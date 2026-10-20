#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW STEP ACTIONS, AGAINST A REAL POSTGRES (lib/record-workflow-actions.ts; docs/WORKFLOW_ENGINE.md
 * phase 6 "Step actions"), for the definitions of THIS checkout's profile (scripts/test-record-workflow-actions-db.mjs
 * runs it in a copy under the neutral maker-checker fixture with two actions added: an email when the preparation is
 * done, and an agent run when it completes). The real deployments routes, the agent's upsert_deployment and the todos
 * routes, as the restricted app_rw role under the fail-closed policies, two workspaces:
 *
 *   fired     the submit fires both actions in its own transaction: saved on the instance with the step, queued in its
 *             history, the fired-once ledger on the instance;
 *   delivered the door delivers them once the write committed: the email as the app's own notification to the
 *             preparation's holder and the people the action names (never an email: the notifier is the only channel,
 *             and nothing else is called), the agent run as a task for the assistant written through the task-workflow
 *             service; both leave the instance, `external_delivered` in its history;
 *   once      a retried move that changes nothing fires nothing; a later step change while the preparation stays done
 *             fires nothing again; a move that rolled back (a stale revision) fired nothing, and its retry fires once;
 *             a send-back and a second submit (a new entry of the step) fires once more; two deliveries at once deliver
 *             once; a delivery that died after making the task, claimed again, finds that task and makes none; a
 *             failed delivery is tried again later, once;
 *   doors     the tasks' door (a write the service makes, settled after) fires and delivers the same way;
 *   beside    a task move checked before a delivery and reserved after it is not refused (a real change still is); a
 *             slow notification never lets a second delivery take the actions after it; a claim taken over while its
 *             task write was in flight leaves one task (the database refuses the second); a notification out of time
 *             is shown to the others only next time; a mover or holder who left neither writes nor holds the task; a
 *             reservation that settles a stale one delivers what that fired; a create holds the record's lock; the
 *             sweep takes only what is due, the longest waiting first;
 *   every     workspace B's actions are its own: its people, its task, never A's; A's delivery and A's sweep reach none
 *             of B's records, under row-level security.
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
  console.log("record-workflow-actions-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "record-workflow-actions-db-"));
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
const A = `org-wfa-a-${TAG}`;
const B = `org-wfa-b-${TAG}`;
const at = (name, org = "a") => `${name}-${TAG}@wfa-${org}.test`;
const OWNER = at("a-owner");
const MAKER = at("b-maker");
const CHECKER = at("c-checker");
const ADMIN = at("d-admin");
const BEN = at("ben", "b");
const BEA = at("bea", "b");
const CO = `acct-${TAG}`;
const DUTY = { [MAKER]: "maker", [CHECKER]: "checker", [ADMIN]: "checker" };

async function cleanup() {
  for (const org of [A, B]) {
    await admin`DELETE FROM record_workflow_events WHERE org_id = ${org}`.catch(() => undefined);
    await admin`DELETE FROM record_workflow_instances WHERE org_id = ${org}`.catch(() => undefined);
  }
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "deployments", "customers", "people_roster", "org_members", "push_subscriptions"]) {
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
// writes, then answers 500 (the write landed, the answer did not); { hold } waits for that promise before it writes
// (`holding` counts the creates waiting).
const createHooks = [];
let holding = 0;
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
      if (hook.hold) {
        holding += 1;
        await hook.hold;
      }
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
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Step actions A', 'active'), (${B}, 'Step actions B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES
    (${A}, ${OWNER}, 'owner'), (${A}, ${MAKER}, 'member'), (${A}, ${CHECKER}, 'member'), (${A}, ${ADMIN}, 'admin'),
    (${B}, ${BEN}, 'admin'), (${B}, ${BEA}, 'member')`;
  for (const email of [MAKER, CHECKER, ADMIN]) {
    await admin`INSERT INTO people_roster (email, org_id, name, attributes) VALUES (${email}, ${A}, ${email.split("-")[1]}, ${admin.json({ duty: DUTY[email] })})`;
  }
  await admin`INSERT INTO people_roster (email, org_id, name, attributes) VALUES (${BEN}, ${B}, 'ben', ${admin.json({ duty: "maker" })}), (${BEA}, ${B}, 'bea', ${admin.json({ duty: "checker" })})`;
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Acme (A)'), (${CO}, ${B}, 'Acme (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const actions = await import(root("lib/record-workflow-actions.ts"));
  // The record's noun is the profile's (in this copy, whatever the deployments area is called there).
  const NOUN = (await import(root("agent/lib/record-areas.ts"))).areaView("deployments").noun;
  const { withOrgRls } = await import(root("lib/ops-db.ts"));
  const people = [OWNER, MAKER, CHECKER, ADMIN, BEN, BEA];
  const bearers = Object.fromEntries(await Promise.all(people.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = Object.fromEntries(people.map((p) => [p, p === BEN || p === BEA ? B : A]));

  // The world the deliveries see: the notifier records every notification (the app's own channel, the ONLY one), the
  // task path is the real one (the task-workflow service, the stand-in above).
  const notified = [];
  let holdNotify = null;
  const fakeNotify = async (orgId, emails, notice) => {
    if (holdNotify) await holdNotify;
    notified.push({ orgId, emails: [...emails].sort(), on: notice(true), off: notice(false) });
    return { people: emails.length, devices: emails.length };
  };
  actions.setStepActionDeps((runIn) => ({ ...actions.productionStepActionDeps(runIn), notify: fakeNotify }));
  const runIn = (org, fn) => withOrgRls(org, fn);
  const depsAt = (now) => ({ ...actions.productionStepActionDeps(runIn), notify: fakeNotify, now: () => now });

  const H = "http://workflow-actions.test";
  const call = async (who, method, { body, id } = {}) => {
    const handlers = await import(root(id ? "app/api/ops/deployments/[id]/route.ts" : "app/api/ops/deployments/route.ts"));
    const path = `/api/ops/deployments${id ? `/${encodeURIComponent(id)}` : ""}`;
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const BASE = { customerId: CO, environment: "prod", region: "eu-west-1", deployedVersion: "1.0.0" };
  const create = (who, id) => call(who, "POST", { body: { ...BASE, deploymentId: id } });
  const move = (who, id, state, extra = {}) => call(who, "PATCH", { id, body: { customerId: CO, custom: { review_state: state }, ...extra } });
  const depKey = (id) => `${encodeURIComponent(CO)}/${encodeURIComponent(id)}`;
  const instanceOf = async (id, org = A) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${org} AND entity_type = 'deployments' AND entity_id = ${depKey(id)}`)[0];
  const eventsOf = async (inst) => (inst ? await admin`SELECT * FROM record_workflow_events WHERE instance_id = ${inst.id} ORDER BY id` : []);
  const queued = async (inst) => (await eventsOf(inst)).filter((e) => e.type === "external_queued").map((e) => `${e.step_id}:${e.detail}`);
  const delivered = async (inst) => (await eventsOf(inst)).filter((e) => e.type === "external_delivered").map((e) => `${e.step_id}:${e.detail}`);
  const outboxOf = (inst) => inst?.engine_state?.outbox ?? [];
  const firedOf = (inst) => inst?.engine_state?.fired_actions ?? [];
  const assistantTasks = async (org = A) => admin`SELECT id, title, notes, assignee, created_by, custom FROM todos WHERE org_id = ${org} AND custom ? 'workflow_action' ORDER BY created_at, id`;
  const settle = () => actions.settleStepActionDeliveries();
  const SUBMIT = { reason: "prepared and checked", evidence: "doc://evidence/1" };
  const notesFor = (n) => notified.slice(n);

  // ── fired with the step change, delivered after it ───────────────────────────────────────────────────────────────
  await create(MAKER, "D-1");
  const n0 = notified.length;
  const submitted = await move(MAKER, "D-1", "in_review", SUBMIT);
  const i1 = await instanceOf("D-1");
  check("the submit fires both actions in its own transaction: queued in the instance's history beside the step change", submitted.status === 200 && JSON.stringify((await queued(i1)).sort()) === JSON.stringify(["prepare:agent:Summarise the material", "prepare:email"]) && i1.steps.find((s) => s.id === "prepare")?.state === "completed", { submitted, q: await queued(i1) });
  check("…the fired-once ledger is on the instance: one key per action, for this entry of the step", firedOf(i1).length === 2 && firedOf(i1).every((k) => /^\d+(\.\d+)?:prepare:\d+:(email|agent:summarise)$/.test(k)), firedOf(i1));
  await settle();
  const i1d = await instanceOf("D-1");
  const notes1 = notesFor(n0);
  check("delivered once the write committed: one notification, to the preparation's holder and the checkers the action names, in workspace A", notes1.length === 1 && notes1[0].orgId === A && JSON.stringify(notes1[0].emails) === JSON.stringify([MAKER, CHECKER, ADMIN].sort()), notes1);
  check("…in the profile's words: the action's own subject and body; with previews off, nothing of the record", notes1[0]?.on.title === "Ready for review" && notes1[0]?.on.body === "The material is in; the review can start." && !notes1[0]?.off.body && !/D-1|Prepare/.test(notes1[0]?.off.title ?? "") && notes1[0]?.on.tag.startsWith("step-action:"), notes1[0]);
  const tasks1 = await assistantTasks();
  check("the agent run is a task for the assistant, through the task path: its name, its instructions, the record by the profile's noun, assigned to the step's holder, authored by the mover", tasks1.length === 1 && tasks1[0].title === "Summarise the material" && tasks1[0].notes.startsWith("For the assistant: Read the material and write a short summary") && tasks1[0].notes.includes(`From the step "Prepare" of the ${NOUN} "D-1".`) && tasks1[0].assignee === MAKER && tasks1[0].created_by === MAKER, tasks1);
  check("…both actions left the instance, each with an external_delivered row", outboxOf(i1d).length === 0 && JSON.stringify((await delivered(i1d)).sort()) === JSON.stringify(["prepare:agent:Summarise the material", "prepare:email"]), { outbox: outboxOf(i1d), d: await delivered(i1d) });
  check("nothing sends an email: the service saw one task create, and no request went anywhere else", received.filter((r) => r.method === "POST" && r.path === "/api/v1/tasks").length === 1, received.map((r) => `${r.method} ${r.path}`));

  // ── exactly once ───────────────────────────────────────────────────────────────────────────────────────────────
  const again = await move(MAKER, "D-1", "in_review", SUBMIT);
  await settle();
  const i1r = await instanceOf("D-1");
  check("a retried move that changes nothing fires nothing (no queued row, the same ledger, no notification, no task)", (await queued(i1r)).length === 2 && firedOf(i1r).length === 2 && notified.length === n0 + 1 && (await assistantTasks()).length === 1, { again, q: await queued(i1r) });
  const approved = await move(CHECKER, "D-1", "approved", { reason: "complete" });
  await settle();
  const i1a = await instanceOf("D-1");
  check("a later step change while the preparation stays done: its email rule matches again and is taken back, not fired twice", approved.status === 200 && i1a.terminal === true && (await queued(i1a)).filter((q) => q === "prepare:email").length === 1 && firedOf(i1a).filter((k) => k.includes(":prepare:")).length === 2, { approved, q: await queued(i1a), fired: firedOf(i1a) });
check("…while the approval's own email fires, once: one more notification, to the review's holders", notified.length === n0 + 2 && notified.at(-1).on.title === "Approved" && JSON.stringify(notified.at(-1).emails) === JSON.stringify([CHECKER, ADMIN].sort()), notified.slice(n0));

  // A move that rolls back (a stale revision under it) fired nothing; its retry fires once.
  await create(MAKER, "D-2");
  const i2 = await instanceOf("D-2");
  const lock = await holder.reserve();
  await lock`BEGIN`;
  await lock`UPDATE record_workflow_instances SET revision = revision + 1 WHERE id = ${i2.id}`;
  const racing = move(MAKER, "D-2", "in_review", SUBMIT);
  let waited = false;
  for (let i = 0; i < 100 && !waited; i++) {
    const [w] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%record_workflow_instances%'`;
    waited = w.n > 0;
    if (!waited) await new Promise((ok) => setTimeout(ok, 50));
  }
  await lock`COMMIT`;
  lock.release();
  const stale = await racing;
  await settle();
  const i2s = await instanceOf("D-2");
  const n2 = notified.length;
  const t2 = (await assistantTasks()).length;
  check("a move that rolled back (stale revision, 409) fired nothing: no action on the instance, no ledger key, nothing delivered", waited && stale.status === 409 && outboxOf(i2s).length === 0 && firedOf(i2s).length === 0 && (await queued(i2s)).length === 0 && t2 === 1, { stale, i2s: i2s?.engine_state });
  const retried = await move(MAKER, "D-2", "in_review", SUBMIT);
  await settle();
  check("…its retry fires once and is delivered once", retried.status === 200 && notified.length === n2 + 1 && (await assistantTasks()).length === t2 + 1 && firedOf(await instanceOf("D-2")).length === 2, { retried, n: notified.length - n2 });

  // A new entry of the step fires again, once.
  const back = await move(CHECKER, "D-2", "sent_back", { reason: "missing a page" });
  const n3 = notified.length;
  const resubmitted = await move(MAKER, "D-2", "in_review", { reason: "added the page", evidence: "doc://evidence/2" });
  await settle();
  const i2b = await instanceOf("D-2");
  check("a send-back and a second submit (a new entry of the preparation) fire both actions once more, and only once", back.status === 200 && resubmitted.status === 200 && notified.length === n3 + 1 && (await assistantTasks()).length === t2 + 2 && firedOf(i2b).length === 4 && (await queued(i2b)).length === 4, { fired: firedOf(i2b), q: await queued(i2b) });

  // Two deliveries at once deliver once. (The door's own delivery is held off: the actions stay pending.)
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify, runIn: async () => [] }));
  await create(MAKER, "D-3");
  await move(MAKER, "D-3", "in_review", SUBMIT);
  await settle();
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify }));
  const i3 = await instanceOf("D-3");
  check("(held off: the actions are pending on the instance)", outboxOf(i3).length === 2 && outboxOf(i3).every((a) => a.delivery.status === "pending"), outboxOf(i3));
  const n4 = notified.length;
  const t4 = (await assistantTasks()).length;
  let release;
  holdNotify = new Promise((ok) => (release = ok));
  const both = Promise.all([actions.deliverStepActions(A, "deployments", depKey("D-3"), depsAt(new Date())), actions.deliverStepActions(A, "deployments", depKey("D-3"), depsAt(new Date()))]);
  await new Promise((ok) => setTimeout(ok, 300));
  release();
  holdNotify = null;
  const [r1, r2] = await both;
  check("two deliveries at once: one claims both actions, the other finds nothing; one notification, one task", r1.length + r2.length === 2 && notified.length === n4 + 1 && (await assistantTasks()).length === t4 + 1 && outboxOf(await instanceOf("D-3")).length === 0, { r1, r2 });

  // A delivery that died after making the task: claimed again once stale, it finds the task and makes none.
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify, runIn: async () => [] }));
  await create(MAKER, "D-4");
  await move(MAKER, "D-4", "in_review", SUBMIT);
  await settle();
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify }));
  const t5 = (await assistantTasks()).length;
  const dying = { ...depsAt(new Date()) };
  let calls = 0;
  const realRunIn = dying.runIn;
  dying.runIn = async (org, fn) => {
    calls += 1;
    if (calls === 5) throw new Error("the function was frozen before it could finish");
    return realRunIn(org, fn);
  };
  // Each action is written back as soon as it is delivered. Order: claim (1), email notify, its finish (2); agent: its
  // claim renewed (3), look for its task (4, none yet), create, its finish (5) dies.
  await actions.deliverStepActions(A, "deployments", depKey("D-4"), dying).catch(() => undefined);
  const i4 = await instanceOf("D-4");
  check("(the delivery died after making the task: the email was written back, the agent action is still claimed on the instance)", (await assistantTasks()).length === t5 + 1 && outboxOf(i4).length === 1 && outboxOf(i4).every((a) => a.kind === "agent" && a.delivery.status === "processing"), outboxOf(i4));
  const soon = await actions.deliverStepActions(A, "deployments", depKey("D-4"), depsAt(new Date()));
  check("…a claim that is not stale yet is left to its deliverer", soon.length === 0);
  const later = await actions.deliverStepActions(A, "deployments", depKey("D-4"), depsAt(new Date(Date.now() + actions.CLAIM_STALE_MS + 1000)));
  const agentOutcome = later.find((o) => o.kind === "agent");
  check("…claimed again once stale: the task it made is found (no second task), and it leaves the instance", agentOutcome?.ok === true && agentOutcome.detail.made === false && (await assistantTasks()).length === t5 + 1 && outboxOf(await instanceOf("D-4")).length === 0, later);

  // A failed delivery is tried again later, once.
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify, runIn: async () => [] }));
  await create(MAKER, "D-5");
  await move(MAKER, "D-5", "in_review", SUBMIT);
  await settle();
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify }));
  const t6 = (await assistantTasks()).length;
  createHooks.push({ fail: true });
  const failed = await actions.deliverStepActions(A, "deployments", depKey("D-5"), depsAt(new Date()));
  const i5 = await instanceOf("D-5");
  const waiting = outboxOf(i5).find((a) => a.kind === "agent");
  check("the task path failing: the agent action is pending again with a later attempt and the reason; the email went", failed.find((o) => o.kind === "agent")?.ok === false && waiting?.delivery.status === "pending" && waiting.delivery.attempts === 1 && Date.parse(waiting.delivery.next_attempt_at) > Date.now() && /500|down/.test(waiting.delivery.last_error ?? "") && outboxOf(i5).length === 1, { failed, waiting });
  const early = await actions.deliverStepActions(A, "deployments", depKey("D-5"), depsAt(new Date()));
  createHooks.push({ lateAfterWrite: true });
  const due = await actions.deliverStepActions(A, "deployments", depKey("D-5"), depsAt(new Date(Date.now() + 60 * 60_000)));
  check("…not before its next attempt; then, a write that landed with a failed answer is found and taken as delivered: one task", early.length === 0 && due.length === 1 && due[0].ok === true && (await assistantTasks()).length === t6 + 1 && outboxOf(await instanceOf("D-5")).length === 0, { early, due });

  // ── the other doors ──────────────────────────────────────────────────────────────────────────────────────────────
  const todo = async (who, method, { body, id } = {}) => {
    const handlers = await import(root(id ? "app/api/ops/todos/[id]/route.ts" : "app/api/ops/todos/route.ts"));
    const path = `/api/ops/todos${id ? `/${id}` : ""}`;
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const madeTask = await todo(MAKER, "POST", { body: { title: "Prepare the pack" } });
  const tid = madeTask.body?.item?.id;
  const n7 = notified.length;
  const t8 = (await assistantTasks()).length;
  const taskSubmit = await todo(MAKER, "PATCH", { id: tid, body: { custom: { state: "in_review" }, ...SUBMIT } });
  await settle();
  const ti = (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'tasks' AND entity_id = ${tid}`)[0];
  check("the tasks' door (the service writes, the move is settled after): the actions fire with the settled step and are delivered once", madeTask.status === 201 && taskSubmit.status === 200 && notified.length === n7 + 1 && (await assistantTasks()).length === t8 + 1 && outboxOf(ti).length === 0 && firedOf(ti).length === 2, { taskSubmit, fired: firedOf(ti), outbox: outboxOf(ti) });

  // ── delivery beside moves, deliveries that overlap, people who left, the sweep ───────────────────────────────────
  const moves = await import(root("lib/record-workflow-moves.ts"));
  const runtime = await import(root("lib/record-workflow-runtime.ts"));
  const { storedTask } = await import(root("agent/lib/record-lifecycle-store.ts"));
  const holdOff = () => actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify, runIn: async () => [] }));
  const deliverNow = () => actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify }));
  const taskInstance = async (id) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'tasks' AND entity_id = ${id}`)[0];
  const moveCheck = (from, to, step) => ({ field: "state", from, to, enforce: "strict", allowed: true, transition: { from: [from], to, label: to, step }, broken: [], allowedMoves: [], stamp: {}, sentence: "" });
  const APPROVE = moveCheck("in_review", "approved", { id: "review", state: "completed" });
  const openTask = (id, actor, extra = {}) => withOrgRls(A, async (tx) => {
    await moves.lockRecordWorkflow(tx, A, "tasks", id);
    return moves.openRecordWorkflow(tx, A, "tasks", { entityId: id, before: await storedTask(tx, A, id), actor, ...extra });
  });
  const reserveTask = (opened, id, check, deliver) => withOrgRls(A, (tx) => moves.reserveRecordMove(tx, opened, { entityId: id, check, readRecord: () => storedTask(tx, A, id), ...(deliver ? { deliver } : {}) }));
  const releaseTask = (id, moveId) => withOrgRls(A, (tx) => moves.settleReservedMove(tx, A, "tasks", { entityId: id, moveId, readRecord: () => storedTask(tx, A, id) }));
  /** A task of workspace A submitted through the tasks' door, its two actions fired and left pending (held off). */
  const submittedTask = async (title) => {
    holdOff();
    const made = await todo(MAKER, "POST", { body: { title } });
    const id = made.body?.item?.id;
    await todo(MAKER, "PATCH", { id, body: { custom: { state: "in_review" }, ...SUBMIT } });
    await settle();
    deliverNow();
    return id;
  };
  const waitFor = async (cond) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 25));
    return cond();
  };

  // A task move is checked in one transaction and reserved in another; a delivery between them saves the instance.
  {
    const tid1 = await submittedTask("Check the pack");
    const pending = outboxOf(await taskInstance(tid1)).length;
    const opened = await openTask(tid1, CHECKER, { comment: "complete" });
    const between = await actions.deliverStepActions(A, "tasks", tid1, depsAt(new Date()));
    const revision = (await taskInstance(tid1)).revision;
    let reserved = null;
    let refused = null;
    try {
      reserved = await reserveTask(opened, tid1, APPROVE);
    } catch (e) {
      refused = e;
    }
    check("a task move checked before a step action's delivery and reserved after it is NOT refused: the delivery moved the revision on, not what the move depends on", pending === 2 && between.length === 2 && between.every((o) => o.ok) && revision > opened.revision && typeof reserved?.id === "string" && !refused, { pending, between, revision, opened: opened?.revision, refused: refused?.message });
    if (reserved?.id) await releaseTask(tid1, reserved.id);
    const again = await openTask(tid1, CHECKER, { comment: "complete" });
    const inst = await taskInstance(tid1);
    await admin`UPDATE record_workflow_instances SET engine_state = jsonb_set(engine_state, '{record_state}', '"sent_back"'), revision = revision + 1 WHERE id = ${inst.id}`;
    let stale = null;
    try {
      await reserveTask(again, tid1, APPROVE);
    } catch (e) {
      stale = e;
    }
    await admin`UPDATE record_workflow_instances SET engine_state = jsonb_set(engine_state, '{record_state}', '"in_review"'), revision = revision + 1 WHERE id = ${inst.id}`;
    check("…while a change a move depends on, between the check and the reservation, still refuses it (a conflict, nothing written)", moves.isRecordWorkflowConflict(stale), String(stale));
  }

  // A slow notification does not make the actions after it look abandoned, and nothing is delivered twice.
  {
    const tid2 = await submittedTask("Read the pack");
    const n0 = notified.length;
    const k0 = (await assistantTasks()).length;
    let clock = Date.now();
    let release;
    const was = holding;
    createHooks.push({ hold: new Promise((ok) => (release = ok)) });
    const slow = { ...depsAt(new Date()), now: () => new Date(clock), notify: async (...args) => { clock += 100_000; return fakeNotify(...args); } };
    const first = actions.deliverStepActions(A, "tasks", tid2, slow);
    const held = await waitFor(() => holding > was);
    const second = await actions.deliverStepActions(A, "tasks", tid2, depsAt(new Date(clock + 90_000)));
    release();
    const firstOut = await first;
    check("a delivery whose notification took 100 s: the email is written back at once, the task's claim renewed, so a sweep 190 s after the claim takes nothing over; one notification, one task", held && second.length === 0 && firstOut.length === 2 && firstOut.every((o) => o.ok) && notified.length === n0 + 1 && (await assistantTasks()).length === k0 + 1 && outboxOf(await taskInstance(tid2)).length === 0, { held, second, firstOut, notes: notified.length - n0 });
  }

  // A claim taken over as stale while its task write is in flight: both write, the database keeps one.
  {
    const tid3 = await submittedTask("Index the pack");
    const k0 = (await assistantTasks()).length;
    const T = Date.now();
    let release;
    const was = holding;
    createHooks.push({ hold: new Promise((ok) => (release = ok)) });
    const first = actions.deliverStepActions(A, "tasks", tid3, depsAt(new Date(T)));
    const held = await waitFor(() => holding > was);
    const second = await actions.deliverStepActions(A, "tasks", tid3, depsAt(new Date(T + actions.CLAIM_STALE_MS + 1000)));
    release();
    const firstOut = await first;
    const mine = (await assistantTasks()).filter((t) => t.custom?.workflow_action === second[0]?.id);
    check("a task write held past the claim, the action taken over and written by a second delivery: ONE task for the action (the database refuses the second), both take it as delivered", held && second.length === 1 && second[0].kind === "agent" && second[0].ok && firstOut.find((o) => o.kind === "agent")?.ok === true && (await assistantTasks()).length === k0 + 1 && mine.length === 1 && outboxOf(await taskInstance(tid3)).length === 0, { held, second, firstOut, tasks: (await assistantTasks()).length - k0 });
    let dup = "none";
    try {
      await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${A}, 'forged twin', 'probe', ${JSON.stringify({ workflow_action: second[0]?.id })}::text::jsonb)`;
    } catch (e) {
      dup = `${e.code} ${e.constraint_name}`;
    }
    check("…the database refuses a second task for one workflow action outright (23505 on todos_workflow_action_uidx)", dup === "23505 todos_workflow_action_uidx", dup);
  }

  // A notification that ran out of time: those done are kept, the rest shown on the next attempt only.
  {
    const tid4 = await submittedTask("Sign the pack");
    const seen = [];
    const some = async (orgId, emails, notice) => {
      seen.push([...emails].sort());
      const done = [...emails].sort().slice(0, 1);
      return { people: done.length, devices: done.length, done };
    };
    const all = async (orgId, emails, notice) => {
      seen.push([...emails].sort());
      return { people: emails.length, devices: emails.length, done: emails };
    };
    await actions.deliverStepActions(A, "tasks", tid4, { ...depsAt(new Date()), notify: some });
    const email = outboxOf(await taskInstance(tid4)).find((a) => a.kind === "email");
    check("a notification out of time with people left: the person done is kept on the action, it is due again at once, and the attempt is not counted as failed", seen[0]?.length === 3 && email?.delivery.status === "pending" && JSON.stringify(email.reached) === JSON.stringify(seen[0].slice(0, 1)) && email.delivery.attempts === 0 && Date.parse(email.delivery.next_attempt_at) <= Date.now(), { seen, email });
    await actions.deliverStepActions(A, "tasks", tid4, { ...depsAt(new Date()), notify: all });
    check("…the next attempt shows it to the others only, and then it is delivered", JSON.stringify(seen[1]) === JSON.stringify(seen[0].slice(1)) && !outboxOf(await taskInstance(tid4)).some((a) => a.kind === "email"), { seen });
  }

  // The mover and the step's holder left the workspace before the task was written.
  {
    const tid5 = await submittedTask("File the pack");
    const agentId = outboxOf(await taskInstance(tid5)).find((a) => a.kind === "agent")?.delivery.id;
    await admin`DELETE FROM org_members WHERE org_id = ${A} AND email = ${MAKER}`;
    try {
      const out = await actions.deliverStepActions(A, "tasks", tid5, depsAt(new Date()));
      const [task] = (await assistantTasks()).filter((t) => t.custom?.workflow_action === agentId);
      check("a task for the assistant whose mover and holder left: written by \"system\", assigned to no one (never as, or to, a former member)", out.every((o) => o.ok) && task?.created_by === actions.SYSTEM_AUTHOR && !task.assignee, { out, task });
    } finally {
      await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${MAKER}, 'member') ON CONFLICT DO NOTHING`;
    }
  }

  // A reservation that settles another mover's stale one delivers what that settling fired.
  {
    holdOff();
    const made = await todo(MAKER, "POST", { body: { title: "Bind the pack" } });
    const tid6 = made.body?.item?.id;
    const op = await openTask(tid6, MAKER, { comment: SUBMIT.reason, evidence: SUBMIT.evidence });
    await reserveTask(op, tid6, moveCheck("drafting", "in_review", { id: "prepare", state: "completed" }));
    // The service took the write; its mover never settled it; the reservation is old now.
    await admin`UPDATE todos SET custom = custom || '{"state": "in_review"}'::jsonb WHERE org_id = ${A} AND id = ${tid6}`;
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin`UPDATE record_workflow_instances SET engine_state = jsonb_set(engine_state, '{record_move,at}', to_jsonb(${old}::text)) WHERE org_id = ${A} AND entity_type = 'tasks' AND entity_id = ${tid6}`;
    deliverNow();
    const n0 = notified.length;
    const k0 = (await assistantTasks()).length;
    const op2 = await openTask(tid6, CHECKER, { comment: "complete" });
    const r = await reserveTask(op2, tid6, APPROVE, (org, fn) => withOrgRls(org, fn));
    await settle();
    const inst = await taskInstance(tid6);
    check("a reservation that settled another mover's stale one: the actions that settling fired are delivered after its commit, not left to the sweep", typeof r.id === "string" && firedOf(inst).length === 2 && notified.length === n0 + 1 && (await assistantTasks()).length === k0 + 1 && outboxOf(inst).length === 0, { r, fired: firedOf(inst), outbox: outboxOf(inst), notes: notified.length - n0 });
    if (r.id) await releaseTask(tid6, r.id);
  }

  // A create's instance is saved under the record's lock (the delivery it schedules waits for the commit).
  {
    const key = depKey("D-LOCK");
    let free = null;
    await withOrgRls(A, async (tx) => {
      const session = await moves.openRecordWorkflow(tx, A, "deployments", { entityId: null, before: null, actor: MAKER });
      await moves.commitRecordWorkflow(session, { entityId: key, created: true, check: null, after: { customerId: CO, deploymentId: "D-LOCK", custom: {} } });
      free = await admin.begin(async (t) => (await t`SELECT pg_try_advisory_xact_lock(hashtext(${runtime.recordWorkflowLockKey(A, "deployments", key)})) AS got`)[0].got);
      throw new Error("roll back");
    }).catch((e) => {
      if (e?.message !== "roll back") throw e;
    });
    check("a create saves its new instance holding the record's workflow lock until it commits, so the claim its delivery takes waits for it", free === false, free);
  }

  // The sweep: what is due now, the longest waiting first; never one in backoff or being delivered.
  {
    const ids = [];
    for (const t of ["Sweep old", "Sweep due", "Sweep later", "Sweep busy"]) ids.push(await submittedTask(t));
    const [old, due, later, busy] = ids;
    const set = async (id, fn) => {
      const inst = await taskInstance(id);
      const state = inst.engine_state;
      for (const a of state.outbox) fn(a.delivery);
      await admin`UPDATE record_workflow_instances SET engine_state = ${admin.json(state)} WHERE id = ${inst.id}`;
    };
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    await set(old, (d) => { d.next_attempt_at = ago(10 * 60_000); });
    await set(due, (d) => { d.next_attempt_at = ago(60_000); });
    await set(later, (d) => { d.status = "pending"; d.attempts = 1; d.next_attempt_at = new Date(Date.now() + 10 * 60_000).toISOString(); });
    await set(busy, (d) => { d.status = "processing"; d.attempts = 1; d.claimed_at = ago(5_000); });
    const listed = (await withOrgRls(A, (tx) => actions.recordsWithStepActions(tx, A, 50))).filter((r) => ids.includes(r.key)).map((r) => r.key);
    check("the sweep lists the records with an action due now, the longest waiting first; never one waiting out its backoff, or one being delivered now", JSON.stringify(listed) === JSON.stringify([old, due]), { listed, old, due, later, busy });
    const stale = (await withOrgRls(A, (tx) => actions.recordsWithStepActions(tx, A, 50, new Date(Date.now() + actions.CLAIM_STALE_MS + 1000)))).filter((r) => ids.includes(r.key)).map((r) => r.key);
    check("…once its claim is stale, the one being delivered is due too", stale.includes(busy) && !stale.includes(later), { stale });
    for (const id of ids) await actions.deliverStepActions(A, "tasks", id, depsAt(new Date(Date.now() + 2 * 60 * 60_000)));
  }

  // ── workspace B ──────────────────────────────────────────────────────────────────────────────────────────────────
  const callB = (who, method, opts) => call(who, method, opts);
  const nB = notified.length;
  const tA = (await assistantTasks(A)).length;
  await callB(BEN, "POST", { body: { ...BASE, deploymentId: "D-1" } });
  const bSubmit = await callB(BEN, "PATCH", { id: "D-1", body: { customerId: CO, custom: { review_state: "in_review" }, ...SUBMIT } });
  await settle();
  const bNotes = notesFor(nB);
  const bTasks = await assistantTasks(B);
  check("workspace B's submit of its own D-1: its notification reaches its own people only, in its workspace", bSubmit.status === 200 && bNotes.length === 1 && bNotes[0].orgId === B && JSON.stringify(bNotes[0].emails) === JSON.stringify([BEN, BEA].sort()), { bSubmit, bNotes });
  check("…its task for the assistant is written in B, and A gains none", bTasks.length === 1 && bTasks[0].assignee === BEN && (await assistantTasks(A)).length === tA, bTasks);
  // B's actions are pending again (held off), and A's delivery and A's sweep cannot reach them.
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify, runIn: async () => [] }));
  await callB(BEN, "POST", { body: { ...BASE, deploymentId: "D-7" } });
  await callB(BEN, "PATCH", { id: "D-7", body: { customerId: CO, custom: { review_state: "in_review" }, ...SUBMIT } });
  await settle();
  actions.setStepActionDeps((r) => ({ ...actions.productionStepActionDeps(r), notify: fakeNotify }));
  const fromA = await actions.deliverStepActions(A, "deployments", depKey("D-7"), depsAt(new Date()));
  const sweptA = await withOrgRls(A, (tx) => actions.recordsWithStepActions(tx, A, 50));
  const sweptB = await withOrgRls(B, (tx) => actions.recordsWithStepActions(tx, B, 50));
  const bInst = await instanceOf("D-7", B);
  check("A's delivery of B's record key delivers nothing, and B's actions stay pending", fromA.length === 0 && outboxOf(bInst).length === 2 && outboxOf(bInst).every((a) => a.delivery.status === "pending"), { fromA, outbox: outboxOf(bInst) });
  check("A's sweep lists none of B's records; B's lists its own", !sweptA.some((r) => r.key === depKey("D-7")) && sweptB.some((r) => r.key === depKey("D-7")), { sweptA, sweptB });
  const seen = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${A}, true)`;
    const [i] = await tx`SELECT count(*)::int AS n FROM record_workflow_instances WHERE org_id = ${B}`;
    const [t] = await tx`SELECT count(*)::int AS n FROM todos WHERE org_id = ${B}`;
    return { instances: i.n, todos: t.n };
  });
  check("under row-level security, A reads none of B's instances (their pending actions) or tasks", seen.instances === 0 && seen.todos === 0, seen);
  const fromB = await actions.deliverStepActions(B, "deployments", depKey("D-7"), depsAt(new Date()));
  check("…B's own delivery delivers them, in B", fromB.length === 2 && fromB.every((o) => o.ok) && notified.at(-1).orgId === B, fromB);
} catch (e) {
  failures++;
  console.log(`  FAIL the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await Promise.all([admin.end({ timeout: 2 }), holder.end({ timeout: 2 }), app.end({ timeout: 2 })]).catch(() => undefined);
}
console.log(`\nrecord-workflow-actions-db-probe: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
