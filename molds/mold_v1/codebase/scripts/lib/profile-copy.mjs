/**
 * A throwaway copy of this checkout under ANOTHER deployment profile, generated the way a stamped build is, so a test
 * can run the real routes, tools and UI words of a profile the checkout itself does not have. What a profile decides
 * at build time (a mode, a word) cannot be flipped inside one process: the generated profile module is imported
 * once. Each copy is its own tree, its own generated profile and its own child processes.
 *
 * The same copy-profile-generate sequence scripts/check-agent-vocabulary.mjs uses, with app/ and setup/ included so
 * a route and the coding agent's tools can be imported from it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRIES = ["agent", "app", "lib", "setup", "data", "scripts", "drizzle", "dm.md", "package.json", "tsconfig.json", "docs"];

/**
 * @param {string} root        the checkout
 * @param {[string, string | object][]} profiles   extra profile files: [name, path to a JSON file | the object itself]
 * @returns {{ dir: string, run: Function, remove: () => void }}
 */
export function copyWithProfiles(root, profiles = []) {
  const dir = mkdtempSync(join(tmpdir(), "profile-copy-"));
  const skip = (src) => !src.includes("__pycache__") && !src.includes(`${root}/app/preview`) && !/\/\.next(\/|$)/.test(src);
  for (const entry of ENTRIES) if (existsSync(join(root, entry))) cpSync(join(root, entry), join(dir, entry), { recursive: true, filter: skip });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  cpSync(join(root, "profiles", "00-default.json"), join(dir, "profiles", "00-default.json"));
  for (const [name, source] of profiles) {
    if (typeof source === "string") cpSync(source, join(dir, "profiles", name));
    else writeFileSync(join(dir, "profiles", name), JSON.stringify(source, null, 2));
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  /** Run node in the copy. `check: false` returns a failed run instead of throwing. */
  const run = (args, { env = {}, check = true, input } = {}) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...args], {
      cwd: dir,
      encoding: "utf8",
      input,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    });
    if (check && r.status !== 0) throw new Error(`profile-copy: node ${args.join(" ")} failed in a copy of the checkout:\n${(r.stderr || r.stdout).slice(-4000)}`);
    return r;
  };
  // The stamping sequence: registry, profile, prompts.
  run(["scripts/gen-subagent-meta.mjs"]);
  run(["scripts/gen-deployment-profile.mjs"]);
  run(["scripts/gen-prompts.mjs"]);
  return { dir, run, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A rendered model surface (scripts/lib/model-surface.mjs) as { title -> body }. */
export function surfaceSections(text) {
  const out = new Map();
  for (const s of text.split(/^(?==== )/m)) {
    if (!s.startsWith("=== ")) continue;
    const nl = s.indexOf("\n");
    out.set(s.slice(4, nl), s.slice(nl + 1));
  }
  return out;
}
