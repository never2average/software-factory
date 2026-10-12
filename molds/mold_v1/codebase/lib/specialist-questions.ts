/**
 * WHO IS ASKING — a delegated specialist's question on the main thread, and the person's reply to it (mold_v1-234).
 *
 * A specialist that needs the person calls its question tool; eve parks it and forwards the question onto the main
 * thread as an `input.requested`, and the person's answer goes back to that specialist by request id
 * (lib/chat-turn-state.ts `proxiedChildRequestIds` has the routing). eve 0.25.1 forwarded the question WITHOUT saying
 * which delegation asked it, and nothing on the main thread recorded the answer at all. So the chat could not name the
 * asker, the reply rendered as a plain bubble in the main thread ("Your answer"), and a reload knew neither.
 *
 * Now:
 *   - the forwarded question carries `data.subagent: { callId, name, childSessionId }` (patches/eve+0.25.1.patch,
 *     scripts/eve-patch/changes.mjs "whose question it is");
 *   - a stream recorded before that patch is attributed only when it is unambiguous: exactly one delegation is live
 *     when the question arrives. Otherwise the question stays unattributed and renders as it always has;
 *   - the reply is persisted as the chat's `client.input.responded` marker WITH the same attribution
 *     (`answerMarker`), so a reload, another device, and the history files it under the specialist and its run.
 *
 * Pure; no React, no eve import. The UI says the names (app/_components/specialist-question.tsx).
 */
import { isDetachedResult, isStoppedDelegation } from "./detached-delegation.ts";

/** Which delegation asked: its call id on the main thread, the specialist's registry name, its own session (run). */
export interface SpecialistAsker {
  readonly callId: string;
  readonly name: string;
  readonly childSessionId?: string;
  /** "event": the stream said so; "inferred": the only live delegation; "marker": the reply's own record said so. */
  readonly source: "event" | "inferred" | "marker";
}

/** Where the specialist is, after the person replied. */
export type SpecialistProgress = "working" | "reports-later" | "finished" | "failed" | "stopped";

/** One reply the person gave a specialist, as the chat persists it. */
export interface SpecialistReply {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
}

interface EventLike {
  readonly type?: string;
  readonly data?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** `data.subagent` as the patched eve (or a reply marker) writes it; undefined when absent or malformed. */
export function readAsker(raw: unknown, source: SpecialistAsker["source"]): SpecialistAsker | undefined {
  if (!isRecord(raw)) return undefined;
  const callId = str(raw.callId);
  const name = str(raw.name);
  if (!callId || !name) return undefined;
  const childSessionId = str(raw.childSessionId);
  return { callId, name, ...(childSessionId ? { childSessionId } : {}), source };
}

/**
 * Every question a delegated specialist asked on this stream, by request id → who asked it.
 *
 * The person's own reply markers (`client.input.responded` carrying `data.subagent`) count too: a stream recorded
 * before the patch, answered after it, keeps the attribution the chat had when the person replied. A question that
 * cannot be attributed is simply absent, and the UI shows it as it always has.
 */
export function specialistAskers(events: readonly (EventLike | null | undefined)[]): ReadonlyMap<string, SpecialistAsker> {
  const out = new Map<string, SpecialistAsker>();
  const declared = new Set<string>();
  /** Delegations called and not settled (a "reports later" stand-in does not settle one), in call order. */
  const live = new Map<string, { name: string; childSessionId?: string }>();
  let sawDelegation = false;
  for (const e of events) {
    if (!e?.type) continue;
    const data = isRecord(e.data) ? e.data : {};
    switch (e.type) {
      case "actions.requested":
        for (const a of Array.isArray(data.actions) ? data.actions : []) {
          const id = isRecord(a) ? str(a.callId) : undefined;
          if (id) declared.add(id);
        }
        break;
      case "subagent.called": {
        const callId = str(data.callId);
        if (!callId) break;
        sawDelegation = true;
        const childSessionId = str(data.childSessionId);
        live.set(callId, { name: str(data.name) ?? str(data.toolName) ?? "", ...(childSessionId ? { childSessionId } : {}) });
        break;
      }
      case "action.result": {
        const result = isRecord(data.result) ? data.result : undefined;
        const callId = str(result?.callId);
        if (callId && !isDetachedResult(result)) live.delete(callId);
        break;
      }
      case "input.requested": {
        const stated = readAsker(data.subagent, "event");
        for (const r of Array.isArray(data.requests) ? data.requests : []) {
          if (!isRecord(r)) continue;
          const requestId = str(r.requestId);
          if (!requestId) continue;
          if (stated) {
            out.set(requestId, stated);
            continue;
          }
          // Unpatched stream: proxied (its call was never declared on this thread) and only ONE delegation could
          // have asked it. Anything less certain is left unattributed.
          const callId = isRecord(r.action) ? str(r.action.callId) : undefined;
          const proxied = sawDelegation && callId !== undefined && !declared.has(callId);
          if (!proxied || live.size !== 1 || out.has(requestId)) continue;
          const [[onlyCallId, only]] = [...live];
          if (!only.name) continue;
          out.set(requestId, {
            callId: onlyCallId,
            name: only.name,
            ...(only.childSessionId ? { childSessionId: only.childSessionId } : {}),
            source: "inferred",
          });
        }
        break;
      }
      case "client.input.responded": {
        const marked = readAsker(data.subagent, "marker");
        if (!marked) break;
        for (const r of Array.isArray(data.responses) ? data.responses : []) {
          const requestId = isRecord(r) ? str(r.requestId) : undefined;
          if (requestId && !out.has(requestId)) out.set(requestId, marked);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * The marker a reply is persisted as. The same `client.input.responded` eve's reducer reads (an answered question
 * stays answered on reload), plus WHO it went to: the specialist's name, its delegation's call id and its run.
 */
export function answerMarker(
  reply: SpecialistReply,
  asker: SpecialistAsker | undefined,
): { type: "client.input.responded"; data: { responses: SpecialistReply[]; subagent?: Omit<SpecialistAsker, "source"> } } {
  const response: SpecialistReply = {
    requestId: reply.requestId,
    ...(reply.optionId !== undefined ? { optionId: reply.optionId } : {}),
    ...(reply.text !== undefined ? { text: reply.text } : {}),
  };
  if (!asker) return { type: "client.input.responded", data: { responses: [response] } };
  return {
    type: "client.input.responded",
    data: {
      responses: [response],
      subagent: { callId: asker.callId, name: asker.name, ...(asker.childSessionId ? { childSessionId: asker.childSessionId } : {}) },
    },
  };
}

/**
 * Where a delegation stands, from the main thread's stream: still working (or handed over as "reports later"), or
 * settled — finished, failed, or stopped. `stopped` is the chat's own Stop record (eve writes nothing for a Stop).
 */
export function delegationProgress(
  events: readonly (EventLike | null | undefined)[],
  callId: string,
  stopped?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): SpecialistProgress {
  let state: SpecialistProgress = "working";
  for (const e of events) {
    if (e?.type !== "action.result") continue;
    const data = isRecord(e.data) ? e.data : {};
    const result = isRecord(data.result) ? data.result : undefined;
    if (str(result?.callId) !== callId) continue;
    if (isDetachedResult(result)) {
      state = "reports-later";
      continue;
    }
    state = result?.isError === true ? (isStoppedDelegation(result.output) ? "stopped" : "failed") : "finished";
  }
  if ((state === "working" || state === "reports-later") && stopped?.has(callId)) return "stopped";
  return state;
}

/** Is the delegation still going (the person's reply is being worked on)? */
export const progressIsLive = (p: SpecialistProgress): boolean => p === "working" || p === "reports-later";

/**
 * The person is answering ONE specialist when every open question that is attributed belongs to it. Two specialists
 * asking at once, or nothing attributed, is no single "you are answering" — the composer then says nothing extra.
 */
export function answeringWhom(
  openRequestIds: readonly string[],
  askers: ReadonlyMap<string, SpecialistAsker>,
): SpecialistAsker | undefined {
  let whom: SpecialistAsker | undefined;
  for (const id of openRequestIds) {
    const a = askers.get(id);
    if (!a) return undefined;
    if (whom && whom.callId !== a.callId) return undefined;
    whom = whom ?? a;
  }
  return whom;
}

/**
 * The chat's answered-input markers, ready to persist: one `client.input.responded` per answered request (eve's
 * reducer needs it to keep a question answered on reload), each carrying its specialist when one asked it
 * (`answerMarker`). Two sources, as before: answers recorded on the parts, and the answers this chat posted itself
 * (`extra`; a directly delivered answer never reaches the part).
 */
export function respondedInputMarkers(
  messages: readonly { readonly parts?: readonly unknown[] }[],
  extra: Readonly<Record<string, SpecialistReply>>,
  askers: ReadonlyMap<string, SpecialistAsker>,
): ReturnType<typeof answerMarker>[] {
  const byId = new Map<string, SpecialistReply>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (!isRecord(p) || p.type !== "dynamic-tool") continue;
      const meta = isRecord(p.toolMetadata) && isRecord(p.toolMetadata.eve) ? p.toolMetadata.eve : undefined;
      const resp = meta && isRecord(meta.inputResponse) ? meta.inputResponse : undefined;
      const requestId = str(resp?.requestId);
      if (resp && requestId) byId.set(requestId, resp as unknown as SpecialistReply);
    }
  }
  for (const [rid, resp] of Object.entries(extra)) if (rid) byId.set(rid, resp);
  return [...byId.values()].map((resp) => answerMarker(resp, askers.get(resp.requestId)));
}

/**
 * A specialist's answered question, as the chat places it. `where`: "tail" while the specialist works on the reply
 * (under the conversation, where the question was asked), "card" once it has handed back (under its delegation card,
 * in the history), "inplace" when no delegation card is on screen (where eve put the part). An answer whose asker is
 * unknown is not placed at all: it renders as it always has.
 */
export interface SpecialistAnswerView {
  readonly requestId: string;
  /** The delegation's call id on the main thread. */
  readonly callId: string;
  /** The specialist's registry name (the UI shows it through the registry's display name). */
  readonly name: string;
  readonly prompt: string;
  readonly reply: string;
  readonly progress: SpecialistProgress;
  readonly where: "tail" | "card" | "inplace";
}

/** Every attributed, answered question in the projected transcript, by request id, with where it renders. */
export function placeSpecialistAnswers(input: {
  readonly messages: readonly { readonly parts?: readonly unknown[] }[];
  readonly askers: ReadonlyMap<string, SpecialistAsker>;
  readonly events: readonly (EventLike | null | undefined)[];
  readonly stopped?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}): ReadonlyMap<string, SpecialistAnswerView> {
  const cards = new Set<string>();
  const answered: Omit<SpecialistAnswerView, "where">[] = [];
  const progressOf = new Map<string, SpecialistProgress>();
  for (const m of input.messages) {
    for (const p of m.parts ?? []) {
      if (!isRecord(p) || p.type !== "dynamic-tool") continue;
      const toolName = str(p.toolName);
      const toolCallId = str(p.toolCallId);
      if (toolName?.startsWith("eve:subagent:") && toolCallId) cards.add(toolCallId);
      const meta = isRecord(p.toolMetadata) && isRecord(p.toolMetadata.eve) ? p.toolMetadata.eve : undefined;
      const req = meta && isRecord(meta.inputRequest) ? meta.inputRequest : undefined;
      const resp = meta && isRecord(meta.inputResponse) ? meta.inputResponse : undefined;
      const requestId = str(req?.requestId);
      const asker = requestId ? input.askers.get(requestId) : undefined;
      if (!req || !resp || !requestId || !asker) continue;
      const options = Array.isArray(req.options) ? req.options.filter(isRecord) : [];
      const text = typeof resp.text === "string" ? resp.text.trim() : "";
      const optionId = str(resp.optionId);
      const reply = text || str(options.find((o) => o.id === optionId)?.label) || optionId || "";
      let progress = progressOf.get(asker.callId);
      if (progress === undefined) {
        progress = delegationProgress(input.events, asker.callId, input.stopped);
        progressOf.set(asker.callId, progress);
      }
      answered.push({ requestId, callId: asker.callId, name: asker.name, prompt: str(req.prompt) ?? "", reply, progress });
    }
  }
  const out = new Map<string, SpecialistAnswerView>();
  for (const a of answered) {
    out.set(a.requestId, { ...a, where: progressIsLive(a.progress) ? "tail" : cards.has(a.callId) ? "card" : "inplace" });
  }
  return out;
}

/** The delegation cards on screen: the call ids of every `eve:subagent:*` part in the projected transcript. */
export function delegationCards(messages: readonly { readonly parts?: readonly unknown[] }[]): ReadonlySet<string> {
  const cards = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (!isRecord(p) || p.type !== "dynamic-tool") continue;
      const toolName = str(p.toolName);
      const toolCallId = str(p.toolCallId);
      if (toolName?.startsWith("eve:subagent:") && toolCallId) cards.add(toolCallId);
    }
  }
  return cards;
}

/** A note the person sent a running specialist (mold_v1-235), as the chat places it. */
export interface SteeringNoteView {
  readonly id: string;
  readonly callId: string;
  /** The specialist's registry name. */
  readonly name: string;
  readonly text: string;
  /** "delivered": the specialist read it at a step; "pending": not yet. */
  readonly status: "pending" | "delivered";
  readonly progress: SpecialistProgress;
  /** "tail" while the specialist works; "card" under its delegation card once it has handed back (or none is shown). */
  readonly where: "tail" | "card";
}

/** Every note of this main thread whose delegation is on its stream, with where it renders and how it stands. */
export function placeSteeringNotes(input: {
  readonly notes: readonly { readonly id: string; readonly callId: string; readonly text: string; readonly status: "pending" | "delivered" }[];
  readonly events: readonly (EventLike | null | undefined)[];
  readonly cards: ReadonlySet<string>;
  readonly stopped?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}): SteeringNoteView[] {
  if (input.notes.length === 0) return [];
  const names = new Map<string, string>();
  for (const e of input.events) {
    if (e?.type !== "subagent.called" || !isRecord(e.data)) continue;
    const callId = str(e.data.callId);
    const name = str(e.data.name) ?? str(e.data.toolName);
    if (callId && name) names.set(callId, name);
  }
  const progressOf = new Map<string, SpecialistProgress>();
  const out: SteeringNoteView[] = [];
  for (const n of input.notes) {
    const name = names.get(n.callId);
    if (!name) continue;
    let progress = progressOf.get(n.callId);
    if (progress === undefined) {
      progress = delegationProgress(input.events, n.callId, input.stopped);
      progressOf.set(n.callId, progress);
    }
    out.push({
      id: n.id,
      callId: n.callId,
      name,
      text: n.text,
      status: n.status,
      progress,
      where: progressIsLive(progress) || !input.cards.has(n.callId) ? "tail" : "card",
    });
  }
  return out;
}

/**
 * The transcript as the chat renders it: a specialist's answered question placed on its card ("tail" or "card") is
 * taken out of the message eve put it in, so the message neither shows it nor counts it as content. Messages it does
 * not touch are returned as they are (the same objects).
 */
export function withoutPlacedAnswers<M extends { readonly parts?: readonly unknown[] }>(
  messages: readonly M[],
  placed: ReadonlyMap<string, { readonly where: string }>,
): readonly M[] {
  if (placed.size === 0) return messages;
  let changed = false;
  const out = messages.map((m) => {
    const parts = m.parts ?? [];
    const kept = parts.filter((p) => {
      if (!isRecord(p) || p.type !== "dynamic-tool") return true;
      const meta = isRecord(p.toolMetadata) && isRecord(p.toolMetadata.eve) ? p.toolMetadata.eve : undefined;
      const rid = meta && isRecord(meta.inputRequest) ? str(meta.inputRequest.requestId) : undefined;
      const where = rid ? placed.get(rid)?.where : undefined;
      return where === undefined || where === "inplace";
    });
    if (kept.length === parts.length) return m;
    changed = true;
    return { ...m, parts: kept };
  });
  return changed ? out : messages;
}
