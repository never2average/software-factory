// The onboarding checklist from pack-declared steps (mold_v0-011; src/onboarding.ts), offline: an embedded database,
// the HTTP server behind a fake Clerk, a fixture pack with one step of every condition.
//   npm run test:onboarding
//
// 1. Zero packs: no steps, nothing mounted at /api/onboarding, and the console's generated count is 0 (the Setup page
//    does not ask; src/app.ts's own setup steps are untouched).
// 2. definePack and the registry refuse steps whose condition is malformed or names what the pack does not have (a
//    kind, a credential, a workspace area of its own) or a tool no one declares.
// 3. Two workspaces: everything B does (connect, call tools, set a credential, add a record, finish a run) ticks B's
//    steps and none of A's; then A's tick one by one from A's own events, each with when it happened. Over HTTP each
//    signed-in person reads their own workspace's checklist.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const TOOL_NAMES = ["shell_tool"]; // a tool of this build the shell reserves (a host pack's, src/host.ts)
  const { setPacksForTest, installPacks } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const ob = await import("../src/onboarding.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const creds = await import("../src/credentials.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Onboard A ${STAMP}`)).org, B = (await createOrg(`Onboard B ${STAMP}`)).org;

  // ---------- 1. zero packs ----------
  {
    assert.deepEqual(ob.onboardingSteps(), [], "no packs, no steps");
    assert.equal(ob.onboardingAppRouter().stack.length, 0, "nothing is mounted at /api/onboarding");
    const nav = readFileSync(path.join(ROOT, "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    assert.match(nav, /export const packOnboardingSteps = 0;/, "the console's Setup page does not ask for pack steps");
    console.log("✓ zero packs: no steps, nothing mounted, the Setup page unchanged");
  }

  // ---------- 2. refusals ----------
  {
    const area = (scope: string) => ({ name: "pk_items", label: "Items", role: scope === "platform" ? "check" : "asset", scope, fields: [{ name: "body", label: "Body" }] });
    const pack = (done_when: string, extra: Record<string, unknown> = {}) => definePack({ id: "pk", onboarding: [{ id: "st", label: "Step", done_when }], ...extra });
    for (const bad of ["", "tool", "tool:", "toolx:a", "tool:A-B", "run", "credential:x y", "always", "record:a:b"]) assert.throws(() => pack(bad), /done_when/, `refused: ${JSON.stringify(bad)}`);
    assert.throws(() => pack("run:nope"), /names job kind nope/);
    assert.throws(() => pack("credential:nope"), /names credential nope/);
    assert.throws(() => pack("record:nope"), /names record area nope/);
    assert.throws(() => pack("record:pk_items", { recordAreas: [area("platform")] }), /workspace-scope area/);
    assert.doesNotThrow(() => pack("record:pk_items", { recordAreas: [area("workspace")] }));
    assert.throws(() => definePack({ id: "pk", onboarding: [{ id: "st", label: "S", done_when: "workspace" }, { id: "st", label: "T", done_when: "connected" }] }), /declared twice/);
    const manifest = { id: "pk", name: "pk", version: "1", entry: "index.ts", migrations: null, words: {} };
    assert.throws(() => installPacks([{ manifest, definition: { id: "pk", onboarding: [{ id: "st", label: "S", done_when: "tool:no_such_tool" }] } }], TOOL_NAMES), /no tool no_such_tool/);
    assert.doesNotThrow(() => installPacks([{ manifest, definition: { id: "pk", onboarding: [{ id: "st", label: "S", done_when: `tool:${TOOL_NAMES[0]}` }] } }], TOOL_NAMES));
    console.log("✓ steps with a malformed condition, or naming a kind, credential, area or tool that is not there, are refused");
  }

  // ---------- the fixture pack ----------
  const fixture = definePack({
    id: "fixture_onboard",
    recordAreas: [{ name: "ob_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] }],
    credentials: [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "FIXTURE_OB_TOKEN" } }],
    jobKinds: [{ name: "first_check", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15 }],
    tools: [
      defineTool({ name: "ob_add_app", description: "Add an application (test).", inputSchema: { key: z.string() },
        handler: async (_ws, { key }, { records }) => records.put("ob_apps", key, { title: key, data: { url: `https://${key}.example` } }) }),
      defineTool({ name: "ob_start", description: "Start the first check (test).", handler: async (_ws, _a, { runs }) => runs.start("first_check") }),
    ],
    onboarding: [
      { id: "made", label: "Workspace made", done_when: "workspace" },
      { id: "connect", label: "Connect a client", done_when: "connected" },
      { id: "first", label: "Make a first call", done_when: "first_call" },
      { id: "app", label: "Add an application", help: "Ask your client to add one.", done_when: "record:ob_apps" },
      { id: "key", label: "Give the API token", done_when: "credential:api_token" },
      { id: "start", label: "Start a check", done_when: "tool:ob_start" },
      { id: "checked", label: "First check done", done_when: "run:first_check" },
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_onboard", name: "Fixture onboarding", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  const http = await startHttp();
  const ca = await connect(A), cb = await connect(B);
  const ids = (x: { steps: { id: string; done: boolean }[] }) => x.steps.filter((s) => s.done).map((s) => s.id);
  try {
    // ---------- 3. two workspaces ----------
    const fresh = await ob.onboardingFor(A.orgId);
    assert.deepEqual([fresh.total, fresh.done, ids(fresh)], [7, 1, ["made"]], "a new workspace: only 'workspace made'");
    assert.equal(fresh.steps.find((s) => s.id === "app")!.help, "Ask your client to add one.");
    const client = await harness.localRunnerClient("w-onboard");
    const finishRun = async () => { const c = (await client.claim(["fixture_onboard/first_check"]))!; return harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" }); };
    // B does everything; its events are recorded as the connector records them (initialize, tools/call).
    const { recordMcpEvent } = await import("../src/analytics.js");
    recordMcpEvent(B, { method: "initialize", client: "test" });
    assert.ok(!(await cb.call("ob_add_app", { key: "b-app" })).isError);
    assert.ok(!(await cb.call("ob_start", {})).isError);
    assert.equal((await finishRun())?.status, "succeeded");
    await creds.setCredential(B.orgId, "test", { pack: "fixture_onboard", name: "api_token", value: "b-token-value-123" });
    await new Promise((r) => setTimeout(r, 300)); // the connector records its events after answering
    const b = await ob.onboardingFor(B.orgId), a = await ob.onboardingFor(A.orgId);
    assert.deepEqual(ids(b), ["made", "connect", "first", "app", "key", "start", "checked"], "B's own events tick all of B's steps");
    assert.deepEqual(ids(a), ["made"], "and none of A's");
    // A, one step at a time.
    recordMcpEvent(A, { method: "initialize", client: "test" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(ids(await ob.onboardingFor(A.orgId)), ["made", "connect"]);
    assert.ok(!(await ca.call("ob_add_app", { key: "a-app" })).isError);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(ids(await ob.onboardingFor(A.orgId)), ["made", "connect", "first", "app"], "a tool call that adds a record: first call and application");
    await creds.setCredential(A.orgId, "test", { pack: "fixture_onboard", name: "api_token", value: "a-token-value-123" });
    assert.deepEqual(ids(await ob.onboardingFor(A.orgId)), ["made", "connect", "first", "app", "key"]);
    assert.ok(!(await ca.call("ob_start", {})).isError);
    await new Promise((r) => setTimeout(r, 300));
    const started = await ob.onboardingFor(A.orgId);
    assert.deepEqual(ids(started), ["made", "connect", "first", "app", "key", "start"], "started, not yet done");
    assert.equal((await finishRun())?.status, "succeeded");
    const all = await ob.onboardingFor(A.orgId);
    assert.deepEqual([all.done, all.total], [7, 7]);
    assert.ok(all.steps.every((s) => s.at && !Number.isNaN(Date.parse(s.at))), "each with when it was done");
    // A step follows its own workspace's state: removing A's credential un-ticks A's step only.
    await creds.deleteCredential(A.orgId, { pack: "fixture_onboard", name: "api_token" });
    assert.ok(!ids(await ob.onboardingFor(A.orgId)).includes("key") && ids(await ob.onboardingFor(B.orgId)).includes("key"), "a step follows its own workspace's state");
    // Over HTTP: each person reads their own workspace's checklist.
    const sa = await http.signIn(A, "viewer"), sb = await http.signIn(B);
    const get = async (tok: string) => (await http.req("GET", "/api/onboarding", { authorization: `Bearer ${tok}` })).json();
    assert.deepEqual(ids(await get(sa)), ["made", "connect", "first", "app", "start", "checked"], "A's person sees A's checklist");
    assert.equal((await get(sb)).done, 7, "B's person sees B's");
    assert.equal((await http.req("GET", "/api/onboarding", {})).status, 401, "signed out: nothing");
    console.log("✓ two workspaces: B's events tick only B's steps; A's tick one by one from A's own events, with when; each person reads their own workspace's checklist");
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }
  await db.close();
  console.log("ONBOARDING TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
