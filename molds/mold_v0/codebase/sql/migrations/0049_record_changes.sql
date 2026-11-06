-- A record's change history (mold_v0-256; src/record-history.ts, the only writer): each change of a workspace record
-- whose area's page lays out a history section (record_areas[].detail, a section with `history`), while the app's flag
-- record_pages is on (off, the default, nothing is written here at all). The data trail (0031) keeps who read and wrote
-- what but never a value; this keeps, for those areas only, what changed: each field's value before and after.
--
--   action    created, updated, moved (a lifecycle move) or deleted
--   by        "<kind>:<who>" of the writer, as workspace_records.updated_by (0042): people:<sign-in id>, staff:<pseudonym>,
--             run:<run id or the pack's tool>, intake:<message>, repository:<name>, shell:<what>; never a value
--   title     {before, after} when the record's title changed, else NULL
--   changes   [{field, before, after}] per field that changed; an encrypted field (0035) is [{field, redacted: true}]:
--             that it changed, never a value, sealed or open
--
-- Written in the change's own transaction (a write rolled back leaves no line). Append-only to the tenant role: it may
-- read and add its workspace's lines under row-level security, never change or remove one; a removed workspace's lines go
-- with it (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS record_changes (
  id       BIGSERIAL PRIMARY KEY,
  org_id   INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack     TEXT NOT NULL,
  area     TEXT NOT NULL,
  key      TEXT NOT NULL,
  action   TEXT NOT NULL CHECK (action IN ('created', 'updated', 'moved', 'deleted')),
  by       TEXT CHECK (length(by) <= 200),
  title    JSONB,
  changes  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A record's history, newest first, inside its workspace.
CREATE INDEX IF NOT EXISTS record_changes_record_idx ON record_changes (org_id, pack, area, key, id DESC);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE record_changes ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON record_changes;
  EXECUTE format('CREATE POLICY tenant_isolation ON record_changes TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON record_changes FROM %I', r);
  EXECUTE format('GRANT SELECT, INSERT ON record_changes TO %I', r);
  EXECUTE format('GRANT USAGE ON SEQUENCE record_changes_id_seq TO %I', r);
END $mig$;
