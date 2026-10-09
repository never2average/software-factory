/**
 * TLS for the migration scripts' database connection — one rule, for scripts/migrate-production.mjs and
 * .migrate-task-workflow-service.mjs.
 *
 * Both connected with `ssl: "require"` and nothing else, which is right for a managed Postgres (Supabase, Neon) and
 * is still the default. A Postgres on the same machine as the app usually has no TLS configured, and against it both
 * scripts died with "Client network socket disconnected before secure TLS connection was established".
 *
 *   DATABASE_SSL unset, empty or "require"   TLS required. The default; what every deployment does today.
 *   DATABASE_SSL=disable                     no TLS, and ONLY for a database on this machine: a loopback host
 *                                            (localhost, 127.x.x.x, ::1) or a unix socket. For any other host it is
 *                                            refused before connecting, so a typo cannot send the admin password
 *                                            across a network in the clear.
 *
 * Anything else is an error naming the setting.
 */

/** The host a postgres URL connects to, and whether that is this machine. */
export function databaseHost(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("The database URL could not be read as a URL.");
  }
  // libpq's unix-socket forms: `postgres:///db?host=/var/run/postgresql` and a percent-encoded path as the host.
  const socket = url.searchParams.get("host");
  if (socket?.startsWith("/")) return { host: socket, local: true };
  const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (host.startsWith("/")) return { host, local: true };
  if (host === "" && url.searchParams.get("host") === null) return { host: "", local: true };
  const local = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return { host, local };
}

/** The `ssl` option for postgres.js: "require", or false when DATABASE_SSL=disable and the database is local. */
export function migrationSsl(databaseUrl, env = process.env) {
  const raw = (env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (raw === "" || raw === "require") return "require";
  if (raw !== "disable") {
    throw new Error(`DATABASE_SSL=${JSON.stringify(raw)} is not supported. Use "require" (the default) or "disable" (a Postgres on this machine only).`);
  }
  const { host, local } = databaseHost(databaseUrl);
  if (!local) {
    throw new Error(
      `DATABASE_SSL=disable is only for a Postgres on this machine (localhost, 127.0.0.1, ::1 or a unix socket). ` +
        `This database is at ${JSON.stringify(host)}, so the connection stays encrypted: unset DATABASE_SSL.`,
    );
  }
  return false;
}
