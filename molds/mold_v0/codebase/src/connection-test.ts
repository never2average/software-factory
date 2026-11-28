/**
 * A record page's "Test connection" (mold_v0-312; the page action `test_connection`, its probe declared in pack config:
 * src/connection-test-config.ts). A workspace's own connection record (an account at a compute provider, a network, a
 * database or another system of record) is checked by one HTTPS call, on the server, with the record's own fields.
 *
 *   the call     the probe the record's `by` value chooses ("*" otherwise): its address and body filled from the
 *                record's plain fields (escaped for the address), its headers from any field, an encrypted one opened
 *                here only (src/encrypted-fields.ts decryptValue, under the workspace's own key) and only for a header
 *   the wire     https only, no user or password; the host is never an address or an internal name, its name is
 *                resolved here and every address checked (src/egress-hosts.ts privateAddress: never private, loopback,
 *                link-local, the cloud metadata address, reserved or multicast), and the connection goes to the checked
 *                address (no second lookup to rebind). At most 3 redirects, each checked as the first address; one to
 *                another host drops the headers that carry a secret. timeout_seconds in all (at most 15). No cookie.
 *   the answer   in plain words ("It works: the account's API at api.example.com answered 200 in 340 ms" / "It does not
 *                work yet: ... answered 401: the token was refused"); never a secret, never the answer's body beyond a
 *                short summary of its own error message, with any secret and anything shaped like a token cut out. The
 *                address's path is never returned (it may hold an account's id): only its host.
 *   the record   the probe's status (working or failing; mold_v0-332: could not test, needs its key) and tested date (and
 *                the declared tested_at, result, failing_since and failures: src/connection-test-health.ts), written as the app's own action
 *                (src/record-areas.ts asAction: fields set_by "action"), through the record store (its history and data
 *                trail say what changed: never a secret). The record's read is the person's (its own trail line).
 *
 * mold_v0-313: a probe with a `kind` other than "http" (aws_sigv4, gcp_service_account, azure_client_credentials,
 * postgres) is made by src/connection-test-signed.ts, through this file's host check, wire and words (mold_v0-319: a
 * signed kind's `check` may read one resource: a volume, a file system, a bucket, a disk, a storage account, a share).
 *
 * Tests and the lane world only (never in production): APP_CONNECTION_TEST_STANDIN=http://127.0.0.1:<port> sends every
 * call that passed the checks to that address instead (`/<host><path>`), so a fixture stands in for the real service.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ANY_PROBE, hostListed, isHttpProbe, localName, placeholders, PLACEHOLDER, PROBE_TIMEOUT_DEFAULT, probeHosts, probeSecrets, type ConnectionProbe, type ConnectionTest } from "./connection-test-config.js";
import { asTestOf, testOutcome } from "./connection-test-health.js";
import { privateAddress } from "./egress-hosts.js";
import { ENV } from "./env-names.js";
import { PackError } from "./pack-api.js";

const MAX_REDIRECTS = 3;
const BODY_MAX = 64 * 1024;
const SUMMARY_MAX = 120;

export type ConnectionOutcome = "working" | "refused" | "unexpected" | "timeout" | "unreachable" | "private_address" | "not_ready";
/** What the Test answers: whether it works, in one sentence, and what can be said safely (never a secret or a path). */
export interface ConnectionTestAnswer { ok: boolean; outcome: ConnectionOutcome; words: string; host: string | null; status: number | null; ms: number; probe: string | null }

/** A probe's failure in words (exported for src/connection-test-signed.ts). */
export class ProbeError extends Error { constructor(readonly outcome: ConnectionOutcome, message: string) { super(message); } }

// ---------------------------------------------------------------- the host check

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (h) => (await dns.promises.lookup(h, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = systemResolver;
/** Tests only: how names resolve (null: the system's). */
export function setResolverForTest(r: Resolver | null) { resolver = r ?? systemResolver; }

/**
 * The stand-in address (tests): honoured only in a test world (APP_TEST_WORLD=1, set by scripts/lib/test-world.ts),
 * never in production, and only on 127.0.0.1.
 */
/**
 * mold_v0-348: a test world (APP_TEST_WORLD=1: the lanes, the console's renders, the scripts) never calls a real service:
 * without a stand-in a connection's Test answers that it was not tested here. Production never sets it.
 */
export const TEST_WORLD_WORDS = "It wasn't tested: this is a test world, which never calls a real service.";
export const testWorldWithoutStandin = (): boolean => ENV.APP_TEST_WORLD === "1" && !standin();

export function standin(): string | null {
  const v = ENV.APP_CONNECTION_TEST_STANDIN;
  if (!v || process.env.NODE_ENV === "production" || ENV.APP_TEST_WORLD !== "1") return null;
  try { const u = new URL(v); return u.protocol === "http:" && u.hostname === "127.0.0.1" ? v.replace(/\/$/, "") : null; } catch { return null; }
}

/**
 * Whether `u` may be called: https, no user or password, a public host by its name whose every address is public.
 * Throws ProbeError in words (never the path). A name that does not resolve is refused as unreachable, except in front
 * of the stand-in (its fixture's names are not real).
 */
export async function checkAddress(u: URL, allowed?: readonly string[]): Promise<void> {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (u.protocol !== "https:") throw new ProbeError("private_address", `${host || "the address"} is not an https:// address, and a test calls https only`);
  if (u.username || u.password) throw new ProbeError("private_address", "the address carries a user or password: a secret goes in a header");
  if (u.port && u.port !== "443") throw new ProbeError("private_address", `${host} on port ${u.port}: a test calls port 443 only`);
  if (net.isIP(host)) throw new ProbeError("private_address", `${host} is an address, not a name: a test calls a public host by its name`);
  if (localName(host)) throw new ProbeError("private_address", `${host} is a private or internal address, and a test only calls public ones`);
  if (ownHosts().includes(host)) throw new ProbeError("private_address", `${host} is this app's own address: a test calls another service`);
  // mold_v0-312: only the hosts the probe names (its address's own, its `hosts`), on every hop: a record never sends
  // a secret elsewhere by holding another address.
  if (allowed && !hostListed(host, allowed)) throw new ProbeError("private_address", `${host} is not one of the hosts this test may call (${allowed.join(", ")})`);
  let addrs: string[];
  try { addrs = await resolver(host); }
  catch {
    if (standin()) return;
    throw new ProbeError("unreachable", unreachable(host));
  }
  if (!addrs.length) throw new ProbeError("unreachable", unreachable(host));
  if (addrs.some(privateAddress)) throw new ProbeError("private_address", `${host} is a private or internal address, and a test only calls public ones`);
}

/** One message for every network failure (a refused port, a missing name, a bad certificate look the same). */
export const unreachable = (host: string) => `${host} could not be reached over https`;
/** This app's own hosts (its public address, the gateway's, the run API's): never a test's to call. */
export const ownHosts = () => [process.env.PUBLIC_URL, ENV.APP_GATEWAY_URL, ENV.APP_RUN_API_URL].flatMap((x) => {
  try { return x ? [new URL(x).hostname.toLowerCase().replace(/\.+$/, "")] : []; } catch { return []; }
});

/** Every address `host` resolves to (the resolver tests set; exported for src/connection-test-signed.ts). */
export const resolveHost = (host: string) => resolver(host);

/** A lookup that answers only public addresses (the connection uses the address checked here: no rebinding). */
const publicLookup: net.LookupFunction = (hostname, options, cb) => {
  resolver(hostname).then((list) => {
    if (!list.length || list.some(privateAddress)) return void (cb as (e: Error | null, a: string, f: number) => void)(Object.assign(new Error("private address"), { code: "EPRIVATE" }), "", 4);
    const all = list.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
    if ((options as { all?: boolean }).all) return void (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, all);
    (cb as (e: null, a: string, f: number) => void)(null, all[0]!.address, all[0]!.family);
  }, (e) => (cb as (e: Error | null, a: string, f: number) => void)(e as Error, "", 4));
};

// ---------------------------------------------------------------- the templates

/** The record's values a probe reads: plain fields as stored; `open(field)` opens an encrypted one (headers only). */
export interface ProbeValues { plain: Record<string, unknown>; sealed: Set<string>; open: (field: string) => Promise<string>; label: (field: string) => string }

export const asText = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
export const noBreaks = /[\u0000-\u001f\u007f]/;

/** A secret shorter than this is refused: redaction could not tell it from ordinary words. */
export const SECRET_MIN = 8;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
async function fill(t: string, vals: ProbeValues, mode: "url" | "header" | "body", secrets: string[]): Promise<string> {
  let out = "", last = 0, first = true;
  // The host part of an address the pack wrote ("https://{account}.api.example.com/..."): its placeholders are labels.
  const hostEnd = mode === "url" && !t.startsWith("{") ? (() => { const i = t.slice(8).search(/[/?#]/); return i < 0 ? t.length : i + 8; })() : -1;
  for (const m of t.matchAll(PLACEHOLDER)) {
    const n = m[1]!;
    let v: string;
    if (vals.sealed.has(n)) {
      if (mode !== "header") throw new ProbeError("not_ready", `${vals.label(n)} is a secret: this test's setup uses it outside a header`);
      v = await vals.open(n);
      if (v) secrets.push(v);
      if (v && v.length < SECRET_MIN) throw new ProbeError("not_ready", `${vals.label(n)} is too short to be a secret (at least ${SECRET_MIN} characters): add it again`);
    } else v = asText(vals.plain[n]);
    if (mode === "url" && first && m.index === 0) v = v.replace(/\/+$/, ""); // "{endpoint}/v1", the endpoint ending in /
    if (!v) throw new ProbeError("not_ready", `${vals.label(n)} is empty`);
    if (noBreaks.test(v)) throw new ProbeError("not_ready", `${vals.label(n)} holds a line break or a control character`);
    if (mode === "header" && !HEADER_VALUE.test(v)) throw new ProbeError("not_ready", `${vals.label(n)} holds a character a header cannot carry (letters, digits and punctuation only)`);
    if (mode === "url" && !(first && m.index === 0)) {
      // A value never climbs the address: no "." or ".." segment; in the host, one plain label.
      if (v === "." || v === "..") throw new ProbeError("not_ready", `${vals.label(n)} is not a value an address takes`);
      if (m.index! < hostEnd && !DNS_LABEL.test(v)) throw new ProbeError("not_ready", `${vals.label(n)} is not one part of a host's name (letters, digits and -)`);
    }
    out += t.slice(last, m.index) + (mode === "url" && !(first && m.index === 0) ? encodeURIComponent(v) : v);
    last = m.index! + m[0].length;
    first = false;
  }
  return out + t.slice(last);
}
async function fillBody(v: unknown, vals: ProbeValues, secrets: string[]): Promise<unknown> {
  if (typeof v === "string") {
    const whole = /^\{([a-z][a-z0-9_]{1,62})\}$/.exec(v);
    if (whole && !vals.sealed.has(whole[1]!)) {
      const x = vals.plain[whole[1]!];
      if (x === undefined || x === null || x === "") throw new ProbeError("not_ready", `${vals.label(whole[1]!)} is empty`);
      return typeof x === "number" || typeof x === "boolean" ? x : asText(x);
    }
    return fill(v, vals, "body", secrets);
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => fillBody(x, vals, secrets)));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[await fill(k, vals, "body", secrets)] = await fillBody(x, vals, secrets);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------- the words

/**
 * A short, safe line of what the service said: its own error message, secrets and token-shaped strings cut out.
 * mold_v0-326: an answer in plain text (`contentType` text/plain, as git's server answers a refused push) gives its
 * first line.
 */
export function safeSummary(body: Buffer, secrets: readonly string[], contentType?: string): string | null {
  let j: unknown;
  try { j = JSON.parse(body.toString("utf8")); } catch {
    if (mediaType(contentType) !== "text/plain") return null;
    const line = body.toString("utf8").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return line ? cleanWords(line, secrets) : null;
  }
  const pick = (o: unknown): unknown => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return Array.isArray(o) ? pick(o[0]) : null;
    const r = o as Record<string, unknown>;
    for (const k of ["message", "error_description", "detail", "title", "error", "errors", "reason"]) {
      const v = r[k];
      if (typeof v === "string" && v.trim()) return v;
      if (v && typeof v === "object") { const x = pick(v); if (typeof x === "string") return x; }
    }
    return null;
  };
  const s = pick(j);
  return typeof s === "string" ? cleanWords(s, secrets) : null;
}
/** A Content-Type's media type, lower case, without its parameters ("text/plain; charset=UTF-8" is "text/plain"). */
export const mediaType = (v: string | undefined) => (v ?? "").split(";")[0]!.trim().toLowerCase();
/** mold_v0-326: a secret as an answer may echo it: itself, escaped for an address, and base64 encoded (longest first). */
export const secretForms = (x: string) => [...new Set([x, encodeURIComponent(x), Buffer.from(x, "utf8").toString("base64"), Buffer.from(x, "utf8").toString("base64").replace(/=+$/, "")])]
  .sort((a, b) => b.length - a.length);
const cutSecrets = (t: string, secrets: readonly string[]) =>
  secrets.filter((x) => x.length >= 4).flatMap(secretForms).sort((a, b) => b.length - a.length).reduce((w, f) => w.split(f).join("…"), t);
export function cleanWords(s: string, secrets: readonly string[]): string | null {
  let t = cutSecrets(s, secrets);
  t = t.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "…").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").replace(/[{}<>]/g, "").trim();
  if (!t) return null;
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
}
const STATUS_WORDS: Record<number, string> = {
  400: "the request was not accepted: the token, or a field this test uses, is probably wrong", 401: "the token was refused", 403: "the token is not allowed to do this",
  404: "nothing was found there (check the address and the account it names)", 405: "the service does not take this kind of request there",
  407: "a proxy asked for a sign-in", 408: "it took too long", 409: "the service refused it in its current state", 410: "it is no longer there",
  422: "the service could not use what was sent", 429: "too many requests: try again in a minute", 502: "the service's gateway had a problem",
  503: "the service is unavailable just now", 504: "the service's gateway took too long",
};
export const statusWords = (s: number) => STATUS_WORDS[s] ?? (s >= 500 ? "the service had a problem on its side" : s >= 300 && s < 400 ? "it sent the test elsewhere" : "that is not the answer this test expects");

/** The value at a dotted path of a JSON value (a list's position by its number); undefined when there is none. */
export function atPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const p of path.split(".")) {
    if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
    else if (cur && typeof cur === "object" && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, p)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

// ---------------------------------------------------------------- the call

/** An answer: its status, where a redirect points, its body (at most 64 KB), and (mold_v0-319) its one-value headers. */
export interface Wire { status: number; location: string | null; body: Buffer; headers: Record<string, string> }
export function send(u: URL, method: string, headers: Record<string, string>, body: string | null, deadline: number, timeoutWords: string): Promise<Wire> {
  const sub = standin();
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new ProbeError("timeout", timeoutWords));
    const h: Record<string, string> = { "user-agent": "connection-test/1", accept: "application/json, */*;q=0.5", "accept-encoding": "identity", ...headers };
    if (body !== null) { h["content-type"] ??= "application/json"; h["content-length"] = String(Buffer.byteLength(body)); }
    const opts = { method, headers: h, timeout: left };
    const req = sub
      ? http.request(`${sub}/${u.host}${u.pathname}${u.search}`, { ...opts, agent: false }) // never a kept-alive socket the stand-in may close
      : https.request(u, { ...opts, lookup: publicLookup, agent: false });
    let done = false;
    const finish = (f: () => void) => { if (!done) { done = true; clearTimeout(timer); f(); } };
    const timer = setTimeout(() => req.destroy(new ProbeError("timeout", timeoutWords)), left);
    req.on("timeout", () => req.destroy(new ProbeError("timeout", timeoutWords)));
    req.on("error", (e) => finish(() => {
      if (e instanceof ProbeError) return reject(e);
      const code = (e as { code?: string }).code ?? "";
      if (code === "EPRIVATE") return reject(new ProbeError("private_address", `${u.hostname} is a private or internal address, and a test only calls public ones`));
      void code;
      reject(new ProbeError("unreachable", unreachable(u.hostname)));
    }));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      const chunks: Buffer[] = [];
      let got = 0;
      const headers = Object.fromEntries(Object.entries(res.headers).filter((e): e is [string, string] => typeof e[1] === "string"));
      const end = () => finish(() => { req.destroy(); resolve({ status, location, body: Buffer.concat(chunks), headers }); });
      if (method === "HEAD" || (status >= 300 && status < 400)) { res.resume(); return end(); }
      res.on("data", (c: Buffer) => {
        if (got >= BODY_MAX) return;
        chunks.push(c.subarray(0, BODY_MAX - got)); got += c.length;
        if (got >= BODY_MAX) end(); // enough to read an answer: the rest is never read
      });
      res.on("end", end);
      res.on("error", () => end());
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * Make one probe's call with the record's values; never throws for the service's answer. Exported for
 * scripts/connection-test-test.ts; the page action calls testConnectionRecord.
 */
export async function runProbe(key: string, p: ConnectionProbe, vals: ProbeValues): Promise<ConnectionTestAnswer> {
  // mold_v0-313: a signed kind (AWS, Google Cloud, Azure, Postgres) is its own call: src/connection-test-signed.ts.
  if (!isHttpProbe(p)) return (await import("./connection-test-signed.js")).runSignedProbe(key, p, vals);
  const label = p.label ?? "the service";
  const secrets: string[] = [];
  const started = Date.now();
  const seconds = p.timeout_seconds ?? PROBE_TIMEOUT_DEFAULT;
  let host: string | null = null, status: number | null = null;
  const answer = (ok: boolean, outcome: ConnectionOutcome, words: string): ConnectionTestAnswer =>
    ({ ok, outcome, words: cleanAnswer(words, secrets), host, status, ms: ok ? Date.now() - started : 0, probe: key });
  try {
    const allowed = probeHosts(p);
    // mold_v0-326: the other address (and its expect) when the record leaves its optional field empty.
    const emptied = p.if_empty && !vals.sealed.has(p.if_empty.field) && asText(vals.plain[p.if_empty.field]) === "";
    const url = emptied ? p.if_empty!.url : p.url;
    // Its own expect, or a plain 2xx (the main expect reads the other address's answer). asText trims: blank is empty.
    const expect = emptied ? (p.if_empty!.expect ?? { status: "2xx" as const }) : p.expect;
    const raw = await fill(url, vals, "url", secrets);
    let u: URL;
    try { u = new URL(raw); } catch { throw new ProbeError("not_ready", `the address this test makes from the record is not a web address (check ${placeholders(url).map(vals.label).join(", ") || "it"})`); }
    host = u.hostname;
    // The headers: those carrying a secret are dropped on a redirect to another host.
    const headers: Record<string, string> = {}, secretHeaders = new Set<string>();
    for (const [h, t] of Object.entries(p.headers ?? {})) {
      headers[h] = await fill(t, vals, "header", secrets);
      if (placeholders(t).some((n) => vals.sealed.has(n))) secretHeaders.add(h);
    }
    // mold_v0-326: Basic authentication (RFC 7617), user and password filled like a header, encoded here.
    if (p.basic_auth) {
      const user = await fill(p.basic_auth.user, vals, "header", secrets), password = await fill(p.basic_auth.password, vals, "header", secrets);
      if (user.includes(":")) throw new ProbeError("not_ready", `${placeholders(p.basic_auth.user).map(vals.label).join(", ") || "the user"} holds a colon, which a sign-in's user cannot carry`);
      const encoded = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
      if ([p.basic_auth.user, p.basic_auth.password].some((t) => placeholders(t).some((n) => vals.sealed.has(n)))) { secrets.push(encoded); secretHeaders.add("Authorization"); }
      headers.Authorization = `Basic ${encoded}`;
    }
    let body = p.body !== undefined && p.method === "POST" ? JSON.stringify(await fillBody(p.body, vals, secrets)) : null;
    let method: string = p.method;
    const deadline = started + seconds * 1000;
    const timeoutWords = `${label} at ${host} did not answer within ${seconds} second${seconds === 1 ? "" : "s"}`;
    let w: Wire;
    for (let hop = 0; ; hop++) {
      await checkAddress(u, allowed);
      w = await send(u, method, headers, body, deadline, timeoutWords);
      if (w.status >= 300 && w.status < 400 && w.location) {
        if (hop >= MAX_REDIRECTS) throw new ProbeError("unexpected", `${label} at ${host} sent the test elsewhere more than ${MAX_REDIRECTS} times`);
        let next: URL;
        try { next = new URL(w.location, u); } catch { throw new ProbeError("unexpected", `${label} at ${host} sent the test to something that is not a web address`); }
        if (next.host !== u.host) for (const h of secretHeaders) delete headers[h];
        if (w.status === 303 || ((w.status === 301 || w.status === 302) && method === "POST")) { method = "GET"; body = null; }
        u = next;
        continue;
      }
      break;
    }
    status = w.status;
    const at = `${label} at ${host}`;
    const want = expect?.status ?? "2xx";
    const statusOk = want === "2xx" ? status >= 200 && status < 300 : want.includes(status);
    if (!statusOk) {
      const said = status >= 400 ? safeSummary(w.body, secrets, w.headers["content-type"]) : null;
      const hint = p.hints?.[String(status)];
      return answer(false, status === 401 || status === 403 ? "refused" : "unexpected",
        `It does not work yet: ${at} answered ${status}: ${statusWords(status)}${said ? ` (it said: "${said}")` : ""}.${hint ? ` ${hint}` : ""}`);
    }
    // mold_v0-326: a working answer of the media type the probe expects (a sign-in page is not git's answer).
    if (expect?.content_type && mediaType(w.headers["content-type"]) !== expect.content_type.toLowerCase())
      return answer(false, "unexpected", `It does not work yet: ${at} answered ${status}, but not with the ${expect.content_type} answer this test reads.${expect.hint ? ` ${expect.hint}` : ""}`);
    if (expect?.json_path) {
      let j: unknown;
      try { j = JSON.parse(w.body.toString("utf8")); } catch { return answer(false, "unexpected", `It does not work yet: ${at} answered ${status}, but not with the JSON this test reads.`); }
      const v = atPath(j, expect.json_path);
      if (expect.equals !== undefined ? v !== expect.equals : v === undefined || v === null || v === "")
        return answer(false, "unexpected", `It does not work yet: ${at} answered ${status}, but ${expect.json_path} ${v === undefined ? "is not in its answer"
          : expect.equals === undefined ? "is empty" : `is ${shortValue(v, secrets)}, not ${JSON.stringify(expect.equals)}`}.${expect.hint ? ` ${expect.hint}` : ""}`);
    }
    return answer(true, "working", `It works: ${at} answered ${status} in ${Date.now() - started} ms.`);
  } catch (e) {
    if (!(e instanceof ProbeError)) throw e;
    if (e.outcome === "not_ready") return answer(false, "not_ready", `It can't be tested yet: ${e.message}.`);
    if (e.outcome === "private_address") return answer(false, "private_address", `It can't be tested: ${e.message}.`);
    return answer(false, e.outcome, `It does not work yet: ${e.message}.`);
  }
}
const shortValue = (v: unknown, secrets: readonly string[]) => {
  if (typeof v === "string") { const c = cleanWords(v, secrets); return c && c.length <= 40 ? JSON.stringify(c) : "another value"; }
  return typeof v === "number" || typeof v === "boolean" ? String(v) : "another value";
};
/** The last guard: no secret in the words, whatever built them. */
export const cleanAnswer = (words: string, secrets: readonly string[]) => cutSecrets(words, secrets);

// ---------------------------------------------------------------- the record

type Area = import("./record-areas.js").RecordArea;
type Actor = { role: import("./account-roles.js").AccountRole | null; userId: string | null };

/**
 * The record page's Test (`test_connection`): its probe's call with this record's own values, and the declared status
 * and tested fields written (as `actor`, who may update the record: the action is offered only then; inside asAction,
 * by the caller). Never throws for the service's answer, never returns or logs a secret.
 */
export async function testConnectionRecord(orgId: number, area: Area, key: string, test: ConnectionTest, actor: Actor): Promise<ConnectionTestAnswer> {
  const { workspaceStored, getFor, workspaceRecords, may } = await import("./record-areas.js");
  // mold_v0-312: this record as the person sees it (visibility honoured), and theirs to update: else no test at all.
  if (!(await getFor(orgId, area.name, key, actor)) || !may(area, "update", actor)) throw new PackError(`no ${area.name} record ${key}`, 404);
  await takeTest(orgId);
  const row = (await workspaceStored(orgId, area, [key])).get(key);
  if (!row) throw new PackError(`no ${area.name} record ${key}`, 404);
  const fieldOf = (n: string) => area.fields.find((f) => f.name === n);
  const label = (n: string) => `"${fieldOf(n)?.label ?? n}"`;
  const choice = test.by ? row.data[test.by] : undefined;
  const pk = test.by && typeof choice === "string" && Object.prototype.hasOwnProperty.call(test.probes, choice) ? choice : Object.prototype.hasOwnProperty.call(test.probes, ANY_PROBE) ? ANY_PROBE : null;
  let result: ConnectionTestAnswer, keyEmpty = false, keyBroken = false;
  if (!pk) {
    result = { ok: false, outcome: "not_ready", host: null, status: null, ms: 0, probe: null,
      words: test.by && (choice === undefined || choice === null || choice === "") ? `It can't be tested yet: ${label(test.by)} is empty.` : `It can't be tested yet: this app has no test for ${test.by ? `${label(test.by)} ${String(choice).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80)}` : "this record"}.` };
  } else if (testWorldWithoutStandin()) {
    result = { ok: false, outcome: "not_ready", host: null, status: null, ms: 0, probe: pk, words: TEST_WORLD_WORDS };
  } else {
    const kv = await import("./keyvault.js");
    const { decryptValue, isEnvelope } = await import("./encrypted-fields.js");
    const { withTenant } = await import("./tenant-scope.js");
    const sealed = new Set(area.fields.filter((f) => f.encrypted).map((f) => f.name));
    const open = async (n: string): Promise<string> => {
      const v = row.data[n];
      if (v === null || v === undefined || v === "") return "";
      if (!isEnvelope(v)) return asText(v); // written before the field was encrypted (the migration has not reached it yet)
      if (!kv.vaultUnlocked()) throw new ProbeError("not_ready", "its secrets cannot be opened while the app's key vault is locked");
      try { return asText(await withTenant(orgId, () => decryptValue(orgId, area, key, n, v))); }
      catch { keyBroken = true; throw new ProbeError("not_ready", `${label(n)} does not open with this workspace's key: add it again`); }
    };
    const plain = Object.fromEntries(Object.entries(row.data).filter(([k]) => !sealed.has(k)));
    result = await runProbe(pk, test.probes[pk]!, { plain, sealed, open, label });
    // mold_v0-332: could not test because a key it sends is empty: the record needs its key (not "failing").
    if (result.outcome === "not_ready") keyEmpty = probeSecrets(test.probes[pk]!, (n) => sealed.has(n)).some((n) => (row.data[n] === undefined || row.data[n] === null || row.data[n] === "") && result.words.includes(`${label(n)} is empty`));
  }
  // mold_v0-332: the outcome (working, failing, could not test, needs its key), its time, words and streak.
  const extra = testOutcome(area, row.data, { ...result, keyEmpty, keyBroken });
  if (Object.keys(extra).length) {
    // The masked record written back: a masked field keeps its stored value (src/encrypted-fields.ts).
    const shown = await getFor(orgId, area.name, key, actor);
    // mold_v0-332: as this record's test, about the values it read (changed meanwhile: the stored health is kept).
    if (shown) await asTestOf(area, key, row.data, () => workspaceRecords(area.pack, orgId, actor).update(area.name, key, { title: shown.title, data: { ...shown.data, ...extra } }))
      .catch((e) => console.error(`connection test: the result was not written to ${area.name} ${key}: ${String((e as Error).message).slice(0, 200)}`));
  }
  return result;
}
/**
 * mold_v0-312: at most TESTS_PER_MINUTE tests a minute per workspace: never a scanner. mold_v0-320: counted in the
 * database (src/rate-limits.ts hit: rate_limit_hits, one fixed one-minute window per workspace, one statement per test),
 * so the limit holds across every server instance; and in this process too, so a database that cannot count still
 * holds this instance to it.
 */
export const TESTS_PER_MINUTE = 10;
/** A test's reset starts a new shared count (tests only: always 0 in the app, so every instance counts in one bucket). */
let round = 0;
const BUCKET = (orgId: number) => `connection-test:${orgId}${round ? `:t${round}` : ""}`;
const recent = new Map<number, number[]>();
async function takeTest(orgId: number) {
  const refuse = () => new PackError(`This workspace has tested ${TESTS_PER_MINUTE} connections in the last minute: try again in a minute`, 429);
  const now = Date.now(), list = (recent.get(orgId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= TESTS_PER_MINUTE) throw refuse();
  const { hit } = await import("./rate-limits.js");
  if (await hit([{ bucket: BUCKET(orgId), limit: TESTS_PER_MINUTE, what: "workspace" }], 60)) throw refuse();
  list.push(now); recent.set(orgId, list);
}
/**
 * Tests only: forget the minute's tests: this process's count, and (unless `processOnly`: what a second instance, which
 * never counted here, sees) the shared one.
 */
export const resetTestRateForTest = (opts: { processOnly?: boolean } = {}) => { recent.clear(); if (!opts.processOnly) round++; };
/** Tests only: the connection's own lookup (it refuses a private address at connect time), and whether the stand-in is on. */
export const publicLookupForTest = (host: string, options: object, cb: (e: Error | null, a?: unknown, f?: number) => void) => publicLookup(host, options as never, cb as never);
export const standinActiveForTest = () => standin() !== null;
