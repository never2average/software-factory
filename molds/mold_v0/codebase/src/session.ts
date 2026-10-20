/**
 * Who is signed in, for the browser surfaces (/api/app for the customer portal, /api/admin for platform admins):
 * a Clerk session, from `Authorization: Bearer <session token>` (the UI's getToken()) or from Clerk's session cookie
 * on the same origin (`__session`, or `__session_<suffix>` when Clerk suffixes cookies). Nothing is stored here.
 */
import type { Request } from "express";
import { verifySessionToken, type SessionClaims } from "./clerk.js";

export const cookies = (req: Request): Record<string, string> => Object.fromEntries((req.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((c) => {
  const i = c.indexOf("=");
  return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
}));

/** The Clerk session on a request, and whether it came from a cookie (cookie-authenticated writes need a CSRF header). */
export async function clerkSession(req: Request): Promise<(SessionClaims & { viaCookie: boolean }) | null> {
  const m = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (m && m[1].split(".").length === 3) {
    const s = await verifySessionToken(m[1]);
    if (s) return { ...s, viaCookie: false };
  }
  const jar = cookies(req);
  for (const [name, value] of Object.entries(jar)) {
    if (name !== "__session" && !name.startsWith("__session_")) continue;
    const s = await verifySessionToken(value);
    if (s) return { ...s, viaCookie: true };
  }
  return null;
}
