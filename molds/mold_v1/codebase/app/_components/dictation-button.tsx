"use client";

/**
 * The composer's microphone: ONE button, and nothing else in the composer's layout.
 *
 *   hold it (mouse, finger, or Space / Enter with it focused)   talk; let go to stop
 *   double-click it (double-tap, double-press, Shift+Enter)     it keeps listening, hands-free
 *   click it again, or Escape                                    stops
 *   one quick click                                              nothing is recorded; a tooltip says the two above
 *
 * While it listens the button beats (a ring that follows the voice, app/_components/dictation-engine.ts reads the
 * level), and what is said arrives in the message box SECTION BY SECTION, at each pause, in the order spoken
 * (lib/dictation-segmenter.ts, lib/dictation-order.ts). It lands where the cursor was and then after itself; the box
 * stays the person's to type in meanwhile, and their edits move the landing place rather than being overwritten.
 * Never sent on its own; no spoken replies. Server: POST /api/ops/dictation, one request per section.
 *
 * NOTHING HERE CHANGES THE COMPOSER'S HEIGHT, in any state: the rings, the clock badge and the busy dot are drawn
 * inside the button's own box; the tooltip, a problem and the "text is coming here" marker float over the page
 * (fixed, in a portal), anchored to the button or to the landing place. tests/dictation.spec.ts holds that.
 *
 * Loaded and drawn only when the server says dictation is on (app/_components/dictation-slot.tsx asks, once per tab),
 * and the engine only on the first press: neither is part of the chat's first load.
 *
 * A screen reader hears each change once (role=status): listening, hands-free, stopped and why. aria-pressed is the
 * hands-free state. Under prefers-reduced-motion nothing moves: the button shows a still "listening" ring.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Anchor, shiftAnchor, shiftCaret } from "@/lib/dictation-order";
import {
  clockText,
  type DictationCapability,
  DOUBLE_PRESS_MS,
  HINT_MS,
  HINT_TEXT,
  HOLD_STATUS,
  insertDictated,
  LATCHED_STATUS,
  MIC_LABEL,
  NO_SPEECH_TEXT,
  NOTICE_MS,
  quietStopText,
  SEND_FAILED_TEXT,
  sessionLimitText,
  STOPPED_STATUS,
  TAP_MS,
  UNSUPPORTED_TEXT,
} from "@/lib/dictation-text";
import type { Listening, StopReason } from "./dictation-engine";

/*
 * Imports React, react-dom's portal and the import-free lib/dictation-*.ts only, and that is load-bearing: this module
 * loads on demand, and importing anything the chat's first load also holds as a module of its own (the UI kit's
 * button, the icon set, the storage helpers, the profile) made the bundler split that module out into one more
 * first-load file on every page (lib/dictation-text.ts says what was measured). So the button carries the composer
 * buttons' own classes (components/ui/button.tsx, ghost; input-group sizes), the icon is drawn here (the icon set's
 * own path), the motion is the few rules in STYLE below, and the slot hands in the address and the headers.
 */
const BUTTON =
  "relative inline-flex size-8 min-h-9 min-w-9 shrink-0 select-none items-center justify-center rounded-md p-0 text-sm font-medium shadow-none transition-colors " +
  "touch-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent] " +
  "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 sm:min-h-8 sm:min-w-8";
/** Press-to-talk: the recording colour. */
const HOLD = "rounded-full! bg-red-500/15! text-red-700! dark:text-red-400!";
/** Hands-free: its own colour and a solid ring, so "it is still listening" cannot be mistaken for a hold. */
const LATCHED = "rounded-full! bg-sky-500/15! text-sky-700! ring-2! ring-sky-600! dark:text-sky-300! dark:ring-sky-400!";

/**
 * The heartbeat: `dictation-beat` is the two-pulse ring, `dictation-level` a disc that swells with the voice
 * (--dictation-level, 0 to 1, set each frame). Both stay within a few pixels of the button: the composer's frame clips
 * what leaves it. Reduced motion: neither moves, the ring stays as a still outline.
 */
const STYLE = `
@keyframes dictation-beat{0%{transform:scale(1);opacity:.75}12%{transform:scale(1.18);opacity:.55}24%{transform:scale(1.05);opacity:.65}38%{transform:scale(1.3);opacity:.35}75%,100%{transform:scale(1.45);opacity:0}}
@keyframes dictation-shimmer{0%{opacity:.25}50%{opacity:.95}100%{opacity:.25}}
@keyframes dictation-turn{to{transform:rotate(360deg)}}
.dictation-ring{position:absolute;inset:0;border-radius:9999px;pointer-events:none}
.dictation-beat{border:2px solid currentColor;animation:dictation-beat 1.25s ease-out infinite}
.dictation-level{background:currentColor;opacity:calc(.1 + var(--dictation-level,0)*.28);transform:scale(calc(1 + var(--dictation-level,0)*.45));transition:transform 80ms linear,opacity 80ms linear}
.dictation-shimmer{animation:dictation-shimmer 1.1s ease-in-out infinite}
.dictation-turn{animation:dictation-turn .9s linear infinite}
@media (prefers-reduced-motion:reduce){.dictation-beat{animation:none;transform:scale(1.14);opacity:.75}.dictation-level{transform:none;transition:none;opacity:.14}.dictation-shimmer,.dictation-turn{animation:none;opacity:.8}}
`;

const MIC = ["M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2", "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z"];

type Mode = "idle" | "hold" | "latched";
type PressSource = "pointer" | "key" | "other";
interface Notice {
  readonly kind: "hint" | "error" | "info";
  readonly text: string;
}

/** Where one stretch of listening's text lands: its box, and the place in it, which edits move. */
interface Draft {
  readonly box: HTMLTextAreaElement;
  anchor: Anchor;
}

/** One stretch of listening, from the press to its last section's answer. */
interface Session {
  /** 1, 2, 3… in the order the stretches were started: an earlier one's words go before a later one's. */
  readonly order: number;
  readonly draft: Draft;
  readonly source: PressSource;
  handsFree: boolean;
  listening: Listening | null;
  ready: boolean;
  ended: boolean;
  speaking: boolean;
  pending: number;
  startedAt: number;
  /** A problem has been shown for it: the reason it stopped does not replace those words. */
  problem: boolean;
  /** Ends it before the engine has loaded: nothing was heard, so there is nothing to wait for. */
  cancel: (reason: StopReason) => void;
}

let engine: Promise<typeof import("./dictation-engine")> | null = null;
/** The engine, fetched on the first press (or as the pointer or focus arrives, so the press itself does not wait). */
const loadEngine = () => (engine ??= import("./dictation-engine").catch((e) => {
  engine = null;
  throw e;
}));

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const canListen = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  (typeof window.AudioContext === "function" || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === "function");

/** The box's text, set the way typing sets it, so a controlled box (PromptInputProvider) sees it in its onChange. */
function setBoxValue(box: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(box, value);
  else box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

const MIRRORED = [
  "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "textIndent",
  "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

/** Where character `index` of the box's text is on the screen, or null when it is scrolled out of the box. */
function pointInBox(box: HTMLTextAreaElement, index: number): { x: number; y: number; h: number } | null {
  if (!box.isConnected) return null;
  const computed = getComputedStyle(box);
  const mirror = document.createElement("div");
  const s = mirror.style;
  for (const key of MIRRORED) s[key] = computed[key];
  s.position = "fixed";
  s.top = "0";
  s.left = "-9999px";
  s.visibility = "hidden";
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = "break-word";
  s.borderStyle = "solid";
  mirror.textContent = box.value.slice(0, index);
  const mark = document.createElement("span");
  mark.textContent = "​";
  mirror.append(mark, box.value.slice(index) || ".");
  document.body.append(mirror);
  const rect = box.getBoundingClientRect();
  const x = rect.left + box.clientLeft + mark.offsetLeft - box.scrollLeft;
  const y = rect.top + box.clientTop + mark.offsetTop - box.scrollTop;
  const h = mark.offsetHeight;
  mirror.remove();
  if (y < rect.top - 2 || y + h > rect.bottom + 2 || rect.width === 0) return null;
  return { x: Math.min(x, rect.right - 6), y, h };
}

export function DictationButton({
  capability,
  path,
  authHeaders,
  disabled = false,
}: {
  readonly capability: DictationCapability;
  /** Where sections go (POST /api/ops/dictation). */
  readonly path: string;
  /** The bearer and this tab's workspace, as every ops call sends them. */
  readonly authHeaders: () => Record<string, string>;
  readonly disabled?: boolean;
}) {
  const [mode, setModeState] = useState<Mode>("idle");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [status, setStatus] = useState("");
  const [marker, setMarker] = useState<{ x: number; y: number; h: number } | null>(null);
  const [floatAt, setFloatAt] = useState<{ left: number; bottom: number } | null>(null);
  /** A marker is owed: something is being said, or its text is on the way. */
  const [tracking, setTracking] = useState(false);
  const [still] = useState(reducedMotion);
  const hintId = useId();

  const rootRef = useRef<HTMLSpanElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<Mode>("idle");
  /** The stretch of listening the microphone is on for (or, after a tap, kept for a possible second press). */
  const current = useRef<Session | null>(null);
  /** Every stretch whose text has not all landed: a stopped one's last sections may still be on their way. */
  const sessions = useRef(new Set<Session>());
  /** The box's text as last seen, to tell what the person changed since. */
  const lastValue = useRef("");
  const watched = useRef<HTMLTextAreaElement | null>(null);
  const press = useRef<{ at: number; source: PressSource; stopOnRelease: boolean; swallow: boolean } | null>(null);
  /** After a tap: the microphone stays on this long, in case a second press makes it a double. */
  const armed = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGesture = useRef(0);
  /** When the last tap was let go, on the events' own clock. */
  const lastTap = useRef(-Infinity);
  const started = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  };

  const textarea = () => rootRef.current?.closest("form")?.querySelector("textarea") ?? null;

  /* ---- what the person is told ------------------------------------------------------------------------------- */

  const show = useCallback((next: Notice | null, ms?: number) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    if (!mounted.current) return;
    setNotice(next);
    if (next && ms)
      noticeTimer.current = setTimeout(() => {
        noticeTimer.current = null;
        if (mounted.current) setNotice(null);
      }, ms);
  }, []);

  /* ---- where the text lands ---------------------------------------------------------------------------------- */

  /** What the marker was last placed for: the box's place on the screen, its scroll, its text and the landing place. */
  const markerKey = useRef("");
  const refreshMarker = useCallback(() => {
    if (!mounted.current) return;
    // The stretch being spoken, or the oldest one still owed text.
    const s = [...sessions.current].find((x) => x.speaking || x.pending > 0);
    setTracking(s !== undefined);
    if (!s) {
      markerKey.current = "";
      return setMarker(null);
    }
    const box = s.draft.box;
    const r = box.getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height, box.scrollTop, box.value.length, s.draft.anchor.end].join();
    if (key === markerKey.current) return;
    markerKey.current = key;
    setMarker(pointInBox(box, s.draft.anchor.end));
  }, []);

  /** Take in what the person (or anything else) changed in the box since it was last seen: every landing place moves with it. */
  const adopt = useCallback(() => {
    const box = watched.current;
    if (!box || box.value === lastValue.current) return;
    // The person's cursor, when they are in the box, says where an edit was that the two texts alone leave open.
    const caret = document.activeElement === box ? box.selectionStart : null;
    for (const s of sessions.current) s.draft.anchor = shiftAnchor(s.draft.anchor, lastValue.current, box.value, caret);
    lastValue.current = box.value;
  }, []);

  /** A section's words into the box at the stretch's landing place. The box is never submitted, and focus never taken. */
  const land = useCallback(
    (session: Session, text: string) => {
      const { draft } = session;
      const box = draft.box;
      if (!box.isConnected) return;
      adopt();
      const before = box.value;
      const { start, end } = draft.anchor;
      const selStart = box.selectionStart ?? before.length;
      const selEnd = box.selectionEnd ?? before.length;
      const scroll = box.scrollTop;
      const { value, caret } = insertDictated(before, start, end, text);
      if (value === before) return;
      const inserted = value.length - before.length + (end - start);
      // Seen before it is set: the box's own "input" event then finds nothing of the person's to take in.
      lastValue.current = value;
      setBoxValue(box, value);
      for (const s of sessions.current) {
        if (s === session) s.draft.anchor = { start: caret, end: caret };
        // An earlier stretch still owed text at this very place keeps it: its words were spoken first, so they go first.
        else if (!(s.order < session.order && s.draft.anchor.start === start && s.draft.anchor.end === start)) s.draft.anchor = shiftAnchor(s.draft.anchor, before, value);
      }
      lastValue.current = box.value;
      if (document.activeElement === box) {
        // The person is in the box: their cursor keeps its place in their own text (after the new words, if it was at them).
        const at = (pos: number) => (pos === end && selStart === selEnd ? caret : shiftCaret(pos, start, end, inserted));
        box.setSelectionRange(at(selStart), at(selEnd));
        box.scrollTop = scroll;
      } else {
        // They are not: the cursor waits after the words, where the next press carries on from.
        box.setSelectionRange(caret, caret);
      }
    },
    [adopt],
  );

  useEffect(() => {
    const onChange = () => {
      adopt();
      refreshMarker();
    };
    document.addEventListener("input", onChange, true);
    return () => document.removeEventListener("input", onChange, true);
  }, [adopt, refreshMarker]);

  /* ---- listening --------------------------------------------------------------------------------------------- */

  const begin = useCallback(
    (source: PressSource, handsFree: boolean) => {
      const box = textarea();
      if (!box || current.current) return;
      if (!canListen()) {
        show({ kind: "error", text: UNSUPPORTED_TEXT });
        return;
      }
      if (sessions.current.size === 0 || watched.current !== box) {
        watched.current = box;
        lastValue.current = box.value;
      } else adopt();
      const session: Session = {
        order: ++started.current,
        draft: { box, anchor: { start: box.selectionStart ?? box.value.length, end: box.selectionEnd ?? box.value.length } },
        source,
        handsFree,
        listening: null,
        ready: false,
        ended: false,
        speaking: false,
        pending: 0,
        startedAt: 0,
        problem: false,
        cancel: () => {},
      };
      sessions.current.add(session);
      current.current = session;
      setMode(handsFree ? "latched" : "hold");
      setReady(false);
      setElapsed(0);
      show(null);

      const countPending = () => setPending([...sessions.current].reduce((n, s) => n + s.pending, 0));
      const stopped = (reason: StopReason) => {
        session.ended = true;
        if (current.current !== session) return;
        current.current = null;
        press.current = null;
        if (!mounted.current) return;
        setMode("idle");
        setReady(false);
        micRef.current?.style.removeProperty("--dictation-level");
        if (reason === "quiet") {
          setStatus(quietStopText(capability.idle_stop_seconds));
          show({ kind: "info", text: quietStopText(capability.idle_stop_seconds) }, NOTICE_MS);
        } else if (reason === "limit") {
          setStatus(sessionLimitText(capability.max_session_seconds));
          // When it is the server that said so, its own words are already up.
          if (!session.problem) show({ kind: "info", text: sessionLimitText(capability.max_session_seconds) }, NOTICE_MS);
        } else if (reason === "stopped") setStatus(STOPPED_STATUS);
      };
      const settledNow = (summary: { reason: StopReason; words: boolean; problem: boolean }) => {
        sessions.current.delete(session);
        if (!mounted.current) return;
        countPending();
        refreshMarker();
        // Held, spoke, and nothing came of it: say so, rather than leave the box silently empty.
        if (summary.reason === "stopped" && !summary.words && !summary.problem && !session.handsFree) show({ kind: "error", text: NO_SPEECH_TEXT }, NOTICE_MS);
        // A pointer's hold ends with the cursor in the box after the words, ready to edit or send. A keyboard's stays
        // on the microphone, to press again.
        const active = document.activeElement;
        if (summary.words && session.source === "pointer" && !current.current && (active === micRef.current || active === document.body) && box.isConnected) {
          box.focus();
          box.setSelectionRange(session.draft.anchor.end, session.draft.anchor.end);
        }
      };

      loadEngine().then(
        (m) => {
          if (session.ended) return;
          session.listening = m.startListening({
            capability,
            path,
            authHeaders,
            handsFree: session.handsFree,
            animate: !still,
            onReady() {
              session.ready = true;
              session.startedAt = performance.now();
              if (current.current !== session || !mounted.current) return;
              setReady(true);
              if (modeRef.current !== "idle") setStatus(session.handsFree ? LATCHED_STATUS : HOLD_STATUS);
            },
            onLevel(level) {
              if (current.current === session) micRef.current?.style.setProperty("--dictation-level", level.toFixed(3));
            },
            onSpeaking(speaking) {
              session.speaking = speaking;
              refreshMarker();
            },
            onText(text) {
              land(session, text);
              refreshMarker();
            },
            onPending(count) {
              session.pending = count;
              if (mounted.current) countPending();
              refreshMarker();
            },
            onProblem(text) {
              session.problem = true;
              show({ kind: "error", text });
            },
            onStopped: stopped,
            onSettled: settledNow,
          });
        },
        () => {
          // The engine's file did not arrive.
          if (session.ended) return;
          show({ kind: "error", text: SEND_FAILED_TEXT });
          stopped("failed");
          settledNow({ reason: "failed", words: false, problem: true });
        },
      );
      session.cancel = (reason) => {
        stopped(reason);
        settledNow({ reason, words: false, problem: false });
      };
    },
    [adopt, authHeaders, capability, land, path, refreshMarker, show, still],
  );

  const stop = useCallback((reason: StopReason) => {
    if (armed.current) clearTimeout(armed.current);
    armed.current = null;
    const session = current.current;
    if (!session) return;
    if (session.listening) session.listening.stop(reason);
    else {
      session.ended = true;
      session.cancel(reason);
    }
  }, []);

  const latch = useCallback(() => {
    const session = current.current;
    if (!session) return;
    if (armed.current) clearTimeout(armed.current);
    armed.current = null;
    session.handsFree = true;
    session.listening?.setHandsFree(true);
    setMode("latched");
    show(null);
    setStatus(LATCHED_STATUS);
  }, [show]);

  /* ---- the gestures ------------------------------------------------------------------------------------------ */

  /*
   * How long a press was held, and how soon the next one came, are read from the EVENTS' own time stamps (when the
   * finger or key moved), not from when this code got to run: a page busy with something else must not turn a tap
   * into a hold, or a double-click into two taps.
   */
  const down = useCallback(
    (source: PressSource, stamp: number) => {
      lastGesture.current = performance.now();
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      setNotice((n) => (n?.kind === "hint" ? null : n));
      press.current = { at: stamp, source, stopOnRelease: false, swallow: false };
      if (modeRef.current === "latched") {
        press.current.stopOnRelease = true;
        return;
      }
      if (modeRef.current !== "idle") return;
      if (stamp - lastTap.current < DOUBLE_PRESS_MS) {
        // The second press of a double: keep listening, and this press's release is not a stop.
        lastTap.current = -Infinity;
        press.current.swallow = true;
        if (current.current) latch();
        else begin(source, true);
        return;
      }
      // A tap's microphone still waiting for a second press that this one came too late to be: let it go, start afresh.
      if (current.current) stop("discarded");
      begin(source, false);
    },
    [begin, latch, stop],
  );

  const up = useCallback(
    (stamp: number, cancelled = false) => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      lastGesture.current = performance.now();
      if (p.swallow) return;
      if (p.stopOnRelease) return stop("stopped");
      const session = current.current;
      if (modeRef.current !== "hold" || !session) return;
      if (stamp - p.at >= TAP_MS && session.ready) return stop("stopped");
      // A tap (or a release before the microphone was even on): not a recording. Say how the button works, and keep the
      // microphone a moment in case this is the first press of a double.
      setMode("idle");
      if (cancelled) return stop("discarded");
      lastTap.current = stamp;
      show({ kind: "hint", text: HINT_TEXT }, HINT_MS);
      armed.current = setTimeout(() => {
        armed.current = null;
        stop("discarded");
      }, DOUBLE_PRESS_MS);
    },
    [show, stop],
  );

  /** Hands-free on or off in one step: Shift+Enter, and a click that came with no press (an assistive tool's). */
  const toggle = useCallback(
    (source: PressSource) => {
      lastGesture.current = performance.now();
      if (modeRef.current === "idle" && !current.current) begin(source, true);
      else if (modeRef.current === "idle") latch();
      else stop("stopped");
    },
    [begin, latch, stop],
  );

  // Escape stops it from anywhere on the page: hands-free, the cursor is usually in the message box.
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop("stopped");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [mode, stop]);

  // The clock in the badge.
  useEffect(() => {
    if (mode === "idle" || !ready) return;
    const tick = () => {
      const s = current.current;
      if (s?.ready) setElapsed(performance.now() - s.startedAt);
    };
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [mode, ready]);

  useEffect(() => {
    if (disabled) stop("stopped");
  }, [disabled, stop]);

  useEffect(() => {
    mounted.current = true;
    const live = sessions.current;
    return () => {
      mounted.current = false;
      for (const t of [armed.current, noticeTimer.current, hoverTimer.current]) if (t) clearTimeout(t);
      for (const s of live) {
        s.ended = true;
        s.listening?.stop("discarded");
      }
      live.clear();
      current.current = null;
    };
  }, []);

  // The tooltip or problem sits just above the button, kept inside the screen; the marker sits at the landing place.
  // Both follow what they are anchored to, frame by frame, for as long as they show: the page under them scrolls,
  // resizes and grows (a reply streaming in above the composer) with no event that says so.
  useLayoutEffect(() => {
    if (!notice) setFloatAt(null);
    if (!notice && !tracking) return;
    let frame = 0;
    const place = () => {
      const mic = micRef.current?.getBoundingClientRect();
      if (notice && mic) {
        const width = floatRef.current?.offsetWidth ?? 0;
        // Its left edge on the button's, so it stays over the composer; pulled in where the screen ends.
        const left = Math.round(Math.max(8, Math.min(mic.left, window.innerWidth - width - 8)));
        const bottom = Math.round(window.innerHeight - mic.top + 8);
        setFloatAt((was) => (was && was.left === left && was.bottom === bottom ? was : { left, bottom }));
      }
      if (tracking) refreshMarker();
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [notice, tracking, refreshMarker]);

  const listening = mode !== "idle";
  const tone = mode === "hold" ? HOLD : mode === "latched" ? LATCHED : "";

  return (
    <span ref={rootRef} className="relative inline-flex" data-testid="dictation" data-state={mode} data-ready={ready} data-pending={pending} data-motion={still ? "reduced" : "full"}>
      <style>{STYLE}</style>
      <button
        ref={micRef}
        type="button"
        className={`${BUTTON} ${tone}`}
        disabled={disabled}
        aria-label={MIC_LABEL}
        aria-pressed={mode === "latched"}
        aria-describedby={notice?.kind === "hint" ? hintId : undefined}
        aria-keyshortcuts="Space Shift+Enter Escape"
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* a pointer that cannot be captured still releases over the button */
          }
          down("pointer", e.timeStamp);
        }}
        onPointerUp={(e) => up(e.timeStamp)}
        onPointerCancel={(e) => up(e.timeStamp, true)}
        onLostPointerCapture={(e) => {
          if (press.current?.source === "pointer") up(e.timeStamp);
        }}
        onPointerEnter={(e) => {
          void loadEngine().catch(() => {});
          if (e.pointerType !== "mouse" || modeRef.current !== "idle") return;
          hoverTimer.current = setTimeout(() => {
            if (modeRef.current === "idle" && !press.current) show({ kind: "hint", text: HINT_TEXT });
          }, 600);
        }}
        onPointerLeave={() => {
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
          setNotice((n) => (n?.kind === "hint" && !noticeTimer.current ? null : n));
        }}
        onFocus={() => void loadEngine().catch(() => {})}
        onBlur={(e) => {
          if (press.current?.source === "key") up(e.timeStamp);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && notice) {
            show(null);
            return;
          }
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          if (e.repeat) return;
          if (e.key === "Enter" && e.shiftKey) return toggle("key");
          down("key", e.timeStamp);
        }}
        onKeyUp={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          up(e.timeStamp);
        }}
        onClick={(e) => {
          e.preventDefault();
          // A press (pointer or key) has already been handled. A click with none behind it is an assistive tool's
          // "activate": it cannot hold, so it turns hands-free listening on and off.
          if (performance.now() - lastGesture.current > 800) toggle("other");
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {listening && ready ? (
          <>
            <span aria-hidden="true" className="dictation-ring dictation-level" />
            <span aria-hidden="true" className="dictation-ring dictation-beat" data-testid="dictation-beat" />
          </>
        ) : null}
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`relative size-4${listening && !ready ? " opacity-60" : ""}`}>
          {MIC.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
        {listening && ready ? (
          <span
            aria-hidden="true"
            data-testid="dictation-timer"
            className={`pointer-events-none absolute -top-1.5 -right-2 rounded-full px-1 text-[9px] leading-[14px] font-semibold tabular-nums text-white ${mode === "latched" ? "bg-sky-700" : "bg-red-700"}`}
          >
            {clockText(elapsed)}
          </span>
        ) : null}
        {!listening && pending > 0 ? (
          <span aria-hidden="true" data-testid="dictation-busy" className="dictation-turn pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sky-500! border-t-transparent!" />
        ) : null}
      </button>
      <span role="status" aria-live="polite" className="sr-only" data-testid="dictation-status">
        {status}
      </span>
      {notice || marker
        ? createPortal(
            <>
              {notice ? (
                <div
                  ref={floatRef}
                  id={notice.kind === "hint" ? hintId : undefined}
                  role={notice.kind === "hint" ? "tooltip" : notice.kind === "error" ? "alert" : undefined}
                  data-testid={`dictation-${notice.kind === "info" ? "notice" : notice.kind}`}
                  style={{ position: "fixed", left: floatAt?.left ?? 0, bottom: floatAt?.bottom ?? 0, visibility: floatAt ? "visible" : "hidden", maxWidth: "min(20rem, calc(100vw - 16px))" }}
                  className={`z-50 flex items-start gap-2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md ${
                    notice.kind === "error" ? "text-amber-800 dark:text-amber-400" : "text-popover-foreground"
                  } ${notice.kind === "hint" ? "pointer-events-none whitespace-nowrap" : ""}`}
                >
                  <span className="flex-1">{notice.text}</span>
                  {notice.kind === "hint" ? null : (
                    <button type="button" onClick={() => show(null)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent">
                      Dismiss
                    </button>
                  )}
                </div>
              ) : null}
              {marker ? (
                <span
                  aria-hidden="true"
                  data-testid="dictation-marker"
                  style={{ position: "fixed", left: marker.x, top: marker.y, height: marker.h }}
                  className="dictation-shimmer pointer-events-none z-40 flex items-center gap-0.5 text-sky-600 dark:text-sky-400"
                >
                  <span className="h-[1.1em] w-0.5 rounded-full bg-current" />
                  <span className="h-1 w-3 rounded-full bg-current opacity-60" />
                </span>
              ) : null}
            </>,
            document.body,
          )
        : null}
    </span>
  );
}
