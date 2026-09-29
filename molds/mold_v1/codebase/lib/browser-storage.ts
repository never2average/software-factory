/**
 * The keys this app keeps in a person's browser — and the ADDITIVE rename that
 * moved them off the base product's role name without signing anybody out.
 *
 * Every one of these used to start with `fde-`: the base product's role word,
 * baked into the storage of an application that is stamped for a vertical which
 * has never heard of it. `check:vocabulary` already forbids that word in text a
 * person reads and PR #46 removed it from every published package; a key in
 * localStorage is the same leak one layer further in, and the one with teeth —
 * `fde-google-token` IS the signed-in session.
 *
 * WHY THIS IS NOT A RENAME. Swapping the string would have logged out every
 * analyst with an open tab, reset their workspace, blanked their chat sidebar
 * and flashed the wrong theme, all at once, on a deploy nobody announced. So:
 *   - READ the new key, fall back to the old one;
 *   - WRITE the new key only, and leave the old value where it is, so a tab
 *     still running yesterday's bundle keeps reading a value it understands;
 *   - REMOVE both, always. A sign-out that cleared only the new key would leave
 *     a live token under the old one and the very next load would "restore" the
 *     session the person just ended. That is the one asymmetry here, and it is
 *     deliberate.
 *
 * The old keys can be deleted in one edit — this file — once no tab can still
 * be running a bundle that wrote them (a token lasts ~1h; a theme, forever).
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
} as const;

/**
 * Keys introduced AFTER the fde- → workspace- rename. They never had an old
 * spelling, so they are exempt from the "every key has a legacy spelling" rule
 * (scripts/test-wire-names.mjs) — by being listed here, not by the rule relaxing.
 */
export const STORAGE_KEYS_SINCE_RENAME: ReadonlySet<string> = new Set([
  STORAGE_KEYS.chatPending,
  STORAGE_KEYS.chatOwed,
  STORAGE_KEYS.desktopNotifications,
  STORAGE_KEYS.lastChat,
]);

/**
 * new key -> the key that held the same value before the rename.
 *
 * This is the whole compatibility surface. Nothing else in the app may spell an
 * `fde-` key, and scripts/check-wire-names.mjs fails the build if it does —
 * with this table as the only allowance.
 */
export const LEGACY_STORAGE_KEYS: Readonly<Record<string, string>> = {
  [STORAGE_KEYS.token]: "fde-google-token",
  [STORAGE_KEYS.nonce]: "fde-google-nonce",
  [STORAGE_KEYS.activeOrg]: "fde-active-org",
  [STORAGE_KEYS.theme]: "fde-theme",
  [STORAGE_KEYS.inviteResult]: "fde-invite-result",
  [STORAGE_KEYS.dismissedInputs]: "fde-dismissed-inputs",
  [STORAGE_KEYS.chats]: "fde-chats",
};

/**
 * The old spelling of `key`, or null when it has none.
 *
 * `workspace-chats:someone@x.com:org-y` is a composed key, not a fixed one, so
 * the prefix is matched as well as the whole string — a person whose sidebar
 * was written under the old prefix must still find it.
 */
export function legacyKeyFor(key: string): string | null {
  const exact = LEGACY_STORAGE_KEYS[key];
  if (exact) return exact;
  const prefix = `${STORAGE_KEYS.chats}:`;
  if (key.startsWith(prefix)) return `${LEGACY_STORAGE_KEYS[STORAGE_KEYS.chats]}:${key.slice(prefix.length)}`;
  return null;
}

/**
 * Which of the two browser stores. The nonce and the invite hand-off live in
 * `session` (one tab, until it closes); everything else in `local`. Both get the
 * same fallback: a value written by the old bundle is still read after a reload
 * that swaps the bundle underneath the same tab, which is exactly when an invite
 * result would otherwise vanish between the redirect and the render.
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

/** Read the new key; fall back to the value written under the old one. */
export function readStored(key: string, area: StorageArea = "local"): string | null {
  const s = store(area);
  if (!s) return null;
  try {
    const current = s.getItem(key);
    if (current !== null) return current;
    const legacy = legacyKeyFor(key);
    return legacy ? s.getItem(legacy) : null;
  } catch {
    return null;
  }
}

/** Write the new key only. The old value stays put for a tab on the old bundle. */
export function writeStored(key: string, value: string, area: StorageArea = "local"): void {
  const s = store(area);
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* quota or private mode — the caller's feature degrades, it does not crash */
  }
}

/**
 * Remove BOTH spellings. Signing out has to mean signed out: clearing only the
 * new key leaves a valid token under the old one for `readStored` to find.
 */
export function removeStored(key: string, area: StorageArea = "local"): void {
  const s = store(area);
  if (!s) return;
  try {
    s.removeItem(key);
    const legacy = legacyKeyFor(key);
    if (legacy) s.removeItem(legacy);
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
