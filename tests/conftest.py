from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from fieldsync.app import create_app
from fieldsync.auth import Role, issue_token
from fieldsync.config import Settings
from fieldsync.device import make_event
from fieldsync.models import EventIn


class Clock:
    def __init__(self) -> None:
        self.t = 1_800_000_000_000

    def __call__(self) -> int:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += int(seconds * 1000)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path, backlog_alert=100).with_dev_secrets()


@pytest.fixture
def app(settings: Settings, clock: Clock) -> Any:
    from fieldsync.app import build_service

    return create_app(settings, build_service(settings, clock))


@pytest.fixture
def client(app: Any) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


class Env:
    def __init__(self, client: TestClient, settings: Settings, clock: Clock) -> None:
        self.c, self.s, self.clock = client, settings, clock

    def h(self, role: Role, sub: str = "u1", agency: str = "agency-1") -> dict[str, str]:
        t = issue_token(self.s.token_secret, sub, role, agency, self.clock(), 3600)
        return {"authorization": f"Bearer {t}"}

    def device(self, device_id: str = "unit-1", *, activate: bool = True) -> str:
        r = self.c.post("/v1/devices", headers=self.h(Role.ADMIN, "admin-a"),
                        json={"device_id": device_id, "label": "Unit", "agency_id": "agency-1"})  # fmt: skip
        assert r.status_code == 201, r.text
        if activate:
            a = self.c.post(
                f"/v1/devices/{device_id}/activate", headers=self.h(Role.ADMIN, "admin-b")
            )
            assert a.status_code == 200, a.text
        return device_id

    def ev(
        self,
        device_id: str,
        seq: int,
        type_: str = "report.create",
        rid: str = "rec-0001",
        payload: dict[str, Any] | None = None,
        base: int | None = None,
    ) -> EventIn:
        p = payload if payload is not None else {"title": f"t{seq}", "body": "b"}
        return make_event(device_id, seq, type_, rid, p, self.clock(), base)

    def send(
        self,
        device_id: str,
        events: list[EventIn],
        key: str = "key-00000001",
        sub: str | None = None,
    ) -> Any:
        return self.c.post("/v1/sync/batches", headers={**self.h(Role.DEVICE, sub or device_id), "idempotency-key": key},
                           json={"device_id": device_id, "events": [e.model_dump() for e in events]})  # fmt: skip


@pytest.fixture
def env(client: TestClient, settings: Settings, clock: Clock) -> Env:
    return Env(client, settings, clock)
