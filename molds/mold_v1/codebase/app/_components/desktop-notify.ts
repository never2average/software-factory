/**
 * DESKTOP NOTIFICATIONS, the browser's half: can this browser do it, turning it on and off, and a hidden tab's own
 * notifier.
 *
 * Two ways a notification reaches the person, one event, one `tag` (agent/lib/notification-text.ts):
 *
 *   - Tab CLOSED (or asleep): the server pushes (agent/hooks/notifications.ts → public/sw.js). Needs this device
 *     subscribed, which needs the server's VAPID key.
 *   - Tab open but HIDDEN or unfocused: this page saw the event on its own stream and shows it itself
 *     (`notifyFromPage`). Works even where the server cannot push.
 *
 * Both show under the same tag, so when both happen the second silently replaces the first — never two alerts. The
 * chat the person is LOOKING AT (tab visible and focused, that chat on screen) never notifies: the page checks
 * itself, and the service worker asks the page (`which-chat`) before showing a push.
 *
 * The permission prompt appears only inside `enableNotifications`, which is called from a click: never on load.
 */
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "@/lib/browser-storage";
import { notificationFor, type NotifyEvent } from "@/agent/lib/notification-text";

export interface DesktopPrefs {
  readonly on: boolean;
  readonly preview: boolean;
}

export type Support =
  | "supported"
  /** No Notification API or no service worker (an old browser, a private window of some browsers). */
  | "unsupported"
  /** iPhone / iPad Safari: Web Push works only for a site added to the Home Screen. */
  | "ios-install";

export function readPrefs(): DesktopPrefs {
  try {
    const raw = JSON.parse(readStored(STORAGE_KEYS.desktopNotifications) ?? "null") as Partial<DesktopPrefs> | null;
    return { on: raw?.on === true, preview: raw?.preview !== false };
  } catch {
    return { on: false, preview: true };
  }
}

function writePrefs(p: DesktopPrefs): void {
  writeStored(STORAGE_KEYS.desktopNotifications, JSON.stringify(p));
  for (const l of listeners) l(p);
}

const listeners = new Set<(p: DesktopPrefs) => void>();
export function onPrefsChange(fn: (p: DesktopPrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

export function support(): Support {
  if (typeof window === "undefined") return "unsupported";
  if (isIos() && !isInstalledApp()) return "ios-install";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  return "supported";
}

/** Can the SERVER reach this browser when its tabs are closed? (Push API present.) */
function pushCapable(): boolean {
  return typeof window !== "undefined" && "PushManager" in window && "serviceWorker" in navigator;
}

export function permission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

type AuthHeaders = () => Record<string, string>;

interface ServerState {
  readonly available: boolean;
  readonly publicKey?: string;
  readonly subscribed?: boolean;
  readonly preview?: boolean;
}

async function serverState(getAuthHeaders: AuthHeaders, endpoint?: string): Promise<ServerState> {
  try {
    const q = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : "";
    const res = await fetch(`/api/ops/push${q}`, { headers: getAuthHeaders(), cache: "no-store" });
    if (!res.ok) return { available: false };
    return (await res.json()) as ServerState;
  } catch {
    return { available: false };
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

async function subscribeHere(
  reg: ServiceWorkerRegistration,
  getAuthHeaders: AuthHeaders,
  publicKey: string,
  preview: boolean,
): Promise<boolean> {
  if (!pushCapable()) return false;
  try {
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await fetch("/api/ops/push", {
      method: "POST",
      headers: { ...getAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys }, preview }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type EnableResult =
  | { readonly ok: true; readonly push: boolean }
  | { readonly ok: false; readonly reason: "denied" | "unsupported" | "ios-install" };

/**
 * TURN IT ON — call this from the click itself: the browser's permission prompt appears here and only here.
 * `push` says whether closed-tab notifications work too (the server has a key and this browser subscribed).
 */
export async function enableNotifications(getAuthHeaders: AuthHeaders): Promise<EnableResult> {
  const s = support();
  if (s !== "supported") return { ok: false, reason: s };
  // FIRST, before any await: a permission request must stay inside the click's user activation.
  const granted = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (granted !== "granted") return { ok: false, reason: "denied" };
  const prefs = { on: true, preview: readPrefs().preview };
  writePrefs(prefs);
  const reg = await registration();
  const server = await serverState(getAuthHeaders);
  const push = Boolean(reg && server.available && server.publicKey && (await subscribeHere(reg, getAuthHeaders, server.publicKey, prefs.preview)));
  return { ok: true, push };
}

/** This browser's push endpoint, if it has one. */
async function endpointHere(): Promise<string | null> {
  if (!pushCapable()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** TURN IT OFF for this browser: no more pushes here, no more page notifications. */
export async function disableNotifications(getAuthHeaders: AuthHeaders): Promise<void> {
  writePrefs({ on: false, preview: readPrefs().preview });
  await forgetThisDevice(getAuthHeaders());
}

/**
 * Remove this device's subscription (the toggle, and sign-out — call it BEFORE the sign-in is dropped: it needs the
 * sign-in to say whose row to delete). Unsubscribes the browser too, so nothing can arrive for the next person.
 */
export async function forgetThisDevice(headers: Record<string, string>): Promise<void> {
  try {
    const reg = pushCapable() ? await navigator.serviceWorker.getRegistration("/") : undefined;
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await fetch(`/api/ops/push?endpoint=${encodeURIComponent(sub.endpoint)}`, {
      method: "DELETE",
      headers,
      keepalive: true,
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
  } catch {
    /* nothing to remove */
  }
}

/** Sign-out: this browser forgets the person's choice as well as their device row. */
export function clearDesktopPrefs(): void {
  removeStored(STORAGE_KEYS.desktopNotifications);
}

/** "Show message preview in notifications". */
export async function setPreview(getAuthHeaders: AuthHeaders, preview: boolean): Promise<void> {
  writePrefs({ ...readPrefs(), preview });
  const endpoint = await endpointHere();
  if (!endpoint) return;
  await fetch("/api/ops/push", {
    method: "PATCH",
    headers: { ...getAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ endpoint, preview }),
  }).catch(() => undefined);
}

export interface DeviceState {
  readonly support: Support;
  readonly permission: NotificationPermission | "unsupported";
  readonly prefs: DesktopPrefs;
  /** Does the server have a key to push with? */
  readonly serverAvailable: boolean;
  /** Is THIS browser subscribed for pushes? */
  readonly pushHere: boolean;
}

/** Everything the settings panel shows. Registers nothing and prompts for nothing. */
export async function deviceState(getAuthHeaders: AuthHeaders): Promise<DeviceState> {
  const prefs = readPrefs();
  const endpoint = await endpointHere();
  const server = await serverState(getAuthHeaders, endpoint ?? undefined);
  return {
    support: support(),
    permission: permission(),
    prefs,
    serverAvailable: server.available,
    pushHere: Boolean(endpoint && server.subscribed),
  };
}

/**
 * On load, for a browser that turned notifications ON earlier (never otherwise): keep the service worker and the
 * subscription current — a browser may rotate a subscription, and the server forgets one the push service dropped.
 */
export async function refreshIfEnabled(getAuthHeaders: AuthHeaders): Promise<void> {
  const prefs = readPrefs();
  if (!prefs.on || permission() !== "granted" || support() !== "supported") return;
  const reg = await registration();
  if (!reg) return;
  const server = await serverState(getAuthHeaders);
  if (server.available && server.publicKey) await subscribeHere(reg, getAuthHeaders, server.publicKey, prefs.preview);
}

/* ─────────────────────────── the page's own notifier ─────────────────────────── */

/** The chat this tab is showing (its eve session), for "don't notify what I'm looking at". */
let viewing: string | null = null;
export function setViewingSession(sessionId: string | null): void {
  viewing = sessionId;
}

function lookingAt(sessionId: string): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus() && viewing === sessionId;
}

/**
 * A HIDDEN or unfocused tab read `ev` on its own stream: show it, unless the person is looking at that chat.
 * Through the service worker when there is one (the same tag as the server's push, so never twice), else with the
 * page's Notification API.
 */
export async function notifyFromPage(ev: NotifyEvent, title: string | null): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const prefs = readPrefs();
  if (!prefs.on || Notification.permission !== "granted") return;
  if (lookingAt(ev.sessionId)) return;
  const payload = notificationFor(ev, title, prefs.preview);
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
    if (reg?.active) {
      reg.active.postMessage({ type: "show", payload });
      return;
    }
    const n = new Notification(payload.title, { body: payload.body ?? "", tag: payload.tag });
    n.onclick = () => {
      window.focus();
      n.close();
      openChatHandler?.(payload.sessionId);
    };
  } catch {
    /* a notification is a courtesy; failing to show one changes nothing */
  }
}

/* ─────────────────────────── the service worker's questions ─────────────────────────── */

let openChatHandler: ((sessionId: string) => void) | null = null;
let bridged = false;

/**
 * Answer the service worker: which chat this tab shows (so a push about it is not shown), and "open this chat"
 * after a notification click (the shell switches to it; `onOpenChat`).
 */
export function installNotificationBridge(onOpenChat: (sessionId: string) => void): () => void {
  openChatHandler = onOpenChat;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    const m = e.data as { type?: string; sessionId?: string | null; url?: string } | null;
    if (m?.type === "which-chat") {
      const visible = document.visibilityState === "visible" && document.hasFocus();
      e.ports?.[0]?.postMessage({ sessionId: visible ? viewing : null });
    } else if (m?.type === "open-chat" && m.sessionId) {
      openChatHandler?.(m.sessionId);
    }
  };
  if (!bridged) {
    bridged = true;
    navigator.serviceWorker.addEventListener("message", onMessage);
  }
  return () => {
    openChatHandler = null;
  };
}
