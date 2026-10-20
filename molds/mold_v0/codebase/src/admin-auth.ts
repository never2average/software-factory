/**
 * Platform admins: Octillion staff who run /admin across every customer, as opposed to an account's own admins (Clerk
 * organization role admin, managing their team on /app). They sign in with Clerk (password, Google, Microsoft, GitHub,
 * whatever the Clerk instance allows); being a platform admin is configured, not stored in the database or the source:
 *
 *   Clerk user public_metadata.platform_role  viewer, support, operator or owner (src/admin-roles.ts), set on /admin/admins
 *   OCTILLION_PLATFORM_ADMINS  comma-separated addresses or *@domain entries, owners; Clerk must have verified the address
 *   (public_metadata.platform_admin = true, the old flag, also means owner)
 *   OCTILLION_ADMIN_TOKEN      still accepted as a bearer token (owner), for scripts and the key vault / population APIs
 *
 * Requests authenticated by Clerk's session cookie that change something must carry `X-Octillion-Admin: 1`, which a
 * cross-site form cannot send, so the cookie cannot be ridden (CSRF). Bearer-token requests need no extra header.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearer } from "./auth.js";
import { clerkEnabled } from "./clerk.js";
import { adminContext, PERMISSIONS, permissionsOf, platformRoleFor, ROLE_LABELS, type PlatformRole } from "./admin-roles.js";
import { clerkSession } from "./session.js";

/** OCTILLION_ADMIN_TOKEN, compared in constant time (also the admin MCP's, src/admin-mcp.ts). */
export function adminTokenOk(t: string | null) {
  const want = process.env.OCTILLION_ADMIN_TOKEN;
  if (!want || !t) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(t), h(want));
}

/**
 * Guards /api/admin/*: the admin token (owner), or a Clerk session of anyone with a platform role (plus the CSRF header
 * on cookie writes). Sets res.locals.adminRole for need() and runs the rest of the request with the role in adminContext.
 */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  const go = (role: PlatformRole) => { res.locals.adminRole = role; adminContext.run({ role }, () => next()); };
  if (adminTokenOk(bearer(req.headers.authorization))) return go("owner");
  const s = await clerkSession(req);
  if (!s) return void res.status(401).json({ error: "Sign in as a platform admin", sign_in_url: "/sign-in" });
  const { email, role } = await platformRoleFor(s.userId).catch(() => ({ email: null, role: null }));
  if (!role) return void res.status(403).json({ error: `${email ?? "This account"} is not a platform admin` });
  if (s.viaCookie && req.method !== "GET" && req.get("x-octillion-admin") !== "1") return void res.status(403).json({ error: "Missing X-Octillion-Admin header" });
  res.locals.adminActor = email ?? s.userId;
  res.locals.adminUserId = s.userId;
  go(role);
}

/** The name admin changes are logged under: the signed-in email, else the X-Admin-Actor label sent with the token. */
export const adminActor = (req: Request, res: Response) =>
  (res.locals.adminActor as string | undefined) ?? (String(req.get("x-admin-actor") ?? "admin").trim().slice(0, 80) || "admin");

export function adminAuthRouter() {
  const r = express.Router();
  // For the admin UI: who is signed in, their role and what it permits (src/admin-roles.ts). Sign-in and sign-out are Clerk's.
  r.get("/admin/session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const s = clerkEnabled() ? await clerkSession(req) : null;
    if (!s) return void res.json({ signed_in: false, email: null, is_platform_admin: false, clerk: clerkEnabled() });
    const { email, role } = await platformRoleFor(s.userId).catch(() => ({ email: null, role: null }));
    res.json({ signed_in: true, user_id: s.userId, email, is_platform_admin: role != null, role, role_label: role ? ROLE_LABELS[role] : null,
               permissions: permissionsOf(role), needs: PERMISSIONS, clerk: true });
  });
  return r;
}
