/**
 * The queue nudge's gate (app/api/chat-queue/nudge): who may nudge, and how often. Pure over an injected clock, so
 * scripts/test-web-push.mjs drives it.
 *
 *  - SIGNED: only the agent can nudge — an HMAC with CRON_SECRET over the workspace, session and time
 *    (lib/secret-compare.ts), compared in constant time, within a minute. Without CRON_SECRET, every nudge is
 *    refused (the cron sweep and the owner's tab still send).
 *  - RATE-LIMITED per session: at most one drain started per `minGapMs`, and `perMinute` in any minute. A session
 *    reaches rest at most once per turn; anything faster is not a real rest. The table is bounded.
 */
import { nudgeSignatureValid } from "./secret-compare.ts";

export interface NudgeGateOptions {
  readonly minGapMs?: number;
  readonly perMinute?: number;
  readonly maxSessions?: number;
  readonly now?: () => number;
}

export function createNudgeGate(opts: NudgeGateOptions = {}) {
  const minGap = opts.minGapMs ?? 2_000;
  const perMinute = opts.perMinute ?? 12;
  const maxSessions = opts.maxSessions ?? 5_000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number[]>();
  return {
    /** "ok" | why not. */
    check(input: { signature: string | null; secret: string | null | undefined; orgId: string; sessionId: string }): "ok" | "unsigned" | "rate-limited" {
      if (!nudgeSignatureValid(input.signature, input.secret, input.orgId, input.sessionId, now())) return "unsigned";
      const key = `${input.orgId}:${input.sessionId}`;
      const t = now();
      const recent = (seen.get(key) ?? []).filter((x) => t - x < 60_000);
      if ((recent.length > 0 && t - recent[recent.length - 1] < minGap) || recent.length >= perMinute) {
        seen.set(key, recent);
        return "rate-limited";
      }
      recent.push(t);
      seen.delete(key);
      seen.set(key, recent);
      while (seen.size > maxSessions) seen.delete(seen.keys().next().value as string);
      return "ok";
    },
  };
}
