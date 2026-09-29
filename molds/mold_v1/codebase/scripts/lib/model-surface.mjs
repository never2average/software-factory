#!/usr/bin/env node
/**
 * THE MODEL-FACING SURFACE, rendered as text.
 *
 * Everything the eve agent's model reads that this repository authors, for the checkout it runs in (so a
 * checkout whose profiles/ relabel the domains renders what THAT deployment's model reads):
 *
 *   - the root system prompt: agent/instructions.{md,ts}, then agent/instructions/* in eve's order, with every
 *     dynamic resolver actually run against an offline session, and the per-turn deployment briefing;
 *   - every tool an agent is given, BUILT the way eve builds it (static tools by file slug; dynamic ones by
 *     running their resolver): name, description, and the JSON Schema of its input (parameter names, their
 *     descriptions, enum values);
 *   - the roster: each declared subagent as eve lowers it into a tool (directory name + description), and, for
 *     each one, the same prompt/tools/skills/sandbox-workspace rendering, recursively;
 *   - tool RESULTS: a fixed set of probe calls run offline (JSON-fallback system of record, local data room,
 *     in-process memory) and printed as the model receives them.
 *
 * Nothing here is grepped from source. What ships is what a pack and a profile produce in a build copy, and a
 * source grep has certified an unfixed tree green in this repo before (see check-wire-names.mjs).
 *
 *   node --experimental-strip-types scripts/lib/model-surface.mjs [--json] [--snapshot] [--no-results]
 *
 * scripts/check-agent-vocabulary.mjs runs it inside throwaway copies of the checkout, one per profile.
 *
 * Runs under Node's type stripping with two resolve hooks eve's bundler would otherwise supply: a `.js`
 * specifier retried as `.ts`, and `?raw` text imports.
 */
import { register } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, next) {
        if (specifier.endsWith("?raw")) {
          const r = await next(specifier.slice(0, -4), context);
          return { ...r, url: r.url + "?raw", format: "module", shortCircuit: true };
        }
        try { return await next(specifier, context); }
        catch (err) {
          if (specifier.endsWith(".js")) return await next(specifier.slice(0, -3) + ".ts", context);
          throw err;
        }
      }
      export async function load(url, context, next) {
        if (url.endsWith("?raw")) {
          const text = readFileSync(fileURLToPath(url.slice(0, -4)), "utf8");
          return { format: "module", source: "export default " + JSON.stringify(text) + ";", shortCircuit: true };
        }
        return next(url, context);
      }`),
  import.meta.url,
);

const ROOT = process.cwd();
const AGENT = join(ROOT, "agent");
const WANT_JSON = process.argv.includes("--json");
const WITH_RESULTS = !process.argv.includes("--no-results");

// Offline, always: no database, a scratch local data room, no provider keys. The surface must not depend on
// whatever the shell running the check happens to have exported.
// Capability flags and model settings change which tools exist (ENABLE_*, the vision model), so they are
// cleared too: the surface rendered is the one a deployment with every capability at its default gets.
for (const k of Object.keys(process.env)) {
  if (/^(DATABASE_URL|POSTGRES_URL|BLOB_READ_WRITE_TOKEN|EXA_API_KEY|GRANOLA_API_KEY|PAGERDUTY_|ENABLE_|CLOUDFLARE_|GATEWAY_|MODEL_|DATAROOM_)/.test(k)) delete process.env[k];
}
const SCRATCH = mkdtempSync(join(tmpdir(), "model-surface-"));
process.env.DATAROOM_DIR = join(SCRATCH, "dataroom");

/** A session context with no identity and no database behind it: what an offline resolver can be handed. */
function stubCtx() {
  return {
    session: { id: "surface-session", auth: { current: null, initiator: null }, parent: undefined },
    messages: [{ role: "user", content: "hello" }],
    callId: "surface-call",
    toolName: "surface",
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error("no sandbox offline"); },
    getSkill: async () => null,
    get: () => undefined,
  };
}

const isDynamic = (v) => v && typeof v === "object" && v.kind === "eve:dynamic" && v.events;
const quietly = async (fn) => {
  const { log, warn, error, info } = console;
  console.log = console.warn = console.error = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error, info }); }
};

async function importDefault(file) {
  const mod = await import(pathToFileURL(file).href);
  return mod.default;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  }).sort();
}

/** eve's model-visible JSON Schema for a tool input (zod -> JSON Schema; a plain JSON Schema is used as is). */
async function inputJsonSchema(schema) {
  if (!schema) return null;
  if (typeof schema.toJSONSchema === "function") {
    try { return schema.toJSONSchema({ io: "input", unrepresentable: "any" }); } catch { /* fall through */ }
  }
  if (schema["~standard"]) {
    const { z } = await import("zod");
    try { return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }); } catch { return { note: "unrenderable schema" }; }
  }
  return schema;
}

async function renderTool(name, def) {
  return { name, description: def.description ?? "", input: await inputJsonSchema(def.inputSchema) };
}

/** The tools an agent directory gives its model, built the way eve builds them. */
async function collectTools(agentDir) {
  const out = [];
  const dir = join(agentDir, "tools");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => /\.(ts|mts|js|mjs)$/.test(n)).sort()) {
    const slug = f.replace(/\.[^.]+$/, "");
    const exp = await quietly(() => importDefault(join(dir, f)));
    if (!exp) continue;
    if (isDynamic(exp)) {
      for (const [event, handler] of Object.entries(exp.events)) {
        if (!["session.started", "turn.started"].includes(event)) continue;
        const r = await quietly(async () => { try { return await handler({ type: event }, stubCtx()); } catch { return null; } });
        if (!r) continue;
        const branded = Object.getOwnPropertySymbols(r).some((s) => String(s) === "Symbol(eve:tool-brand)");
        const entries = branded ? [[slug, r]] : Object.entries(r);
        for (const [name, def] of entries) if (!out.some((t) => t.name === name)) out.push({ ...(await renderTool(name, def)), file: relative(ROOT, join(dir, f)), def });
      }
      continue;
    }
    // disableTool() sentinel: the model never sees it.
    if (typeof exp.execute !== "function") continue;
    out.push({ ...(await renderTool(slug, exp)), file: relative(ROOT, join(dir, f)), def: exp });
  }
  return out;
}

/** The system prompt of one agent directory: the root file first, then instructions/* by localeCompare. */
async function collectInstructions(agentDir) {
  const parts = [];
  for (const name of ["instructions.md", "instructions.ts"]) {
    const p = join(agentDir, name);
    if (!existsSync(p)) continue;
    if (name.endsWith(".md")) parts.push({ source: relative(ROOT, p), text: readFileSync(p, "utf8") });
    else {
      const d = await quietly(() => importDefault(p));
      parts.push({ source: relative(ROOT, p), text: d?.markdown ?? "" });
    }
  }
  const dir = join(agentDir, "instructions");
  if (existsSync(dir)) {
    const entries = readdirSync(dir).filter((n) => /\.(md|ts)$/.test(n)).sort((a, b) => a.localeCompare(b));
    for (const n of entries) {
      const p = join(dir, n);
      if (n.endsWith(".md")) { parts.push({ source: relative(ROOT, p), text: readFileSync(p, "utf8") }); continue; }
      const d = await quietly(() => importDefault(p));
      if (isDynamic(d)) {
        for (const [event, handler] of Object.entries(d.events)) {
          const r = await quietly(async () => { try { return await handler({ type: event }, stubCtx()); } catch { return null; } });
          if (r?.markdown) parts.push({ source: `${relative(ROOT, p)} (${event}, offline)`, text: r.markdown });
        }
      } else if (d?.markdown) parts.push({ source: relative(ROOT, p), text: d.markdown });
    }
  }
  return parts;
}

/** Skills (loaded on demand, with every sibling file readable) and the seeded sandbox workspace. */
function collectFiles(agentDir) {
  const files = [];
  for (const sub of ["skills", join("sandbox", "workspace")]) {
    for (const p of listFiles(join(agentDir, sub))) {
      if (/\.(pyc|png|jpg|jpeg|gif|pdf|xlsx|docx|pptx|zip)$/i.test(p) || p.includes("__pycache__")) continue;
      files.push({ source: relative(ROOT, p), path: relative(agentDir, p), text: readFileSync(p, "utf8") });
    }
  }
  return files;
}

/** Specialists the profile excludes: their directories stay, eve never sees them (scripts/eve-build.mjs). */
async function excludedSpecialists() {
  try {
    const { excludedSpecialists: read } = await import(pathToFileURL(join(ROOT, "scripts/lib/profile-specialists.mjs")).href);
    return new Set(read(ROOT));
  } catch {
    return new Set();
  }
}
let EXCLUDED = new Set();

async function collectAgent(agentDir, id) {
  const agent = { id, dir: relative(ROOT, agentDir) };
  if (id !== "root") {
    const cfg = await quietly(() => importDefault(join(agentDir, "agent.ts")));
    agent.description = cfg?.description ?? "";
  }
  agent.instructions = await collectInstructions(agentDir);
  agent.tools = await collectTools(agentDir);
  agent.files = collectFiles(agentDir);
  agent.subagents = [];
  const subDir = join(agentDir, "subagents");
  if (existsSync(subDir)) {
    for (const n of readdirSync(subDir).sort()) {
      const p = join(subDir, n);
      if (!statSync(p).isDirectory() || !existsSync(join(p, "agent.ts"))) continue;
      if (agentDir === AGENT && EXCLUDED.has(n)) continue;
      agent.subagents.push(await collectAgent(p, n));
    }
  }
  return agent;
}

// ----------------------------------------------------------------------------------------------- results

/**
 * Probe calls, by the tool's BASE name. Each takes the rendered tool (so it can read the parameter names the
 * model is actually given) and returns the input the model would send. Seeded offline: one record created
 * through the model-facing upsert, then read back through every reader.
 */
const SEED_ID = "surface-probe-co";
function prop(tool, pred) {
  const props = Object.keys(tool.input?.properties ?? {});
  return props.find(pred) ?? props[0];
}
const PROBES = [
  ["upsert_customer", (t) => ({ [prop(t, (k) => /^id$/.test(k))]: SEED_ID, name: "Surface Probe Co" })],
  // Nested record keys and stored enum values, written the way the model is told them (v.model()).
  ["upsert_customer", (t, v) => v.model({
    id: SEED_ID,
    fdeOwner: "analyst@example.com",
    implementation: { rolloutId: "large-caps", implementationStage: "Kickoff", implementationProgressPct: 10, implementationRiskLevel: "Green", blockerOwner: "Customer" },
    deployments: [{ deploymentId: "rep-1", environment: "prod", region: "customer-vpc", deployedVersion: "Q1 FY27", releaseStatus: "deployed", healthStatus: "healthy", lastDeployAt: "2026-07-01" }],
  })],
  // A validation error: its path and the choices it lists are what the model reads next.
  ["upsert_customer", (t, v) => v.model({ id: SEED_ID, implementation: { implementationStage: "Kickoff", implementationProgressPct: 1, implementationRiskLevel: "Green", blockerOwner: "Nobody" } })],
  ["list_customers", () => ({})],
  ["get_customer", (t) => ({ [prop(t, (k) => k === "id")]: SEED_ID })],
  ["get_customer", (t) => ({ [prop(t, (k) => k === "id")]: "no-such-company" })],
  ["list_stale_customers", () => ({ days: 7 })],
  ["match_customer_by_email", (t) => ({ [prop(t, (k) => /email/i.test(k))]: "someone@example.com" })],
  ["remember", (t, v) => ({ scope: `${v.memoryPrefix}:${SEED_ID}`, key: "probe", value: "a durable fact" })],
  ["list_memories", (t, v) => ({ scope: `${v.memoryPrefix}:${SEED_ID}` })],
  ["dataroom_write", (t, v) => ({ path: `${v.accountFolder}/${SEED_ID}/context.md`, content: "# context\n" })],
  ["dataroom_list", (t, v) => ({ prefix: `${v.accountFolder}/${SEED_ID}` })],
  ["dataroom_read", (t, v) => ({ path: `${v.accountFolder}/${SEED_ID}/context.md` })],
  ["dataroom_read", (t, v) => ({ path: `${v.accountFolder}/../nope` })],
  ["dataroom_read", (t, v) => ({ path: `${v.accountFolder}/${SEED_ID}/no-such-folder/x.bin` })],
  ["dataroom_fetch_to_sandbox", (t, v) => ({ path: `${v.accountFolder}/${SEED_ID}/context.md` })],
  ["read_customer_slas", () => ({})],
  ["list_fdes", () => ({})],
  ["build_workbook_spec", (t, v) => v.model({ customerId: SEED_ID, domain: "Implementation" })],
];

async function collectResults(root, vocab) {
  const results = [];
  // One file already in the room, written where STORAGE puts it (the model never names this path).
  const store = await import(pathToFileURL(join(AGENT, "lib", "dataroom-store.ts")).href);
  // No database: a session resolves to the default workspace, and its data room is `orgs/<id>/` like any other's.
  const { DEFAULT_ORG } = await import(pathToFileURL(join(AGENT, "lib", "org-context.ts")).href);
  await store.getDataroomStore(DEFAULT_ORG).write(`Customers/${SEED_ID}/context.md`, "# Surface Probe Co\n");
  await store.getDataroomStore(DEFAULT_ORG).write("People/sam-example-com/identity.json", JSON.stringify({ kind: "internal-fde", email: "sam@example.com", name: "Sam" }));
  const byBase = new Map();
  for (const t of root.tools) byBase.set(t.baseName ?? t.name, t);
  for (const [base, build] of PROBES) {
    const tool = byBase.get(base);
    if (!tool) { results.push({ tool: base, skipped: "not given to the root agent" }); continue; }
    const input = build(tool, vocab);
    const ctx = stubCtx();
    const out = await quietly(async () => {
      try { return await tool.def.execute(input, ctx); } catch (e) { return { thrown: String(e?.message ?? e) }; }
    });
    let modelView = out;
    if (typeof tool.def.toModelOutput === "function") {
      try { modelView = await tool.def.toModelOutput(out); } catch { /* keep raw */ }
    }
    results.push({ tool: tool.name, input, output: modelView });
  }
  return results;
}

// ------------------------------------------------------------------------------------------------- main

async function vocabularyView() {
  // After the vocabulary change the agent exposes its own mapping; before it, the base names are the only ones.
  const p = join(AGENT, "lib", "agent-vocabulary.ts");
  if (!existsSync(p)) return { accountFolder: "Customers", memoryPrefix: "customer", baseNameOf: (n) => n, model: (x) => x };
  const v = await import(pathToFileURL(p).href);
  /** A base-shaped input as the model writes it: keys as its schema names them, code values as it is told them. */
  const model = (x) => Array.isArray(x) ? x.map(model)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, val]) => [v.speakIdentifier(k), model(val)]))
    : typeof x === "string" && !/\s/.test(x) ? v.speakCode(x) : x;
  return {
    accountFolder: v.displayFolder("Customers"),
    memoryPrefix: v.MEMORY_ACCOUNT_PREFIX,
    baseNameOf: (n) => v.baseToolName(n),
    model,
  };
}

export async function renderSurface({ results = WITH_RESULTS } = {}) {
  EXCLUDED = await excludedSpecialists();
  const root = await collectAgent(AGENT, "root");
  // The workflow library a workspace is provisioned with: its step prompts reach specialists' models.
  const view = join(AGENT, "lib", "workflow-library-view.ts");
  root.library = existsSync(view)
    ? (await import(pathToFileURL(view).href)).deploymentWorkflowLibrary()
    : (await import(pathToFileURL(join(AGENT, "lib", "workflow-library.generated.ts")).href)).WORKFLOW_LIBRARY;
  const vocab = await vocabularyView();
  const tag = (a) => { for (const t of a.tools) t.baseName = vocab.baseNameOf(t.name); a.subagents.forEach(tag); };
  tag(root);
  // The per-turn block runtime-context.ts appends (it needs a workspace name offline, so render its part directly).
  const briefing = await import(pathToFileURL(join(AGENT, "lib", "deployment-briefing.ts")).href);
  root.briefing = briefing.renderDeploymentBriefing() ?? "";
  if (results) root.results = await collectResults(root, vocab);
  return root;
}

/**
 * Plain text, one section per model-facing thing, stable order.
 *
 * `snapshot: true` is the form the default-profile baseline is kept in: no tool results (they carry ids and
 * timestamps) and no source file names (a prompt moving from instructions.md to instructions.ts is not a change
 * the model can see; the prompt's text changing is). Each agent's prompt is its instruction parts joined in
 * eve's order.
 */
export function surfaceText(root, { snapshot = false } = {}) {
  const out = [];
  const sec = (title, body) => out.push(`=== ${title}\n${body}\n`);
  const walk = (a, path) => {
    if (a.id !== "root") sec(`${path} :: roster entry`, `${a.id}: ${a.description}`);
    if (snapshot) sec(`${path} :: prompt`, a.instructions.map((i) => i.text).join("\n\n"));
    else for (const i of a.instructions) sec(`${path} :: prompt :: ${i.source}`, i.text);
    for (const t of a.tools) sec(`${path} :: tool :: ${t.name}`, `${t.name}\n${t.description}\n${JSON.stringify(t.input, null, 2)}`);
    for (const f of a.files) sec(`${path} :: file :: ${f.path}`, f.text);
    for (const s of a.subagents) walk(s, `${path}/${s.id}`);
  };
  walk(root, "root");
  sec("root :: per-turn briefing", root.briefing);
  // Provisioned workflows: the text they send to a model (description, steps, the script's string literals).
  // Not part of the default snapshot's historic shape: rendered only for a relabelling or excluding profile.
  if (!snapshot) for (const w of root.library ?? []) {
    const literals = (w.script.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []).map((l) => { try { return JSON.parse(l); } catch { return l; } });
    sec(`workflow-library :: ${w.name}`, [w.description, ...w.steps, ...literals].join("\n"));
  }
  if (!snapshot && root.results) for (const r of root.results) sec(`root :: result :: ${r.tool}`, JSON.stringify(r, null, 2));
  return out.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let text;
  try {
    const root = await renderSurface();
    const strip = (a) => ({ ...a, tools: a.tools.map(({ def, ...t }) => t), subagents: a.subagents.map(strip) });
    text = WANT_JSON ? JSON.stringify(strip(root)) : surfaceText(root, { snapshot: process.argv.includes("--snapshot") });
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  // Exit only once the pipe has taken all of it: process.exit() right after a large write truncates it.
  process.stdout.write(text, () => process.exit(0));
}
