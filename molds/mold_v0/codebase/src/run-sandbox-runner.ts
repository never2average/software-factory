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
 *   APP_URL, APP_WORKER_TOKEN   the API and the run-bound token (never the fleet token)
 *   APP_RUN_ID                        the run (for logs; the token alone decides what is claimed)
 *   APP_RUN_UIDS                      the range the run's user is leased from (mold_v0-078, src/run-users.ts;
 *                                           default 61000-64999): a uid of its own for this run, locked down by number
 *                                           and given an account (apprun-<uid>) in the sandbox, which lives one run.
 *                                           (APP_RUN_USER, a fixed account by name, from an older autoscaler.)
 *   APP_RUN_PACK_DIR                  the pack's directory, relative to the code (programs of the pack's own)
 *   APP_RUN_LOCKDOWN                  "on" (the autoscaler always writes it). "off" runs with no firewall and is
 *                                           refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes (test stand-ins only)
 *   APP_RUN_PRIVATE_ALLOW             only from an on-premises runner (mold_v0-036, src/onprem-runner.ts): the private
 *                                           hosts and networks its owner lets runs reach (orchestrator/core/egress.ts
 *                                           parsePrivateAllow), added to the proxy's allowlist for a run of a kind
 *                                           with private_network only. The hosted app never writes it.
 *
 * It imports only node's own modules and these files (the sandbox gets them and the orchestrator's tsx; nothing else):
 * keep it that way (orchestrator/deploy/boat-lib.ts runnerCodeFiles walks the imports; npm run test:run-sandboxes runs
 * the runner from exactly those files).
 */
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrivateAllow, privateAllowText, probeSource, proxySource, setupScript, type PrivateAllow } from "../orchestrator/core/egress.js";
import { httpRunnerClient, keepLease, runWorkspaceHarness, type HarnessOptions } from "./run-harness.js";
import { leaseRunUser, registerSandboxRunUser, RUN_USER_PREFIX, type RunUser } from "./run-users.js";
import { ENV } from "./env-names.js";

/** The egress setup needs useradd and nft (in /usr/sbin, /sbin); the runner's unit starts with a PATH that lacks them. */
function withSbin(p: string): string {
  const have = new Set(p.split(":"));
  return [...["/usr/local/sbin", "/usr/sbin", "/sbin"].filter((d) => !have.has(d)), p].join(":");
}


const env = ENV;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m: string) => console.error(`run-sandbox: ${m}`);

/** A fixed run user by name (APP_RUN_USER, an older autoscaler's): its uid and gid. Null: one is leased per run. */
function namedRunUser(): { uid: number; gid: number; name: string } | null {
  const name = env.APP_RUN_USER || null;
  if (!name) return null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`APP_RUN_USER: not a user name`);
  const id = (flag: string) => Number(spawnSync("id", [flag, name], { encoding: "utf8" }).stdout.trim());
  const uid = id("-u"), gid = id("-g");
  if (!(uid > 0) || !(gid > 0)) throw new Error(`the run user ${name} does not exist in this sandbox`);
  return { uid, gid, name };
}

/**
 * A program run to its end without blocking this process (mold_v0-179): the run's lease is kept by timers meanwhile, which
 * a spawnSync would hold up for as long as the program runs. Killed at `timeoutMs` (status null, as spawnSync's).
 */
function runAsync(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { timeoutMs, ...o } = opts;
    let stdout = "", stderr = "", done = false;
    const child = spawn(cmd, args, { ...o, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (status: number | null) => { if (!done) { done = true; clearTimeout(t); resolve({ status, stdout, stderr }); } };
    const t = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < 1e6) stdout += d; });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < 1e6) stderr += d; });
    child.on("error", (e) => { stderr += String(e.message); finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** The firewall and proxy for the run's user, with the run's hosts; then the probe as that user. Throws when anything fails. */
export async function lockDown(hosts: string[] | { hosts: string[]; exact?: string[]; private?: PrivateAllow[] }, gatewayUrl: string, user: string, uid: number, gid: number) {
  const allow: { hosts: string[]; exact?: string[]; private?: PrivateAllow[] } = Array.isArray(hosts) ? { hosts }
    : { hosts: hosts.hosts, exact: hosts.exact ?? [], ...(hosts.private?.length ? { private: hosts.private } : {}) };
  if (process.getuid?.() !== 0) throw new Error("the lockdown needs the runner to be root in the sandbox");
  const gatewayHost = (() => { try { return new URL(gatewayUrl).hostname.toLowerCase(); } catch { return ""; } })();
  if (!gatewayHost) throw new Error("the lockdown needs the gateway's host for its probe");
  const dir = mkdtempSync("/run/app-egress-setup-");
  try {
    chmodSync(dir, 0o700);
    writeFileSync(path.join(dir, "egress-proxy.mjs"), proxySource());
    writeFileSync(path.join(dir, "egress-allow.json"), JSON.stringify(allow));
    writeFileSync(path.join(dir, "egress-probe.mjs"), probeSource(gatewayHost));
    // By number: the run's user is leased per run (mold_v0-078), its uid is what the firewall matches.
    writeFileSync(path.join(dir, "egress-setup.sh"), setupScript(dir, { user, uid, sudo: false, systemd: false, strict: true }));
    // A minimal environment: the proxy it starts (an unrestricted user parsing the run's traffic) never holds the token.
    const set = await runAsync("bash", [path.join(dir, "egress-setup.sh")], { timeoutMs: 120_000, env: { PATH: withSbin(env.PATH ?? "/usr/bin:/bin") } });
    if (set.status !== 0) throw new Error(`egress lockdown failed (exit ${set.status}): ${(set.stderr || set.stdout).slice(-600)}`);
    // The local resolver's and the system bus's unix sockets: the run's user may not ask them to resolve names (netfilter
    // never sees a unix socket). Best effort, where setfacl exists (boat); the firewall keeps every packet in either way.
    for (const s of ["/run/systemd/resolve/io.systemd.Resolve", "/run/systemd/resolve/io.systemd.Resolve.Monitor", "/run/dbus/system_bus_socket"])
      if (existsSync(s)) await runAsync("setfacl", ["-m", `u:${uid}:---`, s], { timeoutMs: 10_000, env: { PATH: withSbin(env.PATH ?? "/usr/bin:/bin") } });
    // The probe reads its program from the proxy's install directory (root-owned, world-readable), as the run's user.
    const probe = await runAsync(process.execPath, ["/opt/app-egress/probe.mjs"], { timeoutMs: 120_000, uid, gid, cwd: "/", env: { PATH: env.PATH ?? "/usr/bin:/bin" } });
    if (probe.status !== 0) throw new Error(`egress probe failed, the run is not started: ${(probe.stdout || probe.stderr).slice(-800)}`);
    const priv = allow.private ?? [];
    log(`egress locked down for ${user} (uid ${uid}): ${allow.hosts.length + (allow.exact?.length ?? 0)} allowed hosts${priv.length ? `, private: ${privateAllowText(priv).join(" ")}` : ""}, probe ok`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main(): Promise<number> {
  const url = env.APP_URL ?? "", token = env.APP_WORKER_TOKEN ?? "";
  if (!url || !token) { log("APP_URL and APP_WORKER_TOKEN are required"); return 2; }
  const lockdown = (env.APP_RUN_LOCKDOWN ?? "on") !== "off";
  const unsandboxed = env.APP_ALLOW_UNSANDBOXED_RUNS === "yes";
  // Refused before anything is claimed: the run stays queued for a sandbox that does lock down.
  if (!lockdown && !unsandboxed) { log("APP_RUN_LOCKDOWN=off is refused (no firewall): only test stand-ins set it, with APP_ALLOW_UNSANDBOXED_RUNS=yes"); return 2; }
  const named = namedRunUser();
  const root = process.getuid?.() === 0;
  // An on-premises runner's private allow list (mold_v0-036): checked before anything is claimed, so a bad one never
  // takes a run.
  let privateAllow: PrivateAllow[] = [];
  try { privateAllow = parsePrivateAllow(env.APP_RUN_PRIVATE_ALLOW); }
  catch (e) { log(`APP_RUN_PRIVATE_ALLOW: ${(e as Error).message}`); return 2; }
  if (lockdown && !root) { log("the lockdown needs the runner to be root in the sandbox"); return 2; }
  const client = httpRunnerClient(url, token, `sbx-${hostname()}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100));
  const claim = await client.claim();
  if (!claim) { log(`nothing to claim (run ${env.APP_RUN_ID ?? "?"} was taken, ended or is not claimable now)`); return 0; }
  log(`claimed ${claim.run.id} (attempt ${claim.run.attempt})`);
  // The run's lease (and its workspace store's) is kept from here: the set-up below can outlast it (mold_v0-179).
  const keeper = keepLease(client, claim.run.id, claim.lease_token, claim.lease_seconds, () => log("the run's lease was lost while the sandbox was being prepared"));
  const t0 = Date.now(), timings: Record<string, number> = {};
  const lap = (k: string) => { timings[k] = Date.now() - t0; };
  // mold_v0-078: the run's own user, leased for this run (a named one only from an older autoscaler); locked down by uid.
  let leased: RunUser | null = null;
  if (root && !(unsandboxed && env.APP_RUN_SAME_USER === "yes")) {
    try { leased = await leaseRunUser(claim.run.id, named ? { fixed: { uid: named.uid, gid: named.gid } } : {}); lap("run_user_ms"); }
    catch (e) {
      keeper.stop();
      await client.complete(claim.run.id, claim.lease_token, { outcome: "failed", error_kind: "infrastructure", error: `the run's user: ${String((e as Error).message)}`.slice(0, 2000) }).catch(() => {});
      log(String((e as Error).message));
      return 1;
    }
  }
  const iso: HarnessOptions = leased ? { runUser: leased } : unsandboxed && env.APP_RUN_SAME_USER === "yes" ? { allowSameUser: true } : {};
  try {
    // Test stand-ins only (APP_ALLOW_UNSANDBOXED_RUNS=yes): a preparation as slow as a real sandbox's can be.
    const slow = unsandboxed ? Number(env.APP_RUN_TEST_PREPARE_MS ?? 0) : 0;
    if (slow > 0) await new Promise((r) => setTimeout(r, slow));
    if (lockdown) {
      // The sandbox lives one run: its run user gets an account (tools that look their user up find one).
      const name = named?.name ?? (registerSandboxRunUser(leased!.uid) ? `${RUN_USER_PREFIX}${leased!.uid}` : "apprun");
      // The private allow list only for a run that needs the private network; every other run gets exactly the hosted one.
      const priv = (claim.run.spec as { private_network?: boolean }).private_network ? privateAllow : [];
      try { await lockDown({ ...claim.egress, private: priv }, claim.gateway.gateway_url, name.length <= 32 ? name : "apprun", leased!.uid, leased!.gid); lap("lockdown_ms"); }
      catch (e) {
        keeper.stop();
        // Nothing of the run has started: an infrastructure failure, retried in a new sandbox while attempts remain.
        await client.complete(claim.run.id, claim.lease_token, { outcome: "failed", error_kind: "infrastructure", error: String((e as Error).message).slice(0, 2000) }).catch(() => {});
        log(String((e as Error).message));
        return 1;
      }
    }
    const packRel = env.APP_RUN_PACK_DIR ?? "";
    const packDir = () => {
      const p = path.resolve(ROOT, packRel);
      if (!packRel || (p !== ROOT && !p.startsWith(ROOT + path.sep))) throw new Error("this sandbox has no pack directory for the run");
      return p;
    };
    // How long the sandbox took to prepare, on the run (its events): what to look at when a sandbox is slow to start.
    lap("prepared_ms");
    log(`prepared in ${timings.prepared_ms} ms: ${JSON.stringify(timings)}`);
    await client.events(claim.run.id, claim.lease_token, [{ type: "sandbox_prepared", data: timings }]).catch(() => {});
    // The harness heartbeats from its start (every lease_seconds / 3 too): the lease is never left longer than that.
    keeper.stop();
    const view = await runWorkspaceHarness(client, claim, { ...iso, egress: lockdown ? "system" : "proxy", packDir, noNewPrivs: lockdown });
    log(`run ${claim.run.id}: ${view?.status ?? "lease lost"}`);
    return 0;
  } finally { keeper.stop(); await leased?.release().catch(() => false); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { log(`failed: ${(e as Error).message}`); process.exit(1); });
}
