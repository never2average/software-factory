/**
 * Queued chat messages are sent when the session comes to rest — even with no tab open. On every root
 * `session.waiting`, tell the web app if this session holds any (agent/lib/chat-queue-nudge.ts has the why).
 *
 * Awaited but bounded (5 s; the web app answers 202 at once) so a serverless instance does not freeze with the
 * nudge unsent, and never throws: eve escalates a thrown hook to `turn.failed`.
 */
import { defineHook } from "eve/hooks";
import { nudgeDeps, nudgeIfQueued } from "#lib/chat-queue-nudge.js";
import { callerFromCtx, orgForSession, type SessionCtxLike } from "#lib/org-context.js";
import { inheritedScope } from "#lib/session-scope.js";

async function workspaceOf(ctx: SessionCtxLike & { session: { id: string } }): Promise<string | null> {
  try {
    if (callerFromCtx(ctx).email) return await orgForSession(ctx);
    return (await inheritedScope({ sessionId: ctx.session.id }))?.orgId ?? null;
  } catch {
    return null;
  }
}

export default defineHook({
  events: {
    async "session.waiting"(_event, ctx) {
      await nudgeIfQueued(nudgeDeps, { orgId: await workspaceOf(ctx as never), sessionId: ctx.session.id });
    },
  },
});
