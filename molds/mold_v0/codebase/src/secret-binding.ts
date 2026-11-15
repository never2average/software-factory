/**
 * Secrets bound to where they go (mold_v0-312): an encrypted field a server-side call or a session uses is bound to the
 * plain fields that decide where it is sent. A write that changes one of those fields and does not give the secret
 * again clears it, so a person who may edit a connection cannot point its kept secret somewhere else (an endpoint
 * changed to their own host, then Test) without typing the secret themselves. Read by the record store's write
 * (src/record-areas.ts putWorkspaceNow).
 *
 *   test_connection   a page action's probe (src/connection-test-config.ts): its `by` field, and each probe's field
 *                     that starts its address or sits in its host, bind the encrypted fields its headers carry
 *   connection_env    a pack profile's entry (src/connection-env-config.ts): every plain field it delivers binds the
 *                     encrypted fields it delivers (the session decides where they go, with all of them)
 *   object_storage    the declared storage area (mold_v0-305): its endpoint binds both keys
 */
import { ConnectionTestSchema, destinationFields, headerSecrets } from "./connection-test-config.js";
import { ConnectionEnvSchema, envVars } from "./connection-env-config.js";
import { ObjectStorageDeclSchema } from "./pack-api.js";
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
    const secrets = [...new Set(probes.flatMap((p) => headerSecrets(p, sealed)))];
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
