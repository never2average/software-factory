/**
 * Customer account roles: what each person in an account may do on /app and through the connector (/mcp). This file
 * is the only place they are defined; app.ts, limits.ts and server.ts ask can().
 *
 *   viewer   reads Usage, Adoption, reports and context; can't launch runs, onboard or change anything
 *   member   launches within Budget rules, edits their own context and memory, adds use cases (today's member)
 *   billing  "Billing manager": member, plus Billing (plan, cards) and Budget rules; no team management
 *   owner    everything, including the Team (invite, remove, roles) and the company's context and products
 *
 * The role is Clerk's: the organization membership's public_metadata.octillion_role refines Clerk's own role, so
 * org:admin is always owner, and org:member is member unless the metadata says billing or viewer. Setting owner also
 * makes the person org:admin in Clerk (and anything else org:member), so Clerk's admin semantics stay the same.
 */
import type * as clerk from "./clerk.js";

export const ACCOUNT_ROLES = ["viewer", "member", "billing", "owner"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = { viewer: "Viewer", member: "Member", billing: "Billing manager", owner: "Owner" };
export const ACCOUNT_ROLE_HELP: Record<AccountRole, string> = {
  owner: "Everything, including the team: invite people, remove them and change roles.",
  billing: "A member who also manages billing, the plan and Budget rules. Can't manage the team.",
  member: "Runs simulations within Budget rules and keeps their own context and memory.",
  viewer: "Reads usage, adoption, reports and context. Can't run simulations or change anything.",
};

/** Each permission and the least role that has it (roles are ordered viewer < member < billing < owner). */
export const ACCOUNT_PERMISSIONS = {
  read: "viewer",    // Usage, Adoption, reports, transcripts, context
  launch: "member",  // run simulations and onboard products (checkRun)
  edit: "member",    // their own context and memory, use cases, help requests, product saves through the connector
  billing: "billing", // Manage billing, choose a plan, everyone's spend on Billing
  budget: "billing", // Budget rules: the plan, teams, people's limits, history
  manage: "owner",   // the company's context and products, anyone's context and memory, removing anyone's use case
  team: "owner",     // invite, resend, revoke, suspend, restore, change roles
} as const satisfies Record<string, AccountRole>;
export type AccountPermission = keyof typeof ACCOUNT_PERMISSIONS;

const rank = (r: AccountRole) => ACCOUNT_ROLES.indexOf(r);
export const isAccountRole = (r: unknown): r is AccountRole => ACCOUNT_ROLES.includes(r as AccountRole);
export const canAccount = (role: AccountRole | null | undefined, p: AccountPermission) => role != null && rank(role) >= rank(ACCOUNT_PERMISSIONS[p]);
export const accountPermissionsOf = (role: AccountRole | null) => (Object.keys(ACCOUNT_PERMISSIONS) as AccountPermission[]).filter((p) => canAccount(role, p));

/** A role from a request body: one of the four, or the old admin / member. Null when it is neither. */
export const parseAccountRole = (r: unknown): AccountRole | null => (r === "admin" ? "owner" : isAccountRole(r) ? r : null);

/** The role of a Clerk membership (or invitation): Clerk's role, refined by public_metadata.octillion_role. */
export function accountRoleOf(m: { role: string; public_metadata?: Record<string, unknown> | null }): AccountRole {
  if (String(m.role).replace(/^org:/, "") === "admin") return "owner";
  const r = m.public_metadata?.octillion_role;
  return r === "billing" || r === "viewer" ? r : "member";
}
/** What Clerk stores for a role: its organization role and the metadata refinement. */
export const clerkRoleFor = (r: AccountRole) => ({ role: r === "owner" ? ("admin" as const) : ("member" as const), metadata: { octillion_role: r } });

/** A refusal in plain words, with a code the UI and the connector can act on. */
export function accountRefusal(p: AccountPermission): { message: string; code: string; needs: AccountRole } {
  const needs = ACCOUNT_PERMISSIONS[p];
  if (p === "launch") return { message: "Viewers can read reports, usage and transcripts but can't run simulations or onboard products. Ask an account owner to change your role on the Team page.", code: "viewer_role", needs };
  if (p === "edit") return { message: "Viewers can read but can't change context, products, memory or use cases. Ask an account owner to change your role on the Team page.", code: "viewer_role", needs };
  return { message: `This needs the ${ACCOUNT_ROLE_LABELS[needs]} role. Ask an account owner to change your role on the Team page.`, code: "forbidden", needs };
}
