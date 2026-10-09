/**
 * A CHAT LIVES IN ONE WORKSPACE, AND IS ONLY EVER VISIBLE IN THAT WORKSPACE'S CONTEXT.
 *
 * The operator's rule: "even chat sessions shouldn't be visible in a different workspace" — and "you can obviously
 * invite a user from another organization or workspace". So:
 *
 *   · a chat in workspace A never appears in, or opens from, workspace B — not for a member of B, and not for a person
 *     who is a member of BOTH while their current workspace is B (stream, thread load, member list, presence, relay,
 *     sidebar lists, notifications);
 *   · an OUTSIDE person invited to the chat is a GUEST of that one chat: they open it through its link, whose request
 *     names the chat's workspace, and the membership row in THAT workspace is what admits them — read-only. It gives
 *     them nothing else of the workspace (no member list, no presence, no companies, no other chats), and the chat
 *     never shows up inside their own workspace.
 *
 * Every route here is the real handler, called with a real signed-in request, as app_rw under row-level security. No
 * code path may need a cross-workspace reader for any of it (check:tenancy holds that with no exception for threads).
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:thread-visibility-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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
  console.log("test-thread-visibility-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
process.env.NEXT_PUBLIC_EVE_API_URL = "http://127.0.0.1:59999"; // nothing listens: every refusal must come before any call

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

const stamp = Date.now();
const A = `vis-a-${stamp}`;
const B = `vis-b-${stamp}`;
const ALICE = `alice-${stamp}@a.test`; // owner, workspace A
const DUO = `duo-${stamp}@a.test`; // member of A AND B, shared on the chat
const GUEST = `guest-${stamp}@b.test`; // member of B only, invited to the chat: a guest
const CAROL = `carol-${stamp}@b.test`; // member of B only, not invited
const THREAD = randomUUID();
const SESSION = `wrun_vis_${stamp}`;
const ACME = `acme-${stamp}`;

const { mintSessionToken } = await import("../lib/auth-session.ts");
const { NextRequest } = await import("next/server");
const { closeDb } = await import("../agent/lib/db/index.ts");
const token = {};
for (const who of [ALICE, DUO, GUEST, CAROL]) token[who] = `Bearer ${await mintSessionToken(who)}`;
/** A signed-in request from `who`, in the workspace `org` names (the tab's x-ops-org), or none. */
const req = (who, path, { org, method = "GET", body } = {}) =>
  new NextRequest(`http://vis.test${path}`, {
    method,
    headers: {
      authorization: token[who],
      ...(org ? { "x-ops-org": org } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const params = (p) => ({ params: Promise.resolve(p) });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
/** A route call that got as far as calling the agent (nothing listens there) was NOT refused: status "reached-agent". */
const reach = async (call) => {
  try {
    return await call();
  } catch (error) {
    return { status: "reached-agent", body: String(error?.message ?? error) };
  }
};

const threadRoute = await import("../app/api/ops/threads/[id]/route.ts");
const membersRoute = await import("../app/api/ops/threads/[id]/members/route.ts");
const presenceRoute = await import("../app/api/ops/threads/[id]/presence/route.ts");
const messagesRoute = await import("../app/api/ops/threads/[id]/messages/route.ts");
const streamRoute = await import("../app/api/ops/threads/[id]/stream/route.ts");
const listRoute = await import("../app/api/ops/threads/route.ts");
const chatsRoute = await import("../app/api/ops/chat-sessions/route.ts");
const customersRoute = await import("../app/api/ops/customers/route.ts");
const gate = await import("../lib/session-gate.ts");
const { withOrgDb } = await import("../agent/lib/db/index.ts");
const webDb = { inOrg: (o, fn) => withOrgDb(o, fn), orgsOf: async (e) => (await admin`select org_id from org_members where email = ${e}`).map((r) => r.org_id) };

const open = (who, org) => threadRoute.GET(req(who, `/api/ops/threads/${THREAD}`, { org }), params({ id: THREAD })).then(json);
const listed = async (who, org) => ((await json(await listRoute.GET(req(who, "/api/ops/threads", { org })))).body?.items ?? []).some((t) => t.id === THREAD);
const inSidebar = async (who, org) => ((await json(await chatsRoute.GET(req(who, "/api/ops/chat-sessions", { org })))).body?.items ?? (await json(await chatsRoute.GET(req(who, "/api/ops/chat-sessions", { org })))).body?.sessions ?? []).some((c) => c.eveSessionId === SESSION || c.id === SESSION);
const gateAs = (who, right, workspace, named) => gate.gateSessionRequest(webDb, { kind: "person", email: who }, SESSION, right, { workspace, named });

try {
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Vis A', 'active'), (${B}, 'Vis B', 'active')`;
  await admin`insert into org_members (org_id, email, role, last_selected_at) values
    (${A}, ${ALICE}, 'member', now()), (${A}, ${DUO}, 'member', now()), (${B}, ${DUO}, 'member', now() - interval '1 day'),
    (${B}, ${GUEST}, 'member', now()), (${B}, ${CAROL}, 'member', now())`;
  await admin`insert into customers (customer_id, org_id, customer_name) values (${ACME}, ${A}, 'Acme (workspace A)')`;
  await admin`insert into chat_threads (id, org_id, eve_session_id, title, owner_email, customers, turn_holder) values (${THREAD}, ${A}, ${SESSION}, 'A private chat', ${ALICE}, ${admin.json([ACME])}, ${ALICE})`;
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by) values
    (${A}, ${THREAD}, ${DUO}, 'participant', 'accepted', ${ALICE}), (${A}, ${THREAD}, ${GUEST}, 'participant', 'invited', ${ALICE})`;
  await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${SESSION}, ${A}, ${ALICE}, ${SESSION}, 'A private chat')`;
  await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${SESSION}, ${A}, ${ALICE}, 'person', 'owner')`;

  console.log("\n1. The chat in its own workspace");
  const own = await open(ALICE, A);
  check("its owner opens it in workspace A (200)", own.status === 200 && own.body?.item?.role === "owner", own);
  check("a member of A it is shared with opens it in A", (await open(DUO, A)).status === 200);
  check("…and it is in A's sidebar list for them", await listed(DUO, A));

  console.log("\n2. A person in BOTH workspaces, currently in B, sees nothing of it");
  const duoB = await open(DUO, B);
  check("thread load from workspace B: not found", duoB.status === 404, duoB);
  check("not in B's shared list", !(await listed(DUO, B)));
  check("member list from B: not found", (await json(await membersRoute.GET(req(DUO, `/api/ops/threads/${THREAD}/members`, { org: B }), params({ id: THREAD })))).status === 404);
  check("presence from B: not found", (await json(await presenceRoute.GET(req(DUO, `/api/ops/threads/${THREAD}/presence`, { org: B }), params({ id: THREAD })))).status === 404);
  const relayB = await reach(async () => json(await messagesRoute.POST(req(DUO, `/api/ops/threads/${THREAD}/messages`, { org: B, method: "POST", body: { message: "from B" } }), params({ id: THREAD }))));
  check("relay (send) from B: refused", relayB.status === 404 || relayB.status === 403, relayB);
  const streamB = await reach(() => streamRoute.GET(req(DUO, `/api/ops/threads/${THREAD}/stream`, { org: B }), params({ id: THREAD })));
  check("thread stream from B: refused", streamB.status === 403 || streamB.status === 404, streamB.status);
  check("the session gate from B: refused (it reads B only)", !(await gateAs(DUO, "read", B)).allow);
  check("the session gate from B, even naming A while a MEMBER of A: refused — a member switches workspace, never peeks", !(await gateAs(DUO, "read", B, A)).allow);

  console.log("\n3. An outside GUEST opens the one chat through its link (the request names workspace A)");
  const guest = await open(GUEST, A);
  check("the guest opens it (200)", guest.status === 200, guest);
  check("…as a read-only guest, whatever role the invite named", guest.body?.item?.role === "viewer", guest.body?.item?.role);
  check("…and sees none of A's people through it (no member list in the thread)", (guest.body?.item?.members ?? []).length === 0, guest.body?.item?.members);
  const gItem = guest.body?.item ?? {};
  check("…nor the owner's address, the chat's companies, or who holds the turn", !JSON.stringify(gItem).includes(ALICE) && !JSON.stringify(gItem).includes(ACME) && (gItem.customers ?? []).length === 0 && !gItem.turnHolder && !gItem.ownerEmail, { ownerEmail: gItem.ownerEmail, customers: gItem.customers, turnHolder: gItem.turnHolder });
  const gRead = await gateAs(GUEST, "read", B, A);
  check("the session gate lets the guest READ the stream (as a viewer: no continuation token)", gRead.allow && gRead.role === "viewer", gRead);
  check("…never write (send, answer, cancel)", !(await gateAs(GUEST, "write", B, A)).allow);
  const relayG = await reach(async () => json(await messagesRoute.POST(req(GUEST, `/api/ops/threads/${THREAD}/messages`, { org: A, method: "POST", body: { message: "hi" } }), params({ id: THREAD }))));
  check("the relay refuses the guest's message", relayG.status === 403 || relayG.status === 404, relayG);
  check("the guest gets no member list", (await json(await membersRoute.GET(req(GUEST, `/api/ops/threads/${THREAD}/members`, { org: A }), params({ id: THREAD })))).status === 404);
  check("…and no presence", (await json(await presenceRoute.GET(req(GUEST, `/api/ops/threads/${THREAD}/presence`, { org: A }), params({ id: THREAD })))).status === 404);
  const patch = await json(await threadRoute.PATCH(req(GUEST, `/api/ops/threads/${THREAD}`, { org: A, method: "PATCH", body: { title: "renamed by a guest" } }), params({ id: THREAD })));
  check("…and cannot change the chat", patch.status >= 400, patch);

  console.log("\n4. Being a guest gives nothing else of workspace A, and the chat never shows in the guest's workspace");
  const custs = (await json(await customersRoute.GET(req(GUEST, "/api/ops/customers", { org: A })))).body;
  check("naming workspace A does not show the guest A's companies", !JSON.stringify(custs ?? {}).includes(ACME), custs);
  check("the chat is not in the guest's shared list — with the link's workspace named or not", !(await listed(GUEST, A)) && !(await listed(GUEST)));
  check("…nor in the guest's chat sidebar", !(await inSidebar(GUEST, A)) && !(await inSidebar(GUEST)));
  check("from the guest's own workspace (no link) the chat does not open", (await open(GUEST)).status === 404);

  console.log("\n5. Someone with no invite gets nothing, however they name the workspace");
  check("Carol (member of B, not invited), naming A: not found", (await open(CAROL, A)).status === 404);
  check("…and the session gate refuses her", !(await gateAs(CAROL, "read", B, A)).allow);

  console.log("\n5b. Un-sharing cuts a guest off everywhere, even if their member row survived");
  {
    // The archive stamp alone (DELETE also revokes member rows — this is the case where a row was not revoked, or a
    // guest was re-added): every thread route and the session gate must refuse the guest of an archived chat.
    await admin`update chat_threads set archived_at = now() where id = ${THREAD}`;
    check("thread load: not found for the guest", (await open(GUEST, A)).status === 404);
    check("the session gate refuses the guest's stream", !(await gateAs(GUEST, "read", B, A)).allow);
    const s = await reach(() => streamRoute.GET(req(GUEST, `/api/ops/threads/${THREAD}/stream`, { org: A }), params({ id: THREAD })));
    check("the thread stream refuses the guest", s.status === 403 || s.status === 404, s.status);
    check("…while the owner still opens her own chat", (await open(ALICE, A)).status === 200);
    await admin`update chat_threads set archived_at = null where id = ${THREAD}`;
  }

  console.log("\n6. Notifications go only to people in the chat's workspace");
  await admin`insert into push_subscriptions (org_id, owner_email, endpoint, p256dh, auth) values
    (${A}, ${DUO}, ${`https://push.test/duo-a-${stamp}`}, 'k', 'a'), (${B}, ${DUO}, ${`https://push.test/duo-b-${stamp}`}, 'k', 'a'),
    (${B}, ${GUEST}, ${`https://push.test/guest-b-${stamp}`}, 'k', 'a')`;
  await admin`update chat_thread_members set status = 'accepted' where thread_id = ${THREAD}`;
  const { recipientsFor } = await import("../agent/lib/push-recipients.ts");
  const to = await recipientsFor(SESSION, { orgId: A, email: ALICE });
  check("a notification for the chat reaches DUO's device registered in A, never a device in B", to.some((r) => r.endpoint.endsWith(`duo-a-${stamp}`)) && !to.some((r) => r.orgId !== A), to.map((r) => r.endpoint));
  check("…and never the guest's own workspace", !to.some((r) => r.email === GUEST), to.map((r) => r.email));
} finally {
  await admin`delete from push_subscriptions where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from chat_thread_members where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from chat_threads where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from chat_sessions where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from agent_session_owners where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from customers where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from org_members where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
