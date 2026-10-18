/**
 * The deployment profile's `people` section, checked at build (scripts/gen-deployment-profile.mjs): the departments a
 * person may be in, and the typed attributes a workspace's owner records about each person. Both are the DEPLOYMENT's
 * catalogue, never a workspace's: a workflow step routed by `{ department: "ops" }` or by an attribute value must find
 * the same key in every workspace (docs/DEPLOYMENT_PROFILE.md, "people"; docs/WORKFLOW_ENGINE.md, phase 4).
 *
 * Attribute types are the workflow engine's four (dsl/types.ts USER_ATTRIBUTE_TYPES): choice, multi_choice, boolean,
 * text. A key may not be a field the directory sends with every person anyway (RESERVED_PERSON_KEYS), so an attribute
 * can never shadow the person's id, role, department or reporting line.
 *
 * Returns the first problem as a sentence, or null. Pure.
 */
export const ATTRIBUTE_TYPES = ["choice", "multi_choice", "boolean", "text"];
/**
 * Fields a person carries in the directory whatever the profile says (agent/lib/people-directory.ts builds them), and
 * the engine's own directory fields: a profile attribute under one of these names would be two values for one key.
 * Any key ending in `_ids` is the engine's grouping-id form and is refused too.
 */
export const RESERVED_PERSON_KEYS = [
  "id", "organization_id", "email", "name", "role", "roles", "team",
  "department", "departments", "business_unit", "business_units",
  "supervisor", "manager", "manager_email", "reporting_managers", "reportees", "employment_status_active",
];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const word = (w) => typeof w === "string" && w.trim() !== "" && w === w.trim() && w.length <= 60 && !/[{}<>\n]/.test(w);

export function peopleProblem(p) {
  const at = "people";
  if (!isObj(p)) return `${at} must be an object`;
  for (const k of Object.keys(p)) {
    if (!["department_label", "supervisor_label", "multiple_departments", "departments", "attributes"].includes(k)) return `${at}.${k}: unknown key`;
  }
  const dl = p.department_label;
  if (!isObj(dl) || Object.keys(dl).some((n) => n !== "singular" && n !== "plural") || !word(dl.singular) || !word(dl.plural)) {
    return `${at}.department_label must be { "singular": …, "plural": … }, each a word or short phrase of at most 60 characters (no braces or line breaks), for example { "singular": "department", "plural": "departments" }`;
  }
  if (!word(p.supervisor_label)) return `${at}.supervisor_label must be a word or short phrase of at most 60 characters, for example "Reports to"`;
  if (typeof p.multiple_departments !== "boolean") return `${at}.multiple_departments must be true (a person may be in several) or false (in one at most)`;
  if (!Array.isArray(p.departments) || p.departments.length > 200) return `${at}.departments must be a list of at most 200 { "key", "label" } (empty for none)`;
  const seen = new Set();
  for (const [i, d] of p.departments.entries()) {
    const here = `${at}.departments[${i}]`;
    if (!isObj(d) || Object.keys(d).some((k) => k !== "key" && k !== "label")) return `${here} must be { "key", "label" }`;
    if (typeof d.key !== "string" || !KEY.test(d.key)) return `${here}.key must be lower-case letters, digits and _ (at most 40, a letter first), for example "operations"`;
    if (!word(d.label)) return `${here}.label must be a word or short phrase of at most 60 characters`;
    if (seen.has(d.key)) return `${here}.key: "${d.key}" is declared twice`;
    seen.add(d.key);
  }
  if (!Array.isArray(p.attributes) || p.attributes.length > 50) return `${at}.attributes must be a list of at most 50 attributes (empty for none)`;
  const keys = new Set();
  for (const [i, a] of p.attributes.entries()) {
    const here = `${at}.attributes[${i}]`;
    if (!isObj(a)) return `${here} must be { "key", "label", "type", "options"?, "help"? }`;
    for (const k of Object.keys(a)) if (!["key", "label", "type", "options", "help"].includes(k)) return `${here}.${k}: unknown key (an attribute takes key, label, type, options, help)`;
    if (typeof a.key !== "string" || !KEY.test(a.key)) return `${here}.key must be lower-case letters, digits and _ (at most 40, a letter first)`;
    if (RESERVED_PERSON_KEYS.includes(a.key) || a.key.endsWith("_ids")) return `${here}.key: "${a.key}" is a field every person already carries in the directory; choose another key`;
    if (keys.has(a.key)) return `${here}.key: "${a.key}" is declared twice`;
    keys.add(a.key);
    if (!word(a.label)) return `${here}.label must be a word or short phrase of at most 60 characters`;
    if (!ATTRIBUTE_TYPES.includes(a.type)) return `${here}.type: ${JSON.stringify(a.type)} is not a type. Use one of ${ATTRIBUTE_TYPES.join(", ")}`;
    if (a.help !== undefined && (typeof a.help !== "string" || a.help.length > 300 || /[{}<>]/.test(a.help))) return `${here}.help must be a sentence of at most 300 characters`;
    const choice = a.type === "choice" || a.type === "multi_choice";
    if (!choice) {
      if (a.options !== undefined) return `${here}.options: a ${a.type} attribute takes no options`;
      continue;
    }
    if (!Array.isArray(a.options) || a.options.length === 0 || a.options.length > 100) return `${here}.options: a ${a.type} attribute needs 1 to 100 options, each { "value", "label" }`;
    const values = new Set();
    for (const [j, o] of a.options.entries()) {
      if (!isObj(o) || Object.keys(o).some((k) => k !== "value" && k !== "label")) return `${here}.options[${j}] must be { "value", "label" }`;
      if (typeof o.value !== "string" || !KEY.test(o.value)) return `${here}.options[${j}].value must be lower-case letters, digits and _ (at most 40, a letter first)`;
      if (!word(o.label)) return `${here}.options[${j}].label must be a word or short phrase of at most 60 characters`;
      if (values.has(o.value)) return `${here}.options[${j}].value: "${o.value}" is declared twice`;
      values.add(o.value);
    }
  }
  return null;
}
