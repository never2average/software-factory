/**
 * Encrypted fields (mold_v0-194; molds/mold_v0/MOLD.md "Encrypted fields"): a record area's field declared
 * `encrypted: true` is envelope-encrypted, field by field, with the workspace's data key, the same key and scheme as
 * the company email's secrets and the credentials (src/orgcrypto.ts sealBytes: AES-256-GCM under the workspace's
 * data key, which is kept only wrapped by the app's vault key, APP_VAULT_KEY, in org_keys). No second scheme.
 *
 *   at rest      the stored value is "encf:v1:" + base64(sealBytes(JSON value, aad)), the aad binding it to its
 *                workspace, pack, area, record key and field: a value copied to another record, field or workspace
 *                does not open. Rotating the vault key re-wraps the data keys (src/keyvault.ts rekey, orgcrypto
 *                rewrapOrgKeys) and never touches a field's ciphertext.
 *   reads        every read (lists, a record's page, the MCP tools, exports, the developer API, webhooks) carries
 *                ENCRYPTED_MASK in place of a value; a field with none stays null. The data trail never held values.
 *   writes       a value written is encrypted; ENCRYPTED_MASK or a field left out keeps the stored value (a client
 *                that read the mask and writes the record back changes nothing); null clears it. Input that looks
 *                like an envelope is refused.
 *   reveal       src/record-areas.ts revealFor: the field's `reveal_roles` (default: the roles that may update the
 *                area's records), a `reveal` entry in the data trail.
 *   equality     `searchable: "equality"` keeps a blind index beside the value ("$bi:<field>": HMAC-SHA256 under a key
 *                derived from the workspace's data key, orgcrypto orgMac), so `{field: value}` finds it in SQL, for a
 *                sealed area too; any other operator or a sort is refused. A value's index differs per workspace.
 *   migration    "$enc" on a stored row says which declaration its fields were written under (fieldsTag). A row whose
 *                tag differs (a pack newly marked a field encrypted, or no longer) is rewritten by the scheduler in
 *                batches (src/encrypted-fields-migration.ts): idempotent and resumable, nothing else of the row changes.
 *
 * Everything here is pure or calls orgcrypto: src/record-areas.ts applies it (this module imports none of the store).
 */
import { openBytes, orgMac, sealBytes } from "./orgcrypto.js";
import { PackError } from "./pack-api.js";

/** What a read shows in place of an encrypted field's value. */
export const ENCRYPTED_MASK = "[encrypted]";
/** A stored encrypted value starts with this. */
export const ENVELOPE = "encf:v1:";
/** The stored row's key that says under which declaration its fields were written (never a field: fields start with a letter). */
export const FIELDS_TAG = "$enc";
/** The stored row's keys holding a searchable field's blind index: "$bi:<field>". */
export const BLIND_PREFIX = "$bi:";

export interface EncField { name: string; type?: string; encrypted?: boolean; searchable?: "equality"; reveal_roles?: readonly string[] }
export interface EncArea { pack: string; name: string; fields: readonly EncField[] }

export const encryptedFields = (a: Pick<EncArea, "fields">): EncField[] => a.fields.filter((f) => f.encrypted === true);
export const hasEncryptedFields = (a: Pick<EncArea, "fields">): boolean => a.fields.some((f) => f.encrypted === true);
export const isEncryptedField = (a: Pick<EncArea, "fields">, name: string) => a.fields.some((f) => f.name === name && f.encrypted === true);
export const isEnvelope = (v: unknown): v is string => typeof v === "string" && v.startsWith(ENVELOPE);
/** A stored row's own keys (the tag, blind indexes): never fields, never shown. */
export const isStoreKey = (k: string) => k === FIELDS_TAG || k.startsWith(BLIND_PREFIX);

/** The declaration a row's fields are written under: "v1:" and each encrypted field (=eq when searchable), sorted; null: none. */
export function fieldsTag(a: Pick<EncArea, "fields">): string | null {
  const f = encryptedFields(a);
  return f.length ? `v1:${f.map((x) => `${x.name}${x.searchable ? "=eq" : ""}`).sort().join(",")}` : null;
}

const aad = (orgId: number, a: EncArea, key: string, field: string) => `field/v1/${orgId}/${a.pack}/${a.name}/${key}/${field}`;
/** The text a value is sealed and indexed as. */
const canonical = (v: unknown) => JSON.stringify(v);

/** One value sealed for its workspace, area, record and field (refused while the vault is locked: sealBytes). */
export async function encryptValue(orgId: number, a: EncArea, key: string, field: string, value: unknown): Promise<string> {
  const sealed = await sealBytes(orgId, Buffer.from(canonical(value), "utf8"), aad(orgId, a, key, field));
  return `${ENVELOPE}${sealed.toString("base64")}`;
}
/** One stored value opened; throws when it is not this workspace's, area's, record's and field's. */
export async function decryptValue(orgId: number, a: EncArea, key: string, field: string, stored: string): Promise<unknown> {
  const body = await openBytes(orgId, Buffer.from(stored.slice(ENVELOPE.length), "base64"), aad(orgId, a, key, field));
  return JSON.parse(body.toString("utf8"));
}
/** A searchable field's blind index for one value in one workspace: equal values, equal index; nothing else learnt. */
export const blindIndex = (orgId: number, a: EncArea, field: string, value: unknown): Promise<string> =>
  orgMac(orgId, `blind/v1/${a.pack}/${a.name}/${field}`, canonical(value));

/**
 * Whether a stored record's encrypted field equals `value`, by its blind index (for checks that compare encrypted
 * fields, mold_v0-196: equality only, never the value). `stored` is the row's stored data (src/record-areas.ts).
 */
export async function equalsByIndex(orgId: number, a: EncArea, field: string, stored: Record<string, unknown>, value: unknown): Promise<boolean> {
  const f = a.fields.find((x) => x.name === field);
  if (!f?.encrypted || f.searchable !== "equality") throw new PackError(`field ${field} of ${a.name} is not searchable by equality`, 400);
  const have = stored[`${BLIND_PREFIX}${field}`];
  return typeof have === "string" && have === await blindIndex(orgId, a, field, value);
}

/**
 * A record's data as it is stored: each encrypted field's value sealed (an envelope already stored for this record is
 * kept as it is), each searchable one's blind index, the declaration's tag; a value sealed under a field that is no
 * longer encrypted is opened back. `data` is the record's fields (and the shell's own `$state_at`); store keys in it
 * (a carried-over row's) are recomputed.
 */
export async function sealFields(orgId: number, a: EncArea, key: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!isStoreKey(k)) out[k] = v;
  for (const f of a.fields) {
    const v = out[f.name];
    if (v === null || v === undefined) continue;
    if (f.encrypted) {
      const plain = isEnvelope(v) ? (f.searchable ? await decryptValue(orgId, a, key, f.name, v) : undefined) : v;
      if (!isEnvelope(v)) out[f.name] = await encryptValue(orgId, a, key, f.name, v);
      if (f.searchable) out[`${BLIND_PREFIX}${f.name}`] = await blindIndex(orgId, a, f.name, plain);
    } else if (isEnvelope(v)) out[f.name] = await decryptValue(orgId, a, key, f.name, v);
  }
  const tag = fieldsTag(a);
  if (tag) out[FIELDS_TAG] = tag;
  return out;
}
/** Whether a write to `a` must pass through sealFields (an area with encrypted fields, or a row that held some). */
export const needsSealing = (a: Pick<EncArea, "fields">, data: Record<string, unknown>) =>
  hasEncryptedFields(a) || Object.entries(data).some(([k, v]) => isStoreKey(k) || isEnvelope(v));

/**
 * A stored record's data as every read shows it: an encrypted field's value (sealed, or plain on a row the migration
 * has not reached yet) is ENCRYPTED_MASK; a value sealed under a field that is no longer encrypted is opened (null when
 * it does not open); store keys are left out.
 */
export async function maskFields(orgId: number, a: EncArea, key: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (isStoreKey(k)) continue;
    const f = a.fields.find((x) => x.name === k);
    if (f?.encrypted) out[k] = v === null || v === undefined ? v : ENCRYPTED_MASK;
    else if (isEnvelope(v)) out[k] = await decryptValue(orgId, a, key, k, v).catch(() => null);
    else out[k] = v;
  }
  return out;
}
/** Whether a stored row needs maskFields at all (cheap: rows of areas without encrypted fields pass untouched). */
export const needsMasking = (a: Pick<EncArea, "fields">, data: Record<string, unknown>) =>
  hasEncryptedFields(a) || Object.entries(data).some(([k, v]) => isStoreKey(k) || isEnvelope(v));

/**
 * A write's encrypted fields against what is stored: ENCRYPTED_MASK, or a field left out, keeps the stored value
 * (`carried`, still sealed); null clears it; an envelope given as input is refused (only the store writes one).
 * Returns the input without the carried fields (for the type checks) and the carried values.
 */
export function splitEncryptedInput(a: EncArea, given: unknown, stored: Record<string, unknown> | null): { input: unknown; carried: Record<string, unknown> } {
  if (!hasEncryptedFields(a) || !given || typeof given !== "object" || Array.isArray(given)) return { input: given, carried: {} };
  const input = { ...(given as Record<string, unknown>) };
  const carried: Record<string, unknown> = {};
  for (const k of Object.keys(input)) if (isStoreKey(k)) throw new PackError(`${a.name} has no field ${JSON.stringify(k.slice(0, 64))}`, 400);
  for (const f of encryptedFields(a)) {
    const v = input[f.name];
    if (v === undefined || v === ENCRYPTED_MASK) {
      delete input[f.name];
      const was = stored?.[f.name];
      if (was !== null && was !== undefined) carried[f.name] = was;
    } else if (isEnvelope(v)) throw new PackError(`field ${f.name} of area ${a.name}: a value may not start with ${ENVELOPE} (the store's own form)`, 400);
  }
  return { input, carried };
}

/** A filter or sort on an encrypted field: only `{field: value}` (eq) on a searchable one; refused otherwise. */
export function checkEncryptedQuery(a: EncArea, p: { conds: { target: string; name: string; op: string }[]; sort: { target: string; name: string } }) {
  if (!hasEncryptedFields(a)) return;
  if (p.sort.target === "field" && isEncryptedField(a, p.sort.name)) throw new PackError(`field ${p.sort.name} is encrypted: it cannot be sorted on`, 400);
  for (const c of p.conds) {
    if (c.target !== "field" || !isEncryptedField(a, c.name)) continue;
    const f = a.fields.find((x) => x.name === c.name)!;
    if (f.searchable !== "equality") throw new PackError(`field ${c.name} is encrypted and not searchable: it cannot be filtered on`, 400);
    if (c.op !== "eq") throw new PackError(`field ${c.name} is encrypted: it is filtered by equality only ({"${c.name}": value}), not ${c.op}`, 400);
  }
}

// ---------- the build's checks (src/packs.ts installPacks) ----------

/** Field names a declaration names at these keys, anywhere in it (a metric's or a tab's field references). */
function namedFields(v: unknown, keys: ReadonlySet<string>, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) namedFields(x, keys, out, depth + 1); return out; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (keys.has(k) && typeof x === "string") out.add(x);
    else namedFields(x, keys, out, depth + 1);
  }
  return out;
}
const REF_KEYS = new Set(["field", "group_by", "due", "from", "to", "board_by", "timeline_by", "by"]);

interface BuildPack { id: string; definition: { recordAreas?: readonly unknown[]; repositories?: Record<string, unknown>; metrics?: readonly unknown[]; tabs?: readonly unknown[] } }
/**
 * What the build may not do with an encrypted field (mold_v0-194): an area fed by a repository other than the shell's
 * tables (its rows are the files' or an API's, never sealed here), and a metric or a tab that computes, groups, sorts
 * or filters by one (the shell never reads the value). Each problem one sentence.
 */
export function encryptedFieldProblems(list: readonly BuildPack[]): string[] {
  const problems: string[] = [];
  const enc = new Map<string, { pack: string; fields: Set<string> }>();
  for (const p of list) for (const raw of p.definition.recordAreas ?? []) {
    const a = raw as { name: string; repository?: string; fields?: EncField[] };
    const fields = new Set((a.fields ?? []).filter((f) => f.encrypted).map((f) => f.name));
    if (!fields.size) continue;
    enc.set(a.name, { pack: p.id, fields });
    const kind = a.repository ? (p.definition.repositories?.[a.repository] as { kind?: string } | undefined)?.kind : undefined;
    if (kind && kind !== "shell_tables")
      problems.push(`pack ${p.id}: record area ${a.name} has encrypted fields and reads its rows from repository ${a.repository} (${kind}): encrypted fields are for areas stored in the shell's own tables`);
  }
  if (!enc.size) return problems;
  for (const p of list) {
    for (const m of (p.definition.metrics ?? []) as { name?: string; over?: string }[]) {
      const e = m.over ? enc.get(m.over) : undefined;
      if (!e) continue;
      for (const f of namedFields(m, REF_KEYS)) if (e.fields.has(f)) problems.push(`pack ${p.id}: metric ${m.name} names ${m.over}'s encrypted field ${f}: an encrypted value is never computed on`);
    }
    for (const t of (p.definition.tabs ?? []) as { id?: string; area?: string; areas?: { area: string }[]; filter?: Record<string, unknown>; board_by?: string; timeline_by?: string }[]) {
      for (const name of [t.area, ...(t.areas ?? []).map((x) => x.area)]) {
        const e = name ? enc.get(name) : undefined;
        if (!e) continue;
        for (const f of [...Object.keys(t.filter ?? {}), t.board_by, t.timeline_by]) if (f && e.fields.has(f))
          problems.push(`pack ${p.id}: tab ${t.id} filters, boards or orders ${name} by its encrypted field ${f}: an encrypted value is never read by a tab`);
      }
    }
  }
  return problems;
}
