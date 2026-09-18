import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { connectorSecrets, connectors, runtimeEnvPresence } from "@/agent/lib/db/schema";
import { secretsForConnector } from "@/lib/connector-secrets-manifest";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { MissingSecretsKeyError, encryptSecret, hasSecretsKey } from "@/lib/secret-crypto";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A connector's secrets: what it NEEDS, what the running agent actually HAS,
 * and what an operator has stored here.
 *
 * The two are reported separately on purpose. `live` comes from
 * `runtime_env_presence`, which the agent's every-minute dispatcher writes about
 * its OWN process — that is the only thing that can truthfully say a token is
 * working, because the Ops Center runs in a different Vercel project and its
 * process.env says nothing about the agent's. `stored` is what was typed in
 * here, encrypted at rest.
 *
 * A stored secret does NOT make a connector live: eve's connection modules read
 * process.env at import time, so it has to be promoted to the agent's
 * environment (`vercel env add <NAME>` on fde-agent-api). The UI says so rather
 * than implying a green light.
 *
 * NO ROUTE HERE EVER RETURNS A SECRET VALUE — only whether one exists and its
 * last-4 hint.
 */
const uuidSchema = z.uuid();

const putSchema = z.strictObject({
  name: z.string().min(1),
  // Empty string is not "clear" — use DELETE. This avoids a mistyped blank
  // silently wiping a working credential.
  value: z.string().min(1),
  actor: z.string().min(1).optional(),
});

const deleteSchema = z.strictObject({
  name: z.string().min(1),
  actor: z.string().min(1).optional(),
});

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The connector, scoped to the CALLER'S workspace.
 *
 * The org filter is the security boundary, not a convenience. Without it a
 * connector id — a value that travels in URLs and audit logs — was enough to
 * read, overwrite or delete another workspace's credentials, because ids are
 * globally unique and nothing else checked ownership. Returning null for a
 * foreign row also means the caller learns nothing about whether it exists.
 */
async function loadConnector(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  id: string,
  orgId: string,
) {
  const [row] = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), eq(connectors.orgId, orgId)))
      .limit(1),
  );
  return row ?? null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  // This route had no org context at all. Secret VALUES were never exposed, but
  // names, last-4 hints and who-set-them-when were readable across workspaces
  // by anyone signed in — enough to fingerprint another tenant's stack.
  const octx = await orgContextForRequest(request);
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }
  try {
   return await withOrgRls({ orgId: octx.orgId, principal: caller }, async (db) => {
    const connector = await loadConnector(db, id, octx.orgId);
    if (!connector) return NextResponse.json({ error: "Connector not found" }, { status: 404 });

    const required = secretsForConnector(connector);
    const names = required.map((r) => r.name);

    const stored = await withOrgRls(octx.orgId, (tx) =>
      tx
        .select({
          name: connectorSecrets.name,
          hint: connectorSecrets.hint,
          updatedBy: connectorSecrets.updatedBy,
          updatedAt: connectorSecrets.updatedAt,
        })
        .from(connectorSecrets)
        .where(and(eq(connectorSecrets.connectorId, id), eq(connectorSecrets.orgId, octx.orgId))),
    );

    const live = names.length
      ? await withOrgRls({ orgId: octx.orgId, principal: caller }, (tx) =>
          tx.select().from(runtimeEnvPresence).where(inArray(runtimeEnvPresence.name, names)),
        )
      : [];

    const items = required.map((r) => {
      const s = stored.find((x) => x.name === r.name);
      const l = live.find((x) => x.name === r.name);
      return {
        name: r.name,
        purpose: r.purpose,
        optional: r.optional ?? false,
        // Set in the RUNNING agent's environment — the only thing that means
        // the connector actually works. `null` = the agent has not reported yet.
        live: l ? l.present : null,
        liveSeenAt: l?.seenAt ?? null,
        // Stored here (encrypted). Not the same as live.
        stored: Boolean(s),
        hint: s?.hint ?? null,
        updatedBy: s?.updatedBy ?? null,
        updatedAt: s?.updatedAt ?? null,
      };
    });
    return NextResponse.json({ items, canStore: hasSecretsKey() });
   });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const octx = await orgContextForRequest(request);
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Storing a credential is an administrative act — it decides what the agent
  // can reach and act as. Matches the bar on agent-configs.
  if (!isOrgAdmin(octx.role)) {
    return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { name, value, actor = "web" } = parsed.data;

  try {
   return await withOrgRls({ orgId: octx.orgId, principal: caller }, async (db) => {
    const connector = await loadConnector(db, id, octx.orgId);
    if (!connector) return NextResponse.json({ error: "Connector not found" }, { status: 404 });
    // Only names this connector kind actually consumes — a secret nothing reads
    // is a liability with no upside.
    // For a bring-your-own connector this is the row's own declared contract —
    // see secretsForConnector. Either way the rule holds: a secret nothing
    // reads is a liability with no upside.
    const allowed = secretsForConnector(connector);
    if (!allowed.some((r) => r.name === name)) {
      const hint = allowed.length
        ? `It uses: ${allowed.map((r) => r.name).join(", ")}.`
        : `It declares no secrets — set requiredSecrets on the connector first.`;
      return NextResponse.json(
        { error: `${connector.kind} does not use a secret named ${name}. ${hint}` },
        { status: 400 },
      );
    }

    // Sealed with the connector's own key: the workspace's for a shared
    // connector, workspace+owner for a personal one, so a personal credential
    // is not readable with the workspace key.
    const sealed = encryptSecret(value.trim(), octx.orgId, connector.ownerEmail);
    const existing = await withOrgRls(octx.orgId, (tx) =>
      tx
        .select({ id: connectorSecrets.id })
        .from(connectorSecrets)
        .where(
          and(
            eq(connectorSecrets.connectorId, id),
            eq(connectorSecrets.name, name),
            eq(connectorSecrets.orgId, octx.orgId),
          ),
        )
        .limit(1),
    );

    if (existing.length) {
      await withOrgRls(octx.orgId, (tx) =>
        tx
          .update(connectorSecrets)
          .set({ ...sealed, orgId: octx.orgId, updatedBy: actor, updatedAt: new Date() })
          .where(eq(connectorSecrets.id, existing[0].id)),
      );
    } else {
      await withOrgRls(octx.orgId, (tx) =>
        tx
          .insert(connectorSecrets)
          .values({ connectorId: id, orgId: octx.orgId, name, ...sealed, updatedBy: actor }),
      );
    }

    // The audit records the NAME and never the value — not even the hint.
    await recordOpsAudit(db, {
      automationType: "connector",
      automationId: id,
      actor,
      orgId: octx.orgId,
      event: existing.length ? `Secret ${name} replaced` : `Secret ${name} stored`,
    });
    return NextResponse.json({ ok: true });
   });
  } catch (e) {
    if (e instanceof MissingSecretsKeyError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  // Worst of the three before this: no org context whatsoever, so a connector
  // id was enough for any signed-in user to destroy another workspace's stored
  // credential — silently, since the audit row was written against that org.
  const octx = await orgContextForRequest(request);
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOrgAdmin(octx.role)) {
    return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { name, actor = "web" } = parsed.data;
  try {
   return await withOrgRls({ orgId: octx.orgId, principal: caller }, async (db) => {
    const connector = await loadConnector(db, id, octx.orgId);
    if (!connector) return NextResponse.json({ error: "Connector not found" }, { status: 404 });
    const deleted = await withOrgRls(octx.orgId, (tx) =>
      tx
        .delete(connectorSecrets)
        .where(
          and(
            eq(connectorSecrets.connectorId, id),
            eq(connectorSecrets.name, name),
            eq(connectorSecrets.orgId, octx.orgId),
          ),
        )
        .returning({ id: connectorSecrets.id }),
    );
    if (!deleted.length) {
      return NextResponse.json({ error: `No stored secret named ${name}.` }, { status: 404 });
    }
    await recordOpsAudit(db, {
      automationType: "connector",
      automationId: id,
      actor,
      orgId: octx.orgId,
      event: `Secret ${name} deleted`,
    });
    return NextResponse.json({ deleted: true });
   });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
