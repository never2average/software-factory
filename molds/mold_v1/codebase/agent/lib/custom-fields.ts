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

export type CustomValue = string | number;
export type CustomValues = Record<string, CustomValue>;
export type CustomResult = { ok: true; values: CustomValues } | { ok: false; errors: string[] };

const TEXT_MAX = 500;
const LONG_TEXT_MAX = 20000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function realDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** One value, normalised for its type, or the sentence that says what is wrong with it. */
function coerce(f: CustomFieldSpec, raw: unknown): { value: CustomValue } | { error: string } {
  const name = `"${f.label}" (${f.key})`;
  if (typeof raw !== "string" && typeof raw !== "number") return { error: `${name} must be a single ${f.type === "number" || f.type === "percent" ? "number" : "text value"}, not a list or an object.` };
  const text = String(raw).trim();
  // Postgres cannot store a NUL character in text or jsonb: refused here, in a sentence, rather than by the
  // database as a raw "Failed query … params" error the model cannot act on.
  if (text.includes("\u0000")) return { error: `${name} contains a NUL character (\\u0000), which cannot be stored. Remove it and send the value again.` };
  switch (f.type) {
    case "text":
      if (/[\r\n]/.test(text)) return { error: `${name} is a single line of text. Remove the line breaks.` };
      if (text.length > TEXT_MAX) return { error: `${name} is too long: keep it under ${TEXT_MAX} characters.` };
      return { value: text };
    case "long_text":
      if (text.length > LONG_TEXT_MAX) return { error: `${name} is too long: keep it under ${LONG_TEXT_MAX} characters.` };
      return { value: text };
    case "number":
    case "percent": {
      // People type "1,250.50" and "85%"; both mean the number.
      const cleaned = f.type === "percent" ? text.replace(/\s*%$/, "") : text;
      const n = typeof raw === "number" ? raw : /^[+-]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?$/.test(cleaned) && /\d/.test(cleaned) ? Number(cleaned.replace(/,/g, "")) : NaN;
      if (!Number.isFinite(n)) return { error: `${name} must be a number${f.type === "percent" ? " from 0 to 100" : ", for example 1250.5"}.` };
      if (f.type === "percent" && (n < 0 || n > 100)) return { error: `${name} is a percentage: it must be from 0 to 100.` };
      return { value: n };
    }
    case "date":
      if (!realDate(text)) return { error: `${name} must be a real date written as year-month-day, for example 2026-07-31.` };
      return { value: text };
    case "email":
      if (!EMAIL.test(text) || text.length > 254) return { error: `${name} must be an email address, for example name@company.com.` };
      return { value: text };
    case "link": {
      let url: URL | null = null;
      try { url = new URL(text); } catch { /* reported below */ }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return { error: `${name} must be a web link that starts with https:// or http://.` };
      return { value: url.toString() };
    }
    case "pick_list": {
      const hit = (f.options ?? []).find((o) => o.trim().toLowerCase() === text.toLowerCase());
      // Quoted, as describeCustomField does: a choice is the profile's own word, and a message the product writes
      // to the model is spoken through the vocabulary layer, which leaves a quoted span alone. Unquoted, a choice
      // that happens to be a base word ("Customer", "Deployment") was relabelled and the model's retry refused again.
      if (!hit) return { error: `${name} must be one of: ${(f.options ?? []).map((o) => JSON.stringify(o)).join(", ")}.` };
      return { value: hit };
    }
  }
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
      errors.push(fields.length ? `There is no custom field "${key}" here. The custom fields are: ${fields.map(describeCustomField).join("; ")}.` : `There is no custom field "${key}" here: this deployment's profile declares none for this kind of record.`);
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
