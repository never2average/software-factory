/**
 * How much of the machine a `next build` may use, from the build's environment (unset: Next's own defaults, so every
 * Vercel build and every developer's build is unchanged).
 *
 * Next sizes a build from the whole machine: `os.cpus().length - 1` static-generation workers (it does not see a
 * cgroup's or a CPU affinity's limit, so a build inside a 2-CPU limit on a 4-CPU host still starts 3) and no memory
 * target for Turbopack's cache. On a small server, or one that serves a release while it builds the next one, that is
 * a build the kernel kills for lack of memory. Whoever runs the build measures the machine first and says:
 *
 *   BUILD_CPUS         static-generation workers (Next's `experimental.cpus`), a whole number 1-256
 *   BUILD_MEMORY_MIB   the memory the whole build may use, in MiB (256 or more). Turbopack is given half of it as its
 *                      memory target (`experimental.turbopackMemoryLimit`, in bytes); the rest is the Node heap and the
 *                      workers. Under 3 GiB, webpack (the task-workflow service builds with it) also trades speed for
 *                      memory (`experimental.webpackMemoryOptimizations`).
 *
 * The heap ceiling itself is NODE_OPTIONS=--max-old-space-size, which Node reads without help.
 *
 * next.config.ts reads no env var raw (scripts/check-gates.mjs): a value that is not a whole number in range is
 * ignored, never half-used. No imports: next.config.ts loads this. services/task-workflow/lib/build-limits.ts is a
 * byte-for-byte copy (that service is its own package); scripts/test-build-limits.mjs keeps the two the same.
 */
export type BuildLimits = {
  cpus?: number;
  turbopackMemoryLimit?: number;
  webpackMemoryOptimizations?: boolean;
};

function whole(value: string | undefined, min: number, max: number): number | undefined {
  const v = (value ?? "").trim();
  if (!/^[0-9]+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
}

export function buildLimits(env: Record<string, string | undefined> = process.env): BuildLimits {
  const out: BuildLimits = {};
  const cpus = whole(env.BUILD_CPUS, 1, 256);
  if (cpus !== undefined) out.cpus = cpus;
  const mib = whole(env.BUILD_MEMORY_MIB, 256, 1048576);
  if (mib !== undefined) {
    out.turbopackMemoryLimit = Math.floor(mib / 2) * 1024 * 1024;
    if (mib < 3072) out.webpackMemoryOptimizations = true;
  }
  return out;
}
