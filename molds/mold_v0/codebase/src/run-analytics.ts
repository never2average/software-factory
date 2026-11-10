/**
 * Run analytics, the usage tool and the home page's run and attention cards (mold_v0-260; molds/mold_v0/MOLD.md
 * "Generic gaps"). Everything here reads the runs' own rows and events, never a value of a credential or a record's
 * encrypted field:
 *
 *   runAnalytics   (flag run_analytics) a period's runs broken down by record, person, model, tool and failure reason,
 *                  with tokens by model: the spend is each run's (src/run-spend.ts RUN_USD: what it recorded, or the
 *                  gateway's live total while it runs), the tokens a harness's own report (agent_usage events: the
 *                  latest per model) else the gateway's meter by provider, the tools its tool_call and tool.<name> events,
 *                  the failure reason its error_kind and error's first words. A workspace's own (its billing managers and
 *                  owners: GET /api/analytics/runs) or every workspace's (staff: GET /api/admin/onboarding/run-analytics).
 *   usageSummary   (flag usage_tool) the MCP tool get_usage: spend, runs and tokens for a period, of the caller's own
 *                  workspace; a billing manager or owner (or an account key) the whole workspace, anyone else their own runs.
 *   recentRuns, attention   (flag overview_cards) the home page's Recent runs and Needs attention cards.
 *
 * A workspace's queries name it (org_id = $1) and run under its row-level security (withTenant); staff's run as the
 * platform and say so. A record is named only to a person whose role may read its area.
 */
import { getDb } from "./db.js";
import { RUN_USD } from "./run-spend.js";
import { modelsFromEvents, type ModelUsage } from "./run-page.js";
import { PackError, conditionHolds, type DetailCondition } from "./pack-api.js";
import { findArea, listFor, may, recordAreas, type Actor } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { packOpWithheld } from "./mcp-withheld.js";

const DAY = 86_400_000;
const MAX_RUNS = 5000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** A period: from and to (YYYY-MM-DD, UTC, both included); default the last 30 days. At most 366 days. */
export function analyticsRange(q: { from?: unknown; to?: unknown }, now = Date.now()) {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const parse = (v: unknown, name: string) => {
    if (v == null || v === "") return null;
    const s = String(v), t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
    if (!Number.isFinite(t) || day(t) !== s) throw new PackError(`${name} must be a date, YYYY-MM-DD`, 400);
    return t;
  };
  const today = Math.floor(now / DAY) * DAY;
  const to = parse(q.to, "to") ?? today, from = parse(q.from, "from") ?? to - 29 * DAY;
  if (to < from) throw new PackError("to must not be before from", 400);
  if ((to - from) / DAY > 365) throw new PackError("a period is at most 366 days", 400);
  return { from: day(from), to: day(to), start: new Date(from), end: new Date(to + DAY) };
}

interface RunLine {
  id: string; org_id: number; pack: string; kind: string; status: string; error_kind: string | null; error: string | null; requested_by: string | null;
  record_area: string | null; record_key: string | null; targets: Record<string, unknown> | null; created_at: Date; cost: number;
}
export interface AnalyticsQuery { from?: unknown; to?: unknown; kind?: unknown; status?: unknown; workspace?: unknown }
/** Who reads: one workspace (its id, the person's role and id, how people are named), or staff (null: every workspace). */
export type AnalyticsReader = { orgId: number; actor: Actor; who: (id: string | null) => string } | { orgId: null; workspaceId?: number | null };

const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];

/** A period's runs and their events, as the reader may read them. */
async function readRuns(r: AnalyticsReader, q: AnalyticsQuery) {
  const range = analyticsRange(q);
  const kind = typeof q.kind === "string" && /^[a-z][a-z0-9_]{0,62}(\/[a-z][a-z0-9_]{0,62})?$/.test(q.kind) ? q.kind : null;
  const status = typeof q.status === "string" && STATUSES.includes(q.status) ? q.status : null;
  const org = r.orgId ?? (r.workspaceId ?? null);
  const args = [org, range.start, range.end, kind, status];
  const where = `($1::int IS NULL OR r.org_id = $1) AND r.created_at >= $2 AND r.created_at < $3
    AND ($4::text IS NULL OR r.kind = $4 OR r.pack || '/' || r.kind = $4) AND ($5::text IS NULL OR r.status = $5)`;
  const go = async () => {
    const db = await getDb();
    const runs = await db.query<RunLine>(
      `/* tenant: org_id = $1 (a workspace's own; staff's read: every workspace or the one named) */ SELECT r.id, r.org_id, r.pack, r.kind, r.status, r.error_kind, r.error, r.requested_by, r.record_area, r.record_key, r.targets, r.created_at,
              ${RUN_USD}::float AS cost FROM runs r WHERE ${where} ORDER BY r.created_at DESC LIMIT ${MAX_RUNS + 1}`, args);
    const ids = runs.slice(0, MAX_RUNS).map((x) => x.id);
    const events = ids.length ? await db.query<{ run_id: string; type: string; data: unknown }>(
      `/* tenant: the events of runs read above (each of the reader's own) */ SELECT run_id, type, data FROM run_events WHERE run_id = ANY($1::text[])
          AND (type = 'agent_usage' OR type = 'tool_call' OR type LIKE 'tool.%' OR type LIKE 'tool:%') ORDER BY id`, [ids]) : [];
    const metered = ids.length ? await db.query<{ run_id: string; provider: string; requests: number; input_tokens: number; output_tokens: number; usd: number }>(
      `/* tenant: the usage of runs read above (each of the reader's own) */ SELECT run_id, provider, sum(requests)::int AS requests, sum(input_tokens)::float8 AS input_tokens,
              sum(output_tokens)::float8 AS output_tokens, sum(cost_usd)::float AS usd FROM gateway_usage WHERE run_id = ANY($1::text[]) GROUP BY run_id, provider`, [ids]) : [];
    return { runs: runs.slice(0, MAX_RUNS), more: runs.length > MAX_RUNS, events, metered };
  };
  const got = r.orgId !== null ? await withTenant(r.orgId, go) : await asPlatform(go);
  return { range, kind, status, ...got };
}

const sortBy = <T extends { runs: number; cost_usd: number }>(xs: T[]) => xs.sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs).slice(0, 25);
/** A failure's reason in a few words: its kind, then its error's first sentence (numbers and ids made general). */
export const failureReason = (r: { error_kind: string | null; error: string | null }) => {
  const kind = r.error_kind ?? "run";
  const first = (r.error ?? "").split(/[.\n]/)[0]!.replace(/\b(run|apr)_[A-Za-z0-9_-]{6,}\b/g, "<id>").replace(/\b\d[\d,.]*\b/g, "<n>").trim().slice(0, 80);
  return first ? `${kind}: ${first}` : kind;
};

/** The breakdowns of a period's runs (see the module's note). */
export async function runAnalytics(r: AnalyticsReader, q: AnalyticsQuery) {
  const { range, kind, status, runs, more, events, metered } = await readRuns(r, q);
  const add = <K extends string>(m: Map<K, { runs: number; cost_usd: number; failed: number }>, k: K, x: RunLine) => {
    const v = m.get(k) ?? { runs: 0, cost_usd: 0, failed: 0 };
    v.runs++; v.cost_usd += x.cost; if (x.status === "failed") v.failed++;
    m.set(k, v);
  };
  // Records: the one a run ran on, else its target asset; named only where the reader's role may read the area.
  const byRecord = new Map<string, { runs: number; cost_usd: number; failed: number }>();
  const byPerson = new Map<string, { runs: number; cost_usd: number; failed: number }>();
  const byKind = new Map<string, { runs: number; cost_usd: number; failed: number }>();
  const byFailure = new Map<string, { runs: number; cost_usd: number; failed: number }>();
  const byWorkspace = new Map<string, { runs: number; cost_usd: number; failed: number }>();
  const readable = (area: string) => { if (r.orgId === null) return true; const a = findArea(area); return !!a && may(a, "read", r.actor); };
  for (const x of runs) {
    const asset = x.targets?.asset as { area?: string; key?: string } | undefined;
    const rec = x.record_area && x.record_key ? { area: x.record_area, key: x.record_key } : asset?.area && asset.key ? { area: asset.area, key: asset.key } : null;
    if (rec) add(byRecord, readable(rec.area) ? `${rec.area}\u0000${rec.key}` : `${rec.area}\u0000`, x);
    add(byPerson, x.requested_by ?? "", x);
    add(byKind, `${x.pack}/${x.kind}`, x);
    if (x.status === "failed") add(byFailure, failureReason(x), x);
    if (r.orgId === null) add(byWorkspace, String(x.org_id), x);
  }
  // Tokens by model: each run's own report, else its gateway meter by provider.
  const evByRun = new Map<string, { type: string; data: unknown }[]>();
  for (const e of events) evByRun.set(e.run_id, [...(evByRun.get(e.run_id) ?? []), e]);
  const models = new Map<string, ModelUsage & { runs: number }>();
  const addModel = (u: ModelUsage) => {
    const k = u.model ?? `${u.provider ?? "unknown"} (by provider)`;
    const v = models.get(k) ?? { model: k, provider: u.provider, requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, runs: 0 };
    v.requests += u.requests; v.input_tokens += u.input_tokens; v.output_tokens += u.output_tokens; v.cost_usd += u.cost_usd; v.runs++;
    models.set(k, v);
  };
  const tools = new Map<string, { calls: number; errors: number; runs: Set<string> }>();
  for (const x of runs) {
    const ev = evByRun.get(x.id) ?? [];
    const reported = modelsFromEvents(ev.filter((e) => e.type === "agent_usage"));
    if (reported.length) reported.forEach(addModel);
    else for (const m of metered.filter((y) => y.run_id === x.id)) addModel({ model: null, provider: m.provider, requests: Number(m.requests), input_tokens: Number(m.input_tokens), output_tokens: Number(m.output_tokens), cost_usd: Number(m.usd) });
    for (const e of ev.filter((y) => y.type !== "agent_usage")) {
      const d = (e.data ?? {}) as { name?: unknown; tool?: unknown; error?: unknown };
      const name = String(d.name ?? d.tool ?? (e.type === "tool_call" ? "tool" : e.type.slice(5))).slice(0, 120);
      const t = tools.get(name) ?? { calls: 0, errors: 0, runs: new Set<string>() };
      t.calls++; if (d.error) t.errors++; t.runs.add(x.id);
      tools.set(name, t);
    }
  }
  const total = runs.reduce((n, x) => n + x.cost, 0);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, runs.filter((x) => x.status === s).length]));
  const tokens = [...models.values()].reduce((a, m) => ({ input: a.input + m.input_tokens, output: a.output + m.output_tokens }), { input: 0, output: 0 });
  // A kind in the pack's words (its declared label), else its name.
  const { findKind } = await import("./runs.js");
  const label = (k: string) => { const [p, n] = k.split("/"); return (findKind(p!, n!) as { label?: string } | null)?.label ?? n ?? k; };
  const who = r.orgId !== null ? r.who : (id: string | null) => (id ? (id.startsWith("schedule:") ? "Schedule" : id.startsWith("staff:") ? "Staff" : `Person ${id.slice(-6)}`) : "Connector key");
  // Each day of the period, zero-filled.
  const days: { day: string; runs: number; failed: number; cost_usd: number }[] = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY) days.push({ day: new Date(t).toISOString().slice(0, 10), runs: 0, failed: 0, cost_usd: 0 });
  for (const x of runs) { const d = days.find((y) => y.day === new Date(x.created_at).toISOString().slice(0, 10)); if (d) { d.runs++; d.cost_usd += x.cost; if (x.status === "failed") d.failed++; } }
  const workspaces = r.orgId === null && byWorkspace.size ? await asPlatform(async () => (await getDb()).query<{ id: number; slug: string; name: string }>(
    "/* tenant: admin-only (platform staff): the names of the workspaces whose runs are counted */ SELECT id, slug, name FROM organizations WHERE id = ANY($1::int[])", [[...byWorkspace.keys()].map(Number)])) : [];
  return {
    range: { from: range.from, to: range.to }, filters: { kind, status, workspace: r.orgId === null ? r.workspaceId ?? null : null }, more,
    totals: { runs: runs.length, ...counts, cost_usd: r6(total), input_tokens: tokens.input, output_tokens: tokens.output },
    daily: days.map((d) => ({ ...d, cost_usd: r6(d.cost_usd) })),
    kinds: sortBy([...byKind].map(([k, v]) => ({ kind: k, label: label(k), ...v, cost_usd: r6(v.cost_usd) }))),
    by_record: sortBy([...byRecord].map(([k, v]) => { const [area, key] = k.split("\u0000"); return { area: area!, key: key || null, label: key ? `${findArea(area!)?.label ?? area} · ${key}` : `${findArea(area!)?.label ?? area} (a record you may not read)`, ...v, cost_usd: r6(v.cost_usd) }; })),
    by_person: sortBy([...byPerson].map(([k, v]) => ({ person: who(k || null), ...v, cost_usd: r6(v.cost_usd) }))),
    by_model: [...models.values()].map((m) => ({ ...m, cost_usd: r6(m.cost_usd) })).sort((a, b) => b.cost_usd - a.cost_usd || b.input_tokens - a.input_tokens),
    by_tool: [...tools].map(([name, t]) => ({ tool: name, calls: t.calls, errors: t.errors, runs: t.runs.size })).sort((a, b) => b.calls - a.calls).slice(0, 25),
    by_failure: sortBy([...byFailure].map(([reason, v]) => ({ reason, ...v, cost_usd: r6(v.cost_usd) }))),
    ...(r.orgId === null ? { by_workspace: sortBy([...byWorkspace].map(([id, v]) => { const w = workspaces.find((x) => String(x.id) === id); return { workspace: w?.name ?? `Workspace ${id}`, slug: w?.slug ?? null, ...v, cost_usd: r6(v.cost_usd) }; })) } : {}),
  };
}

/**
 * The MCP tool get_usage (flag usage_tool): spend, runs and tokens for a period of the caller's own workspace. A billing
 * manager or owner, or an account key (no person), reads the whole workspace's; anyone else their own runs.
 */
export async function usageSummary(org: { orgId: number; role: string | null; userId: string | null }, q: { from?: unknown; to?: unknown }) {
  const whole = org.role === "owner" || org.role === "billing" || (!org.userId && !org.role);
  const range = analyticsRange(q);
  const rows = await withTenant(org.orgId, async () => (await getDb()).query<RunLine>(
    `/* tenant: org_id = $1 is the caller's workspace */ SELECT r.id, r.org_id, r.pack, r.kind, r.status, r.error_kind, r.error, r.requested_by, r.record_area, r.record_key, r.targets, r.created_at,
            ${RUN_USD}::float AS cost FROM runs r WHERE r.org_id = $1 AND r.created_at >= $2 AND r.created_at < $3 AND ($4::text IS NULL OR r.requested_by = $4)
      ORDER BY r.created_at DESC LIMIT ${MAX_RUNS}`, [org.orgId, range.start, range.end, whole ? null : org.userId ?? "\u0000"]));
  const ids = rows.map((x) => x.id);
  const ev = ids.length ? await withTenant(org.orgId, async () => (await getDb()).query<{ run_id: string; type: string; data: unknown }>(
    "/* tenant: the events of the caller's runs read above */ SELECT run_id, type, data FROM run_events WHERE org_id = $1 AND run_id = ANY($2::text[]) AND type = 'agent_usage' ORDER BY id", [org.orgId, ids])) : [];
  const metered = ids.length ? await withTenant(org.orgId, async () => (await getDb()).query<{ run_id: string; provider: string; input_tokens: number; output_tokens: number; usd: number; requests: number }>(
    "/* tenant: the usage of the caller's runs read above */ SELECT run_id, provider, sum(requests)::int AS requests, sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens, sum(cost_usd)::float AS usd FROM gateway_usage WHERE run_id = ANY($1::text[]) GROUP BY 1, 2", [ids])) : [];
  const models = new Map<string, { model: string; input_tokens: number; output_tokens: number; cost_usd: number }>();
  for (const id of ids) {
    const rep = modelsFromEvents(ev.filter((e) => e.run_id === id));
    const list = rep.length ? rep : metered.filter((m) => m.run_id === id).map((m) => ({ model: `${m.provider} (by provider)`, provider: m.provider, requests: m.requests, input_tokens: Number(m.input_tokens), output_tokens: Number(m.output_tokens), cost_usd: Number(m.usd) }));
    for (const u of list) {
      const k = u.model ?? "unknown";
      const v = models.get(k) ?? { model: k, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      v.input_tokens += u.input_tokens; v.output_tokens += u.output_tokens; v.cost_usd = r6(v.cost_usd + u.cost_usd);
      models.set(k, v);
    }
  }
  const by = [...models.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  return {
    period: { from: range.from, to: range.to }, scope: whole ? "workspace" : "you",
    spend_usd: r6(rows.reduce((n, x) => n + x.cost, 0)),
    runs: { total: rows.length, ...Object.fromEntries(STATUSES.map((s) => [s, rows.filter((x) => x.status === s).length])) },
    tokens: { input: by.reduce((n, m) => n + m.input_tokens, 0), output: by.reduce((n, m) => n + m.output_tokens, 0), by_model: by },
  };
}

// ---------- the home page's cards (flag overview_cards) ----------

/** The session title of each run that is a wake of an agent session (mold_v0-289: its own words, not "Agent session"). */
export async function sessionTitles(orgId: number, runIds: string[]): Promise<Map<string, string>> {
  if (!runIds.length) return new Map();
  const rows = await withTenant(orgId, async () => (await getDb()).query<{ id: string; title: string }>(
    "/* tenant: org_id = $1 is the session's workspace */ SELECT r.id, s.title FROM runs r JOIN harness_sessions s ON s.id = r.harness_session_id AND s.org_id = r.org_id WHERE r.org_id = $1 AND r.id = ANY ($2::text[])", [orgId, runIds]));
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** The workspace's latest runs, of the packs whose runs list is not withheld: kind, status, when, cost and who. */
export async function recentRuns(orgId: number, who: (id: string | null) => string, limit = 6) {
  const rows = await withTenant(orgId, async () => (await getDb()).query<{ id: string; pack: string; kind: string; status: string; created_at: Date; ended_at: Date | null; requested_by: string | null; cost: number; record_area: string | null; record_key: string | null }>(
    `/* tenant: org_id = $1 is the session's workspace */ SELECT r.id, r.pack, r.kind, r.status, r.created_at, r.ended_at, r.requested_by, r.record_area, r.record_key, r.harness_session_id, ${RUN_USD}::float AS cost
       FROM runs r WHERE r.org_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`, [orgId]));
  const titles = await sessionTitles(orgId, rows.map((x) => x.id));
  const { findKind } = await import("./runs.js");
  // An agent session is one line however many times it woke (its latest wake), and opens the session (session_id).
  const seen = new Set<string>();
  return rows.filter((x) => !packOpWithheld(x.pack, "list_runs")).filter((x) => { const s = (x as { harness_session_id?: string | null }).harness_session_id; if (!s) return true; if (seen.has(s)) return false; seen.add(s); return true; }).slice(0, limit).map((x) => ({
    session_id: (x as { harness_session_id?: string | null }).harness_session_id ?? null, id: x.id, pack: x.pack, kind: x.kind, label: titles.get(x.id) ?? (findKind(x.pack, x.kind) as { label?: string } | null)?.label ?? x.kind, status: x.status,
    created_at: new Date(x.created_at).toISOString(), ended_at: x.ended_at ? new Date(x.ended_at).toISOString() : null, cost_usd: r6(Number(x.cost)), by: who(x.requested_by),
  }));
}

/**
 * The records that need attention: those of each area whose page declares notices of tone warning or danger
 * (record_areas[].detail.notices, mold_v0-253/256) and whose condition holds now, read as the person (an area their role
 * may not read is left out), danger first, at most `limit`. At most ATTENTION_SCAN records of an area are read.
 */
export const ATTENTION_SCAN = 1000;
export async function attention(orgId: number, actor: Actor, limit = 8) {
  const out: { area: string; area_label: string; key: string; title: string | null; tone: "warning" | "danger"; notice: string; updated_at: string }[] = [];
  let more = false;
  for (const a of recordAreas()) {
    const notices = ((a as { detail?: { notices?: { when: DetailCondition; tone: string; title?: string; text: string }[] } }).detail?.notices ?? []).filter((n) => n.tone === "warning" || n.tone === "danger");
    if (!notices.length || a.scope !== "workspace" || !may(a, "read", actor)) continue;
    let after: string | undefined, read = 0;
    while (read < ATTENTION_SCAN) {
      const page = await listFor(orgId, a.name, { sort: "-updated_at", limit: 200, ...(after ? { after } : {}) }, actor);
      read += page.records.length;
      for (const rec of page.records) {
        const hit = notices.filter((n) => conditionHolds(n.when, rec.data ?? {}, (rec as { clocks?: Record<string, { status?: string }> }).clocks ?? null))
          .sort((x, y) => (x.tone === "danger" ? 0 : 1) - (y.tone === "danger" ? 0 : 1))[0];
        if (hit) out.push({ area: a.name, area_label: a.label, key: rec.key, title: rec.title, tone: hit.tone as "warning" | "danger", notice: hit.title ?? hit.text, updated_at: rec.updated_at });
      }
      if (!page.next) break;
      after = page.next;
    }
  }
  out.sort((x, y) => (x.tone === y.tone ? (y.updated_at > x.updated_at ? 1 : -1) : x.tone === "danger" ? -1 : 1));
  if (out.length > limit) more = true;
  return { records: out.slice(0, limit), total: out.length, more };
}
