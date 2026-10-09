"use client";

/**
 * Workspace list cards, built from three shared, formattable primitives so
 * Tasks / Deployments / Implementations / the periods all look the same:
 *   - <WorkspaceCard>  the card shell + title + owner slot
 *   - <Badge>          a formattable primary/secondary badge (tone + icon)
 *   - <MetaLine>       the icon metadata row
 * Self-contained (plain props) so they render anywhere they're needed.
 */
import {
  Building2Icon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  ClockIcon,
  GaugeIcon,
  GitBranchIcon,
  LayersIcon,
  type LucideIcon,
  RocketIcon,
  ServerIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CustomerMark } from "../customer-mark";
import { Burndown } from "./burndown";

/* --------------------------------- Badge ---------------------------------- */

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
export type BadgeVariant = "primary" | "secondary";

const TONE: Record<BadgeTone, { primary: string; secondary: string }> = {
  neutral: { primary: "bg-muted text-foreground", secondary: "border border-border/60 bg-muted/50 text-muted-foreground" },
  accent: { primary: "bg-indigo-500 text-white", secondary: "bg-indigo-500/15 text-indigo-800 dark:text-indigo-300" },
  success: { primary: "bg-emerald-500 text-white", secondary: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300" },
  warning: { primary: "bg-amber-500 text-black", secondary: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  danger: { primary: "bg-red-500 text-white", secondary: "bg-red-500/15 text-red-800 dark:text-red-300" },
  info: { primary: "bg-sky-500 text-white", secondary: "bg-sky-500/15 text-sky-800 dark:text-sky-300" },
};

export function Badge({
  children,
  tone = "neutral",
  variant = "secondary",
  icon: Icon,
  className,
}: {
  readonly children: React.ReactNode;
  readonly tone?: BadgeTone;
  readonly variant?: BadgeVariant;
  readonly icon?: LucideIcon;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 truncate rounded-md px-2 py-1 font-medium text-xs",
        TONE[tone][variant],
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------- MetaLine --------------------------------- */

export type MetaItem = { icon?: LucideIcon; node: React.ReactNode; danger?: boolean };

export function MetaLine({ items }: { readonly items: readonly MetaItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
      {items.map((m, i) => (
        <span key={i} className={cn("inline-flex items-center gap-1", m.danger && "text-red-400")}>
          {m.icon ? <m.icon className="size-3.5" /> : null}
          {m.node}
        </span>
      ))}
    </div>
  );
}

/* ----------------------------- WorkspaceCard ------------------------------ */

export function WorkspaceCard({
  title,
  titleTestid,
  strike,
  headerRight,
  selected,
  onClick,
  testid,
  children,
}: {
  readonly title: React.ReactNode;
  readonly titleTestid?: string;
  readonly strike?: boolean;
  readonly headerRight?: React.ReactNode;
  readonly selected?: boolean;
  readonly onClick?: () => void;
  readonly testid?: string;
  readonly children?: React.ReactNode;
}) {
  const shell = cn(
    "group relative flex w-full flex-col gap-2 overflow-hidden rounded-xl border bg-card px-3 py-2.5 text-left transition-all duration-150",
    selected
      ? "border-foreground/30 shadow-[0_1px_0_0_rgba(255,255,255,0.04),0_4px_12px_-4px_rgba(0,0,0,0.4)]"
      : "border-border/60 hover:border-border hover:shadow-[0_2px_10px_-6px_rgba(0,0,0,0.5)]",
  );
  const header = (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {typeof title === "string" ? (
          <span
            data-testid={titleTestid}
            className={cn("line-clamp-2 font-semibold text-sm leading-snug", strike && "text-muted-foreground/60 line-through")}
          >
            {title}
          </span>
        ) : (
          title
        )}
      </div>
      {headerRight}
    </div>
  );
  return onClick ? (
    <button type="button" data-testid={testid} onClick={onClick} className={shell}>
      {header}
      {children}
    </button>
  ) : (
    <div data-testid={testid} className={shell}>
      {header}
      {children}
    </div>
  );
}

function ownerSlot(email?: string | null): React.ReactNode {
  return email ? (
    <span title={`owner ${email}`}>
      <CustomerMark name={email} size="sm" />
    </span>
  ) : undefined;
}

/* --------------------------------- Task ----------------------------------- */

export type TaskCardData = {
  title: string;
  priority: string;
  done?: boolean;
  assignee?: string | null;
  cycleLabel?: string | null;
  containerType?: string | null;
  containerLabel?: string | null;
  due?: { text: string; overdue: boolean } | null;
};

export function TaskCard({
  task,
  selected,
  onClick,
  testid,
}: {
  readonly task: TaskCardData;
  readonly selected?: boolean;
  readonly onClick?: () => void;
  readonly testid?: string;
}) {
  const showPriority = task.priority !== "normal" && Boolean(task.priority);
  const hasFooter = Boolean(showPriority || task.cycleLabel || task.containerLabel || task.due || task.assignee);
  return (
    <WorkspaceCard title={task.title} titleTestid="task-title" strike={task.done} selected={selected} onClick={onClick} testid={testid}>
      {hasFooter ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {showPriority ? (
            <Badge
              tone={task.priority === "high" ? "danger" : "info"}
              icon={task.priority === "high" ? ChevronsUpIcon : ChevronsDownIcon}
              className="capitalize"
            >
              {task.priority}
            </Badge>
          ) : null}
          {task.containerLabel ? (
            <Badge icon={task.containerType === "deployment" ? RocketIcon : GitBranchIcon}>{task.containerLabel}</Badge>
          ) : null}
          {task.cycleLabel ? (
            <Badge tone="accent" icon={LayersIcon}>
              {task.cycleLabel}
            </Badge>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {task.due ? (
              <span className={cn("flex items-center gap-1 font-medium text-xs", task.due.overdue ? "text-red-400" : "text-muted-foreground")}>
                <ClockIcon className="size-3.5" />
                {task.due.text}
              </span>
            ) : null}
            {task.assignee ? ownerSlot(task.assignee) : null}
          </span>
        </div>
      ) : null}
    </WorkspaceCard>
  );
}

/* ------------------------------ Deployment -------------------------------- */

function healthColor(h: string): string {
  return h === "healthy" ? "bg-emerald-500" : h === "degraded" ? "bg-amber-500" : "bg-red-500";
}

export type DeployCardData = {
  customer: string;
  env: string;
  version: string;
  health: string;
  status: string;
  owner?: string | null;
  uptime?: number | null;
  errorRate?: number | null;
  /** What a person reads for `health` when the deployment profile relabels it; absent: the value, capitalised. */
  healthLabel?: string;
  /** The profile's kind of record (a report type…), when it has one. */
  kind?: string | null;
};

export function DeployCard({
  deploy,
  selected,
  onClick,
  testid,
}: {
  readonly deploy: DeployCardData;
  readonly selected?: boolean;
  readonly onClick?: () => void;
  readonly testid?: string;
}) {
  return (
    <WorkspaceCard title={deploy.customer} titleTestid="deploy-title" headerRight={ownerSlot(deploy.owner)} selected={selected} onClick={onClick} testid={testid}>
      <MetaLine
        items={[
          {
            node: (
              <span className={cn("inline-flex items-center gap-1.5", deploy.healthLabel ? null : "capitalize")}>
                <span className={cn("size-2 rounded-full", healthColor(deploy.health))} />
                {deploy.healthLabel ?? deploy.health}
              </span>
            ),
          },
          ...(deploy.kind ? [{ node: deploy.kind } as MetaItem] : []),
          ...(deploy.env ? [{ icon: ServerIcon, node: deploy.env } as MetaItem] : []),
          { node: <span className="font-mono">{deploy.version}</span> },
          ...(deploy.uptime != null
            ? [{ icon: GaugeIcon, node: <span className="tabular-nums text-foreground/80">{deploy.uptime.toFixed(1)}%</span> } as MetaItem]
            : []),
        ]}
      />
    </WorkspaceCard>
  );
}

/* ---------------------------- Implementation ------------------------------ */

export type ImplCardData = {
  /** The solution being implemented — the card title. */
  title: string;
  customer: string;
  risk: string;
  owner?: string | null;
  blocker?: boolean;
  /** Go-live due — e.g. { text: "due in 12 days", overdue: false }. */
  due?: { text: string; overdue: boolean } | null;
  /** Task burndown for this implementation (tasks filed under it). */
  burndown?: { startsAt: string | null; endsAt: string | null; committed: number; doneDates: string[] };
};

export function ImplCard({
  impl,
  selected,
  onClick,
  testid,
}: {
  readonly impl: ImplCardData;
  readonly selected?: boolean;
  readonly onClick?: () => void;
  readonly testid?: string;
}) {
  return (
    <WorkspaceCard title={impl.title} titleTestid="impl-title" headerRight={ownerSlot(impl.owner)} selected={selected} onClick={onClick} testid={testid}>
      <MetaLine
        items={[
          { icon: Building2Icon, node: <span data-testid="impl-customer">{impl.customer}</span> },
          ...(impl.due ? [{ icon: ClockIcon, node: impl.due.text, danger: impl.due.overdue } as MetaItem] : []),
        ]}
      />
      {impl.burndown && impl.burndown.committed > 0 ? (
        <div className="mt-1 border-border/50 border-t pt-2">
          <Burndown
            height={96}
            startsAt={impl.burndown.startsAt}
            endsAt={impl.burndown.endsAt}
            committed={impl.burndown.committed}
            doneDates={impl.burndown.doneDates}
          />
        </div>
      ) : null}
    </WorkspaceCard>
  );
}
