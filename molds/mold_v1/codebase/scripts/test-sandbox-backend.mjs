/**
 * WHERE THE SANDBOX RUNS — `SANDBOX_BACKEND` and its settings (agent/lib/sandbox-settings.ts), as the two sandbox
 * definitions that read them (agent/sandbox.ts, agent/subagents/research/sandbox.ts) and the research prompt turn out.
 *
 * The rule this holds: with nothing set — every Vercel deployment — both definitions are what they were before the
 * setting existed. No `backend` (so eve still chooses Vercel Sandbox on Vercel), the same bootstrap commands, the
 * formatter still at /root/fmt_xlsx.py, and the research prompt still naming that path.
 *
 * And with `SANDBOX_BACKEND=microsandbox`: eve's microsandbox backend, 2 vCPUs and 1024 MiB unless set, and a network
 * policy that eve's OWN translation turns into deny rules for cloud metadata, the private ranges and loopback while
 * leaving the internet open; the formatter written to the sandbox user's home and the prompt naming that.
 *
 * Each case loads the real modules in a fresh process (they read the environment when loaded). No sandbox is created
 * and nothing is started: there is no KVM in CI. What that leaves unproven is in docs/self-hosting/SANDBOX.md.
 *
 *   npm run test:sandbox-backend
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(s, c, n) {
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS = ["SANDBOX_BACKEND", "SANDBOX_CPUS", "SANDBOX_MEMORY_MIB", "SANDBOX_DENY_SUBNETS"];

/* ---- the probe: one process, one environment, what the real modules are in it ---------------------------------- */

if (process.argv.includes("--probe")) {
  const out = { definitions: {}, prompt: null, settings: null, error: null };
  try {
    for (const file of ["agent/sandbox.ts", "agent/subagents/research/sandbox.ts"]) {
      const definition = (await import(pathToFileURL(join(ROOT, file)).href)).default;
      const commands = [];
      await definition.bootstrap({
        use: async (options) => {
          if (options !== undefined) commands.push({ useOptions: options });
          return { run: async ({ command }) => (commands.push(command), { exitCode: 0, stdout: "", stderr: "" }) };
        },
      });
      out.definitions[file] = { keys: Object.keys(definition).sort(), backend: definition.backend?.name ?? null, commands };
    }
    const instructions = (await import(pathToFileURL(join(ROOT, "agent/subagents/research/instructions.ts")).href)).default;
    const markdown = typeof instructions === "string" ? instructions : (instructions.markdown ?? JSON.stringify(instructions));
    out.prompt = { formatterLines: markdown.split("\n").filter((l) => l.includes("fmt_xlsx")), length: markdown.length };
    try {
      const settings = await import(pathToFileURL(join(ROOT, "agent/lib/sandbox-settings.ts")).href);
      out.settings = { microsandbox: settings.microsandboxSettings(), fmt: settings.fmtXlsxPath() };
    } catch (error) {
      out.settings = { error: String(error?.message ?? error) };
    }
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  process.stdout.write(`\n@@PROBE@@${JSON.stringify(out)}\n`);
  process.exit(0);
}

function probe(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SETTINGS.includes(k) && !k.startsWith("VERCEL")));
  const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--probe"], { env: { ...clean, ...env }, encoding: "utf8" });
  const line = r.stdout.split("\n").find((l) => l.startsWith("@@PROBE@@"));
  if (!line) return { error: `probe produced no result (exit ${r.status}): ${r.stderr.slice(-600)}`, definitions: {}, prompt: null, settings: null };
  return JSON.parse(line.slice("@@PROBE@@".length));
}

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 700)}`}`);
};

const ROOT_SB = "agent/sandbox.ts";
const RESEARCH_SB = "agent/subagents/research/sandbox.ts";
const TODAY_WRITE = "cat > /root/fmt_xlsx.py <<'FMTEOF'\n";
const TODAY_PROMPT = "`python3 /root/fmt_xlsx.py <file.xlsx> [...]`";

/* ---- unset, and every spelling of "the default": today's definitions ------------------------------------------- */

console.log("\nDefault (SANDBOX_BACKEND unset, empty or \"vercel\") — what every Vercel deployment runs:");
const base = probe({});
check("the definitions load", !base.error, base.error);
for (const [label, env] of [
  ["unset", {}],
  ["empty", { SANDBOX_BACKEND: "" }],
  ['"vercel"', { SANDBOX_BACKEND: "vercel" }],
  ['"Vercel " (case and spaces)', { SANDBOX_BACKEND: " Vercel " }],
  ["unset, with the microsandbox-only settings set anyway", { SANDBOX_CPUS: "8", SANDBOX_MEMORY_MIB: "4096", SANDBOX_DENY_SUBNETS: "203.0.113.7" }],
  ["on Vercel (VERCEL=1), unset", { VERCEL: "1", VERCEL_ENV: "production" }],
]) {
  const p = probe(env);
  const root = p.definitions[ROOT_SB];
  const research = p.definitions[RESEARCH_SB];
  check(`${label}: the root sandbox names NO backend (eve chooses, as before) and defines only bootstrap`, !p.error && root?.backend === null && root.keys.join() === "bootstrap", p.error ?? root);
  check(`${label}: the research sandbox names NO backend and defines only bootstrap`, !p.error && research?.backend === null && research.keys.join() === "bootstrap", p.error ?? research);
  check(
    `${label}: the formatter is written to /root/fmt_xlsx.py with the command it always was`,
    research?.commands.length === 2 && research.commands[1].startsWith(TODAY_WRITE) && research.commands[1].endsWith("FMTEOF"),
    research?.commands?.[1]?.slice(0, 80),
  );
  check(`${label}: no bootstrap asks for sandbox options (no network policy is passed)`, [...(root?.commands ?? []), ...(research?.commands ?? [])].every((c) => typeof c === "string"));
  check(`${label}: the research prompt names /root/fmt_xlsx.py, and no placeholder is left`, p.prompt?.formatterLines.length === 1 && p.prompt.formatterLines[0].includes(TODAY_PROMPT) && !p.prompt.formatterLines[0].includes("{"), p.prompt);
  check(`${label}: the bootstrap commands and the prompt are byte-identical to the unset ones`, JSON.stringify([root?.commands, research?.commands, p.prompt]) === JSON.stringify([base.definitions[ROOT_SB]?.commands, base.definitions[RESEARCH_SB]?.commands, base.prompt]));
}

/* ---- microsandbox ------------------------------------------------------------------------------------------------ */

console.log("\nSANDBOX_BACKEND=microsandbox — a deployment that is not on Vercel:");
const DENY = ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"];
const micro = probe({ SANDBOX_BACKEND: "microsandbox" });
check("the definitions load", !micro.error, micro.error);
check("the root sandbox pins eve's microsandbox backend", micro.definitions[ROOT_SB]?.backend === "microsandbox", micro.definitions[ROOT_SB]);
check("the research sandbox pins it too", micro.definitions[RESEARCH_SB]?.backend === "microsandbox", micro.definitions[RESEARCH_SB]);
check("2 vCPUs and 1024 MiB by default", micro.settings?.microsandbox?.cpus === 2 && micro.settings.microsandbox.memoryMiB === 1024, micro.settings);
check(
  "the network policy is eve's own option: allow everything, deny cloud metadata, the private ranges (Docker's bridge is in 172.16/12) and loopback",
  JSON.stringify(micro.settings?.microsandbox?.networkPolicy) === JSON.stringify({ allow: ["*"], subnets: { deny: DENY } }),
  micro.settings?.microsandbox?.networkPolicy,
);
check("the runtime is never downloaded by a production process (autoInstall off)", micro.settings?.microsandbox?.setup?.autoInstall === false);
const microWrite = micro.definitions[RESEARCH_SB]?.commands?.[1] ?? "";
check("the formatter is written to the sandbox user's HOME, not /root", microWrite.startsWith(`cat > "$HOME/fmt_xlsx.py" <<'FMTEOF'\n`) && !microWrite.includes("/root/"), microWrite.slice(0, 80));
check("…and it is the same file: only the target differs from the Vercel command", microWrite.replace('"$HOME/fmt_xlsx.py"', "/root/fmt_xlsx.py") === base.definitions[RESEARCH_SB]?.commands?.[1]);
check("the library install commands are the same under both backends", micro.definitions[ROOT_SB]?.commands?.[0] === base.definitions[ROOT_SB]?.commands?.[0] && micro.definitions[RESEARCH_SB]?.commands?.[0] === base.definitions[RESEARCH_SB]?.commands?.[0]);
check(
  "the research prompt names the same place the file was written, and nothing under /root",
  micro.prompt?.formatterLines.length === 1 && micro.prompt.formatterLines[0].includes('`python3 "$HOME/fmt_xlsx.py" <file.xlsx> [...]`') && !micro.prompt.formatterLines[0].includes("/root"),
  micro.prompt,
);
check("…and is otherwise the prompt the Vercel build has (same text around the path)", micro.prompt?.formatterLines[0].replace('"$HOME/fmt_xlsx.py"', "/root/fmt_xlsx.py") === base.prompt?.formatterLines[0] && micro.prompt.length - base.prompt.length === '"$HOME/fmt_xlsx.py"'.length - "/root/fmt_xlsx.py".length);

const tuned = probe({ SANDBOX_BACKEND: "MicroSandbox", SANDBOX_CPUS: "4", SANDBOX_MEMORY_MIB: "2048", SANDBOX_DENY_SUBNETS: "203.0.113.7, 198.51.100.0/24 10.0.0.0/8" });
check("SANDBOX_CPUS and SANDBOX_MEMORY_MIB are honoured", tuned.settings?.microsandbox?.cpus === 4 && tuned.settings.microsandbox.memoryMiB === 2048, tuned.settings);
check(
  "SANDBOX_DENY_SUBNETS ADDS to the list (an address becomes a /32; a built-in range is not repeated or removed)",
  JSON.stringify(tuned.settings?.microsandbox?.networkPolicy?.subnets?.deny) === JSON.stringify([...DENY, "203.0.113.7/32", "198.51.100.0/24"]),
  tuned.settings?.microsandbox?.networkPolicy,
);
const emptyNumbers = probe({ SANDBOX_BACKEND: "microsandbox", SANDBOX_CPUS: "", SANDBOX_MEMORY_MIB: " " });
check("an EMPTY SANDBOX_CPUS / SANDBOX_MEMORY_MIB is the default, not zero", emptyNumbers.settings?.microsandbox?.cpus === 2 && emptyNumbers.settings.microsandbox.memoryMiB === 1024, emptyNumbers.settings);

console.log("\nA value that is set and wrong stops the build with a plain message (it never falls back to another backend):");
for (const [label, env, says] of [
  ["an unknown backend", { SANDBOX_BACKEND: "docker" }, /SANDBOX_BACKEND="docker" is not supported\. Use "vercel" \(the default\) or "microsandbox"/],
  ["a misspelt backend", { SANDBOX_BACKEND: "microsanbox" }, /is not supported/],
  ["zero CPUs", { SANDBOX_BACKEND: "microsandbox", SANDBOX_CPUS: "0" }, /SANDBOX_CPUS="0" is not valid/],
  ["a fractional CPU count", { SANDBOX_BACKEND: "microsandbox", SANDBOX_CPUS: "1.5" }, /SANDBOX_CPUS="1\.5" is not valid/],
  ["memory with a unit", { SANDBOX_BACKEND: "microsandbox", SANDBOX_MEMORY_MIB: "1G" }, /SANDBOX_MEMORY_MIB="1G" is not valid/],
  ["too little memory", { SANDBOX_BACKEND: "microsandbox", SANDBOX_MEMORY_MIB: "64" }, /SANDBOX_MEMORY_MIB="64" is not valid/],
  ["a deny entry that is not a CIDR", { SANDBOX_BACKEND: "microsandbox", SANDBOX_DENY_SUBNETS: "metadata.internal" }, /SANDBOX_DENY_SUBNETS: "metadata\.internal" is not an address or a CIDR block/],
  ["a deny entry with an impossible prefix", { SANDBOX_BACKEND: "microsandbox", SANDBOX_DENY_SUBNETS: "10.0.0.0/40" }, /is not an address or a CIDR block/],
  [
    "filesystem storage whose links point at a private address the sandbox may not reach",
    { SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "filesystem", STORAGE_PUBLIC_URL: "http://10.0.0.5:3000" },
    /file links point at http:\/\/10\.0\.0\.5:3000 \(STORAGE_PUBLIC_URL, STORAGE_DRIVER=filesystem\), which is inside the sandbox deny list \(10\.0\.0\.0\/8\)/,
  ],
  [
    "…or at the host's public address once it is denied",
    { SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "fs", WEB_ORIGIN: "https://203.0.113.7", SANDBOX_DENY_SUBNETS: "203.0.113.7" },
    /\(WEB_ORIGIN, STORAGE_DRIVER=filesystem\), which is inside the sandbox deny list \(203\.0\.113\.7\/32\)/,
  ],
]) {
  const p = probe(env);
  check(`${label}: ${says.source.slice(0, 60).replaceAll("\\", "")}…`, typeof p.error === "string" && says.test(p.error), p.error ?? p.definitions);
}

console.log("\nThe data room's file links under the filesystem storage driver (the sandbox must reach the web app):");
{
  const publicOrigin = probe({ SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "filesystem", STORAGE_PUBLIC_URL: "https://203.0.113.7" });
  check("a public storage origin is reachable: the definitions load with the deny list unchanged", !publicOrigin.error && JSON.stringify(publicOrigin.settings?.microsandbox?.networkPolicy) === JSON.stringify({ allow: ["*"], subnets: { deny: DENY } }), publicOrigin.error ?? publicOrigin.settings);
  const named = probe({ SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "filesystem", STORAGE_PUBLIC_URL: "https://app.example.com" });
  check("a storage origin given by NAME is not resolved at build (sandbox:prewarm resolves it on the server)", !named.error, named.error);
  const vercel = probe({ STORAGE_DRIVER: "filesystem", STORAGE_PUBLIC_URL: "http://10.0.0.5:3000" });
  check("under the vercel backend the storage origin is not checked here (no deny list is in play)", !vercel.error && vercel.definitions[ROOT_SB]?.backend === null, vercel.error);
  const blob = probe({ SANDBOX_BACKEND: "microsandbox", WEB_ORIGIN: "http://10.0.0.5:3000" });
  check("with the default storage driver (Vercel Blob) WEB_ORIGIN is not a file-link origin and is not checked", !blob.error, blob.error);
}

/* ---- what eve itself makes of that policy ------------------------------------------------------------------------ */

console.log("\nThe deny list through eve's own networkPolicy translation (what the microsandbox firewall is handed):");
const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const eveVersion = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version;
const eve = (path) => import(pathToFileURL(join(eveRoot, "dist/src", path)).href);
const settings = micro.settings?.microsandbox;
try {
  const net = await eve("execution/sandbox/bindings/microsandbox-network.js");
  const options = await eve("execution/sandbox/bindings/microsandbox-options.js");
  const plan = net.createMicrosandboxNetworkPlan(settings.networkPolicy);
  check("eve keeps the network ON (this is not deny-all: pip and the internet still work)", plan.disabled === false && plan.policy.defaultEgress === "allow" && plan.policy.defaultIngress === "deny", plan);
  check(
    "one egress DENY rule per subnet, every port and protocol, and no other rule",
    JSON.stringify(plan.policy.rules) === JSON.stringify(DENY.map((cidr) => ({ action: "deny", destination: { cidr, kind: "cidr" }, direction: "egress", ports: [], protocols: [] }))),
    plan.policy.rules,
  );
  // The call eve makes on the microsandbox builder, captured.
  const handed = [];
  const network = { enabled: (on) => (handed.push({ enabled: on }), network), policyJson: (json) => (handed.push({ policy: JSON.parse(json) }), network) };
  net.applyMicrosandboxNetwork({ network: (configure) => configure(network), disableNetwork: () => handed.push({ disabled: true }) }, settings.networkPolicy);
  const json = handed.find((h) => h.policy)?.policy;
  check(
    "the policy JSON eve gives the microsandbox firewall: default_egress allow, a deny rule for each range",
    handed.some((h) => h.enabled === true) && !handed.some((h) => h.disabled) && json?.default_egress === "allow" && json.default_ingress === "deny" &&
      JSON.stringify(json.rules) === JSON.stringify(DENY.map((cidr) => ({ action: "deny", destination: { cidr }, direction: "egress", ports: [], protocols: [] }))),
    handed,
  );
  // eve's default, for contrast: the policy this setting replaces has no rule at all.
  const open = net.createMicrosandboxNetworkPlan(undefined);
  check("…where eve's default (\"allow-all\") has NO rule: metadata and the private ranges are reachable", open.policy.defaultEgress === "allow" && open.policy.rules.length === 0);
  const resolved = options.resolveMicrosandboxOptions(settings);
  check("eve's own option resolver takes the CPUs, memory, policy and no-download setting as given", resolved.cpus === 2 && resolved.memoryMiB === 1024 && resolved.setup.autoInstall === false && JSON.stringify(resolved.networkPolicy) === JSON.stringify(settings.networkPolicy), resolved);
  check("…where its defaults are 1 vCPU and automatic install", options.resolveMicrosandboxOptions(undefined).cpus === 1 && options.resolveMicrosandboxOptions(undefined).setup.autoInstall === true);
} catch (error) {
  check(`eve ${eveVersion}'s microsandbox network modules load (written against 0.25.1)`, false, String(error?.message ?? error));
}

/* ---- on a Vercel bundle the local backends are stubs --------------------------------------------------------------- */

console.log("\nOn Vercel, eve's hosted bundle replaces the local backends with stubs:");
try {
  const { createCompiledSandboxBackendPrunePlugin } = await eve("internal/nitro/host/compiled-sandbox-backend-prune-plugin.js");
  const plugin = createCompiledSandboxBackendPrunePlugin();
  const id = plugin.resolveId("/x/node_modules/eve/dist/src/execution/sandbox/bindings/local.js");
  const stub = plugin.load(id);
  check("the module both `eve/sandbox/microsandbox` and eve's own default backend import is the one replaced", plugin.name === "eve-hosted-sandbox-backend-prune" && typeof stub === "string" && /createMicrosandboxSandboxBackend = pruned/.test(stub));
  const factory = readFileSync(join(eveRoot, "dist/src/public/sandbox/backends/microsandbox.js"), "utf8");
  check("…and `microsandbox()` reaches the microsandbox package only through that module", /from"#execution\/sandbox\/bindings\/local\.js"/.test(factory) && !/from"microsandbox"/.test(factory));
  check("so importing it in the sandbox definitions adds nothing to a Vercel bundle, and it is not called there (unset)", base.definitions[ROOT_SB]?.backend === null && base.definitions[RESEARCH_SB]?.backend === null);
} catch (error) {
  check(`eve ${eveVersion}'s prune plugin loads (written against 0.25.1)`, false, String(error?.message ?? error));
}

/* ---- the formatter really lands in a non-root user's home ---------------------------------------------------------- */

console.log("\nThe microsandbox formatter command, run by bash with a throwaway HOME:");
const home = mkdtempSync(join(tmpdir(), "sandbox-backend-home-"));
try {
  const run = spawnSync("bash", ["-c", microWrite], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  const file = join(home, "fmt_xlsx.py");
  check("it exits 0 and writes $HOME/fmt_xlsx.py", run.status === 0 && existsSync(file) && statSync(file).size > 200, { status: run.status, stderr: run.stderr });
  const source = existsSync(file) ? readFileSync(file, "utf8") : "";
  check("the file is the formatter (it loads a workbook and freezes the header)", /from openpyxl import load_workbook/.test(source) && /freeze_panes = "A2"/.test(source) && source.trimEnd().endsWith('print("formatted", p)'));
  const py = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
  if (py.error) console.log("  skip python3 is not on PATH here, so the file was not compiled");
  else check("python3 compiles it", py.status === 0, py.stderr);
  // The path the PROMPT gives the model, as bash expands it, is that file.
  const shown = spawnSync("bash", ["-c", 'printf %s "$HOME/fmt_xlsx.py"'], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  check("the path the prompt gives expands to that same file", shown.stdout === file, shown.stdout);
  if (userInfo().uid !== 0) {
    const today = spawnSync("bash", ["-c", "cat > /root/fmt_xlsx.py </dev/null"], { encoding: "utf8" });
    check("(this user is not root) today's /root target is NOT writable — the failure the home path fixes", today.status !== 0);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures.length ? `\ntest-sandbox-backend: ${failures.length} FAILED (${passed} passed)` : `\ntest-sandbox-backend: ${passed} checks passed`);
assert.equal(failures.length, 0, `${failures.length} sandbox-backend assertion(s) failed`);
