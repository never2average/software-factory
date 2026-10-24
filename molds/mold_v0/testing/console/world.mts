// The lane world: an application's console and API from its lane copy, on this machine only, with one signed-in person.
//   <lane copy>/node_modules/.bin/tsx world.mts --codebase <lane copy> --console <build/<app>.lane-console/web>
//       --api-port N --harness <a11y.mjs|responsive.mjs> [--deadline S] -- [harness args]
// Started by render.py, which builds the console first. In order:
//   1. The environment is emptied down to what node needs (PATH, HOME, locale, temp): no DATABASE_URL, key or service
//      address of the operator's shell can reach the API or the console.
//   2. The shell's own throwaway world (scripts/lib/test-world.ts: an embedded database in a temporary folder, an
//      unlocked throwaway vault) and its offline Clerk (scripts/lib/mock-providers.ts) on 127.0.0.1.
//   3. The lane copy's API (src/http.ts createApp) on 127.0.0.1:<api port>, the port the console was built against.
//   4. One workspace ("Lane workspace") linked to a mock Clerk organisation, and one person, its owner, who is also
//      platform staff, so both /app and /admin render signed in; and two people in no workspace (one of them staff), for
//      the portal's page for no account (a page's `as` in surface.mts picks them). The session is a token the mock signs and the API
//      verifies; a fresh one is minted for every page (they live five minutes).
//   5. The console: `next start` on 127.0.0.1 (a free port), killed with this process (PR_SET_PDEATHSIG).
//   6. The harness's run({origin, pages, packs, session, argv}): pages from surface.mts, a row per pack.
// Everything is torn down at the end, at --deadline, or on a signal; the temporary folder is removed.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 && i < argv.indexOf("--") ? argv[i + 1] : undefined; };
const lane = path.resolve(opt("--codebase") ?? "");
const consoleDir = path.resolve(opt("--console") ?? "");
const apiPort = Number(opt("--api-port"));
const harness = path.resolve(opt("--harness") ?? "");
const deadline = Number(opt("--deadline") ?? 1500);
const rest = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
if (!opt("--codebase") || !opt("--console") || !apiPort || !opt("--harness")) {
  console.error("usage: world.mts --codebase <lane copy> --console <web> --api-port N --harness <file> [--deadline S] -- [args]");
  process.exit(2);
}

// 1. An empty environment: only what node and the browser need to start.
const KEEP = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER", "SHELL", "PLAYWRIGHT_BROWSERS_PATH", "NODE_OPTIONS"]);
for (const k of Object.keys(process.env)) if (!KEEP.has(k)) delete process.env[k];
const cleanEnv = { ...process.env };

const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
const freePort = () => new Promise<number>((res, rej) => {
  const s = netServer(); s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

const teardown: (() => Promise<unknown> | unknown)[] = [];
let tornDown = false;
async function down() {
  if (tornDown) return; tornDown = true;
  for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort: the rest still runs */ } }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { void down().then(() => process.exit(130)); });
const timer = setTimeout(() => {
  console.error(`lane world: stopped at its deadline (${deadline}s); nothing measured after that point counts.`);
  void down().then(() => process.exit(124));
}, deadline * 1000);

let code = 1;
try {
  process.chdir(lane);
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;

  // 2. The shell's throwaway world and offline Clerk.
  const tw = await imp("scripts/lib/test-world.ts");
  teardown.push(() => tw.cleanup());
  const { startMockProviders } = await imp("scripts/lib/mock-providers.ts");
  const mock = await startMockProviders();
  teardown.push(() => mock.close());
  const { pem } = await (await fetch(`${mock.url}/_mock/public-key`)).json() as { pem: string };
  Object.assign(process.env, { CLERK_SECRET_KEY: "sk_test_mock", CLERK_API_URL: mock.url, CLERK_FRONTEND_API_URL: mock.url, CLERK_JWT_KEY: pem, PUBLIC_URL: origin });

  // 3. The API, where the console was built to find it.
  const { createApp } = await imp("src/http.ts");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  teardown.push(() => new Promise((r) => api.close(() => r(null))));

  // 4. One workspace and its owner, who is also platform staff.
  const { createOrg } = await imp("src/auth.ts");
  const { getDb } = await imp("src/db.ts");
  const db = await getDb();
  const { org } = await createOrg("Lane workspace", "lane-workspace");
  const post = async (p: string, body: unknown, auth = false) => (await fetch(`${mock.url}${p}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer sk_test_mock" } : {}) },
  })).json() as Promise<Record<string, any>>;
  const corg = (await post("/v1/organizations", { name: org.name }, true)).id as string;
  await db.query("UPDATE organizations SET clerk_org_id = $1 WHERE id = $2", [corg, org.orgId]);
  const identity = { email: "lane.owner@example.org", first: "Lane", last: "Owner", org: org.name };
  const user = await post("/_mock/clerk/users", { email: identity.email, first_name: identity.first, verified: true, platform_admin: true });
  await post("/_mock/clerk/memberships", { org_id: corg, user_id: user.id, role: "org:admin" });
  const session = async () => {
    const token = (await post("/_mock/session", { user_id: user.id, org_id: corg, org_role: "admin" })).token as string;
    return [
      { name: "__session", value: token, url: origin },
      { name: "__lane_identity", value: encodeURIComponent(JSON.stringify(identity)), url: origin },
    ];
  };
  // Two people with no account here (mold_v0-098), so the portal's page for them is graded as well: someone who signed up
  // and is in no workspace, and platform staff with no workspace of their own (pages with `as` in surface.mts).
  const nobody = async (email: string, first: string, staff: boolean) => {
    const u = await post("/_mock/clerk/users", { email, first_name: first, verified: true, ...(staff ? { platform_admin: true } : {}) });
    const who = { email, first, last: "Person", org: "" };
    return async () => [
      { name: "__session", value: (await post("/_mock/session", { user_id: u.id })).token as string, url: origin },
      { name: "__lane_identity", value: encodeURIComponent(JSON.stringify(who)), url: origin },
    ];
  };
  const sessionAs = { no_account: await nobody("lane.outsider@example.org", "Lane", false), staff_no_account: await nobody("lane.staff@example.org", "Staff", true) };

  // 5. The console, killed with this process even if this process is killed outright.
  const pdeath = "import ctypes,os,signal,sys; ctypes.CDLL(None).prctl(1, signal.SIGTERM); os.execvp(sys.argv[1], sys.argv[1:])";
  const next: ChildProcess = spawn("python3", ["-c", pdeath, "node", "node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], {
    cwd: consoleDir, env: { ...cleanEnv, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", APP_API_URL: `http://127.0.0.1:${apiPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  next.stdout?.on("data", (b) => { log = (log + b).slice(-8000); });
  next.stderr?.on("data", (b) => { log = (log + b).slice(-8000); });
  teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { const r = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) }); up = r.status < 500; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!up) throw new Error(`the console did not come up on ${origin} (its /healthz, through the console to the API, never answered):\n${log}`);
  console.log(`lane world: console ${origin}, API 127.0.0.1:${apiPort}, one workspace and its owner (platform staff), embedded database`);

  // 6. The harness, with a row per pack.
  const { surface } = await import(pathToFileURL(path.join(import.meta.dirname, "surface.mts")).href);
  const s = await surface(lane);
  const h = await import(pathToFileURL(harness).href);
  code = await h.run({ origin, pages: s.pages, packs: s.packs, session, sessionAs, argv: rest });
} catch (e) {
  console.error(`lane world: ${(e as Error).stack ?? e}`);
  code = 1;
} finally {
  clearTimeout(timer);
  await down();
}
process.exit(code);
