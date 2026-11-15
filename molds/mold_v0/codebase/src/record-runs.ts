/**
 * Records and the runs that wrote them (mold_v0-310; MOLD.md "Records and the runs that wrote them"): from a workspace
 * record to the job run or workspace agent session that created or changed it, and from a run or a session to the records
 * it wrote. Read from what every write already keeps, plus one column beside it:
 *
 *   the writer   "<kind>:<who>" (workspace_records.written_by / updated_by, record_changes.by): a job run's own id
 *                (run:run_<id>; its workspace hook writes run:run:run_<id>), a program's result (run:program:<program>:
 *                <handle>, src/program-records.ts: the handle's child session, else the session that spawned it)
 *   the via      "run:<run id>" (sql/migrations/0071_record_runs.sql: written_via / updated_via, record_changes.via) of a
 *                workspace agent session's wake whose tool call made the write (src/http.ts marks the call): the session
 *                is that run's (runs.harness_session_id). A write that has one is linked to it before its writer
 *   no link      a person's own write, staff, an import, the email intake, a pack's route or tool outside a session, the
 *                shell: "Added by" says who, and there is no run to open
 *
 * Who sees what: every query is the workspace's own (org_id, under its row-level security). A run whose pack's MCP
 * settings withhold its status is never linked (as its page, src/run-page.ts); a session only while the agent is on (its
 * page exists); a record only when the person may read it (its area's read permission and its own visibility, getFor).
 */
import { getDb } from "./db.js";
import { PackError } from "./pack-api.js";
import { withTenant } from "./tenant-scope.js";
import type { Actor } from "./record-areas.js";

const RUN_ID = "run_[A-Za-z0-9_-]{1,80}", HANDLE_ID = "hch_[A-Za-z0-9_-]{8,40}";
const BY_RUN = new RegExp(`^run:(?:run:)?(${RUN_ID})$`), BY_PROGRAM = new RegExp(`^run:program:[^:]{0,120}:(${HANDLE_ID})$`);
const SESSION_ID = /^hss_[A-Za-z0-9_-]{8,40}$/;

/** What a writer or a via names that has a page of its own: a run (a job's, or a session's wake), a program's result. */
export type WriterRef = { run: string } | { handle: string };
export function writerRef(text: string | null | undefined): WriterRef | null {
  if (!text) return null;
  const r = BY_RUN.exec(text);
  if (r) return { run: r[1]! };
  const h = BY_PROGRAM.exec(text);
  return h ? { handle: h[1]! } : null;
}
/** A write's link: the session's wake it was made in, else its writer. */
export const writeRef = (by: string | null | undefined, via: string | null | undefined): WriterRef | null => writerRef(via) ?? writerRef(by);
const refKey = (r: WriterRef) => ("run" in r ? `run:${r.run}` : `handle:${r.handle}`);

/** A run or an agent session as a record's page links it. */
export interface RunLink {
  kind: "run" | "session";
  /** The run's id, or the session's. */
  id: string;
  /** The run's kind in words, or the session's title. */
  title: string;
  /** The run's status, or the session's state. */
  status: string;
  /** When it started. */
  at: string;
  /** Its page: /app/runs/<id>, or the agent's page with the session open. */
  href: string;
  /** A session's wake that made the write (its run page). */
  run_id?: string;
  /** A program's result: the program's name as it was spawned. */
  program?: string;
}
export const runHref = (id: string) => `/app/runs/${encodeURIComponent(id)}`;
export const sessionHref = (id: string) => `/app/agent?session=${encodeURIComponent(id)}`;
const iso = (d: Date | string) => new Date(d).toISOString();

/** Each ref's link, as the workspace's person may open it (null: nothing to open, or not theirs to see). */
export async function resolveRefs(orgId: number, refs: (WriterRef | null)[]): Promise<Map<string, RunLink | null>> {
  const out = new Map<string, RunLink | null>();
  const runIds = [...new Set(refs.flatMap((r) => (r && "run" in r ? [r.run] : [])))].slice(0, 500);
  const handleIds = [...new Set(refs.flatMap((r) => (r && "handle" in r ? [r.handle] : [])))].slice(0, 500);
  if (!runIds.length && !handleIds.length) return out;
  const { agentHarnessOn } = await import("./agent-harness-config.js");
  const { packOpWithheld } = await import("./mcp-withheld.js");
  const { findKind } = await import("./runs.js");
  const sessionsOn = agentHarnessOn();
  const db = await getDb();
  await withTenant(orgId, async () => {
    const runs = runIds.length ? await db.query<{ id: string; pack: string; kind: string; status: string; created_at: Date; harness_session_id: string | null; label: string | null }>(
      "SELECT id, pack, kind, status, created_at, harness_session_id, spec->>'label' AS label FROM runs WHERE org_id = $1 AND id = ANY ($2::text[])", [orgId, runIds]) : [];
    const handles = handleIds.length && sessionsOn ? await db.query<{ id: string; session_id: string | null; parent_id: string; name: string }>(
      "SELECT id, session_id, parent_id, name FROM harness_children WHERE org_id = $1 AND id = ANY ($2::text[])", [orgId, handleIds]) : [];
    const sessionIds = [...new Set([...runs.flatMap((r) => (r.harness_session_id ? [r.harness_session_id] : [])), ...handles.map((h) => h.session_id ?? h.parent_id)])];
    const sessions = sessionsOn && sessionIds.length ? await db.query<{ id: string; title: string; state: string; created_at: Date }>(
      "SELECT id, title, state, created_at FROM harness_sessions WHERE org_id = $1 AND id = ANY ($2::text[])", [orgId, sessionIds]) : [];
    const sessionLink = (id: string, extra: Partial<RunLink>): RunLink | null => {
      const s = sessions.find((x) => x.id === id);
      return s ? { kind: "session", id: s.id, title: s.title, status: s.state, at: iso(s.created_at), href: sessionHref(s.id), ...extra } : null;
    };
    for (const r of runs) {
      if (packOpWithheld(r.pack, "run_status")) { out.set(`run:${r.id}`, null); continue; }
      // A session's wake is the session's: its page holds the conversation the write came from (and links the run).
      const viaSession = r.harness_session_id ? sessionLink(r.harness_session_id, { run_id: r.id }) : null;
      const kind = findKind(r.pack, r.kind) as { label?: string } | null;
      out.set(`run:${r.id}`, viaSession ?? (r.harness_session_id && !sessionsOn ? null
        : { kind: "run", id: r.id, title: kind?.label ?? r.label ?? r.kind.replaceAll("_", " "), status: r.status, at: iso(r.created_at), href: runHref(r.id) }));
    }
    for (const h of handles) out.set(`handle:${h.id}`, sessionLink(h.session_id ?? h.parent_id, { program: h.name }));
  });
  return out;
}
const linkOf = (links: Map<string, RunLink | null>, r: WriterRef | null) => (r ? links.get(refKey(r)) ?? null : null);

/**
 * The run or session that made a record (from its `created` history line, else the row's first writer) and those that
 * changed it since (newest first, at most 10, the maker left out). Nothing for a record no run or session wrote.
 */
export async function recordWriters(orgId: number, area: { pack: string; name: string }, key: string): Promise<{ made: RunLink | null; changed: RunLink[] }> {
  const db = await getDb();
  const [row, lines] = await withTenant(orgId, () => Promise.all([
    db.query<{ written_by: string | null; updated_by: string | null; written_via: string | null; updated_via: string | null }>(
      "SELECT written_by, updated_by, written_via, updated_via FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4", [orgId, area.pack, area.name, key]).then((r) => r[0] ?? null),
    db.query<{ action: string; by: string | null; via: string | null }>(
      `SELECT action, by, via FROM record_changes WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND (by LIKE 'run:%' OR via IS NOT NULL)
        ORDER BY id DESC LIMIT 200`, [orgId, area.pack, area.name, key]),
  ]));
  const created = lines.find((l) => l.action === "created");
  const madeRef = created ? writeRef(created.by, created.via) : row ? writeRef(row.written_by, row.written_via) : null;
  const changedRefs = [...(row ? [writeRef(row.updated_by, row.updated_via)] : []), ...lines.filter((l) => l.action !== "created").map((l) => writeRef(l.by, l.via))];
  const links = await resolveRefs(orgId, [madeRef, ...changedRefs]);
  const made = linkOf(links, madeRef);
  const seen = new Set(made ? [`${made.kind}:${made.id}`] : []);
  const changed: RunLink[] = [];
  for (const r of changedRefs) {
    const l = linkOf(links, r);
    if (!l || seen.has(`${l.kind}:${l.id}`)) continue;
    seen.add(`${l.kind}:${l.id}`); changed.push(l);
    if (changed.length >= 10) break;
  }
  return { made, changed };
}

/** Each history line's run or session (null: a person's own change, an import, the shell...), in the lines' order. */
export async function lineLinks(orgId: number, lines: { by: string | null; via?: string | null }[]): Promise<(RunLink | null)[]> {
  const refs = lines.map((l) => writeRef(l.by, l.via ?? null));
  const links = await resolveRefs(orgId, refs);
  return refs.map((r) => linkOf(links, r));
}

/** A run's or a session's writes, before anyone's read permission: each record once, how and when it was last written. */
export interface WrittenRecord { area: string; key: string; how: ("Created" | "Changed")[]; at: string }
const likeOf = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What a job run wrote (its own writer, and the via of a session's wake), or an agent session (its wakes' via, and the
 * results of the programs it ran: a handle whose child session it is, or that it spawned). Newest first, at most 500.
 */
export async function writtenBy(orgId: number, target: { run: string } | { session: string }): Promise<WrittenRecord[]> {
  const db = await getDb();
  return withTenant(orgId, async () => {
    let by: string[] = [], via: string[] = [], like: string[] = [];
    if ("run" in target) {
      by = [`run:${target.run}`, `run:run:${target.run}`]; via = [`run:${target.run}`];
    } else {
      const wakes = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND harness_session_id = $2 ORDER BY created_at DESC LIMIT 2000", [orgId, target.session]);
      const handles = await db.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND (session_id = $2 OR parent_id = $2) ORDER BY created_at DESC LIMIT 1000", [orgId, target.session]);
      via = wakes.map((w) => `run:${w.id}`); like = handles.map((h) => `run:program:%:${likeOf(h.id)}`);
    }
    if (!by.length && !via.length && !like.length) return [];
    const mine = (col: string) => `(${col} LIKE 'run:%' AND (${col} = ANY ($2::text[]) OR ${col} LIKE ANY ($4::text[])))`;
    const [lines, rows] = await Promise.all([
      db.query<{ area: string; key: string; action: string; at: Date }>(
        `SELECT area, key, action, at FROM record_changes WHERE org_id = $1 AND (${mine("by")} OR via = ANY ($3::text[])) ORDER BY id DESC LIMIT 2000`, [orgId, by, via, like]),
      db.query<{ area: string; key: string; created: boolean; changed: boolean; updated_at: Date }>(
        `SELECT area, key, coalesce(${mine("written_by")} OR written_via = ANY ($3::text[]), false) AS created,
                coalesce(${mine("updated_by")} OR updated_via = ANY ($3::text[]), false) AS changed, updated_at
           FROM workspace_records WHERE org_id = $1 AND (${mine("written_by")} OR ${mine("updated_by")} OR written_via = ANY ($3::text[]) OR updated_via = ANY ($3::text[]))
          ORDER BY updated_at DESC LIMIT 500`, [orgId, by, via, like]),
    ]);
    const out = new Map<string, WrittenRecord & { t: number }>();
    const add = (area: string, key: string, how: "Created" | "Changed", at: Date) => {
      const k = `${area}\u0000${key}`, t = new Date(at).getTime();
      const e = out.get(k) ?? { area, key, how: [], at: iso(at), t };
      if (!e.how.includes(how)) e.how.push(how);
      if (t > e.t) { e.t = t; e.at = iso(at); }
      out.set(k, e);
    };
    for (const l of lines) if (l.action !== "deleted") add(l.area, l.key, l.action === "created" ? "Created" : "Changed", l.at);
    // A row whose latest write is the target's, past its creation, was changed by it (an area that keeps no history).
    for (const r of rows) { if (r.created) add(r.area, r.key, "Created", r.updated_at); if (r.changed && !r.created) add(r.area, r.key, "Changed", r.updated_at); }
    return [...out.values()].sort((a, b) => b.t - a.t).slice(0, 500).map(({ t: _t, ...x }) => ({ ...x, how: x.how.sort() }));
  });
}

/** Of the records a run or session wrote, those this person may read, with their titles: at most `limit` (100), and how many in all. */
export async function readableWritten(orgId: number, written: WrittenRecord[], actor: Actor, limit = 100): Promise<{ records: (WrittenRecord & { title: string | null; label: string })[]; total: number }> {
  const { findArea, getFor, may } = await import("./record-areas.js");
  const { areaOpWithheld } = await import("./mcp-withheld.js");
  const records: (WrittenRecord & { title: string | null; label: string })[] = [];
  let total = 0;
  for (const w of written) {
    const a = findArea(w.area);
    if (!a || a.scope !== "workspace" || areaOpWithheld(a.name, "get") || !may(a, "read", actor)) continue;
    // Its own visibility (a record private to someone else, a team's) and a record deleted since: not listed.
    const row = await getFor(orgId, a.name, w.key, actor).catch(() => null);
    if (!row) continue;
    total++;
    if (records.length < limit) records.push({ ...w, title: row.title ?? null, label: a.label });
  }
  return { records, total };
}

/** An agent session's records (GET /api/agent/<id>/records): the session must be this workspace's. */
export async function sessionRecords(orgId: number, sessionId: string, actor: Actor) {
  if (!SESSION_ID.test(sessionId)) throw new PackError("no such session", 404);
  const db = await getDb();
  const [s] = await withTenant(orgId, () => db.query<{ id: string }>("SELECT id FROM harness_sessions WHERE org_id = $1 AND id = $2", [orgId, sessionId]));
  if (!s) throw new PackError("no such session", 404);
  return readableWritten(orgId, await writtenBy(orgId, { session: sessionId }), actor);
}
