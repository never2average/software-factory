#!/usr/bin/env node
/**
 * POSTINSTALL: apply patches/eve+<version>.patch to node_modules/eve, from whatever state an install left it in.
 *
 * `patch-package` applies a patch to a PRISTINE package, and skips one that already carries that very patch (it checks
 * by reverse-applying it). It cannot move a package from one revision of a patch to another. `npm ci` always starts
 * from a pristine eve, but `npm install` over an existing node_modules leaves eve as it was, and that is what a Vercel
 * build does: it restores node_modules from its build cache (eve with the PREVIOUS deploy's patch on it) and runs
 * `npm install`. The first deploy after a patch change then failed ("Failed to apply patch for package eve"): the new
 * patch neither applied nor reverse-applied to an eve carrying the old one.
 *
 * So: run patch-package as before. If it fails, put eve back as published — the exact tarball the lockfile names,
 * checked against the lockfile's integrity hash — keeping eve's own nested node_modules, and apply again. A second
 * failure fails the install, as before. Everything else about the patch is unchanged (docs/EVE_PATCH.md);
 * `npm run check:eve-patch` still proves the result before any build.
 *
 *   node scripts/eve-patch/postinstall.mjs      what `postinstall` runs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVE = join(ROOT, "node_modules", "eve");
const PATCH_PACKAGE = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "patch-package.cmd" : "patch-package");

/** patch-package as `postinstall` always ran it. True when it succeeded. */
export function patchPackage(root = ROOT) {
  const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "patch-package.cmd" : "patch-package");
  return spawnSync(existsSync(bin) ? bin : PATCH_PACKAGE, ["--error-on-fail"], { cwd: root, stdio: "inherit" }).status === 0;
}

/** The eve the lockfile installs: its version, tarball and integrity. */
export function lockedEve(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const entry = lock.packages?.["node_modules/eve"];
  if (!entry?.version || !entry?.integrity) throw new Error("package-lock.json has no node_modules/eve entry with a version and an integrity hash");
  return { version: entry.version, integrity: entry.integrity, resolved: entry.resolved };
}

/**
 * Put node_modules/eve back exactly as published: the lockfile's tarball (from npm's cache or registry), its sha512
 * checked against the lockfile, unpacked over the package. eve's own node_modules (nested dependencies) are kept.
 */
export function restorePristineEve(root = ROOT) {
  const eve = join(root, "node_modules", "eve");
  const { version, integrity } = lockedEve(root);
  const tmp = mkdtempSync(join(tmpdir(), "eve-pristine-"));
  try {
    execFileSync("npm", ["pack", `eve@${version}`, "--pack-destination", tmp, "--silent"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack eve@${version} produced no tarball`);
    const [algo, expected] = integrity.split("-");
    const got = createHash(algo).update(readFileSync(join(tmp, tgz))).digest("base64");
    if (got !== expected) throw new Error(`the eve@${version} tarball does not match package-lock.json's integrity hash; nothing was replaced`);
    execFileSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp]);
    for (const entry of readdirSync(eve)) if (entry !== "node_modules") rmSync(join(eve, entry), { recursive: true, force: true });
    cpSync(join(tmp, "package"), eve, { recursive: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The whole postinstall. Returns the exit code. */
export function postinstall(root = ROOT, ops = { patchPackage, restorePristineEve }) {
  if (ops.patchPackage(root)) return 0;
  if (!existsSync(join(root, "node_modules", "eve", "package.json"))) return 1;
  console.error(
    "eve-patch: node_modules/eve carries something else (an earlier revision of the patch, from a restored build cache, " +
      "or an edit): putting eve back as published (the lockfile's tarball) and applying the patch again.",
  );
  try {
    ops.restorePristineEve(root);
  } catch (error) {
    console.error(`eve-patch: could not put eve back as published: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return ops.patchPackage(root) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(postinstall());
