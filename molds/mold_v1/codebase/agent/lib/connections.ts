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
 */
import { createSign } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

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
  description:
    "GitHub (read-only): inspect repos, issues, pull requests, commits, and workflow runs for customer deployments.",
  auth: { getToken: async () => ({ token: await githubToken() }) },
});

/**
 * Slack: the agent posts stand-up summaries and follow-up nudges and reads
 * customer channels. App-scoped so it acts as the workspace's bot.
 */
export const slackConnection = defineMcpClientConnection({
  url: process.env.SLACK_MCP_URL ?? "https://slack-mcp.example.com/mcp",
  description:
    "Slack: read customer channels and threads, and post stand-up summaries and follow-up reminders.",
  auth: connect({ connector: "slack/fde-agent", principalType: "app" }),
});

// Email is intentionally NOT a connection here. It is handled by native,
// draft-only IMAP tools (`email_list_inbox`, `email_create_draft`) in
// `agent/lib/email.ts`, configured with IMAP_* env vars. There is no SMTP/send
// path anywhere — see the banner in agent/lib/email.ts.
