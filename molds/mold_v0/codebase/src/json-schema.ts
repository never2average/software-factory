/**
 * The subset of JSON Schema that programs declare (src/program-spec.ts) and the evaluator's json-schema scorer checks
 * (src/program-scorers.ts), implemented here so that what is declared is what is enforced: a keyword this file does not
 * know is refused when a program is saved, never ignored when a child's output is checked. Pure, and imports nothing:
 * it is part of the run sandbox's code (orchestrator/deploy/boat-lib.ts runnerCodeFiles), which may hold only node's
 * modules and runner files.
 */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export type JsonSchema = Record<string, unknown>;
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const KEYWORDS = new Set(["$comment", "$defs", "$ref", "title", "description", "default", "examples", "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "anyOf", "oneOf", "allOf", "not"]);
const FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
};
const MAX_DEPTH = 24;

/** What a schema says wrongly. A keyword that is not implemented is a problem: it would not be enforced. */
export function schemaProblems(schema: unknown, at = "schema", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${at}: nested too deeply`];
  if (!isObject(schema)) return [`${at}: a JSON Schema object`];
  const out: string[] = [];
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) out.push(`${at}.${k}: this keyword is not supported, so it could not be enforced`);
  const t = schema.type;
  if (t !== undefined && !(typeof t === "string" ? TYPES.includes(t) : Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && TYPES.includes(x)))) out.push(`${at}.type: one of ${TYPES.join(", ")}, or a list of them`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) out.push(`${at}.enum: a list with at least one value`);
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((x) => typeof x === "string"))) out.push(`${at}.required: a list of property names`);
  for (const k of ["minItems", "maxItems", "minLength", "maxLength"]) if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && (schema[k] as number) >= 0)) out.push(`${at}.${k}: a whole number`);
  for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) if (schema[k] !== undefined && typeof schema[k] !== "number") out.push(`${at}.${k}: a number`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 500) out.push(`${at}.pattern: a regular expression of at most 500 characters`);
    else try { new RegExp(schema.pattern, "u"); } catch { out.push(`${at}.pattern: not a valid regular expression`); }
  }
  if (schema.format !== undefined && !(typeof schema.format === "string" && schema.format in FORMATS)) out.push(`${at}.format: one of ${Object.keys(FORMATS).join(", ")}`);
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) out.push(`${at}.properties: an object`);
    else for (const [k, v] of Object.entries(schema.properties)) out.push(...schemaProblems(v, `${at}.properties.${k}`, depth + 1));
  }
  if (schema.$defs !== undefined) {
    if (!isObject(schema.$defs)) out.push(`${at}.$defs: an object`);
    else for (const [k, v] of Object.entries(schema.$defs)) out.push(...schemaProblems(v, `${at}.$defs.${k}`, depth + 1));
  }
  if (schema.$ref !== undefined && !(typeof schema.$ref === "string" && /^#\/\$defs\/[^/]+$/.test(schema.$ref))) out.push(`${at}.$ref: only a local #/$defs/<name>`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") out.push(...schemaProblems(schema.additionalProperties, `${at}.additionalProperties`, depth + 1));
  if (schema.items !== undefined) out.push(...schemaProblems(schema.items, `${at}.items`, depth + 1));
  if (schema.not !== undefined) out.push(...schemaProblems(schema.not, `${at}.not`, depth + 1));
  for (const k of ["anyOf", "oneOf", "allOf"]) if (schema[k] !== undefined) {
    if (!Array.isArray(schema[k]) || !(schema[k] as unknown[]).length) out.push(`${at}.${k}: a list of schemas`);
    else (schema[k] as unknown[]).forEach((s, i) => out.push(...schemaProblems(s, `${at}.${k}[${i}]`, depth + 1)));
  }
  return out;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** Why `value` does not meet `schema`, in words naming where; empty when it does. Bounded, so a large value cannot run away. */
export function validateJson(value: unknown, schema: JsonSchema, root: JsonSchema = schema, at = "$", depth = 0, budget = { left: 20_000 }): string[] {
  if (depth > MAX_DEPTH || --budget.left < 0) return [`${at}: too deep or too large to check`];
  if (schema.$ref) {
    const name = String(schema.$ref).slice("#/$defs/".length);
    const d = (root.$defs as Record<string, JsonSchema> | undefined)?.[name];
    return d ? validateJson(value, d, root, at, depth + 1, budget) : [`${at}: its schema refers to ${String(schema.$ref)}, which is not defined`];
  }
  const out: string[] = [];
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const ok = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!ok.includes(t) && !(t === "integer" && ok.includes("number"))) return [`${at}: should be ${ok.join(" or ")}, is ${t}`];
  }
  if (schema.enum && !(schema.enum as unknown[]).some((e) => same(e, value))) out.push(`${at}: should be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
  if ("const" in schema && !same(schema.const, value)) out.push(`${at}: should be ${JSON.stringify(schema.const).slice(0, 200)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) out.push(`${at}: at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) out.push(`${at}: at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string, "u").test(value)) out.push(`${at}: does not match the required pattern`);
    if (schema.format !== undefined && !FORMATS[schema.format as string]!.test(value)) out.push(`${at}: should be a ${schema.format}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) out.push(`${at}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > (schema.maximum as number)) out.push(`${at}: at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number)) out.push(`${at}: more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= (schema.exclusiveMaximum as number)) out.push(`${at}: less than ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) out.push(`${at}: at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) out.push(`${at}: at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && value.some((v, i) => value.slice(0, i).some((w) => same(v, w)))) out.push(`${at}: items must be different`);
    if (schema.items) value.forEach((v, i) => out.push(...validateJson(v, schema.items as JsonSchema, root, `${at}[${i}]`, depth + 1, budget)));
  }
  if (isObject(value)) {
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) out.push(`${at}.${k}: is required`);
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) out.push(...validateJson(v, props[k]!, root, `${at}.${k}`, depth + 1, budget));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: is not allowed`);
      else if (isObject(schema.additionalProperties)) out.push(...validateJson(v, schema.additionalProperties as JsonSchema, root, `${at}.${k}`, depth + 1, budget));
    }
  }
  for (const s of (schema.allOf ?? []) as JsonSchema[]) out.push(...validateJson(value, s, root, at, depth + 1, budget));
  if (schema.anyOf && !(schema.anyOf as JsonSchema[]).some((s) => !validateJson(value, s, root, at, depth + 1, budget).length)) out.push(`${at}: matches none of the allowed forms`);
  if (schema.oneOf && (schema.oneOf as JsonSchema[]).filter((s) => !validateJson(value, s, root, at, depth + 1, budget).length).length !== 1) out.push(`${at}: should match exactly one of the allowed forms`);
  if (schema.not && !validateJson(value, schema.not as JsonSchema, root, at, depth + 1, budget).length) out.push(`${at}: matches a form that is not allowed`);
  return out.slice(0, 40);
}
