/**
 * PLUMBING BETWEEN THE MAIN AGENT AND A SPECIALIST STAYS ON THE SPECIALIST'S CARD (mold_v1-296).
 *
 * The main thread is the conversation between the person and the main agent. Several things that pass between the
 * main agent and a specialist used to render there as rows of their own, between the person's messages:
 *
 *   - an approval the person gave a specialist (eve forwards it onto the main thread; once answered it folded to a
 *     one-line record in the middle of the conversation, where eve's forwarded turn id put it);
 *   - a reply to a specialist's question, and the notes the person sent a working specialist (a card each at the
 *     conversation's tail while the specialist worked: lib/specialist-questions.ts placed them "tail");
 *   - the main agent's own `stop_specialist` call (mold_v1-294), a tool row like any other.
 *
 * Each now lives on the delegation card of the specialist it concerns (and on its run in the Control Panel): the
 * approval as its one-line record, the reply and the notes under the card, the main agent's stop as the reason on the
 * card. Only when no card for that delegation is on screen (a transcript that starts after it) does anything fall back
 * to where it was. An OPEN request is never moved: its buttons stay in the stack beside the composer (mold_v1-289),
 * always on screen, with the card pointing to it.
 *
 * Pure; no React, no eve import.
 */

/** The main agent's stop tool, by its base name (agent/tools/stop_specialist.ts). No record word: never relabelled. */
export const STOP_TOOL = "stop_specialist";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** A part that is the main agent's stop call. */
export function isStopCall(part: unknown): boolean {
  return isRecord(part) && part.type === "dynamic-tool" && part.toolName === STOP_TOOL;
}

/**
 * The main agent's stops, by the call id of the delegation each stopped → the reason it gave. The tool answers with
 * that call id (agent/lib/specialist-stop.ts `stopAnswer`), which is used as it is; only an answer without one (an
 * older transcript) falls back to `callOf`, which turns the name it answered with ("Research 2") into a call id. Only
 * stops that took (`stopped: true`). The reason is read as the agent stores it: one line, never empty.
 */
export function agentStops(
  messages: readonly { readonly parts?: readonly unknown[] }[],
  callOf: (name: string) => string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (!isStopCall(p)) continue;
      const part = p as { state?: unknown; input?: unknown; output?: unknown };
      const output = isRecord(part.output) ? part.output : undefined;
      if (part.state !== "output-available" || output?.stopped !== true) continue;
      const name = str(output.name);
      const callId = str(output.callId) ?? (name ? callOf(name) : undefined);
      const reason = isRecord(part.input) ? str(part.input.reason)?.replace(/\s+/g, " ").trim() : undefined;
      if (callId) out.set(callId, reason ?? "");
    }
  }
  return out;
}

/** The transcript without the main agent's stop calls: they are said on the stopped specialist's card instead. */
export function withoutStopCalls<M extends { readonly parts?: readonly unknown[] }>(messages: readonly M[]): readonly M[] {
  let changed = false;
  const out = messages.map((m) => {
    const parts = m.parts ?? [];
    if (!parts.some(isStopCall)) return m;
    changed = true;
    return { ...m, parts: parts.filter((p) => !isStopCall(p)) };
  });
  return changed ? out : messages;
}

/** "Stopped by the main agent: <reason>" — the line on the card. Empty reason: the plain fact. */
export function stopReasonLine(reason: string): string {
  return reason ? `Stopped by the main agent: ${reason}` : "Stopped by the main agent.";
}
