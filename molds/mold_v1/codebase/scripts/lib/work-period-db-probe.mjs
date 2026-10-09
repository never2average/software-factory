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
  /* ------------------------------------------- every mode: a workspace's own period length (orgs.period_length_days) */
  // Two fresh workspaces: C, whose admin chooses a length, and D, which never does. Each has one period that ended
  // two days ago (seven days long) with an unfinished item in it, so a rollover has something to open a period for.
  {
    const C = `org-plen-c-${TAG}`; const D = `org-plen-d-${TAG}`;
    const OWN = `owen-${TAG}@plen-c.test`; const MEM = `mia-${TAG}@plen-c.test`; const DOWN = `dora-${TAG}@plen-d.test`;
    for (const who of [OWN, MEM, DOWN]) bearers[who] = `Bearer ${await mintSessionToken(who)}`;
    const extraCleanup = async () => {
      for (const t of ["todos", "cycles", "entity_activity", "automation_audit", "people_roster", "org_members"]) await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [C, D]).catch(() => undefined);
      await admin`DELETE FROM orgs WHERE org_id IN (${C}, ${D})`.catch(() => undefined);
    };
    closers.unshift(extraCleanup);
    await extraCleanup();
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${C}, 'Length C', 'active'), (${D}, 'Length D', 'active')`;
    await admin`INSERT INTO org_members (org_id, email, role) VALUES (${C}, ${OWN}, 'owner'), (${C}, ${MEM}, 'member'), (${D}, ${DOWN}, 'owner')`;
    await admin`INSERT INTO people_roster (email, org_id, name, manager_email) VALUES (${OWN}, ${C}, 'Owen', null), (${MEM}, ${C}, 'Mia', ${OWN}), (${DOWN}, ${D}, 'Dora', null)`;
    const C0 = await cycle(C, "C zero", ago(9), ago(2), OWN);
    const D0 = await cycle(D, "D zero", ago(9), ago(2), DOWN);
    const tC = await todo(C, "mia open in C0", C0, MEM, MEM);
    const tD = await todo(D, "dora open in D0", D0, DOWN, DOWN);
    // A checkout without the route (the code before it) fails each check below by name instead of stopping here.
    const length = (who, method, org, body) => call(who, "app/api/ops/orgs/[id]/period-length/route.ts", method, `/api/ops/orgs/${org}/period-length`, { body, id: org }).catch((e) => ({ status: `no route (${String(e?.message ?? e).slice(0, 60)})`, body: {} }));
    const orgRow = (who, org) => call(who, "app/api/ops/orgs/[id]/route.ts", "GET", `/api/ops/orgs/${org}`, { id: org });
    const stored = async (org) => (await admin`SELECT period_length_days AS d FROM orgs WHERE org_id = ${org}`)[0]?.d ?? null;
    const windowOf = async (id) => (await admin`SELECT to_jsonb(x) - 'state' - 'updated_at' AS r FROM cycles x WHERE id = ${id}`)[0]?.r;
    const daysLong = (row) => (row?.ends_at && row?.starts_at ? Math.round((new Date(row.ends_at) - new Date(row.starts_at)) / DAY) : null);
    const C0before = await windowOf(C0);
    const audits = async (org) => (await admin`SELECT actor, event FROM automation_audit WHERE org_id = ${org} AND automation_type = 'org' ORDER BY created_at`).map((r) => r);

    const g = await orgRow(OWN, C);
    check("length: the workspace settings answer (GET /api/ops/orgs/{id}) is what it was, with no period length in it", g.status === 200 && !!g.body?.item && !("periodLengthDays" in g.body.item), g.body);

    if (MODE === "off") {
      const answers = [await length(OWN, "GET", C), await length(OWN, "PUT", C, { lengthDays: 14 })].map((r) => r.status);
      check("length (off): the setting does not exist: GET and PUT answer 404, and nothing is stored", same(answers, [404, 404]) && (await stored(C)) === null, answers);
      check("length (off): …and nothing is audited", (await audits(C)).length === 0);
    } else {
      const P = await import(root("agent/lib/work-periods.ts"));
      const POLICY = P.PERIOD_LENGTH ?? { workspaceCanSet: true, min: 1, max: 90 };
      const CHOSEN = Math.min(POLICY.max, Math.max(POLICY.min, (WP.lengthDays ?? 7) * 2));
      const read = await length(MEM, "GET", C);
      check("length: a member reads the workspace's length: the deployment's default, read-only for them", read.status === 200 && read.body.lengthDays === null && read.body.effectiveDays === WP.lengthDays && read.body.defaultDays === WP.lengthDays && read.body.canEdit === false && read.body.workspaceCanSet === true, read.body);
      const asAdmin = await length(OWN, "GET", C);
      check("length: …an admin reads that they may change it, and the range", asAdmin.status === 200 && asAdmin.body.canEdit === true && asAdmin.body.min === POLICY.min && asAdmin.body.max === POLICY.max, asAdmin.body);
      const byMember = await length(MEM, "PUT", C, { lengthDays: CHOSEN });
      check("length: a member cannot set it (403), and nothing is stored or audited", byMember.status === 403 && (await stored(C)) === null && (await audits(C)).length === 0, byMember);
      const bad = [];
      for (const v of [0, POLICY.min - 1, POLICY.max + 1, 7.5, String(CHOSEN), true]) bad.push([v, (await length(OWN, "PUT", C, { lengthDays: v })).status]);
      const extra = await length(OWN, "PUT", C, { lengthDays: CHOSEN, orgId: D });
      check("length: an admin's out-of-range or malformed value is refused (400), and nothing is stored", bad.every(([, s]) => s === 400) && extra.status === 400 && (await stored(C)) === null, [bad, extra.status]);
      const across = await length(OWN, "PUT", D, { lengthDays: CHOSEN });
      const acrossRead = await length(OWN, "GET", D);
      check("length: C's admin can neither set nor read D's (403), and D's is untouched", across.status === 403 && acrossRead.status === 403 && (await stored(D)) === null, [across, acrossRead.status]);
      const set = await length(OWN, "PUT", C, { lengthDays: CHOSEN });
      check(`length: an admin sets it (${CHOSEN} days): stored on C's own row, D's still the default`, set.status === 200 && set.body.lengthDays === CHOSEN && set.body.effectiveDays === CHOSEN && (await stored(C)) === CHOSEN && (await stored(D)) === null, set);
      const trail = await audits(C);
      check("length: the change is in C's audit trail, by the admin, in the deployment's words; none in D's", trail.length === 1 && trail[0].actor === OWN && trail[0].event.includes(`${WP.label.singular} length`) && trail[0].event.includes(`to ${CHOSEN} days`) && (await audits(D)).length === 0, trail);
      const feed = await call(OWN, "app/api/ops/orgs/[id]/audit/route.ts", "GET", `/api/ops/orgs/${C}/audit`, { id: C });
      check("length: …and the admin reads it in the workspace's audit feed", feed.status === 200 && (feed.body?.items ?? []).some((r) => r.event === trail[0]?.event), feed.body?.items?.length);
      check("length: setting it changed no period: C's existing one keeps its dates", same(await windowOf(C0), C0before));

      if (MODE === "individual") {
        // Auto rollover, on a member's read: C's ended period is followed by one the workspace's length long, D's by one the profile's.
        await cycles(MEM);
        const [cNext] = await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${C} AND id <> ${C0}`.then((r) => r.map((x) => x.r));
        check(`length (rollover): C's ended period rolled over into a new one ${CHOSEN} days long, right after it, carrying the unfinished item`, daysLong(cNext) === CHOSEN && Math.abs(new Date(cNext.starts_at) - new Date(C0before.ends_at)) < 1000 && (await cycleOf(tC)) === cNext.id, cNext);
        check("length (rollover): …C's ended period kept its dates (it was only closed)", same(await windowOf(C0), C0before) && (await stateOf(C0)) === "closed");
        await cycles(DOWN);
        const [dNext] = await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${D} AND id <> ${D0}`.then((r) => r.map((x) => x.r));
        check(`length (rollover): D, which chose nothing, rolled over into one the profile's ${WP.lengthDays} days long`, daysLong(dNext) === WP.lengthDays && (await cycleOf(tD)) === dNext.id, dNext);
        const made = await cycles(MEM, "POST", {});
        check(`length (by hand): a period opened in C with no dates runs ${CHOSEN} days`, made.status === 201 && daysLong({ starts_at: made.body.item.startsAt, ends_at: made.body.item.endsAt }) === CHOSEN, made);
      } else {
        // Mode team: no auto rollover. A period opened by hand with no dates now takes C's length; D's still has none.
        check("length (team): reading the list rolled nothing over and changed C's period not at all", (await cycles(MEM)).status === 200 && same(await windowOf(C0), C0before) && (await cycleOf(tC)) === C0);
        const made = await cycles(MEM, "POST", { name: "By hand" });
        check(`length (by hand): a period opened in C with no dates runs ${CHOSEN} days, starting where the last one ended`, made.status === 201 && made.body.item.name === "By hand" && daysLong({ starts_at: made.body.item.startsAt, ends_at: made.body.item.endsAt }) === CHOSEN, made);
        const dMade = await cycles(DOWN, "POST", { name: "By hand in D" });
        check("length (by hand): …in D, which chose nothing, as before: no dates (the profile gives no length)", dMade.status === 201 && dMade.body.item.startsAt === null && dMade.body.item.endsAt === null, dMade);
        const dNameless = await cycles(DOWN, "POST", {});
        check("length (by hand): …and D still needs a name, the answer it always had", dNameless.status === 400, dNameless);
      }

      // The model's tools read the same value.
      const t = await import(root("agent/lib/todo-tools.ts"));
      const byModel = await tool(t.upsertCycleTool, { name: "By the model" }, MEM);
      const modelRow = byModel.cycle ? await windowOf(byModel.cycle.id) : null;
      check(`length (model): a period the model opens in C with no dates runs ${CHOSEN} days`, !byModel.error && daysLong(modelRow) === CHOSEN && modelRow?.org_id === C, [byModel, modelRow]);
      const dByModel = await tool(t.upsertCycleTool, { name: "By the model in D" }, DOWN);
      const dModelRow = dByModel.cycle ? await windowOf(dByModel.cycle.id) : null;
      check(`length (model): …in D it runs the profile's length (${WP.lengthDays === null ? "none: no dates" : `${WP.lengthDays} days`})`, !dByModel.error && daysLong(dModelRow) === WP.lengthDays && dModelRow?.org_id === D, [dByModel, dModelRow]);

      const windowsBefore = JSON.stringify(await admin`SELECT id, starts_at, ends_at FROM cycles WHERE org_id = ${C} ORDER BY id`);
      const back = await length(OWN, "PUT", C, { lengthDays: null });
      const trail2 = await audits(C);
      check("length: an admin puts it back to the default; that is audited too", back.status === 200 && back.body.lengthDays === null && back.body.effectiveDays === WP.lengthDays && (await stored(C)) === null && trail2.length === 2 && /\(the default\)/.test(trail2[1].event), [back.body, trail2]);
      const same2 = await length(OWN, "PUT", C, { lengthDays: null });
      check("length: setting the value it already has writes no audit line", same2.status === 200 && (await audits(C)).length === 2);
      check("length: changing it again moved no period of C, the current one included: every one keeps its dates", JSON.stringify(await admin`SELECT id, starts_at, ends_at FROM cycles WHERE org_id = ${C} ORDER BY id`) === windowsBefore && JSON.parse(windowsBefore).length >= 3);
      check("length: after everything, C's first period still has the dates it was made with", same(await windowOf(C0), C0before));
    }
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
