/**
 * The per-deployment agent package build (scripts/build-agent-cli.mjs, docs/AGENT_CLI.md).
 *
 * Builds real packages into temp directories - under the default profile and under a probe
 * profile (docs/examples/profile-equity-research.json, read through PROFILES_DIR so no
 * generated file is touched) - and checks what a publisher relies on: the package.json, the
 * bins, which address wins, sign-in by emailed code (against a local stub of the two routes),
 * dm.md, which skills ship, the safety gate, and that npm packs exactly what the gate checked. The only thing written inside the repo is a temporary
 * agent-kit/ directory, removed in `finally`.
 *
 *   npm run test:agent-cli
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDeployment, isSemver, npmNameProblems, parseOrigin, parseSkillFrontmatter, renderDeploymentModule, renderDmMd, safetyGate } from "./lib/agent-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "scripts/build-agent-cli.mjs");
const NAME = "@probe-scope/research-kit";
const ORIGIN = "https://research.probe-deployment.dev";
const OTHER = "https://other.probe-deployment.dev";
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

let passed = 0;
async function check(what, fn) {
  try { await fn(); passed++; console.log(`  ok  ${what}`); } catch (e) { console.error(`FAIL  ${what}\n${e.stack ?? e}`); process.exitCode = 1; throw e; }
}

const TMP = mkdtempSync(join(tmpdir(), "agent-cli-test-"));
const HOME = join(TMP, "home"); mkdirSync(HOME);
const KIT = join(ROOT, "agent-kit");
// The test owns agent-kit/ for its duration; it must not exist, so restoring is deleting.
if (existsSync(KIT)) { console.error("test-agent-cli-build: agent-kit/ already exists here (a pack is applied). Run this test on a base checkout."); process.exit(1); }
const gitStatus = () => spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout;
const statusBefore = gitStatus();

function build(out, { env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [...NODE_FLAGS, BUILD, "--name", NAME, "--version", "1.2.3", "--origin", ORIGIN, "--out", out, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: "", ...env },
  });
}
function run(file, args = [], env = {}) {
  // FDE_* cleared: a developer's own shell must not decide which address this resolves to.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FDE_|WEB_ORIGIN$|BLOB_READ_WRITE_TOKEN$)/.test(k)));
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", input: "", env: { ...clean, HOME, USERPROFILE: HOME, ...env } });
}
/** `run`, without blocking this process: the stub server below answers from this event loop. */
function runAsync(file, args = [], { env = {}, input = "" } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FDE_|WEB_ORIGIN$|BLOB_READ_WRITE_TOKEN$)/.test(k)));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...clean, HOME, USERPROFILE: HOME, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b) => (stdout += b)); child.stderr.on("data", (b) => (stderr += b));
    child.on("error", fail); child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const writeSkill = (dir, name, body = "") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "Demo: set up a research desk. Use when asked to set up coverage."\n---\n\n# Demo setup\n\nCall \`fde_status\` first.\n${body}`);
};

try {
  console.log("inputs");
  await check("npm names: scopes, case, reserved and core names", () => {
    assert.deepEqual(npmNameProblems("@onfinance/hfc-research"), []);
    assert.deepEqual(npmNameProblems("plain-name"), []);
    for (const bad of ["", "Upper", "@scope", "@scope/", "a/b", "@s/a/b", ".dot", "_under", "has space", "@sc ope/x", "http", "node_modules", "x".repeat(215)]) assert.ok(npmNameProblems(bad).length, `"${bad}" should be refused`);
  });
  await check("semver and origin validation", () => {
    assert.ok(isSemver("1.0.0") && isSemver("0.1.0-rc.1+build.5") && !isSemver("1.0") && !isSemver("v1.0.0") && !isSemver("01.0.0"));
    assert.equal(parseOrigin("https://a.example.com/").origin, "https://a.example.com");
    for (const bad of ["http://a.example.com", "https://a.example.com/path", "https://a.example.com/?q=1", "https://u:p@a.example.com", "a.example.com", "https://localhost", ""]) assert.ok(parseOrigin(bad).problem, `"${bad}" should be refused`);
  });
  await check("the build refuses bad inputs with a plain message and writes nothing", () => {
    const out = join(TMP, "bad");
    const r = spawnSync(process.execPath, [...NODE_FLAGS, BUILD, "--name", "Bad Name", "--version", "one", "--origin", "http://x.dev/path", "--out", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--name:/); assert.match(r.stderr, /--version:/); assert.match(r.stderr, /--origin:/);
    assert.ok(!existsSync(out));
  });

  console.log("default profile");
  const D = join(TMP, "default");
  const d = build(D);
  await check("builds clean", () => assert.equal(d.status, 0, d.stderr + d.stdout));
  const pkg = JSON.parse(readFileSync(join(D, "package.json"), "utf8"));
  const baseProfile = JSON.parse(readFileSync(join(ROOT, "profiles/00-default.json"), "utf8"));
  await check("package.json fields", () => {
    assert.equal(pkg.name, NAME); assert.equal(pkg.version, "1.2.3"); assert.equal(pkg.type, "module");
    assert.equal(pkg.license, "UNLICENSED"); assert.deepEqual(pkg.publishConfig, { access: "public" });
    assert.ok(pkg.description.includes(baseProfile.product.tagline));
    assert.ok(pkg.engines.node);
    assert.ok(!("repository" in pkg) && !("homepage" in pkg) && !("scripts" in pkg) && !("dependencies" in pkg));
    // Every bin carries the package's name: a bare `login` would shadow the system's on a global install.
    assert.deepEqual(pkg.bin, { "research-kit": "./fde-cli.mjs", "research-kit-login": "./fde-login.mjs", "research-kit-mcp": "./fde-mcp.mjs", "research-kit-install-skills": "./fde-install-skill.mjs" });
    assert.deepEqual(pkg.files.slice().sort(), ["README.md", "deployment.generated.mjs", "dm.md", "fde-cli.mjs", "fde-install-skill.mjs", "fde-login.mjs", "fde-mcp.mjs", "fde-tools.mjs", "skills"]);
  });
  await check("--access restricted and --repository/--homepage are written when given", () => {
    const out = join(TMP, "restricted");
    const r = build(out, { args: ["--access", "restricted", "--repository", "https://git.probe-deployment.dev/kit.git", "--homepage", ORIGIN, "--allow-host", "git.probe-deployment.dev"] });
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    assert.equal(p.publishConfig.access, "restricted"); assert.equal(p.repository.url, "https://git.probe-deployment.dev/kit.git"); assert.equal(p.homepage, ORIGIN);
  });
  await check("every bin exists, and --help exits 0 naming the product and the address", () => {
    for (const [bin, file] of Object.entries(pkg.bin)) {
      assert.ok(existsSync(join(D, file)), `${bin} -> ${file}`);
      const r = run(join(D, file), ["--help"]);
      assert.equal(r.status, 0, `${bin} --help: ${r.stderr}`);
      assert.ok(r.stderr.includes(baseProfile.product.name), `${bin} --help names the product`);
      assert.ok(r.stderr.includes(ORIGIN), `${bin} --help names the address`);
    }
  });
  await check("`npx <package>` with no command prints help and succeeds; the hosted one-liner is lib/mcp-connect.ts's", async () => {
    const r = run(join(D, "fde-cli.mjs"));
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes(`claude mcp add --transport http delivered ${ORIGIN}/api/mcp --header "Authorization: Bearer <token>"`));
    assert.ok(r.stderr.includes(`npx ${NAME} login`));
    assert.ok(r.stderr.includes(`npx ${NAME} login --email <address>`) && !/Google Workspace accounts\)/.test(r.stderr), "help shows both ways to sign in");
    assert.ok(!r.stderr.includes("@delivery-agents/cli"));
  });
  await check("login, mcp, install-skills and their older names all go through the dispatcher", () => {
    for (const cmd of ["login", "mcp", "install-skills", "fde-login", "fde-mcp", "fde-install-skill"]) {
      const r = run(join(D, "fde-cli.mjs"), [cmd, "--help"]);
      assert.equal(r.status, 0, `${cmd}: ${r.stderr}`); assert.ok(r.stderr.includes(ORIGIN), cmd);
    }
    assert.match(run(join(D, "fde-login.mjs"), ["--help"]).stderr, /--email <address>/);
  });
  const { mcpConnect } = await import(join(ROOT, "lib/mcp-connect.ts"));
  await check("the baked connect strings equal mcpConnect()'s", async () => {
    const c = mcpConnect({ origin: ORIGIN, productName: baseProfile.product.name, agentPackage: NAME });
    const text = readFileSync(join(D, "deployment.generated.mjs"), "utf8");
    const baked = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("};") + 1));
    assert.equal(baked.connect.claudeCommand, c.claudeCommand); assert.equal(baked.mcpEndpoint, c.endpoint); assert.equal(baked.slug, c.slug);
    assert.equal(baked.origin, ORIGIN); assert.equal(baked.packageName, NAME); assert.equal(baked.name, baseProfile.product.name);
    assert.deepEqual(baked.vocabulary.account, baseProfile.vocabulary.account);
    assert.ok(c.packageAlternative.login === `npx ${NAME} login` && !c.packageAlternative.claudeCommand.includes("FDE_OPS_URL"));
    assert.ok(mcpConnect({ origin: ORIGIN, productName: "X" }).packageAlternative.claudeCommand.includes(`FDE_OPS_URL=${ORIGIN}`), "without a package of its own the alternative still spells the address out");
  });
  const ready = (r) => /Ops API: (\S*) \(([^)]*)\)/.exec(r.stderr);
  await check("address: the baked-in origin with no env", () => {
    const m = ready(run(join(D, "fde-mcp.mjs")));
    assert.equal(m[1], ORIGIN); assert.equal(m[2], "built into this package");
  });
  await check("address: FDE_OPS_URL overrides the baked-in origin", () => {
    const m = ready(run(join(D, "fde-mcp.mjs"), [], { FDE_OPS_URL: `${OTHER}/` }));
    assert.equal(m[1], OTHER); assert.equal(m[2], "FDE_OPS_URL");
  });
  await check("address: a saved login outranks the baked-in origin, and FDE_OPS_URL outranks both", () => {
    const dir = join(HOME, ".config/fde-mcp", new URL(ORIGIN).host);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ ops_url: "https://saved.probe-deployment.dev" }));
    try {
      assert.equal(ready(run(join(D, "fde-mcp.mjs")))[1], "https://saved.probe-deployment.dev");
      assert.equal(ready(run(join(D, "fde-mcp.mjs"), [], { FDE_OPS_URL: OTHER }))[1], OTHER);
    } finally { rmSync(join(HOME, ".config"), { recursive: true, force: true }); }
  });
  await check("the MCP server answers initialize as this product", () => {
    const r = spawnSync(process.execPath, [join(D, "fde-cli.mjs"), "mcp"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME }, input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n` });
    const res = JSON.parse(r.stdout.trim().split("\n")[0]);
    assert.ok(res.result.instructions.startsWith(`${baseProfile.product.name} control plane`));
    assert.ok(res.result.instructions.includes(ORIGIN));
  });
  console.log("sign-in by emailed code");
  // Assembled at run time, shaped like the app's session token (three base64url parts).
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const SESSION = [b64({ alg: "ES256" }), b64({ email: "person@probe-deployment.dev", kind: "email-session" }), "c2lnbmF0dXJl"].join(".");
  const REFUSED = "That code is wrong or has expired. Request a new one.";
  const calls = [];
  // Plays POST /api/auth/email/request and /verify as the app does, and records what the Ops API is sent.
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null;
      calls.push({ path: req.url, body: json, authorization: req.headers.authorization ?? null });
      const reply = (status, out) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(out)); };
      if (req.url === "/api/auth/email/request") {
        if (json.email.startsWith("unconfigured@")) return reply(503, { error: "Email sign-in is not configured on this deployment." });
        if (json.email.startsWith("eager@")) return reply(429, { error: "Too many codes requested for that address. Try again in an hour." });
        return reply(200, { ok: true, message: "If that address has an invite or an existing workspace, a sign-in code is on its way." });
      }
      if (req.url === "/api/auth/email/verify") return json.code === "123456" ? reply(200, { token: SESSION, email: json.email, expiresIn: 604800 }) : reply(401, { error: REFUSED });
      if (req.url === "/api/ops/orgs") return reply(200, { items: [] });
      reply(404, { error: "not found" });
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const STUB = `http://127.0.0.1:${stub.address().port}`;
  const CRED = join(HOME, ".config/fde-mcp", new URL(ORIGIN).host, "credentials.json");
  const LOGIN = join(D, "fde-login.mjs");
  try {
    await check("happy path: asks for a code, reads it from stdin, stores an email session (mode 600), never prints the token", async () => {
      const r = await runAsync(LOGIN, ["--email", "Person@Probe-Deployment.dev", "--url", STUB], { input: "123 456\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(calls.map((c) => [c.path, c.body]), [["/api/auth/email/request", { email: "person@probe-deployment.dev" }], ["/api/auth/email/verify", { email: "person@probe-deployment.dev", code: "123456" }]]);
      const stored = JSON.parse(readFileSync(CRED, "utf8"));
      assert.deepEqual(Object.keys(stored).sort(), ["email", "expires_at", "kind", "ops_url", "session_token"]);
      assert.equal(stored.kind, "email-session"); assert.equal(stored.session_token, SESSION); assert.equal(stored.email, "person@probe-deployment.dev"); assert.equal(stored.ops_url, STUB);
      assert.ok(Math.abs(stored.expires_at - (Date.now() / 1000 + 604800)) < 120, "expires_at is now + expiresIn, in seconds");
      assert.equal(statSync(CRED).mode & 0o777, 0o600);
      assert.ok(!(r.stdout + r.stderr).includes(SESSION) && !(r.stdout + r.stderr).includes(SESSION.split(".")[2]), "the token is never printed");
      assert.match(r.stderr, /a sign-in code is on its way/); assert.match(r.stderr, /Signed in as person@probe-deployment\.dev until \d{4}-\d\d-\d\d/);
    });
    await check("--code verifies the code in hand without requesting a new one, through the dispatcher, and tightens a loose file", async () => {
      calls.length = 0; chmodSync(CRED, 0o644);
      const r = await runAsync(join(D, "fde-cli.mjs"), ["login", "--email", "person@probe-deployment.dev", "--code", "123456", "--url", STUB]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(calls.map((c) => c.path), ["/api/auth/email/verify"]);
      assert.equal(statSync(CRED).mode & 0o777, 0o600); assert.ok(!(r.stdout + r.stderr).includes(SESSION));
    });
    await check("a wrong code shows the server's sentence, exits non-zero and stores nothing", async () => {
      rmSync(CRED);
      const r = await runAsync(LOGIN, ["--email", "person@probe-deployment.dev", "--url", STUB], { input: "000000\n" });
      assert.equal(r.status, 1); assert.ok(r.stderr.includes(REFUSED), r.stderr); assert.ok(!existsSync(CRED));
      assert.ok(!/at .*fde-login\.mjs|Error:/.test(r.stderr), "a sentence, not a stack trace");
    });
    await check("429 and 503 are shown as the server's sentences; something that is not a code is refused before any verify", async () => {
      const busy = await runAsync(LOGIN, ["--email", "eager@probe-deployment.dev", "--url", STUB], { input: "123456\n" });
      assert.equal(busy.status, 1); assert.match(busy.stderr, /Too many codes requested for that address\. Try again in an hour\./);
      const off = await runAsync(LOGIN, ["--email", "unconfigured@probe-deployment.dev", "--url", STUB], { input: "123456\n" });
      assert.equal(off.status, 1); assert.match(off.stderr, /Email sign-in is not configured on this deployment\./);
      calls.length = 0;
      const none = await runAsync(LOGIN, ["--email", "person@probe-deployment.dev", "--url", STUB], { input: "" });
      assert.equal(none.status, 1); assert.match(none.stderr, /not a six-digit code.*--code <digits>/); assert.deepEqual(calls.map((c) => c.path), ["/api/auth/email/request"]);
      const bad = await runAsync(LOGIN, ["--email", "not-an-address", "--url", STUB]);
      assert.equal(bad.status, 1); assert.match(bad.stderr, /--email needs an email address/);
      const down = await runAsync(LOGIN, ["--email", "person@probe-deployment.dev", "--url", "http://127.0.0.1:9"], { input: "123456\n" });
      assert.equal(down.status, 1); assert.match(down.stderr, /Could not reach http:\/\/127\.0\.0\.1:9\./);
    });
    const { emailSessionBearer, parseCode } = await import(LOGIN);
    await check("bearer selection: an unexpired email session is the bearer, an expired one is refused, a Google login is left alone", () => {
      const now = Date.now(); const soon = Math.floor(now / 1000);
      const live = emailSessionBearer({ kind: "email-session", session_token: SESSION, email: "a@b.dev", expires_at: soon + 3600 }, { now });
      assert.deepEqual(live, { bearer: SESSION, email: "a@b.dev", expired: false });
      for (const creds of [{ kind: "email-session", session_token: SESSION, email: "a@b.dev", expires_at: soon - 1 }, { kind: "email-session", session_token: SESSION, email: "a@b.dev", expires_at: soon + 30 }, { kind: "email-session", email: "a@b.dev", expires_at: soon + 3600 }]) {
        const dead = emailSessionBearer(creds, { now });
        assert.equal(dead.expired, true); assert.equal(dead.bearer, null);
        assert.equal(dead.message, `Your email sign-in has expired. Run \`npx ${NAME} login --email a@b.dev\` in a terminal to sign in again.`);
      }
      assert.equal(emailSessionBearer({ refresh_token: "r", id_token: "i", email: "a@b.dev" }, { now }), null);
      assert.equal(emailSessionBearer(null), null);
      assert.equal(parseCode(" 123-456\n"), "123456"); assert.equal(parseCode("12345"), null); assert.equal(parseCode("1234567"), null);
    });
    const statusCall = [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fde_status", arguments: {} } }].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const writeCreds = (expiresAt) => { mkdirSync(dirname(CRED), { recursive: true }); writeFileSync(CRED, JSON.stringify({ kind: "email-session", session_token: SESSION, email: "person@probe-deployment.dev", expires_at: expiresAt, ops_url: STUB }), { mode: 0o600 }); };
    await check("the MCP server sends an unexpired email session as its bearer", async () => {
      calls.length = 0; writeCreds(Math.floor(Date.now() / 1000) + 3600);
      const r = await runAsync(join(D, "fde-mcp.mjs"), [], { input: statusCall });
      const text = JSON.parse(r.stdout.trim().split("\n")[0]).result.content[0].text;
      assert.equal(JSON.parse(text).identity.email, "person@probe-deployment.dev");
      assert.ok(calls.length && calls.every((c) => c.authorization === `Bearer ${SESSION}`), JSON.stringify(calls.map((c) => c.path)));
      assert.ok(!r.stderr.includes(SESSION));
    });
    await check("and refuses an expired one with one sentence, sending nothing", async () => {
      calls.length = 0; writeCreds(Math.floor(Date.now() / 1000) - 10);
      const r = await runAsync(join(D, "fde-mcp.mjs"), [], { input: statusCall });
      assert.match(r.stdout, /Your email sign-in has expired\. Run `npx @probe-scope\/research-kit login --email person@probe-deployment\.dev`/);
      assert.deepEqual(calls, []); assert.ok(!r.stdout.includes(SESSION));
    });
  } finally {
    stub.close(); stub.closeAllConnections?.();
    rmSync(join(HOME, ".config"), { recursive: true, force: true });
  }

  await check("dm.md equals setup/dm.md (and the repo's) byte for byte", () => {
    assert.ok(readFileSync(join(D, "dm.md")).equals(readFileSync(join(ROOT, "setup/dm.md"))));
    assert.ok(readFileSync(join(D, "dm.md")).equals(readFileSync(join(ROOT, "dm.md"))));
  });
  await check("the base skill ships, renamed to this package", () => {
    assert.deepEqual(readdirSync(join(D, "skills")), readdirSync(join(ROOT, "skills")));
    const text = readFileSync(join(D, "skills/delivered-setup/SKILL.md"), "utf8");
    assert.ok(!text.includes("@delivery-agents/cli") && text.includes(`npx ${NAME} fde-login`));
  });
  await check("the README leads with the hosted one-liner, then login / mcp / install-skills", () => {
    const t = readFileSync(join(D, "README.md"), "utf8");
    const at = (s) => { const i = t.indexOf(s); assert.ok(i > -1, s); return i; };
    assert.ok(at("claude mcp add --transport http") < at(`npx ${NAME} login`));
    at(`npx ${NAME} mcp`); at(`npx ${NAME} install-skills`); at("## Security"); at(baseProfile.product.name);
  });
  const packList = (dir) => JSON.parse(spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }).stdout)[0].files.map((f) => f.path).sort();
  await check("npm pack --dry-run lists exactly the manifest's files, with matching sizes and digests", async () => {
    const manifest = JSON.parse(readFileSync(join(D, "manifest.json"), "utf8"));
    assert.deepEqual(packList(D), manifest.files.map((f) => f.path).sort());
    const { createHash } = await import("node:crypto");
    for (const f of manifest.files) {
      const bytes = readFileSync(join(D, f.path));
      assert.equal(bytes.length, f.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), f.sha256);
    }
    assert.equal(manifest.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
    assert.ok(!manifest.files.some((f) => f.path === "manifest.json"));
  });
  await check("the build is deterministic", () => {
    const again = join(TMP, "default-again");
    assert.equal(build(again).status, 0);
    assert.equal(readFileSync(join(again, "manifest.json"), "utf8"), readFileSync(join(D, "manifest.json"), "utf8"));
  });
  await check("a rebuild replaces a previous build, but a foreign non-empty --out is refused", () => {
    assert.equal(build(D).status, 0);
    const foreign = join(TMP, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "keep.txt"), "mine");
    const r = build(foreign);
    assert.equal(r.status, 1); assert.ok(existsSync(join(foreign, "keep.txt")));
  });

  console.log("the generic package in setup/");
  await check("setup/deployment.generated.mjs is what --write-default writes: no address, the base wording", async () => {
    const { productSlug } = await import(join(ROOT, "lib/mcp-connect.ts"));
    const base = JSON.parse(JSON.stringify(baseProfile, (k, v) => (k === "$comment" ? undefined : v)));
    const expected = renderDeploymentModule(defaultDeployment({ packageName: "@delivery-agents/cli", profile: base, slug: productSlug(base.product.name) }));
    assert.equal(readFileSync(join(ROOT, "setup/deployment.generated.mjs"), "utf8"), expected);
  });
  await check("its pack list is what it was, plus the generated module", () => {
    assert.deepEqual(packList(join(ROOT, "setup")), ["README.md", "deployment.generated.mjs", "dm.md", "fde-cli.mjs", "fde-install-skill.mjs", "fde-login.mjs", "fde-mcp.mjs", "fde-tools.mjs", "package.json", "skills/delivered-setup/SKILL.md"]);
  });
  await check("it still has no default address and says so", () => {
    const r = run(join(ROOT, "setup/fde-mcp.mjs"));
    assert.match(r.stderr, /FDE_OPS_URL is not set/);
    const help = run(join(ROOT, "setup/fde-cli.mjs"), ["--help"]);
    assert.equal(help.status, 0); assert.match(help.stderr, /NO default address/); assert.match(help.stderr, /npx @delivery-agents\/cli fde-login --url <address>/);
    assert.equal(run(join(ROOT, "setup/fde-cli.mjs")).status, 1, "bare invocation of the generic package is still an error");
    assert.equal(ready(run(join(ROOT, "setup/fde-mcp.mjs"), [], { FDE_OPS_URL: OTHER }))[1], OTHER);
  });
  await check("no product word is left in setup/*.mjs outside the generated module", () => {
    for (const f of ["fde-cli.mjs", "fde-login.mjs", "fde-mcp.mjs", "fde-tools.mjs", "fde-install-skill.mjs"]) {
      const t = readFileSync(join(ROOT, "setup", f), "utf8");
      assert.ok(!/delivery-agents|Delivered|onfinance/i.test(t), `${f} names a product`);
    }
  });

  console.log("probe profile + agent-kit");
  const PROFILES = join(TMP, "profiles"); mkdirSync(PROFILES);
  cpSync(join(ROOT, "profiles/00-default.json"), join(PROFILES, "00-default.json"));
  const probe = JSON.parse(readFileSync(join(ROOT, "docs/examples/profile-equity-research.json"), "utf8"));
  probe.product = { name: "Probe Research", tagline: "Coverage for a research desk." };
  writeFileSync(join(PROFILES, "50-probe.json"), JSON.stringify(probe));
  writeSkill(join(KIT, "skills/demo-setup"), "demo-setup");
  mkdirSync(join(KIT, "skills/demo-setup/references"));
  writeFileSync(join(KIT, "skills/demo-setup/references/coverage.md"), "# Coverage\n\nHow a desk covers a company.\n");
  const P = join(TMP, "probe");
  const p = build(P, { env: { PROFILES_DIR: PROFILES } });
  await check("builds clean under the probe profile", () => assert.equal(p.status, 0, p.stderr + p.stdout));
  await check("product name, tagline and vocabulary come from the profile", () => {
    const pp = JSON.parse(readFileSync(join(P, "package.json"), "utf8"));
    assert.ok(pp.description.startsWith("Probe Research: Coverage for a research desk."));
    assert.ok(pp.keywords.includes("probe-research"));
    const help = run(join(P, "fde-cli.mjs"), ["--help"]).stderr;
    assert.ok(help.includes("Probe Research CLI") && help.includes(`claude mcp add --transport http probe-research ${ORIGIN}/api/mcp`));
    assert.ok(readFileSync(join(P, "deployment.generated.mjs"), "utf8").includes('"plural": "companies"'));
    assert.ok(readFileSync(join(P, "README.md"), "utf8").includes("companies"));
    const all = readdirSync(P).filter((f) => /\.(mjs|md|json)$/.test(f) && f !== "fde-tools.mjs").map((f) => readFileSync(join(P, f), "utf8")).join("\n");
    assert.ok(!all.includes("Delivered"), "the base product's name is nowhere in the probe package");
  });
  const dm = readFileSync(join(P, "dm.md"), "utf8");
  await check("dm.md hides hidden domains", () => {
    for (const gone of ["  |-Platform", "  |-Solutions", "  |-Tickets", "supported.personas.jsonl", "tickets_{id}.jsonl"]) assert.ok(!dm.includes(gone), gone);
    assert.match(dm, /Not used in this deployment, so not listed: Platform, Solutions, Tickets\./);
  });
  await check("dm.md relabels visible domains and keeps the real folder name in brackets", () => {
    assert.ok(dm.includes("  |-Companies [Customers]"));
    assert.match(dm, /^ {2}\|-Coverage reports \[Deployments\]/m);
    assert.match(dm, /^ {2}\|-Portfolios \[Implementation\]/m);
    assert.ok(dm.includes("  |-People\n"), "an unrelabelled domain is unchanged");
    assert.ok(dm.includes("       |-interactions.jsonl") && dm.includes("    |-{CustomerID}"), "the paths under a domain are the real ones");
  });
  await check("dm.md summarises the redefined record areas", () => {
    assert.match(dm, /^Coverage reports \(stored as Deployments\): /m);
    assert.match(dm, /^Portfolios \(stored as Implementation; each row is a Portfolio entry\): /m);
    for (const gone of ["{platform_version_id}", "customizations.tf", "customer.infosec.md"]) assert.ok(!dm.includes(gone), `${gone} is the default tree of a redefined area`);
    assert.match(dm, /\|-Coverage reports \[Deployments\].*\n {4}\(records, not files/);
  });
  await check("subagent path templates are appended under their domain (and an unknown domain is refused)", () => {
    const source = readFileSync(join(ROOT, "dm.md"), "utf8");
    const base = JSON.parse(JSON.stringify(baseProfile, (k, v) => (k === "$comment" ? undefined : v)));
    for (const dom of Object.values(base.dataroom.domains)) dom.visible ??= true;
    const out = renderDmMd({ source, profile: base, defaultDomains: base.domains, extraTemplates: ["Customers/{customer_id}/invoices/**"], productName: "X" });
    const lines = out.split("\n");
    const at = lines.indexOf("    |-{customer_id}/invoices/** (added by a subagent)");
    assert.ok(at > lines.indexOf("  |-Customers") && at < lines.indexOf("  |-Platform"));
    assert.equal(renderDmMd({ source, profile: base, defaultDomains: base.domains, extraTemplates: [], productName: "X" }), source);
    assert.throws(() => renderDmMd({ source, profile: base, defaultDomains: base.domains, extraTemplates: ["Nowhere/x"], productName: "X" }), /not a domain/);
  });
  await check("with agent-kit skills, the base setup skill is left out and the kit's ship with their references", () => {
    assert.deepEqual(readdirSync(join(P, "skills")), ["demo-setup"]);
    assert.ok(existsSync(join(P, "skills/demo-setup/references/coverage.md")));
    assert.match(p.stdout, /base skills left out: delivered-setup/);
    assert.ok(readFileSync(join(P, "README.md"), "utf8").includes("`demo-setup` - Demo: set up a research desk."));
  });
  await check("agent-kit/kit.json include_base_skills brings a base skill back", () => {
    writeFileSync(join(KIT, "kit.json"), JSON.stringify({ include_base_skills: ["delivered-setup"] }));
    const out = join(TMP, "probe-kit");
    const r = build(out, { env: { PROFILES_DIR: PROFILES } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(out, "skills")).sort(), ["delivered-setup", "demo-setup"]);
    writeFileSync(join(KIT, "kit.json"), JSON.stringify({ include_base_skills: ["no-such-skill"] }));
    assert.equal(build(join(TMP, "probe-kit-bad"), { env: { PROFILES_DIR: PROFILES } }).status, 1);
    rmSync(join(KIT, "kit.json"));
  });
  await check("an agent-kit inside a subagent directory is found too", () => {
    const sub = join(ROOT, "agent/subagents/research/agent-kit");
    assert.ok(!existsSync(sub));
    try {
      writeSkill(join(sub, "skills/desk-notes"), "desk-notes");
      const out = join(TMP, "probe-sub");
      assert.equal(build(out).status, 0);
      assert.deepEqual(readdirSync(join(out, "skills")).sort(), ["demo-setup", "desk-notes"]);
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });

  console.log("SKILL.md frontmatter");
  await check("name + description are required; an unquoted description containing \": \" fails", () => {
    assert.deepEqual(parseSkillFrontmatter('---\nname: a-b\ndescription: "Do this: then that"\n---\n', "x"), { name: "a-b", description: "Do this: then that" });
    assert.equal(parseSkillFrontmatter("---\nname: a\ndescription: >\n  folded\n  text\n---\n", "x").description, "folded text");
    assert.throws(() => parseSkillFrontmatter("---\nname: a\ndescription: Do this: then that\n---\n", "x"), /double quotes/);
    assert.throws(() => parseSkillFrontmatter("---\nname: a\n---\n", "x"), /name and description/);
    assert.throws(() => parseSkillFrontmatter("# no frontmatter", "x"), /frontmatter/);
    assert.throws(() => parseSkillFrontmatter("---\nname: Bad Name\ndescription: x\n---\n", "x"), /must match/);
    assert.throws(() => parseSkillFrontmatter('---\nname: a\ndescription: "unclosed\n---\n', "x"), /double-quoted/);
    for (const s of readdirSync(join(ROOT, "skills"))) parseSkillFrontmatter(readFileSync(join(ROOT, "skills", s, "SKILL.md"), "utf8"), s);
  });
  await check("the build fails on a skill whose frontmatter is invalid", () => {
    const bad = join(KIT, "skills/bad-skill");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "---\nname: bad-skill\ndescription: Setup: do the thing\n---\n");
    const out = join(TMP, "bad-skill");
    const r = build(out);
    rmSync(bad, { recursive: true, force: true });
    assert.equal(r.status, 1); assert.match(r.stderr, /agent-kit\/skills\/bad-skill\/SKILL\.md.*double quotes/); assert.ok(!existsSync(out));
  });

  console.log("safety gate");
  // Assembled at run time so this file never contains something that looks like a credential.
  const fakeSecret = ["re", "_", "9fK2mQ7xB4nL8pR3tV6w", "Z1yC5"].join("");
  const plant = (what, files, expect) => check(`trips on ${what}`, () => {
    const dir = join(KIT, "skills/demo-setup");
    for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
    const out = join(TMP, `gate-${passed}`);
    const r = build(out);
    for (const rel of Object.keys(files)) rmSync(join(dir, rel.split("/")[0]), { recursive: true, force: true });
    assert.equal(r.status, 1, `${what}: the build should fail`);
    assert.match(r.stderr, /SAFETY GATE FAILED/); assert.match(r.stderr, expect);
    assert.ok(!existsSync(out), "a failed build leaves nothing to publish");
    return r;
  });
  await plant("a planted secret", { "notes.md": `key = ${fakeSecret}\n` }, /skills\/demo-setup\/notes\.md:1: looks like a Resend API key/);
  await check("and does not print the secret it found", () => {
    const dir = join(KIT, "skills/demo-setup");
    writeFileSync(join(dir, "notes.md"), `key = ${fakeSecret}\n`);
    const r = build(join(TMP, "gate-redact"));
    rmSync(join(dir, "notes.md"));
    assert.ok(!r.stderr.includes(fakeSecret) && !r.stdout.includes(fakeSecret));
  });
  await plant("a planted kpi-spec.md rulebook", { "kpi-spec.md": "# KPI rulebook\n" }, /kpi-spec\.md: a "-spec\.md" rulebook/);
  await plant("a file under schemas/", { "schemas/report.schema.json": "{}" }, /schemas\/ directory is operator material/);
  await plant("a foreign origin", { "notes.md": "See https://fde-agent.vercel.app/onboard for the steps.\n" }, /an address that is not this deployment's .*https:\/\/fde-agent\.vercel\.app/);
  await plant("a disallowed file type", { "run.sh": "#!/bin/sh\necho hi\n" }, /run\.sh: not on the allowlist/);
  await plant("an environment file", { ".env.local": "A=1\n" }, /\.env\.local: an environment file/);
  await plant("an email address", { "notes.md": "Ask priya.sharma@somebank.co.in for access.\n" }, /an email address that is not on the allowlist/);
  await plant("the generic package's name", { "notes.md": "Run npx @delivery-agents/cli fde-login.\n" }, /names another package/);
  await check("each secret shape is recognised, placeholders and this deployment's own address are not", () => {
    const j = (...parts) => parts.join("");
    const shapes = {
      "Resend": fakeSecret, "Cloudflare": j("cfut", "_", "A1b2C3d4E5f6G7h8I9j0K1l2"), "sk-": j("sk", "-", "proj-A1b2C3d4E5f6G7h8I9j0K1l2"),
      "AWS": j("AKIA", "IOSFODNN7EXAMPLE"), "private key": j("-----BEGIN RSA ", "PRIVATE KEY-----"), "bearer": j("Authorization: Bearer ", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"),
      "database": j("postgres://admin:", "hunter2@db.internal:5432/app"), "JSON Web Token": j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N"),
      "Google OAuth client secret": j("GOCSPX", "-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"),
    };
    for (const [what, text] of Object.entries(shapes)) {
      const found = safetyGate([{ path: "skills/x/SKILL.md", bytes: Buffer.from(`a ${text} b`) }], { origin: ORIGIN });
      assert.ok(found.some((o) => o.toLowerCase().includes(what.toLowerCase())), `${what}: ${JSON.stringify(found)}`);
    }
    const fine = `${ORIGIN}/api/mcp https://app.example.com you@company.com person@example.com Bearer <token> Bearer \${bearer} https://oauth2.googleapis.com/token skills@latest @scope/pkg@1.2.3 task-list re_use`;
    assert.deepEqual(safetyGate([{ path: "skills/x/SKILL.md", bytes: Buffer.from(fine) }], { origin: ORIGIN }), []);
    assert.deepEqual(safetyGate([{ path: "skills/x/a.md", bytes: Buffer.from("mail ops@desk.dev at https://docs.desk.dev/x") }], { origin: ORIGIN, allowHosts: ["docs.desk.dev"], allowEmails: ["ops@desk.dev"] }), []);
    assert.equal(safetyGate([{ path: "skills/x/link.md", bytes: Buffer.alloc(0), symlink: true }, { path: "extra.js", bytes: Buffer.from("x") }, { path: "skills/x/logo.png", bytes: Buffer.from([0x89, 0x50, 0, 0]) }], { origin: ORIGIN }).length, 4);
  });
  await check("passes clean once the planted files are gone", () => assert.equal(build(join(TMP, "clean-again")).status, 0));
} finally {
  rmSync(KIT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
}
assert.ok(!existsSync(KIT));
assert.equal(gitStatus(), statusBefore, "the test left the working tree as it found it");
console.log(`\n${passed} checks passed; the working tree is as it was.`);
