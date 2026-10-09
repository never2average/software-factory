/**
 * Ops Center design tokens — the single source of truth for type, spacing,
 * surfaces, button hierarchy, and status colors used by the Ops Center modal.
 *
 * Rules:
 * - Components never pick a `text-*` size directly; they ask for a TYPE ROLE.
 * - Padding combos come from SPACE, not ad-hoc `px-* py-*` pairs.
 * - Every button resolves to an intent (primary|secondary|ghost|danger) and a
 *   size (xs|sm) via BUTTON_INTENT / BUTTON_SIZE, layered on the shared
 *   `components/ui/button.tsx` cva variants.
 * - Borders/radii/tints come from SURFACE.
 * - Status string → dot color lives in one place: `statusDot()` + STATUS_META.
 *
 * See app/_components/ops/README.md for the full usage guide.
 */

import type { VariantProps } from "class-variance-authority";
import type { buttonVariants } from "@/components/ui/button";

/* ------------------------------- Type roles ------------------------------ */

/**
 * Named by JOB, not by size. Each role maps to exactly one `text-*` token
 * from app/globals.css.
 *
 * - heading      wizard step headings (the only base-size text in the modal)
 * - title        panel titles + section-card titles
 * - label        uppercase column headers & review-summary keys
 * - sectionLabel uppercase icon-labelled detail-section headings
 * - body         primary row text, detail values, form controls, buttons
 * - meta         secondary/muted detail: cell subtext, hints, feed timestamps
 * - micro        finest print: field hints, footnotes, kbd, the system badge
 */
export const TYPE = {
  heading: "font-semibold text-base leading-tight",
  title: "font-semibold text-sm",
  label: "font-medium text-2xs uppercase tracking-wide",
  sectionLabel: "font-medium text-3xs uppercase tracking-wide",
  body: "text-xs",
  meta: "text-2xs",
  micro: "text-3xs",
} as const;

/* ------------------------------ Spacing scale ---------------------------- */

/**
 * The five padding/gap jobs in the modal. Anything not listed here derives
 * from one of these (e.g. a table's first cell adds `pl-4` to align with the
 * card edge — see `Th`/`NameCell` in primitives).
 *
 * - cell        table body cells
 * - headerCell  table header cells + the table footer bar (chrome rows)
 * - panelBody   the side panel's scrollable body
 * - panelFooter pinned side-panel footers (Save/Cancel, wizard nav)
 * - gaps        section (between detail sections) > form (between fields)
 *               > field (label → control)
 */
export const SPACE = {
  cell: "px-3 py-2.5",
  headerCell: "px-3 py-2",
  panelBody: "px-5 py-4",
  panelFooter: "px-5 py-3",
  chromeBar: "px-4 py-2",
  sectionGap: "gap-4",
  formGap: "gap-3",
  fieldGap: "gap-1",
} as const;

/* -------------------------------- Density -------------------------------- */

/**
 * The tables render at two explicit densities:
 * - "full"    — resting state; the table spans the modal and shows all columns.
 * - "compact" — the side panel is open (30/70 split); only Name + Actions
 *               render. Cell padding is IDENTICAL in both densities — density
 *               only controls which columns exist, never their spacing.
 */
export type TableDensity = "full" | "compact";

/* -------------------------------- Surfaces ------------------------------- */

export const SURFACE = {
  /** Elevated cards inside the modal: header card, table card, side panel. */
  card: "rounded-xl border border-border bg-card",
  /** Floating overlays: the ⌘K editor, confirm dialog body. */
  overlay: "rounded-xl border border-border bg-popover shadow-2xl",
  /** The Ops Center modal itself. */
  modal: "rounded-2xl border border-white/10 bg-popover shadow-2xl ring-1 ring-white/5",
  /** Recessed framed blocks: summary lists, run-history rows, code blocks. */
  inset: "rounded-lg border border-border/60",
  /** Tiny muted pill used inside table cells (trigger, cadence, access). */
  chip: "rounded bg-muted px-1.5 py-0.5",
  /** Cron-expression chip in detail panels. */
  codeChip: "rounded-md border border-border bg-muted/40 px-2 py-1 font-mono",
  /** Row states. */
  rowHover: "hover:bg-muted/30",
  rowSelected: "bg-primary/[0.06]",
  /** Pinned system-cron rows get a faint tint to read as a distinct band. */
  rowSystem: "bg-muted/[0.04]",
} as const;

/**
 * Density overrides applied on top of `components/ui/input.tsx` /
 * `textarea.tsx` so the shared shadcn controls match the modal's compact
 * scale (the modal is one step denser than the app default).
 */
export const CONTROL =
  "h-auto min-h-0 rounded-lg border-border bg-background/60 px-2.5 py-1.5 text-xs shadow-none md:text-xs dark:bg-background/60 placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-0 field-sizing-fixed";

/**
 * A control that has to sit INSIDE a dense list row (the secrets editor) rather
 * than in a form. Both halves matter: `md:text-2xs` is not redundant — CONTROL
 * sets `md:text-xs`, and tailwind-merge keeps a `md:` variant against a base
 * one, so a plain `text-2xs` would silently lose on every desktop viewport and
 * the input would render a step larger than the row it sits in.
 */
export const CONTROL_DENSE = "h-6 rounded-md px-2 py-0.5 text-2xs md:text-2xs";

/* ------------------------------ Inline editing ---------------------------- */

/**
 * Inline-editable detail values (see `InlineField` in detail.tsx). At rest the
 * value renders as quiet text with a discoverable-but-subtle hover cue (faint
 * tint + a small pencil); activating it swaps the text for a control in place.
 * Read-only/derived values never get these classes — they stay plain text with
 * no hover affordance.
 */
export const INLINE = {
  /** The resting value, as a button: full-bleed hit area, faint hover tint. */
  editable:
    "group/inline -mx-1.5 -my-1 flex w-full min-w-0 cursor-text items-start gap-1.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40",
  /** Pencil cue: invisible until the value is hovered or keyboard-focused. */
  pencil:
    "mt-0.5 size-3 shrink-0 text-transparent transition-colors group-hover/inline:text-muted-foreground/60 group-focus-visible/inline:text-muted-foreground/60",
} as const;

/* ---------------------------- Button hierarchy --------------------------- */

export type ButtonIntent = "primary" | "secondary" | "ghost" | "danger";
export type OpsButtonSize = "xs" | "sm";

type UiVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type UiSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/**
 * Intent → shared Button variant (+ the ops skin layered on top).
 *
 * - primary    filled; the one advancing action on a surface (Save, Next)
 * - secondary  outlined quiet action (Cancel, Clear override, Add, Restore)
 * - ghost      chrome-level action with no frame (Back, ⌘K editor Cancel)
 * - danger     destructive confirmation (Delete)
 */
export const BUTTON_INTENT: Record<ButtonIntent, { variant: UiVariant; cls: string }> = {
  primary: { variant: "default", cls: "" },
  secondary: {
    variant: "outline",
    cls: "border-border bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground dark:border-border dark:bg-transparent dark:hover:bg-muted",
  },
  ghost: { variant: "ghost", cls: "text-muted-foreground hover:text-foreground" },
  danger: { variant: "destructive", cls: "" },
};

/**
 * Ops size → shared Button size (+ density adjustments).
 *
 * - sm  the standard modal button (wizard nav, dialog confirm/cancel)
 * - xs  quiet chrome (the Add button, footer Restore affordances)
 */
export const BUTTON_SIZE: Record<OpsButtonSize, { ui: UiSize; cls: string }> = {
  sm: { ui: "xs", cls: "h-7 gap-1.5 rounded-lg px-3 has-[>svg]:px-3" },
  xs: { ui: "2xs", cls: "" },
};

/* --------------------------------- Status -------------------------------- */

/** Connector status pills + labels (kept for label lookups in detail views). */
export const STATUS_META: Record<string, { label: string; pill: string; dot: string }> = {
  connected: {
    label: "connected",
    pill: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-500",
    dot: "bg-emerald-500",
  },
  read_only: { label: "read-only", pill: "bg-sky-500/10 text-sky-800 dark:text-sky-500", dot: "bg-sky-500" },
  setup: { label: "setup", pill: "bg-amber-500/10 text-amber-800 dark:text-amber-500", dot: "bg-amber-500" },
};

/** Traffic-light dot color for ANY status string (red / amber / green). */
export function statusDot(status: string): string {
  const s = status.toLowerCase();
  if (["connected", "read_only", "live", "active", "ok", "healthy"].includes(s)) {
    return "bg-emerald-500";
  }
  if (["setup", "pending", "configuring", "syncing", "paused"].includes(s)) {
    return "bg-amber-500";
  }
  if (["error", "disconnected", "failed", "revoked", "down"].includes(s)) {
    return "bg-red-500";
  }
  return "bg-muted-foreground/40";
}

/** Run-history entry status → dot treatment. */
export const RUN_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  failed: "bg-red-500",
  running: "animate-pulse bg-amber-500",
};
