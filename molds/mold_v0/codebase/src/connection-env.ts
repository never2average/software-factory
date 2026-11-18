/**
 * A workspace's connection records as an agent session's environment (mold_v0-312; the pack profile's `connection_env`,
 * src/connection-env-config.ts).
 *
 *   at start     startSession (src/harness-sessions.ts) freezes, into the session's policy, which variables come from
 *                which area (names only: never a value) when its profile is a pack's that declares connection_env, for
 *                the entries whose area the person who starts it may update (the people who keep those connections);
 *                the session's first system message lists the variables' NAMES.
 *   each wake    the wake's run carries them in its kind (src/agent-harness-config.ts agentJobKind), and its credentials,
 *                fetched with the lease (src/credentials.ts runCredentials), include each entry's record: of the run's
 *                own workspace only, the one matching `where` and `use` changed last, its encrypted fields opened here
 *                with the workspace's key. The runner sets each in the sandbox's environment, never over a variable it
 *                sets itself (src/agent-harness.ts), and holds them as secrets: everything the wake writes (its trace,
 *                its answers) is redacted of them there, and again on the server (src/runs.ts appendEvents and
 *                completion through runSecrets; src/harness-sessions.ts wakeTurn), so a value an agent prints is
 *                "[credential connection:<area>/<VAR>]" in the transcript, the trace, the MCP answers and the logs.
 *   the trail    each record opened is a data-trail line (read, its area and key: never a value); the run's
 *                `credentials` event lists the names delivered and missing.
 */
import { createHash } from "node:crypto";
import type { AccountRole } from "./account-roles.js";
import { ConnectionEnvSchema, envVars, type ConnectionEnv } from "./connection-env-config.js";
import type { Delivered } from "./credentials.js";

/** What a session's policy keeps of one entry (frozen at its start): its record's key and each variable's field. */
export interface FrozenConnectionEnv { pack: string; area: string; key: string;
  /** mold_v0-312: the record's identity and version at the start (its row and the fields this entry reads): a wake delivers only that. */
  version?: string;
  where?: Record<string, string | number | boolean>; use?: string; vars: { env: string; field: string }[] }

/** The pack declaration of a pack profile's connection_env (its row's source is "pack:<id>"), or []. */
export async function declaredConnectionEnv(profile: { id: string; source: string }): Promise<{ pack: string; list: ConnectionEnv[] }> {
  const m = /^pack:(.+)$/.exec(profile.source);
  if (!m) return { pack: "", list: [] };
  const { packs } = await import("./packs.js");
  const p = packs().find((x) => x.id === m[1]);
  const decl = (p?.definition.agentProfiles ?? []).find((x) => (x as { id?: string }).id === profile.id) as { connection_env?: unknown[] } | undefined;
  return { pack: m[1]!, list: (decl?.connection_env ?? []).flatMap((c) => { const r = ConnectionEnvSchema.safeParse(c); return r.success ? [r.data] : []; }) };
}

/** What a start freezes: the entries with their record's key, and the areas that gave none (no record in use). */
export interface ConnectionEnvStart { frozen: FrozenConnectionEnv[]; none: string[] }

/**
 * The entries a session started by `actor` in workspace `orgId` receives (frozen into its policy): each whose `roles`
 * (default owners) hold the person's role and whose area they may update, with its one record as THEY see it (the
 * records they may read, visibility honoured) matching `where` and `use`. Two such records refuse the start: the
 * workspace keeps exactly one in use. A staff member, a key or the system receives none.
 */
export async function connectionEnvForStart(orgId: number, profile: { id: string; source: string }, actor: { kind: string; role: AccountRole | null; user?: string | null }): Promise<ConnectionEnvStart> {
  const { pack, list } = await declaredConnectionEnv(profile);
  const out: ConnectionEnvStart = { frozen: [], none: [] };
  if (!list.length || actor.kind !== "person" || !actor.role) return out;
  const { findArea, may, listFor } = await import("./record-areas.js");
  const { PackError } = await import("./pack-api.js");
  const person = { role: actor.role, userId: actor.user ?? null };
  for (const c of list) {
    const area = findArea(c.area);
    if (!area || area.pack !== pack || area.scope !== "workspace") continue;
    if (!(c.roles ?? ["owner"]).includes(actor.role as never) || !may(area, "update", person)) continue;
    const page = await listFor(orgId, area.name, { filter: { ...(c.where ?? {}), ...(c.use ? { [c.use]: true } : {}) }, sort: "-updated_at", limit: 2 }, person);
    const hits = page.records.filter((r) => matches(c, r.data));
    if (hits.length > 1) throw new PackError(`${area.label} has more than one record ${c.use ? "in use" : "this session would use"} (${hits.map((h) => h.title || h.key).join(", ")}): keep exactly one${c.use ? " in use" : ""}, then start again`, 409);
    if (!hits.length) { out.none.push(area.label); continue; }
    const version = await versionOf(orgId, area, hits[0]!.key, { where: c.where, use: c.use, vars: envVars(c) });
    out.frozen.push({ pack, area: c.area, key: hits[0]!.key, ...(version ? { version } : {}), ...(c.where ? { where: c.where } : {}), ...(c.use ? { use: c.use } : {}), vars: envVars(c) });
  }
  return out;
}

/** The first message's line naming the variables (never a value), or null. */
export function connectionEnvWords(start: ConnectionEnvStart): string | null {
  const parts: string[] = [];
  if (start.frozen.length) parts.push(`This session's environment has these variables from the workspace's connections (their values are never shown here): ${
    start.frozen.map((c) => `${c.vars.map((v) => v.env).join(", ")} (${c.area})`).join("; ")}.`);
  if (start.none.length) parts.push(`No record of ${start.none.join(", ")} is in use: its variables are not set.`);
  return parts.length ? parts.join(" ") : null;
}

const asText = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const matches = (c: { where?: Record<string, unknown>; use?: string }, data: Record<string, unknown>) =>
  Object.entries(c.where ?? {}).every(([k, v]) => data[k] === v) && (!c.use || data[c.use] === true);

/**
 * The record's identity and version as an entry reads it: its row (a deleted and re-added record is another row) and
 * the stored values of the fields it delivers or matches on (a secret as its sealed envelope: typed again, it differs).
 * A status the record's Test writes is not among them, so a Test does not change it. Null when there is no such row.
 */
async function versionOf(orgId: number, area: import("./record-areas.js").RecordArea, key: string, c: { where?: Record<string, unknown>; use?: string; vars: { field: string }[] }): Promise<string | null> {
  const { workspaceStored } = await import("./record-areas.js");
  const { getDb } = await import("./db.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  const [r] = await withViewer(null, () => withTenant(orgId, async () => (await getDb()).query<{ id: string }>(
    "SELECT id FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4", [orgId, area.pack, area.name, key])));
  const row = r ? (await withViewer(null, () => workspaceStored(orgId, area, [key]))).get(key) : undefined;
  if (!r || !row) return null;
  const fields = [...new Set([...c.vars.map((v) => v.field), ...Object.keys(c.where ?? {}), ...(c.use ? [c.use] : [])])].sort();
  return createHash("sha256").update(JSON.stringify([String(r.id), fields.map((f) => [f, (row.data as Record<string, unknown>)[f] ?? null])])).digest("hex");
}

/** A secret shorter than this is never delivered: redaction could not tell it from ordinary words. */
export const SECRET_MIN = 8;

/**
 * The values a wake's run receives for its frozen entries: each the record frozen at the session's start, of the run's
 * own workspace (`orgId`, the run row's), while it still matches `where` and `use`. A variable with no value (the
 * record gone or no longer in use, an empty field, a secret too short or that does not open) is listed in `missing`
 * by name. `audit`: a data-trail read per record (at delivery only). Throws only when `strict` and the vault is locked.
 */
export async function connectionEnvValues(orgId: number, list: readonly FrozenConnectionEnv[], opts: { strict?: boolean; audit?: boolean } = {}): Promise<{ delivered: Delivered[]; missing: string[]; changed: string[] }> {
  const out: { delivered: Delivered[]; missing: string[]; changed: string[] } = { delivered: [], missing: [], changed: [] };
  if (!list.length || !Number.isSafeInteger(orgId) || orgId <= 0) return out;
  const { findArea, workspaceStored } = await import("./record-areas.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  const { decryptValue, isEnvelope } = await import("./encrypted-fields.js");
  const { auditData } = await import("./audit-trail.js");
  const { PackError } = await import("./pack-api.js");
  for (const c of list) {
    const nameOf = (env: string) => `connection:${c.area}/${env}`;
    const area = findArea(c.area);
    const row = area && area.pack === c.pack && area.scope === "workspace" && typeof c.key === "string"
      ? (await withViewer(null, () => workspaceStored(orgId, area, [c.key]))).get(c.key) : undefined;
    const none = () => out.missing.push(...c.vars.map((v) => nameOf(v.env)));
    if (!area || !row || !matches(c, row.data)) { if (area) out.changed.push(area.label); none(); continue; }
    // mold_v0-312: only the record as it was when the session started: changed, replaced or re-added since, nothing.
    if (c.version !== undefined && (await versionOf(orgId, area, c.key, c)) !== c.version) { out.changed.push(area.label); none(); continue; }
    const data = row.data as Record<string, unknown>;
    if (opts.audit) auditData(orgId, { action: "read", pack: area.pack, area: area.name, key: c.key });
    // All or nothing: an entry missing any of its values gives none (an endpoint without its keys is not delivered).
    const mine: Delivered[] = [];
    let whole = true;
    for (const v of c.vars) {
      const raw = data[v.field];
      const encrypted = area.fields.some((f) => f.name === v.field && f.encrypted);
      let value = "";
      if (isEnvelope(raw)) {
        try { value = asText(await withTenant(orgId, () => decryptValue(orgId, area, c.key, v.field, raw))); }
        catch {
          const { vaultUnlocked } = await import("./keyvault.js");
          if (opts.strict && !vaultUnlocked()) throw new PackError("the session's connections cannot be opened now (the key vault is locked?): try again", 503);
        }
      } else value = asText(raw);
      if (!value || (encrypted && value.length < SECRET_MIN)) { whole = false; break; }
      // A plain field (a bucket's name, an endpoint) is no secret: it is not redacted from what the agent writes.
      mine.push({ name: nameOf(v.env), env: v.env, value, ...(encrypted ? {} : { plain: true }) });
    }
    if (whole) out.delivered.push(...mine); else none();
  }
  return out;
}

const noted = new Set<string>();
/**
 * Say in the session's conversation, once per wake, which connections were not given because their record changed
 * since the session started (names only). Never throws.
 */
export async function noteChangedConnections(runId: string, orgId: number, changed: readonly string[]): Promise<void> {
  if (!changed.length || noted.has(runId)) return;
  noted.add(runId);
  try {
    const { getDb } = await import("./db.js");
    const { asPlatform } = await import("./tenant-scope.js");
    const { systemMessage } = await import("./harness-sessions.js");
    await asPlatform(async () => {
      const db = await getDb();
      const [r] = await db.query<{ harness_session_id: string | null }>("/* tenant: the wake's own run, by id */ SELECT harness_session_id FROM runs WHERE id = $1 AND org_id = $2", [runId, orgId]);
      if (r?.harness_session_id) await systemMessage(db, { id: r.harness_session_id, org_id: orgId },
        `${[...new Set(changed)].join(", ")} changed (or was replaced) since this session started, so its variables were not set for this wake. Start a new session to use it as it is now.`, runId);
    });
  } catch (e) { console.error(`connection env: the session's note was not written: ${String((e as Error).message).slice(0, 200)}`); }
}

// ---------------------------------------------------------------- what each run was given (the redaction's set)
//
// mold_v0-320: the app runs on many instances at once (serverless), and a wake's requests (its events, its answers, its
// completion) reach any of them. What a run was given is therefore kept twice:
//   in this process   `given`, for the instance that delivered it (no query; up to WAKE_KEEP_MS)
//   in the database   run_delivered_secrets (0072): each value SEALED with the workspace's data key (orgcrypto sealBytes,
//                     the encrypted fields' key and scheme), its additional data binding it to its workspace, run and
//                     digest (a keyed fingerprint, orgMac: one row per value). Never a plain value at rest, never a plain
//                     hash. Opened by any instance for its redaction; deleted when the attempt ends (src/workspace-
//                     store.ts endAttempt, in the transaction that ends it), and by the run sweep (src/runs.ts
//                     sweepRuns) past expires_at or once the run is no longer running.

const WAKE_KEEP_MS = 6 * 3600_000;
/** At most this long a run's values stay in the database when nothing ended its attempt (the sweep removes them then). */
export const DELIVERED_KEEP_HOURS = 24;
const given = new Map<string, { at: number; secrets: { name: string; value: string }[] }>();
const deliveredAad = (orgId: number, runId: string, digest: string) => `run-delivered/v1/${orgId}/${runId}/${digest}`;
const DIGEST_PURPOSE = "run-delivered/v1";

/**
 * Keep what a run was given (its secrets), so what it writes is redacted of those values on every instance, even after
 * a rotation: in this process, and sealed in the database for the life of the attempt. Never throws: a value that could
 * not be kept for the other instances is said in the log (by its name, never its value), and the frozen records' current
 * values are still redacted everywhere (connectionSecrets).
 */
export async function rememberDelivered(run: { id: string; org_id: number }, delivered: readonly Delivered[]): Promise<void> {
  const now = Date.now();
  for (const [k, v] of given) if (now - v.at > WAKE_KEEP_MS) given.delete(k);
  const was = given.get(run.id)?.secrets ?? [];
  const add = delivered.filter((d) => !d.plain).map((d) => ({ name: d.name, value: d.value }));
  given.set(run.id, { at: now, secrets: [...was, ...add.filter((a) => !was.some((w) => w.value === a.value))] });
  if (!add.length) return;
  try {
    const { orgMac, sealBytes } = await import("./orgcrypto.js");
    const { getDb } = await import("./db.js");
    const { asPlatform } = await import("./tenant-scope.js");
    await asPlatform(async () => {
      const db = await getDb();
      for (const a of add) {
        const digest = await orgMac(run.org_id, DIGEST_PURPOSE, a.value);
        const sealed = (await sealBytes(run.org_id, Buffer.from(a.value, "utf8"), deliveredAad(run.org_id, run.id, digest))).toString("base64");
        await db.query(`/* tenant: the leased run's own delivered values, by run id and its workspace */ INSERT INTO run_delivered_secrets (run_id, org_id, name, digest, sealed, expires_at)
          SELECT id, org_id, $3, $4, $5, now() + make_interval(hours => $6) FROM runs WHERE id = $1 AND org_id = $2 AND status = 'running'
          ON CONFLICT (run_id, digest) DO NOTHING`, [run.id, run.org_id, a.name.slice(0, 300), digest, sealed, DELIVERED_KEEP_HOURS]);
      }
    });
  } catch (e) {
    console.error(`connection env: run ${run.id}: its connection values were not kept for the other instances' redaction (${add.map((a) => a.name).join(", ")}): ${String((e as Error).message).slice(0, 200)}`);
  }
}

/** What run `runId` of workspace `orgId` was given, opened from the database (any instance's delivery). Never throws. */
async function deliveredFromDb(runId: string, orgId: number): Promise<{ name: string; value: string }[]> {
  try {
    const { openBytes } = await import("./orgcrypto.js");
    const { getDb } = await import("./db.js");
    const { asPlatform } = await import("./tenant-scope.js");
    return await asPlatform(async () => {
      const rows = await (await getDb()).query<{ name: string; digest: string; sealed: string }>(
        "/* tenant: the run's own delivered values, by run id and its workspace */ SELECT name, digest, sealed FROM run_delivered_secrets WHERE run_id = $1 AND org_id = $2 AND expires_at > now()", [runId, orgId]);
      const out: { name: string; value: string }[] = [];
      for (const r of rows) {
        try { out.push({ name: r.name, value: (await openBytes(orgId, Buffer.from(r.sealed, "base64"), deliveredAad(orgId, runId, r.digest))).toString("utf8") }); }
        catch { /* not this workspace's, run's or digest's: never a value */ }
      }
      return out;
    });
  } catch { return []; }
}

/** The run sweep (src/runs.ts sweepRuns): values past their time, or of a run no longer running (an end that missed them). */
export async function sweepDelivered(q: import("./db.js").Queryable): Promise<number> {
  const rows = await q.query<{ run_id: string }>(
    `/* tenant: platform sweep across workspaces */ DELETE FROM run_delivered_secrets d WHERE d.expires_at < now()
       OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = d.run_id AND r.org_id = d.org_id AND r.status = 'running') RETURNING d.run_id`);
  return rows.length;
}

/**
 * The connection secrets to redact from what a run writes: every value it was given (this process, and any instance's,
 * from the database), and the frozen records' current values. Never throws, never audits: a redaction lookup never fails
 * or floods what it guards.
 */
export async function connectionSecrets(run: { id?: string; org_id: number; spec: { connection_env?: FrozenConnectionEnv[] } | null }): Promise<{ name: string; value: string }[]> {
  const list = run.spec?.connection_env ?? [];
  if (!list.length) return [];
  const out = [...(run.id ? given.get(run.id)?.secrets ?? [] : [])];
  const push = (d: { name: string; value: string }) => { if (d.value && !out.some((o) => o.value === d.value)) out.push({ name: d.name, value: d.value }); };
  if (run.id) for (const d of await deliveredFromDb(run.id, run.org_id)) push(d);
  try {
    const { auditQuiet } = await import("./audit-trail.js");
    const now = await auditQuiet(() => connectionEnvValues(run.org_id, list, { strict: false, audit: false }));
    for (const d of now.delivered) if (!d.plain) push(d);
  } catch { /* the values given are still redacted */ }
  return out;
}
