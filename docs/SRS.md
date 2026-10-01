# Software Requirements Specification: FieldSync (offline-first device sync)

| | |
|---|---|
| **Product** | FieldSync: an append-only, offline-first synchronisation service, reference device client, and operator console |
| **Version** | 1.0 |
| **Status** | Baseline for review |
| **Companions** | `Solution-Deep-Dive.md` (design, protocol, wireframes), `SRS-Compliance.md` (evidence per requirement) |

Keywords **MUST**, **SHOULD**, **MAY** follow RFC 2119. Priority **M**/**S**/**C** = must/should/could. Sources: **BR** business rule, **SEC** security, **UX** usability, **OPS** operations, **REL** reliability, **PERF** performance, **DEV** delivery.

---

## 1. Introduction

### 1.1 Purpose and scope
Define what FieldSync must do so that people working in poor connectivity can keep recording, while supervisors keep a **durable, ordered, idempotent, visible and auditable** record of what was created, synchronised and changed.

In scope: the device event log and sync client (browser reference and Python reference), the ingest API, quarantine and conflict review, outbox and projections, fleet monitoring, audit log, the operator console, packaging and CI/CD, and the Windows/Ubuntu/WSL developer workflows.
Out of scope: native mobile clients, identity-provider integration, production database/object-store deployment, and any dependency on AI: an optional advisory exists but the design never needs it.

### 1.2 Definitions
| Term | Meaning |
|---|---|
| Event | An immutable, numbered fact recorded on a device (`report.create`, `report.update`, `note.add`) |
| Sequence number | Per-device counter, starting at 1, never reused |
| Cursor | The highest sequence number the server has committed for a device |
| Acknowledgement | The server's statement "committed through sequence N" |
| Idempotency key | Client-chosen key that makes retrying a batch safe |
| Quarantine | Holding area for events that failed hash or schema checks; blocks the device |
| Outbox | Durable queue of committed events awaiting projection |
| Projection | Derived current state (records, versions, notes) built from events |
| Conflict | A divergent edit that was not applied and awaits a reviewer |

### 1.3 References
`Solution-Deep-Dive.md`; RFC 2119; FIPS 180-4; RFC 8032; WCAG 2.2; OWASP ASVS 4.0.

---

## 2. Overall description

### 2.1 Architecture in one line
`Device (encrypted append-only log) -> resumable idempotent batches -> ingest API (validate, order, commit, ack) -> events + outbox + audit (one transaction) -> idempotent projections -> operator console`.

### 2.2 User classes
| Class | Role | Goal |
|---|---|---|
| Field operator | `device` (token subject = device ID) | Keep working offline; know what has synchronised |
| Supervisor | `supervisor` | See fleet health, alerts, records |
| Reviewer | `reviewer` | Decide conflicts and quarantined events |
| Auditor | `auditor` | Verify history and integrity |
| Administrator | `admin` | Enrol devices, sign checkpoints; cannot read data |

### 2.3 Operating environment
Evergreen browsers with IndexedDB and WebCrypto (SHA-256, AES-GCM); Python 3.12+; Node 22+ (SDK, console); Linux containers (non-root); development on Windows 11 (Docker), Ubuntu 24.04 or WSL2.

### 2.4 Constraints
C1 Events are immutable. C2 Delivery is at-least-once; correctness comes from idempotency, not from hoping for exactly-once transport. C3 Ordering is per device. C4 No third-party runtime origins in the console.

### 2.5 Clarifying assumptions (the questions to ask first)
These are **design targets, not measured results**.
| Question | Assumption used |
|---|---|
| Device volume | up to 10,000 active devices per deployment |
| Event size | typically under 4 KB; hard limit 64 KB payload, 500 events per batch |
| Retention | events kept for the agency's record-retention period (years); device keeps acknowledged events only until compaction |
| Acceptable sync delay | seconds after connectivity returns; "delayed" after two missed heartbeats (about 60 s), "offline" and an alert after 60 min (configurable) |
| Conflict requirements | append-only facts never conflict; edits to mutable records are versioned and reviewed, never silently overwritten |

---

## 3. Specific requirements

### 3.1 Device: local event log and offline operation (FR-DEV)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-DEV-01 | Each device MUST keep an append-only local event log. Every event carries device ID, a monotonically increasing sequence number, timestamp, operation ID and schema version. | M | BR |
| FR-DEV-02 | The local store MUST be encrypted at rest. | M | SEC |
| FR-DEV-03 | An entry MUST be durable before the operator is told it was saved. | M | BR |
| FR-DEV-04 | The operator MUST be able to create and edit entries with no connectivity. | M | UX |
| FR-DEV-05 | Sequence numbers MUST never be reused, including after compaction. | M | BR |
| FR-DEV-06 | Local events MUST be deleted or compacted only after the server acknowledges them. | M | BR |
| FR-DEV-07 | Upload MUST be resumable: before sending, the device MUST read the server cursor and skip what is already acknowledged. | M | BR |
| FR-DEV-08 | Retries MUST use exponential backoff with jitter and a cap. | S | OPS |
| FR-DEV-09 | Devices MUST send a heartbeat with queue depth, oldest unsynchronised age, storage free/total, app version and retry count. | M | OPS |
| FR-DEV-10 | Each entry MUST show one of: local only, uploading, acknowledged, failed. | M | UX |
| FR-DEV-11 | A device MUST never fabricate history: if the server needs an event the device no longer holds, sync MUST stop and surface it. | S | BR |

### 3.2 Server: ingest, ordering, idempotency (FR-ING)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-ING-01 | The server MUST authenticate the caller, authorise it, and allow a device to write only its own log while active in its agency. | M | SEC |
| FR-ING-02 | The server MUST validate each event against a schema registry (type, version, fields, lengths) and reject unknown versions. | M | BR |
| FR-ING-03 | The server MUST recompute each event hash and reject mismatches. | M | SEC |
| FR-ING-04 | The server MUST enforce sequence continuity: the cursor advances only to the next expected number; gaps get HTTP 409 with the expected number. | M | BR |
| FR-ING-05 | Events, outbox rows, cursor and audit entry MUST commit in one transaction. | M | BR |
| FR-ING-06 | The acknowledgement MUST name a sequence number and MUST be sent only after commit. | M | BR |
| FR-ING-07 | Batches MUST carry an idempotency key. A repeat with identical content MUST return the stored result; reuse with different content MUST be rejected. | M | BR |
| FR-ING-08 | Re-sent events at or below the cursor MUST be suppressed and counted, never duplicated. | M | BR |
| FR-ING-09 | A sequence number already acknowledged but re-sent with different content MUST be quarantined as a critical anomaly. | M | SEC |
| FR-ING-10 | Stored events MUST be immutable (no UPDATE/DELETE). | M | SEC |
| FR-ING-11 | Batch size and payload size MUST be bounded. | S | OPS |

### 3.3 Quarantine (FR-QNT)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-QNT-01 | A failing event MUST be preserved exactly as received, MUST NOT be applied or shown as verified, and MUST raise an alert. | M | BR |
| FR-QNT-02 | A quarantined device MUST NOT advance its cursor until a reviewer decides. Events before the bad one MUST stay committed. | M | BR |
| FR-QNT-03 | A reviewer MUST choose retry-authorised or skip-authorised with a note; the decision MUST be audited and close the alert. | M | BR |
| FR-QNT-04 | Skip MUST apply only to the next unacknowledged sequence and only once per item. | M | BR |

### 3.4 Conflicts and projections (FR-CNF, FR-OUT)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-CNF-01 | Append-only events (notes, creates) MUST need no conflict handling; edits of mutable records MUST carry a base version. | M | BR |
| FR-CNF-02 | An edit whose base version is stale MUST NOT overwrite; it MUST open a conflict for review. Duplicate creates and orphan notes likewise. | M | BR |
| FR-CNF-03 | Resolving MUST create a new version with history retained, or dismiss; it MUST require a note and be audited. | M | BR |
| FR-CNF-04 | Only stale-base conflicts MAY apply the proposed change. | S | BR |
| FR-OUT-01 | Each accepted event MUST create an outbox row in the same transaction. | M | BR |
| FR-OUT-02 | Consumers MUST be idempotent and crash-safe. | M | BR |
| FR-OUT-03 | Pending outbox rows MUST be drained at start-up. | S | OPS |
| FR-OUT-04 | A projection failing repeatedly MUST become a dead letter rather than block the queue. | S | OPS |

### 3.5 Visibility, monitoring and audit (FR-OBS)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-OBS-01 | Operators MUST see per-device connectivity (online, delayed, offline, never), backlog, sync lag, storage, last seen and sync state. | M | BR |
| FR-OBS-02 | The service MUST expose heartbeat/queue depth, retry (replay) counts, sync lag, rejected schemas/quarantines and storage capacity as metrics. | M | OPS |
| FR-OBS-03 | A fleet scan MUST alert on prolonged offline, high backlog and low storage, without duplicating open alerts. | M | OPS |
| FR-OBS-04 | The audit log MUST be hash-chained; verification MUST detect tampering. | M | SEC |
| FR-OBS-05 | Auditors MUST be able to verify the chain; administrators MUST be able to sign a checkpoint, and verification MUST check it. | S | SEC |
| FR-OBS-06 | `/readyz` MUST report an audit-integrity failure as not ready. | M | OPS |
| FR-OBS-07 | Every state change and every denied attempt MUST be audited. | M | SEC |

### 3.6 Security and separation of duties (FR-SEC)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-SEC-01 | Roles MUST be least-privilege: administrators cannot read events or records; auditors cannot change state; reviewers cannot see the fleet; devices cannot read others. | M | SEC |
| FR-SEC-02 | Device registration and activation MUST need two different administrators. | M | SEC |
| FR-SEC-03 | Transport MUST be encrypted (TLS at the ingress). | M | SEC |
| FR-SEC-04 | Server storage MUST be encrypted at rest. | M | SEC |
| FR-SEC-05 | Originals MUST be protected against alteration even by privileged staff (immutable storage / retention lock). | M | SEC |

### 3.7 Console (FR-UI)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-UI-01 | The console MUST require sign-in, reject malformed or expired tokens locally, hold the token only in `sessionStorage`, and sign out on 401 or expiry. | M | SEC |
| FR-UI-02 | Navigation MUST show only what the role may use. | M | SEC |
| FR-UI-03 | The Field app MUST work offline, show queue state per entry, offer a simulate-offline switch, sync automatically with backoff, and report heartbeat. | M | UX |
| FR-UI-04 | Fleet: sortable, filterable table of devices with link, sync state, backlog, lag, storage and last seen; drill-down to a device. | M | UX |
| FR-UI-05 | Device detail: overview and immutable event log. | S | UX |
| FR-UI-06 | Records: list, detail with version history, notes and open-conflict notice. | S | UX |
| FR-UI-07 | Conflicts: side-by-side current vs proposed; decision with a required note and a two-click confirm. | M | BR |
| FR-UI-08 | Quarantine: show the event as received, recompute its hash in the browser for hash mismatches, decide with a note and two-click confirm. | M | BR |
| FR-UI-09 | Alerts: open/acknowledged tabs, detail, links to the object, two-click acknowledge, fleet scan. | M | OPS |
| FR-UI-10 | Audit log: paging, filter, entry detail with hashes; verify chain. | M | SEC |
| FR-UI-11 | Enrolment: register, activate, revoke with validation and two-click confirm. | M | SEC |
| FR-UI-12 | An audit-integrity failure MUST be shown prominently on every screen. | M | SEC |
| FR-UI-13 | Offline or unreachable service MUST be indicated; errors MUST show the request ID. | M | UX |

### 3.8 Optional advisory triage (FR-AI)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-AI-01 | Quarantine, blocking, conflicts and alerts MUST be decided by deterministic rules; the advisory MUST NOT gate or change any data. | M | SEC |
| FR-AI-02 | With AI disabled, unkeyed, failing, or returning invalid output, triage MUST still return a complete rule-based advisory. | M | REL |
| FR-AI-03 | A model MUST NOT lower a rule-derived severity, change the category, or add actions outside the allow-list. | M | SEC |
| FR-AI-04 | Only allow-listed, pseudonymous metadata MUST reach the model; never event payloads, record content or free text. Context MUST travel as untrusted data. | M | SEC |
| FR-AI-05 | Every AI use MUST be auditable (model id, prompt hash) and MUST NOT run inside a database transaction. | M | SEC |
| FR-AI-06 | A golden-set eval MUST gate the rules baseline in CI; the LLM path SHOULD be scored on a schedule without blocking deploys. | S | DEV |
| FR-AI-07 | The console MUST label advice as advice, show whether it came from rules or rules plus a named model, and be hidden for roles without `triage:run`. | S | UX |
| FR-AI-08 | A read-only MCP server MAY expose fleet, alerts, quarantine, advisory and audit verification to an agent, with no write tools. | C | OPS |

### 3.9 SDK and deployment (FR-SDK, FR-DEP)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| FR-SDK-01 | A Node/TypeScript SDK MUST provide an encrypted append-only device log, resumable idempotent sync and the same event hash as the service. | S | DEV |
| FR-SDK-02 | The SDK MUST never fabricate history and MUST NOT reuse sequence numbers after compaction. | S | BR |
| FR-DEP-01 | Reference Kubernetes manifests MUST run non-root with no privilege escalation, a NetworkPolicy and a scheduled scan/checkpoint/verify job that can actually reach the data volume. | S | OPS |
| FR-DEP-02 | Reference Terraform MUST provide Object-Lock (COMPLIANCE) archive and anchor buckets with KMS, public-access block and TLS-only policy. | S | SEC |
| FR-DEP-03 | Operational CLI MUST provide `scan`, `checkpoint` and `verify-audit` for scheduled jobs. | S | OPS |

### 3.10 Non-functional requirements (NFR)

| ID | Requirement | Pri | Source |
|---|---|:-:|:-:|
| NFR-SEC-01 | The SPA MUST call only its own origin; nginx MUST send CSP and five other security headers on every route class; source MUST NOT use raw-HTML injection (lint-enforced). | M | SEC |
| NFR-REL-01 | Every request MUST have a timeout; only network failures and 5xx MAY be retried, never 4xx. | M | REL |
| NFR-REL-02 | A render crash MUST show a recovery screen; the audit chain failure MUST NOT be reported as a generic outage. | M | REL |
| NFR-CAP-01 | The system SHOULD sustain the assumed load (§2.5) with bounded batches. | S | OPS |
| NFR-A11Y-01 | The UI SHOULD conform to WCAG 2.2 AA. | S | UX |
| NFR-PERF-01 | The initial JavaScript payload SHOULD stay below 250 kB gzip. | S | PERF |
| NFR-DEV-01 | Lint, strict typing, tests and build MUST gate merges via `ci-ok`; a full-stack job MUST start API and console. | M | DEV |
| NFR-DEV-02 | Coverage floors MUST be enforced. | M | DEV |
| NFR-DEV-03 | Client and server MUST agree on hashing byte-for-byte, tested against a shared vector, with the web copy guarded against drift. | M | DEV |
| NFR-DEV-04 | The web image build context MUST be self-contained. | M | DEV |
| NFR-DEV-05 | Windows 11 and Ubuntu/WSL workflows MUST both be documented and scripted; no bot may open PRs. | M | DEV |

---

## 4. External interfaces

### 4.1 API (JSON; errors `{ "error", "message", ... }`)
| Method and path | Purpose | Permission |
|---|---|---|
| `POST /v1/sync/batches` (`Idempotency-Key`) | Upload a contiguous batch. 200 ack, 409 `sequence_gap` or blocked, 422 `integrity_failure`/`schema_rejected` | `sync:write` (own device) |
| `GET /v1/devices/{id}/cursor` | Resume point and sync state | `sync:cursor` (own) or `fleet:read` |
| `POST /v1/devices/{id}/heartbeat` | Queue depth, lag, storage, version, retries | `sync:heartbeat` (own) |
| `GET /v1/fleet`, `GET /v1/devices/{id}` | Fleet and device status | `fleet:read` |
| `GET /v1/devices/{id}/events` | Immutable event log (audited read) | `events:read` |
| `POST /v1/fleet/scan` | Raise offline/backlog/storage alerts | `fleet:scan` |
| `POST /v1/devices`, `.../activate`, `.../revoke` | Enrolment (two people) | `device:register/activate/revoke` |
| `GET /v1/records`, `GET /v1/records/{id}` | Projected state, versions, notes | `records:read` |
| `GET /v1/conflicts`, `POST /v1/conflicts/{id}/resolve` | Conflict review | `conflicts:read` / `conflicts:review` |
| `GET /v1/quarantine`, `POST /v1/quarantine/{id}/disposition` | Quarantine review | `quarantine:read` / `quarantine:review` |
| `GET /v1/alerts`, `POST /v1/alerts/{id}/ack` | Alerts | `alerts:read` / `alerts:ack` |
| `POST /v1/quarantine/{id}/triage`, `/v1/conflicts/{id}/triage`, `/v1/alerts/{id}/triage` | Advisory (read-only, audited) | `triage:run` |
| `GET /v1/audit`, `POST /v1/audit/verify`, `POST /v1/audit/checkpoint` | Audit | `audit:read` / `audit:verify` / `audit:checkpoint` |
| `GET /healthz`, `/readyz`, `/metrics`, `/v1/keys` | Operations | none |

### 4.2 Event envelope (hashed with SHA-256 over canonical JSON plus `device_id`)
`seq, op_id, type, schema_version, record_id, ts_ms, base_version, payload, content_hash`

### 4.3 Metrics
`sync_events_accepted_total`, `sync_batches_total{result}`, `sync_duplicates_total`, `sync_quarantined_total{reason}`, `sync_conflicts_total{kind}`, `sync_outbox_pending`, `sync_open_conflicts`, `sync_open_quarantine`, `sync_open_alerts`, `sync_blocked_devices`, `sync_devices_offline`, `sync_max_queue_depth`, `sync_max_sync_lag_seconds`, `sync_min_storage_free_ratio`, `sync_heartbeats_total`, `sync_authz_denied_total{role}`.

---

## 5. Data requirements
| Data | Where | Notes |
|---|---|---|
| Device event log | Browser IndexedDB (AES-GCM, non-extractable key) / SQLite (AES-256-GCM) | append-only; compacted only after acknowledgement |
| Events, batches, outbox, records, versions, notes, conflicts, quarantine, alerts, audit | Server SQLite (reference) | triggers block UPDATE/DELETE on events, versions, notes, skips, audit; quarantine originals immutable |
| Token, identity | Console `sessionStorage` | tab lifetime |
| Preferences | Console `localStorage` | theme, recent items |

Production mapping: PostgreSQL with `REVOKE UPDATE, DELETE` and encryption at rest; audit checkpoints exported to object storage with retention lock. **Not built here** (FR-SEC-04, FR-SEC-05 are 🟠).

---

## 6. Verification approach
**T** automated test (pytest, Vitest, Testing Library, fake IndexedDB) · **A** static analysis (ruff, mypy strict, ESLint, `tsc --strict`) · **D** demonstration against a running API (`fieldsync-admin demo`, nginx proxy) · **CI** executed by GitHub Actions · **M** manual/external (accessibility, cross-browser, load).

## Appendix A: Permission matrix (mirrors `src/fieldsync/auth.py`)
| Permission | device | supervisor | reviewer | auditor | admin |
|---|:-:|:-:|:-:|:-:|:-:|
| sync:write, sync:cursor, sync:heartbeat | X | | | | |
| fleet:read | | X | | X | |
| fleet:scan | | X | | | |
| events:read | | X | X | X | |
| records:read | | X | X | | |
| alerts:read, alerts:ack | | X | | X | |
| triage:run | | X | X | X | |
| conflicts:read | | X | X | X | |
| conflicts:review | | | X | | |
| quarantine:read | | X | X | X | |
| quarantine:review | | | X | | |
| audit:read, audit:verify | | | | X | |
| device:register, activate, revoke, audit:checkpoint | | | | | X |
