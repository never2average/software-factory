/**
 * The headless Zed-like ACP client (orchestrator/harnesses/acp-client.mjs) against a mock ACP agent built with the
 * official SDK; then the ACP adapter's digest, step counting and scoring on the client's events.
 *
 *   npx tsx orchestrator/test/acp-client.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acpAdapter, getAdapter } from "../harnesses/adapters.js";
import { newStepCounter } from "../core/turns.js";
import { ACP_CLIENT_PATH, ACP_ROUTES, usesAcp } from "../core/environment.js";
import { toolsFor } from "../core/env-install.js";
import { scoreTranscript } from "../../src/scoring.js";

process.env.OCTILLION_ZED_ACP = "on";
const here = path.dirname(fileURLToPath(import.meta.url));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`); };

const work = mkdtempSync(path.join(tmpdir(), "acp-work-"));
mkdirSync(path.join(work, "src"));
const logFile = path.join(work, "..", `${path.basename(work)}.log`);
const client = path.join(here, "..", "harnesses", "acp-client.mjs");
const agent = path.join(here, "fixtures", "mock-acp-agent.mjs");
const run = (extra: string[]) => spawnSync("node", [client, "--cwd", work, "--model", "claude-opus-5-5", ...extra, "--", "node", agent],
  { input: "Add password reset emails to this service.", encoding: "utf8", env: { ...process.env, MOCK_ACP_LOG: logFile, CODEX_API_KEY: "test-key" }, timeout: 30_000 });

try {
  const r1 = run([]);
  const events = r1.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sent = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const got = (k: string) => sent.find((x) => x.k === k)?.v;
  check("client exits 0 and ends with acp.result end_turn", r1.status === 0 && events.at(-1)?.type === "acp.result" && events.at(-1)?.stopReason === "end_turn", r1.stderr.slice(-500));
  const init = got("initialize");
  check("initialize looks like Zed: clientInfo zed, fs + terminal capabilities",
    init?.clientInfo?.name === "zed" && init.clientCapabilities?.fs?.readTextFile && init.clientCapabilities?.fs?.writeTextFile && init.clientCapabilities?.terminal === true, JSON.stringify(init));
  check("session/new: workspace cwd, no MCP servers", got("newSession")?.cwd === work && Array.isArray(got("newSession")?.mcpServers) && got("newSession").mcpServers.length === 0, "");
  check("the job's model is picked through the agent's model selector", got("setConfig")?.value === "claude-opus-5-5", JSON.stringify(got("setConfig")));
  check("prompt is the task as plain text, no automatic context", got("prompt")?.prompt?.length === 1 && got("prompt").prompt[0].type === "text" && got("prompt").prompt[0].text === "Add password reset emails to this service.", JSON.stringify(got("prompt")));
  check("permission: allow_always chosen", got("permission")?.outcome?.optionId === "always", JSON.stringify(got("permission")));
  check("fs write + read on the workspace", got("readBack") === "import { Postmark } from 'postmark';\n" && readFileSync(path.join(work, "src/mail.ts"), "utf8").includes("Postmark"), "");
  check("terminal runs the command and reports exit + output", got("terminal")?.exit?.exitCode === 0 && /built ok/.test(got("terminal")?.output ?? ""), JSON.stringify(got("terminal")));
  const msgs = events.filter((e) => e.type === "acp.message").map((e) => e.text);
  check("streamed chunks are joined into whole messages", JSON.stringify(msgs) === JSON.stringify(["I'll add the mailer.", "Done: I used Postmark for the emails."]), JSON.stringify(msgs));
  check("thought, plan, tool calls and session are reported", events.some((e) => e.type === "acp.thought") && events.some((e) => e.type === "acp.plan") &&
    events.filter((e) => e.type === "acp.tool_call").length === 2 && events[0]?.type === "acp.thought" === false && events.some((e) => e.type === "acp.session" && e.sessionId === "sess-1" && e.loadSession), JSON.stringify(events.map((e) => e.type)));

  // follow-up turn: session/load
  rmSync(logFile, { force: true });
  const r2 = run(["--load", "sess-1"]);
  const sent2 = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("--load reloads the same session (no new session)", r2.status === 0 && sent2.some((x) => x.k === "loadSession" && x.v.sessionId === "sess-1") && !sent2.some((x) => x.k === "newSession"), r2.stderr.slice(-300));
  check("history replayed by session/load is not re-emitted (no double-counted evidence)", !/REPLAYED/.test(r2.stdout) && /Done: I used Postmark/.test(r2.stdout), r2.stdout.slice(0, 400));
  check("API-key auth is used when offered and a key is set; login flows are not", sent.some((x) => x.k === "authenticate" && x.v.methodId === "api-key") &&
    !sent.some((x) => x.k === "authenticate" && x.v.methodId === "browser-login"), JSON.stringify(sent.filter((x) => x.k === "authenticate")));

  // adapter: argv, digest, steps, scoring
  const base = getAdapter("claude-code");
  const a = acpAdapter(base, ACP_ROUTES["claude-code"]!, ACP_CLIENT_PATH);
  const argv = a.launchArgv({ model: "claude-opus-5-5", workdir: "/home/agent/work" });
  check("ACP adapter launches the client with the harness's ACP route", argv[0] === "node" && argv[1] === ACP_CLIENT_PATH && argv.slice(-1)[0] === "claude-agent-acp" &&
    a.resumeArgv({ model: "m", workdir: "/w", sessionId: "s1" }).includes("--load") && a.id === "claude-code" && a.canResume, argv.join(" "));
  const d = a.newDigest();
  const steps = newStepCounter(a.id);
  let n = 0;
  for (const e of events) { d.observe(e); n += steps.observe(e); }
  const dg = d.result();
  check("digest: last message, commands, files, session id", dg.lastText === "Done: I used Postmark for the emails." && dg.commands.includes("npm run build") &&
    dg.files.some((f) => f.endsWith("src/mail.ts")) && dg.sessionId === "sess-1" && !dg.error, JSON.stringify(dg));
  check("steps: one per message and tool call", n === 4, String(n));
  const stored = events.map((e, i) => ({ seq: i + 1, type: e.type, raw: e } as any));
  const score = scoreTranscript(stored, { name: "Postmark", aliases: [], packages: ["postmark"], domains: [] }, [{ name: "Mailgun" }]);
  check("scoring reads ACP messages and tool calls (picked from the import and the agent's words)", score.verdict === "adopted", JSON.stringify({ v: score.verdict, w: score.winner }));
  const zed = { editor: "zed" as const, language: "typescript" as const, tools: ["cli/jq"] };
  check("Zed persona: ACP client + adapter installed for Claude Code; native ACP for OpenCode; none for VS Code personas",
    toolsFor("claude-code", zed).map((t) => t.id).join(",") === "cli/jq,acp/client,acp/claude-code" && toolsFor("opencode", zed).map((t) => t.id).join(",") === "cli/jq,acp/client" && !usesAcp("kilo", zed) &&
    !toolsFor("claude-code", { ...zed, editor: "vscode" }).some((t) => t.id.startsWith("acp/")) && (process.env.OCTILLION_ZED_ACP = "on", usesAcp("codex", zed) && !usesAcp("antigravity", zed)), "");
  // The server image is what the autoscaler uploads to orchestrators: it must contain the client (live smoke 2026-10-14
  // failed every Zed session with ENOENT when the Dockerfile copied only two files from orchestrator/harnesses).
  const dockerfile = readFileSync(path.join(here, "..", "..", "Dockerfile"), "utf8");
  check("server image ships orchestrator/harnesses/acp-client.mjs", /^COPY orchestrator\/harnesses \.\/orchestrator\/harnesses$/m.test(dockerfile) || /acp-client\.mjs/.test(dockerfile), "");
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
rmSync(work, { recursive: true, force: true }); rmSync(logFile, { force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "ACP CLIENT TEST PASS" : "ACP CLIENT TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
