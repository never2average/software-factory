-- Rows shaped like a live database built before mold_v0-049 (npm run test:migrations): every table the earlier
-- 0001_baseline created, the product's included, with the links between them, and rows the baseline's one-time
-- repairs would change if they ran again (a library task a customer reworded, a picked persona copy, a loss reason
-- skipped before the fix): a database that ran the baseline must keep them as they are.
INSERT INTO organizations (slug, name, clerk_org_id, prepaid_allowed, budget_override_usd) VALUES
  ('mig-acme', 'Acme', 'org_acme', true, 250), ('mig-globex', 'Globex', 'org_globex', false, NULL), ('mig-initech', 'Initech', NULL, true, 40);
INSERT INTO api_keys (org_id, label, key_prefix, key_hash, user_id, last_used_at)
SELECT id, 'default', 'oct_' || slug, 'hash-' || slug, CASE WHEN slug = 'mig-acme' THEN 'user_alice' END, '2026-10-01T10:00:00Z' FROM organizations;
INSERT INTO access_requests (email, company, product_url, message, status, org_id, name, role, team_size, agents, competitors, goal, source)
SELECT 'cto@' || slug || '.example', name, 'https://' || slug || '.example', 'We want to know', 'approved', id, 'Pat', 'CTO', '11-50', '{claude-code,cursor}', 'Rival', 'baseline', '{"utm_source": "hn"}'
  FROM organizations WHERE slug <> 'mig-initech';
INSERT INTO access_requests (email, company, status) VALUES ('new@lead.example', 'Lead Co', 'pending');

INSERT INTO products (org_id, slug, name, description, category, website_url, aliases, packages, domains, competitors, prompt, features)
SELECT o.id, p.slug, p.name, 'A ' || p.name, 'database', 'https://' || p.slug || '.example', ARRAY[p.name || ' DB'], ARRAY[p.slug], ARRAY[p.slug || '.example'],
       '[{"name": "Rival", "aliases": [], "packages": ["rival"], "domains": ["rival.example"]}]', 'It stores rows', '[{"name": "branching"}]'
  FROM organizations o JOIN (VALUES ('mig-acme', 'acmeq', 'Acme Queue'), ('mig-acme', 'acmedb', 'Acme DB'), ('mig-globex', 'globexmail', 'Globex Mail')) p(org, slug, name) ON p.org = o.slug;

INSERT INTO library_tasks (slug, external_id, title, prompt, repo_url, language, category, tags, attributes, source, harnesses)
VALUES ('lt-queue', 'ext-1', 'Add a job queue', 'Add a background job queue to this service', 'https://github.com/x/y', 'typescript', 'backend', '{queue,jobs}', '{"template": "express-ts"}', 'vault', '{}'),
       ('lt-mobile', 'ext-2', 'Offline sync for a mobile app', 'Make the Flutter app work offline', NULL, 'dart', 'mobile', '{flutter}', '{}', 'admin', '{pi}');
INSERT INTO developer_profiles (slug, external_id, name, summary, attributes, instructions, active, source, environment)
VALUES ('vault-senior', 'p-1', 'Senior backend developer', 'Ten years of Go', '{"role": "backend"}', 'Answers tersely', true, 'vault', '{"editor": "vscode", "tools": ["git"]}'),
       ('vault-junior', 'p-2', 'Junior web developer', 'First job', '{"role": "web"}', 'Asks many questions', true, 'vault', NULL);
INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, source, org_id, product_id)
SELECT 'acme-own-' || p.slug, 'Acme platform engineer', 'Runs Acme infra', '{}', 'Precise', 'generated', p.org_id, p.id FROM products p WHERE p.slug = 'acmeq';
-- A persona copy research made before personas became links: the baseline's repair turned such copies into links and
-- deleted them. Kept here: the earlier baseline already ran on this database.
INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, source, org_id, product_id)
SELECT 'acme-picked-senior', 'Senior backend developer', 'Copy', '{"from_profile": "vault-senior"}', 'Copy', 'picked', p.org_id, p.id FROM products p WHERE p.slug = 'acmedb';

INSERT INTO developer_populations (slug, name, description, as_of, methodology, sources, unrepresented_share, sandbox_unit, is_default)
VALUES ('global', 'Global developers', 'Everyone', '2026-10-01', 'Survey', '[{"url": "https://survey.example"}]', 0.1, 20, true);
INSERT INTO developer_populations (slug, name, org_id) SELECT 'acme-mix', 'Acme mix', id FROM organizations WHERE slug = 'mig-acme';
INSERT INTO developer_population_agents (population_id, agent_id, market_share, paused, notes)
SELECT id, a, s, false, 'n' FROM developer_populations, (VALUES ('claude-code/sonnet', 0.5::real), ('codex/gpt', 0.3::real)) x(a, s);

INSERT INTO org_task_sets (public_id, org_id, product_id, name, description)
SELECT 'tset_' || p.slug, p.org_id, p.id, 'Core', 'Our core tasks' FROM products p WHERE p.slug = 'acmeq';
INSERT INTO scenarios (product_id, title, prompt, repo_url, language, tags, expectation, source, rationale, template, prompt_variants, decision, task_set_id, platform)
SELECT p.id, 'Queue for emails', 'Send emails from a queue', NULL, 'typescript', '{email}', 'recommend', 'manual', NULL, 'express-ts', '{}',
       '{"need": "a queue", "options": [{"kind": "library", "name": "acmeq"}]}', (SELECT id FROM org_task_sets LIMIT 1), 'backend'
  FROM products p WHERE p.slug = 'acmeq';
-- A library task the customer reworded (source library, research's rationale, their own title): the baseline's repair
-- cleared such words. Kept here.
INSERT INTO scenarios (product_id, title, prompt, library_task_id, source, rationale, expectation, platform)
SELECT p.id, 'Our own words for the queue task', NULL, lt.id, 'library', 'Fits the queue', 'recommend', 'backend'
  FROM products p, library_tasks lt WHERE p.slug = 'acmeq' AND lt.slug = 'lt-queue';
INSERT INTO scenarios (product_id, title, prompt, expectation, source)
SELECT p.id, 'Avoid it here', 'Write a CLI that never needs a database', 'avoid', 'generated' FROM products p WHERE p.slug = 'globexmail';

INSERT INTO simulations (id, org_id, product_id, name, models, harness, repeats, status, created_at, started_at, finished_at, max_samples, sampling,
                         profile_ids, mode, agent_ids, population_id, created_by, private, prompts, exec_modes)
SELECT 'sim_' || p.slug, p.org_id, p.id, 'Run for ' || p.name, '{sonnet}', 'claude-code', 2, 'completed', '2026-10-02T09:00:00Z', '2026-10-02T09:01:00Z', '2026-10-02T09:30:00Z',
       8, '{"1": {"attempts": 2}}', ARRAY[(SELECT id FROM developer_profiles WHERE slug = 'vault-senior')], 'representative', '{claude-code/sonnet}',
       (SELECT id FROM developer_populations WHERE slug = 'global'), 'user_alice', false, '{"1": "adapted words"}', '{plan,direct}'
  FROM products p;
INSERT INTO agent_sessions (id, simulation_id, org_id, product_id, scenario_id, model, harness, attempt, status, worker_id, sandbox_id, queued_at, started_at,
                            heartbeat_at, ended_at, tokens_in, tokens_out, cost_usd, metadata, events, verdict, winner, mentions, scored_at, profile_id,
                            user_turns, agent_id, archive_key, completed_reason, untracked, reason, reason_status, reason_attempts, reason_tried_at, reason_error, exec_mode)
SELECT 'ses_' || s.id || '_' || n, s.id, s.org_id, s.product_id, sc.id, 'sonnet', 'claude-code', n, CASE WHEN n = 1 THEN 'completed' ELSE 'failed' END, 'w-1', 'sbx-1',
       '2026-10-02T09:00:00Z', '2026-10-02T09:01:00Z', '2026-10-02T09:10:00Z', '2026-10-02T09:20:00Z', 1000 * n, 200 * n, 0.25 * n, '{"k": 1}', 3,
       CASE WHEN n = 1 THEN 'adopted' ELSE 'competitor' END, 'Rival', '[{"tool": "Rival", "level": "adopted"}]', '2026-10-02T09:21:00Z',
       (SELECT id FROM developer_profiles WHERE slug = 'vault-senior'), 2, 'claude-code/sonnet', NULL, 'done', '[{"name": "left-pad", "ecosystem": "npm"}]',
       CASE WHEN n = 2 THEN '{"category": "docs"}'::jsonb END,
       -- A loss reason skipped before the 2026-10-20 fix: the baseline's repair queued it again. Kept here.
       CASE WHEN n = 2 THEN 'skipped' END, n, CASE WHEN n = 2 THEN '2026-10-19T00:00:00Z'::timestamptz END,
       CASE WHEN n = 2 THEN 'the agent wrote nothing to read' END, CASE WHEN n = 1 THEN 'plan' ELSE 'direct' END
  FROM simulations s JOIN LATERAL (SELECT id FROM scenarios WHERE product_id = s.product_id ORDER BY id LIMIT 1) sc ON true, generate_series(1, 2) n;
INSERT INTO transcript_events (session_id, seq, ts, type, text, raw)
SELECT a.id, n, '2026-10-02T09:05:00Z'::timestamptz + n * interval '1 second', 'assistant', 'I will use ' || CASE WHEN n = 2 THEN 'Rival' ELSE 'a queue' END, '{"n": 1}'
  FROM agent_sessions a, generate_series(1, 3) n;
INSERT INTO product_research (id, org_id, product_id, status, stage, input, run, result, attempts, simulation_id, created_at, finished_at, sources, searches, kind)
SELECT 'rsh_' || p.slug, p.org_id, p.id, 'completed', 'done', '{"prompt": "It stores rows"}', '{"samples": 4}', '{"personas": []}', 1, 'sim_' || p.slug,
       '2026-10-01T08:00:00Z', '2026-10-01T08:20:00Z', '[{"url": "https://docs.example"}]', 3, 'product' FROM products p;
INSERT INTO product_research (id, status, input, kind, request_id)
SELECT 'rsh_prospect', 'failed', '{"company": "Lead Co"}', 'prospect', id FROM access_requests WHERE email = 'new@lead.example';
INSERT INTO product_personas (product_id, profile_id, environment, active)
SELECT p.id, d.id, '{"editor": "zed"}', true FROM products p, developer_profiles d WHERE p.slug = 'acmeq' AND d.slug = 'vault-junior';

INSERT INTO account_context (org_id, about, audience, competitors, terms, notes_for_ai, updated_at, updated_by)
SELECT id, 'We sell queues', 'Backend developers', '["Rival"]', 'AQ', 'Be brief', '2026-10-01T00:00:00Z', 'user_alice' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO user_context (org_id, user_id, title, focus_product, interests, answer_style, notes, updated_at)
SELECT id, 'user_alice', 'PM', 'acmeq', 'pricing', 'brief', 'n', '2026-10-01T00:00:00Z' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO journey_templates (id, name, outcome, who, time, stages, promoted, position) VALUES
  ('baseline', 'Baseline', 'Know your pick rate', 'PM', '1 day', '[{"id": "s1", "title": "Onboard"}]', true, 1);
INSERT INTO journey_templates (id, name, outcome, stages, org_id) SELECT 'acme-own', 'Acme use case', 'Ours', '[]', id FROM organizations WHERE slug = 'mig-acme';
INSERT INTO journey_seed (id) VALUES ('baseline');
INSERT INTO journey_progress (org_id, journey_id, stage_id, source, user_id) SELECT id, 'baseline', 's1', 'tool', NULL FROM organizations WHERE slug = 'mig-acme';
INSERT INTO context_memories (org_id, scope, subject, kind, body, created_by) SELECT id, 'product', 'acmeq', 'decision', 'We price per seat', 'user_alice' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO adoption_help (org_id, journey_id, requester, note, status) SELECT id, 'baseline', 'user_alice', 'stuck', 'open' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO nudges (org_id, user_id, journey, step, message, prompt, link, source, expires_at, shown_count)
SELECT id, '', 'baseline', 's1', 'Try a run', 'run it', '/app', 'admin', '2026-12-01T00:00:00Z', 2 FROM organizations WHERE slug = 'mig-acme';
INSERT INTO nudge_prefs (org_id, user_id, muted) SELECT id, 'user_alice', true FROM organizations WHERE slug = 'mig-acme';
INSERT INTO org_harnesses (id, org_id, name, version_label, spec, status, providers, event_format, egress_hosts)
SELECT 'oh_acme', id, 'acme-agent', 'v1', '{"cmd": "x"}', 'pending_review', '{anthropic}', 'jsonl', '{api.acme.example}' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO library_submissions (id, org_id, kind, source_ref, title, snapshot, status, credit_usd, credit_status, created_by)
SELECT 'lsub_1', id, 'persona', 'acme-own-acmeq', 'Acme platform engineer', '{"_sealed": "x"}', 'submitted', 5, 'none', 'user_alice' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO visibility_reports (org_id, name, definition, created_by) SELECT id, 'Weekly', '{"range": {"preset": "7d"}}', 'user_alice' FROM organizations WHERE slug = 'mig-acme';

-- The shell's own rows next to them: limits, the gateway (a session token, usage), MCP activity, compute.
INSERT INTO usage_policies (org_id, mode, reserve_usd, max_concurrent_runs, max_run_usd) SELECT id, 'pool', 10, 2, 50 FROM organizations WHERE slug = 'mig-acme';
INSERT INTO usage_teams (org_id, name, budget_usd) SELECT id, 'Platform', 100 FROM organizations WHERE slug = 'mig-acme';
INSERT INTO usage_members (org_id, user_id, team_id, cap_usd, can_run) SELECT o.id, 'user_alice', t.id, 30, true FROM organizations o JOIN usage_teams t ON t.org_id = o.id;
INSERT INTO gateway_tokens (token_hash, kind, session_id, providers, expires_at)
SELECT 'gwt-' || id, 'session', id, '{anthropic}', '2026-11-01T00:00:00Z' FROM agent_sessions WHERE attempt = 1;
INSERT INTO gateway_tokens (token_hash, kind, orchestrator_id, providers, expires_at) VALUES ('gwt-orch', 'orchestrator', 'orch-1', '{anthropic}', '2026-11-01T00:00:00Z');
INSERT INTO gateway_usage (token_hash, provider, session_id, requests, input_tokens, output_tokens, cost_usd)
SELECT 'gwt-' || id, 'anthropic', id, 4, 1000, 200, 0.12 FROM agent_sessions WHERE attempt = 1;
INSERT INTO mcp_events (org_id, method, name, client, ok, ms, user_id) SELECT id, 'tools/call', 'list_records', 'claude-code', true, 12, 'user_alice' FROM organizations;
INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, job_id, pods) VALUES ('sbx-o1', 'orch-1', 'deleted', 'sim_acmeq', 2);
INSERT INTO compute_events (kind, sandbox_id, job_id, session_id, reason) VALUES ('reaped', 'sbx-o1', 'sim_acmeq', 'ses_sim_acmeq_1', 'idle');
INSERT INTO worker_tokens (token_hash, job_id, org_id, sandbox_row_id, expires_at) SELECT 'wt-1', 'sim_acmeq', id, 1, '2026-11-01T00:00:00Z' FROM organizations WHERE slug = 'mig-acme';
INSERT INTO gateway_model_usage (day, provider, model, consumer, requests, input_tokens, output_tokens, cost_usd) VALUES ('2026-10-02', 'anthropic', 'claude-sonnet-5-5', 'session', 4, 1000, 200, 0.12);
INSERT INTO platform_settings (key, value, updated_by) VALUES ('OCTILLION_MAX_SAMPLES', '12', 'admin@example');
INSERT INTO platform_harnesses (id, harness, model, label) VALUES ('opencode/cf-qwen', 'opencode', 'qwen', 'Qwen on OpenCode');
INSERT INTO email_log (kind, to_hash, to_domain, subject, status, idempotency_key) VALUES ('request_received', 'h', 'lead.example', 'Thanks', 'sent', 'request:1:received');
INSERT INTO docs_answers (area, user_key, org_id, sources, model, answered) SELECT 'customer', 'user_alice', id, 2, 'm', true FROM organizations WHERE slug = 'mig-acme';
