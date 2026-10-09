/**
 * AN INVITE A CHAT SHARE CREATED NEVER MAKES ITS GUEST A WORKSPACE MEMBER.
 *
 * Until #85 a chat share sent a WORKSPACE invite (org_invites, 14-day TTL) to anyone outside the chat's workspace.
 * #85 stopped creating them — but the ones already sent can still be listed (GET /api/ops/me/workspaces), claimed
 * (POST /api/ops/invites/claim) or accepted by token (POST /api/ops/invites/accept), and each would make an outside
 * guest a full MEMBER of the workspace: its data room, its companies, every chat visible to members.
 *
 * So an invite carries its ORIGIN ('workspace' | 'chat_share', migration 0026). A 'chat_share' invite is never
 * listed, claimed or accepted as a membership; every new invite is 'workspace'. Which existing invites came from a
 * share is the operator's call, made with scripts/chat-share-invites.mjs (dry run by default): it lists the pending
 * invites whose (workspace, address) also has a chat membership, and marks or expires the ids it is given.
 *
 * Real route handlers, signed-in requests, against a real Postgres.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:chat-share-invites-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
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
  console.log("test-chat-share-invites-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

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
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error) };
  }
};

const stamp = Date.now();
const A = `inv-a-${stamp}`;
const OWNER = `owner-${stamp}@a.test`;
const GUEST = `guest-${stamp}@outside.test`; // invited by a chat share, before #85
const GUEST2 = `guest2-${stamp}@outside.test`; // likewise, to be expired
const COLLEAGUE = `colleague-${stamp}@a.test`; // invited to the workspace from its settings
const THREAD = randomUUID();
const hash = (t) => createHash("sha256").update(t).digest("hex");
const TOKEN = `dlv_inv_share_${stamp}`;

const { mintSessionToken } = await import("../lib/auth-session.ts");
const { NextRequest } = await import("next/server");
const { closeDb } = await import("../agent/lib/db/index.ts");
const bearer = async (who) => `Bearer ${await mintSessionToken(who)}`;
const post = async (route, who, path, body) =>
  route.POST(new NextRequest(`http://inv.test${path}`, { method: "POST", headers: { authorization: await bearer(who), "content-type": "application/json" }, body: JSON.stringify(body) }));
const claim = await import("../app/api/ops/invites/claim/route.ts");
const accept = await import("../app/api/ops/invites/accept/route.ts");
const mine = await import("../app/api/ops/me/workspaces/route.ts");
const isMember = async (email) => (await admin`select 1 from org_members where org_id = ${A} and email = ${email}`).length === 1;
const listedInvites = async (who) => {
  const res = await mine.GET(new NextRequest("http://inv.test/api/ops/me/workspaces", { headers: { authorization: await bearer(who) } }));
  return ((await res.json().catch(() => ({})))?.invites ?? []).map((i) => i.orgId);
};

try {
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Invites A', 'active')`;
  await admin`insert into org_members (org_id, email, role) values (${A}, ${OWNER}, 'owner')`;
  await admin`insert into chat_threads (id, org_id, eve_session_id, title, owner_email) values (${THREAD}, ${A}, ${`wrun_inv_${stamp}`}, 'shared', ${OWNER})`;
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by) values
    (${A}, ${THREAD}, ${GUEST}, 'participant', 'invited', ${OWNER}), (${A}, ${THREAD}, ${GUEST2}, 'viewer', 'invited', ${OWNER})`;
  // Invites as the pre-#85 share flow left them (no origin named: whatever the column's default is).
  const later = new Date(Date.now() + 10 * 86_400_000);
  const [shareInvite] = await admin`insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
    values (${A}, ${GUEST}, 'member', ${hash(TOKEN)}, ${OWNER}, ${later}) returning id`;
  const [shareInvite2] = await admin`insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
    values (${A}, ${GUEST2}, 'member', ${hash(`${TOKEN}_2`)}, ${OWNER}, ${later}) returning id`;
  await admin`insert into org_invites (org_id, email, role, token_hash, invited_by, expires_at)
    values (${A}, ${COLLEAGUE}, 'member', ${hash(`${TOKEN}_c`)}, ${OWNER}, ${later})`;

  console.log("\n1. The operator's tool lists the invites a chat share left, and marks or expires the ones named");
  const tool = await attempt(() => import("../scripts/chat-share-invites.mjs"));
  check("scripts/chat-share-invites.mjs exists", !tool.threw, tool.message);
  if (!tool.threw) {
    const { listShareInvites, updateInvites } = tool.value;
    const found = await listShareInvites({ orgId: A });
    check("it lists the pending invites whose address also holds a chat membership in that workspace", found.some((i) => i.id === shareInvite.id) && found.some((i) => i.id === shareInvite2.id) && !found.some((i) => i.email === COLLEAGUE), found);
    const dry = await updateInvites({ ids: [shareInvite.id], action: "mark" });
    check("marking is a dry run by default: nothing changes", dry.applied === false && (await admin`select origin from org_invites where id = ${shareInvite.id}`)[0]?.origin !== "chat_share", dry);
    await updateInvites({ ids: [shareInvite.id], action: "mark", apply: true });
    check("…and with apply the named invite is marked as a chat share", (await admin`select origin from org_invites where id = ${shareInvite.id}`)[0]?.origin === "chat_share");
    await updateInvites({ ids: [shareInvite2.id], action: "expire", apply: true });
    check("expiring a named invite ends it now", (await admin`select expires_at from org_invites where id = ${shareInvite2.id}`)[0]?.expires_at <= new Date());
  }

  console.log("\n2. A chat-share invite is never a workspace membership");
  check("it is not offered in the guest's workspace list", !(await listedInvites(GUEST)).includes(A), await listedInvites(GUEST));
  const c = await post(claim, GUEST, "/api/ops/invites/claim", { orgId: A });
  check("claiming it is refused", c.status >= 400, c.status);
  const t = await post(accept, GUEST, "/api/ops/invites/accept", { token: TOKEN });
  check("accepting its emailed token is refused", t.status >= 400, t.status);
  check("…and the guest is NOT a member of the workspace", !(await isMember(GUEST)));
  const c2 = await post(claim, GUEST2, "/api/ops/invites/claim", { orgId: A });
  check("an expired share invite is refused too", c2.status >= 400 && !(await isMember(GUEST2)), c2.status);

  console.log("\n3. A workspace invite still works");
  check("it is offered", (await listedInvites(COLLEAGUE)).includes(A));
  const ok = await post(claim, COLLEAGUE, "/api/ops/invites/claim", { orgId: A });
  check("claiming it makes the colleague a member", ok.status === 200 && (await isMember(COLLEAGUE)), ok.status);
  check("a new invite is a workspace invite by default", (await admin`select column_default from information_schema.columns where table_name = 'org_invites' and column_name = 'origin'`)[0]?.column_default?.includes("workspace"));
} finally {
  await admin`delete from chat_thread_members where org_id = ${A}`.catch(() => {});
  await admin`delete from chat_threads where org_id = ${A}`.catch(() => {});
  await admin`delete from org_invites where org_id = ${A}`.catch(() => {});
  await admin`delete from org_members where org_id = ${A}`.catch(() => {});
  await admin`delete from orgs where org_id = ${A}`.catch(() => {});
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
