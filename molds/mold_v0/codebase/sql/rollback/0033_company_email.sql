-- Rolling back past 0033_company_email (mold_v0-192), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0033_company_email.sql
-- Refused, changing nothing, while any workspace has a sender or a mailbox configured, or the intake's ledger holds a
-- message: an older release would quietly send through the app's own sender instead, and the ledger is what keeps a
-- message from being taken in twice (and where its attachments are). The workspaces' owners remove their senders and
-- mailboxes on Settings › Email first; the records the intake made stay in their areas either way. Otherwise the three
-- tables go, and the ledger row. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'company_email');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'company_email is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (company_email): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT (SELECT count(*) FROM workspace_email_senders) + (SELECT count(*) FROM workspace_email_inboxes) + (SELECT count(*) FROM workspace_email_messages) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '% company email row(s) are in use (senders, mailboxes, messages taken in): not dropped', n;
  END IF;
  DROP TABLE IF EXISTS workspace_email_messages, workspace_email_inboxes, workspace_email_senders;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
