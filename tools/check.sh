#!/usr/bin/env bash
# Install, build and test every game. Used by CI and by deploy/deploy.sh before going live.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
test -f "$root/site/index.html" || { echo "missing site/index.html" >&2; exit 1; }
for pkg in "$root"/games/*/package.json "$root"/services/*/package.json; do
  dir="$(dirname "$pkg")"
  echo "==> $(basename "$dir")"
  (
    cd "$dir"
    npm ci --no-audit --no-fund --loglevel=error
    npm run build --if-present
    npm test --if-present
  )
done
echo "all checks passed"
