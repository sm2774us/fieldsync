#!/usr/bin/env bash
# Runs every check CI runs.
#   bash scripts/check.sh            native if Python 3.12+ and Node 22+ exist, otherwise in Docker
#   bash scripts/check.sh --native   force local toolchain (creates .venv, installs pinned deps)
#   bash scripts/check.sh --docker   force containers (same as scripts\check.cmd on Windows)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-auto}"
if [[ "$mode" == "auto" ]]; then
  if py_ok && node_ok; then mode="--native"; elif have docker; then mode="--docker"; else die "Need (Python 3.12+ and Node 22+) or Docker. Run: bash scripts/setup-linux.sh"; fi
fi
warn_if_windows_mount

case "$mode" in
  --docker)
    have docker || die "Docker not found"
    say "Python: lint, types, tests, demo (container)"
    docker run --rm -v "$ROOT":/src:ro python:3.13-slim sh -c \
      "cp -r /src /tmp/w && cd /tmp/w && pip install -q -c constraints.txt -e '.[dev]' && ruff check . && ruff format --check . && mypy src && pytest --cov=fieldsync --cov-report=term-missing && fieldsync-admin demo"
    say "Web console (container)"
    docker run --rm -v "$ROOT":/src:ro node:22-slim sh -c \
      "cp -r /src /tmp/w && cd /tmp/w/web && npm ci --ignore-scripts --no-audit --no-fund && npm run check"
    ;;
  --native)
    ensure_venv
    say "Python: lint"        ; ruff check . && ruff format --check .
    say "Python: types"       ; mypy src
    say "Python: tests"       ; pytest --cov=fieldsync --cov-report=term-missing
    say "End-to-end simulation"; fieldsync-admin demo
    ensure_node_modules web
    say "Web console"         ; (cd web && npm run check)
    ;;
  *) die "Unknown option $mode (use --native or --docker)" ;;
esac
ok "All checks passed."
