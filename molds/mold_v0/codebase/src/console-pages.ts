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
 * The home page itself (Setup & training, /app) is never hidden: the redirects land there.
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
} as const;
export type ConsolePage = keyof typeof CONSOLE_PAGES;

/** A declared tab's kind -> the shell page it opens (mold_v0-058: a `usage` tab opens the Activity page). */
export const TAB_KIND_PAGE: Record<string, ConsolePage> = {
  usage: "activity", billing: "billing", profile: "profile", credentials: "credentials", schedules: "schedules", notices: "notices", files: "files",
};

/** The problems of one `console` block (where: "pack.json" or "profile.json"); [] when it is good. */
export function consoleProblems(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${where} console: an object, e.g. {"hide": ["activity"]}`];
  const out: string[] = [];
  for (const k of Object.keys(v)) if (k !== "hide" && k !== "$comment") out.push(`${where} console: unknown field ${k} (known: hide)`);
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

/** The console's redirects for the hidden pages: each address, and every address under it, to the home page. */
export const hiddenRedirects = (hidden: readonly ConsolePage[]) =>
  hidden.flatMap((h) => [CONSOLE_PAGES[h], `${CONSOLE_PAGES[h]}/:path*`].map((source) => ({ source, destination: "/app", permanent: false })));
