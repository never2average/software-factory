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
  // Settings › Credentials (mold_v0-218): an in-page tab of /app/settings since its own page went. Hidden, the tab
  // leaves Settings (and Settings the sidebar when it has no Email tab either); there is no old address to redirect.
  credentials: "/app/settings?tab=credentials",
  schedules: "/app/schedules",
  notices: "/app/notices",
  files: "/app/files",
  // Each person's connected apps (mold_v0-087): the AI apps signed in to /mcp, with Revoke (built-in sign-in), or where
  // the sign-in provider keeps them (Clerk).
  "connected-apps": "/app/connected-apps",
  // Each person's own API keys (mold_v0-007; the sidebar's footer link): hidden (mold_v0-171), the link and the page go;
  // the keys made before keep working (the API is never changed). profile.json member_keys false turns the keys off.
  keys: "/app/keys",
  // The workspace agent (mold_v0-243; a page only while agent_harness is on): a pack's `agent` tab puts it in the sidebar.
  agent: "/app/agent",
} as const;
export type ConsolePage = keyof typeof CONSOLE_PAGES;

/** A declared tab's kind -> the shell page it opens (mold_v0-058: a `usage` tab opens the Activity page). */
export const TAB_KIND_PAGE: Record<string, ConsolePage> = {
  usage: "activity", billing: "billing", profile: "profile", credentials: "credentials", schedules: "schedules", notices: "notices", files: "files", keys: "keys", agent: "agent",
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
 *   research  a requester's company research on /admin access requests (its research routes and verdict)
 * The in-chat tips and the journeys were two more until they became the shell's own components (mold_v0-143: pack.json
 * `tips` and `journeys` turn them on; src/tips.ts, src/journeys.ts, web/src/features/journeys).
 */
export const CONSOLE_COMPONENTS = ["research"] as const;
/** The shell pages a sidebar may name by kind (mold_v0-133; a tab of that kind opens the same page). */
export const SIDEBAR_SHELL_PAGES = ["setup", "usage", "billing", "profile", "team", "keys", "credentials", "schedules", "notices", "connected-apps"] as const;

/** The page a sidebar's shell entry opens, as console.hide names it (null: one no build may hide, such as setup). */
export const sidebarShellPage = (id: string): ConsolePage | null =>
  Object.hasOwn(TAB_KIND_PAGE, id) ? TAB_KIND_PAGE[id]! : Object.hasOwn(CONSOLE_PAGES, id) ? (id as ConsolePage) : null;

/**
 * The shell's console sections that appear once they hold something, which a build may show from the start (mold_v0-171):
 *
 *   "console": { "show": ["experiments"] }     in a pack's pack.json, or in the app's profile.json (joined, as hide)
 *
 *   experiments  Operations › FinOps › Experiments (/admin/finops?section=experiments): the pricing experiments, shown
 *                with its empty state (how to start one) before the first exists; without it the tab appears with the
 *                first experiment (or when a link opens it). The admin MCP's pricing_experiment skill is offered either way.
 */
export const SHOWABLE_SECTIONS = ["experiments"] as const;
export type ShowableSection = (typeof SHOWABLE_SECTIONS)[number];

/** The sections shown from the start by a set of `console` blocks (checked first), in SHOWABLE_SECTIONS order. */
export function shownSections(blocks: unknown[]): ShowableSection[] {
  const shown = new Set<string>();
  for (const b of blocks) for (const x of ((b as { show?: unknown[] } | undefined)?.show ?? [])) if (typeof x === "string") shown.add(x);
  return SHOWABLE_SECTIONS.filter((k) => shown.has(k));
}

/**
 * The staff sidebar's Records group (mold_v0-271), in a pack's pack.json or the app's profile.json (the profile's wins;
 * two packs may not both say it):
 *
 *   "console": { "admin_records": { "show": ["recipes", "journeys", "design_systems", { "id": "molds", "label": "Molds" }] } }
 *
 * `show` is the whole group, in its order: a shared (platform-scope) record area by its name, or one of the shell's staff
 * pages by its id (ADMIN_RECORDS_PAGES), each optionally with its own sidebar label ({"id", "label"}). A shared area left
 * out is not in the sidebar but its page, its API and its MCP tools are as before (a link still opens it); a shell page
 * listed leaves its own group for this one, at the same address. scripts/gen-packs.mjs resolves the names.
 *
 * mold_v0-281: an entry may hold 2 to 6 of those lists as in-page tabs, one sidebar entry for them all:
 *
 *   { "id": "library", "label": "Library", "tabs": ["design_systems", { "id": "recipes", "label": "Recipes" }] }
 *
 * Its page is /admin/records-group/<id>?tab=<member>; each member's own address of before leads there (a record's own
 * page, /admin/records/<area>/<key>, stays where it is). A member is named once in the whole group (never twice, never
 * in two entries); the entry's id names no shared area and no staff page.
 */
export const ADMIN_RECORDS_PAGES = ["journeys", "recipes", "agent-profiles", "repositories"] as const;
export type AdminRecordsPage = (typeof ADMIN_RECORDS_PAGES)[number];
export interface AdminRecordsMember { id: string; label?: string }
export interface AdminRecordsEntry { id: string; label?: string; tabs?: AdminRecordsMember[] }
const memberOf = (x: unknown): AdminRecordsMember => (typeof x === "string" ? { id: x }
  : { id: String((x as AdminRecordsMember).id), ...((x as AdminRecordsMember).label ? { label: (x as AdminRecordsMember).label } : {}) });
/** The entries of an admin_records block whose shape is good: each as {id, label?, tabs?}. */
export const adminRecordsEntries = (v: unknown): AdminRecordsEntry[] =>
  (((v as { show?: unknown[] } | undefined)?.show ?? []) as unknown[]).map((x) => {
    const tabs = x && typeof x === "object" ? (x as { tabs?: unknown }).tabs : undefined;
    return { ...memberOf(x), ...(Array.isArray(tabs) ? { tabs: tabs.map(memberOf) } : {}) };
  });
/** Every list the group names, by id: a plain entry's, and each in-page tab of an entry that holds several (mold_v0-281). */
export const adminRecordsMembers = (entries: readonly AdminRecordsEntry[]): string[] => entries.flatMap((e) => (e.tabs ? e.tabs.map((t) => t.id) : [e.id]));
const ADMIN_RECORDS_ID = /^[a-z][a-z0-9_-]{0,63}$/;
export const ADMIN_RECORDS_TABS = { min: 2, max: 6 } as const;
/** The shape of an `admin_records` block (what it names is resolved against the build by gen-packs). */
export function adminRecordsProblems(v: unknown, where: string): string[] {
  const at = `${where} console.admin_records`;
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at}: an object {"show": ["<shared area or staff page>", ...]}`];
  const out: string[] = [];
  for (const k of Object.keys(v)) if (k !== "show" && k !== "$comment") out.push(`${at}: unknown field ${k} (known: show)`);
  const show = (v as { show?: unknown }).show;
  if (!Array.isArray(show) || show.length < 1 || show.length > 30) return [...out, `${at}.show: a list of 1 to 30 entries, each a shared record area's name or a staff page (${ADMIN_RECORDS_PAGES.join(", ")})`];
  const seen = new Map<string, string>();
  const badLabel = (label: unknown) => label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 40 || label !== label.trim() || /[{}<>]/.test(label));
  /** One list (a plain entry or an in-page tab): its id and label; false when its id is unusable. */
  const one = (x: unknown, w: string, fields: string[]): unknown => {
    let id: unknown = x;
    if (x && typeof x === "object" && !Array.isArray(x)) {
      for (const k of Object.keys(x)) if (!fields.includes(k)) out.push(`${w}: unknown field ${k} (known: ${fields.join(", ")})`);
      id = (x as { id?: unknown }).id;
      if (badLabel((x as { label?: unknown }).label)) out.push(`${w}.label: the entry's label in the sidebar, 1 to 40 characters, no braces or angle brackets`);
    }
    if (typeof id !== "string" || !ADMIN_RECORDS_ID.test(id)) { out.push(`${w}: a shared record area's name or a staff page (${ADMIN_RECORDS_PAGES.join(", ")}), or {"id", "label"}`); return false; }
    return id;
  };
  const claim = (id: string, w: string, as: string) => {
    const before = seen.get(id);
    if (before) out.push(`${w}: ${id} is listed twice (${before} and ${as}): each list once, in one entry`);
    else seen.set(id, as);
  };
  show.forEach((x, i) => {
    const w = `${at}.show[${i}]`;
    const tabs = x && typeof x === "object" && !Array.isArray(x) ? (x as { tabs?: unknown }).tabs : undefined;
    if (tabs === undefined) {
      const id = one(x, w, ["id", "label"]);
      if (typeof id === "string") claim(id, w, `show[${i}]`);
      return;
    }
    // mold_v0-281: an entry of in-page tabs: its own id and label, and 2 to 6 lists.
    const id = one(x, w, ["id", "label", "tabs"]);
    if (typeof id === "string") {
      if (typeof (x as { label?: unknown }).label !== "string") out.push(`${w}.label: an entry of in-page tabs has its own label in the sidebar`);
      if ((ADMIN_RECORDS_PAGES as readonly string[]).includes(id)) out.push(`${w}: ${id} is a staff page: an entry of in-page tabs has an id of its own`);
      claim(id, w, `show[${i}]`);
    }
    if (!Array.isArray(tabs) || tabs.length < ADMIN_RECORDS_TABS.min || tabs.length > ADMIN_RECORDS_TABS.max) {
      out.push(`${w}.tabs: ${ADMIN_RECORDS_TABS.min} to ${ADMIN_RECORDS_TABS.max} lists shown as in-page tabs, each a shared record area's name or a staff page, or {"id", "label"} (one list is a plain entry)`);
      return;
    }
    tabs.forEach((t, j) => {
      const tw = `${w}.tabs[${j}]`;
      const tid = one(t, tw, ["id", "label"]);
      if (typeof tid === "string") claim(tid, tw, `show[${i}].tabs[${j}]`);
    });
  });
  return out;
}

/** The problems of one `console` block (where: "pack.json" or "profile.json"); [] when it is good. */
export function consoleProblems(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${where} console: an object, e.g. {"hide": ["activity"]}`];
  const out: string[] = [];
  const known = where === "profile.json" ? ["hide", "show", "sidebar", "admin_records"] : ["hide", "show", "admin_records", ...PACK_CONSOLE_KEYS];
  for (const k of Object.keys(v)) {
    if (k === "sidebar" && where !== "profile.json") out.push(`${where} console: sidebar is the app's (profile.json); a pack orders its own tabs (tabs, group)`);
    else if ((PACK_CONSOLE_KEYS as readonly string[]).includes(k) && where === "profile.json") out.push(`${where} console: ${k} is a pack's (its pack.json console.${k}), never the app's profile`);
    else if (!known.includes(k) && k !== "$comment") out.push(`${where} console: unknown field ${k} (known: ${known.join(", ")})`);
  }
  const sidebar = (v as { sidebar?: unknown }).sidebar;
  if (sidebar !== undefined && where === "profile.json") out.push(...sidebarProblems(sidebar, where));
  const records = (v as { admin_records?: unknown }).admin_records;
  if (records !== undefined) out.push(...adminRecordsProblems(records, where));
  const hide = (v as { hide?: unknown }).hide;
  if (hide !== undefined) {
    if (!Array.isArray(hide)) out.push(`${where} console.hide: a list of page ids (${Object.keys(CONSOLE_PAGES).join(", ")})`);
    else {
      for (const x of hide) if (typeof x !== "string" || !(x in CONSOLE_PAGES)) out.push(`${where} console.hide: ${JSON.stringify(x).slice(0, 60)} is not a page the console may hide (${Object.keys(CONSOLE_PAGES).join(", ")})`);
      if (new Set(hide).size !== hide.length) out.push(`${where} console.hide: each page once`);
    }
  }
  const show = (v as { show?: unknown }).show;
  if (show !== undefined) {
    if (!Array.isArray(show)) out.push(`${where} console.show: a list of section ids (${SHOWABLE_SECTIONS.join(", ")})`);
    else {
      for (const x of show) if (typeof x !== "string" || !(SHOWABLE_SECTIONS as readonly string[]).includes(x)) out.push(`${where} console.show: ${JSON.stringify(x).slice(0, 60)} is not a section the console may show from the start (${SHOWABLE_SECTIONS.join(", ")})`);
      if (new Set(show).size !== show.length) out.push(`${where} console.show: each section once`);
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
  // An in-page tab (a page's ?tab=, mold_v0-218: Settings › Credentials) is that address exactly.
  return hidden.some((h) => CONSOLE_PAGES[h].includes("?") ? url === CONSOLE_PAGES[h] : p === CONSOLE_PAGES[h] || p.startsWith(`${CONSOLE_PAGES[h]}/`));
};

/**
 * The console's redirects for the hidden pages: each address, and every address under it, to the home page (/app, or
 * the tab that includes the Setup page's checklist, mold_v0-134, so a redirect takes one hop).
 */
export const hiddenRedirects = (hidden: readonly ConsolePage[], home = "/app") =>
  // An in-page tab (mold_v0-218) has no address of its own to redirect: its page simply leaves it out.
  hidden.filter((h) => !CONSOLE_PAGES[h].includes("?")).flatMap((h) => [CONSOLE_PAGES[h], `${CONSOLE_PAGES[h]}/:path*`].map((source) => ({ source, destination: home, permanent: false })));
