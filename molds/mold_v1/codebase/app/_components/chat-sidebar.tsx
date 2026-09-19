"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  DatabaseIcon,
  FileTextIcon,
  LogOutIcon,
  MailIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  UserIcon,
  Share2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CustomerMark } from "./customer-mark";
import { OrgMark } from "./org-mark";
import {
  type SharedThread,
  type StoredSession,
  chatToolCounts,
  formatRelativeTime,
  inferCustomersFromEvents,
  sessionCustomers,
} from "./chat-shell";
import { type DataroomTab } from "./dataroom";
import { OPS_SECTIONS, type OpsSection } from "./ops-center";
import { activeOrg, opsFetch } from "./ops/lib";
import { ThemeToggle } from "./theme-toggle";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface ChatSidebarProps {
  readonly sessions: StoredSession[];
  /** The last list load failed — say so instead of claiming there are none. */
  readonly listStale?: boolean;
  /** Writes to the durable mirror are failing. Distinct from listStale: the
   *  chats on screen are real, but they are NOT being saved, and silence here
   *  is how a finished conversation disappears on the next reload. */
  readonly saveFailed?: boolean;
  /** Threads shared WITH me (read-only), rendered in a "Shared with you" section. */
  readonly sharedThreads?: SharedThread[];
  readonly onSelectShared?: (t: SharedThread) => void;
  /** Known customers (id → name) for inferring/labeling a chat's context. */
  readonly customers?: { id: string; name: string }[];
  readonly activeId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly picture: string | null;
  readonly onSelect: (s: StoredSession) => void;
  readonly onNew: () => void;
  readonly onDelete: (id: string) => void;
  readonly onArchive: (id: string) => void;
  readonly onSearch: () => void;
  readonly onOpenDataroom: (tab: DataroomTab) => void;
  readonly onOpenOps: (section: OpsSection) => void;
  readonly onCollapse: () => void;
  readonly onSignOut: () => void;
}

/** Infer a chat's customer(s) from its raw event log when none were manually
 *  picked — matches known customer ids as whole tokens in user messages and
 *  tool inputs, mirroring the header's live inference. */
export function ChatSidebar({
  sessions,
  listStale,
  saveFailed,
  sharedThreads = [],
  onSelectShared,
  customers = [],
  activeId,
  email,
  name,
  picture,
  onSelect,
  onNew,
  onDelete,
  onArchive,
  onSearch,
  onOpenDataroom,
  onOpenOps,
  onCollapse,
  onSignOut,
}: ChatSidebarProps) {
  const idSet = useMemo(() => new Set(customers.map((c) => c.id.toLowerCase())), [customers]);
  const nameOf = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id.toLowerCase(), c.name]));
    return (idOrName: string) => m.get(idOrName.toLowerCase()) ?? idOrName;
  }, [customers]);
  return (
    <aside className="flex h-dvh w-72 max-w-[85vw] shrink-0 flex-col border-border border-r bg-background md:bg-muted/20">
      {/* Brand + actions */}
      {/* Brand + switcher together: which workspace you are in, and how to
          change it, in the one place people look for it. It lived at the
          bottom next to sign-out, which read as an account setting rather than
          the scope of everything on screen. */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-1 px-3">
        {/* The switcher renders the brand itself: one control, and the NAME is
            the target rather than a chevron beside it. */}
        <WorkspaceSwitcher />
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button
            type="button"
            onClick={onNew}
            className="rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={onSearch}
            className="rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Search chats"
            title="Search chats"
          >
            <SearchIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            className="rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Collapse sidebar"
            title="Collapse"
          >
            <PanelLeftCloseIcon className="size-4" />
          </button>
        </div>
      </div>

      <div className="px-3 pt-1 pb-1">
        <ul className="flex flex-col gap-0.5">
          {/* Dataroom — opens the full dm.md file browser. */}
          <li>
            <button
              type="button"
              onClick={() => onOpenDataroom("customers")}
              className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-0 font-medium text-foreground/90 text-xs leading-5 transition-colors hover:bg-muted hover:text-foreground"
            >
              <DatabaseIcon className="size-3.5 shrink-0" />
              Dataroom
            </button>
          </li>

          {/* Connectors · Workflows · Crons */}
          {OPS_SECTIONS.map(({ key, label, icon: Icon }) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => onOpenOps(key)}
                className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-0 font-medium text-foreground/90 text-xs leading-5 transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <hr className="mx-3 my-1.5 border-border" />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-0.5 pb-2">
        <p className="px-3 pt-1 pb-0.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
          Chats
        </p>
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-center text-muted-foreground text-xs">
            {listStale
              ? "Couldn't load your chats. Retrying…"
              : "No chats yet. Hit + to start one."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((s) => {
              const manualCustomers = sessionCustomers(s);
              // Manual selection wins; otherwise infer live from events when they
              // are present, else fall back to the snapshot taken at persist time
              // (so a chat whose events were stripped for quota still shows its
              // customer badge instead of a blank row).
              const customers = manualCustomers.length
                ? manualCustomers
                : s.events?.length
                  ? inferCustomersFromEvents(s.events, idSet)
                  : (s.derivedCustomers ?? []);
              const counts = chatToolCounts(s);
              const isActive = s.id === activeId;
              return (
              <li key={s.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-0.5 rounded-lg py-2 pr-2 pl-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    isActive ? "bg-muted text-foreground shadow-[inset_2px_0_0_hsl(var(--foreground))]" : "hover:bg-muted/60",
                  )}
                >
                  {/* The title owns the full row; only on hover does it yield the
                      trailing space the archive/delete buttons overlay. */}
                  <span className="block w-full truncate pr-0 font-medium text-xs leading-tight transition-[padding] group-hover:pr-12 group-focus-within:pr-12">
                    {s.title || "New chat"}
                  </span>
                  <span className="flex min-w-0 w-full items-center gap-2 text-3xs text-muted-foreground">
                    {customers.length > 0 ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CustomerMark name={nameOf(customers[0])} size="xs" />
                        <span className="truncate">
                          {customers.length === 1
                            ? nameOf(customers[0])
                            : `${nameOf(customers[0])} +${customers.length - 1}`}
                        </span>
                      </span>
                    ) : null}
                    {counts.artifacts > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <FileTextIcon className="size-2.5" />
                        {counts.artifacts}
                      </span>
                    ) : null}
                    {counts.emails > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <MailIcon className="size-2.5" />
                        {counts.emails}
                      </span>
                    ) : null}
                    {/* Hidden on hover — the archive/delete buttons take this corner. */}
                    <span className="ml-auto shrink-0 tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {formatRelativeTime(s.updatedAt)}
                    </span>
                  </span>
                </button>
                <div className="absolute top-1.5 right-1 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
                  <button
                    type="button"
                    onClick={() => onArchive(s.id)}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Archive chat"
                    title="Archive"
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(s.id)}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Delete chat"
                    title="Delete"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              </li>
            );
            })}
          </ul>
        )}

        {sharedThreads.length > 0 ? (
          <>
            <p className="px-3 pt-4 pb-0.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
              Shared with you
            </p>
            <ul className="flex flex-col gap-0.5">
              {sharedThreads.map((t) => {
                const isActive = activeId === `shared:${t.id}`;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onSelectShared?.(t)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex w-full min-w-0 flex-col gap-0.5 rounded-lg py-2 pr-2 pl-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        isActive
                          ? "bg-muted text-foreground shadow-[inset_2px_0_0_hsl(var(--foreground))]"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <span className="flex w-full min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium text-xs leading-tight">
                          {t.title || "Shared chat"}
                        </span>
                        {/* Trailing, so titles start on the same left edge as
                            your own chats and the list still scans as one
                            column. Deliberately absent from your own rows: an
                            icon every row carries says nothing. */}
                        <Share2Icon className="size-3 shrink-0 text-muted-foreground/70" />
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
                        <CustomerMark name={t.ownerEmail} size="xs" />
                        <span className="truncate">
                          {t.ownerEmail.split("@")[0]}
                          {t.role === "participant" ? "" : " · view-only"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </nav>

      {saveFailed ? (
        <div className="mx-2 mb-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-3xs text-amber-700 dark:text-amber-400">
          Your chat list isn&apos;t saving. Recent chats may not survive a reload — retrying.
        </div>
      ) : null}

      {/* Account CARD: profile on the left, settings + sign-out on the right */}
      <div className="m-2 flex shrink-0 items-center gap-2.5 rounded-xl border border-border bg-card p-2.5 shadow-sm">
        <Avatar picture={picture} name={name} email={email} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{name ?? email ?? "Signed in"}</div>
          {name && email ? (
            <div className="truncate text-muted-foreground text-xs">{email}</div>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ThemeToggle />
          <a
            href="/workspace"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Open workspace settings"
            title="Workspace settings"
          >
            <SettingsIcon className="size-4" />
          </a>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-md p-2 text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOutIcon className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Avatar({
  picture,
  name,
  email,
}: {
  readonly picture: string | null;
  readonly name: string | null;
  readonly email: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const initials = (name ?? email ?? "?").trim().charAt(0).toUpperCase();
  if (picture && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={picture}
        alt={name ?? "Profile"}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="size-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground text-xs">
      {initials !== "?" ? initials : <UserIcon className="size-4" />}
    </span>
  );
}
