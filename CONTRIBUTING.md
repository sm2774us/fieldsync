# Contributing

* `make check` must pass. CI mirrors it (`ci-ok` is the required check).
* **Dependencies are updated deliberately, not by bots.** There is no Dependabot or Renovate. The weekly `security.yml` run audits `constraints.txt` and npm and reports in the job summary. To update: change the pin(s) in `constraints.txt` (or `package-lock.json`) in one focused PR, run `make check`, done. No automated PRs or branches.
* Pin GitHub Actions to commit SHAs before adopting in a regulated organisation (tags are used here for readability).
* Never commit real records, personal data, tokens or keys. Use simulated data (`fieldsync-admin demo`).
* Changing the event envelope or hashing? Update `tests/vectors/event_vector.json` **and** its copy `web/test/fixtures/event_vector.json` (a test fails if they drift), and the SDK.
* Changing sync semantics (ordering, idempotency, quarantine, conflicts)? Add tests that try to break the guarantee, and update `docs/SRS.md` and `docs/SRS-Compliance.md` honestly.
* AI features must degrade to deterministic behaviour. Add or extend cases in `evals/cases.jsonl` with every triage change; the rules baseline must stay 100%.
* Report security issues privately (see `SECURITY.md`).
