// The acceptance evaluator carried out as a run sandbox's runner carries it out (mold_v0-324), on this machine or inside
// a run container, with the API's evaluation calls answered from a folder (scripts/fixtures/judge/drive.ts). Used by
// scripts/hosted-judge-test.ts and the CLI scripts/judge-sandbox.ts (a pack's own frozen test against a candidate, before
// a live run). Needs root; the container needs Docker and a runner image (one built from this codebase's Dockerfile).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dockerApi, runContainerBody } from "../../src/run-container.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DRIVER = path.join("scripts", "fixtures", "judge", "drive.ts");

/** What to measure: the frozen test's folder (its cases and scorer), the candidate's and the baseline's trees, as on the API. */
export interface JudgeSpec {
  test_dir: string; candidate_dir: string; champion_dir?: string | null; cases_path: string;
  candidate_command: string[]; scorer_command: string[]; timeout_seconds: number; metric: string; floors: string[];
  /** "auto": a namespace each where one can be made, else the firewall; "firewall": the firewall always. */
  network?: "auto" | "firewall"; deadline_seconds?: number; control?: { host: string; port: number };
  uids?: { first: number; last: number };
}
export interface JudgeOut {
  control: string;
  result: { cases: { id: string; candidate: number | null; baseline: number | null; floors: Record<string, number | null> }[]; tampered: string | null; error?: string | null } | null;
  events: { type: string; data?: Record<string, unknown> }[]; completion: { outcome: string; error?: string } | null; ms: number;
}

/** A folder only root reads, holding a copy of the inputs at test/, candidate/, champion/: what the run users never see. */
function stage(spec: JudgeSpec): { dir: string; rel: (base: string) => Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), "judge-"));
  chmodSync(dir, 0o700);
  cpSync(spec.test_dir, path.join(dir, "test"), { recursive: true });
  cpSync(spec.candidate_dir, path.join(dir, "candidate"), { recursive: true });
  if (spec.champion_dir) cpSync(spec.champion_dir, path.join(dir, "champion"), { recursive: true });
  mkdirSync(path.join(dir, "uids"));
  const rel = (base: string) => ({ ...spec, test_dir: path.join(base, "test"), candidate_dir: path.join(base, "candidate"), champion_dir: spec.champion_dir ? path.join(base, "champion") : null, uid_dir: path.join(base, "uids") });
  return { dir, rel };
}

/** On this machine, as root: the evaluator with its three run users (the firewall path or the namespace path). */
export function judgeHere(spec: JudgeSpec, env: Record<string, string> = {}): JudgeOut {
  const s = stage(spec);
  try {
    const out = path.join(s.dir, "out.json");
    writeFileSync(path.join(s.dir, "spec.json"), JSON.stringify({ uids: { first: 62600, last: 62660 }, ...s.rel(s.dir), out }));
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, DRIVER), path.join(s.dir, "spec.json")], { cwd: ROOT, encoding: "utf8", timeout: 4 * 3600_000, env: { ...process.env, ...env } });
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the driver: exit ${r.status} ${r.signal ?? ""} ${(r.stderr || r.stdout).slice(-1500)}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
}

/** The bridge network's gateway: an address of this machine a run container reaches (the proof's "outside"). */
export async function bridgeGateway(sock = dockerSocket()): Promise<string | null> {
  return ((await dockerApi(sock, "GET", "/networks/bridge")).json?.IPAM?.Config?.[0]?.Gateway as string | undefined) ?? null;
}
export const dockerSocket = () => process.env.APP_DOCKER_SOCKET || "/var/run/docker.sock";

/**
 * In a run container: src/run-container.ts runContainerBody's shape exactly (every capability dropped but the runner's,
 * no new privileges, its memory, CPU and process limits, its deadline), from `image`, with this checkout's runner code
 * mounted over the image's own (read-only) and the staged inputs at /spec. `drop`: capabilities taken from the runner's
 * too (a test of the refusal). `env`: the container's environment (the proof's fake secret).
 */
export async function judgeInContainer(spec: JudgeSpec, o: { image: string; drop?: string[]; env?: Record<string, string>; ttlSeconds?: number; sock?: string }): Promise<JudgeOut> {
  const sock = o.sock ?? dockerSocket();
  const s = stage(spec);
  const ttl = Math.max(60, Math.round(o.ttlSeconds ?? 3600));
  try {
    writeFileSync(path.join(s.dir, "spec.json"), JSON.stringify({ network: "auto", egress: "system", uids: { first: 61000, last: 61100 }, ...s.rel("/spec"), out: "/spec/out.json" }));
    const body = runContainerBody({ image: o.image, network: "bridge", ttlSeconds: ttl, labels: { "org.judge-sandbox": "1" }, env: o.env ?? {} }) as unknown as { Cmd: string[]; HostConfig: { CapAdd: string[]; Binds: string[] } };
    body.Cmd = ["timeout", "-s", "KILL", String(ttl), "node", "--import", "tsx", DRIVER, "/spec/spec.json"];
    body.HostConfig.CapAdd = body.HostConfig.CapAdd.filter((c) => !(o.drop ?? []).includes(c));
    body.HostConfig.Binds = [`${ROOT}/src:/app/src:ro`, `${ROOT}/orchestrator/core:/app/orchestrator/core:ro`, `${ROOT}/scripts:/app/scripts:ro`, `${s.dir}:/spec`];
    const made = await dockerApi(sock, "POST", `/containers/create?name=judge-sandbox-${randomBytes(4).toString("hex")}`, body);
    if (made.status !== 201) throw new Error(`docker create: ${made.status} ${JSON.stringify(made.json)}`);
    const id = made.json.Id as string;
    try {
      const st = await dockerApi(sock, "POST", `/containers/${id}/start`);
      if (st.status !== 204) throw new Error(`docker start: ${st.status} ${JSON.stringify(st.json)}`);
      await new Promise<void>((resolve) => { const t = setInterval(async () => { const j = (await dockerApi(sock, "GET", `/containers/${id}/json`).catch(() => ({ json: null }))).json; if (!j?.State?.Running) { clearInterval(t); resolve(); } }, 1000); });
      const f = path.join(s.dir, "out.json");
      if (!existsSync(f)) {
        const logs = spawnSync("docker", ["logs", "--tail", "40", id], { encoding: "utf8" });
        throw new Error(`the container wrote no result: ${(logs.stdout + logs.stderr).slice(-2000)}`);
      }
      return JSON.parse(readFileSync(f, "utf8"));
    } finally { await dockerApi(sock, "DELETE", `/containers/${id}?force=1`).catch(() => null); }
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
}
