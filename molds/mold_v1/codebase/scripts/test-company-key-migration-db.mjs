#!/usr/bin/env node
/**
 * drizzle/0024_company_key_per_workspace.sql ON A DATABASE SHAPED LIKE PRODUCTION, WITH DATA (mold_v1-118).
 *
 * The company key moves from customers.customer_id to (org_id, customer_id), and with it every table hanging off a
 * company. The live database is built as the factory builds one — `drizzle-kit push` from the schema BEFORE this
 * change (scripts/fixtures/schema-419b38d.ts, a verbatim copy of agent/lib/db/schema.ts at 419b38d), then the
 * tenancy bootstrap (app_rw, row-level security, every policy) — and seeded like production: two workspaces, 100
 * companies, rows in every table that hangs off a company and in every looser reference. Then:
 *
 *   A. THE DEPLOY CHAIN on a live database (the factory's provision.py): the journal (0024, one transaction, as
 *      migrate-production.mjs runs it), then the drift step — a read-only `drizzle-kit push --strict --verbose` dry
 *      run against schema.ts, parsed and filtered exactly as provision.py does: only policy changes, RLS disables
 *      and the one out-of-band index (workflow_definitions_one_default_idx) are set aside; a data-loss statement or
 *      any other index drop is refused. Its plan must hold NOTHING to apply: 0024 did the whole change. No row is
 *      lost or changed, 0024 is harmless run again, and afterwards two workspaces hold the same id while a row
 *      still cannot hang off another workspace's company.
 *   B. AN EMPTY DATABASE, the only place the chain runs `drizzle-kit push --force`: push from the new schema.ts,
 *      then the journal as migrate-production.mjs applies it there (baselined at 0013), then the bootstrap; the plan
 *      holds nothing on the company-keyed tables (only drift older than this change, which the chain applies).
 *   C. A journal-built database (org_id nullable) with the anomalies it allows: a company without a workspace takes
 *      the one its rows carry (else org #1), a row without one takes its company's, and a row planted under another
 *      workspace's company (#70) keeps its workspace and gets a company of its own there — nothing is deleted.
 *   D. The live shape holding such a planted row: 0024 keeps it (in a company of its own workspace) and the plan is
 *      empty.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/fde_test npm run test:company-key-migration-db
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl) {
  console.log("test-company-key-migration-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}`}`); }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const ssl = local ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const urlOf = (name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };
const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const TAG = "0024_company_key_per_workspace";
const statementsOf = (tag) => readFileSync(join(ROOT, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
const before = journal.entries.filter((e) => e.idx < journal.entries.find((x) => x.tag === TAG)?.idx);

const CHILDREN = ["platform", "deployments", "solutions", "implementation", "tickets", "interactions", "internal_staff", "customer_stakeholders"];
const KEYED = ["customers", ...CHILDREN, "account_summaries"];
const LOOSE = ["schedule_rules", "apps", "workflows", "browser_allowlist", "browser_credentials", "browser_contexts", "memories", "chat_sessions", "chat_threads", "todos"];
const W1 = "org-mig-one";
const W2 = "org-mig-two";
const WANT_PK = {
  customers: ["customers_org_id_customer_id_pk", "org_id,customer_id"],
  platform: ["platform_org_id_customer_id_pk", "org_id,customer_id"],
  implementation: ["implementation_org_id_customer_id_pk", "org_id,customer_id"],
  deployments: ["deployments_org_id_customer_id_deployment_id_pk", "org_id,customer_id,deployment_id"],
  solutions: ["solutions_org_id_customer_id_solution_id_pk", "org_id,customer_id,solution_id"],
  tickets: ["tickets_org_id_customer_id_ticket_id_pk", "org_id,customer_id,ticket_id"],
  interactions: ["interactions_org_id_customer_id_interaction_id_pk", "org_id,customer_id,interaction_id"],
  internal_staff: ["internal_staff_org_id_customer_id_staff_role_email_pk", "org_id,customer_id,staff_role,email"],
  customer_stakeholders: ["customer_stakeholders_org_customer_role_email_pk", "org_id,customer_id,stakeholder_role,email"],
  account_summaries: ["account_summaries_org_id_key_pk", "org_id,key"],
};

const scratch = [];
async function freshDb(label) {
  const name = `ckmig_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
/** Every journal entry before 0024, each migration in one transaction, as migrate-production.mjs applies it. */
async function applyJournal(db) {
  for (const e of before) await db.begin(async (tx) => { for (const s of statementsOf(e.tag)) await tx.unsafe(s); });
}
/** 0024, in one transaction (migrate-production.mjs runs every pending migration in one). */
const apply0024 = (db) => db.begin(async (tx) => { for (const s of statementsOf(TAG)) await tx.unsafe(s); });
const kit = (args, url) => {
  const r = spawnSync(join(ROOT, "node_modules/.bin/drizzle-kit"), args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n");
  return { status: r.status, out, statements: out.split("\n").filter((l) => /^(ALTER|CREATE|DROP|DELETE|TRUNCATE|INSERT|UPDATE)\b/.test(l.trim())) };
};
/** The live database's shape: pushed from the schema before this change, then the tenancy bootstrap. */
function liveShape(url) {
  const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
  if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
  const b = spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
}
const push = (url) => kit(["push", "--force", "--verbose"], url);

/**
 * The deploy's drift step, as provision.py (mold_v1-143) runs it: a READ-ONLY `drizzle-kit push --strict --verbose`
 * against schema.ts (non-TTY, so its approval prompt rejects before anything executes), the plan read whole from its
 * "You are about to execute current statements:" line (a statement starts at column 0 with an SQL verb; drizzle
 * prints a primary-key drop without a trailing `;`), and split as provision.py splits it: set aside only what push
 * would do to policies and row-level security and the one out-of-band index; refuse data loss and any other index
 * drop. Returns { apply, aside, refused } or { error }.
 */
const OUT_OF_BAND_INDEXES = ["workflow_definitions_one_default_idx"];
const SET_ASIDE = new RegExp(String.raw`^\s*(DROP\s+POLICY\b|ALTER\s+POLICY\b|DROP\s+INDEX\s+(IF\s+EXISTS\s+)?"?(${OUT_OF_BAND_INDEXES.join("|")})"?\s*;|ALTER\s+TABLE\b[\s\S]*\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY)`, "i");
const DATA_LOSS = /^\s*truncate\b|\bDROP\s+(TABLE|COLUMN|SCHEMA|MATERIALIZED\s+VIEW)\b/i;
const DROPS_INDEX = /^\s*DROP\s+INDEX\b/i;
const SQL_START = /^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|DO|GRANT|REVOKE|INSERT|UPDATE|DELETE|SELECT|WITH|SET|REFRESH)\b/i;
const PLAN_END = /^\s*(Warning\b|Error:|THIS ACTION\b|Do you still want\b|\[.\]|·)/;
function driftPlan(url) {
  const u = new URL(url);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  const r = kit(["push", "--strict", "--verbose"], u.toString());
  if (/Changes applied/.test(r.out)) return { error: "the dry run applied changes", out: r.out.slice(-600) };
  const HEAD = "You are about to execute current statements:";
  if (!r.out.includes(HEAD)) return /No changes detected/.test(r.out) ? { apply: [], aside: [], refused: [] } : { error: "no plan", out: r.out.slice(-600) };
  const stmts = [];
  for (const line of r.out.split(HEAD)[1].split("\n")) {
    if (PLAN_END.test(line)) break;
    if (!line.trim()) continue;
    if (SQL_START.test(line)) stmts.push(line);
    else if (stmts.length) stmts[stmts.length - 1] += `\n${line}`;
  }
  const aside = stmts.filter((x) => SET_ASIDE.test(x));
  const rest = stmts.filter((x) => !SET_ASIDE.test(x));
  return { apply: rest.filter((x) => !DATA_LOSS.test(x) && !DROPS_INDEX.test(x)), aside, refused: rest.filter((x) => DATA_LOSS.test(x) || DROPS_INDEX.test(x)) };
}
const touchesKeyed = (x) => KEYED.some((t) => x.includes(`"${t}"`));
const checkPlanEmpty = (url, label, { keyedOnly = false } = {}) => {
  const plan = driftPlan(url);
  if (keyedOnly) {
    // An empty database built by push + the journal carries drift older than this change (0014's org_id defaults on
    // workflow_runs / workflow_run_journal, which the chain's drift step applies there). None of it may be ours.
    const other = plan.apply?.filter((x) => !touchesKeyed(x)) ?? [];
    check(`${label}: the drift dry run plans nothing on the ${KEYED.length} company-keyed tables (${other.length} older unrelated statement(s): ${other.map((x) => x.split("\n")[0].slice(0, 70)).join(" / ") || "none"})`, !plan.error && plan.apply.filter(touchesKeyed).length === 0, plan.error ? plan : plan.apply.filter(touchesKeyed));
  } else {
    check(`${label}: the drift dry run plans NOTHING to apply (0024 did the whole change)`, !plan.error && plan.apply.length === 0, plan.error ? plan : plan.apply);
  }
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, !plan.error && plan.refused.length === 0, plan.refused);
  check(`${label}: …and what it sets aside (${plan.aside?.length ?? "?"} statements) is only push's usual policy / row-level-security noise, none of it on a key`, !plan.error && plan.aside.every((x) => !/CONSTRAINT|PRIMARY KEY|FOREIGN KEY/i.test(x)), plan.aside?.filter((x) => /CONSTRAINT/i.test(x)));
};

/** Two workspaces, 100 companies (50 each), rows in every table that hangs off a company, and the looser references. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '2 years'), (${W2}, 'Two', 'active', now())`;
  const cos = Array.from({ length: 100 }, (_, i) => ({ org: i < 50 ? W1 : W2, id: `co-${String(i + 1).padStart(3, "0")}` }));
  for (const { org, id } of cos) {
    await db`insert into customers (org_id, customer_id, customer_name, tier, fde_owner, custom) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', 'fde@mig.test', ${db.json({ notes: `n-${id}` })})`;
    await db`insert into platform (org_id, customer_id, deployment_model, data_residency_constraint, primary_model, enabled_connectors, feature_flags, primary_use_case) values (${org}, ${id}, 'saas', 'none', 'm', '[]', '{}', 'research')`;
    for (const d of ["prod", "uat"]) await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, custom) values (${org}, ${id}, ${`DEP-${d}`}, ${d}, 'ap-south-1', ${`v-${id}-${d}`}, 'deployed', 'healthy', ${db.json({ rating: "Buy" })})`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_fde_owner) values (${org}, ${id}, 'SOL-1', 'Research Copilot', '[]', 'live', 'fde@mig.test')`;
    await db`insert into implementation (org_id, customer_id, rollout_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner) values (${org}, ${id}, ${`ROLL-${id}`}, 'UAT', 50, 'Green', 'None')`;
    for (const n of [1, 2, 3]) {
      await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step) values (${org}, ${id}, ${`TCK-${n}`}, ${`t${n} ${id}`}, 'Question', 'Feature Request', 'Open', 'P2-Medium', '2026-09-01', 'fde@mig.test', 'Email', '2026-09-01', 'look')`;
      await db`insert into interactions (org_id, customer_id, interaction_id, interaction_at, interaction_type, source_system, note) values (${org}, ${id}, ${`INT-${n}`}, '2026-09-01', 'note', 'manual', ${`i${n} ${id}`})`;
    }
    await db`insert into internal_staff (org_id, customer_id, staff_role, name, employer_org, email) values (${org}, ${id}, 'solution_engineer', 'F', 'Us', 'fde@mig.test')`;
    await db`insert into customer_stakeholders (org_id, customer_id, stakeholder_role, name, employer_org, email) values (${org}, ${id}, 'champion', 'C', ${id}, ${`c@${id}.test`})`;
    await db`insert into account_summaries (org_id, key, summary) values (${org}, ${`fde@mig.test|${id}`}, 'brief')`;
  }
  // Looser references: a company id in a column that is not a foreign key (each row carries its own org_id).
  for (const { org, id } of cos.filter((_, i) => i % 10 === 0)) {
    await db`insert into schedule_rules (org_id, name, prompt, next_run_at, created_by, customer_id) values (${org}, ${`rule ${id}`}, 'p', now(), 'x', ${id})`;
    await db`insert into apps (org_id, slug, name, created_by, customer_id) values (${org}, ${`app-${id}`}, 'A', 'x', ${id})`;
    await db`insert into workflows (org_id, name, description, created_by, customer_id) values (${org}, ${`wf ${id}`}, 'd', 'x', ${id})`;
    await db`insert into browser_allowlist (org_id, origin, added_by, customer_id) values (${org}, ${`https://${id}.test`}, 'x', ${id})`;
    await db`insert into browser_credentials (org_id, customer_id, site_origin, username, secret_ciphertext, secret_iv, secret_tag, added_by) values (${org}, ${id}, 'https://portal.test', 'u', 'c', 'i', 't', 'x')`;
    await db`insert into browser_contexts (org_id, customer_id, scope_type, scope_key, created_by, provider, provider_context_id) values (${org}, ${id}, 'customer', ${id}, 'x', 'p', ${`ctx-${id}`})`;
    await db`insert into memories (org_id, scope, entity_id, key, value, author_email) values (${org}, 'customer', ${id}, 'k', 'v', 'x@mig.test')`;
    await db`insert into chat_sessions (id, org_id, owner_email, customers) values (${`s-${id}`}, ${org}, 'x@mig.test', ${db.json([id])})`;
    await db`insert into chat_threads (org_id, eve_session_id, owner_email, title, customers) values (${org}, ${`e-${id}`}, 'x@mig.test', 't', ${db.json([id])})`;
    await db`insert into todos (org_id, title, created_by, link_type, link_id) values (${org}, 't', 'x', 'customer', ${id})`;
  }
}

const count = async (db, t) => (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n;
const counts = async (db) => Object.fromEntries(await Promise.all([...KEYED, ...LOOSE].map(async (t) => [t, await count(db, t)])));
/** Every row of every table this touches, hashed by its values (not its column order): a changed or lost value shows. */
const fingerprint = async (db) => {
  const out = {};
  for (const t of [...KEYED, ...LOOSE]) out[t] = (await db.unsafe(`select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) as h from ${t} x`))[0].h;
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The key constraints as the database has them. */
const shape = async (db) => db`
    select con.conrelid::regclass::text as tbl, con.contype, con.conname, con.confdeltype,
           (select string_agg(a.attname, ',' order by k.n) from unnest(con.conkey) with ordinality k(attnum, n) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
           case when con.contype = 'f' then (select string_agg(a.attname, ',' order by k.n) from unnest(con.confkey) with ordinality k(attnum, n) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) end as fcols,
           con.confrelid::regclass::text as ftbl
      from pg_constraint con
     where con.contype in ('p', 'f', 'u') and con.conrelid::regclass::text = any(${KEYED})
     order by 1, 3`;
const checkShape = async (db, label) => {
  const rows = await shape(db);
  const bad = [];
  for (const [t, [name, cols]] of Object.entries(WANT_PK)) {
    const pk = rows.filter((r) => r.tbl === t && r.contype === "p");
    if (pk.length !== 1 || pk[0].conname !== name || pk[0].cols !== cols) bad.push({ t, pk });
  }
  for (const t of CHILDREN) {
    const fks = rows.filter((r) => r.tbl === t && r.contype === "f");
    if (fks.length !== 1 || fks[0].conname !== `${t}_customer_fk` || fks[0].cols !== "org_id,customer_id" || fks[0].fcols !== "org_id,customer_id" || fks[0].ftbl !== "customers" || fks[0].confdeltype !== "c") bad.push({ t, fks });
  }
  const single = rows.filter((r) => r.contype === "f" && r.ftbl === "customers" && r.fcols === "customer_id");
  check(`${label}: every key starts (org_id, customer_id) and every foreign key names both columns, under schema.ts's names`, bad.length === 0 && single.length === 0, { bad, single });
  const nullable = await db`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' and is_nullable = 'YES' and table_name = any(${KEYED})`;
  check(`${label}: org_id is NOT NULL on all ${KEYED.length} tables`, nullable.length === 0, nullable);
  const [order] = await db`select (select attnum from pg_attribute where attrelid = 'public.customers'::regclass and attname = 'org_id') < (select attnum from pg_attribute where attrelid = 'public.customers'::regclass and attname = 'customer_id') as ok`;
  check(`${label}: customers stands org_id before customer_id (both sides of every foreign key read the same way)`, order.ok === true);
};
/** Two workspaces hold one id; a row cannot hang off another workspace's company; a delete cascades per workspace. */
const checkBehaviour = async (db, label) => {
  const dup = await db`insert into customers (org_id, customer_id, customer_name) values (${W2}, 'co-001', 'Two holds it too') returning org_id`.then((r) => r.length, (e) => e.message);
  check(`${label}: W2 creates co-001, which W1 holds`, dup === 1, dup);
  const dupDep = await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${W2}, 'co-001', 'DEP-prod', 'prod', 'x', 'W2', 'deployed', 'healthy') returning 1`.then((r) => r.length, (e) => e.message);
  check(`${label}: …and a deployment under it with the same id as W1's`, dupDep === 1, dupDep);
  const plant = await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${W2}, 'co-002', 'SQUAT', 'prod', 'x', 'v', 'deployed', 'healthy')`.then(() => "inserted", (e) => e.code);
  check(`${label}: a row stamped W2 under co-002 (W1's only) is refused by the foreign key`, plant === "23503", plant);
  const w2Before = await db`select md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) as h from deployments x where org_id = ${W2}`;
  await db`delete from customers where org_id = ${W1} and customer_id = 'co-001'`;
  const w1Left = await db`select count(*)::int as n from deployments where org_id = ${W1} and customer_id = 'co-001'`;
  const w2After = await db`select md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) as h from deployments x where org_id = ${W2}`;
  check(`${label}: deleting W1's co-001 cascades to W1's rows only`, w1Left[0].n === 0 && w2Before[0].h === w2After[0].h, { w1Left, same: w2Before[0].h === w2After[0].h });
};
const keyStatements = (statements) => statements.filter((s) => /CONSTRAINT/.test(s) && KEYED.some((t) => s.includes(`"${t}"`)));

try {
  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, seeded) -> 0024 -> the drift dry run`);
  {
    const { db, url } = await freshDb("a");
    liveShape(url);
    await seed(db);
    const n0 = await counts(db);
    const f0 = await fingerprint(db);
    check("seeded like production: 100 companies in 2 workspaces, rows in every table", n0.customers === 100 && CHILDREN.every((t) => n0[t] >= 100) && LOOSE.every((t) => n0[t] > 0), n0);
    const [pre] = await db`select (select attnum from pg_attribute where attrelid = 'public.customers'::regclass and attname = 'customer_id') < (select attnum from pg_attribute where attrelid = 'public.customers'::regclass and attname = 'org_id') as first`;
    check("the live shape has customer_id before org_id in customers, as every database pushed before this change does", pre.first === true);
    const planBefore = driftPlan(url);
    check("before 0024, the drift plan names the key change (so an empty plan after it means something)", !planBefore.error && keyStatements(planBefore.apply).length > 0, planBefore.error ?? planBefore.apply.length);
    await apply0024(db);
    check("0024 applies, and no row in any table is lost or changed", same(await fingerprint(db), f0));
    await checkShape(db, "after 0024");
    checkPlanEmpty(url, "after 0024");
    await apply0024(db);
    check("0024 again: nothing changes", same(await fingerprint(db), f0));
    await checkShape(db, "after 0024 twice");
    const policies = (await db`select count(*)::int as n from pg_policies where schemaname = 'public'`)[0].n;
    check("…and every row-level-security policy the bootstrap made is still there", policies > 50, policies);
    await checkBehaviour(db, "A");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from the new schema.ts (the only place the chain pushes), the journal, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = push(url);
    check("push --force from the new schema.ts builds an empty database", p.status === 0 && /Changes applied/.test(p.out), p.out.slice(-600));
    // migrate-production.mjs on a pushed database: no journal table yet, the legacy tables exist, so it baselines at
    // 0013 and applies every later entry, 0024 among them, each on top of what push made.
    for (const e of journal.entries.filter((x) => x.idx > 13)) await db.begin(async (tx) => { for (const st of statementsOf(e.tag)) await tx.unsafe(st); });
    const b = spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
    check("…the journal after it (0014 to 0024) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    await seed(db);
    await checkShape(db, "empty database, pushed");
    checkPlanEmpty(url, "empty database, pushed", { keyedOnly: true });
    await checkBehaviour(db, "B");
    await db.end();
  }

  console.log("\nC. A journal-built database (org_id nullable) with the anomalies it allows -> 0024");
  {
    const { db } = await freshDb("c");
    await applyJournal(db);
    await seed(db);
    // A company with no workspace whose rows say W2; one with no rows at all; a row with no workspace under a W2
    // company; and a row W2 planted under W1's company (the #70 hole: the foreign key was checked past RLS).
    await db`insert into customers (org_id, customer_id, customer_name) values (null, 'orphan-with-rows', 'Orphan'), (null, 'orphan-bare', 'Bare')`;
    await db`insert into interactions (org_id, customer_id, interaction_id, interaction_at, interaction_type, source_system, note) values (${W2}, 'orphan-with-rows', 'INT-o', '2026-09-01', 'note', 'manual', 'o')`;
    await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step) values (null, 'co-060', 'TCK-null', 'no workspace', 'Question', 'Feature Request', 'Open', 'P2-Medium', '2026-09-01', 'x', 'Email', '2026-09-01', 'x')`;
    await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${W2}, 'co-003', 'PLANTED', 'prod', 'x', 'planted by W2', 'deployed', 'healthy')`;
    const n0 = await counts(db);
    const w1co3 = await db`select md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) as h from deployments x where org_id = ${W1} and customer_id = 'co-003'`;
    await apply0024(db);
    const n1 = await counts(db);
    check("no row in any table is lost (one company is added: the planted row's own)", CHILDREN.every((t) => n1[t] === n0[t]) && LOOSE.every((t) => n1[t] === n0[t]) && n1.customers === n0.customers + 1, { n0, n1 });
    const [o1] = await db`select org_id from customers where customer_id = 'orphan-with-rows'`;
    const [o2] = await db`select org_id from customers where customer_id = 'orphan-bare'`;
    check("a company with no workspace takes the one its rows carry", o1?.org_id === W2, o1);
    check("…and one with no rows takes the oldest workspace (org #1)", o2?.org_id === W1, o2);
    const [t] = await db`select org_id from tickets where ticket_id = 'TCK-null'`;
    check("a row with no workspace takes its company's", t?.org_id === W2, t);
    const [planted] = await db`select d.org_id, c.customer_name from deployments d join customers c on c.org_id = d.org_id and c.customer_id = d.customer_id where d.deployment_id = 'PLANTED'`;
    check("the planted row keeps its workspace (W2) and hangs off a W2 company of its own, named by its id", planted?.org_id === W2 && planted.customer_name === "co-003", planted);
    const w1co3After = await db`select md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) as h from deployments x where org_id = ${W1} and customer_id = 'co-003'`;
    check("…and W1's co-003 and its rows are untouched", w1co3[0].h === w1co3After[0].h && (await db`select customer_name from customers where org_id = ${W1} and customer_id = 'co-003'`)[0]?.customer_name === "Company co-003");
    await checkShape(db, "journal-built, after 0024");
    const f1 = await fingerprint(db);
    await apply0024(db);
    check("0024 again: nothing changes", same(await fingerprint(db), f1));
    await db.end();
  }

  console.log("\nD. The live shape holding a row planted under another workspace's company (#70) -> 0024 -> the drift dry run");
  {
    const { db, url } = await freshDb("d");
    liveShape(url);
    await seed(db);
    await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${W2}, 'co-003', 'PLANTED', 'prod', 'x', 'planted by W2', 'deployed', 'healthy')`;
    const n0 = await counts(db);
    await apply0024(db);
    const n1 = await counts(db);
    check("no row is lost (one company is added: the planted row's own)", CHILDREN.every((t) => n1[t] === n0[t]) && n1.customers === n0.customers + 1, { n0, n1 });
    const [planted] = await db`select d.org_id, c.customer_name from deployments d join customers c on c.org_id = d.org_id and c.customer_id = d.customer_id where d.deployment_id = 'PLANTED'`;
    check("the planted row keeps its workspace and hangs off a company of its own there", planted?.org_id === W2 && planted.customer_name === "co-003", planted);
    await checkShape(db, "planted row, after 0024");
    checkPlanEmpty(url, "planted row, after 0024");
    await db.end();
  }
} catch (error) {
  failures.push("the test itself");
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const name of scratch) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-company-key-migration-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-company-key-migration-db: all ${passed} checks passed`);
