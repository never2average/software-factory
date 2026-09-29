"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, MailIcon } from "lucide-react";
import { OrgMark } from "./org-mark";
import { cn } from "@/lib/utils";
import { activeOrg, opsFetch, switchWorkspace } from "./ops/lib";

/**
 * Which workspace you are in, and the way out of it.
 *
 * Three things were missing and they compound. Membership was resolvable but
 * never shown, so a person in two workspaces could not tell which one they were
 * looking at. The resolver picked the first row of an UNORDERED query, so it
 * could differ between refreshes. And leaving required an admin, so being added
 * to the wrong workspace was permanent unless somebody else acted.
 *
 * Pending invites are listed here too, because the only other copy of an invite
 * is an email — and if that email went to an address you cannot sign in with,
 * there was no copy at all.
 */

interface Membership {
  orgId: string;
  name: string;
  role: string;
  suspended?: boolean;
  /** How many things need attention there — see lib/workspace-attention.ts. */
  attention?: number;
}
interface Invite {
  orgId: string;
  name: string;
  role: string;
  invitedBy: string | null;
}

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [logos, setLogos] = useState<Record<string, string | undefined>>({});

  const load = useCallback(async () => {
    // Branding lives on the org row, not the membership — fetched so the
    // trigger can show the uploaded logo rather than falling back to a
    // monogram for a workspace that has one. Asked for alongside the
    // memberships, not after them: it needs nothing from their answer.
    opsFetch<{ items: { orgId: string; branding?: { logoUrl?: string } | null }[] }>("/api/ops/orgs")
      .then((o) =>
        setLogos(Object.fromEntries(o.items.map((x) => [x.orgId, x.branding?.logoUrl]))),
      )
      .catch(() => {
        /* branding is decorative — a monogram is a fine fallback */
      });
    try {
      const d = await opsFetch<{ memberships: Membership[]; invites: Invite[]; active?: string | null }>(
        "/api/ops/me/workspaces",
      );
      setMemberships(d.memberships);
      setInvites(d.invites);
      // No stored choice yet: adopt the same one the server would default to,
      // so the label matches what the API is actually returning.
      // `active` is the server's own answer (most recently chosen membership); memberships[0] is merely the
      // first row, and showing it labelled one workspace while the API served another. A stored choice that is
      // no longer a membership (removed from that workspace, another account on this browser) is ignored.
      const member = (id: string | null | undefined) => (id && d.memberships.some((m) => m.orgId === id) ? id : null);
      setCurrent((prev) => member(prev) ?? member(activeOrg()) ?? member(d.active) ?? d.memberships[0]?.orgId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your workspaces.");
    }
  }, []);

  useEffect(() => {
    setCurrent(activeOrg());
    void load();
  }, [load]);

  // Close on an outside click — a dropdown that traps the page is worse than no
  // dropdown, and this one sits above the account card at the bottom edge.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const switchTo = async (orgId: string) => {
    // This tab's workspace, the default for new tabs, and the server's "last selected" (a device that names no
    // workspace follows it). Awaited: the reload below must not race the write.
    await switchWorkspace(orgId);
    // A hard reload, deliberately. Every panel in the app has already fetched
    // its own tenant-scoped data; re-rendering with a new header would leave
    // stale rows from the previous workspace on screen, which for a tenancy
    // boundary is the one kind of staleness that must never happen.
    window.location.reload();
  };

  /**
   * No "leave workspace" here on purpose. Leaving is destructive and rare —
   * it removes a membership only someone else can restore — and it does not
   * belong on the control people click to SWITCH. Signing out (account card)
   * ends the session across every workspace, which is what people actually
   * want. Leaving belongs in workspace settings, sought out deliberately.
   */


  const accept = async (orgId: string) => {
    setBusy(orgId);
    setError(null);
    try {
      // Accepting from here has no token to redeem — the token lives in the
      // emailed link. This is the in-app equivalent for an invite you can SEE:
      // the server re-checks that a live invite exists for your address.
      await opsFetch("/api/ops/invites/claim", {
        method: "POST",
        body: JSON.stringify({ orgId }),
      });
      await switchTo(orgId);
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept that invite.");
      setBusy(null);
    }
  };

  /**
   * Always rendered, because this IS the brand now.
   *
   * It used to return null for a single workspace and sit next to the name as a
   * separate chevron — two controls saying one thing, and the name itself
   * (the obvious target) did nothing.
   */
  const active = memberships?.find((m) => m.orgId === current) ?? memberships?.[0] ?? null;
  const name = active?.name ?? "Workspace";
  const only = (memberships?.length ?? 0) <= 1 && invites.length === 0;

  return (
    <div ref={boxRef} className="relative min-w-0 shrink">
      <button
        type="button"
        onClick={() => !only && setOpen((v) => !v)}
        title={only ? name : `${name} — switch workspace`}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors",
          only ? "cursor-default" : "cursor-pointer hover:bg-muted",
        )}
      >
        <OrgMark name={name} logoUrl={active ? logos[active.orgId] : undefined} size="md" />
        <span className="truncate font-semibold text-sm">{name}</span>
        {!only ? (
          <span className="relative shrink-0">
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
            {invites.length > 0 ? (
              <span className="-right-1 -top-1 absolute size-2 rounded-full bg-foreground" />
            ) : null}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute top-full left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          <ul className="max-h-64 overflow-y-auto py-1">
            {(memberships ?? []).map((m) => (
              <li key={m.orgId} className="group/row flex items-center gap-1 px-1">
                <button
                  type="button"
                  onClick={() => (m.orgId === active?.orgId ? setOpen(false) : void switchTo(m.orgId))}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted"
                >
                  <OrgMark name={m.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{m.name}</span>
                    <span className="block truncate text-3xs text-muted-foreground">
                      {m.role}
                      {m.suspended ? " · suspended" : ""}
                    </span>
                  </span>
                  {/* What is waiting in THAT workspace. The whole reason to put
                      it here: it is the one number you cannot get from the
                      workspace you are currently looking at, and this is the
                      moment you are choosing between them. Absent, not zero,
                      when there is nothing — a row of noughts reads as noise. */}
                  {m.attention ? (
                    <span
                      className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-3xs text-amber-700 tabular-nums dark:text-amber-400"
                      title={`${m.attention} need attention in ${m.name}`}
                    >
                      {m.attention}
                    </span>
                  ) : null}
                  {m.orgId === active?.orgId ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                </button>
              </li>
            ))}
          </ul>

          {invites.length > 0 ? (
            <>
              <div className="border-border border-t px-3 py-1.5 text-3xs text-muted-foreground uppercase tracking-wide">
                Invitations
              </div>
              <ul className="pb-1">
                {invites.map((i) => (
                  <li key={i.orgId} className="flex items-center gap-2 px-2.5 py-1.5">
                    <MailIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{i.name}</span>
                      <span className="block truncate text-3xs text-muted-foreground">
                        as {i.role}
                        {i.invitedBy ? ` · from ${i.invitedBy}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy === i.orgId}
                      onClick={() => accept(i.orgId)}
                      className="shrink-0 cursor-pointer rounded-md bg-foreground px-2 py-1 font-medium text-3xs text-background disabled:opacity-40"
                    >
                      {busy === i.orgId ? "…" : "Join"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {error ? (
            <p className="border-border border-t px-3 py-2 text-3xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
