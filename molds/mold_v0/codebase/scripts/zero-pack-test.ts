// A shell with no packs has none of the product's tables, and nothing of it reads them (mold_v0-049).
//   npm run test:zero-pack
// The product's tables (products, scenarios, simulations and their sessions, personas, tasks, populations, journeys,
// ...) left the shell's base schema for its host pack's migrations. This proves, in a build with no host pack:
//   1. a database built by the shell's migrations has none of them (the tables the pre-049 baseline created and the
//      shell's migrations no longer do: scripts/fixtures/pre-049-migrations/0001_baseline.sql)
//   2. the session engine, which stays in the shell and reads them in a build that has them, is dormant: every GET
//      route of the admin console's API (/api/admin/*) and of the portal's (/api/app/*), walked from the app's own router,
//      answers without a server error for an owner, with no database error logged
//   3. the admin MCP's tools, their schemas and the server's instructions name none of the product's words (its job
//      tools named for simulations are the host pack's)
// In a build whose host pack owns those tables (pack.json host.schema) step 1 checks the opposite (all of them there)
// and steps 2 and 3 are skipped: the product's own surface is the pack's to prove (its smoke and mcp:check).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import { ENV } from "../src/env-names.js";

const ROOT = path.resolve(import.meta.dirname, "..");
// Record every route and mount while the app is built (express 5 keeps no mount paths): the same walk as the console's
// route table, so a route added later is swept too.
const req = createRequire(path.join(ROOT, "package.json"));
const Router = req("router");
const proto = Router.prototype ?? Object.getPrototypeOf(Router());
const uses = new Map<any, { path: string; child: any }[]>(), routes = new Map<any, { path: string; route: any }[]>();
const origUse = proto.use, origRoute = proto.route;
proto.use = function (this: any, ...args: any[]) {
  let p: any = "/", fns = args;
  if (typeof args[0] !== "function") { p = args[0]; fns = args.slice(1); }
  const list = uses.get(this) ?? []; uses.set(this, list);
  for (const fn of fns.flat(Infinity)) {
    const child = fn && typeof fn === "function" && Array.isArray(fn.stack) ? fn : (fn && fn.router && Array.isArray(fn.router.stack) ? fn.router : null);
    if (child) for (const pp of [p].flat()) list.push({ path: String(pp), child });
  }
  return origUse.apply(this, args);
};
proto.route = function (this: any, p: any) {
  const r = origRoute.call(this, p);
  const list = routes.get(this) ?? []; routes.set(this, list);
  for (const pp of [p].flat()) list.push({ path: String(pp), route: r });
  return r;
};

// Database errors the server logs while answering (a missing relation is 42P01): none may happen.
const logged: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${(x as { code?: string }).code ?? ""}` : String(x))).join(" ")); origError(...a); };

/**
 * The product's tables: the 21 the pre-049 baseline created that the shell's migrations no longer do (its account
 * context and memory tables are the shell's again since mold_v0-142: 0024_account_context_memory).
 */
const PRODUCT_TABLES = ["adoption_help", "agent_sessions", "developer_population_agents", "developer_populations",
  "developer_profiles", "journey_progress", "journey_seed", "journey_templates", "library_submissions", "library_tasks", "nudge_prefs", "nudges",
  "org_harnesses", "org_task_sets", "product_personas", "product_research", "products", "scenarios", "simulations", "transcript_events",
  "visibility_reports"];
const MOVED = (() => {
  const names = (sql: string) => new Set([...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase()));
  const before = names(readFileSync(path.join(ROOT, "scripts", "fixtures", "pre-049-migrations", "0001_baseline.sql"), "utf8"));
  const now = new Set(readdirSync(path.join(ROOT, "sql", "migrations")).filter((f) => f.endsWith(".sql")).flatMap((f) => [...names(readFileSync(path.join(ROOT, "sql", "migrations", f), "utf8"))]));
  return [...before].filter((t) => !now.has(t)).sort();
})();

try {
  const { getDb } = await import("../src/db.js");
  const { hostTable, sessionEngine } = await import("../src/host-tables.js");
  const db = await getDb();
  const tables = new Set((await db.query<{ t: string }>("SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')")).map((r) => r.t));
  const owned = PRODUCT_TABLES.filter(hostTable);
  if (owned.length) {
    assert.deepEqual(owned, PRODUCT_TABLES, "a host pack owns all of the product's tables, or none");
    assert.deepEqual(PRODUCT_TABLES.filter((t) => !tables.has(t)), [], "with its host pack a new database has every one of them");
    console.log(`✓ with the host pack: a new database has all ${PRODUCT_TABLES.length} product tables (its migrations made them); the rest is the pack's to prove`);
  } else {
    assert.equal(sessionEngine(), false, "no host pack: the session engine is dormant");
    assert.deepEqual(PRODUCT_TABLES.filter((t) => tables.has(t)), [], "a new database has none of the product's tables");
    assert.deepEqual(MOVED, PRODUCT_TABLES, "they are exactly the tables the pre-049 baseline made and the shell's migrations no longer do");
    console.log(`✓ zero packs: a new database has none of the ${PRODUCT_TABLES.length} product tables (${tables.size} tables, all the shell's)`);

    // ---------- 2. every admin and portal GET route answers without a server error ----------
    const http = await startHttp();
    const { createOrg, createApiKey } = await import("../src/auth.js");
    const { org } = await createOrg(`Zero ${STAMP}`);
    await createApiKey(org.orgId);
    const owner = await http.signIn(org, "owner");
    const admin = await http.adminToken("owner");
    const { createApp } = await import("../src/http.js");
    const app = createApp();
    const found = new Set<string>();
    const join = (a: string, b: string) => (a.replace(/\/$/, "") + (b === "/" ? "" : b)) || "/";
    const walk = (r: any, prefix: string, seen = new Set<any>()) => {
      if (seen.has(r)) return;
      seen.add(r);
      for (const x of routes.get(r) ?? []) if (x.route.methods?.get) found.add(join(prefix, x.path));
      for (const u of uses.get(r) ?? []) walk(u.child, join(prefix, u.path), seen);
      seen.delete(r);
    };
    walk(app.router, "");
    // Path parameters get a value of the right shape: the workspace's slug, ids that name nothing.
    const fill = (p: string) => p.replace(/:slug\b/g, org.slug).replace(/:(id|key|n)\b/g, "1").replace(/:[a-zA-Z_]+/g, "x").replace(/\*[a-zA-Z_]*|\{[^}]*\}/g, "");
    const sweep = [...found].filter((p) => /^\/api\/(admin|app)(\/|$)/.test(p)).sort();
    assert.ok(sweep.length > 40, `the sweep found the console's routes (${sweep.length})`);
    const failures: string[] = [];
    for (const p of sweep) {
      const url = fill(p);
      const auth: Record<string, string> = p.startsWith("/api/admin") ? { authorization: `Bearer ${admin}`, "x-app-admin": "1" } : { authorization: `Bearer ${owner}` };
      const before = logged.length;
      const r = await http.req("GET", url, auth);
      const body = await r.text();
      const dbErrors = logged.slice(before).filter((l) => /relation .* does not exist|42P01|42703|column .* does not exist/.test(l));
      if (r.status >= 500 || dbErrors.length) failures.push(`GET ${url} -> ${r.status}${dbErrors.length ? ` (${dbErrors[0]!.slice(0, 160)})` : ""} ${body.slice(0, 160)}`);
    }
    assert.deepEqual(failures, [], "every admin and portal GET answers without a server error or a missing table");
    console.log(`✓ zero packs: ${sweep.length} admin and portal GET routes answer for an owner with no server error and no missing table`);

    // The worker API (the fleet token) and the engine's background work: nothing to claim, no session, nothing fails.
    const fleet = { authorization: `Bearer ${ENV.APP_WORKER_TOKEN}` };
    const worker: [string, string, unknown?][] = [["POST", "/api/worker/claim", { worker_id: "w-zero", limit: 5 }], ["GET", "/api/worker/fleet"],
      ["POST", "/api/worker/fleet", { orchestrator_id: "orch-zero", capacity: 2 }], ["POST", "/api/worker/sessions/ses_none/events", { events: [] }],
      ["POST", "/api/worker/sessions/ses_none/heartbeat", {}], ["POST", "/api/worker/sessions/ses_none/complete", { status: "completed" }],
      ["POST", "/api/worker/sessions/ses_none/credentials", {}]];
    const answers: string[] = [], workerFailures: string[] = [];
    for (const [m, p, body] of worker) {
      const before = logged.length;
      const r = await http.req(m, p, fleet, body);
      const text = await r.text();
      const dbErrors = logged.slice(before).filter((l) => /relation .* does not exist|42P01|42703/.test(l));
      if (r.status >= 500 || dbErrors.length) workerFailures.push(`${m} ${p} -> ${r.status} ${text.slice(0, 160)}`);
      answers.push(`${m} ${p} ${r.status}${p.endsWith("/claim") ? ` ${text.slice(0, 40)}` : ""}`);
    }
    assert.deepEqual(workerFailures, [], "the worker API answers without a server error or a missing table");
    const { computeDemand, computeJobDemand } = await import("../src/autoscaler.js");
    const { sweepStale } = await import("../src/worker.js");
    const { archiveSweep } = await import("../src/archive.js");
    const { deleteOrg } = await import("../src/tenancy.js");
    assert.deepEqual(await computeDemand(), { sessions: 0, queued_sessions: 0, research: 0, unclaimable_sessions: 0 }, "no session or research demand");
    assert.deepEqual(await computeJobDemand(), [], "no job wants an orchestrator");
    assert.equal(await sweepStale(), 0);
    assert.deepEqual(await archiveSweep(), { sessions: 0, research: 0, failed: 0 });
    const gone = await deleteOrg(org.orgId);
    assert.deepEqual({ ...gone.counts, api_keys: gone.counts.api_keys > 0 }, { api_keys: true, simulations: 0, sessions: 0, research: 0, objects: 0 }, "deleting a workspace touches no product table");
    assert.equal((await db.query("SELECT 1 FROM organizations WHERE id = $1", [org.orgId])).length, 0, "and the workspace is gone");
    console.log(`✓ zero packs: the worker API (${answers.join("; ")}), the autoscaler's demand, the stale sweep, the archive and deleting a workspace touch no product table`);

    // ---------- 3. the admin MCP names none of the product's words ----------
    const { adminToolList, adminTools } = await import("../src/admin-mcp.js");
    const WORDS = /\b(simulations?|scenarios?|personas?|journeys?|competitors?|pick[ -]rate|playbooks?)\b/i;
    const tools = adminTools();
    const said = Object.entries(tools).flatMap(([name, t]) => [name, t.title, t.description, JSON.stringify(Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, (v as { description?: string }).description ?? ""])))])
      .concat(adminToolList().map((t) => `${t.name} ${t.title}`));
    assert.deepEqual(said.filter((x) => WORDS.test(x)), [], "no admin tool's name, title, description or input names the product");
    console.log(`✓ zero packs: the admin MCP's ${Object.keys(tools).length} tools name none of the product's words`);
    await http.close();
  }
} finally {
  console.error = origError;
  cleanup();
}
process.exit(0);
