/**
 * A run sandbox as a local container (mold_v0-055, and an on-premises runner's since mold_v0-036): the Docker Engine API
 * over its unix socket (no client library), and the one container shape every run container has, wherever it is
 * started (src/run-sandboxes.ts dockerProvider on a server of its own, src/onprem-runner.ts inside a customer's
 * network). No Docker socket, no mount, every capability dropped but what the runner needs to switch to the run's user
 * and set its own network namespace's firewall; no new privileges; memory, CPU and process limits; its own deadline.
 * Imports only node's own modules and the environment names.
 */
import http from "node:http";
import { ENV } from "./env-names.js";

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** One call to the Docker Engine API. */
export function dockerApi(socketPath: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, method, path: p, timeout: 60_000, headers: { host: "docker", ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8").on("data", (c) => (raw += c)).on("end", () => {
        let json: any = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = { message: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`docker ${method} ${p}: timed out`)));
    req.on("error", reject);
    req.end(data);
  });
}

/** The capabilities a run container keeps (the runner's: its firewall, the switch to the run's user, its files). */
export const RUN_CONTAINER_CAPS = ["NET_ADMIN", "SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL"];

/** The create body of a run container: the runner (src/run-sandbox-runner.ts) as root, with `env`, killed past `ttlSeconds`. */
export function runContainerBody(o: { image: string; network: string; env: Record<string, string>; ttlSeconds: number; labels: Record<string, string> }) {
  return {
    Image: o.image, User: "0", WorkingDir: "/app",
    // The container's own deadline (it has no provider TTL): killed past it, whatever the scaler does.
    Cmd: ["timeout", "-s", "KILL", String(Math.max(60, Math.round(o.ttlSeconds))), "node", "--import", "tsx", "src/run-sandbox-runner.ts"],
    Env: Object.entries(o.env).map(([k, v]) => `${k}=${v}`),
    Labels: o.labels,
    HostConfig: {
      NetworkMode: o.network, Init: true, AutoRemove: false, RestartPolicy: { Name: "no" },
      CapDrop: ["ALL"], CapAdd: [...RUN_CONTAINER_CAPS],
      SecurityOpt: ["no-new-privileges"], Binds: [], Privileged: false,
      Memory: Math.round(num(ENV.APP_RUN_MEMORY_MB, 2048) * 1024 * 1024), NanoCpus: Math.round(num(ENV.APP_RUN_CPUS, 1) * 1e9),
      PidsLimit: num(ENV.APP_RUN_PIDS, 1024), LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
    },
  };
}
