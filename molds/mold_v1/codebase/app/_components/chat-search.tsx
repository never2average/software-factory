"use client";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { BotIcon, FileTextIcon, Share2Icon, UserPlusIcon } from "lucide-react";
import { CustomerMark } from "./customer-mark";
import {
  type SharedThread,
  type StoredSession,
  chatToolCounts,
  formatRelativeTime,
  sessionCustomers,
} from "./chat-shell";

interface ChatSearchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessions: StoredSession[];
  readonly onSelect: (s: StoredSession) => void;
  readonly sharedThreads?: SharedThread[];
  readonly onSelectShared?: (t: SharedThread) => void;
}

export function ChatSearchDialog({
  open,
  onOpenChange,
  sessions,
  onSelect,
  sharedThreads = [],
  onSelectShared,
}: ChatSearchDialogProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search chats"
      description="Find and open a past conversation"
      className="w-[92vw] max-w-3xl rounded-2xl border border-white/10 bg-popover shadow-2xl ring-1 ring-white/5 sm:max-w-3xl"
    >
      <CommandInput placeholder="Search chats…" />
      <CommandList className="max-h-[65vh]">
        <CommandEmpty>No chats found.</CommandEmpty>
        <CommandGroup>
          {sessions.map((s) => {
            // Customers = manually-set, else the auto-inferred ones (so workflow
            // chats surface their customer too).
            const manual = sessionCustomers(s);
            const custs = manual.length ? manual : (s.derivedCustomers ?? []);
            const counts = chatToolCounts(s);
            const invitees = s.invitees ?? [];
            return (
              <CommandItem
                key={s.id}
                value={`${s.title} ${custs.join(" ")} ${invitees.join(" ")} ${s.id}`}
                onSelect={() => onSelect(s)}
                className="flex flex-col items-start gap-1.5 rounded-lg px-3 py-2.5"
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-sm">
                    {s.title || "New chat"}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                  {custs.length > 0 ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground/90">
                      <CustomerMark name={custs[0]} size="sm" />
                      {custs.length === 1 ? custs[0] : `${custs[0]} +${custs.length - 1}`}
                    </span>
                  ) : null}
                  {invitees.length > 0 ? (
                    <span className="flex items-center gap-1" title={invitees.join(", ")}>
                      <UserPlusIcon className="size-2.5" />
                      {invitees.length === 1 ? invitees[0].split("@")[0] : `${invitees.length} invitees`}
                    </span>
                  ) : null}
                  <span className="flex items-center gap-1">
                    <FileTextIcon className="size-2.5" />
                    {counts.artifacts} artifact{counts.artifacts === 1 ? "" : "s"}
                  </span>
                  <span className="flex items-center gap-1">
                    <BotIcon className="size-2.5" />
                    {counts.subagents} subagent{counts.subagents === 1 ? "" : "s"}
                  </span>
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {sharedThreads.length > 0 ? (
          <CommandGroup heading="Shared with you">
            {sharedThreads.map((t) => (
              <CommandItem
                key={t.id}
                value={`${t.title} ${t.ownerEmail} shared ${t.id}`}
                onSelect={() => onSelectShared?.(t)}
                className="flex flex-col items-start gap-1.5 rounded-lg px-3 py-2.5"
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-sm">{t.title || "Shared chat"}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {formatRelativeTime(Date.parse(t.updatedAt))}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                  <Share2Icon className="size-2.5" />
                  <CustomerMark name={t.ownerEmail} size="sm" />
                  {t.ownerEmail.split("@")[0]}
                  {t.role === "participant" ? "" : " · view-only"}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
