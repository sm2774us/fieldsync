"""Read-only MCP server so an agent (e.g. a shift-supervisor copilot) can *observe* sync health.

It exposes no write, event-read or delete tools: it can list alerts and queues, verify the audit
chain and request the advisory triage. Every call is audited under the gateway principal
(role `auditor`, which cannot change any state). Requires the extra:  pip install 'fieldsync[mcp]'"""

from __future__ import annotations

from typing import Any

from .app import build_service
from .audit import Ctx
from .auth import Principal, Role
from .config import Settings


def build_server(agency: str = "agency-1") -> Any:  # pragma: no cover - needs optional dep
    try:  # mcp >= 2 renamed FastMCP -> MCPServer
        from mcp.server.mcpserver import MCPServer as FastMCP
    except ImportError:
        from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef,attr-defined]

    svc = build_service(Settings.from_env().with_dev_secrets())
    gw = Principal("mcp-gateway", Role.AUDITOR, agency)
    ctx = Ctx(ip="mcp", request_id="mcp")
    mcp = FastMCP("fieldsync")

    @mcp.tool()
    def fleet_overview() -> list[dict[str, Any]]:
        """Per-device connectivity, sync state, backlog, lag and storage."""
        return svc.fleet(gw, ctx)

    @mcp.tool()
    def open_alerts() -> list[dict[str, Any]]:
        """List open alerts."""
        return svc.list_alerts(gw, "open", ctx)

    @mcp.tool()
    def quarantine_queue() -> list[dict[str, Any]]:
        """Events awaiting reviewer decision (with the bytes exactly as received)."""
        return svc.list_quarantine(gw, "open", ctx)

    @mcp.tool()
    def explain_quarantine(quarantine_id: str) -> dict[str, Any]:
        """Deterministic (+ optional AI-enriched) advisory for a quarantined event."""
        return svc.triage_quarantine(gw, quarantine_id, ctx).model_dump()

    @mcp.tool()
    def verify_audit_chain() -> dict[str, Any]:
        """Recompute the audit hash chain and verify signed checkpoints."""
        s = svc.audit.verify()
        return {"ok": s.ok, "entries": s.entries, "error": s.error}

    return mcp


if __name__ == "__main__":  # pragma: no cover
    build_server().run()
