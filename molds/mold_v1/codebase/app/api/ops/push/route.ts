import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { runInOrg } from "@/lib/chat-queue-runtime";
import { readSubscription, removeSubscription, saveSubscription, setPreview, type SubscriptionInput } from "@/lib/push-subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DESKTOP NOTIFICATIONS — this device's subscription (lib/push-subscriptions.ts has the rules).
 *
 *   GET    /api/ops/push?endpoint=<this browser's endpoint>  — available here? the public key; subscribed? preview?
 *   POST   /api/ops/push { subscription, preview }          — turn it on for this device
 *   PATCH  /api/ops/push { endpoint, preview }              — "Show message preview in notifications"
 *   DELETE /api/ops/push?endpoint=…                         — turn it off (also on sign-out)
 *
 * AVAILABLE only when this server has a VAPID public key (VAPID_PUBLIC_KEY) and a database. Without either the
 * toggle is hidden behind a "not available" note; nothing else changes. The keys are set by whoever runs the
 * platform; the agent sends with the matching VAPID_PRIVATE_KEY and VAPID_SUBJECT (agent/lib/web-push.ts).
 *
 * tenancy-ok: every read and write runs through lib/push-subscriptions.ts on `runInOrg` (withOrgRls, the caller's
 * workspace and person). The only bare handle is the `getOpsDb()` null check.
 */
function publicKey(): string | null {
  const key = process.env.VAPID_PUBLIC_KEY?.trim();
  if (!key) return null;
  try {
    return Buffer.from(key, "base64url").length === 65 ? key : null;
  } catch {
    return null;
  }
}

async function caller(request: NextRequest) {
  const email = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!email) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  if (!getOpsDb()) return { error: NextResponse.json({ error: "unavailable" }, { status: 503 }) } as const;
  const ctx = await orgContextForRequest(request);
  if (!ctx) return { error: NextResponse.json({ error: "workspace unavailable" }, { status: 503 }) } as const;
  return { email, orgId: ctx.orgId } as const;
}

export async function GET(request: NextRequest) {
  const key = publicKey();
  if (!key || !getOpsDb()) return NextResponse.json({ available: false });
  const who = await caller(request);
  if ("error" in who) return who.error;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  try {
    const state = endpoint
      ? await readSubscription(runInOrg, { orgId: who.orgId, email: who.email, endpoint })
      : { subscribed: false, preview: true };
    return NextResponse.json({ available: true, publicKey: key, ...state });
  } catch {
    // Before migration 0021: the feature is simply not here yet.
    return NextResponse.json({ available: false });
  }
}

export async function POST(request: NextRequest) {
  if (!publicKey()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const who = await caller(request);
  if ("error" in who) return who.error;
  const body = (await request.json().catch(() => null)) as { subscription?: SubscriptionInput; preview?: unknown } | null;
  if (!body?.subscription) return NextResponse.json({ error: "subscription is required" }, { status: 400 });
  try {
    const res = await saveSubscription(runInOrg, {
      orgId: who.orgId,
      email: who.email,
      subscription: body.subscription,
      preview: typeof body.preview === "boolean" ? body.preview : undefined,
      userAgent: request.headers.get("user-agent"),
    });
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: res.reason === "foreign" ? 409 : 400 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Notifications could not be turned on." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown; preview?: unknown } | null;
  if (typeof body?.endpoint !== "string" || typeof body.preview !== "boolean") {
    return NextResponse.json({ error: "endpoint and preview are required" }, { status: 400 });
  }
  try {
    const ok = await setPreview(runInOrg, { orgId: who.orgId, email: who.email, endpoint: body.endpoint, preview: body.preview });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not subscribed" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "The setting could not be saved." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  try {
    const removed = await removeSubscription(runInOrg, { orgId: who.orgId, email: who.email, endpoint });
    return NextResponse.json({ ok: true, removed });
  } catch {
    return NextResponse.json({ error: "Notifications could not be turned off." }, { status: 503 });
  }
}
