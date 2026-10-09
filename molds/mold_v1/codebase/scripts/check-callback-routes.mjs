/**
 * EVE'S CALLBACK ROUTES STAY CLOSED, AND NOTHING NEEDS THEM OPEN (agent/lib/callback-guard.ts, lib/eve-callback-routes.ts).
 *
 * Fails when:
 *   · eve's framework callback channels are not exactly the ones lib/eve-callback-routes.ts names (an eve upgrade that
 *     adds or renames one would ship it unguarded) — read from the installed eve itself;
 *   · one of them has no agent/channels/<name>.ts built by closedCallbackChannel with that same name, or the built
 *     channel does not serve eve's method and path, or does not answer 404;
 *   · a connection becomes INTERACTIVE (its auth has `startAuthorization`, or principalType "user"): eve would then
 *     send a person's sign-in back to /eve/v1/connections/<name>/callback/<sessionId>:auth, which is closed here, and
 *     the sign-in would fail silently. Re-open it with a guard for exactly that shape first;
 *   · an agent declares a remote agent (`defineRemoteAgent`): its result comes back on /eve/v1/callback/<inbox token>;
 *   · a connection file is not a plain re-export of a connection this check can inspect;
 *   · the web app's refusal routes are gone, or its `/eve/v1/:path*` rewrite stops being a `fallback` (a bare array
 *     would apply it BEFORE the refusal routes, forwarding the callbacks to the agent again).
 *
 * Run:  npm run check:callback-routes      (--self-test: proves the connection rule catches an interactive one)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const problems = [];
const fail = (what) => problems.push(what);

/** The rule: a connection whose auth (or the auth it resolves to for a session) can start a person's sign-in. */
export function interactiveAuth(connection) {
  const auth = connection?.auth;
  if (auth === undefined || auth === null) return false;
  let resolved = auth;
  if (typeof auth === "function") {
    try {
      resolved = auth({ session: { auth: { current: null, initiator: null } } });
    } catch {
      return true; // cannot tell: treat as needing the route
    }
  }
  return typeof resolved?.startAuthorization === "function" || resolved?.principalType === "user";
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [{ auth: { principalType: "app", getToken() {} } }, false],
    [{ auth: () => ({ principalType: "app", getToken() {} }) }, false],
    [{ auth: { principalType: "user", getToken() {}, startAuthorization() {}, completeAuthorization() {} } }, true],
    [{ auth: () => ({ principalType: "user", getToken() {} }) }, true],
    [{ auth: () => { throw new Error("needs a session"); } }, true],
    [{}, false],
  ];
  const bad = cases.filter(([c, want]) => interactiveAuth(c) !== want);
  console.log(bad.length ? `self-test FAILED on ${bad.length} case(s)` : `self-test ok (${cases.length} cases)`);
  process.exit(bad.length ? 1 : 0);
}

const { CALLBACK_CHANNELS } = await import(pathToFileURL(join(ROOT, "lib/eve-callback-routes.ts")).href);

/* ---- 1. eve's own list ----------------------------------------------------------------------------------------- */
const eveFramework = await import(pathToFileURL(join(ROOT, "node_modules/eve/dist/src/runtime/framework-channels/index.js")).href);
const eveCallbacks = eveFramework
  .getFrameworkChannelDefinitions()
  .filter((d) => d.name !== "eve")
  .map((d) => `${d.name} ${d.method} ${d.urlPath}`)
  .sort();
const ours = CALLBACK_CHANNELS.map((c) => `${c.name} ${c.method} ${c.path}`).sort();
if (JSON.stringify(eveCallbacks) !== JSON.stringify(ours)) {
  fail(`eve's framework callback channels changed: eve has [${eveCallbacks.join("; ")}], lib/eve-callback-routes.ts names [${ours.join("; ")}]`);
}
const allNames = [...eveFramework.getAllFrameworkChannelNames()].filter((n) => n !== "eve").sort();
if (JSON.stringify(allNames) !== JSON.stringify(CALLBACK_CHANNELS.map((c) => c.name).sort())) fail(`eve's framework channel names changed: ${allNames.join(", ")}`);

/* ---- 2. each replaced, and the replacement refuses -------------------------------------------------------------- */
const { closedCallbackChannel } = await import(pathToFileURL(join(ROOT, "agent/lib/callback-guard.ts")).href);
const quiet = console.warn;
for (const spec of CALLBACK_CHANNELS) {
  const file = join(ROOT, "agent/channels", `${spec.name}.ts`);
  if (!existsSync(file)) {
    fail(`agent/channels/${spec.name}.ts is missing: eve would register its own unauthenticated ${spec.method} ${spec.path}`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  if (!new RegExp(`export default closedCallbackChannel\\("${spec.name.replace(/\//g, "\\/")}"\\);`).test(text)) fail(`agent/channels/${spec.name}.ts must export closedCallbackChannel("${spec.name}")`);
  const channel = closedCallbackChannel(spec.name);
  const route = channel.routes.length === 1 ? channel.routes[0] : null;
  if (!route || route.method !== spec.method || route.path !== spec.path) {
    fail(`${spec.name}: the replacement does not serve ${spec.method} ${spec.path}`);
    continue;
  }
  console.warn = () => {};
  const res = await route.handler(new Request(`http://x${spec.path.replace(":name", "github").replace(":token", "wrun_X:cancel")}`, { method: spec.method }), {
    params: { name: "github", token: "wrun_X:cancel" },
  });
  console.warn = quiet;
  if (res.status !== 404) fail(`${spec.name}: the replacement answered ${res.status}, not 404`);
}

/* ---- 3. nothing needs them open ------------------------------------------------------------------------------- */
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : [p];
  });
const agentFiles = walk(join(ROOT, "agent")).filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
const lib = await import(pathToFileURL(join(ROOT, "agent/lib/connections.ts")).href);
for (const file of agentFiles.filter((p) => /\/connections\/[^/]+\.ts$/.test(p))) {
  const rel = relative(ROOT, file);
  const hit = /^export \{ (\w+) as default \} from "#lib\/connections\.js";\s*$/.exec(readFileSync(file, "utf8").trim());
  if (!hit || !lib[hit[1]]) {
    fail(`${rel}: not a re-export of a connection in agent/lib/connections.ts, so this check cannot see its auth (extend it)`);
    continue;
  }
  if (interactiveAuth(lib[hit[1]])) fail(`${rel}: ${hit[1]} signs a person in (interactive auth); its callback route is closed (agent/lib/callback-guard.ts)`);
}
for (const [name, value] of Object.entries(lib)) {
  if (value && typeof value === "object" && "auth" in value && interactiveAuth(value)) fail(`agent/lib/connections.ts: ${name} signs a person in (interactive auth)`);
}
for (const file of agentFiles) {
  if (/\bdefineRemoteAgent\b/.test(readFileSync(file, "utf8"))) fail(`${relative(ROOT, file)} declares a remote agent; its result would arrive on the closed /eve/v1/callback route`);
}

/* ---- 4. the web app does not forward them ---------------------------------------------------------------------- */
for (const rel of ["app/eve/v1/callback/[...rest]/route.ts", "app/eve/v1/connections/[...rest]/route.ts"]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    fail(`${rel} is missing: the web app's /eve/v1/:path* rewrite would forward it to the agent`);
    continue;
  }
  const text = readFileSync(p, "utf8");
  for (const m of ["GET", "POST"]) if (!new RegExp(`export async function ${m}\\(\\): Promise<Response> \\{\\s*return refusedCallback\\(\\);`).test(text)) fail(`${rel}: ${m} must return refusedCallback()`);
}
const nextConfig = readFileSync(join(ROOT, "next.config.ts"), "utf8");
if (!/fallback:\s*\[\s*\{\s*source:\s*"\/eve\/v1\/:path\*"/.test(nextConfig)) fail("next.config.ts: the /eve/v1/:path* rewrite must stay under `fallback`, or it runs before the refusal routes");

if (problems.length) {
  console.error(`check:callback-routes FAILED:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check:callback-routes ok: eve's ${CALLBACK_CHANNELS.length} callback channels are replaced and refuse; no interactive connection, no remote agent; the web app forwards neither.`);
