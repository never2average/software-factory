// Stand-in mail servers for the company email tests (mold_v0-192; scripts/company-email-test.ts): a small IMAP server, an
// SMTP server, and Microsoft Graph and Gmail stand-ins over HTTP, all on 127.0.0.1, all in this process. Nothing here
// reaches a real mailbox or sends a real email. Each records what it was asked, so a test can prove the intake only
// reads (no SELECT, STORE, COPY, MOVE, EXPUNGE, DELETE; no Graph PATCH/DELETE/move; no Gmail modify/trash).
import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netServer, type AddressInfo, type Socket } from "node:net";

export interface FakeMessage { uid: number; raw: Buffer; id: string; date: Date; labels?: string[] }

/** One RFC 822 message: text, optional HTML and attachments (base64). */
export function mime(m: { from: string; to?: string; subject: string; messageId?: string | null; date?: Date; text: string; html?: string; attachments?: { name: string; type: string; data: Buffer }[]; extraHeaders?: string[] }): Buffer {
  const b = `mix_${randomBytes(6).toString("hex")}`, alt = `alt_${randomBytes(6).toString("hex")}`;
  const head = [`From: ${m.from}`, `To: ${m.to ?? "intake@company.example"}`, `Subject: ${m.subject}`, `Date: ${(m.date ?? new Date()).toUTCString()}`,
    ...(m.messageId === null ? [] : [`Message-ID: <${m.messageId ?? `${randomBytes(8).toString("hex")}@sender.example`}>`]), "MIME-Version: 1.0", ...(m.extraHeaders ?? [])];
  const body = m.html
    ? `--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${m.text.replace(/=/g, "=3D")}\r\n--${alt}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${m.html}\r\n--${alt}--\r\n`
    : null;
  const atts = m.attachments ?? [];
  if (!atts.length && !body) return Buffer.from(`${head.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}\r\n`, "utf8");
  const parts = [
    body ? `--${b}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n${body}` : `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}\r\n`,
    ...atts.map((a) => `--${b}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.data.toString("base64").replace(/.{1,76}/g, "$&\r\n")}`),
  ];
  return Buffer.from(`${head.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join("")}--${b}--\r\n`, "utf8");
}

// ---------- IMAP ----------

export interface ImapAccount { user: string; pass: string; folders: Record<string, { uidvalidity: number; messages: FakeMessage[] }> }
export async function startFakeImap(accounts: ImapAccount[]) {
  const log: { user: string | null; line: string }[] = [];
  const mutating: string[] = [];
  const server = netServer((sock: Socket) => {
    let user: ImapAccount | null = null, folder: string | null = null, buf = "";
    const say = (s: string | Buffer) => sock.write(s);
    say("* OK fake IMAP ready\r\n");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const [, tag, cmdRaw, rest = ""] = m;
        const cmd = cmdRaw!.toUpperCase();
        log.push({ user: user?.user ?? null, line: cmd === "LOGIN" ? "LOGIN ***" : line });
        const args = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] !== undefined ? x[1].replace(/\\(.)/g, "$1") : x[2]!));
        if (["SELECT", "STORE", "COPY", "MOVE", "EXPUNGE", "DELETE", "APPEND", "CREATE", "RENAME"].includes(cmd) || (cmd === "UID" && /^(STORE|COPY|MOVE|EXPUNGE)$/i.test(args[0] ?? ""))) {
          mutating.push(line); say(`${tag} NO read-only test server\r\n`); continue;
        }
        if (cmd === "CAPABILITY") { say(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`); continue; }
        if (cmd === "LOGIN") {
          const a = accounts.find((x) => x.user === args[0] && x.pass === args[1]);
          if (!a) { say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); continue; }
          user = a; say(`${tag} OK logged in\r\n`); continue;
        }
        if (cmd === "LOGOUT") { say(`* BYE\r\n${tag} OK\r\n`); sock.end(); continue; }
        if (!user) { say(`${tag} NO log in first\r\n`); continue; }
        if (cmd === "EXAMINE") {
          const f = user.folders[args[0]!];
          if (!f) { say(`${tag} NO [NONEXISTENT] no such folder\r\n`); continue; }
          folder = args[0]!;
          const max = Math.max(0, ...f.messages.map((x) => x.uid));
          say(`* ${f.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${f.uidvalidity}] ok\r\n* OK [UIDNEXT ${max + 1}] ok\r\n${tag} OK [READ-ONLY] examined\r\n`); continue;
        }
        if (cmd === "UID" && folder) {
          const f = user.folders[folder]!;
          const sub = (args[0] ?? "").toUpperCase();
          if (sub === "SEARCH") {
            let hits: FakeMessage[];
            if ((args[1] ?? "").toUpperCase() === "UID") {
              const [lo, hi] = args[2]!.split(":");
              const max = Math.max(0, ...f.messages.map((x) => x.uid));
              // As a real server: n:* always includes the last message.
              hits = f.messages.filter((x) => x.uid >= Number(lo) || (hi === "*" && x.uid === max));
            } else {
              const since = new Date(`${args[2]} UTC`);
              hits = f.messages.filter((x) => x.date >= new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())));
            }
            say(`* SEARCH ${hits.map((x) => x.uid).join(" ")}\r\n${tag} OK\r\n`); continue;
          }
          if (sub === "FETCH") {
            const uids = args[1]!.split(",").map(Number);
            const what = rest.slice(rest.indexOf("(")).toUpperCase();
            for (const u of uids) {
              const msg = f.messages.find((x) => x.uid === u);
              if (!msg) continue;
              if (what.includes("RFC822.SIZE")) say(`* ${u} FETCH (UID ${u} RFC822.SIZE ${msg.raw.length})\r\n`);
              else {
                if (!what.includes("PEEK")) mutating.push(`${line} (not PEEK: would set \\Seen)`);
                const body = what.includes("HEADER") ? msg.raw.subarray(0, msg.raw.indexOf("\r\n\r\n") + 4) : msg.raw;
                say(`* ${u} FETCH (UID ${u} BODY[${what.includes("HEADER") ? "HEADER" : ""}] {${body.length}}\r\n`); say(body); say(")\r\n");
              }
            }
            say(`${tag} OK\r\n`); continue;
          }
        }
        say(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on("error", () => null);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, log, mutating, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------- SMTP ----------

export async function startFakeSmtp(account: { user: string; pass: string } | null) {
  const received: { from: string; to: string[]; data: string; authed: boolean }[] = [];
  const server = netServer((sock) => {
    let buf = "", from = "", to: string[] = [], authed = false, inData = false, data = "";
    sock.write("220 fake SMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; received.push({ from, to, data: Buffer.from(data, "latin1").toString("utf8"), authed }); sock.write("250 2.0.0 Ok: queued as FAKE123456\r\n"); data = ""; continue; }
          data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n"; continue;
        }
        const u = line.toUpperCase();
        if (u.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (u.startsWith("AUTH PLAIN ")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\u0000");
          if (account && user === account.user && pass === account.pass) { authed = true; sock.write("235 ok\r\n"); } else sock.write("535 5.7.8 Authentication failed\r\n");
        } else if (u.startsWith("MAIL FROM:")) {
          if (account && !authed) { sock.write("530 5.7.0 Authentication required\r\n"); continue; }
          from = /<([^>]*)>/.exec(line)?.[1] ?? ""; to = []; sock.write("250 ok\r\n");
        } else if (u.startsWith("RCPT TO:")) { to.push(/<([^>]*)>/.exec(line)?.[1] ?? ""); sock.write("250 ok\r\n"); }
        else if (u === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (u === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("502 no\r\n");
      }
    });
    sock.on("error", () => null);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------- Microsoft Graph and Gmail over HTTP ----------

const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
const b64urlJson = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

export interface GraphMailbox { tenant: string; client: string; secret: string; mailbox: string; folders: Record<string, FakeMessage[]> }
export interface GmailMailbox { client_email: string; publicKeyPem: string; mailbox: string; labels: Record<string, { id: string; messages: FakeMessage[] }>; historyId: number }
export async function startFakeProviders(o: { graph: GraphMailbox[]; gmail: GmailMailbox[] }) {
  const requests: { method: string; path: string; auth: string | null }[] = [];
  const sent: { provider: "graph" | "gmail"; mailbox: string; body: unknown }[] = [];
  const tokens = new Map<string, { kind: "graph" | "gmail"; mailbox: string | null; client?: string; scope?: string }>();
  const deltas = new Map<string, { mailbox: string; folder: string; seen: Set<string> }>();
  let base = "";
  const server = httpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    requests.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization ? "Bearer ***" : null });
    const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const bearer = tokens.get(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    // Microsoft sign-in
    let m = /^\/([^/]+)\/oauth2\/v2.0\/token$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const p = new URLSearchParams(body);
      const box = o.graph.find((g) => g.tenant === decodeURIComponent(m![1]!) && g.client === p.get("client_id"));
      if (!box) return json(400, { error: "invalid_tenant", error_description: "AADSTS90002: Tenant not found." });
      if (p.get("client_secret") !== box.secret) return json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      const t = `gt_${randomBytes(12).toString("hex")}`; tokens.set(t, { kind: "graph", mailbox: null, client: box.client });
      return json(200, { access_token: t, token_type: "Bearer", expires_in: 3600 });
    }
    // Google sign-in: a JWT signed with the service account's key, checked here with its public key
    if (url.pathname === "/token" && req.method === "POST") {
      const p = new URLSearchParams(body);
      const [h, c, s] = String(p.get("assertion")).split(".");
      const claims = b64urlJson(c!);
      const box = o.gmail.find((g) => g.client_email === claims.iss && g.mailbox === claims.sub);
      if (!box) return json(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method." });
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(createPublicKey(box.publicKeyPem), Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      if (!ok) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const t = `ya_${randomBytes(12).toString("hex")}`; tokens.set(t, { kind: "gmail", mailbox: box.mailbox, scope: claims.scope });
      return json(200, { access_token: t, token_type: "Bearer", expires_in: 3600 });
    }
    // Graph
    m = /^\/v1.0\/users\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m) {
      if (!bearer || bearer.kind !== "graph") return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
      const box = o.graph.find((g) => g.mailbox === decodeURIComponent(m![1]!) && g.client === bearer.client);
      if (!box) return json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } });
      const rest = m[2] ?? "";
      if (req.method !== "GET" && !(req.method === "POST" && rest === "/sendMail")) return json(405, { error: { code: "Refused", message: "the test refuses any change" } });
      if (rest === "/sendMail") { sent.push({ provider: "graph", mailbox: box.mailbox, body: JSON.parse(body) }); res.writeHead(202); return res.end(); }
      if (rest === "") return json(200, { id: "user-1" });
      if (rest === "/mailFolders") {
        const name = /displayName eq '([^']*)'/.exec(url.searchParams.get("$filter") ?? "")?.[1];
        return json(200, { value: name && box.folders[name] ? [{ id: `fid-${name}` }] : [] });
      }
      if (rest === "/mailFolders/inbox/childFolders") return json(200, { value: [] });
      let f = /^\/mailFolders\/([^/]+)(\/messages\/delta)?$/.exec(rest);
      if (f) {
        const name = decodeURIComponent(f[1]!).replace(/^fid-/, "");
        const msgs = box.folders[name] ?? box.folders[name.toLowerCase()];
        if (!msgs) return json(404, { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
        if (!f[2]) return json(200, { totalItemCount: msgs.length });
        const token = randomBytes(6).toString("hex");
        deltas.set(token, { mailbox: box.mailbox, folder: name, seen: new Set(msgs.map((x) => x.id)) });
        return json(200, { value: msgs.map((x) => ({ id: x.id, receivedDateTime: x.date.toISOString() })), "@odata.deltaLink": `${base}/v1.0/users/${encodeURIComponent(box.mailbox)}/delta-next?token=${token}` });
      }
      if (rest === "/delta-next") {
        const d = deltas.get(url.searchParams.get("token") ?? "");
        if (!d) return json(410, { error: { code: "SyncStateNotFound", message: "gone" } });
        const msgs = box.folders[d.folder]!;
        const fresh = msgs.filter((x) => !d.seen.has(x.id));
        const token = randomBytes(6).toString("hex");
        deltas.set(token, { ...d, seen: new Set(msgs.map((x) => x.id)) });
        return json(200, { value: fresh.map((x) => ({ id: x.id })), "@odata.deltaLink": `${base}/v1.0/users/${encodeURIComponent(box.mailbox)}/delta-next?token=${token}` });
      }
      f = /^\/messages\/([^/]+)\/\$value$/.exec(rest);
      if (f) {
        const msg = Object.values(box.folders).flat().find((x) => x.id === decodeURIComponent(f![1]!));
        if (!msg) return json(404, { error: { code: "ErrorItemNotFound", message: "not found" } });
        res.writeHead(200, { "content-type": "message/rfc822" }); return res.end(msg.raw);
      }
      return json(404, { error: { code: "ErrorItemNotFound", message: "no such path" } });
    }
    // Gmail
    m = /^\/gmail\/v1\/users\/me(\/.*)$/.exec(url.pathname);
    if (m) {
      if (!bearer || bearer.kind !== "gmail") return json(401, { error: { code: 401, message: "Invalid Credentials" } });
      const box = o.gmail.find((g) => g.mailbox === bearer.mailbox)!;
      const rest = m[1]!;
      if (rest === "/messages/send" && req.method === "POST") {
        if (!String(bearer.scope).includes("gmail.send")) return json(403, { error: { code: 403, message: "Insufficient Permission" } });
        sent.push({ provider: "gmail", mailbox: box.mailbox, body: JSON.parse(body) }); return json(200, { id: "sent-1" });
      }
      if (req.method !== "GET") return json(405, { error: { code: 405, message: "the test refuses any change" } });
      if (!String(bearer.scope).includes("gmail.readonly")) return json(403, { error: { code: 403, message: "Insufficient Permission" } });
      if (rest === "/profile") return json(200, { emailAddress: box.mailbox, historyId: String(box.historyId) });
      if (rest === "/labels") return json(200, { labels: Object.entries(box.labels).map(([name, l]) => ({ id: l.id, name })) });
      let f = /^\/labels\/([^/]+)$/.exec(rest);
      if (f) { const l = Object.values(box.labels).find((x) => x.id === decodeURIComponent(f![1]!)); return l ? json(200, { id: l.id, messagesTotal: l.messages.length }) : json(404, { error: { code: 404, message: "Not Found" } }); }
      if (rest === "/messages") {
        const l = Object.values(box.labels).find((x) => x.id === url.searchParams.get("labelIds"));
        const after = Number(/after:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? 0) * 1000;
        return json(200, { messages: (l?.messages ?? []).filter((x) => x.date.getTime() > after).slice().reverse().map((x) => ({ id: x.id })) });
      }
      if (rest === "/history") {
        const start = Number(url.searchParams.get("startHistoryId"));
        if (start < box.historyId - 1000) return json(404, { error: { code: 404, message: "Requested entity was not found." } });
        const l = Object.values(box.labels).find((x) => x.id === url.searchParams.get("labelId"));
        const added = (l?.messages ?? []).filter((x) => Number(x.uid) > start);
        return json(200, { history: added.map((x) => ({ id: String(x.uid), messagesAdded: [{ message: { id: x.id, labelIds: [l!.id] } }] })), historyId: String(box.historyId) });
      }
      f = /^\/messages\/([^/]+)$/.exec(rest);
      if (f) {
        const msg = Object.values(box.labels).flatMap((x) => x.messages).find((x) => x.id === decodeURIComponent(f![1]!));
        if (!msg) return json(404, { error: { code: 404, message: "Not Found" } });
        return json(200, { id: msg.id, raw: msg.raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") });
      }
      return json(404, { error: { code: 404, message: "no such path" } });
    }
    json(404, { error: "no such path" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, requests, sent, close: () => new Promise<void>((r) => server.close(() => r())) };
}
