import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createDictationHandler, DICTATION_SETTINGS } from "@/lib/dictation";
import { cloudflareTranscriberFromEnv } from "@/lib/dictation-cloudflare";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { recordDictationUsage } from "@/lib/usage-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A two-minute clip is transcribed in a few seconds; the provider call gives up at 60 s (lib/dictation-cloudflare.ts).
export const maxDuration = 90;

/**
 * GET  /api/ops/dictation   whether the composer shows its microphone button, and the limits it keeps to:
 *                           { enabled, max_seconds, max_bytes }
 * POST /api/ops/dictation   multipart/form-data: `audio` (the clip), `duration_ms` (its length, from the recorder)
 *                           -> { text, duration_ms }: the text for the message box, never sent on its own
 *
 * Signed in, and in the caller's workspace: the workspace comes from the verified sign-in and a workspace the request
 * names is honoured only for a member (orgContextForRequest), never from the form. The rules, the limits and what is
 * refused are lib/dictation.ts (scripts/test-dictation.mjs drives them with a fake provider); this file only wires
 * the production pieces: the sign-in, the deployment's provider, and the usage ledger (lib/usage-report.ts, a
 * `chat_turn_usage` row of kind "dictation" in the caller's workspace, inside its row-level security scope).
 *
 * No audio is kept: the clip is read into memory, sent to the provider and dropped with the request.
 */
const handler = createDictationHandler({
  settings: DICTATION_SETTINGS,
  // Read once per server instance: credentials arrive with the deployment's environment, not per request.
  transcriber: DICTATION_SETTINGS.provider === "cloudflare" ? cloudflareTranscriberFromEnv() : null,
  async authorize(request) {
    const ctx = await orgContextForRequest(request);
    if (ctx === null || ctx instanceof Response) return ctx;
    const identity = await verifyOpsAuth(request.headers.get("authorization"));
    if (!identity) return null;
    return { orgId: ctx.orgId, email: identity.email.toLowerCase() };
  },
  // No database configured (a local demo): nothing to record into.
  recordUsage: (row) => (getOpsDb() ? recordDictationUsage(row) : Promise.resolve()),
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
