#!/usr/bin/env node
/**
 * Tasks as the deployment defines them, against a real Postgres, for the definition of THIS checkout's profile
 * (scripts/test-task-area-db.mjs runs it in the checkout, the default, and in a copy under the record-areas design's
 * obligation example). The real ops routes and the agent's real todo tools as the restricted app_rw role under the
 * fail-closed policies, and the real task-workflow engine behind them: an in-process stand-in for the service calls
 * services/task-workflow/lib/engine.ts exactly as its routes do, and records every body it is sent.
 *
 *   default      a valid body reaches the service byte for byte as sent; a body the definition refuses (an own field
 *                it does not declare, a status that is not one) is a 400 with the sentence and reaches nothing;
 *                the agent's tool refuses the same;
 *   redefined    a create is checked, defaulted and normalised (own fields canonical under custom, the initial state,
 *                {me}), its status is the state's category's and it enters no stage pipeline; an invalid own value or
 *                a missing required field is a 400 with the choices named and stores nothing; a move by state
 *                writes the status and done; a direct status is refused; own fields merge per key, two writers at
 *                once both land, null clears; the agent's tool refuses and normalises the same way.
 *   both         workspace B reaches none of A's tasks or their own fields (the routes and the rows under RLS).
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
  console.log("task-area-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const REDEFINED = RECORD_AREAS.tasks.redefined;
const LABEL = REDEFINED ? "redefined" : "default";
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

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

/** Equal as objects, whatever order the keys come in (jsonb orders them its own way). */
const sameObject = (a, b) => {
  const sorted = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};
const TAG = `${process.pid}-${LABEL}`;
const A = `org-tasks-a-${TAG}`;
const B = `org-tasks-b-${TAG}`;
const ANA = `ana-${TAG}@tasks-a.test`;
const BEN = `ben-${TAG}@tasks-b.test`;

async function cleanup() {
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

// The task-workflow service, in process: its engine, its schemas, its error answers; every body it is sent, as text.
const engine = await import(pathToFileURL(`${SERVICE}/lib/engine.ts`).href);
const { withOrgTransaction } = await import(pathToFileURL(`${SERVICE}/lib/db.ts`).href);
const { taskCreateSchema, taskPatchSchema } = await import(pathToFileURL(`${SERVICE}/lib/types.ts`).href);
const { errorResponse, issueMessage } = await import(pathToFileURL(`${SERVICE}/lib/http.ts`).href);
const received = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received.push({ method: req.method, path: req.url, text });
  const ctx = { orgId: req.headers["x-org-id"], actor: String(req.headers["x-actor-email"] ?? "").toLowerCase(), role: req.headers["x-actor-role"] ?? "member" };
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
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Tasks A', 'active'), (${B}, 'Tasks B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ANA}, 'member'), (${B}, ${BEN}, 'member')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const bearers = { [ANA]: `Bearer ${await mintSessionToken(ANA)}`, [BEN]: `Bearer ${await mintSessionToken(BEN)}` };
  const orgOf = { [ANA]: A, [BEN]: B };
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
  const create = (who, body, text) => call(who, "POST", "/api/ops/todos", { body, text });
  const patch = (who, id, body) => call(who, "PATCH", `/api/ops/todos/${id}`, { body, id });
  const row = async (id) => (await admin`SELECT title, status, done, done_at, due_at, assignee, priority, custom FROM todos WHERE id = ${id}`)[0];
  const rows = async (org) => Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${org}`)[0].n);
  const instances = async (id) => Number((await admin`SELECT count(*)::int AS n FROM task_workflow_instances WHERE task_id = ${id}`)[0].n);
  const sentSince = (n) => received.slice(n).filter((r) => r.method !== "GET");

  const todoTools = await import(root("agent/lib/todo-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => t.execute(input, ctxFor(who)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

  if (!REDEFINED) {
    // ------------------------------------------------------------------------------------------ the default task
    const before = received.length;
    const text = JSON.stringify({ title: "Chase the invoice", priority: "high", createdBy: ANA });
    const ok = await create(ANA, undefined, text);
    check("a valid body is created (201)", ok.status === 201, ok);
    check("…and reaches the service byte for byte as it was sent", sentSince(before).length === 1 && sentSince(before)[0].text === text, sentSince(before));
    const id = ok.body?.item?.id;
    const stored = await row(id);
    check("…stored with no own fields ('{}') and in today's stage pipeline", JSON.stringify(stored?.custom) === "{}" && (await instances(id)) === 1, stored);
    const n = received.length;
    const own = await create(ANA, { title: "With own fields", custom: { frequency: "Monthly" } });
    check("an own field the default task does not declare is a 400 with the sentence", own.status === 400 && /There is no own field "frequency" here: this kind of record declares none\./.test(own.body?.error ?? ""), own);
    const bad = await patch(ANA, id, { status: "waiting" });
    check("a status that is not one is a 400 naming the six", bad.status === 400 && bad.body?.error?.includes('"Status" (status) must be one of: "Backlog" ("backlog")'), bad);
    check("…and neither reached the service", sentSince(n).length === 0, sentSince(n));
    const moveText = JSON.stringify({ status: "open", actor: ANA });
    const m = received.length;
    const moved = await call(ANA, "PATCH", `/api/ops/todos/${id}`, { text: moveText, id });
    check("a move by status is forwarded byte for byte and answered as before", moved.status === 200 && sentSince(m)[0]?.text === moveText && (await row(id)).status === "open", { moved, sent: sentSince(m) });
    const toolRefused = await tool(todoTools.upsertTodoTool, { title: "From the model", custom: { frequency: "Monthly" } }, ANA);
    check("the agent's upsert_todo refuses the same body, and sends nothing", typeof toolRefused.error === "string" && toolRefused.error.includes('There is no own field "frequency" here') && sentSince(m + 1).length === 0, toolRefused);
    const toolOk = await tool(todoTools.upsertTodoTool, { title: "From the model", priority: "low" }, ANA);
    check("the agent's upsert_todo creates a valid one as before", toolOk.created === true, toolOk);
  } else {
    // ---------------------------------------------------------------------------------------- the redefined task
    const v = RECORD_AREAS.tasks;
    const stateField = v.lifecycle.field;
    const before = received.length;
    const made = await create(ANA, { title: "Quarterly ALM return", dueAt: "2026-10-31", custom: { frequency: "quarterly", department: "Finance" } });
    check("a create the definition accepts is created (201)", made.status === 201, made);
    const id = made.body?.item?.id;
    const sent = JSON.parse(sentSince(before)[0]?.text ?? "{}");
    check("…sent normalised: canonical own values, the initial state, {me}, the morning of the due day, the category's status", sent.custom?.frequency === "Quarterly" && sent.custom?.[stateField] === v.lifecycle.initial && sent.assignee === ANA && sent.dueAt === "2026-10-31T09:00:00.000Z" && sent.status === "open" && sent.statusFrom === "category", sent);
    let stored = await row(id);
    check("…stored so: custom canonical, status open, not done, assignee and due date", sameObject(stored.custom, { frequency: "Quarterly", department: "Finance", [stateField]: v.lifecycle.initial }) && stored.status === "open" && stored.done === false && stored.assignee === ANA && stored.due_at?.toISOString() === "2026-10-31T09:00:00.000Z", stored);
    check("…and it entered no stage pipeline (the states are the deployment's)", (await instances(id)) === 0);
    check("the API answers it with its own fields", sameObject(made.body?.item?.custom, stored.custom), made.body?.item);

    const n = received.length;
    const countBefore = await rows(A);
    const missing = await create(ANA, { title: "No due date" });
    check("a missing required field is a 400 that names it", missing.status === 400 && missing.body?.error === '"Due" (dueAt) is required.', missing);
    const wrong = await create(ANA, { title: "x", dueAt: "2026-11-30", custom: { frequency: "Weekly", obligation_ref: "42" } });
    check("an invalid own value is a 400 that names the choices and the expected form", wrong.status === 400 && wrong.body?.errors?.[0] === '"Frequency" (frequency) must be one of: "One-time", "Monthly", "Quarterly", "Half-yearly", "Annual", "Event-based".' && /obligation_ref\) is not in the expected form/.test(wrong.body?.errors?.[1] ?? ""), wrong);
    const direct = await patch(ANA, id, { status: "done" });
    check("setting the status directly is a 400: it follows the state", direct.status === 400 && direct.body?.error?.startsWith(`\`status\` follows \`custom.${stateField}\` here`), direct);
    check("…none of them reached the service or stored anything", sentSince(n).length === 0 && (await rows(A)) === countBefore, sentSince(n));

    const moved = await patch(ANA, id, { custom: { [stateField]: "in_progress" } });
    stored = await row(id);
    check("a move by state writes the category's status (active -> in_progress), keeping the other own fields", moved.status === 200 && stored.status === "in_progress" && stored.custom.frequency === "Quarterly" && stored.custom[stateField] === "in_progress", { moved: moved.status, stored });
    await patch(ANA, id, { custom: { [stateField]: "closed" } });
    stored = await row(id);
    check("into a done state: status done, done true, a done time", stored.status === "done" && stored.done === true && stored.done_at instanceof Date, stored);
    await patch(ANA, id, { custom: { [stateField]: "in_progress" } });
    stored = await row(id);
    check("out of it again: not done, no done time", stored.status === "in_progress" && stored.done === false && stored.done_at === null, stored);

    await admin`UPDATE todos SET custom = custom || '{"retired_key": "kept"}'::jsonb WHERE id = ${id}`;
    const [x, y] = await Promise.all([patch(ANA, id, { custom: { obligation_ref: "OBL-0001" } }), patch(ANA, id, { custom: { clause: "https://example.com/c#4" } })]);
    stored = await row(id);
    check("two writers of different own fields at once: both land", x.status === 200 && y.status === 200 && stored.custom.obligation_ref === "OBL-0001" && stored.custom.clause === "https://example.com/c#4", stored.custom);
    check("a stored key the profile does not declare is carried through", stored.custom.retired_key === "kept", stored.custom);
    await patch(ANA, id, { custom: { department: null } });
    stored = await row(id);
    check("null clears one own field and nothing else", !("department" in stored.custom) && stored.custom.frequency === "Quarterly", stored.custom);

    const m = received.length;
    const toolRefused = await tool(todoTools.upsertTodoTool, { title: "From the model", dueAt: "2026-12-01", custom: { frequency: "Weekly" } }, ANA);
    check("the agent's upsert_todo refuses an invalid own value with the choices, and sends nothing", typeof toolRefused.error === "string" && toolRefused.error.includes('"Frequency" (frequency) must be one of') && sentSince(m).length === 0, toolRefused);
    const toolMade = await tool(todoTools.upsertTodoTool, { title: "From the model", dueAt: "2026-12-01", custom: { frequency: "annual" } }, ANA);
    const toolRow = toolMade.created ? await row(toolMade.todo.id) : null;
    check("…and creates a valid one normalised, in its initial state, assigned to the caller", toolRow?.custom?.frequency === "Annual" && toolRow?.custom?.[stateField] === v.lifecycle.initial && toolRow?.assignee === ANA && toolRow?.status === "open", { toolMade, toolRow });
    const toolMove = await tool(todoTools.upsertTodoTool, { id: toolMade.todo?.id, custom: { [stateField]: "not_applicable" } }, ANA);
    check("…and moves it by state (cancelled category -> status cancelled)", toolMove.updated === true && (await row(toolMade.todo.id)).status === "cancelled", toolMove);
    const listed = await tool(todoTools.listTodosTool, { includeDone: true }, ANA);
    check("list_todos returns each one's state and own fields", Array.isArray(listed.todos) && listed.todos.some((t) => t.id === id && t.state === "in_progress" && t.custom?.frequency === "Quarterly"), listed);
  }

  // ------------------------------------------------------------------------------------------ both: workspaces apart
  const mine = (await admin`SELECT id FROM todos WHERE org_id = ${A} ORDER BY created_at LIMIT 1`)[0].id;
  const snapshot = async () => JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${A} ORDER BY id`);
  const beforeA = await snapshot();
  const theirs = await patch(BEN, mine, REDEFINED ? { custom: { frequency: "Monthly" } } : { title: "taken" });
  check("another workspace's member cannot change A's task through the API (404)", theirs.status === 404, theirs);
  const app = postgres(process.env.DATABASE_URL, { ssl, prepare: false, max: 1, onnotice: () => {} });
  closers.push(() => app.end({ timeout: 2 }));
  const asB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return {
      read: (await tx`SELECT custom FROM todos WHERE id = ${mine}`).length,
      wrote: (await tx`UPDATE todos SET custom = custom || '{"planted": true}'::jsonb WHERE id = ${mine} RETURNING id`).length,
    };
  });
  check("under RLS, workspace B reads none of A's tasks' own fields and changes none", asB.read === 0 && asB.wrote === 0, asB);
  check("A's tasks are byte for byte what they were", (await snapshot()) === beforeA);
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  server.close();
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`task-area-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
