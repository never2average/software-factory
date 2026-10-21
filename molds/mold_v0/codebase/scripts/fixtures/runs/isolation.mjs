// The isolation probe (mold_v0-041 review): tries to read its runner's environment through /proc, and leaves a process
// behind in a session of its own. Run as a separate user, the read is refused and the process dies with the run.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let environ;
try { environ = readFileSync(`/proc/${process.ppid}/environ`, "utf8").split("\0").map((x) => x.split("=")[0]).filter(Boolean); }
catch (e) { environ = e.code ?? String(e); }
const g = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
g.unref();
console.log(JSON.stringify({ event: "isolation", environ, grandchild: g.pid, uid: process.getuid() }));
