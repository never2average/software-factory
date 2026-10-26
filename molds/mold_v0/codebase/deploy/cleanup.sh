#!/bin/sh
# Disk cleanup policy for the app's own host (docs/storage.md, "Host disk"). Touches only what the app owns, except
# Docker's build cache, which is shared but only cache.
#
#   sh deploy/cleanup.sh [--dry-run]
#
# Runs after every rolling deploy and daily from /etc/cron.d/app-cleanup (deploy/install-cleanup.sh).
#   1. Untagged images of the app's compose project ($COMPOSE_PROJECT_NAME, default app) (each deploy leaves the previous server image behind).
#   2. Docker build cache above APP_BUILD_CACHE_KEEP (5gb), oldest first.
#   3. Local agent images (the registry's image.docker tags) whose tag is not the version pinned in harnesses/registry.json,
#      and those under their name before mold_v0-097 (LEGACY_AGENTS) once the same version is built under the new one.
#   4. Test leftovers in /tmp older than a day.
#   5. Disk guard: above 90% used it warns; above 95% it also removes every unused image of the app.
# Never touches volumes, running containers, other projects' images or /tmp files it did not create.
set -u
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${COMPOSE_PROJECT_NAME:-app}"
REGISTRY="$HERE/../harnesses/registry.json"
# The local images' names before mold_v0-097 (the orchestrator still runs them where nothing newer is built: runners.ts localImage).
LEGACY_AGENTS=octillion/agent-; LEGACY_SANDBOX=octillion-sandbox:
KEEP_CACHE="${APP_BUILD_CACHE_KEEP:-${OCTILLION_BUILD_CACHE_KEEP:-5gb}}"   # the old name, before mold_v0-045, as a fallback
log() { echo "[app-cleanup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
run() { if [ "$DRY" = 1 ]; then log "would run: $*"; else "$@"; fi; }
used() { df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }'; }

log "start: disk $(used)% used$( [ "$DRY" = 1 ] && echo ' (dry run)')"

# 1. Our untagged images (old server builds); in-use images are refused by docker, never forced.
ids=$(docker images -q -f dangling=true -f label=com.docker.compose.project=$PROJECT | sort -u)
[ -n "$ids" ] && { log "removing $(echo "$ids" | wc -l) old build image(s)"; for i in $ids; do run docker rmi "$i" >/dev/null 2>&1 || true; done; }

# 2. Build cache, capped.
if [ "$DRY" = 1 ]; then log "would run: docker builder prune -f --keep-storage $KEEP_CACHE"
else docker builder prune -f --keep-storage "$KEEP_CACHE" 2>/dev/null | tail -n 1 | sed "s/^/[app-cleanup] build cache: /"; fi

# 3. Local agent images not at their pinned version.
if [ -f "$REGISTRY" ] && command -v python3 >/dev/null; then
  pins=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("\n".join(sorted({a["harness"]+":"+a["harness_version"] for a in r["agents"] if a.get("harness_version")})))' "$REGISTRY")
  tags=$(docker images --format '{{.Repository}}:{{.Tag}}')
  echo "$tags" | grep -e '^app/agent-' -e "^$LEGACY_AGENTS" | while read -r img; do
    h=${img#app/agent-}; h=${h#"$LEGACY_AGENTS"}
    if ! echo "$pins" | grep -qx "$h"; then log "removing stale agent image $img (not the pinned version)"; run docker rmi "$img" >/dev/null 2>&1 || true
    elif [ "$img" != "app/agent-$h" ] && echo "$tags" | grep -qx "app/agent-$h"; then log "removing $img: built again as app/agent-$h"; run docker rmi "$img" >/dev/null 2>&1 || true; fi
  done
fi

# 4. Test leftovers (directory names our test suites create).
for d in $(find /tmp -maxdepth 1 \( -name 'app-migrations-*' -o -name 'acp-work-*' -o -name 'codexhome-*' \) -mmin +1440 2>/dev/null); do
  run rm -rf "$d"
done

# 5. Disk guard.
u=$(used)
if [ "$u" -ge 95 ]; then
  log "WARNING: disk ${u}% used: removing every unused image of the app"
  ids=$(docker images -q -f label=com.docker.compose.project=$PROJECT | sort -u)
  for i in $ids; do run docker rmi "$i" >/dev/null 2>&1 || true; done
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -e '^app/agent-' -e '^app-sandbox:' -e "^$LEGACY_AGENTS" -e "^$LEGACY_SANDBOX" | while read -r img; do run docker rmi "$img" >/dev/null 2>&1 || true; done
elif [ "$u" -ge 90 ]; then
  log "WARNING: disk ${u}% used (other projects' files are not touched; see docs/storage.md)"
fi
log "done: disk $(used)% used"
