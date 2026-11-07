/**
 * An agent profile's governance policy (mold_v0-267; molds/mold_v0/docs/agent-harness.md "Governance policy"), ported
 * from the reference product's own: its web-tool policy, its runtime egress approvals, its explicit tool allowlist with a
 * call ceiling, its time-bounded exceptions and its retention. The rules and their words are the reference's; the names
 * are the mold's. Pure and import-free: the API (src/agent-profile-spec.ts, src/harness-sessions.ts) and the runner
 * (src/agent-harness.ts, part of the run sandbox's code) read the same module, so the two cannot disagree.
 *
 *   web          off by default. Enabled, it allows WebSearch, WebFetch or both, within one combined call ceiling
 *                (1 to 100); WebFetch reads only the hosts on its allowlist (exact, `*.domain` for the domain's
 *                subdomains, or `*` alone for every public host), over https on port 443, with no credentials or
 *                fragment in the address. A disabled policy grants nothing; an enabled one allows at least one tool and
 *                a positive ceiling; WebFetch needs a domain and domains need WebFetch.
 *   approvals    a WebFetch outside the allowlist, or a shell command that reaches for a package registry or an explicit
 *                download address, pauses the session for a decision instead of failing it, when `egress_approvals` is
 *                on and the host is one an allowlist could carry (never an address, a bare label or a raw IDN: those are
 *                refused outright). Approve grants exactly that host to exactly that session (a website also to its
 *                web allowlist when WebFetch is on; a package host never widens the network). Decline ends it.
 *   tools        an explicit allowlist of the app's own tools (no wildcard) with a mandatory call ceiling per wake: the
 *                session is shown only those, and any other call ends it. Unset: the platform setting.
 *   exceptions   a host allowed beyond the allowlist for a stated reason until a date (at most 90 days ahead), recorded
 *                with who saved it; past its date it grants nothing.
 *   retention    a shorter period than the platform's for the session's conversation (never longer).
 */

/** The one allowlist entry that is not a domain: every public host (never an address or an internal name). */
export const ALLOW_ALL_DOMAINS = "*";
export const GOVERNANCE_LIMITS = { domains: 100, max_calls: 100, tools: 200, tool_calls: 1000, exceptions: 50, exception_days: 90, reason: 500, retention_days: 3650 } as const;

export interface WebPolicy {
  enabled: boolean;
  web_search_enabled: boolean;
  web_fetch_enabled: boolean;
  web_fetch_allowed_domains: string[];
  max_calls: number;
}
export interface GovernanceException { domain: string; reason: string; expires_at: string; approved_by?: string }
export interface Governance {
  web?: WebPolicy;
  /** Pause for a decision on an off-list website or package host, instead of refusing it (default on). */
  egress_approvals?: boolean;
  /** The app's own tools the session may call, and how many calls a wake may make (unset: the platform setting). */
  tools?: { allowed: string[]; max_calls: number } | null;
  exceptions?: GovernanceException[];
  /** Days the conversation is kept after it ends, at most the platform's (unset: the platform's). */
  retention_days?: number | null;
}
/** What a session freezes of it (src/harness-sessions.ts): the policy, plus what was granted while it ran. */
export interface FrozenGovernance extends Governance {
  /** Hosts approved for this session at runtime (a website or a package host: the harness stops asking). */
  approved_domains?: string[];
  /** Of those, the websites approved while WebFetch was on (they also reach the network through its proxy). */
  approved_websites?: string[];
}

const LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const DOMAIN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const isIpLiteral = (h: string) => IPV4.test(h) || h.includes(":") || /^\[.*\]$/.test(h);

/**
 * Whether a concrete host could enter an allowlist: a DNS name (no `*.`), not an address, at most 253 characters. A
 * runtime request that fails this (a bare label, an address, a raw IDN) is refused before it can become a request
 * nobody could grant.
 */
export function domainNameValid(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || d.startsWith("*.") || !DOMAIN.test(d)) return false;
  return !isIpLiteral(d);
}

/**
 * The host someone meant when what they typed can only mean the host: a bare name, or a URL with nothing after its
 * host. A URL carrying a path, a port or credentials is left as it is (and refused): an allowlist grants a whole host and
 * cannot say anything narrower, so trimming it would quietly widen it.
 */
export function hostFromEntry(value: string): string {
  const e = value.trim().toLowerCase();
  if (!e.includes("//")) return e.replace(/\.$/, "");
  const rest = e.split("//", 2)[1] ?? "";
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash), after = slash < 0 ? "" : rest.slice(slash + 1);
  if (after) return e;
  return host.replace(/\.$/, "");
}

/** A web policy's domains as stored: each read as its host, checked, once each, sorted; `*` only on its own. */
export function normalizeDomains(values: readonly string[]): { domains: string[]; problems: string[] } {
  const entries = values.map((v) => v.trim()).filter(Boolean);
  if (entries.includes(ALLOW_ALL_DOMAINS)) {
    return new Set(entries).size > 1
      ? { domains: [], problems: ["'*' already allows every host, so it cannot be combined with named domains: use '*' on its own, or list the domains"] }
      : { domains: [ALLOW_ALL_DOMAINS], problems: [] };
  }
  const out: string[] = [], problems: string[] = [];
  for (const v of entries) {
    const d = hostFromEntry(v);
    if (d.length > 253 || !DOMAIN.test(d) || isIpLiteral(d.replace(/^\*\./, ""))) {
      problems.push(`${v.slice(0, 100)}: WebFetch domains are host names like example.com, optionally *.example.com for its subdomains, or * on its own for every public host. An address such as https://example.com/ is read as its host; one with a path, a port or credentials is not, because the allowlist grants a whole host`);
      continue;
    }
    if (!out.includes(d)) out.push(d);
  }
  return { domains: out.sort(), problems };
}

/** What a web policy says wrongly (the reference's own rules, in its order). Empty: it holds. */
export function webPolicyProblems(p: WebPolicy): string[] {
  const out: string[] = [];
  if (!p.enabled) {
    if (p.web_search_enabled || p.web_fetch_enabled || p.web_fetch_allowed_domains.length || p.max_calls) out.push("web: a disabled web policy cannot grant anything (no tool, domain or call limit)");
    return out;
  }
  if (!p.web_search_enabled && !p.web_fetch_enabled) out.push("web: an enabled web policy allows at least one web tool (WebSearch or WebFetch)");
  if (p.max_calls < 1) out.push("web: an enabled web policy needs a call limit of at least 1");
  if (p.web_fetch_enabled && !p.web_fetch_allowed_domains.length) out.push("web: WebFetch needs at least one allowed domain");
  if (!p.web_fetch_enabled && p.web_fetch_allowed_domains.length) out.push("web: allowed domains need WebFetch on");
  return out;
}

/**
 * Whether a host is one the public internet can name: no address, no loopback, no internal suffix. `*` grants these
 * only: turning on broad web access asks for the internet, never for what the session happens to run inside.
 */
export function hostIsPublic(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|internal)$/.test(h)) return false;
  return !isIpLiteral(h);
}

/** Whether `host` is allowed by a list of rules: exact names, `*.domain` (its subdomains, not the domain itself), or `*`. */
export function domainAllowed(host: string, rules: readonly string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (rules.includes(ALLOW_ALL_DOMAINS)) return hostIsPublic(h);
  return rules.some((r) => h === r || (r.startsWith("*.") && h.endsWith(r.slice(1)) && h !== r.slice(2)));
}

/** The exceptions in force at `now` (their date not reached). */
export const activeExceptions = (g: Governance | null | undefined, now = Date.now()): GovernanceException[] =>
  (g?.exceptions ?? []).filter((e) => Date.parse(e.expires_at) > now);

/** Every host a session's governance lets WebFetch read now: the allowlist, the hosts approved for it, its exceptions in force. */
export function fetchRules(g: FrozenGovernance, now = Date.now()): string[] {
  return [...(g.web?.web_fetch_allowed_domains ?? []), ...(g.approved_domains ?? []), ...activeExceptions(g, now).map((e) => e.domain)];
}

// ---------------------------------------------------------------- a shell command that downloads

/** A command matched only where a command starts (a line, after a separator, after sudo), never inside its arguments. */
const AT = String.raw`(?:^\s*|[;&|\x60\n(]\s*|\bsudo\s+)`;
/**
 * Shell commands that reach for a package registry, each with the host it would download from. Offline shapes are
 * exempt (a wheelhouse install with --no-index or --find-links, --offline, a local editable install `-e .`).
 */
const PACKAGE_DOWNLOADS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(AT + String.raw`(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+(?:install|download)\b(?![^\n]*(?:--no-index|--find-links|--offline|\s-e\s+\.(?:\s|$)))`), "pypi.org"],
  [new RegExp(AT + String.raw`npm\s+(?:install|ci|i)\b(?![^\n]*--offline)`), "registry.npmjs.org"],
  [new RegExp(AT + String.raw`(?:yarn|pnpm)\s+(?:add|install)\b(?![^\n]*--offline)`), "registry.npmjs.org"],
];
/** A direct download names its own host: an http(s) address handed to curl, wget or git clone. */
const DOWNLOAD_URL = new RegExp(AT + String.raw`(?:curl|wget|git\s+clone)\s[^\n]*?(https?:\/\/([^/\s'"]+)[^\s'"]*)`);
/** Hosts a command may name without being an external download: loopback and internal names. */
const INTERNAL_HOSTS = ["localhost", "*.localhost", "*.local", "*.internal"];

/**
 * The host (and the address, credentials taken out) a shell command would download from, if any. Deliberately
 * conservative: the known package managers (the registry implied) and an explicit address given to a transfer tool. It
 * decides who is asked about, never who gets through: the network boundary stays the run's.
 */
export function packageDownloadTarget(command: string): { host: string; url: string | null } | null {
  for (const [re, host] of PACKAGE_DOWNLOADS) if (re.test(command)) return domainAllowed(host, INTERNAL_HOSTS) ? null : { host, url: null };
  const m = DOWNLOAD_URL.exec(command);
  if (!m) return null;
  const authority = m[2]!;
  const host = (authority.split("@").at(-1) ?? "").split(":")[0]!.toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".") || isIpLiteral(host) || domainAllowed(host, INTERNAL_HOSTS)) return null;
  const url = authority.includes("@") ? m[1]!.replace(authority, host) : m[1]!;
  return { host, url: url.slice(0, 2048) };
}

// ---------------------------------------------------------------- a tool call under the policy

/** Why a call is refused outright (the session ends with it), in the reference's codes. */
export type GovernanceViolation =
  | "web_tool_not_allowed" | "web_fetch_domain_not_allowed" | "web_tool_call_limit_exceeded"
  | "mcp_tool_not_allowed" | "mcp_call_limit_exceeded";
export const VIOLATION_WORDS: Record<GovernanceViolation, string> = {
  web_tool_not_allowed: "a web tool its governance policy does not allow",
  web_fetch_domain_not_allowed: "a web address its governance policy does not allow",
  web_tool_call_limit_exceeded: "more web calls than its governance policy allows",
  mcp_tool_not_allowed: "an app tool its governance policy does not allow",
  mcp_call_limit_exceeded: "more app tool calls than its governance policy allows",
};
export type GovernanceCheck =
  | { decision: "allow"; web: boolean; mcp: boolean }
  | { decision: "ask"; kind: "website" | "package"; host: string; url: string | null }
  | { decision: "deny"; code: GovernanceViolation }
  /** Not the policy's to decide (another tool): the session's other rules apply. */
  | { decision: "pass" };

/**
 * One tool call under a session's governance: the reference harness's emitted-call check. `webCalls` and `mcpCalls`
 * are what the session (web) and this wake (the app's tools) made before this one.
 */
export function governToolUse(t: { name: string; input: Record<string, unknown> }, g: FrozenGovernance, c: { webCalls: number; mcpCalls: number; now?: number; appServer?: string }): GovernanceCheck {
  const now = c.now ?? Date.now();
  const web = g.web ?? { enabled: false, web_search_enabled: false, web_fetch_enabled: false, web_fetch_allowed_domains: [], max_calls: 0 };
  const asks = g.egress_approvals !== false;
  if (t.name === "Bash" || t.name === "bash") {
    const cmd = typeof t.input.command === "string" ? t.input.command : "";
    const dl = asks && cmd ? packageDownloadTarget(cmd) : null;
    if (dl && domainNameValid(dl.host) && !domainAllowed(dl.host, [...web.web_fetch_allowed_domains, ...(g.approved_domains ?? []), ...activeExceptions(g, now).map((e) => e.domain)]))
      return { decision: "ask", kind: "package", host: dl.host, url: dl.url };
    return { decision: "pass" };
  }
  if (t.name === "WebSearch") {
    if (!web.enabled || !web.web_search_enabled) return { decision: "deny", code: "web_tool_not_allowed" };
    if (c.webCalls + 1 > web.max_calls) return { decision: "deny", code: "web_tool_call_limit_exceeded" };
    return { decision: "allow", web: true, mcp: false };
  }
  if (t.name === "WebFetch") {
    if (!web.enabled || !web.web_fetch_enabled) return { decision: "deny", code: "web_tool_not_allowed" };
    let u: URL | null = null;
    try { u = new URL(String(t.input.url ?? "")); } catch { /* not an address */ }
    if (!u || u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password || u.hash) return { decision: "deny", code: "web_fetch_domain_not_allowed" };
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!domainAllowed(host, fetchRules(g, now))) {
      if (asks && domainNameValid(host)) return { decision: "ask", kind: "website", host, url: `${u.origin}${u.pathname}${u.search}`.slice(0, 2048) };
      return { decision: "deny", code: "web_fetch_domain_not_allowed" };
    }
    if (c.webCalls + 1 > web.max_calls) return { decision: "deny", code: "web_tool_call_limit_exceeded" };
    return { decision: "allow", web: true, mcp: false };
  }
  const prefix = `mcp__${c.appServer ?? "app"}__`;
  if (g.tools && t.name.startsWith(prefix)) {
    const tool = t.name.slice(prefix.length);
    if (!g.tools.allowed.includes(tool)) return { decision: "deny", code: "mcp_tool_not_allowed" };
    if (c.mcpCalls + 1 > g.tools.max_calls) return { decision: "deny", code: "mcp_call_limit_exceeded" };
    return { decision: "allow", web: false, mcp: true };
  }
  return { decision: "pass" };
}

/** The hosts a session's run may reach for its web tools (its egress proxy's list): named hosts only, never `*`. */
export function governedEgressHosts(g: FrozenGovernance, now = Date.now()): string[] {
  if (!g.web?.enabled || !g.web.web_fetch_enabled) return [];
  return [...new Set([...g.web.web_fetch_allowed_domains, ...(g.approved_websites ?? []), ...activeExceptions(g, now).map((e) => e.domain)]
    .filter((d) => d !== ALLOW_ALL_DOMAINS).map((d) => d.replace(/^\*\./, "")))];
}
