/**
 * The default profile with the record words it carried before it spoke neutrally (customer, deployment,
 * implementation, rollout): profiles/00-default.json merged, by the real generator, with
 * scripts/fixtures/legacy-record-words/50-legacy-record-words.json.
 *
 * Tests use it for one thing: to hold a renderer or a set of UI words byte-identical to its pre-change output.
 * The words changed; the code that prints them did not, and this is the profile that proves it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
export const LEGACY_RECORD_WORDS = join(ROOT, "scripts/fixtures/legacy-record-words/50-legacy-record-words.json");

/** A throwaway profiles directory: the default profile, the legacy record words, and any further overlays. */
export function legacyRecordProfilesDir(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-record-profiles-"));
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  cpSync(LEGACY_RECORD_WORDS, join(dir, "50-legacy-record-words.json"));
  for (const [name, file] of extra) cpSync(file, join(dir, name));
  return dir;
}

/** The merged, validated profile (what `gen-deployment-profile.mjs --print` gives for that directory). */
export function legacyRecordProfile() {
  const dir = legacyRecordProfilesDir();
  try {
    const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`the legacy record-words profile does not validate:\n${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
