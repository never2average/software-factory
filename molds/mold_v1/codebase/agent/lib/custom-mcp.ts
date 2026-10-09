/**
 * BRING-YOUR-OWN connectors — talking to an MCP server this codebase has never
 * heard of.
 *
 * The built-in connectors (Slack, GitHub) are eve connections: a file under
 * `agent/connections/`, a hardcoded URL, credentials read from `process.env` at
 * import time. That is the right shape for integrations WE ship, and completely
 * wrong for one a workspace brings itself — it would mean a code change, a
 * review and a redeploy before a customer's own MCP server could be reached.
 *
 * So this is the dynamic path. A connector row of a kind we don't ship carries
 * its own endpoint (`endpoint_url`), its own credential contract
 * (`required_secrets`) and the name of the secret that authenticates it
 * (`auth_secret_name`). At CALL time we read the row, decrypt its secrets with
 * the workspace-derived key, and speak MCP over HTTP directly. Nothing is
 * cached in the process and no plaintext credential is ever returned to the
 * model — `mcp_call` returns the MCP server's result, never the token used to
 * get it.
 *
 * Scope: this reaches an arbitrary operator-supplied URL from inside our
 * infrastructure, which is an SSRF surface by construction. `assertPublicUrl`
 * is the boundary — https only, no private/loopback/link-local address space —
 * and it is applied to every request, including redirects (we follow none).
 */
import { and, eq } from "drizzle-orm";
import { acrossOrgDbs, getDb, withOrgDb } from "./db/index.ts";
import { connectorSecrets, connectors } from "./db/schema.ts";
import { decryptSecret, hasSecretsKey } from "./secret-crypto.ts";
import { recordAudit } from "./automation-audit.ts";

/** Kinds wired in code — these never take the dynamic path. */
const BUILT_IN_KINDS = new Set([
  "slack",
  "github",
  "gmail",
  "granola",
  "exa",
  "pagerduty",
  "system_of_record",
]);

export interface CustomConnector {
  id: string;
  /**
   * Never null. The workspace id is the HKDF salt for this connector's
   * credentials, so a connector without one has no key to decrypt with — such a
   * row is dropped in listCustomConnectors rather than silently falling back to
   * a shared master key, which is what the old code did.
   */
  orgId: string;
  /**
   * Set for a PERSONAL connector, and part of its credential's HKDF salt — so
   * this must travel with the row, or the decrypt derives the wrong key.
   */
  ownerEmail: string | null;
  name: string;
  kind: string;
  endpointUrl: string;
  authSecretName: string | null;
  detail: string | null;
  enabled: boolean;
}

/**
 * Reject anything that isn't a public https endpoint.
 *
 * An operator can type any URL into a connector, and this process can reach
 * cloud metadata endpoints and internal services that a browser never could.
 * A literal-IP check is not complete protection (a hostname can resolve to a
 * private address after we check it), but it removes the whole class of
 * copy-pasted `http://localhost` / `http://169.254.169.254` mistakes, which is
 * what actually happens in practice.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error("A connector endpoint must be https — credentials are sent to it.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Refusing to call ${host}: that is a private hostname.`);
  }
  // IPv4 literals in private / loopback / link-local / CGNAT space.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    const priv =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    if (priv) throw new Error(`Refusing to call ${host}: that is a private address.`);
  }
  // IPv6 loopback / unique-local / link-local.
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) {
      throw new Error(`Refusing to call ${host}: that is a private address.`);
    }
  }
  return url;
}

/**
 * Every bring-your-own connector VISIBLE to this caller — the workspace's
 * shared ones, plus their own personal ones.
 *
 * The principal matters as much as the workspace. Without it the policy shows
 * shared connectors only, so a personal connector would be invisible to the
 * agent in its own owner's chat, which defeats the point of having one.
 *
 * Omitting it is still the right answer for automation: a cron or workflow has
 * no human caller, so it passes nothing here and sees only shared connectors.
 * The rule falls out of the shape rather than needing a check.
 */
export async function listCustomConnectors(
  orgId?: string | null,
  principal?: string | null,
): Promise<CustomConnector[]> {
  const db = getDb();
  if (!db) return [];
  // Filter in SQL, not after the fact: pulling every workspace's rows into this
  // process and narrowing them in JS makes the isolation one forgotten
  // `.filter()` deep, and puts other tenants' connector names in memory here
  // for no reason.
  const rows = orgId
    ? await withOrgDb({ orgId, principal }, (tx) =>
        tx.select().from(connectors).where(eq(connectors.orgId, orgId)),
      )
    // No workspace named: the existing contract is "every connector", so sweep
    // rather than run one unscoped query that returns nothing fail-closed.
    : await acrossOrgDbs((tx) => tx.select().from(connectors));
  return rows
    .filter((r) => !BUILT_IN_KINDS.has(r.kind.toLowerCase()) && r.endpointUrl && r.orgId)
    .map((r) => ({
      id: r.id,
      orgId: r.orgId as string,
      ownerEmail: r.ownerEmail ?? null,
      name: r.name,
      kind: r.kind,
      endpointUrl: r.endpointUrl as string,
      authSecretName: r.authSecretName,
      detail: r.detail,
      enabled: r.enabled,
    }));
}

/** Resolve by id or (case-insensitive) name — the model will use the name. */
export async function findCustomConnector(
  ref: string,
  orgId?: string | null,
  principal?: string | null,
): Promise<CustomConnector> {
  const all = await listCustomConnectors(orgId, principal);
  const hit =
    all.find((c) => c.id === ref) ?? all.find((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (!hit) {
    const names = all.map((c) => c.name).join(", ") || "none configured";
    throw new Error(`No custom connector "${ref}". Available: ${names}.`);
  }
  if (!hit.enabled) throw new Error(`Connector "${hit.name}" is disabled.`);
  return hit;
}

/**
 * The bearer token for a connector, decrypted with its WORKSPACE-derived key
 * (HKDF salted with the row's orgId — the same salt the Ops Center sealed it
 * with). Returns null when the connector needs no auth.
 */
async function bearerToken(c: CustomConnector): Promise<string | null> {
  // Hoisted so the narrowing survives into the transaction closure below.
  const secretName = c.authSecretName;
  if (!secretName) return null;
  const db = getDb();
  if (!db) throw new Error("No database — cannot read connector credentials.");
  if (!hasSecretsKey()) {
    throw new Error("OPS_SECRETS_KEY is not set on the agent — stored credentials cannot be decrypted.");
  }
  // Scope the credential read to the connector's OWN workspace as well as its
  // id. Ids are unique so this is belt-and-braces, but this is the one query in
  // the agent that turns stored bytes into a live credential — it should not be
  // the query that trusts a single column.
  // Inside withOrgDb: connector_secrets enforces STRICT row-level security, so
  // this query returns nothing at all unless the workspace GUC is set. The
  // explicit org predicate stays anyway — the database check and the
  // application check should agree, not substitute for each other.
  const [row] = await withOrgDb({ orgId: c.orgId, principal: c.ownerEmail }, (tx) =>
    tx
      .select()
      .from(connectorSecrets)
      .where(
        and(
          eq(connectorSecrets.connectorId, c.id),
          eq(connectorSecrets.name, secretName),
          eq(connectorSecrets.orgId, c.orgId),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new Error(
      `Connector "${c.name}" needs ${secretName}, which has not been stored. ` +
        "An operator sets it in the Ops Center or with connector_secret_set.",
    );
  }
  const token = decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyVersion: row.keyVersion },
    c.orgId,
    c.ownerEmail,
  );

  // A READ LOG for credentials. Storing one was already audited; using one was
  // not, so a leaked token left no trace of ever having been taken out of the
  // database. Records the name and the connector, never the value. Best-effort
  // on purpose: an audit failure must not be a way to block a connector, and it
  // must not turn a working credential into an outage.
  await recordAudit({
    automationType: "connector",
    automationId: c.id,
    actor: "agent",
    orgId: c.orgId,
    event: `Credential ${secretName} decrypted for ${c.name} (key v${row.keyVersion})`,
  }).catch(() => undefined);

  return token;
}

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * One JSON-RPC round trip against a streamable-HTTP MCP server.
 *
 * The transport permits either a JSON body or an SSE stream in reply to the
 * same POST, so both are handled: a server that answers `text/event-stream`
 * with a single `data:` frame is spec-compliant and common, and reading it as
 * JSON would fail with a confusing parse error.
 */
async function rpc(
  url: URL,
  token: string | null,
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<{ body: RpcResult; sessionId: string | null }> {
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual", // a redirect could aim our credential at another host
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId ?? null;
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${url.host} redirected the MCP call (${res.status}); refusing to follow it.`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url.host} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return { body: {}, sessionId: nextSession };
  // SSE framing: take the last `data:` payload.
  const payload = text.includes("data:")
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .pop()
    : text;
  try {
    return { body: JSON.parse(payload ?? "{}") as RpcResult, sessionId: nextSession };
  } catch {
    throw new Error(`${url.host} returned a non-JSON MCP response: ${text.slice(0, 200)}`);
  }
}

/** Handshake, then run `fn` with a live session. */
async function withSession<T>(
  c: CustomConnector,
  fn: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const url = assertPublicUrl(c.endpointUrl);
  const token = await bearerToken(c);

  const init = await rpc(url, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "delivered-agent", version: "1.0.0" },
  });
  if (init.body.error) {
    throw new Error(`${c.name} rejected initialize: ${init.body.error.message}`);
  }
  const sessionId = init.sessionId ?? undefined;

  // The spec requires this notification before any other request; servers that
  // don't need it ignore it, so failing on it would be stricter than the spec.
  await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);

  return await fn(async (method, params) => {
    const { body } = await rpc(url, token, method, params, sessionId);
    if (body.error) throw new Error(`${c.name} → ${method}: ${body.error.message}`);
    return body.result;
  });
}

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** What this connector's server can do, asked of the server itself. */
export async function listRemoteTools(c: CustomConnector): Promise<RemoteTool[]> {
  return await withSession(c, async (call) => {
    const result = (await call("tools/list", {})) as { tools?: RemoteTool[] } | undefined;
    return result?.tools ?? [];
  });
}

/** Invoke one remote tool and return its content. */
export async function callRemoteTool(
  c: CustomConnector,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return await withSession(c, (call) => call("tools/call", { name, arguments: args }));
}
