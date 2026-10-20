#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW ON ITS MOVES, AGAINST A REAL POSTGRES, for the definitions of THIS checkout's profile
 * (scripts/test-record-workflow-runtime-db.mjs runs it in copies under scripts/fixtures/record-workflows/review.json:
 * enforce "strict", "warn" and "off"). The real deployments routes (lib/record-area-routes.ts), the agent's
 * upsert_deployment and upsert_customer, as the restricted app_rw role under the fail-closed policies, two workspaces.
 *
 *   strict  attached on create; a move by someone who does not hold the step, or without the step's evidence or
 *           comment, is a 409 naming the rule and who holds the step, and writes nothing (record, feed, instance);
 *           the holder's move changes the step and the workflow opens the next one; four eyes: the entrant cannot
 *           approve, by {entered_by} and as the step holder; a supervisor acts on their reportee's step; a record stored
 *           under an earlier key and a legacy spelling, moved before the binding, is attached mid-lifecycle at the
 *           state it stands for (dated from the feed) and its move drives the step, nothing rewritten; a stale revision
 *           (someone else changed the instance under the move) is a 409 and nothing of the write is kept; the agent's
 *           tool refuses with the same sentence; upsert_customer refuses a nested move of the area;
 *   warn    every move goes through; one that broke a step rule carries its warning, writes the rule to the feed and
 *           changes its step as an administrative change;
 *   off     the engine is never called: no instance, `evidence` is no field (today's 400), the moves are today's;
 *   every   workspace B sees none of A's instances or events (through the routes and the rows under RLS), and attaches
 *           its own to a record of the same id.
 *   and, in the strict copy, the two other doors (the fixture's tasks and periods are strict whatever the deployments'
 *   enforce): a task through the todos routes, whose write is the task-workflow service's (a stand-in running the
 *   service's own engine, as scripts/lib/record-lifecycle-db-probe.mjs does), and upsert_todo; a period through the
 *   cycles routes and upsert_cycle. Refused moves reach neither the service nor the table.
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
  console.log("record-workflow-runtime-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "record-workflow-runtime-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
// The tasks' door waits this long for the service at most (a stand-in that answers late shows what happens then).
process.env.RECORD_WORKFLOW_SERVICE_TIMEOUT_MS = "1500";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const LC = RECORD_AREAS.deployments.lifecycle;
const MODE = LC?.workflow ? LC.enforce ?? "off" : "unbound";
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const holder = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   [${MODE}] ${what}`);
  } else {
    failures++;
    console.log(`  FAIL [${MODE}] ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 1500)}`}`);
  }
};

const TAG = `${process.pid}-${MODE}`;
const A = `org-wfr-a-${TAG}`;
const B = `org-wfr-b-${TAG}`;
const at = (name, org = "a") => `${name}-${TAG}@wfr-${org}.test`;
const OWNER = at("a-owner");
const MAKER = at("b-maker");
const CHECKER = at("c-checker");
const ADMIN = at("d-admin");
const LEAD = at("e-lead");
const OTHER = at("f-other");
const BEN = at("ben", "b");
const CO = `acct-${TAG}`;
const DUTY = { [MAKER]: "maker", [CHECKER]: "checker", [ADMIN]: "checker" };

async function cleanup() {
  for (const org of [A, B]) {
    // Events are append-only for app_rw; the superuser clears the test's own rows.
    await admin`DELETE FROM record_workflow_events WHERE org_id = ${org}`.catch(() => undefined);
    await admin`DELETE FROM record_workflow_instances WHERE org_id = ${org}`.catch(() => undefined);
  }
  for (const t of ["task_workflow_transition_events", "task_workflow_instances", "project_workflow_versions", "workflow_definitions", "entity_activity", "todos", "cycles", "deployments", "implementation", "customers", "people_roster", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

// The task-workflow service, in process, with the context its auth builds (lib/auth.ts): every request it is sent.
const engine = await import(pathToFileURL(`${SERVICE}/lib/engine.ts`).href);
const { withOrgTransaction } = await import(pathToFileURL(`${SERVICE}/lib/db.ts`).href);
const { taskCreateSchema, taskPatchSchema } = await import(pathToFileURL(`${SERVICE}/lib/types.ts`).href);
const { errorResponse, issueMessage } = await import(pathToFileURL(`${SERVICE}/lib/http.ts`).href);
const { parseTaskStates } = await import(pathToFileURL(`${SERVICE}/lib/stages.ts`).href);
const received = [];
// What the stand-in does with the next PATCHes, in order: { refuse } answers 409 and writes nothing; { stall } waits
// that long and answers 500 without writing; { afterWrite } runs once the task is written; { late } answers that late.
const hooks = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  received.push({ method: req.method, path: req.url, text });
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
      const r = await withOrgTransaction(ctx.orgId, (sql) => engine.createTask(sql, ctx, parsed.data));
      return send(Response.json({ item: r.item }, { status: 201 }));
    }
    if (one && req.method === "PATCH") {
      const parsed = taskPatchSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return send(Response.json({ error: issueMessage(parsed.error) }, { status: 400 }));
      const hook = hooks.shift() ?? {};
      if (hook.refuse) return send(Response.json({ error: hook.refuse }, { status: 409 }));
      if (hook.stall) {
        await sleep(hook.stall);
        return send(Response.json({ error: "stalled" }, { status: 500 }));
      }
      const r = await withOrgTransaction(ctx.orgId, (sql) => engine.updateTask(sql, ctx, one[1], parsed.data));
      if (hook.afterWrite) await hook.afterWrite(one[1]);
      if (hook.late) await sleep(hook.late);
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
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Workflow runtime A', 'active'), (${B}, 'Workflow runtime B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES
    (${A}, ${OWNER}, 'owner'), (${A}, ${MAKER}, 'member'), (${A}, ${CHECKER}, 'member'), (${A}, ${ADMIN}, 'admin'),
    (${A}, ${LEAD}, 'member'), (${A}, ${OTHER}, 'member'), (${B}, ${BEN}, 'admin')`;
  // The people data the directory is built from: each one's duty (people.attributes) and the checker's supervisor.
  for (const email of [MAKER, CHECKER, ADMIN, LEAD, OTHER]) {
    await admin`INSERT INTO people_roster (email, org_id, name, manager_email, attributes) VALUES (${email}, ${A}, ${email.split("-")[1]}, ${email === CHECKER ? LEAD : null}, ${admin.json(DUTY[email] ? { duty: DUTY[email] } : {})})`;
  }
  await admin`INSERT INTO people_roster (email, org_id, name, attributes) VALUES (${BEN}, ${B}, 'ben', ${admin.json({ duty: "maker" })})`;
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Acme (A)'), (${CO}, ${B}, 'Acme (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const people = [OWNER, MAKER, CHECKER, ADMIN, LEAD, OTHER, BEN];
  const bearers = Object.fromEntries(await Promise.all(people.map(async (p) => [p, `Bearer ${await mintSessionToken(p)}`])));
  const orgOf = Object.fromEntries(people.map((p) => [p, p === BEN ? B : A]));
  const H = "http://workflow-runtime.test";
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
  const create = (who, id, extra = {}) => call(who, "POST", { body: { ...BASE, deploymentId: id, ...extra } });
  const move = (who, id, state, extra = {}) => call(who, "PATCH", { id, body: { customerId: CO, custom: { review_state: state }, ...extra } });
  const dep = async (id, org = A) => (await admin`SELECT * FROM deployments WHERE org_id = ${org} AND deployment_id = ${id}`)[0];
  const stateOf = async (id) => (await dep(id))?.custom?.review_state;
  // A deployment's workflow is keyed by its account and id (lib/record-workflow-moves.ts workflowRecordKey).
  const depKey = (id) => `${encodeURIComponent(CO)}/${encodeURIComponent(id)}`;
  const instanceOf = async (id, org = A) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${org} AND entity_type = 'deployments' AND entity_id = ${depKey(id)}`)[0];
  const eventsOf = async (inst) => (inst ? await admin`SELECT * FROM record_workflow_events WHERE instance_id = ${inst.id} ORDER BY id` : []);
  const stepOf = (inst, sid) => inst?.steps?.find((s) => s.id === sid);
  const feed = async (id) => (await admin`SELECT actor, event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'deployment' AND entity_id = ${id} ORDER BY created_at, id`).map((r) => `${r.actor}: ${r.event}`);
  const instanceCount = async (org) => Number((await admin`SELECT count(*)::int AS n FROM record_workflow_instances WHERE org_id = ${org}`)[0].n);
  const sor = await import(root("agent/lib/system-of-record.ts"));
  const tools = await import(root("agent/lib/record-area-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const upsertTool = tools.upsertAreaTool("deployments");
  const tool = async (input, who) => Promise.resolve().then(() => upsertTool.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const SUBMIT = { reason: "prepared and checked", evidence: "doc://evidence/1" };
  const rules = (b) => (b?.broken ?? []).map((x) => x.rule).sort().join(",");

  if (MODE === "strict") {
    // ── attach on create ─────────────────────────────────────────────────────────────────────────────────────────
    const made = await create(MAKER, "S-1");
    const i1 = await instanceOf("S-1");
    check("a create attaches the record's instance in the same write: the maker holds the preparation, the review sleeps", made.status === 201 && i1?.workflow_id === "maker-checker" && i1.revision === 1 && stepOf(i1, "prepare")?.state === "open" && JSON.stringify(stepOf(i1, "prepare")?.assignee) === JSON.stringify([MAKER]) && stepOf(i1, "review")?.status === false, { made, i1 });
    check("…pinned to the deployment's document, its history the creation only", i1?.definition?.init?.start_id === "prepare" && (await eventsOf(i1)).map((e) => e.type).join() === "instance_created", (await eventsOf(i1)).map((e) => e.type));

    // ── the step rules refuse, and nothing is written ────────────────────────────────────────────────────────────
    const feedBefore = await feed("S-1");
    const notHolder = await move(OTHER, "S-1", "in_review", SUBMIT);
    check("not_holder: someone who does not hold the step is refused (409), the sentence names who holds it by their roster name, not their email", notHolder.status === 409 && notHolder.body?.code === "lifecycle_refused" && rules(notHolder.body) === "not_holder" && notHolder.body.error.includes('only whoever holds the step "Prepare" (maker) may make it') && !notHolder.body.error.includes(MAKER), notHolder);
    check("…the allowed moves say who holds each one's step", JSON.stringify(notHolder.body?.allowed?.map((m) => [m.to, m.held_by])) === JSON.stringify([["in_review", ["maker"]]]), notHolder.body?.allowed);
    const noEvidence = await move(MAKER, "S-1", "in_review", { reason: "done" });
    check("step_evidence: the holder without the step's evidence is refused, naming what to send", noEvidence.status === 409 && rules(noEvidence.body) === "step_evidence" && /needs evidence, a link or a document's id sent as `evidence`/.test(noEvidence.body?.error ?? ""), noEvidence);
    const after1 = await instanceOf("S-1");
    check("…nothing written: the record's state, its feed, its instance and its history are what they were", (await stateOf("S-1")) === "drafting" && JSON.stringify(await feed("S-1")) === JSON.stringify(feedBefore) && after1.revision === 1 && (await eventsOf(after1)).length === 1, { state: await stateOf("S-1"), rev: after1.revision });

    // ── the holder moves, the workflow opens the review ──────────────────────────────────────────────────────────
    const submitted = await move(MAKER, "S-1", "in_review", SUBMIT);
    const i2 = await instanceOf("S-1");
    const prep = stepOf(i2, "prepare");
    const rev = stepOf(i2, "review");
    check("the holder's move: the record moves and its step completes, with the comment and the evidence, in one write", submitted.status === 200 && (await stateOf("S-1")) === "in_review" && i2.revision === 2 && prep.state === "completed" && prep.comments?.[0]?.text === SUBMIT.reason && prep.evidence?.[0]?.ref === SUBMIT.evidence, { submitted, prep });
    check("…the workflow's own rules open the review for the two with the checker duty", rev.status === true && rev.state === "open" && JSON.stringify(rev.assignee) === JSON.stringify([CHECKER, ADMIN]), rev);
    const ev2 = (await eventsOf(i2)).map((e) => `${e.type}:${e.step_id ?? ""}:${e.actor ?? ""}`);
    check("…its history: the comment, the evidence, the change and the decision by the holder, then the rules", ev2.includes(`state_changed:prepare:${MAKER}`) && ev2.includes(`evidence_added:prepare:${MAKER}`) && ev2.some((e) => e.startsWith("diff_rule_fired")), ev2);
    check("…and the move is in the activity feed as every enforced move is", (await feed("S-1")).some((l) => l.startsWith(`${MAKER}: `) && /\[review_state: drafting → in_review\]$/.test(l)), await feed("S-1"));

    // ── four eyes ────────────────────────────────────────────────────────────────────────────────────────────────
    const own = await move(MAKER, "S-1", "approved", { reason: "looks fine" });
    check("four eyes: the entrant cannot approve (not_by, and the review is not theirs)", own.status === 409 && rules(own.body) === "not_by,not_holder", own);
    const noComment = await move(CHECKER, "S-1", "approved");
    check("step_comment: the reviewer without a comment is refused", noComment.status === 409 && rules(noComment.body) === "step_comment", noComment);
    const approved = await move(CHECKER, "S-1", "approved", { reason: "complete" });
    const i3 = await instanceOf("S-1");
    check("a second person holding the review approves: the record is approved and its workflow finished", approved.status === 200 && (await stateOf("S-1")) === "approved" && stepOf(i3, "review")?.state === "completed" && i3.terminal === true, { approved, i3: i3?.steps });

    await create(ADMIN, "S-2");
    const adminSubmit = await move(ADMIN, "S-2", "in_review", SUBMIT);
    check("an admin acts on a step they do not hold (role scope All)", adminSubmit.status === 200 && stepOf(await instanceOf("S-2"), "prepare")?.state === "completed", adminSubmit);
    const adminApprove = await move(ADMIN, "S-2", "approved", { reason: "mine" });
    check("four eyes as the step holder: the admin who holds the review but submitted it is refused by not_by alone", adminApprove.status === 409 && rules(adminApprove.body) === "not_by", adminApprove);
    const leadApprove = await move(LEAD, "S-2", "approved", { reason: "as the supervisor" });
    check("a supervisor (the roster's reporting line) acts on their reportee's step", leadApprove.status === 200 && (await stateOf("S-2")) === "approved", leadApprove);

    // ── attached mid-lifecycle, legacy spelling under an earlier key ────────────────────────────────────────────
    const ENTERED = new Date("2026-04-01T10:00:00.000Z");
    for (const id of ["S-3", "S-4"]) {
      await admin`INSERT INTO deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, custom) VALUES (${A}, ${CO}, ${id}, 'prod', 'eu-west-1', '0.9', 'deployed', 'healthy', ${admin.json({ approval_state: "pending", note: "kept" })})`;
      await admin`INSERT INTO entity_activity (org_id, entity_type, entity_id, actor, event, created_at) VALUES (${A}, 'deployment', ${id}, ${MAKER}, ${'State moved "draft" → "pending" [review_state: draft → pending]'}, ${ENTERED})`;
    }
    check("records moved before the binding hold no instance", !(await instanceOf("S-3")) && !(await instanceOf("S-4")));
    const legacyOwn = await move(MAKER, "S-4", "approved", { reason: "x" });
    check("four eyes reads the feed's legacy spelling: its entrant is refused, and a refused move attaches nothing", legacyOwn.status === 409 && /not_by/.test(rules(legacyOwn.body)) && !(await instanceOf("S-4")), legacyOwn);
    const legacy = await move(CHECKER, "S-3", "approved", { reason: "approved after the move" });
    const i4 = await instanceOf("S-3");
    const d4 = await dep("S-3");
    check("the first move after the binding attaches the instance at the state the legacy spelling stands for, and drives the step", legacy.status === 200 && stepOf(i4, "review")?.state === "completed" && i4.terminal === true, { legacy, i4: i4?.steps });
    check("…the step it was past starts completed, dated when the feed says the record entered its state", stepOf(i4, "prepare")?.state === "completed" && stepOf(i4, "prepare")?.completed_at === ENTERED.toISOString(), stepOf(i4, "prepare"));
    const ev4 = await eventsOf(i4);
    check("…its seeding is provisioning, never a decision: the only state change is the reviewer's", ev4.some((e) => e.type === "step_patched" && e.source === "provisioning" && e.step_id === "prepare") && ev4.filter((e) => e.type === "state_changed").map((e) => `${e.step_id}:${e.actor}`).join() === `review:${CHECKER}`, ev4.map((e) => [e.type, e.step_id, e.source, e.actor]));
    check("…nothing rewritten: the earlier key keeps its legacy spelling and every other own value; the move writes the new key", d4.custom.approval_state === "pending" && d4.custom.note === "kept" && d4.custom.review_state === "approved", d4.custom);

    // ── a stale revision ──────────────────────────────────────────────────────────────────────────────────────────
    await create(MAKER, "S-5");
    await move(MAKER, "S-5", "in_review", SUBMIT);
    const i5 = await instanceOf("S-5");
    const feed5 = await feed("S-5");
    // Someone else changes the instance under the move: the row is locked and its revision moved on before the
    // reviewer's write reaches it.
    const lock = await holder.reserve();
    await lock`BEGIN`;
    await lock`UPDATE record_workflow_instances SET revision = revision + 1 WHERE id = ${i5.id}`;
    const racing = move(CHECKER, "S-5", "approved", { reason: "racing" });
    let waited = false;
    for (let i = 0; i < 100 && !waited; i++) {
      const [w] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%record_workflow_instances%'`;
      waited = w.n > 0;
      if (!waited) await new Promise((ok) => setTimeout(ok, 50));
    }
    await lock`COMMIT`;
    lock.release();
    const stale = await racing;
    const i5b = await instanceOf("S-5");
    check("a stale revision: the move waited on the instance, found it changed, and is a 409", waited && stale.status === 409 && stale.body?.code === "workflow_conflict" && stale.body?.reason === "stale_revision", { waited, stale });
    check("…nothing of the write is kept: the record, its feed, the instance's steps and history are as they were", (await stateOf("S-5")) === "in_review" && JSON.stringify(await feed("S-5")) === JSON.stringify(feed5) && i5b.revision === i5.revision + 1 && JSON.stringify(i5b.steps) === JSON.stringify(i5.steps) && (await eventsOf(i5b)).length === (await eventsOf(i5)).length, { state: await stateOf("S-5"), rev: [i5.revision, i5b.revision] });
    const retried = await move(CHECKER, "S-5", "approved", { reason: "again" });
    check("…read again and sent again, it goes through", retried.status === 200 && (await stateOf("S-5")) === "approved" && (await instanceOf("S-5")).revision === i5.revision + 2, retried);

    // ── a workflow is never borrowed: the body's entityId names another record ─────────────────────────────────
    await create(MAKER, "X-1");
    await move(MAKER, "X-1", "in_review", SUBMIT);
    await create(MAKER, "Y-1");
    await move(ADMIN, "Y-1", "in_review", SUBMIT);
    const x0 = await instanceOf("X-1");
    const borrowed = await move(ADMIN, "Y-1", "approved", { reason: "mine", entityId: "X-1" });
    check("PATCH Y with entityId X: four eyes reads Y's own feed (its entrant is refused), not X's", borrowed.status === 409 && rules(borrowed.body) === "not_by", borrowed);
    const throughY = await move(CHECKER, "Y-1", "approved", { reason: "complete", entityId: "X-1" });
    const x1 = await instanceOf("X-1");
    const y1 = await instanceOf("Y-1");
    check("…and the move drives Y's own instance: X's is untouched (same revision, review still open)", throughY.status === 200 && y1.terminal === true && x1.revision === x0.revision && stepOf(x1, "review")?.state === "open" && JSON.stringify(await eventsOf(x1)) === JSON.stringify(await eventsOf(x0)), { throughY, x: [x0.revision, x1.revision] });
    check("…keyed by the record's own account and id", y1.entity_id === `${encodeURIComponent(CO)}/Y-1` && (await admin`SELECT count(*)::int AS n FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'deployments' AND entity_id IN ('X-1', 'Y-1')`)[0].n === 0, y1.entity_id);

    // ── two movers at once: the second is checked from the state the first left ─────────────────────────────────
    await create(MAKER, "C-1");
    await move(MAKER, "C-1", "in_review", SUBMIT);
    const [ap, sb] = await Promise.all([move(CHECKER, "C-1", "approved", { reason: "complete" }), move(ADMIN, "C-1", "sent_back", { reason: "missing a page" })]);
    const c1 = await instanceOf("C-1");
    const decided = (await eventsOf(c1)).filter((e) => e.type === "state_changed" && e.step_id === "review");
    const winner = ap.status === 200 ? "approved" : "sent_back";
    check("two concurrent movers: exactly one moves; the other, checked from the state the first left, is refused", [ap.status, sb.status].sort().join() === "200,409" && decided.length === 1 && (await stateOf("C-1")) === winner, { ap, sb, decided: decided.map((e) => e.detail) });

    // ── implementations: one instance, whichever door ────────────────────────────────────────────────────────────
    if (RECORD_AREAS.implementations.lifecycle?.workflow) {
      const callImp = async (who, method, { body, id } = {}) => {
        const handlers = await import(root(id ? "app/api/ops/implementations/[id]/route.ts" : "app/api/ops/implementations/route.ts"));
        const path = `/api/ops/implementations${id ? `/${encodeURIComponent(id)}` : ""}`;
        const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
        const out = await res.text();
        let json = null;
        try { json = JSON.parse(out); } catch { /* not json */ }
        return { status: res.status, body: json };
      };
      const impTool = tools.upsertAreaTool("implementations");
      const viaTool = await Promise.resolve().then(() => impTool.execute({ customerId: CO, values: {} }, ctxFor(MAKER))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      // Its feed and list key is its rollout (implementationKey); its workflow's key stays its own id.
      await admin`UPDATE implementation SET rollout_id = 'R-9' WHERE org_id = ${A} AND customer_id = ${CO}`;
      const viaPatch = await callImp(MAKER, "PATCH", { id: CO, body: { customerId: CO, custom: { review_state: "in_review" }, ...SUBMIT } });
      const viaPost = await callImp(CHECKER, "POST", { body: { customerId: CO, custom: { review_state: "approved" }, reason: "complete" } });
      const imps = await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'implementations'`;
      check("implementations: created by the tool, submitted through PATCH, approved through POST: one instance, keyed by the record's own id, moved by each door", !viaTool.error && viaPatch.status === 200 && viaPost.status === 200 && imps.length === 1 && imps[0].entity_id === CO && stepOf(imps[0], "prepare")?.state === "completed" && stepOf(imps[0], "review")?.state === "completed" && imps[0].terminal === true, { viaTool, viaPatch, viaPost, imps: imps.map((i) => [i.entity_id, i.revision]) });
    }

    // ── the agent's doors ────────────────────────────────────────────────────────────────────────────────────────
    await create(MAKER, "S-6");
    const byTool = await tool({ customerId: CO, deploymentId: "S-6", values: { custom: { review_state: "in_review" } } }, OTHER);
    check("upsert_deployment: the same refusal, as its sentence, and nothing written", /only whoever holds the step "Prepare"/.test(byTool.error ?? "") && (await stateOf("S-6")) === "drafting" && (await instanceOf("S-6")).revision === 1, byTool);
    const nested = await sor.upsertCustomer({ id: CO, deployments: [{ deploymentId: "S-6", custom: { review_state: "in_review" } }] }, A, { actor: MAKER }).then(() => "ok", (e) => String(e?.message ?? e));
    check("upsert_customer: a nested move of an area that runs a workflow is refused before anything is written", /^Nothing was written\. .* follows a workflow here, so it is moved on its own/.test(nested) && (await stateOf("S-6")) === "drafting", nested);
  }

  if (MODE === "strict" && RECORD_AREAS.tasks.lifecycle?.workflow && RECORD_AREAS.periods.lifecycle?.workflow) {
    // ── a task: its write is the task-workflow service's ──────────────────────────────────────────────────────────
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
    const taskRow = async (id) => (await admin`SELECT * FROM todos WHERE org_id = ${A} AND id = ${id}`)[0];
    const taskInstance = async (id) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'tasks' AND entity_id = ${id}`)[0];
    const madeTask = await todo(MAKER, "POST", { body: { title: "Prepare the pack" } });
    const tid = madeTask.body?.item?.id;
    const ti1 = tid ? await taskInstance(tid) : null;
    check("tasks: a create through the service attaches the task's instance once the service took it", madeTask.status === 201 && typeof tid === "string" && ti1?.revision === 1 && JSON.stringify(stepOf(ti1, "prepare")?.assignee) === JSON.stringify([MAKER]), { madeTask, ti1 });
    const sentBefore = received.length;
    const taskRefused = await todo(OTHER, "PATCH", { id: tid, body: { custom: { state: "in_review" }, ...SUBMIT } });
    check("tasks: a move by someone who does not hold the step is a 409 that never reaches the service", taskRefused.status === 409 && rules(taskRefused.body) === "not_holder" && received.length === sentBefore && (await taskRow(tid))?.custom?.state === "drafting", { taskRefused, sent: received.length - sentBefore });
    const tiRev = (await taskInstance(tid)).revision;
    const taskSubmit = await todo(MAKER, "PATCH", { id: tid, body: { custom: { state: "in_review" }, ...SUBMIT } });
    const ti2 = await taskInstance(tid);
    const forwarded = received.at(-1);
    check("tasks: the holder's move goes to the service without `evidence`; reserved, then settled by the task's state, the instance moves once it took it", taskSubmit.status === 200 && (await taskRow(tid))?.custom?.state === "in_review" && ti2.revision === tiRev + 2 && !ti2.engine_state?.record_move && stepOf(ti2, "prepare")?.evidence?.[0]?.ref === SUBMIT.evidence && !JSON.parse(forwarded?.text ?? "{}").evidence, { taskSubmit, forwarded, ti2: ti2?.steps });
    const taskOwn = await todo(MAKER, "PATCH", { id: tid, body: { custom: { state: "approved" }, reason: "mine" } });
    check("tasks: four eyes, the entrant cannot approve", taskOwn.status === 409 && rules(taskOwn.body) === "not_by,not_holder", taskOwn);
    const todoTools = await import(root("agent/lib/todo-tools.ts"));
    const toolTask = async (input, who) => Promise.resolve().then(() => todoTools.upsertTodoTool.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    const revBefore = (await taskInstance(tid)).revision;
    const sentBeforeTool = received.length;
    const byTodo = await toolTask({ id: tid, custom: { state: "approved" }, reason: "x" }, OTHER);
    check("upsert_todo: the same refusal as its sentence (holders by name), nothing sent, nothing written", /only whoever holds the step "Review" \(checker, admin\)/.test(byTodo.error ?? "") && received.length === sentBeforeTool && (await taskInstance(tid)).revision === revBefore && (await taskRow(tid))?.custom?.state === "in_review", byTodo);
    const byTodoOk = await toolTask({ id: tid, custom: { state: "approved" }, reason: "complete" }, CHECKER);
    const ti3 = await taskInstance(tid);
    check("upsert_todo: the reviewer approves through the tool: the service writes the task, the instance finishes", byTodoOk.updated === true && (await taskRow(tid))?.custom?.state === "approved" && ti3.terminal === true && stepOf(ti3, "review")?.state === "completed", { byTodoOk, ti3: ti3?.steps });

    // ── a period ─────────────────────────────────────────────────────────────────────────────────────────────────
    const cycle = async (who, method, { body, id } = {}) => {
      const handlers = await import(root(id ? "app/api/ops/cycles/[id]/route.ts" : "app/api/ops/cycles/route.ts"));
      const path = `/api/ops/cycles${id ? `/${id}` : ""}`;
      const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
      const out = await res.text();
      let json = null;
      try { json = JSON.parse(out); } catch { /* not json */ }
      return { status: res.status, body: json };
    };
    const periodInstance = async (id) => (await admin`SELECT * FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'periods' AND entity_id = ${id}`)[0];
    const periodState = async (id) => (await admin`SELECT state FROM cycles WHERE org_id = ${A} AND id = ${id}`)[0]?.state;
    const madeP = await cycle(MAKER, "POST", { body: { name: "Batch one" } });
    const pid = madeP.body?.item?.id;
    check("periods: a create attaches the period's instance in the same write", madeP.status === 201 && typeof pid === "string" && (await periodInstance(pid))?.revision === 1, madeP);
    const pNoEvidence = await cycle(MAKER, "PATCH", { id: pid, body: { state: "review", reason: "done" } });
    check("periods: the step's evidence is asked for (409), and nothing is written", pNoEvidence.status === 409 && rules(pNoEvidence.body) === "step_evidence" && (await periodState(pid)) === "planning" && (await periodInstance(pid)).revision === 1, pNoEvidence);
    const pSubmit = await cycle(MAKER, "PATCH", { id: pid, body: { state: "review", ...SUBMIT } });
    check("periods: the holder's move with its evidence changes the period and its step together", pSubmit.status === 200 && (await periodState(pid)) === "review" && stepOf(await periodInstance(pid), "prepare")?.state === "completed", pSubmit);
    const cycleTools = await import(root("agent/lib/todo-tools.ts"));
    const byCycle = await Promise.resolve().then(() => cycleTools.upsertCycleTool.execute({ id: pid, state: "closed", reason: "mine" }, ctxFor(MAKER))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    check("upsert_cycle: four eyes refuses the entrant, as its sentence", /not by the person who moved it to/.test(byCycle.error ?? "") && (await periodState(pid)) === "review", byCycle);
    const pApprove = await cycle(CHECKER, "PATCH", { id: pid, body: { state: "closed", reason: "signed off" } });
    check("periods: a second person holding the review signs it off; the workflow is finished", pApprove.status === 200 && (await periodState(pid)) === "closed" && (await periodInstance(pid)).terminal === true, pApprove);

    // ── a period moved without the engine (as rollover writes it): re-synced, never a false refusal ────────────────
    const madeQ = await cycle(MAKER, "POST", { body: { name: "Batch two" } });
    const qid = madeQ.body?.item?.id;
    await admin`UPDATE cycles SET state = 'review' WHERE org_id = ${A} AND id = ${qid}`;
    const qApprove = await cycle(CHECKER, "PATCH", { id: qid, body: { state: "closed", reason: "signed off after the system's move" } });
    const qi = await periodInstance(qid);
    check("periods: moved outside the engine, its next move is checked where it really is (no false step_inactive), the re-sync recorded as provisioning", madeQ.status === 201 && qApprove.status === 200 && (await periodState(qid)) === "closed" && qi.terminal === true && (await eventsOf(qi)).some((e) => e.source === "provisioning" && /re-synced: the record moved from "planning" to "review"/.test(e.detail ?? "")), { qApprove, events: (await eventsOf(qi)).map((e) => [e.type, e.source, e.detail]) });

    // ── a task's write is the service's: what happens when it refuses, fails, or answers late ──────────────────────
    const fresh = async (title) => (await todo(MAKER, "POST", { body: { title } })).body?.item?.id;
    const t2 = await fresh("Refused by the service");
    hooks.push({ refuse: "the service says no" });
    const svcRefused = await todo(MAKER, "PATCH", { id: t2, body: { custom: { state: "in_review" }, ...SUBMIT } });
    const t2i = await taskInstance(t2);
    check("tasks: the service refuses: its answer stands, the task and its step stay, the reservation is released", svcRefused.status === 409 && svcRefused.body?.error === "the service says no" && (await taskRow(t2))?.custom?.state === "drafting" && stepOf(t2i, "prepare")?.state === "open" && !t2i.engine_state?.record_move && (await eventsOf(t2i)).some((e) => e.data?.outcome === "released"), { svcRefused, t2i: t2i?.engine_state });

    const t3 = await fresh("Answered late, written");
    hooks.push({ late: 2500 });
    const lateWritten = await todo(MAKER, "PATCH", { id: t3, body: { custom: { state: "in_review" }, ...SUBMIT } });
    const t3i = await taskInstance(t3);
    check("tasks: the service writes but answers after the time limit: the answer says the move was made, and the step followed", lateWritten.status === 502 && lateWritten.body?.moved === true && (await taskRow(t3))?.custom?.state === "in_review" && stepOf(t3i, "prepare")?.state === "completed" && !t3i.engine_state?.record_move, { lateWritten, steps: t3i?.steps });

    const t4 = await fresh("Stalled, not written");
    hooks.push({ stall: 2500 });
    const stalled = await todo(MAKER, "PATCH", { id: t4, body: { custom: { state: "in_review" }, ...SUBMIT } });
    const t4i = await taskInstance(t4);
    check("tasks: the service stalls and writes nothing: the answer is a failure, the task and its step stay, nothing pending", stalled.status >= 500 && stalled.body?.moved !== true && (await taskRow(t4))?.custom?.state === "drafting" && stepOf(t4i, "prepare")?.state === "open" && !t4i.engine_state?.record_move, { stalled, t4i: t4i?.engine_state });

    const t5 = await fresh("Settled late");
    const t5id0 = (await taskInstance(t5)).id;
    // While the service writes, someone else holds the instance and moves its revision: settling right after fails.
    let release = null;
    hooks.push({
      afterWrite: async () => {
        const conn = await holder.reserve();
        await conn`BEGIN`;
        await conn`UPDATE record_workflow_instances SET revision = revision + 1 WHERE id = ${t5id0}`;
        release = (async () => {
          for (let i = 0; i < 100; i++) {
            const [w] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%record_workflow_instances%'`;
            if (w.n > 0) break;
            await sleep(50);
          }
          await conn`COMMIT`;
          conn.release();
        })();
      },
    });
    const unsettled = await todo(MAKER, "PATCH", { id: t5, body: { custom: { state: "in_review" }, ...SUBMIT } });
    await release;
    const t5a = await taskInstance(t5);
    check("tasks: the service took the write but settling it fails: the answer says the task moved and its step follows later; the reservation is kept", unsettled.status === 200 && /its workflow step could not be updated just now/.test(unsettled.body?.workflow_note ?? "") && (await taskRow(t5))?.custom?.state === "in_review" && t5a.engine_state?.record_move?.to === "in_review" && stepOf(t5a, "prepare")?.state === "open", { unsettled, t5a: t5a?.engine_state });
    const busy = await todo(CHECKER, "PATCH", { id: t5, body: { custom: { state: "approved" }, reason: "complete" } });
    check("…a second mover meanwhile is told it is being moved (409 workflow_busy), and nothing is sent", busy.status === 409 && busy.body?.code === "workflow_busy" && (await taskRow(t5))?.custom?.state === "in_review", busy);
    await admin`UPDATE record_workflow_instances SET engine_state = jsonb_set(engine_state, '{record_move,at}', '"2000-01-01T00:00:00.000Z"') WHERE id = ${t5id0}`;
    const later = await todo(CHECKER, "PATCH", { id: t5, body: { custom: { state: "approved" }, reason: "complete" } });
    const t5b = await taskInstance(t5);
    check("…once the reservation is stale, the next read settles it by the task's state (the step moves as checked), then the next move goes through", later.status === 200 && stepOf(t5b, "prepare")?.state === "completed" && stepOf(t5b, "prepare")?.evidence?.[0]?.ref === SUBMIT.evidence && stepOf(t5b, "review")?.state === "completed" && t5b.terminal === true && !t5b.engine_state?.record_move, { later, steps: t5b?.steps });
  }

  if (MODE === "warn") {
    await create(MAKER, "W-1");
    const broke = await move(OTHER, "W-1", "in_review");
    const i1 = await instanceOf("W-1");
    const patched = (await eventsOf(i1)).find((e) => e.type === "step_patched" && e.source === "user");
    check('warn: a move that breaks the step\'s rules goes through, with its warning (not_holder, the comment)', broke.status === 200 && (await stateOf("W-1")) === "in_review" && broke.body?.warnings?.length === 1 && rules(broke.body.warnings[0]) === "not_holder,step_comment", broke);
    check("…its step changes as an administrative change naming the rules; the workflow's rules still open the review", stepOf(i1, "prepare")?.state === "completed" && patched?.data?.administrative === true && JSON.stringify(patched?.data?.rules) === JSON.stringify(["not_holder", "step_comment"]) && /^administrative change under enforce "warn"/.test(patched?.detail ?? "") && stepOf(i1, "review")?.status === true, { patched, steps: i1?.steps });
    check("…and the broken rule is in the activity feed", (await feed("W-1")).some((l) => l.startsWith(`${OTHER}: Lifecycle rule not followed (not_holder, step_comment)`) && l.includes('only whoever holds the step "Prepare"')), await feed("W-1"));
    await create(MAKER, "W-2");
    const clean = await move(MAKER, "W-2", "in_review", SUBMIT);
    const i2 = await instanceOf("W-2");
    check("warn: a move that keeps the rules carries no warning and changes its step as the holder's own", clean.status === 200 && !clean.body?.warnings && !(await eventsOf(i2)).some((e) => e.data?.administrative) && stepOf(i2, "prepare")?.state === "completed", clean);
  }

  if (MODE === "off") {
    const made = await create(MAKER, "O-1");
    const moved = await move(OTHER, "O-1", "in_review");
    check('off: the moves are today\'s (no step rule, no warning) and no instance is ever attached', made.status === 201 && moved.status === 200 && !moved.body?.warnings && (await stateOf("O-1")) === "in_review" && (await instanceCount(A)) === 0, { made, moved });
    const withEvidence = await move(MAKER, "O-1", "approved", { evidence: "doc://x" });
    check("off: `evidence` is no field of the record (today's 400), and nothing is written", withEvidence.status === 400 && /evidence/.test(withEvidence.body?.error ?? "") && (await stateOf("O-1")) === "in_review", withEvidence);
  }

  // ── workspace B ────────────────────────────────────────────────────────────────────────────────────────────────
  const anyKey = (await admin`SELECT entity_id FROM record_workflow_instances WHERE org_id = ${A} AND entity_type = 'deployments' ORDER BY entity_id LIMIT 1`)[0]?.entity_id ?? null;
  const anyA = anyKey ? decodeURIComponent(anyKey.split("/")[1]) : null;
  if (anyA) {
    const theirs = await call(BEN, "PATCH", { id: anyA, body: { customerId: CO, custom: { review_state: "approved" }, reason: "x" } });
    check("workspace B cannot move A's record (its own account of the same id holds no such record): 404", theirs.status === 404, theirs);
    const seen = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${B}, true)`;
      const [i] = await tx`SELECT count(*)::int AS n FROM record_workflow_instances WHERE org_id = ${A} OR entity_id = ${anyKey}`;
      const [e] = await tx`SELECT count(*)::int AS n FROM record_workflow_events WHERE org_id = ${A}`;
      return { instances: i.n, events: e.n };
    });
    check("workspace B sees none of A's instances or events under row-level security", seen.instances === 0 && seen.events === 0, seen);
    const ownMade = await call(BEN, "POST", { body: { ...BASE, deploymentId: anyA } });
    const ownInst = await instanceOf(anyA, B);
    const aInst = await instanceOf(anyA, A);
    check("workspace B attaches its own instance to its own record of the same id; A's is untouched", ownMade.status === 201 && ownInst && ownInst.id !== aInst.id && JSON.stringify(stepOf(ownInst, "prepare")?.assignee) === JSON.stringify([BEN]), { ownMade, ownInst: ownInst?.steps });
  } else {
    check("workspace B: nothing of A's to see (no instance was attached in this mode)", (await instanceCount(A)) === 0);
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${MODE}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await Promise.all([admin.end({ timeout: 2 }), holder.end({ timeout: 2 }), app.end({ timeout: 2 })]).catch(() => undefined);
}
console.log(`\nrecord-workflow-runtime-db-probe [${MODE}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
