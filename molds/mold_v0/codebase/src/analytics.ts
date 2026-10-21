/**
 * Per-organization MCP activity: which connector methods and tools each org calls, whether they worked and how long
 * they took. Never stores tool arguments or results. Recording is best effort and never blocks or fails a request.
 */
import type { Org } from "./auth.js";
import { getDb } from "./db.js";
import { hosts } from "./host.js";
import { capture, identifyOrg, identifyPerson, posthogEnabled } from "./telemetry.js";

export interface McpEvent {
  method: string; name?: string | null; client?: string | null; ok?: boolean; error?: string | null; ms?: number | null;
  /** mold_v0-008: the error's class (src/usage-report.ts errorClass), the request's arguments' and the answer's sizes in bytes. */
  error_class?: string | null; req_bytes?: number | null; res_bytes?: number | null;
}

/**
 * A failed call's class (mold_v0-008): what kind of failure it was, never its text or arguments. A database error
 * (SQLSTATE), a refusal (permission, row-level security), a limit (budget, rate, size), a bad argument, a missing
 * thing, or anything else.
 */
export function errorClass(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown; name?: unknown; issues?: unknown };
  if (e?.code === "42501") return "refused";
  if (typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return "database";
  const status = typeof e?.status === "number" ? e.status : null;
  if (status === 429 || status === 413) return "limit";
  if (status === 401 || status === 403) return "refused";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422 || e?.name === "ZodError" || Array.isArray(e?.issues)) return "invalid_input";
  if (status === 409) return "conflict";
  return "error";
}

/** The size of a value as JSON, in bytes (0 when it cannot be measured). */
export const jsonBytes = (v: unknown) => { try { return Buffer.byteLength(JSON.stringify(v ?? null)); } catch { return 0; } };

const identified = new Set<string>();
/** Once per process per person: their email and account in PostHog (journeys email them and target by account). */
async function identifyUser(org: Org) {
  if (!posthogEnabled() || !org.userId || identified.has(org.userId)) return;
  identified.add(org.userId);
  const { clerkEnabled, displayName, primaryEmail, users } = await import("./clerk.js");
  if (!clerkEnabled()) return;
  const u = await users.get(org.userId).catch(() => null);
  if (u) identifyPerson(org.userId, { email: primaryEmail(u).email ?? undefined, name: displayName(u) ?? undefined, account: org.slug, account_name: org.name });
}

/** PostHog event names for the connector methods worth a funnel step; everything else stays in mcp_events only. */
const PRODUCT_EVENTS: Record<string, string> = { initialize: "mcp_connected", "tools/list": "mcp_tools_listed", "resources/read": "mcp_dashboard_loaded", "prompts/get": "mcp_prompt_used" };

export function recordMcpEvent(org: Org, e: McpEvent): void {
  getDb()
    .then((db) => db.query(
      `INSERT INTO mcp_events (org_id, method, name, client, ok, error, ms, user_id, client_name, client_version, error_class, req_bytes, res_bytes, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [org.orgId, e.method.slice(0, 80), e.name?.slice(0, 200) ?? null, e.client?.slice(0, 120) ?? null, e.ok ?? true,
       e.error?.slice(0, 500) ?? null, e.ms == null ? null : Math.round(e.ms), org.userId ?? null,
       org.client?.name?.slice(0, 80) ?? null, org.client?.version?.slice(0, 40) ?? null,
       e.ok === false ? (e.error_class ?? "error").slice(0, 40) : null,
       e.req_bytes == null ? null : Math.round(e.req_bytes), e.res_bytes == null ? null : Math.round(e.res_bytes), org.keyId ?? null],
    ))
    .catch((err) => console.error("mcp event record failed:", (err as Error).message));
  // A successful tool call may complete a step a host pack tracks (src/host.ts, its journeys): it is told shortly after.
  if (e.method === "tools/call" && e.ok !== false) for (const h of hosts()) { try { h.background?.onToolCall?.(org); } catch (err) { console.error(`host ${h.id} onToolCall:`, (err as Error).message); } }
  const event = e.method === "tools/call" ? "tool_called" : PRODUCT_EVENTS[e.method];
  if (!event) return;
  const actor = { distinctId: org.userId ?? `org:${org.slug}`, orgSlug: org.slug };
  capture(actor, event, { tool: e.method === "tools/call" ? e.name : undefined, uri: e.method === "resources/read" ? e.name : undefined,
    client: e.client ?? undefined, ok: e.ok ?? true, duration_ms: e.ms == null ? undefined : Math.round(e.ms),
    auth: org.userId ? "clerk" : "api_key", error: e.ok === false ? (e.error ?? "").slice(0, 120) : undefined });
  if (e.method === "initialize") {
    identifyOrg(org.slug, { name: org.name });
    if (org.userId) void identifyUser(org);
  }
}

/** JSON-RPC messages in an MCP POST body, minus tools/call (runTool records those with their outcome). */
export function connectorEvents(body: unknown, userAgent: string | undefined): McpEvent[] {
  const msgs = (Array.isArray(body) ? body : [body]) as { method?: unknown; params?: Record<string, unknown> }[];
  return msgs
    .filter((m) => m && typeof m.method === "string" && m.method !== "tools/call" && !m.method.startsWith("notifications/"))
    .map((m) => {
      const p = m.params ?? {};
      const info = p.clientInfo as { name?: string; version?: string } | undefined;
      return {
        method: m.method as string,
        name: typeof p.name === "string" ? p.name : typeof p.uri === "string" ? p.uri : null,
        client: info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : userAgent ?? null,
      };
    });
}

/**
 * The /app pages' equivalent of a tool call (Developer personas, Programming tasks): recorded as method 'page/action'
 * under the tool's name, so a host pack's journey stages complete from a page action exactly as from the MCP tool.
 * Usage and tool adoption keep counting tools/call only. `every` (ms) skips a repeat by the same person within it
 * (opening a page). Awaited, so the next journey load sees it.
 */
export async function recordPageAction(org: Org, name: string, opts: { every?: number } = {}): Promise<void> {
  try {
    const db = await getDb();
    if (opts.every) {
      const [r] = await db.query("SELECT 1 FROM mcp_events WHERE org_id = $1 AND method = 'page/action' AND name = $2 AND user_id IS NOT DISTINCT FROM $3 AND at > now() - make_interval(secs => $4) LIMIT 1",
        [org.orgId, name, org.userId ?? null, opts.every / 1000]);
      if (r) return;
    }
    await db.query("INSERT INTO mcp_events (org_id, method, name, client, ok, user_id) VALUES ($1, 'page/action', $2, 'portal', true, $3)", [org.orgId, name.slice(0, 200), org.userId ?? null]);
    for (const h of hosts()) { try { h.background?.onToolCall?.(org); } catch (err) { console.error(`host ${h.id} onToolCall:`, (err as Error).message); } }
    capture({ distinctId: org.userId ?? `org:${org.slug}`, orgSlug: org.slug }, "portal_action", { tool: name });
  } catch (e) { console.error("page action record failed:", (e as Error).message); }
}
