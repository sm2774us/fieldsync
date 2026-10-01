# SRS Compliance Report: FieldSync

| | |
|---|---|
| **Subject** | Backend, reference device, browser sync engine, operator console, image, CI and scripts |
| **Measured against** | `docs/SRS.md` v1.0 (83 requirements) |
| **Method** | Requirement-by-requirement review, automated results from the authoring environment, and direct exercise of the API, the nginx tier and the developer scripts |
| **Not verified** | Anything needing Docker, GitHub Actions, a real browser, a screen reader, Windows or WSL, production databases, or load (see §5) |

## 1. Executive summary

* **The core guarantees are verified by tests that try to break them:** ordered acknowledgement, idempotent retry (including a response lost *after* commit), sequence gaps, duplicate suppression, hash-mismatch quarantine with the good prefix preserved, blocked device until review, conflict-not-overwrite, crash-safe projections, immutability, and tamper detection of the audit chain (the test drops a trigger and edits a row, as a privileged attacker would).
* **Two real defects were found by the tests and fixed:** the reference device reused sequence numbers after compaction, and the browser engine looped when the server needed an event the device no longer held.
* **The console is verified where it matters most** (sign-in, role menus, integrity banner, the offline-to-acknowledged journey, engine, encrypted store, API mapping). Most other screens are implemented and type-checked but not individually tested, so they are rated 🟡.
* **Server-side encryption, TLS and true immutable storage are not built** (🟠). The reference uses SQLite, and a database owner can drop the triggers; the audit chain makes that *detectable*, not *impossible*.
* **Nothing was run on GitHub, in Docker, in a real browser, or on Windows/WSL.** Wireframes are drawings in Markdown, not Figma files.

### Tally
| Status | Count |
|---|---:|
| ✅ Met | 58 |
| 🟡 Met in code, unverified here | 18 |
| 🟠 Partially met | 7 |
| ❌ Not met | 0 |
| **Total** | **83** |

**Legend.** ✅ implemented and covered by a check that ran green here · 🟡 implemented; needs a browser, Docker, CI run or human review · 🟠 partially met, gap stated · ❌ not met.

### Evidence that ran green
| Check | Result |
|---|---|
| ruff check and format, mypy `--strict` | 0 issues (16 source files) |
| pytest | **60 passing**, coverage **96.1 %** against an 88 % gate |
| End-to-end scenario (`fieldsync-admin demo`) | offline authoring, lossy link, exactly 30 events in order, replayed key, conflict resolved, tamper quarantined, retry authorised, audit chain verified |
| ESLint (React-hooks rules, raw-HTML ban), `tsc --strict` | 0 errors |
| Triage evals (`evals/run.py --rules-only`) | 15/15 golden cases, including a prompt-injection case |
| TypeScript SDK (`npm test`, `tsc --strict`) | 9 passing, event hash identical to the Python vector |
| Kubernetes manifests parsed; Terraform parsed as HCL | syntax only; not applied or validated by the tools that matter |
| Vitest | **81 passing** in 7 files; coverage 90 % lines / 90 % functions / 80 % branches (gates 80/75/70) |
| Production build | JS 724 kB raw, **224.8 kB gzip** |
| `bash scripts/check.sh --native` on Ubuntu 24.04 (Python 3.12, Node 22) | passed end to end |
| Web build and tests from a directory containing only `web/` (Docker build context) | passed |
| `actionlint` on all workflows | clean |
| gitleaks 8.21.2 (CI version) on a repository built from the tree | no leaks (both vector copies allowlisted) |

## 2. Traceability to the request
| Requirement in the brief | Delivered | Status |
|---|---|---|
| Local append-only log with device ID, monotonic sequence, timestamp, operation ID, schema version; encrypted, durable | Browser and Python reference devices | ✅ |
| Resumable batches with idempotency keys; retries cannot duplicate | Engine + ingest + tests, including lost acknowledgements | ✅ |
| Validate auth, schema, authorisation, sequence; persist transactionally; acknowledge through a sequence; compact only after ack | Ingest service | ✅ (transaction atomicity 🟡) |
| Ingestion API with durable storage and outbox/queue; idempotent consumers | Outbox + projections | ✅ |
| Conflicts: append-only avoids them; version checks and a review queue for mutable records | Conflicts pages and API | ✅ |
| Operator sees local-only / uploading / acknowledged / failed | Field app | ✅ |
| Monitor heartbeat, queue depth, retry rate, sync lag, rejected schemas, storage; alert on prolonged offline | Fleet, metrics, scan | ✅ |
| Least privilege, encryption in transit and at rest, audit, immutable originals | RBAC, audit chain, triggers; TLS and server-side encryption documented only | ✅ / 🟠 |
| Follow-up 1: prevent an administrator altering evidence | Admin role cannot read data; separate roles; two-person enrolment; every attempt audited; tamper-evident chain; **true immutability needs WORM storage (not built)** | ✅ / 🟠 |
| Follow-up 2: hash mismatch | Quarantine, preserve, block, alert, review, audit | ✅ |
| Front end on the specified stack with CI/CD | React 19, TS, Tailwind, Radix/shadcn-style, TanStack, Zustand, Motion; `web` and `stack` jobs | ✅ built · 🟡 CI |
| Linux/WSL and Windows workflows; three docs | Scripts, WALKTHROUGH, README, docs | ✅ / 🟠 |

## 3. Requirement-level compliance

### 3.1 Device: local event log and offline operation (FR-DEV)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-DEV-01 | ✅ | `test_device_and_e2e` (local log append-only trigger); `engine.test` contiguous sequence numbers; `lib.test` envelope hash vector |
| FR-DEV-02 | ✅ | `test_local_log_is_encrypted…` (plaintext absent); `stores.test` AES-GCM round trip, fresh IV, tamper and wrong-device detection, no plaintext in stored rows. Key custody is browser/OS-level (see §5) |
| FR-DEV-03 | ✅ | `stores.test` reopen-after-restart keeps events and state; SQLite `synchronous=FULL` |
| FR-DEV-04 | ✅ | `app.test` field journey: airplane mode, save, "Local only", then "Acknowledged" |
| FR-DEV-05 | ✅ | `engine.test` and `stores.test` (browser store); `test_local_log…` (reference device) |
| FR-DEV-06 | ✅ | `engine.test` compaction only removes acknowledged events; `compact()` filters `state=acked` |
| FR-DEV-07 | ✅ | `engine.test` lost-acknowledgement recovery; `test_client_resumes_after_lost_acknowledgement` |
| FR-DEV-08 | ✅ | `lib.test` backoff bounds; scheduling loop in `FieldPage` is untested (🟡 for the loop) |
| FR-DEV-09 | 🟡 | Server side tested (`test_fleet_connectivity…`, `test_metrics…`); the browser heartbeat timer is implemented but not asserted |
| FR-DEV-10 | ✅ | `app.test` field journey asserts "Local only" then "Acknowledged"; failed state asserted in `engine.test` |
| FR-DEV-11 | ✅ | `engine.test` gap realignment (found and fixed an infinite loop here) |

### 3.2 Server: ingest, ordering, idempotency (FR-ING)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-ING-01 | ✅ | `test_device_identity_is_enforced` (other device, pending, revoked) |
| FR-ING-02 | ✅ | `test_schema_registry_rejects_bad_events` (7 cases), `test_v2_schema_accepted`, `test_update_validation` |
| FR-ING-03 | ✅ | `test_hash_mismatch_quarantines…`; cross-language hash vector on both sides |
| FR-ING-04 | ✅ | `test_gap_is_rejected…`, `test_non_contiguous_batch…` |
| FR-ING-05 | 🟡 | Single `BEGIN IMMEDIATE` transaction in `ingest`; no fault-injection test of a mid-transaction crash |
| FR-ING-06 | ✅ | `test_ordered_ack_and_projection`; response built after the transaction closes |
| FR-ING-07 | ✅ | `test_retry_with_same_key_is_idempotent`, `test_key_reuse_with_different_content_is_rejected`, metrics replay counter |
| FR-ING-08 | ✅ | `test_resending_acknowledged_events…` |
| FR-ING-09 | ✅ | `test_sequence_reuse_with_different_content_is_quarantined` |
| FR-ING-10 | ✅ | `test_immutability_of_events_and_audit` (database triggers). Production adds REVOKE and object-lock (see §5) |
| FR-ING-11 | ✅ | Pydantic limit (500 events); `max_payload_bytes` check in `ingest`; `engine.test` 500-event backlog |

### 3.3 Quarantine (FR-QNT)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-QNT-01 | ✅ | `test_hash_mismatch_quarantines…` (payload preserved as received); `test_immutability…` (quarantined original immutable) |
| FR-QNT-02 | ✅ | `test_hash_mismatch_quarantines…` (prefix acked, later batch gets 409 blocked) |
| FR-QNT-03 | ✅ | `test_hash_mismatch…`, `test_skip_authorized…` |
| FR-QNT-04 | ✅ | `test_skip_authorized_advances_cursor_only…` (second decision → 409) |

### 3.4 Conflicts and projections (FR-CNF, FR-OUT)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-CNF-01 | ✅ | `validate_event` requires `base_version` for updates (`test_update_validation`) |
| FR-CNF-02 | ✅ | `test_conflicts_are_never_silent_overwrites`, `test_other_conflict_kinds…` |
| FR-CNF-03 | ✅ | `test_conflicts_are_never_silent_overwrites` (v3, 3 versions), keep-current path |
| FR-CNF-04 | ✅ | `test_other_conflict_kinds…` (422) |
| FR-OUT-01 | ✅ | `test_outbox_projection_is_idempotent…` |
| FR-OUT-02 | ✅ | `test_outbox_projection_is_idempotent_and_crash_safe` (status reset, re-drain, no duplicate note) |
| FR-OUT-03 | 🟡 | `build_service` calls `drain_outbox`; no restart test |
| FR-OUT-04 | 🟡 | Implemented (attempts ≥ 5 → `dead`); no test |

### 3.5 Visibility, monitoring and audit (FR-OBS)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-OBS-01 | ✅ | `test_fleet_connectivity_lifecycle_and_scan`; Fleet screen implemented, table not asserted |
| FR-OBS-02 | ✅ | `test_metrics_expose_the_signals_operators_need` |
| FR-OBS-03 | ✅ | `test_fleet_connectivity_lifecycle_and_scan` (3 alerts, second scan none) |
| FR-OBS-04 | ✅ | `test_tampering_with_the_audit_log_is_detected` (trigger dropped, row edited, verify fails, `/readyz` 503) |
| FR-OBS-05 | ✅ | `test_checkpoint_and_verify` |
| FR-OBS-06 | ✅ | `test_tampering…`; console banner in `app.test` |
| FR-OBS-07 | ✅ | `test_separation_of_duties_and_audited_denials`; audit calls inside each mutating transaction |

### 3.6 Security and separation of duties (FR-SEC)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-SEC-01 | ✅ | `test_separation_of_duties…`; `lib.test` permission mirror |
| FR-SEC-02 | ✅ | `test_two_person_activation` |
| FR-SEC-03 | 🟠 | The reference does not terminate TLS; the console sends HSTS-ready headers but the certificate/ingress is deployment work |
| FR-SEC-04 | 🟠 | Reference uses SQLite without encryption; production requires managed encrypted PostgreSQL/object storage (documented, not built) |
| FR-SEC-05 | 🟠 | Triggers block UPDATE/DELETE and tampering is detectable, but a database owner can drop triggers (the test does exactly that). Real immutability needs WORM storage and REVOKE, as documented |

### 3.7 Console (FR-UI)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-UI-01 | ✅ | `app.test` redirect and bad token; `store.test`; `api.test` 401 |
| FR-UI-02 | ✅ | `app.test` four roles |
| FR-UI-03 | ✅ | `app.test` field journey (switch, save, queue, auto-sync, acknowledged). Backoff loop and heartbeat timer: 🟡 by inspection |
| FR-UI-04 | 🟡 | Implemented; dashboard fleet list asserted in `app.test`, table itself not |
| FR-UI-05 | 🟡 | Implemented; no test |
| FR-UI-06 | 🟡 | Implemented; no test |
| FR-UI-07 | 🟡 | Implemented; `ConfirmButton` tested, page not |
| FR-UI-08 | 🟡 | Implemented; hash recompute uses the vector-tested `eventHash`; page not tested |
| FR-UI-09 | 🟡 | Implemented; no test |
| FR-UI-10 | 🟡 | Implemented (carried from the previous console); no test |
| FR-UI-11 | 🟡 | Implemented; request shapes tested (`api.test`) |
| FR-UI-12 | ✅ | `app.test` |
| FR-UI-13 | 🟡 | Banner, pill and `ErrorState` implemented; request ID mapping tested in `api.test` |

### 3.8 Optional advisory triage (FR-AI)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-AI-01 | ✅ | `test_rules_work_without_any_ai`; triage endpoints are read-only plus one audit row (`test_triage_endpoints_audit_and_permissions`) |
| FR-AI-02 | ✅ | `test_ai_failure_degrades_to_rules` (500, refusal, bad JSON, network error); `test_ai_is_off_unless_enabled_and_keyed` |
| FR-AI-03 | ✅ | `test_llm_cannot_lower_severity_or_invent_actions`; `evals/run.py` safety invariants |
| FR-AI-04 | ✅ | `test_prompt_minimisation_blocks_payloads_and_free_text`; injection case in `evals/cases.jsonl` |
| FR-AI-05 | ✅ | `test_ai_enabled_service_enriches_and_audits_provenance`; `_advise` calls the model before opening the transaction |
| FR-AI-06 | 🟡 | `evals/run.py --rules-only` 15/15 and `test_evals_baseline_passes` ran green; `ai-evals.yml` is `actionlint`-clean but the LLM path was never run against a real model |
| FR-AI-07 | ✅ | `advisory.test.tsx` (4 tests) |
| FR-AI-08 | ✅ | `test_mcp_server_registers_read_only_tools` (exact tool set) |

### 3.9 SDK and deployment (FR-SDK, FR-DEP)

| ID | Status | Evidence or gap |
|---|:-:|---|
| FR-SDK-01 | ✅ | `sdk-ts/test/client.test.ts` (9 tests: vector, ordering, 5xx retry, lost-ack, corruption, gap, compaction, encrypted file log) |
| FR-SDK-02 | ✅ | SDK tests "never invents history" and "never reused" |
| FR-DEP-01 | 🟡 | Manifests parse and were reviewed (`yaml` load, 8 objects); never applied to a cluster; nginx web container cannot use a read-only root filesystem |
| FR-DEP-02 | 🟠 | Parsed as HCL only; `terraform validate`/`plan` not run; the service does not yet export events or upload checkpoints to these buckets |
| FR-DEP-03 | ✅ | `test_cli_scan_and_checkpoint` |

### 3.10 Non-functional requirements (NFR)

| ID | Status | Evidence or gap |
|---|:-:|---|
| NFR-SEC-01 | 🟡 | Same template and include file verified with real nginx 1.24 in the previous project and re-verified below for this one; lint rule enforced; image build not run |
| NFR-REL-01 | ✅ | `api.test` timeout, retryable flags; `sendBatch` maps every outcome to a value |
| NFR-REL-02 | 🟡 | `ErrorBoundary`; `/readyz` 503 mapping tested |
| NFR-CAP-01 | 🟠 | Limits enforced and a 500-event backlog tested; throughput/latency never measured; SQLite is single-writer (reference only) |
| NFR-A11Y-01 | 🟠 | Radix primitives, landmarks, labelled controls, `role="status"`/`log`, reduced motion, text contrast by computation; no axe or screen-reader audit |
| NFR-PERF-01 | ✅ | Measured 224.8 kB gzip |
| NFR-DEV-01 | 🟡 | Workflows written and `actionlint`-clean; not run on GitHub |
| NFR-DEV-02 | ✅ | Python 88 % gate (measured 96.1 %); web gate 80/75/80/70 (measured 90 % lines, 90 % functions) |
| NFR-DEV-03 | ✅ | `test_cross_language_event_hash_vector`, `lib.test`, `test_web_copy_of_the_vector_is_identical`; gitleaks allowlist for both copies verified |
| NFR-DEV-04 | ✅ | Reproduced by building and testing from a copy containing only `web/` |
| NFR-DEV-05 | 🟠 | Ubuntu native executed (`check.sh --native`, `dev.sh`); WSL and Windows scripts not executed; no Dependabot config exists |

## 4. Deviations from a "complete" production system
1. **SQLite reference persistence.** Single writer; adequate for the reference and tests, not for 10,000 devices. Production: PostgreSQL with `REVOKE` and encryption, same schema and rules.
2. **Immutability is enforced by triggers**, defeatable by whoever owns the database. The chain detects it. Real prevention needs WORM/object-lock storage and a role that cannot alter triggers.
3. **Device authentication is a bearer token** whose subject is the device ID, not hardware-attested keys or mTLS. Events are integrity-hashed, not individually signed.
4. **Browser key custody** is a non-extractable WebCrypto key in IndexedDB: it protects data at rest from casual inspection, not from malware running as the user or a compromised device.
5. **The console cannot list arbitrary history**; audit paging is oldest to newest with "load all".
6. **Compaction can under-report record versions**: the browser Field app derives base versions from retained events, so aggressive compaction can cause reviewable (never silent) conflicts. Default keeps the newest 200 acknowledged events.
7. **Wireframes are Markdown drawings**, not Figma artboards, and were not compared to a rendered build.
8. **AI is optional and advisory only.** Off by default; never gates data; the LLM path has not been run against a real model by the author.

## 5. Items not executed in this environment
* `docker build` of either image, `docker compose up`, and the `stack` job's probes.
* Any GitHub Actions run (`ci.yml`, `security.yml`, `release.yml`, `ai-evals.yml`); `actionlint` validated syntax only.
* The LLM-enriched triage path against a real model (only a mocked transport was exercised).
* `kubectl apply`, `kubeconform`, `terraform validate/plan` and any cloud account.
* A real browser: rendering, layout at 360 px, focus order, motion, IndexedDB durability across real restarts, storage quota behaviour.
* Accessibility (axe, screen reader, keyboard-only walkthrough).
* Windows 11 and WSL execution; `setup-linux.sh --install`; `check.sh --docker`.
* Python 3.13 (CI matrix).
* Load, soak, and fault-injection (process kill mid-transaction).

## 6. Residual risks and next steps
| # | Risk | Action |
|---|---|---|
| 1 | Page components other than the field journey lack tests | Playwright journeys: sign-in, offline authoring, conflict review, quarantine review |
| 2 | Transaction atomicity and outbox recovery untested under crash | Kill-9 test harness around `ingest` and `drain_outbox` |
| 3 | Accessibility claims are design intent | axe in CI; NVDA/VoiceOver pass |
| 4 | Docker/compose path unproven | First PR run; fix what CI reveals before merging |
| 5 | Throughput unknown | Load test on PostgreSQL; set batch and payload limits from data |
| 6 | Token paste and client-held secrets | OIDC with short-lived, sender-constrained tokens; device attestation |
| 7 | Immutability is tamper-evident, not tamper-proof | WORM storage, object lock, separate database roles |
| 8 | `/metrics` proxied to browsers | Restrict to internal network or authenticate; add an authenticated summary endpoint |
