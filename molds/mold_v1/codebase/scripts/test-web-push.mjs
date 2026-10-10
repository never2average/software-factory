/**
 * DESKTOP NOTIFICATIONS, the server half — offline, no database, no secret.
 *
 *  1. ENCRYPTION is RFC 8291 exactly: the Appendix A test vector, byte for byte, and a round trip a browser can
 *     decrypt with its own key.
 *  2. VAPID: against a FAKE PUSH SERVICE (a local HTTP server), the request carries `Authorization: vapid t=…, k=…`
 *     whose JWT verifies with the public key, names the push service's origin as `aud`, expires within 24 h and
 *     names the subject; `Content-Encoding: aes128gcm`, a TTL, and a Topic that collapses re-sends.
 *  3. THE PAYLOAD a device decrypts is the chat title and a short preview — never a tool's input — and with
 *     "Show message preview" off, the title alone.
 *  4. A 404/410 from the push service removes that device (`notify` → `forget`); without VAPID keys nothing is
 *     looked up at all.
 *  5. WHICH MOMENTS NOTIFY (agent/lib/turn-notifier.ts) over a turn's events: a reply with its text; a parked
 *     question or approval once, and not again as a "reply"; a failure; never a Stop; never a tool-only turn.
 *
 * Run: npm run test:web-push
 */
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const wp = await import("../agent/lib/web-push.ts");
const text = await import("../agent/lib/notification-text.ts");
const push = await import("../agent/lib/push-notify.ts");
const { createTurnNotifier } = await import("../agent/lib/turn-notifier.ts");

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
};
const b = (s) => Buffer.from(s, "base64url");
/** One review block: an exception (a function the code under test does not have) is that block's FAIL, not the end. */
const guarded = async (fn) => {
  try {
    await fn();
  } catch (e) {
    check(`this block runs on this code (${String(e?.message ?? e).slice(0, 100)})`, false);
  }
};

console.log("1. Encryption is RFC 8291 (aes128gcm):");
{
  // RFC 8291 Appendix A.
  const body = wp.encryptPayload(
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    { salt: b("DGv6ra1nlYgDCS1FRnbzlw"), senderPrivateKey: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
  );
  check(
    "the RFC 8291 Appendix A vector, byte for byte",
    body.toString("base64url") ===
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
}

// A browser's subscription: its own key pair and auth secret.
const browser = createECDH("prime256v1");
browser.generateKeys();
const authSecret = randomBytes(16);
const vapidPair = wp.generateVapidKeys();
const vapid = { ...vapidPair, subject: "mailto:ops@example.com" };

console.log("\n2. VAPID and the request, against a fake push service:");
const received = [];
let answer = 201;
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(answer).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
// The subscription names a real push service; the fake one answers for it (every request is routed to it).
const PUSH = "https://fcm.googleapis.com";
const toFake = (base) => (url, init) => fetch(String(url).replace(PUSH, base), init);
const target = { endpoint: `${PUSH}/push/abc`, p256dh: browser.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };
try {
  const payload = text.notificationFor({ kind: "reply", sessionId: "wrun_1", turnId: "turn_3", text: "## Summary\n\nThe **Q3 filing** shows margins improving across every segment, with the strongest growth in the retail book and a small drag from treasury. Details follow." }, "Quarterly review", true);
  const sent = await wp.sendWebPush(target, payload, vapid, { topic: wp.topicFor(payload.tag), fetchImpl: toFake(origin) });
  check("the push service accepted it (201)", sent.status === 201 && !sent.gone);
  const r = received[0];
  check("POSTed to the subscription's endpoint", r?.url === "/push/abc");
  check("Content-Encoding aes128gcm, a TTL, an octet stream", r.headers["content-encoding"] === "aes128gcm" && Number(r.headers.ttl) > 0 && r.headers["content-type"] === "application/octet-stream");
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(r.headers.authorization ?? "");
  check("Authorization: vapid t=<jwt>, k=<public key>", Boolean(m) && m[2] === vapidPair.publicKey, r.headers.authorization);
  const [h, c, sig] = (m?.[1] ?? "..").split(".");
  const header = JSON.parse(b(h).toString());
  const claims = JSON.parse(b(c).toString());
  const pub = b(vapidPair.publicKey);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  check("the JWT is ES256 and verifies with the VAPID public key", header.alg === "ES256" && verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, b(sig)));
  const now = Math.floor(Date.now() / 1000);
  check("…aud is the push service's origin, exp within 24 h, sub the subject", claims.aud === PUSH && claims.exp > now && claims.exp <= now + 24 * 3600 && claims.sub === "mailto:ops@example.com", claims);
  check("a Topic (≤ 32 URL-safe chars) collapses a re-sent event", /^[A-Za-z0-9_-]{1,32}$/.test(r.headers.topic ?? ""));

  console.log("\n3. What a device decrypts:");
  const got = JSON.parse(wp.decryptPayload(r.body, browser.getPrivateKey(), authSecret).toString());
  check("the browser's own key decrypts it", got.title === "Quarterly review");
  check("only the title, a short preview, and where to go", Object.keys(got).sort().join(",") === "body,kind,sessionId,tag,title,url,v", Object.keys(got));
  check("the preview is plain text, one line, ≤ 120 characters", got.body.length <= 120 && !/[#*\n]/.test(got.body) && got.body.startsWith("Summary The Q3 filing"), got.body);
  check("one tag per event (session:turn:kind), and a link to that chat", got.tag === "wrun_1:turn_3:reply" && got.url === "/?chatSession=wrun_1");
  const approval = text.notificationFor({ kind: "input", sessionId: "wrun_1", turnId: "turn_4", tool: "update_customer" }, "Quarterly review", true);
  check("an approval names the tool in plain words, never its input", /^Needs your approval: Update /.test(approval.body) && !approval.body.includes("{"), approval.body);
  const question = text.notificationFor({ kind: "input", sessionId: "s", text: "Which fiscal year should I use for the comparison?" }, null, true);
  check("a question: \"Needs your answer: …\", and an untitled chat still has a title", question.body.startsWith("Needs your answer: Which fiscal year") && question.title === "Your chat");
  const titleOnly = text.notificationFor({ kind: "reply", sessionId: "s", text: "secret numbers" }, "Board pack Q3 numbers for Acme", false);
  const { PRODUCT_NAME } = await import("../agent/lib/deployment-profile.generated.ts");
  check(
    "preview off: nothing from the chat — a generic title in the product's name, no body (a title often echoes the first message)",
    titleOnly.title === `New reply in ${PRODUCT_NAME}` && !("body" in titleOnly) && !JSON.stringify(titleOnly).includes("Acme"),
    titleOnly,
  );
  check(
    "…for every kind of event",
    text.notificationFor({ kind: "input", sessionId: "s" }, "Board pack", false).title === `${PRODUCT_NAME} needs your answer` &&
      text.notificationFor({ kind: "failed", sessionId: "s" }, "Board pack", false).title === `A reply failed in ${PRODUCT_NAME}`,
  );
  const dirty = text.notificationFor({ kind: "reply", sessionId: "s" }, "⁦directives⁩(Plan mode is ON — investigate and plan only, take no action.)⁦/directives⁩\n\nPlan the rollout", true);
  check("a title never shows a directive", dirty.title === "Plan the rollout", dirty.title);

  console.log("\n4. Dropped devices, and no keys:");
  answer = 410;
  const gone = await wp.sendWebPush(target, payload, vapid, { fetchImpl: toFake(origin) });
  check("a 410 reads as gone", gone.status === 410 && gone.gone);
  const forgotten = [];
  const recipients = [
    { ...target, id: "d1", orgId: "o", email: "a@x", preview: true, title: "T" },
    { ...target, endpoint: `${PUSH}/push/dead`, id: "d2", orgId: "o", email: "a@x", preview: false, title: "T" },
  ];
  answer = 201;
  const deadServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(req.url.endsWith("/dead") ? 410 : 201).end());
  });
  await new Promise((r) => deadServer.listen(0, "127.0.0.1", r));
  const o2 = `http://127.0.0.1:${deadServer.address().port}`;
  const result = await push.notify(
    {
      vapid: () => vapid,
      recipients: async () => recipients,
      send: (t, p, v) => wp.sendWebPush(t, p, v, { fetchImpl: toFake(o2) }),
      forget: async (t) => void forgotten.push(t.id),
    },
    { kind: "reply", sessionId: "wrun_1", turnId: "turn_5", text: "done" },
    { orgId: "o", email: "a@x" },
  );
  deadServer.close();
  check("a device the push service dropped (410) is removed; the other is sent", result.sent === 1 && result.removed === 1 && forgotten.join() === "d2", { result, forgotten });
  let looked = false;
  const off = await push.notify(
    { vapid: () => null, recipients: async () => ((looked = true), []), send: async () => ({ status: 201, gone: false }), forget: async () => {} },
    { kind: "reply", sessionId: "s" },
    { orgId: "o", email: "a@x" },
  );
  check("without VAPID keys nothing is sent and nobody is looked up", off.sent === 0 && !looked);
  // One generated private key in 256 starts with a zero byte, which getPrivateKey() drops: 3,000 keys miss that case
  // with a chance of about 1 in 120,000. Each must be one vapidFromEnv accepts (it made the check below flaky).
  const shortKeys = Array.from({ length: 3000 }, () => wp.generateVapidKeys()).filter((k) => wp.vapidFromEnv({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" }) === null);
  check("every generated key pair is one vapidFromEnv accepts (a private key with a leading zero byte is still 32 bytes)", shortKeys.length === 0, shortKeys.slice(0, 2));
  check("VAPID keys are read only when all three are present and well-formed", wp.vapidFromEnv({}) === null && wp.vapidFromEnv({ VAPID_PUBLIC_KEY: vapidPair.publicKey, VAPID_PRIVATE_KEY: vapidPair.privateKey, VAPID_SUBJECT: "ops@example.com" }) === null && wp.vapidFromEnv({ VAPID_PUBLIC_KEY: vapidPair.publicKey, VAPID_PRIVATE_KEY: vapidPair.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" }) !== null);
} finally {
  server.close();
}

console.log("\n6. Review of #63 — each of these failed on 2a1d80c:");
{
  await guarded(async () => {
  // SSRF: only the browsers' push services, https, default port; never a redirect.
  for (const [url, ok] of [
    ["https://fcm.googleapis.com/fcm/send/x", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/x", true],
    ["https://wns2-par02p.notify.windows.com/w/?token=x", true],
    ["https://web.push.apple.com/QGx", true],
    ["https://169.254.169.254/latest/meta-data/", false],
    ["https://10.0.0.5/admin", false],
    ["https://localhost:8443/x", false],
    ["http://127.0.0.1:3000/api/cron/deliver-queued", false],
    ["https://metadata.google.internal/", false],
    ["http://fcm.googleapis.com/x", false],
    ["https://fcm.googleapis.com.evil.example/x", false],
    ["https://evil.example/fcm.googleapis.com", false],
    ["https://push.services.mozilla.com.evil.example/x", false],
    ["https://user:pw@fcm.googleapis.com/x", false],
  ]) {
    check(`push endpoint ${url} ${ok ? "allowed" : "refused"}`, wp.isAllowedPushEndpoint(url) === ok);
  }
  const hits = [];
  const internal = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end("ok"); });
  await new Promise((r) => internal.listen(0, "127.0.0.1", r));
  const outer = createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${internal.address().port}/internal-admin` }); res.end(); });
  await new Promise((r) => outer.listen(0, "127.0.0.1", r));
  const r = await wp.sendWebPush(target, { t: 1 }, vapid, { fetchImpl: toFake(`http://127.0.0.1:${outer.address().port}`) });
  check("a 307 from the push service is a failure, and is NOT followed (the internal server is never reached)", r.status === 307 && !r.gone && hits.length === 0, { r, hits });
  const direct = await wp.sendWebPush({ ...target, endpoint: `http://127.0.0.1:${internal.address().port}/x` }, { t: 1 }, vapid);
  check("a stored endpoint that is not a push service is never fetched", direct.status === 0 && hits.length === 0);
  internal.close();
  outer.close();
  check("a push has a short timeout (≤ 5 s)", wp.PUSH_TIMEOUT_MS <= 5_000);

  });
  await guarded(async () => {
  // Pushes run OFF the turn's critical path.
  const q = push.createNotifyQueue(2, 3);
  let started = 0;
  const slow = () => new Promise((res) => { started++; setTimeout(res, 300); });
  const t0 = Date.now();
  const accepted = [q.run(slow), q.run(slow), q.run(slow), q.run(slow), q.run(slow), q.run(slow)];
  check("handing sends to the queue returns at once (the hook does not wait on a push service)", Date.now() - t0 < 50);
  check("…at most N run together; beyond the waiting room, sends are dropped rather than piled up", started === 2 && accepted.filter(Boolean).length === 5 && accepted[5] === false, { started, accepted });
  // …and each one is kept alive on serverless: registered with the platform's waitUntil, bounded.
  const registered = [];
  const KEY = Symbol.for("@vercel/request-context");
  globalThis[KEY] = { get: () => ({ waitUntil: (p) => registered.push(p) }) };
  try {
    const q2 = push.createNotifyQueue(1, 5, { keepAliveMs: 200 });
    let finished = false;
    q2.run(() => new Promise((res) => setTimeout(() => { finished = true; res(); }, 50)));
    q2.run(() => new Promise(() => {})); // a send that never settles
    check("every accepted push is registered with the platform's waitUntil (a frozen function does not drop it)", registered.length === 2);
    await registered[0];
    check("…which waits for the push to finish", finished);
    const t1 = Date.now();
    await registered[1];
    check("…and never longer than its bound", Date.now() - t1 < 1_000);
  } finally {
    delete globalThis[KEY];
  }
  check("off Vercel (no request context) nothing is registered", push.platformWaitUntil(Promise.resolve(), 10) === false);
  // The one notifier the hook AND the channel's handler feed (a specialist's question reaches no hook) is wired in
  // agent/lib/turn-notify.ts; the hook only calls into it.
  const hook = readFileSync(new URL("../agent/lib/turn-notify.ts", import.meta.url), "utf8");
  check("the notification hook goes through that one notifier", /from "#lib\/turn-notify\.js"/.test(readFileSync(new URL("../agent/hooks/notifications.ts", import.meta.url), "utf8")));
  check("…and the notifier uses it (it never awaits a send)", /sends\.run\(/.test(hook) && !/await notify\(/.test(hook.replace(/sends\.run\(async \(\) => \{[\s\S]*?\}\);/, "")));

  });
  await guarded(async () => {
  // The queue-delivery token: not a sign-in, one session, two minutes.
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.AUTH_JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.AUTH_JWT_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });
  const auth = await import("../lib/auth-session.ts");
  const { queueDeliveryAuth } = await import("../agent/lib/queue-delivery-auth.ts");
  const { QUEUE_DELIVERY_TTL_SECONDS } = await import("../lib/queue-delivery-token.ts");
  const post = await auth.mintQueueDeliveryToken("alice@probe.example", { org: "org_a", sessionId: "wrun_A", scope: { act: "post", item: "q1", claim: "c1", seq: 1 } });
  const read = await auth.mintQueueDeliveryToken("alice@probe.example", { org: "org_a", sessionId: "wrun_A", scope: { act: "read" } });
  const claims = JSON.parse(Buffer.from(post.split(".")[1], "base64url").toString());
  check("the delivery token lives ≤ 2 minutes, has a jti, names one session and one action, and is its own kind", claims.exp - claims.iat <= 120 && QUEUE_DELIVERY_TTL_SECONDS <= 120 && Boolean(claims.jti) && claims.sid === "wrun_A" && claims.act === "post" && claims.kind === "queue-delivery" && claims.aud !== "delivered-app");
  check("…the web app's routes do NOT accept it as a sign-in", (await auth.verifySessionToken(post)) === null && (await auth.verifySessionToken(read)) === null);
  const consumed = [];
  const door = queueDeliveryAuth(process.env.AUTH_JWT_PUBLIC_KEY, async (c) => (consumed.push(c), true));
  const req = (method, path, t, body) => new Request(`https://agent.example${path}`, { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const good = { continuationToken: "ct", message: "hello" };
  check("…a post token is admitted on its own session's message POST (after the single-use consume)", Boolean(await door(req("POST", "/eve/v1/session/wrun_A", post, good))) && consumed.length === 1 && consumed[0].item === "q1" && consumed[0].seq === 1 && consumed[0].message === "hello");
  check("…but NOT on another session (the root risk: eve checks only that a token is valid)", !(await door(req("POST", "/eve/v1/session/wrun_B", post, good))) && !(await door(req("GET", "/eve/v1/session/wrun_B/stream", read))));
  check("…nor POST …/stream, cancel, a new session, or /info", !(await door(req("POST", "/eve/v1/session/wrun_A/stream", post, good))) && !(await door(req("POST", "/eve/v1/session/wrun_A/cancel", post, good))) && !(await door(req("POST", "/eve/v1/session", post, good))) && !(await door(req("GET", "/eve/v1/info", read))));
  check("…nor a body with inputResponses or any other key", !(await door(req("POST", "/eve/v1/session/wrun_A", post, { ...good, inputResponses: [] }))) && !(await door(req("POST", "/eve/v1/session/wrun_A", post, { ...good, extra: 1 }))));
  check("a read token reads its session's stream, and does nothing else", Boolean(await door(req("GET", "/eve/v1/session/wrun_A/stream", read))) && !(await door(req("POST", "/eve/v1/session/wrun_A", read, good))));
  const signIn = await auth.mintSessionToken("alice@probe.example", { org: "org_a" });
  check("…and an ordinary sign-in never passes as one", !(await door(req("POST", "/eve/v1/session/wrun_A", signIn, good))));
  const channel = readFileSync(new URL("../agent/channels/eve.ts", import.meta.url), "utf8");
  check("the agent's channel includes this door", /queueDeliveryAuth\(sessionPublicKey\)/.test(channel));
  const runtime = readFileSync(new URL("../lib/chat-queue-runtime.ts", import.meta.url), "utf8");
  check("the drain signs only delivery tokens (never a full sign-in)", /mintQueueDeliveryToken\(/.test(runtime) && !/mintSessionToken\(/.test(runtime));

  });
  await guarded(async () => {
  // The nudge: signed by the agent, compared in constant time, rate-limited per session.
  const sc = await import("../lib/secret-compare.ts");
  const { createNudgeGate } = await import("../lib/nudge-gate.ts");
  let clock = 1_000_000;
  const gate = createNudgeGate({ now: () => clock });
  const S = "shh";
  check("an unsigned nudge is refused", gate.check({ signature: null, secret: S, orgId: "o", sessionId: "s" }) === "unsigned");
  check("a nudge signed with the wrong secret is refused", gate.check({ signature: sc.signNudge("nope", "o", "s", clock), secret: S, orgId: "o", sessionId: "s" }) === "unsigned");
  check("a nudge signed for another session is refused", gate.check({ signature: sc.signNudge(S, "o", "other", clock), secret: S, orgId: "o", sessionId: "s" }) === "unsigned");
  check("an old nudge is refused (a minute's validity)", gate.check({ signature: sc.signNudge(S, "o", "s", clock - 120_000), secret: S, orgId: "o", sessionId: "s" }) === "unsigned");
  check("no secret configured: every nudge is refused", gate.check({ signature: sc.signNudge(S, "o", "s", clock), secret: undefined, orgId: "o", sessionId: "s" }) === "unsigned");
  check("the agent's signed nudge is accepted", gate.check({ signature: sc.signNudge(S, "o", "s", clock), secret: S, orgId: "o", sessionId: "s" }) === "ok");
  check("…a second one within 2 s is rate-limited", gate.check({ signature: sc.signNudge(S, "o", "s", clock), secret: S, orgId: "o", sessionId: "s" }) === "rate-limited");
  let limited = 0;
  for (let i = 0; i < 30; i++) { clock += 2_500; if (gate.check({ signature: sc.signNudge(S, "o", "s", clock), secret: S, orgId: "o", sessionId: "s" }) === "rate-limited") limited++; }
  check("…and a steady stream is capped per minute", limited > 0);
  const route = readFileSync(new URL("../app/api/chat-queue/nudge/route.ts", import.meta.url), "utf8");
  const nudger = readFileSync(new URL("../agent/lib/chat-queue-nudge.ts", import.meta.url), "utf8");
  check("the nudge route refuses unsigned (401) and rate-limited (429) nudges; the agent signs them", /gate\.check\(/.test(route) && /status: 401/.test(route) && /status: 429/.test(route) && /signNudge\(/.test(nudger));

  });
  await guarded(async () => {
  // Every cron secret is compared in constant time.
  const sc = await import("../lib/secret-compare.ts");
  check("bearerMatches: right, wrong, unset", sc.bearerMatches("Bearer abc", "abc") && !sc.bearerMatches("Bearer abd", "abc") && !sc.bearerMatches("Bearer ", "") && !sc.bearerMatches(null, "abc"));
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : f.endsWith(".ts") ? [`${d}/${f}`] : []));
  const naive = walk("app").filter((f) => /!==?\s*`Bearer \$\{/.test(readFileSync(f, "utf8")) || /===?\s*`Bearer \$\{/.test(readFileSync(f, "utf8")));
  check("no route compares a secret with === / !== (constant time everywhere)", naive.length === 0, naive);
  });
}

console.log("\n5. Which moments of a turn notify:");
{
  const out = [];
  const t = createTurnNotifier({ emit: async (ev) => void out.push(ev) });
  // A reply: narration before a tool call is not the answer; the last text is.
  t.turnStarted("s", "turn_1");
  t.messageCompleted("s", { turnId: "turn_1", finishReason: "tool-calls", message: "Let me look that up." });
  t.messageCompleted("s", { turnId: "turn_1", finishReason: "stop", message: "Here is the answer." });
  await t.turnCompleted("s", "turn_1", {});
  check("a finished reply notifies once, with the answer (not the narration)", out.length === 1 && out[0].kind === "reply" && out[0].text === "Here is the answer.", out);
  // A park: the question notifies; the turn.completed after it does not.
  out.length = 0;
  t.turnStarted("s", "turn_2");
  await t.inputRequested("s", { turnId: "turn_2", requests: [{ prompt: "Which fiscal year?", display: "select" }] }, {});
  await t.turnCompleted("s", "turn_2", {});
  check("a parked question notifies once — not again as a reply", out.length === 1 && out[0].kind === "input" && out[0].text === "Which fiscal year?" && !out[0].tool);
  out.length = 0;
  await t.inputRequested("s", { turnId: "turn_3", requests: [{ display: "confirmation", action: { kind: "tool-call", toolName: "forget" } }] }, {});
  await t.turnCompleted("s", "turn_3", {});
  check("an approval notifies with the tool it is for (once)", out.length === 1 && out[0].tool === "forget");
  out.length = 0;
  t.turnStarted("s", "turn_4");
  t.messageCompleted("s", { turnId: "turn_4", finishReason: "tool-calls", message: "Working…" });
  await t.turnCompleted("s", "turn_4", {});
  check("a turn that produced no answer says nothing", out.length === 0);
  t.turnStarted("s", "turn_5");
  t.turnCancelled("s", "turn_5");
  check("a Stop never notifies", out.length === 0);
  await t.turnFailed("s", "turn_6", {});
  check("a failed turn notifies", out.length === 1 && out[0].kind === "failed");
  out.length = 0;
  await t.turnCompleted("s", "turn_7", {});
  check("a turn whose text landed on another instance still says the reply is ready", out.length === 1 && out[0].kind === "reply" && out[0].text === undefined);
  check("nothing is kept once a turn is over (bounded memory)", t.size() === 0);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
