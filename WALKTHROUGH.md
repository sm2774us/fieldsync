# FieldSync Walkthrough

Two ways to run it, and one to just watch it work. Pick your path.

| You have | Go to |
|---|---|
| Windows 11, Docker Desktop | **Part 1** then **Part 2** |
| Ubuntu or WSL2 | **Part 3** |
| Just want to see the guarantees in a terminal | **Part 2, step 3** |

---

## Part 1 · Windows 11 setup (Command Prompt)

1. Install tools (once):
   ```bat
   winget install --id Git.Git -e
   winget install --id Docker.DockerDesktop -e
   winget install --id GitHub.cli -e
   ```
   Restart, start Docker Desktop, wait for the whale to say "running".
2. Get the code:
   ```bat
   cd %USERPROFILE%\code
   git clone https://github.com/sm2774us/fieldsync.git
   cd fieldsync
   ```
   (No repository yet? See **Part 5**.)
3. Create real secrets (never commit `.env`):
   ```bat
   copy .env.example .env
   docker compose run --rm api fieldsync-admin init
   ```
   Copy the two printed lines (`SYNC_SIGNING_KEY=...`, `SYNC_TOKEN_SECRET=...`) into `.env`, replacing the empty ones.

## Part 2 · Run the stack and use it

1. Start everything:
   ```bat
   docker compose up -d --build
   ```
   Wait until `docker compose ps` shows both services healthy.
2. Open the console at **http://localhost:8081** (API and Swagger: http://localhost:8080/docs).
3. **See the guarantees in a terminal** (no UI needed):
   ```bat
   docker compose run --rm api fieldsync-admin demo
   ```
   You will see: 30 events written offline → sent over a lossy link → exactly 30 on the server, in order → a replayed key returning the stored result → a conflict resolved by a reviewer → a tampered event quarantined, the device blocked, a retry authorised and accepted → audit chain verified.
4. **Get sign-in tokens.** The console signs in with a bearer token. Create one per role:
   ```bat
   docker compose run --rm api fieldsync-admin issue-token --sub admin-a --role admin --ttl 3600
   docker compose run --rm api fieldsync-admin issue-token --sub admin-b --role admin --ttl 3600
   docker compose run --rm api fieldsync-admin issue-token --sub sup-1   --role supervisor --ttl 3600
   docker compose run --rm api fieldsync-admin issue-token --sub rev-1   --role reviewer --ttl 3600
   docker compose run --rm api fieldsync-admin issue-token --sub unit-0417 --role device --ttl 3600
   ```
   (The `--sub` of a **device** token must equal its device ID. Tokens expire; ask again when they do.)
5. **Enrol a device** (two different administrators):
   1. Sign in with `admin-a` → **Enrolment** → Register `unit-0417`, label "Patrol unit 417".
   2. Sign out, sign in with `admin-b` → **Enrolment** → Activate `unit-0417` (a two-click confirm).
   Note that neither administrator can open Fleet, Records or any events: that is deliberate.
6. **Use the Field app.** Sign in with the `unit-0417` device token → **Field app**.
   1. Press **Simulate offline** (the strip turns amber).
   2. Add three reports and a note. Each shows **Local only**; nothing has left the device.
   3. Press **Simulate offline** again. Entries go **Uploading**, then **Acknowledged**, in order.
7. **Watch as a supervisor.** Sign in with `sup-1` → **Dashboard**, **Fleet** (open `unit-0417`, Event log), **Records**.
8. **Conflict.** Seed a second device and edit the same record from the same base:
   ```bat
   docker compose run --rm api fieldsync-admin seed --url http://api:8080 --leave-open
   ```
   (`seed` runs the whole story against the running API with the secrets in `.env`, and `--leave-open` leaves one conflict and one quarantined event for you to review.) Then sign in as `rev-1` → **Conflicts**, compare both sides, decide with a reason, confirm.
9. **Tamper.** The seed run also left one quarantined event (its device is blocked). As `rev-1` → **Quarantine**: read why, compare the claimed hash with the one your browser recomputed, authorise a retry (with a reason). As an auditor (`--role auditor`) → **Audit log** → **Verify chain**.
10. Stop: `docker compose down` (add `-v` to erase data).

**Run all checks (needs only Docker):** `scripts\check.cmd`

## Part 3 · Ubuntu or WSL2

Use the Linux filesystem in WSL (`~/code`, **not** `/mnt/c/...`) or file watching and installs are slow.

```bash
git clone https://github.com/sm2774us/fieldsync.git ~/code/fieldsync && cd ~/code/fieldsync
bash scripts/setup-linux.sh --install     # Python 3.12+, Node 22, tooling (asks for sudo once)
bash scripts/dev.sh                       # API :8080 + console with hot reload :5173
```
In a second terminal:
```bash
bash scripts/dev-token.sh supervisor            # prints a token; paste it at http://localhost:5173
bash scripts/dev-token.sh admin admin-a
bash scripts/dev-token.sh admin admin-b
bash scripts/dev-token.sh device unit-0417      # subject = device ID
fieldsync-admin demo                            # (inside .venv) the terminal story
```
Then follow Part 2 steps 5 to 9. All checks: `bash scripts/check.sh` (add `--docker` to run inside containers). Windows browsers reach WSL servers at `http://localhost:...` automatically.

## Part 4 · How CI works (so a red check is not a mystery)

| Job | What it proves |
|---|---|
| `python` (3.12, 3.13) | ruff, mypy strict, 60 tests with coverage gate, triage evals, the end-to-end demo |
| `web console` | ESLint, `tsc --strict`, 81 tests with coverage gate, production build |
| `workflows-lint` | `actionlint` on every workflow |
| `container` | API image builds, starts hardened (read-only, no capabilities), answers `/readyz` and `/metrics` |
| `full stack (compose)` | API + console start, the console serves the app and proxies the API, headers present |
| `ci-ok` | Required check: passes only if every job above passed |

`ai-evals.yml` scores the optional AI advisory on a schedule (skipped safely without a key). `security.yml` adds CodeQL, `pip-audit`, `npm audit`, gitleaks and dependency review. `release.yml` (on a `vX.Y.Z` tag) builds, scans, signs and attaches an SBOM. **No bot opens pull requests.**

## Part 5 · Publish to GitHub

New repository (this project is delivered as a full tree):
```bash
git init -b main && git add -A && git commit -m "feat: FieldSync offline-first device sync"
gh repo create sm2774us/fieldsync --private --source . --push
bash scripts/set-owner.sh sm2774us          # replaces the sm2774us placeholders (CODEOWNERS), then commit
```
Adding it to an existing repository as a feature branch instead:
```bash
git switch -c feature/fieldsync && git add -A && git commit -m "feat: FieldSync" && git push -u origin feature/fieldsync
```
Then open the pull request. Set **ci-ok** as the only required status check.

## Part 4b · Advisory, SDK and deployment extras
* **Advisory.** On a Quarantine, Conflict or (offline/backlog/storage) Alert dialog press **Get advisory**. It works with no setup (rules). To let a model add detail: put `SYNC_AI_ENABLED=1`, `SYNC_ANTHROPIC_API_KEY=...` in `.env` and restart; the badge then reads "rules + AI". Remove either to turn it off.
* **Evals.** `python evals/run.py --rules-only` (inside the venv; run it from a source checkout; evals are not in the container image).
* **SDK.** `cd sdk-ts && npm ci && npm test` (Node 22+).
* **Deploy references.** See `deploy/README.md`. Not applied by the author.

## Troubleshooting
| Symptom | Cause and fix |
|---|---|
| Sign-in says the token is invalid or expired | Tokens last as long as `--ttl` says. Issue a new one. Copy the whole string, no spaces |
| **Field app is for devices** | You are not signed in with a `device` token. The token subject must equal an active device ID |
| Field app: "Not permitted" on sync | The device is pending or revoked. A second administrator must activate it |
| Console says API unreachable | `docker compose ps`; look at `docker compose logs api`. The API refuses to start with a broken audit chain? Check `/readyz` |
| Red **Audit integrity failure** everywhere | The chain does not verify. Treat as an incident; do not "fix" data; see `docs/Solution-Deep-Dive.md` §4 |
| Sync paused: quarantined event | Working as designed. A reviewer must decide (Quarantine screen) |
| `fieldsync-admin seed` says SYNC_TOKEN_SECRET not set | Run it through `docker compose run` (it reads `.env`) or export the same secret the server uses |
| Port 8080/8081 already used | Change the left side of `ports:` in `docker-compose.yml` |
| Slow installs or file watching in WSL | The repo is on `/mnt/c`. Clone inside WSL (`~/code`) |
| `scripts/*.sh: bad interpreter` after a Windows checkout | CRLF line endings. Re-clone inside WSL; `.gitattributes` forces LF for scripts |
