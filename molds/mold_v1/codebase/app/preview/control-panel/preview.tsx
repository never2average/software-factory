"use client";

import { useEffect, useMemo, useState } from "react";
import { Cockpit } from "@/app/_components/cockpit";
import { renderCensus } from "@/lib/render-census";
import { deriveInsights, type Insights, type SubagentRun } from "@/app/_components/insights";

declare global {
  interface Window {
    /** Renders of the Control Panel in the last two minutes (lib/render-census.ts, which Cockpit notes itself in). */
    __cockpitRenders?: () => number;
    /** Notes the panel sent to a running specialist (onSteer). */
    __steers?: { callId: string; text: string }[];
  }
}

const run = (callId: string, name: string, childSessionId: string, status: SubagentRun["status"], extra: Partial<SubagentRun> = {}): SubagentRun => ({
  callId,
  name,
  childSessionId,
  status,
  activity: [`BRIEF for ${callId}`],
  ...extra,
});

/** The specialists of the chat, in the order the parent delegated them. */
const RUNS: SubagentRun[] = [
  run("call_fin_a", "research", "wrun_FIN_A", "done", { output: "A done" }),
  run("call_fin_b", "research", "wrun_FIN_B", "done", { output: "B done" }),
  run("call_fin_c", "research", "wrun_FIN_C", "done", { output: "C done" }),
  run("call_fin_d", "research", "wrun_FIN_D", "done", { output: "D done" }),
  run("call_fin_e", "research", "wrun_FIN_E", "done", { output: "E done" }),
  run("call_run", "research", "wrun_RUN", "running"),
  // Parked: the parent shows this specialist's question (a proxied input request on the delegation part).
  run("call_park", "research", "wrun_PARK", "running", {
    delegationPart: {
      type: "dynamic-tool",
      toolCallId: "call_park",
      toolName: "eve:subagent:research",
      state: "approval-requested",
      toolMetadata: { eve: { inputRequest: { requestId: "req_park", prompt: "WHICH?" } } },
    },
  }),
];

export function ControlPanelPreview() {
  const insights: Insights = useMemo(() => ({ ...deriveInsights([]), subagents: RUNS }), []);
  const [ready, setReady] = useState(false);
  const [mount, setMount] = useState(0);
  const [away, setAway] = useState(false);
  const extra = { harvestReady: ready } as Record<string, unknown>;
  useEffect(() => {
    window.__cockpitRenders = () => Number(/Cockpit×(\d+)/.exec(renderCensus(120_000, 50))?.[1] ?? 0);
  }, []);
  return (
    <div className="flex h-dvh" data-testid="control-panel-preview">
      <div className="flex flex-1 flex-col gap-2 p-4">
        <button type="button" onClick={() => setReady(true)} data-testid="mark-ready">
          The conversation is up
        </button>
        <button type="button" onClick={() => setMount((n) => n + 1)} data-testid="remount">
          Remount the panel
        </button>
        <button type="button" onClick={() => setAway((a) => !a)} data-testid="switch-chat">
          {away ? "Back to the chat" : "Open another chat"}
        </button>
      </div>
      <aside className="flex h-dvh w-96 shrink-0 flex-col border-border border-l" data-testid="rail">
        {away ? (
          <p data-testid="other-chat">Another chat</p>
        ) : (
          <Cockpit
              key={mount}
              insights={insights}
              onCollapse={() => {}}
              onSteer={async (callId, text) => {
                (window.__steers ??= []).push({ callId, text });
                return { ok: true };
              }}
              {...extra}
            />
        )}
      </aside>
    </div>
  );
}
