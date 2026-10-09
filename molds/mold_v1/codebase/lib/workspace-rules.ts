/**
 * WORKSPACE RULES shared by the web app (lib/org-context.ts) and the agent (agent/lib/org-context.ts), so the two
 * can never disagree about which workspace a person is in — they did (review of #63): the web app resolved a
 * Google hosted domain to any workspace NOT SUSPENDED, the agent only to one exactly "active", so a workspace in any
 * third status was the web app's and not the agent's.
 *
 *  - `resolvableByDomain`: a workspace a verified Google hosted-domain claim may resolve to — not suspended.
 *  - `isMember`: an explicit membership row, and nothing else. Used where acting FOR someone who is not there — a
 *    queued message sent after their tab closed (lib/chat-queue-drain.ts), a notification to their devices
 *    (agent/lib/push-recipients.ts). The domain fallback is deliberately NOT part of it: it rests on Google's
 *    verified `hd` claim, which a server acting later does not have, and an emailed-code sign-in never carries —
 *    with it, a REMOVED member whose email merely shares the workspace's domain kept having messages sent as them.
 *
 * Pure (drizzle-orm only), safe to import from both runtimes.
 */
import { ne, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** The status condition for a workspace a hosted domain may resolve to. */
export function resolvableByDomain(status: PgColumn): SQL {
  return ne(status, "suspended");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunIn = <T>(scope: { readonly orgId: string; readonly principal?: string | null }, fn: (tx: any) => Promise<T>) => Promise<T>;

/** Is `email` a member of `orgId` (an `org_members` row)? Fails closed. */
export async function isMember(runIn: RunIn, input: { readonly orgId: string; readonly email: string }): Promise<boolean> {
  const email = input.email.toLowerCase();
  try {
    return await runIn({ orgId: input.orgId }, async (tx) => {
      const r = await tx.execute(sql`select 1 from org_members where org_id = ${input.orgId} and lower(email) = ${email} limit 1`);
      const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? []);
      return rows.length > 0;
    });
  } catch {
    return false;
  }
}
