-- The shell's base schema (mold_v0-049): workspaces (organizations) and their keys, orchestrators and the autoscaler,
-- the key vault and the inference gateway, model prices and usage, MCP activity, access requests, usage limits,
-- worker tokens, deletions, the admin access log, data keys, settings, harnesses, emails and docs answers.
--
-- Before mold_v0-049 this file was the product's whole schema (sql/schema.sql byte for byte, mold_v0-031): its own
-- tables (products, scenarios, simulations and their sessions, research, personas and tasks, populations, journeys,
-- context and memory, nudges, contributions, reports) left it for the host pack that owns them, whose migrations create
-- them (MOLD.md "Host packs": host.schema). A database that applied the earlier version of this file keeps them, with
-- their rows: src/migrate.ts accepts that version's checksum (SPLIT_MIGRATIONS) and the host pack adopts its own part.
-- Idempotent: every statement is IF NOT EXISTS or guarded, as when it ran on every boot.

CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'default',
  key_prefix   TEXT NOT NULL,                 -- first characters, safe to show
  key_hash     TEXT UNIQUE NOT NULL,          -- sha256 of the full key; the key itself is never stored
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
-- The person a key belongs to (a Clerk user id), when it was issued for one: their calls count as theirs in usage,
-- adoption and limits. Null = the account's key, shown as "Connector key".
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE TABLE IF NOT EXISTS access_requests (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  company      TEXT NOT NULL,
  product_url  TEXT,
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orchestrators (each runs up to OCTILLION_PODS_PER_ORCHESTRATOR warm pods); the server plans the global pod mix (src/fleet.ts).
CREATE TABLE IF NOT EXISTS orchestrators (
  id             TEXT PRIMARY KEY,
  capacity       INT NOT NULL,
  meta           JSONB NOT NULL DEFAULT '{}',
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- On-demand orchestrators (src/autoscaler.ts): every boat orchestrator sandbox the server launched, reconciled
-- against boat's own listing (name prefix octi-orch-) so nothing leaks across server restarts.
CREATE TABLE IF NOT EXISTS orchestrator_sandboxes (
  id               SERIAL PRIMARY KEY,
  sandbox_id       TEXT UNIQUE,
  orchestrator_id  TEXT,
  state            TEXT NOT NULL DEFAULT 'booting' CHECK (state IN ('booting', 'running', 'draining', 'deleted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at         TIMESTAMPTZ,
  last_seen        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  error            TEXT,
  from_image       TEXT,
  timings          JSONB
);
CREATE INDEX IF NOT EXISTS orchestrator_sandboxes_live_idx ON orchestrator_sandboxes (state) WHERE state <> 'deleted';
-- Recycle on deploy (src/fleet.ts): the code an orchestrator was launched with, and when it was first handed an
-- empty assignment. In the database, not in a server process, so every replica agrees.
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS retiring_since TIMESTAMPTZ;
-- One orchestrator per job (src/autoscaler.ts): the simulation (sim_...) or onboarding research (rsh_...) it serves,
-- and the worker sandboxes reserved for it on the boat plan. NULL job_id: a shared orchestrator (per-job mode off).
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS job_id TEXT;
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS pods INT;
-- Why an orchestrator ended, split out of the mixed `error` column (still written as before, for old readers):
-- the launch step that failed and its error, or the reason the autoscaler reaped it (src/error-classes.ts reads them).
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS launch_step TEXT;
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS launch_error TEXT;
ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS reap_reason TEXT;
-- Backfill rows written before the split. A launch failure reads "<step> (<n>s): <error>" and never got ready; any
-- other error was a reap reason. Both only touch rows not split yet, so a rerun at boot does nothing.
UPDATE orchestrator_sandboxes SET
  launch_step  = substring(error from '^(create|name|ready|code upload|configure|preflight|start) \(\d+s\):'),
  launch_error = substring(error from '^(?:create|name|ready|code upload|configure|preflight|start) \(\d+s\): ?(.*)$')
WHERE ready_at IS NULL AND launch_step IS NULL AND reap_reason IS NULL
  AND error ~ '^(create|name|ready|code upload|configure|preflight|start) \(\d+s\):';
UPDATE orchestrator_sandboxes SET reap_reason = error
WHERE error IS NOT NULL AND launch_step IS NULL AND reap_reason IS NULL;
CREATE INDEX IF NOT EXISTS orchestrator_sandboxes_job_idx ON orchestrator_sandboxes (job_id, created_at DESC) WHERE job_id IS NOT NULL;

-- Compute history the orchestrator rows do not keep (src/compute-events.ts): failed launches, reaps, and the sandboxes
-- the autoscaler deletes that have no row of their own (workers of a reaped orchestrator, orphans, stale image
-- builders), tick errors and admin cancels. Kept 90 days.
CREATE TABLE IF NOT EXISTS compute_events (
  id               BIGSERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind             TEXT NOT NULL CHECK (kind IN ('launch_failed', 'reaped', 'worker_deleted', 'orphan_deleted', 'image_builder_deleted', 'tick_error', 'admin_cancel')),
  sandbox_id       TEXT,
  orchestrator_id  TEXT,
  job_id           TEXT,
  session_id       TEXT,
  step             TEXT,
  reason           TEXT,
  actor            TEXT,
  trace_id         TEXT
);
CREATE INDEX IF NOT EXISTS compute_events_at_idx ON compute_events (at DESC);
CREATE INDEX IF NOT EXISTS compute_events_sandbox_idx ON compute_events (sandbox_id);

-- The autoscaler's history (src/autoscaler-ticks.ts): the leader writes a row for every tick that acted (launched,
-- reaped, or its note or error changed) and a sample row (acted = false) when the last row is a minute old. The
-- Compute page's Activity chart reads the samples, its Autoscaler decisions log the acting rows. Kept 14 days.
CREATE TABLE IF NOT EXISTS autoscaler_ticks (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  holder         TEXT,
  acted          BOOLEAN NOT NULL,
  queued         INT,
  running        INT,
  research       INT,
  unclaimable    INT,
  orchestrators  INT,
  desired        INT,
  cap            INT,
  active         INT,
  free           INT,
  demand         JSONB,
  jobs           JSONB,
  launched       JSONB NOT NULL DEFAULT '[]',
  reaped         JSONB NOT NULL DEFAULT '[]',
  note           TEXT,
  error          TEXT,
  trace_id       TEXT
);
CREATE INDEX IF NOT EXISTS autoscaler_ticks_at_idx ON autoscaler_ticks (at DESC);
CREATE INDEX IF NOT EXISTS autoscaler_ticks_acted_idx ON autoscaler_ticks (at DESC) WHERE acted;

-- Single-leader lease for the autoscaler across server replicas; `state` holds the leader's last tick for status.
CREATE TABLE IF NOT EXISTS autoscaler_lease (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  state       JSONB NOT NULL DEFAULT '{}'
);

-- Key vault + inference gateway (src/keyvault.ts, src/gateway.ts; docs/credentials.md).
-- Provider credentials are AES-256-GCM encrypted with OCTILLION_VAULT_KEY; only ciphertext is stored.
CREATE TABLE IF NOT EXISTS vault_providers (
  slug          TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('gateway', 'direct')),
  upstream_url  TEXT,                         -- gateway mode: where /gw/<slug>/... is forwarded
  auth_header   TEXT NOT NULL DEFAULT 'authorization',
  auth_prefix   TEXT NOT NULL DEFAULT 'Bearer ',
  env_vars      TEXT[] NOT NULL DEFAULT '{}', -- registry requires_env names this provider satisfies
  enabled       BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('anthropic',      'gateway', 'https://api.anthropic.com',                 'x-api-key',      '',        '{ANTHROPIC_API_KEY}'),
  ('openai',         'gateway', 'https://api.openai.com',                    'authorization',  'Bearer ', '{OPENAI_API_KEY,CODEX_API_KEY}'),
  ('google',         'gateway', 'https://generativelanguage.googleapis.com', 'x-goog-api-key', '',        '{GEMINI_API_KEY,GOOGLE_API_KEY}'),
  ('dashscope',      'gateway', 'https://dashscope-intl.aliyuncs.com',       'authorization',  'Bearer ', '{DASHSCOPE_API_KEY}'),
  ('github_copilot', 'direct',  NULL, 'authorization', 'Bearer ', '{COPILOT_GITHUB_TOKEN}'),
  ('cursor',         'direct',  NULL, 'authorization', 'Bearer ', '{CURSOR_API_KEY}'),
  ('amp',            'direct',  NULL, 'authorization', 'Bearer ', '{AMP_API_KEY}'),
  ('factory',        'direct',  NULL, 'authorization', 'Bearer ', '{FACTORY_API_KEY}'),
  ('boat',           'direct',  'https://boat.dev/api/v1', 'authorization', 'Bearer ', '{BOAT_API_KEY}')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS vault_credentials (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL REFERENCES vault_providers(slug) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'default',
  ciphertext    TEXT NOT NULL,                -- base64
  iv            TEXT NOT NULL,
  tag           TEXT NOT NULL,
  key_id        TEXT NOT NULL,                -- which master key encrypted it (rotation)
  hint          TEXT NOT NULL,                -- e.g. "sk-ant…9xQ2", safe to display
  priority      INT NOT NULL DEFAULT 0,       -- higher first; equal priorities rotate
  enabled       BOOLEAN NOT NULL DEFAULT true,
  uses          BIGINT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  UNIQUE (provider, label)
);

CREATE TABLE IF NOT EXISTS gateway_tokens (
  token_hash       TEXT PRIMARY KEY,          -- sha256 of ogw_...; the token itself is never stored
  kind             TEXT NOT NULL CHECK (kind IN ('session', 'orchestrator')),
  session_id       TEXT,                      -- a session token's session (the host pack's sessions table, mold_v0-049)
  orchestrator_id  TEXT,
  providers        TEXT[] NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_tokens_session_idx ON gateway_tokens (session_id);

CREATE TABLE IF NOT EXISTS gateway_usage (
  token_hash     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  session_id     TEXT,
  orchestrator_id TEXT,
  requests       INT NOT NULL DEFAULT 0,
  errors         INT NOT NULL DEFAULT 0,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  bytes          BIGINT NOT NULL DEFAULT 0,
  last_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_hash, provider)
);
-- Priced per request at record time (long-context tiers apply per request, not to a session's summed input).
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS gateway_usage_orch_idx          ON gateway_usage (orchestrator_id) WHERE orchestrator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_session_idx       ON gateway_usage (session_id) WHERE session_id IS NOT NULL;

-- Gateway backends: 'direct' forwards to upstream_url; 'vertex' rewrites Anthropic Messages calls to Google Cloud Vertex AI
-- (backend_config: {project_id, region ('global' | 'us' | 'eu' | a region), model_map?}); the credential is a service-account JSON key.
ALTER TABLE vault_providers ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'direct' CHECK (backend IN ('direct', 'vertex'));
ALTER TABLE vault_providers ADD COLUMN IF NOT EXISTS backend_config JSONB NOT NULL DEFAULT '{}';

-- Per-model inference usage and cost (src/usage.ts): every gateway request is attributed to the model the provider
-- reports, per day and consumer (orchestrator brain vs agent sessions), priced from model_prices at request time.
CREATE TABLE IF NOT EXISTS model_prices (
  model                        TEXT PRIMARY KEY,
  input_per_mtok               NUMERIC(10, 4) NOT NULL,
  cached_input_per_mtok        NUMERIC(10, 4) NOT NULL,
  output_per_mtok              NUMERIC(10, 4) NOT NULL,
  long_context_threshold       INT,                  -- input tokens above which the long-context prices apply
  long_input_per_mtok          NUMERIC(10, 4),
  long_cached_input_per_mtok   NUMERIC(10, 4),
  long_output_per_mtok         NUMERIC(10, 4),
  source                       TEXT NOT NULL DEFAULT '',
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, long_context_threshold,
                          long_input_per_mtok, long_cached_input_per_mtok, long_output_per_mtok, source) VALUES
  ('gpt-6.1-sol',       2.00, 0.10, 10.00, 272000, 4.00, 0.20, 15.00, 'OpenAI API pricing, standard tier, 2026-10-10'),
  ('gpt-4.1-nano',      0.10, 0.025, 0.40, NULL, NULL, NULL, NULL,   'OpenAI API pricing, standard tier, 2026-10-10'),
  ('claude-opus-5-5',   4.00, 0.20, 20.00, NULL, NULL, NULL, NULL,   'Anthropic list price; Vertex global billed by Google, verify on the GCP invoice'),
  ('claude-sonnet-5-5', 2.00, 0.20, 10.00, NULL, NULL, NULL, NULL,   'Anthropic list price; Vertex global billed by Google, verify on the GCP invoice')
ON CONFLICT (model) DO NOTHING;

CREATE TABLE IF NOT EXISTS gateway_model_usage (
  day                  DATE NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  consumer             TEXT NOT NULL CHECK (consumer IN ('session', 'orchestrator')),
  requests             INT NOT NULL DEFAULT 0,
  errors               INT NOT NULL DEFAULT 0,
  input_tokens         BIGINT NOT NULL DEFAULT 0,   -- all input, cached included
  cached_input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens        BIGINT NOT NULL DEFAULT 0,
  cost_usd             NUMERIC(14, 6) NOT NULL DEFAULT 0,
  priced               BOOLEAN NOT NULL DEFAULT true,  -- false when a request's model had no price
  PRIMARY KEY (day, provider, model, consumer)
);

CREATE TABLE IF NOT EXISTS usage_alerts (
  day    DATE NOT NULL,
  model  TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, model)
);

-- Cloudflare Workers AI (open models for OpenCode). Disabled until configured with the account's upstream:
--   npm run keyvault -- provider cloudflare --upstream https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai --enable
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled)
VALUES ('cloudflare', 'gateway', NULL, 'authorization', 'Bearer ', '{CLOUDFLARE_API_TOKEN}', false)
ON CONFLICT (slug) DO NOTHING;

-- Cloudflare Workers AI open models (per-model pages, 2026-10-10).
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('@cf/moonshotai/kimi-k2.7-code',        0.95, 0.19,  4.00, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/zai-org/glm-5.3',                  1.40, 0.26,  4.40, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/deepseek-ai/deepseek-v4-pro-0813', 1.32, 0.044, 3.96, 'Cloudflare Workers AI pricing, 2026-10-10'),
  ('@cf/openai/gpt-oss-120b',              0.35, 0.35,  0.75, 'Cloudflare Workers AI pricing, 2026-10-10 (no cached rate listed)')
ON CONFLICT (model) DO NOTHING;
-- GLM 5.3 Flash: the research quick pass and loss reasons (src/reasons.ts) call it server-side (2026-10-20).
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('@cf/zai-org/glm-5.3-flash',            0.15, 0.03,  0.50, 'Cloudflare Workers AI pricing, 2026-10-20')
ON CONFLICT (model) DO NOTHING;
-- Its calls recorded before it had a row were priced as @cf/zai-org/glm-5.3 (the name-prefix fallback in src/usage.ts,
-- now limited to dated releases), about 9x too much: repriced from their stored tokens (input includes cached). Only
-- rows whose cost differs change, so a rerun at boot changes nothing.
UPDATE gateway_model_usage SET priced = true,
       cost_usd = round(((input_tokens - cached_input_tokens) * 0.15 + cached_input_tokens * 0.03 + output_tokens * 0.50) / 1000000.0, 6)
 WHERE model = '@cf/zai-org/glm-5.3-flash'
   AND cost_usd IS DISTINCT FROM round(((input_tokens - cached_input_tokens) * 0.15 + cached_input_tokens * 0.03 + output_tokens * 0.50) / 1000000.0, 6);
-- The rest of the registry's gateway models (2026-10-18). Cursor, Copilot and Amp (auto/default) bill on their own
-- subscriptions and never pass the gateway, so they have no row.
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('gpt-6-sol',        2.00, 0.20, 10.00, 'OpenAI GPT-6 Sol standard tier, 2026-10-18'),
  ('gemini-4-argon',   4.00, 0.20, 20.00, 'Google Gemini 4 Argon list price after the $2/$10 launch promo (ends 2026-11-30), 2026-10-18'),
  ('qwen3-coder-plus', 1.00, 1.00,  5.00, 'Alibaba Model Studio base tier, no cached rate published, 2026-10-18')
ON CONFLICT (model) DO NOTHING;

-- Per-organization MCP activity (src/analytics.ts): connector methods and tool calls with outcome and latency.
-- Tool arguments and results are never stored.
CREATE TABLE IF NOT EXISTS mcp_events (
  id      BIGSERIAL PRIMARY KEY,
  org_id  INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  method  TEXT NOT NULL,                     -- initialize, tools/list, tools/call, prompts/get, resources/read, ...
  name    TEXT,                              -- tool or prompt name, or resource URI
  client  TEXT,                              -- clientInfo on initialize, else the User-Agent
  ok      BOOLEAN NOT NULL DEFAULT true,
  error   TEXT,
  ms      INT
);
CREATE INDEX IF NOT EXISTS mcp_events_org_idx ON mcp_events (org_id, at DESC);

-- Onboarding (src/admin.ts, /admin). People live in WorkOS and money in Stripe; these are only the joins to them,
-- plus the triage state of a landing-page request.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS workos_org_id TEXT UNIQUE;       -- WorkOS organization (users, invites, SSO)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;  -- Stripe customer (plan, invoices); also on the WorkOS org
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'approved', 'declined'));
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
-- More of what the person told us, where they came from, and the AI's background research on the company (src/prospect.ts).
-- Prepaid plans are invite-only (src/billing.ts): an admin allows an account to subscribe, or sets its monthly
-- allowance by hand (your own account, trials, comps). Without either the account's allowance is $0: no runs.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS prepaid_allowed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS budget_override_usd NUMERIC;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS team_size TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS agents TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS docs_url TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS competitors TEXT;          -- who they lose to, in their words
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS goal TEXT;                 -- baseline, competitor, docs, monitor, other
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS timeline TEXT;             -- now, month, quarter, exploring
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS heard_from TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS subindustry TEXT;          -- the kind of developer tool they sell
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS source JSONB;                -- referrer, utm_*, landing page, country
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS research JSONB;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS research_status TEXT CHECK (research_status IN ('running', 'done', 'failed'));
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS research_error TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS user_id TEXT;           -- the WorkOS user when signed in (null for API keys)
CREATE INDEX IF NOT EXISTS mcp_events_user_idx ON mcp_events (org_id, user_id, at DESC);

-- Usage limits inside an account (src/limits.ts): how its admins split the plan's budget, who may launch runs,
-- and how much each person may run at once. Set on /app Limits; the budget itself comes from the Stripe plan.
CREATE TABLE IF NOT EXISTS usage_policies (
  org_id                INT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL DEFAULT 'pool' CHECK (mode IN ('pool', 'even', 'custom')),
  reserve_usd           NUMERIC NOT NULL DEFAULT 0,     -- the buffer: set aside in every mode, nobody can launch into it
  default_cap_usd       NUMERIC,                         -- custom mode (required there): for people without their own limit
  new_members_can_run   BOOLEAN NOT NULL DEFAULT true,   -- rollout: may people launch simulations unless set per person
  max_concurrent_runs   INT,                             -- per person, unless set per team or person
  max_sessions_per_run  INT,                             -- per launch, under the server's own limit
  updated_at            TIMESTAMPTZ,
  updated_by            TEXT
);
-- The most one simulation may spend (live): adaptive runs stop adding sessions once a run reaches it. Null: no limit.
ALTER TABLE usage_policies ADD COLUMN IF NOT EXISTS max_run_usd NUMERIC;
CREATE TABLE IF NOT EXISTS usage_teams (
  id                    SERIAL PRIMARY KEY,
  org_id                INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  budget_usd            NUMERIC,                         -- set aside for the team in every mode; a hard cap on its combined spend
  max_concurrent_runs   INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS usage_members (
  org_id                INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,                   -- WorkOS user
  team_id               INT REFERENCES usage_teams(id) ON DELETE SET NULL,
  cap_usd               NUMERIC,                         -- this person's own monthly limit, in every mode
  adjust_usd            NUMERIC NOT NULL DEFAULT 0,      -- even mode: plus or minus the even share
  can_run               BOOLEAN,                         -- null: the account's default
  max_concurrent_runs   INT,
  PRIMARY KEY (org_id, user_id)
);
-- Budget rules history (src/limits.ts): one plain sentence per change, from every limits endpoint and from the
-- one-time migrations below (actor null: "System"). before/after hold the changed rows, for support; no undo.
CREATE TABLE IF NOT EXISTS usage_rule_changes (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT,                                -- who: the session's label ("customer:<email>"); null: Octillion
  actor_user  TEXT,                                -- their user id, so the page shows their current name
  summary     TEXT NOT NULL,                       -- "Buffer $0 → $50; Platform budget $80 → $100"
  before      JSONB,
  after       JSONB
);
CREATE INDEX IF NOT EXISTS usage_rule_changes_org_idx ON usage_rule_changes (org_id, id DESC);   -- newest first, paged by id
-- Runs at once and sessions per run no longer accept 0 (it blocked every launch without saying so; "can launch" is the
-- way to stop launches). Existing zeros keep their effect: whoever a 0 applied to can't launch, and the count is
-- cleared. All the can_run changes are made before any count is cleared. Runs on every boot; a no-op once no 0 is left.
INSERT INTO usage_rule_changes (org_id, summary)                                      -- logged first, while the 0s are there
SELECT o.id, 'Limits of 0 runs at once or 0 sessions per run now read as "can''t launch" for the people they applied to, and were cleared'
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM usage_policies p WHERE p.org_id = o.id AND (p.max_concurrent_runs = 0 OR p.max_sessions_per_run = 0))
    OR EXISTS (SELECT 1 FROM usage_teams t WHERE t.org_id = o.id AND t.max_concurrent_runs = 0)
    OR EXISTS (SELECT 1 FROM usage_members m WHERE m.org_id = o.id AND m.max_concurrent_runs = 0);
UPDATE usage_members m SET can_run = false                                            -- a person's own 0
 WHERE m.max_concurrent_runs = 0;
UPDATE usage_members m SET can_run = false                                            -- their team's 0, no own count
 WHERE m.max_concurrent_runs IS NULL AND can_run IS DISTINCT FROM false
   AND EXISTS (SELECT 1 FROM usage_teams t WHERE t.id = m.team_id AND t.max_concurrent_runs = 0);
UPDATE usage_members m SET can_run = false                                            -- the account's 0
 WHERE can_run IS DISTINCT FROM false AND EXISTS (SELECT 1 FROM usage_policies p WHERE p.org_id = m.org_id AND (p.max_sessions_per_run = 0
   OR (p.max_concurrent_runs = 0 AND m.max_concurrent_runs IS NULL
       AND NOT EXISTS (SELECT 1 FROM usage_teams t WHERE t.id = m.team_id AND t.max_concurrent_runs IS NOT NULL))));
UPDATE usage_members m SET can_run = true                                             -- the account's 0 didn't reach them:
 WHERE can_run IS NULL AND EXISTS (SELECT 1 FROM usage_policies p WHERE p.org_id = m.org_id    -- keep them launching
   AND p.new_members_can_run AND p.max_concurrent_runs = 0 AND p.max_sessions_per_run IS DISTINCT FROM 0);
UPDATE usage_policies SET new_members_can_run = false                                 -- and for everyone without a row
 WHERE max_sessions_per_run = 0 OR max_concurrent_runs = 0;
UPDATE usage_members  SET max_concurrent_runs = NULL WHERE max_concurrent_runs = 0;
UPDATE usage_teams    SET max_concurrent_runs = NULL WHERE max_concurrent_runs = 0;
UPDATE usage_policies SET max_concurrent_runs = NULL WHERE max_concurrent_runs = 0;
UPDATE usage_policies SET max_sessions_per_run = NULL WHERE max_sessions_per_run = 0;
-- One-time changes to what the budget rules mean (docs/budget-rules-spec.md, section 7), each applied once and recorded
-- here, since what they clear means something afterwards. A fresh database records them with nothing to change.
CREATE TABLE IF NOT EXISTS usage_rule_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
-- A: a person's own limit (cap_usd) now applies in every mode. Outside custom mode it was never applied, so it is
-- cleared (no change in effect). Custom with no default cap is the shared pool with own limits, so it becomes pool.
INSERT INTO usage_rule_changes (org_id, summary)
SELECT DISTINCT m.org_id, 'Cleared unused personal limits (they only applied with custom caps; now they apply in every mode)'
  FROM usage_members m
 WHERE cap_usd IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'own_limit_every_mode')
   AND NOT EXISTS (SELECT 1 FROM usage_policies p WHERE p.org_id = m.org_id AND p.mode = 'custom');
INSERT INTO usage_rule_changes (org_id, summary)
SELECT org_id, 'How budgets are shared: Custom caps with no default cap → Shared pool (own limits kept, same effect)'
  FROM usage_policies
 WHERE mode = 'custom' AND default_cap_usd IS NULL AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'own_limit_every_mode');
UPDATE usage_members m SET cap_usd = NULL
 WHERE cap_usd IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'own_limit_every_mode')
   AND NOT EXISTS (SELECT 1 FROM usage_policies p WHERE p.org_id = m.org_id AND p.mode = 'custom');
UPDATE usage_policies SET mode = 'pool'
 WHERE mode = 'custom' AND default_cap_usd IS NULL AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'own_limit_every_mode');
-- B: the buffer and team budgets are set aside in every mode (on for every account; no opt-in). The buffer was only
-- applied in even mode, so elsewhere it is cleared (no change in effect). Team budgets keep their amounts and now also
-- take their share out of what everyone else can spend.
INSERT INTO usage_rule_changes (org_id, summary)
SELECT org_id, 'Cleared the unused buffer (it only applied with an even split; now it applies in every mode)'
  FROM usage_policies
 WHERE mode <> 'even' AND reserve_usd <> 0 AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'set_aside_every_mode');
UPDATE usage_policies SET reserve_usd = 0
 WHERE mode <> 'even' AND reserve_usd <> 0 AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'set_aside_every_mode');
-- C: an equal share is split only between people who can launch. Logged for accounts it changes shares for: even
-- mode, with someone who can't launch (their own setting, or new members can't by default).
INSERT INTO usage_rule_changes (org_id, summary)
SELECT p.org_id, 'Equal shares now count only people who can launch, so shares went up for the people who can'
  FROM usage_policies p
 WHERE p.mode = 'even' AND NOT EXISTS (SELECT 1 FROM usage_rule_migrations WHERE name = 'share_counts_launchers')
   AND (NOT p.new_members_can_run OR EXISTS (SELECT 1 FROM usage_members m WHERE m.org_id = p.org_id AND m.can_run = false));
INSERT INTO usage_rule_migrations (name) VALUES ('own_limit_every_mode'), ('set_aside_every_mode'), ('share_counts_launchers') ON CONFLICT (name) DO NOTHING;

-- Clerk replaced WorkOS for people (src/clerk.ts): the join to a Clerk organization. workos_org_id is no longer used.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS clerk_org_id TEXT UNIQUE;

-- Per-job worker tokens (src/workerauth.ts): an autoscaled per-job orchestrator gets a token bound to its one job and
-- organization instead of the fleet-wide OCTILLION_WORKER_TOKEN. Hash only; revoked when its sandbox is deleted.
CREATE TABLE IF NOT EXISTS worker_tokens (
  token_hash      TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,                -- sim_... or rsh_...
  org_id          INT REFERENCES organizations(id) ON DELETE CASCADE,
  sandbox_row_id  INT,                          -- orchestrator_sandboxes.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS worker_tokens_sandbox_idx ON worker_tokens (sandbox_row_id) WHERE revoked_at IS NULL;

-- Deleted organizations (src/tenancy.ts): counts only, no names or content.
CREATE TABLE IF NOT EXISTS org_deletions (
  org_id      INT PRIMARY KEY,
  counts      JSONB NOT NULL DEFAULT '{}',
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Staff access to the admin API (docs/security.md): who, what, when. No request bodies (they can hold secrets).
CREATE TABLE IF NOT EXISTS admin_access_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT NOT NULL,                        -- x-octillion-actor header (staff name), else 'admin-token'
  method  TEXT NOT NULL,
  path    TEXT NOT NULL,
  status  INT,
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS admin_access_log_at_idx ON admin_access_log (at DESC);

-- Per-organization data keys for private text at rest (src/orgcrypto.ts), wrapped by the vault master key.
-- Deleting the organization deletes its key (crypto-shredding of its private personas and tasks).
CREATE TABLE IF NOT EXISTS org_keys (
  org_id      INT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  wrapped     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Web and package search for onboarding research (src/websearch.ts). Orchestrator-only keys: no env_vars, so they are
-- never matched to an agent session (gateway/broker look providers up by env_vars) and stay on the server.
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('exa',          'direct', 'https://api.exa.ai',      'x-api-key', '', '{}'),
  ('libraries_io', 'direct', 'https://libraries.io/api', 'api_key',   '', '{}')
ON CONFLICT (slug) DO NOTHING;

-- Global settings edited on /admin/compute (src/settings.ts): models, run sizes, capacity, research limits. A row here
-- wins over the environment variable of the same name, which wins over the code default. No row: not set here.
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,               -- the environment variable it overrides, e.g. OCTILLION_MAX_SAMPLES
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- Harnesses added on /admin/agents (src/harnesses.ts): each a variant of a CLI that harnesses/registry.json supports.
-- registry() merges them after the file's entries (an id here never shadows a file id) and inherits the CLI spec
-- (install script, headless command, event format, adapter, requires_env for the model's route) from a file entry
-- of the same harness. They join the default population only when the admin gives them a weight.
CREATE TABLE IF NOT EXISTS platform_harnesses (
  id               TEXT PRIMARY KEY,          -- <harness>/<slug>, e.g. opencode/cf-qwen3-coder
  harness          TEXT NOT NULL,             -- base CLI: a harness id of registry.json
  model            TEXT NOT NULL,
  label            TEXT NOT NULL,
  harness_version  TEXT,                      -- NULL: the base entry's pin
  notes            TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT
);

-- Vertex AI as its own vault provider (src/keyvault.ts VERTEX_PROVIDER): Google Cloud service-account JSON keys that
-- Claude (and Gemini) on Vertex sign in with. Orchestrator-only (no env_vars): the key never reaches an agent session.
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('vertex', 'direct', 'https://aiplatform.googleapis.com', 'authorization', 'Bearer ', '{}')
ON CONFLICT (slug) DO NOTHING;
-- What a key is, beyond its hint (service-account keys: {project_id, client_email}; never key material).
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS meta JSONB;

-- Provider keys once read from server environment variables, imported into the vault once (src/keyvault-env.ts).
-- One row per provider: after it the environment is never read for that provider again, and the import never
-- overwrites a key already in the vault.
CREATE TABLE IF NOT EXISTS vault_env_imports (
  provider       TEXT PRIMARY KEY,
  env_var        TEXT NOT NULL,                -- the variable it came from (the name only)
  outcome        TEXT NOT NULL DEFAULT 'pending', -- pending | imported | vault_had_key
  hint           TEXT,
  credential_id  INT,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactional email through Resend (src/email.ts). The key is a vault provider like any other: orchestrator/server
-- only (no env_vars), so it never reaches an agent session.
INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('resend', 'direct', 'https://api.resend.com', 'authorization', 'Bearer ', '{}')
ON CONFLICT (slug) DO NOTHING;
-- Stripe's key is a server environment variable (STRIPE_SECRET_KEY, src/billing.ts), not a vault provider: drop the
-- provider row a short-lived build added, while it holds no key.
DELETE FROM vault_providers WHERE slug = 'stripe' AND NOT EXISTS (SELECT 1 FROM vault_credentials WHERE provider = 'stripe');
-- Pricing experiments (src/experiments.ts): the first time an account's Billing page showed it a variant of an
-- experiment. Experiments, variants, checkouts and conversions are Stripe's (price, session and subscription
-- metadata); only the exposure, which Stripe never sees, is kept here. One row per account and experiment (sticky).
CREATE TABLE IF NOT EXISTS plan_exposures (
  org_id        INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment    TEXT NOT NULL,
  price_id      TEXT NOT NULL,
  plan_name     TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, experiment)
);
-- Every email Octillion tried to send: one row per message (recipient and purpose), whatever became of it. Never the
-- address itself (a hash to match on, and the domain), never the body. The idempotency key names the message
-- ("request:12:received", "budget:7:2026-10:80:<hash>"), so a retry or a second trigger never sends it twice; a
-- failed or skipped one is tried again when it is triggered again.
CREATE TABLE IF NOT EXISTS email_log (
  id               BIGSERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),      -- the last attempt
  kind             TEXT NOT NULL,                           -- request_received, request_alert, budget_80, test, ...
  to_hash          TEXT NOT NULL,                           -- sha256 of the lowercased address
  to_domain        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'skipped', 'failed')),
  provider_id      TEXT,                                    -- Resend's email id
  error            TEXT,                                    -- why it failed or was skipped
  attempts         INT NOT NULL DEFAULT 1,
  meta             JSONB NOT NULL DEFAULT '{}',             -- ids it is about (request, submission, account); no addresses
  idempotency_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS email_log_at_idx ON email_log (at DESC);
-- Why a request was declined, when the reviewer says (it goes in the email to the requester).
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- "Ask AI" answers from the docs (src/docs-answers.ts): one row per model call, for the daily cap
-- (DOCS_ANSWERS_DAILY_MAX) and the per-person minute limit (DOCS_ANSWERS_PER_MINUTE). Never the question text.
CREATE TABLE IF NOT EXISTS docs_answers (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  area      TEXT NOT NULL,                  -- customer (/api/app) | admin (/api/admin)
  user_key  TEXT NOT NULL,                  -- who asked: the Clerk user id, or the admin's address
  org_id    INT REFERENCES organizations(id) ON DELETE SET NULL, -- the account they asked from (customer area)
  sources   INT NOT NULL DEFAULT 0,         -- sections sent to the model
  model     TEXT,                           -- the model that answered; NULL when none did
  answered  BOOLEAN
);
CREATE INDEX IF NOT EXISTS docs_answers_at ON docs_answers (at);
CREATE INDEX IF NOT EXISTS docs_answers_user ON docs_answers (user_key, at);
