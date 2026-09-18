import postgres from "postgres";

export type SqlClient = postgres.Sql | postgres.TransactionSql;

let cached: { url: string; sql: postgres.Sql } | null = null;

export function getDb(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  if (!cached || cached.url !== url) {
    cached = { url, sql: postgres(url, { max: 5, prepare: false }) };
  }
  return cached.sql;
}

export async function withOrgTransaction<T>(orgId: string, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await getDb().begin(async (sql) => {
    await sql`select set_config('app.org_id', ${orgId}, true)`;
    return fn(sql);
  });
  return result as T;
}

export async function checkDb(): Promise<{ role: string; ms: number }> {
  const started = Date.now();
  const [row] = await getDb()<{ role: string }[]>`select current_user as role`;
  return { role: row?.role ?? "unknown", ms: Date.now() - started };
}
