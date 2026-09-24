/**
 * THE AGENT'S VOCABULARY — what the model reads, in the deployment's own words.
 *
 * The base product was written for one use: a forward-deployed engineering team managing customers. Its
 * storage keeps those names (the `customers` table, `customer_id`, the `Customers/` folder) and always will:
 * code, stored data and other systems key on them. A deployment for something else relabels the domains in its
 * profile (profiles/*.json): customers are "companies", deployments are "Coverage reports", implementation is
 * "Portfolios", FDEs are "analysts".
 *
 * Until this module, that relabelling stopped at the UI. The model was handed `list_customers`, `customer_id`
 * and `Customers/…`, a customer-management persona, and a per-turn note that "the identifiers do not change",
 * and it reasoned in the base product's words ("Customers/ is shown as Companies…"). Here the profile's words
 * reach every model-facing surface, and are translated back at the boundary so storage never moves:
 *
 *   speak(text)              prose, identifiers inside it (`customer_id`, `list_customers`, `deploymentId`),
 *                            data-room paths (`Customers/x` -> `Companies/x`) and memory scopes, in one pass
 *   speakIdentifier(key)     one identifier (a tool name, a parameter, a result key)
 *   toDisplayPath / toStoredPath    the data-room folder at the head of a path, both ways
 *   schemaForModel / inputFromModel / outputForModel   a tool's JSON Schema out, its input back, its result out
 *
 * Under the default profile every function here is the identity (VOCABULARY.relabelled is false and each
 * returns its argument untouched), which is what keeps the default deployment's prompt byte-identical.
 *
 * Pure: no eve, no `#lib/*` specifiers, so offline scripts import it directly.
 */
import { DEPLOYMENT_PROFILE, DOMAIN_FIELDS, type DeploymentProfile } from "./deployment-profile.generated.ts";
import { SUBAGENT_KEYS } from "./subagent-registry.generated.ts";

/** The data-room domains whose folder a profile may relabel, by stored name. */
const DOMAIN_KEYS = ["Customers", "Platform", "Deployments", "Solutions", "Implementation", "Tickets", "People"] as const;

/** What the base product calls things. A term is relabelled when the profile's word differs from these. */
const BASE = {
  account: { singular: "customer", plural: "customers" },
  member: { singular: "FDE", plural: "FDEs" },
  owner: "FDE owner",
  deployments: { singular: "deployment", plural: "deployments" },
  implementations: { singular: "implementation", plural: "implementations" },
  rollouts: { singular: "rollout", plural: "rollouts" },
} as const;

type Pair = { singular: string; plural: string };
type Case = "lower" | "capital" | "upper";

export interface Vocabulary {
  /** True when anything the model reads differs from the base product's words. */
  relabelled: boolean;
  /** base token (lower case) -> the profile's word(s), as the profile spells them. */
  words: Map<string, string>;
  /** Stored data-room folder -> the folder the model reads and writes (filesystem-safe form of the label). */
  folders: Map<string, string>;
  /** The reverse of `folders`. */
  storedFolders: Map<string, string>;
  /** Stored domain name -> the label people and the model read for it in prose. */
  domainLabels: Map<string, string>;
  /** "FDE owner" in the profile's words, when relabelled. */
  owner: string | null;
  /** The memory scope prefix for an account: `customer` by default, derived from the profile's word otherwise. */
  memoryPrefix: string;
  /** Keep the base product's customer-management persona in the root prompt. */
  personaBase: boolean;
  /** Base specialists this deployment does not use: not in the roster, not delegated to. */
  excludedSpecialists: string[];
  /** The specialists the model can delegate to, by the name it calls them: never translated. */
  specialists: string[];
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) || /^[A-Z]$/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A label as a folder name: "Coverage reports" -> "Coverage-reports". Letters, digits, `.`, `_`, `-` only. */
export function folderNameFor(label: string): string {
  return label.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** The words of a label as identifier parts: "Coverage report" -> ["coverage", "report"]. */
function identifierWords(label: string): string[] {
  return label.trim().toLowerCase().split(/[\s\-/]+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
}

export type VocabularyProfile = DeploymentProfile & {
  persona?: { base?: boolean };
  specialists?: { exclude?: string[] };
};

/** The vocabulary a profile implies. Exported for tests; the agent uses VOCABULARY below. */
export function createVocabulary(profile: VocabularyProfile, specialists: readonly string[] = SUBAGENT_KEYS): Vocabulary {
  const words = new Map<string, string>();
  const add = (base: Pair, to: Pair) => {
    if (sameWord(base.singular, to.singular) && sameWord(base.plural, to.plural)) return;
    words.set(base.singular.toLowerCase(), to.singular);
    words.set(base.plural.toLowerCase(), to.plural);
  };
  add(BASE.account, profile.vocabulary.account);
  add(BASE.member, profile.vocabulary.member);
  add(BASE.deployments, profile.domains.deployments.label);
  add(BASE.implementations, profile.domains.implementations.label);
  add(BASE.rollouts, profile.domains.implementations.group_label);

  const folders = new Map<string, string>();
  const domainLabels = new Map<string, string>();
  for (const key of DOMAIN_KEYS) {
    const label = profile.dataroom.domains[key]?.label ?? key;
    if (label === key) continue;
    domainLabels.set(key, label);
    const folder = folderNameFor(label);
    if (folder && folder !== key) folders.set(key, folder);
  }
  const storedFolders = new Map([...folders].map(([k, v]) => [v, k]));

  const owner = profile.vocabulary.owner !== BASE.owner && words.has("fde") ? profile.vocabulary.owner : null;
  const accountWord = identifierWords(profile.vocabulary.account.singular).join("-") || BASE.account.singular;
  const memoryPrefix = words.has("customer") && !["team", "person"].includes(accountWord) ? accountWord : BASE.account.singular;
  const relabelled = words.size > 0 || folders.size > 0 || domainLabels.size > 0;
  return {
    relabelled,
    words,
    folders,
    storedFolders,
    domainLabels,
    owner,
    memoryPrefix,
    personaBase: profile.persona?.base !== false,
    excludedSpecialists: [...(profile.specialists?.exclude ?? [])],
    specialists: specialists.filter((k) => !(profile.specialists?.exclude ?? []).includes(k)),
  };
}

export const VOCABULARY: Vocabulary = createVocabulary(DEPLOYMENT_PROFILE as VocabularyProfile);
export const VOCABULARY_RELABELLED = VOCABULARY.relabelled;
export const MEMORY_ACCOUNT_PREFIX = VOCABULARY.memoryPrefix;

// ------------------------------------------------------------------------------------------ identifiers

/** Split one identifier run into its parts: snake_case, camelCase, PascalCase, ACRONYMCase. */
function identifierParts(run: string): { parts: string[]; seps: string[] } {
  const parts: string[] = [];
  const seps: string[] = [];
  for (const [i, chunk] of run.split("_").entries()) {
    const humps = chunk.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]{2,})/).filter((p) => p !== "");
    humps.forEach((p, j) => {
      parts.push(p);
      seps.push(j === 0 && i > 0 ? "_" : "");
    });
    if (humps.length === 0 && i > 0) { parts.push(""); seps.push("_"); }
  }
  return { parts, seps };
}

function caseOf(part: string): Case {
  if (part.length > 1 && part === part.toUpperCase() && /[A-Z]/.test(part)) return "upper";
  if (/^[A-Z]/.test(part)) return "capital";
  return "lower";
}

/** A base word inside an identifier, in the identifier's own style. */
function identifierReplacement(to: string, style: Case, snake: boolean): string {
  const w = identifierWords(to);
  if (!w.length) return to;
  if (style === "upper") return w.map((x) => x.toUpperCase()).join("_");
  if (snake) return (style === "capital" ? [upperFirst(w[0]), ...w.slice(1)] : w).join("_");
  const pascal = w.map(upperFirst).join("");
  return style === "capital" ? pascal : lowerFirst(pascal);
}

/** Translate one identifier (`customer_id`, `list_customers`, `deploymentId`, `solutionFdeOwner`). */
export function speakIdentifierWith(v: Vocabulary, run: string): string {
  if (!v.relabelled || !v.words.size) return run;
  const { parts, seps } = identifierParts(run);
  if (!parts.some((p) => v.words.has(p.toLowerCase()))) return run;
  const snake = run.includes("_");
  const allUpper = run === run.toUpperCase();
  return parts
    .map((p, i) => {
      const to = v.words.get(p.toLowerCase());
      if (!to) return seps[i] + p;
      let style = caseOf(p);
      // An acronym ("FDE") inside a mixed-case identifier takes the case of its position, not its own:
      // `list_FDEs` -> `list_analysts`, `ownerFDE` -> `ownerAnalyst`.
      if (style === "upper" && !allUpper) style = snake || i === 0 ? "lower" : "capital";
      return seps[i] + identifierReplacement(to, style, snake);
    })
    .join("");
}

// ------------------------------------------------------------------------------------------------ prose

const OPEN = "\u0001";
const CLOSE = "\u0002";
const mark = (s: string) => `${OPEN}${s}${CLOSE}`;

/** True when the text before `at` ends a sentence (or a line, a heading marker, a bullet). */
function sentenceStart(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /[ \t*_`"'(]/.test(text[i])) i--;
  if (i < 0) return true;
  const c = text[i];
  if (c === "\n" || c === "." || c === "!" || c === "?" || c === "#" || c === ">" || c === "|") return true;
  if ((c === "-" || c === "•") && (i === 0 || /[\n ]/.test(text[i - 1]))) return true;
  return false;
}

/** One prose word in the profile's words, keeping the base word's case where the target allows it. */
function proseWord(v: Vocabulary, word: string, text: string, at: number): string | null {
  const key = word.toLowerCase();
  const to = v.words.get(key);
  // A domain's name standing alone ("Customers", "Implementation") is the domain: say its label.
  if (v.domainLabels.has(word)) return v.domainLabels.get(word)!;
  if (!to) return null;
  const acronym = key === "fde" || key === "fdes";
  const style: Case = acronym ? (sentenceStart(text, at) ? "capital" : "lower") : caseOf(word);
  if (style === "upper") return to.toUpperCase();
  if (style === "capital") return upperFirst(to);
  return lowerFirst(to);
}

/** Is the word at [at, at+len) written as code: in backticks, or directly followed by `[]` / `.x`? */
function inCode(text: string, at: number, len: number): boolean {
  const before = text[at - 1];
  const after = text.slice(at + len, at + len + 2);
  return (
    before === "`" || after[0] === "`" || after === "[]" || (after[0] === "." && /[A-Za-z]/.test(after[1] ?? "")) ||
    // 'deployment' | 'implementation': a quoted value, as the enum gives it (not the apostrophe of "customer's").
    (before === "'" && after[0] === "'")
  );
}

function speakPlain(v: Vocabulary, text: string, protectSpecialists = true): string {
  // Verbatim segments (verbatimWith) are already marked: every step below runs on the text between them only.
  const outside = (t: string, f: (seg: string) => string) =>
    t.split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`)).map((seg) => (seg.startsWith(OPEN) ? seg : f(seg))).join("");
  return outside(text, (seg) => speakSegment(v, seg, protectSpecialists));
}

function speakSegment(v: Vocabulary, text: string, protectSpecialists: boolean): string {
  let out = text;
  // 1. Phrases whose word-by-word rendering would read wrong.
  const memberWord = v.words.get("fde");
  if (memberWord) {
    const member = v.words.get("fde")!;
    const members = v.words.get("fdes") ?? `${member}s`;
    out = out
      .replace(/\bFDE \(forward-deployed engineer\)/g, () => mark(lowerFirst(member)))
      .replace(/\bForward-Deployed Engineering \(FDE\)/g, () => mark(upperFirst(member)))
      .replace(/\b[Ff]orward-deployed engineers\b/g, (m) => mark(m[0] === "F" ? upperFirst(members) : lowerFirst(members)))
      .replace(/\b[Ff]orward-deployed engineer\b/g, (m) => mark(m[0] === "F" ? upperFirst(member) : lowerFirst(member)));
    if (v.owner) {
      const owner = v.owner;
      out = out.replace(/\bFDE [Oo]wner\b/g, (_m, at: number, whole: string) => mark(sentenceStart(whole, at) ? upperFirst(owner) : lowerFirst(owner)));
    }
  }
  // "this deployment" is the product install, not a record: the install is the workspace to the model.
  if (v.words.has("deployment")) {
    out = out.replace(/\b([Tt])his deployment('s)?\b/g, (_m, t: string, s?: string) => mark(`${t}his workspace${s ?? ""}`));
  }
  // 2. Data-room folders at the head of a path, and memory scopes.
  if (v.folders.size) {
    // Only at the head of a path: `Uploads/x/Top Customers/y` names a person's folder, not the domain.
    out = out.replace(/(?<![A-Za-z0-9_\-\/])(Customers|Platform|Deployments|Solutions|Implementation|Tickets|People)(?=\/)/g, (m) =>
      v.folders.has(m) ? mark(v.folders.get(m)!) : m,
    );
  }
  // A memory scope takes the profile's prefix, or — when the account word is itself a scope kind (`team`,
  // `person`), where it would collide — stays `customer:`, the prefix createVocabulary kept (and the store takes).
  out = out.replace(/(?<![A-Za-z0-9_\-])customer:(?=[{\[A-Za-z0-9<'"`])/g, () => mark(`${v.memoryPrefix}:`));
  // A specialist is delegated to by its directory name. Written as code or bold, or hyphenated, it is that name
  // and stays as it is — `customer-context` spoken as `company-context` would name a tool that does not exist.
  // (scripts/gen-deployment-profile.mjs warns about a kept specialist whose name carries a relabelled word.)
  for (const key of protectSpecialists ? v.specialists : []) {
    if (!identifierParts(key.replace(/-/g, "_")).parts.some((p) => v.words.has(p.toLowerCase()))) continue;
    const k = key.replace(/[-]/g, "\\-");
    const re = key.includes("-") ? new RegExp(`(?<![A-Za-z0-9_\\-])${k}(?![A-Za-z0-9_\\-])`, "g") : new RegExp(`(?<=\`|\\*\\*)${k}(?=\`|\\*\\*)`, "g");
    out = out.replace(re, (m) => mark(m));
  }
  // 3. Every remaining word and identifier, outside what was already replaced.
  return out
    .split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))
    .map((seg, i, all) => {
      if (seg.startsWith(OPEN)) return seg;
      // offsets are per segment; sentence detection needs what came before, so rebuild the prefix.
      const prefix = all.slice(0, i).join("").replace(new RegExp(`[${OPEN}${CLOSE}]`, "g"), "");
      return seg.replace(/[A-Za-z0-9_]+/g, (run, at: number) => {
        const { parts } = identifierParts(run);
        if (!parts.some((p) => v.words.has(p.toLowerCase())) && !v.domainLabels.has(run)) return run;
        // A domain's name is the domain wherever it stands, in code or prose; the enum values say the same.
        if (v.domainLabels.has(run)) return mark(v.domainLabels.get(run)!);
        if (parts.length === 1 && !run.includes("_") && !inCode(seg, at, run.length)) {
          const w = proseWord(v, run, prefix + seg, prefix.length + at);
          return w === null ? run : mark(w);
        }
        return mark(speakIdentifierWith(v, run));
      });
    })
    .join("");
}

/** "a" / "an" before a word that was replaced, recomputed for the new word. */
function fixArticles(text: string): string {
  return text.replace(new RegExp(`\\b([Aa])(n?) (\\*\\*|\\*|_|\`|")?${OPEN}([^${CLOSE}]*)${CLOSE}`, "g"), (_m, a: string, _n: string, fmt: string | undefined, w: string) => {
    const vowel = /^[aeiou]/i.test(w) && !/^(uni|use|usu|eu|one)/i.test(w);
    return `${a}${vowel ? "n" : ""} ${fmt ?? ""}${OPEN}${w}${CLOSE}`;
  });
}

/** Text in the deployment's words. The identity under the default profile. */
export function speakWith(v: Vocabulary, text: string, protectSpecialists = true): string {
  if (!v.relabelled || !text) return text;
  return fixArticles(speakPlain(v, text, protectSpecialists)).replace(new RegExp(`[${OPEN}${CLOSE}]`, "g"), "");
}

export const speak = (text: string): string => speakWith(VOCABULARY, text);

/**
 * Text that speak() must leave exactly as it is, inside a larger text that is spoken: a profile's own words (its
 * labels, custom-field keys and choices, its briefing). Identity when nothing is relabelled.
 */
export function verbatimWith(v: Vocabulary, text: string): string {
  return v.relabelled ? mark(text) : text;
}

/**
 * A prompt without the specialists the profile excludes: a roster line (`- **key** — …`) goes, and a name in a
 * list of code-formatted names (`` `key`, ``) leaves the list. The model is never told of a specialist it cannot
 * call. Identity when nothing is excluded.
 */
export function withoutSpecialists(text: string, excluded: readonly string[]): string {
  let out = text;
  for (const key of excluded) {
    const k = key.replace(/-/g, "\\-");
    out = out
      .replace(new RegExp(`^- \\*\\*${k}\\*\\* —.*(?:\\n|$)`, "gm"), "")
      .replace(new RegExp(`\`${k}\`,\\s+`, "g"), "")
      .replace(new RegExp(`,\\s+\`${k}\`(?=[.,;:)\\s])`, "g"), "");
  }
  return out;
}

/** A prompt in the deployment's words, without the specialists it excludes. */
export function speakPromptWith(v: Vocabulary, text: string): string {
  return speakWith(v, withoutSpecialists(text, v.excludedSpecialists));
}
export const speakPrompt = (text: string): string => speakPromptWith(VOCABULARY, text);

/**
 * A value written as code (an enum value, a stored kind): `deployment` -> `coverageReport`, `customer-vpc` ->
 * `company-vpc`, `Customers` -> the domain's label. Values with spaces are prose ("Waiting on Customer").
 */
export function speakCodeWith(v: Vocabulary, value: string): string {
  // A value is never a specialist's name, so nothing in it is protected as one.
  if (!v.relabelled || /\s/.test(value)) return speakWith(v, value, false);
  return speakWith(v, `\`${value}\``, false).slice(1, -1);
}
export const speakCode = (value: string): string => speakCodeWith(VOCABULARY, value);
export const speakIdentifier = (id: string): string => speakIdentifierWith(VOCABULARY, id);

// ------------------------------------------------------------------------------------------------ paths

/** The folder the model reads for a stored one (`Customers` -> `Companies`). */
export function displayFolder(stored: string): string {
  return VOCABULARY.folders.get(stored) ?? stored;
}

/** A data-room path as the model reads it: the stored domain folder at its head swapped for the display one. */
export function toDisplayPathWith(v: Vocabulary, path: string): string {
  if (!v.folders.size) return path;
  const m = /^(\/?)([^/]+)(\/|$)/.exec(path);
  if (!m || !v.folders.has(m[2])) return path;
  return `${m[1]}${v.folders.get(m[2])}${path.slice(m[1].length + m[2].length)}`;
}

/** A path the model sent, as storage names it. Stored names are accepted as they are. */
export function toStoredPathWith(v: Vocabulary, path: string): string {
  if (!v.storedFolders.size) return path;
  const m = /^(\/?)([^/]+)(\/|$)/.exec(path);
  if (!m) return path;
  const stored = v.storedFolders.get(m[2]) ?? [...v.storedFolders].find(([d]) => d.toLowerCase() === m[2].toLowerCase())?.[1];
  if (!stored) return path;
  return `${m[1]}${stored}${path.slice(m[1].length + m[2].length)}`;
}

export const toDisplayPath = (p: string) => toDisplayPathWith(VOCABULARY, p);
export const toStoredPath = (p: string) => toStoredPathWith(VOCABULARY, p);

// ----------------------------------------------------------------------------------------------- memory

/**
 * Every stored spelling of a memory scope: a relabelled deployment writes `company:acme`, and reads its older
 * `customer:acme` rows too. `team` and `person:*` have one spelling.
 */
export function memoryScopeVariants(scope: string, v: Vocabulary = VOCABULARY): string[] {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(scope);
  if (!m || v.memoryPrefix === BASE.account.singular) return [scope];
  if (m[1] === v.memoryPrefix || m[1] === BASE.account.singular) return [`${v.memoryPrefix}:${m[2]}`, `${BASE.account.singular}:${m[2]}`];
  return [scope];
}

/** The scope as the model reads it. */
export function displayMemoryScope(scope: string, v: Vocabulary = VOCABULARY): string {
  if (v.memoryPrefix === BASE.account.singular) return scope;
  return scope.startsWith(`${BASE.account.singular}:`) ? `${v.memoryPrefix}:${scope.slice(BASE.account.singular.length + 1)}` : scope;
}

// ------------------------------------------------------------------------------------ JSON at the boundary
//
// THE RULE: translate the PRODUCT's words, never USER DATA, in either direction.
//   Product words: tool names, parameter and result KEYS, a value of a field whose schema declares it an enum,
//   the folder at the head of a data-room path in a path-typed field, a memory scope's prefix, and the text a
//   tool itself writes to the model (a top-level `error` / `next`), which is spoken by speakMessage and keeps
//   every id, name and quoted value it embeds.
//   User data: every other string — names, notes, reasons, ids, file contents, a workflow's args values and
//   return value, a profile's own custom-field keys and choices — passes through exactly as written or stored.

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The product's own identifiers the model may meet in free text: every parameter name of every tool schema
 * translated, every tool name registered, and the two record areas' field keys. A token equal to one of these is
 * translated in a message and mapped back in a free-form `args` object; nothing else is.
 */
const PRODUCT_KEYS = new Set<string>(["customerId", "customer_id", "customerIds", "customerName", "fdeOwner"]);
for (const area of Object.values(DOMAIN_FIELDS)) for (const k of Object.keys(area)) PRODUCT_KEYS.add(k);
let reverseKeys: { size: number; v: Vocabulary | null; map: Map<string, string> } = { size: -1, v: null, map: new Map() };

/** The product key the model wrote as `key` (`companyId` -> `customerId`), or undefined. */
export function productKeyFromModel(v: Vocabulary, key: string): string | undefined {
  if (reverseKeys.size !== PRODUCT_KEYS.size || reverseKeys.v !== v) {
    const map = new Map<string, string>();
    for (const k of PRODUCT_KEYS) {
      const t = speakIdentifierWith(v, k);
      if (t !== k) map.set(t, k);
    }
    reverseKeys = { size: PRODUCT_KEYS.size, v, map };
  }
  return reverseKeys.map.get(key);
}

/**
 * Per FIELD, the enum values its schema declares, base -> as the model reads them. A stored value is translated
 * on the way out only in a field with this name ("Waiting on Customer" in `ticketStatus`, never in `summary`).
 */
const FIELD_ENUMS = new Map<string, Map<string, string>>();

/** What translating one tool's input schema learned, per translated node (WeakMaps keyed by the node). */
export interface SchemaMap {
  root: unknown;
  keysBack: WeakMap<object, Map<string, string>>;
  enumsBack: WeakMap<object, Map<string, string>>;
}

/** Enum/const values a schema node declares, directly or in an anyOf/oneOf branch or array items. */
function declaredValues(node: unknown, out: string[] = []): string[] {
  if (!isRecord(node)) return out;
  if (Array.isArray(node.enum)) for (const e of node.enum) if (typeof e === "string") out.push(e);
  if (typeof node.const === "string") out.push(node.const);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) for (const b of node[k] as unknown[]) declaredValues(b, out);
  if (node.items) declaredValues(node.items, out);
  return out;
}

/**
 * A tool's input JSON Schema in the deployment's words: property names, `required`, descriptions, titles, and
 * the enum/const values of enum fields. Returns what inputFromModel needs to undo it, node by node.
 */
export function schemaForModelWith(v: Vocabulary, schema: unknown): { schema: unknown; map: SchemaMap } {
  const map: SchemaMap = { root: schema, keysBack: new WeakMap(), enumsBack: new WeakMap() };
  if (!v.relabelled) return { schema, map };
  const walk = (node: unknown, field: string | null): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, field));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    const enumsBack = new Map<string, string>();
    const value = (x: unknown): unknown => {
      if (typeof x !== "string") return x;
      const t = speakCodeWith(v, x);
      if (t !== x) {
        const prior = enumsBack.get(t);
        if (prior !== undefined && prior !== x) throw new Error(`agent vocabulary: enum values "${prior}" and "${x}" would both read "${t}"`);
        enumsBack.set(t, x);
        if (field !== null) {
          if (!FIELD_ENUMS.has(field)) FIELD_ENUMS.set(field, new Map());
          FIELD_ENUMS.get(field)!.set(x, t);
        }
      }
      return t;
    };
    for (const [k, val] of Object.entries(node)) {
      if (k === "properties" && isRecord(val)) {
        const props: Record<string, unknown> = {};
        const keysBack = new Map<string, string>();
        for (const [name, sub] of Object.entries(val)) {
          PRODUCT_KEYS.add(name);
          const t = speakIdentifierWith(v, name);
          if (t in props || (t !== name && t in val)) throw new Error(`agent vocabulary: "${name}" would read "${t}", which is already a parameter here`);
          if (t !== name) keysBack.set(t, name);
          props[t] = walk(sub, name);
        }
        out[k] = props;
        map.keysBack.set(props, keysBack);
      } else if (k === "required" && Array.isArray(val)) {
        out[k] = val.map((r) => (typeof r === "string" ? speakIdentifierWith(v, r) : r));
      } else if ((k === "description" || k === "title" || k === "pattern") && typeof val === "string") {
        out[k] = speakWith(v, val);
      } else if (k === "enum" && Array.isArray(val)) {
        out[k] = val.map(value);
      } else if (k === "const" && typeof val === "string") {
        out[k] = value(val);
      } else if (k === "default" && typeof val === "string" && Array.isArray(node.enum)) {
        out[k] = value(val);
      } else if (k === "examples" && Array.isArray(val)) {
        out[k] = val.map((e) => (typeof e === "string" ? speakWith(v, e) : e));
      } else if (k === "items" || k === "additionalProperties" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "not") {
        out[k] = walk(val, k === "additionalProperties" ? null : field);
      } else {
        out[k] = walk(val, null);
      }
    }
    if (enumsBack.size) map.enumsBack.set(out, enumsBack);
    return out;
  };
  map.root = walk(schema, null);
  return { schema: map.root, map };
}

/** Which keys of a tool's input are what, for translating the model's input back. */
export interface InputRoles {
  /** Values passed through untouched, however deep (file content, a remote tool's arguments). */
  opaque?: ReadonlySet<string>;
  /** DATA-ROOM path fields: the display folder at the head goes back to the stored one. Nothing else is a path. */
  paths?: ReadonlySet<string>;
  /** Free-form objects whose KEYS are product keys the model was taught (`args` of trigger_workflow). */
  argsKeys?: ReadonlySet<string>;
}

/** The anyOf/oneOf branch a value belongs to. */
function branchFor(node: Record<string, unknown>, value: unknown, map: SchemaMap): Record<string, unknown> {
  const branches = ([] as unknown[]).concat(node.anyOf ?? [], node.oneOf ?? []).filter(isRecord) as Record<string, unknown>[];
  if (!branches.length) return node;
  const typeOf = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x === "number" ? (Number.isInteger(x) ? "integer" : "number") : typeof x);
  if (typeof value === "string") {
    const byEnum = branches.find((b) => map.enumsBack.get(b)?.has(value) || (Array.isArray(b.enum) && b.enum.includes(value)));
    if (byEnum) return byEnum;
  }
  const t = typeOf(value);
  return branches.find((b) => b.type === t || (Array.isArray(b.type) && b.type.includes(t)) || (t === "integer" && b.type === "number") || (t === "object" && (b.properties || b.additionalProperties))) ?? node;
}

/**
 * The model's input, as the base tool takes it, walked WITH its schema: parameter names back; a value back to
 * its base enum value only where that field's schema declares the enum; a data-room path back to its stored
 * folder only in a path field; `args`-like objects' keys back to product keys. Every other string is data and is
 * passed through as the model wrote it.
 */
export function inputFromModelWith(v: Vocabulary, input: unknown, map: SchemaMap, roles: InputRoles = {}): unknown {
  if (!v.relabelled) return input;
  const opaque = roles.opaque ?? new Set();
  const paths = roles.paths ?? new Set();
  const argsKeys = roles.argsKeys ?? new Set();
  const walk = (x: unknown, node: unknown, key: string | null): unknown => {
    if (key !== null && opaque.has(key)) return x;
    let n = isRecord(node) ? branchFor(node, x, map) : undefined;
    if (Array.isArray(x)) {
      const items = n?.items;
      return x.map((e, i) => walk(e, Array.isArray(items) ? items[i] : items, key));
    }
    if (isRecord(x)) {
      if (key !== null && argsKeys.has(key)) {
        return Object.fromEntries(Object.entries(x).map(([k, val]) => [productKeyFromModel(v, k) ?? k, val]));
      }
      const props = isRecord(n?.properties) ? (n!.properties as Record<string, unknown>) : {};
      const keysBack = isRecord(n?.properties) ? map.keysBack.get(n!.properties as object) : undefined;
      const extra = isRecord(n?.additionalProperties) ? n!.additionalProperties : undefined;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        const base = keysBack?.get(k) ?? k;
        out[base] = walk(val, k in props ? props[k] : extra, base);
      }
      return out;
    }
    if (typeof x === "string") {
      const e = n ? map.enumsBack.get(n)?.get(x) : undefined;
      if (e !== undefined) return e;
      return key !== null && paths.has(key) ? toStoredPathWith(v, x) : x;
    }
    return x;
  };
  return walk(input, map.root, null);
}

/** Result fields that hold a data-room path (or a list of them). Only their FIRST segment is ever rewritten. */
const PATH_OUT_KEYS = new Set(["path", "paths", "prefix", "workbook", "dataroomPath", "documentPath"]);
/** Top-level result fields that are the tool's own words to the model. Spoken by speakMessage. */
const MESSAGE_OUT_KEYS = new Set(["error", "next"]);
/** Values always passed through as stored: a profile's own custom fields (its keys and choices are its words). */
const ALWAYS_OPAQUE = new Set(["custom"]);

/**
 * A result as the model reads it: keys in the deployment's words; a stored value translated only where its
 * field declares that enum; a data-room path's first segment; a memory scope's prefix; the tool's own message.
 * Everything else — names, notes, reasons, record text, file content — exactly as stored.
 */
export function outputForModelWith(
  v: Vocabulary,
  value: unknown,
  opaque: ReadonlySet<string> = new Set(),
  spoken: ReadonlySet<string> = new Set(),
): unknown {
  if (!v.relabelled) return value;
  const text = (s: string, key: string | null, depth: number): string => {
    if (key === null) return s;
    if (spoken.has(key)) return speakCodeWith(v, s);
    if (depth === 1 && MESSAGE_OUT_KEYS.has(key)) return speakMessageWith(v, s);
    if (PATH_OUT_KEYS.has(key)) return toDisplayPathWith(v, s);
    const e = FIELD_ENUMS.get(key)?.get(s);
    if (e !== undefined) return e;
    if (key === "scope") return displayMemoryScope(s, v);
    if (key === "container") {
      // A TODO's container, `containerType:label`: the type is an enum value, the label is data.
      const at = s.indexOf(":");
      const kind = at > 0 ? FIELD_ENUMS.get("containerType")?.get(s.slice(0, at)) : undefined;
      return kind !== undefined ? `${kind}${s.slice(at)}` : s;
    }
    return s;
  };
  const walk = (x: unknown, key: string | null, depth: number): unknown => {
    if (key !== null && (opaque.has(key) || ALWAYS_OPAQUE.has(key))) return x;
    if (Array.isArray(x)) return x.map((e) => walk(e, key, depth));
    if (isRecord(x)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) out[opaque.has(k) || ALWAYS_OPAQUE.has(k) ? k : speakIdentifierWith(v, k)] = walk(val, k, depth + 1);
      // A table ({ columns, rows }, e.g. a workbook sheet): a cell is its column's field, so a stored enum value is
      // translated exactly as it would be in a record (`blocker_owner` -> the `blockerOwner` enum); nothing else.
      if (Array.isArray(x.columns) && Array.isArray(x.rows) && !opaque.has("rows")) {
        const fields = (x.columns as unknown[]).map((c) => (typeof c === "string" ? c.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase()) : ""));
        out[speakIdentifierWith(v, "rows")] = (x.rows as unknown[]).map((row) =>
          Array.isArray(row) ? row.map((cell, i) => (typeof cell === "string" ? FIELD_ENUMS.get(fields[i])?.get(cell) ?? cell : cell)) : row,
        );
      }
      return out;
    }
    return typeof x === "string" ? text(x, key, depth) : x;
  };
  return walk(value, null, 0);
}

// ------------------------------------------------------------------------------------------------ messages

/** A known product identifier or tool name, as a whole token. */
function isProductToken(token: string): boolean {
  return PRODUCT_KEYS.has(token) || MODEL_NAMES.has(token);
}

const PATH_HEAD = /^(\/?)(Customers|Platform|Deployments|Solutions|Implementation|Tickets|People)\//;

/**
 * A message the product writes to the model (a tool's `error` / `next`, a thrown error), in the deployment's
 * words WITHOUT touching the data it embeds:
 *   - a quoted span ("…", '…', `…`) is data unless it is exactly a product key or tool name, or a data-room path
 *     (then only its first segment moves);
 *   - an unquoted token is translated only when it is a product key / tool name, a data-room path, or a single
 *     base word standing alone — not inside a hyphenated or dotted id ("acme-deployments"), and not a capitalised
 *     word beside another capitalised word (a name: "Deployment Holdings").
 * Error text from a run route lists the keys a script reads; those are product keys, translated the same way the
 * model's `args` are mapped back, so the refusal names what the model actually sent.
 */
export function speakMessageWith(v: Vocabulary, text: string): string {
  if (!v.relabelled || !text) return text;
  const token = (t: string): string => {
    if (isProductToken(t)) return speakIdentifierWith(v, t);
    if (PATH_HEAD.test(t)) return toDisplayPathWith(v, t);
    return t;
  };
  const out: string[] = [];
  let i = 0;
  const words: { at: number; w: string }[] = [];
  const plain = (seg: string) => {
    const parts = seg.split(/(\s+)/);
    for (const p of parts) {
      if (!p || /^\s+$/.test(p)) { out.push(p); continue; }
      const m = /^([(\[{]*)([\s\S]*?)((?:'s)?[)\]},.;:!?]*)$/.exec(p)!;
      const [, lead, core, trail] = m;
      // "customer-facing": an English compound, not an id — its base word is prose.
      const compound = /^(customers?|Customers?|FDEs?|deployments?|Deployments?)-(facing|owned|side|specific|level|wide|led|managed)$/.exec(core);
      if (compound) {
        words.push({ at: out.length, w: compound[1] });
        out.push(`${lead}\u0000${compound[1]}\u0000-${compound[2]}${trail}`);
        continue;
      }
      // A plain lower-case word ("deployments") is prose even though a parameter shares its spelling.
      if (/^[a-z]+$/.test(core) && v.words.has(core)) {
        words.push({ at: out.length, w: core });
        out.push(`${lead}\u0000${core}\u0000${trail}`);
        continue;
      }
      let t = token(core);
      if (t === core && /^[A-Za-z]+$/.test(core) && (v.words.has(core.toLowerCase()) || v.domainLabels.has(core))) {
        words.push({ at: out.length, w: core });
        out.push(`${lead}\u0000${core}\u0000${trail}`);
        continue;
      }
      out.push(`${lead}${t}${trail}`);
    }
  };
  while (i < text.length) {
    const c = text[i];
    const prev = text[i - 1];
    const opensQuote = c === '"' || c === "`" || (c === "'" && (i === 0 || !/[A-Za-z0-9]/.test(prev ?? "")));
    if (opensQuote) {
      let j = text.indexOf(c, i + 1);
      if (c === "'") while (j > 0 && /[A-Za-z0-9]/.test(text[j + 1] ?? "")) j = text.indexOf(c, j + 1);
      if (j > i && !text.slice(i + 1, j).includes("\n")) {
        const inner = text.slice(i + 1, j);
        out.push(c + token(inner) + c);
        i = j + 1;
        continue;
      }
    }
    let j = i + 1;
    while (j < text.length && !(text[j] === '"' || text[j] === "`" || (text[j] === "'" && !/[A-Za-z0-9]/.test(text[j - 1] ?? "")))) j++;
    plain(text.slice(i, j));
    i = j;
  }
  // Standalone base words: prose, unless part of a capitalised name.
  // A quoted neighbour is a value, not part of the name ("Customer "Acme" not found" is prose + a value).
  const capital = (s: string | undefined) => !!s && /^\(*[A-Z][a-z]/.test(s);
  const tokenAt = (k: number) => out[k]?.replace(/\u0000/g, "");
  for (const { at, w } of words) {
    let prevTok: string | undefined;
    for (let k = at - 1; k >= 0; k--) if (out[k] && !/^\s+$/.test(out[k])) { prevTok = tokenAt(k); break; }
    let nextTok: string | undefined;
    for (let k = at + 1; k < out.length; k++) if (out[k] && !/^\s+$/.test(out[k])) { nextTok = tokenAt(k); break; }
    const isName = /^[A-Z]/.test(w) && (capital(nextTok) || (capital(prevTok) && !/[.!?:]$/.test(prevTok ?? "")));
    const to = isName ? w : proseWord(v, w, out.slice(0, at).join("").replace(/\u0000/g, ""), out.slice(0, at).join("").replace(/\u0000/g, "").length + out[at].indexOf("\u0000")) ?? w;
    out[at] = out[at].replace(`\u0000${w}\u0000`, to);
  }
  return out.join("");
}
export const speakMessage = (text: string): string => speakMessageWith(VOCABULARY, text);

/** A stored value of `field` as the model was told it (the field's declared enum), else the value unchanged. */
export function speakFieldValue(field: string, value: string): string {
  return FIELD_ENUMS.get(field)?.get(value) ?? value;
}

export const schemaForModel = (schema: unknown) => schemaForModelWith(VOCABULARY, schema);
export const inputFromModel = (input: unknown, map: SchemaMap, roles?: InputRoles) => inputFromModelWith(VOCABULARY, input, map, roles);
export const outputForModel = (value: unknown, opaque?: ReadonlySet<string>, spoken?: ReadonlySet<string>) => outputForModelWith(VOCABULARY, value, opaque, spoken);

// ------------------------------------------------------------------------------------------- tool names

/** base tool name -> the name the model calls it by. Filled by modelFacing() as tools are defined. */
const MODEL_NAMES = new Map<string, string>();

/** The name the model calls a base tool by (`list_customers` -> `list_companies`). */
export function modelToolName(base: string): string {
  return MODEL_NAMES.get(base) ?? speakIdentifier(base);
}

/** The base name of a tool the model knows by `name`. */
export function baseToolName(name: string): string {
  for (const [base, model] of MODEL_NAMES) if (model === name) return base;
  return name;
}

/**
 * Which of `bases` the tool called `name` is — for code outside the agent (the web app reading a transcript)
 * that knows the base names and must recognise their model-facing ones. Returns `name` when none matches.
 */
export function baseNameAmong(name: string, bases: Iterable<string>, v: Vocabulary = VOCABULARY): string {
  for (const b of bases) if (b === name || speakIdentifierWith(v, b) === name) return b;
  return name;
}

/** A field of a result the model was given, read by its BASE key (`field(out, "customers")` finds `companies`). */
export function fieldOf(obj: Record<string, unknown> | null | undefined, baseKey: string, v: Vocabulary = VOCABULARY): unknown {
  if (!obj) return undefined;
  return baseKey in obj ? obj[baseKey] : obj[speakIdentifierWith(v, baseKey)];
}

/** Record a tool under its model-facing name; two tools may not end up with one name. */
export function registerModelToolName(base: string): string {
  const name = speakIdentifier(base);
  for (const [other, taken] of MODEL_NAMES) {
    if (other !== base && (taken === name || other === name)) {
      throw new Error(`agent vocabulary: the tool "${base}" would be called "${name}", which is already "${other}"'s name. Change the profile's wording.`);
    }
  }
  MODEL_NAMES.set(base, name);
  return name;
}
