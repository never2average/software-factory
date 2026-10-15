"use client";

/**
 * What the signed-in person may do to an area's records, for what a panel offers (agent/lib/record-permissions.ts
 * recordAccess: the rule book the API enforces). The role is the person's in the workspace this tab is on, read from
 * /api/ops/me/workspaces the way the workspace switcher reads which workspace is active: this tab's choice when it is
 * a membership, else the server's `active`, else the first.
 *
 * Only ever an offer: the API is the authority and answers a refusal with a 403 and its sentence. Read only when the
 * area declares permissions (every default declares none, so nothing is fetched and everything is offered as today).
 * An unknown role (not loaded yet, a failed read) offers everything and leaves the decision to the API.
 */
import { useEffect, useMemo, useState } from "react";
import { RECORD_AREAS, type RecordAreaId, type RecordRole } from "@/agent/lib/record-areas.generated";
import type { RecordAreas } from "@/agent/lib/record-areas";
import { permissionsDeclared, recordAccess, type RecordAccess } from "@/agent/lib/record-permissions";
import { readActiveOrg } from "@/lib/browser-storage";
import { opsFetch } from "./lib";

const ROLES: readonly RecordRole[] = ["owner", "admin", "engineer", "member"];

/** The role a /api/ops/me/workspaces answer gives for this tab's workspace, or undefined. */
export function roleFromWorkspaces(answer: unknown, tabOrg: string | null): RecordRole | undefined {
  const d = answer as { memberships?: { orgId: string; role?: string | null }[]; active?: string | null } | null;
  const ms = Array.isArray(d?.memberships) ? d.memberships : [];
  const pick = ms.find((m) => m.orgId === tabOrg) ?? ms.find((m) => m.orgId === d?.active) ?? ms[0];
  const role = pick?.role ?? null;
  return role && (ROLES as readonly string[]).includes(role) ? (role as RecordRole) : undefined;
}

/** The signed-in person's role in this tab's workspace, read only when `enabled`. */
export function useRecordRole(enabled: boolean): RecordRole | undefined {
  const [role, setRole] = useState<RecordRole | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    opsFetch<unknown>("/api/ops/me/workspaces")
      .then((d) => {
        if (alive) setRole(roleFromWorkspaces(d, readActiveOrg()));
      })
      .catch(() => {
        /* unknown: the API decides */
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return role;
}

/** What everything-allowed reads as: an area without permissions, or a role not known yet. */
const OPEN: RecordAccess = { declared: false, create: true, update: () => true, transition: () => true, delete: () => true, field: () => true };

/** What `me` may do to `area`'s records in this tab's workspace (everything, for an area that declares no permissions). */
export function useRecordAccess(area: RecordAreaId, me: string | undefined, areas: RecordAreas = RECORD_AREAS): RecordAccess {
  const declared = permissionsDeclared(area, areas);
  const role = useRecordRole(declared);
  return useMemo(() => (declared && role ? recordAccess(area, { role, actor: me ?? "" }, areas) : OPEN), [declared, role, area, me, areas]);
}
