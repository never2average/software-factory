/**
 * Who hears about a chat session — the database half of agent/lib/push-notify.ts, and the subscriptions it removes.
 *
 * Every read is in the session's workspace (withOrgDb), naming no person: the hook acts for the workspace, and the
 * owner-only policy on `push_subscriptions` applies to requests that name one. What is read is decided here:
 *
 *   - the OWNER's devices, when the session is a chat in their list (`chat_sessions`), titled as they titled it;
 *   - on a SHARED thread (`chat_threads`), also each accepted, unrevoked PARTICIPANT's devices, titled as the thread;
 *   - nobody, for a session that is neither (a workflow step, an app refresh): those are runs, not conversations;
 *   - and only people who can STILL act in the workspace (`canActIn`, the rule the web app resolves workspaces
 *     by): a removed member's devices get nothing, even before their rows are cleaned up.
 *
 * Any failure (no database, the table not migrated yet) is "nobody", never a throw.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { chatSessions, chatThreadMembers, chatThreads, pushSubscriptions } from "./db/schema.ts";
import type { Recipient } from "./push-notify.ts";
import { canActIn, type RunIn } from "../../lib/chat-queue-server.ts";

const runIn: RunIn = (scope, fn) => withOrgDb(scope, fn as never) as never;

export async function recipientsFor(
  sessionId: string,
  owner: { readonly orgId: string; readonly email: string },
): Promise<Recipient[]> {
  if (!getDb()) return [];
  try {
    return await withOrgDb(owner.orgId, async (tx) => {
      const email = owner.email.toLowerCase();
      const [chat] = await tx
        .select({ title: chatSessions.title, ownerEmail: chatSessions.ownerEmail })
        .from(chatSessions)
        .where(and(eq(chatSessions.orgId, owner.orgId), eq(chatSessions.eveSessionId, sessionId)))
        .limit(1);
      const [thread] = await tx
        .select({ id: chatThreads.id, title: chatThreads.title, ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        .where(and(eq(chatThreads.orgId, owner.orgId), eq(chatThreads.eveSessionId, sessionId), isNull(chatThreads.archivedAt)))
        .limit(1);
      if (!chat && !thread) return [];
      const titles = new Map<string, string | null>();
      const ownerEmail = (chat?.ownerEmail ?? thread?.ownerEmail ?? email).toLowerCase();
      titles.set(ownerEmail, chat?.title ?? thread?.title ?? null);
      if (thread) {
        const members = await tx
          .select({ email: chatThreadMembers.email })
          .from(chatThreadMembers)
          .where(
            and(
              eq(chatThreadMembers.threadId, thread.id),
              eq(chatThreadMembers.role, "participant"),
              eq(chatThreadMembers.status, "accepted"),
              isNull(chatThreadMembers.revokedAt),
            ),
          );
        for (const m of members) if (!titles.has(m.email.toLowerCase())) titles.set(m.email.toLowerCase(), thread.title);
      }
      const subs = await tx
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.orgId, owner.orgId), inArray(pushSubscriptions.ownerEmail, [...titles.keys()])));
      const allowed = new Set<string>();
      for (const who of new Set(subs.map((s) => s.ownerEmail.toLowerCase()))) {
        if (await canActIn(runIn, { orgId: owner.orgId, email: who })) allowed.add(who);
      }
      return subs.filter((s) => allowed.has(s.ownerEmail.toLowerCase())).map((s) => ({
        id: s.id,
        orgId: s.orgId,
        email: s.ownerEmail,
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
        preview: s.preview,
        title: titles.get(s.ownerEmail.toLowerCase()) ?? null,
      }));
    });
  } catch {
    return [];
  }
}

/** The push service dropped this subscription (404/410): so do we. */
export async function forgetSubscription(target: Pick<Recipient, "id" | "orgId">): Promise<void> {
  if (!getDb()) return;
  try {
    await withOrgDb(target.orgId, (tx) => tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, target.id)));
  } catch (error) {
    console.error("[notifications] could not remove a dropped subscription:", error instanceof Error ? error.message : error);
  }
}
