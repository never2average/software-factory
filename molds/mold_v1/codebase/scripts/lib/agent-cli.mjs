/**
 * The pure parts of the per-deployment agent package build (scripts/build-agent-cli.mjs):
 * input validation, the deployment module, dm.md rendering, SKILL.md validation and the
 * safety gate. No reads of the repo and no writes here, so scripts/test-agent-cli-build.mjs
 * can exercise each rule directly. See docs/AGENT_CLI.md.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// ------------------------------------------------------------------ inputs

/** npm's naming rules (validate-npm-package-name, "new packages"), including scopes. Returns a list of problems. */
export function npmNameProblems(name) {
  const out = [];
  if (typeof name !== "string" || !name.length) return ["name is required"];
  if (name.length > 214) out.push("name is longer than 214 characters");
  if (name !== name.toLowerCase()) out.push("name must be lowercase");
  if (name.trim() !== name) out.push("name has leading or trailing spaces");
  const m = /^(?:@([^/]+)\/)?([^/]+)$/.exec(name);
  if (!m) return [...out, 'name must be "<name>" or "@<scope>/<name>"'];
  for (const [what, part] of [["scope", m[1]], ["name", m[2]]]) {
    if (part === undefined) continue;
    if (/^[._]/.test(part)) out.push(`${what} cannot start with "." or "_"`);
    if (!/^[a-z0-9._~-]+$/.test(part)) out.push(`${what} "${part}" has characters that are not URL-safe (allowed: a-z 0-9 . _ ~ -)`);
    if (/[~'!()*]/.test(part)) out.push(`${what} cannot contain ~'!()*`);
  }
  if (!m[1] && ["node_modules", "favicon.ico"].includes(m[2])) out.push(`"${m[2]}" is a reserved name`);
  if (!m[1] && NODE_CORE.has(m[2])) out.push(`"${m[2]}" is a Node.js core module name`);
  return out;
}
const NODE_CORE = new Set("assert buffer child_process cluster console constants crypto dgram dns domain events fs http http2 https module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls tty url util v8 vm worker_threads zlib".split(" "));

/** "@scope/name" -> "name": the bin npx runs for `npx <package>`. */
export const unscopedName = (name) => name.replace(/^@[^/]+\//, "");

/**
 * The five program files, named after the package that ships them.
 *
 * They used to ship under the BASE product's own names (fde-cli.mjs, fde-login.mjs, …) in
 * every deployment's package, so an analyst on a housing-finance desk who opened
 * node_modules/@onfinance/hfc-research found another company's initials on five files. PR #28
 * renamed the bins; the files they point at kept the old names. Nothing in a copied source
 * may spell a sibling module's name: `modules` in deployment.generated.mjs is the only place
 * these exist at run time, which is what lets setup/*.mjs still be copied byte for byte.
 */
export function moduleFileNames(own) {
  return {
    cli: `${own}-cli.mjs`,
    login: `${own}-login.mjs`,
    mcp: `${own}-mcp.mjs`,
    tools: `${own}-tools.mjs`,
    installSkills: `${own}-install-skills.mjs`,
  };
}
/** The same map as import specifiers, for deployment.generated.mjs. */
export const moduleSpecifiers = (fileNames) => Object.fromEntries(Object.entries(fileNames).map(([k, v]) => [k, `./${v}`]));

/** What setup/ itself ships: the generic CLI, published as GENERIC_AGENT_PACKAGE. */
export const GENERIC_MODULE_FILES = { cli: "workspace-cli.mjs", login: "workspace-login.mjs", mcp: "workspace-mcp.mjs", tools: "workspace-tools.mjs", installSkills: "workspace-install-skill.mjs" };

/**
 * The generic package's names BEFORE they were neutral, and what each is now. Each old file
 * stays in setup/ as a one-line re-export of the new one (so `node setup/<old file>` and an
 * import of it still work), each old bin stays in setup/package.json beside the new one, and
 * each old command is still answered by the package's entrypoint (`legacyCommands` in the
 * generic deployment module). A package built for a deployment carries none of them: it was
 * never published under these names.
 */
export const LEGACY_GENERIC_MODULE_FILES = { cli: "fde-cli.mjs", login: "fde-login.mjs", mcp: "fde-mcp.mjs", tools: "fde-tools.mjs", installSkills: "fde-install-skill.mjs" };
export const GENERIC_COMMANDS = { login: "workspace-login", mcp: "workspace-mcp", installSkills: "workspace-install-skill" };
export const LEGACY_GENERIC_COMMANDS = { login: "fde-login", mcp: "fde-mcp", installSkills: "fde-install-skill" };
/** The generic package's own folder under ~/.config. A built package uses its own unscoped name. */
export const GENERIC_CONFIG_DIR = "workspace-mcp";

/**
 * The folder under ~/.config holding the sign-in, BEFORE it took the package's own name.
 * Every package wrote `~/.config/fde-mcp/<host>/credentials.json`, so a desk that bought one
 * product found another company's initials in a folder on their laptop. A built package now
 * uses its own unscoped name — the one string the person typed to install it, and the one
 * that cannot fall back to the base product's the way the product slug can; the host segment
 * under it still separates two deployments of one product. The generic package uses
 * GENERIC_CONFIG_DIR. This name survives only as the place a sign-in made before the rename
 * is READ from (setup/workspace-login.mjs), because the alternative is silently signing
 * everybody out.
 */
export const LEGACY_CONFIG_DIR = "fde-mcp";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const isSemver = (v) => typeof v === "string" && SEMVER.test(v);

/** The deployment's address: https, a host, nothing else. Returns { origin } or { problem }. */
export function parseOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { problem: "origin is required" };
  let u;
  try { u = new URL(raw.trim()); } catch { return { problem: `"${raw}" is not a URL` }; }
  if (u.protocol !== "https:") return { problem: `origin must be https (got ${u.protocol}//)` };
  if (u.username || u.password) return { problem: "origin must not carry credentials" };
  if (u.pathname !== "/" || u.search || u.hash) return { problem: `origin must be an address only, with no path, query or fragment (got "${raw}")` };
  if (!u.hostname.includes(".")) return { problem: `origin host "${u.hostname}" is not a public host name` };
  return { origin: u.origin };
}

// ------------------------------------------------------------------ the deployment module

/**
 * deployment.generated.mjs: the ONE module setup/*.mjs read every product word, the default
 * address, the name of every sibling module and the config folder from. `commands` are the
 * command names the help text shows; `modules` the files they live in; `configDir` the folder
 * under ~/.config this package writes a sign-in to. Those three are here rather than spelled
 * out in the sources precisely so a built package can carry its OWN names without the copied
 * sources differing by a byte from setup/'s.
 */
export function renderDeploymentModule(d) {
  const data = {
    packageName: d.packageName,
    name: d.name,
    slug: d.slug,
    tagline: d.tagline ?? null,
    origin: d.origin ?? null,
    mcpEndpoint: d.mcpEndpoint ?? null,
    vocabulary: d.vocabulary,
    commands: d.commands,
    legacyCommands: d.legacyCommands ?? null,
    modules: d.modules,
    configDir: d.configDir,
    connect: d.connect ?? null,
  };
  return `// AUTO-GENERATED by scripts/build-agent-cli.mjs - do not edit by hand.
// Everything in this package that names a product, an address, a sibling module or a folder
// on the user's machine. setup/ ships the DEFAULT (no address, the base product's wording and
// file names); a package built for one deployment carries that deployment's own. See
// docs/AGENT_CLI.md.
export const DEPLOYMENT = ${JSON.stringify(data, null, 2)};
export const { packageName, name, slug, tagline, origin, mcpEndpoint, vocabulary, commands, legacyCommands, modules, configDir, connect } = DEPLOYMENT;
`;
}

/**
 * What setup/deployment.generated.mjs holds: today's generic package. Its command names, its
 * five file names and its config folder are neutral (`workspace-*`), and every name it was
 * published under before still works: the old files are re-exports, the old bins are aliases
 * in setup/package.json, the old commands are `legacyCommands` (answered by the entrypoint,
 * never shown in its help), and a sign-in in the old config folder is read and copied over
 * (LEGACY_CONFIG_DIR), so nobody who already signed in is signed out.
 */
export function defaultDeployment({ packageName, profile, slug }) {
  return {
    packageName,
    name: profile.product.name,
    slug,
    tagline: null,
    origin: null,
    mcpEndpoint: null,
    vocabulary: profile.vocabulary,
    commands: GENERIC_COMMANDS,
    legacyCommands: LEGACY_GENERIC_COMMANDS,
    modules: moduleSpecifiers(GENERIC_MODULE_FILES),
    configDir: GENERIC_CONFIG_DIR,
    connect: null,
  };
}

// ------------------------------------------------------------------ dm.md

const DOMAIN_LINE = /^ {2}\|-([A-Za-z]+)[ \t]*$/;
/** Which record area lives in which data-room folder. */
const AREA_FOLDER = { deployments: "Deployments", implementations: "Implementation" };

/**
 * The package's dm.md: the repo's dm.md as THIS deployment shows it. Hidden domains are
 * removed; a relabelled one reads "Label [Folder]" (the bracketed name is the real one a
 * tool's path uses); redefined record areas are summarised and lose the default tree under their folder; subagent path templates are
 * appended under their domain. Under the default profile with no templates the result is
 * the source, byte for byte.
 */
export function renderDmMd({ source, profile, defaultDomains, extraTemplates = [], productName }) {
  const lines = source.split("\n");
  const blocks = []; // { folder, lines }
  let head = [];
  let cur = null;
  for (const line of lines) {
    const m = DOMAIN_LINE.exec(line);
    if (m) { cur = { folder: m[1], lines: [line] }; blocks.push(cur); } else if (cur) cur.lines.push(line); else head.push(line);
  }
  const domains = profile.dataroom.domains;
  const extrasByFolder = new Map();
  for (const t of extraTemplates) {
    const [folder, ...rest] = t.split("/");
    if (!extrasByFolder.has(folder)) extrasByFolder.set(folder, []);
    extrasByFolder.get(folder).push(rest.join("/"));
  }
  const unknown = [...extrasByFolder.keys()].filter((f) => !blocks.some((b) => b.folder === f));
  if (unknown.length) throw new Error(`dm.md: a subagent path template starts with ${unknown.join(", ")}, which is not a domain in dm.md`);

  const hidden = blocks.filter((b) => domains[b.folder]?.visible === false).map((b) => b.folder);
  const relabelled = blocks.filter((b) => domains[b.folder]?.visible !== false && domains[b.folder]?.label && domains[b.folder].label !== b.folder);
  const redefined = Object.keys(AREA_FOLDER).filter((a) => !isDeepStrictEqual(profile.domains[a], defaultDomains[a]));
  if (!hidden.length && !relabelled.length && !redefined.length && !extraTemplates.length) return source;

  const out = [];
  out.push(`${productName} data room.`);
  out.push("A name in [brackets] is the REAL folder name. Every path you pass to a tool uses the real name, never the label in front of it.");
  if (hidden.length) out.push(`Not used in this deployment, so not listed: ${hidden.join(", ")}.`);
  for (const a of redefined) {
    const d = profile.domains[a];
    const shown = a === "implementations" && d.group_by ? d.group_label.plural : d.label.plural;
    const rows = a === "implementations" && d.group_by ? `; each row is a ${d.label.singular}` : "";
    out.push(`${shown} (stored as ${AREA_FOLDER[a]}${rows}): ${d.description}`);
  }
  out.push("");
  out.push(...head);
  for (const b of blocks) {
    const spec = domains[b.folder];
    const extras = extrasByFolder.get(b.folder) ?? [];
    const isHidden = spec?.visible === false;
    if (isHidden && !extras.length) continue;
    // A redefined record area keeps its rows in the database; the default tree under its folder describes
    // the DEFAULT meaning of the area, so listing it would describe files this deployment never has.
    const isRedefined = redefined.some((a) => AREA_FOLDER[a] === b.folder);
    const kept = b.lines.slice(1);
    const body = isHidden ? [] : isRedefined
      ? ["    (records, not files: read and write them with the record tools; nothing is laid out under this folder by default)", ...kept.filter((l) => l.trim() === "")]
      : kept;
    // Keep the blank lines that end a block at its end, after anything appended.
    let tail = 0;
    while (tail < body.length && body[body.length - 1 - tail].trim() === "") tail++;
    const label = spec?.label && spec.label !== b.folder ? `${spec.label} [${b.folder}]` : b.folder;
    const note = isHidden ? " (not shown in the app; a subagent writes here)" : spec?.description ? ` (${spec.description})` : "";
    out.push(`  |-${label}${note}`);
    out.push(...body.slice(0, body.length - tail));
    for (const e of extras) out.push(`    |-${e} (added by a subagent)`);
    out.push(...body.slice(body.length - tail));
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ skills

/**
 * SKILL.md frontmatter, checked the way a YAML parser and the skills CLI would read it.
 * Returns { name, description } or throws with the file named.
 */
export function parseSkillFrontmatter(text, where) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fm) throw new Error(`${where}: missing YAML frontmatter (--- ... --- at the top)`);
  const fields = {};
  const rows = fm[1].split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.trim() || row.trimStart().startsWith("#")) continue;
    if (/^\s/.test(row)) continue; // continuation / nested value of the previous key
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(row);
    if (!kv) throw new Error(`${where}: frontmatter line ${i + 1} is not "key: value": ${row}`);
    let value = (kv[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(value) || value === "") {
      const block = [];
      while (i + 1 < rows.length && (/^\s+\S/.test(rows[i + 1]) || !rows[i + 1].trim())) block.push(rows[++i].trim());
      value = block.join(" ").trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error(`${where}: ${kv[1]} is not a valid double-quoted YAML string`); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new Error(`${where}: ${kv[1]} has an unclosed single quote`);
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      if (/: |:$/.test(value)) throw new Error(`${where}: ${kv[1]} contains ": " and is not quoted, which is not valid YAML. Wrap the value in double quotes.`);
      if (/ #/.test(value)) throw new Error(`${where}: ${kv[1]} contains " #", which YAML reads as a comment. Wrap the value in double quotes.`);
      if (/^[[\]{}&*!|>%@`,?-] ?/.test(value) && !/^-\S/.test(value)) throw new Error(`${where}: ${kv[1]} starts with a character YAML treats specially. Wrap the value in double quotes.`);
    }
    fields[kv[1]] = value;
  }
  const { name, description } = fields;
  if (!name || !description) throw new Error(`${where}: frontmatter needs both name and description`);
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error(`${where}: name "${name}" must match ^[a-z0-9-]{1,64}$ (the skills CLI rejects others)`);
  if (description.length > 1024) throw new Error(`${where}: description is ${description.length} characters; the skills CLI caps it at 1024`);
  return { name, description };
}

// ------------------------------------------------------------------ the safety gate

/** Third-party hosts the CLI legitimately names. Everything else that is not --origin is "another deployment". */
export const ALLOWED_HOSTS = [
  "accounts.google.com", // the login module: the Google sign-in page
  "oauth2.googleapis.com", // the login and mcp modules: token exchange and refresh
  "mcp.linear.app", // the tools module: the example in a bring-your-own connector's description
  "developers.google.com", // README: Google's note on installed-app client secrets
  "127.0.0.1", // the login module: the loopback OAuth callback
  "localhost",
];
/** Reserved for documentation (RFC 2606): never a real deployment. */
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/;
/** Placeholder addresses the connect instructions print (lib/mcp-connect.ts). */
const PLACEHOLDER_EMAILS = new Set(["you@company.com", "name@company.com"]);

/** Files a package always contains, whatever it is called. The five program files are added per build. */
export const ALWAYS_ALLOWED_FILES = ["package.json", "README.md", "dm.md", "deployment.generated.mjs"];
/** The generic package in setup/: the four above, its own five, and the five re-exports kept at their old names. */
export const ALLOWED_FILES = [...ALWAYS_ALLOWED_FILES, ...Object.values(GENERIC_MODULE_FILES), ...Object.values(LEGACY_GENERIC_MODULE_FILES)];
export const ALLOWED_SKILL_EXTENSIONS = [".md", ".json", ".txt", ".yaml", ".yml", ".csv"];

/**
 * The Google installed-app client secret in workspace-login.mjs / workspace-mcp.mjs is public by
 * design (Google: "not treated as a secret") and is the client the server verifies.
 * Any OTHER GOCSPX- value is a finding. Compared by digest so the gate does not repeat it.
 */
export const KNOWN_INSTALLED_APP_SECRET_SHA256 = "bc1a762fde41fff47a81bccb0a7c68ceff34a6bfe3bd518cf5a8a7ea370ccce8";

const SECRET_SHAPES = [
  ["Resend API key (re_…)", /\bre_[A-Za-z0-9]{16,}\b/g],
  ["Cloudflare user token (cfut_…)", /\bcfut_[A-Za-z0-9_-]{16,}/g],
  ["API key (sk-…)", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["AWS access key id (AKIA…)", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g],
  ["database URL with a password", /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Vercel Blob token", /\bvercel_blob_rw_[A-Za-z0-9_]{10,}/g],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
];
// The last label must be letters, so "cli@0.12.0" (a package at a version) is not an address.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'`<>)\]},\\]+/g;
const redact = (s) => (s.length <= 12 ? s : `${s.slice(0, 8)}…(${s.length} chars)`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Check a built package. `files` is [{ path, bytes: Buffer, symlink?: boolean }] with
 * POSIX relative paths. Returns a list of offender strings; empty means it may be published.
 */
export function safetyGate(files, { origin, allowHosts = [], allowEmails = [], foreignPackageNames = [], allowFiles = ALLOWED_FILES }) {
  const offenders = [];
  const hosts = new Set([...ALLOWED_HOSTS, ...allowHosts.map((h) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, "")), new URL(origin).host]);
  const emails = new Set([...PLACEHOLDER_EMAILS, ...allowEmails.map((e) => e.toLowerCase())]);
  for (const f of files) {
    const p = f.path;
    const base = p.split("/").at(-1);
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    if (f.symlink) { offenders.push(`${p}: a symbolic link (a package ships files, not links)`); continue; }
    if (/^\.env/i.test(base) || /\.env$/i.test(base)) offenders.push(`${p}: an environment file`);
    if (/-spec\.md$/i.test(base)) offenders.push(`${p}: a "-spec.md" rulebook is operator material and never ships`);
    if (p.split("/").slice(0, -1).includes("schemas")) offenders.push(`${p}: a file under a schemas/ directory is operator material and never ships`);
    const inSkills = p.startsWith("skills/") && p.split("/").length >= 3;
    const allowed = allowFiles.includes(p) || (inSkills && ALLOWED_SKILL_EXTENSIONS.includes(ext));
    if (!allowed) offenders.push(`${p}: not on the allowlist (allowed: ${allowFiles.join(", ")}; under skills/<name>/: ${ALLOWED_SKILL_EXTENSIONS.join(" ")})`);
    if (f.bytes.includes(0)) { offenders.push(`${p}: binary content`); continue; }
    const text = f.bytes.toString("utf8");
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    for (const [what, re] of SECRET_SHAPES) {
      for (const m of text.matchAll(re)) {
        if (what === "Google OAuth client secret" && sha256(m[0]) === KNOWN_INSTALLED_APP_SECRET_SHA256) continue;
        offenders.push(`${p}:${lineOf(m.index)}: looks like a ${what}: ${redact(m[0])}`);
      }
    }
    for (const m of text.matchAll(EMAIL)) {
      const e = m[0].toLowerCase().replace(/\.$/, "");
      if (emails.has(e) || PLACEHOLDER_HOST.test(e.split("@")[1])) continue;
      offenders.push(`${p}:${lineOf(m.index)}: an email address that is not on the allowlist: ${m[0]}`);
    }
    for (const m of text.matchAll(URL_RE)) {
      const raw = m[0].replace(/[.;:!?]+$/, "");
      if (/[${]/.test(raw.replace(/^https?:\/\//, "").split("/")[0])) continue; // a template, e.g. https://${host}
      let u;
      try { u = new URL(raw); } catch { continue; }
      if (!u.hostname || u.hostname === "…") continue;
      if (hosts.has(u.host) || hosts.has(u.hostname) || PLACEHOLDER_HOST.test(u.hostname)) continue;
      offenders.push(`${p}:${lineOf(m.index)}: an address that is not this deployment's (${origin}) or a listed third-party host: ${u.origin}`);
    }
    for (const name of foreignPackageNames) {
      let at = text.indexOf(name);
      while (at > -1) {
        // "@a/cli" inside "@a/cli-tools" is a different package.
        if (!/[a-z0-9._~-]/i.test(text[at + name.length] ?? "")) offenders.push(`${p}:${lineOf(at)}: names another package (${name})`);
        at = text.indexOf(name, at + name.length);
      }
    }
  }
  return offenders;
}

// ---------------------------------------------------------- the own-name gate

/**
 * The base product's role name, lower case: the member's legacy word (agent/lib/legacy-member.ts) that
 * check-ui-vocabulary.mjs keeps out of UI text (with its other words). The one place scripts spell it.
 */
export const BASE_PRODUCT_WORD = "fde";
/**
 * That word as a WORD. `_` is excluded on both sides because this gate is about the NAME a person
 * meets — a file, a bin, a README line, a folder — and check-ui-vocabulary.mjs draws the same line
 * ("identifiers are fine, text a person reads is not"). It used to mean `fde_status` and
 * `FDE_OPS_URL` were exempt outright; they are not any more. `wireNameGate` below covers
 * exactly that remainder — tool names, environment variables, storage keys — because those
 * identifiers ARE a contract, and a contract is changed by migrating it, not by exempting it.
 */
const BASE_WORD = new RegExp(`(?<![A-Za-z0-9_])${BASE_PRODUCT_WORD}(?![A-Za-z0-9_])`, "i");
/** A folder the package writes under ~/.config, when the name is a literal: `.config/x`, `".config", "x"`. */
const CONFIG_SEGMENT = /\.config["']?\s*[,/]\s*["']?([A-Za-z0-9._-]+)/g;

/**
 * THE REGRESSION GUARD. A built package must be named after ITSELF everywhere a person meets
 * it: the files in node_modules, the commands they type, the README they read, and the folder
 * it creates in their home directory. Before this gate, `@onfinance/hfc-research` — bought by a
 * desk of housing-finance analysts — shipped fde-cli.mjs and four siblings, a README line
 * offering `fde-login` "under its older name", and wrote their credentials to
 * ~/.config/fde-mcp/. Every one of those is the same bug check-ui-vocabulary.mjs exists for, one
 * layer further out, and every one of them came back silently after being fixed by hand.
 *
 * `files` is the same [{ path, bytes, symlink? }] safetyGate takes. Skipped entirely for the
 * generic package, which IS the base product's CLI. Returns a list of offender strings.
 */
export function ownNameGate(files, { name }) {
  const own = unscopedName(name);
  const offenders = [];
  // A deployment legitimately called "@acme/fde-desk" names itself, not the base product.
  const strip = (text) => String(text).split(name).join("").split(own).join("");
  const carries = (text) => BASE_WORD.test(strip(text));
  const say = (where, what) => offenders.push(`${where}: ${what} carries the base product's name ("${BASE_PRODUCT_WORD}"); a built package is named after itself (docs/AGENT_CLI.md)`);

  for (const f of files) if (carries(f.path)) say(f.path, "a shipped file name");

  const text = (p) => { const f = files.find((x) => x.path === p); return f && !f.symlink && !f.bytes.includes(0) ? f.bytes.toString("utf8") : null; };

  const pkgText = text("package.json");
  if (pkgText) {
    let pkg = null;
    try { pkg = JSON.parse(pkgText); } catch { offenders.push("package.json: not valid JSON, so its bins could not be checked"); }
    for (const [binName, target] of Object.entries(pkg?.bin ?? {})) {
      if (carries(binName)) say("package.json", `the bin "${binName}"`);
      if (carries(target)) say("package.json", `the bin "${binName}" -> ${target}`);
    }
    for (const entry of pkg?.files ?? []) if (carries(entry)) say("package.json", `the packed path "${entry}"`);
  }

  // The README is the one document the person reads before they type anything.
  const readme = text("README.md");
  if (readme) readme.split("\n").forEach((line, i) => { if (carries(line)) say(`README.md:${i + 1}`, `"${line.trim().slice(0, 100)}"`); });

  // Every path this package WRITES on a machine comes from these three values, so checking
  // the generated module checks them at the source rather than by guessing at code.
  const depText = text("deployment.generated.mjs");
  if (depText) {
    let dep = null;
    try { dep = JSON.parse(depText.slice(depText.indexOf("{"), depText.lastIndexOf("};") + 1)); } catch { offenders.push("deployment.generated.mjs: could not be parsed, so the config folder and command names could not be checked"); }
    if (dep && carries(dep.configDir ?? "")) say("deployment.generated.mjs", `the config folder "~/.config/${dep.configDir}/"`);
    for (const [role, cmd] of Object.entries(dep?.commands ?? {})) if (carries(cmd)) say("deployment.generated.mjs", `the ${role} command "${cmd}"`);
    for (const [role, cmd] of Object.entries(dep?.legacyCommands ?? {})) if (carries(cmd)) say("deployment.generated.mjs", `the ${role} command alias "${cmd}"`);
    for (const [role, mod] of Object.entries(dep?.modules ?? {})) if (carries(mod)) say("deployment.generated.mjs", `the ${role} module "${mod}"`);
  }

  // A net under the above: a hard-coded ~/.config/<something> anywhere in the package. The
  // one deliberate survivor is read-only and reaches this scan as an identifier, not a literal
  // (LEGACY_CONFIG_DIR in the login module): forgetting where a sign-in used to live is how
  // you silently sign out everyone who already signed in.
  for (const f of files) {
    if (f.symlink || f.bytes.includes(0)) continue;
    const body = f.bytes.toString("utf8");
    for (const m of body.matchAll(CONFIG_SEGMENT)) {
      if (!carries(m[1])) continue;
      say(`${f.path}:${body.slice(0, m.index).split("\n").length}`, `the folder "~/.config/${m[1]}/" it writes on the user's machine`);
    }
  }
  return offenders;
}

// --------------------------------------------------------- the wire-name gate

/**
 * An identifier "carries the base word" when one of its `_`- or `-`-separated
 * parts IS that word: `fde_status`, `FDE_OPS_URL`, `fde-google-token`. Not
 * `fdeOwner` and not an `/api/…` path segment: those are spellings nobody reads as a name (check-ui-vocabulary.mjs allow-lists
 * them in the UI bundle as keys and routes, with the reason).
 */
export const identifierCarriesBaseWord = (id) =>
  String(id)
    .split(/[-_]/)
    .some((part) => part.toLowerCase() === BASE_PRODUCT_WORD);

/** Every environment variable a source text READS: `process.env.X`, `process.env["X"]`. */
export function envNamesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["'`]([^"'`]+)["'`]/g)) {
    out.push({ name: m[1] ?? m[2], index: m.index });
  }
  return out;
}

/**
 * Every browser-storage key a source text names — at a call site, and as the
 * `…KEY = "literal"` constant that call sites usually go through instead. Both,
 * because the constant form is how every one of these keys is actually written
 * (`const TOKEN_KEY = "fde-google-token"`), and a gate that saw only the call
 * site would pass a new offender the moment somebody named it once.
 */
export function storageKeysIn(text) {
  const out = [];
  const add = (m) => out.push({ name: m[1], index: m.index });
  for (const m of String(text).matchAll(/(?:local|session)Storage(?:\s*\)?)?\s*\.\s*(?:get|set|remove)Item\(\s*["'`]([^"'`$]+)/g)) add(m);
  for (const m of String(text).matchAll(/(?:KEY|Key)\s*(?::\s*[A-Za-z<>\[\]| ]+)?=\s*["'`]([^"'`$]+)["'`]/g)) add(m);
  return out;
}

/** Every tool name a tools module ADVERTISES: the `name: "…"` of each definition. */
export function toolNamesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/^[ \t]*name:\s*["']([a-z][a-z0-9_]*)["'],/gm)) {
    out.push({ name: m[1], index: m.index });
  }
  return out;
}

/**
 * THE OTHER HALF OF THE REGRESSION GUARD — the half `ownNameGate` was written
 * without, and said so: it excludes `_` on both sides, so `fde_status` and
 * `FDE_OPS_URL` walked straight through it. That exemption was the right call
 * for #46 (renaming a tool served to a live coding assistant is a contract
 * change, not a cosmetic one) and it is now spent: the tool is
 * `workspace_status`, the variables are `WORKSPACE_*`, and the old names
 * survive only as declared aliases that are read but never advertised.
 *
 * So this gate covers exactly what that one skipped, inside a built package:
 * the tool names it advertises to a person's coding assistant, the environment
 * variables it reads from their MCP config, and any browser-storage key it
 * carries. `aliases` is the ONLY allowance — the backward-compatibility tables
 * (`aliases` on a tool definition, `LEGACY_ENV_NAMES` in the tools module,
 * `LEGACY_STORAGE_KEYS` in lib/browser-storage.ts). A name not in one of them
 * fails the build, which is the point: the old ones may stand, a new one may
 * not be born.
 *
 * `files` is the same [{ path, bytes, symlink? }] the other gates take.
 */
export function wireNameGate(files, { aliases = [] } = {}) {
  const allowed = new Set(aliases.map((a) => String(a).toLowerCase()));
  const offenders = [];
  const CATEGORIES = [
    ["an advertised tool name", toolNamesIn, "a coding assistant reads this out of tools/list"],
    ["an environment variable", envNamesIn, "a person types this into an MCP config and lives with it for months"],
    ["a browser-storage key", storageKeysIn, "this is a signed-in person's session"],
  ];
  for (const f of files) {
    if (f.symlink || f.bytes.includes(0)) continue;
    const text = f.bytes.toString("utf8");
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    for (const [what, find, why] of CATEGORIES) {
      for (const hit of find(text)) {
        if (!identifierCarriesBaseWord(hit.name)) continue;
        if (allowed.has(hit.name.toLowerCase())) continue;
        offenders.push(
          `${f.path}:${lineOf(hit.index)}: ${what} carries the base product's name ("${BASE_PRODUCT_WORD}"): ${hit.name} — ${why} (docs/AGENT_CLI.md)`,
        );
      }
    }
  }
  return offenders;
}

/** manifest.json: what a publisher diffs between releases. */
export function buildManifest({ name, version, origin, files }) {
  const list = files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: sha256(f.bytes) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { name, version, origin, fileCount: list.length, totalBytes: list.reduce((n, f) => n + f.bytes, 0), files: list };
}
export { sha256 };
