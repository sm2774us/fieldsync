"""Reference offline-first DEVICE: encrypted, append-only local event log + resumable sync client.

Mirrors the browser client in web/src/lib/sync. Local event states: local -> uploading -> acked
(or failed). Acknowledged events are compacted only after the server confirms the cursor.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .crypto import canonical_json, sha256_hex
from .models import EventIn, event_hash


class Transport(Protocol):
    def post(self, url: str, **kw: Any) -> Any: ...
    def get(self, url: str, **kw: Any) -> Any: ...


class LocalLog:
    """SQLite log. Payloads are AES-256-GCM encrypted at rest; rows are never edited, only their
    delivery state advances."""

    def __init__(self, path: str, key: bytes, device_id: str) -> None:
        self.aes, self.device_id = AESGCM(key), device_id
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            "CREATE TABLE IF NOT EXISTS log(seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, "
            "blob BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'local', attempts INTEGER DEFAULT 0, "
            "error TEXT);"
            "CREATE TRIGGER IF NOT EXISTS log_immutable BEFORE UPDATE OF seq, op_id, blob ON log "
            "BEGIN SELECT RAISE(ABORT, 'local log is append-only'); END;"
        )

    def _enc(self, d: dict[str, Any]) -> bytes:
        n = os.urandom(12)
        return n + self.aes.encrypt(n, canonical_json(d), self.device_id.encode())

    def _dec(self, b: bytes) -> dict[str, Any]:
        out: dict[str, Any] = json.loads(self.aes.decrypt(b[:12], b[12:], self.device_id.encode()))
        return out

    def append(self, type_: str, record_id: str, payload: dict[str, Any], *, ts_ms: int,
               base_version: int | None = None, schema_version: int = 1) -> dict[str, Any]:  # fmt: skip
        # sqlite_sequence survives compaction: sequence numbers are never reused, even after deletes.
        row = self.db.execute("SELECT seq FROM sqlite_sequence WHERE name='log'").fetchone()
        last = row["seq"] if row else 0
        env = {"seq": last + 1, "op_id": uuid.uuid4().hex, "type": type_, "schema_version": schema_version,
               "record_id": record_id, "ts_ms": ts_ms, "base_version": base_version, "payload": payload}  # fmt: skip
        env["content_hash"] = event_hash(self.device_id, env)
        self.db.execute("INSERT INTO log(seq,op_id,blob) VALUES(?,?,?)",
                        (env["seq"], env["op_id"], self._enc(env)))  # fmt: skip
        return env

    def pending(self, limit: int) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT blob FROM log WHERE state!='acked' AND state!='failed' "
                               "ORDER BY seq LIMIT ?", (limit,)).fetchall()  # fmt: skip
        return [self._dec(r["blob"]) for r in rows]

    def mark(self, upto: int, state: str) -> None:
        self.db.execute("UPDATE log SET state=? WHERE seq<=? AND state!='acked'", (state, upto))

    def set_state(self, seq: int, state: str, error: str | None = None) -> None:
        self.db.execute("UPDATE log SET state=?, error=? WHERE seq=?", (state, error, seq))

    def counts(self) -> dict[str, int]:
        return {
            r["state"]: r["n"]
            for r in self.db.execute("SELECT state, COUNT(*) n FROM log GROUP BY state")
        }

    def compact(self, keep: int = 0) -> int:
        """Delete acknowledged events (the only deletion the log ever performs)."""
        cur = self.db.execute(
            "DELETE FROM log WHERE state='acked' AND seq <= "
            "(SELECT COALESCE(MAX(seq),0) FROM log WHERE state='acked') - ?",
            (keep,),
        )
        return cur.rowcount


class SyncClient:
    def __init__(self, log: LocalLog, http: Transport, token: str, *, batch: int = 50,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], int] | None = None) -> None:  # fmt: skip
        self.log, self.http, self.batch = log, http, batch
        self.h, self.sleep = {"authorization": f"Bearer {token}"}, sleep
        self.retries, self.duplicates_seen = 0, 0

    def cursor(self) -> int:
        r = self.http.get(f"/v1/devices/{self.log.device_id}/cursor", headers=self.h)
        r.raise_for_status()
        return int(r.json()["acked_seq"])

    def sync_once(self) -> dict[str, Any]:
        """One resumable pass. Returns {'acked': n, 'status': 'ok'|'offline'|'blocked'|'rejected'}."""
        try:
            acked = self.cursor()  # resume point: survives lost acknowledgements
        except Exception:
            return {"status": "offline", "acked": 0}
        self.log.mark(acked, "acked")
        total = 0
        while True:
            evs = self.log.pending(self.batch)
            if not evs:
                return {"status": "ok", "acked": total}
            first, last = evs[0]["seq"], evs[-1]["seq"]
            key = f"{self.log.device_id}:{first}-{last}:" + sha256_hex(canonical_json(evs))[:16]
            self.log.mark(last, "uploading")
            try:
                r = self.http.post(
                    "/v1/sync/batches",
                    headers={**self.h, "idempotency-key": key},
                    json={"device_id": self.log.device_id, "events": evs},
                )
            except Exception:
                self.retries += 1
                self.log.mark(last, "local")
                return {"status": "offline", "acked": total}
            body = r.json()
            if r.status_code == 200:
                total += body["accepted"]
                self.duplicates_seen += body["duplicates"]
                self.log.mark(body["ack_through"], "acked")
                continue
            if r.status_code == 422:  # quarantined server-side: keep locally, surface, stop
                self.log.mark(last, "local")
                self.log.set_state(body["seq"], "failed", body.get("reason"))
                return {"status": "rejected", "acked": total, "reason": body.get("reason")}
            self.log.mark(last, "local")
            if r.status_code == 409 and body.get("error") == "sequence_gap":
                self.log.mark(body["ack_through"], "acked")
                continue
            return {"status": "blocked" if r.status_code == 409 else "offline", "acked": total}


def make_event(device_id: str, seq: int, type_: str, record_id: str, payload: dict[str, Any],
               ts_ms: int, base_version: int | None = None) -> EventIn:  # fmt: skip
    env: dict[str, Any] = {"seq": seq, "op_id": uuid.uuid4().hex, "type": type_, "schema_version": 1,
                           "record_id": record_id, "ts_ms": ts_ms, "base_version": base_version,
                           "payload": payload}  # fmt: skip
    env["content_hash"] = event_hash(device_id, env)
    return EventIn(**env)
