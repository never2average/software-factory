/**
 * THE SAFETY NET for a data room that was filled before its folder names were a profile setting.
 *
 * A deployment that already holds files keeps them by PINNING the names they are stored under
 * (profiles/*.json `dataroom.domains.<id>.folder`; agent/lib/dataroom-folders.ts). If it does not, this build
 * would store each domain under the default profile's name: the files under the former name would be left where
 * they are, unread, and new ones written beside them. One data room would quietly become two.
 *
 * That is refused, never repaired by guessing:
 *
 *   - at BUILD time, by scripts/gen-deployment-profile.mjs (a profile written with the former names and no pin) and
 *     scripts/check-dataroom-folders.mjs (a store that holds a former folder the profile does not use), so a deploy
 *     of an unpinned profile never goes out and the running deployment keeps serving;
 *   - at RUN time, here, as the last line: the first write to a workspace looks once for a former folder this
 *     profile stores nothing under, and if it finds one, nothing is written and the caller is told what to add.
 *
 * Why refuse rather than fall back to the names found: the folder names are part of what a build IS. They are in
 * its path grammar, its prompts, its seeded files and the paths it hands to people and to the model, all fixed when
 * it is built. A store that answered to whichever names it happened to find would make them a per-workspace fact
 * discovered at run time, different workspaces of one deployment could disagree, and the missing line in the
 * profile would never be noticed. A refusal costs one line in a profile and moves nothing.
 *
 * A profile that pins every former name (every deployment that existed before this) has nothing to look for, and
 * this is then a no-op: no listing, no latency.
 *
 * Server-side only (it imports the former names, which no page has a use for).
 */
import { DATAROOM_FOLDER_IDS, FOLDER, type DataroomFolderId } from "./dataroom-folders.ts";
import { LEGACY_DATAROOM_FOLDERS } from "./legacy-dataroom-folders.generated.ts";

export interface StrandedFolder {
  /** The domain (or "uploads"). */
  id: DataroomFolderId;
  /** The folder the data room already has. */
  found: string;
  /** The folder this build would store the same domain under. */
  configured: string;
}

/** The former folder names a profile stores nothing under: only these can be left behind. */
export function unpinnedFormerFolders(
  folders: Readonly<Record<DataroomFolderId, string>> = FOLDER,
  former: Readonly<Record<DataroomFolderId, string>> = LEGACY_DATAROOM_FOLDERS,
): StrandedFolder[] {
  const inUse = new Set(DATAROOM_FOLDER_IDS.map((id) => folders[id]));
  return DATAROOM_FOLDER_IDS.filter((id) => former[id] !== folders[id] && !inUse.has(former[id])).map((id) => ({ id, found: former[id], configured: folders[id] }));
}

/** This build's: empty when its profile pins every former name. */
export const UNPINNED_FORMER_FOLDERS: readonly StrandedFolder[] = unpinnedFormerFolders();

/** The lines to add to a profile so that these folders are kept: valid JSON, to paste as it is. */
export function pinSnippet(stranded: readonly StrandedFolder[]): string {
  const domains = Object.fromEntries(stranded.filter((s) => s.id !== "uploads").map((s) => [s.id, { folder: s.found }]));
  const uploads = stranded.find((s) => s.id === "uploads");
  return JSON.stringify({ dataroom: { ...(Object.keys(domains).length ? { domains } : {}), ...(uploads ? { uploads_folder: uploads.found } : {}) } });
}

/** What to tell whoever runs this deployment, in plain words: what was found, that nothing changed, what to add. */
export function strandedMessage(where: string, stranded: readonly StrandedFolder[]): string {
  const list = stranded.map((s) => `"${s.found}/" (this build would use "${s.configured}/")`).join(", ");
  return (
    `${where} already holds files under ${list}. The profile this was built with does not say that the data room is stored ` +
    `under ${stranded.length === 1 ? "that folder" : "those folders"}, so new files would be written beside the existing ones and the existing ones would no longer be read. ` +
    `Nothing was written and nothing was moved. To keep every file where it is, add this to the profile ` +
    `(a file under profiles/, for example profiles/60-dataroom-folders.json) and build again: ${pinSnippet(stranded)}`
  );
}

/** Thrown instead of writing into a second set of folders. Nothing is written. */
export class DataroomFoldersNotPinnedError extends Error {
  readonly stranded: readonly StrandedFolder[];
  constructor(where: string, stranded: readonly StrandedFolder[]) {
    super(strandedMessage(where, stranded));
    this.name = "DataroomFoldersNotPinnedError";
    this.stranded = stranded;
  }
}

/** Of `candidates`, the former folders that exist. `exists(name)`: does the workspace hold any file under `name/`? */
export async function findStranded(exists: (folder: string) => Promise<boolean>, candidates: readonly StrandedFolder[] = UNPINNED_FORMER_FOLDERS): Promise<StrandedFolder[]> {
  const found = await Promise.all(candidates.map(async (c) => ((await exists(c.found)) ? c : null)));
  return found.filter((c): c is StrandedFolder => c !== null);
}

const checkedWorkspaces = new Map<string, Promise<void>>();

/**
 * Before a write into `key`'s data room (once per workspace per process): refuse when it holds a former folder this
 * profile stores nothing under. A failed look (the store unreachable) is not remembered, so the next write looks
 * again; a refusal is, and every later write to that workspace is refused the same way.
 */
export function guardWorkspaceWrites(key: string, exists: (folder: string) => Promise<boolean>, candidates: readonly StrandedFolder[] = UNPINNED_FORMER_FOLDERS): Promise<void> {
  if (candidates.length === 0) return Promise.resolve();
  let pending = checkedWorkspaces.get(key);
  if (!pending) {
    pending = findStranded(exists, candidates).then((stranded) => {
      if (stranded.length) throw new DataroomFoldersNotPinnedError(`The data room of workspace "${key}"`, stranded);
    });
    checkedWorkspaces.set(key, pending);
    pending.catch((error) => {
      if (!(error instanceof DataroomFoldersNotPinnedError)) checkedWorkspaces.delete(key);
    });
  }
  return pending;
}

/** Tests only: forget what has been looked at. */
export function resetFolderGuard(): void {
  checkedWorkspaces.clear();
}

