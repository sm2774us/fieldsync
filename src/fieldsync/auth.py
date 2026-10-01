"""Authentication tokens and role-based, least-privilege authorization.

Dev tokens are HMAC-signed bearer tokens. In production terminate mTLS/OIDC at the edge and
map claims to `Principal`; the permission model below is unchanged.

Separation of duties is structural: `admin` can enrol devices and sign checkpoints but can read
neither events nor records; `auditor` reads history but cannot change anything; a device may only
write its own log; quarantine and conflict decisions belong to `reviewer`."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from enum import StrEnum

from .errors import AuthError


class Role(StrEnum):
    DEVICE = "device"
    SUPERVISOR = "supervisor"
    REVIEWER = "reviewer"
    AUDITOR = "auditor"
    ADMIN = "admin"


PERMISSIONS: dict[Role, frozenset[str]] = {
    Role.DEVICE: frozenset({"sync:write", "sync:cursor", "sync:heartbeat"}),
    Role.SUPERVISOR: frozenset(
        {
            "fleet:read",
            "fleet:scan",
            "events:read",
            "records:read",
            "alerts:read",
            "alerts:ack",
            "conflicts:read",
            "triage:run",
            "quarantine:read",
        }
    ),  # fmt: skip
    Role.REVIEWER: frozenset(
        {
            "records:read",
            "events:read",
            "conflicts:read",
            "conflicts:review",
            "triage:run",
            "quarantine:read",
            "quarantine:review",
        }
    ),  # fmt: skip
    Role.AUDITOR: frozenset(
        {
            "audit:read",
            "audit:verify",
            "fleet:read",
            "events:read",
            "alerts:read",
            "alerts:ack",
            "conflicts:read",
            "triage:run",
            "quarantine:read",
        }
    ),  # fmt: skip
    Role.ADMIN: frozenset(
        {
            "device:register",
            "device:activate",
            "device:revoke",
            "principal:revoke",
            "audit:checkpoint",
        }
    ),  # fmt: skip
}


@dataclass(frozen=True)
class Principal:
    sub: str
    role: Role
    agency: str
    jti: str = ""

    def can(self, perm: str) -> bool:
        return perm in PERMISSIONS[self.role]


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token(
    secret: str, sub: str, role: Role, agency: str, now_ms: int, ttl_s: int = 900
) -> str:
    payload = {"sub": sub, "role": role.value, "agency": agency,
               "exp": now_ms // 1000 + ttl_s, "jti": uuid.uuid4().hex}  # fmt: skip
    body = _b64(json.dumps(payload, sort_keys=True).encode())
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def parse_token(secret: str, token: str, now_ms: int) -> Principal:
    try:
        body, mac = token.split(".", 1)
        want = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, _unb64(mac)):
            raise AuthError("invalid token signature")
        p = json.loads(_unb64(body))
        if p["exp"] <= now_ms // 1000:
            raise AuthError("token expired")
        return Principal(p["sub"], Role(p["role"]), p["agency"], p["jti"])
    except AuthError:
        raise
    except (ValueError, KeyError, TypeError) as e:
        raise AuthError("malformed token") from e
