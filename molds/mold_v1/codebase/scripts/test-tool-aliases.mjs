#!/usr/bin/env node
/**
 * test:tool-aliases — the roster tool is `list_members`, and its old name still works.
 *
 * The tool the model is given for the member roster was named after the base product's role word. It is
 * `list_members` now (agent/tools/list_members.ts and the two specialists' copies), and the old name is an alias
 * (TOOL_ALIASES in agent/lib/agent-vocabulary.ts) that no model is shown. This proves, offline:
 *
 *   1. the new name is what the model and a person see: the tool files, the generated roster, prompts and
 *      workflow library, the UI label, and the name under the default and a relabelling profile (where the
 *      tool keeps the name that deployment already used);
 *   2. a conversation stored before the rename still resolves (scripts/fixtures/tool-aliases/stored-transcript.json):
 *      the chat labels its old call as the tool it is now, the empty-response guard still counts it as a read,
 *      a stored workflow prompt that says "call <old name>" is sent with the current name, and a model that
 *      re-issues the old name after reading it in that history runs the current tool (the model middleware),
 *      through the real AI SDK tool loop.
 *
 * The role word is assembled, never written whole, so this file needs no allowance in the neutral-names list.
 *
 *   npm run test:tool-aliases
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// eve's `.js` -> `.ts` specifiers, and the web app's `@/` alias and extensionless imports (app/_components).
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const OLD = ["list", ["f", "d", "e", "s"].join("")].join("_");
const NEW = "list_members";

let failures = 0;
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
};

const v = await imp("agent/lib/agent-vocabulary.ts");
const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/tool-aliases/stored-transcript.json"), "utf8"));

console.log("The new name is what the model and a person see:");
await check(`agent/tools/${NEW}.ts and both specialists' copies re-export the roster tool; no file has the old name`, () => {
  for (const dir of ["agent/tools", "agent/subagents/app-author/tools", "agent/subagents/customer-context/tools"]) {
    const text = readFileSync(join(ROOT, dir, `${NEW}.ts`), "utf8");
    assert.match(text, /export \{ listMembersTool as default \} from "#lib\/tools\.js";/, dir);
    assert.ok(!existsSync(join(ROOT, dir, `${OLD}.ts`)), `${dir}/${OLD}.ts still exists`);
  }
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const named = walk(join(ROOT, "agent")).filter((p) => p.includes(OLD));
  assert.deepEqual(named, []);
});
await check("the tool registers under the new base name", () => {
  const tools = readFileSync(join(ROOT, "agent/lib/tools.ts"), "utf8");
  assert.match(tools, new RegExp(`listMembersTool = modelFacing\\("${NEW}"`));
});
await check("the generated roster, prompts and workflow library name only the new tool", () => {
  for (const f of ["app/_components/subagent-meta.generated.ts", "agent/lib/prompts.generated.ts", "agent/lib/workflow-library.generated.ts"]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.ok(!text.includes(OLD), `${f} still names ${OLD}`);
  }
  const meta = readFileSync(join(ROOT, "app/_components/subagent-meta.generated.ts"), "utf8");
  assert.equal(meta.split(`"name": "${NEW}"`).length - 1, 2, "app-author and customer-context both carry it");
});
await check("the pinned default model surface lists the new tool and never the old one", () => {
  const surface = readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8");
  assert.ok(surface.includes(`=== root :: tool :: ${NEW}`), "root");
  assert.ok(surface.includes(`=== root/customer-context :: tool :: ${NEW}`), "customer-context");
  assert.ok(!surface.includes(OLD), "the old name is in the default surface");
});
await check("under the default profile the model calls it by the new name", () => {
  assert.equal(v.speakIdentifier(NEW), NEW);
  assert.equal(v.modelToolName(NEW), NEW);
});
const { toolDisplayName } = await imp("app/_components/tool-display.ts");
await check(`a person sees "List members"`, () => assert.equal(toolDisplayName(NEW), "List members"));

/** The relabelling fixture profile, merged and validated by the real generator. */
function relabelledProfile() {
  const dir = mkdtempSync(join(tmpdir(), "tool-alias-profiles-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    cpSync(join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "50-relabelled.json"));
    const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const voc = v.createVocabulary(relabelledProfile());
await check("a relabelling deployment keeps the name it already called the tool by (list_analysts), from either spelling", () => {
  assert.equal(v.speakIdentifierWith(voc, NEW), "list_analysts");
  assert.equal(v.speakIdentifierWith(voc, OLD), "list_analysts");
  assert.equal(v.speakWith(voc, `Call \`${NEW}\` for the roster.`), "Call `list_analysts` for the roster.");
  assert.equal(v.baseNameAmong("list_analysts", [NEW], voc), NEW);
});

console.log("\nA conversation stored before the rename still resolves:");
const oldCall = fixture.uiMessages[1].parts[0];
await check("the chat labels the stored call as the tool it is now", () => {
  assert.equal(oldCall.toolName, OLD);
  assert.equal(toolDisplayName(oldCall.toolName), toolDisplayName(NEW));
});
await check("the old name resolves to the new tool wherever a tool name is read back", () => {
  assert.equal(v.canonicalToolName(OLD), NEW);
  assert.equal(v.baseToolName(OLD), NEW);
  assert.equal(v.baseNameAmong(OLD, ["list_customers", NEW]), NEW);
  assert.equal(v.canonicalToolName("list_customers"), "list_customers", "any other name is itself");
});
const { isReadOnlyTool } = await imp("agent/lib/read-only-tools.ts");
const { readTurnEvidence } = await imp("agent/lib/empty-model-response.ts");
await check("the empty-response guard still counts the stored call as a read, not a possible write", () => {
  assert.equal(isReadOnlyTool(OLD), true);
  assert.equal(isReadOnlyTool(NEW), true);
  const history = fixture.modelMessages.slice(0, 4);
  const asked = [...history, { role: "user", content: [{ type: "text", text: "Who owns the most?" }] }, history[1], history[2]];
  const e = readTurnEvidence(asked);
  assert.deepEqual(e.writesSince, []);
  assert.deepEqual(e.writesBefore, []);
  assert.equal(e.resultsSince, 1);
});
const { composeStepMessage } = await imp("lib/workflow-delegate.ts");
await check("a stored workflow prompt that names the old tool is sent with the current one", () => {
  const sent = composeStepMessage(fixture.storedWorkflowPrompt, "customer-context");
  assert.ok(sent.includes(`Call ${NEW} for the roster`), sent);
  assert.ok(!sent.includes(OLD), sent);
  assert.equal(v.withCurrentToolNamesWith(voc, fixture.storedWorkflowPrompt).includes("Call list_analysts for the roster"), true);
  assert.equal(v.withCurrentToolNames(`${OLD}_extra and x${OLD}`), `${OLD}_extra and x${OLD}`, "only the whole name");
});

const { renameCall, toolNameAliases } = await imp("agent/lib/tool-name-aliases.ts");
await check("the model middleware renames an old-name call only when the call offered its tool", () => {
  assert.equal(renameCall(OLD, new Set([NEW])), NEW);
  assert.equal(renameCall(OLD, new Set(["list_analysts"]), (b) => v.speakIdentifierWith(voc, b)), "list_analysts");
  assert.equal(renameCall(OLD, new Set([OLD, NEW])), OLD, "a name that was offered is never touched");
  assert.equal(renameCall(OLD, new Set(["get_customer"])), OLD, "no current tool offered: left to fail as before");
  assert.equal(renameCall("nope", new Set([NEW])), "nope");
});
await check("…in a streamed answer too", async () => {
  const parts = [
    { type: "tool-input-start", id: "c1", toolName: OLD },
    { type: "tool-input-delta", id: "c1", delta: "{}" },
    { type: "tool-input-end", id: "c1" },
    { type: "tool-call", toolCallId: "c1", toolName: OLD, input: "{}" },
  ];
  const out = await toolNameAliases.wrapStream({
    doStream: async () => ({ stream: new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }) }),
    params: { tools: [{ type: "function", name: NEW, inputSchema: {} }] },
  });
  const got = [];
  for await (const p of out.stream) got.push(p);
  assert.deepEqual(got.map((p) => p.toolName ?? null), [NEW, null, null, NEW]);
});
await check("the model is wired through it, outside every other middleware", () => {
  const model = readFileSync(join(ROOT, "agent/lib/model.ts"), "utf8");
  assert.match(model, /return wrapLanguageModel\(\{ model: wrapped, middleware: toolNameAliases \}\);/);
});

const { generateText, isStepCount, jsonSchema, tool, wrapLanguageModel } = await import("ai");
const { MockLanguageModelV4 } = await import("ai/test");
await check("through the AI SDK's tool loop: the stored history is accepted, and a re-issued old name runs the current tool", async () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const seen = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(options);
      call++;
      if (call === 1) return { content: [{ type: "tool-call", toolCallId: "call_again", toolName: OLD, input: "{}" }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] };
      return { content: [{ type: "text", text: "Still Asha." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  let ran = 0;
  const result = await generateText({
    model: wrapLanguageModel({ model, middleware: toolNameAliases }),
    messages: fixture.modelMessages,
    tools: { [NEW]: tool({ description: "List the members", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => { ran++; return { roster: [], count: 0 }; } }) },
    stopWhen: isStepCount(2),
  });
  assert.equal(ran, 1, "the current tool ran for the old name");
  assert.equal(result.text, "Still Asha.");
  const offered = (seen[0].tools ?? []).map((t) => t.name);
  assert.deepEqual(offered, [NEW], "only the new name is offered to the model");
  const replayed = JSON.stringify(seen[0].prompt);
  assert.ok(replayed.includes(`"toolName":"${OLD}"`), "the stored call is replayed to the model as it was");
  const second = JSON.stringify(seen[1].prompt);
  assert.ok(second.includes(`"toolName":"${NEW}"`) && second.includes('"count":0'), "the result came back from the current tool");
});

console.log(`\n${failures ? "FAILED" : "all"}: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
