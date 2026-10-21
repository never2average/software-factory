import { getDb, type Queryable } from "./db.js";
import { registry, type Population } from "./agents.js";
import { asPlatform } from "./tenant-scope.js";

/**
 * Developer populations in Postgres: which coding agents (harness x model) a population of developers uses, and in
 * what shares. The default population ("global") is seeded once from the registry's cited weights; after that the
 * database is the source of truth. Edit with `npm run population` or the admin API.
 */

interface PopulationRow {
  id: number; slug: string; name: string; description: string; as_of: string | null; methodology: string; sources: unknown[];
  unrepresented_share: number | null; sandbox_unit: number; min_one_sandbox: boolean; is_default: boolean;
  /** Owner of a private harness mix; null for public populations. */
  org_id: number | null;
}
const COLS = "id, slug, name, description, as_of::text AS as_of, methodology, sources, unrepresented_share, sandbox_unit, min_one_sandbox, is_default, org_id";

let seeded: Promise<void> | undefined;

/** Create the default population from the registry seed if no population exists yet. */
export function ensureDefaultPopulation(): Promise<void> {
  // Seeds the shared default population (src/tenant-scope.ts).
  return asPlatform(() => {
  seeded ??= (async () => {
    const db = await getDb();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM developer_populations");
    if (Number(n) > 0) return;
    const reg = registry() as ReturnType<typeof registry> & { methodology?: string };
    await db.transaction(async (tx) => {
      const [pop] = await tx.query<{ id: number }>(
        `INSERT INTO developer_populations (slug, name, description, as_of, methodology, sources, unrepresented_share, sandbox_unit, min_one_sandbox, is_default)
         VALUES ('global', 'Global developer population', 'Agentic coding usage across all developers, from public surveys and usage data.',
                 $1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [reg.as_of ?? null, reg.methodology ?? "", JSON.stringify(reg.sources ?? []), reg.unrepresented_share ?? null,
         Math.max(1, Math.trunc(Number(process.env.OCTILLION_SANDBOX_UNIT ?? 20))), process.env.OCTILLION_MIN_ONE_SANDBOX !== "0"],
      );
      if (!pop) return; // another process seeded concurrently
      for (const a of reg.agents.filter((x) => x.enabled !== false && x.weight > 0))
        await tx.query(
          `INSERT INTO developer_population_agents (population_id, agent_id, market_share, paused, paused_reason)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [pop.id, a.id, a.weight, Boolean(a.paused), a.paused_reason ?? null],
        );
    });
  })().catch((e) => { seeded = undefined; throw e; });
  return seeded;
});
}

/** `orgId`: a customer's view: public populations plus that organization's own mixes, never another org's. */
async function row(db: Queryable, slug?: string, orgId?: number): Promise<PopulationRow> {
  const scope = orgId === undefined ? "" : ` AND (org_id IS NULL OR org_id = ${Math.trunc(orgId)})`;
  const [p] = await db.query<PopulationRow>(
    slug ? `SELECT ${COLS} FROM developer_populations WHERE slug = $1${scope}` : `SELECT ${COLS} FROM developer_populations WHERE is_default`,
    slug ? [slug] : [],
  );
  if (!p) throw Object.assign(new Error(slug ? `No developer population "${slug}"` : "No default developer population"), { status: 404 });
  return p;
}

/** A population with registry agent specs merged in: weight = its market share, paused = its switch. */
export async function getPopulation(slug?: string, orgId?: number): Promise<Population> {
  await ensureDefaultPopulation();
  const db = await getDb();
  const p = await row(db, slug, orgId);
  const mix = await db.query<{ agent_id: string; market_share: number; paused: boolean; paused_reason: string | null; notes: string | null }>(
    "SELECT agent_id, market_share, paused, paused_reason, notes FROM developer_population_agents WHERE population_id = $1", [p.id]);
  const byId = new Map(mix.map((m) => [m.agent_id, m]));
  const agents = registry().agents.map((a) => {
    const m = byId.get(a.id);
    return { ...a, weight: m ? Number(m.market_share) : 0, paused: m?.paused ?? false, paused_reason: m?.paused_reason ?? undefined,
             notes: m?.notes ?? a.notes };
  });
  return { ...p, unrepresented_share: p.unrepresented_share == null ? null : Number(p.unrepresented_share), agents };
}

/** All populations (admin), or, with `orgId`, the public ones plus that organization's own mixes. */
export async function listPopulations(orgId?: number) {
  await ensureDefaultPopulation();
  return (await getDb()).query(
    `SELECT p.slug, p.name, p.description, p.as_of::text AS as_of, p.sandbox_unit, p.min_one_sandbox, p.is_default, p.org_id IS NOT NULL AS private,
            count(a.agent_id) FILTER (WHERE a.market_share > 0 AND NOT a.paused) AS running_agents
       FROM developer_populations p LEFT JOIN developer_population_agents a ON a.population_id = p.id
      ${orgId === undefined ? "" : "WHERE p.org_id IS NULL OR p.org_id = $1"}
      GROUP BY p.id ORDER BY p.is_default DESC, p.org_id IS NOT NULL, p.slug`, orgId === undefined ? [] : [orgId]);
}

const knownAgent = (id: string) => {
  if (!registry().agents.some((a) => a.id === id)) throw Object.assign(new Error(`Unknown agent ${id} (not in harnesses/registry.json)`), { status: 400 });
};

/** Create a population, optionally copying another's mix. */
export async function createPopulation(slug: string, name: string, opts: { from?: string; description?: string } = {}) {
  if (!/^[a-z0-9-]{2,48}$/.test(slug)) throw Object.assign(new Error("slug must be lowercase letters, digits or -"), { status: 400 });
  await ensureDefaultPopulation();
  const db = await getDb();
  const src = opts.from ? await row(db, opts.from) : null;
  await db.transaction(async (tx) => {
    const [p] = await tx.query<{ id: number }>(
      `INSERT INTO developer_populations (slug, name, description, as_of, methodology, sources, unrepresented_share, sandbox_unit, min_one_sandbox)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [slug, name, opts.description ?? src?.description ?? "", src?.as_of ?? null, src?.methodology ?? "", JSON.stringify(src?.sources ?? []),
       src?.unrepresented_share ?? null, src?.sandbox_unit ?? 20, src?.min_one_sandbox ?? false],
    );
    if (src) await tx.query(
      `INSERT INTO developer_population_agents (population_id, agent_id, market_share, paused, paused_reason, notes)
       SELECT $1, agent_id, market_share, paused, paused_reason, notes FROM developer_population_agents WHERE population_id = $2`,
      [p.id, src.id]);
  });
  return getPopulation(slug);
}

export async function updatePopulation(slug: string, patch: Partial<Pick<PopulationRow, "name" | "description" | "as_of" | "methodology" | "sources" | "unrepresented_share" | "sandbox_unit" | "min_one_sandbox">>) {
  const db = await getDb();
  const p = await row(db, slug);
  if (patch.sandbox_unit !== undefined && !(Number.isInteger(patch.sandbox_unit) && patch.sandbox_unit > 0))
    throw Object.assign(new Error("sandbox_unit must be a positive integer"), { status: 400 });
  await db.query(
    `UPDATE developer_populations SET name = coalesce($2, name), description = coalesce($3, description), as_of = coalesce($4::date, as_of),
       methodology = coalesce($5, methodology), sources = coalesce($6::jsonb, sources), unrepresented_share = coalesce($7, unrepresented_share),
       sandbox_unit = coalesce($8, sandbox_unit), min_one_sandbox = coalesce($9, min_one_sandbox), updated_at = now() WHERE id = $1`,
    [p.id, patch.name ?? null, patch.description ?? null, patch.as_of ?? null, patch.methodology ?? null,
     patch.sources ? JSON.stringify(patch.sources) : null, patch.unrepresented_share ?? null, patch.sandbox_unit ?? null, patch.min_one_sandbox ?? null],
  );
  return getPopulation(slug);
}

/** Set one agent's market share in a population (shares need not sum to 1; they are renormalised over running agents). */
export async function setShare(slug: string, agentId: string, share: number, notes?: string) {
  knownAgent(agentId);
  if (!(share >= 0)) throw Object.assign(new Error("share must be >= 0"), { status: 400 });
  const db = await getDb();
  const p = await row(db, slug);
  await db.query(
    `INSERT INTO developer_population_agents (population_id, agent_id, market_share, notes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (population_id, agent_id) DO UPDATE SET market_share = excluded.market_share,
       notes = coalesce(excluded.notes, developer_population_agents.notes), updated_at = now()`,
    [p.id, agentId, share, notes ?? null]);
  await db.query("UPDATE developer_populations SET updated_at = now() WHERE id = $1", [p.id]);
  return getPopulation(slug);
}

export async function setPaused(slug: string, agentId: string, paused: boolean, reason?: string) {
  knownAgent(agentId);
  const db = await getDb();
  const p = await row(db, slug);
  const [r] = await db.query(
    `UPDATE developer_population_agents SET paused = $3, paused_reason = $4, updated_at = now()
      WHERE population_id = $1 AND agent_id = $2 RETURNING agent_id`,
    [p.id, agentId, paused, paused ? reason ?? null : null]);
  if (!r) throw Object.assign(new Error(`${agentId} has no share in population ${slug}; set one first`), { status: 400 });
  return getPopulation(slug);
}

export async function setDefaultPopulation(slug: string) {
  const db = await getDb();
  const p = await row(db, slug);
  await db.transaction(async (tx) => {
    await tx.query("UPDATE developer_populations SET is_default = false WHERE is_default AND id <> $1", [p.id]);
    await tx.query("UPDATE developer_populations SET is_default = true, updated_at = now() WHERE id = $1", [p.id]);
  });
  return getPopulation(slug);
}
