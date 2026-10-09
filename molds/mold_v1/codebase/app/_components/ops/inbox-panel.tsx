"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  InboxIcon,
  MailIcon,
  MailOpenIcon,
  RefreshCwIcon,
  ArchiveIcon,
  MessageSquareIcon,
  MicIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import { errMessage, opsFetch } from "./lib";
import { PaginatedTable, type Column } from "./paginated-table";
import { W } from "@/lib/ui-words";

/**
 * The Inbox: off-platform conversations, staged, grouped by thread, promoted
 * into the data room one at a time.
 *
 * The grouping is done SERVER-side. It decides what counts as one conversation,
 * and promotion writes one interaction per thread — doing it here as well would
 * let the two definitions drift, and the drift would be invisible until an
 * account report showed nine interactions for one email exchange.
 *
 * Built on PaginatedTable, the same table + detail-panel every other Ops
 * section uses. The first version was a bespoke list of expanding cards: it
 * worked, but it meant no search, no pager, no row count, and a layout nobody
 * else in the console shares — a second thing to learn for no reason.
 */

interface InboxMessage {
  id: string;
  from: string | null;
  preview: string | null;
  body: string | null;
  occurredAt: string;
}

interface InboxThread {
  threadKey: string;
  source: string;
  subject: string;
  preview: string | null;
  participants: string[];
  customerId: string | null;
  messageCount: number;
  unread: boolean;
  firstAt: string;
  lastAt: string;
  messages: InboxMessage[];
}

const SOURCE_ICON: Record<string, typeof MailIcon> = {
  email: MailIcon,
  granola: MicIcon,
  slack: MessageSquareIcon,
};

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function InboxPanel({ authorEmail }: { authorEmail?: string }) {
  const [threads, setThreads] = useState<InboxThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | "email" | "granola" | "slack">("all");
  /**
   * Inbox or Archive. Archiving used to be one-way: the row left the screen and
   * there was no view that listed it and no control that undid it, so a thread
   * filed by mistake — or filed and later needed — was gone as far as the
   * product was concerned. The API always supported both; only this was missing.
   */
  const [view, setView] = useState<"inbox" | "archived">("inbox");
  /** Relative rather than a date picker: an inbox is triaged in "since when"
   *  terms, and two calendar inputs to answer "this week" is the wrong trade. */
  const [rangeFilter, setRangeFilter] = useState<"all" | "1" | "7" | "30">("all");
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const r = await opsFetch<{
        scanned: number; inserted: number; updated: number; skipped: number; errors: string[];
      }>("/api/ops/inbox/sync", { method: "POST", body: JSON.stringify({ sinceDays: 7 }) });
      // Report what happened, including nothing. "Synced" over a no-op is how a
      // broken connector goes unnoticed for a week.
      const parts = [`${r.inserted} new`];
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.skipped) parts.push(`${r.skipped} skipped`);
      setSyncNote(
        r.errors.length
          ? `${parts.join(" · ")} — ${r.errors[0]}`
          : r.scanned === 0
            ? "Nothing new in the last 7 days."
            : parts.join(" · "),
      );
      await load();
    } catch (e) {
      setSyncNote(errMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  const load = useCallback(async () => {
    try {
      // Server-side, unlike the source/date filters below: archived threads are
      // a different SET, not a subset of what is on screen, so no amount of
      // client filtering can reach them.
      const r = await opsFetch<{ threads: InboxThread[] }>(
        `/api/ops/inbox?status=${view === "archived" ? "dismissed" : "new"}`,
      );
      setThreads(r.threads);
      setStale(false);
      setError(null);
    } catch (e) {
      // Keep what is on screen and say it is stale. An unreachable inbox must
      // not render as an empty one — the same failure that emptied the chat
      // sidebar, and here it would read as "nothing to triage".
      setStale(true);
      if (threads === null) setError(errMessage(e));
    }
  }, [threads, view]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /** Put an archived thread back in the inbox. The exact inverse of archive(). */
  async function restore(threadKey: string) {
    setBusy(threadKey);
    try {
      await opsFetch("/api/ops/inbox", {
        method: "PATCH",
        body: JSON.stringify({ threadKey, status: "new" }),
      });
      setThreads((t) => (t ?? []).filter((x) => x.threadKey !== threadKey));
      setOpen((k) => (k === threadKey ? null : k));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Archive: filed away, not deleted — a re-sync must not resurrect it. */
  async function archive(threadKey: string) {
    setBusy(threadKey);
    try {
      await opsFetch("/api/ops/inbox", {
        method: "PATCH",
        body: JSON.stringify({ threadKey, status: "dismissed" }),
      });
      setThreads((t) => (t ?? []).filter((x) => x.threadKey !== threadKey));
      setOpen((k) => (k === threadKey ? null : k));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Optimistic: the row restyles immediately and reverts if the write fails.
   *  Waiting on a round-trip to un-bold a row makes the list feel broken. */
  async function setRead(threadKey: string, read: boolean) {
    setThreads((t) => (t ?? []).map((x) => (x.threadKey === threadKey ? { ...x, unread: !read } : x)));
    try {
      await opsFetch("/api/ops/inbox", {
        method: "PATCH",
        body: JSON.stringify({ threadKey, read }),
      });
    } catch (e) {
      setThreads((t) => (t ?? []).map((x) => (x.threadKey === threadKey ? { ...x, unread: read } : x)));
      setError(errMessage(e));
    }
  }

  if (threads === null && error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (threads === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  // Filtering happens here, not server-side: the list is already bounded and
  // grouped, so this is instant and the count beside the search box updates
  // with it — a filter that needs a round-trip feels broken at this size.
  const visible = threads.filter((t) => {
    if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
    if (rangeFilter !== "all") {
      const days = (Date.now() - new Date(t.lastAt).getTime()) / 86_400_000;
      if (days > Number(rangeFilter)) return false;
    }
    return true;
  });

  const filtersActive = sourceFilter !== "all" || rangeFilter !== "all";

  const columns: Column<InboxThread>[] = [
    {
      key: "subject",
      header: "Conversation",
      text: (t) => `${t.subject} ${t.participants.join(" ")}`,
      cell: (t) => {
        const Icon = SOURCE_ICON[t.source] ?? MailIcon;
        return (
          <div className="flex min-w-0 items-start gap-2.5">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className={t.unread ? "truncate font-semibold" : "truncate font-normal text-muted-foreground"}>
                  {t.subject}
                </span>
                {t.messageCount > 1 && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{t.messageCount} msgs</span>
                )}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                {t.participants.slice(0, 2).join(", ")}
                {t.participants.length > 2 ? ` +${t.participants.length - 2}` : ""}
                {t.preview ? ` — ${t.preview}` : ""}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "customer",
      header: W.Account,
      text: (t) => t.customerId ?? "unmatched",
      // Unmatched is surfaced, not guessed — promotion needs a real customer,
      // and this is the column an operator scans to find the ones needing a
      // decision.
      cell: (t) =>
        t.customerId ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs">{t.customerId}</span>
        ) : (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs text-amber-800 dark:text-amber-400">
            unmatched
          </span>
        ),
    },
    {
      key: "source",
      header: "Source",
      text: (t) => t.source,
      cell: (t) => <span className="capitalize text-muted-foreground">{t.source}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (t) => (
        // stopPropagation: these sit inside the row button, and without it every
        // click would also open the detail panel.
        <span className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => void setRead(t.threadKey, t.unread)}
            title={t.unread ? "Mark read" : "Mark unread"}
            aria-label={t.unread ? "Mark read" : "Mark unread"}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t.unread ? <MailOpenIcon className="size-3.5" /> : <MailIcon className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void (view === "archived" ? restore(t.threadKey) : archive(t.threadKey))}
            disabled={busy === t.threadKey}
            title={view === "archived" ? "Move back to inbox" : "Archive"}
            aria-label={view === "archived" ? "Move back to inbox" : "Archive"}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <ArchiveIcon className="size-3.5" />
          </button>
        </span>
      ),
    },
    {
      key: "last",
      header: "Last activity",
      align: "right",
      text: (t) => t.lastAt,
      cell: (t) => <span className="text-muted-foreground">{when(t.lastAt)}</span>,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {syncNote && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {syncNote}
        </div>
      )}
      {stale && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-400">
          Couldn&apos;t refresh — showing the last known state.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <PaginatedTable
        rows={visible}
        totalBeforeFilters={threads.length}
        columns={columns}
        getKey={(t) => t.threadKey}
        noun="conversation"
        icon={InboxIcon}
        title="Inbox"
        blurb="Off-platform conversations — grouped into threads, staged until you move them to the data room."
        action={
          <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
            <RefreshCwIcon className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        }
        emptyLabel={
          // "Nothing waiting" is FALSE when a filter is hiding rows — it reads
          // as an empty inbox when the inbox is not empty. Say which it is.
          filtersActive
            ? "No conversations match these filters."
            : view === "archived"
              ? "Nothing archived yet. Threads you file away from the inbox appear here, and can be moved back."
              : "Nothing waiting. Email, Granola and Slack conversations land here before they reach the data room."
        }
        flush
        filters={
          <div className="flex shrink-0 items-center gap-2">
            {/* A view switch, not a filter: it changes which set is fetched.
                Sits first so the label reads before the filters that narrow it. */}
            <select
              value={view}
              onChange={(e) => setView(e.target.value as typeof view)}
              aria-label="Inbox or archive"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-xs font-medium"
            >
              <option value="inbox">Inbox</option>
              <option value="archived">Archived</option>
            </select>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
              aria-label="Filter by source"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="all">All sources</option>
              <option value="email">Email</option>
              <option value="granola">Granola</option>
              <option value="slack">Slack</option>
            </select>
            <select
              value={rangeFilter}
              onChange={(e) => setRangeFilter(e.target.value as typeof rangeFilter)}
              aria-label="Filter by date"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="all">Any time</option>
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </div>
        }
        onRowClick={(t) => {
          setOpen(t.threadKey);
          if (t.unread) void setRead(t.threadKey, true);
        }}
        selectedKey={open}
        onCloseDetail={() => setOpen(null)}
        renderDetail={(t, close) => (
          <PromoteForm
            thread={t}
            authorEmail={authorEmail}
            busy={busy === t.threadKey}
            onPromoted={() => {
              setThreads((prev) => (prev ?? []).filter((x) => x.threadKey !== t.threadKey));
              close();
            }}
            onError={setError}
            setBusy={setBusy}
          />
        )}
      />
    </div>
  );
}

/**
 * Initial-in-a-circle, colour derived from the address so the same person is
 * the same colour every time. Purely to make a long thread scannable.
 */
function Avatar({ who }: { who: string }) {
  const hue = [...who].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden="true"
      className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
      style={{ backgroundColor: `oklch(0.55 0.13 ${hue})` }}
    >
      {who.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/**
 * The whole conversation as text an agent can act on.
 *
 * Not a raw dump: it leads with what the agent is being asked to do, then the
 * facts it needs (workspace, customer, participants), then the messages oldest
 * first. Pasting a bare transcript makes the agent guess at the task, which is
 * the failure this is meant to avoid.
 */
function contextFor(thread: InboxThread): string {
  const lines = [
    `Here is an off-platform conversation from our ${PRODUCT_NAME} inbox. Read it, then tell me: what was agreed, what is outstanding, and whether it implies work we should file.`,
    "",
    `Subject:      ${thread.subject}`,
    `Source:       ${thread.source}`,
    `${`${W.Account}:`.padEnd(14)}${thread.customerId ?? "UNMATCHED — identify who this is if you can"}`,
    `Participants: ${thread.participants.join(", ")}`,
    `Messages:     ${thread.messageCount}`,
    "",
    "---",
    "",
  ];
  for (const m of thread.messages) {
    lines.push(`${m.from ?? "unknown"} — ${new Date(m.occurredAt).toISOString()}`);
    lines.push(m.body || m.preview || "(no content)");
    lines.push("");
  }
  return lines.join("\n");
}

/** The triage step: confirm the customer, write a summary, optionally file work. */
function PromoteForm({
  thread,
  authorEmail,
  busy,
  onPromoted,
  onError,
  setBusy,
}: {
  thread: InboxThread;
  authorEmail?: string;
  busy: boolean;
  onPromoted: () => void;
  onError: (m: string) => void;
  setBusy: (k: string | null) => void;
}) {
  const [customerId, setCustomerId] = useState(thread.customerId ?? "");
  const [summary, setSummary] = useState("");
  const [withTicket, setWithTicket] = useState(false);
  const [ticketSummary, setTicketSummary] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyContext() {
    try {
      await navigator.clipboard.writeText(contextFor(thread));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the thread is still selectable above */
    }
  }

  /**
   * Copy the context, then open the console's chat so it can be pasted into the
   * agent already wired to the data room.
   *
   * It copies rather than prefilling because ChatComposer is uncontrolled —
   * there is no value to set without changing its API. A button that navigated
   * and silently dropped the context would look like it worked, which is worse
   * than one paste.
   */
  async function copyAndOpenChat() {
    await copyContext();
    window.location.href = "/";
  }

  async function promote() {
    setBusy(thread.threadKey);
    try {
      await opsFetch("/api/ops/inbox/promote", {
        method: "POST",
        body: JSON.stringify({
          threadKey: thread.threadKey,
          customerId: customerId.trim(),
          summary: summary.trim(),
          ...(withTicket
            ? {
                ticket: {
                  summary: ticketSummary.trim() || summary.trim(),
                  ownerEmail: authorEmail ?? "",
                  nextStep: nextStep.trim() || "Review",
                },
              }
            : {}),
        }),
      });
      onPromoted();
    } catch (e) {
      onError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const ready = customerId.trim() !== "" && summary.trim() !== "" && (!withTicket || !!authorEmail);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-5 pt-4">
      <div className="pr-8">
        <h3 className="text-sm font-semibold leading-tight">{thread.subject}</h3>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"} ·{" "}
          {thread.participants.join(", ")}
        </p>
        {/* Hand the conversation to an agent BEFORE triaging it — reading a
            nine-message thread to write a one-line summary is the work, and it
            is the work an agent should be doing. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={copyContext}>
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? "Copied" : "Copy context"}
          </Button>
          <Button size="sm" variant="outline" onClick={copyAndOpenChat}>
            <SparklesIcon className="size-3.5" /> Copy &amp; open chat
          </Button>
        </div>
      </div>

      {/*
        Reads as the exchange it was — the shape every mail client uses, because
        it is the one people can scan: who, when, then what they said, with a
        rule between messages. The previous version was a single scrolling blob
        of text where a nine-message thread and a one-line note looked identical.
      */}
      <ol className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {thread.messages.map((m) => {
          const who = m.from ?? "unknown";
          return (
            <li key={m.id} className="bg-card px-3.5 py-3">
              <div className="flex items-start gap-2.5">
                <Avatar who={who} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-xs font-semibold">{who}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground" title={new Date(m.occurredAt).toLocaleString()}>
                      {when(m.occurredAt)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                    {m.body || m.preview || "(no content)"}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Two fields, both required. Outcome was a third optional box that
          nobody filled and that pushed the action below the fold; it is still
          supported by the API and can come back as a field on the record. */}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Input
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          placeholder={`${W.Account} — acme-bank`}
        />
        <Input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary — what happened, in one line"
        />
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={withTicket} onChange={(e) => setWithTicket(e.target.checked)} />
        File a ticket too — staged as <span className="font-mono">Needs Triage</span> for the existing approval queue
      </label>
      {withTicket && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={ticketSummary} onChange={(e) => setTicketSummary(e.target.value)} placeholder="Ticket summary (defaults to the summary above)" />
          <Input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Next step" />
        </div>
      )}
      {withTicket && !authorEmail && (
        <p className="text-2xs text-destructive">
          A ticket needs an owner and your email isn&apos;t known in this session — reload, or promote without one.
        </p>
      )}

      {/* One action. Archiving moved to the row, where it belongs — you decide
          to file something away from the list, not from inside it. */}
      <div className="flex justify-end pt-1">
        <Button size="sm" onClick={promote} disabled={!ready || busy}>
          {busy ? "Moving…" : "Move to data room"} <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
