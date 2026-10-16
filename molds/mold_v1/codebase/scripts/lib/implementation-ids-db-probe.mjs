#!/usr/bin/env node
/**
 * Implementation rows by their own id, and renamed own fields read under both keys, against a real Postgres, for the
 * definitions of THIS checkout's profile (scripts/test-implementation-ids-db.mjs runs it in the checkout, the default,
 * and in copies under scripts/fixtures/record-areas/examples/frameworks.json with and without `per_account: "many"`).
 * The real ops routes, upsert_customer's real write path, the per-area tools and the MCP tools, as the restricted
 * app_rw role under the fail-closed policies, two workspaces that each hold an account with the same id.
 *
 *   one       (the default) one row per account on every write path, its id the account's; `implementations[]` refused.
 *   renamed   one per account, own fields renamed: rows under the old keys filtered, sorted, computed and counted.
 *   many      several per account, each addressed by its own id everywhere; the renamed fields as above.
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
  console.log("implementation-ids-db-probe: needs ADMIN_URL and DATABASE_URL");
  process.exit(2);
}
for (const name of ["BLOB_READ_WRITE_TOKEN", "POSTGRES_URL"]) delete process.env[name];
process.env.DATAROOM_DIR = mkdtempSync(join(tmpdir(), "implementation-ids-db-"));
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const root = (p) => pathToFileURL(`${process.cwd()}/${p}`).href;
const { RECORD_AREAS } = await import(root("agent/lib/record-areas.generated.ts"));
const IMP = RECORD_AREAS.implementations;
const MANY = IMP.declared === true && IMP.per_account === "many";
const RENAMED = IMP.declared === true && IMP.fields.control_count?.renamed_from === "controls";
const LABEL = MANY ? "many" : RENAMED ? "renamed" : "one";
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
const TAG = `${process.pid}-${LABEL}`;
const A = `org-implid-a-${TAG}`;
const B = `org-implid-b-${TAG}`;
const ANA = `ana-${TAG}@implid-a.test`;
const BEN = `ben-${TAG}@implid-b.test`;
const CO = "regulator-shared";
const CO2 = "regulator-only-a";

async function cleanup() {
  for (const t of ["entity_activity", "todos", "deployments", "implementation", "customers", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [A, B]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${A}, ${B})`.catch(() => undefined);
}

const closers = [];
try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${A}, 'Impl A', 'active'), (${B}, 'Impl B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${A}, ${ANA}, 'admin'), (${B}, ${BEN}, 'admin')`;
  // Two workspaces each hold an account with the same id; A has one more.
  await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO}, ${A}, 'Regulator (A)'), (${CO2}, ${A}, 'Other (A)'), (${CO}, ${B}, 'Regulator (B)')`;

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import(root("lib/auth-session.ts"));
  const agentDb = await import(root("agent/lib/db/index.ts"));
  closers.push(() => agentDb.closeDb?.());
  const bearers = { [ANA]: `Bearer ${await mintSessionToken(ANA)}`, [BEN]: `Bearer ${await mintSessionToken(BEN)}` };
  const orgOf = { [ANA]: A, [BEN]: B };
  const H = "http://implid.test";
  const call = async (who, method, path, { body, id, query, routeFile } = {}) => {
    const file = routeFile ?? (id !== undefined ? `app/api/ops/${path}/[id]/route.ts` : `app/api/ops/${path}/route.ts`);
    const handlers = await import(root(file));
    const url = `/api/ops/${path}${id !== undefined ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
    const request = new NextRequest(`${H}${url}`, { method, headers: { authorization: bearers[who], "x-ops-org": orgOf[who], "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlers[method](request, id !== undefined ? { params: Promise.resolve({ id }) } : undefined);
    const out = await res.text();
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
  const list = (who, q) => call(who, "GET", "implementations", { query: q });
  const where = (w, extra = "") => `where=${encodeURIComponent(JSON.stringify(w))}${extra}`;
  // The renamed-field checks need no row id of their own; they run (and say what they find) on a database without one.
  const HAS_ID = (await admin`SELECT 1 FROM information_schema.columns WHERE table_name = 'implementation' AND column_name = 'implementation_id'`).length === 1;
  const order = HAS_ID ? "customer_id, implementation_id" : "customer_id";
  const rows = async (org, co) => (co ? await admin.unsafe(`SELECT * FROM implementation WHERE org_id = $1 AND customer_id = $2 ORDER BY ${order}`, [org, co]) : await admin.unsafe(`SELECT * FROM implementation WHERE org_id = $1 ORDER BY ${order}`, [org]));
  const byId = async (org, id) => (await admin`SELECT * FROM implementation WHERE org_id = ${org} AND implementation_id = ${id}`)[0];
  const sor = await import(root("agent/lib/system-of-record.ts"));
  const tools = await import(root("agent/lib/record-area-tools.ts"));
  const ctxFor = (email) => ({ session: { id: `sess-${TAG}-${email}`, auth: { current: { authenticator: "app", principalId: email, principalType: "user", attributes: { email } } } } });
  const tool = async (t, input, who) => Promise.resolve().then(() => t.execute(input, ctxFor(who))).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const nested = (patch, who = ANA) => sor.upsertCustomer(patch, orgOf[who], { actor: who }).then(() => "ok", (e) => String(e?.message ?? e));
  const sorted = (a) => [...a].sort().join();

  if (LABEL === "one") {
    // ---------------------------------------------------------------------- the default: one per account, as before
    const first = await call(ANA, "POST", "implementations", { body: { customerId: CO, implementationStage: "Discovery", implementationOwnerEmail: ANA } });
    const again = await call(ANA, "POST", "implementations", { body: { customerId: CO, implementationStage: "UAT" } });
    let held = await rows(A, CO);
    check("the route: a second create for one account updates its one row (201 each, as before)", first.status === 201 && again.status === 201 && held.length === 1 && held[0].implementation_stage === "UAT" && held[0].implementation_owner_email === ANA, { first, again, held });
    check("…its own id is the account's, and the answer's id is today's (the account)", held[0]?.implementation_id === CO && first.body?.item?.id === CO, { held: held[0]?.implementation_id, item: first.body?.item });
    const patched = await call(ANA, "PATCH", "implementations", { id: CO, body: { customerId: CO, implementationRiskLevel: "Red" } });
    check("PATCH by the account changes that row", patched.status === 200 && (await rows(A, CO))[0]?.implementation_risk_level === "Red", patched);
    const viaPatch = await nested({ id: CO, implementation: { implementationProgressPct: 55 } });
    held = await rows(A, CO);
    check("upsert_customer's `implementation` writes the same one row", viaPatch === "ok" && held.length === 1 && held[0].implementation_progress_pct === 55 && held[0].implementation_stage === "UAT", { viaPatch, held });
    const created = await nested({ id: CO2, name: "Other (A)", implementation: { implementationStage: "Kickoff", implementationProgressPct: 0, implementationRiskLevel: "Green", blockerOwner: "None" } });
    check("…and a new one is created with the account as its id", created === "ok" && (await rows(A, CO2))[0]?.implementation_id === CO2, created);
    const refused = await nested({ id: CO, implementations: [{ implementationId: "second", implementationStage: "Kickoff", implementationProgressPct: 0, implementationRiskLevel: "Green", blockerOwner: "None" }] });
    check("`implementations[]` is refused in a sentence: an account here holds one; nothing written", /^Nothing was written\. .*holds one .*send it as `implementation`/.test(refused) && (await rows(A, CO)).length === 1, refused);
    const record = await sor.getCustomer(CO, A);
    check("the record reads `implementation` without an id, and no `implementations`", record?.implementation?.implementationStage === "UAT" && !("implementationId" in (record?.implementation ?? {})) && !("implementations" in (record ?? {})), record?.implementation);
    const listed = await list(ANA);
    check("the list's ids are today's (the account), and carry no implementationId", listed.status === 200 && sorted(listed.body.items.map((i) => i.id)) === sorted([CO, CO2]) && listed.body.items.every((i) => !("implementationId" in i)), listed.body?.items?.map((i) => i.id));
    const wb = await call(ANA, "GET", "workbook");
    const wc = wb.body?.customers?.find((c) => c.id === CO);
    check("the workbook: `implementation` as before, without its id, and no `implementations`", wb.status === 200 && wc?.implementation?.implementationStage === "UAT" && !("implementationId" in (wc?.implementation ?? {})) && !("implementations" in (wc ?? {})), wc?.implementation);
    const del = await call(ANA, "DELETE", "implementations", { id: CO2, query: `customerId=${CO2}` });
    check("DELETE by the account removes its row", del.status === 200 && (await rows(A, CO2)).length === 0, del);
  }

  if (RENAMED) {
    // ---------------------------------------------- renamed own fields: rows under the old keys, read by the server
    // Four rows across two accounts (several on one when an account may hold them; else one each of four accounts).
    const accounts = MANY ? [CO, CO, CO2, CO2] : [CO, CO2, "regulator-three", "regulator-four"];
    for (const co of new Set(accounts)) await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${co}, ${A}, ${co}) ON CONFLICT DO NOTHING`;
    const seeds = [
      { code: "OLD-Q-150", custom: { framework_code: "OLD-Q-150", controls: 150, cycle: "Quarterly" } },
      { code: "NEW-A-40", custom: { framework_code: "NEW-A-40", control_count: 40, review_cycle: "Annual" } },
      { code: "OLD-M-5", custom: { framework_code: "OLD-M-5", controls: 5, cycle: "Monthly" } },
      // Both keys: the new one is what it holds (it was written after the rename).
      { code: "BOTH-Q-200", custom: { framework_code: "BOTH-Q-200", controls: 1, cycle: "Monthly", control_count: 200, review_cycle: "Quarterly" } },
    ];
    for (const [i, s] of seeds.entries()) {
      if (HAS_ID) {
        await admin`INSERT INTO implementation (org_id, customer_id, implementation_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, custom)
                    VALUES (${A}, ${accounts[i]}, ${MANY ? s.code : accounts[i]}, 'Kickoff', 0, 'Green', 'None', ${admin.json(s.custom)})`;
      } else {
        await admin`INSERT INTO implementation (org_id, customer_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, custom)
                    VALUES (${A}, ${accounts[i]}, 'Kickoff', 0, 'Green', 'None', ${admin.json(s.custom)})`;
      }
    }
    const codes = (r) => sorted((r.body?.items ?? []).map((i) => i.values?.framework_code));
    const all = await list(ANA);
    check("the list shows each row's renamed fields under the new keys (old rows included)", all.status === 200 && all.body.items.length === 4 && all.body.items.find((i) => i.values.framework_code === "OLD-Q-150")?.values?.control_count === 150 && all.body.items.find((i) => i.values.framework_code === "BOTH-Q-200")?.values?.review_cycle === "Quarterly", all.body?.items?.map((i) => i.values));
    const quarterly = await list(ANA, where({ review_cycle: "Quarterly" }));
    check("filtered on a renamed choice: the row stored under the old key is found, a stale old key under a new one is not", codes(quarterly) === "BOTH-Q-200,OLD-Q-150", quarterly.body);
    const monthly = await list(ANA, where({ review_cycle: { in: ["Monthly"] } }));
    check("…`in` likewise (only the old-key row; the row whose new key says otherwise is not)", codes(monthly) === "OLD-M-5", monthly.body);
    const notAnnual = await list(ANA, where({ review_cycle: { ne: "Annual" } }));
    check("…`ne` likewise", codes(notAnnual) === "BOTH-Q-200,OLD-M-5,OLD-Q-150", notAnnual.body);
    const big = await list(ANA, where({ control_count: { gte: 100 } }));
    check("filtered on a renamed number: the old-key row compared as a number", codes(big) === "BOTH-Q-200,OLD-Q-150", big.body);
    const bySort = await list(ANA, "sort=-control_count");
    check("sorted on a renamed number in the database: old and new keys in one order", (bySort.body?.items ?? []).map((i) => i.values.framework_code).join() === "BOTH-Q-200,OLD-Q-150,NEW-A-40,OLD-M-5", bySort.body?.items?.map((i) => i.values));
    const unset = await list(ANA, where({ control_count: { set: true } }));
    check("`set` reads the old key too", unset.body?.items?.length === 4, unset.body);
    const searched = await list(ANA, "q=Quarterly");
    check("searched in the database: the renamed choice's old value is found", codes(searched) === "BOTH-Q-200,OLD-Q-150", searched.body);
    const large = await list(ANA, where({ scale: "Large" }));
    const js = (all.body?.items ?? []).filter((i) => i.values.scale === "Large").map((i) => i.values.framework_code);
    check("a computed field over a renamed field, filtered in the database, means what the definition evaluates", codes(large) === "BOTH-Q-200,OLD-Q-150" && sorted(js) === codes(large), { sql: codes(large), js });
    const metrics = await call(ANA, "GET", "record-metrics", { query: "area=implementations" });
    const m = Object.fromEntries((metrics.body?.metrics ?? []).map((x) => [x.id, x.value]));
    check("the metrics count and add up the old-key rows (2 quarterly, 395 controls, 2 large)", metrics.status === 200 && m.quarterly === 2 && m.controls === 395 && m.large === 2, metrics.body);
    // Clearing a renamed field clears the old key too, so the old value does not come back.
    const old = all.body.items.find((i) => i.values.framework_code === "OLD-M-5");
    const cleared = await call(ANA, "PATCH", "implementations", { id: old.id, body: { customerId: old.customer, review_cycle: null } });
    const after = MANY ? await byId(A, "OLD-M-5") : (await rows(A, old.customer))[0];
    check("clearing a renamed field removes both keys: the old value does not come back", cleared.status === 200 && !("review_cycle" in after.custom) && !("cycle" in after.custom) && after.custom.controls === 5, { cleared, custom: after?.custom });
    const monthlyAfter = await list(ANA, where({ review_cycle: "Monthly" }));
    check("…and the list no longer finds it by that value", monthlyAfter.body?.items?.length === 0, monthlyAfter.body);
    // Workspace B: none of it.
    const theirs = await list(BEN, where({ review_cycle: "Quarterly" }));
    const theirMetrics = await call(BEN, "GET", "record-metrics", { query: "area=implementations" });
    check("workspace B's list and metrics hold none of A's rows", theirs.status === 200 && theirs.body.items.length === 0 && (theirMetrics.body?.metrics ?? []).every((x) => x.value === 0), { theirs: theirs.body, theirMetrics: theirMetrics.body });
    await admin`DELETE FROM implementation WHERE org_id = ${A}`;
  }

  if (MANY) {
    // ------------------------------------------------------------- several per account, each by its own id, everywhere
    const make = (code, extra = {}) => ({ customerId: CO, framework_code: code, control_count: 10, review_cycle: "Annual", ...extra });
    const first = await call(ANA, "POST", "implementations", { body: make("KYC-MD") });
    const second = await call(ANA, "POST", "implementations", { body: make("CYBER-FW") });
    let held = await rows(A, CO);
    const [id1, id2] = [first.body?.item?.id, second.body?.item?.id];
    check("the route: two creates for one account are two rows (201 each), each its own id", first.status === 201 && second.status === 201 && held.length === 2 && id1 && id2 && id1 !== id2 && sorted(held.map((r) => r.implementation_id)) === sorted([id1, id2]), { first, second, held: held.map((r) => [r.implementation_id, r.custom]) });
    check("…the first is not overwritten by the second", (await byId(A, id1))?.custom?.framework_code === "KYC-MD" && (await byId(A, id2))?.custom?.framework_code === "CYBER-FW");
    const named = await call(ANA, "POST", "implementations", { body: { ...make("SEBI-CSCRF"), implementationId: "sebi-cscrf" } });
    check("a create may name its id", named.status === 201 && named.body?.item?.id === "sebi-cscrf" && (await byId(A, "sebi-cscrf"))?.customer_id === CO, named);
    const upd = await call(ANA, "POST", "implementations", { body: { customerId: CO, implementationId: id1, control_count: 75 } });
    check("POST naming an id updates that row only", upd.status === 200 && upd.body?.updated === true && (await byId(A, id1))?.custom?.control_count === 75 && (await byId(A, id2))?.custom?.control_count === 10, upd);
    const badId = await call(ANA, "POST", "implementations", { body: { ...make("X"), implementationId: "has space" } });
    check("an id that is not one is refused (400), nothing written", badId.status === 400 && (await rows(A, CO)).length === 3, badId);
    const patched = await call(ANA, "PATCH", "implementations", { id: id2, body: { customerId: CO, implementationStage: "Discovery" } });
    check("PATCH /:id changes that row only", patched.status === 200 && (await byId(A, id2))?.implementation_stage === "Discovery" && (await byId(A, id1))?.implementation_stage === "Kickoff", patched);
    await admin`INSERT INTO customers (customer_id, org_id, customer_name) VALUES (${CO2}, ${A}, 'Other (A)') ON CONFLICT DO NOTHING`;
    const otherAccount = await call(ANA, "PATCH", "implementations", { id: id2, body: { customerId: CO2, implementationStage: "Go-Live" } });
    check("PATCH naming another account than the row's: 409, nothing changed", otherAccount.status === 409 && (await byId(A, id2))?.implementation_stage === "Discovery", otherAccount);
    const taken = await call(ANA, "POST", "implementations", { body: { ...make("TAKE"), customerId: CO2, implementationId: id1 } });
    check("a create under an id another account's row holds: 409, that row untouched", taken.status === 409 && (await byId(A, id1))?.customer_id === CO && (await byId(A, id1))?.custom?.framework_code === "KYC-MD", taken);
    const missing = await call(ANA, "PATCH", "implementations", { id: "no-such-row", body: { customerId: CO, implementationStage: "Discovery" } });
    check("PATCH of an id that is not there: 404", missing.status === 404, missing);
    const listed = await list(ANA);
    check("the list: one item per row, its id the row's own, implementationId carried", listed.status === 200 && listed.body.items.length === 3 && sorted(listed.body.items.map((i) => i.id)) === sorted([id1, id2, "sebi-cscrf"]) && listed.body.items.every((i) => i.implementationId === i.id && i.customer === CO), listed.body?.items?.map((i) => [i.id, i.implementationId]));
    const exp = await call(ANA, "GET", "export", { query: `type=implementation&id=${encodeURIComponent(id2)}` });
    check("the export of one implementation reads that row by its id", exp.status === 200 && exp.body?.record?.implementationId === id2 && exp.body?.record?.custom?.framework_code === "CYBER-FW", { status: exp.status, record: exp.body?.record?.implementationId, error: exp.body?.error });

    // upsert_customer's implementations[].
    const viaRows = await nested({ id: CO, implementations: [{ implementationId: "dpdp", implementationStage: "Kickoff", implementationProgressPct: 0, implementationRiskLevel: "Green", blockerOwner: "None", custom: { framework_code: "DPDP", control_count: 30 } }, { implementationId: id1, custom: { review_cycle: "Quarterly" } }] });
    check("upsert_customer: implementations[] creates one by its id and changes another by its id", viaRows === "ok" && (await byId(A, "dpdp"))?.custom?.framework_code === "DPDP" && (await byId(A, id1))?.custom?.review_cycle === "Quarterly" && (await byId(A, id1))?.custom?.control_count === 75 && (await rows(A, CO)).length === 4, viaRows);
    const record = await sor.getCustomer(CO, A);
    check("the record reads every row in implementations[], each with its id, and no `implementation`", sorted((record?.implementations ?? []).map((r) => r.implementationId)) === sorted([id1, id2, "sebi-cscrf", "dpdp"]) && !("implementation" in (record ?? {})), record?.implementations?.map((r) => r.implementationId));
    const one = await nested({ id: CO, implementation: { implementationStage: "UAT" } });
    check("`implementation` is refused in a sentence: an account here may hold several; nothing changed", /^Nothing was written\. .*may hold several .*send them as `implementations`/.test(one) && (await rows(A, CO)).length === 4 && (await rows(A, CO)).every((r) => r.implementation_stage !== "UAT"), one);
    const crossNested = await nested({ id: CO2, implementations: [{ implementationId: id2, implementationStage: "Kickoff", implementationProgressPct: 0, implementationRiskLevel: "Green", blockerOwner: "None", custom: { framework_code: "STOLEN" } }] });
    check("upsert_customer: an id another account's row holds is refused, that row untouched", /another .*'s/.test(crossNested) && (await byId(A, id2))?.customer_id === CO && (await byId(A, id2))?.custom?.framework_code === "CYBER-FW", crossNested);
    const removed = await nested({ id: CO, implementations: [{ implementationId: "dpdp", remove: true }] });
    check("upsert_customer: remove: true deletes that row only", removed === "ok" && !(await byId(A, "dpdp")) && (await rows(A, CO)).length === 3, removed);

    // The per-area tools.
    const upsert = tools.upsertAreaTool("implementations");
    const listTool = tools.listAreaTool("implementations");
    const made = await tool(upsert, { customerId: CO, values: { framework_code: "RBI-ITGRC", control_count: 12 } }, ANA);
    const madeId = made?.record?.implementationId;
    check("upsert_implementation without an id creates a new one and answers its id", made.created === true && typeof madeId === "string" && (await byId(A, madeId))?.custom?.framework_code === "RBI-ITGRC" && (await rows(A, CO)).length === 4, made);
    const changed = await tool(upsert, { customerId: CO, implementationId: madeId, values: { control_count: 13 } }, ANA);
    check("upsert_implementation with its id changes that one", changed.updated === true && (await byId(A, madeId))?.custom?.control_count === 13 && (await rows(A, CO)).length === 4, changed);
    const toolCross = await tool(upsert, { customerId: CO2, implementationId: madeId, values: { control_count: 1 } }, ANA);
    check("upsert_implementation naming another account's row: refused, untouched", typeof toolCross.error === "string" && (await byId(A, madeId))?.custom?.control_count === 13, toolCross);
    const toolList = await tool(listTool, { where: { framework_code: "RBI-ITGRC" } }, ANA);
    check("list_implementations returns each row's implementationId", toolList.items?.length === 1 && toolList.items[0].implementationId === madeId, toolList);

    // The MCP tools (setup/workspace-tools.mjs), against the real routes.
    const { createTools } = await import(root("setup/workspace-tools.mjs"));
    const api = async (method, path, body) => {
      const [p, q] = path.replace(/^\/api\/ops\//, "").split("?");
      const r = await call(ANA, method, p, { body, query: q });
      if (r.status >= 400) throw new Error(r.body?.error ?? String(r.status));
      return r.body;
    };
    const { FOLDER } = await import(root("agent/lib/dataroom-folders.ts"));
    const mcp = Object.fromEntries(createTools({ api, actor: ANA, folders: FOLDER, manyImplementations: true }).map((t) => [t.name, t]));
    check("MCP implementation_upsert takes an implementationId", mcp.implementation_upsert?.inputSchema?.properties?.implementationId?.type === "string");
    const mcpMade = JSON.parse(await mcp.implementation_upsert.handler({ customerId: CO, custom: { framework_code: "MCP-NEW" } }));
    const mcpId = mcpMade?.item?.id;
    await mcp.implementation_upsert.handler({ customerId: CO, implementationId: mcpId, implementationStage: "Discovery" });
    check("MCP implementation_upsert creates a new one, then changes it by its id", typeof mcpId === "string" && (await byId(A, mcpId))?.implementation_stage === "Discovery" && (await rows(A, CO)).length === 5, mcpMade);
    const mcpList = JSON.parse(await mcp.implementation_list.handler({}));
    check("MCP implementation_list returns each row's implementationId", Array.isArray(mcpList) && mcpList.length === 5 && mcpList.every((r) => typeof r.implementationId === "string" && r.customerId === CO), mcpList.map?.((r) => r.implementationId));
    const plainMcp = Object.fromEntries(createTools({ api, actor: ANA, folders: FOLDER }).map((t) => [t.name, t]));
    check("…a host that does not say keeps today's tools (no implementationId)", !("implementationId" in (plainMcp.implementation_upsert?.inputSchema?.properties ?? {})));

    // The metrics and the workbook.
    const metrics = await call(ANA, "GET", "record-metrics", { query: "area=implementations" });
    const m = Object.fromEntries((metrics.body?.metrics ?? []).map((x) => [x.id, x.value]));
    const stored = await rows(A);
    const sum = stored.reduce((n, r) => n + (typeof r.custom.control_count === "number" ? r.custom.control_count : 0), 0);
    check("the metrics count every row of the account (5 rows; the controls added up over all of them)", metrics.status === 200 && m.controls === sum && m.quarterly === stored.filter((r) => r.custom.review_cycle === "Quarterly").length, { metrics: metrics.body, sum });
    const wb = await call(ANA, "GET", "workbook");
    const wc = wb.body?.customers?.find((c) => c.id === CO);
    check("the workbook: implementations[] with every row and its id, no `implementation`", wb.status === 200 && (wc?.implementations ?? []).length === 5 && wc.implementations.every((r) => typeof r.implementationId === "string") && !("implementation" in (wc ?? {})), wc?.implementations?.map((r) => r.implementationId));
    const { buildCustomerWorkbookSpecs } = await import(root("agent/lib/workbook-spec.ts"));
    const specs = await buildCustomerWorkbookSpecs({ customerId: CO, now: new Date(), orgId: A });
    const sheet = specs.flatMap((x) => x.sheets).find((x) => x.columns?.includes("implementation_id"));
    check("the account's workbook sheet lists one row per implementation, headed by its id", Boolean(sheet) && sheet.rows.length === 5 && sheet.columns[1] === "implementation_id" && sorted(sheet.rows.map((r) => r[1])) === sorted(stored.map((r) => r.implementation_id)), sheet?.columns);

    // DELETE by id, and workspace B.
    const del = await call(ANA, "DELETE", "implementations", { id: id2, query: `customerId=${CO}` });
    check("DELETE /:id removes that row only", del.status === 200 && !(await byId(A, id2)) && (await rows(A, CO)).length === 4, del);
    const before = JSON.stringify(await admin`SELECT to_jsonb(i) AS r FROM implementation i WHERE org_id = ${A} ORDER BY implementation_id`);
    const theirList = await list(BEN);
    check("workspace B's list (its own account of the same id) holds none of A's rows", theirList.status === 200 && theirList.body.items.length === 0, theirList.body);
    const theirPatch = await call(BEN, "PATCH", "implementations", { id: id1, body: { customerId: CO, implementationStage: "Go-Live" } });
    check("B cannot change A's row by its id (404)", theirPatch.status === 404, theirPatch);
    const theirDelete = await call(BEN, "DELETE", "implementations", { id: id1, query: `customerId=${CO}` });
    check("…nor delete it (404)", theirDelete.status === 404, theirDelete);
    const theirCreate = await call(BEN, "POST", "implementations", { body: { customerId: CO, implementationId: id1, framework_code: "B-OWN" } });
    check("B naming A's id creates B's own row in B, A's untouched", theirCreate.status === 201 && (await byId(B, id1))?.custom?.framework_code === "B-OWN" && (await byId(A, id1))?.custom?.framework_code === "KYC-MD", theirCreate);
    const theirTool = await tool(upsert, { customerId: CO, implementationId: madeId, values: { control_count: 999 } }, BEN);
    check("B's tool naming A's id writes B's own row, never A's", (await byId(A, madeId))?.custom?.control_count === 13, theirTool);
    const theirNested = await nested({ id: CO, implementations: [{ implementationId: "sebi-cscrf", custom: { control_count: 999 } }] }, BEN);
    check("B's upsert_customer naming A's id cannot change A's row", (await byId(A, "sebi-cscrf"))?.custom?.control_count !== 999, theirNested);
    const theirMetrics = await call(BEN, "GET", "record-metrics", { query: "area=implementations" });
    check("B's metrics count none of A's rows", (theirMetrics.body?.metrics ?? []).find((x) => x.id === "controls")?.value !== m.controls, theirMetrics.body);
    const app = postgres(process.env.DATABASE_URL, { ssl, prepare: false, max: 1, onnotice: () => {} });
    closers.push(() => app.end({ timeout: 2 }));
    const asB = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${B}, true)`;
      return {
        read: (await tx`SELECT 1 FROM implementation WHERE org_id = ${A}`).length,
        wrote: (await tx`UPDATE implementation SET custom = custom || '{"planted": true}'::jsonb WHERE org_id = ${A} RETURNING implementation_id`).length,
      };
    });
    check("under RLS, workspace B reads none of A's rows and changes none", asB.read === 0 && asB.wrote === 0, asB);
    check("A's rows are byte for byte what they were", JSON.stringify(await admin`SELECT to_jsonb(i) AS r FROM implementation i WHERE org_id = ${A} ORDER BY implementation_id`) === before);
  }
} catch (e) {
  failures++;
  console.log(`  FAIL [${LABEL}] the probe threw — ${e?.stack ?? e}`);
} finally {
  await cleanup().catch(() => undefined);
  for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`implementation-ids-db-probe [${LABEL}]: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
