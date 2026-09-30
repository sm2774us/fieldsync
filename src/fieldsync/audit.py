"""Append-only, hash-chained audit log with signed checkpoints.

Each entry commits to its predecessor: entry_hash = SHA-256(prev_hash | canonical(entry)).
Rewriting or deleting history breaks every later hash; truncation is caught by signed
checkpoints, which should be anchored off-box (WORM bucket / transparency log)."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .crypto import GENESIS_HASH, Signer, chain_hash, verify_signature
from .db import Database

Clock = Callable[[], int]


@dataclass(frozen=True)
class Ctx:
    """Request context stamped onto every audit row."""

    ip: str = "-"
    request_id: str = "-"


@dataclass(frozen=True)
class Actor:
    sub: str
    role: str


SYSTEM = Actor("system", "system")


@dataclass(frozen=True)
class ChainStatus:
    ok: bool
    entries: int
    head_hash: str
    checkpoints_verified: int
    error: str | None = None
    first_bad_seq: int | None = None


class AuditLog:
    def __init__(self, db: Database, signer: Signer, clock: Clock) -> None:
        self.db, self.signer, self.clock = db, signer, clock

    def append(
        self,
        conn: sqlite3.Connection,
        actor: Actor,
        action: str,
        object_type: str,
        object_id: str,
        detail: dict[str, Any] | None = None,
        *,
        object_version: str | None = None,
        ctx: Ctx = Ctx(),  # noqa: B008 - frozen dataclass
    ) -> int:
        """Must be called inside Database.tx() so it commits atomically with the change."""
        last = conn.execute(
            "SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        seq, prev = (last["seq"] + 1, last["entry_hash"]) if last else (1, GENESIS_HASH)
        entry = {
            "seq": seq,
            "ts_ms": self.clock(),
            "actor": actor.sub,
            "actor_role": actor.role,
            "action": action,
            "object_type": object_type,
            "object_id": object_id,
            "object_version": object_version,
            "source_ip": ctx.ip,
            "request_id": ctx.request_id,
            "detail_json": json.dumps(detail or {}, sort_keys=True, separators=(",", ":")),
        }
        h = chain_hash(prev, entry)
        conn.execute(
            "INSERT INTO audit_log(seq,ts_ms,actor,actor_role,action,object_type,object_id,"
            "object_version,source_ip,request_id,detail_json,prev_hash,entry_hash) "
            "VALUES(:seq,:ts_ms,:actor,:actor_role,:action,:object_type,:object_id,"
            ":object_version,:source_ip,:request_id,:detail_json,:prev,:h)",
            {**entry, "prev": prev, "h": h},
        )
        return seq

    # ---- reads -------------------------------------------------------------------------
    def entries(self, after: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM audit_log WHERE seq>? ORDER BY seq LIMIT ?", (after, min(limit, 1000))
        )
        return [self._row(r) for r in rows]

    def for_objects(self, object_ids: list[str]) -> list[dict[str, Any]]:
        if not object_ids:
            return []
        q = ",".join("?" * len(object_ids))
        rows = self.db.query(
            f"SELECT * FROM audit_log WHERE object_id IN ({q}) ORDER BY seq",  # noqa: S608
            object_ids,
        )
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        d["detail"] = json.loads(d.pop("detail_json"))
        return d

    def head(self) -> tuple[int, str]:
        r = self.db.one("SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
        return (r["seq"], r["entry_hash"]) if r else (0, GENESIS_HASH)

    # ---- integrity ---------------------------------------------------------------------
    def verify(self) -> ChainStatus:
        prev, expected, count, last_seq = GENESIS_HASH, 1, 0, 0
        cursor = 0
        while True:
            rows = self.db.query(
                "SELECT * FROM audit_log WHERE seq>? ORDER BY seq LIMIT 1000", (cursor,)
            )
            if not rows:
                break
            for r in rows:
                if r["seq"] != expected:
                    return ChainStatus(
                        False, count, prev, 0, f"gap before seq {r['seq']}", expected
                    )
                entry = {
                    k: r[k]
                    for k in (
                        "seq",
                        "ts_ms",
                        "actor",
                        "actor_role",
                        "action",
                        "object_type",
                        "object_id",
                        "object_version",
                        "source_ip",
                        "request_id",
                        "detail_json",
                    )  # fmt: skip
                }
                if r["prev_hash"] != prev or chain_hash(prev, entry) != r["entry_hash"]:
                    return ChainStatus(
                        False, count, prev, 0, f"hash mismatch at seq {r['seq']}", r["seq"]
                    )
                prev, expected, count, last_seq = r["entry_hash"], expected + 1, count + 1, r["seq"]
                cursor = r["seq"]
        verified = 0
        for c in self.db.query("SELECT * FROM audit_checkpoints ORDER BY seq"):
            msg = {"seq": c["seq"], "entry_hash": c["entry_hash"], "ts_ms": c["ts_ms"]}
            ok_sig = verify_signature(
                self.signer.public_hex, c["signature"], json.dumps(msg, sort_keys=True).encode()
            )
            row = self.db.one("SELECT entry_hash FROM audit_log WHERE seq=?", (c["seq"],))
            if (
                not ok_sig
                or c["seq"] > last_seq
                or row is None
                or row["entry_hash"] != c["entry_hash"]
            ):
                return ChainStatus(
                    False, count, prev, verified, f"checkpoint {c['seq']} invalid", c["seq"]
                )
            verified += 1
        return ChainStatus(True, count, prev, verified)

    def checkpoint(self) -> dict[str, Any]:
        """Sign the current head. Export the result to an independent WORM location."""
        seq, head = self.head()
        if seq == 0:
            return {"seq": 0, "entry_hash": head, "signature": None}
        msg = {"seq": seq, "entry_hash": head, "ts_ms": self.clock()}
        sig = self.signer.sign(json.dumps(msg, sort_keys=True).encode())
        with self.db.tx() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO audit_checkpoints VALUES(?,?,?,?,?)",
                (seq, head, msg["ts_ms"], self.signer.key_id, sig),
            )
        return {**msg, "key_id": self.signer.key_id, "signature": sig}
