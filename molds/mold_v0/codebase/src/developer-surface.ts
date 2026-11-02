/**
 * The developer surface of an embedded app (mold_v0-193; molds/mold_v0/MOLD.md "Developer surface"): whether this
 * build has one, its declaration (src/developer-config.ts), and what the API's modules share (its problems, the kinds
 * and areas it serves, the actor a request acts as).
 *
 *   src/developer-keys.ts       a workspace's API keys: shown once, prefix, scopes, expiry, rotation, integration keys
 *   src/developer-sessions.ts   client sessions for browsers and phones, and the workspace's allowed origins (CORS)
 *   src/developer-webhooks.ts   webhooks out (Standard Webhooks): endpoints, signing secrets, deliveries, retries, log
 *   src/developer-inbound.ts    webhooks in: a verified payload written into a pack-declared record area
 *   src/developer-openapi.ts    the OpenAPI 3.1 document of the build's API (/openapi.json; the SDKs are made from it)
 *   src/developer-api.ts        /v1 and /openapi.json: authentication, CORS, versions, idempotency, problems, limits
 *   src/developer-routes.ts     /api/developer: the console's (an owner's session) keys, origins, endpoints, sources
 *   src/developer-audit.ts      the hook the platform audit trail (mold_v0-197) takes each API request from
 *
 * Off (no pack declares `developer_surface`, every `kind: tool` app): nothing is mounted, no table is read, no event is
 * queued, and the MCP surface is unchanged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LATEST_API_VERSION, type DeveloperSurfaceConfig } from "./developer-config.js";
import { packConfigs } from "./host.js";

/** The build's developer surface (its one pack's declaration, defaults filled in), or null: off. */
export function developerSurface(): DeveloperSurfaceConfig | null {
  const c = packConfigs().find((x) => x.developer_surface)?.developer_surface;
  if (!c) return null;
  return { ...c, client_sessions: { ttl_seconds: 3600, ...c.client_sessions } };
}
export const developerOn = () => developerSurface() !== null;
/** The version a key made now is pinned to. */
export const currentApiVersion = () => developerSurface()?.api_version ?? LATEST_API_VERSION;
/** The pack that declares it (its areas' and kinds' owner for nothing: the API serves every pack's). */
export const developerPack = () => packConfigs().find((x) => x.developer_surface)?.pack ?? null;

/** An API error, answered as application/problem+json (src/developer-api.ts). */
export class ApiProblem extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

/** Who an API request acts as: the credential, and (when the backend asserted one, or a client session's subject) the person. */
export interface ApiActor {
  orgId: number;
  /** "key:<prefix>" or "session:<id>". */
  credential: string;
  /** The person the call is for: X-Actor from a key, a client session's subject; null for the key itself. */
  user: string | null;
}
const actorScope = new AsyncLocalStorage<ApiActor>();
/** Run fn as `actor` (the events it causes carry it). */
export const asApiActor = <T>(actor: ApiActor, fn: () => T): T => actorScope.run(actor, fn);
/** The API actor of the current request, if it came through the API. */
export const currentApiActor = (): ApiActor | null => actorScope.getStore() ?? null;
/** The actor in words for logs and events: "key:sk_ab12cd as user-1". */
export const actorLabel = (a: ApiActor | null) => (a ? `${a.credential}${a.user ? ` as ${a.user}` : ""}` : null);

/** A short opaque id with a prefix (wh_..., msg_...). */
export const opaqueId = async (prefix: string, bytes = 12) => `${prefix}${(await import("node:crypto")).randomBytes(bytes).toString("base64url")}`;
