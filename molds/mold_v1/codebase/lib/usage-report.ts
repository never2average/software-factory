/**
 * The usage ledger's two sides that are not a route: writing a dictation's row, and reading a workspace's usage as
 * GET /api/ops/usage answers it. Here rather than in the routes so scripts/test-dictation-usage-db.mjs runs both, as
 * the app's restricted role, against a Postgres whose policy fails closed.
 *
 * `chat_turn_usage` stores tokens (a chat turn) or milliseconds of audio (a dictation, kind "dictation"), never
 * dollars: both are priced at read time from lib/inference-pricing.ts, so a provider's new price never leaves a stale
 * figure behind.
 */
import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { chatTurnUsage } from "@/agent/lib/db/schema";
import type { DictationUsage } from "@/lib/dictation";
import { estimateAudioCostUsd, estimateCostUsd } from "@/lib/inference-pricing";
import { withOrgRls } from "@/lib/ops-db";

export interface Totals {
  /** Chat turns of the main agent. */
  turns: number;
  /** Clips the composer's microphone turned into prompt text (lib/dictation.ts). */
  dictations: number;
  /** Their audio, in seconds: what a speech-to-text model is priced on. */
  audio_seconds: number;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null when any model in the slice has no price (never a silent $0). */
  est_cost_usd: number | null;
}

export const zero = (): Totals => ({
  turns: 0,
  dictations: 0,
  audio_seconds: 0,
  steps: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  est_cost_usd: 0,
});

/** One (day, model, kind) group as the query returns it, normalised. */
interface Group {
  kind: string;
  rows: number;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  audio_ms: number;
}

/**
 * Fold one group into a running total, pricing it as it goes: a chat group on its tokens, a dictation group on its
 * audio minutes (lib/inference-pricing.ts has a table for each).
 */
function add(into: Totals, model: string | null, g: Group): Totals {
  const dictation = g.kind === "dictation";
  if (dictation) {
    into.dictations += g.rows;
    into.audio_seconds = Math.round((into.audio_seconds + g.audio_ms / 1000) * 10) / 10;
  } else {
    into.turns += g.rows;
  }
  into.steps += g.steps;
  into.input_tokens += g.input_tokens;
  into.output_tokens += g.output_tokens;
  into.cache_read_tokens += g.cache_read_tokens;
  into.cache_write_tokens += g.cache_write_tokens;
  const cost = dictation
    ? estimateAudioCostUsd(model, g.audio_ms)
    : estimateCostUsd(model, {
        inputTokens: g.input_tokens,
        outputTokens: g.output_tokens,
        cacheReadTokens: g.cache_read_tokens,
        cacheWriteTokens: g.cache_write_tokens,
      });
  into.est_cost_usd = into.est_cost_usd === null || cost === null ? null : round(into.est_cost_usd + cost);
  return into;
}

// Six places: one dictation costs a fraction of a tenth of a cent, and four places would add it up as zero.
const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

export interface UsageReport {
  totals: Totals;
  by_model: ({ model: string | null; priced: boolean } & Totals)[];
  by_day: ({ date: string } & Totals)[];
}

/** A workspace's usage since `since`, inside its row-level security scope: totals, per model, per UTC day. */
export async function readUsage(orgId: string, since: Date): Promise<UsageReport> {
  const day = sql<string>`to_char(date_trunc('day', ${chatTurnUsage.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select({
        day,
        model: chatTurnUsage.model,
        kind: chatTurnUsage.kind,
        rows: sql<number>`count(*)::int`,
        steps: sql<number>`coalesce(sum(${chatTurnUsage.steps}), 0)::int`,
        input_tokens: sql<number>`coalesce(sum(${chatTurnUsage.inputTokens}), 0)::bigint`,
        output_tokens: sql<number>`coalesce(sum(${chatTurnUsage.outputTokens}), 0)::bigint`,
        cache_read_tokens: sql<number>`coalesce(sum(${chatTurnUsage.cacheReadTokens}), 0)::bigint`,
        cache_write_tokens: sql<number>`coalesce(sum(${chatTurnUsage.cacheWriteTokens}), 0)::bigint`,
        audio_ms: sql<number>`coalesce(sum(${chatTurnUsage.audioMs}), 0)::bigint`,
      })
      .from(chatTurnUsage)
      .where(and(eq(chatTurnUsage.orgId, orgId), gte(chatTurnUsage.startedAt, since)))
      .groupBy(day, chatTurnUsage.model, chatTurnUsage.kind)
      .orderBy(day),
  );

  const totals = zero();
  const byModel = new Map<string | null, Totals>();
  const byDay = new Map<string, Totals>();
  for (const r of rows) {
    // bigint sums arrive as strings from postgres.js; normalise once here.
    const g: Group = {
      kind: r.kind,
      rows: Number(r.rows),
      steps: Number(r.steps),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_write_tokens: Number(r.cache_write_tokens),
      audio_ms: Number(r.audio_ms),
    };
    add(totals, r.model, g);
    add(byModel.get(r.model) ?? byModel.set(r.model, zero()).get(r.model)!, r.model, g);
    add(byDay.get(r.day) ?? byDay.set(r.day, zero()).get(r.day)!, r.model, g);
  }

  return {
    totals,
    by_model: [...byModel].map(([model, t]) => ({ model, priced: t.est_cost_usd !== null, ...t })),
    by_day: [...byDay].map(([date, t]) => ({ date, ...t })),
  };
}

/**
 * One dictation's row (lib/dictation.ts, POST /api/ops/dictation), in the caller's workspace and inside its
 * row-level security scope, so readUsage counts and prices it beside the chat's own turns. The audio's length, never
 * its words.
 */
export async function recordDictationUsage(row: DictationUsage): Promise<void> {
  await withOrgRls(row.orgId, (tx) =>
    tx.insert(chatTurnUsage).values({
      orgId: row.orgId,
      eveSessionId: `dictation:${row.id}`,
      turnId: "dictation",
      actorEmail: row.actorEmail,
      model: row.model,
      // Not an agent step: `steps` counts the chat's model calls, and the report keeps the two apart.
      steps: 0,
      status: "success",
      startedAt: row.at,
      completedAt: row.at,
      kind: "dictation",
      audioMs: row.audioMs,
    }),
  );
}
