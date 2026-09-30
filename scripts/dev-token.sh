#!/usr/bin/env bash
# Prints a development bearer token for the .env.dev secrets. Usage: dev-token.sh <role> [subject] [agency] [ttl_seconds]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
role="${1:?usage: dev-token.sh <device|supervisor|reviewer|auditor|admin> [subject] [agency] [ttl]}"
[[ -f .env.dev ]] || die ".env.dev not found. Start the stack first: bash scripts/dev.sh"
ensure_venv
set -a; source .env.dev; set +a
fieldsync-admin issue-token --sub "${2:-$role-1}" --role "$role" --agency "${3:-agency-1}" --ttl "${4:-3600}"
