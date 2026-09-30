"""Domain errors. Each carries an HTTP status and a stable machine-readable code."""

from __future__ import annotations

from typing import Any


class SyncError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra


class AuthError(SyncError):
    status, code = 401, "unauthenticated"


class Forbidden(SyncError):
    status, code = 403, "forbidden"


class NotFound(SyncError):
    status, code = 404, "not_found"


class Conflict(SyncError):
    status, code = 409, "conflict"


class ValidationFailed(SyncError):
    status, code = 422, "validation_failed"


class IntegrityFailure(SyncError):
    """Bytes did not match what the device attested to. Never retried silently."""

    status, code = 422, "integrity_failure"


class Quarantined(SyncError):
    status, code = 422, "quarantined"


class WormViolation(SyncError):
    status, code = 409, "worm_violation"
