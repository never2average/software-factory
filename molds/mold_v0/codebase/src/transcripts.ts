import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { getDb } from "./db.js";
import { sessionEngine } from "./host-tables.js";

/**
 * Raw sub-agent transcripts: one JSONL line per event, stored verbatim.
 *
 * Production: ClickHouse (`octillion.transcript_events`), one row per event, with a full-text index on a
 * lowercased copy of the searchable text. Retried writes are collapsed by ReplacingMergeTree on
 * (org_id, session_id, seq) and reads take one row per seq.
 * Local dev / tests: when CLICKHOUSE_URL is unset the same rows go to Postgres (`transcript_events`).
 *
 * Events are whatever the harness emits (Claude Code stream-json, Codex, our own format...). We only need
 * `type`; `seq` and `ts` are filled in when missing, and searchable text is pulled from every string field.
 */

export interface RawEvent { seq?: number; ts?: string; type?: string; [k: string]: unknown }
export interface StoredEvent { seq: number; ts: string; type: string; text: string; raw: RawEvent }
export interface SessionRef { id: string; org_id: number; product_id: number; simulation_id: string; model: string }

export interface SearchParams {
  orgId: number;
  query: string;
  mode?: "all" | "any" | "phrase";
  productId?: number;
  simulationId?: string;
  sessionId?: string;
  model?: string;
  type?: string;
  days?: number;
  limit?: number;
}
export interface SearchHit { session_id: string; simulation_id: string; product_id: number; model: string; seq: number; ts: string; type: string; text: string }
export interface SearchResult {
  total: number;
  hits: SearchHit[];
  facets: { model: { value: string; count: number }[]; type: { value: string; count: number }[] };
  stats: { ms: number; backend: string };
}

interface TranscriptStore {
  kind: "clickhouse" | "postgres";
  append(s: SessionRef, events: StoredEvent[]): Promise<void>;
  read(orgId: number, sessionId: string, offset: number, limit: number): Promise<{ total: number; events: StoredEvent[] }>;
  /** Drop a session's events (an infrastructure-failed attempt being retried must not leak into the retry's transcript). */
  remove(orgId: number, sessionId: string): Promise<void>;
  /** Drop every event of an organization (organization deletion, src/tenancy.ts). */
  removeOrg(orgId: number): Promise<void>;
  /** Wake the store in the background (a paused ClickHouse Cloud service takes ~15 s to answer its first query). */
  warm(): void;
  search(p: SearchParams): Promise<SearchResult>;
  /** Rows and bytes on disk, where the store reports them cheaply (ClickHouse system.parts); Postgres: null (its table size is the database's). */
  stats(): Promise<{ rows: number; bytes: number } | null>;
}

// ---------- normalisation ----------

const SKIP_KEYS = new Set(["seq", "ts", "timestamp", "type", "id", "uuid", "session_id", "parent_uuid", "signature", "run_id", "usage", "cost_usd"]);
const MAX_TEXT = 50_000;

/** Every string in the event (message text, tool names, commands, file contents...), depth-first. */
export function eventText(e: unknown): string {
  const out: string[] = [];
  let len = 0;
  const walk = (v: unknown, key?: string) => {
    if (len > MAX_TEXT || (key && SKIP_KEYS.has(key))) return;
    if (typeof v === "string") { out.push(v); len += v.length; }
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(e);
  return out.join(" ").slice(0, MAX_TEXT);
}

/** Assign seq (continuing from `lastSeq`) and ts where missing, and extract searchable text. */
export function normalize(events: RawEvent[], lastSeq: number): StoredEvent[] {
  let next = lastSeq;
  return events.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each transcript event must be a JSON object");
    // Harness output never chooses its own position in the transcript (docs/security.md, event provenance).
    const seq = raw._src !== "harness" && Number.isInteger(raw.seq) && Number(raw.seq) > 0 ? Number(raw.seq) : next + 1;
    next = Math.max(next, seq);
    const ts = typeof raw.ts === "string" ? raw.ts : typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString();
    const type = typeof raw.type === "string" && raw.type ? raw.type : "event";
    return { seq, ts: new Date(ts).toISOString(), type, text: eventText(raw), raw: { ...raw, seq, ts, type } };
  });
}

/** Parse a JSONL body (blank lines ignored). */
export function parseJsonl(body: string): RawEvent[] {
  return body.split("\n").map((l) => l.trim()).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) as RawEvent; }
    catch { throw new Error(`Line ${i + 1} is not valid JSON`); }
  });
}

// ---------- ClickHouse ----------

interface ClickHouseConfig { url: string; username: string; password: string; database: string }

/**
 * CLICKHOUSE_URL plus CLICKHOUSE_USER / CLICKHOUSE_PASSWORD, or a gitignored CLICKHOUSE_CREDENTIALS_FILE with
 * "Username: ..." / "Password: ..." (and optionally "Host: ...") lines, which wins.
 */
function chConfig(): ClickHouseConfig | null {
  const file: Record<string, string> = {};
  const credFile = process.env.CLICKHOUSE_CREDENTIALS_FILE;
  if (credFile) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const line of readFileSync(path.resolve(root, credFile), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_ ]+?)\s*[:=]\s*(.*?)\s*$/);
      if (m) file[m[1].toLowerCase()] = m[2];
    }
  }
  const host = file.url ?? file.host;
  const url = process.env.CLICKHOUSE_URL || (host ? (/^https?:\/\//.test(host) ? host : `https://${host}:8443`) : "");
  if (!url) return null;
  return {
    url,
    username: file.username ?? file.user ?? process.env.CLICKHOUSE_USER ?? "default",
    password: file.password ?? process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "octillion",
  };
}

function clickhouseStore(cfg: ClickHouseConfig): TranscriptStore {
  const TABLE = `${cfg.database}.transcript_events`;
  const client: ClickHouseClient = createClient({
    url: cfg.url, username: cfg.username, password: cfg.password,
    request_timeout: 60_000,
    clickhouse_settings: { enable_full_text_index: 1, date_time_input_format: "best_effort" },
  });
  const columns = `
    org_id         UInt32,
    product_id     UInt32,
    simulation_id  String,
    session_id     String,
    model          LowCardinality(String),
    seq            UInt32,
    ts             DateTime64(3, 'UTC'),
    type           LowCardinality(String),
    text           String,
    text_lc        String MATERIALIZED lower(text),
    raw            String CODEC(ZSTD(3)),
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3)`;
  const engine = `ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(ts) ORDER BY (org_id, session_id, seq)`;

  let ready: Promise<boolean> | undefined; // resolves to whether the full-text index exists
  const ensure = () => {
    ready ??= (async () => {
      await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${cfg.database}` });
      try {
        await client.command({
          query: `CREATE TABLE IF NOT EXISTS ${TABLE} (${columns},
                    INDEX text_idx text_lc TYPE text(tokenizer = splitByNonAlpha)) ${engine}`,
        });
      } catch (err) {
        // Older or differently configured servers lack the `text` index type: search falls back to scans.
        console.error(`clickhouse: full-text index unavailable (${(err as Error).message.split("\n")[0]}); using scans`);
        await client.command({ query: `CREATE TABLE IF NOT EXISTS ${TABLE} (${columns}) ${engine}` });
      }
      const [idx] = await (await client.query({
        query: `SELECT count() AS n FROM system.data_skipping_indices
                 WHERE database = {db:String} AND table = 'transcript_events' AND name = 'text_idx'`,
        query_params: { db: cfg.database }, format: "JSONEachRow",
      })).json<{ n: string }>();
      return Number(idx?.n) > 0;
    })().catch((err) => { ready = undefined; throw err; });
    return ready;
  };

  let warmedAt = 0;
  return {
    kind: "clickhouse",
    async append(s, events) {
      await ensure();
      await client.insert({
        table: TABLE, format: "JSONEachRow",
        values: events.map((e) => ({
          org_id: s.org_id, product_id: s.product_id, simulation_id: s.simulation_id, session_id: s.id, model: s.model,
          seq: e.seq, ts: e.ts, type: e.type, text: e.text, raw: JSON.stringify(e.raw),
        })),
      });
    },
    warm() {
      if (Date.now() - warmedAt < 4 * 60_000) return; // at most one wake-up ping every few minutes
      warmedAt = Date.now();
      void ensure().then(() => client.ping()).catch(() => { warmedAt = 0; });
    },
    async removeOrg(orgId) {
      await ensure();
      await client.command({
        query: `DELETE FROM ${TABLE} WHERE org_id = {org:UInt32}`,
        query_params: { org: orgId }, clickhouse_settings: { lightweight_deletes_sync: "2" },
      });
      const [{ left }] = await (await client.query({
        query: `SELECT count() AS left FROM ${TABLE} WHERE org_id = {org:UInt32}`, query_params: { org: orgId }, format: "JSONEachRow",
      })).json<{ left: string }>();
      if (Number(left)) throw new Error(`org ${orgId}: ${left} transcript event(s) still in ClickHouse after delete`);
    },
    async stats() {
      await ensure();
      const [r] = await (await client.query({
        query: `SELECT sum(rows) AS rows, sum(bytes_on_disk) AS bytes FROM system.parts
                 WHERE database = {db:String} AND table = 'transcript_events' AND active`,
        query_params: { db: cfg.database }, format: "JSONEachRow",
      })).json<{ rows: string; bytes: string }>();
      return { rows: Number(r?.rows ?? 0), bytes: Number(r?.bytes ?? 0) };
    },
    async remove(orgId, sessionId) {
      await ensure();
      // Lightweight delete, waited for: the retry's events reuse the same seq numbers.
      await client.command({
        query: `DELETE FROM ${TABLE} WHERE org_id = {org:UInt32} AND session_id = {session:String}`,
        query_params: { org: orgId, session: sessionId }, clickhouse_settings: { lightweight_deletes_sync: "2" },
      });
    },
    async read(orgId, sessionId, offset, limit) {
      await ensure();
      const params = { org: orgId, session: sessionId, offset, limit };
      const [{ total }] = await (await client.query({
        query: `SELECT uniqExact(seq) AS total FROM ${TABLE} WHERE org_id = {org:UInt32} AND session_id = {session:String}`,
        query_params: params, format: "JSONEachRow",
      })).json<{ total: string }>();
      const rows = await (await client.query({
        query: `SELECT seq, ts, type, text, raw FROM ${TABLE}
                 WHERE org_id = {org:UInt32} AND session_id = {session:String}
                 ORDER BY seq, ingested_at DESC LIMIT 1 BY seq
                 LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: params, format: "JSONEachRow",
      })).json<{ seq: number; ts: string; type: string; text: string; raw: string }>();
      return {
        total: Number(total),
        events: rows.map((r) => ({ seq: Number(r.seq), ts: new Date(r.ts.replace(" ", "T") + "Z").toISOString(), type: r.type, text: r.text, raw: JSON.parse(r.raw) })),
      };
    },
    async search(p) {
      const hasIndex = await ensure();
      const started = Date.now();
      const q = p.query.trim().toLowerCase();
      const params: Record<string, unknown> = { org: p.orgId, q, tokens: q.split(/[^\p{L}\p{N}]+/u).filter(Boolean) };
      const where = ["org_id = {org:UInt32}"];
      if (q) {
        if (hasIndex) where.push(p.mode === "any" ? "hasAnyTokens(text_lc, {q:String})" : "hasAllTokens(text_lc, {q:String})");
        else where.push(p.mode === "any" ? "arrayExists(t -> position(text_lc, t) > 0, {tokens:Array(String)})"
                                         : "arrayAll(t -> position(text_lc, t) > 0, {tokens:Array(String)})");
        if (p.mode === "phrase") where.push("position(text_lc, {q:String}) > 0");
      }
      if (p.productId !== undefined) where.push("product_id = {product:UInt32}"), (params.product = p.productId);
      if (p.simulationId) where.push("simulation_id = {sim:String}"), (params.sim = p.simulationId);
      if (p.sessionId) where.push("session_id = {session:String}"), (params.session = p.sessionId);
      if (p.model) where.push("model = {model:String}"), (params.model = p.model);
      if (p.type) where.push("type = {type:String}"), (params.type = p.type);
      if (p.days) where.push("ts >= now() - toIntervalDay({days:UInt32})"), (params.days = p.days);
      const from = `${TABLE} FINAL WHERE ${where.join(" AND ")}`;
      const hits = await (await client.query({
        query: `SELECT session_id, simulation_id, product_id, model, seq, ts, type, substring(text, 1, 2000) AS text
                  FROM ${from} ORDER BY ts DESC LIMIT {limit:UInt32}`,
        query_params: { ...params, limit: p.limit ?? 25 }, format: "JSONEachRow",
      })).json<SearchHit>();
      const facetRows = await (await client.query({
        query: `SELECT model, type, count() AS n FROM ${from} GROUP BY model, type`,
        query_params: params, format: "JSONEachRow",
      })).json<{ model: string; type: string; n: string }>();
      return {
        total: facetRows.reduce((s, r) => s + Number(r.n), 0),
        hits: hits.map((h) => ({ ...h, seq: Number(h.seq), product_id: Number(h.product_id) })),
        facets: facets(facetRows),
        stats: { ms: Date.now() - started, backend: hasIndex ? "clickhouse (full-text index)" : "clickhouse (scan)" },
      };
    },
  };
}

function facets(rows: { model: string; type: string; n: string | number }[]) {
  const count = (key: "model" | "type") => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + Number(r.n));
    return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };
  return { model: count("model"), type: count("type") };
}

// ---------- Postgres fallback ----------

// The table is the session engine's, a host pack's (mold_v0-049): in a build without it there is no session, so no
// transcript to read, remove or search.
const postgresStore: TranscriptStore = {
  kind: "postgres",
  async stats() { return null; },
  async append(s, events) {
    if (!sessionEngine()) throw Object.assign(new Error(`No session ${s.id}`), { status: 404 });
    const db = await getDb();
    for (const e of events)
      await db.query(
        `/* tenant: session checked against the job token in http.ts (/sessions/:id/events) */ INSERT INTO transcript_events (session_id, seq, ts, type, text, raw) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [s.id, e.seq, e.ts, e.type, e.text, JSON.stringify(e.raw)],
      );
  },
  warm() {},
  async removeOrg(orgId) {
    if (!sessionEngine()) return;
    const db = await getDb();
    await db.query("DELETE FROM transcript_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE org_id = $1)", [orgId]);
  },
  async remove(orgId, sessionId) {
    if (!sessionEngine()) return;
    const db = await getDb();
    await db.query("DELETE FROM transcript_events WHERE session_id = $1 AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = $1 AND s.org_id = $2)", [sessionId, orgId]);
  },
  async read(orgId, sessionId, offset, limit) {
    if (!sessionEngine()) return { total: 0, events: [] };
    const db = await getDb();
    const owned = "session_id = $1 AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = $1 AND s.org_id = $2)";
    const [{ total }] = await db.query<{ total: number }>(`/* tenant: org_id check in the owned filter (EXISTS on agent_sessions) */ SELECT count(*) AS total FROM transcript_events WHERE ${owned}`, [sessionId, orgId]);
    const rows = await db.query<{ seq: number; ts: Date; type: string; text: string; raw: RawEvent }>(
      `/* tenant: org_id check in the owned filter (EXISTS on agent_sessions) */ SELECT seq, ts, type, text, raw FROM transcript_events WHERE ${owned} ORDER BY seq LIMIT $3 OFFSET $4`,
      [sessionId, orgId, limit, offset],
    );
    return { total, events: rows.map((r) => ({ ...r, ts: new Date(r.ts).toISOString() })) };
  },
  async search(p) {
    if (!sessionEngine()) return { total: 0, hits: [], facets: facets([]), stats: { ms: 0, backend: "postgres" } };
    const db = await getDb();
    const started = Date.now();
    const params: unknown[] = [p.orgId];
    const where = ["s.org_id = $1"];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    const q = p.query.trim();
    if (q) {
      if (p.mode === "phrase") add("e.text ILIKE ?", `%${q}%`);
      else {
        const tokens = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const conds = tokens.map((t) => { params.push(`%${t}%`); return `e.text ILIKE $${params.length}`; });
        if (conds.length) where.push(`(${conds.join(p.mode === "any" ? " OR " : " AND ")})`);
      }
    }
    if (p.productId !== undefined) add("s.product_id = ?", p.productId);
    if (p.simulationId) add("s.simulation_id = ?", p.simulationId);
    if (p.sessionId) add("s.id = ?", p.sessionId);
    if (p.model) add("s.model = ?", p.model);
    if (p.type) add("e.type = ?", p.type);
    if (p.days) add("e.ts > now() - make_interval(days => ?)", p.days);
    const from = `transcript_events e JOIN agent_sessions s ON s.id = e.session_id WHERE ${where.join(" AND ")}`;
    const hits = await db.query<SearchHit>(
      `SELECT e.session_id, s.simulation_id, s.product_id, s.model, e.seq, e.ts, e.type, left(e.text, 2000) AS text
         FROM ${from} ORDER BY e.ts DESC, e.seq DESC LIMIT ${Math.trunc(p.limit ?? 25)}`,
      params,
    );
    const facetRows = await db.query<{ model: string; type: string; n: number }>(
      `SELECT s.model, e.type, count(*) AS n FROM ${from} GROUP BY s.model, e.type`, params,
    );
    return {
      total: facetRows.reduce((s, r) => s + Number(r.n), 0),
      hits,
      facets: facets(facetRows),
      stats: { ms: Date.now() - started, backend: "postgres" },
    };
  },
};

let store: TranscriptStore | undefined;
/** The live store only (ClickHouse, or Postgres without CLICKHOUSE_URL): what archiving and restoring read and write. */
export function baseTranscripts(): TranscriptStore {
  if (!store) {
    const cfg = chConfig();
    store = cfg ? clickhouseStore(cfg) : postgresStore;
  }
  return store;
}

let wrapped: TranscriptStore | undefined;
/**
 * The transcript store, with read-through to the R2 archive (archive.ts): when the live store has no events for a
 * session (ClickHouse lapsed and the server moved to Postgres) or cannot be reached, an archived session is read
 * from R2. Search stays live-store only.
 */
export function transcripts(): TranscriptStore {
  const base = baseTranscripts();
  wrapped ??= {
    kind: base.kind,
    append: (s, events) => base.append(s, events),
    remove: (orgId, sessionId) => base.remove(orgId, sessionId),
    removeOrg: (orgId) => base.removeOrg(orgId),
    warm: () => base.warm(),
    search: (p) => base.search(p),
    stats: () => base.stats(),
    async read(orgId, sessionId, offset, limit) {
      const fromArchive = async () => {
        const { archivedEvents } = await import("./archive.js");
        const ev = await archivedEvents(orgId, sessionId).catch(() => null);
        return ev?.length ? { total: ev.length, events: ev.slice(offset, offset + limit) } : null;
      };
      let live: { total: number; events: StoredEvent[] };
      try { live = await base.read(orgId, sessionId, offset, limit); }
      catch (e) { const a = await fromArchive(); if (a) return a; throw e; }
      return live.total > 0 ? live : (await fromArchive()) ?? live;
    },
  };
  return wrapped;
}
