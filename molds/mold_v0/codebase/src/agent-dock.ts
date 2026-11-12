/**
 * What the agent page's right dock and the Active runs page read (mold_v0-292, flag nested_runs; docs/agent-harness.md
 * "The agent's dock"): a workspace's programs and what they produced, as sections with live counts, and its runs as trees.
 * Read only, always inside the caller's workspace, and only the shape a console draws: never a credential or a policy.
 *
 *   sections  each program's `dock` names the section its results show under. `items` lists its typed outputs, `changes` the
 *             candidates the guardian judged, `climb` each target's measured versions in its objective space. A program
 *             with no `dock` is a section of its own; with no section declaring them, an acceptance rule brings the two built-ins
 *   runs      a root session with children, the tree, each machine's states and where it has got to, the versions it made
 *   groups    mold_v0-295: the session's top bar shows the sections as a few grouped tabs. A section's group is its `dock.group`,
 *             else its kind's (items think, climb measure, changes ship); think, measure and ship lead, an app's own follow
 *   agents    mold_v0-295: each program, child and run says which agent it is: its name and purpose (src/agent-purpose.ts)
 */
import type { Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import * as H from "./harness-sessions.js";
import { programsOn, listDockPrograms, type DockProgram } from "./programs.js";
import { atPath, type Acceptance, type DockKind, type Machine, type ProgramDock } from "./program-spec.js";
import { nestedOn, type HandleView } from "./nested-runs.js";
import type { MachineRun } from "./program-machine.js";
import { programPurpose, purposeFromWords, DEFAULT_PURPOSE, type AgentLabel, type AgentPurpose } from "./agent-purpose.js";
import { declaredProfilePurposes, profileAgent } from "./agent-profiles.js";

const { read, num, money } = H;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const needOn = () => { if (!nestedOn() || !programsOn()) throw new PackError("Nested runs are not on in this app", 404); };

/** At most this many of a workspace's latest handles and decisions are read for one answer. */
const WINDOW = 500;

export interface DockSection { id: string; label: string; sub: string; icon: string; kind: DockKind; group: string; count: number; live: boolean; attention: boolean; programs: { id: string; name: string; description: string; purpose: AgentPurpose }[] }
export interface DockGroup { id: string; label: string }
interface Declared { id: string; label: string; sub: string; icon: string; kind: DockKind; group: string; order: number; programs: DockProgram[]; dock: Map<string, ProgramDock> }

/** The built-in groups, in their order, and the group a section of each kind sits under when it names none. */
export const DOCK_GROUPS: readonly DockGroup[] = [{ id: "think", label: "Think" }, { id: "measure", label: "Measure" }, { id: "ship", label: "Ship" }];
export const GROUP_OF_KIND: Record<DockKind, string> = { items: "think", climb: "measure", changes: "ship" };
/** The groups these sections use, built-ins first, an app's own after them in the order their first section comes. */
export function dockGroups(sections: readonly Pick<Declared, "group">[]): DockGroup[] {
  const used = [...new Set(sections.map((s) => s.group))];
  const words = (id: string) => { const t = id.replace(/[_-]+/g, " "); return `${t.charAt(0).toUpperCase()}${t.slice(1)}`; };
  return [...DOCK_GROUPS.filter((g) => used.includes(g.id)), ...used.filter((id) => !DOCK_GROUPS.some((g) => g.id === id)).map((id) => ({ id, label: words(id) }))];
}

/** The sections of this workspace's programs, in their order: what the programs declare, then the built-ins nothing declared. */
export function declaredSections(programs: readonly DockProgram[]): Declared[] {
  const map = new Map<string, Declared>();
  const add = (p: DockProgram, d: Pick<ProgramDock, "section"> & Partial<ProgramDock>, fallback: { label: string; sub: string; icon: string; kind: DockKind; order: number }) => {
    const cur = map.get(d.section);
    if (cur) { if (!cur.programs.includes(p)) cur.programs.push(p); cur.dock.set(p.id, d as ProgramDock); return; }
    const kind = d.kind ?? fallback.kind;
    map.set(d.section, { id: d.section, label: d.label ?? fallback.label, sub: d.sub ?? fallback.sub, icon: d.icon ?? fallback.icon, kind, group: d.group ?? GROUP_OF_KIND[kind], order: d.order ?? fallback.order, programs: [p], dock: new Map([[p.id, d as ProgramDock]]) });
  };
  programs.forEach((p, i) => {
    const d = p.config.dock;
    if (!d) { add(p, { section: p.id }, { label: p.name, sub: "results", icon: p.config.icon, kind: "items", order: 100 + i }); return; }
    add(p, d, { label: p.name, sub: "results", icon: p.config.icon, kind: "items", order: 100 + i });
    for (const also of d.also ?? []) add(p, { ...also, section: also.section }, { label: also.label ?? also.section, sub: "", icon: p.config.icon, kind: also.kind ?? "items", order: also.order ?? 100 + i });
  });
  const judged = programs.filter((p) => p.config.acceptance);
  if (judged.length) {
    const has = (k: DockKind) => [...map.values()].some((s) => s.kind === k);
    if (!has("changes")) map.set("changes", { id: "changes", label: "Changes", sub: "changes proposed", icon: "gitPullRequest", kind: "changes", group: GROUP_OF_KIND.changes, order: 900, programs: judged, dock: new Map() });
    if (!has("climb")) map.set("climb", { id: "climb", label: "Climb", sub: "targets climbing", icon: "trendingUp", kind: "climb", group: GROUP_OF_KIND.climb, order: 901, programs: judged, dock: new Map() });
  }
  return [...map.values()].sort((a, b) => a.order - b.order);
}

interface HandleLite { id: string; root_id: string; parent_id: string; session_id: string | null; program_id: string | null; program_version: number | null; kind: string; name: string; status: string; outputs: unknown; answer: string | null; error: string | null; attention: boolean; created_at: Date; settled_at: Date | null; spent_usd: string; budget_usd: string; step_of: string | null; state_id: string | null }
interface EvalLite { id: string; root_id: string; session_id: string | null; program_id: string; program_version: number; target_kind: string; target_id: string; hypothesis: string; status: string; outcome: string | null; reasons: string[]; metrics: { n?: number; baseline_mean?: number | null; candidate_mean?: number | null; lift?: number | null; ci_low?: number | null; floors?: Record<string, number | null> }; candidate: { sha256?: string; bytes?: number; paths?: string[] }; acceptance: Acceptance; promoted_id: string | null; review_decision: string | null; created_at: Date }

const HANDLE_COLS = "id, root_id, parent_id, session_id, program_id, program_version, kind, name, status, outputs, answer, error, attention, created_at, settled_at, spent_usd, budget_usd, step_of, state_id";
const handlesOf = (q: Queryable, orgId: number, programs: readonly string[]) => q.query<HandleLite>(
  `SELECT ${HANDLE_COLS} FROM harness_children WHERE org_id = $1 AND program_id = ANY ($2::text[]) AND step_of IS NULL ORDER BY created_at DESC LIMIT ${WINDOW}`, [orgId, programs]);
const evaluationsOf = (q: Queryable, orgId: number, programs: readonly string[]) => q.query<EvalLite>(
  `SELECT id, root_id, session_id, program_id, program_version, target_kind, target_id, hypothesis, status, outcome, reasons, metrics, candidate, acceptance, promoted_id, review_decision, created_at FROM harness_evaluations WHERE org_id = $1 AND program_id = ANY ($2::text[]) ORDER BY created_at DESC LIMIT ${WINDOW}`, [orgId, programs]);

/** A settled program's results, as its section lists them: each element of its `items` list, or its outputs as one. */
function resultsOf(h: HandleLite, d: ProgramDock | undefined): { value: Record<string, unknown>; index: number }[] {
  if (h.status !== "done" || !h.outputs || typeof h.outputs !== "object") return [];
  if (d?.items) { const list = atPath(h.outputs, d.items); return Array.isArray(list) ? list.map((value, index) => ({ value: (value && typeof value === "object" ? value : { value }) as Record<string, unknown>, index })) : []; }
  return [{ value: h.outputs as Record<string, unknown>, index: 0 }];
}
const OPEN = new Set(["queued", "running"]);

/** Each program's purpose: its own, its profile's declared one, else read from it (src/agent-purpose.ts). */
async function purposesOf(programs: readonly DockProgram[]): Promise<Map<string, AgentPurpose>> {
  const declared = programs.some((p) => !p.config.purpose && p.config.agent_profile) ? await declaredProfilePurposes() : new Map<string, AgentPurpose>();
  return new Map(programs.map((p) => [p.id, programPurpose(p, p.config.agent_profile ? declared.get(p.config.agent_profile) ?? null : null)]));
}

/** The dock: every section with how many it holds and whether anything is at work in it, and the groups they sit under. Nothing while the workspace has no program. */
export async function dockSections(orgId: number): Promise<{ sections: DockSection[]; groups: DockGroup[]; live: boolean }> {
  needOn();
  const programs = await listDockPrograms();
  const sections = declaredSections(programs);
  if (!sections.length) return { sections: [], groups: [], live: false };
  const purpose = await purposesOf(programs);
  return read(async (q) => {
    const ids = programs.map((p) => p.id);
    const [handles, evaluations] = [await handlesOf(q, orgId, ids), await evaluationsOf(q, orgId, ids)];
    const out = sections.map((s): DockSection => {
      const mine = new Set(s.programs.map((p) => p.id));
      const hs = handles.filter((h) => h.program_id && mine.has(h.program_id));
      const evs = evaluations.filter((e) => mine.has(e.program_id));
      const count = s.kind === "changes" ? evs.length
        : s.kind === "climb" ? new Set(evs.map((e) => `${e.target_kind}:${e.target_id}`)).size
          : hs.reduce((t, h) => t + resultsOf(h, s.dock.get(h.program_id!)).length, 0);
      const attention = hs.some((h) => h.attention) || (s.kind !== "items" && evs.some((e) => e.outcome === "needs_review" && !e.review_decision));
      return { id: s.id, label: s.label, sub: s.sub, icon: s.icon, kind: s.kind, group: s.group, count, attention, live: hs.some((h) => OPEN.has(h.status)), programs: s.programs.map((p) => ({ id: p.id, name: p.name, description: p.description, purpose: purpose.get(p.id) ?? DEFAULT_PURPOSE })) };
    });
    return { sections: out, groups: dockGroups(sections), live: out.some((s) => s.live) };
  });
}

export interface DockItem { id: string; title: string; meta: string[]; status: string; at: string; program: string | null; purpose: AgentPurpose | null; handle: string | null; session_id: string | null; root_id: string | null; ref: string | null; error: string | null; fields: Record<string, unknown> }
export interface ClimbTarget { id: string; kind: string; program: string; axes: { metric: string; higherIsBetter: boolean; role: "objective" | "constraint"; bound: number | null }[]; points: { id: string; label: string; at: string; coords: [number | null, number | null, number | null]; values: (number | null)[]; color: string; outcome: string | null; lift: number | null; version: number | null }[]; versions: VersionLite[]; active: boolean }
export interface VersionLite { id: string; version: number; status: string; lift: number | null; applied_at: string | null; applied_ref: string | null; rolled_back_at: string | null; rollback_reason: string | null; at: string }
const OUTCOME_COLOR: Record<string, string> = { accepted: "#10b981", refused: "#ef4444", needs_review: "#f59e0b" };

const words = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

const versionsFor = async (q: Queryable, orgId: number, targetId?: string): Promise<(VersionLite & { target_id: string; target_kind: string; evaluation_id: string | null })[]> => {
  const rows = await q.query<{ id: string; target_id: string; target_kind: string; version: number; status: string; metrics: { lift?: number | null }; applied_at: Date | null; applied_ref: string | null; rolled_back_at: Date | null; rollback_reason: string | null; created_at: Date; evaluation_id: string | null }>(
    `SELECT id, target_id, target_kind, version, status, metrics, applied_at, applied_ref, rolled_back_at, rollback_reason, created_at, evaluation_id FROM harness_champions WHERE org_id = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY version`, [orgId, targetId ?? null]);
  return rows.map((c) => ({ id: c.id, target_id: c.target_id, target_kind: c.target_kind, evaluation_id: c.evaluation_id, version: c.version, status: c.status, lift: c.metrics?.lift ?? null, applied_at: iso(c.applied_at), applied_ref: c.applied_ref, rolled_back_at: iso(c.rolled_back_at), rollback_reason: c.rollback_reason, at: iso(c.created_at)! }));
};

/** One target's measured candidates in its objective space: the metric up, its first two floors across; each axis scaled to what was measured. */
export function climbOf(target: { id: string; kind: string; program: string }, evs: readonly Pick<EvalLite, "id" | "hypothesis" | "status" | "outcome" | "metrics" | "acceptance" | "created_at" | "promoted_id">[], versions: readonly VersionLite[], active: boolean): ClimbTarget {
  const newest = evs[0]?.acceptance;
  const axisNames = newest ? [newest.metric, ...(newest.floors ?? []).map((f) => f.metric)].slice(0, 3) : [];
  const decided = [...evs].filter((e) => e.status === "decided" && typeof e.metrics?.candidate_mean === "number").reverse();
  const valueOf = (e: (typeof decided)[number], i: number) => (i === 0 ? e.metrics.candidate_mean ?? null : e.metrics.floors?.[axisNames[i]!] ?? null);
  const scale = axisNames.map((_, i) => { const vs = decided.map((e) => valueOf(e, i)).filter((v): v is number => v !== null); const lo = vs.length ? Math.min(...vs) : 0, hi = vs.length ? Math.max(...vs) : 1; return { lo, span: hi - lo || 1 }; });
  const coord = (v: number | null, i: number) => (v === null ? null : (v - scale[i]!.lo) / scale[i]!.span);
  const byId = new Map(versions.map((v) => [v.id, v.version]));
  const axes = axisNames.map((metric, i) => {
    const floor = i === 0 ? undefined : newest!.floors?.[i - 1];
    const limit = floor?.min ?? floor?.max;
    return { metric, higherIsBetter: i === 0 ? newest!.direction === "maximize" : floor?.min !== undefined, role: (i === 0 ? "objective" : "constraint") as "objective" | "constraint", bound: limit === undefined ? null : Math.min(1, Math.max(0, (limit - scale[i]!.lo) / scale[i]!.span)) };
  });
  return { id: target.id, kind: target.kind, program: target.program, active, axes, versions: [...versions], points: decided.map((e, n) => {
    const values = axisNames.map((_, i) => valueOf(e, i));
    return { id: e.id, label: e.hypothesis ? e.hypothesis.slice(0, 80) : `Attempt ${n + 1}`, at: iso(e.created_at)!, values, coords: [coord(values[0] ?? null, 0), axisNames[1] ? coord(values[1] ?? null, 1) : null, axisNames[2] ? coord(values[2] ?? null, 2) : null], color: OUTCOME_COLOR[e.outcome ?? ""] ?? "#9ca3af", outcome: e.outcome, lift: e.metrics.lift ?? null, version: e.promoted_id ? byId.get(e.promoted_id) ?? null : null };
  }) };
}

/** A section's contents: its results, its changes, or its targets' climbs. */
export async function dockSection(orgId: number, sectionId: string): Promise<{ kind: DockKind; items?: DockItem[]; targets?: ClimbTarget[] }> {
  needOn();
  const programs = await listDockPrograms();
  const section = declaredSections(programs).find((s) => s.id === sectionId);
  if (!section) throw new PackError("no such section", 404);
  const ids = section.programs.map((p) => p.id);
  const name = new Map(programs.map((p) => [p.id, p.name]));
  const purpose = await purposesOf(section.programs);
  return read(async (q) => {
    if (section.kind === "items") {
      const hs = await handlesOf(q, orgId, ids);
      const refs = await refsOf(q, orgId, hs.map((h) => h.root_id));
      const items: DockItem[] = [];
      for (const h of hs) {
        const d = section.dock.get(h.program_id!);
        const base = { program: name.get(h.program_id!) ?? h.program_id, purpose: purpose.get(h.program_id!) ?? null, handle: h.id, session_id: h.session_id, root_id: h.root_id, ref: refs.get(h.root_id) ?? null, at: iso(h.settled_at ?? h.created_at)! };
        if (h.status !== "done") { items.push({ ...base, id: h.id, title: h.name, meta: [], status: h.status, error: h.error, fields: {} }); continue; }
        for (const r of resultsOf(h, d)) items.push({ ...base, id: `${h.id}:${r.index}`, title: words(d?.title ? atPath(r.value, d.title) : undefined) || h.answer?.slice(0, 120) || h.name, meta: (d?.meta ?? []).map((m) => words(atPath(r.value, m))).filter(Boolean), status: "done", error: null, fields: r.value });
      }
      return { kind: section.kind, items };
    }
    const evs = await evaluationsOf(q, orgId, ids);
    if (section.kind === "changes") {
      const refs = await refsOf(q, orgId, evs.map((e) => e.root_id));
      return { kind: section.kind, items: evs.map((e): DockItem => ({ id: e.id, title: e.hypothesis || `${e.target_kind.replace("_", " ")} ${e.target_id}`, meta: [`${e.target_kind.replace("_", " ")} ${e.target_id}`], status: e.outcome ?? "measuring", at: iso(e.created_at)!, program: name.get(e.program_id) ?? e.program_id, purpose: purpose.get(e.program_id) ?? null, handle: null, session_id: e.session_id, root_id: e.root_id, ref: refs.get(e.root_id) ?? null, error: null,
        fields: { reasons: e.reasons, metrics: e.metrics, paths: e.candidate?.paths ?? [], review: e.review_decision } })) };
    }
    const versions = await versionsFor(q, orgId);
    const groups = new Map<string, EvalLite[]>();
    for (const e of evs) { const k = `${e.target_kind}:${e.target_id}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
    const hs = await handlesOf(q, orgId, ids);
    const moving = new Set(evs.filter((e) => hs.some((h) => h.root_id === e.root_id && OPEN.has(h.status))).map((e) => `${e.target_kind}:${e.target_id}`));
    return { kind: section.kind, targets: [...groups.entries()].map(([k, list]) => climbOf({ id: list[0]!.target_id, kind: list[0]!.target_kind, program: name.get(list[0]!.program_id) ?? list[0]!.program_id }, list, versions.filter((v) => v.target_id === list[0]!.target_id && v.target_kind === list[0]!.target_kind), moving.has(k))) };
  });
}

async function refsOf(q: Queryable, orgId: number, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await q.query<{ id: string; ref: string | null }>("SELECT id, ref FROM harness_sessions WHERE org_id = $1 AND id = ANY ($2::text[])", [orgId, unique]);
  return new Map(rows.flatMap((r) => (r.ref ? [[r.id, r.ref] as [string, string]] : [])));
}

export interface ActiveRun { id: string; ref: string | null; title: string; state: string; started_by: string | null; children: number; open: number; waiting: number; attention: boolean; programs: string[];
  /** mold_v0-295: the agent the root runs as, and each program's agent at work in its tree (its name and purpose). */
  agent: AgentLabel; agents: AgentLabel[]; budget_usd: number; spent_usd: number; children_spent_usd: number; carved_usd: number; last_activity_at: string }
/** Every root session with a child still at work, the newest first. */
export async function activeRuns(orgId: number): Promise<ActiveRun[]> {
  needOn();
  const programs = await listDockPrograms();
  const nameOf = new Map(programs.map((p) => [p.id, p.name]));
  const purpose = await purposesOf(programs);
  const out = await read(async (q) => {
    const open = await q.query<{ root_id: string }>("SELECT DISTINCT root_id FROM harness_children WHERE org_id = $1 AND settled_at IS NULL LIMIT 200", [orgId]);
    if (!open.length) return [];
    const roots = open.map((r) => r.root_id);
    const rows = await q.query<{ id: string; ref: string | null; title: string; state: string; started_by_name: string | null; budget_usd: string; spent_usd: string; children_spent_usd: string; carved_usd: string; last_activity_at: Date; profile_id: string | null; profile_version: number | null }>(
      "SELECT id, ref, title, state, started_by_name, budget_usd, spent_usd, children_spent_usd, carved_usd, last_activity_at, profile_id, profile_version FROM harness_sessions WHERE org_id = $1 AND id = ANY ($2::text[]) ORDER BY last_activity_at DESC", [orgId, roots]);
    const hs = await q.query<{ root_id: string; status: string; attention: boolean; program_id: string | null; kind: string; step_of: string | null }>("SELECT root_id, status, attention, program_id, kind, step_of FROM harness_children WHERE org_id = $1 AND root_id = ANY ($2::text[])", [orgId, roots]);
    return rows.map((r): Omit<ActiveRun, "agent"> & { profile: [string | null, number | null] } => {
      const mine = hs.filter((h) => h.root_id === r.id && h.kind !== "machine");
      const used = [...new Set(hs.filter((h) => h.root_id === r.id && h.program_id && !h.step_of).map((h) => h.program_id!))];
      return { profile: [r.profile_id, r.profile_version], agents: used.map((id) => ({ name: nameOf.get(id) ?? id, purpose: purpose.get(id) ?? DEFAULT_PURPOSE })), id: r.id, ref: r.ref, title: r.title, state: r.state, started_by: r.started_by_name, children: mine.length, open: mine.filter((h) => OPEN.has(h.status)).length, waiting: mine.filter((h) => h.status === "queued").length, attention: hs.some((h) => h.root_id === r.id && h.attention),
        programs: [...new Set(hs.filter((h) => h.root_id === r.id && h.program_id && !h.step_of).map((h) => nameOf.get(h.program_id!) ?? h.program_id!))], budget_usd: num(r.budget_usd), spent_usd: money(num(r.spent_usd)), children_spent_usd: money(num(r.children_spent_usd)), carved_usd: money(num(r.carved_usd)), last_activity_at: iso(r.last_activity_at)! };
    });
  });
  return Promise.all(out.map(async ({ profile, ...r }) => ({ ...r, agent: await profileAgent(profile[0], profile[1]) })));
}

export interface RunNode extends Pick<HandleView, "handle" | "name" | "ref" | "kind" | "program" | "state" | "status" | "settled" | "error" | "budget_usd" | "spent_usd" | "waiting" | "attention" | "session_id" | "started_at" | "settled_at"> { parent_id: string; step_of: string | null;
  /** mold_v0-295: what its agent is for: its program's, else what its name says, else its parent's. */
  purpose: AgentPurpose; graph: { states: { id: string; kind: string; entries: number; settled: boolean; running: boolean }[]; transitions: { from: string; to: string; label: string | null }[]; status: string; error: string | null; fired: number; max: number } | null }
export interface RunDetail { root: { id: string; ref: string | null; title: string; agent: AgentLabel; state: string; budget_usd: number; spent_usd: number; carved_usd: number; children_spent_usd: number; remaining_usd: number }; children: RunNode[]; decisions: { id: string; target: string; outcome: string | null; lift: number | null; hypothesis: string; reasons: string[]; at: string; promoted: boolean }[]; targets: ClimbTarget[] }

/** A machine, for its drawing: each state with how often it ran and where the run has got to. */
export function machineGraph(spec: Machine, run: MachineRun | null): NonNullable<RunNode["graph"]> {
  return { status: run?.status ?? "running", error: run?.error ?? null, fired: run?.transitions ?? 0, max: spec.max_transitions,
    states: spec.states.map((s) => ({ id: s.id, kind: s.kind ?? "agent", entries: run?.entries[s.id] ?? 0, settled: (run?.settled_seq[s.id] ?? -1) >= 0, running: !!run?.running.some((e) => e.state === s.id) })),
    transitions: spec.transitions.map((t) => ({ from: t.from, to: t.to, label: t.when ? `${t.when.output} ${t.when.op}${t.when.value !== undefined ? ` ${words(t.when.value)}` : ""}` : null })) };
}

/** One tree: its children, each machine's progress, what was decided and the versions it made. */
export async function runDetail(orgId: number, sessionId: string, actor: H.Actor): Promise<RunDetail> {
  needOn();
  const { readTree } = await import("./nested-runs.js");
  const { root, children } = await readTree(orgId, sessionId, actor);
  const rootId = root.nested?.root_id ?? root.id;
  const agent = await profileAgent(root.profile?.id ?? null, root.profile?.version ?? null);
  const programs = await listDockPrograms();
  const purpose = await purposesOf(programs);
  return read(async (q) => {
    const specs = new Map((await q.query<{ id: string; machine: { spec?: Machine } | null }>("SELECT id, machine FROM harness_children WHERE org_id = $1 AND root_id = $2 AND kind = 'machine'", [orgId, rootId])).map((m) => [m.id, m.machine?.spec]));
    const evs = await q.query<EvalLite>(`SELECT id, root_id, session_id, program_id, program_version, target_kind, target_id, hypothesis, status, outcome, reasons, metrics, candidate, acceptance, promoted_id, review_decision, created_at FROM harness_evaluations WHERE org_id = $1 AND root_id = $2 ORDER BY created_at DESC`, [orgId, rootId]);
    const versions = await versionsFor(q, orgId);
    const groups = new Map<string, EvalLite[]>();
    for (const e of evs) { const k = `${e.target_kind}:${e.target_id}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
    return {
      root: { id: root.id, ref: root.ref ?? null, title: root.title, agent, state: root.phase, budget_usd: root.budget_usd, spent_usd: root.spent_usd, carved_usd: root.nested?.carved_usd ?? 0, children_spent_usd: root.nested?.children_spent_usd ?? 0, remaining_usd: root.remaining_usd },
      children: children.map((c): RunNode => { const spec = specs.get(c.handle); return { handle: c.handle, name: c.name, ref: c.ref, kind: c.kind, program: c.program, state: c.state, status: c.status, settled: c.settled, error: c.error, budget_usd: c.budget_usd, spent_usd: c.spent_usd, waiting: c.waiting, attention: c.attention, session_id: c.session_id, started_at: c.started_at, settled_at: c.settled_at, parent_id: c.parent_id, step_of: c.step_of,
        purpose: (c.program ? purpose.get(c.program) : null) ?? purposeFromWords(c.name) ?? agent.purpose, graph: spec ? machineGraph(spec, c.machine?.run ?? null) : null }; }),
      decisions: evs.map((e) => ({ id: e.id, target: `${e.target_kind.replace("_", " ")} ${e.target_id}`, outcome: e.outcome, lift: e.metrics?.lift ?? null, hypothesis: e.hypothesis, reasons: e.reasons ?? [], at: iso(e.created_at)!, promoted: !!e.promoted_id })),
      targets: [...groups.values()].map((list) => climbOf({ id: list[0]!.target_id, kind: list[0]!.target_kind, program: list[0]!.program_id }, list, versions.filter((v) => v.target_id === list[0]!.target_id && v.target_kind === list[0]!.target_kind), false)),
    };
  });
}

/** What a record's page lists: the runs that targeted it, its versions and its current champion, in one workspace or (staff) across all. */
export async function targetHistory(orgId: number | null, targetId: string): Promise<{ runs: { id: string; root_id: string; program: string; outcome: string | null; lift: number | null; hypothesis: string; at: string; workspace: string | null }[]; versions: (VersionLite & { workspace: string | null })[]; champion: number | null }> {
  needOn();
  const id = String(targetId).slice(0, 200);
  return read(async (q) => {
    const evs = await q.query<{ id: string; root_id: string; program_id: string; outcome: string | null; metrics: { lift?: number | null }; hypothesis: string; created_at: Date; slug: string | null }>(
      `/* tenant: the caller's workspace (staff: every workspace) */ SELECT e.id, e.root_id, e.program_id, e.outcome, e.metrics, e.hypothesis, e.created_at, o.slug FROM harness_evaluations e JOIN organizations o ON o.id = e.org_id WHERE e.target_id = $1 AND ($2::int IS NULL OR e.org_id = $2) ORDER BY e.created_at DESC LIMIT 100`, [id, orgId]);
    const cs = await q.query<{ id: string; version: number; status: string; metrics: { lift?: number | null }; applied_at: Date | null; applied_ref: string | null; rolled_back_at: Date | null; rollback_reason: string | null; created_at: Date; slug: string | null }>(
      `/* tenant: the caller's workspace (staff: every workspace) */ SELECT c.id, c.version, c.status, c.metrics, c.applied_at, c.applied_ref, c.rolled_back_at, c.rollback_reason, c.created_at, o.slug FROM harness_champions c JOIN organizations o ON o.id = c.org_id WHERE c.target_id = $1 AND ($2::int IS NULL OR c.org_id = $2) ORDER BY c.version DESC LIMIT 100`, [id, orgId]);
    return { runs: evs.map((e) => ({ id: e.id, root_id: e.root_id, program: e.program_id, outcome: e.outcome, lift: e.metrics?.lift ?? null, hypothesis: e.hypothesis, at: iso(e.created_at)!, workspace: orgId === null ? e.slug : null })),
      versions: cs.map((c) => ({ id: c.id, version: c.version, status: c.status, lift: c.metrics?.lift ?? null, applied_at: iso(c.applied_at), applied_ref: c.applied_ref, rolled_back_at: iso(c.rolled_back_at), rollback_reason: c.rollback_reason, at: iso(c.created_at)!, workspace: orgId === null ? c.slug : null })),
      champion: cs.find((c) => c.status === "champion")?.version ?? null };
  });
}
