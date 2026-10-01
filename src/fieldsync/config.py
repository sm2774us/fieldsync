"""Runtime configuration, sourced from environment variables (12-factor)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field, replace
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("./data")
    signing_key_hex: str = ""  # Ed25519 seed for audit checkpoints (prod: KMS/HSM)
    token_secret: str = ""  # HMAC secret for dev bearer tokens (prod: OIDC/mTLS at the edge)
    max_batch_events: int = 500
    max_payload_bytes: int = 64 * 1024
    heartbeat_interval_s: int = 30
    offline_after_s: int = (
        3600  # silent this long: "offline" (alert); between 2 heartbeats and this: "delayed"
    )
    backlog_alert: int = 1000  # device-reported queue depth that raises an alert
    low_storage_ratio: float = 0.10
    ai_enabled: bool = False  # optional advisory enrichment; the workflow never depends on it
    ai_model: str = "claude-sonnet-5-5"
    ai_base_url: str = "https://api.anthropic.com"
    ai_api_key: str = field(default="", repr=False)
    ai_timeout_s: float = 8.0

    @classmethod
    def from_env(cls) -> Settings:
        e = os.environ
        key = e.get("SYNC_ANTHROPIC_API_KEY", "")
        return cls(
            data_dir=Path(e.get("SYNC_DATA_DIR", "./data")),
            signing_key_hex=e.get("SYNC_SIGNING_KEY", ""),
            token_secret=e.get("SYNC_TOKEN_SECRET", ""),
            max_batch_events=int(e.get("SYNC_MAX_BATCH_EVENTS", 500)),
            offline_after_s=int(e.get("SYNC_OFFLINE_AFTER_S", 3600)),
            backlog_alert=int(e.get("SYNC_BACKLOG_ALERT", 1000)),
            ai_enabled=e.get("SYNC_AI_ENABLED", "0") == "1" and bool(key),
            ai_model=e.get("SYNC_AI_MODEL", "claude-sonnet-5-5"),
            ai_api_key=key,
        )

    def with_dev_secrets(self) -> Settings:
        """Fill missing secrets with ephemeral values. Development/tests only."""
        return replace(
            self,
            signing_key_hex=self.signing_key_hex or secrets.token_hex(32),
            token_secret=self.token_secret or secrets.token_hex(32),
        )
