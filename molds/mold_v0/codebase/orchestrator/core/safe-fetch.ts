/**
 * Hardened HTTP GET for product research (fetch_url).
 *
 * - Allowlist: the job's website/docs hosts and their subdomains (a leading "www." is dropped), the package
 *   registries (registry.npmjs.org, pypi.org, crates.io, pkg.go.dev), and github.com / raw.githubusercontent.com
 *   only for owners linked from the product's own pages. RESEARCH_ALLOW_HOSTS adds hosts (tests).
 * - SSRF: every connection resolves DNS itself and refuses private, loopback, link-local (incl. 169.254.169.254
 *   metadata), CGNAT, multicast and reserved addresses. The check happens inside the socket's `lookup`, so the
 *   address that was checked is the address that is connected to (no DNS-rebinding window).
 *   RESEARCH_TRUST_PRIVATE_HOSTS lists hosts that may resolve privately (tests only). RESEARCH_TEST_DNS maps
 *   "host=ip,..." without DNS (tests only).
 * - Redirects are followed manually (max 5), each hop re-checked against the allowlist.
 * - Per job: at most `maxFetches` calls; responses capped at 2 MB raw, ~40k chars of readable text.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

export const REGISTRY_HOSTS = ["registry.npmjs.org", "pypi.org", "crates.io", "pkg.go.dev"];
const GITHUB_HOSTS = ["github.com", "raw.githubusercontent.com"];
const MAX_RAW = 2_000_000;
const MAX_TEXT = Math.max(2000, Number(process.env.RESEARCH_FETCH_MAX_CHARS ?? 40_000) || 40_000);
const MAX_REDIRECTS = 5;

const envList = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export class FetchBlockedError extends Error {}

/** Is this an address we must never connect to? */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    // IPv4 embedded in IPv6: mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) and compatible (::a.b.c.d) forms.
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isBlockedIp(mapped[1]!);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) { const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16); return isBlockedIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8") ||
      x.startsWith("2002:") /* 6to4 */ || x.startsWith("2001:0:") || x.startsWith("2001::") /* Teredo */;
  }
  return true;
}

export class FetchPolicy {
  readonly siteBases: string[];
  readonly githubOwners = new Set<string>();
  readonly extra = envList(process.env.RESEARCH_ALLOW_HOSTS);
  private trustedPrivate = new Set(envList(process.env.RESEARCH_TRUST_PRIVATE_HOSTS));
  private testDns = new Map(envList(process.env.RESEARCH_TEST_DNS).map((kv) => kv.split("=") as [string, string]));
  fetches = 0;

  /**
   * `related`: the product's own links found in its registry metadata (docs site, homepage, source). Their hosts are
   * allowed like the website; a GitHub link unlocks only that owner's repositories, never all of GitHub.
   */
  constructor(urls: (string | null | undefined)[], readonly maxFetches = 25, related: string[] = []) {
    const bases = new Set<string>();
    for (const r of related) {
      try {
        const u = new URL(r);
        const h = u.hostname.toLowerCase().replace(/^www\./, "");
        if (GITHUB_HOSTS.includes(h)) { const owner = u.pathname.split("/").filter(Boolean)[0]; if (owner) this.githubOwners.add(owner.toLowerCase()); }
        else if (u.protocol === "https:") bases.add(h);
      } catch { /* ignore bad URL */ }
    }
    for (const u of urls) {
      if (!u) continue;
      try { bases.add(new URL(u).hostname.toLowerCase().replace(/^www\./, "")); } catch { /* ignore bad URL */ }
    }
    this.siteBases = [...bases];
  }

  /** Hosts a web or package search returned this job (competitors' sites, comparison pages): readable like the product's. */
  readonly found = new Set<string>();

  /** Allow fetching a search result: its exact host over https (a GitHub result unlocks only that owner). */
  allowFound(raw: string) {
    try {
      const u = new URL(raw);
      const h = u.hostname.toLowerCase();
      if (u.protocol !== "https:" || net.isIP(h.replace(/^\[|\]$/g, ""))) return;
      if (GITHUB_HOSTS.includes(h)) { const owner = u.pathname.split("/").filter(Boolean)[0]; if (owner) this.githubOwners.add(owner.toLowerCase()); }
      else this.found.add(h);
    } catch { /* ignore bad URL */ }
  }

  private suffixMatch(host: string, bases: string[]) { return bases.some((b) => host === b || host.endsWith("." + b)); }

  /** Product site (website/docs host or a subdomain, or a test-allowed host). */
  isProductSite(u: URL): boolean { return this.suffixMatch(u.hostname.toLowerCase(), [...this.siteBases, ...this.extra]); }

  allowed(u: URL): { ok: boolean; why?: string } {
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, why: `scheme ${u.protocol} not allowed` };
    if (u.username || u.password) return { ok: false, why: "credentials in URL not allowed" };
    const host = u.hostname.toLowerCase();
    // IP literals skip the socket lookup (where private addresses are refused), so they are never allowed, even when
    // a customer gave one as the product's website.
    if (net.isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, why: "IP address URLs are not allowed; use the host name" };
    if (this.isProductSite(u)) return { ok: true };
    if (REGISTRY_HOSTS.includes(host)) return { ok: true };
    if (this.found.has(host) && u.protocol === "https:") return { ok: true };
    if (GITHUB_HOSTS.includes(host)) {
      const owner = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      if (owner && this.githubOwners.has(owner)) return { ok: true };
      return { ok: false, why: `GitHub owner "${owner ?? ""}" is not linked from the product's own pages` };
    }
    return { ok: false, why: `host ${host} is not the product's website/docs, a package registry, its GitHub, or a search result` };
  }

  /** Socket lookup: resolve, refuse blocked addresses (unless trusted for tests), connect to the checked address. */
  lookup: LookupFunction = (hostname, options, callback) => {
    const host = hostname.toLowerCase();
    const done = (addrs: { address: string; family: number }[]) => {
      const trusted = this.trustedPrivate.has(host);
      const ok = addrs.filter((a) => trusted || !isBlockedIp(a.address));
      if (!ok.length) return callback(new FetchBlockedError(`${host} resolves to a private or reserved address (${addrs.map((a) => a.address).join(", ")}); blocked`) as any, "", 4);
      const pick = ok[0]!;
      if ((options as { all?: boolean })?.all) return (callback as any)(null, [pick]);
      callback(null, pick.address, pick.family);
    };
    const fixed = this.testDns.get(host);
    if (fixed) return done([{ address: fixed, family: net.isIPv6(fixed) ? 6 : 4 }]);
    if (net.isIP(host)) return done([{ address: host, family: net.isIPv6(host) ? 6 : 4 }]);
    dns.lookup(host, { all: true }, (err, addrs) => (err ? callback(err, "", 4) : done(addrs)));
  };
}

function getOnce(u: URL, policy: FetchPolicy): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, {
      method: "GET", lookup: policy.lookup, timeout: 20_000,
      headers: { "user-agent": "research-fetch/1.0 (+product research)", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size <= MAX_RAW) chunks.push(c); else res.destroy(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out after 20s")));
    req.on("error", reject);
    req.end();
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Readable text from HTML: drop scripts/styles/nav chrome, keep code, headings and list structure. */
export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)].map((m) => m[1]!);
  let t = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/section|\/article|\/table)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
  t = t.split("\n").map((l) => l.replace(/[ \t\f\v\r]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text: t, links };
}

/** One research fetch: allowlisted, SSRF-safe, redirects re-checked, readable text + same-site links. */
export async function fetchReadable(raw: string, policy: FetchPolicy): Promise<string> {
  if (policy.fetches >= policy.maxFetches) throw new FetchBlockedError(`fetch limit reached (${policy.maxFetches} per job)`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchBlockedError(`not a valid URL: ${raw}`); }
  const first = policy.allowed(u);
  if (!first.ok) throw new FetchBlockedError(`blocked: ${first.why}`);
  policy.fetches++;
  let res: Awaited<ReturnType<typeof getOnce>> | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await getOnce(u, policy);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, u);
      const ok = policy.allowed(next);
      if (!ok.ok) throw new FetchBlockedError(`redirect from ${u.href} to ${next.href} blocked: ${ok.why}`);
      u = next;
      continue;
    }
    break;
  }
  if (!res) throw new Error("no response");
  if (res.status >= 300 && res.status < 400) throw new FetchBlockedError(`too many redirects (> ${MAX_REDIRECTS})`);
  const ctype = String(res.headers["content-type"] ?? "");
  const body = res.body.toString("utf8");
  let title = "", text = body, links: string[] = [];
  if (/html/i.test(ctype) || /^\s*<(!doctype|html)/i.test(body)) ({ title, text, links } = htmlToText(body));
  else if (/json/i.test(ctype)) { try { text = JSON.stringify(JSON.parse(body), null, 1); } catch { /* raw */ } }

  // Same-site links (absolute, allowlisted), and GitHub owners the product links to (unlocks its repos).
  const sameSite = new Set<string>();
  for (const href of links) {
    let l: URL;
    try { l = new URL(href, u); } catch { continue; }
    l.hash = "";
    if (policy.isProductSite(u) && (l.hostname === "github.com" || l.hostname === "www.github.com")) {
      const owner = l.pathname.split("/").filter(Boolean)[0];
      if (owner && !["features", "about", "pricing", "login", "orgs", "sponsors", "topics"].includes(owner.toLowerCase())) policy.githubOwners.add(owner.toLowerCase());
    }
    if (policy.allowed(l).ok) sameSite.add(l.href);
  }
  const head = `URL: ${u.href}\nStatus: ${res.status}${title ? `\nTitle: ${title}` : ""}\n\n`;
  const linkBlock = sameSite.size ? `\n\nLinks you may fetch:\n${[...sameSite].slice(0, 60).join("\n")}` : "";
  const room = MAX_TEXT - head.length - Math.min(linkBlock.length, 6000);
  return head + (text.length > room ? text.slice(0, room) + "\n[truncated]" : text) + linkBlock.slice(0, 6000);
}
