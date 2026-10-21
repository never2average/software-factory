#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW ON ITS SURFACES, AGAINST A REAL POSTGRES (docs/WORKFLOW_ENGINE.md phase 7 "Surfaces"), for the
 * definitions of THIS checkout's profile (scripts/test-record-workflow-surfaces-db.mjs runs it in a copy under the
 * maker-checker fixture with step actions and due dates). The real ops routes (app/api/ops/record-workflow/**, the
 * deployments, todos and cycles routes), the agent's tools, as the restricted app_rw role under the fail-closed
 * policies, two workspaces:
 *
 *   read      who holds the next step and when it is due, every step, the timeline: names on the roster for a member
 *             (no email anywhere in the answer), emails for an admin; the cards' line for a page of records;
 *   holder    only a supervisor (an owner or an admin) changes who holds a step; the holder named is kept; someone not in
 *             the workspace is refused; the timeline says so;
 *   due       the one-time extension: forward, within its cap, once; a second is refused; an admin corrects freely
 *             (never spending it); a step whose date is the workflow's own is refused for a member;
 *   tools     get_record_workflow, reassign_step, extend_step as the person in the chat; upsert_deployment, upsert_todo
 *             and upsert_cycle take `evidence` (and the move's `reason`), so a step that demands it is completed through
 *             them, and the step actions a tool's move fires are delivered once;
 *   system    a record moved outside the doors (an import, a bulk write) is re-synced on its next read and saved, and its
 *             next move is never falsely refused; a period's rollover keeps its instance in step in the same transaction,
 *             taking the period's lock before its row (no deadlock with a door); a record never attached is attached on
 *             its first read, once; a read that settles a stale reservation delivers the actions it fired; the cards
 *             take no lock; an implementation named by its account only when the account has exactly one;
 *   every     workspace B reads and changes none of A's.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw).
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
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
  console.log("record-workflow-surfaces-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "record-workflow-surfaces-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
process.env.RECORD_WORKFLOW_SERVICE_TIMEOUT_MS = "1500";

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const holder = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 1500)}`}`);
  }
};

const TAG = `${process.pid}`;
const A = `org-wfs-a-${TAG}`;
const B = `org-wfs-b-${TAG}`;
const at = (name, org = "a") => `${name}-${TAG}@wfs-${org}.test`;
const OWNER = at("a-owner");
const MAKER = at("b-maker");
const CHECKER = at("c-checker");
const ADMIN = at("d-admin");
const LEAD = at("e-lead");
const OTHER = at("f-other");
const BEN = at("ben", "b");
const BEA = at("bea", "b");
const CO = `acct-${TAG}`;
const DUTY = { [MAKER]: "maker", [CHECKER]: "checker", [ADMIN]: "checker" };

async function cleanup() {
  for (const org of [A, B]) {
    await admin`DELETE FROM record_workflow_events WHERE org_id = ${org}`.catch(() => undefined);
    await admin`DELETE FROM record_workflow_instances WHERE org_id = ${org}`.catch(() => undefined);
  }
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "cycles", "deployments", "implementation", "customers", "people_roster", "org_members", "push_subscriptions"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

// The task-workflow service, in process (its own engine, as the runtime probe runs it): every request it is sent.
const engine = await import(pathToFileURL(`${SERVICE}/lib/engine.ts`).href);
const { withOrgTransaction } = await import(pathToFileURL(`${SERVICE}/lib/db.ts`).href);
const { taskCreateSchema, taskPatchSchema } = await import(pathToFileURL(`${SERVICE}/lib/types.ts`).href);
const { errorResponse, issueMessage } = await import(pathToFileURL(`${SERVICE}/lib/http.ts`).href);
const { parseTaskStates } = await import(pathToFileURL(`${SERVICE}/lib/stages.ts`).href);
const received = [];
// What the stand-in does with the next task creates, in order: { fail } answers 500 without writing; { lateAfterWrite }
// writes, then answers 500 (the write landed, the answer did not).
const createHooks = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received.push({ method: req.method, path: req.url, org: req.headers["x-org-id"], actor: req.headers["x-actor-email"], text });
  const taskStates = parseTaskStates(req.headers["x-task-states"] ?? null);
  const ctx = { orgId: req.headers["x-org-id"], actor: String(req.headers["x-actor-email"] ?? "").toLowerCase(), role: req.headers["x-actor-role"] ?? "member", ...(taskStates ? { taskStates } : {}) };
  const send = async (response) => {
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  };
  try {
    const one = /^\/api\/v1\/tasks\/([^/]+)$/.exec(req.url);
    if (req.url === "/api/v1/tasks" && req.method === "POST") {
      const parsed = taskCreateSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return send(Response.json({ error: issueMessage(parsed.error) }, { status: 400 }));
      const hook = createHooks.shift() ?? {};
      if (hook.fail) return send(Response.json({ error: "the service is down" }, { status: 500 }));
      const r = await withOrgTransaction(ctx.orgId, (sql) => engine.createTask(sql, ctx, parsed.data));
      if (hook.lateAfterWrite) return send(Response.json({ error: "timed out" }, { status: 500 }));
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

const closers = [() => new Promise((ok) => server.close(() => ok()))];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Surfaces A', 'active'), (${B}, 'Surfaces B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES
    (${A}, ${OWNER}, 'owner'), (${A}, ${MAKER}, 'member'), (${A}, ${CHECKER}, 'member'), (${A}, ${ADMIN}, 'admin'),
    (${A}, ${LEAD}, 'member'), (${A}, ${OTHER}, 'member'), (${B}, ${BEN}, 'admin'), (${B}, ${BEA}, 'member')`;
  for (const email of [MAKER, CHECKER, ADMIN, LEAD, OTHER]) {
    await admin`INSERT INTO people_roster (email, org_id, name, manager_email, attributes) VALUES (${email}, ${A}, ${email.split("-")[1]}, ${email === CHECKER ? LEAD : null}, ${admin.json(DUTY[email] ? { duty: DUTY[email] } : {})})`;
  }
  await admin`INSERT INTO people_roster (email, org_id, name, attributes) VALUES (${BEN}, ${B}, 'ben', ${admin.json({ duty: "maker" })}), (${BEA}, ${B}, 'bea', ${admin.json({ duty: "checker" })})`;
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Acme (A)'), (${CO}, ${B}, 'Acme (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const actions = await import(root("lib/record-workflow-actions.ts"));
  const { withOrgRls } = await import(root("lib/ops-db.ts"));
  const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
  const people = [OWNER, MAKER, CHECKER, ADMIN, LEAD, OTHER, BEN, BEA];
  const bearers = Object.fromEntries(await Promise.all(people.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = Object.fromEntries(people.map((p) => [p, p === BEN || p === BEA ? B : A]));
  const notified = [];
  actions.setStepActionDeps((runIn) => ({ ...actions.productionStepActionDeps(runIn), notify: async (orgId, emails, notice) => { notified.push({ orgId, emails: [...emails].sort(), on: notice(true) }); return { people: emails.length, devices: emails.length }; } }));
  const settle = () => actions.settleStepActionDeliveries();

  const H = "http://workflow-surfaces.test";
  const route = async (path, who, method, { body, id, query } = {}) => {
    const handlers = await import(root(path));
    const url = `${H}/${path.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace("[id]", encodeURIComponent(id ?? ""))}${query ? `?${query}` : ""}`;
    const request = new NextRequest(url, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json, text: out };
  };
  const call = (who, method, { body, id } = {}) => route(id ? "app/api/ops/deployments/[id]/route.ts" : "app/api/ops/deployments/route.ts", who, method, { body, id });
  const BASE = { customerId: CO, environment: "prod", region: "eu-west-1", deployedVersion: "1.0.0" };
  const create = (who, id) => call(who, "POST", { body: { ...BASE, deploymentId: id } });
  const move = (who, id, state, extra = {}) => call(who, "PATCH", { id, body: { customerId: CO, custom: { review_state: state }, ...extra } });
  const read = (who, id, area = "deployments", customerId = CO) => route("app/api/ops/record-workflow/route.ts", who, "GET", { query: `area=${area}&id=${encodeURIComponent(id)}${customerId ? `&customerId=${encodeURIComponent(customerId)}` : ""}` });
  const cards = (who, refs, area = "deployments") => route("app/api/ops/record-workflow/route.ts", who, "GET", { query: `area=${area}&refs=${encodeURIComponent(JSON.stringify(refs))}` });
  const holder = (who, id, step, holders, area = "deployments") => route("app/api/ops/record-workflow/holder/route.ts", who, "POST", { body: { area, id, customerId: CO, step, holders } });
  const due = (who, id, step, due_on, area = "deployments") => route("app/api/ops/record-workflow/due/route.ts", who, "POST", { body: { area, id, customerId: CO, step, due_on } });
  const depKey = (id) => `${encodeURIComponent(CO)}/${encodeURIComponent(id)}`;
  const instanceOf = async (id, org = A) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${org} AND entity_type = 'deployments' AND entity_id = ${depKey(id)}`)[0];
  const eventsOf = async (inst) => (inst ? await admin`SELECT * FROM record_workflow_events WHERE instance_id = ${inst.id} ORDER BY id` : []);
  const stepOf = (inst, sid) => inst?.steps?.find((s) => s.id === sid);
  const SUBMIT = { reason: "prepared and checked", evidence: "doc://evidence/1" };
  const days = (n, from = Date.now()) => new Date(from + n * 86_400_000).toISOString();
  const emailIn = (text) => /[a-z0-9.-]+@wfs-[ab]\.test/i.test(text);

  // SURFACES_PROBE_PART=individual-cycle (the test runs it in a second copy whose periods are each person's own,
  // work_periods mode "individual"): only that mode's upsert_cycle, which writes a declared period beside a person's goal.
  main: {
    if (process.env.SURFACES_PROBE_PART === "individual-cycle") {
      const { WORK_PERIODS } = await import(root("agent/lib/work-periods.ts"));
      const todoTools = await import(root("agent/lib/todo-tools.ts"));
      const ctxOf = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
      check("individual mode: upsert_cycle takes `evidence` where the period's lifecycle runs a workflow", WORK_PERIODS.individual === true && Boolean(todoTools.upsertCycleTool.inputSchema?.shape?.evidence));
      const made = await route("app/api/ops/cycles/route.ts", MAKER, "POST", { body: { name: "Week one" } });
      const id = made.body?.item?.id;
      const ev = await Promise.resolve().then(() => todoTools.upsertCycleTool.execute({ id, state: "review", ...SUBMIT }, ctxOf(MAKER))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const inst = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'periods' AND entity_id = ${id}`)[0];
      check("individual mode: upsert_cycle with `evidence` completes the period's preparation with it (the evidence reaches the move)", made.status === 201 && !ev.error && stepOf(inst, "prepare")?.state === "completed" && stepOf(inst, "prepare")?.evidence?.[0]?.ref === SUBMIT.evidence, { made: made.status, ev, steps: inst?.steps });
      break main;
    }

  // ── read: who holds the next step, its due date, the timeline ───────────────────────────────────────────────────
  await create(MAKER, "D-1");
  const r1 = await read(MAKER, "D-1");
  const w1 = r1.body?.workflow;
  check("a member reads the record's workflow: the next step is the preparation, held by the maker by name, due in three days", r1.status === 200 && w1?.next?.title === "Prepare" && JSON.stringify(w1.next.holders) === JSON.stringify([{ name: "maker" }]) && Math.abs(Date.parse(w1.next.due_on) - (Date.now() + 3 * 86_400_000)) < 120_000 && w1.next.overdue === false, r1);
  check("…every step with its holders and state, and the timeline (the workflow started); no email anywhere in a member's answer", w1?.steps?.map((s) => `${s.id}:${s.active}`).join() === "prepare:true,review:false" && w1.timeline.some((t) => t.what === "The workflow started") && !emailIn(r1.text), w1);
  check("…a member is offered no holder change, and the steps whose date extends (the review)", !r1.body?.options?.holders && JSON.stringify(r1.body?.options?.extends) === JSON.stringify(["review"]), r1.body?.options);
  const r1a = await read(ADMIN, "D-1");
  check("an admin reads emails, and is offered who may hold each step (the review: the two with the checker duty)", r1a.status === 200 && r1a.body.workflow.next.holders[0].id === MAKER && JSON.stringify(r1a.body.options.holders.review.map((p) => p.id).sort()) === JSON.stringify([CHECKER, ADMIN].sort()), r1a.body);

  await move(MAKER, "D-1", "in_review", SUBMIT);
  await settle();
  const r2 = await read(MAKER, "D-1");
  const w2 = r2.body?.workflow;
  check("after the submit: the next step is the review, held by the checkers by name, due five days after the start", w2?.next?.title === "Review" && JSON.stringify(w2.next.holders.map((h) => h.name).sort()) === JSON.stringify(["admin", "checker"]) && Math.abs(Date.parse(w2.next.due_on) - (Date.now() + 5 * 86_400_000)) < 120_000, w2?.next);
  const whats = w2?.timeline?.map((t) => `${t.who}|${t.what}`) ?? [];
  check("…the timeline: the maker's comment, evidence and decision, the workflow opening the review, the notification and the task it made", whats.includes("maker|Comment on Prepare: prepared and checked") && whats.includes("maker|Evidence on Prepare: doc://evidence/1") && whats.includes("maker|Prepare completed") && whats.includes("the workflow|Review opened") && whats.some((w) => /^the workflow\|Notified 3 people about Prepare$/.test(w)) && whats.includes("the workflow|Made a task for the assistant: Summarise the material") && !emailIn(r2.text), whats);

  await create(MAKER, "D-2");
  const c1 = await cards(MAKER, [{ id: "D-1", customerId: CO }, { id: "D-2", customerId: CO }, { id: "NOPE", customerId: CO }]);
  const lines = c1.body?.items ?? [];
  check("the cards' line, for a page at once: each record's next step, who holds it (names) and its due date; nothing for a record not found", c1.status === 200 && lines.length === 3 && lines[0].next.step === "Review" && JSON.stringify(lines[0].next.holders.sort()) === JSON.stringify(["admin", "checker"]) && lines[0].next.due_on && lines[1].next.step === "Prepare" && lines[2].next === null && !emailIn(c1.text), lines);

  // ── who holds a step: supervisors only ───────────────────────────────────────────────────────────────────────────
  const byMaker = await holder(MAKER, "D-1", "review", [CHECKER]);
  const byLead = await holder(LEAD, "D-1", "review", [CHECKER]);
  check("a member (a holder, or the holder's supervisor on the roster) may not change who holds a step: 403 with the rule's sentence", byMaker.status === 403 && byMaker.body?.code === "REASSIGN_NEEDS_SUPERVISOR" && /Ask someone who supervises this work, or an administrator/.test(byMaker.body?.error ?? "") && byLead.status === 403, { byMaker, byLead });
  const before = await instanceOf("D-1");
  const outsider = await holder(ADMIN, "D-1", "review", ["nobody@elsewhere.test"]);
  check("someone not in the workspace cannot be put on a step (422), and nothing is written", outsider.status === 422 && (await instanceOf("D-1")).revision === before.revision, outsider);
  const byAdmin = await holder(ADMIN, "D-1", "review", [CHECKER]);
  const i3 = await instanceOf("D-1");
  check("an admin hands the review to the checker alone: saved, the holder pinned, the history says who changed it", byAdmin.status === 200 && JSON.stringify(stepOf(i3, "review").assignee) === JSON.stringify([CHECKER]) && stepOf(i3, "review").assignee_pinned === true && i3.revision === before.revision + 1 && (await eventsOf(i3)).some((e) => e.type === "step_patched" && e.actor === ADMIN && JSON.stringify(e.data?.assignee?.after) === JSON.stringify([CHECKER])), { byAdmin: byAdmin.body, steps: i3.steps });
  check("…the answer's timeline says it, by name for a member reading it", (await read(MAKER, "D-1")).body.workflow.timeline.some((t) => t.what === "Review now held by checker" && t.who === "admin"));

  // ── a step's due date: the one-time extension ───────────────────────────────────────────────────────────────────
  const reviewDue = stepOf(i3, "review").due_on;
  const ownDate = await due(MAKER, "D-1", "prepare", days(10));
  check("a step whose date is the workflow's own: a member's change is refused (422), naming who may change it", ownDate.status === 422 && /the workflow's own; ask an administrator/.test(ownDate.body?.error ?? ""), ownDate);
  const outsiderDue = await due(OTHER, "D-1", "review", days(2, Date.parse(reviewDue)));
  check("someone who holds no step of it may not change a due date (403)", outsiderDue.status === 403, outsiderDue);
  const back = await due(CHECKER, "D-1", "review", days(-1, Date.parse(reviewDue)));
  const overCap = await due(CHECKER, "D-1", "review", days(8, Date.parse(reviewDue)));
  check("an extension only moves later, and by at most the step's cap (seven days): both refused (422) with the rule's sentence", back.status === 422 && back.body?.code === "DUE_ON_BACKDATE" && overCap.status === 422 && overCap.body?.code === "DUE_ON_OVER_CAP" && /at most 7 day/.test(overCap.body?.error ?? ""), { back, overCap });
  const extended = await due(CHECKER, "D-1", "review", days(3, Date.parse(reviewDue)));
  const i4 = await instanceOf("D-1");
  check("the holder extends the review by three days: saved, with its one-extension row", extended.status === 200 && Date.parse(stepOf(i4, "review").due_on) === Date.parse(days(3, Date.parse(reviewDue))) && (await eventsOf(i4)).some((e) => e.type === "due_date_extended" && e.actor === CHECKER), { extended: extended.body?.workflow?.next, due: stepOf(i4, "review").due_on });
  const twice = await due(CHECKER, "D-1", "review", days(5, Date.parse(reviewDue)));
  check("…a second extension is refused (422, already extended once), and nothing is written", twice.status === 422 && twice.body?.code === "DUE_ON_ALREADY_EXTENDED" && (await instanceOf("D-1")).revision === i4.revision, twice);
  const corrected = await due(ADMIN, "D-1", "review", days(20));
  const i5 = await instanceOf("D-1");
  check("an admin corrects the date freely, and that never counts as the holder's extension", corrected.status === 200 && Math.abs(Date.parse(stepOf(i5, "review").due_on) - (Date.now() + 20 * 86_400_000)) < 120_000 && (await eventsOf(i5)).filter((e) => e.type === "due_date_extended").length === 1, { corrected: corrected.status, due: stepOf(i5, "review").due_on });
  check("…the timeline shows the extension and the dates", (await read(MAKER, "D-1")).body.workflow.timeline.some((t) => t.kind === "due" && /^Review due \d{4}-\d{2}-\d{2} \(was \d{4}-\d{2}-\d{2}\)$/.test(t.what)));

  // ── the agent's tools ───────────────────────────────────────────────────────────────────────────────────────────
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const wfTools = await import(root("agent/lib/record-workflow-tools.ts"));
  const runTool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const noun = (a) => (RECORD_AREAS[a].label?.plural ?? a).replace(/^./, (c) => c.toLowerCase());
  const got = await runTool(wfTools.getRecordWorkflowTool, { area: noun("deployments"), id: "D-1", customerId: CO }, MAKER);
  check("get_record_workflow, for a member: the next step and its holder by name, the timeline; no email", got?.workflow?.next?.title === "Review" && JSON.stringify(got.workflow.next.holders) === JSON.stringify([{ name: "checker" }]) && got.workflow.timeline.length > 5 && !emailIn(JSON.stringify(got)), got);
  const reTool = await runTool(wfTools.reassignStepTool, { area: noun("deployments"), id: "D-1", customerId: CO, step: "review", holders: [ADMIN] }, MAKER);
  check("reassign_step for a member: the rule's sentence, nothing written", /Ask someone who supervises this work, or an administrator/.test(reTool.error ?? "") && JSON.stringify(stepOf(await instanceOf("D-1"), "review").assignee) === JSON.stringify([CHECKER]), reTool);
  const reAdmin = await runTool(wfTools.reassignStepTool, { area: noun("deployments"), id: "D-1", customerId: CO, step: "review", holders: [CHECKER, ADMIN] }, ADMIN);
  check("reassign_step for an admin: the review held by both again", reAdmin?.changed === true && JSON.stringify(stepOf(await instanceOf("D-1"), "review").assignee) === JSON.stringify([CHECKER, ADMIN]), reAdmin);
  await create(MAKER, "D-3");
  await move(MAKER, "D-3", "in_review", SUBMIT);
  const d3due = stepOf(await instanceOf("D-3"), "review").due_on;
  const ext = await runTool(wfTools.extendStepTool, { area: noun("deployments"), id: "D-3", customerId: CO, step: "review", due_on: days(2, Date.parse(d3due)).slice(0, 10) }, CHECKER);
  const ext2 = await runTool(wfTools.extendStepTool, { area: noun("deployments"), id: "D-3", customerId: CO, step: "review", due_on: days(4, Date.parse(d3due)).slice(0, 10) }, CHECKER);
  check("extend_step: the holder's one extension, then the second refused with its sentence", ext?.changed === true && /already been extended once/.test(ext2.error ?? ""), { ext, ext2 });

  // `evidence` through the record tools: a step that demands it is completed by the agent.
  const tools = await import(root("agent/lib/record-area-tools.ts"));
  const upsertTool = tools.upsertAreaTool("deployments");
  check("upsert_deployment takes `reason` and `evidence` where the lifecycle runs a workflow", Boolean(upsertTool.inputSchema?.shape?.evidence) && Boolean(upsertTool.inputSchema?.shape?.reason));
  await create(MAKER, "D-4");
  await settle(); // the deliveries earlier moves started (D-3's submit) land before the counts are taken
  const n0 = notified.length;
  const t0 = Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom ? 'workflow_action'`)[0].n);
  const noEv = await runTool(upsertTool, { customerId: CO, deploymentId: "D-4", values: { custom: { review_state: "in_review" } }, reason: "done" }, MAKER);
  check("upsert_deployment without the evidence the step demands: refused with the step's sentence", /needs evidence/.test(noEv.error ?? "") && stepOf(await instanceOf("D-4"), "prepare").state === "open", noEv);
  const withEv = await runTool(upsertTool, { customerId: CO, deploymentId: "D-4", values: { custom: { review_state: "in_review" } }, ...SUBMIT }, MAKER);
  await settle();
  const i6 = await instanceOf("D-4");
  check("upsert_deployment with `reason` and `evidence`: the step completes, its comment and evidence recorded", !withEv.error && stepOf(i6, "prepare").state === "completed" && stepOf(i6, "prepare").evidence?.[0]?.ref === SUBMIT.evidence && stepOf(i6, "prepare").comments?.[0]?.text === SUBMIT.reason, { withEv, prep: stepOf(i6, "prepare") });
  check("…and the step actions the tool's move fired are delivered once: one notification, one task for the assistant", notified.length === n0 + 1 && Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom ? 'workflow_action'`)[0].n) === t0 + 1 && (i6.engine_state?.outbox ?? []).length === 0, { n: notified.length - n0, tasks: Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom ? 'workflow_action'`)[0].n) - t0, outbox: (i6.engine_state?.outbox ?? []).map((a) => [a.key, a.delivery?.status, a.delivery?.error ?? a.delivery?.last_error ?? null]) });
  const viaToolApprove = await runTool(upsertTool, { customerId: CO, deploymentId: "D-4", values: { custom: { review_state: "approved" } }, reason: "complete" }, CHECKER);
  check("…and the reviewer approves through the tool with the comment the step demands", !viaToolApprove.error && (await instanceOf("D-4")).terminal === true, viaToolApprove);

  const todoTools = await import(root("agent/lib/todo-tools.ts"));
  check("upsert_todo and upsert_cycle take `evidence` where their lifecycle runs a workflow", Boolean(todoTools.upsertTodoTool.inputSchema?.shape?.evidence) && Boolean(todoTools.upsertCycleTool.inputSchema?.shape?.evidence));
  const toolTask = async (input, who) => Promise.resolve().then(() => todoTools.upsertTodoTool.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const madeTask = await route("app/api/ops/todos/route.ts", MAKER, "POST", { body: { title: "Prepare the pack" } });
  const tid = madeTask.body?.item?.id;
  const taskEv = await toolTask({ id: tid, custom: { state: "in_review" }, ...SUBMIT }, MAKER);
  await settle();
  const ti = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'tasks' AND entity_id = ${tid}`)[0];
  check("upsert_todo with `evidence`: the task's preparation completes with it", !taskEv.error && stepOf(ti, "prepare")?.state === "completed" && stepOf(ti, "prepare")?.evidence?.[0]?.ref === SUBMIT.evidence, { taskEv, steps: ti?.steps });
  const rt = await read(MAKER, tid, "tasks", null);
  check("…and the task's workflow reads through the same door (area tasks, by its id)", rt.status === 200 && rt.body.workflow.next?.title === "Review", rt);
  const cycle = (who, method, opts) => route(opts?.id ? "app/api/ops/cycles/[id]/route.ts" : "app/api/ops/cycles/route.ts", who, method, opts);
  const madeP = await cycle(MAKER, "POST", { body: { name: "Batch one" } });
  const pid = madeP.body?.item?.id;
  const cycleEv = await Promise.resolve().then(() => todoTools.upsertCycleTool.execute({ id: pid, state: "review", ...SUBMIT }, ctxFor(MAKER))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const pi = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'periods' AND entity_id = ${pid}`)[0];
  check("upsert_cycle with `evidence`: the period's preparation completes with it", !cycleEv.error && stepOf(pi, "prepare")?.state === "completed" && stepOf(pi, "prepare")?.evidence?.[0]?.ref === SUBMIT.evidence, { cycleEv, steps: pi?.steps });

  // ── system moves ────────────────────────────────────────────────────────────────────────────────────────────────
  // A record moved outside the doors (an import or a bulk write straight to the table): its next read re-syncs it.
  await create(MAKER, "D-5");
  const i7 = await instanceOf("D-5");
  await admin`UPDATE deployments SET custom = jsonb_set(custom, '{review_state}', '"in_review"') WHERE org_id = ${A} AND deployment_id = 'D-5'`;
  const cardStale = await cards(MAKER, [{ id: "D-5", customerId: CO }]);
  check("moved outside the doors: the cards already show where it stands (the review), without writing", cardStale.body?.items?.[0]?.next?.step === "Review" && (await instanceOf("D-5")).revision === i7.revision, cardStale.body);
  const r7 = await read(MAKER, "D-5");
  const i7b = await instanceOf("D-5");
  check("…its next read re-syncs the instance and saves it, as provisioning rows (never a decision)", r7.body?.workflow?.next?.title === "Review" && i7b.revision === i7.revision + 1 && i7b.engine_state?.record_state === "in_review" && (await eventsOf(i7b)).some((e) => e.source === "provisioning" && /re-synced/.test(e.detail ?? "")) && !(await eventsOf(i7b)).some((e) => e.type === "state_changed"), { r7: r7.body?.workflow?.next, events: (await eventsOf(i7b)).map((e) => [e.type, e.source]) });
  const approveImported = await move(CHECKER, "D-5", "approved", { reason: "complete" });
  check("…and its next move is checked where it stands: no false refusal (the review is open, held by the checker)", approveImported.status === 200 && (await instanceOf("D-5")).terminal === true, approveImported);
  // A period's rollover: the instance is brought in line in the rollover's own transaction.
  const { rollOverEnded } = await import(root("agent/lib/work-period-store.ts"));
  const { WORK_PERIODS } = await import(root("agent/lib/work-periods.ts"));
  const madeQ = await cycle(MAKER, "POST", { body: { name: "Batch two", startsAt: days(-20), endsAt: days(-6) } });
  const qid = madeQ.body?.item?.id;
  const qSubmit = await cycle(MAKER, "PATCH", { id: qid, body: { state: "review", ...SUBMIT } });
  await settle(); // the submit's step actions are delivered first (their claim and finish move the revision on)
  const q0 = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'periods' AND entity_id = ${qid}`)[0];
  const wp = { ...WORK_PERIODS, mode: "team", enabled: true, team: true, individual: false, autoRollover: true, lengthDays: 14 };
  const rolled = await withOrgRls(A, (tx) => rollOverEnded(tx, A, wp, Date.now(), RECORD_AREAS));
  const qState = (await admin`SELECT state FROM cycles WHERE org_id = ${A} AND id = ${qid}`)[0]?.state;
  const q1 = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'periods' AND entity_id = ${qid}`)[0];
  check("a period's rollover closes the ended period and, in the same transaction, brings its workflow in step (no read needed)", qSubmit.status === 200 && rolled.some((r) => r.from.id === qid) && qState === "closed" && q1.revision === q0.revision + 1 && q1.engine_state?.record_state === "closed" && stepOf(q1, "review")?.state === "completed" && q1.terminal === true, { qSubmit: qSubmit.status, rolled: rolled.map((r) => r.from.id), qState, rev: [q0?.revision, q1?.revision], steps: q1?.steps });
  check("…as provisioning rows by the system, never a decision", (await eventsOf(q1)).some((e) => e.source === "provisioning" && e.actor === "system" && /re-synced/.test(e.detail ?? "")) && !(await eventsOf(q1)).some((e) => e.type === "state_changed" && e.actor === "system"));

  // A rollover takes a period's workflow lock BEFORE it writes the period's row, as every door does (the lock, then the
  // row): a door holding the lock and writing the row while a rollover runs never deadlocks with it.
  const { sql: dsql } = await import("drizzle-orm");
  const moves = await import(root("lib/record-workflow-moves.ts"));
  const madeR = await cycle(MAKER, "POST", { body: { name: "Batch four", startsAt: days(-20), endsAt: days(-6) } });
  const rid = madeR.body?.item?.id;
  const advisoryWaiters = async () => (await admin`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n;
  let doorHolds = false;
  const door = withOrgRls(A, async (tx) => {
    await moves.lockRecordWorkflow(tx, A, "periods", rid);
    doorHolds = true;
    for (let i = 0; i < 100 && (await advisoryWaiters()) === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
    await tx.execute(dsql`UPDATE cycles SET name = 'Batch four (renamed)', updated_at = now() WHERE org_id = ${A} AND id = ${rid}`);
  });
  for (let i = 0; i < 100 && !doorHolds; i++) await new Promise((ok) => setTimeout(ok, 20));
  const rollover = withOrgRls(A, (tx) => rollOverEnded(tx, A, wp, Date.now(), RECORD_AREAS));
  const [doorDone, rolloverDone] = await Promise.allSettled([door, rollover]);
  const rRow = (await admin`SELECT name, state FROM cycles WHERE org_id = ${A} AND id = ${rid}`)[0];
  check("a rollover and a door writing the same period at once: both finish, no deadlock (the rollover waits on the period's lock before its row)", madeR.status === 201 && doorDone.status === "fulfilled" && rolloverDone.status === "fulfilled" && rRow?.name === "Batch four (renamed)" && rRow?.state === "closed", { made: madeR.status, door: doorDone.reason?.message, rollover: rolloverDone.reason?.message, rRow });

  // A record never attached (written straight to its table): its first read attaches it where it stands, once; every
  // later read shows that same instance (its due dates do not move on with each read).
  await admin`INSERT INTO deployments SELECT (jsonb_populate_record(NULL::deployments, to_jsonb(d) || jsonb_build_object('deployment_id', 'D-7', 'custom', d.custom || '{"review_state":"drafting"}'::jsonb))).* FROM deployments d WHERE d.org_id = ${A} AND d.customer_id = ${CO} AND d.deployment_id = 'D-1'`;
  const never7 = await instanceOf("D-7");
  const r8 = await read(MAKER, "D-7");
  const i8 = await instanceOf("D-7");
  await new Promise((ok) => setTimeout(ok, 1100));
  const r8b = await read(MAKER, "D-7");
  const i8b = await instanceOf("D-7");
  check("a record never attached: its first read attaches its workflow where it stands, and a later read shows the same steps and due dates (not seeded again)", !never7 && r8.status === 200 && Boolean(i8) && i8b?.id === i8?.id && i8b?.revision === i8?.revision && r8b.status === 200 && r8.body?.workflow?.next?.title === "Prepare" && r8b.body?.workflow?.next?.due_on === r8.body?.workflow?.next?.due_on, { never7: Boolean(never7), r8: r8.status, i8: i8 && [i8.id, i8.revision], i8b: i8b && [i8b.id, i8b.revision], due: [r8.body?.workflow?.next?.due_on, r8b.body?.workflow?.next?.due_on] });
  const firstMove = await move(MAKER, "D-7", "in_review", SUBMIT);
  check("…and its first move after that runs on the attached instance", firstMove.status === 200 && stepOf(await instanceOf("D-7"), "prepare")?.state === "completed", firstMove);

  // A stale reservation settled by a read fires the step's actions: the read delivers them after its commit.
  await create(MAKER, "D-8");
  await settle(); // the deliveries earlier moves started (D-7's submit) land before the counts are taken
  const notifiedBefore = notified.length;
  const tasksBefore = Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom ? 'workflow_action'`)[0].n);
  const staleMove = { id: `m-stale-${TAG}`, from: "drafting", to: "in_review", step: { id: "prepare", state: "completed" }, actor: MAKER, comment: SUBMIT.reason, evidence: SUBMIT.evidence, administrative: null, at: new Date(Date.now() - 600_000).toISOString() };
  await admin`UPDATE deployments SET custom = jsonb_set(custom, '{review_state}', '"in_review"') WHERE org_id = ${A} AND customer_id = ${CO} AND deployment_id = 'D-8'`;
  await admin`UPDATE record_workflow_instances SET engine_state = jsonb_set(engine_state, '{record_move}', ${admin.json(staleMove)}) WHERE org_id = ${A} AND entity_type = 'deployments' AND entity_id = ${depKey("D-8")}`;
  const r9 = await read(MAKER, "D-8");
  await settle();
  const i9 = await instanceOf("D-8");
  const outbox9 = (i9?.engine_state?.outbox ?? []).filter((a) => typeof a.key === "string");
  check("a read that settles a stale reservation saves the step change and delivers the actions it fired after its commit (none left pending)", r9.status === 200 && stepOf(i9, "prepare")?.state === "completed" && outbox9.every((a) => a.delivery?.status !== "pending") && notified.length === notifiedBefore + 1 && Number((await admin`SELECT count(*)::int AS n FROM todos WHERE org_id = ${A} AND custom ? 'workflow_action'`)[0].n) === tasksBefore + 1, { r9: r9.status, prep: stepOf(i9, "prepare")?.state, outbox: outbox9.map((a) => [a.key, a.delivery?.status]), notified: notified.length - notifiedBefore });

  // The cards' lines are read only: no record's workflow lock is taken, however many records the page shows.
  const { nextStepsDoor } = await import(root("lib/record-workflow-doors.ts"));
  const cardLocks = await withOrgRls(A, async (tx) => {
    const items = await nextStepsDoor(tx, A, "deployments", ["D-1", "D-5", "D-7", "D-8"].map((id) => ({ id, customerId: CO })), { email: MAKER, role: "member" });
    const rows = await tx.execute(dsql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
    return { items, n: (Array.isArray(rows) ? rows : rows.rows)[0].n };
  });
  check("the cards' lines for a page of records take no advisory lock (and still answer each record)", cardLocks.n === 0 && cardLocks.items.map((x) => x.id).join() === "D-1,D-5,D-7,D-8" && cardLocks.items.find((x) => x.id === "D-7")?.next?.step === "Review" && cardLocks.items.find((x) => x.id === "D-8")?.next?.step === "Review", { locks: cardLocks.n, items: cardLocks.items.map((x) => [x.id, x.next?.step ?? null]) });

  // An implementation named by its account (no implementation id): the account's one implementation, never a guess
  // among several.
  const IMP = (id) => admin`INSERT INTO implementation (org_id, customer_id, implementation_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, custom) VALUES (${A}, ${CO}, ${id}, 'discovery', 0, 'low', '', ${admin.json({ review_state: "drafting" })})`;
  await IMP(`IMP-1-${TAG}`);
  const byAccount1 = await read(MAKER, CO, "implementations", CO);
  await IMP(`IMP-2-${TAG}`);
  const byAccount2 = await read(MAKER, CO, "implementations", CO);
  check("an implementation named by its account: found when the account has exactly one; with two, not found (none is guessed)", byAccount1.status === 200 && byAccount1.body?.key === `IMP-1-${TAG}` && byAccount2.status === 404, { one: [byAccount1.status, byAccount1.body?.key], two: [byAccount2.status, byAccount2.body?.key] });

  // ── workspace B ─────────────────────────────────────────────────────────────────────────────────────────────────
  const revBeforeB = (await instanceOf("D-1")).revision;
  const theirs = await read(BEN, "D-1");
  const theirHolder = await holder(BEN, "D-1", "review", [BEN]);
  const theirDue = await due(BEN, "D-1", "review", days(30));
  const theirCards = await cards(BEN, [{ id: "D-1", customerId: CO }]);
  const iA = await instanceOf("D-1");
  check("workspace B cannot read or change A's record's workflow: 404s, and the cards' line is empty; A's is untouched", theirs.status === 404 && theirHolder.status === 404 && theirDue.status === 404 && theirCards.body?.items?.[0]?.next === null && iA.revision === revBeforeB, { theirs: theirs.status, theirHolder: theirHolder.status, theirDue: theirDue.status, rev: [revBeforeB, iA.revision] });
  const theirTool = await runTool(wfTools.getRecordWorkflowTool, { area: noun("deployments"), id: "D-1", customerId: CO }, BEN);
  check("…nor through the agent's tool", /No such/.test(theirTool.error ?? ""), theirTool);
  } // main
} catch (e) {
  failures++;
  console.log(`  FAIL the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await Promise.all([admin.end({ timeout: 2 }), holder.end({ timeout: 2 }), app.end({ timeout: 2 })]).catch(() => undefined);
}
console.log(`\nrecord-workflow-surfaces-db-probe: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
