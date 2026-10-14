/**
 * Server side of the deployment profile's `domains` section (docs/DEPLOYMENT_PROFILE.md).
 *
 * The ops routes for deployments and implementations were written around the handful of fields the default UI
 * edits. A deployment that redefines an area puts other REAL columns on its forms (`create_fields`,
 * `detail_fields`, `group_by`, `kind_field`), so the routes accept any single-value column of the table,
 * validated against the zod enum it has in agent/lib/customer-schema.ts. No column is renamed or added.
 */
import { z } from "zod";
import { DEPLOYMENT_PROFILE, DOMAIN_FIELDS, type CustomFieldArea, type DomainArea } from "@/lib/deployment-profile.generated";
import { customFieldsOf, displayCustom, validateCustom, type CustomValues } from "@/agent/lib/custom-fields";
import { CHOICE_MEANINGS } from "@/agent/lib/customer-schema";

/**
 * The stored values of a built-in choice column: its zod enum in agent/lib/customer-schema.ts, as the generator
 * copied it into DOMAIN_FIELDS. The one list every write path checks against.
 */
export function choiceValues(area: DomainArea, key: string): readonly string[] {
  const values = DOMAIN_FIELDS[area][key]?.values;
  if (!values?.length) throw new Error(`${area}.${key} is not a choice field`);
  return values;
}

/** The words this deployment shows for a stored value, when they are more than the value in other case. */
function shownAs(area: DomainArea, key: string, value: string): string | null {
  const label = DEPLOYMENT_PROFILE.domains[area].fields[key]?.options?.[value];
  return label && label.toLowerCase() !== value.toLowerCase() ? label : null;
}

/** "healthy, degraded, down" — or, where this deployment shows a value in other words, `healthy ("On time")`. */
export function choiceList(area: DomainArea, key: string): string {
  return choiceValues(area, key)
    .map((v) => (shownAs(area, key, v) ? `${v} ("${shownAs(area, key, v)}")` : v))
    .join(", ");
}

/** The choice fields the record write tools take (setup/workspace-tools.mjs: implementation_upsert, deployment_upsert). */
const TOOL_CHOICE_FIELDS = {
  deployments: ["environment", "region", "releaseStatus", "healthStatus"],
  implementations: ["implementationStage", "implementationRiskLevel"],
} as const satisfies Record<DomainArea, readonly string[]>;

/**
 * The hosted tools' `ctx.choices`: each choice field's stored values, this deployment's word for each, and the
 * value a new record gets when the caller names none. Read from the schema's enums, so the tools' text cannot name
 * a value the API refuses.
 */
export function toolChoices(): Record<DomainArea, Record<string, { value: string; label: string; default?: true }[]>> {
  const defaults: Record<DomainArea, Record<string, string>> = { deployments: CHOICE_MEANINGS.deployments.defaults, implementations: CHOICE_MEANINGS.implementations.defaults };
  const area = (a: DomainArea) =>
    Object.fromEntries(
      TOOL_CHOICE_FIELDS[a].map((key) => [
        key,
        choiceValues(a, key).map((value) => ({ value, label: shownAs(a, key, value) ?? value, ...(defaults[a][key] === value ? { default: true as const } : {}) })),
      ]),
    );
  return { deployments: area("deployments"), implementations: area("implementations") };
}

/**
 * A built-in choice column on a write: one of its stored values, or a 400 that names them. It used to be any
 * non-empty string, so a value no screen, count or filter knows ("production", "low", "scoping") was stored silently
 * and the record dropped out of every view that groups by the field (mold_v1-251).
 */
export function choiceSchema(area: DomainArea, key: string) {
  const values = choiceValues(area, key);
  const label = DEPLOYMENT_PROFILE.domains[area].fields[key]?.label ?? key;
  return z.string().superRefine((v, ctx) => {
    if (!values.includes(v)) {
      ctx.addIssue({ code: "custom", message: `${label}: ${JSON.stringify(v)} is not one of its values. Use one of: ${choiceList(area, key)}.` });
    }
  });
}

/** Optional zod entries for every writable column the route does not already declare. "" and null clear a value. */
export function profileFieldSchemas(area: DomainArea, declared: readonly string[]): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, meta] of Object.entries(DOMAIN_FIELDS[area])) {
    if (!meta.column || meta.type === "list" || meta.required || declared.includes(key)) continue;
    const blank = (v: unknown) => (v === "" ? null : v);
    out[key] =
      meta.type === "enum"
        ? z.preprocess(blank, choiceSchema(area, key).nullable().optional())
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
export function customForWrite(area: CustomFieldArea, custom: unknown, existing: { custom?: unknown } | null | undefined): { custom?: CustomValues; error?: string } {
  if (existing ? custom == null : custom == null && customFieldsOf(area).length === 0) return {};
  const result = validateCustom(area, custom, existing ? { mode: "update", existing: existing.custom } : { mode: "create" });
  return result.ok ? { custom: result.values } : { error: result.errors.join(" ") };
}

/** Activity-feed entries for the custom fields a write changed: the field's label, the values as people read them. */
export function customFieldChanges(area: CustomFieldArea, before: unknown, after: unknown): { label: string; before: string | null; after: string | null }[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return customFieldsOf(area).map((f) => ({ label: f.label, before: displayCustom(f, b[f.key]) || null, after: displayCustom(f, a[f.key]) || null }));
}
