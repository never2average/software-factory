/**
 * The workspace credential vault (mold_v0-034; molds/mold_v0/MOLD.md "Pack and record-area contract"). A pack declares
 * credential fields (definePack credentials: src/pack-api.ts CredentialSchema); a workspace's people give the values in
 * the console (src/credential-routes.ts, /app/credentials); a run of one of the pack's job kinds receives the ones its
 * kind names, for the asset and environment it targets (src/run-harness.ts).
 *
 *   store     sql/migrations/0007_workspace_credentials.sql: one row per value, sealed with the workspace's data key
 *             (src/orgcrypto.ts sealBytes: AES-256-GCM, refused while the vault is locked, bound by additional data to
 *             the workspace, pack, field, asset and environment, so a sealed value moved to another row does not open).
 *             The tenant role has no grant on the table: a pack's server code never reads it.
 *   console   lists the fields and, for each stored value, only its last 4 characters; sets, replaces and removes them.
 *             The workspace is the caller's session's; an asset binding must name an asset record of that workspace.
 *   runs      runCredentials(run): the values the run's kind names, looked up with the run row's own workspace (never a
 *             runner's input), its pack, and its targets (targets.asset, a key in the field's asset area;
 *             targets.environment). A value bound to an asset the run does not target is never delivered.
 *
 * No function here logs a value or puts one in an error message.
 */
import { getDb } from "./db.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { CredentialSchema, PackError, RECORD_KEY, z } from "./pack-api.js";
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
  environments: c.environments ?? null, deliver_as: "env" in c.deliver_as ? { env: c.deliver_as.env } : { file: c.deliver_as.file },
});

interface Slot { spec: CredentialSpec; asset: string | null; environment: string | null }
/** The slot a value goes in: the field, and the asset and environment its binding needs (and nothing it does not). */
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
  if (typeof environment !== "string" || !ENV.test(environment)) throw new PackError("environment: lowercase letters, digits, _ and - (up to 40)", 400);
  if (spec.environments && !spec.environments.includes(environment)) throw new PackError(`environment must be one of ${spec.environments.join(", ")}`, 400);
  return { spec, asset: key, environment };
}

/** The additional data a value is sealed with: it opens only in its own workspace and slot. */
const aad = (orgId: number, s: Slot) => JSON.stringify(["workspace-credential/v1", orgId, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment]);

export interface StoredCredential {
  pack: string; name: string; bound_to: string; asset: string | null; environment: string | null;
  last4: string; updated_at: string; updated_by: string | null;
}
interface Row { pack: string; name: string; bound_to: string; asset_key: string | null; environment: string | null; last4: string; updated_at: Date | string; updated_by: string | null }
const stored = (r: Row): StoredCredential => ({ pack: r.pack, name: r.name, bound_to: r.bound_to, asset: r.asset_key, environment: r.environment,
  last4: r.last4, updated_at: new Date(r.updated_at).toISOString(), updated_by: r.updated_by });

/** A workspace's fields and stored values (last 4 characters only), for the console. */
export async function listCredentials(orgId: number) {
  const specs = credentialSpecs();
  const rows = await asPlatform(async () => (await getDb()).query<Row>(
    `SELECT pack, name, bound_to, asset_key, environment, last4, updated_at, updated_by FROM workspace_credentials
      WHERE org_id = $1 ORDER BY pack, name, asset_key NULLS FIRST, environment NULLS FIRST`, [orgId]));
  // A value whose field a later build no longer declares is not shown (nor delivered): it waits for a build that has it.
  const known = rows.filter((r) => specs.some((c) => c.pack === r.pack && c.name === r.name && c.bound_to === r.bound_to));
  return { fields: specs.map(fieldSummary), values: known.map(stored) };
}

/**
 * Set (or replace) one value for workspace `orgId`. An asset binding must name an asset record of this workspace.
 * Returns what the console may show: the slot and the last 4 characters.
 */
export async function setCredential(orgId: number, by: string | null, input: { pack?: unknown; name?: unknown; asset?: unknown; environment?: unknown; value?: unknown }): Promise<StoredCredential> {
  const s = slot(input?.pack, input?.name, input?.asset, input?.environment);
  const v = input?.value;
  if (typeof v !== "string" || v.length < MIN || v.length > MAX) throw new PackError(`the value must be text of ${MIN} to ${MAX} characters`, 400);
  if (v.includes("\u0000")) throw new PackError("the value may not contain a NUL character", 400);
  if (v.trim() !== v && !v.includes("\n")) throw new PackError("the value starts or ends with a space: check what was pasted", 400);
  if (s.asset !== null && !(await getFor(orgId, s.spec.area!, s.asset))) throw new PackError(`no ${s.spec.area} record ${s.asset} in this workspace`, 404);
  const sealed = (await asPlatform(() => sealBytes(orgId, Buffer.from(v, "utf8"), aad(orgId, s)))).toString("base64");
  const [r] = await asPlatform(async () => (await getDb()).query<Row>(
    `INSERT INTO workspace_credentials (org_id, pack, name, bound_to, asset_area, asset_key, environment, sealed, last4, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (org_id, pack, name, (coalesce(asset_key, '')), (coalesce(environment, '')))
     DO UPDATE SET bound_to = excluded.bound_to, asset_area = excluded.asset_area, sealed = excluded.sealed, last4 = excluded.last4,
                   updated_by = excluded.updated_by, updated_at = now()
     RETURNING pack, name, bound_to, asset_key, environment, last4, updated_at, updated_by`,
    [orgId, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment, sealed, v.slice(-4), by]));
  return stored(r!);
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
export interface Delivered { name: string; env?: string; file?: string; value: string }
export interface RunCredentials { credentials: Delivered[]; missing: string[] }

/** The part of a run row this needs: its own workspace, pack, frozen kind and targets. */
export interface RunForCredentials { org_id: number; pack: string; spec: { credentials?: string[] } | null; targets: Record<string, unknown> | null }

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
export async function runCredentials(run: RunForCredentials, opts: { strict?: boolean } = {}): Promise<RunCredentials> {
  const names = Array.isArray(run.spec?.credentials) ? run.spec!.credentials.filter((n): n is string => typeof n === "string") : [];
  const out: RunCredentials = { credentials: [], missing: [] };
  if (!names.length) return out;
  const { asset, area, environment } = targetOf(run.targets);
  for (const name of names) {
    const spec = findCredential(run.pack, name);
    if (!spec) { out.missing.push(name); continue; }
    const s: Slot = { spec, asset: spec.bound_to === "workspace" ? null : asset, environment: spec.bound_to === "environment" ? environment : null };
    if ((spec.bound_to !== "workspace" && !s.asset) || (spec.bound_to === "environment" && !s.environment)) { out.missing.push(name); continue; }
    // A run that names the asset's area gets a value only for that area's asset (not a same-named key of another area).
    if (spec.bound_to !== "workspace" && area !== null && area !== spec.area) { out.missing.push(name); continue; }
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
    out.credentials.push({ name, ...("env" in spec.deliver_as ? { env: spec.deliver_as.env } : { file: spec.deliver_as.file }), value });
  }
  return out;
}

/**
 * One workspace-bound value of a pack's field, for the shell's own use on the server (mold_v0-059: an external API
 * repository's credential, sent only in its request header). Never reaches pack code or an answer. Null when unset.
 */
export async function workspaceCredentialValue(orgId: number, pack: string, name: string): Promise<string | null> {
  const spec = findCredential(pack, name);
  if (!spec || spec.bound_to !== "workspace") return null;
  const s: Slot = { spec, asset: null, environment: null };
  const [r] = await asPlatform(async () => (await getDb()).query<{ sealed: string }>(
    `SELECT sealed FROM workspace_credentials WHERE org_id = $1 AND pack = $2 AND name = $3 AND bound_to = 'workspace' AND asset_key IS NULL AND environment IS NULL`,
    [orgId, spec.pack, spec.name]));
  if (!r) return null;
  try { return (await asPlatform(() => openBytes(orgId, Buffer.from(r.sealed, "base64"), aad(orgId, s)))).toString("utf8"); }
  catch { throw new PackError("the workspace's credential cannot be opened now (the key vault is locked?): try again", 503); }
}

/** The values a run may have received, for redacting what it writes (src/runs.ts events and completion). */
export async function runSecrets(run: RunForCredentials): Promise<Secret[]> {
  if (!run.spec?.credentials?.length) return [];
  return (await runCredentials(run, { strict: true })).credentials.map((c) => ({ name: c.name, value: c.value }));
}
