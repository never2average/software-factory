-- Octillion schema. Idempotent: every statement is IF NOT EXISTS, so it runs on every boot.
--
--   organizations / api_keys     dev-tool companies (tenants) and the keys their MCP connectors use
--   products                     product context a company configures: names, packages, competitors
--   scenarios                    real-world coding tasks where the product should (or should not) come up
--   simulations                  one launch: scenarios x models x repeats
--   agent_sessions               one sandboxed sub-agent working one scenario; doubles as the worker job queue
--                                and carries the scored verdict
--   transcript_events            raw JSONL events, only when ClickHouse is not configured (local dev fallback)
--   access_requests              landing-page sign-ups

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

CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  website_url   TEXT,
  docs_url      TEXT,
  -- How the product shows up in agent output; all matched case-insensitively.
  aliases       TEXT[] NOT NULL DEFAULT '{}',  -- other names, e.g. "Neon Postgres"
  packages      TEXT[] NOT NULL DEFAULT '{}',  -- npm/PyPI/crate/module names, e.g. "@neondatabase/serverless"
  domains       TEXT[] NOT NULL DEFAULT '{}',  -- e.g. "neon.tech"
  competitors   JSONB NOT NULL DEFAULT '[]',   -- [{name, aliases[], packages[], domains[]}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id           SERIAL PRIMARY KEY,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  prompt       TEXT NOT NULL,                 -- the task given to the sub-agent, verbatim; never names the customer
  repo_url     TEXT,                          -- optional starter repo cloned into the sandbox
  language     TEXT,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  expectation  TEXT NOT NULL DEFAULT 'recommend' CHECK (expectation IN ('recommend', 'avoid')),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_product_idx ON scenarios (product_id);

CREATE TABLE IF NOT EXISTS simulations (
  id           TEXT PRIMARY KEY,              -- sim_<random>
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  models       TEXT[] NOT NULL,
  harness      TEXT NOT NULL,
  repeats      INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'completed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS simulations_product_idx ON simulations (product_id, created_at DESC);
-- Adaptive sampling (src/queries.ts extendAdaptive): the per-task session cap (NULL = fixed-size run) and the last
-- decision per task ({scenario_id: {attempts, scored, hits, margin, status}}).
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS max_samples INT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS sampling JSONB;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id              TEXT PRIMARY KEY,           -- ses_<random>
  simulation_id   TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scenario_id     INT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  harness         TEXT NOT NULL,
  attempt         INT NOT NULL DEFAULT 1,     -- repeat number within the simulation
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timeout', 'cancelled')),
  worker_id       TEXT,
  sandbox_id      TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  tokens_in       BIGINT NOT NULL DEFAULT 0,
  tokens_out      BIGINT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12, 4) NOT NULL DEFAULT 0,
  error_message   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  events          INT NOT NULL DEFAULT 0,     -- transcript events received
  -- Scoring, filled when the session finishes (see src/scoring.ts).
  verdict         TEXT CHECK (verdict IN ('adopted', 'recommended', 'mentioned', 'competitor', 'none')),
  winner          TEXT,                       -- tool the agent went with (target or competitor name), if any
  mentions        JSONB,                      -- [{tool, target, level, first_seq, evidence: [{seq, kind, snippet}]}]
  scored_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_sessions_queue_idx ON agent_sessions (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS agent_sessions_sim_idx ON agent_sessions (simulation_id);
CREATE INDEX IF NOT EXISTS agent_sessions_product_idx ON agent_sessions (product_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS transcript_events (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  type        TEXT NOT NULL,
  text        TEXT NOT NULL,
  raw         JSONB NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  company      TEXT NOT NULL,
  product_url  TEXT,
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Developer profiles and the task library, synced from the vault (`npm run vault:sync`, src/vault.ts).
-- A profile is who the orchestrator role-plays when a sub-agent asks a question; it never names a customer product.
CREATE TABLE IF NOT EXISTS developer_profiles (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  external_id   TEXT,                         -- id in the vault
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  attributes    JSONB NOT NULL DEFAULT '{}',  -- role, experience, company_size, stack, constraints, tone, ...
  instructions  TEXT NOT NULL DEFAULT '',     -- how this developer answers the agent's questions
  active        BOOLEAN NOT NULL DEFAULT true,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_tasks (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  external_id   TEXT,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  repo_url      TEXT,
  language      TEXT,
  category      TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  attributes    JSONB NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE scenarios      ADD COLUMN IF NOT EXISTS library_task_id INT REFERENCES library_tasks(id) ON DELETE SET NULL;
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS profile_ids INT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS profile_id INT REFERENCES developer_profiles(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS user_turns INT NOT NULL DEFAULT 0;  -- questions answered by the simulated developer

-- Worker agents (harnesses/registry.json): which agent ran each session, and how a simulation picked them.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;              -- registry id, e.g. claude-code/sonnet
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'explicit';  -- representative | explicit
ALTER TABLE simulations    ADD COLUMN IF NOT EXISTS agent_ids TEXT[] NOT NULL DEFAULT '{}';

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
  session_id       TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
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

-- The Compute page's tables (src/compute-records.ts, src/compute.ts): sessions by status and when they ended, by agent,
-- by start (wait times, our boat starts), and gateway spend per orchestrator and per session.
CREATE INDEX IF NOT EXISTS agent_sessions_status_ended_idx ON agent_sessions (status, ended_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_agent_status_idx ON agent_sessions (agent_id, status);
CREATE INDEX IF NOT EXISTS agent_sessions_started_idx      ON agent_sessions (started_at DESC) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_orch_idx          ON gateway_usage (orchestrator_id) WHERE orchestrator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_session_idx       ON gateway_usage (session_id) WHERE session_id IS NOT NULL;

-- Developer populations: the coding-agent (harness x model) mix a simulation should represent, e.g. the global
-- developer population or an enterprise subset. Agent definitions (images, adapters) stay in harnesses/registry.json;
-- the mix lives here. The default population is seeded from the registry's cited weights on first boot.
CREATE TABLE IF NOT EXISTS developer_populations (
  id                   SERIAL PRIMARY KEY,
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  as_of                DATE,
  methodology          TEXT NOT NULL DEFAULT '',
  sources              JSONB NOT NULL DEFAULT '[]',
  unrepresented_share  REAL,                    -- usage in tools that cannot run headless
  sandbox_unit         INT NOT NULL DEFAULT 20 CHECK (sandbox_unit > 0),
  min_one_sandbox      BOOLEAN NOT NULL DEFAULT false,
  is_default           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS developer_populations_one_default ON developer_populations (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS developer_population_agents (
  population_id  INT NOT NULL REFERENCES developer_populations(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,               -- registry agent id, e.g. claude-code/opus
  market_share   REAL NOT NULL CHECK (market_share >= 0),  -- share of this population's agentic coding usage
  paused         BOOLEAN NOT NULL DEFAULT false,
  paused_reason  TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (population_id, agent_id)
);

ALTER TABLE simulations ADD COLUMN IF NOT EXISTS population_id INT REFERENCES developer_populations(id) ON DELETE SET NULL;

-- Product onboarding (docs/onboarding.md): prompt + link + docs -> orchestrator research -> profile, personas, problems.
ALTER TABLE products  ADD COLUMN IF NOT EXISTS prompt   TEXT;              -- what the customer said the product is
ALTER TABLE products  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]';
ALTER TABLE products  ADD COLUMN IF NOT EXISTS research JSONB;            -- sources and notes from the last research
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS source    TEXT NOT NULL DEFAULT 'manual';  -- manual | library | generated
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS rationale TEXT;            -- why the product fits (or should not)
-- Starter workspace for scenarios without repo_url (orchestrator/workspaces/<template>); NULL = picked from language/tags/prompt.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS template TEXT;
-- Superseded by developer_profiles.environment (the persona's tools, installed into the harness).
ALTER TABLE scenarios DROP COLUMN IF EXISTS developer_context;
-- The persona's developer environment (orchestrator/core/environment.ts): {editor, tools: [catalog ids]}. Each session
-- installs the editor's language servers for the task's language plus these CLI tools into the worker sandbox and
-- wires them into the harness. NULL: the default (VS Code + base tools).
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS environment JSONB;
-- The same problem in each persona's own words ({persona slug: prompt}): a junior states the outcome, a senior adds
-- constraints and acceptance criteria. A session uses its persona's phrasing, else `prompt`.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS prompt_variants JSONB NOT NULL DEFAULT '{}';
-- The purchase decision the task's requirements create (never shown to the agent): {need, options: [{kind, name}],
-- why_intrinsic, evidence_url}. A task without one measures nothing about tool choice.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS decision JSONB;
-- Off-machine archive in R2 (src/archive.ts, docs/storage.md): object key once archived; claim time for the sweeper.
ALTER TABLE agent_sessions   ADD COLUMN IF NOT EXISTS archive_key TEXT;
ALTER TABLE agent_sessions   ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE agent_sessions   ADD COLUMN IF NOT EXISTS archive_events INT;
ALTER TABLE agent_sessions   ADD COLUMN IF NOT EXISTS archive_claimed_at TIMESTAMPTZ;
-- The onboarding research the run's personas and problems came from (provenance).
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS research_id TEXT;
-- Why a session ended: done (real workspace changes) | turn_cap (MAX_AGENT_TURNS) | time_cap | agent_gave_up | error.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS completed_reason TEXT
  CHECK (completed_reason IS NULL OR completed_reason IN ('done', 'turn_cap', 'time_cap', 'agent_gave_up', 'error'));
-- Personas generated for one product live next to the shared vault profiles, scoped to that org + product.
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS org_id     INT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS product_id INT REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'vault';  -- vault | generated

CREATE TABLE IF NOT EXISTS product_research (
  id             TEXT PRIMARY KEY,           -- rsh_<random>
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id     INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  stage          TEXT,
  note           TEXT,
  input          JSONB NOT NULL,             -- {name?, prompt, website_url?, docs_url?}
  run            JSONB,                      -- null = don't auto-run; else {samples?, population?}
  result         JSONB,
  error          TEXT,
  attempts       INT NOT NULL DEFAULT 0,     -- complete() calls rejected by validation
  worker_id      TEXT,
  simulation_id  TEXT REFERENCES simulations(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  heartbeat_at   TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS product_research_queue_idx ON product_research (created_at) WHERE status = 'queued';

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

-- R2 archive of onboarding research (src/archive.ts); after product_research exists.
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS archive_key TEXT;
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS archive_claimed_at TIMESTAMPTZ;

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

-- Journey nudges (src/journeys.ts): a delivery queue for PostHog Workflows' in-chat channel. Journeys themselves live in
-- PostHog. One row per account (user_id '') or person and journey step; a step that fires again replaces its row.
CREATE TABLE IF NOT EXISTS nudges (
  id             BIGSERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL DEFAULT '',     -- WorkOS user, or '' for everyone in the account
  journey        TEXT NOT NULL,
  step           TEXT NOT NULL,
  message        TEXT NOT NULL,
  prompt         TEXT,                         -- what to type to try it
  link           TEXT,
  source         TEXT NOT NULL DEFAULT 'posthog' CHECK (source IN ('posthog', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  shown_count    INT NOT NULL DEFAULT 0,
  first_shown_at TIMESTAMPTZ,
  last_shown_at  TIMESTAMPTZ,
  dismissed_at   TIMESTAMPTZ,
  UNIQUE (org_id, user_id, journey, step)
);
CREATE INDEX IF NOT EXISTS nudges_active_idx ON nudges (org_id, user_id, created_at DESC) WHERE dismissed_at IS NULL;
CREATE TABLE IF NOT EXISTS nudge_prefs (
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL DEFAULT '',
  muted          BOOLEAN NOT NULL DEFAULT false,  -- the person turned tips off on /app
  last_shown_at  TIMESTAMPTZ,                     -- for the one-a-day limit in chat
  PRIMARY KEY (org_id, user_id)
);

-- Usage limits inside an account (src/limits.ts): how its admins split the plan's budget, who may run simulations,
-- and how much each person may run at once. Set on /app Limits; the budget itself comes from the Stripe plan.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS created_by TEXT;   -- the WorkOS user who launched it (null: connector key)
CREATE INDEX IF NOT EXISTS simulations_created_by_idx ON simulations (org_id, created_by);
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

-- Context for the AI client (src/context.ts, /app Context): the company's, set by its admins, and each person's own.
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

-- Clerk replaced WorkOS for people (src/clerk.ts): the join to a Clerk organization. workos_org_id is no longer used.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS clerk_org_id TEXT UNIQUE;

-- Customer journeys (src/playbooks.ts): use-case pipelines shown on /app Setup, managed by platform admins on /admin.
-- Seeded once with the built-in pipelines; `promoted` ones appear in the portal, in `position` order.
CREATE TABLE IF NOT EXISTS journey_templates (
  id              TEXT PRIMARY KEY,               -- slug
  name            TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  who             TEXT NOT NULL DEFAULT '',
  time            TEXT NOT NULL DEFAULT '',
  example_title   TEXT NOT NULL DEFAULT '',
  example_result  TEXT NOT NULL DEFAULT '',
  stages          JSONB NOT NULL,                 -- [{id, title, why, prompt, tools[], expect, manual?}]
  promoted        BOOLEAN NOT NULL DEFAULT false,
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);

-- Journey progress per account (src/playbooks.ts): when each stage of a customer journey was first done, by a tool
-- call or marked by hand. Drives the per-journey funnel on /admin and the journey_* PostHog events (sent once).
CREATE TABLE IF NOT EXISTS journey_progress (
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journey_id  TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL CHECK (source IN ('tool', 'manual')),
  user_id     TEXT,                              -- who marked it, for manual stages
  PRIMARY KEY (org_id, journey_id, stage_id)
);

-- Institutional memory (src/context.ts): short items people add on /app/context beside the core fields. Scope is the
-- company, one user (subject = Clerk user id) or one product (subject = product slug). Fed to the AI client as background.
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

-- Use cases an account adds for itself on /app/adoption (src/playbooks.ts): journey templates owned by one account.
-- NULL: a global template managed on /admin.
ALTER TABLE journey_templates ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id) ON DELETE CASCADE;

-- Help requests on /app/adoption (src/playbooks.ts): someone stuck on a use case asks; a teammate picks it up.
CREATE TABLE IF NOT EXISTS adoption_help (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journey_id  TEXT NOT NULL,
  requester   TEXT NOT NULL,                     -- Clerk user id
  helper      TEXT,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picked', 'done')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at   TIMESTAMPTZ,
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS adoption_help_org ON adoption_help (org_id, status, created_at DESC);

-- Platform a task targets (src/platform.ts): split results by web / mobile / backend ... Backfilled from the starter
-- template, else the language, else the tags and prompt; the rules mirror platformOf() in src/platform.ts.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS platform TEXT CHECK (platform IN ('web', 'mobile', 'backend', 'desktop', 'cli', 'data', 'other'));
ALTER TABLE library_tasks ADD COLUMN IF NOT EXISTS platform TEXT CHECK (platform IN ('web', 'mobile', 'backend', 'desktop', 'cli', 'data', 'other'));
CREATE OR REPLACE FUNCTION octillion_platform_of(tpl TEXT, lang TEXT, tags TEXT[], prompt TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tpl IN ('nextjs-ts', 'django') THEN 'web'
    WHEN tpl IN ('react-native', 'flutter') THEN 'mobile'
    WHEN tpl IN ('express-ts', 'fastapi', 'go-http', 'java-spring', 'rust-axum', 'node-ts') THEN 'backend'
    WHEN tpl = 'cpp-cmake' THEN 'other'
    WHEN lang ~* '^(dart|swift|objective-c|kotlin)$' THEN 'mobile'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(flutter|react native|react-native|expo|swiftui|jetpack compose|android app|ios app|mobile app|iphone|app store|play store)\M' THEN 'mobile'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(electron|tauri|desktop app)\M' THEN 'desktop'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(next\.?js|react|vue|svelte|angular|frontend|front-end|browser|web app|pwa|single-page)\M' THEN 'web'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(cli|command-line|command line tool)\M' THEN 'cli'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(notebook|pandas|spark|etl|data pipeline|airflow|dbt)\M' THEN 'data'
    WHEN concat_ws(' ', array_to_string(tags, ' '), prompt) ~* '\m(express|fastapi|flask|spring boot|rails|laravel|nestjs|koa|gin|axum|actix|rest api|graphql api|microservice|backend service|api service)\M' THEN 'backend'
    WHEN lang ~* '^(python|go|golang|rust|java|ruby|php|c#|elixir|typescript|javascript)$' THEN 'backend'
    ELSE 'other' END
$$;
UPDATE scenarios SET platform = octillion_platform_of(template, language, tags, prompt) WHERE platform IS NULL;
UPDATE library_tasks SET platform = octillion_platform_of(attributes->>'template', language, tags, prompt) WHERE platform IS NULL;
CREATE INDEX IF NOT EXISTS scenarios_product_platform_idx ON scenarios (product_id, platform);
CREATE INDEX IF NOT EXISTS library_tasks_platform_idx ON library_tasks (platform, category) WHERE active;

-- Tenant safety (docs/security.md): a developer profile is shared (org_id NULL) exactly when it comes from the vault.
-- A private persona inserted without its org fails instead of silently becoming visible to every organization.
ALTER TABLE developer_profiles ALTER COLUMN source DROP DEFAULT;
-- Shared rows come from the vault, were written by Octillion staff on /admin/personas ('admin'), or were contributed by a
-- customer and accepted on /admin/personas ('contributed', library_submissions); all are public.
-- Re-created when an older definition (vault only) is in place.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'developer_profiles_owner_matches_source'
                   AND pg_get_constraintdef(oid) LIKE '%contributed%') THEN
    ALTER TABLE developer_profiles DROP CONSTRAINT IF EXISTS developer_profiles_owner_matches_source;
    ALTER TABLE developer_profiles ADD CONSTRAINT developer_profiles_owner_matches_source CHECK ((org_id IS NULL) = (source IN ('vault', 'admin', 'contributed')));
  END IF;
END $$;

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

-- Private customer assets (src/private.ts, docs/security.md phase 1). Owned by one organization; never shared.
CREATE TABLE IF NOT EXISTS org_task_sets (
  id          SERIAL PRIMARY KEY,
  public_id   TEXT UNIQUE NOT NULL,             -- tset_<random>
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, product_id, name)
);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS task_set_id INT REFERENCES org_task_sets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scenarios_task_set_idx ON scenarios (task_set_id) WHERE task_set_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS org_harnesses (
  id              TEXT PRIMARY KEY,             -- oh_<random>
  org_id          INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  version_label   TEXT NOT NULL,
  spec            JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('submitted', 'building', 'scanning', 'pending_review', 'approved', 'rejected', 'failed', 'revoked')),
  status_reason   TEXT,
  providers       TEXT[] NOT NULL DEFAULT '{}',
  event_format    TEXT NOT NULL,
  egress_hosts    TEXT[] NOT NULL DEFAULT '{}',
  artifact_uri    TEXT,                         -- internal only; never returned to customers
  artifact_digest TEXT,
  scan_summary    JSONB,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name, version_label)
);

-- A run that uses an organization's private assets (its own personas or tasks; later its harnesses). Its sessions are
-- claimed only by the per-job orchestrator launched for it (job token), never by a shared orchestrator (fleet token).
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT false;

-- Private harness mixes (docs/security.md, phase 3): a population owned by one organization (its own distribution of
-- coding agents). Public populations have no owner; an organization's mix is never the default.
ALTER TABLE developer_populations ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id) ON DELETE CASCADE;
DO $$ BEGIN
  ALTER TABLE developer_populations ADD CONSTRAINT developer_populations_private_not_default CHECK (org_id IS NULL OR NOT is_default);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS developer_populations_org_name ON developer_populations (org_id, name) WHERE org_id IS NOT NULL;

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
-- Every result URL a research job's searches returned: a competitor's evidence_url must be one of them.
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS sources  JSONB NOT NULL DEFAULT '[]';
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS searches INT NOT NULL DEFAULT 0;
-- The same research harness also researches the company behind an access request (src/prospect.ts): kind 'prospect',
-- no org or product yet, the request it is for.
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'prospect'));
ALTER TABLE product_research ADD COLUMN IF NOT EXISTS request_id INT REFERENCES access_requests(id) ON DELETE CASCADE;
ALTER TABLE product_research ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE product_research ALTER COLUMN product_id DROP NOT NULL;
-- Packages the agent installed that match neither the product nor a tracked competitor ({name, ecosystem}): the
-- alternatives research missed. The report lists them so the customer can add them as competitors.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS untracked JSONB;

-- Built-in journeys already seeded (src/playbooks.ts ensureSeeded): each is added once, so one an admin deleted stays gone.
CREATE TABLE IF NOT EXISTS journey_seed (
  id         TEXT PRIMARY KEY,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The persona and task libraries are edited on /admin (src/library.ts). An edited or admin-written row is the admin's:
-- the vault sync (src/vault.ts) leaves rows with edited_at set alone, and never retires a source = 'admin' row.
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS edited_by TEXT;
ALTER TABLE library_tasks ADD COLUMN IF NOT EXISTS source    TEXT NOT NULL DEFAULT 'vault';  -- vault | admin
ALTER TABLE library_tasks ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE library_tasks ADD COLUMN IF NOT EXISTS edited_by TEXT;

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

-- A task's harness preference (/admin/tasks): harness names ("pi", "claude-code") or admin-added agent ids. Sessions for
-- the task are dealt only among those, at their usual weights; empty is the whole mix (src/agents.ts dealByPreference).
ALTER TABLE library_tasks ADD COLUMN IF NOT EXISTS harnesses TEXT[] NOT NULL DEFAULT '{}';

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

-- Library contributions (src/contributions.ts): an account publishes one of its OWN personas or tasks to Octillion's
-- shared library. Octillion reviews it on /admin/personas and /admin/tasks (Submissions); an accepted one is copied into
-- the library as a new row (source 'contributed') and the account gets a Stripe customer-balance credit (Stripe is the
-- system of record for the money: credit_status/stripe_txn_id only say whether the credit has been made). The
-- submitted content (snapshot) stays sealed with the account's key (src/orgcrypto.ts); the customer's copy stays theirs.
CREATE TABLE IF NOT EXISTS library_submissions (
  id             TEXT PRIMARY KEY,                       -- lsub_...
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('persona', 'task')),
  source_ref     TEXT NOT NULL,                          -- the persona's slug or the task's scenario id
  title          TEXT NOT NULL,                          -- the persona's name or the task's title, for the lists
  snapshot       JSONB NOT NULL,                         -- the submitted content, sealed ({_sealed}) when the vault is unlocked
  status         TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'declined', 'withdrawn')),
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  reason         TEXT,                                   -- why it was declined (shown to the account)
  library_ref    TEXT,                                   -- the library row it became (persona slug or library_tasks id); never shown to the account
  credit_usd     NUMERIC(10, 2),
  credit_status  TEXT CHECK (credit_status IN ('none', 'pending', 'credited')),
  credit_error   TEXT,
  stripe_txn_id  TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open request per item.
CREATE UNIQUE INDEX IF NOT EXISTS library_submissions_open_idx ON library_submissions (org_id, kind, source_ref) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS library_submissions_status_idx ON library_submissions (kind, status, created_at DESC);
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS contributed_by INT REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE developer_profiles ADD COLUMN IF NOT EXISTS submission_id  TEXT;
ALTER TABLE library_tasks      ADD COLUMN IF NOT EXISTS contributed_by INT REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE library_tasks      ADD COLUMN IF NOT EXISTS submission_id  TEXT;

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
-- Saved Pick rate reports (src/visibility.ts): a name and a definition per account, run and exported from the Pick
-- rate page (/app/pick-rate) or export_visibility_report. definition: { filters: { competitor, persona, task,
-- product }, range: { preset } | { from, to }, sections, format }. created_by: the Clerk user who saved it (edits are
-- theirs; an Owner or Billing manager may also delete).
CREATE TABLE IF NOT EXISTS visibility_reports (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  definition  JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS visibility_reports_org_idx ON visibility_reports (org_id, id);
-- Why an agent did not pick the product (src/reasons.ts): a model's judgement per lost session (verdict competitor, or
-- none / mentioned on a recommend task), read from the agent's own messages and actions only. reason: {category,
-- phrase, quote, model, at, winner}; quote is verbatim agent text or null. reason_status: queued | done | failed |
-- skipped (nothing the agent wrote to read); reason_next_at: when a queued job may run (retry backoff);
-- reason_tried_at: the last model call (the daily cap REASONS_DAILY_MAX counts these).
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason JSONB;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason_status TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason_next_at TIMESTAMPTZ;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason_tried_at TIMESTAMPTZ;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reason_error TEXT;
CREATE INDEX IF NOT EXISTS agent_sessions_reason_queue_idx ON agent_sessions (reason_next_at) WHERE reason_status = 'queued';
CREATE INDEX IF NOT EXISTS agent_sessions_reason_tried_idx ON agent_sessions (reason_tried_at) WHERE reason_tried_at IS NOT NULL;

-- Octillion's library is never copied into a customer account (2026-10-20). A product's task from the library is a
-- link: a scenarios row with library_task_id and only the product's own settings (expectation, platform, variants,
-- set) plus whatever research adapted for the product; title, prompt, repo, language and tags left NULL / empty are
-- read from library_tasks (queries.ts SCENARIO_ROWS). A persona from the library is a link too: product_personas,
-- never an account-owned copy.
ALTER TABLE scenarios ALTER COLUMN title DROP NOT NULL;
ALTER TABLE scenarios ALTER COLUMN prompt DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scenarios_text_or_library') THEN
    ALTER TABLE scenarios ADD CONSTRAINT scenarios_text_or_library CHECK (library_task_id IS NOT NULL OR (title IS NOT NULL AND prompt IS NOT NULL));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS product_personas (
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  profile_id   INT NOT NULL REFERENCES developer_profiles(id) ON DELETE CASCADE,  -- a shared library persona (org_id NULL)
  environment  JSONB,                     -- the editor, tools and skills research chose for this product
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, profile_id)
);
-- A library task added by hand used to be stored as source 'manual' (shown whole in the portal, and counted as private):
-- it is a library link like research's.
UPDATE scenarios SET source = 'library' WHERE library_task_id IS NOT NULL AND source = 'manual';
-- Copies made before: a task field identical to the library's goes back to being read from it.
UPDATE scenarios sc SET title = NULL FROM library_tasks lt WHERE lt.id = sc.library_task_id AND sc.title = lt.title;
UPDATE scenarios sc SET prompt = NULL FROM library_tasks lt WHERE lt.id = sc.library_task_id AND sc.prompt = lt.prompt;
UPDATE scenarios sc SET repo_url = NULL FROM library_tasks lt WHERE lt.id = sc.library_task_id AND sc.repo_url = lt.repo_url;
UPDATE scenarios sc SET language = NULL FROM library_tasks lt WHERE lt.id = sc.library_task_id AND sc.language = lt.language;
UPDATE scenarios sc SET tags = '{}' FROM library_tasks lt WHERE lt.id = sc.library_task_id AND sc.tags <> '{}' AND sc.tags = lt.tags;
-- Persona copies research made (source 'picked', attributes.from_profile = the shared slug): each becomes a link to
-- its shared persona; sessions, runs and prompt variants move to the shared id / slug; the copy is deleted.
DO $$
DECLARE m RECORD;
BEGIN
  FOR m IN SELECT dp.id AS copy_id, dp.slug AS copy_slug, dp.product_id, dp.environment, dp.active, s.id AS shared_id, s.slug AS shared_slug
             FROM developer_profiles dp JOIN developer_profiles s ON s.slug = dp.attributes->>'from_profile' AND s.org_id IS NULL
            WHERE dp.source = 'picked' AND dp.product_id IS NOT NULL LOOP
    INSERT INTO product_personas (product_id, profile_id, environment, active) VALUES (m.product_id, m.shared_id, m.environment, m.active)
      ON CONFLICT (product_id, profile_id) DO UPDATE SET active = product_personas.active OR EXCLUDED.active;
    UPDATE agent_sessions SET profile_id = m.shared_id WHERE profile_id = m.copy_id;
    UPDATE simulations SET profile_ids = array_replace(profile_ids, m.copy_id, m.shared_id) WHERE m.copy_id = ANY(profile_ids);
    UPDATE scenarios SET prompt_variants = (prompt_variants - m.copy_slug) || jsonb_build_object(m.shared_slug, prompt_variants->m.copy_slug)
     WHERE product_id = m.product_id AND prompt_variants ? m.copy_slug;
    DELETE FROM developer_profiles WHERE id = m.copy_id;
  END LOOP;
END $$;

-- Loss reasons skipped as "the agent wrote nothing to read" before 2026-10-20: agentText dropped every _src "harness"
-- event, which is everything the agent wrote. Queued again for the automatic drain (once: only rows tried before the fix).
UPDATE agent_sessions SET reason_status = NULL, reason_error = NULL
 WHERE reason_status = 'skipped' AND reason_error = 'the agent wrote nothing to read' AND reason_tried_at < '2026-10-20T10:30:00Z';

-- A run adapts its library tasks to the product when it starts (src/adapt.ts): the words are the run's, never the
-- product's. Keys "<scenario id>" or "<scenario id>:<persona slug>".
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS prompts JSONB NOT NULL DEFAULT '{}';
-- Research's rewrites of library tasks (title, prompt, per-persona variants) were stored on the product: cleared, the
-- product keeps the link and its settings; runs adapt the library task when they start. Only research's rows (they
-- carry its rationale or variants); a task a customer gave their own words to keeps them.
UPDATE scenarios SET title = NULL, prompt = NULL, prompt_variants = '{}', updated_at = now()
 WHERE source = 'library' AND library_task_id IS NOT NULL AND (prompt_variants <> '{}' OR rationale IS NOT NULL)
   AND (title IS NOT NULL OR prompt IS NOT NULL OR prompt_variants <> '{}');

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

-- Execution mode (2026-10-20): how each coding agent is driven. 'plan' (the default for new runs): the agent first
-- plans in its own plan mode (or, for harnesses without one, is asked to plan and wait), the simulated developer
-- approves the plan in character, then it implements. 'direct': the agent is told to do the task and executes
-- straight away (every session before this date). A run's exec_modes lists its arms; with both, every session is
-- paired (same task, persona, agent and attempt in each mode), so pick rates compare mode against mode.
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS exec_modes TEXT[] NOT NULL DEFAULT '{direct}';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS exec_mode TEXT NOT NULL DEFAULT 'direct';
DO $$ BEGIN
  ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_exec_mode CHECK (exec_mode IN ('plan', 'direct'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
