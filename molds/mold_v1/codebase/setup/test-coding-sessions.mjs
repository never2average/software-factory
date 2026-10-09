/**
 * Tests for the coding-session spike: redaction is airtight, and the parser
 * turns a real transcript into compact signal with nothing sensitive in it.
 *
 *   node setup/test-coding-sessions.mjs
 *
 * Uses `node --experimental-strip-types` under the hood via a dynamic import of
 * the .ts module — the same trick the other agent-lib scripts use.
 */
import assert from "node:assert";

const { redactSecrets, parseClaudeTranscript, sessionToSyncItem } = await import(
  "../agent/lib/coding-sessions.ts"
);

let passed = 0;
function ok(name, cond, detail = "") {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok   ${name}`);
}

/* ------------------------------------------------------------------ redaction */

// [name, raw-input, the exact sensitive substring that MUST be gone afterwards]
const secrets = [
  ["slack bot token", "xoxb-123456789012-abcdefghijklmnop", "abcdefghijklmnop"],
  ["github pat", "ghp_" + "a".repeat(36), "ghp_" + "a".repeat(36)],
  ["openai key", "sk-" + "a".repeat(40), "sk-" + "a".repeat(40)],
  ["anthropic key", "sk-ant-" + "c".repeat(40), "sk-ant-" + "c".repeat(40)],
  ["aws access key", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["google key", "AIza" + "b".repeat(35), "AIza" + "b".repeat(35)],
  ["jwt", "eyJhbGciOiJItsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpM", "SflKxwRJSMeKKF2QT4fwpM"],
  ["bearer header", "Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef"],
  ["postgres url", "postgres://admin:s3cr3tpw@db.example.com:5432/app", "s3cr3tpw"],
  ["env assignment", 'SLACK_BOT_TOKEN="xoxb-should-not-survive-here"', "should-not-survive-here"],
  ["json secret", '"api_key": "livesecret12345"', "livesecret12345"],
];

for (const [name, raw, sensitive] of secrets) {
  const out = redactSecrets(`before ${raw} after`);
  ok(`redacts ${name}`, out.includes("[redacted") && !out.includes(sensitive), out);
}

ok(
  "leaves ordinary text alone",
  redactSecrets("Deployed the config panel to prod and fixed the token font size") ===
    "Deployed the config panel to prod and fixed the token font size",
);

/* --------------------------------------------------------------------- parser */

const transcript = [
  JSON.stringify({ type: "ai-title", aiTitle: "Fix the deploy pipeline", sessionId: "sess-1" }),
  JSON.stringify({ type: "user", sessionId: "sess-1", cwd: "/Users/alex/acme-platform", gitBranch: "main", timestamp: "2026-07-14T10:00:00Z", message: { role: "user", content: "This session is being continued from a previous conversation…" } }),
  JSON.stringify({ type: "user", timestamp: "2026-07-14T10:01:00Z", message: { role: "user", content: [{ type: "text", text: "Deploy acme to prod with token ghp_" + "z".repeat(36) }] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-07-14T10:02:00Z", message: { role: "assistant", content: [
    { type: "tool_use", name: "Bash", input: { command: "vercel deploy --prod --token xoxb-111-secretsecret" } },
    { type: "tool_use", name: "Edit", input: { file_path: "/Users/alex/acme-platform/vercel.json" } },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-07-14T10:05:00Z", message: { role: "assistant", content: [
    { type: "tool_use", name: "Bash", input: { command: "git push origin main" } },
    { type: "tool_use", name: "Write", input: { file_path: "/Users/alex/acme-platform/README.md" } },
  ] } }),
  "   ",
  "{ this is not json",
].join("\n");

const s = parseClaudeTranscript(transcript, "fallback");
ok("parses the session id", s.sessionId === "sess-1", s.sessionId);
ok("derives the repo from cwd", s.repo === "acme-platform", String(s.repo));
ok("keeps the branch", s.branch === "main");
ok("keeps the agent title", s.title === "Fix the deploy pipeline");
ok("skips the continue-preamble and takes the real ask", s.opening?.startsWith("Deploy acme to prod"), s.opening);
ok("REDACTS the secret in the opening ask", !s.opening?.includes("ghp_"), s.opening);
ok("spans first→last timestamp", s.startedAt === "2026-07-14T10:00:00Z" && s.endedAt === "2026-07-14T10:05:00Z");
ok("counts the human turns", s.userTurns === 2, String(s.userTurns));
ok("counts tools", s.tools.Bash === 2 && s.tools.Edit === 1 && s.tools.Write === 1, JSON.stringify(s.tools));
ok("collects files touched", s.filesTouched.includes("/Users/alex/acme-platform/vercel.json"));
ok("keeps only command HEADS, not payloads", s.commandHeads.includes("vercel deploy") && s.commandHeads.includes("git push"), JSON.stringify(s.commandHeads));
ok("no secret survives anywhere in the summary", !JSON.stringify(s).includes("secretsecret") && !JSON.stringify(s).includes("ghp_zzz"), JSON.stringify(s).slice(0, 200));
ok("tolerates blank and non-JSON lines", true);

const item = sessionToSyncItem(s);
ok("the sync item carries id = sessionId for dedupe", item.id === "sess-1");

console.log(`\n${passed} checks passed.`);
