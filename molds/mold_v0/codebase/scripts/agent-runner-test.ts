// The agent-workspace runner (mold_v0-061; src/agent-workspace.ts, src/agent-workspace-config.ts, src/run-harness.ts),
// offline: an embedded database, a local object store, a fake model upstream behind the real gateway, and a tiny agent
// repository (scripts/fixtures/agent-repo: a command that writes JSON into its workspace and a validator) committed
// into a local bare git repository.
//   npm run test:agent-runner
//
//  1. definePack refuses a configuration that would get past the runner: a branch, tag or short id as the pin, an
//     address that is not https, an undeclared placeholder, a variable the shell sets, a gateway placeholder without
//     its provider, a time limit past the run's deadline, a write-back path outside the checkout.
//  2. The pin: the fetch yields exactly the pinned commit (not the branch's tip, not a branch named like the pin); a pin
//     the repository does not have, a redirect, a file:// repository the runner was not told to accept: refused.
//  3. A run end to end, as the run's own user: fetched at the pin, stripped, the workspace restored, the declared
//     arguments, the gateway token under the declared names, credentials (variable and tmpfs file), validated, written
//     back (only the write-back paths), results (two findings on one check x asset, told apart by fingerprint),
//     transcript and usage recorded; the next run sees the workspace it wrote.
//  4. Validation gates the write-back: a run whose validation fails leaves the version where it was; so does a run
//     whose command fails, and one pinned to a commit the repository lacks.
//  5. The time limit: past it every process of the run (one in its own session too) is killed; the run fails "timeout".
//  6. Redaction: credential values and the gateway token printed, in results, in stderr: none stored; one written into
//     the workspace: not written back.
//  7. Links: a link planted in the write-back paths is not followed nor written back; paths outside them are not
//     written back.
//  8. Egress: the run's proxy lets the kind's host past its list and refuses any other.
//  9. Two workspaces: each run sees only its own workspace's files; each store holds only its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];

/** The fixture agent repository: commit 1 (the agent), commit 2 (a different program at the branch's tip). */
function agentRepo() {
  const src = path.join(TMP, "agent-src"), bare = path.join(TMP, "agent.git");
  mkdirSync(path.join(src, "samples"), { recursive: true });
  for (const f of ["agent.mjs", "validate.mjs"]) copyFileSync(path.join(ROOT, "scripts", "fixtures", "agent-repo", f), path.join(src, f));
  writeFileSync(path.join(src, "secret.txt"), "stripped before the run\n");
  writeFileSync(path.join(src, "samples", "example.json"), "{}\n");
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: src, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "the agent");
  const c1 = g("rev-parse", "HEAD");
  writeFileSync(path.join(src, "agent.mjs"), "console.log(JSON.stringify({ event: 'seen', impostor: true })); require('fs').writeFileSync('IMPOSTOR', '1');\n");
  g("commit", "-qam", "another program at the tip");
  const c2 = g("rev-parse", "HEAD");
  // A branch whose name is the pin, pointing at the other commit: a name must never stand for the pin.
  g("branch", c1, c2);
  spawnSync("git", ["clone", "-q", "--bare", src, bare], { env: { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { url: `file://${bare}`, c1, c2 };
}

try {
  const repo = agentRepo();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const aw = await import("../src/agent-workspace.js");
  const store = await import("../src/workspace-store.js");
  const rec = await import("../src/record-areas.js");
  const creds = await import("../src/credentials.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Agent A ${STAMP}`)).org, B = (await createOrg(`Agent B ${STAMP}`)).org;

  const agent = (extra: Record<string, unknown> = {}) => ({
    repository: repo.url, commit: repo.c1, strip: ["secret.txt", "samples/**", "data/*/forbidden.json"],
    command: ["node", "agent.mjs", "--company", "{company}", "--mode", "{mode}"],
    args: { company: { from: "targets.company", pattern: "[a-z][a-z0-9-]{1,30}" }, mode: { from: "scope.mode", default: "ok" } },
    env: { ANTHROPIC_BASE_URL: "{gateway.anthropic.base_url}", ANTHROPIC_AUTH_TOKEN: "{gateway.token}", AGENT_FIXED: "1" },
    validate: { command: ["node", "validate.mjs"], timeout_seconds: 60 },
    write_back: ["data"], results: "out/results.json", record: ["sessions/*.summary.json"], timeout_seconds: 60, ...extra,
  });
  const kind = (name: string, extra: Record<string, unknown> = {}, agentExtra: Record<string, unknown> = {}) => ({
    name, runner: "agent-workspace", providers: ["anthropic"], lease_seconds: 15, egress: ["api.agent-allowed.example"],
    credentials: ["agent_token", "agent_key"], agent: agent(agentExtra), ...extra });

  // ---------- 1. definePack refuses ----------
  {
    const pack = (k: Record<string, unknown>) => definePack({ id: "pk", agentJobKinds: [k as never] });
    const bad = (a: Record<string, unknown>, k: Record<string, unknown> = {}) => pack({ name: "kk", runner: "agent-workspace", providers: ["anthropic"], agent: { ...agent(), ...a }, ...k });
    assert.throws(() => bad({ commit: "main" }), /full commit id/);
    assert.throws(() => bad({ commit: repo.c1.slice(0, 12) }), /full commit id/);
    assert.throws(() => bad({ commit: "v1.0.0" }), /full commit id/);
    assert.throws(() => bad({ repository: "http://example.com/x.git" }), /https/);
    assert.throws(() => bad({ repository: "https://user:pw@example.com/x.git" }), /https/);
    assert.throws(() => bad({ repository: "git@github.com:x/y.git" }), /https/);
    assert.throws(() => bad({ command: ["node", "agent.mjs", "{nope}"] }), /not a declared argument/);
    assert.throws(() => bad({ validate: { command: ["node", "v.mjs", "{company}"] } }), /takes no placeholders/);
    assert.throws(() => bad({ command: ["{mode}", "agent.mjs"] }), /first element\) takes no placeholder/);
    assert.throws(() => bad({ env: { PATH: "/x" } }), /set by the shell/);
    assert.throws(() => bad({ env: { NODE_OPTIONS: "--require x" } }), /set by the shell/);
    assert.throws(() => bad({ env: { X_TOKEN: "{gateway.token}" } }, { providers: [] }), /needs a gateway provider/);
    assert.throws(() => bad({ env: { X_URL: "{gateway.openai.base_url}" } }), /not one of the kind's providers/);
    assert.throws(() => bad({ timeout_seconds: 7200 }, { token_lifetime_seconds: 3600 }), /longer than token_lifetime_seconds/);
    assert.throws(() => bad({ write_back: ["../outside"] }), /inside the checkout/);
    assert.throws(() => bad({ write_back: ["/etc"] }), /inside the checkout/);
    assert.throws(() => bad({ write_back: ["data", "data/x"] }), /inside data/);
    assert.throws(() => bad({}, { workspace: false }), /workspace/);
    assert.doesNotThrow(() => bad({}));
    console.log("✓ definePack refuses a branch, tag or short id as the pin, non-https addresses, undeclared placeholders, the shell's variables, gateway placeholders without their provider, a limit past the deadline, paths outside the checkout");
  }

  // ---------- 2. the pin ----------
  {
    const dest = (n: string) => path.join(TMP, `fetch-${n}`, "checkout");
    const got = await aw.fetchPinned(repo.url, repo.c1, dest("ok"), { allowFile: true });
    assert.equal(got.commit, repo.c1);
    const { readFileSync, existsSync } = await import("node:fs");
    assert.ok(readFileSync(path.join(dest("ok"), "agent.mjs"), "utf8").includes("A tiny agent repository"), "the pinned commit's files, not the branch tip's nor the branch named like the pin");
    assert.ok(!existsSync(path.join(dest("ok"), ".git")), "no .git in the checkout");
    const tip = await aw.fetchPinned(repo.url, repo.c2, dest("tip"), { allowFile: true });
    assert.ok(readFileSync(path.join(dest("tip"), "agent.mjs"), "utf8").includes("impostor") && tip.commit === repo.c2, "(the other commit is really different)");
    await assert.rejects(aw.fetchPinned(repo.url, "0".repeat(40), dest("missing"), { allowFile: true }), (e: Error) => e instanceof aw.AgentRunError && /could not be fetched/.test(e.message) && (e as InstanceType<typeof aw.AgentRunError>).kind === "run");
    await assert.rejects(aw.fetchPinned(repo.url, repo.c1, dest("nofile")), /must be fetched over https/, "file:// only when the runner allows it");
    await assert.rejects(aw.fetchPinned(repo.url, "main", dest("name")), /full commit id/);
    await assert.rejects(aw.fetchPinned(`https://10.0.0.5/agent.git`, repo.c1, dest("ip")), /an address or a local name/, "never an address: the runner fetches outside the run's proxy");
    await assert.rejects(aw.fetchPinned(`https://git.internal/agent.git`, repo.c1, dest("local")), /an address or a local name/);
    process.env.OCTILLION_AGENT_REPO_HOSTS = "github.com";
    await assert.rejects(aw.fetchPinned(`https://example.com/agent.git`, repo.c1, dest("allow")), /not in OCTILLION_AGENT_REPO_HOSTS/);
    delete process.env.OCTILLION_AGENT_REPO_HOSTS;
    // A redirect: the first server answers every request with a 302 to the second; the second is never reached.
    let followed = 0;
    const target = createServer((_q, r) => { followed++; r.writeHead(404).end(); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const redirector = createServer((q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}${q.url}` }).end(); });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    await assert.rejects(aw.fetchPinned(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}/agent.git`, repo.c1, dest("redirect"), { allowHttp: true }), /could not be fetched/);
    assert.equal(followed, 0, "a redirect is never followed");
    redirector.close(); target.close();
    console.log("✓ the pin: exactly the pinned commit (never a branch's tip or a branch named like it); a missing commit, a redirect, an unallowed file:// repository: refused");
  }

  // ---------- the fixture pack ----------
  const fixture = definePack({
    id: "fixture_agent",
    recordAreas: [
      { name: "agent_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "agent_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    credentials: [
      { name: "agent_token", label: "Token", bound_to: "workspace", deliver_as: { env: "FIXTURE_AGENT_TOKEN" } },
      { name: "agent_key", label: "Key", bound_to: "workspace", deliver_as: { file: "agent_key.pem" } },
    ],
    agentJobKinds: [kind("audit"), kind("audit_short", {}, { timeout_seconds: 10 }), kind("audit_badpin", {}, { commit: "1".repeat(40) }),
      kind("audit_quiet", { credentials: [], providers: [], egress: [] }, { env: { AGENT_FIXED: "1" } }),
      kind("audit_default", {}, { results: undefined })] as never,
    tools: [
      defineTool({ name: "fixture_agent_run", description: "Start a run (test).", inputSchema: { kind: z.string(), mode: z.string().optional(), company: z.string() },
        handler: async (_ws, { kind: k, mode, company }, { runs: r }) => r.start(k, { scope: mode ? { mode } : {}, targets: { company } }) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_agent", name: "Fixture agent", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "agent-repo") }, definition: fixture }]);
  await rec.putPlatform(null, "agent_checks", "c1", { title: "A check", data: { summary: "x" } });
  for (const [o, co] of [[A, "a-co"], [B, "b-co"]] as const)
    await withTenant(o.orgId, () => rec.workspaceRecords("fixture_agent", o.orgId).put("agent_apps", `${co}-app`, { title: co, data: { url: `https://${co}.example` } }));
  const secret = { A_TOKEN: `canary-a-token-${STAMP}-0123456789`, A_KEY: `canary-a-key-${STAMP}-abcdefghij`, B_TOKEN: `canary-b-token-${STAMP}-9876543210`, B_KEY: `canary-b-key-${STAMP}-jihgfedcba` };
  await creds.setCredential(A.orgId, null, { pack: "fixture_agent", name: "agent_token", value: secret.A_TOKEN });
  await creds.setCredential(A.orgId, null, { pack: "fixture_agent", name: "agent_key", value: secret.A_KEY });
  await creds.setCredential(B.orgId, null, { pack: "fixture_agent", name: "agent_token", value: secret.B_TOKEN });
  await creds.setCredential(B.orgId, null, { pack: "fixture_agent", name: "agent_key", value: secret.B_KEY });

  const upstream = createServer((req, res) => { req.resume().on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}")); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const kv = await import("../src/keyvault.js");
  await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
  await kv.setCredential("anthropic", "sk-fixture-real-key");

  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, k: string, company: string, mode?: string) => {
    const r = await c.call("fixture_agent_run", { kind: k, company, ...(mode ? { mode } : {}) });
    assert.ok(!r.isError, r.content[0]?.text);
    return r.structuredContent as { id: string };
  };
  const client = await harness.localRunnerClient("w-agent");
  const asRoot = process.getuid?.() === 0;
  const iso = asRoot ? { runAs: { uid: 65534, gid: 65534 } } : { allowSameUser: true };
  const runNext = async (k: string, opts: Parameters<typeof harness.runWorkspaceHarness>[2] = {}) => {
    const c = await client.claim([`fixture_agent/${k}`]);
    assert.ok(c, `a run of ${k} to claim`);
    return { claim: c!, view: await harness.runWorkspaceHarness(client, c!, { egress: "off", allowFileUpstream: true, ...iso, ...opts }) };
  };
  const eventsOf = async (id: string) => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const ev = async (id: string, type: string) => (await eventsOf(id)).filter((e) => e.type === type).map((e) => e.data);
  const latest = (o: number) => store.latestSnapshot(db, o, "fixture_agent");
  const filesOf = async (o: number) => { const s = await latest(o); return s ? Object.keys(s.manifest).sort() : []; };

  try {
    // ---------- 3. a run end to end ----------
    let tokenOfFirst = "";
    {
      await start(ca, "audit", "a-co");
      const r1 = await runNext("audit");
      assert.equal(r1.view?.status, "succeeded", JSON.stringify(r1.view));
      tokenOfFirst = r1.claim.gateway.token!;
      const seen = (await ev(r1.claim.run.id, "seen"))[0];
      assert.deepEqual(seen.notes, null, "a workspace's first run starts empty");
      assert.deepEqual(seen.stripped, { secret: false, samples: false }, "the declared paths were stripped before the run");
      assert.deepEqual(seen.argv, ["--company", "a-co", "--mode", "ok"], "the declared arguments, from the run's targets and the default");
      if (asRoot) assert.equal(seen.uid, 65534, "the agent ran as the run's user");
      const env = (await ev(r1.claim.run.id, "env"))[0];
      assert.deepEqual(env, { has_gateway_token: true, base_url: `${http.base}/gw/anthropic`, fixed: "1", token_cred: "set", cred_file: "set" },
        "the gateway token and address under the declared names; both credentials delivered");
      const checkout = (await ev(r1.claim.run.id, "agent_checkout"))[0];
      assert.equal(checkout.commit, repo.c1, "checked out at the pin");
      assert.deepEqual(await filesOf(A.orgId), ["data/a-co/notes.json"], "only the write-back paths are written back");
      assert.equal((await latest(A.orgId))!.version, 1);
      const rec1 = await ev(r1.claim.run.id, "agent_file");
      assert.equal(rec1.length, 1); assert.equal(rec1[0].path, `sessions/${r1.claim.run.id}.summary.json`); assert.equal(rec1[0].json.turns, 3, "the session summary is recorded");
      const use = (await ev(r1.claim.run.id, "agent_usage"))[0];
      assert.ok(use.command_ms >= 0 && use.validate_exit === 0 && use.exit === 0, JSON.stringify(use));
      const rows = await db.query<{ finding_fingerprint: string; asset_key: string }>("SELECT finding_fingerprint, asset_key FROM run_results WHERE run_id = $1 ORDER BY finding_fingerprint", [r1.claim.run.id]);
      assert.deepEqual(rows.map((x) => x.finding_fingerprint), ["fp-1", "fp-2"], "two findings on one check x asset stay two rows (mold_v0-065)");
      const tok = await db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM gateway_tokens WHERE run_id = $1", [r1.claim.run.id]);
      assert.ok(tok.length === 1 && tok[0]!.revoked_at, "the run's gateway token is revoked when it ends");

      await start(ca, "audit", "a-co");
      const r2 = await runNext("audit");
      assert.equal(r2.view?.status, "succeeded");
      assert.deepEqual((await ev(r2.claim.run.id, "seen"))[0].notes, [r1.claim.run.id], "the next run had the workspace it wrote restored");
      assert.equal((await latest(A.orgId))!.version, 2);
      console.log(`✓ a run end to end${asRoot ? " as the run's user (65534)" : ""}: at the pin, stripped, restored, arguments, gateway token and credentials by declared name, validated, only the write-back paths written back, results, transcript and usage recorded; the next run sees its workspace`);
    }

    // ---------- 4. validation and failures gate the write-back ----------
    {
      const before = (await latest(A.orgId))!.version;
      await start(ca, "audit", "a-co", "invalid");
      const r = await runNext("audit");
      assert.equal(r.view?.status, "failed"); assert.equal(r.view?.error_kind, "validation", JSON.stringify(r.view));
      assert.equal((await latest(A.orgId))!.version, before, "a failed validation writes nothing back");
      await start(ca, "audit", "a-co", "fail");
      const f = await runNext("audit");
      assert.equal(f.view?.error_kind, "run"); assert.equal((await latest(A.orgId))!.version, before, "nor a failed command");
      await start(ca, "audit_badpin", "a-co");
      const p = await runNext("audit_badpin");
      assert.equal(p.view?.status, "failed"); assert.equal(p.view?.error_kind, "run", "a pin the repository lacks is final, not retried");
      assert.match(p.view!.error!, /pinned commit 111111111111 could not be fetched/);
      assert.equal((await latest(A.orgId))!.version, before, "nor a run whose pin could not be fetched");
      const stillOk = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_results WHERE run_id = ANY($1)", [[r.claim.run.id, f.claim.run.id, p.claim.run.id]]))[0]!.n;
      assert.equal(stillOk, 0, "and none of them has results");
      console.log("✓ validation gates the write-back: a failed validation, a failed command or an unfetchable pin leave the version where it was");
    }

    // ---------- 5. the time limit ----------
    {
      await start(ca, "audit_short", "a-co", "sleep");
      const t0 = Date.now();
      const r = await runNext("audit_short");
      assert.equal(r.view?.status, "failed"); assert.equal(r.view?.error_kind, "timeout", JSON.stringify(r.view));
      assert.ok(Date.now() - t0 < 40_000, "stopped at its limit");
      const child = (await ev(r.claim.run.id, "child"))[0]?.pid as number;
      assert.ok(child > 0);
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (asRoot) assert.ok(!alive(child), "a process it started in its own session is gone too");
      else if (alive(child)) process.kill(child, "SIGKILL");
      console.log(`✓ the time limit: past it the run fails "timeout"${asRoot ? " and every process of the run is killed (one in its own session too)" : ""}`);
    }

    // ---------- 6. redaction ----------
    {
      await start(ca, "audit", "a-co", "leak");
      const r = await runNext("audit");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const token = r.claim.gateway.token!;
      const all = JSON.stringify(await db.query("SELECT type, data FROM run_events WHERE run_id = $1", [r.claim.run.id])) + JSON.stringify(await db.query("SELECT * FROM run_results WHERE run_id = $1", [r.claim.run.id]));
      for (const v of [secret.A_TOKEN, secret.A_KEY, token, tokenOfFirst]) assert.ok(!all.includes(v), `no value in the run's events or results (${v.slice(0, 14)}...)`);
      assert.ok(all.includes("value: [credential agent_token]") && all.includes("[credential gateway token]") && all.includes("[credential agent_key]"), "the lines are there, redacted");
      await start(ca, "audit", "a-co", "leak_ws");
      const w = await runNext("audit");
      assert.equal(w.view?.status, "failed"); assert.match(w.view!.error!, /holds the value of credential agent_token: it is not written back/);
      assert.ok(!(await filesOf(A.orgId)).some((f) => f.includes("stolen")));
      console.log("✓ redaction: credential values and the gateway token, printed, in stderr or in results, are never stored; one written into the workspace is not written back");
    }

    // ---------- 7. links and paths outside the write-back ----------
    {
      const before = (await latest(A.orgId))!.version;
      await start(ca, "audit", "a-co", "symlink");
      const r = await runNext("audit");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const skipped = (await ev(r.claim.run.id, "workspace_skipped"))[0].skipped.map((s: { path: string }) => s.path).sort();
      assert.deepEqual(skipped, ["data/a-co/planted", "data/escape"], "the planted links are named and left out");
      assert.equal((await latest(A.orgId))!.version, before! + 1);
      assert.deepEqual(await filesOf(A.orgId), ["data/a-co/notes.json"], "no link and nothing through one is written back");
      await start(ca, "audit", "a-co", "outside");
      await runNext("audit");
      assert.deepEqual(await filesOf(A.orgId), ["data/a-co/notes.json"], "a path outside the write-back paths is not written back");
      console.log("✓ links planted in the write-back paths are neither followed nor written back; paths outside them are not written back");
    }

    // ---------- 8. egress ----------
    {
      await start(ca, "audit", "a-co", "egress");
      let log = "";
      const r = await runNext("audit", { egress: "proxy", onProxyLog: (l) => (log = l) });
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const e = (await ev(r.claim.run.id, "egress"))[0];
      assert.match(e.other, /^HTTP\/1\.1 403/, "another host: refused by the run's proxy");
      const decisions = log.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (process.env.AGENT_TEST_VERBOSE) console.log(log, e);
      const mine = decisions.filter((d) => d.allow === "api.agent-allowed.example" || d.deny?.startsWith("api.agent-allowed.example"));
      // Past the list, the proxy resolves it (offline: no such name, so "dns"): never "host not allowed".
      assert.ok(mine.length && mine.every((d) => d.why !== "host not allowed"), `the kind's host passes the allowlist (${JSON.stringify(mine)})`);
      assert.ok(decisions.some((d) => d.deny?.startsWith("elsewhere.example") && d.why === "host not allowed"), "any other is refused by it");
      console.log("✓ egress: the kind's host passes the run's proxy; any other is refused (enforced for programs that use the proxy; see MOLD.md)");
    }

    // ---------- 9. two workspaces ----------
    {
      await start(cb, "audit", "b-co");
      const rb = await runNext("audit");
      assert.equal(rb.view?.status, "succeeded", JSON.stringify(rb.view));
      const seen = (await ev(rb.claim.run.id, "seen"))[0];
      assert.deepEqual([seen.notes, seen.data], [null, []], "B's first run sees nothing of A's workspace");
      assert.deepEqual(await filesOf(B.orgId), ["data/b-co/notes.json"], "B's store holds only B's files");
      assert.ok((await filesOf(A.orgId)).every((f) => !f.includes("b-co")), "A's holds none of B's");
      const envB = (await ev(rb.claim.run.id, "env"))[0];
      assert.equal(envB.token_cred, "set");
      // The company argument is checked: B cannot aim its run at a path of its own choosing.
      await start(cb, "audit", "../a-co");
      const bad = await runNext("audit");
      assert.equal(bad.view?.status, "failed"); assert.match(bad.view!.error!, /argument company: (the value does not match its pattern|a value may not hold a "\.\." path part)/);
      // A kind with no credentials and no providers gets neither.
      await start(cb, "audit_quiet", "b-co");
      const q = await runNext("audit_quiet");
      assert.equal(q.view?.status, "succeeded", JSON.stringify(q.view));
      assert.deepEqual((await ev(q.claim.run.id, "env"))[0], { has_gateway_token: false, base_url: null, fixed: "1", token_cred: "unset", cred_file: "unset" });
      console.log("✓ two workspaces: each run sees only its own workspace's files, each store holds only its own; an argument outside its pattern is refused");
    }
    // ---------- 10. what the review found (adversarial review of 061) ----------
    {
      const before = (await latest(A.orgId))!.version;
      // The agent rewrites its own validator to pass anything, then writes a broken file: the validation runs on the
      // pinned tree, not on the agent's, so the write-back is refused.
      await start(ca, "audit", "a-co", "tamper");
      const t = await runNext("audit");
      assert.equal(t.view?.error_kind, "validation", `a tampered validator changes nothing: ${JSON.stringify(t.view)}`);
      assert.equal((await latest(A.orgId))!.version, before);
      // A named pipe where the runner reads its default results: refused at once, the runner does not hang.
      await start(ca, "audit_default", "a-co", "fifo");
      const t0 = Date.now();
      const f = await runNext("audit_default");
      assert.equal(f.view?.status, "failed"); assert.match(f.view!.error!, /results\.json is not a plain file/); assert.ok(Date.now() - t0 < 30_000);
      // A stripped path written into the workspace never reaches the store (nor comes back in a later run).
      await start(ca, "audit", "a-co", "forbidden");
      const s = await runNext("audit");
      assert.equal(s.view?.status, "succeeded", JSON.stringify(s.view));
      assert.ok(!(await filesOf(A.orgId)).some((x) => x.includes("forbidden")), "a stripped path is not written back");
      // Past the store's size limit: refused before it is read whole.
      process.env.OCTILLION_WORKSPACE_MAX_BYTES = String(1024 * 1024);
      await start(ca, "audit", "a-co", "big");
      const b = await runNext("audit");
      delete process.env.OCTILLION_WORKSPACE_MAX_BYTES;
      assert.equal(b.view?.status, "failed"); assert.match(b.view!.error!, /more than 1048576 bytes: it is not written back/);
      // An argument with a ".." part, even where its pattern would take it.
      await start(ca, "audit", "a-co", "x/../y");
      const d = await runNext("audit");
      assert.match(d.view!.error!, /a value may not hold a "\.\." path part/);
      console.log("✓ review fixes: a validator the agent rewrote is not the one run; a pipe for results is refused without hanging; a stripped path never reaches the store; the size limit holds before reading; no \"..\" in an argument");
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close(); upstream.close();
  }
  await db.close();
  console.log("AGENT RUNNER TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
