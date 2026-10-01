# Threat model (STRIDE-oriented)

| Threat | Control | Detection |
|---|---|---|
| Spoofed device (stolen or cloned token) | Token subject must equal an active registered device; two-person activation; revocation | `authz.denied` audit entries, 401/403 metrics |
| Event altered in transit or on disk | SHA-256 content hash recomputed server-side; quarantine preserves bytes | `EVENT_QUARANTINED`, `sync_quarantined_total{reason}` |
| Replay or substitution of a sequence number | Contiguous sequence; acknowledged number with different content is quarantined | `sequence_reuse_mismatch` critical |
| Duplicate delivery | Idempotency key + stored result; duplicates counted, never stored | `sync_duplicates_total`, replay counter |
| Insider admin edits data | Admin role has no read or write path to events or records; no mutating endpoint for events; triggers block UPDATE/DELETE | Denials audited; chain verification |
| DBA rewrites the audit log or drops triggers | Hash chain with signed checkpoints exported off-box | `/readyz` 503, `verify-audit`, scheduled job |
| Silent divergence of two devices' edits | `base_version` checks; conflict queue; no silent overwrite | `CONFLICT_OPEN`, `sync_open_conflicts` |
| Stale or blocked device hiding a fault | Heartbeat, fleet connectivity, scan alerts | `DEVICE_OFFLINE`, `BACKLOG_HIGH`, `STORAGE_LOW` |
| Stolen or expired credential | Short TTL, revocation list (`jti`), device revocation | 401s, metrics |
| Device clock manipulation | Ordering by sequence, both device and server times stored | Compare `ts_ms` and `received_ms` |
| Prompt injection through event metadata | Allow-list minimisation; JSON envelope; schema-validated output; severity floor and action allow-list; no model call inside a transaction | `evals/cases.jsonl` injection case |
| Data exposure through the advisory | Model sees only allow-listed pseudonymous fields, never payloads or record content | Prompt-minimisation test |
| Repudiation | Actor, role, IP and request ID on every audit row; signed checkpoints | Audit log |
| Denial of service (huge batches, floods) | Batch and payload limits; bounded queries | Metrics; gateway rate limiting expected |
| Local data theft from a lost device | Encrypted-at-rest log (AES-256-GCM) | Not protected against malware running as the user; use full-disk encryption and remote revoke |
