#!/usr/bin/env node
/**
 * AN IMPLEMENTATION ROW HAS ITS OWN ID, AND A RENAMED OWN FIELD IS READ UNDER BOTH KEYS, against a real Postgres, as the
 * restricted app_rw role under the production FAIL-CLOSED policies (scripts/lib/implementation-ids-db-probe.mjs):
 *
 *   0. the migration (drizzle/0044_implementation_own_id.sql) on a database the journal built up to 0043, holding
 *      rows in two workspaces under the same account id: every row is given its account id as its id and nothing is
 *      lost or changed; the key becomes (org_id, implementation_id), the account's rows keep an index; a row written by
 *      code that predates the column gets its account id; a second row for one account is now possible; applying it
 *      again is harmless; the deploy's drift dry run plans nothing after it;
 *   1. the default (this checkout, one per account): every write path keeps one row per account, its id the account's;
 *      `implementations[]` is refused; the list, the workbook and the record read as before;
 *   2. one per account with two own fields renamed (frameworks.json without `per_account`): rows written under the old
 *      keys are filtered, sorted, searched, computed and counted by the server under the new keys;
 *   3. several per account (frameworks.json, `per_account: "many"`): the ops routes, upsert_customer's
 *      `implementations[]`, the per-area tools, the MCP tools, the metrics and the workbook address each row by its
 *      own id; an id of another account's row is refused; the renamed fields as in 2;
 *   2 and 3 both: workspace B, holding an account with the same id, reaches none of A's rows.
 *
 * Needs ADMIN_URL (policy DDL, seeding, scratch databases) and DATABASE_URL (app_rw); without them it skips. Every
 * policy is restored and every scratch database dropped.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:implementation-ids-db
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
  console.log("test-implementation-ids-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let failures = 0;
let passed = 0;
const saved = new Map();
const check = (what, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${what}`); }
  else { failures++; console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`); }
};
// Found by its name, not its number: a migration merged at the same time may take the number first.
const JOURNAL = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const TAG = JOURNAL.entries.find((e) => /^\d{4}_implementation_own_id$/.test(e.tag))?.tag ?? "0044_implementation_own_id";
const statementsOf = (tag) => readFileSync(join(ROOT, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);

try {
  console.log(`0. The migration (drizzle/${TAG}.sql) on a database the journal built, two workspaces, one account id`);
  // Its own failure is its own: the record areas below are checked whatever it found.
  try {
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1, journal.entries.slice(-2));
    if (at <= 0) throw new Error(`${TAG} is not in the journal`);
    const { driftPlan } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `impl_ids_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      // Every entry before 0044, each in its own transaction, as migrate-production.mjs applies them.
      for (const e of journal.entries.slice(0, at)) await sdb.begin(async (tx) => { for (const x of statementsOf(e.tag)) await tx.unsafe(x); });
      const W1 = "org-impl-one";
      const W2 = "org-impl-two";
      for (const org of [W1, W2]) {
        await sdb`insert into orgs (org_id, name, status) values (${org}, ${org}, 'active') on conflict do nothing`;
        for (const co of ["acme", "beta", "gamma"]) {
          await sdb`insert into customers (org_id, customer_id, customer_name) values (${org}, ${co}, ${`${co} (${org})`})`;
          if (co === "gamma") continue;
          await sdb`insert into implementation (org_id, customer_id, rollout_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, blocker, custom)
                    values (${org}, ${co}, ${`R-${co}`}, 'UAT', ${org === W1 ? 40 : 60}, 'Green', 'None', ${`${co} blocker in ${org}`}, ${sdb.json({ note: `${co}/${org}`, n: 3 })})`;
        }
      }
      const rowsOf = async () => (await sdb`select to_jsonb(i) - 'implementation_id' as r from implementation i order by org_id, customer_id`).map((x) => JSON.stringify(x.r));
      const before = await rowsOf();
      check("before 0044 the key is (org_id, customer_id): one row per account", (await sdb`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'implementation_org_id_customer_id_pk'`)[0]?.d === "PRIMARY KEY (org_id, customer_id)");
      await sdb.begin(async (tx) => { for (const x of statementsOf(TAG)) await tx.unsafe(x); });
      const after = await rowsOf();
      check("after 0044 every row is there with every value it had (4 rows, two workspaces)", after.length === 4 && JSON.stringify(after) === JSON.stringify(before), { before, after });
      const ids = await sdb`select org_id, customer_id, implementation_id from implementation order by 1, 2`;
      check("…and each was given its account id as its own id", ids.length === 4 && ids.every((r) => r.implementation_id === r.customer_id), ids);
      const [pk] = await sdb`select conname, pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'implementation'::regclass and contype = 'p'`;
      check("the key is (org_id, implementation_id), under schema.ts's name", pk?.conname === "implementation_org_id_implementation_id_pk" && pk.d === "PRIMARY KEY (org_id, implementation_id)", pk);
      const [idx] = await sdb`select indexdef from pg_indexes where tablename = 'implementation' and indexname = 'implementation_org_id_customer_id_idx'`;
      check("the account's rows keep an index on (org_id, customer_id)", /USING btree \(org_id, customer_id\)$/.test(idx?.indexdef ?? ""), idx);
      const [fk] = await sdb`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'implementation_customer_fk'`;
      check("the foreign key to the account is unchanged (org_id, customer_id, cascading)", /FOREIGN KEY \(org_id, customer_id\) REFERENCES customers\(org_id, customer_id\) ON DELETE CASCADE/.test(fk?.d ?? ""), fk);
      await sdb`insert into implementation (org_id, customer_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner) values (${W1}, 'gamma', 'Kickoff', 0, 'Green', 'None')`;
      check("a row written by code that predates the column gets its account id", (await sdb`select implementation_id from implementation where org_id = ${W1} and customer_id = 'gamma'`)[0]?.implementation_id === "gamma");
      let second = "ok";
      try { await sdb`insert into implementation (org_id, customer_id, implementation_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner) values (${W1}, 'acme', 'acme-second', 'Kickoff', 0, 'Green', 'None')`; } catch (e) { second = String(e?.message ?? e); }
      check("a second row for one account is now possible, under its own id", second === "ok" && (await sdb`select count(*)::int as n from implementation where org_id = ${W1} and customer_id = 'acme'`)[0].n === 2, second);
      let dup = "inserted";
      try { await sdb`insert into implementation (org_id, customer_id, implementation_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner) values (${W1}, 'beta', 'acme', 'Kickoff', 0, 'Green', 'None')`; } catch (e) { dup = String(e?.code ?? e); }
      check("an id is the workspace's: another account cannot take one held", dup === "23505", dup);
      let again = "ok";
      try { await sdb.begin(async (tx) => { for (const x of statementsOf(TAG)) await tx.unsafe(x); }); } catch (e) { again = String(e?.message ?? e); }
      check("applying it again is harmless, and changes nothing", again === "ok" && (await sdb`select count(*)::int as n from implementation`)[0].n === 6, again);
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
    // The deploy's drift dry run (schema.ts against the database), on a database built as a live one is (pushed from
    // schema.ts), put back in its shape before 0044: the plan names the change, and after 0044 plans nothing at all.
    const { kit } = await import("./lib/drift-plan.mjs");
    const PUSHED = `impl_ids_push_${process.pid}`;
    const pushedUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${PUSHED}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${PUSHED}" with (force)`);
    await admin.unsafe(`create database "${PUSHED}"`);
    const pdb = postgres(pushedUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], pushedUrl);
      const fresh = driftPlan(pushedUrl);
      check("a database built from schema.ts has the new key, and its drift plan is empty", pushed.status === 0 && !fresh.error && fresh.apply.length === 0 && fresh.refused.length === 0 && (await pdb`select 1 from pg_constraint where conname = 'implementation_org_id_implementation_id_pk'`).length === 1, fresh.error ? fresh : { apply: fresh.apply, refused: fresh.refused });
      await pdb.unsafe(`drop index "implementation_org_id_customer_id_idx";
        alter table "implementation" drop constraint "implementation_org_id_implementation_id_pk";
        alter table "implementation" add constraint "implementation_org_id_customer_id_pk" primary key ("org_id", "customer_id");
        alter table "implementation" drop column "implementation_id";`);
      const planBefore = driftPlan(pushedUrl);
      check("put back as it was before 0044, the drift plan names the new column, key and index", !planBefore.error && planBefore.apply.some((x) => /ADD COLUMN "implementation_id"/.test(x)) && planBefore.apply.some((x) => /implementation_org_id_implementation_id_pk/.test(x)) && planBefore.apply.some((x) => /implementation_org_id_customer_id_idx/.test(x)), planBefore.error ? planBefore : { apply: planBefore.apply, refused: planBefore.refused });
      await pdb`insert into orgs (org_id, name, status) values ('org-push', 'push', 'active') on conflict do nothing`;
      await pdb`insert into customers (org_id, customer_id, customer_name) values ('org-push', 'acme', 'Acme')`;
      await pdb`insert into implementation (org_id, customer_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner) values ('org-push', 'acme', 'UAT', 5, 'Green', 'None')`;
      await pdb.begin(async (tx) => { for (const x of statementsOf(TAG)) await tx.unsafe(x); });
      const after = driftPlan(pushedUrl);
      check("after 0044 the deploy's drift dry run plans NOTHING, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
      check("…and its row was given its account id", (await pdb`select implementation_id from implementation where org_id = 'org-push'`)[0]?.implementation_id === "acme");
    } finally {
      await pdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${PUSHED}" with (force)`).catch(() => {});
    }
  } catch (e) {
    check("the migration could be checked", false, String(e?.message ?? e));
  }

  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/implementation-ids-db-probe.mjs"];
  const run = (label, cwd) => {
    const r = spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    const finished = new RegExp(`implementation-ids-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks > 3 && (r.status === 0) === (bad === 0);
    if (finished) passed += 1;
    else {
      failures += 1;
      console.log(`  FAIL ${label}: the probe did not finish under that definition — ${out.slice(-1500)}`);
    }
  };
  const inCopy = (label, profiles) => {
    let copy;
    try {
      copy = copyWithProfiles(ROOT, profiles);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL ${label}: the profile does not build — ${String(e?.message ?? e).slice(-900)}`);
      return;
    }
    try { run(label, copy.dir); } finally { copy.remove(); }
  };
  const FRAMEWORKS = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-areas/examples/frameworks.json"), "utf8"));
  const oneEach = structuredClone(FRAMEWORKS);
  delete oneEach.records.areas.implementations.per_account;
  console.log("\n1. The default (this checkout): one per account");
  run("one", ROOT);
  console.log("\n2. One per account, two own fields renamed (frameworks.json without per_account), in a copy");
  inCopy("renamed", [["50-frameworks.json", oneEach]]);
  console.log("\n3. Several per account (frameworks.json, per_account \"many\"), in a copy");
  inCopy("many", [["50-frameworks.json", join(ROOT, "scripts/fixtures/record-areas/examples/frameworks.json")]]);
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-implementation-ids-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
