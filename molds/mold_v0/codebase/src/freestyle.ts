/**
 * A minimal client for Freestyle's VM API (mold_v0-274; https://docs.freestyle.sh/docs/vms), the calls a run sandbox
 * needs and nothing else. It speaks the HTTP API directly, version 5 as the official SDK `freestyle` 0.2.21 calls it
 * (npm `freestyle`, which supersedes `freestyle-sandboxes`): no SDK is installed, so nothing of Freestyle's runs in this
 * process but these requests.
 *
 *   POST   /v5/vms                          create a VM (its firewall is required: nothing is allowed implicitly)
 *   GET    /v5/vms?metadata=k:v&limit&offset the VMs labelled k:v, and the account's running/starting/pausing counts
 *   GET    /v5/vms/{id}                     one VM's state
 *   DELETE /v5/vms/{id}                     delete it (its firewall rules go with it)
 *   POST   /v5/vms/{id}/exec-await          run a command and wait (at most 5 minutes; we run short ones only)
 *   PUT    /v5/vms/{id}/fs/write?path&mode&sha256   write a file's raw bytes, atomically, with its mode bits
 *   GET    /v5/background-requests/{id}     a request the API took into the background (202): polled to its answer
 *
 * The key is the key vault's `freestyle` provider (Admin › Key vault, a platform owner's), read by the caller and passed
 * in; never an environment variable at runtime (a FREESTYLE_API_KEY on the server is imported into the vault once, as
 * every provider key is: src/keyvault-env.ts). FREESTYLE_API_URL points the client elsewhere (the offline tests' stand-in).
 */
import { createHash } from "node:crypto";
import { ENV } from "./env-names.js";

export const FREESTYLE_PROVIDER = "freestyle";
export const freestyleApiUrl = () => (ENV.FREESTYLE_API_URL || "https://api.freestyle.sh").replace(/\/+$/, "");

/** What a Freestyle call that failed says: its status, Freestyle's error code (SCREAMING_SNAKE_CASE) and message. */
export class FreestyleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** A VM as the API describes it (the fields used here). */
export interface FreestyleVm {
  id: string;
  state: "starting" | "running" | "pausing" | "paused" | "stopped" | string;
  slug?: string | null;
  displayName?: string | null;
  metadata?: Record<string, string>;
  createdAt?: string;
}
export interface FreestyleList { vms: FreestyleVm[]; totalCount: number; runningCount?: number; startingCount?: number; pausingCount?: number }

/** One end of a firewall rule (docs.freestyle.sh/docs/vms/network/firewall): `{}` is the VM being created. */
export interface FirewallEndpoint { public?: true; cidr?: string; port?: number; protocol?: "tcp" | "udp" | "icmp" }
export interface FirewallRule { action: "allow"; source: FirewallEndpoint; destination: FirewallEndpoint }

export interface CreateVm {
  snapshotId?: string;
  slug?: string;
  displayName?: string;
  metadata?: Record<string, string>;
  /** Delete the VM this long after its creation, whatever it is doing (the provider's own TTL). */
  ttlSeconds?: number;
  /** 0: ephemeral, deleted the moment it stops. */
  autoDeleteSeconds?: number;
  /** Boot it again after a failure (a crash): false here, a run's sandbox is not brought back. */
  automaticRestart?: boolean;
  firewall: { rules: FirewallRule[] };
}

const TIMEOUT_MS = 60_000;
const BACKGROUND_POLL_MS = Number(ENV.FREESTYLE_POLL_MS ?? 2000);

export class FreestyleClient {
  constructor(private readonly key: string, readonly base = freestyleApiUrl()) {
    if (!key) throw new Error("no Freestyle key");
  }

  private async send(method: string, p: string, body?: { json?: unknown; bytes?: Uint8Array }, opts: { timeoutMs?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    let payload: BodyInit | undefined;
    if (body?.bytes) { headers["content-type"] = "application/octet-stream"; payload = body.bytes as BodyInit; }
    else if (body?.json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
    let res: Response;
    try {
      res = await fetch(`${this.base}${p}`, { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      // The path names the VM, never a key or a file's content.
      throw new FreestyleError(0, "NETWORK", `freestyle ${method} ${p.split("?")[0]}: ${(e as Error).message}`);
    }
    // A request the API took into the background answers 202 with its id: its answer is polled, the same value or error.
    if (res.status === 202) {
      const accepted = await res.json().catch(() => ({})) as { requestId?: string; resultUrl?: string };
      const id = res.headers.get("x-freestyle-background-request-id") ?? accepted.requestId;
      const next = accepted.resultUrl ?? (id ? `/v5/background-requests/${encodeURIComponent(id)}` : null);
      if (!next) throw new FreestyleError(202, "BACKGROUND_PROTOCOL_ERROR", `freestyle ${method} ${p.split("?")[0]}: 202 with no request id`);
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, BACKGROUND_POLL_MS));
        if (Date.now() - t0 > (opts.timeoutMs ?? TIMEOUT_MS) * 5) throw new FreestyleError(504, "BACKGROUND_TIMEOUT", `freestyle ${method} ${p.split("?")[0]}: no answer`);
        const r = await fetch(/^https?:\/\//.test(next) ? next : `${this.base}${next}`, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!r || r.status === 202 || [408, 429, 502, 503, 504].includes(r.status) && !r.headers.get("x-freestyle-background-request-id")) { await r?.body?.cancel().catch(() => {}); continue; }
        return this.finish(r, method, p);
      }
    }
    return this.finish(res, method, p);
  }

  private async finish(res: Response, method: string, p: string): Promise<any> {
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let d: { error?: string; code?: string; message?: string } = {};
      try { d = JSON.parse(text); } catch { /* not JSON */ }
      const code = String(d.code ?? d.error ?? "UNKNOWN_ERROR");
      throw new FreestyleError(res.status, code, `freestyle ${method} ${p.split("?")[0]} -> ${res.status} ${code}: ${String(d.message ?? text).slice(0, 300)}`);
    }
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }

  createVm(spec: CreateVm): Promise<FreestyleVm> { return this.send("POST", "/v5/vms", { json: spec }, { timeoutMs: 120_000 }); }
  getVm(id: string): Promise<FreestyleVm> { return this.send("GET", `/v5/vms/${encodeURIComponent(id)}`); }
  /**
   * The VMs labelled `key:value` (every page), with the account's counts from the first; `limit` reads one page of that
   * size only (the counts are the account's whatever the page holds).
   */
  async listVms(metadata?: { key: string; value: string }, opts: { limit?: number } = {}): Promise<FreestyleList> {
    const out: FreestyleVm[] = [];
    let first: FreestyleList | null = null;
    const size = opts.limit ?? 100;
    for (let offset = 0, i = 0; i < 50; i++) {
      const q = new URLSearchParams({ limit: String(size), offset: String(offset) });
      if (metadata) q.set("metadata", `${metadata.key}:${metadata.value}`);
      const r = await this.send("GET", `/v5/vms?${q}`) as FreestyleList;
      first ??= r;
      out.push(...(r?.vms ?? []));
      if (opts.limit !== undefined || !r?.vms?.length || r.vms.length < size) break;
      offset += r.vms.length;
    }
    return { ...(first ?? { totalCount: 0 }), vms: out };
  }
  /** Delete a VM; one already gone is not an error. */
  async deleteVm(id: string): Promise<void> {
    try { await this.send("DELETE", `/v5/vms/${encodeURIComponent(id)}`); }
    catch (e) { if (!(e instanceof FreestyleError && e.status === 404)) throw e; }
  }
  /** A command in the guest, as `linuxUser` (root for the set-up), at most `timeoutMs`. */
  async exec(id: string, command: string, opts: { linuxUser?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeoutMs = Math.min(opts.timeoutMs ?? 30_000, 300_000);
    const r = await this.send("POST", `/v5/vms/${encodeURIComponent(id)}/exec-await`, { json: { command, ...(opts.linuxUser ? { linuxUser: opts.linuxUser } : {}), timeoutMs } },
      { timeoutMs: timeoutMs + 30_000 });
    return { code: typeof r?.statusCode === "number" ? r.statusCode : null, stdout: String(r?.stdout ?? ""), stderr: String(r?.stderr ?? "") };
  }
  /** Write a file's bytes with its mode (0o600, 0o700 for a program), checked by its sha256 at the far end. */
  async writeFile(id: string, filePath: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
    if (!filePath.startsWith("/") || filePath.split("/").includes("..")) throw new Error(`not an absolute path: ${filePath}`);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const q = new URLSearchParams({ path: filePath, mode: String(mode), sha256: createHash("sha256").update(bytes).digest("hex") });
    await this.send("PUT", `/v5/vms/${encodeURIComponent(id)}/fs/write?${q}`, { bytes }, { timeoutMs: 120_000 });
  }
}
