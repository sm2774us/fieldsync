# shellcheck shell=bash
# Shared helpers for the Linux / WSL scripts. Source it; do not execute it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# Refuse the slow/broken case early: repo on the Windows drive while running inside WSL.
warn_if_windows_mount() {
  if is_wsl && [[ "$ROOT" == /mnt/* ]]; then
    warn "This repo is on the Windows drive ($ROOT). File permissions and speed suffer there."
    warn "Clone it inside WSL instead:  git clone <url> ~/offline-sync"
  fi
}

py_ok() { have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; }
node_ok() { have node && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]]; }

ensure_venv() {
  py_ok || die "Python 3.12+ is required (found: $(python3 --version 2>&1 || echo none)). Run: bash scripts/setup-linux.sh"
  if [[ ! -x .venv/bin/python ]]; then say "Creating .venv"; python3 -m venv .venv || die "python3-venv missing. Run: bash scripts/setup-linux.sh --install"; fi
  # shellcheck disable=SC1091
  source .venv/bin/activate
  if ! python -c 'import fieldsync' 2>/dev/null || [[ pyproject.toml -nt .venv/.installed || constraints.txt -nt .venv/.installed ]]; then
    say "Installing Python dependencies (pinned by constraints.txt)"
    pip install -q -c constraints.txt -e ".[dev,mcp]"
    touch .venv/.installed
  fi
}

ensure_node_modules() {
  local dir="$1"
  node_ok || die "Node 22+ is required (found: $(node --version 2>&1 || echo none)). Run: bash scripts/setup-linux.sh --install"
  if [[ ! -d "$dir/node_modules" || "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]]; then
    say "Installing npm packages in $dir"
    (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund)
  fi
}
