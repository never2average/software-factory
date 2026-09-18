# Ops Center design system

Everything the Ops Center modal renders comes from three layers. When a design
tweak is requested, change it at the highest layer that covers it — never
inline in a panel.

```
tokens.ts        the values: type roles, spacing, surfaces, buttons, status, inline-edit cues
primitives.tsx   the parts: Field, table bits, RowMenu, wizard scaffold…
detail.tsx       the detail-panel parts: DetailPanel, InlineField/InlineEnabled, run feed, SummaryList
{connectors,workflows,crons}-panel.tsx   the three sections (composition only)
lib.ts           non-visual: API types, opsFetch/useOpsList/usePager, PanelState
../ops-center.tsx   the modal shell (public exports: OpsCenter, OPS_SECTIONS, OpsSection)
```

## Type roles (`TYPE`)

Ask for a role, never a `text-*` size.

| Role           | Value                                    | Used for |
| -------------- | ---------------------------------------- | -------- |
| `heading`      | `font-semibold text-base`                | wizard step headings |
| `title`        | `font-semibold text-sm`                  | panel titles, section-card titles |
| `label`        | `font-medium text-2xs uppercase tracking-wide` | table column headers, summary keys |
| `sectionLabel` | `font-medium text-3xs uppercase tracking-wide` | icon-labelled detail sections |
| `body`         | `text-xs`                                | row text, detail values, controls, buttons |
| `meta`         | `text-2xs`                               | muted secondary detail, hints, timestamps |
| `micro`        | `text-3xs`                               | finest print: field hints, footnotes, kbd |

## Spacing (`SPACE`)

| Token         | Value        | Used for |
| ------------- | ------------ | -------- |
| `cell`        | `px-3 py-2.5`| table body cells (`Td`; edge cells add `pl-4`/`pr-4`) |
| `headerCell`  | `px-3 py-2`  | table header cells, summary-list rows |
| `panelBody`   | `px-5 py-4`  | side-panel scrollable body |
| `panelFooter` | `px-5 py-3`  | pinned side-panel footers |
| `chromeBar`   | `px-4 py-2`  | table footer bar |
| gaps          | `sectionGap` gap-4 > `formGap` gap-3 > `fieldGap` gap-1 | detail sections > form fields > label→control |

## Density

Tables have exactly two densities (`TableDensity`): **full** (resting state,
all columns) and **compact** (side panel open, 30/70 split — Name + Actions
only). Density changes which columns render, never the padding.

## Buttons

Every button is `<OpsButton intent size>` or `<IconButton intent>` (size-6
square). Intents map onto `components/ui/button.tsx` cva variants (extended
with a `2xs` size — do not fork it):

| Intent      | Job |
| ----------- | --- |
| `primary`   | the one advancing action on a surface (Save, Next/Create) |
| `secondary` | outlined quiet action (Cancel, Add, Clear override, Restore) |
| `ghost`     | chrome-level, frameless (Back, inline Cancel, icon buttons) |
| `danger`    | destructive confirmation (Delete) |

Sizes: `sm` (h-7 — the standard modal button) and `xs` (h-5 — quiet chrome:
the Add button, footer Restore chips).

## Surfaces (`SURFACE`)

`card` (header/table/side-panel), `overlay` (⌘K editor, confirm dialog),
`modal` (the Ops Center dialog), `inset` (summary lists, run rows, code
blocks), `chip`/`codeChip` (cell pills), and the row states `rowHover`,
`rowSelected`, `rowSystem`.

## Status

One place maps a status string → dot color: `statusDot()` in tokens.ts
(rendered via `StatusDot`/`StatusLine`), plus `STATUS_META` for connector
labels and `RUN_DOT` for run-history entries.

## Forms & inline editing

`Field` (label + control + hint) wraps `OpsInput` / `OpsTextarea` /
`OpsSelect` — the shared `components/ui` Input/Textarea skinned to the modal's
compact density via the `CONTROL` token (`OpsSelect` stays a native `<select>`
on purpose to keep behaviour identical). `WizardFrame` + `RadioCards` are the
stepped Add wizard scaffold — the only place full forms still exist.

Editing an existing record happens INLINE in the detail panel: `InlineField`
(text / multiline / number / select, styled by the `INLINE` tokens) renders
the value as quiet text with a hover pencil cue and swaps in the matching
control in place — Enter or blur commits (⌘⏎ for multiline), Escape cancels,
failures render inline and keep the draft. `InlineEnabled` is the boolean
variant built on `EnabledToggle`. Both PATCH the single changed field with
`actor` and refetch. Read-only/derived values stay plain text with no hover
affordance.
