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
 *
 * mold_v0-303: a receiver's `signature` picks how a sender signs ("standard", the default; "vercel": x-vercel-signature,
 * the hex HMAC-SHA1 of the body), and a receiver with `log_drain` takes a hosting provider's request logs instead of
 * records: each delivery is reduced to per-deployment, per-window report records (src/log-drain.ts), its lines never
 * kept. The drain's secret is named, never written down: `log_drain.secret_env` (an environment variable) or else the
 * source's own sealed secret. Those options are read defensively here (their shape is src/pack-manifest.ts's).
 */
import { randomBytes } from "node:crypto";
import { pointer } from "./developer-config.js";
import { ApiProblem, developerSurface } from "./developer-surface.js";
import { verifySigned, newSecret } from "./developer-webhooks.js";
import { getDb } from "./db.js";
import { open, seal } from "./orgcrypto.js";
import { asWriter, recordAreas, workspaceRecords } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { aggregate, logDrainOptions, matchValue, merge, parseLines, priorOf, reportKey, reportValues, requestsOf, serially, verifyVercel, hostOf,
  MAX_REPORTS, type LogDrainOptions, type ReportField } from "./log-drain.js";
import { RECORD_KEY, type RecordOperation, type RecordRow } from "./pack-api.js";

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

/** Where a response's headers are set (the route's res.setHeader): a provider's verification header (mold_v0-303). */
export interface InboundReply { header(name: string, value: string): void }

const sourceOf = async (id: string) => {
  const cfg = developerSurface();
  if (!cfg?.webhooks_in?.length || !/^src_[A-Za-z0-9_-]{8,40}$/.test(id)) throw new ApiProblem(404, "not_found", "Not found");
  const [s] = await asPlatform(async () => (await getDb()).query<SourceRaw>(`/* tenant: the source found by its id; its workspace is checked by its secret */ SELECT ${COLS} FROM webhook_sources WHERE id = $1 AND disabled_at IS NULL`, [id]));
  if (!s) throw new ApiProblem(404, "not_found", "Not found");
  return s;
};
/** A receiver's sender signature (mold_v0-303): "vercel" when it says so, else Standard Webhooks. */
const signatureOf = (r: unknown) => ((r as { signature?: unknown }).signature === "vercel" ? "vercel" : "standard");
/** The provider's verification header for a log-drain source, when its token is set (by name: log_drain.verify_env). */
function verifyHeader(o: LogDrainOptions | null, reply?: InboundReply) {
  const v = o?.verify_header && o.verify_env ? process.env[o.verify_env] : undefined;
  if (o?.verify_header && v) reply?.header(o.verify_header, v.replace(/[\r\n]/g, "").slice(0, 200));
}

/**
 * A provider proving it may send to source `id` (mold_v0-303: Vercel asks for the endpoint, GET or an empty POST, and
 * expects x-vercel-verify): the header set, nothing written, nothing else said.
 */
export async function handshake(id: string, reply: InboundReply) {
  const s = await sourceOf(id);
  verifyHeader(logDrainOptions(receiverOf(s.receiver)), reply);
  return { ok: true };
}

/**
 * A payload sent to source `id`: verified with its secret, written into its receiver's area. Answers what was written,
 * or the first answer again for a webhook-id already received. A log-drain receiver's (mold_v0-303) delivery is reduced
 * to report records instead; `reply` takes its provider's verification header.
 */
export async function receive(id: string, headers: Record<string, string | string[] | undefined>, raw: string, reply?: InboundReply) {
  const s = await sourceOf(id);
  const r = receiverOf(s.receiver);
  const drain = logDrainOptions(r);
  verifyHeader(drain, reply);
  // A verification request (an empty body): answered, never written.
  if (drain && !raw.trim()) return { written: 0, verified: true };
  if (drain && Buffer.byteLength(raw, "utf8") > drain.max_bytes) throw new ApiProblem(413, "too_large", `a log delivery is at most ${drain.max_bytes} bytes`);
  // The drain's secret by name (its environment variable), else the source's own.
  const named = drain?.secret_env ? process.env[drain.secret_env] : undefined;
  const secret = named || (await asPlatform(() => open(s.org_id, s.secret_sealed)));
  const { id: msgId } = signatureOf(r) === "vercel" ? verifyVercel(secret, headers, raw) : verifySigned(secret, headers, raw);
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
    const out = drain ? await writeDrain(s, r, drain, raw) : await write(s, raw);
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
  const keyAt = r.key ?? "/id";
  const ops: RecordOperation[] = items.map((it, i) => {
    const k = pointer(it, keyAt);
    if ((typeof k !== "string" && typeof k !== "number") || String(k) === "") throw new ApiProblem(422, "unprocessable", `item ${i + 1}: no key at ${keyAt}`);
    const t = r.title !== undefined ? pointer(it, r.title) : undefined;
    const data: Record<string, unknown> = {};
    for (const [f, p] of Object.entries(r.fields ?? {})) { const v = pointer(it, p); if (v !== undefined) data[f] = v; }
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

/**
 * A log drain's delivery (mold_v0-303): its requests reduced per deployment and window, each window's report record read,
 * merged and written again (one batch), as the source writes any record. A request whose deployment is not found is
 * counted, never written; nothing of a line is kept but its counts.
 */
async function writeDrain(s: SourceRaw, r: ReturnType<typeof receiverOf>, o: LogDrainOptions, raw: string) {
  const lines = parseLines(raw, o.max_bytes);
  const reqs = requestsOf(lines, o);
  const area = recordAreas().find((a) => a.name === r.area);
  const depArea = recordAreas().find((a) => a.name === o.deployments.area);
  if (!area || area.scope !== "workspace" || !depArea) throw new ApiProblem(422, "unprocessable", "this receiver's report or deployment area is not one of the app's: ask its builder");
  const fieldOf = (k: ReportField): string | null => o.fields[k] ?? (area.fields.some((f) => f.name === k) ? k : null);
  const valueOf = (q: (typeof reqs)[number]) => matchValue(q, o.deployments.match);
  const groups = aggregate(reqs, valueOf, o.window_minutes);
  let unknown = reqs.filter((q) => valueOf(q) === undefined).length;
  const who = `inbound:${s.id}`;
  return serially(`drain:${s.org_id}:${area.name}`, () => asWriter({ by: "people", id: who }, () => withTenant(s.org_id, async () => {
    const recs = workspaceRecords(area.pack, s.org_id, { role: null, userId: who });
    const ops: RecordOperation[] = [];
    for (const [value, windows] of groups) {
      const dep = await findDeployment(recs, depArea.name, o, value);
      if (!dep) { for (const w of windows.values()) unknown += w.requests; continue; }
      for (const w of windows.values()) {
        const key = reportKey(dep.key, w.start);
        const prior = await recs.get(area.name, key);
        const merged = merge(w, priorOf(prior?.data ?? null, fieldOf));
        const values = reportValues(merged, dep.key, o.source_label);
        const kept = Object.fromEntries(Object.entries(prior?.data ?? {}).filter(([, v]) => v !== "[encrypted]"));
        const data: Record<string, unknown> = { ...kept };
        for (const [k, v] of Object.entries(values)) { const f = fieldOf(k as ReportField); if (f && v !== null) data[f] = v; }
        ops.push({ op: "put", area: area.name, key, title: `${(dep.title ?? dep.key).slice(0, 300)} ${String(values.window_start).slice(0, 16)}Z`, data });
      }
    }
    if (ops.length > MAX_REPORTS) throw new ApiProblem(413, "too_large", `at most ${MAX_REPORTS} report windows a delivery`);
    const results = ops.length ? await recs.batch(ops) : [];
    await touch(s);
    return { written: results.length, area: area.name, keys: results.map((x) => x.key), requests: reqs.length, unknown };
  })));
}

/** The deployment record a drain's value names: by its key, or by the configured field (a host also as an https address). */
async function findDeployment(recs: ReturnType<typeof workspaceRecords>, areaName: string, o: LogDrainOptions, value: string): Promise<RecordRow | null> {
  if (o.deployments.field === "$key") return RECORD_KEY.test(value) ? recs.get(areaName, value) : null;
  const want = o.deployments.match === "host" ? [hostOf(value), `https://${hostOf(value)}`, `https://${hostOf(value)}/`] : [value];
  const page = await recs.list(areaName, { filter: { [o.deployments.field]: { in: want } }, limit: 2 });
  return page.records.length === 1 ? page.records[0]! : null;
}
