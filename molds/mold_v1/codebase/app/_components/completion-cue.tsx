"use client";

/**
 * THE COMPLETED CUE (mold_v1-287): the brief highlight a finished piece of work earns, the announcement a screen reader
 * hears, and the tab title's mark while the page is hidden. The rules are in lib/completion-cue.ts.
 *
 * Tasteful by construction: one soft colour wash that fades over a couple of seconds, no movement, and under
 * `prefers-reduced-motion` no transition at all (the mark simply appears and the wash goes). Only a transition SEEN
 * during this visit earns the wash: a card that mounts already finished is history and stays quiet.
 */
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { markedTitle, unmarkedTitle } from "@/lib/completion-cue";
import { CHAT_CUES } from "@/lib/ui-words";
import { cn } from "@/lib/utils";

/** How long the highlight stays after something settles. */
export const SETTLE_HIGHLIGHT_MS = 2_400;

/**
 * True for `ms` after `done` turns from false to true while this component is mounted. Never on mount: a card that
 * arrives finished did not just finish.
 */
export function useJustSettled(done: boolean, onSettle?: () => void, ms = SETTLE_HIGHLIGHT_MS): boolean {
  const prev = useRef(done);
  const [lit, setLit] = useState(false);
  const settleRef = useRef(onSettle);
  settleRef.current = onSettle;
  useEffect(() => {
    const was = prev.current;
    prev.current = done;
    if (!done || was) return;
    settleRef.current?.();
    setLit(true);
    const t = setTimeout(() => setLit(false), ms);
    return () => clearTimeout(t);
  }, [done, ms]);
  return lit;
}

/** The wash a just-settled row wears (a class list), and nothing otherwise. */
export function settledWash(lit: boolean): string {
  return cn(
    "transition-colors duration-700 motion-reduce:transition-none",
    lit && "bg-emerald-500/10 ring-1 ring-emerald-500/40 ring-inset",
  );
}

/* ───────────────────────── the announcement (one polite live region) ───────────────────────── */

let said = { text: "", n: 0 };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/**
 * Tell a screen reader something finished. Polite: it waits for whatever is being read. Saying the same words twice
 * in a row still re-announces (the region is cleared first), so two specialists finishing one after the other are
 * both heard.
 */
export function announceCompletion(text: string): void {
  said = { text: "", n: said.n + 1 };
  for (const l of listeners) l();
  setTimeout(() => {
    said = { text, n: said.n + 1 };
    for (const l of listeners) l();
  }, 60);
}

/** The live region itself — rendered once, by the chat. Visually hidden. */
export function CompletionAnnouncer() {
  const now = useSyncExternalStore(
    subscribe,
    () => said,
    () => said,
  );
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-completion-announcer className="sr-only">
      {now.text}
    </div>
  );
}

/* ───────────────────────── the tab title ───────────────────────── */

/**
 * Put the done mark in front of the tab's title if the page is hidden (or not focused): the person is elsewhere and
 * the tab strip is where they will look. It comes off as soon as the page is visible and focused again.
 */
export function markTabDone(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const mark = () => {
    const next = markedTitle(document.title, CHAT_CUES.tabDone);
    if (next !== document.title) document.title = next;
  };
  mark();
  if (tabWatch) return;
  // The framework may write the page's title again while the mark is on (a re-render of the head): keep it on.
  const observer = typeof MutationObserver === "function" ? new MutationObserver(mark) : null;
  observer?.observe(document.head, { subtree: true, childList: true, characterData: true });
  const clear = () => {
    if (document.visibilityState !== "visible") return;
    observer?.disconnect();
    document.title = unmarkedTitle(document.title, CHAT_CUES.tabDone);
    document.removeEventListener("visibilitychange", clear);
    window.removeEventListener("focus", clear);
    tabWatch = false;
  };
  tabWatch = true;
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("focus", clear);
}
/** The mark is on and being kept on. */
let tabWatch = false;

/* ───────────────────────── the chat's own mark ───────────────────────── */

/**
 * The completed mark beside the composer: shown for a few seconds after the main agent's turn ends with an answer
 * while the chat is on screen. Placed over the space above the composer, so it never moves anything. Decorative for
 * sight (the announcement carries it for a screen reader).
 */
export function CompletionMark({ show }: { readonly show: boolean }) {
  if (!show) return null;
  return (
    <span
      data-completion-cue
      aria-hidden="true"
      className="pointer-events-none absolute -top-7 right-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-2xs text-emerald-800 animate-in fade-in-0 duration-500 motion-reduce:animate-none dark:text-emerald-400"
    >
      <CheckIcon className="size-3" />
      {CHAT_CUES.replyCompleted}
    </span>
  );
}
