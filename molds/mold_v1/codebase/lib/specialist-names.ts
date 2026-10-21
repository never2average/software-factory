/**
 * WHAT A SPECIALIST IS CALLED, EVERYWHERE (mold_v1-295).
 *
 * The chat named a delegation by its purpose ("Research subagent") on its card, by a robot codename picked from a
 * static pool on the Control Panel's rail ("WALL-E"), and by the raw key in the main agent's own tool results. Three
 * names for one run, none of them the one its profile or pack gave it, and two of the same kind in one chat read
 * the same on the card.
 *
 * Now every surface asks this module, with the same facts, and gets the same answer:
 *
 *   base name   the specialist's GIVEN name from its pack or profile (subagent.json "givenName", carried by the
 *               generated registry), else its purpose label (subagent.json "name", else the title-cased key) —
 *               today's name, so base code, which declares no given name, reads exactly as before.
 *   ordinal     the second delegation with the same base name in one chat is "<name> 2", the third "<name> 3", in
 *               the order the main thread called them. The first keeps the bare name, so a name never changes once
 *               shown: a later call only ever adds a higher number.
 *
 * The order is the main thread's own call order (its `subagent.called` events, or its delegation parts, which are
 * the same order), so the card, the rail, the composer, a steering note, an approval row and the main agent's
 * `stop_specialist` results (agent/lib/specialist-stop.ts) all agree on which one is "Research 2".
 *
 * Pure and dependency-free: the client (cards, rail) and the agent (its tool results) both import it. The base name
 * resolver is passed in, because the client reads the registry spoken in the profile's words
 * (app/_components/subagent-meta.generated.ts) and the agent speaks it at its own boundary.
 */

/** One delegation, in call order: its call id on the main thread and the specialist's key (`research`, `browser`). */
export interface SpecialistCall {
  readonly callId: string;
  readonly key: string;
}

/**
 * Curated purpose labels where the title-cased key reads wrong. The UI (app/_components/tool-display.ts) and the agent
 * (agent/tools/stop_specialist.ts) both read it, so the person and the main agent say the same name.
 */
export const CURATED_LABELS: Readonly<Record<string, string>> = { "follow-ups": "Follow-ups" };

/** The longest given name a pack may declare (scripts/check-subagents.py holds it to the same bound). */
export const GIVEN_NAME_MAX = 32;

/** "<name> 2": the n-th delegation (1-based) with this base name in one chat. The first is the bare name. */
export function withOrdinal(base: string, n: number): string {
  return n <= 1 ? base : `${base} ${n}`;
}

/**
 * Every delegation's display name, by call id. `baseName(key)` is the given name, else the purpose label. A call id
 * seen twice keeps the name it got first (a repeated stream event is the same delegation).
 */
export function specialistNames(calls: readonly SpecialistCall[], baseName: (key: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const c of calls) {
    if (!c.callId || out.has(c.callId)) continue;
    const base = (baseName(c.key) || c.key || "Specialist").trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(c.callId, withOrdinal(base, n));
  }
  return out;
}

interface EventLike {
  readonly type?: string;
  readonly data?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The main thread's delegations in call order, from its stream (`subagent.called`). */
export function callsFromEvents(events: readonly (EventLike | null | undefined)[]): SpecialistCall[] {
  const out: SpecialistCall[] = [];
  for (const e of events) {
    if (e?.type !== "subagent.called" || typeof e.data !== "object" || e.data === null) continue;
    const d = e.data as Record<string, unknown>;
    const callId = str(d.callId);
    const key = str(d.toolName) ?? str(d.name);
    if (callId && key) out.push({ callId, key });
  }
  return out;
}

/** The main thread's delegations in call order, from its projected messages (`eve:subagent:<key>` parts). */
export function callsFromMessages(messages: readonly { readonly parts?: readonly unknown[] }[]): SpecialistCall[] {
  const out: SpecialistCall[] = [];
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (typeof p !== "object" || p === null) continue;
      const part = p as { type?: unknown; toolName?: unknown; toolCallId?: unknown };
      const toolName = str(part.toolName);
      const callId = str(part.toolCallId);
      if (part.type === "dynamic-tool" && toolName?.startsWith("eve:subagent:") && callId) {
        out.push({ callId, key: toolName.slice("eve:subagent:".length) });
      }
    }
  }
  return out;
}

/** Two call lists as one, in the first one's order, then whatever only the second has (a stream not read whole). */
export function mergeCalls(first: readonly SpecialistCall[], second: readonly SpecialistCall[]): SpecialistCall[] {
  const seen = new Set(first.map((c) => c.callId));
  return [...first, ...second.filter((c) => !seen.has(c.callId))];
}
