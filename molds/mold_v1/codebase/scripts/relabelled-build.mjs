/**
 * A PRODUCTION BUILD UNDER THE RELABELLING PROFILE, MADE IN A COPY, NEVER IN THIS CHECKOUT (factory task mold_v1-188).
 *
 * The isolation job's HTTP checks (test:workbook-route-db, then test:storage-isolation-http-db,
 * test:deployment-upsert-db, test:shared-company-id-http-db, test:named-workspace-http-db) run against `next start`
 * of a build under the relabelling (research-desk) profile, scripts/fixtures/agent-vocabulary/50-relabelled.json, whose
 * hidden fields and declared own fields they assert. That build used to be made IN THE CHECKOUT:
 * `cp scripts/fixtures/agent-vocabulary/50-relabelled.json profiles/ && npm run build`, which left the profile in
 * profiles/ and every generated file regenerated from it. A later job in the same checkout then built and checked the
 * relabelled app as if it were the default one, and a stray profile could be committed.
 *
 *   build   copies the checkout to .ui-vocabulary/relabelled-build (scripts/lib/checkout-copy.mjs; git-ignored),
 *           stamps the profile on the COPY, runs what `npm run build` runs (prebuild, then next build) there, and
 *           prints the copy's path. A build that fails or is interrupted (SIGINT, SIGTERM) removes the copy; a
 *           build that succeeds keeps it for the checks that follow, which take it with `--dir`.
 *   remove  removes it (CI's last isolation step, `if: always()`).
 *   dir     prints its path.
 *
 * This checkout's profiles/ and generated files are never written; `npm run check:checkout-clean` holds that.
 *
 *   npm run build:relabelled
 *   ADMIN_URL=… DATABASE_URL=… npm run test:workbook-route-db -- --dir "$(npm run -s build:relabelled:dir)"
 *   npm run clean:relabelled
 */
import { spawn } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { copyDir, onAnyExit, removeCopy, temporaryCopy } from "./lib/checkout-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const NAME = "relabelled-build";
const FIXTURE = join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const command = process.argv[2];

if (command === "dir") {
  console.log(copyDir(ROOT, NAME));
  process.exit(0);
}
if (command === "remove") {
  removeCopy(ROOT, NAME);
  console.log(`relabelled-build: ${relative(ROOT, copyDir(ROOT, NAME))} removed`);
  process.exit(0);
}
if (command !== "build") {
  console.error("usage: node scripts/relabelled-build.mjs build | remove | dir");
  process.exit(2);
}

/** The child running now: stopped with this process, so an interrupted build leaves no `next build` behind. */
let child = null;
onAnyExit(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
});
const run = (what, cmd, args, cwd) =>
  new Promise((resolveRun) => {
    console.log(`\n$ ${what}`);
    child = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    child.on("exit", (code, signal) => {
      child = null;
      resolveRun(code ?? (signal ? 1 : 0));
    });
  });

// Removed on every way out until the build has succeeded (then `remove` is what takes it away).
const { dir, remove, keep } = temporaryCopy(ROOT, NAME);
cpSync(FIXTURE, join(dir, "profiles", "50-relabelled.json"));
console.log(`relabelled-build: a copy of the checkout at ${relative(ROOT, dir)}, stamped with ${relative(ROOT, FIXTURE)}`);

// What `npm run build` does (prebuild, then next build), in the copy. Turbopack's root is the checkout, whose
// node_modules the copy uses (it has none of its own).
let status = await run("npm run prebuild (in the copy)", "npm", ["run", "-s", "prebuild"], dir);
if (status === 0) {
  writeFileSync(join(dir, "next.config.base.ts"), readFileSync(join(dir, "next.config.ts"), "utf8"));
  writeFileSync(join(dir, "next.config.ts"), `import base from "./next.config.base.ts";\nexport default { ...base, turbopack: { ...(base as { turbopack?: object }).turbopack, root: ${JSON.stringify(ROOT)} } };\n`);
  status = await run("next build (in the copy)", process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "build"], dir);
}
if (status !== 0) {
  console.error("relabelled-build: the build failed; the copy is removed");
  remove();
  process.exit(status);
}
// Built: keep it for the checks that follow (the exit cleanup would otherwise take it).
keep();
console.log(`\nrelabelled-build: built in ${relative(ROOT, dir)} (run the checks with --dir ${dir}; \`npm run clean:relabelled\` removes it)`);
