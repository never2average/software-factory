#!/usr/bin/env node
/**
 * check:google-client — THE CODE HOLDS NO GOOGLE OAUTH CLIENT OF ANYONE'S.
 *
 * The coding-agent package's login and MCP modules once carried one project's desktop-client id and secret as
 * constants, and both front doors (lib/ops-auth.ts, agent/channels/eve.ts) admitted that client's tokens by id. So
 * every deployment of this code trusted one project's client, and the code could not be published. Which client a
 * deployment signs its people in with is its setting now: the server reads WORKSPACE_OAUTH_CLIENT_ID and
 * WORKSPACE_CLI_CLIENT_ID (agent/lib/google-audiences.ts), and scripts/build-agent-cli.mjs writes the client into the
 * BUILT package's deployment.generated.mjs from the build's environment (googleSignInGate proves it lands there and
 * nowhere else).
 *
 * This fails on any tracked file, code, tests and docs alike, that holds:
 *   · a Google OAuth client secret (the GOCSPX prefix followed by a dash);
 *   · a real-shaped Google OAuth client id (<project number>-<id>.apps.googleusercontent.com).
 * A test that needs one builds it from parts at run time. Placeholders without a project number
 * (`test-client.apps.googleusercontent.com`) are not real-shaped and pass.
 *
 *   node scripts/check-google-client.mjs              the gate (CI)
 *   node scripts/check-google-client.mjs --self-test  proves each rule fails a planted file and passes a clean one
 *   node scripts/check-google-client.mjs --root <dir> check another tree (every file under it, not only tracked ones)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIR = new Set(["node_modules", ".next", ".eve", "dist", "build", ".vercel", "test-results", ".git"]);
// Built from parts so this file does not spell the prefix it hunts.
const SECRET_PREFIX = ["GOCSPX", "-"].join("");
const RULES = [
  ["a Google OAuth client secret", new RegExp(SECRET_PREFIX)],
  ["a Google OAuth client id", /\b\d{6,20}-[a-z0-9]{20,64}\.apps\.googleusercontent\.com\b/],
];

function tracked(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(root, join(dir, e.name), out); }
    else if (e.isFile()) out.push(relative(root, join(dir, e.name)));
  }
  return out;
}

/** -> ["path:line: what", ...]; never the value itself. */
export function scan(root, { all = false } = {}) {
  const files = (!all && tracked(root)) || walk(root);
  const found = [];
  for (const rel of files) {
    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [what, re] of RULES) if (re.test(line)) found.push(`${rel}:${i + 1}: ${what}`);
    });
  }
  return found;
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "check-google-client-"));
  let ok = 0;
  const expect = (what, cond) => { if (!cond) { console.error(`FAIL  ${what}`); process.exitCode = 1; } else { ok++; console.log(`  ok  ${what}`); } };
  try {
    mkdirSync(join(dir, "setup"));
    const id = ["123456789012", "-", "abcdefghijklmnopqrstuvwxyz012345", ".apps.googleusercontent.com"].join("");
    const secret = `${SECRET_PREFIX}A1b2C3d4E5f6G7h8I9j0K1l2M3n4`;
    writeFileSync(join(dir, "setup/login.mjs"), `const ID = process.env.X ?? "${id}";\n`);
    expect("a client id written into code fails", scan(dir, { all: true }).some((f) => f.startsWith("setup/login.mjs:1: a Google OAuth client id")));
    writeFileSync(join(dir, "setup/login.mjs"), `\nconst S = "${secret}";\n`);
    const found = scan(dir, { all: true });
    expect("a client secret fails, with its line", found.some((f) => f === "setup/login.mjs:2: a Google OAuth client secret"));
    expect("the finding never repeats the value", found.every((f) => !f.includes(secret)));
    writeFileSync(join(dir, "setup/login.mjs"), "const ID = process.env.WORKSPACE_OAUTH_CLIENT_ID ?? DEPLOYMENT.googleSignIn?.clientId ?? null;\n");
    writeFileSync(join(dir, "test.mjs"), 'process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";\n');
    expect("settings and placeholders pass", scan(dir, { all: true }).length === 0);
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "node_modules/x/i.js"), `"${id}"`);
    expect("node_modules is not this code's", scan(dir, { all: true }).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`check-google-client --self-test: ${ok} checks passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) selfTest();
  else {
    const at = args.indexOf("--root");
    const root = at > -1 ? resolve(args[at + 1]) : ROOT;
    const found = scan(root, { all: at > -1 });
    if (found.length) {
      console.error(`check:google-client: ${found.length} Google OAuth client value${found.length === 1 ? "" : "s"} in the code:\n`);
      for (const f of found) console.error(`  - ${f}`);
      console.error("\nA deployment's Google client is its setting: WORKSPACE_OAUTH_CLIENT_ID / WORKSPACE_CLI_CLIENT_ID on the server,");
      console.error("AGENT_CLI_GOOGLE_CLIENT_ID / _SECRET in the package build's environment (docs/AGENT_CLI.md). A test builds one from parts.");
      process.exit(1);
    }
    console.log("check:google-client: no Google OAuth client id or secret in the code");
  }
}
