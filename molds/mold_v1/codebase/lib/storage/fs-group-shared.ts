/**
 * THE FILESYSTEM DRIVER, SHARED BY TWO SERVICE USERS (`STORAGE_FS_GROUP_SHARED=1`).
 *
 * By default the driver keeps every folder 0700 and every file 0600: the service user and nobody else. That is right
 * for one user. On a server where the web app and the agent API run as two different users (so the agent, which runs
 * model-directed work, cannot read the web app's secrets) neither can open what the other wrote, and the directory
 * cannot be shared by a group whatever its own mode is.
 *
 * With the setting on, the driver makes every folder 2770 and every file 0660: the owner and ONE group may read and
 * write, nobody else may do anything. The setgid bit on a folder is what makes it work without either service
 * changing a file's group: a file or folder created inside takes the folder's group, not its creator's own.
 * Modes are set explicitly after the create, so the service's umask can neither narrow them (a umask of 022 would
 * leave the group unable to write) nor widen them.
 *
 * Unset, none of this file runs: the driver makes the same calls with the same modes as before the setting existed.
 *
 * Because the setting hands the files to a group, it is refused at startup unless the root is set up for exactly
 * that (`groupSharedProblem`). docs/STORAGE.md, "Two service users sharing the directory", is the setup.
 */
import "./server-guard.ts";
import { readFileSync, statSync } from "node:fs";
import { StorageConfigError } from "./types.ts";

/** A folder under the root: owner and group may do everything, others nothing; new entries inherit the group. */
export const SHARED_DIR_MODE = 0o2770;
/** A file under the root: owner and group may read and write, others nothing. */
export const SHARED_FILE_MODE = 0o660;

/** STORAGE_FS_GROUP_SHARED as a boolean. Unset, empty, 0 and false are off: the driver is what it always was. */
export function groupSharedSetting(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new StorageConfigError("STORAGE_FS_GROUP_SHARED must be 1 (the web app and the agent run as two users that share STORAGE_FS_ROOT by a group) or unset.");
}

/** Who this process runs as. `groups` holds every group it may act as, the effective one included. */
export interface ProcessIdentity {
  uid: number;
  groups: readonly number[];
}

/** What /etc/passwd and /etc/group say, as far as they can be read: a server that keeps its users elsewhere has none. */
export interface SystemUsers {
  /** Every user whose primary group is `gid`, by name. */
  primaryMembers(gid: number): string[];
  groupName(gid: number): string | null;
}

/**
 * Group names that are general-purpose on a Linux server: users are put in them for other reasons, so a
 * directory shared with one is shared with all of those users.
 */
const GENERAL_PURPOSE_GROUPS = new Set(["root", "users", "staff", "wheel", "sudo", "admin", "adm", "daemon", "nogroup", "nobody", "www-data", "docker", "everyone"]);

function currentIdentity(): ProcessIdentity {
  // Not POSIX (no such calls): there are no modes to share by, and the caller is told so.
  if (typeof process.geteuid !== "function" || typeof process.getegid !== "function" || typeof process.getgroups !== "function") return { uid: -1, groups: [] };
  return { uid: process.geteuid(), groups: [process.getegid(), ...process.getgroups()] };
}

function lines(file: string): string[][] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(":"));
  } catch {
    return [];
  }
}

/** /etc/passwd and /etc/group. Read when the check runs; unreadable or absent files answer "nothing known". */
export function systemUsers(passwdFile = "/etc/passwd", groupFile = "/etc/group"): SystemUsers {
  return {
    primaryMembers: (gid) => lines(passwdFile).filter((fields) => Number(fields[3]) === gid && fields[3] !== "").map((fields) => fields[0]),
    groupName: (gid) => lines(groupFile).find((fields) => fields[2] !== "" && Number(fields[2]) === gid)?.[0] ?? null,
  };
}

const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(4, "0");

/**
 * Why this root cannot be shared by a group, in one plain sentence, or null when it can.
 *
 * The root is the only thing checked for who may reach it: every folder below is created 2770 in its group. The
 * three folders the driver keeps directly under it are checked too when they already exist, because a root that was
 * used with the setting off holds folders only one user can enter.
 */
export function groupSharedProblem(root: string, identity: ProcessIdentity = currentIdentity(), users: SystemUsers = systemUsers()): string | null {
  const SETTING = "STORAGE_FS_GROUP_SHARED is on";
  const SETUP = 'See "Two service users sharing the directory" in docs/STORAGE.md.';
  if (identity.uid < 0) return `${SETTING}, but this server has no file modes or groups to share by. Unset it.`;
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return `${SETTING}, but STORAGE_FS_ROOT does not exist (or this service's user cannot reach it). It is not created for you, because its group and mode decide who can read every file: create it for the shared group with mode 2770. ${SETUP}`;
  }
  if (!stat.isDirectory()) return `${SETTING}, but STORAGE_FS_ROOT is not a directory.`;
  const mode = stat.mode & 0o7777;
  if ((mode & 0o007) !== 0) {
    return `${SETTING}, but STORAGE_FS_ROOT is open to every user on this server (mode ${octal(mode)}). The files are for the two service users only: run \`chmod 2770\` on it. ${SETUP}`;
  }
  if (mode !== SHARED_DIR_MODE) {
    return `${SETTING}, but STORAGE_FS_ROOT has mode ${octal(mode)}. It must be exactly 2770: the owner and the group may read and write, new files take the folder's group, and nobody else may do anything. Run \`chmod 2770\` on it. ${SETUP}`;
  }
  const group = users.groupName(stat.gid);
  const named = group === null ? `group id ${stat.gid}` : `the group "${group}"`;
  if (stat.gid === 0 || (group !== null && GENERAL_PURPOSE_GROUPS.has(group))) {
    return `${SETTING}, but STORAGE_FS_ROOT belongs to ${named}, a general-purpose group that other users on a server are in: every one of them could read and change the files. Make one group for the files, with only the two service users in it. ${SETUP}`;
  }
  const primaryOf = users.primaryMembers(stat.gid);
  if (primaryOf.length > 0) {
    return `${SETTING}, but STORAGE_FS_ROOT belongs to ${named}, which is the main group of the user "${primaryOf[0]}": everything that user creates anywhere on the server carries it. Sharing by that group would give the other service that user's own files as well (its home folder, its environment file), not only these. Make one group for the files that is no user's main group, and add both service users to it. ${SETUP}`;
  }
  // root may act for any group; anyone else has to be in it.
  if (identity.uid !== 0 && !identity.groups.includes(stat.gid)) {
    return `${SETTING}, but this service's user is not in ${named}, which STORAGE_FS_ROOT belongs to: it could not share the files. Add the user to that group and restart the service (group membership is read when a service starts). ${SETUP}`;
  }
  for (const name of ["objects", "meta", "tmp"]) {
    let child;
    try {
      child = statSync(`${root}/${name}`);
    } catch {
      continue; // not created yet: the driver makes it 2770 in the root's group
    }
    if (!child.isDirectory() || (child.mode & 0o7777) !== SHARED_DIR_MODE || child.gid !== stat.gid) {
      return `${SETTING}, but STORAGE_FS_ROOT already holds a "${name}" folder that is not shared (mode ${octal(child.mode)}${child.gid === stat.gid ? "" : ", another group"}): it was created with the setting off. Convert what is there once, as docs/STORAGE.md shows under "Turning it on for a directory that already holds files".`;
    }
  }
  return null;
}

/** The last root found fit, with what its stat said then: a hot path pays one stat and reads neither /etc file. */
let accepted: string | null = null;

/**
 * Throws a StorageConfigError when the root cannot be shared by a group. Called wherever the settings are read (the
 * startup check in lib/storage/index.ts first). A refusal is never remembered, so a corrected root is seen at once.
 */
export function assertGroupSharedRoot(root: string): void {
  let key: string | null = null;
  try {
    const stat = statSync(root);
    key = [root, stat.mode, stat.uid, stat.gid, stat.ctimeMs].join("|");
  } catch {
    // Missing: groupSharedProblem says so.
  }
  if (key !== null && key === accepted) return;
  const problem = groupSharedProblem(root);
  if (problem !== null) throw new StorageConfigError(problem);
  accepted = key;
}
