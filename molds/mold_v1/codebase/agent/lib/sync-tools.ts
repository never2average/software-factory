/**
 * sync-tools.ts — model-facing tools over the `syncs.ts` ingestion facade.
 *
 * `syncPullTool` pulls one upstream source into the data room (and, for
 * Customers-domain items, into the system of record). It writes to the shared
 * data room and possibly the SoR, so it is approval-gated with `once()`,
 * mirroring `upsertCustomerTool` / `dataroomWriteTool`.
 *
 * `listSyncsTool` is read-only (no approval): it lists the landed sync `.jsonl`
 * streams under a (domain, source?, customer?) prefix.
 *
 * Each is re-exported from a snake_case file under a `tools/` directory so the
 * model-facing tool name comes from the filename.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { jsonObjectSchema } from "#lib/dataroom-schema.js";
import { getDataroomStore } from "#lib/dataroom-store.js";
import { orgForSession } from "#lib/org-context.js";
import {
  ingestSource,
  SYNC_SOURCE_FOLDERS,
  type SyncDomain,
} from "#lib/syncs.js";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { fill } from "./agent-vocabulary.ts";

// The five dm.md domains that carry a `syncs/**` landing subtree.
const syncDomainSchema = z.enum(["Customers", "Platform", "Deployments", "Tickets", "People"]);

/**
 * The verified caller's email from the session auth, never from the model.
 * Mirrors agent/lib/tools.ts (those helpers are module-private there, so they
 * are duplicated here rather than exported — E2 does not own tools.ts).
 */
function callerEmail(ctx: {
  session?: {
    auth?: {
      current?: {
        principalId?: string;
        attributes?: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}): string | undefined {
  const caller = ctx.session?.auth?.current;
  const email = caller?.attributes?.email;
  if (typeof email === "string" && email.length > 0) return email;
  return caller?.principalId || undefined;
}

/** Narrow to an email-shaped string (for schema fields that require one). */
function emailOrUndefined(value: string | undefined): string | undefined {
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined;
}

export const syncPullTool = modelFacing("sync_pull", defineTool({
  description:
    "Pull one upstream source into the data room's dm.md syncs landing zone (one durable .jsonl stream per domain/source/customer/day), and, for the Customers domain, also record items as interactions in the system of record. Sources per domain: `Customers` {manual_entry, email, slack, granola}; `Platform` {manual_entry, github, aws, slack, miro}; `Deployments` {manual_entry, claude, codex, email, github, aws, azure, gcp, oci, bare_metal_*}; `Tickets` {manual_entry, call, email, slack}; `People` {manual_entry, email, slack, analytics, observability, granola}. manual_entry requires items[]; MCP-mediated sources (slack/github) require items[] fetched via their connection tools first; granola/email fetch themselves and degrade to a structured skip (ok:false) when unconfigured. Gated on approval since it writes the team's data room and possibly the source of truth.",
  approval: once(),
  inputSchema: z.object({
    domain: syncDomainSchema,
    customerId: z.string().min(1).describe(fill("{Account} id, e.g. 'acme-bank'.")),
    source: z
      .string()
      .min(1)
      .describe("dm.md syncs source for the domain, e.g. 'manual_entry', 'granola', 'email', 'slack'."),
    since: z.string().optional().describe("ISO date lower bound for fetched items."),
    query: z
      .string()
      .optional()
      .describe(fill("Search query for search-shaped sources (granola); defaults to the {account} id.")),
    items: z
      .array(jsonObjectSchema)
      .optional()
      .describe(
        "Raw items to land directly: required for manual_entry, and for MCP-mediated sources (slack/github) after fetching via their connection tools.",
      ),
    normalize: z
      .boolean()
      .optional()
      .describe("Also record Customers-domain items as interactions (default true)."),
  }),
  async execute(input, ctx) {
    return await ingestSource({
      ...input,
      recordedByEmail: emailOrUndefined(callerEmail(ctx)),
      // The caller's workspace, never the customer id's owner: a model-supplied id must not pick the data room.
      orgId: await orgForSession(ctx),
    });
  },
}));

export const listSyncsTool = modelFacing("list_syncs", defineTool({
  description:
    "List the landed sync .jsonl streams in the data room under a (domain, source?, customerId?) prefix. Read-only. Each returned path is one domain/source/customer/day raw stream produced by sync_pull.",
  inputSchema: z.object({
    domain: syncDomainSchema,
    source: z
      .string()
      .optional()
      .describe("Optional: logical source name to scope to (e.g. 'granola', 'manual_entry')."),
    customerId: z.string().optional().describe(fill("Optional: scope to a single {account} id.")),
  }),
  async execute({ domain, source, customerId }, ctx) {
    const folder = source ? SYNC_SOURCE_FOLDERS[domain as SyncDomain]?.[source] : undefined;
    const prefix = [domain, "syncs", source ? folder : undefined, customerId]
      .filter((seg): seg is string => Boolean(seg))
      .join("/");
    // Always the caller's workspace. Resolving it from a model-supplied customer id listed another workspace's
    // data room for that workspace's customer.
    const org = await orgForSession(ctx);
    return { prefix, paths: await getDataroomStore(org).list(prefix) };
  },
}));
