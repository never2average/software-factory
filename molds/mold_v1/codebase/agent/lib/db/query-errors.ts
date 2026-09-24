/**
 * A database error never carries the values of the query that failed.
 *
 * Drizzle wraps every driver failure in a DrizzleQueryError whose MESSAGE is the whole statement plus its bound
 * parameters (`Failed query: insert into "customers" … params: <every value>`). That message is what reaches a
 * person: a tool's thrown error is handed to the model verbatim and drawn in the chat, and ops routes answer
 * `{ error: String(e) }`. So a write the database REFUSED still published what it was asked to write — and when
 * that row had been read from another workspace (upsertCustomer merged a record read across workspaces into the
 * patch, then wrote it under the caller's), the refusal text was the other workspace's record.
 *
 * The fix is where the error is born, not at each of the ~80 places that print one: every query drizzle runs goes
 * through PgPreparedQuery.queryWithCache (agent and web alike, inside or outside a transaction), so that one method
 * is wrapped to rethrow a {@link DatabaseQueryError}: a plain sentence chosen by SQLSTATE, the code and the
 * constraint/table names kept (lib/pg-error.ts reads them), and nothing the caller or a row supplied. The statement
 * text — placeholders only, no values — and the SQLSTATE are logged server-side under a short reference that the
 * sentence also carries, so an operator can still find the failure.
 *
 * scripts/test-cross-workspace.mjs holds it offline (the wrap is installed and redacts); the isolation job's
 * scripts/test-cross-workspace-reads-db.mjs holds it against Postgres (a refused cross-workspace write's error
 * contains none of the other workspace's values).
 */
import { PgPreparedQuery } from "drizzle-orm/pg-core";
import postgres from "postgres";

/** What survives of the driver error: identifiers the schema defines, never data. */
export interface SafeDbCause {
  code?: string;
  constraint_name?: string;
  table_name?: string;
  column_name?: string;
  severity?: string;
}

export class DatabaseQueryError extends Error {
  readonly code?: string;
  readonly constraint_name?: string;
  readonly table_name?: string;
  readonly ref: string;
  constructor(message: string, ref: string, cause: SafeDbCause) {
    super(message);
    this.name = "DatabaseQueryError";
    this.ref = ref;
    this.code = cause.code;
    this.constraint_name = cause.constraint_name;
    this.table_name = cause.table_name;
    // lib/pg-error.ts walks `.cause` for the SQLSTATE; give it the sanitized one, never the driver's (whose
    // `detail` is "Key (customer_id)=(…)" / "Failing row contains (…)").
    Object.defineProperty(this, "cause", { value: cause, enumerable: false, writable: false });
  }
}

/**
 * A real SQLSTATE: five characters from [0-9A-Z] with at least one digit (every class and subclass Postgres defines
 * has one: 23505, 42P01, P0001, XX000). Five capitals alone is not enough: EPERM, EPIPE and EBUSY are system errors
 * of exactly that shape, and reading them as database errors relabelled a failed file write as "the database".
 */
export function isSqlState(code: unknown): code is string {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && /\d/.test(code);
}

/** Is this error (not its causes) one the Postgres server returned? */
export function isPostgresError(error: unknown): boolean {
  return error instanceof postgres.PostgresError || (typeof error === "object" && error !== null && isSqlState((error as { code?: unknown }).code));
}

/** The server's error inside a drizzle one (one level today; walk the chain rather than depend on that). */
function driverError(error: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (isPostgresError(cur)) return cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** A client-side failure under drizzle (a dropped connection, EPIPE, a timeout): its code, when it has one. */
function clientErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Was the failed statement a read or a write? From its first keyword; a CTE or anything else is "unknown". */
export type QueryKind = "read" | "write" | "unknown";
export function queryKindOf(queryString: string | undefined): QueryKind {
  const head = (queryString ?? "").trimStart().slice(0, 12).toLowerCase();
  if (/^(select|show)\b/.test(head)) return "read";
  if (/^(insert|update|delete|merge)\b/.test(head)) return "write";
  return "unknown";
}

/**
 * One plain sentence per class of failure. Chosen by SQLSTATE and by whether the statement read or wrote, so no text
 * from the database is repeated and a failed read never claims "nothing was written".
 *
 * 42501 is deliberately NEUTRAL. It is what row-level security returns for a row another workspace owns — and also
 * what a missing grant or a misconfigured role returns — so "that record is not in this workspace" was both an
 * existence oracle (it confirms the id is in use elsewhere, where a fresh id would simply have been created) and,
 * for the grant case, wrong. "Absent, not forbidden": say it cannot be reached from here, and no more.
 */
export function plainDatabaseSentence(code: string | undefined, kind: QueryKind = "unknown"): string {
  const notWritten = kind === "write" ? ", so nothing was written" : kind === "read" ? "" : ", so nothing was read or changed";
  if (!code) return "The database could not complete this request.";
  if (code === "42501") {
    if (kind === "read") return "That record can't be read from this workspace.";
    if (kind === "write") return "That record can't be changed from this workspace, so nothing was written.";
    return "That record can't be read or changed from this workspace.";
  }
  if (code === "23505") return "A record with that id already exists, so nothing was written.";
  if (code === "23503") return "It refers to a record that does not exist here, so nothing was written.";
  if (code === "23502") return "A required value was missing, so nothing was written.";
  if (code === "23514" || code === "23P01") return "A value was not allowed, so nothing was written.";
  if (code.startsWith("22")) return `A value was not in the form the database expects${notWritten}.`;
  if (code === "40001" || code === "40P01" || code === "55P03") return "The database was busy with a conflicting change. Try again.";
  if (code === "42P01" || code === "42703") return "The database is missing a table or column this needs (a migration has not run).";
  if (code.startsWith("08") || code === "57P01" || code === "53300") return "The database could not be reached. Try again shortly.";
  if (code === "57014") return "The database took too long and the request was cancelled.";
  return `The database could not complete this request${notWritten}.`;
}

let counter = 0;
const nextRef = () => `db-${Date.now().toString(36)}-${(counter++ % 1296).toString(36)}`;

/**
 * The error a caller may show anyone. Logs the statement (placeholders only) and the SQLSTATE under a reference;
 * never the parameters, never the driver's message or detail.
 */
export function redactQueryError(error: unknown, queryString?: string): Error {
  if (error instanceof DatabaseQueryError) return error;
  const driver = driverError(error);
  const cause: SafeDbCause = {
    code: str(driver?.code),
    constraint_name: str(driver?.constraint_name),
    table_name: str(driver?.table_name),
    column_name: str(driver?.column_name),
    severity: str(driver?.severity),
  };
  // No SQLSTATE: the failure was on the client side (a dropped connection, EPIPE, a timeout). Keep its code — it
  // is the real cause, and a code carries no values — rather than relabel it as a generic database failure.
  const client = driver ? undefined : clientErrorCode(error);
  if (client) cause.code = client;
  const ref = nextRef();
  const statement = (queryString ?? "").replace(/\s+/g, " ").slice(0, 240);
  console.error(
    `[db] query failed ref=${ref} code=${cause.code ?? "none"}` +
      (cause.table_name ? ` table=${cause.table_name}` : "") +
      (cause.constraint_name ? ` constraint=${cause.constraint_name}` : "") +
      (statement ? ` statement="${statement}"` : ""),
  );
  const sentence = client
    ? `The database could not be reached (${client}). Try again shortly.`
    : plainDatabaseSentence(cause.code, queryKindOf(queryString));
  return new DatabaseQueryError(`${sentence} (ref ${ref})`, ref, cause);
}

const INSTALLED = Symbol.for("fde.queryErrorRedaction");

/**
 * Wrap PgPreparedQuery.prototype.queryWithCache once per module instance. Idempotent. Returns whether the wrap is
 * in place, so a test can fail loudly if a drizzle upgrade moves the method.
 */
export function installQueryErrorRedaction(): boolean {
  const proto = PgPreparedQuery.prototype as unknown as Record<PropertyKey, unknown> & {
    queryWithCache?: (queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>;
  };
  if (proto[INSTALLED]) return true;
  const original = proto.queryWithCache;
  if (typeof original !== "function") return false;
  proto.queryWithCache = async function (this: unknown, queryString: string, params: unknown[], query: () => Promise<unknown>) {
    try {
      return await original.call(this, queryString, params, query);
    } catch (error) {
      throw redactQueryError(error, queryString);
    }
  };
  proto[INSTALLED] = true;
  return true;
}

installQueryErrorRedaction();
