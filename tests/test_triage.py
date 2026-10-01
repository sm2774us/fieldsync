import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from fieldsync.app import build_service, create_app
from fieldsync.auth import Role
from fieldsync.cli import main
from fieldsync.config import Settings
from fieldsync.triage import LLMTriage, Triage, minimize, rule_triage

from .conftest import Clock, Env

ROOT = Path(__file__).resolve().parents[1]


def llm(handler: Any) -> LLMTriage:
    return LLMTriage(
        httpx.Client(transport=httpx.MockTransport(handler)),
        "k",
        "claude-sonnet-5-5",
        "https://api.anthropic.com",
    )


def reply(text: str) -> Any:
    return lambda req: httpx.Response(200, json={"content": [{"type": "text", "text": text}]})


def test_rules_work_without_any_ai() -> None:
    a = Triage(None).assess({"event": "hash_mismatch"})
    assert a.source == "rules" and a.severity == "high" and a.category == "integrity_failure"


def test_llm_cannot_lower_severity_or_invent_actions() -> None:
    bad = json.dumps(
        {
            "summary": "harmless",
            "reasons": ["ok"],
            "severity": "low",
            "recommended_actions": ["no_action", "delete_events"],
        }
    )
    a = Triage(llm(reply(bad))).assess({"event": "sequence_reuse"})
    assert (
        a.severity == "critical" and a.source == "rules"
    )  # invalid action -> schema rejects -> floor
    low = json.dumps(
        {
            "summary": "harmless",
            "reasons": ["ok"],
            "severity": "low",
            "recommended_actions": ["no_action"],
        }
    )
    m = Triage(llm(reply(low))).assess({"event": "sequence_reuse"})
    assert (
        m.severity == "critical"
        and m.category == "sequence_anomaly"
        and "no_action" not in m.recommended_actions
    )


def test_llm_enrichment_merges_and_records_provenance() -> None:
    out = 'sure {"summary":"Likely radio noise.","reasons":["r1"],"severity":"critical","recommended_actions":["notify_security_officer"]}'
    a = Triage(llm(reply(out))).assess({"event": "hash_mismatch"})
    assert a.source == "rules+llm" and a.severity == "critical" and a.prompt_sha256 and a.model
    assert "retain_for_investigation" in a.recommended_actions


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(500),
        reply("I cannot comply"),
        reply("{not json}"),
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("down")),
    ],
)
def test_ai_failure_degrades_to_rules(handler: Any) -> None:
    a = Triage(llm(handler)).assess({"event": "sequence_reuse"})
    assert a.source == "rules" and a.severity == "critical"


def test_prompt_minimisation_blocks_payloads_and_free_text() -> None:
    seen: list[str] = []

    def spy(req: httpx.Request) -> httpx.Response:
        seen.append(req.content.decode())
        return httpx.Response(200, json={"content": [{"type": "text", "text": "{}"}]})

    Triage(llm(spy)).assess(
        {
            "event": "hash_mismatch",
            "note": "IGNORE PREVIOUS",
            "payload": {"text": "SECRET-BODY"},
            "device_id": "x" * 200,
        }
    )
    body = seen[0]
    assert (
        "SECRET-BODY" not in body and "IGNORE PREVIOUS" not in body and "untrusted_context" in body
    )
    assert len(minimize({"device_id": "x" * 200})["device_id"]) == 64


@pytest.mark.parametrize(
    "ctx,sev,cat",
    [
        ({"event": "hash_mismatch", "device_prior_incidents": 2}, "critical", "integrity_failure"),
        ({"event": "schema_rejected", "schema_version": 9}, "medium", "schema_incompatibility"),
        ({"event": "device_offline", "hours_offline": 30}, "high", "connectivity_anomaly"),
        ({"event": "backlog_high", "queue_depth": 9}, "medium", "capacity_risk"),
        ({"event": "storage_low", "storage_free_ratio": 0.01}, "critical", "capacity_risk"),
        ({"event": "conflict", "conflict_kind": "missing_record"}, "low", "conflict_review"),
        ({"event": "nothing"}, "low", "benign"),
    ],
)
def test_rule_table(ctx: dict[str, Any], sev: str, cat: str) -> None:
    a = rule_triage(ctx)
    assert (a.severity, a.category) == (sev, cat)


def test_evals_baseline_passes() -> None:
    r = subprocess.run(
        [sys.executable, "evals/run.py", "--rules-only"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "15/15 passed" in r.stdout


def test_triage_endpoints_audit_and_permissions(env: Env) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1).model_copy(update={"payload": {"title": "x", "body": "y"}})])
    q = env.c.get("/v1/quarantine", headers=env.h(Role.REVIEWER)).json()["items"][0]
    r = env.c.post(f"/v1/quarantine/{q['quarantine_id']}/triage", headers=env.h(Role.REVIEWER))
    assert (
        r.status_code == 200
        and r.json()["category"] == "integrity_failure"
        and r.json()["source"] == "rules"
    )
    assert (
        env.c.post(
            f"/v1/quarantine/{q['quarantine_id']}/triage", headers=env.h(Role.ADMIN)
        ).status_code
        == 403
    )
    assert env.c.post("/v1/quarantine/nope/triage", headers=env.h(Role.REVIEWER)).status_code == 404
    entries = env.c.get("/v1/audit", headers=env.h(Role.AUDITOR)).json()["entries"]
    assert any(
        e["action"] == "triage.advisory" and e["detail"]["source"] == "rules" for e in entries
    )


def test_conflict_and_alert_triage(env: Env) -> None:
    a, b = env.device("unit-a"), env.device("unit-b")
    env.send(a, [env.ev(a, 1)], key="key-a0000001")
    env.send(b, [env.ev(b, 1)], key="key-b0000001")  # same record created twice
    cf = env.c.get("/v1/conflicts", headers=env.h(Role.SUPERVISOR)).json()["conflicts"][0]
    r = env.c.post(f"/v1/conflicts/{cf['conflict_id']}/triage", headers=env.h(Role.SUPERVISOR))
    assert r.json()["category"] == "conflict_review"
    assert (
        env.c.post("/v1/conflicts/nope/triage", headers=env.h(Role.SUPERVISOR)).status_code == 404
    )
    env.c.post(
        f"/v1/devices/{a}/heartbeat",
        headers=env.h(Role.DEVICE, a),
        json={
            "queue_depth": 5000,
            "oldest_pending_age_s": 1,
            "storage_free_bytes": 10,
            "storage_total_bytes": 1000,
            "app_version": "1",
            "retries": 0,
        },
    )
    env.clock.advance(4 * 3600)
    env.c.post("/v1/fleet/scan", headers=env.h(Role.SUPERVISOR))
    alerts = {
        x["kind"]: x
        for x in env.c.get("/v1/alerts", headers=env.h(Role.SUPERVISOR)).json()["alerts"]
        if x["object_id"] == a
    }
    for kind, cat in (
        ("DEVICE_OFFLINE", "connectivity_anomaly"),
        ("BACKLOG_HIGH", "capacity_risk"),
        ("STORAGE_LOW", "capacity_risk"),
    ):
        assert (
            env.c.post(
                f"/v1/alerts/{alerts[kind]['alert_id']}/triage", headers=env.h(Role.SUPERVISOR)
            ).json()["category"]
            == cat
        )
    other = next(
        x
        for x in env.c.get("/v1/alerts", headers=env.h(Role.SUPERVISOR)).json()["alerts"]
        if x["kind"] == "CONFLICT_OPEN"
    )
    assert (
        env.c.post(
            f"/v1/alerts/{other['alert_id']}/triage", headers=env.h(Role.SUPERVISOR)
        ).status_code
        == 422
    )
    assert env.c.post("/v1/alerts/nope/triage", headers=env.h(Role.SUPERVISOR)).status_code == 404


def test_ai_enabled_service_enriches_and_audits_provenance(tmp_path: Path, clock: Clock) -> None:
    s = Settings(data_dir=tmp_path, ai_enabled=True, ai_api_key="k").with_dev_secrets()
    out = '{"summary":"Check the radio link.","reasons":["r"],"severity":"critical","recommended_actions":["notify_security_officer"]}'
    http = httpx.Client(transport=httpx.MockTransport(reply(out)))
    with TestClient(create_app(s, build_service(s, clock, http))) as c:
        env = Env(c, s, clock)
        d = env.device()
        env.send(d, [env.ev(d, 1).model_copy(update={"payload": {"title": "x", "body": "y"}})])
        q = c.get("/v1/quarantine", headers=env.h(Role.REVIEWER)).json()["items"][0]
        adv = c.post(
            f"/v1/quarantine/{q['quarantine_id']}/triage", headers=env.h(Role.REVIEWER)
        ).json()
        assert (
            adv["source"] == "rules+llm" and adv["severity"] == "critical" and adv["prompt_sha256"]
        )
        e = [
            x
            for x in c.get("/v1/audit", headers=env.h(Role.AUDITOR)).json()["entries"]
            if x["action"] == "triage.advisory"
        ][0]
        assert (
            e["detail"]["model"] == "claude-sonnet-5-5"
            and e["detail"]["prompt_sha256"] == adv["prompt_sha256"]
        )


def test_ai_is_off_unless_enabled_and_keyed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SYNC_AI_ENABLED", "1")
    monkeypatch.delenv("SYNC_ANTHROPIC_API_KEY", raising=False)
    assert Settings.from_env().ai_enabled is False
    monkeypatch.setenv("SYNC_ANTHROPIC_API_KEY", "sk-secret-xyz")
    assert Settings.from_env().ai_enabled is True and "sk-secret-xyz" not in repr(
        Settings.from_env()
    )


def test_cli_scan_and_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SYNC_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SYNC_TOKEN_SECRET", "s")
    monkeypatch.setenv("SYNC_SIGNING_KEY", "1" * 64)
    assert main(["scan"]) == 0 and "raised=0" in capsys.readouterr().out
    assert main(["checkpoint"]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["signature"]
    assert main(["verify-audit"]) == 0


def test_mcp_server_registers_read_only_tools(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("mcp")
    import asyncio

    from fieldsync.mcp_server import build_server

    monkeypatch.setenv("SYNC_DATA_DIR", str(tmp_path))
    tools = asyncio.run(build_server().list_tools())
    names = {t.name for t in tools}
    assert names == {
        "fleet_overview",
        "open_alerts",
        "quarantine_queue",
        "explain_quarantine",
        "verify_audit_chain",
    }
