/**
 * Server side of the deployment profile's `domains` section (docs/DEPLOYMENT_PROFILE.md).
 *
 * The ops routes for deployments and implementations were written around the handful of fields the default UI
 * edits. A deployment that redefines an area puts other REAL columns on its forms (`create_fields`,
 * `detail_fields`, `group_by`, `kind_field`), so the routes accept any single-value column of the table,
 * validated against the zod enum it has in agent/lib/customer-schema.ts. No column is renamed or added.
 */
import { z } from "zod";
import { DEPLOYMENT_PROFILE, DOMAIN_FIELDS, type DomainArea } from "@/lib/deployment-profile.generated";
import { customFieldsOf, displayCustom, validateCustom, type CustomValues } from "@/agent/lib/custom-fields";

/** Optional zod entries for every writable column the route does not already declare. "" and null clear a value. */
export function profileFieldSchemas(area: DomainArea, declared: readonly string[]): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, meta] of Object.entries(DOMAIN_FIELDS[area])) {
    if (!meta.column || meta.type === "list" || meta.required || declared.includes(key)) continue;
    const blank = (v: unknown) => (v === "" ? null : v);
    out[key] =
      meta.type === "enum"
        ? z.preprocess(blank, z.enum(meta.values as [string, ...string[]]).nullable().optional())
        : meta.type === "number"
          ? z.preprocess(blank, z.coerce.number().nullable().optional())
          : z.preprocess(blank, z.string().trim().nullable().optional());
  }
  return out;
}

/** The fields this deployment's profile puts on a form or groups by: what a list row carries beyond the defaults. */
export function profileListFields(area: DomainArea): string[] {
  const spec = DEPLOYMENT_PROFILE.domains[area];
  const groupBy = "group_by" in spec ? (spec as { group_by: string | null }).group_by : null;
  return [...new Set([...spec.create_fields, ...spec.detail_fields, spec.kind_field, groupBy].filter((k): k is string => Boolean(k)))];
}

export function pickProfileFields(area: DomainArea, row: Record<string, unknown>): Record<string, string | number | null> {
  return Object.fromEntries(
    profileListFields(area).map((k) => {
      const v = row[k];
      return [k, typeof v === "string" || typeof v === "number" ? v : null];
    }),
  );
}

/** The label the activity feed shows for a changed field: the profile's, else the key. */
export function profileFieldLabel(area: DomainArea, key: string, legacy: string): string {
  const f = DEPLOYMENT_PROFILE.domains[area].fields[key];
  return f?.label ?? legacy;
}

/**
 * The profile's OWN fields (`custom_fields`) on a create or an update. The body's `custom` is only shape-checked
 * by the route's zod schema; what it may hold is decided by the one shared validator, agent/lib/custom-fields.ts.
 */
export const customBodySchema = z.record(z.string(), z.unknown()).nullable().optional();

/**
 * What to write to the `custom` column, or the plain sentences to return as a 400.
 * `existing` = the stored row when there is one: its values are kept unless the body changes them.
 * `undefined` = write nothing: the body sent no `custom` and there is nothing to enforce.
 */
export function customForWrite(area: DomainArea, custom: unknown, existing: { custom?: unknown } | null | undefined): { custom?: CustomValues; error?: string } {
  if (existing ? custom == null : custom == null && customFieldsOf(area).length === 0) return {};
  const result = validateCustom(area, custom, existing ? { mode: "update", existing: existing.custom } : { mode: "create" });
  return result.ok ? { custom: result.values } : { error: result.errors.join(" ") };
}

/** Activity-feed entries for the custom fields a write changed: the field's label, the values as people read them. */
export function customFieldChanges(area: DomainArea, before: unknown, after: unknown): { label: string; before: string | null; after: string | null }[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return customFieldsOf(area).map((f) => ({ label: f.label, before: displayCustom(f, b[f.key]) || null, after: displayCustom(f, a[f.key]) || null }));
}
