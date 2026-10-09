#!/usr/bin/env node
/**
 * WORK PERIODS AGAINST A REAL POSTGRES, IN EACH MODE, as the restricted app_rw role under the production FAIL-CLOSED
 * policies. The half of scripts/test-work-periods.mjs that needs a database.
 *
 *   0. THE MIGRATION (drizzle/0030_cycle_member_goals.sql): the table is row-level secured and forced, with the
 *      org_isolation policy its neighbours have; applying the file again is harmless and touches no row.
 *   0b. A WORKSPACE'S OWN LENGTH (drizzle/0033_org_period_length.sql): one nullable column on `orgs`, additive, harmless
 *      applied again, and the deploy's drift dry run plans nothing after it.
 *   1-3. For each mode (team: this checkout; individual and off: a copy of it under scripts/fixtures/work-periods/),
 *      scripts/lib/work-period-db-probe.mjs seeds two workspaces and proves:
 *        every mode   A reads none of B's periods, tasks or goals and can change none of them (the rows under RLS,
 *                     the routes, the model's tools); B is byte for byte what it was after everything A did;
 *        team         the routes and the model's tools answer as they always did; rollover goes to the backlog;
 *        individual   an ended period rolls over inside its own workspace only, each person's unfinished items
 *                     moving to their next period; a goal or an item is set for oneself or a reportee per the
 *                     roster, never for anyone else, at the routes and at the model's tools alike;
 *        off          every route is a 404 and STORED ROWS ARE UNTOUCHED.
 *      and, in two more workspaces, the period length a workspace admin chooses: a member cannot, a value outside the
 *      profile's range is refused, one workspace's admin cannot reach another's, the change is audited, and the
 *      periods opened afterwards (by hand, by the model's tool, by auto rollover) run that long while the other
 *      workspace's run the profile's and every period that existed keeps its dates; under "off" the route is a 404.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:work-periods-db
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
  console.log("test-work-periods-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 600)}`}`);
  }
};

const saved = new Map();
try {
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  const [{ rolbypassrls, rolsuper, current_user: who }] = await app`SELECT r.rolbypassrls, r.rolsuper, current_user FROM pg_roles r WHERE r.rolname = current_user`;
  await app.end();
  if (rolbypassrls || rolsuper) throw new Error(`${who} bypasses RLS — this test would prove nothing`);

  /* ------------------------------------------------------------------------------------------ 0. the migration */
  console.log("\n0. The migration (drizzle/0030_cycle_member_goals.sql)");
  const T = "cycle_member_goals";
  const [cls] = await admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${T} AND relnamespace = 'public'::regnamespace`;
  check("the table exists, row-level secured and forced", cls?.relrowsecurity === true && cls.relforcerowsecurity === true, cls);
  const policyBefore = await admin`SELECT policyname, permissive, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ${T}`;
  check("it has the org_isolation policy its neighbours have, and no other", policyBefore.length === 1 && policyBefore[0].policyname === "org_isolation" && policyBefore[0].permissive === "PERMISSIVE", policyBefore);
  const cols = (await admin`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${T} ORDER BY ordinal_position`).map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`);
  check("its columns are the ones schema.ts declares", JSON.stringify(cols) === JSON.stringify(["id:uuid:NO", "org_id:text:NO", "cycle_id:uuid:NO", "member:text:NO", "goal:text:YES", "target_count:integer:YES", "updated_by:text:NO", "created_at:timestamp with time zone:NO", "updated_at:timestamp with time zone:NO"]), cols);
  const [uidx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cycle_member_goals_member_uidx'`;
  check("one row per (workspace, period, person)", /UNIQUE INDEX .* \(org_id, cycle_id, member\)/.test(uidx?.indexdef ?? ""), uidx);
  const [grant] = await admin`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants WHERE table_name = ${T} AND grantee = 'app_rw'`;
  check("app_rw may read and write it, and nothing more", grant?.p === "DELETE,INSERT,SELECT,UPDATE", grant);

  const sqlFile = readFileSync(join(ROOT, "drizzle/0030_cycle_member_goals.sql"), "utf8");
  check("the migration is additive: it creates and secures one table and drops or rewrites nothing that exists", !/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(sqlFile) && !/\bUPDATE\s+"/i.test(sqlFile) && !/\bALTER\s+TABLE\s+"(?!cycle_member_goals")/i.test(sqlFile) && !/\bDELETE\s+FROM\b/i.test(sqlFile));
  const ORG = `org-periods-mig-${process.pid}`;
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Periods migration', 'active') ON CONFLICT DO NOTHING`;
  const [c] = await admin`INSERT INTO cycles (org_id, name, created_by) VALUES (${ORG}, 'kept', 'x') RETURNING id`;
  await admin`INSERT INTO cycle_member_goals (org_id, cycle_id, member, goal, target_count, updated_by) VALUES (${ORG}, ${c.id}, 'a@x.test', 'kept', 2, 'x')`;
  const rows = async () => JSON.stringify([await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${ORG}`, await admin`SELECT to_jsonb(x) AS r FROM cycle_member_goals x WHERE org_id = ${ORG}`]);
  const kept = await rows();
  let applied = "ok";
  try {
    for (let i = 0; i < 2; i++) for (const stmt of sqlFile.split("--> statement-breakpoint")) if (stmt.replace(/^\s*--.*$/gm, "").trim()) await admin.unsafe(stmt);
  } catch (e) {
    applied = String(e?.message ?? e);
  }
  check("applying it twice more, over a table that holds rows, is harmless", applied === "ok", applied);
  check("…and no row moved: the goal and the period it belongs to are byte for byte what they were", (await rows()) === kept);
  // The file re-creates the policy in the form every table ships with; put back the one this database had.
  await admin.unsafe(`ALTER POLICY org_isolation ON "${T}" USING (${policyBefore[0].qual}) WITH CHECK (${policyBefore[0].with_check ?? policyBefore[0].qual})`);
  await admin`DELETE FROM cycle_member_goals WHERE org_id = ${ORG}`;
  await admin`DELETE FROM cycles WHERE org_id = ${ORG}`;
  await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;

  /* --------------------------------------------- 0b. a workspace's own period length (drizzle/0033_org_period_length.sql) */
  console.log("\n0b. A workspace's own period length (drizzle/0033_org_period_length.sql)");
  {
    const TAG = "0033_org_period_length";
    const [col] = await admin`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orgs' AND column_name = 'period_length_days'`;
    check("orgs.period_length_days exists: a nullable whole number with no default (null = the profile's length)", col?.data_type === "integer" && col.is_nullable === "YES" && col.column_default === null, col);
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1, journal.entries[at]);
    const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    check("it is additive: one nullable column added to orgs, and nothing else altered, dropped, written or secured", statements.length === 1 && /^ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "period_length_days" integer;$/.test(statements[0]), statements);
    const ORG = `org-plen-mig-${process.pid}`;
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Length migration', 'active') ON CONFLICT DO NOTHING`;
    await admin`UPDATE orgs SET period_length_days = 21 WHERE org_id = ${ORG}`;
    const orgsBefore = JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM orgs x ORDER BY org_id`);
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it twice more, over workspaces that hold a length, is harmless and changes no row", again === "ok" && JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM orgs x ORDER BY org_id`) === orgsBefore, again);
    await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;

    // The deploy's drift step against a database as the live ones are before 0033: the plan names the column and only
    // it; after the file, it plans nothing.
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `plenmig_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      check("a database built from schema.ts has the column", pushed.status === 0 && (await sdb`select 1 from information_schema.columns where table_name = 'orgs' and column_name = 'period_length_days'`).length === 1, pushed.out.slice(-300));
      await sdb.unsafe('alter table "orgs" drop column "period_length_days"');
      const before = driftPlan(scratchUrl);
      check("before 0033 the drift plan against schema.ts names the column, and only it", !before.error && before.apply.length === 1 && /ADD COLUMN "period_length_days" integer/.test(before.apply[0]) && before.refused.length === 0, before.error ? before : { apply: before.apply, refused: before.refused });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0033 the drift dry run plans NOTHING to apply, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
  }

  /* ---------------------------------------------------------------------------------------- 1-3. each mode */
  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`\norg_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);

  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/work-period-db-probe.mjs"];
  const runProbe = (cwd) => spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const report = (mode, r) => {
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    check(`mode ${mode}: the probe ran in that mode and finished (${oks} passed, ${bad} failed)`, new RegExp(`work-period-db-probe \\[${mode}\\]: \\d+ passed`).test(out) && oks > 5 && (r.status === 0) === (bad === 0), out.slice(-1500));
  };
  console.log("\n1. Mode team (this checkout, the default profile)");
  report("team", runProbe(ROOT));
  for (const [n, mode] of [[2, "individual"], [3, "off"]]) {
    console.log(`\n${n}. Mode ${mode} (a copy under scripts/fixtures/work-periods/50-${mode}.json)`);
    const copy = copyWithProfiles(ROOT, [[`50-${mode}.json`, join(ROOT, `scripts/fixtures/work-periods/50-${mode}.json`)]]);
    try {
      report(mode, runProbe(copy.dir));
    } finally {
      copy.remove();
    }
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-work-periods-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
