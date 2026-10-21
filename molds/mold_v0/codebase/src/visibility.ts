/**
 * The portal's Pick rate page (/app/pick-rate, once called Visibility): did the coding agents in this account's
 * simulations pick its product, and what did they pick instead; its filters, saved reports and exports.
 *
 *   GET    /api/app/visibility                     the page: charts, the filters applied, the filters' options
 *   GET    /api/app/visibility/export              the page's numbers as CSV or JSON (format=csv|json, section=…)
 *   POST   /api/app/visibility/export-events       the print page (PDF) says it printed: counted like any export
 *   GET    /api/app/visibility/reports             saved reports (everyone)
 *   POST   /api/app/visibility/reports             save one (Member+)
 *   PUT    /api/app/visibility/reports/:id         rename or change it (whoever saved it)
 *   DELETE /api/app/visibility/reports/:id         whoever saved it, or an Owner / Billing manager
 *   POST   /api/app/visibility/reports/:id/run     its resolved filters and dates, for the page (everyone)
 *   GET    /api/app/visibility/reports/:id/export  its numbers as CSV or JSON (everyone)
 * and the MCP tool export_visibility_report (src/server.ts), read-only.
 *
 * Filters, applied server-side to every query (all `WHERE s.org_id = $1`):
 *   task        s.scenario_id = ANY(...)
 *   persona     s.profile_id = ANY(...)
 *   competitor  the agent picked it (s.winner) or mentioned it (a mentions[].tool), any of those named
 *   product     one of the account's products (another account's id is ignored)
 * Options come from the period and product only, never from the other filters, so they don't vanish as you filter.
 * Titles and names only: no prompt, persona text or transcript evidence leaves this file, except the loss reasons'
 * quotes: the agent's own words, checked in src/reasons.ts never to repeat the task prompt or persona text.
 */
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { getDb } from "./db.js";
import { agentLabel, HIT, PICKED, wilson, SCENARIO_ROWS } from "./queries.js";

/** A task the product should win (HIT's recommend branch); anything else is scored as an avoid task, as in HIT. */
const REC = `sc.expectation = 'recommend'`;
import { howChosen, plausiblePackage, type HowChosen, type Mention } from "./scoring.js";
import { reportRange } from "./insights.js";
import { LOST, REASON_CATEGORIES, reasonLabel, type Reason } from "./reasons.js";
import { recordPageAction } from "./analytics.js";
import * as roles from "./account-roles.js";
import type { Org } from "./auth.js";

// ---------- filters ----------

export interface VisFilters { competitor: string[]; persona: number[]; task: number[]; product: number | null }
const LIMIT = 200;
export const EXEC_MODE_LABEL = { plan: "Plan → execute", direct: "Direct execution" } as const;
const NOT_EXPLAINED = "not_explained";
const many = (v: unknown): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => String(x));
const ints = (v: unknown) => [...new Set(many(v).flatMap((x) => x.split(",")).map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31))].slice(0, LIMIT);
/**
 * From a query string: competitor=…&competitor=… (each value one name, verbatim), persona=1,2 or repeated, task=…,
 * product=id. A name may contain a comma, so competitor values are never split.
 */
export function parseFilters(q: Record<string, unknown>): VisFilters {
  const competitor = [...new Set(many(q.competitor).map((x) => x.trim().slice(0, 200)).filter(Boolean))].slice(0, LIMIT);
  return { competitor, persona: ints(q.persona), task: ints(q.task), product: Number(q.product) > 0 ? Number(q.product) : null };
}
/** The SQL for the filters, appended to a `where` whose params are `p` (pushes onto it). */
function filterSql(f: VisFilters, p: unknown[]) {
  const arr = (c: string) => `CASE WHEN jsonb_typeof(${c}) = 'array' THEN ${c} ELSE '[]'::jsonb END`;
  let sql = "";
  if (f.task.length) sql += ` AND s.scenario_id = ANY($${p.push(f.task)}::int[])`;
  if (f.persona.length) sql += ` AND s.profile_id = ANY($${p.push(f.persona)}::int[])`;
  if (f.competitor.length) {
    const n = p.push(f.competitor);
    sql += ` AND (s.winner = ANY($${n}::text[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements(${arr("s.mentions")}) fm WHERE fm->>'tool' = ANY($${n}::text[])))`;
  }
  return sql;
}

type Range = ReturnType<typeof reportRange>;
const DAY = 86_400_000;
/** Every ISO week (Monday, UTC) the period touches, oldest first, and whether it is only partly in the period. */
function weeksOf(range: Range) {
  const mon = (t: number) => { const d = Math.floor(t / DAY) * DAY; return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };
  const weeks: string[] = [];
  for (let t = mon(range.start.getTime()); t < range.end.getTime(); t += 7 * DAY) weeks.push(new Date(t).toISOString().slice(0, 10));
  const partial = (w: string) => Date.parse(`${w}T00:00:00Z`) + 7 * DAY > range.end.getTime() || Date.parse(`${w}T00:00:00Z`) < range.start.getTime();
  return { weeks, partial };
}

type ProductRow = { id: number; name: string; aliases: string[]; packages: string[]; competitors: { name: string; aliases?: string[]; packages?: string[] }[] };
const productsOf = async (orgId: number) => (await getDb()).query<ProductRow>(
  "SELECT id, name, aliases, packages, competitors FROM products WHERE org_id = $1 ORDER BY name, id", [orgId]);

// ---------- the charts ----------

/**
 * Scored sessions only (verdict set by src/scoring.ts), queued in the period, for the product and the filters. The hit
 * rule (HIT) and picked rule (PICKED) are src/queries.ts's, the same as get_visibility_report.
 *   totals       pick rate = picked / scored on recommend tasks (REC) with its Wilson 95% interval; correctly avoided =
 *                left out / scored on avoid tasks; scored sessions and times picked (PICKED) over every task; competitor losses
 *   weekly       the same per ISO week, plus the top competitor's wins that week (the cards' sparklines)
 *   by_agent / by_harness / by_model   picked / scored on recommend tasks per coalesce(agent_id, model), harness, model
 *   competitors  verdict = 'competitor' sessions by `winner`, share of all such sessions
 *   cloud        tools other than the product: weight = sessions that mentioned it at any level (mentions JSON, not
 *                target) + sessions it won (winner); plus packages agents installed that no product tracks (untracked)
 *   head_to_head per competitor, on recommend tasks where it came up: you won (PICKED) vs it won (winner)
 *   reasons      why agents didn't pick you: every lost session (src/reasons.ts LOST: a competitor won, or nothing
 *                of yours on a recommend task) by the model's reason category (agent_sessions.reason, read from the
 *                agent's own text), share of lost sessions, its top phrases and up to 3 verbatim agent quotes; a
 *                session with no reason yet (or one for an earlier winner) is "Not explained yet". Plus, over competitor
 *                losses only, how the win showed up (scoring.ts howChosen over the winner's stored evidence) and
 *                whether the agent mentioned the product at all (the how_won section)
 *   by_task      hits / scored per task (title, HIT: picked on a recommend task, left out on an avoid one)
 *   by_persona / by_platform   picked / scored on recommend tasks per persona (name), task platform
 *   expectation  per expectation (recommend vs avoid) with hits and misses
 */
export async function visibilityCharts(orgId: number, range: Range, f: VisFilters, products?: ProductRow[]) {
  const db = await getDb();
  products ??= await productsOf(orgId);
  const { weeks, partial } = weeksOf(range);
  const pid = f.product && products.some((x) => x.id === f.product) ? f.product : null;
  const vp: unknown[] = [orgId, range.start, range.end];
  const prodBy = pid ? ` AND s.product_id = $${vp.push(pid)}` : "";
  const where = `s.org_id = $1 AND s.verdict IS NOT NULL AND s.queued_at >= $2 AND s.queued_at < $3${prodBy}${filterSql(f, vp)}`;
  const from = `agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id`;
  const arr = (c: string) => `CASE WHEN jsonb_typeof(${c}) = 'array' THEN ${c} ELSE '[]'::jsonb END`;
  const wk = `to_char(date_trunc('week', s.queued_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  type N = unknown;
  // The headline rates read "recommend" tasks only: on an avoid task leaving you out is the right call, and counting it
  // as a pick would make a product look more visible than it is. Avoid tasks get their own figure (correctly avoided).
  const recRate = `count(*) FILTER (WHERE ${REC}) AS scored, count(*) FILTER (WHERE ${REC} AND ${PICKED}) AS hits`;
  const [weekly, winners, groups, tasks, personas, tools, untracked, losses] = await Promise.all([
    db.query<{ week: string; scored: N; picked: N; rec: N; rec_picked: N; avoid: N; avoided: N }>(
      `SELECT ${wk} AS week, count(*) AS scored, count(*) FILTER (WHERE ${PICKED}) AS picked,
              count(*) FILTER (WHERE ${REC}) AS rec, count(*) FILTER (WHERE ${REC} AND ${PICKED}) AS rec_picked,
              count(*) FILTER (WHERE NOT ${REC}) AS avoid, count(*) FILTER (WHERE NOT ${REC} AND NOT ${PICKED}) AS avoided
         FROM ${from} WHERE ${where} GROUP BY 1`, vp),
    db.query<{ week: string; winner: string; n: N }>(
      `SELECT ${wk} AS week, s.winner, count(*) AS n FROM ${from} WHERE ${where} AND s.verdict = 'competitor' AND s.winner IS NOT NULL GROUP BY 1, 2`, vp),
    db.query<{ dim: "agent" | "harness" | "model" | "mode" | "agent_mode"; key: string; scored: N; hits: N }>(
      `SELECT 'agent' AS dim, coalesce(s.agent_id, s.model) AS key, ${recRate} FROM ${from} WHERE ${where} GROUP BY 2
       UNION ALL SELECT 'harness', s.harness, ${recRate} FROM ${from} WHERE ${where} GROUP BY 2
       UNION ALL SELECT 'model', s.model, ${recRate} FROM ${from} WHERE ${where} GROUP BY 2
       UNION ALL SELECT 'mode', s.exec_mode, ${recRate} FROM ${from} WHERE ${where} GROUP BY 2
       UNION ALL SELECT 'agent_mode', s.exec_mode || ' ' || coalesce(s.agent_id, s.model), ${recRate} FROM ${from} WHERE ${where} GROUP BY 2`, vp),
    db.query<{ id: number; title: string; expectation: string; platform: string; scored: N; hits: N; picked: N }>(
      `SELECT sc.id, sc.title, sc.expectation, coalesce(sc.platform, 'unspecified') AS platform, count(*) AS scored,
              count(*) FILTER (WHERE ${HIT}) AS hits, count(*) FILTER (WHERE ${PICKED}) AS picked
         FROM ${from} WHERE ${where} GROUP BY sc.id, sc.title, sc.expectation, sc.platform`, vp),
    db.query<{ id: number; name: string; scored: N; hits: N }>(
      `SELECT dp.id, dp.name, ${recRate}
         FROM ${from} JOIN developer_profiles dp ON dp.id = s.profile_id WHERE ${where} GROUP BY dp.id, dp.name`, vp),
    db.query<{ tool: string; mentioned: N; chosen: N; won: N; lost: N }>(
      `SELECT m->>'tool' AS tool, count(DISTINCT s.id) AS mentioned,
              count(DISTINCT s.id) FILTER (WHERE s.verdict = 'competitor' AND s.winner = m->>'tool') AS chosen,
              count(DISTINCT s.id) FILTER (WHERE sc.expectation = 'recommend' AND ${PICKED}) AS won,
              count(DISTINCT s.id) FILTER (WHERE sc.expectation = 'recommend' AND s.verdict = 'competitor' AND s.winner = m->>'tool') AS lost
         FROM ${from} CROSS JOIN LATERAL jsonb_array_elements(${arr("s.mentions")}) m
        WHERE ${where} AND m->>'tool' IS NOT NULL AND coalesce(m->>'target', 'false') <> 'true' GROUP BY 1`, vp),
    db.query<{ name: string; n: N }>(
      `SELECT lower(x->>'name') AS name, count(DISTINCT s.id) AS n
         FROM ${from} CROSS JOIN LATERAL jsonb_array_elements(${arr("s.untracked")}) x
        WHERE ${where} AND x->>'name' IS NOT NULL GROUP BY 1`, vp),
    db.query<{ verdict: string; winner: string | null; reason: Reason | null; w: Mention | null; considered: boolean }>(
      `SELECT s.verdict, s.winner, CASE WHEN s.reason->>'winner' IS NOT DISTINCT FROM s.winner THEN s.reason END AS reason,
              (SELECT m FROM jsonb_array_elements(${arr("s.mentions")}) m WHERE m->>'tool' = s.winner LIMIT 1) AS w,
              EXISTS (SELECT 1 FROM jsonb_array_elements(${arr("s.mentions")}) m WHERE m->>'target' = 'true') AS considered
         FROM ${from} WHERE ${where} AND ${LOST} ORDER BY s.queued_at DESC LIMIT 5000`, vp),
  ]);
  const pct = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 10 : null);
  const ci = (k: number, n: number) => { const w = wilson(k, n); return w ? [Math.round(w[0] * 1000) / 10, Math.round(w[1] * 1000) / 10] as [number, number] : null; };
  const rateRow = <T,>(x: T, hits: number, scored: number) => ({ ...x, scored, hits, misses: scored - hits, pick_pct: pct(hits, scored), ci: ci(hits, scored) });
  const byRate = (a: { pick_pct: number | null; scored: number }, b: { pick_pct: number | null; scored: number }) => (b.pick_pct ?? -1) - (a.pick_pct ?? -1) || b.scored - a.scored;

  const sumW = (k: "scored" | "picked" | "rec" | "rec_picked" | "avoid" | "avoided") => weekly.reduce((n, r) => n + Number(r[k]), 0);
  const scored = sumW("scored"), picked = sumW("picked"), rec = sumW("rec"), recPicked = sumW("rec_picked"), avoid = sumW("avoid"), avoided = sumW("avoided");
  const winTot = new Map<string, number>();
  for (const r of winners) winTot.set(r.winner, (winTot.get(r.winner) ?? 0) + Number(r.n));
  const lossN = [...winTot.values()].reduce((a, b) => a + b, 0);
  const competitors = [...winTot].map(([name, n]) => ({ name, sessions: n, share_pct: pct(n, lossN) ?? 0 }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  const topName = competitors[0]?.name ?? null;
  const W = new Map(weekly.map((r) => [r.week, r]));

  // Word cloud: tracked tools (competitors the scorer matched) and untracked installs no product knows by name.
  const known = new Set(products.flatMap((x) => [x.name, ...(x.aliases ?? []), ...(x.packages ?? []),
    ...(Array.isArray(x.competitors) ? x.competitors : []).flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? [])])]).map((x) => String(x).toLowerCase()));
  const tracked = tools.map((t) => ({ name: t.tool, mentioned: Number(t.mentioned), chosen: Number(t.chosen), installed: 0, kind: "tracked" as const }));
  for (const t of tracked) known.add(t.name.toLowerCase());
  const extra = untracked.filter((u) => !known.has(u.name) && plausiblePackage(u.name)).map((u) => ({ name: u.name, mentioned: 0, chosen: 0, installed: Number(u.n), kind: "untracked" as const }));
  const cloud = [...tracked, ...extra].map((x) => ({ ...x, weight: x.mentioned + x.chosen + x.installed }))
    .filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)).slice(0, 40);

  const HOW: Record<HowChosen | "unknown", string> = { installed: "Installed its package", imported: "Imported it in code",
    built_on: "Called its API directly", recommended: "Recommended it in prose", unknown: "No evidence kept" };
  const how = new Map<string, number>();
  const wins = losses.filter((l) => l.verdict === "competitor");
  for (const l of wins) { const k = howChosen(l.w) ?? "unknown"; how.set(k, (how.get(k) ?? 0) + 1); }
  // Why: the model's reason per lost session (src/reasons.ts), by category; a session without one yet is "Not explained yet".
  const why = new Map<string, { sessions: number; phrases: Map<string, { phrase: string; sessions: number }>; quotes: { quote: string; winner: string | null }[] }>();
  for (const l of losses) {
    const k = l.reason?.category && REASON_CATEGORIES.some((c) => c.id === l.reason!.category) ? l.reason.category : l.reason ? "other" : NOT_EXPLAINED;
    const g = why.get(k) ?? { sessions: 0, phrases: new Map<string, { phrase: string; sessions: number }>(), quotes: [] as { quote: string; winner: string | null }[] };
    g.sessions++;
    if (l.reason) {
      const ph = String(l.reason.phrase ?? "").trim();
      if (ph) { const key = ph.toLowerCase(); const x = g.phrases.get(key) ?? { phrase: ph, sessions: 0 }; x.sessions++; g.phrases.set(key, x); }
      if (l.reason.quote && g.quotes.length < 3 && !g.quotes.some((q) => q.quote === l.reason!.quote)) g.quotes.push({ quote: String(l.reason.quote), winner: l.winner });
    }
    why.set(k, g);
  }
  const lost = losses.length, explained = losses.filter((l) => l.reason).length;
  const categories = [...why].map(([id, g]) => ({ id, label: id === NOT_EXPLAINED ? "Not explained yet" : reasonLabel(id), sessions: g.sessions, share_pct: pct(g.sessions, lost) ?? 0,
      phrases: [...g.phrases.values()].sort((a, b) => b.sessions - a.sessions || a.phrase.localeCompare(b.phrase)).slice(0, 3), quotes: g.quotes }))
    .sort((a, b) => Number(a.id === NOT_EXPLAINED) - Number(b.id === NOT_EXPLAINED) || b.sessions - a.sessions || a.label.localeCompare(b.label));

  const taskRows = tasks.map((t) => rateRow({ id: Number(t.id), title: t.title, expectation: t.expectation, platform: t.platform, picked: Number(t.picked) }, Number(t.hits), Number(t.scored)));
  const agg = <K extends string>(key: (t: (typeof taskRows)[number]) => K, keep: (t: (typeof taskRows)[number]) => boolean = () => true) => {
    const m = new Map<K, { tasks: number; scored: number; hits: number; picked: number }>();
    for (const t of taskRows.filter(keep)) { const a = m.get(key(t)) ?? { tasks: 0, scored: 0, hits: 0, picked: 0 }; a.tasks++; a.scored += t.scored; a.hits += t.hits; a.picked += t.picked; m.set(key(t), a); }
    return [...m].map(([k, a]) => ({ key: k, ...rateRow({ tasks: a.tasks, picked: a.picked }, a.hits, a.scored) }));
  };
  const dim = (d: "agent" | "harness" | "model") => groups.filter((g) => g.dim === d)
    .map((g) => rateRow({ key: g.key, name: d === "agent" ? agentLabel(g.key) : g.key }, Number(g.hits), Number(g.scored))).filter((x) => x.scored > 0).sort(byRate);

  return {
    products: products.map((x) => ({ id: x.id, name: x.name })),
    product: pid,
    // pick_pct / ci: picked on recommend tasks; avoid_pct: left out on avoid tasks; scored / picked: every task.
    totals: { scored, picked, pick_pct: pct(recPicked, rec), ci: ci(recPicked, rec),
      recommend: { scored: rec, picked: recPicked, missed: rec - recPicked },
      avoid: { scored: avoid, avoided, picked: avoid - avoided, avoid_pct: pct(avoided, avoid) },
      competitor_losses: lossN, top_competitor: topName },
    weekly: weeks.map((week) => {
      const r = W.get(week), n = Number(r?.rec ?? 0), h = Number(r?.rec_picked ?? 0);
      const c = ci(h, n), a = Number(r?.avoid ?? 0), ok = Number(r?.avoided ?? 0);
      return { week, partial: partial(week), scored: Number(r?.scored ?? 0), picked: Number(r?.picked ?? 0),
               recommend_scored: n, recommend_picked: h, pick_pct: pct(h, n), lo: c?.[0] ?? null, hi: c?.[1] ?? null,
               avoid_scored: a, avoided: ok, avoid_pct: pct(ok, a),
               top_competitor: topName ? winners.filter((x) => x.week === week && x.winner === topName).reduce((a, x) => a + Number(x.n), 0) : 0 };
    }),
    by_agent: dim("agent"), by_harness: dim("harness"), by_model: dim("model"),
    // Execution mode (sql/migrations/0001_baseline.sql exec_mode): plan then execute vs direct, overall and per agent.
    by_mode: (["plan", "direct"] as const).flatMap((mode) => {
      const g = groups.find((x) => x.dim === "mode" && x.key === mode);
      if (!g || !Number(g.scored)) return [];
      const agents = groups.filter((x) => x.dim === "agent_mode" && x.key.startsWith(`${mode} `) && Number(x.scored) > 0)
        .map((x) => { const key = x.key.slice(mode.length + 1); return rateRow({ key, name: agentLabel(key) }, Number(x.hits), Number(x.scored)); }).sort(byRate);
      return [rateRow({ mode, name: EXEC_MODE_LABEL[mode], agents }, Number(g.hits), Number(g.scored))];
    }),
    competitors,
    cloud,
    head_to_head: tools.map((t) => ({ name: t.tool, won: Number(t.won), lost: Number(t.lost) })).filter((t) => t.won + t.lost > 0)
      .sort((a, b) => b.won + b.lost - (a.won + a.lost) || a.name.localeCompare(b.name)).slice(0, 8),
    reasons: { lost, explained, not_explained: lost - explained, categories,
      losses: wins.length, never_mentioned: wins.filter((l) => !l.considered).length,
      how: [...how].map(([id, n]) => ({ id, label: HOW[id as HowChosen | "unknown"], sessions: n })).sort((a, b) => b.sessions - a.sessions) },
    by_task: taskRows.map(({ id, title, expectation, scored, hits, misses, pick_pct, ci }) => ({ id, title, expectation, scored, hits, misses, pick_pct, ci })).sort(byRate),
    by_persona: personas.map((x) => rateRow({ id: Number(x.id), name: x.name }, Number(x.hits), Number(x.scored))).filter((x) => x.scored > 0).sort(byRate),
    by_platform: agg((t) => t.platform, (t) => t.expectation === "recommend").map(({ key, ...r }) => ({ platform: key, ...r })).sort(byRate),
    expectation: (["recommend", "avoid"] as const).map((e) => {
      const r = agg((t) => (t.expectation === "avoid" ? "avoid" : "recommend")).find((x) => x.key === e);
      return { expectation: e, tasks: r?.tasks ?? 0, scored: r?.scored ?? 0, hits: r?.hits ?? 0, misses: r?.misses ?? 0, picked: r?.picked ?? 0, pick_pct: r?.pick_pct ?? null };
    }),
  };
}
export type Visibility = Awaited<ReturnType<typeof visibilityCharts>>;

/**
 * What the filters offer, from the period and product only: competitor names (the account's products' competitors,
 * plus any tool that won a session), and the personas (id, name) and tasks (id, title) with scored sessions.
 */
export async function visibilityOptions(orgId: number, range: Range, product: number | null, products?: ProductRow[]) {
  const db = await getDb();
  products ??= await productsOf(orgId);
  const pid = product && products.some((x) => x.id === product) ? product : null;
  const p: unknown[] = [orgId, range.start, range.end];
  const where = `s.org_id = $1 AND s.verdict IS NOT NULL AND s.queued_at >= $2 AND s.queued_at < $3${pid ? ` AND s.product_id = $${p.push(pid)}` : ""}`;
  const [winners, personas, tasks] = await Promise.all([
    db.query<{ name: string }>(`/* tenant: where has s.org_id = $1 */ SELECT DISTINCT s.winner AS name FROM agent_sessions s WHERE ${where} AND s.verdict = 'competitor' AND s.winner IS NOT NULL`, p),
    db.query<{ id: number; name: string }>(`/* tenant: where has s.org_id = $1 */ SELECT DISTINCT dp.id, dp.name FROM agent_sessions s JOIN developer_profiles dp ON dp.id = s.profile_id WHERE ${where}`, p),
    db.query<{ id: number; title: string }>(`/* tenant: where has s.org_id = $1 */ SELECT DISTINCT sc.id, sc.title FROM agent_sessions s JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id WHERE ${where}`, p),
  ]);
  const names = new Map<string, string>(); // lowercased -> first spelling seen
  for (const x of products.filter((x) => !pid || x.id === pid)) for (const c of Array.isArray(x.competitors) ? x.competitors : []) if (c?.name) names.set(String(c.name).toLowerCase(), String(c.name));
  for (const w of winners) if (!names.has(w.name.toLowerCase())) names.set(w.name.toLowerCase(), w.name);
  return {
    products: products.map((x) => ({ id: x.id, name: x.name })),
    competitors: [...names.values()].sort((a, b) => a.localeCompare(b)),
    personas: personas.map((x) => ({ id: Number(x.id), name: x.name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    tasks: tasks.map((x) => ({ id: Number(x.id), title: x.title })).sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id),
  };
}

/** The page: the charts for the filters, the filters as applied, and their options (product + period only). */
export async function visibilityPage(orgId: number, q: Record<string, unknown>) {
  const range = reportRange(q), f = parseFilters(q);
  const products = await productsOf(orgId);
  const [visibility, options] = await Promise.all([visibilityCharts(orgId, range, f, products), visibilityOptions(orgId, range, f.product, products)]);
  return { range: { from: range.from, to: range.to, days: range.days }, filters: { ...f, product: visibility.product }, options, sections: SECTIONS, visibility };
}

// ---------- report sections and exports ----------

export const SECTIONS = [
  { id: "summary", label: "Summary cards" },
  { id: "weekly", label: "Pick rate over time" },
  { id: "by_agent", label: "Pick rate by agent" },
  { id: "by_harness", label: "Pick rate by harness" },
  { id: "by_model", label: "Pick rate by model" },
  { id: "by_mode", label: "Plan → execute vs direct" },
  { id: "competitors", label: "Competitor share" },
  { id: "cloud", label: "Competitor word cloud (list)" },
  { id: "by_task", label: "Pick rate by task" },
  { id: "by_persona", label: "Pick rate by developer persona" },
  { id: "head_to_head", label: "Head-to-head" },
  { id: "reasons", label: "Why agents chose others" },
  { id: "how_won", label: "How the win showed up" },
  { id: "expectation", label: "Expectation check" },
  { id: "by_platform", label: "Pick rate by platform" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];
const SECTION_IDS = SECTIONS.map((s) => s.id) as [SectionId, ...SectionId[]];
export const sectionsFrom = (v: unknown): SectionId[] => {
  const want = new Set(many(v).flatMap((x) => x.split(",")).map((x) => x.trim()));
  const ids = SECTION_IDS.filter((id) => want.has(id));
  return ids.length ? ids : [...SECTION_IDS];
};

type Cell = string | number | boolean | null;
export interface Table { id: SectionId; title: string; columns: string[]; rows: Cell[][] }
/** Each section as a table, in the page's order: the same numbers the API returns. */
export function tables(v: Visibility, sections: SectionId[]): Table[] {
  const rate = ["scored", "hits", "misses", "pick_pct", "ci_low", "ci_high"];
  const r = (x: { scored: number; hits: number; misses: number; pick_pct: number | null; ci: [number, number] | null }) => [x.scored, x.hits, x.misses, x.pick_pct, x.ci?.[0] ?? null, x.ci?.[1] ?? null];
  const t = v.totals;
  const make: Record<SectionId, () => Omit<Table, "id" | "title">> = {
    summary: () => ({ columns: ["metric", "value"], rows: [["pick_pct", t.pick_pct], ["ci_low", t.ci?.[0] ?? null], ["ci_high", t.ci?.[1] ?? null],
      ["recommend_scored", t.recommend.scored], ["recommend_picked", t.recommend.picked], ["avoid_pct", t.avoid.avoid_pct], ["avoid_scored", t.avoid.scored],
      ["avoided", t.avoid.avoided], ["scored", t.scored], ["picked", t.picked], ["competitor_losses", t.competitor_losses], ["top_competitor", t.top_competitor]] }),
    weekly: () => ({ columns: ["week", "partial", "scored", "recommend_scored", "recommend_picked", "pick_pct", "ci_low", "ci_high", "avoid_scored", "avoided", "avoid_pct", "top_competitor_wins"],
      rows: v.weekly.map((w) => [w.week, w.partial, w.scored, w.recommend_scored, w.recommend_picked, w.pick_pct, w.lo, w.hi, w.avoid_scored, w.avoided, w.avoid_pct, w.top_competitor]) }),
    by_agent: () => ({ columns: ["key", "name", ...rate], rows: v.by_agent.map((x) => [x.key, x.name, ...r(x)]) }),
    by_harness: () => ({ columns: ["key", "name", ...rate], rows: v.by_harness.map((x) => [x.key, x.name, ...r(x)]) }),
    by_model: () => ({ columns: ["key", "name", ...rate], rows: v.by_model.map((x) => [x.key, x.name, ...r(x)]) }),
    by_mode: () => ({ columns: ["mode", "agent", ...rate],
      rows: v.by_mode.flatMap((m) => [[m.mode, "all", ...r(m)] as Cell[], ...m.agents.map((a) => [m.mode, a.key, ...r(a)] as Cell[])]) }),
    competitors: () => ({ columns: ["name", "sessions", "share_pct"], rows: v.competitors.map((c) => [c.name, c.sessions, c.share_pct]) }),
    cloud: () => ({ columns: ["name", "kind", "weight", "chosen", "mentioned", "installed"], rows: v.cloud.map((c) => [c.name, c.kind, c.weight, c.chosen, c.mentioned, c.installed]) }),
    by_task: () => ({ columns: ["id", "title", "expectation", ...rate], rows: v.by_task.map((x) => [x.id, x.title, x.expectation, ...r(x)]) }),
    by_persona: () => ({ columns: ["id", "name", ...rate], rows: v.by_persona.map((x) => [x.id, x.name, ...r(x)]) }),
    head_to_head: () => ({ columns: ["name", "won", "lost"], rows: v.head_to_head.map((x) => [x.name, x.won, x.lost]) }),
    reasons: () => ({ columns: ["id", "name", "sessions", "of", "share_pct", "phrases", "quotes"],
      rows: v.reasons.categories.map((c) => [c.id, c.label, c.sessions, v.reasons.lost, c.share_pct, c.phrases.map((p) => `${p.phrase} (${p.sessions})`).join(" | "),
        c.quotes.map((q) => `"${q.quote}"${q.winner ? ` (${q.winner})` : ""}`).join(" | ")] as Cell[]) }),
    how_won: () => ({ columns: ["id", "name", "sessions", "of"], rows: [...v.reasons.how.map((x) => [x.id, x.label, x.sessions, v.reasons.losses] as Cell[]),
      ["never_mentioned", "Never mentioned you", v.reasons.never_mentioned, v.reasons.losses], ["mentioned", "Mentioned you, chose it", v.reasons.losses - v.reasons.never_mentioned, v.reasons.losses]] }),
    expectation: () => ({ columns: ["expectation", "tasks", "scored", "hits", "misses", "picked", "pick_pct"],
      rows: v.expectation.map((e) => [e.expectation, e.tasks, e.scored, e.hits, e.misses, e.picked, e.pick_pct]) }),
    by_platform: () => ({ columns: ["platform", "tasks", ...rate], rows: v.by_platform.map((x) => [x.platform, x.tasks, ...r(x)]) }),
  };
  return sections.map((id) => ({ id, title: SECTIONS.find((s) => s.id === id)!.label, ...make[id]() }));
}

const csvCell = (c: Cell) => {
  if (c == null) return "";
  const s = String(c);
  // A leading = + - @ would run as a formula in a spreadsheet: prefix a quote (names come from agents' transcripts).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
/** One CSV, a `section` column first, then every section's columns (blank where a section has none). */
export function toCsv(ts: Table[]): string {
  const cols: string[] = [];
  for (const t of ts) for (const c of t.columns) if (!cols.includes(c)) cols.push(c);
  const lines = [["section", ...cols].join(",")];
  for (const t of ts) for (const row of t.rows) lines.push([t.id, ...cols.map((c) => { const i = t.columns.indexOf(c); return i < 0 ? null : row[i]; })].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
export const DEFAULT_NAME = "Pick rate report";

/** A report: the numbers for a definition (filters, period, sections) with the filters spelled out by name. */
export async function buildReport(org: { orgId: number; name: string }, d: { name?: string; filters: VisFilters; range: Record<string, unknown>; sections: SectionId[] }) {
  const range = reportRange(d.range);
  const products = await productsOf(org.orgId);
  const [v, options] = await Promise.all([visibilityCharts(org.orgId, range, d.filters, products), visibilityOptions(org.orgId, range, d.filters.product, products)]);
  const name = (d.name ?? "").trim() || DEFAULT_NAME;
  // Names for the filters picked, from this account's own options (an id from elsewhere stays a bare id).
  const persona = d.filters.persona.map((id) => ({ id, name: options.personas.find((x) => x.id === id)?.name ?? null }));
  const task = d.filters.task.map((id) => ({ id, title: options.tasks.find((x) => x.id === id)?.title ?? null }));
  const ts = tables(v, d.sections);
  return {
    report: name, account: org.name, generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    filters: { product: v.product ? { id: v.product, name: v.products.find((x) => x.id === v.product)?.name ?? null } : null, competitor: d.filters.competitor, persona, task },
    sections: ts,
    filename: `pick-rate-${slugify(name)}-${range.from}-to-${range.to}`,
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;

// ---------- saved reports ----------

const PRESETS = ["7d", "14d", "30d", "90d", "month", "last-month"] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Definition = z.object({
  filters: z.object({
    competitor: z.array(z.string().trim().min(1).max(200)).max(LIMIT).default([]),
    persona: z.array(z.number().int().positive()).max(LIMIT).default([]),
    task: z.array(z.number().int().positive()).max(LIMIT).default([]),
    product: z.number().int().positive().nullable().default(null),
  }).strict().default({ competitor: [], persona: [], task: [], product: null }),
  range: z.union([z.object({ preset: z.enum(PRESETS) }).strict(), z.object({ from: day, to: day }).strict()]).default({ preset: "30d" }),
  sections: z.array(z.enum(SECTION_IDS)).min(1).max(SECTION_IDS.length).default([...SECTION_IDS]),
  format: z.enum(["pdf", "csv", "json"]).default("pdf"),
}).strict();
export type Definition = z.infer<typeof Definition>;

/** A saved range as from/to (UTC days): a preset is relative to today, fixed dates stay fixed. */
export function resolveRange(r: Definition["range"]): { from: string; to: string } {
  if ("from" in r) return { from: r.from, to: r.to };
  const today = new Date(Math.floor(Date.now() / DAY) * DAY), iso = (d: Date) => d.toISOString().slice(0, 10);
  const back = (n: number) => iso(new Date(today.getTime() - n * DAY));
  switch (r.preset) {
    case "7d": return { from: back(6), to: iso(today) };
    case "14d": return { from: back(13), to: iso(today) };
    case "90d": return { from: back(89), to: iso(today) };
    case "month": return { from: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: iso(today) };
    case "last-month": return { from: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))), to: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))) };
    default: return { from: back(29), to: iso(today) };
  }
}

interface Row { id: number; org_id: number; name: string; definition: Definition; created_by: string | null; created_at: Date; updated_at: Date; last_run_at: Date | null }
async function reportRow(orgId: number, id: unknown): Promise<Row | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n >= 2 ** 53) return null;
  const [r] = await (await getDb()).query<Row>("SELECT * FROM visibility_reports WHERE org_id = $1 AND id = $2", [orgId, n]);
  return r ? { ...r, id: Number(r.id), definition: Definition.parse(r.definition ?? {}) } : null;
}
const touch = async (orgId: number, id: number) => (await getDb()).query("UPDATE visibility_reports SET last_run_at = now() WHERE org_id = $1 AND id = $2", [orgId, id]);
/** A saved report's export, for the MCP tool and the page (marks it run). */
export async function savedReport(org: { orgId: number; name: string }, id: unknown, sections?: SectionId[]) {
  const r = await reportRow(org.orgId, id);
  if (!r) return null;
  await touch(org.orgId, r.id);
  return buildReport(org, { name: r.name, filters: r.definition.filters, range: resolveRange(r.definition.range), sections: sections ?? r.definition.sections });
}

/** export_visibility_report (src/server.ts): a saved report by id, or filters given here; JSON tables, or one CSV. */
export async function mcpExport(org: Org, a: { report_id?: number; product?: string; competitors?: string[]; personas?: number[]; tasks?: number[];
  days?: number; from?: string; to?: string; sections?: string[]; format?: "json" | "csv"; name?: string }) {
  const sections = a.sections?.length ? sectionsFrom(a.sections) : undefined;
  let rep: Report | null;
  if (a.report_id != null) {
    rep = await savedReport(org, a.report_id, sections);
    if (!rep) throw new Error(`No saved report ${a.report_id} in this account. The Pick rate page lists them under Saved reports.`);
  } else {
    let product: number | null = null;
    if (a.product) {
      const ref = String(a.product).toLowerCase(), ps = await productsOf(org.orgId);
      const p = ps.find((x) => String(x.id) === ref || x.name.toLowerCase() === ref) ??
        (await (await getDb()).query<{ id: number }>("SELECT id FROM products WHERE org_id = $1 AND lower(slug) = $2", [org.orgId, ref]))[0];
      if (!p) throw new Error(`No product "${a.product}". list_products shows this account's products.`);
      product = Number(p.id);
    }
    const f = parseFilters({ competitor: a.competitors, persona: a.personas, task: a.tasks });
    rep = await buildReport(org, { name: a.name, filters: { ...f, product }, range: { from: a.from, to: a.to, days: a.days }, sections: sections ?? sectionsFrom(undefined) });
  }
  const { filename, ...data } = rep;
  return { view: "visibility_export" as const, ...data, format: a.format ?? "json", filename: `${filename}.${a.format === "csv" ? "csv" : "json"}`,
           ...(a.format === "csv" ? { csv: toCsv(rep.sections) } : {}) };
}

// ---------- routes ----------

interface Who { org: number; slug: string; user: string | null; accountRole: roles.AccountRole }
/** Mounted on the portal's /api/app router (src/app.ts), after its sign-in. */
export function visibilityRoutes(api: Router, h: {
  S: (res: Response) => Who; need: (res: Response, p: roles.AccountPermission) => void; fail: (message: string, status?: number, info?: Record<string, unknown>) => Error;
  accountName: (slug: string) => Promise<string>;
}) {
  const db = getDb;
  const orgOf = async (res: Response) => ({ orgId: h.S(res).org, name: await h.accountName(h.S(res).slug) });
  const record = (res: Response) => recordPageAction({ orgId: h.S(res).org, slug: h.S(res).slug, name: "", userId: h.S(res).user ?? undefined }, "export_visibility_report");
  // print=1: the print page reading the tables it lays out; it counts the export itself when it prints.
  const send = async (req: Request, res: Response, rep: Report, format: unknown) => {
    if (req.query.print !== "1") await record(res);
    const { filename, ...data } = rep;
    if (format === "csv") {
      res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", `attachment; filename="${filename}.csv"`);
      return void res.send(toCsv(rep.sections));
    }
    res.set("Content-Disposition", `attachment; filename="${filename}.json"`).json(data);
  };
  const format = (req: Request) => {
    const f = String(req.query.format ?? "json");
    if (f !== "csv" && f !== "json") throw h.fail("format must be csv or json (PDF: the print page, /app/pick-rate/report)", 400);
    return f;
  };
  const view = (res: Response, r: Row) => {
    const s = h.S(res);
    const mine = Boolean(s.user) && r.created_by === s.user;
    return { id: r.id, name: r.name, definition: r.definition, range: resolveRange(r.definition.range), mine, created_at: r.created_at, updated_at: r.updated_at, last_run_at: r.last_run_at,
             can_edit: mine && roles.canAccount(s.accountRole, "edit"), can_delete: roles.canAccount(s.accountRole, "edit") && (mine || roles.canAccount(s.accountRole, "billing")) };
  };
  const found = async (res: Response, id: unknown) => {
    const r = await reportRow(h.S(res).org, id);
    if (!r) throw h.fail("No such report in this account", 404, { code: "not_found" });
    return r;
  };
  const body = (v: unknown) => {
    const r = Definition.safeParse(v ?? {});
    if (!r.success) throw h.fail(`Report definition: ${r.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`).join("; ")}`, 400);
    return r.data;
  };
  const nameOf = (v: unknown) => {
    const n = String(v ?? "").trim().replace(/\s+/g, " ");
    if (!n) throw h.fail("Give the report a name", 400);
    if (n.length > 120) throw h.fail("A report name is at most 120 characters", 400);
    return n;
  };

  api.get("/visibility", async (req, res) => void res.json({ ...(await visibilityPage(h.S(res).org, req.query as Record<string, unknown>)), permissions: roles.accountPermissionsOf(h.S(res).accountRole) }));
  api.get("/visibility/export", async (req, res) => {
    const f = format(req);
    await send(req, res, await buildReport(await orgOf(res), { name: typeof req.query.name === "string" ? req.query.name.slice(0, 120) : undefined,
      filters: parseFilters(req.query as Record<string, unknown>), range: req.query as Record<string, unknown>, sections: sectionsFrom(req.query.section) }), f);
  });
  // The print page (PDF) has no file to send: it says when it printed, so PDFs count like the other exports.
  api.post("/visibility/export-events", async (_req, res) => { await record(res); res.status(204).end(); });

  api.get("/visibility/reports", async (_req, res) => {
    const rows = await (await db()).query<Row>("SELECT * FROM visibility_reports WHERE org_id = $1 ORDER BY lower(name), id", [h.S(res).org]);
    res.json({ reports: rows.map((r) => view(res, { ...r, id: Number(r.id), definition: Definition.parse(r.definition ?? {}) })), can_create: roles.canAccount(h.S(res).accountRole, "edit") });
  });
  api.post("/visibility/reports", async (req, res) => {
    h.need(res, "edit");
    const s = h.S(res), name = nameOf(req.body?.name), def = body(req.body?.definition);
    const [{ n }] = await (await db()).query<{ n: number }>("SELECT count(*)::int AS n FROM visibility_reports WHERE org_id = $1", [s.org]);
    if (Number(n) >= 100) throw h.fail("An account keeps at most 100 saved reports. Delete one first.", 400);
    const [r] = await (await db()).query<Row>("INSERT INTO visibility_reports (org_id, name, definition, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
      [s.org, name, JSON.stringify(def), s.user]);
    res.status(201).json(view(res, { ...r, id: Number(r.id), definition: def }));
  });
  api.put("/visibility/reports/:id", async (req, res) => {
    h.need(res, "edit");
    const r = await found(res, req.params.id), s = h.S(res);
    if (!s.user || r.created_by !== s.user) throw h.fail("Only the person who saved this report can change it. Save your own copy with New report.", 403, { code: "forbidden", needs: "owner of the report" });
    const name = req.body?.name !== undefined ? nameOf(req.body.name) : r.name;
    const def = req.body?.definition !== undefined ? body(req.body.definition) : r.definition;
    const [u] = await (await db()).query<Row>("UPDATE visibility_reports SET name = $3, definition = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *",
      [s.org, r.id, name, JSON.stringify(def)]);
    res.json(view(res, { ...u, id: Number(u.id), definition: def }));
  });
  api.delete("/visibility/reports/:id", async (req, res) => {
    h.need(res, "edit");
    const r = await found(res, req.params.id), s = h.S(res);
    if (!(s.user && r.created_by === s.user) && !roles.canAccount(s.accountRole, "billing"))
      throw h.fail("Only the person who saved this report, an Owner or a Billing manager can delete it.", 403, { code: "forbidden", needs: "billing" });
    await (await db()).query("DELETE FROM visibility_reports WHERE org_id = $1 AND id = $2", [s.org, r.id]);
    res.status(204).end();
  });
  api.post("/visibility/reports/:id/run", async (req, res) => {
    const r = await found(res, req.params.id);
    await touch(h.S(res).org, r.id);
    res.json(view(res, { ...r, last_run_at: new Date() }));
  });
  api.get("/visibility/reports/:id/export", async (req, res) => {
    const f = format(req);
    await found(res, req.params.id);
    const rep = await savedReport(await orgOf(res), req.params.id, req.query.section ? sectionsFrom(req.query.section) : undefined);
    await send(req, res, rep!, f);
  });
}
