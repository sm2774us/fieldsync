"""Wire models shared by the API and the reference device client."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .crypto import canonical_json, sha256_hex

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"


class EventIn(BaseModel):
    seq: int = Field(ge=1)
    op_id: str = Field(min_length=8, max_length=64)
    type: str = Field(max_length=40)
    schema_version: int = Field(ge=1)
    record_id: str = Field(pattern=r"^[A-Za-z0-9_-]{4,64}$")
    ts_ms: int = Field(ge=0)
    base_version: int | None = Field(default=None, ge=0)
    payload: dict[str, Any]
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class BatchIn(BaseModel):
    device_id: str = Field(pattern=ID_PATTERN)
    events: list[EventIn] = Field(min_length=1, max_length=500)


class DeviceRegistration(BaseModel):
    device_id: str = Field(pattern=ID_PATTERN)
    label: str = Field(min_length=1, max_length=80)
    agency_id: str = Field(pattern=ID_PATTERN)


class Heartbeat(BaseModel):
    queue_depth: int = Field(ge=0)
    oldest_pending_age_s: int = Field(ge=0, default=0)
    storage_free_bytes: int = Field(ge=0)
    storage_total_bytes: int = Field(gt=0)
    app_version: str = Field(max_length=32)
    retries: int = Field(ge=0, default=0)


class Disposition(BaseModel):
    decision: str = Field(pattern="^(retry_authorized|skip_authorized)$")
    note: str = Field(min_length=8, max_length=500)


class Resolution(BaseModel):
    decision: str = Field(pattern="^(apply_proposed|keep_current)$")
    note: str = Field(min_length=8, max_length=500)


def event_hash(device_id: str, e: EventIn | dict[str, Any]) -> str:
    """Hash of the event envelope (everything except the hash itself). Mirrored in TypeScript."""
    d = e.model_dump() if isinstance(e, EventIn) else dict(e)
    d.pop("content_hash", None)
    return sha256_hex(canonical_json({**d, "device_id": device_id}))
