/**
 * WHICH env vars each connector kind actually needs to work.
 *
 * Read off the code that consumes them, not invented: see agent/lib/connections.ts
 * (GitHub MCP, Slack MCP), agent/channels/slack.ts (outbound bot token),
 * agent/lib/email.ts (IMAP, draft-only — there is no SMTP), agent/lib/granola.ts,
 * and agent/lib/db/index.ts. This manifest is the reason the Ops Center can say
 * WHY a connector is dead instead of showing a green dot that means nothing.
 */
export interface RequiredSecret {
  name: string;
  /** What breaks without it, in one line. */
  purpose: string;
  /** A connector can work without an optional secret (it has a default). */
  optional?: boolean;
}

export const CONNECTOR_SECRETS: Record<string, RequiredSecret[]> = {
  slack: [
    { name: "SLACK_BOT_TOKEN", purpose: "Posting into channels (outbound)." },
    { name: "SLACK_TEAM_CHANNEL_ID", purpose: "The channel the scheduled runs post to." },
    // Optional in the sense that Slack still POSTS without it — the crons do,
    // every day. It is reading that dies. That is a degraded connector, not a
    // dead one, and the dot says so.
    {
      name: "SLACK_MCP_URL",
      purpose: "Reading channel history (inbound). Without it, Slack is write-only.",
      optional: true,
    },
  ],
  github: [
    { name: "GITHUB_APP_ID", purpose: "Read-only GitHub App — its ID. Preferred over a PAT: short-lived, per-repo, revocable." },
    { name: "GITHUB_APP_INSTALLATION_ID", purpose: "The App's installation on your repos." },
    { name: "GITHUB_APP_PRIVATE_KEY", purpose: "The App's PEM (base64 or \\n-escaped) — signs the JWT that mints ~1h install tokens." },
    { name: "GITHUB_TOKEN", purpose: "Fallback: a static read-only fine-grained PAT, used only when the App vars are unset.", optional: true },
    { name: "GITHUB_MCP_URL", purpose: "The MCP endpoint.", optional: true },
  ],
  gmail: [
    { name: "IMAP_HOST", purpose: "The mail server." },
    { name: "IMAP_USER", purpose: "The mailbox to read and draft into." },
    { name: "IMAP_PASSWORD", purpose: "App password. Drafts only — there is no send path." },
    { name: "IMAP_PORT", purpose: "Defaults to 993.", optional: true },
    { name: "IMAP_SECURE", purpose: "Defaults to TLS.", optional: true },
    { name: "IMAP_DRAFTS_MAILBOX", purpose: "Defaults to Drafts.", optional: true },
  ],
  granola: [
    { name: "GRANOLA_API_KEY", purpose: "Meeting notes. Without it, research and customer-context lose their call transcripts." },
    { name: "GRANOLA_API_URL", purpose: "API base.", optional: true },
  ],
  system_of_record: [
    { name: "DATABASE_URL", purpose: "Postgres (Neon) — the system of record itself." },
    { name: "BLOB_READ_WRITE_TOKEN", purpose: "The data room's document artifacts." },
  ],
  exa: [{ name: "EXA_API_KEY", purpose: "Web search." }],
  pagerduty: [
    { name: "PAGERDUTY_ROUTING_KEY", purpose: "Events API v2 — trigger/resolve incidents (page on-call)." },
    { name: "PAGERDUTY_API_TOKEN", purpose: "REST read — who is currently on-call. Without it, paging still works but the digest can't name the responder.", optional: true },
  ],
};

/**
 * Kinds the Ops Center can list but the AGENT CANNOT USE: no connection module,
 * no tool, nothing reads them. Saying "needs no credentials" about one of these
 * would read as "all good" when the truth is "this connector does not exist" —
 * see agent/lib/connections.ts for what is actually wired.
 */
export const UNIMPLEMENTED_KINDS = new Set<string>([]);

/** Every env var name any connector cares about — what the agent reports on. */
export const ALL_SECRET_NAMES: string[] = [
  ...new Set(Object.values(CONNECTOR_SECRETS).flatMap((s) => s.map((x) => x.name))),
];

/** The manifest for a connector kind; unknown kinds simply have no requirements. */
export function secretsForKind(kind: string): RequiredSecret[] {
  return CONNECTOR_SECRETS[kind.toLowerCase()] ?? [];
}

/**
 * The manifest for an actual connector ROW — what this connector needs.
 *
 * A workspace can bring its own integration (kind "mcp", or any kind we never
 * shipped) and declare its own credential contract in `required_secrets`. That
 * row-level contract WINS: without it, `secretsForKind` returns [] for an
 * unknown kind and the secrets route rejects every name, so a custom connector
 * could be created and then never given a single credential.
 *
 * A built-in kind ignores the column — we know what Slack needs better than a
 * caller does, and letting a row redefine it would be a way to smuggle in an
 * env var nothing reads.
 */
export function secretsForConnector(connector: {
  kind: string;
  requiredSecrets?: RequiredSecret[] | null;
}): RequiredSecret[] {
  const builtin = secretsForKind(connector.kind);
  if (builtin.length) return builtin;
  return (connector.requiredSecrets ?? []).filter(
    (s): s is RequiredSecret => Boolean(s?.name && s?.purpose),
  );
}

/** Env-var shape: uppercase, digits, underscores. Rejects shell-hostile names. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
