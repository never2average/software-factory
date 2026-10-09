import { refusedCallback } from "@/lib/eve-callback-routes";

export const dynamic = "force-dynamic";

/**
 * eve's session-callback route (`POST /eve/v1/callback/:token`) is NOT forwarded to the agent. It resumes any eve hook
 * by token with no sign-in; this app has no caller of it (lib/eve-callback-routes.ts). This handler sits at the path
 * the `/eve/v1/:path*` fallback rewrite (next.config.ts) would otherwise forward, and Next serves a route before a
 * fallback rewrite, so the agent never sees the request from here. The agent closes the route itself as well
 * (agent/lib/callback-guard.ts): this is the early refusal, not the one that counts.
 */
export async function GET(): Promise<Response> {
  return refusedCallback();
}
export async function POST(): Promise<Response> {
  return refusedCallback();
}
export async function PUT(): Promise<Response> {
  return refusedCallback();
}
export async function PATCH(): Promise<Response> {
  return refusedCallback();
}
export async function DELETE(): Promise<Response> {
  return refusedCallback();
}
