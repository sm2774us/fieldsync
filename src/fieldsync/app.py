"""Composition root + FastAPI application."""

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse

from .audit import AuditLog, Ctx
from .auth import Principal, parse_token
from .config import Settings
from .crypto import Signer
from .db import Database
from .errors import AuthError, SyncError
from .metrics import Metrics
from .models import BatchIn, DeviceRegistration, Disposition, Heartbeat, Resolution
from .service import SyncService
from .triage import LLMTriage, Triage

log = logging.getLogger("fieldsync")


def build_service(settings: Settings, clock: Callable[[], int] | None = None,
                  http: httpx.Client | None = None) -> SyncService:  # fmt: skip
    clock = clock or (lambda: int(time.time() * 1000))
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(str(settings.data_dir / "fieldsync.db"))
    signer = Signer(settings.signing_key_hex)
    llm = None
    if settings.ai_enabled:  # optional; off unless SYNC_AI_ENABLED=1 and a key is present
        llm = LLMTriage(http or httpx.Client(), settings.ai_api_key, settings.ai_model,
                        settings.ai_base_url, settings.ai_timeout_s)  # fmt: skip
    svc = SyncService(
        settings, db, AuditLog(db, signer, clock), signer, clock, Metrics(), Triage(llm)
    )
    svc.drain_outbox()  # crash recovery: finish any projections interrupted before restart
    return svc


def _principal(
    request: Request, authorization: Annotated[str | None, Header()] = None
) -> Principal:
    svc: SyncService = request.app.state.svc
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthError("bearer token required")
    p = parse_token(request.app.state.settings.token_secret, authorization[7:], svc.clock())
    if svc.db.one("SELECT 1 FROM revoked_tokens WHERE jti=?", (p.jti,)):
        raise AuthError("token revoked")
    return p


def _ctx(request: Request) -> Ctx:
    c: Ctx = request.state.ctx
    return c


P = Annotated[Principal, Depends(_principal)]
C = Annotated[Ctx, Depends(_ctx)]


def create_app(settings: Settings | None = None, service: SyncService | None = None) -> FastAPI:
    settings = (settings or Settings.from_env()).with_dev_secrets()
    svc = service or build_service(settings)
    app = FastAPI(title="FieldSync API", version="1.0.0", docs_url="/docs")
    app.state.svc, app.state.settings = svc, settings

    @app.exception_handler(SyncError)
    async def _err(_: Request, exc: SyncError) -> JSONResponse:
        return JSONResponse({"error": exc.code, "message": exc.message, **exc.extra}, exc.status)

    @app.middleware("http")
    async def _mw(request: Request, call_next: Callable[..., Any]) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.ctx = Ctx(ip=request.client.host if request.client else "-", request_id=rid)
        t0 = time.perf_counter()
        resp: Response = await call_next(request)
        resp.headers.update({"x-request-id": rid, "cache-control": "no-store",
                             "x-content-type-options": "nosniff"})  # fmt: skip
        log.info(json.dumps({"rid": rid, "method": request.method, "path": request.url.path,
                             "status": resp.status_code,
                             "ms": round((time.perf_counter() - t0) * 1000, 1)}))  # fmt: skip
        return resp

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> JSONResponse:
        chain = svc.audit.verify()
        return JSONResponse({"ready": chain.ok, "audit_entries": chain.entries,
                             "audit_error": chain.error}, 200 if chain.ok else 503)  # fmt: skip

    @app.get("/metrics", response_class=PlainTextResponse)
    def metrics() -> str:
        return svc.metrics.render()

    @app.get("/v1/keys")
    def keys() -> dict[str, str]:
        return {"key_id": svc.signer.key_id, "public_key": svc.signer.public_hex, "alg": "Ed25519"}

    # ---- devices -----------------------------------------------------------------------
    @app.post("/v1/devices", status_code=201)
    def register(body: DeviceRegistration, p: P, c: C) -> dict[str, Any]:
        return svc.register_device(p, body.device_id, body.label, body.agency_id, c)

    @app.post("/v1/devices/{device_id}/activate")
    def activate(device_id: str, p: P, c: C) -> dict[str, Any]:
        return svc.activate_device(p, device_id, c)

    @app.post("/v1/devices/{device_id}/revoke")
    def revoke(device_id: str, p: P, c: C, reason: str = "unspecified") -> dict[str, Any]:
        return svc.revoke_device(p, device_id, reason, c)

    @app.get("/v1/fleet")
    def fleet(p: P, c: C) -> dict[str, Any]:
        return {"devices": svc.fleet(p, c)}

    @app.get("/v1/devices/{device_id}")
    def device(device_id: str, p: P, c: C) -> dict[str, Any]:
        return svc.device(p, device_id, c)

    @app.get("/v1/devices/{device_id}/cursor")
    def cursor(device_id: str, p: P, c: C) -> dict[str, Any]:
        return svc.cursor(p, device_id, c)

    @app.get("/v1/devices/{device_id}/events")
    def events(device_id: str, p: P, c: C, after: int = 0, limit: int = 200) -> dict[str, Any]:
        return {"events": svc.events(p, device_id, after, limit, c)}

    @app.post("/v1/devices/{device_id}/heartbeat")
    def heartbeat(device_id: str, body: Heartbeat, p: P, c: C) -> dict[str, Any]:
        return svc.heartbeat(p, device_id, body, c)

    # ---- sync --------------------------------------------------------------------------
    @app.post("/v1/sync/batches")
    def sync(body: BatchIn, p: P, c: C,
             idempotency_key: Annotated[str, Header()] = "") -> JSONResponse:  # fmt: skip
        out = svc.ingest(p, body, idempotency_key, c)
        if out["problem"]:
            pr = out["problem"]
            code = "integrity_failure" if pr["reason"] != "schema_rejected" else "schema_rejected"
            return JSONResponse({"error": code, "message": pr["message"], **pr,
                                 "ack_through": out["ack_through"]}, 422)  # fmt: skip
        if out["expected_seq"] is not None:
            return JSONResponse({"error": "sequence_gap", "message": "sequence gap: resume from the cursor",
                                 "expected_seq": out["expected_seq"], "ack_through": out["ack_through"]}, 409)  # fmt: skip
        return JSONResponse({k: v for k, v in out.items() if k not in ("problem", "expected_seq")},
                            headers={"idempotent-replay": str(out["idempotent_replay"]).lower()})  # fmt: skip

    # ---- records, conflicts, quarantine ---------------------------------------------------
    @app.get("/v1/records")
    def records(p: P, c: C) -> dict[str, Any]:
        return {"records": svc.records(p, c)}

    @app.get("/v1/records/{rid}")
    def record(rid: str, p: P, c: C) -> dict[str, Any]:
        return svc.record(p, rid, c)

    @app.get("/v1/conflicts")
    def conflicts(p: P, c: C, status: str = "open") -> dict[str, Any]:
        return {"conflicts": svc.list_conflicts(p, status, c)}

    @app.post("/v1/conflicts/{cid}/resolve")
    def resolve(cid: str, body: Resolution, p: P, c: C) -> dict[str, Any]:
        return svc.resolve_conflict(p, cid, body.decision, body.note, c)

    @app.get("/v1/quarantine")
    def quarantine(p: P, c: C, status: str = "open") -> dict[str, Any]:
        return {"items": svc.list_quarantine(p, status, c)}

    @app.post("/v1/quarantine/{qid}/disposition")
    def dispose(qid: str, body: Disposition, p: P, c: C) -> dict[str, Any]:
        return svc.dispose_quarantine(p, qid, body.decision, body.note, c)

    @app.post("/v1/quarantine/{qid}/triage")
    def triage_quarantine(qid: str, p: P, c: C) -> dict[str, Any]:
        return svc.triage_quarantine(p, qid, c).model_dump()

    @app.post("/v1/conflicts/{cid}/triage")
    def triage_conflict(cid: str, p: P, c: C) -> dict[str, Any]:
        return svc.triage_conflict(p, cid, c).model_dump()

    @app.post("/v1/alerts/{aid}/triage")
    def triage_alert(aid: str, p: P, c: C) -> dict[str, Any]:
        return svc.triage_alert(p, aid, c).model_dump()

    # ---- audit & alerts ----------------------------------------------------------------
    @app.get("/v1/audit")
    def audit(p: P, c: C, after: int = 0, limit: int = 200) -> dict[str, Any]:
        svc.require_audit(p, "audit:read", c)
        return {"entries": svc.audit.entries(after, limit)}

    @app.post("/v1/audit/verify")
    def audit_verify(p: P, c: C) -> dict[str, Any]:
        svc.require_audit(p, "audit:verify", c)
        s = svc.audit.verify()
        return {"ok": s.ok, "entries": s.entries, "head_hash": s.head_hash,
                "checkpoints_verified": s.checkpoints_verified, "error": s.error}  # fmt: skip

    @app.post("/v1/audit/checkpoint")
    def audit_checkpoint(p: P, c: C) -> dict[str, Any]:
        svc.require_audit(p, "audit:checkpoint", c)
        return svc.audit.checkpoint()

    @app.post("/v1/fleet/scan")
    def scan(p: P, c: C) -> dict[str, Any]:
        return {"alerts": svc.scan_fleet(p, c)}

    @app.get("/v1/alerts")
    def alerts(p: P, c: C, status: str = "open") -> dict[str, Any]:
        return {"alerts": svc.list_alerts(p, status, c)}

    @app.post("/v1/alerts/{aid}/ack")
    def ack(aid: str, p: P, c: C) -> dict[str, Any]:
        return svc.ack_alert(p, aid, c)

    return app


def main() -> None:  # pragma: no cover
    import uvicorn

    uvicorn.run("fieldsync.app:create_app", factory=True, host="0.0.0.0", port=8080,
                log_level="info", proxy_headers=True)  # fmt: skip


if __name__ == "__main__":  # pragma: no cover
    main()
