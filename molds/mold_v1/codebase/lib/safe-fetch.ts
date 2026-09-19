/**
 * A guarded outbound fetch for ONE purpose: previewing a public PDF.
 *
 * The agent links filings on stock-exchange and investor-relations sites all
 * day, and the browser can neither frame nor fetch them (CSP: `frame-src`,
 * `connect-src 'self'`, `object-src 'none'`). So the server fetches the bytes on
 * the signed-in user's behalf — which makes this a server-side request whose
 * destination a user (or a prompt-injected agent reply) chooses. Everything in
 * this file exists so that such a request can only ever reach a PUBLIC https
 * host, and only ever returns a PDF:
 *
 *   - https, default port, no credentials, a real dotted hostname;
 *   - every address the name resolves to must be public — one private answer
 *     rejects the lot (a split answer is the rebinding setup);
 *   - the connection is PINNED to the address that was checked, so a second DNS
 *     answer between check and connect cannot land somewhere else;
 *   - redirects are followed by hand, each hop re-validated from scratch;
 *   - nothing of the caller's travels upstream (no cookies, no authorization).
 *
 * The top half is pure (no network) and is what scripts/test-pdf-fetch.mjs
 * exercises. Imports are node: built-ins only, so plain
 * `node --experimental-strip-types` can load it.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Readable } from "node:stream";

export const MAX_PDF_BYTES = 40 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 4;
export const TOTAL_TIMEOUT_MS = 20_000;
/** How far into the body `%PDF-` may start (the PDF spec's own allowance). */
export const PDF_SNIFF_WINDOW = 1024;

export type SafeFetchCode =
  | "bad_url"
  | "blocked_host"
  | "too_many_redirects"
  | "timeout"
  | "upstream_denied"
  | "upstream_missing"
  | "upstream_error"
  | "not_pdf"
  | "too_large";

export class SafeFetchError extends Error {
  readonly code: SafeFetchCode;
  constructor(code: SafeFetchCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

/** The HTTP status our route answers with for each failure. Never 401 — that
 *  status is reserved for OUR sign-in gate, and the viewer reads it that way. */
export function statusForCode(code: SafeFetchCode): number {
  switch (code) {
    case "bad_url":
    case "blocked_host":
      return 400;
    case "upstream_denied":
      return 403;
    case "upstream_missing":
      return 404;
    case "too_large":
      return 413;
    case "not_pdf":
      return 415;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

/** Same rule as app/api/artifact-proxy: our own private blob store. */
export function isBlobHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "vercel-storage.com" || h.endsWith(".vercel-storage.com");
}

// --- address classification -------------------------------------------------

function parseDottedQuad(ip: string): number[] | null {
  // Strict: four plain decimal octets, no leading zeros (octal), no hex.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets: number[] = [];
  for (const part of m.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Why a v4 address is not public, or null when it is. */
function blockedV4(o: readonly number[]): string | null {
  const [a, b, c] = o;
  if (a === 0) return "this-network (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation (192.0.2.0/24)";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay (192.88.99.0/24)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved (240.0.0.0/4)";
  return null;
}

/** Expand an IPv6 literal (no brackets, no zone) to 8 hextets, or null. */
function parseV6(ip: string): number[] | null {
  if (ip.includes("%")) return null; // zone ids are never public
  let s = ip;
  // Trailing embedded dotted quad ("::ffff:10.0.0.1") → two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = parseDottedQuad(tail);
    if (!q) return null;
    s = `${s.slice(0, lastColon + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function blockedV6(h: readonly number[]): string | null {
  const allZeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (allZeroTo(8)) return "unspecified (::)";
  if (allZeroTo(7) && h[7] === 1) return "loopback (::1)";
  const embedded = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (deprecated v4-compatible): judge
  // the v4 address inside.
  if (allZeroTo(5) && h[5] === 0xffff) {
    const why = blockedV4(embedded);
    return why ? `IPv4-mapped ${why}` : null;
  }
  if (allZeroTo(6)) return "IPv4-compatible (::/96)";
  if ((h[0] & 0xfe00) === 0xfc00) return "unique-local (fc00::/7)";
  if ((h[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((h[0] & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  // Allow-list from here: only global unicast (2000::/3) is public, minus the
  // ranges inside it that tunnel to, or stand in for, something else.
  if ((h[0] & 0xe000) !== 0x2000) return "not global unicast (outside 2000::/3)";
  if (h[0] === 0x2001 && h[1] === 0x0db8) return "documentation (2001:db8::/32)";
  if (h[0] === 0x2001 && h[1] === 0) return "Teredo (2001::/32)";
  if (h[0] === 0x2002) return "6to4 (2002::/16)";
  return null;
}

export type AddressVerdict = { ok: true } | { ok: false; reason: string };

/** Is this IP literal (v4 dotted quad or v6, brackets tolerated) a PUBLIC address? */
export function classifyAddress(address: string): AddressVerdict {
  const ip = address.replace(/^\[|\]$/g, "");
  if (ip.includes(":")) {
    const h = parseV6(ip);
    if (!h) return { ok: false, reason: "not a valid IPv6 address" };
    const why = blockedV6(h);
    return why ? { ok: false, reason: why } : { ok: true };
  }
  const o = parseDottedQuad(ip);
  if (!o) return { ok: false, reason: "not a plain dotted-quad IPv4 address" };
  const why = blockedV4(o);
  return why ? { ok: false, reason: why } : { ok: true };
}

/**
 * A hostname made only of digits, dots and hex-ish characters ("2130706433",
 * "0x7f.1", "017700000001", "127.1") is an IP address in disguise: inet_aton and
 * the URL parser both read those as IPv4. Anything of that shape must be a plain
 * dotted quad (which is then judged as an address) or it is refused.
 */
export function looksNumericHost(hostname: string): boolean {
  const h = hostname.replace(/\.$/, "");
  if (/^[0-9.]+$/.test(h)) return true;
  // A LAST label that is a number in some base (all digits, or 0x…) is how the
  // URL standard itself decides "this host is an IPv4 address".
  const last = h.slice(h.lastIndexOf(".") + 1);
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

export type HostVerdict =
  | { ok: true; kind: "name" | "ip" }
  | { ok: false; reason: string };

/** Judge a hostname BEFORE any DNS: literals by range, names by shape. */
export function checkHostname(rawHostname: string): HostVerdict {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "no hostname" };
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const v = classifyAddress(hostname);
    return v.ok ? { ok: true, kind: "ip" } : v;
  }
  if (looksNumericHost(hostname)) {
    const v = classifyAddress(hostname);
    return v.ok ? { ok: true, kind: "ip" } : v;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    return { ok: false, reason: "not a public DNS name" };
  }
  if (hostname.length > 253) return { ok: false, reason: "hostname too long" };
  const tld = hostname.slice(hostname.lastIndexOf(".") + 1);
  if (["localhost", "local", "internal", "lan", "home", "corp", "intranet", "test", "invalid", "example", "onion", "arpa"].includes(tld)) {
    return { ok: false, reason: `.${tld} is not a public name` };
  }
  return { ok: true, kind: "name" };
}

export type UrlVerdict =
  | { ok: true; url: URL; blob: boolean; hostKind: "name" | "ip" }
  | { ok: false; code: "bad_url" | "blocked_host"; message: string };

/** Validate the URL itself. Pure — no DNS. */
export function validatePdfUrl(raw: string | null | undefined): UrlVerdict {
  if (!raw) return { ok: false, code: "bad_url", message: "Missing url." };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, code: "bad_url", message: "That link is too long." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "bad_url", message: "That is not a valid link." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: "bad_url", message: "Only https links can be previewed." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "bad_url", message: "Links carrying a username or password cannot be previewed." };
  }
  if (url.port !== "" && url.port !== "443") {
    return { ok: false, code: "bad_url", message: "Only the standard https port can be previewed." };
  }
  if (!url.hostname) return { ok: false, code: "bad_url", message: "That link has no host." };
  // The URL parser has already canonicalised integer/octal/hex hosts to a dotted
  // quad, so checking url.hostname judges what would really be connected to.
  const host = checkHostname(url.hostname);
  if (!host.ok) {
    return { ok: false, code: "blocked_host", message: "This address cannot be previewed." };
  }
  return { ok: true, url, blob: isBlobHost(url.hostname), hostKind: host.kind };
}

/** Does the body start with a PDF header within the sniff window? */
export function sniffPdf(head: Uint8Array): boolean {
  const limit = Math.min(head.length, PDF_SNIFF_WINDOW);
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  outer: for (let i = 0; i + sig.length <= limit; i++) {
    for (let j = 0; j < sig.length; j++) if (head[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}

// --- the network half -------------------------------------------------------

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a validated hostname and return the ONE address to connect to. Every
 * answer must be public; a single private one refuses the host.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolver: Resolver = systemResolver,
): Promise<ResolvedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  if (literal) {
    const v = classifyAddress(bare);
    if (!v.ok) throw new SafeFetchError("blocked_host", "This address cannot be previewed.");
    return { address: bare, family: literal as 4 | 6 };
  }
  let answers: readonly { address: string; family: number }[];
  try {
    answers = await resolver(bare);
  } catch {
    throw new SafeFetchError("upstream_error", "That site could not be found.");
  }
  if (answers.length === 0) throw new SafeFetchError("upstream_error", "That site could not be found.");
  for (const a of answers) {
    if (!classifyAddress(a.address).ok) {
      throw new SafeFetchError("blocked_host", "This address cannot be previewed.");
    }
  }
  const pick = answers.find((a) => a.family === 4) ?? answers[0];
  return { address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

function requestPinned(url: URL, pinned: ResolvedAddress, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        host: url.hostname.replace(/^\[|\]$/g, ""),
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false, // no pooled socket that was resolved some other way
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; pdf-preview/1.0)",
          accept: "application/pdf",
          "accept-encoding": "identity",
        },
        // THE PIN. Whatever the name resolves to now, connect only to the
        // address that passed the check.
        lookup: (_host, options, callback) => {
          const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
          if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
      },
      (res) => {
        // Belt and braces: the socket must really be talking to the pinned address.
        const remote = res.socket?.remoteAddress;
        if (remote && !classifyAddress(remote).ok) {
          res.destroy();
          reject(new SafeFetchError("blocked_host", "This address cannot be previewed."));
          return;
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface GuardedPdfResponse {
  /** The upstream body, positioned at byte 0. Destroy it if you stop early. */
  readonly body: IncomingMessage;
  readonly finalUrl: URL;
  readonly contentLength: number | null;
  /** Call when done (or on failure) to clear the deadline timer. */
  readonly done: () => void;
}

/**
 * GET `rawUrl` under every rule above and hand back the 200 response stream.
 * Throws SafeFetchError for anything else. The caller still has to sniff the
 * body (sniffPdf) and enforce MAX_PDF_BYTES while streaming.
 */
export async function guardedPdfFetch(
  rawUrl: string,
  opts: { resolver?: Resolver; timeoutMs?: number } = {},
): Promise<GuardedPdfResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TOTAL_TIMEOUT_MS);
  const done = () => clearTimeout(timer);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const verdict = validatePdfUrl(current);
      if (!verdict.ok) throw new SafeFetchError(verdict.code, verdict.message);
      const pinned = await resolvePublicAddress(verdict.url.hostname, opts.resolver);
      const res = await requestPinned(verdict.url, pinned, controller.signal);
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        try {
          current = new URL(res.headers.location, verdict.url).toString();
        } catch {
          throw new SafeFetchError("upstream_error", "That site sent a redirect we could not follow.");
        }
        continue;
      }
      if (status !== 200) {
        res.destroy();
        if (status === 401 || status === 403) {
          throw new SafeFetchError(
            "upstream_denied",
            verdict.blob
              ? "This file link has expired — reopen the file for a fresh one."
              : "That site refused to share this file. Open the original instead.",
          );
        }
        if (status === 404 || status === 410) {
          throw new SafeFetchError("upstream_missing", "That file is no longer at this address.");
        }
        throw new SafeFetchError("upstream_error", "That site could not deliver the file right now.");
      }

      const rawLength = Number(res.headers["content-length"]);
      const contentLength = Number.isFinite(rawLength) && rawLength >= 0 ? rawLength : null;
      if (contentLength !== null && contentLength > MAX_PDF_BYTES) {
        res.destroy();
        throw new SafeFetchError("too_large", "Too large to preview (over 40 MB).");
      }
      return { body: res, finalUrl: verdict.url, contentLength, done };
    }
    throw new SafeFetchError("too_many_redirects", "That link redirected too many times.");
  } catch (err) {
    done();
    if (err instanceof SafeFetchError) throw err;
    if (controller.signal.aborted) throw new SafeFetchError("timeout", "That site took too long to respond.");
    throw new SafeFetchError("upstream_error", "That site could not be reached.");
  }
}

/**
 * Turn an upstream body into the stream the route sends — but only if it IS a
 * PDF. The first PDF_SNIFF_WINDOW bytes are held back until `%PDF-` is found in
 * them (the content-type header is never trusted); anything else throws
 * `not_pdf` and not one byte of it is forwarded. While streaming, bytes are
 * counted and the stream is broken at `maxBytes` — by then the status line has
 * gone, so a break is the only honest signal left (the viewer counts bytes too
 * and reads a break at the cap as "too large").
 *
 * `release` runs exactly once when the stream ends, fails or is cancelled.
 */
export async function openPdfStream(
  body: Readable,
  release: () => void = () => {},
  maxBytes: number = MAX_PDF_BYTES,
): Promise<ReadableStream<Uint8Array>> {
  let released = false;
  const abandon = () => {
    if (released) return;
    released = true;
    release();
    body.destroy();
  };
  const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const held: Buffer[] = [];
  let heldBytes = 0;
  let ended = false;
  try {
    while (heldBytes < PDF_SNIFF_WINDOW) {
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      held.push(chunk);
      heldBytes += chunk.length;
    }
  } catch {
    abandon();
    throw new SafeFetchError("upstream_error", "That site stopped responding part-way through.");
  }
  if (!sniffPdf(Buffer.concat(held))) {
    abandon();
    throw new SafeFetchError("not_pdf", "This link is not a PDF.");
  }
  if (heldBytes > maxBytes) {
    abandon();
    throw new SafeFetchError("too_large", "Too large to preview (over 40 MB).");
  }

  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let chunk = held.shift();
        if (!chunk) {
          const next = ended ? { done: true as const, value: undefined } : await iterator.next();
          if (next.done) {
            abandon();
            controller.close();
            return;
          }
          chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        }
        sent += chunk.length;
        if (sent > maxBytes) {
          abandon();
          controller.error(new SafeFetchError("too_large", "Too large to preview (over 40 MB)."));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      } catch (err) {
        abandon();
        controller.error(err);
      }
    },
    cancel() {
      abandon();
    },
  });
}
