/**
 * Test connection's signed kinds (mold_v0-313; the probe's `kind`, declared in pack config: src/connection-test-config.ts;
 * the HTTP probe of mold_v0-312 is src/connection-test.ts, which calls runSignedProbe for every other kind). Each kind's
 * hosts, call and signing are fixed here; the record gives only the values of the roles its pack names.
 *
 *   aws_sigv4                  POST https://sts.amazonaws.com/ (or sts.<region>.amazonaws.com) GetCallerIdentity, signed
 *                              with Signature Version 4 (node:crypto, no SDK). "It works: AWS account ending …1234 (Alice)"
 *                              (the account's last 4 digits and the ARN's last segment only). mold_v0-319, by `check`:
 *                              "ebs_volume" POST ec2.<region>.amazonaws.com DescribeVolumes (VolumeId.1, service ec2);
 *                              "efs_file_system" GET elasticfilesystem.<region>.amazonaws.com/2015-02-01/file-systems
 *                              ?FileSystemId= (service elasticfilesystem); "s3_bucket" HEAD s3.<region>.amazonaws.com/<bucket>
 *                              (path-style, service s3). Each id checked against AWS's own shape before anything is signed.
 *   gcp_service_account        the key file's token_uri must be https://oauth2.googleapis.com/token exactly (a crafted one
 *                              never receives the signed assertion); an RS256 assertion for a read-only scope exchanged
 *                              there, then (check "project") GET cloudresourcemanager.googleapis.com/v1/projects/<id>;
 *                              mold_v0-319: "compute_disk" GET compute.googleapis.com/compute/v1/projects/<p>/zones/<z>/disks/<d>
 *                              (scope compute.readonly), "filestore_instance" GET file.googleapis.com/v1/projects/<p>/locations/
 *                              <l>/instances/<i> (scope cloud-platform: the only one Filestore takes; one GET, then dropped).
 *   azure_client_credentials   POST login.microsoftonline.com/<tenant>/oauth2/v2.0/token (client credentials, the
 *                              management scope), then GET management.azure.com/subscriptions[/<id>] (read-only);
 *                              mold_v0-319: "storage_account" GET .../resourceGroups/<rg>/providers/Microsoft.Storage/
 *                              storageAccounts/<name>, "file_share" .../fileServices/default/shares/<share> (api 2023-05-01).
 *   postgres                   TLS only (the server's certificate checked against the host's name, the bundled and the
 *                              system's CAs; mold_v0-319: with `ca`, a provider's public bundle shipped in src/ca/ besides),
 *                              the host one of the probe's `hosts` resolving to public addresses only, the
 *                              connection pinned to the address checked (never this app's own database, by name or
 *                              address), a port of its `ports`; BEGIN READ ONLY, SET LOCAL statement_timeout (10 s),
 *                              SELECT 1, ROLLBACK, a close that never waits on the server (the socket destroyed). The server's error text is never
 *                              read (it may echo a value): only its SQLSTATE code, in words.
 *
 * Every opened secret and everything derived from one (a signature, an Authorization header, an assertion, an access
 * token, a password from a url) is on the probe's secrets list, cut from its answer; nothing here logs. HTTP calls go
 * through src/connection-test.ts's checks (https, 443, the kind's hosts only, every address public, pinned, no redirect
 * followed). Tests: scripts/signed-probes-test.ts (the stand-in of APP_CONNECTION_TEST_STANDIN; a TLS Postgres stand-in
 * through setPostgresStandinForTest, honoured in a test world only).
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { AWS_REGION, AWS_REGION_UNCOVERED, GCP_TOKEN_URI, hostListed, KIND_HOSTS, localName, PG_CA_BUNDLES, POSTGRES_DEFAULT_PORT, PROBE_TIMEOUT_DEFAULT, type SignedProbe } from "./connection-test-config.js";
import { asText, checkAddress, cleanAnswer, cleanWords, noBreaks, ownHosts, ProbeError, resolveHost, safeSummary, SECRET_MIN, send, standin, statusWords,
  type ConnectionOutcome, type ConnectionTestAnswer, type ProbeValues, type Wire } from "./connection-test.js";
import { privateAddress } from "./egress-hosts.js";

const FORM = "application/x-www-form-urlencoded; charset=utf-8";
const KIND_LABEL: Record<SignedProbe["kind"], string> = { aws_sigv4: "AWS", gcp_service_account: "Google Cloud", azure_client_credentials: "Azure", postgres: "the database" };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_NAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** The read-only scope a service account's token asks for. */
export const GCP_KEY_BITS_MAX = 4096;
export const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const GCP_SCOPE_RO = GCP_SCOPE;
export const AZURE_SCOPE = "https://management.azure.com/.default";
/** The statement timeout of the database test's query. */
export const PG_STATEMENT_MS = 10_000;

interface Ctx { label: string; host: string | null; status: number | null; secrets: string[]; deadline: number; seconds: number; started: number }

/** Make a signed kind's call with the record's values; never throws for the service's answer (as runProbe). */
export async function runSignedProbe(key: string, p: SignedProbe, vals: ProbeValues): Promise<ConnectionTestAnswer> {
  const seconds = p.timeout_seconds ?? PROBE_TIMEOUT_DEFAULT;
  const started = Date.now();
  const ctx: Ctx = { label: p.label ?? KIND_LABEL[p.kind], host: null, status: null, secrets: [], deadline: started + seconds * 1000, seconds, started };
  const answer = (ok: boolean, outcome: ConnectionOutcome, words: string): ConnectionTestAnswer =>
    ({ ok, outcome, words: cleanAnswer(words, ctx.secrets), host: ctx.host, status: ctx.status, ms: ok ? Date.now() - started : 0, probe: key });
  try {
    const value = roleReader(p, vals, ctx);
    const words = p.kind === "aws_sigv4" ? await aws(p, value, ctx)
      : p.kind === "gcp_service_account" ? await gcp(p, value, ctx)
        : p.kind === "azure_client_credentials" ? await azure(p, value, ctx)
          : await postgres(p, value, ctx);
    return answer(true, "working", words);
  } catch (e) {
    if (!(e instanceof ProbeError)) throw e;
    if (e.outcome === "not_ready") return answer(false, "not_ready", `It can't be tested yet: ${e.message}.`);
    if (e.outcome === "private_address") return answer(false, "private_address", `It can't be tested: ${e.message}.`);
    return answer(false, e.outcome, `It does not work yet: ${e.message}.`);
  }
}

type Reader = (role: string, required: boolean, multiline?: boolean) => Promise<string | null>;
/** A role's value: an encrypted field opened here (on the secrets list; too short refused), a plain one as stored. */
function roleReader(p: SignedProbe, vals: ProbeValues, ctx: Ctx): Reader {
  return async (role, required, multiline = false) => {
    const n = (p.fields as Record<string, string | undefined>)[role];
    if (!n) return null;
    let v: string;
    if (vals.sealed.has(n)) {
      v = await vals.open(n);
      if (v) ctx.secrets.push(v);
      if (v && v.length < SECRET_MIN) throw new ProbeError("not_ready", `${vals.label(n)} is too short to be a secret (at least ${SECRET_MIN} characters): add it again`);
    } else v = asText(vals.plain[n]);
    if (!v) { if (required) throw new ProbeError("not_ready", `${vals.label(n)} is empty`); return null; }
    if (!multiline && noBreaks.test(v)) throw new ProbeError("not_ready", `${vals.label(n)} holds a line break or a control character`);
    return v;
  };
}
const fieldLabel = (p: SignedProbe, vals: ProbeValues, role: string) => vals.label((p.fields as Record<string, string>)[role]!);

/**
 * One HTTPS call of a kind: the address checked (the kind's hosts only), no redirect followed (a 3xx is refused in
 * words, or, with `keep3xx`, returned for the caller to say why: S3 answers 301 for a bucket in another region).
 */
async function call(ctx: Ctx, url: string, allowed: readonly string[], method: "GET" | "POST" | "HEAD", headers: Record<string, string>, body: string | null, keep3xx = false): Promise<Wire> {
  const u = new URL(url);
  ctx.host = u.hostname;
  await checkAddress(u, allowed);
  const w = await send(u, method, headers, body, ctx.deadline, `${ctx.label} at ${u.hostname} did not answer within ${ctx.seconds} second${ctx.seconds === 1 ? "" : "s"}`);
  ctx.status = w.status;
  if (w.status >= 300 && w.status < 400 && !keep3xx) throw new ProbeError("unexpected", `${ctx.label} at ${u.hostname} answered ${w.status}: it sent the test elsewhere, and this test does not follow it`);
  return w;
}
/** mold_v0-319: a resource's id in an answer: its kind's prefix and last 4 characters ("vol-…1234"). */
const trimId = (id: string) => { const i = id.indexOf("-"); return `${i > 0 ? id.slice(0, i + 1) : ""}…${id.slice(-4)}`; };
/** A whole number of bytes or gigabytes in words. */
const sizeWords = (bytes: number) => { const u = ["bytes", "KB", "MB", "GB", "TB", "PB"]; let n = bytes, i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`; };
/** A short word from an answer (a state, a type), shown only when it is plainly one. */
const word = (v: unknown, re = /^[A-Za-z0-9_.-]{1,40}$/) => (typeof v === "string" && re.test(v) ? v : null);
const num = (v: unknown) => { const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null; return n; };
/** A failing answer in words: 401 or 403 (or an OAuth error naming the credentials) as refused, with the service's own cleaned line. */
function failed(ctx: Ctx, w: Wire, refusedWords: string, said: string | null): never {
  const oauth = (() => { try { return String((JSON.parse(w.body.toString("utf8")) as { error?: unknown }).error ?? ""); } catch { return ""; } })();
  const refused = w.status === 401 || w.status === 403 || ["invalid_client", "invalid_grant", "unauthorized_client", "access_denied"].includes(oauth);
  throw new ProbeError(refused ? "refused" : "unexpected",
    `${ctx.label} at ${ctx.host} answered ${w.status}: ${refused ? refusedWords : statusWords(w.status)}${said ? ` (it said: "${said}")` : ""}`);
}
const ok2xx = (w: Wire) => w.status >= 200 && w.status < 300;
const json = (w: Wire): Record<string, unknown> | null => { try { const j = JSON.parse(w.body.toString("utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; } };
const took = (ctx: Ctx) => `${Date.now() - ctx.started} ms`;

// ---------------------------------------------------------------- aws_sigv4

const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => crypto.createHmac("sha256", k).update(s, "utf8").digest();
export interface SigV4Request { method: string; host: string; path: string; query: string; headers: Record<string, string>; body: string; region: string; service: string;
  accessKeyId: string; secretAccessKey: string; sessionToken?: string | null; now: Date }
/**
 * AWS Signature Version 4 (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html):
 * the headers to send (x-amz-date, x-amz-security-token, authorization; host is the connection's own) and the signature.
 * `query` is already canonical (its names sorted, its values escaped).
 */
export function sigv4(r: SigV4Request): { headers: Record<string, string>; signature: string } {
  const amzDate = r.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) h[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  h.host = r.host; h["x-amz-date"] = amzDate;
  if (r.sessionToken) h["x-amz-security-token"] = r.sessionToken;
  const names = Object.keys(h).sort();
  const signed = names.join(";");
  const canonical = [r.method, r.path, r.query, names.map((n) => `${n}:${h[n]}\n`).join(""), signed, sha256(r.body)].join("\n");
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${r.secretAccessKey}`, date), r.region), r.service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  const { host: _host, ...send } = h;
  return { headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }, signature };
}
const xmlTag = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]{0,2048})</${tag}>`).exec(xml)?.[1]?.trim() ?? null;

/**
 * mold_v0-319: an AWS error's words with what identifies an account cut: an ARN said as "an ARN", a 12-digit account
 * id as its last 4 digits.
 */
export const awsWords = (s: string) => s.replace(/\barn:aws[a-z-]*:[^\s"'<>,;()]*/g, "an ARN").replace(/\b\d{12}\b/g, (d) => `…${d.slice(-4)}`);

/** mold_v0-319: AWS's own shapes of the ids a resource check reads (checked before anything is signed). */
export const AWS_VOLUME_ID = /^vol-([0-9a-f]{8}|[0-9a-f]{17})$/;
export const AWS_FILE_SYSTEM_ID = /^fs-([0-9a-f]{8}|[0-9a-f]{17})$/;
/** A bucket's name (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html): 3 to 63 of a-z 0-9 . -. */
export const awsBucketName = (b: string) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) && !b.includes("..") && !/^\d{1,3}(\.\d{1,3}){3}$/.test(b)
  && !/^(xn--|sthree-|amzn-s3-demo-)/.test(b) && !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(b) && !b.includes(".-") && !b.includes("-.");

async function aws(p: Extract<SignedProbe, { kind: "aws_sigv4" }>, value: Reader, ctx: Ctx): Promise<string> {
  const accessKeyId = (await value("access_key_id", true))!;
  ctx.secrets.push(accessKeyId); // a plain key id is still never repeated in the answer
  const secretAccessKey = (await value("secret_access_key", true))!;
  const sessionToken = await value("session_token", false);
  const region = p.region ?? (await value("region", false));
  const check = p.check ?? "identity";
  if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) throw new ProbeError("not_ready", "the access key ID is not an AWS access key ID (capital letters and digits)");
  if (region !== null && !AWS_REGION.test(region)) throw new ProbeError("not_ready", `"${cleanWords(region, ctx.secrets) ?? "the region"}" is not an AWS region's name (eu-west-1)`);
  // mold_v0-319: China's endpoints are under another domain and GovCloud's and China's use other CAs: not covered yet.
  if (region !== null && AWS_REGION_UNCOVERED.test(region)) throw new ProbeError("not_ready", `${region} is an AWS ${region.startsWith("cn-") ? "China" : "GovCloud"} region, and this test does not cover those yet`);
  if (sessionToken && !/^[\x21-\x7e]+$/.test(sessionToken)) throw new ProbeError("not_ready", "the session token holds a character a header cannot carry");
  if (!/^[\x21-\x7e]+$/.test(secretAccessKey)) throw new ProbeError("not_ready", "the secret access key holds a character it cannot hold");
  if (check !== "identity") return awsResource(p, check, value, ctx, { accessKeyId, secretAccessKey, sessionToken, region });
  const host = KIND_HOSTS.aws_sigv4(region)[0]!;
  const body = "Action=GetCallerIdentity&Version=2011-06-15";
  const s = sigv4({ method: "POST", host, path: "/", query: "", headers: { "content-type": FORM }, body, region: region ?? "us-east-1", service: "sts",
    accessKeyId, secretAccessKey, sessionToken, now: new Date() });
  ctx.secrets.push(s.signature, s.headers.authorization!);
  const w = await call(ctx, `https://${host}/`, [host], "POST", { ...s.headers, accept: "text/xml" }, body);
  const xml = w.body.toString("utf8");
  if (!ok2xx(w)) {
    const code = xmlTag(xml, "Code"), msg = xmlTag(xml, "Message");
    const said = msg ? cleanWords(awsWords(`${code && /^[A-Za-z.]{1,64}$/.test(code) ? `${code}: ` : ""}${msg}`), ctx.secrets) : safeSummary(w.body, ctx.secrets);
    failed(ctx, w, "the keys were refused", said);
  }
  const account = xmlTag(xml, "Account"), arn = xmlTag(xml, "Arn");
  if (!account || !/^\d{12}$/.test(account)) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}, but not with the caller's identity this test reads`);
  const last = arn?.split(/[:/]/).pop() ?? "";
  return `It works: AWS account ending …${account.slice(-4)}${/^[\w+=,.@-]{1,64}$/.test(last) ? ` (${last})` : ""}, answered by ${host} in ${took(ctx)}.`;
}

/**
 * mold_v0-319: one AWS resource read, by check. The record gives only validated parameters (an id in a form field or
 * the query, a bucket's name as the path); the host is the check's own, the region its one record-given label.
 */
async function awsResource(p: Extract<SignedProbe, { kind: "aws_sigv4" }>, check: "ebs_volume" | "efs_file_system" | "s3_bucket", value: Reader, ctx: Ctx,
  k: { accessKeyId: string; secretAccessKey: string; sessionToken: string | null; region: string | null }): Promise<string> {
  if (!k.region) throw new ProbeError("not_ready", `${p.fields.region ? "the region is empty" : "this test names no region"}: a ${check === "s3_bucket" ? "bucket" : check === "ebs_volume" ? "volume" : "file system"} is read at its region's endpoint`);
  const region = k.region;
  const host = KIND_HOSTS.aws_sigv4(region, check)[0]!;
  const sign = (method: string, path: string, query: string, headers: Record<string, string>, body: string, service: string) => {
    const s = sigv4({ method, host, path, query, headers, body, region, service, accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, sessionToken: k.sessionToken, now: new Date() });
    ctx.secrets.push(s.signature, s.headers.authorization!);
    return s.headers;
  };
  const awsSaid = (w: Wire) => {
    const text = w.body.toString("utf8");
    let code = xmlTag(text, "Code"), msg = xmlTag(text, "Message");
    if (!code) { const j = json(w); code = word(j?.ErrorCode ?? j?.code ?? j?.__type, /^[A-Za-z.#:]{1,64}$/); msg = typeof (j?.Message ?? j?.message) === "string" ? String(j?.Message ?? j?.message) : null; }
    code = code && /^[A-Za-z.#:]{1,64}$/.test(code) ? code.replace(/^.*#/, "") : null;
    return { code, said: msg ? cleanWords(awsWords(`${code ? `${code}: ` : ""}${msg}`), ctx.secrets) : code };
  };
  const awsFailed = (w: Wire, missing: RegExp, noneWords: string, mayNot: string): never => {
    const { code, said } = awsSaid(w);
    if ((code && missing.test(code)) || w.status === 404) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}: ${noneWords}`);
    if (code === "UnauthorizedOperation" || code === "AccessDeniedException" || code === "AccessDenied")
      throw new ProbeError("refused", `${ctx.label} at ${host} answered ${w.status}: ${mayNot}${said ? ` (it said: "${said}")` : ""}`);
    return failed(ctx, w, "the keys were refused", said);
  };
  if (check === "ebs_volume") {
    const id = (await value("volume_id", true))!;
    if (!AWS_VOLUME_ID.test(id)) throw new ProbeError("not_ready", "the volume ID is not an EBS volume's ID (vol- and 8 or 17 of 0-9 a-f)");
    ctx.secrets.push(id); // the whole id is never repeated: its last 4 characters only
    const body = `Action=DescribeVolumes&Version=2016-11-15&VolumeId.1=${id}`;
    const w = await call(ctx, `https://${host}/`, [host], "POST", { ...sign("POST", "/", "", { "content-type": FORM }, body, "ec2"), accept: "text/xml" }, body);
    if (!ok2xx(w)) awsFailed(w, /^InvalidVolume\.NotFound$/, `there is no volume ${trimId(id)} in ${region} that these keys can see`, "these keys may not describe volumes (ec2:DescribeVolumes)");
    const xml = w.body.toString("utf8");
    // The attachments' own <item>s cut out first: the volume's item ends at its own </item>.
    const item = /<volumeSet>\s*<item>([\s\S]{0,8192}?)<\/item>/.exec(xml.replace(/<attachmentSet>[\s\S]*?<\/attachmentSet>/g, ""))?.[1] ?? "";
    if (xmlTag(item, "volumeId") !== id) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}, but not with the volume this test reads`);
    const size = num(xmlTag(item, "size")), state = word(xmlTag(item, "status")), type = word(xmlTag(item, "volumeType")), az = word(xmlTag(item, "availabilityZone"));
    return `It works: AWS volume ${trimId(id)}${size !== null ? `, ${size} GB` : ""}${type ? ` ${type}` : ""}${state ? `, ${state}` : ""}, ${az ?? region}, answered by ${host} in ${took(ctx)}.`;
  }
  if (check === "efs_file_system") {
    const id = (await value("file_system_id", true))!;
    if (!AWS_FILE_SYSTEM_ID.test(id)) throw new ProbeError("not_ready", "the file system ID is not an EFS file system's ID (fs- and 8 or 17 of 0-9 a-f)");
    ctx.secrets.push(id);
    const path = "/2015-02-01/file-systems", query = `FileSystemId=${id}`;
    const w = await call(ctx, `https://${host}${path}?${query}`, [host], "GET", { ...sign("GET", path, query, {}, "", "elasticfilesystem"), accept: "application/json" }, null);
    if (!ok2xx(w)) awsFailed(w, /^FileSystemNotFound$/, `there is no file system ${trimId(id)} in ${region} that these keys can see`, "these keys may not describe file systems (elasticfilesystem:DescribeFileSystems)");
    const fs = (json(w)?.FileSystems as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    if (!fs || fs.FileSystemId !== id) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}, but not with the file system this test reads`);
    const state = word(fs.LifeCycleState), used = num((fs.SizeInBytes as Record<string, unknown> | undefined)?.Value);
    return `It works: AWS file system ${trimId(id)}${state ? `, ${state}` : ""}${used !== null ? `, ${sizeWords(used)} used` : ""}, ${region}, answered by ${host} in ${took(ctx)}.`;
  }
  const bucket = (await value("bucket", true))!;
  if (!awsBucketName(bucket)) throw new ProbeError("not_ready", "the bucket is not an S3 bucket's name (3 to 63 of a-z, 0-9, . and -)");
  const path = `/${bucket}`, empty = sha256("");
  const w = await call(ctx, `https://${host}${path}`, [host], "HEAD", sign("HEAD", path, "", { "x-amz-content-sha256": empty }, "", "s3"), null, true);
  const where = word(w.headers["x-amz-bucket-region"], AWS_REGION);
  if (w.status === 301 || w.status === 307 || (w.status === 400 && where && where !== region)) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}: bucket ${bucket} is in ${where ?? "another region"}, not ${region}`);
  if (w.status === 404) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered 404: there is no bucket named ${bucket}`);
  if (w.status === 403) throw new ProbeError("refused", `${ctx.label} at ${host} answered 403: the keys were refused for bucket ${bucket} (they may not read it, s3:ListBucket, or it is another account's)`);
  if (!ok2xx(w)) failed(ctx, w, "the keys were refused", null);
  return `It works: AWS bucket ${bucket}, ${where ?? region}, answered by ${host} in ${took(ctx)}.`;
}

// ---------------------------------------------------------------- gcp_service_account

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** An RS256 JSON Web Token (exported for the tests' stand-in, which checks it with the key's public half). */
export function signJwt(claims: Record<string, unknown>, key: crypto.KeyObject, kid: string | null): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}
const GCP_PROJECT = /^([a-z0-9.-]{1,63}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/**
 * mold_v0-319: Google's naming rules for the path segments a resource check reads (each one segment, never a "/"):
 * a zone (us-central1-a), a Filestore location (a zone or a region), a disk's or an instance's name (RFC 1035: a
 * lowercase letter, then up to 62 of a-z 0-9 -, not ending in -).
 */
export const GCP_ZONE = /^[a-z]{2,20}-[a-z]{2,20}\d{1,2}-[a-z]$/;
export const GCP_LOCATION = /^[a-z]{2,20}-[a-z]{2,20}\d{1,2}(-[a-z])?$/;
export const GCP_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** The token's scope per check: read-only where the API takes it (Filestore takes cloud-platform only). */
export const GCP_SCOPES: Readonly<Record<string, string>> = Object.freeze({ project: GCP_SCOPE_RO, token: GCP_SCOPE_RO, compute_disk: "https://www.googleapis.com/auth/compute.readonly",
  filestore_instance: "https://www.googleapis.com/auth/cloud-platform" });

async function gcp(p: Extract<SignedProbe, { kind: "gcp_service_account" }>, value: Reader, ctx: Ctx): Promise<string> {
  const raw = (await value("service_account_json", true, true))!;
  const notKey = (why: string) => new ProbeError("not_ready", `the service account's key file ${why}`);
  let j: Record<string, unknown>;
  try { const x = JSON.parse(raw); if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("not an object"); j = x; } catch { throw notKey("is not JSON (paste the whole file Google Cloud gave)"); }
  if (typeof j.private_key === "string") ctx.secrets.push(j.private_key);
  if (typeof j.private_key_id === "string") ctx.secrets.push(j.private_key_id);
  if (j.type !== "service_account") throw notKey(`is not a service account's (its "type" is not "service_account")`);
  // mold_v0-313: the signed assertion goes to Google's own token address only, whatever the file says.
  if (j.token_uri !== GCP_TOKEN_URI) throw notKey(`names another token address than Google's own (${GCP_TOKEN_URI}), and the test sends its signed assertion only there`);
  const email = typeof j.client_email === "string" ? j.client_email : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9.-]{3,200}$/i.test(email)) throw notKey("has no client_email the test can use");
  if (typeof j.private_key !== "string") throw notKey("has no private_key");
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(j.private_key); } catch { throw notKey("holds a private key that does not open"); }
  if (key.asymmetricKeyType !== "rsa") throw notKey("holds a key that is not an RSA key");
  // Google's keys are 2048 bits; a far larger one would only make the server sign slowly.
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) > GCP_KEY_BITS_MAX) throw notKey(`holds an RSA key larger than ${GCP_KEY_BITS_MAX} bits`);
  const check = p.check ?? "project";
  // mold_v0-319: a project field (validated) reads that project; else the key file's own.
  const projectField = check !== "token" ? await value("project", false) : null;
  const project = projectField ?? (typeof j.project_id === "string" ? j.project_id : "");
  if (projectField !== null && !GCP_PROJECT.test(projectField)) throw new ProbeError("not_ready", "the project is not a Google Cloud project's ID (6 to 30 of a-z, 0-9 and -, starting with a letter)");
  if (check !== "token" && !GCP_PROJECT.test(project)) throw notKey("has no project_id the test can read");
  // The resource's path segments, checked before anything is signed.
  const seg = async (role: string, re: RegExp, what: string) => {
    const v = (await value(role, true))!;
    if (!re.test(v)) throw new ProbeError("not_ready", `the ${role} is not ${what}`);
    return v;
  };
  let resource: { path: string; host: string; what: string } | null = null;
  if (check === "compute_disk") {
    const zone = await seg("zone", GCP_ZONE, "a Google Cloud zone's name (us-central1-a)"), disk = await seg("disk", GCP_NAME, "a disk's name (a lowercase letter, then a-z, 0-9 and -)");
    resource = { host: "compute.googleapis.com", path: `/compute/v1/projects/${encodeURIComponent(project)}/zones/${zone}/disks/${disk}`, what: `disk ${disk} in ${zone}` };
  } else if (check === "filestore_instance") {
    const loc = await seg("location", GCP_LOCATION, "a Google Cloud zone's or region's name (us-central1-a, us-central1)"), inst = await seg("instance", GCP_NAME, "a Filestore instance's name (a lowercase letter, then a-z, 0-9 and -)");
    resource = { host: "file.googleapis.com", path: `/v1/projects/${encodeURIComponent(project)}/locations/${loc}/instances/${inst}`, what: `Filestore instance ${inst} in ${loc}` };
  }
  const kid = typeof j.private_key_id === "string" && /^[a-f0-9]{8,64}$/i.test(j.private_key_id) ? j.private_key_id : null;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: email, scope: GCP_SCOPES[check] ?? GCP_SCOPE, aud: GCP_TOKEN_URI, iat, exp: iat + 300 }, key, kid);
  ctx.secrets.push(assertion, assertion.split(".")[2]!);
  const hosts = KIND_HOSTS.gcp_service_account(check);
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
  const w = await call(ctx, GCP_TOKEN_URI, hosts, "POST", { "content-type": FORM }, body);
  if (!ok2xx(w)) failed(ctx, w, "the service account's key was refused", safeSummary(w.body, ctx.secrets));
  const token = json(w)?.access_token;
  if (typeof token !== "string" || !token) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered ${w.status}, but without the access token this test reads`);
  ctx.secrets.push(token);
  if (check === "token") return `It works: Google Cloud service account ${email} got a read-only token from ${ctx.host} in ${took(ctx)}.`;
  if (resource) {
    const r = await call(ctx, `https://${resource.host}${resource.path}`, hosts, "GET", { authorization: `Bearer ${token}` }, null);
    if (r.status === 404) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered 404: there is no ${resource.what} in project ${project} (or the service account may not see it)`);
    if (!ok2xx(r)) failed(ctx, r, `the service account may not read ${resource.what} in project ${project}`, safeSummary(r.body, ctx.secrets));
    const d = json(r) ?? {};
    if (check === "compute_disk") {
      const size = num(d.sizeGb), state = word(d.status), type = word(typeof d.type === "string" ? d.type.split("/").pop() : null);
      return `It works: Google Cloud ${resource.what}${size !== null ? `, ${size} GB` : ""}${type ? ` ${type}` : ""}${state ? `, ${state}` : ""}, project ${project}, read by ${email} in ${took(ctx)}.`;
    }
    const share = Array.isArray(d.fileShares) ? (d.fileShares[0] as Record<string, unknown> | undefined) : undefined;
    const cap = num(share?.capacityGb), state = word(d.state), tier = word(d.tier);
    return `It works: Google Cloud ${resource.what}${cap !== null ? `, ${cap} GB` : ""}${tier ? ` ${tier}` : ""}${state ? `, ${state}` : ""}, project ${project}, read by ${email} in ${took(ctx)}.`;
  }
  const r = await call(ctx, `https://${hosts[1]}/v1/projects/${encodeURIComponent(project)}`, hosts, "GET", { authorization: `Bearer ${token}` }, null);
  if (!ok2xx(r)) failed(ctx, r, `the service account may not read its project ${project}`, safeSummary(r.body, ctx.secrets));
  const state = json(r)?.lifecycleState;
  return `It works: Google Cloud service account ${email} can read project ${project}${typeof state === "string" && /^[A-Z_]{1,40}$/.test(state) ? ` (${state})` : ""}, in ${took(ctx)}.`;
}

// ---------------------------------------------------------------- azure_client_credentials

/**
 * mold_v0-319: Azure's naming rules for a resource check's path segments: a resource group (1 to 90 of letters, digits,
 * _ . ( ) -, not ending in "."; ASCII only here), a storage account (3 to 24 lowercase letters and digits), a file share
 * (3 to 63 lowercase letters, digits and single hyphens, starting and ending with a letter or digit).
 */
export const AZURE_RESOURCE_GROUP = /^[A-Za-z0-9_.()-]{0,89}[A-Za-z0-9_()-]$/;
export const AZURE_STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
export const AZURE_FILE_SHARE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const AZURE_STORAGE_API = "2023-05-01";

async function azure(p: Extract<SignedProbe, { kind: "azure_client_credentials" }>, value: Reader, ctx: Ctx): Promise<string> {
  const tenant = (await value("tenant_id", true))!.toLowerCase();
  const clientId = (await value("client_id", true))!;
  const secret = (await value("client_secret", true))!;
  const check = p.check ?? "subscription";
  const sub = await value("subscription_id", check !== "subscription");
  if (!GUID.test(tenant) && !HOST_NAME.test(tenant)) throw new ProbeError("not_ready", "the tenant ID is not a directory's ID (a GUID) or its domain (example.onmicrosoft.com)");
  if (!GUID.test(clientId)) throw new ProbeError("not_ready", "the client ID is not an application's ID (a GUID)");
  if (sub !== null && !GUID.test(sub)) throw new ProbeError("not_ready", "the subscription ID is not a subscription's ID (a GUID)");
  // The resource's path segments, checked before anything is sent.
  let resource: { path: string; what: string } | null = null;
  if (check !== "subscription") {
    const rg = (await value("resource_group", true))!, account = (await value("storage_account", true))!;
    if (!AZURE_RESOURCE_GROUP.test(rg)) throw new ProbeError("not_ready", "the resource group is not a resource group's name (letters, digits, _ . ( ) -, not ending in .)");
    if (!AZURE_STORAGE_ACCOUNT.test(account)) throw new ProbeError("not_ready", "the storage account is not a storage account's name (3 to 24 lowercase letters and digits)");
    const base = `/subscriptions/${sub}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Storage/storageAccounts/${account}`;
    if (check === "file_share") {
      const share = (await value("file_share", true))!;
      if (!AZURE_FILE_SHARE.test(share)) throw new ProbeError("not_ready", "the file share is not a file share's name (3 to 63 lowercase letters, digits and single hyphens)");
      resource = { path: `${base}/fileServices/default/shares/${share}`, what: `file share ${share} in storage account ${account}` };
    } else resource = { path: base, what: `storage account ${account} in resource group ${rg}` };
  }
  const hosts = KIND_HOSTS.azure_client_credentials();
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, scope: AZURE_SCOPE, grant_type: "client_credentials" }).toString();
  ctx.secrets.push(encodeURIComponent(secret), body);
  const w = await call(ctx, `https://${hosts[0]}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, hosts, "POST", { "content-type": FORM }, body);
  if (!ok2xx(w)) failed(ctx, w, "the client ID or secret was refused", safeSummary(w.body, ctx.secrets));
  const token = json(w)?.access_token;
  if (typeof token !== "string" || !token) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered ${w.status}, but without the access token this test reads`);
  ctx.secrets.push(token);
  if (resource) {
    const r = await call(ctx, `https://${hosts[1]}${resource.path}?api-version=${AZURE_STORAGE_API}`, hosts, "GET", { authorization: `Bearer ${token}` }, null);
    if (r.status === 404) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered 404: there is no ${resource.what} in subscription …${sub!.slice(-4)} (or the application may not see it)`);
    if (!ok2xx(r)) failed(ctx, r, `the application may not read ${resource.what}`, safeSummary(r.body, ctx.secrets));
    const d = json(r) ?? {}, props = (d.properties ?? {}) as Record<string, unknown>;
    if (check === "file_share") {
      const quota = num(props.shareQuota), proto = word(props.enabledProtocols), tier = word(props.accessTier);
      return `It works: Azure ${resource.what}${quota !== null ? `, ${quota} GB` : ""}${proto ? ` ${proto}` : ""}${tier ? `, ${tier}` : ""}, in ${took(ctx)}.`;
    }
    const loc = word(d.location, /^[a-z0-9]{2,40}$/), kind = word(d.kind), sku = word((d.sku as Record<string, unknown> | undefined)?.name), state = word(props.provisioningState);
    return `It works: Azure ${resource.what}${loc ? `, ${loc}` : ""}${kind ? `, ${kind}` : ""}${sku ? ` ${sku}` : ""}${state ? `, ${state}` : ""}, in ${took(ctx)}.`;
  }
  const r = await call(ctx, `https://${hosts[1]}/subscriptions${sub ? `/${sub}` : ""}?api-version=2022-12-01`, hosts, "GET", { authorization: `Bearer ${token}` }, null);
  if (!ok2xx(r)) failed(ctx, r, sub ? "the application may not read this subscription" : "the application may not list subscriptions", safeSummary(r.body, ctx.secrets));
  const j = json(r);
  if (sub) {
    const name = typeof j?.displayName === "string" ? cleanWords(j.displayName, ctx.secrets) : null;
    const state = typeof j?.state === "string" && /^[A-Za-z]{1,30}$/.test(j.state) ? j.state : null;
    return `It works: the application signed in to Azure and can read subscription ${name && name.length <= 60 ? `"${name}"` : "…" + sub.slice(-4)}${state ? ` (${state})` : ""}, in ${took(ctx)}.`;
  }
  const n = Array.isArray(j?.value) ? (j!.value as unknown[]).length : 0;
  return `It works: the application signed in to Azure and can see ${n} subscription${n === 1 ? "" : "s"}, in ${took(ctx)}.`;
}

// ---------------------------------------------------------------- postgres

export interface PgTarget { host: string; port: number; user: string; password: string; database: string }
/**
 * A postgres:// (or postgresql://) address's parts, parsed here (never by the client library, whose parser reads
 * certificate files and other options from the address): its query is ignored (TLS is always required), one host only.
 * Null when it is not one.
 */
export function parsePostgresUrl(raw: string): PgTarget | null {
  if (!/^postgres(ql)?:\/\//i.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  let user: string, password: string, database: string;
  try { user = decodeURIComponent(u.username); password = decodeURIComponent(u.password); database = decodeURIComponent(u.pathname.replace(/^\//, "")); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const port = u.port ? Number(u.port) : POSTGRES_DEFAULT_PORT;
  if (!host || !Number.isInteger(port)) return null;
  return { host, port, user, password, database: database || "postgres" };
}

let pgStandin: { port: number; ca: string } | null = null;
/** Tests only: connect every database test to 127.0.0.1:<port>, trusting `ca` (honoured only in a test world, with the stand-in on). */
export function setPostgresStandinForTest(s: { port: number; ca: string } | null) { pgStandin = s; }
const pgStandinActive = () => (pgStandin && standin() ? pgStandin : null);
/** Tests only: the client options a database test would use for `name` (never a password), with a named bundle. */
export const pgTlsOptionsForTest = (name: string, bundle?: string) => tlsOptions(name, bundle ? caBundle(bundle) : null);

/**
 * mold_v0-319: the managed providers' public CA bundles, shipped as files in src/ca/ (public certificates, not secrets),
 * read once. Each is a provider's own roots for its database servers only (the probe's hosts are under its zones:
 * src/connection-test-config.ts PG_CA_ZONES):
 *   aws-rds  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, as fetched 2026-11-18 (114 CA
 *            certificates; SHA-256 of the file 90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b)
 *   azure    DigiCert Global Root G2, DigiCert Global Root CA, Microsoft RSA Root Certificate Authority 2017 (from
 *            cacerts.digicert.com and microsoft.com/pkiops; each one's SHA-256 fingerprint in the file)
 */
const CA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ca");
const caCache = new Map<string, string[]>();
const testBundles = new Map<string, string[]>();
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
/** A bundle's certificates (each one PEM block; anything else in the file, its comments, left out). */
export const pemCertificates = (text: string) => [...text.matchAll(PEM_BLOCK)].map((m) => `${m[0].replace(/\r/g, "")}\n`);
/** The certificates of a shipped bundle by name (a test world's registered ones first); null when there is none. */
export function caBundle(name: string): string[] | null {
  if (standin() && testBundles.has(name)) return testBundles.get(name)!;
  if (!(PG_CA_BUNDLES as readonly string[]).includes(name)) return null;
  let certs = caCache.get(name);
  if (!certs) {
    try { certs = pemCertificates(readFileSync(path.join(CA_DIR, `${name}.pem`), "utf8")); } catch { certs = []; }
    caCache.set(name, certs);
  }
  return certs.length ? certs : null;
}
/** Tests only: a named bundle (a throwaway CA made at run time), honoured only in a test world with the stand-in on. */
export function registerCaBundleForTest(name: string, pem: string | null) { if (pem === null) testBundles.delete(name); else testBundles.set(name, pemCertificates(pem)); }

function tlsOptions(name: string, extra: string[] | null = null): tls.ConnectionOptions {
  const sub = pgStandinActive();
  const ca = sub ? [sub.ca, ...(extra ?? [])] : (() => {
    const get = (tls as { getCACertificates?: (t: string) => string[] }).getCACertificates;
    try { return get ? [...new Set([...get("default"), ...get("system"), ...(extra ?? [])])] : extra ? [...tls.rootCertificates, ...extra] : undefined; } catch { return extra ? [...tls.rootCertificates, ...extra] : undefined; }
  })();
  return { rejectUnauthorized: true, servername: name, ...(ca ? { ca } : {}), checkServerIdentity: (_h, cert) => tls.checkServerIdentity(name, cert) };
}

async function postgres(p: Extract<SignedProbe, { kind: "postgres" }>, value: Reader, ctx: Ctx): Promise<string> {
  let t: PgTarget;
  if (p.fields.url) {
    const raw = (await value("url", true))!;
    const parsed = parsePostgresUrl(raw);
    if (!parsed) throw new ProbeError("not_ready", "the connection address is not a postgres:// address (postgres://user:password@host:5432/database)");
    t = parsed;
  } else {
    let host = (await value("host", true))!;
    if (/^[a-z]+:\/\//i.test(host)) { try { host = new URL(host).hostname; } catch { throw new ProbeError("not_ready", "the database's host is not a host's name"); } }
    const port = await value("port", false);
    t = { host: host.toLowerCase().replace(/\.$/, ""), port: port === null ? POSTGRES_DEFAULT_PORT : Number(port), user: (await value("user", true))!,
      password: (await value("password", true))!, database: (await value("database", false)) ?? "postgres" };
  }
  if (t.password) ctx.secrets.push(t.password, encodeURIComponent(t.password));
  const label = ctx.label;
  ctx.host = t.host;
  if (!t.user) throw new ProbeError("not_ready", "the connection names no user");
  if (!t.password) throw new ProbeError("not_ready", "the connection has no password");
  if (t.password.length < SECRET_MIN) throw new ProbeError("not_ready", `the password is too short to be a secret (at least ${SECRET_MIN} characters): add it again`);
  for (const [what, v] of [["user", t.user], ["database", t.database], ["password", t.password]] as const)
    if (noBreaks.test(v) || v.length > 512) throw new ProbeError("not_ready", `the ${what} holds a character or a length a database connection cannot carry`);
  // The host: a public name on the probe's list, on one of its ports; every address public; the connection pinned.
  const ports = p.ports ?? [POSTGRES_DEFAULT_PORT];
  if (net.isIP(t.host.replace(/^\[|\]$/g, ""))) throw new ProbeError("private_address", `${t.host} is an address, not a name: a test connects to a public host by its name`);
  if (!HOST_NAME.test(t.host)) throw new ProbeError("not_ready", "the database's host is not a host's name");
  if (localName(t.host)) throw new ProbeError("private_address", `${t.host} is a private or internal address, and a test only calls public ones`);
  if (!hostListed(t.host, p.hosts)) throw new ProbeError("private_address", `${t.host} is not one of the hosts this test may call (${p.hosts.join(", ")})`);
  if (!Number.isInteger(t.port) || !ports.includes(t.port)) throw new ProbeError("private_address", `${t.host} on port ${Number.isFinite(t.port) ? t.port : "?"}: this test connects on port ${ports.join(" or ")} only`);
  // mold_v0-319: a named provider bundle, trusted besides the stores; a name the mold does not ship is said in words.
  const extraCa = p.ca ? caBundle(p.ca) : null;
  if (p.ca && !extraCa) throw new ProbeError("not_ready", `this app has no CA bundle named ${JSON.stringify(String(p.ca).slice(0, 40))}`);
  const ownDb = OWN_DATABASE_ENV.flatMap((n) => { const x = process.env[n]; try { return x ? [new URL(x).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")] : []; } catch { return []; } });
  const own = [...ownHosts(), ...ownDb];
  if (own.includes(t.host)) throw new ProbeError("private_address", `${t.host} is this app's own address: a test connects to another service`);
  const sub = pgStandinActive();
  let address: string;
  try {
    const addrs = await resolveHost(t.host);
    if (!addrs.length) throw new Error("none");
    if (addrs.some(privateAddress)) throw new ProbeError("private_address", `${t.host} is a private or internal address, and a test only calls public ones`);
    // The app's own database by its addresses too (another name for the same server).
    if (await sharesAddress(addrs, ownDb)) throw new ProbeError("private_address", `${t.host} is this app's own database: a test connects to another service`);
    address = addrs[0]!;
  } catch (e) {
    if (e instanceof ProbeError) throw e;
    if (!sub) throw new ProbeError("unreachable", `${t.host} could not be reached over TLS`);
    address = "127.0.0.1";
  }
  const { default: pg } = await import("pg");
  const left = ctx.deadline - Date.now();
  const timeoutWords = `${label} at ${t.host} did not answer within ${ctx.seconds} second${ctx.seconds === 1 ? "" : "s"}`;
  const client = new pg.Client({
    host: sub ? "127.0.0.1" : address, port: sub ? sub.port : t.port, user: t.user, password: t.password, database: t.database,
    ssl: tlsOptions(t.host, extraCa), application_name: "connection-test", keepAlive: false,
    connectionTimeoutMillis: Math.max(1, left), query_timeout: Math.min(PG_STATEMENT_MS, Math.max(1, left)),
  } as import("pg").ClientConfig);
  client.on("error", () => { /* read through the awaited calls below; never logged */ });
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    // Inside the transaction (a startup parameter is refused by transaction-mode poolers such as PgBouncer).
    await client.query(`SET LOCAL statement_timeout = '${PG_STATEMENT_MS / 1000}s'`);
    const r = await client.query("SELECT 1 AS ok");
    await client.query("ROLLBACK");
    return r.rows?.[0]?.ok;
  };
  try {
    const ok = await Promise.race([run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ProbeError("timeout", timeoutWords)), Math.max(1, left)); })]);
    if (Number(ok) !== 1) throw new ProbeError("unexpected", `${label} at ${t.host} answered, but SELECT 1 did not return 1`);
    return `It works: ${label} at ${t.host} answered SELECT 1 over TLS in ${took(ctx)}.`;
  } catch (e) {
    if (e instanceof ProbeError) throw e;
    throw pgError(e, t.host, label, timeoutWords, ctx);
  } finally {
    clearTimeout(timer);
    await closeNow(client);
  }
}
/**
 * Close without waiting on the server: end() is given at most PG_CLOSE_MS (a server that half-closes never finishes
 * it), then the socket is destroyed whatever happened.
 */
export const PG_CLOSE_MS = 500;
async function closeNow(client: import("pg").Client) {
  let t: NodeJS.Timeout | undefined;
  await Promise.race([client.end().catch(() => {}), new Promise<void>((r) => { t = setTimeout(r, PG_CLOSE_MS); })]);
  clearTimeout(t);
  try { (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.(); } catch { /* already gone */ }
}
/** The environment names of this app's own database addresses (a database test never connects to it). */
export const OWN_DATABASE_ENV = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_PRISMA_URL"];
/** Whether any of `addrs` is an address one of `hosts` resolves to (a host that does not resolve shares none). */
async function sharesAddress(addrs: readonly string[], hosts: readonly string[]): Promise<boolean> {
  const mine = new Set(addrs.map((a) => a.toLowerCase()));
  for (const h of hosts) {
    const list = net.isIP(h) ? [h] : await resolveHost(h).catch(() => [] as string[]);
    if (list.some((a) => mine.has(a.toLowerCase()))) return true;
  }
  return false;
}
/** A database error in words: its SQLSTATE code only, never its text (it may echo a value). */
function pgError(e: unknown, host: string, label: string, timeoutWords: string, ctx: Ctx): ProbeError {
  const code = (e as { code?: unknown }).code;
  const msg = String((e as { message?: unknown }).message ?? "");
  if (msg === "The server does not support SSL connections") return new ProbeError("unexpected", `${label} at ${host} does not accept TLS connections, and this test connects over TLS only`);
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    if (code === "28P01" || code === "28000") return new ProbeError("refused", `${label} at ${host} refused the user name or password`);
    if (code === "3D000") return new ProbeError("unexpected", `${label} at ${host} has no database by the name the connection gives`);
    if (code === "57014") return new ProbeError("timeout", timeoutWords);
    if (code === "53300") return new ProbeError("unexpected", `${label} at ${host} has no connection free just now`);
    return new ProbeError("unexpected", `${label} at ${host} answered with error ${code}`);
  }
  if (/timeout/i.test(msg) || Date.now() >= ctx.deadline) return new ProbeError("timeout", timeoutWords);
  return new ProbeError("unreachable", `${host} could not be reached over TLS`);
}
