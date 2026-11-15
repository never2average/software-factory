/**
 * A record page's "Test connection" (mold_v0-312; the page action `test_connection`, src/connection-test.ts runs it):
 * a workspace's own connection record (an account at a compute provider, a network, a database or another system of
 * record) is checked by one HTTPS call its pack declares, with the record's own fields, on the server. Pack config
 * only, checked here for gen-packs and the server's install alike (src/pack-api.ts actionProblems).
 *
 *   "actions": [{ "kind": "test_connection", "place": "primary", "label": "Test connection", "probe": {
 *     "by": "provider",                         an enum field of the record: which probe its value calls ("*": any other)
 *     "probes": { "<value>": {
 *       "label": "the account's API",           what the answer calls it ("It works: the account's API at ... answered")
 *       "method": "GET" | "HEAD" | "POST",
 *       "url": "https://api.example.com/v1/accounts/{account_id}",
 *                                               https only; {field} is a plain field of the record (its value is
 *                                               escaped for the address; a {field} that starts the address is a url
 *                                               field and gives the address itself)
 *       "headers": { "Authorization": "Bearer {api_token}" },
 *                                               the only place an encrypted (sealed) field may be used
 *       "body": { "query": "{database}" },      POST only: JSON, its strings templates of plain fields
 *       "expect": { "status": "2xx" | [200, 204], "json_path": "data.account.state", "equals": "active" },
 *       "timeout_seconds": 10 },                1 to 15 (default 10)
 *     },
 *     "status": "status",                       an enum (options working and failing) or text field, set_by "action"
 *     "tested": "last_tested" }}]               a date field, set_by "action"
 *
 * The area is a workspace area written by hand (not a repository's), its contract reveals nothing (`reveal: {none}`):
 * a secret is typed once and never shown again, opened only by the test on the server, never returned or logged.
 */
import { z } from "zod";

export const PROBE_METHODS = ["GET", "HEAD", "POST"] as const;
export const PROBE_TIMEOUT_MAX = 15;
export const PROBE_TIMEOUT_DEFAULT = 10;
export const PROBES_MAX = 12;
export const PROBE_HEADERS_MAX = 8;
/** The probe used when the record's `by` value has none of its own (or when there is no `by`). */
export const ANY_PROBE = "*";
/** A {field} placeholder in a probe's template. */
export const PLACEHOLDER = /\{([a-z][a-z0-9_]{1,62})\}/g;
/** The headers a pack never sets: the connection's own (the server sets them), or a browser's. */
const RESERVED_HEADERS = ["host", "content-length", "transfer-encoding", "connection", "cookie", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "expect"];

const template = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, "one line, no control characters");
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a field's name");
const statusCode = z.number().int().min(200, "a status the test counts as working is 200 to 299").max(299, "a status the test counts as working is 200 to 299");

export const ConnectionProbeSchema = z.object({
  label: z.string().trim().min(1).max(60).regex(/^[^\n\r{}<>]*$/, "plain text on one line").optional(),
  method: z.enum(PROBE_METHODS, { error: () => `a probe's method is ${PROBE_METHODS.join(", ")}` }),
  url: template(2000),
  headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "a header's name: letters, digits and -"), template(2000))
    .refine((h) => Object.keys(h).length <= PROBE_HEADERS_MAX, `at most ${PROBE_HEADERS_MAX} headers`).optional(),
  body: z.unknown().optional(),
  expect: z.object({
    status: z.union([z.literal("2xx"), z.array(statusCode).min(1).max(10)]).optional(),
    json_path: z.string().regex(/^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,9}$/, "a path into the JSON answer: names and list positions joined by dots (data.items.0.id)").optional(),
    equals: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]).optional(),
  }).strict().optional(),
  timeout_seconds: z.number().int().min(1).max(PROBE_TIMEOUT_MAX, `a test waits at most ${PROBE_TIMEOUT_MAX} seconds`).optional(),
  /**
   * mold_v0-312: the hosts the call may reach (a name allows itself and its subdomains; "*.x" is x and its subdomains),
   * on every hop, redirects included. Required when the record decides the host (the address starts with a url field,
   * or a {field} is its first label); otherwise the address's own host is the list, with these besides.
   */
  hosts: z.array(z.string().regex(/^(\*\.)?(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host's name (api.example.com, or *.example.com)")).min(1).max(10).optional(),
}).strict();
export type ConnectionProbe = z.output<typeof ConnectionProbeSchema>;

export const ConnectionTestSchema = z.object({
  by: fieldName.optional(),
  probes: z.record(z.string().min(1).max(80), ConnectionProbeSchema)
    .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= PROBES_MAX, `1 to ${PROBES_MAX} probes`),
  status: fieldName.optional(),
  tested: fieldName.optional(),
}).strict();
export type ConnectionTest = z.output<typeof ConnectionTestSchema>;

/** The fields a template names, in order. */
export const placeholders = (t: string): string[] => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!);
/** Every string inside a JSON body (its templates). */
export function bodyStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) bodyStrings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); bodyStrings(x, out); }
  return out;
}
/** Whether the address part before the first placeholder is the whole URL's start: "{endpoint}/v1/..." */
export const startsWithField = (url: string) => /^\{[a-z][a-z0-9_]{1,62}\}/.test(url);
/** The host part of a template (between "https://" and the next / ? #), or null when a field starts the address. */
const hostPart = (url: string) => (startsWithField(url) ? null : (/^https:\/\/([^/?#]*)/i.exec(url)?.[1] ?? null));
/** The fields that decide where a probe's call goes: one that starts its address, or one in its host. */
export function destinationFields(p: ConnectionProbe): string[] {
  if (startsWithField(p.url)) return [placeholders(p.url)[0]!];
  return placeholders(hostPart(p.url) ?? "");
}
/** The hosts a probe may reach: its declared ones, and its address's own host when the pack wrote it. */
export function probeHosts(p: ConnectionProbe): string[] {
  const h = hostPart(p.url);
  const own = h && !h.includes("{") ? [h.toLowerCase().replace(/:443$/, "")] : [];
  return [...own, ...(p.hosts ?? [])];
}
/** Whether `host` is on a list: a listed name allows itself and its subdomains ("*.x" is x and its subdomains). */
export function hostListed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((raw) => { const l = raw.toLowerCase().replace(/^\*\./, ""); return h === l || h.endsWith(`.${l}`); });
}
/** The fields whose secret a probe's headers carry (encrypted fields named in a header). */
export const headerSecrets = (p: ConnectionProbe, sealed: (n: string) => boolean): string[] =>
  [...new Set(Object.values(p.headers ?? {}).flatMap(placeholders).filter(sealed))];

/** A private, loopback or internal name a test never calls (src/connection-test.ts checks the addresses too). */
export const LOCAL_NAMES = ["localhost", "local", "internal", "localdomain", "home.arpa", "lan", "intranet", "corp"];
export const localName = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return !h.includes(".") || LOCAL_NAMES.some((s) => h === s || h.endsWith(`.${s}`));
};
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

interface Field { name: string; label?: string; type?: string; encrypted?: boolean; multiple?: boolean; set_by?: string; options?: readonly (string | { value: string; label?: string })[] }
interface Area { name?: string; scope?: string; repository?: string; fields: readonly Field[]; contract?: { actions?: Record<string, unknown> }; lifecycle?: { field?: string } }

/**
 * Suffixes anyone can host a name under (a cloud's shared hosting, a public suffix): a wildcard under one ("*.x")
 * would let any of its customers receive the call. An exact host under one is fine.
 */
export const SHARED_SUFFIXES = ["amazonaws.com", "on.aws", "vercel.app", "workers.dev", "github.io", "herokuapp.com", "cloudfront.net", "azurewebsites.net",
  "appspot.com", "netlify.app", "pages.dev", "fly.dev", "onrender.com", "web.app", "firebaseapp.com", "run.app", "azurestaticapps.net", "blob.core.windows.net",
  "trycloudflare.com", "ngrok.io", "ngrok.app", "ngrok-free.app", "glitch.me", "repl.co", "surge.sh", "vercel.sh", "deno.dev", "railway.app", "up.railway.app",
  "co.uk", "com.au", "co.jp", "com.br", "co.in", "co.za", "com.cn", "org.uk", "gov.uk", "ac.uk"];
/** Whether a probe's `hosts` entry is a wildcard over a shared suffix (or a bare top-level name). */
export const sharedWildcard = (h: string) => {
  if (!h.startsWith("*.")) return false;
  const base = h.slice(2).toLowerCase();
  return !base.includes(".") || SHARED_SUFFIXES.some((x) => base === x || x.endsWith(`.${base}`));
};
const values = (f: Field) => (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));

/**
 * What is wrong with a test_connection action's probe on `area` (each with its path under the action): the fields its
 * templates name exist (encrypted ones in headers only), https only, sane statuses, a workspace area written by hand
 * whose contract reveals nothing, and a status and tested field only the app's actions set.
 */
export function connectionTestProblems(area: Area, raw: unknown): { message: string; path: (string | number)[] }[] {
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path: ["probe", ...path] });
  const r = ConnectionTestSchema.safeParse(raw);
  if (!r.success) { for (const e of r.error.issues) bad(e.message, ...(e.path as (string | number)[])); return out; }
  const t = r.data;
  const field = (n: string) => area.fields.find((f) => f.name === n);
  if (area.scope !== "workspace") bad("a connection is a workspace's own record: test_connection is for a workspace area", "kind");
  if (area.repository !== undefined) bad(`${area.name ?? "the area"}'s records come from its repository: a connection is added by the workspace's people`, "kind");
  const reveal = area.contract?.actions?.reveal as { none?: unknown } | undefined;
  if (!reveal || typeof reveal !== "object" || Array.isArray(reveal) || typeof reveal.none !== "string")
    bad(`${area.name ?? "the area"}'s contract reveals nothing (contract.actions.reveal {"none": "<why>"}): a connection's secrets are never shown again once saved`, "kind");
  if (t.by !== undefined) {
    const f = field(t.by);
    if (!f) bad(`${t.by} is not one of the area's fields`, "by");
    else if (f.type !== "enum" || f.multiple || f.encrypted) bad(`${t.by} is not a plain single-choice enum field: by chooses a probe by the record's value`, "by");
    else for (const k of Object.keys(t.probes)) if (k !== ANY_PROBE && !values(f).includes(k)) bad(`${k} is not one of ${t.by}'s options (${values(f).join(", ")}) or "${ANY_PROBE}"`, "probes", k);
  } else if (Object.keys(t.probes).some((k) => k !== ANY_PROBE)) bad(`without by, the one probe is "${ANY_PROBE}"`, "probes");
  const setByAction = (k: "status" | "tested", n: string, check: (f: Field) => string | null) => {
    const f = field(n);
    if (!f) return bad(`${n} is not one of the area's fields`, k);
    if (f.encrypted) return bad(`${n} is encrypted: the test writes a plain field`, k);
    if (f.set_by !== "action") return bad(`${n} is written by the test only: declare it set_by "action" (a person never sets it by hand)`, k);
    const why = check(f);
    if (why) bad(`${n} ${why}`, k);
  };
  if (t.status) setByAction("status", t.status, (f) => !["text", "enum"].includes(f.type ?? "text") ? "is a text or enum field"
    : f.type === "enum" && !(values(f).includes("working") && values(f).includes("failing")) ? "is an enum with the options working and failing (what the test writes)" : null);
  if (t.tested) setByAction("tested", t.tested, (f) => (f.type !== "date" ? "is a date field" : null));
  const plainUse = (n: string, where: string, ...path: (string | number)[]) => {
    const f = field(n);
    if (!f) return bad(`{${n}} is not one of the area's fields`, ...path);
    if (f.encrypted) return bad(`{${n}} is encrypted: a secret goes only in a header, never in ${where}`, ...path);
    if (["file", "json", "person"].includes(f.type ?? "text") || f.multiple) bad(`{${n}} is a ${f.multiple ? "list" : `${f.type} field`}: a template takes one plain value`, ...path);
  };
  // A lifecycle's move changes its field without the write's checks (src/secret-binding.ts): it never decides a destination.
  const lc = area.lifecycle?.field;
  if (lc && t.by === lc) bad(`${lc} is the lifecycle's field: a move would change which probe runs without the secret's binding; by names another field`, "by");
  for (const [k, p] of Object.entries(t.probes)) if (lc && destinationFields(p).includes(lc)) bad(`{${lc}} is the lifecycle's field: it never decides where a secret goes`, "probes", k, "url");
  for (const [k, p] of Object.entries(t.probes)) {
    // The address: https, a host that is not an address or an internal name; {field} only for plain fields.
    const names = placeholders(p.url);
    for (const n of names) plainUse(n, "the address", "probes", k, "url");
    if (startsWithField(p.url)) {
      const f = field(names[0]!);
      if (f && f.type !== "url") bad(`{${names[0]}} starts the address: it is a url field (an https address the record holds)`, "probes", k, "url");
      if (!p.hosts) bad(`{${names[0]}} starts the address, so the record decides the host: list the hosts it may be (hosts: ["api.example.com", "*.example.net"])`, "probes", k, "hosts");
    } else {
      let u: URL | null = null;
      try { u = new URL(p.url.replace(PLACEHOLDER, "x")); } catch { bad("not a web address (https://host/path, {field} for a value of the record)", "probes", k, "url"); }
      if (u) {
        if (u.protocol !== "https:") bad("a test calls https:// addresses only", "probes", k, "url");
        if (u.username || u.password) bad("an address never carries a user or password: put a secret in a header", "probes", k, "url");
        const host = new URL(p.url.replace(PLACEHOLDER, "x")).hostname;
        if (/\{/.test(p.url.split("/")[2] ?? "") && !/^\{[a-z0-9_]+\}\.[a-z0-9.-]+$/i.test(p.url.split("/")[2] ?? ""))
          bad("a {field} in the host names only its first label ({account}.api.example.com): the rest of the host is the pack's", "probes", k, "url");
        if (IP_LITERAL.test(host) || localName(host)) bad(`${host} is an address or an internal name: a test calls a public host by its name`, "probes", k, "url");
        if (u.port && u.port !== "443") bad("a test calls port 443 only", "probes", k, "url");
        if (/\{/.test(hostPart(p.url) ?? "") && !p.hosts) bad("a {field} in the host lets the record decide it: list the hosts it may be (hosts)", "probes", k, "hosts");
      }
    }
    for (const h of p.hosts ?? []) if (localName(h.replace(/^\*\./, ""))) bad(`${h} is an internal name: a test calls public hosts only`, "probes", k, "hosts");
    for (const h of p.hosts ?? []) if (sharedWildcard(h)) bad(`${h} is a wildcard over a name anyone can host under: list the exact host (my-db.${h.slice(2)})`, "probes", k, "hosts");
    for (const [h, v] of Object.entries(p.headers ?? {})) {
      if (RESERVED_HEADERS.includes(h.toLowerCase())) bad(`${h} is set by the connection itself: a probe never sets it`, "probes", k, "headers", h);
      for (const n of placeholders(v)) {
        const f = field(n);
        if (!f) bad(`{${n}} is not one of the area's fields`, "probes", k, "headers", h);
        else if (["file", "json", "person"].includes(f.type ?? "text") || f.multiple) bad(`{${n}} is a ${f.multiple ? "list" : `${f.type} field`}: a header takes one plain value`, "probes", k, "headers", h);
      }
    }
    if (p.body !== undefined) {
      if (p.method !== "POST") bad(`a ${p.method} sends no body`, "probes", k, "body");
      let text = "";
      try { text = JSON.stringify(p.body) ?? ""; } catch { /* not JSON */ }
      if (!text) bad("a body is JSON", "probes", k, "body");
      else if (text.length > 4000) bad("a body is at most 4000 characters of JSON", "probes", k, "body");
      for (const s of bodyStrings(p.body)) for (const n of placeholders(s)) plainUse(n, "a body", "probes", k, "body");
    }
    if (p.expect?.equals !== undefined && !p.expect.json_path) bad("equals compares the value at json_path: name it", "probes", k, "expect", "equals");
    if (p.expect?.json_path && p.method === "HEAD") bad("a HEAD's answer has no body: json_path is for a GET or a POST", "probes", k, "expect", "json_path");
  }
  return out;
}
