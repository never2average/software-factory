// The workflow library and the recipe catalog a deployment's workspaces are provisioned with: named by the
// deployment profile (`library.sources` in profiles/*.json), never listed in base code. The default profile names
// none, so a deployment that adds nothing provisions an empty library.
//
// A source is a directory in the repository, shaped like this:
//
//   <dir>/workflows/*.workflow.js   workflow scripts (export const meta = { name, description } + phase()/agent())
//   <dir>/recipes.json              { "recipes": [{ slug, title, summary, satisfiesCheck }] }, in checklist order
//   <dir>/apps.json                 { "apps": [ … ] }: STARTER APPS, the apps a new workspace opens with (see below)
//   <dir>/apps/*.json               the same, one starter app per file (in file-name order, after apps.json)
//   <dir>/history.json              optional: what the library has ever shipped (scripts/operator/library-cleanup.mjs)
//
// Read straight from the profile files, like scripts/lib/profile-specialists.mjs, so every generator agrees without
// depending on generation order. Merge rule as the profile generator's: files in name order, `library.sources` is a
// map, so a later file ADDS a source under its own id and turns one off by setting its id to null.
//
// A STARTER APP is an app (a saved document a specialist or a workflow regenerates) that every NEW workspace of the
// deployment is created with. It is the library's, never base code's, and is written like this:
//
//   { "key": "open-follow-ups",                 stable, unique in its library: what makes provisioning idempotent
//     "name": "Open follow-ups",                what a person reads in the Apps tab; unique across the build
//     "description": "One line.",
//     "brief": "What the document must hold.",  what the source is asked for at every refresh
//     "source": { "specialist": "follow-ups" }  a specialist THIS build has (in the tree, not excluded by the profile)
//            or { "workflow": "weekly-digest" } a workflow the SAME library ships (and this build provisions)
//     "refresh": "0 6 * * 1",                   optional: 5-field UTC cron; without it the app refreshes on request only
//     "first_content": "on_open" }              optional: "on_open" (the default) or "on_create"
//
// first_content says when the FIRST document is written. "on_open": nothing runs until a person opens the app or its
// schedule comes due, so creating a workspace never runs a model by itself. "on_create": the request that creates
// the workspace starts the first refresh, as the person creating it. Text may write the placeholders the profile
// fills ({account}, {owner}, …), like a library workflow.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { parseCron } from "../../agent/lib/cron-match.ts";
import { excludedSpecialists } from "./profile-specialists.mjs";

const PROFILE_FILE = /^\d{2}-[a-z0-9-]+\.json$/;
export const SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** `library.sources` as the profiles merge it: { id: directory }, turned-off ids removed. Malformed values are kept
 *  as they are written; validateSource (and gen-deployment-profile.mjs) says what is wrong with them. */
export function librarySources(root) {
  const dir = process.env.PROFILES_DIR || join(root, "profiles");
  const sources = {};
  if (!existsSync(dir)) return sources;
  for (const f of readdirSync(dir).filter((n) => PROFILE_FILE.test(n)).sort()) {
    let map;
    try {
      map = JSON.parse(readFileSync(join(dir, f), "utf8"))?.library?.sources;
    } catch {
      continue; // gen-deployment-profile.mjs reports a malformed profile, with its file and path
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [id, value] of Object.entries(map)) {
      if (id === "$comment") continue;
      if (value === null || value === false) delete sources[id];
      else sources[id] = value;
    }
  }
  return sources;
}

/** Why `library.sources.<id>` cannot be used, or null. */
export function validateSource(root, id, value) {
  if (!SOURCE_ID.test(id)) return `the source id "${id}" must be lower-case letters, digits and hyphens`;
  if (typeof value !== "string" || !value.trim()) return `must be the path of a directory in the repository (for example "library/${id}"), or null to turn the source off`;
  const rel = normalize(value);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return `"${value}" must be a path inside the repository`;
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return `"${value}" is not a directory in the repository`;
  if (!["workflows", "recipes.json", "apps.json", "apps"].some((f) => existsSync(join(abs, f)))) return `"${value}" holds none of workflows/*.workflow.js, recipes.json, apps.json`;
  return null;
}

/** One workflow script as a library row: its name and description from `meta`, its steps from phase(). */
export function parseWorkflowScript(script, file = "workflow") {
  const name = /name:\s*"([^"]+)"/.exec(script)?.[1];
  const description = /description:\s*"([^"]+)"/.exec(script)?.[1];
  const steps = [...script.matchAll(/phase\("([^"]+)"\)/g)].map((m) => m[1]);
  if (!name || !description) throw new Error(`${file}: missing name/description in meta`);
  return { name, description, steps, script };
}

const CHECKS = new Set(["members", "roster", "connector", "workflows", "dataroom", "customer"]);

/** One source directory's content: { workflows, recipes }. Throws with the file that is wrong. */
export function readLibraryDir(abs, label = abs) {
  const workflows = [];
  const wfDir = join(abs, "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => n.endsWith(".workflow.js")).sort()) {
      workflows.push(parseWorkflowScript(readFileSync(join(wfDir, f), "utf8"), `${label}/workflows/${f}`));
    }
  }
  const recipes = [];
  const recipeFile = join(abs, "recipes.json");
  if (existsSync(recipeFile)) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(recipeFile, "utf8"));
    } catch (e) {
      throw new Error(`${label}/recipes.json: not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(doc?.recipes)) throw new Error(`${label}/recipes.json: must be { "recipes": [ … ] }`);
    for (const [i, r] of doc.recipes.entries()) {
      const at = `${label}/recipes.json: recipes[${i}]`;
      if (!r || typeof r !== "object") throw new Error(`${at} must be an object`);
      if (typeof r.slug !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(r.slug)) throw new Error(`${at}.slug must be lower-case letters, digits and hyphens`);
      if (typeof r.title !== "string" || !r.title.trim()) throw new Error(`${at}.title is required`);
      if (r.summary != null && typeof r.summary !== "string") throw new Error(`${at}.summary must be text`);
      if (r.satisfiesCheck != null && !CHECKS.has(r.satisfiesCheck)) throw new Error(`${at}.satisfiesCheck must be one of ${[...CHECKS].join(", ")}`);
      const extra = Object.keys(r).filter((k) => !["slug", "title", "summary", "satisfiesCheck"].includes(k));
      if (extra.length) throw new Error(`${at}: unknown key ${extra.join(", ")}`);
      recipes.push({ slug: r.slug, title: r.title, summary: r.summary ?? null, satisfiesCheck: r.satisfiesCheck ?? null });
    }
  }
  return { workflows, recipes, apps: readStarterApps(abs, label) };
}

const APP_KEY = /^[a-z][a-z0-9-]{0,79}$/;
const APP_KEYS = ["key", "name", "description", "brief", "source", "refresh", "first_content"];
export const FIRST_CONTENT = ["on_open", "on_create"];

/**
 * A string that has the shape of a credential. A starter app's text is written into every new workspace and read by
 * people and by the model, and a library is a directory in a repository: a key pasted into a brief would be both.
 * Returns what it looks like, or null.
 */
const SECRET_SHAPES = [
  ["an API key (sk-…)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a Resend API key (re_…)", /\bre_[A-Za-z0-9]{16,}\b/],
  ["an AWS access key id (AKIA…)", /\bAKIA[0-9A-Z]{16}\b/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ["a URL with a password in it", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Vercel Blob token", /\bvercel_blob_rw_[A-Za-z0-9_]{10,}/],
  ["a Google OAuth client secret", /\bGOCSPX[-][A-Za-z0-9_-]{20,}/],
  ["a credential assignment", /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i],
  ["a long random token", /(?<![A-Za-z0-9])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9])/],
  ["a long hex token", /\b[0-9a-f]{40,}\b/i],
];
export function looksLikeSecret(text) {
  for (const [what, re] of SECRET_SHAPES) if (re.test(String(text ?? ""))) return what;
  return null;
}

/** One starter app as written, checked for shape (not yet against the build: see checkStarterApps). */
function parseStarterApp(a, at) {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error(`${at} must be an object`);
  const extra = Object.keys(a).filter((k) => k !== "$comment" && !APP_KEYS.includes(k));
  if (extra.length) throw new Error(`${at}: unknown key ${extra.join(", ")} (a starter app has ${APP_KEYS.join(", ")})`);
  if (typeof a.key !== "string" || !APP_KEY.test(a.key)) throw new Error(`${at}.key must be lower-case letters, digits and hyphens (it is what keeps a second run from creating the app twice, so it never changes)`);
  for (const k of ["name", "description", "brief"]) {
    if (typeof a[k] !== "string" || !a[k].trim()) throw new Error(`${at}.${k} is required`);
  }
  if (a.name.length > 200) throw new Error(`${at}.name is longer than 200 characters`);
  if (a.description.length > 500) throw new Error(`${at}.description is longer than 500 characters`);
  if (a.brief.length > 4000) throw new Error(`${at}.brief is longer than 4000 characters`);
  const src = a.source;
  const kinds = src && typeof src === "object" && !Array.isArray(src) ? Object.keys(src).filter((k) => k !== "$comment") : [];
  if (kinds.length !== 1 || !["specialist", "workflow"].includes(kinds[0]) || typeof src[kinds[0]] !== "string" || !src[kinds[0]].trim()) {
    throw new Error(`${at}.source must be { "specialist": "<id>" } or { "workflow": "<name>" }`);
  }
  let refresh = null;
  if (a.refresh != null) {
    if (typeof a.refresh !== "string" || !a.refresh.trim()) throw new Error(`${at}.refresh must be a 5-field UTC cron expression, or left out for an app refreshed on request only`);
    refresh = a.refresh.trim();
    try {
      parseCron(refresh);
    } catch (e) {
      throw new Error(`${at}.refresh: ${e.message}`);
    }
  }
  const first = a.first_content ?? "on_open";
  if (!FIRST_CONTENT.includes(first)) throw new Error(`${at}.first_content must be "on_open" (the document is written when a person first opens the app, or at its first scheduled refresh) or "on_create" (written when the workspace is created)`);
  for (const k of ["key", "name", "description", "brief", "refresh"]) {
    const what = looksLikeSecret(a[k]);
    if (what) throw new Error(`${at}.${k} holds what looks like ${what}. A starter app is written into every new workspace and read by people and by the model: it never carries a credential`);
  }
  const whatSource = looksLikeSecret(src[kinds[0]]);
  if (whatSource) throw new Error(`${at}.source holds what looks like ${whatSource}`);
  return { key: a.key, name: a.name.trim(), description: a.description.trim(), brief: a.brief.trim(), sourceKind: kinds[0], source: src[kinds[0]].trim(), refreshCron: refresh, firstContent: first };
}

/** A library directory's starter apps: apps.json, then apps/*.json in name order. Throws with the file that is wrong. */
export function readStarterApps(abs, label = abs) {
  const out = [];
  const json = (file, where) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${where}: not valid JSON: ${e.message}`);
    }
  };
  const single = join(abs, "apps.json");
  if (existsSync(single)) {
    const doc = json(single, `${label}/apps.json`);
    if (!Array.isArray(doc?.apps)) throw new Error(`${label}/apps.json: must be { "apps": [ … ] }`);
    for (const [i, a] of doc.apps.entries()) out.push(parseStarterApp(a, `${label}/apps.json: apps[${i}]`));
  }
  const dir = join(abs, "apps");
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      out.push(parseStarterApp(json(join(dir, f), `${label}/apps/${f}`), `${label}/apps/${f}`));
    }
  }
  const seen = new Map();
  for (const a of out) {
    if (seen.has(a.key)) throw new Error(`${label}: two starter apps have the key "${a.key}"`);
    seen.set(a.key, a);
  }
  return out;
}

/** The specialists THIS build has: every directory under agent/subagents/ that declares one, minus the profile's exclusions. */
export function buildSpecialists(root) {
  const dir = join(root, "agent", "subagents");
  const excluded = excludedSpecialists(root);
  const hidden = join(root, ".eve-build-hidden", "subagents");
  const all = new Set();
  for (const d of [dir, hidden]) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) if (existsSync(join(d, name, "agent.ts"))) all.add(name);
  }
  return { specialists: [...all].filter((k) => !excluded.includes(k)).sort(), excluded: [...all].filter((k) => excluded.includes(k)).sort() };
}

/** The specialists a script delegates to (`agent(…, { subagent: "key" })`); as agent/lib/workflow-library-view.ts. */
const delegatesTo = (script) => [...new Set([...String(script).matchAll(/subagent:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]))];

/**
 * A source's starter apps against the build: each one's source must be something a new workspace of THIS build will
 * hold, or the app could only ever fail its first refresh. Returns the first problem, or null.
 *
 *   specialist  a specialist in the tree that the profile does not exclude (it gets a row in every new workspace);
 *   workflow    a workflow the SAME library ships, which the build provisions (one that delegates to an excluded
 *               specialist is left out of a new workspace, so an app built on it is refused here).
 */
export function starterAppProblem(app, { workflows, specialists, excluded }) {
  if (app.sourceKind === "specialist") {
    if (excluded.includes(app.source)) return `its source is the specialist "${app.source}", which this build's profile excludes (specialists.exclude). Name a specialist this build has (${specialists.join(", ") || "none"}), or remove the starter app`;
    if (!specialists.includes(app.source)) return `its source is the specialist "${app.source}", and this build has no such specialist (it has ${specialists.join(", ") || "none"})`;
    return null;
  }
  const wf = workflows.find((w) => w.name === app.source);
  if (!wf) return `its source is the workflow "${app.source}", which this library does not ship (it ships ${workflows.map((w) => w.name).join(", ") || "none"}). A starter app is generated by a workflow of its own library, or by a specialist`;
  const needs = delegatesTo(wf.script).filter((k) => excluded.includes(k));
  if (needs.length) return `its source is the workflow "${app.source}", which is not provisioned in this build: it delegates to ${needs.map((k) => `"${k}"`).join(", ")}, which the profile excludes`;
  return null;
}

/**
 * The library this deployment provisions: every source its profile names, in id order. A workflow name or a recipe
 * slug that two sources both ship is refused: a workspace holds one row per name, so one of them would silently win.
 */
export function readLibrary(root, sources = librarySources(root)) {
  const ids = Object.keys(sources).sort();
  const workflows = [];
  const recipes = [];
  const apps = [];
  const owner = new Map();
  const build = buildSpecialists(root);
  for (const id of ids) {
    const problem = validateSource(root, id, sources[id]);
    if (problem) throw new Error(`library.sources.${id}: ${problem}`);
    const part = readLibraryDir(join(root, normalize(sources[id])), normalize(sources[id]));
    for (const w of part.workflows) {
      if (owner.has(`w:${w.name}`)) throw new Error(`library.sources: the workflow "${w.name}" is shipped by both "${owner.get(`w:${w.name}`)}" and "${id}"`);
      owner.set(`w:${w.name}`, id);
      workflows.push(w);
    }
    for (const r of part.recipes) {
      if (owner.has(`r:${r.slug}`)) throw new Error(`library.sources: the recipe "${r.slug}" is shipped by both "${owner.get(`r:${r.slug}`)}" and "${id}"`);
      owner.set(`r:${r.slug}`, id);
      recipes.push(r);
    }
    for (const a of part.apps) {
      const at = `library.sources.${id}: the starter app "${a.key}"`;
      const problem = starterAppProblem(a, { workflows: part.workflows, ...build });
      if (problem) throw new Error(`${at}: ${problem}`);
      const name = a.name.toLowerCase();
      if (owner.has(`a:${name}`)) throw new Error(`${at} is named "${a.name}", and so is a starter app of "${owner.get(`a:${name}`)}". Two apps with one name cannot be told apart in the Apps tab`);
      owner.set(`a:${name}`, id);
      // The key a workspace's row carries: the source's id and the app's own key. It never changes, so provisioning
      // again (a retry, an operator's apply) finds the row it already made, and a deleted one is not made again.
      apps.push({ ...a, key: `${id}/${a.key}`, library: id });
    }
  }
  return { sources: ids, workflows, recipes, apps };
}

/**
 * A script's CODE, without the words it sends: the contents of its double-quoted strings removed, trimmed. A library
 * workflow is stored in each deployment's own words (agent/lib/workflow-library-view.ts speaks its string literals)
 * and its prompts are reworded between releases; the code around them is what says "this is still that script".
 */
export function scriptSkeleton(script) {
  return createHash("sha256").update(String(script ?? "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').trim()).digest("hex");
}

/**
 * Everything the library directories in the repository have ever put into a workspace, whether or not this
 * deployment's profile names them: per library directory, each workflow name with the skeletons of its versions (the
 * files today plus history.json), and each recipe slug. Used only by scripts/operator/library-cleanup.mjs.
 */
export function knownLibraries(root, base = "library") {
  const out = [];
  const dir = join(root, base);
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir).sort()) {
    const abs = join(dir, id);
    if (!statSync(abs).isDirectory()) continue;
    const workflows = new Map();
    const recipes = new Set();
    const add = (name, skeleton) => workflows.set(name, (workflows.get(name) ?? new Set()).add(skeleton));
    const now = readLibraryDir(abs, `${base}/${id}`);
    for (const w of now.workflows) add(w.name, scriptSkeleton(w.script));
    for (const r of now.recipes) recipes.add(r.slug);
    const historyFile = join(abs, "history.json");
    if (existsSync(historyFile)) {
      const history = JSON.parse(readFileSync(historyFile, "utf8"));
      for (const [name, list] of Object.entries(history.workflows ?? {})) for (const s of list) add(name, s);
      for (const slug of history.recipes ?? []) recipes.add(slug);
    }
    out.push({ id, dir: `${base}/${id}`, workflows, recipes });
  }
  return out;
}
