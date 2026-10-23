import { spawn } from "node:child_process";
import { CFG } from "./config.js";

export class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Retries network errors, 429 and 5xx; other 4xx are final. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (i >= tries - 1) throw e;
      await sleep(Math.min(1000 * 2 ** i, 15_000));
    }
  }
}

export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
    if (opts.input !== undefined) p.stdin!.end(opts.input);
  });
}

/** The server's worker API (`/api/worker/*`). */
export async function api(path: string, init: { method?: string; json?: unknown; ndjson?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${CFG.token}` };
  let body: string | undefined;
  if (init.ndjson !== undefined) { headers["Content-Type"] = "application/x-ndjson"; body = init.ndjson; }
  else if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const res = await fetch(CFG.url + path, { method: init.method ?? "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "POST"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
