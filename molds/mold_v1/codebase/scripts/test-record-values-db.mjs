/**
 * Record choice values through the real Ops API routes, against a real Postgres as app_rw (mold_v1-251).
 *
 * The routes are imported and called in-process with a member's session token, as scripts/test-app-source-db.mjs
 * does. Every seeded value is a STORED value, read from the enums in agent/lib/customer-schema.ts, never typed here:
 *
 *   1. GET /api/ops/summary counts what is stored: a healthy record is not "not healthy", a Red one is "at risk".
 *      (It compared health with "Healthy" and risk with "High"/"Critical": every record counted unhealthy, no Red one
 *      at risk.) The switcher's count (lib/workspace-attention.ts) agrees with it.
 *   2. A create that names no stage, risk, release or health stores values of their enums.
 *      (It stored stage "scoping", risk "low" and blocker owner "".)
 *   3. A write with a value that is not one of the column's is a 400 that lists the real ones, and changes nothing.
 *      (Any non-empty string was stored.)
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:record-values-db
 */
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
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
  console.log("test-record-values-db: SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
  process.exit(0);
}

let passed = 0;
let failures = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}${detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
  }
};

// A member's session token, verified locally (lib/auth-session.ts): no Google, no network.
for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
delete process.env.GOOGLE_CLIENT_ID;
const { exportPKCS8, exportSPKI, generateKeyPair } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

const { deploymentSchema, implementationSchema } = await import("../agent/lib/customer-schema.ts");
const HEALTH = deploymentSchema.shape.healthStatus.options; // healthy, degraded, down, unknown
const RELEASE = deploymentSchema.shape.releaseStatus.options;
const ENVIRONMENT = deploymentSchema.shape.environment.options;
const REGION = deploymentSchema.shape.region.options;
const STAGE = implementationSchema.shape.implementationStage.options;
const RISK = implementationSchema.shape.implementationRiskLevel.options; // Green, Yellow, Red
const OWNER = implementationSchema.shape.blockerOwner.options;
const [HEALTHY] = HEALTH;
const LOW_RISK = RISK[0];
const HIGH_RISK = RISK.at(-1);

const postgres = (await import("postgres")).default;
const stamp = `${Date.now()}-${process.pid}`;
const ORG = `recvals-${stamp}`;
const MEMBER = `member-${stamp}@record-values.test`;
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const cleanup = async () => {
  for (const t of ["entity_activity", "deployments", "implementation", "customers", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [ORG]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id = ${ORG}`.catch(() => undefined);
};

const { NextRequest } = await import("next/server");
const { mintSessionToken } = await import("../lib/auth-session.ts");
const token = await mintSessionToken(MEMBER);
const WEB = "http://web.record-values.test";
const as = (path, init = {}) =>
  new NextRequest(`${WEB}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-ops-org": ORG, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const params = (id) => ({ params: Promise.resolve({ id }) });

const deployment = (cust, id, health) =>
  admin`INSERT INTO deployments (customer_id, deployment_id, org_id, environment, region, deployed_version, health_status, release_status)
        VALUES (${cust}, ${id}, ${ORG}, ${ENVIRONMENT[0]}, ${REGION[0]}, '1.0.0', ${health}, ${RELEASE[0]})`;
const project = (cust, risk, blocker = null) =>
  admin`INSERT INTO implementation (customer_id, implementation_id, org_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, blocker)
        VALUES (${cust}, ${cust}, ${ORG}, ${STAGE[1]}, 40, ${risk}, ${OWNER.at(-1)}, ${blocker})`;
const customer = (cust) => admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${cust}, ${ORG}, ${cust})`;

try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Record values probe', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${ORG}, ${MEMBER}, 'member')`;
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`;
  if (who.b) throw new Error(`${who.u} bypasses RLS — this test would prove nothing`);
  console.log(`  (database as ${who.u}; workspace ${ORG}; a member's session token on every request)`);

  const summaryRoute = await import("../app/api/ops/summary/route.ts");
  const depsRoute = await import("../app/api/ops/deployments/route.ts");
  const depRoute = await import("../app/api/ops/deployments/[id]/route.ts");
  const implsRoute = await import("../app/api/ops/implementations/route.ts");
  const implRoute = await import("../app/api/ops/implementations/[id]/route.ts");

  /* ---- 1. the counts --------------------------------------------------------------------------------------------- */
  console.log(`\n1. The summary counts stored values: health ${HEALTH.join("/")}, risk ${RISK.join("/")}`);
  // One record per health value, and one project per risk value plus a low-risk one with a blocker.
  for (const [i, h] of HEALTH.entries()) {
    await customer(`dep-${i}`);
    await deployment(`dep-${i}`, `D-${i}`, h);
  }
  for (const [i, r] of RISK.entries()) {
    await customer(`proj-${i}`);
    await project(`proj-${i}`, r);
  }
  await customer("proj-blocked");
  await project("proj-blocked", LOW_RISK, "waiting on access");
  const summary = await json(await summaryRoute.GET(as("/api/ops/summary")));
  check("GET /api/ops/summary answers for the workspace", summary.status === 200 && summary.body?.orgId === ORG, summary);
  const section = (key) => summary.body?.sections?.find((s) => s.key === key) ?? { count: 0, sample: [] };
  const unhealthy = section("unhealthyDeployments");
  check(`"not healthy" counts every health value but ${HEALTHY} (${HEALTH.length - 1}), and not the ${HEALTHY} record`, unhealthy.count === HEALTH.length - 1 && !unhealthy.sample.some((s) => s.includes(`— ${HEALTHY}`)), unhealthy);
  const atRisk = section("implementationsAtRisk");
  check(`"at risk or blocked" counts the ${HIGH_RISK} record and the blocked one (2)`, atRisk.count === 2, atRisk);
  check(`…the ${HIGH_RISK} record is among them`, atRisk.sample.some((s) => s.startsWith(`proj-${RISK.length - 1} `)), atRisk.sample);
  check(`…and not the ${RISK.slice(0, -1).join(" or ")} ones without a blocker`, !atRisk.sample.some((s) => /^proj-[0-9]+ /.test(s) && !s.startsWith(`proj-${RISK.length - 1} `)), atRisk.sample);

  const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
  const { attentionCounts } = await import("../lib/workspace-attention.ts");
  const switcher = await attentionCounts([ORG], (orgId, fn) => withOrgDb(orgId, fn));
  check("the workspace switcher's count is the summary's total (one set of conditions)", switcher[ORG] === summary.body?.total, { switcher: switcher[ORG], summary: summary.body?.total });

  /* ---- 2. defaults ----------------------------------------------------------------------------------------------- */
  console.log("\n2. A create that names no choice stores values of the enums");
  await customer("fresh");
  const made = await json(await implsRoute.POST(as("/api/ops/implementations", { method: "POST", body: { customerId: "fresh" } })));
  check("POST /api/ops/implementations with only the account: 201", made.status === 201, made);
  const [fresh] = await admin`SELECT implementation_stage, implementation_risk_level, blocker_owner FROM implementation WHERE org_id = ${ORG} AND customer_id = 'fresh'`;
  check(`its stage is a stage (${STAGE.join(", ")})`, STAGE.includes(fresh?.implementation_stage), fresh);
  check(`its risk is a risk (${RISK.join(", ")})`, RISK.includes(fresh?.implementation_risk_level), fresh);
  check(`its blocker owner is a blocker owner (${OWNER.join(", ")})`, OWNER.includes(fresh?.blocker_owner), fresh);
  await customer("fresh-dep");
  const dep = await json(await depsRoute.POST(as("/api/ops/deployments", { method: "POST", body: { customerId: "fresh-dep", deploymentId: "D-new", environment: ENVIRONMENT[0], region: REGION[0], deployedVersion: "1.0.0" } })));
  check("POST /api/ops/deployments with only the identity fields: 201", dep.status === 201, dep);
  const [freshDep] = await admin`SELECT release_status, health_status FROM deployments WHERE org_id = ${ORG} AND deployment_id = 'D-new'`;
  check("its release and health are values of their enums", RELEASE.includes(freshDep?.release_status) && HEALTH.includes(freshDep?.health_status), freshDep);

  /* ---- 3. refusals ----------------------------------------------------------------------------------------------- */
  console.log("\n3. A value that is not one of the column's is a 400 listing the real ones, and nothing is written");
  const lists = (res, values) => res.status === 400 && values.every((v) => String(res.body?.error ?? "").includes(v));
  const rows = async () => JSON.stringify(await admin`SELECT * FROM deployments WHERE org_id = ${ORG} ORDER BY deployment_id`) + JSON.stringify(await admin`SELECT * FROM implementation WHERE org_id = ${ORG} ORDER BY customer_id`);
  const before = await rows();
  await customer("bad");
  const cases = [
    ["POST a project with risk \"low\"", () => implsRoute.POST(as("/api/ops/implementations", { method: "POST", body: { customerId: "bad", implementationRiskLevel: "low" } })), RISK],
    ["POST a project with stage \"scoping\"", () => implsRoute.POST(as("/api/ops/implementations", { method: "POST", body: { customerId: "bad", implementationStage: "scoping" } })), STAGE],
    ["POST (upsert) an existing project with risk \"High\"", () => implsRoute.POST(as("/api/ops/implementations", { method: "POST", body: { customerId: "fresh", implementationRiskLevel: "High" } })), RISK],
    ["PATCH a project's risk to \"Critical\"", () => implRoute.PATCH(as("/api/ops/implementations/fresh", { method: "PATCH", body: { customerId: "fresh", implementationRiskLevel: "Critical" } }), params("fresh")), RISK],
    ["PATCH a project's stage to \"go-live\"", () => implRoute.PATCH(as("/api/ops/implementations/fresh", { method: "PATCH", body: { customerId: "fresh", implementationStage: "go-live" } }), params("fresh")), STAGE],
    ["POST a record with environment \"production\"", () => depsRoute.POST(as("/api/ops/deployments", { method: "POST", body: { customerId: "bad", deploymentId: "D-bad", environment: "production", region: REGION[0], deployedVersion: "1" } })), ENVIRONMENT],
    ["POST a record with health \"Healthy\"", () => depsRoute.POST(as("/api/ops/deployments", { method: "POST", body: { customerId: "bad", deploymentId: "D-bad", environment: ENVIRONMENT[0], region: REGION[0], deployedVersion: "1", healthStatus: "Healthy" } })), HEALTH],
    ["POST (upsert) an existing record with release \"live\"", () => depsRoute.POST(as("/api/ops/deployments", { method: "POST", body: { customerId: "fresh-dep", deploymentId: "D-new", releaseStatus: "live" } })), RELEASE],
    ["PATCH a record's health to \"Healthy\"", () => depRoute.PATCH(as("/api/ops/deployments/D-new", { method: "PATCH", body: { customerId: "fresh-dep", healthStatus: "Healthy" } }), params("D-new")), HEALTH],
  ];
  for (const [what, call, values] of cases) {
    const res = await json(await call());
    check(`${what}: 400, naming every value (${values.length})`, lists(res, values), res);
  }
  check("nothing was written by any refused call", (await rows()) === before);
  const good = await json(await implRoute.PATCH(as("/api/ops/implementations/fresh", { method: "PATCH", body: { customerId: "fresh", implementationRiskLevel: HIGH_RISK } }), params("fresh")));
  const [after] = await admin`SELECT implementation_risk_level FROM implementation WHERE org_id = ${ORG} AND customer_id = 'fresh'`;
  check(`a stored value still goes through (PATCH risk ${HIGH_RISK}: ${good.status})`, good.status === 200 && after?.implementation_risk_level === HIGH_RISK, { good, after });
  await closeDb();
} catch (e) {
  failures++;
  console.error(`  FAIL the run stopped: ${e?.stack ?? e}`);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e));
  await admin.end();
}

console.log(`\ntest-record-values-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
