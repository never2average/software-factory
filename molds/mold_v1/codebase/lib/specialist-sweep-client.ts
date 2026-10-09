/**
 * THE CHAT'S NOTES OF WHAT THE SPECIALIST SWEEP DID, the pure half (mold_v1-196). The hook and the notes are
 * app/_components/specialist-sweep-notes.tsx; the agent's side is agent/lib/sweep-ledger.ts behind the session guard's
 * `GET /eve/v1/session/:id/specialist-sweep` (a read, gated like the stream).
 *
 * The sweep (agent/lib/specialist-sweep.ts) settles a main thread's delegations that went quiet: a frozen specialist is
 * stopped and the main agent told why; a finished one whose result never arrived has it handed back; one that stopped
 * or failed without reporting is reported; one that waits on the person for hours is left alone and surfaced. The main
 * agent sees each outcome as that delegation's result, on its card; these notes tell the PERSON.
 *
 * The words are the deployment profile's (`chat.specialist_sweep`): a deployment that calls its specialists something
 * else says so there.
 */
import { DEPLOYMENT_PROFILE, fillProfileText } from "./deployment-profile.generated.ts";

/** The session route segment the notes are read from (lib/chat-gate.ts counts it as a read). */
export const SWEEP_NOTES_SEGMENT = "specialist-sweep";

/** How often an open chat that has delegated asks. The sweep itself runs every 5 minutes and at each turn start. */
export const SWEEP_NOTES_POLL_MS = 60_000;

/** One note, as the agent answers it (names and plain facts; never a session id). */
export interface SweepNoteShown {
  readonly kind: "frozen" | "undelivered" | "unreported" | "waiting";
  readonly status: string;
  readonly name: string;
  readonly facts: Readonly<Record<string, string | number>>;
  /** When the condition began (ms), or null. */
  readonly since: number | null;
  /** When the sweep last acted (ms). */
  readonly at: number;
}

const KINDS = new Set(["frozen", "undelivered", "unreported", "waiting"]);

/** The agent's answer, read defensively: anything unexpected is left out. */
export function readSweepNotes(body: unknown): SweepNoteShown[] {
  const notes = (body as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) return [];
  const out: SweepNoteShown[] = [];
  for (const n of notes) {
    const r = n as Record<string, unknown> | null;
    if (!r || typeof r.kind !== "string" || !KINDS.has(r.kind) || typeof r.name !== "string" || !r.name.trim()) continue;
    out.push({
      kind: r.kind as SweepNoteShown["kind"],
      status: typeof r.status === "string" ? r.status : "",
      name: r.name.trim(),
      facts: r.facts && typeof r.facts === "object" ? (r.facts as Record<string, string | number>) : {},
      since: typeof r.since === "number" && Number.isFinite(r.since) ? r.since : null,
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
    });
  }
  return out;
}

/** "45 minutes", "5 hours", "2 days": how long something has waited, in whole units. */
export function waitedText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

type Words = { frozen: string; undelivered: string; stopped: string; failed: string; waiting: string };

/** The sentence a person reads for a note, in this deployment's words. */
export function sweepNoteText(note: SweepNoteShown, now: number = Date.now(), words: Words = DEPLOYMENT_PROFILE.chat.specialist_sweep): string {
  const name = note.name;
  switch (note.kind) {
    case "frozen":
      return fillProfileText(words.frozen, { name, minutes: Number(note.facts.minutes) || 0 });
    case "undelivered":
      return fillProfileText(words.undelivered, { name });
    case "unreported":
      return fillProfileText(note.facts.how === "failed" ? words.failed : words.stopped, { name });
    case "waiting":
      return fillProfileText(words.waiting, { name, waited: waitedText(now - (note.since ?? now)) });
  }
}
