// The gateway's pricing against the provider's own usage fields (mold_v0-246; src/usage.ts priceTokens, src/gateway.ts),
// offline: an embedded database, the real gateway in front of a fake Anthropic upstream that answers with real-shaped
// usage, and a run whose spend is read where every ledger reads it.
//   npm run test:gateway-pricing
//
//  1. Pure: plain input, cache reads and cache writes each at their own price (5-minute writes at 1.25x input and
//     1-hour writes at 2x when the row names no write price, or at the row's own); the long-context tier; a real
//     session's tokens (claude-sonnet-5-5: 1,263 plain, 40,796 cache-write, 17,986 cache-read, 744 output, measured in
//     mold_v0-245) give the provider's list-price figure, $0.115553 (to the cent $0.12), where the old arithmetic
//     (writes as plain input) gave $0.095155.
//  2. The meter reads Anthropic's usage fields as the provider reports them: a streamed message_start and the
//     message_delta repeating its figures, and a JSON body with 1-hour writes; nothing counted twice.
//  3. Through the gateway: that session's request costs $0.115553 in gateway_usage (the run's ledger) and in
//     gateway_model_usage (the day's, with its cache writes counted apart); the run's spend (run-spend.ts RUN_USD, what
//     the run budget, the month figures and the agent session's ledger read) is the same figure.
//  4. Haiku is priced: claude-haiku-5-5 (served as a dated release) is routed and metered at its price, 1-hour writes
//     at 2x; a served name with no row of its own is priced as the model the request asked for.
//  5. A model with no price is refused before anything is sent (400, in words), metered nowhere; counting tokens
//     (free) is not refused; a request that names no model goes on as before.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, STAMP } from "./lib/test-world.js";
import { spendWorld } from "./lib/spend-world.js";

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 5e-7, `${what}: ${a} (expected ${b})`);
const ok = (what: string) => console.log(`✓ ${what}`);

// The session measured in mold_v0-245 (docs/agent-harness.md "A real session"), the provider's usage fields summed.
const SESSION = { input_tokens: 1263, cache_creation_input_tokens: 40796, cache_read_input_tokens: 17986, output_tokens: 744 };
const SESSION_USD = 0.115553; // at $2 input, $2.50 cache write (1.25x), $0.20 cache read, $10 output per million

try {
  const U = await import("../src/usage.js");
  const G = await import("../src/gateway.js");

  // ---------- 1. pure ----------
  {
    const sonnet = { input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 10, cache_write_per_mtok: null, cache_write_1h_per_mtok: null,
      long_context_threshold: null, long_input_per_mtok: null, long_cached_input_per_mtok: null, long_output_per_mtok: null };
    const m = { input: SESSION.input_tokens + SESSION.cache_creation_input_tokens + SESSION.cache_read_input_tokens, cached: SESSION.cache_read_input_tokens,
      cacheWrite: SESSION.cache_creation_input_tokens, output: SESSION.output_tokens };
    assert.equal(m.input, 60045, "the session's input with cache, as the gateway counted it");
    // The provider's arithmetic, written out: each field at its own price.
    const provider = (1263 * 2 + 40796 * 2 * 1.25 + 17986 * 0.2 + 744 * 10) / 1e6;
    near(provider, SESSION_USD, "the provider's list-price figure");
    near(U.priceTokens(sonnet, m), SESSION_USD, "the gateway's figure is the provider's");
    assert.equal(U.priceTokens(sonnet, m).toFixed(2), "0.12", "to the cent");
    near(U.priceTokens(sonnet, { ...m, cacheWrite: 0 }), 0.0951552, "the old arithmetic (writes as plain input): 18% low");
    near(U.priceTokens(sonnet, m) - U.priceTokens(sonnet, { ...m, cacheWrite: 0 }), 40796 * 0.5 / 1e6, "the whole gap is the writes' premium");
    near(U.priceTokens({ ...sonnet, cache_write_per_mtok: 3 }, m), (1263 * 2 + 40796 * 3 + 17986 * 0.2 + 744 * 10) / 1e6, "a row's own write price");
    near(U.priceTokens(sonnet, { ...m, cacheWrite1h: 796 }), (1263 * 2 + 40000 * 2.5 + 796 * 4 + 17986 * 0.2 + 744 * 10) / 1e6, "1-hour writes at 2x input");
    near(U.priceTokens({ ...sonnet, cache_write_1h_per_mtok: 5 }, { ...m, cacheWrite1h: 796 }), (1263 * 2 + 40000 * 2.5 + 796 * 5 + 17986 * 0.2 + 744 * 10) / 1e6, "a row's own 1-hour price");
    const long = { ...sonnet, long_context_threshold: 50_000, long_input_per_mtok: 4, long_cached_input_per_mtok: 0.4, long_output_per_mtok: 15, cache_write_per_mtok: 2.5 };
    near(U.priceTokens(long, m), (1263 * 4 + 40796 * 5 + 17986 * 0.4 + 744 * 15) / 1e6, "past the long-context threshold: the long prices, writes at 1.25x the long input");
    // OpenAI and Gemini report cache reads inside their input and no writes: as before.
    const gpt = { ...sonnet, input_per_mtok: 2, cached_input_per_mtok: 0.1 };
    near(U.priceTokens(gpt, { input: 10_000, cached: 4_000, output: 100 }), (6000 * 2 + 4000 * 0.1 + 100 * 10) / 1e6, "no writes reported: plain and cached as before");
    ok("pure: plain, cache-read and cache-write tokens each at their own price (1.25x and 2x input, or the row's); the long tier; the real session's tokens give the provider's $0.115553 ($0.12), the old arithmetic $0.095155");
  }

  // ---------- 2. the meter ----------
  {
    const sse = new G.UsageMeter("text/event-stream");
    sse.feed(Buffer.from(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { ...SESSION, output_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 40796, ephemeral_1h_input_tokens: 0 } } } })}\n\n`));
    sse.feed(Buffer.from(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: SESSION })}\n\n`));
    sse.end();
    assert.deepEqual([sse.model, sse.input, sse.cached, sse.cacheWrite, sse.cacheWrite1h, sse.output], ["claude-sonnet-5-5", 60045, 17986, 40796, 0, 744],
      "streamed: the delta repeating the start's figures counts nothing twice");
    const body = new G.UsageMeter("application/json");
    body.feed(Buffer.from(JSON.stringify({ model: "claude-haiku-5-5", usage: { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 }, output_tokens: 200 } })));
    body.end();
    assert.deepEqual([body.input, body.cached, body.cacheWrite, body.cacheWrite1h, body.output], [8000, 5000, 2000, 2000, 200], "a JSON answer with 1-hour writes");
    const oa = new G.UsageMeter("application/json");
    oa.feed(Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", usage: { prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 300 } } })));
    oa.end();
    assert.deepEqual([oa.input, oa.cached, oa.cacheWrite], [900, 300, 0], "OpenAI's fields: no writes");
    assert.equal(G.requestedModel(Buffer.from('{"model":"claude-haiku-5-5","messages":[]}'), "/v1/messages"), "claude-haiku-5-5");
    assert.equal(G.requestedModel(null, "/v1beta/models/gemini-4-argon:streamGenerateContent"), "gemini-4-argon");
    assert.equal(G.requestedModel(Buffer.from("{}"), "/v1/messages"), "", "a request that names no model");
    ok("the meter: Anthropic's streamed and JSON usage (cache writes and the 1-hour ones apart), OpenAI's; the model a request asks for");
  }

  // ---------- the world ----------
  const w = await spendWorld([{ name: "metered", providers: ["anthropic"], budget_usd: 5 }], { tools: false });
  const hits: string[] = [];
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const asked = (() => { try { return String(JSON.parse(raw).model ?? ""); } catch { return ""; } })();
      hits.push(`${req.url} ${asked}`);
      if (req.url?.endsWith("/count_tokens")) return void res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":12}');
      if (asked === "claude-sonnet-5-5") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { ...SESSION, output_tokens: 1,
          cache_creation: { ephemeral_5m_input_tokens: 40796, ephemeral_1h_input_tokens: 0 } } } })}\n\n`);
        return void res.end(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: SESSION })}\n\n`);
      }
      const usage = asked === "claude-haiku-5-5"
        ? { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 }, output_tokens: 200 }
        : { input_tokens: 1000, output_tokens: 100 };
      // Haiku 5.5 is served as a dated release; Haiku 4.5 under a name with no row of its own.
      const served = asked === "claude-haiku-5-5" ? "claude-haiku-5-5-20261101" : asked === "claude-haiku-4-5" ? "claude-haiku-4-5-variant" : asked || "fixture-model";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", model: served, content: [], usage }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const kv = await import("../src/keyvault.js");
  await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
  const { createOrg } = await import("../src/auth.js");
  const { orgMonthRunSpendUsd } = await import("../src/run-spend.js");
  const A = (await createOrg(`Pricing ${STAMP}`)).org;
  try {
    await w.start(A.orgId, "metered", "user_a1");
    const c = (await w.claim(["metered"]))!;
    const base = c.gateway.providers.anthropic!.base_url, key = c.gateway.env.ANTHROPIC_API_KEY!;
    const call = async (model: string | null, p = "/v1/messages") => {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(model ? { model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] } : {}) });
      return { status: r.status, text: await r.text() };
    };
    const runUsd = async () => Number((await w.db.query<{ c: string }>("SELECT coalesce(sum(cost_usd), 0) AS c FROM gateway_usage WHERE run_id = $1", [c.run.id]))[0]!.c);

    // ---------- 3. the real session through the gateway ----------
    assert.equal((await call("claude-sonnet-5-5")).status, 200);
    near(await runUsd(), SESSION_USD, "the run's gateway ledger (gateway_usage)");
    const [day] = await w.db.query<{ input_tokens: string; cached_input_tokens: string; cache_write_tokens: string; output_tokens: string; cost_usd: string; priced: boolean }>(
      "SELECT input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, priced FROM gateway_model_usage WHERE day = current_date AND model = 'claude-sonnet-5-5'");
    assert.deepEqual([Number(day!.input_tokens), Number(day!.cached_input_tokens), Number(day!.cache_write_tokens), Number(day!.output_tokens), day!.priced],
      [60045, 17986, 40796, 744, true], "the day's row: input with cache, reads and writes apart, output");
    near(Number(day!.cost_usd), SESSION_USD, "the day's figure (gateway_model_usage)");
    near(await orgMonthRunSpendUsd(A.orgId), SESSION_USD, "the run's spend where the budget, month figures and session ledger read it (RUN_USD)");
    ok(`through the gateway: the real session's request costs $${SESSION_USD} in the run's ledger, the day's row (writes counted apart) and the run's spend`);

    // ---------- 4. Haiku ----------
    assert.equal((await call("claude-haiku-5-5")).status, 200, "Haiku 5.5 is routed");
    near(await runUsd(), SESSION_USD + (1000 * 0.1 + 5000 * 0.01 + 2000 * 0.2 + 200 * 0.5) / 1e6, "metered at its price, 1-hour writes at 2x input");
    const [hk] = await w.db.query<{ cost_usd: string; priced: boolean }>("SELECT cost_usd, priced FROM gateway_model_usage WHERE day = current_date AND model = 'claude-haiku-5-5-20261101'");
    assert.ok(hk?.priced && Number(hk.cost_usd) > 0, "its dated release is priced in the day's row");
    const before = await runUsd();
    assert.equal((await call("claude-haiku-4-5")).status, 200);
    near(await runUsd() - before, (1000 * 1 + 100 * 5) / 1e6, "a served name with no row: priced as the model asked for");
    const [v] = await w.db.query<{ priced: boolean }>("SELECT priced FROM gateway_model_usage WHERE day = current_date AND model = 'claude-haiku-4-5-variant'");
    assert.equal(v?.priced, true, "and the day's row says priced, under the served name");
    ok("Haiku: claude-haiku-5-5 routed and metered at its price (its dated release too, 1-hour writes at 2x); a served name with no row is priced as the model asked for");

    // ---------- 5. no price: refused ----------
    const n = hits.length, spent = await runUsd();
    const r = await call(`claude-unpriced-${STAMP}`);
    assert.equal(r.status, 400, "refused");
    const err = JSON.parse(r.text) as { error: { type: string; message: string } };
    assert.equal(err.error.type, "invalid_request_error");
    assert.match(err.error.message, /has no price/); assert.match(err.error.message, /Nothing was sent/);
    assert.ok(!/model_prices|_per_mtok|undefined/.test(err.error.message), "in words, no table names");
    assert.equal(hits.length, n, "nothing reached the provider");
    assert.equal(await runUsd(), spent, "nothing metered");
    assert.equal((await w.db.query("SELECT 1 FROM gateway_model_usage WHERE model = $1", [`claude-unpriced-${STAMP}`])).length, 0, "not in the day's rows");
    assert.equal((await call(`claude-unpriced-${STAMP}`, "/v1/messages/count_tokens")).status, 200, "counting tokens (free) is not refused");
    assert.equal((await call(null)).status, 200, "a request that names no model goes on");
    ok("a model with no price: refused before anything is sent (400, in words), metered nowhere; counting tokens and a request naming no model go on");
    await w.complete(c);
  } finally {
    await w.close(); upstream.close();
  }
} finally {
  cleanup();
}
process.exit(0);
