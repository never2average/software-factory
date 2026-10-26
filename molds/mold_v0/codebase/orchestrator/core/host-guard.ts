/**
 * Host guard: the orchestrator runs ONLY inside a boat.dev sandbox (the "orchestrator sandbox"), and its only
 * production runner is `boat` (worker sandboxes created from there, sandbox from sandbox). Nothing agent-related may
 * run on the main VM, which hosts only the server stack.
 *
 * A host passes when ALL of these hold:
 *  1. APP_HOST_ROLE=boat-orchestrator (written by the launcher into the orchestrator's env file)
 *  2. the launcher's marker file (/etc/app/host-role, root-owned) says {"role":"boat-orchestrator", ...}
 *  3. boat's own indicators (seen on live boat VMs, 2026-10-10): BOAT_ID or BOX_ID in the env, /etc/ascii and
 *     /home/user/.ascii present (boat's agent + CLI)
 *  4. when the marker records a sandbox id and BOAT_ID looks like one (bx_...), they match
 * and RUNNER is `boat`.
 *
 * APP_DEV_ALLOW_LOCAL=1 bypasses all of it (tests and local development only) with a loud warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { appEnv } from "./env-names.js";

export const HOST_ROLE = "boat-orchestrator";
export const MARKER_PATH = "/etc/app/host-role";

export interface HostProbe {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  read(path: string): string | null;
}

export const realProbe: HostProbe = {
  env: process.env,
  exists: (p) => existsSync(p),
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
};

export interface GuardResult { ok: boolean; dev: boolean; problems: string[]; warning?: string }

export function checkHost(runner: string, probe: HostProbe = realProbe): GuardResult {
  const env = appEnv(probe.env);
  if (env.APP_DEV_ALLOW_LOCAL === "1") {
    return {
      ok: true, dev: true, problems: [],
      warning: [
        "#".repeat(78),
        "# APP_DEV_ALLOW_LOCAL=1: HOST GUARD DISABLED. Tests / local development ONLY.",
        `# This process may run coding agents on THIS machine (RUNNER=${runner}). Never set this in production:`,
        "# production orchestrators run only inside boat.dev sandboxes (orchestrator/deploy/boat-orchestrators.ts).",
        "#".repeat(78),
      ].join("\n"),
    };
  }
  const problems: string[] = [];
  if (runner !== "boat") problems.push(`RUNNER=${runner} is not allowed in production (only "boat"; pool/docker/local need APP_DEV_ALLOW_LOCAL=1, tests only)`);
  // The coding agent runs task text written by customers: never as boat's sudo-capable user (docs/security.md).
  if (env.BOAT_AGENT_USER === "user") problems.push("BOAT_AGENT_USER=user runs the coding agent with passwordless sudo; not allowed in production (the default agent user has none)");
  if (env.APP_HOST_ROLE !== HOST_ROLE) problems.push(`APP_HOST_ROLE is not "${HOST_ROLE}" (set by the launcher's env file)`);
  const markerRaw = probe.read(MARKER_PATH);
  let marker: { role?: string; sandbox_id?: string } | null = null;
  try { marker = markerRaw ? JSON.parse(markerRaw) : null; } catch { marker = null; }
  if (marker?.role !== HOST_ROLE) problems.push(`launcher marker ${MARKER_PATH} is missing or not a ${HOST_ROLE} marker`);
  const boatId = env.BOAT_ID ?? env.BOX_ID;
  if (!boatId) problems.push("no BOAT_ID/BOX_ID in the environment (not a boat.dev VM?)");
  if (!probe.exists("/etc/ascii") || !probe.exists("/home/user/.ascii")) problems.push("boat agent files (/etc/ascii, /home/user/.ascii) not found (not a boat.dev VM?)");
  if (marker?.sandbox_id && boatId && /^bx_/.test(boatId) && boatId !== marker.sandbox_id)
    problems.push(`BOAT_ID ${boatId} does not match the launcher marker's sandbox ${marker.sandbox_id}`);
  return { ok: problems.length === 0, dev: false, problems };
}

/** Throw unless this process may run as an orchestrator here. Prints the dev warning loudly when bypassed. */
let warned = false;
export function assertOrchestratorHost(runner: string, probe: HostProbe = realProbe): void {
  const r = checkHost(runner, probe);
  if (r.warning && !warned) { console.error(r.warning); warned = true; }
  if (!r.ok) {
    throw new Error(
      "Refusing to start: the orchestrator runs only inside a boat.dev orchestrator sandbox " +
      "(start it with `npm run boat-orchestrators -- up <n>` from orchestrator/).\n  - " + r.problems.join("\n  - "));
  }
}
