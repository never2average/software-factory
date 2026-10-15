#!/usr/bin/env node
/**
 * Who may write a record, and the declared metrics, against a real Postgres, for the definitions of THIS checkout's
 * profile (scripts/test-record-permissions-db.mjs runs it in the checkout, the default, and in a copy under
 * scripts/fixtures/record-areas/examples/{compliance,obligation,programme,permissions}.json). The real ops routes, the
 * real upsert_customer, the real agent tools (upsert_<area>, upsert_todo, hide_todo, upsert_cycle), as the restricted
 * app_rw role under the fail-closed policies, and the real task-workflow engine behind the task routes (an in-process
 * stand-in for the service, as scripts/lib/task-area-db-probe.mjs runs it).
 *
 *   default    nothing is declared: a member creates, changes, moves, archives and deletes every kind of record, on
 *              every path, as before; the metrics route answers none.
 *   declared   every role rule on every path: a filing deleted or its reviewer set by an owner or an admin only; a
 *              programme created by an owner, an admin or an engineer, changed by an owner or an admin or by its own
 *              owner (own row), its risk by an owner or an admin; a task changed by an owner or an admin or the person
 *              it is assigned to, its reviewer and its delete (or archive) by an owner or an admin; a period opened by
 *              an owner or an admin, changed or rolled over by them or an engineer, deleted by an owner. A refusal is a
 *              403 with the sentence and changes nothing. The metrics equal what the list query counts for the same
 *              condition.
 *   both       workspace B reaches none of A's records and counts none of them.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw); TASK_AREA_SERVICE_ROOT names the task service's directory (a copy has none).
 */
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
if (!adminUrl || !process.env.DATABASE_URL) {
  console.log("record-permissions-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "record-permissions-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const DECLARED = Boolean(RECORD_AREAS.implementations.permissions?.update && RECORD_AREAS.implementations.permissions.update !== "*");
const LABEL = DECLARED ? "declared" : "default";
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
const TAG = `${process.pid}-${LABEL}`;
const A = `org-perm-a-${TAG}`;
const B = `org-perm-b-${TAG}`;
const OWNER = `olga-${TAG}@perm-a.test`;
const ADMIN = `adam-${TAG}@perm-a.test`;
const ENG = `eli-${TAG}@perm-a.test`;
const MEM = `mia-${TAG}@perm-a.test`;
const MEM2 = `max-${TAG}@perm-a.test`;
const BEN = `ben-${TAG}@perm-b.test`;
const CO = "acme-shared";
const CO2 = "beta-only-a";
const CO3 = "gamma-only-a";

async function cleanup() {
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "cycle_member_goals", "cycles", "deployments", "implementation", "customers", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

// The task-workflow service, in process (its engine, schemas and answers), as scripts/lib/task-area-db-probe.mjs runs it.
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
    if (one && req.method === "DELETE") {
      await withOrgTransaction(ctx.orgId, (sql) => engine.deleteTask(sql, ctx, one[1]));
      return send(Response.json({ ok: true }));
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
/** One part of the probe: a throw is one failure, and the parts after it still run. */
const section = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log(`  FAIL [${LABEL}] the ${name} part threw — ${e?.stack ?? e}`);
  }
};
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Perm A', 'active'), (${B}, 'Perm B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${OWNER}, 'owner'), (${A}, ${ADMIN}, 'admin'), (${A}, ${ENG}, 'engineer'), (${A}, ${MEM}, 'member'), (${A}, ${MEM2}, 'member'), (${B}, ${BEN}, 'owner')`;
  // Two workspaces each hold an account with the same id; A has two more.
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Acme (A)'), (${CO2}, ${A}, 'Beta (A)'), (${CO3}, ${A}, 'Gamma (A)'), (${CO}, ${B}, 'Acme (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const people = [OWNER, ADMIN, ENG, MEM, MEM2, BEN];
  const bearers = Object.fromEntries(await Promise.all(people.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = (who) => (who === BEN ? B : A);
  const H = "http://perm.test";
  /** A route handler, called as the person: `file` under app/api/ops, `path` the URL path, `params` the dynamic ones. */
  const call = async (who, method, file, path, { body, params } = {}) => {
    const handlers = await import(root(`app/api/ops/${file}/route.ts`));
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf(who), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, params ? { params: Promise.resolve(params) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const dep = async (org, id) => (await admin`SELECT * FROM deployments WHERE org_id = ${org} AND deployment_id = ${id}`)[0];
  const imp = async (org, co) => (await admin`SELECT * FROM implementation WHERE org_id = ${org} AND customer_id = ${co}`)[0];
  const todo = async (id) => (await admin`SELECT * FROM todos WHERE id = ${id}`)[0];
  const cycle = async (id) => (await admin`SELECT * FROM cycles WHERE id = ${id}`)[0];
  const sor = await import(root("agent/lib/system-of-record.ts"));
  const areaTools = await import(root("agent/lib/record-area-tools.ts"));
  const todoTools = await import(root("agent/lib/todo-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const nested = (who, patch) => sor.upsertCustomer(patch, orgOf(who), { actor: who }).then(() => "ok", (e) => String(e?.message ?? e));
  const is403 = (r, re) => r.status === 403 && typeof r.body?.error === "string" && re.test(r.body.error);
  const sentSince = (n) => received.slice(n).filter((r) => r.method !== "GET");
  // The coding agent's MCP tools, through the routes, as the hosted endpoint calls them (lib/mcp-server.ts api()).
  const { createTools } = await import(root("setup/workspace-tools.mjs"));
  const { FOLDER } = await import(root("agent/lib/dataroom-folders.ts"));
  const ROUTES = [[/^\/api\/ops\/cycles\/([^/]+)\/rollover$/, "cycles/[id]/rollover"], [/^\/api\/ops\/(deployments|implementations|todos|cycles)\/([^/]+)$/, null], [/^\/api\/ops\/(deployments|implementations|todos|cycles)$/, null]];
  const mcpFor = (who) => {
    const api = async (method, path, body) => {
      const bare = path.split("?")[0];
      let file = null;
      let params;
      for (const [re, named] of ROUTES) {
        const m = re.exec(bare);
        if (!m) continue;
        if (named) { file = named; params = { id: decodeURIComponent(m[1]) }; }
        else if (m[2] !== undefined) { file = `${m[1]}/[id]`; params = { id: decodeURIComponent(m[2]) }; }
        else file = m[1];
        break;
      }
      if (!file) throw new Error(`no route for ${path} in this probe`);
      const r = await call(who, method, file, path, { body: method === "GET" || method === "DELETE" ? undefined : body, params });
      if (r.status >= 400) throw new Error(r.body?.error ?? `HTTP ${r.status} from ${path}`);
      return r.body;
    };
    const tools = createTools({ api, folders: FOLDER, actor: who, blobStore: () => null, getOrg: () => orgOf(who), setOrg: () => {} });
    return (name, args) => tools.find((t) => t.name === name).handler(args).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  };

  if (!DECLARED) {
    // ---------------------------------------------------------------------------- the default: a member does it all
    const d = await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: { customerId: CO, deploymentId: "D-1", environment: "prod", region: "us-east-1", deployedVersion: "1.0" } });
    check("a member creates a deployment (201), as before", d.status === 201, d);
    const dp = await call(MEM, "PATCH", "deployments/[id]", "/api/ops/deployments/D-1", { body: { customerId: CO, releaseStatus: "deployed", deployOwnerEmail: MEM }, params: { id: "D-1" } });
    check("…changes it (200)", dp.status === 200 && (await dep(A, "D-1"))?.release_status === "deployed", dp);
    const dd = await call(MEM, "DELETE", "deployments/[id]", `/api/ops/deployments/D-1?customerId=${CO}`, { params: { id: "D-1" } });
    check("…and deletes it (200)", dd.status === 200 && !(await dep(A, "D-1")), dd);
    const i = await call(MEM, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO, implementationStage: "Kickoff" } });
    check("a member creates an implementation", i.status === 201, i);
    const id = await call(MEM, "DELETE", "implementations/[id]", `/api/ops/implementations/${CO}?customerId=${CO}`, { params: { id: CO } });
    check("…and deletes it", id.status === 200 && !(await imp(A, CO)), id);
    const nMade = await nested(MEM, { id: CO2, deployments: [{ deploymentId: "N-1", environment: "prod", region: "us-east-1", deployedVersion: "1", releaseStatus: "deployed", healthStatus: "healthy" }] });
    const nGone = await nested(MEM, { id: CO2, deployments: [{ deploymentId: "N-1", remove: true }] });
    check("upsert_customer: a member creates, then removes, a nested deployment", nMade === "ok" && nGone === "ok" && !(await dep(A, "N-1")), { nMade, nGone });
    const t = await call(MEM, "POST", "todos", "/api/ops/todos", { body: { title: "Chase", createdBy: MEM, assignee: MEM2 } });
    check("a member creates a task", t.status === 201, t);
    const tid = t.body?.item?.id;
    const n = received.length;
    const text = { title: "Chase (late)", actor: MEM };
    const tp = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: text, params: { id: tid } });
    check("…changes another person's task, the body reaching the service byte for byte", tp.status === 200 && sentSince(n)[0]?.text === JSON.stringify(text), { tp, sent: sentSince(n) });
    const ta = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { archived: true }, params: { id: tid } });
    check("…archives it", ta.status === 200 && (await todo(tid))?.archived_at !== null, ta);
    const td = await call(MEM, "DELETE", "todos/[id]", `/api/ops/todos/${tid}`, { params: { id: tid } });
    check("…and deletes it", td.status === 200 && !(await todo(tid)), td);
    const hidden = await tool(todoTools.upsertTodoTool, { title: "From the model" }, MEM);
    const hid = await tool(todoTools.hideTodoTool, { id: hidden.todo?.id }, MEM);
    check("upsert_todo and hide_todo: a member creates and hides one", hidden.created === true && hid.hidden === true, { hidden, hid });
    const c = await call(MEM, "POST", "cycles", "/api/ops/cycles", { body: { name: "P-1", createdBy: MEM } });
    check("a member opens a period", c.status === 201, c);
    const cid = c.body?.item?.id;
    const cp = await call(MEM, "PATCH", "cycles/[id]", `/api/ops/cycles/${cid}`, { body: { goal: "Ship", state: "active" }, params: { id: cid } });
    const cr = await call(MEM, "POST", "cycles/[id]/rollover", `/api/ops/cycles/${cid}/rollover`, { body: {}, params: { id: cid } });
    const cd = await call(MEM, "DELETE", "cycles/[id]", `/api/ops/cycles/${cid}`, { params: { id: cid } });
    check("…changes it, rolls it over and deletes it", cp.status === 200 && cr.status === 200 && cd.status === 200 && !(await cycle(cid)), { cp, cr, cd });
    const uc = await tool(todoTools.upsertCycleTool, { name: "P-2" }, MEM);
    check("upsert_cycle: a member opens one", uc.created === true, uc);
    await section("metrics", async () => {
      const m = await call(MEM, "GET", "record-metrics", "/api/ops/record-metrics?area=deployments");
      const m2 = await call(MEM, "GET", "record-metrics", "/api/ops/record-metrics?area=implementations");
      check("the metrics route answers none: nothing is declared", m.status === 200 && JSON.stringify(m.body) === '{"metrics":[]}' && JSON.stringify(m2.body) === '{"metrics":[]}', { m, m2 });
    });
  } else {
    // ---------------------------------------------------------------------------- deployments: the live packs' rule
    const filing = (id, extra = {}) => ({ customerId: CO, deploymentId: id, runtime: "Periodic return", deployedVersion: id, custom: { due_date: "2026-01-31" }, ...extra });
    const made = await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-1") });
    check("deployments: a member creates a filing (create \"*\")", made.status === 201, made);
    const rev = await call(MEM, "PATCH", "deployments/[id]", "/api/ops/deployments/F-1", { body: { customerId: CO, approvedByEmail: MEM }, params: { id: "F-1" } });
    check("…a member setting its reviewer is a 403 with the sentence, and nothing changes", is403(rev, /^Only an owner or an admin can change ".+" on a .+\.$/) && (await dep(A, "F-1"))?.approved_by_email === null, rev);
    const rev2 = await call(ADMIN, "PATCH", "deployments/[id]", "/api/ops/deployments/F-1", { body: { customerId: CO, approvedByEmail: ADMIN }, params: { id: "F-1" } });
    check("…an admin sets it (200)", rev2.status === 200 && (await dep(A, "F-1"))?.approved_by_email === ADMIN, rev2);
    const notes = await call(MEM, "PATCH", "deployments/[id]", "/api/ops/deployments/F-1", { body: { customerId: CO, notes: "late" }, params: { id: "F-1" } });
    check("…a member changes its other fields (update \"*\")", notes.status === 200 && (await dep(A, "F-1"))?.notes === "late", notes);
    const viaCreate = await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-2", { approvedByEmail: MEM }) });
    check("…a member creating one with a reviewer is refused (403) and nothing is stored", is403(viaCreate, /Only an owner or an admin can change/) && !(await dep(A, "F-2")), viaCreate);
    for (const who of [MEM, ENG]) {
      const del = await call(who, "DELETE", "deployments/[id]", `/api/ops/deployments/F-1?customerId=${CO}`, { params: { id: "F-1" } });
      check(`…${who === MEM ? "a member" : "an engineer"} deleting it is a 403 with the sentence, and it stays`, is403(del, /^Only an owner or an admin can delete a .+\.$/) && Boolean(await dep(A, "F-1")), del);
    }
    // The agent's tool, as the caller's role.
    const upsertDep = areaTools.upsertAreaTool("deployments");
    const toolRev = await tool(upsertDep, { customerId: CO, deploymentId: "F-1", values: { approvedByEmail: MEM } }, MEM);
    check("upsert_<filing>: a member setting the reviewer is refused with the sentence; nothing changes", /Only an owner or an admin can change/.test(toolRev.error ?? "") && (await dep(A, "F-1"))?.approved_by_email === ADMIN, toolRev);
    const toolOk = await tool(upsertDep, { customerId: CO, deploymentId: "F-1", values: { approvedByEmail: OWNER } }, OWNER);
    check("…an owner sets it", toolOk.updated === true && (await dep(A, "F-1"))?.approved_by_email === OWNER, toolOk);
    // upsert_customer's nested rows.
    const nestedRev = await nested(MEM, { id: CO, deployments: [{ deploymentId: "F-1", approvedByEmail: MEM }] });
    check("upsert_customer: a member setting a nested filing's reviewer is refused, nothing written", /Only an owner or an admin can change/.test(nestedRev) && (await dep(A, "F-1"))?.approved_by_email === OWNER, nestedRev);
    const nestedDel = await nested(MEM, { id: CO, deployments: [{ deploymentId: "F-1", remove: true }] });
    check("upsert_customer: a member removing a nested filing is refused with the sentence, and it stays", /F-1: Only an owner or an admin can delete/.test(nestedDel) && Boolean(await dep(A, "F-1")), nestedDel);
    const nestedNotes = await nested(MEM, { id: CO, deployments: [{ deploymentId: "F-1", notes: "from the model" }] });
    check("upsert_customer: a member changes a nested filing's other fields", nestedNotes === "ok" && (await dep(A, "F-1"))?.notes === "from the model", nestedNotes);
    // Workspace B: its owner reaches none of A's filings (B holds an account with the same id).
    const bDel = await call(BEN, "DELETE", "deployments/[id]", `/api/ops/deployments/F-1?customerId=${CO}`, { params: { id: "F-1" } });
    check("workspace B's owner deleting A's filing finds nothing (404), and it stays", bDel.status === 404 && Boolean(await dep(A, "F-1")), bDel);
    const adminDel = await call(ADMIN, "DELETE", "deployments/[id]", `/api/ops/deployments/F-1?customerId=${CO}`, { params: { id: "F-1" } });
    check("an admin deletes it (200)", adminDel.status === 200 && !(await dep(A, "F-1")), adminDel);
    await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-3") });
    const ownerNested = await nested(OWNER, { id: CO, deployments: [{ deploymentId: "F-3", remove: true }] });
    check("upsert_customer: an owner removes a nested filing", ownerNested === "ok" && !(await dep(A, "F-3")), ownerNested);

    // ------------------------------------------------------------------------ implementations: roles and own row
    const created = await call(MEM, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO, rolloutId: "P-1", implementationStage: "Kickoff" } });
    check("implementations: a member creating a programme is a 403 with the sentence, nothing stored", is403(created, /^Only an owner, an admin or an engineer can add a/) && !(await imp(A, CO)), created);
    const byEng = await call(ENG, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO, rolloutId: "P-1", implementationStage: "Kickoff", implementationOwnerEmail: MEM } });
    check("…an engineer creates one, owned by a member", byEng.status === 201 && (await imp(A, CO))?.implementation_owner_email === MEM, byEng);
    const pid = CO;
    const mine = await call(MEM, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, blocker: "vendor" }, params: { id: pid } });
    check("own row: its owner (a member) changes it", mine.status === 200 && (await imp(A, CO))?.blocker === "vendor", mine);
    const move = await call(MEM, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, implementationStage: "Discovery" }, params: { id: pid } });
    check("…and moves it", move.status === 200 && (await imp(A, CO))?.implementation_stage === "Discovery", move);
    const notMine = await call(MEM2, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, blocker: "someone else" }, params: { id: pid } });
    check("…another member changing it is a 403 that names the rule, and nothing changes", is403(notMine, /only when you are its .+; an owner or an admin can change any\.$/) && (await imp(A, CO))?.blocker === "vendor", notMine);
    const eng = await call(ENG, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, blocker: "eng" }, params: { id: pid } });
    check("…so is an engineer (not an owner or an admin, not its owner)", eng.status === 403 && (await imp(A, CO))?.blocker === "vendor", eng);
    const risk = await call(MEM, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, implementationRiskLevel: "Red" }, params: { id: pid } });
    check("…its owner setting the risk is a 403 (an owner's or an admin's field), nothing changes", is403(risk, /^Only an owner or an admin can change "/) && (await imp(A, CO))?.implementation_risk_level !== "Red", risk);
    const adminRisk = await call(ADMIN, "PATCH", "implementations/[id]", `/api/ops/implementations/${pid}`, { body: { customerId: CO, implementationRiskLevel: "Red" }, params: { id: pid } });
    check("…an admin sets it", adminRisk.status === 200 && (await imp(A, CO))?.implementation_risk_level === "Red", adminRisk);
    const upsertImp = areaTools.upsertAreaTool("implementations");
    const toolOther = await tool(upsertImp, { customerId: CO, values: { blocker: "from the model" } }, MEM2);
    check("upsert_<programme>: another member is refused with the sentence", /only when you are its/.test(toolOther.error ?? "") && (await imp(A, CO))?.blocker === "vendor", toolOther);
    const toolOwn = await tool(upsertImp, { customerId: CO, values: { blocker: "from the model" } }, MEM);
    check("…its owner is let through", toolOwn.updated === true && (await imp(A, CO))?.blocker === "from the model", toolOwn);
    const nestOther = await nested(MEM2, { id: CO, implementation: { blocker: "nested" } });
    check("upsert_customer: another member changing the nested programme is refused, nothing written", /only when you are its/.test(nestOther) && (await imp(A, CO))?.blocker === "from the model", nestOther);
    const nestOwn = await nested(MEM, { id: CO, implementation: { blocker: "nested" } });
    check("…its owner changes it", nestOwn === "ok" && (await imp(A, CO))?.blocker === "nested", nestOwn);
    const nestRemove = await nested(MEM, { id: CO, implementation: { remove: true } });
    check("…its owner removing it is refused (own lets a member change, not delete)", /Only an owner or an admin can delete/.test(nestRemove) && Boolean(await imp(A, CO)), nestRemove);
    const memDel = await call(MEM, "DELETE", "implementations/[id]", `/api/ops/implementations/${pid}?customerId=${CO}`, { params: { id: pid } });
    check("…deleting it through the route is a 403, and it stays", is403(memDel, /^Only an owner or an admin can delete/) && Boolean(await imp(A, CO)), memDel);

    // ------------------------------------------------------------------------------- the metrics, against the list
    await section("metrics", async () => {
      // A's programmes: CO (Red, Discovery), CO2 (Red, Go-Live, past deadline), CO3 (Green, Kickoff, past deadline).
      await call(ADMIN, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO2, rolloutId: "P-2", implementationStage: "Go-Live", implementationRiskLevel: "Red", targetGoLiveDate: "2026-01-01", implementationProgressPct: 100 } });
      await call(ADMIN, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO3, rolloutId: "P-3", implementationStage: "Kickoff", targetGoLiveDate: "2020-01-01", implementationProgressPct: 30 } });
      await admin`UPDATE implementation SET implementation_progress_pct = 20 WHERE org_id = ${A} AND customer_id = ${CO}`;
      // B's one programme, Red and past its deadline: never counted in A.
      const bMade = await call(BEN, "POST", "implementations", "/api/ops/implementations", { body: { customerId: CO, rolloutId: "B-1", implementationStage: "Kickoff", implementationRiskLevel: "Red", targetGoLiveDate: "2020-01-01", implementationProgressPct: 50 } });
      check("workspace B's owner creates its own programme on its own account of the same id", bMade.status === 201 && Boolean(await imp(B, CO)), bMade);
      const metrics = await call(MEM, "GET", "record-metrics", "/api/ops/record-metrics?area=implementations");
      const byId = Object.fromEntries((metrics.body?.metrics ?? []).map((m) => [m.id, m]));
      const listCount = async (where) => {
        const r = await call(MEM, "GET", "implementations", `/api/ops/implementations?where=${encodeURIComponent(JSON.stringify(where))}&limit=300`);
        return r.status === 200 ? r.body.items.length : `list ${r.status} ${JSON.stringify(r.body)}`;
      };
      const today = new Date().toISOString().slice(0, 10);
      const def = Object.fromEntries(RECORD_AREAS.implementations.metrics.map((m) => [m.id, m]));
      const atRisk = await listCount(def["at-risk"].count.where);
      check("metrics: \"at risk\" is the list's count for the same condition, flagged for attention", byId["at-risk"]?.value === atRisk && atRisk === 2 && byId["at-risk"].attention === true, { metric: byId["at-risk"], atRisk });
      const past = await listCount(JSON.parse(JSON.stringify(def["past-deadline"].count.where).replaceAll("{today}", today)));
      check("metrics: \"past their deadline\" ({today} and open categories) is the list's count", byId["past-deadline"]?.value === past && past === 1, { metric: byId["past-deadline"], past });
      const all = await listCount({});
      const live = await listCount(def["live-rate"].ratio.num);
      check("metrics: the ratio is the list's numerator over its denominator, as a percent", byId["live-rate"]?.value === (live / all) * 100 && byId["live-rate"].text === `${Math.round((live / all) * 100)}%`, { metric: byId["live-rate"], live, all });
      const [{ s }] = await admin`SELECT coalesce(sum(implementation_progress_pct), 0)::float8 AS s FROM implementation WHERE org_id = ${A}`;
      check("metrics: the sum adds up the workspace's own rows only", byId.progress?.value === s && s === 150, { metric: byId.progress, s });
      const bMetrics = await call(BEN, "GET", "record-metrics", "/api/ops/record-metrics?area=implementations");
      const bById = Object.fromEntries((bMetrics.body?.metrics ?? []).map((m) => [m.id, m.value]));
      check("workspace B counts only its own programme (none of A's)", bById["at-risk"] === 1 && bById["past-deadline"] === 1 && bById.progress === 50, bMetrics.body);
      // The filing's metrics: a computed field (timeliness) and a ratio over the lifecycle's category.
      await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-10", { custom: { due_date: "2020-01-31" } }) });
      await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-11", { releaseStatus: "deployed", lastDeployAt: "2020-01-30", custom: { due_date: "2020-01-31" } }) });
      await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-12", { custom: { due_date: "2099-01-31" } }) });
      const dm = await call(MEM, "GET", "record-metrics", "/api/ops/record-metrics?area=deployments");
      const dById = Object.fromEntries((dm.body?.metrics ?? []).map((m) => [m.id, m]));
      const dCount = async (where) => {
        const r = await call(MEM, "GET", "deployments", `/api/ops/deployments?where=${encodeURIComponent(JSON.stringify(where))}&limit=300`);
        return r.status === 200 ? r.body.items.length : `list ${r.status} ${JSON.stringify(r.body)}`;
      };
      const ddef = Object.fromEntries(RECORD_AREAS.deployments.metrics.map((m) => [m.id, m]));
      const overdue = await dCount(ddef.overdue.count.where);
      check("metrics: the filings overdue (a computed field) are the list's count", dById.overdue?.value === overdue && overdue === 1 && dById.overdue.attention === true, { metric: dById.overdue, overdue });
      const den = await dCount(ddef["on-time-rate"].ratio.den);
      const num = await dCount({ ...ddef["on-time-rate"].ratio.den, ...ddef["on-time-rate"].ratio.num });
      check("metrics: the on-time rate is the list's numerator within its denominator", dById["on-time-rate"]?.value === (den ? (num / den) * 100 : 0) && den === 1 && num === 1, { metric: dById["on-time-rate"], num, den });
    });

    // --------------------------------------------------------------------------------- tasks: own row, a field, delete
    const t = await call(MEM, "POST", "todos", "/api/ops/todos", { body: { title: "Quarterly return", dueAt: "2026-10-31", createdBy: MEM } });
    check("tasks: a member creates one, assigned to them ({me})", t.status === 201 && (await todo(t.body?.item?.id))?.assignee === MEM, t);
    const tid = t.body?.item?.id;
    let n = received.length;
    const other = await call(MEM2, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { title: "Renamed by another" }, params: { id: tid } });
    check("…another member changing it is a 403 that names the rule, and nothing reaches the service", is403(other, /only when you are its .+; an owner or an admin can change any\.$/) && sentSince(n).length === 0 && (await todo(tid))?.title === "Quarterly return", other);
    const own = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { title: "Quarterly return (Q3)" }, params: { id: tid } });
    check("…its assignee changes it", own.status === 200 && (await todo(tid))?.title === "Quarterly return (Q3)", own);
    const moved = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { custom: { state: "in_progress" } }, params: { id: tid } });
    check("…and moves it", moved.status === 200 && (await todo(tid))?.custom?.state === "in_progress", moved);
    n = received.length;
    const reviewer = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { custom: { reviewer: MEM2 } }, params: { id: tid } });
    check("…its assignee setting the reviewer is a 403 (an owner's or an admin's field), nothing sent", is403(reviewer, /^Only an owner or an admin can change "/) && sentSince(n).length === 0, reviewer);
    const adminReviewer = await call(ADMIN, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { custom: { reviewer: MEM2 } }, params: { id: tid } });
    check("…an admin sets it", adminReviewer.status === 200 && (await todo(tid))?.custom?.reviewer === MEM2, adminReviewer);
    const archive = await call(MEM, "PATCH", "todos/[id]", `/api/ops/todos/${tid}`, { body: { archived: true }, params: { id: tid } });
    check("…its assignee archiving it is a delete: 403", is403(archive, /^Only an owner or an admin can delete/) && (await todo(tid))?.archived_at === null, archive);
    n = received.length;
    const del = await call(MEM, "DELETE", "todos/[id]", `/api/ops/todos/${tid}`, { params: { id: tid } });
    check("…deleting it is a 403 with the sentence, nothing reaches the service, and it stays", is403(del, /^Only an owner or an admin can delete/) && sentSince(n).length === 0 && Boolean(await todo(tid)), del);
    const toolOtherTask = await tool(todoTools.upsertTodoTool, { id: tid, title: "From the model" }, MEM2);
    check("upsert_todo: another member is refused with the sentence", /only when you are its/.test(toolOtherTask.error ?? "") && (await todo(tid))?.title === "Quarterly return (Q3)", toolOtherTask);
    const toolOwnTask = await tool(todoTools.upsertTodoTool, { id: tid, title: "From the model" }, MEM);
    check("…its assignee is let through", toolOwnTask.updated === true && (await todo(tid))?.title === "From the model", toolOwnTask);
    const hideRefused = await tool(todoTools.hideTodoTool, { id: tid }, MEM);
    check("hide_todo: a member is refused (hiding is a delete), the task stays", /Only an owner or an admin can delete/.test(hideRefused.error ?? "") && (await todo(tid))?.archived_at === null, hideRefused);
    const bTask = await call(BEN, "DELETE", "todos/[id]", `/api/ops/todos/${tid}`, { params: { id: tid } });
    check("workspace B's owner deleting A's task reaches nothing, and it stays", bTask.status !== 200 && Boolean(await todo(tid)), bTask);
    const hideOk = await tool(todoTools.hideTodoTool, { id: tid }, ADMIN);
    check("hide_todo: an admin hides it", hideOk.hidden === true && (await todo(tid))?.archived_at !== null, hideOk);
    const adminDelTask = await call(ADMIN, "DELETE", "todos/[id]", `/api/ops/todos/${tid}`, { params: { id: tid } });
    check("…and deletes it", adminDelTask.status === 200 && !(await todo(tid)), adminDelTask);

    // -------------------------------------------------------------------------------------------- periods: roles
    const memOpen = await call(MEM, "POST", "cycles", "/api/ops/cycles", { body: { createdBy: MEM } });
    check("periods: a member opening one is a 403 with the sentence", is403(memOpen, /^Only an owner or an admin can add a/), memOpen);
    const toolOpen = await tool(todoTools.upsertCycleTool, { name: "Week" }, ENG);
    check("…so is an engineer through upsert_cycle", /Only an owner or an admin can add a/.test(toolOpen.error ?? ""), toolOpen);
    const open = await call(ADMIN, "POST", "cycles", "/api/ops/cycles", { body: { createdBy: ADMIN } });
    check("…an admin opens one", open.status === 201, open);
    const cid = open.body?.item?.id;
    const memGoal = await call(MEM, "PATCH", "cycles/[id]", `/api/ops/cycles/${cid}`, { body: { name: "Renamed" }, params: { id: cid } });
    check("…a member changing it is a 403", is403(memGoal, /^Only an owner, an admin or an engineer can change a/) && (await cycle(cid))?.name !== "Renamed", memGoal);
    const engGoal = await call(ENG, "PATCH", "cycles/[id]", `/api/ops/cycles/${cid}`, { body: { name: "Renamed" }, params: { id: cid } });
    check("…an engineer changes it", engGoal.status === 200 && (await cycle(cid))?.name === "Renamed", engGoal);
    const memTool = await tool(todoTools.upsertCycleTool, { id: cid, name: "By the model" }, MEM);
    check("…upsert_cycle refuses a member's change", /Only an owner, an admin or an engineer can change/.test(memTool.error ?? "") && (await cycle(cid))?.name === "Renamed", memTool);
    const memRoll = await call(MEM, "POST", "cycles/[id]/rollover", `/api/ops/cycles/${cid}/rollover`, { body: {}, params: { id: cid } });
    check("…a member's rollover is a 403", is403(memRoll, /^Only an owner, an admin or an engineer can change a/), memRoll);
    const engRoll = await call(ENG, "POST", "cycles/[id]/rollover", `/api/ops/cycles/${cid}/rollover`, { body: {}, params: { id: cid } });
    check("…an engineer's goes through", engRoll.status === 200, engRoll);
    for (const who of [ADMIN, ENG]) {
      const d = await call(who, "DELETE", "cycles/[id]", `/api/ops/cycles/${cid}`, { params: { id: cid } });
      check(`…${who === ADMIN ? "an admin" : "an engineer"} deleting it is a 403 (an owner's), and it stays`, is403(d, /^Only an owner can delete a/) && Boolean(await cycle(cid)), d);
    }
    const bCycle = await call(BEN, "DELETE", "cycles/[id]", `/api/ops/cycles/${cid}`, { params: { id: cid } });
    check("workspace B's owner deleting A's period finds nothing, and it stays", bCycle.status === 404 && Boolean(await cycle(cid)), bCycle);
    const ownerDel = await call(OWNER, "DELETE", "cycles/[id]", `/api/ops/cycles/${cid}`, { params: { id: cid } });
    check("…an owner deletes it", ownerDel.status === 200 && !(await cycle(cid)), ownerDel);

    // ------------------------------------------------------------------- MCP: the coding agent's tools, the same rules
    await section("MCP", async () => {
      const mem = mcpFor(MEM);
      await call(MEM, "POST", "deployments", "/api/ops/deployments", { body: filing("F-20") });
      const rev = await mem("deployment_upsert", { customerId: CO, deploymentId: "F-20", custom: {}, approvedByEmail: MEM });
      check("MCP deployment_upsert: a member setting the reviewer is refused with the sentence", /Only an owner or an admin can change/.test(rev.error ?? "") && (await dep(A, "F-20"))?.approved_by_email === null, rev);
      const prog = await mcpFor(MEM2)("implementation_upsert", { customerId: CO, implementationProgressPct: 90 });
      check("MCP implementation_upsert: a member changing another's programme is refused", /only when you are its/.test(prog.error ?? "") && (await imp(A, CO))?.implementation_progress_pct !== 90, prog);
      const t2 = await call(MEM, "POST", "todos", "/api/ops/todos", { body: { title: "Board KYC review", dueAt: "2026-11-30", createdBy: MEM } });
      const t2id = t2.body?.item?.id;
      const upd = await mcpFor(MEM2)("task_update", { id: t2id, title: "Renamed through MCP" });
      check("MCP task_update: another member is refused with the sentence", /only when you are its/.test(upd.error ?? "") && (await todo(t2id))?.title === "Board KYC review", upd);
      const del = await mem("task_delete", { id: t2id });
      check("MCP task_delete: a member is refused with the sentence, and the task stays", /Only an owner or an admin can delete/.test(del.error ?? "") && Boolean(await todo(t2id)), del);
      const ok = await mcpFor(ADMIN)("task_delete", { id: t2id });
      check("…an admin's goes through", !ok.error && !(await todo(t2id)), ok);
    });
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  server.close();
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`record-permissions-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
