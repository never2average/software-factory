/**
 * THE PEOPLE CATALOGUE AND ITS RULES, with no database: the deployment profile's `people` section (departments, typed
 * person attributes, their words), the checks a value must pass, and who reads what. Safe in the browser (the Control
 * Panel's person drawer) and on the server. agent/lib/people-data.ts adds the database half and says the whole model.
 */
import { PEOPLE_PROFILE, type PersonAttributeSpec } from "./deployment-profile.generated.ts";

export type AttributeValue = string | string[] | boolean;
export type PersonAttributes = Record<string, AttributeValue>;

const P = PEOPLE_PROFILE;
/** The deployment's people catalogue and its words. */
export const PEOPLE = {
  /** What a department is called ({ singular, plural }). */
  department: P.department_label,
  /** The label of the reporting line, as a person reads it ("Reports to"). */
  supervisorLabel: P.supervisor_label,
  multipleDepartments: P.multiple_departments,
  departments: P.departments,
  attributes: P.attributes as PersonAttributeSpec[],
  hasDepartments: P.departments.length > 0,
  hasAttributes: P.attributes.length > 0,
} as const;

/** The longest text attribute value, as the record areas' one-line text. */
export const TEXT_ATTRIBUTE_MAX = 500;

/** May this workspace role set departments, attributes and supervisors? The workspace's owner and its admins. */
export function canSetPeopleData(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** A department key as a person and the model read it (the key itself when the profile no longer declares it). */
export function departmentLabel(key: string): string {
  return PEOPLE.departments.find((d) => d.key === key)?.label ?? key;
}

/** Departments: a list of declared keys (one at most unless the profile allows several), kept in the profile's order. [] clears. */
export function checkDepartments(value: unknown): { value: string[] } | { error: string } {
  const word = PEOPLE.department;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { error: `${upper(word.plural)} must be a list of keys.` };
  const keys = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
  if (keys.length && !PEOPLE.hasDepartments) return { error: `This workspace declares no ${word.plural}.` };
  const unknown = keys.filter((k) => !PEOPLE.departments.some((d) => d.key === k));
  if (unknown.length) return { error: `Not ${an(word.singular)} ${word.singular} here: ${unknown.join(", ")}. Choose from ${PEOPLE.departments.map((d) => d.key).join(", ")}.` };
  if (keys.length > 1 && !PEOPLE.multipleDepartments) return { error: `A person is in one ${word.singular} at most.` };
  // Stored in the profile's order, so the same departments are always the same value.
  return { value: PEOPLE.departments.filter((d) => keys.includes(d.key)).map((d) => d.key) };
}

/**
 * An attributes patch: each key a declared attribute, its value of the attribute's type; null (or "" / [] ) clears
 * that key. Keys the patch does not name are left as stored. Returns what to set and what to clear.
 */
export function checkAttributes(value: unknown): { set: PersonAttributes; clear: string[] } | { error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "Attributes must be an object keyed by attribute." };
  const set: PersonAttributes = {};
  const clear: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const spec = PEOPLE.attributes.find((a) => a.key === key);
    if (!spec) return { error: `"${key}" is not an attribute here.${PEOPLE.hasAttributes ? ` Known: ${PEOPLE.attributes.map((a) => a.key).join(", ")}.` : ""}` };
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      clear.push(key);
      continue;
    }
    const checked = attributeValue(spec, v);
    if ("error" in checked) return checked;
    set[key] = checked.value;
  }
  return { set, clear };
}

function attributeValue(spec: PersonAttributeSpec, v: unknown): { value: AttributeValue } | { error: string } {
  const options = new Set((spec.options ?? []).map((o) => o.value));
  const optionList = [...options].join(", ");
  switch (spec.type) {
    case "boolean":
      return typeof v === "boolean" ? { value: v } : { error: `${spec.label} is yes or no (true or false).` };
    case "text": {
      if (typeof v !== "string") return { error: `${spec.label} is text.` };
      const t = v.trim();
      if (t.includes("\u0000")) return { error: `${spec.label} may not contain a NUL character.` };
      if (t.length > TEXT_ATTRIBUTE_MAX || /[\r\n]/.test(t)) return { error: `${spec.label} is one line of at most ${TEXT_ATTRIBUTE_MAX} characters.` };
      return { value: t };
    }
    case "choice":
      return typeof v === "string" && options.has(v) ? { value: v } : { error: `${spec.label} is one of ${optionList}.` };
    case "multi_choice": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !options.has(x))) return { error: `${spec.label} is a list of ${optionList}.` };
      return { value: [...new Set(v as string[])] };
    }
  }
}

/** The stored attributes with a patch applied: set keys replaced, cleared keys removed, every other key kept. */
export function mergeAttributes(stored: unknown, patch: { set: PersonAttributes; clear: string[] }): PersonAttributes {
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as PersonAttributes) } : {};
  for (const k of patch.clear) delete base[k];
  return { ...base, ...patch.set };
}

/** The stored attributes a reader is given: only declared keys holding a value of their type. */
export function declaredAttributes(stored: unknown): PersonAttributes {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: PersonAttributes = {};
  for (const spec of PEOPLE.attributes) {
    const v = (stored as Record<string, unknown>)[spec.key];
    if (v === undefined || v === null) continue;
    const ok = attributeValue(spec, v);
    if (!("error" in ok)) out[spec.key] = ok.value;
  }
  return out;
}

/** The stored departments a reader is given: the declared keys, in the profile's order. */
export function declaredDepartments(stored: unknown): string[] {
  const keys = Array.isArray(stored) ? new Set(stored.filter((k): k is string => typeof k === "string")) : new Set<string>();
  return PEOPLE.departments.filter((d) => keys.has(d.key)).map((d) => d.key);
}

/** A person's attributes for one reader: the person themself and the workspace's owner and admins; nobody else. */
export function visibleAttributes(row: { email: string; attributes?: unknown }, reader: { email?: string | null; role?: string | null }): PersonAttributes | undefined {
  const self = Boolean(reader.email) && reader.email!.toLowerCase() === row.email.toLowerCase();
  return self || canSetPeopleData(reader.role) ? declaredAttributes(row.attributes) : undefined;
}

/**
 * Is anything wrong with these reporting lines, for the people whose line changed? A line is (person -> who they
 * report to, or null). `people` is everyone of this workspace (its roster and its signed-in people). The first
 * problem as a sentence, or null:
 *   - someone reporting to themselves;
 *   - a supervisor who is not of this workspace;
 *   - a loop (a reports to b reports to ... a).
 */
export function reportingProblem(lines: ReadonlyMap<string, string | null>, people: ReadonlySet<string>, changed: Iterable<string>): string | null {
  for (const raw of changed) {
    const email = raw.toLowerCase();
    const manager = lines.get(email)?.toLowerCase() ?? null;
    if (!manager) continue;
    if (manager === email) return `${email} cannot report to themselves.`;
    if (!people.has(manager)) return `${manager} is not in this workspace: a person can report only to someone of the same workspace.`;
    const path = [email];
    const seen = new Set(path);
    let cur: string | null = manager;
    while (cur) {
      path.push(cur);
      if (cur === email) return `That would make a reporting loop: ${path.join(" → ")}.`;
      if (seen.has(cur)) break; // a loop elsewhere, already stored and not through this person: not this write's
      seen.add(cur);
      cur = lines.get(cur)?.toLowerCase() ?? null;
    }
  }
  return null;
}

const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const an = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
