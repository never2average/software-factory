/**
 * THE MAIN AGENT STOPS ONE OF ITS OWN SPECIALISTS (mold_v1-294).
 *
 * The person could stop a specialist (the Control Panel's Stop, the chat's Stop); the main agent could not. A
 * specialist that had gone the wrong way, or that the person's later message made pointless, ran on until it finished
 * or the sweep found it frozen 30 minutes later. `stop_specialist` (agent/tools/stop_specialist.ts) gives the main
 * agent the same Stop, with a short reason the person reads on the specialist's card.
 *
 * IT IS THE SAME MACHINERY, NOT A SECOND ONE:
 *
 *   - the stop is eve's cancel of the specialist's own session (`delegationSweep.cancel`, the eve patch's
 *     `requestWorkflowTurnCancellation`): what the person's Stop reaches through the session guard's
 *     `POST /eve/v1/session/<child>/cancel`, a running turn cancelled or a parked one stopped through its
 *     `stop-parked` hook (docs/SPECIALIST_HANDBACK.md "Stopping");
 *   - the reason travels the way the specialist sweep's "stopped, and why" does (agent/lib/specialist-sweep.ts, a
 *     frozen delegation): delivered FIRST as the delegation's own result (`SUBAGENT_STOPPED`, through eve's late-result
 *     path, exactly once by eve's durable record), and only THEN the cancel, so the stop report eve makes itself finds
 *     the delegation settled and is dropped. The card shows the result's message, the main agent reads it on its next
 *     turn, and the Control Panel shows the run stopped;
 *   - the right to act is the sweep's ledger row (`specialist_sweeps`, kind "stopped"): one claim per delegation, so a
 *     stop racing a sweep pass, or two calls, act once; and the ledger's backstop ends a run the cancel did not reach
 *     on a later pass (`frozenToEnd`), which frees its sandbox: a stopped specialist does not keep its slot.
 *
 * SCOPE, STRICTLY THE CALLING CHAT'S OWN: the delegations it can name are the ones the CALLING session's own stream
 * announced (`subagent.called`), read by the session id eve gives the tool, never one from the model's input. Another
 * chat's specialist is not on that stream, so it cannot be named; neither can another workspace's. With a database
 * the session's owner record is checked too: the calling session must be a main thread of the workspace the tool runs
 * in, and the specialist's own record must name that main thread as its root, in the same workspace. A specialist's
 * own session (a delegation) has no specialists of its own to stop here and is refused.
 *
 * Pure over an injected world (no eve import, no database): scripts/test-specialist-stop.mjs drives it; the tool wires
 * the real one.
 */
import { isDetachedResult, STOPPED_CODE } from "../../lib/detached-delegation.ts";
import { callsFromEvents, specialistNames } from "../../lib/specialist-names.ts";
import { deliveryTokenOf, owedDelegations, type SweepClaim, type SweepEvent, type SweepResult } from "./specialist-sweep.ts";

/** The longest reason kept; the person reads it on the card. */
export const STOP_REASON_MAX = 200;

/** What the stop needs from the world. */
export interface StopWorld {
  /** A session's COMPLETE history as of now, or undefined when it cannot be read whole. */
  history(sessionId: string): Promise<readonly SweepEvent[] | undefined>;
  /** Deliver a delegation's result to the main thread as a late result (eve's `delegationSweep.deliverLateResult`). */
  deliver(parentSessionId: string, continuationToken: string, result: SweepResult): Promise<boolean>;
  /** eve's cancel of the specialist's session (the person's Stop): its status. */
  cancel(childSessionId: string): Promise<string>;
  /** The sweep's ledger, when there is a database: the claim, and how it went. */
  readonly ledger?: {
    claim(row: SweepClaim): Promise<"won" | "held">;
    settle(parentSessionId: string, callId: string, status: "delivered" | "sent" | "stopped" | "pending"): Promise<void>;
  };
  /**
   * The owner records, when there is a database: is `sessionId` a main thread of this workspace, and is `childSessionId`
   * a specialist whose root is that main thread, in the same workspace? Absent: the stream alone decides.
   */
  readonly owners?: {
    isMainThread(sessionId: string): Promise<boolean>;
    isOwnSpecialist(parentSessionId: string, childSessionId: string): Promise<boolean>;
  };
}

/** One specialist of this chat, as the main agent is told about it. */
export interface StopRosterEntry {
  /** What the person and the main agent call it (lib/specialist-names.ts). */
  readonly name: string;
  readonly callId: string;
  readonly status: "working" | "finished";
}

export type StopOutcome =
  | { readonly stopped: true; readonly name: string; readonly callId: string; readonly reason: string; readonly told: boolean }
  | {
      readonly stopped: false;
      readonly why: "not-a-main-thread" | "unreadable" | "not-found" | "ambiguous" | "already-finished" | "not-stoppable" | "held" | "not-yours" | "unreachable";
      readonly name?: string;
      readonly specialists: readonly StopRosterEntry[];
    };

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** The reason as the person reads it on the card: one line, bounded, never empty. */
export function cleanReason(reason: string): string {
  const one = reason.replace(/\s+/g, " ").trim();
  return (one || "No reason given.").slice(0, STOP_REASON_MAX);
}

/** The words the main agent reads as the stopped delegation's result, and the person reads on its card. */
export function stoppedByMainAgentMessage(reason: string): string {
  return `Stopped by the main agent: ${cleanReason(reason)} It returned no result.`;
}

/** Every specialist this chat called, in call order, with what it is called and whether it is still out. */
export function chatSpecialists(events: readonly SweepEvent[], baseName: (key: string) => string): StopRosterEntry[] {
  const names = specialistNames(callsFromEvents(events), baseName);
  const settled = new Set<string>();
  for (const e of events) {
    if (e?.type !== "action.result") continue;
    const result = e.data?.result as { callId?: unknown } | undefined;
    if (typeof result?.callId === "string" && !isDetachedResult(result)) settled.add(result.callId);
  }
  return [...names].map(([callId, name]) => ({ name, callId, status: settled.has(callId) ? "finished" : "working" }));
}

/**
 * Which of this chat's specialists `target` names: its call id, or what the chat calls it ("Research 2": the names the
 * main agent is given; the first of a kind may also be said "Research 1"), or its kind or bare base name ("research",
 * "Research", a given name's specialist by its directory name). A kind or bare base name names its one specialist, or,
 * of several, the one still working; several still working are never guessed between, even though the first of them is
 * shown with the bare name (the main agent says the kind when it means the one it just called, so a bare name is
 * ambiguous whenever more than one of the kind is out). Case, hyphens and spacing do not matter.
 */
export function resolveTarget(
  roster: readonly StopRosterEntry[],
  keys: ReadonlyMap<string, string>,
  baseName: (key: string) => string,
  target: string,
): StopRosterEntry[] {
  const t = norm(target);
  if (!t) return [];
  const byId = roster.filter((r) => r.callId === target.trim());
  if (byId.length) return byId;
  const kindOf = (r: StopRosterEntry) => keys.get(r.callId) ?? "";
  const ofKind = roster.filter((r) => norm(kindOf(r)) === t || norm(baseName(kindOf(r))) === t);
  if (ofKind.length === 1) return ofKind;
  if (ofKind.length > 1) {
    const working = ofKind.filter((r) => r.status === "working");
    // One still out: that one. Several: ambiguous (all of them). None: the shown name decides, else ambiguous.
    if (working.length >= 1) return working;
  }
  // The exact shown name, number included; the first of a kind also answers to "<name> 1".
  const byName = roster.filter((r) => norm(r.name) === t || (!/ \d+$/.test(r.name) && `${norm(r.name)} 1` === t));
  if (byName.length) return byName;
  return ofKind;
}

/**
 * Stop the specialist `target` names, one of the calling chat's own. `sessionId` is the CALLING session (eve's, never
 * the model's); `delegated` says whether that session is itself a specialist. Never throws.
 */
export async function stopSpecialist(
  world: StopWorld,
  input: { readonly sessionId: string; readonly delegated: boolean; readonly target: string; readonly reason: string; readonly baseName: (key: string) => string },
): Promise<StopOutcome> {
  const none: StopRosterEntry[] = [];
  if (input.delegated || !input.sessionId) return { stopped: false, why: "not-a-main-thread", specialists: none };
  if (world.owners && !(await world.owners.isMainThread(input.sessionId).catch(() => false))) {
    return { stopped: false, why: "not-a-main-thread", specialists: none };
  }
  const events = await world.history(input.sessionId).catch(() => undefined);
  if (!events) return { stopped: false, why: "unreadable", specialists: none };
  const roster = chatSpecialists(events, input.baseName);
  const keys = new Map(callsFromEvents(events).map((c) => [c.callId, c.key]));
  const matches = resolveTarget(roster, keys, input.baseName, input.target);
  if (matches.length === 0) return { stopped: false, why: "not-found", specialists: roster };
  if (matches.length > 1) return { stopped: false, why: "ambiguous", specialists: roster };
  const hit = matches[0];
  if (hit.status === "finished") return { stopped: false, why: "already-finished", name: hit.name, specialists: roster };
  // Only a delegation eve reports home itself, handed over to the main agent ("reports later"): one the main agent's
  // own step still waits on cannot be told apart from its step, and is the person's Stop to press.
  const owed = owedDelegations(events).find((d) => d.callId === hit.callId);
  if (!owed || !owed.detachable || owed.where !== "detached") return { stopped: false, why: "not-stoppable", name: hit.name, specialists: roster };
  if (world.owners && !(await world.owners.isOwnSpecialist(input.sessionId, owed.childSessionId).catch(() => false))) {
    return { stopped: false, why: "not-yours", name: hit.name, specialists: roster };
  }
  const reason = cleanReason(input.reason);
  if (world.ledger) {
    const claim = await world.ledger
      .claim({
        parentSessionId: input.sessionId,
        callId: owed.callId,
        childSessionId: owed.childSessionId,
        name: owed.name,
        kind: "stopped",
        since: Date.now(),
        facts: { name: hit.name, reason },
      })
      .catch(() => "held" as const);
    if (claim !== "won") return { stopped: false, why: "held", name: hit.name, specialists: roster };
  }
  // The reason first, as the delegation's own result; then eve's cancel, whose own stop report then finds it settled.
  const token = deliveryTokenOf(events);
  const result: SweepResult = {
    callId: owed.callId,
    kind: "subagent-result",
    subagentName: owed.subagentName,
    isError: true,
    output: { code: STOPPED_CODE, message: stoppedByMainAgentMessage(reason), reason: "main-agent" },
  };
  const told = token ? await world.deliver(input.sessionId, token, result).catch(() => false) : false;
  const status = await world.cancel(owed.childSessionId).catch(() => "error");
  // Told: "sent" (the backstop ends the run if the cancel missed it). Not told: "pending", which a later sweep pass may
  // take over once stale and report itself (a stop eve's own report never reached must not leave the main thread owed
  // a result forever); a "stopped" row is never taken over, so it is not written here.
  await world.ledger?.settle(input.sessionId, owed.callId, told ? "sent" : "pending").catch(() => undefined);
  // Neither the reason delivered nor the cancel made: nothing was stopped, and the card must not say it was.
  if (!told && status === "error") return { stopped: false, why: "unreachable", name: hit.name, specialists: roster };
  return { stopped: true, name: hit.name, callId: owed.callId, reason, told };
}

/** What the main agent reads back (model-facing; neutral words only). */
export function stopAnswer(outcome: StopOutcome): Record<string, unknown> {
  const roster = (outcome.stopped ? [] : outcome.specialists).map((s) => ({ name: s.name, status: s.status }));
  if (outcome.stopped) {
    return {
      stopped: true,
      name: outcome.name,
      // The delegation's own call id: the chat puts the reason on that card by it, not by a name that could drift.
      callId: outcome.callId,
      message: `${outcome.name} was stopped. The person sees your reason on its card. Its result comes back as stopped; do not wait for it, and call it again only if the work is still needed.`,
    };
  }
  const who = outcome.name ?? "That specialist";
  const message: Record<typeof outcome.why, string> = {
    "not-a-main-thread": "Only the main agent can stop its specialists, from its own chat.",
    unreadable: "This chat's history could not be read just now, so nothing was stopped. Try again in a moment.",
    "not-found": "No specialist of this chat goes by that name. Use a name from `specialists`.",
    ambiguous: "More than one specialist of this chat that is still working goes by that name. Use the exact name from `specialists`, number included; the first of a kind is \"<name> 1\".",
    "already-finished": `${who} has already finished; there is nothing to stop.`,
    "not-stoppable": `${who} is part of the step you are in and cannot be stopped from here. Its result arrives with that step; the person can stop it from its card.`,
    held: `${who} is already being stopped or settled.`,
    "not-yours": `${who} does not belong to this chat, so it was not stopped.`,
    unreachable: `${who} could not be reached just now, so it was not stopped. Try again in a few minutes.`,
  };
  return { stopped: false, message: message[outcome.why], specialists: roster };
}
