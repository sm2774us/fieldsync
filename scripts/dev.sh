#!/usr/bin/env bash
# One command for local development: API on :8080 and the console (hot reload) on :5173.
#   bash scripts/dev.sh          then open http://localhost:5173 and sign in with a token
#   bash scripts/dev-token.sh auditor   (in another terminal) prints a token for that role
# Secrets are generated once into .env.dev (git-ignored) so tokens survive restarts.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
warn_if_windows_mount
ensure_venv
ensure_node_modules web

if [[ ! -f .env.dev ]]; then
  say "Generating .env.dev (development secrets, never commit)"
  { fieldsync-admin init; echo "SYNC_DATA_DIR=$ROOT/.dev-data"; } > .env.dev
fi
set -a; source .env.dev; set +a
mkdir -p "$SYNC_DATA_DIR"

cleanup() { trap - INT TERM EXIT; kill 0 2>/dev/null || true; }
trap cleanup INT TERM EXIT

say "API      http://localhost:8080   (Swagger: /docs)"
python -m fieldsync.app &
say "Console  http://localhost:5173"
(cd web && npm run dev -- --host 127.0.0.1) &
say "Tokens:  bash scripts/dev-token.sh <device|supervisor|reviewer|auditor|admin>   Ctrl+C stops both."
wait -n
