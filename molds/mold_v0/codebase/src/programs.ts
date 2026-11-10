/**
 * Programs (mold_v0-291, flag nested_runs; src/program-spec.ts says what one is): staff-managed records, versioned, and
 * declarable in a pack.json. The only writer of harness_programs and harness_program_versions. Platform tables: no workspace
 * reads them (a session is told the ones it may spawn; a spawn resolves them on the server).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { agentHarnessOn } from "./agent-harness-config.js";
import { featureOn } from "./features.js";
import { parseProgram, PROGRAM_ID, PROGRAM_LIMITS, mayBeSpawnedBy, type ProgramConfig } from "./program-spec.js";

const read = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => fn(await getDb()));
const tx = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => (await getDb()).transaction(fn));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const programsOn = () => featureOn("nested_runs") && agentHarnessOn();
const needOn = () => { if (!programsOn()) throw new PackError("Programs are not on in this app", 404); };

export interface ProgramSummary { id: string; name: string; description: string; icon: string; status: "active" | "archived"; version: number; source: "staff" | "pack"; updated_by: string; updated_at: string; machine: boolean; acceptance: boolean; spawned_by: string[] }
export interface ProgramDetail extends ProgramSummary { config: ProgramConfig; versions: { version: number; note: string; by: string; at: string }[]; created_by: string; created_at: string; archived_at: string | null }
interface Row { id: string; name: string; description: string; icon: string; status: "active" | "archived"; version: number; source: "staff" | "pack"; pack_sha: string | null; created_by: string; created_at: Date; updated_by: string; updated_at: Date; archived_at: Date | null }
const COLS = "id, name, description, icon, status, version, source, pack_sha, created_by, created_at, updated_by, updated_at, archived_at";

const nameOf = (v: unknown) => { const n = typeof v === "string" ? v.trim() : ""; if (!n) throw new PackError("name: give the program a name", 400); if (n.length > PROGRAM_LIMITS.name) throw new PackError(`name: at most ${PROGRAM_LIMITS.name} characters`, 400); return n; };
const textOf = (v: unknown, what: string, max: number) => { const t = typeof v === "string" ? v.trim() : ""; if (t.length > max) throw new PackError(`${what}: at most ${max} characters`, 400); return t; };
export const programIdFromName = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "p-$1").slice(0, 40).replace(/-+$/, "");
function configOf(raw: unknown): ProgramConfig {
  const { config, problems } = parseProgram(raw, sha256);
  if (!config) throw new PackError(problems.join("; ").slice(0, 2000), 400);
  return config;
}

async function latest(q: Queryable, id: string, lock = false): Promise<Row> {
  if (!PROGRAM_ID.test(id)) throw new PackError("no such program", 404);
  const [r] = await q.query<Row>(`SELECT ${COLS} FROM harness_programs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!r) throw new PackError("no such program", 404);
  return r;
}
async function configAt(q: Queryable, id: string, version: number): Promise<ProgramConfig> {
  const [v] = await q.query<{ config: ProgramConfig }>("SELECT config FROM harness_program_versions WHERE program_id = $1 AND version = $2", [id, version]);
  if (!v) throw new PackError("no such version of that program", 404);
  return v.config;
}
const summary = (r: Row, c: ProgramConfig): ProgramSummary => ({ id: r.id, name: r.name, description: r.description, icon: r.icon, status: r.status, version: r.version, source: r.source,
  updated_by: r.updated_by, updated_at: iso(r.updated_at)!, machine: !!c.machine, acceptance: !!c.acceptance, spawned_by: c.spawned_by });

/**
 * Programs a pack.json declares (a pack's `programs`, JSON only), brought in once per process: a new one becomes version
 * 1; a declaration whose text changed adds a version, unless staff have edited that program since (theirs stands). Idempotent.
 */
let declared: Promise<void> | null = null;
export function declaredPrograms(): { id: string; name: string; description?: string; config: unknown }[] {
  return packs().flatMap((p) => ((p.definition as { programs?: { id: string; name: string; description?: string; config: unknown }[] }).programs ?? []));
}
export function syncDeclaredPrograms(): Promise<void> {
  declared ??= (async () => {
    for (const d of declaredPrograms()) {
      const config = configOf(d.config);
      const packSha = sha256(JSON.stringify({ name: d.name, description: d.description ?? "", config }));
      await tx(async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`program:${d.id}`]);
        const [r] = await q.query<Row>(`SELECT ${COLS} FROM harness_programs WHERE id = $1 FOR UPDATE`, [d.id]);
        if (!r) {
          await q.query("INSERT INTO harness_programs (id, name, description, icon, status, version, source, pack_sha, created_by, updated_by) VALUES ($1, $2, $3, $4, 'active', 1, 'pack', $5, 'the app', 'the app')",
            [d.id, d.name, textOf(d.description, "description", PROGRAM_LIMITS.description), config.icon, packSha]);
          await q.query("INSERT INTO harness_program_versions (program_id, version, config, note, created_by) VALUES ($1, 1, $2, 'declared by the app', 'the app')", [d.id, JSON.stringify(config)]);
        } else if (r.source === "pack" && r.pack_sha !== packSha) {
          await q.query("INSERT INTO harness_program_versions (program_id, version, config, note, created_by) VALUES ($1, $2, $3, 'declared by the app', 'the app')", [d.id, r.version + 1, JSON.stringify(config)]);
          await q.query("UPDATE harness_programs SET version = $2, name = $3, description = $4, icon = $5, pack_sha = $6, updated_by = 'the app', updated_at = now() WHERE id = $1",
            [d.id, r.version + 1, d.name, textOf(d.description, "description", PROGRAM_LIMITS.description), config.icon, packSha]);
        }
      });
    }
  })().catch((e) => { declared = null; throw e; });
  return declared;
}
export function forgetDeclaredProgramsForTest() { declared = null; }

export async function listPrograms(): Promise<ProgramSummary[]> {
  needOn();
  await syncDeclaredPrograms();
  return read(async (q) => {
    const rows = await q.query<Row & { config: ProgramConfig }>(`SELECT p.${COLS.split(", ").join(", p.")}, v.config FROM harness_programs p JOIN harness_program_versions v ON v.program_id = p.id AND v.version = p.version ORDER BY p.name, p.id`);
    return rows.map((r) => summary(r, r.config));
  });
}
export async function readProgram(id: string): Promise<ProgramDetail> {
  needOn();
  await syncDeclaredPrograms();
  return read(async (q) => {
    const r = await latest(q, id);
    const c = await configAt(q, id, r.version);
    const vs = await q.query<{ version: number; note: string; created_by: string; created_at: Date }>("SELECT version, note, created_by, created_at FROM harness_program_versions WHERE program_id = $1 ORDER BY version DESC", [id]);
    return { ...summary(r, c), config: c, created_by: r.created_by, created_at: iso(r.created_at)!, archived_at: iso(r.archived_at), versions: vs.map((v) => ({ version: v.version, note: v.note, by: v.created_by, at: iso(v.created_at)! })) };
  });
}
export async function readProgramVersion(id: string, version: number): Promise<{ version: number; config: ProgramConfig; note: string; by: string; at: string }> {
  needOn();
  return read(async (q) => {
    await latest(q, id);
    if (!Number.isInteger(version) || version < 1) throw new PackError("no such version of that program", 404);
    const [v] = await q.query<{ version: number; config: ProgramConfig; note: string; created_by: string; created_at: Date }>("SELECT version, config, note, created_by, created_at FROM harness_program_versions WHERE program_id = $1 AND version = $2", [id, version]);
    if (!v) throw new PackError("no such version of that program", 404);
    return { version: v.version, config: v.config, note: v.note, by: v.created_by, at: iso(v.created_at)! };
  });
}
export async function createProgram(by: string, input: { id?: unknown; name?: unknown; description?: unknown; config?: unknown; note?: unknown }): Promise<ProgramDetail> {
  needOn();
  const name = nameOf(input.name);
  const id = typeof input.id === "string" && input.id ? input.id : programIdFromName(name) || `program-${randomBytes(3).toString("hex")}`;
  if (!PROGRAM_ID.test(id)) throw new PackError("id: lowercase letters, digits and -, starting with a letter", 400);
  const config = configOf(input.config ?? {});
  await tx(async (q) => {
    const made = await q.query<{ id: string }>("INSERT INTO harness_programs (id, name, description, icon, version, source, created_by, updated_by) VALUES ($1, $2, $3, $4, 1, 'staff', $5, $5) ON CONFLICT (id) DO NOTHING RETURNING id",
      [id, name, textOf(input.description, "description", PROGRAM_LIMITS.description), config.icon, by]);
    if (!made.length) throw new PackError(`a program called ${id} already exists`, 409);
    await q.query("INSERT INTO harness_program_versions (program_id, version, config, note, created_by) VALUES ($1, 1, $2, $3, $4)", [id, JSON.stringify(config), textOf(input.note, "note", PROGRAM_LIMITS.note), by]);
  });
  return readProgram(id);
}
/** A change is the next version, against the version edited (409 when someone else saved one first). */
export async function updateProgram(by: string, id: string, input: { version?: unknown; name?: unknown; description?: unknown; config?: unknown; note?: unknown }): Promise<ProgramDetail> {
  needOn();
  const config = configOf(input.config ?? {});
  await tx(async (q) => {
    const r = await latest(q, id, true);
    if (Number(input.version) !== r.version) throw new PackError("This program was changed meanwhile: look again before saving", 409);
    const next = r.version + 1;
    await q.query("INSERT INTO harness_program_versions (program_id, version, config, note, created_by) VALUES ($1, $2, $3, $4, $5)", [id, next, JSON.stringify(config), textOf(input.note, "note", PROGRAM_LIMITS.note), by]);
    // A program staff edited is theirs from now on: the app's declaration no longer replaces it.
    await q.query("UPDATE harness_programs SET version = $2, name = $3, description = $4, icon = $5, source = 'staff', updated_by = $6, updated_at = now() WHERE id = $1",
      [id, next, input.name !== undefined ? nameOf(input.name) : r.name, input.description !== undefined ? textOf(input.description, "description", PROGRAM_LIMITS.description) : r.description, config.icon, by]);
  });
  return readProgram(id);
}
export async function setProgramArchived(by: string, id: string, archived: boolean): Promise<ProgramDetail> {
  needOn();
  await tx(async (q) => {
    await latest(q, id, true);
    await q.query("UPDATE harness_programs SET status = $2, archived_at = $3, updated_by = $4, updated_at = now() WHERE id = $1", [id, archived ? "archived" : "active", archived ? new Date() : null, by]);
  });
  return readProgram(id);
}

/** The active programs a session of this agent profile may spawn, each at its latest version. */
export async function programsForProfile(profile: string | null): Promise<{ id: string; name: string; description: string; version: number; config: ProgramConfig }[]> {
  await syncDeclaredPrograms();
  const rows = await read((q) => q.query<{ id: string; name: string; description: string; version: number; config: ProgramConfig }>(
    "SELECT p.id, p.name, p.description, p.version, v.config FROM harness_programs p JOIN harness_program_versions v ON v.program_id = p.id AND v.version = p.version WHERE p.status = 'active' ORDER BY p.name"));
  return rows.filter((r) => mayBeSpawnedBy(r.config, profile));
}
/** One program a session asks to spawn: active, and one its profile may spawn; else refused in words. */
export async function programForSpawn(id: string, profile: string | null): Promise<{ id: string; name: string; description: string; version: number; config: ProgramConfig }> {
  await syncDeclaredPrograms();
  return read(async (q) => {
    const r = await latest(q, id);
    if (r.status !== "active") throw new PackError(`The program ${id} is archived`, 409);
    const config = await configAt(q, id, r.version);
    if (!mayBeSpawnedBy(config, profile)) throw new PackError(`This session's agent profile may not spawn the program ${id}`, 403);
    return { id: r.id, name: r.name, description: r.description, version: r.version, config };
  });
}
