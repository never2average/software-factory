#!/usr/bin/env node
/**
 * Build THIS deployment's own agent package: a complete, publishable npm package directory
 * with the deployment's address, product name, vocabulary, skills and data-room description
 * baked in. One per application stamped from this codebase. docs/AGENT_CLI.md is the manual.
 *
 *   npm run build:agent-cli -- --name @acme/research --version 1.0.0 --origin https://research.acme.com
 *
 * Flags (each also an env var):
 *   --name <npm name>        AGENT_CLI_NAME       required
 *   --version <semver>       AGENT_CLI_VERSION    required
 *   --origin <https origin>  AGENT_CLI_ORIGIN     required; becomes the package's built-in address
 *   --access public|restricted  AGENT_CLI_ACCESS  default public
 *   --out <dir>              AGENT_CLI_OUT        default dist/agent-cli
 *   --repository <url> / --homepage <url>         AGENT_CLI_REPOSITORY / AGENT_CLI_HOMEPAGE; omitted unless given
 *   --allow-host <host>      AGENT_CLI_ALLOW_HOSTS   (comma-separated) third-party hosts a pack's skills may name
 *   --allow-email <address>  AGENT_CLI_ALLOW_EMAILS  (comma-separated) addresses that may appear
 *   --write-default          rewrite setup/deployment.generated.mjs (the generic package's module) and exit
 *
 * The product name, tagline and vocabulary are NOT flags: they come from the deployment
 * profile (lib/deployment-profile.generated.ts). PROFILES_DIR, as for
 * scripts/gen-deployment-profile.mjs, reads another set of profiles through that generator
 * instead (tests use it). This script never publishes: a person runs `npm publish`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_HOSTS, buildManifest, defaultDeployment, isSemver, npmNameProblems, parseOrigin, parseSkillFrontmatter,
  renderDeploymentModule, renderDmMd, safetyGate, unscopedName,
} from "./lib/agent-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = join(ROOT, "setup");
const CLI_SOURCES = ["fde-cli.mjs", "fde-login.mjs", "fde-mcp.mjs", "fde-tools.mjs", "fde-install-skill.mjs"];

function die(msg) { console.error(`build-agent-cli: ${msg}`); process.exit(1); }

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const FLAGS = { "--name": "AGENT_CLI_NAME", "--version": "AGENT_CLI_VERSION", "--origin": "AGENT_CLI_ORIGIN", "--access": "AGENT_CLI_ACCESS", "--out": "AGENT_CLI_OUT", "--repository": "AGENT_CLI_REPOSITORY", "--homepage": "AGENT_CLI_HOMEPAGE" };
const LISTS = { "--allow-host": "AGENT_CLI_ALLOW_HOSTS", "--allow-email": "AGENT_CLI_ALLOW_EMAILS" };
const opt = {}; const lists = { "--allow-host": [], "--allow-email": [] };
let writeDefault = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--write-default") { writeDefault = true; continue; }
  if (a === "--help" || a === "-h") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, "")); process.exit(0); }
  if (!(a in FLAGS) && !(a in LISTS)) die(`unknown argument "${a}" (see --help)`);
  const v = argv[++i];
  if (v === undefined || v.startsWith("--")) die(`${a} needs a value`);
  if (a in FLAGS) opt[a] = v; else lists[a].push(v);
}
for (const [flag, env] of Object.entries(FLAGS)) if (opt[flag] === undefined && process.env[env]?.trim()) opt[flag] = process.env[env].trim();
for (const [flag, env] of Object.entries(LISTS)) if (process.env[env]?.trim()) lists[flag].push(...process.env[env].split(",").map((s) => s.trim()).filter(Boolean));

// ------------------------------------------------------------------ the profile (never flags)
const uncomment = (v) => (Array.isArray(v) ? v.map(uncomment) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "$comment").map(([k, x]) => [k, uncomment(x)])) : v);
function printProfile(dir) {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print"], { env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) { die(`the deployment profile in ${dir} does not validate:\n${e.stderr || e.message}`); }
}
/** profiles/00-default.json alone: what the generic package in setup/ is built from, whatever packs are applied. */
function baseProfile() {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-base-profile-"));
  try { cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json")); return printProfile(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const { productSlug, mcpConnect, GENERIC_AGENT_PACKAGE } = await import(join(ROOT, "lib/mcp-connect.ts"));
const basePackage = JSON.parse(readFileSync(join(SETUP, "package.json"), "utf8"));

if (writeDefault) {
  const profile = baseProfile();
  const text = renderDeploymentModule(defaultDeployment({ packageName: basePackage.name, profile, slug: productSlug(profile.product.name) }));
  writeFileSync(join(SETUP, "deployment.generated.mjs"), text);
  console.log(`wrote setup/deployment.generated.mjs (${basePackage.name}, "${profile.product.name}", no built-in address)`);
  process.exit(0);
}

let profile; let defaultDomains;
if (process.env.PROFILES_DIR) {
  profile = printProfile(process.env.PROFILES_DIR);
  defaultDomains = uncomment(JSON.parse(readFileSync(join(process.env.PROFILES_DIR, "00-default.json"), "utf8"))).domains;
} else {
  const mod = await import(join(ROOT, "lib/deployment-profile.generated.ts"));
  profile = mod.DEPLOYMENT_PROFILE; defaultDomains = mod.DEFAULT_DOMAINS;
}
const { EXTRA_DATAROOM_PATH_TEMPLATES } = await import(join(ROOT, "agent/lib/subagent-registry.generated.ts"));

// ------------------------------------------------------------------ validate the inputs
const problems = [];
for (const flag of ["--name", "--version", "--origin"]) if (!opt[flag]) problems.push(`${flag} is required (or ${FLAGS[flag]})`);
if (opt["--name"]) problems.push(...npmNameProblems(opt["--name"]).map((p) => `--name: ${p}`));
if (opt["--version"] && !isSemver(opt["--version"])) problems.push(`--version: "${opt["--version"]}" is not a semantic version (e.g. 1.0.0)`);
const parsedOrigin = opt["--origin"] ? parseOrigin(opt["--origin"]) : {};
if (parsedOrigin.problem) problems.push(`--origin: ${parsedOrigin.problem}`);
const access = opt["--access"] ?? "public";
if (!["public", "restricted"].includes(access)) problems.push(`--access must be "public" or "restricted"`);
if (access === "restricted" && opt["--name"] && !opt["--name"].startsWith("@")) problems.push("--access restricted needs a scoped name (@scope/name): npm has no private unscoped packages");
for (const flag of ["--repository", "--homepage"]) if (opt[flag] && !/^(https:\/\/|git\+https:\/\/)\S+$/.test(opt[flag])) problems.push(`${flag} must be an https URL`);
const RESERVED_BINS = ["login", "mcp", "install-skills", "fde-login", "fde-mcp", "fde-install-skill"];
if (opt["--name"] && RESERVED_BINS.includes(unscopedName(opt["--name"]))) problems.push(`--name: "${unscopedName(opt["--name"])}" is one of this package's own command names`);
if (problems.length) die(`\n  - ${problems.join("\n  - ")}`);

const name = opt["--name"]; const version = opt["--version"]; const origin = parsedOrigin.origin;
const OUT = resolve(opt["--out"] ?? join(ROOT, "dist/agent-cli"));
if (OUT === ROOT || ROOT.startsWith(OUT + sep) || OUT === SETUP) die(`--out ${OUT} would overwrite the codebase`);
if (existsSync(OUT) && readdirSync(OUT).length && !existsSync(join(OUT, "manifest.json"))) die(`--out ${OUT} is not empty and is not a previous build (no manifest.json). Choose another directory.`);

// ------------------------------------------------------------------ skills
function listSkillDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
/** agent-kit/ at the codebase root, and one inside any subagent: a pack adds either. */
const kitRoots = [join(ROOT, "agent-kit"), ...listSkillDirs(join(ROOT, "agent/subagents")).map((k) => join(ROOT, "agent/subagents", k, "agent-kit"))].filter(existsSync);
const kitSkills = []; const includeBase = new Set();
for (const kit of kitRoots) {
  for (const s of listSkillDirs(join(kit, "skills"))) kitSkills.push({ name: s, dir: join(kit, "skills", s), from: relative(ROOT, join(kit, "skills", s)) });
  const kitJson = join(kit, "kit.json");
  if (existsSync(kitJson)) {
    let doc;
    try { doc = JSON.parse(readFileSync(kitJson, "utf8")); } catch (e) { die(`${relative(ROOT, kitJson)} is not valid JSON: ${e.message}`); }
    const unknownKeys = Object.keys(doc).filter((k) => !["$comment", "include_base_skills"].includes(k));
    if (unknownKeys.length) die(`${relative(ROOT, kitJson)}: unknown key ${unknownKeys.join(", ")} (it takes include_base_skills)`);
    if (doc.include_base_skills !== undefined && (!Array.isArray(doc.include_base_skills) || doc.include_base_skills.some((s) => typeof s !== "string"))) die(`${relative(ROOT, kitJson)}: include_base_skills must be a list of skill names`);
    for (const s of doc.include_base_skills ?? []) includeBase.add(s);
  }
}
const baseSkills = listSkillDirs(join(ROOT, "skills")).map((s) => ({ name: s, dir: join(ROOT, "skills", s), from: `skills/${s}`, base: true }));
for (const s of includeBase) if (!baseSkills.some((b) => b.name === s)) die(`agent-kit/kit.json include_base_skills names "${s}", which is not a directory under skills/`);
// The base skills teach the BASE product's use. A deployment that ships its own skills is a
// different use of the product, so it gets only the base skills it asks for by name.
const shippedSkills = kitSkills.length ? [...baseSkills.filter((b) => includeBase.has(b.name)), ...kitSkills] : baseSkills;
const excludedBase = kitSkills.length ? baseSkills.filter((b) => !includeBase.has(b.name)).map((b) => b.name) : [];
const seen = new Map();
for (const s of shippedSkills) {
  if (seen.has(s.name)) die(`two skills are named "${s.name}": ${seen.get(s.name)} and ${s.from}`);
  seen.set(s.name, s.from);
  const skillMd = join(s.dir, "SKILL.md");
  if (!existsSync(skillMd)) die(`${s.from}/SKILL.md is missing`);
  let fm;
  try { fm = parseSkillFrontmatter(readFileSync(skillMd, "utf8"), `${s.from}/SKILL.md`); } catch (e) { die(e.message); }
  if (fm.name !== s.name) die(`${s.from}/SKILL.md: name "${fm.name}" must equal its directory name "${s.name}"`);
  s.description = fm.description;
}

// ------------------------------------------------------------------ write the package
const productName = profile.product.name;
const tagline = profile.product.tagline;
const slug = productSlug(productName);
const connect = mcpConnect({ origin, productName, agentPackage: name });
const commands = { login: "login", mcp: "mcp", installSkills: "install-skills" };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const write = (rel, text) => { mkdirSync(dirname(join(OUT, rel)), { recursive: true }); writeFileSync(join(OUT, rel), text); };

for (const f of CLI_SOURCES) write(f, readFileSync(join(SETUP, f)));
write("deployment.generated.mjs", renderDeploymentModule({
  packageName: name, name: productName, slug, tagline, origin, mcpEndpoint: connect.endpoint, vocabulary: profile.vocabulary, commands,
  connect: { claudeCommand: connect.claudeCommand, tokenCommands: connect.tokenCommands, tokenNote: connect.tokenNote, packageAlternative: connect.packageAlternative },
}));
write("dm.md", renderDmMd({ source: readFileSync(join(ROOT, "dm.md"), "utf8"), profile, defaultDomains, extraTemplates: [...EXTRA_DATAROOM_PATH_TEMPLATES], productName }));

for (const s of shippedSkills) {
  cpSync(s.dir, join(OUT, "skills", s.name), { recursive: true, verbatimSymlinks: true });
  // A base skill names the generic package; in this package the same commands are this package's.
  if (s.base && name !== GENERIC_AGENT_PACKAGE) {
    for (const file of walk(join(OUT, "skills", s.name))) {
      if (!/\.(md|txt|json|ya?ml)$/i.test(file) || lstatSync(file).isSymbolicLink()) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes(GENERIC_AGENT_PACKAGE)) writeFileSync(file, text.split(GENERIC_AGENT_PACKAGE).join(name));
    }
  }
}
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

const license = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license ?? "UNLICENSED";
const bin = Object.fromEntries([
  [unscopedName(name), "./fde-cli.mjs"],
  ["login", "./fde-login.mjs"], ["mcp", "./fde-mcp.mjs"], ["install-skills", "./fde-install-skill.mjs"],
  ["fde-login", "./fde-login.mjs"], ["fde-mcp", "./fde-mcp.mjs"], ["fde-install-skill", "./fde-install-skill.mjs"],
]);
const pkg = {
  name, version,
  description: `${productName}: ${tagline} Sign in and connect your coding agent over MCP.`,
  type: "module",
  license,
  bin,
  files: [...CLI_SOURCES, "deployment.generated.mjs", "dm.md", "README.md", "skills"],
  engines: basePackage.engines ?? { node: ">=20" },
  keywords: ["mcp", "cli", slug],
  publishConfig: { access },
  ...(opt["--repository"] ? { repository: { type: "git", url: opt["--repository"] } } : {}),
  ...(opt["--homepage"] ? { homepage: opt["--homepage"] } : {}),
};
write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

const v = profile.vocabulary;
write("README.md", `# ${name}

**${productName}** - ${tagline}

This package connects a coding agent (Claude Code, Cursor, VS Code, Codex) to ${productName} at
${origin} over MCP, so the agent can work with ${v.account.plural}, the data room, workflows and
schedules as you. The address is built in: nothing to configure.

## Simplest: the hosted endpoint (no package)

${productName} serves MCP itself at \`${connect.endpoint}\`. In Claude Code:

\`\`\`bash
${connect.claudeCommand}
\`\`\`

Get the token with these two calls:

\`\`\`bash
${connect.tokenCommands.request}
${connect.tokenCommands.verify}
\`\`\`

${connect.tokenNote}

## Or: this package (Google Workspace accounts)

\`\`\`bash
npx ${name} login            # sign in once with your work Google account (opens a browser)
npx ${name} mcp              # the MCP server your coding agent runs
npx ${name} install-skills   # install the agent skills shipped in this package
npx ${name}                  # help
\`\`\`

Register it with Claude Code:

\`\`\`bash
${connect.packageAlternative.claudeCommand}
\`\`\`

Any other client, as JSON:

\`\`\`json
{ "command": "npx", "args": ["-y", "${name}", "mcp"] }
\`\`\`

\`fde-login\`, \`fde-mcp\` and \`fde-install-skill\` are the same commands under their older names.

Which address is used, first match wins: \`--url <address>\` or \`FDE_OPS_URL\`, then the address saved
at sign-in, then the built-in ${origin}.

## Skills in this package

${shippedSkills.length ? shippedSkills.map((s) => `- \`${s.name}\` - ${s.description}`).join("\n") : "None."}

\`dm.md\` describes the data room as ${productName} shows it. A name in [brackets] is the real folder
name, and the one every tool path uses.

## Security

- Everything the agent does is done as YOU: the sign-in is your own Google work account, checked
  by ${productName} on every call. Leaving a workspace ends access to it.
- The sign-in is stored only on your machine (\`~/.config/fde-mcp/${new URL(origin).host}/credentials.json\`,
  readable by you alone). This package sends it to Google (to refresh it) and to ${origin}, nowhere else.
- The Google client id and secret inside \`fde-login.mjs\` are for an installed-app client. Google does
  not treat such a secret as confidential; it grants nothing without your interactive sign-in.
- The tools write to the LIVE workspace. Writes to the data room and invitations preview first and
  need your confirmation.
- Never paste a password, token or key into a data-room file. Credentials go through
  \`connector_secret_set\`, which encrypts them and never reads them back.
- Skills are installed from this package's own files, pinned to the version you installed. Nothing
  is fetched from a URL.
`);

// ------------------------------------------------------------------ the safety gate
const files = walk(OUT).map((abs) => {
  const symlink = lstatSync(abs).isSymbolicLink();
  return { path: relative(OUT, abs).split(sep).join("/"), bytes: symlink ? Buffer.alloc(0) : readFileSync(abs), symlink };
});
const offenders = safetyGate(files, {
  origin, allowHosts: lists["--allow-host"], allowEmails: lists["--allow-email"],
  foreignPackageNames: name === GENERIC_AGENT_PACKAGE ? [] : [GENERIC_AGENT_PACKAGE],
});
if (offenders.length) {
  rmSync(OUT, { recursive: true, force: true });
  console.error(`build-agent-cli: SAFETY GATE FAILED - nothing was written. ${offenders.length} problem${offenders.length === 1 ? "" : "s"}:\n`);
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(`\nA public package is readable by anyone. Only agent-kit/ content ships; rulebooks (*-spec.md) and schemas/ never do.\nThird-party hosts allowed by default: ${ALLOWED_HOSTS.join(", ")} (add one with --allow-host).`);
  process.exit(1);
}

const manifest = buildManifest({ name, version, origin, files });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// ------------------------------------------------------------------ report
console.log(`built ${name}@${version} for ${productName} at ${origin}`);
console.log(`  out:     ${OUT}`);
console.log(`  access:  ${access}    license: ${license}`);
console.log(`  skills:  ${shippedSkills.map((s) => s.name).join(", ") || "(none)"}${excludedBase.length ? `    (base skills left out: ${excludedBase.join(", ")}; list them in agent-kit/kit.json include_base_skills to ship them)` : ""}`);
console.log(`  safety gate: passed (${files.length} files, ${manifest.totalBytes} bytes; manifest.json written beside them, not packed)`);
let packed;
try {
  packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: OUT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
} catch (e) { die(`npm pack --dry-run failed in ${OUT}: ${e.message}`); }
const packedPaths = packed.files.map((f) => f.path).sort();
const manifestPaths = manifest.files.map((f) => f.path).sort();
if (JSON.stringify(packedPaths) !== JSON.stringify(manifestPaths)) {
  const extra = packedPaths.filter((p) => !manifestPaths.includes(p)); const missing = manifestPaths.filter((p) => !packedPaths.includes(p));
  die(`npm would not pack exactly what the gate checked.${extra.length ? ` Packed but unchecked: ${extra.join(", ")}.` : ""}${missing.length ? ` Checked but not packed: ${missing.join(", ")}.` : ""}`);
}
console.log(`\nnpm pack --dry-run (${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} unpacked):`);
for (const f of packed.files) console.log(`  ${String(f.size).padStart(7)}  ${f.path}`);
console.log(`\nTo publish, a person runs:  npm publish ${relative(process.cwd(), OUT) || "."} --access ${access}`);
