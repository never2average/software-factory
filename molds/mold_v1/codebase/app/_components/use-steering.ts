"use client";

/**
 * The chat's side of notes to a running specialist (mold_v1-235; lib/steering-client.ts has the route). Reads this main
 * thread's notes once it has delegated, polls while a note waits for its specialist's next step, and sends a note.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { refusalText } from "@/lib/specialist-run-actions";
import { type SteeringNote, steerPath } from "@/lib/steering-client";

const POLL_MS = 4_000;

export function useSteering({
  sessionId,
  headers,
  delegated,
  running,
}: {
  /** The main thread's session; null before it has one. */
  readonly sessionId: string | null | undefined;
  readonly headers: () => Record<string, string>;
  /** The thread has delegated to a specialist: its notes are worth reading. */
  readonly delegated: boolean;
  /** A specialist is working now: a pending note may be read any moment. */
  readonly running: boolean;
}) {
  const [notes, setNotes] = useState<readonly SteeringNote[]>([]);
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(steerPath(sessionId), { headers: headersRef.current(), cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { notes?: SteeringNote[] } | null;
      if (Array.isArray(body?.notes)) setNotes(body.notes);
    } catch {
      /* the next poll tries again */
    }
  }, [sessionId]);

  useEffect(() => {
    setNotes([]);
    if (sessionId && delegated) void refresh();
  }, [sessionId, delegated, refresh]);

  const waiting = notes.some((n) => n.status === "pending");
  useEffect(() => {
    if (!sessionId || !waiting || !running) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [sessionId, waiting, running, refresh]);

  /** Send a note; on a refusal, the agent's own words. */
  const send = useCallback(
    async (callId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!sessionId) return { ok: false, message: "This chat has not started yet." };
      try {
        const res = await fetch(steerPath(sessionId), {
          method: "POST",
          headers: { "content-type": "application/json", ...headersRef.current() },
          body: JSON.stringify({ callId, text }),
        });
        if (!res.ok) return { ok: false, message: await refusalText(res, "The note was not sent. Try again in a moment.") };
        const body = (await res.json().catch(() => null)) as { note?: SteeringNote } | null;
        const note = body?.note;
        if (note) setNotes((prev) => (prev.some((n) => n.id === note.id) ? prev : [...prev, note]));
        return { ok: true };
      } catch {
        return { ok: false, message: "The note was not sent: this page lost its connection. Try again in a moment." };
      }
    },
    [sessionId],
  );

  return { notes, send, refresh };
}
