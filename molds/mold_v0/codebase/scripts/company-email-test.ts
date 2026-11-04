// A company's own email (mold_v0-192; src/company-email.ts, src/email-intake.ts, src/mail-protocols.ts,
// src/email-routes.ts), offline: an embedded database, the HTTP server behind a fake Clerk, and stand-in mail servers on
// 127.0.0.1 (scripts/lib/fake-mail.ts: an IMAP server, an SMTP server, Microsoft Graph and Gmail). No real mailbox is
// read and no real email is sent.
//   npm run test:company-email
//
// 1. Zero packs: nothing mounted, no tool, no poll. definePack refuses an intake into a shared area, an area fed by a
//    repository, another pack's area, a field the area lacks or of the wrong type.
// 2. MIME: encoded words, RFC 2231 file names, quoted-printable, nested multiparts, HTML only, no Message-ID.
// 3. Hosts: a private address is refused unless the operator allows it by name; security none only when allowed.
// 4. The sender (SMTP, Graph, Gmail): owners only; write-only secrets (no answer carries any part); Test signs in and
//    sends to the stand-ins; a wrong password says auth_failed with its hint. A workspace's notification goes out through
//    its own sender; another workspace's through the app's default; a paused sender falls back to the default.
// 5. The intake over IMAP: records with the pack's fields, attachments sealed in the object store (no plaintext at rest),
//    only the declared folder, read only (EXAMINE, BODY.PEEK; no SELECT/STORE/COPY/MOVE/EXPUNGE), each message once
//    (a second poll, a UIDVALIDITY change, the same Message-ID in another mailbox), too many / too large attachments
//    listed and not kept, a wrong password backs off and marks the mailbox.
// 6. Graph and Gmail intakes against their stand-ins: delta and history, dedup across all three mailboxes.
// 7. Tenant isolation: B's poll writes B's records only; B cannot read A's mailboxes, records or attachments (HTTP, MCP).
// 8. Reading: list_intake_items (MCP) under the area's read rule; an attachment download for A's people only.
// 9. Credentials never returned: every HTTP and MCP answer, every table as text, the object store's files and this
//    process's logs hold no secret (canaries); the email log of a workspace send holds no provider error text.
// 10. Row-level security: the catalog check passes with the three tables; deleting a workspace removes its rows.
// 8b (mold_v0-220). Files on the record: the body (sanitised HTML, text) and every attachment kept as sealed files,
//    previewed and downloaded at signed links for the area's readers only; the one-off backfill of earlier messages.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { mime, startFakeImap, startFakeProviders, startFakeSmtp, type FakeMessage } from "./lib/fake-mail.js";

const logged: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return write(chunk, ...rest); };
}
const seen: string[] = [];
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
process.env.APP_EMAIL_ALLOW_INSECURE = "1";
process.env.APP_EMAIL_ALLOWED_PRIVATE_HOSTS = "127.0.0.1,localhost";
process.env.APP_EMAIL_PROVIDER = "test";
process.env.APP_EMAIL_INTAKE = "off";
process.env.APP_SCHEDULER = "off";

const canary = (l: string) => `canary-${l}-${randomBytes(10).toString("hex")}`;
const C = { SMTP_A: canary("smtp-a"), IMAP_A: canary("imap-a"), IMAP_B: canary("imap-b"), GRAPH: canary("graph"), GRAPH_SEND: canary("graph-send") };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const GMAIL_KEY = JSON.stringify({ type: "service_account", client_email: "intake@proj.iam.example", private_key: PRIV, private_key_id: "kid-1" });
const keyLine = PRIV.split("\n")[5]!;
const SECRETS = [...Object.values(C), keyLine];
const needles = SECRETS.flatMap((v) => [v, Buffer.from(v).toString("base64"), JSON.stringify(v).slice(1, -1)]);
const hits = (t: string | Buffer) => needles.filter((n) => t.includes(n)).length;

const day = 86_400_000;
const NOW = new Date();
const att = (name: string, text: string) => ({ name, type: "application/pdf", data: Buffer.from(`%PDF-1.4 ${text}`) });

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const ce = await import("../src/company-email.js");
  const intake = await import("../src/email-intake.js");
  const wire = await import("../src/mail-protocols.js");
  const { emailAppRouter } = await import("../src/email-routes.js");
  const email = await import("../src/email.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");

  // ---------- 1. zero packs, and what definePack refuses ----------
  assert.equal(ce.companyEmailWired(), false);
  assert.equal(emailAppRouter().stack.length, 0, "nothing mounted at /api/email");
  assert.deepEqual(intake.intakeTools(), [], "no intake tool");
  assert.equal((await intake.pollIntake()).ran, false, "no poll");
  {
    const areas = [
      { name: "pk_mail", label: "Mail", role: "source", scope: "workspace", fields: [{ name: "sender", label: "From" }, { name: "num", label: "N", type: "number" }] },
      { name: "pk_shared", label: "Shared", role: "source", scope: "platform", fields: [{ name: "xx", label: "X" }] },
    ];
    const pack = (email: unknown) => definePack({ id: "pk", recordAreas: areas as never, email: email as never });
    assert.throws(() => pack({ intake: { area: "pk_shared" } }), /shared \(platform\)/);
    assert.throws(() => pack({ intake: { area: "elsewhere" } }), /not one of this pack's record areas/);
    assert.throws(() => pack({ intake: { area: "pk_mail", fields: { from: "nope" } } }), /has no field nope/);
    assert.throws(() => pack({ intake: { area: "pk_mail", fields: { from: "num" } } }), /goes into a text field/);
    assert.throws(() => pack({ intake: { area: "pk_mail", folder: 'IN"BOX' } }), /no quote or backslash/);
    assert.throws(() => pack({}), /a sender, an intake, or both/);
    assert.doesNotThrow(() => pack({ sender: { allow: true }, intake: { area: "pk_mail", fields: { from: "sender", attachment_count: "num" } } }));
    console.log("✓ zero packs: nothing mounted, no tool, no poll; definePack refuses a shared, foreign or mis-mapped intake area");
  }

  // ---------- 2. MIME ----------
  {
    const raw = Buffer.from([
      "From: =?UTF-8?B?w4lsaXNl?= <Elise@Regulator.Example>", "To: a@x.example, \"B, C\" <b@x.example>", "Subject: =?utf-8?Q?Circular_n=C2=B0_12?= =?utf-8?Q?_final?=",
      "Message-ID: <abc.123@regulator.example>", "Date: Mon, 02 Nov 2026 10:00:00 +0000", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="X"', "",
      "--X", 'Content-Type: multipart/alternative; boundary="Y"', "", "--Y", "Content-Type: text/html; charset=utf-8", "", "<p>Hello <b>there</b></p>", "--Y--",
      "--X", "Content-Type: application/pdf", "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9ponse%20finale.pdf", "Content-Transfer-Encoding: base64", "",
      Buffer.from("PDFDATA").toString("base64"), "--X", "Content-Type: text/plain; charset=utf-8", "Content-Disposition: attachment; filename=\"../../etc/passwd\"", "", "x", "--X--", ""].join("\r\n"));
    const m = wire.parseMail(raw);
    assert.equal(m.subject, "Circular n° 12 final");
    assert.equal(m.from, "elise@regulator.example"); assert.equal(m.from_name, "Élise");
    assert.deepEqual(m.to, ["a@x.example", "b@x.example"]);
    assert.equal(m.message_id, "abc.123@regulator.example");
    assert.equal(m.text, "Hello there");
    assert.deepEqual(m.attachments.map((a) => a.name), ["réponse finale.pdf", "passwd"]);
    assert.equal(m.attachments[0]!.data.toString(), "PDFDATA");
    const qp = wire.parseMail(Buffer.from("Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 =\r\nau lait\r\n"));
    assert.equal(qp.text, "Café au lait"); assert.equal(qp.message_id, null);
    assert.notEqual(wire.messageKey(null, "1:a"), wire.messageKey(null, "1:b"));
    assert.equal(wire.messageKey("<X@Y>", "1:a"), wire.messageKey("x@y", "2:b"), "the Message-ID decides, not where it was read");
    console.log("✓ MIME: encoded words, RFC 2231 names, quoted-printable, nested parts, HTML as text, file names without directories");
  }

  // ---------- 3. hosts ----------
  {
    const allowed = process.env.APP_EMAIL_ALLOWED_PRIVATE_HOSTS;
    process.env.APP_EMAIL_ALLOWED_PRIVATE_HOSTS = "";
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "::1"]) await assert.rejects(wire.resolveHost(h), /private address/, h);
    process.env.APP_EMAIL_ALLOWED_PRIVATE_HOSTS = allowed;
    assert.equal(await wire.resolveHost("127.0.0.1"), "127.0.0.1");
    delete process.env.APP_EMAIL_ALLOW_INSECURE;
    assert.throws(() => wire.checkSecurity("none"), /refused/);
    process.env.APP_EMAIL_ALLOW_INSECURE = "1";
    assert.equal(wire.checkSecurity("none"), "none");
    console.log("✓ hosts: private addresses refused unless allowed by name; no TLS only when allowed (tests)");
  }

  // ---------- the stand-ins ----------
  const msg = (uid: number, o: Parameters<typeof mime>[0], id = `m${uid}`): FakeMessage => ({ uid, raw: mime(o), id, date: o.date ?? NOW });
  const SHARED_ID = `shared-${STAMP}@regulator.example`;
  const aInbox: FakeMessage[] = [
    msg(1, { from: "Regulator <notices@regulator.example>", subject: "Circular 1", text: "Please comply by Friday.", messageId: `c1-${STAMP}@regulator.example`, attachments: [att("circular-1.pdf", "first")] }),
    msg(2, { from: "customer@acme-bank.example", subject: "Audit request", text: "Body two", html: "<p>Body <b>two</b></p>", messageId: SHARED_ID }),
    msg(3, { from: "old@regulator.example", subject: "Too old", text: "old", date: new Date(NOW.getTime() - 30 * day) }),
    msg(4, { from: "big@regulator.example", subject: "Many files", text: "files", attachments: [att("a.pdf", "a"), att("b.pdf", "b"), att("c.pdf", "c"), { name: "huge.bin", type: "application/octet-stream", data: Buffer.alloc(300 * 1024, 1) }, att("e.pdf", "e")] }),
  ];
  const aArchive: FakeMessage[] = [msg(1, { from: "x@y.example", subject: "Archived: never read", text: "no" })];
  const bInbox: FakeMessage[] = [msg(1, { from: "b-reg@regulator.example", subject: "B only", text: "for B", messageId: `b1-${STAMP}@regulator.example` })];
  const imap = await startFakeImap([
    { user: "intake-a", pass: C.IMAP_A, folders: { INBOX: { uidvalidity: 7, messages: aInbox }, Archive: { uidvalidity: 8, messages: aArchive } } },
    { user: "intake-b", pass: C.IMAP_B, folders: { INBOX: { uidvalidity: 3, messages: bInbox } } },
  ]);
  const smtp = await startFakeSmtp({ user: "notices@a.example", pass: C.SMTP_A });
  const graphMsgs: FakeMessage[] = [
    msg(1, { from: "graph@regulator.example", subject: "Via Graph", text: "graph body", messageId: `g1-${STAMP}@regulator.example`, attachments: [att("g.pdf", "graph")] }, "AAMk-1"),
    msg(2, { from: "customer@acme-bank.example", subject: "Audit request (copy)", text: "again", messageId: SHARED_ID }, "AAMk-2"),
  ];
  const gmailMsgs: FakeMessage[] = [msg(11, { from: "gm@regulator.example", subject: "Via Gmail", text: "gmail body", messageId: `gm1-${STAMP}@regulator.example` }, "gm-1")];
  const providers = await startFakeProviders({
    graph: [{ tenant: "acme.example", client: "client-1", secret: C.GRAPH, mailbox: "legal@a.example", folders: { inbox: graphMsgs } },
            { tenant: "acme.example", client: "client-send", secret: C.GRAPH_SEND, mailbox: "notices@a.example", folders: {} }],
    gmail: [{ client_email: "intake@proj.iam.example", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), mailbox: "legal@a.example", labels: { INBOX: { id: "INBOX", messages: gmailMsgs } }, historyId: 10 },
            { client_email: "intake@proj.iam.example", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), mailbox: "notices@a.example", labels: {}, historyId: 1 }],
  });
  process.env.APP_EMAIL_GRAPH_URL = providers.url; process.env.APP_EMAIL_MS_LOGIN_URL = providers.url;
  process.env.APP_EMAIL_GMAIL_URL = providers.url; process.env.APP_EMAIL_GOOGLE_TOKEN_URL = `${providers.url}/token`;

  // ---------- the pack ----------
  const fixture = definePack({
    id: "mailfix",
    recordAreas: [{ name: "mf_mail", label: "Inbound mail", role: "source", scope: "workspace", fields: [
      { name: "sender", label: "From" }, { name: "sender_domain", label: "Domain" }, { name: "sent_on", label: "Sent", type: "date" },
      { name: "summary", label: "Summary" }, { name: "files", label: "Files", type: "json" }, { name: "file_count", label: "Files kept", type: "number" },
      { name: "mailbox", label: "Mailbox" }, { name: "kind", label: "Kind", type: "enum", options: ["regulator", "customer", "other"] },
    ] }] as never,
    email: { sender: { allow: true }, intake: { area: "mf_mail", label: "Regulatory mail", folder: "INBOX", body_chars: 200, backfill_days: 7,
      fields: { from: "sender", from_domain: "sender_domain", date: "sent_on", body: "summary", attachments: "files", attachment_count: "file_count", mailbox: "mailbox" },
      set: { kind: "other" }, attachments: { max_bytes: 200 * 1024, max_count: 4 } } },
  });
  setPacksForTest([{ manifest: { id: "mailfix", name: "Mail fixture", version: "1", entry: null, migrations: null, words: {}, dir: "packs/mailfix" }, definition: fixture }]);
  assert.equal(ce.companyEmailWired(), true);
  const A = (await createOrg(`Mail A ${STAMP}`)).org, B = (await createOrg(`Mail B ${STAMP}`)).org;

  const http = await startHttp();
  const req = async (method: string, p: string, h: Record<string, string>, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const buf = Buffer.from(await r.arrayBuffer());
    seen.push(buf.toString("utf8"));
    const text = buf.toString("utf8");
    return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })(), bytes: buf, headers: r.headers };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  try {
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A), viewerA = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");

    // ---------- 4. the sender ----------
    {
      const v = await req("GET", "/api/email", bearer(memberA));
      assert.equal(v.status, 200); assert.equal(v.body.can_manage, false); assert.equal(v.body.sender, undefined, "a member sees no settings");
      const smtpSettings = { from_address: "notices@a.example", from_name: "A Compliance", host: "127.0.0.1", port: smtp.port, security: "none", username: "notices@a.example" };
      assert.equal((await req("PUT", "/api/email/sender", bearer(memberA), { provider: "smtp", settings: smtpSettings, secret: C.SMTP_A })).status, 403, "members cannot set it");
      assert.equal((await req("PUT", "/api/email/sender", { cookie: `__session=${ownerA}` }, { provider: "smtp", settings: smtpSettings, secret: C.SMTP_A })).status, 403, "a cookie write needs the CSRF header");
      assert.equal((await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "smtp", settings: smtpSettings })).status, 400, "a user name needs a password");
      const put = await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "smtp", settings: smtpSettings, secret: C.SMTP_A });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.sender.secret_set, true); assert.equal(put.body.effective, "workspace");
      assert.equal(hits(JSON.stringify(put.body)), 0, "the answer carries no part of the secret");
      const t1 = await req("POST", "/api/email/sender/test", bearer(ownerA), { to: "me@a.example" });
      assert.equal(t1.body.ok, true, JSON.stringify(t1.body)); assert.equal(smtp.received.length, 1);
      assert.ok(smtp.received[0]!.authed && smtp.received[0]!.to[0] === "me@a.example" && /Subject: Test email/.test(smtp.received[0]!.data));
      // A notification for A's people goes out through A's sender; B's through the app's default (the test transport).
      email.setEmailProfileForTest({ notifications: ["due_dates", "usage"] });
      email.clearTestOutbox();
      const ra = await email.send({ kind: "due_soon", to: "owner@a.example", org: A.orgId, subject: "Due soon", text: "Two things are due.", idempotencyKey: `t:a:${STAMP}` });
      const rb = await email.send({ kind: "due_soon", to: "owner@b.example", org: B.orgId, subject: "Due soon", text: "One thing is due.", idempotencyKey: `t:b:${STAMP}` });
      assert.equal(ra.status, "sent"); assert.equal(rb.status, "sent");
      assert.equal(smtp.received.length, 2); assert.ok(/From: "A Compliance" <notices@a\.example>/.test(smtp.received[1]!.data) && smtp.received[1]!.to[0] === "owner@a.example");
      assert.deepEqual(email.testOutbox().map((m) => m.to), ["owner@b.example"], "B has no sender: the app's own sends");
      // Paused: the app's default again. Then a wrong password: the Test says auth_failed, with what to change.
      assert.equal((await req("PATCH", "/api/email/sender", bearer(ownerA), { enabled: false })).body.effective, "app");
      await email.send({ kind: "due_soon", to: "owner@a.example", org: A.orgId, subject: "Due", text: "x", idempotencyKey: `t:a2:${STAMP}` });
      assert.equal(smtp.received.length, 2); assert.equal(email.testOutbox().length, 2);
      await req("PATCH", "/api/email/sender", bearer(ownerA), { enabled: true });
      await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "smtp", settings: smtpSettings, secret: "wrong-password-1" });
      const bad = await req("POST", "/api/email/sender/test", bearer(ownerA), {});
      assert.equal(bad.body.ok, false); assert.equal(bad.body.kind, "auth_failed"); assert.match(bad.body.hint, /app password/);
      const failed = await email.send({ kind: "due_soon", to: "owner@a.example", org: A.orgId, subject: "Due", text: "x", idempotencyKey: `t:a3:${STAMP}` });
      assert.equal(failed.status, "failed"); assert.match(String(failed.error), /own sender \(smtp\) did not send it \(auth_failed\)/);
      const [logRow] = await db.query<{ error: string }>("SELECT error FROM email_log WHERE id = $1", [failed.id]);
      assert.ok(!/535|Authentication/.test(logRow!.error), "the operator's email log says only that the workspace's sender failed");
      await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "smtp", settings: smtpSettings, secret: C.SMTP_A });
      // Graph and Gmail senders, against their stand-ins.
      const g = await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "graph", settings: { from_address: "notices@a.example", tenant_id: "acme.example", client_id: "client-send" }, secret: C.GRAPH_SEND });
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.equal((await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "gmail", settings: { from_address: "notices@a.example" } })).status, 400, "a new provider needs its own secret");
      const gt = await req("POST", "/api/email/sender/test", bearer(ownerA), { to: "me@a.example" });
      assert.equal(gt.body.ok, true, JSON.stringify(gt.body));
      assert.equal(providers.sent.at(-1)!.provider, "graph");
      const gm = await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "gmail", settings: { from_address: "notices@a.example" }, secret: GMAIL_KEY });
      assert.equal(gm.status, 200, JSON.stringify(gm.body));
      assert.equal((await req("POST", "/api/email/sender/test", bearer(ownerA), { to: "me@a.example" })).body.ok, true);
      const last = providers.sent.at(-1)!;
      assert.equal(last.provider, "gmail"); assert.match(Buffer.from(String((last.body as { raw: string }).raw), "base64url").toString(), /Subject: Test email/);
      await req("PUT", "/api/email/sender", bearer(ownerA), { provider: "smtp", settings: smtpSettings, secret: C.SMTP_A });
      console.log("✓ sender: owners only; write-only secret; Test signs in and sends (SMTP, Graph, Gmail stand-ins); A's notices through A's sender, B's through the app's; paused falls back; a wrong password: auth_failed with its hint, the operator's log without the provider's words");
    }

    // ---------- 5. the intake over IMAP ----------
    const imapSettings = (user: string) => ({ label: "Regulatory inbox", host: "127.0.0.1", port: imap.port, security: "none", username: user, mailbox: `${user}@company.example` });
    const ia = await req("PUT", "/api/email/inboxes", bearer(ownerA), { provider: "smtp", settings: imapSettings("intake-a"), secret: C.IMAP_A });
    assert.equal(ia.status, 200, JSON.stringify(ia.body));
    assert.equal(hits(JSON.stringify(ia.body)), 0);
    const ib = await req("PUT", "/api/email/inboxes", bearer(ownerB), { provider: "smtp", settings: imapSettings("intake-b"), secret: C.IMAP_B });
    assert.equal(ib.status, 200);
    assert.equal((await req("PUT", "/api/email/inboxes", bearer(memberA), { provider: "smtp", settings: imapSettings("intake-a"), secret: C.IMAP_A })).status, 403);
    {
      const t = await req("POST", `/api/email/inboxes/${ia.body.id}/test`, bearer(ownerA));
      assert.equal(t.body.ok, true, JSON.stringify(t.body)); assert.equal(t.body.messages, 4); assert.equal(t.body.folder, "INBOX");
      assert.equal((await req("POST", `/api/email/inboxes/${ia.body.id}/test`, bearer(ownerB))).status, 404, "B cannot reach A's mailbox");
      const r1 = await intake.pollIntake(new Date());
      assert.equal(r1.ran, true); assert.equal(r1.inboxes, 2); assert.equal(r1.failed, 0, JSON.stringify(r1));
      assert.equal(r1.taken, 4, "A: three within the backfill window; B: one");
      const listA = await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }));
      const byTitle = Object.fromEntries(listA.records.map((r) => [r.title, r]));
      assert.deepEqual(Object.keys(byTitle).sort(), ["Audit request", "Circular 1", "Many files"]);
      const c1 = byTitle["Circular 1"]!;
      assert.equal(c1.data.sender, "notices@regulator.example"); assert.equal(c1.data.sender_domain, "regulator.example");
      assert.equal(c1.data.summary, "Please comply by Friday."); assert.equal(c1.data.mailbox, "Regulatory inbox"); assert.equal(c1.data.kind, "other");
      assert.equal(c1.data.file_count, 1); assert.deepEqual((c1.data.files as { name: string }[]).map((f) => f.name), ["circular-1.pdf"]);
      assert.match(c1.key, /^mail-[0-9a-f]{24}$/);
      assert.equal(byTitle["Audit request"]!.data.summary, "Body two", "the plain part, not the HTML");
      const many = byTitle["Many files"]!.data.files as { name: string; skipped?: string }[];
      assert.deepEqual(many.map((f) => [f.name, f.skipped ?? null]), [["a.pdf", null], ["b.pdf", null], ["c.pdf", null], ["huge.bin", "larger than 200 KB"], ["e.pdf", "more than 4 attachments"]]);
      assert.equal(byTitle["Many files"]!.data.file_count, 3);
      const listB = await withTenant(B.orgId, () => rec.listFor(B.orgId, "mf_mail", { limit: 50 }));
      assert.deepEqual(listB.records.map((r) => r.title), ["B only"], "B's poll wrote B's records only");
      // Read only, and only the declared folder.
      assert.deepEqual(imap.mutating, [], "no SELECT, STORE, COPY, MOVE, EXPUNGE or non-PEEK fetch");
      assert.ok(imap.log.some((l) => l.line.includes("EXAMINE") && l.line.includes("INBOX")));
      assert.ok(!imap.log.some((l) => /Archive/.test(l.line)), "the Archive folder is never opened");
      // Each message once: a second poll takes nothing; a new message is taken; a UIDVALIDITY change re-reads and drops repeats.
      await db.query("UPDATE workspace_email_inboxes SET next_poll_at = now() - interval '1 minute'");
      assert.equal((await intake.pollIntake(new Date())).taken, 0);
      aInbox.push(msg(5, { from: "new@regulator.example", subject: "New one", text: "new", messageId: `c5-${STAMP}@regulator.example` }));
      await db.query("UPDATE workspace_email_inboxes SET next_poll_at = now() - interval '1 minute'");
      assert.equal((await intake.pollIntake(new Date())).taken, 1);
      (imap as unknown as { log: unknown[] }).log.length = 0;
      // The folder rebuilt (a new UIDVALIDITY, new UIDs): everything is read again, nothing is taken twice.
      const rebuilt = aInbox.map((m2, i) => ({ ...m2, uid: 100 + i }));
      aInbox.splice(0, aInbox.length, ...rebuilt);
      await db.query("UPDATE workspace_email_inboxes SET next_poll_at = now() - interval '1 minute', cursor = jsonb_set(cursor, '{uidvalidity}', '\"6\"') WHERE org_id = $1", [A.orgId]);
      const again = await intake.pollIntake(new Date());
      assert.equal(again.taken, 0); assert.ok(again.duplicates >= 4, JSON.stringify(again));
      // A wrong password: the mailbox shows the error and backs off; the other mailbox goes on.
      await req("PUT", "/api/email/inboxes", bearer(ownerB), { id: ib.body.id, provider: "smtp", settings: imapSettings("intake-b"), secret: "wrong-password-2" });
      const fail = await intake.pollIntake(new Date());
      assert.equal(fail.failed, 1);
      const [bRow] = await db.query<{ status: string; last_error_kind: string; failures: number; next_poll_at: Date }>("SELECT status, last_error_kind, failures, next_poll_at FROM workspace_email_inboxes WHERE id = $1", [ib.body.id]);
      assert.equal(bRow!.status, "error"); assert.equal(bRow!.last_error_kind, "auth_failed"); assert.equal(bRow!.failures, 1);
      assert.ok(new Date(bRow!.next_poll_at).getTime() >= Date.now() + 4 * 60_000, "backed off (at least its interval)");
      const shown = await req("GET", "/api/email", bearer(ownerB));
      assert.equal(shown.body.inboxes[0].status, "error"); assert.match(shown.body.inboxes[0].hint, /Sign-in failed/);
      await req("PUT", "/api/email/inboxes", bearer(ownerB), { id: ib.body.id, provider: "smtp", settings: imapSettings("intake-b"), secret: C.IMAP_B });
      const [kept] = await db.query<{ cursor: { uidvalidity?: string } }>("SELECT cursor FROM workspace_email_inboxes WHERE id = $1", [ib.body.id]);
      assert.equal(kept!.cursor.uidvalidity, "3", "a new secret for the same mailbox keeps its read position");
      // The vault locked: nothing is polled.
      const key = process.env.APP_VAULT_KEY; delete process.env.APP_VAULT_KEY;
      assert.equal((await intake.pollIntake(new Date())).ran, false);
      process.env.APP_VAULT_KEY = key;
      console.log("✓ IMAP intake: records with the pack's fields, attachments kept (too large or past the count listed, not kept), only INBOX, read only (EXAMINE, BODY.PEEK, nothing changed), each message once (re-poll, new UIDVALIDITY), a wrong password backs off, a locked vault polls nothing");
    }

    // ---------- 6. Graph and Gmail intakes ----------
    {
      const g = await req("PUT", "/api/email/inboxes", bearer(ownerA), { provider: "graph", settings: { label: "Legal (365)", tenant_id: "acme.example", client_id: "client-1", mailbox: "legal@a.example" }, secret: C.GRAPH });
      assert.equal(g.status, 200, JSON.stringify(g.body));
      const gm = await req("PUT", "/api/email/inboxes", bearer(ownerA), { provider: "gmail", settings: { label: "Legal (Gmail)", mailbox: "legal@a.example" }, secret: GMAIL_KEY });
      assert.equal(gm.status, 200, JSON.stringify(gm.body));
      assert.equal((await req("POST", `/api/email/inboxes/${g.body.id}/test`, bearer(ownerA))).body.messages, 2);
      assert.equal((await req("POST", `/api/email/inboxes/${gm.body.id}/test`, bearer(ownerA))).body.messages, 1);
      const r = await intake.pollIntake(new Date());
      assert.equal(r.failed, 0, JSON.stringify(r));
      assert.equal(r.taken, 2, "Graph's first and Gmail's; the shared Message-ID was already in from IMAP");
      assert.ok(r.duplicates >= 1);
      graphMsgs.push(msg(3, { from: "graph2@regulator.example", subject: "Graph later", text: "later", messageId: `g3-${STAMP}@regulator.example` }, "AAMk-3"));
      gmailMsgs.push(msg(12, { from: "gm2@regulator.example", subject: "Gmail later", text: "later", messageId: `gm2-${STAMP}@regulator.example` }, "gm-2"));
      await db.query("UPDATE workspace_email_inboxes SET next_poll_at = now() - interval '1 minute' WHERE org_id = $1", [A.orgId]);
      const r2 = await intake.pollIntake(new Date());
      assert.equal(r2.taken, 2, "the delta link and the history id bring only the new ones");
      assert.ok(!providers.requests.some((x) => x.method !== "GET" && x.method !== "POST"), "no PATCH or DELETE on a provider");
      assert.ok(!providers.requests.some((x) => x.method === "POST" && /\/(move|modify|trash|batchModify)/.test(x.path)));
      const titles = (await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }))).records.map((x) => x.title);
      assert.equal(titles.filter((t) => t === "Audit request" || t === "Audit request (copy)").length, 1, "one record for one Message-ID");
      console.log("✓ Graph and Gmail intakes (stand-ins): delta link and history, read only, one record per Message-ID across IMAP, Graph and Gmail");
    }

    // ---------- 7 and 8. isolation and reading ----------
    {
      const listA = await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }));
      const c1 = listA.records.find((r) => r.title === "Circular 1")!;
      const dl = await req("GET", `/api/email/attachments/mf_mail/${c1.key}/1`, bearer(viewerA));
      assert.equal(dl.status, 200); assert.equal(dl.bytes.toString(), "%PDF-1.4 first");
      assert.match(String(dl.headers.get("content-disposition")), /attachment; filename="circular-1.pdf"/);
      assert.equal(dl.headers.get("content-type"), "application/octet-stream");
      assert.equal((await req("GET", `/api/email/attachments/mf_mail/${c1.key}/1`, bearer(ownerB))).status, 404, "B cannot download A's attachment");
      assert.equal((await req("GET", `/api/email/attachments/mf_mail/${c1.key}/9`, bearer(ownerA))).status, 404);
      // Attachments are sealed at rest: no object file holds the plaintext.
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const objects = walk(path.join(TMP, "objects")).filter((f) => f.includes(`${path.sep}.mail${path.sep}`));
      assert.ok(objects.length >= 5, `attachments stored (${objects.length})`);
      for (const f of objects) assert.ok(!readFileSync(f).includes("%PDF-1.4"), `${f} is sealed`);
      assert.ok(objects.every((f) => f.includes(`org-${A.orgId}${path.sep}`)), "every attachment so far is A's, under A's own prefix");
      // MCP: list_intake_items, A's items to A only.
      const ca = await connect({ ...A, role: "viewer" } as never), cb = await connect({ ...B, role: "owner" } as never);
      const la = await ca.call("list_intake_items", {}); seen.push(JSON.stringify(la));
      const items = la.structuredContent?.items ?? JSON.parse(la.content[0]!.text).items;
      assert.ok(items.length >= 7 && items.some((x: { subject: string; attachments: { name: string }[] }) => x.subject === "Circular 1" && x.attachments[0]!.name === "circular-1.pdf"), JSON.stringify(la).slice(0, 400));
      const lb = await cb.call("list_intake_items", {}); seen.push(JSON.stringify(lb));
      const bItems = lb.structuredContent?.items ?? JSON.parse(lb.content[0]!.text).items;
      assert.deepEqual(bItems.map((x: { subject: string }) => x.subject), ["B only"]);
      const tools = (await ca.client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes("list_intake_items"));
      await ca.close(); await cb.close();
      // B's owner cannot see or change A's mailboxes.
      const gb = await req("GET", "/api/email", bearer(ownerB));
      assert.equal(gb.body.inboxes.length, 1); assert.equal(gb.body.sender, null);
      assert.equal((await req("PATCH", `/api/email/inboxes/${ia.body.id}`, bearer(ownerB), { enabled: false })).status, 404);
      assert.equal((await req("DELETE", `/api/email/inboxes/${ia.body.id}`, bearer(ownerB))).status, 404);
      // The platform operator has no door: no admin route, no admin MCP tool.
      const staff = await http.adminToken("owner");
      assert.equal((await req("GET", "/api/admin/email", bearer(staff))).status, 404);
      const { adminTools } = await import("../src/admin-mcp.js");
      assert.ok(!Object.keys(adminTools()).some((n) => /mail|inbox|intake/.test(n)));
      console.log("✓ isolation: B's records, mailboxes, attachments and MCP items are B's; attachments sealed at rest; downloads for A's readers only; list_intake_items per workspace; no admin route or tool");
    }

    // ---------- 8b. files on the record (mold_v0-220): the body and every attachment, and the one-off backfill ----------
    {
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const filesPack = definePack({
        id: "mailfix",
        recordAreas: [{ name: "mf_mail", label: "Inbound mail", role: "source", scope: "workspace", fields: [
          { name: "sender", label: "From" }, { name: "sender_domain", label: "Domain" }, { name: "sent_on", label: "Sent", type: "date" },
          { name: "summary", label: "Summary" }, { name: "files", label: "Files", type: "json" }, { name: "file_count", label: "Files kept", type: "number" },
          { name: "mailbox", label: "Mailbox" }, { name: "kind", label: "Kind", type: "enum", options: ["regulator", "customer", "other"] },
          { name: "body", label: "Message", type: "file", multiple: true }, { name: "attachments", label: "Attachments", type: "file", multiple: true },
        ] }] as never,
        email: { sender: { allow: true }, intake: { area: "mf_mail", label: "Regulatory mail", folder: "INBOX", body_chars: 200, backfill_days: 7,
          fields: { from: "sender", from_domain: "sender_domain", date: "sent_on", body: "summary", attachments: "files", attachment_count: "file_count", mailbox: "mailbox", body_file: "body", attachment_files: "attachments" },
          set: { kind: "other" }, attachments: { max_bytes: 200 * 1024, max_count: 4 } } },
      });
      // definePack refuses attachment_files into a field of one file.
      assert.throws(() => definePack({ id: "pk2", recordAreas: [{ name: "m2", label: "M", role: "source", scope: "workspace", fields: [{ name: "a", label: "A", type: "file" }] }] as never,
        email: { intake: { area: "m2", fields: { attachment_files: "a" } } } as never }), /holds one file/);
      setPacksForTest([{ manifest: { id: "mailfix", name: "Mail fixture", version: "1", entry: null, migrations: null, words: {}, dir: "packs/mailfix" }, definition: filesPack }]);
      const before = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_email_messages WHERE org_id = $1 AND files IS NULL", [A.orgId]);
      assert.ok(before[0]!.n >= 5, "the messages taken in so far wait for the backfill");
      const HTML = '<p>Hello <b>A</b></p><script>alert("x")</script><img src="https://tracker.example/p.png" onerror="alert(1)"><a href="javascript:alert(1)">bad</a> <a href="https://regulator.example/c">circular</a>';
      aInbox.push(msg(300, { from: "files@regulator.example", subject: "With files", text: "Plain body with files", html: HTML, messageId: `wf-${STAMP}@regulator.example`,
        attachments: [att("notice.pdf", "noticebody"), { name: "chart.png", type: "image/png", data: PNG }, { name: "terms.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: Buffer.from("PK\u0003\u0004docx") }] }));
      await db.query("UPDATE workspace_email_inboxes SET next_poll_at = now() - interval '1 minute' WHERE org_id = $1", [A.orgId]);
      const r = await intake.pollIntake(new Date());
      assert.equal(r.failed, 0, JSON.stringify(r)); assert.equal(r.taken, 1);
      const wf = (await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }))).records.find((x) => x.title === "With files")!;
      const body = wf.data.body as { name: string; content_type: string; object: string }[], files = wf.data.attachments as { name: string; content_type: string }[];
      assert.deepEqual(body.map((f) => [f.name, f.content_type]), [["message.html", "text/html"], ["message.txt", "text/plain"]]);
      assert.deepEqual(files.map((f) => [f.name, f.content_type]), [["notice.pdf", "application/pdf"], ["chart.png", "image/png"], ["terms.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]]);
      assert.ok(body.every((f) => /^rf_[0-9a-f]{32}$/.test(f.object)), "references, not bytes");
      assert.ok(!JSON.stringify(wf).includes("noticebody") && !JSON.stringify(wf).includes("Hello <b>"), "the record never holds a file's bytes");
      const [led] = await db.query<{ files: string }>("SELECT files FROM workspace_email_messages WHERE org_id = $1 AND record_key = $2", [A.orgId, wf.key]);
      assert.equal(led!.files, "kept");
      // The record's card: four files, each with its preview, for A's readers only.
      const cards = await req("GET", `/api/records/mf_mail/${wf.key}/files`, bearer(viewerA));
      assert.equal(cards.status, 200, JSON.stringify(cards.body));
      assert.deepEqual(cards.body.files.map((c: { name: string; preview: string | null }) => [c.name, c.preview]),
        [["message.html", "html"], ["message.txt", "text"], ["notice.pdf", "pdf"], ["chart.png", "image"], ["terms.docx", null]]);
      const card = (name: string) => cards.body.files.find((c: { name: string }) => c.name === name);
      const html = await req("GET", card("message.html").preview_url, bearer(viewerA));
      assert.equal(html.status, 200); assert.match(String(html.headers.get("content-type")), /^text\/html/);
      assert.ok(!/<script|onerror|javascript:/i.test(html.bytes.toString()), "scripts, handlers and javascript: links are gone");
      assert.ok(!html.bytes.toString().includes("tracker.example") && html.bytes.toString().includes("data-blocked-src"), "the remote image is blocked");
      assert.match(String(html.headers.get("content-security-policy")), /sandbox/); assert.doesNotMatch(String(html.headers.get("content-security-policy")), /img-src[^;]*https:/);
      assert.match(html.bytes.toString(), /href="https:\/\/regulator\.example\/c" target="_blank" rel="noopener noreferrer nofollow"/);
      const withImages = await req("GET", `${card("message.html").preview_url}&images=1`, bearer(viewerA));
      assert.ok(withImages.bytes.toString().includes('src="https://tracker.example/p.png"')); assert.match(String(withImages.headers.get("content-security-policy")), /img-src data: https:/);
      const pdf = await req("GET", card("notice.pdf").preview_url, bearer(viewerA));
      assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.equal(pdf.bytes.toString(), "%PDF-1.4 noticebody");
      const dl = await req("GET", card("notice.pdf").download_url, bearer(viewerA));
      assert.equal(dl.headers.get("content-type"), "application/octet-stream"); assert.match(String(dl.headers.get("content-disposition")), /^attachment; filename="notice.pdf"/);
      assert.equal(card("terms.docx").preview_url, null, "no preview for a docx: download only");
      assert.equal((await req("GET", `/api/records/mf_mail/${wf.key}/files`, bearer(ownerB))).status, 404, "B never sees A's record's files");
      assert.equal((await req("GET", card("notice.pdf").preview_url, bearer(ownerB))).status, 403, "A's link opens nothing for B");
      assert.equal((await req("GET", card("notice.pdf").preview_url.replace(/t=[^&]+/, "t=forged"), bearer(viewerA))).status, 403, "a forged link opens nothing");
      // The mail API's download reads the same one copy.
      const old = await req("GET", `/api/email/attachments/mf_mail/${wf.key}/2`, bearer(viewerA));
      assert.equal(old.status, 200); assert.ok(old.bytes.equals(PNG));
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const recFiles = walk(path.join(TMP, "objects")).filter((f) => f.includes(`${path.sep}.records${path.sep}`));
      assert.equal(recFiles.length, 5, "five files kept for the record");
      for (const f of recFiles) { const b = readFileSync(f); assert.ok(!b.includes("noticebody") && !b.includes("Hello") && !b.includes("Plain body"), `${f} is sealed`); }

      // The one-off backfill: earlier messages read again from their mailboxes; their records get the body and attachments.
      const c1Before = (await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }))).records.find((x) => x.title === "Circular 1")!;
      assert.equal(c1Before.data.body, undefined);
      const mailObjectsBefore = walk(path.join(TMP, "objects")).filter((f) => f.includes(`${path.sep}.mail${path.sep}`)).length;
      const bf = await intake.backfillMessageFiles(new Date(), { limit: 10 });
      assert.equal(bf.failed, 0, JSON.stringify(bf)); assert.ok(bf.inboxes >= 3 && bf.filled >= 5, JSON.stringify(bf));
      const c1 = (await withTenant(A.orgId, () => rec.listFor(A.orgId, "mf_mail", { limit: 50 }))).records.find((x) => x.title === "Circular 1")!;
      assert.deepEqual((c1.data.body as { name: string }[]).map((f) => f.name), ["message.txt"]);
      assert.deepEqual((c1.data.attachments as { name: string }[]).map((f) => f.name), ["circular-1.pdf"]);
      assert.equal(c1.data.sender, "notices@regulator.example", "its other fields as they were");
      const c1dl = await req("GET", `/api/email/attachments/mf_mail/${c1.key}/1`, bearer(viewerA));
      assert.equal(c1dl.bytes.toString(), "%PDF-1.4 first", "the mail API reads the backfilled copy");
      assert.ok(walk(path.join(TMP, "objects")).filter((f) => f.includes(`${path.sep}.mail${path.sep}`)).length < mailObjectsBefore, "the old .mail copies are removed");
      const left = await db.query<{ files: string | null; n: number }>("SELECT files, count(*)::int AS n FROM workspace_email_messages WHERE org_id = $1 GROUP BY files ORDER BY files", [A.orgId]);
      assert.ok(!left.some((x) => x.files === null), `nothing waits any more: ${JSON.stringify(left)}`);
      assert.equal((await intake.backfillMessageFiles(new Date(), { limit: 10 })).inboxes, 0, "it does not run again");
      assert.deepEqual(imap.mutating, [], "the backfill read the mailbox read only");
      console.log(`✓ files on the record: the body (sanitised HTML and text) and every attachment kept as sealed files, previewed and downloaded at signed links for A's readers only (HTML without scripts, remote images blocked until asked; a docx download only); the backfill gave ${bf.filled} earlier records their files from their mailboxes, once`);
    }

    // ---------- 9. credentials never returned ----------
    {
      assert.equal(seen.reduce((n, t) => n + hits(t), 0), 0, "no HTTP or MCP answer holds a secret");
      const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
      let dbHits = 0;
      for (const t of tables) for (const r of await db.query(`SELECT * FROM "${t.table_name}"`)) dbHits += hits(JSON.stringify(r));
      assert.equal(dbHits, 0, "no table holds a secret in the clear");
      const files = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); })(TMP)
        .filter((f) => statSync(f).size < 64 * 1024 * 1024);
      assert.equal(files.reduce((n, f) => n + hits(readFileSync(f)), 0), 0, "no file (the database's, the object store's) holds one");
      assert.equal(hits(logged.join("")), 0, "nothing logged holds one");
      console.log(`✓ credentials never returned: 0 secret hits in ${seen.length} answers, ${tables.length} tables, ${files.length} files and the logs`);
    }

    // ---------- 10. row-level security and deletion ----------
    {
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), [], "the catalog check passes");
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, [], "the live probe passes");
      const { deleteOrg } = await import("../src/tenancy.js");
      await deleteOrg(B.orgId);
      for (const t of ["workspace_email_senders", "workspace_email_inboxes", "workspace_email_messages"])
        assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [B.orgId]))[0]!.n, 0, t);
      console.log(`✓ row-level security in place (catalog, live probe: ${probe.checked} checks); deleting a workspace removes its mailboxes and ledger`);
    }
  } finally {
    await http.close(); await imap.close(); await smtp.close(); await providers.close();
  }
  console.log("company email: all passed");
} finally {
  cleanup();
}
process.exit(0);
