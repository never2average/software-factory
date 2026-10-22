// The email adapter (mold_v0-083; src/email.ts), offline: an embedded database, the test transport, no provider and
// no network. No real email is sent.
//   npm run test:email
//
// 1. One place sends: no file in src/ but src/email.ts talks to a provider or builds a message of a kind it sends;
//    the built-in sign-in asks the adapter for its code and invitation emails.
// 2. Transports: test (kept in the process, refused in production), none, resend without a key; each says in
//    emailStatus why it does or does not send, and with no transport only sign-in codes and invitations are on.
// 3. The profile turns notifications on: with none listed only sign-in codes, invitations and the test email go out;
//    a listed group goes out; OCTILLION_EMAIL_NOTIFICATIONS narrows the profile's list, never widens it.
// 4. The log: a row per message, with a hash and the domain of the address, never the address, a code or a secret;
//    the same key never sends twice.
// 5. Recipients and headers: one valid address per message; line breaks in a subject, a sender or a recipient never
//    reach the transport; a bad sender stops the message.
// 6. Links: every link is on the console's address from the environment (OCTILLION_CONSOLE_URL, else PUBLIC_URL); an
//    address that is not plain http(s) is ignored; a request's Host never matters.
// 7. Billing notices: off unless the profile lists billing; to the operator only; Stripe ids and addresses kept out.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.OCTILLION_EMAIL_PROVIDER = "test";
process.env.PUBLIC_URL = "https://api.example.test";
process.env.OCTILLION_CONSOLE_URL = "https://console.example.test";
const { cleanup, STAMP } = await import("./lib/test-world.js");

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const mail = await import("../src/email.js");
  const settings = await import("../src/settings.js");
  const logOf = async (key: string) => (await db.query<{ kind: string; to_hash: string; to_domain: string; subject: string; status: string; error: string | null; meta: any }>(
    "SELECT kind, to_hash, to_domain, subject, status, error, meta FROM email_log WHERE idempotency_key = $1", [key]))[0];
  const outbox = () => mail.testOutbox();
  const last = () => outbox().at(-1)!;

  // ---------- 1. one place sends ----------
  {
    const SRC = path.resolve(import.meta.dirname, "..", "src");
    const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".generated.ts"));
    const offenders: string[] = [];
    for (const f of files) {
      if (f === "email.ts") continue;
      const t = readFileSync(path.join(SRC, f), "utf8");
      // A provider's API, a provider's key, or a message of a kind only the adapter sends, built anywhere else.
      if (/api\.resend\.com|RESEND_API_URL|useCredential\(\s*["']resend|nodemailer|smtp\./i.test(t) && !/^keyvault/.test(f) && f !== "about-routes.ts") offenders.push(`${f}: talks to an email provider`);
      for (const k of mail.EMAIL_KINDS) if (new RegExp(`kind:\\s*["']${k}["']`).test(t)) offenders.push(`${f}: builds a ${k} email`);
      if (/sendLater\(\s*\{|\bmail\.send\(/.test(t)) offenders.push(`${f}: sends a message it built itself`);
    }
    assert.deepEqual(offenders, [], "only src/email.ts talks to a provider or builds a message");
    const auth = readFileSync(path.join(SRC, "builtin-auth.ts"), "utf8");
    assert.match(auth, /mail\.signInCode\(/);
    assert.match(auth, /mail\.invitation\(/);
    assert.doesNotMatch(auth, /subject:/, "the built-in sign-in writes no email of its own");
    ok("one place sends: no file but src/email.ts talks to a provider or builds a message; sign-in asks the adapter for its code and invitation");
  }

  // ---------- 2. transports, and what the app says ----------
  {
    let s = await mail.emailStatus();
    assert.equal(s.provider, "test");
    assert.equal(s.connected, true);
    assert.deepEqual(s.notifications, []);
    assert.deepEqual([...s.on].sort(), ["invitation", "sign_in_code", "test"], "the build's profile turns on no notification");
    assert.match(s.summary, /sign-in codes and invitations only/);
    process.env.OCTILLION_EMAIL_PROVIDER = "none";
    s = await mail.emailStatus();
    assert.equal(s.connected, false);
    assert.match(s.summary, /^Not sending email \(No email transport.*Sign-in codes and invitations are the only kinds on/);
    const r0 = await mail.send({ kind: "sign_in_code", to: "nobody@example.org", idempotencyKey: `t:${STAMP}:none`, subject: "x", text: "x" });
    assert.equal(r0.status, "skipped");
    assert.match((await logOf(`t:${STAMP}:none`))!.error!, /No email transport/);
    process.env.OCTILLION_EMAIL_PROVIDER = "resend";
    s = await mail.emailStatus();
    assert.equal(s.provider, "resend");
    assert.equal(s.connected, false);
    assert.match(s.summary, /No Resend key|Resend provider is off/);
    process.env.OCTILLION_EMAIL_PROVIDER = "test";
    process.env.NODE_ENV = "production";
    const before = outbox().length;
    const r1 = await mail.send({ kind: "sign_in_code", to: "nobody@example.org", idempotencyKey: `t:${STAMP}:prod`, subject: "x", text: "x" });
    assert.equal(r1.status, "skipped");
    assert.equal(outbox().length, before, "the test transport keeps nothing in production");
    assert.match((await mail.emailStatus()).summary, /not used in production/);
    delete process.env.NODE_ENV;
    // The switch in Agent configuration still turns everything off.
    await settings.setSettings("test", { EMAILS_ENABLED: "off" });
    await settings.refreshSettings();
    assert.equal((await mail.send({ kind: "sign_in_code", to: "nobody@example.org", idempotencyKey: `t:${STAMP}:off`, subject: "x", text: "x" })).status, "skipped");
    assert.match((await mail.emailStatus()).summary, /switched off/);
    await settings.setSettings("test", { EMAILS_ENABLED: "on" });
    await settings.refreshSettings();
    ok("transports: test (never in production), none, resend without a key; each says why it does or does not send; the switch still turns email off");
  }

  // ---------- 3. the profile turns notifications on ----------
  {
    mail.setEmailProfileForTest(undefined); // the build's own profile: no notifications
    const due = (key: string) => mail.send({ kind: "due_soon", to: "owner@example.org", idempotencyKey: key, subject: "Due", text: "Due soon" });
    let r = await due(`t:${STAMP}:due1`);
    assert.equal(r.status, "skipped");
    assert.match((await logOf(`t:${STAMP}:due1`))!.error!, /does not list due_dates/);
    assert.equal((await mail.dueSoon(1, { area: "a", label: "Things", within_days: 7, roles: ["owner"], day: "2030-01-01", items: [{ key: "k", title: "t", due_on: "2030-01-02" }], batch: ["1"] })).recipients, 0,
      "due-date emails off: nothing asked of the workspace's people");
    assert.deepEqual(await mail.checkBudget(1), { threshold: null, sent: 0 }, "usage alerts off: nothing read");
    for (const k of ["request_received", "submission_alert", "budget_80", "budget_100", "billing_notice"] as const)
      assert.equal(mail.kindOn(k).on, false, `${k} is off by default`);
    for (const k of ["sign_in_code", "invitation", "test"] as const) assert.equal(mail.kindOn(k).on, true, `${k} is always on`);
    mail.setEmailProfileForTest({ notifications: ["due_dates"] });
    r = await due(`t:${STAMP}:due1`); // the same message, tried again now that it is on
    assert.equal(r.status, "sent");
    assert.equal(last().kind, "due_soon");
    assert.equal((await due(`t:${STAMP}:due1`)).status, "duplicate", "sent once: the same key never sends twice");
    assert.equal(mail.kindOn("budget_80").on, false, "only the groups listed");
    process.env.OCTILLION_EMAIL_NOTIFICATIONS = "usage,due_dates,billing";
    assert.deepEqual([...mail.notificationsOn()], ["due_dates"], "the environment narrows, never widens");
    process.env.OCTILLION_EMAIL_NOTIFICATIONS = "none";
    assert.equal((await due(`t:${STAMP}:due2`)).status, "skipped", "none: off whatever the profile says");
    assert.equal(mail.kindOn("sign_in_code").on, true, "sign-in stays on");
    delete process.env.OCTILLION_EMAIL_NOTIFICATIONS;
    mail.setEmailProfileForTest({ notifications: ["due_dates", "not_a_group"] });
    assert.deepEqual([...mail.notificationsOn()], ["due_dates"], "an unknown group turns nothing on");
    mail.setEmailProfileForTest(undefined);
    ok("notifications: only sign-in codes, invitations and the test email unless the profile lists a group; the environment only narrows");
  }

  // ---------- 4. the log ----------
  {
    const code = "48213907";
    await mail.signInCode({ id: `${STAMP}1`, to: "Person@Example.org", code, minutes: 10 });
    const row = (await logOf(`sign-in-code:${STAMP}1`))!;
    assert.equal(row.status, "sent");
    assert.equal(row.to_domain, "example.org");
    assert.equal(row.to_hash, mail.hashAddress("person@example.org"));
    const all = JSON.stringify(await db.query("SELECT * FROM email_log"));
    assert.ok(!all.includes("person@example.org") && !all.includes("Person@Example.org"), "no address in the log");
    assert.ok(!all.includes(code), "no code in the log");
    const m = last();
    assert.equal(m.to, "person@example.org");
    assert.ok(m.text.includes(code) && !m.subject.includes(code), "the code is in the text, never the subject");
    await mail.send({ kind: "test", to: "ok@example.org", idempotencyKey: `t:${STAMP}:subjaddr`, subject: "New access request: Acme (boss@acme.example)", text: "x" });
    const logged = (await logOf(`t:${STAMP}:subjaddr`))!.subject;
    assert.ok(logged.startsWith("New access request: Acme") && logged.includes("*@…") && !logged.includes("acme.example"), `an address typed into a name never reaches the log: ${logged}`);
    assert.ok(last().subject.includes("boss@acme.example"), "the email itself keeps its subject");
    ok("the log: a hash and the domain, never the address or the code; the code only in the text");
  }

  // ---------- 5. recipients and headers ----------
  {
    const bad = ["a@b.example\r\nBcc: spy@evil.example", "a@b.example, spy@evil.example", "a@b.example;spy@evil.example", "<a@b.example>", "not-an-address", ""];
    for (const [i, to] of bad.entries()) {
      const before = outbox().length;
      const r = await mail.send({ kind: "test", to, idempotencyKey: `t:${STAMP}:bad${i}`, subject: "x", text: "x" });
      assert.equal(r.status, "skipped", `refused: ${JSON.stringify(to)}`);
      assert.equal(outbox().length, before);
    }
    await mail.send({ kind: "test", to: "ok@example.org", idempotencyKey: `t:${STAMP}:subj`, subject: "Hello\r\nBcc: spy@evil.example\u2028X-Evil: 1", text: "Body\r\nwith lines" });
    assert.ok(!/[\r\n\u2028]/.test(last().subject) && last().subject.startsWith("Hello"), `one line: ${JSON.stringify(last().subject)}`);
    assert.equal(last().text, "Body\r\nwith lines", "the text keeps its lines");
    assert.match((await logOf(`t:${STAMP}:subj`))!.subject, /^Hello Bcc/);
    for (const [i, from] of ["Evil <a@b.example>\r\nBcc: spy@evil.example", "a@b.example, c@d.example", "Name <a@b.example> <c@d.example>"].entries()) {
      // Written past the settings page (which refuses these too): the adapter does not trust the stored value.
      await assert.rejects(settings.setSettings("test", { EMAIL_FROM: from }), /must be Name <address> or an address/);
      await db.query(`INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('EMAIL_FROM', $1, now(), 'test')
                      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(from)]);
      await settings.refreshSettings();
      assert.equal(settings.settingText("EMAIL_FROM"), from);
      const before = outbox().length;
      const r = await mail.send({ kind: "test", to: "ok@example.org", idempotencyKey: `t:${STAMP}:from${i}`, subject: "x", text: "x" });
      assert.equal(r.status, "skipped", `a sender ${JSON.stringify(from)} stops the message`);
      assert.equal(outbox().length, before);
    }
    await db.query("DELETE FROM platform_settings WHERE key = 'EMAIL_FROM'");
    await settings.refreshSettings();
    ok("recipients and headers: one valid address, no line break reaches a subject, a recipient or the sender");
  }

  // ---------- 6. links ----------
  {
    await mail.invitation({ id: `inv_${STAMP}`, to: "new@example.org", account: "Acme\r\nBcc: x@evil.example", accountSlug: "acme", role: "Member", google: false, days: 7 });
    const inv = last();
    assert.equal(inv.to, "new@example.org");
    assert.ok(inv.text.includes("https://console.example.test/auth/sign-in?redirect_url=%2Fapp"), inv.text);
    assert.ok(!/api\.example\.test/.test(inv.text), "the console's address, not the API's");
    assert.ok(!/[\r\n]/.test(inv.subject));
    assert.ok(inv.html.includes('href="https://console.example.test/auth/sign-in?redirect_url=%2Fapp"'), "the console's link is a link");
    await mail.invitation({ id: `inv2_${STAMP}`, to: "new2@example.org", account: "Verify at https://evil.example/login now", accountSlug: "acme", role: "Member", google: false, days: 7 });
    assert.ok(last().text.includes("https://evil.example/login") && !last().html.includes('href="https://evil.example'), "a URL typed into a name stays plain text, never a link");
    for (const bad of ["javascript:alert(1)", "https://user:pw@console.example.test", "https://console.example.test/?next=//evil.example", "https://console.example.test/#x", "ftp://console.example.test", "//evil.example"]) {
      process.env.OCTILLION_CONSOLE_URL = bad;
      assert.equal(mail.siteUrl(), "https://api.example.test", `${bad}: ignored, PUBLIC_URL instead`);
    }
    process.env.OCTILLION_CONSOLE_URL = "https://console.example.test/";
    assert.equal(mail.siteUrl(), "https://console.example.test");
    delete process.env.OCTILLION_CONSOLE_URL;
    assert.equal(mail.siteUrl(), "https://api.example.test", "no console address: PUBLIC_URL (one address serves both)");
    process.env.OCTILLION_CONSOLE_URL = "https://console.example.test";
    ok("links: the console's address from the environment only; anything but a plain http(s) address is ignored");
  }

  // ---------- 7. billing notices ----------
  {
    await settings.setSettings("test", { EMAIL_ADMIN_TO: "ops@operator.example" });
    await settings.refreshSettings();
    const notice = { charge_id: `ch${STAMP}`, run_id: `run_${STAMP}`, kind: "charge" as const, account: "acme", amount: "2.50 USD", tries: 20,
      error: "Stripe answered 400: No such customer: 'cus_Q1w2E3r4' (billing@customer.example)" };
    assert.deepEqual(await mail.billingNotice(notice), [], "off unless the profile lists billing");
    mail.setEmailProfileForTest({ notifications: ["billing"] });
    const before = outbox().length;
    const out = await mail.billingNotice(notice);
    assert.equal(out.length, 1);
    assert.equal(outbox().length, before + 1);
    const m = last();
    assert.equal(m.to, "ops@operator.example", "to the operator only");
    assert.equal(m.kind, "billing_notice");
    assert.ok(m.text.includes(`run_${STAMP}`) && m.text.includes("https://console.example.test/admin"));
    assert.ok(!m.text.includes("cus_Q1w2E3r4") && !m.text.includes("billing@customer.example"), `no Stripe id or address: ${m.text}`);
    assert.equal((await mail.billingNotice(notice))[0]!.status, "duplicate", "once per charge");
    mail.setEmailProfileForTest(undefined);
    ok("billing notices: off unless the profile lists billing; to the operator only, once per charge, without Stripe ids or addresses");
  }
  await wait(50);
  console.log(`EMAIL ADAPTER TEST PASS (${n} groups)`);
  await db.close();
} finally {
  cleanup();
}
process.exit(0);
