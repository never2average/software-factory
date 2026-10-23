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

/** Where people open the console: APP_CONSOLE_URL, else PUBLIC_URL. Every link in an email is built on this. */
export const consoleUrl = () => cleanAddress(ENV.APP_CONSOLE_URL, "APP_CONSOLE_URL") ?? publicUrl();
