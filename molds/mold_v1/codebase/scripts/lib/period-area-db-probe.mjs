#!/usr/bin/env node
/**
 * The periods against a real Postgres, for the definitions of THIS checkout's profile (scripts/test-period-area-db.mjs
 * runs it in the checkout, the default, and in copies under examples/filing-period.json: declared, and declared with
 * auto rollover). The real cycles routes and the real period tools, as the restricted app_rw role under the
 * fail-closed policies, two workspaces.
 *
 *   default    the routes and tools answer what they always did: no `custom` on the wire, today's three states, a
 *              field the route does not take refused;
 *   declared   own fields written in their canonical form and merged per key at write time (a key written by someone
 *              else in between, or no longer declared, is kept); declared states and moves under warn, their lines in
 *              the feed; every refusal a sentence that stores nothing; upsert_cycle / list_cycles take and return the
 *              same, with how many contained tasks are done;
 *   rollover   the system closes an ended period in the done state its declared transition leads to, leaves a finished
 *              one alone, opens the next in the initial state and starts it by category, and writes its moves;
 *   every one  workspace B reaches none of A's periods through the routes, the tools or the rows under RLS.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
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
  console.log("period-area-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "period-area-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const DECLARED = Boolean(RECORD_AREAS.periods.declared);
const ROLLING = DECLARED && RECORD_AREAS.periods.period?.auto_rollover === true;
const LABEL = ROLLING ? "rollover" : DECLARED ? "declared" : "default";
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   [${LABEL}] ${what}`);
  } else {
    failures++;
    console.log(`  FAIL [${LABEL}] ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 900)}`}`);
  }
};
const same = (a, b) => {
  const sorted = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};
const TAG = `${process.pid}-${LABEL}`;
const A = `org-periods-a-${TAG}`;
const B = `org-periods-b-${TAG}`;
const ANA = `ana-${TAG}@periods-a.test`;
const CAT = `cat-${TAG}@periods-a.test`;
const BEN = `ben-${TAG}@periods-b.test`;
const DAY = 86_400_000;

async function cleanup() {
  for (const t of ["entity_activity", "todos", "cycles", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

const closers = [];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Periods A', 'active'), (${B}, 'Periods B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ANA}, 'member'), (${A}, ${CAT}, 'admin'), (${B}, ${BEN}, 'admin')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const bearers = Object.fromEntries(await Promise.all([ANA, CAT, BEN].map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = { [ANA]: A, [CAT]: A, [BEN]: B };
  const H = "http://periods.test";
  const call = async (who, method, { body, id, sub } = {}) => {
    const file = id ? (sub ? `app/api/ops/cycles/[id]/${sub}/route.ts` : "app/api/ops/cycles/[id]/route.ts") : "app/api/ops/cycles/route.ts";
    const handlers = await import(root(file));
    const path = `/api/ops/cycles${id ? `/${id}` : ""}${sub ? `/${sub}` : ""}`;
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const tools = await import(root("agent/lib/todo-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const row = async (id) => (await admin`SELECT name, state, created_by, starts_at, ends_at, lead, goal, capacity, custom FROM cycles WHERE id = ${id}`)[0];
  const feed = async (id) => (await admin`SELECT actor, event FROM entity_activity WHERE entity_type = 'cycle' AND entity_id = ${id} ORDER BY created_at, id`).map((r) => ({ actor: r.actor, event: r.event }));
  /** The rows app_rw sees (and can change) in `org`, under the fail-closed policy. */
  const asOrg = (org, fn) => app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  });
  // B holds a period of its own throughout: nothing A does reaches it.
  const [bp] = await admin`INSERT INTO cycles (org_id, name, state, created_by, starts_at, ends_at) VALUES (${B}, 'B own', 'active', ${BEN}, now() - interval '20 days', now() - interval '13 days') RETURNING id`;
  const bBefore = JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${B}`);

  let aId = null;
  if (!DECLARED) {
    // ------------------------------------------------------------------------------------------------ default
    const made = await call(ANA, "POST", { body: { name: "Period 9", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-14T00:00:00.000Z", createdBy: "web" } });
    aId = made.body?.item?.id;
    const KEYS = ["archivedAt", "capacity", "createdAt", "createdBy", "endsAt", "goal", "id", "lead", "name", "orgId", "startsAt", "state", "updatedAt"];
    check("POST: 201, the item is the row it always was (no `custom`)", made.status === 201 && same(Object.keys(made.body.item).sort(), KEYS), made.body);
    const listed = await call(ANA, "GET");
    check("GET: every item carries no `custom`", listed.status === 200 && listed.body.items.length === 1 && listed.body.items.every((c) => !("custom" in c)), listed.body);
    const moved = await call(ANA, "PATCH", { id: aId, body: { state: "active", goal: "Ship it" } });
    check("PATCH: a state of today's three and a goal, answered with the item alone (no `custom`)", moved.status === 200 && moved.body.item.state === "active" && !("custom" in moved.body.item) && same(Object.keys(moved.body), ["item"]), moved.body);
    const own = await call(ANA, "PATCH", { id: aId, body: { custom: { x: 1 } } });
    check("PATCH: `custom` is not a field the route takes (400), nothing stored", own.status === 400 && same((await row(aId)).custom, {}), { own, row: await row(aId) });
    const other = await call(ANA, "PATCH", { id: aId, body: { state: "review" } });
    check("PATCH: a state outside today's three is refused (400)", other.status === 400 && (await row(aId)).state === "active", other.body);
    const t = await tool(tools.upsertCycleTool, { name: "From the model" }, ANA);
    check("upsert_cycle: answers what it always did", t.created === true && same(Object.keys(t.cycle).sort(), ["id", "name"]), t);
    const l = await tool(tools.listCyclesTool, {}, ANA);
    check("list_cycles: each period is id, name and window, as before", Array.isArray(l.cycles) && l.cycles.length === 2 && l.cycles.every((c) => same(Object.keys(c), ["id", "name", "startsAt", "endsAt"])), l);
  } else if (!ROLLING) {
    // ------------------------------------------------------------------------------------------------ declared
    const made = await call(ANA, "POST", { body: { name: "RBI · ALM return · Q2", startsAt: "2026-10-01", endsAt: "2026-10-31", lead: ANA, custom: { regulator: "RBI", penalty_exposure: "250000" }, createdBy: "web" } });
    aId = made.body?.item?.id;
    const r0 = aId ? await row(aId) : null;
    check("POST: 201, in the initial state, filed under the signed-in person, own fields canonical", made.status === 201 && r0?.state === "planning" && r0.created_by === ANA && same(r0.custom, { regulator: "RBI", penalty_exposure: 250000 }) && r0.ends_at.toISOString() === "2026-10-31T00:00:00.000Z", { made: made.body, r0 });
    check("…and the item carries its own fields", same(made.body?.item?.custom, { regulator: "RBI", penalty_exposure: 250000 }), made.body);
    const count = async () => (await admin`SELECT count(*)::int AS n FROM cycles WHERE org_id = ${A}`)[0].n;
    const n0 = await count();
    const badChoice = await call(ANA, "POST", { body: { name: "Wrong", custom: { regulator: "FED" } } });
    check("POST: a choice outside the list is a 400 in a sentence, nothing stored", badChoice.status === 400 && /"Regulator" \(regulator\) must be one of/.test(badChoice.body?.error ?? "") && (await count()) === n0, badChoice.body);
    const unknown = await call(ANA, "POST", { body: { name: "Wrong", custom: { colour: "red" } } });
    check("POST: an own field the definition does not have is a 400, nothing stored", unknown.status === 400 && /There is no own field "colour" here/.test(unknown.body?.error ?? "") && (await count()) === n0, unknown.body);
    const noName = await call(ANA, "POST", { body: { custom: { regulator: "RBI" } } });
    check("POST: a required field missing is a 400 (no length: no name to give it)", noName.status === 400 && /"Filing" \(name\) is required/.test(noName.body?.error ?? ""), noName.body);
    // Someone else writes a key between our read and our write: it is kept (merged per key at write time).
    await admin`UPDATE cycles SET custom = custom || '{"acknowledgement": "ACK-1", "retired_key": "kept"}'::jsonb WHERE id = ${aId}`;
    const p1 = await call(ANA, "PATCH", { id: aId, body: { custom: { filed_on: "2026-10-30" }, actor: ANA } });
    check("PATCH: an own field merged per key: the stored keys (another writer's, one no longer declared) are kept", p1.status === 200 && same((await row(aId)).custom, { regulator: "RBI", penalty_exposure: 250000, acknowledgement: "ACK-1", retired_key: "kept", filed_on: "2026-10-30" }), { p1: p1.body, row: await row(aId) });
    const p2 = await call(ANA, "PATCH", { id: aId, body: { custom: { acknowledgement: null } } });
    check("PATCH: null clears that key only", p2.status === 200 && same((await row(aId)).custom, { regulator: "RBI", penalty_exposure: 250000, retired_key: "kept", filed_on: "2026-10-30" }), (await row(aId)).custom);
    check("…the feed names the change by the field's label", (await feed(aId)).some((l) => l.event === "Filed on changed — → 2026-10-30"), await feed(aId));
    const badState = await call(ANA, "PATCH", { id: aId, body: { state: "archived" } });
    check("PATCH: a state the definition does not have is a 400", badState.status === 400 && /"Filing status" \(state\) must be one of/.test(badState.body?.error ?? "") && (await row(aId)).state === "planning", badState.body);
    const start = await call(ANA, "PATCH", { id: aId, body: { state: "active" } });
    check("a move its rules allow (Start preparing: lead and due date set): 200, no warning", start.status === 200 && (await row(aId)).state === "active" && !start.body?.warnings, start.body);
    check("…its line in the feed, by the mover, in the definition's words", (await feed(aId)).some((l) => l.actor === ANA && l.event === 'Filing status moved "Draft" → "In preparation" (Start preparing) [state: planning → active]'), await feed(aId));
    const review = await call(ANA, "PATCH", { id: aId, body: { state: "review" } });
    check("a declared state beyond today's three (Awaiting sign-off) is stored as it is", review.status === 200 && (await row(aId)).state === "review", review.body);
    const self = await call(ANA, "PATCH", { id: aId, body: { state: "closed" } });
    check("warn: marking it filed by who sent it for sign-off, without the acknowledgement, goes through with the warning", self.status === 200 && (await row(aId)).state === "closed" && self.body?.warnings?.[0]?.code === "lifecycle_rule_broken" && self.body.warnings[0].broken.some((b) => b.rule === "not_by") && self.body.warnings[0].broken.some((b) => b.rule === "requires"), self.body);
    check("…and the feed names the broken rules", (await feed(aId)).some((l) => l.actor === ANA && l.event.startsWith("Lifecycle rule not followed (not_by, requires): Mark filed")), await feed(aId));
    const comment = await call(ANA, "PATCH", { id: aId, body: { state: "rejected", reason: "Regulator asked for the annexure" } });
    check("a move's comment (`reason`) is in its line", comment.status === 200 && (await feed(aId)).some((l) => l.event === 'Filing status moved "Filed" → "Returned by regulator" (Returned by regulator): Regulator asked for the annexure [state: closed → rejected]'), await feed(aId));
    const listed = await call(CAT, "GET");
    const mine = listed.body?.items?.find((c) => c.id === aId);
    check("GET: each period with its state and its own fields", listed.status === 200 && mine?.state === "rejected" && mine.custom?.regulator === "RBI", listed.body);

    // The model's tools.
    const t1 = await tool(tools.upsertCycleTool, { name: "SEBI · LODR · Q2", startsAt: "2026-11-01", endsAt: "2026-11-15", custom: { regulator: "SEBI" } }, CAT);
    const tId = t1.cycle?.id;
    check("upsert_cycle creates with own fields, answering the state and the fields", t1.created === true && t1.cycle.state === "planning" && same(t1.cycle.custom, { regulator: "SEBI" }) && (await row(tId))?.created_by === CAT, t1);
    const t2 = await tool(tools.upsertCycleTool, { id: tId, lead: ANA, custom: { penalty_exposure: 5000 } }, CAT);
    check("upsert_cycle updates per key (a column and an own field)", t2.updated === true && (await row(tId)).lead === ANA && same((await row(tId)).custom, { regulator: "SEBI", penalty_exposure: 5000 }), t2);
    const t3 = await tool(tools.upsertCycleTool, { id: tId, custom: { regulator: "FED" } }, CAT);
    check("upsert_cycle: a refusal is the validator's sentence, nothing written", typeof t3.error === "string" && /^Nothing was written\. "Regulator" \(regulator\) must be one of/.test(t3.error) && (await row(tId)).custom.regulator === "SEBI", t3);
    const t4 = await tool(tools.upsertCycleTool, { id: tId, state: "missed" }, ANA);
    check("upsert_cycle: a move against its rules under warn goes through with the warning (a member, no comment)", t4.updated === true && (await row(tId)).state === "missed" && Array.isArray(t4.warnings) && /only owner or admin may make it/.test(t4.warnings[0]), t4);
    await admin`INSERT INTO todos (org_id, cycle_id, title, done, status, created_by) VALUES (${A}, ${aId}, 'Collate ALM data', true, 'done', ${ANA}), (${A}, ${aId}, 'Board sign-off', false, 'open', ${ANA}), (${A}, ${aId}, 'Dropped item', false, 'cancelled', ${ANA})`;
    const l = await tool(tools.listCyclesTool, {}, ANA);
    const la = l.cycles?.find((c) => c.id === aId);
    check("list_cycles: each period's state, fields, own fields and how many contained tasks are done", la?.state === "rejected" && la.lead === ANA && la.custom?.filed_on === "2026-10-30" && same(la.contains, { total: 2, done: 1 }), la ?? l);
    const lm = await tool(tools.listCyclesTool, { state: "missed" }, ANA);
    check("list_cycles: filtered by a state", Array.isArray(lm.cycles) && lm.cycles.length === 1 && lm.cycles[0].id === tId, lm);
    const theirs = await tool(tools.upsertCycleTool, { id: aId, custom: { regulator: "MCA" } }, BEN);
    check("B's upsert_cycle cannot write A's period, A's row unchanged", typeof theirs.error === "string" && (await row(aId)).custom.regulator === "RBI", theirs);
  } else {
    // ------------------------------------------------------------------------------------------------ rollover
    const now = Date.now();
    const at = (d) => new Date(now + d * DAY).toISOString();
    const [ended] = await admin`INSERT INTO cycles (org_id, name, state, created_by, starts_at, ends_at) VALUES (${A}, 'Ended in review', 'review', ${ANA}, ${at(-10)}, ${at(-3)}) RETURNING id`;
    const [missed] = await admin`INSERT INTO cycles (org_id, name, state, created_by, starts_at, ends_at) VALUES (${A}, 'Missed long ago', 'missed', ${ANA}, ${at(-40)}, ${at(-33)}) RETURNING id`;
    await admin`INSERT INTO todos (org_id, cycle_id, title, done, status, created_by) VALUES (${A}, ${ended.id}, 'Unfinished', false, 'open', ${ANA}), (${A}, ${ended.id}, 'Finished', true, 'done', ${ANA})`;
    aId = ended.id;
    const listed = await call(ANA, "GET");
    check("GET reads the periods (and runs the rollover in A's own transaction)", listed.status === 200, listed.body);
    check("an ended period is closed in the done state its declared transition leads to (Awaiting sign-off -> Filed)", (await row(ended.id)).state === "closed", await row(ended.id));
    check("a period already finished (Missed) is left as it is", (await row(missed.id)).state === "missed", await row(missed.id));
    const opened = await admin`SELECT id, state, starts_at, ends_at FROM cycles WHERE org_id = ${A} AND id NOT IN (${ended.id}, ${missed.id})`;
    check("the next period is opened where the ended one stopped, and, having begun, started in the first active state", opened.length === 1 && opened[0].state === "active" && opened[0].starts_at.getTime() <= now && opened[0].ends_at.getTime() > now, opened);
    const carried = await admin`SELECT title, cycle_id FROM todos WHERE org_id = ${A} ORDER BY title`;
    check("its unfinished task is carried into the next period, the finished one stays", carried.find((t) => t.title === "Unfinished")?.cycle_id === opened[0]?.id && carried.find((t) => t.title === "Finished")?.cycle_id === ended.id, carried);
    check("the system's close is a move line in the feed (by system), beside the rollover sentence", (await feed(ended.id)).some((l) => l.actor === "system" && l.event.endsWith("[state: review → closed]")) && (await feed(ended.id)).some((l) => l.actor === "system" && l.event.startsWith("Rolled over 1 unfinished")), await feed(ended.id));
    check("…and so is the start of the next one", opened[0] && (await feed(opened[0].id)).some((l) => l.actor === "system" && l.event.endsWith("[state: planning → active]")), opened[0] ? await feed(opened[0].id) : null);
    const again = await call(ANA, "GET");
    check("reading again finds nothing more to do", again.status === 200 && (await admin`SELECT count(*)::int AS n FROM cycles WHERE org_id = ${A}`)[0].n === 3);
  }

  // ------------------------------------------------------------------------------------------------ isolation (every run)
  // (Before B reads anything: B's own read runs B's own rollover, in B's own transaction.)
  check("B's own period is byte for byte what it was after everything A did", JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${B}`) === bBefore);
  const bList = await call(BEN, "GET");
  check("B's GET holds none of A's periods", bList.status === 200 && bList.body.items.every((c) => c.id !== aId) && bList.body.items.some((c) => c.id === bp.id), bList.body);
  const bPatch = await call(BEN, "PATCH", { id: aId, body: { name: "taken" } });
  check("B's PATCH of A's period is a 404, A's row unchanged", bPatch.status === 404 && (await row(aId)).name !== "taken", bPatch);
  const bTool = await tool(tools.listCyclesTool, {}, BEN);
  check("B's list_cycles holds none of A's periods", Array.isArray(bTool.cycles) && bTool.cycles.every((c) => c.id !== aId), bTool);
  const seen = await asOrg(B, (tx) => tx`SELECT id FROM cycles WHERE org_id = ${A}`);
  const changed = await asOrg(B, (tx) => tx`UPDATE cycles SET custom = '{"planted": true}'::jsonb WHERE org_id = ${A} RETURNING id`);
  check("under RLS, app_rw in B sees and changes none of A's rows (custom included)", seen.length === 0 && changed.length === 0, { seen: seen.length, changed: changed.length });
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await app.end({ timeout: 2 }).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`period-area-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
