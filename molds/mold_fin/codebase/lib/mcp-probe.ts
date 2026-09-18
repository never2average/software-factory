import "server-only";

/**
 * Ask a bring-your-own connector's endpoint whether it is really there.
 *
 * `connector_create` accepts any https URL without contacting it, so a typo'd
 * host, a decommissioned server, or a URL that points at something which isn't
 * an MCP server at all are indistinguishable from success right up until the
 * agent tries to use it — at which point the failure surfaces mid-task, to the
 * model, as somebody else's error message.
 *
 * DELIBERATELY UNAUTHENTICATED. `decryptSecret` is not reachable from any API
 * route — nothing under `app/api/ops/*` turns stored ciphertext back into a
 * credential — and a diagnostic is not a good enough reason to be the first
 * thing that does. So this proves reachability and protocol, not authorisation.
 * A server that demands a token is reported as `needs-auth`, which is a healthy
 * answer: it means something real is listening and speaking HTTP at that URL.
 * The credentialed check is the agent's own `mcp_tools`, which runs the exact
 * path production uses.
 */
export type ProbeStatus = "ok" | "needs-auth" | "not-mcp" | "unreachable" | "refused";

export interface ProbeResult {
  status: ProbeStatus;
  /** One line an operator can act on. */
  detail: string;
  /** Tool names, when the server answered without auth. */
  tools?: string[];
  httpStatus?: number;
}

/** Public https only — same boundary the agent applies before it dials out. */
export function assertProbeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("The endpoint must be https.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error(`Refusing to call ${host}: that is a private hostname.`);
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (
      a === 10 || a === 127 || a === 0 ||
      (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    ) {
      throw new Error(`Refusing to call ${host}: that is a private address.`);
    }
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) {
      throw new Error(`Refusing to call ${host}: that is a private address.`);
    }
  }
  return url;
}

/** Parse a JSON-RPC reply that may arrive as JSON or as a single SSE frame. */
function parseRpc(text: string): { result?: unknown; error?: { message: string } } | null {
  const payload = text.includes("data:")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop()
    : text;
  try {
    return JSON.parse(payload ?? "");
  } catch {
    return null;
  }
}

export async function probeMcpEndpoint(endpoint: string): Promise<ProbeResult> {
  let url: URL;
  try {
    url = assertProbeUrl(endpoint);
  } catch (e) {
    return { status: "refused", detail: e instanceof Error ? e.message : String(e) };
  }

  const post = (body: unknown, sessionId?: string) =>
    fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

  let res: Response;
  try {
    res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "delivered-probe", version: "1.0.0" },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "unreachable",
      detail: `Could not reach ${url.host}: ${msg.slice(0, 160)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: "needs-auth",
      httpStatus: res.status,
      detail: `${url.host} is reachable and requires authentication (HTTP ${res.status}). Reachability confirmed; the credential itself is not verified from here.`,
    };
  }
  if (!res.ok) {
    return {
      status: "not-mcp",
      httpStatus: res.status,
      detail: `${url.host} answered HTTP ${res.status} to an MCP initialize. That is not an MCP endpoint, or not this path.`,
    };
  }

  const sessionId = res.headers.get("mcp-session-id") ?? undefined;
  const init = parseRpc(await res.text());
  if (!init || (!init.result && !init.error)) {
    return { status: "not-mcp", detail: `${url.host} replied, but not with JSON-RPC. Check the path.` };
  }
  if (init.error) {
    return { status: "not-mcp", detail: `${url.host} rejected initialize: ${init.error.message}` };
  }

  // Handshake done — ask what it can do. A server may still gate this.
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => undefined);
    const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    if (listRes.status === 401 || listRes.status === 403) {
      return {
        status: "needs-auth",
        httpStatus: listRes.status,
        detail: `${url.host} speaks MCP but gates tools/list behind authentication. Reachability and protocol confirmed.`,
      };
    }
    const list = parseRpc(await listRes.text());
    const tools = (list?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    return {
      status: "ok",
      detail: `${url.host} speaks MCP and exposes ${tools.length} tool(s), unauthenticated.`,
      tools: tools.map((t) => t.name),
    };
  } catch (e) {
    return {
      status: "not-mcp",
      detail: `${url.host} completed initialize but failed on tools/list: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`,
    };
  }
}
