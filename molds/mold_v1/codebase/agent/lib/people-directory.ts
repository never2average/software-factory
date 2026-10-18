/**
 * THE WORKFLOW ENGINE'S DIRECTORY, BUILT FROM A WORKSPACE'S OWN PEOPLE (docs/WORKFLOW_ENGINE.md, phase 4).
 *
 * The engine resolves a step's holder by querying a directory ({ department, role, <attribute> }), walks the
 * reporting matrix for relative assignment ("one level up" to escalate, "one level down" to delegate), and checks role
 * scopes for who may reassign a step (supervisors only). It takes all three as one identity snapshot per
 * organisation: users, role boundaries, reporting rows (the engine's integrations/identity.ts IdentitySnapshot,
 * validated by its validateIdentitySnapshot).
 *
 * identitySnapshot() builds that snapshot from ONE workspace's people: its roster rows (people_roster: name, the
 * departments, the attributes and the reporting line its owner set; agent/lib/people-data.ts) and its signed-in people
 * with their workspace role (org_members). Pure: the caller reads both under the workspace's row-level security and
 * passes them in, and a row of another workspace is dropped, never carried. Nothing calls it at runtime yet; phase 5
 * (wiring the engine into record moves) does.
 *
 * The types below copy the SHAPE of the engine's (core/evaluator.ts DirectoryUser, core/rbac.ts RoleBoundary and
 * ReportingRow, integrations/identity.ts IdentitySnapshot), not the engine itself, so this module stands on its own
 * until the engine library is in the tree; scripts/test-people-data.mjs validates the output with the engine's own
 * validator whenever the engine is present.
 *
 * Mapping:
 *   id, email                 the person's email (lower-cased): what every holder, owner and reporting line keys on
 *   name                      the roster's name, when it has one
 *   role                      their workspace role (owner, admin, engineer, member); "member" when on the roster only
 *   department, departments   the profile's department keys they are in (department: the first, for one-department
 *                             queries)
 *   reporting_managers        who they report to (the roster's reporting line), when that person is in the snapshot
 *   employment_status_active  true: an ARCHIVED roster row is not carried at all, nor any line from or to it, so
 *                             the engine never routes to, escalates through or walks past someone who left the
 *                             roster (a signed-in person whose roster row is archived stays, with their role only)
 *   <attribute key>           each declared attribute's value, by its key (people.attributes)
 * Roles: owner and admin may do everything in the workspace (All); engineer and member act on what they hold or
 * created, and on what their reportees hold (a supervisor reassigns their reportees' steps).
 */
import { declaredAttributes, declaredDepartments, type AttributeValue } from "./people-catalogue.ts";

/** The engine's directory person (core/evaluator.ts DirectoryUser), as this workspace fills it. */
export interface DirectoryPerson {
  id: string;
  organization_id?: string;
  email?: string;
  department?: string;
  departments?: string[];
  role?: string;
  reporting_managers?: string[];
  employment_status_active?: boolean;
  [key: string]: unknown;
}
/** The engine's permission scopes (core/rbac.ts PermissionScope) this adapter grants. */
export type DirectoryPermission = "All" | "AssignedReadUpdateAll" | "SelfCreatedAll" | "ReporteeAssignedReadUpdateAll";
/** The engine's role boundary (core/rbac.ts RoleBoundary). */
export interface DirectoryRole { name: string; permissions: { object_name?: string; permission: DirectoryPermission }[] }
/** One row of the engine's reporting matrix (core/rbac.ts ReportingRow). */
export interface DirectoryReportingRow { reporting_manager: string; reportee: string; business_unit?: string }
/** The engine's identity snapshot for one organisation (integrations/identity.ts IdentitySnapshot). */
export interface DirectorySnapshot {
  organization_id: string;
  users: DirectoryPerson[];
  roles: DirectoryRole[];
  grants?: never[];
  reporting?: DirectoryReportingRow[];
}

/** A roster row as people_roster holds it (agent/lib/db/schema.ts). */
export interface RosterPerson {
  orgId: string;
  email: string;
  name?: string | null;
  managerEmail?: string | null;
  departments?: unknown;
  attributes?: unknown;
  archivedAt?: Date | string | null;
}
/** A signed-in person of the workspace (org_members). */
export interface WorkspaceMember { orgId: string; email: string; role?: string | null }

export const WORKSPACE_ROLES = ["owner", "admin", "engineer", "member"] as const;
/** What each workspace role may do in the engine (see the module comment). */
export const DIRECTORY_ROLES: DirectoryRole[] = [
  { name: "owner", permissions: [{ permission: "All" }] },
  { name: "admin", permissions: [{ permission: "All" }] },
  { name: "engineer", permissions: [{ permission: "AssignedReadUpdateAll" }, { permission: "SelfCreatedAll" }, { permission: "ReporteeAssignedReadUpdateAll" }] },
  { name: "member", permissions: [{ permission: "AssignedReadUpdateAll" }, { permission: "SelfCreatedAll" }, { permission: "ReporteeAssignedReadUpdateAll" }] },
];

const roleOf = (r: string | null | undefined): (typeof WORKSPACE_ROLES)[number] =>
  (WORKSPACE_ROLES as readonly string[]).includes(r ?? "") ? (r as (typeof WORKSPACE_ROLES)[number]) : "member";

/**
 * The identity snapshot of one workspace. People are keyed by lower-cased email; someone on the roster and signed in
 * is one person. Sorted by id, so the same people always give the same snapshot.
 */
export function identitySnapshot(orgId: string, roster: readonly RosterPerson[], members: readonly WorkspaceMember[]): DirectorySnapshot {
  const inOrg = roster.filter((r) => r.orgId === orgId && typeof r.email === "string" && r.email.trim());
  const archived = new Set(inOrg.filter((r) => r.archivedAt).map((r) => r.email.trim().toLowerCase()));
  const ours = inOrg.filter((r) => !r.archivedAt);
  const signedIn = members.filter((m) => m.orgId === orgId && typeof m.email === "string" && m.email.trim());
  const byId = new Map<string, DirectoryPerson>();
  const managerOf = new Map<string, string>();
  for (const m of signedIn) {
    const id = m.email.trim().toLowerCase();
    byId.set(id, { id, organization_id: orgId, email: id, role: roleOf(m.role), employment_status_active: true });
  }
  for (const r of ours) {
    const id = r.email.trim().toLowerCase();
    const departments = declaredDepartments(r.departments);
    const attributes: Record<string, AttributeValue> = declaredAttributes(r.attributes);
    const prior = byId.get(id);
    const person: DirectoryPerson = {
      ...attributes,
      id,
      organization_id: orgId,
      email: id,
      role: prior?.role ?? "member",
      employment_status_active: true,
      departments,
    };
    if (r.name) person.name = r.name;
    if (departments.length) person.department = departments[0];
    byId.set(id, person);
    if (r.managerEmail && r.managerEmail.trim()) managerOf.set(id, r.managerEmail.trim().toLowerCase());
  }
  const reporting: DirectoryReportingRow[] = [];
  for (const [reportee, manager] of [...managerOf].sort(([a], [b]) => a.localeCompare(b))) {
    // A line to someone outside this workspace's people is not carried (the engine refuses a row naming an unknown
    // person); a line to oneself is not a line.
    // A line to an archived person is not carried either, even when they are still signed in.
    if (manager === reportee || !byId.has(manager) || archived.has(manager)) continue;
    byId.get(reportee)!.reporting_managers = [manager];
    reporting.push({ reporting_manager: manager, reportee });
  }
  const users = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { organization_id: orgId, users, roles: DIRECTORY_ROLES.map((r) => ({ name: r.name, permissions: r.permissions.map((p) => ({ ...p })) })), reporting };
}
