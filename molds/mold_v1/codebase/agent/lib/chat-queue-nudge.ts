/**
 * THE QUEUE'S NUDGE — the agent's half of sending a queued chat message after its tab has closed.
 *
 * Messages typed while a turn runs are held on the server (`chat_queue_items`, lib/chat-queue-server.ts) and sent
 * by the WEB app when the session comes to rest (lib/chat-queue-drain.ts), as the person who queued them. The web
 * app cannot see the session come to rest; the agent can, because `session.waiting` is its own event. So on every
 * root `session.waiting`, this asks one indexed question — does this session hold anything queued? — and if so
 * tells the web app (POST ${WEB_ORIGIN}/api/chat-queue/nudge). The nudge carries only the session and workspace,
 * SIGNED with CRON_SECRET (set on both projects; lib/secret-compare.ts), and the web app still reads the session's
 * own stream before sending anything. No CRON_SECRET here: no nudge (the sweep and the owner's tab still send).
 *
 * Never throws, never waits long (the web app answers 202 at once and sends after), and does nothing without a
 * database. A nudge that is lost costs a minute: /api/cron/deliver-queued sweeps what the hook missed.
 */
import { sql } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { NUDGE_HEADER, signNudge } from "../../lib/secret-compare.ts";
import { webOriginSetting } from "../../lib/web-origin.ts";

export interface NudgeDeps {
  /** Does this session hold a queued message in this workspace? */
  hasQueued(orgId: string, sessionId: string): Promise<boolean>;
  post(url: string, body: { sessionId: string; orgId: string }, signature: string): Promise<number>;
  webOrigin(): string | null;
  /** The shared secret the nudge is signed with (CRON_SECRET); null → no nudge. */
  secret(): string | null;
}

export async function nudgeIfQueued(deps: NudgeDeps, input: { orgId: string | null; sessionId: string | undefined }): Promise<"sent" | "none" | "skipped"> {
  try {
    if (!input.orgId || !input.sessionId) return "skipped";
    const origin = deps.webOrigin();
    const secret = deps.secret();
    if (!origin || !secret) return "skipped";
    if (!(await deps.hasQueued(input.orgId, input.sessionId))) return "none";
    const status = await deps.post(
      `${origin.replace(/\/+$/, "")}/api/chat-queue/nudge`,
      { sessionId: input.sessionId, orgId: input.orgId },
      signNudge(secret, input.orgId, input.sessionId),
    );
    return status >= 200 && status < 300 ? "sent" : "skipped";
  } catch {
    return "skipped";
  }
}

export const nudgeDeps: NudgeDeps = {
  async hasQueued(orgId, sessionId) {
    if (!getDb()) return false;
    try {
      const rows = (await withOrgDb(orgId, (tx) =>
        tx.execute(sql`select 1 from chat_queue_items where org_id = ${orgId} and eve_session_id = ${sessionId} and state in ('queued', 'sending') limit 1`),
      )) as unknown as unknown[];
      return Array.isArray(rows) ? rows.length > 0 : ((rows as { rows?: unknown[] })?.rows?.length ?? 0) > 0;
    } catch {
      // Before migration 0021 there is no table: nothing is queued.
      return false;
    }
  },
  async post(url, body, signature) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [NUDGE_HEADER]: signature },
        redirect: "manual",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      return res.status;
    } catch {
      return 0;
    }
  },
  secret() {
    return process.env.CRON_SECRET?.trim() || null;
  },
  webOrigin() {
    // The web app's address, as agent/channels/eve.ts reads it for CORS. Unset: no nudge (the sweep still sends).
    return webOriginSetting();
  },
};
