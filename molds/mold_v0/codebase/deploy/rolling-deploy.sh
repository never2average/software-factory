#!/bin/sh
# Zero-downtime deploy of the Octillion server and its web console (mold_v0-020):
#   build both images (one after the other) -> migrate the database -> prove row-level security -> for the API, then
#   the console: start a NEW replica next to the old one -> wait until it is healthy -> drain the old one(s) -> remove them.
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

# One build at a time: the console's `next build` and the server's install together would not fit a 4 GB host.
dc build octillion
dc build console
# Schema first, in a one-off container of the new image (src/migrate.ts): the new replica then starts with nothing to
# apply, and a failed migration stops the deploy before anything is replaced. Migrations are backward compatible with
# the release still running (docs/migrations.md), so the old replicas keep serving meanwhile.
echo "applying database migrations"
dc run --rm -T octillion npm run --silent db:migrate
# Prove row-level security on the live database before anything new serves (src/rls.ts): stops the deploy otherwise.
echo "checking row-level security"
dc run --rm -T octillion npm run --silent check:rls

# roll <service> <drain seconds>: a new replica next to the old one(s), healthy first, then the old one(s) drained.
roll() {
  svc=$1; grace=$2
  old=$(dc ps -q "$svc" || true)
  count=$(printf '%s\n' "$old" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    echo "$svc: no running replica: plain start (with what it depends on)"
    dc up -d --wait "$svc"
    return 0
  fi
  echo "$svc: starting the new replica next to $count old one(s)"
  dc up -d --no-deps --no-recreate --scale "$svc=$((count + 1))" --wait "$svc"
  new=$(dc ps -q "$svc" | grep -v -F "$old" || true)
  [ -n "$new" ] || { echo "$svc: no new replica appeared; nothing changed" >&2; exit 1; }
  for c in $new; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = "healthy" ] || { echo "$svc: new replica $c is not healthy; old replica left running" >&2; exit 1; }
  done
  for c in $old; do
    echo "$svc: draining old replica $(docker inspect -f '{{.Name}}' "$c") (up to ${grace}s)"
    docker stop -t "$grace" "$c" >/dev/null
    docker rm "$c" >/dev/null
  done
  echo "deployed: $(dc ps "$svc" --format '{{.Name}} {{.Status}}')"
}

# The API first (in-flight model streams get OCTILLION_DRAIN_SECONDS), then the console, which holds no streams (Caddy
# sends those to the API directly). The console's Next.js server exits as soon as it is stopped: new requests already go
# to the new replica (Caddy retries a refused connection), but a page render in flight on the old one at that moment
# is cut, and its browser retries it.
roll octillion $(( ${OCTILLION_DRAIN_SECONDS:-300} + 30 ))
roll console 30
# Caddy reads its routes from deploy/Caddyfile, mounted as a file: when the file on disk differs from the one the
# running Caddy holds (a checkout replaces the file, which a running container does not see), Caddy is recreated on it
# (a second without answers); otherwise it is only started if absent.
if dc ps -q caddy | grep -q . && ! dc exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - "$(dirname "$COMPOSE_FILE")/Caddyfile"; then
  echo "caddy: its routes changed; recreating it on deploy/Caddyfile"
  dc up -d --no-deps --force-recreate caddy
else
  # a file edited in place is seen by the container but not by Caddy until it reloads (a reload keeps connections)
  dc up -d --no-deps caddy && { dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || echo "caddy: reload failed; its routes are the ones it started with" >&2; }
fi
# The runner service (run sandboxes, mold_v0-055) runs the same image: recreated on it. Runs in flight keep their own
# containers; the new runner tears them down when their runs end.
dc up -d --no-deps runner || echo "the runner service did not restart (runs wait until it does)" >&2
# Disk cleanup policy (old server images, build cache, test leftovers). Never fails the deploy.
sh "$(dirname "$COMPOSE_FILE")/cleanup.sh" || echo "cleanup failed (deploy is fine)"
