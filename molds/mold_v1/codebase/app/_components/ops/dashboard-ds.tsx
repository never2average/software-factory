"use client";

/**
 * The MCP-UI design system: the SINGLE source of truth for how agent-generated
 * dashboard widgets look. Every widget composes from the primitives here, and
 * every colour comes from the `TONE` token map — no widget hand-rolls a colour
 * or a surface. The agent's spec is constrained to this vocabulary (a closed
 * set of tones / widths / block types), so consistency is enforced by
 * construction rather than by remembering to apply the right class.
 *
 * It builds on the Ops Center's own tokens (`TYPE`, `SURFACE`) so the
 * agent-generated UI and the human-authored UI share one visual language.
 */

import { cn } from "@/lib/utils";
import { TYPE } from "./tokens";

/* ---------------------------------- tones --------------------------------- */

export type Tone = "default" | "good" | "warn" | "critical" | "info";

/** Semantic colour, one place. Matches the platform's status palette
 *  (emerald / amber / red / sky) used across the Ops Center. */
export const TONE: Record<Tone, { dot: string; text: string; bar: string; ring: string }> = {
  default: {
    dot: "bg-muted-foreground/40",
    text: "text-foreground",
    bar: "bg-muted-foreground/50",
    ring: "border-border",
  },
  good: {
    dot: "bg-emerald-500",
    text: "text-emerald-500",
    bar: "bg-emerald-500/70",
    ring: "border-emerald-500/30",
  },
  warn: {
    dot: "bg-amber-500",
    text: "text-amber-500",
    bar: "bg-amber-500/70",
    ring: "border-amber-500/30",
  },
  critical: {
    dot: "bg-red-500",
    text: "text-red-400",
    bar: "bg-red-500/70",
    ring: "border-red-500/30",
  },
  info: {
    dot: "bg-sky-500",
    text: "text-sky-400",
    bar: "bg-sky-500/70",
    ring: "border-sky-500/30",
  },
};

/** Coerce any agent-supplied value to a valid tone — the enforcement point. */
export const asTone = (t?: string): Tone => (t && t in TONE ? (t as Tone) : "default");

/** Ordered hues for un-toned categorical series (bars, funnels). */
export const HUES: Tone[] = ["info", "good", "warn", "critical", "default"];

/* -------------------------------- primitives ------------------------------ */

/** The one card surface every widget sits in. */
export function Surface({
  className,
  onClick,
  title,
  children,
}: {
  readonly className?: string;
  readonly onClick?: () => void;
  readonly title?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      onClick={onClick}
      title={title}
      className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-muted/[0.06] p-3.5", className)}
    >
      {children}
    </section>
  );
}

/** A widget's heading, uppercase and quiet. */
export function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <h4 className={cn("mb-2.5 font-medium text-muted-foreground/80 uppercase tracking-wide", TYPE.micro)}>
      {children}
    </h4>
  );
}

/** Surface + optional heading — the default widget frame. */
export function WidgetCard({
  title,
  className,
  children,
}: {
  readonly title?: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Surface className={className}>
      {title ? <SectionLabel>{title}</SectionLabel> : null}
      {children}
    </Surface>
  );
}

export function ToneDot({ tone, className }: { readonly tone?: Tone; readonly className?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", TONE[asTone(tone)].dot, className)} />;
}

/** A proportional bar (funnel stage, category, load). */
export function Meter({
  value,
  max,
  tone,
}: {
  readonly value: number;
  readonly max: number;
  readonly tone?: Tone;
}) {
  return (
    <span className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <span
        className={cn("block h-full rounded-full", TONE[asTone(tone)].bar)}
        style={{ width: `${Math.max(3, (value / Math.max(1, max)) * 100)}%` }}
      />
    </span>
  );
}

/* --------------------------------- mermaid -------------------------------- */

/**
 * Mermaid renders its own SVG island we can't fully theme through tokens, so we
 * map its variables onto OUR palette: bright, contrasting slice colours + light
 * title/legend text, so a residual chart (flowchart, time-series) stays legible
 * and roughly on-brand. Native widgets (bars/funnel/…) are always preferred.
 */
export const MERMAID_THEME = {
  config: {
    theme: "base" as const,
    themeVariables: {
      fontFamily: "inherit",
      textColor: "#e5e7eb",
      lineColor: "#6b7280",
      primaryColor: "#1f2937",
      primaryTextColor: "#e5e7eb",
      primaryBorderColor: "#374151",
      // pie
      pie1: "#38bdf8",
      pie2: "#34d399",
      pie3: "#fbbf24",
      pie4: "#f87171",
      pie5: "#a78bfa",
      pie6: "#94a3b8",
      pie7: "#22d3ee",
      pie8: "#f472b6",
      pieTitleTextColor: "#e5e7eb",
      pieSectionTextColor: "#0b0b0f",
      pieLegendTextColor: "#e5e7eb",
      pieStrokeColor: "#0b0b0f",
      pieOuterStrokeColor: "#0b0b0f",
      // xychart
      xyChartTitleColor: "#e5e7eb",
    },
  },
};
