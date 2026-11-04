/**
 * Document previews of a URL field (mold_v0-220): a field that declares `preview: "document"` names a document on the
 * web (a regulator's circular, a standard's page); the server fetches it once, through an allowlist the pack declares,
 * and keeps it in the object store, so the record's card can preview it like a file.
 *
 *   pack.json  "documents": { "hosts": ["rbi.org.in", "*.sebi.gov.in"], "max_bytes": 20971520, "refresh_days": 30 }
 *              a field: { "name": "url", "type": "text", "preview": "document" }
 *
 *   hosts      the egress allowlist's rule (src/pack-api.ts `host`, the run egress proxy's): a listed host allows itself
 *              and its subdomains; "*.x" means x and its subdomains. Nothing else is ever fetched: a URL off the list is
 *              refused before any connection (`not_allowed`).
 *   wire       HTTPS on port 443 only, no user or password in the URL; the name is resolved here and every address
 *              checked (src/egress-hosts.ts privateAddress: never private, loopback, link-local, reserved or multicast),
 *              and the connection goes to the checked address (no second lookup to rebind). At most 3 redirects, each
 *              checked as the first URL. 20 seconds in all. No cookie, no credential, no referrer is ever sent.
 *   kept       at most `max_bytes` (default 20 MiB, at most 25 MiB; larger is refused, `too_large`); only a PDF (its bytes
 *              start %PDF-), a PNG, JPEG, GIF or WebP image (by its bytes), plain text or HTML (`unsupported_type`
 *              otherwise). HTML is shown only through src/html-sanitise.ts.
 *   cache      a shared area's documents under `documents/shared/<sha256 of the URL>`; a workspace area's sealed with that
 *              workspace's data key under `workspaces/org-<id>/.documents/<sha256>.wse`, so one workspace's fetch never
 *              shows in another's. Fetched again after `refresh_days` (default 30); a failed refresh keeps the last copy.
 *
 * Tests and the lane world only (never in production): APP_DOCUMENT_FETCH_STANDIN=http://127.0.0.1:<port> sends every
 * fetch that passed the allowlist to that address instead (`/<host><path>`), so a fixture stands in for the real host.
 */
import { createHash } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { privateAddress } from "./egress-hosts.js";
import { ENV } from "./env-names.js";

export const DOCUMENT_DEFAULT_MAX = 20 * 1024 * 1024;
export const DOCUMENT_HARD_MAX = 25 * 1024 * 1024;
const TOTAL_MS = 20_000;
const MAX_REDIRECTS = 3;

export type FetchRefusal = "not_allowed" | "bad_url" | "private_address" | "unreachable" | "http_error" | "too_large" | "unsupported_type" | "timeout";
export class DocumentFetchError extends Error {
  constructor(readonly kind: FetchRefusal, message: string) { super(message); this.name = "DocumentFetchError"; }
}
export interface FetchedDocument { url: string; final_url: string; content_type: string; data: Buffer; sha256: string; fetched_at: string }

/** Whether `host` is on the list: a listed host allows itself and its subdomains ("*.x" is x and its subdomains). */
export function hostAllowed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((raw) => {
    const l = raw.toLowerCase().replace(/^\*\./, "");
    return h === l || h.endsWith(`.${l}`);
  });
}

/** The URL if it may be fetched under `hosts` (https, port 443, no credentials, a listed name, not an address). */
export function checkDocumentUrl(raw: unknown, hosts: readonly string[]): URL {
  if (typeof raw !== "string" || raw.length > 2000) throw new DocumentFetchError("bad_url", "not a URL");
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new DocumentFetchError("bad_url", "not a URL"); }
  if (u.protocol !== "https:") throw new DocumentFetchError("not_allowed", "only https:// documents are fetched");
  if (u.username || u.password) throw new DocumentFetchError("not_allowed", "a URL with a user or password is never fetched");
  if (u.port && u.port !== "443") throw new DocumentFetchError("not_allowed", "only port 443 is fetched");
  const host = u.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) throw new DocumentFetchError("not_allowed", "an address is never fetched, only a listed name");
  if (!hostAllowed(host, hosts)) throw new DocumentFetchError("not_allowed", `${host} is not one of the hosts this app may fetch documents from`);
  return u;
}

/** The stand-in address (tests, the lane world): honoured outside production only, and only on 127.0.0.1. */
function standin(): string | null {
  const v = ENV.APP_DOCUMENT_FETCH_STANDIN;
  if (!v || process.env.NODE_ENV === "production") return null;
  try { const u = new URL(v); return u.protocol === "http:" && u.hostname === "127.0.0.1" ? v.replace(/\/$/, "") : null; } catch { return null; }
}

/** A lookup that answers only public addresses (the connection uses the address checked here: no rebinding). */
const publicLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return void (cb as (e: Error | null, a: string, f: number) => void)(err, "", 4);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => privateAddress(a.address));
    if (bad || !list.length) return void (cb as (e: Error | null, a: string, f: number) => void)(Object.assign(new Error("private address"), { code: "EPRIVATE" }), "", 4);
    if ((options as { all?: boolean }).all) return void (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

const TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/html"] as const;
/** What the bytes are, from their first bytes (a declared type is never trusted alone). */
export function sniff(data: Buffer, declared: string): string | null {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const t = declared.split(";")[0]!.trim().toLowerCase();
  if ((t === "text/html" || t === "application/xhtml+xml") && !data.includes(0)) return "text/html";
  if (t === "text/plain" && !data.includes(0)) return "text/plain";
  return null;
}

/**
 * Fetch one document under the allowlist (above). Throws DocumentFetchError with its kind; never sends a cookie or a
 * credential, never follows a redirect off the list, never reads more than `maxBytes`.
 */
export async function fetchDocument(raw: string, hosts: readonly string[], maxBytes = DOCUMENT_DEFAULT_MAX): Promise<FetchedDocument> {
  const max = Math.min(Math.max(1024, maxBytes), DOCUMENT_HARD_MAX);
  const deadline = Date.now() + TOTAL_MS;
  let u = checkDocumentUrl(raw, hosts);
  for (let hop = 0; ; hop++) {
    const r = await request(u, max, deadline);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (hop >= MAX_REDIRECTS) throw new DocumentFetchError("http_error", `more than ${MAX_REDIRECTS} redirects`);
      let next: URL;
      try { next = new URL(r.location, u); } catch { throw new DocumentFetchError("bad_url", "a redirect to something that is not a URL"); }
      u = checkDocumentUrl(next.toString(), hosts);
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new DocumentFetchError("http_error", `the host answered ${r.status}`);
    const type = sniff(r.body, r.type);
    if (!type || !(TYPES as readonly string[]).includes(type)) throw new DocumentFetchError("unsupported_type", `${r.type.split(";")[0] || "an unknown type"} is not previewed (PDF, images, text and web pages are)`);
    return { url: raw, final_url: u.toString(), content_type: type, data: r.body, sha256: createHash("sha256").update(r.body).digest("hex"), fetched_at: new Date().toISOString() };
  }
}

function request(u: URL, max: number, deadline: number): Promise<{ status: number; type: string; location: string | null; body: Buffer }> {
  const sub = standin();
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new DocumentFetchError("timeout", "the document took too long"));
    const headers = { "user-agent": "document-preview/1 (+record card)", accept: "application/pdf,image/*,text/html;q=0.9,text/plain;q=0.8", "accept-encoding": "identity" };
    const req = sub
      ? http.request(`${sub}/${u.hostname}${u.pathname}${u.search}`, { method: "GET", headers, timeout: left })
      : https.request(u, { method: "GET", headers, timeout: left, lookup: publicLookup, agent: false });
    const timer = setTimeout(() => req.destroy(new DocumentFetchError("timeout", "the document took too long")), left);
    req.on("timeout", () => req.destroy(new DocumentFetchError("timeout", "the document took too long")));
    req.on("error", (e) => {
      clearTimeout(timer);
      if (e instanceof DocumentFetchError) return reject(e);
      if ((e as { code?: string }).code === "EPRIVATE") return reject(new DocumentFetchError("private_address", `${u.hostname} resolves to a private or reserved address: never fetched`));
      reject(new DocumentFetchError("unreachable", `${u.hostname} could not be reached`));
    });
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      const type = String(res.headers["content-type"] ?? "");
      if (status >= 300 && status < 400) { res.resume(); clearTimeout(timer); return resolve({ status, type, location, body: Buffer.alloc(0) }); }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max) { req.destroy(); clearTimeout(timer); return reject(new DocumentFetchError("too_large", `the document is larger than ${max} bytes`)); }
      const chunks: Buffer[] = [];
      let got = 0;
      res.on("data", (c: Buffer) => {
        got += c.length;
        if (got > max) { req.destroy(new DocumentFetchError("too_large", `the document is larger than ${max} bytes`)); return; }
        chunks.push(c);
      });
      res.on("end", () => { clearTimeout(timer); resolve({ status, type, location, body: Buffer.concat(chunks) }); });
      res.on("error", (e) => { clearTimeout(timer); reject(e instanceof DocumentFetchError ? e : new DocumentFetchError("unreachable", "the document's connection broke")); });
    });
    req.end();
  });
}
