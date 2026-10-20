import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Tiny query interface shared by both backends:
 *  - DATABASE_URL set  -> real Postgres via `pg` (e.g. the docker-compose service)
 *  - otherwise         -> embedded PGlite (Postgres compiled to WASM), persisted to PGLITE_DIR
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  /** Run fn inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Apply schema SQL with no other process doing the same at once (concurrent ALTERs deadlock). */
  migrate(sql: string): Promise<void>;
  kind: "postgres" | "pglite";
}

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    // Return NUMERIC and BIGINT (e.g. count(*)) as JS numbers.
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
    pg.types.setTypeParser(pg.types.builtins.INT8, Number);
    const pool = new pg.Pool({ connectionString: url });
    return {
      kind: "postgres",
      async query(sql, params) {
        return (await pool.query(sql, params)).rows;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
      // Replicas starting together (rolling deploys, serverless cold starts) would run the same ALTERs at once and
      // deadlock: they take turns on a transaction-level advisory lock. Transaction-level, not session-level, so it is
      // released at COMMIT even behind a transaction-pooling proxy (PgBouncer, Neon's pooler), where a session lock
      // can be taken on one server connection and "released" on another. The schema is idempotent and has no
      // statements that cannot run in a transaction; the second replica's pass is a no-op.
      async migrate(sql) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(7270010)");
          await client.query(sql);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }

  const { PGlite, types } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DIR ?? path.resolve(SQL_DIR, "..", ".pglite");
  const lite = await PGlite.create(dataDir, {
    parsers: { [types.NUMERIC]: Number, [types.INT8]: Number },
  });
  return {
    kind: "pglite",
    async query(sql, params) {
      return (await lite.query(sql, params)).rows as never[];
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    transaction: (fn) =>
      lite.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never[] })),
    close: () => lite.close(),
    migrate: (sql) => lite.exec(sql).then(() => undefined), // one process per PGlite directory
  };
}

let dbPromise: Promise<Db> | undefined;

/** Shared connection. Applies the (idempotent) schema on first use. */
export function getDb(): Promise<Db> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await createDb();
    try {
      await db.migrate(await readFile(path.join(SQL_DIR, "schema.sql"), "utf8"));
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
    return db;
  })();
  // A failed start (the database restarting, a network blip) must not stick: the next caller tries again.
  dbPromise.catch(() => { dbPromise = undefined; });
  return dbPromise;
}

/** Destructive: drop every table, then recreate the schema. Local development only. */
export async function resetDb(db: Db): Promise<void> {
  await db.exec(`DROP TABLE IF EXISTS access_requests, transcript_events, agent_sessions, simulations, scenarios,
                 products, api_keys, organizations, developer_profiles, library_tasks, orchestrators, gateway_usage, gateway_tokens, vault_credentials, vault_env_imports, vault_providers, developer_population_agents, developer_populations, product_research, model_prices, gateway_model_usage, usage_alerts, orchestrator_sandboxes, compute_events, autoscaler_ticks, autoscaler_lease, platform_settings, email_log CASCADE`);
  await db.exec(await readFile(path.join(SQL_DIR, "schema.sql"), "utf8"));
}
