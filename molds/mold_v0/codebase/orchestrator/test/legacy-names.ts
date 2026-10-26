/**
 * Hermetic tests for the names held outside a release before mold_v0-097 (the first product's name), offline:
 *  - local images: a tag this host does not have runs under its old name when only that is built (core/runners.ts
 *    localImage), a fake `docker` on PATH standing in for the host's images
 *  - an orchestrator sandbox set up before: the launcher's configure moves it over (the old unit stopped, disabled and
 *    removed, its home with its env file and its marker deleted, the new unit, home and marker in place), and
 *    stopService stops whichever unit a sandbox runs. The launcher's own commands run, through a mock boat API, in bash
 *    over a scratch directory standing for the sandbox's root, with stand-ins for sudo and systemctl.
 *
 *   npx tsx orchestrator/test/legacy-names.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "legacy-names-"));
const bin = path.join(tmp, "bin");
mkdirSync(bin);
const stub = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
let passed = 0;
const ok = (what: string) => { passed++; console.log(`  ✓ ${what}`); };

try {
  process.env.PATH = `${bin}:${process.env.PATH}`;
  // The mock boat API (section 2) first: the boat settings are read when the orchestrator's modules load.
  const root = path.join(tmp, "root");
  const state = path.join(tmp, "units");
  mkdirSync(state);
  const log = path.join(tmp, "systemctl.log");
  stub("sudo", `[ "$1" = "-n" ] && shift; exec "$@"`);
  stub("id", "exit 0");
  stub("useradd", "exit 0");
  stub("systemctl", `echo "$*" >> ${log}
case "$1" in
  disable) [ "$2" = "--now" ] && rm -f ${state}/$3 ;;
  enable) [ "$2" = "--now" ] && touch ${state}/$3 ;;
  stop) rm -f ${state}/$2 ;;
  restart) touch ${state}/$2 ;;
  is-active) [ -f ${state}/$2 ] && { echo active; exit 0; } || { echo inactive; exit 3; } ;;
esac
exit 0`);
  // The sandbox's absolute paths, under the scratch root.
  const jail = (s: string) => s.replace(/(^|[\s'"=:;(])\/(etc|home|var)\//g, `$1${root}/$2/`);
  const sh = (cmd: string) => spawnSync("bash", ["-c", jail(cmd)], { encoding: "utf8", env: { ...process.env, BOAT_ID: "bx_test1234" } });
  const boat = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = raw ? JSON.parse(raw) : {};
      const u = String(req.url).replace(/^\/api\/v1/, "");
      const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "PUT" && /\/files$/.test(u)) {
        const p = jail(` ${b.path}`).slice(1);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, b.encoding === "base64" ? Buffer.from(b.content, "base64") : b.content);
        return send({ ok: true });
      }
      if (req.method === "POST" && /\/commands$/.test(u)) {
        const r = sh(b.command);
        return send({ ok: true, exitCode: r.status, stdout: r.stdout, stderr: r.stderr });
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise<void>((r) => boat.listen(0, "127.0.0.1", r));
  process.env.BOAT_API_URL = `http://127.0.0.1:${(boat.address() as AddressInfo).port}/api/v1`;
  process.env.BOAT_API_KEY = "boat_mock";

  // ---------------------------------------------------------------- 1. local images
  stub("docker", `[ "$1 $2" = "image inspect" ] || exit 2
tag="\${@: -1}"
for t in $FAKE_IMAGES; do [ "$t" = "$tag" ] && { echo sha256:0; exit 0; }; done
echo "Error: No such image: $tag" >&2; exit 1`);
  process.env.FAKE_IMAGES = "octillion/agent-codex:0.162.1 app/agent-pi:1.1.0 octillion/agent-pi:1.1.0 octillion-sandbox:latest";
  const { localImage } = await import("../core/runners.js");
  assert.equal(await localImage("app/agent-codex:0.162.1"), "octillion/agent-codex:0.162.1");
  ok("an agent image built only under its old name runs under it");
  assert.equal(await localImage("app/agent-pi:1.1.0"), "app/agent-pi:1.1.0");
  ok("once built under the new name, the new one runs");
  assert.equal(await localImage("app/agent-amp:1.0.0"), "app/agent-amp:1.0.0");
  ok("an image built under neither name is asked for by its new name (and never pulled: --pull never)");
  assert.equal(await localImage("app-sandbox:latest"), "octillion-sandbox:latest");
  ok("the session sandbox image likewise");
  assert.equal(await localImage("custom/agent:1"), "custom/agent:1");
  ok("any other image is left as named");
  const src = (f: string) => readFileSync(path.join(import.meta.dirname, "..", "core", f), "utf8");
  assert.match(src("pool.ts"), /"run", "-d", "--init", "--pull", "never"/);
  assert.match(src("runners.ts"), /"run", "-d", "--init", "--pull", "never"/);
  ok("pods and session sandboxes start with --pull never: a missing image is an error, never a download");

  // ---------------------------------------------------------------- 2. an orchestrator sandbox set up before
  const lib = await import("../deploy/boat-lib.js");
  const at = (p: string) => path.join(root, p);
  const legacy = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true }); mkdirSync(state);
    rmSync(log, { force: true });
    for (const d of ["etc/systemd/system", "home/user", "var/lib"]) mkdirSync(at(d), { recursive: true });
    mkdirSync(at(lib.LEGACY_HOME.slice(1) + "/app"), { recursive: true });
    writeFileSync(at(lib.LEGACY_HOME.slice(1) + "/orchestrator.env"), "APP_WORKER_TOKEN=wt_old\n");
    writeFileSync(at(`etc/systemd/system/${lib.LEGACY_UNIT}.service`), "[Unit]\n");
    mkdirSync(at(lib.LEGACY_MARKER_DIR.slice(1)), { recursive: true });
    writeFileSync(at(lib.LEGACY_MARKER_DIR.slice(1) + "/host-role"), '{"role":"boat-orchestrator"}');
    writeFileSync(path.join(state, lib.LEGACY_UNIT), "");
  };

  legacy();
  assert.equal(await lib.stopService("bx_test1234"), "inactive");
  assert.ok(readFileSync(log, "utf8").includes(`stop ${lib.LEGACY_UNIT}`) && !existsSync(path.join(state, lib.LEGACY_UNIT)), "the old unit was stopped");
  ok("stopService stops the old unit on a sandbox that still runs it");

  legacy();
  mkdirSync(at(lib.HOME.slice(1) + "/app"), { recursive: true }); // the release's code, as uploadCode leaves it
  await lib.configure("bx_test1234", "orch-test", { url: "https://app.example", workerToken: "wt_new", podCapacity: 2 });
  const calls = readFileSync(log, "utf8");
  assert.ok(calls.includes(`disable --now ${lib.LEGACY_UNIT}`), `the old unit was stopped and disabled: ${calls}`);
  assert.ok(!existsSync(path.join(state, lib.LEGACY_UNIT)), "the old unit is not running");
  assert.ok(!existsSync(at(`etc/systemd/system/${lib.LEGACY_UNIT}.service`)), "its unit file is gone");
  assert.ok(!existsSync(at(lib.LEGACY_HOME.slice(1))), "its home, with its env file and the worker token in it, is gone");
  assert.ok(!existsSync(at(lib.LEGACY_MARKER_DIR.slice(1))), "its marker is gone");
  ok("configure moves a sandbox set up before over: the old unit stopped, disabled and removed, its home and marker deleted");
  assert.ok(existsSync(at(`etc/systemd/system/${lib.UNIT}.service`)), "the new unit is installed");
  assert.match(readFileSync(at(lib.HOME.slice(1) + "/orchestrator.env"), "utf8"), /APP_WORKER_TOKEN=wt_new/);
  assert.equal(JSON.parse(readFileSync(at(lib.MARKER_DIR.slice(1) + "/host-role"), "utf8")).role, "boat-orchestrator");
  const { MARKER_PATH } = await import("../core/host-guard.js");
  assert.equal(MARKER_PATH, `${lib.MARKER_DIR}/host-role`, "the host guard reads the marker configure writes");
  ok("and sets it up under the new names: unit, home with the env file, the marker the host guard reads");
  assert.equal(await lib.startService("bx_test1234"), "active");
  assert.equal(await lib.stopService("bx_test1234"), "inactive");
  assert.ok(readFileSync(log, "utf8").includes(`stop ${lib.UNIT}`));
  ok("then starts and stops the new unit");
  boat.close();
  console.log(`✓ legacy names: ${passed} checks`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
