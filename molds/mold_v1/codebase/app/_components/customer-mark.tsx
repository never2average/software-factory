"use client";

import { cn } from "@/lib/utils";

/**
 * A client "logo" mark. We have no real logo assets (and the CSP blocks remote
 * images anyway), so this renders a distinctive monogram instead of a plain
 * initial: up to two letters drawn from the company name, in a per-client
 * deterministic hue so every customer reads as distinct. The tile is primarily
 * white with just a whisper of the hue and a thin, light border — a restrained,
 * tasteful logo-chip look rather than a saturated block.
 */

/** Stable 0–359 hue from the name (simple string hash). */
function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * Up to two letters that best identify the company. Parentheticals like "(COS)",
 * "(V2T)", "(POC)" are dropped first (they're product/variant tags, not the
 * name), then we take the initials of the first two words — so "Axis Bank",
 * "Axis Finance", "Axis AMC" read as AB / AF / AA rather than all "A".
 */
function markInitials(name: string): string {
  const clean = (name ?? "").replace(/\([^)]*\)/g, " ").trim();
  const words = clean.split(/[\s/]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? (name || "?");
  return w.slice(0, 2).toUpperCase();
}

// Rounded-square tiles with the corner radius scaled to the tile so every size
// reads as a squircle-ish logo, never a circle. The small sizes carry larger,
// bolder glyphs than before — the whole point of the mark is that the initials
// are legible at a glance.
const SIZES = {
  xs: "size-4 rounded-[4px] text-[8px]",
  sm: "size-5 rounded-[5px] text-[9px]",
  md: "size-7 rounded-md text-[11px]",
  lg: "size-9 rounded-lg text-sm",
} as const;

export function CustomerMark({
  name,
  size = "md",
  className,
}: {
  readonly name: string;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}) {
  const hue = hueFromName(name || "?");
  return (
    <span
      aria-hidden="true"
      title={name}
      className={cn(
        "grid shrink-0 place-items-center border font-bold uppercase leading-none tracking-tight",
        SIZES[size],
        className,
      )}
      // Inline style is allowed by the CSP (style-src 'unsafe-inline'). A real
      // tint — saturated pastel ground, matching border, deep same-hue initials —
      // so the mark reads as a logo tile in BOTH themes (a light logo chip on a
      // dark UI is the standard treatment, and far more legible than the old
      // near-white wash whose initials disappeared at small sizes).
      style={{
        backgroundColor: `hsl(${hue} 70% 90%)`,
        borderColor: `hsl(${hue} 55% 74%)`,
        color: `hsl(${hue} 65% 27%)`,
      }}
    >
      {markInitials(name)}
    </span>
  );
}
