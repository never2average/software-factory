"use client";

/**
 * Apps — living documents. Each app is Markdown the agent REGENERATES on a
 * cadence (from a workflow or a prompt) and this panel renders read-only. The
 * detail view is document-first: the rendered doc fills the pane, with its
 * source / cadence / provenance in a column beside it.
 */

import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import type { Components } from "streamdown";
import {
  AlarmClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  Settings2Icon,
  TagIcon,
  TextIcon,
  WorkflowIcon,
} from "lucide-react";
import { describeCron } from "@/agent/lib/cron-match";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageResponse } from "@/components/ai-elements/message";
import { Spinner } from "@/components/ui/spinner";
import { CustomerMark } from "../customer-mark";
import { CronChip, RunStatusDot } from "./detail";
import {
  errMessage,
  fmtTime,
  opsFetch,
  useOpsList,
  type ApiApp,
  type ApiAppVersion,
} from "./lib";
import {
  Banners,
  CustomerSelect,
  EnabledToggle,
  Field,
  IconButton,
  ListFooter,
  OpsButton,
  OpsInput,
  OpsSelect,
  OpsTextarea,
  PanelLayout,
  RadioCards,
  RowMenu,
  SearchBox,
  SectionHeaderCard,
  SidePanel,
  TableCard,
  Td,
  Th,
  WorkflowSelect,
  type RadioOption,
} from "./primitives";
import { TYPE } from "./tokens";
import { Dashboard, parseDashboardSpec } from "./dashboard";
import { W } from "@/lib/ui-words";

type SourceKind = "workflow" | "prompt";

const SOURCE_OPTIONS: RadioOption<SourceKind>[] = [
  {
    value: "prompt",
    title: "Prompt",
    icon: TextIcon,
    description: "One agent call each refresh — its reply IS the document. Fastest to set up.",
  },
  {
    value: "workflow",
    title: "Workflow",
    icon: WorkflowIcon,
    description: "Run a workflow script and render what it returns. Structured and multi-step.",
  },
];

/**
 * Refresh frequency as a friendly dropdown instead of a raw cron. Each option
 * maps to a 5-field UTC expression; "custom" keeps whatever's on the row so an
 * operator who hand-set an expression isn't overwritten.
 */
const FREQUENCIES: { label: string; cron: string | null }[] = [
  { label: "Manual only", cron: null },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily · 07:00 UTC", cron: "0 7 * * *" },
  { label: "Weekdays · 07:00 UTC", cron: "0 7 * * 1-5" },
  { label: "Weekly · Mon 07:00 UTC", cron: "0 7 * * 1" },
];
const FREQ_CRONS = new Set(FREQUENCIES.map((f) => f.cron).filter(Boolean) as string[]);
/** The dropdown value for a stored cron: a known frequency, or "custom". */
function freqValue(cron: string | null): string {
  if (!cron) return "";
  return FREQ_CRONS.has(cron) ? cron : "custom";
}

/** "just now" / "3m ago" / "2h ago" / "5d ago" for an ISO timestamp. */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Hovering the Source cell reveals what actually generates the document — the
 * prompt in full, or the workflow it runs — so the table stays scannable while
 * the detail is one hover away.
 */
function SourceTooltip({ app, children }: { readonly app: ApiApp; readonly children: React.ReactNode }) {
  const body =
    app.sourceKind === "workflow"
      ? (app.workflow ?? "No workflow selected yet.")
      : (app.prompt ?? "No prompt set yet.");
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" align="start" variant="panel" sideOffset={6} className="w-80 p-0">
        <p className={cn("border-border/60 border-b px-2.5 py-1.5 font-medium", TYPE.meta)}>
          {app.sourceKind === "workflow" ? "Runs workflow" : "Prompt"}
        </p>
        <p className={cn("max-h-48 overflow-y-auto px-2.5 py-2 text-muted-foreground", TYPE.meta)}>
          {body}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function AppsPanel({
  authorEmail,
  initialSelectedId,
  onInitialConsumed,
}: {
  readonly authorEmail?: string;
  readonly initialSelectedId?: string | null;
  readonly onInitialConsumed?: () => void;
}) {
  const { items, error, refetch, loading } = useOpsList<ApiApp>("/api/ops/apps");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Honour a deep-link (/?ops=apps&id=…) once the list has arrived.
  if (initialSelectedId && items?.some((a) => a.id === initialSelectedId)) {
    onInitialConsumed?.();
  }

  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (a) =>
          !q ||
          [a.name, a.slug, a.description ?? "", a.workflow ?? "", a.prompt ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(q),
      ),
    [items, q],
  );
  const openItem = items?.find((a) => a.id === selectedId) ?? null;

  const run = async (id: string | null, fn: () => Promise<unknown>) => {
    setBusyId(id ?? "new");
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const patch = (id: string, body: Record<string, unknown>) =>
    run(id, () =>
      opsFetch(`/api/ops/apps/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      }),
    );

  const refreshNow = (id: string) =>
    run(id, () => opsFetch(`/api/ops/apps/${id}/refresh`, { method: "POST" }));

  const remove = (id: string) =>
    run(id, async () => {
      await opsFetch(`/api/ops/apps/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ actor: authorEmail }),
      });
      setSelectedId(null);
    });

  const closePanel = () => {
    setSelectedId(null);
    setCreating(false);
  };

  const panelBody = creating ? (
    <AppCreateForm
      authorEmail={authorEmail}
      busy={busyId === "new"}
      onCancel={closePanel}
      onCreate={async (body) => {
        await run(null, async () => {
          const created = await opsFetch<{ item: ApiApp }>("/api/ops/apps", {
            method: "POST",
            body: JSON.stringify({ ...body, createdBy: authorEmail ?? "web" }),
          });
          setCreating(false);
          setSelectedId(created.item.id);
        });
      }}
    />
  ) : openItem ? (
    <AppDetail
      app={openItem}
      busy={busyId === openItem.id}
      settingsOpen={settingsOpen}
      onPatch={(body) => patch(openItem.id, body)}
      onRefresh={() => refreshNow(openItem.id)}
    />
  ) : null;

  // With the side panel open the table is squeezed to ~30%, where four columns
  // clip. Same contract as the other panels: keep Name, drop the rest.
  const compact = panelBody !== null;
  const columnCount = compact ? 2 : 5;

  return (
    <PanelLayout
      panel={
        panelBody ? (
          <SidePanel
            onClose={closePanel}
            actions={
              openItem ? (
                <IconButton
                  aria-label="Prompt, cadence and history"
                  title="Prompt, cadence and history"
                  onClick={() => setSettingsOpen((v) => !v)}
                  className={cn(settingsOpen && "bg-muted text-foreground")}
                >
                  <Settings2Icon className="size-3.5" />
                </IconButton>
              ) : null
            }
          >
            {panelBody}
          </SidePanel>
        ) : null
      }
      header={
        <>
          <SectionHeaderCard
            section="apps"
            noun="App"
            onAdd={() => {
              setSelectedId(null);
              setCreating(true);
            }}
          />
          <SearchBox noun="app" value={search} onChange={setSearch} />
          <Banners loadError={error} actionError={actionError} noun="app" />
        </>
      }
      table={
          <TableCard
            footer={
              <ListFooter
                noun="app"
                total={filtered.length}
                page={1}
                pages={1}
                onPage={() => {}}
                pageSize={filtered.length || 1}
                onPageSize={() => {}}
              />
            }
          >
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <Th icon={TagIcon} label="Name" />
                  {compact ? null : (
                    <>
                      <Th icon={TextIcon} label="Description" />
                      <Th icon={AlarmClockIcon} label="Refresh" />
                      <Th label="Last refreshed" />
                    </>
                  )}
                  <Th label="Actions" align="right" />
                </tr>
              </thead>
              <tbody>
                {loading && !items ? (
                  <tr>
                    <Td colSpan={columnCount} className="py-10 text-center text-muted-foreground">
                      <span className="flex items-center justify-center gap-2">
                        <Spinner className="size-3" />
                        Loading apps…
                      </span>
                    </Td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <Td
                      colSpan={columnCount}
                      className="py-10 text-center text-muted-foreground/60 italic"
                    >
                      {q ? "No apps match." : "No apps yet — create one to get a living document."}
                    </Td>
                  </tr>
                ) : (
                  filtered.map((a) => (
                    <tr
                      key={a.id}
                      className={cn(
                        "border-border/60 border-t",
                        selectedId === a.id && "bg-muted/50",
                      )}
                    >
                      <Td>
                        <span className="flex min-w-0 items-center gap-2">
                          <CustomerMark name={a.name} size="sm" />
                          <SourceTooltip app={a}>
                            <span
                              className={cn(
                                "grid size-4 shrink-0 cursor-default place-items-center rounded font-semibold text-[10px]",
                                a.sourceKind === "workflow"
                                  ? "bg-indigo-500/15 text-indigo-300"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {a.sourceKind === "workflow" ? "W" : "P"}
                            </span>
                          </SourceTooltip>
                          <span className="min-w-0 truncate font-medium">{a.name}</span>
                          {a.enabled ? null : (
                            <span className={cn("shrink-0 text-muted-foreground/60", TYPE.micro)}>
                              paused
                            </span>
                          )}
                        </span>
                      </Td>
                      {compact ? null : (
                        <>
                          <Td className="text-muted-foreground">
                            <span className="block truncate">{a.description || "—"}</span>
                          </Td>
                          <Td className="truncate text-muted-foreground">
                            {a.refreshCron ? (
                              <CronChip cron={a.refreshCron} cadence={describeCron(a.refreshCron)} />
                            ) : (
                              "manual only"
                            )}
                          </Td>
                          <Td className="truncate text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              {a.lastError ? (
                                <RunStatusDot status="failed" />
                              ) : a.contentUpdatedAt ? (
                                <RunStatusDot status="success" />
                              ) : null}
                              {fmtTime(a.lastRefreshAt) ?? "never"}
                            </span>
                          </Td>
                        </>
                      )}
                      {/* The row itself is inert — Review opens the document. */}
                      <Td className="text-right">
                        <span className="flex items-center justify-end">
                          <RowMenu
                            enabled={a.enabled}
                            pending={busyId === a.id}
                            onReview={() => {
                              setCreating(false);
                              setSelectedId(a.id);
                            }}
                            onRefresh={() => refreshNow(a.id)}
                            onToggleEnabled={() => patch(a.id, { enabled: !a.enabled })}
                            onDelete={() => remove(a.id)}
                          />
                        </span>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableCard>
      }
    />
  );
}

/* ------------------------------ Document tables --------------------------- */

const TABLE_PAGE_SIZES = [10, 25, 50] as const;

/**
 * A `table` renderer override for the app document's Markdown. We render
 * streamdown's own table children UNCHANGED (so cell styling stays intact) and
 * page it by HIDING the off-page body rows with a scoped CSS rule — never
 * reconstructing the table, which is what broke rendering before. Row count is
 * read from the live DOM. Below the default page size there are no controls.
 */
function PaginatedTable({ children, className, ...rest }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const rawId = useId();
  const id = rawId.replace(/:/g, ""); // colon-free, safe in a CSS attr selector
  const [page, setPage] = useState(0);
  const [size, setSize] = useState<number>(TABLE_PAGE_SIZES[0]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setTotal(ref.current?.querySelectorAll("tbody > tr").length ?? 0);
    setPage(0);
  }, [children]);

  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages - 1);
  const start = current * size;
  // Hide the rows before this page and after it; nth-child is 1-indexed.
  const hideCss =
    total > size
      ? `[data-ptbl="${id}"] tbody > tr:nth-child(-n+${start}),` +
        `[data-ptbl="${id}"] tbody > tr:nth-child(n+${start + size + 1}){display:none}`
      : "";

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border" data-ptbl={id}>
      {hideCss ? <style dangerouslySetInnerHTML={{ __html: hideCss }} /> : null}
      <div className="overflow-x-auto">
        <table ref={ref} className={cn("w-full", className)} {...rest}>
          {children}
        </table>
      </div>
      {total > TABLE_PAGE_SIZES[0] ? (
        <div
          className={cn(
            "flex items-center justify-between gap-2 border-border border-t bg-muted/20 px-2.5 py-1.5",
            TYPE.micro,
          )}
        >
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(0);
            }}
            aria-label="Rows per page"
            className="h-6 rounded-md border border-border bg-background px-1.5 text-muted-foreground outline-none hover:text-foreground focus:border-ring"
          >
            {TABLE_PAGE_SIZES.map((n) => (
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
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
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
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <ChevronRightIcon className="size-3.5" />
              </button>
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// The app document's Markdown renders with paginated tables; the chart, prose
// and everything else keep streamdown's defaults.
const DOCUMENT_COMPONENTS = { table: PaginatedTable } as Components;

/* ------------------------------- App detail ------------------------------- */

function AppDetail({
  app,
  busy,
  settingsOpen,
  onPatch,
  onRefresh,
}: {
  readonly app: ApiApp;
  readonly busy: boolean;
  /** Owned by the panel, so the toggle can live in SidePanel's action cluster. */
  readonly settingsOpen: boolean;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly onRefresh: () => Promise<unknown> | void;
}) {
  // A past version being read instead of the current document.
  const [viewing, setViewing] = useState<ApiAppVersion | null>(null);
  const { items: versions, refetch: refetchVersions } = useOpsList<ApiAppVersion>(
    `/api/ops/apps/${app.id}/versions`,
  );
  const cadence = app.refreshCron ? (describeCron(app.refreshCron) ?? app.refreshCron) : null;

  const doRefresh = async () => {
    await onRefresh();
    setViewing(null);
    await refetchVersions();
  };

  const shownContent = viewing ? viewing.contentMd : app.contentMd;
  const shownError = viewing ? viewing.error : app.lastError;
  // A dashboard spec renders as widgets; anything else falls back to Markdown.
  const spec = useMemo(() => parseDashboardSpec(shownContent), [shownContent]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One line of identity, one of state. Everything else is on demand. */}
      {/* pr-20 clears the panel's absolute action cluster (settings + close). */}
      <header className="flex shrink-0 items-center gap-4 border-border border-b px-6 py-3.5 pr-20">
        <div className="min-w-0 flex-1">
          <h3 className={cn("truncate", TYPE.title)}>{app.name}</h3>
          <p className={cn("mt-1 flex items-center gap-1.5 text-muted-foreground", TYPE.micro)}>
            {app.lastError ? (
              <RunStatusDot status="failed" />
            ) : app.contentUpdatedAt ? (
              <RunStatusDot status="success" />
            ) : null}
            <span className="truncate">
              {app.contentUpdatedAt ? `Refreshed ${relTime(app.contentUpdatedAt)}` : "Never refreshed"}
              {cadence ? ` · ${cadence}` : " · manual only"}
              {app.enabled ? "" : " · paused"}
            </span>
          </p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* The document, at a comfortable measure. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-3xl text-sm">
            {viewing ? (
              <div
                className={cn(
                  "mb-6 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2",
                  TYPE.meta,
                )}
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  Viewing the version from {relTime(viewing.createdAt)}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setViewing(null)}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Back to latest
                  </button>
                </span>
              </div>
            ) : null}
            {shownError ? (
              <p
                className={cn(
                  "mb-6 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-400",
                  TYPE.meta,
                )}
              >
                Refresh failed: {shownError}
              </p>
            ) : null}
            {spec ? (
              <Dashboard
                spec={spec}
                onAction={(a) => {
                  // Human-in-the-loop: chat seeds a new thread the agent runs
                  // (approval happens there); open navigates; refresh regenerates.
                  if (a.kind === "chat") {
                    window.open(`/?seed=${encodeURIComponent(a.prompt)}`, "_blank", "noopener");
                  } else if (a.kind === "open") {
                    window.open(a.href, "_blank", "noopener");
                  } else if (a.kind === "refresh") {
                    void onRefresh();
                  }
                }}
              />
            ) : shownContent ? (
              <MessageResponse components={DOCUMENT_COMPONENTS}>{shownContent}</MessageResponse>
            ) : shownError ? null : (
              <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>
                No document yet — refresh to generate it.
              </p>
            )}
          </div>
        </div>

        {/* Opened from the gear only: what to generate, how often, whether it
            runs — and every version it has produced. */}
        {settingsOpen ? (
          <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-border border-l bg-muted/10">
            <div className="flex shrink-0 flex-col gap-4 border-border/60 border-b p-4">
              <Field label={app.sourceKind === "workflow" ? "Workflow" : "Prompt"}>
                {app.sourceKind === "workflow" ? (
                  <WorkflowSelect
                    value={app.workflow}
                    disabled={busy}
                    onChange={(next) => onPatch({ workflow: next })}
                  />
                ) : (
                  <OpsTextarea
                    rows={6}
                    defaultValue={app.prompt ?? ""}
                    placeholder="Summarize every at-risk account with open P0s as a table."
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== app.prompt) onPatch({ prompt: v });
                    }}
                  />
                )}
              </Field>

              <Field label="Refresh">
                <OpsSelect
                  value={freqValue(app.refreshCron)}
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value === "custom") return; // keep the hand-set cron
                    onPatch({ refreshCron: e.target.value || null });
                  }}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f.label} value={f.cron ?? ""}>
                      {f.label}
                    </option>
                  ))}
                  {/* Only shown when the row carries a non-preset expression. */}
                  {freqValue(app.refreshCron) === "custom" ? (
                    <option value="custom">Custom · {app.refreshCron}</option>
                  ) : null}
                </OpsSelect>
              </Field>

              <div className="flex items-center gap-2">
                <EnabledToggle
                  checked={app.enabled}
                  onToggle={() => onPatch({ enabled: !app.enabled })}
                />
                <span className={cn("text-muted-foreground", TYPE.meta)}>
                  {app.enabled ? "Refresh on" : "Refresh off"}
                </span>
              </div>
            </div>

            <VersionList
              versions={versions}
              busy={busy}
              selectedId={viewing?.id ?? null}
              onSelect={(v) => setViewing(v)}
              onLatest={() => setViewing(null)}
              onRefresh={doRefresh}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every refresh this app has produced — searchable and scrollable, newest
 * first. Selecting one reads that version; its run/session opens as a chat.
 */
function VersionList({
  versions,
  busy,
  selectedId,
  onSelect,
  onLatest,
  onRefresh,
}: {
  readonly versions: ApiAppVersion[] | null;
  readonly busy: boolean;
  readonly selectedId: string | null;
  readonly onSelect: (v: ApiAppVersion) => void;
  readonly onLatest: () => void;
  readonly onRefresh: () => void | Promise<void>;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = versions ?? [];
  const filtered = query
    ? list.filter((v) =>
        [v.createdBy, v.error ?? "", v.contentMd ?? "", fmtTime(v.createdAt) ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : list;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-4 pt-3 pb-2">
        <OpsInput
          className="min-w-0 flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search versions…"
        />
        <IconButton
          aria-label="Refresh now"
          title="Refresh now — adds a new version"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          {busy ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {list.length === 0 ? (
          <p className={cn("py-6 text-center text-muted-foreground/60 italic", TYPE.micro)}>
            No versions yet.
          </p>
        ) : filtered.length === 0 ? (
          <p className={cn("py-6 text-center text-muted-foreground/60 italic", TYPE.micro)}>
            No versions match.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((v, i) => {
              const isLatest = i === 0 && !query;
              // Who triggered this refresh — the cron, or the person's email.
              const by = v.createdBy === "cron" ? "cron" : v.createdBy;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => (isLatest ? onLatest() : onSelect(v))}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                      selectedId === v.id
                        ? "border-foreground/40 bg-muted/50"
                        : "border-transparent hover:border-border hover:bg-muted/30",
                    )}
                  >
                    <CustomerMark name={by} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("min-w-0 truncate font-medium", TYPE.meta)}>
                          Triggered by {by}
                        </span>
                        {isLatest ? (
                          <span className={cn("shrink-0 text-muted-foreground/60", TYPE.micro)}>
                            latest
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "truncate",
                          v.error ? "text-red-400/80" : "text-muted-foreground",
                          TYPE.micro,
                        )}
                      >
                        {relTime(v.createdAt)}
                        {v.error ? " · failed" : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- Create form ------------------------------ */

function AppCreateForm({
  authorEmail,
  busy,
  onCancel,
  onCreate,
}: {
  readonly authorEmail?: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("prompt");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [refreshCron, setRefreshCron] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);

  const valid =
    name.trim().length > 0 &&
    (sourceKind === "workflow" ? Boolean(workflow) : prompt.trim().length > 0);

  return (
    // Fields scroll; the actions stay pinned to the bottom of the card.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <div className="flex items-center gap-2">
        <LayoutDashboardIcon className="size-4 text-muted-foreground" />
        <h3 className={TYPE.title}>New app</h3>
      </div>
      <Field label="Name">
        <OpsInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Portfolio health digest" />
      </Field>
      <Field label="Description">
        <OpsTextarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Daily snapshot of at-risk accounts"
        />
      </Field>

      <Field label="Refresh">
        <OpsSelect value={refreshCron} onChange={(e) => setRefreshCron(e.target.value)}>
          {FREQUENCIES.map((f) => (
            <option key={f.label} value={f.cron ?? ""}>
              {f.label}
            </option>
          ))}
        </OpsSelect>
      </Field>
      <Field label={W.Account}>
        <CustomerSelect value={customerId} onChange={setCustomerId} />
      </Field>

      <RadioCards
        label="Generated by"
        value={sourceKind}
        onChange={setSourceKind}
        options={SOURCE_OPTIONS}
        orientation="horizontal"
      />

      {sourceKind === "workflow" ? (
        <Field label="Workflow">
          <WorkflowSelect value={workflow} onChange={setWorkflow} />
        </Field>
      ) : (
        <Field label="Prompt">
          <OpsTextarea
            className="min-h-24"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Summarize every at-risk account with open P0 tickets as a Markdown table, newest first."
          />
        </Field>
      )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-border border-t px-5 py-4">
        <OpsButton
          intent="primary"
          size="sm"
          disabled={!valid || busy}
          onClick={() =>
            void onCreate({
              name: name.trim(),
              description: description.trim() || null,
              sourceKind,
              workflow: sourceKind === "workflow" ? workflow : null,
              prompt: sourceKind === "prompt" ? prompt.trim() : null,
              refreshCron: refreshCron.trim() || null,
              customerId,
              createdBy: authorEmail,
            })
          }
        >
          {busy ? <Spinner className="size-3" /> : null}
          Create app
        </OpsButton>
        <OpsButton intent="secondary" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </OpsButton>
      </div>
    </div>
  );
}
