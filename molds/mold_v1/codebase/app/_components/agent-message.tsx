"use client";

import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "eve/react";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  PaperclipIcon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { ArtifactCard } from "./artifact-view";
import { PdfView } from "./pdf-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { extractAttachmentRefs, visibleText, type AttachmentRef } from "@/lib/chat-attachments";
import { partStillWriting } from "@/lib/chat-turn-state";
import { isPreviewablePdfPath } from "@/lib/pdf-preview";
import { Dashboard, parseDashboardSpec } from "./ops/dashboard";
import { ErrorBoundary } from "./error-boundary";
import { toolCallSummary, toolDisplayName } from "./tool-display";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { CollapsibleUserText } from "./collapsible-user-text";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  ToolStatusIcon,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

function messageText(message: EveMessage): string {
  return (message.parts ?? [])
    .map((p) => {
      const part = p as { type?: string; text?: string };
      return part.type === "text" ? (part.text ?? "") : "";
    })
    .join("")
    .trim();
}

/** A run of ADJACENT plain tool calls collapses into one Activity cluster;
 *  everything else renders as its own part. Segments carry the parts' original
 *  indices so the streaming-caret logic (lastTextIndex) is untouched. */
type PartSegment =
  | { readonly kind: "single"; readonly part: EveMessagePart; readonly index: number }
  | { readonly kind: "cluster"; readonly parts: EveDynamicToolPart[] };

/** Plain tool calls cluster. Standalone stays standalone: publish_artifact
 *  (artifact card), the question card, and STILL-PENDING approval cards. */
function isClusterable(part: EveMessagePart): part is EveDynamicToolPart {
  if (part.type !== "dynamic-tool") return false;
  if (part.toolName === "publish_artifact") return false;
  // A plain question keeps its own Q&A card (prompt + chosen answer), never a
  // terse cluster row — even once it's answered.
  if (part.toolName === "ask_question") return false;
  // Delegations NEVER cluster: their card is a click-through to the Control
  // Panel (no dropdown), with proxied approvals rendered beneath it.
  if (part.toolName.startsWith("eve:subagent:")) return false;
  // Only a tool STILL AWAITING the operator's decision keeps the standalone
  // approval chrome (wrench, PARAMETERS, "Approve tool call" box). The moment
  // it's been RESPONDED to — approval-responded, or a recorded inputResponse —
  // it's just a normal tool (running, then finished) and clusters like a GET:
  // the green-check row, no wrench, no "Responded"/"Completed" pill. Finished
  // tools cluster too, even though their inputRequest metadata lingers.
  if (awaitsUserDecision(part)) return false;
  return true;
}

/** The tool is parked waiting for the operator to approve/answer RIGHT NOW —
 *  the only state that earns the heavy standalone approval card. Shared by the
 *  clustering, hoisting, and empty-message checks so they never disagree. */
function awaitsUserDecision(part: EveMessagePart): boolean {
  if (part.type !== "dynamic-tool") return false;
  const terminal =
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied";
  if (terminal || part.state === "approval-responded") return false;
  const hasResponse = Boolean(part.toolMetadata?.eve?.inputResponse);
  return part.state === "approval-requested" || (Boolean(part.toolMetadata?.eve?.inputRequest) && !hasResponse);
}

function segmentParts(parts: readonly EveMessagePart[]): PartSegment[] {
  const segments: PartSegment[] = [];
  parts.forEach((part, index) => {
    if (isClusterable(part)) {
      const last = segments[segments.length - 1];
      if (last?.kind === "cluster") last.parts.push(part);
      else segments.push({ kind: "cluster", parts: [part] });
    } else {
      segments.push({ kind: "single", part, index });
    }
  });
  return segments;
}

/** Does this part render any visible output? MUST stay in lockstep with
 *  AgentMessagePart's null branches below — a message whose every part is
 *  suppressed here mounts as an empty, 0-height bubble that still eats a
 *  ConversationContent flex-gap slot, which is the blank band between a crashed
 *  child's delegation card and its hoisted approvals. AgentMessage drops such
 *  messages so no empty shell occupies transcript space. */
function partRendersContent(
  part: EveMessagePart,
  role: EveMessage["role"],
  hoistPendingInput?: boolean,
  isProxiedApproval?: (part: EveMessagePart) => boolean,
): boolean {
  // A subagent-proxied approval is suppressed entirely in the main thread (it
  // lives in the rail), so it renders nothing here.
  if (isProxiedApproval?.(part)) return false;
  switch (part.type) {
    case "step-start":
      return false;
    case "reasoning":
      // Textless reasoning renders null (the eve-relay-drops-reasoning fix).
      return Boolean(part.text?.trim());
    case "text":
      // User text keeps `[file: x]` attachment tokens (they survive
      // stripDirectives), so an attachment-only message stays visible.
      return role === "user"
        ? Boolean(stripDirectives(part.text ?? "").trim())
        : Boolean((part.text ?? "").trim());
    case "authorization":
      return true;
    case "file":
      // An attachment-only message (empty text, file parts only) projects to
      // real file parts once the server emits data.parts — keep it visible so
      // the message the user attached a file to is never dropped as empty.
      return true;
    case "dynamic-tool": {
      // Delegation and artifact cards always render.
      if (part.toolName === "publish_artifact") return true;
      if (part.toolName.startsWith("eve:subagent:")) return true;
      // A plain tool card renders unless it's a pending input hoisted away —
      // use the SAME predicate the render + clustering paths use.
      return !(hoistPendingInput && awaitsUserDecision(part));
    }
    default:
      // Any other part type renders null in AgentMessagePart (no case handles
      // it), so it contributes nothing visible — mirror that.
      return false;
  }
}

export function AgentMessage({
  canRespond,
  hoistPendingInput,
  isProxiedApproval,
  isLast,
  isStreaming,
  message,
  onFocusSubagent,
  onInputResponses,
  onRetry,
  turnActive,
}: {
  readonly canRespond: boolean;
  /** Render pending approval/question cards elsewhere (the conversation tail)
   *  instead of in place — eve's proxied child approvals carry stale turn ids,
   *  so in place they land inside the WRONG (earlier) message. */
  readonly hoistPendingInput?: boolean;
  /** True for a subagent-proxied approval part: suppressed from this thread
   *  entirely (it's answered in the subagent's rail), pending or answered. */
  readonly isProxiedApproval?: (part: EveMessagePart) => boolean;
  /** This message is the last one in the conversation. */
  readonly isLast: boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  /** Hand a delegation tool call off to the Control Panel rail. */
  readonly onFocusSubagent?: (toolCallId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onRetry?: () => void;
  /**
   * The TURN is still going anywhere in the chat — not "the eve store is
   * reading". The caller derives it from the event stream (`turnFinished` in
   * lib/chat-turn-state); passing the store's own `submitted | streaming` put
   * the end-of-answer row under a reply whose tool call had not come back yet.
   */
  readonly turnActive: boolean;
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  const isAssistant = message.role === "assistant";
  // A parked turn (tool approval / question / authorization awaiting the user)
  // is not "streaming", but it is not DONE either — the copy/vote actions row
  // must not render under a card that is still waiting for input.
  const awaitingInput = message.parts.some((p) => {
    const part = p as {
      state?: string;
      toolMetadata?: { eve?: { inputRequest?: unknown; inputResponse?: unknown } };
    };
    if (part.state === "approval-requested" || part.state === "required") return true;
    // An ask_question-style card: request present, no response chosen yet.
    const eveMeta = part.toolMetadata?.eve;
    return Boolean(eveMeta?.inputRequest) && !eveMeta?.inputResponse;
  });

  // A message whose every part is suppressed (all step-start / textless
  // reasoning / hoisted-away approvals — e.g. a crashed child's ghost messages)
  // renders an empty bubble that still eats a ConversationContent gap slot.
  // Drop it, but keep the actively streaming last message mounted so its block
  // caret isn't dropped mid-stream (zombie messages are never streaming).
  const hasRenderableContent = message.parts.some((p) =>
    partRendersContent(p, message.role, hoistPendingInput, isProxiedApproval),
  );
  if (!hasRenderableContent && !isStreaming) return null;

  return (
    <div className="group">
      <Message
        data-optimistic={message.metadata?.optimistic ? "true" : undefined}
        from={message.role}
      >
        <MessageContent>
          {segmentParts(message.parts).map((segment) =>
            segment.kind === "cluster" ? (
              // Keyed by the FIRST member's tool-call id — NEVER by array index
              // (parts regroup while streaming, so index keys remount-churn) and
              // never by the joined member ids (the join changes every time a
              // streaming turn appends a tool call, remounting the cluster and
              // wiping each row's pinned expand state).
              <ErrorBoundary key={segment.parts[0].toolCallId} label="Tools" compact>
                <ToolCluster onFocusSubagent={onFocusSubagent} parts={segment.parts} />
              </ErrorBoundary>
            ) : (
              // Contain a bad part (e.g. a malformed tool/artifact output) so it
              // can't take down the whole conversation view.
              <ErrorBoundary key={partKey(segment.part, segment.index)} label="Message" compact>
                <AgentMessagePart
                  canRespond={canRespond}
                  hoistPendingInput={hoistPendingInput}
                  isProxiedApproval={isProxiedApproval}
                  messageStreaming={isStreaming}
                  onFocusSubagent={onFocusSubagent}
                  onInputResponses={onInputResponses}
                  part={segment.part}
                  role={message.role}
                  // The caret marks a line being WRITTEN, not the last line that
                  // was. eve closes the text part (`state: "done"`) at the step
                  // boundary before a tool runs, so on `isStreaming` alone it
                  // blinked under a finished paragraph for the whole of a tool
                  // call — the same "it looks done" the actions row caused,
                  // read the other way round.
                  showCaret={
                    isStreaming &&
                    message.role === "assistant" &&
                    segment.index === lastTextIndex &&
                    partStillWriting(segment.part)
                  }
                />
              </ErrorBoundary>
            ),
          )}
        </MessageContent>
      </Message>
      {/* Actions only at TRUE turn end: last message, no turn in flight — never
          mid-turn under an earlier assistant segment or an answered question. */}
      {isAssistant && isLast && !turnActive && !awaitingInput ? (
        <MessageActions text={messageText(message)} onRetry={onRetry} />
      ) : null}
    </div>
  );
}

function MessageActions({ text, onRetry }: { readonly text: string; readonly onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const btn =
    "rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  return (
    <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button type="button" onClick={copy} title="Copy" aria-label="Copy" className={btn}>
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => setVote((v) => (v === "up" ? null : "up"))}
        title="Good response"
        aria-label="Thumbs up"
        aria-pressed={vote === "up"}
        className={cn(btn, vote === "up" && "text-foreground")}
      >
        <ThumbsUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setVote((v) => (v === "down" ? null : "down"))}
        title="Bad response"
        aria-label="Thumbs down"
        aria-pressed={vote === "down"}
        className={cn(btn, vote === "down" && "text-foreground")}
      >
        <ThumbsDownIcon className="size-3.5" />
      </button>
      {onRetry ? (
        <button type="button" onClick={onRetry} title="Retry" aria-label="Retry" className={btn}>
          <RefreshCwIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Hide the injected context / web-search / plan-mode directives from displayed user text. */
function stripDirectives(text: string) {
  /**
   * Legacy shape only. Directives are wrapped in an agent-only marker now, but
   * messages sent before that still carry bare parentheses and eve replays them
   * on reopen. "Browser use" is included because it was missing from this list
   * for its whole life — which is how it ended up rendered in user messages —
   * and the body match is lazy-to-the-last-bracket because the browser
   * directive contains "(browser_open)" and `[^)]*` stopped at it.
   */
  // Structure, not bracket balancing: a directive run sits at the start and
  // ends at the blank line. Any bracket-counting pattern trips on the
  // "(browser_open)" nested inside the browser directive — which is how that
  // whole sentence ended up rendered in users' own messages.
  return text.replace(/^\((?:Context|Web search|Plan mode|Browser use)[\s\S]*?(?:\n\n|$)/i, "").trim();
}

/**
 * eve encodes user file attachments into the message text as `[file: name]`
 * tokens (its message-part union has no file type — see summarizeUserContent).
 * Pull those out so we can render them as attachment chips instead of raw text.
 *
 * BOTH halves now come from lib/chat-attachments — the same module the SENDER
 * composed the message with. The inline copies of those regexes that used to
 * live here are gone: the file's own comment already said two copies is how the
 * visible message drifts back to leaking paths, and a third consequence showed
 * up as soon as the chips had to be openable — the path was being stripped
 * here and was therefore unrecoverable one line later.
 */
function extractAttachments(text: string): { text: string; files: AttachmentRef[] } {
  return { text: visibleText(text), files: extractAttachmentRefs(text) };
}

/**
 * The chips above a sent message. A chip whose file is a PDF IN THE DATA ROOM
 * is a button that opens it in the in-app viewer; every other chip stays the
 * inert label it has always been.
 *
 * WHY A DIALOG AND NOT THE RIGHT RAIL: the rail (ArtifactPanel) is addressed by
 * URL and versioned by published name, and an attachment has neither — it has a
 * data-room path. A dialog is also what the published-artifact card in this
 * same transcript already opens, so a person gets one behaviour for "show me
 * that file", wherever in the chat it came from.
 *
 * The viewer only MOUNTS while the dialog is open (`{open ? … : null}`, the same
 * shape ArtifactCard uses): mounting it eagerly for every chip in a long
 * transcript would start a fetch and a pdf.js parse per attached file the
 * moment the conversation loaded.
 */
function AttachmentChips({ files }: { readonly files: readonly AttachmentRef[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {files.map((file, i) =>
        /**
         * `isPreviewablePdfPath` is the gate, and it is checked on the PATH, not
         * the displayed name. A chip's name comes from `[file: …]` in message
         * text and can say anything at all; the path is what would be requested,
         * so that is what has to be a data-room path ending in .pdf. A name that
         * merely reads "…pdf" buys nothing.
         *
         * It grants no access: the request is workspace-scoped server-side. All
         * this decides is whether to offer a click that could only ever succeed.
         */
        isPreviewablePdfPath(file.path) ? (
          <AttachmentPreviewChip key={`${file.name}:${i}`} name={file.name} path={file.path} />
        ) : (
          <span
            key={`${file.name}:${i}`}
            className="flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
            title={file.name}
          >
            <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{file.name}</span>
          </span>
        ),
      )}
    </div>
  );
}

function AttachmentPreviewChip({ name, path }: { readonly name: string; readonly path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="attachment-preview-chip"
        className="flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs transition-colors hover:border-foreground/30 hover:bg-muted"
        title={`Open ${name}`}
      >
        <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
        <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[90vh] w-[92vw] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-2xl border border-white/10 bg-popover p-0 shadow-2xl sm:max-w-[92vw]">
          <DialogHeader className="sr-only">
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>Attached file preview</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/10">
            {open ? <PdfView dataroomPath={path} filename={name} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Client-side smooth reveal for streamed assistant text. The hosted relay
 * flushes `message.appended` in coarse step-boundary chunks (eve on Vercel —
 * same relay family as github.com/vercel/eve/issues/938), so text otherwise
 * POPS in paragraph-sized bursts. This tweens the visible prefix toward the
 * full text at a rate proportional to the backlog, so bursts read as a stream;
 * when streaming ends (or the part isn't eligible) it snaps to the full text.
 */
function useSmoothText(target: string, enabled: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!enabled || !target.startsWith(shownRef.current)) {
      // Not animating, or a different text entirely (new message) — snap.
      shownRef.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const tick = () => {
      const current = shownRef.current;
      if (current.length >= target.length) return;
      // Catch-up rate scales with backlog: never crawls behind a big flush,
      // never teleports either (≥2 chars/frame, backlog/40 when far behind).
      const step = Math.max(2, Math.ceil((target.length - current.length) / 40));
      const next = target.slice(0, current.length + step);
      shownRef.current = next;
      setShown(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return enabled ? shown : target;
}

function AgentMessagePart({
  canRespond,
  hoistPendingInput,
  isProxiedApproval,
  messageStreaming,
  onFocusSubagent,
  onInputResponses,
  part,
  showCaret,
  role,
}: {
  readonly canRespond: boolean;
  readonly hoistPendingInput?: boolean;
  readonly isProxiedApproval?: (part: EveMessagePart) => boolean;
  readonly messageStreaming: boolean;
  /** Hand a delegation tool call off to the Control Panel rail. */
  readonly onFocusSubagent?: (toolCallId: string) => void;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveMessagePart;
  readonly showCaret: boolean;
  readonly role: EveMessage["role"];
}) {
  // Hooks must run unconditionally (the switch below branches per part type).
  // Standalone tool cards: open state is CONTROLLED so a card that LATER needs
  // input (approval flips in, proxied request arrives) opens itself — Radix
  // defaultOpen is mount-time-only and kept hiding approve buttons.
  const [toolOpenPinned, setToolOpenPinned] = useState<boolean | null>(null);
  const isAssistantText = part.type === "text" && role === "assistant";
  const rawText = isAssistantText ? ((part as { text?: string }).text ?? "") : "";
  const smoothText = useSmoothText(rawText, isAssistantText && messageStreaming);
  // A subagent-proxied approval never renders in the main thread — pending or
  // answered, it belongs to that subagent's rail (the parent-stream copy is
  // mis-positioned by the child's forwarded turn id).
  if (isProxiedApproval?.(part)) return null;
  switch (part.type) {
    case "step-start":
      return null;
    case "text": {
      const text = part.text ?? "";
      if (role === "user") {
        const { text: display, files } = extractAttachments(stripDirectives(text));
        return (
          <>
            <AttachmentChips files={files} />
            {/* Long sent text starts folded; the chips above never do. */}
            {display ? (
              <CollapsibleUserText>
                <MessageResponse caret="block" isAnimating={showCaret}>
                  {display}
                </MessageResponse>
              </CollapsibleUserText>
            ) : null}
          </>
        );
      }
      // A finished assistant message that IS a dashboard spec (App Author's
      // `{title, blocks:[…]}`) renders as the widget grid, not raw JSON. While
      // streaming, the partial JSON won't parse yet → falls back to text and
      // snaps to the dashboard once the message completes.
      if (!messageStreaming) {
        const spec = parseDashboardSpec(text);
        if (spec) {
          return (
            <div className="not-prose mb-4 w-full">
              <Dashboard spec={spec} />
            </div>
          );
        }
      }
      return (
        <MessageResponse
          caret="block"
          isAnimating={showCaret || smoothText.length < rawText.length}
        >
          {smoothText}
        </MessageResponse>
      );
    }
    case "reasoning":
      // No text, no block: on hosted Vercel the workflow-world relay drops
      // reasoning content entirely (eve ≤0.25.1, any provider — verified
      // against the prod stream), which used to leave a contentless
      // "Thinking…" shell. Render reasoning only when there is text to show.
      if (!part.text?.trim()) return null;
      return (
        // Gate the "Thinking…" spinner on the MESSAGE still streaming, not just
        // the part state: eve can leave a reasoning part stuck at state
        // "streaming" after a later tool/text part completes, which would hang the
        // spinner forever. Once the message is done, the reasoning is done.
        <Reasoning defaultOpen={false} isStreaming={part.state === "streaming" && messageStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "authorization":
      return <AuthorizationPrompt part={part} />;
    case "dynamic-tool": {
      if (part.toolName === "publish_artifact") {
        return <ArtifactCard input={part.input} output={part.output} />;
      }
      const hasInputRequest = Boolean(part.toolMetadata?.eve?.inputRequest);
      const isDelegation = part.toolName.startsWith("eve:subagent:");
      if (isDelegation) {
        // Delegation card: the ROW is the Control Panel affordance — clicking it
        // opens the run's rail detail (no separate button, no chevron). A proxied
        // approval/question renders ALWAYS-VISIBLE beneath the row: it used to
        // mount inside a collapsed body (Radix defaultOpen is mount-time only,
        // and the card mounts before the child's request arrives), which hid
        // the approve buttons entirely.
        const summary = toolCallSummary(part.toolName, part.input);
        // Explicit handoff status so it's never ambiguous whether the subagent
        // is starting, running, waiting on you, done, or failed.
        const delegationStatus: { label: string; className: string } =
          part.state === "output-available"
            ? { label: "Completed", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" }
            : part.state === "output-error"
              ? { label: "Failed", className: "bg-red-500/10 text-red-600 dark:text-red-400" }
              : hasInputRequest
                ? { label: "Needs approval", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" }
                : { label: "Running", className: "bg-primary/10 text-primary" };
        const delegationRunning =
          part.state !== "output-available" && part.state !== "output-error";
        return (
          <div className="not-prose mb-4 w-full overflow-hidden rounded-md border">
            <button
              type="button"
              onClick={onFocusSubagent ? () => onFocusSubagent(part.toolCallId) : undefined}
              title="Open in Control Panel"
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
            >
              <span className="shrink-0">
                <ToolStatusIcon className="size-3.5" state={part.state} />
              </span>
              <span className="max-w-56 flex-none truncate font-medium text-sm">
                {toolDisplayName(part.toolName)}
              </span>
              {summary ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                  {summary}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium text-2xs",
                  delegationStatus.className,
                )}
              >
                {delegationRunning ? (
                  <span className="size-1.5 animate-pulse rounded-full bg-current" />
                ) : null}
                {delegationStatus.label}
              </span>
            </button>
            {delegationRunning && !hasInputRequest ? (
              <p className="border-border/60 border-t px-3 py-1.5 text-2xs text-muted-foreground">
                Working in the Control Panel — the main agent continues once it hands back.
              </p>
            ) : null}
            {hasInputRequest ? (
              <div className="border-border/60 border-t px-3 py-3">
                <InputRequestActions
                  // eve accepts a response to a PENDING request even mid-turn —
                  // proxied subagent approvals arrive while the parent is busy,
                  // so gating on !isBusy would disable exactly these buttons.
                  canRespond
                  part={part}
                  onInputResponses={onInputResponses}
                />
              </div>
            ) : null}
            {part.errorText ? (
              <p className="mx-3 mb-2 border-destructive/50 border-l-2 pl-2 text-destructive text-xs">
                {part.errorText.length > 200 ? `${part.errorText.slice(0, 200)}…` : part.errorText}
              </p>
            ) : null}
          </div>
        );
      }
      // Only a still-awaiting-decision tool reaches the heavy card below;
      // responded/terminal tools cluster (isClusterable). Same shared predicate.
      const needsInput = awaitsUserDecision(part);
      // Hoisted mode: the conversation tail renders this card (correctly
      // positioned after the latest message) — skip the in-place copy.
      if (hoistPendingInput && needsInput) return null;
      // A plain question to the user renders as its own minimal card, not the
      // full tool-call chrome (wrench, Responded badge, PARAMETERS).
      if (part.toolName === "ask_question" && hasInputRequest) {
        return <QuestionCard canRespond part={part} onInputResponses={onInputResponses} />;
      }
      return (
        <Tool
          open={toolOpenPinned ?? (needsInput || part.state === "approval-responded")}
          onOpenChange={setToolOpenPinned}
        >
          <ToolHeader
            state={part.state}
            title={toolDisplayName(part.toolName)}
            toolName={part.toolName}
            type="dynamic-tool"
          />
          <ToolContent>
            {needsInput ? (
              // While the approval is still PENDING, the InputRequestActions card
              // already presents the prompt and options — don't dump the raw
              // PARAMETERS JSON above it. Keep the raw args reachable behind a
              // collapsed disclosure that matches the transcript's Collapsible +
              // rotating-chevron idiom and the uppercase section-heading style
              // (so it doesn't clash with ToolInput's own "Parameters" heading).
              <Collapsible>
                <CollapsibleTrigger className="group/params flex items-center gap-1 font-medium text-muted-foreground text-xs uppercase tracking-wide transition-colors hover:text-foreground">
                  Parameters
                  <ChevronDownIcon className="size-3 transition-transform group-data-[state=open]/params:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="rounded-md bg-muted/50">
                    <CodeBlock code={JSON.stringify(part.input, null, 2)} language="json" />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              // Normal/terminal tool — the params are the point, shown outright.
              // (InputRequestActions below self-suppresses once terminal, or
              // shows "Responded: …" when this part recorded the answer.)
              <ToolInput input={part.input} />
            )}
            <InputRequestActions
              // Pending requests are answerable regardless of turn state — see
              // the delegation card above for why gating on busy hides these.
              canRespond
              part={part}
              onInputResponses={onInputResponses}
            />
            <ToolOutput errorText={part.errorText} output={part.output} />
          </ToolContent>
        </Tool>
      );
    }
  }
}

/** One bordered container for a run of adjacent plain tool calls: a compact
 *  header ("11 steps · 2 failed") over one compact row per call. A cluster of
 *  one renders as just the row — no header, no heavy per-card chrome. */
function ToolCluster({
  onFocusSubagent,
  parts,
}: {
  readonly onFocusSubagent?: (toolCallId: string) => void;
  readonly parts: readonly EveDynamicToolPart[];
}) {
  const failed = parts.filter((p) => p.state === "output-error").length;
  return (
    // mb-4 matches the standalone Tool card (tool.tsx) so both tool surfaces
    // share one vertical rhythm inside a message.
    <div className="not-prose mb-4 w-full overflow-hidden rounded-md border">
      {parts.length > 1 ? (
        <div className="border-b bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs">
          {parts.length} steps
          {failed > 0 ? ` · ${failed} failed` : ""}
        </div>
      ) : null}
      <div className="divide-y divide-border/60">
        {parts.map((part) => (
          // Rows are keyed by toolCallId — never by index — so a row keeps its
          // identity (and expand state) as the cluster regroups while streaming.
          <ErrorBoundary key={part.toolCallId} label="Tool" compact>
            <ToolClusterRow onFocusSubagent={onFocusSubagent} part={part} />
          </ErrorBoundary>
        ))}
      </div>
    </div>
  );
}

/** Hand a delegation tool call off to the Control Panel rail. Shared between
 *  cluster rows and standalone Tool cards so the affordance never appears and
 *  disappears as a call moves between the two surfaces. */

function ToolClusterRow({
  onFocusSubagent,
  part,
}: {
  readonly onFocusSubagent?: (toolCallId: string) => void;
  readonly part: EveDynamicToolPart;
}) {
  // Collapsed by DEFAULT for every row, errors included — a click pins it open.
  // (Previously errors auto-expanded; the operator wants a uniform collapsed
  // resting state, with the error text still one click away.)
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? false;
  const toggle = () => setPinned(!open);
  const summary = toolCallSummary(part.toolName, part.input);
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="shrink-0">
          <ToolStatusIcon className="size-3.5" state={part.state} />
        </span>
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {/* Title yields LAST: the summary (flex-1) absorbs the squeeze first,
              so "Research subagent" never truncates to "Research sub…" while
              its argument text keeps room. */}
          <span className="max-w-56 flex-none truncate font-medium text-sm">
            {toolDisplayName(part.toolName)}
          </span>
          {summary ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{summary}</span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? "Collapse" : "Expand"}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open ? (
        <div className="space-y-3 border-border/60 border-t bg-muted/20 px-3 py-3">
          <ToolInput input={part.input} />
          <ToolOutput errorText={part.errorText} output={part.output} />
        </div>
      ) : null}
    </div>
  );
}

function AuthorizationPrompt({ part }: { readonly part: EveAuthorizationPart }) {
  const isAuthorized = part.state === "completed" && part.outcome === "authorized";
  const isCompleted = part.state === "completed";
  const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
  const instructions = part.authorization?.instructions;
  const shouldShowInstructions = instructions !== undefined && instructions !== part.description;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border p-3",
        isAuthorized
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isCompleted
            ? "border-destructive/30 bg-destructive/5"
            : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            isAuthorized
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : isCompleted
                ? "bg-destructive/10 text-destructive"
                : "bg-blue-500/10 text-blue-700 dark:text-blue-300",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-sm">{authorizationTitle(part)}</p>
          <p className="text-muted-foreground text-sm">{authorizationDescription(part)}</p>
          {shouldShowInstructions ? (
            <p className="text-muted-foreground text-sm">{instructions}</p>
          ) : null}
          {part.state === "required" && part.authorization?.userCode ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Code</span>
              <code className="rounded-md bg-background px-2 py-1 font-mono">
                {part.authorization.userCode}
              </code>
            </div>
          ) : null}
          {part.state === "required" && part.authorization?.url ? (
            <Button asChild size="sm">
              <a href={part.authorization.url} rel="noreferrer" target="_blank">
                <ExternalLinkIcon className="size-4" />
                Sign in with {part.displayName}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function authorizationTitle(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return `Connect ${part.displayName}`;
  }
  if (part.outcome === "authorized") {
    return `${part.displayName} connected`;
  }
  return `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`;
}

function authorizationDescription(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return part.description;
  }
  if (part.outcome === "authorized") {
    return `${part.displayName} connected.`;
  }
  const tail = part.reason !== undefined ? ` (${part.reason})` : "";
  return `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}${tail}.`;
}

function formatAuthorizationOutcome(outcome: NonNullable<EveAuthorizationPart["outcome"]>): string {
  switch (outcome) {
    case "authorized":
      return "authorized";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed out";
  }
}

/** A pending approval/question card rendered at the conversation tail.
 *  Same markup as the in-place card; used when hoistPendingInput is on. */
export function PendingApprovalCard({
  expired,
  onInputResponses,
  onDismiss,
  part,
}: {
  /** The run that requested this approval has stopped (a failed answer or a
   *  store error proved its continuation token dead), so it can no longer be
   *  delivered. Render a muted note WITHOUT Yes/No — we never claim it was
   *  answered, because no response exists. */
  readonly expired?: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  /** Wave the card away without answering — the run moved past this question and
   *  the operator doesn't want to respond. Undefined ⇒ no dismiss affordance. */
  readonly onDismiss?: () => void;
  readonly part: EveDynamicToolPart;
}) {
  const hasInputRequest = Boolean(part.toolMetadata?.eve?.inputRequest);
  if (expired) {
    return (
      <div className="not-prose mb-4 w-full space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 opacity-80">
        <p className="font-medium text-muted-foreground text-sm">
          {toolDisplayName(part.toolName)}
        </p>
        <p className="text-muted-foreground text-xs">
          Approval expired — the run that requested it has stopped. Re-delegate to continue.
        </p>
      </div>
    );
  }
  // Plain questions get the minimal card here too (matching the in-thread one).
  if (part.toolName === "ask_question" && hasInputRequest) {
    return (
      <QuestionCard
        canRespond
        part={part}
        onInputResponses={onInputResponses}
        onDismiss={onDismiss}
      />
    );
  }
  return (
    <Tool open>
      <ToolHeader
        state={part.state}
        title={toolDisplayName(part.toolName)}
        toolName={part.toolName}
        type="dynamic-tool"
      />
      <ToolContent>
        {hasInputRequest ? null : <ToolInput input={part.input} />}
        <InputRequestActions
          canRespond
          part={part as never}
          onInputResponses={onInputResponses}
          onDismiss={onDismiss}
        />
      </ToolContent>
    </Tool>
  );
}

/** A simple question to the user (the `ask_question` tool): just the prompt and
 *  the choices, with no tool-card chrome, wrench, "Responded" badge, or raw
 *  PARAMETERS. Before answering it shows the options; after, the prompt and the
 *  chosen answer with a check. Used both in-thread and in the hoisted tail. */
function QuestionCard({
  canRespond,
  onInputResponses,
  onDismiss,
  part,
}: {
  readonly canRespond: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onDismiss?: () => void;
  readonly part: EveDynamicToolPart;
}) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) return null;
  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );
  const answer = selectedOption?.label ?? inputResponse?.text ?? inputResponse?.optionId;
  const terminal =
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied";

  if (inputResponse) {
    return (
      <div className="not-prose mb-4 w-full space-y-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
        <p className="text-muted-foreground text-sm">{inputRequest.prompt}</p>
        <p className="flex items-center gap-1.5 font-medium text-sm">
          <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          {answer}
        </p>
      </div>
    );
  }
  // Answered elsewhere (e.g. a subagent question routed through the parent, so
  // this part never records the response) but the run has moved on — show the
  // question as answered, never the still-clickable options.
  if (terminal) {
    return (
      <div className="not-prose mb-4 w-full space-y-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
        <p className="text-muted-foreground text-sm">{inputRequest.prompt}</p>
        <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          Answered
        </p>
      </div>
    );
  }
  return (
    <div className="not-prose group/q relative mb-4 w-full space-y-3 rounded-lg border border-border bg-muted/20 px-3 py-3">
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss — the run has moved past this"
          aria-label="Dismiss this question"
          className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/q:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
      <p className="pr-6 text-sm">{inputRequest.prompt}</p>
      <div className="flex flex-wrap gap-2">
        {inputRequest.options?.map((option) => (
          <Button
            disabled={!canRespond}
            key={option.id}
            onClick={() => {
              void onInputResponses([{ optionId: option.id, requestId: inputRequest.requestId }]);
            }}
            size="sm"
            type="button"
            variant={option.style === "danger" ? "destructive" : "default"}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function InputRequestActions({
  canRespond,
  onInputResponses,
  onDismiss,
  part,
}: {
  readonly canRespond: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly onDismiss?: () => void;
  readonly part: EveDynamicToolPart;
}) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  // The tool has already run/finished — the approve/deny decision is moot. When
  // no response was recorded on THIS part (e.g. a subagent approval answered via
  // the parent proxy, so the child stream never sets inputResponse), the pending
  // Yes/No must not linger next to a Completed result — the output below tells
  // the story. Only keep the box when we actually have the recorded answer.
  const terminal =
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied";
  if (terminal && !inputResponse) return null;

  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );

  return (
    <div className="group/a relative space-y-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      {!inputResponse && onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss — the run has moved past this"
          aria-label="Dismiss this approval"
          className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/a:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
      <p className="pr-6 text-muted-foreground text-sm">{inputRequest.prompt}</p>
      {inputResponse ? (
        <p className="font-medium text-sm">
          Responded: {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {inputRequest.options?.map((option) => (
            <Button
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onInputResponses([
                  {
                    optionId: option.id,
                    requestId: inputRequest.requestId,
                  },
                ]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return part.toolCallId;
    default:
      return `${part.type}:${index}`;
  }
}
