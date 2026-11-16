#!/usr/bin/env bash
# Pull-based deploy for jgame.duckdns.org. Run every minute by jgame-deploy.timer.
#
#   ~/srv/jgame/repo.git        bare mirror of GitHub (public, no credentials needed)
#   ~/srv/jgame/releases/<sha>  exported, built and tested trees
#   ~/srv/jgame/current         symlink to the live release
#
# A new commit on main is exported, checked (tools/check.sh), activated, and
# its infra installed (systemd units, landing page, Caddy route). If anything
# fails after activation the previous release is restored. Commits that fail
# are remembered in ~/srv/jgame/failed and not retried (FORCE=1 to retry).
set -euo pipefail

SRV="${JGAME_SRV:-$HOME/srv/jgame}"
REPO_URL="${JGAME_REPO:-https://github.com/jetzhu/jgame.git}"
BRANCH="${JGAME_BRANCH:-main}"
PROXY="${JGAME_PROXY:-$HOME/Projects/setup/reverse-proxy}"
UNITS="$HOME/.config/systemd/user"
KEEP=5

log() { echo "[deploy] $*"; }
mkdir -p "$SRV/releases"
exec 9>"$SRV/.lock"
flock -n 9 || exit 0

[ -d "$SRV/repo.git" ] || git clone --quiet --bare "$REPO_URL" "$SRV/repo.git"
git --git-dir="$SRV/repo.git" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/heads/$BRANCH"
NEW="$(git --git-dir="$SRV/repo.git" rev-parse "refs/heads/$BRANCH")"
CUR="$(basename "$(readlink "$SRV/current" 2>/dev/null || echo none)")"

if [ "$NEW" = "$CUR" ] && [ "${FORCE:-0}" != 1 ]; then exit 0; fi
if grep -qxF "$NEW" "$SRV/failed" 2>/dev/null && [ "${FORCE:-0}" != 1 ]; then exit 0; fi
log "deploying ${NEW:0:12} (live: ${CUR:0:12})"

# 1. export + check in a staging dir (live site untouched until this passes)
REL="$SRV/releases/$NEW"
if [ ! -f "$REL/.checked" ]; then
  rm -rf "$REL" "$REL.tmp"
  mkdir -p "$REL.tmp"
  git --git-dir="$SRV/repo.git" archive "$NEW" | tar -x -C "$REL.tmp"
  if ! "$REL.tmp/tools/check.sh"; then
    log "checks failed for ${NEW:0:12}; staying on ${CUR:0:12}"
    echo "$NEW" >> "$SRV/failed"
    rm -rf "$REL.tmp"
    exit 1
  fi
  touch "$REL.tmp/.checked"
  mv "$REL.tmp" "$REL"
fi

activate() { ln -sfn "releases/$1" "$SRV/current.tmp" && mv -T "$SRV/current.tmp" "$SRV/current"; }

install_infra() { # $1 = release dir
  local rel="$1" changed=0 f name
  # systemd user units
  mkdir -p "$UNITS"
  for f in "$rel"/deploy/systemd/*; do
    name="$(basename "$f")"
    if ! cmp -s "$f" "$UNITS/$name"; then cp "$f" "$UNITS/$name"; changed=1; log "unit updated: $name"; fi
  done
  if [ "$changed" = 1 ]; then
    systemctl --user daemon-reload
    for f in "$rel"/deploy/systemd/*; do
      name="$(basename "$f")"
      grep -q '^\[Install\]' "$f" && systemctl --user enable --quiet "$name"
      case "$name" in *.timer) systemctl --user start "$name" ;; esac
    done
  fi
  # landing page
  if [ -d "$PROXY/www/jgame" ]; then rsync -a --delete "$rel/site/" "$PROXY/www/jgame/"; fi
  # Caddy route (validated by reload.sh; caddy keeps the old config if validation fails)
  local live="$PROXY/domains/jgame.caddy"
  if [ -f "$rel/deploy/caddy/jgame.caddy" ] && ! cmp -s "$rel/deploy/caddy/jgame.caddy" "$live"; then
    cp "$live" "$live.prev"
    cp "$rel/deploy/caddy/jgame.caddy" "$live"
    if ! "$PROXY/reload.sh"; then
      log "caddy config rejected; restoring previous"
      cp "$live.prev" "$live"
      return 1
    fi
    log "caddy route updated"
  fi
}

restart_and_check() { # $1 = release dir
  local unit url i ok
  while read -r unit url; do
    case "$unit" in ''|'#'*) continue ;; esac
    systemctl --user restart "$unit"
    ok=0
    for i in $(seq 1 30); do
      if curl -fsS -m 2 "$url" >/dev/null 2>&1; then ok=1; break; fi
      sleep 0.5
    done
    if [ "$ok" != 1 ]; then log "health check failed: $unit ($url)"; return 1; fi
    log "healthy: $unit"
  done < "$1/deploy/services.txt"
}

# 2. go live
activate "$NEW"
if install_infra "$REL" && restart_and_check "$REL"; then
  log "live: ${NEW:0:12}"
else
  echo "$NEW" >> "$SRV/failed"
  if [ "$CUR" != none ] && [ -d "$SRV/releases/$CUR" ]; then
    log "rolling back to ${CUR:0:12}"
    activate "$CUR"
    install_infra "$SRV/releases/$CUR" || true
    restart_and_check "$SRV/releases/$CUR" || log "WARNING: rollback health check failed too"
  fi
  exit 1
fi

# 3. prune old releases (never the live one)
ls -1t "$SRV/releases" | grep -v '\.tmp$' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$NEW" ] || rm -rf "${SRV:?}/releases/$old"
done
