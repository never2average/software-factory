/**
 * The keys this app keeps in a person's browser.
 *
 * Every key starts with `workspace-`: a neutral prefix, the same in every deployment, since a key is part of the
 * wire a stamped application ships with. (They once had another prefix; the values written under it were read as a
 * fallback after the rename on 2026-09-23 and are no longer read: a session token expires within the hour, the chat
 * list is the server's, and the rest is a preference a person sets again.)
 *
 * Pure, dependency-free and safe on the server: every accessor is wrapped,
 * because `localStorage` throws outright in a browser with site data blocked.
 */

/** The key each piece of state lives under today. */
export const STORAGE_KEYS = {
  /** The Google ID / email-session token the whole app authenticates with. */
  token: "workspace-google-token",
  /** One Tap's replay nonce. */
  nonce: "workspace-google-nonce",
  /** Which workspace the person last chose, for people who belong to several. */
  activeOrg: "workspace-active-org",
  /** system | light | dark. Also read by the pre-paint script in app/layout.tsx. */
  theme: "workspace-theme",
  /** Where an invite outcome is left for ChatShell to render. */
  inviteResult: "workspace-invite-result",
  /** Input requests the person waved away. */
  dismissedInputs: "workspace-dismissed-inputs",
  /** PREFIX. The real key is `${chats}:${email}:${orgId}` — see chat-shell.tsx. */
  chats: "workspace-chats",
  /**
   * PREFIX. `${lastChat}:${email}:${orgId}` holds the id of the chat that person last had open in that workspace, so
   * a reload reopens it from the cache (app/_components/chat-shell.tsx, bootFromCache).
   */
  lastChat: "workspace-last-chat",
  /**
   * PREFIX, in sessionStorage. THIS TAB's queue for a chat:
   * `${chatPending}:${email}:${orgId}:${chatId}` (lib/chat-queue). Cleared on sign-out.
   */
  chatPending: "workspace-chat-pending",
  /**
   * PREFIX. What eve still owes a chat, one record per tab:
   * `${chatOwed}:${email}:${orgId}:${chatId}:t:${tab}` (lib/chat-queue). Cleared on sign-out.
   */
  chatOwed: "workspace-chat-owed",
  /**
   * This browser's "Desktop notifications" choice: `{ on, preview }` (app/_components/desktop-notify.ts). Whether
   * the server may push is the subscription row; this is what a hidden tab's own notifier reads. Cleared on sign-out.
   */
  desktopNotifications: "workspace-desktop-notifications",
  /**
   * In sessionStorage, for the length of a Google sign-in redirect: the address (path and query) the person was on, so
   * they come back to it — a shared chat's link above all — rather than to the bare home page Google returns to.
   */
  signInReturn: "workspace-sign-in-return",
} as const;

/**
 * Which of the two browser stores. The nonce and the invite hand-off live in
 * `session` (one tab, until it closes); everything else in `local`.
 */
export type StorageArea = "local" | "session";

/** The store, or null anywhere it cannot be reached (server render, blocked site data). */
function store(area: StorageArea): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return area === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

/** Read a key; null when it is unset or storage cannot be reached. */
export function readStored(key: string, area: StorageArea = "local"): string | null {
  const s = store(area);
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/** Write a key. */
export function writeStored(key: string, value: string, area: StorageArea = "local"): void {
  const s = store(area);
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* quota or private mode — the caller's feature degrades, it does not crash */
  }
}

/** Remove a key. */
export function removeStored(key: string, area: StorageArea = "local"): void {
  const s = store(area);
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* nothing to do: there is no storage to clear */
  }
}

/**
 * THE WORKSPACE THIS TAB IS IN. Each tab keeps its own (sessionStorage), so two tabs can sit on two workspaces; the
 * last one chosen anywhere (localStorage) is only the default a NEW tab starts from. It used to be localStorage alone,
 * shared by every tab: switching in one tab silently moved the other's requests to the new workspace.
 */
export function readActiveOrg(): string | null {
  return readStored(STORAGE_KEYS.activeOrg, "session") ?? readStored(STORAGE_KEYS.activeOrg);
}

/** Choose this tab's workspace, and make it the default for tabs opened from now on. */
export function writeActiveOrg(orgId: string | null): void {
  if (orgId) {
    writeStored(STORAGE_KEYS.activeOrg, orgId, "session");
    writeStored(STORAGE_KEYS.activeOrg, orgId);
  } else {
    removeStored(STORAGE_KEYS.activeOrg, "session");
    removeStored(STORAGE_KEYS.activeOrg);
  }
}
