/**
 * SYSTEM TOOL: the workspace invites a chat share sent before #85 — list them, and mark or expire the ones named.
 *
 * Before #85 sharing a chat with someone outside its workspace also sent them a WORKSPACE invite (org_invites,
 * 14-day TTL); accepting it made them a full member. A share now makes them a read-only guest of that one chat, and an
 * invite whose origin is 'chat_share' is never listed, claimed or accepted as a membership (migration 0026). Which
 * pending invites came from a share is the operator's decision — this tool shows the candidates and applies it.
 *
 *   node scripts/chat-share-invites.mjs                              # list pending invites whose (workspace, address)
 *                                                                    # also has a chat membership: the candidates
 *   node scripts/chat-share-invites.mjs --org onfinance-ai           # one workspace
 *   node scripts/chat-share-invites.mjs --mark <id,id>   [--apply]   # label them 'chat_share' (never a membership)
 *   node scripts/chat-share-invites.mjs --expire <id,id> [--apply]   # end them now
 *
 * DRY RUN unless --apply. A system job: it reads each workspace's chat memberships inside that workspace's scope;
 * never run from a request. DATABASE_URL by name; nothing secret is printed.
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { closeDb, getDb, withOrgDb } from "../agent/lib/db/index.ts";
import { chatThreadMembers, orgInvites } from "../agent/lib/db/schema.ts";

/** Pending (unaccepted, unexpired) invites whose address also holds a chat membership in the invite's workspace. */
export async function listShareInvites({ orgId = null } = {}) {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set.");
  const pending = await db
    .select({
      id: orgInvites.id,
      orgId: orgInvites.orgId,
      email: orgInvites.email,
      role: orgInvites.role,
      invitedBy: orgInvites.invitedBy,
      createdAt: orgInvites.createdAt,
      expiresAt: orgInvites.expiresAt,
      origin: orgInvites.origin,
    })
    .from(orgInvites)
    .where(and(isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, new Date()), ...(orgId ? [eq(orgInvites.orgId, orgId)] : [])));
  const out = [];
  for (const inv of pending) {
    // The chat memberships are tenant rows: read inside the invite's own workspace.
    const shares = await withOrgDb(inv.orgId, (tx) =>
      tx
        .select({ threadId: chatThreadMembers.threadId, status: chatThreadMembers.status })
        .from(chatThreadMembers)
        .where(and(eq(chatThreadMembers.orgId, inv.orgId), eq(chatThreadMembers.email, inv.email.toLowerCase()))),
    );
    if (shares.length) out.push({ ...inv, chatMemberships: shares.length });
  }
  return out;
}

/** Mark (origin 'chat_share') or expire (expires_at now) the named invites. Dry run unless `apply`. */
export async function updateInvites({ ids, action, apply = false }) {
  if (!["mark", "expire"].includes(action)) throw new Error("action must be 'mark' or 'expire'");
  if (!ids?.length) throw new Error("name the invite ids to change");
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set.");
  const rows = await db.select({ id: orgInvites.id, orgId: orgInvites.orgId, email: orgInvites.email }).from(orgInvites).where(inArray(orgInvites.id, ids));
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (apply && rows.length) {
    await db
      .update(orgInvites)
      .set(action === "mark" ? { origin: "chat_share" } : { expiresAt: new Date() })
      .where(inArray(orgInvites.id, rows.map((r) => r.id)));
  }
  return { action, applied: apply, invites: rows, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };
  const apply = args.includes("--apply");
  try {
    const mark = value("mark");
    const expire = value("expire");
    if (mark || expire) {
      const r = await updateInvites({ ids: (mark ?? expire).split(",").map((s) => s.trim()).filter(Boolean), action: mark ? "mark" : "expire", apply });
      for (const i of r.invites) console.log(`  ${r.action.toUpperCase()}  ${i.id}  ${i.orgId}  ${i.email}`);
      for (const m of r.missing) console.log(`  NOT FOUND  ${m}`);
      console.log(apply ? `chat-share-invites: ${r.invites.length} invite(s) ${r.action === "mark" ? "marked chat_share" : "expired"}.` : "chat-share-invites: dry run — re-run with --apply to change them.");
    } else {
      const found = await listShareInvites({ orgId: value("org") });
      console.log(`chat-share-invites: ${found.length} pending invite(s) whose address also holds a chat membership:`);
      for (const i of found) {
        console.log(`  ${i.id}  ${i.orgId}  ${i.email}  created ${i.createdAt.toISOString().slice(0, 10)}  expires ${i.expiresAt.toISOString().slice(0, 10)}  origin=${i.origin}  chat memberships=${i.chatMemberships}`);
      }
      console.log("Decide per invite: --mark <ids> (never a membership) or --expire <ids>; a real member is invited from the workspace settings.");
    }
  } finally {
    await closeDb?.();
  }
}
