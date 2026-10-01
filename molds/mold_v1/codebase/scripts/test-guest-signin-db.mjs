/**
 * A GUEST OF ONE SHARED CHAT SIGNS IN WITH AN EMAILED CODE OR WITH GOOGLE — AND GETS THAT CHAT, NOTHING ELSE.
 *
 * Sharing a chat with someone outside its workspace makes them a read-only GUEST of that one chat (a chat membership
 * in the chat's workspace, never a workspace membership). The operator's decision (2026-09-30): the guest signs in
 * whichever way they choose, from the chat's link (`/?chatSession=<session>&org=<workspace>`):
 *
 *   · an EMAILED CODE — sent only to the invited address, only for a live invite to that chat
 *     (app/api/auth/email/request, checked again at app/api/auth/email/verify);
 *   · GOOGLE — accepted only when Google's VERIFIED address is the invited one, compared without capital letters
 *     (app/api/auth/guest/google).
 *
 * Both answer with the same email-session token, and both land on the invited chat. Neither creates a workspace
 * membership, a workspace invite or a workspace, and the token opens nothing else: not another chat of the workspace,
 * not its sidebar lists or companies, not another workspace, not a withdrawn or expired invite. A withdrawn invite
 * sends no code and admits no Google sign-in. Every one of those is asserted for BOTH doors, using the token each
 * door actually handed out.
 *
 * Real route handlers (the sign-in doors, the thread routes, the web's eve session gate, workspace creation),
 * real signed requests, as app_rw under row-level security. Mail and the agent are the only things replaced: the
 * code is read from the message the app tried to send, and a request that reaches the agent is answered "forwarded".
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:guest-signin-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-guest-signin-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
process.env.OPS_SECRETS_KEY = "test-secrets-key-not-a-real-one";
process.env.RESEND_API_KEY = "test-not-a-real-key";
process.env.PLATFORM_NOTIFY_FROM = "sign-in@guest.test";
process.env.NEXT_PUBLIC_EVE_API_URL = "http://agent.guest.test";
const GOOGLE_CLIENT = "guest-test-client.apps.googleusercontent.com";
process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = GOOGLE_CLIENT;

/* Mail and the agent, replaced. Every code the app sends is kept per address; a call that reaches the agent is "forwarded". */
const mailbox = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(init.body);
    const code = /code is (\d{6})/.exec(body.text ?? "")?.[1] ?? null;
    mailbox.set(String(body.to).toLowerCase(), [...(mailbox.get(String(body.to).toLowerCase()) ?? []), code]);
    return new Response("{}", { status: 200 });
  }
  if (url.startsWith("http://agent.guest.test/")) return new Response("forwarded", { status: 200 });
  return realFetch(input, init);
};

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
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
const attempt = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return { status: "threw", body: String(error?.message ?? error) };
  }
};

const stamp = Date.now();
const A = `gsi-a-${stamp}`; // the chat's workspace
const C = `gsi-c-${stamp}`; // another workspace
const ALICE = `alice-${stamp}@a.test`; // owner, workspace A
const TEAMMATE = `mate-${stamp}@a.test`; // member of A (a Google Workspace account on a.test)
const CAROL = `carol-${stamp}@c.test`; // member of C
const GUEST = `guest-${stamp}@outside.test`; // the invited guest: in no workspace
const GUEST_AS_INVITED = `Guest-${stamp}@Outside.test`; // how the share spelled the address (capital letters)
const GUEST_GOOGLE = `GUEST-${stamp}@OUTSIDE.TEST`; // how their Google account spells it
const STRANGER = `stranger-${stamp}@outside.test`; // invited to nothing
const ACME = `acme-${stamp}`;
const chat = (n) => ({ id: randomUUID(), session: `wrun_gsi_${n}_${stamp}` });
const INVITED = chat("invited"); // shared with the guest
const OTHER = chat("other"); // same workspace, not shared with the guest
const REVOKED = chat("revoked"); // shared, then withdrawn
const EXPIRED = chat("expired"); // shared 20 days ago, never opened (its expiry passed 6 days ago)
const LATE = chat("late"); // withdrawn between the code being sent and being used
const ELSEWHERE = chat("elsewhere"); // workspace C
const PRE = chat("pre"); // shared 30 days BEFORE migration 0027, never opened: it must still stand
const STREAMED = chat("streamed"); // read only through the live stream / cached transcript
const MATE2 = `mate2-${stamp}@a.test`; // another member of A, invited to STREAMED

const { NextRequest } = await import("next/server");
const { closeDb } = await import("../agent/lib/db/index.ts");
const { __setGoogleKeysForTest } = await import("../lib/ops-auth.ts");
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import("jose");

/* Google, replaced by keys made here: the route checks signature, issuer, audience and email_verified as for Google. */
const google = await generateKeyPair("RS256");
const googleJwk = { ...(await exportJWK(google.publicKey)), kid: "guest-test", alg: "RS256", use: "sig" };
// Optional call: a build without the seam has no Google guest door either, and the checks below say so.
__setGoogleKeysForTest?.(createLocalJWKSet({ keys: [googleJwk] }));
const stranger = await generateKeyPair("RS256");
const googleToken = (email, { verified = true, hd, key = google.privateKey, aud = GOOGLE_CLIENT } = {}) =>
  new SignJWT({ email, email_verified: verified, ...(hd ? { hd } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "guest-test" })
    .setIssuer("https://accounts.google.com")
    .setAudience(aud)
    .setSubject(`google-${email}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

const route = async (path) => attempt(() => import(path));
const requestRoute = await import("../app/api/auth/email/request/route.ts");
const verifyRoute = await import("../app/api/auth/email/verify/route.ts");
const googleRoute = await route("../app/api/auth/guest/google/route.ts");
const threadRoute = await import("../app/api/ops/threads/[id]/route.ts");
const listRoute = await import("../app/api/ops/threads/route.ts");
const chatsRoute = await import("../app/api/ops/chat-sessions/route.ts");
const customersRoute = await import("../app/api/ops/customers/route.ts");
const orgsRoute = await import("../app/api/ops/orgs/route.ts");
const eveRoute = await import("../app/eve/v1/session/[...segments]/route.ts");
const { gateForSession } = await import("../lib/chat-session-access.ts");
const { resolveOrgForIdentity } = await import("../lib/org-context.ts");
const { verifySessionToken } = await import("../lib/auth-session.ts");

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const postJson = (mod, path, body) =>
  attempt(async () =>
    json(await mod.POST(new NextRequest(`http://gsi.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))),
  );
const linkOf = (c, org = A) => ({ org, chat: c.session });

/** The code door, end to end: ask for a code from the chat's link, read it from the mail, use it. */
async function signInWithCode(address, c, org = A) {
  const before = (mailbox.get(address.toLowerCase()) ?? []).length;
  const asked = await postJson(requestRoute, "/api/auth/email/request", { email: address, ...linkOf(c, org) });
  const code = (mailbox.get(address.toLowerCase()) ?? [])[before] ?? null;
  if (!code) return { asked, code: null, token: null };
  const used = await postJson(verifyRoute, "/api/auth/email/verify", { email: address, code, ...linkOf(c, org) });
  return { asked, code, used, token: used.body?.token ?? null };
}
/** The Google door: a Google ID token for `email`, from the chat's link. */
async function signInWithGoogle(credential, c, org = A) {
  if (googleRoute.status === "threw") return { status: "no such door", body: googleRoute.body, token: null };
  const res = await postJson(googleRoute, "/api/auth/guest/google", { credential, ...linkOf(c, org) });
  return { ...res, token: res.body?.token ?? null };
}

const signed = (token, path, { org, method = "GET", body } = {}) =>
  new NextRequest(`http://gsi.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { "x-ops-org": org } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const params = (p) => ({ params: Promise.resolve(p) });
const openThread = (token, c, org) => attempt(async () => json(await threadRoute.GET(signed(token, `/api/ops/threads/${c.id}`, { org }), params({ id: c.id }))));
/** The chat's stream through the web's eve session proxy — how the page opens a shared chat from its link. */
const openStream = (token, c, org) =>
  attempt(async () => {
    const res = await eveRoute.GET(signed(token, `/eve/v1/session/${c.session}/stream`, { org }), params({ segments: [c.session, "stream"] }));
    return { status: res.status, body: await res.text().catch(() => "") };
  });
/**
 * The session gate's own answer for the token's holder, in the workspace the request resolves to and the one it names
 * (as the web proxy and the agent both ask it: lib/session-gate.ts). The proxy forwards what it cannot place to the
 * agent, which refuses it with this same decision, so the decision is what is asserted for a refusal.
 */
const gateReads = async (token, c, org) => {
  const email = await verifySessionToken(token);
  if (!email) return false;
  const ctx = await resolveOrgForIdentity(email, undefined, org ?? null);
  const named = org && org !== ctx.orgId ? org : null;
  return (await gateForSession(email, c.session, "read", ctx.orgId, named)).allow;
};
const reachesChat = async (token, c, org) => {
  if (!token) return false;
  const [t, s, g] = await Promise.all([openThread(token, c, org), openStream(token, c, org), gateReads(token, c, org)]);
  return t.status === 200 && s.status === 200 && s.body === "forwarded" && g === true;
};
const refusedChat = async (token, c, org) => {
  if (!token) return false; // no token from the door: nothing proven about what it would open
  const [t, g] = await Promise.all([openThread(token, c, org), gateReads(token, c, org)]);
  return t.status === 404 && g === false;
};
const itemsOf = async (mod, token, path, org) => {
  const r = await attempt(async () => json(await mod.GET(signed(token, path, { org }))));
  return { status: r.status, items: r.body?.items ?? r.body?.sessions ?? [] };
};
const guestMemberships = async () => (await admin`select org_id from org_members where lower(email) = lower(${GUEST})`).length;
const guestInvites = async () => (await admin`select id from org_invites where lower(email) = lower(${GUEST})`).length;
const guestWorkspaces = async () => (await admin`select org_id from orgs where lower(created_by) = lower(${GUEST})`).length;

try {
  await admin`insert into orgs (org_id, name, status, google_hosted_domain) values (${A}, 'Guest A', 'active', ${`a-${stamp}.test`}), (${C}, 'Guest C', 'active', null)`;
  await admin`insert into org_members (org_id, email, role) values (${A}, ${ALICE}, 'owner'), (${A}, ${TEAMMATE}, 'member'), (${A}, ${MATE2}, 'member'), (${C}, ${CAROL}, 'owner')`;
  await admin`insert into customers (customer_id, org_id, customer_name) values (${ACME}, ${A}, 'Acme (workspace A)'), (${ACME}, ${C}, 'Acme (workspace C)')`;
  for (const [c, org, owner] of [[INVITED, A, ALICE], [OTHER, A, ALICE], [REVOKED, A, ALICE], [EXPIRED, A, ALICE], [LATE, A, ALICE], [ELSEWHERE, C, CAROL], [PRE, A, ALICE], [STREAMED, A, ALICE]]) {
    await admin`insert into chat_threads (id, org_id, eve_session_id, title, owner_email) values (${c.id}, ${org}, ${c.session}, 'a chat', ${owner})`;
    await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${c.session}, ${org}, ${owner}, 'person', 'owner')`;
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${c.session}, ${org}, ${owner}, ${c.session}, 'a chat')`;
  }
  // An invite from BEFORE migration 0027, as the live database holds it: the table without `expires_at`, the invite
  // sent 30 days ago and never opened. Then the migration itself, from the journal's file.
  await admin`alter table chat_thread_members drop column if exists expires_at`;
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by, invited_at) values
    (${A}, ${PRE.id}, ${GUEST}, 'viewer', 'invited', ${ALICE}, ${new Date(Date.now() - 30 * 86_400_000)})`;
  await admin.unsafe(readFileSync("drizzle/0027_chat_invite_expiry.sql", "utf8"));
  const long = new Date(Date.now() - 20 * 86_400_000);
  const lapsed = new Date(Date.now() - 6 * 86_400_000);
  const fortnight = new Date(Date.now() + 14 * 86_400_000);
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  // As the members route writes them from now on: an expiry two weeks after each share.
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by, invited_at, revoked_at, expires_at) values
    (${A}, ${INVITED.id}, ${GUEST_AS_INVITED}, 'participant', 'invited', ${ALICE}, now(), null, ${fortnight}),
    (${A}, ${REVOKED.id}, ${GUEST}, 'viewer', 'revoked', ${ALICE}, now(), now(), ${fortnight}),
    (${A}, ${EXPIRED.id}, ${GUEST}, 'viewer', 'invited', ${ALICE}, ${long}, null, ${lapsed}),
    (${A}, ${LATE.id}, ${GUEST}, 'viewer', 'invited', ${ALICE}, now(), null, ${fortnight}),
    (${C}, ${ELSEWHERE.id}, ${STRANGER}, 'viewer', 'invited', ${CAROL}, now(), null, ${fortnight}),
    (${A}, ${STREAMED.id}, ${GUEST}, 'viewer', 'invited', ${ALICE}, now(), null, ${soon}),
    (${A}, ${STREAMED.id}, ${TEAMMATE}, 'viewer', 'invited', ${ALICE}, now(), null, ${soon}),
    (${A}, ${STREAMED.id}, ${MATE2}, 'viewer', 'invited', ${ALICE}, now(), null, ${soon})`;

  console.log("\n1. The emailed code: sent only to the invited address, for a live invite to that chat");
  const byCode = await signInWithCode(GUEST, INVITED);
  check("the invited guest, asking from the chat's link, is sent a code", Boolean(byCode.code), byCode.asked);
  check("…and the code signs them in (a token comes back)", Boolean(byCode.token), byCode.used);
  const strangerAsk = await postJson(requestRoute, "/api/auth/email/request", { email: STRANGER, ...linkOf(INVITED) });
  check("an address the chat was not shared with is sent nothing", !(mailbox.get(STRANGER) ?? []).length, strangerAsk);
  check("…and is answered exactly as the guest was (no way to learn who is invited)", JSON.stringify(strangerAsk.body) === JSON.stringify(byCode.asked?.body), [strangerAsk.body, byCode.asked?.body]);
  const noLink = await postJson(requestRoute, "/api/auth/email/request", { email: `nolink-${GUEST}` });
  check("without a chat's link, a guest-only address gets nothing either", noLink.status === 200 && !(mailbox.get(`nolink-${GUEST}`) ?? []).length, noLink);
  const revokedCode = await signInWithCode(GUEST, REVOKED);
  check("a WITHDRAWN invite sends no code", !revokedCode.code, revokedCode.asked);
  const expiredCode = await signInWithCode(GUEST, EXPIRED);
  check("an EXPIRED invite (unopened for 20 days) sends no code", !expiredCode.code, expiredCode.asked);
  const wrongPlace = await signInWithCode(GUEST, INVITED, C);
  check("naming another workspace with the same chat sends no code", !wrongPlace.code, wrongPlace.asked);
  // Withdrawn between the code going out and being used: the code no longer signs them in from that link.
  const beforeLate = (mailbox.get(GUEST) ?? []).length;
  await postJson(requestRoute, "/api/auth/email/request", { email: GUEST, ...linkOf(LATE) });
  const lateCode = (mailbox.get(GUEST) ?? [])[beforeLate];
  await admin`update chat_thread_members set status = 'revoked', revoked_at = now() where thread_id = ${LATE.id}`;
  const lateUse = lateCode ? await postJson(verifyRoute, "/api/auth/email/verify", { email: GUEST, code: lateCode, ...linkOf(LATE) }) : null;
  check("a code sent before the invite was withdrawn signs nobody in from that link", Boolean(lateCode) && lateUse?.status === 403 && !lateUse?.body?.token, lateUse);
  check("…and says why, in plain words", /no longer shared/i.test(lateUse?.body?.error ?? ""), lateUse?.body);

  console.log("\n2. Google: accepted only when Google's verified address is the invited one (capital letters aside)");
  const byGoogle = await signInWithGoogle(await googleToken(GUEST_GOOGLE), INVITED);
  check("the invited guest's Google account (a different spelling of the same address) signs them in", byGoogle.status === 200 && Boolean(byGoogle.token), byGoogle);
  check("…as the invited address, in lower case", byGoogle.body?.email === GUEST, byGoogle.body?.email);
  const wrongAccount = await signInWithGoogle(await googleToken(STRANGER), INVITED);
  check("another Google account is refused, and told to use the invited address", wrongAccount.status === 403 && !wrongAccount.token && /address the invite was sent to/.test(wrongAccount.body?.error ?? ""), wrongAccount);
  const unverified = await signInWithGoogle(await googleToken(GUEST, { verified: false }), INVITED);
  check("a Google account whose address Google has not verified is refused", unverified.status === 401 && !unverified.token, unverified);
  const forged = await signInWithGoogle(await googleToken(GUEST, { key: stranger.privateKey }), INVITED);
  check("a token Google did not sign is refused", forged.status === 401 && !forged.token, forged);
  const otherClient = await signInWithGoogle(await googleToken(GUEST, { aud: "someone-else.apps.googleusercontent.com" }), INVITED);
  check("a Google token made for another app is refused", otherClient.status === 401 && !otherClient.token, otherClient);
  const revokedGoogle = await signInWithGoogle(await googleToken(GUEST), REVOKED);
  check("a WITHDRAWN invite admits no Google sign-in", revokedGoogle.status === 403 && !revokedGoogle.token && /no longer shared/i.test(revokedGoogle.body?.error ?? ""), revokedGoogle);
  const expiredGoogle = await signInWithGoogle(await googleToken(GUEST), EXPIRED);
  check("an EXPIRED invite admits no Google sign-in, and says to ask for it again", expiredGoogle.status === 403 && !expiredGoogle.token && /expired/i.test(expiredGoogle.body?.error ?? ""), expiredGoogle);
  const elsewhereGoogle = await signInWithGoogle(await googleToken(GUEST), INVITED, C);
  check("naming another workspace with the invited chat admits nothing", elsewhereGoogle.status === 403 && !elsewhereGoogle.token, elsewhereGoogle);
  const mate = await signInWithGoogle(await googleToken(TEAMMATE, { hd: `a-${stamp}.test` }), INVITED);
  check("a member of the chat's own workspace is not a guest: told to use their ordinary sign-in, given no guest token", mate.status === 409 && mate.body?.reason === "member" && !mate.token, mate);

  const doors = [
    ["code", byCode.token],
    ["Google", byGoogle.token],
  ];
  for (const [door, token] of doors) {
    console.log(`\n3. Signed in by ${door}: the invited chat, and nothing else`);
    check(`${door}: the guest lands on the invited chat (thread and stream open, through its link's workspace)`, await reachesChat(token, INVITED, A));
    const t = token ? await openThread(token, INVITED, A) : null;
    check(`${door}: …read-only, and shown none of the workspace's people`, t?.body?.item?.role === "viewer" && (t?.body?.item?.members ?? []).length === 0 && !t?.body?.item?.ownerEmail, t?.body?.item);
    check(`${door}: another chat of the same workspace does not open`, await refusedChat(token, OTHER, A));
    check(`${door}: the withdrawn chat does not open`, await refusedChat(token, REVOKED, A));
    check(`${door}: the expired chat does not open`, await refusedChat(token, EXPIRED, A));
    check(`${door}: a chat of another workspace does not open, even naming that workspace`, await refusedChat(token, ELSEWHERE, C));
    check(`${door}: the invited chat does not open from the guest's own place (no link)`, await refusedChat(token, INVITED, undefined));
    const threads = token ? await itemsOf(listRoute, token, "/api/ops/threads", A) : null;
    check(`${door}: the workspace's chat list shows the guest nothing of it, even naming it`, Boolean(token) && !threads.items.some((i) => [INVITED, OTHER, REVOKED, EXPIRED].some((c) => i.id === c.id)), threads);
    const sidebar = token ? await itemsOf(chatsRoute, token, "/api/ops/chat-sessions", A) : null;
    check(`${door}: the workspace's sidebar shows the guest none of its chats`, Boolean(token) && !sidebar.items.some((i) => [INVITED, OTHER].some((c) => i.id === c.session || i.eveSessionId === c.session)), sidebar);
    const custA = token ? await itemsOf(customersRoute, token, "/api/ops/customers", A) : null;
    const custC = token ? await itemsOf(customersRoute, token, "/api/ops/customers", C) : null;
    check(`${door}: no companies of the chat's workspace, nor of another workspace`, Boolean(token) && !JSON.stringify(custA).includes(ACME) && !JSON.stringify(custC).includes(ACME), [custA, custC]);
    const orgsList = token ? await itemsOf(orgsRoute, token, "/api/ops/orgs", A) : null;
    check(`${door}: the workspace switcher lists no workspace for the guest`, Boolean(token) && orgsList.status === 200 && orgsList.items.length === 0, orgsList);
  }

  console.log("\n4. Neither door makes the guest a member of anything");
  check("no workspace membership was created", (await guestMemberships()) === 0, await guestMemberships());
  check("no workspace invite was created", (await guestInvites()) === 0);
  check("the invite counts as opened: it no longer expires", (await admin`select status from chat_thread_members where thread_id = ${INVITED.id}`)[0]?.status === "accepted");
  const create = byCode.token
    ? await attempt(async () => json(await orgsRoute.POST(signed(byCode.token, "/api/ops/orgs", { method: "POST", body: { name: `Guest Co ${stamp}` } }))))
    : { status: "no token" };
  check("a guest's sign-in cannot start a workspace of its own", create.status === 403 && (await guestWorkspaces()) === 0, create);
  check("…so it still has no membership anywhere", (await guestMemberships()) === 0);

  console.log("\n5. Withdrawing the invite later cuts off a guest signed in by either door");
  await admin`update chat_thread_members set status = 'revoked', revoked_at = now() where thread_id = ${INVITED.id}`;
  for (const [door, token] of doors) check(`${door}: the chat no longer opens`, await refusedChat(token, INVITED, A));

  console.log("\n6. The same rules for a guest signed in any other way (a Google Workspace account, an older sign-in)");
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const direct = await mintSessionToken(GUEST);
  check("an invite nobody opened for 20 days no longer opens its chat (thread and stream)", await refusedChat(direct, EXPIRED, A));
  check("a withdrawn invite does not either", await refusedChat(direct, REVOKED, A));
  const directCreate = await attempt(async () => json(await orgsRoute.POST(signed(direct, "/api/ops/orgs", { method: "POST", body: { name: `Guest Direct ${stamp}` } }))));
  check("an emailed-address sign-in with no workspace cannot start a workspace", directCreate.status === 403 && (await guestWorkspaces()) === 0 && (await guestMemberships()) === 0, directCreate);

  console.log("\n7. An invite sent 30 days before migration 0027 still stands after it (the operator's decision)");
  const statusOf = async (c, email) => (await admin`select status, expires_at from chat_thread_members where thread_id = ${c.id} and lower(email) = lower(${email})`)[0];
  const pre = await statusOf(PRE, GUEST);
  check("the migration gave it no expiry (still unopened, 30 days old)", pre?.status === "invited" && pre?.expires_at === null, pre);
  const mailedBefore = (mailbox.get(GUEST) ?? []).length;
  const preAsk = await postJson(requestRoute, "/api/auth/email/request", { email: GUEST, ...linkOf(PRE) });
  check("the code door still sends its guest a code", (mailbox.get(GUEST) ?? []).length === mailedBefore + 1, preAsk);
  const preGoogle = await signInWithGoogle(await googleToken(GUEST), PRE);
  check("the Google door still admits its guest", preGoogle.status === 200 && Boolean(preGoogle.token), preGoogle);
  check("…and the guest opens the chat (thread and stream)", await reachesChat(preGoogle.token ?? direct, PRE, A));

  console.log("\n8. Reading a shared chat through the live stream, or its cached transcript, counts as opening it");
  check("the guest reads it through the stream gate, from its link", await gateReads(direct, STREAMED, A));
  check("…and that marked the guest's invite opened", (await statusOf(STREAMED, GUEST))?.status === "accepted", await statusOf(STREAMED, GUEST));
  await admin`update chat_thread_members set expires_at = now() - interval '1 day' where thread_id = ${STREAMED.id}`;
  check("…so when its expiry passes, the active guest still reads it (stream and thread)", await reachesChat(direct, STREAMED, A));
  const mateRead = await gateForSession(TEAMMATE, STREAMED.session, "read", A, null);
  check("a member reading it through the stream gate in the chat's workspace marks it opened too", mateRead.allow && (await statusOf(STREAMED, TEAMMATE))?.status === "accepted", [mateRead.allow, await statusOf(STREAMED, TEAMMATE)]);
  const { accessForSession } = await import("../lib/chat-session-access.ts");
  const transcript = await accessForSession(A, MATE2, STREAMED.session);
  check("reading its cached transcript marks it opened too", transcript.read && (await statusOf(STREAMED, MATE2))?.status === "accepted", [transcript, await statusOf(STREAMED, MATE2)]);
} finally {
  await admin`alter table chat_thread_members add column if not exists expires_at timestamp with time zone`.catch(() => {});
  const emails = [GUEST, STRANGER, `nolink-${GUEST}`];
  await admin`delete from login_codes where lower(email) in ${admin(emails)}`.catch(() => {});
  for (const org of [A, C]) {
    await admin`delete from chat_thread_members where org_id = ${org}`.catch(() => {});
    await admin`delete from chat_threads where org_id = ${org}`.catch(() => {});
    await admin`delete from chat_sessions where org_id = ${org}`.catch(() => {});
    await admin`delete from agent_session_owners where org_id = ${org}`.catch(() => {});
    await admin`delete from customers where org_id = ${org}`.catch(() => {});
    await admin`delete from org_members where org_id = ${org}`.catch(() => {});
    await admin`delete from orgs where org_id = ${org}`.catch(() => {});
  }
  // A workspace a pre-fix build let the guest create, and anything it seeded.
  const made = await admin`select org_id from orgs where lower(created_by) = lower(${GUEST})`.catch(() => []);
  for (const { org_id } of made) {
    for (const table of ["recipes", "workflows", "org_members", "orgs"]) await admin`delete from ${admin(table)} where org_id = ${org_id}`.catch(() => {});
  }
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
