/**
 * A migration rehearsal (mold_v0-142): what applying this release's pending migrations does to a database, measured
 * from the database itself, on a copy (scripts/migration-rehearsal.ts; the factory's `provision.py <app>
 * --rehearse-migrations` runs it on a temporary copy of a live database: a Neon branch, or a dump restored into a
 * scratch Postgres). Nothing here decides anything: it reads the catalogs and the rows before and after and says what
 * changed.
 *
 *   catalogStamp   every catalog row that defines a table (its pg_class row, columns, constraints, indexes, policies,
 *                  triggers and the sequences it owns), by object id and the transaction that last wrote it (xmin). Any
 *                  DDL on a table writes at least one of those rows (an ALTER, a GRANT, a policy dropped and made
 *                  again, even a no-op ENABLE ROW LEVEL SECURITY); reading it never does, nor do VACUUM and ANALYZE
 *                  (they update in place). Equal stamps: no DDL reached the table.
 *   rowStats       per table its row count and an md5 of its rows (every column, in a stable order)
 *   relationStamp  the same for every relation of the schema, to name what DDL did run (created, changed, dropped)
 */
import { createHash } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { ADOPTING_MIGRATIONS, migrationStatus, runMigrations, tableShape } from "./migrate.js";
import { rlsCatalogProblems, rlsProbe } from "./rls.js";

/** One table's defining catalog rows, as "kind oid:xmin" lines, sorted. */
export async function catalogStamp(q: Queryable, table: string): Promise<string[]> {
  const rel = (await q.query<{ oid: number }>("SELECT to_regclass('public.' || quote_ident($1))::oid::int AS oid", [table]))[0]?.oid;
  if (!rel) return [];
  const rows = await q.query<{ k: string }>(
    `SELECT 'class ' || c.oid || ':' || c.xmin AS k FROM pg_class c WHERE c.oid = $1
     UNION ALL SELECT 'attribute ' || a.attnum || ':' || a.xmin FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0
     UNION ALL SELECT 'constraint ' || k.oid || ':' || k.xmin FROM pg_constraint k WHERE k.conrelid = $1
     UNION ALL SELECT 'index ' || i.indexrelid || ':' || i.xmin || ' ' || ic.xmin FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = $1
     UNION ALL SELECT 'policy ' || p.oid || ':' || p.xmin FROM pg_policy p WHERE p.polrelid = $1
     UNION ALL SELECT 'trigger ' || g.oid || ':' || g.xmin FROM pg_trigger g WHERE g.tgrelid = $1
     UNION ALL SELECT 'default ' || d.oid || ':' || d.xmin FROM pg_attrdef d WHERE d.adrelid = $1
     UNION ALL SELECT 'sequence ' || s.oid || ':' || s.xmin FROM pg_class s JOIN pg_depend dp ON dp.objid = s.oid AND dp.classid = 'pg_class'::regclass
               AND dp.refclassid = 'pg_class'::regclass AND dp.deptype IN ('a', 'i') WHERE s.relkind = 'S' AND dp.refobjid = $1`, [rel]);
  return rows.map((r) => r.k).sort();
}

/** Every relation of the public schema (tables, indexes, sequences, views) by name, with its pg_class row's oid:xmin. */
export async function relationStamp(q: Queryable): Promise<Map<string, string>> {
  const rows = await q.query<{ n: string; k: string; s: string }>(
    "SELECT relname AS n, relkind::text AS k, oid || ':' || xmin AS s FROM pg_class WHERE relnamespace = 'public'::regnamespace");
  return new Map(rows.map((r) => [`${r.k === "r" || r.k === "p" ? "table" : r.k === "i" ? "index" : r.k === "S" ? "sequence" : r.k === "v" ? "view" : `relation(${r.k})`} ${r.n}`, r.s]));
}

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * Row count, and with `content` an md5 of its rows (each row as text, in a stable order), computed by the database: what
 * "every row intact" compares. Counting only for the rest (a copy of a live database may hold millions of rows).
 */
export async function rowStats(q: Queryable, table: string, content = true): Promise<{ rows: number; md5: string | null } | null> {
  const rel = (await q.query<{ t: string | null }>("SELECT to_regclass('public.' || quote_ident($1))::text AS t", [table]))[0]?.t;
  if (!rel) return null;
  const [r] = await q.query<{ n: number; h: string | null }>(content
    ? `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM public.${ident(table)} t`
    : `SELECT count(*)::int AS n, NULL::text AS h FROM public.${ident(table)} t`);
  return { rows: Number(r!.n), md5: r!.h };
}

export interface RehearsalReport {
  /** The pending migrations before (shell and packs), and what the runner did with each: applied, or adopted (nothing run). */
  pending: string[];
  applied: string[];
  /** Relations whose definition changed: created, changed (their pg_class row was written) or dropped. */
  ddl: { created: string[]; changed: string[]; dropped: string[] };
  /** The tables an adopting migration names (ADOPTING_MIGRATIONS), each: rows and catalog before and after. */
  adopted_tables: { table: string; rows_before: number | null; rows_after: number | null; rows_identical: boolean; catalog_unchanged: boolean; shape: "as_migration_gives" | "different" | "absent" }[];
  /** Every table that existed before whose row count changed (and, for the adopted tables, whose content changed). */
  rows_changed: { table: string; before: number; after: number | null }[];
  tables_checked: number;
  /** check:rls on the result: the catalog check and the live probe (its rows rolled back). */
  rls: { pass: boolean; problems: string[]; probe_checks: number };
  log: string[];
}

/**
 * Apply the pending migrations to `db` (a copy: this changes it) and say what happened. `dryRun` measures and lists
 * the pending migrations without applying anything.
 */
export async function rehearse(db: Db, opts: { dryRun?: boolean } = {}): Promise<RehearsalReport> {
  const before = await migrationStatus(db);
  const pending = [...before.pending.map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`),
    ...before.packs.flatMap((p) => p.pending.map((m) => `pack ${p.pack} ${String(m.version).padStart(4, "0")}_${m.name}`))];
  const adopting = [...new Set(Object.values(ADOPTING_MIGRATIONS).flatMap((a) => [...a.tables]))];
  const tables = (await db.query<{ t: string }>(
    "SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1")).map((r) => r.t);
  const rowsBefore = new Map<string, { rows: number; md5: string | null }>();
  for (const t of tables) rowsBefore.set(t, (await rowStats(db, t, adopting.includes(t)))!);
  const stampBefore = new Map<string, string[]>();
  for (const t of adopting) stampBefore.set(t, await catalogStamp(db, t));
  const relBefore = await relationStamp(db);
  const log: string[] = [];
  const applied = opts.dryRun ? [] : (await runMigrations(db, { log: (l) => log.push(l) })).applied;
  const relAfter = await relationStamp(db);
  // Each adopting migration's tables, as a group: in the shape that migration gives them, another shape, or absent.
  const shapes = new Map<string, "as_migration_gives" | "different" | "absent">();
  for (const a of Object.values(ADOPTING_MIGRATIONS)) {
    const present = (await db.query<{ t: string }>("SELECT t FROM unnest($1::text[]) t WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL", [[...a.tables]])).map((r) => r.t);
    const lines = present.length ? await tableShape(db, a.tables) : [];
    const verdict = !present.length ? "absent" as const : lines.length === a.shape.length && lines.every((x) => a.shape.includes(x)) ? "as_migration_gives" as const : "different" as const;
    for (const t of a.tables) shapes.set(t, present.includes(t) ? verdict : "absent");
  }
  const adopted_tables: RehearsalReport["adopted_tables"] = [];
  for (const t of adopting) {
    const b = rowsBefore.get(t) ?? null, a = await rowStats(db, t);
    adopted_tables.push({ table: t, rows_before: b?.rows ?? null, rows_after: a?.rows ?? null,
      rows_identical: b !== null && a !== null && b.rows === a.rows && b.md5 === a.md5,
      catalog_unchanged: JSON.stringify(stampBefore.get(t)) === JSON.stringify(await catalogStamp(db, t)) && (stampBefore.get(t)?.length ?? 0) > 0,
      shape: shapes.get(t) ?? "absent" });
  }
  const rows_changed: RehearsalReport["rows_changed"] = [];
  for (const [t, b] of rowsBefore) {
    const a = await rowStats(db, t, b.md5 !== null);
    if (!a || a.rows !== b.rows || a.md5 !== b.md5) rows_changed.push({ table: t, before: b.rows, after: a?.rows ?? null });
  }
  const ddl = {
    created: [...relAfter.keys()].filter((k) => !relBefore.has(k)).sort(),
    changed: [...relAfter.keys()].filter((k) => relBefore.has(k) && relBefore.get(k) !== relAfter.get(k)).sort(),
    dropped: [...relBefore.keys()].filter((k) => !relAfter.has(k)).sort(),
  };
  const catalog = await rlsCatalogProblems(db);
  const probe = catalog.length ? { problems: [] as string[], checked: 0 } : await rlsProbe(db);
  const problems = [...catalog, ...probe.problems];
  return { pending, applied, ddl, adopted_tables, rows_changed, tables_checked: tables.length, rls: { pass: !problems.length, problems, probe_checks: probe.checked }, log };
}
