/**
 * Secrets are compared in CONSTANT TIME. `a !== b` returns at the first differing character, so the time a wrong
 * guess takes leaks how much of it was right. Every CRON_SECRET check and the queue nudge's signature go through
 * here. Pure (node:crypto), so the agent can import it too.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Equal, in time that does not depend on where they differ (both hashed first, so lengths leak nothing either). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** `Authorization: Bearer <CRON_SECRET>`, fail-closed when the secret is unset or empty. */
export function bearerMatches(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret) return false;
  return safeEqual(authorization ?? "", `Bearer ${secret}`);
}

/**
 * THE QUEUE NUDGE'S SIGNATURE (agent/lib/chat-queue-nudge.ts → app/api/chat-queue/nudge). HMAC-SHA256 with
 * CRON_SECRET (set on both projects) over `${ts}.${orgId}.${sessionId}`, sent as `x-queue-nudge: ${ts}.${hex}`.
 * Accepted within `NUDGE_WINDOW_MS` of the web app's clock, so a captured nudge is useless a minute later.
 */
export const NUDGE_HEADER = "x-queue-nudge";
export const NUDGE_WINDOW_MS = 60_000;

export function signNudge(secret: string, orgId: string, sessionId: string, now = Date.now()): string {
  const ts = String(Math.floor(now));
  return `${ts}.${createHmac("sha256", secret).update(`${ts}.${orgId}.${sessionId}`).digest("hex")}`;
}

export function nudgeSignatureValid(
  header: string | null | undefined,
  secret: string | null | undefined,
  orgId: string,
  sessionId: string,
  now = Date.now(),
): boolean {
  if (!secret || !header) return false;
  const dot = header.indexOf(".");
  if (dot <= 0) return false;
  const ts = Number(header.slice(0, dot));
  if (!Number.isFinite(ts) || Math.abs(now - ts) > NUDGE_WINDOW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${header.slice(0, dot)}.${orgId}.${sessionId}`).digest("hex");
  return safeEqual(header.slice(dot + 1), expected);
}
