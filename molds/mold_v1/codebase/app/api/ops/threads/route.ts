import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { callerEmail, publicThread } from "@/lib/chat-threads";
import { DEFAULT_ORG, orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/threads — the SHARE moment. The owner uploads a local
 * StoredSession's metadata + client markers + current resume token; this
 * creates (or updates, by clientKey) the server-authoritative thread row.
 * Ownership is the VERIFIED caller email, never a client field.
 *
 * GET /api/ops/threads — every thread I own or am a non-revoked member of
 * (drives the sidebar's "Shared" section). Never returns the continuation token.
 */
const shareSchema = z.object({
  clientKey: z.string().optional().nullable(),
  eveSessionId: z.string().min(1),
  title: z.string().min(1),
  preview: z.string().optional().nullable(),
  customers: z.array(z.string()).optional().nullable(),
  forkedFrom: z.object({ id: z.string(), title: z.string() }).optional().nullable(),
  continuationToken: z.string().optional().nullable(),
  clientEvents: z.array(z.unknown()).optional().nullable(),
});

export async function POST(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (org instanceof Response) return org;
  const orgScope = org.orgId === DEFAULT_ORG
    ? or(eq(chatThreads.orgId, org.orgId), isNull(chatThreads.orgId))
    : eq(chatThreads.orgId, org.orgId);
  const parsed = shareSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const d = parsed.data;
  try {
    /**
     * A RECIPIENT opening this must not fork the thread.
     *
     * Reconciliation was `(ownerEmail = caller, clientKey)` only. For someone
     * the thread was shared WITH, that matches nothing — so this route created a
     * brand-new row with them as owner, and the share dialog then showed that
     * fork: the recipient labelled Owner, with none of the real participants.
     * It also quietly duplicated the thread every time a non-owner opened the
     * dialog.
     *
     * `clientKey` is local to a device, so it can only ever identify the
     * owner's own row. `eveSessionId` is the thread's shared identity — the
     * thing both sides actually have in common — so look there first and hand
     * back the existing row untouched when the caller is a member of it.
     */
    const [shared] = await withOrgRls(org.orgId, (tx) =>
      tx
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.eveSessionId, d.eveSessionId), orgScope, isNull(chatThreads.archivedAt)))
        .limit(1),
    );
    if (shared && shared.ownerEmail !== email) {
      const [membership] = await withOrgRls(org.orgId, (tx) =>
        tx
          .select({ role: chatThreadMembers.role })
          .from(chatThreadMembers)
          .where(
            and(
              eq(chatThreadMembers.threadId, shared.id),
              eq(chatThreadMembers.email, email),
              ne(chatThreadMembers.status, "revoked"),
            ),
          )
          .limit(1),
      );
      if (!membership) {
        return NextResponse.json({ error: "That thread isn't shared with you." }, { status: 403 });
      }
      // Not the owner: read-only reconciliation. Nothing about the thread's
      // identity or metadata is theirs to rewrite.
      return NextResponse.json({ item: { ...publicThread(shared, membership.role), viewerEmail: email } });
    }

    /**
     * Reconcile by (owner, clientKey) first, then FALL BACK to the owner's
     * existing row for this eve session.
     *
     * The fallback is the fix for a real fork. This used to consult clientKey
     * alone whenever one was supplied, discarding the `shared` row found above —
     * so the moment a chat's mount key changed (a fresh mount is `new-1`, a
     * reopened one is keyed by the stored id) the lookup missed and a SECOND row
     * was inserted for the same conversation. Production has exactly that: one
     * eve session with a `new-1` row holding no events and an id-keyed row
     * holding thirteen, which is two entries in the share UI for one thread and
     * a 50/50 chance of opening the empty one.
     *
     * clientKey stays the preferred key — it is stable per mount and survives
     * eve re-minting a session id — but the session is the thread's real
     * identity, so it decides when clientKey has nothing to say.
     */
    const clientKey = d.clientKey;
    const byClientKey = clientKey
      ? (
          await withOrgRls(org.orgId, (tx) =>
            tx
              .select()
              .from(chatThreads)
              .where(and(eq(chatThreads.ownerEmail, email), orgScope, eq(chatThreads.clientKey, clientKey)))
              .limit(1),
          )
        )[0]
      : undefined;
    /**
     * A clientKey match is only trusted when it agrees about WHICH conversation.
     *
     * Client keys used to be `new-1`, `new-2`… from a counter that reset on every
     * page load, so the same key was handed out again and again. Reconciling on
     * it alone let a new conversation adopt an older thread's row — and every
     * `chat_thread_members` grant already attached to it. That is a disclosure,
     * not a fork: the people it was shared with would be reading something they
     * were never given.
     *
     * Keys are unique now (chat-shell mints a UUID), but old ones are still in
     * browsers and in the database, so the invariant is enforced here too: if
     * the row found by clientKey names a DIFFERENT eve session, it is not this
     * conversation. Fall back to the session, which is the real identity.
     */
    const keyMatchIsSameConversation =
      byClientKey && (!byClientKey.eveSessionId || byClientKey.eveSessionId === d.eveSessionId);
    if (byClientKey && !keyMatchIsSameConversation) {
      console.warn("thread clientKey collision ignored", {
        clientKey: d.clientKey,
        stored: byClientKey.eveSessionId,
        incoming: d.eveSessionId,
      });
    }
    const existing =
      (keyMatchIsSameConversation ? byClientKey : undefined) ??
      (shared && shared.ownerEmail === email ? shared : undefined);

    const values = {
      orgId: org.orgId,
      clientKey: d.clientKey ?? null,
      eveSessionId: d.eveSessionId,
      title: d.title,
      preview: d.preview ?? null,
      customers: d.customers ?? null,
      forkedFrom: d.forkedFrom ?? null,
      ownerEmail: email,
      continuationToken: d.continuationToken ?? null,
      clientEvents: d.clientEvents ?? null,
      updatedAt: new Date(),
    };

    let row;
    if (existing) {
      [row] = await withOrgRls(org.orgId, (tx) =>
        tx.update(chatThreads).set(values).where(eq(chatThreads.id, existing.id)).returning(),
      );
    } else {
      [row] = await withOrgRls(org.orgId, (tx) => tx.insert(chatThreads).values(values).returning());
      void recordActivity(db, {
        entityType: "thread",
        entityId: row.id,
        actor: email,
        event: `${email} shared this thread`,
        orgId: org.orgId,
      });
    }
    return NextResponse.json(
      { item: { ...publicThread(row, "owner"), viewerEmail: email } },
      { status: existing ? 200 : 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (org instanceof Response) return org;
  const orgScope = org.orgId === DEFAULT_ORG
    ? or(eq(chatThreads.orgId, org.orgId), isNull(chatThreads.orgId))
    : eq(chatThreads.orgId, org.orgId);
  try {
    // Threads I own.
    const owned = await withOrgRls(org.orgId, (tx) =>
      tx
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.ownerEmail, email), orgScope, isNull(chatThreads.archivedAt)))
        .orderBy(desc(chatThreads.updatedAt)),
    );
    // Threads I'm a non-revoked member of.
    const memberships = await withOrgRls(org.orgId, (tx) =>
      tx
        .select()
        .from(chatThreadMembers)
        // Anything that is not REVOKED counts. An allow-list of status strings
        // means any new value silently drops the thread out of this list — which
        // is exactly what happened when acceptance started writing "active".
        .where(and(eq(chatThreadMembers.email, email), ne(chatThreadMembers.status, "revoked"))),
    );
    const memberThreadIds = memberships.map((m) => m.threadId).filter((id) => !owned.some((o) => o.id === id));
    const memberThreads = memberThreadIds.length
      ? await withOrgRls(org.orgId, (tx) =>
          tx
            .select()
            .from(chatThreads)
            .where(and(inArray(chatThreads.id, memberThreadIds), orgScope, isNull(chatThreads.archivedAt)))
            .orderBy(desc(chatThreads.updatedAt)),
        )
      : [];

    const roleFor = (id: string) => memberships.find((m) => m.threadId === id)?.role ?? "viewer";
    const items = [
      // OWNED rows carry no transcript: they are the bulk of this list, the
      // sidebar only renders a title and a timestamp from them, and their
      // history is read from the local cache when one is opened. Re-sending all
      // of it every 20s was competing with the thread the user is waiting for.
      ...owned.map((t) => publicThread(t, "owner", undefined, false)),
      // SHARED rows keep theirs: openSharedThread replays the transcript from
      // eve but takes the answered-clarification markers from this field, and
      // they exist nowhere else. There are few of these by nature.
      ...memberThreads.map((t) => publicThread(t, roleFor(t.id))),
    ];
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
