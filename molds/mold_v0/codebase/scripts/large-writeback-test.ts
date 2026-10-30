// Large write-backs (mold_v0-182; src/run-transfers.ts, src/run-transfer-seal.ts, src/agent-workspace.ts writeBackIgnore,
// src/run-harness.ts httpRunnerClient), offline: an embedded database, the S3 stand-in of test:object-storage
// (scripts/lib/s3-standin.ts, now checking presigned links too) and, in front of the API, a stand-in for a hosted
// platform's function limits: a request body or an answer over 4.5 MB is refused as Vercel refuses it
// (413 FUNCTION_PAYLOAD_TOO_LARGE). Maxwell's first audit on Vercel failed exactly there: refresh_apps cloned the
// company's repositories into applications/<app>/repos/<repo>/ (Maxwell's git-ignored checkouts), the write-back sent
// them along, and PUT /api/worker/runs/<id>/workspace answered 413.
//   npm run test:large-writeback
//
// Proves:
//   1. git's ignore rules as Maxwell's .gitignore (at its pin, 5f7e77e) writes them: a checkout under
//      applications/*/repos/*/ and a decrypted credentials file are ignored, the repository's record next to it is not;
//      "!" re-includes, anchoring, directory-only rules, deeper files win; a write-back path the repository itself
//      ignores is the kind's (its rules are not applied inside it); the kind's write_back_ignore applies everywhere
//   2. the incident, reproduced: a write-back over 4.5 MB sent to the API is refused by the platform stand-in
//   3. a refresh_apps-like run over HTTP, through the stand-in: succeeds; the clone (and its .git) and the decrypted
//      file never leave the sandbox (not in the snapshot, not in what was uploaded); the write-back (over 4.5 MB of
//      the workspace's own records) went to the bucket with a presigned PUT, sealed, under the workspace's prefix,
//      and was removed once staged; no request to the API and no answer from it over 4 MiB
//   4. the next run's checkout (over 4.5 MB) comes from the bucket with a presigned GET; its transfer is removed when
//      the attempt ends
//   5. the lease and the tenant: an upload is refused without the run's lease, its commit once the store's lease is
//      gone; another workspace's run cannot commit it (404), nor can a second commit; an expired link is refused by
//      the bucket; content that is not what was announced is refused; tenant work cannot read run_transfers
//   6. the platform's 413 below the runner's own threshold falls back to the bucket
//   7. refused for size: an event naming the size and the limit, and the run's error saying the same (the
//      deployment's limit; and with no links, the platform's 4.5 MB)
//   8. a local directory store (one machine, docker): the same write-back goes to the API as before
//   9. a completion over 4.5 MB goes through the bucket; events in batches under the limit
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { startS3Standin } from "./lib/s3-standin.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const R2 = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
for (const k of R2) delete process.env[k];
delete process.env.APP_STORAGE_DIR;
delete process.env.APP_WORKER_INLINE_MAX_BYTES;
const MiB = 1024 * 1024, PLATFORM_LIMIT = 4_500_000;

/** Maxwell's .gitignore at its pin (OnFinance/Maxwell 5f7e77e22edd21d71e6806c9026273d94c392b65), verbatim. */
const MAXWELL_GITIGNORE = `node_modules
# cloned application sources (manifests are committed, checkouts are not)
applications/*/repos/*/
# decrypted credentials must never be committed
applications/*/credentials.dec.json
# local sops/age keys
.sops-key.txt
*.age-key.txt
# raw harness transcripts can be large; keep summaries, ignore verbatim copies unless opted in
kpis/data/raw/sessions/*/*.jsonl
kpis/data/raw/sessions/*/*.export.json
.DS_Store
# transient git worktrees Claude Code creates for isolated agents
.claude/worktrees/
`;

/** A Maxwell-like agent repository: its .gitignore, an agent that clones a "repository" under applications/, a validator. */
function agentRepo() {
  const src = path.join(TMP, "mx-src"), bare = path.join(TMP, "mx.git");
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, ".gitignore"), MAXWELL_GITIGNORE);
  writeFileSync(path.join(src, "agent.mjs"), `import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const mode = process.argv[2] ?? "big";
const list = (d) => existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : [];
console.log(JSON.stringify({ event: "seen", applications: list("applications").filter((f) => !f.includes("repos/repo1/")).slice(0, 50), checkout: existsSync("applications/app1/repos/repo1") }));
mkdirSync("company-profile/company", { recursive: true });
writeFileSync("company-profile/company/profile.json", JSON.stringify({ name: "Company", run: process.env.RUN_ID }));
// refresh-apps: "git clone --depth 50 <url> applications/<app>/repos/<repo>": a checkout with its .git, git-ignored upstream.
mkdirSync("applications/app1/repos/repo1/.git/objects/pack", { recursive: true });
mkdirSync("applications/app1/repos/repo1/src", { recursive: true });
writeFileSync("applications/app1/repos/repo1/.git/objects/pack/pack-1.pack", randomBytes(3_000_000));
writeFileSync("applications/app1/repos/repo1/src/main.bin", randomBytes(3_000_000));
writeFileSync("applications/app1/repos/repo1/README.md", "CHECKOUT-SENTINEL\\n");
writeFileSync("applications/app1/credentials.dec.json", JSON.stringify({ token: "DECRYPTED-SENTINEL" }));
// The workspace's own records: the application, its repository's record (committed in Maxwell), evidence.
writeFileSync("applications/app1/app.json", JSON.stringify({ appId: "app1" }));
writeFileSync("applications/app1/repos/repo1.json", JSON.stringify({ repoId: "repo1", localCheckout: "applications/app1/repos/repo1" }));
if (mode === "big") writeFileSync("applications/app1/evidence.bin", randomBytes(5_500_000));
`);
  writeFileSync(path.join(src, "validate.mjs"), "console.log('valid');\n");
  const g = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: src, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "maxwell-like");
  const commit = g("rev-parse", "HEAD");
  spawnSync("git", ["clone", "-q", "--bare", src, bare], { env: { PATH: process.env.PATH!, HOME: TMP, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { url: `file://${bare}`, commit };
}

/** A hosted platform's function limits in front of the API: a body or an answer over 4.5 MB is refused, as Vercel does. */
async function platformStandin(target: string) {
  const calls: { method: string; path: string; bytes: number; answer: number; status: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const call = { method: req.method ?? "", path: (req.url ?? "").replace(/\?.*$/, ""), bytes: body.length, answer: 0, status: 0 };
      calls.push(call);
      if (body.length > PLATFORM_LIMIT) {
        call.status = 413;
        res.writeHead(413, { "content-type": "text/plain", "x-vercel-error": "FUNCTION_PAYLOAD_TOO_LARGE" }).end("Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
      const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: body.length ? new Uint8Array(body) : undefined });
      const out = Buffer.from(await r.arrayBuffer());
      call.answer = out.length; call.status = r.status;
      if (out.length > PLATFORM_LIMIT) {
        call.status = 500;
        res.writeHead(500, { "content-type": "text/plain", "x-vercel-error": "FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE" }).end("FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE\n");
        return;
      }
      const h: Record<string, string> = {};
      r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k)) h[k] = v; });
      res.writeHead(r.status, h).end(out);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const KEY_ID = `LWBKEYID${randomBytes(6).toString("hex")}`, KEY_SECRET = `lwb-secret-${randomBytes(16).toString("hex")}`;
const s3 = await startS3Standin({ buckets: ["runs-bucket"], keys: { [KEY_ID]: KEY_SECRET } });
const useBucket = () => Object.assign(process.env, { R2_BUCKET: "runs-bucket", R2_ENDPOINT: s3.url, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: KEY_SECRET });
try {
  // ---------- 1. the ignore rules ----------
  const paths = await import("../src/agent-workspace-paths.js");
  const aw = await import("../src/agent-workspace.js");
  {
    const ig = paths.ignoreMatcher(paths.parseIgnore(MAXWELL_GITIGNORE));
    const cases: [string, boolean, boolean][] = [
      ["applications/app1/repos/repo1", true, true], ["applications/app1/repos/repo1/src/main.bin", false, true],
      ["applications/app1/repos/repo1/.git/HEAD", false, true], ["applications/app1/repos/repo1.json", false, false],
      ["applications/app1/repos", true, false], ["applications/app1/app.json", false, false],
      ["applications/app1/credentials.dec.json", false, true], ["applications/app1/credentials.json", false, false],
      ["company-profile/company/profile.json", false, false], ["node_modules", true, true], ["a/b/node_modules/x.js", false, true],
      ["kpis/data/raw/sessions/s1/t.jsonl", false, true], ["kpis/data/raw/sessions/s1/t.summary.json", false, false],
      ["deep/.DS_Store", false, true], [".claude/worktrees/x/y", false, true], ["x.age-key.txt", false, true],
    ];
    for (const [p, dir, want] of cases) assert.equal(ig(p, dir), want, `${p}${dir ? "/" : ""}: ${want ? "ignored" : "kept"}`);
    // "!" re-includes a file, never one inside an ignored directory; "/x" is anchored; "x/" is for directories only; deeper wins.
    const more = paths.ignoreMatcher([...paths.parseIgnore("*.log\n!keep.log\n/top.txt\nbuild/\nlogs/**\n!logs/a/\n"), ...paths.parseIgnore("!local.log\n", "sub")]);
    assert.equal(more("x/y.log", false), true); assert.equal(more("x/keep.log", false), false, "! re-includes");
    assert.equal(more("top.txt", false), true); assert.equal(more("x/top.txt", false), false, "a leading / anchors");
    assert.equal(more("build", true), true); assert.equal(more("build", false), false, "a trailing / is for directories only");
    assert.equal(more("logs/a/x.txt", false), true, "inside an ignored directory, ! cannot re-include");
    assert.equal(more("sub/local.log", false), false, "a deeper .gitignore's rule wins");
    assert.equal(more("other/local.log", false), true, "only below its own directory");
    // A write-back path the repository ignores is the kind's own; the kind's write_back_ignore applies everywhere.
    const pinned = mkdtempSync(path.join(TMP, "pinned-"));
    writeFileSync(path.join(pinned, ".gitignore"), "data/\n*.tmp\n");
    mkdirSync(path.join(pinned, "nested"), { recursive: true });
    writeFileSync(path.join(pinned, "nested", ".gitignore"), "cache/\n");
    const wbi = aw.writeBackIgnore(pinned, ["records/scratch/"]);
    assert.equal(wbi.under("data", true)!("data/x.tmp", false), false, "inside a write-back path the repository ignores, its rules stay out");
    assert.equal(wbi.under("records", true)!("records/x.tmp", false), true, "below any other write-back path they apply");
    assert.equal(wbi.under("records", true)!("records/scratch", true), true, "the kind's write_back_ignore");
    assert.equal(wbi.under("data", true)!("data/records/scratch", true), false, "anchored at the checkout's root");
    assert.equal(wbi.under("nested", true)!("nested/cache", true), true, "a nested .gitignore, below its directory");
    assert.equal(aw.writeBackIgnore(pinned, [], false).under("records", true), null, "write_back_gitignore: false, no patterns: nothing left out");
    console.log("✓ ignore rules as git reads them (Maxwell's .gitignore at its pin: the checkouts under applications/*/repos/*/ and decrypted credentials ignored, the records kept); a write-back path the repository ignores stays the kind's");
  }

  useBucket();
  const repo = agentRepo();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const store = await import("../src/workspace-store.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const { sealTransfer, sha256Hex } = await import("../src/run-transfer-seal.js");
  const A = (await createOrg(`Large A ${STAMP}`)).org, B = (await createOrg(`Large B ${STAMP}`)).org;

  const kind = (name: string) => ({
    name, runner: "agent-workspace", providers: [], egress: [], credentials: [], lease_seconds: 15,
    agent: {
      repository: repo.url, commit: repo.commit, strip: ["applications/*/repos/*/.git"],
      command: ["node", "agent.mjs", "{mode}"], args: { mode: { from: "scope.mode", default: "big", pattern: "[a-z]{1,10}" } },
      validate: { command: ["node", "validate.mjs"], timeout_seconds: 60 },
      write_back: ["company-profile/company", "applications"], timeout_seconds: 120,
    },
  });
  const fixture = definePack({
    id: "fixture_big",
    agentJobKinds: [kind("refresh")] as never,
    tools: [defineTool({ name: "fixture_big_run", description: "Start a refresh (test).", inputSchema: { mode: z.string().optional() },
      handler: async (_ws, { mode }, { runs: r }) => r.start("refresh", { scope: { mode: mode ?? "big" } }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_big", name: "Fixture big", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "agent-repo") }, definition: fixture }]);

  const http = await startHttp();
  const platform = await platformStandin(http.base);
  const W = process.env.APP_WORKER_TOKEN!;
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, mode = "big") => { const r = await c.call("fixture_big_run", { mode }); assert.ok(!r.isError, r.content[0]?.text); return r.structuredContent as { id: string }; };
  const asRoot = process.getuid?.() === 0;
  const iso = asRoot ? {} : { allowSameUser: true };
  const runVia = async (base: string, worker: string) => {
    const client = harness.httpRunnerClient(base, W, worker);
    const c = (await client.claim(["fixture_big/refresh"]))!;
    assert.ok(c, "a run to claim");
    return { claim: c, view: await harness.runWorkspaceHarness(client, c, { egress: "off", allowFileUpstream: true, ...iso }) };
  };
  const ev = async (id: string, type: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = $2 ORDER BY id", [id, type])).map((e) => e.data);
  const latest = (o: number) => store.latestSnapshot(db, o, "fixture_big");
  const transfersIn = (o: number) => s3.list("runs-bucket", `workspaces/org-${o}/.transfers/`);
  const apiOver = (from: number, limit: number) => platform.calls.slice(from).filter((c) => c.bytes > limit || c.answer > limit);

  try {
    // ---------- 2. the incident, reproduced ----------
    {
      const r = await fetch(`${platform.url}/api/worker/runs/run_x/workspace`, { method: "PUT", headers: { authorization: `Bearer ${W}`, "content-type": "application/octet-stream" }, body: new Uint8Array(randomBytes(5 * MiB)) });
      assert.equal(r.status, 413);
      assert.match(await r.text(), /FUNCTION_PAYLOAD_TOO_LARGE/);
      console.log("✓ the incident reproduced: a 5 MB write-back to the API is refused by the platform (413 FUNCTION_PAYLOAD_TOO_LARGE)");
    }

    // ---------- 3. a refresh_apps-like run through the platform ----------
    let firstVersion = 0;
    {
      await start(ca);
      const from = platform.calls.length, s3From = s3.calls.length;
      const r = await runVia(platform.url, "w-big-1");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const snap = (await latest(A.orgId))!;
      firstVersion = snap.version!;
      const files = Object.keys(snap.manifest).sort();
      assert.deepEqual(files, ["applications/app1/app.json", "applications/app1/evidence.bin", "applications/app1/repos/repo1.json", "company-profile/company/profile.json"],
        "only the workspace's own records are written back: no checkout under repos/repo1/ (nor its .git), no decrypted credentials");
      const ignored = (await ev(r.claim.run.id, "workspace_ignored"))[0];
      assert.ok(ignored && ignored.paths >= 2 && ignored.sample.includes("applications/app1/repos/repo1") && ignored.sample.includes("applications/app1/credentials.dec.json"), JSON.stringify(ignored));
      const api = platform.calls.slice(from);
      assert.deepEqual(apiOver(from, 4 * MiB), [], "no request to the API and no answer from it over 4 MiB");
      assert.ok(api.some((c) => c.method === "POST" && /\/uploads$/.test(c.path)) && api.some((c) => c.method === "POST" && /\/workspace\/commit$/.test(c.path)), "an upload link, then the commit");
      assert.ok(!api.some((c) => c.method === "PUT" && /\/workspace$/.test(c.path)), "the bundle never went to the API");
      const puts = s3.calls.slice(s3From).filter((c) => c.method === "PUT" && c.key.includes("/.transfers/"));
      assert.equal(puts.length, 1, "one upload to the bucket");
      assert.ok(puts[0]!.presigned && puts[0]!.status === 200 && puts[0]!.accessKeyId === KEY_ID, "with a presigned link, accepted");
      assert.match(puts[0]!.key, new RegExp(`^workspaces/org-${A.orgId}/\\.transfers/tr_[0-9a-f]{32}\\.wst$`), "under the workspace's own prefix");
      assert.ok(puts[0]!.body.length > PLATFORM_LIMIT, `more than the platform takes (${puts[0]!.body.length} bytes)`);
      assert.ok(puts[0]!.body.length < 5_500_000 + 1 * MiB, "and not the 6 MB checkout with it: it never left the sandbox");
      assert.ok(!puts[0]!.headers.authorization, "no key of the bucket's in the runner's request");
      assert.ok(!puts[0]!.body.includes(Buffer.from("Company")), "sealed in the bucket (never the workspace's files in the clear)");
      assert.deepEqual(transfersIn(A.orgId), [], "the upload was removed once staged");
      assert.deepEqual(s3.list("runs-bucket", `workspaces/org-${A.orgId}/fixture_big/`), [snap.object_key], "the snapshot itself, as before");
      assert.equal((await db.query("SELECT 1 FROM run_transfers WHERE run_id = $1", [r.claim.run.id])).length, 0);
      console.log(`✓ a refresh_apps-like run through the platform: succeeded; the clone and the decrypted file stayed in the sandbox; the ${(puts[0]!.body.length / 1e6).toFixed(1)} MB write-back went to the bucket with a presigned PUT (sealed, under org-${A.orgId}/), removed once staged; nothing over 4 MiB through the API`);
    }

    // ---------- 4. the next checkout comes from the bucket ----------
    {
      await start(ca, "small");
      const from = platform.calls.length, s3From = s3.calls.length;
      const r = await runVia(platform.url, "w-big-2");
      assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
      const seen = (await ev(r.claim.run.id, "seen"))[0];
      assert.ok(seen.applications.includes("app1/evidence.bin") && seen.applications.includes("app1/repos/repo1.json"), `the workspace restored: ${JSON.stringify(seen)}`);
      assert.equal(seen.checkout, false, "the clone was never stored, so it is not restored either (the run clones again)");
      assert.deepEqual(apiOver(from, 4 * MiB), [], "no answer over 4 MiB");
      // The runner's requests to the bucket are the presigned ones (the API's own are signed with its key).
      const gets = s3.calls.slice(s3From).filter((c) => c.presigned && c.method === "GET");
      assert.ok(gets.length === 1 && gets[0]!.key.includes(`org-${A.orgId}/.transfers/`) && gets[0]!.status === 200, "the checkout came with a presigned GET");
      assert.deepEqual(transfersIn(A.orgId), [], "its transfer removed when the attempt ended");
      assert.equal((await latest(A.orgId))!.version, firstVersion + 1);
      console.log("✓ the next checkout (over 4.5 MB) came from the bucket with a presigned GET; removed when the attempt ended");
    }

    // ---------- 5. the lease and the tenant ----------
    {
      await start(ca, "small");
      const client = harness.httpRunnerClient(platform.url, W, "w-manual");
      const c = (await client.claim(["fixture_big/refresh"]))!;
      const id = c.run.id, lease = c.lease_token;
      const dir = mkdtempSync(path.join(TMP, "manual-"));
      await client.checkout(id, lease, dir);
      const api = (p: string, l: string | null, body: unknown, base = platform.url) => fetch(`${base}/api/worker/runs/${encodeURIComponent(id)}${p}`, {
        method: "POST", headers: { authorization: `Bearer ${W}`, "content-type": "application/json", ...(l ? { "x-run-lease": l } : {}) }, body: JSON.stringify(body) });
      const bundle = (await import("../src/workspace-bundle.js")).packBundle(dir).bundle;
      const ask = { purpose: "workspace", bytes: bundle.length, sha256: sha256Hex(bundle) };
      assert.equal((await api("/uploads", null, ask)).status, 409, "no lease token: refused");
      assert.equal((await api("/uploads", "orl_not-the-lease", ask)).status, 409, "another lease token: refused");
      const tooBig = await api("/uploads", lease, { ...ask, bytes: 400 * MiB });
      assert.equal(tooBig.status, 413);
      const tb = await tooBig.json() as { error: string; bytes: number; limit: number };
      assert.match(tb.error, /419\.4 MB \(419430400 bytes\); this deployment takes at most 314\.6 MB \(314572800 bytes, APP_WORKSPACE_MAX_BUNDLE_BYTES\)/);
      assert.deepEqual([tb.bytes, tb.limit], [400 * MiB, 300 * MiB], "a refusal names the size and the limit");
      const up = await (await api("/uploads", lease, ask)).json() as { upload: { id: string; url: string; key: string } };
      assert.match(up.upload.url, new RegExp(`^${s3.url}/runs-bucket/workspaces/org-${A.orgId}/\\.transfers/${up.upload.id}\\.wst\\?.*X-Amz-Signature=`), "a presigned link for the run's workspace's own key");
      assert.ok(!up.upload.url.includes(KEY_SECRET), "the link carries no secret");
      const sealed = sealTransfer(Buffer.from(up.upload.key, "base64"), up.upload.id, bundle);
      // An expired link: refused by the bucket.
      const real = Date.now; Date.now = () => real() + 16 * 60_000;
      try { assert.equal((await fetch(up.upload.url, { method: "PUT", body: new Uint8Array(sealed) })).status, 403, "an expired link is refused"); }
      finally { Date.now = real; }
      // A link signed for one key writes nothing else.
      const other = up.upload.url.replace(`/.transfers/${up.upload.id}.wst`, `/fixture_big/999.wse`);
      assert.equal((await fetch(other, { method: "PUT", body: new Uint8Array(sealed) })).status, 403, "the link is for its one key only");
      assert.equal((await fetch(up.upload.url, { method: "PUT", body: new Uint8Array(sealed) })).status, 200);
      // Another workspace's run cannot commit it.
      await start(cb, "small");
      const cB = (await harness.httpRunnerClient(platform.url, W, "w-b").claim(["fixture_big/refresh"]))!;
      const asB = await fetch(`${platform.url}/api/worker/runs/${encodeURIComponent(cB.run.id)}/workspace/commit`, { method: "POST",
        headers: { authorization: `Bearer ${W}`, "content-type": "application/json", "x-run-lease": cB.lease_token }, body: JSON.stringify({ upload: up.upload.id }) });
      assert.equal(asB.status, 409, "B's run has not checked its workspace out: refused before anything is read");
      await harness.httpRunnerClient(platform.url, W, "w-b").checkout(cB.run.id, cB.lease_token, mkdtempSync(path.join(TMP, "b-")));
      const asB2 = await fetch(`${platform.url}/api/worker/runs/${encodeURIComponent(cB.run.id)}/workspace/commit`, { method: "POST",
        headers: { authorization: `Bearer ${W}`, "content-type": "application/json", "x-run-lease": cB.lease_token }, body: JSON.stringify({ upload: up.upload.id }) });
      assert.equal(asB2.status, 404, "another workspace's run cannot commit A's upload");
      const has = (t: string) => transfersIn(A.orgId).some((k) => k.endsWith(`/${t}.wst`));
      assert.ok(has(up.upload.id), "A's upload is still there");
      // The store's lease gone: refused.
      await db.query("UPDATE workspace_leases SET expires_at = now() - interval '1 second' WHERE run_id = $1", [id]);
      assert.equal((await api("/workspace/commit", lease, { upload: up.upload.id })).status, 409, "the store's lease lapsed: refused");
      await db.query("UPDATE workspace_leases SET expires_at = now() + interval '5 minutes' WHERE run_id = $1", [id]);
      const ok = await api("/workspace/commit", lease, { upload: up.upload.id });
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.equal((await api("/workspace/commit", lease, { upload: up.upload.id })).status, 404, "used once");
      // Content that is not what was announced: refused, and removed.
      const up2 = await (await api("/uploads", lease, ask)).json() as { upload: { id: string; url: string; key: string } };
      const wrong = sealTransfer(Buffer.from(up2.upload.key, "base64"), up2.upload.id, Buffer.concat([bundle.subarray(0, bundle.length - 1), Buffer.from([bundle[bundle.length - 1]! ^ 1])]));
      await fetch(up2.upload.url, { method: "PUT", body: new Uint8Array(wrong) });
      const bad = await api("/workspace/commit", lease, { upload: up2.upload.id });
      assert.equal(bad.status, 400); assert.match((await bad.json() as { error: string }).error, /sha256 is not the one announced/);
      assert.ok(!has(up.upload.id) && !has(up2.upload.id), "a used upload and a refused one are removed");
      // Tenant work never reads run_transfers.
      await assert.rejects(withTenant(A.orgId, async () => db.query("SELECT * FROM run_transfers")), /permission denied/, "tenant work cannot read run_transfers");
      await client.complete(id, lease, { outcome: "failed", error_kind: "run", error: "manual" });
      await harness.httpRunnerClient(platform.url, W, "w-b").complete(cB.run.id, cB.lease_token, { outcome: "failed", error_kind: "run", error: "manual" });
      assert.equal((await db.query("SELECT 1 FROM run_transfers")).length, 0, "nothing left once the attempts ended");
      assert.deepEqual(transfersIn(A.orgId), [], "nor in the bucket (the checkout's download included)");
      console.log("✓ the lease and the tenant: no lease, no upload; the store's lease gone, no commit; another workspace's run cannot commit it (404); used once; an expired link or another key refused by the bucket; tampered content refused; tenant work cannot read run_transfers");
    }

    // ---------- 6. the platform's 413 below the runner's threshold falls back to the bucket ----------
    {
      await start(ca, "small");
      const client = harness.httpRunnerClient(platform.url, W, "w-fallback");
      const c = (await client.claim(["fixture_big/refresh"]))!;
      const dir = mkdtempSync(path.join(TMP, "fallback-"));
      await client.checkout(c.run.id, c.lease_token, dir);
      writeFileSync(path.join(dir, "applications", "app1", "more.bin"), randomBytes(5 * MiB));
      process.env.APP_WORKER_INLINE_MAX_BYTES = String(64 * MiB); // a runner that does not know the platform's limit
      const from = platform.calls.length;
      try { await client.stage(c.run.id, c.lease_token, dir); } finally { delete process.env.APP_WORKER_INLINE_MAX_BYTES; }
      const api = platform.calls.slice(from);
      assert.deepEqual(api.map((x) => `${x.method} ${x.path.replace(/.*\/runs\/[^/]+/, "")} ${x.status}`), ["PUT /workspace 413", "POST /uploads 200", "POST /workspace/commit 200"],
        "refused by the platform, then through the bucket");
      await client.complete(c.run.id, c.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      console.log("✓ the platform's 413 (FUNCTION_PAYLOAD_TOO_LARGE) below the runner's threshold: the write-back went through the bucket");
    }

    // ---------- 7. refused for size: an event naming the size and the limit ----------
    {
      process.env.APP_WORKSPACE_MAX_BUNDLE_BYTES = String(2_000_000);
      await start(ca);
      let r;
      try { r = await runVia(platform.url, "w-limit"); } finally { delete process.env.APP_WORKSPACE_MAX_BUNDLE_BYTES; }
      assert.equal(r.view?.status, "failed"); assert.equal(r.view?.error_kind, "run");
      assert.match(r.view!.error!, /write back: the workspace's write-back is 5\.\d MB \(\d+ bytes\); this deployment takes at most 2\.0 MB \(2000000 bytes, APP_WORKSPACE_MAX_BUNDLE_BYTES\)/, r.view!.error!);
      const refused = (await ev(r.claim.run.id, "workspace_write_back_refused"))[0];
      assert.ok(refused && refused.bytes > 5_000_000 && refused.limit === 2_000_000, JSON.stringify(refused));
      // No links (a local directory behind a hosted platform; a new workspace, whose store is empty there): the platform's limit, named.
      for (const k of R2) delete process.env[k];
      process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
      const D = (await createOrg(`Large D ${STAMP}`)).org;
      const cd = await connect(D);
      await start(cd);
      let r2;
      try { r2 = await runVia(platform.url, "w-nolinks"); } finally { delete process.env.APP_STORAGE_DIR; useBucket(); await cd.close(); }
      assert.equal(r2.view?.status, "failed");
      assert.match(r2.view!.error!, /the workspace's write-back is 5\.\d MB \(\d+ bytes\), more than the API takes in one request .*FUNCTION_PAYLOAD_TOO_LARGE.*at most 4\.5 MB/, r2.view!.error!);
      const refused2 = (await ev(r2.claim.run.id, "workspace_write_back_refused"))[0];
      assert.ok(refused2 && refused2.bytes > 5_000_000 && refused2.limit === PLATFORM_LIMIT, JSON.stringify(refused2));
      console.log(`✓ refused for size: the run's error and a workspace_write_back_refused event name the size and the limit ("${r.view!.error!.slice(12, 120)}...")`);
    }

    // ---------- 8. a local directory store: as before ----------
    {
      for (const k of R2) delete process.env[k];
      process.env.APP_STORAGE_DIR = path.join(TMP, "objects-local");
      try {
        const C = (await createOrg(`Large C ${STAMP}`)).org;
        const cc = await connect(C);
        await start(cc);
        const s3From = s3.calls.length;
        const r = await runVia(http.base, "w-local");
        assert.equal(r.view?.status, "succeeded", JSON.stringify(r.view));
        assert.equal(s3.calls.length, s3From, "no bucket involved");
        assert.deepEqual(Object.keys((await latest(C.orgId))!.manifest).sort(), ["applications/app1/app.json", "applications/app1/evidence.bin", "applications/app1/repos/repo1.json", "company-profile/company/profile.json"]);
        await cc.close();
      } finally { delete process.env.APP_STORAGE_DIR; useBucket(); }
      console.log("✓ a local directory store (one machine, docker): the write-back went to the API as before, the same files left out");
    }

    // ---------- 9. a large completion; events in batches ----------
    {
      await start(ca, "small");
      const client = harness.httpRunnerClient(platform.url, W, "w-complete");
      const c = (await client.claim(["fixture_big/refresh"]))!;
      const from = platform.calls.length, s3From = s3.calls.length;
      const events = Array.from({ length: 500 }, (_, i) => ({ type: "bulk", data: { i, pad: randomBytes(6000).toString("hex") } }));
      await client.events(c.run.id, c.lease_token, events);
      const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND type = 'bulk'", [c.run.id]))[0]!.n;
      assert.equal(n, 500, "every event appended");
      const big = { outcome: "failed" as const, error_kind: "run" as const, error: `huge ${"x".repeat(5 * MiB)}` };
      const view = await client.complete(c.run.id, c.lease_token, big);
      assert.equal(view.status, "failed");
      assert.deepEqual(apiOver(from, 4 * MiB), [], "no request over 4 MiB");
      assert.ok(platform.calls.slice(from).filter((x) => /\/events$/.test(x.path)).length >= 2, "the events went in batches");
      assert.ok(s3.calls.slice(s3From).some((x) => x.method === "PUT" && x.presigned && x.key.includes("/.transfers/")), "the completion went through the bucket");
      console.log("✓ a 5 MB completion went through the bucket; 6 MB of events in batches under the limit");
    }
  } finally {
    await ca.close(); await cb.close();
    await platform.close();
    await http.close();
  }
  setPacksForTest(null);
  await db.close();
  console.log("LARGE WRITE-BACK TEST PASS");
} finally {
  await s3.close();
  cleanup();
}
process.exit(0);
