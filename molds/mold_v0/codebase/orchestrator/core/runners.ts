/**
 * Sandbox runners. A sandbox lives for the whole session and can run the harness several times
 * (launch, then resumes with the simulated developer's replies) in the same workdir.
 *
 *  - boat:   one boat.dev VM per session over its REST API (default).
 *  - docker: one long-lived container per session (`docker exec` per turn).
 *  - local:  host CLI in a temp dir. DEV ONLY, no isolation.
 *
 * BLINDNESS: a sandbox receives only the harness input on stdin, the optional repo and the harness env
 * (its own API key + quiet flags). Never session ids, the server's URLs/tokens, customer names or the orchestrator key.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../fleet/plan.js";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type { HarnessAdapter } from "../harnesses/adapters.js";
import { seedBase, seedScript, type TemplateId } from "./workspaces.js";
import type { SessionEnvironment } from "./environment.js";
import { envInstallScript, harnessWiringScript, parseEnvLines, toolsFor } from "./env-install.js";
import { BOAT, BOAT_PRICE_PER_HOUR, CFG } from "./config.js";
import { HttpError, log, sh, shq, sleep, withRetry } from "./util.js";
import { EGRESS_DIR, proxyEnv, proxySource, probeSource, diagnosticsScript as egressDiagnostics, setupScript as egressSetupScript, type EgressPolicy } from "./egress.js";
import { boatApi, boatCommandRetry, boatCreate, boatExec, boatExecStream, boatSandboxPath, BoatError } from "./boat.js";
import { ENV, isShellEnvName } from "./env-names.js";

export interface RunExit { code: number | null; signal: string | null; error?: string }

export interface Turn {
  /** Harness stdout: one JSON event per line. */
  stdout: Readable;
  stderr: Readable;
  /** Resolves once the harness exited and stdout/stderr ended. Never rejects. */
  exited: Promise<RunExit>;
}

export interface Sandbox {
  id: string;
  /** Absolute harness workdir inside the sandbox. */
  workdir: string;
  /** Run the harness once: argv[0] is the binary, `input` goes to stdin byte-for-byte. One turn at a time. */
  /**
   * `env` = the harness credentials + flags for THIS run (from the broker). Injected only at exec time under
   * `env -i`; never written into the image, the container env or argv.
   */
  runTurn(argv: string[], input: string, env: Record<string, string>): Promise<Turn>;
  /** Network lockdown applied at open (private runs): allowed host count and the probe result. */
  egress?: { hosts: number; probe: unknown };
  /** Unified diff of everything the agent changed (vs the cloned commit, or vs empty). null if unavailable. */
  diff(): Promise<string | null>;
  /**
   * Stop the current harness run gracefully (SIGTERM to the CLI), keeping the sandbox and its workspace: used when
   * the session's agent-turn cap is reached mid-run. Optional; without it the run continues until the deadline.
   */
  stopTurn?(): Promise<void>;
  /** Hard-stop (idempotent). */
  kill(): Promise<void>;
  /** Free resources (idempotent). */
  cleanup(): Promise<void>;
  meta(): Record<string, unknown>;
  /** What the developer environment step did (boat runner); undefined when the session had none. */
  environment?: EnvironmentResult;
}

export interface EnvironmentResult {
  /** present = already on the sandbox (not reinstalled); installed = installed for this session. */
  /** launch: "acp" = the harness ran over the Agent Client Protocol with a Zed-like client; "cli" = as a CLI. */
  launch: "acp" | "cli";
  editor: string; language: string | null; requested: string[]; present: string[]; installed: string[]; failed: string[]; dropped: string[];
  wired: Record<string, string>; wiring: string; seconds: number;
  /** Skill names and whether standing rules were written (contents are in the persona, not repeated here). */
  skills: string[]; agent_rules: boolean;
}

export interface OpenSpec {
  adapter: HarnessAdapter;
  repoUrl: string | null;
  /**
   * Starter workspace (orchestrator/workspaces/<template>) seeded and committed when there is no repoUrl, so the
   * agent sees an existing project. The diff is taken against that commit. null/undefined = empty workdir.
   */
  template?: TemplateId | null;
  /** Raw job harness id (pool runner picks a pod by it). */
  harness?: string;
  /** Host-side job key (the server's session id) for pool reservations. Never passed into a sandbox. */
  jobKey?: string;
  /** Registry agent id (pool group) and the job's model; the pool asserts the group's model matches. */
  agentId?: string;
  model?: string;
  /** The persona's developer environment (CLI tools, language servers), installed and wired before the first run (boat only). */
  environment?: SessionEnvironment | null;
  /**
   * Network lockdown for the agent (core/egress.ts; boat only): after setup, the agent reaches only these hosts through
   * an in-VM proxy, verified by a probe; the open fails if it cannot be enforced. Set for private runs.
   */
  egress?: EgressPolicy | null;
}

export interface Runner {
  name: string;
  open(spec: OpenSpec): Promise<Sandbox>;
}

export const AGENT_HOME = "/home/agent"; // same layout in boat and docker
export const AGENT_WORKDIR = `${AGENT_HOME}/work`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Lockfiles: their content (every transitive package name) stays out of the scored diff; only a name line. */
export const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "Cargo.lock", "Gemfile.lock", "composer.lock"];
const LOCK_EXCLUDE = LOCKFILES.map((f) => `':(exclude,glob)**/${f}'`).join(" ");
const LOCK_ONLY = LOCKFILES.map((f) => `':(glob)**/${f}'`).join(" ");

/**
 * Diff script, parameterized by env WORK, SNAP (git dir used when the workdir is not a repo; kept outside the
 * workdir so the agent never sees a .git it did not create) and BASE (cloned commit, optional).
 * Lockfile changes are listed by name only ("# lockfile changed: ...").
 */
/**
 * A repo URL may pin a commit (or tag/branch) after "#": https://github.com/acme/app#3f2c1d0. Pinned repos fetch exactly
 * that commit, so every run of a scenario sees the identical codebase; unpinned ones clone the default branch.
 */
export function parseRepoUrl(raw: string): { url: string; ref: string | null } {
  const i = raw.lastIndexOf("#");
  if (i < 0) return { url: raw, ref: null };
  const ref = raw.slice(i + 1);
  if (!/^[\w][\w.\/-]{0,199}$/.test(ref)) throw new Error(`Invalid repo ref "${ref}"`);
  return { url: raw.slice(0, i), ref };
}

/** Clone URL (at REF when set) into W; prints the checked-out commit last. Inputs come from the environment. */
export const CLONE_SCRIPT = `set -euo pipefail
if [ -n "\${REF:-}" ]; then
  git init -q "$W"
  git -C "$W" remote add origin "$URL"
  git -C "$W" fetch -q --depth 1 origin "$REF"
  git -C "$W" checkout -q FETCH_HEAD
else
  git clone --depth 1 -q "$URL" "$W"
fi
git -C "$W" rev-parse HEAD`;

export const DIFF_SCRIPT = `cd "$WORK" 2>/dev/null || exit 0
G="git -c core.quotepath=off -c safe.directory=*"
if [ -d .git ]; then
  B="\${BASE:-${EMPTY_TREE}}"
else
  export GIT_DIR="$SNAP" GIT_WORK_TREE="$WORK"
  rm -rf "$GIT_DIR"; git init -q
  printf "node_modules/\\n.venv/\\nvenv/\\n__pycache__/\\n" > "$GIT_DIR/info/exclude"
  B=${EMPTY_TREE}
fi
$G add -A >/dev/null 2>&1
$G diff --cached --no-color --no-ext-diff "$B" -- . ${LOCK_EXCLUDE} ':(exclude,glob)**/.serena/**'
$G diff --cached --name-only "$B" -- ${LOCK_ONLY} | sed 's/^/# lockfile changed (content omitted): /'`;

export function capDiff(d: string): string {
  return d.length > BOAT.diffMaxBytes ? d.slice(0, BOAT.diffMaxBytes) + "\n[diff truncated by worker]\n" : d;
}

/**
 * The local images' names before mold_v0-097 (agents app/agent-<harness> were octillion/agent-<harness>, the session
 * sandbox app-sandbox was octillion-sandbox). A host whose images were built under the old names keeps running them
 * until they are rebuilt: a tag this host does not have is looked up under its old name, until a later cleanup.
 */
const LEGACY_IMAGES: [RegExp, string][] = [[/^app\/agent-/, "octillion/agent-"], [/^app-sandbox:/, "octillion-sandbox:"]];
const localImages = new Map<string, string>();
/** The local image to run for `tag`: itself, or its old name when only that is on this host (never pulled: --pull never). */
export async function localImage(tag: string): Promise<string> {
  const known = localImages.get(tag);
  if (known) return known;
  if ((await sh("docker", ["image", "inspect", "-f", "{{.Id}}", tag])).code === 0) { localImages.set(tag, tag); return tag; }
  for (const [re, old] of LEGACY_IMAGES) {
    if (!re.test(tag)) continue;
    const legacy = tag.replace(re, old);
    if ((await sh("docker", ["image", "inspect", "-f", "{{.Id}}", legacy])).code !== 0) continue;
    log(`image ${tag} is not on this host: running ${legacy}, its name before mold_v0-097 (rebuild it with orchestrator/images/build.sh)`);
    localImages.set(tag, legacy);
    return legacy;
  }
  return tag;
}

/** Image env minus the shell's own names, APP_* and their old spelling (blindness), for `env -i` at exec time. */
export async function imageEnv(image: string): Promise<string[]> {
  const r = await sh("docker", ["image", "inspect", "-f", "{{json .Config.Env}}", image]);
  if (r.code !== 0) throw new Error(`image ${image} not found: ${r.out.slice(-200)}`);
  const list: string[] = JSON.parse(r.out.trim() || "[]") ?? [];
  return list.filter((kv) => !isShellEnvName((kv.includes("=") ? kv.slice(0, kv.indexOf("=")) : kv).toUpperCase()));
}

/**
 * `docker exec` argv running `argv` under `env -i` with only `baseEnv` (neutral image env) plus the harness keys.
 * Key values travel as `-e NAME` from the docker CLI's env (never in argv / host `ps`) and never sit in the
 * container's own env.
 */
export function dockerExecHarness(container: string, baseEnv: string[], keys: string[], argv: string[], user = "agent"): string[] {
  const script = `exec env -i ${baseEnv.map(shq).join(" ")} ${keys.map((k) => `${k}="$${k}"`).join(" ")} "$@"`;
  return ["exec", "-i", "-u", user, "-w", AGENT_WORKDIR, ...keys.flatMap((k) => ["-e", k]), container, "bash", "-c", script, "run", ...argv];
}

function childTurn(child: ChildProcess): Turn {
  const exited = new Promise<RunExit>((resolve) => {
    child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { stdout: child.stdout!, stderr: child.stderr!, exited };
}

// ---------------------------------------------------------------- docker

/** One long-lived container per session from SANDBOX_IMAGE (see Dockerfile.sandbox); `docker exec` per turn. */
export const dockerRunner: Runner = {
  name: "docker",
  async open(spec) {
    const name = `sandbox-${randomUUID().slice(0, 12)}`;
    const image = await localImage(CFG.dockerImage);
    const args = [
      "run", "-d", "--init", "--pull", "never",
      "--name", name,
      "--label", "app.sandbox=1",
      "--cpus", CFG.dockerCpus,
      "--memory", CFG.dockerMemory,
      "--pids-limit", "1024",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "-w", AGENT_WORKDIR,
    ];
    if (CFG.dockerNetwork) args.push("--network", CFG.dockerNetwork);
    args.push(image, "sleep", "infinity");
    const baseEnv = await imageEnv(image);
    const r = await sh("docker", args);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.out.slice(-500)}`);
    const rmContainer = () => sh("docker", ["rm", "-f", name]).then(() => {});
    let base = "";
    if (spec.repoUrl) {
      const { url, ref } = parseRepoUrl(spec.repoUrl);
      const c = await sh("docker", ["exec", "-e", `URL=${url}`, "-e", `REF=${ref ?? ""}`, "-e", `W=${AGENT_WORKDIR}`, name, "bash", "-c", CLONE_SCRIPT]);
      if (c.code !== 0) { await rmContainer(); throw new Error(`git clone failed: ${c.out.slice(-500)}`); }
      base = c.out.trim().split("\n").pop() ?? "";
    } else if (spec.template) {
      const c = await sh("docker", ["exec", "-e", `W=${AGENT_WORKDIR}`, name, "bash", "-c", seedScript(spec.template)]);
      if (c.code !== 0) { await rmContainer(); throw new Error(`workspace seed failed: ${c.out.slice(-500)}`); }
      base = seedBase(c.out);
    }
    let current: ChildProcess | null = null;
    let killed = false;
    return {
      id: `docker:${name}`,
      workdir: AGENT_WORKDIR,
      async runTurn(argv, input, env) {
        // Key values travel as `docker exec -e NAME` from our env (never argv, never the container env).
        const child = spawn("docker", dockerExecHarness(name, baseEnv, Object.keys(env), argv), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("docker", ["exec", "-e", `BASE=${base}`, "-e", `WORK=${AGENT_WORKDIR}`, "-e", "SNAP=/tmp/.octi-snap.git", name, "bash", "-c", DIFF_SCRIPT]);
        return r.code === 0 ? capDiff(r.out) : null;
      },
      async stopTurn() { await sh("docker", ["exec", name, "bash", "-c", "pkill -TERM -u agent || true"]); },
      async kill() {
        if (killed) return;
        killed = true;
        await rmContainer();
        current?.kill("SIGKILL");
      },
      async cleanup() { await rmContainer(); },
      meta: () => ({}),
    };
  },
};

// ---------------------------------------------------------------- local

/**
 * Local: runs the CLI on the host in a fresh temp dir. DEV ONLY - no isolation.
 * HOME / CODEX_HOME point at an empty temp dir so the developer's ~/.claude, ~/.codex, CLAUDE.md, memories
 * and MCP servers don't leak in (would break blindness).
 */
export const localRunner: Runner = {
  name: "local",
  async open(spec) {
    const root = await mkdtemp(join(tmpdir(), "agent-"));
    const work = join(root, "work");
    const home = join(root, "home");
    await mkdir(work, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "dumb",
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: root,
    };
    let base = "";
    if (spec.repoUrl) {
      const { url, ref } = parseRepoUrl(spec.repoUrl);
      const r = await sh("bash", ["-c", CLONE_SCRIPT], { env: { ...baseEnv, URL: url, REF: ref ?? "", W: work } });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.out.slice(-500)}`);
      }
      base = r.out.trim().split("\n").pop() ?? "";
    } else if (spec.template) {
      const r = await sh("bash", ["-c", seedScript(spec.template)], { env: { ...baseEnv, W: work } });
      if (r.code !== 0) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`workspace seed failed: ${r.out.slice(-500)}`);
      }
      base = seedBase(r.out);
    }
    let current: ChildProcess | null = null;
    const killGroup = () => {
      try { if (current?.pid) process.kill(-current.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    return {
      id: `local:${root}`,
      workdir: work,
      async runTurn(argv, input, env) {
        const [cmd, ...args] = argv;
        const child = spawn(cmd!, args, { cwd: work, env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
        current = child;
        child.stdin!.end(input);
        return childTurn(child);
      },
      async diff() {
        const r = await sh("bash", ["-c", DIFF_SCRIPT], { env: { ...baseEnv, WORK: work, SNAP: join(root, "snap.git"), BASE: base } });
        return r.code === 0 ? capDiff(r.out) : null;
      },
      async stopTurn() { try { if (current?.pid) process.kill(-current.pid, "SIGTERM"); } catch { /* already gone */ } },
      async kill() { killGroup(); },
      async cleanup() { killGroup(); await rm(root, { recursive: true, force: true }).catch(() => {}); },
      meta: () => ({}),
    };
  },
};

// ---------------------------------------------------------------- boat.dev
//
// One fresh VM per session, driven over the REST API (https://docs.boat.dev/api/v1):
//   POST /sandboxes {type, ttlSeconds, noEnv:true, snapshots:false} (Idempotency-Key); poll GET until ready
//   PUT  /files: env + scripts + per-turn input -> /tmp/octi (mode 700, Boat's user; the agent user can't read it)
//   POST /commands: prepare (sync); per turn: launch (detached) + follow its JSONL (stream:true); diff (stream)
//   GET  /commands/{processId}: is the turn still running?
//   DELETE /sandboxes/{id} + X-Ascii-Confirm-Delete: force-stop + permanent delete (cleanup / kill)
//
// We don't use Boat's managed POST /prompt + GET /events: Boat injects its own system prompt, `boat` skill and
// `computer` MCP server into managed harnesses (breaks blindness), and its events are a normalized format without
// Claude's `result` usage/cost. We exec the stock preinstalled CLI as an isolated user under `env -i`.

const BOAT_DIR = "/tmp/octi";
const TAIL_SECONDS = 540; // each streamed tail call stays under the 600s command cap, then reconnects

function boatRunAs(): string {
  return BOAT.agentUser === "agent" ? "sudo -n -u agent -H" : "";
}

/**
 * Developer environment (core/environment.ts): install the persona's CLI tools and language servers system-wide, then
 * wire them into the harness as the agent user (config under its HOME only). Never fails the session: a tool that does
 * not install is reported, and the agent runs without it.
 */
async function boatEnvironment(id: string, put: (path: string, content: string) => Promise<unknown>, harness: string, env: SessionEnvironment): Promise<EnvironmentResult> {
  const t0 = Date.now();
  let tools = toolsFor(harness, env);
  // Zed over ACP needs the client file; without it the session runs as a CLI rather than failing.
  if (tools.some((t) => t.id === "acp/client")) {
    try { await put(`${BOAT_DIR}/acp-client.mjs`, readFileSync(ACP_CLIENT_SRC, "utf8")); }
    catch (e) { log(`[boat ${id}] ACP client unavailable (${String(e).slice(0, 200)}); running as a CLI`); tools = tools.filter((t) => !t.id.startsWith("acp/")); }
  }
  await put(`${BOAT_DIR}/env-install.sh`, envInstallScript(tools));
  // One call per tool: boat caps a command at 600s, and a slow install (a JDK) must not take the others with it.
  const inst = { exitCode: 0, stdout: "", stderr: "" };
  for (let i = 0; i < tools.length; i++) {
    const r = await boatExec(id, `ACP_CLIENT_SRC=${BOAT_DIR}/acp-client.mjs bash ${BOAT_DIR}/env-install.sh ${i}`, 600)
      .catch((e) => ({ exitCode: -1, stdout: `ENV ${tools[i]!.id} fail 0\n`, stderr: String(e) }));
    inst.stdout += r.stdout;
    if (r.exitCode !== 0) { inst.exitCode = r.exitCode ?? -1; inst.stderr += `${tools[i]!.id}: ${r.stderr.slice(-300)}\n`; }
  }
  const wiring = harnessWiringScript(harness, tools, env);
  await put(`${BOAT_DIR}/env-wire.sh`, wiring.script);
  const wire = await boatExec(id, `cd / && ${boatRunAs()} env -i HOME=${AGENT_HOME} PATH="$(cat ${BOAT_DIR}/path)" bash -s < ${BOAT_DIR}/env-wire.sh`, 300)
    .catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
  const r = parseEnvLines(`${inst.stdout}\n${wire.stdout}`);
  if (r.failed.length || inst.exitCode !== 0 || wire.exitCode !== 0)
    log(`[boat ${id}] environment: failed ${r.failed.join(", ") || "-"}: ${(inst.stderr || "").slice(-400)} ${wire.exitCode !== 0 ? `wiring: ${(wire.stderr || "").slice(-300)}` : ""}`);
  // ACP only when its pieces are really there (installed now or already present), never on silence.
  const have = new Set([...r.installed, ...r.present]);
  const acpOk = tools.filter((t) => t.id.startsWith("acp/")).every((t) => have.has(t.id)) && tools.some((t) => t.id === "acp/client");
  return { launch: acpOk ? "acp" : "cli", editor: env.editor, language: env.language, requested: tools.map((t) => t.id), present: r.present, installed: r.installed, failed: r.failed,
           dropped: env.dropped ?? [], skills: (env.skills ?? []).map((s) => s.name), agent_rules: !!env.agent_rules, wired: r.wired, wiring: wiring.summary, seconds: Math.round((Date.now() - t0) / 1000) };
}

function boatPrepareScript(bin: string, repoUrl: string | null, seed = false): string {
  // Seed: the template script is read by this (Boat) user's shell and piped to the agent user's bash.
  const repo = repoUrl ? parseRepoUrl(repoUrl) : null;
  const clone = repo
    ? `$RUN env URL=${shq(repo.url)} REF=${shq(repo.ref ?? "")} W="$W" bash -c ${shq(CLONE_SCRIPT)} </dev/null | tail -n 1 > "$O/base"\ntest -s "$O/base"`
    : seed
      ? `$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" W="$W" bash -s < "$O/seed.sh" | tail -n 1 > "$O/base"\ntest -s "$O/base"`
      : ":";
  return `set -euo pipefail
cd /
O=${BOAT_DIR}; AH=${AGENT_HOME}; W=${AGENT_WORKDIR}
if [ ${shq(BOAT.agentUser)} = agent ]; then
  id -u agent >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash agent
  OWNER=agent
else
  sudo -n mkdir -p "$AH"; sudo -n chown "$(id -un):" "$AH"
  OWNER=$(id -un)
fi
RUN="${boatRunAs()}"
# Agent PATH: system dirs + wherever the preinstalled tools live, never Boat's own home dir.
P=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for b in claude codex node npm npx git python3 pip3 uv; do
  d=$(bash -lc "command -v $b" 2>/dev/null | head -n1 || true)
  case "$d" in /*) d=$(dirname "$d");; *) continue;; esac
  case "$d" in /home/*|/root*) continue;; esac
  case ":$P:" in *":$d:"*) ;; *) P="$P:$d";; esac
done
echo "$AH/.npm-global/bin:$AH/.local/bin:$P" > "$O/path"
$RUN mkdir -p "$W" "$AH/.npm-global" "$AH/.codex"
echo "$OWNER" > "$O/owner"
${clone}
$RUN env -i HOME="$AH" PATH="$(cat "$O/path")" bash -c 'command -v ${bin}' >/dev/null || { echo "${bin} is not on the agent PATH ($(cat "$O/path")); try BOAT_AGENT_USER=user" >&2; exit 127; }
`;
}

function boatLaunchScript(n: number, argv: string[]): string {
  const hardLimit = Math.ceil(CFG.maxSessionMs / 1000) + 60; // the worker kills first; belt and braces
  return `cd /
O=${BOAT_DIR}; AH=${AGENT_HOME}
U=${BOAT.agentUser === "agent" ? "agent" : "$(id -un)"}
# This run's credentials: handed to the agent user (0600), sourced and deleted before the harness execs.
sudo -n install -o "$(cat "$O/owner")" -m 600 "$O/env-${n}" "$AH/.octi-env-${n}" && rm -f "$O/env-${n}"
${boatRunAs()} env -i HOME="$AH" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 TERM=dumb PATH="$(cat "$O/path")" \\
  bash -c 'set -a; . "$HOME/.octi-env-${n}"; set +a; rm -f "$HOME/.octi-env-${n}"; cd "$HOME/work" && exec timeout -k 30 ${hardLimit} "$@"' run ${argv.map(shq).join(" ")} \\
  < "$O/in-${n}.txt" > "$O/out-${n}.jsonl" 2> "$O/err-${n}.log"
c=$?
echo "$c" > "$O/exit-${n}"
exit "$c"
`;
}

function boatDiffScript(): string {
  return `cd /
${boatRunAs()} env -i HOME=${AGENT_HOME} PATH="$(cat ${BOAT_DIR}/path)" WORK=${AGENT_WORKDIR} SNAP=/tmp/.octi-snap.git BASE="$(cat ${BOAT_DIR}/base 2>/dev/null)" bash -c ${shq(DIFF_SCRIPT)} | head -c ${BOAT.diffMaxBytes + 1}
`;
}

/** Worker sandbox name: lets `boat-orchestrators status` attribute worker sandboxes to their orchestrator. */
export function workerSandboxName(agentId: string): string {
  return `${(ENV.APP_BOAT_NAMESPACE || "octi").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "octi"}-w-${CFG.orchestratorId}-${agentId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
}

/** Pinned harness version from the registry (by agent id, else the first agent of that harness). */
export function harnessPin(agentId: string | undefined, harness: string): string | null {
  try {
    const agents = loadRegistry().agents;
    return (agents.find((a) => a.id === agentId) ?? agents.find((a) => a.harness === harness))?.harness_version ?? null;
  } catch { return null; }
}

const SETUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "images", "boat-setup");
const ACP_CLIENT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "harnesses", "acp-client.mjs");

/** orchestrator/images/boat-setup/<harness>.sh + _common.sh, if this harness has one. */
export function boatSetupScripts(harness: string): { common: string; script: string } | null {
  try { return { common: readFileSync(join(SETUP_DIR, "_common.sh"), "utf8"), script: readFileSync(join(SETUP_DIR, `${harness}.sh`), "utf8") }; }
  catch { return null; }
}

/** Keep the preinstalled CLI if it reports the pinned version; else install it with its boat-setup script. */
export function boatEnsureHarnessScript(harness: string, bin: string, pin: string | null, hasSetup: boolean): string {
  return `set -uo pipefail
# Boat VMs ship /usr/local/bin/node as a symlink into /home/user/.nvm (0750): the agent user would fall back to
# /usr/bin/node v20 (breaks pi, cline warns). Make it a real, world-executable copy first.
real="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
case "$real" in /home/*|/root/*) sudo -n cp --remove-destination "$real" /usr/local/bin/node && sudo -n chmod 0755 /usr/local/bin/node ;; esac
cur="$( (sudo -n -u nobody env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin ${shq(bin)} --version 2>/dev/null || true) | grep -v -i -E '^(warning|\\[|\\(node)' | head -n1)"
pin=${shq(pin ?? "")}
if [ -n "$cur" ] && { [ -z "$pin" ] || printf '%s' "$cur" | grep -qF -- "$pin"; }; then echo "harness ${harness}: preinstalled ($cur)"; exit 0; fi
${hasSetup
    ? `echo "harness ${harness}: installing pinned \${pin:-latest} (found: \${cur:-none})" >&2
bash ${BOAT_DIR}/setup/${harness}.sh "$pin" >&2 || exit 1
now="$( (sudo -n -u nobody env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin ${shq(bin)} --version 2>/dev/null || true) | grep -v -i -E '^(warning|\\[|\\(node)' | head -n1)"
printf '%s' "$now" | grep -qF -- "$pin" || { echo "harness ${harness}: after install, unprivileged --version reports '$now', expected $pin" >&2; exit 1; }
echo "harness ${harness}: installed ($now)"`
    : `echo "harness ${harness}: ${bin} is \${cur:-missing}, expected \${pin:-any}, and there is no boat-setup script" >&2; exit 1`}
`;
}

export const boatRunner: Runner = {
  name: "boat",
  async open(spec) {
    // Start gate + 429/503 backoff, same Idempotency-Key on retries (a lost response never creates a second VM).
    let created: any;
    try {
      created = await boatCreate(
        { type: BOAT.size, ttlSeconds: BOAT.ttlSeconds, noEnv: true, snapshots: false, ...(BOAT.org ? { org: BOAT.org } : {}) },
        { onBackoff: (ms, e) => log(`boat create backing off ${Math.round(ms / 1000)}s (${e.status} ${e.code})`) });
    } catch (e) {
      // Seen live (2026-10-10): a key scoped without sandbox.create gets 403 api_key_action_forbidden.
      if (e instanceof BoatError && e.code === "api_key_action_forbidden")
        throw new Error(`boat key is not allowed to create sandboxes (${e.message}). Store a key with the ci preset (sandbox.create + delete-own + exec + files) in the vault.`);
      throw e;
    }
    const id: string = created?.sandbox?.id;
    let envResult: EnvironmentResult | undefined;
    let egressReport: { hosts: number; probe: unknown } | undefined;
    if (!id) throw new Error(`boat create returned no sandbox id: ${JSON.stringify(created).slice(0, 300)}`);
    // A recognisable name, so `status` / cleanup can attribute worker sandboxes (best effort).
    void boatApi(boatSandboxPath(id), { method: "PATCH", json: { name: workerSandboxName(spec.agentId ?? spec.adapter.id) } }).catch(() => {});
    const createdAt = Date.now();
    let destroyedAt: number | null = null;
    let destroying: Promise<void> | null = null;
    const abort = new AbortController();

    const destroy = () => (destroying ??= (async () => {
      abort.abort();
      try {
        if (BOAT.onFinish === "stop") await withRetry(() => boatApi(`${boatSandboxPath(id)}/stop`, { method: "POST", json: {} }), 3);
        else await withRetry(() => boatApi(boatSandboxPath(id), { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }), 3);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) {
          log(`[boat ${id}] ${BOAT.onFinish} failed, falling back to stop:`, String(e));
          await boatApi(`${boatSandboxPath(id)}/stop`, { method: "POST", json: { force: true } }).catch((e2) =>
            log(`[boat ${id}] stop failed too; it auto-stops at its TTL (${BOAT.ttlSeconds}s after create):`, String(e2)));
        }
      }
      destroyedAt = Date.now();
    })());

    const put = (path: string, content: string) =>
      withRetry(() => boatApi(`${boatSandboxPath(id)}/files`, { method: "PUT", json: { path, content } }), 3);

    try {
      const until = Date.now() + BOAT.readyTimeoutMs;
      for (;;) {
        const g = await withRetry(() => boatApi(boatSandboxPath(id)), 3);
        const st = g?.sandbox?.state;
        if (st === "ready" || st === "idle" || st === "running") break;
        if (st === "error" || st === "cancelled" || st === "archived" || st === "archiving") throw new Error(`boat sandbox ${id} is ${st}: ${g?.sandbox?.error ?? ""}`);
        if (Date.now() > until) throw new Error(`boat sandbox ${id} not ready after ${BOAT.readyTimeoutMs / 1000}s (state ${st})`);
        await sleep(2000);
      }
      const mk = await boatExec(id, `install -d -m 700 ${BOAT_DIR}`, 30);
      if (mk.exitCode !== 0) throw new Error(`mkdir ${BOAT_DIR} failed: ${mk.stderr.slice(-300)}`);
      // Harness pinned by the registry: keep boat's preinstalled CLI when it is the pinned version, otherwise
      // install it system-wide with orchestrator/images/boat-setup/<harness>.sh (which verifies `--version`).
      const pin = harnessPin(spec.agentId, spec.adapter.id);
      const setup = boatSetupScripts(spec.adapter.id);
      if (setup) {
        await put(`${BOAT_DIR}/setup/_common.sh`, setup.common);
        await put(`${BOAT_DIR}/setup/${spec.adapter.id}.sh`, setup.script);
      }
      const ensure = await boatExec(id, boatEnsureHarnessScript(spec.adapter.id, spec.adapter.bin, pin, !!setup), 600);
      if (ensure.exitCode !== 0) throw new Error(`harness ${spec.adapter.id}${pin ? `@${pin}` : ""} not available: ${(ensure.stderr || ensure.stdout).slice(-800)}`);
      const seed = !spec.repoUrl && !!spec.template;
      if (seed) await put(`${BOAT_DIR}/seed.sh`, seedScript(spec.template!));
      await put(`${BOAT_DIR}/prepare.sh`, boatPrepareScript(spec.adapter.bin, spec.repoUrl, seed));
      await put(`${BOAT_DIR}/diff.sh`, boatDiffScript());
      const prep = await boatExec(id, `bash ${BOAT_DIR}/prepare.sh`, 600);
      if (prep.exitCode !== 0) throw new Error(`sandbox prepare failed (exit ${prep.exitCode}): ${(prep.stderr || prep.stdout).slice(-800)}`);
      if (spec.environment) envResult = await boatEnvironment(id, put, spec.adapter.id, spec.environment);
      // Last step before the agent's first turn: everything that needs the network (harness, repo, tools) is done.
      if (spec.egress) {
        if (BOAT.agentUser !== "agent") throw new Error("egress lockdown needs the unprivileged agent user (BOAT_AGENT_USER)");
        await put(`${BOAT_DIR}/egress-proxy.mjs`, proxySource());
        await put(`${BOAT_DIR}/egress-allow.json`, JSON.stringify({ hosts: spec.egress.hosts }));
        await put(`${BOAT_DIR}/egress-probe.mjs`, probeSource(spec.egress.gatewayHost));
        await put(`${BOAT_DIR}/egress-setup.sh`, egressSetupScript(BOAT_DIR));
        const lock = await boatExec(id, `bash ${BOAT_DIR}/egress-setup.sh`, 120);
        if (lock.exitCode !== 0) throw new Error(`egress lockdown failed (exit ${lock.exitCode}): ${(lock.stderr || lock.stdout).slice(-600)}`);
        const probe = await boatExec(id, `cd / && NODE="$(command -v node)" && ${boatRunAs()} env -i HOME=${AGENT_HOME} PATH="$(cat ${BOAT_DIR}/path)" "$NODE" ${EGRESS_DIR}/probe.mjs`, 120);
        const last = probe.stdout.trim().split("\n").pop() ?? "";
        if (probe.exitCode !== 0) {
          // The VM is destroyed right after this: collect what the proxy and firewall look like first.
          const diag = await boatExec(id, egressDiagnostics(), 60).then((d) => d.stdout.trim().slice(-1400), () => "(diagnostics unavailable)");
          let failedChecks = last.slice(0, 300);
          try { failedChecks = JSON.parse(last).checks.filter((c: { want: boolean; got: boolean }) => c.want !== c.got).map((c: { name: string }) => c.name).join("; "); } catch { /* keep raw */ }
          throw new Error(`egress probe failed, refusing to run the agent. Unexpected: ${failedChecks || probe.stderr.slice(-300)}\n${diag}`);
        }
        egressReport = { hosts: spec.egress.hosts.length, probe: JSON.parse(last) };
        log(`[boat ${id}] egress locked down: ${spec.egress.hosts.length} allowed hosts, probe ok`);
      }
    } catch (e) {
      await destroy();
      throw e;
    }

    let turnNo = 0;
    let finishCurrent: ((x: RunExit) => void) | null = null;

    return {
      id: `boat:${id}`,
      workdir: AGENT_WORKDIR,
      environment: envResult,
      egress: egressReport,
      async runTurn(argv, input, env) {
        const n = ++turnNo;
        if (spec.egress) env = { ...env, ...proxyEnv() }; // HTTP clients go through the in-VM proxy
        argv = [...argv];
        argv[0] = argv[0]!.split("/").pop()!; // host bin overrides don't apply in the VM
        await put(`${BOAT_DIR}/env-${n}`, Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n");
        await put(`${BOAT_DIR}/in-${n}.txt`, input); // byte-for-byte; fed to the CLI on stdin
        await put(`${BOAT_DIR}/launch-${n}.sh`, boatLaunchScript(n, argv));
        const started = await boatCommandRetry(() => boatApi(`${boatSandboxPath(id)}/commands`, {
          method: "POST", json: { command: `bash ${BOAT_DIR}/launch-${n}.sh`, detached: true },
        }));
        const processId = Number(started?.processId);
        const pid = Number(started?.pid ?? started?.processId);
        if (!Number.isFinite(processId)) throw new Error(`boat detached start returned no processId: ${JSON.stringify(started).slice(0, 300)}`);

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let finished = false;
        let resolveExit!: (x: RunExit) => void;
        const exited = new Promise<RunExit>((r) => (resolveExit = r));
        const finish = (x: RunExit) => {
          if (finished) return;
          finished = true;
          finishCurrent = null;
          stdout.end();
          stderr.end();
          resolveExit(x);
        };
        finishCurrent = finish;
        const out = `${BOAT_DIR}/out-${n}.jsonl`;

        // Follow out-N.jsonl by line number, reconnecting every TAIL_SECONDS; `tail --pid` returns once the launcher exits.
        void (async () => {
          let lines = 0;
          let partial = "";
          const onOut = (d: string) => {
            partial += d;
            let i: number;
            while ((i = partial.indexOf("\n")) >= 0) {
              const line = partial.slice(0, i);
              partial = partial.slice(i + 1);
              lines++;
              stdout.write(line + "\n");
            }
          };
          const noop = () => {};
          let failures = 0;
          try {
            for (;;) {
              if (abort.signal.aborted) return;
              const t0 = Date.now();
              partial = ""; // a torn last line is re-read from its start by the next call
              try {
                await boatExecStream(id, `timeout ${TAIL_SECONDS} tail -n +${lines + 1} -F --pid=${pid} ${out} 2>/dev/null; true`,
                  TAIL_SECONDS + 30, onOut, noop, abort.signal);
                failures = 0;
              } catch (e) {
                if (abort.signal.aborted) return;
                if (++failures > 10) throw e;
                log(`[boat ${id}] tail stream failed (${failures}), reconnecting:`, String(e));
              }
              const st = await withRetry(() => boatApi(`${boatSandboxPath(id)}/commands/${processId}?tailBytes=2000`, { signal: abort.signal }), 3);
              if (!st?.running) break;
              if (Date.now() - t0 < 5000) await sleep(3000); // don't hot-loop if tail returns early
            }
            // The run has exited and its output is on disk: a dropped connection here (ECONNRESET mid-stream) must not
            // fail a finished session. Both reads are idempotent; the drain resumes after the last complete line.
            const afterExit = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
              for (let attempt = 1; ; attempt++) {
                try { return await fn(); }
                catch (e) {
                  if (abort.signal.aborted || attempt >= 6) throw e;
                  log(`[boat ${id}] ${what} failed (${attempt}), retrying:`, String(e));
                  await sleep(Math.min(2000 * attempt, 10_000));
                }
              }
            };
            await afterExit("final output drain", () => {
              partial = ""; // a torn last line is re-read from its start
              return boatExecStream(id, `tail -n +${lines + 1} ${out} 2>/dev/null; true`, 120, onOut, noop, abort.signal);
            });
            if (partial.trim()) { stdout.write(partial + "\n"); partial = ""; }
            const fin = await afterExit("exit status read", () =>
              boatExec(id, `cat ${BOAT_DIR}/exit-${n} 2>/dev/null; tail -c 8000 ${BOAT_DIR}/err-${n}.log >&2 2>/dev/null; true`, 60));
            if (fin.stderr) stderr.write(fin.stderr);
            const code = /^\s*(\d+)/.exec(fin.stdout)?.[1];
            finish({ code: code !== undefined ? Number(code) : null, signal: null });
          } catch (e) {
            if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
            else finish({ code: null, signal: null, error: `boat runner: ${String(e instanceof Error ? e.message : e)}` });
          } finally {
            if (abort.signal.aborted) finish({ code: null, signal: "SIGKILL" });
          }
        })();
        return { stdout, stderr, exited };
      },
      async diff() {
        if (abort.signal.aborted) return null;
        let d = "";
        try {
          await boatExecStream(id, `bash ${BOAT_DIR}/diff.sh`, 300, (s) => { if (d.length <= BOAT.diffMaxBytes) d += s; }, () => {}, abort.signal);
        } catch (e) {
          log(`[boat ${id}] diff failed:`, String(e));
          return null;
        }
        return capDiff(d);
      },
      async stopTurn() {
        // The harness runs under `timeout -k 30 <limit>`; GNU timeout forwards SIGTERM to the CLI.
        if (abort.signal.aborted) return;
        await boatExec(id, "sudo -n pkill -TERM -f '^timeout -k 30 ' || pkill -TERM -f '^timeout -k 30 ' || true", 30).catch(() => {});
      },
      async kill() {
        await destroy(); // DELETE force-stops the VM; aborting ends any follower
        finishCurrent?.({ code: null, signal: "SIGKILL" });
      },
      async cleanup() { await destroy(); },
      meta() {
        const secs = ((destroyedAt ?? Date.now()) - createdAt) / 1000;
        return {
          ...(spec.template && !spec.repoUrl ? { workspace_template: spec.template } : {}),
          boat_sandbox_id: id,
          boat_sandbox_type: BOAT.size,
          boat_sandbox_seconds: Math.round(secs),
          boat_est_cost_usd: Number(((secs / 3600) * (BOAT_PRICE_PER_HOUR[BOAT.size] ?? 0.036)).toFixed(5)), // exact meter: GET /sandboxes/{id}/usage
        };
      },
    };
  },
};

export const RUNNERS: Record<string, Runner> = { boat: boatRunner, docker: dockerRunner, local: localRunner };

/** Startup checks for the selected runner. */
export async function checkRunner(runner: Runner): Promise<void> {
  if (runner.name === "boat") {
    if (!BOAT.apiKey) throw new Error("BOAT_API_KEY is required for RUNNER=boat (create one with `boat api-key create app-worker --preset ci --ttl 90d`)");
    const me = await boatApi("/me").catch((e) => { throw new Error(`boat.dev auth check failed: ${String(e)}`); });
    log(`boat.dev OK as ${me?.user?.login ?? me?.login ?? "?"}; size=${BOAT.size} ttl=${BOAT.ttlSeconds}s agentUser=${BOAT.agentUser} onFinish=${BOAT.onFinish}`);
  }
  if (runner.name === "docker") {
    const r = await sh("docker", ["image", "inspect", await localImage(CFG.dockerImage)]);
    if (r.code !== 0) throw new Error(`Docker image ${CFG.dockerImage} not found. Build it: docker build -f orchestrator/Dockerfile.sandbox -t ${CFG.dockerImage} orchestrator`);
  }
}
