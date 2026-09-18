/**
 * Token accounting for ORDINARY chat turns — the main agent's own model calls.
 *
 * The workflow subagents record their usage through `hooks/usage.ts` into
 * `automation_runs`; the root agent never did, so the turns people actually
 * type were billed nowhere (a first turn measured at ~32,400 input tokens on
 * Workers AI, invisible in the product). `agent/hooks/chat-usage.ts` feeds this
 * module: one `step.completed` per model call ADDS its tokens to the turn's
 * `chat_turn_usage` row (keyed by eve session id + turn id), and the terminal
 * turn event closes the row with a status.
 *
 * Workspace: a usage row is tenant data, so it needs the workspace of the
 * person who sent the turn. That comes from the session's authenticated
 * caller (`ctx.session.auth`), resolved exactly as the agent's tools resolve
 * it (`orgForSession`). When there is NO identity to resolve from — or the
 * resolver refuses it — nothing is written and one line is logged per turn.
 * A row filed under a guessed workspace would be a tenancy bug wearing a
 * billing hat.
 *
 * Never throws and never blocks the turn: eve escalates a thrown hook to
 * `turn.failed`, so every path here swallows its own error, and the hook does
 * not await the write. Writes for one turn are still chained in order, so the
 * closing update cannot overtake the row's first insert.
 *
 * The recorder takes its dependencies as a parameter so
 * scripts/test-chat-usage.mjs can drive it offline with fakes; `chatUsage` is
 * the production instance. Relative `.ts` specifiers, like the other `#lib`
 * modules, so it runs under plain `node --experimental-strip-types`.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { chatTurnUsage } from "./db/schema.ts";
import { callerFromCtx, orgForSession, type SessionCtxLike } from "./org-context.ts";
import { agentModelId } from "./model.ts";

export interface StepUsage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type ChatTurnStatus = "success" | "failed" | "cancelled";

/** The minimal hook context this needs: the session id plus its auth. */
export interface ChatUsageCtx extends SessionCtxLike {
  readonly session?: SessionCtxLike["session"] & { readonly id?: string };
}

export interface ChatStepWrite {
  readonly orgId: string;
  readonly eveSessionId: string;
  readonly turnId: string;
  readonly actorEmail: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ChatFinishWrite {
  readonly orgId: string;
  readonly eveSessionId: string;
  readonly turnId: string;
  readonly status: ChatTurnStatus;
}

export interface ChatUsageDeps {
  /** The caller's workspace, or null when it cannot be known for this turn. */
  resolveOrg(ctx: ChatUsageCtx): Promise<string | null>;
  /** The caller's email, if the session carries one. */
  actorEmail(ctx: ChatUsageCtx): string | null;
  /** The model id to stamp on the row. */
  model(): string | null;
  /** Upsert: ADD this step's tokens to the (session, turn) row, steps + 1. */
  writeStep(row: ChatStepWrite): Promise<void>;
  /** Close the (session, turn) row with a terminal status. */
  writeFinish(row: ChatFinishWrite): Promise<void>;
  warn(message: string): void;
  error(message: string, error: unknown): void;
}

export interface ChatUsageRecorder {
  /** Fire-and-forget; resolves when the write has settled (for tests). */
  recordStep(ctx: ChatUsageCtx, turnId: string, usage: StepUsage | undefined): Promise<void>;
  finishTurn(ctx: ChatUsageCtx, turnId: string, status: ChatTurnStatus): Promise<void>;
}

/** Sum of the token fields — used only to decide whether a step is worth writing. */
export function isEmptyUsage(usage: StepUsage | undefined): boolean {
  if (!usage) return true;
  return (
    !usage.inputTokens &&
    !usage.outputTokens &&
    !usage.cacheReadTokens &&
    !usage.cacheWriteTokens
  );
}

/**
 * Per-turn state kept for the life of the turn: the resolved workspace (so the
 * lookup runs once, and an unresolved turn warns once), and the tail of the
 * turn's write chain. Bounded so an instance that never sees a turn end cannot
 * grow it forever.
 */
interface TurnState {
  org: Promise<string | null>;
  tail: Promise<void>;
}
const MAX_TRACKED_TURNS = 2_000;

export function createChatUsageRecorder(deps: ChatUsageDeps): ChatUsageRecorder {
  const turns = new Map<string, TurnState>();

  function stateFor(ctx: ChatUsageCtx, sessionId: string, turnId: string): TurnState {
    const key = `${sessionId}:${turnId}`;
    let state = turns.get(key);
    if (!state) {
      state = {
        org: deps
          .resolveOrg(ctx)
          .catch((error) => {
            deps.error(`[chat-usage] workspace lookup failed for turn ${turnId}:`, error);
            return null;
          })
          .then((org) => {
            if (!org) {
              deps.warn(
                `[chat-usage] turn ${turnId} in session ${sessionId} has no resolvable workspace — usage not recorded`,
              );
            }
            return org;
          }),
        tail: Promise.resolve(),
      };
      if (turns.size >= MAX_TRACKED_TURNS) {
        const oldest = turns.keys().next().value;
        if (oldest !== undefined) turns.delete(oldest);
      }
      turns.set(key, state);
    }
    return state;
  }

  /** Append one write to the turn's chain; a failed write logs and never breaks the chain. */
  function enqueue(state: TurnState, label: string, write: () => Promise<void>): Promise<void> {
    const next = state.tail.then(write).catch((error) => {
      deps.error(`[chat-usage] could not ${label}:`, error);
    });
    state.tail = next;
    return next;
  }

  return {
    recordStep(ctx, turnId, usage) {
      try {
        const sessionId = ctx.session?.id;
        if (!sessionId || !turnId || isEmptyUsage(usage)) return Promise.resolve();
        const state = stateFor(ctx, sessionId, turnId);
        return enqueue(state, `record a step of turn ${turnId}`, async () => {
          const orgId = await state.org;
          if (!orgId) return;
          await deps.writeStep({
            orgId,
            eveSessionId: sessionId,
            turnId,
            actorEmail: deps.actorEmail(ctx),
            model: deps.model(),
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
          });
        });
      } catch (error) {
        deps.error(`[chat-usage] could not record a step of turn ${turnId}:`, error);
        return Promise.resolve();
      }
    },
    finishTurn(ctx, turnId, status) {
      try {
        const sessionId = ctx.session?.id;
        if (!sessionId || !turnId) return Promise.resolve();
        const key = `${sessionId}:${turnId}`;
        // A turn whose steps reported no usage has no row and no state; there is
        // nothing to close, and starting a workspace lookup now would only warn.
        const state = turns.get(key);
        if (!state) return Promise.resolve();
        turns.delete(key);
        return enqueue(state, `close turn ${turnId}`, async () => {
          const orgId = await state.org;
          if (!orgId) return;
          await deps.writeFinish({ orgId, eveSessionId: sessionId, turnId, status });
        });
      } catch (error) {
        deps.error(`[chat-usage] could not close turn ${turnId}:`, error);
        return Promise.resolve();
      }
    },
  };
}

/* ---- production dependencies --------------------------------------------- */

/**
 * The workspace for this session's caller, or null when there is no caller to
 * resolve from. `orgForSession` fails SAFE for the agent's tools (an unknown
 * identity gets an isolated workspace, none at all gets `personal:unknown`);
 * a ledger must not inherit that, so a session with no email and no hosted
 * domain resolves to nothing here, and so does a resolver refusal.
 */
async function resolveOrgForUsage(ctx: ChatUsageCtx): Promise<string | null> {
  const { email, hd } = callerFromCtx(ctx);
  if (!email && !hd) return null;
  const org = await orgForSession(ctx);
  return org && org !== "personal:unknown" ? org : null;
}

async function writeStepRow(row: ChatStepWrite): Promise<void> {
  if (!getDb()) return;
  await withOrgDb(row.orgId, (tx) =>
    tx
      .insert(chatTurnUsage)
      .values({
        orgId: row.orgId,
        eveSessionId: row.eveSessionId,
        turnId: row.turnId,
        actorEmail: row.actorEmail,
        model: row.model,
        steps: 1,
        status: "running",
        startedAt: new Date(),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      })
      .onConflictDoUpdate({
        target: [chatTurnUsage.eveSessionId, chatTurnUsage.turnId],
        // ADD, don't overwrite: every step of the turn lands on this row.
        set: {
          steps: sql`${chatTurnUsage.steps} + 1`,
          inputTokens: sql`${chatTurnUsage.inputTokens} + ${row.inputTokens}`,
          outputTokens: sql`${chatTurnUsage.outputTokens} + ${row.outputTokens}`,
          cacheReadTokens: sql`${chatTurnUsage.cacheReadTokens} + ${row.cacheReadTokens}`,
          cacheWriteTokens: sql`${chatTurnUsage.cacheWriteTokens} + ${row.cacheWriteTokens}`,
        },
      }),
  );
}

async function writeFinishRow(row: ChatFinishWrite): Promise<void> {
  if (!getDb()) return;
  await withOrgDb(row.orgId, (tx) =>
    tx
      .update(chatTurnUsage)
      .set({ status: row.status, completedAt: new Date() })
      .where(
        and(
          eq(chatTurnUsage.eveSessionId, row.eveSessionId),
          eq(chatTurnUsage.turnId, row.turnId),
          eq(chatTurnUsage.status, "running"),
        ),
      ),
  );
}

export const chatUsage: ChatUsageRecorder = createChatUsageRecorder({
  resolveOrg: resolveOrgForUsage,
  actorEmail: (ctx) => callerFromCtx(ctx).email ?? null,
  model: () => agentModelId("orchestrator"),
  writeStep: writeStepRow,
  writeFinish: writeFinishRow,
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
});
