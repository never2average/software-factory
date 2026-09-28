import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isEmptyStore } from "@/lib/pg-error";
import {
  enqueueItem,
  listQueue,
  removeQueued,
  updateQueued,
  type QueueItemInput,
  type QueuePatch,
  type QueueRow,
} from "@/lib/chat-queue-server";
import { backgroundDeliveryAvailable, runInOrg } from "@/lib/chat-queue-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A chat's QUEUE — messages typed while the agent was working — held on the server so closing the tab does not lose
 * them (lib/chat-queue-server.ts has every rule; lib/chat-queue-drain.ts sends them).
 *
 *   GET    /api/ops/chat-queue?session=<eve session id>  — the caller's items for that chat
 *   POST   /api/ops/chat-queue { item }                  — queue one (idempotent on item.id)
 *   PATCH  /api/ops/chat-queue { id, patch }             — edit / reorder / attachments landed / send without / requeue
 *   DELETE /api/ops/chat-queue?id=<item id>              — × (only while it has not gone)
 *
 * OWNER-ONLY: every call acts as the signed-in person in their workspace (withOrgRls with the person named, so the
 * restrictive owner policy applies), and the library filters on them too.
 *
 * tenancy-ok: every read and write goes through lib/chat-queue-server.ts on `runInOrg` (withOrgRls with the caller's
 * workspace and person). The only bare handle is the `getOpsDb()` null check, which opens no connection.
 */

/** What a tab sees of an item: everything but the claim bookkeeping. */
function view(r: QueueRow) {
  return {
    id: r.id,
    sessionId: r.eveSessionId,
    chatId: r.chatId,
    text: r.text,
    // What actually went, once sent (with its delivery reference) — what the tab matches the reply against.
    message: r.state === "sent" && r.sentMessage ? r.sentMessage : r.message,
    settings: r.settings,
    goal: r.goal,
    attachments: r.attachments.map((a) => ({ name: a.name })),
    filesPending: r.filesPending,
    fileNames: r.fileNames,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sentAt: r.sentAt,
    sentBy: r.sentBy,
  };
}

async function caller(request: NextRequest) {
  const email = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!email) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  if (!getOpsDb()) {
    return { error: NextResponse.json({ error: "The queue needs a database, and none is configured." }, { status: 503 }) } as const;
  }
  const ctx = await orgContextForRequest(request);
  if (!ctx) return { error: NextResponse.json({ error: "workspace unavailable" }, { status: 503 }) } as const;
  return { email, orgId: ctx.orgId } as const;
}

export async function GET(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const sessionId = request.nextUrl.searchParams.get("session");
  if (!sessionId) return NextResponse.json({ error: "session is required" }, { status: 400 });
  try {
    const rows = await listQueue(runInOrg, { orgId: who.orgId, email: who.email, sessionId });
    return NextResponse.json({ items: rows.map(view), background: backgroundDeliveryAvailable() });
  } catch (e) {
    // Only an absent table (before migration 0021) is emptiness; anything else is a failure the tab must see.
    if (isEmptyStore(e)) return NextResponse.json({ items: [], background: false, unavailable: true });
    return NextResponse.json({ error: "The queue could not be read." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const body = (await request.json().catch(() => null)) as { item?: QueueItemInput } | null;
  if (!body?.item) return NextResponse.json({ error: "item is required" }, { status: 400 });
  try {
    const res = await enqueueItem(runInOrg, { orgId: who.orgId, email: who.email, item: body.item });
    if (!res.ok) {
      // "not-your-chat": only the chat's own owner may queue into it (the tab then keeps the message itself).
      const status = res.reason === "foreign" ? 409 : res.reason === "full" ? 429 : res.reason === "not-your-chat" ? 403 : 400;
      return NextResponse.json({ error: res.reason, detail: res.detail }, { status });
    }
    return NextResponse.json({ item: view(res.row) });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    return NextResponse.json({ error: "The message could not be queued." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const body = (await request.json().catch(() => null)) as { id?: string; patch?: QueuePatch } | null;
  if (!body?.id || !body.patch) return NextResponse.json({ error: "id and patch are required" }, { status: 400 });
  try {
    const row = await updateQueued(runInOrg, { orgId: who.orgId, email: who.email, id: body.id, patch: body.patch });
    if (!row) return NextResponse.json({ error: "That message has already been sent, or is not yours." }, { status: 409 });
    return NextResponse.json({ item: view(row) });
  } catch {
    return NextResponse.json({ error: "The message could not be changed." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const who = await caller(request);
  if ("error" in who) return who.error;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const result = await removeQueued(runInOrg, { orgId: who.orgId, email: who.email, id });
    if (result === "already-sent") {
      return NextResponse.json({ error: "already-sent", message: "That message was already sent." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, result });
  } catch {
    return NextResponse.json({ error: "The message could not be removed." }, { status: 503 });
  }
}
