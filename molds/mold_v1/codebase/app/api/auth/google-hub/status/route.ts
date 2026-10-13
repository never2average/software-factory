import { NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/google-hub";
import { hubStatus } from "@/lib/google-sign-in-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google-hub/status?return=<origin>: will this deployment, as a sign-in hub, answer that origin?
 *
 * Asked by an app's server before it shows a Google button that goes through this hub (lib/google-sign-in-mode.ts)
 * and by whoever runs the deployments, to see that a hub is set up before anyone meets it. It says: whether the hub
 * is on, whether the origin is on its allow-list, a fingerprint of its Google client (an app and its hub must share
 * one, or the token is for the wrong audience), and whether Google lists the hub's own address.
 *
 * Public, like the sign-in page it describes. It names no person and no other origin on the list: the answer is
 * about the one origin asked for, and "is this address expected here" is what that address's own sign-in page
 * would reveal by trying.
 */
export async function GET(request: NextRequest) {
  const status = await hubStatus(new URL(request.url).searchParams.get("return"), requestOrigin(request));
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
