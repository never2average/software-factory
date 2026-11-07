// Credentials for workspace agent sessions (mold_v0-262, flag agent_harness; src/agent-profile-spec.ts `credentials`,
// src/harness-sessions.ts, src/agent-harness.ts, src/credentials.ts), offline: an embedded database, the run engine in
// this process and the stand-in CLI (scripts/fixtures/agent-cli/cli.mjs). `npm run test:agent-harness`, after
// agent-harness-test.
//   1. Declared and refused: a profile names "<pack>/<field>" credentials, each once; a pack's profile naming a credential
//      the build does not declare, or one bound to a record, is refused at build; staff's editor refuses the same.
//   2. A workspace owner's session with the profile: each wake receives the value in its env (the CLI reads it) and
//      everything it writes is redacted of it (its reply says [credential ...]); the wake's run records which it was
//      given (its credentials event, the names, never a value); the session says which it receives.
//   3. A member's session with the same profile receives none (its env unset, its run asks for none).
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (what: string) => console.log(`✓ ${what}`);
const TOKEN = `deploy-canary-${Date.now().toString(36)}-${"q".repeat(12)}`;

try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const harness = await import("../src/run-harness.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const P = await import("../src/agent-profiles.js");
  const S = await import("../src/agent-profile-spec.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { createOrg } = await import("../src/auth.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const { setCredential } = await import("../src/credentials.js");
  const { asPlatform } = await import("../src/tenant-scope.js");

  const CREDS = [
    { name: "deploy_token", label: "Deploy token", bound_to: "workspace", deliver_as: { env: "DEPLOY_TOKEN" } },
    { name: "site_key", label: "Site key", bound_to: "asset", area: "fx_sites", deliver_as: { env: "SITE_KEY" } },
  ];
  const AREAS = [{ name: "fx_sites", label: "Sites", role: "asset", scope: "workspace", fields: [{ name: "host", label: "Host" }] }];
  const pack = (profiles: unknown[]) => [{ manifest: { id: "fixture_deploy", name: "fixture_deploy", version: "1", entry: "index.ts", migrations: null, words: {} },
    definition: definePack({ id: "fixture_deploy", recordAreas: AREAS, credentials: CREDS, agentProfiles: profiles } as never) }];

  // ---------- 1. declared and refused ----------
  {
    assert.ok(S.ProfileConfigSchema.safeParse({ credentials: ["fixture_deploy/deploy_token"] }).success, "a profile names a credential");
    assert.ok(!S.ProfileConfigSchema.safeParse({ credentials: ["deploy_token"] }).success, "as <pack>/<field>");
    assert.match(S.configProblems({ credentials: ["a_b/c_d", "a_b/c_d"] }).join(), /listed twice/, "each once");
    assert.throws(() => setPacksForTest(pack([{ id: "deployer", name: "Deployer", credentials: ["fixture_deploy/nope"] }]) as never), /not a credential a pack of this build declares/, "an unknown credential refused at build");
    assert.throws(() => setPacksForTest(pack([{ id: "deployer", name: "Deployer", credentials: ["fixture_deploy/site_key"] }]) as never), /a workspace's own pasted value/, "one bound to a record refused at build");
    setPacksForTest(pack([{ id: "deployer", name: "Deployer", description: "Deploys the app.", credentials: ["fixture_deploy/deploy_token"], roles: ["member", "owner"] }]) as never);
    assert.match((await P.sessionCredentialProblems(["fixture_deploy/site_key", "fixture_deploy/gone"])).join(" "), /bound to a record.*not a credential/, "staff's editor refuses the same");
    ok("declared and refused: <pack>/<field>, each once; an unknown credential or one bound to a record refused at build and in staff's editor");
  }

  // ---------- the world ----------
  F.setFeaturesForTest({ agent_harness: true });
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  P.resetProfileSeedForTest(); await P.ensureProfiles();
  const org = (await createOrg(`Deploy ${STAMP}`)).org;
  await setCredential(org.orgId, "user_owner", { pack: "fixture_deploy", name: "deploy_token", value: TOKEN });
  const owner = { kind: "person", user: "user_owner", name: "owner@example.org", role: "owner" } as const;
  const member = { kind: "person", user: "user_member", name: "member@example.org", role: "member" } as const;
  const client = await harness.localRunnerClient("w-deploy");
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 250 };
  const until = async (what: string, f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
  const wakeOf = async (sid: string) => {
    const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]);
    assert.ok(c, "a wake to claim");
    return { claim: c!, done: harness.runWorkspaceHarness(client, c!, opts) };
  };
  const agentSaid = async (sid: string, a: typeof owner | typeof member) => (await H.readSession(org.orgId, sid, a as never)).messages.filter((m) => m.role === "agent").map((m) => m.body);

  // ---------- 2. an owner's session receives it, redacted ----------
  {
    const s = await H.startSession(org.orgId, owner as never, { message: "env DEPLOY_TOKEN", profile: "deployer", mode: "task" });
    assert.deepEqual(s.policy.credentials, ["fixture_deploy/deploy_token"], "the session says which credentials it receives");
    const w = await wakeOf(s.id);
    await until("the agent answers", async () => (await agentSaid(s.id, owner)).length > 0);
    const said = (await agentSaid(s.id, owner)).join("\n");
    assert.ok(!said.includes(TOKEN), "the value never leaves the wake");
    assert.match(said, /Env DEPLOY_TOKEN: \[credential fixture_deploy\/deploy_token\]/, `the CLI had it in its env, redacted on its way out: ${said}`);
    const ev = await asPlatform(() => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [w.claim.run.id]));
    const given = ev.find((e) => e.type === "credentials");
    assert.deepEqual(given?.data.delivered, ["fixture_deploy/deploy_token"], "its run records the names it was given");
    assert.ok(!JSON.stringify(ev).includes(TOKEN), "and never a value");
    await H.stopSession(org.orgId, s.id, owner as never).catch(() => null);
    await Promise.race([w.done, sleep(15_000)]);
    ok("a workspace owner's session receives the profile's credential in each wake's env, redacted from what it writes; its run records the names it was given, never a value");
  }

  // ---------- 3. a member's session receives none ----------
  {
    const s = await H.startSession(org.orgId, member as never, { message: "env DEPLOY_TOKEN", profile: "deployer", mode: "task" });
    assert.deepEqual(s.policy.credentials, [], "a member's session receives none");
    const w = await wakeOf(s.id);
    await until("the agent answers", async () => (await agentSaid(s.id, member)).length > 0);
    assert.match((await agentSaid(s.id, member)).join("\n"), /Env DEPLOY_TOKEN: unset/, "its env has none");
    const ev = await asPlatform(() => db.query<{ type: string }>("SELECT type FROM run_events WHERE run_id = $1", [w.claim.run.id]));
    assert.ok(!ev.some((e) => e.type === "credentials"), "its run asks for none");
    await H.stopSession(org.orgId, s.id, member as never).catch(() => null);
    await Promise.race([w.done, sleep(15_000)]);
    ok("a member's session with the same profile receives no credential");
  }
  F.setFeaturesForTest(null);
  console.log("\nagent sessions' credentials (mold_v0-262): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
