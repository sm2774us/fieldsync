"""End-to-end scenario against a running API (in-process TestClient or a real server).

Shows the whole design working: offline authoring, lossy links with lost acknowledgements,
idempotent retry, conflict review, tamper quarantine, reviewer decision, verified audit chain.
"""

from __future__ import annotations

import random
import secrets
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import httpx

from .auth import Role, issue_token
from .device import LocalLog, SyncClient, make_event


class Lossy:
    """Wraps an HTTP client: every Nth POST is committed by the server but its response is lost
    (the hardest case for idempotency); every Mth POST never reaches the server."""

    def __init__(self, inner: Any, lose_ack_every: int = 3, drop_every: int = 5) -> None:
        self.inner, self.n, self.a, self.d = inner, 0, lose_ack_every, drop_every
        self.tamper_next = False

    def get(self, url: str, **kw: Any) -> Any:
        return self.inner.get(url, **kw)

    def post(self, url: str, **kw: Any) -> Any:
        self.n += 1
        if url.startswith("/v1/sync") and self.tamper_next:
            self.tamper_next = False
            kw["json"] = {**kw["json"], "events": [
                {**kw["json"]["events"][0], "payload": {"title": "tampered", "body": "in transit"}},
                *kw["json"]["events"][1:]]}  # fmt: skip
        if self.n % self.d == 0:
            raise httpx.ConnectError("link down")
        r = self.inner.post(url, **kw)
        if self.n % self.a == 0:
            raise httpx.ReadTimeout("response lost after commit")
        return r


def run_scenario(http: Any, token_secret: str, say: Callable[[str], None] = print,
                 device_id: str | None = None, resolve: bool = True) -> dict[str, str]:  # fmt: skip
    rnd = random.Random(7)
    now = int(time.time() * 1000)

    def hdr(sub: str, role: Role) -> dict[str, str]:
        return {
            "authorization": "Bearer " + issue_token(token_secret, sub, role, "agency-1", now, 3600)
        }

    dev = device_id or f"unit-{secrets.token_hex(2)}"
    dev2 = f"{dev}-b"
    for d in (dev, dev2):
        http.post("/v1/devices", headers=hdr("admin-a", Role.ADMIN),
                  json={"device_id": d, "label": f"Patrol unit {d}", "agency_id": "agency-1"}).raise_for_status()  # fmt: skip
        http.post(
            f"/v1/devices/{d}/activate", headers=hdr("admin-b", Role.ADMIN)
        ).raise_for_status()
    tmp = Path(tempfile.mkdtemp())
    key = secrets.token_bytes(32)
    lg = LocalLog(str(tmp / "a.db"), key, dev)
    wire = Lossy(http)
    cl = SyncClient(lg, cast(Any, wire), hdr(dev, Role.DEVICE)["authorization"][7:], batch=8, sleep=lambda _: None)  # fmt: skip

    say(f"[1] OFFLINE: {dev} records 30 events with no connectivity (encrypted local log)")
    for i in range(10):
        rid = f"rpt-{dev}-{i}"
        lg.append("report.create", rid, {"title": f"Incident {i}", "body": "x" * rnd.randint(5, 50)}, ts_ms=now + i)  # fmt: skip
        lg.append("report.update", rid, {"changes": {"body": "updated"}}, ts_ms=now + i, base_version=1)  # fmt: skip
        lg.append("note.add", rid, {"text": f"note {i}"}, ts_ms=now + i)
    say(f"    local states: {lg.counts()}")

    say("[2] CONNECTIVITY RETURNS over a lossy link (dropped requests, lost acknowledgements)")
    passes = 0
    while lg.counts().get("acked", 0) < 30 and passes < 60:
        cl.sync_once()
        passes += 1
    ev = http.get(
        f"/v1/devices/{dev}/events?limit=500", headers=hdr("sup-1", Role.SUPERVISOR)
    ).json()["events"]
    say(f"    passes={passes} retries={cl.retries} duplicates_suppressed={cl.duplicates_seen} "
        f"server_events={len(ev)} (exactly 30, in order: {[e['seq'] for e in ev] == list(range(1, 31))})")  # fmt: skip
    say(f"    compacted local rows after ack: {lg.compact()} (sequence numbers keep counting up)")
    first = [{k: e[k] for k in ("seq", "op_id", "type", "schema_version", "record_id", "ts_ms", "base_version", "payload", "content_hash")} for e in ev[:2]]  # fmt: skip
    body = {"device_id": dev, "events": first}
    r1 = http.post("/v1/sync/batches", headers={**hdr(dev, Role.DEVICE), "idempotency-key": "demo-replay-key-1"}, json=body)  # fmt: skip
    r2 = http.post("/v1/sync/batches", headers={**hdr(dev, Role.DEVICE), "idempotency-key": "demo-replay-key-1"}, json=body)  # fmt: skip
    say(f"    re-sending acknowledged events: duplicates={r1.json()['duplicates']}, replayed key -> "
        f"idempotent-replay={r2.headers['idempotent-replay']}, still {len(ev)} events on the server")  # fmt: skip

    say("[3] CONFLICT: a second unit edits a record from the same base version")
    rec = f"rpt-{dev}-0"
    other = LocalLog(str(tmp / "b.db"), secrets.token_bytes(32), dev2)
    other.append(
        "report.update", rec, {"changes": {"title": "Edited by unit B"}}, ts_ms=now, base_version=1
    )
    SyncClient(
        other, cast(Any, http), hdr(dev2, Role.DEVICE)["authorization"][7:], sleep=lambda _: None
    ).sync_once()
    cfs = http.get("/v1/conflicts", headers=hdr("rev-1", Role.REVIEWER)).json()["conflicts"]
    mine = [c for c in cfs if c["record_id"] == rec]
    say(
        f"    open conflict {mine[0]['conflict_id']} kind={mine[0]['kind']}; the record was NOT overwritten"
    )
    if resolve:
        http.post(f"/v1/conflicts/{mine[0]['conflict_id']}/resolve", headers=hdr("rev-1", Role.REVIEWER),
                  json={"decision": "apply_proposed", "note": "Unit B has the corrected title"}).raise_for_status()  # fmt: skip
        say("    reviewer resolved it (new version, history preserved)")
    else:
        say("    left OPEN for you to review in the console")

    say("[4] TAMPER: an event is altered in transit -> hash mismatch")
    lg.append(
        "report.create", f"rpt-{dev}-x", {"title": "Sensitive", "body": "original"}, ts_ms=now
    )
    wire.tamper_next = True
    wire.n = 1  # avoid injected faults on this call so the tamper is the only failure
    res = cl.sync_once()
    q = http.get("/v1/quarantine", headers=hdr("rev-1", Role.REVIEWER)).json()["items"]
    mq = [x for x in q if x["device_id"] == dev]
    say(
        f"    sync -> {res['status']} ({res.get('reason')}); quarantined original preserved: {bool(mq)}"
    )
    probe = make_event(dev, 31, "note.add", rec, {"text": "probe while blocked"}, now).model_dump()
    blocked = http.post("/v1/sync/batches", headers={**hdr(dev, Role.DEVICE), "idempotency-key": "probe-blocked-1"},
                        json={"device_id": dev, "events": [probe]})  # fmt: skip
    say(f"    device is blocked from advancing the cursor (HTTP {blocked.status_code})")
    if resolve:
        if mq:
            http.post(f"/v1/quarantine/{mq[0]['quarantine_id']}/disposition", headers=hdr("rev-1", Role.REVIEWER),
                      json={"decision": "retry_authorized", "note": "Transit corruption; resend authorised"}).raise_for_status()  # fmt: skip
        if mq:
            lg.set_state(mq[0]["seq"], "local")
        for _ in range(10):
            cl.sync_once()
        say(f"    after review the original is resent and accepted: local states {lg.counts()}")
    else:
        say("    left in QUARANTINE for you to review in the console; the device stays blocked")

    say("[5] AUDIT: verify the hash-chained log")
    v = http.post("/v1/audit/verify", headers=hdr("aud-1", Role.AUDITOR)).json()
    say(f"    chain ok={v['ok']} entries={v['entries']}")
    return {"device_id": dev, "device_b": dev2, "record_id": rec}
