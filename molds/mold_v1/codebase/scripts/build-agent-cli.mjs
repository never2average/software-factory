#!/usr/bin/env node
/**
 * Build THIS deployment's own agent package: a complete, publishable npm package directory
 * with the deployment's address, product name, vocabulary, skills and data-room description
 * baked in, and named after ITSELF throughout - its five program files, its bins, its README
 * and the ~/.config folder it writes all carry the package's own name, never the base
 * product's (ownNameGate in lib/agent-cli.mjs fails the build otherwise). One per application
 * stamped from this codebase. docs/AGENT_CLI.md is the manual.
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
 *   --email-sign-in-only     AGENT_CLI_EMAIL_SIGN_IN_ONLY=1  build without Google sign-in (emailed code only)
 *   --write-default          rewrite setup/deployment.generated.mjs (the generic package's module) and exit
 *
 * Google sign-in: environment only, never a flag (a flag sits in the process list and the shell history):
 *   AGENT_CLI_GOOGLE_CLIENT_ID / AGENT_CLI_GOOGLE_CLIENT_SECRET   this deployment's installed-app (desktop) client;
 *   WORKSPACE_OAUTH_CLIENT_ID / WORKSPACE_OAUTH_CLIENT_SECRET     read when the first two are unset.
 * Both are required unless --email-sign-in-only. They are written into the package's deployment.generated.mjs
 * and nowhere else; the sources in setup/ hold no client (googleSignInGate in lib/agent-cli.mjs proves both).
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
  ALLOWED_HOSTS, ALWAYS_ALLOWED_FILES, BASE_PRODUCT_WORD, GENERIC_MODULE_FILES, buildManifest, defaultDeployment, googleSignInGate, googleSignInSettings, isSemver,
  moduleFileNames, moduleSpecifiers, npmNameProblems, ownNameGate, parseOrigin, parseSkillFrontmatter,
  periodsForTools, renderDeploymentModule, renderDmMd, safetyGate, unscopedName, wireNameGate,
} from "./lib/agent-cli.mjs";
import { fillPlaceholders, storedFolders } from "./lib/profile-words.mjs";
// The migration tables the wire-name gate allows and nothing else, read from the modules that
// HONOUR them, so the gate and the compatibility shim can never drift into disagreeing about
// what is deliberate.
import { declaredAliases } from "./lib/wire-names.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = join(ROOT, "setup");

function die(msg) { console.error(`build-agent-cli: ${msg}`); process.exit(1); }

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const FLAGS = { "--name": "AGENT_CLI_NAME", "--version": "AGENT_CLI_VERSION", "--origin": "AGENT_CLI_ORIGIN", "--access": "AGENT_CLI_ACCESS", "--out": "AGENT_CLI_OUT", "--repository": "AGENT_CLI_REPOSITORY", "--homepage": "AGENT_CLI_HOMEPAGE" };
const LISTS = { "--allow-host": "AGENT_CLI_ALLOW_HOSTS", "--allow-email": "AGENT_CLI_ALLOW_EMAILS" };
const opt = {}; const lists = { "--allow-host": [], "--allow-email": [] };
let writeDefault = false;
let emailOnly = /^(1|true|yes)$/i.test(process.env.AGENT_CLI_EMAIL_SIGN_IN_ONLY ?? "");
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--write-default") { writeDefault = true; continue; }
  if (a === "--email-sign-in-only") { emailOnly = true; continue; }
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
  // The generic package's dm.md: the repo's, with each domain's folder as the default profile stores it.
  writeFileSync(join(SETUP, "dm.md"), renderDmMd({ source: readFileSync(join(ROOT, "dm.md"), "utf8"), profile, defaultDomains: profile.domains, productName: profile.product.name }));
  console.log(`wrote setup/deployment.generated.mjs and setup/dm.md (${basePackage.name}, "${profile.product.name}", no built-in address)`);
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
// The commands a built package answers to. A package named after one of them would take
// `npx <package> login` to mean the package, not the command.
const RESERVED_BINS = ["login", "mcp", "install-skills", "skills"];
if (opt["--name"] && RESERVED_BINS.includes(unscopedName(opt["--name"]))) problems.push(`--name: "${unscopedName(opt["--name"])}" is one of this package's own command names`);
const { googleSignIn, problems: signInProblems } = googleSignInSettings(process.env, { emailOnly });
problems.push(...signInProblems.map((p) => `Google sign-in: ${p}`));
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
// Every file, command and on-disk folder this package ships is named after the package or the
// deployment — never after the base product. See ownNameGate in lib/agent-cli.mjs for why.
const own = unscopedName(name);
const moduleFiles = moduleFileNames(own);
// ~/.config/<this>/<host>/credentials.json. The package's own unscoped name, not the product
// slug: it is the one string the person actually typed to install this, and it cannot quietly
// become the BASE product's name the way the slug can when a deployment ships the default
// profile. The host segment under it still separates two deployments of one product.
const configDir = own;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const write = (rel, text) => { mkdirSync(dirname(join(OUT, rel)), { recursive: true }); writeFileSync(join(OUT, rel), text); };

// The five sources are copied byte for byte under this package's names: they hold no module
// name, product word or folder of their own, only lookups into the generated module below.
for (const [role, source] of Object.entries(GENERIC_MODULE_FILES)) write(moduleFiles[role], readFileSync(join(SETUP, source)));
write("deployment.generated.mjs", renderDeploymentModule({
  packageName: name, name: productName, slug, tagline, origin, mcpEndpoint: connect.endpoint, vocabulary: profile.vocabulary, folders: storedFolders(profile), workPeriods: periodsForTools(profile),
  commands, modules: moduleSpecifiers(moduleFiles), configDir,
  connect: { claudeCommand: connect.claudeCommand, tokenCommands: connect.tokenCommands, tokenNote: connect.tokenNote, packageAlternative: connect.packageAlternative },
  googleSignIn,
}));
write("dm.md", renderDmMd({ source: readFileSync(join(ROOT, "dm.md"), "utf8"), profile, defaultDomains, extraTemplates: [...EXTRA_DATAROOM_PATH_TEMPLATES], productName }));

/**
 * A base skill is written for the base product: it names the generic package, the generic
 * package's command names (`npx @delivery-agents/cli workspace-login`) and the base product's role
 * (in an older copy of a skill, "the <role word> MCP is wired"). In THIS package all three are this package's own - and a skill
 * description is quoted verbatim into the README, so leaving them would put another company's
 * initials in front of the analyst reading it.
 */
const GENERIC_COMMANDS = defaultDeployment({ packageName: GENERIC_AGENT_PACKAGE, profile, slug }).commands;
function rebrandBaseSkill(text) {
  let out = text.split(GENERIC_AGENT_PACKAGE).join(name);
  for (const role of Object.keys(commands)) out = out.split(`${name} ${GENERIC_COMMANDS[role]}`).join(`${name} ${commands[role]}`);
  // The base product's role word as a word only, never inside an identifier. There is no longer a wire identifier hiding behind it - the tool is workspace_status
  // and the variables are WORKSPACE_* (check:wire-names holds that), so this rewrite meets
  // only real prose now.
  return out.replace(new RegExp(`(?<![A-Za-z0-9_])${BASE_PRODUCT_WORD}(?![A-Za-z0-9_])`, "gi"), own);
}
for (const s of shippedSkills) {
  cpSync(s.dir, join(OUT, "skills", s.name), { recursive: true, verbatimSymlinks: true });
  if (s.base) {
    // A base skill writes placeholders for the role and record words ({account}, {member}, …): filled from THIS
    // deployment's profile in every package, the generic one included. A kit's own skills are in its own words.
    const inWords = (text) => fillPlaceholders(name !== GENERIC_AGENT_PACKAGE ? rebrandBaseSkill(text) : text, profile);
    for (const file of walk(join(OUT, "skills", s.name))) {
      if (!/\.(md|txt|json|ya?ml)$/i.test(file) || lstatSync(file).isSymbolicLink()) continue;
      const text = readFileSync(file, "utf8");
      const rebranded = inWords(text);
      if (rebranded !== text) writeFileSync(file, rebranded);
    }
    // The README quotes this line; it was read from the frontmatter before the rewrite above.
    s.description = inWords(s.description);
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
// Every bin, and now every file behind it, carries the package's own name. A bare `login`
// shadows the system's on a global install (PR #28), and a bin named for the base product would collide between
// two deployments' packages. `npx <package> login | mcp | install-skills` is the whole surface:
// the base product's own command names are NOT aliased here, because a package sold to one desk
// answering to another company's command names is the leak this build exists to close.
const bin = Object.fromEntries([
  [own, `./${moduleFiles.cli}`],
  [`${own}-login`, `./${moduleFiles.login}`], [`${own}-mcp`, `./${moduleFiles.mcp}`], [`${own}-install-skills`, `./${moduleFiles.installSkills}`],
]);
const pkg = {
  name, version,
  description: `${productName}: ${tagline} Sign in and connect your coding agent over MCP.`,
  type: "module",
  license,
  bin,
  files: [...Object.values(moduleFiles), "deployment.generated.mjs", "dm.md", "README.md", "skills"],
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

## Or: this package

Sign in once, either way:

\`\`\`bash
${googleSignIn ? `npx ${name} login                    # with your work Google account (opens a browser)\n` : ""}npx ${name} login --email <address>  # with a six-digit code emailed to you; type it when asked
\`\`\`

An emailed-code sign-in lasts about a week, then you run it again. Then:

\`\`\`bash
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

Installed globally, the commands are \`${own}\`, \`${own}-login\`, \`${own}-mcp\` and
\`${own}-install-skills\`: each carries the package's name, so none shadows a system command.

Which address is used, first match wins: \`--url <address>\` or \`WORKSPACE_OPS_URL\`, then the address saved
at sign-in, then the built-in ${origin}.

## Skills in this package

${shippedSkills.length ? shippedSkills.map((s) => `- \`${s.name}\` - ${s.description}`).join("\n") : "None."}

\`dm.md\` describes the data room as ${productName} shows it. A name in [brackets] is the real folder
name, and the one every tool path uses.

## Security

- Everything the agent does is done as YOU: the sign-in is your own Google work account or your
  own email address, checked by ${productName} on every call. Leaving a workspace ends access to it.
- The sign-in is stored only on your machine (\`~/.config/${configDir}/${new URL(origin).host}/credentials.json\`,
  readable by you alone). This package sends it to Google (to refresh a Google sign-in) and to ${origin}, nowhere else.
${googleSignIn ? `- The Google client id and secret inside \`deployment.generated.mjs\` are for an installed-app client. Google does
  not treat such a secret as confidential; it grants nothing without your interactive sign-in.
` : ""}- The tools write to the LIVE workspace. Writes to the data room and invitations preview first and
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
  allowFiles: [...ALWAYS_ALLOWED_FILES, ...Object.values(moduleFiles)],
  googleSignIn,
});
// The built-in Google client is in deployment.generated.mjs, exactly as given, and in no other file.
offenders.push(...googleSignInGate(files, { googleSignIn }));
// The generic package IS the base product's CLI, so it alone may carry the base product's names.
if (name !== GENERIC_AGENT_PACKAGE) offenders.push(...ownNameGate(files, { name }));
/**
 * The wire half, on EVERY package including the generic one. ownNameGate is skipped
 * for the generic package because that package IS the base product's CLI and may
 * legitimately be called after it — but a tool name and an environment variable are
 * not the package's name. They are a contract every deployment's assistant speaks,
 * so the base product's role word has no business in either, in any package.
 */
offenders.push(...wireNameGate(files, { aliases: declaredAliases() }));
if (offenders.length) {
  rmSync(OUT, { recursive: true, force: true });
  console.error(`build-agent-cli: SAFETY GATE FAILED - nothing was written. ${offenders.length} problem${offenders.length === 1 ? "" : "s"}:\n`);
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(`\nA public package is readable by anyone. Only agent-kit/ content ships; rulebooks (*-spec.md) and schemas/ never do.\nThird-party hosts allowed by default: ${ALLOWED_HOSTS.join(", ")} (add one with --allow-host).\nA package is also named after itself: its files, bins, README and the folder it writes under ~/.config carry ${name}, never the base product.`);
  process.exit(1);
}

const manifest = buildManifest({ name, version, origin, files });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// ------------------------------------------------------------------ report
console.log(`built ${name}@${version} for ${productName} at ${origin}`);
console.log(`  out:     ${OUT}`);
console.log(`  access:  ${access}    license: ${license}`);
console.log(`  sign-in: ${googleSignIn ? "Google (the client this build was given, in deployment.generated.mjs) and emailed code" : "emailed code only (built without a Google client)"}`);
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
