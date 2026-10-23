/**
 * The sign-in adapter (mold_v0-004): one interface, two implementations, chosen by src/auth-provider.ts.
 *
 *   clerk    src/clerk.ts, exactly as before: Clerk keeps people, organizations, memberships, invitations and sessions;
 *            Clerk is also the OAuth server for /mcp and the admin MCP
 *   builtin  src/builtin-auth.ts: an emailed code and Google, people and sessions in this server's Postgres, invitations
 *            emailed by src/email.ts. This server is the OAuth server for /mcp (src/mcp-oauth.ts, mold_v0-013):
 *            connectors sign in; other MCP clients may use keys in a header (a member's own key, src/member-keys.ts,
 *            or the workspace's key)
 *
 * Both speak Clerk's shapes (ClerkUser, ClerkMembership, ClerkInvitation, ClerkOrg), so the code that reads a person's
 * workspaces and role (src/app.ts customerSession, src/auth.ts memberRole), manages a team (src/admin.ts), finds platform
 * admins (src/admin-roles.ts) and emails a workspace's people (src/email.ts) is the same for both. organizations.clerk_org_id
 * is the directory's id for a workspace under either provider.
 */
import type { Request } from "express";
import { authProvider, type AuthProviderName } from "./auth-provider.js";
import * as builtin from "./builtin-auth.js";
import * as clerk from "./clerk.js";
import { clerkSession } from "./session.js";

export interface PeopleDirectory {
  provider: AuthProviderName;
  /** Whether people can be signed in and managed at all (Clerk: its key is set; builtin: always). */
  enabled(): boolean;
  organizations: typeof clerk.organizations;
  invitations: typeof clerk.invitations;
  memberships: typeof clerk.memberships;
  users: Omit<typeof clerk.users, "byEmail"> & { byEmail(email: string): Promise<clerk.ClerkUser | null> };
  onMembershipChange(fn: (userId: string) => void): void;
}

const CLERK: PeopleDirectory = {
  provider: "clerk", enabled: clerk.clerkEnabled,
  organizations: clerk.organizations, invitations: clerk.invitations, memberships: clerk.memberships, users: clerk.users,
  onMembershipChange: clerk.onMembershipChange,
};
const BUILTIN: PeopleDirectory = {
  provider: "builtin", enabled: () => true,
  organizations: builtin.organizations, invitations: builtin.invitations, memberships: builtin.memberships, users: builtin.users,
  onMembershipChange: builtin.onMembershipChange,
};

/** The directory of the server's sign-in, read per call (the provider is the environment's). */
export const people = (): PeopleDirectory => (authProvider() === "clerk" ? CLERK : BUILTIN);

/** Listeners on both, so a cache keyed by person is cleared whichever provider changed a membership. */
export const onAnyMembershipChange = (fn: (userId: string) => void) => { clerk.onMembershipChange(fn); builtin.onMembershipChange(fn); };

/**
 * Who is signed in on a browser request, under the server's provider: a Clerk session (Bearer session token or the
 * __session cookie, src/session.ts) or a built-in session cookie. `viaCookie`: cookie-authenticated writes need a CSRF
 * header where the route asks for one. Null when nobody is (or the provider is not configured).
 */
export async function signedIn(req: Request): Promise<(clerk.SessionClaims & { viaCookie: boolean }) | null> {
  if (authProvider() === "clerk") return clerkSession(req);
  return builtin.sessionFromRequest(req);
}
