// The fixture's run program (mold_v0-041): what a pack's job kind runs in the workspace harness (src/run-harness.ts).
// It is runner code (pack.json "runner", mold_v0-054): it may start processes, here a child that counts the workspace's
// files, and writes a one-line summary into the run's output directory.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const files = execFileSync("/bin/sh", ["-c", "ls -A | wc -l"], { cwd: process.env.RUN_WORKSPACE ?? ".", encoding: "utf8" }).trim();
writeFileSync(path.join(process.env.RUN_OUT ?? ".", "summary.txt"), `ok ${files}\n`);
