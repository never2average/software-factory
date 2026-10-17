#!/usr/bin/env node
/**
 * Lifecycles enforced, against a real Postgres, for the tasks definition of THIS checkout's profile
 * (scripts/test-record-lifecycle-db.mjs runs it in copies under the pipeline fixture with enforce strict, warn and off,
 * and in the checkout itself, the default). The real ops routes, the agent's real upsert_todo, the coding agent's real
 * MCP task_update (through the routes, as the hosted endpoint calls them), as the restricted app_rw role under the
 * fail-closed policies, and the real task-workflow engine behind them: an in-process stand-in calls
 * services/task-workflow/lib/engine.ts as its routes do (with the context its auth builds, x-task-states included)
 * and records every body it is sent.
 *
 *   strict    each rule refuses with 409 (the sentence, the broken rules, the allowed moves) and nothing reaches the
 *             service; an allowed move stamps and is written to the activity feed; four eyes reads who entered the
 *             state from the feed (and the creator for the initial state); a stage move is checked as its state's;
 *             the agent's tool and MCP refuse with the same sentence.
 *   warn      the same moves go through and the feed names the broken rule; the agent's tool reports it.
 *   off       the same moves go through as they always did; nothing is written about them, no row is read for them.
 *   default   (the checkout) moves write nothing to the feed but the service's own lines.
 *   all       workspace B moves none of A's tasks, its activity lines never count as A's, and the policies are the same.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw); TASK_AREA_SERVICE_ROOT names the service's directory (a copy has none).
 */
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const SERVICE = process.env.TASK_AREA_SERVICE_ROOT ?? `${process.cwd()}/services/task-workflow`;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      const SERVICE = ${JSON.stringify(pathToFileURL(SERVICE + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = (c.parentURL && c.parentURL.startsWith(SERVICE) ? SERVICE : ROOT) + s.slice(2);
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
  console.log("record-lifecycle-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const LC = RECORD_AREAS.tasks.lifecycle;
const RECURRENCE = process.env.LIFECYCLE_PROBE_SET === "recurrence";
const PERIODS = process.env.LIFECYCLE_PROBE_SET === "periods";
const LEGACY = process.env.LIFECYCLE_PROBE_SET === "legacy";
const MODE = LEGACY ? "legacy" : RECURRENCE ? "recurrence" : PERIODS ? `periods-${RECORD_AREAS.periods.lifecycle?.enforce ?? "off"}` : !RECORD_AREAS.tasks.redefined ? "default" : LC.enforce;
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
    console.log(`  FAIL [${MODE}] ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 1200)}`}`);
  }
};

const TAG = `${process.pid}-${MODE}`;
const A = `org-lc-a-${TAG}`;
const B = `org-lc-b-${TAG}`;
const ANA = `ana-${TAG}@lc-a.test`;
const BO = `bo-${TAG}@lc-a.test`;
const CAT = `cat-${TAG}@lc-a.test`;
const BEN = `ben-${TAG}@lc-b.test`;

async function cleanup() {
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "cycles", "deployments", "customers", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

// The task-workflow service, in process, with the context its auth builds (lib/auth.ts): every body it is sent.
const engine = await import(pathToFileURL(`${SERVICE}/lib/engine.ts`).href);
const { withOrgTransaction } = await import(pathToFileURL(`${SERVICE}/lib/db.ts`).href);
const { taskCreateSchema, taskPatchSchema } = await import(pathToFileURL(`${SERVICE}/lib/types.ts`).href);
const { errorResponse, issueMessage } = await import(pathToFileURL(`${SERVICE}/lib/http.ts`).href);
const { parseTaskStates } = await import(pathToFileURL(`${SERVICE}/lib/stages.ts`).href);
const received = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received.push({ method: req.method, path: req.url, text, states: req.headers["x-task-states"] ?? null });
  const taskStates = parseTaskStates(req.headers["x-task-states"] ?? null);
  const ctx = { orgId: req.headers["x-org-id"], actor: String(req.headers["x-actor-email"] ?? "").toLowerCase(), role: req.headers["x-actor-role"] ?? "member", ...(taskStates ? { taskStates } : {}) };
  const send = async (response) => {
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  };
  try {
    const one = /^\/api\/v1\/tasks\/([^/]+)$/.exec(req.url);
    if (req.url === "/api/v1/tasks" && req.method === "GET") return send(Response.json({ items: await withOrgTransaction(ctx.orgId, (sql) => engine.listTasks(sql, ctx.orgId)) }));
    if (req.url === "/api/v1/tasks" && req.method === "POST") {
      const parsed = taskCreateSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return send(Response.json({ error: issueMessage(parsed.error) }, { status: 400 }));
      const r = await withOrgTransaction(ctx.orgId, (sql) => engine.createTask(sql, ctx, parsed.data));
      return send(Response.json({ item: r.item }, { status: 201 }));
    }
    if (one && req.method === "PATCH") {
      const parsed = taskPatchSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return send(Response.json({ error: issueMessage(parsed.error) }, { status: 400 }));
      const r = await withOrgTransaction(ctx.orgId, (sql) => engine.updateTask(sql, ctx, one[1], parsed.data));
      return send(Response.json({ item: r.item }));
    }
    return send(Response.json({ error: "Not found" }, { status: 404 }));
  } catch (e) {
    return send(errorResponse(e));
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
process.env.TASK_WORKFLOW_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.TASK_WORKFLOW_SERVICE_TOKEN = "probe-token";

const closers = [];
let periodsScenario = async () => {};
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Lifecycle A', 'active'), (${B}, 'Lifecycle B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ANA}, 'member'), (${A}, ${BO}, 'member'), (${A}, ${CAT}, 'admin'), (${B}, ${BEN}, 'admin')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const people = [ANA, BO, CAT, BEN];
  const bearers = Object.fromEntries(await Promise.all(people.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = { [ANA]: A, [BO]: A, [CAT]: A, [BEN]: B };
  const H = "http://tasks.test";
  const call = async (who, method, path, { body, text, id } = {}) => {
    const handlers = await import(root(id ? "app/api/ops/todos/[id]/route.ts" : "app/api/ops/todos/route.ts"));
    const raw = text ?? (body === undefined ? undefined : JSON.stringify(body));
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: raw });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const create = (who, body) => call(who, "POST", "/api/ops/todos", { body });
  const patch = (who, id, body) => call(who, "PATCH", `/api/ops/todos/${id}`, { body, id });
  const row = async (id) => (await admin`SELECT status, done, assignee, due_at, created_by, custom FROM todos WHERE id = ${id}`)[0];
  const feed = async (id) => (await admin`SELECT actor, event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'task' AND entity_id = ${id} ORDER BY created_at, id`).map((r) => ({ actor: r.actor, event: r.event }));
  const lifecycleLines = (lines) => lines.filter((l) => /\[status: [a-z_]* → [a-z_]+\]$/.test(l.event) || l.event.startsWith("Lifecycle rule"));
  const sentSince = (n) => received.slice(n).filter((r) => r.method !== "GET");
  // A new task enters the workspace's default stage pipeline (Backlog first), whose own manual transitions the service
  // enforces whatever the lifecycle. The moves below are made on tasks outside a pipeline (as tasks made before
  // pipelines existed are), in Open; the pipeline itself is exercised on its own task.
  const free = async (taskId) => {
    await admin`DELETE FROM task_workflow_instances WHERE task_id = ${taskId}`;
    await admin`UPDATE todos SET status = 'open' WHERE id = ${taskId}`;
    return taskId;
  };
  const createFree = async (who, body) => {
    const r = await create(who, body);
    return r.body?.item?.id ? free(r.body.item.id) : null;
  };

  const todoTools = await import(root("agent/lib/todo-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => t.execute(input, ctxFor(who)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

  // The coding agent's MCP task tools, through the routes, as the hosted endpoint calls them (lib/mcp-server.ts api()).
  const { createTools } = await import(root("setup/workspace-tools.mjs"));
  const { FOLDER } = await import(root("agent/lib/dataroom-folders.ts"));
  const mcpFor = (who) => {
    const api = async (method, path, body) => {
      const id = /^\/api\/ops\/todos\/([^/]+)$/.exec(path)?.[1];
      const r = await call(who, method, path, { body, id });
      if (r.status >= 400) throw new Error(r.body?.error ?? `HTTP ${r.status} from ${path}`);
      return r.body;
    };
    const tools = createTools({ api, folders: FOLDER, actor: who, blobStore: () => null, getOrg: () => orgOf[who], setOrg: () => {} });
    return (name, args) => tools.find((t) => t.name === name).handler(args).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  };

  periodsScenario = async () => {
    // ------------------------------------------------- periods (records.areas.periods; app/api/ops/cycles)
    const PL = RECORD_AREAS.periods.lifecycle?.enforce ?? "off";
    const cyc = async (who, method, path, body, id) => {
      const handlers = await import(root(id ? "app/api/ops/cycles/[id]/route.ts" : "app/api/ops/cycles/route.ts"));
      const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json };
    };
    const move = (who, id, body) => cyc(who, "PATCH", `/api/ops/cycles/${id}`, body, id);
    const crow = async (id) => (await admin`SELECT state, created_by, starts_at FROM cycles WHERE id = ${id}`)[0];
    const cfeed = async (id) => (await admin`SELECT actor, event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'cycle' AND entity_id = ${id} ORDER BY created_at, id`).map((r) => ({ actor: r.actor, event: r.event }));
    const made = await cyc(ANA, "POST", "/api/ops/cycles", { name: "Week 42", startsAt: "2026-10-12T00:00:00.000Z", endsAt: "2026-10-19T00:00:00.000Z", createdBy: "someone-else@lc-a.test" });
    const id = made.body?.item?.id;
    check("a period is created (201) in the initial state", made.status === 201 && (await crow(id))?.state === "planning", made);
    if (PL === "strict") {
      check("…filed under the signed-in person, not the label the body chose (four eyes may fall back to it)", (await crow(id)).created_by === ANA, await crow(id));
      const member = await move(ANA, id, { state: "active" });
      check("roles: a member may not start it (409)", member.status === 409 && member.body?.code === "lifecycle_refused" && member.body.broken?.[0]?.rule === "roles" && member.body.error === 'Moving from "Planning" to "Active" is not possible now: "Active" (Start): only owner or admin may make it. From "Planning" you can move to: nothing.', member.body);
      check("…nothing changed", (await crow(id)).state === "planning");
      const t0 = Date.now();
      const started = await move(CAT, id, { state: "active" });
      const r = await crow(id);
      check("an admin starts it (200); the stamp sets its start to now", started.status === 200 && r.state === "active" && Math.abs(r.starts_at.getTime() - t0) < 60_000, { started, r });
      check("…and the feed has the move by the admin", (await cfeed(id)).some((l) => l.actor === CAT && l.event === 'State moved "Planning" → "Active" (Start) [state: planning → active]'), await cfeed(id));
      const self = await move(CAT, id, { state: "closed" });
      check("four eyes: who started it may not close it (409 not_by)", self.status === 409 && self.body?.broken?.[0]?.rule === "not_by", self.body);
      const back = await move(BO, id, { state: "planning" });
      check("a required comment: back to planning without one is 409", back.status === 409 && back.body?.broken?.[0]?.rule === "requires_comment", back.body);
      const closed = await move(BO, id, { state: "closed" });
      check("a second person closes it (200)", closed.status === 200 && (await crow(id)).state === "closed", closed);
      const reopenBare = await move(CAT, id, { state: "active" });
      const reopen = await move(CAT, id, { state: "active", reason: "one more filing came in" });
      check("reopening needs a comment (409 without, 200 with) and the comment is in the move's line", reopenBare.status === 409 && reopen.status === 200 && (await cfeed(id)).some((l) => l.event === 'State moved "Closed" → "Active" (Reopen): one more filing came in [state: closed → active]'), { reopenBare: reopenBare.body, reopen: reopen.status });
      // Four eyes with no move line: the last person the feed shows changing it, else its creator.
      const [old] = await admin`INSERT INTO cycles (org_id, name, state, created_by) VALUES (${A}, 'Week 41', 'active', ${BO}) RETURNING id`;
      await admin`INSERT INTO entity_activity (org_id, entity_type, entity_id, actor, event) VALUES (${A}, 'cycle', ${old.id}, ${CAT}, 'State changed planning → active')`;
      const lastSelf = await move(CAT, old.id, { state: "closed" });
      const creatorOk = await move(BO, old.id, { state: "closed" });
      check("no move line: the last person who changed it may not close it; another may", lastSelf.status === 409 && creatorOk.status === 200, { lastSelf: lastSelf.body, creatorOk: creatorOk.status });
      const [bare] = await admin`INSERT INTO cycles (org_id, name, state, created_by) VALUES (${A}, 'Week 40', 'active', ${BO}) RETURNING id`;
      const creatorSelf = await move(BO, bare.id, { state: "closed" });
      const other = await move(ANA, bare.id, { state: "closed" });
      check("no line at all: its creator may not close it; another may", creatorSelf.status === 409 && other.status === 200, { creatorSelf: creatorSelf.body, other: other.status });
    } else if (PL === "warn") {
      const member = await move(ANA, id, { state: "active" });
      check("warn: a member starts it anyway (200), the answer carries the warning", member.status === 200 && (await crow(id)).state === "active" && member.body?.warnings?.[0]?.code === "lifecycle_rule_broken" && member.body.warnings[0].broken[0].rule === "roles" && member.body?.item?.id === id, member.body);
      check("…and the feed names the rule", (await cfeed(id)).some((l) => l.actor === ANA && l.event.startsWith("Lifecycle rule not followed (roles): Start: only owner or admin may make it.")), await cfeed(id));
    } else {
      const withReason = await move(CAT, id, { state: "active", reason: "x" });
      check("off: the route takes what it took before (`reason` is still not a field: 400)", withReason.status === 400, withReason);
      const member = await move(ANA, id, { state: "closed" });
      check("off: any move goes through as before, answered with the item alone", member.status === 200 && (await crow(id)).state === "closed" && JSON.stringify(Object.keys(member.body ?? {})) === '["item"]', member.body);
      check("…the creator is the body's label, as before", (await crow(id)).created_by === "someone-else@lc-a.test", await crow(id));
      check("…and no lifecycle line is written", (await cfeed(id)).every((l) => !/\[state: |Lifecycle rule/.test(l.event)), await cfeed(id));
    }
    const theirs = await move(BEN, id, { state: "planning", ...(PL === "off" ? {} : { reason: "x" }) });
    check("another workspace's admin cannot move A's period (404)", theirs.status === 404, theirs);
  };
  if (PERIODS) {
    await periodsScenario();
  } else if (LEGACY) {
    // ------------------------------------------------- four eyes on a state stored in a legacy spelling (PR #192 review)
    // Each record stores its state in a spelling the definition reads as another (legacy_values). The person whose move
    // line entered it (written in that spelling) may not sign it off; a later, unrelated line by someone else must not
    // stand in for them (it would, if the move line were not found under the legacy spelling), so that person may.
    const line = (type, id, actor, event) => admin`INSERT INTO entity_activity (org_id, entity_type, entity_id, actor, event, created_at) VALUES (${A}, ${type}, ${id}, ${actor}, ${event}, now() - interval '1 minute' * ${event.startsWith("Note") ? 1 : 2})`;
    const notBy = (r) => r.status === 409 && r.body?.broken?.some((b) => b.rule === "not_by");
    // Tasks: the routes and the agent's upsert_todo (records.areas.tasks, status "doing" read as "in_progress").
    const [t] = await admin`INSERT INTO todos (org_id, title, status, assignee, created_by, due_at) VALUES (${A}, 'Legacy task', 'doing', ${ANA}, ${BO}, '2026-11-02T09:00:00Z') RETURNING id`;
    await line("task", t.id, ANA, 'Status moved "Open" → "Doing" (Start) [status: open → doing]');
    await line("task", t.id, CAT, "Note: due date confirmed");
    const selfRoute = await patch(ANA, t.id, { status: "done" });
    check("tasks: who entered the legacy-spelled state may not sign it off through the routes (409 not_by)", notBy(selfRoute), selfRoute.body);
    const selfTool = await tool(todoTools.upsertTodoTool, { id: t.id, status: "done" }, ANA);
    check("tasks: …nor through the agent's upsert_todo", typeof selfTool.error === "string" && /not by the person who moved it/.test(selfTool.error) && (await row(t.id)).status === "doing", selfTool);
    const other = await patch(CAT, t.id, { status: "done" });
    check("tasks: someone else may (the move line is found under the legacy spelling, so the later note's author is not taken for who entered it)", !notBy(other) && other.status === 200 && (await row(t.id)).status === "done", other.body);
    // Periods: app/api/ops/cycles (records.areas.periods, state "running" read as "active").
    const cyc = async (who, id, body) => {
      const handlers = await import(root("app/api/ops/cycles/[id]/route.ts"));
      const request = new NextRequest(`${H}/api/ops/cycles/${id}`, { method: "PATCH", headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await handlers.PATCH(request, { params: Promise.resolve({ id }) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json };
    };
    const [c] = await admin`INSERT INTO cycles (org_id, name, state, created_by) VALUES (${A}, 'Week 39', 'running', ${BO}) RETURNING id`;
    await line("cycle", c.id, CAT, 'State moved "Planning" → "Running" (Start) [state: planning → running]');
    await line("cycle", c.id, BO, "Note: scope agreed");
    const selfCycle = await cyc(CAT, c.id, { state: "closed" });
    check("periods: who entered the legacy-spelled state may not close it (409 not_by)", notBy(selfCycle), selfCycle.body);
    const otherCycle = await cyc(BO, c.id, { state: "closed" });
    check("periods: someone else may (the creator and last changer: the move line names who entered it)", otherCycle.status === 200 && (await admin`SELECT state FROM cycles WHERE id = ${c.id}`)[0].state === "closed", otherCycle.body);
    // Record areas: app/api/ops/deployments (records.areas.deployments, its state renamed twice and stored as "todo" under
    // the oldest key, read as "queued").
    await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES ('acme', ${A}, 'Acme')`;
    await admin`INSERT INTO deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, custom) VALUES (${A}, 'acme', 'item-1', 'prod', 'on-prem', 'First', 'in-progress', 'unknown', ${admin.json({ first_stage: "todo" })})`;
    await line("deployment", "item-1", ANA, 'Stage moved "Draft" → "Todo" [stage: draft → todo]');
    await line("deployment", "item-1", BO, "Note: owner confirmed");
    const itemPatch = async (who, body) => {
      const handlers = await import(root("app/api/ops/deployments/[id]/route.ts"));
      const request = new NextRequest(`${H}/api/ops/deployments/item-1`, { method: "PATCH", headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await handlers.PATCH(request, { params: Promise.resolve({ id: "item-1" }) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json };
    };
    const itemSelf = await itemPatch(ANA, { customerId: "acme", custom: { stage: "working" } });
    check("record areas: who entered the legacy-spelled state (stored under the oldest key) may not start it (409 not_by)", notBy(itemSelf), itemSelf.body);
    const itemOther = await itemPatch(BO, { customerId: "acme", custom: { stage: "working" } });
    const itemRow = (await admin`SELECT custom FROM deployments WHERE org_id = ${A} AND deployment_id = 'item-1'`)[0];
    check("record areas: someone else may; the new state is stored under the field's own key", itemOther.status === 200 && itemRow?.custom?.stage === "working", { itemOther: itemOther.body, itemRow });
  } else if (RECURRENCE) {
    // ------------------------------------------------- recurrence (the obligation example: quarterly, monthly, one-time)
    const count = async (prevId) => Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom @> ${JSON.stringify({ recurs_from: prevId })}::text::jsonb`)[0].n);
    const made = await create(ANA, { title: "Quarterly ALM return", dueAt: "2026-10-31", custom: { frequency: "Quarterly", department: "Finance", obligation_ref: "OBL-0042" } });
    const prev = made.body?.item?.id;
    check("an obligation is created (201)", made.status === 201 && typeof prev === "string", made);
    const closed = await patch(CAT, prev, { custom: { state: "closed" } });
    const next = closed.body?.next;
    check("moving it into a done state answers with the next occurrence (`next`)", closed.status === 200 && typeof next?.id === "string" && next.title === "Quarterly ALM return" && next.dueAt === "2027-01-31T09:00:00.000Z", closed.body);
    const nrow = next?.id ? await row(next.id) : null;
    check("…which carries the copied fields, starts in the initial state, is due one interval after the last due date, and links back", nrow?.custom?.frequency === "Quarterly" && nrow.custom.department === "Finance" && nrow.custom.obligation_ref === "OBL-0042" && nrow.custom.state === "not_started" && nrow.status === "open" && nrow.done === false && nrow.assignee === ANA && nrow.due_at?.toISOString() === "2027-01-31T09:00:00.000Z" && nrow.custom.recurs_from === prev, nrow);
    check("…and both feeds say so", (await feed(prev)).some((l) => l.actor === CAT && l.event === `Next occurrence created, due 2027-01-31 [recurs: ${next?.id}]`) && (await feed(next?.id)).some((l) => l.event === `Recurs from "Quarterly ALM return" [recurs_from: ${prev}]`), { prev: await feed(prev), next: await feed(next?.id) });
    await patch(CAT, prev, { custom: { state: "in_progress" } });
    const again = await patch(CAT, prev, { custom: { state: "closed" } });
    const x = await patch(CAT, prev, { custom: { state: "in_progress" } });
    const twice = await Promise.all([patch(CAT, prev, { custom: { state: "closed" } }), patch(BO, prev, { custom: { department: "Risk" } })]);
    check("idempotent: done again (reopened and closed, twice over) makes no second occurrence", again.status === 200 && again.body?.next === undefined && x.status === 200 && twice[0].status === 200 && (await count(prev)) === 1, { again: again.body?.next, n: await count(prev) });
    const notDone = await patch(CAT, next?.id, { custom: { state: "in_progress" } });
    check("a move into a state that is not done creates nothing", notDone.status === 200 && notDone.body?.next === undefined && (await count(next?.id)) === 0, notDone.body);
    const once = (await create(ANA, { title: "One-off filing", dueAt: "2026-11-15", custom: { frequency: "One-time" } })).body?.item?.id;
    const onceClosed = await patch(CAT, once, { custom: { state: "closed" } });
    check("a frequency with no interval (One-time) does not recur", onceClosed.status === 200 && onceClosed.body?.next === undefined && (await count(once)) === 0, onceClosed.body);
    const monthly = (await create(ANA, { title: "Monthly MIS", dueAt: "2026-01-31", custom: { frequency: "Monthly" } })).body?.item?.id;
    const byTool = await tool(todoTools.upsertTodoTool, { id: monthly, custom: { state: "closed" } }, CAT);
    const mrow = byTool.next?.id ? await row(byTool.next.id) : null;
    check("the agent's upsert_todo creates the next one too (a month end stays in its month: 2026-02-28)", byTool.updated === true && mrow?.due_at?.toISOString() === "2026-02-28T09:00:00.000Z" && mrow.custom.recurs_from === monthly && mrow.custom.state === "not_started", { byTool, mrow });
    const byToolAgain = await tool(todoTools.upsertTodoTool, { id: monthly, custom: { state: "closed" } }, CAT);
    check("…and never a second", byToolAgain.next === undefined && (await count(monthly)) === 1, byToolAgain);
    // Two completions at the same moment: both see no next occurrence, both create one; the database lets one in
    // (drizzle/0042) and the other is taken as done, without an error.
    const { recurAfterWrite } = await import(root("agent/lib/task-recurrence-run.ts"));
    const racer = (await create(ANA, { title: "Annual return", dueAt: "2026-03-31", custom: { frequency: "Annual" } })).body?.item?.id;
    const beforeRace = { ...(await admin`SELECT * FROM todos WHERE id = ${racer}`)[0] };
    const stored = { ...beforeRace, createdBy: beforeRace.created_by, custom: beforeRace.custom };
    await patch(CAT, racer, { custom: { state: "closed" } }).then(async () => admin`DELETE FROM todos WHERE org_id = ${A} AND custom @> ${JSON.stringify({ recurs_from: racer })}::text::jsonb`);
    const item = { id: racer, title: "Annual return", status: "done", assignee: ANA, dueAt: "2026-03-31T09:00:00.000Z", custom: { state: "closed", frequency: "Annual" } };
    const race = await Promise.allSettled([1, 2, 3].map(() => recurAfterWrite({ orgId: A, actor: CAT, before: { ...stored, custom: { state: "under_review", frequency: "Annual" } }, item, withTx: (fn) => agentDb.withOrgDb(A, fn) })));
    const madeN = race.filter((r) => r.status === "fulfilled" && r.value).length;
    check("three completions at the same moment create exactly one next occurrence, and none of them fails", race.every((r) => r.status === "fulfilled") && madeN === 1 && (await count(racer)) === 1, { race: race.map((r) => r.status === "fulfilled" ? (r.value ? "made" : "taken as done") : String(r.reason)), n: await count(racer) });
    let dup = "inserted";
    try {
      await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${A}, 'forged twin', 'probe', ${JSON.stringify({ recurs_from: racer })}::text::jsonb)`;
    } catch (e) { dup = `${e.code} ${e.constraint_name}`; }
    check("the database refuses a second next occurrence outright (23505 on todos_recurs_from_uidx)", dup === "23505 todos_recurs_from_uidx", dup);
    await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${B}, 'same id, other workspace', 'probe', ${JSON.stringify({ recurs_from: racer })}::text::jsonb)`;
    check("…per workspace: another workspace's row with the same recurs_from is its own", true);
    await admin`DELETE FROM todos WHERE org_id = ${B}`;
    const theirs = await patch(BEN, prev, { custom: { state: "closed" } });
    check("another workspace cannot complete A's obligation, nor make it recur (404)", theirs.status === 404 && (await count(prev)) === 1, theirs);
    check("…and B holds no task", Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${B}`)[0].n) === 0);
  } else {
  // A task in A, created by Ana, started by Ana (open -> in progress): the state Ana entered.
  const made = await create(ANA, { title: "Reconcile the ledger", dueAt: "2026-11-02T09:00:00.000Z" });
  check("a task is created (201), in the first stage of the workspace's pipeline as before", made.status === 201 && made.body?.item?.workflow?.stageId === "backlog", made);
  const id = await free(made.body?.item?.id);
  check("…and the create in the initial state writes no lifecycle line", lifecycleLines(await feed(id)).length === 0, await feed(id));
  const started = await patch(ANA, id, { status: "in_progress" });
  const afterStart = await row(id);
  check("an allowed move goes through (Start)", started.status === 200 && afterStart.status === "in_progress", { started, afterStart });

  if (MODE === "strict" || MODE === "warn") {
    check("…its stamp landed: the caller is the assignee ({me})", afterStart.assignee === ANA, afterStart);
    check("…answered with the item alone: an allowed move carries no warning", JSON.stringify(Object.keys(started.body ?? {})) === '["item"]', started.body);
    const lines = lifecycleLines(await feed(id));
    check("…and the activity feed has the move, by the caller, with its marker", lines.length === 1 && lines[0].actor === ANA && lines[0].event === 'Status moved "Open" → "In progress" (Start) [status: open → in_progress]', lines);
  } else {
    check("…with no stamp (the assignee stays unset) and no lifecycle line in the feed", afterStart.assignee === null && lifecycleLines(await feed(id)).length === 0, { afterStart, feed: await feed(id) });
  }

  if (MODE === "strict") {
    // ------------------------------------------------------------------------------------------ strict: every rule refuses
    let n = received.length;
    let before = JSON.stringify(await row(id));
    const self = await patch(ANA, id, { status: "done" });
    check("four eyes: who moved it to In progress may not sign it off (409)", self.status === 409 && self.body?.code === "lifecycle_refused" && self.body.broken?.some((b) => b.rule === "not_by"), self);
    check("…the 409 body: the sentence, the move, the broken rule and the allowed moves", self.body?.error === 'Moving from "In progress" to "Done" is not possible now: "Done" (Sign off): not by the person who moved it to "In progress"; a second person must. From "In progress" you can move to: "Blocked" (Block; needs a comment), "Done" (Sign off; not by you: a second person must; needs "Due").' && self.body.from === "in_progress" && self.body.to === "done" && self.body.field === "status" && JSON.stringify(self.body.allowed.map((m) => m.to)) === '["blocked","done"]', self.body);
    check("…nothing reached the service, and the task is as it was", sentSince(n).length === 0 && JSON.stringify(await row(id)) === before, sentSince(n));

    // B's workspace plants a line claiming Bo entered A's task's state: it never counts as A's.
    await admin`INSERT INTO entity_activity (org_id, entity_type, entity_id, actor, event) VALUES (${B}, 'task', ${id}, ${BO}, ${'Status moved "Open" → "In progress" (Start) [status: open → in_progress]'})`;
    const stillSelf = await patch(ANA, id, { status: "done" });
    check("another workspace's activity line for the same id does not change who entered the state (RLS + org filter)", stillSelf.status === 409 && stillSelf.body?.broken?.some((b) => b.rule === "not_by"), stillSelf);

    const blockNoComment = await patch(BO, id, { status: "blocked" });
    check("a required comment: blocking without one is 409 (requires_comment)", blockNoComment.status === 409 && blockNoComment.body?.broken?.[0]?.rule === "requires_comment", blockNoComment);
    const skip = await patch(BO, id, { status: "backlog" });
    check("a move the transitions do not list is 409 (transition), naming the moves there are", skip.status === 409 && skip.body?.broken?.[0]?.rule === "transition" && /^"In progress" cannot move to "Backlog"\. From "In progress" you can move to: /.test(skip.body.error), skip);
    const cancelMember = await patch(BO, id, { status: "cancelled", reason: "duplicate" });
    check("roles: a member may not cancel (409 roles)", cancelMember.status === 409 && cancelMember.body?.broken?.some((b) => b.rule === "roles"), cancelMember);
    await admin`UPDATE todos SET due_at = NULL WHERE id = ${id}`;
    const noDue = await patch(BO, id, { status: "done" });
    check("a required field: signing off without a due date is 409 (requires)", noDue.status === 409 && noDue.body?.broken?.some((b) => b.rule === "requires" && /"Due"/.test(b.message)), noDue);
    check("…none of these reached the service", sentSince(n).length === 0, sentSince(n));

    n = received.length;
    const signed = await patch(BO, id, { status: "done", dueAt: "2026-11-03T09:00:00.000Z" });
    const done = await row(id);
    check("a second person signs off, with the due date given in the same write (200, done)", signed.status === 200 && done.status === "done" && done.done === true, { signed, done });
    const lines = lifecycleLines(await feed(id));
    check("…and the feed has both moves, each by who made it", lines.length === 2 && lines[1].actor === BO && lines[1].event === 'Status moved "In progress" → "Done" (Sign off) [status: in_progress → done]', lines);

    // The comment goes to the service as the request's reason; an admin may cancel.
    const other = await createFree(BO, { title: "Duplicate" });
    n = received.length;
    const cancelled = await patch(CAT, other, { status: "cancelled", reason: "filed twice" });
    check("an admin cancels with a comment (200), the reason reaches the service as sent", cancelled.status === 200 && (await row(other)).status === "cancelled" && JSON.parse(sentSince(n)[0]?.text ?? "{}").reason === "filed twice", { cancelled, sent: sentSince(n) });
    check("…and the comment is in the move's line", lifecycleLines(await feed(other)).some((l) => l.actor === CAT && l.event === 'Status moved "Open" → "Cancelled" (Cancel): filed twice [status: open → cancelled]'), await feed(other));

    const direct = await create(ANA, { title: "Done already", status: "done" });
    check("a create outside the initial state is 409", direct.status === 409 && /^A new task cannot start in "Done": it starts in "Open"\./.test(direct.body?.error ?? ""), direct);

    // A stage pipeline: the task entered today's default pipeline; a stage move is checked as its state's move.
    const staged = (await create(ANA, { title: "Staged" })).body?.item?.id;
    const inst = (await admin`SELECT stage_id FROM task_workflow_instances WHERE task_id = ${staged}`)[0];
    check("a new task enters the workspace's stage pipeline as before", inst?.stage_id === "backlog" && (await row(staged)).status === "backlog", inst);
    const planned = await patch(ANA, staged, { stageId: "open" });
    check("a stage move the lifecycle allows (Backlog -> Open, Plan) goes through the pipeline", planned.status === 200 && (await row(staged)).status === "open", planned);
    const toDone = await patch(ANA, staged, { stageId: "done" });
    check("a move to a stage is checked as the move to the state it stands for (open -> done: 409)", toDone.status === 409 && toDone.body?.to === "done" && toDone.body?.broken?.[0]?.rule === "transition", toDone);
    const toStart = await patch(BO, staged, { stageId: "in_progress" });
    const stagedRow = await row(staged);
    check("…an allowed stage move goes through: the stage moves, the status is its category's, the stamp lands", toStart.status === 200 && stagedRow.status === "in_progress" && stagedRow.assignee === BO && (await admin`SELECT stage_id FROM task_workflow_instances WHERE task_id = ${staged}`)[0]?.stage_id === "in_progress", { toStart, stagedRow });
    check("…the service was told the deployment's states (x-task-states)", received.some((r) => r.states && JSON.parse(decodeURIComponent(r.states)).some((s) => s.value === "in_progress" && s.status === "in_progress")));

    // The initial state was entered by whoever created the task: four eyes from it, by the store's fallback.
    const { whoEntered } = await import(root("agent/lib/record-lifecycle-store.ts"));
    const { areaView } = await import(root("agent/lib/record-areas.ts"));
    const fresh = await createFree(CAT, { title: "Fresh" });
    const entered = await agentDb.withOrgDb(A, async (tx) => whoEntered(tx, A, { type: "task", id: fresh }, areaView("tasks"), { createdBy: CAT, status: "open" }, "open"));
    check("who entered the initial state, with no move line: the creator", entered === CAT, entered);

    // Four eyes with no move line (a task moved before its lifecycle was enforced): the last person the feed shows
    // changing it, else its creator; never nobody.
    const legacy = await createFree(BO, { title: "Moved before enforcement", dueAt: "2026-11-05T09:00:00.000Z" });
    await admin`UPDATE todos SET status = 'in_progress' WHERE id = ${legacy}`;
    await admin`INSERT INTO entity_activity (org_id, entity_type, entity_id, actor, event) VALUES (${A}, 'task', ${legacy}, ${CAT}, 'Status changed open → in_progress')`;
    const byLast = await patch(CAT, legacy, { status: "done" });
    check("no move line: whoever last changed it (by the feed) may not sign it off (409 not_by)", byLast.status === 409 && byLast.body?.broken?.some((b) => b.rule === "not_by"), byLast);
    const byOther = await patch(BO, legacy, { status: "done" });
    check("…anyone else may", byOther.status === 200 && (await row(legacy)).status === "done", byOther);
    const bare = await createFree(BO, { title: "No feed at all", dueAt: "2026-11-05T09:00:00.000Z" });
    await admin`UPDATE todos SET status = 'in_progress' WHERE id = ${bare}`;
    await admin`DELETE FROM entity_activity WHERE org_id = ${A} AND entity_id = ${bare}`;
    const byCreator = await patch(BO, bare, { status: "done" });
    check("no line at all: its creator may not sign it off (409 not_by)", byCreator.status === 409 && byCreator.body?.broken?.some((b) => b.rule === "not_by"), byCreator);
    const notCreator = await patch(ANA, bare, { status: "done" });
    check("…anyone else may", notCreator.status === 200, notCreator);

    // The agent's tool and MCP: the same rules, the same sentence.
    const mine = await createFree(ANA, { title: "Mine", dueAt: "2026-11-05T09:00:00.000Z" });
    await patch(ANA, mine, { status: "in_progress" });
    n = received.length;
    const toolSelf = await tool(todoTools.upsertTodoTool, { id: mine, status: "done" }, ANA);
    check("the agent's upsert_todo refuses the four-eyes move with the sentence that names the moves", toolSelf.error === 'Moving from "In progress" to "Done" is not possible now: "Done" (Sign off): not by the person who moved it to "In progress"; a second person must. From "In progress" you can move to: "Blocked" (Block; needs a comment), "Done" (Sign off; not by you: a second person must; needs "Due").', toolSelf);
    const toolCancel = await tool(todoTools.upsertTodoTool, { id: mine, status: "cancelled", reason: "x" }, BO);
    check("…its role is the caller's in the workspace (a member may not cancel)", /only owner or admin may make it/.test(toolCancel.error ?? ""), toolCancel);
    check("…and sent nothing", sentSince(n).length === 0, sentSince(n));
    const toolOk = await tool(todoTools.upsertTodoTool, { id: mine, status: "blocked", reason: "waiting on the bank" }, BO);
    check("…an allowed move goes through, with its line in the feed by the caller", toolOk.updated === true && (await row(mine)).status === "blocked" && lifecycleLines(await feed(mine)).some((l) => l.actor === BO && l.event === 'Status moved "In progress" → "Blocked" (Block): waiting on the bank [status: in_progress → blocked]'), { toolOk, feed: await feed(mine) });
    const mcpAna = mcpFor(ANA);
    await patch(BO, mine, { status: "in_progress" });
    const mcpSelf = await mcpFor(BO)("task_update", { id: mine, status: "done" });
    check("MCP's task_update (through the API) refuses with the same sentence", mcpSelf.error?.startsWith('Moving from "In progress" to "Done" is not possible now: "Done" (Sign off): not by the person who moved it to "In progress"; a second person must.'), mcpSelf);
    const mcpOk = await mcpAna("task_update", { id: mine, status: "done" });
    check("…and lets a second person's move through", !mcpOk.error && (await row(mine)).status === "done", mcpOk);
  }

  if (MODE === "warn") {
    // -------------------------------------------------------------------------------------------- warn: through, and noted
    const self = await patch(ANA, id, { status: "done" });
    const r = await row(id);
    check("four eyes broken under warn: the move goes through (200, done)", self.status === 200 && r.status === "done", { self, r });
    check("…and the answer carries the warning beside the item (WriteWarning: code, message, rule, moves)", Array.isArray(self.body?.warnings) && self.body.warnings.length === 1 && self.body.warnings[0].code === "lifecycle_rule_broken" && self.body.warnings[0].message.startsWith('Moving from "In progress" to "Done" is not possible now') && self.body.warnings[0].broken[0].rule === "not_by" && self.body.warnings[0].from === "in_progress" && self.body.warnings[0].to === "done" && Array.isArray(self.body.warnings[0].allowed) && self.body.item?.id === id, self.body);
    const lines = lifecycleLines(await feed(id));
    check("…and the feed names the broken rule, by the caller", lines.length === 3 && lines[1].event === 'Status moved "In progress" → "Done" [status: in_progress → done]' && lines[2].actor === ANA && lines[2].event === 'Lifecycle rule not followed (not_by): Sign off: not by the person who moved it to "In progress"; a second person must. The move went through (enforce: warn).', lines);
    const skip = await patch(BO, id, { status: "backlog" });
    check("a move the transitions do not list goes through and is noted (transition)", skip.status === 200 && (await row(id)).status === "backlog" && (await feed(id)).some((l) => l.event.startsWith("Lifecycle rule not followed (transition): ")), await feed(id));
    const other = await createFree(BO, { title: "Other" });
    const toolMove = await tool(todoTools.upsertTodoTool, { id: other, status: "cancelled" }, BO);
    check("the agent's upsert_todo moves it and reports the broken rules", toolMove.updated === true && /only owner or admin may make it; it needs a comment saying why/.test(toolMove.warnings?.[0] ?? "") && (await row(other)).status === "cancelled", toolMove);
    check("…and the feed names them", (await feed(other)).some((l) => l.actor === BO && l.event === "Lifecycle rule not followed (roles, requires_comment): Cancel: only owner or admin may make it; Cancel: it needs a comment saying why. The move went through (enforce: warn)."), await feed(other));
  }

  if (MODE === "off" || MODE === "default") {
    // ------------------------------------------------------------------------- off / default: as before, and nothing noted
    const n = received.length;
    const text = JSON.stringify({ status: "done" });
    const self = await call(ANA, "PATCH", `/api/ops/todos/${id}`, { text, id });
    check("a move that strict would refuse goes through as before (200)", self.status === 200 && (await row(id)).status === "done", self);
    check("…answered with the item alone, as before: no warnings, no next", JSON.stringify(Object.keys(self.body ?? {})) === '["item"]', Object.keys(self.body ?? {}));
    const skip = await patch(BO, id, { status: "backlog" });
    const cancel = await patch(BO, id, { status: "cancelled" });
    check("…so does every other one (no comment, no role)", skip.status === 200 && cancel.status === 200 && (await row(id)).status === "cancelled", { skip, cancel });
    check("…each body reaches the service as it was sent", sentSince(n)[0]?.text === text && JSON.parse(sentSince(n)[1]?.text ?? "{}").status === "backlog", sentSince(n));
    check("…and the feed holds only the service's own lines: no move, no rule", lifecycleLines(await feed(id)).length === 0 && (await feed(id)).every((l) => !l.event.includes("Lifecycle")), await feed(id));
    const toolMove = await tool(todoTools.upsertTodoTool, { id, status: "open" }, ANA);
    check("the agent's upsert_todo moves it as before, with no warnings", toolMove.updated === true && toolMove.warnings === undefined, toolMove);
    const direct = await create(ANA, { title: "Done already", status: "done" });
    check("a create in any state goes through as before", direct.status === 201, direct);
  }

  // ------------------------------------------------------------------------------------------ every mode: workspaces apart
  const snapshot = async () => JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${A} ORDER BY id`);
  const beforeA = await snapshot();
  const feedA = (await admin`SELECT count(*)::int AS n FROM entity_activity WHERE org_id = ${A}`)[0].n;
  const theirs = await patch(BEN, id, { status: "in_progress" });
  check("another workspace's admin cannot move A's task (404), whatever the lifecycle", theirs.status === 404, theirs);
  check("…A's tasks and A's activity feed are byte for byte what they were", (await snapshot()) === beforeA && (await admin`SELECT count(*)::int AS n FROM entity_activity WHERE org_id = ${A}`)[0].n === feedA);
  const app = postgres(process.env.DATABASE_URL, { ssl, prepare: false, max: 1, onnotice: () => {} });
  closers.push(() => app.end({ timeout: 2 }));
  const asB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return {
      lines: (await tx`SELECT event FROM entity_activity WHERE entity_id = ${id}`).filter((l) => l.event).length,
      ownOnly: (await tx`SELECT count(*)::int AS n FROM entity_activity WHERE org_id <> ${B}`)[0].n,
    };
  });
  check("under RLS, workspace B reads none of A's activity lines", asB.ownOnly === 0, asB);
  const [pol] = await admin`SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = 'entity_activity' AND p.policyname = 'org_isolation') AS policy FROM pg_class c WHERE c.relname = 'entity_activity' AND c.relnamespace = 'public'::regnamespace`;
  check("entity_activity keeps row-level security, forced, under its org_isolation policy", pol?.on === true && pol.forced === true && pol.policy === 1, pol);
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${MODE}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  server.close();
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`record-lifecycle-db-probe [${MODE}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
