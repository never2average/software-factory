/**
 * A pack agent profile's `connection_env` (mold_v0-312; src/connection-env.ts delivers it): a workspace's own
 * connection records (a bucket, an account at a compute provider, a database) given to the profile's sessions as
 * environment variables of their sandbox, never as words of a prompt, a message or a transcript. Pack config only,
 * checked here for gen-packs and the server's install alike (src/pack-api.ts validatePack).
 *
 *   "agent_profiles": [{ "id": "builder", "name": "Builder", "connection_env": [{
 *     "area": "storage_connections",              a workspace area of this pack whose contract reveals nothing
 *     "where": { "kind": "files" },               plain fields the record must hold (optional)
 *     "use": "use_for_files",                     a boolean field the record must have on (optional)
 *     "prefix": "STORAGE_",                       put before every variable's name (optional)
 *     "members_field": "members_may_use",         a boolean field only owners set: on, members' sessions receive it too (optional)
 *     "fields": { "BUCKET": "bucket", "ENDPOINT": "endpoint", "ACCESS_KEY_ID": "access_key_id", "SECRET_ACCESS_KEY": "secret_access_key" }
 *   }]}]
 *
 * One record per entry: of the workspace's records that match, the one changed last. A variable's name (its prefix
 * and name) is ^[A-Z][A-Z0-9_]{0,63}$, never one the session sets itself (PATH, HOME, RUN_*, the gateway's, the proxy's)
 * and never one another entry of the profile sets.
 */
import { z } from "zod";
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../orchestrator/core/env-names.js";

export const CONNECTION_ENV_MAX = 16; // mold_v0-317: was 8 (an app with a connection per building block needs more)
export const CONNECTION_VARS_MAX = 20;
export const ENV_VAR = /^[A-Z][A-Z0-9_]{0,63}$/;
/** What a session's sandbox sets itself (src/agent-harness.ts), or a runner reads: never a connection's variable. */
export const RESERVED_ENV = ["PATH", "HOME", "LANG", "LANGUAGE", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP", "TERM", "TZ", "IFS", "ENV",
  "PS1", "PS4", "CDPATH", "HOSTALIASES", "RESOLV_HOST_CONF", "LOCALDOMAIN", "PROMPT_COMMAND", "MAIL", "EDITOR", "VISUAL", "PAGER", "BROWSER",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "DISABLE_AUTOUPDATER", "DISABLE_TELEMETRY", "ENABLE_TOOL_SEARCH"];
/** Prefixes a loader, an interpreter, TLS or a runner reads (LD_PRELOAD, PYTHONPATH, SSL_CERT_FILE, ...): never a connection's. */
export const RESERVED_ENV_PREFIXES = ["RUN_", ENV_PREFIX, LEGACY_ENV_PREFIX, "ANTHROPIC_", "CLAUDE_", "OPENAI_", "GEMINI_", "CODEX_", "GATEWAY_", "WORKSPACE_",
  "NODE_", "NPM_", "GIT_", "SSH_", "LD_", "DYLD_", "BASH_", "PYTHON", "PERL", "RUBY", "GEM_", "JAVA_", "_JAVA", "JDK_", "SSL_", "CURL_", "REQUESTS_", "GCONV_",
  "LC_", "XDG_", "DOCKER_", "KUBE", "AWS_", "GOOGLE_", "AZURE_", "HISTFILE", "GOPATH", "GOFLAGS", "CARGO_", "RUSTUP_", "PIP_", "UV_", "COREPACK_", "DENO_", "BUN_"];
/** Case-blind (http_proxy as HTTP_PROXY): a name a program reads in either case is reserved in both. */
export const reservedEnv = (n: string) => { const u = n.toUpperCase(); return RESERVED_ENV.includes(u) || RESERVED_ENV_PREFIXES.some((p) => u.startsWith(p)); };

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a field's name");
export const ConnectionEnvSchema = z.object({
  area: fieldName,
  where: z.record(fieldName, z.union([z.string().max(200), z.number().finite(), z.boolean()])).refine((w) => Object.keys(w).length <= 4, "at most 4 conditions").optional(),
  use: fieldName.optional(),
  /** Every variable's name starts with it (required: a connection's names never collide with a program's own). */
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,30}_$/, "capital letters and digits ending in _ (STORAGE_, COMPUTE_)"),
  /**
   * Who may start a session that receives it (default: owners only). Whoever starts the session can read every value
   * delivered (a program can print a variable in a form redaction does not know), so give it only to people who may
   * hold the secrets themselves.
   */
  roles: z.array(z.enum(["owner", "billing", "member"])).min(1).max(3).optional(),
  /**
   * mold_v0-322: a plain boolean field of the area that only the workspace's owners set, by hand (src/secret-binding.ts
   * membersFlagWrite): on a record, a session a member starts receives that record's values too (the record they may
   * read, as frozen at the start). Off (or unset), members receive nothing of it. A member's change of where its secrets
   * go (a delivered field, a secret typed again) turns it off.
   */
  members_field: fieldName.optional(),
  /**
   * mold_v0-332: at most one record of the area (of those matching `where`) has `use` on: a save that turns it on while
   * another has it on is refused, naming the other (not only at a session's start).
   */
  only_one: z.boolean().optional(),
  /**
   * mold_v0-332: a date field (set_by "action") the delivery stamps with the time a session's wake received this
   * record's values (at most once an hour per record).
   */
  last_used: fieldName.optional(),
  // The names are checked by connectionEnvProblems (a key's own error here would only say "Invalid key").
  fields: z.record(z.string().min(1).max(64), fieldName)
    .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= CONNECTION_VARS_MAX, `1 to ${CONNECTION_VARS_MAX} variables`),
}).strict();
export type ConnectionEnv = z.output<typeof ConnectionEnvSchema>;
export const ConnectionEnvListSchema = z.array(ConnectionEnvSchema).min(1).max(CONNECTION_ENV_MAX, `at most ${CONNECTION_ENV_MAX} connections`);

/** Each variable an entry sets: its full name and the field it comes from. */
export const envVars = (c: ConnectionEnv): { env: string; field: string }[] => Object.entries(c.fields).map(([k, f]) => ({ env: `${c.prefix ?? ""}${k}`, field: f }));

interface Area { name?: string; scope?: string; repository?: string; fields?: { name?: string; type?: string; encrypted?: boolean; multiple?: boolean; set_by?: string }[]; contract?: { actions?: Record<string, unknown> }; lifecycle?: { field?: string } }

/**
 * What is wrong with a profile's connection_env against its pack's own areas ([]: nothing): each area a workspace area
 * written by hand whose contract reveals nothing, each field one of its fields holding one plain value, each variable's
 * name well formed, not the session's own and not set twice (nor by the profile's own credentials, `taken`).
 */
export function connectionEnvProblems(raw: unknown, areas: readonly unknown[], taken: readonly string[] = []): string[] {
  const r = ConnectionEnvListSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((e) => `connection_env.${e.path.join(".") || "value"}: ${e.message}`);
  const out: string[] = [];
  const seen = new Map<string, string>(taken.map((t) => [t, "the profile's own credentials"]));
  for (const [i, c] of r.data.entries()) {
    const at = `connection_env[${i}]`;
    const a = (areas as Area[]).find((x) => x?.name === c.area);
    if (!a) { out.push(`${at}.area: this pack declares no record area ${c.area}`); continue; }
    if (a.scope !== "workspace") out.push(`${at}.area: ${c.area} is a shared area: a connection is a workspace's own record (scope workspace)`);
    if (a.repository !== undefined) out.push(`${at}.area: ${c.area} is read from a repository: a workspace's people add its connections by hand`);
    const reveal = a.contract?.actions?.reveal as { none?: unknown } | undefined;
    if (!reveal || typeof reveal !== "object" || Array.isArray(reveal) || typeof reveal.none !== "string")
      out.push(`${at}.area: ${c.area}'s contract reveals nothing (contract.actions.reveal {"none": "<why>"}): its secrets reach a session's environment only, never a person`);
    const field = (n: string) => (a.fields ?? []).find((f) => f?.name === n);
    for (const n of Object.keys(c.where ?? {})) { const f = field(n); if (!f) out.push(`${at}.where: ${c.area} has no field ${n}`); else if (f.encrypted) out.push(`${at}.where: ${n} is encrypted: narrow by a plain field`); }
    if (c.use) { const f = field(c.use); if (!f) out.push(`${at}.use: ${c.area} has no field ${c.use}`); else if (f.type !== "boolean" || f.encrypted) out.push(`${at}.use: ${c.use} is a plain boolean field (the record in use)`); }
    if (c.members_field) {
      const f = field(c.members_field), m = c.members_field;
      if (!f) out.push(`${at}.members_field: ${c.area} has no field ${m}`);
      else if (f.type !== "boolean" || f.encrypted || f.multiple) out.push(`${at}.members_field: ${m} is a plain boolean field (on: members' sessions may receive this record's values)`);
      else if (f.set_by !== undefined) out.push(`${at}.members_field: ${m} is set_by ${JSON.stringify(f.set_by)}: the workspace's owners set it by hand`);
      if (a.lifecycle?.field === m) out.push(`${at}.members_field: ${m} is the lifecycle's field: a move would change it without an owner`);
      if (m === c.use || Object.keys(c.where ?? {}).includes(m) || envVars(c).some((v) => v.field === m)) out.push(`${at}.members_field: ${m} is also the entry's use, where or a delivered field: give the owners' consent a field of its own`);
      if ((c.roles ?? []).includes("member")) out.push(`${at}.members_field: roles already gives members every record: leave member out of roles to let owners decide per record`);
    }
    // mold_v0-332: one record marked at a time, enforced on save; when a session last received the record.
    if (c.only_one && !c.use) out.push(`${at}.only_one: keeps one record marked: name the flag it reads (use)`);
    if (c.last_used) {
      const f = field(c.last_used), n = c.last_used;
      if (!f) out.push(`${at}.last_used: ${c.area} has no field ${n}`);
      else if (f.type !== "date" || f.encrypted || f.multiple) out.push(`${at}.last_used: ${n} is a plain date field (when a session last received the record)`);
      else if (f.set_by !== "action") out.push(`${at}.last_used: ${n} is written by the app only: declare it set_by "action"`);
      // Nor one a test writes (its status or health fields): the test and the delivery never write each other's.
      const probe = ((a as { detail?: { actions?: { kind?: string; probe?: Record<string, unknown> }[] } }).detail?.actions ?? []).find((x) => x?.kind === "test_connection")?.probe;
      if (probe && ["status", "tested", "tested_at", "result", "failing_since", "failures", "expires_on"].some((k) => probe[k] === n)) out.push(`${at}.last_used: ${n} is also a field the area's test writes: give it a field of its own`);
      if (n === c.use || n === c.members_field || Object.keys(c.where ?? {}).includes(n) || envVars(c).some((v) => v.field === n)) out.push(`${at}.last_used: ${n} is also the entry's use, where, members_field or a delivered field: give it a field of its own`);
    }
    if (reservedEnv(c.prefix) || reservedEnv(`${c.prefix}X`)) out.push(`${at}.prefix: ${c.prefix} starts names a program or the session reads itself: choose another prefix`);
    for (const v of envVars(c)) {
      const f = field(v.field);
      // A lifecycle's move changes its field without the write's checks (src/secret-binding.ts): never a delivered field.
      if (a.lifecycle?.field && a.lifecycle.field === v.field) out.push(`${at}.fields.${v.env}: ${v.field} is the lifecycle's field: a move would change it without its secrets' binding`);
      if (!f) out.push(`${at}.fields.${v.env}: ${c.area} has no field ${v.field}`);
      else if (["file", "json", "person"].includes(f.type ?? "text") || f.multiple) out.push(`${at}.fields.${v.env}: ${v.field} is a ${f.multiple ? "list" : `${f.type} field`}: a variable holds one plain value`);
      if (!ENV_VAR.test(v.env)) { out.push(`${at}.fields.${v.env}: a variable's name is capital letters, digits and _, starting with a letter (at most 64, with the prefix)`); continue; }
      if (reservedEnv(v.env)) out.push(`${at}.fields.${v.env}: the session sets ${v.env} itself (or a runner reads it): name the variable otherwise`);
      const before = seen.get(v.env);
      if (before) out.push(`${at}.fields.${v.env}: ${v.env} is also set by ${before}: each variable once`);
      seen.set(v.env, `connection_env[${i}]`);
    }
  }
  return out;
}

/**
 * mold_v0-322: what else of the pack must never set or decide a `members_field` (the owners' consent is theirs alone,
 * set by hand): another entry's `use` or `where` on the area (any profile's), the pack's object storage fields, a field
 * a clock of the area names (its escalations write fields), and a page action that fills or writes it (a create_record's
 * `input`, a test_connection's `status` or `tested`). [] when nothing.
 */
export function membersFieldProblems(profiles: readonly unknown[], areas: readonly unknown[], objectStorage?: unknown): string[] {
  const out: string[] = [];
  const entries = profiles.flatMap((p) => {
    const id = (p as { id?: string })?.id ?? "?";
    return ((p as { connection_env?: unknown[] })?.connection_env ?? []).flatMap((raw, i) => {
      const r = ConnectionEnvSchema.safeParse(raw);
      return r.success ? [{ at: `agent profile ${id}: connection_env[${i}]`, c: r.data }] : [];
    });
  });
  const named = (v: unknown, m: string) => JSON.stringify(v ?? null).includes(JSON.stringify(m));
  for (const { at, c } of entries) {
    // mold_v0-332: an entry's last_used is never one of the object storage's fields (its status and health included).
    const ls = objectStorage as { area?: string; fields?: Record<string, unknown> } | undefined;
    if (c.last_used && ls?.area === c.area && Object.values(ls.fields ?? {}).includes(c.last_used)) out.push(`${at}.last_used: ${c.last_used} is one of the object storage's fields: give it a field of its own`);
    const m = c.members_field;
    if (!m) continue;
    for (const o of entries) if (o.c.area === c.area && (o.c.use === m || Object.keys(o.c.where ?? {}).includes(m)))
      out.push(`${at}.members_field: ${m} is also ${o.at}'s ${o.c.use === m ? "use" : "where"}: the owners' consent is a field of its own`);
    const os = objectStorage as { area?: string; fields?: Record<string, unknown> } | undefined;
    if (os?.area === c.area && Object.values(os.fields ?? {}).includes(m)) out.push(`${at}.members_field: ${m} is one of the object storage's fields: the owners' consent is a field of its own`);
    const area = (areas as { name?: string; clocks?: unknown }[]).find((a) => a?.name === c.area);
    if (area && named(area.clocks, m)) out.push(`${at}.members_field: a clock of ${c.area} names ${m}: nothing but an owner sets the consent`);
    for (const o of entries) if (o.c.area === c.area && o.c.last_used === m) out.push(`${at}.members_field: ${m} is also ${o.at}'s last_used: the owners' consent is a field of its own`);
    for (const a of areas as { name?: string; detail?: { actions?: { kind?: string; area?: string; input?: Record<string, unknown>; probe?: Record<string, unknown> }[] } }[])
      for (const x of a?.detail?.actions ?? []) {
        if (x?.kind === "create_record" && x.area === c.area && Object.prototype.hasOwnProperty.call(x.input ?? {}, m))
          out.push(`${at}.members_field: ${a.name}'s create_record action fills ${m}: nothing but an owner sets the consent`);
        // mold_v0-332: and the health fields it writes (tested_at, result, failing_since, failures).
        if (x?.kind === "test_connection" && a.name === c.area && ["status", "tested", "tested_at", "result", "failing_since", "failures"].some((k) => x.probe?.[k] === m))
          out.push(`${at}.members_field: ${a.name}'s test_connection writes ${m}: nothing but an owner sets the consent`);
      }
  }
  return [...new Set(out)];
}
