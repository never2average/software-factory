/**
 * Credentials kept in clear in the audit trails (mold_v0-323). Until mold_v0-322 the masking of an entry's request
 * (src/audit-request.ts) knew a prefixed key only when the six characters after its prefix were letters and digits; keys
 * are base64url, so a key with - or _ there (about one in six) was kept as sent wherever a value is masked by its shape:
 * in JSON bodies, an MCP call's tool arguments and the headers not named for a secret. (Authorization, Cookie and the
 * secret-named headers were masked whatever the shape.) A Slack token (xox?-) was never recognised before either.
 * Read by `npm run operator:audit-key-scan` (scripts/operator/audit-key-scan.ts).
 *
 * What is read: every row of audit_platform_events and audit_data_events (each column but the chain's hashes: the kept
 * `request`, and the text columns, such as the route of a request that came with its key in the address, /mcp/<key>)
 * and the staff access log admin_access_log (actor, path), across every workspace, with the app's own role.
 * Every string (and every field name) is checked against the current looksSecret (src/audit-request.ts) and the
 * factory's credential shapes (.claude/scripts/lib/secret_patterns.py: GitHub, GitLab, Slack, AWS key ids, Anthropic or
 * OpenAI, Google, Stripe, npm, Neon, Vercel Blob, private keys, connection strings with a password), anywhere in the
 * string. Which prefixes count, and when a generic one (sk_, pk_, rk_, re_, cs_, app_, key_) is a key and not a word
 * ("app_settings_page"), is the writer's own rule: src/key-shapes.ts, shared with src/audit-request.ts.
 *
 * What is printed: never a value, nor any part of one but this: an app key the key lists show (oct_, sk_, adm_) by the
 * prefix those lists show (the prefix and its next six characters), so its owner can find and revoke it, with whether
 * a key with that prefix is still active (matched exactly by its sha256 in memory, else by the prefix alone); any other
 * kind by its name and, for a value of 16 characters or more, its last 4 characters.
 *
 * READ ONLY by default: one transaction, made read-only before its first query (SET TRANSACTION READ ONLY, checked with
 * SHOW transaction_read_only), always rolled back. `redactAuditKeys` (--redact --yes) is the one writer: in one
 * transaction it replaces each flagged value in the kept `request` column with the mask ("••••"; a credential inside
 * a longer string: only its span), lifting the trails' append-only trigger for that transaction alone (the trigger is
 * back when it commits or rolls back). The request is not among the chained and signed fields (src/ledger.ts), so the
 * chain and its checkpoints still verify. The text columns are part of the chain and are never changed: their findings
 * are reported as not redactable.
 */
import { createHash } from "node:crypto";
import { looksSecret, MASK } from "./audit-request.js";
import { prefixedKeyOk, prefixedKeysIn } from "./key-shapes.js";
import type { RawConn } from "./vault-status.js";

export type { RawConn };

/** One value that holds a credential, as it may be shown. */
export interface Finding {
  table: string;
  /** The row: scope_id/seq (platform trail), org_id/seq (data trail), id (staff access log). */
  row: string;
  at: string | null;
  org_id: number | null;
  /** Where in the row: request.body.notes, request.tools[0].arguments.q, path, ... */
  path: string;
  kind: string;
  /** An app key the key lists show: its prefix as listed (oct_ and six characters), else null. */
  prefix: string | null;
  /** Any other kind: its last 4 characters when it has 16 or more, else null. */
  last4: string | null;
  /** For an app key: whether a key with this prefix is still active (null for other kinds). */
  key_status: string | null;
  /** Whether --redact can mask it (only the kept request; the text columns are chained). */
  redactable: boolean;
}
export interface ScanReport {
  read_only: boolean;
  tables: { table: string; rows: number; findings: number; present: boolean }[];
  first_at: string | null;
  last_at: string | null;
  findings: Finding[];
  rows_with_findings: number;
  by_table: Record<string, number>;
  by_kind: Record<string, number>;
  by_workspace: { org_id: number | null; slug: string | null; name: string | null; findings: number }[];
  /** Findings --redact cannot change (in a chained text column). */
  not_redactable: number;
}
export interface RedactReport extends ScanReport { redacted_values: number; redacted_rows: number; remaining_redactable: number }

// ---------------------------------------------------------------- what a credential looks like

interface Hit { start: number; end: number; kind: string; prefix: string | null; secret: string; mask: [number, number] }

/** The app's own key kinds by prefix (src/auth.ts, developer-keys.ts, admin-tokens.ts, ...) and the known others. */
const PREFIX_KIND: Record<string, string> = {
  oct: "workspace API key (oct_)", sk: "developer key (sk_)", adm: "admin token (adm_)", whsec: "webhook signing secret (whsec_)",
  cs: "client session token (cs_)", oma: "MCP sign-in token (oma_, omr_, omc_)", omr: "MCP sign-in token (oma_, omr_, omc_)",
  omc: "MCP sign-in token (oma_, omr_, omc_)", ore: "on-premises runner token (ore_, orr_)", orr: "on-premises runner token (ore_, orr_)",
  hst: "agent tool token (hst_)", ocs: "OAuth client secret (ocs_)", ogw: "gateway token (ogw_)", orl: "run lease (orl_)",
  owk: "worker token (owk_)", ghp: "GitHub token", gho: "GitHub token", ghs: "GitHub token", ghu: "GitHub token", ghr: "GitHub token",
  github_pat: "GitHub token", glpat: "GitLab token", re: "Resend key", npm: "npm token", npg: "Neon database password",
  pk: "publishable or restricted key (pk_, rk_)", rk: "publishable or restricted key (pk_, rk_)", app: "prefixed key (app_, key_)", key: "prefixed key (app_, key_)",
};
/** The app keys the key lists show by their prefix and next six characters, and where each is kept. */
export const LISTED: Record<string, { table: string; prefixCol: string; hashCol: string }> = {
  oct: { table: "api_keys", prefixCol: "key_prefix", hashCol: "key_hash" },
  sk: { table: "developer_keys", prefixCol: "key_prefix", hashCol: "key_hash" },
  adm: { table: "admin_tokens", prefixCol: "token_prefix", hashCol: "token_hash" },
};
const randomLooking = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s);

// The factory's shapes (.claude/scripts/lib/secret_patterns.py) and the rest of looksSecret, unanchored.
const SHAPES: { rx: RegExp; kind: string; group?: number }[] = [
  { rx: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g, kind: "private key (PEM)" },
  { rx: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, kind: "JWT" },
  { rx: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g, kind: "Slack token" },
  { rx: /(?<![A-Za-z0-9_.-])gl(?:pat|dt|rt|ptt|oas|soat|cbt|ft|imt|agent)-[A-Za-z0-9_.-]{20,}/g, kind: "GitLab token" },
  { rx: /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, kind: "Anthropic or OpenAI key" },
  { rx: /(?<![A-Za-z0-9])(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}(?![0-9A-Za-z])/g, kind: "AWS access key id" },
  { rx: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g, kind: "Google API key" },
  { rx: /(?<![A-Za-z0-9_-])vercel_blob_rw_[A-Za-z0-9]{12,}_[A-Za-z0-9]{24,}/g, kind: "Vercel Blob token" },
  { rx: /(?<![A-Za-z0-9_-])LS0tLS1CRUdJTi[A-Za-z0-9+/=]{24,}/g, kind: "private key (base64-encoded PEM)" },
];
const CONN = /\b([A-Za-z][A-Za-z0-9+.-]{1,24}):\/\/([^\s/:@'"`<>\\,;()]{1,128}):([^\s/@'"`<>\\,;()]{1,256})@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)/g;
const PLACEHOLDER = /[$<>{}*%[\]#]|…|•|^(?:.{1,2}|pass(?:word|wd)?|pw|pwd|secret|x{3,}|\.{3}|changeme|example|test|postgres|user|token|key|redacted)$/i;
const NOWHERE = /^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]|(?:.*\.)?example\.(?:com|org|net)|.*\.(?:example|test|invalid|localhost))$/i;
const AUTH = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/gi;

/** Every credential in a string, by its span; never more than one hit for a span. */
export function credentialsIn(s: string): Hit[] {
  if (s.length < 12) return [];
  const hits: Hit[] = [];
  const free = (a: number, b: number) => !hits.some((h) => a < h.end && b > h.start);
  const add = (h: Hit) => { if (free(h.start, h.end)) hits.push(h); };
  for (const { rx, kind } of SHAPES) {
    for (const m of s.matchAll(rx)) {
      if (kind === "private key (base64-encoded PEM)") {
        let head = "";
        try { head = Buffer.from(m[0].slice(0, Math.floor(Math.min(m[0].length, 400) / 4) * 4), "base64").toString("latin1"); } catch { /* not base64 */ }
        if (!head.includes("PRIVATE KEY")) continue;
      }
      add({ start: m.index!, end: m.index! + m[0].length, kind, prefix: null, secret: m[0], mask: [m.index!, m.index! + m[0].length] });
    }
  }
  // The writer's own rule (src/key-shapes.ts): which prefixes, and when a generic one (sk_, app_, ...) is a key.
  for (const m of s.matchAll(prefixedKeysIn())) {
    const pre = m[1]!.slice(0, -1).toLowerCase(), six = m[2]!, tail = m[3]!, start = m.index!, end = start + m[0].length;
    if (!prefixedKeyOk(pre, six, tail)) continue;
    const stripe = /^(sk|rk|pk)_(live|test)_/i.test(m[0]);
    const kind = stripe ? "Stripe key" : PREFIX_KIND[pre]!;
    add({ start, end, kind, prefix: !stripe && LISTED[pre] ? m[1]! + six : null, secret: m[0], mask: [start, end] });
  }
  for (const m of s.matchAll(CONN)) {
    const pass = m[3]!, host = m[4]!.replace(/\.$/, "");
    if (PLACEHOLDER.test(pass) || NOWHERE.test(host)) continue;
    const a = m.index! + m[1]!.length + 3 + m[2]!.length + 1;
    add({ start: m.index!, end: m.index! + m[0].length, kind: "connection string with a password", prefix: null, secret: pass, mask: [a, a + pass.length] });
  }
  for (const m of s.matchAll(AUTH)) {
    const cred = m[2]!, a = m.index! + m[0].length - cred.length;
    if (!(randomLooking(cred) || /[0-9]/.test(cred) && /[A-Za-z]/.test(cred))) continue;
    if (!free(a, a + cred.length)) continue; // a key already named by its own kind
    add({ start: a, end: a + cred.length, kind: m[1]!.toLowerCase() === "basic" ? "basic credentials" : "bearer token", prefix: null, secret: cred, mask: [a, a + cred.length] });
  }
  // looksSecret's own rule, for the rest (a data: address, a long opaque value, a bearer word).
  if (!hits.length && looksSecret(s)) {
    const t = s.trim();
    const kind = /^data:/i.test(t) ? "file contents (a data: address)" : /-----BEGIN [A-Z ]*CERTIFICATE-----/.test(t) ? "certificate (PEM)"
      : /^bearer\s/i.test(t) ? "bearer token" : /^basic\s/i.test(t) ? "basic credentials" : t.length >= 256 ? "long opaque value (file contents or a key)" : "credential-shaped value";
    const secret = kind.startsWith("bearer") || kind.startsWith("basic") ? t.replace(/^\w+\s+/, "") : t;
    hits.push({ start: 0, end: s.length, kind, prefix: null, secret, mask: [0, s.length] });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** The value with each credential masked: the whole string when one fills it (as the writer stores it), else each span. */
export function maskCredentials(s: string, hits = credentialsIn(s)): string {
  if (!hits.length) return s;
  if (looksSecret(s) || hits.some((h) => h.start <= s.length - s.trimStart().length && h.end >= s.trimEnd().length)) return MASK;
  let out = s;
  for (const h of [...hits].sort((a, b) => b.mask[0] - a.mask[0])) out = out.slice(0, h.mask[0]) + MASK + out.slice(h.mask[1]);
  return out;
}

const last4 = (h: Hit) => (h.kind.startsWith("private key") || h.kind.startsWith("certificate") || h.kind.startsWith("file contents") || h.kind.startsWith("long opaque")
  || h.secret.length < 16 ? null : h.secret.slice(-4));
const seg = (k: string) => (/^[A-Za-z_][A-Za-z0-9_-]{0,59}$/.test(k) ? `.${k}` : `[${JSON.stringify(k.slice(0, 60))}]`);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface Raw { at: string | null; org_id: number | null; row: string; table: string; column: string; path: string; hit: Hit; field_name: boolean }

/** Every credential in a JSON value (strings and field names), each with its path. */
function walk(v: unknown, path: string, out: { path: string; hit: Hit; field_name: boolean }[], depth = 0): void {
  if (depth > 40 || v === null || v === undefined) return;
  if (typeof v === "string") { for (const hit of credentialsIn(v)) out.push({ path, hit, field_name: false }); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, out, depth + 1)); return; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const named = credentialsIn(k);
      for (const hit of named) out.push({ path: `${path}[a field name]`, hit, field_name: true });
      walk(x, named.length ? `${path}[a field name]` : `${path}${seg(k)}`, out, depth + 1);
    }
  }
}

/** The value with every credential masked (strings and field names). */
export function redactJson(v: unknown, depth = 0): { value: unknown; changed: number } {
  if (depth > 40 || v === null || v === undefined) return { value: v, changed: 0 };
  if (typeof v === "string") { const hits = credentialsIn(v); return hits.length ? { value: maskCredentials(v, hits), changed: hits.length } : { value: v, changed: 0 }; }
  if (Array.isArray(v)) { let n = 0; const value = v.map((x) => { const r = redactJson(x, depth + 1); n += r.changed; return r.value; }); return { value, changed: n }; }
  if (typeof v === "object") {
    let n = 0; const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const r = redactJson(x, depth + 1); n += r.changed;
      let name = k; const kh = credentialsIn(k);
      if (kh.length) { n += kh.length; name = maskCredentials(k, kh); for (let i = 2; name in out; i++) name = `${MASK}${i}`; }
      out[name] = r.value;
    }
    return { value: out, changed: n };
  }
  return { value: v, changed: 0 };
}

// ---------------------------------------------------------------- the tables

interface TableSpec { table: string; id: string[]; trigger: string | null; chained: boolean }
const TABLES: TableSpec[] = [
  { table: "audit_platform_events", id: ["scope_id", "seq"], trigger: "audit_platform_events_append_only", chained: true },
  { table: "audit_data_events", id: ["org_id", "seq"], trigger: "audit_data_events_append_only", chained: true },
  { table: "admin_access_log", id: ["id"], trigger: null, chained: false },
];
/** Columns that are never content: the chain's own hashes. */
const SKIP_COLUMNS = new Set(["hash", "prev_hash"]);
const BATCH = 500;
type Q = (sql: string, params?: unknown[]) => Promise<any[]>;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function scanTables(q: Q): Promise<{ raws: Raw[]; tables: ScanReport["tables"]; first: string | null; last: string | null; requests: Map<string, unknown> }> {
  const raws: Raw[] = [], tables: ScanReport["tables"] = [], requests = new Map<string, unknown>();
  let first: string | null = null, last: string | null = null;
  for (const t of TABLES) {
    const [reg] = await q("SELECT to_regclass($1)::text AS t", [t.table]);
    if (!reg?.t) { tables.push({ table: t.table, rows: 0, findings: 0, present: false }); continue; }
    let rows = 0, found = 0, after: unknown[] | null = null;
    const ids = t.id.join(", ");
    for (;;) {
      const where = after ? `WHERE (${ids}) > (${t.id.map((_, i) => `$${i + 1}`).join(", ")})` : "";
      // to_jsonb(row): every column, whatever this release added; the chain's hashes left out.
      const batch = await q(`/* platform: the read-only audit key scan reads every workspace's entries */
        SELECT to_jsonb(e) - 'hash' - 'prev_hash' AS r FROM ${t.table} e ${where} ORDER BY ${ids} LIMIT ${BATCH}`, after ?? []);
      for (const { r } of batch) {
        const row = (typeof r === "string" ? JSON.parse(r) : r) as Record<string, unknown>;
        rows++;
        const at = iso(row.at);
        if (at && (!first || at < first)) first = at;
        if (at && (!last || at > last)) last = at;
        const id = t.id.map((c) => String(row[c])).join("/");
        const orgId = row.org_id == null ? null : Number(row.org_id);
        for (const [col, v] of Object.entries(row)) {
          if (SKIP_COLUMNS.has(col)) continue;
          const hits: { path: string; hit: Hit; field_name: boolean }[] = [];
          walk(v, col, hits);
          for (const h of hits) { raws.push({ at, org_id: orgId, row: id, table: t.table, column: col, ...h }); found++; }
          if (col === "request" && hits.length) requests.set(`${t.table} ${id}`, v);
        }
      }
      if (batch.length < BATCH) break;
      const lastRow = (typeof batch.at(-1).r === "string" ? JSON.parse(batch.at(-1).r) : batch.at(-1).r) as Record<string, unknown>;
      after = t.id.map((c) => lastRow[c]);
    }
    tables.push({ table: t.table, rows, findings: found, present: true });
  }
  return { raws, tables, first, last, requests };
}

/** Whether each app key found is still active: exactly (its sha256, in memory) where the row is there, else by prefix. */
async function keyStatuses(q: Q, raws: Raw[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byPre = new Map<string, Set<string>>();
  for (const r of raws) if (r.hit.prefix) {
    const pre = r.hit.prefix.slice(0, r.hit.prefix.indexOf("_")).toLowerCase();
    if (!byPre.has(pre)) byPre.set(pre, new Set());
    byPre.get(pre)!.add(r.hit.prefix);
  }
  for (const [pre, prefixes] of byPre) {
    const spec = LISTED[pre]!;
    const [reg] = await q("SELECT to_regclass($1)::text AS t", [spec.table]);
    const rows = reg?.t ? await q(`/* platform: the audit key scan checks whether a found key's prefix is still active */
      SELECT to_jsonb(k) AS r FROM ${spec.table} k WHERE ${spec.prefixCol} = ANY($1::text[])`, [[...prefixes]]) : [];
    const keys = rows.map(({ r }) => (typeof r === "string" ? JSON.parse(r) : r) as Record<string, unknown>);
    const live = (k: Record<string, unknown>) => !k.revoked_at && !(k.expires_at && new Date(k.expires_at as string).getTime() <= Date.now());
    for (const r of raws) if (r.hit.prefix && prefixes.has(r.hit.prefix)) {
      const same = keys.filter((k) => k[spec.prefixCol] === r.hit.prefix);
      const exact = same.find((k) => k[spec.hashCol] === sha256(r.hit.secret));
      const word = (k: Record<string, unknown>) => (live(k) ? "still active" : k.revoked_at ? "revoked" : "expired");
      out.set(`${r.table} ${r.row} ${r.path} ${r.hit.start}`, exact ? `this key is ${word(exact)}`
        : same.length ? `a key with this prefix is ${same.some(live) ? "still active" : word(same[0]!)}` : "not found (no key with this prefix)");
    }
  }
  return out;
}

async function report(q: Q, readOnly: boolean): Promise<ScanReport & { requests: Map<string, unknown> }> {
  const { raws, tables, first, last, requests } = await scanTables(q);
  const status = await keyStatuses(q, raws);
  const findings: Finding[] = raws.map((r) => ({
    table: r.table, row: r.row, at: r.at, org_id: r.org_id, path: r.path, kind: r.hit.kind, prefix: r.hit.prefix,
    last4: r.hit.prefix ? null : last4(r.hit), key_status: r.hit.prefix ? status.get(`${r.table} ${r.row} ${r.path} ${r.hit.start}`) ?? null : null,
    redactable: r.column === "request" && TABLES.find((t) => t.table === r.table)!.trigger !== null,
  }));
  const count = (f: (x: Finding) => string) => findings.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const orgIds = [...new Set(findings.map((f) => f.org_id).filter((x): x is number => x !== null))];
  const orgs = orgIds.length ? await q("SELECT id, slug, name FROM organizations WHERE id = ANY($1::int[])", [orgIds]) : [];
  const byOrg = count((f) => String(f.org_id));
  const by_workspace = Object.entries(byOrg).map(([k, n]) => {
    const id = k === "null" ? null : Number(k), o = orgs.find((x) => Number(x.id) === id);
    return { org_id: id, slug: o?.slug ?? null, name: o?.name ?? null, findings: n };
  }).sort((a, b) => b.findings - a.findings);
  return {
    read_only: readOnly, tables, first_at: first, last_at: last, findings,
    rows_with_findings: new Set(findings.map((f) => `${f.table} ${f.row}`)).size,
    by_table: count((f) => f.table), by_kind: count((f) => f.kind), by_workspace,
    not_redactable: findings.filter((f) => !f.redactable).length, requests,
  };
}

/** The scan, in one READ ONLY transaction on `conn` that is rolled back whatever happens. */
export async function scanAuditKeys(conn: RawConn): Promise<ScanReport> {
  await conn.query("BEGIN");
  try {
    await conn.query("SET TRANSACTION READ ONLY");
    const [ro] = (await conn.query("SHOW transaction_read_only")).rows;
    if (String(ro?.transaction_read_only ?? Object.values(ro ?? {})[0]) !== "on") throw new Error("the transaction could not be made read-only; nothing was read");
    const q: Q = async (sql, params) => (await conn.query(sql, params)).rows;
    const { requests: _r, ...r } = await report(q, true);
    return r;
  } finally {
    await conn.query("ROLLBACK").catch(() => {});
  }
}

/**
 * --redact --yes: in one transaction, every flagged value in the kept `request` column replaced by the mask; the trails'
 * append-only trigger lifted for this transaction only (ALTER TABLE ... DISABLE TRIGGER is transactional: it is back
 * at COMMIT or ROLLBACK, and the table is locked meanwhile). Each row is changed only if its request is still the one
 * read. The scan is run again before COMMIT: anything redactable still there rolls the whole change back.
 */
export async function redactAuditKeys(conn: RawConn): Promise<RedactReport> {
  const q: Q = async (sql, params) => (await conn.query(sql, params)).rows;
  await conn.query("BEGIN");
  try {
    const before = await report(q, false);
    let values = 0, rows = 0;
    for (const t of TABLES) {
      if (!t.trigger) continue;
      const mine = [...before.requests].filter(([k]) => k.startsWith(`${t.table} `));
      if (!mine.length) continue;
      await q(`ALTER TABLE ${t.table} DISABLE TRIGGER ${t.trigger}`);
      for (const [k, request] of mine) {
        const r = redactJson(request);
        if (!r.changed) continue;
        const id = k.slice(t.table.length + 1).split("/");
        const done = await q(`/* platform: the audit key scan's --redact masks a credential kept in an entry's request */
          UPDATE ${t.table} SET request = $1::jsonb WHERE ${t.id.map((c, i) => `${c} = $${i + 3}`).join(" AND ")} AND request = $2::jsonb RETURNING 1 AS ok`,
          [JSON.stringify(r.value), JSON.stringify(request), ...id]);
        if (done.length !== 1) throw new Error(`${t.table} ${id.join("/")} changed while it was being redacted; nothing was changed`);
        values += r.changed; rows++;
      }
      await q(`ALTER TABLE ${t.table} ENABLE TRIGGER ${t.trigger}`);
    }
    const after = await report(q, false);
    const remaining = after.findings.filter((f) => f.redactable).length;
    if (remaining) throw new Error(`${remaining} value(s) were still there after redacting; nothing was changed`);
    await conn.query("COMMIT");
    const { requests: _r, ...r } = before;
    return { ...r, redacted_values: values, redacted_rows: rows, remaining_redactable: remaining };
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------- the words

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length));
const day = (s: string | null) => (s ? s.slice(0, 10) : "-");
const ws = (r: ScanReport, id: number | null) => {
  if (id === null) return "the platform (no workspace)";
  const w = r.by_workspace.find((x) => x.org_id === id);
  return `#${id} ${w?.name ?? "(removed workspace)"}${w?.slug ? ` (${w.slug})` : ""}`;
};
const shown = (f: Finding) => f.prefix ? `${f.prefix}  ${f.key_status}` : f.last4 ? `ends in ${f.last4}` : "(nothing of it is shown)";

export function formatScan(r: ScanReport | RedactReport): string {
  const out: string[] = [];
  const redact = "redacted_values" in r;
  out.push(redact ? "Audit key scan, REDACT: the values below were masked in the kept requests (one transaction, committed)"
    : "Audit key scan (READ ONLY: one read-only transaction, rolled back; nothing was changed)");
  out.push(`Read: ${r.tables.map((t) => (t.present ? `${t.table} ${t.rows} row(s)` : `${t.table} (not in this database)`)).join(", ")}`);
  out.push(`Entries from ${day(r.first_at)} to ${day(r.last_at)}`);
  if (!r.findings.length) { out.push("No credential found in the audit trails."); return out.join("\n"); }
  out.push(`Found ${r.findings.length} credential(s) in ${r.rows_with_findings} row(s).`);
  out.push("  By table:     " + Object.entries(r.by_table).map(([k, n]) => `${k} ${n}`).join(", "));
  out.push("  By kind:      " + Object.entries(r.by_kind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
  out.push("  By workspace: " + r.by_workspace.map((w) => `${ws(r, w.org_id)} ${w.findings}`).join(", "));
  out.push("Each (never the value: an app key by the prefix its key list shows, anything else by its kind and last 4 characters):");
  for (const f of r.findings)
    out.push(`  ${pad(f.table, 22)}${pad(f.row, 10)}${pad(f.at ?? "-", 25)}${pad(ws(r, f.org_id), 26)}${pad(f.path, 32)}${pad(f.kind, 28)}${shown(f)}${f.redactable ? "" : "  [a chained column: --redact leaves it]"}`);
  if (redact) {
    const x = r as RedactReport;
    out.push(`Masked ${x.redacted_values} value(s) in ${x.redacted_rows} row(s); the chain is unchanged (the request is not among its fields).`);
  } else {
    out.push("What to do: revoke every app key still active (its owner, in the key list, by the prefix above) and rotate every other");
    out.push("credential found at its provider. To mask them in the stored rows too: npm run operator:audit-key-scan -- --redact --yes");
  }
  if (r.not_redactable) out.push(`${r.not_redactable} finding(s) are in chained text columns (an address, an actor): --redact never changes those; revoke the keys.`);
  return out.join("\n");
}
