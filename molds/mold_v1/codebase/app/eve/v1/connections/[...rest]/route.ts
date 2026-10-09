import { refusedCallback } from "@/lib/eve-callback-routes";

export const dynamic = "force-dynamic";

/**
 * eve's connection-callback route (`GET|POST /eve/v1/connections/:name/callback/:token`) is NOT forwarded to the agent.
 * It resumes any eve hook by token with no sign-in; no connection in this app has a sign-in step that would use it
 * (lib/eve-callback-routes.ts). Everything under /eve/v1/connections is refused here, before the `/eve/v1/:path*`
 * fallback rewrite (next.config.ts) can forward it. The agent closes the route itself as well
 * (agent/lib/callback-guard.ts).
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
