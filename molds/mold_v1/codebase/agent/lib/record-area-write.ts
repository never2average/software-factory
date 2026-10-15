/**
 * A WRITE TO AN ACCOUNT RECORD AREA (deployments, implementations), CHECKED BY THE ONE VALIDATOR (agent/lib/record-validate.ts)
 * whatever path it comes by: the ops routes (app/api/ops/{deployments,implementations}), upsert_customer's nested rows
 * (agent/lib/system-of-record.ts) and the per-area agent tools (agent/lib/record-area-tools.ts). MCP goes through the
 * routes.
 *
 *   - an area the profile states in the record-area form (`declared`): prepareRecordWrite() is the whole check and its
 *     result is what is written (columns, own fields as a per-key delta, defaults and fixed values on create);
 *   - any other profile (the default, the legacy `domains.<area>`): checkOnly() runs the same validator over the write
 *     the route has already parsed and returns only its refusal, so a valid write is sent exactly as before.
 *
 * Pure: no database, no fetch.
 */
import { RECORD_AREAS, type RecordRole } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type RecordAreas } from "./record-areas.ts";
import { validateRecordWrite, type TransitionCheck } from "./record-validate.ts";
import { warningOf, type LifecycleConflict, type MoveCheck, type WriteWarning } from "./record-lifecycle.ts";
import { CHOICE_MEANINGS } from "./customer-schema.ts";
import { DOMAIN_FIELDS } from "./deployment-profile.generated.ts";
import type { AccountAreaId } from "./record-area-records.ts";
import { createRefusal, updateRefusal } from "./record-permissions.ts";

/**
 * Request keys that are not fields of the area: the account, who writes, the activity feed's id, the edited title,
 * and `reason` (the comment a lifecycle move may need, as a task's).
 */
export const RECORD_PASS_THROUGH: readonly string[] = ["customerId", "actor", "entityId", "displayName", "reason"];

/**
 * The values a new row gets when neither the caller nor the definition names one (a default, a fixed value, the
 * lifecycle's initial state): the ops routes' own defaults, values of the columns' enums (CHOICE_MEANINGS).
 */
export const ROUTE_DEFAULTS: Record<AccountAreaId, Record<string, unknown>> = {
  deployments: { ...CHOICE_MEANINGS.deployments.defaults },
  implementations: { ...CHOICE_MEANINGS.implementations.defaults, implementationProgressPct: 0 },
};

/* ------------------------------------------------------------------------------------------------- a write */

/** A per-key change of the `custom` column (agent/lib/custom-merge-sql.ts): set, clear, never append here. */
export interface RecordCustomDelta { set: Record<string, unknown>; clear: string[]; append: Record<string, string> }

export type PreparedWrite =
  | {
      ok: true;
      /** The columns to write, by key (the request's passed-through `displayName` included). */
      columns: Record<string, unknown>;
      /** The own fields that change; null when the write names none. */
      customDelta: RecordCustomDelta | null;
      /** A new row's whole `custom` (the delta over nothing). */
      custom: Record<string, unknown>;
      /** The own fields as the record holds them after the write (the stored ones carried through). */
      customAfter: Record<string, unknown>;
      /** The broken lifecycle rules of a move that went through (enforce "warn"): the answer's `warnings`. */
      warnings: WriteWarning[];
      transition: TransitionCheck | null;
      /**
       * The move this write makes, checked by the lifecycle's rules (agent/lib/record-lifecycle.ts), when the lifecycle
       * is enforced; the caller writes it to the activity feed once the write landed (recordLifecycleOutcome /
       * writeOutcome). Null under "off" and when nothing moves.
       */
      lifecycle: MoveCheck | null;
    }
  | { ok: false; errors: string[]; conflict?: LifecycleConflict; forbidden?: true };

export interface WriteWho {
  actor: string;
  role?: RecordRole;
  now?: Date;
  /** The stored row (its columns by key, and `custom`), on an update. */
  before?: AreaRow | null;
  /** Who moved the stored record into its state (lib/record-lifecycle-server.ts lifecycleContext), for four eyes. */
  enteredBy?: string | null;
  /**
   * false: skip who-may (agent/lib/record-permissions.ts), for a form's own pre-check when the screen does not know
   * the caller's role. Every server path leaves it on and passes `role`.
   */
  checkPermissions?: boolean;
}

/**
 * One write to an account record area, checked against its definition. `body` is what the caller sent: field keys (or
 * their aliases), `custom` for own fields, and the passed-through request keys (RECORD_PASS_THROUGH), which never
 * reach the validator as fields. A create gets the route defaults for what neither the caller nor the definition fills.
 *
 * The lifecycle is the validator's (agent/lib/record-validate.ts, agent/lib/record-lifecycle.ts): a move refused under
 * `enforce: "strict"` comes back with `conflict`; one under "warn" goes through with `warnings`; `lifecycle` is the
 * checked move for the activity feed. Under "off" (the default) nothing is read, stamped or noted.
 */
export function prepareRecordWrite(
  id: AccountAreaId,
  mode: "create" | "update",
  body: Record<string, unknown>,
  who: WriteWho,
  areas: RecordAreas = RECORD_AREAS,
): PreparedWrite {
  const v = areaView(id, areas);
  // Who may (records.areas.<area>.permissions): a refusal is `forbidden` (the routes' 403). Nothing is checked, and
  // nothing changes, for an area that declares no permissions.
  if (who.checkPermissions !== false) {
    const refusal = mode === "create" ? createRefusal(id, who, body, areas) : updateRefusal(id, body, who.before, who, areas);
    if (refusal) return { ok: false, errors: [refusal], forbidden: true };
  }
  const patch: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(body)) if (!RECORD_PASS_THROUGH.includes(k) && x !== undefined) patch[k] = x;
  if (mode === "create") {
    const lc = v.area.lifecycle;
    for (const [k, d] of Object.entries(ROUTE_DEFAULTS[id])) {
      const f = v.field(k);
      if (!f || k in patch || f.computed || (f.hidden && f.fixed !== undefined) || "default" in f) continue;
      if (lc && lc.field === k && v.lifecycle?.initial) continue;
      // A value the definition no longer offers is not a default (a declared area may narrow a column's choices).
      if (f.options && !f.options.some((o) => o.value === d && !o.retired)) continue;
      patch[k] = d;
    }
  }
  // The record's id, in the form the definition gives it (`id.pattern`), checked when it is created (a row stored
  // before the pattern existed is still found and changed by its id).
  const idSpec = v.area.id;
  const idKey = id === "deployments" ? idSpec?.field ?? "deploymentId" : null;
  const idError = mode === "create" && idKey && idSpec?.pattern && typeof patch[idKey] === "string" && !new RegExp(idSpec.pattern, "u").test(patch[idKey] as string)
    ? `"${idSpec.label ?? idKey}" (${idKey}) is not in the expected form (${idSpec.pattern}).`
    : null;
  // The lifecycle's rules are the validator's (agent/lib/record-lifecycle.ts): a move it refuses under "strict" comes
  // back with `conflict` (the routes' 409), one under "warn" goes through with its warning and its activity lines.
  const comment = typeof body.reason === "string" ? body.reason : null;
  const r = validateRecordWrite(id, { mode, before: who.before ?? null, patch, actor: who.actor, role: who.role, now: who.now, comment, enteredBy: who.enteredBy }, areas);
  if (!r.ok || idError) return { ok: false, errors: [...(idError ? [idError] : []), ...(r.ok ? [] : r.errors)], ...(!r.ok && r.conflict ? { conflict: r.conflict } : {}) };
  const columns: Record<string, unknown> = { ...r.columns };
  if ("displayName" in body && body.displayName !== undefined) columns.displayName = typeof body.displayName === "string" ? body.displayName.trim() || null : null;
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [k, x] of Object.entries(r.customDelta)) {
    if (x === null) clear.push(k);
    else set[k] = x;
  }
  const custom: Record<string, unknown> = { ...set };
  const lifecycle = r.lifecycle ?? null;
  const warnings = lifecycle && lifecycle.enforce === "warn" && !lifecycle.allowed ? [warningOf(lifecycle)] : [];
  return { ok: true, customAfter: r.custom, columns, customDelta: Object.keys(set).length || clear.length ? { set, clear, append: {} } : null, custom, warnings, transition: r.transition, lifecycle };
}

/**
 * The same check for a write a legacy route has already parsed (a profile that does not declare the area): only its
 * refusal is used, so a valid write is sent exactly as before. `body` is the parsed body, its route defaults filled.
 */
export function checkOnly(id: AccountAreaId, mode: "create" | "update", body: Record<string, unknown>, who: WriteWho, areas: RecordAreas = RECORD_AREAS): string[] {
  // A hidden field's fixed value is the forms' to submit; the legacy routes never held a write to it (a route default
  // may differ), so it is not judged here.
  const legacy = legacyAreas(areas);
  const v = areaView(id, legacy);
  // Its own values (`custom`) are agent/lib/custom-fields.ts's on these routes, the same per-type rule
  // (agent/lib/record-values.ts) with the sentences they have always answered.
  const judged = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "custom" && !(v.field(k)?.hidden && v.field(k)?.fixed !== undefined)));
  const r = prepareRecordWrite(id, mode, judged, who, legacy);
  return r.ok ? [] : r.errors;
}


/**
 * The definitions as the legacy routes have always taken a column: a free-text column a legacy profile lists kinds for
 * (`kind_field`) is still free text there, and a number column is any number. Only for checkOnly(): a profile that
 * draws the area from its definition gets its choices and ranges held.
 */
const legacyCache = new WeakMap<RecordAreas, RecordAreas>();
function legacyAreas(areas: RecordAreas): RecordAreas {
  const hit = legacyCache.get(areas);
  if (hit) return hit;
  const out = structuredClone(areas) as RecordAreas;
  for (const id of ["deployments", "implementations"] as const) {
    for (const f of Object.values(out[id].fields)) {
      const meta = DOMAIN_FIELDS[id][f.key];
      if (!f.column || !meta) continue;
      if (meta.type === "text" && f.type === "pick_list") {
        f.type = "text";
        delete f.options;
      }
      if (meta.type === "number" && f.type === "percent") f.type = "number";
    }
  }
  legacyCache.set(areas, out);
  return out;
}
