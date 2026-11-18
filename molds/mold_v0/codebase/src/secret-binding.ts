/**
 * Secrets bound to where they go (mold_v0-312): an encrypted field a server-side call or a session uses is bound to the
 * plain fields that decide where it is sent. A write that changes one of those fields and does not give the secret
 * again clears it, so a person who may edit a connection cannot point its kept secret somewhere else (an endpoint
 * changed to their own host, then Test) without typing the secret themselves. Read by the record store's write
 * (src/record-areas.ts putWorkspaceNow).
 *
 *   test_connection   a page action's probe (src/connection-test-config.ts): its `by` field, and each probe's field
 *                     that starts its address or sits in its host, bind the encrypted fields its headers carry;
 *                     mold_v0-313: a signed kind's deciding roles (an AWS region, an Azure tenant, a database's host
 *                     and port) bind the encrypted fields its roles name (keys, a client secret, a password)
 *   connection_env    a pack profile's entry (src/connection-env-config.ts): every plain field it delivers binds the
 *                     encrypted fields it delivers (the session decides where they go, with all of them)
 *   object_storage    the declared storage area (mold_v0-305): its endpoint binds both keys
 *   members_field     mold_v0-322: a connection_env entry's owners-only opt-in for members' sessions (membersFlagWrite, below)
 */
import { ConnectionTestSchema, destinationFields, probeSecrets } from "./connection-test-config.js";
import { ConnectionEnvSchema, envVars } from "./connection-env-config.js";
import { ObjectStorageDeclSchema, PackError } from "./pack-api.js";
import { packs } from "./packs.js";

export interface Binding { decide: string[]; secrets: string[] }
interface AreaLike { pack: string; name: string; fields: readonly { name: string; encrypted?: boolean }[]; detail?: { actions?: readonly { kind?: string; probe?: unknown }[] } }

const cache = new WeakMap<object, Map<string, Binding[]>>();

/** The bindings of `area`'s encrypted fields (none for an area without encrypted fields). */
export function bindingsOf(area: AreaLike): Binding[] {
  if (!area.fields.some((f) => f.encrypted)) return [];
  const key = packs();
  let byArea = cache.get(key);
  if (!byArea) { byArea = new Map(); cache.set(key, byArea); }
  const id = `${area.pack}/${area.name}`;
  const hit = byArea.get(id);
  if (hit) return hit;
  const sealed = (n: string) => area.fields.some((f) => f.name === n && f.encrypted);
  const out: Binding[] = [];
  for (const a of area.detail?.actions ?? []) {
    if (a?.kind !== "test_connection") continue;
    const t = ConnectionTestSchema.safeParse(a.probe);
    if (!t.success) continue;
    const probes = Object.values(t.data.probes);
    const secrets = [...new Set(probes.flatMap((p) => probeSecrets(p, sealed)))];
    const decide = [...new Set([...(t.data.by ? [t.data.by] : []), ...probes.flatMap(destinationFields)])].filter((n) => !sealed(n));
    if (secrets.length && decide.length) out.push({ decide, secrets });
  }
  for (const p of key) {
    if (p.id === area.pack) for (const prof of (p.definition.agentProfiles ?? []) as { connection_env?: unknown[] }[])
      for (const raw of prof.connection_env ?? []) {
        const c = ConnectionEnvSchema.safeParse(raw);
        if (!c.success || c.data.area !== area.name) continue;
        const fields = envVars(c.data).map((v) => v.field);
        const secrets = fields.filter(sealed), decide = fields.filter((n) => !sealed(n));
        if (secrets.length && decide.length) out.push({ decide, secrets });
      }
    const os = (p.definition as { objectStorage?: unknown }).objectStorage;
    if (os && p.id === area.pack) {
      const d = ObjectStorageDeclSchema.safeParse(os);
      if (d.success && d.data.area === area.name) out.push({ decide: [d.data.fields.endpoint], secrets: [d.data.fields.access_key_id, d.data.fields.secret_access_key] });
    }
  }
  byArea.set(id, out);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The encrypted fields a write must clear: those bound to a deciding field whose value the write changes, unless the
 * write gives the secret itself (`given` holds it: the person typed it again).
 */
export function secretsToClear(area: AreaLike, stored: Record<string, unknown> | null, given: unknown): string[] {
  if (!stored) return [];
  const g = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  const out = new Set<string>();
  for (const b of bindingsOf(area)) {
    if (!b.decide.some((f) => !same(g[f], stored[f]))) continue;
    for (const s of b.secrets) if (!(s in g)) out.add(s);
  }
  return [...out];
}

// ---------------------------------------------------------------- members' builds (mold_v0-322)
//
// A connection_env entry's `members_field` (src/connection-env-config.ts): a plain boolean only the workspace's owners
// set, by hand, meaning "sessions members start may receive this record's values". Here, for the record store's write
// (src/record-areas.ts putWorkspaceNow) and an import's preview (src/record-import.ts):
//   who sets it     a person whose role is owner, writing directly (not an agent session's tool call, a pack tool, a
//                   repository's index or the system). Anyone else's write that gives another value is refused (403);
//                   one that leaves it out keeps it as stored
//   what clears it  a write by anyone but such an owner that changes where the entry's secrets go: a delivered plain
//                   field changed, or a delivered secret typed again (or cleared) — the binding's rule, for the consent
//   the trail       each change is a data-trail line of its own: grant (on) or revoke (off), never a value

/** One entry's opt-in: its field, and the fields the entry delivers (a change of one by a non-owner turns it off). */
export interface MembersGate { field: string; label: string; delivers: string[] }
interface GateArea { pack: string; name: string; label?: string; fields: readonly { name: string; label?: string; encrypted?: boolean }[] }
const gateCache = new WeakMap<object, Map<string, MembersGate[]>>();

/** The members' opt-in fields of `area` (its pack's profiles' connection_env entries that name one). */
export function membersGatesOf(area: GateArea): MembersGate[] {
  const key = packs();
  let byArea = gateCache.get(key);
  if (!byArea) { byArea = new Map(); gateCache.set(key, byArea); }
  const id = `${area.pack}/${area.name}`;
  const hit = byArea.get(id);
  if (hit) return hit;
  const out = new Map<string, MembersGate>();
  for (const p of key) {
    if (p.id !== area.pack) continue;
    for (const prof of (p.definition.agentProfiles ?? []) as { connection_env?: unknown[] }[])
      for (const raw of prof.connection_env ?? []) {
        const c = ConnectionEnvSchema.safeParse(raw);
        if (!c.success || c.data.area !== area.name || !c.data.members_field) continue;
        const m = c.data.members_field, f = area.fields.find((x) => x.name === m);
        const g = out.get(m) ?? { field: m, label: f?.label ?? m, delivers: [] };
        g.delivers = [...new Set([...g.delivers, ...envVars(c.data).map((v) => v.field)])];
        out.set(m, g);
      }
  }
  const list = [...out.values()];
  byArea.set(id, list);
  return list;
}

/** The fields of `area` only owners set (its members' opt-ins): a form for anyone else leaves them out. */
export const ownerOnlyFields = (area: GateArea): Set<string> => new Set(membersGatesOf(area).map((g) => g.field));

/**
 * A write's effect on the members' opt-ins of `area`. `owner`: an owner writing by hand (src/record-areas.ts says who).
 * Refuses (403) anyone else's write that gives another value; for them returns the input without the field and what to
 * carry (the stored value, or false when the write changes where the secrets go). `turned`: the opt-ins this write
 * changes (for the trail). `given` is the write's input after its encrypted fields were split (a secret in it was typed
 * again or cleared; one left out is kept).
 */
export function membersFlagWrite(area: GateArea, owner: boolean, stored: Record<string, unknown> | null, given: unknown):
  { input: unknown; carried: Record<string, unknown>; turned: { field: string; on: boolean }[] } {
  const gates = membersGatesOf(area);
  if (!gates.length) return { input: given, carried: {}, turned: [] };
  const g = given && typeof given === "object" && !Array.isArray(given) ? { ...(given as Record<string, unknown>) } : {};
  const has = (f: string) => Object.prototype.hasOwnProperty.call(g, f);
  const sealed = (n: string) => area.fields.some((f) => f.name === n && f.encrypted);
  const carried: Record<string, unknown> = {};
  const turned: { field: string; on: boolean }[] = [];
  for (const gate of gates) {
    const was = stored?.[gate.field] === true;
    if (owner) {
      const now = has(gate.field) ? g[gate.field] === true : false;
      if (now !== was) turned.push({ field: gate.field, on: now });
      continue;
    }
    if (has(gate.field)) {
      if ((g[gate.field] === true) !== was)
        throw new PackError(`"${gate.label}" of ${area.label ?? area.name} records is for the workspace's owners to set: leave it out`, 403);
      delete g[gate.field];
    }
    // Where the secrets go, changed by someone other than an owner: the owners' consent does not follow it.
    const moved = !!stored && gate.delivers.some((f) => (sealed(f) ? has(f) : !same(g[f], stored[f])));
    if (was && moved) { carried[gate.field] = false; turned.push({ field: gate.field, on: false }); }
    else if (was) carried[gate.field] = true;
  }
  return { input: given && typeof given === "object" && !Array.isArray(given) ? g : given, carried, turned };
}

/** Whether a form for a person of `role` offers field `f` of `area`: a members' opt-in only to owners (mold_v0-322). */
export const formOffers = (area: GateArea, role: string | null) => {
  const only = ownerOnlyFields(area);
  return (f: { name: string }) => role === "owner" || !only.has(f.name);
};
