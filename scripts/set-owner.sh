#!/usr/bin/env bash
# Linux/WSL equivalent of set-owner.ps1: replaces the placeholder organisation name with your GitHub username.
#   bash scripts/set-owner.sh YOUR_GITHUB_USERNAME
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
owner="${1:?usage: set-owner.sh <github-username>}"
[[ "$owner" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]] || die "That is not a valid GitHub username"
mapfile -t files < <(grep -rlE 'your-org' --include='*.md' --include='*.yml' --include='*.yaml' --include='*.json' --include='*.toml' --include='*.tf' --include='CODEOWNERS' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv --exclude=package-lock.json . || true)
for f in "${files[@]}"; do
  sed -i -E "s#@your-org/(security|platform)#@${owner}#g; s#\byour-org\b#${owner}#g" "$f"
  echo "updated $f"
done
ok "Owner is now '$owner' (${#files[@]} files)."
