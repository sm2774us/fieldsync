# FieldSync

An **offline-first device sync system**: devices keep recording with no connection, and the server ends up with exactly what they recorded, **durably, in order, without duplicates, with nothing silently overwritten**, while operators can see every entry's state and every device's health. Reference implementation of the "Design an Offline-First Device Sync System" problem, built the way you would defend it in review.

```
Device: encrypted append-only log ──▶ resumable, idempotent batches ──▶ Ingest API
  seq · op id · time · schema           cursor first · idempotency key      auth · schema · hash · continuity
                                                                             │ one transaction
                                                                             ▼
                              acknowledged "through N" ◀── events (immutable) + outbox + cursor + audit
                                                                             │
                                          quarantine (kept as received) ◀───┤───▶ idempotent projections ──▶ records
                                          conflict review queue ◀───────────┘                                (versions)
```

| Requirement | Where | Proof |
|---|---|---|
| Append-only encrypted local log; device ID, monotonic sequence, timestamp, op ID, schema version | `web/src/lib/sync`, `src/fieldsync/device.py`, `sdk-ts` | engine, store and device tests |
| Resumable, idempotent batches; lost acknowledgements are harmless | `SyncEngine`, `service.ingest` | lost-ack, replay and duplicate tests |
| Server validates auth, schema, authorisation, sequence; commits transactionally; acks through N | `src/fieldsync/service.py` | 60 pytest |
| Device compacts only after ack; sequence numbers never reused | `LocalLog.compact`, `SyncEngine.compact` | compaction tests (found a real bug) |
| Outbox with idempotent consumers | `outbox` table, `drain_outbox` | crash-safe projection test |
| Conflicts: version checks + review queue, never silent overwrite | conflicts API and screens | conflict tests |
| Operator sees local only / uploading / acknowledged / failed | Field app | offline-to-acknowledged journey test |
| Monitoring: heartbeat, queue depth, retries, lag, rejected schemas, storage; offline alerts | Fleet, `/metrics`, fleet scan | fleet and metrics tests |
| Least privilege, encryption, audit, immutable originals | roles, AES-GCM, hash-chained audit, triggers | separation-of-duties, immutability, tamper tests |
| Hash mismatch: quarantine, preserve, alert, retry when appropriate, record it | quarantine flow | mismatch and skip tests |
| Advisory triage: rules decide, optional AI enriches, never gates data | `src/fieldsync/triage.py`, `evals/` | 15 golden cases plus the triage test module |
| Device SDK, deployment references | `sdk-ts/`, `deploy/` | 9 SDK tests; manifests parsed only |

Read `docs/Solution-Deep-Dive.md` first (design, protocol, every screen wireframed), then `docs/SRS.md` and `docs/SRS-Compliance.md` (requirements with honest status). Also: `docs/ARCHITECTURE.md`, `THREAT_MODEL.md`, `COMPLIANCE.md`, `DESIGN_ANSWER.md`, `RUNBOOK.md`.

## Quick start

**Everything in Docker** (Windows 11 with Docker Desktop, or Linux):
```bash
cp .env.example .env          # Windows: copy .env.example .env
# put real secrets in .env:  docker compose run --rm api fieldsync-admin init   (paste the two lines)
docker compose up -d --build
# console  http://localhost:8081      API + Swagger  http://localhost:8080/docs
docker compose run --rm api fieldsync-admin demo        # the whole story in your terminal
```

**Development on Ubuntu or WSL2** (hot reload):
```bash
bash scripts/setup-linux.sh --install     # once: Python, Node, tooling
bash scripts/dev.sh                       # API :8080, console http://localhost:5173
bash scripts/dev-token.sh supervisor      # another terminal: prints a sign-in token
```

**Verify everything CI verifies:** `bash scripts/check.sh` (Linux/WSL) · `scripts\check.cmd` (Windows, uses Docker).

**Try the Field app.** Register a device with one admin token, activate it with a *different* admin token (Enrolment screen), issue a `device` token whose subject equals that device ID, sign in, press **Simulate offline**, add entries, turn it off again and watch them become **Acknowledged**. Full steps: `WALKTHROUGH.md`.

## Layout
```
src/fieldsync/   API, ingest service, audit chain, roles, reference device, demo, CLI
tests/           60 tests; tests/vectors/event_vector.json is the cross-language hash vector
web/             React 19 + TypeScript console and the browser sync engine (web/src/lib/sync); 81 tests
sdk-ts/          Node/TypeScript device SDK (encrypted log, resumable idempotent sync); 9 tests
evals/           golden set + harness for the triage advisory (rules baseline gates CI)
deploy/          Kubernetes and Terraform reference manifests (see deploy/README.md)
scripts/         check.cmd (Windows) · check/dev/dev-token/setup-linux/set-owner .sh (Linux, WSL)
.github/         ci.yml · security.yml · release.yml · ai-evals.yml · CODEOWNERS
docs/            Solution-Deep-Dive · SRS · SRS-Compliance · ARCHITECTURE · THREAT_MODEL · COMPLIANCE · DESIGN_ANSWER · RUNBOOK
```

## Configuration (`.env`)
| Variable | Meaning |
|---|---|
| `SYNC_SIGNING_KEY` | Ed25519 seed that signs audit checkpoints (production: KMS/HSM) |
| `SYNC_TOKEN_SECRET` | HMAC secret for the development bearer tokens (production: OIDC/mTLS at the edge) |
| `SYNC_OFFLINE_AFTER_S` | Silence (s) before a device is offline and alerts (default 3600) |
| `SYNC_BACKLOG_ALERT` | Device queue depth that raises an alert (default 1000) |
| `SYNC_DATA_DIR`, `SYNC_MAX_BATCH_EVENTS` | Storage location; batch limit (default 500) |
| `SYNC_AI_ENABLED`, `SYNC_ANTHROPIC_API_KEY`, `SYNC_AI_MODEL` | Optional advisory enrichment. Off by default; needs both the flag and a key. Never gates data |

## Honest limits
Reference persistence is SQLite (production: PostgreSQL); immutability is enforced by triggers, which are **tamper-evident, not tamper-proof** (production: WORM/object lock); TLS and server-side encryption are deployment work; device auth is a bearer token; the console has not been run in a real browser, and Docker/GitHub Actions paths are written but were not executed by the author. Details: `docs/SRS-Compliance.md` §4 to §6.

AI is optional and advisory only (off by default; the workflow never depends on it). No dependency bots. See `CONTRIBUTING.md` and `SECURITY.md`.
