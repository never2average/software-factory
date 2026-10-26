/**
 * Which of the shell's own pages the customer console shows (mold_v0-130). Pure, no imports, so scripts/gen-packs.mjs
 * (node strips the types) and the tests run the same rules.
 *
 *   "console": { "hide": ["activity"] }     in a pack's pack.json, or in the app's profile.json
 *
 * Each id names one of the shell's customer pages (CONSOLE_PAGES); a hidden page leaves the /app sidebar (the shell's own
 * entries, the Workspace and Activity groups, and any declared tab that opens it), the Cmd+K bar and the customer guide's
 * list of tabs, and its address (and every address under it) redirects to the console's home, /app. What the packs and
 * the profile hide is joined: a page is shown unless one of them hides it. The staff console (/admin) is never changed,
 * nor the API behind a page (an MCP client or a script reads the same data as before).
 * The home page itself (Setup & training, /app) is never hidden: the redirects land there (or on the tab that includes
 * its checklist, mold_v0-134, where /app itself leads).
 *
 * The whole /app sidebar from the app's profile (mold_v0-133), profile.json only (a pack orders its own tabs):
 *
 *   "console": { "sidebar": [{ "label": "Home", "items": ["overview"] }, { "label": "Company", "items": ["billing", "team"] }] }
 *
 * Each group in order, each item a pack's tab by its id (or `<pack>/<id>` when two packs have that id) or one of the
 * shell's pages by its kind (SIDEBAR_SHELL_PAGES). scripts/gen-packs.mjs resolves it: then the sidebar is exactly that,
 * every tab of the packs is in it once, and a shell page the build lacks or hides is refused.
 */

/** The shell's customer pages a build may hide: id -> the page's address. */
export const CONSOLE_PAGES = {
  activity: "/app/activity",
  usage: "/app/usage",
  billing: "/app/billing",
  profile: "/app/profile",
  credentials: "/app/credentials",
  schedules: "/app/schedules",
  notices: "/app/notices",
  files: "/app/files",
  // Each person's connected apps (mold_v0-087): the AI apps signed in to /mcp, with Revoke (built-in sign-in), or where
  // the sign-in provider keeps them (Clerk).
  "connected-apps": "/app/connected-apps",
} as const;
export type ConsolePage = keyof typeof CONSOLE_PAGES;

/** A declared tab's kind -> the shell page it opens (mold_v0-058: a `usage` tab opens the Activity page). */
export const TAB_KIND_PAGE: Record<string, ConsolePage> = {
  usage: "activity", billing: "billing", profile: "profile", credentials: "credentials", schedules: "schedules", notices: "notices", files: "files",
};

/**
 * What a pack's pack.json `console` may say besides `hide` (mold_v0-140; src/pack-manifest.ts checks their shape,
 * scripts/gen-packs.mjs what they name):
 *   nav         a host pack's sidebar entries among the shell's, in /app and /admin: {"app": [...], "admin": [...]}, each
 *               a new group {"label", "before"|"after": <a group's label>, "items"} or entries put into a group
 *               {"into": <its label>, "before"|"after": <an entry's url>, "items"}; an item {title, url, icon, shortcut?}
 *               names one of the pack's own console pages (its routes.json)
 *   components  the shell's console components a host pack's routes serve, shown only then (CONSOLE_COMPONENTS)
 *   redirects   old addresses kept working: [{source, destination, permanent}] (next.config redirects)
 */
export const PACK_CONSOLE_KEYS = ["nav", "components", "redirects"] as const;
/**
 * The shell's console components that read a host pack's own routes (mold_v0-140; they were its nav.ts `features`):
 *   tips      in-chat tips: the Setup page's tips section and "Send a tip" on /admin accounts (its /api/app/nudges and admin tips routes)
 *   journeys  the Setup page's journeys: their picker and each journey's stages (its /api/app/journeys)
 *   research  a requester's company research on /admin access requests (its research routes and verdict)
 */
export const CONSOLE_COMPONENTS = ["tips", "journeys", "research"] as const;
/** The shell pages a sidebar may name by kind (mold_v0-133; a tab of that kind opens the same page). */
export const SIDEBAR_SHELL_PAGES = ["setup", "usage", "billing", "profile", "team", "keys", "credentials", "schedules", "notices", "connected-apps"] as const;

/** The page a sidebar's shell entry opens, as console.hide names it (null: one no build may hide, such as setup). */
export const sidebarShellPage = (id: string): ConsolePage | null =>
  Object.hasOwn(TAB_KIND_PAGE, id) ? TAB_KIND_PAGE[id]! : Object.hasOwn(CONSOLE_PAGES, id) ? (id as ConsolePage) : null;

/** The problems of one `console` block (where: "pack.json" or "profile.json"); [] when it is good. */
export function consoleProblems(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${where} console: an object, e.g. {"hide": ["activity"]}`];
  const out: string[] = [];
  const known = where === "profile.json" ? ["hide", "sidebar"] : ["hide", ...PACK_CONSOLE_KEYS];
  for (const k of Object.keys(v)) {
    if (k === "sidebar" && where !== "profile.json") out.push(`${where} console: sidebar is the app's (profile.json); a pack orders its own tabs (tabs, group)`);
    else if ((PACK_CONSOLE_KEYS as readonly string[]).includes(k) && where === "profile.json") out.push(`${where} console: ${k} is a pack's (its pack.json console.${k}), never the app's profile`);
    else if (!known.includes(k) && k !== "$comment") out.push(`${where} console: unknown field ${k} (known: ${known.join(", ")})`);
  }
  const sidebar = (v as { sidebar?: unknown }).sidebar;
  if (sidebar !== undefined && where === "profile.json") out.push(...sidebarProblems(sidebar, where));
  const hide = (v as { hide?: unknown }).hide;
  if (hide !== undefined) {
    if (!Array.isArray(hide)) out.push(`${where} console.hide: a list of page ids (${Object.keys(CONSOLE_PAGES).join(", ")})`);
    else {
      for (const x of hide) if (typeof x !== "string" || !(x in CONSOLE_PAGES)) out.push(`${where} console.hide: ${JSON.stringify(x).slice(0, 60)} is not a page the console may hide (${Object.keys(CONSOLE_PAGES).join(", ")})`);
      if (new Set(hide).size !== hide.length) out.push(`${where} console.hide: each page once`);
    }
  }
  return out;
}

/** The shape of a profile's `console.sidebar` (what it names is resolved against the build by gen-packs). */
function sidebarProblems(v: unknown, where: string): string[] {
  const at = `${where} console.sidebar`;
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) return [`${at}: a list of 1 to 12 groups, each {"label": "...", "items": ["<tab id or shell page>", ...]}`];
  const out: string[] = [];
  const ITEM = /^([a-z][a-z0-9_]{0,40}\/)?[a-z][a-z0-9-]{0,40}$/;
  v.forEach((g, i) => {
    if (!g || typeof g !== "object" || Array.isArray(g)) { out.push(`${at}[${i}]: a group {"label", "items"}`); return; }
    for (const k of Object.keys(g)) if (k !== "label" && k !== "items" && k !== "$comment") out.push(`${at}[${i}]: unknown field ${k} (known: label, items)`);
    const { label, items } = g as { label?: unknown; items?: unknown };
    if (typeof label !== "string" || label.length > 40 || /[{}<>]/.test(label) || label !== label.trim()) out.push(`${at}[${i}].label: the group's heading, up to 40 characters ("" for none), no braces or angle brackets`);
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) out.push(`${at}[${i}].items: a list of 1 to 20 entries`);
    else for (const [j, x] of items.entries()) if (typeof x !== "string" || !ITEM.test(x)) out.push(`${at}[${i}].items[${j}]: a tab id, <pack>/<tab id>, or a shell page (${SIDEBAR_SHELL_PAGES.join(", ")})`);
  });
  return out;
}

/** The pages hidden by a set of `console` blocks (checked first), in CONSOLE_PAGES order. */
export function hiddenPages(blocks: unknown[]): ConsolePage[] {
  const hidden = new Set<string>();
  for (const b of blocks) for (const x of ((b as { hide?: unknown[] } | undefined)?.hide ?? [])) if (typeof x === "string") hidden.add(x);
  return (Object.keys(CONSOLE_PAGES) as ConsolePage[]).filter((k) => hidden.has(k));
}

/** Is this console address one of the hidden pages, or under one? */
export const isHiddenUrl = (url: string, hidden: readonly ConsolePage[]) => {
  const p = url.split(/[?#]/)[0]!;
  return hidden.some((h) => p === CONSOLE_PAGES[h] || p.startsWith(`${CONSOLE_PAGES[h]}/`));
};

/**
 * The console's redirects for the hidden pages: each address, and every address under it, to the home page (/app, or
 * the tab that includes the Setup page's checklist, mold_v0-134, so a redirect takes one hop).
 */
export const hiddenRedirects = (hidden: readonly ConsolePage[], home = "/app") =>
  hidden.flatMap((h) => [CONSOLE_PAGES[h], `${CONSOLE_PAGES[h]}/:path*`].map((source) => ({ source, destination: home, permanent: false })));
