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
  awaitsFirstDocument,
  errMessage,
  refreshUnderWay,
  fmtTime,
  opsFetch,
  useOpsList,
  type ApiApp,
  type ApiAppVersion,
  type ApiWorkflow,
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
import { STORAGE_KEYS, readActiveOrg, readStored } from "@/lib/browser-storage";

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
    description: "Run a workflow script, or hand the work to one of this workspace's specialists, and render what comes back.",
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

/** "started just now" / "started 4 min ago" / "started 1 h 5 min ago", for a refresh in progress. */
function startedAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "started a moment ago";
  const m = Math.floor(Math.max(0, Date.now() - t) / 60_000);
  if (m < 1) return "started just now";
  if (m < 60) return `started ${m} min ago`;
  return `started ${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/**
 * A refresh THIS person started has finished while the tab is hidden or unfocused: a desktop notification, if they
 * turned desktop notifications on (the same stored choice and service worker as the chat's, app/_components/
 * desktop-notify.ts; not imported, to keep it out of this panel's chunk). Page-side only: nothing is pushed from the
 * server, so a closed tab shows nothing and the app says how it went the next time it is opened.
 */
async function notifyRefreshFinished(input: { appId: string; appName: string; ok: boolean }): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  let prefs: { on?: boolean; preview?: boolean } | null = null;
  try {
    prefs = JSON.parse(readStored(STORAGE_KEYS.desktopNotifications) ?? "null");
  } catch {
    prefs = null;
  }
  if (prefs?.on !== true) return;
  const org = readActiveOrg();
  const payload = {
    v: 1,
    kind: input.ok ? "reply" : "failed",
    title: prefs.preview === false ? "An app finished refreshing" : input.appName,
    body: input.ok ? "Refreshed: the new document is ready." : "The refresh failed. Open the app to see why.",
    tag: `app-refresh:${input.appId}`,
    url: `/?ops=apps&id=${encodeURIComponent(input.appId)}${org ? `&org=${encodeURIComponent(org)}` : ""}`,
    sessionId: "",
  };
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
    if (reg?.active) reg.active.postMessage({ type: "show", payload });
    else new Notification(payload.title, { body: payload.body, tag: payload.tag });
  } catch {
    /* a notification is a courtesy; failing to show one changes nothing */
  }
}

/** While any app is refreshing, the list is read again this often, so the result shows without a reload. */
const REFRESHING_POLL_MS = 5_000;

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

  /**
   * A refresh runs in the background and can take many minutes (lib/app-refresh.ts): while any app is refreshing,
   * read the list again every few seconds, so "Refreshing…" turns into the document or the error by itself.
   */
  const refreshingIds = (items ?? [])
    .filter((a) => a.refreshingAt)
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (!refreshingIds) return;
    const timer = setInterval(() => void refetch().catch(() => {}), REFRESHING_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshingIds, refetch]);

  // The refreshes THIS person started from this page: when one ends while they are elsewhere, a desktop notification.
  const startedHere = useRef(new Set<string>());
  const wasRefreshing = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const a of items ?? []) {
      const now = Boolean(a.refreshingAt);
      if (wasRefreshing.current.get(a.id) && !now && startedHere.current.has(a.id)) {
        startedHere.current.delete(a.id);
        void notifyRefreshFinished({ appId: a.id, appName: a.name, ok: !a.lastError });
      }
      wasRefreshing.current.set(a.id, now);
    }
  }, [items]);

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

  // A create the API refused: said IN the form, where the person is looking, not in the list's banner.
  const [createError, setCreateError] = useState<string | null>(null);

  const run = async (id: string | null, fn: () => Promise<unknown>) => {
    setBusyId(id ?? "new");
    setActionError(null);
    setCreateError(null);
    try {
      await fn();
    } catch (e) {
      if (id === null) setCreateError(errMessage(e));
      else setActionError(errMessage(e));
    } finally {
      // Refetch after a failure too: a refresh that failed has written its error on the app, and the row and the
      // open document must show it (they kept showing the state from before the attempt).
      await refetch().catch(() => {});
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

  // Answers at once (202): the refresh carries on in the background, and the list follows it (above).
  const refreshNow = (id: string) =>
    run(id, async () => {
      startedHere.current.add(id);
      await opsFetch(`/api/ops/apps/${id}/refresh`, { method: "POST" });
    });

  // Opening a starter app that has never been written asks for its first document. The server starts at most one
  // generation however many people or tabs ask (lib/starter-apps.ts); a person's own Refresh always runs.
  const firstOpen = (id: string) =>
    run(id, () => opsFetch(`/api/ops/apps/${id}/refresh?first=1`, { method: "POST" }));

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
    setCreateError(null);
  };

  const panelBody = creating ? (
    <AppCreateForm
      authorEmail={authorEmail}
      busy={busyId === "new"}
      error={createError}
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
      onOpenSettings={() => setSettingsOpen(true)}
      onPatch={(body) => patch(openItem.id, body)}
      onRefresh={() => refreshNow(openItem.id)}
      onFirstOpen={() => firstOpen(openItem.id)}
      onPoll={() => void refetch().catch(() => {})}
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
              setCreateError(null);
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
                                  ? "bg-indigo-500/15 text-indigo-800 dark:text-indigo-300"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {a.sourceKind === "workflow" ? "W" : "P"}
                            </span>
                          </SourceTooltip>
                          <span className="min-w-0 truncate font-medium">{a.name}</span>
                          {/* A starter app: it came with the workspace, nobody here made it. */}
                          {a.starterKey ? (
                            <span
                              data-app-starter
                              title="This app came with the workspace. Edit it or delete it like any other; a deleted one does not come back."
                              className={cn("shrink-0 rounded border border-border px-1 text-muted-foreground", TYPE.micro)}
                            >
                              starter
                            </span>
                          ) : null}
                          {/* Refreshing, failed, or cannot refresh as it is set: said on the row itself, at any width. */}
                          {a.refreshingAt ? (
                            <span
                              data-app-refreshing
                              title={`Refreshing, ${startedAgo(a.refreshingAt)}`}
                              className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", TYPE.micro)}
                            >
                              <Spinner className="size-2.5" />
                              refreshing
                            </span>
                          ) : a.lastError || a.source?.ok === false ? (
                            <span
                              data-app-problem
                              title={a.source?.ok === false ? `${a.source.reason} ${a.source.fix}` : `The last refresh failed: ${a.lastError}`}
                              className={cn("shrink-0 text-red-400", TYPE.micro)}
                            >
                              {a.source?.ok === false ? "cannot refresh" : "failed"}
                            </span>
                          ) : null}
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
                              {a.refreshingAt ? (
                                <RunStatusDot status="running" />
                              ) : a.lastError ? (
                                <RunStatusDot status="failed" />
                              ) : a.contentUpdatedAt ? (
                                <RunStatusDot status="success" />
                              ) : null}
                              {fmtTime(a.lastRefreshAt) ?? (awaitsFirstDocument(a) ? (refreshUnderWay(a) ? "being written" : "written when first opened") : "never")}
                            </span>
                          </Td>
                        </>
                      )}
                      {/* The row itself is inert — Review opens the document. */}
                      <Td className="text-right">
                        <span className="flex items-center justify-end">
                          <RowMenu
                            enabled={a.enabled}
                            pending={busyId === a.id || Boolean(a.refreshingAt)}
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
  onOpenSettings,
  onPatch,
  onRefresh,
  onFirstOpen,
  onPoll,
}: {
  readonly app: ApiApp;
  readonly busy: boolean;
  /** Owned by the panel, so the toggle can live in SidePanel's action cluster. */
  readonly settingsOpen: boolean;
  readonly onOpenSettings: () => void;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly onRefresh: () => Promise<unknown> | void;
  /** Ask for the first document of a starter app that has never been written. */
  readonly onFirstOpen: () => Promise<unknown> | void;
  /** Read the list again (while a first document is being written by another tab or person). */
  readonly onPoll: () => void;
}) {
  // A STARTER APP OPENED FOR THE FIRST TIME. It was created with the workspace and has no document: nothing ran then.
  // Opening it is what writes it, once. Asked once per app per mount (a second ask is harmless: the server starts at
  // most one generation), and never for an app that cannot refresh as it is set, or that is paused.
  const awaiting = awaitsFirstDocument(app);
  const canGenerate = app.source?.ok !== false && app.enabled;
  // Under way already (another tab, another person, the request that created the workspace)? The server ends an
  // attempt that died (lib/app-refresh.ts), and then it shows as failed with a Try again.
  const underWay = refreshUnderWay(app);
  const askedFirst = useRef<string | null>(null);
  useEffect(() => {
    if (!awaiting || !canGenerate || underWay || askedFirst.current === app.id) return;
    askedFirst.current = app.id;
    void onFirstOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, awaiting, canGenerate, underWay]);
  // Somebody else is writing it: look again until it is there.
  const writingElsewhere = awaiting && underWay && !busy;
  useEffect(() => {
    if (!writingElsewhere) return;
    const t = setInterval(onPoll, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writingElsewhere]);

  // A past version being read instead of the current document.
  const [viewing, setViewing] = useState<ApiAppVersion | null>(null);
  const { items: versions, refetch: refetchVersions } = useOpsList<ApiAppVersion>(
    `/api/ops/apps/${app.id}/versions`,
  );
  const cadence = app.refreshCron ? (describeCron(app.refreshCron) ?? app.refreshCron) : null;
  const refreshing = Boolean(app.refreshingAt);
  // A Try again while a refresh is in progress would only join it: the buttons say it is running instead.
  const blocked = busy || refreshing;

  const doRefresh = async () => {
    await onRefresh();
    setViewing(null);
    await refetchVersions();
  };

  // When a refresh ends (here or anywhere), its version joins the history.
  useEffect(() => {
    if (!refreshing) void refetchVersions();
  }, [refreshing, refetchVersions]);

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
            {refreshing ? (
              <RunStatusDot status="running" />
            ) : app.lastError ? (
              <RunStatusDot status="failed" />
            ) : app.contentUpdatedAt ? (
              <RunStatusDot status="success" />
            ) : null}
            <span className="truncate">
              {app.refreshingAt
                ? `Refreshing… ${startedAgo(app.refreshingAt)}`
                : app.contentUpdatedAt
                  ? `Refreshed ${relTime(app.contentUpdatedAt)}`
                  : awaiting
                    ? "Starter app · not written yet"
                    : "Never refreshed"}
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
            {/* What generates this app cannot run as it is set (lib/app-source.ts): say so before anyone refreshes,
                with what to do. An app saved before the form checked this, or whose workflow changed under it. */}
            {/* A starter app's first document says so in its own words below. */}
            {!viewing && app.refreshingAt && !awaiting ? (
              <div
                data-app-refreshing
                className={cn("mb-6 flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-muted-foreground", TYPE.meta)}
              >
                <Spinner className="mt-0.5 size-3 shrink-0" />
                <p>
                  <span className="font-medium text-foreground">Refreshing… {startedAgo(app.refreshingAt)}.</span>{" "}
                  {app.contentMd
                    ? "The document below is the last one; it is replaced when this finishes."
                    : "The document appears here when it finishes."}{" "}
                  This can take several minutes. You can close this page; it carries on.
                </p>
              </div>
            ) : !viewing && app.source?.ok === false ? (
              <div
                data-app-source-problem
                className={cn("mb-6 flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-800 dark:text-red-400", TYPE.meta)}
              >
                <p>
                  <span className="font-medium">This app cannot refresh as it is set.</span> {app.source.reason}
                </p>
                <p className="text-foreground/80">{app.source.fix}</p>
                <div>
                  <OpsButton intent="secondary" size="sm" onClick={onOpenSettings}>
                    Change what generates it
                  </OpsButton>
                </div>
              </div>
            ) : shownError ? (
              <div
                data-app-refresh-error
                className={cn("mb-6 flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-800 dark:text-red-400", TYPE.meta)}
              >
                <p>
                  <span className="font-medium">{viewing ? "This refresh failed." : "The last refresh failed."}</span> {shownError}
                </p>
                {viewing ? null : (
                  <>
                    <p className="text-foreground/80">
                      {app.contentMd
                        ? "The document below is the last one that worked. Try again; if it fails the same way, change what generates this app."
                        : "Nothing has been generated yet. Try again; if it fails the same way, change what generates this app."}
                    </p>
                    <div className="flex items-center gap-2">
                      <OpsButton intent="primary" size="sm" disabled={blocked} onClick={() => void doRefresh()}>
                        {blocked ? <Spinner className="size-3" /> : null}
                        Try again
                      </OpsButton>
                      <OpsButton intent="secondary" size="sm" disabled={blocked} onClick={onOpenSettings}>
                        Change what generates it
                      </OpsButton>
                    </div>
                  </>
                )}
              </div>
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
            ) : shownError ? null : awaiting && app.source?.ok !== false ? (
              // A starter app before its first document: say what it is, and what is happening now.
              <div data-app-first-document className={cn("flex flex-col items-center gap-3 py-16 text-center text-muted-foreground", TYPE.meta)}>
                <p className="max-w-md">
                  <span className="font-medium text-foreground">This app came with the workspace and has not been written yet.</span>{" "}
                  {app.description}
                </p>
                {busy || underWay ? (
                  <p className="flex items-center gap-2" data-app-first-document-writing>
                    <Spinner className="size-3" />
                    Its first document is being written now. This can take a few minutes; you can leave this tab and it will be here when you come back.
                  </p>
                ) : app.enabled ? (
                  <p>
                    {cadence ? `It is written on its schedule (${cadence}), or now: ` : "It is written when somebody asks for it: "}
                    <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => void doRefresh()}>
                      write it now
                    </button>
                    .
                  </p>
                ) : (
                  <p>It is paused. Resume it to have it written.</p>
                )}
              </div>
            ) : refreshing && !viewing ? null : (
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
                    forApp
                    noneLabel="Pick a workflow or a specialist"
                    value={app.workflow}
                    disabled={busy}
                    onChange={(next) => {
                      if (next && next !== app.workflow) onPatch({ workflow: next });
                    }}
                  />
                ) : (
                  <OpsTextarea
                    rows={6}
                    defaultValue={app.prompt ?? ""}
                    placeholder={`Summarize every at-risk ${W.account} with open P0s as a table.`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== app.prompt) onPatch({ prompt: v });
                    }}
                  />
                )}
              </Field>

              {/* A specialist's row has no script: the brief below is what the specialist is asked for. */}
              {app.sourceKind === "workflow" && app.source?.ok && app.source.kind === "specialist" ? (
                <Field label="What should it produce?">
                  <OpsTextarea
                    rows={5}
                    defaultValue={app.prompt ?? ""}
                    placeholder="Left empty, the specialist is given this app's name and description."
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (app.prompt ?? "")) onPatch({ prompt: v || null });
                    }}
                  />
                </Field>
              ) : null}

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
              busy={blocked}
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
  error,
  onCancel,
  onCreate,
}: {
  readonly authorEmail?: string;
  readonly busy: boolean;
  /** Why the API refused the last create, when it did. */
  readonly error: string | null;
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

  // What the picked workflow IS, as the API decided it (lib/app-source.ts): a script, one of this workspace's
  // specialists, or something that cannot generate a document. The picker will not let the last be picked; this
  // also covers a list that changed while the form was open.
  const { items: workflowRows } = useOpsList<ApiWorkflow>("/api/ops/workflows");
  const picked = sourceKind === "workflow" && workflow ? (workflowRows ?? []).find((w) => w.name === workflow) : undefined;
  const pickedSource = picked?.appSource;
  const [brief, setBrief] = useState("");

  const valid =
    name.trim().length > 0 &&
    (sourceKind === "workflow" ? Boolean(workflow) && pickedSource?.ok !== false : prompt.trim().length > 0);

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
          placeholder={`Daily snapshot of at-risk ${W.accounts}`}
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
        <>
          <Field label="Workflow or specialist">
            <WorkflowSelect forApp noneLabel="Pick a workflow or a specialist" value={workflow} onChange={setWorkflow} />
          </Field>
          {pickedSource?.ok === false ? (
            <p data-app-source-refused className={cn("rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-800 dark:text-red-400", TYPE.meta)}>
              {pickedSource.reason} {pickedSource.fix}
            </p>
          ) : pickedSource?.kind === "specialist" ? (
            <Field label="What should it produce?">
              <OpsTextarea
                className="min-h-24"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What this specialist should write each refresh. Left empty, it is given the name and description above."
              />
            </Field>
          ) : null}
        </>
      ) : (
        <Field label="Prompt">
          <OpsTextarea
            className="min-h-24"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Summarize every at-risk ${W.account} with open P0 tickets as a Markdown table, newest first.`}
          />
        </Field>
      )}
      </div>

      {error ? (
        <p data-app-create-error className={cn("mx-5 mb-3 shrink-0 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-800 dark:text-red-400", TYPE.meta)}>
          The app was not created. {error}
        </p>
      ) : null}
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
              // A specialist's brief travels in `prompt` too: it is what that specialist is asked for.
              prompt: sourceKind === "prompt" ? prompt.trim() : pickedSource?.kind === "specialist" ? brief.trim() || null : null,
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
