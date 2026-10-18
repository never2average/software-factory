import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { chatPresence, chatThreads, orgMembers, peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { threadAccess, callerEmail, type Access } from "@/lib/chat-threads";
import { isEmptyStore } from "@/lib/pg-error";
import { listThreadQueue, type RunIn } from "@/lib/thread-queue-server";
import { TYPING_WINDOW_MS } from "@/lib/chat-presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/threads/:id/presence — heartbeat. Called every few seconds while a
 * member has the thread open; `typing` opens a short typing window. Returns the
 * live roster, the turn holder and the chat's queue in the same round-trip so the
 * client needs one call, not three.
 * GET — the same, without the heartbeat.
 *
 * Polled heartbeats are the pragmatic presence channel on Vercel (no WebSockets,
 * no LISTEN/NOTIFY). "Online" = seen within the last ~25s; "typing" = the typing
 * window (`TYPING_WINDOW_MS`, about 4 s) has not yet elapsed. The page sends a
 * typing beat at most once a second while the person types (lib/chat-presence.ts),
 * so the window expires about four seconds after they stop.
 *
 * TYPING IS INFORMATION, NEVER A LOCK (mold_v1-288/290). Nothing reads it to
 * hold a composer or refuse a message: a message sent while someone else types
 * or a turn runs goes into the chat's queue (../messages).
 *
 * WORKSPACE-SCOPED. Every read and write is in the THREAD's workspace (withOrgRls
 * with its org id), for this thread only. Names come from that workspace's
 * roster; anyone online who is not a member of that workspace is a guest of the
 * chat and is shown as one, never by a name or an address. A GUEST may beat (so
 * the members see that a guest is reading) but is told nothing back (GET answers a
 * guest 404, as it always has; POST answers an empty roster): no roster,
 * no turn holder, no queue — what a guest sees of a chat is the conversation
 * (lib/chat-threads.ts `guestThread`). A guest never types: they cannot send.
 */
const bodySchema = z.object({ typing: z.boolean().optional() });

const runIn: RunIn = (orgId, fn) => withOrgRls(orgId, fn as never) as never;

/**
 * A LIGHT RATE LIMIT. A page beats every 2 s and types at most once a second; anything faster from one person on one
 * chat is refused (429) before it touches the database. Per server instance, which is all a courtesy limit needs; the
 * write itself is also skipped for a plain heartbeat less than a second after the last.
 */
const MIN_BEAT_MS = 250;
const lastBeat = new Map<string, number>();
function tooSoon(key: string, now: number): boolean {
  const last = lastBeat.get(key);
  lastBeat.set(key, now);
  if (lastBeat.size > 5_000) for (const [k, t] of lastBeat) if (now - t > 60_000) lastBeat.delete(k);
  return last !== undefined && now - last < MIN_BEAT_MS;
}

interface OnlineView {
  /** The member's address: a key, and the hover title. Absent for a guest. */
  email?: string;
  /** Who they are, as the workspace's roster names them (the address's local part when it has no name). */
  name: string | null;
  guest: boolean;
  typing: boolean;
}

async function roster(orgId: string, threadId: string, me: string): Promise<OnlineView[]> {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(chatPresence)
      .where(
        and(
          eq(chatPresence.orgId, orgId),
          eq(chatPresence.threadId, threadId),
          gt(chatPresence.lastSeenAt, sql`now() - interval '25 seconds'`),
        ),
      ),
  );
  const others = rows.filter((r) => r.email.toLowerCase() !== me.toLowerCase());
  if (others.length === 0) return [];
  const emails = others.map((r) => r.email.toLowerCase());
  const [members, names] = await Promise.all([
    withOrgRls(orgId, (tx) =>
      tx
        .select({ email: orgMembers.email })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), inArray(sql`lower(${orgMembers.email})`, emails))),
    ),
    withOrgRls(orgId, (tx) =>
      tx
        .select({ email: peopleRoster.email, name: peopleRoster.name })
        .from(peopleRoster)
        .where(and(eq(peopleRoster.orgId, orgId), inArray(sql`lower(${peopleRoster.email})`, emails))),
    ),
  ]);
  const member = new Set(members.map((m) => m.email.toLowerCase()));
  const nameOf = new Map(names.map((n) => [n.email.toLowerCase(), n.name?.trim() || null]));
  const now = Date.now();
  return others.map((r) => {
    const key = r.email.toLowerCase();
    const guest = !member.has(key);
    const typing = Boolean(r.typingUntil && r.typingUntil.getTime() > now);
    return guest
      ? { name: null, guest: true, typing: false }
      : { email: r.email, name: nameOf.get(key) ?? r.email.split("@")[0], guest: false, typing };
  });
}

/** The chat's queue as its members see it: who sent each message, and its words. */
async function queueView(access: Access, threadId: string, me: string) {
  try {
    const items = await listThreadQueue(runIn, { orgId: access.thread.orgId, threadId, viewer: me });
    if (items.length === 0) return [];
    const authors = [...new Set(items.map((i) => i.authorEmail.toLowerCase()))];
    const names = await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .select({ email: peopleRoster.email, name: peopleRoster.name })
        .from(peopleRoster)
        .where(and(eq(peopleRoster.orgId, access.thread.orgId), inArray(sql`lower(${peopleRoster.email})`, authors))),
    );
    const nameOf = new Map(names.map((n) => [n.email.toLowerCase(), n.name?.trim() || null]));
    return items.map((i) => ({
      id: i.id,
      author: nameOf.get(i.authorEmail) ?? i.authorEmail.split("@")[0],
      mine: i.authorEmail === me.toLowerCase(),
      text: i.text,
      state: i.state,
      error: i.state === "failed" ? i.error : null,
    }));
  } catch (e) {
    // A deployment that has not applied drizzle/0048 yet has no queue to show.
    if (isEmptyStore(e)) return [];
    throw e;
  }
}

async function answer(access: Access, threadId: string, me: string) {
  if (access.guest) return { online: [], turnHolder: null, queue: [] };
  const [online, [thread], queue] = await Promise.all([
    roster(access.thread.orgId, threadId, me),
    withOrgRls(access.thread.orgId, (tx) =>
      tx.select({ turnHolder: chatThreads.turnHolder }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1),
    ),
    queueView(access, threadId, me),
  ]);
  return { online, turnHolder: thread?.turnHolder ?? null, queue };
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [], turnHolder: null, queue: [] });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (tooSoon(`${id}:${email.toLowerCase()}`, Date.now())) {
    return NextResponse.json({ error: "Too many presence updates." }, { status: 429, headers: { "retry-after": "1" } });
  }
  try {
    const access = await threadAccess(request, db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    // `typing: true` opens the window, `false` closes it (the message was sent or the draft cleared), and a beat
    // that says neither leaves it as it is: a heartbeat landing between two keystrokes must not hide the line.
    // Only someone who can send can be typing: a viewer or a guest reads.
    const said = parsed.success ? parsed.data.typing : undefined;
    const canType = access.role !== "viewer" && !access.guest;
    const typingUntil = said === true && canType ? new Date(Date.now() + TYPING_WINDOW_MS) : null;
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .insert(chatPresence)
        .values({ orgId: access.thread.orgId, threadId: id, email, lastSeenAt: new Date(), typingUntil })
        .onConflictDoUpdate({
          target: [chatPresence.threadId, chatPresence.email],
          set: said === undefined && canType ? { lastSeenAt: new Date() } : { lastSeenAt: new Date(), typingUntil },
          // A plain heartbeat less than a second after the last changes nothing worth a write.
          ...(said === undefined ? { setWhere: sql`${chatPresence.lastSeenAt} < now() - interval '1 second'` } : {}),
        }),
    );
    return NextResponse.json(await answer(access, id, email));
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [], turnHolder: null, queue: [] });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const access = await threadAccess(request, db, id, email);
    // A guest is told nothing of who is here (lib/chat-threads.ts guestThread): the roster read is not theirs at all.
    if (!access || access.guest) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    return NextResponse.json(await answer(access, id, email));
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
