/**
 * A stored KEY (a record field, a workbook column, an export section) as a person reads it, in the profile's words.
 *
 * Keys never move: the API, the database and the workbook keep `customerId`, `customer_id`, `fdeOwner`. Where the UI
 * shows one to a person (a data-room sheet's column header, a Markdown or JSON export, a JSON / JSONL viewer, an API
 * error naming a field), it shows the key the MODEL is given for it (agent/lib/agent-vocabulary.ts: `customer_id` ->
 * `company_id`), so a person and the agent name a column the same way. A key humanised into a label ("Fde Owner")
 * reads the profile's owner label instead. VALUES are never translated: they are data.
 *
 * Only keys that name the product's own records are translated. The account and the member ("customer", "FDE") mean
 * one thing wherever they appear in a key; "deployment", "implementation" and "rollout" also name other things
 * (`deployment_model`, `deployment_strategy` are a platform's software-deployment settings), so a key carrying one of
 * those is translated only when it is a field of the two record areas (DOMAIN_FIELDS) or one of their ids.
 *
 * The identity under the default profile.
 */
import { speakIdentifier, VOCABULARY_RELABELLED } from "../agent/lib/agent-vocabulary.ts";
import { DOMAIN_FIELDS, type DomainArea } from "./deployment-profile.generated.ts";
import { domainView } from "./profile-domains.ts";
import { W } from "./ui-words.ts";

/** Base words that mean the account or the member in any key. */
const ALWAYS = new Set(["customer", "customers", "fde", "fdes"]);
/** Base words that name a record area only in the areas' own keys. */
const AREA = new Set(["deployment", "deployments", "implementation", "implementations", "rollout", "rollouts"]);
/**
 * The record areas' own keys (camelCase): the areas themselves, their ids and the keys that point at them, and the
 * implementation area's `implementation…` fields. A deployment record's other `deployment…` fields
 * (`deploymentStrategy`, `deploymentModel`) describe SOFTWARE deployment and keep their word.
 */
const AREA_KEYS = new Set<string>([
  ...Object.keys(DOMAIN_FIELDS.implementations).filter((k) => /^(implementation|rollout)[A-Z]/.test(k)),
  "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts",
  "deploymentId", "deploymentIds", "rolloutId", "relatedDeploymentIds", "affectedDeploymentId",
]);

const parts = (key: string) => key.split(/_|-|(?<=[a-z0-9])(?=[A-Z])/).map((p) => p.toLowerCase()).filter(Boolean);
const camel = (key: string) => key.replace(/[_-]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Is this key one the profile's words apply to? */
function isProductKey(key: string): boolean {
  const p = parts(key);
  if (p.some((w) => AREA.has(w))) return AREA_KEYS.has(camel(key));
  return p.some((w) => ALWAYS.has(w));
}

/** `customer_id` -> `company_id`; `deploymentId` -> `coverageReportId`; `deployment_model` stays. */
export function speakKey(key: string): string {
  return VOCABULARY_RELABELLED && isProductKey(key) ? speakIdentifier(key) : key;
}

/** camelCase key -> "Words Like This", spoken: `customerId` -> "Company Id"; the owner key -> the owner label. */
export function humanizeKey(key: string): string {
  if (VOCABULARY_RELABELLED && /^fde_?owner$/i.test(key)) return W.owner;
  return speakKey(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * The profile's OWN custom fields live under `custom`: their keys and choices are the deployment's words, never the
 * base product's, so that subtree is passed through untouched (as the agent's ALWAYS_OPAQUE does).
 */
const OPAQUE = new Set(["custom"]);
const isPlain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;

/** A value with every object KEY spoken, at any depth. Values (strings, numbers) pass through as they are. */
export function speakKeys<T>(value: T): T {
  if (!VOCABULARY_RELABELLED) return value;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (isPlain(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => (OPAQUE.has(k) ? [k, v] : [speakKey(k), walk(v)])));
    return x;
  };
  return walk(value) as T;
}

/** Keys whose VALUE names one of the base product's record kinds (a TODO's container or link, an export's type). */
const KIND_KEYS = new Set(["containerType", "linkType", "type", "entity", "kind"]);
const KIND_WORDS: Record<string, string> = {
  deployment: W.deployment, deployments: W.deployments,
  implementation: W.implementation, implementations: W.implementations,
  customer: W.account, customers: W.accounts,
};
/** The record area whose enum field `key` is. */
function enumArea(key: string): DomainArea | null {
  for (const area of ["deployments", "implementations"] as const) if (DOMAIN_FIELDS[area][key]?.type === "enum") return area;
  return null;
}

/**
 * A stored CODE value as a person reads it: a record kind (`containerType: deployment`) in the profile's word, an
 * enum value (`blockerOwner: Customer`) through the profile's label. Any other value is data and is returned as is.
 */
export function speakValue(key: string, value: unknown): unknown {
  if (!VOCABULARY_RELABELLED || typeof value !== "string") return value;
  if (KIND_KEYS.has(key) && value in KIND_WORDS) return KIND_WORDS[value];
  const area = enumArea(key);
  return area ? domainView(area).display(key, value) : value;
}

/** Every code value in a record spoken (speakValue), at any depth; keys and `custom` untouched. */
export function speakValues<T>(value: T): T {
  if (!VOCABULARY_RELABELLED) return value;
  const walk = (x: unknown, key: string | null): unknown => {
    if (Array.isArray(x)) return x.map((e) => walk(e, key));
    if (isPlain(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, OPAQUE.has(k) ? v : walk(v, k)]));
    return key === null ? x : speakValue(key, x);
  };
  return walk(value, null) as T;
}

/** A record (an export, a copied bundle) as a person reads it: keys AND code values spoken; data verbatim. */
export function recordForPeople<T>(value: T): T {
  return speakKeys(speakValues(value));
}

/** JSON a person reads (a viewer, a copied export): keys spoken, values verbatim. */
export function jsonForPeople(value: unknown, indent?: number): string {
  return JSON.stringify(speakKeys(value), null, indent);
}
