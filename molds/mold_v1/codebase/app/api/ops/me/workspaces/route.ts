import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { orgInvites, orgMembers, orgs } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { tenancyEnabled } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { attentionCounts } from "@/lib/workspace-attention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/me/workspaces — every workspace I belong to, plus every invite
 * still waiting for me.
 *
 * This is the route the product was missing. Membership was resolvable but
 * never VISIBLE: `resolveOrgForIdentity` picked `memberships[0]` from an
 * unordered query, so a person in two workspaces landed in an arbitrary one
 * with nothing on screen naming it, no list of the others, and no way to
 * choose. Being invited twice made it worse, not better.
 *
 * Deliberately NOT under /orgs/{id}: it is about the CALLER, not a workspace,
 * so it needs no workspace to already be selected — which is exactly the state
 * someone is in when the selection is what's wrong.
 *
 * Pending invites are listed for the same reason: an invite you cannot see is
 * an invite you cannot accept, and the email carrying it is the only other copy.
 */

export async function GET(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ memberships: [], invites: [], email: identity.email });
  }
  const email = identity.email.toLowerCase();
  try {
    const [memberRows, inviteRows] = await Promise.all([
      db
        .select({
          orgId: orgMembers.orgId,
          role: orgMembers.role,
          joinedAt: orgMembers.acceptedAt,
          name: orgs.name,
          domain: orgs.googleHostedDomain,
          status: orgs.status,
          lastSelectedAt: orgMembers.lastSelectedAt,
        })
        .from(orgMembers)
        .leftJoin(orgs, eq(orgs.orgId, orgMembers.orgId))
        .where(eq(orgMembers.email, email))
        // Oldest first, and STABLE: this same order decides which workspace a
        // person lands in by default, so it must not vary between requests.
        .orderBy(asc(orgMembers.createdAt), asc(orgMembers.orgId)),
      db
        .select({
          orgId: orgInvites.orgId,
          role: orgInvites.role,
          invitedBy: orgInvites.invitedBy,
          expiresAt: orgInvites.expiresAt,
          name: orgs.name,
        })
        .from(orgInvites)
        .leftJoin(orgs, eq(orgs.orgId, orgInvites.orgId))
        .where(
          and(
            eq(orgInvites.email, email),
            isNull(orgInvites.acceptedAt),
            // A chat share's invite is not an offer of membership (see migration 0026).
            ne(orgInvites.origin, "chat_share"),
            // An expired invite is not an offer; showing it as one just moves
            // the dead end later.
            gt(orgInvites.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(orgInvites.createdAt)),
    ]);

    const joined = new Set(memberRows.map((m) => m.orgId));
    /**
     * WHICH workspace is currently active — computed here rather than left to
     * each client to guess.
     *
     * Clients were inferring it from `memberships[0]`, which is the oldest
     * membership, not the chosen one. So a caller could show "you are in A"
     * while every write went to B. The rule is one line and it must live in one
     * place: the most recently chosen membership, falling back to the oldest.
     */
    const active =
      [...memberRows].sort((a, b) => {
        const at = a.lastSelectedAt ? new Date(a.lastSelectedAt).getTime() : -1;
        const bt = b.lastSelectedAt ? new Date(b.lastSelectedAt).getTime() : -1;
        return bt - at;
      })[0]?.orgId ?? null;
    /**
     * How much needs attention in EACH workspace — carried on the switcher,
     * because choosing which workspace to open is the moment you need it and
     * the one moment the answer is otherwise unavailable: the workspace you are
     * in cannot tell you about the one you are not.
     */
    const attention: Record<string, number> = await attentionCounts(
      memberRows.map((m) => m.orgId),
      // Each of the caller's own workspaces counted inside its RLS scope (lib/workspace-attention.ts).
      (orgId, fn) => withOrgRls(orgId, fn),
    ).catch(() => ({}) as Record<string, number>);
    return NextResponse.json({
      email,
      active,
      memberships: memberRows.map((m) => ({
        orgId: m.orgId,
        name: m.name ?? m.orgId,
        role: m.role,
        attention: attention[m.orgId] ?? 0,
        domain: m.domain,
        suspended: m.status === "suspended",
        joinedAt: m.joinedAt,
      })),
      // An invite to somewhere you are already a member is noise — the accept
      // would be a no-op and it reads as an action you still owe someone.
      invites: inviteRows
        .filter((i) => !joined.has(i.orgId))
        .map((i) => ({
          orgId: i.orgId,
          name: i.name ?? i.orgId,
          role: i.role,
          invitedBy: i.invitedBy,
          expiresAt: i.expiresAt,
        })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
