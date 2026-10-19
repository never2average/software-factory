#!/usr/bin/env node
/**
 * ONE PERSON ON SEVERAL WORKSPACES' ROSTERS (mold_v1-285): people_roster is keyed by (org_id, email), drizzle/0049.
 *
 * Workspaces are unaware of each other: the same people may be on several workspaces' rosters, each workspace seeing
 * and changing only its own row. With the email alone as the key, workspace B adding someone A holds failed with a
 * database error. Proven here:
 *
 *   A. THE LIVE SHAPE: pushed from the schema before the per-workspace keys (scripts/fixtures/schema-419b38d.ts),
 *      bootstrapped (app_rw, row-level security, every policy), the journal up to 0049, then seeded like production:
 *      three workspaces, 300 people, reporting lines, escalations, departments and attributes, archived rows. Before
 *      0049 the same email in a second workspace is refused (the bug) and the drift plan names the key. Then 0049 in
 *      one transaction, as migrate-production.mjs runs it: no row lost or changed, the key is (org_id, email) under
 *      schema.ts's name, org_id NOT NULL, row-level security and every policy on the table unchanged, the deploy's
 *      drift dry run plans NOTHING and refuses nothing, and 0049 again changes nothing. Afterwards one email sits in
 *      two workspaces, an update or delete in one leaves the other's row alone.
 *   B. A JOURNAL-BUILT DATABASE (org_id nullable there): rows of no workspace whose email has several accepted
 *      memberships, none, or only a pending invitation make 0049 REFUSE, naming the count, and change nothing (each
 *      kind alone too); once each has exactly one accepted membership, the row takes that workspace; nothing lost;
 *      harmless twice.
 *   C. A DATABASE THAT RAN THE OLD ONE-OFF TIGHTENING SCRIPT (key already (org_id, email), named people_roster_pkey):
 *      0049 puts it under schema.ts's name; the drift plan is empty.
 *   F. THE LIVE SHAPE, what 0049 must not lose or wait behind: behind a transaction holding the roster it fails on
 *      its 5-second lock timeout instead of queueing every roster read; an index other than the key on email makes it
 *      refuse, naming the index, instead of dropping it with the column; a varchar(320) COLLATE "C" column is moved
 *      with exactly that type and collation. Each refusal changes nothing.
 *   D. AN EMPTY DATABASE: push --force from schema.ts, the journal after the 0013 baseline, the bootstrap: the key is
 *      schema.ts's, the plan holds nothing on people_roster.
 *   E. THE APP, as the restricted app_rw role under the production FAIL-CLOSED policies, two workspaces holding the
 *      same people: B's owner adds a person A holds (200, B's own row); every route (the roster, its template, the
 *      bulk and workbook imports, the person's dossier) and every tool and reader (list_roster, upsert_roster_member,
 *      the roster context block, the workflow data API, the work-period store's reporting lines, the identity
 *      snapshot) answers each workspace only its own row; a write in A never touches B's; reporting lines are per
 *      workspace (A: s -> m and B: m -> s both stand; the same line in A again is a loop and refused).
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE; the main database pushed from schema.ts and bootstrapped) and
 * DATABASE_URL (app_rw on it). Scratch databases carry this process's pid and are dropped in a finally block; every
 * policy flipped for part E is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:roster-key-db
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { driftPlan, kit, stopsToAsk } from "./lib/drift-plan.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The app's own modules, as the agent and the web app import them: `@/`, `#lib/` and eve's `.js` -> `.ts` specifiers.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(ROOT + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        if (s.startsWith("#lib/")) s = ROOT + "agent/lib/" + s.slice(5);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-roster-key-db: SKIPPED — needs ADMIN_URL (a role that may create a database) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0049_people_roster_key_per_workspace";
const PK = "people_roster_org_id_email_pk";

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
const statementsOf = (tag) => readFileSync(join(ROOT, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
const entry = journal.entries.find((e) => e.tag === TAG);
const BEFORE = journal.entries.filter((e) => e.idx < entry.idx);
const FROM_ON = journal.entries.filter((e) => e.idx >= entry.idx);

const scratch = [];
async function freshDb(label) {
  const name = `rkmig_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
/** Journal entries, each migration in one transaction, as migrate-production.mjs applies them. */
const applyEntries = async (db, entries) => { for (const e of entries) await db.begin(async (tx) => { for (const s of statementsOf(e.tag)) await tx.unsafe(s); }); };
/** 0049 and every entry after it, in ONE transaction, as migrate-production.mjs runs every pending migration. */
const apply0049 = (db) => db.begin(async (tx) => { for (const e of FROM_ON) for (const s of statementsOf(e.tag)) await tx.unsafe(s); });
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
/** The live database's shape: pushed from the schema before the per-workspace keys, bootstrapped, the journal since. */
async function liveShape(db, url) {
  const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
  if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
  const b = bootstrap(url);
  if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
  // Every entry from 0024 (the first after that schema) up to 0049, as the deploys since have applied them.
  await applyEntries(db, BEFORE.filter((e) => e.idx >= 24));
}

const W = ["org-rk-one", "org-rk-two", "org-rk-three"];
/** Three workspaces, 100 people each (emails distinct: the old key allowed nothing else), lines, fields, archives. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W[0]}, 'One', 'active', now() - interval '2 years'), (${W[1]}, 'Two', 'active', now() - interval '1 year'), (${W[2]}, 'Three', 'active', now())`;
  for (const [w, org] of W.entries()) {
    for (let i = 0; i < 100; i++) {
      const email = `p${String(i).padStart(3, "0")}@w${w}.rk.test`;
      const manager = i === 0 ? null : `p${String(Math.floor((i - 1) / 4)).padStart(3, "0")}@w${w}.rk.test`;
      await db`insert into people_roster (email, org_id, name, team, manager_email, escalations, departments, attributes, archived_at)
               values (${email}, ${org}, ${`Person ${i}`}, ${`team-${i % 5}`}, ${manager},
                       ${i % 7 === 0 ? db.json([{ email: `p000@w${w}.rk.test`, reason: "client escalation" }]) : null},
                       ${db.json(i % 3 === 0 ? ["north"] : [])}, ${db.json(i % 4 === 0 ? { grade: `g${i % 3}`, on_call: true } : {})},
                       ${i % 25 === 24 ? db`now() - interval '3 days'` : null})`;
    }
    await db`insert into org_members (org_id, email, role) values (${org}, ${`p000@w${w}.rk.test`}, 'owner')`;
  }
}
const ROW = "(to_jsonb(x) - 'updated_at')";
const fingerprint = async (db) => (await db.unsafe(`select count(*)::int as n, md5(coalesce(string_agg(${ROW}::text, '|' order by ${ROW}::text), '')) as h from people_roster x`))[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkOf = async (db) => (await db`
    select con.conname, (select string_agg(a.attname, ',' order by k.n) from unnest(con.conkey) with ordinality k(attnum, n)
                          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols
      from pg_constraint con where con.contype = 'p' and con.conrelid = 'public.people_roster'::regclass`);
const checkKey = async (db, label) => {
  const pk = await pkOf(db);
  check(`${label}: people_roster's key is (org_id, email), named ${PK} as schema.ts names it, and it is the only key`, pk.length === 1 && pk[0].conname === PK && pk[0].cols === "org_id,email", pk);
  const nullable = await db`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'people_roster' and column_name in ('org_id', 'email') and is_nullable = 'YES'`;
  check(`${label}: org_id and email are NOT NULL`, nullable.length === 0, nullable);
  const [order] = await db`select (select attnum from pg_attribute where attrelid = 'public.people_roster'::regclass and attname = 'org_id') < (select attnum from pg_attribute where attrelid = 'public.people_roster'::regclass and attname = 'email') as ok`;
  check(`${label}: org_id stands before email (the key's order, which the drift step reads from the table)`, order.ok === true);
  const uniq = await db`select conname from pg_constraint where contype = 'u' and conrelid = 'public.people_roster'::regclass`;
  check(`${label}: no unique constraint on the email alone is left`, uniq.length === 0, uniq);
};
/** Row-level security and every policy on the table, as the database has them. */
const security = async (db) => ({
  rls: (await db`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.people_roster'::regclass`)[0],
  policies: await db`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'people_roster' order by policyname`,
  grants: await db`select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'people_roster' order by 1, 2`,
});
const onRoster = (x) => x.includes('"people_roster"');
const checkPlanEmpty = (url, label, { rosterOnly = false } = {}) => {
  const plan = driftPlan(url);
  if (rosterOnly) {
    const other = plan.apply?.filter((x) => !onRoster(x)) ?? [];
    check(`${label}: the drift dry run plans nothing on people_roster (${other.length} older unrelated statement(s))`, !plan.error && plan.apply.filter(onRoster).length === 0, plan.error ? plan : plan.apply.filter(onRoster));
  } else {
    check(`${label}: the drift dry run plans NOTHING to apply (0049 did the whole change)`, !plan.error && plan.apply.length === 0, plan.error ? plan : plan.apply);
  }
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, !plan.error && plan.refused.length === 0, plan.refused);
  check(`${label}: …and nothing it sets aside touches a key`, !plan.error && plan.aside.every((x) => !/CONSTRAINT|PRIMARY KEY/i.test(x)), plan.aside);
};
/** One email in two workspaces; an update or delete in one leaves the other's row alone; lines per workspace. */
const checkBehaviour = async (db, label) => {
  const e = "p001@w0.rk.test";
  const add = await db`insert into people_roster (email, org_id, name, team, manager_email) values (${e}, ${W[1]}, 'Also in two', 'two-team', 'p000@w1.rk.test') returning org_id`.then((r) => r.length, (x) => x.message);
  check(`${label}: workspace two adds ${e}, whom workspace one holds`, add === 1, add);
  const dup = await db`insert into people_roster (email, org_id) values (${e}, ${W[1]})`.then(() => "inserted", (x) => x.code);
  check(`${label}: …and a second row for it in the SAME workspace is refused by the key (23505)`, dup === "23505", dup);
  const oneBefore = await db`select ${db.unsafe(ROW)} as r from people_roster x where org_id = ${W[0]} and email = ${e}`;
  await db`update people_roster set team = 'moved' where org_id = ${W[1]} and email = ${e}`;
  const oneAfter = await db`select ${db.unsafe(ROW)} as r from people_roster x where org_id = ${W[0]} and email = ${e}`;
  check(`${label}: an update in workspace two leaves workspace one's row alone`, same(oneBefore, oneAfter) && oneAfter[0]?.r.team === "team-1", oneAfter);
  const lines = await db`select org_id, manager_email from people_roster where email = ${e} order by org_id`;
  check(`${label}: …each row keeps its own reporting line (one: p000@w0, two: p000@w1)`, same(lines.map((l) => [l.org_id, l.manager_email]), [[W[0], "p000@w0.rk.test"], [W[1], "p000@w1.rk.test"]]), lines);
  await db`delete from people_roster where org_id = ${W[1]} and email = ${e}`;
  const left = await db`select org_id from people_roster where email = ${e}`;
  check(`${label}: deleting workspace two's row leaves workspace one's`, same(left.map((r) => r.org_id), [W[0]]), left);
};

try {
  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, the journal to 0048, seeded) -> 0049 -> the drift dry run`);
  {
    const { db, url } = await freshDb("a");
    await liveShape(db, url);
    await seed(db);
    const f0 = await fingerprint(db);
    check("seeded like production: 300 people in 3 workspaces", f0.n === 300, f0);
    const pk0 = await pkOf(db);
    check("the live shape keys people_roster on the email alone", pk0.length === 1 && pk0[0].cols === "email", pk0);
    const bug = await db`insert into people_roster (email, org_id, name) values ('p001@w0.rk.test', ${W[1]}, 'In two')`.then(() => "inserted", (e) => e.code);
    check("before 0049, workspace two adding a person workspace one holds fails with a database error (the bug, 23505)", bug === "23505", bug);
    const planBefore = driftPlan(url);
    check("before 0049, the drift plan names the key change (or cannot plan yet), so an empty plan after it means something", (!planBefore.error && planBefore.apply.some((x) => onRoster(x) && /PRIMARY KEY|CONSTRAINT/.test(x))) || stopsToAsk(url), planBefore.error ?? planBefore.apply);
    const sec0 = await security(db);
    await apply0049(db);
    check("0049 applies, and no row is lost or changed", same(await fingerprint(db), f0));
    await checkKey(db, "after 0049");
    check("row-level security, every policy and every grant on people_roster are exactly as before", same(await security(db), sec0) && sec0.rls.relrowsecurity === true && sec0.policies.length > 0, { sec0, after: await security(db) });
    checkPlanEmpty(url, "after 0049");
    await apply0049(db);
    check("0049 again: nothing changes", same(await fingerprint(db), f0));
    await checkKey(db, "after 0049 twice");
    await checkBehaviour(db, "A");
    await db.end();
  }

  console.log("\nB. A journal-built database (org_id nullable) with rows that have no workspace -> 0049");
  {
    const { db } = await freshDb("b");
    await applyEntries(db, BEFORE);
    await seed(db);
    // Three rows of no workspace the migration must not guess about: a pending invitation only, accepted memberships
    // of two workspaces, and no membership at all.
    await db`insert into org_members (org_id, email, role, accepted_at) values (${W[2]}, 'pending-only@rk.test', 'member', null), (${W[1]}, 'two-orgs@rk.test', 'member', now()), (${W[2]}, 'two-orgs@rk.test', 'member', now())`;
    await db`insert into people_roster (email, org_id, name) values ('pending-only@rk.test', null, 'Pending only'), ('two-orgs@rk.test', null, 'Two workspaces'), ('nobody@rk.test', null, 'No membership')`;
    const f0 = await fingerprint(db);
    const refused = await apply0049(db).then(() => "applied", (e) => e.message);
    check("0049 REFUSES rows of no workspace it would have to guess (pending only, two workspaces, none), naming the count", /people_roster has 3 row\(s\) with no workspace/.test(refused), refused);
    check("…and changes nothing: every row as it was, the key still the email alone, org_id still nullable", same(await fingerprint(db), f0) && (await pkOf(db))[0]?.cols === "email" && (await db`select is_nullable from information_schema.columns where table_name = 'people_roster' and column_name = 'org_id'`)[0].is_nullable === "YES");
    // Each kind alone is refused too.
    const orphans = { "pending-only@rk.test": "a pending invitation only", "two-orgs@rk.test": "accepted in two workspaces", "nobody@rk.test": "no membership" };
    await db`delete from people_roster where org_id is null`;
    for (const [e, kind] of Object.entries(orphans)) {
      await db`insert into people_roster (email, org_id, name) values (${e}, null, ${kind})`;
      const one = await apply0049(db).then(() => "applied", (x) => x.message);
      check(`…a single row of no workspace with ${kind}: refused (1 row), nothing changed`, /has 1 row\(s\) with no workspace/.test(one) && (await pkOf(db))[0]?.cols === "email", one);
      await db`delete from people_roster where email = ${e}`;
    }
    await db`insert into people_roster (email, org_id, name) values ('pending-only@rk.test', null, 'Pending only')`;
    // The operator's fix: the pending invitation is accepted. Its row now has exactly one accepted membership, as has
    // a second row whose email also holds a pending invitation elsewhere (which does not count).
    await db`update org_members set accepted_at = now() where email = 'pending-only@rk.test'`;
    await db`insert into org_members (org_id, email, role, accepted_at) values (${W[1]}, 'accepted-one-pending-one@rk.test', 'member', now()), (${W[0]}, 'accepted-one-pending-one@rk.test', 'member', null)`;
    await db`insert into people_roster (email, org_id, name) values ('accepted-one-pending-one@rk.test', null, 'Accepted in one, invited to another')`;
    const n0 = (await fingerprint(db)).n;
    await apply0049(db);
    const orgOf = async (e) => (await db`select org_id from people_roster where email = ${e}`).map((r) => r.org_id);
    check("no row is lost", (await fingerprint(db)).n === n0, n0);
    check("a row with no workspace takes the one workspace its email has an ACCEPTED membership of (a pending one elsewhere does not count)", same(await orgOf("pending-only@rk.test"), [W[2]]) && same(await orgOf("accepted-one-pending-one@rk.test"), [W[1]]));
    await checkKey(db, "journal-built, after 0049");
    const f1 = await fingerprint(db);
    await apply0049(db);
    check("0049 again: nothing changes", same(await fingerprint(db), f1));
    await checkBehaviour(db, "B");
    await db.end();
  }

  console.log("\nC. The live shape after the old one-off tightening script (key (org_id, email) as people_roster_pkey) -> 0049");
  {
    const { db, url } = await freshDb("c");
    await liveShape(db, url);
    await seed(db);
    await db.unsafe(`alter table people_roster drop constraint people_roster_pkey; alter table people_roster add primary key (org_id, email)`);
    const f0 = await fingerprint(db);
    await apply0049(db);
    check("0049 applies over it, and no row is lost or changed", same(await fingerprint(db), f0));
    await checkKey(db, "tightened, after 0049");
    checkPlanEmpty(url, "tightened, after 0049");
    await db.end();
  }

  console.log("\nF. The live shape: what 0049 must not lose or wait behind -> refusals, then the column's own type and collation");
  {
    const { db, url } = await freshDb("f");
    await liveShape(db, url);
    await seed(db);
    const f0 = await fingerprint(db);
    // A long transaction holding the roster (an ACCESS SHARE lock, as any open read does) while 0049 needs it exclusively.
    const holder = postgres(url, { ssl, prepare: false, max: 1, onnotice: () => {} });
    let release;
    const held = new Promise((r) => { release = r; });
    let locked;
    const lockTaken = new Promise((r) => { locked = r; });
    const holding = holder.begin(async (tx) => { await tx`lock table people_roster in access share mode`; locked(); await held; });
    await lockTaken;
    const t0 = Date.now();
    const waited = await apply0049(db).then(() => "applied", (e) => `${e.code} ${e.message}`);
    const took = Date.now() - t0;
    release();
    await holding;
    await holder.end({ timeout: 2 });
    check(`behind a transaction holding the roster, 0049 fails on its lock timeout (55P03) instead of queueing (${took} ms)`, /^55P03 /.test(waited) && took < 15_000, waited);
    check("…and changes nothing", same(await fingerprint(db), f0) && (await pkOf(db))[0]?.cols === "email");
    await db`create index people_roster_email_lower_idx on people_roster (lower(email))`;
    const indexed = await apply0049(db).then(() => "applied", (e) => e.message);
    check("an index other than the key on email (here by expression): 0049 refuses, naming it, instead of dropping it with the column", /people_roster_email_lower_idx/.test(indexed) && /nothing was changed/.test(indexed), indexed);
    check("…and changes nothing: the index and every row are still there", same(await fingerprint(db), f0) && (await db`select 1 from pg_indexes where indexname = 'people_roster_email_lower_idx'`).length === 1);
    await db`drop index people_roster_email_lower_idx`;
    // A database whose column is not plain text: the move keeps the type and the collation exactly.
    await db.unsafe(`alter table people_roster alter column email type varchar(320) collate "C"`);
    const colOf = async () => (await db`select format_type(a.atttypid, a.atttypmod) as type, c.collname from pg_attribute a left join pg_collation c on c.oid = a.attcollation where a.attrelid = 'public.people_roster'::regclass and a.attname = 'email'`)[0];
    const before = await colOf();
    const fv = await fingerprint(db);
    await apply0049(db);
    const after = await colOf();
    check(`a varchar(320) COLLATE "C" email column is moved as it is (${after.type}, ${after.collname}), every row unchanged`, before.type === "character varying(320)" && same(after, before) && same(await fingerprint(db), fv), { before, after });
    await checkKey(db, "varchar column, after 0049");
    await db.end();
  }

  console.log("\nD. An empty database: push --force from schema.ts, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("d");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force from schema.ts builds an empty database", p.status === 0 && /Changes applied/.test(p.out), p.out.slice(-600));
    await applyEntries(db, journal.entries.filter((x) => x.idx > 13));
    const b = bootstrap(url);
    check("…the journal after it and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    await checkKey(db, "empty database, pushed");
    checkPlanEmpty(url, "empty database, pushed", { rosterOnly: true });
    await db.end();
  }

  console.log("\nE. The app, as app_rw under the fail-closed policies: two workspaces holding the same people");
  await appBehaviour();
} catch (error) {
  failures.push("the test itself");
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const name of scratch) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
  await admin.end({ timeout: 2 }).catch(() => {});
}

if (failures.length) {
  console.error(`\ntest-roster-key-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-roster-key-db: all ${passed} checks passed`);
process.exit(0);

async function appBehaviour() {
  const [main] = await admin`select (select count(*)::int from pg_constraint where conname = ${PK}) as n`;
  if (main.n !== 1) throw new Error(`the main database has no ${PK}: push it from schema.ts and bootstrap it first`);
  for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
  process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "roster-key-db-"));
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
  const root = (p) => pathToFileURL(`${ROOT}/${p}`).href;

  const T = process.pid;
  const A = `org-rk-a-${T}`;
  const B = `org-rk-b-${T}`;
  const OWN_A = `own-a-${T}@rk-a.test`;
  const OWN_B = `own-b-${T}@rk-b.test`;
  // S and M are on BOTH rosters and members of both workspaces.
  const S = `s-${T}@rk-shared.test`;
  const M = `m-${T}@rk-shared.test`;
  const NEW = `new-${T}@rk-shared.test`;
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  const saved = new Map();
  const closers = [];
  const cleanup = async () => {
    for (const t of ["people_roster", "org_members", "automation_audit"]) await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
    await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
  };
  try {
    const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
    if (!policies.some((p) => p.tablename === "people_roster")) throw new Error("people_roster has no org_isolation policy — run scripts/bootstrap-test-db.mjs first");
    const closed = `(org_id = current_setting('app.org_id', true))`;
    for (const p of policies) {
      saved.set(p.tablename, p);
      await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
    }
    await cleanup();
    await admin`INSERT INTO orgs (org_id, name, status, created_at) VALUES (${A}, 'Roster A', 'active', now() - interval '1 day'), (${B}, 'Roster B', 'active', now())`;
    await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${OWN_A}, 'owner'), (${A}, ${S}, 'member'), (${A}, ${M}, 'member'), (${B}, ${OWN_B}, 'owner'), (${B}, ${S}, 'member'), (${B}, ${M}, 'member')`;
    // A holds S (reporting to M) and M. B holds only M so far: B's owner adds S below, through the route.
    await admin`INSERT INTO people_roster (email, org_id, name, team, manager_email) VALUES (${S}, ${A}, 'S of A', 'a-team', ${M}), (${M}, ${A}, 'M of A', 'a-team', null), (${M}, ${B}, 'M of B', 'b-team', null)`;

    const { NextRequest } = await import("next/server");
    const { mintSessionToken } = await import(root("lib/auth-session.ts"));
    const agentDb = await import(root("agent/lib/db/index.ts"));
    closers.push(() => agentDb.closeDb?.());
    const bearers = Object.fromEntries(await Promise.all([OWN_A, OWN_B, S].map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
    const ROUTES = {
      "/api/ops/roster": "app/api/ops/roster/route.ts",
      "/api/ops/roster/bulk": "app/api/ops/roster/bulk/route.ts",
      "/api/ops/roster/template": "app/api/ops/roster/template/route.ts",
      "/api/ops/roster/import": "app/api/ops/roster/import/route.ts",
    };
    const call = async (who, org, method, path, { body, form, params } = {}) => {
      const file = ROUTES[path] ?? "app/api/ops/people/[email]/route.ts";
      const handlers = await import(root(file));
      const headers = { authorization: bearers[who], "x-ops-org": org };
      if (body !== undefined) headers["content-type"] = "application/json";
      const request = new NextRequest(`http://roster.test${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const res = await handlers[method](request, params ? { params: Promise.resolve(params) } : undefined);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* not json */ }
      return { status: res.status, body: json, bytes };
    };
    const roster = async (who, org) => (await call(who, org, "GET", "/api/ops/roster")).body?.items ?? [];
    const dossier = (who, org, email) => call(who, org, "GET", `/api/ops/people/${encodeURIComponent(email)}`, { params: { email: encodeURIComponent(email) } });
    const rowsOf = async (org) => JSON.stringify(await admin`SELECT to_jsonb(x) - 'updated_at' AS r FROM people_roster x WHERE org_id = ${org} ORDER BY email`);
    const rowOf = async (org, email) => (await admin`SELECT name, team, manager_email FROM people_roster WHERE org_id = ${org} AND email = ${email}`)[0];
    const tools = await import(root("agent/lib/roster-tools.ts"));
    const ctxFor = (email, org) => ({ session: { id: `sess-rk-${T}-${email}-${org}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email, org } } } } });
    const tool = (t, input, who, org) => Promise.resolve().then(() => t.execute(input, ctxFor(who, org))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    const { parseRosterWorkbook, buildRosterWorkbook } = await import(root("lib/roster-workbook.ts"));

    // ---------------------------------------------------------------------------------------- the bug, through the route
    const aBefore = await rowsOf(A);
    const added = await call(OWN_B, B, "POST", "/api/ops/roster", { body: { email: S, name: "S of B", team: "b-team" } });
    check("B's owner adds a person A holds through POST /api/ops/roster: 200 (was a database error), B's own row", added.status === 200 && added.body?.item?.name === "S of B" && (await rowOf(B, S))?.team === "b-team", added);
    check("…and A's rows are untouched", (await rowsOf(A)) === aBefore);
    const line = await call(OWN_B, B, "POST", "/api/ops/roster", { body: { email: M, managerEmail: S } });
    check("B's owner sets m -> s in B while A holds s -> m: 200 (lines are per workspace, so it closes no loop)", line.status === 200 && (await rowOf(B, M))?.manager_email === S && (await rowOf(A, S))?.manager_email === M && (await rowOf(A, M))?.manager_email === null, line);
    const loopA = await call(OWN_A, A, "POST", "/api/ops/roster", { body: { email: M, managerEmail: S } });
    check("…the same line in A is a loop with A's own s -> m: 400, nothing stored", loopA.status === 400 && /reporting loop/.test(loopA.body?.error ?? "") && (await rowsOf(A)) === aBefore, loopA);
    const outsider = await call(OWN_A, A, "POST", "/api/ops/roster", { body: { email: S, managerEmail: OWN_B } });
    check("…and A's owner naming B's owner (of B only) as supervisor: 400 not in this workspace", outsider.status === 400 && /is not in this workspace/.test(outsider.body?.error ?? "") && (await rowsOf(A)) === aBefore, outsider);

    // ------------------------------------------------------------------------------------------ every reader, per workspace
    const ra = await roster(OWN_A, A);
    const rb = await roster(OWN_B, B);
    const one = (items, e) => items.filter((i) => i.email === e);
    check("GET /api/ops/roster: A reads its own s (a-team, reports to m) once; B reads its own s (b-team, no line) once", one(ra, S).length === 1 && one(ra, S)[0].team === "a-team" && one(ra, S)[0].managerEmail === M && one(rb, S).length === 1 && one(rb, S)[0].team === "b-team" && one(rb, S)[0].managerEmail === null && one(rb, M)[0]?.managerEmail === S && one(ra, M)[0]?.managerEmail === null, { ra, rb });
    const sa = await roster(S, A);
    const sb = await roster(S, B);
    check("…s, a member of both, reads A's rows in A and B's rows in B", one(sa, S)[0]?.name === "S of A" && one(sb, S)[0]?.name === "S of B" && sa.length === ra.length && sb.length === rb.length, { sa, sb });
    const da = await dossier(OWN_A, A, S);
    const db_ = await dossier(OWN_B, B, S);
    check("GET /api/ops/people/:email: A's dossier of s has A's team and chain (m); B's has B's team, no chain, m as reportee", da.status === 200 && da.body.team === "a-team" && da.body.managerEmail === M && same(da.body.chainUp.map((c) => c.email), [M]) && da.body.reportees.length === 0 && db_.status === 200 && db_.body.team === "b-team" && db_.body.managerEmail === null && db_.body.chainUp.length === 0 && same(db_.body.reportees.map((r) => r.email), [M]), { a: da.body, b: db_.body });
    const tpl = await call(OWN_B, B, "GET", "/api/ops/roster/template");
    const parsedTpl = tpl.status === 200 ? await parseRosterWorkbook(tpl.bytes) : null;
    check("GET /api/ops/roster/template: B's workbook holds B's rows only (s on b-team)", parsedTpl && parsedTpl.people.length === 2 && parsedTpl.people.find((p) => p.email === S)?.team === "b-team" && !parsedTpl.people.some((p) => p.email.endsWith("@rk-a.test")), parsedTpl ?? tpl.status);
    const la = await tool(tools.listRosterTool, {}, S, A);
    const lb = await tool(tools.listRosterTool, {}, S, B);
    check("list_roster: s in A reads A's s; s in B reads B's s", la.roster?.filter((x) => x.email === S).length === 1 && la.roster.find((x) => x.email === S).team === "a-team" && lb.roster?.filter((x) => x.email === S).length === 1 && lb.roster.find((x) => x.email === S).team === "b-team", { la, lb });
    const { loadRosterContext } = await import(root("agent/lib/prompt-context-blocks.ts"));
    const [ca, cb] = [await loadRosterContext(A), await loadRosterContext(B)];
    const ctxOf = (env) => env.filter((e) => e.id === S).map((e) => [e.audience.orgId, e.data.team]);
    check("the roster context block the model is given: A's s in A, B's s in B", ca.length === 2 && cb.length === 2 && same(ctxOf(ca), [[A, "a-team"]]) && same(ctxOf(cb), [[B, "b-team"]]), { ca, cb });
    const { workflowDataFor } = await import(root("lib/workflow-data.ts"));
    const [wa, wb] = [await workflowDataFor(A).roster("{}"), await workflowDataFor(B).roster("{}")];
    check("the workflow data API's roster: each workspace's own rows", wa.length === 2 && wb.length === 2 && wa.find((r) => r.email === S)?.team === "a-team" && wb.find((r) => r.email === S)?.team === "b-team", { wa, wb });
    const { withOrgRls } = await import(root("lib/ops-db.ts"));
    const { rosterLines } = await import(root("agent/lib/work-period-store.ts"));
    const { workspacePeople } = await import(root("agent/lib/people-data.ts"));
    const linesOf = async (org) => (await withOrgRls(org, (tx) => rosterLines(tx, org))).map((l) => `${l.email}>${l.managerEmail ?? ""}`).sort();
    check("the work-period store's reporting lines: A has s -> m, B has m -> s", same(await linesOf(A), [`${M}>`, `${S}>${M}`]) && same(await linesOf(B), [`${M}>${S}`, `${S}>`]), { A: await linesOf(A), B: await linesOf(B) });
    const wpA = await withOrgRls(A, (tx) => workspacePeople(tx, A));
    const wpB = await withOrgRls(B, (tx) => workspacePeople(tx, B));
    check("the reporting check's view of the workspace: A's lines and people, B's lines and people", wpA.lines.get(S) === M && wpA.lines.get(M) === null && wpB.lines.get(M) === S && wpB.lines.get(S) === null && !wpA.people.has(OWN_B) && !wpB.people.has(OWN_A), { A: [...wpA.lines], B: [...wpB.lines] });
    const { identitySnapshot } = await import(root("agent/lib/people-directory.ts"));
    const snapOf = async (org) => {
      const rows = await app.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${org}, true)`;
        return tx`SELECT org_id AS "orgId", email, name, manager_email AS "managerEmail", departments, attributes, archived_at AS "archivedAt" FROM people_roster`;
      });
      const members = await app.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${org}, true)`;
        return tx`SELECT org_id AS "orgId", email, role FROM org_members WHERE org_id = ${org}`;
      });
      return { rows: [...rows], snap: identitySnapshot(org, [...rows], [...members]) };
    };
    const [ia, ib] = [await snapOf(A), await snapOf(B)];
    check("the identity snapshot from rows read under RLS: A's s reports to m, B's m reports to s; each holds its own rows only", ia.rows.every((r) => r.orgId === A) && ib.rows.every((r) => r.orgId === B) && same(ia.snap.reporting.map((r) => [r.reportee, r.reporting_manager]), [[S, M]]) && same(ib.snap.reporting.map((r) => [r.reportee, r.reporting_manager]), [[M, S]]), { a: ia.snap.reporting, b: ib.snap.reporting });

    // -------------------------------------------------------------------------------------- every writer, never the other
    let bBefore = await rowsOf(B);
    const up = await tool(tools.upsertRosterMemberTool, { email: S, team: "a-two" }, OWN_A, A);
    check("upsert_roster_member in A changes A's s only", up.ok === true && (await rowOf(A, S)).team === "a-two" && (await rowsOf(B)) === bBefore, up);
    const upNew = await tool(tools.upsertRosterMemberTool, { email: NEW, name: "New in A" }, OWN_A, A);
    check("…adds a new person to A only", upNew.ok === true && (await rowOf(A, NEW))?.name === "New in A" && !(await rowOf(B, NEW)) && (await rowsOf(B)) === bBefore, upNew);
    const upB = await tool(tools.upsertRosterMemberTool, { email: NEW, name: "New in B" }, OWN_B, B);
    let aNow = await rowsOf(A);
    check("…and the same new person to B, as B's own row, leaving A's", upB.ok === true && (await rowOf(B, NEW))?.name === "New in B" && (await rowOf(A, NEW))?.name === "New in A", upB);
    const post = await call(OWN_A, A, "POST", "/api/ops/roster", { body: { email: S, name: "S renamed in A" } });
    bBefore = await rowsOf(B);
    check("POST /api/ops/roster in A renames A's s only", post.status === 200 && (await rowOf(A, S)).name === "S renamed in A" && (await rowOf(B, S)).name === "S of B", post);
    aNow = await rowsOf(A);
    const bPre = await rowOf(B, S);
    const bulk = await call(OWN_B, B, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: S, team: "b-bulk" }, { email: `bulk-${T}@rk-shared.test`, name: "Bulk" }] } });
    check("the bulk import in B updates B's s and adds to B only; A's rows untouched", bulk.status === 200 && bulk.body.updated === 1 && bulk.body.created === 1 && (await rowOf(B, S)).team === "b-bulk" && (await rowsOf(A)) === aNow, bulk);
    const undoOf = (res, e) => res.body?.snapshot?.find((x) => x.email === e);
    check("…its undo is B's exact prior state: s existed with B's values (not A's), the new person did not", undoOf(bulk, S)?.existed === true && undoOf(bulk, S)?.team === bPre.team && undoOf(bulk, S)?.name === bPre.name && undoOf(bulk, `bulk-${T}@rk-shared.test`)?.existed === false, bulk.body?.snapshot);
    const bulkA = await call(OWN_A, A, "POST", "/api/ops/roster/bulk", { body: { people: [{ email: `bulk-${T}@rk-shared.test`, name: "Bulk in A" }] } });
    bBefore = await rowsOf(B);
    check("…the same new person in A's bulk import is created in A (B holding them is no conflict)", bulkA.status === 200 && bulkA.body.created === 1 && (await rowOf(A, `bulk-${T}@rk-shared.test`))?.name === "Bulk in A" && (await rowOf(B, `bulk-${T}@rk-shared.test`))?.name === "Bulk", bulkA);
    const book = await buildRosterWorkbook([{ email: S, name: "S of A", team: "a-book", managerEmail: M }, { email: M, name: "M of A", team: "a-team", managerEmail: null }, { email: OWN_B, name: "B's owner, on A's roster", team: "a-team", managerEmail: null }], A, new Date().toISOString());
    const form = new FormData();
    form.set("file", new File([new Uint8Array(book)], "roster.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    form.set("apply", "1");
    const imp = await call(OWN_A, A, "POST", "/api/ops/roster/import", { form });
    check("…its counts and undo are exact: s existed in A (with A's values), B's owner was new to A's roster", imp.body?.created === 1 && undoOf(imp, S)?.existed === true && undoOf(imp, S)?.team === "a-two" && undoOf(imp, OWN_B)?.existed === false, imp.body);
    check("the workbook import in A writes A's rows (s's team, B's owner added as A's own row) and B's are untouched", imp.status === 200 && imp.body?.applied === true && (await rowOf(A, S)).team === "a-book" && (await rowOf(A, OWN_B))?.name === "B's owner, on A's roster" && (await rowsOf(B)) === bBefore, imp);

    // A person added by ANOTHER writer between the read and the insert (the race every importer has): the insert stands
    // down on the key, the row is read, locked and updated, and the answer says it existed, with the other writer's row.
    const { writeRosterRow } = await import(root("agent/lib/people-data.ts"));
    const RACE = `race-${T}@rk-shared.test`;
    const raced = await withOrgRls(A, (tx) => writeRosterRow(tx, A, RACE, async (before) => {
      if (!before) await admin`INSERT INTO people_roster (email, org_id, name, team) VALUES (${RACE}, ${A}, 'Added meanwhile', 'theirs') ON CONFLICT DO NOTHING`;
      return { updatedAt: new Date(), team: "ours" };
    }));
    check("a person another writer adds between the read and the insert: updated, not a database error; created false, the pre-image theirs", raced.created === false && raced.before?.name === "Added meanwhile" && raced.before?.team === "theirs" && raced.row.team === "ours" && raced.row.name === "Added meanwhile" && !(await rowOf(B, RACE)), raced);

    // ------------------------------------------------------------------------------------------- the rows under RLS
    aNow = await rowsOf(A);
    const inB = await app.begin(async (tx) => { await tx`select set_config('app.org_id', ${B}, true)`; return tx`SELECT org_id FROM people_roster WHERE email = ${S}`; });
    const upd = await app.begin(async (tx) => { await tx`select set_config('app.org_id', ${B}, true)`; return tx`UPDATE people_roster SET name = 'B wrote by email' WHERE email = ${S} RETURNING org_id`; });
    check("under RLS, B selecting s by email alone reads one row, B's; updating by email alone changes B's only", same(inB.map((r) => r.org_id), [B]) && same(upd.map((r) => r.org_id), [B]) && (await rowsOf(A)) === aNow, { inB, upd });
    const del = await app.begin(async (tx) => { await tx`select set_config('app.org_id', ${B}, true)`; return tx`DELETE FROM people_roster WHERE email = ${S} RETURNING org_id`; });
    check("…deleting s by email alone in B deletes B's row; A's s is still there, unchanged", same(del.map((r) => r.org_id), [B]) && (await rowsOf(A)) === aNow && (await rowOf(A, S))?.team === "a-book", del);
  } finally {
    await cleanup().catch(() => undefined);
    for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
    for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
    await app.end({ timeout: 2 }).catch(() => undefined);
  }
}
