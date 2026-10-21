import { AdminError, log } from "./admin.js";
import { getDb } from "./db.js";
import * as kv from "./keyvault.js";
import { envStillSet } from "./keyvault-env.js";
import { setSettings } from "./settings.js";

/**
 * The platform's model keys and sandbox provider as /admin/compute and the key vault page show them, and saving global
 * settings with the console's audit log (moved out of the product's library module, mold_v0-039: these are the shell's).
 */

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Save global settings (src/settings.ts) as `actor`, logged; returns what changed. */
export async function saveSettingValues(actor: string, values: unknown) {
  const changes = await setSettings(actor, (values && typeof values === "object" ? values : {}) as Record<string, unknown>);
  if (changes.length) log(actor, "settings.save", null, { changes });
  return changes;
}

// ---------- model keys (the key vault, src/keyvault.ts) ----------
// The vault's own admin API (/api/admin/keyvault/*) stays as it is; these wrap it for /admin/compute with the console's
// actor and audit log. A secret is taken once and never returned: only its hint ("sk-ant…9xQ2").

const vaultError = (e: unknown) => (e instanceof AdminError ? e : new AdminError((e as Error).message));

/** Providers (with how many keys they hold and when one was last used) and every credential, hints only. */
export async function modelKeys() {
  // Every key is a vault key (env keys were imported once, src/keyvault-env.ts); env_set names the variables still set
  // on the server for a provider, which nothing reads any more and can be deleted there.
  const [providers, creds, envSet] = await Promise.all([kv.listProviders(), kv.listCredentials() as Promise<any[]>, envStillSet()]);
  const credentials = creds.map(({ key_id: _k, meta, ...c }) => ({ ...c, uses: Number(c.uses),
    ...(meta?.client_email ? { project_id: meta.project_id || null, client_email: meta.client_email } : {}) }));
  return {
    unlocked: kv.vaultUnlocked(),
    providers: providers.map((p) => {
      const mine = credentials.filter((c) => c.provider === p.slug);
      const last = mine.map((c) => c.last_used_at).filter(Boolean).sort((a, b) => +new Date(b) - +new Date(a))[0] ?? null;
      return { slug: p.slug, mode: p.mode, backend: p.backend, enabled: p.enabled, keys: mine.length, enabled_keys: mine.filter((c) => c.enabled).length, last_used_at: last,
               env_set: envSet[p.slug] ?? [] };
    }),
    credentials,
  };
}

export async function addModelKey(actor: string, body: { provider?: unknown; secret?: unknown; label?: unknown; priority?: unknown }) {
  const provider = str(body.provider, 40), secret = typeof body.secret === "string" ? body.secret : "";
  if (!provider || !secret) throw new AdminError("provider and secret are required");
  if (!kv.vaultUnlocked()) throw new AdminError("The key vault is locked: set OCTILLION_VAULT_KEY on the server first");
  const label = str(body.label, 60) || undefined, priority = body.priority === undefined || body.priority === "" ? undefined : Math.trunc(Number(body.priority));
  if (priority !== undefined && !Number.isFinite(priority)) throw new AdminError("Priority must be a whole number");
  const saved = await kv.setCredential(provider, secret, { label, priority }).catch((e) => { throw vaultError(e); });
  log(actor, "model_key.add", null, { provider, label: saved.label, hint: saved.hint });
  return saved; // { id, provider, label, hint } (+ project_id, client_email for a service account): never the secret
}

export async function setModelKeyEnabled(actor: string, id: number, enabled: unknown) {
  if (!Number.isInteger(id) || typeof enabled !== "boolean") throw new AdminError("A credential id and enabled (true or false) are required");
  await kv.setCredentialEnabled(id, enabled).catch((e) => { throw new AdminError((e as Error).message, 404); });
  log(actor, enabled ? "model_key.enable" : "model_key.disable", null, { credential: id });
}

export async function deleteModelKey(actor: string, id: number) {
  if (!Number.isInteger(id)) throw new AdminError("Bad credential id");
  await kv.deleteCredential(id).catch((e) => { throw new AdminError((e as Error).message, 404); });
  log(actor, "model_key.delete", null, { credential: id });
}

export async function setProviderEnabled(actor: string, slug: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new AdminError("enabled (true or false) is required");
  if (!(await kv.getProvider(slug))) throw new AdminError(`No provider ${slug}`, 404); // never create one from here
  await kv.upsertProvider({ slug, enabled }).catch((e) => { throw vaultError(e); });
  log(actor, enabled ? "model_provider.enable" : "model_provider.disable", null, { provider: slug });
}

// ---------- sandbox provider (boat.dev) ----------

/**
 * The sandbox provider as Compute shows it: boat.dev, the vault key it uses (hint only; replace or rotate it in Key
 * vault), live plan limits and what is running, ours (this deployment's namespace) and anyone else's on the account.
 * Each call asks boat.dev directly, so it doubles as a connection test.
 */
export async function sandboxProvider() {
  const lib = await import("../orchestrator/deploy/boat-lib.js");
  const { BOAT } = await import("../orchestrator/core/config.js");
  const creds = (await kv.listCredentials() as any[]).filter((c) => c.provider === "boat").map(({ key_id: _k, ...c }) => ({ ...c, uses: Number(c.uses) }));
  const db = await getDb();
  const orchestrators = await db.query<{ state: string; n: number }>(
    "SELECT state, count(*)::int AS n FROM orchestrator_sandboxes WHERE state IN ('booting', 'running', 'draining') GROUP BY state");
  const base = { provider: "boat.dev", api: BOAT.apiUrl, namespace: lib.BOAT_NAMESPACE, keys: creds,
    orchestrators: Object.fromEntries(orchestrators.map((o) => [o.state, Number(o.n)])) };
  try {
    BOAT.apiKey = (await kv.useCredential("boat")).secret;
    const [limits, list] = await Promise.all([lib.boatLimits(), lib.listSandboxes()]);
    const live = list.filter((s) => lib.isLive(s));
    const ours = live.filter((s) => s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX));
    return { ...base, ok: true, error: null, limits,
      running: { total: live.length, ours: ours.length, orchestrators: ours.filter((s) => s.name?.startsWith(lib.ORCH_PREFIX)).length, others: live.length - ours.length } };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message.slice(0, 300), limits: null, running: null };
  }
}
