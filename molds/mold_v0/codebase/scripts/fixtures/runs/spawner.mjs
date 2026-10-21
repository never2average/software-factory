// A run program that starts processes (mold_v0-054): a node child and a shell child, as a pack's runner would start its
// upstream tool. Both run as the run's own user (never the runner's); one is left behind in a session of its own, and
// must not outlive the run.
import { execFileSync, spawn } from "node:child_process";

const nodeUid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.getuid()))"], { encoding: "utf8" }));
const shUid = Number(execFileSync("/bin/sh", ["-c", "id -u"], { encoding: "utf8" }).trim());
const left = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
left.unref();
console.log(JSON.stringify({ event: "spawned", uid: process.getuid(), node_child_uid: nodeUid, sh_child_uid: shUid, left_behind: left.pid }));
