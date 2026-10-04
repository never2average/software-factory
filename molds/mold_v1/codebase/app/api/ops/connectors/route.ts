import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { connectionsFromEnv, connectionsWorkspace, isProvidedConnectorKind } from "@/lib/connections-provider";
import { workspaceConnectorHealth } from "@/lib/connector-health";
import { connectorSecrets, connectors, runtimeEnvPresence } from "@/agent/lib/db/schema";
import {
  SECRET_NAME_RE,
  UNIMPLEMENTED_KINDS,
  secretsForConnector,
  secretsForKind,
} from "@/lib/connector-secrets-manifest";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createConnectorSchema = z.strictObject({
  /**
   * Who this connector belongs to. The CREATOR chooses.
   *
   *   "me"        → account-level: only this person can see or use it.
   *   "workspace" → organization-level: shared by everyone in the workspace.
   *
   * Defaults to "me", which is the conservative answer: a credential someone
   * adds is theirs until they deliberately share it. Choosing "workspace"
   * requires an admin role — see the RBAC check in POST.
   */
  scope: z.enum(["me", "workspace"]).default("me"),
  name: z.string().min(1),
  kind: z.string().min(1),
  access: z.enum(["read", "write", "read_write"]),
  status: z.string().min(1).optional(),
  detail: z.string().optional(),
  lands: z.string().optional(),
  synced: z.array(z.string()).optional(),
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  enabled: z.boolean().optional(),
  createdBy: z.string().min(1).default("web"),
  /* ---- bring-your-own connector ------------------------------------- *
   * Only meaningful for a kind we don't ship. A built-in kind's contract
   * comes from the static manifest and these are ignored — see
   * secretsForConnector.                                                */
  endpointUrl: z.url().nullable().optional(),
  requiredSecrets: z
    .array(
      z.strictObject({
        // Env-var shape. A free-form name would end up interpolated into the
        // agent's environment and shell-quoting becomes the security boundary.
        name: z.string().regex(SECRET_NAME_RE, "must be UPPER_SNAKE_CASE (A-Z, 0-9, _)"),
        purpose: z.string().min(1).max(200),
        optional: z.boolean().optional(),
      }),
    )
    .max(20)
    .nullable()
    .optional(),
  authSecretName: z.string().regex(SECRET_NAME_RE).nullable().optional(),
});


/**
 * A connector's REAL health, derived from the secrets the running agent holds —
 * not the seeded `status` string, which said "connected" for GitHub, Gmail and
 * Granola while their own detail panel said the token was missing. A green dot
 * next to a missing credential is worse than no dot.
 *
 *   live          — every secret this connector uses is set in the agent
 *   degraded      — the required ones are set, an OPTIONAL one is not: part of
 *                   the connector works and part does not. Slack is exactly this
 *                   — it posts every day, and cannot read a single message.
 *   missing       — a REQUIRED secret is absent: the connector cannot run
 *   unimplemented — no connector code exists for this kind at all
 *   unknown       — the agent has not reported its environment yet
 */
export type ConnectorHealth = "live" | "degraded" | "missing" | "unimplemented" | "unknown";

/**
 * `stored` is the set of secret names an operator has saved against THIS
 * connector. It only counts for a bring-your-own connector, and there it is the
 * whole truth: the agent reads those out of the database at call time, so
 * stored IS live. For a built-in kind the opposite holds — eve's connection
 * modules read process.env at import, so only `runtime_env_presence` can say a
 * credential works, and a stored-but-not-promoted secret must not turn the dot
 * green.
 */
function healthFor(
  connector: { kind: string; requiredSecrets?: { name: string; purpose: string; optional?: boolean }[] | null },
  present: Map<string, boolean>,
  stored?: Set<string>,
  /**
   * CONNECTIONS_PROVIDER=env only (lib/connections-provider.ts): is the server's environment bound to THIS workspace?
   * Undefined with the setting unset, and then nothing below it runs.
   */
  serverIsThisWorkspace?: boolean,
): ConnectorHealth {
  const kind = connector.kind;
  if (UNIMPLEMENTED_KINDS.has(kind.toLowerCase())) return "unimplemented";
  const byo = secretsForKind(kind).length === 0;
  const secrets = secretsForConnector(connector);
  if (secrets.length === 0) return "unknown";
  if (serverIsThisWorkspace !== undefined && isProvidedConnectorKind(kind)) {
    // Off Vercel the agent reads Slack's and GitHub's credentials per workspace at call time: what is stored on
    // this workspace's connector is live, and the server's environment counts only for the workspace it is bound to.
    return workspaceConnectorHealth(secrets, stored, present, serverIsThisWorkspace);
  }
  if (byo) {
    const have = (n: string) => stored?.has(n) ?? false;
    if (!secrets.filter((s) => !s.optional).every((s) => have(s.name))) return "missing";
    return secrets.every((s) => have(s.name)) ? "live" : "degraded";
  }
  // The agent has not reported on these names at all — say so, do not guess.
  if (secrets.some((s) => !present.has(s.name))) return "unknown";
  const required = secrets.filter((s) => !s.optional);
  if (!required.every((s) => present.get(s.name))) return "missing";
  return secrets.every((s) => present.get(s.name)) ? "live" : "degraded";
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const [rows, env, saved] = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      Promise.all([
        tx.select().from(connectors).where(eq(connectors.orgId, ctx.orgId)).orderBy(desc(connectors.createdAt)),
        tx.select().from(runtimeEnvPresence),
        tx
          .select({ connectorId: connectorSecrets.connectorId, name: connectorSecrets.name })
          .from(connectorSecrets),
      ]),
    );
    const present = new Map(env.map((e) => [e.name, e.present]));
    const storedBy = new Map<string, Set<string>>();
    for (const s of saved) {
      const set = storedBy.get(s.connectorId) ?? new Set<string>();
      set.add(s.name);
      storedBy.set(s.connectorId, set);
    }
    // Undefined unless CONNECTIONS_PROVIDER=env: with the setting unset healthFor is called exactly as before.
    const serverIsThisWorkspace = connectionsFromEnv() ? connectionsWorkspace() === ctx.orgId : undefined;
    // A personal connector is never a workspace's credential (the agent does not read it for Slack or GitHub), so
    // what is stored on one does not count.
    const personalProvided = (c: { kind: string; ownerEmail: string | null }) =>
      serverIsThisWorkspace !== undefined && Boolean(c.ownerEmail) && isProvidedConnectorKind(c.kind);
    const items = rows.map((c) => ({
      ...c,
      health: healthFor(c, present, personalProvided(c) ? new Set<string>() : storedBy.get(c.id), serverIsThisWorkspace),
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createConnectorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  /**
   * RBAC on the workspace-wide option.
   *
   * Anyone may add a connector for themselves; only an admin may add one that
   * acts on behalf of the whole workspace. Enforced here rather than only in
   * the UI, because the UI merely hides the control — a POST can still ask.
   */
  const { scope, ...fields } = parsed.data;
  if (scope === "workspace" && !isOrgAdmin(ctx.role)) {
    return NextResponse.json(
      {
        error:
          "Only a workspace owner or admin can add a shared connector. You can add this one for yourself instead.",
        allowedScopes: ["me"],
      },
      { status: 403 },
    );
  }
  if (scope === "me" && !caller) {
    return NextResponse.json(
      { error: "Could not identify you, so this connector has no owner to belong to." },
      { status: 401 },
    );
  }
  const ownerEmail = scope === "me" ? caller! : null;

  try {
    const [item] = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      tx.insert(connectors).values({ ...fields, orgId: ctx.orgId, ownerEmail }).returning(),
    );
    // Best-effort audit trail — a failed audit write never fails the create.
    await recordOpsAudit(db, {
      automationType: "connector",
      automationId: item.id,
      actor: parsed.data.createdBy,
      event:
        `Created ${ownerEmail ? "a personal" : "a shared"} connector "${item.name}"` +
        ` (kind ${item.kind}, access ${item.access})` +
        (ownerEmail ? ` for ${ownerEmail}` : " for the whole workspace"),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
