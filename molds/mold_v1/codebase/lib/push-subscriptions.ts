/**
 * THE DEVICES A PERSON ASKED TO BE NOTIFIED ON (`push_subscriptions`) — read and written here so the route
 * (app/api/ops/push) and the database test (scripts/test-chat-queue-db.mjs) run the same code.
 *
 *  1. OWNER-ONLY. Every call names the caller as `app.principal_email` (the restrictive owner policy, drizzle/0021)
 *     and filters on them as well.
 *  2. NO TAKEOVER. One endpoint is one browser profile. A row for it under ANOTHER person in the workspace is
 *     refused, never rewritten — otherwise anyone who learned an endpoint could re-home someone's notifications or
 *     silence them. The upsert is guarded at write time too (`setWhere owner = me`). A shared computer is handled by
 *     sign-out, which removes the device's row.
 *  3. PER DEVICE, PER WORKSPACE. The same browser subscribed in two workspaces is two rows; turning it off in one
 *     leaves the other.
 */
import { and, eq, sql } from "drizzle-orm";
import { pushSubscriptions } from "../agent/lib/db/schema.ts";
import type { RunIn } from "./chat-queue-server.ts";
import { isAllowedPushEndpoint } from "../agent/lib/web-push.ts";

export interface SubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * A well-formed browser subscription: an endpoint at one of the browsers' push services (never any other host —
 * the server POSTs to it; agent/lib/web-push.ts `isAllowedPushEndpoint`) and the two base64url keys.
 */
export function invalidSubscription(sub: SubscriptionInput | null | undefined): string | null {
  if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 2000) return "bad endpoint";
  if (!isAllowedPushEndpoint(sub.endpoint)) return "bad endpoint";
  if (typeof sub.keys?.p256dh !== "string" || !B64U.test(sub.keys.p256dh) || sub.keys.p256dh.length > 200) return "bad key";
  if (typeof sub.keys?.auth !== "string" || !B64U.test(sub.keys.auth) || sub.keys.auth.length > 100) return "bad key";
  return null;
}


export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid" | "foreign" };

/** Turn notifications on for this device (or refresh its keys / preview choice). */
export async function saveSubscription(
  runIn: RunIn,
  input: {
    readonly orgId: string;
    readonly email: string;
    readonly subscription: SubscriptionInput;
    readonly preview?: boolean;
    readonly userAgent?: string | null;
  },
): Promise<SaveResult> {
  const email = input.email.toLowerCase();
  if (invalidSubscription(input.subscription)) return { ok: false, reason: "invalid" };
  const { endpoint, keys } = input.subscription;
  // Rule 2, asked with no person named so the owner policy cannot hide the row that says "not yours".
  const [existing] = (await runIn({ orgId: input.orgId }, (tx) =>
    tx
      .select({ ownerEmail: pushSubscriptions.ownerEmail })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.orgId, input.orgId), eq(pushSubscriptions.endpoint, endpoint)))
      .limit(1),
  )) as Array<{ ownerEmail: string }>;
  if (existing && existing.ownerEmail.toLowerCase() !== email) return { ok: false, reason: "foreign" };
  await runIn({ orgId: input.orgId, principal: email }, (tx) =>
    tx
      .insert(pushSubscriptions)
      .values({
        orgId: input.orgId,
        ownerEmail: email,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        preview: input.preview ?? true,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.orgId, pushSubscriptions.endpoint],
        set: {
          p256dh: keys.p256dh,
          auth: keys.auth,
          ...(input.preview === undefined ? {} : { preview: input.preview }),
          userAgent: input.userAgent?.slice(0, 300) ?? null,
          updatedAt: new Date(),
        },
        setWhere: eq(pushSubscriptions.ownerEmail, email),
      }),
  );
  return { ok: true };
}

/** "Show message preview in notifications" for this device. */
export async function setPreview(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly endpoint: string; readonly preview: boolean },
): Promise<boolean> {
  const email = input.email.toLowerCase();
  const rows = (await runIn({ orgId: input.orgId, principal: email }, (tx) =>
    tx
      .update(pushSubscriptions)
      .set({ preview: input.preview, updatedAt: new Date() })
      .where(
        and(
          eq(pushSubscriptions.orgId, input.orgId),
          eq(pushSubscriptions.ownerEmail, email),
          eq(pushSubscriptions.endpoint, input.endpoint),
        ),
      )
      .returning({ id: pushSubscriptions.id }),
  )) as unknown[];
  return rows.length > 0;
}

/** Turn this device off (the toggle, or sign-out). Only ever the caller's own row. */
export async function removeSubscription(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly endpoint: string },
): Promise<number> {
  const email = input.email.toLowerCase();
  const rows = (await runIn({ orgId: input.orgId, principal: email }, (tx) =>
    tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.orgId, input.orgId),
          eq(pushSubscriptions.ownerEmail, email),
          eq(pushSubscriptions.endpoint, input.endpoint),
        ),
      )
      .returning({ id: pushSubscriptions.id }),
  )) as unknown[];
  return rows.length;
}

/** This device's state for the caller: subscribed here, and its preview choice. */
export async function readSubscription(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly endpoint: string },
): Promise<{ readonly subscribed: boolean; readonly preview: boolean }> {
  const email = input.email.toLowerCase();
  const [row] = (await runIn({ orgId: input.orgId, principal: email }, (tx) =>
    tx
      .select({ preview: pushSubscriptions.preview })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.orgId, input.orgId),
          eq(pushSubscriptions.ownerEmail, email),
          eq(pushSubscriptions.endpoint, input.endpoint),
        ),
      )
      .limit(1),
  )) as Array<{ preview: boolean }>;
  return { subscribed: Boolean(row), preview: row?.preview ?? true };
}

/** How many devices the caller has in this workspace (the settings line says "on N devices"). */
export async function countSubscriptions(runIn: RunIn, input: { readonly orgId: string; readonly email: string }): Promise<number> {
  const email = input.email.toLowerCase();
  const [row] = (await runIn({ orgId: input.orgId, principal: email }, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.orgId, input.orgId), eq(pushSubscriptions.ownerEmail, email))),
  )) as Array<{ n: number }>;
  return row?.n ?? 0;
}
