/**
 * REMOVING A MEMBER, in one transaction (app/api/ops/orgs/[id]/members/[email]): their membership, the messages
 * they queued that have not gone (they would otherwise be sent as someone no longer here), and their notification
 * devices in that workspace. All or nothing: if any of it fails, nothing is removed and the caller is told — a
 * removal that "succeeded" while their queue and devices stayed is exactly the gap this closes (review of #63).
 *
 * `runIn` runs `fn` in ONE transaction scoped to the workspace (withOrgRls / withOrgDb); `org_members` is the
 * control plane (no RLS), the other two are org-scoped. Shared by the route and scripts/test-chat-queue-db.mjs.
 */
import { sql } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunIn = <T>(scope: { readonly orgId: string; readonly principal?: string | null }, fn: (tx: any) => Promise<T>) => Promise<T>;

const count = (r: unknown): number =>
  Array.isArray(r) ? r.length : ((r as { rows?: unknown[] } | null)?.rows?.length ?? 0);

export async function removeMemberEverywhere(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string },
): Promise<{ readonly membership: number; readonly queued: number; readonly devices: number }> {
  const email = input.email.toLowerCase();
  return runIn({ orgId: input.orgId }, async (tx) => {
    const membership = count(
      await tx.execute(sql`delete from org_members where org_id = ${input.orgId} and lower(email) = ${email} returning email`),
    );
    const queued = count(
      await tx.execute(
        sql`delete from chat_queue_items where org_id = ${input.orgId} and owner_email = ${email} and state <> 'sent' returning id`,
      ),
    );
    const devices = count(
      await tx.execute(sql`delete from push_subscriptions where org_id = ${input.orgId} and owner_email = ${email} returning id`),
    );
    return { membership, queued, devices };
  });
}
