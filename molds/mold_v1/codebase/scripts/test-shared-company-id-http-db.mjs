#!/usr/bin/env node
/**
 * TWO WORKSPACES CAN HOLD THE SAME COMPANY ID, over HTTP (mold_v1-118): the Ops API, the data room workbook route,
 * the record export and the hosted MCP endpoint, against `next start` of a real build, as the restricted app_rw
 * role under the production FAIL-CLOSED policies.
 *
 * One person, a member of two workspaces, creates `aditya-birla-hfl` in each (POST /api/ops/customers, and through
 * the MCP's customer_create), with its own deployment and implementation under the SAME ids, and:
 *
 *   1. both creates succeed (the second was a 500: "That record can't be changed from this workspace");
 *   2. every read answers with the asking workspace's record only: GET customers, deployments, implementations,
 *      tickets (list and by id), the workbook, the export, and the MCP's customer_list / deployment_list;
 *   3. an update in one (customers POST, deployments POST/PATCH, implementations POST/PATCH, tickets PATCH, the MCP's
 *      deployment_upsert) never changes the other's row;
 *   4. a delete in one (deployments DELETE, implementations DELETE) never removes the other's row;
 *   5. a record still cannot be created on an id only the other workspace holds (409, nothing written).
 *
 * Needs a production build in --dir (default: this checkout; CI reuses the relabelling build of the workbook step),
 * ADMIN_URL (seeding, policy DDL) and DATABASE_URL (app_rw). Without the URLs it skips. Rows live under throwaway
 * workspaces carrying this process's pid, removed in a finally block, and every policy is restored.
 *
 *   ADMIN_URL=… DATABASE_URL=… npm run test:shared-company-id-http-db [-- --dir <built checkout>]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { freePort, waitForNextStart } from "./lib/own-listener.mjs";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-shared-company-id-http-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : ROOT;
if (!existsSync(join(DIR, ".next", "BUILD_ID"))) {
  console.error(`test-shared-company-id-http-db: no production build in ${DIR}/.next — run \`npm run build\` first.`);
  process.exit(2);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}`}`); }
};

// The own fields the build's profile requires on a new row (the relabelling fixture declares some; the default none).
const { DEPLOYMENT_PROFILE: P } = await import(pathToFileURL(join(DIR, "lib/deployment-profile.generated.ts")).href);
const sample = (f) => (f.type === "pick_list" ? f.options[0] : f.type === "number" || f.type === "percent" ? 7 : f.type === "date" ? "2026-09-29" : f.type === "email" ? "x@example.com" : f.type === "link" ? "https://example.com/" : "text");
const requiredOf = (fields) => {
  const req = (fields ?? []).filter((f) => f.required);
  return req.length ? { custom: Object.fromEntries(req.map((f) => [f.key, sample(f)])) } : {};
};
const DEP_OWN = requiredOf(P.domains.deployments?.custom_fields);
const IMPL_OWN = requiredOf(P.domains.implementations?.custom_fields);
const ACCOUNT_OWN = requiredOf(P.account_fields?.custom_fields);

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const PID = process.pid;
const A = `org-shared-http-a-${PID}`;
const B = `org-shared-http-b-${PID}`;
const ALICE = `alice-${PID}@shared-http.test`;
const ID = "aditya-birla-hfl";
const ONLY_B = `shared-http-only-b-${PID}`;
const DEP = `Q2FY26-${PID}`;
const TCK = `TCK-shared-${PID}`;
const CHILDREN = ["platform", "deployments", "solutions", "implementation", "tickets", "interactions", "internal_staff", "customer_stakeholders"];

async function unseed() {
  for (const t of CHILDREN) await admin.unsafe(`delete from ${t} where org_id in ($1, $2)`, [A, B]).catch(() => {});
  await admin`delete from customers where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from automation_audit where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from entity_activity where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from org_members where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
}
const saved = new Map();
const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
const { mintSessionToken } = await import("../lib/auth-session.ts");
const token = await mintSessionToken(ALICE);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server;
let log = "";
async function start() {
  server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: url, AUTH_JWT_PUBLIC_KEY: process.env.AUTH_JWT_PUBLIC_KEY, AUTH_JWT_PRIVATE_KEY: "", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  await waitForNextStart({ server, port, log: () => log });
}
/** One call to the Ops API as alice, in the workspace named. */
const call = async (org, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-ops-org": org },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text };
};
let rpcId = 0;
/** One MCP tools/call as alice, in the workspace named; the tool's text parsed as JSON when it is. */
const mcp = async (org, name, args = {}) => {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-ops-org": org },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  const text = body?.result?.content?.map((c) => c.text).join("") ?? "";
  let value = null;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: res.status, isError: Boolean(body?.result?.isError || body?.error), value, raw: body };
};
const rowOf = async (table, org, extra = "") => (await admin.unsafe(`select * from ${table} where customer_id = $1 and org_id = $2 ${extra}`, [ID, org]));
const snapshot = async (org) => {
  const out = {};
  for (const t of ["customers", ...CHILDREN]) out[t] = await admin.unsafe(`select to_jsonb(x) - 'updated_at' as r from ${t} x where customer_id = $1 and org_id = $2 order by 1::text`, [ID, org]);
  return JSON.stringify(out);
};

try {
  await unseed();
  // The production policy shape: an unscoped read sees nothing (.migrate-rls-fail-closed.mjs).
  const policies = await admin`select tablename, qual from pg_policies where schemaname = 'public' and policyname = 'org_isolation'`;
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const { tablename, qual } of policies) {
    saved.set(tablename, qual);
    await admin.unsafe(`alter policy org_isolation on "${tablename}" using ${closed} with check ${closed}`);
  }
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Shared desk A', 'active'), (${B}, 'Shared desk B', 'active')`;
  await admin`insert into org_members (org_id, email, role, accepted_at) values (${A}, ${ALICE}, 'owner', now()), (${B}, ${ALICE}, 'owner', now())`;
  await start();

  console.log("1. Both workspaces create the same company id");
  const cA = await call(A, "POST", "/api/ops/customers", { customerId: ID, customerName: "ABHFL A desk", tier: "Tier-1", ...ACCOUNT_OWN });
  check("A creates it (POST /api/ops/customers)", cA.status === 201, cA);
  const cB = await mcp(B, "customer_create", { customerId: ID, customerName: "ABHFL B desk", tier: "Tier-2", ...ACCOUNT_OWN });
  check("B creates it too, through the MCP's customer_create (it was refused: the id was A's)", !cB.isError && cB.status === 200, cB.raw);
  const both = await admin`select org_id, customer_name from customers where customer_id = ${ID} and org_id in (${A}, ${B}) order by org_id`;
  check("…two rows, each workspace's own name", both.length === 2 && both[0].customer_name === "ABHFL A desk" && both[1].customer_name === "ABHFL B desk", both);

  for (const [org, v] of [[A, "A-v1"], [B, "B-v1"]]) {
    const d = await call(org, "POST", "/api/ops/deployments", { customerId: ID, deploymentId: DEP, environment: "prod", region: "ap-south-1", deployedVersion: v, notes: `${v} notes`, ...DEP_OWN });
    check(`${org === A ? "A" : "B"} creates deployment ${DEP} (the same id in both)`, d.status === 201, d);
    const i = await call(org, "POST", "/api/ops/implementations", { customerId: ID, implementationStage: "UAT", implementationOwnerEmail: `${org === A ? "a" : "b"}@shared-http.test`, ...IMPL_OWN });
    check(`${org === A ? "A" : "B"} creates its implementation record`, i.status === 201, i);
  }
  // The same ticket id in both workspaces, seeded as the owner (tickets have no create route; the agent opens them).
  for (const [org, who] of [[A, "A"], [B, "B"]]) {
    const seeded = await admin`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step)
      values (${org}, ${ID}, ${TCK}, ${`${who} ticket`}, 'Question', 'Feature Request', 'Open', 'P2-Medium', '2026-09-29', ${`${who.toLowerCase()}@shared-http.test`}, 'Email', '2026-09-29', 'look')`.then(() => null, (e) => e.message);
    check(`${who} holds ticket ${TCK} under the company (the same ticket id in both)`, seeded === null, seeded);
  }

  console.log("2. Every read answers with the asking workspace's record only");
  const has = (x, mine, theirs) => JSON.stringify(x).includes(mine) && !JSON.stringify(x).includes(theirs);
  const lA = await call(A, "GET", "/api/ops/customers");
  const lB = await call(B, "GET", "/api/ops/customers");
  check("GET customers: A sees A's name, B sees B's", has(lA.body, "ABHFL A desk", "ABHFL B desk") && has(lB.body, "ABHFL B desk", "ABHFL A desk"), { lA: lA.body, lB: lB.body });
  const dA = await call(A, "GET", "/api/ops/deployments");
  const dB = await call(B, "GET", "/api/ops/deployments");
  check("GET deployments: each its own version, and its own company name on the card", has(dA.body, "A-v1", "B-v1") && has(dA.body, "ABHFL A desk", "ABHFL B desk") && has(dB.body, "B-v1", "A-v1"), { dA: dA.body, dB: dB.body });
  const iA = await call(A, "GET", "/api/ops/implementations");
  check("GET implementations: A's owner only", has(iA.body, "a@shared-http.test", "b@shared-http.test"), iA.body);
  const tA = await call(A, "GET", "/api/ops/tickets");
  check("GET tickets: A's ticket only", has(tA.body, "A ticket", "B ticket"), tA.body);
  const t1 = await call(B, "GET", `/api/ops/tickets/${encodeURIComponent(TCK)}`);
  check("GET tickets/:id in B: B's ticket, with B's company name", t1.body?.found === true && has(t1.body, "B ticket", "A ticket") && has(t1.body, "ABHFL B desk", "ABHFL A desk"), t1.body);
  const wA = await call(A, "GET", "/api/ops/workbook");
  const wB = await call(B, "GET", "/api/ops/workbook");
  check("GET workbook: each workspace's workbook holds its own company and rows", wA.status === 200 && has(wA.body, "ABHFL A desk", "ABHFL B desk") && has(wA.body, "A-v1", "B-v1") && wB.status === 200 && has(wB.body, "ABHFL B desk", "ABHFL A desk") && has(wB.body, "B-v1", "A-v1"), { wA: JSON.stringify(wA.body).slice(0, 300) });
  const eA = await call(A, "GET", `/api/ops/export?type=deployment&id=${encodeURIComponent(DEP)}&customerId=${ID}`);
  const eB = await call(B, "GET", `/api/ops/export?type=implementation&id=${ID}&customerId=${ID}`);
  check("GET export (deployment) in A: A's record and A's company", eA.status === 200 && has(eA.body, "A-v1", "B-v1") && has(eA.body, "ABHFL A desk", "ABHFL B desk"), eA.body);
  check("GET export (implementation) in B: B's record and B's company", eB.status === 200 && has(eB.body, "b@shared-http.test", "a@shared-http.test") && has(eB.body, "ABHFL B desk", "ABHFL A desk"), eB.body);
  const mlA = await mcp(A, "customer_list");
  const mdB = await mcp(B, "deployment_list");
  check("MCP customer_list in A: A's company only", !mlA.isError && has(mlA.value, "ABHFL A desk", "ABHFL B desk"), mlA.raw);
  check("MCP deployment_list in B: B's deployment only", !mdB.isError && has(mdB.value, "B-v1", "A-v1"), mdB.raw);

  console.log("3. An update in one never changes the other's row");
  let bBefore = await snapshot(B);
  const u1 = await call(A, "POST", "/api/ops/customers", { customerId: ID, customerName: "ABHFL A desk (renamed)" });
  check("A renames its company (customers POST, an upsert)", u1.status === 200, u1);
  const u2 = await call(A, "POST", "/api/ops/deployments", { customerId: ID, deploymentId: DEP, deployedVersion: "A-v2" });
  check("A updates its deployment (deployments POST, the upsert deployment_upsert uses)", u2.status === 200 && u2.body?.updated === true, u2);
  const u3 = await call(A, "PATCH", `/api/ops/deployments/${encodeURIComponent(DEP)}`, { customerId: ID, healthStatus: "degraded" });
  check("A edits its deployment (deployments PATCH)", u3.status === 200, u3);
  const u4 = await call(A, "POST", "/api/ops/implementations", { customerId: ID, implementationOwnerEmail: "a2@shared-http.test" });
  check("A updates its implementation (implementations POST)", u4.status < 300, u4);
  const u5 = await call(A, "PATCH", `/api/ops/implementations/${ID}`, { customerId: ID, implementationRiskLevel: "Red" });
  check("A edits its implementation (implementations PATCH)", u5.status === 200, u5);
  const u6 = await call(A, "PATCH", `/api/ops/tickets/${encodeURIComponent(TCK)}`, { customerId: ID, ticketStatus: "Resolved" });
  check("A resolves its ticket (tickets PATCH)", u6.status === 200, u6);
  const u7 = await mcp(A, "deployment_upsert", { customerId: ID, deploymentId: DEP, deployedVersion: "A-v3" });
  check("A updates its deployment through the MCP's deployment_upsert", !u7.isError, u7.raw);
  const aDep = (await rowOf("deployments", A))[0];
  check("…A's rows carry every change", aDep?.deployed_version === "A-v3" && aDep?.health_status === "degraded" && (await rowOf("customers", A))[0]?.customer_name === "ABHFL A desk (renamed)" && (await rowOf("implementation", A))[0]?.implementation_risk_level === "Red" && (await rowOf("tickets", A))[0]?.ticket_status === "Resolved", aDep);
  check("…and B's company, deployment, implementation and ticket are byte-for-byte unchanged", (await snapshot(B)) === bBefore);

  console.log("4. A delete in one never removes the other's row");
  bBefore = await snapshot(B);
  const x1 = await call(A, "DELETE", `/api/ops/deployments/${encodeURIComponent(DEP)}?customerId=${ID}`);
  check("A deletes its deployment", x1.status === 200 && (await rowOf("deployments", A)).length === 0, x1);
  const x2 = await call(A, "DELETE", `/api/ops/implementations/${ID}?customerId=${ID}`);
  check("A deletes its implementation record", x2.status === 200 && (await rowOf("implementation", A)).length === 0, x2);
  check("…B's deployment and implementation with the same keys are still there, unchanged", (await rowOf("deployments", B)).length === 1 && (await rowOf("implementation", B)).length === 1 && (await snapshot(B)) === bBefore);

  console.log("5. A record still cannot be created on an id only the other workspace holds");
  await admin`insert into customers (customer_id, org_id, customer_name) values (${ONLY_B}, ${B}, 'Only B')`;
  const p1 = await call(A, "POST", "/api/ops/deployments", { customerId: ONLY_B, deploymentId: `planted-${PID}`, environment: "prod", region: "ap-south-1", deployedVersion: "x", ...DEP_OWN });
  const p2 = await call(A, "POST", "/api/ops/implementations", { customerId: ONLY_B, implementationStage: "UAT", ...IMPL_OWN });
  const p3 = await call(A, "PATCH", `/api/ops/tickets/${encodeURIComponent(TCK)}`, { customerId: ONLY_B, ticketStatus: "Closed" });
  const planted = await admin`select 'd' as t from deployments where customer_id = ${ONLY_B} union all select 'i' from implementation where customer_id = ${ONLY_B}`;
  check("deployments / implementations POST on B's id from A: 409, nothing written", p1.status === 409 && p2.status === 409 && planted.length === 0, { p1: p1.status, p2: p2.status, planted });
  check("tickets PATCH naming B's id from A: refused", p3.status >= 400, p3);
} finally {
  server?.kill("SIGTERM");
  for (const [t, qual] of saved) await admin.unsafe(`alter policy org_isolation on "${t}" using (${qual}) with check (${qual})`).catch(() => {});
  await unseed();
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-shared-company-id-http-db: ${failures.length} failed, ${passed} passed`);
  if (log && process.env.SHOW_SERVER_LOG) console.error(log.slice(-4000));
  process.exit(1);
}
console.log(`\ntest-shared-company-id-http-db: all ${passed} checks passed`);
