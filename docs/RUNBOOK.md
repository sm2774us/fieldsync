# Runbook

**Hash mismatch or quarantined event.** Alert `EVENT_QUARANTINED`; the device is blocked. Delete nothing. Open **Quarantine**, read the reason, compare the claimed and recomputed hashes, optionally request the advisory (`POST /v1/quarantine/{id}/triage`). Transport fault on a first occurrence: authorise a retry with a reason; the device resends the original with the same sequence number. Repeat offender or `sequence_reuse_mismatch`: retain, inspect the device, consider `POST /v1/devices/{id}/revoke`. Skip only when the event is unrecoverable; the bytes stay preserved.

**`/readyz` = 503 (audit chain broken).** Treat as a security incident. Freeze administrative changes, run `fieldsync-admin verify-audit` to find the first bad entry, compare with the last exported checkpoint, restore from replica, and preserve the tampered database.

**Device offline (`DEVICE_OFFLINE`).** Usually normal (dead zone, powered off). Check the backlog in Fleet; events are safe on the device. Contact the operator after the configured window (`SYNC_OFFLINE_AFTER_S`). Advisory available on the alert.

**Backlog high or storage low.** `BACKLOG_HIGH`: the device is not draining (link quality or a blocked queue). `STORAGE_LOW`: the device may stop recording; free space or replace it urgently.

**Conflict open.** Open **Conflicts**, compare current and proposed, decide with a reason. Applying creates a new version; nothing is lost.

**Blocked device that a reviewer has already cleared.** The device resumes on its next sync pass; if a client shows `failed`, run **retry** in the app.

**Schema rejections after an app rollout.** `schema_rejected` quarantines mean devices run a schema this server does not accept. Update the server or the app; then authorise retries.

**Key rotation.** Deploy a new `SYNC_SIGNING_KEY`; `key_id` on checkpoints identifies which key signed what. Keep old public keys (`GET /v1/keys`) to verify old checkpoints. Rotate `SYNC_TOKEN_SECRET` to invalidate all dev tokens.

**Scheduled operations.** `fieldsync-admin scan && fieldsync-admin checkpoint && fieldsync-admin verify-audit` every 6 hours (see the CronJob). `checkpoint` prints signed JSON: upload it to the anchors bucket (manual step; not automated here).

**Restore and disaster recovery drill (infrastructure).** Restore the database from the replica, run `verify-audit`, compare the head hash with the newest exported checkpoint, then re-enable devices. Regional failover and RPO/RTO depend on your replication; nothing here has been drilled.

**AI enrichment.** Off unless `SYNC_AI_ENABLED=1` and `SYNC_ANTHROPIC_API_KEY` are set. If it misbehaves, unset either; behaviour falls back to rules with no other change. The `AI evals` workflow shows drift against the golden set.
