// The lane world: an application's console and API from its lane copy, on this machine only, with one signed-in person.
//   <lane copy>/node_modules/.bin/tsx world.mts --codebase <lane copy> --console <a built console's web dir>
//       --api-port N (--harness <a11y.mjs|responsive.mjs> | --suite <suite.json>) [--pages <pages.json>] [--deadline S]
//       [-- harness args]
//   --suite    [{name, harness, argv}]: run one after another in this one world (mold_v0-147: one build, one database,
//              one `next start` for a11y, layout, screenshots and any probe); the exit code is the worst of them
//   --pages    [{path, reasons}]: grade only these of the build's pages (render.py --pages auto|<list>), every row of a
//              page kept (a page two packs share keeps both rows); a named page the build does not serve is said so
// Started by render.py, which builds the console first (or takes a cached build). In order:
//   1. The environment is emptied down to what node needs (PATH, HOME, locale, temp): no DATABASE_URL, key or service
//      address of the operator's shell can reach the API or the console.
//   2. The shell's own throwaway world (scripts/lib/test-world.ts: an embedded database in a temporary folder, an
//      unlocked throwaway vault) and its offline Clerk (scripts/lib/mock-providers.ts) on 127.0.0.1.
//   3. The lane copy's API (src/http.ts createApp) on 127.0.0.1:<api port>, the port the console was built against.
//   4. One workspace ("Lane workspace") linked to a mock Clerk organisation, and one person, its owner, who is also
//      platform staff, so both /app and /admin render signed in; and two people in no workspace (one of them staff), for
//      the portal's page for no account (a page's `as` in surface.mts picks them). The session is a token the mock signs and the API
//      verifies; a fresh one is minted for every page (they live five minutes). Then the shared record areas' sample
//      records (mold_v0-170: pack.json record_areas[].samples), so their pages are graded with rows.
//   5. The console: `next start` on 127.0.0.1 (a free port), killed with this process (PR_SET_PDEATHSIG).
//   6. Each harness's run({origin, api, lane, pages, packs, session, sessionAs, argv}): pages from surface.mts (filtered by
//      --pages), a row per pack; api and lane for a harness that reads the API itself or imports the lane copy's modules
//      (testing/parity/snapshot.mts).
// Everything is torn down at the end, at --deadline, or on a signal; the temporary folder is removed.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const head = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
const opt = (k: string) => { const i = head.indexOf(k); return i >= 0 ? head[i + 1] : undefined; };
const lane = path.resolve(opt("--codebase") ?? "");
const consoleDir = path.resolve(opt("--console") ?? "");
const apiPort = Number(opt("--api-port"));
const suiteFile = opt("--suite");
const pagesFile = opt("--pages");
const deadline = Number(opt("--deadline") ?? 1500);
const rest = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
if (!opt("--codebase") || !opt("--console") || !apiPort || !(opt("--harness") || suiteFile)) {
  console.error("usage: world.mts --codebase <lane copy> --console <web> --api-port N (--harness <file> | --suite <json>) [--pages <json>] [--deadline S] -- [args]");
  process.exit(2);
}
const { readFileSync } = await import("node:fs");
const suite: { name: string; harness: string; argv: string[] }[] = suiteFile
  ? JSON.parse(readFileSync(suiteFile, "utf8"))
  : [{ name: path.basename(opt("--harness")!), harness: path.resolve(opt("--harness")!), argv: rest }];
const only: { path: string; reasons: string[] }[] | null = pagesFile ? JSON.parse(readFileSync(pagesFile, "utf8")) : null;

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

  // 4b. The packs' sample records (mold_v0-170: pack.json record_areas[].samples, shared areas only), written as a
  // repository's rows would be, so the shared areas' pages are graded with rows; an area a pack gives no samples stays
  // empty and its empty state is graded. An area read live from an API is not stored, so it gets none.
  const ra = await imp("src/record-areas.ts");
  let samples = 0;
  for (const a of ra.recordAreas() as { name: string; scope: string; repo: { kind: string } | null; samples?: { key: string; title?: string; version?: string; data: Record<string, unknown> }[] }[]) {
    if (a.scope !== "platform" || a.repo?.kind === "http_api") continue;
    for (const x of a.samples ?? []) {
      await ra.putPlatform(null, a.name, x.key, { title: x.title ?? null, version: x.version ?? null, data: x.data }, "put", { source: "lane:samples", fingerprint: `lane:${x.key}` });
      samples++;
    }
  }
  if (samples) console.log(`lane world: ${samples} sample record(s) written to the shared areas that declare them`);

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

  // 6. The harnesses, one after another, each with a row per pack.
  const { surface } = await import(pathToFileURL(path.join(import.meta.dirname, "surface.mts")).href);
  const s = await surface(lane);
  let pages = s.pages as { path: string }[];
  if (only) {
    const want = new Set(only.map((p) => p.path));
    pages = pages.filter((p) => want.has(p.path));
    const missing = [...want].filter((w) => !pages.some((p) => p.path === w));
    console.log(`lane world: grading ${new Set(pages.map((p) => p.path)).size} of ${new Set(s.pages.map((p: { path: string }) => p.path)).size} pages (--pages)${missing.length ? `; not served by this build: ${missing.join(", ")}` : ""}`);
  }
  code = 0;
  const results: string[] = [];
  for (const item of suite) {
    const t0 = Date.now();
    if (suite.length > 1) console.log(`\n== suite: ${item.name} (${path.basename(item.harness)}${item.argv.length ? " " + item.argv.join(" ") : ""})\n`);
    const h = await import(pathToFileURL(path.resolve(item.harness)).href);
    let c: number;
    try { c = Number(await h.run({ origin, api: `http://127.0.0.1:${apiPort}`, lane, pages, packs: s.packs, session, sessionAs, argv: item.argv })) || 0; }
    catch (e) { console.error(`lane world: ${item.name}: ${(e as Error).stack ?? e}`); c = 1; }
    results.push(`${item.name} exit ${c} (${Math.round((Date.now() - t0) / 1000)}s)`);
    code = Math.max(code, c);
  }
  if (suite.length > 1) console.log(`\n== suite: ${results.join("; ")}`);
} catch (e) {
  console.error(`lane world: ${(e as Error).stack ?? e}`);
  code = 1;
} finally {
  clearTimeout(timer);
  await down();
}
process.exit(code);
