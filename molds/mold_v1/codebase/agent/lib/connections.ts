/**
 * Shared connection definitions, re-exported from `connections/<name>.ts` files
 * in the root agent and in the subagents that need them (declared subagents do
 * not inherit the root's connections, so each re-exports the factory it needs).
 *
 * Auth goes through Vercel Connect. Register each connector once from this
 * project, then replace the placeholder UIDs below with the ones the CLI returns:
 *
 *   vercel link
 *   vercel connect create api.githubcopilot.com --name github
 *   vercel connect create <slack-connector>      --name slack
 *   vercel connect attach <connector-uid> --yes
 *   vercel env pull
 *
 * See https://vercel.com/docs/connect and node_modules/eve/docs/connections/.
 *
 * OFF VERCEL there is no Vercel Connect. With CONNECTIONS_PROVIDER=env (lib/connections-provider.ts) both
 * connections take their bearer from the calling workspace's own credentials instead: the secrets stored on its
 * connector, or the server's environment values when they are bound to that workspace
 * (agent/lib/connector-credentials.ts). `connect()` is then never called. With the setting unset, everything below is
 * exactly what it was: scripts/test-connections-default-unchanged.mjs holds it to a recording made before the
 * setting existed.
 */
import { createSign } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { ConnectionAuthorizationFailedError, defineMcpClientConnection } from "eve/connections";
import { connectionsFromEnv, type ProvidedConnectorKind } from "../../lib/connections-provider.ts";
import { fill } from "./agent-vocabulary.ts";
import { connectorTokenFor, NotConnectedError } from "./connector-credentials.ts";
import { orgForSession, type SessionCtxLike } from "./org-context.ts";

/** Read once, when the agent starts: eve builds its connections from these definitions at load. */
const FROM_ENV = connectionsFromEnv();

/**
 * CONNECTIONS_PROVIDER=env: the bearer for one connector, resolved PER CALLER. eve calls this inside the active turn
 * with the session's context (and keeps the result in that turn's own context, never in the process), so the token
 * is the one that belongs to the workspace the session runs in, and to no other.
 *
 * A workspace with no credentials gets the error eve already knows for an app connector that is not installed
 * (what Vercel Connect's adapter raises: ConnectionAuthorizationFailedError, reason "app_not_installed", not
 * retryable). The tool call reports "not connected"; nothing crashes, and the turn carries on.
 */
export function workspaceConnectorAuth(kind: ProvidedConnectorKind) {
  return (ctx: unknown) => ({
    principalType: "app" as const,
    getToken: async () => {
      try {
        return await connectorTokenFor(await orgForSession(ctx as SessionCtxLike), kind);
      } catch (error) {
        if (error instanceof NotConnectedError) {
          throw new ConnectionAuthorizationFailedError(kind, { message: error.message, reason: "app_not_installed", retryable: false });
        }
        throw error;
      }
    },
  });
}

/**
 * GitHub App installation token — minted on demand, short-lived (~1h), and
 * READ-ONLY (scoped entirely by the App's own permissions, which are read-only
 * and cover only the installed repos). This is strictly more least-privilege
 * than a PAT: nothing long-lived is stored, the token carries no user identity,
 * and access is revoked the instant the App is uninstalled. eve sends it as a
 * bearer and never exposes it to the model.
 *
 * Config on the agent (fde-agent-api): GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID,
 * GITHUB_APP_PRIVATE_KEY (the App's PEM, base64-encoded or \n-escaped so it
 * survives an env var). If the App vars are absent, this falls back to a static
 * read-only GITHUB_TOKEN (PAT); if that too is unset, GitHub tools just fail when
 * called. A GitHub App is NOT an OAuth App — no broad user grant.
 */
let cachedGithubToken: { token: string; expMs: number } | null = null;

/** A ≤10-minute App JWT (RS256), signed with the App private key. */
function githubAppJwt(appId: string, privateKey: string): string {
  const seg = (s: string) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = seg(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s for clock skew; exp within GitHub's 10-minute App-JWT cap.
  const payload = seg(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

/** The bearer for GitHub calls: a fresh installation token (cached to ~expiry),
 *  or a static PAT fallback, or "" (tools then fail closed). */
async function githubToken(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !rawKey) return process.env.GITHUB_TOKEN ?? "";

  // Installation tokens live ~1h — reuse while >5m of headroom remains.
  if (cachedGithubToken && cachedGithubToken.expMs - Date.now() > 5 * 60 * 1000) {
    return cachedGithubToken.token;
  }

  // An env var can't hold raw PEM newlines cleanly: accept base64 or \n-escaped.
  const privateKey = rawKey.includes("-----BEGIN")
    ? rawKey.replace(/\\n/g, "\n")
    : Buffer.from(rawKey, "base64").toString("utf8");

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubAppJwt(appId, privateKey)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub App installation-token mint failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cachedGithubToken = { token: data.token, expMs: new Date(data.expires_at).getTime() };
  return data.token;
}

export const githubConnection = defineMcpClientConnection({
  url: process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/",
  description: fill(
    "GitHub (read-only): inspect repos, issues, pull requests, commits, and workflow runs for {account} platforms.",
  ),
  auth: FROM_ENV ? workspaceConnectorAuth("github") : { getToken: async () => ({ token: await githubToken() }) },
});

/**
 * Slack: the agent posts stand-up summaries and follow-up nudges and reads
 * customer channels. App-scoped so it acts as the workspace's bot.
 */
export const slackConnection = defineMcpClientConnection({
  url: process.env.SLACK_MCP_URL ?? "https://slack-mcp.example.com/mcp",
  description: fill(
    "Slack: read {account} channels and threads, and post stand-up summaries and follow-up reminders.",
  ),
  auth: FROM_ENV ? workspaceConnectorAuth("slack") : connect({ connector: "slack/fde-agent", principalType: "app" }),
});

// Email is intentionally NOT a connection here. It is handled by native,
// draft-only IMAP tools (`email_list_inbox`, `email_create_draft`) in
// `agent/lib/email.ts`, configured with IMAP_* env vars. There is no SMTP/send
// path anywhere — see the banner in agent/lib/email.ts.
