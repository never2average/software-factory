"use client";

/**
 * "Waiting for a free sandbox (3rd in line)…" in the chat, live, while a command of this chat (or of a specialist it
 * handed work to) waits for a free sandbox under the server's running cap, and gone when the sandbox opens
 * (mold_v1-194). The pure half, and when the chat asks at all, is lib/sandbox-wait-client.ts; the agent answers
 * through its session guard, for this session only (agent/lib/session-guard.ts, agent/lib/sandbox-wait.ts).
 */
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import {
  readSandboxWait,
  SANDBOX_LINE_ENABLED,
  SANDBOX_WAIT_POLL_MS,
  SANDBOX_WAIT_SEGMENT,
  sandboxWaitText,
  type SandboxWaitShown,
} from "@/lib/sandbox-wait-client";

/** After a refusal or an error, ask this much less often (the session may not be readable from here yet). */
const BACKOFF = 5;

/**
 * This chat's place in the sandbox line, asked every few seconds while `active` (a turn or a specialist runs). Null
 * when nothing waits, when it is not active, and always on a build without the sandbox cap (`enabled` false: no
 * request is ever sent).
 */
export function useSandboxWait({
  sessionId,
  active,
  getAuthHeaders,
  enabled = SANDBOX_LINE_ENABLED,
  intervalMs = SANDBOX_WAIT_POLL_MS,
}: {
  readonly sessionId: string | null | undefined;
  readonly active: boolean;
  readonly getAuthHeaders: () => Record<string, string>;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
}): SandboxWaitShown | null {
  const [shown, setShown] = useState<SandboxWaitShown | null>(null);
  // Read at each ask, so a refreshed sign-in is used and a new function identity does not restart the poll.
  const headersRef = useRef(getAuthHeaders);
  headersRef.current = getAuthHeaders;
  const on = enabled && active && Boolean(sessionId);
  useEffect(() => {
    if (!on || !sessionId) {
      setShown(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | undefined;
    const ask = async () => {
      let next = intervalMs;
      inflight = new AbortController();
      try {
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/${SANDBOX_WAIT_SEGMENT}`, {
          headers: headersRef.current(),
          cache: "no-store",
          signal: inflight.signal,
        });
        if (stopped) return;
        if (res.ok) setShown(readSandboxWait(await res.json().catch(() => null)));
        else {
          setShown(null);
          next = intervalMs * BACKOFF;
        }
      } catch {
        if (stopped) return;
        setShown(null);
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
  return on ? shown : null;
}

/** The line itself. */
export function SandboxWaitLine({ wait }: { readonly wait: SandboxWaitShown }) {
  return (
    <div
      className="flex items-center gap-2 text-muted-foreground text-xs"
      data-testid="sandbox-wait"
      data-position={wait.position}
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-3.5" />
      {sandboxWaitText(wait.position)}
    </div>
  );
}
