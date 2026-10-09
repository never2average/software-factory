/**
 * AN APP REFRESH OUTLIVES THE REQUEST THAT ASKED FOR IT — through the real routes, against a real Postgres, with the
 * web function KILLED at its limit the way the platform kills it.
 *
 * What was broken. On the live app, "Balance sheet of the companies" (a specialist's row, no brief) was refreshed
 * with POST /api/ops/apps/<id>/refresh. The route ran the whole refresh inside the request: it waited for the
 * specialist (which fetches filings and runs code, many minutes) until the platform killed the function at the
 * route's 300 s limit (504 FUNCTION_INVOCATION_TIMEOUT). Nothing recorded that: the app kept `refreshing_at` from the
 * start, no session, no run, its old error, no content — "refreshing" for ever.
 *
 * The deployment under test is this tree stamped as the software factory stamps one (the relabelled fixture profile
 * and a fixture specialist, as scripts/test-app-source-db.mjs does). The AGENT is a real HTTP server here that
 * answers eve's session API: a session it opens takes as long as the case says, can park on a question, or the
 * session create can hang. The WEB FUNCTION that serves a person's Try again is a separate process (this script with
 * --invocation) that is SIGKILLed when the forced limit runs out, as Vercel ends a function: nothing in it survives.
 * The cron and the list are called in this process, as the platform calls them later.
 *
 *   1. LONGER THAN THE LIMIT   a specialist slower than the route's limit: the request answers 202 at once with the
 *                              session it opened, recorded on the app; the function is killed; the specialist finishes
 *                              later; the next cron tick writes its document, by the person who asked
 *   2. KILLED BEFORE IT STARTS a function killed before any session was recorded leaves a marker that EXPIRES: past
 *                              the bound the list (and the cron) end it with a sentence and a failed version; a fresh
 *                              one is left alone; the live app's shape (marker, no session, an old error) is ended by
 *                              the same rule; one still running past the longest a refresh may take is stopped
 *   3. ONE RUN                 two Try agains at once start one session; the second joins it; a third joins it too
 *   4. NOBODY TO ANSWER        a specialist that parks on a question fails the refresh at once, naming what it asked
 *                              (#114's rule for unattended steps), and its turn is cancelled
 *   5. WORKSPACES              two workspaces' apps refreshed side by side: each session is opened, read and written
 *                              in its own workspace only; a member of one cannot refresh the other's app
 *
 * It imports nothing this change added (the routes, and modules that exist on the commit before), so it runs
 * unchanged on the code before it, where it fails: see the pull request for that run.
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:app-refresh-background-db
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SELF = "scripts/test-app-refresh-background-db.mjs";
const STAMPED = process.argv.includes("--stamped");
const INVOCATION = process.argv.includes("--invocation");
const SPECIALIST = "ledger-reader";
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const FLAGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server"];

/* ================================================================================================================ */
/* The outer run: stamp a copy of the tree (relabelled profile + the fixture specialist) and run the test inside it. */
/* ================================================================================================================ */
if (!STAMPED) {
  if (!adminUrl || !appUrl) {
    console.log("test-app-refresh-background-db: SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
    process.exit(0);
  }
  const dir = mkdtempSync(join(tmpdir(), "app-refresh-bg-stamped-"));
  let status = 1;
  try {
    for (const e of ["agent", "app", "lib", "components", "data", "scripts", "library", "profiles", "package.json", "tsconfig.json", "dm.md"]) {
      if (existsSync(join(HERE, e))) cpSync(join(HERE, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes("/.eve") });
    }
    cpSync(join(HERE, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "profiles/50-relabelled.json"));
    mkdirSync(join(dir, "agent/subagents", SPECIALIST), { recursive: true });
    cpSync(join(HERE, "scripts/fixtures/app-source/ledger-reader.agent.ts.txt"), join(dir, "agent/subagents", SPECIALIST, "agent.ts"));
    symlinkSync(join(HERE, "node_modules"), join(dir, "node_modules"), "dir");
    for (const s of ["scripts/gen-subagent-meta.mjs", "scripts/gen-deployment-profile.mjs"]) {
      const r = spawnSync(process.execPath, [s], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${s} failed in the stamped copy:\n${r.stderr || r.stdout}`);
    }
    const r = spawnSync(process.execPath, [...FLAGS, SELF, "--stamped"], { cwd: dir, env: process.env, stdio: "inherit" });
    status = r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}

/* ================================================================================================================ */
/* Inside the stamped copy (the test, and each web function invocation it starts).                                  */
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

const WEB = "http://web.app-refresh.test";

/* ---- a web function invocation: one POST /api/ops/apps/<id>/refresh, then it lives until it is killed ----------- */
if (INVOCATION) {
  const appId = process.argv[process.argv.indexOf("--invocation") + 1];
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/ops/apps/[id]/refresh/route.ts");
  process.stdout.write("READY\n");
  // The request arrives when the test says so: the limit is the request's, not this process's start-up.
  await new Promise((resolve) => process.stdin.once("data", resolve));
  const res = await route.POST(
    new NextRequest(`${WEB}/api/ops/apps/${appId}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.PROBE_TOKEN}`, "x-ops-org": process.env.PROBE_ORG, "x-ops-actor": process.env.PROBE_ACTOR },
    }),
    { params: Promise.resolve({ id: appId }) },
  );
  const body = await res.json().catch(() => null);
  process.stdout.write(`RESPONSE ${JSON.stringify({ status: res.status, body })}\n`);
  // Whatever the route left running keeps running here, until the platform ends the function.
  setInterval(() => {}, 1 << 30);
} else {
  await main();
}

async function main() {
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- the agent: a real HTTP server answering eve's session API ------------------------------------------------ */
  /**
   * What a session does is said in the app's description, which reaches the specialist in its brief:
   *   MODE:slow     answers SLOW_MS after it was opened (longer than the web function's limit)
   *   MODE:never    never answers (still working past the longest a refresh may take)
   *   MODE:park     the specialist asks the person a question; the root parks on it
   *   MODE:hang     the session create itself never answers (the function dies before a session is recorded)
   *   otherwise     answers at once
   */
  const LIMIT_MS = 3_000; // the forced route limit
  const SLOW_MS = 7_000; // the specialist: longer than the limit
  const sessions = new Map(); // id → { scope, mode, readyAt, message, cancelled }
  const calls = []; // { method, path, scope, auth, session }
  let personToken = "";
  const modeOf = (message) => /MODE:(slow|never|park|hang)/.exec(message)?.[1] ?? "instant";
  const DOCUMENT = (scope) => `# Balance sheet\n\n| Company | Total assets (Rs crore) |\n|---|---|\n| Acme Housing | 1,240 |\n\n_Written for workspace ${scope}._`;
  const agent = createServer(async (req, res) => {
    const url = new URL(req.url, "http://agent");
    const scope = req.headers["x-workspace-scope"] ?? null;
    const auth = req.headers.authorization === `Bearer ${personToken}` ? "person" : req.headers.authorization ? "service" : "none";
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST" && url.pathname === "/eve/v1/session") {
      const { message } = JSON.parse(body || "{}");
      const mode = modeOf(message);
      calls.push({ method: "POST", path: url.pathname, scope, auth, mode });
      if (mode === "hang") return; // never answers: the function is killed waiting
      const id = `wrun_bg_${sessions.size + 1}_${randomUUID().slice(0, 8)}`;
      sessions.set(id, { scope, mode, message, readyAt: Date.now() + (mode === "slow" ? SLOW_MS : 0), cancelled: 0 });
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: id }));
      return;
    }
    const cancel = /^\/eve\/v1\/session\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && cancel) {
      const s = sessions.get(decodeURIComponent(cancel[1]));
      calls.push({ method: "POST", path: url.pathname, scope, auth, session: cancel[1] });
      if (s) s.cancelled++;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const stream = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(url.pathname);
    if (req.method === "GET" && stream) {
      const id = decodeURIComponent(stream[1]);
      const s = sessions.get(id);
      calls.push({ method: "GET", path: url.pathname, scope, auth, session: id });
      if (!s) return res.writeHead(404).end("no session");
      // The agent's own rule: a service caller reads a session only while it names that session's workspace.
      if (auth === "service" && scope !== s.scope) return res.writeHead(404).end("no session");
      const start = Number(url.searchParams.get("startIndex") ?? 0);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const emit = (events) => {
        for (const e of events.slice(start)) res.write(`${JSON.stringify(e)}\n`);
      };
      if (s.mode === "park") {
        emit([
          { type: "session.started", data: {} },
          { type: "subagent.called", data: { callId: "call_1", name: SPECIALIST, childSessionId: `${id}_child` } },
          { type: "input.requested", data: { requests: [{ prompt: "Which financial year should I use?" }] } },
          { type: "message.completed", data: { message: `I'll hand this to the ${SPECIALIST} specialist.` } },
          { type: "turn.completed", data: {} },
          { type: "session.waiting", data: {} },
        ]);
        return res.end();
      }
      const done = [
        { type: "session.started", data: {} },
        { type: "message.completed", data: { message: DOCUMENT(s.scope) } },
        { type: "turn.completed", data: {} },
      ];
      if (s.mode !== "never" && Date.now() >= s.readyAt) {
        emit(done);
        return res.end();
      }
      // Still working: the stream stays open until it is done, or the reader goes away.
      if (start === 0) res.write(`${JSON.stringify(done[0])}\n`);
      if (s.mode === "never") return;
      const timer = setTimeout(() => {
        for (const e of done.slice(Math.max(1, start))) res.write(`${JSON.stringify(e)}\n`);
        res.end();
      }, s.readyAt - Date.now());
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((r) => agent.listen(0, "127.0.0.1", r));
  const AGENT = `http://127.0.0.1:${agent.address().port}`;

  /* ---- a deployment off Vercel that reaches its agent as itself (SERVICE_AUTH=session-key) ---------------------- */
  for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
  delete process.env.GOOGLE_CLIENT_ID;
  process.env.SERVICE_AUTH = "session-key";
  const CRON_SECRET = `cron-${randomUUID()}`;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.NEXT_PUBLIC_EVE_API_URL = AGENT;
  // The background follow inside the web function is held to the forced limit too.
  process.env.APP_REFRESH_BACKGROUND_MS = String(LIMIT_MS);
  const { exportPKCS8, exportSPKI, generateKeyPair } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
  process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

  const postgres = (await import("postgres")).default;
  const stamp = `${Date.now()}-${process.pid}`;
  const ORG = `refbg-a-${stamp}`;
  const ORG_B = `refbg-b-${stamp}`;
  const ANALYST = `analyst-${stamp}@refbg.test`;
  const OTHER = `other-${stamp}@refbg.test`;
  const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
  const cleanup = async () => {
    for (const org of [ORG, ORG_B]) {
      for (const t of ["app_versions", "apps", "workflow_run_journal", "workflow_runs", "automation_runs", "automation_audit", "workflows", "agent_session_scopes", "agent_session_owners", "org_members"]) {
        await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch(() => undefined);
      }
      await admin`DELETE FROM orgs WHERE org_id = ${org}`.catch(() => undefined);
    }
  };

  const { NextRequest } = await import("next/server");
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const token = await mintSessionToken(ANALYST);
  const otherToken = await mintSessionToken(OTHER);
  personToken = token;
  const as = (who, org, path, init = {}) =>
    new NextRequest(`${WEB}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${who === OTHER ? otherToken : token}`, "x-ops-org": org, "x-ops-actor": who, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const appRow = async (id) => (await admin`SELECT * FROM apps WHERE id = ${id}`)[0];
  const versions = async (id) => admin`SELECT content_md, error, session_id, created_by FROM app_versions WHERE app_id = ${id} ORDER BY created_at`;
  const created = (mode) => calls.filter((c) => c.method === "POST" && c.path === "/eve/v1/session" && (!mode || c.mode === mode));
  const makeApp = async (org, name, description) => {
    const [row] = await admin`
      INSERT INTO apps (org_id, slug, name, description, source_kind, workflow, enabled, created_by)
      VALUES (${org}, ${`${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`}, ${name}, ${description}, 'workflow', ${SPECIALIST}, true, ${ANALYST}) RETURNING id`;
    return row.id;
  };
  const cronTick = async () => {
    const route = await import("../app/api/cron/refresh-apps/route.ts");
    return json(await route.GET(new NextRequest(`${WEB}/api/cron/refresh-apps`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })));
  };
  const listed = async (who = ANALYST, org = ORG) => {
    const route = await import("../app/api/ops/apps/route.ts");
    return (await json(await route.GET(as(who, org, "/api/ops/apps")))).body?.items ?? [];
  };
  const refreshHere = async (id, who = ANALYST, org = ORG) => {
    const route = await import("../app/api/ops/apps/[id]/refresh/route.ts");
    return json(await route.POST(as(who, org, `/api/ops/apps/${id}/refresh`, { method: "POST" }), { params: Promise.resolve({ id }) }));
  };
  const until = async (fn, ms = 20_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return true;
    return false;
  };

  /**
   * One web function invocation serving a person's Try again, killed when the limit runs out (SIGKILL: as the
   * platform ends a function, nothing in it gets to clean up). Resolves with the response it sent in time, or 504.
   */
  const invocation = (appId) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [...FLAGS, SELF, "--stamped", "--invocation", appId], {
        cwd: process.cwd(),
        env: { ...process.env, PROBE_TOKEN: token, PROBE_ORG: ORG, PROBE_ACTOR: ANALYST },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let out = "";
      let response = null;
      let sentAt = 0;
      child.stdout.on("data", (d) => {
        out += d;
        if (!sentAt && out.includes("READY\n")) {
          sentAt = Date.now();
          child.stdin.write("go\n");
          setTimeout(() => child.kill("SIGKILL"), LIMIT_MS);
        }
        const m = /RESPONSE (.*)\n/.exec(out);
        if (m && !response) response = { ...JSON.parse(m[1]), ms: Date.now() - sentAt };
      });
      child.on("exit", () => resolve(response ?? { status: 504, body: "FUNCTION_INVOCATION_TIMEOUT (killed at the limit)", ms: Date.now() - sentAt }));
    });

  try {
    await cleanup();
    for (const [org, who] of [[ORG, ANALYST], [ORG_B, OTHER]]) {
      await admin`INSERT INTO orgs (org_id, name, status) VALUES (${org}, ${org}, 'active')`;
      await admin`INSERT INTO org_members (org_id, email, role) VALUES (${org}, ${who}, 'member')`;
      await admin`INSERT INTO workflows (org_id, name, description, trigger, script, enabled, created_by) VALUES (${org}, ${SPECIALIST}, 'Reads ledgers.', 'on delegation', null, true, ${who})`;
    }
    console.log(`  (agent at ${AGENT}; web function limit forced to ${LIMIT_MS} ms; workspaces ${ORG} and ${ORG_B})`);

    /* ---- 1. longer than the limit ------------------------------------------------------------------------------- */
    console.log("\n1. A specialist slower than the route's limit: the request answers at once, the document arrives later");
    {
      // As the live app stands: a specialist's row, no brief, so the brief is its name and description.
      const id = await makeApp(ORG, "Balance sheet of the companies", "Total assets and net worth of every covered company. MODE:slow");
      const res = await invocation(id);
      check("the request answers within the limit (202), naming the session it opened", res.status === 202 && res.ms < LIMIT_MS && typeof res.body?.sessionId === "string", res);
      const during = await appRow(id);
      check("the function is gone, and the app records the refresh: started, with its session", during.refreshing_at !== null && during.last_session_id === res.body?.sessionId && during.content_md === null, { refreshing_at: during.refreshing_at, last_session_id: during.last_session_id });
      check("…the specialist was asked once", created("slow").length === 1, created("slow"));
      await sleep(Math.max(0, SLOW_MS - LIMIT_MS) + 500); // the specialist finishes, with nobody listening
      const tick = await cronTick();
      const after = await appRow(id);
      check("the next cron tick writes the specialist's document", tick.status === 200 && after.content_md === DOCUMENT(ORG), { tick: tick.body, content: after.content_md });
      check("…and the app is no longer refreshing, with no error and the session it came from", after.refreshing_at === null && after.last_error === null && after.last_session_id === res.body?.sessionId, { refreshing_at: after.refreshing_at, last_error: after.last_error });
      const v = await versions(id);
      check("…one version, the document, by the person who asked", v.length === 1 && v[0].content_md === DOCUMENT(ORG) && v[0].created_by === ANALYST && v[0].session_id === res.body?.sessionId, v);
      const reads = calls.filter((c) => c.session === res.body?.sessionId);
      check("every call on that session named its workspace, as the platform's own identity", reads.length > 0 && reads.every((c) => c.scope === ORG && c.auth === "service"), reads);
    }

    /* ---- 2. killed before it started ---------------------------------------------------------------------------- */
    console.log("\n2. A function killed before any session was recorded leaves a marker that expires");
    {
      const id = await makeApp(ORG, "Borrowings mix", "Borrowings by instrument. MODE:hang");
      const res = await invocation(id);
      const killed = await appRow(id);
      check("the request never answered: killed at the limit (504)", res.status === 504, res);
      check("…the app is left marked refreshing, with no session", killed.refreshing_at !== null && killed.last_session_id === null, { refreshing_at: killed.refreshing_at, last_session_id: killed.last_session_id });
      let item = (await listed()).find((a) => a.id === id);
      check("a fresh marker is left alone: it may still be starting", item?.refreshingAt !== null && item?.lastError === null, item && { refreshingAt: item.refreshingAt, lastError: item.lastError });
      await admin`UPDATE apps SET refreshing_at = refreshing_at - interval '6 minutes' WHERE id = ${id}`;
      item = (await listed()).find((a) => a.id === id);
      check("past the bound, the list ends it: not refreshing, and it says what happened in a sentence", item?.refreshingAt === null && /stopped before it could start its work.*Try again\./.test(item?.lastError ?? ""), item && { refreshingAt: item.refreshingAt, lastError: item.lastError });
      const v = await versions(id);
      check("…a failed version records it", v.some((x) => x.error && /stopped before it could start/.test(x.error)), v);

      // The live app exactly: a marker 20 minutes old, no session or run, an old error, no versions at all.
      const [live] = await admin`
        INSERT INTO apps (org_id, slug, name, source_kind, workflow, last_error, refreshing_at, enabled, created_by)
        VALUES (${ORG}, ${`live-${stamp}`}, 'Balance sheet of the companies (live)', 'workflow', ${SPECIALIST}, 'Workflow "annual-report-format" has no script.', now() - interval '20 minutes', true, ${ANALYST}) RETURNING id`;
      const tick = await cronTick();
      const after = await appRow(live.id);
      check("the live app's stuck marker is ended by the same rule on the next cron tick", tick.status === 200 && after.refreshing_at === null && /stopped before it could start its work/.test(after.last_error ?? ""), { refreshing_at: after.refreshing_at, last_error: after.last_error });
      const again = await refreshHere(live.id);
      check("…and it can be refreshed again at once (202, a new session)", again.status === 202 && again.body?.started === true, again);
      await until(async () => (await appRow(live.id)).refreshing_at === null);

      // Still running past the longest a refresh may take: stopped, its turn cancelled, said so.
      const slowest = await makeApp(ORG, "Ten-year history", "Every filing since 2016. MODE:never");
      const started = await refreshHere(slowest);
      await sleep(300);
      check("a refresh whose specialist never finishes is still refreshing at first", started.status === 202 && (await appRow(slowest)).refreshing_at !== null, started);
      await admin`UPDATE apps SET refreshing_at = refreshing_at - interval '61 minutes' WHERE id = ${slowest}`;
      await cronTick();
      const over = await appRow(slowest);
      check("past the longest a refresh may take, the cron stops it and says so", over.refreshing_at === null && /was still not finished after 60 minutes/.test(over.last_error ?? ""), { refreshing_at: over.refreshing_at, last_error: over.last_error });
      check("…and cancels its turn on the agent", (sessions.get(started.body?.sessionId)?.cancelled ?? 0) > 0, sessions.get(started.body?.sessionId));
    }

    /* ---- 3. one run ----------------------------------------------------------------------------------------------- */
    console.log("\n3. Two Try agains start one run");
    {
      const id = await makeApp(ORG, "Asset quality", "GNPA and NNPA by company. MODE:slow");
      const before = created("slow").length;
      const [a, b] = await Promise.all([refreshHere(id), refreshHere(id)]);
      check("both answer 202", a.status === 202 && b.status === 202, [a.status, b.status]);
      check("one started it, the other joined it", [a, b].filter((r) => r.body?.started === true).length === 1 && [a, b].filter((r) => r.body?.joined === true).length === 1, [a.body, b.body].map((x) => ({ started: x?.started, joined: x?.joined })));
      const c = await refreshHere(id);
      const one = [a, b].find((r) => r.body?.started)?.body?.sessionId;
      check("a third, while it runs, joins it too, and says which session", c.status === 202 && c.body?.joined === true && c.body?.sessionId === one, c.body);
      check("the specialist was asked ONCE", created("slow").length - before === 1, created("slow").length - before);
      // The background follow gives up at the limit; the cron collects the rest.
      await sleep(SLOW_MS);
      await cronTick();
      const v = await versions(id);
      check("one version, the document", v.length === 1 && v[0].content_md === DOCUMENT(ORG), v);
    }

    /* ---- 4. nobody to answer -------------------------------------------------------------------------------------- */
    console.log("\n4. A specialist that parks on a question fails the refresh at once, naming what it asked");
    {
      const id = await makeApp(ORG, "Liquidity", "ALM buckets. MODE:park");
      const res = await refreshHere(id);
      await until(async () => (await appRow(id)).refreshing_at === null, 10_000);
      const row = await appRow(id);
      check("started (202), then failed, not hung", res.status === 202 && row.refreshing_at === null && row.content_md === null, { status: res.status, refreshing_at: row.refreshing_at });
      check("…with the sentence naming the specialist and its question, and that nobody can answer it", /The "ledger-reader" specialist asked a question \("Which financial year should I use\?"\), and this step runs with nobody to answer it/.test(row.last_error ?? ""), row.last_error);
      check("…and its parked turn was cancelled on the agent", (sessions.get(res.body?.sessionId)?.cancelled ?? 0) > 0, sessions.get(res.body?.sessionId));
      check("…not the root's narration stored as the document", !(await versions(id)).some((v) => v.content_md && /hand this to/.test(v.content_md)));
    }

    /* ---- 5. workspaces -------------------------------------------------------------------------------------------- */
    console.log("\n5. Each refresh opens, reads and writes only its own workspace");
    {
      // The same app, by name, in two workspaces.
      const idA = await makeApp(ORG, "Peer table", "Peers. MODE:slow");
      const idB = await makeApp(ORG_B, "Peer table", "Peers. MODE:slow");
      const mark = calls.length;
      const [ra, rb] = await Promise.all([refreshHere(idA, ANALYST, ORG), refreshHere(idB, OTHER, ORG_B)]);
      check("both start (202), each its own session", ra.status === 202 && rb.status === 202 && ra.body?.sessionId && rb.body?.sessionId && ra.body.sessionId !== rb.body.sessionId, [ra.body, rb.body]);
      const cross = await refreshHere(idA, OTHER, ORG_B);
      check("a member of the other workspace cannot refresh this one's app (404), and nothing is started", cross.status === 404 && calls.slice(mark).filter((c) => c.method === "POST" && c.path === "/eve/v1/session").length === 2, { status: cross.status });
      check("each session was opened in its app's workspace", sessions.get(ra.body.sessionId)?.scope === ORG && sessions.get(rb.body.sessionId)?.scope === ORG_B);
      await sleep(SLOW_MS);
      const tick = await cronTick();
      check("one cron tick collects both, each in its own workspace", tick.status === 200 && (tick.body?.collected ?? []).filter((c) => c.status === "refreshed").length >= 2, tick.body);
      const [a, b] = [await appRow(idA), await appRow(idB)];
      check("each app holds its own workspace's document, and only that", a.content_md === DOCUMENT(ORG) && b.content_md === DOCUMENT(ORG_B), { a: a.content_md, b: b.content_md });
      const wrong = calls.slice(mark).filter((c) => (c.session === ra.body.sessionId && c.scope !== ORG) || (c.session === rb.body.sessionId && c.scope !== ORG_B));
      check("no call on either session named the other workspace", wrong.length === 0, wrong);
      const [va, vb] = [await versions(idA), await versions(idB)];
      check("each version history is its own", va.length === 1 && vb.length === 1 && va[0].session_id === ra.body.sessionId && vb[0].session_id === rb.body.sessionId, { va, vb });
      const seenByB = await listed(OTHER, ORG_B);
      check("the other workspace's list shows only its own apps", seenByB.length > 0 && seenByB.every((x) => x.orgId === ORG_B), seenByB.map((x) => x.orgId));
    }
  } finally {
    await cleanup();
    await admin.end({ timeout: 2 }).catch(() => undefined);
    agent.closeAllConnections?.();
    agent.close();
  }

  console.log(`\ntest-app-refresh-background-db: ${passed} check(s) passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}
