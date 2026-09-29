/**
 * WHICH MAILBOX A WORKSPACE MAY READ — its own, and nobody else's.
 *
 * Email intake (agent/lib/email-intake.ts) and the inbox / draft tools (agent/lib/email.ts) used to read ONE
 * deployment-wide IMAP inbox (the IMAP_* environment variables) from any workspace's turn. That inbox holds whatever
 * mail the deployment receives, for every workspace; intake then matched each sender against the CALLING workspace's
 * companies, so when two workspaces hold the same company or domain (mold_v1-118), one workspace's mail became a
 * ticket in whichever workspace happened to run intake, and `list_inbox` showed every workspace's mail to anyone.
 *
 * Now a workspace reads exactly one mailbox, and only its own:
 *
 *   1. its enabled, workspace-level `gmail` connector — the IMAP_* secrets the Ops Center stores per workspace
 *      (lib/connector-secrets-manifest.ts), decrypted inside that workspace's scope (connector_secrets is RLS-strict).
 *      The same source the web app's inbox sync already uses (lib/inbox-ingest.ts);
 *   2. otherwise the deployment's IMAP_* mailbox, ONLY for the one workspace it is bound to by IMAP_WORKSPACE
 *      (a workspace id, not a secret). Unbound, the deployment mailbox is nobody's: no workspace reads it;
 *   3. otherwise none: intake reports that the workspace has no mailbox, and the inbox tools say so.
 *
 * With no database at all (local development: one workspace) the environment mailbox is that workspace's.
 *
 * Nothing here lists workspaces or looks at another workspace's connectors: the answer for workspace W is read in
 * W's scope, or from W's own binding of the deployment mailbox.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { connectorSecrets, connectors } from "./db/schema.ts";
import { decryptSecret, hasSecretsKey } from "./secret-crypto.ts";

export interface MailboxConfig {
  readonly host: string;
  readonly user: string;
  readonly pass: string;
  readonly port: number;
  readonly secure: boolean;
  readonly draftsMailbox: string;
  /** Where it came from: the workspace's own connector, or the deployment mailbox bound to it. */
  readonly source: "connector" | "deployment";
}

export type MailboxLookup = { readonly mailbox: MailboxConfig } | { readonly mailbox: null; readonly reason: string };

function fromValues(v: Record<string, string | undefined>, source: MailboxConfig["source"]): MailboxConfig | null {
  if (!v.IMAP_HOST || !v.IMAP_USER || !v.IMAP_PASSWORD) return null;
  return {
    host: v.IMAP_HOST,
    user: v.IMAP_USER,
    pass: v.IMAP_PASSWORD,
    port: Number(v.IMAP_PORT ?? 993),
    secure: (v.IMAP_SECURE ?? "true") !== "false",
    draftsMailbox: v.IMAP_DRAFTS_MAILBOX ?? "Drafts",
    source,
  };
}

/** The deployment mailbox (IMAP_* env), or null when it is not configured. */
function deploymentMailbox(): MailboxConfig | null {
  return fromValues(process.env, "deployment");
}

/** The workspace's own mailbox: its enabled workspace-level `gmail` connector's secrets, read in its scope. */
async function connectorMailbox(orgId: string): Promise<MailboxConfig | null> {
  if (!getDb() || !hasSecretsKey()) return null;
  return withOrgDb(orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.orgId, orgId), eq(connectors.kind, "gmail"), eq(connectors.enabled, true), isNull(connectors.ownerEmail)))
      .limit(1);
    if (!conn) return null;
    const rows = await tx
      .select()
      .from(connectorSecrets)
      .where(and(eq(connectorSecrets.orgId, orgId), eq(connectorSecrets.connectorId, conn.id)));
    const values: Record<string, string> = {};
    for (const r of rows) {
      try {
        values[r.name] = decryptSecret({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag, keyVersion: r.keyVersion }, orgId, null);
      } catch {
        /* a secret that will not decrypt is simply absent: the mailbox is then incomplete, and not used */
      }
    }
    return fromValues(values, "connector");
  });
}

/** The ONE mailbox workspace `orgId` may read and draft into, or why there is none. Never another workspace's. */
export async function mailboxFor(orgId: string | null | undefined): Promise<MailboxLookup> {
  if (!orgId) return { mailbox: null, reason: "No workspace was named, so no mailbox is read." };
  const own = await connectorMailbox(orgId);
  if (own) return { mailbox: own };
  const deployment = deploymentMailbox();
  if (deployment) {
    const bound = process.env.IMAP_WORKSPACE?.trim();
    if (!getDb() || bound === orgId) return { mailbox: deployment };
    return {
      mailbox: null,
      reason: bound
        ? "This workspace has no mailbox of its own (a 'gmail' connector), and the deployment's mailbox is not this workspace's."
        : "This workspace has no mailbox of its own (a 'gmail' connector). The deployment's mailbox (IMAP_*) is not bound to a workspace (IMAP_WORKSPACE), so no workspace reads it.",
    };
  }
  return { mailbox: null, reason: "This workspace has no mailbox: add a 'gmail' connector with its IMAP secrets." };
}
