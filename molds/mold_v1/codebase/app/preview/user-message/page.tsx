"use client";

/**
 * Standalone preview of sent-message folding — the REAL AgentMessage over mock
 * messages, no auth, no DB, no network (dev only; see ../layout.tsx). Checked by
 * tests/user-message.spec.ts. `?scheme=light` forces nothing: the app themes by
 * prefers-color-scheme, which the test emulates.
 *
 * The last pair is "the newest prompt while its reply streams": the assistant
 * text grows on a timer so the test can expand the message above it mid-stream.
 *
 * Below the transcript, the chat's sandbox line (mold_v1-194), from the REAL hook
 * and line (app/_components/sandbox-wait-line.tsx), checked by tests/cards.spec.ts,
 * which gives the agent's answers (`/eve/v1/session/<id>/sandbox-wait`):
 *   capped     a build whose agent caps its sandboxes: asks while active, shows
 *              the place in line, clears when the sandbox opens
 *   uncapped   a build without the cap (every Vercel deployment): never asks
 * It lives on this page, beside the transcript it is part of, rather than on a
 * page of its own: preview pages are compiled into production builds too (they
 * answer 404 there), and a new one regrouped the chat page's first-load chunks.
 */
import { useEffect, useState } from "react";
import type { EveMessage } from "eve/react";
import { AgentMessage } from "@/app/_components/agent-message";
import { SandboxWaitLine, useSandboxWait } from "@/app/_components/sandbox-wait-line";

const noHeaders = () => ({});

function SandboxChat({ id, enabled, active }: { readonly id: string; readonly enabled: boolean; readonly active: boolean }) {
  const wait = useSandboxWait({ sessionId: id, active, getAuthHeaders: noHeaders, enabled, intervalMs: 250 });
  return (
    <section data-testid={`chat-${id}`} className="flex flex-col gap-2 rounded-xl border border-border p-4">
      <h2 className="font-medium text-sm">{id}</h2>
      {wait ? <SandboxWaitLine wait={wait} /> : <div data-testid="no-wait" className="text-muted-foreground text-xs">Working…</div>}
    </section>
  );
}

const FILING = Array.from(
  { length: 28 },
  (_, i) =>
    `${i + 1}. Regulation 52(4): the listed entity shall disclose line item ${i + 1} of the standalone financial results, including the debt-equity ratio and net worth.`,
).join("\n\n");
const TABLE = `Compare these:\n\n| Metric | FY24 | FY25 |\n|---|---|---|\n${Array.from({ length: 14 }, (_, i) => `| Row ${i + 1} | ${i * 3} | ${i * 4} |`).join("\n")}`;

const user = (id: string, text: string): EveMessage =>
  ({ id, role: "user", parts: [{ type: "text", text, state: "done" }] }) as EveMessage;
const assistant = (id: string, text: string, streaming = false): EveMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "step-start" }, { type: "text", text, state: streaming ? "streaming" : "done", stepIndex: 0 }],
  }) as EveMessage;

export default function UserMessagePreview() {
  const [ticks, setTicks] = useState(1);
  const [turnActive, setTurnActive] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setTicks((n) => n + 1), 150);
    return () => clearInterval(t);
  }, []);
  const messages: EveMessage[] = [
    user("short", "What changed in the March LODR amendment?"),
    assistant("a-long", FILING),
    user("long", `Summarise this filing:\n\n${FILING}`),
    user("table", TABLE),
    user("chips", `[file: Q4-results.pdf]\n[file: investor-deck.pptx]\n\nRead both, then check them against this:\n\n${FILING}`),
    user("newest", `And reconcile it with the text below.\n\n${FILING}`),
    assistant("a-stream", Array.from({ length: ticks }, (_, i) => `Streaming sentence ${i + 1}.`).join(" "), true),
  ];
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-background p-6 text-foreground">
      {messages.map((message, i) => (
        <div key={message.id} data-testid={`msg-${message.id}`}>
          <AgentMessage
            canRespond={false}
            isLast={i === messages.length - 1}
            isStreaming={message.id === "a-stream"}
            message={message}
            onInputResponses={() => {}}
            turnActive
          />
        </div>
      ))}
      <button type="button" data-testid="toggle-active" onClick={() => setTurnActive((a) => !a)} className="w-fit rounded border border-border px-2 py-1 text-xs">
        {turnActive ? "Turn running" : "Turn over"}
      </button>
      <SandboxChat id="capped" enabled active={turnActive} />
      <SandboxChat id="uncapped" enabled={false} active={turnActive} />
    </main>
  );
}
