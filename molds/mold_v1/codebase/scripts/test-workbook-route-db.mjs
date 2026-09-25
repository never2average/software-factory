#!/usr/bin/env node
/**
 * THE DATA ROOM'S RECORDS, AS THE ROUTE SERVES THEM, AGAINST A FAIL-CLOSED POSTGRES.
 *
 * GET /api/ops/workbook is what every Master.xlsx preview is built from (it replaced the bundled sample records,
 * mold_v1-120). Its review (PR #62) found five things a person or the network pays for, each asserted here over HTTP
 * against `next start` of a real build, signed in with a locally minted email-session token, as the restricted app_rw
 * role under row-level security:
 *
 *   1. PAYLOAD: an account's whole `custom` blob went out on every open (a 2 MB note made a 2,000,466-byte answer),
 *      and interaction notes uncapped. Only the own fields the profile LISTS (show_in_list) go out, as
 *      /api/ops/customers sends them, and long text is cut to a preview, marked as cut.
 *   2. ONE TABLE IS ONE TABLE: a missing or failing table answered EMPTY for the whole workspace (the data room then
 *      said "No companies yet" over real records). A table that cannot be read is named in `unavailable`; the rest
 *      are served.
 *   3. HIDDEN FIELDS: the profile's hidden fields (account_fields.hidden, the areas' hidden fields) are not in the
 *      answer. Asserted for whatever the built profile hides: CI builds this under the relabelling profile
 *      (scripts/fixtures/agent-vocabulary/50-relabelled.json, the hfc-research pack's), which hides 26.
 *   4. CAPS SAY SO: past the per-table cap the answer flags `tables.<t>.truncated` and keeps the MOST RECENT rows.
 *   5. `Cache-Control: private, no-store` on this route and on /api/ops/customers; and another workspace's rows never.
 *
 * Needs a production build in --dir (default: this checkout), ADMIN_URL (seeding, DDL) and DATABASE_URL (app_rw).
 * Without the URLs it skips. Its rows live under two throwaway workspaces carrying this process's pid, removed in a
 * finally block, and every grant or rename it makes is put back.
 *
 *   ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/fde_test \
 *   DATABASE_URL=postgres://app_rw:…@127.0.0.1:5432/fde_test npm run test:workbook-route-db [-- --dir <built checkout>]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-workbook-route-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : ROOT;
if (!existsSync(join(DIR, ".next", "BUILD_ID"))) {
  console.error(`test-workbook-route-db: no production build in ${DIR}/.next — run \`npm run build\` first.`);
  process.exit(2);
}

let passed = 0;
const failures = [];
/** Each item is reported on its own, so one broken rule does not hide the others. */
const check = (label, condition, detail) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`}`);
  }
};

/* ------------------------------------------------------------------------------------ the profile it was built with */

const { DEPLOYMENT_PROFILE: P } = await import(pathToFileURL(join(DIR, "lib/deployment-profile.generated.ts")).href);
const hiddenOf = (fields) => Object.entries(fields ?? {}).filter(([, f]) => f?.hidden).map(([k]) => k);
const HIDDEN = {
  account: (P.account_fields?.hidden ?? []).filter((k) => k !== "id" && k !== "name"),
  deployments: hiddenOf(P.domains.deployments?.fields),
  implementation: hiddenOf(P.domains.implementations?.fields),
};
const listed = (area) => ((area === "account" ? P.account_fields?.custom_fields : P.domains[area]?.custom_fields) ?? []).filter((f) => f.show_in_list).map((f) => f.key);

/* ------------------------------------------------------------------------------------ seed */

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const W1 = `wb-a-${process.pid}`;
const W2 = `wb-b-${process.pid}`;
const ALICE = `alice-${process.pid}@w1.test`;
const C1 = `wb-c1-${process.pid}`;
const C2 = `wb-c2-${process.pid}`;
const C3 = `wb-c3-${process.pid}`;
const INTERACTIONS = 5010; // past the route's per-table cap of 5,000
const BIG_NOTE = "N".repeat(2_000_000);

async function seed() {
  await admin`insert into orgs (org_id, name, status) values (${W1}, 'Workbook A', 'active'), (${W2}, 'Workbook B', 'active')`;
  await admin`insert into org_members (org_id, email, role, accepted_at) values (${W1}, ${ALICE}, 'owner', now())`;
  await admin`insert into customers (customer_id, org_id, customer_name, tier, status, arr, seats, ae_owner, renewal_date, custom)
              values (${C1}, ${W1}, 'Wb Alpha Co', 'Enterprise', 'On Track', 1234567, 99, 'ae@w1.test', '2027-01-01',
                      ${admin.json({ notes: BIG_NOTE, house_view: "Positive" })}),
                     (${C2}, ${W1}, 'Wb Beta Co', 'Growth', 'At Risk', null, null, null, null, null),
                     (${C3}, ${W2}, 'Wb Other Secret', 'Growth', 'On Track', 777, 7, null, null, null)`;
  await admin`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status, deployment_strategy, custom)
              values (${W1}, ${C1}, ${`d1-${process.pid}`}, 'prod', 'ap-south-1', 'Q2 FY26', 'deployed', 'healthy', 'rolling',
                      ${admin.json({ rating: "Buy", target_price: 1234, kpi_completeness: 80, aum_cr: 5000 })})`;
  await admin`insert into implementation (org_id, customer_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, security_review_status, custom)
              values (${W1}, ${C1}, 'UAT', 10, 'Green', 'None', 'Approved', ${admin.json({ coverage_priority: "Core", next_review: "2026-10-01" })})`;
  // 5,010 interactions a minute apart; the NEWEST (i = 5010) carries a 5,000-character note.
  await admin`insert into interactions (org_id, customer_id, interaction_id, interaction_at, interaction_type, source_system, note)
              select ${W1}, ${C1}, 'wbi-' || ${String(process.pid)} || '-' || i,
                     to_char(timestamp '2026-01-01' + (i || ' minutes')::interval, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'call', 'manual', case when i = ${INTERACTIONS} then repeat('L', 5000) else 'n' end
              from generate_series(1, ${INTERACTIONS}) as i`;
  await admin`insert into internal_staff (org_id, customer_id, staff_role, name, employer_org, email)
              values (${W1}, ${C1}, 'solution_engineer', 'Wb Staff', 'Workbook A', 'staff@w1.test')`;
}

async function unseed() {
  for (const t of ["interactions", "tickets", "deployments", "implementation", "internal_staff", "customer_stakeholders", "platform", "solutions"]) {
    await admin.unsafe(`delete from ${t} where org_id in ($1, $2)`, [W1, W2]).catch(() => {});
  }
  await admin`delete from customers where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from org_members where org_id in (${W1}, ${W2})`.catch(() => {});
  await admin`delete from orgs where org_id in (${W1}, ${W2})`.catch(() => {});
}

/* ------------------------------------------------------------------------------------ the server */

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); s.on("error", rej); });

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
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/onboard`)).status < 500) return; } catch { /* not up yet */ }
    if (i > 240 || server.exitCode !== null) throw new Error(`next start did not come up:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const get = async (path) => {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, bytes: Buffer.byteLength(text), cache: res.headers.get("cache-control") ?? "", body };
};

/* ------------------------------------------------------------------------------------ run */

try {
  await unseed();
  await seed();
  await start();

  const r = await get("/api/ops/workbook");
  const c1 = r.body?.customers?.find((c) => c.id === C1);
  check("the workbook answers 200 with the workspace's accounts", r.status === 200 && Boolean(c1), { status: r.status });

  console.log("1. payload");
  // The whole answer also carries 5,000 interactions (~0.7 MB), so the note is measured where it lives: on the account.
  const accountBytes = c1 ? JSON.stringify({ ...c1, interactions: undefined }).length : Infinity;
  check(`the account with a 2 MB note is small: ${accountBytes.toLocaleString("en-US")} bytes < 10,000`, accountBytes < 10_000);
  check(`the whole answer is less than the note alone: ${r.bytes.toLocaleString("en-US")} bytes < 2,000,000`, r.bytes < 2_000_000);
  check("an own field the profile does not list (notes) is not sent", !(c1?.custom && "notes" in c1.custom), c1?.custom && Object.keys(c1.custom));
  for (const k of listed("account")) check(`a listed own field (${k}) is sent`, c1?.custom?.[k] !== undefined, c1?.custom);
  const dep = c1?.deployments?.[0];
  for (const k of listed("deployments")) check(`a listed deployment own field (${k}) is sent`, !HIDDEN.account.includes("deployments") && dep?.custom?.[k] !== undefined, dep?.custom);
  check("an unlisted deployment own field (aum_cr) is not sent", !(dep?.custom && "aum_cr" in dep.custom) || listed("deployments").includes("aum_cr"), dep?.custom);
  const newest = c1?.interactions?.find((i) => i.interactionId === `wbi-${process.pid}-${INTERACTIONS}`);
  check("a long note is cut to a preview", typeof newest?.note === "string" && newest.note.length <= 600, newest?.note?.length);
  check("…and marked as cut", Array.isArray(newest?._truncated) && newest._truncated.includes("note"), newest && Object.keys(newest));

  console.log("3. hidden fields");
  const leakedAccount = HIDDEN.account.filter((k) => c1 && k in c1);
  check(`none of the ${HIDDEN.account.length} hidden account fields is in the answer`, c1 && leakedAccount.length === 0, leakedAccount);
  const leakedDep = HIDDEN.deployments.filter((k) => dep && k in dep);
  check(`none of the ${HIDDEN.deployments.length} hidden deployment fields is in the answer`, !dep || leakedDep.length === 0, leakedDep);
  const impl = c1?.implementation;
  const leakedImpl = HIDDEN.implementation.filter((k) => impl && k in impl);
  check(`none of the ${HIDDEN.implementation.length} hidden implementation fields is in the answer`, !impl || leakedImpl.length === 0, leakedImpl);

  console.log("4. caps");
  check("a table past the cap is flagged truncated", r.body?.tables?.interactions?.truncated === true, r.body?.tables?.interactions);
  check("…and keeps the most recent rows (the newest interaction is there)", Boolean(newest));
  check("a table under the cap is not flagged", r.body?.tables?.customers?.truncated === false, r.body?.tables?.customers);

  console.log("5. cache and workspace");
  check("the workbook is Cache-Control: private, no-store", /private/.test(r.cache) && /no-store/.test(r.cache), r.cache);
  const list = await get("/api/ops/customers");
  check("the account list is Cache-Control: private, no-store", /private/.test(list.cache) && /no-store/.test(list.cache), list.cache);
  check("another workspace's account is not in the answer", !JSON.stringify(r.body ?? {}).includes("Wb Other Secret"));

  console.log("2. one table is one table");
  await admin.unsafe("revoke select on public.deployments from app_rw");
  const failing = await get("/api/ops/workbook");
  await admin.unsafe("grant select on public.deployments to app_rw");
  check("a table that fails to read does not fail the workspace (200)", failing.status === 200, { status: failing.status, body: failing.body });
  check("…its accounts are still served", Boolean(failing.body?.customers?.find((c) => c.id === C1)));
  check("…and the failed table is named unavailable, not served empty", (failing.body?.unavailable ?? []).includes("deployments"), failing.body?.unavailable);

  await admin.unsafe("alter table public.internal_staff rename to internal_staff_gone_wb");
  let missing;
  try {
    missing = await get("/api/ops/workbook");
  } finally {
    await admin.unsafe("alter table public.internal_staff_gone_wb rename to internal_staff");
  }
  check("a MISSING table does not blank the workspace", Boolean(missing.body?.customers?.find((c) => c.id === C1)), { status: missing.status, customers: missing.body?.customers?.length });
  check("…it is named unavailable too", (missing.body?.unavailable ?? []).includes("internal_staff"), missing.body?.unavailable);
} finally {
  server?.kill("SIGTERM");
  await admin.unsafe("grant select on public.deployments to app_rw").catch(() => {});
  await admin.unsafe("alter table if exists public.internal_staff_gone_wb rename to internal_staff").catch(() => {});
  await unseed();
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-workbook-route-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-workbook-route-db: all ${passed} checks passed (profile hides ${HIDDEN.account.length} account, ${HIDDEN.deployments.length} deployment, ${HIDDEN.implementation.length} implementation fields)`);
assert.ok(true);
