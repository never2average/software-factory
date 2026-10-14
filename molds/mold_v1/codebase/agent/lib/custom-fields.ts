/**
 * The deployment profile's OWN fields on the two record areas (`domains.<area>.custom_fields`) and on the account
 * record itself (`account_fields.custom_fields`), docs/DEPLOYMENT_PROFILE.md: ONE validator for every write path.
 *
 * A built-in column can be relabelled or hidden; a vertical also needs fields the base never had (a report's
 * period, its target price, a site's inspection date). Those are declared in the profile and stored by key in
 * the table's `custom` jsonb column, so a profile never needs DDL. Whatever writes that column — the ops API
 * routes, the agent's upsert_customer, a coding agent through the MCP tools (which go through the ops API) —
 * calls validateCustom() first and stores what it returns.
 *
 * Pure: no database, no React, no zod. It lives under agent/lib because the agent cannot import the web app's
 * lib/, while the web app imports agent/lib freely. `fields` is a parameter so a test or a preview page can
 * pass another profile's.
 */
import { DEPLOYMENT_PROFILE, type CustomFieldArea, type CustomFieldSpec, type CustomFieldType } from "./deployment-profile.generated.ts";
import { coerceFieldValue, LONG_TEXT_MAX } from "./record-values.ts";

/** The product install, as a person reads it: "deployment", or "workspace" once the profile renames the deployment
 *  record area (then "deployment" means that record). The rule lib/ui-words.ts `W.install` and speak() follow. */
const INSTALL = DEPLOYMENT_PROFILE.domains.deployments.label.singular.trim().toLowerCase() === "deployment" ? "deployment" : "workspace";

export type CustomValue = string | number;
export type CustomValues = Record<string, CustomValue>;
export type CustomResult = { ok: true; values: CustomValues } | { ok: false; errors: string[] };

/** The declared fields of a record: `account` is the account record itself (customers.custom). */
export function customFieldsOf(area: CustomFieldArea, profile: Pick<typeof DEPLOYMENT_PROFILE, "domains" | "account_fields"> = DEPLOYMENT_PROFILE): CustomFieldSpec[] {
  return (area === "account" ? profile.account_fields?.custom_fields : profile.domains[area].custom_fields) ?? [];
}

/** A stored `custom` column as a plain map: anything that is not an object reads as "nothing set". */
export function asCustomValues(stored: unknown): CustomValues {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([, v]) => typeof v === "string" || typeof v === "number")) as CustomValues;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * One value, normalised for its type, or the sentence that says what is wrong with it: the record areas' one rule
 * per type (agent/lib/record-values.ts), so an own field means the same thing on every kind of record.
 */
function coerce(f: CustomFieldSpec, raw: unknown): { value: CustomValue } | { error: string } {
  const out = coerceFieldValue({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options.map((value) => ({ value })) } : {}) }, raw);
  return out as { value: CustomValue } | { error: string };
}

/**
 * Validate a `custom` object for an area and return what to STORE.
 *
 *  - mode "create": every required field must be present.
 *  - mode "update": the input is a PARTIAL change merged onto `existing`; a key it does not mention is kept,
 *    null or "" clears a key (refused for a required one).
 *  - A key the profile does not declare is refused, never dropped silently. A stored key the profile no longer
 *    declares is carried through untouched: narrowing a profile must not delete what people entered — but
 *    null / "" for such a STORED key clears it (on an update), or it could never be removed at all.
 *  - `shrinkGuard` (the model's write path only): a long_text value of SHRINK_GUARD_MIN characters or more may not
 *    be replaced by one under half its length. A model rewriting a long note whole can cut it short without
 *    meaning to (an output budget, a summary it did not intend); it appends instead, or clears first.
 */
export function validateCustom(
  area: CustomFieldArea,
  input: unknown,
  opts: { mode: "create" | "update"; existing?: unknown; fields?: CustomFieldSpec[]; shrinkGuard?: { append: boolean } },
): CustomResult {
  const fields = opts.fields ?? customFieldsOf(area);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: string[] = [];
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    return { ok: false, errors: ["`custom` must be an object that maps a field key to its value."] };
  }
  const values: CustomValues = opts.mode === "update" ? asCustomValues(opts.existing) : {};
  for (const [key, raw] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    const f = byKey.get(key);
    if (!f && isBlank(raw) && opts.mode === "update" && key in values) {
      delete values[key];
      continue;
    }
    if (!f) {
      errors.push(fields.length ? `There is no custom field "${key}" here. The custom fields are: ${fields.map(describeCustomField).join("; ")}.` : `There is no custom field "${key}" here: this ${INSTALL}'s profile declares none for this kind of record.`);
      continue;
    }
    if (isBlank(raw)) {
      // Blank on a create is "not filled in" (reported once, below); on an update it is a request to clear.
      if (f.required && opts.mode === "update") errors.push(`"${f.label}" (${f.key}) is required, so it cannot be cleared.`);
      else delete values[key];
      continue;
    }
    const out = coerce(f, raw);
    if ("error" in out) errors.push(out.error);
    else {
      const before = values[key];
      if (opts.shrinkGuard && f.type === "long_text" && typeof before === "string" && before.length >= SHRINK_GUARD_MIN && String(out.value).length < before.length / 2) {
        errors.push(`"${f.label}" (${f.key}) would shrink from ${before.length.toLocaleString("en-US")} to ${String(out.value).length.toLocaleString("en-US")} characters, so it was not replaced. ${opts.shrinkGuard.append ? "To add to it, send only the new text in \`custom_append\`; to really replace it, send null for it in \`custom\` together with the new text in \`custom_append\`, in this one call" : "To really replace it, clear it first (null) and then send the new text"}.`);
      } else values[key] = out.value;
    }
  }
  if (opts.mode === "create") for (const f of fields) if (f.required && !(f.key in values) && !errors.some((e) => e.includes(`(${f.key})`))) errors.push(`"${f.label}" (${f.key}) is required.`);
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/** A long_text value this long or longer is protected by validateCustom's shrinkGuard. */
export const SHRINK_GUARD_MIN = 500;
/** What an append puts between the stored text and the addition. */
export const APPEND_SEPARATOR = "\n\n";
/** The longest a long_text value may be; also enforced in SQL at write time for appends (system-of-record.ts). */
export const LONG_TEXT_LIMIT = LONG_TEXT_MAX;

/**
 * The keys a patch REPLACES in one call: null (or "") in `custom` together with text in `custom_append` for the
 * same long-text key. Written as one SQL SET, so there is no moment, and no second approval, at which the old
 * text is gone and the new one not yet there.
 */
export function replacedKeys(custom: unknown, append: unknown): string[] {
  if (!custom || typeof custom !== "object" || !append || typeof append !== "object") return [];
  return Object.entries(custom as Record<string, unknown>)
    .filter(([k, v]) => isBlank(v) && typeof (append as Record<string, unknown>)[k] === "string")
    .map(([k]) => k);
}

/**
 * What a write CHANGES, for an atomic merge in SQL (agent/lib/custom-merge-sql.ts), instead of rewriting the
 * whole column from a value read earlier: that lost a note written in between (a concurrent ops write, another
 * agent turn). `set` = the keys the input names with a value (as validated), `clear` = the keys it clears,
 * `append` = long_text additions, applied to whatever is stored at write time. Undefined = nothing to write.
 */
export interface CustomDelta { set: CustomValues; clear: string[]; append: Record<string, string> }
export function customDelta(input: unknown, values: CustomValues, append: Record<string, string> = {}): CustomDelta | undefined {
  const named = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [];
  const set: CustomValues = {};
  const clear: string[] = [];
  for (const [k, raw] of named) {
    if (isBlank(raw)) clear.push(k);
    else if (k in values) set[k] = values[k];
  }
  if (!Object.keys(set).length && !clear.length && !Object.keys(append).length) return undefined;
  return { set, clear, append };
}

/**
 * `custom_append`: text added to the END of long_text fields, by key, so a long note is never resent whole.
 * Validated against the declared fields and the stored values (the total must still fit a long_text); returns
 * the merged values (what the record reads after the write) and the additions for the atomic SQL append.
 */
export function validateAppend(
  input: unknown,
  opts: { fields: CustomFieldSpec[]; values: CustomValues; also?: unknown },
): { ok: true; values: CustomValues; append: Record<string, string> } | { ok: false; errors: string[] } {
  if (input === undefined || input === null) return { ok: true, values: opts.values, append: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["`custom_append` must be an object that maps a long-text field's key to the text to add."] };
  const errors: string[] = [];
  const values = { ...opts.values };
  const append: Record<string, string> = {};
  const longText = opts.fields.filter((f) => f.type === "long_text");
  const sent = opts.also && typeof opts.also === "object" ? (opts.also as Record<string, unknown>) : {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const f = longText.find((x) => x.key === key);
    if (!f) {
      errors.push(longText.length ? `\`custom_append\` adds to a long-text field, and "${key}" is not one. The long-text fields are: ${longText.map(describeCustomField).join("; ")}.` : `\`custom_append\` adds to a long-text field, and this record declares none.`);
      continue;
    }
    if (key in sent) { errors.push(`"${f.label}" (${f.key}) is in both \`custom\` and \`custom_append\`. To add to it, send it only in \`custom_append\`; to replace it, send null for it in \`custom\` together with the new text in \`custom_append\`.`); continue; }
    if (typeof raw !== "string" || !raw.trim()) { errors.push(`"${f.label}" (${f.key}): \`custom_append\` takes the text to add, a non-empty string.`); continue; }
    if (raw.includes("\u0000")) { errors.push(`"${f.label}" (${f.key}) contains a NUL character (\\u0000), which cannot be stored. Remove it and send the text again.`); continue; }
    const text = raw.trim();
    const before = typeof values[key] === "string" ? (values[key] as string) : "";
    const after = before ? `${before}${APPEND_SEPARATOR}${text}` : text;
    if (after.length > LONG_TEXT_MAX) { errors.push(`"${f.label}" (${f.key}) would be too long after the addition: keep it under ${LONG_TEXT_MAX} characters.`); continue; }
    values[key] = after;
    append[key] = text;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values, append };
}

/** A stored value as a person reads it: a percentage gets its sign, a number its separators. "" when unset. */
export function displayCustom(f: Pick<CustomFieldSpec, "type">, value: unknown): string {
  if (isBlank(value)) return "";
  if (f.type === "percent") return `${value}%`;
  if (f.type === "number" && typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return String(value);
}

/** The HTML input type for a field; long_text is a textarea and pick_list a select, handled by the form. */
export function inputTypeOf(type: CustomFieldType): "text" | "number" | "date" | "email" | "url" {
  return type === "number" || type === "percent" ? "number" : type === "date" ? "date" : type === "email" ? "email" : type === "link" ? "url" : "text";
}

/** `key` ("Label", type, required?, choices): how a tool description and the agent's briefing name a field. */
export function describeCustomField(f: CustomFieldSpec): string {
  const type = f.type === "pick_list" ? `one of ${(f.options ?? []).map((o) => JSON.stringify(o)).join(" | ")}` : f.type === "date" ? "date yyyy-mm-dd" : f.type === "percent" ? "percent 0-100" : f.type === "link" ? "http(s) link" : f.type.replace("_", " ");
  return `\`${f.key}\` ("${f.label}", ${type}${f.required ? ", required" : ""})`;
}
