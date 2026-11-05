/**
 * The workspace credential vault (mold_v0-034; molds/mold_v0/MOLD.md "Pack and record-area contract"). A pack declares
 * credential fields (definePack credentials: src/pack-api.ts CredentialSchema); a workspace's people give the values in
 * the console (src/credential-routes.ts, Settings › Credentials: /app/settings?tab=credentials); a run of one of the pack's job kinds receives the ones its
 * kind names, for the asset and environment it targets (src/run-harness.ts).
 *
 *   store     sql/migrations/0007_workspace_credentials.sql: one row per value, sealed with the workspace's data key
 *             (src/orgcrypto.ts sealBytes: AES-256-GCM, refused while the vault is locked, bound by additional data to
 *             the workspace, pack, field, asset and environment, so a sealed value moved to another row does not open).
 *             The tenant role has no grant on the table: a pack's server code never reads it.
 *   console   lists the fields and, for each stored value, only its last 4 characters; sets, replaces and removes them.
 *             The workspace is the caller's session's; an asset binding must name an asset record of that workspace.
 *             mold_v0-239: each in its own place: Settings › Credentials reads the workspace's (scope "workspace"), a
 *             record's own page the ones bound to that record and its environments (recordCredentials); fields that
 *             share a `group` are set and cleared together (setCredentialGroup, deleteCredentialGroup); a stored
 *             value says when a run (or the shell) last received it (last_used_at, 0043_credential_last_used).
 *   runs      runCredentials(run): the values the run's kind names, looked up with the run row's own workspace (never a
 *             runner's input), its pack, and its targets (targets.asset, a key in the field's asset area;
 *             targets.environment). A value bound to an asset the run does not target is never delivered.
 *
 * No function here logs a value or puts one in an error message.
 */
import { getDb, type Queryable } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { CredentialSchema, OperatorCredentialSchema, PackError, RECORD_KEY, z } from "./pack-api.js";
import { packs } from "./packs.js";
import { checkKey, getFor } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";
import type { Secret } from "./credential-redact.js";

export type CredentialSpec = z.output<typeof CredentialSchema> & { pack: string };

let cache: { from: unknown; list: CredentialSpec[] } | null = null;
/** Every credential field the packs declare, in pack order. */
export function credentialSpecs(): CredentialSpec[] {
  const list = packs();
  if (cache?.from === list) return cache.list;
  cache = { from: list, list: list.flatMap((p) => (p.definition.credentials ?? []).map((c) => ({ ...CredentialSchema.parse(c), pack: p.id }))) };
  return cache.list;
}
export const findCredential = (pack: string, name: string) => credentialSpecs().find((c) => c.pack === pack && c.name === name) ?? null;

const MIN = 8, MAX = 16 * 1024;
const ENV = /^[a-z][a-z0-9_-]{0,39}$/;

/** What the console shows of a field: never a value. */
export const fieldSummary = (c: CredentialSpec) => ({
  pack: c.pack, name: c.name, label: c.label, help: c.help ?? null, bound_to: c.bound_to, area: c.area ?? null,
  environments: c.environments ?? null, deliver_as: deliveredAs(c.deliver_as),
  // mold_v0-014: runs get a GitHub App installation token instead when the workspace has connected one.
  ...(c.github_app ? { github_app: true } : {}),
  ...(c.oauth ? { oauth: c.oauth } : {}),
  // mold_v0-186: the runs go ahead without a value; the console tags the field Optional and says what a value adds.
  ...(c.optional ? { optional: true, adds: c.adds ?? null } : {}),
  // mold_v0-239: its words for the customer, and the credential it is part of.
  purpose: c.purpose ?? null, steps: c.steps ?? null, without: c.without ?? null,
  ...(c.group ? { group: c.group, group_label: groupLead(c).group_label ?? c.label } : {}),
});
/** The first field of a field's group (itself when it has none): it names the credential and carries its words. */
export const groupLead = (c: CredentialSpec) => (c.group ? credentialSpecs().find((x) => x.pack === c.pack && x.group === c.group) ?? c : c);
/** The fields of one group of a pack, in declared order. */
export const groupFields = (pack: string, group: string) => credentialSpecs().filter((c) => c.pack === pack && c.group === group);
/** How a field is delivered: a variable, or a file (and the variable naming its path, mold_v0-075). */
const deliveredAs = (d: CredentialSpec["deliver_as"]): { env: string } | { file: string; path_env?: string } =>
  "env" in d ? { env: d.env } : { file: d.file, ...(d.path_env ? { path_env: d.path_env } : {}) };

export interface Slot { spec: CredentialSpec; asset: string | null; environment: string | null }
/** The slot a value (or an OAuth connection, mold_v0-014) goes in: the field, and the asset and environment its binding needs. */
export const credentialSlot = (pack: unknown, name: unknown, asset: unknown, environment: unknown) => slot(pack, name, asset, environment);
function slot(pack: unknown, name: unknown, asset: unknown, environment: unknown): Slot {
  const spec = typeof pack === "string" && typeof name === "string" ? findCredential(pack, name) : null;
  if (!spec) throw new PackError("no such credential field", 404);
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (spec.bound_to === "workspace") {
    if (has(asset) || has(environment)) throw new PackError(`${spec.label} is one value for the whole workspace: give no asset or environment`, 400);
    return { spec, asset: null, environment: null };
  }
  if (!has(asset)) throw new PackError(`${spec.label} is given per ${spec.bound_to === "asset" ? "asset" : "asset and environment"}: name the asset`, 400);
  const key = checkKey(asset);
  if (spec.bound_to === "asset") {
    if (has(environment)) throw new PackError(`${spec.label} is one value per asset: give no environment`, 400);
    return { spec, asset: key, environment: null };
  }
  if (typeof environment !== "string" || !ENV.test(environment)) throw new PackError("pick one of the environments listed", 400);
  if (spec.environments && !spec.environments.includes(environment)) throw new PackError(`environment must be one of ${spec.environments.join(", ")}`, 400);
  return { spec, asset: key, environment };
}

/** The additional data a value is sealed with: it opens only in its own workspace and slot. */
const aad = (orgId: number, s: Slot) => JSON.stringify(["workspace-credential/v1", orgId, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment]);

export interface StoredCredential {
  pack: string; name: string; bound_to: string; asset: string | null; environment: string | null;
  last4: string; updated_at: string; updated_by: string | null;
  /** mold_v0-239: when a run (or the shell's own use) last received it; null: never since it was set. */
  last_used_at: string | null;
}
interface Row { pack: string; name: string; bound_to: string; asset_key: string | null; environment: string | null; last4: string; updated_at: Date | string; updated_by: string | null; last_used_at: Date | string | null }
const stored = (r: Row): StoredCredential => ({ pack: r.pack, name: r.name, bound_to: r.bound_to, asset: r.asset_key, environment: r.environment,
  last4: r.last4, updated_at: new Date(r.updated_at).toISOString(), updated_by: r.updated_by, last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null });
const COLS = "pack, name, bound_to, asset_key, environment, last4, updated_at, updated_by, last_used_at";

/**
 * Which credentials a list shows (mold_v0-239): all of them (the default, for the API), only the workspace's
 * (Settings › Credentials), or one record's (its own page: the fields bound to its area, the values of that record).
 */
export type CredentialScope = { scope?: "all" | "workspace" } | { area: string; asset: string };

/** A workspace's fields and stored values (last 4 characters only), for the console. */
export async function listCredentials(orgId: number, where: CredentialScope = {}) {
  const record = "area" in where ? where : null;
  const specs = credentialSpecs().filter((c) => record ? c.bound_to !== "workspace" && c.area === record.area
    : (where as { scope?: string }).scope === "workspace" ? c.bound_to === "workspace" : true);
  const rows = await asPlatform(async () => (await getDb()).query<Row>(
    `SELECT ${COLS} FROM workspace_credentials
      WHERE org_id = $1 ${record ? "AND asset_area = $2 AND asset_key = $3" : ""} ORDER BY pack, name, asset_key NULLS FIRST, environment NULLS FIRST`,
    record ? [orgId, record.area, record.asset] : [orgId]));
  // A value whose field a later build no longer declares is not shown (nor delivered): it waits for a build that has it.
  const known = rows.filter((r) => specs.some((c) => c.pack === r.pack && c.name === r.name && c.bound_to === r.bound_to));
  return { fields: specs.map(fieldSummary), values: known.map(stored) };
}

/**
 * The environments a record has, for an environment-bound field (mold_v0-239): the field's fixed list, else the
 * record's own (environments_from: a field of the record holding names, or objects whose `key` holds one), in the
 * record's order, each once. A field that declares neither has none of its own: only those a value is stored under.
 */
export function environmentsOf(spec: CredentialSpec, data: Record<string, unknown> | null): string[] | null {
  if (spec.bound_to !== "environment") return null;
  if (spec.environments) return [...spec.environments];
  if (!spec.environments_from) return null;
  const v = data?.[spec.environments_from.field];
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const k = typeof x === "string" ? x : x && typeof x === "object" && spec.environments_from.key ? (x as Record<string, unknown>)[spec.environments_from.key] : null;
    if (typeof k === "string" && ENV.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * One record's credentials (mold_v0-239): its own page's Credentials card. The fields bound to its area (by the record
 * or by the record and an environment), its stored values, and its environments: the record's own (environmentsOf) and
 * any a value is still stored under. 404 when the record is not one of this workspace's.
 */
export async function recordCredentials(orgId: number, area: unknown, asset: unknown) {
  if (typeof area !== "string" || !credentialSpecs().some((c) => c.bound_to !== "workspace" && c.area === area)) throw new PackError("no credentials belong to these records", 404);
  const key = checkKey(asset);
  const rec = await getFor(orgId, area, key);
  if (!rec) throw new PackError("no such record in this workspace", 404);
  const v = await listCredentials(orgId, { area, asset: key });
  const environments: string[] = [];
  for (const spec of credentialSpecs().filter((c) => c.area === area && c.bound_to === "environment"))
    for (const e of environmentsOf(spec, rec.data) ?? []) if (!environments.includes(e)) environments.push(e);
  for (const s of v.values) if (s.environment && !environments.includes(s.environment)) environments.push(s.environment);
  return { ...v, record: { area, key, title: rec.title ?? key }, environments,
    // Which of them each field takes (a fixed list narrows it), so the console offers only those.
    field_environments: Object.fromEntries(credentialSpecs().filter((c) => c.area === area && c.bound_to === "environment").map((c) => [`${c.pack}/${c.name}`, environmentsOf(c, rec.data)])) };
}

/** A record's environments must include the one a value is set for, when the field reads them from the record. */
async function checkRecordEnvironment(orgId: number, s: Slot) {
  if (s.spec.bound_to !== "environment" || !s.spec.environments_from || s.asset === null) return;
  const rec = await getFor(orgId, s.spec.area!, s.asset);
  if (!rec) throw new PackError(`no ${s.spec.area} record ${s.asset} in this workspace`, 404);
  if (!(environmentsOf(s.spec, rec.data) ?? []).includes(s.environment!)) throw new PackError("pick one of this record's own environments", 400);
}

/**
 * Set (or replace) one value for workspace `orgId`. An asset binding must name an asset record of this workspace.
 * Returns what the console may show: the slot and the last 4 characters.
 */
export async function setCredential(orgId: number, by: string | null, input: { pack?: unknown; name?: unknown; asset?: unknown; environment?: unknown; value?: unknown }): Promise<StoredCredential> {
  const s = slot(input?.pack, input?.name, input?.asset, input?.environment);
  checkValue(input?.value);
  if (s.asset !== null && !(await getFor(orgId, s.spec.area!, s.asset))) throw new PackError(`no ${s.spec.area} record ${s.asset} in this workspace`, 404);
  await checkRecordEnvironment(orgId, s);
  const sealed = await seal(orgId, s, input.value as string);
  const [r] = await asPlatform(async () => upsert(await getDb(), orgId, by, s, sealed, input.value as string));
  return stored(r!);
}

function checkValue(v: unknown, label?: string): asserts v is string {
  const what = label ? `${label}: the value` : "the value";
  if (typeof v !== "string" || v.length < MIN || v.length > MAX) throw new PackError(`${what} must be text of ${MIN} to ${MAX} characters`, 400);
  if (v.includes("\u0000")) throw new PackError(`${what} may not contain a NUL character`, 400);
  if (v.trim() !== v && !v.includes("\n")) throw new PackError(`${what} starts or ends with a space: check what was pasted`, 400);
}
const seal = async (orgId: number, s: Slot, v: string) => (await asPlatform(() => sealBytes(orgId, Buffer.from(v, "utf8"), aad(orgId, s)))).toString("base64");
const upsert = (db: Queryable, orgId: number, by: string | null, s: Slot, sealed: string, v: string) => db.query<Row>(
  `INSERT INTO workspace_credentials (org_id, pack, name, bound_to, asset_area, asset_key, environment, sealed, last4, created_by, updated_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
   ON CONFLICT (org_id, pack, name, (coalesce(asset_key, '')), (coalesce(environment, '')))
   DO UPDATE SET bound_to = excluded.bound_to, asset_area = excluded.asset_area, sealed = excluded.sealed, last4 = excluded.last4,
                 updated_by = excluded.updated_by, updated_at = now(), last_used_at = NULL
   RETURNING ${COLS}`,
  [orgId, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment, sealed, v.slice(-4), by]);

/**
 * Set (or replace) every field of one group at once (mold_v0-239): `values` holds one value per field of the group,
 * all of them (a pair is never half replaced), written in one transaction. Same slot rules as setCredential.
 */
export async function setCredentialGroup(orgId: number, by: string | null, input: { pack?: unknown; group?: unknown; asset?: unknown; environment?: unknown; values?: unknown }): Promise<StoredCredential[]> {
  const fields = typeof input?.pack === "string" && typeof input?.group === "string" ? groupFields(input.pack, input.group) : [];
  if (!fields.length) throw new PackError("no such credential", 404);
  const values = input.values && typeof input.values === "object" && !Array.isArray(input.values) ? input.values as Record<string, unknown> : {};
  const extra = Object.keys(values).filter((k) => !fields.some((f) => f.name === k));
  if (extra.length) throw new PackError(`${groupLead(fields[0]!).group_label ?? fields[0]!.label} has no part ${extra[0]!.slice(0, 64)}`, 400);
  const slots = fields.map((f) => slot(f.pack, f.name, input.asset, input.environment));
  for (const s of slots) checkValue(values[s.spec.name], s.spec.label);
  if (slots[0]!.asset !== null && !(await getFor(orgId, slots[0]!.spec.area!, slots[0]!.asset))) throw new PackError(`no ${slots[0]!.spec.area} record ${slots[0]!.asset} in this workspace`, 404);
  await checkRecordEnvironment(orgId, slots[0]!);
  const sealed: string[] = [];
  for (const s of slots) sealed.push(await seal(orgId, s, values[s.spec.name] as string));
  const rows = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const out: Row[] = [];
    for (const [i, s] of slots.entries()) out.push(...(await upsert(tx, orgId, by, s, sealed[i]!, values[s.spec.name] as string)));
    return out;
  }));
  return rows.map(stored);
}

/** Remove every value of one group in one slot (mold_v0-239): a pair is cleared together. */
export async function deleteCredentialGroup(orgId: number, input: { pack?: unknown; group?: unknown; asset?: unknown; environment?: unknown }): Promise<boolean> {
  const fields = typeof input?.pack === "string" && typeof input?.group === "string" ? groupFields(input.pack, input.group) : [];
  if (!fields.length) throw new PackError("no such credential", 404);
  const slots = fields.map((f) => slot(f.pack, f.name, input.asset, input.environment));
  const n = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    let k = 0;
    for (const s of slots) k += (await tx.query(
      `DELETE FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND coalesce(asset_key, '') = $4 AND coalesce(environment, '') = $5 RETURNING id`,
      [orgId, s.spec.pack, s.spec.name, s.asset ?? "", s.environment ?? ""])).length;
    return k;
  }));
  return n > 0;
}

/** mold_v0-239: when a stored value was last received (by a run, or the shell's own use). Never fails what used it. */
async function touched(orgId: number, s: Slot) {
  try {
    await asPlatform(async () => (await getDb()).query(
      `UPDATE workspace_credentials SET last_used_at = now() WHERE org_id = $1 AND pack = $2 AND name = $3 AND coalesce(asset_key, '') = $4 AND coalesce(environment, '') = $5`,
      [orgId, s.spec.pack, s.spec.name, s.asset ?? "", s.environment ?? ""]));
  } catch (e) { console.error(`workspace ${orgId}: could not record when ${s.spec.pack}/${s.spec.name} was last used: ${(e as Error).message}`); }
}

/** Remove one value of workspace `orgId`. */
export async function deleteCredential(orgId: number, input: { pack?: unknown; name?: unknown; asset?: unknown; environment?: unknown }): Promise<boolean> {
  const s = slot(input?.pack, input?.name, input?.asset, input?.environment);
  return asPlatform(async () => (await (await getDb()).query(
    `DELETE FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND coalesce(asset_key, '') = $4 AND coalesce(environment, '') = $5 RETURNING id`,
    [orgId, s.spec.pack, s.spec.name, s.asset ?? "", s.environment ?? ""])).length > 0);
}

/** Whether workspace `orgId` has any value of a field (any binding): the onboarding checklist's credential condition. */
export async function hasCredential(orgId: number, pack: string, name: string): Promise<{ at: string } | null> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ at: Date | null }>(
    "SELECT min(created_at) AS at FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3", [orgId, pack, name]));
  return r?.at ? { at: new Date(r.at).toISOString() } : null;
}

// ---------- runs ----------

/** What a run receives: each value with the way its field delivers it. */
/**
 * What a run receives: each value with the way its field delivers it. `path_env` (mold_v0-075): the variable that holds
 * the file's full path. `operator`: a value the platform's operators hold (never the workspace's to see).
 */
export interface Delivered {
  name: string; env?: string; file?: string; path_env?: string; operator?: boolean; value: string;
  /**
   * mold_v0-014: when a short-lived token (a GitHub App installation's, an OAuth connection's) stops working. The runner
   * asks for the run's credentials again before then (src/run-harness.ts) and gets a fresh one.
   */
  expires_at?: string;
}
export interface RunCredentials {
  credentials: Delivered[]; missing: string[];
  /**
   * mold_v0-014: the fields delivered as a GitHub App installation token (never the token: the field's name, the
   * repositories it reaches and when it expires), and why a field due one got none.
   */
  github_app?: { name: string; repositories: string[]; expires_at: string }[];
  github_app_missing?: { name: string; reason: string }[];
  /** mold_v0-014: the fields delivered from an OAuth connection (never the token), and why a connected one gave none. */
  oauth?: { name: string; provider: string; expires_at: string | null }[];
  oauth_missing?: { name: string; reason: string }[];
}

/** The part of a run row this needs: its own workspace, pack, frozen kind and targets. */
export interface RunForCredentials { id?: string; org_id: number; pack: string; spec: { credentials?: string[]; operator_credentials?: string[] } | null; targets: Record<string, unknown> | null }

/** The asset (its key, and the area when the run names one) and environment a run targets. */
const targetOf = (targets: Record<string, unknown> | null) => {
  const t = targets ?? {};
  const a = t.asset;
  const asObj = a && typeof a === "object" ? (a as { key?: unknown; area?: unknown }) : null;
  const asset = typeof a === "string" ? a : typeof asObj?.key === "string" ? asObj.key : null;
  const area = typeof asObj?.area === "string" ? asObj.area : null;
  const env = typeof t.environment === "string" && ENV.test(t.environment) ? t.environment : null;
  return { asset: asset && RECORD_KEY.test(asset) ? asset : null, area, environment: env };
};

/**
 * The values a run receives: for each field its kind names (frozen into the run when it started), the one bound to the
 * run's own workspace and the asset and environment it targets. A field with no such value is listed as missing (the
 * program decides what to do without it). The workspace comes from the run row only.
 */
export async function runCredentials(run: RunForCredentials, opts: { strict?: boolean; mint?: boolean } = {}): Promise<RunCredentials> {
  const names = Array.isArray(run.spec?.credentials) ? run.spec!.credentials.filter((n): n is string => typeof n === "string") : [];
  const out: RunCredentials = { credentials: [], missing: [] };
  await operatorCredentials(run, out, opts);
  if (!names.length) return out;
  const { asset, area, environment } = targetOf(run.targets);
  for (const name of names) {
    const spec = findCredential(run.pack, name);
    if (!spec) { out.missing.push(name); continue; }
    const s: Slot = { spec, asset: spec.bound_to === "workspace" ? null : asset, environment: spec.bound_to === "environment" ? environment : null };
    if ((spec.bound_to !== "workspace" && !s.asset) || (spec.bound_to === "environment" && !s.environment)) { out.missing.push(name); continue; }
    // A run that names the asset's area gets a value only for that area's asset (not a same-named key of another area).
    if (spec.bound_to !== "workspace" && area !== null && area !== spec.area) { out.missing.push(name); continue; }
    // mold_v0-014: a GitHub App installation token, minted for this run, when the platform has the app and the workspace
    // an installation of it (else the pasted value below). Never minted while only redacting (runSecrets reads them all).
    if (spec.github_app && run.id && opts.mint !== false) {
      const { installationTokenForRun } = await import("./github-app.js");
      const t = await installationTokenForRun({ runId: run.id, orgId: run.org_id, name, bound_to: spec.bound_to, area: spec.area ?? null, asset: s.asset });
      if (t && "missing" in t) { out.missing.push(name); (out.github_app_missing ??= []).push({ name, reason: t.missing }); continue; }
      if (t) {
        out.credentials.push({ name, ...deliveredAs(spec.deliver_as), value: t.value, expires_at: t.expires_at });
        (out.github_app ??= []).push({ name, repositories: t.repositories, expires_at: t.expires_at });
        continue;
      }
    }
    // mold_v0-014: the slot's OAuth connection, when it has one (its access token, refreshed before it expires); a
    // connection the provider refused to refresh gives nothing (never the pasted value in its place).
    if (spec.oauth && run.id && opts.mint !== false) {
      const { runOAuthToken } = await import("./oauth-connections.js");
      const t = await runOAuthToken(run.id, run.org_id, s);
      if (t && "missing" in t) { out.missing.push(name); (out.oauth_missing ??= []).push({ name, reason: t.missing }); continue; }
      if (t) {
        out.credentials.push({ name, ...deliveredAs(spec.deliver_as), value: t.value, ...(t.expires_at ? { expires_at: t.expires_at } : {}) });
        (out.oauth ??= []).push({ name, provider: spec.oauth, expires_at: t.expires_at });
        continue;
      }
    }
    const [r] = await asPlatform(async () => (await getDb()).query<{ sealed: string }>(
      `SELECT sealed FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND bound_to = $4
          AND coalesce(asset_key, '') = $5 AND coalesce(environment, '') = $6`,
      [run.org_id, spec.pack, spec.name, spec.bound_to, s.asset ?? "", s.environment ?? ""]));
    if (!r) { out.missing.push(name); continue; }
    let value: string;
    try { value = (await asPlatform(() => openBytes(run.org_id, Buffer.from(r.sealed, "base64"), aad(run.org_id, s)))).toString("utf8"); }
    catch (e) {
      // A value that does not open in this slot is not this slot's. While redacting (strict), a value that cannot be
      // opened (the vault locked) refuses the write rather than store it unredacted.
      if (opts.strict) throw new PackError("the run's credentials cannot be opened now (the key vault is locked?): try again", 503);
      void e; out.missing.push(name); continue;
    }
    out.credentials.push({ name, ...deliveredAs(spec.deliver_as), value });
    // Delivered to the run (not only read to redact what it wrote): the value's "last used".
    if (opts.mint !== false && !opts.strict) await touched(run.org_id, s);
  }
  return out;
}

/**
 * mold_v0-184: whether the run's own slot (its workspace, and the asset and environment it targets, exactly as
 * runCredentials looks it up) holds a stored value of any of `names` (each one of the run's frozen kind's credentials).
 * Nothing is opened or minted: a kind's `credential_egress` hosts are added to the run's allowlist at claim only when
 * this is true (a GitHub App or OAuth field counts when a value was pasted; such a field is never named there).
 */
export async function runHasCredential(run: RunForCredentials, names: string[]): Promise<boolean> {
  const own = new Set(Array.isArray(run.spec?.credentials) ? run.spec!.credentials : []);
  const { asset, area, environment } = targetOf(run.targets);
  for (const name of names) {
    if (!own.has(name)) continue;
    const spec = findCredential(run.pack, name);
    if (!spec) continue;
    const s: Slot = { spec, asset: spec.bound_to === "workspace" ? null : asset, environment: spec.bound_to === "environment" ? environment : null };
    if ((spec.bound_to !== "workspace" && !s.asset) || (spec.bound_to === "environment" && !s.environment)) continue;
    if (spec.bound_to !== "workspace" && area !== null && area !== spec.area) continue;
    const [r] = await asPlatform(async () => (await getDb()).query<{ one: number }>(
      `SELECT 1 AS one FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND bound_to = $4
          AND coalesce(asset_key, '') = $5 AND coalesce(environment, '') = $6`,
      [run.org_id, spec.pack, spec.name, spec.bound_to, s.asset ?? "", s.environment ?? ""]));
    if (r) return true;
  }
  return false;
}

/**
 * One workspace-bound value of a pack's field, for the shell's own use on the server (mold_v0-059: an external API
 * repository's credential, sent only in its request header). Never reaches pack code or an answer. Null when unset.
 */
export async function workspaceCredentialValue(orgId: number, pack: string, name: string): Promise<string | null> {
  const spec = findCredential(pack, name);
  if (!spec || spec.bound_to !== "workspace") return null;
  // mold_v0-014: the workspace's GitHub App installation, when it has one, instead of a pasted token.
  if (spec.github_app) {
    const { installationTokenForServer } = await import("./github-app.js");
    const t = await installationTokenForServer(orgId);
    if (t) return t;
  }
  if (spec.oauth) {
    const { serverOAuthToken } = await import("./oauth-connections.js");
    const t = await serverOAuthToken(orgId, { spec, asset: null, environment: null });
    if (t && "missing" in t) throw new PackError(`the ${spec.label} connection needs to be made again (Settings › Credentials): ${t.missing}`, 409);
    if (t) return t.value;
  }
  const s: Slot = { spec, asset: null, environment: null };
  const [r] = await asPlatform(async () => (await getDb()).query<{ sealed: string }>(
    `SELECT sealed FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND bound_to = 'workspace' AND asset_key IS NULL AND environment IS NULL`,
    [orgId, spec.pack, spec.name]));
  if (!r) return null;
  let value: string;
  try { value = (await asPlatform(() => openBytes(orgId, Buffer.from(r.sealed, "base64"), aad(orgId, s)))).toString("utf8"); }
  catch { throw new PackError("the workspace's credential cannot be opened now (the key vault is locked?): try again", 503); }
  await touched(orgId, s);
  return value;
}

// ---------- operator-held credentials (mold_v0-075) ----------

/** The key vault's provider that holds the packs' operator credentials (label "<pack>.<name>"). */
export const OPERATOR_CREDENTIAL_PROVIDER = "pack_credentials";
export type OperatorCredentialSpec = z.output<typeof OperatorCredentialSchema> & { pack: string };
/** Every operator credential the packs declare. Never listed to a workspace (the console's fields are credentialSpecs). */
export const operatorCredentialSpecs = (): OperatorCredentialSpec[] =>
  packs().flatMap((p) => (p.definition.operatorCredentials ?? []).map((c) => ({ ...OperatorCredentialSchema.parse(c), pack: p.id })));
export const operatorVaultLabel = (pack: string, name: string) => `${pack}.${name}`;

/**
 * The operator credentials a run's kind names (frozen into the run): each from the platform's key vault under its pack's
 * label, delivered as its field declares. Missing ones are listed (as "operator:<name>") and the run decides. While
 * redacting (strict) a vault that cannot be read refuses rather than store unredacted output.
 */
async function operatorCredentials(run: RunForCredentials, out: RunCredentials, opts: { strict?: boolean }) {
  const names = Array.isArray(run.spec?.operator_credentials) ? run.spec!.operator_credentials.filter((n): n is string => typeof n === "string") : [];
  if (!names.length) return;
  const { decrypt } = await import("./keyvault.js");
  for (const name of names) {
    const spec = operatorCredentialSpecs().find((c) => c.pack === run.pack && c.name === name);
    if (!spec) { out.missing.push(`operator:${name}`); continue; }
    // The vault is platform data (src/tenant-scope.ts): read as the platform, by the run row's own pack only.
    const [r] = await asPlatform(async () => (await getDb()).query<{ ciphertext: string; iv: string; tag: string; key_id: string }>(
      "SELECT ciphertext, iv, tag, key_id FROM vault_credentials WHERE provider = $1 AND label = $2 AND enabled ORDER BY priority DESC, id LIMIT 1",
      [OPERATOR_CREDENTIAL_PROVIDER, operatorVaultLabel(run.pack, name)]));
    if (!r) { out.missing.push(`operator:${name}`); continue; }
    let value: string;
    try { value = decrypt(r); }
    catch {
      if (opts.strict) throw new PackError("the run's operator credentials cannot be opened now (the key vault is locked?): try again", 503);
      out.missing.push(`operator:${name}`); continue;
    }
    out.credentials.push({ name, ...deliveredAs(spec.deliver_as), operator: true, value });
  }
}

/** The values a run may have received, for redacting what it writes (src/runs.ts events and completion). */
export async function runSecrets(run: RunForCredentials): Promise<Secret[]> {
  if (!run.spec?.credentials?.length && !run.spec?.operator_credentials?.length) return [];
  const pasted = (await runCredentials(run, { strict: true, mint: false })).credentials.map((c) => ({ name: c.name, value: c.value }));
  // mold_v0-014: and every GitHub App token minted for the run (expired or revoked ones too: the run may have printed them).
  const fields = (run.spec?.credentials ?? []).map((n) => findCredential(run.pack, n));
  if (!run.id) return pasted;
  const out = [...pasted];
  if (fields.some((f) => f?.github_app)) out.push(...(await (await import("./github-app.js")).runTokenSecrets(run.id, run.org_id)));
  // mold_v0-014: and every OAuth access token it received, refreshed ones included.
  if (fields.some((f) => f?.oauth)) out.push(...(await (await import("./oauth-connections.js")).runOAuthSecrets(run.id, run.org_id)));
  return out;
}

/**
 * Every value stored for workspace `orgId` (any pack, any binding), for checking that what the console's file viewer
 * serves holds none of them (mold_v0-056; src/workspace-files.ts). Only the shell's own code holds them, for that check;
 * never an answer or a log. A value that does not open (the vault locked, a row moved) refuses the check: it throws.
 */
export async function workspaceSecrets(orgId: number): Promise<Secret[]> {
  const rows = await asPlatform(async () => (await getDb()).query<{ pack: string; name: string; bound_to: string; asset_area: string | null; asset_key: string | null; environment: string | null; sealed: string }>(
    "SELECT pack, name, bound_to, asset_area, asset_key, environment, sealed FROM workspace_credentials WHERE org_id = $1", [orgId]));
  const out: Secret[] = [];
  for (const r of rows) {
    // Opened in the slot its own row names (what it was sealed with), whether or not today's build declares the field
    // the same way: a value a run once received may still be in a file.
    const spec = { pack: r.pack, name: r.name, bound_to: r.bound_to, ...(r.asset_area ? { area: r.asset_area } : {}) } as unknown as CredentialSpec;
    try { out.push({ name: r.name, value: (await asPlatform(() => openBytes(orgId, Buffer.from(r.sealed, "base64"), aad(orgId, { spec, asset: r.asset_key, environment: r.environment })))).toString("utf8") }); }
    catch {
      if (!vaultUnlocked()) throw new PackError("the workspace's credentials cannot be opened now (the key vault is locked): try again", 503);
      // A row that does not open in its own slot (moved, damaged) holds nothing anyone was ever given.
      console.error(`workspace ${orgId}: a stored credential value of ${r.pack}/${r.name} does not open in its own slot`);
    }
  }
  return out;
}
