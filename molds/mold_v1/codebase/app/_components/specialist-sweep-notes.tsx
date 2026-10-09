"use client";

/**
 * What the specialist sweep did on this chat, said to the person (mold_v1-196): "research showed no progress for 34
 * minutes, so it was stopped. The main agent has been told.", "reviewer has been waiting for your answer for 5 hours."
 * The pure half is lib/specialist-sweep-client.ts; the agent answers through its session guard, for this main thread
 * only (agent/lib/session-guard.ts, agent/lib/sweep-ledger.ts).
 */
import { useEffect, useRef, useState } from "react";
import { readSweepNotes, SWEEP_NOTES_POLL_MS, SWEEP_NOTES_SEGMENT, sweepNoteText, type SweepNoteShown } from "@/lib/specialist-sweep-client";

/** After a refusal or an error, ask this much less often. */
const BACKOFF = 5;

/**
 * This chat's sweep notes, asked when the chat opens and every minute while `active` (the chat has delegated to a
 * specialist). Empty when there are none, and when it is not active (no request is sent).
 */
export function useSweepNotes({
  sessionId,
  active,
  getAuthHeaders,
  intervalMs = SWEEP_NOTES_POLL_MS,
}: {
  readonly sessionId: string | null | undefined;
  readonly active: boolean;
  readonly getAuthHeaders: () => Record<string, string>;
  readonly intervalMs?: number;
}): readonly SweepNoteShown[] {
  const [notes, setNotes] = useState<readonly SweepNoteShown[]>([]);
  const headersRef = useRef(getAuthHeaders);
  headersRef.current = getAuthHeaders;
  const on = active && Boolean(sessionId);
  useEffect(() => {
    if (!on || !sessionId) {
      setNotes([]);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | undefined;
    const ask = async () => {
      let next = intervalMs;
      inflight = new AbortController();
      try {
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/${SWEEP_NOTES_SEGMENT}`, {
          headers: headersRef.current(),
          cache: "no-store",
          signal: inflight.signal,
        });
        if (stopped) return;
        if (res.ok) setNotes(readSweepNotes(await res.json().catch(() => null)));
        else next = intervalMs * BACKOFF;
      } catch {
        if (stopped) return;
        next = intervalMs * BACKOFF;
      }
      if (!stopped) timer = setTimeout(ask, next);
    };
    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      inflight?.abort();
    };
  }, [on, sessionId, intervalMs]);
  return on ? notes : [];
}

/** The notes themselves: one quiet line each. */
export function SpecialistSweepNotes({ notes, now = Date.now() }: { readonly notes: readonly SweepNoteShown[]; readonly now?: number }) {
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs" data-testid="specialist-sweep-notes" role="status" aria-live="polite">
      {notes.map((note) => (
        <p key={`${note.kind}:${note.name}:${note.at}`} data-kind={note.kind}>
          {sweepNoteText(note, now)}
        </p>
      ))}
    </div>
  );
}
