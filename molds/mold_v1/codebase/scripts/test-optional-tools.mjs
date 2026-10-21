/**
 * AN OPTIONAL TOOL THAT IS SWITCHED OFF IS SIMPLY NOT THERE (factory task mold_v1-263).
 *
 * Some of the agent's own tools exist only when the deployment turns them on: the record-area tools
 * (`list_deployments`, `upsert_deployment`, `list_implementations`, `upsert_implementation`: the profile's
 * `records.areas.<area>.agent.tools`), the work-period tools (`list_cycles`, `upsert_cycle`: `work_periods.mode`
 * not "off"), `read_image` (ENABLE_VISION / the vision model) and a record's workflow tools (`get_record_workflow`,
 * `reassign_step`, `extend_step`: a record area's lifecycle runs a workflow). Each file exports `disableTool()` when its tool is
 * off. eve 0.25.1 accepts that sentinel only on one of ITS OWN tool names (`web_search`, `bash`, ...): on any other it
 * threw at runtime agent resolution, `agent/tools/list_deployments.ts exports disableTool() but "list_deployments" is
 * not a framework tool`, so no agent could be resolved: every runtime start and every `npm run sandbox:prewarm` of a
 * build where one of them was off (the default profile: the four record-area tools are off). patches/eve+0.25.1.patch
 * (scripts/eve-patch/changes.mjs, mold_v1-263) makes it "omit this authored tool"; a framework tool's disableTool()
 * still removes eve's default, as before.
 *
 * Two parts:
 *   1. The files (fast, no build): every `disableTool()` under agent/tools/ and agent/subagents/<name>/tools/ is in
 *      the table below, which says how it is switched off; a new optional tool must be added here, so it is built
 *      both ways in part 2.
 *   2. The real agent graph (two real `eve build`s of a copy of the checkout, a few minutes): built with every optional
 *      tool OFF (work periods "off", no record-area tools, ENABLE_VISION=false, ENABLE_WEB_SEARCH=false) and with every
 *      one ON (a record area's lifecycle running a workflow: scripts/fixtures/record-workflows/review.json), then resolved the way eve's runtime resolves it (runtime/resolve-agent-graph.js) and read by
 *      `sandbox:prewarm --plan`. Off: the graph resolves, and each tool is absent from the node that has the file.
 *      On: each is present. Nothing is started.
 *
 *   npm run test:optional-tools            both parts
 *   node scripts/test-optional-tools.mjs --no-build      part 1 only
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/* ---- child mode: resolve the built agent graph in the current directory, print { node: [tool names] } ---------- */

if (process.argv[2] === "--resolve") {
  const require = createRequire(join(process.cwd(), "package.json"));
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const load = (path) => import(pathToFileURL(join(eveRoot, "dist/src", path)).href);
  const { createDiskRuntimeCompiledArtifactsSource } = await load("runtime/compiled-artifacts-source.js");
  const { resolvePackageSourceFilePath } = await load("internal/application/package.js");
  const { loadCompileMetadata } = await load("runtime/loaders/compile-metadata.js");
  const { loadCompiledManifest } = await load("runtime/loaders/manifest.js");
  const { loadCompiledModuleMapFromAuthoredSource } = await load("internal/authored-module-map-loader.js");
  const { withBundledCompiledArtifacts } = await load("runtime/loaders/bundled-artifacts.js");
  const { resolveRuntimeAgentGraph } = await load("runtime/resolve-agent-graph.js");
  const disk = createDiskRuntimeCompiledArtifactsSource(join(process.cwd(), ".output"), {
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
    sandboxAppRoot: process.cwd(),
  });
  const [metadata, manifest, moduleMap] = await Promise.all([
    loadCompileMetadata({ compiledArtifactsSource: disk }),
    loadCompiledManifest({ compiledArtifactsSource: disk }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource: disk }),
  ]);
  const out = {};
  try {
    await withBundledCompiledArtifacts({ manifest, metadata: metadata ?? undefined, moduleMap, sessionId: "optional-tools" }, async () => {
      const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
      for (const [nodeId, node] of graph.nodesByNodeId.entries()) out[nodeId] = node.toolRegistry.preparedTools.map((t) => t.name).sort();
    });
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(0);
  }
  console.log(JSON.stringify({ nodes: out }));
  process.exit(0);
}

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1200)}`}`);
};

/**
 * Every file that exports `disableTool()`: its node in the built graph, its tool name, and whether that name is one of
 * eve's own (framework) tools. How each is switched off is the OFF build below.
 */
const OPTIONAL = [
  { file: "agent/tools/list_deployments.ts", node: "root", tool: "list_deployments", framework: false, off: "profile: records.areas.deployments.agent.tools.read not true (the default)" },
  { file: "agent/tools/upsert_deployment.ts", node: "root", tool: "upsert_deployment", framework: false, off: "profile: records.areas.deployments.agent.tools.write not true (the default)" },
  { file: "agent/tools/list_implementations.ts", node: "root", tool: "list_implementations", framework: false, off: "profile: records.areas.implementations.agent.tools.read not true (the default)" },
  { file: "agent/tools/upsert_implementation.ts", node: "root", tool: "upsert_implementation", framework: false, off: "profile: records.areas.implementations.agent.tools.write not true (the default)" },
  { file: "agent/tools/list_cycles.ts", node: "root", tool: "list_cycles", framework: false, off: 'profile: work_periods.mode "off"' },
  { file: "agent/tools/upsert_cycle.ts", node: "root", tool: "upsert_cycle", framework: false, off: 'profile: work_periods.mode "off"' },
  { file: "agent/tools/read_image.ts", node: "root", tool: "read_image", framework: false, off: "ENABLE_VISION=false" },
  { file: "agent/tools/get_record_workflow.ts", node: "root", tool: "get_record_workflow", framework: false, off: "profile: no record area's lifecycle runs a workflow (the default)" },
  { file: "agent/tools/reassign_step.ts", node: "root", tool: "reassign_step", framework: false, off: "profile: no record area's lifecycle runs a workflow (the default)" },
  { file: "agent/tools/extend_step.ts", node: "root", tool: "extend_step", framework: false, off: "profile: no record area's lifecycle runs a workflow (the default)" },
  { file: "agent/tools/web_search.ts", node: "root", tool: "web_search", framework: true, off: "ENABLE_WEB_SEARCH=false" },
  { file: "agent/subagents/research/tools/web_search.ts", node: "subagents/research", tool: "web_search", framework: true, off: "ENABLE_WEB_SEARCH=false" },
  { file: "agent/subagents/app-author/tools/web_search.ts", node: "subagents/app-author", tool: "web_search", framework: true, off: "ENABLE_WEB_SEARCH=false" },
  { file: "agent/subagents/customer-context/tools/web_search.ts", node: "subagents/customer-context", tool: "web_search", framework: true, off: "ENABLE_WEB_SEARCH=false" },
];
/** Tools the OFF build must still have: the switch takes away only what it names. */
const ALWAYS = [
  ["root", "list_todos"],
  ["root", "bash"],
  ["subagents/research", "bash"],
];
const ENV_OFF = { ENABLE_VISION: "false", ENABLE_WEB_SEARCH: "false" };
const PROFILE_OFF = { work_periods: { mode: "off" } };
const PROFILE_ON = {
  records: {
    areas: {
      deployments: { agent: { tools: { read: true, write: true } } },
      implementations: { agent: { tools: { read: true, write: true } } },
    },
  },
};

/* ---- 1. the files ------------------------------------------------------------------------------------------------- */

function partFiles() {
  console.log("\nEvery tool file that exports disableTool() is one this test builds both ways:");
  const found = [];
  const scan = (dir) => {
    if (!existsSync(join(ROOT, dir))) return;
    for (const f of readdirSync(join(ROOT, dir)).sort()) {
      if (!/\.(ts|mts|js|mjs)$/.test(f)) continue;
      // Imported from eve/tools (a comment that names it is not a use).
      if (/import\s*\{[^}]*\bdisableTool\b[^}]*\}\s*from\s*["']eve\/tools["']/.test(readFileSync(join(ROOT, dir, f), "utf8"))) found.push(`${dir}/${f}`);
    }
  };
  scan("agent/tools");
  for (const s of readdirSync(join(ROOT, "agent/subagents")).sort()) scan(`agent/subagents/${s}/tools`);
  const known = OPTIONAL.map((o) => o.file).sort();
  const missing = found.filter((f) => !known.includes(f));
  check(`the ${found.length} files that do are all in this test's table (a new optional tool belongs there)`, missing.length === 0, missing);
  check("…and every file in the table still does", known.every((f) => found.includes(f)), known.filter((f) => !found.includes(f)));
  return found;
}

/* ---- 2. the real agent graph -------------------------------------------------------------------------------------- */

const nodeKey = (n) => (n === "root" || n === "__root__" ? "root" : n);

async function partGraph() {
  const { copyWithProfiles } = await import(pathToFileURL(join(ROOT, "scripts/lib/profile-copy.mjs")).href);
  const builds = [
    { label: "OFF", profile: PROFILE_OFF, env: ENV_OFF },
    // ON: a record area's lifecycle runs a workflow too (the neutral maker-checker review fixture), under the tools' layer.
    { label: "ON", profile: PROFILE_ON, env: {}, under: [["49-record-workflow.json", JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows/review.json"), "utf8"))]] },
  ];
  const results = {};
  for (const b of builds) {
    console.log(`\nEvery optional tool ${b.label} (a real \`eve build\` of a copy; nothing is started):`);
    const copy = copyWithProfiles(ROOT, [...(b.under ?? []), ["50-optional-tools.json", b.profile]]);
    try {
      const env = { ...process.env, ...b.env };
      for (const k of ["SANDBOX_BACKEND", "VERCEL"]) delete env[k];
      if (b.label === "ON") for (const k of ["ENABLE_VISION", "ENABLE_WEB_SEARCH", "CLOUDFLARE_MODEL_VISION", "GATEWAY_MODEL_VISION"]) delete env[k];
      const built = spawnSync(process.execPath, ["scripts/eve-build.mjs", "build"], { cwd: copy.dir, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      check(`${b.label}: the real eve builds it`, built.status === 0, (built.stderr || built.stdout).slice(-1200));
      const resolved = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/test-optional-tools.mjs"), "--resolve"], { cwd: copy.dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const line = resolved.stdout.split("\n").reverse().find((l) => l.startsWith("{"));
      let r = null;
      try {
        r = JSON.parse(line ?? "");
      } catch {
        r = null;
      }
      check(`${b.label}: eve's runtime resolves the built agent graph (runtime/resolve-agent-graph.js), refusing no tool file`, resolved.status === 0 && r?.nodes !== undefined, r?.error ?? resolved.stderr.slice(-1200));
      const nodes = Object.fromEntries(Object.entries(r?.nodes ?? {}).map(([k, v]) => [nodeKey(k), v]));
      results[b.label] = nodes;
      const plan = spawnSync(process.execPath, ["scripts/sandbox-prewarm-serial.mjs", "--plan"], { cwd: copy.dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      check(`${b.label}: \`sandbox:prewarm --plan\` reads the built agent (exit 0)`, plan.status === 0, plan.stderr.split("\n").filter((l) => !l.startsWith("[model]")).join("\n").slice(-1200));
      for (const o of OPTIONAL) {
        const tools = nodes[o.node];
        if (tools === undefined) {
          check(`${b.label}: ${o.node} is in the graph`, false, Object.keys(nodes));
          continue;
        }
        const has = tools.includes(o.tool);
        if (b.label === "OFF") check(`OFF: ${o.tool} is absent from ${o.node} (${o.off}; ${o.framework ? "eve's own tool, removed as before" : "an authored tool, omitted"})`, !has, tools);
        else check(`ON: ${o.tool} is present on ${o.node}`, has, tools);
      }
      if (b.label === "OFF") for (const [n, t] of ALWAYS) check(`OFF: ${t} is still on ${n} (only what is switched off goes)`, nodes[n]?.includes(t) === true, nodes[n]);
    } finally {
      copy.remove();
      rmSync(join(copy.dir), { recursive: true, force: true });
    }
  }
  if (results.OFF && results.ON) {
    const diff = [...new Set([...(results.ON.root ?? [])].filter((t) => !(results.OFF.root ?? []).includes(t)))].sort();
    const expected = [...new Set(OPTIONAL.filter((o) => o.node === "root").map((o) => o.tool))].sort();
    check("the root's tools differ between the two builds by exactly the optional ones", JSON.stringify(diff) === JSON.stringify(expected), { diff, expected });
  }
}

partFiles();
if (!process.argv.includes("--no-build")) await partGraph();
console.log(failures.length ? `\ntest-optional-tools: ${failures.length} FAILED\n  - ${failures.join("\n  - ")}` : `\ntest-optional-tools: ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);
