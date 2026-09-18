"use client";

/**
 * A plain-text editor with a line-number gutter, sized to fill its panel.
 *
 * Deliberately a real <textarea> rather than a contenteditable surface or an
 * embedded code editor: the content is a prompt, so selection, spellcheck,
 * undo, IME and every OS text affordance should behave exactly as the user
 * expects. The gutter is a separate element painted behind the same metrics
 * and scrolled in lockstep — which only holds if both sides share font,
 * size, line-height and vertical padding, so those live in one constant.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Shared metrics. The gutter and the text MUST agree or the numbers drift. */
const TEXT = "font-mono text-[12.5px] leading-[1.6]";
const PAD_Y = "py-2.5";

export function CodeEditor({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  className,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Called when the value should be persisted — debounced idle, and on blur. */
  readonly onCommit?: (next: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(0);

  const lineCount = useMemo(() => Math.max(1, value.split("\n").length), [value]);

  // Keep the gutter aligned with the text as it scrolls.
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const g = gutterRef.current;
    if (!ta || !g) return;
    g.scrollTop = ta.scrollTop;
    setScrolled(ta.scrollTop);
  }, []);

  // Persist on idle so nothing needs a Save button, and once more on unmount —
  // closing the panel mid-edit should not silently drop the last keystrokes.
  //
  // Three seconds. A prompt is written in paragraphs, and pausing mid-thought is
  // not the same as finishing: a short window fires while someone is still
  // composing, so the save state flickers through the whole draft. Blur still
  // commits immediately, so leaving the field never waits out the timer.
  const latest = useRef(value);
  latest.current = value;
  const committed = useRef(value);

  /**
   * Held in a ref, not read from the closure.
   *
   * Callers pass an inline arrow, so `onCommit` is a new function on every
   * render. With it in the dependency arrays below, the unmount cleanup ran on
   * every render instead of on unmount — committing on each keystroke, ~150ms
   * apart, well inside the debounce that was supposed to be preventing exactly
   * that. Typing "hello" wrote five saves and five versions.
   */
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (value === committed.current) return;
    const t = setTimeout(() => {
      committed.current = value;
      commitRef.current?.(value);
    }, 3000);
    return () => clearTimeout(t);
  }, [value]);

  // Genuinely on unmount only — closing the panel mid-edit must not drop the
  // last keystrokes, but nothing else here should trigger a write.
  useEffect(
    () => () => {
      if (latest.current !== committed.current) commitRef.current?.(latest.current);
    },
    [],
  );

  const gutterWidth = `${Math.max(2, String(lineCount).length) + 1.5}ch`;

  return (
    <div
      className={cn(
        "relative flex min-h-0 overflow-hidden rounded-lg border border-input bg-background/40 focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    >
      <div
        ref={gutterRef}
        aria-hidden
        style={{ width: gutterWidth }}
        className={cn(
          "shrink-0 select-none overflow-hidden border-input/60 border-r bg-muted/20 pr-2 text-right text-muted-foreground/40",
          TEXT,
          PAD_Y,
        )}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onBlur={() => {
          if (value !== committed.current) {
            committed.current = value;
            commitRef.current?.(value);
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(
          "min-h-0 flex-1 resize-none bg-transparent px-3 outline-none placeholder:text-muted-foreground/50 disabled:opacity-70",
          TEXT,
          PAD_Y,
        )}
      />
      {/* Only meaningful once the content overflows; silent otherwise. */}
      {scrolled > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-background/60 to-transparent" />
      )}
    </div>
  );
}
