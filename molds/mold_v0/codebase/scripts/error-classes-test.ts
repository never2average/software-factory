// Error classes (src/error-classes.ts): real messages from stored rows, and the order rules between them.
//   npx tsx scripts/error-classes-test.ts
import assert from "node:assert/strict";
import { classifyOrchestrator, classifySession, FIX_LINKS, type SessionLike } from "../src/error-classes.js";

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };
const failed = (error_message: string, extra: Partial<SessionLike> = {}) => classifySession({ status: "failed", error_message, ...extra })?.key;

check("missing provider key, new 424 and old 503 rows", () => {
  const sid = "4f1c2a3b-0d5e-4c6f-9a8b-7e6d5c4b3a21";
  assert.equal(failed(`credentials: POST /api/worker/sessions/${sid}/credentials -> 424: {"error":"No vault provider supplies DASHSCOPE_API_KEY","code":"missing_credential","env":"DASHSCOPE_API_KEY"}`), "credentials");
  assert.equal(failed(`credentials: POST /api/worker/sessions/${sid}/credentials -> 503: {"error":"Internal error"}`), "credentials", "old rows: the masked 503");
  assert.equal(failed("No anthropic credential in the vault"), "credentials");
  assert.deepEqual(FIX_LINKS[classifySession({ status: "failed", error_message: "No vault provider supplies X" })!.fix!], { label: "Key vault", href: "/admin/keys" });
});
check("harness install, gateway token, boat key and capacity", () => {
  assert.equal(failed("harness qwen-code not available in the sandbox (npm install failed)"), "harness_install");
  assert.equal(failed("upstream said: Gateway token is invalid, expired or revoked"), "gateway_token");
  assert.equal(failed("boat runner: 403 api_key_action_forbidden"), "boat_permission");
  assert.equal(failed("boat runner: POST /sandboxes -> 429: rate_limited"), "boat_capacity");
  assert.equal(failed("boat runner: no_ready_machine"), "boat_capacity");
});
check("sandbox boot and prepare", () => {
  assert.equal(failed("boat runner: sandbox sb_1 not ready after 240s"), "sandbox_boot");
  assert.equal(failed("sandbox prepare failed: exit 1"), "sandbox_prepare");
  assert.equal(failed("egress lockdown failed: iptables missing"), "sandbox_prepare");
});
check("heartbeat is checked before the time cap", () => {
  assert.equal(classifySession({ status: "timeout", error_message: "No heartbeat for 10 minutes" })?.key, "heartbeat");
  assert.equal(failed("No heartbeat for 10 minutes; Exceeded MAX_SESSION_MINUTES"), "heartbeat");
  assert.equal(failed("Exceeded MAX_SESSION_MINUTES (45)"), "time_cap");
  assert.equal(classifySession({ status: "timeout", error_message: null })?.key, "time_cap", "a timeout with no message is the time cap");
});
check("infra_error in metadata is read too", () => {
  assert.equal(classifySession({ status: "failed", error_message: null, metadata: { infra_error: "No heartbeat for 12 minutes" } })?.key, "heartbeat");
});
check("shutdown, agent stopped, other", () => {
  assert.equal(failed("Worker shut down"), "shutdown");
  assert.equal(classifySession({ status: "completed", completed_reason: "agent_gave_up" })?.key, "agent");
  assert.equal(classifySession({ status: "failed", error_message: "exit 1", completed_reason: "error" })?.key, "agent");
  assert.equal(failed("something nobody has seen"), "other");
});
check("nothing to explain: done, running, claimable, requeued", () => {
  assert.equal(classifySession({ status: "completed", completed_reason: "done" }), null);
  assert.equal(classifySession({ status: "running" }), null);
  assert.equal(classifySession({ status: "queued", agent_id: "codex/default" }, { scheduled: new Set(["codex/default"]) }), null);
  assert.equal(classifySession({ status: "queued", agent_id: "codex/default", metadata: { infra_error: "boat runner: ECONNRESET" } }), null);
  assert.equal(classifySession({ status: "cancelled", error_message: "cancelled" }), null);
});
check("queued on an agent the population does not schedule is unclaimable", () => {
  const c = classifySession({ status: "queued", agent_id: "ide-only/x" }, { scheduled: new Set(["codex/default"]) });
  assert.equal(c?.key, "unclaimable");
  assert.equal(FIX_LINKS[c!.fix!].href, "/admin/agents", "Harness mix");
  assert.equal(classifySession({ status: "queued", agent_id: "ide-only/x" }), null, "without the population, not judged");
});
check("orchestrator: launch steps from the split columns and from the legacy error", () => {
  assert.deepEqual(classifyOrchestrator({ launch_step: "preflight", launch_error: "exit 2" }), { key: "launch:preflight", label: "Launch failed at preflight", routine: false, message: "exit 2" });
  assert.equal(classifyOrchestrator({ error: "code upload (31s): PUT /files -> 413", ready_at: null })?.key, "launch:code upload");
  assert.equal(classifyOrchestrator({ error: "code upload (31s): PUT /files -> 413" })?.message, "PUT /files -> 413");
  assert.equal(classifyOrchestrator({ error: "ready (240s): not ready", ready_at: new Date() })?.key, "reap:other", "a ready orchestrator did not fail its launch");
});
check("orchestrator: reap reasons normalized, routine ones marked", () => {
  const reap = (r: string) => classifyOrchestrator({ reap_reason: r });
  assert.equal(reap("stale: no fleet check-in for 5 min")?.key, "reap:stale");
  assert.equal(reap("stuck booting > 10 min")?.key, "reap:stuck_booting");
  assert.equal(reap("TTL about to expire")?.key, "reap:ttl");
  assert.equal(reap("sandbox gone from boat")?.key, "reap:sandbox_gone");
  assert.equal(reap("sandbox is archived")?.key, "reap:sandbox_gone");
  assert.equal(reap("launch never created a sandbox")?.key, "reap:never_created");
  for (const [r, k] of [["drained (idle exit)", "idle_drain"], ["drained (job sim_1 over or idle)", "job_drain"],
                        ["retired: launched before this deploy (old code)", "retired"], ["job rsh_9 is completed", "job_ended"]]) {
    assert.equal(reap(r)?.key, `reap:${k}`); assert.equal(reap(r)?.routine, true, r);
  }
  assert.equal(reap("stale: no fleet check-in for 5 min")?.routine, false);
  assert.equal(classifyOrchestrator({ error: "stale: no fleet check-in for 5 min" })?.key, "reap:stale", "legacy column");
  assert.equal(classifyOrchestrator({}), null);
});
console.log(`error classes: ${n} checks passed`);
