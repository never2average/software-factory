/**
 * A small JSON Schema (draft 2020-12) checker for the keywords scripts/schemas/*.schema.json use, so the profile
 * generator stays standard-library only: type (incl. "integer" and lists of types), enum, const, properties,
 * additionalProperties (false or a schema), required, items, minItems, maxItems, minLength, maxLength, pattern,
 * minimum, maximum, anyOf and local $ref ("#/$defs/<name>"). "$comment", "$id", "$schema" and "default" are
 * documentation. Any other keyword in a schema is refused, so a schema can never say more than is checked.
 *
 * validate(schema, value, path) -> a list of { path, message }: the first problem on each branch, in document order.
 */
const KNOWN = new Set([
  "$schema", "$id", "$comment", "$defs", "$ref", "type", "enum", "const", "properties", "additionalProperties",
  "required", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "anyOf", "default",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const fits = (t, v) => {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
};
const show = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/** Every keyword a schema (and its sub-schemas) uses must be one this file checks. */
export function assertSupported(schema, at = "#") {
  if (!isObj(schema)) return;
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`${at}: the schema keyword "${k}" is not supported by scripts/lib/json-schema.mjs`);
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" || k === "$defs") for (const [n, s] of Object.entries(v)) assertSupported(s, `${at}/${k}/${n}`);
    else if (k === "items" || (k === "additionalProperties" && isObj(v))) assertSupported(v, `${at}/${k}`);
    else if (k === "anyOf") v.forEach((s, i) => assertSupported(s, `${at}/anyOf/${i}`));
  }
}

export function validate(schema, value, path = "", root = schema) {
  const problems = [];
  const s = schema.$ref ? resolve(root, schema.$ref) : schema;
  if (s.$ref) return validate(s, value, path, root);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => fits(t, value))) {
      return [{ path, message: `must be ${types.map((t) => (t === "integer" ? "a whole number" : t === "object" ? "an object" : t === "array" ? "a list" : t === "null" ? "null" : `a ${t}`)).join(" or ")} (it is ${show(value)})` }];
    }
  }
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) return [{ path, message: `must be ${show(s.const)}` }];
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return [{ path, message: `${show(value)} is not one of ${s.enum.map(show).join(", ")}` }];
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) problems.push({ path, message: s.minLength === 1 ? "must not be empty" : `must be at least ${s.minLength} characters` });
    if (s.maxLength !== undefined && value.length > s.maxLength) problems.push({ path, message: `must be at most ${s.maxLength} characters (it has ${value.length})` });
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value)) problems.push({ path, message: `${show(value)} does not match ${s.pattern}` });
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) problems.push({ path, message: `must be at least ${s.minimum}` });
    if (s.maximum !== undefined && value > s.maximum) problems.push({ path, message: `must be at most ${s.maximum}` });
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) problems.push({ path, message: s.minItems === 1 ? "must list at least one" : `must list at least ${s.minItems}` });
    if (s.maxItems !== undefined && value.length > s.maxItems) problems.push({ path, message: `may list at most ${s.maxItems} (it lists ${value.length})` });
    if (s.items) value.forEach((v, i) => problems.push(...validate(s.items, v, `${path}[${i}]`, root)));
  }
  if (isObj(value)) {
    for (const r of s.required ?? []) if (!(r in value)) problems.push({ path, message: `needs "${r}"` });
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (s.properties && k in s.properties) problems.push(...validate(s.properties[k], v, here, root));
      else if (s.additionalProperties === false) problems.push({ path: here, message: `unknown key (${s.properties ? `known: ${Object.keys(s.properties).filter((p) => p !== "$comment").join(", ")}` : "none are allowed here"})` });
      else if (isObj(s.additionalProperties)) problems.push(...validate(s.additionalProperties, v, here, root));
    }
  }
  if (s.anyOf) {
    const branches = s.anyOf.map((b) => validate(b, value, path, root));
    if (!branches.some((b) => b.length === 0)) {
      // The branch whose type matched says the most; otherwise name what was expected.
      const typed = branches.find((b) => b.length && !b[0].message.startsWith("must be "));
      problems.push(...(typed ?? [{ path, message: `${show(value)} matches none of the allowed forms` }]));
    }
  }
  return problems;
}

function resolve(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`json-schema: unresolvable $ref ${ref}`);
  return root.$defs[m[1]];
}
