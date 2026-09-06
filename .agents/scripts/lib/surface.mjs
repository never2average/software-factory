// Surface I/O against a mold_v1 database and blob store. Used by clone.py; never run by hand.
//   node surface.mjs extract   env: ORG_ID DATABASE_URL                      -> JSON surface+datainfra on stdout
//   node surface.mjs apply     env: ORG_ID DATABASE_URL, state JSON on stdin -> upserts the surface rows
//   node surface.mjs diff      env: ORG_ID DATABASE_URL LIVE_DATABASE_URL [BLOB_READ_WRITE_TOKEN LIVE_BLOB_READ_WRITE_TOKEN BLOB_PREFIX] -> JSON diff
//   node surface.mjs blobcopy  env: BLOB_PREFIX LIVE_BLOB_READ_WRITE_TOKEN BLOB_READ_WRITE_TOKEN  [--apply]
// Secrets arrive only through the environment; this file never writes them anywhere.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const MOLD = process.env.MOLD_DIR; if (!MOLD) throw new Error("MOLD_DIR unset");
const require = createRequire(MOLD + "/package.json");
const postgres = require("postgres");
const pg = (url) => postgres(url, { max: 2, prepare: false, connect_timeout: 20, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require" });
const cmd = process.argv[2]; const ORG = process.env.ORG_ID;

// Tables that carry the service surface, with the columns that identify a row and the columns worth diffing.
const SURFACE = {
  orgs:                  { key: ["org_id"], cols: ["name","google_hosted_domain","branding","plan","limits","blob_prefix","data_residency","status"] },
  org_members:           { key: ["org_id","email"], cols: ["role"] },
  platform_admins:       { key: ["email"], cols: [], global: true },
  people_roster:         { key: ["org_id","email"], cols: ["name","team","manager_email","escalations","archived_at"] },
  agent_profiles:        { key: ["org_id","email"], cols: ["persona_name","tone","instructions","default_mode","web_search_default","browser_default","model"] },
  agent_configs:         { key: ["org_id","agent_key"], cols: ["paused","instructions"] },
  memories:              { key: ["org_id","scope","entity_id","key"], cols: ["sensitivity","version"] },
  workflows:             { key: ["org_id","name"], cols: ["description","trigger","customer_id","steps","instructions","instructions_enabled","enabled","created_by"] },
  workflow_definitions:  { key: ["org_id","id"], cols: ["name","entity","stages","current_version","is_default","archived_at"] },
  customers:             { key: ["org_id","customer_id"], cols: ["customer_name","tier","lifecycle_stage","status","fde_owner","vertical","account_region","business_owner_email","technical_owner_email"] },
  internal_staff:        { key: ["org_id","customer_id","staff_role","email"], cols: ["name","employer_org"] },
  customer_stakeholders: { key: ["org_id","customer_id","stakeholder_role","email"], cols: ["name","employer_org"] },
  platform:              { key: ["org_id","customer_id"], cols: ["deployment_model","data_residency_constraint","primary_model","primary_use_case","feature_flags","enabled_connectors"] },
  solutions:             { key: ["org_id","customer_id","solution_id"], cols: ["use_case","business_process","solution_status"] },
  deployments:           { key: ["org_id","customer_id","deployment_id"], cols: ["environment","region","cloud_provider"] },
  recipes:               { key: ["org_id","slug"], cols: ["version","title","summary","satisfies_check","sort_order"] },
};
// Rows in these tables change with every request; they are counted but never diffed.
const VOLATILE = new Set(["runtime_env_presence","login_codes","subagent_runs","chat_presence","room_presence","chat_sessions","system_cron_overrides","account_summaries","task_workflow_transition_events","inbox"]);
const LIBRARY = new Set(["assign-account","data-migration-plan","eval-regression-triage","go-live-sprint","incident-postmortem","infosec-checklist","infra-sizing","integration-wiring","onboard-account","qbr-prep","renewal-risk","route-incident","solution-engineering"]);
const KEY_SEP = "|";

async function tableCols(sql, t) { return (await sql`select column_name from information_schema.columns where table_schema='public' and table_name=${t}`).map(r => r.column_name); }
async function rows(sql, t, spec) {
  const cols = await tableCols(sql, t); if (!cols.length) return null;
  const want = [...spec.key, ...spec.cols].filter(c => cols.includes(c));
  if (!spec.global && cols.includes("org_id")) return await sql`select ${sql(want)} from ${sql(t)} where org_id = ${ORG}`;
  return await sql`select ${sql(want)} from ${sql(t)}`;
}
const k = (r, spec) => spec.key.map(c => r[c] ?? "").join(KEY_SEP);
const showKey = (key) => key.split(KEY_SEP).join("/");
const norm = (v) => JSON.stringify(v ?? null);
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

async function listOrgs(sql) {
  const cols = await tableCols(sql, "orgs"); if (!cols.length) return [];
  const hasMembers = (await tableCols(sql, "org_members")).length > 0;
  const os = await sql`select org_id, name, status from orgs order by org_id`;
  for (const o of os) o.members = hasMembers ? (await sql`select count(*)::int as n from org_members where org_id = ${o.org_id}`)[0].n : null;
  return os;
}
async function countIf(url, t) { const sql = pg(url); try { if (!(await tableCols(sql, t)).length) return 0; const c = await tableCols(sql, t); return (c.includes("org_id") ? await sql`select count(*)::int as n from ${sql(t)} where org_id = ${ORG}` : await sql`select count(*)::int as n from ${sql(t)}`)[0].n; } finally { await sql.end(); } }
async function blobPaths(token, prefix) {
  const { list } = require("@vercel/blob"); const out = []; let cursor;
  do { const r = await list({ token, prefix, cursor, limit: 1000 }); for (const b of r.blobs) out.push(b.pathname.slice(prefix.length).replace(/^\//, "")); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  return out;
}
async function extract(url) {
  const sql = pg(url); const out = {}; let orgs = [];
  try { orgs = await listOrgs(sql); for (const [t, spec] of Object.entries(SURFACE)) out[t] = await rows(sql, t, spec); } finally { await sql.end(); }
  const org = out.orgs?.[0] ?? {}; const prof = (out.agent_profiles ?? []).find(p => p.email === "") ?? null;
  const names = new Set((out.workflows ?? []).map(w => w.name)), slugs = new Set((out.recipes ?? []).map(r => r.slug)), defs = out.workflow_definitions ?? [];
  const cyclesN = await countIf(url, "cycles"), todosN = await countIf(url, "todos");
  const hasEsc = (out.people_roster ?? []).some(r => Array.isArray(r.escalations) && r.escalations.length);
  const present = (i) => i.kind === "workflow_script" ? names.has(i.ref) : i.kind === "recipe" ? slugs.has(i.ref) : i.kind === "workflow_definition" ? defs.some(d => d.entity === i.ref || d.id === i.ref)
    : i.kind === "cycles" ? cyclesN > 0 : i.kind === "todos" ? todosN > 0 : i.kind === "roster_escalations" ? hasEsc : i.kind === "ticket_folder" ? true : true;
  let blobs = null, blobError = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) { try { blobs = await blobPaths(process.env.BLOB_READ_WRITE_TOKEN, process.env.BLOB_PREFIX ?? ""); } catch (e) { blobError = e.message; } }
  const tplRe = (tpl) => new RegExp("^(dataroom/)?(orgs/[^/]+/)?" + tpl.split(/\{[a-z_]+\}/).map(s => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+"));
  const filesUnder = (tpl) => blobs ? blobs.filter(p => tplRe(tpl).test(p)).length : undefined;
  const workspace = {
    org: pick({ org_id: ORG, name: org.name ?? ORG, display_name: org.branding?.displayName ?? org.name ?? ORG, google_hosted_domain: org.google_hosted_domain, plan: org.plan, data_residency: org.data_residency, blob_prefix: org.blob_prefix, logo_url: org.branding?.logoUrl }),
    members: (out.org_members ?? []).map(r => ({ email: r.email, role: r.role ?? "member" })),
    platform_admins: (out.platform_admins ?? []).map(r => r.email),
    roster: (out.people_roster ?? []).filter(r => !r.archived_at).map(r => ({ ...pick({ email: r.email, name: r.name, team: r.team, manager_email: r.manager_email }), escalations: r.escalations ?? [] })),
    customers: (out.customers ?? []).map(c => ({
      ...pick({ id: c.customer_id, name: c.customer_name, tier: c.tier, vertical: c.vertical, region: c.account_region, business_owner: c.business_owner_email, technical_owner: c.technical_owner_email }),
      staff: (out.internal_staff ?? []).filter(s => s.customer_id === c.customer_id).map(s => pick({ email: s.email, role: s.staff_role, name: s.name, employer_org: s.employer_org })),
      stakeholders: (out.customer_stakeholders ?? []).filter(s => s.customer_id === c.customer_id).map(s => pick({ email: s.email, role: s.stakeholder_role, name: s.name, employer_org: s.employer_org })) })),
  };
  const surface = {
    primary_context: {
      instructions: { ...(prof ? pick({ workspace: prof.instructions, persona_name: prof.persona_name, tone: prof.tone, default_mode: prof.default_mode, model: prof.model }) : {}),
        subagents: (out.agent_configs ?? []).map(r => pick({ agent_key: r.agent_key, paused: !!r.paused, instructions: r.instructions })) },
      memory: { scopes: [...new Set((out.memories ?? []).map(m => m.scope))].filter(Boolean), live_keys: (out.memories ?? []).length },
      corpus_files: blobs ? { total: blobs.length } : blobError ? { error: blobError } : undefined,
    },
    multiplayer_context: {
      evidence: { workflows: [...names], recipes: [...slugs], definitions: defs.map(d => ({ id: d.id, entity: d.entity, is_default: !!d.is_default })), cycles: cyclesN, todos: todosN, roster_escalations: hasEsc },
      escalation: { path: hasEsc ? "roster_escalations" : "none", incident_workflow: names.has("route-incident") ? "route-incident" : undefined },
    },
    custom_workflow_builder: {
      library: (() => { const have = (out.workflows ?? []).filter(w => LIBRARY.has(w.name)).map(w => w.name); return have.length === LIBRARY.size ? { install: "all" } : have.length ? { install: "listed", names: have } : { install: "none" }; })(),
      scripts: (out.workflows ?? []).filter(w => !LIBRARY.has(w.name)).map(w => ({ ...pick({ name: w.name, description: w.description ?? "", trigger: w.trigger ?? "manual", customer_id: w.customer_id, instructions: w.instructions }), steps: w.steps ?? [], enabled: w.enabled !== false, instructions_enabled: !!w.instructions_enabled })),
      definitions: defs.filter(d => !d.archived_at).map(d => ({ id: d.id, name: d.name, entity: d.entity, is_default: !!d.is_default, stages: d.stages ?? [] })),
    },
  };
  const fill = { present, filesUnder };
  const datainfra = {
    platforms: (out.platform ?? []).map(p => ({ ...pick({ customer_id: p.customer_id, version: "v1", deployment_model: p.deployment_model ?? "single_tenant", data_residency_constraint: p.data_residency_constraint ?? "none", primary_model: p.primary_model, primary_use_case: p.primary_use_case }), feature_flags: p.feature_flags ?? [], enabled_connectors: p.enabled_connectors ?? [] })),
    deployments: (out.deployments ?? []).map(d => pick({ customer_id: d.customer_id, version: d.deployment_id, environment: d.environment ?? "production", region: d.region, cloud: d.cloud_provider })),
    pipelines: (out.solutions ?? []).filter(s => s.business_process !== "agent").map(s => pick({ pipeline_id: s.solution_id, version: "v1", customer_id: s.customer_id, use_case: s.use_case })),
    agents: (out.solutions ?? []).filter(s => s.business_process === "agent").map(s => pick({ agent_id: s.solution_id, version: "v1", customer_id: s.customer_id, use_case: s.use_case })),
  };
  const counts = Object.fromEntries(Object.entries(out).map(([t, r]) => [t, r ? r.length : null]));
  // clone.py sends the app's own corpus and process lists; annotate them with what live has
  const state = process.env.STATE_JSON ? JSON.parse(readFileSync(process.env.STATE_JSON, "utf8")) : null;
  if (state) {
    surface.primary_context.corpus = (state.surface.primary_context.corpus ?? []).map(c => ({ ...c, ...(filesUnder(c.dataroom_path) !== undefined && { live_files: filesUnder(c.dataroom_path) }) }));
    surface.multiplayer_context.processes = (state.surface.multiplayer_context.processes ?? []).map(p => ({ ...p, implemented_by: p.implemented_by.map(i => ({ ...i, present: present(i) })) }));
  }
  return { workspace, surface, datainfra, counts, orgs, org: ORG };
}

async function pkCols(sql, t) {
  const r = await sql`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = ${t}::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`;
  return r.map(x => x.attname);
}
async function apply(url, state) {
  const sql = pg(url); const pk = {}; for (const t of ["orgs","org_members","platform_admins","people_roster","agent_profiles","agent_configs","workflow_definitions"]) pk[t] = await pkCols(sql, t); const s = state.surface; const mp = state.workspace; const ws = mp.org; const me = mp.fde_self.email; const done = {};
  const up = async (label, fn) => { try { done[label] = await fn(); } catch (e) { done[label] = "ERR " + e.message; } };
  try {
    await up("orgs", () => sql`insert into orgs (org_id, name, branding, blob_prefix, status, created_by) values (${ws.org_id}, ${ws.name}, ${sql.json(pick({ displayName: ws.display_name ?? ws.name, logoUrl: ws.logo_url }))}, ${ws.blob_prefix ?? "orgs/" + ws.org_id}, 'active', ${me})
      on conflict (${sql(pk.orgs)}) do update set name = excluded.name, branding = excluded.branding`.then(() => 1));
    await up("org_members", async () => { let n = 0; for (const m of mp.members) { await sql`insert into org_members (org_id, email, role, invited_by, accepted_at) values (${ws.org_id}, ${m.email}, ${m.role}, ${me}, now()) on conflict (${sql(pk.org_members)}) do update set role = excluded.role`; n++; } return n; });
    await up("platform_admins", async () => { let n = 0; for (const e of mp.platform_admins ?? []) { await sql`insert into platform_admins (email, added_by) values (${e}, ${me}) on conflict do nothing`; n++; } return n; });
    await up("people_roster", async () => { let n = 0; for (const r of mp.roster ?? []) { await sql`insert into people_roster (org_id, email, name, team, manager_email, escalations) values (${ws.org_id}, ${r.email}, ${r.name ?? null}, ${r.team ?? null}, ${r.manager_email ?? null}, ${r.escalations && r.escalations.length ? sql.json(r.escalations) : null}) on conflict (${sql(pk.people_roster)}) do update set name = excluded.name, team = excluded.team, manager_email = excluded.manager_email, escalations = excluded.escalations`; n++; } return n; });
    const p = s.primary_context.instructions ?? {}; const ws_ = s.web_search ?? {}, br = s.browser ?? {};
    await up("agent_profiles", () => sql`insert into agent_profiles (id, org_id, email, persona_name, tone, instructions, default_mode, web_search_default, browser_default, model, updated_by) values (${ws.org_id + ":"}, ${ws.org_id}, '', ${p.persona_name ?? null}, ${p.tone ?? null}, ${p.workspace ?? null}, ${p.default_mode ?? null}, ${ws_.default_on_for_agent ?? null}, ${br.default_on_for_agent ?? null}, ${p.model ?? null}, ${me})
      on conflict (${sql(pk.agent_profiles)}) do update set persona_name = excluded.persona_name, tone = excluded.tone, instructions = excluded.instructions, default_mode = excluded.default_mode, web_search_default = excluded.web_search_default, browser_default = excluded.browser_default, model = excluded.model`.then(() => 1));
    await up("agent_configs", async () => { let n = 0; for (const c of s.primary_context.instructions?.subagents ?? []) { await sql`insert into agent_configs (org_id, agent_key, paused, instructions) values (${ws.org_id}, ${c.agent_key}, ${!!c.paused}, ${c.instructions ?? null}) on conflict (${sql(pk.agent_configs)}) do update set paused = excluded.paused, instructions = excluded.instructions`; n++; } return n; });
    await up("workflow_definitions", async () => { let n = 0; for (const d of s.custom_workflow_builder.definitions ?? []) { await sql`insert into workflow_definitions (id, org_id, name, entity, stages, current_version, is_default, created_by) values (${d.id}, ${ws.org_id}, ${d.name}, ${d.entity}, ${sql.json(d.stages)}, 1, ${!!d.is_default}, ${me}) on conflict (${sql(pk.workflow_definitions)}) do update set name = excluded.name, stages = excluded.stages, is_default = excluded.is_default`; n++; } return n; });
    await up("workflows", async () => { let n = 0; for (const w of s.custom_workflow_builder.scripts ?? []) { if (w.file) continue; /* file-backed scripts go through fde:seed-workflows */
      await sql`insert into workflows (org_id, name, description, trigger, customer_id, steps, instructions, instructions_enabled, enabled, created_by) values (${ws.org_id}, ${w.name}, ${w.description}, ${w.trigger ?? "manual"}, ${w.customer_id ?? null}, ${sql.json(w.steps ?? [])}, ${w.instructions ?? null}, ${!!w.instructions_enabled}, ${w.enabled !== false}, ${me}) on conflict do nothing`; n++; } return n; });
  } finally { await sql.end(); }
  return done;
}

async function counts(sql) {
  const ts = (await sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`).map(r => r.table_name);
  const out = {}; for (const t of ts) out[t] = (await sql`select count(*)::int as n from ${sql(t)}`)[0].n; return out;
}
async function blobTree(token, prefix) {
  const { list } = require("@vercel/blob"); const out = {}; let cursor;
  do { const r = await list({ token, prefix, cursor, limit: 1000 }); for (const b of r.blobs) { const rel = b.pathname.slice(prefix.length).replace(/^\//, ""); const top = rel.split("/")[0] || "(root)"; out[top] = out[top] ?? { files: 0, bytes: 0 }; out[top].files++; out[top].bytes += b.size; } cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  return out;
}
async function diff(url, liveUrl, token, liveToken, prefix) {
  const a = pg(url), b = pg(liveUrl); const report = { tables: {}, surface: {}, blob: null, ok: true };
  try {
    const [ca, cb] = [await counts(a), await counts(b)];
    for (const t of new Set([...Object.keys(ca), ...Object.keys(cb)])) { const same = ca[t] === cb[t]; report.tables[t] = { clone: ca[t] ?? null, live: cb[t] ?? null, same, volatile: VOLATILE.has(t) }; if (!same && !VOLATILE.has(t)) report.ok = false; }
    for (const [t, spec] of Object.entries(SURFACE)) {
      const [ra, rb] = [await rows(a, t, spec), await rows(b, t, spec)]; if (!ra || !rb) { report.surface[t] = { skipped: "table missing" }; continue; }
      const ma = new Map(ra.map(r => [k(r, spec), r])), mb = new Map(rb.map(r => [k(r, spec), r]));
      const only_clone = [...ma.keys()].filter(x => !mb.has(x)), only_live = [...mb.keys()].filter(x => !ma.has(x)), changed = [];
      for (const [key, r] of ma) { const l = mb.get(key); if (!l) continue; const cols = spec.cols.filter(c => norm(r[c]) !== norm(l[c])); if (cols.length) changed.push({ key: showKey(key), cols }); }
      if (only_clone.length + only_live.length + changed.length) report.ok = false;
      report.surface[t] = { clone: ra.length, live: rb.length, only_clone: only_clone.map(showKey), only_live: only_live.map(showKey), changed };
    }
    if (token && liveToken) { const [ta, tb] = [await blobTree(token, prefix), await blobTree(liveToken, prefix)]; report.blob = { prefix, clone: ta, live: tb, same: norm(ta) === norm(tb) }; if (!report.blob.same) report.ok = false; }
  } finally { await a.end(); await b.end(); }
  return report;
}
async function blobcopy(prefix, liveToken, token, applyIt) {
  const { list, put } = require("@vercel/blob"); let n = 0, bytes = 0, cursor;
  do { const r = await list({ token: liveToken, prefix, cursor, limit: 1000 });
    for (const b of r.blobs) { n++; bytes += b.size; if (applyIt) {
      const res = await fetch(b.url, { headers: { authorization: "Bearer " + liveToken } });   // private store: unauthenticated GET returns a short error body
      if (!res.ok) throw new Error(`download ${b.pathname}: HTTP ${res.status}`);
      const body = await res.arrayBuffer(); if (body.byteLength !== b.size) throw new Error(`download ${b.pathname}: got ${body.byteLength} bytes, expected ${b.size}`);
      await put(b.pathname, body, { token, access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: res.headers.get("content-type") ?? undefined }); } }
    cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  return { prefix, files: n, bytes, applied: applyIt };
}

const E = process.env;
(async () => {
  let out;
  if (cmd === "extract") out = await extract(E.DATABASE_URL);
  else if (cmd === "apply") out = await apply(E.DATABASE_URL, JSON.parse(readFileSync(0, "utf8")));
  else if (cmd === "diff") out = await diff(E.DATABASE_URL, E.LIVE_DATABASE_URL, E.BLOB_READ_WRITE_TOKEN, E.LIVE_BLOB_READ_WRITE_TOKEN, E.BLOB_PREFIX ?? "");
  else if (cmd === "blobcheck") { const { list } = require("@vercel/blob"); try { const r = await list({ token: E.BLOB_READ_WRITE_TOKEN, prefix: E.BLOB_PREFIX ?? "", limit: 1 }); out = { ok: true, sample: r.blobs[0]?.pathname ?? null }; } catch (e) { out = { ok: false, error: e.message }; } }
  else if (cmd === "blobtree") out = await blobTree(E.BLOB_READ_WRITE_TOKEN, E.BLOB_PREFIX ?? "");
  else if (cmd === "blobcopy") out = await blobcopy(E.BLOB_PREFIX ?? "", E.LIVE_BLOB_READ_WRITE_TOKEN, E.BLOB_READ_WRITE_TOKEN, process.argv.includes("--apply"));
  else { console.error("usage: surface.mjs extract|apply|diff|blobcopy"); process.exit(2); }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
})().catch(e => { console.error("surface.mjs " + cmd + ": " + (e.message || e.code || String(e))); process.exit(1); });
