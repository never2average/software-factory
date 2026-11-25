/**
 * A catalog tab whose services a workspace connects in place (mold_v0-344; pack.json `tabs[].connect`, src/pack-api.ts
 * TabConnectSchema; molds/mold_v0/MOLD.md "Connect a service where you find it"). Each service of the catalog is one row;
 * this module adds, as the person reading, this workspace's own state for it, worked out from its connection records:
 *
 *   connection_state    connected (a test worked), needs attention (one failed, could not be tested, needs its key, is
 *                       stale or expiring: connection health, src/connection-test-health.ts), not tested, not connected
 *   connection_flag     whether builds use one of its connections (the pack's `flag`)
 *   connection_tested   when one of them was last tested
 *   connect             whether the service may be connected here (`when`), and its connections as the person reads them
 *                       (a sealed field masked, as every read masks it), each with its health now
 *
 * A connection belongs to the service its `via` names; one saved without (before the tab had Connect) to the one service
 * whose `set` values it holds, when exactly one claims it; `others` lists the rest as rows of their own. Nothing is
 * written here and nothing crosses workspaces: the connections are the workspace's own list (src/record-areas.ts listFor,
 * the area's read permission for the person asking; a role that may not read them gets no state at all, never an
 * empty "not connected"). A write happens in the console through the connection area's own routes (the data API's create,
 * its page actions: test, edit, delete, toggles), with their permissions, contract, guards and audit.
 */
import { ACCOUNT_ROLE_LABELS, canAccount, type AccountRole } from "./account-roles.js";
import { healthOf } from "./connection-test-health.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { CONNECT_COLUMNS, conditionHolds, personSets, type RecordRow, type Tab, type TabConnect } from "./pack-api.js";
import { allowedRoles, areaOrThrow, listFor, may, type Actor, type RecordArea } from "./record-areas.js";
import { formOffers } from "./secret-binding.js";

/** The most connections of one area a tab reads for its rows (a workspace keeps a handful). */
export const CONNECTIONS_MAX = 1000;
export type ConnectState = "connected" | "needs_attention" | "not_tested" | "not_connected";
type Health = { state?: string | null; attention?: boolean; tested_at?: string };
export interface ConnectionView { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; health?: Health }
export type ConnectRow = RecordRow & { areas?: string[]; health?: Health; connect?: { connectable: boolean; connections: ConnectionView[] } | { hidden: true } };

const joined = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");

/** A service's state from its connections: any needing attention, else any working (or saved where nothing tests), else not tested. */
export function connectState(conns: readonly Pick<ConnectionView, "health">[], tested: boolean): ConnectState {
  if (!conns.length) return "not_connected";
  if (conns.some((c) => c.health?.attention)) return "needs_attention";
  if (!tested || conns.some((c) => c.health?.state === "working")) return "connected";
  return "not_tested";
}

/** The service keys a connection without `via` belongs to: the services whose `set` values it holds (explicit ones, never "*"). */
const claimants = (c: TabConnect, data: Record<string, unknown>) => Object.entries(c.services ?? {})
  .filter(([k, s]) => k !== "*" && s.set && Object.keys(s.set).length && Object.entries(s.set).every(([f, v]) => data[f] === v)).map(([k]) => k);

/** The service a connection is for: its via, else the one service that claims it, else null (one of `others`). */
export function serviceOf(c: TabConnect, data: Record<string, unknown>): string | null {
  const v = data[c.via];
  if (typeof v === "string" && v !== "") return v;
  const by = claimants(c, data);
  return by.length === 1 ? by[0]! : null;
}

/** Every connection of the area this person may read (the workspace's own, up to CONNECTIONS_MAX), or null when they may read none. */
async function connectionsOf(orgId: number, conn: RecordArea, actor: Actor): Promise<ConnectionView[] | null> {
  if (!may(conn, "read", actor) || areaOpWithheld(conn.name, "list")) return null;
  const out: ConnectionView[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listFor(orgId, conn.name, { limit: 200, ...(after ? { after } : {}) }, actor);
    for (const r of page.records as (RecordRow & { health?: Health })[]) out.push({ key: r.key, title: r.title, data: r.data, updated_at: r.updated_at, ...(r.health ? { health: r.health } : {}) });
    if (!page.next || out.length >= CONNECTIONS_MAX) return out.slice(0, CONNECTIONS_MAX);
    after = page.next;
  }
}

const latest = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/**
 * The catalog rows with this workspace's state for each (and, on the last page, `others`' rows: the connections no
 * service holds), as `actor` reads them.
 */
export async function withConnections(orgId: number, tab: Tab, rows: RecordRow[], actor: Actor, last: boolean): Promise<ConnectRow[]> {
  const c = tab.connect!;
  const conn = areaOrThrow(c.area);
  const all = await connectionsOf(orgId, conn, actor);
  if (!all) return rows.map((r) => ({ ...r, connect: { hidden: true as const } }));
  const tested = healthOf(conn as never) !== null;
  const by = new Map<string, ConnectionView[]>();
  for (const x of all) { const s = serviceOf(c, x.data); if (s !== null) by.set(s, [...(by.get(s) ?? []), x]); }
  const view = (own: ConnectionView[]) => ({
    [CONNECT_COLUMNS.state]: connectState(own, tested),
    ...(c.flag ? { [CONNECT_COLUMNS.flag]: own.some((x) => x.data[c.flag!] === true) } : {}),
    [CONNECT_COLUMNS.tested]: latest(own.map((x) => x.health?.tested_at)),
  });
  const out: ConnectRow[] = rows.map((r) => {
    const own = by.get(r.key) ?? [];
    return { ...r, data: { ...r.data, ...view(own) }, connect: { connectable: !c.when || conditionHolds(c.when, r.data), connections: own } };
  });
  if (c.others && last) {
    const listed = new Set(rows.map((r) => r.key));
    // A connection no service holds: its own row, opening its own record (a key a service row already has is not repeated).
    for (const x of all) if (serviceOf(c, x.data) === null && !listed.has(x.key))
      out.push({ area: conn.name, key: x.key, title: x.title, version: null, data: { ...x.data, ...view([x]) }, updated_at: x.updated_at, areas: [conn.name], ...(x.health ? { health: x.health } : {}) } as unknown as ConnectRow);
  }
  return out;
}

/**
 * What the Connect form needs, for this person: whether they may connect (the connection area's create: its roles, its
 * create not withheld, a role that edits), the fields it asks (the area's own form fields, a person's to set, as an edit
 * offers them: never one only actions set, nor an owners' opt-in to anyone else), the order (`fields` and the required
 * first, `more` under More options), the flag, the health fields an account shows, and who may connect when they may not.
 */
export async function connectSpec(tab: Tab, actor: Actor) {
  const c = tab.connect!;
  const conn = areaOrThrow(c.area);
  const role = actor.role;
  const readable = may(conn, "read", actor) && !areaOpWithheld(conn.name, "list");
  const allowed = readable && !areaOpWithheld(conn.name, "create") && (role === null || canAccount(role as AccountRole, "edit")) && may(conn, "create", actor);
  const { formField } = await import("./tab-actions.js");
  const fields = conn.fields.filter(personSets).filter(formOffers(conn, role)).filter((f) => f.name !== c.via && f.type !== "file").map(formField);
  const ask = [...new Set([...fields.filter((f) => f.required).map((f) => f.name), ...(c.fields ?? [])])].filter((n) => n !== c.flag && fields.some((f) => f.name === n));
  const more = [...new Set([...(c.more ?? []), ...fields.map((f) => f.name)])].filter((n) => !ask.includes(n) && n !== c.flag && fields.some((f) => f.name === n));
  const h = healthOf(conn as never)?.decl as { status?: string; tested_at?: string; tested?: string; result?: string; expires_on?: string } | undefined;
  const creators = allowedRoles(conn, "create").map((r) => ACCOUNT_ROLE_LABELS[r as AccountRole] ?? r);
  return {
    allowed, readable, area: { name: conn.name, label: conn.label, key_from_title: !!(conn as { key_from_title?: boolean }).key_from_title }, fields, ask, more,
    flag: c.flag ? { name: c.flag, label: conn.fields.find((f) => f.name === c.flag)?.label ?? c.flag } : null,
    health: h ? { status: h.status ?? null, tested_at: h.tested_at ?? h.tested ?? null, result: h.result ?? null, expires_on: h.expires_on ?? null } : null,
    // Said to the people who may not connect: who may, in the roles' own words ("Only workspace owners can connect it.").
    who: creators.length ? `Only workspace ${joined(creators.map((r) => `${r.toLowerCase()}s`))} can connect it.` : "No one in this workspace can connect it.",
  };
}

