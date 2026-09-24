// The base specialists a deployment profile excludes (`specialists.exclude` in profiles/*.json), read straight
// from the profile files so every generator agrees without depending on generation order: the subagent registry
// (scripts/gen-subagent-meta.mjs), the eve build (scripts/eve-build.mjs), the checks. Merge rule as the profile
// generator's: files in name order, a later file's list replaces an earlier one's. Nothing is ever moved: an
// excluded specialist's directory stays in the tree, tracked, and is left out of what is generated and built.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function excludedSpecialists(root) {
  const dir = process.env.PROFILES_DIR || join(root, "profiles");
  if (!existsSync(dir)) return [];
  let exclude = [];
  for (const f of readdirSync(dir).filter((n) => /^\d{2}-[a-z0-9-]+\.json$/.test(n)).sort()) {
    try {
      const list = JSON.parse(readFileSync(join(dir, f), "utf8"))?.specialists?.exclude;
      if (Array.isArray(list)) exclude = list.filter((k) => typeof k === "string");
    } catch {
      /* gen-deployment-profile.mjs reports a malformed profile, with its file and path */
    }
  }
  return exclude;
}
