"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon, BellOffIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  deviceState,
  disableNotifications,
  enableNotifications,
  onPrefsChange,
  readPrefs,
  refreshIfEnabled,
  setPreview,
  type DeviceState,
} from "./desktop-notify";

/**
 * The bell beside the account: "Desktop notifications", on or off, for this browser.
 *
 * One click turns it on, and that click is the only thing that ever shows the browser's permission prompt — never
 * a page load. Where it cannot work the bell says why in one line (this browser, an iPhone that has not added the
 * site to its Home Screen, a site the browser blocked) instead of offering a switch that does nothing. Without the
 * server's push key it still turns on — notifications then come while a tab is open — and says so.
 */
export function NotificationsBell({ getAuthHeaders }: { readonly getAuthHeaders: () => Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(false);
  const [state, setState] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the bell shows before it is opened: only the local choice, no request.
  useEffect(() => {
    setOn(readPrefs().on);
    return onPrefsChange((p) => setOn(p.on));
  }, []);
  // A browser that turned this on earlier keeps its subscription current. Nothing happens for anyone else.
  useEffect(() => {
    void refreshIfEnabled(getAuthHeaders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setState(await deviceState(getAuthHeaders));
  }, [getAuthHeaders]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    const res = await enableNotifications(getAuthHeaders);
    setBusy(false);
    if (!res.ok) {
      setNote(
        res.reason === "denied"
          ? "Your browser said no. To change that, see the steps below."
          : "This browser can't show notifications.",
      );
    }
    const next = await deviceState(getAuthHeaders);
    setState(next);
    // Only when closed-tab notifications SHOULD have worked here and did not (the no-key case has its own line).
    if (res.ok && !res.push && next.serverAvailable) {
      setNote("On while a tab of this app is open. Closed-tab notifications could not be set up in this browser.");
    }
  };
  const turnOff = async () => {
    setBusy(true);
    await disableNotifications(getAuthHeaders);
    setBusy(false);
    setNote(null);
    await load();
  };
  const togglePreview = async (preview: boolean) => {
    await setPreview(getAuthHeaders, preview);
    await load();
  };

  const Icon = on ? BellIcon : BellOffIcon;
  const blocked = state?.permission === "denied";
  const enabled = Boolean(state?.prefs.on && state.permission === "granted");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={on ? "Desktop notifications: on" : "Desktop notifications: off"}
        title="Desktop notifications"
        data-notifications-bell
      >
        <Icon className="size-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Desktop notifications</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm" data-notifications-panel>
            <p className="text-muted-foreground">
              Get a notification when a reply is ready or the agent needs your answer, even when this tab is in the
              background or closed.
            </p>
            {!state ? (
              <p className="text-muted-foreground">Checking this browser…</p>
            ) : state.support === "ios-install" ? (
              <p data-notifications-note>
                On iPhone and iPad, notifications work only after you add this site to your Home Screen (tap Share,
                then Add to Home Screen) and open it from there.
              </p>
            ) : state.support === "unsupported" ? (
              <p data-notifications-note>This browser can&apos;t show notifications.</p>
            ) : blocked ? (
              <div data-notifications-note className="space-y-1">
                <p>Notifications are blocked for this site. To allow them:</p>
                <ol className="list-decimal space-y-0.5 pl-5">
                  <li>Click the lock or settings icon at the left of the web address.</li>
                  <li>Set Notifications to Allow.</li>
                  <li>Reload this page, then open this bell again.</li>
                </ol>
              </div>
            ) : enabled ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    On for this browser
                    {state.pushHere ? "" : " (while a tab of this app is open)"}.
                  </span>
                  <button
                    type="button"
                    onClick={() => void turnOff()}
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    Turn off
                  </button>
                </div>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={state.prefs.preview}
                    onChange={(e) => void togglePreview(e.target.checked)}
                    data-notifications-preview
                  />
                  <span>
                    Show message preview in notifications
                    <span className="block text-muted-foreground text-xs">
                      Off: the notification shows the chat&apos;s name only.
                    </span>
                  </span>
                </label>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void turnOn()}
                disabled={busy}
                className="rounded-md bg-foreground px-3 py-2 text-background text-sm hover:opacity-90 disabled:opacity-50"
                data-notifications-enable
              >
                Turn on desktop notifications
              </button>
            )}
            {state && state.support === "supported" && !blocked && !state.serverAvailable ? (
              <p data-notifications-note className="text-muted-foreground text-xs">
                Your administrator hasn&apos;t turned on notifications for closed tabs yet. You&apos;ll still get them
                while this tab is open.
              </p>
            ) : null}
            {note ? <p className="text-amber-700 text-xs dark:text-amber-400">{note}</p> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
