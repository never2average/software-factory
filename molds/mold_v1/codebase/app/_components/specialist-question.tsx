"use client";

/**
 * A DELEGATED SPECIALIST'S QUESTION, AND THE PERSON'S REPLY TO IT (mold_v1-234).
 *
 * The pieces the chat shows once it knows who asked (lib/specialist-questions.ts):
 *   - `SpecialistAskingHeader`  over the open question card: "<Specialist> is asking you";
 *   - `SpecialistThread`        the question once answered: what was asked, the reply indented under it as
 *                               "Reply to <Specialist>", and where that specialist is now (working on it, finished, ...),
 *                               with the way into its run;
 *   - `ComposerTargetRow`       the one row above the composer while specialists run: "Answering <Specialist>", a
 *                               note to a working one, or the main chat, and the choice between them (mold_v1-235);
 *   - `SteeringNoteLine` / `SpecialistNotesCard`  a note sent to a running specialist: "Steered <Specialist>", and
 *                               whether it read it.
 *
 * A question nobody can attribute renders exactly as before; none of this mounts for it.
 * Names come from the subagent registry (`subagentDisplayName`, applied by the caller), never a raw id.
 */
import type { ReactNode, SVGProps } from "react";
import type { SpecialistProgress } from "@/lib/specialist-questions";

/*
 * The four glyphs this file draws, as plain SVG (lucide's own paths). Importing lucide here split its shared icon
 * factory out of the chat's first-load chunk into a file of its own, one more request on every page (the first-load
 * budget, scripts/check-bundle-budget.mjs); these few paths cost nothing of the kind.
 */
function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}
const MessageCircleQuestionIcon = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Glyph>
);
const CornerDownRightIcon = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <polyline points="15 10 20 15 15 20" />
    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
  </Glyph>
);
const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Glyph>
);
const ArrowRightIcon = (p: SVGProps<SVGSVGElement>) => (
  <Glyph {...p}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Glyph>
);
/** A small turning ring: work in progress (the same look as the app's spinner, without its icon import). */
const Spinner = ({ className }: { readonly className?: string; readonly "aria-hidden"?: boolean }) => (
  <span aria-hidden="true" className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className)} />
);

/** Class names joined, falsy ones dropped (this file imports nothing it would share with the first load). */
const cn = (...parts: readonly (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");
/**
 * Every `name` given to this file is the specialist's DISPLAY name, from the registry (`subagentDisplayName` in
 * ./tool-display): the callers format it, so this lazily loaded file shares no module with the chat's first load.
 */
const askerName = (name: string): string => name;

/** The question card's label row: who is asking. */
export function SpecialistAskingHeader({ name }: { readonly name: string }) {
  return (
    <p data-specialist-asking className="mb-2 flex items-center gap-1.5 font-medium text-xs">
      <MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      <span>
        <span data-specialist-name>{askerName(name)}</span> is asking you
      </span>
    </p>
  );
}

/** Wraps an open question card so the whole card reads as the specialist's. */
export function SpecialistQuestionFrame({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <section
      data-specialist-question
      aria-label={`${askerName(name)} is asking you`}
      className="not-prose mb-4 w-full rounded-lg border border-primary/30 bg-primary/5 px-3 pt-2.5 [&>*:last-child]:mb-2.5"
    >
      <SpecialistAskingHeader name={name} />
      {children}
    </section>
  );
}

const PROGRESS: Record<SpecialistProgress, (name: string) => string> = {
  working: (n) => `${n} is working on your reply`,
  "reports-later": (n) => `${n} is working on your reply. Its result comes back to the main agent by itself`,
  finished: (n) => `${n} finished. Its result went to the main agent`,
  failed: (n) => `${n} stopped with an error`,
  stopped: (n) => `${n} was stopped`,
};

/**
 * The answered question, threaded: the prompt, the reply indented under it, and what the specialist did next. Not a
 * main-thread message: it sits on the left, inside the specialist's card, and says whom it went to.
 */
export function SpecialistThread({
  name,
  prompt,
  reply,
  progress,
  onOpen,
  className,
}: {
  readonly name: string;
  readonly prompt: string;
  readonly reply: string;
  readonly progress: SpecialistProgress;
  /** Open this specialist's run (the Control Panel). */
  readonly onOpen?: () => void;
  readonly className?: string;
}) {
  const display = askerName(name);
  const live = progress === "working" || progress === "reports-later";
  return (
    <section
      data-specialist-thread
      data-progress={progress}
      aria-label={`${display} asked you a question`}
      className={cn("not-prose w-full space-y-2 text-sm", className)}
    >
      <p className="flex items-start gap-1.5 text-muted-foreground">
        <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          <span className="font-medium text-foreground">{display} asked:</span> {prompt}
        </span>
      </p>
      <div data-specialist-reply className="ml-2 border-primary/40 border-l-2 pl-3 sm:ml-5">
        <p className="flex items-center gap-1 text-2xs text-muted-foreground">
          <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
          Reply to {display}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words">{reply}</p>
      </div>
      <div className="ml-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-3 text-muted-foreground text-xs sm:ml-5">
        <span data-specialist-progress role="status" className="inline-flex items-center gap-1.5">
          {live ? <Spinner aria-hidden className="size-3" /> : <CheckIcon aria-hidden className="size-3 shrink-0" />}
          {PROGRESS[progress](display)}
        </span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex min-h-8 items-center gap-1 rounded px-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open its run
            <ArrowRightIcon aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** One place a message from the composer can go: the main chat, or a running specialist. */
export interface ComposerTarget {
  /** "main", or the delegation's call id. */
  readonly id: string;
  /** The specialist's registry name; absent for the main chat. */
  readonly name?: string;
  /** This specialist is waiting on the person's answer. */
  readonly asking?: boolean;
}

/**
 * The one row above the composer while specialists are running (mold_v1-234/235): whom the next message goes to, and
 * the way to pick another. Answering a specialist that asked, a note to one that is working, or the main chat.
 * Self-contained (a single row, no composer state of its own) so it sits beside whatever else the composer grows.
 */
export function ComposerTargetRow({
  targets,
  selected,
  onSelect,
  heldFor,
  error,
}: {
  /** "main" first, then each running specialist. */
  readonly targets: readonly ComposerTarget[];
  readonly selected: string;
  /** Undefined: only the label, no choice (a shared thread's relay answers only). */
  readonly onSelect?: (id: string) => void;
  /** A specialist the main chat's message waits for (it is asking): said when the main chat is picked. */
  readonly heldFor?: string;
  /** Why the last note was not taken, in plain words. */
  readonly error?: string | null;
}) {
  const current = targets.find((t) => t.id === selected) ?? targets[0];
  const display = current?.name ? askerName(current.name) : "";
  const line = !current || current.id === "main"
    ? heldFor
      ? `To the main chat. It is sent once ${askerName(heldFor)} has its answer and hands back.`
      : "To the main chat."
    : current.asking
      ? `Answering ${display}`
      : `Note to ${display}. It reads it at its next step and carries on.`;
  return (
    <div data-answering data-target={current?.id ?? "main"} className="mb-1.5 space-y-1 px-1 text-xs">
      <p role="status" className={cn("flex items-center gap-1", current && current.id !== "main" ? "font-medium" : "text-muted-foreground")}>
        {current && current.id !== "main" ? <CornerDownRightIcon aria-hidden className="size-3 shrink-0 text-primary" /> : null}
        <span>{line}</span>
      </p>
      {onSelect && targets.length > 1 ? (
        <div role="radiogroup" aria-label="Who your message goes to" className="flex flex-wrap items-center gap-1.5">
          <span aria-hidden className="text-muted-foreground">
            To:
          </span>
          {targets.map((t) => {
            const on = t.id === (current?.id ?? "main");
            const label = t.id === "main" ? "Main chat" : askerName(t.name ?? "");
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onSelect(t.id)}
                className={cn(
                  "min-h-8 rounded-full border px-2.5 focus-visible:outline-2 focus-visible:outline-ring sm:min-h-6",
                  on ? "border-primary/50 bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {t.asking ? <span className="text-muted-foreground"> · asking</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-steer-error className="text-amber-800 dark:text-amber-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A note the person sent a running specialist, and whether it has read it. */
export function SteeringNoteLine({
  name,
  text,
  status,
  live,
}: {
  readonly name: string;
  readonly text: string;
  readonly status: "pending" | "delivered";
  /** The specialist is still working. */
  readonly live: boolean;
}) {
  const display = askerName(name);
  const state =
    status === "delivered"
      ? "Read at its next step"
      : live
        ? "Waiting for its next step"
        : `Not read: ${display} finished first. Ask the main agent instead.`;
  return (
    <div data-steering-note data-status={status} className="ml-2 border-primary/40 border-l-2 pl-3 sm:ml-5">
      <p className="flex items-center gap-1 text-2xs text-muted-foreground">
        <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
        Steered {display}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{text}</p>
      <p data-steering-status className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
        {status === "delivered" ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
        {state}
      </p>
    </div>
  );
}

/** The notes sent one specialist, at the conversation's tail while it works: with its progress and its run. */
export function SpecialistNotesCard({
  name,
  notes,
  progress,
  onOpen,
}: {
  readonly name: string;
  readonly notes: readonly { readonly id: string; readonly text: string; readonly status: "pending" | "delivered" }[];
  readonly progress: SpecialistProgress;
  readonly onOpen?: () => void;
}) {
  const display = askerName(name);
  const live = progress === "working" || progress === "reports-later";
  return (
    <section
      data-specialist-notes
      aria-label={`Your notes to ${display}`}
      className="not-prose w-full space-y-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm"
    >
      {notes.map((n) => (
        <SteeringNoteLine key={n.id} name={name} text={n.text} status={n.status} live={live} />
      ))}
      <div className="ml-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-3 text-muted-foreground text-xs sm:ml-5">
        <span data-specialist-progress role="status" className="inline-flex items-center gap-1.5">
          {live ? <Spinner aria-hidden className="size-3" /> : <CheckIcon aria-hidden className="size-3 shrink-0" />}
          {live ? `${display} is working` : PROGRESS[progress](display)}
        </span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex min-h-8 items-center gap-1 rounded px-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open its run
            <ArrowRightIcon aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The answered question at the conversation's tail, while the specialist works on the reply: the question card's
 *  own frame, so the card the person answered is the card that now shows the reply. */
export function SpecialistAnsweredCard(props: Parameters<typeof SpecialistThread>[0]) {
  return (
    <div data-specialist-answered className="not-prose w-full rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
      <SpecialistThread {...props} />
    </div>
  );
}
