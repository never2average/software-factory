/**
 * Workspace recipes (mold_v0-271, flag workspace_recipes with agent_harness; molds/mold_v0/docs/agent-harness.md
 * "Workspace recipes"): reusable bundles of files and runtime binaries an agent works with, kept by platform staff and
 * picked by an agent profile's workspace instead of files of its own.
 *
 *   a recipe    an id (lowercase words joined by -, its address /admin/recipes/<id>), a name, a description, active or
 *               archived, and its versions: each a list of files, each {path in the session's working directory, its
 *               bytes and sha256, executable or not, the upload that holds it}. A version is never changed: a change is
 *               the next version (staff's, or an agent's proposal staff accepted).
 *   an upload   one file's bytes in the object store, in parts of RECIPE_PART_BYTES (under a hosted function's 4.5 MB
 *               request limit) under recipes/uploads/<id>/<n>: started with its size, each part sent, then finished (its
 *               sha256 computed from the parts). Only a finished upload goes into a version.
 *   a proposal  "self-improvement": the agent of a session that started with a recipe writes its improved files into
 *               `.recipe-proposal/` in its working directory (files/<path> for each file changed or added, remove.txt
 *               for paths to drop, note.md for why); its wake sends them as it ends (src/agent-harness.ts). Kept as an
 *               approval request against the version the session used: staff accept it (the next version, its source
 *               the agent's session) or decline it with a reason. A proposal made against an older version than the
 *               current one is refused on accept: the recipe changed since.
 *
 * A profile picks one (src/agent-profile-spec.ts `recipe`: {id, version}, version null for the latest); a session freezes
 * the version at its start (src/harness-sessions.ts policy.recipe) and its first wake writes the files into its working
 * directory, the executable ones made executable (fetched through the worker API: src/run-routes.ts
 * /:id/agent/recipe/:n/:part). The platform's own tables (src/rls.ts NO_ACCESS): no workspace reads them.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { featureOn } from "./features.js";
import { agentHarnessOn } from "./agent-harness-config.js";
import { objectStore } from "./storage.js";

export const RECIPE_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const RECIPE_UPLOAD_ID = /^rup_[0-9a-f]{24}$/;
export const RECIPE_PROPOSAL_ID = /^rpp_[0-9a-f]{24}$/;
/** A path inside the session's working directory: relative, no `.` or `..` segment, up to 16 deep. */
export const RECIPE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+){0,15}$/;
/** One part of an upload: 4 MiB, under a hosted function's request limit. */
export const RECIPE_PART_BYTES = 4 * 1024 * 1024;
export const RECIPE_LIMITS = { name: 80, description: 500, note: 4000, reason: 1000, files: 500, path: 400 } as const;
/** The most bytes one file may have (AGENT_RECIPE_FILE_MAX_MB, default 512) and a version in all (four times that). */
export const recipeFileMax = () => Math.max(1, Number(process.env.AGENT_RECIPE_FILE_MAX_MB ?? 512) || 512) * 1024 * 1024;
export const recipeVersionMax = () => recipeFileMax() * 4;
/** The directory in a session's working directory an agent writes its proposed version into. */
export const PROPOSAL_DIR = ".recipe-proposal";

export interface RecipeFile { path: string; upload: string; bytes: number; sha256: string; executable: boolean }
export type RecipeStatus = "active" | "archived";
export interface RecipeSummary {
  id: string; name: string; description: string; status: RecipeStatus; version: number; files: number; bytes: number;
  pending_proposals: number; updated_by: string; updated_at: string;
}
export interface RecipeVersionView { version: number; files: RecipeFile[]; note: string; source: "staff" | "agent"; proposal: string | null; by: string; at: string }
export interface ProposalView {
  id: string; recipe: string; recipe_name: string; base_version: number; status: "pending" | "accepted" | "declined";
  files: RecipeFile[]; changed: string[]; removed: string[]; note: string;
  /** Where it came from: the workspace (its name), the agent session and its wake. */
  workspace: string | null; session: string | null; run: string | null;
  decided_by: string | null; decided_at: string | null; reason: string | null; accepted_version: number | null; at: string;
  /** Accepting it now would be refused: the recipe has a newer version than the one it was made against. */
  stale: boolean;
}
export interface RecipeDetail extends RecipeSummary { created_by: string; created_at: string; archived_at: string | null; versions: RecipeVersionView[]; proposals: ProposalView[] }

const read = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => fn(await getDb()));
const tx = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => (await getDb()).transaction(fn));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const hexId = (p: string) => `${p}_${randomBytes(12).toString("hex")}`;

/** Recipes are part of the build: the flag on (the staff Records group lists them) and the workspace agent on. */
export const recipesOn = () => featureOn("workspace_recipes") && agentHarnessOn();
const needOn = () => { if (!recipesOn()) throw new PackError("Workspace recipes are not on in this app", 404); };

// ---------------------------------------------------------------- uploads

const partKey = (id: string, n: number) => `recipes/uploads/${id}/${String(n).padStart(5, "0")}`;
const partsOf = (bytes: number) => Math.max(1, Math.ceil(bytes / RECIPE_PART_BYTES));
const partSize = (bytes: number, n: number, parts: number) => (n < parts ? RECIPE_PART_BYTES : bytes - (parts - 1) * RECIPE_PART_BYTES);
interface UploadRow { id: string; bytes: string | number; parts: number; sha256: string | null; completed_at: Date | null }
async function uploadRow(q: Queryable, id: string): Promise<UploadRow> {
  if (!RECIPE_UPLOAD_ID.test(id)) throw new PackError("no such upload", 404);
  const [r] = await q.query<UploadRow>("SELECT id, bytes, parts, sha256, completed_at FROM workspace_recipe_uploads WHERE id = $1", [id]);
  if (!r) throw new PackError("no such upload", 404);
  return r;
}

/** Start an upload of one file of `bytes` bytes: its id and how to send it (its parts, each RECIPE_PART_BYTES but the last). */
export async function startUpload(by: string, raw: unknown): Promise<{ id: string; bytes: number; parts: number; part_bytes: number }> {
  needOn();
  const bytes = Number((raw as { bytes?: unknown } | null)?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new PackError("bytes: the file's size in bytes", 400);
  if (bytes > recipeFileMax()) throw new PackError(`a recipe's file is at most ${Math.floor(recipeFileMax() / 1048576)} MB`, 413);
  const id = hexId("rup"), parts = partsOf(bytes);
  await tx((q) => q.query("INSERT INTO workspace_recipe_uploads (id, bytes, parts, created_by) VALUES ($1, $2, $3, $4)", [id, bytes, parts, by]));
  return { id, bytes, parts, part_bytes: RECIPE_PART_BYTES };
}

/** One part (1-based) of an unfinished upload: exactly its size. Sending it again replaces it. */
export async function putUploadPart(id: string, n: number, body: Buffer): Promise<{ part: number; bytes: number }> {
  needOn();
  const r = await read((q) => uploadRow(q, id));
  if (r.completed_at) throw new PackError("this upload is finished: start another to change the file", 409);
  if (!Number.isSafeInteger(n) || n < 1 || n > r.parts) throw new PackError(`part: 1 to ${r.parts}`, 400);
  const want = partSize(Number(r.bytes), n, r.parts);
  if (body.length !== want) throw new PackError(`part ${n} is ${want} bytes, not ${body.length}`, 400);
  await (await objectStore()).put(partKey(id, n), body, "application/octet-stream");
  return { part: n, bytes: body.length };
}

/** Finish an upload: every part there and of its size; its sha256 from the parts. Finishing twice answers the same. */
export async function finishUpload(id: string): Promise<{ id: string; bytes: number; sha256: string }> {
  needOn();
  const r = await read((q) => uploadRow(q, id));
  if (r.completed_at && r.sha256) return { id, bytes: Number(r.bytes), sha256: r.sha256 };
  const store = await objectStore();
  const h = createHash("sha256");
  for (let n = 1; n <= r.parts; n++) {
    const part = await store.get(partKey(id, n));
    if (!part) throw new PackError(`part ${n} of ${r.parts} has not been sent`, 409);
    if (part.length !== partSize(Number(r.bytes), n, r.parts)) throw new PackError(`part ${n} is not the size it should be: send it again`, 409);
    h.update(part);
  }
  const sha256 = h.digest("hex");
  await tx((q) => q.query("UPDATE workspace_recipe_uploads SET sha256 = $2, completed_at = now() WHERE id = $1 AND completed_at IS NULL", [id, sha256]));
  return { id, bytes: Number(r.bytes), sha256 };
}

/** Keep `data` as a finished upload in one call (an agent's proposal; tests). */
export async function storeUpload(by: string, data: Buffer): Promise<{ id: string; bytes: number; sha256: string }> {
  if (data.length > recipeFileMax()) throw new PackError(`a recipe's file is at most ${Math.floor(recipeFileMax() / 1048576)} MB`, 413);
  const id = hexId("rup"), parts = partsOf(data.length);
  await tx((q) => q.query("INSERT INTO workspace_recipe_uploads (id, bytes, parts, created_by) VALUES ($1, $2, $3, $4)", [id, data.length, parts, by]));
  const store = await objectStore();
  for (let n = 1; n <= parts; n++) await store.put(partKey(id, n), data.subarray((n - 1) * RECIPE_PART_BYTES, n * RECIPE_PART_BYTES), "application/octet-stream");
  const sha256 = createHash("sha256").update(data).digest("hex");
  await tx((q) => q.query("UPDATE workspace_recipe_uploads SET sha256 = $2, completed_at = now() WHERE id = $1", [id, sha256]));
  return { id, bytes: data.length, sha256 };
}

/** One part of a finished upload (1-based), checked against the file's sha256 once the last part is read by readUpload. */
export async function readUploadPart(id: string, n: number): Promise<{ body: Buffer; parts: number }> {
  const r = await read((q) => uploadRow(q, id));
  if (!r.completed_at) throw new PackError("this upload is not finished", 409);
  if (!Number.isSafeInteger(n) || n < 1 || n > r.parts) throw new PackError("no such part", 404);
  const body = await (await objectStore()).get(partKey(id, n));
  if (!body) throw new PackError("the file's bytes are missing from the object store", 410);
  return { body, parts: r.parts };
}
/** A finished upload's bytes, whole and checked against its sha256. */
export async function readUpload(id: string): Promise<Buffer> {
  const first = await readUploadPart(id, 1);
  const out = [first.body];
  for (let n = 2; n <= first.parts; n++) out.push((await readUploadPart(id, n)).body);
  const data = Buffer.concat(out);
  const [r] = await read((q) => q.query<{ sha256: string }>("SELECT sha256 FROM workspace_recipe_uploads WHERE id = $1", [id]));
  if (createHash("sha256").update(data).digest("hex") !== r?.sha256) throw new PackError("the file's bytes do not match its sha256", 410);
  return data;
}

// ---------------------------------------------------------------- versions' files

/** A version's files as staff send them ({upload, path, executable}): each a finished upload, paths inside the workspace and once each. */
async function checkFiles(q: Queryable, raw: unknown): Promise<RecipeFile[]> {
  if (!Array.isArray(raw)) throw new PackError("files: a list of {upload, path, executable}", 400);
  if (raw.length > RECIPE_LIMITS.files) throw new PackError(`files: at most ${RECIPE_LIMITS.files}`, 400);
  const out: RecipeFile[] = [];
  const problems: string[] = [];
  for (const [i, f] of raw.entries()) {
    const x = (f ?? {}) as { upload?: unknown; path?: unknown; executable?: unknown };
    const path = typeof x.path === "string" ? x.path.trim() : "";
    if (!path || path.length > RECIPE_LIMITS.path || !RECIPE_FILE_PATH.test(path) || path.startsWith(`${PROPOSAL_DIR}/`) || path === PROPOSAL_DIR) { problems.push(`files[${i}].path: a path inside the session's working directory (relative, no . or .. segment, not under ${PROPOSAL_DIR})`); continue; }
    if (typeof x.upload !== "string" || !RECIPE_UPLOAD_ID.test(x.upload)) { problems.push(`files[${i}].upload: a finished upload's id`); continue; }
    const [u] = await q.query<UploadRow>("SELECT id, bytes, parts, sha256, completed_at FROM workspace_recipe_uploads WHERE id = $1", [x.upload]);
    if (!u?.completed_at || !u.sha256) { problems.push(`files[${i}] ${path}: its upload is not finished`); continue; }
    out.push({ path, upload: u.id, bytes: Number(u.bytes), sha256: u.sha256, executable: x.executable === true });
  }
  problems.push(...fileProblems(out));
  if (problems.length) throw new PackError(problems.join("; ").slice(0, 2000), 400);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
/** What a version's file list says wrongly: a path twice (case-folded), a path that is a file and a folder, too many bytes. */
export function fileProblems(files: readonly Pick<RecipeFile, "path" | "bytes">[]): string[] {
  const out: string[] = [];
  const paths = files.map((f) => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) out.push("files: two files have one path");
  const folder = paths.find((p) => paths.some((q) => q !== p && q.startsWith(`${p}/`)));
  if (folder) out.push(`files: ${folder} is a file and a folder`);
  const total = files.reduce((t, f) => t + f.bytes, 0);
  if (total > recipeVersionMax()) out.push(`files: ${Math.ceil(total / 1048576)} MB in all: a version holds at most ${Math.floor(recipeVersionMax() / 1048576)} MB`);
  return out;
}

// ---------------------------------------------------------------- recipes

interface RecipeRow { id: string; name: string; description: string; status: RecipeStatus; version: number; created_by: string; created_at: Date; updated_by: string; updated_at: Date; archived_at: Date | null }
const COLS = "id, name, description, status, version, created_by, created_at, updated_by, updated_at, archived_at";
async function rowOf(q: Queryable, id: string, lock = false): Promise<RecipeRow> {
  if (!RECIPE_ID.test(id)) throw new PackError("no such recipe", 404);
  const [r] = await q.query<RecipeRow>(`SELECT ${COLS} FROM workspace_recipes WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!r) throw new PackError("no such recipe", 404);
  return r;
}
const nameOf = (v: unknown) => {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n) throw new PackError("name: give the recipe a name", 400);
  if (n.length > RECIPE_LIMITS.name) throw new PackError(`name: at most ${RECIPE_LIMITS.name} characters`, 400);
  return n;
};
const textOf = (v: unknown, what: string, max: number) => {
  const t = typeof v === "string" ? v.trim() : "";
  if (t.length > max) throw new PackError(`${what}: at most ${max} characters`, 400);
  return t;
};
/** An id from a name: lowercase words joined by -. */
export const recipeIdFromName = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "r-$1").slice(0, 40).replace(/-+$/, "");

async function versionFiles(q: Queryable, id: string, version: number): Promise<RecipeFile[]> {
  if (version < 1) return [];
  const [v] = await q.query<{ files: RecipeFile[] }>("SELECT files FROM workspace_recipe_versions WHERE recipe_id = $1 AND version = $2", [id, version]);
  return v?.files ?? [];
}
async function addVersion(q: Queryable, r: RecipeRow, files: RecipeFile[], by: string, note: string, source: "staff" | "agent", proposal: string | null): Promise<number> {
  const v = r.version + 1;
  await q.query("INSERT INTO workspace_recipe_versions (recipe_id, version, files, note, source, proposal_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [r.id, v, JSON.stringify(files), note, source, proposal, by]);
  await q.query("UPDATE workspace_recipes SET version = $2, updated_by = $3, updated_at = now() WHERE id = $1", [r.id, v, by]);
  return v;
}

export async function listRecipes(): Promise<RecipeSummary[]> {
  needOn();
  return read(async (q) => {
    const rows = await q.query<RecipeRow & { files: RecipeFile[] | null; pending: number }>(
      `SELECT ${COLS.split(", ").map((c) => `r.${c}`).join(", ")}, v.files,
              (SELECT count(*)::int FROM workspace_recipe_proposals p WHERE p.recipe_id = r.id AND p.status = 'pending') AS pending
         FROM workspace_recipes r LEFT JOIN workspace_recipe_versions v ON v.recipe_id = r.id AND v.version = r.version
        ORDER BY r.status, lower(r.name), r.id`);
    return rows.map((r) => summary(r, r.files ?? [], r.pending));
  });
}
const summary = (r: RecipeRow, files: RecipeFile[], pending: number): RecipeSummary => ({
  id: r.id, name: r.name, description: r.description, status: r.status, version: r.version, files: files.length, bytes: files.reduce((t, f) => t + f.bytes, 0),
  pending_proposals: pending, updated_by: r.updated_by, updated_at: iso(r.updated_at)!,
});

interface ProposalRow {
  id: string; recipe_id: string; recipe_name: string; recipe_version: number; base_version: number; status: ProposalView["status"]; files: RecipeFile[]; changed: string[]; removed: string[]; note: string;
  workspace: string | null; session_id: string | null; run_id: string | null; decided_by: string | null; decided_at: Date | null; reason: string | null; accepted_version: number | null; created_at: Date;
}
const PROPOSAL_SELECT = `SELECT p.id, p.recipe_id, r.name AS recipe_name, r.version AS recipe_version, p.base_version, p.status, p.files, p.changed, p.removed, p.note,
       /* tenant: platform staff, the name of the workspace whose agent proposed it */ (SELECT o.name FROM organizations o WHERE o.id = p.proposed_by_org) AS workspace,
       p.session_id, p.run_id, p.decided_by, p.decided_at, p.reason, p.accepted_version, p.created_at
  FROM workspace_recipe_proposals p JOIN workspace_recipes r ON r.id = p.recipe_id`;
const proposalView = (p: ProposalRow): ProposalView => ({
  id: p.id, recipe: p.recipe_id, recipe_name: p.recipe_name, base_version: p.base_version, status: p.status, files: p.files, changed: p.changed, removed: p.removed, note: p.note,
  workspace: p.workspace, session: p.session_id, run: p.run_id, decided_by: p.decided_by, decided_at: iso(p.decided_at), reason: p.reason, accepted_version: p.accepted_version,
  at: iso(p.created_at)!, stale: p.status === "pending" && p.recipe_version !== p.base_version,
});

export async function readRecipe(id: string): Promise<RecipeDetail> {
  needOn();
  return read(async (q) => {
    const r = await rowOf(q, id);
    const versions = await q.query<{ version: number; files: RecipeFile[]; note: string; source: "staff" | "agent"; proposal_id: string | null; created_by: string; created_at: Date }>(
      "SELECT version, files, note, source, proposal_id, created_by, created_at FROM workspace_recipe_versions WHERE recipe_id = $1 ORDER BY version DESC", [id]);
    const proposals = (await q.query<ProposalRow>(`${PROPOSAL_SELECT} WHERE p.recipe_id = $1 ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 200`, [id])).map(proposalView);
    const current = versions.find((v) => v.version === r.version)?.files ?? [];
    return {
      ...summary(r, current, proposals.filter((p) => p.status === "pending").length), created_by: r.created_by, created_at: iso(r.created_at)!, archived_at: iso(r.archived_at),
      versions: versions.map((v) => ({ version: v.version, files: v.files, note: v.note, source: v.source, proposal: v.proposal_id, by: v.created_by, at: iso(v.created_at)! })),
      proposals,
    };
  });
}

export interface RecipeInput { id?: unknown; name?: unknown; description?: unknown; files?: unknown; note?: unknown; version?: unknown }

/** Staff: a new recipe; with files, its version 1 (else it has none until the first is saved). */
export async function createRecipe(by: string, input: RecipeInput): Promise<RecipeDetail> {
  needOn();
  const name = nameOf(input.name);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : recipeIdFromName(name);
  if (!RECIPE_ID.test(id)) throw new PackError("id: lowercase letters, digits and -, 2 to 40, starting with a letter", 400);
  const description = textOf(input.description, "description", RECIPE_LIMITS.description);
  const note = textOf(input.note, "note", RECIPE_LIMITS.note);
  await tx(async (q) => {
    const files = input.files === undefined ? null : await checkFiles(q, input.files);
    const [made] = await q.query<RecipeRow>(
      `INSERT INTO workspace_recipes (id, name, description, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) ON CONFLICT (id) DO NOTHING RETURNING ${COLS}`, [id, name, description, by]);
    if (!made) throw new PackError(`A recipe called ${id} already exists: give this one another name or id`, 409);
    if (files?.length) await addVersion(q, made, files, by, note || "The first version.", "staff", null);
  });
  return readRecipe(id);
}

/** Staff: its name and description (no new version: a version is its files). */
export async function renameRecipe(by: string, id: string, input: RecipeInput): Promise<RecipeDetail> {
  needOn();
  await tx(async (q) => {
    const r = await rowOf(q, id, true);
    const name = input.name === undefined ? r.name : nameOf(input.name);
    const description = input.description === undefined ? r.description : textOf(input.description, "description", RECIPE_LIMITS.description);
    if (name === r.name && description === r.description) throw new PackError("Nothing changed", 400);
    await q.query("UPDATE workspace_recipes SET name = $2, description = $3, updated_by = $4, updated_at = now() WHERE id = $1", [id, name, description, by]);
  });
  return readRecipe(id);
}

/** Staff: save its files as the next version. `version` is the one edited: a newer one saved meanwhile refuses (409). */
export async function saveRecipeVersion(by: string, id: string, input: RecipeInput): Promise<RecipeDetail> {
  needOn();
  const expected = Number(input.version);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new PackError("version: the version you edited (0 for a recipe with none yet)", 400);
  const note = textOf(input.note, "note", RECIPE_LIMITS.note);
  await tx(async (q) => {
    const r = await rowOf(q, id, true);
    if (r.status === "archived") throw new PackError(`${r.name} is archived: restore it before you change it`, 409);
    if (r.version !== expected) throw new PackError(`Someone saved version ${r.version} of ${r.name} while you edited version ${expected}: open it again and redo your change`, 409);
    const files = await checkFiles(q, input.files);
    if (!files.length) throw new PackError("files: a version holds at least one file", 400);
    const before = await versionFiles(q, id, r.version);
    if (sameFiles(before, files)) throw new PackError("Nothing changed: these are the files of the current version", 400);
    await addVersion(q, r, files, by, note, "staff", null);
  });
  return readRecipe(id);
}
const sameFiles = (a: readonly RecipeFile[], b: readonly RecipeFile[]) =>
  a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.sha256 === b[i]!.sha256 && f.executable === b[i]!.executable);

/** Staff: archived, no profile may pick it and no new session starts with it (a running one keeps its version). */
export async function setRecipeArchived(by: string, id: string, archived: boolean): Promise<RecipeDetail> {
  needOn();
  await tx(async (q) => {
    const r = await rowOf(q, id, true);
    if ((r.status === "archived") === archived) throw new PackError(`${r.name} is ${archived ? "archived" : "active"} already`, 409);
    await q.query("UPDATE workspace_recipes SET status = $2, archived_at = $3, updated_by = $4, updated_at = now() WHERE id = $1", [id, archived ? "archived" : "active", archived ? new Date() : null, by]);
  });
  return readRecipe(id);
}

/** One file of a version (1-based, in the version's path order), for staff to download. */
export async function recipeFile(id: string, version: number, n: number): Promise<{ file: RecipeFile; data: Buffer }> {
  needOn();
  const files = await read((q) => versionFiles(q, id, version));
  const file = files[n - 1];
  if (!file) throw new PackError("no such file", 404);
  return { file, data: await readUpload(file.upload) };
}

// ---------------------------------------------------------------- a profile's pick, a session's version

/** The problem with a profile's pick (null: none): an unknown or archived recipe, a version it does not have, one with no files. */
export async function pickProblem(pick: { id: string; version?: number | null }): Promise<string | null> {
  if (!recipesOn()) return "recipe: workspace recipes are not on in this app";
  const [r] = await read((q) => q.query<{ name: string; status: RecipeStatus; version: number }>("SELECT name, status, version FROM workspace_recipes WHERE id = $1", [pick.id]));
  if (!r) return `recipe: no recipe is called ${pick.id}`;
  if (r.status === "archived") return `recipe: ${r.name} is archived`;
  const v = pick.version ?? r.version;
  if (v < 1) return `recipe: ${r.name} has no version yet`;
  if (v > r.version) return `recipe: ${r.name} has no version ${v} (its latest is ${r.version})`;
  return null;
}

/** What a session gets of a profile's pick, frozen at its start: the recipe's name, its version and that version's files. */
export interface SessionRecipe { id: string; name: string; version: number; files: Omit<RecipeFile, "upload">[] }
export async function recipeForSession(pick: { id: string; version?: number | null }): Promise<SessionRecipe> {
  const bad = await pickProblem(pick);
  if (bad) throw new PackError(`This agent profile's ${bad.replace(/^recipe: /, "recipe: ")}: ask platform staff to fix the profile`, 409);
  return read(async (q) => {
    const r = await rowOf(q, pick.id);
    const version = pick.version ?? r.version;
    const files = await versionFiles(q, r.id, version);
    return { id: r.id, name: r.name, version, files: files.map(({ upload: _u, ...f }) => f) };
  });
}
/** One part (1-based) of file `n` (1-based) of a recipe's version, as a session's wake fetches it. */
export async function recipeFilePart(pick: { id: string; version: number }, n: number, part: number): Promise<{ body: Buffer; parts: number; file: RecipeFile }> {
  const files = await read((q) => versionFiles(q, pick.id, pick.version));
  const file = files[n - 1];
  if (!file) throw new PackError("no such file", 404);
  const p = await readUploadPart(file.upload, part);
  return { ...p, file };
}

// ---------------------------------------------------------------- proposals (an agent's improved version)

export interface ProposalInput { note: string; removed: string[]; files: { path: string; data: Buffer; executable: boolean }[] }
export interface ProposalOrigin { org_id: number; session_id: string; run_id: string; recipe: { id: string; version: number } }

/**
 * An agent's proposed next version of the recipe its session started with: its changed and added files kept as uploads,
 * the version it would make (the session's version, minus what it removes, with what it changed), pending until staff
 * decide. One pending proposal per session and recipe: a later one replaces the earlier.
 */
export async function proposeRecipeVersion(origin: ProposalOrigin, input: ProposalInput): Promise<ProposalView> {
  needOn();
  const note = textOf(input.note, "note.md", RECIPE_LIMITS.note);
  if (!note) throw new PackError("note.md: say what the proposed version changes and why", 400);
  if (!input.files.length && !input.removed.length) throw new PackError("the proposal changes nothing: put the changed files under files/ or name paths in remove.txt", 400);
  const bad = [...input.files.map((f) => f.path), ...input.removed].filter((p) => !RECIPE_FILE_PATH.test(p) || p.length > RECIPE_LIMITS.path);
  if (bad.length) throw new PackError(`not a path inside the working directory: ${bad.slice(0, 3).join(", ")}`, 400);
  const base = await read((q) => versionFiles(q, origin.recipe.id, origin.recipe.version));
  const removed = [...new Set(input.removed)].filter((p) => base.some((f) => f.path === p));
  const by = `agent session ${origin.session_id}`;
  const changed: RecipeFile[] = [];
  for (const f of input.files) {
    const before = base.find((x) => x.path === f.path);
    const sha = createHash("sha256").update(f.data).digest("hex");
    if (before && before.sha256 === sha && before.executable === f.executable) continue; // the same file: not a change
    const u = await storeUpload(by, f.data);
    changed.push({ path: f.path, upload: u.id, bytes: u.bytes, sha256: u.sha256, executable: f.executable });
  }
  if (!changed.length && !removed.length) throw new PackError("the proposal changes nothing: its files are the version's own", 400);
  const files = [...base.filter((f) => !removed.includes(f.path) && !changed.some((c) => c.path === f.path)), ...changed].sort((a, b) => a.path.localeCompare(b.path));
  const problems = fileProblems(files);
  if (!files.length) problems.push("the proposed version would hold no file");
  if (problems.length) throw new PackError(problems.join("; "), 400);
  const id = hexId("rpp");
  await tx(async (q) => {
    await q.query("UPDATE workspace_recipe_proposals SET status = 'declined', decided_by = $3, decided_at = now(), reason = 'Replaced by a later proposal of the same session.' WHERE recipe_id = $1 AND session_id = $2 AND status = 'pending'",
      [origin.recipe.id, origin.session_id, by]);
    await q.query(`INSERT INTO workspace_recipe_proposals (id, recipe_id, base_version, files, changed, removed, note, proposed_by_org, session_id, run_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, origin.recipe.id, origin.recipe.version, JSON.stringify(files), JSON.stringify(changed.map((c) => c.path)), JSON.stringify(removed), note, origin.org_id, origin.session_id, origin.run_id]);
  });
  return readProposal(id);
}

export async function readProposal(id: string): Promise<ProposalView> {
  needOn();
  if (!RECIPE_PROPOSAL_ID.test(id)) throw new PackError("no such proposal", 404);
  const [p] = await read((q) => q.query<ProposalRow>(`${PROPOSAL_SELECT} WHERE p.id = $1`, [id]));
  if (!p) throw new PackError("no such proposal", 404);
  return proposalView(p);
}
/** Every proposal waiting for a decision, oldest first (the approvals staff have to give). */
export async function pendingProposals(): Promise<ProposalView[]> {
  needOn();
  return (await read((q) => q.query<ProposalRow>(`${PROPOSAL_SELECT} WHERE p.status = 'pending' ORDER BY p.created_at LIMIT 500`))).map(proposalView);
}

/** Staff decide a proposal: accept (the recipe's next version, its source the agent) or decline with a reason. */
export async function decideProposal(by: string, id: string, accept: boolean, raw: unknown): Promise<ProposalView> {
  needOn();
  if (!RECIPE_PROPOSAL_ID.test(id)) throw new PackError("no such proposal", 404);
  const body = (raw ?? {}) as { reason?: unknown; note?: unknown };
  const reason = textOf(body.reason, "reason", RECIPE_LIMITS.reason);
  if (!accept && !reason) throw new PackError("reason: say why it is declined (the history keeps it)", 400);
  await tx(async (q) => {
    const [p] = await q.query<{ recipe_id: string; base_version: number; status: string; files: RecipeFile[]; note: string; session_id: string | null }>(
      "SELECT recipe_id, base_version, status, files, note, session_id FROM workspace_recipe_proposals WHERE id = $1 FOR UPDATE", [id]);
    if (!p) throw new PackError("no such proposal", 404);
    if (p.status !== "pending") throw new PackError(`This proposal was ${p.status} already`, 409);
    if (!accept) {
      await q.query("UPDATE workspace_recipe_proposals SET status = 'declined', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1", [id, by, reason]);
      return;
    }
    const r = await rowOf(q, p.recipe_id, true);
    if (r.status === "archived") throw new PackError(`${r.name} is archived: restore it before you accept a proposal`, 409);
    if (r.version !== p.base_version) throw new PackError(`${r.name} is at version ${r.version} now, and this proposal was made against version ${p.base_version}: decline it (the agent's next session can propose again from the current version)`, 409);
    const note = textOf(body.note, "note", RECIPE_LIMITS.note) || `Proposed by the agent (session ${p.session_id ?? "?"}): ${p.note}`.slice(0, RECIPE_LIMITS.note);
    const v = await addVersion(q, r, p.files, by, note, "agent", id);
    await q.query("UPDATE workspace_recipe_proposals SET status = 'accepted', decided_by = $2, decided_at = now(), reason = NULLIF($3, ''), accepted_version = $4 WHERE id = $1", [id, by, reason, v]);
  });
  return readProposal(id);
}

/** One file (1-based) of a proposal's version, for staff to review it. */
export async function proposalFile(id: string, n: number): Promise<{ file: RecipeFile; data: Buffer }> {
  const p = await readProposal(id);
  const file = p.files[n - 1];
  if (!file) throw new PackError("no such file", 404);
  return { file, data: await readUpload(file.upload) };
}
