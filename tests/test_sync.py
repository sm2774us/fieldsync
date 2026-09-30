import json
import sqlite3
from typing import Any

import pytest

from fieldsync.auth import Role
from fieldsync.models import EventIn, event_hash

from .conftest import Env


def test_ordered_ack_and_projection(env: Env) -> None:
    d = env.device()
    evs = [env.ev(d, 1), env.ev(d, 2, "report.update", payload={"changes": {"body": "new"}}, base=1),
           env.ev(d, 3, "note.add", payload={"text": "hello"})]  # fmt: skip
    r = env.send(d, evs)
    assert r.status_code == 200 and r.json()["ack_through"] == 3 and r.json()["accepted"] == 3
    rec = env.c.get("/v1/records/rec-0001", headers=env.h(Role.REVIEWER)).json()
    assert (
        rec["version"] == 2 and rec["data"]["body"] == "new" and rec["notes"][0]["text"] == "hello"
    )
    assert [v["cause"] for v in rec["versions"]] == ["create", "update"]
    assert (
        env.c.get(f"/v1/devices/{d}/cursor", headers=env.h(Role.DEVICE, d)).json()["acked_seq"] == 3
    )


def test_retry_with_same_key_is_idempotent(env: Env) -> None:
    d = env.device()
    evs = [env.ev(d, 1), env.ev(d, 2, "note.add", payload={"text": "x"})]
    first = env.send(d, evs, key="retry-key-01")
    again = env.send(d, evs, key="retry-key-01")
    assert again.status_code == 200 and again.headers["idempotent-replay"] == "true"
    assert again.json()["batch_id"] == first.json()["batch_id"]
    n = env.c.get(f"/v1/devices/{d}/events", headers=env.h(Role.SUPERVISOR)).json()["events"]
    assert len(n) == 2


def test_key_reuse_with_different_content_is_rejected(env: Env) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)], key="reuse-key-01")
    r = env.send(d, [env.ev(d, 2, "note.add", payload={"text": "y"})], key="reuse-key-01")
    assert r.status_code == 409 and r.json()["error"] == "conflict"


def test_resending_acknowledged_events_counts_duplicates_without_duplicating(env: Env) -> None:
    d = env.device()
    evs = [env.ev(d, 1), env.ev(d, 2, "note.add", payload={"text": "z"})]
    env.send(d, evs, key="first-key-01")
    r = env.send(d, evs, key="second-key-01")
    assert r.json()["duplicates"] == 2 and r.json()["accepted"] == 0
    assert (
        len(env.c.get(f"/v1/devices/{d}/events", headers=env.h(Role.SUPERVISOR)).json()["events"])
        == 2
    )


def test_sequence_reuse_with_different_content_is_quarantined(env: Env) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)], key="key-aaaa0001")
    r = env.send(d, [env.ev(d, 1, payload={"title": "other", "body": "b"})], key="key-aaaa0002")
    assert r.status_code == 422 and r.json()["reason"] == "sequence_reuse_mismatch"
    cur = env.c.get(f"/v1/devices/{d}/cursor", headers=env.h(Role.DEVICE, d)).json()
    assert cur["sync_state"] == "blocked"


def test_gap_is_rejected_and_reports_expected_sequence(env: Env) -> None:
    d = env.device()
    r = env.send(d, [env.ev(d, 3)])
    assert (
        r.status_code == 409
        and r.json()["expected_seq"] == 1
        and r.json()["error"] == "sequence_gap"
    )
    assert (
        env.c.get(f"/v1/devices/{d}/events", headers=env.h(Role.SUPERVISOR)).json()["events"] == []
    )


def test_non_contiguous_batch_and_missing_key(env: Env) -> None:
    d = env.device()
    assert env.send(d, [env.ev(d, 1), env.ev(d, 3)]).status_code == 422
    assert env.send(d, [env.ev(d, 1)], key="short").status_code == 422


def test_hash_mismatch_quarantines_blocks_and_persists_the_good_prefix(env: Env) -> None:
    d = env.device()
    good, bad = env.ev(d, 1), env.ev(d, 2, "note.add", payload={"text": "original"})
    tampered = bad.model_copy(update={"payload": {"text": "altered in transit"}})
    r = env.send(d, [good, tampered])
    body = r.json()
    assert r.status_code == 422 and body["reason"] == "hash_mismatch" and body["ack_through"] == 1
    q = env.c.get("/v1/quarantine", headers=env.h(Role.REVIEWER)).json()["items"][0]
    assert (
        q["event"]["payload"]["text"] == "altered in transit" and q["seq"] == 2
    )  # preserved as received
    blocked = env.send(d, [bad], key="key-after-blk")
    assert blocked.status_code == 409 and blocked.json()["blocked_seq"] == 2
    ok = env.c.post(f"/v1/quarantine/{q['quarantine_id']}/disposition", headers=env.h(Role.REVIEWER),
                    json={"decision": "retry_authorized", "note": "resend the original"})  # fmt: skip
    assert ok.status_code == 200
    assert env.send(d, [bad], key="key-after-ok1").json()["ack_through"] == 2
    kinds = [
        a["kind"] for a in env.c.get("/v1/alerts", headers=env.h(Role.SUPERVISOR)).json()["alerts"]
    ]
    assert "EVENT_QUARANTINED" not in kinds  # acknowledged by the disposition


def test_skip_authorized_advances_cursor_only_for_the_blocked_sequence(env: Env) -> None:
    d = env.device()
    bad = env.ev(d, 1).model_copy(update={"payload": {"title": "x", "body": "y"}})
    env.send(d, [bad])
    q = env.c.get("/v1/quarantine", headers=env.h(Role.REVIEWER)).json()["items"][0]
    r = env.c.post(f"/v1/quarantine/{q['quarantine_id']}/disposition", headers=env.h(Role.REVIEWER),
                   json={"decision": "skip_authorized", "note": "unrecoverable, retained"})  # fmt: skip
    assert r.status_code == 200
    assert (
        env.send(
            d,
            [env.ev(d, 2, "note.add", rid="rec-0002", payload={"text": "n"})],
            key="k-after-skip1",
        ).status_code
        == 200
    )  # accepted; projection parks it as a conflict
    cur = env.c.get(f"/v1/devices/{d}/cursor", headers=env.h(Role.DEVICE, d)).json()
    assert cur["acked_seq"] == 2 and cur["sync_state"] == "ok"
    again = env.c.post(f"/v1/quarantine/{q['quarantine_id']}/disposition", headers=env.h(Role.REVIEWER),
                       json={"decision": "retry_authorized", "note": "second decision"})  # fmt: skip
    assert again.status_code == 409


@pytest.mark.parametrize(
    "mut",
    [
        {"schema_version": 9},
        {"type": "report.delete"},
        {"payload": {"title": "t"}},
        {"payload": {"title": "t", "body": "b", "extra": 1}},
        {"payload": {"title": 5, "body": "b"}},
        {"schema_version": 2, "payload": {"title": "t", "body": "b", "severity": "urgent"}},
        {"payload": {"title": "t" * 201, "body": "b"}},
    ],
)
def test_schema_registry_rejects_bad_events(env: Env, mut: dict[str, Any]) -> None:
    d = env.device()
    e = env.ev(d, 1).model_dump() | mut
    e["content_hash"] = event_hash(d, e)
    r = env.send(d, [EventIn(**e)])
    assert r.status_code == 422 and r.json()["error"] == "schema_rejected"


def test_v2_schema_accepted(env: Env) -> None:
    d = env.device()
    e = env.ev(d, 1, payload={"title": "t", "body": "b", "severity": "high"}).model_dump() | {
        "schema_version": 2
    }
    e["content_hash"] = event_hash(d, e)
    assert env.send(d, [EventIn(**e)]).status_code == 200


def test_update_validation(env: Env) -> None:
    d = env.device()
    bad = env.ev(d, 1, "report.update", payload={"changes": {}}, base=1)
    assert env.send(d, [bad]).json()["error"] == "schema_rejected"


def test_device_identity_is_enforced(env: Env) -> None:
    a, b = env.device("unit-a"), env.device("unit-b")
    assert env.send(a, [env.ev(a, 1)], sub=b).status_code == 403
    assert env.c.get(f"/v1/devices/{a}/cursor", headers=env.h(Role.DEVICE, b)).status_code == 403
    p = env.device("unit-p", activate=False)
    assert env.send(p, [env.ev(p, 1)]).status_code == 403  # pending devices cannot write
    env.c.post(f"/v1/devices/{a}/revoke", headers=env.h(Role.ADMIN), params={"reason": "lost"})
    assert env.send(a, [env.ev(a, 1)], key="key-revoked1").status_code == 403


def test_two_person_activation(env: Env) -> None:
    env.device("unit-x", activate=False)
    r = env.c.post("/v1/devices/unit-x/activate", headers=env.h(Role.ADMIN, "admin-a"))
    assert r.status_code == 403
    assert (
        env.c.post(
            "/v1/devices",
            headers=env.h(Role.ADMIN),
            json={"device_id": "unit-x", "label": "l", "agency_id": "agency-1"},
        ).status_code
        == 409
    )


def test_separation_of_duties_and_audited_denials(env: Env) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)])
    for path in (
        f"/v1/devices/{d}/events",
        "/v1/records",
        "/v1/conflicts",
        "/v1/fleet",
        "/v1/alerts",
    ):
        assert env.c.get(path, headers=env.h(Role.ADMIN)).status_code == 403, path
    assert env.c.get("/v1/fleet", headers=env.h(Role.REVIEWER)).status_code == 403
    assert env.c.post("/v1/audit/checkpoint", headers=env.h(Role.AUDITOR)).status_code == 403
    assert env.c.get("/v1/records", headers=env.h(Role.DEVICE, d)).status_code == 403
    entries = env.c.get("/v1/audit", headers=env.h(Role.AUDITOR)).json()["entries"]
    assert any(e["action"] == "authz.denied" for e in entries)
    assert env.c.get("/v1/fleet").status_code == 401
    assert env.c.get("/v1/fleet", headers={"authorization": "Bearer nope"}).status_code == 401


def test_conflicts_are_never_silent_overwrites(env: Env) -> None:
    a, b = env.device("unit-a"), env.device("unit-b")
    env.send(a, [env.ev(a, 1)], key="key-a0000001")
    env.send(
        a,
        [env.ev(a, 2, "report.update", payload={"changes": {"title": "A wins"}}, base=1)],
        key="key-a0000002",
    )
    env.send(
        b,
        [env.ev(b, 1, "report.update", payload={"changes": {"title": "B stale"}}, base=1)],
        key="key-b0000001",
    )
    rec = env.c.get("/v1/records/rec-0001", headers=env.h(Role.REVIEWER)).json()
    assert rec["data"]["title"] == "A wins" and rec["version"] == 2
    cf = env.c.get("/v1/conflicts", headers=env.h(Role.REVIEWER)).json()["conflicts"][0]
    assert (
        cf["kind"] == "stale_base"
        and cf["current"]["title"] == "A wins"
        and cf["proposed"]["changes"]["title"] == "B stale"
    )
    r = env.c.post(f"/v1/conflicts/{cf['conflict_id']}/resolve", headers=env.h(Role.REVIEWER),
                   json={"decision": "apply_proposed", "note": "B has the newer facts"})  # fmt: skip
    assert r.json()["new_version"] == 3
    rec = env.c.get("/v1/records/rec-0001", headers=env.h(Role.REVIEWER)).json()
    assert rec["data"]["title"] == "B stale" and len(rec["versions"]) == 3
    assert (
        env.c.post(
            f"/v1/conflicts/{cf['conflict_id']}/resolve",
            headers=env.h(Role.REVIEWER),
            json={"decision": "keep_current", "note": "again please"},
        ).status_code
        == 409
    )


def test_other_conflict_kinds_and_keep_current(env: Env) -> None:
    a, b = env.device("unit-a"), env.device("unit-b")
    env.send(a, [env.ev(a, 1)], key="key-a0000001")
    env.send(b, [env.ev(b, 1)], key="key-b0000001")  # same record created twice
    env.send(
        b, [env.ev(b, 2, "note.add", rid="ghost-1", payload={"text": "n"})], key="key-b0000002"
    )
    kinds = {
        c["kind"]: c
        for c in env.c.get("/v1/conflicts", headers=env.h(Role.SUPERVISOR)).json()["conflicts"]
    }
    assert set(kinds) == {"duplicate_create", "missing_record"}
    bad = env.c.post(f"/v1/conflicts/{kinds['duplicate_create']['conflict_id']}/resolve", headers=env.h(Role.REVIEWER),
                     json={"decision": "apply_proposed", "note": "should not be allowed"})  # fmt: skip
    assert bad.status_code == 422
    ok = env.c.post(f"/v1/conflicts/{kinds['missing_record']['conflict_id']}/resolve", headers=env.h(Role.REVIEWER),
                    json={"decision": "keep_current", "note": "orphan note dismissed"})  # fmt: skip
    assert ok.json()["new_version"] is None


def test_outbox_projection_is_idempotent_and_crash_safe(env: Env, app: Any) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1), env.ev(d, 2, "note.add", payload={"text": "once"})])
    svc = app.state.svc
    svc.db.raw().execute("UPDATE outbox SET status='pending'")  # simulate crash before 'done'
    svc.drain_outbox()
    rec = env.c.get("/v1/records/rec-0001", headers=env.h(Role.REVIEWER)).json()
    assert len(rec["notes"]) == 1 and rec["version"] == 1
    assert svc.drain_outbox() == 0


def test_immutability_of_events_and_audit(env: Env, app: Any) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)])
    raw = app.state.svc.db.raw()
    for sql in ("UPDATE events SET payload_json='{}'", "DELETE FROM events", "DELETE FROM audit_log",
                "UPDATE audit_log SET actor='x'", "UPDATE record_versions SET data_json='{}'"):  # fmt: skip
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            raw.execute(sql)
    env.send(
        d,
        [env.ev(d, 2).model_copy(update={"payload": {"title": "q", "body": "w"}})],
        key="k-quarantine",
    )
    with pytest.raises(sqlite3.DatabaseError, match="immutable"):
        raw.execute("UPDATE quarantine SET event_json='{}'")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        raw.execute("DELETE FROM quarantine")


def test_tampering_with_the_audit_log_is_detected(env: Env, app: Any) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)])
    assert env.c.get("/readyz").status_code == 200
    raw = app.state.svc.db.raw()
    raw.execute("DROP TRIGGER audit_log_no_update")  # attacker with database access
    raw.execute("UPDATE audit_log SET actor='mallory' WHERE seq=2")
    r = env.c.get("/readyz")
    assert r.status_code == 503 and r.json()["ready"] is False
    v = env.c.post("/v1/audit/verify", headers=env.h(Role.AUDITOR)).json()
    assert v["ok"] is False


def test_checkpoint_and_verify(env: Env) -> None:
    d = env.device()
    env.send(d, [env.ev(d, 1)])
    assert env.c.post("/v1/audit/checkpoint", headers=env.h(Role.ADMIN)).status_code == 200
    v = env.c.post("/v1/audit/verify", headers=env.h(Role.AUDITOR)).json()
    assert v["ok"] and v["checkpoints_verified"] == 1
    assert env.c.get("/v1/keys").json()["alg"] == "Ed25519"


def _hb(**kw: Any) -> dict[str, Any]:
    return {
        "queue_depth": 0,
        "oldest_pending_age_s": 0,
        "storage_free_bytes": 900,
        "storage_total_bytes": 1000,
        "app_version": "1.0.0",
        "retries": 0,
    } | kw


def test_fleet_connectivity_lifecycle_and_scan(env: Env) -> None:
    d = env.device()

    def fleet() -> dict[str, Any]:
        rows = env.c.get("/v1/fleet", headers=env.h(Role.SUPERVISOR)).json()["devices"]
        return {x["device_id"]: x for x in rows}

    assert fleet()[d]["connectivity"] == "never"
    r = env.c.post(
        f"/v1/devices/{d}/heartbeat",
        headers=env.h(Role.DEVICE, d),
        json=_hb(queue_depth=150, storage_free_bytes=50),
    )
    assert r.status_code == 200
    assert fleet()[d]["connectivity"] == "online"
    env.clock.advance(300)
    assert fleet()[d]["connectivity"] == "delayed"
    env.clock.advance(7200)
    assert fleet()[d]["connectivity"] == "offline"
    raised = env.c.post("/v1/fleet/scan", headers=env.h(Role.SUPERVISOR)).json()["alerts"]
    kinds = sorted(
        a["kind"] for a in env.c.get("/v1/alerts", headers=env.h(Role.SUPERVISOR)).json()["alerts"]
    )
    assert len(raised) == 3 and kinds == ["BACKLOG_HIGH", "DEVICE_OFFLINE", "STORAGE_LOW"]
    assert (
        env.c.post("/v1/fleet/scan", headers=env.h(Role.SUPERVISOR)).json()["alerts"] == []
    )  # deduped
    aid = env.c.get("/v1/alerts", headers=env.h(Role.SUPERVISOR)).json()["alerts"][0]["alert_id"]
    assert env.c.post(f"/v1/alerts/{aid}/ack", headers=env.h(Role.SUPERVISOR)).status_code == 200
    assert env.c.post(f"/v1/alerts/{aid}/ack", headers=env.h(Role.SUPERVISOR)).status_code == 404
    assert env.c.get(f"/v1/devices/{d}", headers=env.h(Role.AUDITOR)).json()["retries"] == 0
    assert env.c.get("/v1/devices/nope", headers=env.h(Role.AUDITOR)).status_code == 404
    other = env.device("unit-o")
    assert (
        env.c.post(
            f"/v1/devices/{d}/heartbeat", headers=env.h(Role.DEVICE, other), json=_hb()
        ).status_code
        == 403
    )


def test_metrics_expose_the_signals_operators_need(env: Env) -> None:
    d = env.device()
    e = env.ev(d, 1)
    env.send(d, [e], key="key-metric001")
    env.send(d, [e], key="key-metric001")
    env.c.post(
        f"/v1/devices/{d}/heartbeat",
        headers=env.h(Role.DEVICE, d),
        json=_hb(queue_depth=7, oldest_pending_age_s=42),
    )
    m = env.c.get("/metrics").text
    for name in ("sync_events_accepted_total 1.0", 'sync_batches_total{result="replay"} 1.0', "sync_max_queue_depth 7.0",
                 "sync_max_sync_lag_seconds 42.0", "sync_outbox_pending 0.0", "sync_open_conflicts", "sync_devices_offline",
                 "sync_min_storage_free_ratio 0.9"):  # fmt: skip
        assert name in m, name
    assert json.dumps(m)
