import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { orgInvites, orgMembers, orgs } from "@/agent/lib/db/schema";
import type { Db as OpsDb } from "./ops-db";
import { sendOrgInvite } from "./platform-notify";

/**
 * ONE way to invite a person into a workspace, for every door that does it.
 *
 * The workspace settings invite people explicitly. Sharing a chat thread invites them implicitly: a thread
 * lives in one workspace, and both ways into the app open only for that workspace's people (the emailed
 * sign-in code is issued only to a member or a pending invitee; thread access requires the thread's
 * workspace). A share to someone outside it used to "succeed" — a member row and an email saying "open it
 * here" — and the person could then neither sign in nor see the thread. So a thread share now brings a
 * workspace invite with it, at the lowest role.
 */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** What one workspace may send in an hour: this mails arbitrary addresses from the platform's domain. */
export const INVITE_HOURLY_CAP = 100;

/** dlv_inv_<random> — the plaintext is emailed once; only its hash is stored. */
export function mintInviteToken(): { token: string; hash: string } {
  const token = `dlv_inv_${randomBytes(18).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export type WorkspaceInviteResult =
  | { status: "already-member" }
  | { status: "already-invited" }
  | { status: "rate-limited"; reason: string }
  | { status: "sent" | "resent"; url: string; delivered: boolean; via?: string; reason?: string };

/**
 * Make sure `email` can get into workspace `orgId`: a no-op for a member; for anyone else, a fresh invite
 * (superseding any pending one when `resend` is set, otherwise leaving a live invite alone) and its email.
 */
export async function ensureWorkspaceInvite(
  db: OpsDb,
  input: { orgId: string; email: string; role: string; inviter: string; origin: string; resend?: boolean },
): Promise<WorkspaceInviteResult> {
  const email = input.email.toLowerCase().trim();
  const [member] = await db
    .select({ email: orgMembers.email })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.email, email)))
    .limit(1);
  if (member) return { status: "already-member" };

  const prior = await db
    .select({ id: orgInvites.id, expiresAt: orgInvites.expiresAt })
    .from(orgInvites)
    .where(and(eq(orgInvites.orgId, input.orgId), eq(orgInvites.email, email), isNull(orgInvites.acceptedAt)));
  const live = prior.some((p) => p.expiresAt > new Date());
  if (live && !input.resend) return { status: "already-invited" };

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(orgInvites)
    .where(and(eq(orgInvites.orgId, input.orgId), gt(orgInvites.createdAt, since)));
  if (recent + 1 > INVITE_HOURLY_CAP) {
    return { status: "rate-limited", reason: `Invite limit reached (${INVITE_HOURLY_CAP}/hour for this workspace). Try again later.` };
  }

  // Re-inviting supersedes rather than accumulates: org_invites has no unique key on (org_id, email).
  if (prior.length) await db.delete(orgInvites).where(inArray(orgInvites.id, prior.map((p) => p.id)));
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.orgId, input.orgId)).limit(1);
  const { token, hash } = mintInviteToken();
  const url = `${input.origin}/?invite=${encodeURIComponent(token)}`;
  await db.insert(orgInvites).values({
    orgId: input.orgId,
    email,
    role: input.role,
    tokenHash: hash,
    invitedBy: input.inviter,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  const delivery = await sendOrgInvite({
    workspace: input.orgId,
    workspaceName: org?.name ?? input.orgId,
    role: input.role,
    to: email,
    token,
    acceptUrl: url,
  });
  return {
    status: prior.length ? "resent" : "sent",
    url,
    ...(delivery.delivered ? { delivered: true, via: delivery.via } : { delivered: false, reason: delivery.reason }),
  };
}
