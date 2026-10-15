#!/usr/bin/env node
/**
 * The two account record areas against a real Postgres, for the definitions of THIS checkout's profile
 * (scripts/test-record-area-db.mjs runs it in the checkout, the default, and in a copy under two declared examples: the
 * research desk's "Coverage report" for deployments and a "Compliance programme" for implementations). The real ops
 * routes, upsert_customer's real write path and the per-area tools, as the restricted app_rw role under the
 * fail-closed policies, two workspaces that each hold an account with the same id.
 *
 *   default    today's routes: a valid write as before; today's list unchanged without a query; with one, filtered,
 *              sorted and paged in the database; a key outside the definition refused; no per-area tool.
 *   declared   every write through the one validator (the routes, upsert_customer's nested rows, the tools): a create
 *              normalised and filled (aliases, labels, fixed values, the initial state, {me}), a refusal stores nothing;
 *              own fields merged per key; the list filtered and sorted on columns and own fields, paged by a cursor,
 *              each row with its title and values.
 *   both       workspace B reaches none of A's records through the lists, the writes, the tools or the rows under RLS.
 *
 * Needs ADMIN_URL and DATABASE_URL (app_rw).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
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
  console.log("record-area-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "record-area-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const DECLARED = Boolean(RECORD_AREAS.deployments.declared && RECORD_AREAS.implementations.declared);
const STRICT = DECLARED && RECORD_AREAS.deployments.lifecycle?.enforce === "strict";
const LABEL = STRICT ? "strict" : DECLARED ? "declared" : "default";
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
const sameObject = (a, b) => {
  const sorted = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};
const TAG = `${process.pid}-${LABEL}`;
const A = `org-areas-a-${TAG}`;
const B = `org-areas-b-${TAG}`;
const ANA = `ana-${TAG}@areas-a.test`;
const BEN = `ben-${TAG}@areas-b.test`;
const CARL = `carl-${TAG}@areas-a.test`;
const DANA = `dana-${TAG}@areas-a.test`;
const CO = "acme-shared";
const CO2 = "beta-only-a";

async function cleanup() {
  for (const t of ["entity_activity", "deployments", "implementation", "customers", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

const closers = [];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Areas A', 'active'), (${B}, 'Areas B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ANA}, 'member'), (${B}, ${BEN}, 'member'), (${A}, ${CARL}, 'admin'), (${A}, ${DANA}, 'admin')`;
  // Two workspaces each hold an account with the same id (mold_v1-118); A has one more.
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Acme (A)'), (${CO2}, ${A}, 'Beta (A)'), (${CO}, ${B}, 'Acme (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const bearers = { [ANA]: `Bearer ${await mintSessionToken(ANA)}`, [BEN]: `Bearer ${await mintSessionToken(BEN)}` };
  const orgOf = { [ANA]: A, [BEN]: B };
  const H = "http://areas.test";
  const call = async (who, method, area, { body, id, query } = {}) => {
    const handlers = await import(root(id ? `app/api/ops/${area}/[id]/route.ts` : `app/api/ops/${area}/route.ts`));
    const path = `/api/ops/${area}${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
    const request = new NextRequest(`${H}${path}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const list = (who, area, q) => call(who, "GET", area, { query: q });
  const where = (w, extra = "") => `where=${encodeURIComponent(JSON.stringify(w))}${extra}`;
  const dep = async (org, id) => (await admin`SELECT * FROM deployments WHERE org_id = ${org} AND deployment_id = ${id}`)[0];
  const imp = async (org, co) => (await admin`SELECT * FROM implementation WHERE org_id = ${org} AND customer_id = ${co}`)[0];
  const count = async (table, org) => Number((await admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [org]))[0].n);
  const sor = await import(root("agent/lib/system-of-record.ts"));
  const tools = await import(root("agent/lib/record-area-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  // The tools as defined (the model-facing wrapper only translates words under a relabelling profile; the surface test,
  // scripts/test-record-area-panels.mjs, reads them as the model does).
  const base = DECLARED ? { list: tools.listAreaTool("deployments"), upsert: tools.upsertAreaTool("deployments"), upsertImp: tools.upsertAreaTool("implementations") } : {};
  const tool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

  if (STRICT) {
    // ------------------------------------------------- a strict lifecycle through the agent's write paths: roles, four eyes
    const upsert = tools.upsertAreaTool("deployments");
    const report = (id, values = {}) => ({ customerId: CO, deploymentId: id, values: { runtime: "Sector note", deployedVersion: id, healthStatus: "healthy", rating: "Buy", ...values } });
    const state = async (id) => (await dep(A, id))?.release_status;
    const moves = async (id) => (await admin`SELECT actor, event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'deployment' AND entity_id = ${id} ORDER BY created_at`).map((r) => `${r.actor}: ${r.event}`);
    // The per-area tool, as the caller's role.
    await tool(upsert, report("R1"), ANA);
    const sent = await tool(upsert, report("R1", { releaseStatus: "pending-approval" }), ANA);
    check("upsert_<area>: a member sends a report for review (allowed), and the move is in the activity feed", sent.updated === true && (await state("R1")) === "pending-approval" && (await moves("R1")).some((m) => m.startsWith(`${ANA}: `) && /\[releaseStatus: in-progress → pending-approval\]$/.test(m)), { sent, moves: await moves("R1") });
    const memberPublish = await tool(upsert, report("R1", { releaseStatus: "deployed" }), ANA);
    check("upsert_<area>: a member may not publish (roles: owner or admin), under strict refused with the rule", /only owner or admin may make it/.test(memberPublish.error ?? "") && (await state("R1")) === "pending-approval", memberPublish);
    const adminPublish = await tool(upsert, report("R1", { releaseStatus: "deployed" }), DANA);
    check("upsert_<area>: an admin may: the tool passes the caller's workspace role", adminPublish.updated === true && (await state("R1")) === "deployed", adminPublish);
    await tool(upsert, report("R2"), DANA);
    await tool(upsert, report("R2", { releaseStatus: "pending-approval" }), DANA);
    const ownPublish = await tool(upsert, report("R2", { releaseStatus: "deployed" }), DANA);
    check("upsert_<area>: four eyes: whoever sent it for review may not publish it", /not by the person who moved it to "Awaiting review"/.test(ownPublish.error ?? "") && (await state("R2")) === "pending-approval", ownPublish);
    const otherPublish = await tool(upsert, report("R2", { releaseStatus: "deployed" }), CARL);
    check("…a second admin may", otherPublish.updated === true && (await state("R2")) === "deployed", otherPublish);

    // upsert_customer's nested rows: the same rules, and the moves written to the activity feed, so four eyes holds there too.
    const nested = (who, row) => sor.upsertCustomer({ id: CO, deployments: [{ deploymentId: "R3", ...row }] }, A, { actor: who }).then(() => "ok", (e) => String(e?.message ?? e));
    const made = await nested(CARL, { runtime: "Sector note", deployedVersion: "R3", healthStatus: "healthy", custom: { rating: "Hold" } });
    const toReview = await nested(CARL, { releaseStatus: "pending-approval" });
    check("upsert_customer: a nested row's move is written to the activity feed as the routes write it", made === "ok" && toReview === "ok" && (await state("R3")) === "pending-approval" && (await moves("R3")).some((m) => m.startsWith(`${CARL}: `) && /\[releaseStatus: in-progress → pending-approval\]$/.test(m)), { made, toReview, moves: await moves("R3") });
    const selfPublish = await nested(CARL, { releaseStatus: "deployed" });
    check("upsert_customer: four eyes reads that line: who sent it for review may not publish it, nothing written", /^Nothing was written\. R3: .*not by the person who moved it to "Awaiting review"/.test(selfPublish) && (await state("R3")) === "pending-approval", selfPublish);
    const memberNested = await nested(ANA, { releaseStatus: "deployed" });
    check("upsert_customer: the writer's workspace role is read (a member may not publish)", /only owner or admin may make it/.test(memberNested) && (await state("R3")) === "pending-approval", memberNested);
    const secondPublish = await nested(DANA, { releaseStatus: "deployed" });
    check("upsert_customer: a second admin publishes, and that move is noted too", secondPublish === "ok" && (await state("R3")) === "deployed" && (await moves("R3")).some((m) => m.startsWith(`${DANA}: `) && /\[releaseStatus: pending-approval → deployed\]$/.test(m)), { secondPublish, moves: await moves("R3") });
  } else if (!DECLARED) {
    // ----------------------------------------------------------------------------------------- the default areas
    check("no per-area tool is offered under the default definition", [tools.listDeploymentsTool, tools.upsertDeploymentTool, tools.listImplementationsTool, tools.upsertImplementationTool].every((t) => t === null));
    const base = { customerId: CO, environment: "prod", region: "eu-west-1" };
    const made = [];
    for (const [i, [id, version, status]] of [["D-1", "1.0.0", "deployed"], ["D-2", "2.0.0", "in-progress"], ["D-3", "3.0.0", "in-progress"]].entries()) {
      const r = await call(ANA, "POST", "deployments", { body: { ...base, deploymentId: id, deployedVersion: version, releaseStatus: status, ...(i === 0 ? { displayName: "First" } : {}) } });
      made.push(r.status);
    }
    check("valid creates are created as before (201 each)", made.every((s) => s === 201), made);
    const stored = await dep(A, "D-1");
    check("…stored as before: today's defaults, no own fields", stored?.health_status === "healthy" && stored?.release_status === "deployed" && sameObject(stored?.custom, {}) && stored?.display_name === "First", stored);
    const bad = await call(ANA, "POST", "deployments", { body: { ...base, deploymentId: "D-9", deployedVersion: "9", releaseStatus: "waiting" } });
    check("a value the column does not take is today's 400", bad.status === 400 && /Release status|releaseStatus/.test(bad.body?.error ?? "") && !(await dep(A, "D-9")), bad);
    const plain = await list(ANA, "deployments");
    const keys = Object.keys(plain.body?.items?.[0] ?? {}).sort().join(",");
    check("the list without a query is today's: every row, today's order and today's keys (no values, no title)", plain.status === 200 && plain.body.items.map((d) => d.id).join() === "D-1,D-2,D-3" && keys === "custom,customer,customerLabel,displayName,env,errorRate,fields,health,id,label,lastDeployAt,owner,status,uptime,version" && !("nextCursor" in plain.body), { keys, ids: plain.body?.items?.map((d) => d.id) });
    const filtered = await list(ANA, "deployments", where({ releaseStatus: "in-progress" }, "&sort=-deployedVersion"));
    check("with a query: filtered and sorted in the database", filtered.status === 200 && filtered.body.items.map((d) => d.id).join() === "D-3,D-2", filtered.body);
    const page1 = await list(ANA, "deployments", "sort=deployedVersion&limit=2");
    const page2 = await list(ANA, "deployments", `sort=deployedVersion&limit=2&cursor=${encodeURIComponent(page1.body?.nextCursor ?? "")}`);
    check("paged: two rows and a cursor, then the last row and no cursor", page1.body?.items?.map((d) => d.id).join() === "D-1,D-2" && typeof page1.body.nextCursor === "string" && page2.body?.items?.map((d) => d.id).join() === "D-3" && !page2.body.nextCursor, { page1: page1.body, page2: page2.body });
    const injected = await list(ANA, "deployments", where({ "deployment_id) or (1=1": "x" }));
    check("a key outside the definition is a 400 that names the fields, and nothing is read", injected.status === 400 && /There is no field "deployment_id\) or \(1=1" to filter on here/.test(injected.body?.error ?? ""), injected);
    const patched = await call(ANA, "PATCH", "deployments", { id: "D-2", body: { customerId: CO, releaseStatus: "deployed" } });
    check("a valid change is made as before", patched.status === 200 && (await dep(A, "D-2")).release_status === "deployed", patched);
    const own = await call(ANA, "PATCH", "deployments", { id: "D-2", body: { customerId: CO, custom: { colour: "red" } } });
    check("an own field the default does not declare is refused with today's sentence", own.status === 400 && /colour/.test(own.body?.error ?? ""), own);
    const nested = await sor.upsertCustomer({ id: CO, deployments: [{ deploymentId: "D-1", releaseStatus: "rolled-back" }], implementation: { implementationStage: "Discovery", implementationRiskLevel: "Green", implementationProgressPct: 10, blockerOwner: "None" } }, A, { actor: ANA }).then(() => "ok", (e) => String(e?.message ?? e));
    check("upsert_customer's nested rows are written as before", nested === "ok" && (await dep(A, "D-1")).release_status === "rolled-back" && (await imp(A, CO))?.implementation_stage === "Discovery", nested);
    const impList = await list(ANA, "implementations", where({ implementationStage: "Discovery" }));
    check("implementations: filtered in the database too", impList.status === 200 && impList.body.items.length === 1 && impList.body.items[0].customer === CO, impList.body);
  } else {
    // ---------------------------------------------------------------------------------------- the declared areas
    const d = RECORD_AREAS.deployments;
    const created = await call(ANA, "POST", "deployments", { body: { customerId: CO, deploymentId: "Q2FY26-results", report_type: "initiation", period: "Q2 FY26 · standalone", data_quality: "Complete", custom: { rating: "buy", target_price: "1250.5" }, actor: "someone-else@x.test" } });
    let row = await dep(A, "Q2FY26-results");
    check("a create the definition accepts is created (201)", created.status === 201 && created.body?.item?.id === "Q2FY26-results", created);
    check("…normalised: an alias and a label taken, fixed values and the initial state filled, {me} is the signed-in person", row?.runtime === "Initiation" && row.deployed_version === "Q2 FY26 · standalone" && row.health_status === "healthy" && row.environment === d.fields.environment.fixed && row.region === d.fields.region.fixed && row.release_status === d.lifecycle.initial && row.deploy_owner_email === ANA, row);
    check("…its own fields canonical (a choice's value, a number)", sameObject(row?.custom, { rating: "Buy", target_price: 1250.5 }), row?.custom);
    const before = await count("deployments", A);
    const missing = await call(ANA, "POST", "deployments", { body: { customerId: CO, deploymentId: "No-rating", runtime: "Sector note", deployedVersion: "Q3", healthStatus: "unknown" } });
    check("a field required when created, missing: a 400 that names it, nothing stored", missing.status === 400 && /"Rating" \(rating\) is required\./.test(missing.body?.error ?? "") && (await count("deployments", A)) === before, missing);
    const wrong = await call(ANA, "POST", "deployments", { body: { customerId: CO, deploymentId: "Bad", runtime: "Sector note", deployedVersion: "Q3", healthStatus: "unknown", custom: { rating: "Strong buy", target_price: -1 } } });
    check("invalid values: a 400 naming the choices and the limit, every problem at once, nothing stored", wrong.status === 400 && /"Rating" \(rating\) must be one of: "Buy"/.test(wrong.body?.errors?.[0] ?? "") && /"Target price" \(target_price\) must be at least 0\./.test(wrong.body.errors[1] ?? "") && (await count("deployments", A)) === before, wrong);
    const computedLike = await call(ANA, "POST", "deployments", { body: { customerId: CO, deploymentId: "Hidden", runtime: "Sector note", deployedVersion: "Q3", healthStatus: "unknown", environment: "dev", custom: { rating: "Hold" } } });
    check("a hidden fixed field written with another value: a 400, nothing stored", computedLike.status === 400 && /\(environment\) is not used here; it always holds "prod"/.test(computedLike.body?.error ?? ""), computedLike);

    // Own fields merge per key; null clears one; a stored key the profile does not declare is carried.
    await admin`UPDATE deployments SET custom = custom || '{"retired_key": "kept"}'::jsonb WHERE org_id = ${A} AND deployment_id = 'Q2FY26-results'`;
    const [x, y] = await Promise.all([
      call(ANA, "PATCH", "deployments", { id: "Q2FY26-results", body: { customerId: CO, custom: { kpi_completeness: "85%" } } }),
      call(ANA, "PATCH", "deployments", { id: "Q2FY26-results", body: { customerId: CO, custom: { source_filing: "https://example.com/q2.pdf" } } }),
    ]);
    row = await dep(A, "Q2FY26-results");
    check("two writers of different own fields at once: both land, the rest kept", x.status === 200 && y.status === 200 && row.custom.kpi_completeness === 85 && row.custom.source_filing === "https://example.com/q2.pdf" && row.custom.rating === "Buy" && row.custom.retired_key === "kept", { x: x.body, y: y.body, custom: row.custom });
    await call(ANA, "PATCH", "deployments", { id: "Q2FY26-results", body: { customerId: CO, custom: { source_filing: null } } });
    row = await dep(A, "Q2FY26-results");
    check("null clears one own field and nothing else", !("source_filing" in row.custom) && row.custom.rating === "Buy", row.custom);
    const cleared = await call(ANA, "PATCH", "deployments", { id: "Q2FY26-results", body: { customerId: CO, deployedVersion: "" } });
    check("a required field cannot be cleared (400)", cleared.status === 400 && /\(deployedVersion\) is required, so it cannot be cleared/.test(cleared.body?.error ?? ""), cleared);
    const move = await call(ANA, "PATCH", "deployments", { id: "Q2FY26-results", body: { customerId: CO, releaseStatus: "deployed" } });
    check("a move outside the lifecycle's transitions under enforce \"warn\": made, and the answer's warning names the rule and the moves there are", move.status === 200 && (await dep(A, "Q2FY26-results")).release_status === "deployed" && move.body?.warnings?.[0]?.code === "lifecycle_rule_broken" && move.body.warnings[0].to === "deployed" && /Published/.test(move.body.warnings[0].message), move);
    await new Promise((ok) => setTimeout(ok, 500)); // the activity feed is written after the answer, as it always was
    const activity = await admin`SELECT event FROM entity_activity WHERE org_id = ${A} AND entity_type = 'deployment' AND entity_id = 'Q2FY26-results'`;
    check("each change is in the activity feed in the definition's words; the move as the lifecycle notes it, with the rule it broke", activity.some((a) => /^KPI table completeness changed — → 85%$/.test(a.event)) && activity.some((a) => /^Status moved "In progress" → "Published" \[releaseStatus: in-progress → deployed\]$/.test(a.event)) && activity.some((a) => /^Lifecycle rule not followed/.test(a.event)) && !activity.some((a) => /^Status changed/.test(a.event)), activity.map((a) => a.event));

    // More rows for the list.
    for (const [id, rating, tp, co] of [["Q1FY26-results", "Hold", 900, CO], ["FY25-annual", "Sell", null, CO2], ["Q3FY26-update", "Buy", 1500, CO2]]) {
      const r = await call(ANA, "POST", "deployments", { body: { customerId: co, deploymentId: id, runtime: "Quarterly results update", deployedVersion: id, healthStatus: "degraded", lastDeployAt: "2026-08-01", custom: { rating, ...(tp === null ? {} : { target_price: tp }) } } });
      if (r.status !== 201) check(`seed ${id}`, false, r);
    }
    const all = await list(ANA, "deployments");
    const one = all.body?.items?.find((i) => i.id === "Q2FY26-results");
    check("the list: each row carries its title (the template) and its values by key", all.status === 200 && all.body.items.length === 4 && one?.title === "Initiation · Q2 FY26 · standalone" && one?.values?.rating === "Buy" && one?.values?.runtime === "Initiation" && !("environment" in (one?.values ?? {})), one);
    const byOwn = await list(ANA, "deployments", where({ rating: "buy" }));
    check("filtered on an own choice field (a label or value, in any case)", byOwn.body?.items?.map((i) => i.id).sort().join() === "Q2FY26-results,Q3FY26-update", byOwn.body);
    const byNum = await list(ANA, "deployments", where({ target_price: { gte: 1000 } }, "&sort=-target_price"));
    check("filtered and sorted on an own number field, numerically", byNum.body?.items?.map((i) => i.id).join() === "Q3FY26-update,Q2FY26-results", byNum.body);
    const unset = await list(ANA, "deployments", where({ target_price: { set: false } }));
    check("an own field not set", unset.body?.items?.map((i) => i.id).join() === "FY25-annual", unset.body);
    const byAccount = await list(ANA, "deployments", where({ account: CO2, healthStatus: "degraded" }));
    check("the account and a column together", byAccount.body?.items?.length === 2, byAccount.body);
    const searched = await list(ANA, "deployments", "q=annual");
    check("searched in the database", searched.body?.items?.map((i) => i.id).join() === "FY25-annual", searched.body);
    const p1 = await list(ANA, "deployments", "sort=-target_price&limit=3");
    const p2 = await list(ANA, "deployments", `sort=-target_price&limit=3&cursor=${encodeURIComponent(p1.body?.nextCursor ?? "")}`);
    check("paged by the cursor, a total order: no row twice, none skipped, nulls last", p1.body?.items?.map((i) => i.id).join() === "Q3FY26-update,Q2FY26-results,Q1FY26-results" && p2.body?.items?.map((i) => i.id).join() === "FY25-annual" && !p2.body.nextCursor, { p1: p1.body?.items?.map((i) => i.id), p2: p2.body?.items?.map((i) => i.id) });
    const computedFilter = await list(ANA, "deployments", where({ environment: "prod" }));
    check("a hidden field cannot be filtered on (400)", computedFilter.status === 400, computedFilter.body);

    // Implementations: a programme with a multi-pick, money, a yes/no.
    const prog = await call(ANA, "POST", "implementations", { body: { customerId: CO, regulators: ["rbi", "SEBI"], custom: { budget: "125000", board_approved: "yes" } } });
    const ir = await imp(A, CO);
    check("a programme is created: the initial phase, the fixed blocker owner, defaults, the lead is the signed-in person", prog.status === 201 && ir?.implementation_stage === "Kickoff" && ir.blocker_owner === "None" && ir.implementation_risk_level === "Green" && ir.implementation_progress_pct === 0 && ir.implementation_owner_email === ANA, { prog, ir });
    check("…its own fields canonical: a list, a number, a yes/no", sameObject(ir?.custom, { regulators: ["RBI", "SEBI"], budget: 125000, board_approved: true }), ir?.custom);
    const contains = await list(ANA, "implementations", where({ regulators: { contains: "sebi" } }));
    const notContains = await list(ANA, "implementations", where({ regulators: { contains: "MCA" } }));
    check("filtered by what a list field contains", contains.body?.items?.length === 1 && notContains.body?.items?.length === 0, { contains: contains.body, notContains: notContains.body });
    const progPatch = await call(ANA, "PATCH", "implementations", { id: CO, body: { customerId: CO, regulators: ["NHB"], implementationStage: "Discovery" } });
    check("a programme changed: the list replaced, the phase moved", progPatch.status === 200 && sameObject((await imp(A, CO)).custom.regulators, ["NHB"]) && (await imp(A, CO)).implementation_stage === "Discovery", progPatch);

    // upsert_customer's nested rows go through the same validator.
    const nestedBad = await sor.upsertCustomer({ id: CO, deployments: [{ deploymentId: "Nested-1", runtime: "Sector note", deployedVersion: "Q4", healthStatus: "unknown", custom: { rating: "Strong buy" } }] }, A, { actor: ANA }).then(() => "written", (e) => String(e?.message ?? e));
    check("upsert_customer: a nested row the definition refuses is refused in its sentence, nothing written", /^Nothing was written\. Nested-1: "Rating" \(rating\) must be one of/.test(nestedBad) && !(await dep(A, "Nested-1")), nestedBad);
    const nestedOk = await sor.upsertCustomer({ id: CO, deployments: [{ deploymentId: "Nested-1", runtime: "sector note", deployedVersion: "Q4", healthStatus: "unknown", custom: { rating: "hold" } }], implementation: { custom: { regulators: ["mca"] } } }, A, { actor: ANA }).then(() => "ok", (e) => String(e?.message ?? e));
    const nrow = await dep(A, "Nested-1");
    check("upsert_customer: a nested row is filled and normalised as the routes do", nestedOk === "ok" && nrow?.runtime === "Sector note" && nrow.environment === d.fields.environment.fixed && nrow.release_status === d.lifecycle.initial && nrow.deploy_owner_email === ANA && sameObject(nrow.custom, { rating: "Hold" }), { nestedOk, nrow });
    check("upsert_customer: the implementation's own list merged by key, the other own fields kept", sameObject((await imp(A, CO)).custom, { regulators: ["MCA"], budget: 125000, board_approved: true }), (await imp(A, CO)).custom);

    // The per-area tools.
    check("the per-area tools are offered (the definition turns them on)", [tools.listDeploymentsTool, tools.upsertDeploymentTool, tools.listImplementationsTool, tools.upsertImplementationTool].every((t) => t !== null));
    const listed = await tool(base.list, { where: { rating: "Buy" }, sort: "-target_price" }, ANA);
    check("list_<area>: filtered and sorted in the database, each row with its title and values", Array.isArray(listed.items) && listed.items.map((i) => i.deploymentId).join() === "Q3FY26-update,Q2FY26-results" && listed.items[0].values.rating === "Buy", listed);
    const toolBad = await tool(base.list, { where: { "custom->>'rating'": "Buy" } }, ANA);
    check("list_<area>: a key outside the definition is refused", typeof toolBad.error === "string" && /There is no field "custom->>'rating'"/.test(toolBad.error), toolBad);
    const toolWrite = await tool(base.upsert, { customerId: CO2, deploymentId: "From-model", values: { runtime: "Sector note", deployedVersion: "FY26", healthStatus: "healthy", rating: "Add" } }, ANA);
    const trow = await dep(A, "From-model");
    check("upsert_<area>: creates through the validator, {me} the caller", toolWrite.created === true && trow?.deploy_owner_email === ANA && sameObject(trow?.custom, { rating: "Add" }) && trow.release_status === d.lifecycle.initial, { toolWrite, trow });
    const toolRefused = await tool(base.upsert, { customerId: CO2, deploymentId: "From-model", values: { rating: "Strong buy" } }, ANA);
    check("upsert_<area>: a refusal is an error in the validator's sentence, nothing changed", typeof toolRefused.error === "string" && /^Nothing was written\. "Rating" \(rating\) must be one of/.test(toolRefused.error) && (await dep(A, "From-model")).custom.rating === "Add", toolRefused);
    const toolImp = await tool(base.upsertImp, { customerId: CO2, values: { regulators: ["RBI"], budget: 10 } }, ANA);
    check("upsert_implementation: one per account, created with its lists", toolImp.created === true && sameObject((await imp(A, CO2))?.custom, { regulators: ["RBI"], budget: 10 }), toolImp);
    // Computed fields filtered and sorted in the database, meaning what the definition evaluates for display.
    await call(ANA, "PATCH", "implementations", { id: CO, body: { customerId: CO, targetGoLiveDate: "2026-01-01" } });
    const progs = (await list(ANA, "implementations")).body?.items ?? [];
    const byJs = (key, value) => progs.filter((r) => r.values?.[key] === value).map((r) => r.customer).sort().join();
    check("the list shows each programme's computed fields (evaluated for display)", progs.length === 2 && progs.find((r) => r.customer === CO)?.values?.schedule === "Late" && progs.find((r) => r.customer === CO2)?.values?.schedule === "No date" && progs.find((r) => r.customer === CO)?.values?.size === "Large" && progs.find((r) => r.customer === CO2)?.values?.size === "Small", progs.map((r) => [r.customer, r.values?.schedule, r.values?.size]));
    const mismatch = [];
    for (const [key, values] of [["schedule", ["Late", "Scheduled", "No date"]], ["size", ["Large", "Small"]]]) {
      for (const value of values) {
        const r = await list(ANA, "implementations", where({ [key]: value }));
        const sql = (r.body?.items ?? []).map((i) => i.customer).sort().join();
        if (r.status !== 200 || sql !== byJs(key, value)) mismatch.push({ key, value, status: r.status, sql, js: byJs(key, value), error: r.body?.error });
      }
    }
    check("filtered on a computed field in the database: for every value, the rows the definition evaluates to it", mismatch.length === 0, mismatch);
    const sortedDesc = await list(ANA, "implementations", "sort=-schedule");
    check("sorted on a computed field in the database", sortedDesc.status === 200 && sortedDesc.body.items.map((i) => i.values.schedule).join() === "No date,Late", sortedDesc.body);
    const notLate = await list(ANA, "implementations", where({ schedule: { ne: "Late" } }));
    check("…and its other comparisons (ne)", notLate.body?.items?.map((i) => i.customer).join() === CO2, notLate.body);

  }

  // ------------------------------------------------------------------------------------------ both: workspaces apart
  const snapshot = async () => JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM deployments x WHERE org_id = ${A} ORDER BY deployment_id`) + JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM implementation x WHERE org_id = ${A} ORDER BY customer_id`);
  const beforeA = await snapshot();
  const theirList = await list(BEN, "deployments", where({ account: CO }));
  check("workspace B's list (its own account of the same id) holds none of A's rows", theirList.status === 200 && theirList.body.items.length === 0, theirList.body);
  const theirSearch = await list(BEN, "deployments", "q=a");
  check("…nor does its search", theirSearch.status === 200 && theirSearch.body.items.length === 0, theirSearch.body);
  const firstA = (await admin`SELECT deployment_id FROM deployments WHERE org_id = ${A} ORDER BY deployment_id LIMIT 1`)[0].deployment_id;
  const theirPatch = await call(BEN, "PATCH", "deployments", { id: firstA, body: { customerId: CO, deployOwnerEmail: "taken@b.test" } });
  check("B cannot change A's record through the API", theirPatch.status === 404 || theirPatch.status === 403, theirPatch);
  const theirOther = await call(BEN, "PATCH", "deployments", { id: firstA, body: { customerId: CO2, deployOwnerEmail: "taken@b.test" } });
  check("…nor name A's other account", theirOther.status === 403, theirOther);
  if (DECLARED) {
    const theirTool = await tool(base.list, {}, BEN);
    check("B's list tool holds none of A's rows", Array.isArray(theirTool.items) && theirTool.items.length === 0, theirTool);
    const theirWrite = await tool(base.upsert, { customerId: CO2, deploymentId: "Planted", values: { runtime: "Sector note", deployedVersion: "x", healthStatus: "healthy", rating: "Buy" } }, BEN);
    check("B's write tool cannot attach a record to A's account", typeof theirWrite.error === "string" && !(await dep(A, "Planted")) && !(await dep(B, "Planted")), theirWrite);
  }
  const app = postgres(process.env.DATABASE_URL, { ssl, prepare: false, max: 1, onnotice: () => {} });
  closers.push(() => app.end({ timeout: 2 }));
  const asB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return {
      read: (await tx`SELECT custom FROM deployments WHERE org_id = ${A}`).length + (await tx`SELECT custom FROM implementation WHERE org_id = ${A}`).length,
      wrote: (await tx`UPDATE deployments SET custom = custom || '{"planted": true}'::jsonb WHERE org_id = ${A} RETURNING deployment_id`).length,
    };
  });
  check("under RLS, workspace B reads none of A's rows and changes none", asB.read === 0 && asB.wrote === 0, asB);
  check("A's records are byte for byte what they were", (await snapshot()) === beforeA);
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`record-area-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
