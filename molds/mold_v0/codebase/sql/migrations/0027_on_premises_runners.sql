-- On-premises runners (mold_v0-036; src/onprem-runners.ts, src/onprem-runner.ts, molds/mold_v0/MOLD.md "On-premises
-- runners"). A workspace whose runs must reach its own private network installs a small runner inside that network. The
-- runner connects out to the app only (no inbound port), enrolls once with a one-time token an owner of the workspace
-- created, and from then on asks for that workspace's runs and nothing else; each run is carried out in a run sandbox
-- of its own on the customer's machine, with the same lockdown as a hosted run. Platform bookkeeping: tenant work has
-- no access to these tables (the shell's own code reads and writes them, with the workspace taken from the caller's
-- session or from the runner's own row, never from input).
--
--   onprem_runners              one row per runner of a workspace: its name, the one-time enrollment token (only its
--                               sha256, cleared when used, with its expiry), the runner's own credential once enrolled
--                               (only its sha256), its state (pending, enrolled, revoked), and what it last said about
--                               itself (when, its version and host, how many runs it takes at once, its isolation, the
--                               private hosts and networks its owner allows its runs to reach)
--   workspace_runner_settings   where a workspace's runs that need its private network run: hosted (the default, also
--                               with no row) or on_premises (on one of its own enrolled runners)
--   runs.runner_location        where a run was routed when it was queued (hosted, or on_premises: claimed only by a
--                               sandbox one of its own workspace's runners launched)
--   run_sandboxes.onprem_runner_id   the runner that launched the sandbox (provider 'onprem'); the hosted run scaler
--                               never lists, counts or removes these

CREATE TABLE IF NOT EXISTS onprem_runners (
  id                TEXT PRIMARY KEY,                          -- rnr_<random>
  org_id            INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'enrolled', 'revoked')),
  enroll_token_hash TEXT,                                      -- sha256 of the one-time token; NULL once used or revoked
  enroll_expires_at TIMESTAMPTZ NOT NULL,
  secret_hash       TEXT,                                      -- sha256 of the runner's own credential (after enrolling)
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrolled_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_by        TEXT,
  last_seen_at      TIMESTAMPTZ,
  version           TEXT,
  hostname          TEXT,
  isolation         TEXT,
  capacity          INT,
  allow             JSONB NOT NULL DEFAULT '[]'                -- the private hosts and networks its runs may reach
);
CREATE INDEX IF NOT EXISTS onprem_runners_org_idx ON onprem_runners (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS onprem_runners_enroll_idx ON onprem_runners (enroll_token_hash) WHERE enroll_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onprem_runners_secret_idx ON onprem_runners (secret_hash) WHERE secret_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_runner_settings (
  org_id      INT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  location    TEXT NOT NULL DEFAULT 'hosted' CHECK (location IN ('hosted', 'on_premises')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A constant default: no table rewrite, and every existing run is a hosted one.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runner_location TEXT NOT NULL DEFAULT 'hosted';
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_runner_location_check') THEN
    ALTER TABLE runs ADD CONSTRAINT runs_runner_location_check CHECK (runner_location IN ('hosted', 'on_premises'));
  END IF;
END $mig$;
CREATE INDEX IF NOT EXISTS runs_onprem_queued_idx ON runs (org_id, created_at) WHERE status = 'queued' AND runner_location = 'on_premises';

ALTER TABLE run_sandboxes ADD COLUMN IF NOT EXISTS onprem_runner_id TEXT REFERENCES onprem_runners (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS run_sandboxes_onprem_idx ON run_sandboxes (onprem_runner_id) WHERE state <> 'deleted';

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['onprem_runners', 'workspace_runner_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
