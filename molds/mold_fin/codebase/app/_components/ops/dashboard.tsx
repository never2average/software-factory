"use client";

/**
 * Dashboard renderer for an app document. Instead of prose, an app emits a
 * structured spec — a grid of typed VISUAL widgets (KPI tiles, funnels, kanban
 * boards, timelines, charts, compact tables). This file parses that spec and
 * renders it; a document that ISN'T a spec falls back to Markdown upstream.
 *
 * The spec is deliberately forgiving: unknown block types and malformed fields
 * are skipped, never thrown, so a slightly-off generation still renders what it
 * can rather than blanking the whole app.
 */

import { createContext, useContext, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ArrowUpRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractLeadingJsonObject } from "@/lib/dashboard-spec";
import { TYPE } from "./tokens";
import { ChartWidget, type ChartBlock } from "./dashboard-charts";
import {
  TONE,
  asTone,
  WidgetCard,
  ToneDot,
  type Tone,
} from "./dashboard-ds";

type Width = "full" | "half";

/**
 * A widget's callback to the agent — a CLOSED enum, no arbitrary code (the safe
 * core of the MCP-UI idea). The host dispatches these:
 *  • chat    — open a chat seeded with the instruction; the agent proposes the
 *              tool call and the operator approves inline (human-in-the-loop).
 *  • open    — navigate to a chat session / record / URL.
 *  • refresh — regenerate this app.
 */
export type DashAction =
  | { kind: "chat"; prompt: string }
  | { kind: "open"; href: string }
  | { kind: "refresh" };

const ActionCtx = createContext<((a: DashAction) => void) | null>(null);
const useAction = () => useContext(ActionCtx);

interface KpiBlock {
  type: "kpi";
  width?: Width;
  label: string;
  value: string | number;
  sub?: string;
  tone?: Tone;
  action?: DashAction;
}
interface ActionsBlock {
  type: "actions";
  width?: Width;
  title?: string;
  buttons: { label: string; tone?: Tone; action: DashAction }[];
}
interface KanbanBlock {
  type: "kanban";
  width?: Width;
  title?: string;
  columns: {
    title: string;
    cards: { title: string; sub?: string; tone?: Tone; action?: DashAction }[];
  }[];
}
interface TimelineBlock {
  type: "timeline";
  width?: Width;
  title?: string;
  events: { date?: string; title: string; detail?: string; tone?: Tone }[];
}
interface TableBlock {
  type: "table";
  width?: Width;
  title?: string;
  columns: string[];
  rows: (string | number)[][];
}
type Block =
  | KpiBlock
  | ActionsBlock
  | KanbanBlock
  | TimelineBlock
  | ChartBlock
  | TableBlock;

export interface DashboardSpec {
  title?: string;
  blocks: Block[];
}

/**
 * Extract a dashboard spec from an app document, or null if it's plain prose.
 * Accepts the whole content as JSON, or a fenced ```json block inside it.
 */
export function parseDashboardSpec(content: string | null | undefined): DashboardSpec | null {
  if (!content) return null;
  const trimmed = content.trim();
  // Extract the balanced JSON object even when the model wrapped it in a fence
  // or left trailing chatter (e.g. a stray "[blocked]") — otherwise JSON.parse
  // throws on the whole string and the dashboard renders as raw text.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const jsonText = extractLeadingJsonObject(fenced ?? trimmed);
  if (!jsonText) return null;
  try {
    const v = JSON.parse(jsonText) as unknown;
    if (v && typeof v === "object" && Array.isArray((v as DashboardSpec).blocks)) {
      return v as DashboardSpec;
    }
  } catch {
    /* not json */
  }
  return null;
}


/* --------------------------------- widgets -------------------------------- */

function KpiWidget({ block }: { readonly block: KpiBlock }) {
  const t = asTone(block.tone);
  const dispatch = useAction();
  const clickable = Boolean(block.action && dispatch);
  return (
    <section
      onClick={clickable ? () => dispatch!(block.action!) : undefined}
      className={cn(
        "flex min-w-0 flex-col justify-center rounded-xl border border-border bg-muted/[0.06] p-3.5",
        clickable && "cursor-pointer transition-colors hover:border-foreground/30 hover:bg-muted/20",
      )}
    >
      <span className={cn("flex items-center gap-1 truncate font-medium text-muted-foreground uppercase tracking-wide", TYPE.micro)}>
        {block.label}
        {clickable ? <ArrowUpRightIcon className="size-3 opacity-50" /> : null}
      </span>
      <span className={cn("mt-1 font-semibold text-2xl tabular-nums", TONE[t].text)}>{block.value}</span>
      {block.sub ? (
        <span className={cn("mt-0.5 truncate text-muted-foreground", TYPE.micro)}>{block.sub}</span>
      ) : null}
    </section>
  );
}


function ActionsWidget({ block }: { readonly block: ActionsBlock }) {
  const dispatch = useAction();
  const buttons = (block.buttons ?? []).filter((b) => b && b.action);
  return (
    <WidgetCard title={block.title}>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b, i) => {
          const t = asTone(b.tone);
          return (
            <button
              key={i}
              type="button"
              onClick={() => dispatch?.(b.action)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-medium transition-colors",
                TYPE.meta,
                t === "critical"
                  ? "border-red-500/40 text-red-400 hover:bg-red-500/10"
                  : t === "good"
                    ? "border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10"
                    : "border-border text-foreground hover:bg-muted",
              )}
            >
              {b.action.kind === "open" ? (
                <ArrowUpRightIcon className="size-3.5" />
              ) : null}
              {b.label}
            </button>
          );
        })}
      </div>
    </WidgetCard>
  );
}


function KanbanWidget({ block }: { readonly block: KanbanBlock }) {
  const cols = block.columns ?? [];
  return (
    <WidgetCard title={block.title}>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {cols.map((col, ci) => (
          <div key={ci} className="flex w-44 shrink-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-1">
              <span className={cn("truncate font-medium", TYPE.meta)}>{col.title}</span>
              <span className={cn("shrink-0 text-muted-foreground/60", TYPE.micro)}>
                {(col.cards ?? []).length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {(col.cards ?? []).map((card, ki) => (
                <KanbanCard key={ki} card={card} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

function KanbanCard({
  card,
}: {
  readonly card: { title: string; sub?: string; tone?: Tone; action?: DashAction };
}) {
  const dispatch = useAction();
  const clickable = Boolean(card.action && dispatch);
  return (
    <div
      onClick={clickable ? () => dispatch!(card.action!) : undefined}
      className={cn(
        "rounded-lg border border-border bg-background px-2.5 py-1.5",
        clickable && "cursor-pointer transition-colors hover:border-foreground/30 hover:bg-muted/40",
      )}
    >
      <span className="flex items-center gap-1.5">
        <ToneDot tone={asTone(card.tone)} className="size-1.5" />
        <span className={cn("min-w-0 flex-1 truncate font-medium", TYPE.meta)}>{card.title}</span>
        {clickable ? <ArrowUpRightIcon className="size-3 shrink-0 opacity-40" /> : null}
      </span>
      {card.sub ? (
        <span className={cn("mt-0.5 block truncate text-muted-foreground", TYPE.micro)}>
          {card.sub}
        </span>
      ) : null}
    </div>
  );
}

function TimelineWidget({ block }: { readonly block: TimelineBlock }) {
  const events = block.events ?? [];
  return (
    <WidgetCard title={block.title}>
      <ol className="flex flex-col">
        {events.map((e, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="flex flex-col items-center">
              <ToneDot tone={asTone(e.tone)} className="mt-1" />
              {i < events.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 pb-3">
              {e.date ? (
                <span className={cn("text-muted-foreground/60", TYPE.micro)}>{e.date}</span>
              ) : null}
              <span className={cn("font-medium", TYPE.meta)}>{e.title}</span>
              {e.detail ? (
                <span className={cn("text-muted-foreground", TYPE.micro)}>{e.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </WidgetCard>
  );
}



/** A native category distribution — clear label + bar + value + %, no mermaid
 *  legend to clip or lose in the dark. The reliable choice over a pie. */

const TABLE_SIZES = [8, 15, 30] as const;

function TableWidget({ block }: { readonly block: TableBlock }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState<number>(TABLE_SIZES[0]);
  const cols = block.columns ?? [];
  const rows = block.rows ?? [];
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages - 1);
  const shown = total > size ? rows.slice(current * size, current * size + size) : rows;
  return (
    <WidgetCard title={block.title}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-border border-b">
              {cols.map((c, i) => (
                <th
                  key={i}
                  className={cn(
                    "whitespace-nowrap px-2 py-1.5 text-left font-medium text-muted-foreground",
                    TYPE.micro,
                  )}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri} className="border-border/50 border-b last:border-0">
                {cols.map((_, ci) => (
                  <td key={ci} className={cn("px-2 py-1.5 align-top", TYPE.meta)}>
                    {String(r?.[ci] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > TABLE_SIZES[0] ? (
        <div className={cn("mt-2 flex items-center justify-between gap-2", TYPE.micro)}>
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(0);
            }}
            aria-label="Rows per page"
            className="h-6 rounded-md border border-border bg-background px-1.5 text-muted-foreground outline-none hover:text-foreground"
          >
            {TABLE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="tabular-nums">
              {current * size + 1}–{Math.min((current + 1) * size, total)} of {total}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Previous page"
                disabled={current === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="grid size-6 place-items-center rounded-md hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeftIcon className="size-3.5" />
              </button>
              <span className="tabular-nums">
                {current + 1}/{pages}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={current >= pages - 1}
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                className="grid size-6 place-items-center rounded-md hover:bg-muted disabled:opacity-40"
              >
                <ChevronRightIcon className="size-3.5" />
              </button>
            </span>
          </span>
        </div>
      ) : null}
    </WidgetCard>
  );
}

/* -------------------------------- dashboard ------------------------------- */

const KNOWN = new Set([
  "kpi",
  "actions",
  "kanban",
  "timeline",
  "chart",
  "table",
]);

function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case "kpi":
      return <KpiWidget block={block} />;
    case "actions":
      return <ActionsWidget block={block} />;
    case "kanban":
      return <KanbanWidget block={block} />;
    case "timeline":
      return <TimelineWidget block={block} />;
    case "chart":
      return <ChartWidget block={block} />;
    case "table":
      return <TableWidget block={block} />;
    default:
      return null;
  }
}

export function Dashboard({
  spec,
  onAction,
}: {
  readonly spec: DashboardSpec;
  readonly onAction?: (a: DashAction) => void;
}) {
  const blocks = (spec.blocks ?? []).filter((b) => b && KNOWN.has((b as Block).type));
  return (
    <ActionCtx.Provider value={onAction ?? null}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {blocks.map((block, i) => (
          // A "full" block spans both columns; KPI/callout default to half, the
          // rest to full so charts, kanban and tables get room.
          <div
            key={i}
            className={cn(
              (block.width ?? defaultWidth(block)) === "full" ? "sm:col-span-2" : "sm:col-span-1",
            )}
          >
            <BlockView block={block} />
          </div>
        ))}
      </div>
    </ActionCtx.Provider>
  );
}

function defaultWidth(block: Block): Width {
  return block.type === "kpi" ? "half" : "full";
}
