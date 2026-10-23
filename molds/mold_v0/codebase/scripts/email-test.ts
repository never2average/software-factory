// The email adapter (mold_v0-083; src/email.ts), offline: an embedded database, the test transport, no provider and
// no network. No real email is sent.
//   npm run test:email
//
// 1. One place sends: no file in src/ but src/email.ts talks to a provider or builds a message of a kind it sends;
//    the built-in sign-in asks the adapter for its code and invitation emails.
// 2. Transports: test (kept in the process, refused in production), none, resend without a key; each says in
//    emailStatus why it does or does not send, and with no transport only sign-in codes and invitations are on.
// 3. The profile turns notifications on: with none listed only sign-in codes, invitations and the test email go out;
//    a listed group goes out; APP_EMAIL_NOTIFICATIONS narrows the profile's list, never widens it.
// 4. The log: a row per message, with a hash and the domain of the address, never the address, a code or a secret;
//    the same key never sends twice.
// 5. Recipients and headers: one valid address per message; line breaks in a subject, a sender or a recipient never
//    reach the transport; a bad sender stops the message.
// 6. Links: every link is on the console's address from the environment (APP_CONSOLE_URL, else PUBLIC_URL); an
//    address that is not plain http(s) is ignored; a request's Host never matters.
// 7. Billing notices: off unless the profile lists billing; to the operator only; Stripe ids and addresses kept out.
// 8. The words (mold_v0-101): every email's copy is the build's: the profile's name and sender, the packs' run word,
//    the landing block's pitch (else the short description). A build with no packs and a declarative pack's build
//    never carry the session engine's words; a build with the session engine (a host pack's tables) keeps them, the
//    same text as before byte for byte.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.APP_EMAIL_PROVIDER = "test";
process.env.PUBLIC_URL = "https://api.example.test";
process.env.APP_CONSOLE_URL = "https://console.example.test";
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
    process.env.APP_EMAIL_PROVIDER = "none";
    s = await mail.emailStatus();
    assert.equal(s.connected, false);
    assert.match(s.summary, /^Not sending email \(No email transport.*Sign-in codes and invitations are the only kinds on/);
    const r0 = await mail.send({ kind: "sign_in_code", to: "nobody@example.org", idempotencyKey: `t:${STAMP}:none`, subject: "x", text: "x" });
    assert.equal(r0.status, "skipped");
    assert.match((await logOf(`t:${STAMP}:none`))!.error!, /No email transport/);
    process.env.APP_EMAIL_PROVIDER = "resend";
    s = await mail.emailStatus();
    assert.equal(s.provider, "resend");
    assert.equal(s.connected, false);
    assert.match(s.summary, /No Resend key|Resend provider is off/);
    process.env.APP_EMAIL_PROVIDER = "test";
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
    process.env.APP_EMAIL_NOTIFICATIONS = "usage,due_dates,billing";
    assert.deepEqual([...mail.notificationsOn()], ["due_dates"], "the environment narrows, never widens");
    process.env.APP_EMAIL_NOTIFICATIONS = "none";
    assert.equal((await due(`t:${STAMP}:due2`)).status, "skipped", "none: off whatever the profile says");
    assert.equal(mail.kindOn("sign_in_code").on, true, "sign-in stays on");
    delete process.env.APP_EMAIL_NOTIFICATIONS;
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
      process.env.APP_CONSOLE_URL = bad;
      assert.equal(mail.siteUrl(), "https://api.example.test", `${bad}: ignored, PUBLIC_URL instead`);
    }
    process.env.APP_CONSOLE_URL = "https://console.example.test/";
    assert.equal(mail.siteUrl(), "https://console.example.test");
    delete process.env.APP_CONSOLE_URL;
    assert.equal(mail.siteUrl(), "https://api.example.test", "no console address: PUBLIC_URL (one address serves both)");
    process.env.APP_CONSOLE_URL = "https://console.example.test";
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
  // ---------- 8. the words: the build's own, never another product's ----------
  {
    mail.setEmailProfileForTest({ notifications: ["access_requests", "library"] });
    const base = Date.now() % 1_000_000_000;
    let seq = 0;
    /** Every message a build's words give, by its idempotency key: the request emails, and a library decision. */
    const render = async (words: Parameters<typeof mail.setEmailWordsForTest>[0]) => {
      mail.setEmailWordsForTest(words);
      const id = base + ++seq * 10;
      const r = { id, email: "ana@customer.example", company: "Acme Corp", name: "Ana Diaz", product_url: null, message: null };
      await mail.requestReceived(r);
      await mail.requestDeclined({ ...r, id: id + 1 }, "Not this quarter");
      await mail.requestApproved({ ...r, id: id + 2 }, { account: "Acme Corp", invited: true });
      await mail.requestApproved({ ...r, id: id + 3 }, { account: "Acme Corp", invited: false });
      const sub = { id: `s${id}`, kind: "task" as const, title: "Fix a bug", org_id: 1, org_name: "Acme Corp", org_slug: "acme", created_by: "customer:ana@customer.example" };
      await mail.submissionAccepted(sub, { usd: 0, status: "none" });
      await mail.submissionDeclined({ ...sub, id: `t${id}` }, "A duplicate");
      await wait(20);
      const by = (k: string) => outbox().find((m) => m.idempotencyKey === k || m.idempotencyKey.startsWith(`${k}:`));
      const got = { received: by(`request:${id}:received`), declined: by(`request:${id + 1}:declined`), approved: by(`request:${id + 2}:approved`),
        approved_uninvited: by(`request:${id + 3}:approved`), alert: by(`request:${id}:alert`), accepted: by(`submission:s${id}:accepted`), sub_declined: by(`submission:t${id}:declined`) };
      for (const [k, m] of Object.entries(got)) assert.ok(m, `${k} went out`);
      mail.setEmailWordsForTest(undefined);
      return got as { [K in keyof typeof got]: NonNullable<(typeof got)[K]> };
    };
    const ENGINE = /simulation|developer product|coding agents|Claude Code|programming task/i;

    // A build with no packs: the profile's neutral words (passed in, so the test reads the same in a build copy with packs).
    const { PROFILE } = await import("../src/profile.js");
    assert.equal(mail.emailWords().product, PROFILE.name, "this build's words are its profile's");
    const neutral = { name: "Workspace", sender_name: "Workspace", short_description: "Connect an MCP client, run agents and read their results.", pitch: null, pack_words: [], engine: false };
    const zero = await render(neutral);
    const zw = mail.wordsFor(neutral);
    assert.deepEqual({ product: zw.product, run: zw.run, runs: zw.runs }, { product: "Workspace", run: "run", runs: "runs" });
    assert.equal(zero.approved.subject, "Welcome to Workspace");
    assert.ok(zero.approved.text.includes("now has a Workspace account."), zero.approved.text);
    assert.ok(zero.approved.text.includes("Workspace: Connect an MCP client, run agents and read their results."), "the pitch is the short description");
    assert.ok(zero.approved.text.includes("/app to connect Workspace to your AI assistant and start your first run."), zero.approved.text);
    for (const [k, m] of Object.entries(zero)) if (k !== "accepted" && k !== "sub_declined")
      assert.doesNotMatch(`${m.subject}\n${m.text}`, ENGINE, `${k}: no session-engine words in a build without it`);
    assert.ok(zero.received.text.endsWith("— Workspace") && zero.received.subject === "We got your request for Workspace");

    // A declarative pack's build: its run word, its landing pitch, its name (and its article).
    const decl = { name: "Atlas", sender_name: "Atlas", short_description: "Audits for your applications", pitch: "Atlas runs audits of your applications and tracks each finding to a fix-by date",
      pack_words: [{ workspace: "company", run: "audit" }], engine: false };
    const d = await render(decl);
    assert.equal(d.approved.subject, "Welcome to Atlas");
    assert.equal(d.approved.text, [
      "Hi Ana,",
      "Your request is approved: Acme Corp now has an Atlas account.",
      "Atlas runs audits of your applications and tracks each finding to a fix-by date.",
      "You'll get a separate invitation email to join Acme Corp. Accept it to create your sign-in, then open https://console.example.test/app to connect Atlas to your AI assistant and start your first audit.",
      "Questions? Reply to this email.",
      "— Atlas"].join("\n\n"));
    assert.ok(d.accepted.text.includes("where it now helps audits for everyone"), d.accepted.text);
    for (const [k, m] of Object.entries(d)) assert.doesNotMatch(`${m.subject}\n${m.text}`, /simulation|developer product|coding agents|Claude Code|Workspace/i, `${k}: only the pack's words`);
    assert.equal(mail.wordsFor({ ...decl, pitch: null }).pitch, "Atlas: Audits for your applications.", "no landing block: the short description");
    assert.equal(mail.wordsFor({ ...decl, pack_words: [{ run: "review", runs: "reviews done" }] }).runs, "reviews done", "a pack's own plural");
    assert.equal(mail.wordsFor({ ...decl, name: "Ledger" }).a_product, "a");
    assert.equal(mail.wordsFor({ ...decl, pitch: "Line one\nand <b>two</b>" }).pitch, "Line one and <b>two</b>.", "one line (the HTML escapes the rest)");
    assert.equal(mail.wordsFor({ ...decl, pack_words: [{ run: "x".repeat(80) }] }).run.length, 40, "a pack's word is bounded");

    // A build with the session engine (a host pack's tables) and no words of its own: the text it always had.
    const host = await render({ name: "Hostapp", sender_name: "Hostapp", short_description: "Some tagline", pitch: null, pack_words: [], engine: true });
    const was = (name: string) => ({
      received: ["We got your request for " + name, ["Hi Ana,", `Thanks for asking for access to ${name} for Acme Corp. We read every request ourselves and will get back to you by email, usually within a few working days.`,
        "If you want to add anything in the meantime, just reply to this email.", `— ${name}`]],
      declined: [`About your ${name} request`, ["Hi Ana,", `Thank you for your interest in ${name}. We can't offer Acme Corp access right now.`, "The reason: Not this quarter",
        "This isn't necessarily final. If things change on your side, or you think we've misread something, reply to this email and we'll take another look.", `— ${name}`]],
      approved: [`Welcome to ${name}`, ["Hi Ana,", `Your request is approved: Acme Corp now has a ${name} account.`,
        `${name} shows how AI coding agents treat your developer product: we run agents like Claude Code, Codex and Cursor on real programming tasks and report how often they choose your product, who they pick instead, and why.`,
        `You'll get a separate invitation email to join Acme Corp. Accept it to create your sign-in, then open https://console.example.test/app to connect ${name} to your AI assistant and run your first simulation.`,
        "Questions? Reply to this email.", `— ${name}`]],
      approved_uninvited: [`Welcome to ${name}`, ["Hi Ana,", `Your request is approved: Acme Corp now has a ${name} account.`,
        `${name} shows how AI coding agents treat your developer product: we run agents like Claude Code, Codex and Cursor on real programming tasks and report how often they choose your product, who they pick instead, and why.`,
        "We'll send you your connection details separately. Once you have them, https://console.example.test/app walks you through setup.",
        "Questions? Reply to this email.", `— ${name}`]],
      accepted: [`Your programming task is in ${name}'s library`, ["Hi,", `Thanks for sharing "Fix a bug". We reviewed it and added it to ${name}'s library, where it now helps simulations for everyone.`,
        "Your own copy stays yours and unchanged.", `— ${name}`]],
      sub_declined: [`About your programming task for ${name}'s library`, ["Hi,", `Thanks for sharing "Fix a bug". We've decided not to add it to ${name}'s library this time.`,
        "The reason: A duplicate", "Your own copy stays yours and keeps working as before. If you change it, you're welcome to submit it again.", `— ${name}`]],
    }) as Record<string, [string, string[]]>;
    for (const [k, [subject, text]] of Object.entries(was("Hostapp"))) {
      const m = host[k as keyof typeof host];
      assert.equal(m.subject, subject, `${k}: the subject it always had`);
      assert.equal(m.text, text.join("\n\n"), `${k}: the text it always had`);
    }
    assert.deepEqual({ run: mail.wordsFor({ name: "H", sender_name: "H", short_description: "", pitch: null, pack_words: [], engine: true }).runs }, { run: "simulations" },
      "the usage alert's run word with the session engine (new simulations can't start)");
    mail.setEmailProfileForTest(undefined);
    ok("words: the build's own name, sender, run word and pitch; no packs and a declarative pack carry no session-engine words; the engine's build keeps its text byte for byte");
  }
  await wait(50);
  console.log(`EMAIL ADAPTER TEST PASS (${n} groups)`);
  await db.close();
} finally {
  cleanup();
}
process.exit(0);
