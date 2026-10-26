// Agent-workspace runs read result files, declare tools, write inputs and run credentialed steps with a checkout cache
// (mold_v0-071..074; src/agent-workspace-steps.ts, src/run-tools.ts, src/run-harness.ts), offline: an embedded
// database, a local object store, the fixture program (scripts/fixtures/agent-repo/steps.mjs) committed into a local git
// repository, local repositories for the checkout cache (file://, and one behind git's own HTTP backend that asks for
// a token), stand-in tool artifacts on a local HTTP server. No model, no cloud, no provider.
//   npm run test:agent-steps
//
//  1. definePack refuses what would get past the runner: results_from with results, an undeclared {$args.x}, a tool
//     outside the catalogue, an input under a write-back path or from an undeclared argument, a step credential the
//     kind does not have, a git host or checkout host outside the egress, steps longer than the deadline, a schema
//     keyword outside the subset, a checkout mount without {name}.
//  2. 071 results_from: the program's result object under <RUN_OUT>, the findings list at a JSON pointer, mapped into
//     run_results (check, asset, status through the map, fingerprint, evidence, detail from the item and the file's
//     root); every file under <RUN_OUT> recorded; an unmappable item fails a "reject" kind; forged items (another
//     workspace's asset, a missing check, a status outside the map, a bad fingerprint, a prototype key, a non-object)
//     never land under "drop"; a missing file, a link for the file; a credential in the file is redacted.
//  3. 073 inputs: a spec in the run's scope written to a new file of the checkout, checked against its schema, reaches
//     the step that reads it; refused: a schema violation, past its size, a credential's value, over a file of the
//     pinned tree, through a link of the tree. Never written back.
//  4. 074 steps: each step gets only its credentials; git gets its token through the helper (the declared host only,
//     never in a variable or an argument; the helper's files gone after the step); the runner's checkout step fetches
//     the manifests' repositories at their pins (one behind a token, sent only by the helper) into the workspace's cache,
//     links them read-only, never writes them back; a second run uses the cache; another workspace has its own cache and
//     cannot read this one's; refused: a host off the list, a short commit, a repository over its size; the cache is
//     capped (least recently used go) and cleaned (old entries, unfinished fetches); a failing or slow step fails the run.
//  5. 072 tools: a kind's pinned tool (a stand-in installed through installTools with its checksum) is first on the
//     run's PATH; a kind whose tool the image lacks, or whose installed file changed, is refused before anything runs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
/** AGENT_STEPS_ONLY=071,074 runs those sections only (to show each fails without its change); all by default. */
const want = (t: string) => !process.env.AGENT_STEPS_ONLY || process.env.AGENT_STEPS_ONLY.split(",").includes(t);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const GIT_ENV = { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A bare repository with `files`, one commit: its file:// address, its directory and its commit. */
function repo(name: string, files: Record<string, string | Buffer>, link?: [string, string]) {
  const src = path.join(TMP, `${name}-src`), bare = path.join(TMP, "repos", `${name}.git`);
  mkdirSync(src, { recursive: true });
  for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); writeFileSync(path.join(src, f), body); }
  if (link) symlinkSync(link[1], path.join(src, link[0]));
  git(src, "init", "-q", "-b", "main"); git(src, "add", "."); git(src, "commit", "-qm", name);
  const commit = git(src, "rev-parse", "HEAD");
  mkdirSync(path.dirname(bare), { recursive: true });
  spawnSync("git", ["clone", "-q", "--bare", src, bare], { env: GIT_ENV });
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(bare, "config", "http.receivepack", "false");
  return { url: `file://${bare}`, bare, commit, name: `${name}.git` };
}

/** git's own HTTP backend behind Basic auth: only `x-access-token:<token>` gets in. */
function gitHttp(projectRoot: string, token: string) {
  const seen = { authed: 0, refused: 0 };
  const want = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const srv = createServer((req, res) => {
    if (req.headers.authorization !== want) { seen.refused++; req.resume(); res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end(); return; }
    seen.authed++;
    const u = new URL(req.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_NOSYSTEM: "1", GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "x", REMOTE_ADDR: "127.0.0.1",
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""), HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? "") } });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c: Buffer) => chunks.push(c));
    cgi.on("close", () => {
      const all = Buffer.concat(chunks), cut = all.indexOf("\r\n\r\n");
      const head = all.subarray(0, cut).toString("utf8"), body = all.subarray(cut + 4);
      const headers: Record<string, string> = {};
      let status = 200;
      for (const l of head.split("\r\n")) { const i = l.indexOf(":"); const k = l.slice(0, i).trim(), v = l.slice(i + 1).trim(); if (/^status$/i.test(k)) status = Number(v.split(" ")[0]); else if (k) headers[k] = v; }
      res.writeHead(status, headers).end(body);
    });
  });
  return { srv, seen };
}

try {
  // ---------- the program, the repositories, the stand-in tools ----------
  const progSrc: Record<string, string> = {};
  for (const f of ["agent.mjs", "validate.mjs", "steps.mjs"]) progSrc[f] = (await import("node:fs")).readFileSync(path.join(ROOT, "scripts", "fixtures", "agent-repo", f), "utf8");
  const prog = repo("program", progSrc, ["linkdir", "/tmp"]);
  const one = repo("one", { "README.md": "repo one\n" });
  const two = repo("two", { "README.md": "repo two\n" });
  const big = repo("big", { "README.md": "big\n", "blob.bin": Buffer.alloc(2 * 1024 * 1024, 7) });
  const priv = repo("private", { "README.md": "repo private\n" });
  const GIT_TOKEN = `canary-git-token-${STAMP}-0123456789abcdef`;
  const gh = gitHttp(path.join(TMP, "repos"), GIT_TOKEN);
  await new Promise<void>((r) => gh.srv.listen(0, "127.0.0.1", r));
  const privUrl = `http://127.0.0.1:${(gh.srv.address() as AddressInfo).port}/private.git`;

  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const store = await import("../src/workspace-store.js");
  const rec = await import("../src/record-areas.js");
  const creds = await import("../src/credentials.js");
  const tools = await import("../src/run-tools.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Steps A ${STAMP}`)).org, B = (await createOrg(`Steps B ${STAMP}`)).org;

  // Stand-in tool artifacts, served locally; a test catalogue pins their sha256 (the real one pins the real releases).
  const sopsBody = Buffer.from("#!/bin/sh\necho 'sops 3.13.3 (stand-in)'\n");
  const artifacts: Record<string, Buffer> = { "/sops": sopsBody };
  const art = createServer((q, r) => { const b = artifacts[q.url!]; if (!b) r.writeHead(404).end(); else r.writeHead(200).end(b); });
  await new Promise<void>((r) => art.listen(0, "127.0.0.1", r));
  const artUrl = `http://127.0.0.1:${(art.address() as AddressInfo).port}`;
  const arch = tools.toolArch();
  const catalog = {
    git: tools.RUN_TOOL_CATALOG.git!,
    sops: { version: "3.13.3", format: "binary" as const, bins: { sops: "sops" }, source: "stand-in", artifacts: { [arch]: { url: `${artUrl}/sops`, sha256: sha(sopsBody), bytes: sopsBody.length } } },
    kubectl: { version: "1.37.1", format: "binary" as const, bins: { kubectl: "kubectl" }, source: "stand-in", artifacts: { [arch]: { url: `${artUrl}/kubectl`, sha256: "0".repeat(64), bytes: 1 } } },
  };
  // Where the run's user can reach it (as /opt/app-tools): not inside the test's own 0700 directory.
  const toolsRoot = mkdtempSync(path.join(tmpdir(), "steps-tools-"));
  chmodSync(toolsRoot, 0o755);
  const toolsDir = path.join(toolsRoot, "app-tools");
  await tools.installTools(["sops"], { dir: toolsDir, catalog });
  const runTools = { dir: toolsDir, catalog };

  const baseAgent = (extra: Record<string, unknown> = {}) => ({
    repository: prog.url, commit: prog.commit, strip: [],
    command: ["node", "steps.mjs", "main", "--company", "{company}", "--mode", "{mode}"],
    args: { company: { from: "targets.company", pattern: "[a-z][a-z0-9-]{1,30}" }, mode: { from: "scope.mode", default: "ok" },
      other: { from: "scope.other", default: "none", pattern: "none|(/[A-Za-z0-9._-]+)+" } },
    env: { STEPS_FIXED: "1" }, validate: { command: ["node", "validate.mjs"], timeout_seconds: 60 }, write_back: ["data"], timeout_seconds: 60, ...extra,
  });
  const kind = (name: string, agentExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    name, runner: "agent-workspace", providers: [], lease_seconds: 15, token_lifetime_seconds: 3600,
    egress: ["git.allowed.example", "api.agent-allowed.example"], credentials: ["agent_token", "agent_key", "git_token"], agent: baseAgent(agentExtra), ...extra });
  const resultsFrom = {
    file: "program-result.json", pointer: "/findings", where: { field: "kind", in: ["finding"] },
    check: { area: "steps_checks", key: "{control}" }, asset: { area: "steps_apps", key: "{app}" },
    status: { from: "status", map: { open: "fail", resolved: "pass" } }, fingerprint: "{fingerprint}", evidence: "ledger:{id}",
    detail: { title: "{title}", severity: "{severity}", workflow: "{$root.workflow}", company: "{$args.company}" },
  };
  const specSchema = { type: "object", required: ["appId", "repos"], additionalProperties: false, properties: {
    appId: { type: "string", pattern: "^[a-z][a-z0-9-]{1,40}$" },
    repos: { type: "array", maxItems: 8, items: { type: "object", required: ["repoId", "url", "pinnedCommit"], additionalProperties: false, properties: {
      repoId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,40}$" }, url: { type: "string", maxLength: 2000 }, pinnedCommit: { type: "string", pattern: "^[0-9a-f]{40}$" } } } } } };
  const inputs = { spec: { from: "scope.spec", path: ".app-inputs/spec.json", schema: specSchema, max_bytes: 4096 } };
  const checkout = { manifests: "data/{company}/repos/*.json", url: "url", commit: "pinnedCommit", name: "repoId", mount: "data/{company}/repos/{name}",
    hosts: ["git.allowed.example"], credential: "git_token", max_bytes: 1024 * 1024, source: "checkout" };
  const steps = [
    { name: "add", command: ["node", "steps.mjs", "add", ".app-inputs/spec.json", "--company", "{company}"] },
    { name: "gitfill", command: ["node", "steps.mjs", "gitfill", "git.allowed.example"], git_credentials: [{ credential: "agent_token", host: "git.allowed.example" }] },
    { name: "checkout", checkout },
    { name: "read", command: ["node", "steps.mjs", "readrepo", "data/{company}/repos/one", "{other}"] },
  ];

  // ---------- 1. definePack refuses ----------
  {
    const pack = (k: Record<string, unknown>) => definePack({ id: "pk", credentials: [{ name: "agent_token", label: "T", bound_to: "workspace", deliver_as: { env: "T_TOKEN" } }], agentJobKinds: [k as never] });
    const bad = (a: Record<string, unknown>, k: Record<string, unknown> = {}) => pack({ ...kind("kk", a), credentials: ["agent_token"], ...k });
    assert.throws(() => bad({ results_from: resultsFrom, results: "out/x.json" }), /results_from and results both/);
    assert.throws(() => bad({ results_from: { ...resultsFrom, evidence: "{$args.nope}" } }), /\{\$args\.nope\} is not a declared argument/);
    assert.throws(() => bad({ results_from: { ...resultsFrom, status: { from: "status", map: { open: "broken" } } } }), /status/);
    assert.throws(() => bad({ results_from: { ...resultsFrom, file: "../escape.json" } }), /inside the checkout/);
    assert.throws(() => bad({ tools: ["terraform"] }), /tools/);
    assert.throws(() => bad({ inputs: { spec: { ...inputs.spec, path: "data/spec.json" } } }), /under a write-back path/);
    assert.throws(() => bad({ inputs: { spec: { ...inputs.spec, path: "../spec.json" } } }), /inside the checkout/);
    assert.throws(() => bad({ inputs: { spec: { ...inputs.spec, schema: { $ref: "http://evil.example/s.json" } } } }), /\$ref|Unrecognized/i);
    assert.throws(() => bad({ inputs }, { args: [{ name: "other", label: "Other", type: "text" }] }), /scope\.spec is not one of the kind's arguments/);
    assert.throws(() => bad({ steps: [{ name: "s", command: ["true"], credentials: ["agent_key"] }] }), /agent_key is not one of the kind's credentials/);
    assert.throws(() => bad({ steps: [{ name: "s", command: ["true"], git_credentials: [{ credential: "agent_token", host: "github.com" }] }] }), /github\.com is not in the kind's egress/);
    assert.throws(() => bad({ steps: [{ name: "s", checkout: { ...checkout, credential: "agent_token", hosts: ["evil.example"] } }] }), /evil\.example is not in the kind's egress/);
    assert.throws(() => bad({ steps: [{ name: "s", checkout: { ...checkout, credential: "agent_token", mount: "data/repos/x" } }] }), /needs \{name\}/);
    assert.throws(() => bad({ steps: [{ name: "s", command: ["true"], timeout_seconds: 3600 }] }), /longer than token_lifetime_seconds/);
    assert.throws(() => bad({ steps: [{ name: "s", command: ["true"], checkout: { ...checkout, credential: "agent_token" } }] }), /a command or a checkout/);
    assert.throws(() => bad({ git_credentials: [{ credential: "agent_token", host: "10.0.0.1" }] }), /host name/);
    assert.throws(() => bad({ write_back: ["data/repos/one"], steps: [{ name: "s", checkout: { ...checkout, credential: "agent_token", mount: "data/repos/{name}" } }] }), /a write-back path is at or inside it/);
    assert.throws(() => bad({ credentials: ["agent_token"], steps: [{ name: "s", checkout: { ...checkout, credential: "agent_token" } }] }), /a checkout's credential \(the runner's own\): the command does not receive it/);
    assert.throws(() => bad({ inputs: { spec: { ...inputs.spec, path: ".git/config" } } }), /a tool's own settings or code/);
    assert.throws(() => bad({ inputs: { spec: { ...inputs.spec, schema: { type: "string", pattern: "^\\:x$" } } } }), /regular expression/);
    assert.doesNotThrow(() => bad({ results_from: resultsFrom, tools: ["sops"], inputs, steps: [{ name: "s", command: ["true"], credentials: ["agent_token"] }] }));
    console.log("✓ definePack refuses results_from beside results, undeclared {$args}, a status outside the five, a tool outside the catalogue, an input under the write-back or from an undeclared argument, a schema keyword outside the subset, credentials and hosts the kind does not have, steps past the deadline, a mount without {name}");
  }

  // ---------- the fixture pack ----------
  const fixture = definePack({
    id: "fixture_steps",
    recordAreas: [
      { name: "steps_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "steps_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    credentials: [
      { name: "agent_token", label: "Token", bound_to: "workspace", deliver_as: { env: "FIXTURE_AGENT_TOKEN" } },
      { name: "agent_key", label: "Key", bound_to: "workspace", deliver_as: { file: "agent_key.pem" } },
      { name: "git_token", label: "Repository token", bound_to: "workspace", deliver_as: { env: "FIXTURE_GIT_TOKEN" } },
    ],
    agentJobKinds: [
      kind("from", { results_from: resultsFrom }),
      kind("from_drop", { results_from: resultsFrom }, { unresolved_references: "drop" }),
      kind("from_any", { results_from: { ...resultsFrom, status: { from: "status", map: { open: "fail" }, default: "unknown" } } }, { unresolved_references: "drop" }),
      kind("steps", { inputs, steps, credentials: ["agent_token"] }),
      // The checkout reads the workspace as restored (the default), and the command names no credentials.
      kind("steps_ws", { inputs, steps: steps.map((st) => st.checkout ? { ...st, checkout: { ...checkout, source: undefined } } : st) }),
      kind("steps_slow", { steps: [{ name: "slow", command: ["sleep", "30"], timeout_seconds: 10 }] }),
      kind("clobber", { inputs: { spec: { ...inputs.spec, path: "steps.mjs" } } }),
      kind("through_link", { inputs: { spec: { ...inputs.spec, path: "linkdir/spec.json" } } }),
      kind("tools", { tools: ["sops"], command: ["node", "steps.mjs", "tool", "sops", "--version"] }),
      kind("tools_missing", { tools: ["kubectl"], command: ["node", "steps.mjs", "tool", "kubectl", "version"] }),
    ] as never,
    tools: [
      defineTool({ name: "fixture_steps_run", description: "Start a run (test).", inputSchema: { kind: z.string(), company: z.string(), scope: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind: k, company, scope }, { runs: r }) => r.start(k, { scope: scope ?? {}, targets: { company } }) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_steps", name: "Fixture steps", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "agent-repo") }, definition: fixture }]);
  await rec.putPlatform(null, "steps_checks", "c1", { title: "A check", data: { summary: "x" } });
  for (const [o, co] of [[A, "a-co"], [B, "b-co"]] as const)
    await withTenant(o.orgId, () => rec.workspaceRecords("fixture_steps", o.orgId).put("steps_apps", `${co}-app`, { title: co, data: { url: `https://${co}.example` } }));
  const secret = { A_TOKEN: `canary-a-token-${STAMP}-0123456789`, A_KEY: `canary-a-key-${STAMP}-abcdefghij`, B_TOKEN: `canary-b-token-${STAMP}-9876543210` };
  await creds.setCredential(A.orgId, null, { pack: "fixture_steps", name: "agent_token", value: secret.A_TOKEN });
  await creds.setCredential(A.orgId, null, { pack: "fixture_steps", name: "agent_key", value: secret.A_KEY });
  await creds.setCredential(A.orgId, null, { pack: "fixture_steps", name: "git_token", value: GIT_TOKEN });
  await creds.setCredential(B.orgId, null, { pack: "fixture_steps", name: "agent_token", value: secret.B_TOKEN });
  await creds.setCredential(B.orgId, null, { pack: "fixture_steps", name: "git_token", value: GIT_TOKEN });

  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, k: string, company: string, scope: Record<string, unknown> = {}) => {
    const r = await c.call("fixture_steps_run", { kind: k, company, scope });
    assert.ok(!r.isError, r.content[0]?.text);
  };
  const client = await harness.localRunnerClient("w-steps");
  const asRoot = process.getuid?.() === 0;
  // As root, each run leases a user of its own (mold_v0-078, the harness's default); else the test's own user.
  const iso = asRoot ? {} : { allowSameUser: true };
  // Outside the test's own directory (0700): the run's user must be able to traverse to the cache, as under /var/cache.
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "steps-cache-"));
  chmodSync(cacheRoot, 0o711);
  const cacheDir = path.join(cacheRoot, "cache");
  const runNext = async (k: string) => {
    const c = await client.claim([`fixture_steps/${k}`]);
    assert.ok(c, `a run of ${k} to claim`);
    return { claim: c!, view: await harness.runWorkspaceHarness(client, c!, { egress: "off", allowFileUpstream: true, allowHttpUpstream: true, cacheDir, runTools, ...iso }) };
  };
  const eventsOf = async (id: string) => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const ev = async (id: string, type: string) => (await eventsOf(id)).filter((e) => e.type === type).map((e) => e.data);
  const stepLine = async (id: string, step: string) => (await ev(id, "step_log")).filter((d) => d.step === step).map((d) => JSON.parse(d.line))[0];
  const latest = (o: number) => store.latestSnapshot(db, o, "fixture_steps");
  const filesOf = async (o: number) => { const s = await latest(o); return s ? Object.keys(s.manifest).sort() : []; };
  const everything = async (id: string) => JSON.stringify(await db.query("SELECT type, data FROM run_events WHERE run_id = $1", [id])) + JSON.stringify(await db.query("SELECT * FROM run_results WHERE run_id = $1", [id])) + JSON.stringify(await db.query("SELECT error FROM runs WHERE id = $1", [id]));

  try {
    // ---------- 2. 071 results_from ----------
    if (want("071")) {
      await start(ca, "from", "a-co");
      const r = await runNext("from");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const rows = await db.query<{ check_key: string; asset_key: string; status: string; finding_fingerprint: string; evidence_ref: string; detail: any }>(
        "SELECT check_key, asset_key, status, finding_fingerprint, evidence_ref, detail FROM run_results WHERE run_id = $1 ORDER BY finding_fingerprint", [r.claim.run.id]);
      assert.deepEqual(rows.map((x) => [x.check_key, x.asset_key, x.status, x.finding_fingerprint, x.evidence_ref]), [["c1", "a-co-app", "fail", "fp-a", "ledger:f-1"], ["c1", "a-co-app", "pass", "fp-b", "ledger:f-2"]],
        "the findings of the result object, mapped: check, asset, status through the map, fingerprint, evidence");
      assert.deepEqual(rows[0]!.detail, { title: "First", severity: "high", workflow: "audit", company: "a-co" }, "detail from the item, the file's root and the run's arguments");
      assert.deepEqual((await ev(r.claim.run.id, "results_mapped"))[0], { file: "program-result.json", items: 3, results: 2, skipped: 1, unmapped: 0 }, "the note (not a finding) is skipped by `where`");
      const outs = (await ev(r.claim.run.id, "agent_output")).sort((x, y) => x.path.localeCompare(y.path));
      assert.deepEqual(outs.map((o) => o.path), ["program-result.json", "report.md", "sub/usage.json"], "every file under <RUN_OUT> recorded");
      assert.deepEqual(outs[2].json, { turns: 2 }, "a small JSON file's content too");
      assert.ok(outs.every((o) => /^[0-9a-f]{64}$/.test(o.sha256) && o.size > 0));
      assert.deepEqual(await filesOf(A.orgId), ["data/a-co/notes.json"], "the result file (outside the checkout) is never written back");

      await start(ca, "from", "a-co", { mode: "unmappable" });
      const u = await runNext("from");
      assert.equal(u.view?.status, "failed"); assert.match(u.view!.error!, /results_from: item 3 does not map \(\{control\} is missing\)/, "an unmappable item fails a reject kind");
      assert.equal((await db.query("SELECT 1 FROM run_results WHERE run_id = $1", [u.claim.run.id])).length, 0);

      await start(ca, "from_drop", "a-co", { mode: "forged" });
      const f = await runNext("from_drop");
      assert.equal(f.view?.status, "succeeded", JSON.stringify(f.view));
      const frows = await db.query<{ finding_fingerprint: string; asset_key: string }>("SELECT finding_fingerprint, asset_key FROM run_results WHERE run_id = $1 ORDER BY finding_fingerprint", [f.claim.run.id]);
      assert.deepEqual(frows.map((x) => [x.finding_fingerprint, x.asset_key]), [["fp-a", "a-co-app"], ["fp-b", "a-co-app"]], "forged items never land");
      const um = (await ev(f.claim.run.id, "result_unmapped"))[0];
      assert.deepEqual(um.items.map((i: { item: number }) => i.item), [5, 6, 7], "a status outside the map, a bad fingerprint, a check only under __proto__: unmapped");
      assert.equal((await ev(f.claim.run.id, "results_mapped"))[0].skipped, 2, "a note and a non-object are not findings: skipped");
      const unres = (await ev(f.claim.run.id, "result_unresolved"));
      assert.ok(JSON.stringify(unres).includes("b-co-app") && JSON.stringify(unres).includes("nope"), `the engine drops another workspace's asset and a missing check: ${JSON.stringify(unres)}`);
      assert.equal(({} as Record<string, unknown>).control, undefined, "no prototype was touched");

      await start(ca, "from", "a-co", { mode: "forged" });
      const fr = await runNext("from");
      assert.equal(fr.view?.status, "failed", "the same under reject: the run fails");

      await start(ca, "from_any", "a-co", { mode: "forged" });
      const fa = await runNext("from_any");
      assert.equal(fa.view?.status, "succeeded", JSON.stringify(fa.view));
      const any = await db.query<{ finding_fingerprint: string; status: string }>("SELECT finding_fingerprint, status FROM run_results WHERE run_id = $1 ORDER BY finding_fingerprint", [fa.claim.run.id]);
      assert.deepEqual(any.map((x) => [x.finding_fingerprint, x.status]), [["fp-a", "fail"], ["fp-b", "unknown"], ["fp-f", "unknown"]], "with a default, a status outside the map is the default");

      await start(ca, "from", "a-co", { mode: "nofile" });
      const nf = await runNext("from");
      assert.match(nf.view!.error!, /results_from: program-result\.json is missing/);
      await start(ca, "from", "a-co", { mode: "symlink" });
      const sl = await runNext("from");
      assert.match(sl.view!.error!, /program-result\.json: a symbolic link/, "a link for the result file is refused");
      await start(ca, "from", "a-co", { mode: "leak" });
      const lk = await runNext("from");
      assert.equal(lk.view?.status, "succeeded", JSON.stringify(lk.view));
      const all = await everything(lk.claim.run.id);
      assert.ok(!all.includes(secret.A_TOKEN), "a credential in the result file is never stored");
      assert.ok(all.includes("[credential agent_token]"), "it is redacted");
      console.log("✓ 071 results_from: the program's result object under <RUN_OUT> mapped into run_results (check, asset, status map, fingerprint, evidence, detail); every <RUN_OUT> file recorded; unmappable items fail a reject kind; forged items (another workspace's asset, a missing check, a status outside the map, a bad fingerprint, a prototype key, a non-object) never land; a missing or linked file refused; credentials redacted");
    }

    // ---------- 3 + 4. 073 inputs, 074 steps and the checkout cache ----------
    const spec = (repos: { repoId: string; url: string; pinnedCommit: string }[]) => ({ appId: "payments", repos });
    let gitHelperDir = "";
    if (want("074")) {
      const before = { ...gh.seen };
      await start(ca, "steps", "a-co", { spec: spec([{ repoId: "one", url: one.url, pinnedCommit: one.commit }, { repoId: "private", url: privUrl, pinnedCommit: priv.commit }]) });
      const r = await runNext("steps");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view) + JSON.stringify(await ev(r.claim.run.id, "stderr")));
      const id = r.claim.run.id;
      const inp = (await ev(id, "agent_inputs"))[0].inputs[0];
      // As the run holds it (the database keeps the scope's keys in its own order).
      const specBody = `${JSON.stringify((r.claim.run.scope as { spec: unknown }).spec, null, 2)}\n`;
      assert.deepEqual((r.claim.run.scope as { spec: unknown }).spec, spec([{ repoId: "one", url: one.url, pinnedCommit: one.commit }, { repoId: "private", url: privUrl, pinnedCommit: priv.commit }]));
      assert.deepEqual(inp, { name: "spec", path: ".app-inputs/spec.json", bytes: Buffer.byteLength(specBody), sha256: sha(specBody) }, "the input, written as given");
      const add = await stepLine(id, "add");
      assert.deepEqual(add.add, { app: "payments", repos: 2, input_mode: "644" }, "the step read the spec from its file");
      assert.deepEqual([add.token_env, add.git_env, add.cred_dir, add.git_config], ["unset", "unset", null, null], "a step with no credentials gets none");
      const gf = await stepLine(id, "gitfill");
      assert.equal(gf.gitfill.password_sha256, sha(secret.A_TOKEN), "git got the token from the helper");
      assert.equal(gf.gitfill.username, "x-access-token");
      assert.equal(gf.gitfill.other_password, false, "and nothing for another host");
      assert.ok(!gf.env_values_sha256.includes(sha(secret.A_TOKEN).slice(0, 16)) && !gf.argv_sha256.includes(sha(secret.A_TOKEN).slice(0, 16)), "the token is in no variable and no argument");
      assert.deepEqual([gf.token_env, gf.git_env], ["unset", "unset"], "nor delivered as the field's variable");
      assert.ok(!gf.env_names.includes("STEPS_FIXED"), "a step gets the kind's env only when it says env: true");
      gitHelperDir = path.dirname(gf.git_config);
      assert.ok(!existsSync(gitHelperDir), "the helper's files are gone with the step");
      const co = (await ev(id, "agent_checkout_repos"))[0];
      assert.deepEqual(co.repos.map((x: any) => [x.name, x.commit, x.mount, x.cached]), [["one", one.commit, "data/a-co/repos/one", false], ["private", priv.commit, "data/a-co/repos/private", false]]);
      assert.ok(gh.seen.authed > before.authed, "the private repository was fetched with the token");
      const rd = await stepLine(id, "read");
      assert.deepEqual([rd.readrepo.link, rd.readrepo.readme, rd.readrepo.files], [true, "repo one", ["README.md"]], "a later step reads the checkout through its link");
      if (asRoot) assert.equal(rd.readrepo.write, "EACCES", "read-only to the run's user");
      const main = (await ev(id, "main_env"))[0];
      assert.deepEqual([main.token_env, main.cred_dir, main.git_env], ["set", null, "unset"], "the command gets exactly its credentials (agent_token; not the key, not the git token)");
      assert.deepEqual(await filesOf(A.orgId), ["data/a-co/notes.json", "data/a-co/repos/one.json", "data/a-co/repos/private.json"], "manifests written back; the checkouts and the input never");
      assert.equal((await ev(id, "workspace_skipped")).length, 0, "the links are gone before the write-back is read");
      const all = await everything(id);
      for (const v of [secret.A_TOKEN, secret.A_KEY, GIT_TOKEN]) assert.ok(!all.includes(v), "no credential stored");
      const wsA = path.join(cacheDir, `ws-${A.orgId}`);
      if (asRoot) assert.equal(statSync(wsA).mode & 0o777, 0o700, "the workspace's cache is closed once its run ends");
      assert.equal(readdirSync(wsA).filter((n) => !n.startsWith(".")).length, 2);

      // The same repositories again: from the cache (nothing fetched).
      const seen2 = gh.seen.authed;
      await start(ca, "steps", "a-co", { spec: spec([{ repoId: "one", url: one.url, pinnedCommit: one.commit }, { repoId: "private", url: privUrl, pinnedCommit: priv.commit }]) });
      const r2 = await runNext("steps");
      assert.equal(r2.view?.status, "succeeded", JSON.stringify(r2.view));
      assert.deepEqual((await ev(r2.claim.run.id, "agent_checkout_repos"))[0].repos.map((x: any) => x.cached), [true, true]);
      assert.equal(gh.seen.authed, seen2, "nothing fetched");

      // The default source: the workspace as restored. A manifest this run's own step writes is not fetched; the command,
      // naming no credentials, gets all the kind's but the checkout's.
      await start(ca, "steps_ws", "a-co", { spec: spec([{ repoId: "two", url: two.url, pinnedCommit: two.commit }]) });
      const rw = await runNext("steps_ws");
      assert.equal(rw.view?.status, "succeeded", JSON.stringify(rw.view) + JSON.stringify(await ev(rw.claim.run.id, "stderr")));
      assert.deepEqual((await ev(rw.claim.run.id, "agent_checkout_repos"))[0].repos.map((x: any) => x.name), ["one", "private"], "only what the workspace held when the run began");
      const mw = (await ev(rw.claim.run.id, "main_env"))[0];
      assert.deepEqual([mw.token_env, mw.cred_dir, mw.git_env], ["set", ["agent_key.pem"], "unset"], "the command gets the kind's credentials but the checkout's");

      // Another workspace: its own cache, and this workspace's is out of its reach.
      const entryA = path.join(wsA, readdirSync(wsA).filter((n) => !n.startsWith("."))[0]!, "tree");
      await start(cb, "steps", "b-co", { spec: spec([{ repoId: "one", url: one.url, pinnedCommit: one.commit }]), other: entryA });
      const rb = await runNext("steps");
      assert.equal(rb.view?.status, "succeeded", JSON.stringify(rb.view));
      assert.equal((await ev(rb.claim.run.id, "agent_checkout_repos"))[0].repos[0].cached, false, "B fetches into its own cache");
      if (asRoot) assert.equal((await stepLine(rb.claim.run.id, "read")).readrepo.other, "EACCES", "B's run cannot read A's cache, even by its exact path");
      assert.deepEqual(await filesOf(B.orgId), ["data/b-co/notes.json", "data/b-co/repos/one.json"]);
      console.log(`✓ 073 + 074: the spec input reaches the step that reads it; each step gets only its credentials; git gets its token through the helper for the declared host only (never a variable or an argument, gone after the step); the checkout step fetches the manifests' repositories at their pins (one behind a token) into the workspace's cache, linked read-only${asRoot ? " (EACCES for the run's user)" : ""}, never written back; a second run uses the cache; another workspace has its own and cannot read this one's`);
    }
    if (want("073")) {
      // Inputs refused.
      const before = (await latest(A.orgId))?.version ?? 0;
      const tryRun = async (k: string, scope: Record<string, unknown>) => { await start(ca, k, "a-co", scope); return runNext(k); };
      const okRepo = { repoId: "one", url: one.url, pinnedCommit: one.commit };
      let x = await tryRun("steps", { spec: { ...spec([okRepo]), extra: 1 } });
      assert.match(x.view!.error!, /inputs: input spec does not match its schema: \$: has extra, which is not allowed/);
      x = await tryRun("steps", { spec: spec([{ ...okRepo, pinnedCommit: "main" }]) });
      assert.match(x.view!.error!, /\$\.repos\[0\]\.pinnedCommit: does not match its pattern/);
      x = await tryRun("steps", { spec: spec(Array.from({ length: 8 }, (_, i) => ({ ...okRepo, repoId: `r${i}`, url: `${one.url}?${"x".repeat(400)}` }))) });
      assert.match(x.view!.error!, /input spec is \d+ bytes, more than its 4096/);
      x = await tryRun("steps", { spec: spec([{ ...okRepo, url: `${one.url}#${secret.A_TOKEN}` }]) });
      assert.match(x.view!.error!, /input spec holds the value of credential agent_token: it is not written/);
      assert.ok(!(await everything(x.claim.run.id)).includes(secret.A_TOKEN));
      x = await tryRun("clobber", { spec: spec([okRepo]) });
      assert.match(x.view!.error!, /a file of the checkout is already there/);
      x = await tryRun("through_link", { spec: spec([okRepo]) });
      assert.match(x.view!.error!, /linkdir is not a directory/);
      x = await tryRun("steps", {});
      assert.match(x.view!.error!, /input spec: the run gives no scope\.spec/);
      assert.equal((await latest(A.orgId))?.version ?? 0, before, "none of them wrote anything back");
      console.log("✓ 073 inputs refused: a schema violation, past the size cap, a credential's value, over a file of the pinned tree, through a link of the tree, absent: nothing written back");

    }
    if (want("074")) {
      const tryRun = async (k: string, scope: Record<string, unknown>) => { await start(ca, k, "a-co", scope); return runNext(k); };
      let x;
      // Checkouts refused; the cache's cap and cleaning.
      x = await tryRun("steps", { spec: spec([{ repoId: "evil", url: "https://evil.example/x.git", pinnedCommit: one.commit }]) });
      assert.match(x.view!.error!, /step checkout: .*evil\.example is not one of the step's hosts/);
      x = await tryRun("steps", { spec: spec([{ repoId: "sub", url: "https://sub.git.allowed.example/x.git", pinnedCommit: one.commit }]) });
      assert.match(x.view!.error!, /sub\.git\.allowed\.example is not one of the step's hosts/, "a subdomain is not the host");
      x = await tryRun("steps", { spec: spec([{ repoId: "big", url: big.url, pinnedCommit: big.commit }]) });
      assert.match(x.view!.error!, /step checkout: the commit's files are \d+ bytes, more than 1048576: not checked out/, "refused from git's own objects, before anything is checked out");
      const wsA = path.join(cacheDir, `ws-${A.orgId}`);
      assert.ok(!readdirSync(wsA).some((n) => n.startsWith(".tmp-")), "a refused fetch leaves nothing behind");
      // The cache itself: past its cap the least recently used go (never one this run uses); old entries and unfinished
      // fetches are cleaned when it is next entered; a base directory someone else could write is refused.
      const { CheckoutCache } = await import("../src/agent-workspace-steps.js");
      const unit = path.join(TMP, "unit-cache");
      const fill = (n: number) => async (d: string) => { mkdirSync(d); writeFileSync(path.join(d, "f"), Buffer.alloc(n, 1)); };
      const c1 = new CheckoutCache(unit, 99, { maxBytes: 20, maxAgeDays: 7, runUser: false }); c1.open();
      const e1 = await c1.get("https://h.example/1.git", "1".repeat(40), 1e6, fill(12)); c1.close();
      const c2 = new CheckoutCache(unit, 99, { maxBytes: 20, maxAgeDays: 7, runUser: false }); c2.open();
      const e2 = await c2.get("https://h.example/2.git", "2".repeat(40), 1e6, fill(12));
      assert.ok(!existsSync(e1.tree) && existsSync(e2.tree), "past the cap the least recently used entry goes, never the one in use");
      assert.equal((await c2.get("https://h.example/2.git", "2".repeat(40), 1e6, fill(12))).hit, true);
      await assert.rejects(c2.get("https://h.example/3.git", "3".repeat(40), 1e6, fill(30)), /larger than the workspace's whole checkout cache/);
      c2.close();
      const old = new Date(Date.now() - 30 * 86400_000);
      utimesSync(path.dirname(e2.tree), old, old);
      const unfinished = path.join(unit, "ws-99", ".tmp-x"); mkdirSync(unfinished); utimesSync(unfinished, old, old);
      new CheckoutCache(unit, 99, { maxBytes: 20, maxAgeDays: 7, runUser: false }).open();
      assert.ok(!existsSync(e2.tree) && !existsSync(unfinished), "an entry unused for 30 days and an unfinished fetch are gone");
      if (asRoot) {
        const planted = path.join(TMP, "planted-cache"); mkdirSync(planted, { mode: 0o777 }); chmodSync(planted, 0o777);
        assert.throws(() => new CheckoutCache(planted, 99, { maxBytes: 20, maxAgeDays: 7, runUser: true }).open(), /not root's alone: refused/, "a cache directory others can write is refused");
      }
      x = await tryRun("steps_slow", {});
      assert.equal(x.view?.error_kind, "timeout"); assert.match(x.view!.error!, /step slow ran past its time limit \(10 s\)/);
      console.log(`✓ 074 refused: a host off the step's list, a repository over its size; the cache keeps under its cap (least recently used go, never one in use), cleans old entries and unfinished fetches${asRoot ? ", refuses a directory others can write" : ""}; a slow step fails the run (timeout)`);
    }

    // ---------- 5. 072 tools ----------
    if (want("072")) {
      await start(ca, "tools", "a-co");
      const t = await runNext("tools");
      assert.equal(t.view?.status, "succeeded", JSON.stringify(t.view));
      assert.deepEqual((await ev(t.claim.run.id, "agent_tools"))[0], { tools: ["sops 3.13.3"] });
      const out = (await ev(t.claim.run.id, "log")).map((l) => l.line).join("\n");
      assert.match(out, /sops 3\.13\.3 \(stand-in\)/, "the pinned tool is on the run's PATH");
      await start(ca, "tools_missing", "a-co");
      const m = await runNext("tools_missing");
      assert.equal(m.view?.status, "failed"); assert.match(m.view!.error!, /kubectl 1\.37\.1 is not in this image: the runner image is not built for this kind/);
      // The installed file changed after the image was built: refused before anything runs.
      const manifest = JSON.parse((await import("node:fs")).readFileSync(path.join(toolsDir, "manifest.json"), "utf8"));
      const bin = path.join(toolsDir, manifest.tools.sops.bins.sops.path);
      chmodSync(bin, 0o755);
      writeFileSync(bin, "#!/bin/sh\necho swapped\n");
      await start(ca, "tools", "a-co");
      const s = await runNext("tools");
      assert.equal(s.view?.status, "failed"); assert.match(s.view!.error!, /sops: sops is not the file that was installed/);
      assert.equal((await ev(s.claim.run.id, "log")).length, 0, "nothing ran");
      console.log("✓ 072 tools: the kind's pinned tool is first on its PATH; a tool the image lacks, or an installed file that changed, refuses the run before anything runs");
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close(); gh.srv.close(); art.close();
  }
  await db.close();
  rmSync(cacheRoot, { recursive: true, force: true }); rmSync(toolsRoot, { recursive: true, force: true });
  console.log("AGENT STEPS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
