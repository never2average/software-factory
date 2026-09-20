import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import { handleMcpRequest, type McpDeps } from "@/lib/mcp-server";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * /api/mcp — this deployment's own MCP server (Streamable HTTP, stateless).
 *
 * All of it is lib/mcp-server.ts; this file only supplies the real
 * dependencies. Authentication is the Ops API's own `verifyOpsAuth` — the same
 * bearer the web app sends — and every tool call goes back through the Ops API
 * as the caller. See docs/MCP.md.
 *
 * proxy.ts does not gate this path (its gate covers /api/ops/*): the handler
 * authenticates every request itself, including `initialize`, and each tool
 * call then crosses the proxy gate on its way to the Ops API.
 */
const deps: McpDeps = {
  productName: PRODUCT_NAME,
  verifyAuth: (authorization) => verifyOpsAuth(authorization),
  // dm.md is traced into the function by next.config.ts (outputFileTracingIncludes).
  readSpec: () => readFile(join(process.cwd(), "dm.md"), "utf8"),
  webOrigin: process.env.WEB_ORIGIN?.trim() || null,
  internalOrigin: process.env.MCP_INTERNAL_ORIGIN?.trim() || null,
};

const handle = (request: NextRequest) => handleMcpRequest(request, deps);

export { handle as GET, handle as POST, handle as DELETE };
