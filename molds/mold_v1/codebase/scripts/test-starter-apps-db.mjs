/**
 * A WORKSPACE SHOWS ONLY ITS OWN WORKFLOWS AND APPS, AND OPENS WITH ITS LIBRARY'S STARTER APPS — through the real
 * routes, against a real Postgres, in a deployment shaped like a research pack's.
 *
 * Two promises, each proved in a copy of the tree stamped the way the software factory stamps one (the relabelling
 * fixture profile scripts/fixtures/agent-vocabulary/50-relabelled.json, which mirrors the research pack: companies
 * and analysts, four base specialists excluded; plus a FIXTURE specialist the base product does not have,
 * scripts/fixtures/app-source/ stamped in as agent/subagents/ledger-reader/):
 *
 *   A. ITS OWN, AND NOTHING ELSE (the build names NO library, as the default does). A workspace created through
 *      POST /api/ops/orgs is asked for every list a person or the model reads: the Workflows tab, the app source
 *      picker, the Apps tab, the recipes, the specialists (the generated roster, the agent-configs API, the published
 *      tools' agent_list), the agent's own list tool, this deployment's MCP server (its tool list and its list
 *      tools), the workspace health check and the model-facing surface. None of them may name a workflow, a recipe
 *      or a starter app of library/account-delivery, or a specialist the profile excludes; and what IS listed is
 *      exactly one row per specialist the build has.
 *      Then the cleanup: a starter app left by a library this build does not name is removable while untouched, and
 *      kept once a person edited, opened or refreshed it.
 *
 *   B. STARTER APPS (the build names a pack-shaped fixture library and library/account-delivery:
 *      scripts/fixtures/starter-apps/60-library.json).
 *        1. a NEW workspace gets exactly its libraries' starter apps, created by "system", with no document, and the
 *           agent was never called: creating a workspace runs no model (but for the one app whose library says
 *           first_content "on_create", which is written as the person who created the workspace);
 *        2. the Apps tab lists them, in this deployment's words, each with a source that can run;
 *        3. FIRST OPEN writes the document through the specialist, once: a second ask starts nothing; a library
 *           workflow's app runs its script durably; the scheduled refresh writes one too;
 *        4. IDEMPOTENT: provisioning again creates nothing and changes nothing a person edited;
 *        5. DELETED, NOT RESURRECTED: a starter app a person deleted stays deleted through provisioning and apply;
 *        6. an EXISTING workspace gets nothing from a deploy or from provisioning's --force path: only
 *           `operator:library-apply`, whose dry run writes nothing, whose --apply adds exactly what the dry run
 *           listed, and whose second --apply adds nothing;
 *        7. another workspace sees none of it (rows are the workspace's own, under the fail-closed policy).
 *
 * Each route is the real handler, called as the console calls it (a member's session token, the workspace header).
 * The agent is a stand-in at the web app's `fetch`: it records what it was asked and answers a document, so
 * "content" means the bytes the route stored. The database is a real Postgres, as app_rw under the fail-closed
 * policies. Nothing in this checkout is modified: each part re-runs this file inside its own stamped copy.
 *
 * On the commit before this change it fails: there is no starter key, provisioning creates no app, the published
 * tools list ten built-in specialists whatever the profile says, and the workflow tool's own description names
 * library workflows. See the pull request for that run.
 *
 * Without ADMIN_URL and DATABASE_URL the database parts are skipped and only what needs none runs.
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:starter-apps-db
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PART = process.argv.find((a) => a.startsWith("--stamped="))?.slice("--stamped=".length) ?? null;
const SPECIALIST = "ledger-reader";
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

let passed = 0;
let failures = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}${detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1200)}`}`);
  }
};

/* ================================================================================================================ */
/* The outer run: stamp one copy of the tree per part and run this file inside it.                                   */
/* ================================================================================================================ */
if (!PART) {
  let status = 0;
  for (const part of ["own", "starter"]) {
    const dir = mkdtempSync(join(tmpdir(), `starter-apps-${part}-`));
    try {
      for (const e of ["agent", "app", "lib", "components", "data", "scripts", "library", "profiles", "setup", "package.json", "tsconfig.json", "dm.md"]) {
        if (existsSync(join(HERE, e))) cpSync(join(HERE, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes("/.eve") && !s.endsWith(".tgz") });
      }
      cpSync(join(HERE, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "profiles/50-relabelled.json"));
      // Part B names a library; part A names none, like the default profile.
      if (part === "starter") cpSync(join(HERE, "scripts/fixtures/starter-apps/60-library.json"), join(dir, "profiles/60-library.json"));
      mkdirSync(join(dir, "agent/subagents", SPECIALIST), { recursive: true });
      cpSync(join(HERE, "scripts/fixtures/app-source/ledger-reader.agent.ts.txt"), join(dir, "agent/subagents", SPECIALIST, "agent.ts"));
      symlinkSync(join(HERE, "node_modules"), join(dir, "node_modules"), "dir");
      // The stamping sequence: the registry (with the pack's specialist, without the excluded ones), the profile,
      // then the library the profile names.
      for (const s of ["scripts/gen-subagent-meta.mjs", "scripts/gen-deployment-profile.mjs", "scripts/build-workflow-library.mjs"]) {
        const r = spawnSync(process.execPath, [s], { cwd: dir, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${s} failed in the stamped copy (${part}):\n${r.stderr || r.stdout}`);
      }
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/test-starter-apps-db.mjs", `--stamped=${part}`],
        { cwd: dir, env: process.env, stdio: "inherit" },
      );
      if (r.status !== 0) status = r.status ?? 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(status);
}

/* ================================================================================================================ */
/* Inside a stamped copy.                                                                                           */
/* ================================================================================================================ */
register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.endsWith("?raw")) {
          const r = await n(s.slice(0, -4), c);
          return { ...r, url: r.url + "?raw", format: "module", shortCircuit: true };
        }
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }
      export async function load(url, context, next) {
        if (url.endsWith("?raw")) {
          const text = readFileSync(fileURLToPath(url.slice(0, -4)), "utf8");
          return { format: "module", source: "export default " + JSON.stringify(text) + ";", shortCircuit: true };
        }
        return next(url, context);
      }`),
  import.meta.url,
);

const vocab = await import("../agent/lib/agent-vocabulary.ts");
const V = vocab.VOCABULARY;
const generated = await import("../agent/lib/workflow-library.generated.ts");
const view = await import("../agent/lib/workflow-library-view.ts");
const { readLibrary } = await import("./lib/profile-library.mjs");

// What must never be shown to a workspace whose build does not name it: everything library/account-delivery ships.
const OPT_IN = readLibrary(process.cwd(), { "account-delivery": "library/account-delivery" });
const FOREIGN = {
  workflows: OPT_IN.workflows.map((w) => w.name),
  recipes: OPT_IN.recipes.map((r) => r.slug),
  recipeTitles: OPT_IN.recipes.map((r) => r.title),
  // (`?? []`: on the code before starter apps existed the library reader returns none, and the audit below still runs.)
  apps: (OPT_IN.apps ?? []).map((a) => a.name.replace(/\{[A-Za-z_:]+\}\s*/g, "").trim()),
  appKeys: (OPT_IN.apps ?? []).map((a) => a.key),
};
const EXCLUDED = V.excludedSpecialists;
/** Every name of a foreign library's content found in a text (whole names, never substrings of a longer name). */
const foreignIn = (text, { recipes = true } = {}) => {
  const names = [...FOREIGN.workflows, ...FOREIGN.apps, ...FOREIGN.appKeys, ...(recipes ? [...FOREIGN.recipes, ...FOREIGN.recipeTitles] : [])];
  return names.filter((n) => new RegExp(`(?<![A-Za-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`).test(text));
};
/** A specialist's key as a NAME: a quoted value or a code span. (The words "deployment" and "configuration" are prose elsewhere.) */
const excludedNamedIn = (text) => EXCLUDED.filter((k) => new RegExp(`["'\`]${k}["'\`]`).test(text));
/** In the published tools "deployment" is also a record type's value, so there an excluded specialist is told by a key no other thing has. */
const excludedKeyIn = (text) => EXCLUDED.filter((k) => k.includes("-") && text.includes(k));

console.log(`\n${PART === "own" ? "A" : "B"}.0 The deployment under test (${PART === "own" ? "names no library" : "names a pack-shaped library and the opt-in one"})`);
check("the stamped copy is relabelled (an account is a company) and excludes base specialists", V.relabelled === true && vocab.fill("{account}") === "company" && EXCLUDED.length === 4, { relabelled: V.relabelled, excluded: EXCLUDED });
check(`it has the fixture specialist "${SPECIALIST}", which the base product does not`, V.specialists.includes(SPECIALIST), V.specialists);
check("the opt-in library ships workflows, recipes and starter apps to look for", FOREIGN.workflows.length === 13 && FOREIGN.recipes.length === 5 && FOREIGN.apps.length >= 2, { w: FOREIGN.workflows.length, r: FOREIGN.recipes.length, a: FOREIGN.apps });
if (PART === "own") {
  check("this build names no library: no workflow, no recipe, no starter app is compiled in", generated.LIBRARY_SOURCES.length === 0 && generated.WORKFLOW_LIBRARY.length === 0 && generated.RECIPE_LIBRARY.length === 0 && generated.STARTER_APP_LIBRARY?.length === 0, generated.LIBRARY_SOURCES);
} else {
  check("this build names both libraries", generated.LIBRARY_SOURCES.join(",") === "account-delivery,desk-research", generated.LIBRARY_SOURCES);
  check("six starter apps are compiled in: the pack-shaped library's three and the opt-in library's three", generated.STARTER_APP_LIBRARY?.length === 6 && generated.STARTER_APP_LIBRARY.every((a) => a.key.startsWith(`${a.library}/`)), generated.STARTER_APP_LIBRARY?.map((a) => a.key));
}

/* ---- A.1 what needs no database: the surfaces a build bakes in ---------------------------------------------------- */
if (PART === "own") {
  console.log("\nA.1 What the build bakes in names no foreign library and no excluded specialist");
  const meta = await import("../app/_components/subagent-meta.generated.ts");
  const registry = await import("../agent/lib/subagent-registry.generated.ts");
  const rosterKeys = Object.keys(meta.SUBAGENT_META);
  check("the specialists roster the UI lists is this build's: the pack's specialist in, the excluded ones out", rosterKeys.includes(SPECIALIST) && !rosterKeys.some((k) => EXCLUDED.includes(k)), rosterKeys);
  check("…and so is the registry the agent provisions rows from", registry.SUBAGENT_KEYS.includes(SPECIALIST) && !registry.SUBAGENT_KEYS.some((k) => EXCLUDED.includes(k)), registry.SUBAGENT_KEYS);

  // Everything the model reads that this repository authors, rendered for THIS build (scripts/lib/model-surface.mjs).
  const surface = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/lib/model-surface.mjs", "--no-results"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  check("the model-facing surface renders", surface.status === 0 && surface.stdout.length > 10_000, (surface.stderr || "").slice(-600));
  check("no prompt, tool description or parameter names a workflow, recipe or app of a library this build does not name", foreignIn(surface.stdout).length === 0, foreignIn(surface.stdout));
  const rosterTools = [...surface.stdout.matchAll(/eve:subagent:([a-z0-9-]+)/g)].map((m) => m[1]);
  check("the model's roster has no excluded specialist", !rosterTools.some((k) => EXCLUDED.includes(k)) && excludedNamedIn(surface.stdout).length === 0, { rosterTools: [...new Set(rosterTools)], named: excludedNamedIn(surface.stdout) });

  // The published tools (setup/workspace-tools.mjs: the npm package and this deployment's MCP server) as shipped.
  const toolsSource = readFileSync("setup/workspace-tools.mjs", "utf8");
  check("the published tools carry no specialist list of their own (they ask the server)", !/SUBAGENT_IDS|Built in:/.test(toolsSource) && excludedKeyIn(toolsSource).length === 0, excludedKeyIn(toolsSource));
  check("…and name no workflow, recipe or app of the opt-in library", foreignIn(toolsSource).length === 0, foreignIn(toolsSource));
}

if (!adminUrl || !appUrl) {
  console.log(`\ntest-starter-apps-db (${PART}): the database part is SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).`);
  console.log(`test-starter-apps-db (${PART}): ${passed} check(s) passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

/* ---- a deployment that reaches its agent as the person asking (the console) and as itself (the cron) -------------- */
for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
delete process.env.GOOGLE_CLIENT_ID;
process.env.SERVICE_AUTH = "session-key";
const CRON_SECRET = `cron-${randomUUID()}`;
process.env.CRON_SECRET = CRON_SECRET;
const AGENT = "https://agent.starter-apps.test";
process.env.NEXT_PUBLIC_EVE_API_URL = AGENT; // read at import by lib/workflow-delegate.ts
const STORE = mkdtempSync(join(tmpdir(), "starter-apps-store-"));
Object.assign(process.env, { STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: STORE, STORAGE_SIGNING_SECRET: randomUUID(), STORAGE_PUBLIC_URL: "https://web.starter-apps.test" });
const { exportPKCS8, exportSPKI, generateKeyPair } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

const postgres = (await import("postgres")).default;
const stamp = `${Date.now()}-${process.pid}`;
const HOME = `starter-home-${stamp}`; // the workspace the analyst already belongs to: an EXISTING one
const OTHER = `starter-other-${stamp}`; // somebody else's workspace
const LEFT = `starter-left-${stamp}`; // a workspace an earlier build left starter apps in
const ANALYST = `analyst-${stamp}@starter.test`;
const OUTSIDER = `outsider-${stamp}@starter.test`;
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const created = new Set([HOME, OTHER, LEFT]);
const cleanup = async () => {
  await admin`DELETE FROM platform_admins WHERE email IN (${ANALYST}, ${OUTSIDER})`.catch(() => undefined);
  for (const org of created) {
    for (const t of ["app_versions", "apps", "workflow_run_journal", "workflow_runs", "automation_runs", "automation_audit", "workflows", "recipes", "agent_configs", "agent_session_scopes", "agent_session_owners", "org_members"]) {
      await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch(() => undefined);
    }
    await admin`DELETE FROM orgs WHERE org_id = ${org}`.catch(() => undefined);
  }
  rmSync(STORE, { recursive: true, force: true });
};

/* ---- the agent, at the web app's fetch: it records what it was asked and answers a document ----------------------- */
const asked = []; // { message, scope, who }
const sessions = new Map();
const DOCUMENT = (who) => `# Balance sheets\n\n| Company | Total assets (Rs crore) | Source |\n|---|---|---|\n| Acme Housing | 1,240 | AR FY26 p.112 |\n\n_Written by ${who}._`;
const delegatedTo = (message) => /Delegate this task to the `([a-z0-9-]+)` subagent/.exec(message)?.[1] ?? null;
const realFetch = globalThis.fetch;
let agentDelayMs = 0;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (!request.url.startsWith(AGENT)) return realFetch(input, init);
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/eve/v1/session") {
    const { message } = await request.json();
    const id = `wrun_starter_${sessions.size + 1}`;
    const who = delegatedTo(message) ?? "the orchestrator";
    sessions.set(id, { message, answer: DOCUMENT(who) });
    asked.push({ message, scope: request.headers.get("x-workspace-scope"), who });
    if (agentDelayMs) await new Promise((r) => setTimeout(r, agentDelayMs));
    return Response.json({ sessionId: id }, { status: 202 });
  }
  const stream = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(url.pathname);
  if (request.method === "GET" && stream) {
    const s = sessions.get(decodeURIComponent(stream[1]));
    if (!s) return new Response("no session", { status: 404 });
    const events = [
      { type: "session.started", data: {} },
      { type: "message.completed", data: { message: s.answer } },
      { type: "turn.completed", data: {} },
    ];
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }
  return new Response("{}", { status: 200 });
};

const { NextRequest } = await import("next/server");
const { mintSessionToken } = await import("../lib/auth-session.ts");
const tokens = { [ANALYST]: await mintSessionToken(ANALYST), [OUTSIDER]: await mintSessionToken(OUTSIDER) };
const WEB = "http://web.starter-apps.test";
const as = (path, { org, who = ANALYST, ...init } = {}) =>
  new NextRequest(`${WEB}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(org ? { "x-ops-org": org } : {}), "x-ops-actor": who, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const appRows = (org) => admin`SELECT * FROM apps WHERE org_id = ${org} ORDER BY created_at, name`;
const settle = async (until, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await until()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
const schema = await import("../agent/lib/db/schema.ts");
const { provisionWorkspace, provisionStarterApps, deploymentSpecialists } = await import("../agent/lib/provision-workspace.ts");
const { applyPlan, planWorkspace } = await import("./operator/lib/library-cleanup.mjs");
const { knownLibraries, scriptSkeleton } = await import("./lib/profile-library.mjs");

// The production shape (.migrate-rls-fail-closed.mjs) on every org_isolation policy, restored afterwards:
// scripts/bootstrap-test-db.mjs builds the permissive one the isolation test needs.
const savedPolicies = new Map();
const CLOSED = `(org_id = current_setting('app.org_id', true))`;
let exit = 1;
try {
  for (const { tablename, qual, with_check } of await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`) {
    savedPolicies.set(tablename, { qual, with_check });
    await admin.unsafe(`ALTER POLICY org_isolation ON "${tablename}" USING ${CLOSED} WITH CHECK ${CLOSED}`);
  }
  check(`org_isolation on ${savedPolicies.size} tables is set to the production fail-closed shape for this run`, savedPolicies.size > 10 && savedPolicies.has("apps"), savedPolicies.size);
  await cleanup();
  for (const [org, name] of [[HOME, "Home desk"], [OTHER, "Another desk"], [LEFT, "Left-over desk"]]) await admin`INSERT INTO orgs (org_id, name, status) VALUES (${org}, ${name}, 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${HOME}, ${ANALYST}, 'owner'), (${LEFT}, ${ANALYST}, 'owner'), (${OTHER}, ${OUTSIDER}, 'owner')`;
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u`;
  console.log(`  (database as ${who.u}; a member's session token on every request)`);

  const orgsRoute = await import("../app/api/ops/orgs/route.ts");
  const workflowsRoute = await import("../app/api/ops/workflows/route.ts");
  const appsRoute = await import("../app/api/ops/apps/route.ts");
  const appRoute = await import("../app/api/ops/apps/[id]/route.ts");
  const refreshRoute = await import("../app/api/ops/apps/[id]/refresh/route.ts");
  const recipesRoute = await import("../app/api/ops/recipes/route.ts");
  const agentConfigsRoute = await import("../app/api/ops/agent-configs/route.ts");
  const healthRoute = await import("../app/api/ops/orgs/[id]/health/route.ts");
  const get = async (route, path, opts) => json(await route.GET(as(path, opts), ...(opts?.params ? [{ params: Promise.resolve(opts.params) }] : [])));
  const listApps = async (org, whoAsks = ANALYST) => (await get(appsRoute, "/api/ops/apps", { org, who: whoAsks })).body?.items ?? [];
  // A refresh answers at once (202 when it started one) and finishes in the background (lib/app-refresh.ts): wait for
  // the app to settle before reading what it wrote. `item` is the row as it stands after that.
  const refresh = async (org, id, first = false) => {
    const out = await json(await refreshRoute.POST(as(`/api/ops/apps/${id}/refresh${first ? "?first=1" : ""}`, { org, method: "POST" }), { params: Promise.resolve({ id }) }));
    for (const t0 = Date.now(); Date.now() - t0 < 20_000; await new Promise((r) => setTimeout(r, 50))) {
      const [row] = await admin`SELECT refreshing_at FROM apps WHERE id = ${id}`;
      if (!row?.refreshing_at) break;
    }
    if (out.body?.item) out.body.item = (await json(await (await import("../app/api/ops/apps/route.ts")).GET(as("/api/ops/apps", { org })))).body?.items?.find((a) => a.id === id) ?? out.body.item;
    return out;
  };
  const createWorkspace = async (name) => {
    const res = await json(await orgsRoute.POST(as("/api/ops/orgs", { method: "POST", body: { name } })));
    if (res.body?.item?.orgId) created.add(res.body.item.orgId);
    return res;
  };

  /* ================================================================================================================ */
  if (PART === "own") {
    console.log("\nA.2 A new workspace, created through POST /api/ops/orgs, holds only what its build declares");
    const mark = asked.length;
    const made = await createWorkspace(`Own probe ${stamp}`);
    const NEW = made.body?.item?.orgId;
    check("the workspace is created (201) and provisioned without error", made.status === 201 && Boolean(NEW) && !made.body.provisionError, made);
    check("provisioning reports no recipe, no starter app, and one workflow row per specialist of this build", made.body?.provisioned?.recipesCreated === 0 && made.body.provisioned.starterAppsCreated === 0 && made.body.provisioned.workflowsCreated === V.specialists.length, made.body?.provisioned);
    if (!NEW) throw new Error("no workspace to audit");
    check("creating it called the agent zero times", asked.length === mark, asked.slice(mark));

    const wf = await get(workflowsRoute, "/api/ops/workflows", { org: NEW });
    const names = (wf.body?.items ?? []).map((w) => w.name).sort();
    check("the Workflows tab lists exactly one row per specialist this build has, and nothing else", wf.status === 200 && JSON.stringify(names) === JSON.stringify([...V.specialists].sort()), names);
    check("…none of them a workflow of the opt-in library, none the row of an excluded specialist", !names.some((n) => FOREIGN.workflows.includes(n) || EXCLUDED.includes(n)), names);
    check("…and no note about a library that is smaller here: there is no library", wf.body?.libraryNote === null, wf.body?.libraryNote);
    const picker = (wf.body?.items ?? []).filter((w) => w.appSource?.ok);
    check("the app source picker offers this build's specialists only", picker.length === V.specialists.length && picker.every((w) => w.appSource.kind === "specialist" && V.specialists.includes(w.name)), picker.map((w) => [w.name, w.appSource]));

    const apps = await get(appsRoute, "/api/ops/apps", { org: NEW });
    check("the Apps tab is empty: no starter app, because this build's library ships none", apps.status === 200 && apps.body?.items?.length === 0, apps);
    const recipes = await get(recipesRoute, "/api/ops/recipes", { org: NEW });
    check("the recipe list is empty: no catalog in the table, none as a fallback", recipes.status === 200 && recipes.body?.items?.length === 0, recipes);

    const cfg = await get(agentConfigsRoute, "/api/ops/agent-configs", { org: NEW });
    check("the agent-configs API names this deployment's specialists: the pack's in, the excluded out", cfg.status === 200 && Array.isArray(cfg.body?.specialists) && cfg.body.specialists.includes(SPECIALIST) && !cfg.body.specialists.some((k) => EXCLUDED.includes(k)), cfg.body);
    const health = await get(healthRoute, `/api/ops/orgs/${NEW}/health`, { org: NEW, params: { id: NEW } });
    const healthText = JSON.stringify(health.body);
    check("the workspace health check names no workflow, recipe slug or app of the opt-in library", health.status === 200 && foreignIn(healthText, { recipes: false }).length === 0 && !FOREIGN.recipes.some((r) => healthText.includes(`"${r}"`)) && excludedNamedIn(healthText).length === 0, healthText.slice(0, 600));
    check("…and does not ask this workspace to seed a workflow library its build does not have", !/workflow library/i.test(healthText) && health.body?.checks?.find((c) => c.id === "workflows")?.ok === true, health.body?.checks?.find((c) => c.id === "workflows"));
    for (const [what, res] of [["workflows", wf], ["apps", apps], ["recipes", recipes], ["agent-configs", cfg]]) {
      const text = JSON.stringify(res.body);
      check(`GET /api/ops/${what}: no name from the opt-in library, no excluded specialist`, foreignIn(text).length === 0 && excludedNamedIn(text).length === 0, { foreign: foreignIn(text), excluded: excludedNamedIn(text) });
    }

    console.log("\nA.3 The agent's own list tool, and this deployment's MCP server (the published tools)");
    {
      const appTools = await import("../agent/lib/app-tools.ts");
      const ctx = { session: { id: `s-${stamp}`, auth: { current: { principalId: ANALYST, attributes: { email: ANALYST, org: NEW } }, initiator: null } } };
      const listed = await appTools.listAppsTool.execute({}, ctx);
      check("list_apps answers this workspace's apps: none", Array.isArray(listed?.apps) && listed.apps.length === 0, listed);

      // The MCP server as /api/mcp builds it; its Ops API calls are answered by the real route handlers.
      const { handleMcpRequest } = await import("../lib/mcp-server.ts");
      const { FOLDER } = await import("../agent/lib/dataroom-folders.ts");
      const routes = { "/api/ops/workflows": workflowsRoute, "/api/ops/apps": appsRoute, "/api/ops/agent-configs": agentConfigsRoute, "/api/ops/recipes": recipesRoute };
      const deps = {
        productName: "Research kit",
        verifyAuth: async (authorization) => (authorization === `Bearer ${tokens[ANALYST]}` ? { email: ANALYST, hostedDomain: null } : null),
        readSpec: async () => "",
        folders: FOLDER,
        customFields: { deployments: [], implementations: [], account: [] },
        webOrigin: WEB,
        internalOrigin: WEB,
        fetchImpl: async (url, init) => {
          const u = new URL(url);
          const route = routes[u.pathname];
          if (!route || (init?.method ?? "GET") !== "GET") return Response.json({ error: `not routed in this test: ${init?.method} ${u.pathname}` }, { status: 404 });
          return route.GET(new NextRequest(u, { headers: init.headers }));
        },
      };
      const rpc = async (method, params) => {
        const res = await handleMcpRequest(new Request(`${WEB}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens[ANALYST]}`, "content-type": "application/json", "x-ops-org": NEW }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), deps);
        return res.json();
      };
      const tools = await rpc("tools/list", {});
      const toolText = JSON.stringify(tools);
      const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
      check("the MCP server lists its tools", toolNames.includes("agent_list") && toolNames.length > 20, toolNames.length);
      check("no tool's name, description or parameter names an excluded specialist", excludedKeyIn(toolText).length === 0 && !/Built in:/.test(toolText), excludedKeyIn(toolText));
      check("no tool names a workflow, recipe or app of the opt-in library", foreignIn(toolText, { recipes: false }).length === 0, foreignIn(toolText, { recipes: false }));
      const call = async (name) => {
        const out = await rpc("tools/call", { name, arguments: {} });
        return out.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(out);
      };
      const agents = await call("agent_list");
      let agentKeys = [];
      try { agentKeys = JSON.parse(agents).map((a) => a.agent); } catch { /* reported below */ }
      check("agent_list answers this deployment's specialists: the pack's in, no excluded one", agentKeys.includes(SPECIALIST) && !agentKeys.some((k) => EXCLUDED.includes(k)) && agentKeys.length === V.specialists.length, agents.slice(0, 600));
      const appTool = toolNames.find((n) => /^apps?_list$/.test(n)) ?? toolNames.find((n) => /app/.test(n) && /list/.test(n));
      const wfTool = toolNames.find((n) => /^workflows?_list$/.test(n)) ?? toolNames.find((n) => /workflow/.test(n) && /list/.test(n));
      check("the tool list has an apps list and a workflows list to ask", Boolean(appTool) && Boolean(wfTool), toolNames.filter((n) => /app|workflow/.test(n)));
      const listedApps = appTool ? await call(appTool) : "";
      const listedWorkflows = wfTool ? await call(wfTool) : "";
      check(`${appTool}: none`, listedApps.trim() === "[]", listedApps.slice(0, 400));
      check(`${wfTool}: this workspace's rows only`, foreignIn(listedWorkflows).length === 0 && excludedNamedIn(listedWorkflows).length === 0 && listedWorkflows.includes(SPECIALIST), listedWorkflows.slice(0, 600));
    }

    console.log("\nA.4 Another workspace's rows are not this one's (fail-closed policy, through the routes)");
    {
      await admin`INSERT INTO workflows (org_id, name, description, trigger, enabled, created_by) VALUES (${OTHER}, 'their-own-flow', 'Theirs.', 'manual', true, ${OUTSIDER})`;
      await admin`INSERT INTO apps (org_id, slug, name, source_kind, prompt, enabled, created_by) VALUES (${OTHER}, 'their-board', 'Their board', 'prompt', 'Summarise.', true, ${OUTSIDER})`;
      const wf2 = await get(workflowsRoute, "/api/ops/workflows", { org: NEW });
      const apps2 = await get(appsRoute, "/api/ops/apps", { org: NEW });
      check("the new workspace still lists only its own", !JSON.stringify(wf2.body).includes("their-own-flow") && !JSON.stringify(apps2.body).includes("Their board"), { wf: wf2.body?.items?.map((w) => w.name), apps: apps2.body?.items });
      const peek = await get(appsRoute, "/api/ops/apps", { org: OTHER });
      check("and asking for the other workspace by name is refused, not answered", peek.status !== 200 || !(peek.body?.items ?? []).length, peek);
    }

    console.log("\nA.5 Cleanup: starter apps left by a library this build does not name");
    if (typeof provisionStarterApps !== "function" || typeof view.deploymentStarterApps !== "function") check("this build has starter apps to clean up after (provisionStarterApps, deploymentStarterApps)", false, "neither exists");
    else {
      // What a build that named the fixture library created in LEFT: three starter apps, by the real provisioning.
      const left = [
        { key: "desk-research/balance-sheets", library: "desk-research", name: "Balance sheets of the companies", description: "d", brief: "b", sourceKind: "specialist", source: SPECIALIST, refreshCron: "0 6 * * 1", firstContent: "on_open" },
        { key: "desk-research/morning-brief", library: "desk-research", name: "Morning brief", description: "d", brief: "b", sourceKind: "specialist", source: SPECIALIST, refreshCron: null, firstContent: "on_open" },
        { key: "desk-research/renamed-by-a-person", library: "desk-research", name: "Guidance tracker", description: "d", brief: "b", sourceKind: "specialist", source: SPECIALIST, refreshCron: null, firstContent: "on_open" },
        { key: "desk-research/deleted-by-a-person", library: "desk-research", name: "Peer table", description: "d", brief: "b", sourceKind: "specialist", source: SPECIALIST, refreshCron: null, firstContent: "on_open" },
      ];
      const seeded = await withOrgDb(LEFT, (tx) => provisionWorkspace(tx, LEFT, ANALYST, { starterApps: left }));
      check("the earlier build's four starter apps are in the workspace", seeded.starterAppsCreated === 4, seeded.starterApps);
      const byName = Object.fromEntries((await listApps(LEFT)).map((a) => [a.name, a]));
      // A person opens one (its first document is written), renames another, deletes a third. The fourth is untouched.
      const opened = await refresh(LEFT, byName["Morning brief"].id, true);
      await new Promise((r) => setTimeout(r, 2100));
      const renamed = await json(await appRoute.PATCH(as(`/api/ops/apps/${byName["Guidance tracker"].id}`, { org: LEFT, method: "PATCH", body: { name: "Guidance tracker (ours)" } }), { params: Promise.resolve({ id: byName["Guidance tracker"].id }) }));
      const deleted = await json(await appRoute.DELETE(as(`/api/ops/apps/${byName["Peer table"].id}`, { org: LEFT, method: "DELETE" }), { params: Promise.resolve({ id: byName["Peer table"].id }) }));
      const [own] = await admin`INSERT INTO apps (org_id, slug, name, source_kind, workflow, enabled, created_by) VALUES (${LEFT}, 'ours', 'Our own board', 'workflow', ${SPECIALIST}, true, ${ANALYST}) RETURNING id`;
      check("a person opened one, renamed one and deleted one", opened.status === 202 && opened.body?.started === true && renamed.status === 200 && deleted.status === 200, { opened, renamed, deleted });

      const ctx = {
        libraries: knownLibraries(process.cwd()),
        skeleton: scriptSkeleton,
        provisioned: { workflows: new Set(view.deploymentWorkflowLibrary().map((w) => w.name)), recipes: new Set(view.deploymentRecipes().map((r) => r.slug)), apps: new Set(view.deploymentStarterApps().map((a) => a.key)) },
        sources: generated.LIBRARY_SOURCES,
        excluded: EXCLUDED,
      };
      const before = (await appRows(LEFT)).length;
      const plan = await withOrgDb(LEFT, (tx) => planWorkspace(tx, schema, LEFT, ctx));
      const of = (list) => list.filter((r) => r.table === "apps").map((r) => r.name).sort();
      check("the dry run changes nothing", (await appRows(LEFT)).length === before, before);
      check("the untouched starter app is listed as removable, and only it", JSON.stringify(of(plan.removable)) === JSON.stringify(["Balance sheets of the companies"]), plan.removable);
      check("the opened one and the renamed one are kept", JSON.stringify(of(plan.kept)) === JSON.stringify(["Guidance tracker (ours)", "Morning brief"]), plan.kept);
      const why = Object.fromEntries(plan.kept.filter((r) => r.table === "apps").map((r) => [r.name, r.why.join("; ")]));
      check("…each with the evidence: a document and a version for the opened one, an edit for the renamed one", /it has a document/.test(why["Morning brief"] ?? "") && /1 version/.test(why["Morning brief"] ?? "") && /edited: changed after it was created/.test(why["Guidance tracker (ours)"] ?? ""), why);
      check("it says where each came from: a library this build's profile does not name", [...plan.removable, ...plan.kept].filter((r) => r.table === "apps").every((r) => /starter app of the "desk-research" library, which this build's profile does not name/.test(r.origin)), plan.removable.map((r) => r.origin));
      check("the deleted one is not reported, and a person's own app is never looked at", ![...plan.removable, ...plan.kept].some((r) => r.name === "Peer table" || r.name === "Our own board"), [...plan.removable, ...plan.kept].map((r) => r.name));
      check("the specialist's row the removable app was built on is not a leftover (the build has that specialist)", ![...plan.removable, ...plan.kept].some((r) => r.table === "workflows" && r.name === SPECIALIST), plan);
      const removed = await withOrgDb(LEFT, (tx) => applyPlan(tx, schema, LEFT, plan));
      const after = await appRows(LEFT);
      check("--apply removes exactly the one removable app", removed.apps === 1 && after.length === before - 1 && !after.some((a) => a.name === "Balance sheets of the companies"), { removed, names: after.map((a) => a.name) });
      check("everything a person touched, and their own app, is still there", ["Morning brief", "Guidance tracker (ours)", "Peer table", "Our own board"].every((n) => after.some((a) => a.name === n)) && after.some((a) => a.id === own.id), after.map((a) => a.name));
      const again = await withOrgDb(LEFT, (tx) => planWorkspace(tx, schema, LEFT, ctx));
      check("a second run finds nothing more to remove", again.removable.filter((r) => r.table === "apps").length === 0, again.removable);
    }
  }

  /* ================================================================================================================ */
  if (PART === "starter") {
    const EXPECT = view.deploymentStarterApps();
    const expectNames = EXPECT.map((a) => a.name).sort();

    console.log("\nB.1 A new workspace gets exactly its libraries' starter apps, and no model runs for the ones that wait");
    const mark = asked.length;
    const made = await createWorkspace(`Starter probe ${stamp}`);
    const NEW = made.body?.item?.orgId;
    check("the workspace is created (201) and provisioned without error", made.status === 201 && Boolean(NEW) && !made.body.provisionError, made);
    check("provisioning reports the six starter apps created", made.body?.provisioned?.starterAppsCreated === 6 && made.body.provisioned.starterAppsSkipped === 0, made.body?.provisioned);
    // The one app whose library says "on_create" is written now, as the person who created the workspace.
    await settle(async () => (await appRows(NEW)).some((a) => a.starter_key === "desk-research/morning-brief" && a.content_md));
    const rows = await appRows(NEW);
    check("the workspace holds exactly its libraries' starter apps: six rows, no other app", rows.length === 6 && JSON.stringify(rows.map((a) => a.name).sort()) === JSON.stringify(expectNames), rows.map((a) => a.name));
    check("each carries its key, and is attributed to the system, not to the person who created the workspace", rows.every((a) => EXPECT.some((e) => e.key === a.starter_key) && a.created_by === "system") && new Set(rows.map((a) => a.starter_key)).size === 6, rows.map((a) => [a.starter_key, a.created_by]));
    check("each is in this deployment's words: an account is a company", rows.some((a) => a.name === "Companies gone quiet") && rows.some((a) => a.name === "Balance sheets of the companies") && !rows.some((a) => /\{[a-zA-Z]+\}|account/i.test(`${a.name} ${a.description} ${a.prompt}`)), rows.map((a) => a.name));
    check("each is generated by a row of this workspace, with its brief and its schedule", rows.every((a) => a.source_kind === "workflow" && a.workflow && a.prompt) && rows.find((a) => a.starter_key === "desk-research/balance-sheets")?.refresh_cron === "0 6 * * 1" && rows.find((a) => a.starter_key === "desk-research/coverage-digest")?.refresh_cron === null, rows.map((a) => [a.starter_key, a.workflow, a.refresh_cron]));
    const waiting = rows.filter((a) => a.starter_key !== "desk-research/morning-brief");
    check("the five that wait for a first open have no document, no attempt and nothing under way", waiting.length === 5 && waiting.every((a) => a.content_md === null && a.content_updated_at === null && a.last_refresh_at === null && a.refreshing_at === null && a.last_error === null), waiting.map((a) => [a.starter_key, a.last_refresh_at]));
    const eager = rows.find((a) => a.starter_key === "desk-research/morning-brief");
    const calls = asked.slice(mark);
    check("the agent was called once in all: for the one app whose library says first_content \"on_create\"", calls.length === 1 && calls[0].who === SPECIALIST && calls[0].scope === NEW && /three things an analyst should read first/.test(calls[0].message), calls.map((c) => [c.who, c.scope]));
    check("…and that app has its document, written as the person who created the workspace", eager?.content_md === DOCUMENT(SPECIALIST) && eager.last_error === null, { content: eager?.content_md, error: eager?.last_error });
    const [eagerVersion] = await admin`SELECT created_by FROM app_versions WHERE app_id = ${eager.id}`;
    check("…recorded in its history under their name", eagerVersion?.created_by === ANALYST, eagerVersion);
    const wfNames = (await admin`SELECT name FROM workflows WHERE org_id = ${NEW}`).map((w) => w.name);
    check("the workspace also holds the library workflow its app is built on, and no workflow that needs an excluded specialist", wfNames.includes("coverage-digest") && !(await admin`SELECT script FROM workflows WHERE org_id = ${NEW} AND script IS NOT NULL`).some((w) => view.delegatesTo(w.script).some((k) => EXCLUDED.includes(k))), wfNames);

    console.log("\nB.2 The Apps tab lists them");
    const listed = await listApps(NEW);
    check("GET /api/ops/apps returns the six, each marked as a starter app with a source that can run", listed.length === 6 && listed.every((a) => a.starterKey && a.source?.ok === true), listed.map((a) => [a.name, a.starterKey, a.source]));
    check("a specialist's app says so, and the library workflow's app is a script", listed.find((a) => a.starterKey === "desk-research/balance-sheets")?.source.kind === "specialist" && listed.find((a) => a.starterKey === "desk-research/coverage-digest")?.source.kind === "script", listed.map((a) => [a.starterKey, a.source?.kind]));
    {
      const appTools = await import("../agent/lib/app-tools.ts");
      const ctx = { session: { id: `s-${stamp}`, auth: { current: { principalId: ANALYST, attributes: { email: ANALYST, org: NEW } }, initiator: null } } };
      const out = await appTools.listAppsTool.execute({}, ctx);
      check("the agent's list_apps lists the same six, marked as starter apps", out.apps.length === 6 && out.apps.every((a) => a.starter === true), out.apps.map((a) => [a.name, a.starter]));
    }

    console.log("\nB.3 First open writes the document through the specialist, once");
    const sheet = listed.find((a) => a.starterKey === "desk-research/balance-sheets");
    {
      const m = asked.length;
      agentDelayMs = 150;
      const [first, second] = await Promise.all([refresh(NEW, sheet.id, true), refresh(NEW, sheet.id, true)]);
      agentDelayMs = 0;
      const started = [first, second].filter((r) => r.body?.started === true);
      const waited = [first, second].filter((r) => r.body?.started === false);
      check("two people open it in the same moment: one generation starts, the other is told it is being written", started.length === 1 && waited.length === 1 && waited[0].status === 200 && waited[0].body.why === "in-progress", [first.body, second.body].map((b) => [b?.started, b?.why, b?.ok]));
      const row = (await appRows(NEW)).find((a) => a.id === sheet.id);
      check("its document is the specialist's reply", started[0]?.status === 202 && row.content_md === DOCUMENT(SPECIALIST) && row.last_error === null && Boolean(row.last_session_id), { content: row.content_md, error: row.last_error });
      const ask = asked.slice(m);
      check("the agent was asked once, to delegate to that specialist, for this workspace, with the library's brief in this deployment's words", ask.length === 1 && ask[0].who === SPECIALIST && ask[0].scope === NEW && /every covered company, its total assets, borrowings and net worth/.test(ask[0].message) && /Reply with the finished document itself/.test(ask[0].message), ask.map((a) => a.message.slice(0, 300)));
      const versions = await admin`SELECT created_by, error FROM app_versions WHERE app_id = ${sheet.id}`;
      check("one version in its history, by the person who opened it", versions.length === 1 && versions[0].created_by === ANALYST && versions[0].error === null, versions);
      const m2 = asked.length;
      const third = await refresh(NEW, sheet.id, true);
      check("opening it again starts nothing: it has its document", third.status === 200 && third.body?.started === false && third.body.why === "generated" && asked.length === m2, third.body);
      const explicit = await refresh(NEW, sheet.id);
      check("a person's own Refresh still regenerates it", explicit.status === 202 && explicit.body?.ok === true && asked.length === m2 + 1, explicit.body);
    }
    {
      const digest = listed.find((a) => a.starterKey === "desk-research/coverage-digest");
      const out = await refresh(NEW, digest.id, true);
      const row = (await appRows(NEW)).find((a) => a.id === digest.id);
      const [run] = row.last_run_id ? await admin`SELECT status, workflow_name FROM workflow_runs WHERE run_id = ${row.last_run_id}` : [];
      check("the app built on a library workflow runs that script durably on first open", out.status === 202 && out.body?.started === true && row.content_md === DOCUMENT(SPECIALIST) && run?.status === "completed" && run.workflow_name === "coverage-digest", { out: out.body, run, error: row.last_error });
    }
    {
      // The schedule: an app nobody opened is written by the refresh cron when it comes due.
      const quiet = listed.find((a) => a.starterKey === "account-delivery/quiet-accounts");
      await admin`UPDATE apps SET enabled = false WHERE org_id = ${NEW} AND id <> ${quiet.id}`;
      await admin`UPDATE apps SET refresh_cron = '* * * * *' WHERE id = ${quiet.id}`;
      const cronRoute = await import("../app/api/cron/refresh-apps/route.ts");
      let outcome = null;
      for (let tick = 0; tick < 4 && !outcome; tick++) {
        const r = await json(await cronRoute.GET(new NextRequest(`${WEB}/api/cron/refresh-apps`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })));
        outcome = r.body?.outcomes?.find((o) => o.app === quiet.slug) ?? (r.status === 200 ? null : { status: `http_${r.status}`, body: r.body });
      }
      const row = (await appRows(NEW)).find((a) => a.id === quiet.id);
      check("a starter app nobody opened gets its first document from its schedule", outcome?.status === "refreshed" && row.content_md === DOCUMENT("follow-ups") && row.last_error === null, { outcome, error: row.last_error });
      await admin`UPDATE apps SET enabled = true WHERE org_id = ${NEW}`;
      await admin`UPDATE apps SET refresh_cron = '0 7 * * 1' WHERE id = ${quiet.id}`;
    }

    console.log("\nB.4 Idempotent: provisioning again creates nothing and overwrites nothing");
    const follow = listed.find((a) => a.starterKey === "account-delivery/open-follow-ups");
    {
      const edited = await json(await appRoute.PATCH(as(`/api/ops/apps/${follow.id}`, { org: NEW, method: "PATCH", body: { name: "Open follow-ups (desk)", refreshCron: "0 9 * * *", prompt: "Our own brief." } }), { params: Promise.resolve({ id: follow.id }) }));
      check("a person edits one starter app", edited.status === 200, edited);
      const before = JSON.stringify(await appRows(NEW));
      const m = asked.length;
      const [again, same] = await Promise.all([
        withOrgDb(NEW, (tx) => provisionWorkspace(tx, NEW, ANALYST)),
        withOrgDb(NEW, (tx) => provisionWorkspace(tx, NEW, ANALYST)).catch((e) => ({ error: String(e) })),
      ]);
      check("two more runs at once create no app", again.starterAppsCreated === 0 && again.starterAppsSkipped === 6 && (same.error || same.starterAppsCreated === 0), { again: again.starterApps, same });
      check("no row was added or changed: the edit stands, the documents stand", JSON.stringify(await appRows(NEW)) === before, (await appRows(NEW)).map((a) => [a.name, a.refresh_cron]));
      check("and nothing was generated", asked.length === m, asked.slice(m));
      const plan = await withOrgDb(NEW, (tx) => provisionStarterApps(tx, NEW, undefined, { dryRun: true }));
      check("a dry run says all six are already there", plan.created.length === 0 && plan.skipped.length === 6 && plan.skipped.every((s) => s.why === "present"), plan);
    }

    console.log("\nB.5 A starter app a person deleted is not resurrected");
    {
      const evals = listed.find((a) => a.starterKey === "account-delivery/evaluation-regressions");
      const del = await json(await appRoute.DELETE(as(`/api/ops/apps/${evals.id}`, { org: NEW, method: "DELETE" }), { params: Promise.resolve({ id: evals.id }) }));
      check("a person deletes one (200); the Apps tab lists five", del.status === 200 && (await listApps(NEW)).length === 5, del);
      const again = await withOrgDb(NEW, (tx) => provisionWorkspace(tx, NEW, ANALYST));
      const why = again.starterApps.skipped.find((s) => s.key === "account-delivery/evaluation-regressions");
      check("provisioning again does not create it, and says why", again.starterAppsCreated === 0 && why?.why === "deleted" && /a person deleted it/.test(why.detail), again.starterApps);
      const applied = await withOrgDb(NEW, (tx) => provisionStarterApps(tx, NEW));
      check("neither does the operator's apply", applied.created.length === 0 && applied.skipped.find((s) => s.key === "account-delivery/evaluation-regressions")?.why === "deleted", applied);
      const names = (await listApps(NEW)).map((a) => a.name);
      check("the Apps tab still lists five, and not the deleted one", names.length === 5 && !names.includes("Evaluation regressions"), names);
      check("one row carries that key in the database: the deleted one, kept so it is not made again", (await admin`SELECT deleted_at FROM apps WHERE org_id = ${NEW} AND starter_key = 'account-delivery/evaluation-regressions'`).filter((r) => r.deleted_at).length === 1);
      const dup = await admin`INSERT INTO apps (org_id, slug, name, source_kind, prompt, enabled, created_by, starter_key) VALUES (${NEW}, 'dup', 'Dup', 'prompt', 'x', true, 'system', 'desk-research/balance-sheets') RETURNING id`.catch((e) => ({ refused: e.message }));
      check("the database itself refuses a second row with one workspace's starter key", Boolean(dup.refused) && /apps_org_starter_key_uq/.test(dup.refused), dup);
    }

    console.log("\nB.6 An existing workspace gets starter apps only from the operator's explicit apply");
    {
      // HOME existed before this build's library shipped starter apps. Its analyst already has an app of their own
      // whose name one starter app would take.
      await admin`INSERT INTO apps (org_id, slug, name, source_kind, prompt, enabled, created_by) VALUES (${HOME}, 'morning-brief', 'Morning brief', 'prompt', 'Ours.', true, ${ANALYST})`;
      const forced = await withOrgDb(HOME, (tx) => provisionWorkspace(tx, HOME, ANALYST, { starterApps: false }));
      check("re-provisioning an existing workspace (operator:new-org --force) adds its rows and NO starter app", forced.starterAppsCreated === 0 && forced.workflowsCreated > 0 && (await appRows(HOME)).length === 1, forced);
      check("the Apps tab of the existing workspace shows only the person's own app", JSON.stringify((await listApps(HOME)).map((a) => a.name)) === JSON.stringify(["Morning brief"]), (await listApps(HOME)).map((a) => a.name));

      const env = { ...process.env, DATABASE_URL: appUrl };
      const cli = (...args) => spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "scripts/operator/library-apply.mjs", "--org", HOME, ...args], { cwd: process.cwd(), env, encoding: "utf8" });
      const dry = cli("--json");
      let plan = null;
      try { plan = JSON.parse(dry.stdout); } catch { /* reported below */ }
      const ws = plan?.workspaces?.[0];
      check("operator:library-apply without --apply is a dry run: it exits 0 and writes nothing", dry.status === 0 && plan?.applied === false && (await appRows(HOME)).length === 1, (dry.stderr || dry.stdout).slice(-600));
      check("it lists the five it would add, and the one it would not: the workspace already has an app of that name", ws?.created.length === 5 && ws.skipped.length === 1 && ws.skipped[0].why === "name-taken" && ws.skipped[0].name === "Morning brief", ws);
      const text = cli();
      check("in words it says DRY RUN and how to apply", text.status === 0 && /DRY RUN/.test(text.stdout) && /would add \(5\)/.test(text.stdout) && /--org \S+ --apply/.test(text.stdout), text.stdout.slice(0, 900));
      const m = asked.length;
      const applied = cli("--apply", "--json");
      let done = null;
      try { done = JSON.parse(applied.stdout); } catch { /* reported below */ }
      const after = await appRows(HOME);
      check("--apply adds exactly the five the dry run listed", applied.status === 0 && done?.applied === true && JSON.stringify(done.workspaces[0].created.map((a) => a.key).sort()) === JSON.stringify(ws.created.map((a) => a.key).sort()) && after.length === 6, (applied.stderr || applied.stdout).slice(-600));
      check("the person's own app is untouched, and no second app took its name", after.filter((a) => a.name === "Morning brief").length === 1 && after.find((a) => a.name === "Morning brief").starter_key === null && after.find((a) => a.name === "Morning brief").created_by === ANALYST, after.map((a) => [a.name, a.starter_key]));
      check("nothing was generated by applying: every added app waits for its first open", asked.length === m && after.filter((a) => a.starter_key).every((a) => a.content_md === null && a.last_refresh_at === null), after.map((a) => [a.name, a.last_refresh_at]));
      const twice = cli("--apply", "--json");
      check("a second --apply adds nothing", twice.status === 0 && JSON.parse(twice.stdout).workspaces[0].created.length === 0 && (await appRows(HOME)).length === 6, twice.stdout.slice(0, 400));
      const homeList = await listApps(HOME);
      const first = await refresh(HOME, homeList.find((a) => a.starterKey === "desk-research/balance-sheets").id, true);
      check("an applied starter app is written on its first open, like a new workspace's", first.status === 202 && first.body?.started === true && first.body.item?.contentMd === DOCUMENT(SPECIALIST), first.body);
    }

    console.log("\nB.7 Another workspace sees none of it");
    {
      const theirs = await listApps(OTHER, OUTSIDER);
      check("the other workspace's Apps tab is empty: it was not created by this build and nobody applied", theirs.length === 0, theirs);
      const peek = await get(appsRoute, "/api/ops/apps", { org: NEW, who: OUTSIDER });
      check("and its member cannot list the new workspace's apps by naming it", peek.status !== 200 || !(peek.body?.items ?? []).length, peek);
      const sheetRow = (await appRows(NEW)).find((a) => a.starter_key === "desk-research/balance-sheets");
      const poke = await json(await refreshRoute.POST(as(`/api/ops/apps/${sheetRow.id}/refresh?first=1`, { org: OTHER, who: OUTSIDER, method: "POST" }), { params: Promise.resolve({ id: sheetRow.id }) }));
      check("nor refresh one by its id from their own workspace (404)", poke.status === 404, poke);
      const app = postgres(appUrl, { prepare: false, max: 1 });
      const unscoped = await app`SELECT count(*)::int AS n FROM apps WHERE starter_key IS NOT NULL`;
      await app.end({ timeout: 2 });
      check("a query that names no workspace sees no starter app at all (fail-closed)", unscoped[0].n === 0, unscoped);
    }
  }
  exit = failures ? 1 : 0;
} catch (e) {
  failures++;
  console.error(`\n  FAIL the run stopped: ${e?.stack ?? e}`);
} finally {
  await cleanup();
  for (const [tablename, { qual, with_check }] of savedPolicies) {
    await admin.unsafe(`ALTER POLICY org_isolation ON "${tablename}" USING ${qual} WITH CHECK ${with_check ?? qual}`).catch((e) => console.error(`could not restore org_isolation on ${tablename}: ${e.message}`));
  }
  await closeDb().catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}

console.log(`\ntest-starter-apps-db (${PART}): ${passed} check(s) passed${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : exit);
