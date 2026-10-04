/**
 * EVERY sandbox this app creates takes the SANDBOX_* settings — one place, for the root, every specialist and every
 * specialist a pack adds later.
 *
 * WHY THIS IS A BUILD STEP. eve gives each declared specialist its own sandbox and inherits nothing from the root
 * (node_modules/eve/docs/subagents.mdx: "An absent slot falls back to the framework default, not to the root's
 * version"). Read in eve 0.25.1:
 *
 *   · runtime/sandbox/registry.js      no authored definition  → `{ backend: defaultSandbox() }`, no options
 *   · runtime/resolve-sandbox.js       a definition with no `backend` → `defaultSandbox()`, no options
 *   · public/sandbox/backends/default  off Vercel: Docker if a daemon answers, else `microsandbox(undefined)`:
 *                                      1 vCPU, allow-all egress
 *
 * There is no agent-level or config-level default backend, no environment variable for the options, and the options
 * a backend was created with are private to it. So a specialist with no `backend: microsandbox(settings)` of its own
 * (no sandbox definition at all, or one that only defines `bootstrap`, which is what a pack ships) runs on eve's
 * defaults. First real server, 2026-10-04: the root's template built, the next specialist's ran its bootstrap on
 * 1 vCPU with no network policy and spun for 1h50m.
 *
 * WHAT IT DOES. For the duration of an eve build made with `SANDBOX_BACKEND=microsandbox` (scripts/eve-build.mjs,
 * under its lock), every agent node's sandbox slot holds a generated WRAPPER:
 *
 *   node has `sandbox/sandbox.ts`     moved to `sandbox/sandbox.authored.ts`, wrapper written in its place
 *   else has `sandbox.ts`             moved to `sandbox.authored.ts`, wrapper written in its place
 *   else has `sandbox/` (seed files)  wrapper written at `sandbox/sandbox.ts`
 *   else                              wrapper written at `sandbox.ts`
 *
 * The wrapper is the authored definition (its bootstrap, onSession, revalidationKey: untouched) with
 * `backend: microsandbox(microsandboxSettings())`, so the template VM and every session VM of that node get
 * SANDBOX_CPUS, SANDBOX_MEMORY_MIB and the network deny list. The backend object carries the settings it was made
 * from under {@link SETTINGS_TAG}, which is how `npm run sandbox:prewarm` proves it for each node of the BUILT agent
 * and refuses any node without it. When the build ends (or its process is found dead) the wrappers are removed and
 * the authored files moved back: the tree, `git status` and a checkout are unchanged.
 *
 * WITH THE SETTING UNSET (every Vercel deployment) NOTHING HERE RUNS: no file is written or moved, eve reads the
 * same sources, and every sandbox template key is the one it was. A pack adds nothing: its specialists are agent
 * nodes like any other, found by walking the tree.
 *
 *   node scripts/lib/sandbox-overlay.mjs --self-test
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** First line of every wrapper. A `sandbox.ts` that starts with it is ours to delete; nothing else ever is. */
export const WRAPPER_MARKER = "// GENERATED-SANDBOX-WRAPPER (scripts/lib/sandbox-overlay.mjs). Exists only during an eve build with SANDBOX_BACKEND=microsandbox. Never commit.";

/** `Symbol.for(...)` key under which a wrapper's backend carries the settings it was created from. */
export const SETTINGS_TAG = "app.sandbox.settings";

const AUTHORED = "sandbox.authored.ts";

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** What `SANDBOX_BACKEND` selects, read the way agent/lib/sandbox-settings.ts reads it. A wrong value is an error. */
export function sandboxBackendOf(env = process.env) {
  const raw = (env.SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (raw === "" || raw === "vercel") return "vercel";
  if (raw === "microsandbox") return "microsandbox";
  throw new Error(`SANDBOX_BACKEND=${JSON.stringify(raw)} is not supported. Use "vercel" (the default) or "microsandbox".`);
}

/** Every agent node under `<appRoot>/agent`: the root, each `subagents/<name>/` with an `agent.ts`, and theirs. */
export function agentNodes(appRoot) {
  const out = [];
  const walk = (dir, id) => {
    out.push({ id, dir });
    const sub = join(dir, "subagents");
    if (!isDir(sub)) return;
    for (const name of readdirSync(sub).sort()) {
      const child = join(sub, name);
      if (isDir(child) && existsSync(join(child, "agent.ts"))) walk(child, id === "root" ? `subagents/${name}` : `${id}/subagents/${name}`);
    }
  };
  if (isDir(join(appRoot, "agent"))) walk(join(appRoot, "agent"), "root");
  return out;
}

/** Where a node's sandbox definition lives (eve: the folder layout wins over the shorthand), and whether one is authored. */
export function sandboxSlot(nodeDir) {
  const folder = join(nodeDir, "sandbox", "sandbox.ts");
  const shorthand = join(nodeDir, "sandbox.ts");
  if (existsSync(folder)) return { slot: folder, authored: true };
  if (existsSync(shorthand)) return { slot: shorthand, authored: true };
  if (isDir(join(nodeDir, "sandbox"))) return { slot: folder, authored: false };
  return { slot: shorthand, authored: false };
}

const isWrapper = (file) => {
  try {
    return readFileSync(file, "utf8").startsWith(WRAPPER_MARKER);
  } catch {
    return false;
  }
};

/**
 * The wrapper's source. `authoredSha` is the authored definition's content hash, written into the file because eve
 * derives a template's key from the SLOT file's source: without it an edited bootstrap would keep the old template.
 */
export function wrapperSource({ node, authoredSha }) {
  const authored = authoredSha
    ? `import authored from "./sandbox.authored.js";\n// authored definition sha256: ${authoredSha}`
    : "// This node authors no sandbox definition: eve's default one (no bootstrap), on the deployment's backend.\nconst authored = {};";
  return `${WRAPPER_MARKER}
// node: ${node}
import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";
import { microsandboxSettings } from "#lib/sandbox-settings.js";
${authored}

// Null unless SANDBOX_BACKEND=microsandbox where this runs: then the definition is passed through as authored.
const settings = microsandboxSettings();

export default defineSandbox(
  settings
    ? { ...authored, backend: Object.assign(microsandbox(settings), { [Symbol.for(${JSON.stringify(SETTINGS_TAG)})]: settings }) }
    : authored,
);
`;
}

/**
 * Put a wrapper in every node's sandbox slot. Returns `[{ node, slot, authored }]` (paths relative to appRoot).
 * Idempotent: a slot that already holds a wrapper is rewritten from its authored file, never wrapped twice.
 */
export function applySandboxOverlay(appRoot) {
  const applied = [];
  for (const { id, dir } of agentNodes(appRoot)) {
    let { slot, authored } = sandboxSlot(dir);
    const kept = join(slot, "..", AUTHORED);
    if (authored && isWrapper(slot)) authored = existsSync(kept); // a previous overlay is still here
    else if (authored) {
      if (existsSync(kept)) throw new Error(`sandbox overlay: both ${relative(appRoot, slot)} and ${relative(appRoot, kept)} exist; "${AUTHORED}" is a name this build step uses. Keep one.`);
      renameSync(slot, kept);
    }
    const authoredSha = authored ? createHash("sha256").update(readFileSync(kept)).digest("hex") : null;
    writeFileSync(slot, wrapperSource({ node: id, authoredSha }));
    applied.push({ node: id, slot: relative(appRoot, slot), authored: authored ? relative(appRoot, kept) : null, authoredSha });
  }
  return applied;
}

/* ---- the build's stamp ------------------------------------------------------------------------------------------ */

/**
 * `<appRoot>/.output/sandbox-overlay.json`, written by scripts/eve-build.mjs after a build made WITH the wrappers.
 * The server runs the definitions bundled into .output, so `npm run sandbox:prewarm` must know that THIS output was
 * built with them: a build made with the setting unset has none, and its specialists would start on eve's defaults
 * however the server is configured. `output` is the build's own identity (.output/nitro.json), so a stamp left over
 * from an earlier build is not mistaken for this one's.
 */
export const stampPath = (appRoot) => join(appRoot, ".output", "sandbox-overlay.json");

const outputIdentity = (appRoot) => {
  try {
    return createHash("sha256").update(readFileSync(join(appRoot, ".output", "nitro.json"))).digest("hex");
  } catch {
    return null;
  }
};

export function writeBuildStamp(appRoot, applied) {
  const output = outputIdentity(appRoot);
  if (!output) return null; // not a command that produced .output (eve dev)
  const stamp = { backend: "microsandbox", output, nodes: applied.map(({ node, slot, authoredSha }) => ({ node, slot, authoredSha })) };
  writeFileSync(stampPath(appRoot), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Why the built agent at `<appRoot>/.output` cannot be trusted to carry the SANDBOX_* settings, or null. `applied`
 * is what {@link applySandboxOverlay} returns for the tree as it is now.
 */
export function buildStampProblem(appRoot, applied) {
  const rebuild = "Run `npm run build:eve` on this server with SANDBOX_BACKEND=microsandbox set, then prewarm again.";
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath(appRoot), "utf8"));
  } catch {
    return `The built agent (.output) was not built with SANDBOX_BACKEND=microsandbox: its specialists' sandboxes would start on eve's defaults (1 vCPU, allow-all egress) whatever the server's settings are. ${rebuild}`;
  }
  if (stamp.backend !== "microsandbox" || stamp.output !== outputIdentity(appRoot)) {
    return `The built agent (.output) is newer than its sandbox stamp: the last build was not made with SANDBOX_BACKEND=microsandbox. ${rebuild}`;
  }
  const now = new Map(applied.map((a) => [a.node, a]));
  for (const built of stamp.nodes ?? []) {
    const current = now.get(built.node);
    if (!current) return `The built agent has a sandbox for ${built.node}, which is no longer in agent/. ${rebuild}`;
    if (current.slot !== built.slot || current.authoredSha !== built.authoredSha) {
      return `The sandbox definition of ${built.node} (${current.authored ?? current.slot}) changed since the agent was built. ${rebuild}`;
    }
  }
  return null;
}

/**
 * Take every wrapper out again and move the authored definitions back. Found by scanning (a wrapper is a slot file
 * that starts with the marker), so it also cleans up after a build that was killed. Returns the slots restored.
 */
export function removeSandboxOverlay(appRoot) {
  const restored = [];
  for (const { dir } of agentNodes(appRoot)) {
    for (const slot of [join(dir, "sandbox", "sandbox.ts"), join(dir, "sandbox.ts")]) {
      const kept = join(slot, "..", AUTHORED);
      if (isWrapper(slot)) {
        rmSync(slot, { force: true });
        restored.push(relative(appRoot, slot));
      }
      // Also the half-applied case: the authored file was moved and the build died before the wrapper was written.
      if (existsSync(kept) && !existsSync(slot)) renameSync(kept, slot);
    }
  }
  return restored;
}

/* ---- self-test -------------------------------------------------------------------------------------------------- */

function selfTest() {
  let passed = 0;
  const failures = [];
  const check = (what, ok, detail) => {
    if (ok) passed++;
    else failures.push(what);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-overlay-selftest-"));
  try {
    const app = join(scratch, "app");
    const put = (file, text) => {
      mkdirSync(join(app, file, ".."), { recursive: true });
      writeFileSync(join(app, file), text);
    };
    const AUTH_A = 'import { defineSandbox } from "eve/sandbox";\nexport default defineSandbox({ async bootstrap() {} });\n';
    put("agent/agent.ts", "x");
    put("agent/sandbox.ts", AUTH_A);
    put("agent/subagents/shorthand/agent.ts", "x");
    put("agent/subagents/shorthand/sandbox.ts", AUTH_A + "// shorthand\n");
    put("agent/subagents/folder/agent.ts", "x");
    put("agent/subagents/folder/sandbox/sandbox.ts", AUTH_A + "// folder\n");
    put("agent/subagents/folder/sandbox/workspace/scripts/a.py", "print(1)\n");
    put("agent/subagents/both/agent.ts", "x");
    put("agent/subagents/both/sandbox.ts", AUTH_A + "// loses\n");
    put("agent/subagents/both/sandbox/sandbox.ts", AUTH_A + "// wins\n");
    put("agent/subagents/seed-only/agent.ts", "x");
    put("agent/subagents/seed-only/sandbox/workspace/x.txt", "x");
    put("agent/subagents/bare/agent.ts", "x");
    put("agent/subagents/bare/prompt.md", "x");
    put("agent/subagents/bare/subagents/README.md", "not a node");
    put("agent/subagents/bare/subagents/nested/agent.ts", "x");
    put("agent/subagents/not-a-node/notes.md", "no agent.ts");
    const snapshot = () => {
      const files = {};
      const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
          const path = join(dir, name);
          if (isDir(path)) walk(path);
          else files[relative(app, path)] = readFileSync(path, "utf8");
        }
      };
      walk(app);
      return JSON.stringify(files);
    };
    const before = snapshot();

    check(
      "every agent node is found: the root, each specialist with an agent.ts, and nested ones; nothing else",
      agentNodes(app).map((n) => n.id).join() === "root,subagents/bare,subagents/bare/subagents/nested,subagents/both,subagents/folder,subagents/seed-only,subagents/shorthand",
      agentNodes(app).map((n) => n.id),
    );

    const applied = applySandboxOverlay(app);
    const by = Object.fromEntries(applied.map((a) => [a.node, a]));
    check("one wrapper per node", applied.length === 7, applied);
    check("a node with NO sandbox definition gets one at sandbox.ts", by["subagents/bare"].slot === "agent/subagents/bare/sandbox.ts" && by["subagents/bare"].authored === null && isWrapper(join(app, by["subagents/bare"].slot)));
    check("…and so does a nested one", by["subagents/bare/subagents/nested"]?.slot === "agent/subagents/bare/subagents/nested/sandbox.ts");
    check("a node with only seed files gets one in the folder layout, beside workspace/", by["subagents/seed-only"].slot === "agent/subagents/seed-only/sandbox/sandbox.ts" && by["subagents/seed-only"].authored === null);
    check(
      "an authored shorthand definition is kept as sandbox.authored.ts and wrapped",
      by["subagents/shorthand"].authored === "agent/subagents/shorthand/sandbox.authored.ts" && readFileSync(join(app, by["subagents/shorthand"].authored), "utf8").endsWith("// shorthand\n") && isWrapper(join(app, "agent/subagents/shorthand/sandbox.ts")),
      by["subagents/shorthand"],
    );
    check("an authored folder-layout definition (what a pack ships) is wrapped in place", by["subagents/folder"].slot === "agent/subagents/folder/sandbox/sandbox.ts" && by["subagents/folder"].authored === "agent/subagents/folder/sandbox/sandbox.authored.ts");
    check("with both layouts the folder one is wrapped, as eve reads that one", by["subagents/both"].slot === "agent/subagents/both/sandbox/sandbox.ts" && readFileSync(join(app, "agent/subagents/both/sandbox.ts"), "utf8").endsWith("// loses\n"));
    check("the root agent's definition is wrapped too", by.root.slot === "agent/sandbox.ts" && by.root.authored === "agent/sandbox.authored.ts");
    const wrapper = readFileSync(join(app, "agent/subagents/folder/sandbox/sandbox.ts"), "utf8");
    check(
      "a wrapper spreads the authored definition and sets backend: microsandbox(microsandboxSettings()), tagged with the settings",
      wrapper.includes('import authored from "./sandbox.authored.js"') && wrapper.includes("...authored, backend: Object.assign(microsandbox(settings)") && wrapper.includes(`Symbol.for("${SETTINGS_TAG}")`) && wrapper.includes('from "#lib/sandbox-settings.js"'),
    );
    const sha = createHash("sha256").update(AUTH_A + "// folder\n").digest("hex");
    check("a wrapper names the authored file's hash, so an edited bootstrap rotates the template", wrapper.includes(`sha256: ${sha}`));
    check("a wrapper for a node with no definition imports no authored file", !readFileSync(join(app, "agent/subagents/bare/sandbox.ts"), "utf8").includes("sandbox.authored"));
    check("seed files are not touched", readFileSync(join(app, "agent/subagents/folder/sandbox/workspace/scripts/a.py"), "utf8") === "print(1)\n");

    const mid = snapshot();
    const again = applySandboxOverlay(app);
    check("applying twice changes nothing (a wrapper is never wrapped)", snapshot() === mid && JSON.stringify(again) === JSON.stringify(applied));

    const restored = removeSandboxOverlay(app);
    check("removing it restores the tree byte for byte", snapshot() === before && restored.length === 7, restored);
    check("removing it again is a no-op", removeSandboxOverlay(app).length === 0 && snapshot() === before);

    // A build killed between the move and the write.
    renameSync(join(app, "agent/subagents/shorthand/sandbox.ts"), join(app, "agent/subagents/shorthand/sandbox.authored.ts"));
    removeSandboxOverlay(app);
    check("a half-applied overlay (authored moved, no wrapper yet) is put back", snapshot() === before);

    // A stray authored file is never overwritten.
    put("agent/subagents/shorthand/sandbox.authored.ts", "mine");
    let clash = null;
    try {
      applySandboxOverlay(app);
    } catch (error) {
      clash = error;
    }
    check("a tree that already has its own sandbox.authored.ts is refused, not overwritten", /both .*sandbox\.ts and .*sandbox\.authored\.ts exist/.test(String(clash?.message)) && readFileSync(join(app, "agent/subagents/shorthand/sandbox.authored.ts"), "utf8") === "mine", String(clash?.message));
    rmSync(join(app, "agent/subagents/shorthand/sandbox.authored.ts"));
    removeSandboxOverlay(app);
    check("…and what was applied before the refusal is undone", snapshot() === before);

    // The build's stamp.
    check("no .output at all: no stamp is written (eve dev)", writeBuildStamp(app, applied) === null && !existsSync(stampPath(app)));
    put(".output/nitro.json", '{"date":"one"}');
    const live = applySandboxOverlay(app);
    check("an output built without the wrappers has no stamp, and that is refused", /was not built with SANDBOX_BACKEND=microsandbox/.test(buildStampProblem(app, live) ?? ""));
    writeBuildStamp(app, live);
    check("a stamped build whose definitions are unchanged is accepted", buildStampProblem(app, live) === null, buildStampProblem(app, live));
    removeSandboxOverlay(app);
    put("agent/subagents/folder/sandbox/sandbox.ts", AUTH_A + "// folder, edited after the build\n");
    check("a definition edited after the build is refused, naming the node", /subagents\/folder .*changed since the agent was built/.test(buildStampProblem(app, applySandboxOverlay(app)) ?? ""));
    removeSandboxOverlay(app);
    put("agent/subagents/folder/sandbox/sandbox.ts", AUTH_A + "// folder\n");
    put(".output/nitro.json", '{"date":"two"}');
    check("a later build made WITHOUT the setting leaves the old stamp behind: refused", /newer than its sandbox stamp/.test(buildStampProblem(app, applySandboxOverlay(app)) ?? ""));
    removeSandboxOverlay(app);
    rmSync(join(app, ".output"), { recursive: true });
    check("the tree is still as it was", snapshot() === before);

    check("SANDBOX_BACKEND: unset, empty and vercel are the default; microsandbox in any case", ["vercel", "vercel", "vercel", "microsandbox"].join() === [{}, { SANDBOX_BACKEND: " " }, { SANDBOX_BACKEND: "Vercel" }, { SANDBOX_BACKEND: " MicroSandbox " }].map(sandboxBackendOf).join());
    let wrong = null;
    try {
      sandboxBackendOf({ SANDBOX_BACKEND: "docker" });
    } catch (error) {
      wrong = error;
    }
    check("an unknown backend is an error, never a fallback", /not supported/.test(String(wrong?.message)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length ? `\nsandbox-overlay --self-test: ${failures.length} FAILED` : `\nsandbox-overlay --self-test: ${passed} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv.includes("--self-test")) selfTest();
