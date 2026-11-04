/**
 * A company's own email on the wire (mold_v0-192; src/company-email.ts holds the settings, src/email-intake.ts the
 * intake): SMTP and IMAP over TCP/TLS, Microsoft 365 through Microsoft Graph and Google Workspace through the Gmail API,
 * plus the MIME a message is built from and read into. No dependency: the protocols are small, and every byte a
 * mailbox gives is treated as untrusted input (sizes capped, names cleaned, nothing executed or rendered).
 *
 *   SMTP     submission with STARTTLS (587) or implicit TLS (465), AUTH PLAIN; the certificate is always verified
 *   IMAP     the folder is opened with EXAMINE (read-only: the server refuses any change) and messages fetched with
 *            BODY.PEEK[] (never marked seen); no STORE, COPY, MOVE, EXPUNGE or DELETE is ever sent
 *   Graph    app-only sign-in (client credentials, a client secret); sendMail; a delta query on one folder, each message
 *            read as MIME ($value); only Mail.Send / Mail.Read are needed
 *   Gmail    a service account with domain-wide delegation (a JWT signed here, RS256), impersonating the mailbox;
 *            messages.send; history (or a list on first sight) on one label, each message read raw; gmail.send /
 *            gmail.readonly only
 *
 * Hosts: an SMTP or IMAP host must resolve to a public address (the server must not become a probe into its own
 * network) unless the operator lists it in APP_EMAIL_ALLOWED_PRIVATE_HOSTS; the connection goes to the address that was
 * checked. Security "none" (no TLS) only with APP_EMAIL_ALLOW_INSECURE=1 outside production (local tests). The Graph and
 * Gmail endpoints are the providers' own; a stand-in address (APP_EMAIL_GRAPH_URL, APP_EMAIL_MS_LOGIN_URL,
 * APP_EMAIL_GMAIL_URL, APP_EMAIL_GOOGLE_TOKEN_URL) is honoured only outside production and only on this machine
 * (127.0.0.1 / localhost), so no setting can send a workspace's secret to another host.
 *
 * Errors are MailError with a kind the console explains (auth_failed, permission_missing, tls_error, unreachable,
 * not_found, refused, protocol); their text never holds a secret (callers redact it again before storing).
 */
import { createHash, createSign, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { ENV } from "./env-names.js";

export const MAIL_ERROR_KINDS = ["auth_failed", "permission_missing", "tls_error", "unreachable", "not_found", "refused", "protocol"] as const;
export type MailErrorKind = (typeof MAIL_ERROR_KINDS)[number];
/** What to change, per kind: the console shows it under the error. */
export const MAIL_HINTS: Record<MailErrorKind, string> = {
  auth_failed: "Sign-in failed: check the user name and password (an app password where the mailbox needs one), or create a new client secret or key.",
  permission_missing: "Permission missing: grant the app Mail.Send (sending) or Mail.Read (intake) with admin consent, or delegate gmail.send / gmail.readonly to the service account's client id; a mailbox outside the app's access policy answers the same way.",
  tls_error: "TLS failed: the server's certificate must be valid; 465 and 993 use SSL/TLS, 587 and 143 STARTTLS.",
  unreachable: "The server did not answer: check the host and port, and that this service may reach them.",
  not_found: "Not found: check the tenant, mailbox, folder or label.",
  refused: "Refused here: see the message.",
  protocol: "The server answered something unexpected: see the message.",
};
export class MailError extends Error {
  constructor(public kind: MailErrorKind, message: string) { super(message.slice(0, 400)); }
}

export type Security = "tls" | "starttls" | "none";
const production = () => process.env.NODE_ENV === "production";
const TIMEOUT = () => Math.min(Math.max(Number(ENV.APP_EMAIL_TIMEOUT_SECONDS) || 20, 5), 120) * 1000;

// ---------- hosts ----------

/** An IPv4 or IPv6 address that is not on the public internet. */
export function privateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && Number(v4[3]) === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8:");
}
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export const isHostName = (h: unknown): h is string => typeof h === "string" && (HOST.test(h) || isIP(h) !== 0);
/** The address to connect to: the host's, checked to be public unless the operator allows it by name. */
export async function resolveHost(host: string): Promise<string> {
  if (!isHostName(host)) throw new MailError("refused", "host: a host name or an IP address");
  const allowed = String(ENV.APP_EMAIL_ALLOWED_PRIVATE_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new MailError("unreachable", `${host} does not resolve`); })).map((a) => a.address);
  if (!addrs.length) throw new MailError("unreachable", `${host} does not resolve`);
  if (!allowed.includes(host.toLowerCase()) && addrs.some(privateAddress))
    throw new MailError("refused", `${host} is a private address: only hosts on the public internet, unless this service's operator allows it by name (APP_EMAIL_ALLOWED_PRIVATE_HOSTS)`);
  return addrs[0]!;
}
export function checkSecurity(s: unknown): Security {
  if (s !== "tls" && s !== "starttls" && s !== "none") throw new MailError("refused", "security: tls, starttls or none");
  if (s === "none" && (production() || ENV.APP_EMAIL_ALLOW_INSECURE !== "1")) throw new MailError("refused", "security none (no TLS) is refused: use SSL/TLS or STARTTLS");
  return s;
}

/** A stand-in for a provider's endpoint (tests), else the provider's own. */
function endpoint(name: "APP_EMAIL_GRAPH_URL" | "APP_EMAIL_MS_LOGIN_URL" | "APP_EMAIL_GMAIL_URL" | "APP_EMAIL_GOOGLE_TOKEN_URL", real: string): string {
  const v = ENV[name];
  if (!v || production()) return real;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return v.replace(/\/$/, "");
  } catch { /* the real one */ }
  return real;
}
export const graphUrl = () => endpoint("APP_EMAIL_GRAPH_URL", "https://graph.microsoft.com");
export const msLoginUrl = () => endpoint("APP_EMAIL_MS_LOGIN_URL", "https://login.microsoftonline.com");
export const gmailUrl = () => endpoint("APP_EMAIL_GMAIL_URL", "https://gmail.googleapis.com");
export const googleTokenUrl = () => endpoint("APP_EMAIL_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token");

// ---------- a line-and-literal reader over a socket ----------

const netKind = (e: unknown): MailError => {
  if (e instanceof MailError) return e;
  const err = e as { code?: string; message?: string };
  const code = String(err.code ?? "");
  if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME|ERR_SSL/i.test(code) || /certificate|tls|ssl/i.test(err.message ?? "")) return new MailError("tls_error", `TLS failed (${code || "handshake"})`);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|EAI_AGAIN/.test(code) || /timed out|closed/i.test(err.message ?? ""))
    return new MailError("unreachable", `the server did not answer (${code || String(err.message ?? "").slice(0, 60)})`);
  return new MailError("protocol", String(err.message ?? e).slice(0, 200));
};

class Wire {
  private buf: Buffer = Buffer.alloc(0);
  private failed: Error | null = null;
  private wake: (() => void) | null = null;
  private onData = (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 64 * 1024 * 1024) this.sock.destroy(new Error("answer too large")); this.poke(); };
  private onErr = (e: Error) => { this.failed ??= e; this.poke(); };
  private onClose = () => { this.failed ??= new Error("connection closed"); this.poke(); };
  constructor(public sock: Socket | TLSSocket) { this.attach(sock); }
  private poke() { const w = this.wake; this.wake = null; w?.(); }
  private attach(s: Socket | TLSSocket) {
    s.on("data", this.onData); s.on("error", this.onErr); s.on("close", this.onClose);
    s.setTimeout(TIMEOUT(), () => s.destroy(new Error("timed out")));
  }
  private async more() {
    if (this.failed) throw netKind(this.failed);
    await new Promise<void>((r) => { this.wake = r; });
  }
  async line(max = 1024 * 1024): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const l = this.buf.subarray(0, i).toString("utf8"); this.buf = this.buf.subarray(i + 2); return l; }
      if (this.buf.length > max) throw new MailError("protocol", "a line too long");
      await this.more();
    }
  }
  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const b = Buffer.from(this.buf.subarray(0, n)); this.buf = this.buf.subarray(n); return b;
  }
  write(s: string | Buffer) { this.sock.write(s); }
  /** STARTTLS: the same connection, now under TLS, its certificate checked against the host's name. */
  async upgrade(servername: string) {
    const plain = this.sock;
    plain.off("data", this.onData); plain.off("error", this.onErr); plain.off("close", this.onClose); plain.setTimeout(0);
    const t = tlsConnect({ socket: plain, servername: isIP(servername) ? undefined : servername, rejectUnauthorized: true });
    await new Promise<void>((ok, bad) => { t.once("secureConnect", () => ok()); t.once("error", (e) => bad(netKind(e))); });
    this.sock = t; this.buf = Buffer.alloc(0); this.attach(t);
  }
  close() { this.sock.destroy(); }
}

async function open(host: string, port: number, security: Security): Promise<Wire> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("refused", "port: 1 to 65535");
  const address = await resolveHost(host);
  const sock = await new Promise<Socket | TLSSocket>((ok, bad) => {
    const s = security === "tls"
      ? tlsConnect({ host: address, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true })
      : netConnect({ host: address, port });
    const t = setTimeout(() => { s.destroy(); bad(new MailError("unreachable", `${host}:${port} did not answer`)); }, TIMEOUT());
    s.once(security === "tls" ? "secureConnect" : "connect", () => { clearTimeout(t); ok(s); });
    s.once("error", (e) => { clearTimeout(t); bad(netKind(e)); });
  });
  return new Wire(sock);
}

// ---------- SMTP ----------

export interface SmtpSettings { host: string; port: number; security: Security; username?: string | null }
async function smtpReply(w: Wire): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const l = await w.line(8192);
    lines.push(l.slice(4));
    if (!/^\d{3}[ -]/.test(l)) throw new MailError("protocol", "not an SMTP server");
    if (l[3] === " ") return { code: Number(l.slice(0, 3)), text: lines.join(" ").slice(0, 300) };
    if (lines.length > 100) throw new MailError("protocol", "an SMTP reply too long");
  }
}
async function smtpSession<T>(s: SmtpSettings, password: string | null, fn: (cmd: (line: string, ok: number[]) => Promise<{ code: number; text: string }>, w: Wire) => Promise<T>): Promise<T> {
  const security = checkSecurity(s.security);
  const w = await open(s.host, s.port, security);
  const cmd = async (line: string, ok: number[], quiet = false) => {
    if (/[\r\n]/.test(line)) throw new MailError("refused", "a line break in an SMTP command");
    w.write(`${line}\r\n`);
    const r = await smtpReply(w);
    if (!ok.includes(r.code)) {
      const what = quiet ? line.split(" ")[0] : line.slice(0, 60);
      throw new MailError(r.code === 535 || r.code === 534 || r.code === 530 ? "auth_failed" : r.code === 550 || r.code === 553 || r.code === 554 ? "permission_missing" : "protocol",
        `${what}: the server answered ${r.code} ${redact(r.text, [password ?? "", s.username ?? ""])}`);
    }
    return r;
  };
  try {
    const hello = await smtpReply(w);
    if (hello.code !== 220) throw new MailError("protocol", `the server's greeting was ${hello.code}`);
    let ehlo = await cmd("EHLO localhost", [250]);
    if (security === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) throw new MailError("tls_error", "the server does not offer STARTTLS");
      await cmd("STARTTLS", [220]);
      await w.upgrade(s.host);
      ehlo = await cmd("EHLO localhost", [250]);
    }
    if (s.username) {
      if (!password) throw new MailError("auth_failed", "a user name without a password");
      await cmd(`AUTH PLAIN ${Buffer.from(`\u0000${s.username}\u0000${password}`, "utf8").toString("base64")}`, [235], true);
    }
    const out = await fn((l, ok) => cmd(l, ok), w);
    await cmd("QUIT", [221]).catch(() => null);
    return out;
  } finally { w.close(); }
}
/** Sign in and say goodbye: the sender's Test button with no recipient. */
export const smtpCheck = (s: SmtpSettings, password: string | null) => smtpSession(s, password, async () => true);
/** Send one message (its MIME, built by buildMime) to one recipient. */
export async function smtpSend(s: SmtpSettings, password: string | null, m: { from: string; to: string; mime: Buffer }): Promise<{ id: string | null }> {
  return smtpSession(s, password, async (cmd, w) => {
    await cmd(`MAIL FROM:<${bareAddress(m.from)}>`, [250]);
    await cmd(`RCPT TO:<${bareAddress(m.to)}>`, [250, 251]);
    await cmd("DATA", [354]);
    // Dot-stuffing: a line that starts with "." gets another.
    w.write(Buffer.from(m.mime.toString("latin1").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..") + "\r\n.\r\n", "latin1"));
    const r = await smtpReply(w);
    if (r.code !== 250) throw new MailError("protocol", `the message was refused: ${r.code} ${r.text}`);
    return { id: /\b([A-Za-z0-9._-]{6,80})\b/.exec(r.text)?.[1] ?? null };
  });
}

// ---------- IMAP (read only) ----------

export interface ImapSettings { host: string; port: number; security: Security; username: string }
interface ImapResponse { lines: { text: string; literals: Buffer[] }[]; status: "OK" | "NO" | "BAD"; text: string }
const imapQuote = (s: string) => {
  if (/[\r\n\u0000]/.test(s)) throw new MailError("refused", "a line break in an IMAP argument");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
class Imap {
  private n = 0;
  constructor(private w: Wire, private secrets: string[]) {}
  /** One untagged or tagged response line, with its literals ({n} then n bytes) read in. */
  private async item(): Promise<{ text: string; literals: Buffer[] }> {
    let text = await this.w.line();
    const literals: Buffer[] = [];
    for (let m = /\{(\d+)\}$/.exec(text); m; m = /\{(\d+)\}$/.exec(text)) {
      const size = Number(m[1]);
      if (size > 50 * 1024 * 1024) throw new MailError("protocol", "a message larger than 50 MB");
      literals.push(await this.w.bytes(size));
      text = `${text}\u0000${await this.w.line()}`;
      if (literals.length > 10) throw new MailError("protocol", "too many literals in one answer");
    }
    return { text, literals };
  }
  async greeting() {
    const g = await this.item();
    if (!/^\* (OK|PREAUTH)/i.test(g.text)) throw new MailError("protocol", "not an IMAP server");
  }
  async cmd(line: string, max = 10_000): Promise<ImapResponse> {
    const tag = `a${++this.n}`;
    this.w.write(`${tag} ${line}\r\n`);
    const lines: ImapResponse["lines"] = [];
    for (;;) {
      const it = await this.item();
      if (it.text.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(it.text);
        if (!m) throw new MailError("protocol", "an IMAP answer without a status");
        return { lines, status: m[1]!.toUpperCase() as ImapResponse["status"], text: redact(m[2] ?? "", this.secrets).slice(0, 200) };
      }
      if (it.text.startsWith("+")) throw new MailError("protocol", "the server asked for more input");
      lines.push(it);
      if (lines.length > max) throw new MailError("protocol", "an IMAP answer too long");
    }
  }
  async ok(line: string, kind: MailErrorKind = "protocol", what = line.split(" ")[0]!): Promise<ImapResponse> {
    const r = await this.cmd(line);
    if (r.status !== "OK") throw new MailError(kind, `${what}: ${r.status} ${r.text}`);
    return r;
  }
  async upgradeAfterStarttls(host: string) { await this.ok("STARTTLS", "tls_error"); await this.w.upgrade(host); }
}

export interface FolderInfo { uidvalidity: string; exists: number; uidnext: number | null }
export interface ImapMessage { uid: number; raw: Buffer; size: number; headers_only: boolean }
/** Sign in, open the folder read-only (EXAMINE), work, sign out. Nothing here can change the mailbox. */
export async function imapSession<T>(s: ImapSettings, password: string, folder: string, fn: (box: {
  info: FolderInfo; search(fromUid: number, since: Date | null): Promise<number[]>; fetch(uids: number[], maxBytes: number): Promise<ImapMessage[]>;
}) => Promise<T>): Promise<T> {
  const security = checkSecurity(s.security);
  const w = await open(s.host, s.port, security);
  const imap = new Imap(w, [password, s.username]);
  try {
    await imap.greeting();
    if (security === "starttls") await imap.upgradeAfterStarttls(s.host);
    const login = await imap.cmd(`LOGIN ${imapQuote(s.username)} ${imapQuote(password)}`);
    if (login.status !== "OK") throw new MailError("auth_failed", `LOGIN: ${login.status} ${login.text}`);
    const ex = await imap.cmd(`EXAMINE ${imapQuote(folder)}`);
    if (ex.status !== "OK") throw new MailError("not_found", `the folder ${JSON.stringify(folder)}: ${ex.status} ${ex.text}`);
    const all = ex.lines.map((l) => l.text).join("\n");
    const info: FolderInfo = {
      uidvalidity: /UIDVALIDITY (\d+)/i.exec(all)?.[1] ?? "0",
      exists: Number(/\* (\d+) EXISTS/i.exec(all)?.[1] ?? 0),
      uidnext: /UIDNEXT (\d+)/i.exec(all) ? Number(/UIDNEXT (\d+)/i.exec(all)![1]) : null,
    };
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const box = {
      info,
      async search(fromUid: number, since: Date | null) {
        const crit = since ? `SINCE ${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}` : `UID ${Math.max(1, fromUid)}:*`;
        const r = await imap.ok(`UID SEARCH ${crit}`, "protocol", "UID SEARCH");
        const uids = r.lines.filter((l) => /^\* SEARCH\b/i.test(l.text)).flatMap((l) => l.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/)).filter(Boolean).map(Number);
        // "n:*" always names the last message, even below n: only those at or after n.
        return [...new Set(uids)].filter((u) => Number.isInteger(u) && u >= fromUid).sort((a, b) => a - b);
      },
      async fetch(uids: number[], maxBytes: number) {
        if (!uids.length) return [];
        const set = uids.join(",");
        const sizes = await imap.ok(`UID FETCH ${set} (UID RFC822.SIZE)`, "protocol", "UID FETCH");
        const size = new Map<number, number>();
        for (const l of sizes.lines) { const u = /UID (\d+)/i.exec(l.text), z = /RFC822\.SIZE (\d+)/i.exec(l.text); if (u && z) size.set(Number(u[1]), Number(z[1])); }
        const out: ImapMessage[] = [];
        for (const uid of uids) {
          const big = (size.get(uid) ?? 0) > maxBytes;
          // BODY.PEEK: reading never sets \Seen. Too large: its header only.
          const r = await imap.ok(`UID FETCH ${uid} (UID ${big ? "BODY.PEEK[HEADER]" : "BODY.PEEK[]"})`, "protocol", "UID FETCH");
          const hit = r.lines.find((l) => new RegExp(`UID ${uid}\\b`, "i").test(l.text) && l.literals.length);
          if (hit) out.push({ uid, raw: hit.literals[0]!, size: size.get(uid) ?? hit.literals[0]!.length, headers_only: big });
        }
        return out;
      },
    };
    const res = await fn(box);
    await imap.cmd("LOGOUT").catch(() => null);
    return res;
  } finally { w.close(); }
}

// ---------- HTTP providers ----------

async function http(url: string, init: RequestInit & { secrets?: string[] }, what: string): Promise<{ status: number; json: any; text: string; bytes: Buffer }> {
  let r: Response;
  try { r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT()) }); }
  catch (e) { throw netKind((e as { cause?: unknown }).cause ?? e); }
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > 50 * 1024 * 1024) throw new MailError("protocol", `${what}: an answer larger than 50 MB`);
  const text = bytes.toString("utf8");
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const detail = redact(String(json?.error?.message ?? json?.error_description ?? json?.error ?? text).slice(0, 300), init.secrets ?? []);
    const code = String(json?.error?.code ?? json?.error ?? "");
    const kind: MailErrorKind = r.status === 401 || /invalid_client|invalid_grant|AADSTS7000215|AADSTS700016/i.test(detail + code) ? (/unauthorized_client/i.test(detail + code) ? "permission_missing" : "auth_failed")
      : r.status === 403 || /unauthorized_client|access_denied|ErrorAccessDenied/i.test(detail + code) ? "permission_missing"
      : r.status === 404 || /not.?found|ErrorItemNotFound|invalid_tenant|AADSTS90002/i.test(detail + code) ? "not_found" : "protocol";
    throw new MailError(kind, `${what}: ${r.status} ${detail}`);
  }
  return { status: r.status, json, text, bytes };
}

export interface GraphSettings { tenant_id: string; client_id: string; mailbox: string }
const TENANT = /^[A-Za-z0-9.-]{1,100}$/, CLIENT = /^[A-Za-z0-9.@_-]{1,200}$/;
export async function graphToken(s: GraphSettings, secret: string): Promise<string> {
  if (!TENANT.test(s.tenant_id) || !CLIENT.test(s.client_id)) throw new MailError("refused", "tenant id and client id: letters, digits, dots and dashes");
  const r = await http(`${msLoginUrl()}/${encodeURIComponent(s.tenant_id)}/oauth2/v2.0/token`, {
    method: "POST", secrets: [secret], headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.client_id, client_secret: secret, scope: "https://graph.microsoft.com/.default" }).toString(),
  }, "Microsoft sign-in");
  if (typeof r.json?.access_token !== "string") throw new MailError("protocol", "Microsoft sign-in gave no token");
  return r.json.access_token;
}
const gUser = (s: GraphSettings) => `${graphUrl()}/v1.0/users/${encodeURIComponent(s.mailbox)}`;
const WELL_KNOWN = new Set(["inbox", "archive", "junkemail", "sentitems", "deleteditems", "drafts"]);
/** A folder's id path: a well-known name as it is, else a top-level folder (or one under Inbox) by its display name. */
async function graphFolder(s: GraphSettings, token: string, folder: string): Promise<string> {
  if (WELL_KNOWN.has(folder.toLowerCase())) return folder.toLowerCase();
  const q = `$filter=${encodeURIComponent(`displayName eq '${folder.replace(/'/g, "''")}'`)}&$select=id`;
  for (const base of [`${gUser(s)}/mailFolders`, `${gUser(s)}/mailFolders/inbox/childFolders`]) {
    const r = await http(`${base}?${q}`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, "Graph folders");
    const id = r.json?.value?.[0]?.id;
    if (typeof id === "string") return encodeURIComponent(id);
  }
  throw new MailError("not_found", `no folder ${JSON.stringify(folder)} in the mailbox`);
}
export async function graphCheck(s: GraphSettings, secret: string, folder: string | null): Promise<{ messages: number | null }> {
  const token = await graphToken(s, secret);
  if (!folder) { await http(`${gUser(s)}?$select=id`, { headers: { authorization: `Bearer ${token}` }, secrets: [token, secret] }, "Graph mailbox"); return { messages: null }; }
  const f = await graphFolder(s, token, folder);
  const r = await http(`${gUser(s)}/mailFolders/${f}?$select=totalItemCount`, { headers: { authorization: `Bearer ${token}` }, secrets: [token, secret] }, "Graph folder");
  return { messages: Number(r.json?.totalItemCount ?? 0) };
}
export async function graphSend(s: GraphSettings, secret: string, m: { from: string; fromName: string | null; to: string; replyTo: string[]; subject: string; text: string; html: string }) {
  const token = await graphToken(s, secret);
  await http(`${gUser(s)}/sendMail`, {
    method: "POST", secrets: [token, secret], headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ saveToSentItems: true, message: {
      subject: m.subject, body: { contentType: "HTML", content: m.html },
      from: { emailAddress: { address: bareAddress(m.from), ...(m.fromName ? { name: m.fromName } : {}) } },
      toRecipients: [{ emailAddress: { address: m.to } }], replyTo: m.replyTo.map((a) => ({ emailAddress: { address: a } })),
    } }),
  }, "Graph sendMail");
  return { id: null };
}
/** New messages of one folder since the delta link (null: first sight, from `since`): their ids, and the next delta link. */
export async function graphChanges(s: GraphSettings, secret: string, folder: string, delta: string | null, since: Date, max: number): Promise<{ token: string; ids: string[]; next: string | null; more: boolean }> {
  const token = await graphToken(s, secret);
  const f = delta ? null : await graphFolder(s, token, folder);
  // A delta link is only ever followed on the Graph's own host (it came from there).
  let url = delta && delta.startsWith(`${graphUrl()}/`) ? delta
    : `${gUser(s)}/mailFolders/${f}/messages/delta?$select=id,receivedDateTime&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString().replace(/\.\d+Z$/, "Z")}`)}`;
  const ids: string[] = [];
  for (let pages = 0; pages < 50; pages++) {
    const r = await http(url, { headers: { authorization: `Bearer ${token}`, prefer: "odata.maxpagesize=50" }, secrets: [token, secret] }, "Graph delta");
    for (const v of r.json?.value ?? []) if (typeof v?.id === "string" && !v["@removed"]) ids.push(v.id);
    const nextLink = r.json?.["@odata.nextLink"], deltaLink = r.json?.["@odata.deltaLink"];
    if (typeof deltaLink === "string") return { token, ids, next: deltaLink, more: false };
    if (typeof nextLink !== "string" || !nextLink.startsWith(`${graphUrl()}/`)) break;
    url = nextLink;
    // Too many at once: stop at a page boundary and continue from the page link next time.
    if (ids.length >= max) return { token, ids, next: nextLink, more: true };
  }
  return { token, ids, next: delta, more: false };
}
export async function graphMime(s: GraphSettings, token: string, id: string): Promise<Buffer> {
  return (await http(`${gUser(s)}/messages/${encodeURIComponent(id)}/$value`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, "Graph message")).bytes;
}

export interface GmailSettings { mailbox: string }
export interface ServiceAccountKey { client_email: string; private_key: string; private_key_id?: string }
export function parseServiceAccount(secret: string): ServiceAccountKey {
  let j: any;
  try { j = JSON.parse(secret); } catch { throw new MailError("refused", "the key file is not JSON: paste the whole service-account key file"); }
  if (typeof j?.client_email !== "string" || typeof j?.private_key !== "string" || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(j.private_key))
    throw new MailError("refused", "the key file has no client_email or private_key: paste the whole service-account key file");
  return { client_email: j.client_email, private_key: j.private_key, ...(typeof j.private_key_id === "string" ? { private_key_id: j.private_key_id } : {}) };
}
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
export const GMAIL_SCOPES = { send: "https://www.googleapis.com/auth/gmail.send", read: "https://www.googleapis.com/auth/gmail.readonly" } as const;
export async function gmailToken(s: GmailSettings, secret: string, scope: string): Promise<string> {
  const key = parseServiceAccount(secret);
  const aud = googleTokenUrl(), now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, sub: s.mailbox, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  let sig: string;
  try { sig = b64url(createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key.private_key)); }
  catch { throw new MailError("refused", "the key file's private_key does not sign: paste the whole key file again"); }
  const r = await http(aud, {
    method: "POST", secrets: [secret, key.private_key], headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }).toString(),
  }, "Google sign-in");
  if (typeof r.json?.access_token !== "string") throw new MailError("protocol", "Google sign-in gave no token");
  return r.json.access_token;
}
const gm = () => `${gmailUrl()}/gmail/v1/users/me`;
async function gmailLabel(token: string, label: string): Promise<string> {
  if (/^[A-Z_]+$/.test(label) && ["INBOX", "SPAM", "IMPORTANT", "STARRED", "UNREAD", "CATEGORY_PERSONAL", "CATEGORY_UPDATES"].includes(label)) return label;
  const r = await http(`${gm()}/labels`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, "Gmail labels");
  const hit = (r.json?.labels ?? []).find((l: { id?: string; name?: string }) => l.name === label || l.id === label);
  if (!hit?.id) throw new MailError("not_found", `no label ${JSON.stringify(label)} in the mailbox`);
  return String(hit.id);
}
export async function gmailCheck(s: GmailSettings, secret: string, label: string | null): Promise<{ messages: number | null }> {
  const token = await gmailToken(s, secret, label ? GMAIL_SCOPES.read : GMAIL_SCOPES.send);
  if (!label) return { messages: null };
  const id = await gmailLabel(token, label);
  const r = await http(`${gm()}/labels/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, "Gmail label");
  return { messages: Number(r.json?.messagesTotal ?? 0) };
}
export async function gmailSend(s: GmailSettings, secret: string, mime: Buffer) {
  const token = await gmailToken(s, secret, GMAIL_SCOPES.send);
  const r = await http(`${gm()}/messages/send`, { method: "POST", secrets: [token, secret], headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime) }) }, "Gmail send");
  return { id: typeof r.json?.id === "string" ? r.json.id : null };
}
/** New message ids on one label since a history id (null: first sight, from `since`), and the history id to start from next. */
export async function gmailChanges(s: GmailSettings, secret: string, label: string, history: string | null, since: Date, max: number): Promise<{ token: string; ids: string[]; next: string | null; more: boolean }> {
  const token = await gmailToken(s, secret, GMAIL_SCOPES.read);
  const id = await gmailLabel(token, label);
  const h = { headers: { authorization: `Bearer ${token}` }, secrets: [token, secret] };
  const fresh = async () => {
    const profile = await http(`${gm()}/profile`, h, "Gmail profile");
    const ids: string[] = [];
    let page: string | null = null;
    do {
      const r = await http(`${gm()}/messages?labelIds=${encodeURIComponent(id)}&maxResults=100&q=${encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)}`)}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, h, "Gmail list");
      for (const m of r.json?.messages ?? []) if (typeof m?.id === "string") ids.push(m.id);
      page = typeof r.json?.nextPageToken === "string" ? r.json.nextPageToken : null;
    } while (page && ids.length < 1000);
    // Oldest first (the list is newest first).
    return { token, ids: ids.reverse(), next: String(profile.json?.historyId ?? "") || null, more: false };
  };
  if (!history) return fresh();
  try {
    const ids: string[] = [];
    let page: string | null = null, last = history;
    do {
      const r = await http(`${gm()}/history?startHistoryId=${encodeURIComponent(history)}&labelId=${encodeURIComponent(id)}&historyTypes=messageAdded&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, h, "Gmail history");
      for (const x of r.json?.history ?? []) for (const a of x?.messagesAdded ?? []) if (typeof a?.message?.id === "string" && (a.message.labelIds ?? [id]).includes(id)) ids.push(a.message.id);
      if (r.json?.historyId) last = String(r.json.historyId);
      page = typeof r.json?.nextPageToken === "string" ? r.json.nextPageToken : null;
    } while (page && ids.length < max * 4);
    return { token, ids: [...new Set(ids)], next: last, more: false };
  } catch (e) {
    // An expired history id (404): list again from `since`; the intake's ledger drops what it already has.
    if (e instanceof MailError && e.kind === "not_found") return fresh();
    throw e;
  }
}
export async function gmailRaw(token: string, id: string): Promise<Buffer> {
  const r = await http(`${gm()}/messages/${encodeURIComponent(id)}?format=raw`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, "Gmail message");
  if (typeof r.json?.raw !== "string") throw new MailError("protocol", "Gmail gave no raw message");
  return Buffer.from(r.json.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ---------- MIME: building ----------

const nonAscii = (s: string) => /[^\x20-\x7e]/.test(s);
const encWord = (s: string) => (nonAscii(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s);
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, (x) => `${x}\r\n`);
/** The address in "Name <a@b>" or a bare address. */
export const bareAddress = (s: string) => (/<([^<>\s]+)>\s*$/.exec(s)?.[1] ?? s).trim();
const displayName = (s: string) => /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(s)?.[1]?.trim() || null;
const headerAddress = (s: string) => { const n = displayName(s); const a = bareAddress(s); return n ? `${nonAscii(n) ? encWord(n) : `"${n.replace(/["\\]/g, "")}"`} <${a}>` : a; };
/** A message as MIME: text and HTML, UTF-8, base64 bodies; one recipient. */
export function buildMime(m: { from: string; to: string; replyTo: string[]; subject: string; text: string; html: string; domain?: string }): Buffer {
  const boundary = `b_${randomBytes(12).toString("hex")}`;
  const domain = (m.domain || bareAddress(m.from).split("@")[1] || "localhost").replace(/[^A-Za-z0-9.-]/g, "");
  const one = (s: string) => s.replace(/[\r\n]+/g, " ");
  const head = [
    `From: ${one(headerAddress(m.from))}`, `To: ${one(bareAddress(m.to))}`,
    ...(m.replyTo.length ? [`Reply-To: ${one(m.replyTo.map(bareAddress).join(", "))}`] : []),
    `Subject: ${one(encWord(m.subject))}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@${domain}>`, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(body, "utf8").toString("base64"))}`;
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${part("text/plain", m.text)}${part("text/html", m.html)}--${boundary}--\r\n`, "latin1");
}

// ---------- MIME: reading ----------

export interface MailAttachment { name: string; content_type: string; data: Buffer }
export interface ParsedMail {
  message_id: string | null; subject: string; from: string | null; from_name: string | null; to: string[]; cc: string[];
  date: string | null; text: string; attachments: MailAttachment[];
  /** The message's HTML part as it came (mold_v0-220: kept only sanitised, src/html-sanitise.ts); null without one. */
  html: string | null;
}
const decoder = (charset: string) => { try { return new TextDecoder(charset.toLowerCase().replace(/^(us-)?ascii$/, "utf-8"), { fatal: false }); } catch { return new TextDecoder("utf-8"); } };
/** RFC 2047 words (=?charset?B|Q?...?=) in a header, joined when only space separates them. */
export function decodeWords(s: string): string {
  return s.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1").replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, txt: string) => {
    const bytes = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64")
      : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decoder(cs).decode(bytes);
  });
}
interface Headers { [name: string]: string[] }
function splitHead(raw: string): { headers: Headers; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : "";
  const headers: Headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    // Header bytes may be raw UTF-8 (RFC 6532): the latin1 string back to its bytes, read as UTF-8.
    (headers[k] ??= []).push(Buffer.from(line.slice(i + 1).trim(), "latin1").toString("utf8"));
    if (Object.keys(headers).length > 500) break;
  }
  return { headers, body };
}
/** A header value's parameters (type; a=b; c="d"), RFC 2231 continuations and charsets included. */
function params(v: string): { value: string; p: Record<string, string> } {
  const parts: string[] = [];
  let cur = "", q = false;
  for (const ch of v) { if (ch === '"') q = !q; if (ch === ";" && !q) { parts.push(cur); cur = ""; } else cur += ch; }
  parts.push(cur);
  const p: Record<string, string> = {}, ext: Record<string, { i: number; v: string; enc: boolean }[]> = {};
  for (const x of parts.slice(1)) {
    const i = x.indexOf("=");
    if (i < 0) continue;
    const k = x.slice(0, i).trim().toLowerCase();
    let val = x.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(k);
    if (m) (ext[m[1]!] ??= []).push({ i: Number(m[2] ?? 0), v: val, enc: k.endsWith("*") });
    else p[k] = decodeWords(val);
  }
  for (const [k, list] of Object.entries(ext)) {
    list.sort((a, b) => a.i - b.i);
    let charset = "utf-8";
    const bytes = list.map((x, n) => {
      let v = x.v;
      if (n === 0 && x.enc) { const m = /^([^']*)'[^']*'(.*)$/.exec(v); if (m) { charset = m[1] || "utf-8"; v = m[2]!; } }
      return x.enc ? Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_y, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1") : Buffer.from(v, "latin1");
    });
    p[k] = decoder(charset).decode(Buffer.concat(bytes));
  }
  return { value: parts[0]!.trim().toLowerCase(), p };
}
function decodeBody(body: string, cte: string): Buffer {
  const e = cte.trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
  return Buffer.from(body, "latin1");
}
/** Addresses in a header: "Name <a@b>, c@d" -> ["a@b", "c@d"], lowercase. */
export function addresses(v: string | undefined): { address: string; name: string | null }[] {
  if (!v) return [];
  const out: { address: string; name: string | null }[] = [];
  let cur = "", q = false, angle = 0;
  const push = () => {
    const s = decodeWords(cur.trim()); cur = "";
    if (!s) return;
    const m = /^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
    const address = (m ? m[2]! : s).trim().toLowerCase();
    if (/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(address)) out.push({ address: address.slice(0, 254), name: m ? m[1]!.trim().replace(/^"|"$/g, "").slice(0, 200) || null : null });
  };
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (!q && ch === "<") angle++;
    if (!q && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !q && !angle) push(); else cur += ch;
    if (out.length > 200) break;
  }
  push();
  return out;
}
/** A file name safe to store and show: no directory, no control character, at most 200 characters. */
export function cleanName(name: string | undefined, n: number, type: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_").replace(/^\.+/, "").trim().slice(0, 200);
  if (base) return base;
  const ext = type === "message/rfc822" ? ".eml" : type === "application/pdf" ? ".pdf" : type.startsWith("text/") ? ".txt" : "";
  return `attachment-${n}${ext}`;
}
const stripHtml = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();

/** Read a message: its header fields, its text (plain, else HTML as text) and its attachments. Never throws on bad MIME. */
export function parseMail(raw: Buffer, opts: { headersOnly?: boolean } = {}): ParsedMail {
  const top = splitHead(raw.toString("latin1"));
  const h = top.headers;
  const first = (k: string) => h[k]?.[0];
  const from = addresses(first("from"))[0] ?? null;
  const date = first("date") ? new Date(first("date")!) : null;
  const out: ParsedMail = {
    message_id: (/<([^<>\s]{1,900})>/.exec(first("message-id") ?? "")?.[1] ?? (first("message-id")?.trim().slice(0, 900) || null)),
    subject: decodeWords(first("subject") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 998),
    from: from?.address ?? null, from_name: from?.name ?? null,
    to: addresses(h.to?.join(", ")).map((a) => a.address), cc: addresses(h.cc?.join(", ")).map((a) => a.address),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, text: "", attachments: [], html: null,
  };
  if (opts.headersOnly) return out;
  let plain: string | null = null, html: string | null = null, parts = 0;
  const walk = (hd: Headers, body: string, depth: number) => {
    if (++parts > 200 || depth > 10) return;
    const ct = params(hd["content-type"]?.[0] ?? "text/plain; charset=us-ascii");
    const cd = params(hd["content-disposition"]?.[0] ?? "");
    const cte = hd["content-transfer-encoding"]?.[0] ?? "7bit";
    if (ct.value.startsWith("multipart/") && ct.p.boundary) {
      const b = `--${ct.p.boundary}`;
      const chunks = body.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      for (const c of chunks.slice(1)) { if (!c.trim()) continue; const s = splitHead(c); walk(s.headers, s.body, depth + 1); }
      return;
    }
    const name = cd.p.filename ?? ct.p.name;
    const isText = ct.value === "text/plain" || ct.value === "text/html";
    if (cd.value === "attachment" || (name && !(isText && cd.value === "inline")) || ct.value === "message/rfc822" || (!isText && !ct.value.startsWith("multipart/"))) {
      out.attachments.push({ name: cleanName(name, out.attachments.length + 1, ct.value), content_type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct.value) ? ct.value : "application/octet-stream", data: decodeBody(body, cte) });
      return;
    }
    const text = decoder(ct.p.charset ?? "utf-8").decode(decodeBody(body, cte));
    if (ct.value === "text/plain" && plain === null) plain = text;
    else if (ct.value === "text/html" && html === null) html = text;
  };
  walk(h, top.body, 0);
  out.text = (plain ?? (html !== null ? stripHtml(html) : "")).replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  out.html = html;
  return out;
}

/** The text with every secret (and its base64) cut out. */
export function redact(text: string, secrets: string[]): string {
  let t = String(text);
  for (const s of secrets.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length))
    for (const v of [s, Buffer.from(s).toString("base64"), encodeURIComponent(s)]) t = t.split(v).join("…");
  return t;
}
/** A message's dedup key: its Message-ID (lowercase, no brackets), else the provider's own id in its mailbox. */
export const messageKey = (messageId: string | null, fallback: string) =>
  createHash("sha256").update(messageId ? `mid:${messageId.trim().replace(/^<|>$/g, "").toLowerCase()}` : `pid:${fallback}`).digest("hex");
