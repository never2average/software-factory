// The workflow library and the recipe catalog a deployment's workspaces are provisioned with: named by the
// deployment profile (`library.sources` in profiles/*.json), never listed in base code. The default profile names
// none, so a deployment that adds nothing provisions an empty library.
//
// A source is a directory in the repository, shaped like this:
//
//   <dir>/workflows/*.workflow.js   workflow scripts (export const meta = { name, description } + phase()/agent())
//   <dir>/recipes.json              { "recipes": [{ slug, title, summary, satisfiesCheck }] }, in checklist order
//   <dir>/history.json              optional: what the library has ever shipped (scripts/operator/library-cleanup.mjs)
//
// Read straight from the profile files, like scripts/lib/profile-specialists.mjs, so every generator agrees without
// depending on generation order. Merge rule as the profile generator's: files in name order, `library.sources` is a
// map, so a later file ADDS a source under its own id and turns one off by setting its id to null.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

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
  if (!existsSync(join(abs, "workflows")) && !existsSync(join(abs, "recipes.json"))) return `"${value}" holds neither workflows/*.workflow.js nor recipes.json`;
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
  return { workflows, recipes };
}

/**
 * The library this deployment provisions: every source its profile names, in id order. A workflow name or a recipe
 * slug that two sources both ship is refused: a workspace holds one row per name, so one of them would silently win.
 */
export function readLibrary(root, sources = librarySources(root)) {
  const ids = Object.keys(sources).sort();
  const workflows = [];
  const recipes = [];
  const owner = new Map();
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
  }
  return { sources: ids, workflows, recipes };
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
