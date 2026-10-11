#!/usr/bin/env node
/**
 * test:build-limits — a build's size comes from the machine that runs it, through BUILD_CPUS and BUILD_MEMORY_MIB
 * (lib/build-limits.ts), and from nowhere else; unset, Next's own defaults (every Vercel build is unchanged).
 *
 *   · unset or blank: no setting at all
 *   · BUILD_CPUS: a whole number 1-256 becomes `experimental.cpus`; anything else (0, -1, 2.5, "two", 257) is ignored
 *   · BUILD_MEMORY_MIB: a whole number from 256 becomes Turbopack's memory target (half of it, in bytes), and under
 *     3072 webpack's memory optimisations too; anything else is ignored
 *   · Next itself accepts what comes out (its own config schema, from the installed `next`), so a renamed option fails
 *     here and not as a silently ignored key on a server
 *   · the web app's and the task-workflow service's next.config.ts both spread buildLimits() into `experimental`, and
 *     the service's copy of the helper is the web app's, byte for byte
 *
 *   node --experimental-strip-types scripts/test-build-limits.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { buildLimits } = await import(join(ROOT, "lib/build-limits.ts"));
const require = createRequire(join(ROOT, "package.json"));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MiB = 1024 * 1024;

check("unset: no setting (Next's defaults)", same(buildLimits({}), {}));
check("blank values: no setting", same(buildLimits({ BUILD_CPUS: " ", BUILD_MEMORY_MIB: "" }), {}));
check("BUILD_CPUS=2: two static-generation workers", same(buildLimits({ BUILD_CPUS: "2" }), { cpus: 2 }));
check("BUILD_CPUS with spaces around it is read", same(buildLimits({ BUILD_CPUS: " 3 " }), { cpus: 3 }));
for (const bad of ["0", "-1", "2.5", "two", "257", "1e2", "0x2"]) {
  check(`BUILD_CPUS=${JSON.stringify(bad)} is ignored`, same(buildLimits({ BUILD_CPUS: bad }), {}), JSON.stringify(buildLimits({ BUILD_CPUS: bad })));
}
check("BUILD_MEMORY_MIB=2048: Turbopack targets 1024 MiB, webpack saves memory",
  same(buildLimits({ BUILD_MEMORY_MIB: "2048" }), { turbopackMemoryLimit: 1024 * MiB, webpackMemoryOptimizations: true }));
check("BUILD_MEMORY_MIB=4096: Turbopack targets 2048 MiB, webpack as usual",
  same(buildLimits({ BUILD_MEMORY_MIB: "4096" }), { turbopackMemoryLimit: 2048 * MiB }));
check("BUILD_MEMORY_MIB=3072 is not under 3 GiB", same(buildLimits({ BUILD_MEMORY_MIB: "3072" }), { turbopackMemoryLimit: 1536 * MiB }));
for (const bad of ["255", "-2048", "2048.5", "2G", "1048577"]) {
  check(`BUILD_MEMORY_MIB=${JSON.stringify(bad)} is ignored`, same(buildLimits({ BUILD_MEMORY_MIB: bad }), {}));
}
check("both together", same(buildLimits({ BUILD_CPUS: "1", BUILD_MEMORY_MIB: "1500" }),
  { cpus: 1, turbopackMemoryLimit: 750 * MiB, webpackMemoryOptimizations: true }));

const { configSchema } = require("next/dist/server/config-schema");
for (const env of [{ BUILD_CPUS: "1", BUILD_MEMORY_MIB: "1500" }, { BUILD_CPUS: "8", BUILD_MEMORY_MIB: "8192" }]) {
  const r = configSchema.safeParse({ experimental: buildLimits(env) });
  check(`the installed Next accepts what ${JSON.stringify(env)} gives`, r.success, r.success ? "" : JSON.stringify(r.error.issues).slice(0, 300));
}
check("  ...and refuses a misspelt option (the schema is strict, so the check above means something)",
  !configSchema.safeParse({ experimental: { cpuz: 2 } }).success);

const web = readFileSync(join(ROOT, "lib/build-limits.ts"), "utf8");
const svc = readFileSync(join(ROOT, "services/task-workflow/lib/build-limits.ts"), "utf8");
check("the task-workflow service's lib/build-limits.ts is the web app's, byte for byte", web === svc);
const webConfig = readFileSync(join(ROOT, "next.config.ts"), "utf8");
const svcConfig = readFileSync(join(ROOT, "services/task-workflow/next.config.ts"), "utf8");
check("the web app's next.config.ts spreads buildLimits() into experimental",
  /import \{ buildLimits \} from "\.\/lib\/build-limits\.ts"/.test(webConfig) && /const BUILD_LIMITS = buildLimits\(\)/.test(webConfig) && /experimental: \{ \.\.\.BUILD_LIMITS/.test(webConfig));
check("the task-workflow service's next.config.ts sets experimental from buildLimits()",
  /import \{ buildLimits \} from "\.\/lib\/build-limits\.ts"/.test(svcConfig) && /experimental: buildLimits\(\)/.test(svcConfig));

if (failed) {
  console.error(`test-build-limits: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("test-build-limits: all checks pass");
