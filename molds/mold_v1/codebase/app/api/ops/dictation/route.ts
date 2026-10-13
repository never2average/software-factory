import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createDictationHandler, DICTATION_SETTINGS } from "@/lib/dictation";
import { cloudflareTranscriberFromEnv } from "@/lib/dictation-cloudflare";
import { resolveAsrChoice } from "@/lib/dictation-models";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { readDictationSession, recordDictationUsage } from "@/lib/usage-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A clip is transcribed in a few seconds; the provider call gives up at 60 s (lib/dictation-cloudflare.ts).
export const maxDuration = 90;

/**
 * GET  /api/ops/dictation   whether the composer shows its microphone button, and the limits it keeps to:
 *                           { enabled, max_seconds, max_bytes, max_session_seconds, idle_stop_seconds }
 * POST /api/ops/dictation   multipart/form-data: `audio` (one clip: a complete audio file), `duration_ms` (its
 *                           length, as the browser measured it), and, for a section of a longer stretch of listening,
 *                           `session_id` (the browser's random id for the stretch) and `seq` (0, 1, 2…)
 *                           -> { text, duration_ms[, session_id, seq] }: the text for the message box, never sent on
 *                           its own. 429 `session_limit` past `max_session_seconds` of audio in one stretch, 429
 *                           `rate_limited` past 40 sections a minute in one.
 *
 * Each request is small: the button sends sections of at most ten seconds as 16 kHz mono WAV, about 320 KB, well
 * under the 4.5 MB body a Vercel function accepts (and `max_bytes` refuses anything larger, unread).
 *
 * Signed in, and in the caller's workspace: the workspace comes from the verified sign-in and a workspace the request
 * names is honoured only for a member (orgContextForRequest), never from the form. The rules, the limits and what is
 * refused are lib/dictation.ts (scripts/test-dictation.mjs drives them with a fake provider); this file only wires
 * the production pieces: the sign-in, the deployment's provider, and the usage ledger (lib/usage-report.ts, a
 * `chat_turn_usage` row of kind "dictation" in the caller's workspace, inside its row-level security scope).
 *
 * No audio is kept: the clip is read into memory, sent to the provider and dropped with the request.
 */
// The profile's model and language, with this deployment's own choice over them (ASR_MODEL, ASR_LANGUAGE, ASR_ENABLED;
// lib/dictation-models.ts). A model it cannot call or price turns dictation off, and says why here, once.
const { settings, problem } = resolveAsrChoice(DICTATION_SETTINGS, process.env);
if (problem) console.error(`[dictation] ${problem}`);

const handler = createDictationHandler({
  settings,
  // Read once per server instance: credentials arrive with the deployment's environment, not per request.
  transcriber: settings.provider === "cloudflare" ? cloudflareTranscriberFromEnv() : null,
  async authorize(request) {
    const ctx = await orgContextForRequest(request);
    if (ctx === null || ctx instanceof Response) return ctx;
    const identity = await verifyOpsAuth(request.headers.get("authorization"));
    if (!identity) return null;
    return { orgId: ctx.orgId, email: identity.email.toLowerCase() };
  },
  // No database configured (a local demo): nothing to record into.
  recordUsage: (row) => (getOpsDb() ? recordDictationUsage(row) : Promise.resolve()),
  // The session's limit is counted from its usage rows; with nothing to record into there is nothing to count.
  sessionTotals: (who, sessionId, now) => (getOpsDb() ? readDictationSession(who.orgId, sessionId, now) : Promise.resolve({ audioMs: 0, lastMinute: 0 })),
  newId: () => randomUUID(),
  now: () => new Date(),
  error: (message, error) => console.error(message, error instanceof Error ? error.message : error),
});

export async function GET(request: NextRequest) {
  return handler.GET(request);
}

export async function POST(request: NextRequest) {
  return handler.POST(request);
}
