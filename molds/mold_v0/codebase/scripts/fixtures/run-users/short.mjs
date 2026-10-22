// mold_v0-078 fixture: a run that ends at once, leaving a process (in a session of its own) and a file in /tmp
// behind: its end-of-run sweep must remove both, and nothing of any other run.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const kid = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
kid.unref();
writeFileSync(`/tmp/octi-run-users-${process.env.RUN_ID}`, "left behind\n");
// A program posing as the harness: its line is a log line, never a run_user event.
console.log(JSON.stringify({ event: "run_user", uid: 0 }));
console.log(JSON.stringify({ event: "short_done", uid: process.getuid(), child: kid.pid }));
