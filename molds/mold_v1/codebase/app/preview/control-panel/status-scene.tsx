"use client";

/**
 * `/preview/control-panel?scene=status` — a chat's specialists in every state, on their delegation cards AND on their
 * rows in the Control Panel (mold_v1-294..297), from the REAL AgentMessage, PendingApprovalCard and Cockpit, wired the
 * way agent-chat.tsx wires them: names from lib/specialist-names.ts, relays placed by lib/specialist-questions.ts and
 * lib/specialist-relay.ts, facts as lib/specialist-status.ts reads them. Checked by tests/specialist-status.spec.ts.
 * It lives on this page, not one of its own: a new preview page regroups the chat's first-load chunks
 * (scripts/check-bundle-budget.mjs), and this page already loads everything the scene uses.
 *
 * The main thread called nine specialists, five of one kind:
 *
 *   call_nostart research    its start failed: eve wrote no `subagent.called` for it, so the chat names it after the
 *                             ones its stream announced ("Research 5"); the Control Panel takes the chat's names, so
 *                             its row says the same though it is the first part
 *   call_run     research     running (wrote seconds ago); the person approved one of its writes and sent it a note
 *   call_wait    research     waiting on the person: its approval is open, in the stack beside the composer
 *   call_stuck   browser      running, but nothing written for 25 minutes (the bound is 10)
 *   call_ready   browser      finished in its own session; handed over as "reports later", not yet back
 *   call_done    research     its result reached the main agent
 *   call_fail    evals        failed
 *   call_stop    follow-ups   stopped by the person (the chat's Stop)
 *   call_mstop   research     still working until "The main agent stops Research 4" is clicked: the main agent's
 *                             `stop_specialist` call, then the stopped result eve delivers with its reason
 */
import { useMemo, useState } from "react";
import type { EveDynamicToolPart, EveMessage } from "eve/react";
import { AgentMessage, PendingApprovalCard } from "@/app/_components/agent-message";
import { Cockpit } from "@/app/_components/cockpit";
import { deriveInsights } from "@/app/_components/insights";
import { specialistBaseName } from "@/app/_components/tool-display";
import { pendingInputRequestParts, proxiedChildRequestIds, type TurnEvent } from "@/lib/chat-turn-state";
import { callsFromEvents, callsFromMessages, mergeCalls, specialistNames } from "@/lib/specialist-names";
import { agentStops, withoutStopCalls } from "@/lib/specialist-relay";
import { delegationCards, placeSpecialistAnswers, placeSteeringNotes, specialistAskers, withoutPlacedAnswers } from "@/lib/specialist-questions";
import type { SpecialistCardFacts } from "@/lib/specialist-status";

declare global {
  interface Window {
    /** Answers the scene's stack sent (the chat would post them to the main thread). */
    __answers?: { requestId: string; optionId?: string }[];
  }
}

const NONE: ReadonlySet<string> = new Set();
const MIN = 60_000;

const delegation = (callId: string, key: string, state: EveDynamicToolPart["state"], extra: Partial<EveDynamicToolPart> = {}): EveDynamicToolPart =>
  ({
    type: "dynamic-tool",
    toolCallId: callId,
    toolName: `eve:subagent:${key}`,
    state,
    input: { message: `Brief for ${callId}` },
    ...extra,
  }) as EveDynamicToolPart;

const APPROVE = [
  { id: "approve", label: "Approve" },
  { id: "deny", label: "Deny" },
];

/** The main thread's stream, as far as who called whom and who asked what (the chat reads these). */
function events(stopped: boolean): TurnEvent[] {
  // Plain stream events as eve writes them; the chat's readers take them as TurnEvent.
  const called = (callId: string, key: string) => ({ type: "subagent.called", data: { callId, childSessionId: `wrun_${callId}`, name: key, toolName: key, detachable: true } });
  const out: Record<string, unknown>[] = [
    { type: "turn.started", data: { turnId: "turn_0" } },
    { type: "actions.requested", data: { actions: ["call_run", "call_wait", "call_stuck", "call_ready", "call_done", "call_fail", "call_stop", "call_mstop"].map((callId) => ({ callId })) } },
    called("call_run", "research"),
    called("call_wait", "research"),
    called("call_stuck", "browser"),
    called("call_ready", "browser"),
    called("call_done", "research"),
    called("call_fail", "evals"),
    called("call_stop", "follow-ups"),
    called("call_mstop", "research"),
    // call_run's specialist asked to write a file; the person approved it (proxied: its call was never declared here).
    {
      type: "input.requested",
      data: {
        subagent: { callId: "call_run", name: "research", childSessionId: "wrun_call_run" },
        requests: [{ requestId: "req_ok", prompt: "Write notes/summary.md?", options: APPROVE, action: { callId: "child_write", toolName: "write_file", input: { path: "notes/summary.md" } } }],
      },
    },
    // call_wait's specialist asks to publish; still open.
    {
      type: "input.requested",
      data: {
        subagent: { callId: "call_wait", name: "research", childSessionId: "wrun_call_wait" },
        requests: [{ requestId: "req_open", prompt: "Publish the summary to the data room?", options: APPROVE, action: { callId: "child_publish", toolName: "publish_artifact", input: { path: "summary.md" } } }],
      },
    },
  ];
  if (stopped) out.push({ type: "action.result", data: { result: { callId: "call_mstop", kind: "subagent-result", subagentName: "research", isError: true, output: { code: "SUBAGENT_STOPPED" } } } });
  return out as unknown as TurnEvent[];
}

function messages(stopped: boolean, answered: ReadonlySet<string>): EveMessage[] {
  const waitRequest = { requestId: "req_open", prompt: "Publish the summary to the data room?", options: APPROVE, action: { toolName: "publish_artifact", input: { path: "summary.md" } } };
  const parts: EveDynamicToolPart[] = [
    delegation("call_nostart", "research", "output-error", { errorText: "The specialist could not be started." } as unknown as Partial<EveDynamicToolPart>),
    delegation("call_run", "research", "input-available"),
    delegation("call_wait", "research", answered.has("req_open") ? "input-available" : "approval-requested", {
      toolMetadata: { eve: { inputRequest: waitRequest, ...(answered.has("req_open") ? { inputResponse: { requestId: "req_open", optionId: "approve" } } : {}) } },
    } as unknown as Partial<EveDynamicToolPart>),
    delegation("call_stuck", "browser", "input-available"),
    delegation("call_ready", "browser", "output-available", { output: { status: "running", childSessionId: "wrun_call_ready", name: "browser", note: "reports later" } } as unknown as Partial<EveDynamicToolPart>),
    delegation("call_done", "research", "output-available", { output: "THE RESULT" } as unknown as Partial<EveDynamicToolPart>),
    delegation("call_fail", "evals", "output-error", { errorText: "The eval suite could not be loaded." } as unknown as Partial<EveDynamicToolPart>),
    delegation("call_stop", "follow-ups", "input-available"),
    stopped
      ? delegation("call_mstop", "research", "output-error", { errorText: "Stopped by the main agent: The person asked for FY24 only. It returned no result." } as unknown as Partial<EveDynamicToolPart>)
      : delegation("call_mstop", "research", "input-available"),
  ];
  const out: EveMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Research the filings, check the site, and run the evals." }] } as unknown as EveMessage,
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "I have asked the specialists." }, ...parts] } as unknown as EveMessage,
    // eve puts the forwarded, answered approval in a message of its own on the main thread.
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "child_write",
          toolName: "write_file",
          state: "output-available",
          input: { path: "notes/summary.md" },
          output: "ok",
          toolMetadata: { eve: { inputRequest: { requestId: "req_ok", prompt: "Write notes/summary.md?", options: APPROVE, action: { toolName: "write_file", input: { path: "notes/summary.md" } } }, inputResponse: { requestId: "req_ok", optionId: "approve" } } },
        },
      ],
    } as unknown as EveMessage,
  ];
  if (stopped) {
    out.push({
      id: "a3",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call_stop_tool",
          toolName: "stop_specialist",
          state: "output-available",
          input: { specialist: "Research 4", reason: "The person asked for FY24 only." },
          output: { stopped: true, name: "Research 4", callId: "call_mstop", message: "Research 4 was stopped." },
        },
        { type: "text", text: "I stopped Research 4: you asked for FY24 only." },
      ],
    } as unknown as EveMessage);
  }
  return out;
}

export function StatusScene() {
  const [stopped, setStopped] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(NONE);
  const [now] = useState(() => Date.now());
  const ev = useMemo(() => events(stopped), [stopped]);
  const view = useMemo(() => messages(stopped, answered), [stopped, answered]);
  // As agent-chat.tsx names them: the stream's calls in order, then any only the messages have (a failed start).
  const names = useMemo(() => specialistNames(mergeCalls(callsFromEvents(ev), callsFromMessages(messages(false, NONE))), specialistBaseName), [ev]);
  const askers = useMemo(() => specialistAskers(ev), [ev]);
  const proxied = useMemo(() => proxiedChildRequestIds(ev), [ev]);
  const placed = useMemo(() => placeSpecialistAnswers({ messages: view, askers, events: ev, stopped: new Map([["call_stop", "follow-ups"]]) }), [view, askers, ev]);
  const notes = placeSteeringNotes({
    notes: [{ id: "n1", callId: "call_run", text: "Focus on FY24 only.", status: "pending" }],
    events: ev,
    cards: delegationCards(view),
  });
  const rendered = withoutStopCalls(withoutPlacedAnswers(view, placed));
  const dock = pendingInputRequestParts({ messages: view, dismissed: NONE, responded: answered, expired: NONE, delegations: true }) as EveDynamicToolPart[];
  const below = new Set(dock.map((p) => (p.toolMetadata?.eve?.inputRequest as { requestId?: string } | undefined)?.requestId).filter((r): r is string => Boolean(r)));
  const stops = agentStops(view, (name) => [...names].find(([, n]) => n === name)?.[0]);
  const facts = useMemo(() => {
    const out = new Map<string, SpecialistCardFacts>([
      ["call_run", { lastProgressAt: now - 5_000 }],
      ["call_wait", { lastProgressAt: now - 60_000, ...(below.has("req_open") ? { waiting: true } : {}) }],
      ["call_stuck", { lastProgressAt: now - 25 * MIN }],
      ["call_ready", { childFinished: true, lastProgressAt: now - 2 * MIN }],
      ["call_done", { childFinished: true }],
      ["call_fail", {}],
      ["call_stop", { lastProgressAt: now - MIN, stoppedHere: true }],
      ["call_mstop", { lastProgressAt: now - 10_000 }],
    ]);
    for (const [callId, reason] of stops) out.set(callId, { ...out.get(callId), stopReason: reason });
    return out;
  }, [now, below, stops]);
  const isProxied = (part: { toolName?: string; type?: string }) => {
    const rid = (part as { toolMetadata?: { eve?: { inputRequest?: { requestId?: string } } } }).toolMetadata?.eve?.inputRequest?.requestId;
    return part.type === "dynamic-tool" && !part.toolName?.startsWith("eve:subagent:") && Boolean(rid && proxied.has(rid));
  };
  const insights = useMemo(() => deriveInsights(view), [view]);
  const answer = (responses: readonly { requestId: string; optionId?: string }[]) => {
    (window.__answers ??= []).push(...responses);
    setAnswered((prev) => new Set([...prev, ...responses.map((r) => r.requestId)]));
  };
  return (
    <div className="flex h-dvh" data-testid="status-scene">
      <main className="flex min-w-0 flex-1 flex-col">
        <div role="log" data-testid="thread" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto p-4">
          {rendered.map((message, i) => (
            <div key={message.id} data-testid={`msg-${message.role}`}>
              <AgentMessage
                canRespond
                hoistPendingInput
                isProxiedApproval={isProxied}
                isLast={i === rendered.length - 1}
                isStreaming={false}
                message={message}
                stoppedDelegations={new Map([["call_stop", "follow-ups"]])}
                specialistNames={names}
                specialistFacts={facts}
                specialistAnswers={placed}
                steeringNotes={notes}
                requestsBelow={below}
                onInputResponses={answer}
                turnActive={false}
              />
            </div>
          ))}
        </div>
        {/* The stack beside the composer (mold_v1-289): every open request, always on screen. */}
        <div data-pending-approvals className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2">
          {dock.map((p) => (
            <PendingApprovalCard key={p.toolCallId} part={p} onInputResponses={answer} />
          ))}
        </div>
        <div className="mx-auto flex w-full max-w-3xl gap-2 p-4 text-xs">
          <button type="button" data-testid="main-agent-stops" onClick={() => setStopped(true)}>
            The main agent stops Research 4
          </button>
        </div>
      </main>
      <aside className="flex h-dvh w-96 shrink-0 flex-col border-border border-l" data-testid="rail">
        <Cockpit insights={insights} onCollapse={() => {}} specialistFacts={facts} specialistNames={names} harvestReady />
      </aside>
    </div>
  );
}
