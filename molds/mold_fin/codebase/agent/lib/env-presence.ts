/**
 * What the RUNNING agent actually has in its environment.
 *
 * The Ops Center runs in a different Vercel project (fde-agent) from the agent
 * (fde-agent-api), so its own `process.env` says nothing about whether the agent
 * holds a working GITHUB_TOKEN. The only process that can answer that is the
 * agent itself — so the every-minute dispatcher reports it here, and the Ops
 * Center reads the report.
 *
 * NAMES AND A BOOLEAN ONLY. A value never leaves this process: nothing is
 * hashed, prefixed, or "just the last 4" — the row says set or not set.
 *
 * Best-effort like the rest of the bookkeeping: no DB or a failed write is a
 * console line, never an exception into the dispatcher's run.
 *
 * NOTE: relative `.ts` specifiers so this also runs under plain
 * `node --experimental-strip-types`.
 *
 * tenancy-ok: runtime_env_presence records which environment variables a
 * deployment has, not tenant data. No org_id, no RLS.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db/index.ts";
import { runtimeEnvPresence } from "./db/schema.ts";

/**
 * Kept in step with lib/connector-secrets-manifest.ts on the Next side (Next
 * cannot import this module — it uses `.ts` specifiers the bundler will not
 * resolve). A name here that no connector asks about is harmless; a name the
 * manifest asks about and this list omits simply reports "unknown".
 */
export const REPORTED_ENV_NAMES = [
  "SLACK_BOT_TOKEN",
  "SLACK_TEAM_CHANNEL_ID",
  "SLACK_MCP_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "GITHUB_MCP_URL",
  "IMAP_HOST",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "IMAP_PORT",
  "IMAP_SECURE",
  "IMAP_DRAFTS_MAILBOX",
  "GRANOLA_API_KEY",
  "GRANOLA_API_URL",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "EXA_API_KEY",
  "PAGERDUTY_ROUTING_KEY",
  "PAGERDUTY_API_TOKEN",
] as const;

/**
 * SLACK_MCP_URL ships with a placeholder default in agent/lib/connections.ts.
 * Set-to-the-placeholder is not set — reporting it as present would tell an
 * operator Slack can read history when it cannot.
 */
const PLACEHOLDERS: Record<string, string> = {
  SLACK_MCP_URL: "https://slack-mcp.example.com/mcp",
};

function isPresent(name: string): boolean {
  const value = process.env[name]?.trim();
  if (!value) return false;
  return value !== PLACEHOLDERS[name];
}

export async function reportEnvPresence(): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const now = new Date();
    const rows = REPORTED_ENV_NAMES.map((name) => ({
      name,
      present: isPresent(name),
      seenAt: now,
    }));
    // WHICH DATABASE ROLE this process actually connects as.
    //
    // Reported for the same reason the env names are: nothing outside this
    // process can observe it. The agent is a separate Vercel project with its
    // own environment, so the front-end's health check says nothing about it —
    // and if the agent connects as a BYPASSRLS role, every tenant policy is
    // inert for the runtime that actually decrypts credentials, silently and
    // with no symptom. Recording it here makes the question answerable instead
    // of inferred from when an environment variable happened to be created.
    let roleRow = { name: "__db_role", present: false, seenAt: now };
    try {
      const r = await db.execute<{ role: string; bypassrls: boolean }>(
        sql`select current_user as role,
                   (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`,
      );
      const got = (r as unknown as { role: string; bypassrls: boolean }[])[0];
      // `present` means "RLS is enforced for this connection" — the healthy
      // state, so a green dot never means an ungoverned connection.
      roleRow = { name: `__db_role:${got?.role ?? "unknown"}`, present: !got?.bypassrls, seenAt: now };
    } catch {
      /* diagnostics must never break the report */
    }

    for (const row of [...rows, roleRow]) {
      await db
        .insert(runtimeEnvPresence)
        .values(row)
        .onConflictDoUpdate({
          target: runtimeEnvPresence.name,
          set: { present: row.present, seenAt: now },
        });
    }
  } catch (error) {
    console.error("[env-presence] could not report the environment:", error);
  }
}
