"use client";

import { resolveTextToResponses } from "eve/client";
import type { EveMessage } from "eve/react";
import { useEffect, useMemo, useState } from "react";
import { AgentMessage, PendingApprovalCard } from "@/app/_components/agent-message";
import { subagentDisplayName } from "@/app/_components/tool-display";
import {
  ComposerTargetRow,
  type ComposerTarget,
  SpecialistAnsweredCard,
  SpecialistNotesCard,
  SpecialistQuestionFrame,
} from "@/app/_components/specialist-question";
import {
  deadInputRequestIds,
  liveDelegations,
  pendingInputRequestParts,
  proxiedChildRequestIds,
  type TurnEvent,
  withResponses,
} from "@/lib/chat-turn-state";
import {
  answeringWhom,
  delegationCards,
  placeSpecialistAnswers,
  placeSteeringNotes,
  respondedInputMarkers,
  specialistAskers,
  type SpecialistReply,
} from "@/lib/specialist-questions";

/** This page's own copy of what a chat persists: its stage, and its answered-input markers. */
const KEY_BASE = "preview.specialist-question";
interface Saved {
  readonly stage: "live" | "done";
  readonly markers: readonly unknown[];
  /** Notes sent to a running specialist, as the steer route keeps them (mold_v1-235). */
  readonly notes?: readonly { id: string; callId: string; text: string; status: "pending" | "delivered" }[];
}
const NONE: ReadonlySet<string> = new Set();

/**
 * The chat's tail, transcript and composer row for a specialist's question, over a recorded stream (see ./page.tsx).
 * The same pieces agent-chat.tsx mounts: AgentMessage, PendingApprovalCard in SpecialistQuestionFrame,
 * SpecialistAnsweredCard, AnsweringLabel, and lib/specialist-questions for who asked and where the reply goes.
 */
export function SpecialistQuestionPreview({
  live,
  done,
  fallback,
}: {
  /** Nothing can say who asked (a stream before the patch, two delegations live): the chat renders as it always did. */
  readonly fallback?: boolean;
  readonly live: { readonly events: readonly TurnEvent[]; readonly messages: readonly EveMessage[] };
  readonly done: { readonly events: readonly TurnEvent[]; readonly messages: readonly EveMessage[] };
}) {
  const KEY = fallback ? `${KEY_BASE}.fallback` : KEY_BASE;
  const [saved, setSaved] = useState<Saved | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState("auto");
  const [held, setHeld] = useState<string[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      setSaved(raw ? (JSON.parse(raw) as Saved) : { stage: "live", markers: [] });
    } catch {
      setSaved({ stage: "live", markers: [] });
    }
  }, [KEY]);
  const save = (next: Saved) => {
    setSaved(next);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  };

  const stage = saved?.stage ?? "live";
  const base = stage === "done" ? done : live;
  /** The stream as a reopened chat has it: eve's events, then the chat's persisted markers. */
  const events = useMemo(() => [...base.events, ...((saved?.markers ?? []) as TurnEvent[])], [base, saved]);
  /** The answers the markers record, folded into the view the way agent-chat folds its own (withResponses). */
  const answers = useMemo(() => {
    const out: Record<string, SpecialistReply> = {};
    for (const m of (saved?.markers ?? []) as { data?: { responses?: SpecialistReply[] } }[]) {
      for (const r of m.data?.responses ?? []) out[r.requestId] = r;
    }
    return out;
  }, [saved]);
  const messages = useMemo(() => withResponses(base.messages, answers), [base, answers]);
  const askers = useMemo(() => (fallback ? new Map() : specialistAskers(events)), [events, fallback]);
  const placed = useMemo(
    () => placeSpecialistAnswers({ messages: messages as readonly { parts?: readonly unknown[] }[], askers, events }),
    [messages, askers, events],
  );
  const proxied = useMemo(() => proxiedChildRequestIds(events), [events]);
  const dead = useMemo(() => deadInputRequestIds(events as { type?: string }[]), [events]);
  const pending = useMemo(
    () =>
      pendingInputRequestParts({
        messages: messages as readonly { parts?: readonly unknown[] }[],
        dismissed: NONE,
        responded: new Set(Object.keys(answers)),
        expired: NONE,
      }).filter((p) => {
        const rid = (p as { toolMetadata?: { eve?: { inputRequest?: { requestId?: string } } } }).toolMetadata?.eve
          ?.inputRequest?.requestId;
        return rid && !dead.has(rid);
      }) as Array<React.ComponentProps<typeof PendingApprovalCard>["part"]>,
    [messages, answers, dead],
  );
  const open = pending.map((p) => p.toolMetadata?.eve?.inputRequest).filter((r) => r !== undefined);
  const whom = answeringWhom(
    open.map((r) => r.requestId),
    askers,
  );
  // The composer's targets, exactly as agent-chat builds them: the main chat, then each running specialist.
  const running = liveDelegations(events);
  const targets: ComposerTarget[] = [
    { id: "main" },
    ...running.map((d) => ({ id: d.callId, name: d.name, ...(whom?.callId === d.callId ? { asking: true } : {}) })),
  ];
  const target = targets.find((t) => t.id === picked) ?? targets.find((t) => t.asking) ?? targets[0];
  const notes = placeSteeringNotes({
    notes: saved?.notes ?? [],
    events,
    cards: delegationCards(messages as readonly { parts?: readonly unknown[] }[]),
  });
  const [steerError, setSteerError] = useState<string | null>(null);

  const answer = (responses: readonly SpecialistReply[]) => {
    const nextAnswers = { ...answers };
    for (const r of responses) nextAnswers[r.requestId] = r;
    const view = withResponses(base.messages, nextAnswers);
    save({ stage, markers: respondedInputMarkers(view, nextAnswers, askers), notes: saved?.notes ?? [] });
    setPicked("auto");
  };
  const submit = () => {
    const raw = text.trim();
    if (!raw) return;
    setText("");
    if (target.id !== "main" && !target.asking) {
      // The steer route, as the agent answers it: refused once the specialist has finished.
      if (!running.some((d) => d.callId === target.id)) {
        setSteerError("It has already finished, so it can no longer take a note. Ask the main agent in the chat instead.");
        return;
      }
      setSteerError(null);
      const note = { id: `note-${Date.now()}`, callId: target.id, text: raw, status: "pending" as const };
      save({ stage, markers: saved?.markers ?? [], notes: [...(saved?.notes ?? []), note] });
      return;
    }
    const resolved = whom && target.id !== "main" ? resolveTextToResponses(raw, open as never) : [];
    if (resolved.length > 0) answer(resolved as SpecialistReply[]);
    else setHeld((h) => [...h, raw]);
  };
  const isProxied = (part: { toolCallId?: string; toolName?: string; type?: string }) => {
    const rid = (part as { toolMetadata?: { eve?: { inputRequest?: { requestId?: string } } } }).toolMetadata?.eve
      ?.inputRequest?.requestId;
    return part.type === "dynamic-tool" && !part.toolName?.startsWith("eve:subagent:") && Boolean(rid && proxied.has(rid));
  };

  if (!saved) return null;
  return (
    <main
      data-testid="specialist-question"
      data-stage={stage}
      className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-background p-4 text-foreground sm:p-6"
    >
      {messages.map((message, i) => (
        <div key={message.id} data-testid={`msg-${message.role}`}>
          <AgentMessage
            canRespond
            hoistPendingInput
            isProxiedApproval={isProxied}
            isLast={i === messages.length - 1}
            isStreaming={false}
            message={message}
            specialistAnswers={placed}
            steeringNotes={notes}
            onFocusSubagent={(id) => setOpened(id)}
            onInputResponses={(r) => answer(r as SpecialistReply[])}
            turnActive={false}
          />
        </div>
      ))}
      {pending.map((p) => {
        const rid = p.toolMetadata?.eve?.inputRequest?.requestId;
        const asker = rid ? askers.get(rid) : undefined;
        const card = <PendingApprovalCard key={p.toolCallId} part={p} onInputResponses={(r) => answer(r as SpecialistReply[])} />;
        return asker ? (
          <SpecialistQuestionFrame key={p.toolCallId} name={subagentDisplayName(asker.name)}>
            {card}
          </SpecialistQuestionFrame>
        ) : (
          card
        );
      })}
      {[...placed.values()]
        .filter((a) => a.where === "tail")
        .map((a) => (
          <SpecialistAnsweredCard
            key={a.requestId}
            name={subagentDisplayName(a.name)}
            prompt={a.prompt}
            reply={a.reply}
            progress={a.progress}
            onOpen={() => setOpened(a.callId)}
          />
        ))}
      {[...new Set(notes.filter((n) => n.where === "tail").map((n) => n.callId))].map((callId) => {
        const mine = notes.filter((n) => n.where === "tail" && n.callId === callId);
        return (
          <SpecialistNotesCard
            key={callId}
            name={subagentDisplayName(mine[0].name)}
            notes={mine}
            progress={mine[0].progress}
            onOpen={() => setOpened(callId)}
          />
        );
      })}
      {held.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a preview's held lines never reorder
        <p key={i} data-held className="text-muted-foreground text-xs">
          Held for the main agent: {h}
        </p>
      ))}
      {opened ? (
        <p data-opened className="text-muted-foreground text-xs">
          Opened the run of {opened}
        </p>
      ) : null}
      <form
        className="sticky bottom-0 mt-auto bg-background pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {targets.length > 1 && !(open.length > 0 && !whom) ? (
          <ComposerTargetRow
            targets={targets.map((t) => (t.name ? { ...t, name: subagentDisplayName(t.name) } : t))}
            selected={target.id}
            onSelect={(id) => {
              setSteerError(null);
              setPicked(id);
            }}
            heldFor={whom ? subagentDisplayName(whom.name) : undefined}
            error={steerError}
          />
        ) : null}
        <div className="flex gap-2">
          <textarea
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-primary px-3 text-primary-foreground text-sm">
            Send
          </button>
        </div>
      </form>
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          data-testid="next-step"
          onClick={() => save({ ...saved, notes: (saved.notes ?? []).map((n) => ({ ...n, status: "delivered" as const })) })}
        >
          The specialist takes its next step
        </button>
        <button type="button" data-testid="hand-back" onClick={() => save({ ...saved, stage: "done" })}>
          Deliver the rest of the stream
        </button>
        <button type="button" data-testid="reset" onClick={() => save({ stage: "live", markers: [], notes: [] })}>
          Reset
        </button>
      </div>
    </main>
  );
}
