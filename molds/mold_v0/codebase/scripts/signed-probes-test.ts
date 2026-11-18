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
//   9. mold_v0-319, resource checks: the declaration (a check's resource roles required, another check's refused, a
//      regional check has a region, a resource check binds its resource and subscription); aws_sigv4 ebs_volume (EC2,
//      service ec2), efs_file_system (EFS, service elasticfilesystem), s3_bucket (path-style HEAD, service s3) signed and
//      checked by the stand-in's own SigV4; gcp_service_account compute_disk / filestore_instance (each check's scope);
//      azure_client_credentials storage_account / file_share; each one found, missing and refused in words with ids
//      trimmed, and a bad id, a region / project / zone / resource group that climbs or leaves its segment refused
//      before anything is signed or sent
//  10. mold_v0-319, managed-provider CAs: the shipped bundles parse (aws-rds 114 CA certificates, azure its 3 roots);
//      ca names a shipped bundle only, its hosts under that provider's zone; a shared database zone ("*.<region>.rds.
//      amazonaws.com", "*.postgres.database.azure.com") refused, one account's ("*.<id>.<region>.rds.amazonaws.com")
//      allowed; a TLS stand-in whose certificate a throwaway CA signed works only with that CA registered as a named
//      bundle (a test world only), and without it no password is sent
import { cleanup, STAMP, TMP } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto, { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
const GTOKEN_COMPUTE = can("ya29.c"), GTOKEN_CP = can("ya29.p");
const SECRETS = [AWS_SECRET, AWS_TOKEN, AWS_BAD, SA_PEM, OTHER_PEM, GTOKEN, GTOKEN_COMPUTE, GTOKEN_CP, AZ_SECRET, AZ_BAD, AZ_TOKEN, PG_PW, PG_BAD,
  ...[SA_PEM, OTHER_PEM].map((p) => p.split("\n")[5]!)]; // a line of each key's body, too
const derived: string[] = []; // what the stand-ins saw that only a secret makes: signatures, assertions, Authorization

// ---------- an independent SigV4 check (the stand-in's own code, not src/'s) ----------
const H = (k: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", k).update(s).digest();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** The request as signed: its method, path and query (mold_v0-319: any service's, its credential scope read back). */
function sigv4Valid(host: string, headers: http.IncomingHttpHeaders, body: string, secrets: Record<string, string>, method = "POST", pathQuery = "/"):
  { ok: boolean; region?: string; service?: string; token?: string } {
  const m = /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(String(headers.authorization ?? ""));
  if (!m) return { ok: false };
  const [, akid, date, region, service, signed, sig] = m as unknown as string[];
  derived.push(sig!, String(headers.authorization));
  const secret = secrets[akid!];
  if (!secret) return { ok: false };
  const names = signed!.split(";");
  if (!names.includes("host") || !names.includes("x-amz-date")) return { ok: false };
  // S3 signs its payload's hash as a header, and it must be the body's.
  if (service === "s3" && (!names.includes("x-amz-content-sha256") || headers["x-amz-content-sha256"] !== sha(body))) return { ok: false };
  const [p, q = ""] = pathQuery.split("?");
  const query = q ? q.split("&").sort().join("&") : "";
  const val = (n: string) => (n === "host" ? host : String(headers[n] ?? "").trim());
  const canonical = `${method}\n${p}\n${query}\n${names.map((n) => `${n}:${val(n)}\n`).join("")}\n${signed}\n${sha(body)}`;
  const toSign = `AWS4-HMAC-SHA256\n${headers["x-amz-date"]}\n${date}/${region}/${service}/aws4_request\n${sha(canonical)}`;
  const k = H(H(H(H(`AWS4${secret}`, date!), region!), service!), "aws4_request");
  const want = crypto.createHmac("sha256", k).update(toSign).digest("hex");
  return { ok: crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig!)), region, service, token: headers["x-amz-security-token"] as string | undefined };
}
// mold_v0-319: the resources the stand-in holds.
const VOL_ATT = "vol-0bbbbbbbbbbbbbbbb", VOL_DENIED = "vol-0aaaaaaaaaaaaaaaa";
const VOL = "vol-0123456789abcdef0", VOL_GONE = "vol-0fedcba9876543210", FS = "fs-0123456789abcdef0", FS_GONE = "fs-89abcdef";
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
    // mold_v0-319: EC2, EFS and S3, each signed for its own service and region.
    const awsRes = /^(ec2|elasticfilesystem|s3)\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host!);
    if (awsRes) {
      const [, service, region] = awsRes;
      const v = sigv4Valid(host!, req.headers, body, { [AKID]: AWS_SECRET }, req.method, p);
      const signedOk = v.ok && v.service === service && v.region === region;
      if (service === "ec2") {
        const f = new URLSearchParams(body);
        if (!signedOk || req.method !== "POST" || p !== "/" || f.get("Action") !== "DescribeVolumes" || f.get("Version") !== "2016-11-15" || [...f.keys()].length !== 3)
          return xml(401, `<Response><Errors><Error><Code>AuthFailure</Code><Message>AWS was not able to validate the provided access credentials ${req.headers.authorization}</Message></Error></Errors></Response>`);
        const id = f.get("VolumeId.1");
        if (id === VOL_DENIED) return xml(403, `<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/Alice is not authorized to perform: ec2:DescribeVolumes in account 123456789012</Message></Error></Errors></Response>`);
        // An attached volume: its attachments' own <item>s come before its type, as EC2 answers.
        if (id === VOL_ATT) return xml(200, `<DescribeVolumesResponse><volumeSet><item><volumeId>${VOL_ATT}</volumeId><size>8</size><availabilityZone>${region}b</availabilityZone><status>in-use</status><attachmentSet><item><volumeId>${VOL_ATT}</volumeId><instanceId>i-0123456789abcdef0</instanceId><device>/dev/xvda</device><status>attached</status></item></attachmentSet><volumeType>io2</volumeType></item></volumeSet></DescribeVolumesResponse>`);
        if (id !== VOL) return xml(400, `<Response><Errors><Error><Code>InvalidVolume.NotFound</Code><Message>The volume '${id}' does not exist.</Message></Error></Errors></Response>`);
        return xml(200, `<DescribeVolumesResponse><volumeSet><item><volumeId>${VOL}</volumeId><size>20</size><availabilityZone>${region}a</availabilityZone><status>available</status><volumeType>gp3</volumeType></item></volumeSet></DescribeVolumesResponse>`);
      }
      if (service === "elasticfilesystem") {
        const u = new URL(`https://x${p}`);
        if (!signedOk || req.method !== "GET" || u.pathname !== "/2015-02-01/file-systems" || [...u.searchParams.keys()].join() !== "FileSystemId")
          return json(403, { ErrorCode: "AccessDeniedException", Message: `denied ${req.headers.authorization}` });
        const id = u.searchParams.get("FileSystemId");
        if (id !== FS) return json(404, { ErrorCode: "FileSystemNotFound", Message: `File system '${id}' does not exist.` });
        return json(200, { FileSystems: [{ FileSystemId: FS, LifeCycleState: "available", SizeInBytes: { Value: 6144 }, Name: "shared" }] });
      }
      // S3 HeadBucket, path-style: no body, the bucket's region in a header.
      const head = (status: number, h: Record<string, string> = {}) => { res.writeHead(status, h); res.end(); };
      if (req.method !== "HEAD" || !signedOk) return head(403);
      const bucket = p.slice(1);
      if (bucket === "my-bucket.example") return head(200, { "x-amz-bucket-region": region! });
      if (bucket === "far-bucket") return head(301, { "x-amz-bucket-region": "ap-southeast-2" });
      if (bucket === "locked-bucket") return head(403, { "x-amz-bucket-region": region! });
      return head(404);
    }
    if (/^sts(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(host!) && p === "/" && req.method === "POST") {
      const v = sigv4Valid(host!, req.headers, body, { [AKID]: AWS_SECRET });
      const regionOk = host === "sts.amazonaws.com" ? v.region === "us-east-1" : host === `sts.${v.region}.amazonaws.com`;
      if (!v.ok || v.service !== "sts" || !regionOk || body !== "Action=GetCallerIdentity&Version=2011-06-15" || !String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded"))
        return xml(403, `<ErrorResponse><Error><Type>Sender</Type><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match ${req.headers.authorization}</Message></Error></ErrorResponse>`);
      const arn = v.token === AWS_TOKEN ? "arn:aws:sts::123456789012:assumed-role/Deployer/probe-session" : "arn:aws:iam::123456789012:user/Alice";
      return xml(200, `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    }
    if (host === "oauth2.googleapis.com" && p === "/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      const v = jwtValid(f.get("assertion") ?? "");
      const c = v.claims ?? {};
      const scopes: Record<string, string> = { "https://www.googleapis.com/auth/cloud-platform.read-only": GTOKEN, "https://www.googleapis.com/auth/compute.readonly": GTOKEN_COMPUTE,
        "https://www.googleapis.com/auth/cloud-platform": GTOKEN_CP };
      if (f.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !v.ok || v.head?.alg !== "RS256" || c.aud !== "https://oauth2.googleapis.com/token"
        || !scopes[c.scope] || c.iss !== "probe@my-project-123.iam.gserviceaccount.com" || !(c.exp > c.iat && c.exp - c.iat <= 3600))
        return json(400, { error: "invalid_grant", error_description: `Invalid JWT Signature. ${f.get("assertion")}` });
      return json(200, { access_token: scopes[c.scope], expires_in: 3599, token_type: "Bearer" });
    }
    // mold_v0-319: a disk (a compute.readonly token only) and a Filestore instance (cloud-platform: its only scope).
    if (host === "compute.googleapis.com" && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${GTOKEN_COMPUTE}`) return json(403, { error: { code: 403, message: "Request had insufficient authentication scopes." } });
      if (p === "/compute/v1/projects/my-project-123/zones/us-central1-a/disks/data-disk" || p === "/compute/v1/projects/other-project-9/zones/us-central1-a/disks/data-disk")
        return json(200, { kind: "compute#disk", name: "data-disk", sizeGb: "200", status: "READY", type: "https://www.googleapis.com/compute/v1/projects/my-project-123/zones/us-central1-a/diskTypes/pd-balanced" });
      return json(404, { error: { code: 404, message: "The resource 'projects/my-project-123/zones/us-central1-a/disks/x' was not found" } });
    }
    if (host === "file.googleapis.com" && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${GTOKEN_CP}`) return json(403, { error: { code: 403, message: "Request had insufficient authentication scopes." } });
      if (p === "/v1/projects/my-project-123/locations/us-central1-a/instances/nfs-1")
        return json(200, { name: "projects/my-project-123/locations/us-central1-a/instances/nfs-1", state: "READY", tier: "BASIC_HDD", fileShares: [{ name: "vol1", capacityGb: "1024" }] });
      return json(404, { error: { code: 404, message: "not found" } });
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
      // mold_v0-319: a storage account and a file share, read only.
      const acct = `/subscriptions/${SUB}/resourceGroups/rg-files.prod(1)/providers/Microsoft.Storage/storageAccounts/acmefiles01`;
      if (req.method === "GET" && p === `${acct}?api-version=2023-05-01`)
        return json(200, { name: "acmefiles01", location: "westeurope", kind: "StorageV2", sku: { name: "Standard_LRS" }, properties: { provisioningState: "Succeeded" } });
      if (req.method === "GET" && p === `${acct}/fileServices/default/shares/team-share?api-version=2023-05-01`)
        return json(200, { name: "team-share", properties: { shareQuota: 100, enabledProtocols: "SMB", accessTier: "TransactionOptimized" } });
      if (p.includes("/providers/Microsoft.Storage/")) return json(404, { error: { code: "ResourceNotFound", message: "The Resource 'Microsoft.Storage/storageAccounts/x' was not found." } });
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
const pgServer = (withTls: boolean, stubborn = false, key = PG_KEY, cert = PG_CERT) => net.createServer({ allowHalfOpen: stubborn }, (raw) => {
  raw.on("error", () => {});
  raw.once("data", (first: Buffer) => {
    const conn: PgConn = { tls: false, params: {}, password: null, queries: [], closed: false };
    raw.on("close", () => { conn.closed = true; });
    pgSeen.push(conn);
    if (first.length < 8 || first.readInt32BE(4) !== 80877103) { raw.destroy(); return; } // only an SSLRequest opens it
    if (!withTls) { raw.write("N"); return; }
    raw.write("S");
    conn.tls = true;
    speak(new tls.TLSSocket(raw, { isServer: true, key, cert, ...(stubborn ? { allowHalfOpen: true } : {}) } as tls.TLSSocketOptions), conn, stubborn);
  });
});
// mold_v0-319: a throwaway CA (made here, never stored) and a server certificate it signs, for the named-bundle test.
const tmp = (n: string) => path.join(TMP, n);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tmp("ca-key.pem"), "-out", tmp("ca-cert.pem"), "-days", "1", "-subj", "/CN=Fixture Provider Root CA",
  "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", tmp("srv-key.pem"), "-out", tmp("srv.csr"), "-subj", "/CN=db.pg.example"], { stdio: "ignore" });
writeFileSync(tmp("srv.ext"), "subjectAltName=DNS:db.pg.example\nbasicConstraints=CA:FALSE\n");
execFileSync("openssl", ["x509", "-req", "-in", tmp("srv.csr"), "-CA", tmp("ca-cert.pem"), "-CAkey", tmp("ca-key.pem"), "-CAcreateserial", "-out", tmp("srv-cert.pem"), "-days", "1",
  "-extfile", tmp("srv.ext")], { stdio: "ignore" });
const FIXTURE_CA = readFileSync(tmp("ca-cert.pem"), "utf8");
const pgTls = pgServer(true), pgPlain = pgServer(false), pgStubborn = pgServer(true, true), pgProvider = pgServer(true, false, readFileSync(tmp("srv-key.pem"), "utf8"), readFileSync(tmp("srv-cert.pem"), "utf8"));
await Promise.all([pgTls, pgPlain, pgStubborn, pgProvider].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
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
    assert.deepEqual(problems((_a, p) => { p.probes.pg.hosts = ["my-db.fly.dev", "my-db.c9akq0example.eu-west-1.rds.amazonaws.com"]; }), [], "an exact host under a shared suffix: fine");
    // mold_v0-319: the zone itself is no database's name.
    bad((_a, p) => { p.probes.pg.hosts = ["rds.amazonaws.com"]; }, /rds\.amazonaws\.com is a name anyone can host under/, "a bare database zone");
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

  // ---------- 9. mold_v0-319: resource checks ----------
  {
    const R = {
      by: "kind",
      probes: {
        ebs: { kind: "aws_sigv4", check: "ebs_volume", fields: { access_key_id: "key_id", secret_access_key: "secret", region: "region", volume_id: "volume" }, timeout_seconds: 5 },
        efs: { kind: "aws_sigv4", check: "efs_file_system", fields: { access_key_id: "key_id", secret_access_key: "secret", file_system_id: "fs_id" }, region: "eu-west-1", timeout_seconds: 5 },
        s3: { kind: "aws_sigv4", check: "s3_bucket", fields: { access_key_id: "key_id", secret_access_key: "secret", region: "region", bucket: "bucket" }, timeout_seconds: 5 },
        disk: { kind: "gcp_service_account", check: "compute_disk", fields: { service_account_json: "key_file", project: "project", zone: "zone", disk: "disk" }, timeout_seconds: 5 },
        filestore: { kind: "gcp_service_account", check: "filestore_instance", fields: { service_account_json: "key_file", location: "zone", instance: "instance" }, timeout_seconds: 5 },
        account: { kind: "azure_client_credentials", check: "storage_account", fields: { tenant_id: "tenant", client_id: "client", client_secret: "secret", subscription_id: "subscription",
          resource_group: "rg", storage_account: "account" }, timeout_seconds: 5 },
        share: { kind: "azure_client_credentials", check: "file_share", fields: { tenant_id: "tenant", client_id: "client", client_secret: "secret", subscription_id: "subscription",
          resource_group: "rg", storage_account: "account", file_share: "share" }, timeout_seconds: 5 },
      },
      status: "status", tested: "last_tested",
    };
    const RAREA = { ...structuredClone(AREA), name: "fx_resources",
      fields: [...AREA.fields.filter((f) => f.name !== "kind"), { name: "kind", label: "Kind", type: "enum", options: Object.keys(R.probes) },
        ...["volume", "fs_id", "bucket", "project", "zone", "disk", "instance", "rg", "account", "share"].map((n) => ({ name: n, label: n, type: "text" }))],
      detail: { ...structuredClone(AREA.detail), actions: [{ kind: "test_connection", place: "primary", label: "Test connection", roles: ["owner"], probe: R }, { kind: "edit", place: "secondary" }] } };
    const problems = (patch: (p: any) => void) => {
      const a = structuredClone(RAREA) as any; patch(a.detail.actions[0].probe);
      const r = api.RecordAreaSchema.safeParse(a);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    assert.deepEqual(problems(() => {}), [], "the resource checks' area");
    const bad = (patch: (p: any) => void, re: RegExp, what: string) => { const p = problems(patch); assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`); };
    bad((p) => { p.probes.ebs.check = "ec2:TerminateInstances"; }, /an aws_sigv4 probe's check is identity, ebs_volume, efs_file_system, s3_bucket/, "a free-form action as a check");
    bad((p) => { p.probes.disk.check = "delete"; }, /a gcp_service_account probe's check is project, token, compute_disk, filestore_instance/, "an unknown Google check");
    bad((p) => { p.probes.account.check = "keys"; }, /an azure_client_credentials probe's check is subscription, storage_account, file_share/, "an unknown Azure check");
    bad((p) => { delete p.probes.ebs.fields.volume_id; }, /check "ebs_volume" names the field holding its volume id/, "no volume field");
    bad((p) => { delete p.probes.ebs.fields.region; }, /check "ebs_volume" calls a regional endpoint/, "a regional check without a region");
    bad((p) => { p.probes.ebs.check = "identity"; }, /fields\.volume_id is read by another check than "identity"/, "a resource role on another check");
    bad((p) => { p.probes.ebs.fields.volume_id = "token"; }, /token is encrypted: a volume id decides/, "a sealed volume id");
    bad((p) => { p.probes.ebs.fields.bucket = "bucket"; }, /fields\.bucket is read by another check than "ebs_volume"/, "a bucket on the volume check");
    bad((p) => { delete p.probes.disk.fields.zone; }, /check "compute_disk" names the field holding its zone/, "no zone");
    bad((p) => { p.probes.disk.check = "token"; delete p.probes.disk.fields.zone; delete p.probes.disk.fields.disk; }, /check "token" reads no project/, "a project on the token check");
    bad((p) => { delete p.probes.account.fields.subscription_id; }, /check "storage_account" reads a resource in one subscription/, "no subscription");
    bad((p) => { delete p.probes.share.fields.file_share; }, /check "file_share" names the field holding its file share/, "no share");
    bad((p) => { delete p.probes.efs.region; p.probes.efs.region = "us-gov-west-1"; }, /us-gov-west-1 is an AWS China or GovCloud region/, "a fixed GovCloud region");
    bad((p) => { p.probes.ebs.fields.volume_id = "last_tested"; }, /last_tested is a date field: a volume id is a text or enum field/, "a date as a volume id");
    // The binding: a resource check's resource (and its subscription) decide, so changing them without the secret clears it.
    assert.deepEqual(cfg.destinationFields(R.probes.ebs as never).sort(), ["key_id", "region", "volume"]);
    assert.deepEqual(cfg.destinationFields(R.probes.s3 as never).sort(), ["bucket", "key_id", "region"]);
    assert.deepEqual(cfg.destinationFields(R.probes.disk as never).sort(), ["disk", "project", "zone"]);
    assert.deepEqual(cfg.destinationFields(R.probes.share as never).sort(), ["account", "client", "rg", "share", "subscription", "tenant"]);
    assert.deepEqual(cfg.destinationFields(PROBE.probes.azure as never).sort(), ["client", "tenant"], "the subscription check's subscription still binds nothing (mold_v0-313)");
    let ones = 0; // each its own area (the bindings are cached by area)
    const one = (probe: unknown) => ({ pack: "fixture_clouds", name: `fx_one_${++ones}`, fields: RAREA.fields, detail: { actions: [{ kind: "test_connection", probe: { probes: { "*": probe } } }] } }) as never;
    const st = { key_id: AKID, region: "eu-west-1", volume: VOL, tenant: TENANT, client: CLIENT, subscription: SUB, rg: "rg-a", account: "acmefiles01", share: "team-share", secret: "x", key_file: "z", zone: "us-central1-a", disk: "d", project: "my-project-123" };
    const drop = (o: Record<string, unknown>) => { const g: Record<string, unknown> = { ...st, ...o }; delete g.secret; delete g.key_file; return g; };
    assert.deepEqual(secretsToClear(one(R.probes.ebs), st, drop({ volume: VOL_GONE })), ["secret"], "another volume: the keys cleared");
    assert.deepEqual(secretsToClear(one(R.probes.share), st, drop({ share: "other-share" })), ["secret"], "another share: the secret cleared");
    assert.deepEqual(secretsToClear(one(R.probes.share), st, drop({ subscription: TENANT })), ["secret"], "another subscription on a resource check: cleared");
    assert.deepEqual(secretsToClear(one(R.probes.disk), st, drop({ zone: "europe-west4-b" })), ["key_file"], "another zone: the key file cleared");
    assert.deepEqual(secretsToClear(one(R.probes.share), st, drop({})), [], "nothing changed: kept");
    ok("resource checks, declared: fixed checks only (never an action from config), a check's resource fields required and another check's refused, plain, a region for a regional call; the resource and its subscription bind the secret");

    const run2 = async (probe: keyof typeof R.probes, data: Record<string, unknown>) => {
      const r = await C.runProbe(probe, R.probes[probe] as never, { plain: Object.fromEntries(Object.entries(data).filter(([k]) => !sealedNames.has(k))), sealed: sealedNames,
        open: async (n) => String(data[n] ?? ""), label: (n) => `"${n}"` });
      answers.push(JSON.stringify(r));
      return r;
    };
    const aws = { key_id: AKID, secret: AWS_SECRET, region: "eu-west-1" };
    // EC2 DescribeVolumes.
    const e1 = await run2("ebs", { ...aws, volume: VOL });
    assert.equal(e1.ok, true, e1.words); assert.match(e1.words, /^It works: AWS volume vol-…def0, 20 GB gp3, available, eu-west-1a, answered by ec2\.eu-west-1\.amazonaws\.com in \d+ ms\.$/);
    assert.equal(seen.at(-1)!.host, "ec2.eu-west-1.amazonaws.com"); assert.equal(seen.at(-1)!.body, `Action=DescribeVolumes&Version=2016-11-15&VolumeId.1=${VOL}`);
    assert.match(seen.at(-1)!.auth!, /Credential=[A-Z0-9]+\/\d{8}\/eu-west-1\/ec2\/aws4_request/, "signed for ec2 in its region");
    const e2 = await run2("ebs", { ...aws, volume: VOL_GONE });
    assert.equal(e2.outcome, "unexpected"); assert.equal(e2.words, "It does not work yet: AWS at ec2.eu-west-1.amazonaws.com answered 400: there is no volume vol-…3210 in eu-west-1 that these keys can see.");
    const e3 = await run2("ebs", { ...aws, secret: AWS_BAD, volume: VOL });
    assert.equal(e3.outcome, "refused", e3.words); assert.match(e3.words, /answered 401: the keys were refused \(it said: "AuthFailure: AWS was not able to validate/);
    let n = seen.length;
    for (const volume of ["vol-123", "vol-0123456789abcdef0/../x", "i-0123456789abcdef0", "vol-0123456789ABCDEF0", "vol-0123456789abcdef0&Action=DeleteVolume", "../vol-01234567"]) {
      const r = await run2("ebs", { ...aws, volume });
      assert.equal(r.outcome, "not_ready", volume); assert.match(r.words, /is not an EBS volume's ID/);
    }
    for (const region of ["eu-west-1.evil.example", "evil.example/x", "eu-west-1/../x"]) assert.match((await run2("ebs", { ...aws, region, volume: VOL })).words, /is not an AWS region's name/);
    assert.match((await run2("ebs", { key_id: AKID, secret: AWS_SECRET, volume: VOL })).words, /^It can't be tested yet: the region is empty: a volume is read at its region's endpoint\.$/);
    for (const region of ["cn-north-1", "cn-northwest-1", "us-gov-west-1", "us-gov-east-1"]) {
      const r = await run2("ebs", { ...aws, region, volume: VOL });
      assert.equal(r.outcome, "not_ready", region); assert.match(r.words, /is an AWS (China|GovCloud) region, and this test does not cover those yet/);
    }
    assert.match((await run("aws", { key_id: AKID, secret: AWS_SECRET, region: "cn-north-1" })).words, /China region/, "the identity check too");
    assert.equal(seen.length, n, "a bad id or region: nothing signed or sent");
    // An attached volume keeps its own type (its attachments' items cut out first); an error's ARN and account id cut.
    const e4 = await run2("ebs", { ...aws, volume: VOL_ATT });
    assert.equal(e4.ok, true, e4.words); assert.match(e4.words, /^It works: AWS volume vol-…bbbb, 8 GB io2, in-use, eu-west-1b,/);
    const e5 = await run2("ebs", { ...aws, volume: VOL_DENIED });
    assert.equal(e5.outcome, "refused"); assert.match(e5.words, /these keys may not describe volumes \(ec2:DescribeVolumes\) \(it said: "UnauthorizedOperation: You are not authorized/);
    assert.ok(!e5.words.includes("123456789012") && !/arn:aws/.test(e5.words), e5.words);
    assert.equal(S.awsWords("User: arn:aws:iam::123456789012:user/Alice in 123456789012, arn:aws-us-gov:sts::210987654321:assumed-role/R/s."), "User: an ARN in …9012, an ARN");
    // EFS DescribeFileSystems (a fixed region).
    const f1 = await run2("efs", { ...aws, fs_id: FS });
    assert.equal(f1.ok, true, f1.words); assert.match(f1.words, /^It works: AWS file system fs-…def0, available, 6\.0 KB used, eu-west-1, answered by elasticfilesystem\.eu-west-1\.amazonaws\.com in \d+ ms\.$/);
    assert.equal(seen.at(-1)!.path, `/2015-02-01/file-systems?FileSystemId=${FS}`); assert.match(seen.at(-1)!.auth!, /\/eu-west-1\/elasticfilesystem\/aws4_request/);
    const f2 = await run2("efs", { ...aws, fs_id: FS_GONE });
    assert.equal(f2.words, "It does not work yet: AWS at elasticfilesystem.eu-west-1.amazonaws.com answered 404: there is no file system fs-…cdef in eu-west-1 that these keys can see.");
    n = seen.length;
    for (const fs_id of ["fs-1", "fs-0123456789abcdef0&MaxItems=1", "fsap-0123456789abcdef0"]) assert.match((await run2("efs", { ...aws, fs_id })).words, /is not an EFS file system's ID/);
    assert.equal(seen.length, n);
    // S3 HeadBucket, path-style: the bucket's name is the path, never the host.
    const b1 = await run2("s3", { ...aws, bucket: "my-bucket.example" });
    assert.equal(b1.ok, true, b1.words); assert.match(b1.words, /^It works: AWS bucket my-bucket\.example, eu-west-1, answered by s3\.eu-west-1\.amazonaws\.com in \d+ ms\.$/);
    assert.deepEqual([seen.at(-1)!.host, seen.at(-1)!.path, seen.at(-1)!.method], ["s3.eu-west-1.amazonaws.com", "/my-bucket.example", "HEAD"]);
    assert.match(seen.at(-1)!.auth!, /\/eu-west-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date,/, "signed for s3, its payload hash signed");
    assert.match((await run2("s3", { ...aws, bucket: "far-bucket" })).words, /answered 301: bucket far-bucket is in ap-southeast-2, not eu-west-1\.$/);
    assert.match((await run2("s3", { ...aws, bucket: "gone-bucket" })).words, /answered 404: there is no bucket named gone-bucket\.$/);
    const b4 = await run2("s3", { ...aws, bucket: "locked-bucket" });
    assert.equal(b4.outcome, "refused"); assert.match(b4.words, /answered 403: the keys were refused for bucket locked-bucket/);
    assert.equal((await run2("s3", { ...aws, secret: AWS_BAD, bucket: "my-bucket.example" })).outcome, "refused");
    n = seen.length;
    for (const bucket of ["../x", "My_Bucket", "ab", "192.168.1.10", "evil.example/..", "b?x=1", "a..b", "xn--bucket", "bucket-s3alias", "x".repeat(64), "-bucket", "bucket#x"]) {
      const r = await run2("s3", { ...aws, bucket });
      assert.equal(r.outcome, "not_ready", bucket); assert.match(r.words, /is not an S3 bucket's name/);
    }
    assert.equal(seen.length, n, "a bad bucket name: nothing sent");
    ok("aws_sigv4 resource checks: EC2 DescribeVolumes, EFS DescribeFileSystems and S3 HeadBucket (path-style) signed for ec2, elasticfilesystem and s3 in the region; found, missing, in another region and refused in words, ids trimmed; a bad id, bucket or region refused before anything is signed");

    // Google: a disk (compute.readonly), a Filestore instance (cloud-platform).
    const g = { key_file: keyFile(SA_PEM), zone: "us-central1-a" };
    const d1 = await run2("disk", { ...g, disk: "data-disk" });
    assert.equal(d1.ok, true, d1.words); assert.match(d1.words, /^It works: Google Cloud disk data-disk in us-central1-a, 200 GB pd-balanced, READY, project my-project-123, read by probe@my-project-123\.iam\.gserviceaccount\.com in \d+ ms\.$/);
    assert.deepEqual(seen.slice(-2).map((x) => x.host), ["oauth2.googleapis.com", "compute.googleapis.com"]);
    const d1b = await run2("disk", { ...g, project: "other-project-9", disk: "data-disk" });
    assert.equal(d1b.ok, true, d1b.words); assert.match(d1b.words, /project other-project-9/);
    const d2 = await run2("disk", { ...g, disk: "gone-disk" });
    assert.equal(d2.outcome, "unexpected"); assert.match(d2.words, /answered 404: there is no disk gone-disk in us-central1-a in project my-project-123 \(or the service account may not see it\)\.$/);
    const fi = await run2("filestore", { ...g, instance: "nfs-1" });
    assert.equal(fi.ok, true, fi.words); assert.match(fi.words, /^It works: Google Cloud Filestore instance nfs-1 in us-central1-a, 1024 GB BASIC_HDD, READY, project my-project-123/);
    assert.equal(seen.at(-1)!.host, "file.googleapis.com");
    n = seen.length;
    for (const [k, v] of [["zone", "us-central1-a/../../x"], ["zone", "us-central1"], ["disk", "Data_Disk"], ["disk", "../x"], ["disk", "a/b"], ["disk", "1disk"], ["disk", "disk-"], ["project", "evil/../x"], ["project", "my-project-123/zones"], ["zone", "us-central1-a?x"]] as const) {
      const r = await run2("disk", { ...g, disk: "data-disk", [k]: v });
      assert.equal(r.outcome, "not_ready", `${k}=${v}: ${r.words}`);
    }
    for (const [k, v] of [["zone", "us-central1/x"], ["instance", "NFS"], ["instance", "nfs-1/../../x"]] as const) assert.equal((await run2("filestore", { ...g, instance: "nfs-1", [k]: v })).outcome, "not_ready", `${k}=${v}`);
    assert.equal(seen.length, n, "a segment that is not one: nothing signed or sent, not even the token request");
    ok("gcp_service_account resource checks: a Compute disk (a compute.readonly token) and a Filestore instance (cloud-platform, its only scope) read at their fixed hosts; missing said in words; a project, zone, location or name that is not one segment of Google's rules refused before anything is signed");

    // Azure: a storage account and a file share.
    const z = { tenant: TENANT, client: CLIENT, secret: AZ_SECRET, subscription: SUB, rg: "rg-files.prod(1)", account: "acmefiles01" };
    const s1 = await run2("account", z);
    assert.equal(s1.ok, true, s1.words); assert.match(s1.words, /^It works: Azure storage account acmefiles01 in resource group rg-files\.prod\(1\), westeurope, StorageV2 Standard_LRS, Succeeded, in \d+ ms\.$/);
    const s2 = await run2("share", { ...z, share: "team-share" });
    assert.equal(s2.ok, true, s2.words); assert.match(s2.words, /^It works: Azure file share team-share in storage account acmefiles01, 100 GB SMB, TransactionOptimized, in \d+ ms\.$/);
    const s3 = await run2("share", { ...z, share: "gone-share" });
    assert.equal(s3.outcome, "unexpected"); assert.match(s3.words, /answered 404: there is no file share gone-share in storage account acmefiles01 in subscription …5555/);
    assert.equal((await run2("account", { ...z, secret: AZ_BAD })).outcome, "refused");
    assert.match((await run2("account", { ...z, subscription: "" })).words, /"subscription" is empty/);
    n = seen.length;
    for (const [k, v] of [["rg", "../x"], ["rg", "rg/.."], ["rg", "rg?api-version=1"], ["rg", "rg."], ["rg", "rg%2f"], ["account", "Bad-Account"], ["account", "ab"], ["account", "acme/../x"], ["subscription", "../x"]] as const)
      assert.equal((await run2("account", { ...z, [k]: v })).outcome, "not_ready", `${k}=${v}`);
    for (const share of ["a--b", "Team", "../x", "x", "share/"]) assert.equal((await run2("share", { ...z, share })).outcome, "not_ready", share);
    assert.equal(seen.length, n, "a resource group, account, share or subscription that is not one: nothing sent");
    ok("azure_client_credentials resource checks: a storage account and a file share read at management.azure.com (api 2023-05-01); missing and refused in words; a name that leaves its segment refused before anything is sent");
  }

  // ---------- 10. mold_v0-319: managed-provider CAs for postgres ----------
  {
    const rds = S.caBundle("aws-rds")!, az = S.caBundle("azure")!;
    assert.equal(rds.length, 114, "the RDS global bundle: 114 certificates");
    for (const c of rds) assert.ok(new crypto.X509Certificate(c).ca, "each an authority's");
    assert.deepEqual(az.map((c) => new crypto.X509Certificate(c).fingerprint256).sort(), [
      "43:48:A0:E9:44:4C:78:CB:26:5E:05:8D:5E:89:44:B4:D8:4F:96:62:BD:26:DB:25:7F:89:34:A4:43:C7:01:61", // DigiCert Global Root CA
      "C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0", // Microsoft RSA Root Certificate Authority 2017
      "CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F", // DigiCert Global Root G2
    ]);
    for (const f of ["aws-rds.pem", "azure.pem"]) assert.ok(!/PRIVATE KEY/.test(readFileSync(new URL(`../src/ca/${f}`, import.meta.url), "utf8")), `${f}: certificates only`);
    assert.equal(S.caBundle("letsencrypt"), null); assert.equal(S.caBundle("../ca/aws-rds"), null);
    const p = (o: Record<string, unknown>) => cfg.connectionTestProblems(AREA as never, { by: "kind", probes: { pg: { ...PROBE.probes.pg, ...o } }, status: "status", tested: "last_tested" }).map((x) => x.message);
    const refused = (o: Record<string, unknown>, re: RegExp, what: string) => assert.ok(p(o).some((m) => re.test(m)), `${what}: ${JSON.stringify(p(o))}`);
    assert.deepEqual(p({ ca: "aws-rds", hosts: ["*.c9akq0example.eu-west-1.rds.amazonaws.com", "orders.c9akq0example.eu-west-1.rds.amazonaws.com", "*.proxy-c9akq0example.eu-west-1.rds.amazonaws.com"] }), [], "one account's RDS names");
    assert.deepEqual(p({ ca: "azure", hosts: ["orders-prod.postgres.database.azure.com", "*.orders-prod.postgres.database.azure.com"] }), [], "one Azure server");
    refused({ ca: "aws-rds", hosts: ["*.eu-west-1.rds.amazonaws.com"] }, /\*\.eu-west-1\.rds\.amazonaws\.com is a wildcard over a name anyone can host under/, "every account's databases in a region");
    refused({ ca: "aws-rds", hosts: ["*.rds.amazonaws.com"] }, /is a wildcard over a name anyone can host under/, "every RDS database");
    refused({ ca: "aws-rds", hosts: ["eu-west-1.rds.amazonaws.com"] }, /is a name anyone can host under/, "a region's zone, bare");
    refused({ ca: "azure", hosts: ["*.postgres.database.azure.com"] }, /is a wildcard over a name anyone can host under/, "every Azure server");
    refused({ ca: "azure", hosts: ["*.database.azure.com"] }, /is a wildcard over a name anyone can host under/, "above the zone");
    refused({ hosts: ["*.redshift.amazonaws.com"] }, /anyone can host under/, "Redshift's zone, without a ca too");
    // Fail closed: a wildcard anywhere under a shared provider name is refused, unless that zone's own labels allow it.
    const multi = ["*.compute-1.amazonaws.com", "*.us-east-1.elb.amazonaws.com", "*.s3.amazonaws.com", "*.dsql.us-east-1.on.aws", "*.neon.tech", "*.aws.neon.tech",
      "*.us-east-2.aws.neon.tech", "*.supabase.co", "*.pooler.supabase.com", "*.db.ondigitalocean.com", "*.b.db.ondigitalocean.com", "*.aivencloud.com", "*.a.aivencloud.com",
      "*.oregon-postgres.render.com", "*.cloudapp.net", "*.a.run.app", "*.eu-west-1.compute.amazonaws.com", "*.lambda-url.us-east-1.on.aws", "*.core.windows.net", "*.westeurope.cloudapp.azure.com"];
    for (const h of multi) {
      assert.equal(cfg.sharedWildcard(h), true, h);
      refused({ hosts: [h] }, /is a wildcard over a name anyone can host under/, `a postgres probe's ${h}`);
      const hp = cfg.connectionTestProblems(AREA as never, { probes: { "*": { method: "GET", url: "https://api.example.com/v1", hosts: [h] } } }).map((x) => x.message);
      assert.ok(hp.some((m) => /is a wildcard over a name anyone can host under/.test(m)), `an http probe's ${h}: ${JSON.stringify(hp)}`);
    }
    // Exact hosts under them, and wildcards under one customer's own labels, are fine.
    for (const h of ["ep-cool-river-123456.us-east-2.aws.neon.tech", "db.abcdefghijklmnop.supabase.co", "*.abcdefghijklmnop.supabase.co", "ec2-1-2-3-4.compute-1.amazonaws.com",
      "my-db.b.db.ondigitalocean.com", "pg-acme.aivencloud.com", "dpg-abc.oregon-postgres.render.com", "*.example.co.uk", "*.myapp.vercel.app", "*.acme.workers.dev",
      "*.vm1.westeurope.cloudapp.azure.com", "*.c9akq0example.eu-west-1.rds.amazonaws.com", "*.example.org", "*.sebi.gov.in"])
      assert.equal(cfg.sharedWildcard(h), false, h);
    for (const h of ["neon.tech", "supabase.com", "eu-west-1.rds.amazonaws.com", "co.uk", "*.co.uk", "*.vercel.app", "*.com"]) assert.equal(cfg.sharedWildcard(h), true, h);
    // any_customer_host: a managed database product's every-customer zone, opted into, while the host is bound to the password.
    const IMMACULATE = ["*.aws.neon.tech", "*.azure.neon.tech", "*.supabase.co", "*.pooler.supabase.com", "*.postgres.database.azure.com"];
    for (const h of IMMACULATE) {
      refused({ hosts: [h] }, /is a wildcard over a name anyone can host under/, `${h} without the opt-in`);
      assert.deepEqual(p({ hosts: [h], any_customer_host: true }), [], `${h} with the opt-in (a host field)`);
      assert.deepEqual(p({ hosts: [h], any_customer_host: true, fields: { url: "secret" } }), [], `${h} with the opt-in (a sealed url)`);
    }
    assert.deepEqual(p({ hosts: ["*.rds.amazonaws.com", "*.eu-west-1.rds.amazonaws.com"], any_customer_host: true, ca: "aws-rds" }), [], "every RDS database, opted into");
    for (const h of ["*.neon.tech", "*.compute-1.amazonaws.com", "*.s3.amazonaws.com", "*.us-east-1.elb.amazonaws.com", "*.amazonaws.com", "*.co.uk", "*.com", "*.vercel.app", "*.dsql.us-east-1.on.aws", "*.aivencloud.com"])
      refused({ hosts: [h], any_customer_host: true }, /is a wildcard over a name anyone can host under|a host's name/, `${h} stays refused with the opt-in`);
    // Not bound: the host written by an action (no clearing), a sealed host, no secret; and an opt-in with nothing to cover.
    refused({ hosts: ["*.supabase.co"], any_customer_host: true, fields: { host: "status", user: "user", password: "secret" } }, /set_by "action": with any_customer_host the host is written by people only/, "a host an action writes");
    refused({ hosts: ["*.supabase.co"], any_customer_host: true, fields: { host: "token", user: "user", password: "secret" } }, /any_customer_host needs the host in a plain field that decides/, "a sealed host");
    refused({ hosts: ["db.abc.supabase.co"], any_customer_host: true }, /any_customer_host is for a wildcard over a managed database product's zone/, "an opt-in with only exact hosts");
    assert.ok(cfg.connectionTestProblems({ ...structuredClone(AREA), lifecycle: { field: "host" } } as never,
      { by: "kind", probes: { pg: { ...PROBE.probes.pg, hosts: ["*.supabase.co"], any_customer_host: true } } }).some((x) => /\{host\} is the lifecycle's field/.test(x.message)), "a host a move changes");

    refused({ ca: "aws-rds", hosts: ["*.pg.example"] }, /\*\.pg\.example is not a aws-rds database's name: with ca "aws-rds" every host is under rds\.amazonaws\.com/, "a bundle for another provider's hosts");
    refused({ ca: "azure", hosts: ["db.c9akq0example.eu-west-1.rds.amazonaws.com"] }, /not a azure database's name/, "the Azure bundle for an RDS host");
    refused({ ca: "letsencrypt" }, /a postgres probe's ca is a bundle the mold ships: aws-rds, azure/, "a bundle the mold does not ship");
    refused({ ca: FIXTURE_CA }, /a postgres probe's ca is a bundle the mold ships/, "an inline certificate");
    // The options: the named bundle besides the stores (never instead of them).
    delete process.env.APP_TEST_WORLD;
    const withRds = S.pgTlsOptionsForTest("db.c9akq0example.eu-west-1.rds.amazonaws.com", "aws-rds").ca as string[];
    for (const c of rds) assert.ok(withRds.includes(c));
    assert.ok(withRds.length > rds.length, "the bundled and system stores kept");
    process.env.APP_TEST_WORLD = "1";

    // The TLS stand-in whose certificate a throwaway CA signed: trusted only through that CA as a named bundle.
    S.registerCaBundleForTest("fixture-ca", FIXTURE_CA);
    S.setPostgresStandinForTest({ port: pgPort(pgProvider), ca: OTHER_CA }); // the stand-in's own trust: not this server's
    const pgBase = { host: "db.pg.example", port: 5432, database: "orders", user: "app", secret: PG_PW };
    const runPg = async (o: Record<string, unknown>, data = pgBase) => {
      const r = await C.runProbe("pg", { ...PROBE.probes.pg, ...o } as never, { plain: Object.fromEntries(Object.entries(data).filter(([k]) => !sealedNames.has(k))), sealed: sealedNames, open: async (k) => String((data as any)[k] ?? ""), label });
      answers.push(JSON.stringify(r)); return r;
    };
    let m = pgSeen.length;
    const c1 = await runPg({ ca: "fixture-ca" });
    assert.equal(c1.ok, true, c1.words); assert.match(c1.words, /^It works: the orders database at db\.pg\.example answered SELECT 1 over TLS in \d+ ms\.$/);
    assert.equal(pgSeen.at(-1)!.password, PG_PW);
    const c2 = await runPg({});
    assert.equal(c2.outcome, "unreachable", c2.words); assert.equal(pgSeen.at(-1)!.password, null, "without the bundle: no password sent");
    const c3 = await runPg({ ca: "aws-rds" });
    assert.equal(c3.outcome, "unreachable", c3.words); assert.equal(pgSeen.at(-1)!.password, null, "another provider's bundle: no password sent");
    assert.equal(pgSeen.length, m + 3);
    const c4 = await runPg({ ca: "no-such-bundle" });
    assert.equal(c4.outcome, "not_ready"); assert.match(c4.words, /this app has no CA bundle named "no-such-bundle"/);
    assert.equal(pgSeen.length, m + 3, "an unknown bundle: nothing connected");
    // Outside a test world the registered bundle is never trusted.
    delete process.env.APP_TEST_WORLD;
    assert.equal(S.caBundle("fixture-ca"), null);
    process.env.APP_TEST_WORLD = "1";
    S.registerCaBundleForTest("fixture-ca", null);
    S.setPostgresStandinForTest({ port: pgPort(pgTls), ca: PG_CERT });
    ok("managed-provider CAs: the RDS global bundle (114) and Azure's 3 roots ship as public certificates; ca names a shipped bundle only, its hosts one account's or one server's under that provider's zone; a throwaway CA's server is trusted only through its named bundle (a test world only), and without it no password is sent");
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
  standin.close(); pgTls.close(); pgPlain.close(); pgStubborn.close(); pgProvider.close();
  cleanup();
}
process.exit(0);
