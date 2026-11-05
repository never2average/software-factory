/**
 * Webhooks in (mold_v0-193): a generic receiver that writes a verified payload into one of the build's workspace record
 * areas, as the pack declares (pack.json developer_surface.webhooks_in: the area, JSON Pointers to the key, the title and
 * each field, optionally a list of items, optionally the payload types it takes): a scanner's findings, a ticket
 * system's issues, any import, with no code.
 *
 * A workspace adds a source for one receiver (webhook_sources): an id (its address, POST /v1/inbound/<id>) and a signing
 * secret of its own (whsec_..., sealed, shown once). The sender signs as Standard Webhooks does; a payload is written
 * only when its signature verifies within 5 minutes of its timestamp. The same webhook-id is written once (kept 24 hours
 * with the idempotency keys). Every item of one payload is written as one batch (all or none), through the record store
 * (the area's fields, references and lifecycle), as `inbound:<source id>`; an existing record is replaced (its state
 * kept). The writes raise the record events like any other (webhooks out).
 */
import { randomBytes } from "node:crypto";
import { pointer } from "./developer-config.js";
import { ApiProblem, developerSurface } from "./developer-surface.js";
import { verifySigned, newSecret } from "./developer-webhooks.js";
import { getDb } from "./db.js";
import { open, seal } from "./orgcrypto.js";
import type { RecordOperation } from "./pack-api.js";
import { asWriter, recordAreas, workspaceRecords } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

/** The most items one payload may write. */
export const MAX_ITEMS = 1000;

const receiverOf = (name: unknown) => {
  const r = (developerSurface()?.webhooks_in ?? []).find((x) => x.name === name);
  if (!r) throw new ApiProblem(400, "invalid_receiver", `receiver: one of ${(developerSurface()?.webhooks_in ?? []).map((x) => x.name).join(", ") || "(this app has none)"}`);
  return r;
};

interface SourceRaw { id: string; org_id: number; receiver: string; description: string | null; secret_sealed: string; created_at: Date; disabled_at: Date | null; last_received_at: Date | null; received: number }
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const view = (s: SourceRaw) => ({ id: s.id, receiver: s.receiver, description: s.description, path: `/v1/inbound/${s.id}`, created_at: iso(s.created_at),
  disabled_at: iso(s.disabled_at), last_received_at: iso(s.last_received_at), received: s.received });
const COLS = "id, org_id, receiver, description, secret_sealed, created_at, disabled_at, last_received_at, received";

export async function createSource(orgId: number, input: { receiver?: unknown; description?: unknown }, by: string | null) {
  const r = receiverOf(input.receiver);
  const secret = newSecret(), id = `src_${randomBytes(12).toString("base64url")}`;
  const sealed = await asPlatform(() => seal(orgId, secret));
  const description = typeof input.description === "string" ? input.description.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null : null;
  const [s] = await asPlatform(async () => {
    const db = await getDb();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_sources WHERE org_id = $1", [orgId]);
    if (n >= 20) throw new ApiProblem(409, "too_many_sources", "at most 20 inbound sources a workspace");
    return db.query<SourceRaw>(`INSERT INTO webhook_sources (id, org_id, receiver, description, secret_sealed, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [id, orgId, r.name, description, sealed, by]);
  });
  return { ...view(s!), secret };
}
export async function listSources(orgId: number) {
  return (await asPlatform(async () => (await getDb()).query<SourceRaw>(`SELECT ${COLS} FROM webhook_sources WHERE org_id = $1 ORDER BY created_at, id`, [orgId]))).map(view);
}
/**
 * A source's last deliveries (mold_v0-201, the console's Inbound tab): the messages written in the last 24 hours, newest
 * first, from what the idempotency keys keep of each (its webhook-id, when, what was written). A message refused (a bad
 * signature, a payload that did not fit) was not written and is not kept: only received ones are listed.
 */
export async function listSourceDeliveries(orgId: number, id: string, limit = 20) {
  const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 20, 1), 100);
  const rows = await asPlatform(async () => (await getDb()).query<{ idem_key: string; state: string; response: Record<string, unknown> | null; created_at: Date }>(
    `SELECT idem_key, state, response, created_at FROM idempotency_keys WHERE org_id = $1 AND scope = $2 ORDER BY created_at DESC LIMIT $3`,
    [orgId, `inbound:${String(id)}`, n]));
  return rows.map((r) => ({
    id: r.idem_key, at: iso(r.created_at), state: r.state === "done" ? "written" : "writing",
    written: typeof r.response?.written === "number" ? r.response.written : null, area: typeof r.response?.area === "string" ? r.response.area : null,
    skipped: typeof r.response?.skipped === "string" ? r.response.skipped : null,
  }));
}
export async function deleteSource(orgId: number, id: string): Promise<boolean> {
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM webhook_sources WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, String(id)]))).length > 0;
}

/**
 * A payload sent to source `id`: verified with its secret, written into its receiver's area. Answers what was written,
 * or the first answer again for a webhook-id already received.
 */
export async function receive(id: string, headers: Record<string, string | string[] | undefined>, raw: string) {
  const cfg = developerSurface();
  if (!cfg?.webhooks_in?.length || !/^src_[A-Za-z0-9_-]{8,40}$/.test(id)) throw new ApiProblem(404, "not_found", "Not found");
  const [s] = await asPlatform(async () => (await getDb()).query<SourceRaw>(`/* tenant: the source found by its id; its workspace is checked by its secret */ SELECT ${COLS} FROM webhook_sources WHERE id = $1 AND disabled_at IS NULL`, [id]));
  if (!s) throw new ApiProblem(404, "not_found", "Not found");
  const secret = await asPlatform(() => open(s.org_id, s.secret_sealed));
  const { id: msgId } = verifySigned(secret, headers, raw);
  // The same message twice is written once: its webhook-id is kept with the idempotency keys.
  const seen = await asPlatform(async () => (await getDb()).query<{ response: unknown; state: string }>(
    `INSERT INTO idempotency_keys (org_id, scope, idem_key, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, scope, idem_key) DO UPDATE SET org_id = idempotency_keys.org_id RETURNING response, state, (xmax <> 0) AS replay`,
    [s.org_id, `inbound:${s.id}`, msgId.slice(0, 255), "inbound"]));
  const prior = seen[0] as { response: unknown; state: string; replay?: boolean } | undefined;
  if (prior?.replay) {
    if (prior.state === "done") return { replayed: true, ...(prior.response as Record<string, unknown>) };
    throw new ApiProblem(409, "in_progress", "This message is being written: send it again later");
  }
  try {
    const out = await write(s, raw);
    await asPlatform(async () => (await getDb()).query("UPDATE idempotency_keys SET state = 'done', status_code = 200, response = $4 WHERE org_id = $1 AND scope = $2 AND idem_key = $3",
      [s.org_id, `inbound:${s.id}`, msgId.slice(0, 255), JSON.stringify(out)]));
    return out;
  } catch (e) {
    // Not written: the same message may be sent again.
    await asPlatform(async () => (await getDb()).query("DELETE FROM idempotency_keys WHERE org_id = $1 AND scope = $2 AND idem_key = $3", [s.org_id, `inbound:${s.id}`, msgId.slice(0, 255)]));
    throw e;
  }
}

async function write(s: SourceRaw, raw: string) {
  const r = receiverOf(s.receiver);
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new ApiProblem(400, "invalid_request", "the payload must be JSON"); }
  const type = (payload as { type?: unknown })?.type;
  if (r.types?.length && !(typeof type === "string" && r.types.includes(type))) {
    await touch(s);
    return { written: 0, skipped: `type ${typeof type === "string" ? type.slice(0, 80) : "(none)"} is not one this receiver takes` };
  }
  const items = r.items !== undefined ? pointer(payload, r.items) : [payload];
  if (!Array.isArray(items)) throw new ApiProblem(422, "unprocessable", `${r.items} is not a list in the payload`);
  if (items.length > MAX_ITEMS) throw new ApiProblem(413, "too_large", `at most ${MAX_ITEMS} items a payload`);
  const area = recordAreas().find((a) => a.name === r.area)!;
  const ops: RecordOperation[] = items.map((it, i) => {
    const k = pointer(it, r.key);
    if ((typeof k !== "string" && typeof k !== "number") || String(k) === "") throw new ApiProblem(422, "unprocessable", `item ${i + 1}: no key at ${r.key}`);
    const t = r.title !== undefined ? pointer(it, r.title) : undefined;
    const data: Record<string, unknown> = {};
    for (const [f, p] of Object.entries(r.fields)) { const v = pointer(it, p); if (v !== undefined) data[f] = v; }
    return { op: "put", area: area.name, key: String(k), ...(typeof t === "string" ? { title: t.slice(0, 500) } : {}), data };
  });
  if (!ops.length) { await touch(s); return { written: 0 }; }
  // mold_v0-236: an inbound source the workspace's people set up writes as they do (provenance people), named by its id.
  const results = await asWriter({ by: "people", id: `inbound:${s.id}` }, () => withTenant(s.org_id, () => workspaceRecords(area.pack, s.org_id, { role: null, userId: `inbound:${s.id}` }).batch(ops)));
  await touch(s);
  return { written: results.length, area: area.name, keys: results.map((x) => x.key) };
}
const touch = (s: SourceRaw) => asPlatform(async () => (await getDb()).query(
  "UPDATE webhook_sources SET last_received_at = now(), received = received + 1 WHERE org_id = $1 AND id = $2", [s.org_id, s.id]));
