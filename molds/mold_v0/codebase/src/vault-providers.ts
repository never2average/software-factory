/**
 * Which key vault providers this build reads, and which of them its packs' runs need (mold_v0-169, mold_v0-173).
 *
 * The vault's provider rows are the shell's migrations', the same in every build; the key vault page, the admin MCP's
 * key_vault_status (src/platform-keys.ts) and the operator's `npm run operator:vault-status` (scripts/operator/
 * vault-status.ts) list only the ones something in this build reads, so a build without the session engine is not asked
 * for keys of coding agents, research search or the orchestrators' sandboxes it never uses. Nothing here touches the
 * database: it reads the build's packs and the deployment's settings only.
 */
import { ENV } from "./env-names.js";

/** Read by the shell itself in every build: email (Resend), and the one-model calls behind the docs answers and packs'
 * askModel (src/ask-model.ts: Cloudflare Workers AI, then Claude, directly or on Vertex AI, then OpenAI). */
const SHELL_PROVIDERS = new Set(["resend", "cloudflare", "anthropic", "vertex", "openai"]);
/** Read only by the session engine (src/host-tables.ts sessionEngine): its agents' gateway providers and coding-agent
 * harnesses (harnesses/registry.json), its research's search providers, and the sandboxes its orchestrators run in. */
const ENGINE_PROVIDERS = new Set(["google", "dashscope", "github_copilot", "cursor", "amp", "factory", "exa", "libraries_io", "boat"]);

/** A provider's name and category as the key vault page shows them (web/src/features/admin/keyvault.tsx NAME and TYPE:
 * the console is its own Next.js app and keeps its own copy; keep the two in step). */
export const PROVIDER_NAME: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google Gemini", cloudflare: "Cloudflare Workers AI", dashscope: "Alibaba DashScope",
  vertex: "Vertex AI (Google Cloud)", boat: "boat.dev", exa: "Exa", libraries_io: "Libraries.io", resend: "Resend", amp: "Amp", cursor: "Cursor",
  factory: "Factory", github_copilot: "GitHub Copilot", oauth_clients: "OAuth app clients", pack_credentials: "Staff-held run credentials",
  object_storage: "Object storage (R2 / S3)", freestyle: "Freestyle", neon: "Neon",
};
export const PROVIDER_CATEGORY: Record<string, string> = {
  anthropic: "Inference", openai: "Inference", google: "Inference", cloudflare: "Inference", dashscope: "Inference", vertex: "Inference",
  boat: "Sandbox", freestyle: "Sandbox", exa: "Search", libraries_io: "Search", resend: "Email",
  amp: "Coding agent", cursor: "Coding agent", factory: "Coding agent", github_copilot: "Coding agent",
  oauth_clients: "Connection", pack_credentials: "Run credential", object_storage: "Storage", neon: "Storage",
};
export const providerName = (slug: string) => PROVIDER_NAME[slug] ?? slug;
export const providerCategory = (slug: string) => PROVIDER_CATEGORY[slug] ?? "Other";

/** The vault provider of the object store's settings (src/keyvault.ts OBJECT_STORAGE_PROVIDER, src/storage.ts). */
const OBJECT_STORAGE = "object_storage";
/** The job kinds (`<pack>.<kind>`) that keep a workspace store between runs (src/workspace-retention.ts storePacks):
 * the object store holds their snapshots. */
async function storeKinds(): Promise<string[]> {
  const { packs } = await import("./packs.js");
  return packs().flatMap((p) => [
    ...(p.definition.agentJobKinds ?? []).map((k) => `${p.id}.${(k as { name: string }).name}`),
    ...(p.definition.jobKinds ?? []).filter((k) => (k as { workspace?: boolean }).workspace).map((k) => `${p.id}.${(k as { name: string }).name}`),
  ]);
}
/** Whether the deployment's settings read here give the store a home without the vault: all four R2_* or APP_STORAGE_DIR. */
export const storeOutsideVault = () => Boolean((ENV.R2_BUCKET && ENV.R2_ENDPOINT && ENV.R2_ACCESS_KEY_ID && ENV.R2_SECRET_ACCESS_KEY) || ENV.APP_STORAGE_DIR);

/**
 * Whether this build reads a vault provider: one holding a key always (nothing a staff member stored is hidden); the
 * shell's own; a gateway provider some pack's job kind names; the packs' operator credentials and OAuth clients only when
 * a pack declares them; boat when the session engine runs orchestrators on it or the packs' runs may go there
 * (boatForRuns); object storage with the engine (its trace archive) or a pack whose runs keep a workspace store; the
 * engine's when the build has the engine; Freestyle (mold_v0-274) only when the runs' sandboxes come
 * from it (the platform setting APP_RUN_SANDBOX, the profile's run_sandbox: src/run-sandboxes.ts runSandboxMode), so a
 * build that never uses it is not asked for its key; a provider staff added by hand.
 */
export async function providerInBuild(slug: string, keys: number): Promise<boolean> {
  if (keys > 0 || SHELL_PROVIDERS.has(slug)) return true;
  const { sessionEngine } = await import("./host-tables.js");
  if (slug === "pack_credentials") return (await import("./credentials.js")).operatorCredentialSpecs().length > 0;
  if (slug === "oauth_clients") return (await import("./oauth-connections.js")).oauthProviders().length > 0;
  const kinds = (await import("./runs.js")).jobKinds();
  if (slug === "boat") { const rs = await import("./run-sandboxes.js"); return sessionEngine() || rs.boatForRuns(rs.RUN_SANDBOXES.mode(), kinds.length > 0); }
  if (slug === "freestyle") return (await import("./run-sandboxes.js")).RUN_SANDBOXES.mode() === "freestyle";
  if (slug === OBJECT_STORAGE) return sessionEngine() || (await storeKinds()).length > 0;
  // mold_v0-282: Neon only while a shared area's records own a database (flag record_resources).
  if (slug === "neon") { const { featureOn } = await import("./features.js"); return featureOn("record_resources") && (await import("./record-areas.js")).recordAreas().some((a) => a.fields.some((f) => f.type === "database")); }
  if (kinds.some((k) => k.providers.includes(slug))) return true;
  return ENGINE_PROVIDERS.has(slug) ? sessionEngine() : true;
}

/** One provider the packs' runs need, and why: the kinds that name it (`<pack>.<kind>`), or the runs' sandboxes. */
export interface RunNeed {
  slug: string;
  /** For pack_credentials: the vault labels (`<pack>.<name>`) the kinds' operator_credentials read. */
  labels?: string[];
  kinds: string[];
  sandbox?: boolean;
  /** For object_storage: the kinds' workspace store needs a bucket, and the deployment's settings give none. */
  store?: boolean;
}

/**
 * An operator credential a run kind names that is declared optional (mold_v0-186): the runs go ahead without it and do
 * less, so it is not among what they need. `adds` is what a value adds (its `adds`, else its help, else its label).
 */
export interface RunOptional { slug: "pack_credentials"; label: string; name: string; kinds: string[]; adds: string }

/** One line of what an optional credential adds: its `adds`, else the first sentence of its help after a leading "Optional.". */
export function optionalAdds(c: { label: string; help?: string | null; adds?: string | null }): string {
  if (c.adds) return c.adds;
  const help = (c.help ?? "").replace(/^\s*optional[.:]?\s*/i, "").trim();
  const first = help.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? help;
  return (first || c.label).slice(0, 200);
}

/**
 * What the build's run kinds need from the vault, by the same rules the console uses: each kind's gateway `providers`,
 * its `operator_credentials` (provider pack_credentials, label `<pack>.<name>`), and boat when the runs get their
 * sandbox there (src/run-sandboxes.ts boatForRuns, with the deployment's APP_RUN_SANDBOX, default auto), freestyle when
 * they get it there (mold_v0-274: APP_RUN_SANDBOX freestyle, chosen by staff, the server or the profile), and object
 * storage when kinds keep a workspace store and the deployment's settings seen here give it no bucket (no R2_*, no
 * APP_STORAGE_DIR). An operator credential declared optional (mold_v0-186) is not a need: it is listed in `optional`.
 */
export async function runNeeds(): Promise<{ kinds: number; packs: string[]; sandbox_mode: string; boat_for_runs: boolean; needs: RunNeed[]; optional: RunOptional[] }> {
  const kinds = (await import("./runs.js")).jobKinds();
  const rs = await import("./run-sandboxes.js");
  const mode = rs.RUN_SANDBOXES.mode();
  const boat = rs.boatForRuns(mode, kinds.length > 0);
  const bySlug = new Map<string, RunNeed>();
  const need = (slug: string) => bySlug.get(slug) ?? (bySlug.set(slug, { slug, kinds: [] }), bySlug.get(slug)!);
  const specs = (await import("./credentials.js")).operatorCredentialSpecs();
  const optional = new Map<string, RunOptional>();
  for (const k of kinds) {
    const id = `${k.pack}.${k.name}`;
    for (const p of k.providers ?? []) need(p).kinds.push(id);
    const ops = ("operator_credentials" in k ? (k.operator_credentials as string[] | undefined) : undefined) ?? [];
    for (const n of ops) {
      // mold_v0-186: an optional one is listed apart, never among what the runs need.
      const spec = specs.find((c) => c.pack === k.pack && c.name === n);
      if (spec?.optional) {
        const label = `${k.pack}.${n}`;
        const o = optional.get(label) ?? (optional.set(label, { slug: "pack_credentials", label, name: spec.label, kinds: [], adds: optionalAdds(spec) }), optional.get(label)!);
        o.kinds.push(id);
        continue;
      }
      const n_ = need("pack_credentials"); n_.kinds.push(id);
      const label = `${k.pack}.${n}`;
      n_.labels = [...new Set([...(n_.labels ?? []), label])];
    }
  }
  if (boat) need("boat").sandbox = true;
  // mold_v0-274: the runs' sandboxes from Freestyle (the workspace agent's wakes are runs too).
  const agents = (await import("./feature-flags.js")).featureSetting("agent_harness");
  if (mode === "freestyle" && (kinds.length > 0 || agents)) need("freestyle").sandbox = true;
  // The workspace store's snapshots go to the bucket: from the vault when the environment names none (mold_v0-181).
  const stores = await storeKinds();
  if (stores.length && !storeOutsideVault()) { const n = need(OBJECT_STORAGE); n.store = true; n.kinds.push(...stores); }
  for (const n of bySlug.values()) n.kinds = [...new Set(n.kinds)];
  return { kinds: kinds.length, packs: [...new Set(kinds.map((k) => k.pack))], sandbox_mode: mode, boat_for_runs: boat,
           needs: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
           optional: [...optional.values()].map((o) => ({ ...o, kinds: [...new Set(o.kinds)] })).sort((a, b) => a.label.localeCompare(b.label)) };
}

/** Whether the deployment's settings read here are the defaults (the operator script names what it could not see). */
export const sandboxModeSet = () => Boolean(ENV.APP_RUN_SANDBOX);
