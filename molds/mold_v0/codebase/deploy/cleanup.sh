#!/bin/sh
# Disk cleanup policy for the Octillion host (docs/storage.md, "Host disk"). Touches only what Octillion owns, except
# Docker's build cache, which is shared but only cache.
#
#   sh deploy/cleanup.sh [--dry-run]
#
# Runs after every rolling deploy and daily from /etc/cron.d/octillion-cleanup (deploy/install-cleanup.sh).
#   1. Untagged images of the octillion compose project (each deploy leaves the previous server image behind).
#   2. Docker build cache above OCTILLION_BUILD_CACHE_KEEP (5gb), oldest first.
#   3. Local agent images (octillion/agent-*) whose tag is not the version pinned in harnesses/registry.json.
#   4. Octillion test leftovers in /tmp older than a day.
#   5. Disk guard: above 90% used it warns; above 95% it also removes every unused octillion image.
# Never touches volumes, running containers, other projects' images or /tmp files it did not create.
set -u
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$HERE/../harnesses/registry.json"
KEEP_CACHE="${OCTILLION_BUILD_CACHE_KEEP:-5gb}"
log() { echo "[octillion-cleanup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
run() { if [ "$DRY" = 1 ]; then log "would run: $*"; else "$@"; fi; }
used() { df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }'; }

log "start: disk $(used)% used$( [ "$DRY" = 1 ] && echo ' (dry run)')"

# 1. Our untagged images (old server builds); in-use images are refused by docker, never forced.
ids=$(docker images -q -f dangling=true -f label=com.docker.compose.project=octillion | sort -u)
[ -n "$ids" ] && { log "removing $(echo "$ids" | wc -l) old octillion build image(s)"; for i in $ids; do run docker rmi "$i" >/dev/null 2>&1 || true; done; }

# 2. Build cache, capped.
if [ "$DRY" = 1 ]; then log "would run: docker builder prune -f --keep-storage $KEEP_CACHE"
else docker builder prune -f --keep-storage "$KEEP_CACHE" 2>/dev/null | tail -n 1 | sed "s/^/[octillion-cleanup] build cache: /"; fi

# 3. Local agent images not at their pinned version.
if [ -f "$REGISTRY" ] && command -v python3 >/dev/null; then
  pins=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("\n".join(sorted({a["harness"]+":"+a["harness_version"] for a in r["agents"] if a.get("harness_version")})))' "$REGISTRY")
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '^octillion/agent-' | while read -r img; do
    h=${img#octillion/agent-}
    echo "$pins" | grep -qx "$h" || { log "removing stale agent image $img (not the pinned version)"; run docker rmi "$img" >/dev/null 2>&1 || true; }
  done
fi

# 4. Test leftovers (directory names our test suites create).
for d in $(find /tmp -maxdepth 1 \( -name 'octillion-pjtest-*' -o -name 'octillion-astest-*' -o -name 'octillion-artest-*' -o -name 'octillion-pi-*' -o -name 'acp-work-*' -o -name 'codexhome-*' \) -mmin +1440 2>/dev/null); do
  run rm -rf "$d"
done

# 5. Disk guard.
u=$(used)
if [ "$u" -ge 95 ]; then
  log "WARNING: disk ${u}% used: removing every unused octillion image"
  ids=$(docker images -q -f label=com.docker.compose.project=octillion | sort -u)
  for i in $ids; do run docker rmi "$i" >/dev/null 2>&1 || true; done
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^octillion/agent-|^octillion-sandbox:' | while read -r img; do run docker rmi "$img" >/dev/null 2>&1 || true; done
elif [ "$u" -ge 90 ]; then
  log "WARNING: disk ${u}% used (other projects' files are not touched; see docs/storage.md)"
fi
log "done: disk $(used)% used"
