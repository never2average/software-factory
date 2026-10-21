// The fixture's run program (mold_v0-041): what a pack's job kind runs in the workspace harness (src/run-harness.ts).
// It writes a one-line summary into the run's output directory and exits 0.
import { writeFileSync } from "node:fs";
import path from "node:path";

writeFileSync(path.join(process.env.RUN_OUT ?? ".", "summary.txt"), "ok\n");
