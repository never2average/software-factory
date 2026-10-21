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
 *   results      a JSON list in the checkout, the run's results (src/runs.ts); default <RUN_OUT>/results.json
 *   record       files of the checkout recorded in the run's events after the run (a session summary, usage): path,
 *                size, sha256 and, for a small JSON file, its content, redacted like everything else
 *   timeout_seconds  the agent command's time limit; past it every process of the run is killed and the run fails
 */
import { z } from "zod";

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
const regexOk = (s: string) => { try { new RegExp(s); return true; } catch { return false; } };

export const AGENT_ARG_SOURCE = /^((scope|targets)(\.[A-Za-z0-9_-]{1,64}){1,4}|run\.(id|attempt|kind))$/;
export const AgentArgSchema = z.object({
  from: z.string().regex(AGENT_ARG_SOURCE, "scope.<key>, targets.<key>[.<key>...] or run.id / run.attempt / run.kind"),
  /** The value must match it in full (anchored); default: letters, digits and . _ : @ / + = -, up to 200. */
  pattern: z.string().min(1).max(200).refine(regexOk, "a regular expression").optional(),
  default: z.string().max(200).optional(),
}).strict();

/** "{name}" placeholders of a string. */
export const placeholders = (s: string) => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
export const GATEWAY_PLACEHOLDER = /^gateway\.(token|url|([a-z][a-z0-9_-]{1,40})\.base_url)$/;

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
  results: relPath.optional(),
  record: z.array(glob).max(20).default([]),
  timeout_seconds: timeout(3600),
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
});
export type AgentWorkspaceConfig = z.output<typeof AgentWorkspaceSchema>;

/** A glob (as `strip` and `record` take it) as a regular expression over relative paths. */
export function globRegex(g: string): RegExp {
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "/" && g.slice(i) === "/**") { out += "(?:/.*)?"; break; } // "dir/**": the directory and all under it
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
