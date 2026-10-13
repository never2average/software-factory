import { NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/google-hub";
import { googleAvailability } from "@/lib/google-sign-in-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/availability: how Google sign-in works at the address this page was served from: `direct`,
 * through a `hub`, or `none` (lib/google-sign-in-mode.ts). The sign-in page asks before it draws a Google button, so
 * a button is only ever drawn where it leads somewhere.
 *
 * Public and about no one: it says what the page itself would show. `reason` and `listed` are for whoever runs the
 * deployment (and the checks that run after a deploy); the page reads `google` and `oneTap`.
 */
export async function GET(request: NextRequest) {
  const availability = await googleAvailability(requestOrigin(request));
  return NextResponse.json(availability, { headers: { "cache-control": "no-store" } });
}
