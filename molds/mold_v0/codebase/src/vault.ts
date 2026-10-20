import { isPlatform, platformOf } from "./platform.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db.js";

/**
 * The vault: the curated repository of developer tasks and developer profiles.
 *
 * Source, in order of preference:
 *   VAULT_URL (+ VAULT_TOKEN)  GET {VAULT_URL}/profiles and {VAULT_URL}/tasks, JSON array or {items|data: [...]}
 *   VAULT_DIR                  profiles.json / tasks.json (arrays) or .jsonl files in a directory
 * Records are upserted by slug (or external id); anything no longer in the vault is deactivated, never deleted,
 * so past sessions keep their profile. Rows an admin edited on /admin (edited_at set) or wrote there (source 'admin')
 * are the admin's: the sync never overwrites, reactivates or retires them (src/library.ts).
 */

export interface VaultProfile {
  id?: string; slug?: string; name: string; summary?: string; instructions?: string;
  attributes?: Record<string, unknown>; [k: string]: unknown;
}
export interface VaultTask {
  id?: string; slug?: string; title: string; prompt: string; repo_url?: string; language?: string;
  category?: string; tags?: string[]; attributes?: Record<string, unknown>; [k: string]: unknown;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
const list = (body: unknown): unknown[] =>
  Array.isArray(body) ? body : ((body as any)?.items ?? (body as any)?.data ?? (body as any)?.results ?? []);

async function fromUrl(kind: "profiles" | "tasks"): Promise<unknown[]> {
  const base = process.env.VAULT_URL!.replace(/\/$/, "");
  const res = await fetch(`${base}/${kind}`, {
    headers: { accept: "application/json", ...(process.env.VAULT_TOKEN ? { authorization: `Bearer ${process.env.VAULT_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Vault ${kind}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return list(await res.json());
}

async function fromDir(kind: "profiles" | "tasks"): Promise<unknown[]> {
  const dir = path.resolve(process.env.VAULT_DIR!);
  for (const file of [`${kind}.json`, `${kind}.jsonl`]) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => null);
    if (text == null) continue;
    return file.endsWith(".jsonl") ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : list(JSON.parse(text));
  }
  throw new Error(`Vault directory ${dir} has no ${kind}.json or ${kind}.jsonl`);
}

export const vaultConfigured = () => Boolean(process.env.VAULT_URL || process.env.VAULT_DIR);

export async function fetchVault() {
  if (!vaultConfigured()) throw new Error("Set VAULT_URL (and VAULT_TOKEN) or VAULT_DIR");
  const get = process.env.VAULT_URL ? fromUrl : fromDir;
  const [profiles, tasks] = await Promise.all([get("profiles"), get("tasks")]);
  return { profiles: profiles as VaultProfile[], tasks: tasks as VaultTask[] };
}

/** Pull the vault into Postgres. Returns counts. */
export async function syncVault() {
  const { profiles, tasks } = await fetchVault();
  const db = await getDb();
  const bad = (what: string, i: number, field: string) => new Error(`Vault ${what} #${i + 1} is missing ${field}`);
  return db.transaction(async (tx) => {
    let keptProfiles = 0, keptTasks = 0;
    const profileSlugs: string[] = [];
    for (const [i, p] of profiles.entries()) {
      if (!p?.name) throw bad("profile", i, "name");
      const { id, slug, name, summary, instructions, attributes, ...rest } = p;
      const s = slug ? slugify(slug) : slugify(String(id ?? name));
      profileSlugs.push(s);
      const wrote = await tx.query(
        // Shared vault rows only: a vault slug that collides with an organization's private persona, or with a persona an
        // admin edited or wrote, never overwrites it.
        `INSERT INTO developer_profiles (slug, external_id, name, summary, attributes, instructions, source, active, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'vault', true, now())
         ON CONFLICT (slug) DO UPDATE SET external_id = excluded.external_id, name = excluded.name, summary = excluded.summary,
           attributes = excluded.attributes, instructions = excluded.instructions, active = true, synced_at = now()
         WHERE developer_profiles.org_id IS NULL AND developer_profiles.source = 'vault' AND developer_profiles.edited_at IS NULL
         RETURNING 1`,
        [s, id == null ? null : String(id), name, summary ?? "", JSON.stringify({ ...rest, ...(attributes ?? {}) }), instructions ?? ""],
      );
      if (!wrote.length) keptProfiles++;
    }
    const taskSlugs: string[] = [];
    for (const [i, t] of tasks.entries()) {
      if (!t?.prompt) throw bad("task", i, "prompt");
      const { id, slug, title, prompt, repo_url, language, category, tags, attributes, ...rest } = t;
      const s = slug ? slugify(slug) : slugify(String(id ?? title ?? prompt.slice(0, 48)));
      taskSlugs.push(s);
      const wrote = await tx.query(
        `INSERT INTO library_tasks (slug, external_id, title, prompt, repo_url, language, category, tags, attributes, platform, active, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, now())
         ON CONFLICT (slug) DO UPDATE SET external_id = excluded.external_id, title = excluded.title, prompt = excluded.prompt,
           repo_url = excluded.repo_url, language = excluded.language, category = excluded.category, tags = excluded.tags,
           attributes = excluded.attributes, platform = excluded.platform, active = true, synced_at = now()
         WHERE library_tasks.source = 'vault' AND library_tasks.edited_at IS NULL
         RETURNING 1`,
        [s, id == null ? null : String(id), title || prompt.slice(0, 80), prompt, repo_url ?? null, language ?? null,
         category ?? null, tags ?? [], JSON.stringify({ ...rest, ...(attributes ?? {}) }),
         // A vault task may state its platform; otherwise it is derived like every other task's.
         isPlatform(t.platform ?? attributes?.platform) ? (t.platform ?? attributes?.platform)
           : platformOf({ template: (attributes?.template ?? rest.template) as string | undefined, language, tags, prompt })],
      );
      if (!wrote.length) keptTasks++;
    }
    const [{ n: retiredProfiles }] = await tx.query<{ n: number }>(
      "WITH u AS (UPDATE developer_profiles SET active = false WHERE active AND source = 'vault' AND edited_at IS NULL AND NOT (slug = ANY($1)) RETURNING 1) SELECT count(*) AS n FROM u",
      [profileSlugs],
    );
    const [{ n: retiredTasks }] = await tx.query<{ n: number }>(
      "WITH u AS (UPDATE library_tasks SET active = false WHERE active AND source = 'vault' AND edited_at IS NULL AND NOT (slug = ANY($1)) RETURNING 1) SELECT count(*) AS n FROM u",
      [taskSlugs],
    );
    return { profiles: profiles.length, tasks: tasks.length, retired_profiles: Number(retiredProfiles), retired_tasks: Number(retiredTasks),
             kept_profiles: keptProfiles, kept_tasks: keptTasks };
  });
}
