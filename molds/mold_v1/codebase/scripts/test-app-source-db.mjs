/**
 * AN APP CAN BE MADE FROM ANYTHING THE PICKER OFFERS — create → refresh → content, through the real routes,
 * against a real Postgres, in a deployment shaped like a research pack's.
 *
 * What was broken. The Apps form offers every row of the workspace's `workflows` table as a source. Most rows in a
 * pack's workspace are SPECIALIST rows (trigger "on delegation", no script): the row a specialist's runs are filed
 * under. The create route stored whichever was picked; the refresh ran scripts only. So an app made from a
 * specialist's row was saved, listed, and could only ever fail: `Workflow "<name>" has no script.` Changing the
 * app's workflow afterwards left that error on the row, naming a workflow the app was no longer set to.
 *
 * The deployment under test is this tree stamped the way the software factory stamps one: the relabelling fixture
 * profile (scripts/fixtures/agent-vocabulary/50-relabelled.json, which mirrors the research pack: companies and
 * analysts, base specialists excluded) plus a FIXTURE specialist the base product does not have
 * (scripts/fixtures/app-source/, copied in as agent/subagents/ledger-reader/). The test copies the tree, regenerates
 * the registry and the profile in the copy, and re-runs itself there; nothing in this checkout is modified.
 *
 * Each route is the real handler, called as the console calls it (a member's session token, the workspace header).
 * The agent is a stand-in at the web app's `fetch`: it records what it was asked and answers a document, so
 * "content" means the bytes the route stored. The database is a real Postgres, as app_rw under the fail-closed
 * policies.
 *
 *   1. THE PICKER   GET /api/ops/workflows says of each row whether it can generate an app, as what, or why not
 *   2. FAIL FAST    a source that cannot run is refused at create (400, the reason and what to do); nothing is saved
 *   3. SPECIALIST   an app made from a specialist's row: created, refreshed, its document is the specialist's reply
 *   4. SCRIPT       an app made from a workflow script still runs durably, as before
 *   5. RETRY        an app saved BEFORE the fix, carrying the old error, refreshes without being recreated
 *   6. THE ERROR    an app whose source cannot run says so on the list, is refused at refresh with the same
 *                   sentence, can still be paused, and is repaired by changing its source: which clears the error
 *   7. THE CRON     the scheduled refresh runs a specialist app too, as the web app's own identity
 *
 * It imports nothing this change added (the routes, and modules that exist on the commit before), so it runs
 * unchanged on the code before it, where it fails: see the pull request for that run.
 *
 * Without ADMIN_URL and DATABASE_URL the database part is skipped and only the pure rules (0) run.
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:app-source-db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAMPED = process.argv.includes("--stamped");
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
    console.error(`  FAIL ${what}${detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
  }
};

/* ================================================================================================================ */
/* The outer run: stamp a copy of the tree (relabelled profile + the fixture specialist) and run the test inside it. */
/* ================================================================================================================ */
if (!STAMPED) {
  const dir = mkdtempSync(join(tmpdir(), "app-source-stamped-"));
  let status = 1;
  try {
    for (const e of ["agent", "app", "lib", "components", "data", "scripts", "library", "profiles", "package.json", "tsconfig.json", "dm.md"]) {
      if (existsSync(join(HERE, e))) cpSync(join(HERE, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes("/.eve") });
    }
    cpSync(join(HERE, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "profiles/50-relabelled.json"));
    mkdirSync(join(dir, "agent/subagents", SPECIALIST), { recursive: true });
    cpSync(join(HERE, "scripts/fixtures/app-source/ledger-reader.agent.ts.txt"), join(dir, "agent/subagents", SPECIALIST, "agent.ts"));
    symlinkSync(join(HERE, "node_modules"), join(dir, "node_modules"), "dir");
    // The stamping sequence: the registry (with the pack's specialist, without the excluded ones), then the profile.
    for (const s of ["scripts/gen-subagent-meta.mjs", "scripts/gen-deployment-profile.mjs"]) {
      const r = spawnSync(process.execPath, [s], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${s} failed in the stamped copy:\n${r.stderr || r.stdout}`);
    }
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/test-app-source-db.mjs", "--stamped"],
      { cwd: dir, env: process.env, stdio: "inherit" },
    );
    status = r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}

/* ================================================================================================================ */
/* Inside the stamped copy.                                                                                         */
/* ================================================================================================================ */
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

const vocab = await import("../agent/lib/agent-vocabulary.ts");
const V = vocab.VOCABULARY;
const EXCLUDED = V.excludedSpecialists[0];

console.log("\n0. The deployment under test");
check("the stamped copy is relabelled (an account is a company) and excludes base specialists", V.relabelled === true && vocab.fill("{account}") === "company" && V.excludedSpecialists.length > 0, { relabelled: V.relabelled, account: vocab.fill("{account}"), excluded: V.excludedSpecialists });
check(`it has the fixture specialist "${SPECIALIST}", which the base product does not`, V.specialists.includes(SPECIALIST), V.specialists);

if (!adminUrl || !appUrl) {
  console.log("\ntest-app-source-db: the database part is SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
  process.exit(failures ? 1 : 0);
}

/* ---- a deployment that reaches its agent as itself (the cron) and as the person asking (the console) ------------ */
for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
delete process.env.GOOGLE_CLIENT_ID;
process.env.SERVICE_AUTH = "session-key";
const CRON_SECRET = `cron-${randomUUID()}`;
process.env.CRON_SECRET = CRON_SECRET;
const AGENT = "https://agent.app-source.test";
process.env.NEXT_PUBLIC_EVE_API_URL = AGENT; // read at import by lib/workflow-delegate.ts
const { exportPKCS8, exportSPKI, generateKeyPair } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

const postgres = (await import("postgres")).default;
const stamp = `${Date.now()}-${process.pid}`;
const ORG = `appsrc-${stamp}`;
const ANALYST = `analyst-${stamp}@appsrc.test`;
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const cleanup = async () => {
  for (const t of ["app_versions", "apps", "workflow_run_journal", "workflow_runs", "automation_runs", "automation_audit", "workflows", "agent_session_scopes", "agent_session_owners", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [ORG]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id = ${ORG}`.catch(() => undefined);
};

/* ---- the agent, at the web app's fetch: it records what it was asked and answers a document ---------------------- */
const asked = []; // { message, scope, authorization }
const sessions = new Map();
const DOCUMENT = (who) => `# Balance sheet\n\n| Company | Total assets (Rs crore) | Source |\n|---|---|---|\n| Acme Housing | 1,240 | AR FY26 p.112 |\n\n_Written by ${who}._`;
const delegatedTo = (message) => /Delegate this task to the `([a-z0-9-]+)` subagent/.exec(message)?.[1] ?? null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (!request.url.startsWith(AGENT)) return realFetch(input, init);
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/eve/v1/session") {
    const { message } = await request.json();
    const id = `wrun_appsrc_${sessions.size + 1}`;
    const who = delegatedTo(message) ?? "the orchestrator";
    sessions.set(id, { message, answer: DOCUMENT(who) });
    asked.push({ message, scope: request.headers.get("x-workspace-scope"), who });
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
const token = await mintSessionToken(ANALYST);
const WEB = "http://web.app-source.test";
const as = (path, init = {}) =>
  new NextRequest(`${WEB}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-ops-org": ORG, "x-ops-actor": ANALYST, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const appRow = async (id) => (await admin`SELECT * FROM apps WHERE id = ${id}`)[0];
const appCount = async () => Number((await admin`SELECT count(*)::int AS n FROM apps WHERE org_id = ${ORG} AND deleted_at IS NULL`)[0].n);

try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'App source probe', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${ORG}, ${ANALYST}, 'member')`;
  const wf = (name, description, trigger, script) => admin`INSERT INTO workflows (org_id, name, description, trigger, script, enabled, created_by) VALUES (${ORG}, ${name}, ${description}, ${trigger}, ${script}, true, ${ANALYST})`;
  // What a pack's workspace holds: the pack specialist's row, a script somebody wrote, a row with no script that is
  // nobody's specialist, the row of a base specialist the profile excludes, and a script that still delegates to one.
  await wf(SPECIALIST, "Reads ledgers.", "on delegation", null);
  await wf("kpi-table", "Build the KPI table.", "manual", `export const meta = { name: "kpi-table", description: "Build the KPI table." };\nphase("Build");\nconst out = await agent("Build the KPI table.", { subagent: ${JSON.stringify(SPECIALIST)} });\nreturn out;\n`);
  await wf("weekly-notes", "A draft with no script yet.", "on delegation", null);
  await wf(EXCLUDED, "A base specialist this deployment excludes.", "on delegation", null);
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u`;
  console.log(`  (database as ${who.u}; workspace ${ORG}; a member's session token on every request)`);

  const workflowsRoute = await import("../app/api/ops/workflows/route.ts");
  const appsRoute = await import("../app/api/ops/apps/route.ts");
  const appRoute = await import("../app/api/ops/apps/[id]/route.ts");
  const refreshRoute = await import("../app/api/ops/apps/[id]/refresh/route.ts");
  const refresh = async (id) => json(await refreshRoute.POST(as(`/api/ops/apps/${id}/refresh`, { method: "POST" }), { params: Promise.resolve({ id }) }));
  const patch = async (id, body) => json(await appRoute.PATCH(as(`/api/ops/apps/${id}`, { method: "PATCH", body }), { params: Promise.resolve({ id }) }));
  const create = async (body) => json(await appsRoute.POST(as("/api/ops/apps", { method: "POST", body: { createdBy: ANALYST, ...body } })));
  const listed = async () => (await json(await appsRoute.GET(as("/api/ops/apps")))).body?.items ?? [];

  /* ---- 1. the picker ------------------------------------------------------------------------------------------ */
  console.log("\n1. The picker: GET /api/ops/workflows says what each row can do for an app");
  {
    const res = await json(await workflowsRoute.GET(as("/api/ops/workflows")));
    const by = Object.fromEntries((res.body?.items ?? []).map((w) => [w.name, w.appSource]));
    check("a specialist's row (no script) is a source: the specialist writes the document", by[SPECIALIST]?.ok === true && by[SPECIALIST].kind === "specialist", by[SPECIALIST]);
    check("a workflow with a script is a source", by["kpi-table"]?.ok === true && by["kpi-table"].kind === "script", by["kpi-table"]);
    check("a row with no script that is nobody's specialist is NOT, with the reason and what to do", by["weekly-notes"]?.ok === false && /has no script and is not one of this workspace's specialists/.test(by["weekly-notes"].reason) && /Give it a script/.test(by["weekly-notes"].fix), by["weekly-notes"]);
    check("the row of a specialist the profile excludes is NOT", by[EXCLUDED]?.ok === false, by[EXCLUDED]);
  }

  /* ---- 2. fail fast ------------------------------------------------------------------------------------------- */
  console.log("\n2. Fail fast: a source that cannot run is refused at create, and nothing is saved");
  {
    const before = await appCount();
    const noScript = await create({ name: "Notes board", sourceKind: "workflow", workflow: "weekly-notes" });
    check("a row with no script that is nobody's specialist: 400, saying why and what to do", noScript.status === 400 && /"weekly-notes" has no script and is not one of this workspace's specialists.*Give it a script under Workflows, or pick a workflow that has one\./.test(noScript.body?.error ?? ""), noScript);
    const excluded = await create({ name: "Old board", sourceKind: "workflow", workflow: EXCLUDED });
    check("the row of an excluded specialist: 400", excluded.status === 400 && typeof excluded.body?.error === "string", excluded);
    const missing = await create({ name: "Ghost board", sourceKind: "workflow", workflow: "no-such-workflow" });
    check("a workflow that does not exist: 400, naming it", missing.status === 400 && /There is no workflow named "no-such-workflow"/.test(missing.body?.error ?? ""), missing);
    const pinned = await create({ name: "Pinned board", sourceKind: "prompt", prompt: "Summarise.", subagent: EXCLUDED });
    check("a prompt pinned to a specialist this workspace does not have: 400", pinned.status === 400 && /is not one of this workspace's specialists/.test(pinned.body?.error ?? ""), pinned);
    check("none of the four was saved", (await appCount()) === before, await appCount());
  }

  /* ---- 3. an app from a specialist's row ---------------------------------------------------------------------- */
  console.log("\n3. An app made from a specialist's row: create → refresh → content");
  let specialistApp;
  {
    const made = await create({ name: "Balance sheet of the companies", description: "Total assets, borrowings and net worth of every covered company.", sourceKind: "workflow", workflow: SPECIALIST });
    specialistApp = made.body?.item;
    check("created (201), and the answer says a specialist generates it", made.status === 201 && specialistApp?.source?.ok === true && specialistApp.source.kind === "specialist" && specialistApp.source.specialist === SPECIALIST, made);
    const mark = asked.length;
    const out = await refresh(specialistApp.id);
    const row = await appRow(specialistApp.id);
    check("the refresh succeeds (200)", out.status === 200 && out.body?.ok === true, out);
    check("its document is the specialist's reply", row.content_md === DOCUMENT(SPECIALIST), row.content_md);
    check("no error on the app, and the session it came from is recorded", row.last_error === null && Boolean(row.last_session_id) && row.content_updated_at !== null, { last_error: row.last_error, last_session_id: row.last_session_id });
    const ask = asked.slice(mark);
    check("the agent was asked once, to delegate to that specialist, for this workspace", ask.length === 1 && ask[0].who === SPECIALIST, ask);
    check("with no brief, the specialist is given the app's name and what it is for", /Produce the document for the app "Balance sheet of the companies"\./.test(ask[0]?.message ?? "") && /What it is for: Total assets, borrowings and net worth/.test(ask[0]?.message ?? ""), ask[0]?.message);
    check("…and asked for the document itself, not a dashboard spec", /Reply with the finished document itself/.test(ask[0]?.message ?? "") && !/JSON dashboard spec/.test(ask[0]?.message ?? ""), ask[0]?.message);
    const [version] = await admin`SELECT content_md, error, session_id, created_by FROM app_versions WHERE app_id = ${specialistApp.id} ORDER BY created_at DESC LIMIT 1`;
    check("the refresh is in the version history, by the person who asked", version?.content_md === DOCUMENT(SPECIALIST) && version.error === null && version.created_by === ANALYST, version);

    const briefed = await create({ name: "Borrowings mix", sourceKind: "workflow", workflow: SPECIALIST, prompt: "Table of borrowings by instrument for each company, latest quarter.", customerId: "acme-housing" });
    const mark2 = asked.length;
    const out2 = await refresh(briefed.body?.item?.id);
    const said = asked.slice(mark2)[0]?.message ?? "";
    check("with a brief, the specialist is given the brief, and the company the app is about, in this deployment's word", out2.status === 200 && /Table of borrowings by instrument/.test(said) && /It is about one company: acme-housing\./.test(said) && !/Produce the document for the app/.test(said), said);
  }

  /* ---- 4. an app from a script --------------------------------------------------------------------------------- */
  console.log("\n4. An app made from a workflow script still runs durably");
  {
    const made = await create({ name: "KPI table", sourceKind: "workflow", workflow: "kpi-table" });
    check("created (201), as a script", made.status === 201 && made.body?.item?.source?.kind === "script", made);
    const out = await refresh(made.body.item.id);
    const row = await appRow(made.body.item.id);
    check("the refresh succeeds and the document is what the script returned", out.status === 200 && row.content_md === DOCUMENT(SPECIALIST) && row.last_error === null, { out, content: row.content_md, error: row.last_error });
    const [run] = row.last_run_id ? await admin`SELECT status, workflow_name FROM workflow_runs WHERE run_id = ${row.last_run_id}` : [];
    check("…through a durable workflow run, recorded completed", run?.status === "completed" && run.workflow_name === "kpi-table", { run, last_run_id: row.last_run_id });
  }

  /* ---- 5. retry an app saved before the fix --------------------------------------------------------------------- */
  console.log("\n5. An app saved before the fix, carrying the old error, refreshes without being recreated");
  {
    // As the live app stands: workflow source, a specialist's row, no brief, an error left from an earlier pick.
    const [old] = await admin`
      INSERT INTO apps (org_id, slug, name, source_kind, workflow, last_error, last_refresh_at, enabled, created_by)
      VALUES (${ORG}, ${`old-${stamp}`}, 'Balance sheet of the companies (old)', 'workflow', ${SPECIALIST}, 'Workflow "annual-report-format" has no script.', now() - interval '1 day', true, ${ANALYST}) RETURNING id`;
    const item = (await listed()).find((a) => a.id === old.id);
    check("the list still shows its error, and says its source CAN run now", item?.lastError === 'Workflow "annual-report-format" has no script.' && item.source?.ok === true && item.source.kind === "specialist", item);
    const out = await refresh(old.id);
    const row = await appRow(old.id);
    check("a retry succeeds on the same app (200)", out.status === 200 && out.body?.ok === true && out.body.item?.id === old.id, out);
    check("it has its document and the error is gone", row.content_md === DOCUMENT(SPECIALIST) && row.last_error === null, { content: row.content_md, error: row.last_error });
  }

  /* ---- 6. an app whose source cannot run ------------------------------------------------------------------------ */
  console.log("\n6. An app whose source cannot run says so, with what to do; changing the source repairs it");
  {
    const [broken] = await admin`
      INSERT INTO apps (org_id, slug, name, source_kind, workflow, enabled, created_by)
      VALUES (${ORG}, ${`broken-${stamp}`}, 'Notes board', 'workflow', 'weekly-notes', true, ${ANALYST}) RETURNING id`;
    const item = (await listed()).find((a) => a.id === broken.id);
    check("the list says it cannot refresh, why, and what to do, before anyone tries", item?.source?.ok === false && /has no script and is not one of this workspace's specialists/.test(item.source.reason) && /Give it a script under Workflows, or pick a workflow that has one\./.test(item.source.fix), item?.source);
    const mark = asked.length;
    const out = await refresh(broken.id);
    const row = await appRow(broken.id);
    const sentence = `"weekly-notes" has no script and is not one of this workspace's specialists, so there is nothing to run. Give it a script under Workflows, or pick a workflow that has one.`;
    check("a refresh is refused (409, not a 500) with that sentence, and the agent is never called", out.status === 409 && out.body?.error === sentence && asked.length === mark, out);
    check("the app carries the same sentence as its error, for the person who opens it next", row.last_error === sentence, row.last_error);
    const paused = await patch(broken.id, { enabled: false });
    check("it can still be paused while it is broken", paused.status === 200 && paused.body?.item?.enabled === false, paused);
    const worse = await patch(broken.id, { workflow: "no-such-workflow" });
    check("changing its source to another that cannot run is refused (400) and changes nothing", worse.status === 400 && (await appRow(broken.id)).workflow === "weekly-notes", worse);
    const fixed = await patch(broken.id, { workflow: SPECIALIST });
    const after = await appRow(broken.id);
    check("changing its source to a specialist is accepted", fixed.status === 200 && fixed.body?.item?.source?.ok === true && after.workflow === SPECIALIST, fixed);
    check("…and the error about the source it no longer has is cleared (it used to stay, naming the old workflow)", after.last_error === null, after.last_error);
    const [attempt] = await admin`SELECT error FROM app_versions WHERE app_id = ${broken.id} AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
    check("the failed attempt stays in the version history", attempt?.error === sentence, attempt);
    const out2 = await refresh(broken.id);
    check("and the same app now refreshes to a document", out2.status === 200 && (await appRow(broken.id)).content_md === DOCUMENT(SPECIALIST), out2);
    const renamed = await patch(broken.id, { name: "Notes board (renamed)" });
    check("an edit that does not touch the source leaves the document and state alone", renamed.status === 200 && (await appRow(broken.id)).content_md === DOCUMENT(SPECIALIST), renamed);
  }

  /* ---- 7. the cron ---------------------------------------------------------------------------------------------- */
  console.log("\n7. The scheduled refresh runs a specialist app too");
  {
    await admin`UPDATE apps SET enabled = false WHERE org_id = ${ORG}`;
    const made = await create({ name: "Hourly ledger digest", sourceKind: "workflow", workflow: SPECIALIST, refreshCron: "* * * * *" });
    const cronRoute = await import("../app/api/cron/refresh-apps/route.ts");
    const mark = asked.length;
    let outcome = null;
    for (let tick = 0; tick < 4 && !outcome; tick++) {
      const r = await json(await cronRoute.GET(new NextRequest(`${WEB}/api/cron/refresh-apps`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })));
      outcome = r.body?.outcomes?.find((o) => o.app === made.body?.item?.slug) ?? (r.status === 200 ? null : { status: `http_${r.status}`, body: r.body });
    }
    const row = await appRow(made.body.item.id);
    check("the cron refreshes it", outcome?.status === "refreshed", outcome);
    check("its document is the specialist's reply, for this workspace", row.content_md === DOCUMENT(SPECIALIST) && row.last_error === null && asked.slice(mark).some((a) => a.who === SPECIALIST && a.scope === ORG), { content: row.content_md, error: row.last_error, asked: asked.slice(mark).map((a) => [a.who, a.scope]) });
  }
} finally {
  await cleanup();
  await admin.end({ timeout: 2 }).catch(() => undefined);
}

console.log(`\ntest-app-source-db: ${passed} check(s) passed${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
