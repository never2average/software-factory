/**
 * A record field's value, one per type: the rule every write path shares (agent/lib/record-validate.ts for the
 * record areas, agent/lib/custom-fields.ts for the legacy own fields), so a value means the same thing wherever it is
 * written. Normalises what people type ("1,250.50", "85%", a choice's label) into what is stored, or answers in a
 * sentence that names the field by its label and key.
 *
 * Pure and small, with no import: the browser's forms check a value with it before anything is sent.
 */
import type { RecordField } from "./record-areas.generated.ts";

export const TEXT_MAX = 500;
export const LONG_TEXT_MAX = 20000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function realDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** What coerceFieldValue needs of a field. */
export type CoercibleField = Pick<RecordField, "key" | "type"> & Partial<Pick<RecordField, "label" | "options" | "min" | "max" | "max_length" | "pattern" | "many" | "legacy_values">>;
export type CoercedValue = string | number | boolean | string[];

export const fieldName = (f: CoercibleField) => `"${f.label ?? f.key}" (${f.key})`;
const choiceList = (f: CoercibleField) =>
  (f.options ?? []).filter((o) => !o.retired).map((o) => JSON.stringify(o.label ?? o.value) + (o.label && o.label !== o.value ? ` (${JSON.stringify(o.value)})` : "")).join(", ");

/** One value of a field, normalised for its type, or the sentence that says what is wrong with it. */
export function coerceFieldValue(f: CoercibleField, raw: unknown): { value: CoercedValue } | { error: string } {
  const name = fieldName(f);
  // Lists first: they are the only types that take an array.
  if (f.type === "multi_pick" || f.type === "tags" || (f.many && (f.type === "person" || f.type === "record" || f.type === "file"))) {
    const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
    if (!items) return { error: `${name} must be a list.` };
    const out: string[] = [];
    for (const item of items) {
      if (typeof item === "string" && item.trim() === "") continue;
      const one = coerceFieldValue({ ...f, type: f.type === "multi_pick" ? "pick_list" : f.type === "tags" ? "text" : f.type, many: false }, item);
      if ("error" in one) return one;
      if (!out.includes(String(one.value))) out.push(String(one.value));
    }
    return { value: out };
  }
  if (f.type === "boolean") {
    if (typeof raw === "boolean") return { value: raw };
    const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (["true", "yes", "1"].includes(t)) return { value: true };
    if (["false", "no", "0"].includes(t)) return { value: false };
    return { error: `${name} must be true or false.` };
  }
  if (typeof raw !== "string" && typeof raw !== "number") return { error: `${name} must be a single ${["number", "percent", "integer", "money"].includes(f.type) ? "number" : "text value"}, not a list or an object.` };
  const text = String(raw).trim();
  // Postgres cannot store a NUL character in text or jsonb: refused here, in a sentence, rather than by the
  // database as a raw "Failed query … params" error the model cannot act on.
  if (text.includes("\u0000")) return { error: `${name} contains a NUL character (\\u0000), which cannot be stored. Remove it and send the value again.` };
  const limits = (value: CoercedValue): { value: CoercedValue } | { error: string } => {
    if (typeof value === "number") {
      if (f.min !== undefined && value < f.min) return { error: `${name} must be at least ${f.min}.` };
      if (f.max !== undefined && value > f.max) return { error: `${name} must be at most ${f.max}.` };
    }
    if (typeof value === "string" && f.pattern && !new RegExp(f.pattern, "u").test(value)) return { error: `${name} is not in the expected form (${f.pattern}).` };
    return { value };
  };
  switch (f.type) {
    case "text":
    case "record":
      if (/[\r\n]/.test(text)) return { error: `${name} is a single line of text. Remove the line breaks.` };
      if (text.length > (f.max_length ?? TEXT_MAX)) return { error: `${name} is too long: keep it under ${f.max_length ?? TEXT_MAX} characters.` };
      return limits(text);
    case "long_text":
      if (text.length > (f.max_length ?? LONG_TEXT_MAX)) return { error: `${name} is too long: keep it under ${f.max_length ?? LONG_TEXT_MAX} characters.` };
      return limits(text);
    case "number":
    case "percent":
    case "money":
    case "integer": {
      // People type "1,250.50" and "85%"; both mean the number.
      const cleaned = f.type === "percent" ? text.replace(/\s*%$/, "") : text;
      const n = typeof raw === "number" ? raw : /^[+-]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?$/.test(cleaned) && /\d/.test(cleaned) ? Number(cleaned.replace(/,/g, "")) : NaN;
      if (!Number.isFinite(n)) return { error: `${name} must be a number${f.type === "percent" ? " from 0 to 100" : f.type === "integer" ? ", a whole one" : ", for example 1250.5"}.` };
      if (f.type === "percent" && (n < 0 || n > 100)) return { error: `${name} is a percentage: it must be from 0 to 100.` };
      if (f.type === "integer" && !Number.isInteger(n)) return { error: `${name} must be a whole number.` };
      return limits(n);
    }
    case "date":
      if (!realDate(text)) return { error: `${name} must be a real date written as year-month-day, for example 2026-07-31.` };
      return { value: text };
    case "datetime": {
      const t = Date.parse(text);
      if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text) || Number.isNaN(t)) return { error: `${name} must be a date and time, for example 2026-07-31T09:00:00Z.` };
      return { value: new Date(t).toISOString() };
    }
    case "email":
    case "person":
      if (!EMAIL.test(text) || text.length > 254) return { error: `${name} must be an email address, for example name@company.com.` };
      return { value: f.type === "person" ? text.toLowerCase() : text };
    case "link": {
      let url: URL | null = null;
      try { url = new URL(text); } catch { /* reported below */ }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return { error: `${name} must be a web link that starts with https:// or http://.` };
      return { value: url.toString() };
    }
    case "file":
      if (!text || text.startsWith("/") || text.split("/").includes("..") || /[\r\n]/.test(text)) return { error: `${name} must be a data-room path, for example evidence/report.pdf.` };
      return { value: text };
    case "pick_list": {
      const mapped = f.legacy_values?.[text] ?? text;
      const hit = (f.options ?? []).find((o) => !o.retired && (o.value.trim().toLowerCase() === mapped.toLowerCase() || (o.label ?? "").trim().toLowerCase() === mapped.toLowerCase()));
      // Quoted: a choice is the profile's own word, and a message the product writes to the model is spoken through
      // the vocabulary layer, which leaves a quoted span alone.
      if (!hit) return { error: `${name} must be one of: ${choiceList(f)}.` };
      return { value: hit.value };
    }
    default:
      return { error: `${name} has a type this write path does not take (${f.type}).` };
  }
}
