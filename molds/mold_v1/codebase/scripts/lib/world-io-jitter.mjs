/**
 * TEST ONLY (mold_v1-191): a `--import` preload that delays each read eve's local workflow world makes of its data
 * directory (`.workflow-data`) by a random 0..EVE_STRESS_JITTER_MS ms. A replay then takes longer and varies, so two
 * invocations of one run that start close together overlap far more often — the interleaving behind a step run twice
 * (scripts/stress-specialist-together.mjs `--jitter-ms`). With EVE_STRESS_JITTER_WRITES=1 each file the world writes
 * there is delayed the same way, which widens the gaps between the several files one event is made of (a lazy step
 * start writes the step, its step_created event, the step again, and its step_started event). Nothing else changes.
 */
import fs from "node:fs";

const MAX = Number(process.env.EVE_STRESS_JITTER_MS ?? "0");
if (MAX > 0) {
  console.error(`[world-io-jitter] pid ${process.pid}: world reads${process.env.EVE_STRESS_JITTER_WRITES === "1" ? " and writes" : ""} delayed 0..${MAX} ms`);
  const p = fs.promises;
  const jitter = () => new Promise((r) => setTimeout(r, Math.random() * MAX));
  const ours = (path) => String(path?.pathname ?? path).includes(".workflow-data");
  for (const name of ["readFile", "readdir", ...(process.env.EVE_STRESS_JITTER_WRITES === "1" ? ["writeFile"] : [])]) {
    const original = p[name].bind(p);
    p[name] = async (path, ...rest) => {
      if (ours(path)) await jitter();
      return original(path, ...rest);
    };
  }
}
