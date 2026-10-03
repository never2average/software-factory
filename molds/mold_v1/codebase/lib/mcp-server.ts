/**
 * The hosted MCP endpoint — the app serving its OWN tools at `/api/mcp`.
 *
 * Every deployment stamped from this codebase gets one for free, at its own
 * address, with nothing to configure: the endpoint IS the deployment, so there
 * is no "which app does the package point at" question left to get wrong.
 *
 * TRANSPORT. MCP Streamable HTTP, stateless, JSON responses. Each POST carries
 * one JSON-RPC message (or a small batch), is authenticated on its own, and is
 * answered in the response body. There is no session id and no server-to-client
 * stream, because nothing here needs one and a serverless function cannot
 * promise the next request lands on the same instance. Hand-rolled rather than
 * built on @modelcontextprotocol/sdk: the surface is four methods that the
 * stdio package already implements without the SDK (now shared, in
 * setup/workspace-tools.mjs), while the SDK brings ~90 transitive packages (express,
 * hono, cors, ajv, ...) into the app for it. The SDK's own client is used to
 * test interoperability instead (docs/MCP.md).
 *
 * AUTHORISATION IS NOT REIMPLEMENTED HERE. A tool call becomes an ordinary
 * request to this same deployment's Ops API, carrying the caller's own
 * Authorization header and workspace header, so it passes through proxy.ts and
 * each route's membership checks exactly as a click in the web app does. This
 * file decides who may TALK to the endpoint; the Ops API decides what they may
 * DO. The extra hop costs one same-origin request per Ops call; calling forty
 * route handlers in-process would have skipped the proxy gate and coupled this
 * file to every route's signature.
 *
 * Relative imports only, and every outside dependency injected: the test drives
 * this exact function in plain node with a mocked Ops API.
 */
import { availableTools, createTools, handleRpc, PROTOCOL_VERSIONS, serverInstructions } from "../setup/workspace-tools.mjs";
import { parseClaudeTranscript, sessionToSyncItem } from "../agent/lib/coding-sessions.ts";
import { productSlug } from "./mcp-connect.ts";

/** Vercel rejects bodies over 4.5 MB before we see them; stay under it and say so ourselves. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** JSON-RPC batching left the spec in 2025-06-18; older clients may still send a few. */
export const MAX_BATCH = 10;
/** A tool result is text an agent must read. Past this it is truncated with a note saying how to narrow. */
export const MAX_RESULT_CHARS = 400_000;
const OPS_TIMEOUT_MS = 55_000;

export interface McpIdentity {
  email: string;
  hostedDomain?: string;
}

export interface McpDeps {
  productName: string;
  /** Verify an Authorization header. The route passes verifyOpsAuth — the Ops API's own check. */
  verifyAuth: (authorization: string | null) => Promise<McpIdentity | null>;
  /** Text of dm.md, for dataroom_structure. */
  readSpec: () => Promise<string>;
  /** The name this deployment stores each data-room folder under, by id (agent/lib/dataroom-folders.ts FOLDER). */
  folders: Record<string, string>;
  /** The profile's custom_fields per record (the two areas, the account), so the write tools can name them. Absent = described generically. */
  customFields?: { deployments: unknown[]; implementations: unknown[]; account?: unknown[] };
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra addresses this deployment answers on (WEB_ORIGIN), for the Origin check and links. */
  webOrigin?: string | null;
  /** Operator override for where the Ops API is reached from inside (e.g. http://127.0.0.1:3000 behind a proxy). */
  internalOrigin?: string | null;
  version?: string;
}

const originOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  // A JSON-RPC shaped body even for transport-level refusals, so a client that
  // parses every response as JSON-RPC reports the reason instead of a parse error.
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

/** Read at most `limit` bytes. Content-Length is a hint a caller can lie about, so count what arrives. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const requestOrigin = new URL(request.url).origin;
  const webOrigin = originOf(deps.webOrigin);

  /**
   * ORIGIN. MCP clients are programs, not web pages, and send no Origin header.
   * A browser always does on a cross-site POST — so an Origin that is not this
   * deployment's own means some web page is trying to drive the endpoint (the
   * DNS-rebinding case the MCP spec warns about). Refuse it, and never emit
   * Access-Control-Allow-Origin: no other site has any business here.
   */
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== requestOrigin && origin !== webOrigin) {
    return rpcError(403, -32000, "Cross-origin requests are not accepted by this endpoint.");
  }

  if (request.method !== "POST") {
    // No server-initiated stream and no sessions to delete: 405 is what the
    // Streamable HTTP spec asks for, and clients treat it as "POST only".
    return rpcError(405, -32000, "This endpoint answers POST only (MCP Streamable HTTP, stateless).", { allow: "POST" });
  }

  const authorization = request.headers.get("authorization");
  const identity = await deps.verifyAuth(authorization);
  if (!identity) {
    return rpcError(
      401,
      -32001,
      `Sign in first. Send "Authorization: Bearer <token>" — get a token with POST ${requestOrigin}/api/auth/email/request then /api/auth/email/verify (see docs/MCP.md).`,
      { "www-authenticate": `Bearer realm="${productSlug(deps.productName)}", error="invalid_token"` },
    );
  }

  const version = request.headers.get("mcp-protocol-version");
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return rpcError(400, -32600, `Unsupported MCP-Protocol-Version "${version}". Supported: ${PROTOCOL_VERSIONS.join(", ")}.`);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return rpcError(415, -32600, "Content-Type must be application/json.");
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return rpcError(413, -32600, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Parse error: the body is not JSON.");
  }
  const batch = Array.isArray(payload);
  const messages: unknown[] = batch ? (payload as unknown[]) : [payload];
  if (messages.length === 0) return rpcError(400, -32600, "Empty batch.");
  if (messages.length > MAX_BATCH) return rpcError(400, -32600, `Batch of ${messages.length} exceeds the limit of ${MAX_BATCH}.`);

  /**
   * WHERE the Ops API is. This deployment — never a configured "other" address.
   * On Vercel the platform routes by Host, so the request's own origin is the
   * deployment. Self-hosted, a caller can put anything in Host, so prefer what
   * the operator configured; the request origin is the last resort.
   */
  const selfOrigin =
    originOf(deps.internalOrigin) ?? (process.env.VERCEL ? requestOrigin : (webOrigin ?? requestOrigin));
  const doFetch = deps.fetchImpl ?? fetch;
  // The workspace, exactly as the web app sends it. Absent -> the Ops API uses
  // the identity's retained active workspace. Membership is checked there.
  let selectedOrg = request.headers.get("x-ops-org")?.trim() || null;

  async function api(method: string, path: string, body?: unknown) {
    if (!path.startsWith("/api/ops/")) throw new Error(`refused: ${path} is not an Ops API path`);
    const res = await doFetch(new URL(path, selfOrigin), {
      method,
      headers: {
        "content-type": "application/json",
        authorization: authorization as string,
        ...(selectedOrg ? { "x-ops-org": selectedOrg } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: { error?: string } & Record<string, unknown>;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 2000) };
    }
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status} from ${path}`);
    return parsed;
  }

  const publicOrigin = webOrigin ?? requestOrigin;
  const signInHint = `The token was refused. Get a fresh one from ${publicOrigin}/api/auth/email/request then /verify, and update the Authorization header in your MCP config.`;
  const ctx = {
    api,
    getOrg: () => selectedOrg,
    setOrg: (orgId: string) => {
      selectedOrg = orgId;
    },
    orgSelectedVia: "the x-ops-org header on this connection",
    identity: async () => ({ email: identity.email, domain: identity.hostedDomain ?? null }),
    signInHint,
    // The Ops API records the verified identity itself; this is only the label on rows that carry one.
    actor: identity.email,
    opsUrl: publicOrigin,
    webOrigin: publicOrigin,
    readSpec: deps.readSpec,
    folders: deps.folders,
    customFields: deps.customFields,
    // No direct blob access: the data room is reached through the Ops API, as the caller, org-scoped and audited.
    blobStore: () => null,
    parseClaudeTranscript,
    sessionToSyncItem,
  };
  const rpc = {
    tools: availableTools(createTools(ctx), ctx),
    serverInfo: {
      name: productSlug(deps.productName),
      title: deps.productName,
      version: deps.version ?? "1.0.0",
    },
    instructions: serverInstructions({ productName: deps.productName, opsUrl: publicOrigin, signInHint }),
    maxResultChars: MAX_RESULT_CHARS,
  };

  // In order, not in parallel: workspace_use followed by a write in one batch must see the switch.
  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await handleRpc(message, rpc);
    if (response) responses.push(response);
  }
  const headers = { "cache-control": "no-store" };
  if (responses.length === 0) return new Response(null, { status: 202, headers });
  return Response.json(batch ? responses : responses[0], { headers });
}
