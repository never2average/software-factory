"use client";

/**
 * THE chat composer — one component, used by the main agent chat AND the
 * Cockpit's subagent steer box, so the two can never drift apart visually
 * (same container, same colors, same textarea metrics, same submit button).
 * Surface-specific chrome (attach/search/plan tools, attachment chips) comes
 * in through slots; the rail passes none.
 *
 * Both get the microphone (app/_components/dictation-slot.tsx) after their
 * tools: dictated text goes into this box at the cursor and is never sent on
 * its own. It draws nothing unless the server says dictation is on.
 */
import { lazy, Suspense, useEffect } from "react";
import { prewarmAgent } from "@/lib/agent-prewarm";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";

/**
 * The microphone, loaded after the composer rather than with it: the chat's first load sits at its budget
 * (scripts/check-bundle-budget.mjs), and even the slot's few hundred bytes there split a first-load chunk in two (one
 * more file). Loaded, it asks the server whether dictation is on and draws nothing unless it is.
 */
const DictationSlot = lazy(() => import("./dictation-slot").then((m) => ({ default: m.DictationSlot })));

export function ChatComposer({
  header,
  onStop,
  onSubmit,
  placeholder,
  status,
  tools,
  submitAccessory,
}: {
  /** Optional chips row above the textarea (e.g. attachments). */
  readonly header?: React.ReactNode;
  readonly onStop?: () => void;
  readonly onSubmit: (message: PromptInputMessage, event: React.FormEvent<HTMLFormElement>) => void;
  readonly placeholder: string;
  readonly status?: React.ComponentProps<typeof PromptInputSubmit>["status"];
  /** Optional footer tool buttons (left side). */
  readonly tools?: React.ReactNode;
  /** Optional element pinned just LEFT of the submit button (e.g. the context
   *  ring). The submit sits at `right-2.5 bottom-2.5`; this clears it. */
  readonly submitAccessory?: React.ReactNode;
}) {
  // A composer on screen means a message is coming: start the agent's cold start now, not on Enter.
  useEffect(() => {
    prewarmAgent();
  }, []);
  return (
    <PromptInput onSubmit={onSubmit}>
      {header ? <PromptInputHeader>{header}</PromptInputHeader> : null}
      <PromptInputTextarea placeholder={placeholder} className="min-h-11 text-sm!" />
      {/* Tools wrap on narrow screens instead of running under the composer's
          overflow-hidden frame; the right padding keeps the wrapped row clear
          of the absolutely-positioned submit button + accessory. */}
      <PromptInputFooter className="pr-20">
        <PromptInputTools className="flex-wrap">
          {tools}
          <Suspense fallback={null}>
            <DictationSlot />
          </Suspense>
        </PromptInputTools>
      </PromptInputFooter>
      {submitAccessory ? (
        <div className="absolute right-14 bottom-3 flex items-center">{submitAccessory}</div>
      ) : null}
      <PromptInputSubmit onStop={onStop} status={status} />
    </PromptInput>
  );
}
