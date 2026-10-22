/**
 * What a pack declares about its workspace store (mold_v0-056; src/workspace-store.ts holds the snapshots): how long
 * old versions are kept (src/workspace-retention.ts sweeps them daily) and which of its files the console's file viewer
 * (src/workspace-files.ts) never shows. No database, no keys: the schema, the policy and the path rules only.
 *
 *   workspace_store.retention     keep_last (the newest N versions) and/or keep_days (versions committed within D
 *                                 days): a version is kept when either declared rule keeps it, and only within the
 *                                 platform's ceiling (the newest OCTILLION_WORKSPACE_RETENTION_MAX_VERSIONS, default 100,
 *                                 committed within OCTILLION_WORKSPACE_RETENTION_MAX_DAYS, default 365), a hard bound; a
 *                                 pack that declares nothing gets the ceiling itself. Whatever the rules say, the latest
 *                                 version and every version a run result or a report references are kept
 *   workspace_store.secret_paths  globs (* one segment, ** any depth, ? a character) of files the viewer never shows,
 *                                 lists or serves, besides the shell's own: hidden paths (a segment starting with "."),
 *                                 credential-looking files (keys, certificates, keystores, credentials files), the files
 *                                 the pack's credential fields are delivered as, and the pack's agent kinds' `strip`
 */
import { z } from "zod";
import { globRegex } from "./agent-workspace-paths.js";

const segment = (s: string) => s !== "" && s !== "." && s !== "..";
/** A glob over a workspace's relative paths (as an agent kind's `strip`): no leading /, no .., no [ ] { }. */
const glob = z.string().min(1).max(300)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f[\]{}]/.test(p) && p.split("/").every(segment), "a relative glob inside the workspace (no .., no leading /, no [ ] { })");

export const RetentionSchema = z.object({
  /** Keep the newest N versions. */
  keep_last: z.number().int().min(1).max(100_000).optional(),
  /** Keep the versions committed within the last D days. */
  keep_days: z.number().int().min(1).max(36_500).optional(),
}).strict().refine((r) => r.keep_last !== undefined || r.keep_days !== undefined, "declare keep_last, keep_days or both");

export const WorkspaceStoreSchema = z.object({
  retention: RetentionSchema.optional(),
  secret_paths: z.array(glob).max(100).default([]),
  $comment: z.string().max(2000).optional(),
}).strict();
export type WorkspaceStoreSettings = z.output<typeof WorkspaceStoreSchema>;

// ---------- retention ----------

const num = (v: string | undefined, def: number) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : def; };
/** The platform's ceiling: whatever a pack declares, no version is kept past the newest keep_last nor past keep_days. */
export const retentionCeiling = () => ({
  keep_last: num(process.env.OCTILLION_WORKSPACE_RETENTION_MAX_VERSIONS, 100),
  keep_days: num(process.env.OCTILLION_WORKSPACE_RETENTION_MAX_DAYS, 365),
});

/**
 * The rules a store's sweep applies: the pack's (null for a rule not declared) and the ceiling (max_versions,
 * max_days), which bounds every version but the protected ones and the latest.
 */
export interface RetentionPolicy { keep_last: number | null; keep_days: number | null; max_versions: number; max_days: number; source: "pack" | "platform" }

/** The pack's declared rules, each at most the ceiling; the ceiling itself when the pack declares none. */
export function retentionPolicy(declared: { keep_last?: number; keep_days?: number } | null | undefined): RetentionPolicy {
  const c = retentionCeiling();
  const max = { max_versions: c.keep_last, max_days: c.keep_days };
  if (!declared || (declared.keep_last === undefined && declared.keep_days === undefined)) return { ...c, ...max, source: "platform" };
  return {
    keep_last: declared.keep_last === undefined ? null : Math.min(declared.keep_last, c.keep_last),
    keep_days: declared.keep_days === undefined ? null : Math.min(declared.keep_days, c.keep_days),
    ...max, source: "pack",
  };
}

/**
 * Which of a store's committed versions expire. Kept: the latest always, and every one in `protect` (referenced by a
 * result, a report or a store lease's checkout). Any other is kept only when a declared rule keeps it (among the newest
 * keep_last, or committed within keep_days) and the ceiling allows it (among the newest max_versions and within
 * max_days): the ceiling is a hard bound, so a rule never keeps an unbounded number of versions.
 */
export function expiredVersions(versions: readonly { version: number; committed_at: Date | string | null }[], policy: RetentionPolicy, protect: ReadonlySet<number>, now: Date): number[] {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const day = 86_400_000;
  const cutoff = policy.keep_days === null ? null : now.getTime() - policy.keep_days * day;
  const ceiling = now.getTime() - policy.max_days * day;
  return sorted.filter((v, i) => {
    if (i === 0 || protect.has(v.version)) return false;
    // A version with no commit time (never: committed rows have one) is kept rather than guessed at.
    const at = v.committed_at === null ? null : new Date(v.committed_at).getTime();
    if (at === null || Number.isNaN(at)) return false;
    if (i >= policy.max_versions || at < ceiling) return true;
    if (policy.keep_last !== null && i < policy.keep_last) return false;
    if (cutoff !== null && at >= cutoff) return false;
    return true;
  }).map((v) => v.version);
}

// ---------- what the viewer never shows ----------

/**
 * Files that hold credentials by their name, at any depth (the viewer never shows them, whatever the pack declares):
 * private keys and certificates, keystores, SSH keys, cloud and cluster credentials, environment files.
 */
export const SHELL_SECRET_PATHS = [
  "**/*.pem", "**/*.key", "**/*.crt", "**/*.cer", "**/*.der", "**/*.p8", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.keystore",
  "**/*.kdbx", "**/*.ppk", "**/*.gpg", "**/*.asc", "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*",
  "**/credentials", "**/credentials.*", "**/*credentials*.json", "**/*secret*", "**/*Secret*", "**/*SECRET*", "**/*.env", "**/env",
  "**/service-account*.json", "**/*service_account*.json", "**/kubeconfig", "**/*.kubeconfig", "**/htpasswd", "**/*.tfstate", "**/*.tfstate.*",
  "**/*.tfvars", "**/token", "**/token.*", "**/*.token", "**/auth.json", "**/netrc", "**/_netrc", "**/pgpass",
  // Everything under a directory named like one.
  "**/npmrc", "**/pypirc", "**/aws/config", "**/kube/config", "**/docker/config.json", "**/git-credentials",
  "**/*secret*/**", "**/credentials/**", "**/private_keys/**", "**/private-keys/**",
] as const;

export interface PathRules { secret: RegExp[]; files: Set<string> }

/** A store's path rules: the shell's, the pack's secret_paths and its agent kinds' strip, its credential files' names. */
export function pathRules(pack: {
  workspaceStore?: { secret_paths?: string[] } | null;
  agentJobKinds?: { agent?: { strip?: string[] } }[];
  credentials?: { deliver_as?: { file?: string } | { env?: string } }[];
} | null | undefined): PathRules {
  const globs = [...SHELL_SECRET_PATHS, ...(pack?.workspaceStore?.secret_paths ?? []), ...(pack?.agentJobKinds ?? []).flatMap((k) => k.agent?.strip ?? [])];
  const files = new Set((pack?.credentials ?? []).map((c) => (c.deliver_as && "file" in c.deliver_as ? c.deliver_as.file : undefined)).filter((f): f is string => !!f).map((f) => f.toLowerCase()));
  // A pack's glob is matched at its own depth and, written without a directory, at any depth too ("*.sqlite" anywhere).
  const regexes = [...new Set(globs)].flatMap((g) => (g.includes("/") ? [globRegex(g)] : [globRegex(g), globRegex(`**/${g}`)]));
  return { secret: regexes, files };
}

/**
 * Why the viewer never shows `p`: "hidden" (a segment starts with "."), "secret" (a credential file by its name, a
 * file the pack declares secret or strips, a file a credential is delivered as), or null. Case-insensitive on names.
 */
export function pathRefusal(p: string, rules: PathRules): "hidden" | "secret" | null {
  const parts = p.split("/");
  if (parts.some((s) => s.startsWith("."))) return "hidden";
  const base = parts[parts.length - 1]!;
  if (rules.files.has(base.toLowerCase())) return "secret";
  const lower = p.toLowerCase();
  if (rules.secret.some((r) => r.test(p) || r.test(lower))) return "secret";
  return null;
}
