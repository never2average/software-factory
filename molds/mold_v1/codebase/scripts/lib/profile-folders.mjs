// The data-room folders' STORED names under a tree's deployment profile (`dataroom.domains.<id>.folder`,
// `dataroom.uploads_folder` in profiles/*.json), read straight from the profile files so a generator or a check can
// know them without depending on generation order: the subagent registry (scripts/gen-subagent-meta.mjs validates
// a pack's path templates against them), the store check (scripts/check-dataroom-folders.mjs), the tests. Merge rule
// as the profile generator's: files in name order, a later file's value replaces an earlier one's. A profile
// written when a folder's name was still in the code names the domain by that name: it is read as the domain's id
// here too (scripts/lib/legacy-dataroom-folders.json is the one place those names are spelled).
// scripts/gen-deployment-profile.mjs validates all of it and reports a malformed profile with its file and path.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The names the folders had while they were written into the code, by domain id (and "uploads"). */
export function legacyFolders(root) {
  const doc = JSON.parse(readFileSync(join(root, "scripts/lib/legacy-dataroom-folders.json"), "utf8"));
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("$")));
}

/** { accounts: "<stored name>", …, uploads: "<stored name>" } for the tree at `root` (or $PROFILES_DIR). */
export function storedFoldersOfTree(root) {
  const dir = process.env.PROFILES_DIR || join(root, "profiles");
  const legacy = legacyFolders(root);
  const idOfLegacyKey = new Map(Object.entries(legacy).filter(([id]) => id !== "uploads").map(([id, name]) => [name, id]));
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => /^\d{2}-[a-z0-9-]+\.json$/.test(n)).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const room = doc?.dataroom;
    if (!room || typeof room !== "object") continue;
    if (typeof room.uploads_folder === "string") out.uploads = room.uploads_folder;
    for (const [key, entry] of Object.entries(room.domains ?? {})) {
      const id = idOfLegacyKey.get(key) ?? key;
      if (entry && typeof entry === "object" && typeof entry.folder === "string") out[id] = entry.folder;
    }
  }
  return out;
}
