/**
 * Helpers the launcher runs INSIDE an orchestrator sandbox (never on the main VM):
 *   tsx deploy/in-sandbox.ts guard                      host-guard verdict as JSON (production rules, RUNNER from env)
 *   tsx deploy/in-sandbox.ts preflight                  can this sandbox reach $APP_URL/healthz over HTTPS?
 *   tsx deploy/in-sandbox.ts nested <boat-key-file>     selftest: create + exec + delete ONE worker sandbox from here
 */
import { readFileSync, rmSync } from "node:fs";
import { checkHost, MARKER_PATH } from "../core/host-guard.js";
import { ENV, ENV_PREFIX, LEGACY_ENV_PREFIX } from "../core/env-names.js";
import { boatNamespace } from "../core/boat-namespace.js";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "guard") {
  const r = checkHost(process.env.RUNNER ?? "boat");
  const boatId = process.env.BOAT_ID ?? process.env.BOX_ID ?? "";
  let marker: any = null;
  try { marker = JSON.parse(readFileSync(MARKER_PATH, "utf8")); } catch { /* none */ }
  console.log(JSON.stringify({ ok: r.ok, dev: r.dev, problems: r.problems, boat_id_matches_marker: !!marker?.sandbox_id && boatId === marker.sandbox_id, boat_id_shape: boatId.replace(/[a-z0-9]/g, "x") }));
  process.exit(r.ok ? 0 : 3);
}

if (cmd === "preflight") {
  const url = (ENV.APP_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(url)) {
    console.log(JSON.stringify({ ok: false, reason: `APP_URL must be the server's PUBLIC https URL (got ${url || "nothing"}); orchestrator and worker sandboxes reach it over the internet` }));
    process.exit(4);
  }
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const ok = r.status === 200;
    console.log(JSON.stringify({ ok, status: r.status, reason: ok ? "reachable" : `GET ${url}/healthz returned ${r.status}` }));
    process.exit(ok ? 0 : 4);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    console.log(JSON.stringify({ ok: false, reason: `cannot reach ${url}/healthz from this boat sandbox (${cause}). The server must be on a public HTTPS URL that boat VMs can reach.` }));
    process.exit(4);
  }
}

if (cmd === "nested") {
  // Selftest only: the boat key is passed in a 0600 file for this one check and deleted right after reading.
  const key = readFileSync(arg!, "utf8").trim();
  rmSync(arg!, { force: true });
  const { BOAT } = await import("../core/config.js");
  BOAT.apiKey = key;
  const { boatApi, boatCreate, boatExec } = await import("../core/boat.js");
  let id = "";
  const out: Record<string, unknown> = { from_sandbox: process.env.BOAT_ID ?? process.env.BOX_ID ?? null };
  try {
    const c = await boatCreate({ type: "small", ttlSeconds: 600, noEnv: true, snapshots: false });
    id = c.sandbox.id;
    out.worker_sandbox = id;
    await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: `${boatNamespace()}-w-selftest` } }).catch(() => {});
    for (let i = 0; i < 90; i++) {
      const s = (await boatApi(`/sandboxes/${id}`)).sandbox.state;
      if (["ready", "idle", "running"].includes(s)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r = await boatExec(id, `echo ok; claude --version | head -1; env | grep -cE '^(${ENV_PREFIX}|${LEGACY_ENV_PREFIX})' || true`, 60);
    out.exec = r.stdout.trim().split("\n");
  } catch (e) {
    out.error = String(e).replace(key, "<boat key>");
  } finally {
    if (id) {
      const d = await boatApi(`/sandboxes/${id}`, { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }).catch((e: unknown) => ({ error: String(e) }));
      out.deleted = (d as any)?.type ?? d;
    }
  }
  console.log(JSON.stringify(out));
  process.exit(out.error ? 5 : 0);
}

console.error("usage: tsx deploy/in-sandbox.ts guard | preflight | nested <boat-key-file>");
process.exit(2);
