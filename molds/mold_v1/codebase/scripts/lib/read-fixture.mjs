/**
 * A JSON fixture, read the way this deployment stores things.
 *
 * A fixture is base text: where a record names a data-room folder (a path, a ticket's `affectedSchema`), it writes
 * the folder as a placeholder (`{folder:accounts}`, agent/lib/dataroom-folders.ts) and never a name, because the
 * name is the deployment profile's. Read through here, the placeholder is the folder THIS build stores the domain
 * under, so the same fixture is valid under the default profile and under one that pins other names.
 */
import { readFileSync } from "node:fs";
import { fillFolders } from "../../agent/lib/dataroom-folders.ts";

/** @param {string | URL} file */
export function readJsonFixture(file) {
  return JSON.parse(fillFolders(readFileSync(file, "utf8")));
}
