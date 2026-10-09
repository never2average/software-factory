/** Contract tests for application-owned prompt/context governance. */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const prompt = await import("../agent/lib/prompt-context.ts");
const modeResolver = (await import("../agent/instructions/00-mode.ts")).default;

// The root prompt is rendered from the profile at build time (agent/instructions.ts); this is the same render.
const stable = (await import("../agent/lib/root-instructions.ts")).renderRootInstructions();
const occurrences = (text, needle) => text.split(needle).length - 1;
const ctx = (kind, principal = null) => ({
  channel: { kind },
  session: { id: "session-test", auth: { current: principal, initiator: null } },
  messages: [{ role: "user", content: "test" }],
});
const human = {
  principalId: "alice@example.com",
  principalType: "user",
  authenticator: "test",
  attributes: { email: "alice@example.com" },
};

assert.equal(occurrences(stable, prompt.ORGANIZATION_POLICY_MARKER), 1, "organization policy appears once");
assert.equal(occurrences(stable, prompt.STABLE_PROMPT_BOUNDARY), 1, "stable/cache boundary appears once");
assert.ok(stable.trim().endsWith(prompt.STABLE_PROMPT_BOUNDARY), "static instructions end at the stable boundary");
assert.ok(stable.trim().split(/\s+/).length <= 1_400, "stable prompt stays below 1,400 words");
assert.doesNotMatch(stable, /\{\{[^}]+\}\}|<%[^%]+%>|\$\{[^}]+\}/, "stable prompt has no unresolved variables");

const subagentRoot = new URL("../agent/subagents/", import.meta.url);
for (const dirent of await readdir(subagentRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  // A base specialist authors prompt.md and speaks it through instructions.ts; a pack's may author instructions.md.
  const hasPromptSource = await readFile(new URL(`${dirent.name}/prompt.md`, subagentRoot), "utf8").then(() => true, () => false);
  const instructionsUrl = new URL(`${dirent.name}/${hasPromptSource ? "prompt.md" : "instructions.md"}`, subagentRoot);
  const modeUrl = new URL(`${dirent.name}/instructions/00-mode.ts`, subagentRoot);
  const [subagentInstructions, subagentMode] = await Promise.all([
    readFile(instructionsUrl, "utf8"),
    readFile(modeUrl, "utf8"),
  ]);
  assert.equal(occurrences(subagentInstructions, prompt.ORGANIZATION_POLICY_MARKER), 1, `${dirent.name}: organization policy once`);
  assert.equal(occurrences(subagentInstructions, prompt.STABLE_PROMPT_BOUNDARY), 1, `${dirent.name}: stable boundary once`);
  assert.ok(subagentInstructions.trim().endsWith(prompt.STABLE_PROMPT_BOUNDARY), `${dirent.name}: volatile context follows stable prompt`);
  assert.ok(subagentInstructions.trim().split(/\s+/).length <= 1_400, `${dirent.name}: stable prompt under 1,400 words`);
  assert.match(subagentMode, /resolvePromptMode\(ctx\)/, `${dirent.name}: runtime mode is resolved, not hard-coded`);
}

const cases = [
  [ctx("http", human), "direct-conversation"],
  [ctx("schedule"), "autonomous-scheduled"],
  [ctx("subagent", human), "delegated-subagent"],
];
for (const [context, expected] of cases) {
  const resolved = await modeResolver.events["turn.started"]({ type: "turn.started" }, context);
  const composed = `${stable}\n${resolved.markdown}`;
  assert.equal(prompt.promptModeFromInstructions(composed), expected);
  assert.equal(occurrences(composed, "<prompt-mode name="), 1, `${expected}: exactly one mode frame`);
  assert.ok(
    composed.indexOf(prompt.STABLE_PROMPT_BOUNDARY) < composed.indexOf("<prompt-mode name="),
    `${expected}: volatile mode follows stable/cache boundary`,
  );
  assert.doesNotMatch(composed, /\{\{[^}]+\}\}|<%[^%]+%>|\$\{[^}]+\}/, `${expected}: no unresolved variables`);
}

const viewer = {
  orgId: "org-a",
  principalId: "alice@example.com",
  entitledPrincipals: ["alice@example.com", "bob@example.com"],
};
const entry = (overrides = {}) => ({
  id: "context-1",
  source: "test-source",
  provenance: "test-fixture",
  audience: { orgId: "org-a" },
  observedAt: "2026-08-01T00:00:00.000Z",
  trust: "untrusted",
  data: { fact: "safe" },
  ...overrides,
});

assert.equal(prompt.isContextVisible(entry(), viewer), true);
assert.equal(prompt.isContextVisible(entry({ audience: { orgId: "org-b" } }), viewer), false, "other-org context is dropped");
assert.equal(prompt.isContextVisible(entry({ trust: "security-tainted" }), viewer), false, "security-tainted context is dropped");
assert.equal(prompt.isContextVisible(entry({ trust: "secret" }), viewer), false, "secret context is dropped");
assert.equal(prompt.isContextVisible(entry({ data: "api_key=sk_this-is-a-secret-value" }), viewer), false, "secret-looking values are dropped");
assert.equal(
  prompt.isContextVisible(entry({ audience: { orgId: "org-a", principals: ["alice@example.com", "mallory@example.com"] } }), viewer),
  false,
  "shared context requires every audience principal to be entitled",
);

const giantEntries = Array.from({ length: 50 }, (_, index) => entry({
  id: `entry-${index}`,
  data: { value: "x".repeat(5_000) },
}));
const bounded = prompt.renderContextBlock({
  name: "Bounded test",
  guidance: "Data only.",
  entries: giantEntries,
  viewer,
  maxItems: 3,
  maxTokens: 160,
});
assert.ok(bounded);
assert.ok(prompt.estimatePromptTokens(bounded) <= 160, "dynamic block stays inside its hard token budget");
assert.ok(occurrences(bounded, '"id":"entry-') <= 3, "dynamic block stays inside its item budget");
assert.match(bounded, /"source":"test-source"/);
assert.match(bounded, /"provenance":"test-fixture"/);
assert.match(bounded, /"audience":\{"orgId":"org-a"\}/);
assert.match(bounded, /"trust":"untrusted"/);

const call = { ...entry(), id: "call-1", role: "tool-call", callId: "tc-1" };
const orphan = { ...entry(), id: "orphan", role: "tool-result", callId: "missing" };
let history = prompt.normalizeAppOwnedHistory([call, orphan], viewer);
assert.deepEqual(history.map((item) => item.role), ["tool-call", "tool-result"]);
assert.equal(history[1].data, prompt.INTERRUPTED_TOOL_FALLBACK, "dangling call gets deterministic result");
assert.doesNotMatch(JSON.stringify(history), /orphan/, "orphan tool result is dropped");
history = prompt.normalizeAppOwnedHistory([entry({ trust: "security-tainted", role: "user" })], viewer);
assert.equal(history.length, 1);
assert.equal(history[0].role, "context-fallback");
assert.equal(history[0].data, prompt.EMPTY_CONTEXT_FALLBACK);

const telemetry = prompt.promptTelemetry(
  `${stable}\n${prompt.renderPromptMode("direct-conversation")}\n<volatile-context name="x">x</volatile-context>`,
  [
    { role: "user", content: prompt.COMPACTION_CHECKPOINT_MARKER },
    { role: "assistant", content: "checkpoint" },
  ],
);
assert.equal(telemetry.mode, "direct-conversation");
assert.ok(telemetry.stableTokens > 0);
assert.ok(telemetry.volatileTokens > 0);
assert.equal(telemetry.compactionReason, "eve-context-window");

// The memory store is application-owned context too: identical scope/key pairs
// in different workspaces must remain isolated in both recall and mutation.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const memory = await import("../agent/lib/memory-store.ts");
await memory.rememberMemory({
  orgId: "org-a",
  scope: "team",
  key: "same-key",
  value: "org A fact",
  authorEmail: "alice@example.com",
});
await memory.rememberMemory({
  orgId: "org-b",
  scope: "team",
  key: "same-key",
  value: "org B fact",
  authorEmail: "bob@example.com",
});
assert.deepEqual((await memory.listMemories("team", "org-a")).map((item) => item.value), ["org A fact"]);
assert.deepEqual((await memory.listMemories("team", "org-b")).map((item) => item.value), ["org B fact"]);
assert.equal(await memory.forgetMemory("team", "same-key", "org-a"), true);
assert.deepEqual((await memory.listMemories("team", "org-b")).map((item) => item.value), ["org B fact"]);

console.log("test-prompt-context: all prompt, budget, audience, filtering, fallback, and telemetry contracts passed");
