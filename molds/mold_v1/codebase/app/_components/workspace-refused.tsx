"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { OrgMark } from "./org-mark";
import { Spinner } from "@/components/ui/spinner";
import { STORAGE_KEYS, readStored, writeActiveOrg } from "@/lib/browser-storage";
import { guestLinkOf } from "@/lib/guest-invite-rules";
import { onWorkspaceRefusal, showWorkspaceRefusal, workspaceRefusalState } from "@/lib/workspace-refusal";
import { switchWorkspace } from "./ops/lib";

/**
 * "You are not a member of this workspace" — what a person sees when the workspace this tab is set to is one the
 * server refuses (a remembered choice that is no longer theirs, a link that names someone else's workspace, an id
 * that does not exist). The server used to answer such a request from the person's own first workspace, so the page
 * showed that workspace's records under the other one's name. Now it refuses, and this is the page: one plain
 * sentence and the person's OWN workspaces to open. Never a blank page, never a retry loop: nothing here asks again
 * by itself, and choosing a workspace loads the page without the link's `org`, so the refused one is not adopted again.
 */

interface Membership {
  orgId: string;
  name: string;
  role: string;
  suspended?: boolean;
}

/** The workspace of a shared chat's link on this page (`/?chatSession=…&org=…`), or null. */
function guestLinkWorkspace(): string | null {
  try {
    const q = new URLSearchParams(window.location.search);
    return guestLinkOf({ org: q.get("org"), chat: q.get("chatSession") })?.org ?? null;
  } catch {
    return null;
  }
}

const noRefusal = () => false;

/** True once this page should show the refusal instead of the console (lib/workspace-refusal.ts). */
export function useWorkspaceRefused(): boolean {
  return useSyncExternalStore(
    onWorkspaceRefusal,
    () => showWorkspaceRefusal(workspaceRefusalState(), guestLinkWorkspace()),
    noRefusal,
  );
}

/** This page's address without the link that named the refused workspace. */
function ownAddress(): string {
  return window.location.pathname || "/";
}

export function WorkspaceRefused({ onSignOut }: { readonly onSignOut?: () => void }) {
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const hadChatLink = typeof window !== "undefined" && Boolean(guestLinkWorkspace());

  /**
   * The person's own workspaces. /api/ops/me/workspaces is about the CALLER, not a workspace, so it answers whatever
   * this tab is set to; asked with the bearer alone all the same, so a refused workspace is not named again.
   */
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const token = readStored(STORAGE_KEYS.token);
      const res = await fetch("/api/ops/me/workspaces", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { memberships?: Membership[] };
      setMemberships(Array.isArray(data.memberships) ? data.memberships : []);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = async (orgId: string) => {
    setBusy(orgId);
    // The switcher's own path: this tab, the default for new tabs, and the server's "last selected".
    await switchWorkspace(orgId);
    window.location.assign(ownAddress());
  };
  /** Forget the refused choice and load the page as someone who has chosen nothing (invites, or setting one up). */
  const startOver = () => {
    writeActiveOrg(null);
    window.location.assign(ownAddress());
  };

  return (
    <main
      data-workspace-refused
      className="flex h-dvh flex-col items-center justify-center bg-background px-6 text-foreground"
    >
      <div className="w-full max-w-sm">
        <h1 className="font-semibold text-xl tracking-tight">You are not a member of this workspace</h1>
        <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
          {hadChatLink
            ? "This link opens a chat in a workspace you are not a member of, and the chat is not shared with the address you signed in with. Nothing from that workspace is shown."
            : "This browser was set to a workspace you are not a member of, so nothing from it is shown."}
        </p>

        {memberships === null && !failed ? (
          <div className="mt-6 flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner />
            Finding your workspaces…
          </div>
        ) : null}

        {failed ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm">Your workspaces could not be loaded just now.</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 font-medium text-background text-xs"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={startOver}
                className="cursor-pointer rounded-md border border-border px-3 py-1.5 font-medium text-xs hover:bg-muted"
              >
                Continue without it
              </button>
            </div>
          </div>
        ) : null}

        {memberships && memberships.length > 0 ? (
          <>
            <p className="mt-6 font-medium text-sm">Open one of your workspaces</p>
            <ul className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
              {memberships.map((m) => (
                <li key={m.orgId} className="border-border border-b last:border-b-0">
                  <button
                    type="button"
                    data-own-workspace={m.orgId}
                    disabled={busy !== null}
                    onClick={() => void open(m.orgId)}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted disabled:cursor-default disabled:opacity-60"
                  >
                    <OrgMark name={m.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.name}</span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {m.role}
                        {m.suspended ? " · suspended" : ""}
                      </span>
                    </span>
                    {busy === m.orgId ? <Spinner /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {memberships && memberships.length === 0 ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm">You are not a member of any workspace yet.</p>
            <button
              type="button"
              onClick={startOver}
              className="mt-3 cursor-pointer rounded-md bg-foreground px-3 py-1.5 font-medium text-background text-xs"
            >
              Continue
            </button>
          </div>
        ) : null}

        {onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            className="mt-6 cursor-pointer text-muted-foreground text-xs underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        ) : null}
      </div>
    </main>
  );
}
