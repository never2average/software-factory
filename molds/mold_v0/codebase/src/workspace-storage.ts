/**
 * A workspace's own object storage (mold_v0-305, flag workspace_storage; molds/mold_v0/MOLD.md "Workspace object
 * storage"): a workspace's owners add the bucket its files are kept in (Cloudflare R2, Amazon S3 or any S3-compatible
 * service) as a record of the area a pack declares (pack.json `object_storage`, src/pack-api.ts ObjectStorageDeclSchema),
 * in the customer console. No staff console, no server environment.
 *
 *   the record   the declared area's fields: the bucket, its endpoint (https), the access key id and the secret access
 *                key (both encrypted fields, src/encrypted-fields.ts: sealed with the workspace's data key, masked on
 *                every read, and the area's contract reveals nothing, so they are never shown again, never in a log,
 *                an MCP answer or an export), and the boolean that marks the one in use (`where` narrows the area to
 *                its object-storage rows). A save is refused when the bucket or the endpoint is not one a bucket service
 *                takes (checkStorageRecord, the record store's save checks).
 *   resolution   src/storage.ts asks workspaceBucket(org) for every key stored for a workspace (<kind>/org-<id>/...):
 *                its record marked for use (the latest changed, when several are), else the environment's R2_*, else
 *                the Key vault's Object storage. A record marked for use whose keys cannot be opened (the vault is
 *                locked, the keys were sealed with another vault key) is refused in words: a workspace's files never go
 *                quietly to a bucket its owners did not choose.
 *   the cache    one answer per workspace for VAULT_TTL_MS (a minute), dropped at once when a record of the area changes
 *                in this process (src/record-areas.ts onRecordChange).
 *   everywhere   mold_v0-308: what lists or removes all of a workspace's objects asks its own bucket and the platform's
 *                (src/storage.ts listKeysEverywhere, deleteKeysEverywhere): a workspace's deletion (src/tenancy.ts)
 *                removes its objects from both; the transcript archive (src/archive.ts) writes a workspace's archives to
 *                its own bucket, runs for the workspaces that have one when the platform has none
 *                (workspacesWithStorage), and restores from both.
 *   Test         the record page's `test_storage` action (src/record-page-routes.ts): writes, reads and deletes one small
 *                object with the record's own settings (src/storage.ts testBucket, the Key vault's Test), says what went
 *                wrong in plain words (never a key), and writes the declared status (working, failing; mold_v0-332: could
 *                not test, needs its key: src/connection-test-health.ts) and tested date, and its declared health fields.
 *
 * The keys are opened only here, on the server, for the storage client; nothing returns them.
 */
import { ObjectStorageDeclSchema, PackError, type ObjectStorageDecl } from "./pack-api.js";
import { featureOn } from "./features.js";
import { packs } from "./packs.js";
import type { BucketSettings, BucketTest } from "./storage.js";

/** The build's declaration (one pack's, gen-packs refuses two), with its pack; null when none declares one. */
export function storageDecl(): (ObjectStorageDecl & { pack: string }) | null {
  for (const p of packs()) {
    const d = (p.definition as { objectStorage?: unknown }).objectStorage;
    if (d) return { ...ObjectStorageDeclSchema.parse(d), pack: p.id };
  }
  return null;
}
/** Whether a workspace's own storage is looked for: the flag on and a pack declaring where it is kept. */
export const workspaceStorageOn = (): boolean => featureOn("workspace_storage") && storageDecl() !== null;
/** Whether `area` is the declared storage area. */
export const isStorageArea = (area: string): boolean => workspaceStorageOn() && storageDecl()?.area === area;

const TTL_MS = 60_000;
const cache = new Map<number, { at: number; gen: number; value: { key: string; settings: BucketSettings } | null }>();
let generation = 0;
/** Drop every cached answer now (tests; a record change in this process does it for its workspace). */
export function forgetWorkspaceStorage(orgId?: number) {
  generation++;
  if (orgId === undefined) cache.clear(); else cache.delete(orgId);
}
let listening = false;
async function listen() {
  if (listening) return;
  listening = true;
  const { onRecordChange } = await import("./record-areas.js");
  onRecordChange((c) => { if (c.area === storageDecl()?.area) forgetWorkspaceStorage(c.orgId); });
}

const plain = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const matches = (where: Record<string, unknown> | undefined, data: Record<string, unknown>) =>
  Object.entries(where ?? {}).every(([k, v]) => data[k] === v);

/**
 * The settings of one record of the area, its keys opened (server side only): checked as the Key vault checks its own
 * (src/keyvault.ts checkObjectStorage). Throws in words that never quote a key.
 */
async function settingsOf(orgId: number, key: string, data: Record<string, unknown>): Promise<BucketSettings> {
  const d = storageDecl()!;
  const { findArea } = await import("./record-areas.js");
  const area = findArea(d.area)!;
  const kv = await import("./keyvault.js");
  const { decryptValue, isEnvelope } = await import("./encrypted-fields.js");
  const { withTenant } = await import("./tenant-scope.js");
  const open = async (field: string): Promise<string> => {
    const v = data[field];
    if (v === null || v === undefined || v === "") return "";
    if (!isEnvelope(v)) return plain(v); // written before the field was encrypted (the migration has not reached it yet)
    if (!kv.vaultUnlocked()) throw new Error("its keys cannot be opened while the app's key vault is locked (APP_VAULT_KEY)");
    try { return plain(await withTenant(orgId, () => decryptValue(orgId, area, key, field, v))); }
    catch { throw new Error("its keys do not open with this workspace's key: add them again"); }
  };
  const access_key_id = await open(d.fields.access_key_id), secret_access_key = await open(d.fields.secret_access_key);
  try {
    return kv.checkObjectStorage({ bucket: plain(data[d.fields.bucket]), endpoint: plain(data[d.fields.endpoint]), access_key_id, secret_access_key });
  } catch (e) { throw new Error(fieldWords((e as Error).message, d)); }
}
/** A settings check's message with the area's own field names (bucket: ... -> its bucket field's). */
function fieldWords(message: string, d: ObjectStorageDecl): string {
  const m = /^(bucket|endpoint|access_key_id|secret_access_key): (.*)$/.exec(message);
  return m ? `${d.fields[m[1] as keyof ObjectStorageDecl["fields"]]}: ${m[2]}` : message;
}

/** The workspace's records of the area marked for use, newest change first (plain fields opened, keys still sealed). */
async function inUse(orgId: number): Promise<{ key: string; title: string | null; data: Record<string, unknown> }[]> {
  const d = storageDecl()!;
  const { findArea, workspaceStored } = await import("./record-areas.js");
  const area = findArea(d.area);
  if (!area || area.scope !== "workspace") return [];
  const { getDb } = await import("./db.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  // The shell's own read (no person's visibility, no data-trail line: nothing is shown to anyone).
  const keys = await withViewer(null, () => withTenant(orgId, async () => (await (await getDb()).query<{ key: string }>(
    "SELECT key FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND data -> $4 = 'true'::jsonb ORDER BY updated_at DESC, key LIMIT 20",
    [orgId, area.pack, area.name, d.fields.use])).map((r) => r.key)));
  if (!keys.length) return [];
  const stored = await withViewer(null, () => workspaceStored(orgId, area, keys));
  return keys.flatMap((k) => { const r = stored.get(k); return r && r.data[d.fields.use] === true && matches(d.where, r.data) ? [{ key: k, title: r.title, data: r.data }] : []; });
}

/**
 * mold_v0-308: the workspaces with a record of the area marked for use (the platform's own read, across workspaces, of
 * no key: only which workspaces have one). Empty when workspace storage is off.
 */
export async function workspacesWithStorage(): Promise<number[]> {
  if (!workspaceStorageOn()) return [];
  const d = storageDecl()!;
  const { findArea } = await import("./record-areas.js");
  const area = findArea(d.area);
  if (!area || area.scope !== "workspace") return [];
  const { getDb } = await import("./db.js");
  const { asPlatform } = await import("./tenant-scope.js");
  return asPlatform(async () => (await (await getDb()).query<{ org_id: number }>(
    "/* tenant: the platform's own read across workspaces (which have their own storage; no data) */ SELECT DISTINCT org_id FROM workspace_records WHERE pack = $1 AND area = $2 AND data -> $3 = 'true'::jsonb ORDER BY org_id",
    [area.pack, area.name, d.fields.use])).map((r) => Number(r.org_id)));
}

/**
 * The bucket a workspace keeps its files in: its record marked for use, or null (none: the environment's or the Key
 * vault's). Throws, in words, when that record cannot be used. Cached a minute, dropped on a change of the area.
 */
export async function workspaceBucket(orgId: number): Promise<{ key: string; settings: BucketSettings } | null> {
  if (!workspaceStorageOn() || !Number.isSafeInteger(orgId) || orgId <= 0) return null;
  await listen();
  const hit = cache.get(orgId);
  if (hit && hit.gen === generation && Date.now() - hit.at < TTL_MS) return hit.value;
  const gen = generation;
  const [first] = await inUse(orgId);
  let value: { key: string; settings: BucketSettings } | null = null;
  if (first) {
    try { value = { key: first.key, settings: await settingsOf(orgId, first.key, first.data) }; }
    catch (e) { throw new Error(`object storage: this workspace's storage ${first.title ?? first.key} cannot be used: ${(e as Error).message}`); }
  }
  if (gen === generation) cache.set(orgId, { at: Date.now(), gen, value });
  return value;
}

/**
 * The record store's save check for the storage area (src/record-areas.ts onSaveChecks): a bucket and an endpoint a
 * bucket service takes, when given (a record may be saved unfinished; one marked for use must have both).
 */
export async function checkStorageRecord(area: string, data: Record<string, unknown>): Promise<void> {
  if (!isStorageArea(area)) return;
  const d = storageDecl()!;
  if (!matches(d.where, data)) return;
  const bucket = plain(data[d.fields.bucket]), endpoint = plain(data[d.fields.endpoint]);
  const kv = await import("./keyvault.js");
  if (bucket && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")))
    throw new PackError(`${d.fields.bucket}: 3 to 63 lowercase letters, digits, dots and dashes (the bucket's name, not its address)`, 400);
  if (endpoint) { try { kv.checkEndpoint(endpoint, bucket || undefined); } catch (e) { throw new PackError(fieldWords((e as Error).message, d), 400); } }
  if (data[d.fields.use] === true && (!bucket || !endpoint))
    throw new PackError(`A storage used for this workspace's files names its ${!bucket ? d.fields.bucket : d.fields.endpoint}`, 400);
}

/** What the Test answers: the test's steps and, in one sentence, what it found. */
export interface StorageTestAnswer extends Omit<BucketTest, "endpoint"> { endpoint: string | null; words: string; in_use: boolean }

/**
 * The record page's Test (`test_storage`): one small object written, read back and deleted with this record's own
 * settings; never throws for the bucket's answer, never returns or logs a key. The declared status and tested fields
 * are written when the area has them (as `actor`, who may update the record: the action is offered only then).
 */
export async function testStorageRecord(orgId: number, key: string, actor: { role: import("./account-roles.js").AccountRole | null; userId: string | null }): Promise<StorageTestAnswer> {
  const d = storageDecl();
  if (!d || !workspaceStorageOn()) throw new PackError("Workspace object storage is off in this app", 404);
  const { findArea, workspaceStored, getFor, workspaceRecords } = await import("./record-areas.js");
  const area = findArea(d.area)!;
  // mold_v0-312: this record as the person sees it (visibility honoured): else no test at all.
  if (!(await getFor(orgId, area.name, key, actor))) throw new PackError(`no ${area.name} record ${key}`, 404);
  const row = (await workspaceStored(orgId, area, [key])).get(key);
  if (!row) throw new PackError(`no ${area.name} record ${key}`, 404);
  const inUseNow = row.data[d.fields.use] === true;
  let result: StorageTestAnswer;
  try {
    const settings = await settingsOf(orgId, key, row.data);
    const { testBucket } = await import("./storage.js");
    const t = await testBucket(settings);
    // mold_v0-322: the flags this area's records are used by, as the pack declares them: its own (the workspace's
    // files) and each its agent sessions' connection_env names ("Use in builds"), not only the first.
    const sessions = (await (await import("./connection-env.js")).connectionEnvFlags(area)).filter((f) => f !== d.fields.use)
      .map((f) => (row.data[f] === true ? ` Agent sessions receive it (${fieldLabel(area, f)} is on).` : ` Turn on ${fieldLabel(area, f)} for agent sessions to receive it.`)).join("");
    result = { ...t, in_use: inUseNow, words: t.ok
      ? `It works: a small test file was written to ${t.bucket}, read back and deleted in ${t.ms} ms.${inUseNow ? " This workspace's files are kept there." : ` Turn on ${fieldLabel(area, d.fields.use)} to keep this workspace's files there.`}${sessions}`
      : `It does not work yet: ${t.error}.` };
  } catch (e) {
    result = { ok: false, bucket: plain(row.data[d.fields.bucket]), endpoint: plain(row.data[d.fields.endpoint]) || null, ms: 0, steps: [], error: (e as Error).message, in_use: inUseNow,
      words: `It can't be tested yet: ${(e as Error).message}.` };
  }
  // mold_v0-332: a bucket that answered (or did not) is working or failing; keys that could not be opened, or were
  // refused before any call, could not be tested (needs its key when one is empty): never blamed on the bucket.
  const asked = result.ok || result.steps.length > 0;
  const keyEmpty = [d.fields.access_key_id, d.fields.secret_access_key].some((f) => row.data[f] === undefined || row.data[f] === null || row.data[f] === "");
  const { testOutcome } = await import("./connection-test-health.js");
  const extra = testOutcome(area, row.data, { ok: result.ok, outcome: asked ? (result.ok ? "working" : "unexpected") : "not_ready", words: result.words, keyEmpty: !asked && keyEmpty });
  if (Object.keys(extra).length) {
    // The masked record written back: a masked field keeps its stored value (src/encrypted-fields.ts).
    const shown = await getFor(orgId, area.name, key, actor);
    if (shown) await workspaceRecords(area.pack, orgId, actor).update(area.name, key, { title: shown.title, data: { ...shown.data, ...extra } })
      .catch((e) => console.error(`workspace storage: the test's result was not written to ${area.name} ${key}: ${(e as Error).message}`));
  }
  forgetWorkspaceStorage(orgId);
  return result;
}
const fieldLabel = (area: { fields: readonly { name: string; label: string }[] }, name: string) => `"${area.fields.find((f) => f.name === name)?.label ?? name}"`;
