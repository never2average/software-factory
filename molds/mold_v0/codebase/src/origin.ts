/**
 * Origin validation for the MCP endpoints (/mcp, /mcp/<key>, /admin/mcp, /api/admin/mcp), per the MCP transport spec's
 * DNS-rebinding guidance: "Servers MUST validate the Origin header on all incoming connections ... If the Origin header
 * is present and invalid, servers MUST respond with HTTP 403 Forbidden."
 *
 * A web page an attacker controls can make a browser send requests to a name that resolves to this server (DNS
 * rebinding, or a server bound on a developer's machine). The browser always sends the page's Origin with such a
 * request, so a request whose Origin is not one of ours is refused before anything else looks at it. MCP clients that
 * are not browsers (Claude's and ChatGPT's connectors, Claude Code, Cursor, the SDKs) send no Origin and are unaffected.
 *
 * Allowed: PUBLIC_URL's origin, the origins of the URIs in CLERK_MCP_AUDIENCE, and APP_MCP_ALLOWED_ORIGINS
 * (comma-separated origins, e.g. a browser-based MCP client you trust: http://localhost:6274 for the MCP Inspector).
 * The opaque origin "null" (sandboxed iframes, file: pages) is never allowed. Allowing an origin only passes this check:
 * the endpoints send no CORS headers, so a cross-origin browser client still needs a proxy (the MCP Inspector's own).
 *
 * Host: a server bound to loopback with no PUBLIC_URL (a developer's machine, the classic DNS-rebinding target) also
 * refuses a Host header that is not localhost, 127.0.0.1 or [::1], which covers requests that carry no Origin.
 */
import type { NextFunction, Request, Response } from "express";
import { ENV } from "./env-names.js";

const originOf = (u: string): string | null => {
  try {
    const x = new URL(u.trim());
    return x.protocol === "http:" || x.protocol === "https:" ? x.origin.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The server's own address, with the same fallback as src/http.ts. */
const publicUrl = () => process.env.PUBLIC_URL ?? `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3333}`;

export function allowedMcpOrigins(): Set<string> {
  const list = [
    publicUrl(),
    ...(process.env.CLERK_MCP_AUDIENCE ?? "").split(","),
    ...(ENV.APP_MCP_ALLOWED_ORIGINS ?? "").split(","),
  ];
  return new Set(list.map((x) => (x.trim() ? originOf(x) : null)).filter((x): x is string => Boolean(x)));
}

/** True when the request has no Origin (not a browser) or one of ours. */
export function mcpOriginOk(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const o = originOf(origin);
  return o !== null && allowedMcpOrigins().has(o);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** True unless the server listens on loopback without a PUBLIC_URL and the Host names something else. */
export function mcpHostOk(host: string | undefined): boolean {
  // Vercel never binds to HOST (its proxy is the listener); a VM container binds 0.0.0.0 behind Caddy.
  if (process.env.PUBLIC_URL || process.env.VERCEL || !LOOPBACK.has(process.env.HOST ?? "127.0.0.1")) return true;
  if (!host) return false;
  try { return LOOPBACK.has(new URL(`http://${host}`).hostname.toLowerCase()); } catch { return false; }
}

/** One log line per refused origin per minute: a hostile page cannot flood the log. */
const lastLogged = new Map<string, number>();
const clean = (v: unknown) => JSON.stringify(String(v).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120));

/** Express middleware: 403 (JSON-RPC error body) for a foreign Origin or Host, before auth or the MCP transport run. */
export function mcpOriginGuard(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const originOk = mcpOriginOk(origin), hostOk = mcpHostOk(req.headers.host);
  if (originOk && hostOk) return next();
  // The origin is the caller's page, not a secret; clipped and stripped of control characters for the log line.
  const what = originOk ? `host=${clean(req.headers.host)}` : `origin=${clean(origin)}`;
  const now = Date.now();
  if (now - (lastLogged.get(what) ?? 0) >= 60_000) {
    if (lastLogged.size > 1000) lastLogged.clear();
    lastLogged.set(what, now);
    console.error(`mcp origin refused ${req.method} ${req.baseUrl} ${what}`);
  }
  res.status(403).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Forbidden: this ${originOk ? "Host" : "Origin"} may not use the MCP endpoint` } });
}
