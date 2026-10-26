-- Account context and memory (mold_v0-142; src/account-context.ts, molds/mold_v0/MOLD.md "Account context and memory"):
-- the shell's component any app turns on from pack.json `memory`. What an account says about itself (account_context,
-- set by its owners), what each person says about themselves (user_context) and the account's memory (context_memories:
-- short items about the company, one person or one subject, scope `product`), shown on /app/context and given to the
-- AI client at connect time. Fails closed like every tenant table: the tenant role reads and writes only the rows of
-- the workspace it acts for.
--
-- Adopted, never rebuilt (src/migrate.ts ADOPTING_MIGRATIONS). These three tables were a host pack's (and, before
-- mold_v0-049, the shell's own base schema's) under exactly these statements: each CREATE below is that DDL byte for
-- byte, and the security block gives them the same policies and grants that pack's row-level security migration gave
-- them. A database that already has all three, in exactly this shape, records this migration as adopted without running
-- it (schema_adoptions: what was adopted and the shape it had): no statement touches those tables or their rows. A
-- database with none of them runs it and gets them. Some but not all, or another shape: refused, nothing changed.

-- Context for the AI client (src/account-context.ts, /app/context): the company's, set by its owners, and each person's own.
CREATE TABLE IF NOT EXISTS account_context (
  org_id        INT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  about         TEXT,                          -- what the company does
  audience      TEXT,                          -- the developers it builds for
  competitors   JSONB NOT NULL DEFAULT '[]',   -- names to always track
  terms         TEXT,                          -- internal product names and jargon
  notes_for_ai  TEXT,
  updated_at    TIMESTAMPTZ,
  updated_by    TEXT
);
CREATE TABLE IF NOT EXISTS user_context (
  org_id        INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,                 -- WorkOS user
  title         TEXT,
  focus_product TEXT,                          -- product slug used when they do not name one
  interests     TEXT,
  answer_style  TEXT,                          -- brief | detailed | executive
  notes         TEXT,
  updated_at    TIMESTAMPTZ,
  PRIMARY KEY (org_id, user_id)
);

-- Memory (src/account-context.ts): short items people and their AI client add beside the core fields. Scope is the
-- company, one user (subject = their user id) or one subject (`product`: its key, or the name as written). Fed to the AI
-- client as background.
CREATE TABLE IF NOT EXISTS context_memories (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('company', 'user', 'product')),
  subject     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('fact', 'decision', 'preference', 'note')),
  body        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS context_memories_scope ON context_memories (org_id, scope, subject, created_at DESC);

-- Row-level security: the workspace policy on each, read and write for the tenant role, nextval for its inserts.
DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_context', 'user_context', 'context_memories'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
  END LOOP;
  EXECUTE format('GRANT USAGE ON SEQUENCE context_memories_id_seq TO %I', r);
END $mig$;
