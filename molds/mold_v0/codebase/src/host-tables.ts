import { PACK_MIGRATION_DIRS } from "./pack-migrations.generated.js";

/**
 * Which of the session engine's tables this build has (mold_v0-049). The product's tables left the shell's base schema
 * for its host pack, whose migrations create them under the names they had (pack.json host.schema.tables, listed in
 * src/pack-migrations.generated.ts). The session engine (src/worker.ts, src/autoscaler.ts, the Compute and Accounts
 * figures) stays in the shell and reads them, so it runs only in a build whose host pack has them; with none (a shell
 * with zero packs) it is dormant: no demand, no claims, no spend, no rows on its pages, and none of its SQL runs.
 * Read from the build's registry, never from the database: a database built before mold_v0-049 may still hold the
 * tables, and a build with no host pack leaves them alone.
 */
const HOST_TABLES = new Set(PACK_MIGRATION_DIRS.flatMap((d) => [...(d.schema?.tables ?? [])]));
/** Whether a host pack of this build owns this table. */
export const hostTable = (name: string): boolean => HOST_TABLES.has(name);
/** Whether this build has the session engine: its products, scenarios, simulations and their sessions. */
export const sessionEngine = (): boolean => ["products", "scenarios", "simulations", "agent_sessions"].every(hostTable);
/** Whether this build has research jobs too (the host pack's product_research), which the engine also runs. */
export const researchJobs = (): boolean => sessionEngine() && hostTable("product_research");
