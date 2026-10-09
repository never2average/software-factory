/*
 * Desktop notifications for this app — the service worker.
 *
 * Registered only after the person turns "Desktop notifications" on (app/_components/notifications-bell.tsx),
 * never on page load. It does three things and caches nothing:
 *
 *  1. PUSH: show what the server sent (agent/lib/push-notify.ts) — the chat title and a short preview, or the title
 *     alone when the person turned previews off — unless a focused, visible tab is showing that very chat.
 *  2. CLICK: bring a tab of this app forward on that chat, or open one.
 *  3. PAGE MESSAGES: a HIDDEN tab asks it to show the notification for an event it read on its own stream (when the
 *     server cannot push). Both paths use one `tag` per event (session:turn:kind), so a push and a tab — or two
 *     tabs — never alert twice for the same thing: the second only replaces the first, silently.
 */
const GENERIC = {
  reply: "Your reply is ready.",
  input: "The agent needs your answer.",
  failed: "A reply failed. Open the chat to try again.",
};
const ASK_MS = 400;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Ask one tab which chat it shows; null when it does not answer in time. */
function ask(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_MS);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data || null);
    };
    try {
      client.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Is the person looking at this chat right now — a focused, visible tab showing it? */
async function beingViewed(sessionId) {
  if (!sessionId) return false;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (!client.focused || client.visibilityState !== "visible") continue;
    const answer = await ask(client, { type: "which-chat" });
    if (answer && answer.sessionId === sessionId) return true;
  }
  return false;
}

async function show(payload, { checkViewing }) {
  if (!payload || typeof payload.title !== "string" || typeof payload.tag !== "string") return;
  if (checkViewing && (await beingViewed(payload.sessionId))) return;
  await self.registration.showNotification(payload.title, {
    body: typeof payload.body === "string" && payload.body ? payload.body : GENERIC[payload.kind] || "",
    tag: payload.tag,
    renotify: false,
    data: { url: payload.url || "/", sessionId: payload.sessionId || null },
  });
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  event.waitUntil(show(payload, { checkViewing: true }));
});

/** Open the chat a notification is about: an open tab of this app is focused and switched to it, else a new one. */
async function openChat(data) {
  // Only ever a page of THIS app: a URL on another origin (a tampered payload) opens the app's home instead.
  let target;
  try {
    target = new URL((data && data.url) || "/", self.location.origin);
  } catch {
    target = new URL("/", self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  const url = target.href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    try {
      await client.focus();
    } catch {
      /* focus is best-effort */
    }
    client.postMessage({ type: "open-chat", sessionId: (data && typeof data.sessionId === "string" && data.sessionId) || null, url });
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openChat(event.notification.data));
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "show") {
    // From a hidden tab: it already knows nobody is looking at it.
    event.waitUntil(show(message.payload, { checkViewing: false }));
  } else if (message.type === "open-notification" && typeof message.tag === "string") {
    // The same thing a click does, for a notification the page names by its tag (used by the page's own tests).
    event.waitUntil(
      self.registration.getNotifications({ tag: message.tag }).then((list) => {
        const n = list[0];
        if (!n) return undefined;
        n.close();
        return openChat(n.data);
      }),
    );
  }
});
