# Self-hosted production deploy

`docker-compose.prod.yml` runs the whole server side on one host:

| Service | Role | Exposed |
|---|---|---|
| `postgres` 17 | config, queue, scores, **key vault** (encrypted) | internal only |
| `pg-backup` | nightly `pg_dump -Fc`, kept `BACKUP_KEEP_DAYS` (7) days in the `pg_backups` volume | – |
| `clickhouse` 25.12 | raw JSONL transcripts + full-text search | internal only |
| `octillion` | landing page, MCP, worker API, fleet, **inference gateway** `/gw/*` | via Caddy |
| `runner` | run sandboxes (mold_v0-055, `src/run-fleet.ts`): a container per queued run from the `octillion` image, on the `runs` network; the only service with the Docker socket | – |
| `caddy` | TLS (automatic Let's Encrypt for `DOMAIN`) | 80 / 443 |

```bash
cd deploy
DOMAIN=octillion.example.com ./bootstrap.sh     # writes .env (0600) with generated secrets, once
docker compose -f docker-compose.prod.yml --env-file .env up -d --build --wait

# load credentials into the key vault: hidden prompts, verified against each provider, stored encrypted
./load-keys.sh                    # or: ANTHROPIC_API_KEY=... ./load-keys.sh --from-env ; ./load-keys.sh --list
# (manual equivalent, stdin only; values never touch argv or logs)
docker compose -f docker-compose.prod.yml --env-file .env exec -T octillion npx tsx scripts/keyvault.ts set boat --label main < boat.env
printf %s "$ANTHROPIC_API_KEY" | docker compose -f docker-compose.prod.yml --env-file .env exec -T octillion npx tsx scripts/keyvault.ts set anthropic
printf %s "$OPENAI_API_KEY"    | docker compose -f docker-compose.prod.yml --env-file .env exec -T octillion npx tsx scripts/keyvault.ts set openai
docker compose -f docker-compose.prod.yml --env-file .env exec octillion npx tsx scripts/keyvault.ts list   # hints only

# first customer
docker compose -f docker-compose.prod.yml --env-file .env exec octillion npx tsx scripts/create-org.ts "Acme Inc"
```

Orchestrators need only `OCTILLION_URL=https://$DOMAIN` and `OCTILLION_WORKER_TOKEN` from `.env`. Everything else
(boat.dev key, LLM access) is brokered from the vault (see `docs/credentials.md`).

**Secrets**
- **`OCTILLION_VAULT_KEY`** decrypts the vault. Back it up offline; losing it means re-entering every provider key.
- **Rotating the master key:** set the old value as `OCTILLION_VAULT_KEY_PREVIOUS`, set a new `OCTILLION_VAULT_KEY`,
  restart, run `keyvault rekey`, then drop the previous key.
- **Admin access:** platform admins sign in with Clerk. Scripts use an admin token minted for one purpose, with the
  least role it needs and an expiry (30 days by default, 90 at most): `npm run admin:token -- create --label <purpose>
  --role <viewer|support|operator|owner>` inside the app container (`list`, `revoke <id>` too; owners can also do it on
  `/api/admin/tokens`). Send it as `Authorization: Bearer adm_…`. There is no static admin token: an old
  `OCTILLION_ADMIN_TOKEN` in `.env` opens nothing (the server says so at start); remove it. Put Caddy IP-allowlisting
  in front if the host is shared.

**Restore**
```bash
docker compose -f docker-compose.prod.yml --env-file .env exec postgres \
  pg_restore -U octillion -d octillion --clean /path/inside/container.dump
```
