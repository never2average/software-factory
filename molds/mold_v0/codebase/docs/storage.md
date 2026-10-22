# Object storage (Cloudflare R2)

One private R2 bucket (`R2_BUCKET`, today `octillion-backup`) holds everything that must survive the machine and the
managed services. There is one prefix per kind of data, and `src/storage.ts` is the only code that builds keys.

| Prefix | What | Written by | Kept |
|---|---|---|---|
| `postgres/` | daily `pg_dump` of the database, copied hourly | `pg-backup-offsite` service (rclone) | newest 10 (`OFFSITE_KEEP`; the volume keeps `BACKUP_KEEP`, 10) |
| `transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz` | every finished session's full trace | `src/archive.ts` sweeper | indefinitely |
| `research/org-<id>/<research_id>.json` | every finished onboarding research result (product, personas, problems, sources) | `src/archive.ts` sweeper | indefinitely |
| `reports/org-<id>/<simulation>/<stamp>.pdf` and `.html` | run reports | reports (planned: `export_report`) | until deleted |
| `diffs/org-<id>/<simulation>/<session>.diff.gz` | workspace diffs | reserved | — |
| `exports/org-<id>/…` | customer data exports | reserved | — |
| `workspaces/org-<id>/<store>/<snapshot>.wse` | workspace store snapshots, sealed with the org's data key (mold_v0-033) | `src/workspace-store.ts` | per the pack's retention, under the platform's ceiling (mold_v0-056, `src/workspace-retention.ts`: daily; the latest and every version a result or a report references are always kept) |
| `ops/…` | internal one-offs | by hand | — |

Customer data always sits under its org's prefix (`org-<id>`, the id, because slugs can be renamed), so access can be
scoped per org by construction. Links handed out are signed, path-style and expire in at most 7 days.

## Trace archive

A session's archive is gzipped JSONL. The first line is a header, `{"_session": {...}}`, with org, product,
simulation, scenario, persona, agent, harness, model, status, completed reason, verdict, winner, cost and tokens. Every
following line is one stored event, exactly as the transcript store returns it (`seq`, `ts`, `type`, `text`, `raw`).

- **When:** the server's archive sweeper runs every `OCTILLION_ARCHIVE_INTERVAL_SECONDS` (300). It claims unarchived
  finished sessions (2+ minutes after they end) and finished research with `FOR UPDATE SKIP LOCKED`, so several
  replicas never double-write; a failed upload is retried after 15 minutes. The first sweeps after a deploy backfill
  everything recorded before archiving existed.
- **Tracking:** `agent_sessions.archive_key`, `archived_at`, `archive_events`; `product_research.archive_key`,
  `archived_at`. An infrastructure retry that wipes a transcript also clears its archive key, so the retry is
  archived afresh.
- **Off switch:** `OCTILLION_ARCHIVE=off`, or leave `R2_BUCKET` unset.

## If ClickHouse goes away

ClickHouse Cloud is on a trial. When it lapses:

1. Remove `CLICKHOUSE_URL` (and its credentials) from `deploy.env` and deploy. The server falls back to the Postgres
   transcript store.
2. Nothing breaks in the meantime: transcript reads read through to the R2 archive when the live store has no events
   for a session or cannot be reached, so reports, `get_session_transcript` and evidence links keep working.
   Transcript **search** only covers the live store.
3. To make old traces searchable again, load them into the new store from inside the server container:
   `npx tsx scripts/restore-transcripts.ts [--org <id>] [--dry-run]`. Sessions the store already has are skipped, so
   it is safe to re-run. The same command fills a new ClickHouse service.

## Host disk

The server shares its machine with other projects. `deploy/cleanup.sh` keeps Octillion's own footprint bounded. It
runs after every rolling deploy and daily at 04:17 UTC (`/etc/cron.d/octillion-cleanup`, installed by
`deploy/install-cleanup.sh`, log `/var/log/octillion-cleanup.log`). `--dry-run` shows what it would remove.

- **Old server images:** untagged images of the `octillion` compose project (each deploy leaves one, about 1 GB).
- **Build cache:** capped at `OCTILLION_BUILD_CACHE_KEEP` (5 GB), oldest first. Docker's cache is shared; it is only
  cache.
- **Local agent images** (`octillion/agent-*`, for the local Docker runner): removed when not at the version pinned in
  `harnesses/registry.json`. Rebuild with `orchestrator/images/build.sh`.
- **Test leftovers** in `/tmp` older than a day.
- **Container logs:** capped at 20 MB x 5 files per container (`x-logging` in the compose file). The cap applies when
  a container is recreated: the server on its next deploy, the database services at the next maintenance restart.
- **Disk guard:** above 90% the job logs a warning; above 95% it also removes every unused Octillion image.

It never touches volumes, running containers, or other projects' images and files. On 2026-10-14 the disk reached 99%
(about 30 GB of `/tmp` and 80 sandbox images belong to other projects). Removing local agent images and old build
cache brought it to 90%.

## Restoring the database

`rclone copy r2:<bucket>/postgres/<file> . && pg_restore -d octillion <file>` (see the `pg-backup-offsite` service).

## Tests

`npx tsx orchestrator/test/archive.ts`: PGlite plus a mock S3 API. It covers archiving, the layout, read-through with
paging, org scoping, restore (and re-running it), signed links and key safety.
