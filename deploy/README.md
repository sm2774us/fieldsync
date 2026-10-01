# Deployment reference

Reference manifests, not a turnkey production install. Neither was applied to a real cluster or cloud account by the author.

## Kubernetes (`k8s/fieldsync.yaml`)
```bash
# 1. secrets (never commit): generate with `fieldsync-admin init`
kubectl create namespace fieldsync
kubectl -n fieldsync create secret generic fieldsync-secrets \
  --from-literal=SYNC_SIGNING_KEY="$(openssl rand -hex 32)" \
  --from-literal=SYNC_TOKEN_SECRET="$(openssl rand -hex 32)"
# optional AI enrichment (off by default; the workflow never needs it):
#   --from-literal=SYNC_AI_ENABLED=1 --from-literal=SYNC_ANTHROPIC_API_KEY=...
# 2. set the image references (pin by digest), then
kubectl apply -f deploy/k8s/fieldsync.yaml
```
Replace `sm2774us` with your GitHub owner (`bash scripts/set-owner.sh <owner>`). Add an Ingress with TLS for both the console and, if devices connect directly, the API. Production replaces SQLite with PostgreSQL before scaling beyond one replica.

## Terraform (`terraform/worm_storage.tf`)
Two Object-Lock (COMPLIANCE) buckets with KMS encryption, public-access block and TLS-only policy: `archive` and `anchors`.
```bash
cd deploy/terraform && terraform init && terraform plan -var name_prefix=myorg
```
Uploading checkpoints (`fieldsync-admin checkpoint` prints them) and exporting events to these buckets is a deployment step that is not automated in this repository.
