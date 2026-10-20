import { getDb } from "./db.js";
import { addCredentialIfAbsent, ENV_IMPORT_LABEL, listProviders, VERTEX_PROVIDER, vaultUnlocked, type ProviderRow } from "./keyvault.js";

/**
 * Provider keys live in the key vault only. Keys that used to be server environment variables (Vercel) are imported
 * once, on boot, inside the server: for each provider with a key set in the environment and no enabled key in the
 * vault, the value is encrypted into the vault as "imported from environment". A row in vault_env_imports records
 * that the provider was handled, so it runs once per provider (replicas race on the row; one wins), never overwrites
 * a vault key, and later changes to the environment variable are ignored. Only the provider and hint are logged.
 * Nothing at runtime reads these variables any more; the Key vault page notes which are still set so they can be
 * deleted from Vercel.
 */

/** Variables a provider's key was read from besides its registry env_vars (vault_providers.env_vars). */
const EXTRA_ENV: Record<string, string[]> = {
  cloudflare: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
  exa: ["EXA_API_KEY"],
  libraries_io: ["LIBRARIES_IO_API_KEY"],
  resend: ["RESEND_API_KEY"],
  [VERTEX_PROVIDER]: ["VERTEX_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"],
};

/** Every environment variable that holds (or held) this provider's key. */
export const envNamesFor = (p: Pick<ProviderRow, "slug" | "env_vars">) => [...new Set([...(p.env_vars ?? []), ...(EXTRA_ENV[p.slug] ?? [])])];
const envValue = (name: string) => { const v = process.env[name]; return v && v.trim() ? v : undefined; };

/** The provider-key variables still set in this process's environment (names only), per provider. */
export async function envStillSet(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const p of await listProviders()) {
    const set = envNamesFor(p).filter((n) => envValue(n));
    if (set.length) out[p.slug] = set;
  }
  return out;
}

export interface EnvImport { provider: string; env_var: string; outcome: "imported" | "vault_had_key" | "failed"; hint?: string; error?: string }

/** The one-time import (see above). Safe to call again: providers already handled are skipped. */
export async function importEnvKeys(log: (line: string) => void = console.error): Promise<EnvImport[]> {
  if (!vaultUnlocked()) return [];
  const db = await getDb();
  const out: EnvImport[] = [];
  for (const p of await listProviders()) {
    const name = envNamesFor(p).find((n) => envValue(n));
    if (!name) continue;
    const [claim] = await db.query<{ provider: string }>(
      "INSERT INTO vault_env_imports (provider, env_var) VALUES ($1, $2) ON CONFLICT (provider) DO NOTHING RETURNING provider", [p.slug, name]);
    if (!claim) continue; // handled once already (here or by another replica)
    try {
      const [has] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM vault_credentials WHERE provider = $1 AND enabled", [p.slug]);
      const saved = Number(has.n) ? null : await addCredentialIfAbsent(p.slug, envValue(name)!, { label: ENV_IMPORT_LABEL });
      if (saved) {
        await db.query("UPDATE vault_env_imports SET outcome = 'imported', hint = $2, credential_id = $3 WHERE provider = $1", [p.slug, saved.hint, saved.id]);
        log(`keyvault: imported ${p.slug} from the environment (${saved.hint})`);
        out.push({ provider: p.slug, env_var: name, outcome: "imported", hint: saved.hint });
      } else {
        await db.query("UPDATE vault_env_imports SET outcome = 'vault_had_key' WHERE provider = $1", [p.slug]);
        log(`keyvault: ${p.slug} already has a vault key; its environment variable was not imported`);
        out.push({ provider: p.slug, env_var: name, outcome: "vault_had_key" });
      }
    } catch (e) {
      // Not handled: release the claim so a later boot tries again (e.g. a direct-mode key once that is allowed).
      await db.query("DELETE FROM vault_env_imports WHERE provider = $1 AND outcome = 'pending'", [p.slug]).catch(() => {});
      const error = (e as Error).message.slice(0, 300); // vault errors never quote the key
      log(`keyvault: could not import ${p.slug} from the environment: ${error}`);
      out.push({ provider: p.slug, env_var: name, outcome: "failed", error });
    }
  }
  return out;
}

let once: Promise<unknown> | null = null;
/** importEnvKeys once per process (retried on the next call if it failed as a whole, e.g. the database was down). */
export function importEnvKeysOnce(): Promise<unknown> {
  once ??= importEnvKeys().then(async (r) => {
    // The boat key is read from the vault (compute, autoscaler); drop the copy orchestrator/core/config took from env.
    const { BOAT } = await import("../orchestrator/core/config.js");
    BOAT.apiKey = "";
    return r;
  }).catch((e) => { once = null; console.error("keyvault: environment import failed:", (e as Error).message); });
  return once;
}
