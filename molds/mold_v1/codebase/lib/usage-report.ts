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
import type { DictationUsage, SessionTotals } from "@/lib/dictation";
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
/**
 * The ledger key of one stretch of listening's rows. The workspace is part of it: the id is the browser's, and two
 * workspaces that happened (or tried) to send the same one must never meet in the table's unique index.
 */
const dictationSessionKey = (orgId: string, sessionId: string) => `dictation:${orgId}:${sessionId}`;

export async function recordDictationUsage(row: DictationUsage): Promise<void> {
  const sectioned = row.sessionId !== null && row.seq !== null;
  await withOrgRls(row.orgId, (tx) =>
    tx
      .insert(chatTurnUsage)
      .values({
      orgId: row.orgId,
      // A section is keyed by its stretch and its place in it; a clip sent on its own, by its own id, as before.
      eveSessionId: sectioned ? dictationSessionKey(row.orgId, row.sessionId!) : `dictation:${row.id}`,
      turnId: sectioned ? `section-${row.seq}` : "dictation",
      actorEmail: row.actorEmail,
      model: row.model,
      // Not an agent step: `steps` counts the chat's model calls, and the report keeps the two apart.
      steps: 0,
      status: "success",
      startedAt: row.at,
      completedAt: row.at,
      kind: "dictation",
      audioMs: row.audioMs,
      })
      // The same section sent twice (a retry) was transcribed twice: one row, with both lengths, so what was paid for
      // is all there and a replay cannot hide audio from the session's limit.
      .onConflictDoUpdate({
        target: [chatTurnUsage.eveSessionId, chatTurnUsage.turnId],
        set: { audioMs: sql`${chatTurnUsage.audioMs} + excluded.audio_ms`, completedAt: row.at },
      }),
  );
}

/**
 * What one stretch of listening has used so far (lib/dictation.ts keeps `max_session_seconds` and the per-minute rate
 * with it), read from the rows above inside the caller's workspace scope. From the ledger rather than from memory: a
 * deployment runs as many server instances, and each section may reach a different one.
 */
export async function readDictationSession(orgId: string, sessionId: string, now: Date): Promise<SessionTotals> {
  const minuteAgo = new Date(now.getTime() - 60_000);
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select({
        audio_ms: sql<string>`coalesce(sum(${chatTurnUsage.audioMs}), 0)`,
        // gte(), not a bare ${minuteAgo}: the column is what tells the driver how to send a Date.
        last_minute: sql<string>`count(*) filter (where ${gte(chatTurnUsage.startedAt, minuteAgo)})`,
      })
      .from(chatTurnUsage)
      .where(and(eq(chatTurnUsage.orgId, orgId), eq(chatTurnUsage.eveSessionId, dictationSessionKey(orgId, sessionId)), eq(chatTurnUsage.kind, "dictation"))),
  );
  return { audioMs: Number(rows[0]?.audio_ms ?? 0), lastMinute: Number(rows[0]?.last_minute ?? 0) };
}
