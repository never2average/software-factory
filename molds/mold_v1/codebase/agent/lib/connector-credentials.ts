/**
 * A CONNECTOR'S CREDENTIALS FOR ONE WORKSPACE, WITHOUT VERCEL CONNECT (CONNECTIONS_PROVIDER=env).
 *
 * On Vercel the Slack connector's token is issued by Vercel Connect. A server that is not on Vercel has no Connect,
 * so the credentials have to live somewhere the server can read. The application already has that place: the Ops
 * Center stores a connector's secrets per workspace (`connector_secrets`), encrypted with OPS_SECRETS_KEY under a key
 * derived from the workspace id (HKDF, salt = workspace id) and behind a strict row-level-security policy, so a read
 * outside the workspace's database scope returns nothing and another workspace's key cannot open the row. It is what
 * a bring-your-own connector and the workspace mailbox (agent/lib/workspace-mailbox.ts) already read at call time.
 * This is the same rule as the mailbox, for the built-in Slack and GitHub connectors:
 *
 *   1. the workspace's OWN credentials: its enabled, workspace-level connector of that kind, when the secrets stored
 *      on it are enough to authenticate. Read and decrypted inside that workspace's scope;
 *   2. otherwise the SERVER's environment values, ONLY for the one workspace they are bound to by
 *      CONNECTIONS_WORKSPACE (a workspace id, not a secret). Unbound, they are nobody's: on a server with several
 *      workspaces, one company's Slack bot or GitHub App is not every company's;
 *   3. otherwise not connected, with the reason.
 *
 * With no database at all (local development: one workspace) the environment values are that workspace's.
 *
 * A set of credentials is used whole or not at all: a workspace's stored set is never completed from the
 * environment. Nothing here lists workspaces or looks at another workspace's connectors: the answer for workspace W
 * is read in W's scope, or from W's own binding of the server's values. A personal connector (one with an owner) is
 * not a workspace credential and is never used here.
 *
 * Values never leave this module except as the token handed to eve, which sends it as a bearer and never shows it
 * to the model. Reasons name settings, never values.
 *
 * Relative `.ts` imports, so this also runs under plain `node --experimental-strip-types`.
 */
import { createSign } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { connectionsWorkspace, CONNECTIONS_WORKSPACE_ENV, type ProvidedConnectorKind } from "../../lib/connections-provider.ts";
import { getDb, withOrgDb } from "./db/index.ts";
import { connectorSecrets, connectors } from "./db/schema.ts";
import { decryptSecret, hasSecretsKey } from "./secret-crypto.ts";

type Values = Record<string, string | undefined>;

/** The names each kind's credentials are made of (lib/connector-secrets-manifest.ts carries the same names). */
export const CREDENTIAL_NAMES: Record<ProvidedConnectorKind, readonly string[]> = {
  slack: ["SLACK_BOT_TOKEN"],
  github: ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_TOKEN"],
};

/** Is this set enough to authenticate? Slack: the bot token. GitHub: the whole App triple, or a token. */
export function credentialsUsable(kind: ProvidedConnectorKind, v: Values): boolean {
  if (kind === "slack") return Boolean(v.SLACK_BOT_TOKEN);
  return Boolean((v.GITHUB_APP_ID && v.GITHUB_APP_INSTALLATION_ID && v.GITHUB_APP_PRIVATE_KEY) || v.GITHUB_TOKEN);
}

export type CredentialSource = "workspace" | "server";

export type CredentialLookup =
  | { readonly connected: true; readonly source: CredentialSource; readonly values: Readonly<Record<string, string>> }
  | { readonly connected: false; readonly reason: string };

/** What the lookup reads from. Replaceable so the rules can be tested without a database. */
export interface CredentialDeps {
  readonly env: Values;
  /** Is there a database (so: possibly more than one workspace)? */
  hasDatabase(): boolean;
  /** The secrets stored on workspace `orgId`'s enabled, workspace-level connector of `kind`; null when it has none. */
  readStored(orgId: string, kind: ProvidedConnectorKind): Promise<Record<string, string> | null>;
}

/** The workspace's own stored secrets for `kind`, read and decrypted inside its scope. */
async function readStoredSecrets(orgId: string, kind: ProvidedConnectorKind): Promise<Record<string, string> | null> {
  if (!getDb() || !hasSecretsKey()) return null;
  return withOrgDb(orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.orgId, orgId), eq(connectors.kind, kind), eq(connectors.enabled, true), isNull(connectors.ownerEmail)))
      .limit(1);
    if (!conn) return null;
    const rows = await tx
      .select()
      .from(connectorSecrets)
      .where(and(eq(connectorSecrets.orgId, orgId), eq(connectorSecrets.connectorId, conn.id)));
    const values: Record<string, string> = {};
    for (const r of rows) {
      if (!CREDENTIAL_NAMES[kind].includes(r.name)) continue;
      try {
        values[r.name] = decryptSecret({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag, keyVersion: r.keyVersion }, orgId, null);
      } catch {
        /* a secret that will not decrypt is simply absent: the set is then incomplete, and not used */
      }
    }
    return values;
  });
}

const liveDeps: CredentialDeps = {
  get env() {
    return process.env;
  },
  hasDatabase: () => Boolean(getDb()),
  readStored: readStoredSecrets,
};

const LABEL: Record<ProvidedConnectorKind, string> = { slack: "Slack", github: "GitHub" };
const NEEDS: Record<ProvidedConnectorKind, string> = {
  slack: "SLACK_BOT_TOKEN",
  github: "GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_TOKEN)",
};

function pick(kind: ProvidedConnectorKind, v: Values): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CREDENTIAL_NAMES[kind]) {
    const value = v[name];
    if (value) out[name] = value;
  }
  return out;
}

/** The ONE set of credentials workspace `orgId` may use for `kind`, or why there is none. Never another workspace's. */
export async function connectorCredentialsFor(
  orgId: string | null | undefined,
  kind: ProvidedConnectorKind,
  deps: CredentialDeps = liveDeps,
): Promise<CredentialLookup> {
  if (!orgId) return { connected: false, reason: `${LABEL[kind]} is not connected: no workspace was named, so no credentials are read.` };

  const stored = await deps.readStored(orgId, kind);
  if (stored && credentialsUsable(kind, stored)) return { connected: true, source: "workspace", values: pick(kind, stored) };

  const server = pick(kind, deps.env);
  if (credentialsUsable(kind, server)) {
    const bound = connectionsWorkspace(deps.env);
    if (!deps.hasDatabase() || bound === orgId) return { connected: true, source: "server", values: server };
    return {
      connected: false,
      reason: bound
        ? `${LABEL[kind]} is not connected for this workspace: it has no ${LABEL[kind]} credentials of its own (a '${kind}' connector with ${NEEDS[kind]} stored), and this server's ${LABEL[kind]} credentials are another workspace's.`
        : `${LABEL[kind]} is not connected for this workspace: it has no ${LABEL[kind]} credentials of its own (a '${kind}' connector with ${NEEDS[kind]} stored). This server's ${LABEL[kind]} credentials are not bound to a workspace (${CONNECTIONS_WORKSPACE_ENV}), so no workspace uses them.`,
    };
  }
  return {
    connected: false,
    reason: `${LABEL[kind]} is not connected for this workspace: store ${NEEDS[kind]} on its '${kind}' connector.`,
  };
}

/* ---- GitHub: a token from a set of credentials ------------------------------------------------------------------ */

/** A ≤10-minute App JWT (RS256), signed with the App private key. The same construction as agent/lib/connections.ts. */
function githubAppJwt(appId: string, privateKey: string): string {
  const seg = (s: string) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = seg(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = seg(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

/**
 * Installation tokens, one per (workspace, App, installation). The workspace is part of the key on purpose: two
 * workspaces that stored the same App get two entries, and a token minted for one is never handed to the other.
 */
const installationTokens = new Map<string, { token: string; expMs: number }>();

/** For tests. */
export function resetConnectorTokenCache(): void {
  installationTokens.clear();
}

export interface TokenResult {
  readonly token: string;
  readonly expiresAt?: number;
}

/** The bearer for GitHub calls from one workspace's credentials: an installation token (cached to near expiry), or the PAT. */
export async function githubTokenFrom(orgId: string, v: Readonly<Record<string, string>>, fetchImpl: typeof fetch = fetch): Promise<TokenResult> {
  const appId = v.GITHUB_APP_ID;
  const installationId = v.GITHUB_APP_INSTALLATION_ID;
  const rawKey = v.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !rawKey) return { token: v.GITHUB_TOKEN ?? "" };

  const cacheKey = `${orgId}\u0000${appId}\u0000${installationId}`;
  const cached = installationTokens.get(cacheKey);
  if (cached && cached.expMs - Date.now() > 5 * 60 * 1000) return { token: cached.token, expiresAt: cached.expMs };

  const privateKey = rawKey.includes("-----BEGIN") ? rawKey.replace(/\\n/g, "\n") : Buffer.from(rawKey, "base64").toString("utf8");
  const res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${githubAppJwt(appId, privateKey)}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub App installation-token mint failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  const expMs = new Date(data.expires_at).getTime();
  installationTokens.set(cacheKey, { token: data.token, expMs });
  return { token: data.token, expiresAt: expMs };
}

/** The bearer a connector's MCP calls use for workspace `orgId`. Throws `NotConnectedError` when there is none. */
export async function connectorTokenFor(
  orgId: string | null | undefined,
  kind: ProvidedConnectorKind,
  deps: CredentialDeps = liveDeps,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const found = await connectorCredentialsFor(orgId, kind, deps);
  if (!found.connected) throw new NotConnectedError(kind, found.reason);
  if (kind === "slack") return { token: found.values.SLACK_BOT_TOKEN };
  return githubTokenFrom(orgId as string, found.values, fetchImpl);
}

/** The connector has no credentials for this workspace. The message says why, naming settings and never values. */
export class NotConnectedError extends Error {
  readonly kind: ProvidedConnectorKind;
  constructor(kind: ProvidedConnectorKind, reason: string) {
    super(reason);
    this.name = "NotConnectedError";
    this.kind = kind;
  }
}
