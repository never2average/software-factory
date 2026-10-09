/**
 * A stored KEY (a record field, a workbook column, an export section) as a person reads it, in the profile's words.
 *
 * Keys never move: the API, the database and the workbook keep `customerId`, `customer_id`, `accountOwner`. Where the UI
 * shows one to a person (a data-room sheet's column header, a Markdown or JSON export, a JSON / JSONL viewer, an API
 * error naming a field), it shows the key the MODEL is given for it (agent/lib/agent-vocabulary.ts: `customer_id` ->
 * `company_id`), so a person and the agent name a column the same way. The owner key, whose name still carries the
 * member's legacy word (agent/lib/legacy-member.ts), reads the profile's owner label under every profile, the
 * default included ("Account owner"). VALUES are never translated: they are data.
 *
 * A key shown AS A KEY keeps its stored name unless the profile relabels it (speakKey). A key turned into a LABEL
 * (keyLabel, headerLabel: a Markdown export's field, a table preview's column header) is a sentence the product
 * writes: the record word in it is the profile's under every profile, the default included ("Account Id").
 *
 * Only keys that name the product's own records are translated. The account and the member ("customer", the legacy member word) mean
 * one thing wherever they appear in a key; "deployment", "implementation" and "rollout" also name other things
 * (`deployment_model`, `deployment_strategy` are a platform's software-deployment settings), so a key carrying one of
 * those is translated only when it is a field of the two record areas (DOMAIN_FIELDS) or one of their ids.
 *
 * speakKey, speakKeys and jsonForPeople are the identity under the default profile.
 */
import { speakIdentifier, VOCABULARY_RELABELLED } from "../agent/lib/agent-vocabulary.ts";
import { LEGACY_MEMBER, ownerKeyLabel } from "../agent/lib/legacy-member.ts";
import { secondaryOwnerKeyLabel } from "../agent/lib/owner-keys.ts";
import { DOMAIN_FIELDS, type DomainArea } from "./deployment-profile.generated.ts";
import { domainView } from "./profile-domains.ts";
import { W } from "./ui-words.ts";

/** Base words that mean the account or the member in any key (the member by its legacy spelling, which keys keep). */
const ALWAYS = new Set(["customer", "customers", LEGACY_MEMBER.singular.toLowerCase(), LEGACY_MEMBER.plural.toLowerCase()]);

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
  // The owner key (account_owner, and the key it was stored under before drizzle/0028, which an older workbook or
  // export may still carry): the profile's owner label, under every profile.
  // The second owner's key under any of its names (ae_owner, and secondary_owner beside it,
  // drizzle/0029_neutral_secondary_owner.sql): the profile's label for it, under every profile.
  const owner = ownerKeyLabel(key, W.owner) ?? secondaryOwnerKeyLabel(key, W.secondaryOwner);
  if (owner) return owner;
  return speakKey(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** The record words a stored key spells (lower case), each as this deployment's profile calls it. */
const RECORD_WORDS: Record<string, string> = {
  customer: W.account, customers: W.accounts,
  deployment: W.deployment, deployments: W.deployments,
  implementation: W.implementation, implementations: W.implementations,
  rollout: W.rollout, rollouts: W.rollouts,
};
const titleCase = (words: string): string => words.replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => sp + c.toUpperCase());

/**
 * A label made from the product key `key`, with each record word the key still spells as stored read in the
 * profile's word: "Customer Id" -> "Account Id" where the profile calls the account an account. A word the
 * vocabulary already translated (a relabelling profile: speakKey gave `companyId`) is left as it is, and so is any
 * key that is not the product's own (`deployment_model`). The identity where the profile's word is the stored one.
 */
function withRecordWords(key: string, label: string): string {
  if (!isProductKey(key)) return label;
  return label.replace(/[A-Za-z][a-z0-9]*/g, (w) => {
    const stored = w.toLowerCase();
    if (!Object.hasOwn(RECORD_WORDS, stored)) return w;
    const word = RECORD_WORDS[stored];
    if (word === stored || speakIdentifier(stored) !== stored) return w;
    return /^[A-Z]/.test(w) ? titleCase(word) : word;
  });
}

/**
 * A stored key as a LABEL a person reads (a Markdown export's "**Account Id:**", a section heading): humanizeKey,
 * with the record word in the profile's word under every profile, the default included.
 */
export function keyLabel(key: string): string {
  return withRecordWords(key, humanizeKey(key));
}

/** Abbreviations a column header keeps in capitals, and the member's legacy word, which reads the profile's member word. */
const HEADER_ABBR: Record<string, string> = {
  id: "ID",
  url: "URL",
  api: "API",
  // A data column whose name carries the member's legacy word keeps its name in the file; only the HEADER a person
  // reads follows the deployment's word for its members ("Member" by default, "Analyst" on a research deployment).
  [LEGACY_MEMBER.singular.toLowerCase()]: W.Member,
  sla: "SLA",
  kpi: "KPI",
  poc: "POC",
  crm: "CRM",
  ai: "AI",
  arr: "ARR",
  mrr: "MRR",
  po: "PO",
  qbr: "QBR",
};

/** A header that is a KEY (`customer_id`, `deploymentId`), not the file's own words ("Customer", "Net revenue"). */
const KEY_SHAPED = /^[a-z][a-z0-9]*(?:(?:[A-Z][a-z0-9]*)+|(?:_[a-z0-9]+)+)$/;

/**
 * A table preview's column header as a person reads it: "customer_id" / "customerId" -> "Account ID" (the
 * profile's word for the record, as keyLabel), "account_owner" -> the profile's owner label. Column headers should
 * never read as raw snake_case, and a product KEY never in a record word the deployment does not use. A header
 * that is not key-shaped is the file's own text (a column a person named "Customer"): it is data, and only its
 * case is tidied.
 */
export function headerLabel(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  // The owner columns read the profile's labels ("Account owner", "Secondary owner"), as everywhere else.
  const owner = ownerKeyLabel(s, W.owner) ?? secondaryOwnerKeyLabel(s, W.secondaryOwner);
  if (owner) return owner;
  const key = KEY_SHAPED.test(s);
  const label = (key ? speakKey(s) : s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (Object.hasOwn(HEADER_ABBR, w.toLowerCase()) ? HEADER_ABBR[w.toLowerCase()] : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return key ? withRecordWords(s, label) : label;
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
const KIND_WORDS: Record<string, string> = { deployment: W.deployment, deployments: W.deployments, implementation: W.implementation, implementations: W.implementations, customer: W.account, customers: W.accounts };
/** Does this deployment call a record kind by a word other than its stored value? (Never, under a profile that keeps the stored words.) */
const KINDS_SPOKEN = Object.entries(KIND_WORDS).some(([stored, word]) => stored !== word);
/** The record area whose enum field `key` is. */
function enumArea(key: string): DomainArea | null {
  for (const area of ["deployments", "implementations"] as const) if (DOMAIN_FIELDS[area][key]?.type === "enum") return area;
  return null;
}

/**
 * A stored CODE value as a person reads it: a record kind (`containerType: deployment`) in the profile's word (under
 * every profile), an enum value (`blockerOwner: Customer`) through a relabelling profile's label. Any other value is
 * data and is returned as is.
 */
export function speakValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  // A record kind reads the profile's word under every profile (the identity where that is the stored word).
  if (KIND_KEYS.has(key) && Object.hasOwn(KIND_WORDS, value)) return KIND_WORDS[value];
  if (!VOCABULARY_RELABELLED) return value;
  const area = enumArea(key);
  return area ? domainView(area).display(key, value) : value;
}

/** Every code value in a record spoken (speakValue), at any depth; keys and `custom` untouched. */
export function speakValues<T>(value: T): T {
  if (!VOCABULARY_RELABELLED && !KINDS_SPOKEN) return value;
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
