#!/usr/bin/env node
/**
 * Work periods against a real, fail-closed Postgres, for the mode of THIS checkout's profile: two workspaces, the
 * real routes and the real agent tools as the restricted app_rw role, and the database read back as the admin.
 * scripts/test-work-periods-db.mjs runs it once per mode (this checkout, and a copy per fixture profile) and sets up
 * the policies; this file seeds its own two workspaces, pid- and mode-suffixed, and removes them.
 *
 * In every mode: workspace A reads none of B's periods, tasks or goals and can change none of them (rows under RLS,
 * the routes, the model's tools), and B's rows are byte for byte what they were after everything A did.
 * Then, per mode, what the mode is for. Needs ADMIN_URL and DATABASE_URL.
 */
import { generateKeyPairSync } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
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
if (!adminUrl || !process.env.DATABASE_URL) {
  console.log("work-period-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["TASK_WORKFLOW_SERVICE_URL", "TASK_WORKFLOW_SERVICE_TOKEN", "BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { WORK_PERIODS: WP } = await import(root("agent/lib/work-periods.ts"));
const MODE = WP.mode;
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   [${MODE}] ${what}`);
  } else {
    failures++;
    console.log(`  FAIL [${MODE}] ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 700)}`}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TAG = `${process.pid}-${MODE}`;
const A = `org-periods-a-${TAG}`;
const B = `org-periods-b-${TAG}`;
const ALICE = `alice-${TAG}@periods-a.test`; // A; amy reports to her
const AMY = `amy-${TAG}@periods-a.test`; // A
const BOB = `bob-${TAG}@periods-b.test`; // B
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY);

async function cleanup() {
  for (const t of ["cycle_member_goals", "todos", "cycles", "entity_activity", "comments", "people_roster", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

let closers = [];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Periods A', 'active'), (${B}, 'Periods B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ALICE}, 'member'), (${A}, ${AMY}, 'member'), (${B}, ${BOB}, 'member')`;
  await admin`INSERT INTO people_roster (email, org_id, name, manager_email) VALUES (${ALICE}, ${A}, 'Alice', null), (${AMY}, ${A}, 'Amy', ${ALICE}), (${BOB}, ${B}, 'Bob', null)`;
  const cycle = async (org, name, startsAt, endsAt, by, extra = {}) =>
    (await admin`INSERT INTO cycles (org_id, name, starts_at, ends_at, state, goal, lead, capacity, created_by)
                 VALUES (${org}, ${name}, ${startsAt}, ${endsAt}, 'active', ${extra.goal ?? null}, ${extra.lead ?? null}, ${extra.capacity ?? null}, ${by}) RETURNING id`)[0].id;
  // A0 / B0 ended two days ago and were never closed; A1 / B1 began then and contain now.
  const A0 = await cycle(A, "A zero", ago(9), ago(2), ALICE);
  const A1 = await cycle(A, "A one", ago(2), ago(-5), ALICE, { goal: "Shared goal", lead: ALICE, capacity: 3 });
  const B0 = await cycle(B, "B zero", ago(9), ago(2), BOB);
  const B1 = await cycle(B, "B one", ago(2), ago(-5), BOB, { lead: BOB });
  const todo = async (org, title, cycleId, assignee, by, done = false) =>
    (await admin`INSERT INTO todos (org_id, cycle_id, title, done, done_at, status, created_by, assignee)
                 VALUES (${org}, ${cycleId}, ${title}, ${done}, ${done ? new Date() : null}, ${done ? "done" : "open"}, ${by}, ${assignee}) RETURNING id`)[0].id;
  const tA1 = await todo(A, "amy open in A0", A0, AMY, ALICE);
  const tA2 = await todo(A, "alice open in A0", A0, ALICE, ALICE);
  const tA3 = await todo(A, "amy done in A0", A0, AMY, AMY, true);
  const tA4 = await todo(A, "alice open in A1", A1, null, ALICE); // no assignee: its creator's
  const tA5 = await todo(A, "no period", null, AMY, AMY);
  const tB0 = await todo(B, "bob open in B0", B0, BOB, BOB);
  const tB1 = await todo(B, "bob open in B1", B1, BOB, BOB);
  await admin`INSERT INTO cycle_member_goals (org_id, cycle_id, member, goal, target_count, updated_by) VALUES (${A}, ${A1}, ${AMY}, 'Amy goal', 3, ${AMY}), (${B}, ${B1}, ${BOB}, 'Bob goal', 2, ${BOB})`;

  /** Everything a workspace holds about periods, as the database has it. */
  const snapshot = async (org) =>
    JSON.stringify({
      cycles: await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${org} ORDER BY id`,
      todos: await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${org} ORDER BY id`,
      goals: await admin`SELECT to_jsonb(x) AS r FROM cycle_member_goals x WHERE org_id = ${org} ORDER BY id`,
    });
  const beforeA = await snapshot(A);
  const beforeB = await snapshot(B);
  const cycleOf = async (id) => (await admin`SELECT cycle_id FROM todos WHERE id = ${id}`)[0]?.cycle_id ?? null;
  const stateOf = async (id) => (await admin`SELECT state FROM cycles WHERE id = ${id}`)[0]?.state ?? null;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const { withOrgRls } = await import(root("lib/ops-db.ts"));
  const { sql } = await import("drizzle-orm");
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const bearers = {};
  for (const who of [ALICE, AMY, BOB]) bearers[who] = `Bearer ${await mintSessionToken(who)}`;
  const H = "http://periods.test";
  const call = async (who, file, method, path, { body, id } = {}) => {
    const handlers = await import(root(file));
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const cycles = (who, method = "GET", body) => call(who, "app/api/ops/cycles/route.ts", method, "/api/ops/cycles", { body });
  const cycleById = (who, method, id, body) => call(who, "app/api/ops/cycles/[id]/route.ts", method, `/api/ops/cycles/${id}`, { body, id });
  const rollover = (who, id, body = {}) => call(who, "app/api/ops/cycles/[id]/rollover/route.ts", "POST", `/api/ops/cycles/${id}/rollover`, { body, id });
  const goals = (who, method, id, body) => call(who, "app/api/ops/cycles/[id]/goals/route.ts", method, `/api/ops/cycles/${id}/goals`, { body, id });
  const todos = (who, body) => call(who, "app/api/ops/todos/route.ts", "POST", "/api/ops/todos", { body });
  const todoById = (who, id, body) => call(who, "app/api/ops/todos/[id]/route.ts", "PATCH", `/api/ops/todos/${id}`, { body, id });
  const exported = (who, id) => call(who, "app/api/ops/export/route.ts", "GET", `/api/ops/export?type=task&id=${id}`);
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => t.execute(input, ctxFor(who)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

  /* ---------------------------------------------------------------- every mode: the rows, under row-level security */
  const visible = async (org, table) => (await withOrgRls(org, (tx) => tx.execute(sql.raw(`SELECT org_id FROM ${table}`)))).map((r) => r.org_id);
  for (const table of ["cycles", "todos", "cycle_member_goals"]) {
    const seenA = await visible(A, table);
    check(`rows: workspace A reads only its own ${table} (and has some)`, seenA.length > 0 && seenA.every((o) => o === A), [...new Set(seenA)]);
  }
  const touched = await withOrgRls(A, async (tx) => ({
    cycles: (await tx.execute(sql`UPDATE cycles SET name = 'taken' WHERE id = ${B1} RETURNING id`)).length,
    todos: (await tx.execute(sql`UPDATE todos SET cycle_id = NULL WHERE id = ${tB1} RETURNING id`)).length,
    goals: (await tx.execute(sql`DELETE FROM cycle_member_goals WHERE cycle_id = ${B1} RETURNING id`)).length,
  }));
  check("rows: A can change none of B's periods, tasks or goals", same(touched, { cycles: 0, todos: 0, goals: 0 }), touched);
  const planted = await withOrgRls(A, (tx) => tx.execute(sql`INSERT INTO cycle_member_goals (org_id, cycle_id, member, updated_by) VALUES (${B}, ${B1}, 'x@x.test', 'x')`)).then(() => "inserted", (e) => String(e?.cause?.message ?? e?.message ?? e));
  check("rows: A cannot plant a goal in B", planted !== "inserted", planted);

  /* ------------------------------------------------------------------------------------------------ per mode */
  if (MODE === "off") {
    const answers = [
      await cycles(ALICE), await cycles(ALICE, "POST", { name: "x" }), await cycleById(ALICE, "PATCH", A1, { name: "x" }), await cycleById(ALICE, "DELETE", A1),
      await rollover(ALICE, A0), await goals(ALICE, "GET", A1), await goals(ALICE, "PUT", A1, { goal: "x" }),
    ].map((r) => r.status);
    check("off: every cycles route answers 404, with rows in the database", answers.every((s) => s === 404), answers);
    const refused = [await todos(ALICE, { title: "x", cycleId: A1 }), await todoById(ALICE, tA5, { cycleId: A1 })].map((r) => r.status);
    check("off: a task write that names a period is refused", refused.every((s) => s === 400), refused);
    const feeds = [
      await call(ALICE, "app/api/ops/activity/route.ts", "GET", `/api/ops/activity?entity=cycle&id=${A1}`),
      await call(ALICE, "app/api/ops/comments/route.ts", "GET", `/api/ops/comments?entity=cycle&id=${A1}`),
      await call(ALICE, "app/api/ops/comments/route.ts", "POST", "/api/ops/comments", { body: { entityType: "cycle", entityId: A1, author: ALICE, body: "x" } }),
      await call(ALICE, "app/api/ops/activity/route.ts", "GET", `/api/ops/activity?entity=task&id=${tA4}`),
    ].map((r) => r.status);
    check("off: there is no cycle entity to read or write activity or comments of; a task's are still read", same(feeds, [400, 400, 400, 200]), feeds);
    const ex = await exported(ALICE, tA4);
    check("off: an exported task carries no period: no pointer, no resolved period", ex.status === 200 && ex.body.record?.title === "alice open in A1" && !("cycleId" in ex.body.record) && !("cycle" in (ex.body.resolved ?? {})) && !JSON.stringify(ex.body).includes(A1), ex.body?.resolved);
    const listTool = (await import(root("agent/tools/list_cycles.ts"))).default;
    const upsertTool = (await import(root("agent/tools/upsert_cycle.ts"))).default;
    check("off: the model's two period tools are not tools at all (eve's disabled sentinel)", typeof listTool?.execute !== "function" && typeof upsertTool?.execute !== "function", [Object.keys(listTool ?? {}), Object.keys(upsertTool ?? {})]);
    check("off: STORED ROWS ARE UNTOUCHED, in both workspaces", (await snapshot(A)) === beforeA && (await snapshot(B)) === beforeB);
  }

  if (MODE === "team") {
    const list = await cycles(ALICE);
    const ids = (list.body?.items ?? []).map((c) => c.id).sort();
    check("team: A lists exactly its own periods", list.status === 200 && same(ids, [A0, A1].sort()), ids);
    check("team: reading the list rolls nothing over (auto_rollover is off by default)", (await snapshot(A)) === beforeA);
    check("team: there is no per-person goals route", (await goals(ALICE, "GET", A1)).status === 404 && (await goals(ALICE, "PUT", A1, { goal: "x" })).status === 404);
    const reach = [await cycleById(ALICE, "PATCH", B1, { name: "taken" }), await cycleById(ALICE, "DELETE", B1)].map((r) => r.status);
    check("team: A cannot rename or delete B's period by id", same(reach, [404, 404]), reach);
    const foreign = await rollover(ALICE, B1);
    check("team: a rollover of a period A does not hold moves nothing (the answer it has always had)", foreign.status === 200 && same(foreign.body, { ok: true, moved: 0 }), foreign);
    const intoB = await rollover(ALICE, A0, { target: B1 });
    check("team: a rollover INTO B's period is refused and moves nothing", intoB.status === 404 && (await cycleOf(tA1)) === A0, intoB);
    check("team: …and after all of that B is byte for byte what it was", (await snapshot(B)) === beforeB);
    const lead = await cycleById(ALICE, "PATCH", A1, { lead: AMY, capacity: 5 });
    check("team: a period takes a lead and a capacity", lead.status === 200 && lead.body?.item?.lead === AMY && lead.body.item.capacity === 5, lead);
    const ex = await exported(ALICE, tA4);
    check("team: an exported task resolves its period, with its lead", ex.status === 200 && same(ex.body.resolved?.cycle, { id: A1, name: "A one", state: "active", lead: AMY }), ex.body?.resolved);
    const rolled = await rollover(ALICE, A0, { target: null });
    check("team: rolling over sends the unfinished tasks to the backlog, whoever they belong to; done ones stay", rolled.status === 200 && rolled.body.moved === 2 && (await cycleOf(tA1)) === null && (await cycleOf(tA2)) === null && (await cycleOf(tA3)) === A0, rolled);
    await new Promise((r) => setTimeout(r, 300));
    const feed = await admin`SELECT event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'cycle' AND entity_id = ${A0} ORDER BY created_at DESC LIMIT 1`;
    check("team: …and the activity line reads as it always did", feed[0]?.event === "Rolled over 2 unfinished tasks to Backlog", feed);
    // A task write is forwarded untouched: anyone on the team may file a task for anyone.
    const forwarded = [await todos(AMY, { title: "x", cycleId: A1, assignee: ALICE }), await todoById(AMY, tA4, { status: "done" })].map((r) => r.status);
    check("team: a task write for somebody else is forwarded as before (503 here: the task service is not configured)", same(forwarded, [503, 503]), forwarded);

    const t = await import(root("agent/lib/todo-tools.ts"));
    const mine = await tool(t.listCyclesTool, {}, ALICE);
    check("team: the model's list_cycles returns exactly A's periods, in the shape it always had", same((mine.cycles ?? []).map((c) => c.id).sort(), [A0, A1].sort()) && same(Object.keys(mine.cycles[0]), ["id", "name", "startsAt", "endsAt"]) && same(Object.keys(mine), ["cycles"]), mine);
    const theirs = await tool(t.listCyclesTool, {}, BOB);
    check("team: …and B's session exactly B's", same((theirs.cycles ?? []).map((c) => c.id).sort(), [B0, B1].sort()), theirs);
    const taken = await tool(t.upsertCycleTool, { id: B1, name: "taken" }, ALICE);
    check("team: the model cannot rename B's period from A's session", taken.error === `No cycle with id "${B1}".` && (await admin`SELECT name FROM cycles WHERE id = ${B1}`)[0].name === "B one", taken);
    check("team: …and B is still byte for byte what it was", (await snapshot(B)) === beforeB);
  }

  if (MODE === "individual") {
    // Reading the list is what rolls an ended period over, inside the reader's own workspace.
    const list = await cycles(AMY);
    const ids = (list.body?.items ?? []).map((c) => c.id).sort();
    check("individual: A lists exactly its own periods", list.status === 200 && same(ids, [A0, A1].sort()), ids);
    check("individual: the ended period was closed, and each person's unfinished item moved to the period that follows, still theirs", (await stateOf(A0)) === "closed" && (await cycleOf(tA1)) === A1 && (await cycleOf(tA2)) === A1 && (await admin`SELECT assignee FROM todos WHERE id = ${tA1}`)[0].assignee === AMY, [await stateOf(A0), await cycleOf(tA1), await cycleOf(tA2)]);
    check("individual: a finished item stays where it was done, and a task in no period is left alone", (await cycleOf(tA3)) === A0 && (await cycleOf(tA5)) === null);
    const feed = await admin`SELECT actor, event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'cycle' AND entity_id = ${A0}`;
    check("individual: the rollover is on the period's activity feed, in the profile's words", feed.length === 1 && feed[0].actor === "system" && feed[0].event === `Rolled over 2 unfinished ${WP.itemLabel.plural} to A one`, feed);
    check("individual: A's read rolled over NOTHING of B's: B is byte for byte what it was, its ended period still open", (await snapshot(B)) === beforeB && (await stateOf(B0)) === "active" && (await cycleOf(tB0)) === B0);
    const again = await snapshot(A);
    await cycles(ALICE);
    check("individual: reading again changes nothing", (await snapshot(A)) === again);

    const gA = await goals(ALICE, "GET", A1);
    check("individual: A reads the goals of its period", gA.status === 200 && same(gA.body.items.map((g) => [g.member, g.goal, g.targetCount]), [[AMY, "Amy goal", 3]]), gA);
    const gB = await goals(ALICE, "GET", B1);
    check("individual: …and none of B's period's goals", gB.status === 200 && same(gB.body.items, []), gB);
    const plantB = await goals(ALICE, "PUT", B1, { goal: "planted" });
    check("individual: A cannot set a goal on B's period", plantB.status === 404 && (await snapshot(B)) === beforeB, plantB);
    const own = await goals(AMY, "PUT", A1, { goal: "Amy, revised", targetCount: 4 });
    check("individual: a person sets their own goal and planned count", own.status === 200 && same(own.body.item, { member: AMY, goal: "Amy, revised", targetCount: 4 }), own);
    const up = await goals(AMY, "PUT", A1, { member: ALICE, goal: "set by amy" });
    check("individual: …cannot set their manager's", up.status === 403 && /does not report to you/.test(up.body?.error ?? "") && (await admin`SELECT count(*)::int AS n FROM cycle_member_goals WHERE org_id = ${A} AND member = ${ALICE}`)[0].n === 0, up);
    const down = await goals(ALICE, "PUT", A1, { member: AMY, targetCount: 5 });
    check("individual: …and their manager (per the roster) can set theirs, changing only what was sent", down.status === 200 && same(down.body.item, { member: AMY, goal: "Amy, revised", targetCount: 5 }), down);

    // A task write is checked before it is forwarded: 503 below means "allowed, and the task service is not configured here".
    const r1 = await todos(AMY, { title: "for my manager", cycleId: A1, assignee: ALICE });
    check("individual: a person cannot set an item for someone they do not manage", r1.status === 403 && /does not report to you/.test(r1.body?.error ?? ""), r1);
    const r2 = await todos(AMY, { title: "mine", cycleId: A1 });
    const r3 = await todos(ALICE, { title: "for my reportee", cycleId: A1, assignee: AMY });
    check("individual: …can set their own, and a manager can set a reportee's", r2.status === 503 && r3.status === 503, [r2, r3]);
    const r4 = await todoById(AMY, tA4, { status: "done" });
    check("individual: a person cannot complete somebody else's item (one with no assignee is its creator's)", r4.status === 403, r4);
    const r5 = await todoById(ALICE, tA1, { status: "done" });
    const r6 = await todoById(ALICE, tA5, { title: "anyone may edit a task in no period" });
    check("individual: …a manager can complete a reportee's, and a task in no period is the team's as before", r5.status === 503 && r6.status === 503, [r5, r6]);
    const r7 = await todoById(AMY, tA5, { assignee: ALICE, cycleId: A1 });
    check("individual: a task cannot be handed to someone else as their item", r7.status === 403, r7);
    const r8 = await todos(AMY, { title: "into B", cycleId: B1 });
    check("individual: an item cannot be filed into B's period", r8.status === 404, r8);
    const led = await cycleById(ALICE, "PATCH", A1, { lead: AMY });
    check("individual: a period takes no lead and no capacity", led.status === 400 && (await admin`SELECT lead FROM cycles WHERE id = ${A1}`)[0].lead === ALICE, led);
    const ex = await exported(ALICE, tA4);
    check("individual: an exported task resolves its period without a lead", ex.status === 200 && same(ex.body.resolved?.cycle, { id: A1, name: "A one", state: "active" }), ex.body?.resolved);

    // One person's unfinished items, carried into the next period (opened, the profile's length long).
    const notMine = await rollover(AMY, A1, { assignee: ALICE });
    check("individual: a person cannot carry somebody else's items forward", notMine.status === 403 && (await cycleOf(tA2)) === A1, notMine);
    const mineOnly = await rollover(AMY, A1, { assignee: AMY });
    const [next] = await admin`SELECT id, name, starts_at, ends_at, state FROM cycles WHERE org_id = ${A} AND id NOT IN (${A0}, ${A1})`;
    check("individual: carrying my unfinished items forward opens the next period, the profile's length long, right after this one", mineOnly.status === 200 && mineOnly.body.moved === 1 && next && mineOnly.body.target === next.id && next.ends_at - next.starts_at === WP.lengthDays * DAY && Math.abs(next.starts_at - (await admin`SELECT ends_at FROM cycles WHERE id = ${A1}`)[0].ends_at) < 1000, [mineOnly, next]);
    check("individual: …mine moved, my manager's stayed", (await cycleOf(tA1)) === next?.id && (await cycleOf(tA2)) === A1 && (await cycleOf(tA4)) === A1);
    check("individual: the new period is named by the profile's word and its start date", next?.name === `${WP.label.singular[0].toUpperCase()}${WP.label.singular.slice(1)} of ${next?.starts_at.toISOString().slice(0, 10)}`, next?.name);
    check("individual: …and after everything A did, B is byte for byte what it was", (await snapshot(B)) === beforeB);

    // The model's tools, as the people themselves.
    const t = await import(root("agent/lib/todo-tools.ts"));
    const amys = await tool(t.listCyclesTool, {}, AMY);
    check("individual: the model lists A's periods and, by default, the signed-in person's own items in the current one", !amys.error && amys.person === AMY && amys.cycle?.id === A1 && amys.goal === "Amy, revised" && amys.planned === 5 && same(amys.items, []) && (amys.cycles ?? []).every((c) => [A0, A1, next.id].includes(c.id)) && amys.cycles.length === 3, amys);
    const alices = await tool(t.listCyclesTool, { person: ALICE }, AMY);
    check("individual: …or another person's, by name", alices.person === ALICE && same(alices.items.map((i) => i.id).sort(), [tA2, tA4].sort()) && alices.done === 0 && alices.planned === 2, alices);
    const bobs = await tool(t.listCyclesTool, { cycleId: A1 }, BOB);
    check("individual: B's session sees none of A's periods or items, even naming A's period", !bobs.error && bobs.cycle === null && same(bobs.items, []) && (bobs.cycles ?? []).length >= 2 && bobs.cycles.every((c) => ![A0, A1, next.id].includes(c.id)), bobs);
    check("individual: …and B's own read rolled B's ended period over, in B alone", (await stateOf(B0)) === "closed" && (await cycleOf(tB0)) === B1);
    const afterA = await snapshot(A);
    const refused = await tool(t.upsertTodoTool, { title: "for my manager", cycleId: "current", assignee: ALICE }, AMY);
    check("individual: the model cannot set an item for someone the signed-in person does not manage", /does not report to you/.test(refused.error ?? ""), refused);
    const allowed = await tool(t.upsertTodoTool, { title: "mine", cycleId: "current" }, AMY);
    check('individual: …it can add one for the signed-in person ("current" resolves; only the unconfigured task service stops it here)', /Task workflow service is not configured/.test(allowed.error ?? ""), allowed);
    const done = await tool(t.upsertTodoTool, { id: tA4, done: true }, AMY);
    check("individual: …and cannot complete somebody else's", /does not report to you/.test(done.error ?? ""), done);
    const goalUp = await tool(t.upsertCycleTool, { id: "current", person: ALICE, goal: "set by amy" }, AMY);
    check("individual: the model cannot set a manager's goal", /does not report to you/.test(goalUp.error ?? ""), goalUp);
    check("individual: …and none of those refusals wrote anything", (await snapshot(A)) === afterA);
    const goalOwn = await tool(t.upsertCycleTool, { id: "current", goal: "Via the model", planned: 2 }, AMY);
    check("individual: it sets the signed-in person's own goal", goalOwn.person === AMY && goalOwn.goal === "Via the model" && goalOwn.planned === 2 && goalOwn.cycle?.id === A1, goalOwn);
    const goalDown = await tool(t.upsertCycleTool, { id: A1, person: AMY, planned: 6 }, ALICE);
    check("individual: …and a manager's session sets a reportee's", goalDown.person === AMY && goalDown.planned === 6 && goalDown.goal === "Via the model", goalDown);
    const takenB = await tool(t.upsertCycleTool, { id: B1, goal: "planted" }, AMY);
    check("individual: the model cannot touch B's period from A's session", /No cycle with id/.test(takenB.error ?? ""), takenB);
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${MODE}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const close of closers) await Promise.resolve(close()).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`work-period-db-probe [${MODE}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
