import type { NextConfig } from "next";
import { agentBaseUrl } from "./lib/agent-url.ts";

// This app is the web front-end only. The eve agent runs as a separate Vercel
// project (fde-agent-api), so we proxy the eve API routes to it server-side.
// The browser talks same-origin to this app (no CORS), and the Authorization
// header (the signed-in user's Google ID token) is forwarded to the agent.
//
// Resolved through agentBaseUrl() rather than a bare `??`, because this is a
// BUILD-TIME read: a Sensitive env var arrives from `vercel pull` as the
// literal "[SENSITIVE]", which `??` accepts as a real value and which then
// fails rewrite validation with an error naming the route, not the cause.
const EVE_API = agentBaseUrl();

const nextConfig: NextConfig = {
  // /api/mcp serves dm.md (the data-room contract) through its dataroom_structure tool.
  outputFileTracingIncludes: { "/api/mcp": ["./dm.md"] },
  async rewrites() {
    /**
     * `fallback`, NOT a bare array.
     *
     * A bare array means `afterFiles`, which Next applies BEFORE dynamic routes.
     * That silently beat the ownership gate at
     * `app/eve/v1/session/[...segments]/route.ts`: the handler existed, built,
     * and was never reached, so every request went straight to the agent
     * unchecked. It looked exactly like a working fix.
     *
     * `fallback` runs only when nothing else matched, so the gate handles the
     * per-session paths and every other /eve/v1/* path still proxies untouched.
     */
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        { source: "/eve/v1/:path*", destination: `${EVE_API}/eve/v1/:path*` },
        {
          source: "/.well-known/workflow/:path*",
          destination: `${EVE_API}/.well-known/workflow/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
