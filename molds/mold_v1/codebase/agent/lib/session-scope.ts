/**
 * The workspace a session belongs to, for sessions that carry no identity of their own.
 *
 * See `agentSessionScopes` in db/schema.ts for why this exists. Two halves:
 *
 *   recordSessionScope  — the ROOT agent, which has the signed-in person's identity, records its session's
 *                         workspace at the start of every turn (awaited, so the row exists before the model
 *                         can delegate).
 *   inheritedScope      — a child session looks up its ROOT session's row. The id comes from
 *                         `ctx.session.parent.rootSessionId`, which eve sets; nothing the model writes can
 *                         change which row is read, so a subagent cannot be talked into another workspace.
 *
 * Deliberately imports nothing from org-context.ts (which imports this).
 */
import { eq } from "drizzle-orm";
import { acrossOrgDbs, getDb, withOrgDb } from "./db/index.ts";
import { agentSessionScopes } from "./db/schema.ts";

export interface SessionScope {
  readonly orgId: string;
  readonly email: string | null;
}

/** Process-local: a session's workspace never changes, so a hit is good for the life of the process. */
const cache = new Map<string, SessionScope>();
const MAX_CACHE = 2_000;
function remember(sessionId: string, scope: SessionScope) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(sessionId, scope);
}

/** Best-effort and never throws: failing to record must not fail the turn that called it. */
export async function recordSessionScope(sessionId: string | undefined, orgId: string, email: string | undefined): Promise<void> {
  if (!sessionId || !orgId || !email) return; // only a turn with a real person behind it defines a scope
  const known = cache.get(sessionId);
  if (known && known.orgId === orgId) return;
  try {
    if (!getDb()) return;
    await withOrgDb(orgId, (tx) =>
      tx
        .insert(agentSessionScopes)
        .values({ sessionId, orgId, principalEmail: email.toLowerCase() })
        .onConflictDoUpdate({
          target: agentSessionScopes.sessionId,
          set: { orgId, principalEmail: email.toLowerCase(), updatedAt: new Date() },
        }),
    );
    remember(sessionId, { orgId, email: email.toLowerCase() });
  } catch (error) {
    console.error(`[session-scope] could not record the workspace of session ${sessionId}:`, error);
  }
}

interface ParentLike {
  readonly rootSessionId?: string;
  readonly sessionId?: string;
}

/**
 * The scope a child session inherits from the session that (transitively) delegated to it, or null.
 * One short retry: the root records its scope before its first model call, so a miss is almost always a
 * replica a moment behind, not an absent row.
 */
export async function inheritedScope(parent: ParentLike | null | undefined): Promise<SessionScope | null> {
  const rootId = parent?.rootSessionId ?? parent?.sessionId;
  if (!rootId) return null;
  const hit = cache.get(rootId);
  if (hit) return hit;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = await acrossOrgDbs((tx) =>
        tx
          .select({ orgId: agentSessionScopes.orgId, email: agentSessionScopes.principalEmail })
          .from(agentSessionScopes)
          .where(eq(agentSessionScopes.sessionId, rootId))
          .limit(1),
      );
      if (rows[0]) {
        const scope = { orgId: rows[0].orgId, email: rows[0].email ?? null };
        remember(rootId, scope);
        return scope;
      }
    } catch (error) {
      console.error(`[session-scope] lookup failed for root session ${rootId}:`, error);
      return null;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
