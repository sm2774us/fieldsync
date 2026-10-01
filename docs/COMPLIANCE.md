# CJIS-style control mapping (engineering view)

Not a certification. CJIS Security Policy compliance also depends on personnel screening, facility controls, agency policy and the hosting environment. This maps what the **software** provides to the policy areas, and says where it does not.

| Policy area | Implementation | Gap |
|---|---|---|
| Access control | Five least-privilege roles; agency claim on every token; separation of duties (admin cannot read data; two-person device activation) | Roles come from dev tokens; production needs OIDC claim mapping |
| Auditing and accountability | Hash-chained audit of auth, state changes, reviews and every denied request (actor, role, IP, request ID); signed checkpoints; verify endpoint; `/readyz` fails on a broken chain | Checkpoint export to an independent store is manual |
| Identification and authentication | Short-lived signed tokens, revocation list (`jti`), device revocation, token subject bound to the device ID | No MFA or mTLS in the reference |
| Encryption | Device log encrypted at rest (AES-256-GCM); HTTPS expected at the ingress | Server storage encryption and TLS are deployment work (KMS key and bucket policy provided in Terraform) |
| Media and record integrity | SHA-256 content hash verified server-side; immutable events and versions; quarantine preserves bytes as received | Triggers are tamper-evident only; WORM storage needed for tamper-proof |
| Incident response | Alerts, advisory triage, quarantine dispositions with reasons, `docs/RUNBOOK.md` | No paging integration |
| Configuration and supply chain | Pinned constraints, image scan, SBOM, keyless signing, provenance, pinned actions by tag (pin by SHA before adopting), no dependency bots | Actions pinned by tag, not SHA |
| Privacy | Advisory AI receives minimised metadata only (allow-list); never event payloads, record content or free text; no real data in tests, CI or prompts | AI egress should go through a reviewed proxy |
