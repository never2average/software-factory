// A run world for the spend, usage and limits tests (mold_v0-053, 008, 018): the throwaway database and HTTP server of
// test-world.ts, a fixture pack whose job kinds the test chooses, the real gateway in front of a fake model upstream
// that meters every request at $0.12 (120 input tokens x $500/M + 30 output x $2000/M), and helpers to start, claim,
// spend through the gateway and complete runs without a runner process. Import test-world.ts first.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { startHttp } from "./test-world.js";

export const PER_REQUEST_USD = 0.12;

export async function spendWorld(kinds: Record<string, unknown>[], opts: { tools?: boolean } = {}) {
  const { getDb } = await import("../../src/db.js");
  const db = await getDb();
  await import("../../src/server.js");
  const { setPacksForTest } = await import("../../src/packs.js");
  const { definePack, defineTool, z } = await import("../../src/pack-api.js");
  const runs = await import("../../src/runs.js");
  const fixture = definePack({
    id: "fixture_spend",
    jobKinds: kinds.map((k) => ({ runner: "workspace-harness", entry: "ok.mjs", ...k })) as never,
    tools: opts.tools === false ? [] : [
      defineTool({ name: "fixture_spend_start", description: "Start a run (test).", inputSchema: { kind: z.string() },
        handler: async (_ws, { kind }, { runs: r }) => r.start(kind, {}) }),
      defineTool({ name: "fixture_spend_echo", description: "Echo a payload of n bytes (test).", inputSchema: { n: z.number().int().min(0).max(10_000_000) },
        annotations: { readOnlyHint: true }, handler: async (_ws, { n }) => ({ payload: "x".repeat(n) }) }),
      defineTool({ name: "fixture_spend_fail", description: "Fail (test).", inputSchema: {}, annotations: { readOnlyHint: true },
        handler: async () => { throw Object.assign(new Error("bad argument (test)"), { status: 400 }); } }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_spend", name: "Fixture spend", version: "1", entry: "index.ts", migrations: null, words: {},
    dir: path.resolve(import.meta.dirname, "..", "fixtures", "runs") }, definition: fixture }]);

  const upstream = createServer((req, res) => {
    req.resume().on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: {"type":"message_start","message":{"model":"fixture-model","usage":{"input_tokens":120,"output_tokens":1}}}\n\n`);
      res.end(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const kv = await import("../../src/keyvault.js");
  await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
  await kv.setCredential("anthropic", "sk-fixture-real-key");
  await db.query(`INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok) VALUES ('fixture-model', 500, 50, 2000)
                  ON CONFLICT (model) DO UPDATE SET input_per_mtok = 500, output_per_mtok = 2000`);

  type Claim = NonNullable<Awaited<ReturnType<typeof runs.claimRun>>>;
  /** Start a run of `kind` for `orgId` (as a pack's ctx.runs.start would), optionally by a member. */
  const start = (orgId: number, kind: string, by: string | null = null) => runs.startRun(orgId, "fixture_spend", kind, {}, by);
  /** Claim the oldest queued run of these kinds (all of the fixture's when none). */
  const claim = (kindNames: string[] = []) => runs.claimRun("w-test", { kinds: kindNames.map((k) => `fixture_spend/${k}`) });
  /** n model requests through the real gateway with the run's token: the HTTP statuses. */
  const spend = async (c: Claim, n = 1) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = await fetch(`${c.gateway.providers.anthropic!.base_url}/v1/messages`, { method: "POST",
        headers: { "x-api-key": c.gateway.env.ANTHROPIC_API_KEY!, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-model", messages: [] }) });
      await r.text();
      out.push(r.status);
    }
    return out;
  };
  const complete = (c: Claim) => runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [] });
  const close = async () => { await http.close(); upstream.close(); };
  return { db, http, runs, start, claim, spend, complete, close };
}
