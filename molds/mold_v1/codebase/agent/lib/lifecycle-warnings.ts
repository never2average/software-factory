/**
 * SYSTEM PATH — a READ-ONLY report of the lifecycle rules a deployment let through under enforce "warn".
 *
 * Under "warn" (records.areas.<area>.lifecycle.enforce) a move that breaks a rule goes through, and writeOutcome
 * (agent/lib/record-lifecycle-store.ts) writes two activity lines a millisecond apart, same record, same actor:
 *
 *   the move   moveEvent: `Status moved "Open" → "Cancelled": filed twice [status: open → cancelled]`
 *   the rule   warnEvent: `Lifecycle rule not followed (roles): Cancel: only owner or admin may make it. The move went
 *              through (enforce: warn).`
 *
 * Every door writes them through writeOutcome: the web routes (recordLifecycleOutcome, lib/record-lifecycle-server.ts),
 * the agent's task and record tools, the system of record. This module reads them back for the operator who decides
 * whether a deployment may go to "strict": per workspace, the warned moves (time, record, from → to, the rules, the
 * actor, the comment the move carried), counted by rule, by area and by actor, beside the number of lifecycle moves in
 * the same window (every move line, warned or not), so the share that warned is plain.
 *
 * It writes nothing: every transaction is put in read-only mode before its first read (SET TRANSACTION READ ONLY), so
 * a statement that would write fails instead. Run by scripts/operator/lifecycle-warnings.mjs as the application role.
 *
 * tenancy-ok: every tenant-table statement runs inside `db.inOrg(orgId, …)` and filters on org_id itself; the
 * workspace list is `orgs`, the control plane. Cross-workspace by construction — which is why it is a system job and
 * not a request.
 */
import { sql } from "drizzle-orm";

/** A transaction as this module uses it: raw statements only. */
export interface ReadTx {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** What the report needs of the database: the workspace list, and a transaction inside one workspace's RLS scope. */
export interface ReadOnlyGateDb {
  /** Every workspace id (the `orgs` control plane). */
  listOrgs(): Promise<string[]>;
  /** `fn` in a transaction scoped to `orgId` (withOrgDb in the agent). */
  inOrg<T>(orgId: string, fn: (tx: ReadTx) => Promise<T>): Promise<T>;
}

/** The start of every warn line (warnEvent). */
export const WARN_PREFIX = "Lifecycle rule not followed (";
const WARN_LINE = /^Lifecycle rule not followed \(([^)]*)\): ([\s\S]*?)\.? The move went through \(enforce: warn\)\.$/;
/** The marker every move line ends with (moveMarker): `[field: from → to]`, from empty on a create. */
const MARKER = /\[([^[\]:]+): ([^[\]]*?) → ([^[\]]+)\]$/;
/**
 * The same marker, as a Postgres regular expression. In a bracket a `]` first is literal, and `[:` would open a
 * character class (`[:alpha:]`), so the colon goes before the `[`.
 */
export const MARKER_SQL = "\\[[^]:[]+: [^][]* → [^][]+\\]$";
/** What precedes the marker in a move line: the move in words, the transition's label when allowed, the comment. */
const MOVE_WORDS = /^(?:[\s\S]*? created in "[^"]*"|[\s\S]*? moved "[^"]*" → "[^"]*")(?: \([^)]*\))?(?:: ([\s\S]*))?$/;

/** The activity feed's entity types, as the record areas they belong to (lib/record-area-routes.ts ENTITY). */
export const AREA_OF_ENTITY: Readonly<Record<string, string>> = { task: "tasks", cycle: "periods", deployment: "deployments", implementation: "implementations" };
export const areaOfEntity = (entityType: string): string => AREA_OF_ENTITY[entityType] ?? entityType;

export interface ParsedWarn {
  rules: string[];
  /** The broken rules in words, as the warn line says them. */
  detail: string;
}
/** A warn line's rules and words, or null for any other line. */
export function parseWarnLine(event: string): ParsedWarn | null {
  const m = WARN_LINE.exec(event);
  if (!m) return null;
  return { rules: m[1].split(",").map((s) => s.trim()).filter(Boolean), detail: m[2].trim() };
}

export interface ParsedMove {
  field: string;
  /** null on a create (`[status:  → open]`). */
  from: string | null;
  to: string;
  comment: string | null;
}
/** A move line's field, states and comment, or null for any other line. */
export function parseMoveLine(event: string): ParsedMove | null {
  const m = MARKER.exec(event);
  if (!m) return null;
  const words = event.slice(0, m.index).replace(/ $/, "");
  const c = MOVE_WORDS.exec(words);
  const comment = c?.[1]?.trim() || null;
  return { field: m[1], from: m[2] === "" ? null : m[2], to: m[3], comment };
}

export interface LifecycleWarning {
  at: string;
  orgId: string;
  area: string;
  entityType: string;
  entityId: string;
  actor: string;
  field: string | null;
  from: string | null;
  to: string | null;
  rules: string[];
  detail: string;
  comment: string | null;
}

export interface Counts {
  [key: string]: number;
}

export interface OrgLifecycleReport {
  orgId: string;
  /** Lifecycle moves in the window (every move line, warned or not). */
  moves: number;
  movesByArea: Counts;
  warnings: number;
  /** warnings / moves, 0 when there were no moves. */
  share: number;
  byRule: Counts;
  byArea: Counts;
  byActor: Counts;
  list: LifecycleWarning[];
}

export interface LifecycleWarningsReport {
  since: string;
  until: string | null;
  readOnly: true;
  orgs: OrgLifecycleReport[];
  totals: { orgs: number; moves: number; warnings: number; share: number; byRule: Counts; byArea: Counts; byActor: Counts };
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : (((r as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const bump = (c: Counts, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};
const sorted = (c: Counts): Counts => Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const share = (w: number, m: number) => (m > 0 ? Math.round((w / m) * 10000) / 10000 : 0);

/** One workspace's warned moves and lifecycle moves in [since, until). Read-only. */
export async function lifecycleWarningsIn(db: Pick<ReadOnlyGateDb, "inOrg">, orgId: string, since: Date, until: Date | null = null): Promise<OrgLifecycleReport> {
  const end = until ?? new Date("9999-12-31T00:00:00Z");
  return db.inOrg(orgId, async (tx) => {
    // Before any read: from here on this transaction cannot write.
    await tx.execute(sql`set transaction read only`);
    const moves = rowsOf(
      await tx.execute(sql`
        select entity_type, count(*)::int as n
        from entity_activity
        where org_id = ${orgId} and created_at >= ${since.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz
          and event ~ ${MARKER_SQL}
        group by entity_type
        order by entity_type`),
    );
    // Each warn line with the move line writeOutcome wrote just before it (same record, same actor, a millisecond
    // earlier; the latest move line of that record and actor within the minute before, should the clock say otherwise).
    const warned = rowsOf(
      await tx.execute(sql`
        select w.created_at, w.entity_type, w.entity_id, w.actor, w.event as warn_line, m.event as move_line
        from entity_activity w
        left join lateral (
          select m.event from entity_activity m
          where m.org_id = w.org_id and m.entity_type = w.entity_type and m.entity_id = w.entity_id and m.actor = w.actor
            and m.created_at <= w.created_at and m.created_at >= w.created_at - interval '1 minute'
            and m.event ~ ${MARKER_SQL}
          order by m.created_at desc
          limit 1
        ) m on true
        where w.org_id = ${orgId} and w.created_at >= ${since.toISOString()}::timestamptz and w.created_at < ${end.toISOString()}::timestamptz
          and w.event like ${`${WARN_PREFIX}%`}
        order by w.created_at, w.entity_id`),
    );
    const movesByArea: Counts = {};
    let total = 0;
    for (const r of moves) {
      const n = Number(r.n) || 0;
      bump(movesByArea, areaOfEntity(String(r.entity_type)), n);
      total += n;
    }
    const list: LifecycleWarning[] = [];
    const byRule: Counts = {};
    const byArea: Counts = {};
    const byActor: Counts = {};
    for (const r of warned) {
      const warn = parseWarnLine(String(r.warn_line));
      if (!warn) continue; // a line that merely starts like one
      const move = typeof r.move_line === "string" ? parseMoveLine(r.move_line) : null;
      const entityType = String(r.entity_type);
      const w: LifecycleWarning = {
        at: iso(r.created_at),
        orgId,
        area: areaOfEntity(entityType),
        entityType,
        entityId: String(r.entity_id),
        actor: String(r.actor),
        field: move?.field ?? null,
        from: move?.from ?? null,
        to: move?.to ?? null,
        rules: warn.rules,
        detail: warn.detail,
        comment: move?.comment ?? null,
      };
      list.push(w);
      for (const rule of new Set(warn.rules)) bump(byRule, rule);
      bump(byArea, w.area);
      bump(byActor, w.actor);
    }
    return { orgId, moves: total, movesByArea: sorted(movesByArea), warnings: list.length, share: share(list.length, total), byRule: sorted(byRule), byArea: sorted(byArea), byActor: sorted(byActor), list };
  });
}

/** Every workspace's report (or the named ones), and the totals. Read-only. */
export async function lifecycleWarnings(db: ReadOnlyGateDb, opts: { since: Date; until?: Date | null; orgs?: string[] | null }): Promise<LifecycleWarningsReport> {
  const all = await db.listOrgs();
  const wanted = opts.orgs?.length ? all.filter((o) => opts.orgs!.includes(o)) : all;
  const orgs: OrgLifecycleReport[] = [];
  for (const orgId of [...wanted].sort()) orgs.push(await lifecycleWarningsIn(db, orgId, opts.since, opts.until ?? null));
  const byRule: Counts = {};
  const byArea: Counts = {};
  const byActor: Counts = {};
  let moves = 0;
  let warnings = 0;
  for (const o of orgs) {
    moves += o.moves;
    warnings += o.warnings;
    for (const [k, n] of Object.entries(o.byRule)) bump(byRule, k, n);
    for (const [k, n] of Object.entries(o.byArea)) bump(byArea, k, n);
    for (const [k, n] of Object.entries(o.byActor)) bump(byActor, k, n);
  }
  return {
    since: opts.since.toISOString(),
    until: opts.until ? opts.until.toISOString() : null,
    readOnly: true,
    orgs,
    totals: { orgs: orgs.length, moves, warnings, share: share(warnings, moves), byRule: sorted(byRule), byArea: sorted(byArea), byActor: sorted(byActor) },
  };
}

const pct = (s: number) => `${(s * 100).toFixed(1)}%`;
const counts = (c: Counts) => (Object.keys(c).length ? Object.entries(c).map(([k, n]) => `${k} ${n}`).join(", ") : "none");

/** The report as the operator reads it. */
export function formatLifecycleWarnings(r: LifecycleWarningsReport): string {
  const out: string[] = [];
  out.push(`Lifecycle warnings (enforce "warn") from ${r.since}${r.until ? ` to ${r.until}` : " to now"}, ${r.totals.orgs} workspace(s).`);
  out.push(`  ${r.totals.warnings} warned move(s) of ${r.totals.moves} lifecycle move(s) (${pct(r.totals.share)}).`);
  if (r.totals.warnings) {
    out.push(`  by rule:  ${counts(r.totals.byRule)}`);
    out.push(`  by area:  ${counts(r.totals.byArea)}`);
    out.push(`  by actor: ${counts(r.totals.byActor)}`);
  }
  for (const o of r.orgs) {
    out.push("");
    out.push(`Workspace ${o.orgId}: ${o.warnings} warned of ${o.moves} move(s) (${pct(o.share)}); moves by area: ${counts(o.movesByArea)}`);
    if (!o.warnings) continue;
    out.push(`  by rule:  ${counts(o.byRule)}`);
    out.push(`  by area:  ${counts(o.byArea)}`);
    out.push(`  by actor: ${counts(o.byActor)}`);
    for (const w of o.list) {
      const move = w.to === null ? "(move line not found)" : `${w.field}: ${w.from ?? "(created)"} → ${w.to}`;
      out.push(`  ${w.at}  ${w.entityType}/${w.entityId}  ${move}  [${w.rules.join(", ")}]  by ${w.actor}`);
      out.push(`      rule: ${w.detail}`);
      if (w.comment) out.push(`      comment: ${w.comment}`);
    }
  }
  out.push("");
  out.push("Read-only: every transaction was READ ONLY; nothing was changed.");
  return out.join("\n");
}

export interface LifecycleWarningsArgs {
  since: Date;
  until: Date | null;
  orgs: string[];
  json: boolean;
}
/** The command line (`--since <ISO date> [--until <ISO date>] [--org <id>]… [--json]`), or an error to print. */
export function parseLifecycleWarningsArgs(argv: readonly string[]): LifecycleWarningsArgs | { error: string } {
  const out: LifecycleWarningsArgs = { since: new Date(NaN), until: null, orgs: [], json: false };
  const date = (flag: string, v: string | undefined): Date | string => {
    if (!v || v.startsWith("--")) return `${flag} needs an ISO date or time after it, for example ${flag} 2026-10-21`;
    if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return `${flag} ${v}: not an ISO date (2026-10-21, or 2026-10-21T05:56:00Z)`;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? `${flag} ${v}: not a date` : d;
  };
  let sawSince = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--since" || a === "--until") {
      const d = date(a, argv[++i]);
      if (typeof d === "string") return { error: d };
      if (a === "--since") {
        out.since = d;
        sawSince = true;
      } else out.until = d;
    } else if (a === "--org") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--org needs a workspace id after it" };
      out.orgs.push(v);
    } else return { error: `${a}: not an argument of this report (--since <ISO date> [--until <ISO date>] [--org <workspace id>] [--json])` };
  }
  if (!sawSince) return { error: "--since <ISO date> is required, for example --since 2026-10-21" };
  if (out.until && out.until <= out.since) return { error: "--until must be later than --since" };
  return out;
}
