-- The fixture's one table: a workspace table, secured by the shell's helper (row-level security for the tenant role).
CREATE TABLE fixture_notes_notes (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fixture_notes_notes_org ON fixture_notes_notes (org_id, created_at DESC);
SELECT shell_pack_tenant_table('fixture_notes_notes');
