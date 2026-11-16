/**
 * Test connection's signed kinds (mold_v0-313; the probe's `kind`, declared in pack config: src/connection-test-config.ts;
 * the HTTP probe of mold_v0-312 is src/connection-test.ts, which calls runSignedProbe for every other kind). Each kind's
 * hosts, call and signing are fixed here; the record gives only the values of the roles its pack names.
 *
 *   aws_sigv4                  POST https://sts.amazonaws.com/ (or sts.<region>.amazonaws.com) GetCallerIdentity, signed
 *                              with Signature Version 4 (node:crypto, no SDK). "It works: AWS account ending …1234 (Alice)"
 *                              (the account's last 4 digits and the ARN's last segment only).
 *   gcp_service_account        the key file's token_uri must be https://oauth2.googleapis.com/token exactly (a crafted one
 *                              never receives the signed assertion); an RS256 assertion for a read-only scope exchanged
 *                              there, then (check "project") GET cloudresourcemanager.googleapis.com/v1/projects/<id>.
 *   azure_client_credentials   POST login.microsoftonline.com/<tenant>/oauth2/v2.0/token (client credentials, the
 *                              management scope), then GET management.azure.com/subscriptions[/<id>] (read-only).
 *   postgres                   TLS only (the server's certificate checked against the host's name, the bundled and the
 *                              system's CAs), the host one of the probe's `hosts` resolving to public addresses only, the
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
import net from "node:net";
import tls from "node:tls";
import { AWS_REGION, GCP_TOKEN_URI, hostListed, KIND_HOSTS, localName, POSTGRES_DEFAULT_PORT, PROBE_TIMEOUT_DEFAULT, type SignedProbe } from "./connection-test-config.js";
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
        : p.kind === "azure_client_credentials" ? await azure(value, ctx)
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

/** One HTTPS call of a kind: the address checked (the kind's hosts only), no redirect followed. */
async function call(ctx: Ctx, url: string, allowed: readonly string[], method: "GET" | "POST", headers: Record<string, string>, body: string | null): Promise<Wire> {
  const u = new URL(url);
  ctx.host = u.hostname;
  await checkAddress(u, allowed);
  const w = await send(u, method, headers, body, ctx.deadline, `${ctx.label} at ${u.hostname} did not answer within ${ctx.seconds} second${ctx.seconds === 1 ? "" : "s"}`);
  ctx.status = w.status;
  if (w.status >= 300 && w.status < 400) throw new ProbeError("unexpected", `${ctx.label} at ${u.hostname} answered ${w.status}: it sent the test elsewhere, and this test does not follow it`);
  return w;
}
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

async function aws(p: Extract<SignedProbe, { kind: "aws_sigv4" }>, value: Reader, ctx: Ctx): Promise<string> {
  const accessKeyId = (await value("access_key_id", true))!;
  ctx.secrets.push(accessKeyId); // a plain key id is still never repeated in the answer
  const secretAccessKey = (await value("secret_access_key", true))!;
  const sessionToken = await value("session_token", false);
  const region = p.region ?? (await value("region", false));
  if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) throw new ProbeError("not_ready", "the access key ID is not an AWS access key ID (capital letters and digits)");
  if (region !== null && !AWS_REGION.test(region)) throw new ProbeError("not_ready", `"${cleanWords(region, ctx.secrets) ?? "the region"}" is not an AWS region's name (eu-west-1)`);
  if (sessionToken && !/^[\x21-\x7e]+$/.test(sessionToken)) throw new ProbeError("not_ready", "the session token holds a character a header cannot carry");
  if (!/^[\x21-\x7e]+$/.test(secretAccessKey)) throw new ProbeError("not_ready", "the secret access key holds a character it cannot hold");
  const host = KIND_HOSTS.aws_sigv4(region)[0]!;
  const body = "Action=GetCallerIdentity&Version=2011-06-15";
  const s = sigv4({ method: "POST", host, path: "/", query: "", headers: { "content-type": FORM }, body, region: region ?? "us-east-1", service: "sts",
    accessKeyId, secretAccessKey, sessionToken, now: new Date() });
  ctx.secrets.push(s.signature, s.headers.authorization!);
  const w = await call(ctx, `https://${host}/`, [host], "POST", { ...s.headers, accept: "text/xml" }, body);
  const xml = w.body.toString("utf8");
  if (!ok2xx(w)) {
    const code = xmlTag(xml, "Code"), msg = xmlTag(xml, "Message");
    const said = msg ? cleanWords(`${code && /^[A-Za-z.]{1,64}$/.test(code) ? `${code}: ` : ""}${msg}`, ctx.secrets) : safeSummary(w.body, ctx.secrets);
    failed(ctx, w, "the keys were refused", said);
  }
  const account = xmlTag(xml, "Account"), arn = xmlTag(xml, "Arn");
  if (!account || !/^\d{12}$/.test(account)) throw new ProbeError("unexpected", `${ctx.label} at ${host} answered ${w.status}, but not with the caller's identity this test reads`);
  const last = arn?.split(/[:/]/).pop() ?? "";
  return `It works: AWS account ending …${account.slice(-4)}${/^[\w+=,.@-]{1,64}$/.test(last) ? ` (${last})` : ""}, answered by ${host} in ${took(ctx)}.`;
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
  const project = typeof j.project_id === "string" ? j.project_id : "";
  const check = p.check ?? "project";
  if (check === "project" && !GCP_PROJECT.test(project)) throw notKey("has no project_id the test can read");
  const kid = typeof j.private_key_id === "string" && /^[a-f0-9]{8,64}$/i.test(j.private_key_id) ? j.private_key_id : null;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: email, scope: GCP_SCOPE, aud: GCP_TOKEN_URI, iat, exp: iat + 300 }, key, kid);
  ctx.secrets.push(assertion, assertion.split(".")[2]!);
  const hosts = KIND_HOSTS.gcp_service_account();
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
  const w = await call(ctx, GCP_TOKEN_URI, hosts, "POST", { "content-type": FORM }, body);
  if (!ok2xx(w)) failed(ctx, w, "the service account's key was refused", safeSummary(w.body, ctx.secrets));
  const token = json(w)?.access_token;
  if (typeof token !== "string" || !token) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered ${w.status}, but without the access token this test reads`);
  ctx.secrets.push(token);
  if (check === "token") return `It works: Google Cloud service account ${email} got a read-only token from ${ctx.host} in ${took(ctx)}.`;
  const r = await call(ctx, `https://${hosts[1]}/v1/projects/${encodeURIComponent(project)}`, hosts, "GET", { authorization: `Bearer ${token}` }, null);
  if (!ok2xx(r)) failed(ctx, r, `the service account may not read its project ${project}`, safeSummary(r.body, ctx.secrets));
  const state = json(r)?.lifecycleState;
  return `It works: Google Cloud service account ${email} can read project ${project}${typeof state === "string" && /^[A-Z_]{1,40}$/.test(state) ? ` (${state})` : ""}, in ${took(ctx)}.`;
}

// ---------------------------------------------------------------- azure_client_credentials

async function azure(value: Reader, ctx: Ctx): Promise<string> {
  const tenant = (await value("tenant_id", true))!.toLowerCase();
  const clientId = (await value("client_id", true))!;
  const secret = (await value("client_secret", true))!;
  const sub = await value("subscription_id", false);
  if (!GUID.test(tenant) && !HOST_NAME.test(tenant)) throw new ProbeError("not_ready", "the tenant ID is not a directory's ID (a GUID) or its domain (example.onmicrosoft.com)");
  if (!GUID.test(clientId)) throw new ProbeError("not_ready", "the client ID is not an application's ID (a GUID)");
  if (sub !== null && !GUID.test(sub)) throw new ProbeError("not_ready", "the subscription ID is not a subscription's ID (a GUID)");
  const hosts = KIND_HOSTS.azure_client_credentials();
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, scope: AZURE_SCOPE, grant_type: "client_credentials" }).toString();
  ctx.secrets.push(encodeURIComponent(secret), body);
  const w = await call(ctx, `https://${hosts[0]}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, hosts, "POST", { "content-type": FORM }, body);
  if (!ok2xx(w)) failed(ctx, w, "the client ID or secret was refused", safeSummary(w.body, ctx.secrets));
  const token = json(w)?.access_token;
  if (typeof token !== "string" || !token) throw new ProbeError("unexpected", `${ctx.label} at ${ctx.host} answered ${w.status}, but without the access token this test reads`);
  ctx.secrets.push(token);
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
/** Tests only: the client options a database test would use for `name` at `address` (never a password). */
export const pgTlsOptionsForTest = (name: string) => tlsOptions(name);

function tlsOptions(name: string): tls.ConnectionOptions {
  const sub = pgStandinActive();
  const ca = sub ? [sub.ca] : (() => {
    const get = (tls as { getCACertificates?: (t: string) => string[] }).getCACertificates;
    try { return get ? [...new Set([...get("default"), ...get("system")])] : undefined; } catch { return undefined; }
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
    ssl: tlsOptions(t.host), application_name: "connection-test", keepAlive: false,
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
