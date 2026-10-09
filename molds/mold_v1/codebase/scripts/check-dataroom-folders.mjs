#!/usr/bin/env node
/**
 * check:dataroom-folders — a build is refused when the data room it will serve already holds files under folder
 * names its profile does not use.
 *
 * The data room's folder names are a setting of the deployment (profiles/*.json `dataroom.domains.<id>.folder`;
 * agent/lib/dataroom-folders.ts). They were once part of the code, and every deployment built then stored its files
 * under those names. Such a deployment keeps them by pinning the names in its profile. If it does not, this build
 * would store each domain under the default profile's name: the existing files would be left where they are,
 * unread, and new ones written beside them. One data room would quietly become two.
 *
 * So, before a build (`prebuild`, `prebuild:eve`), this looks at the store the build is configured for:
 *
 *   - Vercel Blob (BLOB_READ_WRITE_TOKEN): every workspace under `dataroom/orgs/`;
 *   - else the local data room ($DATAROOM_DIR, or ./.dataroom), when there is one;
 *
 * and, for each folder name the profile stores nothing under (scripts/lib/legacy-dataroom-folders.json names the
 * former ones), whether a workspace holds it. If one does, the build stops with what was found, the lines to add to
 * the profile, and nothing changed: a failed build leaves the running deployment serving.
 *
 * Why refuse rather than use the names found: see agent/lib/dataroom-folder-guard.ts. The same rule guards every
 * write at run time, for a build that could not look (no store credentials where it was built).
 *
 *   node scripts/check-dataroom-folders.mjs          the gate
 *   DATAROOM_FOLDERS_CHECK=skip                      do not look (a build with no access to its store on purpose)
 *
 * Nothing to do, and no listing at all, when the profile pins every former name. With no store to look at it says
 * so and passes: CI, a fork, a first build.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The workspaces of a store that hold a folder this profile stores nothing under.
 * `candidates`: [{ id, found, configured }] (agent/lib/dataroom-folder-guard.ts `unpinnedFormerFolders`).
 * `store`: { workspaces(): Promise<string[]>, hasFolder(workspace, name): Promise<boolean> }.
 */
export async function strandedWorkspaces(candidates, store) {
  const out = [];
  if (!candidates.length) return out;
  for (const workspace of await store.workspaces()) {
    const found = [];
    for (const c of candidates) if (await store.hasFolder(workspace, c.found)) found.push(c);
    if (found.length) out.push({ workspace, found });
  }
  return out;
}

/** Vercel Blob: `dataroom/orgs/<workspace>/<folder>/…`. */
export async function blobStore(token) {
  const { list } = await import("@vercel/blob");
  return {
    kind: "the Vercel Blob store",
    async workspaces() {
      const ids = [];
      let cursor;
      do {
        const page = await list({ token, prefix: "dataroom/orgs/", mode: "folded", cursor, limit: 1000 });
        for (const f of page.folders ?? []) ids.push(f.slice("dataroom/orgs/".length).replace(/\/$/, ""));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return ids.filter(Boolean).sort();
    },
    async hasFolder(workspace, name) {
      return (await list({ token, prefix: `dataroom/orgs/${workspace}/${name}/`, limit: 1 })).blobs.length > 0;
    },
  };
}

/** The local driver: `<dir>/orgs/<workspace>/<folder>/…`. */
export function localStore(dir) {
  const orgs = join(dir, "orgs");
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  return {
    kind: `the local data room at ${dir}`,
    async workspaces() {
      return isDir(orgs) ? readdirSync(orgs).filter((n) => isDir(join(orgs, n))).sort() : [];
    },
    async hasFolder(workspace, name) {
      const p = join(orgs, workspace, name);
      return isDir(p) && readdirSync(p).length > 0;
    },
  };
}

/** The refusal, in plain words. */
export function refusal(kind, stranded, snippet) {
  const lines = stranded.map(({ workspace, found }) => `  - workspace "${workspace}": ${found.map((c) => `"${c.found}/" (this build would use "${c.configured}/")`).join(", ")}`);
  return [
    `check-dataroom-folders: this build was stopped. Nothing was changed, and nothing will be moved.`,
    ``,
    `${kind[0].toUpperCase()}${kind.slice(1)} already holds files under folder names this deployment's profile does not use:`,
    ...lines,
    ``,
    `If the build went ahead, new files would be written into new folders beside these and the existing files would no longer be read.`,
    `To keep every file exactly where it is, add this to the deployment's profile (a new file under profiles/, for example profiles/60-dataroom-folders.json), then build again:`,
    ``,
    `  ${snippet}`,
    ``,
    `That names the folders the data room is already stored under. No file is renamed, no record is rewritten, and every existing link keeps working.`,
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const guard = await import(pathToFileURL(join(ROOT, "agent/lib/dataroom-folder-guard.ts")).href);
  const candidates = guard.UNPINNED_FORMER_FOLDERS;
  if (!candidates.length) {
    console.log("check-dataroom-folders: this profile stores every folder under the name the data room has always had; nothing can be left behind.");
    process.exit(0);
  }
  if (process.env.DATAROOM_FOLDERS_CHECK === "skip") {
    console.log("check-dataroom-folders: skipped (DATAROOM_FOLDERS_CHECK=skip). Writes are still guarded at run time.");
    process.exit(0);
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  const localDir = process.env.DATAROOM_DIR?.trim() || join(process.cwd(), ".dataroom");
  const store = token ? await blobStore(token) : existsSync(join(localDir, "orgs")) ? localStore(localDir) : null;
  if (!store) {
    console.log(`check-dataroom-folders: no data room to look at from here (no BLOB_READ_WRITE_TOKEN, no ${join(localDir, "orgs")}); writes are guarded at run time.`);
    process.exit(0);
  }
  let stranded;
  try {
    stranded = await strandedWorkspaces(candidates, store);
  } catch (error) {
    console.error(
      `check-dataroom-folders: this build was stopped. ${store.kind[0].toUpperCase()}${store.kind.slice(1)} could not be read (${String(error?.message ?? error).slice(0, 200)}), so it could not be confirmed that no existing file would be left behind. ` +
        "Nothing was changed. Run the build again; if this deployment has no files yet, or its store cannot be reached from where it is built, set DATAROOM_FOLDERS_CHECK=skip for the build (writes stay guarded at run time).",
    );
    process.exit(1);
  }
  if (stranded.length) {
    const all = candidates.filter((c) => stranded.some((s) => s.found.includes(c)));
    console.error(refusal(store.kind, stranded, guard.pinSnippet(all)));
    process.exit(1);
  }
  console.log(`check-dataroom-folders: ${store.kind} holds no file under a folder name this profile does not use (looked for ${candidates.map((c) => `${c.found}/`).join(", ")}).`);
}
