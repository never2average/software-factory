/**
 * ONE WORKSPACE CANNOT REACH ANOTHER'S RECORD BY ID, AGAINST A FAIL-CLOSED POSTGRES.
 *
 * The defect: getCustomer(id, orgId) read the record across EVERY workspace, then asked in the caller's scope
 * which workspace owned it. Under the production fail-closed policy that second read cannot see another
 * workspace's row, so it came back empty, `row?.orgId && row.orgId !== orgId` was false, and the other
 * workspace's whole record was returned — to get_customer, the account report and the workbook builder.
 *
 * The same shape, one layer out, sat under every by-id WRITE the model can call: the workspace was taken from the
 * record (orgForCustomer), never from the caller, and orgForCustomer itself reads on the bare handle, which under
 * fail-closed sees nothing and answers the DEFAULT workspace for every id. So a caller anywhere could log
 * interactions, reassign owners, open/resolve/promote tickets and read follow-ups on the default workspace's
 * accounts, while every other workspace could not do those things to its own.
 *
 * And the refusal leaked too: upsertCustomer merged the other workspace's record into the patch, the database
 * refused the write, and drizzle's error text carried every merged value back to the model.
 *
 * For each by-id reader/writer: workspace B asking for workspace A's id gets nothing (null / "Unknown customer" /
 * not found / []), A's record is unchanged, and the owner still gets its record. A is the default workspace (the
 * one the old fallback resolved every id to, so the leak is live there) and a second, ordinary workspace Y (where
 * the owner itself was locked out).
 *
 * It flips every org_isolation policy to the production FAIL-CLOSED shape (bootstrap-test-db builds the permissive
 * one the isolation test needs) and restores each exactly afterwards. Rows live under pid-suffixed ids and are
 * removed in a finally block. Needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw); without them it skips.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:cross-workspace-db
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-cross-workspace-reads-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
const scratch = mkdtempSync(path.join(tmpdir(), "xws-test-"));
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
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
/** Run `fn`; the error it throws (or null when it did not throw). */
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

const PID = process.pid;
const { DEFAULT_ORG } = await import("../agent/lib/org-context.ts");
const A = DEFAULT_ORG; // the default workspace: the one the old fallback resolved every id to
const Y = `org-xws-owner-${PID}`; // an ordinary workspace
const B = `org-xws-other-${PID}`; // the caller that must see nothing of A's or Y's
const X = `xws-acct-${PID}`; // A's account
const YX = `xws-yacct-${PID}`; // Y's account
const SECRET_NAME = `Confidential Holdings ${PID}`;
const SECRET_REASON = `covenant breach under review ${PID}`;
const CONTACT = `treasurer-${PID}@xws-probe.test`;
const DOMAIN = `xws-${PID}.test`;
const NOW = "2026-09-24T12:00:00Z";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customers.fixture.json", import.meta.url), "utf8"));
const base = fixture.customers.find((c) => c.id === "acme-bank");
/** A fixture account under a new id: scalar fields, its tickets and interactions; no platform/deployment rows. */
const account = (id, name, reason, contact, domain) => {
  const { platform: _p, deployments: _d, solutions: _s, implementation: _i, ...scalar } = base;
  return {
    ...scalar,
    id,
    name,
    healthReason: reason,
    businessOwnerEmail: contact,
    technicalOwnerEmail: undefined,
    executiveSponsorEmail: undefined,
    companyDomain: domain,
    tickets: base.tickets.map((t) => ({ ...t, ticketId: `${t.ticketId}-${id}`, externalId: undefined })),
    interactions: base.interactions.map((i) => ({ ...i, interactionId: `${i.interactionId}-${id}` })),
  };
};
const OPEN_TICKET = `${base.tickets.find((t) => !["Resolved", "Closed", "Won't Fix"].includes(t.ticketStatus)).ticketId}-${X}`;
const interaction = (id) => ({
  interactionId: id,
  interactionAt: "2026-09-24",
  interactionType: "note",
  sourceSystem: "manual",
  note: `probe ${id}`,
});
const newTicket = (customerId, ticketId) => ({
  ticketId,
  customerId,
  summary: "probe ticket",
  ticketType: "Question",
  ticketCategory: "Feature Request",
  ticketPriority: "P3-Low",
  ticketOwnerEmail: "owner@xws-probe.test",
  ticketNextStep: "look",
  externalId: `ext-${ticketId}`,
});

const insertedOrgs = [];
const saved = new Map();
let closeDb = null;
const cleanup = async () => {
  await admin`DELETE FROM internal_staff WHERE customer_id IN (${X}, ${YX})`.catch(() => undefined);
  await admin`DELETE FROM customers WHERE customer_id IN (${X}, ${YX})`.catch(() => undefined);
  await admin`DELETE FROM agent_session_scopes WHERE session_id LIKE ${`%-${PID}`}`.catch(() => undefined);
};

try {
  const probe = postgres(appUrl, { ssl, prepare: false, max: 1 });
  const [{ rolbypassrls, rolsuper, current_user: who }] = await probe`
    SELECT r.rolbypassrls, r.rolsuper, current_user FROM pg_roles r WHERE r.rolname = current_user`;
  await probe.end();
  console.log(`\nConnected as ${who}`);
  // A role that bypasses RLS makes every assertion below vacuously true.
  assert.ok(!rolbypassrls && !rolsuper, `${who} bypasses RLS — this test would prove nothing`);

  // The production shape (.migrate-rls-fail-closed.mjs) on EVERY org_isolation policy, not a chosen few: the
  // defect is a read that the production policy answers differently from the permissive one.
  const policies = await admin`SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  assert.ok(policies.length > 0, "no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const { tablename, qual } of policies) {
    saved.set(tablename, qual);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);

  for (const [id, name] of [[A, "Default workspace"], [Y, "Owner probe"], [B, "Other probe"]]) {
    const [row] = await admin`INSERT INTO orgs (org_id, name, status) VALUES (${id}, ${name}, 'active') ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
    if (row) insertedOrgs.push(id);
  }
  await cleanup();

  const db = await import("../agent/lib/db/index.ts");
  closeDb = db.closeDb;
  const sor = await import("../agent/lib/system-of-record.ts");
  const { renderAccountReport, renderDataroomSummary } = await import("../agent/lib/render-html.ts");
  const { buildCustomerWorkbookSpecs, buildDomainWorkbookSpec } = await import("../agent/lib/workbook-spec.ts");

  // Seeded through the real write path, in each owner's own scope.
  await sor.upsertCustomer(account(X, SECRET_NAME, SECRET_REASON, CONTACT, DOMAIN), A);
  await sor.upsertCustomer(account(YX, `Y Holdings ${PID}`, "ordinary", `cfo-${PID}@y-probe.test`, `y-${PID}.test`), Y);
  const [seeded] = await admin`SELECT org_id FROM customers WHERE customer_id = ${X} AND org_id = ${A}`;
  assert.equal(seeded?.org_id, A, "the probe account must be seeded in the default workspace");
  // A's company by its whole key (org_id, customer_id): another workspace may hold the same id (mold_v1-118).
  const snapshot = async () =>
    JSON.stringify(await admin`SELECT c.customer_name, c.health_reason, c.fde_owner,
      (SELECT count(*) FROM interactions i WHERE i.customer_id = c.customer_id AND i.org_id = c.org_id)::int AS interactions,
      (SELECT json_agg(json_build_array(t.ticket_id, t.ticket_status) ORDER BY t.ticket_id) FROM tickets t WHERE t.customer_id = c.customer_id AND t.org_id = c.org_id) AS tickets
      FROM customers c WHERE c.customer_id = ${X} AND c.org_id = ${A}`);
  const before = await snapshot();

  console.log("\n1. getCustomer — the reported leak");
  check("B asking for A's id gets null", (await sor.getCustomer(X, B)) === null);
  check("B asking for Y's id gets null", (await sor.getCustomer(YX, B)) === null);
  check("A still gets its own record", (await sor.getCustomer(X, A))?.name === SECRET_NAME);
  check("Y still gets its own record", (await sor.getCustomer(YX, Y))?.id === YX);
  check("A asking for Y's id gets null (and the reverse)", (await sor.getCustomer(YX, A)) === null && (await sor.getCustomer(X, Y)) === null);

  console.log("\n2. upsertCustomer — the merge that leaked through the refusal text");
  // A company is keyed by (org_id, customer_id) (mold_v1-118): B patching an id it does not hold creates B's OWN
  // company of that id. What #58 closed must stay closed: nothing of A's is merged into B's write or its answer,
  // and A's record is untouched.
  let upOut = null;
  const upErr = await errorOf(async () => { upOut = await sor.upsertCustomer({ id: X, healthReason: `from B ${PID}` }, B); });
  const upText = `${upErr ? `${messageOf(upErr)} ${String(upErr)} ${JSON.stringify(upErr)}` : ""} ${JSON.stringify(upOut ?? {})}`;
  check("B patching A's id never reaches A's record: it is B's own company of that id", upErr === null && upOut?.id === X && upOut.name === X && upOut.healthReason === `from B ${PID}`, upText.slice(0, 300));
  check("…and neither its answer nor any error carries A's values", !upText.includes(SECRET_NAME) && !upText.includes(SECRET_REASON) && !upText.includes(CONTACT), upText.slice(0, 400));
  check("…nor the statement and its parameters", !/Failed query|params:/.test(upText), upText.slice(0, 200));
  check("…and A's record is unchanged", (await snapshot()) === before);
  const bRows = await admin`SELECT org_id, customer_name FROM customers WHERE customer_id = ${X} ORDER BY org_id`;
  check("…two companies of the id now, each in its own workspace", bRows.length === 2 && bRows.some((r) => r.org_id === A && r.customer_name === SECRET_NAME) && bRows.some((r) => r.org_id === B && r.customer_name === X), bRows);
  // Back to B holding nothing of the id: the refusals below are of writes into a company B does not hold.
  await admin`DELETE FROM customers WHERE customer_id = ${X} AND org_id = ${B}`;

  console.log("\n3. recordInteraction / recordInteractions");
  check("B logging onto A's id is refused as an unknown customer", /Unknown customer/.test(messageOf(await errorOf(() => sor.recordInteraction(X, interaction(`INT-b1-${PID}`), B)))));
  check("B batch-logging onto A's id is refused", /Unknown customer/.test(messageOf(await errorOf(() => sor.recordInteractions(X, [interaction(`INT-b2-${PID}`)], B)))));
  check("…and A has no interaction from B", (await snapshot()) === before);
  const mine = await sor.recordInteraction(X, interaction(`INT-a1-${PID}`), A).catch((e) => e);
  check("A logs onto its own account and reads it back", mine?.id === X && mine.interactions?.some((i) => i.interactionId === `INT-a1-${PID}`), messageOf(mine));
  const yMine = await sor.recordInteractions(YX, [interaction(`INT-y1-${PID}`)], Y).catch((e) => e);
  check("Y logs onto its own account (it could not: the workspace came from the default fallback)", yMine?.id === YX, messageOf(yMine));
  const afterOwnerWrites = await snapshot();

  console.log("\n4. reassignOwner");
  check("B reassigning A's account is refused", /Unknown customer/.test(messageOf(await errorOf(() => sor.reassignOwner(X, `b-${PID}@xws-probe.test`, "B", B)))));
  check("…and A's owner is unchanged", (await snapshot()) === afterOwnerWrites);
  const own = await sor.reassignOwner(YX, `y-owner-${PID}@y-probe.test`, "Y owner", Y).catch((e) => e);
  check("Y reassigns its own account", own?.newOwner === `y-owner-${PID}@y-probe.test`, messageOf(own));

  console.log("\n5. createTicket / setTicketStatus / resolveFollowUp");
  check("B opening a ticket on A's account is refused", /Unknown customer/.test(messageOf(await errorOf(() => sor.createTicket(newTicket(X, `TCK-b-${PID}`), B)))));
  check("B promoting A's ticket is refused as not found", /not found/.test(messageOf(await errorOf(() => sor.setTicketStatus(X, OPEN_TICKET, "Open", B)))));
  check("B resolving A's follow-up is refused as not found", /not found/.test(messageOf(await errorOf(() => sor.resolveFollowUp(X, OPEN_TICKET, B)))));
  check("…and A's tickets are unchanged", (await snapshot()) === afterOwnerWrites);
  const yTicket = await sor.createTicket(newTicket(YX, `TCK-y-${PID}`), Y).catch((e) => e);
  check("Y opens a ticket on its own account", yTicket?.created === true, messageOf(yTicket));
  const yPromote = await sor.setTicketStatus(YX, `TCK-y-${PID}`, "Open", Y).catch((e) => e);
  check("Y promotes its own ticket", yPromote?.ticketStatus === "Open", messageOf(yPromote));
  const yResolve = await sor.resolveFollowUp(YX, `TCK-y-${PID}`, Y).catch((e) => e);
  check("Y resolves its own follow-up", yResolve?.ticketStatus === "Resolved", messageOf(yResolve));
  const aTicket = await sor.createTicket(newTicket(X, `TCK-a-${PID}`), A).catch((e) => e);
  check("A opens a ticket on its own account", aTicket?.created === true, messageOf(aTicket));

  console.log("\n6. listFollowUps (list_followups with a customer id)");
  check("B listing A's account's follow-ups gets none", (await sor.listFollowUps(X, B)).length === 0);
  check("B listing every follow-up sees none of A's or Y's", (await sor.listFollowUps(undefined, B)).length === 0);
  check("A lists its own", (await sor.listFollowUps(X, A)).some((f) => f.ticketId === OPEN_TICKET));

  console.log("\n7. matchCustomerByEmail (match_customer_by_email, run_email_intake)");
  check("B matching A's contact email does not match", (await sor.matchCustomerByEmail(CONTACT, B)).matched === false);
  check("B matching A's company domain does not match", (await sor.matchCustomerByEmail(`someone@${DOMAIN}`, B)).matched === false);
  const aMatch = await sor.matchCustomerByEmail(CONTACT, A);
  check("A matches its own contact", aMatch.matched === true && aMatch.customerId === X);

  console.log("\n8. render_account_report and build_workbook_spec");
  check("B rendering A's account report is refused", /Unknown customer/.test(messageOf(await errorOf(() => renderAccountReport({ customerId: X, now: NOW, orgId: B })))));
  const aReport = await renderAccountReport({ customerId: X, now: NOW, orgId: A }).catch((e) => e);
  check("A renders its own", typeof aReport === "string" && aReport.includes(SECRET_NAME), messageOf(aReport));
  const bIndex = await renderDataroomSummary({ now: NOW, orgId: B });
  check("B's data-room index lists none of A's or Y's accounts", !bIndex.includes(SECRET_NAME) && !bIndex.includes(`Y Holdings ${PID}`));
  check("A's data-room index lists its own", (await renderDataroomSummary({ now: NOW, orgId: A })).includes(SECRET_NAME));
  check("B building A's workbooks is refused", /Unknown customer/.test(messageOf(await errorOf(() => buildCustomerWorkbookSpecs({ customerId: X, now: NOW, orgId: B })))));
  check("B building one of A's workbooks is refused", /Unknown customer/.test(messageOf(await errorOf(() => buildDomainWorkbookSpec({ customerId: X, domain: "Tickets", now: NOW, orgId: B })))));
  const aBooks = await buildCustomerWorkbookSpecs({ customerId: X, now: NOW, orgId: A }).catch((e) => e);
  check("A builds its own", Array.isArray(aBooks) && aBooks.length > 0, messageOf(aBooks));

  console.log("\n9. A failed query's error names no values (every surface prints this text)");
  const { getDb, withOrgDb } = db;
  const { customers } = await import("../agent/lib/db/schema.ts");
  const dupErr = await errorOf(() =>
    withOrgDb(A, (tx) => tx.insert(customers).values({ customerId: X, orgId: A, customerName: `dup ${SECRET_REASON}` })),
  );
  const dupText = dupErr ? `${messageOf(dupErr)} ${String(dupErr)} ${JSON.stringify(dupErr)}` : "";
  check("a refused write throws", dupErr !== null);
  check("…a plain sentence, without the statement or the values", dupErr !== null && !dupText.includes(SECRET_REASON) && !/Failed query|params:|insert into/i.test(dupText), dupText.slice(0, 300));
  check("…and the SQLSTATE survives for callers that branch on it (lib/pg-error.ts)", dupErr?.code === "23505" && dupErr?.cause?.code === "23505", { code: dupErr?.code });
  const rlsErr = await errorOf(() =>
    withOrgDb(B, (tx) => tx.insert(customers).values({ customerId: `xws-rls-${PID}`, orgId: A, customerName: SECRET_NAME })),
  );
  const rlsText = rlsErr ? `${messageOf(rlsErr)} ${String(rlsErr)} ${JSON.stringify(rlsErr)}` : "";
  check("a write outside the caller's workspace is refused (42501) with no values in the text", rlsErr?.code === "42501" && !rlsText.includes(SECRET_NAME), rlsText.slice(0, 300));
  void getDb;

  console.log("\n10. Service-started turns keep their workspace (a schedule rule, a front-end workflow step)");
  // What the turn's tools see: eve's schedule appAuth, and the front-end's Vercel OIDC service principal, each
  // naming the workspace it acts for in the `workspace_scope` attribute (agent/lib/service-scope.ts). Built by hand
  // here, as eve hands them over, so this fails on a build that does not honour the attribute.
  const { orgForSession } = await import("../agent/lib/org-context.ts");
  const { recordSessionScope } = await import("../agent/lib/session-scope.ts");
  const FE_SUBJECT = "owner:f20170061g-3183s-projects:project:fde-agent:environment:production";
  const scheduleCtx = (org) => ({
    session: { id: `sess-sched-${org}-${PID}`, auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: { workspace_scope: org } } } },
  });
  const frontEndCtx = (org) => ({
    session: {
      id: `sess-oidc-${org}-${PID}`,
      auth: {
        current: {
          // The front-end's PRODUCTION token, as eve's vercelOidc hands it over.
          authenticator: "oidc",
          issuer: "https://oidc.vercel.com/f20170061g-3183s-projects",
          principalId: `https://oidc.vercel.com/f20170061g-3183s-projects:${FE_SUBJECT}`,
          principalType: "service",
          subject: FE_SUBJECT,
          attributes: { environment: "production", ...(org ? { workspace_scope: org } : {}) },
        },
      },
    },
  });
  const schedOrgA = await orgForSession(scheduleCtx(A)).catch((e) => messageOf(e));
  check("a schedule turn for A resolves to A (it resolved to an empty workspace)", schedOrgA === A, schedOrgA);
  const schedTicket = `TCK-sched-${PID}`;
  await sor.createTicket(newTicket(X, schedTicket), A);
  const promoted = await sor.setTicketStatus(X, schedTicket, "Open", schedOrgA).catch((e) => e);
  check("…so promote_ticket in a scheduled turn promotes A's ticket", promoted?.ticketStatus === "Open", messageOf(promoted));
  const resolvedBySchedule = await sor.resolveFollowUp(X, schedTicket, schedOrgA).catch((e) => e);
  check("…resolve_followup resolves it", resolvedBySchedule?.ticketStatus === "Resolved", messageOf(resolvedBySchedule));
  const scheduledMatch = await sor.matchCustomerByEmail(CONTACT, schedOrgA);
  check("…and the email-intake rule's match_customer_by_email matches A's sender", scheduledMatch.matched === true && scheduledMatch.customerId === X);
  const oidcOrgY = await orgForSession(frontEndCtx(Y)).catch((e) => messageOf(e));
  check("a front-end workflow/app/cron step for Y resolves to Y", oidcOrgY === Y, oidcOrgY);
  check("…and cannot see A's record from there", (await sor.getCustomer(X, oidcOrgY)) === null);
  const ghost = await orgForSession(scheduleCtx(`org-does-not-exist-${PID}`)).catch((e) => messageOf(e));
  check("a service naming a workspace that does not exist does not get it", ghost !== `org-does-not-exist-${PID}`, ghost);
  const person = {
    session: { id: `sess-person-${PID}`, auth: { current: { authenticator: "oidc", issuer: "https://accounts.google.com", principalId: `someone-${PID}@b-probe.test`, principalType: "user", attributes: { email: `someone-${PID}@b-probe.test`, hd: "b-probe.test", workspace_scope: A } } } },
  };
  const personOrg = await orgForSession(person).catch((e) => messageOf(e));
  check("a PERSON's token carrying the attribute is not given that workspace", personOrg !== A, personOrg);
  const rootId = `sess-root-sched-${PID}`;
  await recordSessionScope(rootId, A, undefined, { service: true });
  const childOrg = await orgForSession({ session: { id: `sess-child-${PID}`, parent: { rootSessionId: rootId, sessionId: rootId } } }).catch((e) => messageOf(e));
  check("a specialist the scheduled turn delegates to inherits A", childOrg === A, childOrg);
  await admin`DELETE FROM agent_session_scopes WHERE session_id = ${rootId}`.catch(() => undefined);

  // A continuation carrying only inputResponses (an approval answer) skips eve.ts onMessage, so it arrives without
  // the attribute. The session recorded its workspace when it started; the same trusted service gets that back.
  const contId = `sess-cont-${PID}`;
  await recordSessionScope(contId, Y, undefined, { service: true });
  const bare = frontEndCtx(null);
  const continued = await orgForSession({ session: { ...bare.session, id: contId } }).catch((e) => messageOf(e));
  check("a front-end continuation without the attribute acts in the workspace its session recorded", continued === Y, continued);
  const previewCont = await orgForSession({
    session: { id: contId, auth: { current: { authenticator: "oidc", issuer: "https://oidc.vercel.com/f20170061g-3183s-projects", principalType: "service", subject: "owner:f20170061g-3183s-projects:project:fde-agent-api:environment:preview", attributes: { environment: "preview", workspace_scope: Y } } } },
  }).catch((e) => messageOf(e));
  check("…while the agent project's PREVIEW token gets neither the attribute nor the recorded scope", previewCont !== Y, previewCont);

  console.log("\n11. A system path names its workspace: a company id no longer names one (mold_v1-118)");
  const sysNone = await sor.recordInteraction(YX, interaction(`INT-sys-${PID}`), undefined).catch((e) => e);
  check("a system write with no workspace is refused, never sent to 'whoever holds the id'", sysNone instanceof Error && /workspace/i.test(sysNone.message), messageOf(sysNone));
  check("…and nothing was written", (await admin`SELECT count(*)::int AS n FROM interactions WHERE interaction_id = ${`INT-sys-${PID}`}`)[0].n === 0);
  const sysY = await sor.recordInteraction(YX, interaction(`INT-sys-${PID}`), Y).catch((e) => e);
  const [sysRow] = await admin`SELECT org_id FROM interactions WHERE interaction_id = ${`INT-sys-${PID}`}`;
  check("a system write naming Y lands in Y's account, stamped with Y", sysY?.id === YX && sysRow?.org_id === Y, messageOf(sysY));
  check("an EMPTY workspace is refused, never widened to the owner's", (await errorOf(() => sor.recordInteraction(X, interaction(`INT-empty-${PID}`), ""))) !== null && (await errorOf(() => sor.recordInteraction(X, interaction(`INT-null-${PID}`), null))) !== null);
} catch (error) {
  failures++;
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
  for (const id of insertedOrgs) await admin`DELETE FROM orgs WHERE org_id = ${id}`.catch(() => undefined);
  for (const [t, qual] of saved) {
    // Put each policy back exactly as it was found: the other isolation checks expect the permissive shape.
    await admin.unsafe(`ALTER POLICY org_isolation ON "${t}" USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\ntest-cross-workspace-reads-db: all ${passed} assertions passed against a fail-closed Postgres`
    : `\ntest-cross-workspace-reads-db: ${failures} FAILED, ${passed} passed`,
);
process.exit(failures === 0 ? 0 : 1);
