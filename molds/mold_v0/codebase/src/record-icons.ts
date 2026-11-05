/**
 * Each record area's icon (mold_v0-242): the one icon an area shows wherever it appears, its entry in the staff console's
 * Records group, its entry in the customer console's Records group and its spec (web/src/config/pack-nav.generated.ts
 * recordAreas). Pure, no imports, so scripts/gen-packs.mjs loads it as it is and the tests call it alone.
 *
 * An area's icon is, in order:
 *   1. its own `icon` (pack.json record_areas[].icon, one of src/pack-api.ts TAB_ICONS);
 *   2. the icon of the customer tab that shows it: the sidebar entry of the first tab over the area (its own tab, else
 *      the sections tab it is an in-page tab of; a tab over the area alone before one that merges several), when that
 *      entry declares an icon no other area has taken;
 *   3. one of RECORD_FALLBACK_ICONS, chosen from the area's name (a hash, so adding an area elsewhere does not move it),
 *      the first after that no area has taken and no other staff sidebar entry shows; then, with none left, one no area
 *      has taken; then the hashed one.
 * Steps 2 and 3 go through the shared (platform) areas first, then the workspace's own, so the staff sidebar's entries
 * choose first. No two areas end up with one icon unless two declare it (they keep it: gen-packs warns,
 * recordIconDuplicates) or the areas outnumber the fallback list.
 */
export interface RecordIconArea {
  name: string;
  /** platform (shared: the staff sidebar's Records entries, which choose first) or workspace. */
  scope?: string;
  /** Its own icon (pack.json record_areas[].icon), if any. */
  icon?: string | null;
}

/**
 * The icons an area falls back to, best first: each one of TAB_ICONS that reads as a list of things kept. Never one that
 * reads as an action, a state or a person (refresh, warning, account) or that names a shell page (settings, billing).
 */
export const RECORD_FALLBACK_ICONS = [
  "book", "post", "page", "forms", "kanban", "product", "workspace", "circleCheck", "check", "shield", "clock", "calendar",
  "media", "code", "route", "health", "search", "inbox", "building", "chartBar", "gauge", "plug",
] as const;

/** A stable small hash of an area's name (FNV-1a, 32 bits): where its search of the fallback list starts. */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Every area's icon, by area name (the order given is the build's: packs in order, each pack's areas in order).
 *   tabIcons    each area's customer tab icon (step 2), when a tab over it has a sidebar entry with an icon of its own
 *   staffIcons  the icons of the staff sidebar's other entries (the shell's, the host packs', the packs' pages): a
 *               fallback never repeats one
 *   avoidIcons  icons a fallback avoids too while it can (the customer sidebar's other entries)
 */
export function recordAreaIcons(areas: readonly RecordIconArea[], opts: {
  tabIcons?: Readonly<Record<string, string>>;
  staffIcons?: readonly string[];
  avoidIcons?: readonly string[];
  fallback?: readonly string[];
} = {}): Record<string, string> {
  const fallback = opts.fallback ?? RECORD_FALLBACK_ICONS;
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const a of areas) if (a.icon) { out[a.name] = a.icon; taken.add(a.icon); }
  const ordered = [...areas.filter((a) => a.scope === "platform"), ...areas.filter((a) => a.scope !== "platform")];
  for (const a of ordered) {
    if (out[a.name]) continue;
    const t = opts.tabIcons?.[a.name];
    if (t && !taken.has(t)) { out[a.name] = t; taken.add(t); }
  }
  const staff = new Set(opts.staffIcons ?? []);
  const avoid = new Set([...staff, ...(opts.avoidIcons ?? [])]);
  for (const a of ordered) {
    if (out[a.name] || !fallback.length) continue;
    const start = nameHash(a.name) % fallback.length;
    const ring = fallback.map((_x, i) => fallback[(start + i) % fallback.length]!);
    const pick = ring.find((x) => !taken.has(x) && !avoid.has(x)) ?? ring.find((x) => !taken.has(x) && !staff.has(x))
      ?? ring.find((x) => !taken.has(x)) ?? ring[0]!;
    out[a.name] = pick;
    taken.add(pick);
  }
  return out;
}

/** The explicit icons two or more areas declare, each with those areas (gen-packs warns of each). */
export function recordIconDuplicates(areas: readonly RecordIconArea[]): { icon: string; areas: string[] }[] {
  const by = new Map<string, string[]>();
  for (const a of areas) if (a.icon) by.set(a.icon, [...(by.get(a.icon) ?? []), a.name]);
  return [...by].filter(([, names]) => names.length > 1).map(([icon, names]) => ({ icon, areas: names }));
}
