#!/usr/bin/env node
/**
 * TWO WORKSPACES CAN HOLD THE SAME COMPANY ID (mold_v1-118), through the agent's own write and read paths, as the
 * restricted app_rw role against the production FAIL-CLOSED policies.
 *
 * A company is keyed by (org_id, customer_id). It used to be keyed by customer_id alone, so workspace B could not
 * create an id workspace A already used: the write hit A's row, which B's scope cannot see or change, and was refused
 * ("can't be changed from this workspace"). Two research desks covering the same listed company (both onfinance-ai and
 * icici-hfc need `aditya-birla-hfl`) could not both hold it.
 *
 * For one id held by two workspaces, each with its own record in EVERY part (platform, deployments, solutions,
 * implementation, tickets, interactions, internal staff) and the SAME nested row ids in both:
 *
 *   1. both create it, and each record reads back as its own (system of record + every agent tool that reads it:
 *      get_customer, list_customers, list_followups, list_urgent_tickets, list_triage_tickets, list_stale_customers,
 *      match_customer_by_email, render_account_report, build_workbook_spec);
 *   2. every update in one (a patch, a nested row, an interaction, a ticket and its status, an owner) never touches
 *      the other;
 *   3. every delete in one (a nested row by `remove`, the company itself with its cascade) never touches the other;
 *   4. writing INTO another workspace's company is still impossible: a nested row cannot be planted under an id only
 *      the other workspace holds (the database refuses it: the foreign key now carries the workspace), and a by-id
 *      write naming an id the caller does not hold is still "Unknown account";
 *   5. a system path must name its workspace: an id no longer names one, and no list widens to every workspace.
 *
 * Needs ADMIN_URL (policy DDL, seeding orgs) and DATABASE_URL (app_rw); without them it skips. Rows live under
 * pid-suffixed workspaces, removed in a finally block, and every policy is restored exactly.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:shared-company-id-db
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// eve's `.js` -> `.ts` specifiers (agent/lib/tools.ts is imported as the agent imports it), as test-agent-vocabulary.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(s, c, n) {
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          throw e;
        }
      }`),
  pathToFileURL(process.cwd() + "/").href,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-shared-company-id-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
const scratch = mkdtempSync(path.join(tmpdir(), "shared-id-test-"));
process.env.DATAROOM_DIR = path.join(scratch, "dataroom");

const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${what}`);
  } else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}`}`);
  }
};
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
const messageOf = (e) => (e instanceof Error ? e.message : String(e ?? ""));

const PID = process.pid;
const A = `org-shared-a-${PID}`;
const B = `org-shared-b-${PID}`;
const ID = "aditya-birla-hfl"; // the operator's own case: both desks cover it
const ONLY_A = `shared-only-a-${PID}`; // an id only A holds
const NOW = "2026-09-29T12:00:00Z";
const TABLES = ["platform", "deployments", "solutions", "implementation", "tickets", "interactions", "internal_staff", "customer_stakeholders"];

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customers.fixture.json", import.meta.url), "utf8"));
const base = fixture.customers.find((c) => c.id === "acme-bank");
/**
 * The same company as each desk records it: every part present, the SAME nested ids (DEP/SOL/TCK/INT/ROLL) in both,
 * and each desk's own values, so a read that mixes the two, or a write that reaches the other, shows.
 */
const record = (desk) => ({
  ...base,
  id: ID,
  name: `Aditya Birla Housing Finance (${desk} desk)`,
  healthReason: `${desk}: coverage initiated`,
  // Active and never touched, so both appear in the stale sweep; each desk's own contact and domain.
  lifecycleStage: "Onboarding",
  businessOwnerEmail: `cfo-${desk.toLowerCase()}-${PID}@abhfl-probe.test`,
  technicalOwnerEmail: undefined,
  executiveSponsorEmail: undefined,
  companyDomain: `${desk.toLowerCase()}-${PID}.abhfl-probe.test`,
  platform: { ...base.platform, primaryModel: `${desk}-model` },
  deployments: base.deployments.map((d) => ({ ...d, deployedVersion: `${desk}-Q2FY26`, notes: `${desk} deployment` })),
  solutions: base.solutions.map((s) => ({ ...s, businessProcess: `${desk} process` })),
  implementation: { ...base.implementation, blocker: `${desk} blocker`, custom: undefined },
  tickets: base.tickets.map((t) => ({
    ...t,
    summary: `${desk}: ${t.summary}`,
    externalId: undefined,
    // One urgent open ticket and one triage draft per desk, same ids in both.
    ...(t.ticketId === base.tickets[0].ticketId ? { ticketPriority: "P0-Critical", ticketStatus: "Open" } : {}),
    ...(t.ticketId === base.tickets[1].ticketId ? { ticketStatus: "Needs Triage" } : {}),
  })),
  interactions: base.interactions.map((i) => ({ ...i, note: `${desk} interaction`, interactionAt: "2020-01-01" })),
});
const DEP = base.deployments[0].deploymentId;
const TCK = base.tickets[0].ticketId;
const TRIAGE = base.tickets[1].ticketId;

const saved = new Map();
let closeDb = null;
const cleanup = async () => {
  for (const t of TABLES) await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  await admin`DELETE FROM customers WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
};

try {
  const probe = postgres(appUrl, { ssl, prepare: false, max: 1 });
  const [{ rolbypassrls, rolsuper, current_user: who }] = await probe`
    SELECT r.rolbypassrls, r.rolsuper, current_user FROM pg_roles r WHERE r.rolname = current_user`;
  await probe.end();
  console.log(`\nConnected as ${who}`);
  if (rolbypassrls || rolsuper) throw new Error(`${who} bypasses RLS — this test would prove nothing`);

  const policies = await admin`SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const { tablename, qual } of policies) {
    saved.set(tablename, qual);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Shared id desk A', 'active'), (${B}, 'Shared id desk B', 'active') ON CONFLICT (org_id) DO NOTHING`;
  await cleanup();

  const db = await import("../agent/lib/db/index.ts");
  closeDb = db.closeDb;
  const sor = await import("../agent/lib/system-of-record.ts");
  const tools = await import("../agent/lib/tools.ts");
  const { renderAccountReport } = await import("../agent/lib/render-html.ts");
  const { buildCustomerWorkbookSpecs } = await import("../agent/lib/workbook-spec.ts");
  const { customers, deployments } = await import("../agent/lib/db/schema.ts");
  const { and, eq } = await import("drizzle-orm");
  // A turn acting for a workspace, as eve hands a scheduled turn over (agent/lib/service-scope.ts).
  const ctxFor = (org) => ({
    session: { id: `sess-shared-${org}`, auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: { workspace_scope: org } } } },
  });
  const count = async (table, org) => (await admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id = $1 AND org_id = $2`, [ID, org]))[0].n;
  /** Everything one desk holds for the id, as the database has it: a write in the other must leave this identical. */
  const snapshot = async (org) => {
    const out = {};
    out.customers = await admin`SELECT customer_name, health_reason, fde_owner, status FROM customers WHERE customer_id = ${ID} AND org_id = ${org}`;
    for (const t of TABLES) out[t] = await admin.unsafe(`SELECT to_jsonb(x) - 'created_at' - 'updated_at' AS r FROM ${t} x WHERE customer_id = $1 AND org_id = $2 ORDER BY 1::text`, [ID, org]);
    return JSON.stringify(out);
  };

  console.log("\n1. Both workspaces create the same company id, each with its own record");
  const aMade = await sor.upsertCustomer(record("A"), A).catch((e) => e);
  check("A creates aditya-birla-hfl", aMade?.id === ID && aMade.name.includes("(A desk)"), messageOf(aMade));
  const bMade = await sor.upsertCustomer(record("B"), B).catch((e) => e);
  check("B creates aditya-birla-hfl too (it was refused: the id was A's)", bMade?.id === ID && bMade.name.includes("(B desk)"), messageOf(bMade));
  const rows = await admin`SELECT org_id FROM customers WHERE customer_id = ${ID} AND org_id IN (${A}, ${B}) ORDER BY org_id`;
  check("…two company rows, one per workspace", rows.length === 2 && rows[0].org_id === A && rows[1].org_id === B, rows);
  for (const t of ["platform", "deployments", "solutions", "implementation", "tickets", "interactions"]) {
    const [na, nb] = [await count(t, A), await count(t, B)];
    check(`…${t}: each workspace has its own rows under the same ids (${na} + ${nb})`, na > 0 && na === nb, { na, nb });
  }

  console.log("\n2. Each sees only its own, through every read the agent has");
  const aRead = await sor.getCustomer(ID, A);
  const bRead = await sor.getCustomer(ID, B);
  const onlyDesk = (rec, desk) => {
    const text = JSON.stringify(rec ?? null);
    const other = desk === "A" ? "B" : "A";
    return Boolean(rec) && text.includes(`(${desk} desk)`) && !text.includes(`${other} desk`) && !text.includes(`${other}-Q2FY26`) && !text.includes(`${other} interaction`) && !text.includes(`${other}: `);
  };
  check("getCustomer(A) is A's record, nothing of B's in any part", onlyDesk(aRead, "A") && aRead.deployments?.length === 1 && aRead.interactions?.length === 1, aRead && { deployments: aRead.deployments, interactions: aRead.interactions });
  check("getCustomer(B) is B's record, nothing of A's in any part", onlyDesk(bRead, "B") && bRead.deployments?.length === 1 && bRead.tickets?.length === base.tickets.length, bRead && { deployments: bRead.deployments });
  const toolOut = async (tool, input, org) => (await tool.execute(input, ctxFor(org)).catch((e) => ({ error: messageOf(e) })));
  const gA = await toolOut(tools.getCustomerTool, { id: ID }, A);
  const gB = await toolOut(tools.getCustomerTool, { id: ID }, B);
  check("get_customer in A returns A's; in B returns B's", onlyDesk(gA.customer, "A") && onlyDesk(gB.customer, "B"), { gA: JSON.stringify(gA).slice(0, 200), gB: JSON.stringify(gB).slice(0, 200) });
  const lA = await toolOut(tools.listCustomersTool, {}, A);
  check("list_customers in A lists it once, as A's", lA.customers?.filter((c) => c.id === ID).length === 1 && lA.customers.find((c) => c.id === ID).name.includes("(A desk)"), lA);
  const fA = await toolOut(tools.listFollowupsTool, { customerId: ID }, A);
  check("list_followups in A: only A's open tickets", fA.followUps?.length > 0 && fA.followUps.every((f) => f.summary.startsWith("A: ")), fA);
  const uA = await toolOut(tools.listUrgentTicketsTool, {}, A);
  const uB = await toolOut(tools.listUrgentTicketsTool, {}, B);
  const mineOnly = (rows, desk) => {
    const ours = (rows ?? []).filter((t) => t.customerId === ID);
    return ours.length > 0 && ours.every((t) => t.summary.startsWith(`${desk}: `));
  };
  check("list_urgent_tickets in A: A's only (B's carry the same ticket ids under the same company id)", mineOnly(uA.urgentTickets, "A") && uA.urgentTickets.some((t) => t.ticketId === TCK), uA);
  check("list_urgent_tickets in B: B's only", mineOnly(uB.urgentTickets, "B") && uB.urgentTickets.some((t) => t.ticketId === TCK), uB);
  const tA = await toolOut(tools.listTriageTicketsTool, {}, A);
  check("list_triage_tickets in A: A's draft only", mineOnly(tA.triageTickets, "A") && tA.triageTickets.filter((t) => t.customerId === ID).length === 1, tA);
  const sA = await toolOut(tools.listStaleCustomersTool, { days: 30 }, A);
  check("list_stale_customers in A: the id once, with A's name", sA.staleCustomers?.filter((c) => c.customerId === ID).length === 1 && sA.staleCustomers.find((c) => c.customerId === ID).customerName.includes("(A desk)"), sA);
  const mA = await toolOut(tools.matchCustomerByEmailTool, { sender: `cfo-a-${PID}@abhfl-probe.test` }, A);
  const mBofA = await toolOut(tools.matchCustomerByEmailTool, { sender: `cfo-a-${PID}@abhfl-probe.test` }, B);
  check("match_customer_by_email: A's contact matches in A, not in B", mA.matched === true && mA.customerName?.includes("(A desk)") && mBofA.matched === false, { mA, mBofA });
  const repA = await renderAccountReport({ customerId: ID, now: NOW, orgId: A }).catch((e) => e);
  const repB = await renderAccountReport({ customerId: ID, now: NOW, orgId: B }).catch((e) => e);
  check("render_account_report: each workspace's report is its own", typeof repA === "string" && repA.includes("(A desk)") && !repA.includes("B desk") && typeof repB === "string" && repB.includes("(B desk)") && !repB.includes("A desk"), messageOf(repA).slice(0, 200));
  const wbA = await buildCustomerWorkbookSpecs({ customerId: ID, now: NOW, orgId: A }).catch((e) => e);
  check("build_workbook_spec: A's workbooks carry A's values only", Array.isArray(wbA) && JSON.stringify(wbA).includes("A-Q2FY26") && !JSON.stringify(wbA).includes("B-Q2FY26"), messageOf(wbA));

  console.log("\n3. Updates in one never touch the other");
  let bBefore = await snapshot(B);
  const patched = await sor.upsertCustomer({ id: ID, healthReason: "A: rating change", deployments: [{ deploymentId: DEP, deployedVersion: "A-Q3FY26" }], implementation: { blocker: "A: new blocker" } }, A).catch((e) => e);
  check("A patches its account, a deployment row and the implementation", patched?.healthReason === "A: rating change" && patched.deployments?.[0]?.deployedVersion === "A-Q3FY26", messageOf(patched));
  check("…B's record is byte-for-byte unchanged", (await snapshot(B)) === bBefore);
  const logged = await sor.recordInteraction(ID, { interactionId: `INT-a-${PID}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "A only" }, A).catch((e) => e);
  check("A logs an interaction", logged?.interactions?.some((i) => i.interactionId === `INT-a-${PID}`), messageOf(logged));
  const same = await sor.recordInteractions(ID, [{ interactionId: `INT-a-${PID}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "B, same id" }], B).catch((e) => e);
  check("B logs an interaction with the SAME interaction id (its own row)", same?.interactions?.some((i) => i.interactionId === `INT-a-${PID}` && i.note === "B, same id"), messageOf(same));
  const note = await admin`SELECT org_id, note FROM interactions WHERE customer_id = ${ID} AND interaction_id = ${`INT-a-${PID}`} ORDER BY org_id`;
  check("…two rows, each workspace's own note", note.length === 2 && note[0].note === "A only" && note[1].note === "B, same id", note);
  bBefore = await snapshot(B);
  const aTicket = await sor.createTicket({ ticketId: `TCK-new-${PID}`, customerId: ID, summary: "A: new", ticketType: "Question", ticketCategory: "Feature Request", ticketPriority: "P3-Low", ticketOwnerEmail: "a@abhfl-probe.test", ticketNextStep: "look", externalId: `ext-${PID}` }, A).catch((e) => e);
  check("A opens a ticket", aTicket?.created === true, messageOf(aTicket));
  const promoted = await sor.setTicketStatus(ID, TRIAGE, "Open", A).catch((e) => e);
  check("A promotes its triage draft", promoted?.ticketStatus === "Open", messageOf(promoted));
  const resolved = await sor.resolveFollowUp(ID, TCK, A).catch((e) => e);
  check("A resolves its P0", resolved?.ticketStatus === "Resolved", messageOf(resolved));
  const owner = await sor.reassignOwner(ID, `new-owner-${PID}@abhfl-probe.test`, "A owner", A).catch((e) => e);
  check("A reassigns the owner", owner?.newOwner === `new-owner-${PID}@abhfl-probe.test`, messageOf(owner));
  check("…B's record is unchanged by all four", (await snapshot(B)) === bBefore);
  const bTicket = await sor.createTicket({ ticketId: `TCK-new-${PID}`, customerId: ID, summary: "B: new", ticketType: "Question", ticketCategory: "Feature Request", ticketPriority: "P3-Low", ticketOwnerEmail: "b@abhfl-probe.test", ticketNextStep: "look", externalId: `ext-${PID}` }, B).catch((e) => e);
  check("B opens a ticket with the same ticket id and external id: created, not taken for A's", bTicket?.created === true, messageOf(bTicket));
  const bTriage = (await sor.getCustomer(ID, B))?.tickets?.find((t) => t.ticketId === TRIAGE);
  check("B's triage draft is still a draft, its P0 still open", bTriage?.ticketStatus === "Needs Triage" && (await sor.getCustomer(ID, B))?.tickets?.find((t) => t.ticketId === TCK)?.ticketStatus === "Open");
  const staff = await admin`SELECT org_id, email FROM internal_staff WHERE customer_id = ${ID} AND org_id IN (${A}, ${B})`;
  check("the new owner is on A's staff only", staff.length === 1 && staff[0].org_id === A, staff);
  const bOwner = await sor.reassignOwner(ID, `new-owner-${PID}@abhfl-probe.test`, "B owner", B).catch((e) => e);
  check("B assigns the same person: its own staff row (the key carries the workspace)", bOwner?.newOwner && (await admin`SELECT count(*)::int AS n FROM internal_staff WHERE customer_id = ${ID} AND org_id IN (${A}, ${B})`)[0].n === 2, messageOf(bOwner));
  // An ops-style scoped statement keyed only by the company id, inside A's scope, still reaches A's row alone.
  bBefore = await snapshot(B);
  await db.withOrgDb(A, (tx) => tx.update(customers).set({ status: "At Risk" }).where(and(eq(customers.orgId, A), eq(customers.customerId, ID))));
  check("a scoped UPDATE in A changes A's row only", (await admin`SELECT status FROM customers WHERE customer_id = ${ID} AND org_id = ${A}`)[0]?.status === "At Risk" && (await snapshot(B)) === bBefore);

  console.log("\n4. Deletes in one never touch the other");
  bBefore = await snapshot(B);
  const removed = await sor.upsertCustomer({ id: ID, deployments: [{ deploymentId: DEP, remove: true }] }, A).catch((e) => e);
  check("A removes its deployment row", removed?.id === ID && !removed.deployments?.length, messageOf(removed));
  check("…B's deployment with the same id is still there, unchanged", (await count("deployments", B)) === 1 && (await snapshot(B)) === bBefore);
  const gone = await db.withOrgDb(A, (tx) => tx.delete(customers).where(and(eq(customers.orgId, A), eq(customers.customerId, ID))).returning({ id: customers.customerId }));
  check("A deletes the company itself", gone.length === 1);
  const left = {};
  for (const t of TABLES) left[t] = await count(t, A);
  check("…its every part goes with it (the cascade follows the workspace)", Object.values(left).every((n) => n === 0), left);
  check("…and B's company and every part of it are untouched", (await snapshot(B)) === bBefore && (await sor.getCustomer(ID, B))?.name.includes("(B desk)"));
  check("…A reads no company, B still reads its own", (await sor.getCustomer(ID, A)) === null && onlyDesk(await sor.getCustomer(ID, B), "B"));

  console.log("\n5. Writing into another workspace's company is still impossible");
  await sor.upsertCustomer({ ...record("A"), id: ONLY_A, name: `Only A ${PID}` }, A);
  const planted = await errorOf(() =>
    db.withOrgDb(B, (tx) => tx.insert(deployments).values({ orgId: B, customerId: ONLY_A, deploymentId: `SQUAT-${PID}`, environment: "prod", region: "x", deployedVersion: "v", releaseStatus: "deployed", healthStatus: "healthy" })),
  );
  check("a nested row B stamps with its own workspace under A's id is refused by the database (no parent in B)", planted?.code === "23503" || planted?.cause?.code === "23503", { code: planted?.code ?? planted?.cause?.code, message: messageOf(planted).slice(0, 160) });
  check("…nothing was planted", (await admin`SELECT count(*)::int AS n FROM deployments WHERE customer_id = ${ONLY_A} AND org_id = ${B}`)[0].n === 0);
  const aOnlyBefore = JSON.stringify(await admin`SELECT customer_name, health_reason FROM customers WHERE customer_id = ${ONLY_A}`);
  check("B logging onto an id only A holds is 'Unknown account'", /Unknown account/.test(messageOf(await errorOf(() => sor.recordInteraction(ONLY_A, { interactionId: `INT-x-${PID}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "x" }, B)))));
  check("B opening a ticket on it is 'Unknown account'", /Unknown account/.test(messageOf(await errorOf(() => sor.createTicket({ ticketId: `TCK-x-${PID}`, customerId: ONLY_A, summary: "x", ticketType: "Question", ticketCategory: "Feature Request", ticketPriority: "P3-Low", ticketOwnerEmail: "b@x.test", ticketNextStep: "x" }, B)))));
  check("B reassigning it is 'Unknown account'", /Unknown account/.test(messageOf(await errorOf(() => sor.reassignOwner(ONLY_A, "b@x.test", "B", B)))));
  check("B resolving its ticket is 'not found'", /not found/.test(messageOf(await errorOf(() => sor.resolveFollowUp(ONLY_A, TCK, B)))));
  check("…and A's company is unchanged", JSON.stringify(await admin`SELECT customer_name, health_reason FROM customers WHERE customer_id = ${ONLY_A}`) === aOnlyBefore);

  console.log("\n6. A system path names its workspace: an id no longer names one");
  const sys = await errorOf(() => sor.recordInteraction(ID, { interactionId: `INT-sys-${PID}`, interactionAt: "2026-09-29", interactionType: "note", sourceSystem: "manual", note: "system" }, undefined));
  check("a by-id write with no workspace is refused, never guessed from the id", sys !== null && /workspace/i.test(messageOf(sys)), messageOf(sys));
  check("…and nothing was written anywhere", (await admin`SELECT count(*)::int AS n FROM interactions WHERE interaction_id = ${`INT-sys-${PID}`}`)[0].n === 0);
  check("getCustomer with no workspace is refused rather than merging two workspaces' records", (await errorOf(() => sor.getCustomer(ID))) !== null);
  // Workspaces are not aware of each other: no list widens to every workspace when none is named.
  for (const [what, fn] of [
    ["listCustomers", () => sor.listCustomers(undefined)],
    ["listCustomers('')", () => sor.listCustomers("")],
    ["matchCustomerByEmail", () => sor.matchCustomerByEmail(`cfo-b-${PID}@abhfl-probe.test`, undefined)],
    ["listFollowUps(id)", () => sor.listFollowUps(ID, undefined)],
    ["listFollowUps()", () => sor.listFollowUps()],
    ["listStaleCustomers", () => sor.listStaleCustomers(30)],
    ["listUrgentTickets", () => sor.listUrgentTickets()],
    ["listTriageTickets", () => sor.listTriageTickets()],
  ]) {
    const e = await errorOf(fn);
    check(`${what} with no workspace is refused, never widened to every workspace`, e !== null && /workspace/i.test(messageOf(e)), messageOf(e) || "returned rows");
  }
} catch (error) {
  failures++;
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
  await admin`DELETE FROM customers WHERE customer_id = ${ONLY_A}`.catch(() => undefined);
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
  for (const [t, qual] of saved) {
    await admin.unsafe(`ALTER POLICY org_isolation ON "${t}" USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ntest-shared-company-id-db: all ${passed} assertions passed against a fail-closed Postgres`
    : `\ntest-shared-company-id-db: ${failures} FAILED, ${passed} passed`,
);
process.exit(failures === 0 ? 0 : 1);
