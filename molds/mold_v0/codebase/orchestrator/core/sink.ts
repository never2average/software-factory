/**
 * Transcript sink: batches events every FLUSH_INTERVAL_MS to the Octillion API (`/events`, NDJSON), to ClickHouse
 * directly (HTTP interface, JSONEachRow), or both (TRANSCRIPT_SINK=api|clickhouse|both).
 *
 * api:        harness lines are sent verbatim; the server assigns seq/ts.
 * clickhouse: we assign seq (monotonic per session, continuing after any rows already stored for the session),
 *             ts and searchable text exactly like the server's normalize()/eventText() in src/transcripts.ts.
 * both:       the same seq/ts are also written into the API copy, so both stores agree (the server keeps an
 *             explicit integer seq) and ClickHouse's ReplacingMergeTree dedupes if the server writes there too.
 */
import { CFG, SINK } from "./config.js";
import { api, HttpError, log, withRetry } from "./util.js";

export interface SinkRef {
  org_id: number;
  product_id: number;
  simulation_id: string;
  session_id: string;
  model: string;
}

// Mirrors src/transcripts.ts (SKIP_KEYS, MAX_TEXT, eventText). Keep in sync.
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

const chAuth = () => "Basic " + Buffer.from(`${SINK.chUser}:${SINK.chPassword}`).toString("base64");

async function chRequest(query: string, body: string | undefined, params: Record<string, string> = {}): Promise<string> {
  const u = new URL(SINK.chUrl + "/");
  u.searchParams.set("query", query);
  u.searchParams.set("date_time_input_format", "best_effort");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { method: "POST", headers: { Authorization: chAuth() }, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `clickhouse ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/**
 * Event provenance (docs/security.md): every event says who wrote it. `_src: "orchestrator"` for the orchestrator's own
 * events (the post-run diff, the simulated developer's replies, session end), `_src: "harness"` for lines the coding
 * agent's harness printed. A harness cannot pose as the orchestrator: its `_src` and `seq` are overwritten, and the
 * orchestrator's event types are renamed `harness_reserved:<type>` when a harness prints them, so the scorer and the
 * turn count never take forged evidence.
 */
export const ORCHESTRATOR_EVENT_TYPES = new Set(["file_edit", "simulated_user", "session_end", "environment", "turn_cap", "raw_stdout", "worker_stderr", "egress"]);
export function fromHarness(obj: Record<string, unknown>): Record<string, unknown> {
  const { _src, seq, ...rest } = obj;
  const type = typeof rest.type === "string" && ORCHESTRATOR_EVENT_TYPES.has(rest.type) ? `harness_reserved:${rest.type}` : rest.type;
  return { ...rest, ...(type !== undefined ? { type } : {}), _src: "harness" };
}

export class EventSink {
  private seq = 0;
  private apiBuf: string[] = [];
  private chBuf: string[] = [];
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly toApi = SINK.mode !== "clickhouse";
  readonly toCh = SINK.mode !== "api";
  count = 0;

  constructor(private ref: SinkRef, private onRejected: (status: number) => void) {
    if (this.toCh && !SINK.chUrl) throw new Error(`TRANSCRIPT_SINK=${SINK.mode} needs CLICKHOUSE_URL`);
  }

  /** ClickHouse modes: continue after rows already stored for this session (e.g. an earlier attempt). */
  async init(): Promise<void> {
    if (!this.toCh) return;
    try {
      const t = await chRequest(
        `SELECT max(seq) AS m FROM ${SINK.chDatabase}.transcript_events WHERE org_id = {org:UInt32} AND session_id = {s:String} FORMAT JSONEachRow`,
        undefined, { param_org: String(this.ref.org_id), param_s: this.ref.session_id });
      this.seq = Number(JSON.parse(t.trim() || "{}").m ?? 0) || 0;
    } catch (e) {
      log(`[${this.ref.session_id}] clickhouse seq lookup failed (starting at 0):`, String(e));
    }
  }

  start() { this.timer ??= setInterval(() => void this.flush(), CFG.flushMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** A harness JSONL line (already parsed into `obj`): tagged as harness output (see fromHarness). */
  pushLine(_line: string, obj: Record<string, unknown>) {
    this.count++;
    const tagged = fromHarness(obj);
    if (!this.toCh) { this.apiBuf.push(JSON.stringify(tagged)); return; }
    this.normalized(tagged);
  }

  /** A synthetic event (simulated_user, file_edit, raw_stdout, worker_stderr...), written by the orchestrator. */
  push(obj: Record<string, unknown>) {
    this.count++;
    const tagged = { ...obj, _src: "orchestrator" };
    if (!this.toCh) { this.apiBuf.push(JSON.stringify(tagged)); return; }
    this.normalized(tagged);
  }

  private normalized(obj: Record<string, unknown>) {
    const seq = ++this.seq;
    const tsIn = typeof obj.ts === "string" ? obj.ts : typeof obj.timestamp === "string" ? obj.timestamp : null;
    const d = tsIn ? new Date(tsIn) : new Date();
    const ts = (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
    const type = typeof obj.type === "string" && obj.type ? obj.type : "event";
    const raw = { ...obj, seq, ts, type };
    const rawLine = JSON.stringify(raw);
    if (this.toApi) this.apiBuf.push(rawLine);
    this.chBuf.push(JSON.stringify({
      org_id: this.ref.org_id, product_id: this.ref.product_id, simulation_id: this.ref.simulation_id,
      session_id: this.ref.session_id, model: this.ref.model,
      seq, ts, type, text: eventText(obj), raw: rawLine,
    }));
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.apiBuf.length && !this.chBuf.length) return;
    this.flushing = (async () => {
      const enc = encodeURIComponent(this.ref.session_id);
      if (this.apiBuf.length) {
        const batch = this.apiBuf;
        this.apiBuf = [];
        try {
          await withRetry(() => api(`/api/worker/sessions/${enc}/events`, { ndjson: batch.join("\n") + "\n" }), 3);
        } catch (e) {
          if (e instanceof HttpError && (e.status === 409 || e.status === 404)) this.onRejected(e.status);
          else { this.apiBuf = batch.concat(this.apiBuf).slice(-50_000); log(`[${this.ref.session_id}] events flush failed, will retry:`, String(e)); }
        }
      }
      if (this.chBuf.length) {
        const batch = this.chBuf;
        this.chBuf = [];
        try {
          await withRetry(() => chRequest(
            `INSERT INTO ${SINK.chDatabase}.transcript_events (org_id, product_id, simulation_id, session_id, model, seq, ts, type, text, raw) FORMAT JSONEachRow`,
            batch.join("\n") + "\n"), 3);
        } catch (e) {
          this.chBuf = batch.concat(this.chBuf).slice(-50_000);
          log(`[${this.ref.session_id}] clickhouse insert failed, will retry:`, String(e));
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Flush until empty (bounded). */
  async drain(): Promise<void> {
    for (let i = 0; i < 5 && (this.apiBuf.length || this.chBuf.length || this.flushing); i++) {
      if (this.flushing) await this.flushing;
      await this.flush();
    }
  }
}
