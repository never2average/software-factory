/**
 * A session's stream, passed through line by line, with each subagent delegation noticed on the way.
 *
 * A subagent's child session is created by eve, not by a caller, so no create route ever records its owner. Its id
 * reaches a client in exactly one way: the parent's `subagent.called` event (`data.childSessionId`), on the parent's
 * stream — and every read of that stream goes through the agent's session guard (agent/lib/session-guard.ts). So the
 * guard reads its own output: for each `subagent.called` line it records the child's owner (inherited from the
 * parent, lib/session-gate.ts) BEFORE that line is forwarded. By the time any client, on any instance, knows a child
 * id, the child has an owner on record; the chat's subagent rail, the run timeline and the workflow delegate open it
 * directly.
 *
 * Why not something else, measured against eve 0.25.1: authored hooks never see `subagent.called` (it is written by
 * eve's action-dispatch step, which runs no hooks — only turn-step events reach them), and the child's own
 * `session.started` carries no `invocation`/parent in this version (harness/emission.js passes only `runtime`).
 *
 * Every other line — and every byte — is forwarded unchanged. A failed record is logged and the line still goes
 * out: the child is then simply refused later (fail closed), which is better than a stalled transcript.
 */
export function noticeDelegations(
  upstream: ReadableStream<Uint8Array>,
  onChild: (childSessionId: string) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let partial = "";

  const inspect = async (line: string) => {
    if (!line.includes("subagent.called")) return;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { childSessionId?: unknown } };
      const child = event?.type === "subagent.called" ? event.data?.childSessionId : undefined;
      if (typeof child === "string" && child) await onChild(child);
    } catch (error) {
      console.error("[session-guard] could not record a delegated child session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return new ReadableStream<Uint8Array>({
    // One pull produces one chunk or ends the stream (see lib/chat-replay-stream.ts for why it must not return
    // empty-handed); a chunk with no newline is held until its line is complete.
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          if (partial) {
            await inspect(partial);
            controller.enqueue(encoder.encode(partial));
          }
          partial = "";
          controller.close();
          return;
        }
        partial += decoder.decode(next.value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        if (!lines.length) continue;
        for (const line of lines) await inspect(line);
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
        return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}
