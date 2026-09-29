/**
 * test:own-listener — a test talks to the server it started, or fails loudly
 * (mold_v1-121). See scripts/lib/own-listener.mjs for the why.
 *
 *   1. A squatter holds a port. The fake model server asked for that port exits
 *      non-zero and SAYS it could not listen (it used to crash on an unhandled
 *      'error' the caller never read).
 *   2. spawnFakeModel never asks for a number: it gets the kernel's port back
 *      from the server, and that port is the fake's (GET /__requests is JSON).
 *   3. waitForNextStart refuses a port that answers but that our child never
 *      announced (the squatter), and fails at once if our child exits.
 *   4. Ratchet: no script picks a literal port for a server it starts, and every
 *      "free port, then spawn" goes through the one helper that checks the child.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_MODEL_READY, freePort, spawnFakeModel, waitForNextStart } from "./lib/own-listener.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};

// A stranger that answers everything with 200 and a JSON body that is NOT the fake's.
const squatter = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ squatter: true }));
});
await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
const held = squatter.address().port;

try {
  /* 1 — the fake refuses a held port out loud */
  {
    const child = spawn(process.execPath, ["scripts/fake-model-server.mjs", "--port", String(held), "--script", "empty-then-answer"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); r("still running"); }, 5000);
      child.on("exit", (c) => { clearTimeout(t); r(c); });
    });
    check(`the fake exits non-zero when its port is held (exit: ${code})`, typeof code === "number" && code !== 0);
    check("…and says why, in one line the caller can show", /\[fake-model\] could not listen on :\d+: EADDRINUSE/.test(err));
    check("…and never prints the ready line a caller waits for", !FAKE_MODEL_READY.test(err));
  }

  /* 2 — spawnFakeModel: the kernel's port, read back from the fake itself */
  {
    const fake = await spawnFakeModel(["--script", "empty-then-answer"], { cwd: ROOT });
    try {
      check(`spawnFakeModel got a real port (${fake.port}), not the squatter's`, fake.port > 0 && fake.port !== held);
      const body = await (await fetch(`${fake.base}/__requests`)).json();
      check("…and what answers there is the fake (an empty request log), not a stranger", Array.isArray(body) && body.length === 0);
    } finally {
      fake.stop();
    }
    let threw = "";
    try { spawnFakeModel(["--port", "1234"], { cwd: ROOT }); } catch (e) { threw = String(e.message); }
    check("spawnFakeModel refuses a caller-chosen --port", /do not pass --port/.test(threw));
  }

  /* 3 — waitForNextStart: announcement first, and a dead child is fatal */
  {
    // A child that stays up but never listens: the squatter answers 200 on `held`.
    const silent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    let msg = "";
    try {
      await waitForNextStart({ server: silent, port: held, log: () => "", tries: 4 });
    } catch (e) { msg = String(e.message); }
    silent.kill("SIGKILL");
    check("a port that answers but that our child never announced is not 'up'", /did not come up on :\d+/.test(msg));

    // A child that dies the way next does on EADDRINUSE.
    const dying = spawn(process.execPath, ["-e", "console.error('Error: listen EADDRINUSE'); process.exit(1)"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    dying.stderr.on("data", (d) => (log += d));
    await new Promise((r) => dying.on("exit", r));
    msg = "";
    const t0 = Date.now();
    try {
      await waitForNextStart({ server: dying, port: held, log: () => log });
    } catch (e) { msg = String(e.message); }
    check("a child that exited fails at once, with its log", /exited \(1\) before it listened/.test(msg) && /EADDRINUSE/.test(msg) && Date.now() - t0 < 2000);

    // And the good path: a child that announces its port the way `next start` does.
    const port = await freePort();
    const src = `require("node:http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1", () => console.log("   - Local:         http://127.0.0.1:${port}"))`;
    const good = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    good.stdout.on("data", (d) => (out += d));
    msg = "ok";
    try { await waitForNextStart({ server: good, port, log: () => out, tries: 40 }); } catch (e) { msg = String(e.message); }
    good.kill("SIGKILL");
    check("a child that announced its own port is up", msg === "ok");
  }

  /* 4 — ratchet over every script that starts a server */
  {
    const files = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (n === "node_modules") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(mjs|js|ts)$/.test(n)) files.push(p);
      }
    };
    walk(join(ROOT, "scripts"));
    walk(join(ROOT, "tests"));
    const offenders = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (rel === "scripts/lib/own-listener.mjs" || rel === "scripts/test-own-listener.mjs") continue;
      const s = readFileSync(f, "utf8");
      const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\bconst\s+port\s*=\s*\d{2,5}\s*;/.test(code)) offenders.push(`${rel}: const port = <literal>`);
      if (/\.listen\(\s*\d{2,5}\s*[,)]/.test(code)) offenders.push(`${rel}: listen(<literal>)`);
      if (/["']--port["']\s*,\s*["']\d{2,5}["']/.test(code)) offenders.push(`${rel}: spawn --port <literal>`);
      if (/fake-model-server\.mjs/.test(code) && /\bspawn\(/.test(code) && !/spawnFakeModel/.test(code)) offenders.push(`${rel}: spawns the fake model without spawnFakeModel`);
      if (/const\s+freePort\s*=/.test(code)) offenders.push(`${rel}: its own freePort (use scripts/lib/own-listener.mjs)`);
      if (/\bnext\/dist\/bin\/next\b/.test(code) && /["']start["']/.test(code) && !/waitForNextStart/.test(code)) offenders.push(`${rel}: next start without waitForNextStart`);
    }
    check(`no script picks a port for a server it starts, or trusts a port it did not see its child bind${offenders.length ? `:\n    ${offenders.join("\n    ")}` : ""}`, offenders.length === 0);
  }
} finally {
  squatter.close();
}

assert.equal(failed, 0, `${failed} check(s) failed`);
console.log("\ntest:own-listener: all checks passed");
