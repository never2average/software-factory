import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { chatTurnUsage } from "@/agent/lib/db/schema";
import { estimateCostUsd } from "@/lib/inference-pricing";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

interface Totals {
  turns: number;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null when any model in the slice has no price (never a silent $0). */
  est_cost_usd: number | null;
}

const zero = (): Totals => ({
  turns: 0,
  steps: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  est_cost_usd: 0,
});

/** Fold one (model, tokens) group into a running total, pricing it as it goes. */
function add(into: Totals, model: string | null, g: Omit<Totals, "est_cost_usd">): Totals {
  into.turns += g.turns;
  into.steps += g.steps;
  into.input_tokens += g.input_tokens;
  into.output_tokens += g.output_tokens;
  into.cache_read_tokens += g.cache_read_tokens;
  into.cache_write_tokens += g.cache_write_tokens;
  const cost = estimateCostUsd(model, {
    inputTokens: g.input_tokens,
    outputTokens: g.output_tokens,
    cacheReadTokens: g.cache_read_tokens,
    cacheWriteTokens: g.cache_write_tokens,
  });
  into.est_cost_usd = into.est_cost_usd === null || cost === null ? null : round(into.est_cost_usd + cost);
  return into;
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

function daysParam(url: URL): number {
  const raw = Number(url.searchParams.get("days") ?? DEFAULT_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DAYS;
  return Math.min(Math.floor(raw), MAX_DAYS);
}

/**
 * GET /api/ops/usage?days=30 — what the workspace's ordinary chat turns cost.
 *
 * Read-only. Sums `chat_turn_usage` for the caller's workspace over the last
 * `days` (default 30, max 365): turn and step counts, the four token counters,
 * and an estimated cost priced at request time from `lib/inference-pricing.ts`
 * (tokens are stored, prices are not). Also a per-day series and a per-model
 * breakdown, so an unpriced model shows up by name rather than as a hole in
 * the total. Workflow (subagent) usage lives in `automation_runs` and is not
 * included here.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const days = daysParam(url);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ days, since: since.toISOString(), totals: zero(), by_model: [], by_day: [] });
  }
  try {
    const day = sql<string>`to_char(date_trunc('day', ${chatTurnUsage.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({
          day,
          model: chatTurnUsage.model,
          turns: sql<number>`count(*)::int`,
          steps: sql<number>`coalesce(sum(${chatTurnUsage.steps}), 0)::int`,
          input_tokens: sql<number>`coalesce(sum(${chatTurnUsage.inputTokens}), 0)::bigint`,
          output_tokens: sql<number>`coalesce(sum(${chatTurnUsage.outputTokens}), 0)::bigint`,
          cache_read_tokens: sql<number>`coalesce(sum(${chatTurnUsage.cacheReadTokens}), 0)::bigint`,
          cache_write_tokens: sql<number>`coalesce(sum(${chatTurnUsage.cacheWriteTokens}), 0)::bigint`,
        })
        .from(chatTurnUsage)
        .where(and(eq(chatTurnUsage.orgId, ctx.orgId), gte(chatTurnUsage.startedAt, since)))
        .groupBy(day, chatTurnUsage.model)
        .orderBy(day),
    );

    const totals = zero();
    const byModel = new Map<string | null, Totals>();
    const byDay = new Map<string, Totals>();
    for (const r of rows) {
      // bigint sums arrive as strings from postgres.js; normalise once here.
      const g = {
        turns: Number(r.turns),
        steps: Number(r.steps),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cache_read_tokens: Number(r.cache_read_tokens),
        cache_write_tokens: Number(r.cache_write_tokens),
      };
      add(totals, r.model, g);
      add(byModel.get(r.model) ?? byModel.set(r.model, zero()).get(r.model)!, r.model, g);
      add(byDay.get(r.day) ?? byDay.set(r.day, zero()).get(r.day)!, r.model, g);
    }

    return NextResponse.json({
      days,
      since: since.toISOString(),
      totals,
      by_model: [...byModel].map(([model, t]) => ({ model, priced: t.est_cost_usd !== null, ...t })),
      by_day: [...byDay].map(([date, t]) => ({ date, ...t })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
