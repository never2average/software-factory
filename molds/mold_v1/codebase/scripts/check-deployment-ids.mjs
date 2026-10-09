#!/usr/bin/env node
/**
 * check:deployment-ids — RUNTIME CODE NAMES NO DEPLOYMENT'S VERCEL TEAM, PROJECT OR ADDRESS.
 *
 * The agent once admitted the web app's Vercel OIDC token only for one product's own team and project, written into
 * agent/channels/eve.ts and agent/lib/service-scope.ts, and defaulted the web app's address to that product's URL.
 * Every other deployment of this code had each service call (app refresh, scheduled workflows, workflow resume, the
 * run trigger) refused with a 401. Which team, project and address are the deployment's settings
 * (lib/service-frontend-subject.ts, lib/web-origin.ts, lib/agent-url.ts), never the code's.
 *
 * This fails on any of these in runtime code (agent/, lib/, app/, components/, services/, proxy.ts, next.config.ts,
 * vercel*.json), in code and in comments alike:
 *
 *   · a Vercel team or project id (team_…, prj_…) or a Vercel Connect client id (scl_…);
 *   · a `*.vercel.app` address (a deployment's own URL);
 *   · a Vercel OIDC subject or issuer spelled out (owner:<team>:project:…, https://oidc.vercel.com/<team>);
 *   · `vercelSubject({ teamSlug: "<literal>" … })` / `projectName: "<literal>"` — a subject built from literals;
 *   · a Vercel personal team slug (`<name>-<suffix>s-projects`, the shape Vercel gives a Hobby team);
 *   · any team slug listed in scripts/deployment-ids.known.json.
 *
 * Tests, operator scripts and docs may name deployments; they are not runtime code.
 *
 *   node scripts/check-deployment-ids.mjs              the gate (CI)
 *   node scripts/check-deployment-ids.mjs --self-test  proves each rule fails a planted file and passes a clean one
 *   node scripts/check-deployment-ids.mjs --root <dir> check another tree
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const RUNTIME_DIRS = ["agent", "lib", "app", "components", "services"];
const RUNTIME_FILES = ["proxy.ts", "next.config.ts", "vercel.json", "vercel.api.json", "vercel.eve.json"];
const EXT = /\.(ts|tsx|js|mjs|cjs|jsx|json)$/;
const SKIP_DIR = new Set(["node_modules", ".next", ".eve", "dist", "build", ".vercel", "test-results"]);

function known() {
  try {
    return JSON.parse(readFileSync(join(HERE, "deployment-ids.known.json"), "utf8")).teamSlugs ?? [];
  } catch {
    return [];
  }
}

function rules(teamSlugs) {
  const list = [
    ["a Vercel team id", /\bteam_[A-Za-z0-9]{16,}\b/],
    ["a Vercel project id", /\bprj_[A-Za-z0-9]{16,}\b/],
    ["a Vercel Connect client id", /\bscl_[A-Za-z0-9]{16,}\b/],
    ["a *.vercel.app address", /\b[a-z0-9][a-z0-9-]*\.vercel\.app\b/i],
    ["a Vercel OIDC subject spelled out", /owner:[A-Za-z0-9._-]+:project:[A-Za-z0-9._-]+/],
    ["a Vercel OIDC issuer with a team", /oidc\.vercel\.com\/[A-Za-z0-9._-]+/],
    ["a Vercel personal team slug", /\b[a-z0-9]+(?:-[a-z0-9]+)*s-projects\b/],
    ["a team slug written as a literal", /teamSlug\s*:\s*["'`][^"'`]+["'`]/],
    ["a project name written as a literal", /projectName\s*:\s*["'`][^"'`]+["'`]/],
  ];
  for (const slug of teamSlugs) list.push([`the team slug ${slug}`, new RegExp(slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))]);
  return list;
}

function* files(root) {
  for (const d of RUNTIME_DIRS) yield* walk(root, join(root, d));
  for (const f of RUNTIME_FILES) {
    try {
      if (statSync(join(root, f)).isFile()) yield join(root, f);
    } catch {
      /* absent */
    }
  }
}
function* walk(root, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) yield* walk(root, join(dir, e.name));
    } else if (EXT.test(e.name)) yield join(dir, e.name);
  }
}

export function check(root, teamSlugs = known()) {
  const problems = [];
  const rs = rules(teamSlugs);
  for (const file of files(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [what, re] of rs) if (re.test(line)) problems.push(`${relative(root, file)}:${i + 1}: ${what}: ${line.trim().slice(0, 140)}`);
    });
  }
  return problems;
}

function selfTest() {
  let failures = 0;
  const ok = (what, cond) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failures++;
  };
  const PLANTS = [
    ["agent/channels/eve.ts", 'vercelSubject({ teamSlug: "some-team", projectName: "web", environment: "production" })'],
    ["agent/lib/service-scope.ts", 'export const FRONTEND_SUBJECT = "owner:some-team:project:web:environment:production";'],
    ["agent/lib/run-tools.ts", 'const WEB_ORIGIN = process.env.WEB_ORIGIN || "https://some-web.vercel.app";'],
    ["lib/agent-url.ts", 'export const DEFAULT_AGENT_URL = "https://some-agent.vercel.app";'],
    ["services/x/deploy.ts", 'const project = "prj_EXAMPLE0000000000000000";'],
    ["app/route.ts", '// team team_EXAMPLE0000000000000000'],
    ["components/a.tsx", 'const iss = "https://oidc.vercel.com/some-team";'],
    ["next.config.ts", "// the client scl_EXAMPLE000000000000"],
    ["lib/x.ts", "// lives on the known-team-slug team"],
    ["lib/y.ts", "// deployed under someone-1234s-projects"],
  ];
  const base = mkdtempSync(join(tmpdir(), "deployment-ids-"));
  try {
    const clean = join(base, "clean");
    mkdirSync(join(clean, "agent/lib"), { recursive: true });
    writeFileSync(join(clean, "agent/lib/ok.ts"), 'const s = frontendSubject(); const o = process.env.WEB_ORIGIN; // the web app\'s project\n');
    mkdirSync(join(clean, "scripts"), { recursive: true });
    writeFileSync(join(clean, "scripts/test.mjs"), 'const t = "owner:some-team:project:web:environment:production"; // tests may\n');
    ok("a clean tree passes (and tests outside runtime code may name a deployment)", check(clean, ["known-team-slug"]).length === 0);
    PLANTS.forEach(([file, text], i) => {
      const dir = join(base, `p${i}`);
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), `${text}\n`);
      ok(`fails on ${file}: ${text.slice(0, 70)}`, check(dir, ["known-team-slug"]).length > 0);
    });
  } finally {
    if (base.startsWith(join(tmpdir(), "deployment-ids-"))) rmSync(base, { recursive: true, force: true });
  }
  console.log(failures ? `\ncheck-deployment-ids --self-test: ${failures} FAILED` : "\ncheck-deployment-ids --self-test: all passed");
  process.exit(failures ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();
else {
  const i = args.indexOf("--root");
  const root = i >= 0 ? args[i + 1] : new URL("..", import.meta.url).pathname;
  const problems = check(root);
  if (problems.length) {
    console.error(`check-deployment-ids: ${problems.length} problem(s). Runtime code names no deployment's Vercel team, project or address; read it from the deployment's settings (lib/service-frontend-subject.ts, lib/web-origin.ts, lib/agent-url.ts).\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("check-deployment-ids: runtime code names no Vercel team, project or deployment address.");
}
