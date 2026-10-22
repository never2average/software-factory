// mold_v0-078 fixture: a run that keeps running while another run on the host ends. It starts a process in a session
// of its own and leaves a file in /tmp (as a run's tools do), then, for a few seconds, checks both are still there.
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
const tag = `/tmp/octi-run-users-${process.env.RUN_ID}`;
const kid = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
kid.unref();
writeFileSync(tag, "mine\n");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
console.log(JSON.stringify({ event: "long_started", uid: process.getuid(), child: kid.pid, home_mode: (statSync(process.env.HOME).mode & 0o777).toString(8), out_mode: (statSync(process.env.RUN_OUT).mode & 0o777).toString(8) }));
const t0 = Date.now(), wait = Number(JSON.parse(process.env.RUN_SCOPE || "{}").seconds ?? 8) * 1000;
while (Date.now() - t0 < wait) await new Promise((r) => setTimeout(r, 250));
console.log(JSON.stringify({ event: "long_checked", uid: process.getuid(), child_alive: alive(kid.pid), file: existsSync(tag) }));
process.exit(alive(kid.pid) && existsSync(tag) ? 0 : 3);
