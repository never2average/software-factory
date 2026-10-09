/**
 * THE DATA ROOM'S FOLDER NAMES — a setting of the deployment, never a word in the code.
 *
 * The data room has seven domains and a folder for files people attach. Each domain has:
 *
 *   an ID      what code calls it (`accounts`, `platform`, `deliveries`, `solutions`, `projects`, `tickets`, `people`)
 *   a FOLDER   the name its files are STORED under: the first segment of every path in it
 *   a LABEL    what a person and the model read for it
 *
 * The folder and the label are the deployment profile's (profiles/*.json `dataroom.domains.<id>.folder` / `.label`,
 * `dataroom.uploads_folder`). The base product once wrote the folder names into the code, in the words of the one
 * line of work it was built for; every deployment then stored its files under those words. Now:
 *
 *   - a NEW deployment stores under the default profile's neutral names;
 *   - a deployment that already holds files PINS the names it has in its profile. Nothing is moved, no row is
 *     rewritten, and a path in an old transcript still resolves, because every path below is built from FOLDER.
 *
 * So base code builds a stored path as `${FOLDER.accounts}/${id}/context.md` and names a domain by its id. It never
 * spells a stored name (npm run check:neutral-names holds that; the names the folders used to have are spelled once,
 * in scripts/lib/legacy-dataroom-folders.json).
 *
 * The same name is the domain's value wherever one is stored or sent: a workbook's main sheet, the `domain` of a
 * sync or a workbook request, a ticket's `affectedSchema`. Those were always the folder's name.
 *
 * Text a person or the model reads writes a placeholder instead of a name, filled at the same boundaries as the
 * role and record words (agent/lib/agent-vocabulary.ts `fill` / `speak`, scripts/lib/profile-words.mjs):
 *
 *   {folder:accounts}   the folder in a path     `{folder:accounts}/{customer_id}/context.md`
 *   {domain:accounts}   the domain in a sentence "across {domain:accounts} and {domain:tickets}"
 *
 * Pure: plain data from the generated profile, safe in the browser, the agent and an offline script.
 */
import { DATAROOM_DOMAIN_IDS, DEPLOYMENT_PROFILE, type DataroomDomainId, type DeploymentProfile } from "./deployment-profile.generated.ts";

export { DATAROOM_DOMAIN_IDS, type DataroomDomainId };
/** A top-level folder of the data room: a domain's, or the one attached files are stored under. */
export type DataroomFolderId = DataroomDomainId | "uploads";
export const DATAROOM_FOLDER_IDS: readonly DataroomFolderId[] = [...DATAROOM_DOMAIN_IDS, "uploads"];

type FolderProfile = { dataroom: Pick<DeploymentProfile["dataroom"], "domains" | "uploads_folder"> };

/** Every top-level folder's stored name under `profile`, by id. */
export function foldersOf(profile: FolderProfile): Record<DataroomFolderId, string> {
  const out = { uploads: profile.dataroom.uploads_folder } as Record<DataroomFolderId, string>;
  for (const id of DATAROOM_DOMAIN_IDS) out[id] = profile.dataroom.domains[id].folder;
  return out;
}

/** This deployment's stored folder names: `${FOLDER.accounts}/${id}/context.md`. */
export const FOLDER: Readonly<Record<DataroomFolderId, string>> = foldersOf(DEPLOYMENT_PROFILE);

/** The seven domains' stored names, in the data model's order. */
export const DOMAIN_FOLDERS: readonly string[] = DATAROOM_DOMAIN_IDS.map((id) => FOLDER[id]);
/** Every top-level folder a data-room path may start with: the domains', then the attached files'. */
export const ROOT_FOLDERS: readonly string[] = DATAROOM_FOLDER_IDS.map((id) => FOLDER[id]);

const ID_BY_FOLDER: ReadonlyMap<string, DataroomFolderId> = new Map(DATAROOM_FOLDER_IDS.map((id) => [FOLDER[id], id]));

/** Which top-level folder a stored name is (`folderIdOf(FOLDER.tickets)` is "tickets"), or undefined. */
export function folderIdOf(name: string): DataroomFolderId | undefined {
  return ID_BY_FOLDER.get(name);
}

/** Which domain a stored name is, or undefined (the attached files' folder is not a domain). */
export function domainIdOf(name: string): DataroomDomainId | undefined {
  const id = ID_BY_FOLDER.get(name);
  return id === "uploads" ? undefined : id;
}

/** Is `name` one of this deployment's top-level data-room folders? */
export function isRootFolder(name: string): boolean {
  return ID_BY_FOLDER.has(name);
}

/** The domain a stored path is in (by its first segment), or undefined. */
export function domainOfPath(path: string): DataroomDomainId | undefined {
  return domainIdOf(path.split("/", 1)[0]);
}

/** The first segments of stored paths, as a regular-expression alternation: `(?:Accounts|Platform|…)`. */
export function folderAlternation(names: readonly string[] = ROOT_FOLDERS): string {
  return `(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
}

/**
 * A stored path under one top-level folder, as a pattern: `pathPattern("accounts", "[^/]+/context\\.md")` matches
 * `<the accounts folder>/<one segment>/context.md` and nothing else. `tail` is a regular-expression source.
 */
export function pathPattern(id: DataroomFolderId, tail: string, flags?: string): RegExp {
  return new RegExp(`^${folderAlternation([FOLDER[id]])}/${tail}$`, flags);
}

/** A domain's `Master.xlsx`, as stored. */
export function masterWorkbookPath(domain: DataroomDomainId): string {
  return `${FOLDER[domain]}/Master.xlsx`;
}

/** What a person reads for a domain: the profile's label. */
export function labelOf(domain: DataroomDomainId, profile: FolderProfile = DEPLOYMENT_PROFILE): string {
  const d = profile.dataroom.domains[domain];
  return d.label || d.folder;
}

/** May a person see this domain? (`visible: false` in the profile hides it from the browser.) */
export function isDomainVisible(domain: DataroomDomainId, profile: FolderProfile = DEPLOYMENT_PROFILE): boolean {
  return profile.dataroom.domains[domain].visible !== false;
}

// --------------------------------------------------------------------------------------------- placeholders

const PLACEHOLDER = new RegExp(`(?<!\\$)\\{(folder|domain):(${DATAROOM_FOLDER_IDS.join("|")})\\}`, "g");

/** Does this text hold a folder or domain placeholder? */
export function hasFolderPlaceholder(text: string): boolean {
  return typeof text === "string" && text.includes("{") && new RegExp(PLACEHOLDER.source).test(text);
}

/**
 * Text with each `{folder:<id>}` and `{domain:<id>}` replaced by what `word` returns for it. The default gives the
 * STORED folder and the profile's label, which is what a person reads and what an offline script writes; the
 * model-facing boundary passes its own (the folder as the model addresses it).
 */
export function fillFolders(
  text: string,
  word: (kind: "folder" | "domain", id: DataroomFolderId) => string = (kind, id) => (kind === "folder" || id === "uploads" ? FOLDER[id] : labelOf(id)),
): string {
  if (!text || !text.includes("{")) return text;
  return text.replace(PLACEHOLDER, (_m, kind: "folder" | "domain", id: DataroomFolderId) => word(kind, id));
}
