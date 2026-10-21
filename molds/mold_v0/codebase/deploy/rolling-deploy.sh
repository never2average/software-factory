#!/bin/sh
# Zero-downtime deploy of the Octillion server:
#   build -> migrate the database -> prove row-level security -> start a NEW replica next to the old one -> wait until it is healthy -> drain the old one(s) -> remove them.
# New requests go to the new replica as soon as the old one starts draining (it refuses connections and Caddy retries
# elsewhere); requests already in flight on the old replica, including agents' model streams through the gateway,
# finish there (OCTILLION_DRAIN_SECONDS, default 300). Orchestrators launched before the new replica started are
# retired by its autoscaler as they go idle (recycle on deploy).
#
#   deploy/rolling-deploy.sh <env-file> [compose project, default: octillion]
#
# Container names are not stable across deploys (octillion-octillion-1, -2, ...): use
#   docker compose -p octillion -f deploy/docker-compose.prod.yml --env-file <env-file> exec octillion <cmd>
set -eu
ENV_FILE=${1:?usage: rolling-deploy.sh <env-file> [project]}
PROJECT=${2:-octillion}
COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.prod.yml"
dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

dc build octillion
# Schema first, in a one-off container of the new image (src/migrate.ts): the new replica then starts with nothing to
# apply, and a failed migration stops the deploy before anything is replaced. Migrations are backward compatible with
# the release still running (docs/migrations.md), so the old replicas keep serving meanwhile.
echo "applying database migrations"
dc run --rm -T octillion npm run --silent db:migrate
# Prove row-level security on the live database before anything new serves (src/rls.ts): stops the deploy otherwise.
echo "checking row-level security"
dc run --rm -T octillion npm run --silent check:rls
old=$(dc ps -q octillion || true)
count=$(printf '%s\n' "$old" | grep -c . || true)
if [ "$count" -eq 0 ]; then
  echo "no running replica: plain start"
  dc up -d --wait octillion
  exit 0
fi

echo "starting the new replica next to $count old one(s)"
dc up -d --no-deps --no-recreate --scale "octillion=$((count + 1))" --wait octillion
new=$(dc ps -q octillion | grep -v -F "$old" || true)
[ -n "$new" ] || { echo "no new replica appeared; nothing changed" >&2; exit 1; }
for c in $new; do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = "healthy" ] || { echo "new replica $c is not healthy; old replica left running" >&2; exit 1; }
done

grace=$(( ${OCTILLION_DRAIN_SECONDS:-300} + 30 ))
for c in $old; do
  echo "draining old replica $(docker inspect -f '{{.Name}}' "$c") (up to ${grace}s)"
  docker stop -t "$grace" "$c" >/dev/null
  docker rm "$c" >/dev/null
done
echo "deployed: $(dc ps octillion --format '{{.Name}} {{.Status}}')"
# Disk cleanup policy (old server images, build cache, test leftovers). Never fails the deploy.
sh "$(dirname "$COMPOSE_FILE")/cleanup.sh" || echo "cleanup failed (deploy is fine)"
