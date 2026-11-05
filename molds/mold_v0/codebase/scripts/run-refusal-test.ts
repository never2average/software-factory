// Provider-safe CLI settings and the refused-before-spend retry (mold_v0-189; src/provider-safe-env.ts, src/gateway.ts
// brokerRunCredentials, src/runs.ts complete, src/run-harness.ts), offline: an embedded database, the real gateway in
// front of a stand-in Google Cloud Vertex AI (its token endpoint and Claude's rawPredict) that refuses
// `context_management` exactly as Vertex did on 2026-11-01 ("400 context_management: Extra inputs are not permitted").
//   npm run test:run-refusal
//
//  1. The settings, as functions: which upstream counts as Anthropic's own API; what each provider's runs get; what
//     counts as refused before any spend.
//  2. A run whose Claude provider is served from Vertex: its claim carries CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 and
//     the quiet settings; a CLI that honours it sends no context_management and succeeds.
//  3. A CLI that sends context_management anyway (one before the setting, or that ignores it): its attempt is refused
//     before a token is spent, so the run is queued once more, with a model_refused_retry event, though its kind has
//     max_attempts 1; the next attempt (Vertex accepting again) succeeds.
//  4. Refused on every attempt: retried once only, then failed.
//  5. Not retried: a run that spent tokens and then failed; a cancelled run.
//  6. A Claude provider served from api.anthropic.com with its own key: the quiet settings, the betas left on.
//  7. With RUN_REFUSAL_CLAUDE_BINS (paths of real Claude Code binaries, colon-separated): each one, through the real
//     gateway to the stand-in Vertex, succeeds with the run's settings; with the betas setting removed, a version that
//     does not fall back (2.1.303 and older) fails with Vertex's 400 and a newer one recovers.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
try {
  const pse = await import("../src/provider-safe-env.js");

  // ---------- 1. the settings, as functions ----------
  {
    const direct = { backend: "direct" as const, upstream_url: "https://api.anthropic.com" };
    assert.equal(pse.anthropicFirstParty(direct, true), true, "api.anthropic.com with its own key: Anthropic's own API");
    assert.equal(pse.anthropicFirstParty(direct, false), false, "no key of its own: the gateway falls back to Vertex");
    assert.equal(pse.anthropicFirstParty({ backend: "vertex", upstream_url: "https://api.anthropic.com" }, true), false, "a Vertex backend");
    assert.equal(pse.anthropicFirstParty({ backend: "direct", upstream_url: "https://llm-proxy.example" }, true), false, "another upstream");
    assert.equal(pse.anthropicFirstParty({ backend: "direct", upstream_url: null }, true), false);
    assert.deepEqual(pse.providerSafeEnv("anthropic", false), { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" });
    assert.deepEqual(pse.providerSafeEnv("anthropic", true), { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" });
    assert.deepEqual(pse.providerSafeEnv("openai", false), {}, "only the Claude provider has settings");
    assert.equal(pse.refusedBeforeSpend({ requests: 2, errors: 2, tokens: 0, cost_usd: 0 }), true);
    assert.equal(pse.refusedBeforeSpend({ requests: 0, errors: 0, tokens: 0, cost_usd: 0 }), false, "never reached the model: not the model's refusal");
    assert.equal(pse.refusedBeforeSpend({ requests: 3, errors: 2, tokens: 0, cost_usd: 0 }), true, "a free request answered (count_tokens) spends nothing either");
    assert.equal(pse.refusedBeforeSpend({ requests: 3, errors: 0, tokens: 0, cost_usd: 0 }), false, "nothing refused");
    assert.equal(pse.refusedBeforeSpend({ requests: 2, errors: 2, tokens: 10, cost_usd: 0 }), false, "tokens were spent");
    console.log("✓ settings: Anthropic's own API only at api.anthropic.com with its own key; the Claude provider's settings; refused before spend");
  }

  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const { createOrg } = await import("../src/auth.js");
  const A = (await createOrg(`Refusal A ${STAMP}`)).org;

  const kinds = [
    { name: "cli", runner: "workspace-harness", entry: "cli-like.mjs", providers: ["anthropic"], max_attempts: 1, budget_usd: 5 },
    { name: "real_cli", runner: "workspace-harness", entry: "claude-cli.mjs", providers: ["anthropic"], max_attempts: 1, budget_usd: 5 },
  ];
  const fixture = definePack({
    id: "fixture_refusal",
    jobKinds: kinds as never,
    tools: [
      defineTool({ name: "fixture_refusal_start", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind, targets }, { runs: r }) => r.start(kind, { targets }) }),
      defineTool({ name: "fixture_refusal_cancel", description: "Cancel a run (test).", inputSchema: { id: z.string() }, handler: async (_ws, { id }, { runs: r }) => r.cancel(id) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_refusal", name: "Fixture refusal", version: "1", entry: "index.ts", migrations: null, words: {}, dir: RUNS_DIR }, definition: fixture }]);

  // The stand-in Vertex AI: Google's token endpoint, and Claude's rawPredict / streamRawPredict / count-tokens.
  let vertexAccepts = true;
  const seen: { path: string; context_management: boolean; anthropic_beta: string[] }[] = [];
  const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const vertex = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => {
      const url = req.url ?? "";
      if (url === "/token") return send(res, 200, { access_token: "ya29.stand-in", expires_in: 3600, token_type: "Bearer" });
      const m = /^\/v1\/projects\/p189-test\/locations\/global\/publishers\/anthropic\/models\/([^/:]+):(rawPredict|streamRawPredict)$/.exec(url);
      if (!m || req.headers.authorization !== "Bearer ya29.stand-in") return send(res, 404, { error: { code: 404, message: `no ${url}` } });
      let b: Record<string, any> = {};
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send(res, 400, { error: { message: "bad JSON" } }); }
      seen.push({ path: url, context_management: "context_management" in b, anthropic_beta: b.anthropic_beta ?? [] });
      // What Vertex answered on 2026-11-01 10:06 (and whenever it does not take the field).
      if ("context_management" in b && !vertexAccepts) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "context_management: Extra inputs are not permitted" } });
      if (m[1] === "count-tokens") return send(res, 200, { input_tokens: 12 });
      const message = { id: "msg_vertex", type: "message", role: "assistant", model: "claude-opus-5-5", content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } };
      if (m[2] === "rawPredict") return send(res, 200, { ...message, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 2 } });
      const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ev("message_start", { type: "message_start", message }) +
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) +
        ev("message_stop", { type: "message_stop" }));
    });
  });
  await new Promise<void>((r) => vertex.listen(0, "127.0.0.1", r));
  const vertexBase = `http://127.0.0.1:${(vertex.address() as AddressInfo).port}`;
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const kv = await import("../src/keyvault.js");
  // Claude on Vertex, as the audit app has it: no Anthropic key, a service-account key (a throwaway one, made here).
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"],
    backend: "vertex", backend_config: { project_id: "p189-test", region: "global", endpoint: vertexBase } });
  await kv.setCredential("anthropic", JSON.stringify({ type: "service_account", project_id: "p189-test", client_email: "runs@p189-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: `${vertexBase}/token` }), { label: kv.VERTEX_LABEL });

  const ca = await connect(A);
  const start = async (kind: string, targets: Record<string, unknown> = {}) => {
    const r = await ca.call("fixture_refusal_start", { kind, targets });
    assert.ok(!r.isError, `start ${kind}: ${r.content[0]?.text}`);
    return r.structuredContent as { id: string; status: string };
  };
  const client = await harness.localRunnerClient("w-refusal");
  const runOne = async (kind: string) => {
    const c = await client.claim([`fixture_refusal/${kind}`]);
    assert.ok(c, `a run of ${kind} to claim`);
    return { claim: c!, view: await harness.runWorkspaceHarness(client, c!, { allowSameUser: true, egress: "off" }) };
  };
  const eventsOf = async (id: string) => db.query<{ type: string; data: any; attempt: number }>("SELECT type, data, attempt FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const row = async (id: string) => (await db.query<any>("SELECT status, attempt, max_attempts, error, cost_usd FROM runs WHERE id = $1", [id]))[0];

  try {
    // ---------- 2. Vertex-served: the settings reach the CLI, which then sends no context_management ----------
    {
      vertexAccepts = false; seen.length = 0;
      const r = await start("cli");
      const { claim, view } = await runOne("cli");
      assert.equal(claim.gateway.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1", "a Vertex-served Claude provider: the betas are off");
      assert.equal(claim.gateway.harness_env?.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1", "and in the agent's settings");
      assert.equal(claim.gateway.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "no non-essential traffic (no remote feature flags)");
      assert.ok(claim.gateway.env.ANTHROPIC_API_KEY.startsWith("ogw_"), "the gateway token as before");
      assert.equal(view?.status, "succeeded", JSON.stringify(view));
      assert.deepEqual(seen.map((s) => s.context_management), [false], "Vertex saw no context_management");
      assert.ok(!seen[0]!.anthropic_beta.includes("context-management-2025-06-27"), "nor its beta");
      assert.ok((await eventsOf(r.id)).every((e) => e.type !== pse.REFUSED_RETRY_EVENT));
      console.log("✓ Claude on Vertex: the run gets CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 and the quiet settings; Vertex sees no context_management; it succeeds");
    }

    // ---------- 3. refused before any spend: queued once more, and the next attempt succeeds ----------
    {
      vertexAccepts = false; seen.length = 0;
      const r = await start("cli", { ignore_flag: true });
      const first = await runOne("cli");
      assert.equal(first.view?.status, "queued", `refused before spending: queued again (${JSON.stringify(first.view)})`);
      const ev = await eventsOf(r.id);
      assert.ok(ev.some((e) => e.type === "stderr" && /400 context_management: Extra inputs are not permitted/.test(e.data.tail)), "the CLI's error is kept");
      const retry = ev.find((e) => e.type === pse.REFUSED_RETRY_EVENT);
      assert.ok(retry && retry.attempt === 1 && retry.data.requests === 1 && retry.data.refused === 1 && retry.data.cost_usd === 0, `the retry is an event: ${JSON.stringify(retry)}`);
      assert.deepEqual([(await row(r.id)).max_attempts, Number((await row(r.id)).cost_usd)], [2, 0], "one extra attempt, nothing spent");
      vertexAccepts = true;
      const second = await runOne("cli");
      assert.deepEqual([second.claim.run.id, second.view?.status, second.view?.attempt], [r.id, "succeeded", 2], "the second attempt succeeds");
      assert.deepEqual(seen.map((s) => s.context_management), [true, true], "both attempts sent it; Vertex refused the first only");
      console.log("✓ refused before any token was spent (Vertex's 400, cost 0): queued once more with a model_refused_retry event, though max_attempts is 1; the retry succeeds");
    }

    // ---------- 4. refused again: one retry only ----------
    {
      vertexAccepts = false;
      const r = await start("cli", { ignore_flag: true });
      assert.equal((await runOne("cli")).view?.status, "queued");
      const second = await runOne("cli");
      assert.deepEqual([second.claim.run.id, second.view?.status, second.view?.attempt], [r.id, "failed", 2], "refused again: failed");
      assert.match(String((await row(r.id)).error ?? ""), /exited with 1|exit/i);
      assert.equal((await eventsOf(r.id)).filter((e) => e.type === pse.REFUSED_RETRY_EVENT).length, 1, "retried once, no more");
      assert.equal(await client.claim(["fixture_refusal/cli"]), null, "nothing left to claim");
      console.log("✓ refused on the retry too: failed (one retry per run)");
    }

    // ---------- 5. not retried: tokens spent; cancelled ----------
    {
      vertexAccepts = true;
      const spent = await start("cli", { fail_after: true });
      const s = await runOne("cli");
      assert.deepEqual([s.view?.status, s.view?.attempt], ["failed", 1], "a run that spent tokens and failed is not retried");
      assert.ok((await eventsOf(spent.id)).every((e) => e.type !== pse.REFUSED_RETRY_EVENT));
      vertexAccepts = false;
      const c = await start("cli", { ignore_flag: true });
      const claim = (await client.claim(["fixture_refusal/cli"]))!;
      assert.equal(claim.run.id, c.id);
      // Refused once through the gateway with the run's own token, then cancelled before it completes.
      const res = await fetch(`${claim.gateway.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "x-api-key": claim.gateway.env.ANTHROPIC_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }], context_management: { edits: [] } }) });
      assert.equal(res.status, 400);
      assert.equal((await ca.call("fixture_refusal_cancel", { id: c.id })).structuredContent.cancel_requested, true);
      const v = await runs.completeRun(c.id, claim.lease_token, { outcome: "failed", error_kind: "run", error: "refused" });
      assert.equal(v.status, "cancelled", "a cancelled run is not retried");
      console.log("✓ not retried: a run that spent tokens before failing; a cancelled run");
    }

    // ---------- 6. Anthropic's own API: the betas stay on ----------
    {
      await kv.upsertProvider({ slug: "anthropic", backend: "direct", upstream_url: "https://api.anthropic.com" });
      await kv.setCredential("anthropic", "sk-ant-fixture-not-real");
      await start("cli");
      const claim = (await client.claim(["fixture_refusal/cli"]))!;
      assert.equal(claim.gateway.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, undefined, "Anthropic's own API takes every field: the betas stay on");
      assert.equal(claim.gateway.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "the quiet settings still");
      assert.ok(!JSON.stringify(claim).includes("sk-ant-fixture-not-real"), "the real key never reaches a run");
      await runs.completeRun(claim.run.id, claim.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      await kv.upsertProvider({ slug: "anthropic", backend: "vertex" });
      const own = await db.query<{ id: number }>("SELECT id FROM vault_credentials WHERE provider = 'anthropic' AND label <> $1", [kv.VERTEX_LABEL]);
      for (const k of own) await kv.deleteCredential(k.id);
      console.log("✓ Claude from api.anthropic.com with its own key: the quiet settings, the betas left on");
    }

    // ---------- 7. real Claude Code binaries, through the real gateway to the stand-in Vertex ----------
    const bins = (process.env.RUN_REFUSAL_CLAUDE_BINS ?? "").split(":").filter(Boolean);
    if (!bins.length) console.log("- real Claude Code binaries: skipped (set RUN_REFUSAL_CLAUDE_BINS to their paths)");
    for (const bin of bins) {
      const { spawnSync } = await import("node:child_process");
      const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim().split(" ")[0]!;
      vertexAccepts = false; seen.length = 0;
      await start("real_cli", { bin });
      const ok = await runOne("real_cli");
      const said = (await eventsOf(ok.claim.run.id)).find((e) => e.type === "claude")?.data;
      assert.equal(ok.view?.status, "succeeded", `Claude Code ${version} with the run's settings: ${JSON.stringify(said)}`);
      assert.ok(seen.length > 0 && seen.every((s) => !s.context_management), `Claude Code ${version}: no context_management reached Vertex`);
      // The same binary without the betas setting (a kind that cleared it): the failure of 2026-11-01, or the CLI's own fallback.
      seen.length = 0;
      const r = await start("real_cli", { bin });
      const c = (await client.claim(["fixture_refusal/real_cli"]))!;
      const { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: _off, ...env } = c.gateway.env;
      const { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: _off2, ...hEnv } = c.gateway.harness_env ?? {};
      const bare = await harness.runWorkspaceHarness(client, { ...c, gateway: { ...c.gateway, env, harness_env: hEnv } }, { allowSameUser: true, egress: "off" });
      const out = (await eventsOf(r.id)).find((e) => e.type === "claude")?.data;
      const [maj, min, patch] = version.split(".").map(Number);
      const fallsBack = maj! > 2 || (maj === 2 && (min! > 1 || (min === 1 && patch! >= 304)));
      if (fallsBack) assert.ok(bare?.status === "succeeded" && seen[0]?.context_management && seen.some((s) => !s.context_management), `Claude Code ${version} retries without the field: ${JSON.stringify(out)}`);
      else {
        assert.equal(bare?.status, "queued", `Claude Code ${version} without the setting is refused, and queued once more: ${JSON.stringify(out)}`);
        assert.match(String(out?.result), /context_management: Extra inputs are not permitted/, "with Vertex's own words");
        const again = await runOne("real_cli");
        assert.equal(again.view?.status, "succeeded", "the retry gets the settings again and succeeds");
      }
      console.log(`✓ Claude Code ${version}: succeeds through the gateway on Vertex with the run's settings; without the betas setting it ${fallsBack ? "falls back by itself" : "is refused (400 context_management), and the run's one retry succeeds"}`);
    }
  } finally {
    await ca.close();
    await http.close();
    vertex.close();
  }
  await db.close();
  console.log("RUN REFUSAL TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
