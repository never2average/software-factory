#!/usr/bin/env bash
# Generate deploy/.env with strong random secrets (once). Re-running keeps existing values.
# Back up OCTILLION_VAULT_KEY somewhere safe: without it the key vault cannot be decrypted.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
touch .env
gen() { openssl rand -base64 "$1" | tr -d '\n=/+' | cut -c1-"$2"; }
put() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }

put POSTGRES_PASSWORD "$(gen 48 40)"
put CLICKHOUSE_PASSWORD "$(gen 48 40)"
put OCTILLION_VAULT_KEY "$(openssl rand -base64 32)"
put OCTILLION_ADMIN_TOKEN "adm_$(gen 48 40)"
put OCTILLION_WORKER_TOKEN "wrk_$(gen 48 40)"
put DOMAIN "${DOMAIN:-localhost}"
put PUBLIC_URL "${PUBLIC_URL:-https://${DOMAIN:-localhost}}"
chmod 600 .env
echo "deploy/.env ready ($(grep -c = .env) values). Set DOMAIN/PUBLIC_URL for your host, then:"
echo "  docker compose -f docker-compose.prod.yml --env-file .env up -d --build"
