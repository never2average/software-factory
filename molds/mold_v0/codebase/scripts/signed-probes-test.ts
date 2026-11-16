// Test connection's signed kinds (mold_v0-313; src/connection-test-signed.ts, src/connection-test-config.ts), offline:
// an HTTPS stand-in on 127.0.0.1 (APP_CONNECTION_TEST_STANDIN) that checks the SigV4 signature and the JWT assertion
// with its own code, a TLS Postgres stand-in speaking the wire protocol (setPostgresStandinForTest), and the embedded
// database for the record's own path. No real host is called. Both stand-ins are honoured in a test world only.
//   npx tsx scripts/signed-probes-test.ts
//
// Proves:
//   1. the declaration: each kind's roles name the area's fields, encrypted where they hold a secret and plain where
//      they decide where it goes; postgres a url or host + user + password, its hosts public, ports 1024 to 65535
//   2. the binding: a region, a tenant, a database's host or port (and `by`) changed without the secret clears it;
//      a fixed host binds nothing; a database's name keeps it
//   3. SigV4 against AWS's own published example
//   4. aws_sigv4: works (global and regional, a session token signed too), keys refused with their echo cut out, a
//      region that is not one refused before any call
//   5. gcp_service_account: works (project, token), another key refused, a crafted token_uri never called, a key file
//      that is not one said in words
//   6. azure_client_credentials: works (a subscription, the list), a secret refused with its echo cut out, a tenant
//      that climbs the address refused before any call
//   7. postgres: works over TLS (statement timeout, read-only transaction, SELECT 1), a password refused (the server's
//      echo never read), a certificate for another name refused before the password is sent, a server without TLS
//      refused, a host off the list / a private address / an address literal / another port / this app's database (by
//      name or address) refused before any connection; a url parsed by the test, never the client library; a server
//      that never closes does not hold the probe (its socket destroyed); the statement timeout set inside the transaction
//   8. the record: status and date written as the app's action, an owner's only, no secret in the answer, anything
//      printed, the history, the data trail or the stored row
import { cleanup, STAMP, TMP } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto, { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import tls from "node:tls";

const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}
const ok = (m: string) => console.log(`✓ ${m}`);
const can = (w: string) => `${w}CANARY${randomBytes(12).toString("hex")}`;

// ---------- the secrets ----------
const AKID = "AKIAEXAMPLE" + randomBytes(5).toString("hex").toUpperCase(), AWS_SECRET = can("awsSecret/"), AWS_TOKEN = can("sessTok"), AWS_BAD = can("awsBad");
const SA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), OTHER = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_PEM = SA.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), OTHER_PEM = OTHER.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const GTOKEN = can("ya29."), AZ_SECRET = can("azSecret~"), AZ_BAD = can("azBad~"), AZ_TOKEN = can("eyAz"), PG_PW = can("pgPw"), PG_BAD = can("pgBad");
const TENANT = "11111111-2222-3333-4444-555555555555", CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", SUB = "99999999-8888-7777-6666-555555555555";
const keyFile = (pem: string, over: Record<string, unknown> = {}) => JSON.stringify({ type: "service_account", project_id: "my-project-123", private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: pem, client_email: "probe@my-project-123.iam.gserviceaccount.com", client_id: "1234567890", token_uri: "https://oauth2.googleapis.com/token", ...over }, null, 2);
const SECRETS = [AWS_SECRET, AWS_TOKEN, AWS_BAD, SA_PEM, OTHER_PEM, GTOKEN, AZ_SECRET, AZ_BAD, AZ_TOKEN, PG_PW, PG_BAD,
  ...[SA_PEM, OTHER_PEM].map((p) => p.split("\n")[5]!)]; // a line of each key's body, too
const derived: string[] = []; // what the stand-ins saw that only a secret makes: signatures, assertions, Authorization

// ---------- an independent SigV4 check (the stand-in's own code, not src/'s) ----------
const H = (k: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", k).update(s).digest();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function sigv4Valid(host: string, headers: http.IncomingHttpHeaders, body: string, secrets: Record<string, string>): { ok: boolean; region?: string; token?: string } {
  const m = /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/sts\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(String(headers.authorization ?? ""));
  if (!m) return { ok: false };
  const [, akid, date, region, signed, sig] = m as unknown as string[];
  derived.push(sig!, String(headers.authorization));
  const secret = secrets[akid!];
  if (!secret) return { ok: false };
  const names = signed!.split(";");
  if (!names.includes("host") || !names.includes("x-amz-date")) return { ok: false };
  const val = (n: string) => (n === "host" ? host : String(headers[n] ?? "").trim());
  const canonical = `POST\n/\n\n${names.map((n) => `${n}:${val(n)}\n`).join("")}\n${signed}\n${sha(body)}`;
  const toSign = `AWS4-HMAC-SHA256\n${headers["x-amz-date"]}\n${date}/${region}/sts/aws4_request\n${sha(canonical)}`;
  const k = H(H(H(H(`AWS4${secret}`, date!), region!), "sts"), "aws4_request");
  const want = crypto.createHmac("sha256", k).update(toSign).digest("hex");
  return { ok: crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig!)), region, token: headers["x-amz-security-token"] as string | undefined };
}
function jwtValid(assertion: string): { ok: boolean; claims?: any; head?: any } {
  derived.push(assertion, assertion.split(".")[2] ?? "");
  const [h, b, s] = assertion.split(".");
  if (!h || !b || !s) return { ok: false };
  const okSig = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), SA.publicKey, Buffer.from(s, "base64url"));
  return { ok: okSig, claims: JSON.parse(Buffer.from(b, "base64url").toString()), head: JSON.parse(Buffer.from(h, "base64url").toString()) };
}

// ---------- the HTTPS stand-in: /<host><path> ----------
const seen: { host: string; path: string; method: string; body: string; auth: string | null }[] = [];
const standin = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const [, host, ...rest] = (req.url ?? "/").split("/");
    const p = `/${rest.join("/")}`, body = Buffer.concat(chunks).toString();
    seen.push({ host: host!, path: p, method: req.method!, body, auth: (req.headers.authorization as string) ?? null });
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const xml = (status: number, x: string) => { res.writeHead(status, { "content-type": "text/xml" }); res.end(x); };
    if (/^sts(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(host!) && p === "/" && req.method === "POST") {
      const v = sigv4Valid(host!, req.headers, body, { [AKID]: AWS_SECRET });
      const regionOk = host === "sts.amazonaws.com" ? v.region === "us-east-1" : host === `sts.${v.region}.amazonaws.com`;
      if (!v.ok || !regionOk || body !== "Action=GetCallerIdentity&Version=2011-06-15" || !String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded"))
        return xml(403, `<ErrorResponse><Error><Type>Sender</Type><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match ${req.headers.authorization}</Message></Error></ErrorResponse>`);
      const arn = v.token === AWS_TOKEN ? "arn:aws:sts::123456789012:assumed-role/Deployer/probe-session" : "arn:aws:iam::123456789012:user/Alice";
      return xml(200, `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    }
    if (host === "oauth2.googleapis.com" && p === "/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      const v = jwtValid(f.get("assertion") ?? "");
      const c = v.claims ?? {};
      if (f.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !v.ok || v.head?.alg !== "RS256" || c.aud !== "https://oauth2.googleapis.com/token"
        || c.scope !== "https://www.googleapis.com/auth/cloud-platform.read-only" || c.iss !== "probe@my-project-123.iam.gserviceaccount.com" || !(c.exp > c.iat && c.exp - c.iat <= 3600))
        return json(400, { error: "invalid_grant", error_description: `Invalid JWT Signature. ${f.get("assertion")}` });
      return json(200, { access_token: GTOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (host === "cloudresourcemanager.googleapis.com" && p === "/v1/projects/my-project-123") {
      if (req.headers.authorization !== `Bearer ${GTOKEN}`) return json(401, { error: { message: "no" } });
      return json(200, { projectId: "my-project-123", lifecycleState: "ACTIVE" });
    }
    if (host === "login.microsoftonline.com" && p === `/${TENANT}/oauth2/v2.0/token` && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("client_id") !== CLIENT || f.get("client_secret") !== AZ_SECRET || f.get("scope") !== "https://management.azure.com/.default" || f.get("grant_type") !== "client_credentials")
        return json(401, { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided: ${f.get("client_secret")}` });
      return json(200, { access_token: AZ_TOKEN, token_type: "Bearer", expires_in: 3599 });
    }
    if (host === "management.azure.com" && p.startsWith("/subscriptions")) {
      if (req.headers.authorization !== `Bearer ${AZ_TOKEN}`) return json(401, { error: { code: "InvalidAuthenticationToken", message: "no" } });
      if (p === `/subscriptions/${SUB}?api-version=2022-12-01`) return json(200, { subscriptionId: SUB, displayName: "Production", state: "Enabled" });
      if (p === "/subscriptions?api-version=2022-12-01") return json(200, { value: [{ subscriptionId: SUB }, { subscriptionId: TENANT }] });
    }
    json(404, { message: "not here" });
  });
});
await new Promise<void>((r) => standin.listen(0, "127.0.0.1", r));
process.env.APP_CONNECTION_TEST_STANDIN = `http://127.0.0.1:${(standin.address() as AddressInfo).port}`;

// ---------- the TLS Postgres stand-in (the wire protocol's startup, cleartext password and simple query) ----------
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "pg-key.pem"), "-out", path.join(TMP, "pg-cert.pem"), "-days", "1",
  "-subj", "/CN=db.pg.example", "-addext", "subjectAltName=DNS:db.pg.example"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "other-key.pem"), "-out", path.join(TMP, "other-cert.pem"), "-days", "1",
  "-subj", "/CN=db.pg.example", "-addext", "subjectAltName=DNS:db.pg.example"], { stdio: "ignore" });
const PG_KEY = readFileSync(path.join(TMP, "pg-key.pem"), "utf8"), PG_CERT = readFileSync(path.join(TMP, "pg-cert.pem"), "utf8"), OTHER_CA = readFileSync(path.join(TMP, "other-cert.pem"), "utf8");
interface PgConn { tls: boolean; params: Record<string, string>; password: string | null; queries: string[]; closed: boolean }
const pgSeen: PgConn[] = [];
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s: string) => Buffer.from(`${s}\0`);
const msg = (t: string, body: Buffer) => Buffer.concat([Buffer.from(t), i32(body.length + 4), body]);
const pgError = (code: string, text: string) => msg("E", Buffer.concat([cstr("SFATAL"), cstr("VFATAL"), cstr(`C${code}`), cstr(`M${text}`), Buffer.from("\0")]));
function speak(sock: net.Socket | tls.TLSSocket, conn: PgConn, stubborn = false) {
  let buf = Buffer.alloc(0), started = false;
  sock.on("error", () => {});
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        const len = buf.readInt32BE(0), parts = buf.subarray(8, len).toString().split("\0");
        buf = buf.subarray(len);
        for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) conn.params[parts[i]!] = parts[i + 1]!;
        started = true; sock.write(msg("R", i32(3))); continue; // AuthenticationCleartextPassword
      }
      if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
      const t = String.fromCharCode(buf[0]!), len = buf.readInt32BE(1), body = buf.subarray(5, 1 + len).toString().replace(/\0$/, "");
      buf = buf.subarray(1 + len);
      if (t === "p") {
        conn.password = body;
        if (body !== PG_PW) { sock.write(pgError("28P01", `password authentication failed for user "${conn.params.user}" with ${body}`)); sock.end(); return; }
        sock.write(Buffer.concat([msg("R", i32(0)), msg("Z", Buffer.from("I"))]));
      } else if (t === "Q") {
        conn.queries.push(body);
        if (/^SELECT 1/.test(body)) sock.write(Buffer.concat([msg("T", Buffer.concat([i16(1), cstr("ok"), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)])),
          msg("D", Buffer.concat([i16(1), i32(1), Buffer.from("1")])), msg("C", cstr("SELECT 1")), msg("Z", Buffer.from("T"))]));
        else sock.write(Buffer.concat([msg("C", cstr(body.split(" ")[0]!)), msg("Z", Buffer.from(body.startsWith("BEGIN") ? "T" : "I"))]));
      } else if (t === "X") { if (!stubborn) sock.end(); return; } // stubborn: answers, then never closes
    }
  });
}
const pgServer = (withTls: boolean, stubborn = false) => net.createServer({ allowHalfOpen: stubborn }, (raw) => {
  raw.on("error", () => {});
  raw.once("data", (first: Buffer) => {
    const conn: PgConn = { tls: false, params: {}, password: null, queries: [], closed: false };
    raw.on("close", () => { conn.closed = true; });
    pgSeen.push(conn);
    if (first.length < 8 || first.readInt32BE(4) !== 80877103) { raw.destroy(); return; } // only an SSLRequest opens it
    if (!withTls) { raw.write("N"); return; }
    raw.write("S");
    conn.tls = true;
    speak(new tls.TLSSocket(raw, { isServer: true, key: PG_KEY, cert: PG_CERT, ...(stubborn ? { allowHalfOpen: true } : {}) } as tls.TLSSocketOptions), conn, stubborn);
  });
});
const pgTls = pgServer(true), pgPlain = pgServer(false), pgStubborn = pgServer(true, true);
await Promise.all([pgTls, pgPlain, pgStubborn].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
const pgPort = (s: net.Server) => (s.address() as AddressInfo).port;

// ---------- the area ----------
const ALL = ["viewer", "member", "billing", "owner"];
const PROBE = {
  by: "kind",
  probes: {
    aws: { kind: "aws_sigv4", fields: { access_key_id: "key_id", secret_access_key: "secret", session_token: "token", region: "region" }, timeout_seconds: 5 },
    gcp: { kind: "gcp_service_account", fields: { service_account_json: "key_file" }, timeout_seconds: 5 },
    gcp_token: { kind: "gcp_service_account", fields: { service_account_json: "key_file" }, check: "token", timeout_seconds: 5 },
    azure: { kind: "azure_client_credentials", fields: { tenant_id: "tenant", client_id: "client", client_secret: "secret", subscription_id: "subscription" }, timeout_seconds: 5 },
    pg: { kind: "postgres", label: "the orders database", fields: { host: "host", port: "port", database: "database", user: "user", password: "secret" }, hosts: ["*.pg.example"], ports: [5432, 6432], timeout_seconds: 5 },
    pg_url: { kind: "postgres", fields: { url: "secret" }, hosts: ["db.pg.example"], timeout_seconds: 5 },
  },
  status: "status", tested: "last_tested",
};
const AREA = {
  name: "fx_clouds", label: "Clouds", role: "source", scope: "workspace",
  fields: [
    { name: "kind", label: "Kind", type: "enum", options: ["aws", "gcp", "gcp_token", "azure", "pg", "pg_url", "other"] },
    { name: "key_id", label: "Access key ID", type: "text" },
    { name: "region", label: "Region", type: "text" },
    { name: "tenant", label: "Tenant", type: "text" },
    { name: "client", label: "Client ID", type: "text" },
    { name: "subscription", label: "Subscription", type: "text" },
    { name: "host", label: "Host", type: "text" },
    { name: "port", label: "Port", type: "number" },
    { name: "database", label: "Database", type: "text" },
    { name: "user", label: "User", type: "text" },
    { name: "secret", label: "Secret", type: "text", encrypted: true },
    { name: "token", label: "Session token", type: "text", encrypted: true },
    { name: "key_file", label: "Key file", type: "text", encrypted: true },
    { name: "status", label: "Last test", type: "enum", options: ["untested", "working", "failing"], set_by: "action" },
    { name: "last_tested", label: "Tested on", type: "date", set_by: "action" },
  ],
  permissions: { read: ALL, create: ["owner"], update: ["owner"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ALL, export: { none: "secrets" }, create: ["owner"], update: ["owner"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "A secret is never shown again once saved" }, import: { none: "secrets are typed" } }, primary_action: "create_record" },
  detail: { tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["kind", "region", "tenant", "host"] }] }],
    actions: [{ kind: "test_connection", place: "primary", label: "Test connection", roles: ["owner"], probe: PROBE }, { kind: "edit", place: "secondary" }] },
};
const PACK = { id: "fixture_clouds", name: "Fixture clouds", version: "1", record_areas: [AREA] };

const answers: string[] = [];
try {
  const api = await import("../src/pack-api.js");
  const cfg = await import("../src/connection-test-config.js");
  const C = await import("../src/connection-test.js");
  const S = await import("../src/connection-test-signed.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations, PackJsonSchema } = await import("../src/pack-manifest.js");
  const { secretsToClear } = await import("../src/secret-binding.js");

  // ---------- 1. the declaration ----------
  {
    assert.ok(PackJsonSchema.safeParse(PACK).success, JSON.stringify(PackJsonSchema.safeParse(PACK).error?.issues));
    const problems = (patch: (a: any, p: any) => void) => {
      const a = structuredClone(AREA) as any; patch(a, a.detail.actions[0].probe);
      const r = api.RecordAreaSchema.safeParse(a);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    assert.deepEqual(problems(() => {}), [], "the fixture's area");
    const bad = (patch: (a: any, p: any) => void, re: RegExp, what: string) => { const p = problems(patch); assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`); };
    bad((_a, p) => { p.probes.aws.kind = "ssh"; }, /a probe's kind is http, aws_sigv4, gcp_service_account, azure_client_credentials, postgres/, "an unknown kind");
    bad((_a, p) => { p.probes.aws.fields.secret_access_key = "key_id"; }, /key_id holds a secret: declare it encrypted/, "a secret key in a plain field");
    bad((_a, p) => { delete p.probes.aws.fields.secret_access_key; }, /names the field holding its secret access key/, "no secret key");
    bad((_a, p) => { p.probes.aws.fields.region = "token"; }, /token is encrypted: a region decides or names where the secrets go/, "a sealed region");
    bad((_a, p) => { p.probes.aws.region = "eu-west-1"; }, /a fixed region or a region field, not both/, "both regions");
    bad((_a, p) => { delete p.probes.aws.fields.region; p.probes.aws.region = "evil.example"; }, /an AWS region's name/, "a region that is not one");
    bad((_a, p) => { p.probes.aws.url = "https://x.example"; }, /url|Unrecognized/i, "an http key on a signed kind");
    bad((_a, p) => { p.probes.gcp.fields.service_account_json = "user"; }, /user holds a secret: declare it encrypted/, "a key file in a plain field");
    bad((_a, p) => { p.probes.azure.fields.tenant_id = "secret"; }, /secret is encrypted: a tenant id decides or names where the secrets go/, "a sealed tenant");
    bad((_a, p) => { p.probes.azure.fields.client_secret = "client"; }, /client holds a secret/, "a plain client secret");
    bad((_a, p) => { p.probes.azure.fields.tenant_id = "nope"; }, /nope is not one of the area's fields/, "an unknown field");
    bad((_a, p) => { p.probes.azure.fields.subscription_id = "tenant"; }, /tenant fills both tenant_id and subscription_id/, "one field in two roles");
    bad((_a, p) => { p.probes.pg.fields.url = "token"; }, /a sealed url, or from host, user and password: not both/, "postgres both ways");
    bad((_a, p) => { delete p.probes.pg.fields.password; }, /names a sealed url field, or host, user and password fields/, "postgres without a password");
    bad((_a, p) => { delete p.probes.pg.hosts; }, /hosts/, "postgres without hosts");
    bad((_a, p) => { p.probes.pg.hosts = ["*.rds.amazonaws.com", "*.amazonaws.com"]; }, /\*\.amazonaws\.com is a wildcard over a name anyone can host under/, "a shared wildcard");
    bad((_a, p) => { p.probes.pg.hosts = ["db.internal"]; }, /internal name/, "an internal host");
    for (const h of ["amazonaws.com", "fly.dev", "co.uk", "vercel.app"]) bad((_a, p) => { p.probes.pg.hosts = [h]; }, /is a name anyone can host under/, `a bare shared suffix ${h}`);
    for (const h of ["amazonaws.com", "fly.dev"]) bad((_a, p) => { p.probes.other = { method: "GET", url: "https://api.example.com/v1", hosts: [h] }; }, /is a name anyone can host under/, `an http probe's bare ${h}`);
    assert.deepEqual(problems((_a, p) => { p.probes.pg.hosts = ["my-db.fly.dev", "rds.amazonaws.com"]; }), [], "an exact host under a shared suffix: fine");
    // A bare entry is exactly itself; only "*." matches subdomains.
    assert.equal(cfg.hostListed("x.rds.amazonaws.com", ["rds.amazonaws.com"]), false);
    assert.equal(cfg.hostListed("a.db.example", ["db.example"]), false);
    assert.equal(cfg.hostListed("DB.example.", ["db.example"]), true);
    assert.deepEqual(["db.example", "a.db.example", "a.b.db.example", "xdb.example"].map((h) => cfg.hostListed(h, ["*.db.example"])), [true, true, true, false]);
    bad((_a, p) => { p.probes.pg.ports = [22]; }, /a database's port is 1024 to 65535/, "a low port");
    bad((_a, p) => { p.probes.pg.fields.host = "secret"; p.probes.pg.fields.password = "token"; }, /secret is encrypted: a host decides/, "a sealed host");
    bad((_a, p) => { p.probes.pg.fields.port = "last_tested"; }, /last_tested is a date field: a port is a number or text or enum field/, "a date as the port");
    assert.ok(cfg.connectionTestProblems({ ...structuredClone(AREA), lifecycle: { field: "region" } } as never, PROBE).some((p) => /\{region\} is the lifecycle's field/.test(p.message)), "the lifecycle's field deciding a host");
    // An HTTP probe is still the default, with or without kind "http".
    assert.deepEqual(problems((_a, p) => { p.probes.other = { method: "GET", url: "https://api.example.com/v1", kind: "http" }; }), []);
    ok("the declaration: each kind's roles name fields, sealed where they hold a secret, plain where they decide where it goes; postgres a url or host + user + password, public hosts, ports 1024 to 65535; an unknown kind refused");
  }

  setPacksForTest([{ manifest: { id: "fixture_clouds", name: "x", version: "1", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);

  // ---------- 2. the binding ----------
  {
    const area = { pack: "fixture_clouds", name: "fx_clouds", fields: AREA.fields, detail: AREA.detail } as never;
    const stored = { kind: "aws", key_id: AKID, region: "eu-west-1", tenant: TENANT, client: CLIENT, host: "db.pg.example", port: 5432, database: "orders", user: "app", secret: "x", token: "y", key_file: "z" };
    const without = (o: Record<string, unknown>) => { const g = { ...stored, ...o }; delete (g as any).secret; delete (g as any).token; delete (g as any).key_file; return secretsToClear(area, stored, g).sort(); };
    assert.deepEqual(without({ region: "us-east-1" }), ["key_file", "secret", "token"], "a region changed: the secrets of the probes it decides cleared (every probe: one by binds them all)");
    assert.deepEqual(without({ tenant: "contoso.onmicrosoft.com" }), ["key_file", "secret", "token"], "a tenant changed");
    assert.deepEqual(without({ host: "evil.pg.example" }), ["key_file", "secret", "token"], "a database's host changed");
    assert.deepEqual(without({ port: 6432 }), ["key_file", "secret", "token"], "its port changed");
    assert.deepEqual(without({ kind: "gcp" }), ["key_file", "secret", "token"], "the kind changed");
    assert.deepEqual(without({ database: "other", user: "app2", subscription: SUB }), [], "a database's name, a user or a subscription: kept");
    assert.deepEqual(without({ client: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }), ["key_file", "secret", "token"], "a plain client id binds the secret");
    assert.deepEqual(without({ key_id: "AKIAOTHER0000000" }), ["key_file", "secret", "token"], "a plain access key id binds the secret key");
    assert.deepEqual(secretsToClear(area, stored, { ...stored, region: "us-east-1" }), [], "the secrets typed again with the change: kept");
    // A probe whose host the kind fixes, with no by: nothing decides, nothing binds.
    const fixed = { pack: "fixture_clouds", name: "fx_fixed", fields: AREA.fields,
      detail: { actions: [{ kind: "test_connection", probe: { probes: { "*": { kind: "aws_sigv4", fields: { access_key_id: "key_id", secret_access_key: "secret" }, region: "eu-west-1" } } } }] } } as never;
    assert.deepEqual(secretsToClear(fixed, stored, { ...stored, region: "us-east-1" }), [], "a fixed host: the region field binds nothing");
    assert.deepEqual(secretsToClear(fixed, stored, (({ secret: _s, ...rest }) => ({ ...rest, key_id: "AKIAOTHER0000000" }))(stored)), ["secret"], "a plain key id changed: its secret key cleared");
    assert.deepEqual(cfg.destinationFields(PROBE.probes.pg as never).sort(), ["host", "port"]);
    assert.deepEqual(cfg.destinationFields(PROBE.probes.azure as never).sort(), ["client", "tenant"]);
    assert.deepEqual(cfg.destinationFields(PROBE.probes.pg_url as never), []);
    assert.deepEqual(cfg.probeSecrets(PROBE.probes.aws as never, (n) => ["secret", "token", "key_file"].includes(n)).sort(), ["secret", "token"]);
    ok("the binding: a region, a tenant, a database's host or port, or the kind changed without the secret clears it; a fixed host binds nothing; a name, a user or a subscription keeps it");
  }

  // ---------- 3. SigV4: AWS's published example (IAM ListUsers, 2015-08-30) ----------
  {
    const s = S.sigv4({ method: "GET", host: "iam.amazonaws.com", path: "/", query: "Action=ListUsers&Version=2010-05-08", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "", region: "us-east-1", service: "iam", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2015-08-30T12:36:00Z") });
    assert.equal(s.signature, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    assert.equal(s.headers.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    ok("SigV4 matches AWS's published example");
  }

  // ---------- 4-7. each kind against the stand-ins ----------
  C.setResolverForTest(async (h) => (h === "private.pg.example" ? ["10.0.0.5"] : h === "six.pg.example" ? ["::ffff:127.0.0.1"] : h === "alias.pg.example" || h === "owndb.example" ? ["93.184.216.77"] : ["93.184.216.34"]));
  const label = (n: string) => `"${AREA.fields.find((f) => f.name === n)?.label ?? n}"`;
  const sealedNames = new Set(["secret", "token", "key_file"]);
  const run = async (probe: string, data: Record<string, unknown>) => {
    const r = await C.runProbe(probe, (PROBE.probes as any)[probe], { plain: Object.fromEntries(Object.entries(data).filter(([k]) => !sealedNames.has(k))), sealed: sealedNames,
      open: async (n) => String(data[n] ?? ""), label });
    answers.push(JSON.stringify(r));
    return r;
  };
  {
    const a1 = await run("aws", { key_id: AKID, secret: AWS_SECRET });
    assert.equal(a1.ok, true, a1.words); assert.match(a1.words, /^It works: AWS account ending …9012 \(Alice\), answered by sts\.amazonaws\.com in \d+ ms\.$/);
    assert.equal(seen.at(-1)!.host, "sts.amazonaws.com");
    const a2 = await run("aws", { key_id: AKID, secret: AWS_SECRET, token: AWS_TOKEN, region: "eu-west-1" });
    assert.equal(a2.ok, true, a2.words); assert.match(a2.words, /^It works: AWS account ending …9012 \(probe-session\), answered by sts\.eu-west-1\.amazonaws\.com/);
    const a3 = await run("aws", { key_id: AKID, secret: AWS_BAD });
    assert.equal(a3.outcome, "refused"); assert.match(a3.words, /^It does not work yet: AWS at sts\.amazonaws\.com answered 403: the keys were refused \(it said: "SignatureDoesNotMatch: The request signature we calculated does not match/, a3.words);
    let n = seen.length;
    for (const region of ["evil.example", "eu-west-1.evil", "../x"]) {
      const r = await run("aws", { key_id: AKID, secret: AWS_SECRET, region });
      assert.equal(r.outcome, "not_ready", r.words); assert.match(r.words, /is not an AWS region's name/);
    }
    assert.equal((await run("aws", { key_id: "not a key", secret: AWS_SECRET })).outcome, "not_ready");
    assert.match((await run("aws", { key_id: AKID, secret: "abc12x" })).words, /"Secret" is too short to be a secret/);
    assert.match((await run("aws", { key_id: AKID })).words, /^It can't be tested yet: "Secret" is empty\.$/);
    assert.equal(seen.length, n, "nothing sent for a bad region, key or secret");
    ok("aws_sigv4: works at the global and a regional STS (a session token signed too: its role's last segment), keys refused with the echo cut out, a region that is not one refused before any call");

    const g1 = await run("gcp", { key_file: keyFile(SA_PEM) });
    assert.equal(g1.ok, true, g1.words); assert.match(g1.words, /^It works: Google Cloud service account probe@my-project-123\.iam\.gserviceaccount\.com can read project my-project-123 \(ACTIVE\), in \d+ ms\.$/);
    assert.deepEqual(seen.slice(-2).map((s) => s.host), ["oauth2.googleapis.com", "cloudresourcemanager.googleapis.com"]);
    const g2 = await run("gcp_token", { key_file: keyFile(SA_PEM) });
    assert.equal(g2.ok, true, g2.words); assert.match(g2.words, /got a read-only token from oauth2\.googleapis\.com/);
    const g3 = await run("gcp", { key_file: keyFile(OTHER_PEM) });
    assert.equal(g3.outcome, "refused", g3.words); assert.match(g3.words, /answered 400: the service account's key was refused \(it said: "Invalid JWT Signature\. …"\)/);
    n = seen.length;
    for (const uri of ["https://evil.example/token", "https://oauth2.googleapis.com.evil.example/token", "http://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token?x=1"]) {
      const r = await run("gcp", { key_file: keyFile(SA_PEM, { token_uri: uri }) });
      assert.equal(r.outcome, "not_ready"); assert.match(r.words, /names another token address than Google's own/);
    }
    assert.match((await run("gcp", { key_file: keyFile(SA_PEM, { type: "authorized_user" }) })).words, /is not a service account's/);
    assert.match((await run("gcp", { key_file: "{not json" })).words, /is not JSON/);
    const BIG = crypto.generateKeyPairSync("rsa", { modulusLength: 4608 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    SECRETS.push(BIG);
    assert.match((await run("gcp", { key_file: keyFile(BIG) })).words, /holds an RSA key larger than 4096 bits/);
    assert.match((await run("gcp", { key_file: keyFile(`-----BEGIN ${"PRIV" + "ATE"} KEY-----\nAAAA\n-----END ${"PRIV" + "ATE"} KEY-----\n`) })).words, /private key that does not open/);
    assert.equal(seen.length, n, "a crafted token_uri, or a file that is not a key: nothing sent anywhere");
    assert.ok(!seen.some((s) => s.host.includes("evil")), "the crafted token address never received the assertion");
    ok("gcp_service_account: works (the project read, or the token alone), another key refused, a crafted token_uri never called, a file that is not a key said in words");

    const z1 = await run("azure", { tenant: TENANT, client: CLIENT, secret: AZ_SECRET, subscription: SUB });
    assert.equal(z1.ok, true, z1.words); assert.match(z1.words, /^It works: the application signed in to Azure and can read subscription "Production" \(Enabled\), in \d+ ms\.$/);
    const z2 = await run("azure", { tenant: TENANT, client: CLIENT, secret: AZ_SECRET });
    assert.match(z2.words, /can see 2 subscriptions/);
    const z3 = await run("azure", { tenant: TENANT, client: CLIENT, secret: AZ_BAD, subscription: SUB });
    assert.equal(z3.outcome, "refused"); assert.match(z3.words, /login\.microsoftonline\.com answered 401: the client ID or secret was refused \(it said: "AADSTS7000215: Invalid client secret provided: …"\)/, z3.words);
    n = seen.length;
    for (const tenant of ["../evil", "evil.example/x", "a b", "common?x"]) assert.equal((await run("azure", { tenant, client: CLIENT, secret: AZ_SECRET })).outcome, "not_ready", tenant);
    assert.match((await run("azure", { tenant: TENANT, client: "app", secret: AZ_SECRET })).words, /not an application's ID/);
    assert.match((await run("azure", { tenant: TENANT, client: CLIENT, secret: AZ_SECRET, subscription: "../x" })).words, /not a subscription's ID/);
    assert.equal(seen.length, n, "nothing sent for a tenant, client or subscription that is not one");
    ok("azure_client_credentials: works (a subscription read, the list), a secret refused with its echo cut out, a tenant that climbs the address refused before any call");

    // Postgres.
    S.setPostgresStandinForTest({ port: pgPort(pgTls), ca: PG_CERT });
    const pgBase = { host: "db.pg.example", port: 5432, database: "orders", user: "app", secret: PG_PW };
    const p1 = await run("pg", pgBase);
    assert.equal(p1.ok, true, p1.words); assert.match(p1.words, /^It works: the orders database at db\.pg\.example answered SELECT 1 over TLS in \d+ ms\.$/);
    const c1 = pgSeen.at(-1)!;
    assert.equal(c1.tls, true); assert.equal(c1.password, PG_PW); assert.equal(c1.params.user, "app"); assert.equal(c1.params.database, "orders");
    assert.equal(c1.params.statement_timeout, undefined, "no startup parameter a pooler would refuse");
    assert.deepEqual(c1.queries, ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '10s'", "SELECT 1 AS ok", "ROLLBACK"], "SELECT 1 in a read-only transaction, a 10 s statement timeout set inside it");
    // A server that answers and then never closes (half-open): the probe returns within its deadline, the socket destroyed.
    S.setPostgresStandinForTest({ port: pgPort(pgStubborn), ca: PG_CERT });
    const sockets = () => process.getActiveResourcesInfo().filter((x) => x === "TCPSocketWrap").length;
    const before = sockets(), tStub = Date.now();
    const pStub = await run("pg", pgBase);
    assert.equal(pStub.ok, true, pStub.words); assert.ok(Date.now() - tStub < 3000, `it returned without waiting on the server (${Date.now() - tStub} ms)`);
    const stub = pgSeen.at(-1)!;
    assert.deepEqual(stub.queries.at(-1), "ROLLBACK");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stub.closed, false, "the server never closed its side");
    assert.equal(sockets() - before, 1, "only the server's half-open socket is left: the client destroyed its own");
    S.setPostgresStandinForTest({ port: pgPort(pgTls), ca: PG_CERT });
    const p2 = await run("pg", { ...pgBase, secret: PG_BAD });
    assert.equal(p2.outcome, "refused"); assert.equal(p2.words, "It does not work yet: the orders database at db.pg.example refused the user name or password.");
    // A certificate for another name: the TLS check refuses it before the password is sent.
    let m = pgSeen.length;
    const p3 = await run("pg", { ...pgBase, host: "other.pg.example" });
    assert.equal(p3.outcome, "unreachable", p3.words); assert.equal(p3.words, "It does not work yet: other.pg.example could not be reached over TLS.");
    assert.equal(pgSeen.length, m + 1); assert.equal(pgSeen.at(-1)!.password, null, "no password sent to a server whose certificate is not the host's");
    // Not trusted (another CA): the same.
    S.setPostgresStandinForTest({ port: pgPort(pgTls), ca: OTHER_CA });
    m = pgSeen.length;
    const p3b = await run("pg", pgBase);
    assert.equal(p3b.outcome, "unreachable", p3b.words); assert.equal(pgSeen.at(-1)?.password ?? null, null, "an untrusted certificate: no password sent");
    // A server without TLS.
    S.setPostgresStandinForTest({ port: pgPort(pgPlain), ca: PG_CERT });
    const p4 = await run("pg", pgBase);
    assert.equal(p4.outcome, "unexpected"); assert.match(p4.words, /does not accept TLS connections, and this test connects over TLS only/);
    assert.equal(pgSeen.at(-1)!.password, null, "nothing sent in the clear");
    S.setPostgresStandinForTest({ port: pgPort(pgTls), ca: PG_CERT });
    // Refused before any connection.
    m = pgSeen.length;
    const refusedPg = async (data: Record<string, unknown>, re: RegExp, outcome = "private_address") => { const r = await run("pg", { ...pgBase, ...data }); assert.equal(r.outcome, outcome, r.words); assert.match(r.words, re); };
    await refusedPg({ host: "evil.example" }, /evil\.example is not one of the hosts this test may call \(\*\.pg\.example\)/);
    await refusedPg({ host: "private.pg.example" }, /private\.pg\.example is a private or internal address/);
    await refusedPg({ host: "six.pg.example" }, /six\.pg\.example is a private or internal address/);
    await refusedPg({ host: "10.0.0.5" }, /is an address, not a name/);
    await refusedPg({ host: "db.internal" }, /private or internal/);
    await refusedPg({ port: 22 }, /on port 22: this test connects on port 5432 or 6432 only/);
    await refusedPg({ host: "db.pg.example\nx" }, /line break/, "not_ready");
    await refusedPg({ secret: "abc12x" }, /too short to be a secret/, "not_ready");
    process.env.DATABASE_URL = "postgres://u:p@own.pg.example:5432/app";
    await refusedPg({ host: "own.pg.example" }, /this app's own address/);
    process.env.DATABASE_URL = "postgres://u:p@owndb.example:5432/app";
    await refusedPg({ host: "alias.pg.example" }, /alias\.pg\.example is this app's own database/);
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_URL_NON_POOLING = "postgres://u:p@owndb.example:5432/app";
    await refusedPg({ host: "alias.pg.example" }, /this app's own database/);
    delete process.env.POSTGRES_URL_NON_POOLING;
    assert.equal(pgSeen.length, m, "nothing connected for a refused host, port or value");
    // A sealed url, parsed by the test (never the client library: its own parser reads files named in the address).
    const u1 = await run("pg_url", { secret: `postgres://app:${encodeURIComponent(PG_PW)}@db.pg.example/orders?sslmode=disable&sslrootcert=/etc/passwd` });
    assert.equal(u1.ok, true, u1.words); assert.equal(pgSeen.at(-1)!.tls, true, "TLS whatever the address says"); assert.equal(pgSeen.at(-1)!.params.database, "orders");
    const u2 = await run("pg_url", { secret: `postgresql://app:${PG_PW}@evil.example:5432/orders` });
    assert.equal(u2.outcome, "private_address"); assert.ok(!u2.words.includes(PG_PW));
    assert.match((await run("pg_url", { secret: `mysql://app:${PG_PW}@db.pg.example/x` })).words, /is not a postgres:\/\/ address/);
    assert.deepEqual(S.parsePostgresUrl("postgresql://a%40b:p%3Aw%2Fd@DB.Example.com.:6543/my%20db?x=1"), { host: "db.example.com", port: 6543, user: "a@b", password: "p:w/d", database: "my db" });
    assert.deepEqual(S.parsePostgresUrl("postgres://u:p@h.example.com"), { host: "h.example.com", port: 5432, user: "u", password: "p", database: "postgres" });
    assert.equal(S.parsePostgresUrl("https://u:p@h.example.com/x"), null);
    const o = S.pgTlsOptionsForTest("db.pg.example");
    assert.equal(o.rejectUnauthorized, true); assert.equal(o.servername, "db.pg.example");
    delete process.env.APP_TEST_WORLD;
    assert.notDeepEqual(S.pgTlsOptionsForTest("db.pg.example").ca, [PG_CERT], "outside a test world: the stand-in's certificate is never trusted");
    process.env.APP_TEST_WORLD = "1";
    ok("postgres: works over TLS (a 10 s statement timeout, a read-only transaction, SELECT 1); a password refused without the server's words; a certificate for another name or from another CA and a server without TLS refused before the password; a host off the list, a private or mapped address, an address literal, another port and this app's own database refused before any connection; a url parsed safely, TLS whatever it says");
  }

  // ---------- 8. the record ----------
  {
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    await import("../src/server.js");
    const F = await import("../src/features.js");
    const ra = await import("../src/record-areas.js");
    const { createOrg } = await import("../src/auth.js");
    F.setFeaturesForTest({ record_pages: true, teams: true });
    const A = (await createOrg(`Clouds A ${STAMP}`)).org;
    const owner = { role: "owner" as const, userId: "user_owner_a" }, member = { role: "member" as const, userId: "user_member_a" };
    const rec = ra.workspaceRecords("fixture_clouds", A.orgId, owner);
    const add = (key: string, data: Record<string, unknown>) => ra.asWriter({ by: "people", id: "owner" }, () => rec.create("fx_clouds", key, { title: key, data }));
    await add("aws-1", { kind: "aws", key_id: AKID, secret: AWS_SECRET, token: AWS_TOKEN, region: "eu-west-1" });
    await add("pg-1", { kind: "pg", host: "db.pg.example", port: 5432, database: "orders", user: "app", secret: PG_PW });
    await add("gcp-1", { kind: "gcp", key_file: keyFile(SA_PEM) });
    const area = ra.findArea("fx_clouds")!;
    const test = async (key: string, actor: { role: "owner" | "member"; userId: string } = owner) => { C.resetTestRateForTest(); const r = await ra.asAction(() => C.testConnectionRecord(A.orgId, area, key, PROBE as never, actor)); answers.push(JSON.stringify(r)); return r; };
    const stored = async (key: string) => (await ra.getFor(A.orgId, "fx_clouds", key, owner))!.data;
    const today = new Date().toISOString().slice(0, 10);
    for (const k of ["aws-1", "pg-1", "gcp-1"]) {
      const r = await test(k);
      assert.equal(r.ok, true, `${k}: ${r.words}`);
      assert.deepEqual([(await stored(k)).status, (await stored(k)).last_tested], ["working", today], k);
    }
    await assert.rejects(test("aws-1", member), /no fx_clouds record aws-1/, "a member who may not update: no test");
    // A region changed without the keys clears them: the next test sends nothing.
    await ra.asWriter({ by: "people", id: "owner" }, () => rec.update("fx_clouds", "aws-1", { title: "aws-1", data: { kind: "aws", key_id: AKID, region: "us-west-2" } }));
    const sent = seen.length;
    const r = await test("aws-1");
    assert.equal(r.outcome, "not_ready"); assert.match(r.words, /"Secret" is empty/); assert.equal(seen.length, sent);
    assert.equal((await stored("aws-1")).status, "failing");
    const { recordHistory } = await import("../src/record-history.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    const lines = (await Promise.all(["aws-1", "pg-1", "gcp-1"].map((k) => withTenant(A.orgId, () => recordHistory(A.orgId, area, k, { limit: 50 }))))).flatMap((h) => h.lines);
    const history = JSON.stringify(lines) + JSON.stringify(await db.query("SELECT * FROM record_changes WHERE org_id = $1", [A.orgId]));
    const trail = JSON.stringify(await db.query("SELECT * FROM audit_data_events WHERE org_id = $1", [A.orgId]).catch(() => []));
    const rows = JSON.stringify(await db.query("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'fx_clouds'", [A.orgId]));
    for (const s of [...SECRETS, ...derived.filter((d) => d.length >= 16)]) {
      assert.ok(!answers.some((a) => a.includes(s)), `no answer carries a secret or what one makes (${s.slice(0, 6)}…)`);
      assert.ok(!printed.some((p) => p.includes(s)), "nothing printed carries one");
      assert.ok(!history.includes(s) && !trail.includes(s), "nor the history or the data trail");
    }
    for (const s of SECRETS.slice(0, 11)) assert.ok(!rows.includes(s), "stored sealed");
    ok("the record: status and date written as the app's action for each kind, a member who may not update has no test, a region changed without the keys clears them (nothing sent); no secret, signature, assertion or token in any answer, anything printed, the history, the data trail or the stored row");
  }
  console.log("signed-probes-test: all passed");
} finally {
  standin.close(); pgTls.close(); pgPlain.close(); pgStubborn.close();
  cleanup();
}
process.exit(0);
