# Nightly backup of an app's Postgres into its own Vercel Blob store

Scoped deliberately to the one gap a managed provider leaves: Neon's free tier gives a short restore
window and no dump you own. Everything else (patching, TLS, HA, the daily operational chore) stays
with Neon, which is the reason the factory chose a managed provider at all.

`make-timer.sh <app_id>` generates, from the app's own state:

- `/etc/systemd/system/factory-backup@<app_id>.service` — one `pg_dump -Fc` of
  `datastores.postgres.admin_url_ref` (the DIRECT endpoint, never the pooled one, and never
  `DATABASE_URL`, which is `app_rw` and owns nothing), streamed straight into the app's Vercel Blob
  store under `backups/<app_id>/<date>.dump`.
- `/etc/systemd/system/factory-backup@<app_id>.timer` — daily, with a randomised delay.
- 7-day retention, applied by deleting blobs older than 7 days in the same run.

The blob store already exists — `provision_datastores` creates one per app and it is free — so this
adds no account, no credential and no cost. Secret values come from `vercel env pull` into a
0600 temp file that is deleted in a `finally`, exactly as provision.py does; nothing is written into
the repo.

Restore is `pg_restore --clean --if-exists` with the **admin** URL. `clone.py`'s `pg_url()` resolves
that chain (`SUPABASE_POSTGRES_URL_NON_POOLING` / `DATABASE_URL_UNPOOLED` / `POSTGRES_ADMIN_URL`,
then `DATABASE_URL` last) — restoring as `app_rw` fails with `must be owner of table orgs`.
