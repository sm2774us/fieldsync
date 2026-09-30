## What / why

## Evidence-integrity checklist
- [ ] No code path can modify or delete an original, or shorten retention
- [ ] Every new state change writes an audit row in the same transaction
- [ ] New endpoints declare a permission and are agency-scoped
- [ ] Tests cover the failure mode, not just the happy path
- [ ] Touches sync semantics (ordering, idempotency, quarantine)? Tests added and docs/SRS.md updated
