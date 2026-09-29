/**
 * A test talks to the server IT started, or it fails. Never "whatever answers on
 * that port".
 *
 * Why this exists (mold_v1-121): test:empty-model-response spawned the fake model
 * on a hard-coded 8791 and then polled that port until something answered. When
 * the port was already held (a stale fake from an earlier run, another job on the
 * box), the fake died with EADDRINUSE on its own stderr — which the test ignored —
 * and every assertion ran against the stranger. The pass or fail that came back
 * described some other process.
 *
 * Two rules, one per kind of child:
 *
 *   - A server we write (scripts/fake-model-server.mjs) listens on port 0 and
 *     tells us, on stderr, the port the kernel gave it. We never pick a number,
 *     so nothing can already hold it. `spawnFakeModel` does this.
 *
 *   - A server we do not write (`next start` rejects -p 0) gets a port from
 *     `freePort()`, which is free NOW but can be taken before `next` binds it.
 *     So readiness is not "the port answers" but "OUR child announced it is
 *     listening on that port" (next prints `- Local: http://host:PORT` from its
 *     own 'listening' handler, and exits 1 on EADDRINUSE). `waitForNextStart`
 *     requires the announcement before it polls, and fails loudly — with the
 *     child's log — if the child exits first.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** A port nobody holds this instant. Only for children that cannot take port 0. */
export const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

/** The line scripts/fake-model-server.mjs prints once its own listener is bound. */
export const FAKE_MODEL_READY = /\[fake-model\] script=\S+ on :(\d+)/;

/**
 * Start scripts/fake-model-server.mjs and resolve once it says which port it
 * bound. Rejects (with its stderr) if it exits or stays silent — so a port that
 * is already held is an error here, never a stranger answering later.
 *
 * `port` defaults to 0 (the kernel picks). Pass one only when a caller must
 * RESTART the fake on the port a client already froze (test:vision,
 * test:model-output-budget); the fake's own ready line is still the proof.
 * @param {string[]} args  everything but --port
 * @param {{ cwd: string, port?: number, timeoutMs?: number }} opts
 */
export function spawnFakeModel(args, { cwd, port: wanted = 0, timeoutMs = 10_000 }) {
  if (args.includes("--port")) throw new Error("spawnFakeModel picks the port itself (the `port` option, default 0); do not pass --port");
  const child = spawn(process.execPath, ["scripts/fake-model-server.mjs", "--port", String(wanted), ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fake model server did not announce a port within ${timeoutMs} ms:\n${log}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fake model server exited (${code ?? signal}) before listening:\n${log}`));
    };
    child.once("exit", onExit);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.stderr.on("data", (d) => {
      log += d;
      const m = FAKE_MODEL_READY.exec(log);
      if (!m) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      const port = Number(m[1]);
      if (wanted && port !== wanted) {
        child.kill("SIGKILL");
        reject(new Error(`fake model server bound :${port}, not the :${wanted} it was asked for`));
        return;
      }
      resolve({ child, port, base: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGKILL"), log: () => log });
    });
  });
}

/**
 * Wait for a spawned `next start -p <port>` to be up — ours, not a squatter.
 * @param {{ server: import("node:child_process").ChildProcess, port: number, log: () => string, path?: string, tries?: number }} o
 */
export async function waitForNextStart({ server, port, log, path = "/onboard", tries = 240 }) {
  const mine = new RegExp(`- Local:\\s+https?://[^\\s]+:${port}\\b`);
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`next start exited (${server.exitCode ?? server.signalCode}) before it listened on :${port}:\n${log().slice(-2000)}`);
    }
    if (mine.test(log())) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return;
      } catch { /* bound, not serving yet */ }
    }
    if (i > tries) throw new Error(`next start did not come up on :${port}:\n${log().slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
