// Log drains in (mold_v0-303; src/log-drain.ts, src/developer-inbound.ts), offline: an embedded database and the
// embedded fixture with a deployments area and a report area, its receiver of kind log drain signed as Vercel signs.
//   npx tsx scripts/log-drain-test.ts
//
//  1. The pure parts: NDJSON, a JSON array and one object parse; a bad line, too many bytes are refused; requests joined
//     by requestId, build lines and other sources skipped; buckets and p95; the report key.
//  2. A signed NDJSON delivery: one report record per deployment and window with the right requests, errors, error rate,
//     p95 and mean; a second delivery merges into the same window (the histogram kept); the same body twice is written
//     once; an unknown deployment counted, never created; nothing of a line (path, address, agent) kept.
//  3. Refused: a bad signature, no signature, an oversize body. The secret by name (secret_env) wins over the source's.
//  4. The verification handshake: x-vercel-verify set from verify_env on a GET-style handshake and on an empty body,
//     which writes nothing.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { cleanup, STAMP } from "./lib/test-world.js";
import { EMBEDDED_DIR, embeddedJson } from "./lib/embedded-fixture.js";

const RECEIVER = {
  name: "hosting_logs", description: "The hosting provider's request logs, as hourly reports.", area: "deployment_reports", signature: "vercel",
  log_drain: {
    secret_env: "TEST_LOG_DRAIN_SECRET", verify_env: "TEST_LOG_DRAIN_VERIFY", window_minutes: 60,
    deployments: { area: "deployments", field: "provider_id", match: "deployment_id" },
    environments: ["production"],
  },
};

try {
  const ld = await import("../src/log-drain.js");

  // ---------- 1. pure parts ----------
  {
    const a = { deploymentId: "dpl_1", statusCode: 200, timestamp: 1 };
    assert.equal(ld.parseLines([a, a].map((x) => JSON.stringify(x)).join("\n")).length, 2, "NDJSON");
    assert.equal(ld.parseLines(JSON.stringify([a, a, a])).length, 3, "a JSON array");
    assert.equal(ld.parseLines(JSON.stringify(a)).length, 1, "one object");
    assert.deepEqual(ld.parseLines("  \n"), [], "empty");
    assert.throws(() => ld.parseLines(`${JSON.stringify(a)}\nnot json`), /line 2 is not JSON/);
    assert.throws(() => ld.parseLines("[1,2]"), /not a JSON object/);
    assert.throws(() => ld.parseLines("x".repeat(2048), 1024), (e: any) => e.status === 413);
    const reqs = ld.requestsOf([
      { requestId: "r1", deploymentId: "dpl_1", source: "lambda", message: "START" },
      { requestId: "r1", deploymentId: "dpl_1", source: "lambda", message: "REPORT RequestId: r1 Duration: 42.5 ms Billed Duration: 43 ms" },
      { requestId: "r1", deploymentId: "dpl_1", source: "edge", proxy: { statusCode: 502, host: "a.example.com", path: "/x" }, timestamp: 1000 },
      { deploymentId: "dpl_1", source: "build", statusCode: 200 },
      { deploymentId: "dpl_1", source: "static", statusCode: 200, environment: "preview" },
      { deploymentId: "dpl_1", source: "static", statusCode: 304, durationMs: 3 },
      { deploymentId: "dpl_1", message: "a console line without status" },
    ], { sources: null, environments: ["production"] }, 5000);
    assert.equal(reqs.length, 2, "r1 is one request; build lines, other environments and lines without status are not requests");
    assert.deepEqual({ status: reqs[0]!.status, d: reqs[0]!.duration_ms, at: reqs[0]!.at }, { status: 502, d: 42.5, at: 1000 });
    assert.equal(reqs[1]!.at, 5000, "no timestamp: now");
    assert.equal(ld.bucketOf(42.4), 42); assert.equal(ld.bucketOf(1234), 1200); assert.equal(ld.bucketOf(98765), 99000);
    assert.equal(ld.percentile({ "10": 94, "500": 6 }, 0.95), 500);
    assert.equal(ld.percentile({}, 0.95), null);
    assert.equal(ld.reportKey("dep-1", Date.UTC(2026, 10, 14, 10)), "dep-1.20261114T1000Z");
    assert.equal(ld.vercelSignature("s", "body"), "2b36f8fce5fdb512c1a69117e808584a51019d07", "the hex HMAC-SHA1 of the raw body (as openssl sha1 -hmac computes it)");
    assert.equal(ld.logDrainOptions({ name: "x" }), null, "a plain receiver is not a log drain");
    const o = ld.logDrainOptions({ signature: "vercel", log_drain: { secret_env: "whsec_not_a_name", max_bytes: 10 ** 9 } })!;
    assert.equal(o.secret_env, null, "a value that is not an environment name is never taken as one");
    assert.equal(o.max_bytes, ld.LOG_DRAIN_MAX_BYTES, "max_bytes capped");
    assert.equal(o.verify_header, "x-vercel-verify");
    const probs = ld.logDrainProblems(0, { area: "deployment_reports", log_drain: { secret_env: "lower", deployments: { area: "nope" }, fields: { requests: "missing" } } },
      [{ name: "deployment_reports", scope: "workspace", fields: ["requests_n"] }]);
    for (const want of [/secret_env/, /deployments.area: nope/, /fields.requests: missing/]) assert.ok(probs.some((p) => want.test(p)), `${want}: ${probs.join(" | ")}`);
  }
  console.log("✓ pure: NDJSON, arrays and objects parse; bad lines and oversize refused; requests joined by requestId; buckets, p95, keys, options read defensively");

  // ---------- the world ----------
  await import("../src/hosts.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const json = embeddedJson();
  json.record_areas.push(
    { name: "deployments", label: "Deployments", role: "source", scope: "workspace", fields: [
      { name: "provider_id", label: "Provider id", type: "text" }, { name: "url", label: "Address", type: "text" }] },
    { name: "deployment_reports", label: "Deployment reports", role: "source", scope: "workspace", fields: [
      { name: "deployment", label: "Deployment", type: "reference", to: "deployments" },
      { name: "window_start", label: "From", type: "date" }, { name: "window_end", label: "To", type: "date" },
      { name: "requests", label: "Requests", type: "number" }, { name: "errors", label: "Errors", type: "number" },
      { name: "error_rate", label: "Error rate", type: "number" }, { name: "p95_ms", label: "p95 (ms)", type: "number" },
      { name: "mean_ms", label: "Mean (ms)", type: "number" }, { name: "source", label: "Source", type: "text" },
      { name: "buckets", label: "Latency histogram", type: "json" }, { name: "verdict", label: "Verdict", type: "text" }] });
  setPacksForTest([{ manifest: { id: json.id, name: json.name, version: json.version, entry: null, migrations: null, words: {}, dir: EMBEDDED_DIR }, declared: compileDeclarations(json), definition: null } as never]);
  const { $comment: _c, ...cfg } = json.developer_surface;
  // The receiver is given as the server config (its pack.json shape is src/pack-manifest.ts's to take).
  setPackConfigsForTest([{ pack: json.id, developer_surface: { ...cfg, client_sessions: { ttl_seconds: 3600, ...cfg.client_sessions }, webhooks_in: [...cfg.webhooks_in, RECEIVER] } }]);

  const { createOrg } = await import("../src/auth.js");
  const { workspaceRecords } = await import("../src/record-areas.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const inbound = await import("../src/developer-inbound.js");
  const org = (await createOrg(`Drain ${STAMP}`)).org;
  const recs = () => workspaceRecords(json.id, org.orgId);
  await withTenant(org.orgId, async () => {
    await recs().create("deployments", "dep-a", { title: "Release A", data: { provider_id: "dpl_A", url: "https://a.example.com" } });
    await recs().create("deployments", "dep-b", { title: "Release B", data: { provider_id: "dpl_B" } });
  });
  const src = await inbound.createSource(org.orgId, { receiver: "hosting_logs", description: "hosting logs" }, null);
  const SECRET = "drain-secret-from-the-provider";
  process.env.TEST_LOG_DRAIN_SECRET = SECRET;
  process.env.TEST_LOG_DRAIN_VERIFY = "verify-token-123";
  const signed = (body: string, secret = SECRET) => ({ "content-type": "application/x-ndjson", "x-vercel-signature": ld.vercelSignature(secret, body) });
  const send = async (body: string, headers: Record<string, string> = signed(body)) => {
    const got: Record<string, string> = {};
    try { return { ok: true as const, out: await inbound.receive(src.id, headers, body, { header: (n, v) => { got[n] = v; } }) as any, headers: got }; }
    catch (e: any) { return { ok: false as const, status: e.status, code: e.code, headers: got }; }
  };
  const get = (key: string) => withTenant(org.orgId, () => recs().get("deployment_reports", key));
  const H10 = Date.UTC(2026, 10, 14, 10), H11 = Date.UTC(2026, 10, 14, 11);
  const line = (dep: string, status: number, ms: number, at: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: `l${Math.random()}`, deploymentId: dep, projectId: "prj_1", source: "lambda", environment: "production", timestamp: at,
      proxy: { statusCode: status, path: "/private/path?q=secret", clientIp: "203.0.113.9", userAgent: ["agent"], host: "a.example.com" }, durationMs: ms, ...extra });

  // ---------- 2. a signed NDJSON delivery ----------
  {
    // dep-a, 10:00: 20 requests, 10..29 ms, two 500s, one 404; 11:00: 1 request. dep-b: 1 request. dpl_X: unknown (3).
    const body = [
      ...Array.from({ length: 20 }, (_, i) => line("dpl_A", i < 2 ? 500 : i === 2 ? 404 : 200, 10 + i, H10 + i * 1000)),
      line("dpl_A", 200, 100, H11 + 5),
      line("dpl_B", 503, 7, H10 + 1),
      line("dpl_X", 200, 5, H10), line("dpl_X", 200, 5, H10), line("dpl_X", 200, 5, H11),
      JSON.stringify({ deploymentId: "dpl_A", source: "build", message: "Build completed", timestamp: H10 }),
    ].join("\n");
    const r = await send(body);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.out.written, 3, JSON.stringify(r.out));
    assert.equal(r.out.unknown, 3, "the unknown deployment's requests are counted");
    assert.equal(r.out.requests, 25);
    assert.deepEqual([...r.out.keys].sort(), ["dep-a.20261114T1000Z", "dep-a.20261114T1100Z", "dep-b.20261114T1000Z"]);
    const a10 = (await get("dep-a.20261114T1000Z"))!;
    assert.equal(a10.data.deployment, "dep-a");
    assert.equal(a10.data.window_start, "2026-11-14T10:00:00.000Z");
    assert.equal(a10.data.window_end, "2026-11-14T11:00:00.000Z");
    assert.equal(a10.data.requests, 20);
    assert.equal(a10.data.errors, 2, "5xx only");
    assert.equal(a10.data.error_rate, 0.1);
    assert.equal(a10.data.mean_ms, 19.5, "mean of 10..29");
    assert.equal(a10.data.p95_ms, 28, "nearest rank: the 19th of 20");
    assert.equal(a10.data.source, "log drain");
    assert.equal((await get("dep-b.20261114T1000Z"))!.data.error_rate, 1);
    const stored = JSON.stringify(await withTenant(org.orgId, () => recs().list("deployment_reports", {})));
    for (const leak of ["/private/path", "203.0.113.9", "secret", "agent"]) assert.ok(!stored.includes(leak), `nothing of a line is kept: ${leak}`);
    const deps = await withTenant(org.orgId, () => recs().list("deployments", {}));
    assert.equal(deps.records.length, 2, "an unknown deployment creates no record");

    // The same body again (a provider's retry): written once.
    const again = await send(body);
    assert.ok(again.ok && again.out.replayed === true, JSON.stringify(again));
    assert.equal((await get("dep-a.20261114T1000Z"))!.data.requests, 20);

    // A second delivery into the same window merges (the histogram kept): 10 more at 1000 ms, one 500.
    await withTenant(org.orgId, () => recs().update("deployment_reports", "dep-a.20261114T1000Z", { title: a10.title, data: { ...a10.data, verdict: "kept by an agent" } }));
    const more = Array.from({ length: 10 }, (_, i) => line("dpl_A", i === 0 ? 500 : 200, 1000, H10 + 60_000 + i)).join("\n");
    const r2 = await send(more);
    assert.ok(r2.ok && r2.out.written === 1, JSON.stringify(r2));
    const m = (await get("dep-a.20261114T1000Z"))!;
    assert.equal(m.data.requests, 30);
    assert.equal(m.data.errors, 3);
    assert.equal(m.data.error_rate, 0.1);
    assert.equal(m.data.mean_ms, Math.round(((19.5 * 20 + 10000) / 30) * 10) / 10);
    assert.equal(m.data.p95_ms, 1000, "p95 over both deliveries");
    assert.equal(m.data.verdict, "kept by an agent", "fields the drain does not write are kept");

    // A JSON array body.
    const arr = JSON.stringify([JSON.parse(line("dpl_B", 200, 9, H10 + 2))]);
    const r3 = await send(arr);
    assert.ok(r3.ok && r3.out.written === 1, JSON.stringify(r3));
    assert.equal((await get("dep-b.20261114T1000Z"))!.data.requests, 2);
  }
  console.log("✓ a signed NDJSON delivery: per-deployment, per-window reports with requests, 5xx errors, error rate, p95 and mean; merged across deliveries; retries written once; unknown deployments counted, never created; no line kept");

  // ---------- 3. refused ----------
  {
    const body = line("dpl_A", 200, 10, H10 + 5);
    const bad = await send(body, signed(body, "another-secret"));
    assert.equal(bad.ok, false); assert.equal(bad.code, "invalid_signature");
    const none = await send(body, { "content-type": "application/x-ndjson" });
    assert.equal(none.code, "invalid_signature", "no signature");
    const big = "x".repeat(1024 * 1024 + 10);
    assert.equal((await send(big, signed(big))).status, 413, "an oversize body");
    // The secret by name wins; without it, the source's own sealed secret signs.
    delete process.env.TEST_LOG_DRAIN_SECRET;
    assert.equal((await send(body)).code, "invalid_signature", "the named secret unset: the source's own is used");
    const own = await send(body, signed(body, src.secret));
    assert.ok(own.ok && own.out.written === 1, JSON.stringify(own));
    process.env.TEST_LOG_DRAIN_SECRET = SECRET;
    assert.equal((await get("dep-a.20261114T1000Z"))!.data.requests, 31);
    // A standard receiver still verifies Standard Webhooks (the fixture's scanner) — untouched by `signature`.
    const scanner = await inbound.createSource(org.orgId, { receiver: "scanner" }, null);
    await assert.rejects(inbound.receive(scanner.id, signed("{}"), "{}"), (e: any) => e.code === "invalid_signature");
  }
  console.log("✓ refused: a bad signature, no signature, an oversize body; the secret by its environment name, else the source's own");

  // ---------- 4. the verification handshake ----------
  {
    const got: Record<string, string> = {};
    assert.deepEqual(await inbound.handshake(src.id, { header: (n, v) => { got[n] = v; } }), { ok: true });
    assert.equal(got["x-vercel-verify"], "verify-token-123");
    const empty = await send("", {});
    assert.ok(empty.ok && empty.out.verified === true && empty.out.written === 0, JSON.stringify(empty));
    assert.equal(empty.headers["x-vercel-verify"], "verify-token-123", "every response of the source carries it");
    const bad = await send("{}", { "x-vercel-signature": "00" });
    assert.equal(bad.headers["x-vercel-verify"], "verify-token-123", "a refused one too");
    await assert.rejects(inbound.handshake("src_doesnotexist000", { header: () => {} }), (e: any) => e.status === 404);
  }
  console.log("✓ handshake: x-vercel-verify from its environment name, on a handshake and an empty body (nothing written)");
} finally {
  cleanup();
}
process.exit(0);
