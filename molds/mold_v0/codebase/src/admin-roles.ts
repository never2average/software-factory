/**
 * Platform admin roles: what each kind of platform staff may do on /admin. This file is the only place permissions
 * are defined; http.ts puts need("<permission>") on every route that changes something, and GETs need any role.
 *
 *   viewer    reads every admin page (the key vault shows hints only)
 *   support   + access requests, creating accounts, inviting people, journey tips
 *   operator  + compute, harness mix and harnesses, agent configuration, the library, account edits, simulations
 *   owner     + the key vault, test emails, admins and their roles, plans in Stripe, and anything destructive
 *
 * The role lives in Clerk (user public_metadata.platform_role), so there is no table. Owner also covers the old ways
 * in: public_metadata.platform_admin = true and an address APP_PLATFORM_ADMINS lists. Admin tokens (adm_…,
 * src/admin-tokens.ts) carry the role they were minted for. Owners manage everyone else's role on /admin/admins.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response, Router } from "express";
import * as clerk from "./clerk.js";
import { people } from "./people.js";
import { fill } from "./vocabulary.js";

export const PLATFORM_ROLES = ["viewer", "support", "operator", "owner"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const ROLE_LABELS: Record<PlatformRole, string> = { viewer: "Viewer", support: "Support", operator: "Operator", owner: "Owner" };
/** What each platform role may do, the run noun in the build's words (src/vocabulary.ts). */
export function roleHelp(r: PlatformRole): string {
  return {
    viewer: "Reads every admin page. Changes nothing.",
    support: "Viewer, plus access requests, new accounts, invitations and journey tips.",
    operator: fill("Support, plus compute, harnesses, agent configuration, the library, account edits and {runs}."),
    owner: "Everything, including the key vault, admins and deleting things.",
  }[r];
}

/** Each permission and the least role that has it. */
export const PERMISSIONS = {
  read: "viewer",          // every GET
  requests: "support",     // approve, decline, reopen and research access requests; create accounts
  invite: "support",       // invite people to accounts, resend or revoke an invitation
  journeys: "support",     // send and remove journey tips (nudges)
  accounts: "operator",    // rename, link Clerk, plan and billing links, prepaid, allowance, members, API keys
  compute: "operator",     // compute and agent configuration settings, run a tick, cancel a session (the simulation work)
  harnesses: "operator",   // the harness mix (populations) and admin-added harnesses
  library: "operator",     // personas, tasks and customer journeys (playbooks)
  email: "owner",          // send a test email (/admin/emails)
  keys: "owner",           // key vault: add, import, rotate, delete keys, provider switches, the sandbox provider's key
  admins: "owner",         // add and remove admins, change their roles
  plans: "owner",          // create and archive prepaid plans in Stripe (FinOps › Revenue)
  delete: "owner",         // delete harnesses and journeys, revoke or rotate account keys, anything else destructive
} as const satisfies Record<string, PlatformRole>;
export type Permission = keyof typeof PERMISSIONS;

const rank = (r: PlatformRole) => PLATFORM_ROLES.indexOf(r);
export const isRole = (r: unknown): r is PlatformRole => PLATFORM_ROLES.includes(r as PlatformRole);
export const can = (role: PlatformRole | null | undefined, p: Permission) => role != null && rank(role) >= rank(PERMISSIONS[p]);
export const permissionsOf = (role: PlatformRole | null) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
export const refusal = (p: Permission) => {
  const needs = PERMISSIONS[p];
  return { error: `This needs the ${ROLE_LABELS[needs]} role. Ask an Owner on the Admins page.`, code: "forbidden", needs };
};

/** The signed-in admin for the rest of the request (admin.log records their role). */
export const adminContext = new AsyncLocalStorage<{ role: PlatformRole }>();
export const currentAdminRole = () => adminContext.getStore()?.role ?? null;

/** Route guard: 403 unless the admin's role has the permission. requirePlatformAdmin set res.locals.adminRole. */
export function need(p: Permission) {
  return function needPermission(_req: Request, res: Response, next: NextFunction) {
    if (can(res.locals.adminRole as PlatformRole | undefined, p)) return next();
    res.status(403).json(refusal(p));
  };
}

/** At startup: every route on the router that is not a GET must carry need(), so a new write can't slip in unguarded. */
export function assertGuarded(router: Router, where: string) {
  for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } }[] }).stack) {
    const r = layer.route;
    if (!r || Object.keys(r.methods).every((m) => m === "get" || m === "head")) continue;
    if (!r.stack.some((l) => l.name === "needPermission")) throw new Error(`${where}: ${Object.keys(r.methods).join(",").toUpperCase()} ${r.path} has no need(permission)`);
  }
}

/** A Clerk user's role: owner when the environment lists their verified address or the old platform_admin flag is set. */
export function roleOfUser(u: clerk.ClerkUser): { role: PlatformRole | null; source: "environment" | "clerk" | null } {
  const { email, verified } = clerk.primaryEmail(u);
  if (verified && clerk.isPlatformAdminEmail(email)) return { role: "owner", source: "environment" };
  const r = u.public_metadata?.platform_role;
  if (isRole(r)) return { role: r, source: "clerk" };
  if (u.public_metadata?.platform_admin === true) return { role: "owner", source: "clerk" };
  return { role: null, source: null };
}
export async function platformRoleFor(userId: string): Promise<{ email: string | null; role: PlatformRole | null }> {
  const u = await people().users.get(userId);
  return { email: clerk.primaryEmail(u).email, role: roleOfUser(u).role };
}

// ---------- the Admins page (/admin/admins) ----------

export class AdminRoleError extends Error { constructor(message: string, public status = 400) { super(message); } }

export interface AdminRow { id: string | null; email: string | null; name: string | null; role: PlatformRole; role_label: string; source: "environment" | "clerk";
  last_sign_in_at: string | null; added_by: string | null; added_at: string | null; editable: boolean }

/** Everyone with a platform role: Clerk users, plus environment entries nobody has signed in with yet. */
export async function listAdmins(): Promise<AdminRow[]> {
  const out: AdminRow[] = [];
  for (const u of await people().users.list()) {
    const { role, source } = roleOfUser(u);
    if (!role) continue;
    const md = u.public_metadata ?? {};
    out.push({ id: u.id, email: clerk.primaryEmail(u).email, name: clerk.displayName(u), role, role_label: ROLE_LABELS[role], source: source!,
      last_sign_in_at: clerk.iso(u.last_sign_in_at), added_by: typeof md.platform_role_by === "string" ? md.platform_role_by : null,
      added_at: typeof md.platform_role_at === "string" ? md.platform_role_at : null, editable: source === "clerk" });
  }
  const seen = new Set(out.map((a) => a.email));
  for (const e of clerk.platformAdminEntries()) if (!seen.has(e))
    out.push({ id: null, email: e, name: null, role: "owner", role_label: ROLE_LABELS.owner, source: "environment", last_sign_in_at: null, added_by: null, added_at: null, editable: false });
  const order = (a: AdminRow) => -rank(a.role);
  return out.sort((a, b) => order(a) - order(b) || String(a.email).localeCompare(String(b.email)));
}

const ownersLeft = (all: AdminRow[], without: string) => all.filter((a) => a.role === "owner" && a.id !== without).length;

/** Who is changing roles, for the guards and the record (an email, or the token's actor label). */
export interface Changer { actor: string; userId: string | null }

async function editable(id: string) {
  const all = await listAdmins();
  const row = all.find((a) => a.id === id);
  const u = row ? null : await people().users.get(id, true).catch(() => null);
  if (!row && !u) throw new AdminRoleError("No such person in Clerk", 404);
  if (row?.source === "environment") throw new AdminRoleError("This admin is set in the server environment (APP_PLATFORM_ADMINS). Change it there.", 409);
  return { all, row };
}

const stamp = (by: Changer, role: PlatformRole | null) =>
  role ? { platform_role: role, platform_admin: null, platform_role_by: by.actor, platform_role_at: new Date().toISOString() }
       : { platform_role: null, platform_admin: null, platform_role_by: null, platform_role_at: null };

/** Change an admin's role (or give one to a Clerk user). The last owner can't be demoted. */
export async function setAdminRole(by: Changer, id: string, roleIn: unknown) {
  if (!isRole(roleIn)) throw new AdminRoleError(`role must be one of ${PLATFORM_ROLES.join(", ")}`);
  const { all, row } = await editable(id);
  if (row?.role === "owner" && roleIn !== "owner" && !ownersLeft(all, id))
    throw new AdminRoleError(id === by.userId ? "You are the last owner. Make someone else an owner first." : "This is the last owner. Make someone else an owner first.", 409);
  await people().users.setMetadata(id, stamp(by, roleIn));
  return (await listAdmins()).find((a) => a.id === id)!;
}

/** Remove an admin: their platform role is cleared (their Clerk account stays). */
export async function removeAdmin(by: Changer, id: string) {
  const { all, row } = await editable(id);
  if (!row) throw new AdminRoleError("Not an admin", 404);
  if (row.role === "owner" && !ownersLeft(all, id))
    throw new AdminRoleError(id === by.userId ? "You are the last owner. Make someone else an owner first." : "This is the last owner. Make someone else an owner first.", 409);
  await people().users.setMetadata(id, stamp(by, null));
}

/** Add an admin by email: an existing Clerk user gets the role; otherwise Clerk creates the user, who becomes an admin on first sign-in. */
export async function addAdmin(by: Changer, emailIn: unknown, roleIn: unknown) {
  const email = String(emailIn ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminRoleError("Enter a valid email address");
  if (!isRole(roleIn)) throw new AdminRoleError(`role must be one of ${PLATFORM_ROLES.join(", ")}`);
  const u = await people().users.byEmail(email);
  if (u) return { created: false, admin: await setAdminRole(by, u.id, roleIn) };
  const made = await people().users.create(email, Object.fromEntries(Object.entries(stamp(by, roleIn)).filter(([, v]) => v != null)));
  return { created: true, admin: (await listAdmins()).find((a) => a.id === made.id) ?? null };
}
