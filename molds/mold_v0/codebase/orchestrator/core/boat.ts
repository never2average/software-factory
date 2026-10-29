/** Minimal boat.dev v1 REST client (https://docs.boat.dev/api/v1). fetch only. */
import { BOAT } from "./config.js";
import { HttpError, sleep } from "./util.js";

export class BoatError extends HttpError {
  retryAfterMs?: number;
  constructor(status: number, public code: string, msg: string, public retryable?: boolean) { super(status, msg); }
}

export const boatSandboxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

function boatHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${BOAT.apiKey}`, ...extra };
}

async function boatErrorFrom(res: Response, what: string): Promise<BoatError> {
  const text = await res.text().catch(() => "");
  let d: any = null;
  try { d = JSON.parse(text); } catch { /* not JSON */ }
  const code = String(d?.code ?? d?.error?.code ?? "");
  const msg = d?.message ?? d?.error?.message ?? text.slice(0, 300);
  const e = new BoatError(res.status, code, `boat ${what} -> ${res.status} ${code}: ${msg}`, d?.error?.details?.retryable);
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
  return e;
}

/**
 * Client-side start gate: boat counts every create/fork/resume as a "start" (plan: 12/min, 60/h, 200/day on $20).
 * Every orchestrator paces its own creates below the account limits; 429s are still handled by boatCreate.
 */
export class StartGate {
  private times: number[] = [];
  constructor(public perMinute: number, public perHour: number) {}
  /** Milliseconds to wait before the next start is allowed (0 = now). */
  waitMs(now = Date.now()): number {
    this.times = this.times.filter((t) => now - t < 3600_000);
    const lastMin = this.times.filter((t) => now - t < 60_000);
    let w = 0;
    if (lastMin.length >= this.perMinute) w = Math.max(w, lastMin[lastMin.length - this.perMinute]! + 60_000 - now);
    if (this.times.length >= this.perHour) w = Math.max(w, this.times[this.times.length - this.perHour]! + 3600_000 - now);
    return w;
  }
  async acquire(): Promise<void> {
    for (let w = this.waitMs(); w > 0; w = this.waitMs()) await sleep(Math.min(w + 50, 60_000));
    this.times.push(Date.now());
  }
}
export const startGate = new StartGate(
  Math.max(1, Number(process.env.BOAT_STARTS_PER_MINUTE ?? 10)), Math.max(1, Number(process.env.BOAT_STARTS_PER_HOUR ?? 50)));

/**
 * POST /sandboxes through the start gate. 429 (rate_limited / limit_reached) and 503 no_ready_machine back off
 * (Retry-After, else exponential 5s..2min with jitter) and retry with the SAME Idempotency-Key, so a lost response
 * never creates a second billable sandbox.
 */
export async function boatCreate(json: Record<string, unknown>, opts: { maxTries?: number; onBackoff?: (ms: number, e: BoatError) => void } = {}): Promise<any> {
  const idem = crypto.randomUUID();
  const maxTries = opts.maxTries ?? 10;
  for (let i = 0; ; i++) {
    await startGate.acquire();
    try {
      return await boatApi("/sandboxes", { method: "POST", headers: { "Idempotency-Key": idem }, json, timeoutMs: 120_000 });
    } catch (e) {
      const retryable = e instanceof BoatError && (e.status === 429 || e.status >= 500 || e.code === "idempotency_in_progress" || e.code === "no_ready_machine");
      if (!retryable || i >= maxTries - 1) throw e;
      const base = Math.min(5000 * 2 ** i, 120_000);
      const ms = Math.max((e as BoatError).retryAfterMs ?? 0, base) + Math.floor(Math.random() * 1000);
      opts.onBackoff?.(ms, e as BoatError);
      await sleep(ms);
    }
  }
}

/** Set by the credential layer: refetch the boat key after a 401 (rotated key). Returns true if it changed. */
let refreshBoatKey: (() => Promise<boolean>) | null = null;
export function onBoatUnauthorized(fn: () => Promise<boolean>) { refreshBoatKey = fn; }

export async function boatApi(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}, retried = false): Promise<any> {
  const method = init.method ?? "GET";
  const headers = boatHeaders(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 60_000)];
  if (init.signal) signals.push(init.signal);
  const res = await fetch(BOAT.apiUrl + path, { method, headers, body, signal: AbortSignal.any(signals) });
  if (res.status === 401 && !retried && refreshBoatKey && await refreshBoatKey().catch(() => false)) return boatApi(path, init, true);
  if (!res.ok) throw await boatErrorFrom(res, `${method} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Retry a command call only when Boat says it provably did not run (still starting / restoring / rate limited). */
export async function boatCommandRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const safe = e instanceof BoatError &&
        ((e.status === 409 && /starting/.test(e.code)) || (e.status === 502 && e.retryable === true) || e.status === 429);
      if (!safe || i >= 20) throw e;
      await sleep(3000);
    }
  }
}

/** Synchronous command (<= 600s: boat refuses a longer timeoutSeconds with 400 invalid_timeout). Boat may truncate long output. */
export async function boatExec(id: string, command: string, timeoutSeconds = 120): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  timeoutSeconds = Math.max(1, Math.min(600, Math.round(timeoutSeconds)));
  const r = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
    method: "POST", json: { command, timeoutSeconds }, timeoutMs: (timeoutSeconds + 60) * 1000,
  }));
  return { exitCode: r?.exitCode ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

/**
 * Streamed command: POST /commands {stream:true} answers application/x-ndjson frames:
 * {"type":"started"}, {"type":"stdout"|"stderr","data":"..."}..., then {"type":"exit",exitCode,...} or {"type":"error",...}.
 */
export async function boatExecStream(
  id: string, command: string, timeoutSeconds: number,
  onStdout: (s: string) => void, onStderr: (s: string) => void, signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
  const signals = [AbortSignal.timeout((timeoutSeconds + 60) * 1000)];
  if (signal) signals.push(signal);
  const res = await boatCommandRetry(async () => {
    const r = await fetch(`${BOAT.apiUrl}${boatSandboxPath(id)}/commands`, {
      method: "POST",
      headers: boatHeaders({ "Content-Type": "application/json", Accept: "application/x-ndjson" }),
      body: JSON.stringify({ command, timeoutSeconds, stream: true }),
      signal: AbortSignal.any(signals),
    });
    if (!r.ok) throw await boatErrorFrom(r, "POST commands(stream)");
    return r;
  });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) { // server answered with the sync JSON result
    const d: any = await res.json();
    onStdout(d?.stdout ?? ""); onStderr(d?.stderr ?? "");
    return { exitCode: d?.exitCode ?? null };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let exitCode: number | null = null;
  const frame = (line: string) => {
    if (!line.trim()) return;
    let f: any;
    try { f = JSON.parse(line); } catch { return; }
    if (f.type === "stdout") onStdout(String(f.data ?? ""));
    else if (f.type === "stderr") onStderr(String(f.data ?? ""));
    else if (f.type === "exit") exitCode = f.exitCode ?? null;
    else if (f.type === "error") throw new BoatError(502, String(f.error ?? "stream_error"), `boat command stream error: ${f.message ?? f.error}`, f.retryable);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { frame(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  frame(buf + dec.decode());
  return { exitCode };
}
