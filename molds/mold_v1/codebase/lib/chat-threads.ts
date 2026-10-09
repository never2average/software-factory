import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "./ops-db";
import { verifyOpsAuth } from "./ops-auth";
import { DEFAULT_ORG, isWorkspaceRefusal, namedWorkspaceOf, resolveOrgForIdentity } from "./org-context";
import { guestInviteLive, normalEmail } from "./guest-invite-rules";

/**
 * Shared authorization helpers for the multiplayer chat routes. proxy.ts proves
 * IDENTITY (a verified @example.com Google token); these prove AUTHORIZATION
 * (ownership / membership of a specific thread). The caller email is always the
 * verified token subject — NEVER a client-supplied field.
 */
export type OpsDb = NonNullable<ReturnType<typeof getOpsDb>>;
export type ThreadRow = typeof chatThreads.$inferSelect;
export type MemberRow = typeof chatThreadMembers.$inferSelect;

/** The verified caller email from the Authorization header, or null. */
export async function callerEmail(request: Request): Promise<string | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  return identity?.email ?? null;
}

export type Access = {
  thread: ThreadRow;
  /** 'owner' | 'participant' | 'viewer' — the caller's effective role. A guest is always 'viewer'. */
  role: string;
  member: MemberRow | null;
  /** An outside guest of this one chat (the request named the chat's workspace; the caller is not in it). */
  guest?: boolean;
};

/**
 * WHICH WORKSPACE A THREAD REQUEST IS IN — and, for a guest's link, which one it NAMES.
 *
 * A chat lives in one workspace and is visible only in that workspace's context. `orgId` is the request's workspace:
 * the one it names (the tab's `x-ops-org` or `?org=`) when the caller is a member of it, or the caller's default when
 * it names none. `named` is the workspace the request names when the caller is NOT in it: a guest following the link
 * of one chat shared with them — and then `orgId` is null. A named workspace is never swapped for another
 * (lib/org-context.ts): such a request is not looked up in the caller's own workspace at all (it used to be, first),
 * only in the one it names, by this thread's id, through the read-only guest path below. Every read is in one
 * workspace — nothing lists or sweeps workspaces (it used to: `acrossOrgsRls` for every thread load).
 */
export interface ThreadScope {
  readonly orgId: string | null;
  readonly named: string | null;
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

export async function threadScope(request: Request): Promise<ThreadScope | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return null;
  const asked = namedWorkspaceOf(request);
  const resolved = await resolveOrgForIdentity(identity.email, identity.hostedDomain, asked);
  if (!isWorkspaceRefusal(resolved)) return { orgId: resolved.orgId, named: null };
  // Membership could not be read: neither a member's answer nor a guest's can be given. The route answers an error.
  if (resolved.reason === "unavailable") throw new Error("workspace unavailable");
  // Not a member of the workspace named (or there is none): the guest path only, in that workspace, or nothing.
  return { orgId: null, named: asked && WORKSPACE_ID.test(asked) ? asked : null };
}

/** The rows of workspace `orgId` a thread read may see (the default workspace's pre-tenancy rows have no org). */
const inWorkspace = (orgId: string) =>
  orgId === DEFAULT_ORG ? or(eq(chatThreads.orgId, orgId), isNull(chatThreads.orgId)) : eq(chatThreads.orgId, orgId);

/** Load a thread row by id, in workspace `orgId` only. */
export async function loadThread(_db: OpsDb, threadId: string, orgId: string): Promise<ThreadRow | undefined> {
  const rows = await withOrgRls(orgId, (tx) =>
    tx.select().from(chatThreads).where(and(eq(chatThreads.id, threadId), inWorkspace(orgId))).limit(1),
  );
  return rows[0];
}

async function loadMember(_db: OpsDb, threadId: string, email: string, orgId: string): Promise<MemberRow | undefined> {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(chatThreadMembers)
      // Compared without capital letters: a Google sign-in may spell the address differently from the invite.
      .where(and(eq(chatThreadMembers.threadId, threadId), sql`lower(${chatThreadMembers.email}) = ${normalEmail(email)}`))
      .limit(1),
  );
  return rows[0];
}

/**
 * Resolve the caller's access to a thread, IN THE REQUEST'S WORKSPACE: the owner always has full access; everyone
 * else must have a non-revoked member row. Returns null when the thread is not in that workspace or the caller has no
 * access. A thread of any other workspace is simply not found — including for a person who is a member of both while
 * their current workspace is the other one (they switch workspace; they never peek across).
 *
 * The GUEST path: when the thread is not in the request's workspace and the request NAMES another (its link), that
 * one is read — by this thread's id — and a live member row there admits the caller as a read-only GUEST of this one
 * chat (`role: "viewer"`, `guest: true`). A guest sees the chat and nothing else of that workspace. A member of the
 * named workspace is never a guest (threadScope put them IN it, so `named` is null for them); and for a guest there
 * is no request workspace at all (`scope.orgId` is null), so nothing of their own workspace is read under its name.
 *
 * The thread and member reads are issued CONCURRENTLY, as before: one speculative member read the owner throws away
 * is cheaper than a second serial round trip for everyone else.
 */
export async function accessFor(
  db: OpsDb,
  threadId: string,
  email: string,
  scope: ThreadScope,
): Promise<Access | null> {
  if (scope.orgId) {
    const [thread, member] = await Promise.all([
      loadThread(db, threadId, scope.orgId),
      loadMember(db, threadId, email, scope.orgId),
    ]);
    if (thread) return resolveAccess(db, thread, member, threadId, email);
  }
  if (!scope.named) return null;
  const [guestThread, guestMember] = await Promise.all([
    loadThread(db, threadId, scope.named),
    loadMember(db, threadId, email, scope.named),
  ]);
  if (!guestThread || guestThread.ownerEmail === email) return null;
  // A guest's invite must still be good: not withdrawn, and opened or sent within the last two weeks
  // (lib/guest-invite-rules.ts — the same rule the guest sign-in doors apply).
  if (!guestMember || !guestInviteLive(guestMember)) return null;
  const access = resolveAccess(db, guestThread, guestMember, threadId, email);
  return access ? { ...access, role: "viewer", guest: true } : null;
}

/** {@link accessFor} for a route: the request's own workspace (and a guest's named one), read from the request. */
export async function threadAccess(request: Request, db: OpsDb, threadId: string, email: string): Promise<Access | null> {
  const scope = await threadScope(request);
  return scope ? accessFor(db, threadId, email, scope) : null;
}

function resolveAccess(
  db: OpsDb,
  thread: ThreadRow | undefined,
  member: MemberRow | undefined,
  threadId: string,
  email: string,
): Access | null {
  if (!thread) return null;
  if (thread.ownerEmail === email) return { thread, role: "owner", member: null };
  if (!member || member.status === "revoked") return null;
  // UN-SHARED (archived) is un-shared for everyone but the owner, on every route — not only the stream. DELETE also
  // revokes the member rows, but a row that escaped that (or a guest re-added since) must not keep the chat.
  if (thread.archivedAt) return null;

  /**
   * Opening the thread IS accepting the invitation.
   *
   * Nothing anywhere ever moved a member off "invited", so the share dialog
   * showed "Can participate · invited" for people who had already read and
   * replied — the owner had no way to tell who had actually turned up. There is
   * no separate accept step to hook, and inventing one would ask a person to
   * confirm something they have just demonstrably done.
   *
   * Best-effort: a failed bookkeeping write must never cost someone access to a
   * thread they are entitled to read.
   */
  if (member.status === "invited") {
    // Inside the thread's workspace: on the bare handle this update matched no row under fail-closed RLS, so an
    // invitee stayed "invited" for ever — the symptom this block was written to fix.
    void withOrgRls(thread.orgId ?? DEFAULT_ORG, (tx) => tx
      .update(chatThreadMembers)
      // "accepted" — NOT a new word. The list query filters on
      // ["invited", "accepted"], so inventing "active" here silently removed
      // the thread from "Shared with you" the instant someone opened it.
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(and(eq(chatThreadMembers.threadId, threadId), sql`lower(${chatThreadMembers.email}) = ${normalEmail(email)}`)))
      .catch(() => undefined);
    return { thread, role: member.role, member: { ...member, status: "accepted" } };
  }
  return { thread, role: member.role, member };
}

/**
 * What a GUEST of the chat (an outside person reading it through its link) is shown: the conversation, and nothing
 * about the chat's workspace — no owner address, no companies it is about, no member list, no turn holder, no local
 * keys. The owner is named by a display label at most.
 */
export function guestThread(thread: ThreadRow) {
  const full = publicThread(thread, "viewer", [], true);
  return {
    ...full,
    clientKey: null,
    ownerEmail: undefined,
    ownerLabel: "the chat's owner",
    customers: [],
    forkedFrom: undefined,
    turnHolder: null,
    members: [],
  };
}

/** Public projection of a thread — never leaks the continuation token. */
export function publicThread(
  thread: ThreadRow,
  role: string,
  members?: MemberRow[],
  /**
   * Include the stored transcript.
   *
   * OFF for list responses. The list is polled every 20 seconds and returns
   * every owned and shared thread, so shipping each one's full `clientEvents`
   * meant re-sending the entire history of every conversation, four times a
   * minute, to render a sidebar that shows a title and a timestamp — competing
   * for bandwidth with the very thread the user is waiting to open.
   */
  withEvents = true,
) {
  return {
    id: thread.id,
    clientKey: thread.clientKey,
    eveSessionId: thread.eveSessionId,
    title: thread.title,
    preview: thread.preview,
    customers: thread.customers ?? [],
    forkedFrom: thread.forkedFrom ?? undefined,
    ownerEmail: thread.ownerEmail,
    role,
    turnHolder: thread.turnHolder,
    ...(withEvents ? { clientEvents: thread.clientEvents ?? [] } : {}),
    archived: Boolean(thread.archivedAt),
    updatedAt: thread.updatedAt.toISOString(),
    members: members?.map((m) => ({
      email: m.email,
      role: m.role,
      status: m.status,
    })),
  };
}
