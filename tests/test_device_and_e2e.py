import json
import secrets
import sqlite3
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from fastapi.testclient import TestClient

from fieldsync.app import create_app
from fieldsync.auth import Role
from fieldsync.cli import main
from fieldsync.config import Settings
from fieldsync.device import LocalLog, SyncClient
from fieldsync.models import event_hash
from fieldsync.simulate import Lossy, run_scenario

from .conftest import Env

ROOT = Path(__file__).resolve().parents[1]


def test_cross_language_event_hash_vector() -> None:
    v = json.loads((ROOT / "tests/vectors/event_vector.json").read_text())
    assert event_hash(v["device_id"], v["event"]) == v["event"]["content_hash"]


def test_web_copy_of_the_vector_is_identical() -> None:
    a = (ROOT / "tests/vectors/event_vector.json").read_bytes()
    assert (ROOT / "web/test/fixtures/event_vector.json").read_bytes() == a, (
        "copy it to web/test/fixtures/"
    )


def test_local_log_is_encrypted_append_only_and_sequence_survives_compaction(
    tmp_path: Path,
) -> None:
    lg = LocalLog(str(tmp_path / "l.db"), secrets.token_bytes(32), "unit-1")
    lg.append("note.add", "rec-0001", {"text": "TOP-SECRET-PLAINTEXT"}, ts_ms=1)
    lg.db.close()
    assert (
        b"TOP-SECRET-PLAINTEXT"
        not in (tmp_path / "l.db").read_bytes() + (tmp_path / "l.db-wal").read_bytes()
        if (tmp_path / "l.db-wal").exists()
        else True
    )
    lg = LocalLog(str(tmp_path / "l.db"), secrets.token_bytes(32), "unit-1")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        lg.db.execute("UPDATE log SET blob=x'00'")
    lg.mark(1, "acked")
    assert lg.compact() == 1
    assert lg.append("note.add", "rec-0001", {"text": "later"}, ts_ms=2)["seq"] == 2  # never reused


def test_client_resumes_after_lost_acknowledgement(env: Env, tmp_path: Path) -> None:
    d = env.device()
    lg = LocalLog(str(tmp_path / "d.db"), secrets.token_bytes(32), d)
    for i in range(5):
        lg.append(
            "note.add" if i else "report.create",
            "rec-0001",
            {"text": "n"} if i else {"title": "t", "body": "b"},
            ts_ms=i,
        )
    wire = Lossy(env.c, lose_ack_every=1, drop_every=999)  # every response is lost after commit
    cl = SyncClient(
        lg,
        cast(Any, wire),
        env.h(Role.DEVICE, d)["authorization"][7:],
        batch=10,
        sleep=lambda _: None,
    )
    assert cl.sync_once()["status"] == "offline"
    assert lg.counts() == {"local": 5}  # device does not know the server has them
    wire.a = 999
    assert cl.sync_once()["status"] == "ok"  # cursor shows 5 acked: nothing is re-sent
    assert lg.counts() == {"acked": 5}
    assert (
        len(env.c.get(f"/v1/devices/{d}/events", headers=env.h(Role.SUPERVISOR)).json()["events"])
        == 5
    )


def test_client_reports_rejection_and_blocked(env: Env, tmp_path: Path) -> None:
    d = env.device()
    lg = LocalLog(str(tmp_path / "d.db"), secrets.token_bytes(32), d)
    lg.append("report.delete", "rec-0001", {"x": 1}, ts_ms=1)
    cl = SyncClient(
        lg, cast(Any, env.c), env.h(Role.DEVICE, d)["authorization"][7:], sleep=lambda _: None
    )
    r = cl.sync_once()
    assert r["status"] == "rejected" and lg.counts() == {"failed": 1}


def test_full_scenario_runs_clean(settings: Settings) -> None:
    with TestClient(create_app(settings)) as http:
        out = run_scenario(http, settings.token_secret, say=lambda _: None)
        assert out["device_id"]


def test_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["init"]) == 0 and "SYNC_SIGNING_KEY=" in capsys.readouterr().out
    monkeypatch.delenv("SYNC_TOKEN_SECRET", raising=False)
    assert main(["issue-token", "--sub", "a", "--role", "admin"]) == 2
    assert main(["seed"]) == 2
    monkeypatch.setenv("SYNC_TOKEN_SECRET", "s3cret")
    monkeypatch.setenv("SYNC_DATA_DIR", str(tmp_path))
    assert main(["issue-token", "--sub", "a", "--role", "admin"]) == 0
    assert main(["verify-audit"]) == 0
    assert main(["demo"]) == 0
    assert "chain ok=True" in capsys.readouterr().out


def test_seed_against_a_running_server_shape(settings: Settings) -> None:
    with TestClient(create_app(settings)) as http:
        out = run_scenario(
            cast(httpx.Client, http),
            settings.token_secret,
            say=lambda _: None,
            device_id="seed-unit",
        )
        assert out["device_id"] == "seed-unit"


def test_seed_can_leave_work_for_hands_on_review(settings: Settings) -> None:
    from fieldsync.auth import issue_token

    with TestClient(create_app(settings)) as http:
        run_scenario(http, settings.token_secret, say=lambda _: None, resolve=False)
        rev = {
            "authorization": "Bearer "
            + issue_token(
                settings.token_secret, "r", Role.REVIEWER, "agency-1", 1_800_000_000_000, 60
            )
        }
        assert len(http.get("/v1/conflicts", headers=rev).json()["conflicts"]) == 1
        assert len(http.get("/v1/quarantine", headers=rev).json()["items"]) == 1
