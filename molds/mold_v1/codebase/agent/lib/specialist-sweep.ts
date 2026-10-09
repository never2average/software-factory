/**
 * THE SPECIALIST SWEEP — a main thread's delegations that went quiet are found and settled, once (mold_v1-196).
 *
 * The factory's own operator hit this with their helpers: some finished and their report never reached the main
 * thread; one sat silent for hours and nobody noticed. The app's main agent gets the same hygiene for its specialists.
 * For each delegation a main thread still waits on (its `subagent.called` has no result on the main thread yet), the
 * sweep reads the specialist's own stream and decides:
 *
 *   (a) FROZEN       nothing written (no event, no progress) for longer than the bound, not waiting on a person, not
 *                    waiting for a free sandbox: the main agent is given the delegation's result "stopped, and why",
 *                    once, and the specialist is stopped (its turn cancelled; a run the cancel does not reach is ended
 *                    on a later pass, which frees its sandbox).
 *   (b) UNDELIVERED  it FINISHED, and its result never reached the main agent (past a grace period in which eve hands it
 *                    back itself): that result is delivered, once. The case that bit the operator.
 *   (c) UNREPORTED   it stopped or crashed and the main agent was never told: that is delivered as its result, once.
 *   (d) WAITING      it has waited on a person's answer or approval for longer than a bound: left alone, and surfaced
 *                    (the chat says so; agent/lib/sweep-ledger.ts holds the note).
 *
 * Never a specialist that is still working (it wrote something within the bound) or that waits on a person: the same
 * line `delegation-failures.ts` draws for the run-history sweeper ("under-marking closes a run that is still working,
 * which is the one outcome the sweeper must never produce").
 *
 * HOW A RESULT REACHES THE MAIN AGENT: only through eve's own late-result path (the eve patch's per-result delegation,
 * docs/SPECIALIST_HANDBACK.md), so it is exactly once by construction. A delegation already handed over as "reports
 * later" is owed in the main thread's durable session state; the sweep's copy is a `delegationResults` delivery
 * (`delegationSweep.deliverLateResult`), and whichever copy reaches the session first — the sweep's, or the
 * specialist's own arriving late — removes the record, so the other is dropped. A delegation whose turn still waits on
 * it is first HANDED OVER (`delegationSweep.handOver`: the batch goes on as at its bound, every delegation still out as
 * "reports later" — and one whose result the turn was holding hands it over there and then), and only then delivered.
 * Two sweeps (the schedule and a turn start, two instances) race safely for the same reason; the ledger's claim
 * (one row per delegation, agent/lib/sweep-ledger.ts) keeps the second from doing the work at all.
 *
 * WHAT IT CAN NOT REACH: a delegation eve does not report itself (its `subagent.called` is not `detachable`: a session
 * started before the eve patch, a program's session, which keeps eve's own batch). The sweep leaves those as they are.
 *
 * Pure over an injected world (no eve import, no database): scripts/test-specialist-sweep.mjs drives it with streams,
 * and agent/lib/specialist-sweep-run.ts supplies the real one (eve's `delegationSweep`, the ledger, the sandbox line).
 */
import { isDetachedResult, STOPPED_CODE, STOPPED_MESSAGE } from "../../lib/detached-delegation.ts";
import type { SpecialistSweepSettings } from "./specialist-sweep-settings.ts";

export interface SweepEvent {
  readonly type?: string;
  readonly data?: Record<string, unknown> | null;
  readonly meta?: { readonly at?: unknown } | null;
}

/** A delegation the main thread has not had a result for. */
export interface OwedDelegation {
  readonly callId: string;
  /** What the main thread calls it (the tool's name). */
  readonly name: string;
  /** The specialist's own name: the result's `subagentName`. */
  readonly subagentName: string;
  readonly childSessionId: string;
  /** When it was called (ms), or NaN when eve stamped no time. */
  readonly calledAt: number;
  readonly turnId: string;
  /** "detached": handed over as "reports later"; "batch": the turn that called it still waits on it. */
  readonly where: "detached" | "batch";
  /** Does eve report it home itself (the eve patch)? Only those are swept. */
  readonly detachable: boolean;
}

/** What a specialist's own stream says about it. */
export type ChildFacts =
  | { readonly kind: "finished"; readonly at: number; readonly result: string }
  | { readonly kind: "failed"; readonly at: number; readonly message: string }
  | { readonly kind: "stopped"; readonly at: number }
  | { readonly kind: "asking"; readonly at: number }
  | { readonly kind: "live"; readonly lastAt: number; readonly started: boolean };

export type FindingKind = "frozen" | "undelivered" | "unreported" | "waiting";

/** What the sweep found about one delegation, and the result the main agent is given for it (none for "waiting"). */
export interface Finding {
  readonly kind: FindingKind;
  readonly delegation: OwedDelegation;
  /** When the condition began: the last progress, the rest, the question (ms). */
  readonly since: number;
  /** The delegation's result as the main agent reads it (an eve `subagent-result`). Absent for "waiting". */
  readonly result?: SweepResult;
  /** Plain facts the chat words a note with (lib/specialist-sweep-client.ts). */
  readonly facts: Readonly<Record<string, string | number>>;
}

export interface SweepResult {
  readonly callId: string;
  readonly kind: "subagent-result";
  readonly subagentName: string;
  readonly output: unknown;
  readonly isError?: boolean;
}

/** What the sweep did with one delegation (the ledger's status, and what the test reads). */
export type SweepAction =
  /** The main agent has the result the sweep delivered (seen on its stream). */
  | "delivered"
  /** Handing the batch over gave the main agent the specialist's OWN result: the turn had been holding it. */
  | "handed-over"
  /** Delivered to the main thread's session; the main agent has not read it yet (it is mid-turn). Checked again. */
  | "sent"
  /** Could not be done now (no batch to hand over yet, no delivery hook): the next pass tries again. */
  | "pending"
  /** Frozen inside a batch the sweep could not hand over: stopped, and eve reported the stop itself. */
  | "stopped"
  /** Left alone and surfaced. */
  | "surfaced"
  /** Another sweep holds this delegation. */
  | "held";

export interface SweepOutcome {
  readonly callId: string;
  readonly name: string;
  readonly kind: FindingKind;
  readonly action: SweepAction;
}

/** One row of the sweep's ledger (agent/lib/sweep-ledger.ts). */
export interface SweepClaim {
  readonly parentSessionId: string;
  readonly callId: string;
  readonly childSessionId: string;
  readonly name: string;
  readonly kind: FindingKind;
  readonly since: number;
  readonly facts: Readonly<Record<string, string | number>>;
}

export interface SweepLedger {
  /** The right to act on this delegation: one row per (main thread, call); a stale or unfinished claim is taken over. */
  claim(row: SweepClaim): Promise<"won" | "held">;
  /** How it went. */
  settle(parentSessionId: string, callId: string, status: SweepAction): Promise<void>;
  /** (d): the note that this delegation waits on a person (idempotent; never overwrites a claimed outcome). */
  surfaceWaiting(row: SweepClaim): Promise<void>;
  /** The waiting notes of this main thread whose delegation no longer waits are cleared. */
  clearWaiting(parentSessionId: string, stillWaiting: readonly string[]): Promise<void>;
  /** Frozen delegations of this main thread whose run may still have to be ended, and when the sweep stopped them. */
  frozenToEnd(parentSessionId: string): Promise<ReadonlyArray<{ readonly callId: string; readonly childSessionId: string; readonly stoppedAt: number }>>;
  /** That run is at rest (or ended): nothing more to do for it. */
  ended(parentSessionId: string, callId: string): Promise<void>;
}

export interface SweepWorld {
  /** A session's COMPLETE history as of now, or undefined when it cannot be read whole. */
  history(sessionId: string): Promise<readonly SweepEvent[] | undefined>;
  /** Hand over the batch waiting on one of `callIds` (eve's `delegationSweep.handOver`). */
  handOver(parentSessionId: string, callIds: readonly string[]): Promise<boolean>;
  /** Deliver a delegation's result to the main thread as a late result (eve's `delegationSweep.deliverLateResult`). */
  deliver(parentSessionId: string, continuationToken: string, result: SweepResult): Promise<boolean>;
  /** eve's cancel of the specialist's turn: its status. */
  cancel(childSessionId: string): Promise<string>;
  /** End the specialist's run (a cancel did not reach it). */
  terminate(childSessionId: string, reason: string): Promise<boolean>;
  /** Is this session waiting for a free sandbox right now (self-hosted only; agent/lib/sandbox-wait.ts)? */
  inSandboxLine(sessionId: string): boolean;
  readonly ledger: SweepLedger;
  readonly settings: Pick<SpecialistSweepSettings, "frozenMs" | "graceMs" | "waitingMs">;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/* ---- reading the streams ----------------------------------------------------------------------------------------- */

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const atOf = (e: SweepEvent | undefined): number => {
  const raw = e?.meta?.at;
  return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
};
const isNoise = (type: string) => type.endsWith(".delta") || type.endsWith(".appended");

/**
 * The delegations a main thread has had no result for, in call order. A delegation is settled by any `action.result`
 * for its call that is not the "reports later" stand-in. One the stand-in marks is `detached`; one without it is owed
 * only while the turn that called it can still be waiting on it: no later turn has started, and that turn was not
 * cancelled or failed (eve settles those itself).
 */
export function owedDelegations(events: readonly SweepEvent[]): OwedDelegation[] {
  const calls = new Map<string, Omit<OwedDelegation, "where">>();
  const standIn = new Set<string>();
  const settled = new Set<string>();
  const ended = new Set<string>();
  const turnsAfter = new Map<string, number>(); // call id → turns started after it
  for (const e of events) {
    const data = e?.data ?? {};
    const type = typeof e?.type === "string" ? e.type : "";
    if (type === "turn.started") {
      for (const id of calls.keys()) turnsAfter.set(id, (turnsAfter.get(id) ?? 0) + 1);
    } else if (type === "turn.cancelled" || type === "turn.failed") {
      if (typeof data.turnId === "string") ended.add(data.turnId);
    } else if (type === "subagent.called") {
      const callId = text(data.callId);
      const childSessionId = text(data.childSessionId);
      if (!callId || !childSessionId) continue;
      const name = text(data.name) || "specialist";
      calls.set(callId, {
        callId,
        name,
        subagentName: text(data.toolName) || name,
        childSessionId,
        calledAt: atOf(e),
        turnId: text(data.turnId),
        detachable: data.detachable === true,
      });
    } else if (type === "action.result") {
      const result = data.result as { callId?: unknown } | undefined;
      const callId = text(result?.callId);
      if (!callId) continue;
      if (isDetachedResult(result)) standIn.add(callId);
      else settled.add(callId);
    }
  }
  const out: OwedDelegation[] = [];
  for (const call of calls.values()) {
    if (settled.has(call.callId)) continue;
    if (standIn.has(call.callId)) out.push({ ...call, where: "detached" });
    else if (!turnsAfter.get(call.callId) && !ended.has(call.turnId)) out.push({ ...call, where: "batch" });
  }
  return out;
}

/**
 * The child sessions of this main thread's delegations that the sweep can never act on again (mold_v1-199): every
 * delegation its stream announced that is not owed as one eve reports home itself. Each reason is final in an
 * append-only stream (a real result is there; a later turn started or the turn was cancelled or failed, so eve settled
 * the batch; the call is not `detachable`), so the scheduled sweep need not read this main thread for them again
 * (agent/lib/sweep-ledger.ts `markSettled`). A delegation the sweep has just acted on is seen settled on the next read.
 */
export function settledChildren(events: readonly SweepEvent[]): string[] {
  const open = new Set(owedDelegations(events).filter((d) => d.detachable).map((d) => d.childSessionId));
  const out = new Set<string>();
  for (const e of events) {
    if (e?.type !== "subagent.called") continue;
    const callId = text(e.data?.callId);
    const child = text(e.data?.childSessionId);
    if (callId && child && !open.has(child)) out.add(child);
  }
  return [...out];
}

/** What a specialist's own stream says about it. `calledAt` stands in for its last progress before it wrote anything. */
export function childFacts(events: readonly SweepEvent[], calledAt: number): ChildFacts {
  const settledEvents = events.filter((e) => typeof e?.type === "string" && !isNoise(e.type));
  const types = settledEvents.map((e) => e.type as string);
  let said = "";
  let answer = "";
  for (const e of settledEvents) {
    if (e.type !== "message.completed") continue;
    const message = text(e.data?.message);
    if (!message) continue;
    said = message;
    if (e.data?.finishReason !== "tool-calls") answer = message;
  }
  const completed = settledEvents.find((e) => e.type === "session.completed");
  if (completed) return { kind: "finished", at: atOf(completed), result: answer || said };
  const failed = settledEvents.find((e) => e.type === "session.failed");
  if (failed) return { kind: "failed", at: atOf(failed), message: text(failed.data?.message) || "The specialist's session failed." };
  const last = types.length - 1;
  if (last >= 1 && types[last] === "session.waiting" && types[last - 1] === "turn.cancelled") return { kind: "stopped", at: atOf(settledEvents[last - 1]) };
  // Waiting on the person: its own request is the last thing it did (a turn that parks on it may close after it).
  const asked = types.lastIndexOf("input.requested");
  if (asked >= 0 && types.slice(asked + 1).every((t) => t === "turn.completed" || t === "session.waiting")) {
    return { kind: "asking", at: atOf(settledEvents[asked]) };
  }
  const lastAny = events.length ? atOf(events[events.length - 1]) : Number.NaN;
  return { kind: "live", lastAt: Number.isFinite(lastAny) ? lastAny : calledAt, started: types.includes("turn.started") };
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** The words the main agent reads for a frozen delegation (model-facing; neutral words only). */
export function frozenMessage(idleMs: number, frozenMs: number): string {
  return `Stopped by the system: this specialist showed no progress for ${minutes(idleMs)} minutes (the limit is ${minutes(frozenMs)}). It returned no result. If the work is still needed, call it again.`;
}

/** What to do about one owed delegation, from its own stream, or null to leave it alone. */
export function classify(
  delegation: OwedDelegation,
  facts: ChildFacts,
  now: number,
  settings: SweepWorld["settings"],
  inSandboxLine: boolean,
): Finding | null {
  const base = { callId: delegation.callId, kind: "subagent-result" as const, subagentName: delegation.subagentName };
  const name = delegation.name;
  switch (facts.kind) {
    case "finished":
      if (!(now - facts.at > settings.graceMs)) return null;
      return { kind: "undelivered", delegation, since: facts.at, result: { ...base, output: facts.result }, facts: { name } };
    case "failed":
      if (!(now - facts.at > settings.graceMs)) return null;
      return { kind: "unreported", delegation, since: facts.at, result: { ...base, isError: true, output: { code: "SUBAGENT_EXECUTION_FAILED", message: facts.message } }, facts: { name, how: "failed" } };
    case "stopped":
      if (!(now - facts.at > settings.graceMs)) return null;
      return { kind: "unreported", delegation, since: facts.at, result: { ...base, isError: true, output: { code: STOPPED_CODE, message: STOPPED_MESSAGE } }, facts: { name, how: "stopped" } };
    case "asking":
      if (!(now - facts.at > settings.waitingMs)) return null;
      return { kind: "waiting", delegation, since: facts.at, facts: { name } };
    case "live": {
      // Never on a time eve did not stamp, and never while a command waits for a free sandbox (that is a tool call
      // that has not returned yet, bounded by SANDBOX_WAIT_S, not a frozen specialist).
      if (!Number.isFinite(facts.lastAt) || inSandboxLine) return null;
      const idle = now - facts.lastAt;
      if (!(idle > settings.frozenMs)) return null;
      const message = frozenMessage(idle, settings.frozenMs);
      return {
        kind: "frozen",
        delegation,
        since: facts.lastAt,
        result: { ...base, isError: true, output: { code: STOPPED_CODE, message, reason: "no-progress" } },
        facts: { name, minutes: minutes(idle), limit: minutes(settings.frozenMs), started: facts.started ? 1 : 0 },
      };
    }
  }
}

/* ---- acting ------------------------------------------------------------------------------------------------------- */

/** The main thread's current delivery token: its latest `session.waiting` that carries one. */
export function deliveryTokenOf(events: readonly SweepEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const token = events[i]?.type === "session.waiting" ? events[i]?.data?.continuationToken : undefined;
    if (typeof token === "string" && token) return token;
  }
  return null;
}

const realResultFor = (events: readonly SweepEvent[], callId: string) =>
  events.some((e) => e?.type === "action.result" && text((e.data?.result as { callId?: unknown } | undefined)?.callId) === callId && !isDetachedResult(e.data?.result));
const standInFor = (events: readonly SweepEvent[], callId: string) =>
  events.some((e) => e?.type === "action.result" && text((e.data?.result as { callId?: unknown } | undefined)?.callId) === callId && isDetachedResult(e.data?.result));

/** How long one wait inside a pass may take (the hand-over landing, a token appearing, the delivery being read). */
export const STEP_WAIT_MS = 15_000;

async function waitFor(world: SweepWorld, sessionId: string, ok: (events: readonly SweepEvent[]) => boolean, ms: number): Promise<readonly SweepEvent[] | undefined> {
  const deadline = world.now() + ms;
  for (;;) {
    const events = await world.history(sessionId).catch(() => undefined);
    if (events && ok(events)) return events;
    if (world.now() >= deadline) return undefined;
    await world.sleep(500);
  }
}

/** Carry out (a), (b) or (c) for one delegation the sweep holds the claim for. */
async function act(world: SweepWorld, parentSessionId: string, finding: Finding, owed: readonly OwedDelegation[]): Promise<SweepAction> {
  const d = finding.delegation;
  const result = finding.result as SweepResult;
  if (d.where === "batch") {
    // Hand the batch over: every delegation of this turn the main thread still waits on, in call order (the batch's
    // sweep hook is its first delegation's; the others' hooks do not exist and are passed over).
    const batch = owed.filter((o) => o.where === "batch" && o.turnId === d.turnId).map((o) => o.callId);
    const took = await world.handOver(parentSessionId, batch);
    const after = await waitFor(world, parentSessionId, (e) => realResultFor(e, d.callId) || standInFor(e, d.callId), took ? STEP_WAIT_MS : 1_000);
    if (after && realResultFor(after, d.callId)) return "handed-over";
    if (!after) {
      if (finding.kind === "frozen" && !took) {
        // No sweep hook (a turn started under an older build): stop it all the same. eve reports the stop into the
        // batch itself, once, without the sweep's reason.
        await world.cancel(d.childSessionId).catch(() => "error");
        return "stopped";
      }
      return "pending";
    }
  }
  // It is owed as "reports later" now: deliver through the late-result path.
  const parent = await waitFor(world, parentSessionId, (e) => deliveryTokenOf(e) !== null, STEP_WAIT_MS);
  const token = parent ? deliveryTokenOf(parent) : null;
  if (!parent || !token) return "pending";
  if (realResultFor(parent, d.callId)) {
    // Settled in the meantime (its own result arrived): nothing to deliver. A frozen one is still stopped.
    if (finding.kind === "frozen") await world.cancel(d.childSessionId).catch(() => "error");
    return "delivered";
  }
  const took = await world.deliver(parentSessionId, token, result).catch(() => false);
  if (!took) return "pending";
  // Stop a frozen one only now: its own stop report, if it ever makes one, then finds the delegation already settled.
  if (finding.kind === "frozen") await world.cancel(d.childSessionId).catch(() => "error");
  const read = await waitFor(world, parentSessionId, (e) => realResultFor(e, d.callId), STEP_WAIT_MS);
  return read ? "delivered" : "sent";
}

/**
 * Sweep one main thread. Never throws; every delegation is reported in the outcome. `parentSessionId` is a main thread
 * of the workspace the ledger is scoped to (the caller decided that from the session's owner record).
 */
export async function sweepMainThread(
  world: SweepWorld,
  parentSessionId: string,
  /**
   * Counted for the scheduled pass's one log line (agent/lib/specialist-sweep-run.ts): delegations outstanding here.
   * `settled`, when given, receives `settledChildren` of the main thread as this sweep read it (mold_v1-199).
   */
  counts?: { outstanding: number; settled?: string[] },
): Promise<SweepOutcome[]> {
  const outcomes: SweepOutcome[] = [];
  let parent: readonly SweepEvent[] | undefined;
  try {
    parent = await world.history(parentSessionId);
  } catch {
    parent = undefined;
  }
  if (!parent) return outcomes;
  // A frozen specialist the sweep stopped whose run is still not at rest: end the run (it holds a sandbox).
  try {
    for (const row of await world.ledger.frozenToEnd(parentSessionId)) {
      const own = await world.history(row.childSessionId).catch(() => undefined);
      const facts = own ? childFacts(own, Number.NaN) : undefined;
      if (facts && facts.kind !== "live") await world.ledger.ended(parentSessionId, row.callId);
      else if (world.now() - row.stoppedAt > world.settings.graceMs) {
        await world.terminate(row.childSessionId, "Stopped by the system: no progress, and a cancel did not reach it.").catch(() => false);
        await world.ledger.ended(parentSessionId, row.callId);
      }
    }
  } catch (error) {
    console.error("[specialist-sweep] could not finish stopping a frozen specialist", { parentSessionId, error: error instanceof Error ? error.message : String(error) });
  }
  const owed = owedDelegations(parent).filter((d) => d.detachable);
  if (counts) counts.outstanding += owed.length;
  if (counts?.settled) counts.settled.push(...settledChildren(parent));
  const waiting: string[] = [];
  for (const d of owed) {
    try {
      const own = await world.history(d.childSessionId);
      if (!own) continue; // unreadable: decide nothing about it
      const finding = classify(d, childFacts(own, d.calledAt), world.now(), world.settings, world.inSandboxLine(d.childSessionId));
      if (!finding) continue;
      const row: SweepClaim = { parentSessionId, callId: d.callId, childSessionId: d.childSessionId, name: d.name, kind: finding.kind, since: finding.since, facts: finding.facts };
      if (finding.kind === "waiting") {
        waiting.push(d.callId);
        await world.ledger.surfaceWaiting(row);
        outcomes.push({ callId: d.callId, name: d.name, kind: finding.kind, action: "surfaced" });
        continue;
      }
      if ((await world.ledger.claim(row)) !== "won") {
        outcomes.push({ callId: d.callId, name: d.name, kind: finding.kind, action: "held" });
        continue;
      }
      let action: SweepAction = "pending";
      try {
        action = await act(world, parentSessionId, finding, owed);
      } finally {
        await world.ledger.settle(parentSessionId, d.callId, action);
      }
      outcomes.push({ callId: d.callId, name: d.name, kind: finding.kind, action });
    } catch (error) {
      console.error("[specialist-sweep] could not sweep a delegation", { parentSessionId, callId: d.callId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await world.ledger.clearWaiting(parentSessionId, waiting).catch(() => undefined);
  return outcomes;
}
