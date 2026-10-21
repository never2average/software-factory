/**
 * The runner inside a run sandbox (mold_v0-055; launched by src/run-sandboxes.ts, one sandbox per run). It runs as root
 * in the sandbox, carries out exactly one run, and exits; the sandbox is torn down after it.
 *
 *   1. claim     POST /api/worker/runs/claim with the token it was given, which is bound to this one run and this one
 *                sandbox: the engine hands out that run or nothing, once (src/run-routes.ts)
 *   2. lockdown  the sandbox's egress proxy (orchestrator/core/egress.ts), started with the run's allowlist from the
 *                claim, and the firewall for the run's user (strict): everything dropped but the proxy's three loopback
 *                ports, TCP 443 and UDP DNS sent to the proxy, which allows only the run's hosts; no local resolver,
 *                no other local daemon, no IPv6. Then the probe, as the run's user: it must reach the
 *                gateway and must not reach anything else directly. Any failure: the run is not started (an
 *                infrastructure failure, so it is retried in a new sandbox while attempts remain)
 *   3. run       src/run-harness.ts with egress "system" (the proxy above) as the run's user (never root)
 *
 * What it reads from its environment (written by the autoscaler into a file only root can read):
 *   OCTILLION_URL, OCTILLION_WORKER_TOKEN   the API and the run-bound token (never the fleet token)
 *   OCTILLION_RUN_ID                        the run (for logs; the token alone decides what is claimed)
 *   OCTILLION_RUN_USER                      the run's user (octirun in the image); or OCTILLION_RUN_UID / _GID
 *   OCTILLION_RUN_PACK_DIR                  the pack's directory, relative to the code (programs of the pack's own)
 *   OCTILLION_RUN_LOCKDOWN                  "on" (the autoscaler always writes it). "off" runs with no firewall and is
 *                                           refused unless OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes (test stand-ins only)
 *
 * It imports only node's own modules and these files (the sandbox gets them and the orchestrator's tsx; nothing else):
 * keep it that way (orchestrator/deploy/boat-lib.ts runnerCodeFiles walks the imports; npm run test:run-sandboxes runs
 * the runner from exactly those files).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeSource, proxySource, setupScript } from "../orchestrator/core/egress.js";
import { httpRunnerClient, runWorkspaceHarness, type HarnessOptions } from "./run-harness.js";

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m: string) => console.error(`run-sandbox: ${m}`);

/** The run user's uid and gid: by name (id -u) or from OCTILLION_RUN_UID/_GID. */
function runUser(): { uid: number; gid: number; name: string | null } | null {
  const name = env.OCTILLION_RUN_USER || null;
  if (name) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`OCTILLION_RUN_USER: not a user name`);
    const id = (flag: string) => Number(spawnSync("id", [flag, name], { encoding: "utf8" }).stdout.trim());
    const uid = id("-u"), gid = id("-g");
    if (!(uid > 0) || !(gid > 0)) throw new Error(`the run user ${name} does not exist in this sandbox`);
    return { uid, gid, name };
  }
  if (env.OCTILLION_RUN_UID) return { uid: Number(env.OCTILLION_RUN_UID), gid: Number(env.OCTILLION_RUN_GID ?? env.OCTILLION_RUN_UID), name: null };
  return null;
}

/** The firewall and proxy for the run's user, with the run's hosts; then the probe as that user. Throws when anything fails. */
export function lockDown(hosts: string[], gatewayUrl: string, user: string, uid: number, gid: number) {
  if (process.getuid?.() !== 0) throw new Error("the lockdown needs the runner to be root in the sandbox");
  const gatewayHost = (() => { try { return new URL(gatewayUrl).hostname.toLowerCase(); } catch { return ""; } })();
  if (!gatewayHost) throw new Error("the lockdown needs the gateway's host for its probe");
  const dir = mkdtempSync("/run/octi-egress-setup-");
  try {
    chmodSync(dir, 0o700);
    writeFileSync(path.join(dir, "egress-proxy.mjs"), proxySource());
    writeFileSync(path.join(dir, "egress-allow.json"), JSON.stringify({ hosts }));
    writeFileSync(path.join(dir, "egress-probe.mjs"), probeSource(gatewayHost));
    writeFileSync(path.join(dir, "egress-setup.sh"), setupScript(dir, { user, sudo: false, systemd: false, strict: true }));
    // A minimal environment: the proxy it starts (an unrestricted user parsing the run's traffic) never holds the token.
    const set = spawnSync("bash", [path.join(dir, "egress-setup.sh")], { encoding: "utf8", timeout: 120_000, env: { PATH: env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin" } });
    if (set.status !== 0) throw new Error(`egress lockdown failed (exit ${set.status}): ${(set.stderr || set.stdout).slice(-600)}`);
    // The probe reads its program from the proxy's install directory (root-owned, world-readable), as the run's user.
    const probe = spawnSync(process.execPath, ["/opt/octi-egress/probe.mjs"], { encoding: "utf8", timeout: 120_000, uid, gid, cwd: "/", env: { PATH: env.PATH ?? "/usr/bin:/bin" } });
    if (probe.status !== 0) throw new Error(`egress probe failed, the run is not started: ${(probe.stdout || probe.stderr).slice(-800)}`);
    log(`egress locked down for ${user}: ${hosts.length} allowed hosts, probe ok`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main(): Promise<number> {
  const url = env.OCTILLION_URL ?? "", token = env.OCTILLION_WORKER_TOKEN ?? "";
  if (!url || !token) { log("OCTILLION_URL and OCTILLION_WORKER_TOKEN are required"); return 2; }
  const lockdown = (env.OCTILLION_RUN_LOCKDOWN ?? "on") !== "off";
  const unsandboxed = env.OCTILLION_ALLOW_UNSANDBOXED_RUNS === "yes";
  // Refused before anything is claimed: the run stays queued for a sandbox that does lock down.
  if (!lockdown && !unsandboxed) { log("OCTILLION_RUN_LOCKDOWN=off is refused (no firewall): only test stand-ins set it, with OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes"); return 2; }
  const user = runUser();
  if (lockdown && !user?.name) { log("the lockdown needs the run user by name (OCTILLION_RUN_USER)"); return 2; }
  const iso: HarnessOptions = user ? { runAs: { uid: user.uid, gid: user.gid } } : unsandboxed && env.OCTILLION_RUN_SAME_USER === "yes" ? { allowSameUser: true } : {};
  const client = httpRunnerClient(url, token, `sbx-${hostname()}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100));
  const claim = await client.claim();
  if (!claim) { log(`nothing to claim (run ${env.OCTILLION_RUN_ID ?? "?"} was taken, ended or is not claimable now)`); return 0; }
  log(`claimed ${claim.run.id} (attempt ${claim.run.attempt})`);
  if (lockdown) {
    try { lockDown(claim.egress.hosts, claim.gateway.gateway_url, user!.name!, user!.uid, user!.gid); }
    catch (e) {
      // Nothing of the run has started: an infrastructure failure, retried in a new sandbox while attempts remain.
      await client.complete(claim.run.id, claim.lease_token, { outcome: "failed", error_kind: "infrastructure", error: String((e as Error).message).slice(0, 2000) }).catch(() => {});
      log(String((e as Error).message));
      return 1;
    }
  }
  const packRel = env.OCTILLION_RUN_PACK_DIR ?? "";
  const packDir = () => {
    const p = path.resolve(ROOT, packRel);
    if (!packRel || (p !== ROOT && !p.startsWith(ROOT + path.sep))) throw new Error("this sandbox has no pack directory for the run");
    return p;
  };
  const view = await runWorkspaceHarness(client, claim, { ...iso, egress: lockdown ? "system" : "proxy", packDir, noNewPrivs: lockdown });
  log(`run ${claim.run.id}: ${view?.status ?? "lease lost"}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { log(`failed: ${(e as Error).message}`); process.exit(1); });
}
