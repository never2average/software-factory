#!/usr/bin/env node
/**
 * PEOPLE DATA, AGAINST A REAL POSTGRES, as the restricted app_rw role under the production FAIL-CLOSED policies
 * (scripts/lib/people-data-db-probe.mjs, run under two profiles):
 *
 *   0. the migration (drizzle/0046_people_directory.sql): people_roster.departments jsonb NOT NULL DEFAULT '[]' and
 *      .attributes jsonb NOT NULL DEFAULT '{}', additive, harmless applied twice over rows it keeps, the journal entry
 *      numbered after 0045, and the deploy's drift plan names exactly the two columns before it and nothing after;
 *   1. the default profile (this checkout): the roster, the dossier and the tools answer what they always did, and the
 *      reporting-line rules hold: only the owner or an admin sets who someone reports to, only to someone of the same
 *      workspace, never themselves, never a loop (one write, through stored lines, or a bulk import);
 *   2. a declared catalogue (scripts/fixtures/people/50-people.json), in a copy: the owner sets departments and
 *      attributes, a member cannot, the wrong kind of value is refused, who reads what;
 *   every run: workspace B reads none of A's people or their fields through the routes, the tools or the rows under RLS.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:people-data-db
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { copyWithProfiles } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-people-data-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let failures = 0;
let passed = 0;
const saved = new Map();
const check = (what, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${what}`); }
  else { failures++; console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)}`}`); }
};
try {
  console.log("0. The migration (drizzle/0046_people_directory.sql)");
  {
    const TAG = "0046_people_directory";
    const cols = await admin`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people_roster' AND column_name IN ('departments', 'attributes') ORDER BY column_name`;
    check("people_roster.attributes jsonb NOT NULL default '{}', .departments jsonb NOT NULL default '[]'", JSON.stringify(cols.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default])) === JSON.stringify([["attributes", "jsonb", "NO", "'{}'::jsonb"], ["departments", "jsonb", "NO", "'[]'::jsonb"]]), cols);
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1 && journal.entries[at].idx === 46 && journal.entries[at].when > journal.entries[at - 1].when, journal.entries[at]);
    const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    check("it is additive: two columns with defaults, IF NOT EXISTS; nothing altered, dropped, written or secured", statements.length === 2 && statements[0] === `ALTER TABLE "people_roster" ADD COLUMN IF NOT EXISTS "departments" jsonb DEFAULT '[]'::jsonb NOT NULL;` && statements[1] === `ALTER TABLE "people_roster" ADD COLUMN IF NOT EXISTS "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;`, statements);
    const ORG = `org-people-mig-${process.pid}`;
    const E1 = `kept-${process.pid}@people-mig.test`;
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'People migration', 'active') ON CONFLICT DO NOTHING`;
    await admin`INSERT INTO people_roster (email, org_id, name, team, manager_email, departments, attributes) VALUES (${E1}, ${ORG}, 'Kept', 'core', null, '["north"]'::jsonb, '{"grade": "g1"}'::jsonb)`;
    const rows = async () => JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM people_roster x WHERE org_id = ${ORG}`);
    const kept = await rows();
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it twice more, over a person who holds values, is harmless and changes no row", again === "ok" && (await rows()) === kept, again);
    await admin`DELETE FROM people_roster WHERE org_id = ${ORG}`;
    await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `people_directory_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      const plan = driftPlan(scratchUrl);
      check("a database built from schema.ts has both columns, and its drift plan is empty", pushed.status === 0 && !plan.error && plan.apply.length === 0 && plan.refused.length === 0 && (await sdb`select 1 from information_schema.columns where table_name = 'people_roster' and column_name in ('departments', 'attributes')`).length === 2, plan.error ? plan : { apply: plan.apply, refused: plan.refused });
      // As the live databases are before 0046: neither column, a person stored.
      await sdb.unsafe(`alter table "people_roster" drop column "departments"; alter table "people_roster" drop column "attributes"`);
      await sdb.unsafe(`insert into people_roster (email, org_id, name, manager_email) values ('before@x.test', 'org-x', 'Stored before', 'lead@x.test')`);
      const before = driftPlan(scratchUrl);
      check("before 0046 the drift plan names the two columns, and only them", !before.error && before.apply.length === 2 && before.apply.some((x) => /ADD COLUMN "departments"/.test(x)) && before.apply.some((x) => /ADD COLUMN "attributes"/.test(x)) && before.refused.length === 0, before.error ? before : { apply: before.apply, refused: before.refused });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0046 the drift dry run plans NOTHING, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
      const [stored] = await sdb`select manager_email, departments, attributes from people_roster where email = 'before@x.test'`;
      check("…and the person stored before it reads [] and {}, their reporting line untouched", stored?.manager_email === "lead@x.test" && JSON.stringify(stored.departments) === "[]" && JSON.stringify(stored.attributes) === "{}", stored);
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
  }

  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  check("people_roster is under the org_isolation policy", policies.some((p) => p.tablename === "people_roster"), policies.map((p) => p.tablename));
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/people-data-db-probe.mjs"];
  const run = (label, cwd, min) => {
    const r = spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    const finished = new RegExp(`people-data-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks >= min && (r.status === 0) === (bad === 0);
    if (finished) passed += 1;
    else {
      failures += 1;
      console.log(`  FAIL ${label}: the probe did not finish under that profile — ${out.slice(-1500)}`);
    }
  };
  console.log("\n1. The default profile (this checkout)");
  run("default", ROOT, 30);
  console.log("\n2. A declared people catalogue (scripts/fixtures/people/50-people.json), in a copy");
  const declared = copyWithProfiles(ROOT, [["50-people.json", join(ROOT, "scripts/fixtures/people/50-people.json")]]);
  try {
    run("declared", declared.dir, 35);
  } finally {
    declared.remove();
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-people-data-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
