"""Hashing, canonical JSON, and Ed25519 signing primitives."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

GENESIS_HASH = "0" * 64


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj: Any) -> bytes:
    """Deterministic JSON shared with the TypeScript SDK (sorted keys, no whitespace, ASCII)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def chain_hash(prev_hash: str, payload: dict[str, Any]) -> str:
    return sha256_hex(prev_hash.encode() + b"|" + canonical_json(payload))


class Signer:
    """Ed25519 signer. In production the seed lives in a KMS/HSM, never in env."""

    def __init__(self, seed_hex: str) -> None:
        self._key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))
        raw = self._key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        self.public_hex = raw.hex()
        self.key_id = sha256_hex(raw)[:16]

    def sign(self, message: bytes) -> str:
        return self._key.sign(message).hex()

    def sign_obj(self, obj: Any) -> str:
        return self.sign(canonical_json(obj))


def verify_signature(public_hex: str, signature_hex: str, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_hex)).verify(
            bytes.fromhex(signature_hex), message
        )
    except (InvalidSignature, ValueError):
        return False
    return True
