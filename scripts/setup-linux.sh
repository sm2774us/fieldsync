#!/usr/bin/env bash
# Checks (and with --install, installs) prerequisites on Ubuntu / Debian / WSL Ubuntu.
#   bash scripts/setup-linux.sh             report only, changes nothing
#   bash scripts/setup-linux.sh --install   apt-installs git, make, curl, jq, python3-venv, Node 22
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

INSTALL=0; [[ "${1:-}" == "--install" ]] && INSTALL=1
warn_if_windows_mount
is_wsl && say "Detected WSL" || say "Detected native Linux"

missing=()
for t in git curl make jq; do have "$t" || missing+=("$t"); done
py_ok || missing+=(python3-venv python3-pip)
python3 -c 'import venv, ensurepip' 2>/dev/null || missing+=(python3-venv)

if [[ ${#missing[@]} -gt 0 || $INSTALL -eq 1 ]]; then
  if [[ $INSTALL -eq 1 ]]; then
    have apt-get || die "Only apt-based systems are automated. Install: ${missing[*]} manually."
    say "Installing system packages (sudo)"
    sudo apt-get update -qq
    sudo apt-get install -y git curl make jq ca-certificates python3 python3-venv python3-pip
  else
    warn "Missing: ${missing[*]}  (re-run with --install, or: sudo apt-get install -y ${missing[*]})"
  fi
fi

if ! node_ok; then
  if [[ $INSTALL -eq 1 ]]; then
    say "Installing Node 22 from NodeSource (sudo)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    warn "Node 22+ not found. Install with: bash scripts/setup-linux.sh --install"
  fi
fi

if have docker && docker info >/dev/null 2>&1; then ok "Docker is running"
elif have docker; then
  warn "Docker is installed but the daemon is not reachable."
  is_wsl && warn "WSL: start Docker Desktop and enable Settings > Resources > WSL integration for this distro."
  warn "Native Linux: sudo systemctl enable --now docker && sudo usermod -aG docker \$USER  (then log out and in)"
else
  warn "Docker not found (needed only for 'docker compose up' and --docker checks)."
  is_wsl && warn "WSL: install Docker Desktop for Windows with WSL integration, or Docker Engine inside WSL."
  warn "Ubuntu: https://docs.docker.com/engine/install/ubuntu/  (official apt repository)"
fi

py_ok   && ok "Python $(python3 --version | cut -d' ' -f2)" || warn "Python 3.12+ missing"
node_ok && ok "Node $(node --version)"                       || warn "Node 22+ missing"
have gh && ok "GitHub CLI $(gh --version | head -1 | cut -d' ' -f3)" || warn "GitHub CLI missing (needed to publish): https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
git config --get user.name >/dev/null || warn "git identity not set: git config --global user.name 'Your Name'; git config --global user.email you@example.com"
say "Next: bash scripts/check.sh"
