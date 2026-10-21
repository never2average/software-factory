// Usage pages in neutral words (mold_v0-008; src/usage-report.ts, src/usage-routes.ts, src/analytics.ts), offline:
// an embedded database, the HTTP server, the real gateway in front of a fake model, two workspaces.
//   npm run test:usage
//
//  1. Each MCP call records its workspace, member (or key id), client name and version, tool, outcome, error class,
//     latency and sizes; never its arguments or its answer.
//  2. A workspace's page (GET /api/usage): calls per tool with errors and p50/p95, errors by class, members, clients,
//     and its runs with their tool calls, model requests and cost; nothing of the other workspace.
//  3. Daily and weekly active people and week-over-week retention.
//  4. The operator's page (every workspace, platform admins only; a member gets 401/403).
//  5. Words: a pack's words replace the shell's on the pages.
//  6. Recording never blocks or fails the call: a call whose record cannot be written still answers.
import assert from "node:assert/strict";
import { cleanup, STAMP } from "./lib/test-world.js";
import { PER_REQUEST_USD, spendWorld } from "./lib/spend-world.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const w = await spendWorld([{ name: "metered", providers: ["anthropic"], budget_usd: 5 }]);
  const { createOrg, createApiKey } = await import("../src/auth.js");
  const { recordMcpEvent } = await import("../src/analytics.js");
  const A = (await createOrg(`Usage A ${STAMP}`)), B = (await createOrg(`Usage B ${STAMP}`));
  const SECRET_ARG = `canary-${STAMP}-argument`;
  /** One JSON-RPC call to /mcp with a key, as a client named in its User-Agent. */
  const rpc = async (key: string, method: string, params: Record<string, unknown> = {}, ua = "fixture-client/1.2.3") => {
    const r = await fetch(`${w.http.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "user-agent": ua }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: r.status, text: await r.text() };
  };
  const call = (key: string, name: string, args: Record<string, unknown> = {}, ua?: string) => rpc(key, "tools/call", { name, arguments: args }, ua);
  try {
    // ---------- 1. what a call records ----------
    const memberKey = await createApiKey(A.org.orgId, "member key", "user_a1");
    for (let i = 0; i < 3; i++) assert.equal((await call(memberKey, "fixture_spend_echo", { n: 10 + i, note: SECRET_ARG })).status, 200);
    assert.equal((await call(A.key, "fixture_spend_fail", {}, "other-client/9.0")).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await call(B.key, "fixture_spend_echo", { n: 1 }, "b-client/2.0")).status, 200);
    await sleep(500); // recording is fire-and-forget
    const rows = await w.db.query<any>("SELECT * FROM mcp_events WHERE method = 'tools/call' AND org_id = $1 ORDER BY id", [A.org.orgId]);
    assert.equal(rows.length, 4, "A's four calls are recorded");
    const ok = rows[0], bad = rows[3];
    assert.deepEqual([ok.name, ok.user_id, ok.client_name, ok.client_version, ok.ok], ["fixture_spend_echo", "user_a1", "fixture-client", "1.2.3", true], "tool, member, client name and version, outcome");
    assert.ok(Number(ok.key_id) > 0 && ok.ms != null && ok.req_bytes > 0 && ok.res_bytes > 0, "key id, latency, request and answer sizes");
    assert.deepEqual([bad.ok, bad.error_class, bad.user_id, bad.client_name], [false, "invalid_input", null, "other-client"], "a failure's class; a key with no member");
    const all = JSON.stringify(await w.db.query("SELECT * FROM mcp_events"));
    assert.ok(!all.includes(SECRET_ARG) && !all.includes("xxxxxxxxxx"), "neither arguments nor answers are stored");
    console.log("✓ each call records workspace, member or key, client name and version, tool, outcome, error class, latency and sizes; no arguments, no answer");

    // ---------- runs: tool calls and cost per run ----------
    const run = await w.start(A.org.orgId, "metered", "user_a1");
    const c = (await w.claim(["metered"]))!;
    assert.deepEqual(await w.spend(c, 2), [200, 200]);
    await w.runs.appendRunEvents(c.run.id, c.lease_token, [{ type: "tool_call", data: { name: "search" } }, { type: "tool.fetch" }, { type: "log" }]);
    await w.complete(c);

    // ---------- 2. the workspace's page ----------
    const ta = await w.http.signIn(A.org, "member"), tb = await w.http.signIn(B.org, "member");
    const page = async (t: string, q = "") => { const r = await w.http.req("GET", `/api/usage${q}`, { authorization: `Bearer ${t}` }); assert.equal(r.status, 200, `GET /api/usage: ${r.status}`); return r.json() as Promise<any>; };
    const pa = await page(ta), pb = await page(tb);
    assert.equal(pa.totals.calls, 4); assert.equal(pa.totals.errors, 1); assert.equal(pb.totals.calls, 5, "each workspace counts its own calls only");
    const echo = pa.tools.find((t: any) => t.name === "fixture_spend_echo");
    assert.ok(echo && echo.calls === 3 && echo.p50_ms != null && echo.p95_ms != null && echo.avg_answer_bytes > 0, "calls per tool with p50/p95 and sizes");
    assert.deepEqual(pa.errors_by_class, [{ class: "invalid_input", errors: 1 }], "errors by class");
    assert.ok(pa.clients.some((x: any) => x.name === "fixture-client" && x.version === "1.2.3"), "clients by name and version");
    const m = pa.members.find((x: any) => x.user_id === "user_a1");
    assert.ok(m && m.calls === 3 && m.runs === 1 && Math.abs(m.run_cost_usd - 2 * PER_REQUEST_USD) < 1e-6, "per member: calls, runs and run cost");
    assert.ok(pa.members.some((x: any) => x.user_id === null && x.key_id != null && x.calls === 1 && x.label.startsWith("Key ")), "a key with no member is its own line");
    assert.equal(pa.runs.runs, 1);
    const rr = pa.runs.recent[0];
    assert.deepEqual([rr.id, rr.tool_calls, rr.requests], [run.id, 2, 2], "per run: its tool calls (tool_call and tool.* events) and model requests");
    assert.ok(Math.abs(rr.cost_usd - 2 * PER_REQUEST_USD) < 1e-6, "per run: its cost");
    assert.equal(pb.runs.runs, 0, "B has no runs");
    for (const leak of [run.id, "user_a1", "fixture-client"]) assert.ok(!JSON.stringify(pb).includes(leak), `B's page names nothing of A's (${leak})`);
    console.log("✓ the workspace page: calls per tool (errors, p50/p95, sizes), errors by class, clients, members, runs with tool calls, requests and cost; nothing of B");

    // ---------- 3. active people and retention ----------
    {
      const C = (await createOrg(`Usage C ${STAMP}`)).org;
      const DAY = 86_400_000, today = Math.floor(Date.now() / DAY) * DAY;
      const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
      const at = (t: number) => new Date(t + 3_600_000);
      // p1 is active last week and this week, p2 last week only, p3 this week only: 1 of 2 came back.
      for (const [user, t] of [["p1", monday - 7 * DAY], ["p2", monday - 6 * DAY], ["p1", monday], ["p3", monday]] as [string, number][])
        await w.db.query("INSERT INTO mcp_events (org_id, method, name, ok, ms, user_id, at) VALUES ($1, 'tools/call', 'x', true, 5, $2, $3)", [C.orgId, user, at(t)]);
      const { workspaceUsageReport } = await import("../src/usage-report.js");
      const rep = await workspaceUsageReport(C.orgId, { days: 14 });
      const thisWeek = rep.retention.find((x) => x.week === new Date(monday).toISOString().slice(0, 10))!;
      assert.deepEqual([thisWeek.active, thisWeek.previous, thisWeek.retained, thisWeek.rate], [2, 2, 1, 0.5], "week-over-week retention: 1 of last week's 2 came back");
      assert.equal(rep.active.wau, 2, "active this week");
      assert.ok(rep.active.daily_people.reduce((a, b) => a + b, 0) === 4 && rep.active.dau_avg > 0, "daily active people");
      console.log("✓ daily and weekly active people and week-over-week retention");
    }

    // ---------- 4. the operator's page ----------
    {
      const r = await w.http.req("GET", "/api/admin/onboarding/usage", { authorization: `Bearer ${ta}` });
      assert.ok([401, 403].includes(r.status), `a member cannot read the operator page (${r.status})`);
      const admin = await w.http.adminToken("viewer");
      const op = await (await w.http.req("GET", "/api/admin/onboarding/usage", { authorization: `Bearer ${admin}` })).json() as any;
      const wa = op.workspaces.find((x: any) => x.slug === A.org.slug), wb = op.workspaces.find((x: any) => x.slug === B.org.slug);
      assert.ok(wa && wa.calls === 4 && wa.errors === 1 && wa.runs === 1 && Math.abs(wa.run_cost_usd - 2 * PER_REQUEST_USD) < 1e-6, "per workspace: A");
      assert.ok(wb && wb.calls === 5 && wb.runs === 0, "per workspace: B");
      assert.ok(op.totals.calls >= 9 && op.tools.length > 0 && Array.isArray(op.retention), "every workspace's calls per tool and retention");
      console.log("✓ the operator page: every workspace (calls, errors, people, p95, runs, run cost), platform admins only");
    }

    // ---------- 5. words ----------
    {
      const { setPacksForTest, packs } = await import("../src/packs.js");
      const { usageWords } = await import("../src/usage-report.js");
      assert.deepEqual(usageWords(), { workspace: "workspace", member: "member", run: "run", tool_call: "tool call", key: "key" }, "the shell's neutral words");
      const p = packs()[0]!;
      setPacksForTest([{ ...p, manifest: { ...p.manifest, words: { workspace: "company", run: "audit" } } }]);
      assert.deepEqual([usageWords().workspace, usageWords().run, usageWords().member], ["company", "audit", "member"], "a pack's words replace the shell's");
      assert.equal((await page(ta)).words.run, "audit", "and reach the page");
      setPacksForTest([p]);
      console.log("✓ words: the shell's neutral ones, a pack's where it has its own");
    }

    // ---------- 6. recording never blocks or fails the call ----------
    {
      const ghost = { orgId: 2_000_000_000, slug: "ghost", name: "ghost" };
      assert.doesNotThrow(() => recordMcpEvent(ghost, { method: "tools/call", name: "x" }), "a record that cannot be written (no such workspace) never throws");
      await w.db.query("ALTER TABLE mcp_events RENAME TO mcp_events_away");
      try {
        const r = await call(memberKey, "fixture_spend_echo", { n: 3 });
        assert.equal(r.status, 200, "with the activity table gone, the call still answers");
        assert.ok(r.text.includes("xxx") && !r.text.includes('"isError":true'), "with its result");
      } finally {
        await w.db.query("ALTER TABLE mcp_events_away RENAME TO mcp_events");
      }
      console.log("✓ recording never blocks or fails the call it describes");
    }
  } finally {
    await w.close();
  }
} finally {
  cleanup();
}
process.exit(0);
