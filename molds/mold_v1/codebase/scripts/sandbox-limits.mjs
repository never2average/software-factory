#!/usr/bin/env node
/**
 * sandbox-limits — what the sandbox guard (agent/lib/sandbox-guard.ts) allows on THIS host, or on a host of a given
 * size, as one line of JSON. Read-only: it starts nothing and writes nothing.
 *
 * Every limit is derived from the host when the agent starts (agent/lib/sandbox-settings.ts `sandboxLimitsFor`):
 * sandboxes running at once, sandboxes booting at once, the memory kept free before one more boots, and the memory
 * kept for the host itself. So a server moved to a bigger size needs a restart of the agent, not an edit. This
 * prints the numbers the guard will use, so a deploy can record them and an operator can be told what a bigger
 * size would give.
 *
 *   node --experimental-strip-types scripts/sandbox-limits.mjs
 *        this host (its CPUs and /proc/meminfo MemTotal, the same reads the guard makes) and this environment
 *        (SANDBOX_CPUS, SANDBOX_MEMORY_MIB, SANDBOX_MAX_RUNNING)
 *   node --experimental-strip-types scripts/sandbox-limits.mjs --cpus 8 --memory-mib 16000
 *        a host of that size, with this environment's sandbox size (SANDBOX_MAX_RUNNING is ignored: a fixed
 *        setting says nothing about another size)
 *   node --experimental-strip-types scripts/sandbox-limits.mjs --self-test
 *
 * Exit 1, with the reason on stderr, when a SANDBOX_* setting is set and wrong.
 */
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const settings = await import(pathToFileURL(join(ROOT, "agent/lib/sandbox-settings.ts")).href);
const { sandboxLimitsFor, sandboxGuardSettings, SANDBOX_DEFAULT_CPUS, SANDBOX_DEFAULT_MEMORY_MIB } = settings;

function hostMemoryMiB() {
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    /* not Linux */
  }
  return Math.floor(totalmem() / 1048576);
}

function whole(env, name, fallback) {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name}=${JSON.stringify(raw)} is not a whole number of at least 1.`);
  return Number(raw);
}

/** The limits for `argv` and `env`; `probe` reads this host. */
export function limits(argv, env, probe = { cpus: availableParallelism, memoryMiB: hostMemoryMiB }) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    const v = argv[i + 1] ?? "";
    if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error(`${name} needs a whole number of at least 1, not ${JSON.stringify(v)}.`);
    return Number(v);
  };
  const cpus = opt("--cpus");
  const memoryMiB = opt("--memory-mib");
  const sized = cpus !== null || memoryMiB !== null;
  const guard = sandboxGuardSettings(env);
  return sandboxLimitsFor(
    {
      hostCpus: cpus ?? probe.cpus(),
      hostMemoryMiB: memoryMiB ?? probe.memoryMiB(),
      sandboxCpus: whole(env, "SANDBOX_CPUS", SANDBOX_DEFAULT_CPUS),
      sandboxMemoryMiB: whole(env, "SANDBOX_MEMORY_MIB", SANDBOX_DEFAULT_MEMORY_MIB),
    },
    sized ? { maxRunning: null } : guard,
  );
}

function selfTest() {
  const assert = (ok, what) => {
    if (!ok) throw new Error(`sandbox-limits self-test: ${what}`);
  };
  const fixed = { cpus: () => 4, memoryMiB: () => 7941 };
  const here = limits([], {}, fixed);
  assert(here.maxRunning === 2 && here.maxStarting === 2 && here.memoryHeadroomMiB === 512 && here.hostReservedMiB === 2048 && here.maxRunningFrom === "host", `4 CPUs, 7941 MiB: ${JSON.stringify(here)}`);
  const big = limits(["--cpus", "8", "--memory-mib", "15990"], { SANDBOX_MAX_RUNNING: "2" }, fixed);
  assert(big.maxRunning === 4 && big.maxStarting === 4 && big.maxRunningFrom === "host", `a sized host ignores a fixed setting: ${JSON.stringify(big)}`);
  const set = limits([], { SANDBOX_MAX_RUNNING: "3" }, fixed);
  assert(set.maxRunning === 3 && set.maxRunningFrom === "setting", `the setting wins on this host: ${JSON.stringify(set)}`);
  let threw = false;
  try {
    limits(["--cpus", "zero"], {}, fixed);
  } catch {
    threw = true;
  }
  assert(threw, "a wrong --cpus is refused");
  console.log("sandbox-limits: self-test passed (4 checks)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes("--self-test")) selfTest();
    else console.log(JSON.stringify(limits(argv, process.env)));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
