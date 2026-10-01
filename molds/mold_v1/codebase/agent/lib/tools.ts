/**
 * Shared tool definitions. Each is re-exported from a snake_case file under a
 * `tools/` directory (root or subagent) so the model-facing tool name comes from
 * the filename. Centralizing the definitions here keeps the system-of-record
 * surface identical everywhere it is used.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  customerPatchSchema,
} from "#lib/customer-schema.js";
import {
  createTicket,
  getCustomer,
  listCustomers,
  listFollowUps,
  listStaleCustomers,
  listTriageTickets,
  listUrgentTickets,
  matchCustomerByEmail,
  reassignOwner,
  recordInteraction,
  recordInteractions,
  resolveFollowUp,
  setTicketStatus,
  upsertCustomer,
} from "#lib/system-of-record.js";
import { searchGranolaNotes } from "#lib/granola.js";
import { getDataroomStore } from "#lib/dataroom-store.js";
import { orgForSession } from "#lib/org-context.js";
import { getDb } from "#lib/db/index.js";
import { createDraft, listInbox } from "#lib/email.js";
import { runEmailIntake } from "#lib/email-intake.js";
import { getOnCall, pageOnCall } from "#lib/pagerduty.js";
import { searchExa } from "#lib/exa.js";
import { publishArtifact } from "#lib/artifact.js";
import { UNASSIGNED_OWNER_EMAIL as UNASSIGNED_TRIAGE_OWNER } from "./unassigned.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { HIDDEN_FIELDS, fill } from "./agent-vocabulary.ts";
import { customFieldsOf } from "./custom-fields.ts";
import { isMemberKind } from "./member-kind.ts";

/**
 * The verified caller's email from the session auth, never from the model.
 * Used to stamp who logged a write into the system of record (audit trail),
 * mirroring how the memory tools record each memory's author. Returns
 * undefined when the surface is unauthenticated (e.g. local dev), so callers
 * can leave the field unset rather than forge one.
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

export const publishArtifactTool = modelFacing("publish_artifact", defineTool({
  description:
    "Generate and PUBLISH an artifact, returning a PRIVATE, time-limited signed link (not a public URL — the blob is stored privately and the link expires). For TEXT artifacts (HTML report/dashboard, Markdown, CSV, SVG, JSON, plain text) pass `content`. For BINARY/OFFICE artifacts (.xlsx, .docx, .pptx, .pdf, images) GENERATE the file in the bash sandbox first (e.g. python openpyxl / python-docx / python-pptx / reportlab) and pass its sandbox `path` instead. Returns a signed https URL to hand back as a deliverable.",
  inputSchema: z.object({
    filename: z
      .string()
      .min(1)
      .describe("File name with extension, e.g. 'northwind-status.html' or 'accounts.xlsx'."),
    content: z
      .string()
      .optional()
      .describe("Full TEXT content (HTML, Markdown, CSV, SVG, JSON, text). Provide this OR path."),
    path: z
      .string()
      .optional()
      .describe(
        "Path in the bash sandbox to a file to publish, for binary/office artifacts (.xlsx/.docx/.pptx/.pdf/images). Provide this OR content.",
      ),
    contentType: z
      .string()
      .optional()
      .describe("Override the MIME type; inferred from the file extension by default."),
  }),
  async execute({ filename, content, path, contentType }, ctx) {
    let data: string | Buffer;
    if (path) {
      const sandbox = await ctx.getSandbox();
      const { stdout } = await sandbox.run({
        command: `base64 -w0 "${path}" 2>/dev/null || base64 "${path}"`,
      });
      data = Buffer.from(stdout.trim(), "base64");
    } else if (content != null && content.length > 0) {
      data = content;
    } else {
      throw new Error("publish_artifact requires either `content` (text) or `path` (a sandbox file).");
    }
    const { url, pathname, expiresAt } = await publishArtifact({ orgId: await orgForSession(ctx), filename, content: data, contentType });
    // `pathname` is the artifact's STABLE identity; `url` is only a credential
    // that expires. The console re-signs from the pathname when someone opens
    // the artifact later, so a stale link stops being a dead end.
    return {
      published: true as const,
      url,
      pathname,
      expiresAt,
      note: "Private signed link — expires at expiresAt.",
    };
  },
}), { opaqueInput: ["content"] });

export const webSearchTool = modelFacing("web_search", defineTool({
  description:
    "Search the web with Exa for current, external information — company/customer research, industry news, docs, competitors, anything not in the system of record. Returns titles, URLs, dates, and text snippets.",
  inputSchema: z.object({
    query: z.string().min(1),
    numResults: z.number().int().min(1).max(15).optional(),
  }),
  async execute({ query, numResults }) {
    return await searchExa(query, numResults ?? 6);
  },
}), { opaqueOutput: "*" });

/**
 * The caller's own rows of a list that spans "all customers", each query asked IN the caller's workspace.
 *
 * It used to run the query across every workspace and keep the rows whose customer id was in the caller's own
 * list. A company is keyed by (org_id, customer_id) now (mold_v1-118): two workspaces may both hold
 * `aditya-birla-hfl`, and the other one's tickets under that id passed an id filter. The query is scoped to the
 * workspace instead, and every row it returns must carry that workspace, or it is dropped (fails CLOSED: a caller
 * with no workspace gets nothing). The workspace is then taken off each row: the model's output is unchanged.
 */
async function ownRows<T extends { orgId?: string }>(
  ctx: Parameters<typeof orgForSession>[0],
  query: (org: string) => Promise<T[]>,
): Promise<Omit<T, "orgId">[]> {
  const org = await orgForSession(ctx);
  if (!org) return [];
  // Only the in-memory fallback (no database: one workspace, dev and tests) returns rows without a workspace.
  const untagged = !getDb();
  return (await query(org)).filter((r) => r.orgId === org || (untagged && r.orgId === undefined)).map(({ orgId: _org, ...rest }) => rest);
}

/**
 * The model's description of a record tool, without the nested parts the profile hides (`account_fields.hidden`):
 * the model is not told about a part it can neither read nor write. Passed to modelFacing as `modelDescription`;
 * the tool's own `description` stays a string literal, because scripts/gen-subagent-meta.mjs reads it from source
 * for the UI. Undefined when nothing is hidden, so the default deployment is unchanged.
 */
const shownParts = (parts: [key: string, words: string][]) => {
  const kept = parts.filter(([key]) => !HIDDEN_FIELDS.account.has(key)).map(([, words]) => words);
  return kept.length > 1 ? `${kept.slice(0, -1).join(", ")}, and ${kept.at(-1)}` : kept.join("");
};
const RECORD_PARTS = ["platform", "deployments", "solutions", "implementation", "tickets", "interactions"];
const hidesParts = RECORD_PARTS.some((k) => HIDDEN_FIELDS.account.has(k));

export const listCustomersTool = modelFacing("list_customers", defineTool({
  description:
    "List all customers in the system of record with tier, lifecycle stage, status, {owner}, open ticket count, and — for matching an inbound sender to a customer — companyDomain plus businessOwnerEmail/technicalOwnerEmail. Match an email sender by its domain against companyDomain, or its address against those contact emails.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { customers: await listCustomers(await orgForSession(ctx)) };
  },
}), { recordOutput: ["customers"] });

export const getCustomerTool = modelFacing("get_customer", defineTool({
  description:
    "Get the full record for one customer: platform config, deployments, solutions, implementation, tickets, and recent interactions.",
  inputSchema: z.object({
    id: z.string().min(1).describe("Customer id, e.g. 'acme-bank'."),
  }),
  async execute({ id }, ctx) {
    const customer = await getCustomer(id, await orgForSession(ctx));
    if (!customer) return { found: false as const, id };
    return { found: true as const, customer };
  },
}), {
  recordOutput: ["customer"],
  modelDescription: hidesParts
    ? `Get the full record for one customer: ${shownParts([["platform", "platform config"], ["deployments", "deployments"], ["solutions", "solutions"], ["implementation", "implementation"], ["tickets", "tickets"], ["interactions", "recent interactions"]])}.`
    : undefined,
});

/**
 * The account's own fields (`custom`, account_fields.custom_fields) are a parameter only when the profile declares
 * some: a deployment that declares none offers exactly the schema it did before the column existed (the default
 * model surface is held byte-identical by check:agent-vocabulary). The cast keeps the tool's input type the full
 * patch; at run time the narrower schema strips a `custom` the model was never offered.
 */
const accountFields = customFieldsOf("account");
// `custom_append` (add to a long note without resending it) likewise only when a long-text account field exists.
const upsertCustomerInput = (
  accountFields.some((f) => f.type === "long_text")
    ? customerPatchSchema
    : accountFields.length > 0
      ? customerPatchSchema.omit({ custom_append: true })
      : customerPatchSchema.omit({ custom: true, custom_append: true })
) as typeof customerPatchSchema;

export const upsertCustomerTool = modelFacing("upsert_customer", defineTool({
  description:
    "Create or update a customer record in the system of record (Postgres when configured, bundled-JSON fallback otherwise). Only the fields you send change. Nested records (platform, deployments, solutions, implementation, tickets, interactions) follow one rule: each row is matched on its id, only the fields you send change, a row you leave out is kept, and a row is deleted only by remove: true. Gated on approval since this mutates the team's source of truth.",
  approval: once(),
  inputSchema: upsertCustomerInput,
  async execute(patch, ctx) {
    /**
     * Stamp the WORKSPACE. Without it the row is written with a null org_id and
     * is invisible to every reader — the customer picker, the data room, the
     * ops surfaces — because they all filter by workspace. Sixty-six customers
     * were created this way and none of them showed up anywhere.
     */
    return { customer: await upsertCustomer(patch, await orgForSession(ctx)) };
  },
}), {
  // A profile's hidden fields are not offered to the model, and a stored hidden value survives its rewrite.
  recordInput: {},
  recordOutput: ["customer"],
  modelDescription: hidesParts
    ? `Create or update a customer record in the system of record (Postgres when configured, bundled-JSON fallback otherwise). Only the fields you send change. Nested records (${RECORD_PARTS.filter((k) => !HIDDEN_FIELDS.account.has(k)).join(", ")}) follow one rule: each row is matched on its id, only the fields you send change, a row you leave out is kept, and a row is deleted only by remove: true. Gated on approval since this mutates the team's source of truth.`
    : undefined,
});

/** The per-interaction fields shared by the single and batch record tools. */
const interactionInputShape = {
  date: z.string().describe("ISO date or datetime, e.g. '2026-07-07' or '2026-07-07T10:00:00Z'."),
  type: z.enum(["meeting", "email", "call", "slack", "note", "qbr", "support_review", "implementation_checkin"]),
  source: z.enum(["granola", "gmail", "slack", "salesforce", "zendesk", "manual", "other"]),
  summary: z.string().optional(),
  note: z.string().min(1),
  participantEmails: z.array(z.string().email()).optional(),
  relatedTicketIds: z.array(z.string()).optional(),
  relatedSolutionIds: z.array(z.string()).optional(),
  nextAction: z.string().optional(),
  nextActionOwnerEmail: z.string().email().optional(),
  nextActionDueDate: z.string().optional(),
} as const;

type InteractionInput = z.infer<z.ZodObject<typeof interactionInputShape>>;

/** Map a model-facing interaction input to a stored Interaction row. */
function toInteractionRow(input: InteractionInput, recordedByEmail: string | undefined) {
  const { date, type, source, ...rest } = input;
  return {
    interactionId: `INT-${nanoid(10)}`,
    interactionAt: date,
    interactionType: type,
    sourceSystem: source,
    recordedAt: new Date().toISOString(),
    // Stamp the verified caller so every interaction row records who logged it
    // (audit trail); left unset on unauthenticated surfaces. The schema requires
    // an email, so only stamp an email-shaped identity.
    recordedByEmail,
    ...rest,
  };
}

export const recordInteractionTool = modelFacing("record_interaction", defineTool({
  description:
    "Append ONE interaction (meeting, email, call, Slack thread) to a customer's history in the system of record (an interactions row in Postgres when configured, bundled-JSON fallback otherwise; also mirrored to the data room's Customers/{id}/interactions.jsonl document view). To log SEVERAL at once, use record_interactions (batch) instead of calling this repeatedly.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    ...interactionInputShape,
  }),
  async execute({ customerId, ...interaction }, ctx) {
    const customer = await recordInteraction(
      customerId,
      toInteractionRow(interaction, emailOrUndefined(callerEmail(ctx))),
      await orgForSession(ctx),
    );
    return { ok: true, interactions: customer.interactions?.slice(0, 3) };
  },
}));

export const recordInteractionsTool = modelFacing("record_interactions", defineTool({
  description:
    "Append MANY interactions to a single customer's history in ONE call (one batched write), instead of calling record_interaction repeatedly. Use this whenever you have more than one interaction to log for the same customer — e.g. backfilling a history or logging a batch of meetings/emails.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    interactions: z
      .array(z.object(interactionInputShape))
      .min(1)
      .describe("A non-empty list of interactions to append to this customer, oldest-to-newest."),
  }),
  async execute({ customerId, interactions }, ctx) {
    const email = emailOrUndefined(callerEmail(ctx));
    const customer = await recordInteractions(
      customerId,
      interactions.map((i) => toInteractionRow(i, email)),
      await orgForSession(ctx),
    );
    return { ok: true, count: interactions.length, interactions: customer.interactions?.slice(0, 3) };
  },
}));

export const listStaleCustomersTool = modelFacing("list_stale_customers", defineTool({
  description:
    "List OUT-OF-TOUCH customers: active accounts (Onboarding/Pilot/Contracting) with no logged interaction in the last `days` days (default 7) — i.e. deployments going quiet with limited/no recent progress. Returns each customer's lifecycle stage, status, one-line health summary, {owner}, last-touch date, and daysQuiet, sorted most-stale first. Use this for the out-of-touch sweep.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Staleness window in days (default 7): no interaction within this many days = out of touch."),
  }),
  async execute({ days }, ctx) {
    return { staleCustomers: await ownRows(ctx, (org) => listStaleCustomers(days ?? 7, org)) };
  },
}));

export const readCustomerSlasTool = modelFacing("read_customer_slas", defineTool({
  description:
    "Read EVERY customer's SLA agreement (Customers/{id}/agreements/sla.json) AND their Implementation customization footprint (Implementation/{id}/… paths) from the data room, and return a compound JSON. SLAs are streamlined into three tiers — INFRA (uptime/RPO/RTO), PLATFORM (performance/throughput), SOLUTIONS (accuracy/TAT, per agent/workflow). Use this to (a) COMPOSE per-customer urgency/breach filters from each customer's own commitments instead of one global rule, and (b) check whether that customer's Implementation VOIDS a commitment: a commitment marked voidableByCustomization whose service/scope (agentId/workflowId/deploymentId or tier) is customized in `customizations` is VOIDED — do not count it as a breach; surface it as 'SLA voided by customization'. Customers in `missing` have no sla.json — fall back to the platform default.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const org = await orgForSession(ctx);
    const store = getDataroomStore(org);
    const customers = await listCustomers(org);
    const slas: Record<string, unknown> = {};
    const customizations: Record<string, string[]> = {};
    const invalid: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      customers.map(async (c) => {
        // SLA agreement
        try {
          const content = await store.read(`Customers/${c.id}/agreements/sla.json`);
          if (content == null) {
            missing.push(c.id);
          } else {
            try {
              slas[c.id] = JSON.parse(content);
            } catch {
              invalid.push(c.id);
            }
          }
        } catch {
          missing.push(c.id);
        }
        // Implementation customization footprint (what may void an SLA).
        try {
          const paths = await store.list(`Implementation/${c.id}`);
          if (paths.length > 0) customizations[c.id] = paths;
        } catch {
          /* none */
        }
      }),
    );
    return {
      slas,
      customizations,
      missing,
      invalid,
      present: Object.keys(slas).length,
      total: customers.length,
    };
  },
}));

export const pageOncallTool = modelFacing("page_oncall", defineTool({
  description:
    "Page the current on-call via PagerDuty for a genuine incident — an SLA breach, P0/P1 production issue, or outage. Idempotent on dedupKey (pass the ticket id, so re-paging updates the same incident, never duplicates). Use action:'resolve' with the same dedupKey to close it. No-op with a clear message when PagerDuty isn't configured. Gated on approval since it pages a human.",
  approval: once(),
  inputSchema: z.object({
    summary: z.string().min(1).describe("What's wrong, one line."),
    dedupKey: z.string().min(1).describe("Stable key = the ticket id; dedups re-pages."),
    severity: z.enum(["critical", "error", "warning", "info"]).optional(),
    customerId: z.string().optional(),
    ticketId: z.string().optional(),
    action: z.enum(["trigger", "resolve"]).optional(),
  }),
  async execute(input) {
    return await pageOnCall(input);
  },
}));

export const getOncallTool = modelFacing("get_oncall", defineTool({
  description:
    "Read who is currently on-call in PagerDuty (escalation policy, level, user, schedule). Use it to name the responder in a digest or before paging. Read-only; empty when PagerDuty read access isn't configured.",
  inputSchema: z.object({}),
  async execute() {
    return await getOnCall();
  },
}));

export const listMembersTool = modelFacing("list_members", defineTool({
  description:
    "List the {member} roster with live load. Reads every People/{id}/identity.json marked as a team member (kind:'internal-member'; entries written before that carry an earlier kind and are read too) and joins the accounts each one owns plus their open-ticket count — so you can see who owns what, who is unassigned, and who is overloaded vs their capacity target. Read-only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const org = await orgForSession(ctx);
    const store = getDataroomStore(org);
    const paths = await store.list("People");
    const identityPaths = paths.filter((p) => /^People\/[^/]+\/identity\.json$/.test(p));
    const members: Array<Record<string, unknown> & { email?: string; slug: string }> = [];
    await Promise.all(
      identityPaths.map(async (p) => {
        try {
          const content = await store.read(p);
          if (!content) return;
          const id = JSON.parse(content) as Record<string, unknown>;
          if (!isMemberKind(id.kind)) return;
          members.push({ ...id, slug: p.split("/")[1] });
        } catch {
          /* skip unreadable */
        }
      }),
    );
    // Live load per owner email.
    const customers = await listCustomers(org);
    const load = new Map<string, { accounts: number; openTickets: number }>();
    for (const c of customers) {
      const owner = (c.fdeOwner ?? "").toLowerCase();
      if (!owner) continue;
      const cur = load.get(owner) ?? { accounts: 0, openTickets: 0 };
      cur.accounts += 1;
      cur.openTickets += c.openTickets;
      load.set(owner, cur);
    }
    const roster = members.map((f) => {
      const email = typeof f.email === "string" ? f.email.toLowerCase() : "";
      const l = load.get(email) ?? { accounts: 0, openTickets: 0 };
      return { ...f, accountsOwned: l.accounts, openTickets: l.openTickets };
    });
    // Accounts whose owner is not in the roster (dangling) or unset (unassigned).
    const rosterEmails = new Set(roster.map((r) => (typeof r.email === "string" ? r.email.toLowerCase() : "")));
    const unassigned = customers.filter((c) => !c.fdeOwner).map((c) => c.id);
    const danglingOwners = customers
      .filter((c) => c.fdeOwner && !rosterEmails.has(c.fdeOwner.toLowerCase()))
      .map((c) => ({ customerId: c.id, owner: c.fdeOwner }));
    return { roster, count: roster.length, unassigned, danglingOwners };
  },
}), { spokenOutput: ["kind"] });

export const reassignOwnerTool = modelFacing("reassign_owner", defineTool({
  description:
    "Reassign a customer's durable {owner} (updates the account's ownership and the internal_staff solution_engineer row) and logs the change as an interaction. Gated on approval since it changes account ownership.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    newOwnerEmail: z.string().email(),
    ownerName: z.string().optional(),
  }),
  async execute({ customerId, newOwnerEmail, ownerName }, ctx) {
    const org = await orgForSession(ctx);
    const result = await reassignOwner(customerId, newOwnerEmail, ownerName, org);
    await recordInteraction(
      customerId,
      toInteractionRow(
        {
          date: new Date().toISOString(),
          type: "note",
          source: "manual",
          note: `${fill("{Owner}")} reassigned from ${result.previousOwner ?? "(none)"} to ${newOwnerEmail}.`,
        },
        emailOrUndefined(callerEmail(ctx)),
      ),
      org,
    );
    return { ok: true, ...result };
  },
}));

export const createTicketTool = modelFacing("create_ticket", defineTool({
  description:
    "Create a ticket in the system of record for a customer — e.g. a customer doubt/error raised over email, an SLA breach, or an out-of-touch flag. Idempotent on externalId (pass an email Message-ID / stable key so re-runs don't duplicate — returns the existing ticket with created:false). Set ticketOwnerEmail to the customer's fde_owner. Gated on approval since it writes to the shared tickets store.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    summary: z.string().min(1).describe("One-line ticket title."),
    description: z.string().optional().describe("Full detail (e.g. the email body / error)."),
    ticketType: z.enum(["Bug", "Config Change", "Feature Request", "Access Request", "Data Issue", "Migration", "Question", "Escalation"]),
    ticketCategory: z.enum(["Feature Request", "Bug Report", "Data Migration Request", "Configuration Change Request", "Workflow Customization Request"]),
    ticketPriority: z.enum(["P0-Critical", "P1-High", "P2-Medium", "P3-Low"]),
    ticketStatus: z.enum(["Open", "Needs Triage", "In Progress", "Blocked", "Waiting on Customer"]).optional(),
    ticketOwnerEmail: z.string().email().describe(fill("The {member} who owns it — usually the customer's {owner}.")),
    ticketNextStep: z.string().min(1),
    sourceChannel: z.enum(["Email", "Slack", "Call", "Meeting", "In-App", "Zendesk"]).optional(),
    reportedByEmail: z.string().email().optional(),
    customerContactEmail: z.string().email().optional(),
    externalId: z.string().optional().describe("Dedup key, e.g. the email Message-ID."),
  }),
  async execute({ customerId, ...rest }, ctx) {
    const ticketId = `TCK-${nanoid(8)}`;
    const result = await createTicket({ ticketId, customerId, ...rest }, await orgForSession(ctx));
    return { ok: true, ...result };
  },
}));

/** Placeholder owner for a draft when none is resolved — a human assigns the
 *  real member when promoting the draft, so intake never fails on owner lookup. */

export const runEmailIntakeTool = modelFacing("run_email_intake", defineTool({
  description:
    "Run the FULL email intake in one deterministic step: read unread inbox mail (last `sinceDays` days), match each sender to a customer, and stage a Needs-Triage DRAFT ticket for every matched customer email (skips automated/no-reply; dedups by Message-ID). Returns { read, skipped, staged:[{ticketId,customerId,customerName,subject}], unmatched:[{sender,subject}] }. This IS the whole intake — do NOT also call email_list_inbox / match_customer_by_email / create_triage_ticket; just call this once and report its result.",
  inputSchema: z.object({
    sinceDays: z.number().int().min(1).max(30).optional().describe("How many days back to read (default 2)."),
    max: z.number().int().min(1).max(50).optional().describe("Max messages to process (default 20)."),
  }),
  async execute({ sinceDays, max }, ctx) {
    return await runEmailIntake({ sinceDays, max, orgId: await orgForSession(ctx) });
  },
}));

export const matchCustomerByEmailTool = modelFacing("match_customer_by_email", defineTool({
  description:
    "Deterministically match an inbound email sender to a customer — use this instead of scanning list_customers by eye. Exact (case-insensitive) match on a customer's business/technical/executive contact email, else (for a corporate, non-freemail sender) on company_domain. Returns { matched:true, customerId, customerName, fdeOwner, matchedOn } or { matched:false }. If matched:false, do NOT guess — route the sender to manual triage.",
  inputSchema: z.object({
    sender: z.string().min(3).describe("The sender's email address (a raw address or a 'Name <addr>' header form)."),
  }),
  async execute({ sender }, ctx) {
    return await matchCustomerByEmail(sender, await orgForSession(ctx));
  },
}));

export const createTriageTicketTool = modelFacing("create_triage_ticket", defineTool({
  description:
    "Stage a DRAFT ticket in the triage queue (status is forced to 'Needs Triage') for a matched customer — this is how autonomous flows like email intake propose a ticket WITHOUT auto-filing a live one. NOT approval-gated: it can only ever create a draft, never a live ticket, so a human still approves it into 'Open' via promote_ticket. Idempotent on externalId (pass the email Message-ID so re-runs don't duplicate). Fill the fields provisionally from the source (e.g. the email) — a human corrects them on approval. ticketOwnerEmail is optional: omit it if you can't resolve the {owner} and a human will assign it on approval.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    summary: z.string().min(1).describe("One-line ticket title (e.g. the email subject)."),
    description: z.string().optional().describe("Full detail (e.g. the email body)."),
    ticketType: z.enum(["Bug", "Config Change", "Feature Request", "Access Request", "Data Issue", "Migration", "Question", "Escalation"]),
    ticketCategory: z.enum(["Feature Request", "Bug Report", "Data Migration Request", "Configuration Change Request", "Workflow Customization Request"]),
    ticketPriority: z.enum(["P0-Critical", "P1-High", "P2-Medium", "P3-Low"]),
    ticketOwnerEmail: z.string().email().optional().describe(fill("The {member} who would own it (the customer's {owner}). Omit if unresolved — a human assigns it on approval.")),
    ticketNextStep: z.string().min(1),
    sourceChannel: z.enum(["Email", "Slack", "Call", "Meeting", "In-App", "Zendesk"]).optional(),
    reportedByEmail: z.string().email().optional(),
    customerContactEmail: z.string().email().optional(),
    externalId: z.string().optional().describe("Dedup key, e.g. the email Message-ID."),
  }),
  async execute({ customerId, ticketOwnerEmail, ...rest }, ctx) {
    const ticketId = `TCK-${nanoid(8)}`;
    const result = await createTicket({
      ticketId,
      customerId,
      ...rest,
      ticketOwnerEmail: ticketOwnerEmail ?? UNASSIGNED_TRIAGE_OWNER,
      ticketStatus: "Needs Triage",
    }, await orgForSession(ctx));
    return { ok: true, ...result };
  },
}));

export const promoteTicketTool = modelFacing("promote_ticket", defineTool({
  description:
    "Approve a draft ticket out of the triage queue: move a 'Needs Triage' ticket to an active status ('Open' by default). This is the human approval step for email-intake drafts — to discard one instead, resolve it. Gated on approval since it turns a proposal into a live ticket.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    ticketId: z.string().min(1).describe("The draft's ticket id (from list_triage_tickets)."),
    toStatus: z
      .enum(["Open", "In Progress", "Blocked", "Waiting on Customer"])
      .optional()
      .describe("Target status; defaults to Open."),
  }),
  async execute({ customerId, ticketId, toStatus }, ctx) {
    return { ticket: await setTicketStatus(customerId, ticketId, toStatus ?? "Open", await orgForSession(ctx)) };
  },
}));

export const listTriageTicketsTool = modelFacing("list_triage_tickets", defineTool({
  description:
    "List the triage queue — draft tickets awaiting approval (status 'Needs Triage') across all customers, e.g. those staged by email intake. Each carries the customer, summary, description, priority, owner, and source. Use this to review what to promote (approve) or resolve (discard).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { triageTickets: await ownRows(ctx, (org) => listTriageTickets(org)) };
  },
}));

export const listUrgentTicketsTool = modelFacing("list_urgent_tickets", defineTool({
  description:
    "List OPEN, URGENT tickets across all customers from the tickets store — P0-Critical/P1-High priority, SLA at-risk/breached, or past their due date — ranked most-urgent first. Each ticket carries urgencyRank, customer, summary, DESCRIPTION (the reported metric signal — uptime/accuracy/throughput incidents live here), next step, openedAt, and ageHours (the measured TAT, for reconciling against a TAT SLA commitment), plus due date. Use this to prioritize whoever most needs a change and to reconcile SLA breaches from ticket data.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { urgentTickets: await ownRows(ctx, (org) => listUrgentTickets(org)) };
  },
}));

export const listFollowupsTool = modelFacing("list_followups", defineTool({
  description:
    "List open customer tickets/follow-ups across all customers (or one), sorted by the caller. Use this to prep the daily stand-up.",
  inputSchema: z.object({
    customerId: z.string().optional().describe("Optional: scope to a single customer."),
  }),
  async execute({ customerId }, ctx) {
    return { followUps: await ownRows(ctx, (org) => listFollowUps(customerId, org)) };
  },
}));

export const resolveFollowupTool = modelFacing("resolve_followup", defineTool({
  description: "Mark a customer follow-up as done in the system of record.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    followUpId: z.string().min(1),
  }),
  async execute({ customerId, followUpId }, ctx) {
    return { resolved: await resolveFollowUp(customerId, followUpId, await orgForSession(ctx)) };
  },
}));

export const emailListInboxTool = modelFacing("email_list_inbox", defineTool({
  description:
    "List/search the inbox over IMAP. Filter by sender, subject, unread-only, and recency. Returns uid, from, to, subject, date, and messageId (use messageId as inReplyTo when drafting a reply).",
  inputSchema: z.object({
    from: z.string().optional().describe("Filter to a sender, e.g. 'northwind.com'."),
    subject: z.string().optional().describe("Filter by subject substring."),
    unseenOnly: z.boolean().optional().describe("Only unread messages."),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only messages newer than this many days."),
    max: z.number().int().min(1).max(50).optional(),
  }),
  async execute({ max, ...filters }, ctx) {
    return { emails: await listInbox({ ...filters, max: max ?? 10 }, await orgForSession(ctx)) };
  },
}), { opaqueOutput: "*" });

export const emailCreateDraftTool = modelFacing("email_create_draft", defineTool({
  description:
    "Create an email DRAFT via IMAP (appended to the Drafts mailbox). This never sends — the draft lands in Drafts for a human to review and send from their mail client. Pass inReplyTo (a message's messageId) to draft a threaded reply.",
  inputSchema: z.object({
    to: z.string().min(1).describe("Recipient email address(es)."),
    subject: z.string(),
    body: z.string().min(1),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    inReplyTo: z
      .string()
      .optional()
      .describe("RFC822 Message-ID of the message being replied to (from email_list_inbox)."),
  }),
  async execute(input, ctx) {
    const draft = await createDraft(input, await orgForSession(ctx));
    return { created: true as const, mailbox: draft.mailbox, uid: draft.uid };
  },
}));

export const granolaSearchNotesTool = modelFacing("granola_search_notes", defineTool({
  description:
    "Search Granola meeting notes by keyword to pull recent customer-call context and action items.",
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute({ query, limit }) {
    return await searchGranolaNotes(query, limit);
  },
}), { opaqueOutput: "*" });
