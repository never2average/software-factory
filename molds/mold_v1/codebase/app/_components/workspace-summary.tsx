"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { opsFetch } from "./ops/lib";

/**
 * What needs attention in THIS workspace, in the sidebar.
 *
 * The signals already existed — triage, urgent tickets, overdue tasks,
 * unhealthy deployments, blocked implementations, failed runs — but each lived
 * in its own panel. "What changed while I was away" meant opening six of them
 * and remembering the previous numbers, so in practice nobody looked.
 *
 * It is deliberately silent when there is nothing to say. A notification
 * surface that renders "0" six times trains you to ignore it, and then it is
 * worth less than the space it occupies.
 */

interface Section {
  key: string;
  label: string;
  count: number;
  sample: string[];
}

export function WorkspaceSummary({
  onOpen,
  variant = "rail",
}: {
  onOpen?: (key: string) => void;
  /** "home" = the home screen under the composer; "rail" = the sidebar. */
  variant?: "home" | "rail";
}) {
  const [data, setData] = useState<{ total: number; sections: Section[] } | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await opsFetch<{ total: number; sections: Section[] }>("/api/ops/summary"));
    } catch {
      /* the summary is an aid, never the thing itself — stay quiet on failure */
    }
  }, []);

  useEffect(() => {
    void load();
    // Slow on purpose. This is a "while you were away" digest, not a live
    // ticker; polling it hard would cost six queries a minute to tell you
    // nothing changed.
    const t = setInterval(() => void load(), 120_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data || data.total === 0) return null;

  /**
   * On the home screen this is a section like the ones beneath it, not a
   * collapsed rail item — there is room, and the whole point of the home screen
   * is to tell you what to do next without a click.
   */
  if (variant === "home") {
    return (
      <section className="w-full">
        <h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Needs attention
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.sections.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onOpen?.(s.key)}
                className="flex w-full items-start gap-3 rounded-lg border border-border bg-card/40 p-3 text-left transition-colors hover:bg-muted/60"
              >
                <span className="mt-0.5 font-semibold text-lg tabular-nums leading-none">{s.count}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{s.label}</span>
                  {s.sample[0] ? (
                    <span className="block truncate text-muted-foreground text-xs">{s.sample[0]}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div className="px-3 pt-1 pb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-0 text-left font-medium text-foreground/90 text-xs leading-5 transition-colors hover:bg-muted hover:text-foreground"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-1.5 rounded-full bg-amber-500" />
        </span>
        <span className="flex-1 truncate">{data.total} need attention</span>
        <ChevronDownIcon
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <ul className="mt-0.5 mb-1 space-y-1 pl-5">
          {data.sections.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onOpen?.(s.key)}
                className="w-full text-left"
                title={s.sample.join("\n")}
              >
                <span className="flex items-baseline gap-1.5 text-3xs">
                  <span className="font-medium tabular-nums">{s.count}</span>
                  <span className="truncate text-muted-foreground">{s.label}</span>
                </span>
                {/* One example, because a count alone rarely tells you whether
                    it matters. The rest are in the tooltip. */}
                {s.sample[0] ? (
                  <span className="block truncate text-3xs text-muted-foreground">{s.sample[0]}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
