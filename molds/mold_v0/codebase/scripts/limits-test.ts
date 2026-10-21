// Limits per run kind and MCP rate limits (mold_v0-018; src/run-limits.ts, src/rate-limits.ts), offline: an embedded
// database, the HTTP server, the real gateway in front of a fake model ($0.12 a request), several workspaces.
//   npm run test:limits
//
//  1. A pack cannot raise its limits past the platform's: a kind's budget, concurrency and month budget are clamped to
//     the platform's ceilings.
//  2. Concurrency per workspace and kind, at claim: extra runs wait in the queue; another workspace's run of the same
//     kind is claimed meanwhile.
//  3. A kind's month budget per workspace, at start and in the gateway: splitting the work into several runs cannot
//     spend past it (by more than the one request in flight when it is reached).
//  4. Runs queued or running per workspace, at start.
//  5. MCP rate limits per key, per member (all their keys) and per workspace (all its keys): a 429 with Retry-After and
//     a JSON-RPC error saying which limit; several keys do not get past the member's or the workspace's limit; other
//     workspaces are unaffected; per address before sign-in.
//  6. Load: one noisy workspace (many requests at once) does not raise another's error rate.
//  7. Size caps: a request over the cap is refused (413); an answer over the cap is a plain error, not sent.
//  8. Sign-up, invitation and key-creation endpoints are rate limited.
//  9. The profile's limits: the build's own numbers and per plan, under the server's environment; gen-packs refuses a
//     limit it does not know.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, STAMP } from "./lib/test-world.js";
import { PER_REQUEST_USD, spendWorld } from "./lib/spend-world.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (vars: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
/** Counts are per one-minute window: start a section early in one, so it never straddles two. */
const freshWindow = async () => { const s = (Date.now() / 1000) % 60; if (s > 35) await sleep((60 - s) * 1000 + 200); };

try {
  const w = await spendWorld([
    { name: "greedy", providers: ["anthropic"], budget_usd: 10_000, concurrency_per_workspace: 100, month_budget_usd: 100_000 },
    { name: "single", concurrency_per_workspace: 1 },
    { name: "capped", providers: ["anthropic"], budget_usd: 5, month_budget_usd: 0.3 },
    { name: "plain" },
  ]);
  const { createOrg, createApiKey } = await import("../src/auth.js");
  const { limitsFor, DEFAULTS } = await import("../src/rate-limits.js");
  let n = 0;
  const org = async () => createOrg(`Limits ${++n} ${STAMP}`);
  const rpc = async (key: string | null, body: unknown, ua = "limits-test/1") => {
    const r = await fetch(`${w.http.base}/mcp`, { method: "POST", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json",
      accept: "application/json, text/event-stream", "user-agent": ua }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { const m = /data: (.*)/.exec(text); json = m ? JSON.parse(m[1]!) : null; }
    return { status: r.status, retryAfter: r.headers.get("retry-after"), json, text };
  };
  const call = (key: string, name = "fixture_spend_echo", args: Record<string, unknown> = { n: 1 }) => rpc(key, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  const MCP_ENV = ["PER_KEY_PER_MINUTE", "PER_MEMBER_PER_MINUTE", "PER_WORKSPACE_PER_MINUTE", "PER_IP_PER_MINUTE", "CONCURRENT_PER_WORKSPACE", "MAX_REQUEST_BYTES", "MAX_RESPONSE_BYTES"];
  const mcpLimits = (v: Partial<Record<string, number>>) => env(Object.fromEntries(MCP_ENV.map((k) => [`OCTILLION_LIMIT_MCP_${k}`, v[k] == null ? undefined : String(v[k])])));
  try {
    // ---------- 1. a pack cannot raise its own limits ----------
    {
      env({ OCTILLION_LIMIT_RUNS_BUDGET_USD_MAX: "2", OCTILLION_LIMIT_RUNS_CONCURRENCY_PER_WORKSPACE: "2", OCTILLION_LIMIT_RUNS_KIND_MONTH_BUDGET_USD: "0.3" });
      const { org: A } = await org(), { org: B } = await org();
      const r = await w.start(A.orgId, "greedy");
      assert.equal(r.budget_usd, 2, "the kind asks $10 000 a run; the platform's ceiling ($2) is frozen into the run");
      await w.start(A.orgId, "greedy"); await w.start(A.orgId, "greedy");
      const c1 = await w.claim(["greedy"]), c2 = await w.claim(["greedy"]), c3 = await w.claim(["greedy"]);
      assert.ok(c1 && c2 && c3 === null, "at most the platform's 2 running at once in a workspace, though the kind asks 100");
      assert.deepEqual(await w.spend(c1!, 2), [200, 200], "$0.24 of the kind's month");
      assert.deepEqual(await w.spend(c2!, 2), [200, 429], "another run of the kind: refused once the kind's month spend reaches the platform's $0.30, though the kind asks $100 000");
      await assert.rejects(w.start(A.orgId, "greedy"), /used this workspace's \$0\.30/, "and no new run of the kind starts in A");
      assert.ok((await w.start(B.orgId, "greedy")).id, "B's month for the kind is its own");
      await w.complete(c1!); await w.complete(c2!);
      env({ OCTILLION_LIMIT_RUNS_BUDGET_USD_MAX: undefined, OCTILLION_LIMIT_RUNS_CONCURRENCY_PER_WORKSPACE: undefined, OCTILLION_LIMIT_RUNS_KIND_MONTH_BUDGET_USD: undefined });
      // Drain what is left so later sections see an empty queue.
      for (let c = await w.claim(["greedy"]); c; c = await w.claim(["greedy"])) await w.complete(c);
      console.log("✓ a pack cannot raise its own limits: budget per run, concurrency and month budget clamped to the platform's");
    }

    // ---------- 2. concurrency per workspace and kind, at claim ----------
    {
      const { org: S1 } = await org(), { org: S2 } = await org();
      const a1 = await w.start(S1.orgId, "single"), a2 = await w.start(S1.orgId, "single"), b1 = await w.start(S2.orgId, "single");
      const x = await w.claim(["single"]), y = await w.claim(["single"]), z = await w.claim(["single"]);
      assert.equal(x?.run.id, a1.id, "S1's first run");
      assert.equal(y?.run.id, b1.id, "S1's second waits (the kind runs one at a time per workspace); S2's run of the same kind goes ahead");
      assert.equal(z, null, "nothing else may start");
      await w.complete(x!);
      const again = await w.claim(["single"]);
      assert.equal(again?.run.id, a2.id, "once S1's first ends, its second starts");
      await w.complete(y!); await w.complete(again!);
      console.log("✓ concurrency per workspace and kind at claim: extra runs wait; another workspace's run goes ahead");
    }

    // ---------- 3. a kind's own month budget, split across runs ----------
    {
      const { org: M } = await org(), { org: M2 } = await org();
      await w.start(M.orgId, "capped");
      const m1 = (await w.claim(["capped"]))!;
      assert.deepEqual(await w.spend(m1, 2), [200, 200]);
      await w.complete(m1);
      await w.start(M.orgId, "capped");
      const m2 = (await w.claim(["capped"]))!;
      assert.deepEqual(await w.spend(m2, 3), [200, 429, 429], "a second run spends only up to the kind's $0.30 for the month");
      await w.complete(m2);
      const [{ usd }] = await w.db.query<{ usd: number }>("SELECT sum(g.cost_usd)::float AS usd FROM gateway_usage g JOIN runs r ON r.id = g.run_id WHERE r.org_id = $1", [M.orgId]);
      assert.ok(usd <= 0.3 + PER_REQUEST_USD + 1e-9, `the kind's month spend stays within its budget and the one request in flight ($${usd})`);
      await assert.rejects(w.start(M.orgId, "capped"), /used this workspace's \$0\.30/, "a third run of the kind is refused at start");
      assert.ok((await w.start(M.orgId, "plain")).id, "another kind of the same workspace still starts");
      assert.ok((await w.start(M2.orgId, "capped")).id, "the same kind in another workspace still starts");
      for (let c = await w.claim(["plain", "capped"]); c; c = await w.claim(["plain", "capped"])) await w.complete(c);
      console.log("✓ a kind's month budget per workspace, at start and in the gateway: splitting work into runs cannot spend past it");
    }

    // ---------- 4. live runs per workspace ----------
    {
      env({ OCTILLION_LIMIT_RUNS_LIVE_PER_WORKSPACE: "2" });
      const { org: L } = await org();
      await w.start(L.orgId, "plain"); await w.start(L.orgId, "plain");
      await assert.rejects(w.start(L.orgId, "plain"), /already has 2 runs queued or running \(at most 2\)/);
      env({ OCTILLION_LIMIT_RUNS_LIVE_PER_WORKSPACE: undefined, OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE: "1" });
      const { org: L2 } = await org();
      await w.start(L2.orgId, "plain");
      await assert.rejects(w.start(L2.orgId, "plain"), /at most 1/, "the older setting still works");
      env({ OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE: undefined });
      for (let c = await w.claim(["plain"]); c; c = await w.claim(["plain"])) await w.complete(c);
      console.log("✓ runs queued or running per workspace, at start");
    }

    // ---------- 5. MCP rate limits per key, member, workspace and address ----------
    {
      mcpLimits({ PER_KEY_PER_MINUTE: 3, PER_MEMBER_PER_MINUTE: 5, PER_WORKSPACE_PER_MINUTE: 8, PER_IP_PER_MINUTE: 100_000 });
      await freshWindow();
      // Per key.
      const R1 = await org();
      for (let i = 0; i < 3; i++) assert.equal((await call(R1.key)).status, 200);
      const k = await call(R1.key);
      assert.equal(k.status, 429, "the key's 4th call in a minute");
      assert.ok(Number(k.retryAfter) >= 1 && Number(k.retryAfter) <= 60, `Retry-After (${k.retryAfter})`);
      assert.deepEqual([k.json.error.code, k.json.error.data.limit, k.json.error.data.max, k.json.id], [-32029, "key", 3, 7], "a JSON-RPC error naming the limit, its number and the request's id");
      assert.ok(/limited to 3 a minute\. Try again in \d+ seconds?/.test(k.json.error.message), k.json.error.message);
      // Per member: two keys of one person share the member's limit.
      const R2 = await org();
      const m1 = await createApiKey(R2.org.orgId, "m1", "user_r2"), m2 = await createApiKey(R2.org.orgId, "m2", "user_r2");
      for (let i = 0; i < 3; i++) assert.equal((await call(m1)).status, 200);
      for (let i = 0; i < 2; i++) assert.equal((await call(m2)).status, 200);
      const mm = await call(m2);
      assert.deepEqual([mm.status, mm.json?.error?.data?.limit], [429, "member"], "a second key does not get past the member's limit");
      // Per workspace: several account keys share the workspace's limit.
      const R3 = await org();
      const a2 = await createApiKey(R3.org.orgId, "a2"), a3 = await createApiKey(R3.org.orgId, "a3");
      for (const key of [R3.key, R3.key, R3.key, a2, a2, a2, a3, a3]) assert.equal((await call(key)).status, 200);
      const ww = await call(a3);
      assert.deepEqual([ww.status, ww.json?.error?.data?.limit], [429, "workspace"], "several keys do not get past the workspace's limit");
      // Another workspace is unaffected.
      const R4 = await org();
      for (let i = 0; i < 3; i++) assert.equal((await call(R4.key)).status, 200, "another workspace's calls go through");
      await sleep(300);
      const [{ c }] = await w.db.query<{ c: number }>("SELECT count(*)::int AS c FROM mcp_events WHERE org_id = $1 AND error_class = 'rate_limited'", [R3.org.orgId]);
      assert.equal(c, 1, "a refusal is recorded as a failed call of class rate_limited");
      // Per address, before sign-in: refused before any key is looked at.
      mcpLimits({ PER_IP_PER_MINUTE: 1 });
      const ip = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.deepEqual([ip.status, ip.json?.error?.data?.limit], [429, "address"], "the address's limit applies before sign-in (also bounds key guessing)");
      mcpLimits({});
      console.log("✓ MCP rate limits per key, member (all their keys), workspace (all its keys) and address; 429 + Retry-After + which limit; others unaffected");
    }

    // ---------- 6. load: a noisy workspace does not raise another's error rate ----------
    {
      mcpLimits({ PER_WORKSPACE_PER_MINUTE: 40, CONCURRENT_PER_WORKSPACE: 4, PER_KEY_PER_MINUTE: 100_000, PER_MEMBER_PER_MINUTE: 100_000, PER_IP_PER_MINUTE: 100_000 });
      await freshWindow();
      const noisy = await org(), quiet = await org();
      const quietAlone = await Promise.all(Array.from({ length: 4 }, () => call(quiet.key)));
      const before = quietAlone.filter((r) => r.status !== 200).length / quietAlone.length;
      const [loud, calm] = await Promise.all([
        Promise.all(Array.from({ length: 120 }, () => call(noisy.key))),
        (async () => { const out = []; for (let i = 0; i < 12; i++) { out.push(await call(quiet.key)); await sleep(10); } return out; })(),
      ]);
      const loudErr = loud.filter((r) => r.status !== 200).length / loud.length, calmErr = calm.filter((r) => r.status !== 200).length / calm.length;
      assert.ok(loud.every((r) => r.status === 200 || r.status === 429), "the noisy workspace gets answers or 429s, nothing else");
      assert.ok(loudErr > 0.5, `the noisy workspace is limited (${Math.round(loudErr * 100)}% refused)`);
      assert.equal(calmErr, before, `the quiet workspace's error rate is unchanged (${calmErr} with the noise, ${before} alone)`);
      assert.equal(calmErr, 0);
      mcpLimits({});
      console.log(`✓ load: 120 requests at once from one workspace (${Math.round(loudErr * 100)}% refused) leave another's error rate at 0%`);
    }

    // ---------- 7. size caps ----------
    {
      mcpLimits({ MAX_REQUEST_BYTES: 2000, MAX_RESPONSE_BYTES: 5000 });
      const Z = await org();
      const big = await call(Z.key, "fixture_spend_echo", { n: 1, pad: "y".repeat(5000) });
      assert.equal(big.status, 413, "a request over the cap");
      const ok = await call(Z.key, "fixture_spend_echo", { n: 100 });
      assert.ok(ok.status === 200 && !ok.text.includes('"isError":true'), "an answer under the cap is sent");
      const huge = await call(Z.key, "fixture_spend_echo", { n: 20_000 });
      assert.equal(huge.status, 200);
      assert.ok(huge.text.includes('"isError":true') && /too large/.test(huge.text) && !huge.text.includes("x".repeat(6000)), "an answer over the cap is a plain error, never sent");
      await sleep(300);
      const [ev] = await w.db.query<any>("SELECT error_class, res_bytes FROM mcp_events WHERE org_id = $1 AND NOT ok ORDER BY id DESC LIMIT 1", [Z.org.orgId]);
      assert.ok(ev.error_class === "limit" && ev.res_bytes > 5000, "recorded as a limit, with the answer's size");
      mcpLimits({});
      console.log("✓ size caps: a request over the cap is refused (413); an answer over it is a plain error");
    }

    // ---------- 8. sign-up, invitation and key-creation endpoints ----------
    {
      env({ OCTILLION_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP: "2", OCTILLION_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE: "1", OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE: "1" });
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await w.http.req("POST", "/api/access-requests", {}, { email: `p${i}@example.org`, company: `Co ${i}` })).status);
      assert.ok(statuses[0] !== 429 && statuses[1] !== 429 && statuses[2] === 429, `sign-up requests: ${statuses}`);
      const I = (await org()).org;
      const owner = await w.http.signIn(I, "owner");
      const inv = async (e: string) => (await w.http.req("POST", "/api/app/team/invitations", { authorization: `Bearer ${owner}` }, { email: e })).status;
      const i1 = await inv(`a-${STAMP}@example.org`), i2 = await inv(`b-${STAMP}@example.org`);
      assert.ok(i1 !== 429 && i2 === 429, `invitations: ${i1}, ${i2}`);
      const admin = await w.http.adminToken("owner");
      const key = async () => (await w.http.req("POST", `/api/admin/onboarding/orgs/${I.slug}/keys`, { authorization: `Bearer ${admin}`, "x-octillion-admin": "1" }, { label: "extra" })).status;
      const k1 = await key(), k2 = await key();
      assert.ok(k1 === 201 && k2 === 429, `new keys: ${k1}, ${k2}`);
      env({ OCTILLION_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP: undefined, OCTILLION_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE: undefined, OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE: undefined });
      console.log("✓ sign-up, invitation and key-creation endpoints are rate limited (429 with Retry-After)");
    }

    // ---------- 9. the profile's limits, per plan, under the environment; gen-packs checks them ----------
    {
      const profile = { mcp: { per_key_per_minute: 50 }, runs: { budget_usd_max: 7 }, plans: { pro: { mcp: { per_key_per_minute: 500 } } } };
      assert.equal(limitsFor(null, undefined).mcp.per_key_per_minute, DEFAULTS.mcp.per_key_per_minute, "the shell's default");
      assert.equal(limitsFor(null, profile).mcp.per_key_per_minute, 50, "the build's profile");
      assert.equal(limitsFor("pro", profile).mcp.per_key_per_minute, 500, "the workspace's plan");
      assert.equal(limitsFor("pro", profile).runs.budget_usd_max, 7, "the profile's run ceiling under a plan that does not change it");
      env({ OCTILLION_LIMIT_MCP_PER_KEY_PER_MINUTE: "9" });
      assert.equal(limitsFor("pro", profile).mcp.per_key_per_minute, 9, "the server's environment over both");
      env({ OCTILLION_LIMIT_MCP_PER_KEY_PER_MINUTE: undefined });
      const dir = mkdtempSync(path.join(tmpdir(), "limits-gen-"));
      try {
        mkdirSync(path.join(dir, "packs")); mkdirSync(path.join(dir, "out"));
        const gen = (limits: unknown) => {
          writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "Shell", limits }));
          return spawnSync(process.execPath, ["scripts/gen-packs.mjs", "--packs", path.join(dir, "packs"), "--out", path.join(dir, "out"), "--profile", path.join(dir, "profile.json")],
            { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
        };
        const good = gen(profile);
        assert.equal(good.status, 0, good.stderr);
        assert.ok(readFileSync(path.join(dir, "out", "src", "profile.generated.ts"), "utf8").includes('"per_key_per_minute": 500'), "the profile's limits reach the server's generated profile");
        assert.ok(!readFileSync(path.join(dir, "out", "web", "src", "config", "profile.generated.ts"), "utf8").includes("limits"), "and never the console's");
        for (const bad of [{ mcp: { per_key_per_minute: -1 } }, { mcp: { per_key: 5 } }, { gateway: {} }, { plans: { pro: { plans: {} } } }]) {
          const r = gen(bad);
          assert.ok(r.status !== 0 && /limits/.test(r.stderr), `gen-packs refuses ${JSON.stringify(bad)}`);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
      console.log("✓ limits from the profile, per plan, under the server's environment; gen-packs refuses unknown or non-positive limits");
    }
  } finally {
    await w.close();
  }
} finally {
  cleanup();
}
process.exit(0);
