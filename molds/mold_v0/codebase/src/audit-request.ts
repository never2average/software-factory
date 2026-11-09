/**
 * The request an access-log entry keeps (mold_v0-286): the headers and the JSON body of the request that made it (for
 * MCP also the tool's name and its arguments), masked before they are stored and capped at REQUEST_CAP bytes. Written
 * by src/audit-trail.ts into the trails' `request` column (sql/migrations/0064_audit_request_payloads.sql); read only by
 * the Access log's side panel and its per-entry export (never the table, never the CSV). Pure: no database, no server.
 *
 * What is kept: every header but the addresses (the entry's own `ip` column has the caller's address, shown only to
 * staff), the JSON body as sent (a non-JSON body: its type and size, never its bytes), and an MCP call's tool and
 * arguments. What is masked, always, to MASK ("••••"):
 *   headers   Authorization and Proxy-Authorization (the scheme word kept: "Bearer ••••"), Cookie, Set-Cookie,
 *             X-Api-Key, and any header whose name has token, secret, key, password, auth, session, signature or
 *             credential in it; a key's public prefix is kept when it has one ("oct_ab12cd••••", what the key list shows)
 *   body      any field whose name has one of those words (or code, otp, pin: a sign-in code); every value of a request
 *             that touched a sealed area (all but the few names that say what was done: op, area, pack, action,
 *             paging) or a credential, key vault or key route (its path names it: credentials, vault, secrets, keys);
 *             every encrypted or file field of an area the request touched (by its name, anywhere in the body); file
 *             contents (base64, data: addresses, long opaque strings); and any value that looks like a credential
 *             whatever its name (a bearer token, a JWT, a PEM block, a prefixed key). A process's first request,
 *             before the areas are loaded, has every body value masked.
 */

export const MASK = "••••";
/** Each entry's request is at most this many bytes of JSON; a longer one keeps its headers and the body's first part. */
export const REQUEST_CAP = 16 * 1024;

export interface AuditRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The JSON body, masked; null for none. A non-JSON body: { "not_kept": "<type>, <n> bytes" }. */
  body: unknown;
  /** An MCP request's tool calls: the tool and its arguments (masked as the body is). */
  tools?: { name: string; arguments: unknown }[];
  /** The body did not fit in REQUEST_CAP: its first part, as text, and a note saying so. */
  truncated?: true;
  note?: string;
  /** One request's id, shared by its platform entry and its data entries. */
  request_id?: string;
}
/** A request's areas: what decides which body fields are masked beyond the names (sealed, encrypted, file fields). */
export interface AreaMasking { sealed: boolean; fields: string[] }

const SECRET_WORDS = /(token|secret|passw(or)?d|passphrase|credential|signature|session|cookie|auth(orization)?|api[-_]?key|private[-_]?key|client[-_]?secret)/i;
/** A name's words (snake, kebab, camel): "x-api-key" → x, api, key; "recordKey" → record, key. */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A field or header whose name says it holds a secret. */
export function secretName(name: string): boolean {
  if (SECRET_WORDS.test(name)) return true;
  const w = words(name);
  return w.some((x) => x === "key" || x === "keys" || x === "apikey" || x === "password" || x === "pwd" || x === "secret" || x === "token" || x === "otp" || x === "pin" || x === "code" || x === "jwt");
}
/** Headers never kept at all: the caller's address and where it is (the entry's ip column holds it, for staff only). */
const DROPPED_HEADER = /^(x-forwarded-for|x-real-ip|forwarded|cf-connecting-ip|true-client-ip|x-client-ip|x-vercel-forwarded-for|x-vercel-proxied-for|x-vercel-ip-.*|cf-ipcountry|x-vercel-ip)$/i;

/** A key's public prefix: `<letters>_` and six more, as the key list shows it (src/auth.ts createApiKey). */
const PREFIXED_KEY = /^([a-z]{2,8}_)([A-Za-z0-9]{6})[A-Za-z0-9_-]{8,}$/;
const keepPrefix = (v: string) => { const m = PREFIXED_KEY.exec(v); return m ? `${m[1]}${m[2]}${MASK}` : MASK; };

/** One header's value as kept. */
export function maskHeader(name: string, value: string): string {
  const n = name.toLowerCase();
  if (n === "authorization" || n === "proxy-authorization") {
    const m = /^(\w+)\s+(.+)$/.exec(value.trim());
    return m ? `${m[1]} ${keepPrefix(m[2]!)}` : MASK;
  }
  if (n === "cookie" || n === "set-cookie") return MASK;
  if (secretName(n)) return keepPrefix(value.trim());
  return looksSecret(value) ? MASK : value.slice(0, 1000);
}

/** A value that is a credential or file contents whatever its field's name. */
export function looksSecret(v: string): boolean {
  const s = v.trim();
  if (/^bearer\s+\S{8,}/i.test(s) || /^basic\s+[A-Za-z0-9+/=]{8,}$/i.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/.test(s)) return true; // a JWT
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(s)) return true;
  if (PREFIXED_KEY.test(s) && /^(oct|sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr]|whsec|re|app|key)_/i.test(s)) return true;
  if (/^(sk-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}$/.test(s)) return true;
  if (/^data:[\w/+.-]+;base64,/i.test(s)) return true; // file contents
  if (s.length >= 256 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return true; // a long opaque blob: base64 file contents or a key
  return false;
}

/** Field names that carry file contents. */
const FILE_FIELD = /^(content|contents|file|files|bytes|blob|base64|data_base64|content_base64|attachment|attachments)$/i;
/** A sealed area's request (or a credential's): these names say what was done and stay readable; every other value is masked. */
const STRUCTURAL = new Set(["op", "operation", "area", "pack", "action", "limit", "before", "after", "cursor", "sort", "order", "visibility", "dry_run", "jsonrpc", "method"]);

/** The body as kept: masked by name, by value and by the areas the request touched. */
export function maskBody(body: unknown, opts: { areas?: AreaMasking[]; maskAll?: boolean } = {}): unknown {
  const sealed = opts.areas?.some((a) => a.sealed) ?? false;
  const fieldNames = new Set((opts.areas ?? []).flatMap((a) => a.fields));
  const walk = (v: unknown, name: string | null, depth: number, all: boolean): unknown => {
    if (depth > 12) return MASK;
    if (v === null || v === undefined) return v ?? null;
    if (name !== null && (secretName(name) || fieldNames.has(name) || FILE_FIELD.test(name))) return MASK;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, null, depth + 1, all));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
        out[k] = walk(x, k, depth + 1, all);
      }
      return out;
    }
    if (all) return name !== null && STRUCTURAL.has(name) ? (typeof v === "string" ? v.slice(0, 500) : v) : MASK;
    if (typeof v === "string") return looksSecret(v) ? MASK : v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} characters)` : v;
    return v;
  };
  // A sealed area's request: every value masked but the names that say what was done (its fields may sit anywhere in
  // a tool's arguments, not only under data).
  return walk(body, null, 0, opts.maskAll === true || sealed);
}

/** A path whose requests carry credential values (the workspace's credentials, the key vault, keys): every value masked. */
export const credentialPath = (path: string) => /(^|\/)(credentials?|vault|keyvault|key-vault|secrets?|keys|api-keys|member-keys|tokens?)(\/|$)/i.test(path);

/** The areas a request names: an `area` value anywhere in its body (an MCP tool's arguments, a batch's operations). */
export function areasNamed(body: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 500)) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "area" && typeof x === "string") out.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return [...out];
}

/** An MCP request's tool calls (JSON-RPC tools/call), each with its arguments masked. */
function mcpTools(body: unknown, masking: AreaMasking[]): { name: string; arguments: unknown }[] {
  const msgs = (Array.isArray(body) ? body : body ? [body] : []) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }[];
  return msgs.filter((m) => m?.method === "tools/call" && typeof m.params?.name === "string")
    .map((m) => ({ name: String(m.params!.name).slice(0, 200), arguments: maskBody(m.params!.arguments ?? {}, { areas: masking }) }));
}

/**
 * The request as kept: headers and body masked, an MCP call's tools, capped at REQUEST_CAP (a longer body is cut, as
 * text, with a note). `masking`: the areas the request touched.
 */
export function captureRequest(r: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown; contentType?: string | null; contentLength?: number | null },
  masking: AreaMasking[] = [], mcp = false, maskAll = false): AuditRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined || DROPPED_HEADER.test(k)) continue;
    headers[k.toLowerCase()] = maskHeader(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  const json = /json/i.test(r.contentType ?? "") || (r.body !== undefined && r.body !== null && typeof r.body === "object" && !Buffer.isBuffer(r.body));
  let body: unknown = null;
  if (r.body !== undefined && r.body !== null && !(typeof r.body === "object" && !Buffer.isBuffer(r.body) && Object.keys(r.body as object).length === 0 && !Array.isArray(r.body))) {
    body = !json || Buffer.isBuffer(r.body) || typeof r.body === "string"
      ? { not_kept: `${(r.contentType ?? "unknown type").split(";")[0]}, ${r.contentLength ?? (Buffer.isBuffer(r.body) ? r.body.length : String(r.body).length)} bytes` }
      : maskBody(r.body, { areas: masking, maskAll: maskAll || credentialPath(r.path) });
  }
  const tools = mcp ? mcpTools(r.body, masking).map((t) => (maskAll ? { ...t, arguments: maskBody(t.arguments, { maskAll: true }) } : t)) : null;
  const out: AuditRequest = { method: r.method.slice(0, 16), path: r.path.slice(0, 300), headers, body, ...(tools ? { tools } : {}) };
  return capRequest(out);
}

/** At most REQUEST_CAP bytes: past it, the body (and tools) become their first part as text, with a note. */
export function capRequest(r: AuditRequest): AuditRequest {
  const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
  if (size(r) <= REQUEST_CAP) return r;
  const rest = { ...r, body: null, tools: undefined } as AuditRequest;
  delete rest.tools;
  const room = Math.max(0, REQUEST_CAP - size(rest) - 200);
  const text = JSON.stringify({ body: r.body, ...(r.tools ? { tools: r.tools } : {}) });
  const out: AuditRequest = { ...rest, body: text.slice(0, room), truncated: true, note: `Cut at 16 KB: the request was ${Math.ceil(size(r) / 1024)} KB` };
  if (size({ ...out, body: "" }) > REQUEST_CAP) out.headers = { note: "headers cut: too long to keep" };
  // The cut text grows when it is written as JSON (quotes and escapes): shorten it until the whole entry fits.
  for (let over = size(out) - REQUEST_CAP; over > 0; over = size(out) - REQUEST_CAP) out.body = (out.body as string).slice(0, Math.max(0, (out.body as string).length - over - 16));
  return out;
}
