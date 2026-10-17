#!/usr/bin/env node
/**
 * SYNC THE VENDORED WORKFLOW ENGINE (lib/workflow-engine/; docs/WORKFLOW_ENGINE.md).
 *
 * The workflow engine is vendored, never edited by hand: this script is the only writer of lib/workflow-engine/.
 * It copies EXACTLY the files listed in FILES from an engine checkout at the pinned commit, applies the declared local
 * patches (below: nothing else), puts a one-line header on each file pointing to UPSTREAM.json, and records in
 * lib/workflow-engine/UPSTREAM.json the source (a neutral label, the engine's path inside its repository, the
 * commit), every file with the sha256 of its upstream bytes and of its vendored bytes, and every patch applied. A file
 * the list does not name is removed.
 *
 * WHERE THE CHECKOUT IS never appears in this repository: it is the operator's, on the operator's machine (like the
 * mold's own source address). Pass it as --from, or set WORKFLOW_ENGINE_SOURCE.
 *
 * The local patches, each declared here with its reason and recorded per file:
 *
 *   1. import-specifiers   a relative import gains `.ts` (`from './mongo'` -> `from './mongo.ts'`), so the files load
 *                          under `node --experimental-strip-types`, the mold's convention for scripts and tests.
 *   2. erasable-syntax     the two TypeScript parameter properties upstream has (WorkloadBalancer's constructor,
 *                          PersistenceConflictError's `readonly code`) become a field plus an assignment, on the same
 *                          line. Node's strip-only mode refuses a parameter property (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX),
 *                          so without it balancer.ts and store.ts do not load at all. Behaviour is identical.
 *   3. neutral-words       whole comment lines (and the spec's title and $id lines) that name the upstream platform or
 *                          company, an example taken from a client, or a line of business are replaced by neutral lines.
 *                          Comments and documentation only: no identifier, no value code reads. The ORIGINAL text is not
 *                          stored anywhere in this repository, in any reversible form: a patch names the line(s) it
 *                          replaces by the salted sha256 of their text (NEUTRAL_SALT), and only a sync from the upstream
 *                          checkout, which holds the originals, can find and replace them. The three directory field
 *                          names in PLATFORM_USER_ATTRIBUTES are the one exception, kept verbatim (KEPT_IDENTIFIERS:
 *                          upstream's wire contract; renaming them would change what validateWorkflow accepts).
 *
 * Every patch has an exact count, checked at sync time: the sync fails when upstream no longer holds the text (or the
 * hashed lines) a patch was written for, so a refresh never applies a patch to text it was not written for.
 *
 * --check (CI; no upstream checkout there) verifies, offline: every vendored file's bytes are the recorded vendored
 * sha256 and carry the header; the recorded patch list is exactly what this script declares (import patches: their
 * results present at their counts, and no relative import left without `.ts`); UPSTREAM.json is byte for byte what this
 * script writes for that record; and the domain-word gate. With --from (or WORKFLOW_ENGINE_SOURCE) it also re-derives
 * every file from the upstream checkout and requires the recorded upstream sha256 and the vendored bytes.
 *
 * The domain-word gate, run by both modes: no file under lib/workflow-engine/ (UPSTREAM.json included) holds a
 * client, bank, company, product or line-of-business word (DOMAIN_WORD_SHA256), except the kept identifiers, each at its
 * exact count.
 *
 *   node scripts/sync-workflow-engine.mjs --from <engine checkout> [--commit <sha>] [--path <engine path in its repo>]
 *        write (the checkout must be at the pinned commit, or at --commit, which becomes the new pin)
 *   node scripts/sync-workflow-engine.mjs --check [--from <engine checkout>]
 *        verify; with --from (or WORKFLOW_ENGINE_SOURCE), also re-derive from the checkout
 *   --root <dir>   another checkout of this repository
 *
 * <engine checkout> is the engine project directory itself (the one holding dsl/ and engine/), inside a git checkout of
 * the upstream repository. Standard library only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { stringifyRecorded } from "./lib/json-text.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = opt("--root") ?? new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR_REL = "lib/workflow-engine";
const VENDOR = join(ROOT, VENDOR_REL);
const RECORD = join(VENDOR, "UPSTREAM.json");

/**
 * The vendored files, by upstream path (relative to the engine project directory). The vendored path is the same path
 * under lib/workflow-engine/, so every relative import resolves exactly as it does upstream.
 *
 * `why` says what each is for. The last three are the dependency closure of the kept files, not a choice: core/identity.ts
 * holds DEFAULT_ORGANIZATION_ID (init, balancer, evaluator, rbac and store import it), and the in-memory store imports
 * core/summary.ts (projectSummaryFields, at runtime) and the IdentitySnapshot type from integrations/identity.ts. All
 * three are pure (no network, no database); the sync refuses a relative import that does not resolve to a listed file.
 */
export const FILES = [
  { path: "dsl/spec.json", why: "the DSL's JSON Schema (Draft 2020-12) contract" },
  { path: "dsl/types.ts", why: "the DSL's TypeScript model" },
  { path: "dsl/validate.ts", why: "the DSL's semantic validator (pure; needs no schema library)" },
  { path: "engine/src/core/mongo.ts", why: "the Mongo-style query matcher and the $object substitution" },
  { path: "engine/src/core/init.ts", why: "materialize an instance from a definition (init)" },
  { path: "engine/src/core/diff.ts", why: "the rule engine: diff rules, guards, cohorts, relative assignment, transitions" },
  { path: "engine/src/core/state.ts", why: "the instance and step state types and setters" },
  { path: "engine/src/core/balancer.ts", why: "least_loaded and round_robin assignment" },
  { path: "engine/src/core/evaluator.ts", why: "the prompt evaluator seam and the in-memory directory" },
  { path: "engine/src/core/rbac.ts", why: "role scopes, grants, reporting matrix, canReassign" },
  { path: "engine/src/core/diagram.ts", why: "Mermaid rendering of a definition" },
  { path: "engine/src/core/store.ts", why: "the WorkflowStore interface and the in-memory store (tests only)" },
  { path: "engine/src/core/identity.ts", why: "dependency closure: DEFAULT_ORGANIZATION_ID (and the gateway identity types it sits with)" },
  { path: "engine/src/core/summary.ts", why: "dependency closure: projectSummaryFields, imported by the in-memory store" },
  { path: "engine/src/integrations/identity.ts", why: "dependency closure: the IdentitySnapshot type the store interface names, and its validator" },
];

/** What upstream has that is deliberately not vendored, and why (recorded in UPSTREAM.json). */
export const NOT_VENDORED = [
  { path: "engine/src/app.ts", why: "the HTTP service (Elysia). Its step-change guards are rebuilt as pure functions in lib/workflow-step-rules.ts" },
  { path: "engine/src/index.ts", why: "the service entrypoint" },
  { path: "engine/src/schema.ts", why: "the Ajv wrapper around dsl/spec.json; the mold validates spec.json with Ajv as a devDependency (test only) until a later phase needs it at build time" },
  { path: "engine/src/persistence/mongo-store.ts", why: "MongoDB persistence; the mold keeps records in its own Postgres (a later phase)" },
  { path: "engine/src/integrations/callbacks.ts", why: "HTTP callback verification for the separate service" },
  { path: "engine/src/integrations/outbox.ts", why: "HTTP outbox delivery for the separate service" },
  { path: "engine/src/core/sequence.ts", why: "ordered manual workflows bound to upstream object types" },
  { path: "engine/jobs/", why: "cron and bulk HTTP callers of the separate service" },
  { path: "schemas/", why: "the upstream platform's own schemas" },
  { path: "customers/", why: "upstream's per-client requests and workflow documents" },
  { path: "dsl/examples/", why: "example workflows derived from upstream's clients; the mold has neutral fixtures (scripts/fixtures/workflows/)" },
  { path: "workflows/", why: "example workflow documents" },
  { path: "engine/test/", why: "the upstream test suite (bun:test, over the HTTP app); ported to scripts/test-workflow-engine.mjs (coverage, below)" },
];

const HEADER_TEXT = `Vendored workflow engine: generated by scripts/sync-workflow-engine.mjs, never edited by hand. Source, commit and local patches: ${VENDOR_REL}/UPSTREAM.json`;
const headerFor = (path) => (path.endsWith(".json") ? `  "$comment": ${JSON.stringify(HEADER_TEXT)},\n` : `// ${HEADER_TEXT}\n`);

/** Patch 2: parameter properties -> field + assignment, line for line. */
const ERASABLE = [
  {
    file: "engine/src/core/balancer.ts",
    before: "  constructor(private readonly instances: () => WorkflowInstance[] = () => []) {}",
    after: "  private readonly instances: () => WorkflowInstance[]; constructor(instances: () => WorkflowInstance[] = () => []) { this.instances = instances; }",
    count: 1,
  },
  {
    file: "engine/src/core/store.ts",
    before: "  constructor(\n    message: string,\n    readonly code: 'CONFLICT' | 'STALE_REVISION' = 'CONFLICT',\n  ) {\n    super(message);\n",
    after: "  readonly code: 'CONFLICT' | 'STALE_REVISION'; constructor(\n    message: string,\n    code: 'CONFLICT' | 'STALE_REVISION' = 'CONFLICT',\n  ) {\n    super(message); this.code = code;\n",
    count: 1,
  },
];

/**
 * Patch 3: neutral words. Each entry: [file, how many lines, sha256(NEUTRAL_SALT + those lines joined by "\n"), the
 * replacement lines]. The original lines are named only by that hash; see the header.
 */
export const NEUTRAL_SALT = "neutral-words:";
const NEUTRAL = [
  ["dsl/spec.json", 1, "fc3ce5a4a604e23b7b881a9a67b698abe3f224901ce1403c6d0e6ada829561bb", "  \"$id\": \"urn:workflow-engine:dsl:v2\","],
  ["dsl/spec.json", 1, "89b1ee5cd35b5f3b212ddd5c8fecfc55a3221faf51eccabfb1308dab7ee73468", "  \"title\": \"Workflow DSL v2\","],
  ["dsl/types.ts", 1, "1674f8bdc6a435009c39ecb809394b572c556ad4093c50a5be31ce24d39d3942", "   * the platform's person record carries). **Defaults to true**: presence is something you"],
  ["dsl/types.ts", 1, "fcbd5f3d818f1cc5ba2271920c6696fa18973e595ba7c41262e43ab9ac11c0b9", "   * `workflows[]` projection the platform's schema stores. Optional: omit it and"],
  ["dsl/types.ts", 1, "4fdaebcc5300fcb956ca6a2cf7c166543b6ceb1aa0bdf4f2d716cc6e5a2b2cef", "  /** Task property joining the cohort, e.g. \"batch_id\". */"],
  ["dsl/types.ts", 1, "7bdfc7d53529839f83909339a9384fc6bf9657efa98cd29a5dda61cd9ad146c9", "  // three upstream grouping-id fields a person covers (kept verbatim: UPSTREAM.json kept_identifiers)"],
  ["dsl/types.ts", 1, "05eaf929b443a5ec1e02130f5a0e9462a8b953ff44a049466d628e97828b4f2a", " * `{ key: 'desk', options: ['north', 'south'] }` for a step assigned by"],
  ["dsl/types.ts", 1, "c5a3cd0f510a1f244cd65992b68caa82fbd04227c83554b5fb36b67cfc4827b7", " * `{ desk: 'north' }`. The platform offers `options` as a drop-down on the"],
  ["engine/src/core/state.ts", 1, "9bb6105062be6a0ad987360f0f5530051f2f9f40561e4ee8a356399c5b487449", "/** A reviewer's note against a step (the platform's step review comment). */"],
  ["engine/src/core/state.ts", 1, "2c8f9bfa5a247fc7b9653605c58fba5314c04d4c66ea94d2665b6b87b16dff07", "  /** Domain discriminator such as `task`, `request`, `requirement`, or `case`. */"],
  ["engine/src/core/state.ts", 1, "ace3d9c5aedda876fb45898b10864f1c5bdd2cd72bdd489c555c5607c2288927", "   * order). For flat consumers — checklists, the platform's linear projection —"],
  ["engine/src/core/init.ts", 1, "075211683da9a44fbda8627bed8baa904d8593ae24f93e5db836fd5590f6ebad", " * the platform's `Person.employment_status_active`."],
  ["engine/src/core/rbac.ts", 2, "aa27be7cbdf3dc14460fbf53aec9d8151d5123cf08d03f3684a78b2a499e49eb", " * RBAC — mirrors the upstream platform's model\n * (its organization schema):"],
  ["engine/src/core/rbac.ts", 1, "95307077842b69001ee9fa2a70d783241449d868106ed58fcc0880836135046f", "  /** Platform Permission.object_name; omit = applies to every object. */"],
  ["engine/src/core/rbac.ts", 1, "14f173423c8e2e7f86ad88b01233785c769ba508788c344cd8f0c826009d1d11", "/** Platform ExplicitPermission (grants override role boundaries). */"],
  ["engine/src/core/rbac.ts", 1, "5dba440fe9bf92ced83cb1384d760221e66382d95bc00c04319cb77f12ef2470", "  /** Platform object; engine resources are \"Actionable\". */"],
  ["engine/src/core/rbac.ts", 1, "619f70cf65eac47b1f71f1560aa8ea555cb8e61e553badbadd6a7655810cdaf4", "/** One row of the platform's `ReportingMatrix`, optionally scoped to a business unit. */"],
  ["engine/src/core/rbac.ts", 1, "99feb01a20e032472f31f8045e4ab19cc055515ab8ae469202a043fbc941dd2f", "   * reportee id → every manager of theirs (the platform's `ReportingMatrix` is a"],
  ["engine/src/core/rbac.ts", 1, "1ac3c6c55ec3fcabdc3d90c04dbff883d531bd0f502251fe5db6fb7aa38662df", "    // (the supervising-role bypass must not be bought with a share)."],
  ["engine/src/core/diagram.ts", 1, "ce1b11f13310ea09cf1f6ec57108b7b320508ec1a243fdafdc8466ab008218b5", "/** Mermaid ids must be bare identifiers; step ids come from authored DSLs. */"],
  ["engine/src/core/evaluator.ts", 1, "f96886892f01a11cbbd973c684bbc5fdc84bd81b17d294d2bf681700efa3db65", "   * This person's reporting managers — their rows of the platform's"],
  ["engine/src/core/diff.ts", 1, "28cd573956d20d898c588808171743420b73da7f30c49a0e3c402783481b6d5e", "      // batch_id of 1 and \"1\" do not silently split one cohort in two."],
].map(([file, lines, before_sha256, after]) => ({ file, lines, before_sha256, after, count: 1 }));

/**
 * The words no vendored file may hold, as the sha256 of DOMAIN_WORD_SALT + the word (lower case), so this gate does not itself carry them: the
 * upstream company, platform and product; every customer named in upstream's examples, tests and customer notes, and the
 * banks among them; and the lines of business its comments used as examples (a regulatory notice, a trading desk, a
 * lender's licence class). A word matches as the start of a token or of a token's `_`-separated part, in any case, so a
 * stem such as a field-name prefix catches its whole family.
 */
export const DOMAIN_WORD_SALT = "domain-word:";
export const DOMAIN_WORD_SHA256 = [
  "e68647439e08caf381299c378df6e2a0d03d0dcaaef2c9c791b15b74dd908203",
  "44741a154199b86df645073543cf047b10ca087f6e5a1b47a3212d8e62d7fbcd",
  "c991d8057bd1fa6422d35be740fab37d6a6a9f8922c23d8397adcfb3ad47b4ff",
  "c337d82b62a5823dd6c9903e19aa62be9dc222d9b2484b3b3838525eaf6d26d5",
  "5cb1958d4d75f48d7e64ebff68d9f873d66cc3bd404d4b29eb2e2910a834210a",
  "9b0264ba31b203e82f5a8cdc01ba365d88d7e5ef4517537f2b6a29f515043911",
  "8d4007e9127e1bcb1e3fc87c0dd6405f5435490d267779ac68ef663d5e05a21a",
  "4306a2763d307ff3965b0e87c60eb25cd2b15a9c08240d8d5cd01b9314f2fa7e",
  "b0131618fff7077d01fcaebb56665049ffdc33d71ecf133177485fd3601416ce",
  "874ddbdcc73ecc27fb78b143700f943428b2de1df71160017f4642cea8db92a9",
  "ad3a8242274f96fd3d8e81a40bc558a58a8e412d3c3d20102c99b7981b119225",
  "6a4ace4decccd58e411df5c3ee764652868f5377722da7e80f7cda2fca0709a3",
  "462e34dde6e92bb5636c67e76da3b822f48d1ba7cd46ffd9c8f93be4a345b643",
  "84fb28417d6b434449d8d530b1ff01b4e0a8b290fd21c8a47af5a7f6c283fa95",
  "6f3f4902666f4b55098957d2e72e212e1d384031b882d79115748fb89a68d799",
  "5bc41e956230ac9851a2569aa0e8c7daca2db67bab302a7ba9d2436fb1b8f8c8",
  "297c1aeac66aa79489eb48e20c6a022ede47a402be8b20eaa7c2c2d94ae3ada7",
  "0505dcdf794921bc57c4eafbec6f5aa4628c407b29fa5e1b04542d265f6eae05",
];
/** The one allowance: upstream's directory field names, a wire contract. Exact file and count. */
export const KEPT_IDENTIFIERS = [
  {
    file: "dsl/types.ts",
    identifiers: ["legal_entity_ids", "office_location_ids", "financial_product_ids"],
    count: 1,
    why: "Entries of PLATFORM_USER_ATTRIBUTES: the directory fields the upstream platform sends with every user, which validateWorkflow lets a directory query name and refuses to see redeclared. Renaming them would change what the validator accepts, so they are kept as upstream spells them. The mold's people carry none of them; a later phase (people data) maps the mold's own fields.",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const count = (text, needle) => (needle ? text.split(needle).length - 1 : 0);
const fail = (message) => {
  console.error(`sync-workflow-engine: ${message}`);
  process.exit(1);
};

/** Patch 1, computed from the file: every relative import specifier that names a listed .ts file without its extension. */
function importPatches(path, text) {
  const out = [];
  const seen = new Set();
  const dir = posix.dirname(path);
  for (const m of text.matchAll(/(\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g)) {
    const spec = m[3];
    const resolved = posix.normalize(posix.join(dir, spec));
    if (FILES.some((f) => f.path === resolved)) continue; // already carries its extension
    if (!FILES.some((f) => f.path === `${resolved}.ts`)) {
      throw new Error(`${path}: imports ${spec}, which resolves to no vendored file (the vendored list must hold the whole dependency closure)`);
    }
    const before = `${m[1]}${m[2]}${spec}${m[2]}`;
    if (seen.has(before)) continue;
    seen.add(before);
    out.push({ before, after: `${m[1]}${m[2]}${spec}.ts${m[2]}`, count: count(text, before) });
  }
  for (const m of text.matchAll(/\bfrom\s+(['"])([^'".][^'"]*)\1/g)) {
    if (!m[2].startsWith("node:")) throw new Error(`${path}: imports the package "${m[2]}"; the vendored engine may import only node: builtins and its own files`);
  }
  return out;
}

/** The patches for one file, in the order they apply, each with its kind. */
function patchesFor(path, upstreamText) {
  return [
    ...(path.endsWith(".ts") ? importPatches(path, upstreamText).map((p) => ({ kind: "import-specifiers", ...p })) : []),
    ...declaredPatches(path),
  ];
}
/** The patches this script declares for a file (everything but the import patches, which are read off upstream). */
function declaredPatches(path) {
  return [
    ...ERASABLE.filter((p) => p.file === path).map(({ before, after, count }) => ({ kind: "erasable-syntax", before, after, count })),
    ...NEUTRAL.filter((p) => p.file === path).map(({ lines, before_sha256, after, count }) => ({ kind: "neutral-words", lines, before_sha256, after, count })),
  ];
}

/** Where a hashed neutral-words patch applies: the start of every window of `lines` lines whose salted hash matches. */
function hashedWindows(text, p) {
  const lines = text.split("\n");
  const at = [];
  for (let i = 0; i + p.lines <= lines.length; i++) {
    if (sha256(NEUTRAL_SALT + lines.slice(i, i + p.lines).join("\n")) === p.before_sha256) at.push(i);
  }
  return at;
}

/** upstream text -> vendored text. Each patch must find exactly its count of `before` and no `after`. */
function forward(path, upstreamText, patches) {
  let text = upstreamText;
  for (const p of patches) {
    if (p.kind === "neutral-words") {
      const at = hashedWindows(text, p);
      if (at.length !== p.count) throw new Error(`${path}: the neutral-words patch ${p.before_sha256.slice(0, 12)}… expects ${p.count} matching line window(s), upstream has ${at.length}`);
      if (count(text, p.after) !== 0) throw new Error(`${path}: upstream already holds the neutral-words patch's result ${JSON.stringify(p.after)}`);
      const lines = text.split("\n");
      for (const i of [...at].reverse()) lines.splice(i, p.lines, p.after);
      text = lines.join("\n");
      continue;
    }
    const n = count(text, p.before);
    if (n !== p.count) throw new Error(`${path}: the ${p.kind} patch expects ${p.count} occurrence(s) of ${JSON.stringify(p.before)}, upstream has ${n}`);
    if (p.kind !== "import-specifiers" && count(text, p.after) !== 0) throw new Error(`${path}: upstream already holds the ${p.kind} patch's result ${JSON.stringify(p.after)}`);
    text = text.split(p.before).join(p.after);
  }
  const header = headerFor(path);
  if (path.endsWith(".json")) {
    if (!text.startsWith("{\n")) throw new Error(`${path}: expected a JSON object starting "{" on its own line`);
    return `{\n${header}${text.slice(2)}`;
  }
  return header + text;
}

/** Offline checks of one vendored file against its recorded patches (no upstream bytes needed). */
function offlineProblems(path, vendored, recordedPatches) {
  const problems = [];
  const header = headerFor(path);
  if (!vendored.startsWith(path.endsWith(".json") ? `{\n${header}` : header)) problems.push(`${VENDOR_REL}/${path}: the header line is missing or changed`);
  const imports = recordedPatches.filter((p) => p.kind === "import-specifiers");
  const others = recordedPatches.filter((p) => p.kind !== "import-specifiers");
  if (JSON.stringify(others) !== JSON.stringify(declaredPatches(path))) problems.push(`${VENDOR_REL}/${path}: the recorded patches are not the ones this script declares (re-sync from the upstream checkout)`);
  for (const p of [...imports, ...others]) {
    const n = count(vendored, p.after);
    if (n < p.count) problems.push(`${VENDOR_REL}/${path}: the ${p.kind} patch's result ${JSON.stringify(p.after)} should occur ${p.count} time(s), the vendored file has ${n}`);
  }
  if (path.endsWith(".ts")) {
    try {
      const left = importPatches(path, vendored);
      if (left.length) problems.push(`${VENDOR_REL}/${path}: relative import(s) without .ts: ${left.map((p) => p.before).join(", ")}`);
    } catch (e) {
      problems.push(e.message);
    }
  }
  return problems;
}

/** sha256(salt + w) for every start of `token` and of each of its `_`-separated parts: what the domain-word gate compares. */
const WORD_SET = new Set(DOMAIN_WORD_SHA256);
export function domainWordIn(token) {
  const t = token.toLowerCase();
  const starts = [0, ...[...t].flatMap((c, i) => (c === "_" ? [i + 1] : []))];
  for (const start of starts) {
    for (let end = start + 3; end <= t.length; end++) {
      if (WORD_SET.has(sha256(DOMAIN_WORD_SALT + t.slice(start, end)))) return t.slice(start, end);
    }
  }
  return null;
}

/** Domain words anywhere in the vendored tree (UPSTREAM.json included), minus the kept identifiers. */
export function domainWordProblems(root = ROOT) {
  const problems = [];
  const dir = join(root, VENDOR_REL);
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    let text = readFileSync(file, "utf8");
    if (rel === "UPSTREAM.json") {
      const record = JSON.parse(text);
      delete record.kept_identifiers; // the declaration of the allowance itself
      text = JSON.stringify(record, null, 2);
    }
    for (const kept of KEPT_IDENTIFIERS.filter((k) => k.file === rel)) {
      for (const id of kept.identifiers) {
        const n = count(text, `'${id}'`);
        if (n !== kept.count) problems.push(`${VENDOR_REL}/${rel}: the kept identifier '${id}' occurs ${n} time(s), declared ${kept.count}`);
        text = text.split(`'${id}'`).join("''");
      }
    }
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/[A-Za-z0-9_]+/g)) {
        const hit = domainWordIn(m[0]);
        // the word itself is not printed: the message would carry it into a log
        if (hit) problems.push(`${VENDOR_REL}/${rel}:${i + 1}:${m.index + 1}: a refused domain word (${hit.length} letters, starting "${hit[0]}") begins the token at this column; add a neutral-words patch`);
      }
    });
  }
  return problems;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readRecord() {
  if (!existsSync(RECORD)) return null;
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The upstream test files at the checkout (for the coverage map). A file named after a customer is recorded with that
 * word replaced by "redacted" (the name would otherwise carry it into the tree); the rest of the name says which it is.
 */
export function redactName(name) {
  return name.replace(/[A-Za-z0-9]+/g, (part) => (domainWordIn(part) ? "redacted" : part));
}
function upstreamTests(from) {
  const dir = join(from, "engine/test");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort().map(redactName) : [];
}

/** UPSTREAM.json for a source and per-file entries ({ path, sha256_upstream, sha256_vendored, patches }). */
function recordFrom(source, files, kept) {
  return {
    $comment: "Written by scripts/sync-workflow-engine.mjs (never by hand, except `coverage`, which the sync keeps as it finds it and scripts/test-workflow-engine.mjs holds to the upstream test list). docs/WORKFLOW_ENGINE.md says how to refresh. Where the upstream checkout lives is the operator's (WORKFLOW_ENGINE_SOURCE), never recorded here.",
    source,
    header: HEADER_TEXT,
    local_patches: {
      "import-specifiers": "A relative import gains `.ts`, so the files load under node --experimental-strip-types (the mold's convention).",
      "erasable-syntax": "TypeScript parameter properties (two, in balancer.ts and store.ts) become a field and an assignment on the same line; strip-only mode refuses a parameter property. Same behaviour.",
      "neutral-words": "Whole comment lines (and the spec's title and $id lines) that named the upstream platform or company, an example taken from a client, or a line of business are replaced by neutral lines. The originals are not stored: each patch names its lines by sha256(salt + text), salt `neutral-words:`, and only a sync from the upstream checkout can apply it. No identifier or value that code reads changes (the three kept_identifiers stay as upstream spells them).",
    },
    kept_identifiers: KEPT_IDENTIFIERS,
    domain_words_refused: { salt: DOMAIN_WORD_SALT, sha256: DOMAIN_WORD_SHA256 },
    files: FILES.map(({ path, why }) => {
      const f = files.get(path);
      return { path, vendored_as: `${VENDOR_REL}/${path}`, why, sha256_upstream: f.sha256_upstream, sha256_vendored: f.sha256_vendored, patches: f.patches };
    }),
    not_vendored: NOT_VENDORED,
    upstream_tests: kept.upstream_tests,
    coverage: kept.coverage,
  };
}

/** Every vendored file from upstream texts (path -> text): path -> { vendored, sha256s, patches }. */
function derive(upstream) {
  const out = new Map();
  for (const { path } of FILES) {
    const up = upstream.get(path);
    const patches = patchesFor(path, up);
    const vendored = forward(path, up, patches);
    out.set(path, { vendored, sha256_upstream: sha256(Buffer.from(up, "utf8")), sha256_vendored: sha256(Buffer.from(vendored, "utf8")), patches });
  }
  return out;
}

const SOURCE_LABEL = "the operator's workflow-engine monorepo";

/** The engine checkout: --from, else WORKFLOW_ENGINE_SOURCE. Never an address written in this repository. */
const checkoutDir = () => opt("--from") ?? process.env.WORKFLOW_ENGINE_SOURCE ?? undefined;

function readUpstream(from) {
  const upstream = new Map();
  for (const f of FILES) {
    const p = join(from, f.path);
    if (!existsSync(p)) fail(`${from} has no ${f.path}`);
    upstream.set(f.path, readFileSync(p, "utf8"));
  }
  return upstream;
}

function write(from, commitArg) {
  const previous = readRecord();
  const pinned = commitArg ?? previous?.source?.commit;
  if (!pinned) fail("no pinned commit: pass --commit <sha> (the first sync), or keep UPSTREAM.json");
  const head = gitHead(from);
  if (!head) fail(`the engine checkout is not inside a git checkout; the commit must be verifiable`);
  if (head !== pinned) fail(`the engine checkout is at ${head}, the pin is ${pinned}. Check out the pinned commit, or pass --commit ${head} to re-pin.`);
  const path = opt("--path") ?? previous?.source?.path;
  if (!path) fail("the engine's path inside its repository is not recorded yet: pass --path <dir in that repository>");
  let derived;
  try {
    derived = derive(readUpstream(from));
  } catch (e) {
    fail(e.message);
  }
  const record = recordFrom(
    { label: SOURCE_LABEL, path, commit: pinned, synced: new Date().toISOString().slice(0, 10) },
    derived,
    { upstream_tests: upstreamTests(from), coverage: previous?.coverage ?? {} },
  );
  for (const file of walk(VENDOR)) {
    const rel = relative(VENDOR, file);
    if (rel !== "UPSTREAM.json" && !FILES.some((f) => f.path === rel)) rmSync(file);
  }
  for (const [p, f] of derived) {
    mkdirSync(dirname(join(VENDOR, p)), { recursive: true });
    writeFileSync(join(VENDOR, p), f.vendored);
  }
  writeFileSync(RECORD, `${stringifyRecorded(record, 2)}\n`);
  const problems = domainWordProblems();
  if (problems.length) fail(`wrote the files, but the domain-word gate fails (declare a neutral-words patch for each):\n  - ${problems.join("\n  - ")}`);
  console.log(`sync-workflow-engine: ${FILES.length} file(s) vendored from ${path} @ ${pinned} into ${VENDOR_REL}/ (UPSTREAM.json written)`);
}

function check(from) {
  const record = readRecord();
  if (!record) fail(`${VENDOR_REL}/UPSTREAM.json is missing`);
  const problems = [];
  const files = new Map();
  for (const f of FILES) {
    const rec = record.files?.find((r) => r.path === f.path);
    const file = join(VENDOR, f.path);
    if (!rec) {
      problems.push(`${f.path}: not recorded in UPSTREAM.json`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${VENDOR_REL}/${f.path}: missing`);
      continue;
    }
    const vendored = readFileSync(file, "utf8");
    if (sha256(Buffer.from(vendored, "utf8")) !== rec.sha256_vendored) problems.push(`${VENDOR_REL}/${f.path}: its bytes are not the recorded vendored sha256 (edited by hand?)`);
    problems.push(...offlineProblems(f.path, vendored, rec.patches ?? []));
    files.set(f.path, rec);
  }
  for (const file of walk(VENDOR)) {
    const rel = relative(VENDOR, file);
    if (rel !== "UPSTREAM.json" && !FILES.some((f) => f.path === rel)) problems.push(`${VENDOR_REL}/${rel}: not a listed file (the sync would remove it)`);
  }
  if (!problems.length) {
    const keys = Object.keys(record.source ?? {}).sort().join(",");
    if (keys !== "commit,label,path,synced" || record.source.label !== SOURCE_LABEL) problems.push(`${VENDOR_REL}/UPSTREAM.json: source must hold exactly { label, path, commit, synced } (no address)`);
    const want = `${stringifyRecorded(recordFrom(record.source, files, { upstream_tests: record.upstream_tests, coverage: record.coverage }), 2)}\n`;
    if (readFileSync(RECORD, "utf8") !== want) problems.push(`${VENDOR_REL}/UPSTREAM.json: is not what the sync writes (patches, file list or notes changed without a sync)`);
  }
  let rederived = false;
  if (from && !problems.length) {
    const head = gitHead(from);
    if (head !== record.source.commit) problems.push(`the engine checkout is at ${head}, UPSTREAM.json pins ${record.source.commit}`);
    else {
      try {
        for (const [p, d] of derive(readUpstream(from))) {
          const rec = files.get(p);
          if (d.sha256_upstream !== rec.sha256_upstream) problems.push(`${p}: the checkout's bytes are not the recorded upstream sha256`);
          if (readFileSync(join(VENDOR, p), "utf8") !== d.vendored) problems.push(`${VENDOR_REL}/${p}: is not what the sync produces from the checkout`);
          if (JSON.stringify(d.patches) !== JSON.stringify(rec.patches)) problems.push(`${VENDOR_REL}/${p}: the recorded patches are not what the sync derives from the checkout`);
        }
        rederived = true;
      } catch (e) {
        problems.push(e.message);
      }
    }
  }
  problems.push(...domainWordProblems());
  if (problems.length) fail(`--check failed:\n  - ${problems.join("\n  - ")}\nRefresh with: node scripts/sync-workflow-engine.mjs --from <engine checkout at the pinned commit>`);
  const patchCount = record.files.reduce((n, f) => n + f.patches.length, 0);
  console.log(`sync-workflow-engine --check: ${FILES.length} vendored file(s) match their recorded sha256 and the ${patchCount} declared patch(es) for ${record.source.path} @ ${record.source.commit}${rederived ? ", and re-derive byte for byte from the upstream checkout" : " (offline; pass --from or set WORKFLOW_ENGINE_SOURCE to re-derive from upstream)"}; no domain word outside the ${KEPT_IDENTIFIERS.reduce((n, k) => n + k.identifiers.length, 0)} kept identifier(s)`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const from = checkoutDir();
  if (args.includes("--check")) check(from);
  else if (from) write(from, opt("--commit"));
  else {
    console.error("usage: node scripts/sync-workflow-engine.mjs --from <engine checkout> [--commit <sha>] [--path <dir>] | --check [--from <engine checkout>] [--root <dir>]\n(WORKFLOW_ENGINE_SOURCE may stand for --from)");
    process.exit(2);
  }
}
