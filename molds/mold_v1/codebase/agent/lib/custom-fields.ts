/**
 * The deployment profile's OWN fields on the two record areas (`domains.<area>.custom_fields`,
 * docs/DEPLOYMENT_PROFILE.md): ONE validator for every write path.
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
import { DEPLOYMENT_PROFILE, type CustomFieldSpec, type CustomFieldType, type DomainArea } from "./deployment-profile.generated.ts";

export type CustomValue = string | number;
export type CustomValues = Record<string, CustomValue>;
export type CustomResult = { ok: true; values: CustomValues } | { ok: false; errors: string[] };

const TEXT_MAX = 500;
const LONG_TEXT_MAX = 20000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function customFieldsOf(area: DomainArea, domains = DEPLOYMENT_PROFILE.domains): CustomFieldSpec[] {
  return domains[area].custom_fields ?? [];
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
      if (!hit) return { error: `${name} must be one of: ${(f.options ?? []).join(", ")}.` };
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
 *    declares is carried through untouched: narrowing a profile must not delete what people entered.
 */
export function validateCustom(
  area: DomainArea,
  input: unknown,
  opts: { mode: "create" | "update"; existing?: unknown; fields?: CustomFieldSpec[] },
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
    else values[key] = out.value;
  }
  if (opts.mode === "create") for (const f of fields) if (f.required && !(f.key in values) && !errors.some((e) => e.includes(`(${f.key})`))) errors.push(`"${f.label}" (${f.key}) is required.`);
  return errors.length ? { ok: false, errors } : { ok: true, values };
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
