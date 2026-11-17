/**
 * A record's breadcrumb parent (mold_v0-318): the record a record of an area without a sidebar entry of its own is reached
 * from. A customer's record page crumbs through it: <group> › <parent's entry> › <its sub-tab> › <parent record> › <record>,
 * never "<Area> / <record>" linking to a list the sidebar does not show.
 *
 * Declared: an area's `detail.parent`, a single required-or-not reference field of the area to another workspace area
 * (checked across the build: crumbParentProblems, run by src/metric-spec.ts checkViews, so gen-packs and the server's
 * install refuse the same). Left out: for an area no tab shows, the first required single reference whose target area a
 * tab shows (a sidebar entry or a sections tab's sub-tab), else the first whose target itself has a parent that leads
 * there (at most CRUMB_HOPS hops in all). An area a tab shows has none unless it declares one.
 *
 * Pure: the server (src/record-areas.ts detailFor: the parents' keys and titles, as the person reads them) and the tests
 * (scripts/record-crumbs-test.ts) read it alike.
 */

/** At most this many parent records in a trail (tenant › environment › application). */
export const CRUMB_HOPS = 3;

export interface CrumbField { name: string; type?: string; to?: string; required?: boolean; multiple?: boolean; encrypted?: boolean }
export interface CrumbArea { pack?: string; name: string; scope?: string; fields: readonly CrumbField[]; detail?: { parent?: string } | null }
export interface CrumbTab { kind?: string; area?: string; areas?: readonly { area: string }[] }
export interface CrumbHop { field: string; area: string }

/** The areas some tab of the build lists (an area tab's area, a merged tab's areas): each has a place in the sidebar. */
export const tabShownAreas = (tabs: readonly CrumbTab[]): Set<string> =>
  new Set(tabs.filter((t) => t.kind === "area").flatMap((t) => [t.area, ...(t.areas ?? []).map((a) => a.area)]).filter((a): a is string => !!a));

const isSingleRef = (f: CrumbField | undefined): f is CrumbField & { to: string } => !!f && f.type === "reference" && !!f.to && !f.multiple && !f.encrypted;

/** What is wrong with an area's declared `detail.parent` across the build (none when it declares none). */
export function crumbParentProblems(areas: readonly CrumbArea[]): string[] {
  const out: string[] = [];
  for (const a of areas) {
    const p = a.detail?.parent;
    if (p === undefined) continue;
    const at = (what: string) => out.push(`${a.pack ? `pack ${a.pack}: ` : ""}record area ${a.name}'s page: parent ${p}: ${what}`);
    const f = a.fields.find((x) => x.name === p);
    if (!f) { at(`not one of the area's fields`); continue; }
    if (f.type !== "reference" || !f.to) { at(`a ${f.type ?? "text"} field: the breadcrumb's parent is a reference field to another area`); continue; }
    if (f.multiple) { at(`a list of references: the breadcrumb's parent is a single reference (one record)`); continue; }
    if (f.encrypted) { at(`encrypted: the breadcrumb names the parent record, so its key is read`); continue; }
    if (f.to === a.name) { at(`refers to ${a.name} itself: the parent is a record of another area`); continue; }
    const t = areas.find((x) => x.name === f.to);
    if (!t) { at(`refers to ${f.to}, which is not a record area of this build`); continue; }
    if ((a.scope ?? "workspace") !== "workspace" || (t.scope ?? "workspace") !== "workspace") at(`${a.scope === "platform" ? a.name : f.to} is a shared (platform) area: a parent is a workspace area's record, crumbed in the customer console`);
  }
  return out;
}

/**
 * The trail's parents of a record of `name`, nearest first (field of the record before, area it names): empty when the
 * area has none. Every hop's area is a workspace area; the last one's a tab shows, unless a declared parent ends the
 * chain somewhere else. Never a cycle, never more than CRUMB_HOPS.
 */
export function crumbChain(name: string, areas: readonly CrumbArea[], shown: ReadonlySet<string>): CrumbHop[] {
  const byName = new Map(areas.map((a) => [a.name, a]));
  const workspace = (n: string) => (byName.get(n)?.scope ?? "workspace") === "workspace" && byName.has(n);
  /** The parent hop of area `n` (declared, else the fallback), its chain from there kept under `left` hops, never through `seen`. */
  const parentOf = (n: string, left: number, seen: ReadonlySet<string>): CrumbHop | null => {
    const a = byName.get(n);
    if (!a || left <= 0 || !workspace(n)) return null;
    const declared = a.detail?.parent;
    if (declared !== undefined) {
      const f = a.fields.find((x) => x.name === declared);
      return isSingleRef(f) && f.to !== n && workspace(f.to) && !seen.has(f.to) ? { field: f.name, area: f.to } : null;
    }
    if (shown.has(n)) return null;
    const refs = a.fields.filter((f): f is CrumbField & { to: string } => isSingleRef(f) && f.required === true && f.to !== n && workspace(f.to) && !seen.has(f.to));
    const direct = refs.find((f) => shown.has(f.to));
    if (direct) return { field: direct.name, area: direct.to };
    // Through a parent that has its own way to a shown area (tenant › environment › application).
    for (const f of refs) if (reaches(f.to, left - 1, new Set([...seen, f.to]))) return { field: f.name, area: f.to };
    return null;
  };
  /** Whether area `n`'s chain ends at an area a tab shows, within `left` hops. */
  const reaches = (n: string, left: number, seen: ReadonlySet<string>): boolean => {
    const p = parentOf(n, left, seen);
    if (!p) return false;
    return shown.has(p.area) || reaches(p.area, left - 1, new Set([...seen, p.area]));
  };
  const out: CrumbHop[] = [];
  const seen = new Set([name]);
  let cur = name;
  while (out.length < CRUMB_HOPS) {
    const p = parentOf(cur, CRUMB_HOPS - out.length, seen);
    if (!p) break;
    out.push(p);
    seen.add(p.area);
    cur = p.area;
    // A shown area ends the trail, unless it declares a parent of its own.
    if (shown.has(cur) && byName.get(cur)?.detail?.parent === undefined) break;
  }
  return out;
}
