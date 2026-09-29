#!/usr/bin/env node
/**
 * `deployment_upsert` UPDATES AN EXISTING RECORD (mold_v1-089), over HTTP against `next start` of a real build, as the
 * restricted app_rw role under row-level security.
 *
 * The MCP tool `deployment_upsert` posts to POST /api/ops/deployments, which was a plain INSERT: a coding agent could
 * create a deployment record and never correct one (a second call for the same id was a unique-key error), so a
 * wrong version or status could only be fixed in the console. Now:
 *
 *   1. a new (customerId, deploymentId) is created as before (201, the identity fields required, defaults applied);
 *   2. the same key again UPDATES that record (200): only the fields the body names change, nothing is defaulted
 *      back ("healthy" / "deployed" were create defaults), "" clears an optional field;
 *   3. `custom` changes only by the keys named, merged in SQL onto what is stored (the rest of the row's own values
 *      are kept), and is checked by the shared validator (an undeclared key is a 400, nothing written);
 *   4. an update naming nothing is a 400, and another workspace's record is never reached.
 *
 * Needs a production build in --dir (default: this checkout; CI reuses the relabelling build of the step before),
 * ADMIN_URL (seeding) and DATABASE_URL (app_rw). Without the URLs it skips. Its rows live under throwaway workspaces
 * carrying this process's pid, removed in a finally block.
 *
 *   ADMIN_URL=… DATABASE_URL=… npm run test:deployment-upsert-db [-- --dir <built checkout>]
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
  console.log("test-deployment-upsert-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : ROOT;
if (!existsSync(join(DIR, ".next", "BUILD_ID"))) {
  console.error(`test-deployment-upsert-db: no production build in ${DIR}/.next — run \`npm run build\` first.`);
  process.exit(2);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`}`); }
};

// The own fields the build's profile declares on the area (the relabelling fixture declares some; the default none).
const { DEPLOYMENT_PROFILE: P } = await import(pathToFileURL(join(DIR, "lib/deployment-profile.generated.ts")).href);
const OWN = P.domains.deployments?.custom_fields ?? [];
const sample = (f) => (f.type === "pick_list" ? f.options[0] : f.type === "number" || f.type === "percent" ? 7 : f.type === "date" ? "2026-09-29" : f.type === "email" ? "x@example.com" : f.type === "link" ? "https://example.com/" : "text");
const REQUIRED_OWN = Object.fromEntries(OWN.filter((f) => f.required).map((f) => [f.key, sample(f)]));
const OPTIONAL_OWN = OWN.filter((f) => !f.required && (f.type === "number" || f.type === "percent" || f.type === "text"));
// The implementation area's required own fields, sent only if the stored row lacks them (it does not: seeded bare).
const IMPL_OWN = (P.domains.implementations?.custom_fields ?? []).filter((f) => f.required);
const REQUIRED_IMPL_OWN = IMPL_OWN.length ? Object.fromEntries(IMPL_OWN.map((f) => [f.key, sample(f)])) : null;

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const W1 = `dup-a-${process.pid}`;
const W2 = `dup-b-${process.pid}`;
const ALICE = `alice-${process.pid}@dup.test`;
const C1 = `dup-c1-${process.pid}`;
const C2 = `dup-c2-${process.pid}`;
const D = `Q2FY26-${process.pid}`;

async function unseed() {
  await admin`delete from deployments where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from implementation where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from customers where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from org_members where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from orgs where org_id in (${W1}, ${W2})`.catch(() => {});
}
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
const post = async (body) => {
  const res = await fetch(`${base}/api/ops/deployments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text };
};
const row = async (customer = C1) => (await admin`select * from deployments where customer_id = ${customer} and deployment_id = ${D}`)[0] ?? null;

try {
  await unseed();
  await admin`insert into orgs (org_id, name, status) values (${W1}, 'Upsert A', 'active'), (${W2}, 'Upsert B', 'active')`;
  await admin`insert into org_members (org_id, email, role, accepted_at) values (${W1}, ${ALICE}, 'owner', now())`;
  await admin`insert into customers (customer_id, org_id, customer_name) values (${C1}, ${W1}, 'Upsert Co'), (${C2}, ${W2}, 'Other Co')`;
  await admin`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, notes)
              values (${W2}, ${C2}, ${D}, 'prod', 'ap-south-1', 'theirs', 'deployed', 'healthy', 'theirs')`;
  await start();

  console.log("1. create");
  const created = await post({ customerId: C1, deploymentId: D, environment: "prod", region: "ap-south-1", deployedVersion: "Q2 FY26", deployOwnerEmail: "a@example.com", notes: "first", ...(OWN.length ? { custom: REQUIRED_OWN } : {}) });
  check("a new record is created (201)", created.status === 201 && (await row()) !== null, created);
  check("…with the create defaults", (await row())?.release_status === "deployed" && (await row())?.health_status === "healthy");

  console.log("2. the same key again updates it");
  const updated = await post({ customerId: C1, deploymentId: D, deployedVersion: "Q2 FY26 (restated)", healthStatus: "degraded" });
  const r = await row();
  check("the second call is an update (200), not a unique-key error", updated.status === 200 && updated.body?.updated === true, updated);
  check("…the named fields changed", r?.deployed_version === "Q2 FY26 (restated)" && r?.health_status === "degraded", r);
  check("…the rest is kept: owner, note, environment, release status (not defaulted back)", r?.deploy_owner_email === "a@example.com" && r?.notes === "first" && r?.environment === "prod" && r?.release_status === "deployed", r);
  await post({ customerId: C1, deploymentId: D, notes: "" });
  check('"" clears an optional field', (await row())?.notes === null);
  const nothing = await post({ customerId: C1, deploymentId: D });
  check("an update naming nothing is a 400", nothing.status === 400, nothing);

  console.log("3. own fields");
  if (OPTIONAL_OWN.length && OWN.length) {
    const f = OPTIONAL_OWN[0];
    const before = (await row()).custom;
    const res = await post({ customerId: C1, deploymentId: D, custom: { [f.key]: sample(f) } });
    const after = (await row()).custom;
    check(`custom changes only by the key named (${f.key}); the stored ones are kept`, res.status === 200 && after[f.key] === sample(f) && Object.entries(before).every(([k, v]) => k === f.key || after[k] === v), { res, before, after });
  } else console.log("  --   (this build's profile declares no optional own field to change)");
  const bad = await post({ customerId: C1, deploymentId: D, custom: { no_such_field: 1 } });
  check("an undeclared own field is a 400, nothing written", bad.status === 400 && /no_such_field/.test(JSON.stringify(bad.body)), bad);

  console.log("3b. the ops edit (PATCH) merges own values in SQL too");
  if (OPTIONAL_OWN.length) {
    const f = OPTIONAL_OWN[0];
    let lost = 0;
    for (let i = 1; i <= 20; i++) {
      const res = await Promise.all([
        fetch(`${base}/api/ops/deployments/${encodeURIComponent(D)}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ customerId: C1, custom: { [f.key]: f.type === "text" ? `v${i}` : i } }) }),
        admin`update deployments set custom = custom || jsonb_build_object('zz_note', ${`round ${i}`}::text) where customer_id = ${C1} and deployment_id = ${D}`,
      ]);
      const c = (await row()).custom;
      if (res[0].status !== 200 || c.zz_note !== `round ${i}` || String(c[f.key]) !== String(f.type === "text" ? `v${i}` : i)) lost++;
    }
    check(`a value saved while the detail card edits another is kept (20 rounds, lost ${lost})`, lost === 0, `${lost} of 20`);
  } else console.log("  --   (this build's profile declares no optional own field to change)");

  console.log("3c. implementation_upsert on an existing rollout keeps what it does not name");
  await admin`insert into implementation (org_id, customer_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner)
              values (${W1}, ${C1}, 'UAT', 60, 'Red', 'None')`;
  const impl = await fetch(`${base}/api/ops/implementations`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ customerId: C1, implementationOwnerEmail: "owner@example.com", ...(REQUIRED_IMPL_OWN ? { custom: REQUIRED_IMPL_OWN } : {}) }) });
  const [ir] = await admin`select implementation_stage, implementation_progress_pct, implementation_risk_level, implementation_owner_email from implementation where customer_id = ${C1}`;
  check("its stage, progress and risk are not reset to the create defaults", impl.status < 300 && ir.implementation_stage === "UAT" && ir.implementation_progress_pct === 60 && ir.implementation_risk_level === "Red" && ir.implementation_owner_email === "owner@example.com", { status: impl.status, ir });

  console.log("4. workspaces");
  const theirs = await post({ customerId: C2, deploymentId: D, deployedVersion: "mine now" });
  check("another workspace's record is never updated", (await row(C2))?.deployed_version === "theirs" && theirs.status === 409, theirs);
  const planted = await post({ customerId: C2, deploymentId: `planted-${process.pid}`, environment: "prod", region: "ap-south-1", deployedVersion: "x", ...(OWN.length ? { custom: REQUIRED_OWN } : {}) });
  check("…nor can a record be created on another workspace's account", planted.status === 409 && !(await admin`select 1 from deployments where deployment_id = ${`planted-${process.pid}`}`).length, planted);
  // The same for implementation_upsert (POST /api/ops/implementations): its foreign key is also checked past RLS.
  const implPlant = await fetch(`${base}/api/ops/implementations`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ customerId: C2, implementationStage: "UAT", ...(REQUIRED_IMPL_OWN ? { custom: REQUIRED_IMPL_OWN } : {}) }) });
  const implRows = await admin`select org_id from implementation where customer_id = ${C2}`;
  check("…nor an implementation record on another workspace's account (implementation_upsert)", implPlant.status === 409 && implRows.length === 0, { status: implPlant.status, implRows });
  const absent = await post({ customerId: `nobody-${process.pid}`, deploymentId: D, environment: "prod", region: "ap-south-1", deployedVersion: "x" });
  check("…and an absent account reads the same: create it first (409)", absent.status === 409 && /Create the/.test(absent.body?.error ?? ""), absent);
} finally {
  server?.kill("SIGTERM");
  await unseed();
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-deployment-upsert-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-deployment-upsert-db: all ${passed} checks passed`);
