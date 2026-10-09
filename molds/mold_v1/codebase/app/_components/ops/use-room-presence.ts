"use client";
import { useEffect, useRef, useState } from "react";
import { authToken } from "./lib";

function authHeaders(): Record<string, string> {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface PresentPerson {
  email: string;
  activity: string | null;
}

/**
 * Workspace-scoped presence for a room (e.g. `readiness` or `readiness:acme`).
 * Heartbeats every ~10s while mounted and returns everyone else currently in
 * the room (seen in the last ~25s). Polled — Vercel has no WebSockets. Pass a
 * falsy `room` to disable (e.g. before data loads). `activity` is an optional
 * short label of what the caller is doing, sent with each heartbeat.
 */
export function useRoomPresence(room: string | null, activity?: string | null): PresentPerson[] {
  const [online, setOnline] = useState<PresentPerson[]>([]);
  const activityRef = useRef<string | null | undefined>(activity);
  activityRef.current = activity;

  useEffect(() => {
    if (!room) {
      setOnline([]);
      return;
    }
    let alive = true;
    const beat = async () => {
      try {
        const res = await fetch("/api/ops/presence", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ room, activity: activityRef.current ?? null }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { online?: PresentPerson[] };
        if (alive) setOnline(data.online ?? []);
      } catch {
        /* transient — next beat retries */
      }
    };
    void beat();
    const t = setInterval(beat, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [room]);

  return online;
}
