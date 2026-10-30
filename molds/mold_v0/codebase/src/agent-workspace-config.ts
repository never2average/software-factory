/**
 * The agent-workspace runner's configuration (mold_v0-061; the runner is src/agent-workspace.ts, carried out by
 * src/run-harness.ts). A job kind with `runner: "agent-workspace"` runs an agent repository (an upstream project that
 * is never vendored into the pack or the shell) at a pinned commit, with a declared command, a declared validation and
 * a declared write-back. Everything here is plain JSON (no functions), so the same object can be written in a pack's
 * pack.json (mold_v0-057) as in its definePack.
 *
 *   repository   where the agent repository is fetched from: https:// (a file:// mirror on the runner's machine is
 *                accepted here and refused at run time unless the runner allows local mirrors)
 *   commit       the full commit id (40 or 64 hex characters): the only commit a run ever checks out. Never a branch,
 *                a tag or a short id; a fetch that does not yield exactly this commit fails the run
 *   strip        paths removed from the checkout before anything runs (glob: * one segment, ** any depth, ? a character)
 *   setup        an optional command run first (installing the repository's dependencies), with the run's egress but no
 *                credential and no gateway token
 *   command      the agent's command, an argument list (never a shell line). "{name}" is replaced by the declared
 *                argument `name` (args), inside one argument, never splitting it
 *   args         each argument's source: the run's scope or targets (a dotted path), or the run's id, attempt or kind;
 *                a `default`, and a `pattern` its value must match (a value never starts with "-")
 *   env          variables the agent gets, besides the run's own (PATH, HOME, RUN_*, the egress proxy's). A value may
 *                hold "{gateway.token}" (the run's gateway token), "{gateway.<provider>.base_url}", "{gateway.url}" and
 *                declared arguments. The run's credentials (mold_v0-034) are delivered as the kind's `credentials` say
 *   validate     the validation command, run after the agent exits 0, with no credential and no gateway token, on a copy
 *                of the pinned tree as it was before the agent ran with the write-back laid over it (never on files the
 *                agent could change): the workspace is written back only when it exits 0
 *   write_back   the paths of the checkout that are the workspace: restored from its latest snapshot before the run,
 *                written back (as a new snapshot) after a valid run
 *   write_back_ignore  (mold_v0-182) patterns in git's ignore syntax, from the checkout's root, never written back
 *                (a repository the run clones under a write-back path, a cache, a decrypted file)
 *   write_back_gitignore  (mold_v0-182, default true) the agent repository's own .gitignore files, as committed at the
 *                pin, are applied below each write-back path too (never to a write-back path the repository itself
 *                ignores: the kind declared that one its workspace). What either leaves out never leaves the sandbox
 *   write_back_required  (mold_v0-183, default false) the kind always changes its workspace when it works (a profile it
 *                creates, a record it refreshes, a ledger it appends to): a run that exits 0 and validates but leaves
 *                every write-back path exactly as it found it fails ("run": it changed nothing in its workspace) instead
 *                of succeeding silently. The program's own account of why is in its events (step output, agent_output)
 *   results      a JSON list in the checkout, the run's results (src/runs.ts); default <RUN_OUT>/results.json
 *   record       files of the checkout recorded in the run's events after the run (a session summary, usage): path,
 *                size, sha256 and, for a small JSON file, its content, redacted like everything else
 *   timeout_seconds  the agent command's time limit; past it every process of the run is killed and the run fails
 *   results_from (mold_v0-071) the program's own result file under <RUN_OUT> (a JSON pointer to its list, each item
 *                mapped to a run result: check/asset/source from an area and a key template, status through a value
 *                map, fingerprint, evidence, detail); an item that does not map follows the kind's
 *                unresolved_references (reject: the run fails; drop/downgrade: left out and reported). Instead of
 *                `results`. Every file the run writes under <RUN_OUT> is recorded in its events (agent_output)
 *   tools        (mold_v0-072) the tools the kind needs from the runner image's pinned catalogue (src/run-tools.ts):
 *                the image is built with them (scripts/install-run-tools.ts); a run whose image lacks one, or holds a
 *                copy that is not the pinned one, is refused before anything runs. Nothing is downloaded at run time
 *   inputs       (mold_v0-073) run arguments written to files in the checkout before the first step: each from the
 *                run's scope or targets, checked against its JSON schema (a fixed subset) and its size cap, refused
 *                when it holds the value of a credential, written to a new file (never over a file of the pinned tree,
 *                never through a link, never under a write-back path); `pin` (mold_v0-166) fills in the current
 *                commit (and default branch) of each repository the input lists without one
 *   steps        (mold_v0-074) commands run before `command`, in order, each with its own time limit and only the
 *                credentials it names; `git_credentials` hand a credential to git through a credential helper that
 *                reads a file on tmpfs (never an argument, a variable or a URL); a `checkout` step is the runner's own:
 *                repositories named by the checkout's manifest files fetched at their pinned commits into a cache
 *                outside the workspace store (per workspace, per repository and commit, size-capped, cleaned) and
 *                linked read-only into the checkout for the later steps (or copied there read-only: mount_as
 *                "directory", mold_v0-183); the links and copies are never written back
 *   credentials  (mold_v0-074) the kind's credentials `command` receives (default: all of them); `git_credentials`
 *                as for a step
 */
import { z } from "zod";
import { globRegex, placeholders } from "./agent-workspace-paths.js";

// Plain helpers with no dependency, so the sandbox runner (src/run-sandbox-runner.ts) loads without zod (mold_v0-055).
export { globRegex, placeholders } from "./agent-workspace-paths.js";

const segment = (s: string) => s !== "" && s !== "." && s !== "..";
/** A relative path inside the checkout: forward slashes, no empty, "." or ".." part, no control characters. */
const relPath = z.string().min(1).max(300)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f]/.test(p) && p.split("/").every(segment), "a relative path inside the checkout (no .., no leading /)")
  .refine((p) => !/[*?[\]{}]/.test(p), "a plain path (no glob characters)");
/** A glob over relative paths: * (one segment), ** (any depth), ? (one character); otherwise a plain relative path. */
const glob = z.string().min(1).max(300)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f[\]{}]/.test(p) && p.split("/").every(segment), "a relative glob inside the checkout (no .., no leading /, no [ ] { })");
const argName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "an argument name: lowercase letters, digits and _");
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/, "an environment variable name");
const commandSchema = z.array(z.string().min(1).max(500).refine((a) => !/[\u0000]/.test(a), "no NUL")).min(1).max(64);
const timeout = (def: number) => z.number().int().min(10).max(24 * 3600).default(def);
const regexOk = (s: string) => { try { new RegExp(s); new RegExp(s, "u"); return true; } catch { return false; } };

export const AGENT_ARG_SOURCE = /^((scope|targets)(\.[A-Za-z0-9_-]{1,64}){1,4}|run\.(id|attempt|kind))$/;
export const AgentArgSchema = z.object({
  from: z.string().regex(AGENT_ARG_SOURCE, "scope.<key>, targets.<key>[.<key>...] or run.id / run.attempt / run.kind"),
  /** The value must match it in full (anchored); default: letters, digits and . _ : @ / + = -, up to 200. */
  pattern: z.string().min(1).max(200).refine(regexOk, "a regular expression").optional(),
  default: z.string().max(200).optional(),
}).strict();

export const GATEWAY_PLACEHOLDER = /^gateway\.(token|url|([a-z][a-z0-9_-]{1,40})\.base_url)$/;

// ---------- mold_v0-071..074 ----------

const credName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a credential field of the pack (lowercase letters, digits and _)");
/** A host git may be given a credential for: a plain host name (HTTPS), no address, no port, no wildcard. */
const gitHost = z.string().max(253).regex(/^(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/, "a host name (git over HTTPS)");
export const GitCredentialSchema = z.object({
  credential: credName,
  host: gitHost,
  /** The user name git sends with the credential as its password (a token): x-access-token for GitHub. */
  username: z.string().regex(/^[A-Za-z0-9._@+-]{1,100}$/, "a user name").default("x-access-token"),
}).strict();
const gitCredentials = z.array(GitCredentialSchema).max(5).default([]);

/** The tools a kind may declare (mold_v0-072): the catalogue's names (src/run-tools.ts RUN_TOOL_NAMES). */
export const RUN_TOOL_NAMES = ["git", "claude-code", "sops", "age", "kubectl", "aws"] as const;

/** A dotted field of a result item, the run's arguments ($args.<name>) or the result file's root ($root.<path>). */
const TEMPLATE_PART = /^(\$args\.[a-z][a-z0-9_]{0,39}|(\$root\.)?[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7})$/;
const template = z.string().min(1).max(300).refine((t) => !/[\u0000-\u001f]/.test(t), "no control characters")
  .refine((t) => placeholders(t).every((p) => TEMPLATE_PART.test(p)), "{field.path}, {$args.<name>} or {$root.<path>} placeholders")
  .refine((t) => !/[{}]/.test(t.replace(/\{[^{}]*\}/g, "")), "unbalanced { }");
const itemField = z.string().regex(/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7}$/, "an item's field (a dotted path)");
const RESULT_STATUSES = ["pass", "fail", "error", "not_applicable", "unknown"] as const;
const areaName = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "a record area's name");
const refMap = z.object({ area: areaName, key: template }).strict();
const jsonPointer = z.string().max(300).regex(/^(\/([^~/]|~[01])*)*$/, "a JSON pointer (RFC 6901): \"\" for the whole file, /findings for its findings list");
export const ResultsFromSchema = z.object({
  /** The program's result file, under <RUN_OUT> (the run's output directory: outside the checkout, never written back). */
  file: relPath,
  pointer: jsonPointer.default(""),
  check: refMap,
  asset: refMap.optional(),
  source: refMap.optional(),
  /** A status for every item, or one read from a field and mapped (`map`), else `default`; no default: the item does not map. */
  status: z.union([z.enum(RESULT_STATUSES), z.object({
    /** The item's field (a dotted path) whose value is looked up in `map`. */
    from: itemField, map: z.record(z.string().max(100), z.enum(RESULT_STATUSES)).default({}), default: z.enum(RESULT_STATUSES).optional(),
  }).strict()]),
  fingerprint: template.optional(),
  evidence: template.optional(),
  detail: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), template).refine((d) => Object.keys(d).length <= 20, "at most 20 detail fields").default({}),
  /** Items whose field `field` is one of `in` only (e.g. only findings): the others are skipped, not unmapped. */
  where: z.object({ field: itemField, in: z.array(z.union([z.string().max(100), z.number(), z.boolean()])).min(1).max(50) }).strict().optional(),
}).strict();

/** The fixed subset of JSON Schema an input may be checked with (refused at build otherwise). */
export type InputSchema = {
  type?: string | string[]; properties?: Record<string, InputSchema>; required?: string[]; additionalProperties?: boolean | InputSchema;
  items?: InputSchema; enum?: unknown[]; const?: unknown; pattern?: string; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; maxProperties?: number;
  title?: string; description?: string; $comment?: string;
};
const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
export const InputSchemaSchema: z.ZodType<InputSchema> = z.lazy(() => z.object({
  type: z.union([z.enum(JSON_TYPES), z.array(z.enum(JSON_TYPES)).min(1).max(7)]).optional(),
  properties: z.record(z.string().max(100), InputSchemaSchema).refine((p) => Object.keys(p).length <= 200, "at most 200 properties").optional(),
  required: z.array(z.string().max(100)).max(200).optional(),
  additionalProperties: z.union([z.boolean(), InputSchemaSchema]).optional(),
  items: InputSchemaSchema.optional(),
  enum: z.array(z.unknown()).min(1).max(200).optional(),
  const: z.unknown().optional(),
  pattern: z.string().max(300).refine(regexOk, "a regular expression").optional(),
  minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(),
  minimum: z.number().optional(), maximum: z.number().optional(),
  minItems: z.number().int().min(0).optional(), maxItems: z.number().int().min(0).optional(),
  maxProperties: z.number().int().min(0).optional(),
  title: z.string().max(200).optional(), description: z.string().max(1000).optional(), $comment: z.string().max(1000).optional(),
}).strict());
/**
 * (mold_v0-166) Repositories named in an input, each pinned to the current commit of its branch before the input is
 * written: the list at `list` (a JSON pointer into the value), each item's `url`, `branch` and `commit` fields. An item
 * that gives its commit keeps it; else the runner asks the repository (git ls-remote, outside the run's proxy as for the
 * agent repository, no credential: a private repository's item gives its commit) for the branch's head, or for its
 * default branch and head when the item names no branch, and fills both in. The url must be https on one of `hosts`
 * exactly (each in the kind's egress). The value is checked against the schema before and after.
 */
const fieldKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a field name");
export const InputPinSchema = z.object({
  list: z.string().regex(/^(\/[A-Za-z0-9_-]{1,64}){1,4}$/, "a JSON pointer to a list (/repos)"),
  url: fieldKey.default("url"),
  branch: fieldKey.default("branch"),
  commit: fieldKey.default("commit"),
  hosts: z.array(gitHost).min(1).max(10),
  max_items: z.number().int().min(1).max(50).default(20),
}).strict();
export const AgentInputSchema = z.object({
  /** The run's scope or targets (a dotted path), as an argument's `from`: an object, a list or a value. */
  from: z.string().regex(/^(scope|targets)(\.[A-Za-z0-9_-]{1,64}){1,4}$/, "scope.<key> or targets.<key>[.<key>...]"),
  /** Where it is written: a new file in the checkout (never under a write-back path, never over a file of the tree). */
  path: relPath,
  schema: InputSchemaSchema,
  format: z.enum(["json", "text"]).default("json"),
  max_bytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024),
  pin: InputPinSchema.optional(),
}).strict().refine((i) => !i.pin || i.format === "json", "pin is for a json input");

/** The runner's own checkout of repositories named by manifest files of the checkout (mold_v0-074). */
export const CheckoutStepSchema = z.object({
  /** Manifest files in the checkout (after the workspace is restored), a glob that may hold {argument} placeholders. */
  manifests: z.string().min(1).max(300),
  /** Fields of each manifest: the repository's https address, its full pinned commit, and its name (for `mount`). */
  url: z.string().regex(/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}$/).default("url"),
  commit: z.string().regex(/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}$/).default("commit"),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}$/).default("name"),
  /** Where each repository appears in the checkout, read-only: a path with {name} and {argument} placeholders. */
  mount: z.string().min(1).max(300),
  /**
   * How it appears there (mold_v0-183): "link" (default), a link to the cache's tree; "directory", a read-only copy of
   * it, for programs whose file search does not follow links (Claude Code's Glob and Grep run ripgrep without --follow:
   * a linked checkout looks empty to them). Either is gone before the write-back is collected.
   */
  mount_as: z.enum(["link", "directory"]).default("link"),
  /** The hosts a manifest's repository may be on, exactly (no subdomain; each must also be in the kind's egress). */
  hosts: z.array(gitHost).min(1).max(10),
  /**
   * Where the manifests are read: "workspace" (default), the workspace's files as the run restored them (what earlier,
   * validated runs committed), before any program of this run could write one; or "checkout", the checkout as the earlier
   * steps left it. With "checkout" the run's own programs choose the repositories the runner fetches with `credential`:
   * that is giving them the token's read reach on these hosts.
   */
  source: z.enum(["workspace", "checkout"]).default("workspace"),
  /** The kind's credential the fetch authenticates with (git's credential helper, for the repository's host only). */
  credential: credName.optional(),
  username: z.string().regex(/^[A-Za-z0-9._@+-]{1,100}$/).default("x-access-token"),
  max_repos: z.number().int().min(1).max(50).default(20),
  /** One repository's checkout at most this many bytes; the workspace's whole cache is capped by the runner. */
  max_bytes: z.number().int().min(1024 * 1024).max(4 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
}).strict();

const stepName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "a step name: lowercase letters, digits, _ and -");
export const AgentStepSchema = z.object({
  name: stepName,
  /** A command, as `command` (an argument list with {argument} placeholders), or the runner's own `checkout`. */
  command: commandSchema.optional(),
  checkout: CheckoutStepSchema.optional(),
  timeout_seconds: timeout(600),
  /** The kind's credentials this step receives (as each field delivers it); none by default. */
  credentials: z.array(credName).max(20).default([]),
  git_credentials: gitCredentials,
  /** The kind's declared `env` (the gateway token among them, where it says so): none by default. */
  env: z.boolean().default(false),
}).strict().refine((s) => !!s.command !== !!s.checkout, "a step is a command or a checkout, not both");

export const AgentWorkspaceSchema = z.object({
  repository: z.string().max(300).regex(/^(https:\/\/[A-Za-z0-9.-]+(:443)?\/[A-Za-z0-9._~\/-]+|file:\/\/\/[A-Za-z0-9._~\/-]+)$/,
    "an https:// address of the repository (no user, query or fragment), or a file:/// mirror"),
  commit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "the full commit id (40 or 64 lowercase hex characters): never a branch, a tag or a short id"),
  strip: z.array(glob).max(100).default([]),
  setup: z.object({ command: commandSchema, timeout_seconds: timeout(600) }).strict().optional(),
  command: commandSchema,
  args: z.record(argName, AgentArgSchema).default({}),
  env: z.record(envName, z.string().max(1000)).default({}),
  validate: z.object({ command: commandSchema, timeout_seconds: timeout(600) }).strict(),
  write_back: z.array(relPath).min(1).max(50),
  write_back_ignore: z.array(z.string().min(1).max(300).refine((p) => !/[\u0000-\u001f]/.test(p) && !p.split("/").includes(".."), "a pattern in git's ignore syntax (no .., no control characters)")).max(100).default([]),
  write_back_gitignore: z.boolean().default(true),
  write_back_required: z.boolean().default(false),
  results: relPath.optional(),
  record: z.array(glob).max(20).default([]),
  timeout_seconds: timeout(3600),
  results_from: ResultsFromSchema.optional(),
  tools: z.array(z.enum(RUN_TOOL_NAMES)).max(RUN_TOOL_NAMES.length).default([]),
  inputs: z.record(argName, AgentInputSchema).refine((i) => Object.keys(i).length <= 10, "at most 10 inputs").default({}),
  steps: z.array(AgentStepSchema).max(10).default([]),
  /** The kind's credentials `command` receives; absent: all of them (as before mold_v0-074). */
  credentials: z.array(credName).max(20).optional(),
  git_credentials: gitCredentials,
}).strict().superRefine((a, ctx) => {
  const bad = (message: string, ...path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  const declared = new Set(Object.keys(a.args));
  for (const [i, part] of a.command.entries()) for (const p of placeholders(part))
    if (!declared.has(p)) bad(`{${p}} is not a declared argument (args)`, "command", i);
  if (placeholders(a.command[0]!).length) bad("the program (the command's first element) takes no placeholder", "command", 0);
  for (const [k, cmd] of [["setup", a.setup?.command ?? []], ["validate", a.validate.command]] as const)
    for (const [i, part] of cmd.entries()) if (placeholders(part).length) bad(`the ${k} command takes no placeholders: it runs the same for every run`, k, "command", i);
  for (const [name, v] of Object.entries(a.env)) for (const p of placeholders(v))
    if (!declared.has(p) && !GATEWAY_PLACEHOLDER.test(p)) bad(`{${p}} is neither a declared argument nor {gateway.token}, {gateway.url} or {gateway.<provider>.base_url}`, "env", name);
  // The checkout's write-back paths never nest: each file belongs to exactly one.
  for (const x of a.write_back) for (const y of a.write_back) if (x !== y && (y.startsWith(`${x}/`))) bad(`write_back ${y} is inside ${x}`, "write_back");
  if (new Set(a.write_back).size !== a.write_back.length) bad("a write_back path is listed twice", "write_back");
  // mold_v0-071: the program's result file or a JSON list in the checkout, not both.
  if (a.results_from && a.results) bad("results_from and results both name the run's results: keep one", "results_from");
  if (a.results_from) {
    const rf = a.results_from;
    const temps: [string, string][] = [["check.key", rf.check.key], ["asset.key", rf.asset?.key ?? ""], ["source.key", rf.source?.key ?? ""], ["fingerprint", rf.fingerprint ?? ""],
      ["evidence", rf.evidence ?? ""], ...Object.entries(rf.detail).map(([k, v]) => [`detail.${k}`, v] as [string, string])];
    for (const [where, t] of temps) for (const p of placeholders(t)) if (p.startsWith("$args.") && !declared.has(p.slice(6))) bad(`{${p}} is not a declared argument (args)`, "results_from", ...where.split("."));
  }
  if (new Set(a.tools).size !== a.tools.length) bad("a tool is listed twice", "tools");
  // mold_v0-073: inputs are files of this run only, never part of the workspace nor over the pinned tree's own files.
  for (const [name, i] of Object.entries(a.inputs)) {
    if (underWb(i.path, a.write_back)) bad(`input ${name}: ${i.path} is under a write-back path (an input is the run's, never the workspace's)`, "inputs", name, "path");
    for (const [other, j] of Object.entries(a.inputs)) if (other !== name && (j.path === i.path || j.path.startsWith(`${i.path}/`))) bad(`input ${other}: ${j.path} collides with input ${name}`, "inputs", other, "path");
    if (declared.has(name)) bad(`input ${name} has the name of an argument`, "inputs", name);
    // Never where the runner reads what the run did (its results, its recorded files), nor git's or a tool's own settings.
    if (a.results && (a.results === i.path || a.results.startsWith(`${i.path}/`))) bad(`input ${name}: ${i.path} is the run's results file`, "inputs", name, "path");
    if (a.record.some((g) => globRegex(g).test(i.path))) bad(`input ${name}: ${i.path} matches a recorded file`, "inputs", name, "path");
    if (i.path.split("/").some((seg) => seg === ".git" || seg === "node_modules" || /^\.(npmrc|gitconfig|git-credentials|netrc|bashrc|profile)$/.test(seg))) bad(`input ${name}: ${i.path} is a tool's own settings or code`, "inputs", name, "path");
  }
  // mold_v0-074: a checkout credential is the runner's own: no step and not the command receives it.
  const checkoutCreds = new Set(a.steps.flatMap((s) => s.checkout?.credential ? [s.checkout.credential] : []));
  for (const [i, s] of a.steps.entries()) for (const c of [...s.credentials, ...s.git_credentials.map((g) => g.credential)])
    if (checkoutCreds.has(c)) bad(`${c} is a checkout's credential (the runner's own): no step receives it`, "steps", i, "credentials");
  for (const c of [...(a.credentials ?? []), ...a.git_credentials.map((g) => g.credential)])
    if (checkoutCreds.has(c)) bad(`${c} is a checkout's credential (the runner's own): the command does not receive it`, "credentials");
  // mold_v0-074: steps' names are unique, their placeholders declared; a checkout's mount is a plain path once filled.
  const names = new Set<string>();
  for (const [i, s] of a.steps.entries()) {
    if (names.has(s.name)) bad(`step ${s.name} is declared twice`, "steps", i, "name");
    names.add(s.name);
    if (s.command) {
      if (placeholders(s.command[0]!).length) bad("the program (the command's first element) takes no placeholder", "steps", i, "command", 0);
      for (const [j, part] of s.command.entries()) for (const p of placeholders(part)) if (!declared.has(p)) bad(`{${p}} is not a declared argument (args)`, "steps", i, "command", j);
    }
    if (s.checkout) {
      const c = s.checkout;
      for (const p of placeholders(c.manifests)) if (!declared.has(p)) bad(`{${p}} is not a declared argument (args)`, "steps", i, "checkout", "manifests");
      for (const p of placeholders(c.mount)) if (p !== "name" && !declared.has(p)) bad(`{${p}} is neither {name} nor a declared argument`, "steps", i, "checkout", "mount");
      if (!placeholders(c.mount).includes("name")) bad("the mount needs {name}: one place per repository", "steps", i, "checkout", "mount");
      const filled = (t: string) => t.replace(/\{[^{}]*\}/g, "x");
      if (!globOk(filled(c.manifests))) bad("manifests: a relative glob inside the checkout (no .., no leading /)", "steps", i, "checkout", "manifests");
      if (!relOk(filled(c.mount))) bad("mount: a relative path inside the checkout (no .., no leading /, no glob)", "steps", i, "checkout", "mount");
      const m = filled(c.mount);
      const overlaps = (x: string) => x === m || x.startsWith(`${m}/`) || m.startsWith(`${x}/`);
      // Any filling of the mount ({name} and arguments stand for one path segment each) that is or holds a write-back path.
      const mre = globRegex(c.mount.replace(/\{[^{}]*\}/g, "*"));
      const prefixes = (w: string) => w.split("/").map((_, k, all) => all.slice(0, k + 1).join("/"));
      if (a.write_back.some((w) => prefixes(w).some((x) => mre.test(x)))) bad("mount: a write-back path is at or inside it (the mount would replace the workspace's files)", "steps", i, "checkout", "mount");
      for (const [n, inp] of Object.entries(a.inputs)) if (overlaps(inp.path)) bad(`mount: it overlaps input ${n}`, "steps", i, "checkout", "mount");
      if (a.results && overlaps(a.results)) bad("mount: it overlaps the results file", "steps", i, "checkout", "mount");
      if (c.credential && s.credentials.includes(c.credential)) bad("the checkout's credential is the runner's own, for git: it is not also delivered", "steps", i, "credentials");
    }
    if (s.checkout && s.git_credentials.length) bad("a checkout step authenticates with its checkout.credential", "steps", i, "git_credentials");
  }
});

const relOk = (p: string) => relPath.safeParse(p).success;
const globOk = (p: string) => glob.safeParse(p).success;
const underWb = (rel: string, wb: string[]) => wb.some((w) => rel === w || rel.startsWith(`${w}/`) || w.startsWith(`${rel}/`));
export type AgentWorkspaceConfig = z.output<typeof AgentWorkspaceSchema>;
