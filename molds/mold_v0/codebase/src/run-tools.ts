/**
 * The tools an agent-workspace run may need (mold_v0-072; molds/mold_v0/MOLD.md "The agent-workspace runner"): a fixed
 * catalogue, each tool at one pinned version with the sha256 of its release artifact per architecture. A job kind names
 * the tools it needs (`agent.tools`); the build collects them across the packs (scripts/gen-packs.mjs writes
 * src/run-tools.generated.json) and the runner image is built with exactly those (scripts/install-run-tools.ts, run by
 * the Dockerfile; a boat run sandbox runs the same installer when it is set up, before the runner starts): each artifact
 * downloaded once, its sha256 checked against this catalogue (any other bytes are refused and nothing is installed),
 * unpacked under /opt/app-tools (APP_RUN_TOOLS_DIR), root-owned, with a manifest.
 *
 * At run time nothing is downloaded: the harness (src/run-harness.ts) checks each tool the kind names against the
 * manifest and this catalogue (the pinned version, the artifact's sha256, the installed program's own sha256, owned by
 * root and writable by no one else) and puts links to exactly those programs first on the run's PATH. A kind whose
 * image lacks a tool, or holds another version or altered bytes, is refused before anything of the run starts.
 *
 * git is the image's own (the distribution's package, installed with the image: Dockerfile, the boat set-up): checked
 * to be there, not pinned by checksum here.
 *
 * mold_v0-184: a Python program (format "python": cfn-lint, moto) is its own pinned CPython build (python-build-standalone,
 * relocatable) with exactly the wheels of its hash-locked requirements (src/run-tools-wheels.ts), each checked against its
 * sha256 before pip installs them into that interpreter alone (--no-index --no-deps: nothing is fetched or built), and a
 * launcher that runs the interpreter isolated (-I: no PYTHONPATH, no user site, no current directory on sys.path). A
 * data tool (format "zip" with `data`: AWS's Guard rule sets) has no program: its directory's files are hashed into the
 * manifest and checked at every run, then linked under RUN_TOOLS_DATA.
 *
 * Plain node only: the run sandbox's runner imports this (orchestrator/deploy/boat-lib.ts runnerCodeFiles).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV } from "./env-names.js";
import { PYTHON_WHEELS } from "./run-tools-wheels.js";

export type RunToolName = "git" | "claude-code" | "sops" | "age" | "kubectl" | "aws" | "cfn-lint" | "cfn-guard" | "aws-guard-rules" | "moto";
export type ToolArch = "x64" | "arm64";
export interface ToolArtifact { url: string; sha256: string; bytes: number }
export interface CatalogTool {
  version: string;
  /** "system": the image's own package (git); else how the artifact unpacks. */
  format: "system" | "binary" | "tar.gz" | "npm-tgz" | "aws-zip" | "python" | "zip";
  /** The artifact; for "python" the interpreter (a python-build-standalone install_only build). */
  artifacts?: Partial<Record<ToolArch, ToolArtifact>>;
  /** Program name -> its path inside the unpacked artifact ("python": bin/<name>, the launcher the installer writes). */
  bins: Record<string, string>;
  /** "python" (mold_v0-184): the wheels pip installs into the interpreter, and each program's entry point (module:function). */
  python?: { wheels: Partial<Record<ToolArch, ToolArtifact[]>>; entry_points: Record<string, string> };
  /** mold_v0-184: data directories (name -> its path inside the unpacked artifact), linked under RUN_TOOLS_DATA. */
  data?: Record<string, string>;
  /** "zip": the archive's paths left out (a prefix each: macOS resource forks, say). */
  exclude?: string[];
  source: string;
}
export type ToolCatalog = Record<string, CatalogTool>;

/**
 * The catalogue. Versions were picked at least two weeks old when pinned (2026-10-22); every sha256 was measured on the
 * downloaded artifact (and matched the publisher's own checksum where one is published: sops' checksums.txt, kubectl's
 * .sha256, age's release asset digests). Changing a version means measuring its artifacts again.
 */
export const RUN_TOOL_CATALOG: ToolCatalog = {
  git: { version: "system", format: "system", bins: { git: "git" }, source: "the image's distribution package (Dockerfile apt-get; the boat set-up)" },
  "claude-code": {
    version: "2.1.295", format: "npm-tgz", bins: { claude: "package/claude" }, source: "npm @anthropic-ai/claude-code-linux-<arch> (the native build @anthropic-ai/claude-code installs)",
    artifacts: {
      x64: { url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz", sha256: "d45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95", bytes: 114433914 },
      arm64: { url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.295.tgz", sha256: "931e64de4906046d2fc4d5a3c2daa9a27dc6397525c25f136cb8348749abcb51", bytes: 114688246 },
    },
  },
  sops: {
    version: "3.13.3", format: "binary", bins: { sops: "sops" }, source: "github.com/getsops/sops releases",
    artifacts: {
      x64: { url: "https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.amd64", sha256: "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b", bytes: 52121762 },
      arm64: { url: "https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.arm64", sha256: "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77", bytes: 48300194 },
    },
  },
  age: {
    version: "1.3.2", format: "tar.gz", bins: { age: "age/age", "age-keygen": "age/age-keygen" }, source: "github.com/FiloSottile/age releases",
    artifacts: {
      x64: { url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz", sha256: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10", bytes: 19405817 },
      arm64: { url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-arm64.tar.gz", sha256: "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4", bytes: 17771923 },
    },
  },
  kubectl: {
    version: "1.37.1", format: "binary", bins: { kubectl: "kubectl" }, source: "dl.k8s.io release binaries",
    artifacts: {
      x64: { url: "https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl", sha256: "65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8", bytes: 61886626 },
      arm64: { url: "https://dl.k8s.io/release/v1.37.1/bin/linux/arm64/kubectl", sha256: "ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7", bytes: 57868450 },
    },
  },
  aws: {
    version: "2.37.5", format: "aws-zip", bins: { aws: "dist/aws" }, source: "awscli.amazonaws.com (AWS CLI v2)",
    artifacts: {
      x64: { url: "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.37.5.zip", sha256: "850ba65f1342a1f725f4868de3c4621ea729af31dac96e54b574cbb0ef309029", bytes: 73787128 },
      arm64: { url: "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.37.5.zip", sha256: "95d2bac9242185ae3a2970ec38c8766d3bf7b31609a0302dec3643522a676d32", bytes: 71240439 },
    },
  },
  // mold_v0-184 (pinned 2026-10-31): CloudFormation checked with AWS's own tools, offline. cfn-lint and moto run on their
  // own CPython 3.12.15 (python-build-standalone 20261013; the release's asset digests matched), with the wheels of
  // scripts/run-tools-locks/<tool>.txt (cfn-lint[sarif] at the version Maxwell pins, and moto[server], each compiled
  // with --exclude-newer 2026-10-17; the sarif extra is what `cfn-lint -f sarif` needs). cfn-guard's tarballs matched
  // the release's asset digests; the Guard rules registry publishes no digest (measured at pin).
  "cfn-lint": {
    version: "1.56.3", format: "python", bins: { "cfn-lint": "bin/cfn-lint" }, source: "PyPI cfn-lint (aws-cloudformation/cfn-lint), on python-build-standalone CPython 3.12.15",
    artifacts: {
      x64: { url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-x86_64-unknown-linux-gnu-install_only.tar.gz", sha256: "5d546fc004fc2435fa142eb8f42ed8de5eb4725963dc22f7e6671014a80eb560", bytes: 66983838 },
      arm64: { url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-aarch64-unknown-linux-gnu-install_only.tar.gz", sha256: "34a43010cc05982d8b5debbad7d09f7b1200117ebf018f7acfd656895e408205", bytes: 52391962 },
    },
    python: { wheels: PYTHON_WHEELS["cfn-lint"]!, entry_points: { "cfn-lint": "cfnlint.runner:main" } },
  },
  moto: {
    version: "5.2.4", format: "python", bins: { moto_server: "bin/moto_server" }, source: "PyPI moto[server] (getmoto/moto): a local AWS emulator, CloudFormation included, on python-build-standalone CPython 3.12.15",
    artifacts: {
      x64: { url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-x86_64-unknown-linux-gnu-install_only.tar.gz", sha256: "5d546fc004fc2435fa142eb8f42ed8de5eb4725963dc22f7e6671014a80eb560", bytes: 66983838 },
      arm64: { url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-aarch64-unknown-linux-gnu-install_only.tar.gz", sha256: "34a43010cc05982d8b5debbad7d09f7b1200117ebf018f7acfd656895e408205", bytes: 52391962 },
    },
    python: { wheels: PYTHON_WHEELS.moto!, entry_points: { moto_server: "moto.server:main" } },
  },
  "cfn-guard": {
    version: "3.2.1", format: "tar.gz", bins: { "cfn-guard": "cfn-guard-v3-<arch>-linux-latest/cfn-guard" }, source: "github.com/aws-cloudformation/cloudformation-guard releases (static)",
    artifacts: {
      x64: { url: "https://github.com/aws-cloudformation/cloudformation-guard/releases/download/3.2.1/cfn-guard-v3-x86_64-linux-latest.tar.gz", sha256: "8c66efb19c63e6c2bf26b9a41bbcf2f85baa8a937b01d350940194faaf64cf1d", bytes: 3365672 },
      arm64: { url: "https://github.com/aws-cloudformation/cloudformation-guard/releases/download/3.2.1/cfn-guard-v3-aarch64-linux-latest.tar.gz", sha256: "cd378026dad0f865926ab1d1c082e2faf825f7fd888a9fe6b5c142cdf175c129", bytes: 3257741 },
    },
  },
  "aws-guard-rules": {
    version: "1.0.2", format: "zip", bins: {}, data: { "aws-guard-rules": "output" }, exclude: ["__MACOSX"], source: "github.com/aws-cloudformation/aws-guard-rules-registry releases (ruleset-build: AWS's Guard rule sets per framework)",
    artifacts: {
      x64: { url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/releases/download/1.0.2/ruleset-build-v1.0.2.zip", sha256: "dc21aaad601c673843c299191d864cd9b9db32475b1937d930d6069ddde73296", bytes: 602473 },
      arm64: { url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/releases/download/1.0.2/ruleset-build-v1.0.2.zip", sha256: "dc21aaad601c673843c299191d864cd9b9db32475b1937d930d6069ddde73296", bytes: 602473 },
    },
  },
};

/** A bin's path for an architecture: `<arch>` is the release's own name for it (x86_64, aarch64). */
const binPath = (rel: string, arch: ToolArch) => rel.replaceAll("<arch>", arch === "x64" ? "x86_64" : "aarch64");

/**
 * What the manifest records as the tool's pinned artifact: the artifact's sha256, or for a Python tool one digest over
 * the interpreter's and every wheel's (another wheel, or another order, is another pin).
 */
export function pinDigest(t: CatalogTool, arch: ToolArch): string | null {
  const art = t.artifacts?.[arch];
  if (!art) return null;
  if (t.format !== "python") return art.sha256;
  const wheels = t.python?.wheels[arch];
  if (!wheels?.length) return null;
  return createHash("sha256").update([art.sha256, ...wheels.map((w) => w.sha256)].join("\n")).digest("hex");
}

export const RUN_TOOL_NAMES = Object.keys(RUN_TOOL_CATALOG) as RunToolName[];
export const runToolsDir = () => ENV.APP_RUN_TOOLS_DIR || "/opt/app-tools";
export const toolArch = (a: string = process.arch): ToolArch => {
  if (a === "x64" || a === "arm64") return a;
  throw new Error(`no run tools for the architecture ${a}`);
};

export class RunToolError extends Error {}

/** What the installer wrote: per tool, its version, the artifact's sha256 and each program's path and sha256. */
export interface ToolManifest {
  arch: ToolArch;
  tools: Record<string, {
    version: string; artifact_sha256: string; bins: Record<string, { path: string; sha256: string }>;
    /** mold_v0-184: other programs checked at every run but not linked (a Python tool's interpreter). */
    files?: { path: string; sha256: string }[];
    /** mold_v0-184: data directories: each file's path and sha256 folded into one digest, with the count. */
    data?: Record<string, { path: string; sha256: string; files: number }>;
  }>;
}

const sha256File = (p: string): string => {
  const h = createHash("sha256");
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  } finally { closeSync(fd); }
  return h.digest("hex");
};

const root = () => process.getuid?.() === 0;
/** Owned by root and writable by no one else (checked only when this process is root: only then is it a guarantee). */
function trusted(p: string, st: import("node:fs").Stats, what: string) {
  if (!root()) return;
  if (st.uid !== 0) throw new RunToolError(`${what} (${p}) is not owned by root`);
  if (st.mode & 0o022) throw new RunToolError(`${what} (${p}) is writable by others than root`);
}

/** The installed manifest, read without following a link, from a directory only root can change. */
export function readToolManifest(dir = runToolsDir()): ToolManifest | null {
  let dst; try { dst = lstatSync(dir); } catch { return null; }
  if (!dst.isDirectory()) throw new RunToolError(`${dir} is not a directory`);
  trusted(dir, dst, "the tools directory");
  const file = path.join(dir, "manifest.json");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RunToolError(`the tools manifest is unreadable or a link`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) throw new RunToolError("the tools manifest is not a plain file");
    trusted(file, st, "the tools manifest");
    return JSON.parse(readFileSync(fd, "utf8")) as ToolManifest;
  } finally { closeSync(fd); }
}

/**
 * Check that the image holds exactly the pinned tools `names` (nothing is installed or downloaded here) and return the
 * absolute path of each program. Throws RunToolError naming every tool that is missing or not the pinned one.
 */
export function verifyTools(names: string[], o: { dir?: string; catalog?: ToolCatalog; arch?: ToolArch } = {}): Record<string, string> {
  return verifyToolSet(names, o).bins;
}

/**
 * A data directory's digest (mold_v0-184): every entry under it a plain directory or file (no link, no other kind),
 * root's and writable by no one else when this process is root; sha256 over the sorted "path NUL sha256" lines.
 */
export function treeDigest(top: string): { sha256: string; files: number } {
  const lines: string[] = [];
  const walk = (d: string) => {
    const st = lstatSync(d);
    if (!st.isDirectory()) throw new RunToolError(`${d} is not a plain directory`);
    trusted(d, st, "a data directory");
    for (const e of readdirSync(d).sort()) {
      const p = path.join(d, e), es = lstatSync(p);
      if (es.isDirectory()) { walk(p); continue; }
      if (!es.isFile()) throw new RunToolError(`${p} is a link or a special file`);
      trusted(p, es, "a data file");
      lines.push(`${path.relative(top, p)}\u0000${sha256File(p)}`);
    }
  };
  walk(top);
  return { sha256: createHash("sha256").update(lines.join("\n")).digest("hex"), files: lines.length };
}

/** verifyTools, and (mold_v0-184) each data directory of the tools named, checked file by file against the manifest. */
export function verifyToolSet(names: string[], o: { dir?: string; catalog?: ToolCatalog; arch?: ToolArch } = {}): { bins: Record<string, string>; data: Record<string, string> } {
  const catalog = o.catalog ?? RUN_TOOL_CATALOG, arch = o.arch ?? toolArch();
  const data: Record<string, string> = {};
  const dir = (() => { const d = path.resolve(o.dir ?? runToolsDir()); try { return realpathSync(d); } catch { return d; } })();
  const problems: string[] = [];
  const bins: Record<string, string> = {};
  const wanted = names.filter((n) => catalog[n] && catalog[n]!.format !== "system");
  for (const n of names) if (!catalog[n]) problems.push(`${n} is not in the run tools' catalogue`);
  for (const n of names.filter((x) => catalog[x]?.format === "system")) {
    const r = spawnSync(n, ["--version"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    if (r.status !== 0) problems.push(`${n} is not installed in this image`);
  }
  let manifest: ToolManifest | null = null;
  if (wanted.length) {
    try { manifest = readToolManifest(dir); } catch (e) { problems.push((e as Error).message); }
    if (!manifest && !problems.length) problems.push(`this image has no run tools (${dir}/manifest.json): it was not built with ${wanted.join(", ")}`);
    else if (manifest && manifest.arch !== arch) problems.push(`the run tools were installed for ${manifest.arch}, this machine is ${arch}`);
  }
  if (manifest && manifest.arch === arch) for (const n of wanted) {
    const want = catalog[n]!, got = manifest.tools?.[n];
    const digest = pinDigest(want, arch);
    if (!got) { problems.push(`${n} ${want.version} is not in this image`); continue; }
    if (got.version !== want.version) { problems.push(`${n}: this image has ${got.version}, the catalogue pins ${want.version}`); continue; }
    if (!digest || got.artifact_sha256 !== digest) { problems.push(`${n}: this image's copy was not installed from the pinned artifact`); continue; }
    // mold_v0-184: a data directory, file by file; it must be where the manifest says, inside the tools directory.
    for (const d of Object.keys(want.data ?? {})) {
      const entry = got.data?.[d];
      if (!entry || typeof entry.path !== "string") { problems.push(`${n}: no ${d} data in this image`); continue; }
      const abs = path.resolve(dir, entry.path);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) { problems.push(`${n}: ${d} is outside the tools directory`); continue; }
      try {
        if (realpathSync(abs) !== abs) { problems.push(`${n}: ${d} goes through a link`); continue; }
        for (let p = path.dirname(abs); p.startsWith(path.resolve(dir)); p = path.dirname(p)) trusted(p, lstatSync(p), `${n}'s directory`);
        const t = treeDigest(abs);
        if (t.sha256 !== entry.sha256 || t.files !== entry.files) { problems.push(`${n}: ${d} is not the data that was installed (a file changed, was added or removed)`); continue; }
        data[d] = abs;
      } catch (e) { problems.push(e instanceof RunToolError ? `${n}: ${e.message}` : `${n}: ${d} is missing`); }
    }
    const checks: [string, { path: string; sha256: string } | undefined][] = [
      ...Object.keys(want.bins).map((b) => [b, got.bins?.[b]] as [string, { path: string; sha256: string } | undefined]),
      ...(got.files ?? []).map((f) => [`:${f.path}`, f] as [string, { path: string; sha256: string }]),
    ];
    if (want.format === "python" && !(got.files ?? []).length) problems.push(`${n}: this image's copy has no interpreter recorded`);
    for (const [b, entry] of checks) {
      if (!entry || typeof entry.path !== "string") { problems.push(`${n}: no ${b} in this image`); continue; }
      const abs = path.resolve(dir, entry.path);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) { problems.push(`${n}: ${b} is outside the tools directory`); continue; }
      try {
        // The program itself and every directory up to the tools directory: real, root's, writable by no one else.
        const real = realpathSync(abs);
        if (real !== abs) { problems.push(`${n}: ${b} goes through a link`); continue; }
        const st = lstatSync(abs);
        if (!st.isFile()) { problems.push(`${n}: ${b} is not a plain file`); continue; }
        trusted(abs, st, `${n}'s ${b}`);
        for (let d = path.dirname(abs); d.startsWith(path.resolve(dir)); d = path.dirname(d)) trusted(d, lstatSync(d), `${n}'s directory`);
        if (!(st.mode & 0o111)) { problems.push(`${n}: ${b} is not executable`); continue; }
        if (sha256File(abs) !== entry.sha256) { problems.push(`${n}: ${b.startsWith(":") ? b.slice(1) : b} is not the file that was installed (its sha256 changed)`); continue; }
        if (!b.startsWith(":")) bins[b] = abs;
      } catch (e) { problems.push(e instanceof RunToolError ? e.message : `${n}: ${b} is missing`); }
    }
  }
  if (problems.length) throw new RunToolError(`the run's tools: ${problems.join("; ")}`);
  return { bins, data };
}

/** mold_v0-184: a directory of links to the kind's data directories (RUN_TOOLS_DATA/<name>). */
export function linkToolData(data: Record<string, string>, dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  for (const [name, abs] of Object.entries(data)) symlinkSync(abs, path.join(dataDir, name));
  return dataDir;
}

/** A directory of links to exactly the kind's programs (first on its PATH); the image's other tools stay off it. */
export function linkTools(bins: Record<string, string>, binDir: string): string {
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  for (const [name, abs] of Object.entries(bins)) symlinkSync(abs, path.join(binDir, name));
  return binDir;
}

/** The union of the tools the packs' agent kinds name, as gen-packs writes it (src/run-tools.generated.json). */
export function generatedTools(file: string): string[] {
  const j = JSON.parse(readFileSync(file, "utf8")) as { tools?: unknown };
  if (!Array.isArray(j.tools) || j.tools.some((t) => typeof t !== "string")) throw new RunToolError(`${file}: no tools list`);
  return j.tools as string[];
}

const run = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" } });
  if (r.status !== 0) throw new RunToolError(`${cmd} ${args[0] ?? ""}: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(-400)}`);
};

/**
 * Install `names` into `dir` (the image's build; a boat sandbox's set-up): each artifact downloaded, its sha256 checked
 * against the catalogue before anything is unpacked, unpacked into a fresh directory and moved into place, the
 * manifest written last. A tool already installed at its pinned version is kept. Throws RunToolError (nothing of that
 * tool installed) on any mismatch. `fetchImpl` and `catalog` are for the offline tests.
 */
export async function installTools(names: string[], o: { dir?: string; catalog?: ToolCatalog; arch?: ToolArch; fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<ToolManifest> {
  const catalog = o.catalog ?? RUN_TOOL_CATALOG, arch = o.arch ?? toolArch(), get = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});
  for (const n of names) if (!catalog[n]) throw new RunToolError(`${n} is not in the run tools' catalogue (${Object.keys(catalog).join(", ")})`);
  mkdirSync(path.resolve(o.dir ?? runToolsDir()), { recursive: true, mode: 0o755 });
  const dir = realpathSync(path.resolve(o.dir ?? runToolsDir()));
  chmodSync(dir, 0o755);
  const previous = (() => { try { return readToolManifest(dir); } catch { return null; } })();
  const manifest: ToolManifest = { arch, tools: previous && previous.arch === arch ? { ...previous.tools } : {} };
  for (const n of [...new Set(names)].sort()) {
    const t = catalog[n]!;
    if (t.format === "system") { log(`${n}: the image's own (not installed here)`); continue; }
    const art = t.artifacts?.[arch], digest = pinDigest(t, arch);
    if (!art || !digest) throw new RunToolError(`${n} ${t.version} has no artifact for ${arch}`);
    const have = manifest.tools[n];
    if (have && have.version === t.version && have.artifact_sha256 === digest) {
      try { verifyTools([n], { dir, catalog, arch }); log(`${n} ${t.version}: already installed`); continue; } catch { /* reinstalled below */ }
    }
    const work = mkdtempSync(path.join(dir, `.install-${n}-`));
    try {
      // Every artifact (a Python tool's interpreter and each of its wheels) downloaded and checked first: other bytes
      // than the pinned ones are never unpacked, installed or run.
      const fetchPinnedBytes = async (a: ToolArtifact, what: string): Promise<Buffer> => {
        log(`${n} ${t.version}: downloading ${a.url}`);
        const res = await get(a.url, { redirect: "follow" });
        if (!res.ok) throw new RunToolError(`${n}: ${a.url} answered ${res.status}`);
        const b = Buffer.from(await res.arrayBuffer());
        const sum = createHash("sha256").update(b).digest("hex");
        if (sum !== a.sha256) throw new RunToolError(`${n} ${t.version}: ${what}'s sha256 is ${sum}, the catalogue pins ${a.sha256}: refused`);
        return b;
      };
      const body = await fetchPinnedBytes(art, "the artifact");
      const wheelFiles: string[] = [];
      if (t.format === "python") {
        const wdir = path.join(work, "wheels");
        mkdirSync(wdir);
        for (const w of t.python!.wheels[arch]!) {
          const name = decodeURIComponent(new URL(w.url).pathname.split("/").pop() ?? "");
          if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(name)) throw new RunToolError(`${n}: ${w.url} is not a wheel`);
          const f = path.join(wdir, name);
          writeFileSync(f, await fetchPinnedBytes(w, name), { mode: 0o600 });
          wheelFiles.push(f);
        }
      }
      const file = path.join(work, "artifact");
      writeFileSync(file, body, { mode: 0o600 });
      const out = path.join(work, "tree");
      mkdirSync(out);
      if (t.format === "binary") writeFileSync(path.join(out, Object.values(t.bins)[0]!), body, { mode: 0o755 });
      else if (t.format === "tar.gz" || t.format === "npm-tgz") run("tar", ["-xzf", file, "-C", out, "--no-same-owner", "--no-same-permissions"], work);
      else if (t.format === "aws-zip") {
        // The zip's aws/dist is the whole CLI (AWS's own installer only copies it and adds links): kept as dist/.
        const unz = path.join(work, "zip");
        mkdirSync(unz);
        run("unzip", ["-q", file, "-d", unz], work);
        renameSync(path.join(unz, "aws", "dist"), path.join(out, "dist"));
      } else if (t.format === "zip") {
        run("unzip", ["-q", file, "-d", out, ...(t.exclude?.length ? ["-x", ...t.exclude.flatMap((x) => [x, `${x}/*`])] : [])], work);
      } else if (t.format === "python") {
        // The interpreter (relocatable), then the wheels into its own site-packages: from these files only, no index,
        // no dependency resolution, nothing built. pip's own scripts (absolute paths into this scratch directory) go;
        // the launchers below run the interpreter isolated.
        run("tar", ["-xzf", file, "-C", out, "--no-same-owner", "--no-same-permissions"], work);
        const py = path.join(out, "python", "bin", "python3");
        if (!existsSync(py)) throw new RunToolError(`${n}: the interpreter's artifact has no python/bin/python3`);
        run(py, ["-I", "-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "--no-warn-script-location", "--root-user-action=ignore", "--only-binary=:all:", "-q", ...wheelFiles], work);
        for (const [b, entry] of Object.entries(t.python!.entry_points)) {
          const [mod, fn] = entry.split(":");
          if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(mod ?? "") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn ?? "")) throw new RunToolError(`${n}: ${entry} is not module:function`);
          rmSync(path.join(out, "python", "bin", b), { force: true });
          mkdirSync(path.join(out, "bin"), { recursive: true });
          writeFileSync(path.join(out, "bin", b), `#!/bin/sh\n# ${n} ${t.version} (mold_v0-184): the pinned interpreter, isolated (-I), with only this tool's wheels.\nd="$(dirname "$(readlink -f "$0")")"\nexec "$d/../python/bin/python3" -I -c 'import sys; from ${mod} import ${fn}; sys.argv[0] = "${b}"; sys.exit(${fn}())' "$@"\n`, { mode: 0o755 });
        }
      }
      const dest = path.join(dir, n, t.version);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      renameSync(out, dest);
      if (root()) run("chown", ["-R", "root:root", dest], dir);
      run("chmod", ["-R", "go-w,a+rX", path.join(dir, n)], dir);
      const bins: Record<string, { path: string; sha256: string }> = {};
      for (const [b, rel0] of Object.entries(t.bins)) {
        const rel = binPath(rel0, arch), abs = path.join(dest, rel);
        if (!existsSync(abs)) throw new RunToolError(`${n}: ${rel} is not in the artifact`);
        chmodSync(abs, 0o755);
        bins[b] = { path: path.relative(dir, realpathSync(abs)), sha256: sha256File(realpathSync(abs)) };
      }
      const files: { path: string; sha256: string }[] = [];
      if (t.format === "python") {
        const py = realpathSync(path.join(dest, "python", "bin", "python3"));
        files.push({ path: path.relative(dir, py), sha256: sha256File(py) });
      }
      const data: Record<string, { path: string; sha256: string; files: number }> = {};
      for (const [d, rel] of Object.entries(t.data ?? {})) {
        const abs = path.join(dest, rel);
        if (!existsSync(abs)) throw new RunToolError(`${n}: ${rel} is not in the artifact`);
        data[d] = { path: path.relative(dir, realpathSync(abs)), ...treeDigest(realpathSync(abs)) };
      }
      manifest.tools[n] = { version: t.version, artifact_sha256: digest, bins, ...(files.length ? { files } : {}), ...(Object.keys(data).length ? { data } : {}) };
      log(`${n} ${t.version}: installed (pin ${digest.slice(0, 12)}…)`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  const tmp = path.join(dir, `.manifest-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path.join(dir, "manifest.json"));
  return manifest;
}
