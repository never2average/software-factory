// One application build, end to end, through the real app (mold_v0-327): an owner adds four connections over HTTP
// (object storage, a hosting account, a code repository, a database), presses Test on each, marks them "Use in builds",
// adds an application and presses Start build; the session freezes the connections and delivers their values as
// STORAGE_*, HOSTING_*, REPO_* and SYSTEM_* variables; the stand-in agent CLI (scripts/fixtures/agent-cli/cli.mjs) then
// drives the build as a model would: the workspace's MCP tools, the recipe's scripts, a write to the bucket, a git push,
// a deploy and the build's records. Offline: a neutral fixture pack (scripts/fixtures/build-rehearsal/), an embedded
// database, the mold's S3 stand-in (scripts/lib/s3-standin.ts, SigV4 checked), one HTTP stand-in for the hosting API and
// the git host (APP_CONNECTION_TEST_STANDIN, a test world only) whose git half is a real `git http-backend` over a bare
// repository that checks the token, and a TLS Postgres stand-in (setPostgresStandinForTest).
//   npm run test:build-rehearsal
//
// Proves:
//   1. the fixture is a valid pack (its schema and validatePack)
//   2. Test on each of the four connections passes ("It works"), writes status working and the date, and each stand-in
//      saw the call it should, signed with the right secret
//   3. Start build: the session freezes exactly the expected variable names (no value), lists them in its first system
//      message, and the sandbox's environment has exactly those names; the recipe's files are in its working directory
//   4. the build: the bucket takes an object signed with the delivered keys; the wiring check passes; the push lands in
//      the bare repository (the token checked by the server, never in .git/config); the fake deploy receives the
//      application's variables by name with the right values; a printed token is redacted
//   5. the build and deployment records are created through the session's MCP tools and the build moved queued, running,
//      deploying, succeeded (its history says so)
//   6. a member's Start build (no owner turned on "Members' builds may use its keys") freezes none and its sandbox has none
//   7. no secret anywhere: every HTTP answer, every line printed, every table of the database, the trace, the pushed
//      repository and its working copy's git config
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { startS3Standin } from "./lib/s3-standin.js";

const T0 = Date.now();
const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "build-rehearsal");
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`✓ ${m} (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const until = async (what: string, f: () => Promise<boolean>, ms = 30_000) => {
  const t = Date.now();
  while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
};

// Fakes made at run time, never key-shaped, never stored anywhere but the stand-ins' memory.
const fake = (w: string) => `${w}-${randomBytes(16).toString("hex")}`;
const S3_ID = `EXAMPLE${randomBytes(8).toString("hex").toUpperCase()}`, S3_SECRET = fake("s3secret");
const HOSTING_TOKEN = fake("hosting"), REPO_TOKEN = fake("repo"), PG_PASSWORD = fake("pgpass");
const PG_HOST = "pg.example.com";
const PG_URL = `postgresql://app_owner:${PG_PASSWORD}@${PG_HOST}:5432/app`;
const basic = (t: string) => Buffer.from(`x-access-token:${t}`).toString("base64");
const SECRETS = [S3_ID, S3_SECRET, HOSTING_TOKEN, REPO_TOKEN, PG_PASSWORD, basic(REPO_TOKEN)];
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s)).map((s) => sha(s).slice(0, 12));

const EXPECTED_NAMES = ["HOSTING_ACCOUNT_ID", "HOSTING_API_TOKEN", "HOSTING_PROVIDER", "REPO_NAME", "REPO_OWNER", "REPO_PROVIDER", "REPO_TOKEN",
  "STORAGE_ACCESS_KEY_ID", "STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_SECRET_ACCESS_KEY", "SYSTEM_KIND", "SYSTEM_URL"];

// ---------- the bucket (S3 stand-in, SigV4 checked) ----------
const s3 = await startS3Standin({ buckets: ["example-app-files"], keys: { [S3_ID]: S3_SECRET } });

// ---------- the repository: a bare repository served by git http-backend, the token checked ----------
const GITROOT = path.join(TMP, "git");
const BARE = path.join(GITROOT, "acme", "example-app.git");
mkdirSync(path.dirname(BARE), { recursive: true });
execFileSync("git", ["init", "-q", "--bare", "-b", "main", BARE]);
execFileSync("git", ["-C", BARE, "config", "http.receivepack", "true"]);
const gitSeen: { path: string; service: string; auth: "none" | "good" | "bad" }[] = [];
function gitBackend(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: string) {
  const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ""));
  const auth = !m ? "none" : m[1] === basic(REPO_TOKEN) ? "good" : "bad";
  gitSeen.push({ path: pathname, service: new URLSearchParams(search).get("service") ?? pathname.split("/").pop()!, auth });
  if (auth !== "good") { res.writeHead(401, { "www-authenticate": 'Basic realm="example"', "content-type": "text/plain" }); res.end("Authentication required."); return; }
  const cgi = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: GITROOT, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: pathname,
    REQUEST_METHOD: req.method!, QUERY_STRING: search.replace(/^\?/, ""), CONTENT_TYPE: String(req.headers["content-type"] ?? ""), REMOTE_USER: "x-access-token",
    REMOTE_ADDR: "127.0.0.1", HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""), GIT_HTTP_MAX_REQUEST_BUFFER: "100M" } });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), started = false;
  cgi.stdout.on("data", (d: Buffer) => {
    if (started) { res.write(d); return; }
    head = Buffer.concat([head, d]);
    const i = head.indexOf("\r\n\r\n");
    if (i < 0) return;
    started = true;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.subarray(0, i).toString().split("\r\n")) {
      const at = line.indexOf(":");
      const k = line.slice(0, at).trim(), v = line.slice(at + 1).trim();
      if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]); else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(i + 4));
  });
  cgi.stdout.on("end", () => res.end());
  cgi.stderr.resume();
}

// ---------- the hosting API and the git host, behind one stand-in (/<host><path>) ----------
const hostingSeen: { method: string; path: string; auth: boolean }[] = [];
const hostingEnv = new Map<string, { type: string; valueSha: string }>();
const deployments = new Map<string, { name: string; reads: number }>();
const svc = http.createServer((req, res) => {
  const [, host, ...rest] = (req.url ?? "/").split("/");
  const u = new URL(`/${rest.join("/")}`, "http://x");
  if (host === "git.example.com") return gitBackend(req, res, u.pathname, u.search);
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const json = (s: number, v: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (host !== "api.hosting.example.com") return json(404, { message: "no such stand-in host" });
    const good = req.headers.authorization === `Bearer ${HOSTING_TOKEN}`;
    hostingSeen.push({ method: req.method!, path: u.pathname, auth: good });
    if (!good) return json(403, { error: { message: "Not authorized" } });
    if (u.searchParams.has("teamId") && u.searchParams.get("teamId") !== "team_example") return json(403, { error: { message: "Not a member of that team" } });
    const team = /^\/v2\/teams\/([^/]+)$/.exec(u.pathname);
    if (team && req.method === "GET") return team[1] === "team_example" ? json(200, { id: "team_example", slug: "acme" }) : json(404, { error: { message: "No such team" } });
    const env = /^\/v10\/projects\/([^/]+)\/env$/.exec(u.pathname);
    if (env && req.method === "POST") {
      const b = JSON.parse(Buffer.concat(chunks).toString());
      hostingEnv.set(String(b.key), { type: String(b.type), valueSha: sha(String(b.value)) });
      return json(201, { created: { key: b.key } });
    }
    if (u.pathname === "/v13/deployments" && req.method === "POST") {
      const b = JSON.parse(Buffer.concat(chunks).toString());
      const id = `dpl_${randomBytes(6).toString("hex")}`;
      deployments.set(id, { name: String(b.name), reads: 0 });
      return json(200, { id, url: `${b.name}-${id.slice(4, 10)}.hosting.example.com`, readyState: "QUEUED" });
    }
    const d = /^\/v13\/deployments\/([^/]+)$/.exec(u.pathname);
    if (d && deployments.has(d[1]!)) {
      const x = deployments.get(d[1]!)!;
      x.reads++;
      return json(200, { id: d[1], url: `${x.name}-${d[1]!.slice(4, 10)}.hosting.example.com`, readyState: x.reads >= 2 ? "READY" : "BUILDING" });
    }
    return json(404, { error: { message: "Not found" } });
  });
});
await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
const SVC = `http://127.0.0.1:${(svc.address() as AddressInfo).port}`;
process.env.APP_CONNECTION_TEST_STANDIN = SVC;

// ---------- the database: a TLS Postgres stand-in (startup, cleartext password, simple queries) ----------
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "pg-key.pem"), "-out", path.join(TMP, "pg-cert.pem"), "-days", "1",
  "-subj", `/CN=${PG_HOST}`, "-addext", `subjectAltName=DNS:${PG_HOST}`], { stdio: "ignore" });
const PG_KEY = readFileSync(path.join(TMP, "pg-key.pem"), "utf8"), PG_CERT = readFileSync(path.join(TMP, "pg-cert.pem"), "utf8");
const pgSeen: { password: "good" | "bad" | null; queries: string[] }[] = [];
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s: string) => Buffer.from(`${s}\0`);
const pgMsg = (t: string, b: Buffer) => Buffer.concat([Buffer.from(t), i32(b.length + 4), b]);
const pg = net.createServer((raw) => {
  raw.on("error", () => {});
  raw.once("data", (first: Buffer) => {
    if (first.length < 8 || first.readInt32BE(4) !== 80877103) { raw.destroy(); return; } // SSLRequest only
    raw.write("S");
    const conn = { password: null as "good" | "bad" | null, queries: [] as string[] };
    pgSeen.push(conn);
    const sock = new tls.TLSSocket(raw, { isServer: true, key: PG_KEY, cert: PG_CERT });
    let buf = Buffer.alloc(0), startup = false;
    sock.on("error", () => {});
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!startup) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0)); startup = true;
          sock.write(pgMsg("R", i32(3))); // AuthenticationCleartextPassword
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
        const t = String.fromCharCode(buf[0]!), len = buf.readInt32BE(1), body = buf.subarray(5, 1 + len).toString().replace(/\0$/, "");
        buf = buf.subarray(1 + len);
        if (t === "p") {
          conn.password = body === PG_PASSWORD ? "good" : "bad";
          if (conn.password === "bad") { sock.write(pgMsg("E", Buffer.concat([cstr("SFATAL"), cstr("C28P01"), cstr("Mpassword authentication failed"), Buffer.from("\0")]))); sock.end(); return; }
          sock.write(Buffer.concat([pgMsg("R", i32(0)), pgMsg("Z", Buffer.from("I"))]));
        } else if (t === "Q") {
          conn.queries.push(body);
          if (/^SELECT 1\b/.test(body)) sock.write(Buffer.concat([pgMsg("T", Buffer.concat([i16(1), cstr("ok"), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)])),
            pgMsg("D", Buffer.concat([i16(1), i32(1), Buffer.from("1")])), pgMsg("C", cstr("SELECT 1")), pgMsg("Z", Buffer.from("T"))]));
          else sock.write(Buffer.concat([pgMsg("C", cstr(body.split(" ")[0]!)), pgMsg("Z", Buffer.from(/^(BEGIN|SET)\b/.test(body) ? "T" : "I"))]));
        } else if (t === "X") { sock.end(); return; }
      }
    });
  });
});
await new Promise<void>((r) => pg.listen(0, "127.0.0.1", r));

// ---------- the fixture pack, its recipe's files read from the fixture's recipe/ ----------
const PACK = JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));
const RECIPE_DIR = path.join(FIXTURE, "recipe");
const walk = (d: string): string[] => readdirSync(d).sort().flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
PACK.recipes[0].files = walk(RECIPE_DIR).map((f) => ({ path: path.relative(RECIPE_DIR, f).split(path.sep).join("/"), content: readFileSync(f, "utf8"),
  ...(f.endsWith(".py") ? { executable: true } : {}) }));
const RECIPE_FILES = PACK.recipes[0].files.map((f: { path: string }) => f.path);

const answers: string[] = [];
let failed = false;
try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const api = await import("../src/pack-api.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const P = await import("../src/agent-profiles.js");
  const harness = await import("../src/run-harness.js");
  const CT = await import("../src/connection-test.js");
  const S = await import("../src/connection-test-signed.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations, PackJsonSchema } = await import("../src/pack-manifest.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { createOrg } = await import("../src/auth.js");

  // ---------- 1. the fixture is a valid pack ----------
  {
    const parsed = PackJsonSchema.safeParse(PACK);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    api.validatePack({ id: PACK.id, ...compileDeclarations(PACK) } as never);
    ok("the fixture is a valid pack: four connection areas with their Test, an applications area with Start build, a build profile with connection_env and a recipe");
  }

  setPacksForTest([{ manifest: { id: PACK.id, name: PACK.name, version: PACK.version, entry: null, migrations: null, words: {}, dir: FIXTURE }, declared: compileDeclarations(PACK) } as never]);
  F.setFeaturesForTest({ agent_harness: true, record_pages: true, workspace_storage: true, encrypted_fields: true, workspace_recipes: true, teams: true });
  P.resetProfileSeedForTest();
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  CT.setResolverForTest(async () => ["93.184.216.34"]); // every example.com name is public (the stand-in answers for it)
  S.setPostgresStandinForTest({ port: (pg.address() as AddressInfo).port, ca: PG_CERT });
  const web = await startHttp();
  process.env.PUBLIC_URL = web.base;
  const A = (await createOrg(`Build rehearsal ${STAMP}`)).org;
  const owner = await web.signInAs(A, "owner");
  const member = await web.signInAs(A, "member");
  const as = (token: string) => async (method: string, p: string, body?: unknown) => {
    const r = await web.req(method, p, { authorization: `Bearer ${token}`, "x-pack-request": "1" }, body);
    const text = await r.text();
    answers.push(text);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
    return { status: r.status, body: parsed };
  };
  const call = as(owner.token), callMember = as(member.token);
  const record = async (area: string, key: string) => { const r = await call("GET", `/api/data/${area}/${key}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.record ?? r.body) as { title: string; data: Record<string, any> }; };
  const pageAction = async (c: typeof call, area: string, key: string, kind: string) => {
    const p = await c("GET", `/api/records/_page/${area}/${key}`);
    assert.equal(p.status, 200, `${area}/${key}'s page: ${JSON.stringify(p.body).slice(0, 300)}`);
    const a = (p.body.actions ?? []).find((x: any) => x.kind === kind);
    assert.ok(a, `${area}/${key} offers ${kind} (${(p.body.actions ?? []).map((x: any) => x.kind).join(", ")})`);
    assert.ok(!a.disabled, `${area}/${key}'s ${kind} is not disabled: ${a.disabled}`);
    return a.id as string;
  };

  // ---------- 2. the four connections, added and tested over HTTP ----------
  const CONNECTIONS = [
    { area: "storage_connections", key: "app-files", kind: "test_storage", title: "App files",
      data: { bucket: "example-app-files", endpoint: s3.url, region: "auto", access_key_id: S3_ID, secret_access_key: S3_SECRET } },
    { area: "hosting_accounts", key: "acme-hosting", kind: "test_connection", title: "Acme hosting", data: { provider: "example-hosting", account_id: "team_example", api_token: HOSTING_TOKEN } },
    { area: "repositories", key: "example-app", kind: "test_connection", title: "example-app", data: { provider: "example-git", owner: "acme", repo_name: "example-app", token: REPO_TOKEN } },
    { area: "databases", key: "app-db", kind: "test_connection", title: "App database", data: { kind: "postgres", url: PG_URL } },
  ] as const;
  {
    const today = new Date().toISOString().slice(0, 10);
    for (const c of CONNECTIONS) {
      const r = await call("POST", `/api/data/${c.area}`, { key: c.key, title: c.title, data: c.data });
      assert.ok(r.status < 300, `adding ${c.area}/${c.key}: ${r.status} ${JSON.stringify(r.body)}`);
      CT.resetTestRateForTest();
      const t = await call("POST", `/api/records/_page/${c.area}/${c.key}/actions/${await pageAction(call, c.area, c.key, c.kind)}`);
      assert.equal(t.status, 200, `Test on ${c.area}: ${JSON.stringify(t.body)}`);
      assert.equal(t.body.ok, true, `Test on ${c.area} passes: ${JSON.stringify(t.body)}`);
      assert.match(String(t.body.words), /^It works\b/, `Test on ${c.area} says it works: ${t.body.words}`);
      const d = (await record(c.area, c.key)).data;
      assert.equal(d.status, "working", `${c.area}: status written`);
      assert.equal(d.tested, today, `${c.area}: tested today`);
    }
    // Each stand-in saw the call it should, signed with the right secret (and nothing failed its check).
    assert.deepEqual(s3.calls.filter((x) => x.status < 300).map((x) => x.method), ["PUT", "GET", "DELETE"], "the bucket: a test object written, read back and deleted");
    assert.ok(s3.calls.every((x) => x.accessKeyId === S3_ID && x.status < 300), "every bucket call signed with the stored key");
    assert.deepEqual(hostingSeen, [{ method: "GET", path: "/v2/teams/team_example", auth: true }], "the hosting API: the team read with the token");
    assert.deepEqual(gitSeen.filter((g) => g.auth === "good").map((g) => [g.path, g.service]), [["/acme/example-app.git/info/refs", "git-receive-pack"]], "the git host: push discovery with the token");
    assert.ok(!gitSeen.some((g) => g.auth === "bad"), "never a wrong token at the git host");
    assert.equal(pgSeen.length, 1, "one database connection");
    assert.equal(pgSeen[0]!.password, "good", "the database's password checked");
    assert.deepEqual(pgSeen[0]!.queries, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '10s'", "SELECT 1 AS ok", "ROLLBACK"], "the database answered SELECT 1, read-only");
    ok("Test passes on each connection (bucket written, read and deleted; hosting team read; git push discovery; Postgres over TLS), status working and tested today");
  }

  // ---------- 3. Use in builds, the application, Start build ----------
  let sid: string, WD: string;
  const agentMessages = async (c: typeof call, id: string) => {
    const r = await c("GET", `/api/agent/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    return r.body.session.messages as { role: string; body: string }[];
  };
  const client = await harness.localRunnerClient("w-build-rehearsal");
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 250 };
  const wake = async (sessionId: string) => {
    const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]);
    assert.ok(c, "a wake to claim");
    const [r] = await db.query<{ harness_session_id: string }>("SELECT harness_session_id FROM runs WHERE id = $1", [c!.run.id]);
    assert.equal(r!.harness_session_id, sessionId, "the wake is this session's");
    return harness.runWorkspaceHarness(client, c!, opts);
  };
  /** Send one message as `c` and wait for the agent's next answer (by count: whole answers, in order). */
  const asker = (c: typeof call, id: string) => async (text: string, ms = 30_000) => {
    const n = (await agentMessages(c, id)).filter((m) => m.role === "agent").length;
    const r = await c("POST", `/api/agent/${id}/messages`, { message: text });
    assert.ok(r.status < 300, `message: ${JSON.stringify(r.body)}`);
    let last = "";
    await until(`the answer to "${text.slice(0, 60)}"`, async () => {
      const agent = (await agentMessages(c, id)).filter((m) => m.role === "agent");
      if (agent.length <= n) return false;
      last = agent[n]!.body;
      return true;
    }, ms);
    return last;
  };
  const ran = (answer: string, what: string) => {
    const m = /^Ran: (\d+) ?([\s\S]*)$/.exec(answer);
    assert.ok(m, `${what}: ${answer.slice(0, 400)}`);
    assert.equal(m![1], "0", `${what} exits 0: ${answer.slice(0, 600)}`);
    return m![2]!.trim();
  };
  const mcpJson = (answer: string, tool: string) => {
    const m = new RegExp(`^MCP ${tool}: ([\\s\\S]*)$`).exec(answer);
    assert.ok(m, `${tool} answered: ${answer.slice(0, 400)}`);
    return JSON.parse(m![1]!);
  };
  let ask: (text: string, ms?: number) => Promise<string>;
  let wakeDone: Promise<unknown>;
  {
    for (const c of CONNECTIONS) {
      const cur = await record(c.area, c.key);
      // The edit form as the console sends it: the masked secrets left empty (kept), "Use in builds" turned on.
      const data = Object.fromEntries(Object.entries(cur.data).filter(([, v]) => typeof v !== "object" || v === null));
      const r = await call("POST", `/api/records/_page/${c.area}/${c.key}/actions/${await pageAction(call, c.area, c.key, "edit")}`, { title: cur.title, data: { ...data, use_for_builds: true } });
      assert.ok(r.status < 300, `Use in builds on ${c.area}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await record(c.area, c.key)).data.use_for_builds, true);
    }
    const app = await call("POST", "/api/data/applications", { key: "example-app", title: "Example app", data: { summary: "A small portal where vendors upload documents.", repository: "example-app",
      brief: "Vendors sign in and upload their documents, which are kept in the bucket." } });
    assert.ok(app.status < 300, `adding the application: ${JSON.stringify(app.body)}`);
    const started = await call("POST", `/api/records/_page/applications/example-app/actions/${await pageAction(call, "applications", "example-app", "start_agent")}`);
    assert.equal(started.status, 200, `Start build: ${JSON.stringify(started.body)}`);
    sid = started.body.session.id;
    const [row] = await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [sid]);
    const frozen = row!.policy.connection_env as { area: string; key: string; vars: { env: string }[] }[];
    assert.deepEqual(frozen.map((e) => [e.area, e.key]), [["hosting_accounts", "acme-hosting"], ["storage_connections", "app-files"], ["repositories", "example-app"], ["databases", "app-db"]],
      "each connection marked Use in builds frozen by key");
    assert.deepEqual(frozen.flatMap((e) => e.vars.map((v) => v.env)).sort(), EXPECTED_NAMES, "exactly the expected variable names frozen");
    assert.deepEqual(leaks(JSON.stringify(row!.policy)), [], "no value in the session's policy");
    assert.deepEqual((row!.policy.recipes ?? []).map((r: { id: string }) => r.id), ["build-steps"], "the profile's recipe frozen");
    const sys = (await agentMessages(call, sid)).filter((m) => m.role === "system").map((m) => m.body).join("\n");
    for (const n of EXPECTED_NAMES) assert.match(sys, new RegExp(`\\b${n}\\b`), `the first system message names ${n}`);

    wakeDone = wake(sid);
    ask = asker(call, sid);
    await until("the first answer", async () => (await agentMessages(call, sid)).some((m) => m.role === "agent"));
    const msgs = await agentMessages(call, sid);
    assert.deepEqual(msgs.filter((m) => m.role !== "system" && m.role !== "agent").map((m) => m.body),
      ["Build the application Example app (example-app).\nRepository: example-app.\nWhat it is: A small portal where vendors upload documents."], "the first message filled from the record");
    assert.equal(msgs.find((m) => m.role === "agent")!.body, "Echo: What it is: A small portal where vendors upload documents.", "the agent took it in");
    WD = /^Working in (.+)\.$/.exec(await ask("pwd"))![1]!;
    const names = ran(await ask("run printenv | cut -d= -f1 | grep -E '^(HOSTING|STORAGE|REPO|SYSTEM)_' | sort | tr '\\n' ' '"), "the session's variable names");
    assert.deepEqual(names.split(/\s+/).filter(Boolean), EXPECTED_NAMES, "the sandbox has exactly the expected variables");
    const files = ran(await ask("run find scripts -type f | sort | tr '\\n' ' '; ls BUILD.md"), "the recipe's files");
    for (const f of RECIPE_FILES) assert.ok(files.split(/\s+/).includes(f), `the recipe's ${f} is in the working directory (${files})`);
    ok("Use in builds on each, the application added, Start build: exactly the 14 variable names frozen and in the sandbox, the recipe's files in its working directory");
  }

  // ---------- 4. the build ----------
  {
    const app = mcpJson(await ask(`mcp ex_get_applications {"key":"example-app"}`), "ex_get_applications");
    assert.equal((app.record ?? app).data.repository, "example-app", "the agent reads the application's record");
    const repos = await ask(`mcp ex_list_repositories {}`);
    assert.match(repos, /^MCP ex_list_repositories: /, repos);
    assert.match(repos, /\bexample-app\b/, "the agent lists the repositories");

    // What a model writes with its Write tool, into the wake's working directory.
    const w = (f: string, v: string) => { mkdirSync(path.dirname(path.join(WD, f)), { recursive: true }); writeFileSync(path.join(WD, f), v); };
    w("app/package.json", JSON.stringify({ name: "example-app", private: true, scripts: { build: "next build" } }, null, 2));
    w("app/.gitignore", ".env\n.env*\nnode_modules\n");
    w("app/src/storage.ts", "export const storage = { bucket: process.env.STORAGE_BUCKET, endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION,\n" +
      "  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY };\n");
    w("app/src/db.ts", "export const databaseUrl = process.env.DATABASE_URL;\n");
    w("app/blocks.json", JSON.stringify({ blocks: [
      { block: "storage", env: ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"] },
      { block: "database", env: ["SYSTEM_URL"], reads: ["DATABASE_URL"] },
      { block: "hosting", env: ["HOSTING_API_TOKEN", "HOSTING_ACCOUNT_ID"], reads: [] },
      { block: "repository", env: ["REPO_OWNER", "REPO_NAME", "REPO_TOKEN"], reads: [] }] }, null, 2));
    const sdk = path.join(ROOT, "node_modules", "@aws-sdk", "client-s3", "dist-cjs", "index.js");
    w("s3-put.cjs", `const { S3Client, PutObjectCommand } = require(${JSON.stringify(sdk)});
const c = new S3Client({ endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION, forcePathStyle: true,
  credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY } });
c.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: "builds/example-app/hello.txt", Body: "hello" }))
  .then(() => console.log("put ok"), (e) => { console.log("put failed: " + e.name); process.exit(1); });
`);

    // The bucket takes an object signed with the delivered STORAGE_* keys.
    assert.equal(ran(await ask("run node s3-put.cjs"), "the write to the bucket"), "put ok");
    const put = s3.calls.find((x) => x.method === "PUT" && x.key === "builds/example-app/hello.txt");
    assert.ok(put && put.status === 200 && put.accessKeyId === S3_ID, "the bucket stored the build's object, signed with the delivered key");

    // The recipe's wiring check.
    const check = JSON.parse(ran(await ask("run python3 scripts/steps/wiring_check.py app"), "the wiring check"));
    assert.equal(check.ok, true, `every block wired: ${JSON.stringify(check)}`);
    assert.deepEqual(check.blocks.map((b: { block: string; status: string }) => [b.block, b.status]), [["storage", "wired"], ["database", "wired"], ["hosting", "wired"], ["repository", "wired"]]);

    // The push: through the git host's stand-in, the token through the recipe's credential helper.
    const pushed = JSON.parse(ran(await ask(`run node scripts/steps/push.mjs app b-1 ${SVC}/git.example.com/`), "the push"));
    const head = execFileSync("git", ["-C", BARE, "rev-parse", "main"], { encoding: "utf8" }).trim();
    assert.equal(head, pushed.pushed, "the push landed on main in the repository");
    assert.equal(execFileSync("git", ["-C", BARE, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), "Build b-1");
    assert.deepEqual(execFileSync("git", ["-C", BARE, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).trim().split("\n").sort(),
      [".gitignore", "blocks.json", "package.json", "src/db.ts", "src/storage.ts"], "the application's files, nothing else");
    assert.ok(gitSeen.some((g) => g.service === "git-receive-pack" && g.path.endsWith("/git-receive-pack") && g.auth === "good"), "the pack was received with the token");
    assert.ok(!gitSeen.some((g) => g.auth === "bad"), "never a wrong token");
    const gitConfig = readFileSync(path.join(WD, "app", ".git", "config"), "utf8");
    assert.match(gitConfig, /url = https:\/\/git\.example\.com\/acme\/example-app\.git/, "the remote is the repository's own address");
    assert.deepEqual(leaks(gitConfig), [], "no token in .git/config");
    assert.doesNotMatch(gitConfig, /\bhelper\b/, "no credential helper saved");

    // The deploy: the application's variables by name, then one deployment read until it is ready.
    const dep = JSON.parse(ran(await ask(`run node scripts/steps/deploy.mjs example-app ${SVC}/api.hosting.example.com`), "the deploy"));
    assert.equal(dep.state, "READY", `the deployment is ready: ${JSON.stringify(dep)}`);
    assert.match(dep.url, /^https:\/\/example-app-[0-9a-f]{6}\.hosting\.example\.com$/);
    assert.deepEqual([...hostingEnv.keys()].sort(), ["DATABASE_URL", "STORAGE_ACCESS_KEY_ID", "STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_SECRET_ACCESS_KEY"],
      "the hosting project received exactly the application's variables, by name");
    const want: Record<string, [string, string]> = { STORAGE_BUCKET: ["example-app-files", "plain"], STORAGE_ENDPOINT: [s3.url, "plain"], STORAGE_REGION: ["auto", "plain"],
      STORAGE_ACCESS_KEY_ID: [S3_ID, "encrypted"], STORAGE_SECRET_ACCESS_KEY: [S3_SECRET, "encrypted"], DATABASE_URL: [PG_URL, "encrypted"] };
    for (const [k, [v, type]] of Object.entries(want)) assert.deepEqual(hostingEnv.get(k), { type, valueSha: sha(v) }, `${k}: the right value (by its hash), ${type}`);
    assert.ok(hostingSeen.filter((x) => x.path !== "/v2/teams/team_example").every((x) => x.auth), "every deploy call made with the delivered token");

    // A token the agent prints is redacted, in the answer as everywhere.
    const printedToken = await ask("run printenv REPO_TOKEN");
    assert.match(printedToken, /^Ran: 0 \[credential connection:repositories\/REPO_TOKEN\]$/, `a printed token is redacted: ${printedToken.slice(0, 200)}`);

    // ---------- 5. the build's records, through the session's MCP tools ----------
    const created = mcpJson(await ask(`mcp ex_create_builds {"key":"b-1","title":"Example app, build 1","data":{"application":"example-app"}}`), "ex_create_builds");
    assert.equal((created.record ?? created).data.status, "queued", "a new build starts queued");
    for (const to of ["running", "deploying"]) mcpJson(await ask(`mcp ex_move_builds {"key":"b-1","to":"${to}"}`), "ex_move_builds");
    mcpJson(await ask(`mcp ex_create_deployments ${JSON.stringify({ key: "b-1:production", title: "Example app, production", data: { build: "b-1", application: "example-app",
      hosting_deployment_id: dep.id, deployment_url: dep.url, state: dep.state } })}`), "ex_create_deployments");
    mcpJson(await ask(`mcp ex_update_builds ${JSON.stringify({ key: "b-1", title: "Example app, build 1", data: { application: "example-app", deployment_url: dep.url,
      outcome: `Deployed to ${dep.url}; pushed ${pushed.pushed.slice(0, 7)} to main.` } })}`), "ex_update_builds");
    mcpJson(await ask(`mcp ex_move_builds {"key":"b-1","to":"succeeded"}`), "ex_move_builds");
    const build = await record("builds", "b-1"), deployment = await record("deployments", "b-1:production");
    assert.equal(build.data.status, "succeeded");
    assert.equal(build.data.deployment_url, dep.url);
    assert.deepEqual([deployment.data.build, deployment.data.state, deployment.data.hosting_deployment_id, deployment.data.deployment_url], ["b-1", "READY", dep.id, dep.url]);
    const history = await db.query<{ action: string; changes: { field: string; after?: unknown }[] }>(
      "SELECT action, changes FROM record_changes WHERE org_id = $1 AND area = 'builds' AND key = 'b-1' ORDER BY id", [A.orgId]);
    assert.deepEqual(history.filter((h) => h.action === "moved").map((h) => h.changes.find((c) => c.field === "status")?.after), ["running", "deploying", "succeeded"],
      "the build moved running, deploying, succeeded (its history)");
    assert.equal(history[0]!.action, "created");
    ok("the build: an object in the bucket, wiring check passed, pushed to main (no token in .git/config), deployed with its variables by name, a printed token redacted, the build and deployment recorded and moved to succeeded");

    assert.ok((await call("POST", `/api/agent/${sid}/stop`)).status < 300, "the owner stops the session");
    await wakeDone;
  }

  // ---------- 6. a member's Start build: no keys without an owner's opt-in ----------
  {
    const started = await callMember("POST", `/api/records/_page/applications/example-app/actions/${await pageAction(callMember, "applications", "example-app", "start_agent")}`);
    assert.equal(started.status, 200, `a member's Start build: ${JSON.stringify(started.body)}`);
    const mid = started.body.session.id as string;
    const [row] = await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [mid]);
    assert.equal(row!.policy.connection_env, undefined, "nothing frozen for a member's session");
    const sys = (await agentMessages(callMember, mid)).filter((m) => m.role === "system").map((m) => m.body).join("\n");
    for (const area of ["Hosting", "Storage", "Repositories", "Databases"])
      assert.match(sys, new RegExp(`${area}: a workspace owner has not turned on "Members' builds may use its keys"`), `the member is told why ${area} is not set`);
    const done = wake(mid);
    const askM = asker(callMember, mid);
    await until("the member's first answer", async () => (await agentMessages(callMember, mid)).some((m) => m.role === "agent"));
    assert.equal(ran(await askM("run printenv | cut -d= -f1 | grep -E '^(HOSTING|STORAGE|REPO|SYSTEM)_' | wc -l"), "the member's variables"), "0", "the member's sandbox has none of them");
    assert.ok((await callMember("POST", `/api/agent/${mid}/stop`)).status < 300);
    await done;
    ok("a member's Start build without an owner's opt-in: nothing frozen, the reason named per connection, none of the variables in its sandbox");
  }

  // ---------- 7. no secret anywhere ----------
  {
    const trace = await call("GET", `/api/agent/${sid}/trace`);
    assert.equal(trace.status, 200);
    assert.ok(JSON.stringify(trace.body).includes("[credential connection:repositories/REPO_TOKEN]"), "the trace shows the printed token redacted");
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
    const found: string[] = [];
    for (const { table_name } of tables) {
      const rows = await db.query<{ t: string }>(`SELECT t::text AS t FROM "${table_name}" t`);
      const l = leaks(rows.map((r) => r.t).join("\n"));
      if (l.length) found.push(`${table_name}: ${l.join(", ")}`);
    }
    assert.deepEqual(found, [], "no table of the database holds a secret in the clear");
    const repo = execFileSync("git", ["-C", BARE, "log", "-p", "--all", "--format=%H %an %ae %s"], { encoding: "utf8" });
    assert.deepEqual(leaks(repo), [], "nothing secret in the pushed repository");
    const answersLeaks = answers.flatMap((a, i) => leaks(a).map((x) => `answer ${i}: ${x}`));
    assert.deepEqual(answersLeaks, [], "no HTTP answer holds a secret");
    const printedLeaks = printed.flatMap((p) => leaks(p));
    assert.deepEqual(printedLeaks, [], "nothing printed holds a secret");
    ok(`no secret anywhere: ${answers.length} HTTP answers, ${tables.length} tables, the trace, the pushed repository, everything printed`);
  }
  await web.close();
  console.log(`build-rehearsal-test: all passed in ${((Date.now() - T0) / 1000).toFixed(1)} s`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await s3.close();
  svc.close();
  pg.close();
  cleanup();
}
process.exit(failed ? 1 : 0);
