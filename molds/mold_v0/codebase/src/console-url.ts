/**
 * The two addresses links are built from (mold_v0-084), read from the server's environment only, never from a request
 * (a Host or X-Forwarded-Host header names whatever the sender wants, so a link built from one could point anywhere):
 *
 *   publicUrl()   PUBLIC_URL: where this API answers (MCP clients, webhooks, the install pages)
 *   consoleUrl()  APP_CONSOLE_URL, else PUBLIC_URL: where people open the console (sign-in, /app, /admin). On a
 *                 server of its own one address serves both (the stack's Caddy sends the console's pages to the console),
 *                 and the factory sets it to that address; on Vercel the console is its own project in front of this
 *                 API, and the factory sets it on the API project to the console project's address, so sign-in codes,
 *                 invitations and every other email link to the console, not to the API.
 *
 *   mcpUrl()      APP_MCP_URL, else the console's address when it is its own (frontDoor below), else PUBLIC_URL: where
 *                 AI clients connect (mold_v0-118, 144); the MCP endpoint is its /mcp. On Vercel the console project
 *                 forwards /mcp, /.well-known, /oauth and /install to this API, so the console's address is the one
 *                 front door (the operator's decision of 2026-10-26, mold_v0-144): the app's own domain once it has one
 *                 (domain.py switch, which also sets APP_MCP_URL to it), else the console project's own address. The
 *                 resource the sign-in is for, the install pages, the client skill and every connector address are on
 *                 it. A token issued for PUBLIC_URL/mcp is still accepted (src/clerk.ts mcpAudiences), so connections
 *                 made before keep working. With neither set, or the console on PUBLIC_URL's origin, everything stays
 *                 on PUBLIC_URL.
 *
 *   frontDoor()   the console's address when it is another origin than PUBLIC_URL's (APP_CONSOLE_URL set: on Vercel,
 *                 the console project), else null. The API's root page sends people there (mold_v0-144, src/http.ts):
 *                 the console's own / is its landing page, never forwarded here, so the two never send a request round.
 *
 * Only an http(s) origin, with an optional path, is taken: anything else (another scheme, credentials in the address,
 * a query or a fragment) is ignored, with one line on stderr, for the address it would replace.
 */
import { ENV } from "./env-names.js";
const fallbackPublic = () => `http://127.0.0.1:${process.env.PORT ?? 3333}`;

const warned = new Set<string>();
/** The address in `raw` as `https://host[:port][/path]` with no trailing slash, or null when it is not one. */
export function cleanAddress(raw: string | undefined | null, name = "address"): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || /[\s\\]/.test(v)) throw new Error("not an http(s) address");
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    if (!warned.has(`${name}=${v}`)) { warned.add(`${name}=${v}`); console.error(`${name} is not an http(s) address (ignored): ${v.slice(0, 120)}`); }
    return null;
  }
}

/** Where this API answers: PUBLIC_URL, else this process's own local address. */
export const publicUrl = () => cleanAddress(process.env.PUBLIC_URL, "PUBLIC_URL") ?? fallbackPublic();

/** Where AI clients connect: APP_MCP_URL (a trailing /mcp is dropped), else the console's own address, else PUBLIC_URL. Never from a request. */
export const mcpUrl = () => mcpUrlSetting() ?? publicUrl();
/**
 * The front door AI clients connect to when it is not PUBLIC_URL: APP_MCP_URL as an address, else the console's address
 * when it is another origin (frontDoor, mold_v0-144); null when neither (everything is on PUBLIC_URL).
 */
export const mcpUrlSetting = () => cleanAddress(ENV.APP_MCP_URL, "APP_MCP_URL")?.replace(/\/mcp$/, "") ?? frontDoor();

/** Where people open the console: APP_CONSOLE_URL, else PUBLIC_URL. Every link in an email is built on this. */
export const consoleUrl = () => cleanAddress(ENV.APP_CONSOLE_URL, "APP_CONSOLE_URL") ?? publicUrl();

/**
 * The console's address when people should be sent there from this API's root (mold_v0-144): APP_CONSOLE_URL, when it
 * is set and names another origin than PUBLIC_URL (the console is its own project in front of this API); else null (one
 * address serves both, or no console address is known), and the root answers as before.
 */
export function frontDoor(): string | null {
  const c = cleanAddress(ENV.APP_CONSOLE_URL, "APP_CONSOLE_URL");
  if (!c) return null;
  try { return new URL(c).origin === new URL(publicUrl()).origin ? null : c; } catch { return null; }
}
