"""Sync service: durable, ordered, idempotent ingest with quarantine, outbox and conflict review.

Invariants (each has a test):
  * events are append-only and acknowledged only after they are committed (ack = commit);
  * a batch retried with the same idempotency key returns the stored result, never duplicates;
  * sequence continuity: a device can only advance the cursor by exactly the next sequence number;
  * an event that fails hash or schema checks is preserved in quarantine and blocks the cursor
    until a reviewer decides; it is never applied and never shown as verified;
  * projections are derived, idempotent, and never overwrite: divergent edits become conflicts.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from collections.abc import Callable
from typing import Any

from .audit import SYSTEM, Actor, AuditLog, Ctx
from .auth import Principal
from .config import Settings
from .crypto import Signer, canonical_json, sha256_hex
from .db import Database
from .errors import Conflict, Forbidden, NotFound, SyncError, ValidationFailed
from .metrics import Metrics
from .models import BatchIn, EventIn, Heartbeat, event_hash
from .triage import Advisory, Triage

log = logging.getLogger("fieldsync")
Clock = Callable[[], int]

SEVERITIES = {"low", "medium", "high"}
FIELDS_V1 = {"title", "body"}
FIELDS_V2 = FIELDS_V1 | {"severity"}


def _rid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def validate_event(e: EventIn) -> str | None:
    """Return a reason string if the event violates the schema registry, else None."""
    if e.schema_version not in (1, 2):
        return f"unsupported schema_version {e.schema_version}"
    allowed = FIELDS_V2 if e.schema_version == 2 else FIELDS_V1
    p = e.payload

    def ok_fields(d: dict[str, Any], required: bool) -> str | None:
        if not set(d) <= allowed or (required and not set(d) >= FIELDS_V1):
            return "payload fields do not match the schema"
        for k, v in d.items():
            if k == "severity":
                if v not in SEVERITIES:
                    return "severity must be low, medium or high"
            elif not isinstance(v, str) or len(v) > (200 if k == "title" else 20000):
                return f"{k} must be a string within its length limit"
        return None

    if e.type == "report.create":
        return ok_fields(p, True)
    if e.type == "report.update":
        ch = p.get("changes")
        if set(p) != {"changes"} or not isinstance(ch, dict) or not ch:
            return "report.update needs a non-empty changes object"
        if e.base_version is None or e.base_version < 1:
            return "report.update needs base_version >= 1"
        return ok_fields(ch, False)
    if e.type == "note.add":
        t = p.get("text")
        if set(p) != {"text"} or not isinstance(t, str) or not 1 <= len(t) <= 2000:
            return "note.add needs text of 1 to 2000 characters"
        return None
    return f"unknown event type {e.type!r}"


class SyncService:
    def __init__(self, settings: Settings, db: Database, audit: AuditLog, signer: Signer,
                 clock: Clock, metrics: Metrics, triage: Triage | None = None) -> None:  # fmt: skip
        self.s, self.db, self.audit, self.signer, self.clock, self.metrics = (
            settings, db, audit, signer, clock, metrics)  # fmt: skip
        self.triage = triage or Triage(None)
        m = metrics
        m.gauge("sync_outbox_pending", lambda: float(self._count("outbox", "status='pending'")))
        m.gauge("sync_open_conflicts", lambda: float(self._count("conflicts", "status='open'")))
        m.gauge("sync_open_quarantine", lambda: float(self._count("quarantine", "status='open'")))
        m.gauge("sync_open_alerts", lambda: float(self._count("alerts", "status='open'")))
        m.gauge(
            "sync_blocked_devices", lambda: float(self._count("devices", "sync_state='blocked'"))
        )
        m.gauge("sync_events_total", lambda: float(self._count("events")))
        m.gauge("sync_devices_active", lambda: float(self._count("devices", "status='active'")))
        m.gauge("sync_max_queue_depth", lambda: float(self._agg("MAX(hb_queue_depth)")))
        m.gauge("sync_max_sync_lag_seconds", self._max_lag)
        m.gauge("sync_devices_offline", lambda: float(self._connectivity_count("offline")))
        m.gauge("sync_min_storage_free_ratio", self._min_free_ratio)

    # ---- helpers -----------------------------------------------------------------------
    def _count(self, table: str, where: str = "1=1") -> int:
        r = self.db.one(f"SELECT COUNT(*) n FROM {table} WHERE {where}")  # noqa: S608
        return int(r["n"]) if r else 0

    def _agg(self, expr: str) -> float:
        r = self.db.one(f"SELECT {expr} v FROM devices WHERE status='active'")  # noqa: S608
        return float(r["v"] or 0) if r else 0.0

    def _max_lag(self) -> float:
        r = self.db.one("SELECT MAX(hb_oldest_age_s) v FROM devices WHERE status='active'")
        return float(r["v"] or 0) if r else 0.0

    def _min_free_ratio(self) -> float:
        rows = self.db.query("SELECT hb_free, hb_total FROM devices WHERE hb_total > 0")
        return min((r["hb_free"] / r["hb_total"] for r in rows), default=1.0)

    def _connectivity_count(self, which: str) -> int:
        return sum(1 for d in self.fleet_rows() if d["connectivity"] == which)

    def _actor(self, p: Principal) -> Actor:
        return Actor(p.sub, p.role.value)

    def _require(self, p: Principal, perm: str, ctx: Ctx) -> None:
        if not p.can(perm):
            self.metrics.inc("sync_authz_denied_total", role=p.role.value)
            with self.db.tx() as c:
                self.audit.append(c, self._actor(p), "authz.denied", "permission", perm,
                                  {"role": p.role.value}, ctx=ctx)  # fmt: skip
            raise Forbidden(f"missing permission {perm}")

    def _alert(self, c: sqlite3.Connection, kind: str, severity: str, obj: str | None,
               detail: dict[str, Any], *, dedupe: bool = False) -> str | None:  # fmt: skip
        if dedupe and c.execute("SELECT 1 FROM alerts WHERE kind=? AND object_id IS ? AND "
                                "status='open'", (kind, obj)).fetchone():  # fmt: skip
            return None
        aid = _rid("al")
        c.execute("INSERT INTO alerts(alert_id,ts_ms,kind,severity,object_id,detail_json) "
                  "VALUES(?,?,?,?,?,?)",
                  (aid, self.clock(), kind, severity, obj, json.dumps(detail, sort_keys=True)))  # fmt: skip
        self.metrics.inc("sync_alerts_total", kind=kind, severity=severity)
        return aid

    def _device(self, device_id: str) -> sqlite3.Row:
        r = self.db.one("SELECT * FROM devices WHERE device_id=?", (device_id,))
        if not r:
            raise NotFound("device not found")
        return r

    # ---- device registry (two-person activation) ---------------------------------------
    def register_device(self, p: Principal, device_id: str, label: str, agency: str,
                        ctx: Ctx) -> dict[str, Any]:  # fmt: skip
        self._require(p, "device:register", ctx)
        with self.db.tx() as c:
            if c.execute("SELECT 1 FROM devices WHERE device_id=?", (device_id,)).fetchone():
                raise Conflict("device already registered")
            c.execute("INSERT INTO devices(device_id,label,agency_id,status,registered_by,"
                      "registered_at) VALUES(?,?,?,?,?,?)",
                      (device_id, label, agency, "pending", p.sub, self.clock()))  # fmt: skip
            self.audit.append(c, self._actor(p), "device.registered", "device", device_id,
                              {"label": label, "agency": agency}, ctx=ctx)  # fmt: skip
        return {"device_id": device_id, "status": "pending"}

    def activate_device(self, p: Principal, device_id: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "device:activate", ctx)
        d = self._device(device_id)
        if d["registered_by"] == p.sub:
            raise Forbidden("a different administrator must activate this device")
        if d["status"] != "pending":
            raise Conflict(f"device is {d['status']}")
        with self.db.tx() as c:
            c.execute("UPDATE devices SET status='active', activated_by=? WHERE device_id=?",
                      (p.sub, device_id))  # fmt: skip
            self.audit.append(c, self._actor(p), "device.activated", "device", device_id, ctx=ctx)
        return {"device_id": device_id, "status": "active"}

    def revoke_device(self, p: Principal, device_id: str, reason: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "device:revoke", ctx)
        self._device(device_id)
        with self.db.tx() as c:
            c.execute("UPDATE devices SET status='revoked' WHERE device_id=?", (device_id,))
            self.audit.append(c, self._actor(p), "device.revoked", "device", device_id,
                              {"reason": reason}, ctx=ctx)  # fmt: skip
        return {"device_id": device_id, "status": "revoked"}

    # ---- ingest ------------------------------------------------------------------------
    def ingest(self, p: Principal, batch: BatchIn, idem_key: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "sync:write", ctx)
        if p.sub != batch.device_id:
            raise Forbidden("a device may only write its own log")
        if not 8 <= len(idem_key) <= 200:
            raise ValidationFailed("Idempotency-Key header (8 to 200 characters) is required")
        if len(batch.events) > self.s.max_batch_events:
            raise ValidationFailed("batch too large")
        seqs = [e.seq for e in batch.events]
        if seqs != list(range(seqs[0], seqs[0] + len(seqs))):
            raise ValidationFailed("batch sequence numbers must be contiguous and ascending")
        dev = self._device(batch.device_id)
        if dev["status"] != "active" or dev["agency_id"] != p.agency:
            raise Forbidden("device is not active for this agency")
        bh = sha256_hex(canonical_json([e.model_dump() for e in batch.events]))

        out: dict[str, Any]
        with self.db.tx() as c:
            prior = c.execute("SELECT * FROM batches WHERE device_id=? AND idem_key=?",
                              (batch.device_id, idem_key)).fetchone()  # fmt: skip
            if prior:
                if prior["batch_hash"] != bh:
                    raise Conflict("idempotency key reused with different content")
                self.metrics.inc("sync_batches_total", result="replay")
                return {**json.loads(prior["result_json"]), "idempotent_replay": True}
            cur = c.execute(
                "SELECT * FROM devices WHERE device_id=?", (batch.device_id,)
            ).fetchone()
            if cur["sync_state"] == "blocked":
                self.metrics.inc("sync_batches_total", result="blocked")
                raise Conflict("device is blocked pending quarantine review",
                               blocked_seq=cur["blocked_seq"], ack_through=cur["acked_seq"])  # fmt: skip
            acked, batch_id = int(cur["acked_seq"]), _rid("bt")
            new: list[EventIn] = []
            dups, problem, gap = 0, None, None
            for e in batch.events:
                if e.seq <= acked:
                    row = c.execute("SELECT content_hash FROM events WHERE device_id=? AND seq=?",
                                    (batch.device_id, e.seq)).fetchone()  # fmt: skip
                    if row is not None and row["content_hash"] != e.content_hash:
                        problem = (e, "sequence_reuse_mismatch",
                                   "sequence number already acknowledged with different content")  # fmt: skip
                        break
                    dups += 1
                    continue
                if e.seq != acked + len(new) + 1:
                    gap = acked + len(new) + 1
                    break
                if event_hash(batch.device_id, e) != e.content_hash:
                    problem = (e, "hash_mismatch", "content hash does not match the event bytes")
                    break
                bad = validate_event(e)
                if bad or len(canonical_json(e.payload)) > self.s.max_payload_bytes:
                    problem = (e, "schema_rejected", bad or "payload too large")
                    break
                new.append(e)

            now = self.clock()
            for e in new:
                c.execute("INSERT INTO events(device_id,seq,op_id,type,schema_version,record_id,"
                          "ts_ms,base_version,payload_json,content_hash,received_ms,batch_id) "
                          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                          (batch.device_id, e.seq, e.op_id, e.type, e.schema_version, e.record_id,
                           e.ts_ms, e.base_version, json.dumps(e.payload, sort_keys=True),
                           e.content_hash, now, batch_id))  # fmt: skip
                c.execute("INSERT INTO outbox(device_id,seq) VALUES(?,?)", (batch.device_id, e.seq))
            if new:
                acked = new[-1].seq
                c.execute("UPDATE devices SET acked_seq=?, last_sync_ms=? WHERE device_id=?",
                          (acked, now, batch.device_id))  # fmt: skip
                self.audit.append(c, self._actor(p), "sync.batch", "device", batch.device_id,
                                  {"batch_id": batch_id, "first_seq": new[0].seq,
                                   "last_seq": acked, "count": len(new), "duplicates": dups},
                                  ctx=ctx)  # fmt: skip
                self.metrics.inc("sync_events_accepted_total", len(new))
            if dups:
                self.metrics.inc("sync_duplicates_total", dups)
            out = {"batch_id": batch_id, "device_id": batch.device_id, "ack_through": acked,
                   "accepted": len(new), "duplicates": dups, "idempotent_replay": False,
                   "problem": None, "expected_seq": gap}  # fmt: skip
            if problem:
                e, reason, detail = problem
                qid = _rid("qt")
                c.execute("INSERT INTO quarantine(quarantine_id,device_id,seq,reason,detail_json,"
                          "event_json,received_ms) VALUES(?,?,?,?,?,?,?)",
                          (qid, batch.device_id, e.seq, reason, json.dumps({"detail": detail}),
                           json.dumps(e.model_dump(), sort_keys=True), now))  # fmt: skip
                c.execute("UPDATE devices SET sync_state='blocked', blocked_seq=? WHERE device_id=?",
                          (e.seq, batch.device_id))  # fmt: skip
                self._alert(c, "EVENT_QUARANTINED", "high" if reason != "schema_rejected" else "medium",
                            qid, {"device_id": batch.device_id, "seq": e.seq, "reason": reason})  # fmt: skip
                self.audit.append(c, SYSTEM, "sync.quarantined", "quarantine", qid,
                                  {"device_id": batch.device_id, "seq": e.seq, "reason": reason},
                                  ctx=ctx)  # fmt: skip
                self.metrics.inc("sync_quarantined_total", reason=reason)
                out["problem"] = {"quarantine_id": qid, "seq": e.seq, "reason": reason,
                                  "message": detail}  # fmt: skip
            elif gap is not None:
                self.metrics.inc("sync_batches_total", result="gap")
            else:
                c.execute("INSERT INTO batches(device_id,idem_key,batch_id,batch_hash,result_json,"
                          "ts_ms) VALUES(?,?,?,?,?,?)",
                          (batch.device_id, idem_key, batch_id, bh, json.dumps(out), now))  # fmt: skip
                self.metrics.inc("sync_batches_total", result="ok")
        if new:
            self.drain_outbox()
        return out

    def cursor(self, p: Principal, device_id: str, ctx: Ctx) -> dict[str, Any]:
        if p.role.value == "device":
            self._require(p, "sync:cursor", ctx)
            if p.sub != device_id:
                raise Forbidden("a device may only read its own cursor")
        else:
            self._require(p, "fleet:read", ctx)
        d = self._device(device_id)
        return {"device_id": device_id, "acked_seq": d["acked_seq"], "sync_state": d["sync_state"],
                "blocked_seq": d["blocked_seq"]}  # fmt: skip

    def heartbeat(self, p: Principal, device_id: str, hb: Heartbeat, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "sync:heartbeat", ctx)
        if p.sub != device_id:
            raise Forbidden("a device may only report its own heartbeat")
        d = self._device(device_id)
        if d["status"] != "active":
            raise Forbidden("device is not active")
        with self.db.tx() as c:
            c.execute("UPDATE devices SET last_hb_ms=?, hb_queue_depth=?, hb_oldest_age_s=?, "
                      "hb_free=?, hb_total=?, hb_version=?, hb_retries=? WHERE device_id=?",
                      (self.clock(), hb.queue_depth, hb.oldest_pending_age_s, hb.storage_free_bytes,
                       hb.storage_total_bytes, hb.app_version, hb.retries, device_id))  # fmt: skip
        self.metrics.inc("sync_heartbeats_total")
        return {"ok": True, "acked_seq": d["acked_seq"], "server_time_ms": self.clock()}

    # ---- outbox / projections ----------------------------------------------------------
    def drain_outbox(self, limit: int = 1000) -> int:
        done = 0
        rows = self.db.query("SELECT id, device_id, seq FROM outbox WHERE status='pending' "
                             "ORDER BY id LIMIT ?", (limit,))  # fmt: skip
        for r in rows:
            try:
                with self.db.tx() as c:
                    if (
                        c.execute("SELECT status FROM outbox WHERE id=?", (r["id"],)).fetchone()[0]
                        != "pending"
                    ):
                        continue
                    self._project(c, r["device_id"], r["seq"])
                    c.execute("UPDATE outbox SET status='done' WHERE id=?", (r["id"],))
                done += 1
            except sqlite3.IntegrityError:  # already projected (crash between effect and mark)
                with self.db.tx() as c:
                    c.execute("UPDATE outbox SET status='done' WHERE id=?", (r["id"],))
            except Exception:
                log.exception("projection failed")
                with self.db.tx() as c:
                    c.execute("UPDATE outbox SET attempts=attempts+1, status=CASE WHEN attempts>=4 "
                              "THEN 'dead' ELSE status END WHERE id=?", (r["id"],))  # fmt: skip
        return done

    def _project(self, c: sqlite3.Connection, device_id: str, seq: int) -> None:
        ev = c.execute(
            "SELECT * FROM events WHERE device_id=? AND seq=?", (device_id, seq)
        ).fetchone()
        payload, rid, now = json.loads(ev["payload_json"]), ev["record_id"], self.clock()
        rec = c.execute("SELECT * FROM records WHERE record_id=?", (rid,)).fetchone()

        def conflict(kind: str, cur: int | None) -> None:
            cid = _rid("cf")
            c.execute("INSERT INTO conflicts(conflict_id,record_id,device_id,seq,kind,base_version,"
                      "current_version,proposed_json,created_ms) VALUES(?,?,?,?,?,?,?,?,?)",
                      (cid, rid, device_id, seq, kind, ev["base_version"], cur,
                       json.dumps(payload, sort_keys=True), now))  # fmt: skip
            self._alert(c, "CONFLICT_OPEN", "medium", cid, {"record_id": rid, "kind": kind})
            self.audit.append(
                c,
                SYSTEM,
                "conflict.opened",
                "conflict",
                cid,
                {"record_id": rid, "kind": kind, "device_id": device_id, "seq": seq},
            )
            self.metrics.inc("sync_conflicts_total", kind=kind)

        if ev["type"] == "report.create":
            if rec:
                conflict("duplicate_create", rec["version"])
                return
            c.execute("INSERT INTO records VALUES(?,?,?,?,?)",
                      (rid, 1, json.dumps(payload, sort_keys=True), now, device_id))  # fmt: skip
            c.execute(
                "INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)",
                (rid, 1, json.dumps(payload, sort_keys=True), device_id, seq, "create", now),
            )
        elif ev["type"] == "report.update":
            if not rec:
                conflict("missing_record", None)
            elif ev["base_version"] != rec["version"]:
                conflict("stale_base", rec["version"])
            else:
                data = {**json.loads(rec["data_json"]), **payload["changes"]}
                v = rec["version"] + 1
                c.execute("UPDATE records SET version=?, data_json=?, updated_ms=? WHERE record_id=?",
                          (v, json.dumps(data, sort_keys=True), now, rid))  # fmt: skip
                c.execute(
                    "INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)",
                    (rid, v, json.dumps(data, sort_keys=True), device_id, seq, "update", now),
                )
        elif not rec:  # note.add
            conflict("missing_record", None)
        else:
            c.execute("INSERT INTO notes VALUES(?,?,?,?,?)",
                      (rid, device_id, seq, payload["text"], ev["ts_ms"]))  # fmt: skip

    # ---- reads -------------------------------------------------------------------------
    def fleet_rows(self) -> list[dict[str, Any]]:
        now, out = self.clock(), []
        for r in self.db.query("SELECT * FROM devices ORDER BY device_id"):
            seen = max(filter(None, [r["last_hb_ms"], r["last_sync_ms"]]), default=None)
            age = None if seen is None else (now - seen) / 1000
            conn = (
                "never"
                if age is None
                else "online"
                if age <= 2 * self.s.heartbeat_interval_s
                else "delayed"
                if age <= self.s.offline_after_s
                else "offline"
            )
            out.append({
                "device_id": r["device_id"], "label": r["label"], "agency_id": r["agency_id"],
                "status": r["status"], "sync_state": r["sync_state"], "blocked_seq": r["blocked_seq"],
                "acked_seq": r["acked_seq"], "last_seen_ms": seen, "connectivity": conn,
                "queue_depth": r["hb_queue_depth"], "oldest_pending_age_s": r["hb_oldest_age_s"],
                "storage_free_bytes": r["hb_free"], "storage_total_bytes": r["hb_total"],
                "app_version": r["hb_version"], "retries": r["hb_retries"],
            })  # fmt: skip
        return out

    def fleet(self, p: Principal, ctx: Ctx) -> list[dict[str, Any]]:
        self._require(p, "fleet:read", ctx)
        return self.fleet_rows()

    def device(self, p: Principal, device_id: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "fleet:read", ctx)
        rows = [d for d in self.fleet_rows() if d["device_id"] == device_id]
        if not rows:
            raise NotFound("device not found")
        return rows[0]

    def events(
        self, p: Principal, device_id: str, after: int, limit: int, ctx: Ctx
    ) -> list[dict[str, Any]]:
        self._require(p, "events:read", ctx)
        rows = self.db.query("SELECT * FROM events WHERE device_id=? AND seq>? ORDER BY seq LIMIT ?",
                             (device_id, after, min(limit, 500)))  # fmt: skip
        with self.db.tx() as c:
            self.audit.append(c, self._actor(p), "events.read", "device", device_id,
                              {"after": after, "count": len(rows)}, ctx=ctx)  # fmt: skip
        return [{**dict(r), "payload": json.loads(r["payload_json"])} | {"payload_json": None}
                for r in rows]  # fmt: skip

    def records(self, p: Principal, ctx: Ctx, limit: int = 100) -> list[dict[str, Any]]:
        self._require(p, "records:read", ctx)
        return [{**dict(r), "data": json.loads(r["data_json"])} | {"data_json": None}
                for r in self.db.query("SELECT * FROM records ORDER BY updated_ms DESC LIMIT ?",
                                       (min(limit, 500),))]  # fmt: skip

    def record(self, p: Principal, rid: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "records:read", ctx)
        r = self.db.one("SELECT * FROM records WHERE record_id=?", (rid,))
        if not r:
            raise NotFound("record not found")
        vs = self.db.query(
            "SELECT * FROM record_versions WHERE record_id=? ORDER BY version", (rid,)
        )
        ns = self.db.query("SELECT * FROM notes WHERE record_id=? ORDER BY ts_ms", (rid,))
        cf = self.db.query(
            "SELECT conflict_id,status,kind FROM conflicts WHERE record_id=?", (rid,)
        )
        return {"record_id": rid, "version": r["version"], "data": json.loads(r["data_json"]),
                "versions": [{**dict(v), "data": json.loads(v["data_json"]), "data_json": None} for v in vs],
                "notes": [dict(n) for n in ns], "conflicts": [dict(x) for x in cf]}  # fmt: skip

    def list_conflicts(self, p: Principal, status: str, ctx: Ctx) -> list[dict[str, Any]]:
        self._require(p, "conflicts:read", ctx)
        rows = self.db.query(
            "SELECT * FROM conflicts WHERE status=? ORDER BY created_ms DESC", (status,)
        )
        out = []
        for r in rows:
            rec = self.db.one("SELECT data_json FROM records WHERE record_id=?", (r["record_id"],))
            out.append({**dict(r), "proposed": json.loads(r["proposed_json"]), "proposed_json": None,
                        "current": json.loads(rec["data_json"]) if rec else None})  # fmt: skip
        return out

    def resolve_conflict(
        self, p: Principal, cid: str, decision: str, note: str, ctx: Ctx
    ) -> dict[str, Any]:
        self._require(p, "conflicts:review", ctx)
        with self.db.tx() as c:
            cf = c.execute("SELECT * FROM conflicts WHERE conflict_id=?", (cid,)).fetchone()
            if not cf:
                raise NotFound("conflict not found")
            if cf["status"] != "open":
                raise Conflict("conflict already resolved")
            newv = None
            if decision == "apply_proposed":
                if cf["kind"] != "stale_base":
                    raise ValidationFailed(
                        "only stale_base conflicts can apply the proposed change"
                    )
                rec = c.execute(
                    "SELECT * FROM records WHERE record_id=?", (cf["record_id"],)
                ).fetchone()
                data = {
                    **json.loads(rec["data_json"]),
                    **json.loads(cf["proposed_json"])["changes"],
                }
                newv = rec["version"] + 1
                c.execute("UPDATE records SET version=?, data_json=?, updated_ms=? WHERE record_id=?",
                          (newv, json.dumps(data, sort_keys=True), self.clock(), cf["record_id"]))  # fmt: skip
                c.execute("INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)",
                          (cf["record_id"], newv, json.dumps(data, sort_keys=True), None, None,
                           f"resolved:{cid}", self.clock()))  # fmt: skip
            c.execute("UPDATE conflicts SET status='resolved', resolution=?, resolved_by=?, "
                      "resolved_note=?, resolved_ms=? WHERE conflict_id=?",
                      (decision, p.sub, note, self.clock(), cid))  # fmt: skip
            c.execute("UPDATE alerts SET status='acknowledged', acked_by=?, acked_at_ms=? WHERE "
                      "kind='CONFLICT_OPEN' AND object_id=? AND status='open'",
                      (p.sub, self.clock(), cid))  # fmt: skip
            self.audit.append(
                c,
                self._actor(p),
                "conflict.resolved",
                "conflict",
                cid,
                {"decision": decision, "note": note, "new_version": newv},
                ctx=ctx,
            )
        self.metrics.inc("sync_conflicts_resolved_total", decision=decision)
        return {"conflict_id": cid, "decision": decision, "new_version": newv}

    def list_quarantine(self, p: Principal, status: str, ctx: Ctx) -> list[dict[str, Any]]:
        self._require(p, "quarantine:read", ctx)
        rows = self.db.query(
            "SELECT * FROM quarantine WHERE status=? ORDER BY received_ms DESC", (status,)
        )
        return [{**dict(r), "event": json.loads(r["event_json"]), "event_json": None,
                 "detail": json.loads(r["detail_json"]), "detail_json": None} for r in rows]  # fmt: skip

    def dispose_quarantine(
        self, p: Principal, qid: str, decision: str, note: str, ctx: Ctx
    ) -> dict[str, Any]:
        self._require(p, "quarantine:review", ctx)
        with self.db.tx() as c:
            q = c.execute("SELECT * FROM quarantine WHERE quarantine_id=?", (qid,)).fetchone()
            if not q:
                raise NotFound("quarantine item not found")
            if q["status"] != "open":
                raise Conflict("already reviewed")
            dev = c.execute("SELECT * FROM devices WHERE device_id=?", (q["device_id"],)).fetchone()
            if decision == "skip_authorized":
                if q["seq"] != dev["acked_seq"] + 1:
                    raise ValidationFailed("only the next unacknowledged sequence can be skipped")
                c.execute("INSERT INTO skips VALUES(?,?,?)", (q["device_id"], q["seq"], qid))
                c.execute(
                    "UPDATE devices SET acked_seq=? WHERE device_id=?", (q["seq"], q["device_id"])
                )
            c.execute("UPDATE devices SET sync_state='ok', blocked_seq=NULL WHERE device_id=?",
                      (q["device_id"],))  # fmt: skip
            c.execute("UPDATE quarantine SET status=?, reviewed_by=?, review_note=?, reviewed_ms=? "
                      "WHERE quarantine_id=?", (decision, p.sub, note, self.clock(), qid))  # fmt: skip
            c.execute("UPDATE alerts SET status='acknowledged', acked_by=?, acked_at_ms=? WHERE "
                      "kind='EVENT_QUARANTINED' AND object_id=? AND status='open'",
                      (p.sub, self.clock(), qid))  # fmt: skip
            self.audit.append(c, self._actor(p), "quarantine.disposition", "quarantine", qid,
                              {"decision": decision, "note": note, "device_id": q["device_id"],
                               "seq": q["seq"]}, ctx=ctx)  # fmt: skip
        return {"quarantine_id": qid, "decision": decision}

    # ---- alerts, scan ------------------------------------------------------------------
    def list_alerts(self, p: Principal, status: str, ctx: Ctx) -> list[dict[str, Any]]:
        self._require(p, "alerts:read", ctx)
        rows = self.db.query("SELECT * FROM alerts WHERE status=? ORDER BY ts_ms DESC", (status,))
        return [
            {**dict(r), "detail": json.loads(r["detail_json"]), "detail_json": None} for r in rows
        ]

    def ack_alert(self, p: Principal, aid: str, ctx: Ctx) -> dict[str, Any]:
        self._require(p, "alerts:ack", ctx)
        with self.db.tx() as c:
            r = c.execute("UPDATE alerts SET status='acknowledged', acked_by=?, acked_at_ms=? WHERE "
                          "alert_id=? AND status='open'", (p.sub, self.clock(), aid))  # fmt: skip
            if r.rowcount == 0:
                raise NotFound("open alert not found")
            self.audit.append(c, self._actor(p), "alert.acked", "alert", aid, ctx=ctx)
        return {"alert_id": aid, "status": "acknowledged"}

    def scan_fleet(self, p: Principal, ctx: Ctx) -> list[str]:
        self._require(p, "fleet:scan", ctx)
        raised: list[str] = []
        with self.db.tx() as c:
            for d in self.fleet_rows():
                if d["status"] != "active":
                    continue
                did = d["device_id"]
                checks = []
                if d["connectivity"] == "offline":
                    checks.append(("DEVICE_OFFLINE", "medium", {"last_seen_ms": d["last_seen_ms"]}))
                if d["queue_depth"] is not None and d["queue_depth"] >= self.s.backlog_alert:
                    checks.append(("BACKLOG_HIGH", "medium", {"queue_depth": d["queue_depth"]}))
                if d["storage_total_bytes"] and (
                    d["storage_free_bytes"] / d["storage_total_bytes"] < self.s.low_storage_ratio
                ):
                    checks.append(("STORAGE_LOW", "high", {"free": d["storage_free_bytes"],
                                                            "total": d["storage_total_bytes"]}))  # fmt: skip
                for kind, sev, detail in checks:
                    aid = self._alert(c, kind, sev, did, detail, dedupe=True)
                    if aid:
                        raised.append(aid)
            self.audit.append(c, self._actor(p), "fleet.scan", "fleet", "all",
                              {"raised": len(raised)}, ctx=ctx)  # fmt: skip
        return raised

    def require_audit(self, p: Principal, perm: str, ctx: Ctx) -> None:
        self._require(p, perm, ctx)

    # ---- advisory triage (read-only; never gates the workflow; never inside a transaction) ----
    def _advise(
        self, p: Principal, kind: str, oid: str, ctx_in: dict[str, Any], ctx: Ctx
    ) -> Advisory:
        adv = self.triage.assess(ctx_in)  # network call happens here, outside any transaction
        with self.db.tx() as c:
            self.audit.append(c, self._actor(p), "triage.advisory", kind, oid,
                              {"category": adv.category, "severity": adv.severity,
                               "source": adv.source, "model": adv.model,
                               "prompt_sha256": adv.prompt_sha256}, ctx=ctx)  # fmt: skip
        return adv

    def triage_quarantine(self, p: Principal, qid: str, ctx: Ctx) -> Advisory:
        self._require(p, "triage:run", ctx)
        q = self.db.one("SELECT * FROM quarantine WHERE quarantine_id=?", (qid,))
        if not q:
            raise NotFound("quarantine item not found")
        ev = {
            "schema_rejected": "schema_rejected",
            "sequence_reuse_mismatch": "sequence_reuse",
        }.get(q["reason"], "hash_mismatch")
        row = self.db.one("SELECT COUNT(*) n FROM quarantine WHERE device_id=? AND quarantine_id!=?",
                          (q["device_id"], qid))  # fmt: skip
        prior = int(row["n"]) if row else 0
        sv = json.loads(q["event_json"]).get("schema_version")
        info: dict[str, Any] = {"event": ev, "device_prior_incidents": prior, "seq": q["seq"],
                                "device_id": q["device_id"], "quarantine_id": qid}  # fmt: skip
        if isinstance(sv, int):
            info["schema_version"] = sv
        return self._advise(p, "quarantine", qid, info, ctx)

    def triage_conflict(self, p: Principal, cid: str, ctx: Ctx) -> Advisory:
        self._require(p, "triage:run", ctx)
        r = self.db.one("SELECT * FROM conflicts WHERE conflict_id=?", (cid,))
        if not r:
            raise NotFound("conflict not found")
        info = {"event": "conflict", "conflict_kind": r["kind"], "device_id": r["device_id"],
                "seq": r["seq"], "conflict_id": cid}  # fmt: skip
        return self._advise(p, "conflict", cid, info, ctx)

    def triage_alert(self, p: Principal, aid: str, ctx: Ctx) -> Advisory:
        self._require(p, "triage:run", ctx)
        a = self.db.one("SELECT * FROM alerts WHERE alert_id=?", (aid,))
        if not a:
            raise NotFound("alert not found")
        d = json.loads(a["detail_json"])
        info: dict[str, Any]
        if a["kind"] == "DEVICE_OFFLINE":
            seen = d.get("last_seen_ms") or self.clock()
            info = {
                "event": "device_offline",
                "hours_offline": max(0, (self.clock() - seen) // 3_600_000),
            }
        elif a["kind"] == "BACKLOG_HIGH":
            info = {"event": "backlog_high", "queue_depth": d.get("queue_depth", 0)}
        elif a["kind"] == "STORAGE_LOW":
            info = {
                "event": "storage_low",
                "storage_free_ratio": d.get("free", 0) / max(1, d.get("total", 1)),
            }
        else:
            raise ValidationFailed(
                f"no advisory is defined for {a['kind']} alerts; use the quarantine or conflict advisory"
            )
        info["device_id"] = a["object_id"] or ""
        return self._advise(p, "alert", aid, info, ctx)


__all__ = ["SyncError", "SyncService", "validate_event"]
