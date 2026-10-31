// The run tools' catalogue and installer (mold_v0-072; src/run-tools.ts, scripts/install-run-tools.ts, the Dockerfile,
// the boat set-up in src/run-sandboxes.ts), offline: stand-in artifacts on a local HTTP server, a test catalogue that
// pins their sha256. The real catalogue's artifacts are never downloaded here.
//   npm run test:run-tools
//
//  1. The catalogue: every tool a kind may declare (src/agent-workspace-config.ts RUN_TOOL_NAMES) is in it, each
//     downloadable one pinned to a version with an https artifact and a sha256 per architecture.
//  2. installTools: each format (a binary, a tar.gz, an npm tarball, the AWS zip) installed from its artifact after its
//     sha256 matched; a manifest; verifyTools finds each program. Other bytes than the pinned ones: refused, nothing of
//     that tool installed, the earlier manifest kept. A tool already installed is not downloaded again.
//  3. verifyTools refuses: a tool the image lacks, another version, a changed file, a link swapped in, a file others
//     can write (root only), a tool outside the catalogue.
//  5. mold_v0-184: a Python tool (its own interpreter and the wheels of its lock, each checked, installed with pip from
//     those files only, a launcher that runs the interpreter isolated; a changed wheel refused, the interpreter re-hashed
//     at every run) and a data tool (a zip's directory hashed file by file into the manifest; a file changed, added or
//     a link swapped in refused at run time); a bin path naming the release's own architecture.
//  4. The build: gen-packs writes the union of the packs' agent kinds' tools (src/run-tools.generated.json) and refuses
//     a tool outside the catalogue; the installer's --verify (the Dockerfile's last check) exits 1 when the image lacks
//     a tool the build needs, 0 when it has them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_TOOL_NAMES as CONFIG_TOOL_NAMES } from "../src/agent-workspace-config.js";
import { installTools, pinDigest, RUN_TOOL_CATALOG, RUN_TOOL_NAMES, toolArch, verifyToolSet, verifyTools, type ToolCatalog } from "../src/run-tools.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "run-tools-test-"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const asRoot = process.getuid?.() === 0;

try {
  // ---------- 1. the catalogue ----------
  {
    assert.deepEqual([...RUN_TOOL_NAMES].sort(), [...CONFIG_TOOL_NAMES].sort(), "a kind may declare exactly the catalogue's tools");
    for (const [n, t] of Object.entries(RUN_TOOL_CATALOG)) {
      if (t.format === "system") continue;
      assert.match(t.version, /^\d+\.\d+\.\d+$/, `${n}: a pinned version`);
      for (const a of ["x64", "arm64"] as const) {
        const art = t.artifacts?.[a];
        assert.ok(art, `${n}: an artifact for ${a}`);
        assert.match(art!.url, /^https:\/\//, `${n} ${a}: https`);
        // A Python tool's artifact is its interpreter: the tool's own version is in its wheel.
        const named = t.format === "python" ? (t.python?.wheels[a] ?? []).map((w) => w.url) : [art!.url];
        assert.ok(named.some((u) => u.includes(t.version)), `${n} ${a}: an artifact's URL names the pinned version`);
        assert.match(art!.sha256, /^[0-9a-f]{64}$/, `${n} ${a}: a sha256`);
        assert.ok(art!.bytes > 1000, `${n} ${a}: its size`);
        if (t.format === "python") {
          const wheels = t.python!.wheels[a]!;
          assert.ok(wheels.length > 0 && Object.keys(t.python!.entry_points).length > 0, `${n} ${a}: wheels and entry points`);
          for (const w of wheels) { assert.match(w.url, /^https:\/\/files\.pythonhosted\.org\/.+\.whl$/, `${n} ${a}: a wheel from PyPI`); assert.match(w.sha256, /^[0-9a-f]{64}$/); }
          assert.equal(new Set(wheels.map((w) => w.url.split("/").pop()!.split("-")[0]!.toLowerCase())).size, wheels.length, `${n} ${a}: one wheel per package`);
          assert.ok(wheels.every((w) => /(none-any|cp312-cp312|abi3)/.test(w.url)), `${n} ${a}: wheels for CPython 3.12 only`);
          assert.ok(wheels.every((w) => !/(x86_64|aarch64)/.test(w.url) || w.url.includes(a === "x64" ? "x86_64" : "aarch64")), `${n} ${a}: its own architecture's wheels`);
        }
        assert.match(pinDigest(t, a) ?? "", /^[0-9a-f]{64}$/, `${n} ${a}: a pin`);
      }
    }
    // mold_v0-184: the locks the wheels were chosen from are in the tree, each wheel's sha256 one of its lock's hashes.
    for (const n of ["cfn-lint", "moto"]) {
      const lock = readFileSync(path.join(ROOT, "scripts", "run-tools-locks", `${n}.txt`), "utf8");
      assert.ok(lock.includes(`${n}==${RUN_TOOL_CATALOG[n]!.version}`) || lock.includes(`${n}[`), `${n}: the lock pins ${RUN_TOOL_CATALOG[n]!.version}`);
      for (const a of ["x64", "arm64"] as const) for (const w of RUN_TOOL_CATALOG[n]!.python!.wheels[a]!) assert.ok(lock.includes(`sha256:${w.sha256}`), `${n}: ${w.url.split("/").pop()} is in its lock`);
    }
    assert.deepEqual(Object.keys(RUN_TOOL_CATALOG["aws-guard-rules"]!.data ?? {}), ["aws-guard-rules"], "the Guard rule sets are data");
    console.log(`✓ the catalogue: ${RUN_TOOL_NAMES.join(", ")}; each downloadable tool pinned (version, https artifact, sha256, size) for x64 and arm64; the Python tools' wheels from their locks`);
  }

  // ---------- stand-in artifacts ----------
  const stage = path.join(TMP, "stage");
  const prog = (name: string) => `#!/bin/sh\necho '${name} (stand-in)'\n`;
  mkdirSync(path.join(stage, "age"), { recursive: true });
  writeFileSync(path.join(stage, "age", "age"), prog("age 1.3.2"), { mode: 0o755 });
  writeFileSync(path.join(stage, "age", "age-keygen"), prog("age-keygen 1.3.2"), { mode: 0o755 });
  spawnSync("tar", ["-czf", path.join(TMP, "age.tar.gz"), "-C", stage, "age"]);
  mkdirSync(path.join(stage, "package"), { recursive: true });
  writeFileSync(path.join(stage, "package", "claude"), prog("2.1.295 (Claude Code)"), { mode: 0o755 });
  spawnSync("tar", ["-czf", path.join(TMP, "claude.tgz"), "-C", stage, "package"]);
  mkdirSync(path.join(stage, "aws", "dist"), { recursive: true });
  writeFileSync(path.join(stage, "aws", "dist", "aws"), prog("aws-cli/2.37.5"), { mode: 0o755 });
  writeFileSync(path.join(stage, "aws", "install"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const zip = spawnSync("python3", ["-c", `import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],'w')
for root,_,fs in os.walk('aws'):
  for f in fs:
    p=os.path.join(root,f); i=zipfile.ZipInfo(p); i.external_attr=(0o755<<16); z.writestr(i, open(p,'rb').read())
z.close()`, path.join(TMP, "aws.zip")], { cwd: stage });
  assert.equal(zip.status, 0, `a stand-in zip: ${zip.stderr}`);
  // mold_v0-184: a stand-in interpreter (python/bin/python3 answers "-m pip install <wheels>" by copying them into its
  // site directory, and "-c" by printing what it was asked), two stand-in wheels, a zip of data, a tarball whose
  // directory names the release's architecture.
  mkdirSync(path.join(stage, "python", "bin"), { recursive: true });
  writeFileSync(path.join(stage, "python", "bin", "python3"), `#!/bin/sh
d="$(dirname "$(readlink -f "$0")")/../site"
if [ "$1" = "-I" ] && [ "$2" = "-m" ] && [ "$3" = "pip" ]; then mkdir -p "$d"; for a in "$@"; do case "$a" in *.whl) cp "$a" "$d/";; esac; done; exit 0; fi
if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then shift 2; code="$1"; shift; echo "python (stand-in): $code :: $* :: $(ls "$d" | tr '\\n' ' ')"; exit 0; fi
exit 9
`, { mode: 0o755 });
  writeFileSync(path.join(stage, "python", "bin", "pytool"), "#!/bin/sh\necho pip's own script\n", { mode: 0o755 });
  spawnSync("tar", ["-czf", path.join(TMP, "python.tar.gz"), "-C", stage, "python"]);
  mkdirSync(path.join(stage, "data", "output", "sub"), { recursive: true }); mkdirSync(path.join(stage, "data", "__MACOSX"), { recursive: true });
  writeFileSync(path.join(stage, "data", "output", "a.guard"), "rule a { }\n"); writeFileSync(path.join(stage, "data", "output", "sub", "b.guard"), "rule b { }\n");
  writeFileSync(path.join(stage, "data", "__MACOSX", "._a.guard"), "fork");
  const dzip = spawnSync("python3", ["-c", `import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],'w')
for root,_,fs in os.walk('.'):
  for f in fs:
    p=os.path.relpath(os.path.join(root,f)); z.write(p, p)
z.close()`, path.join(TMP, "data.zip")], { cwd: path.join(stage, "data") });
  assert.equal(dzip.status, 0, `a stand-in data zip: ${dzip.stderr}`);
  const relArch = toolArch() === "x64" ? "x86_64" : "aarch64";
  mkdirSync(path.join(stage, `guard-${relArch}`), { recursive: true });
  writeFileSync(path.join(stage, `guard-${relArch}`, "cfn-guard"), prog("cfn-guard 3.2.1"), { mode: 0o755 });
  spawnSync("tar", ["-czf", path.join(TMP, "guard.tar.gz"), "-C", stage, `guard-${relArch}`]);
  const bodies: Record<string, Buffer> = {
    "/python.tar.gz": readFileSync(path.join(TMP, "python.tar.gz")), "/data.zip": readFileSync(path.join(TMP, "data.zip")), "/guard.tar.gz": readFileSync(path.join(TMP, "guard.tar.gz")),
    "/w/tool_a-1.2.3-py3-none-any.whl": Buffer.from("wheel a"), "/w/dep_b-2.0-py3-none-any.whl": Buffer.from("wheel b"),
    "/sops": Buffer.from(prog("sops 3.13.3")), "/kubectl": Buffer.from(prog("kubectl v1.37.1")),
    "/age.tar.gz": readFileSync(path.join(TMP, "age.tar.gz")), "/claude.tgz": readFileSync(path.join(TMP, "claude.tgz")), "/aws.zip": readFileSync(path.join(TMP, "aws.zip")),
  };
  const hits: Record<string, number> = {};
  const srv = createServer((q, r) => { hits[q.url!] = (hits[q.url!] ?? 0) + 1; const b = bodies[q.url!]; if (!b) r.writeHead(404).end(); else r.writeHead(200).end(b); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const arch = toolArch();
  const pin = (p: string, body = bodies[p]!) => ({ [arch]: { url: `${base}${p}`, sha256: sha(body), bytes: body.length } });
  const catalog: ToolCatalog = {
    git: RUN_TOOL_CATALOG.git!,
    sops: { version: "3.13.3", format: "binary", bins: { sops: "sops" }, source: "stand-in", artifacts: pin("/sops") },
    kubectl: { version: "1.37.1", format: "binary", bins: { kubectl: "kubectl" }, source: "stand-in", artifacts: pin("/kubectl") },
    age: { version: "1.3.2", format: "tar.gz", bins: { age: "age/age", "age-keygen": "age/age-keygen" }, source: "stand-in", artifacts: pin("/age.tar.gz") },
    "claude-code": { version: "2.1.295", format: "npm-tgz", bins: { claude: "package/claude" }, source: "stand-in", artifacts: pin("/claude.tgz") },
    aws: { version: "2.37.5", format: "aws-zip", bins: { aws: "dist/aws" }, source: "stand-in", artifacts: pin("/aws.zip") },
    pytool: { version: "1.2.3", format: "python", bins: { pytool: "bin/pytool" }, source: "stand-in", artifacts: pin("/python.tar.gz"),
      python: { wheels: { [arch]: ["/w/tool_a-1.2.3-py3-none-any.whl", "/w/dep_b-2.0-py3-none-any.whl"].map((w) => pin(w)[arch]!) }, entry_points: { pytool: "tool_a.cli:main" } } },
    rules: { version: "1.0.2", format: "zip", bins: {}, data: { rules: "output" }, exclude: ["__MACOSX"], source: "stand-in", artifacts: pin("/data.zip") },
    guard: { version: "3.2.1", format: "tar.gz", bins: { "cfn-guard": "guard-<arch>/cfn-guard" }, source: "stand-in", artifacts: pin("/guard.tar.gz") },
  };
  const dir = path.join(TMP, "opt", "app-tools");

  try {
    // ---------- 2. installTools ----------
    {
      const m = await installTools(["sops", "age", "claude-code", "aws", "git"], { dir, catalog });
      assert.deepEqual(Object.keys(m.tools).sort(), ["age", "aws", "claude-code", "sops"], "git is the image's own");
      const bins = verifyTools(["sops", "age", "claude-code", "aws", "git"], { dir, catalog });
      assert.deepEqual(Object.keys(bins).sort(), ["age", "age-keygen", "aws", "claude", "sops"]);
      for (const [b, p] of Object.entries(bins)) {
        const out = spawnSync(p, [], { encoding: "utf8" }).stdout;
        assert.match(out, /\(stand-in\)/, `${b} runs`);
      }
      assert.match(spawnSync(bins.aws!, [], { encoding: "utf8" }).stdout, /aws-cli\/2\.37\.5/);
      // Other bytes than the pinned ones: refused before anything is unpacked; the tools installed so far stay.
      const before = readFileSync(path.join(dir, "manifest.json"), "utf8");
      bodies["/kubectl"] = Buffer.from("#!/bin/sh\necho evil\n");
      await assert.rejects(installTools(["kubectl"], { dir, catalog }), /kubectl 1\.37\.1: the artifact's sha256 is [0-9a-f]{64}, the catalogue pins [0-9a-f]{64}: refused/);
      assert.equal(readFileSync(path.join(dir, "manifest.json"), "utf8"), before, "the manifest is unchanged");
      assert.throws(() => verifyTools(["kubectl"], { dir, catalog }), /kubectl 1\.37\.1 is not in this image/);
      bodies["/kubectl"] = Buffer.from(prog("kubectl v1.37.1"));
      const n = hits["/sops"];
      await installTools(["sops", "kubectl"], { dir, catalog });
      assert.equal(hits["/sops"], n, "a tool already installed at its pin is not downloaded again");
      verifyTools(["sops", "kubectl"], { dir, catalog });
      console.log("✓ installTools: a binary, a tar.gz, an npm tarball and the AWS zip installed from artifacts whose sha256 matched; other bytes refused (nothing installed, the manifest kept); an installed tool is not downloaded again");
    }

    // ---------- 3. verifyTools refuses ----------
    {
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      const sopsPath = path.join(dir, manifest.tools.sops.bins.sops.path);
      // Another version pinned by the catalogue than the image holds.
      assert.throws(() => verifyTools(["sops"], { dir, catalog: { ...catalog, sops: { ...catalog.sops!, version: "3.14.0" } } }), /sops: this image has 3\.13\.3, the catalogue pins 3\.14\.0/);
      // Another artifact pinned for the same version (the catalogue's checksum changed).
      assert.throws(() => verifyTools(["sops"], { dir, catalog: { ...catalog, sops: { ...catalog.sops!, artifacts: { [arch]: { url: "x", sha256: "f".repeat(64), bytes: 1 } } } } }), /not installed from the pinned artifact/);
      // The file changed after it was installed.
      const good = readFileSync(sopsPath);
      writeFileSync(sopsPath, "#!/bin/sh\necho swapped\n");
      assert.throws(() => verifyTools(["sops"], { dir, catalog }), /sops: sops is not the file that was installed/);
      writeFileSync(sopsPath, good);
      // A link swapped in for the program.
      renameSync(sopsPath, `${sopsPath}.real`); symlinkSync(`${sopsPath}.real`, sopsPath);
      assert.throws(() => verifyTools(["sops"], { dir, catalog }), /sops: sops goes through a link/);
      unlinkSync(sopsPath); renameSync(`${sopsPath}.real`, sopsPath);
      verifyTools(["sops"], { dir, catalog });
      if (asRoot) {
        chmodSync(sopsPath, 0o777);
        assert.throws(() => verifyTools(["sops"], { dir, catalog }), /writable by others than root/);
        chmodSync(sopsPath, 0o755);
        chownSync(path.join(dir, "manifest.json"), 65534, 65534);
        assert.throws(() => verifyTools(["sops"], { dir, catalog }), /the tools manifest .* is not owned by root/);
        chownSync(path.join(dir, "manifest.json"), 0, 0);
      }
      assert.throws(() => verifyTools(["terraform"], { dir, catalog }), /terraform is not in the run tools' catalogue/);
      assert.throws(() => verifyTools(["sops"], { dir: path.join(TMP, "empty"), catalog }), /this image has no run tools/);
      console.log(`✓ verifyTools refuses a tool the image lacks, another version, another artifact, a changed file, a link${asRoot ? ", files others can write or own" : ""}, a tool outside the catalogue`);
    }

    // ---------- 5. mold_v0-184: a Python tool, a data tool, an architecture in a bin's path ----------
    {
      await installTools(["pytool", "rules", "guard"], { dir, catalog });
      const set = verifyToolSet(["pytool", "rules", "guard"], { dir, catalog });
      assert.deepEqual(Object.keys(set.bins).sort(), ["cfn-guard", "pytool"]);
      assert.deepEqual(Object.keys(set.data), ["rules"]);
      const out = spawnSync(set.bins.pytool!, ["--flag"], { encoding: "utf8" }).stdout;
      assert.match(out, /^python \(stand-in\): import sys; from tool_a\.cli import main; sys\.argv\[0\] = "pytool"; sys\.exit\(main\(\)\) :: --flag :: dep_b-2\.0-py3-none-any\.whl tool_a-1\.2\.3-py3-none-any\.whl/,
        `the launcher runs the interpreter isolated with the entry point, and pip got exactly the pinned wheels: ${out}`);
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      assert.equal(manifest.tools.pytool.artifact_sha256, pinDigest(catalog.pytool!, arch), "the pin covers the interpreter and every wheel");
      assert.ok(!existsSync(path.join(dir, "pytool", "1.2.3", "python", "bin", "pytool")), "pip's own script (an absolute path into the scratch directory) is gone");
      assert.match(spawnSync(set.bins["cfn-guard"]!, [], { encoding: "utf8" }).stdout, /cfn-guard 3\.2\.1/, "a bin path naming the release's architecture");
      assert.deepEqual(readdirSync(set.data.rules!).sort(), ["a.guard", "sub"], "the data directory, without the excluded paths");
      assert.equal(manifest.tools.rules.data.rules.files, 2);
      // A wheel with other bytes than its pin: refused, nothing of the tool installed again.
      const good = bodies["/w/dep_b-2.0-py3-none-any.whl"]!;
      bodies["/w/dep_b-2.0-py3-none-any.whl"] = Buffer.from("evil wheel");
      rmSync(path.join(dir, "pytool"), { recursive: true, force: true });
      await assert.rejects(installTools(["pytool"], { dir, catalog }), /pytool 1\.2\.3: dep_b-2\.0-py3-none-any\.whl's sha256 is [0-9a-f]{64}, the catalogue pins [0-9a-f]{64}: refused/);
      bodies["/w/dep_b-2.0-py3-none-any.whl"] = good;
      await installTools(["pytool"], { dir, catalog });
      // Another wheel pinned (the catalogue changed): the image's copy is not the pin.
      const otherWheel = { ...catalog.pytool!, python: { ...catalog.pytool!.python!, wheels: { [arch]: [catalog.pytool!.python!.wheels[arch]![0]!] } } };
      assert.throws(() => verifyTools(["pytool"], { dir, catalog: { ...catalog, pytool: otherWheel } }), /pytool: this image's copy was not installed from the pinned artifact/);
      // The interpreter changed after it was installed: refused at run time.
      const m2 = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      const py = path.join(dir, m2.tools.pytool.files[0].path);
      const pyGood = readFileSync(py);
      writeFileSync(py, "#!/bin/sh\necho swapped\n");
      assert.throws(() => verifyTools(["pytool"], { dir, catalog }), /pytool: .*python3 is not the file that was installed/);
      writeFileSync(py, pyGood);
      verifyTools(["pytool"], { dir, catalog });
      // The data: a file changed, a file added, a link swapped in.
      const a = path.join(set.data.rules!, "a.guard");
      writeFileSync(a, "rule a { allow }\n");
      assert.throws(() => verifyToolSet(["rules"], { dir, catalog }), /rules: rules is not the data that was installed/);
      writeFileSync(a, "rule a { }\n");
      writeFileSync(path.join(set.data.rules!, "extra.guard"), "rule x { }\n");
      assert.throws(() => verifyToolSet(["rules"], { dir, catalog }), /rules is not the data that was installed/);
      unlinkSync(path.join(set.data.rules!, "extra.guard"));
      renameSync(a, `${a}.real`); symlinkSync(`${a}.real`, a);
      assert.throws(() => verifyToolSet(["rules"], { dir, catalog }), /is a link or a special file/);
      unlinkSync(a); renameSync(`${a}.real`, a);
      assert.deepEqual(verifyToolSet(["rules"], { dir, catalog }).data, { rules: set.data.rules });
      // Offline after install: a server that answers nothing, and every tool still verifies (nothing is fetched).
      const before = Object.values(hits).reduce((x, y) => x + y, 0);
      verifyToolSet(["pytool", "rules", "guard", "sops", "aws"], { dir, catalog });
      await installTools(["pytool", "rules", "guard"], { dir, catalog, fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
      assert.equal(Object.values(hits).reduce((x, y) => x + y, 0), before, "an installed tool is never downloaded again");
      console.log("✓ mold_v0-184: a Python tool (interpreter and wheels each checked, pip from those files only, an isolated launcher; a changed wheel refused, the interpreter re-hashed at run time), a data tool (hashed file by file; a change, an added file or a link refused), a bin path with the release's architecture; offline after install");
    }

    // ---------- 4. the build ----------
    {
      const packs = path.join(TMP, "build", "packs"), pdir = path.join(packs, "fixture_tools");
      mkdirSync(pdir, { recursive: true });
      const kindJson = (name: string, tools: string[]) => ({ name, runner: "agent-workspace", agent: {
        repository: "https://github.com/example/agent", commit: "a".repeat(40), command: ["node", "a.mjs"], validate: { command: ["node", "v.mjs"] }, write_back: ["data"], tools } });
      const writePack = (kinds: unknown[]) => writeFileSync(path.join(pdir, "pack.json"), JSON.stringify({ id: "fixture_tools", name: "Tools", version: "1", job_kinds: kinds }));
      const gen = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packs, "--out", path.join(TMP, "build", "out"), "--profile", path.join(TMP, "none.json")], { cwd: ROOT, encoding: "utf8" });
      writePack([kindJson("one", ["sops", "age"]), kindJson("two", ["claude-code", "sops", "git"])]);
      let r = gen();
      assert.equal(r.status, 0, `gen-packs: ${r.stderr}`);
      const generated = JSON.parse(readFileSync(path.join(TMP, "build", "out", "src", "run-tools.generated.json"), "utf8"));
      assert.deepEqual(generated.tools, ["age", "claude-code", "git", "sops"], "the union of the kinds' tools, for the image");
      writePack([kindJson("one", ["terraform"])]);
      r = gen();
      assert.equal(r.status, 1); assert.match(r.stderr, /tools/, "a tool outside the catalogue is refused at build");
      const zero = JSON.parse(readFileSync(path.join(ROOT, "src", "run-tools.generated.json"), "utf8"));
      assert.deepEqual(zero.tools, [], "this build (no packs) needs none: the zero-pack image installs nothing");
      // The Dockerfile's last check: the image holds every tool the build needs.
      const verify = (tools: string) => spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/install-run-tools.ts", "--verify", "--tools", tools, "--dir", dir], { cwd: ROOT, encoding: "utf8" });
      const lacks = verify("aws");
      assert.equal(lacks.status, 1, "an image without the build's tools is refused"); assert.match(lacks.stderr, /aws: this image's copy was not installed from the pinned artifact|aws 2\.37\.5 is not in this image/);
      const none = verify("");
      assert.equal(none.status, 0, `no tools: nothing to verify (${none.stderr})`);
      const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
      assert.match(dockerfile, /install-run-tools\.ts --from src\/run-tools\.generated\.json --dir \/opt\/app-tools/, "the image installs the build's tools");
      assert.match(dockerfile, /install-run-tools\.ts --verify --from src\/run-tools\.generated\.json/, "and checks them last");
      console.log("✓ the build: gen-packs writes the union of the kinds' tools and refuses one outside the catalogue; --verify (the Dockerfile's last step) refuses an image that lacks a tool the build needs");
    }
  } finally { srv.close(); }
  console.log("RUN TOOLS TEST PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
