"""SQLite persistence (dev/reference). Production swaps in PostgreSQL with the same schema
and REVOKE UPDATE/DELETE on audit tables; the triggers below are defense in depth."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any

_IMMUTABLE = ("audit_log", "audit_checkpoints", "events", "record_versions", "notes", "skips")


def _triggers() -> str:
    out = []
    for t in _IMMUTABLE:
        for op in ("UPDATE", "DELETE"):
            out.append(
                f"CREATE TRIGGER IF NOT EXISTS {t}_no_{op.lower()} BEFORE {op} ON {t} "
                f"BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END;"
            )
    out.append(
        "CREATE TRIGGER IF NOT EXISTS quarantine_keeps_original BEFORE UPDATE ON quarantine "
        "WHEN NEW.event_json != OLD.event_json OR NEW.reason != OLD.reason OR NEW.seq != OLD.seq "
        "BEGIN SELECT RAISE(ABORT, 'quarantined original is immutable'); END;"
    )
    out.append(
        "CREATE TRIGGER IF NOT EXISTS quarantine_no_delete BEFORE DELETE ON quarantine "
        "BEGIN SELECT RAISE(ABORT, 'quarantine is append-only'); END;"
    )
    return "\n".join(out)


SCHEMA = """
CREATE TABLE IF NOT EXISTS devices(
  device_id TEXT PRIMARY KEY, label TEXT NOT NULL, agency_id TEXT NOT NULL, status TEXT NOT NULL,
  registered_by TEXT NOT NULL, activated_by TEXT, registered_at INTEGER NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0, sync_state TEXT NOT NULL DEFAULT 'ok', blocked_seq INTEGER,
  last_sync_ms INTEGER, last_hb_ms INTEGER, hb_queue_depth INTEGER, hb_oldest_age_s INTEGER,
  hb_free INTEGER, hb_total INTEGER, hb_version TEXT, hb_retries INTEGER);
CREATE TABLE IF NOT EXISTS revoked_tokens(jti TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  device_id TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  schema_version INTEGER NOT NULL, record_id TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  base_version INTEGER, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  received_ms INTEGER NOT NULL, batch_id TEXT NOT NULL, PRIMARY KEY(device_id, seq));
CREATE INDEX IF NOT EXISTS ix_events_record ON events(record_id);
CREATE TABLE IF NOT EXISTS batches(
  device_id TEXT NOT NULL, idem_key TEXT NOT NULL, batch_id TEXT NOT NULL, batch_hash TEXT NOT NULL,
  result_json TEXT NOT NULL, ts_ms INTEGER NOT NULL, PRIMARY KEY(device_id, idem_key));
CREATE TABLE IF NOT EXISTS skips(device_id TEXT NOT NULL, seq INTEGER NOT NULL, quarantine_id TEXT NOT NULL,
  PRIMARY KEY(device_id, seq));
CREATE TABLE IF NOT EXISTS quarantine(
  quarantine_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, reason TEXT NOT NULL,
  detail_json TEXT NOT NULL, event_json TEXT NOT NULL, received_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, review_note TEXT, reviewed_ms INTEGER);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(device_id, seq));
CREATE TABLE IF NOT EXISTS records(
  record_id TEXT PRIMARY KEY, version INTEGER NOT NULL, data_json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS record_versions(
  record_id TEXT NOT NULL, version INTEGER NOT NULL, data_json TEXT NOT NULL, device_id TEXT,
  seq INTEGER, cause TEXT NOT NULL, ts_ms INTEGER NOT NULL, PRIMARY KEY(record_id, version));
CREATE UNIQUE INDEX IF NOT EXISTS ux_rv_origin ON record_versions(device_id, seq) WHERE device_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS notes(
  record_id TEXT NOT NULL, device_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
  ts_ms INTEGER NOT NULL, PRIMARY KEY(device_id, seq));
CREATE TABLE IF NOT EXISTS conflicts(
  conflict_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, device_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, base_version INTEGER, current_version INTEGER, proposed_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_ms INTEGER NOT NULL, resolution TEXT,
  resolved_by TEXT, resolved_note TEXT, resolved_ms INTEGER, UNIQUE(device_id, seq));
CREATE TABLE IF NOT EXISTS alerts(
  alert_id TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
  object_id TEXT, detail_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  acked_by TEXT, acked_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS audit_log(
  seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, actor TEXT NOT NULL, actor_role TEXT NOT NULL,
  action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, object_version TEXT,
  source_ip TEXT, request_id TEXT, detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_audit_object ON audit_log(object_id);
CREATE TABLE IF NOT EXISTS audit_checkpoints(
  seq INTEGER PRIMARY KEY, entry_hash TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL, signature TEXT NOT NULL);
""" + _triggers()


class Database:
    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Serialized write transaction. State changes and their audit rows commit atomically."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def query(self, sql: str, args: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def one(self, sql: str, args: Sequence[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, args)
        return rows[0] if rows else None

    def raw(self) -> sqlite3.Connection:
        """Test hook: direct handle to simulate an attacker with database access."""
        return self._conn
