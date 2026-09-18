/**
 * Pull the real Postgres error out of a Drizzle failure.
 *
 * Drizzle wraps driver errors in its own Error whose message is the full SQL
 * text plus the bound parameters, and `String(e)` gives you only that. The
 * useful part — SQLSTATE, the constraint name, the human message — hangs off
 * `.cause`. So the naive `/foreign key/.test(String(e))` check silently never
 * matches, and callers get a 50-line INSERT dump with no cause. Two operators
 * hit exactly this and neither could tell what was wrong.
 */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
}

export function pgError(e: unknown): PgErrorInfo {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  // Walk the cause chain — Drizzle nests one deep today, but that is an
  // implementation detail worth not depending on.
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const c = cur as Record<string, unknown>;
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) {
      return {
        code: c.code,
        constraint: typeof c.constraint_name === "string" ? c.constraint_name
          : typeof c.constraint === "string" ? c.constraint : undefined,
        detail: typeof c.detail === "string" ? c.detail : undefined,
        message: typeof c.message === "string" ? c.message : undefined,
      };
    }
    cur = c.cause;
  }
  return {};
}

/** 23503 = foreign_key_violation. */
export const isForeignKeyViolation = (e: unknown): boolean => pgError(e).code === "23503";
/** 23505 = unique_violation. */
export const isUniqueViolation = (e: unknown): boolean => pgError(e).code === "23505";

/** 42P01 = undefined_table — the migration has not run yet. */
export const isUndefinedTable = (e: unknown): boolean => pgError(e).code === "42P01";

/**
 * Is this failure safe to report as "there is nothing stored"?
 *
 * Only a table that does not exist. Everything else — a quota-exhausted
 * compute, a dropped connection, a permission denial — means the store has
 * data we could not read, and answering "empty" for those is how a read
 * failure turns into what looks like data loss.
 */
export const isEmptyStore = (e: unknown): boolean => isUndefinedTable(e);
