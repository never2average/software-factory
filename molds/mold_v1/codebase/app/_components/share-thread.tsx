"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, Share2Icon, UserPlus2Icon, XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { opsFetch } from "./ops/lib";
import { CustomerMark } from "./customer-mark";
import { cn } from "@/lib/utils";

/** The snapshot of the current chat needed to create/update its server thread. */
export interface SharePayload {
  clientKey: string;
  eveSessionId: string;
  title: string;
  preview?: string;
  customers?: string[];
  forkedFrom?: { id: string; title: string };
  continuationToken?: string;
  clientEvents?: unknown[];
}

type Role = "viewer" | "participant";
interface Member {
  email: string;
  role: string;
  status: string;
  /** Not on the viewer's own email domain — computed per caller by the API. */
  external?: boolean;
}

/** Personal-account domains. Sign-in refuses these, so the invite must too. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);
interface RosterMember {
  email: string;
  name: string | null;
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", participant: "Can participate", viewer: "Can view" };

export function ShareThreadButton({ getPayload }: { readonly getPayload: () => SharePayload | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
        title="Share this thread with teammates"
      >
        <Share2Icon className="size-3.5" />
        Share
      </button>
      {open ? <ShareDialog getPayload={getPayload} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ShareDialog({
  getPayload,
  onClose,
}: {
  readonly getPayload: () => SharePayload | null;
  readonly onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  /** Per-invite delivery, keyed by email — "did this person actually get told". */
  const [delivery, setDelivery] = useState<Record<string, { delivered: boolean; reason?: string }>>({});
  /**
   * Am I the owner of this thread, or someone it was shared with?
   *
   * Read from the row the server hands back rather than assumed. The dialog
   * used to label whoever opened it "Owner", because the ensure route forked a
   * thread for them — so a participant saw themselves as owner and nobody else
   * in the list at all.
   */
  const [iOwnThis, setIOwnThis] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<Role>("participant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadMembers = useCallback(async (tid: string) => {
    const m = await opsFetch<{ items: Member[] }>(`/api/ops/threads/${tid}/members`);
    setMembers(m.items.filter((x) => x.status !== "revoked"));
  }, []);

  // Ensure the server thread row, then load members + roster + presence.
  useEffect(() => {
    let alive = true;
    const payload = getPayload();
    if (!payload) {
      setError("Send a message first — an empty thread can't be shared yet.");
      return;
    }
    (async () => {
      try {
        const { item } = await opsFetch<{ item: { id: string; ownerEmail: string; viewerEmail?: string } }>("/api/ops/threads", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!alive) return;
        setThreadId(item.id);
        setOwnerEmail(item.ownerEmail);
        setViewerEmail(item.viewerEmail ?? item.ownerEmail);
        setIOwnThis(item.ownerEmail.toLowerCase() === (item.viewerEmail ?? item.ownerEmail).toLowerCase());
        await loadMembers(item.id);
        setReady(true);
        opsFetch<{ online: { email: string }[] }>(`/api/ops/threads/${item.id}/presence`)
          .then((p) => alive && setOnline(new Set(p.online.map((o) => o.email))))
          .catch(() => {});
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    opsFetch<{ items: RosterMember[] }>("/api/ops/roster")
      .then((r) => alive && setRoster(r.items))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = useMemo(() => {
    const map = new Map(roster.map((r) => [r.email.toLowerCase(), r.name ?? r.email.split("@")[0]]));
    return (e: string) => map.get(e.toLowerCase()) ?? e.split("@")[0];
  }, [roster]);

  const memberEmails = useMemo(
    () => new Set([ownerEmail?.toLowerCase(), ...members.map((m) => m.email.toLowerCase())].filter(Boolean)),
    [members, ownerEmail],
  );

  // Roster suggestions matching the query, excluding people already on the thread.
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster
      .filter((r) => !memberEmails.has(r.email.toLowerCase()))
      .filter((r) => !q || r.email.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [roster, query, memberEmails]);

  const invite = useCallback(
    async (targetEmail: string, targetRole: Role) => {
      const target = targetEmail.trim().toLowerCase();
      if (!threadId || !target) return;
      setBusy(true);
      setError(null);
      try {
        const res = await opsFetch<{ delivery?: { delivered: boolean; reason?: string } }>(
          `/api/ops/threads/${threadId}/members`,
          { method: "POST", body: JSON.stringify({ email: target, role: targetRole }) },
        );
        if (res?.delivery) setDelivery((d) => ({ ...d, [target]: res.delivery! }));
        await loadMembers(threadId);
        setQuery("");
        inputRef.current?.focus();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [threadId, loadMembers],
  );

  const changeRole = useCallback(
    async (target: string, next: Role) => {
      if (!threadId) return;
      setOpenMenu(null);
      setMembers((prev) => prev.map((m) => (m.email === target ? { ...m, role: next } : m)));
      try {
        await opsFetch(`/api/ops/threads/${threadId}/members/${encodeURIComponent(target)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: next }),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void loadMembers(threadId);
      }
    },
    [threadId, loadMembers],
  );

  const revoke = useCallback(
    async (target: string) => {
      if (!threadId) return;
      setOpenMenu(null);
      setMembers((prev) => prev.filter((m) => m.email !== target));
      try {
        await opsFetch(`/api/ops/threads/${threadId}/members/${encodeURIComponent(target)}`, { method: "DELETE" });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void loadMembers(threadId);
      }
    },
    [threadId, loadMembers],
  );

  const typedEmail = query.trim().toLowerCase();
  const myDomain = (viewerEmail ?? ownerEmail ?? "").split("@")[1] ?? "";
  const typedDomain = typedEmail.split("@")[1] ?? "";
  // Any work address, inside the company or out. Personal accounts are refused
  // here for the same reason the server refuses them: sign-in rejects them, so
  // the invite would be a member row nobody can ever use.
  const typedIsConsumer = CONSUMER_DOMAINS.has(typedDomain);
  const canInviteTyped =
    /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(typedEmail) && !typedIsConsumer && !memberEmails.has(typedEmail);
  const typedIsExternal = canInviteTyped && !!myDomain && typedDomain !== myDomain;
  const externalMembers = members.filter((m) => m.external);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        {/* Header */}
        <DialogHeader className="space-y-0 border-border/70 border-b px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted">
              <Share2Icon className="size-3.5 text-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-sm leading-tight">Share thread</DialogTitle>
              <p className="text-2xs text-muted-foreground leading-tight">
                People you add can view or take part in this conversation.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </DialogHeader>

        {/* Invite combobox */}
        <div className="relative px-5 pt-4">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 focus-within:border-foreground/40">
            <UserPlus2Icon className="size-4 shrink-0 text-muted-foreground/70" />
            <input
              ref={inputRef}
              value={query}
              disabled={!ready || busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canInviteTyped) {
                  e.preventDefault();
                  void invite(typedEmail, role);
                }
              }}
              placeholder="Add people by name or email…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
            />
            <RolePicker value={role} onChange={setRole} />
          </div>

          {/* Suggestion dropdown */}
          {query.trim() && (suggestions.length > 0 || canInviteTyped) ? (
            <div className="absolute inset-x-5 z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
              {suggestions.map((s) => (
                <button
                  key={s.email}
                  type="button"
                  onClick={() => void invite(s.email, role)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <CustomerMark name={s.name ?? s.email} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{s.name ?? s.email.split("@")[0]}</span>
                    <span className="block truncate text-2xs text-muted-foreground">{s.email}</span>
                  </span>
                </button>
              ))}
              {canInviteTyped && !suggestions.some((s) => s.email.toLowerCase() === typedEmail) ? (
                <button
                  type="button"
                  onClick={() => void invite(typedEmail, role)}
                  className="flex w-full items-center gap-2.5 border-border/60 border-t px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <span className="grid size-5 place-items-center rounded-[5px] bg-muted">
                    <UserPlus2Icon className="size-3 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    Invite <span className="font-medium">{typedEmail}</span>
                    {typedIsExternal ? (
                      <span className="ml-1.5 text-2xs text-amber-600 dark:text-amber-400">
                        outside @{myDomain} — they&apos;ll read the whole thread
                      </span>
                    ) : null}
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {error ? <p className="px-5 pt-2 text-red-400 text-xs">{error}</p> : null}

        {/* Member list */}
        <div className="mt-3 max-h-[55vh] min-h-[16rem] overflow-y-auto px-2 pb-2">
          <p className="px-3 pb-1 font-medium text-2xs text-muted-foreground/50 uppercase tracking-wide">
            People with access
          </p>
          {!ready ? (
            <div className="flex flex-col gap-2 px-3 py-2">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <span className="size-7 animate-pulse rounded-md bg-muted" />
                  <span className="h-3 w-32 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <ul className="flex flex-col">
              {/* Owner row */}
              {ownerEmail ? (
                <MemberRow
                  email={ownerEmail}
                  name={nameOf(ownerEmail)}
                  roleLabel="Owner"
                  online={online.has(ownerEmail)}
                  isOwner
                />
              ) : null}
              {members.map((m) => (
                <MemberRow
                  key={m.email}
                  email={m.email}
                  name={nameOf(m.email)}
                  roleLabel={m.status === "invited" ? `${ROLE_LABEL[m.role]} · invited` : ROLE_LABEL[m.role]}
                  online={online.has(m.email)}
                  // Whether the invite notice actually reached them. Only known
                  // for people invited in this session — the server does not
                  // store delivery, and a stale "emailed" would be worse than
                  // silence.
                  external={m.external}
                  notice={
                    delivery[m.email]
                      ? delivery[m.email].delivered
                        ? { text: "emailed", ok: true }
                        : { text: "not emailed", ok: false, title: delivery[m.email].reason }
                      : undefined
                  }
                  // Only the owner may change roles or revoke. A participant
                  // seeing those controls would be offered actions the API
                  // refuses.
                  {...(iOwnThis
                    ? {
                        menuOpen: openMenu === m.email,
                        onToggleMenu: () => setOpenMenu((o) => (o === m.email ? null : m.email)),
                        onRole: (r: Role) => void changeRole(m.email, r),
                        onRevoke: () => void revoke(m.email),
                        currentRole: m.role as Role,
                      }
                    : {})}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Outside-the-company members are a standing fact about this thread,
            not a one-time toast: whoever opens Share later should see it too. */}
        {externalMembers.length > 0 ? (
          <p className="border-amber-500/25 border-t bg-amber-500/10 px-5 py-2 text-2xs text-amber-700 dark:text-amber-400">
            {externalMembers.length === 1
              ? `${externalMembers[0].email} is outside ${myDomain ? `@${myDomain}` : "your company"}`
              : `${externalMembers.length} people are outside ${myDomain ? `@${myDomain}` : "your company"}`}{" "}
            and can read this thread&apos;s full history.
          </p>
        ) : null}

        {/* Footer note */}
        <p className="border-border/60 border-t px-5 py-2.5 text-2xs text-muted-foreground/70">
          Anyone with a work email can be added — personal accounts can&apos;t sign in.
          They&apos;ll see it in “Shared with you”.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Segmented View/Participate toggle used in the invite row. */
function RolePicker({ value, onChange }: { readonly value: Role; readonly onChange: (r: Role) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-md bg-muted p-0.5 text-2xs">
      {(["viewer", "participant"] as const).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn(
            "rounded px-1.5 py-0.5 font-medium transition-colors",
            value === r ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r === "viewer" ? "View" : "Edit"}
        </button>
      ))}
    </div>
  );
}

function MemberRow({
  email,
  name,
  roleLabel,
  online,
  isOwner,
  menuOpen,
  onToggleMenu,
  onRole,
  onRevoke,
  currentRole,
  notice,
  external,
}: {
  readonly email: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly online?: boolean;
  readonly isOwner?: boolean;
  readonly menuOpen?: boolean;
  readonly onToggleMenu?: () => void;
  readonly onRole?: (r: Role) => void;
  readonly onRevoke?: () => void;
  readonly currentRole?: Role;
  /** "emailed" / "couldn't email them", with the reason as a tooltip. */
  readonly notice?: { text: string; ok: boolean; title?: string };
  /** Not on the viewer's email domain — shown inline so it can't be missed. */
  readonly external?: boolean;
}) {
  return (
    <li className="group/mr relative flex items-center gap-2.5 rounded-md px-3 py-1.5 hover:bg-muted/50">
      <span className="relative shrink-0">
        <CustomerMark name={name} size="md" />
        {online ? (
          <span className="absolute right-[-1px] bottom-[-1px] size-2 rounded-full border-2 border-background bg-emerald-500" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {email}
          {external ? (
            <span className="ml-1 text-amber-600 dark:text-amber-400">· external</span>
          ) : null}
          {notice ? (
            <span
              title={notice.title}
              className={notice.ok ? "ml-1 text-emerald-600 dark:text-emerald-400" : "ml-1 text-amber-600 dark:text-amber-400"}
            >
              · {notice.text}
            </span>
          ) : null}
        </span>
      </span>
      {isOwner ? (
        <span className="shrink-0 text-2xs text-muted-foreground">Owner</span>
      ) : (
        <>
          <button
            type="button"
            onClick={onToggleMenu}
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {roleLabel}
            <ChevronDownIcon className="size-3" />
          </button>
          {menuOpen ? (
            <div className="absolute top-full right-2 z-30 mt-0.5 w-40 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
              {(["participant", "viewer"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onRole?.(r)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  <CheckIcon className={cn("size-3.5", currentRole === r ? "opacity-100" : "opacity-0")} />
                  {r === "participant" ? "Can participate" : "Can view"}
                </button>
              ))}
              <div className="my-1 border-border/60 border-t" />
              <button
                type="button"
                onClick={onRevoke}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 text-xs transition-colors hover:bg-muted"
              >
                <XIcon className="size-3.5" />
                Remove
              </button>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
