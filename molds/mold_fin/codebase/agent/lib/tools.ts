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
import { createDraft, listInbox } from "#lib/email.js";
import { runEmailIntake } from "#lib/email-intake.js";
import { getOnCall, pageOnCall } from "#lib/pagerduty.js";
import { searchExa } from "#lib/exa.js";
import { publishArtifact } from "#lib/artifact.js";
import { UNASSIGNED_OWNER_EMAIL as UNASSIGNED_TRIAGE_OWNER } from "./unassigned.ts";

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

export const publishArtifactTool = defineTool({
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
    const { url, pathname, expiresAt } = await publishArtifact({ filename, content: data, contentType });
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
});

export const webSearchTool = defineTool({
  description:
    "Search the web with Exa for current, external information — company/customer research, industry news, docs, competitors, anything not in the system of record. Returns titles, URLs, dates, and text snippets.",
  inputSchema: z.object({
    query: z.string().min(1),
    numResults: z.number().int().min(1).max(15).optional(),
  }),
  async execute({ query, numResults }) {
    return await searchExa(query, numResults ?? 6);
  },
});

/**
 * Keep only the rows belonging to the caller's workspace.
 *
 * These four queries span every customer by design ("across all customers"),
 * which was correct when there was one tenant and is a cross-tenant read now.
 * Scoping at the tool boundary rather than in each query is deliberate: it is
 * one place to be right, and it fails CLOSED — an org whose customer set can
 * not be read gets nothing rather than everything.
 */
async function scopeToOrg<T extends { customerId?: string; id?: string }>(
  rows: T[],
  ctx: Parameters<typeof orgForSession>[0],
): Promise<T[]> {
  const org = await orgForSession(ctx);
  if (!org) return rows;
  const mine = new Set((await listCustomers(org)).map((c) => c.id));
  return rows.filter((r) => mine.has(r.customerId ?? r.id ?? ""));
}

export const listCustomersTool = defineTool({
  description:
    "List all customers in the system of record with tier, lifecycle stage, status, FDE owner, open ticket count, and — for matching an inbound sender to a customer — companyDomain plus businessOwnerEmail/technicalOwnerEmail. Match an email sender by its domain against companyDomain, or its address against those contact emails.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { customers: await listCustomers(await orgForSession(ctx)) };
  },
});

export const getCustomerTool = defineTool({
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
});

export const upsertCustomerTool = defineTool({
  description:
    "Create or update a customer record in the system of record (Postgres when configured, bundled-JSON fallback otherwise). Only provided fields are changed; nested domains (platform, deployments, solutions, implementation, tickets, interactions) are upserted alongside the customer row. Gated on approval since this mutates the team's source of truth.",
  approval: once(),
  inputSchema: customerPatchSchema,
  async execute(patch, ctx) {
    /**
     * Stamp the WORKSPACE. Without it the row is written with a null org_id and
     * is invisible to every reader — the customer picker, the data room, the
     * ops surfaces — because they all filter by workspace. Sixty-six customers
     * were created this way and none of them showed up anywhere.
     */
    return { customer: await upsertCustomer(patch, await orgForSession(ctx)) };
  },
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

export const recordInteractionTool = defineTool({
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
    );
    return { ok: true, interactions: customer.interactions?.slice(0, 3) };
  },
});

export const recordInteractionsTool = defineTool({
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
    );
    return { ok: true, count: interactions.length, interactions: customer.interactions?.slice(0, 3) };
  },
});

export const listStaleCustomersTool = defineTool({
  description:
    "List OUT-OF-TOUCH customers: active accounts (Onboarding/Pilot/Contracting) with no logged interaction in the last `days` days (default 7) — i.e. deployments going quiet with limited/no recent progress. Returns each customer's lifecycle stage, status, one-line health summary, FDE owner, last-touch date, and daysQuiet, sorted most-stale first. Use this for the out-of-touch sweep.",
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
    return { staleCustomers: await scopeToOrg(await listStaleCustomers(days ?? 7), ctx) };
  },
});

export const readCustomerSlasTool = defineTool({
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
});

export const pageOncallTool = defineTool({
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
});

export const getOncallTool = defineTool({
  description:
    "Read who is currently on-call in PagerDuty (escalation policy, level, user, schedule). Use it to name the responder in a digest or before paging. Read-only; empty when PagerDuty read access isn't configured.",
  inputSchema: z.object({}),
  async execute() {
    return await getOnCall();
  },
});

export const listFdesTool = defineTool({
  description:
    "List the FDE (forward-deployed engineer) roster with live load. Reads every People/{id}/identity.json marked kind:'internal-fde' and joins the accounts each owns (customers.fde_owner) plus their open-ticket count — so you can see who owns what, who is unassigned, and who is overloaded vs their capacity target. Read-only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const org = await orgForSession(ctx);
    const store = getDataroomStore(org);
    const paths = await store.list("People");
    const identityPaths = paths.filter((p) => /^People\/[^/]+\/identity\.json$/.test(p));
    const fdes: Array<Record<string, unknown> & { email?: string; slug: string }> = [];
    await Promise.all(
      identityPaths.map(async (p) => {
        try {
          const content = await store.read(p);
          if (!content) return;
          const id = JSON.parse(content) as Record<string, unknown>;
          if (id.kind !== "internal-fde") return;
          fdes.push({ ...id, slug: p.split("/")[1] });
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
    const roster = fdes.map((f) => {
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
});

export const reassignOwnerTool = defineTool({
  description:
    "Reassign a customer's durable FDE owner (updates customers.fde_owner + the internal_staff solution_engineer row) and logs the change as an interaction. Gated on approval since it changes account ownership.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    newOwnerEmail: z.string().email(),
    ownerName: z.string().optional(),
  }),
  async execute({ customerId, newOwnerEmail, ownerName }, ctx) {
    const result = await reassignOwner(customerId, newOwnerEmail, ownerName);
    await recordInteraction(
      customerId,
      toInteractionRow(
        {
          date: new Date().toISOString(),
          type: "note",
          source: "manual",
          note: `FDE owner reassigned from ${result.previousOwner ?? "(none)"} to ${newOwnerEmail}.`,
        },
        emailOrUndefined(callerEmail(ctx)),
      ),
    );
    return { ok: true, ...result };
  },
});

export const createTicketTool = defineTool({
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
    ticketOwnerEmail: z.string().email().describe("The FDE who owns it — usually the customer's fde_owner."),
    ticketNextStep: z.string().min(1),
    sourceChannel: z.enum(["Email", "Slack", "Call", "Meeting", "In-App", "Zendesk"]).optional(),
    reportedByEmail: z.string().email().optional(),
    customerContactEmail: z.string().email().optional(),
    externalId: z.string().optional().describe("Dedup key, e.g. the email Message-ID."),
  }),
  async execute({ customerId, ...rest }) {
    const ticketId = `TCK-${nanoid(8)}`;
    const result = await createTicket({ ticketId, customerId, ...rest });
    return { ok: true, ...result };
  },
});

/** Placeholder owner for a draft when none is resolved — a human assigns the
 *  real FDE when promoting the draft, so intake never fails on owner lookup. */

export const runEmailIntakeTool = defineTool({
  description:
    "Run the FULL email intake in one deterministic step: read unread inbox mail (last `sinceDays` days), match each sender to a customer, and stage a Needs-Triage DRAFT ticket for every matched customer email (skips automated/no-reply; dedups by Message-ID). Returns { read, skipped, staged:[{ticketId,customerId,customerName,subject}], unmatched:[{sender,subject}] }. This IS the whole intake — do NOT also call email_list_inbox / match_customer_by_email / create_triage_ticket; just call this once and report its result.",
  inputSchema: z.object({
    sinceDays: z.number().int().min(1).max(30).optional().describe("How many days back to read (default 2)."),
    max: z.number().int().min(1).max(50).optional().describe("Max messages to process (default 20)."),
  }),
  async execute({ sinceDays, max }) {
    return await runEmailIntake({ sinceDays, max });
  },
});

export const matchCustomerByEmailTool = defineTool({
  description:
    "Deterministically match an inbound email sender to a customer — use this instead of scanning list_customers by eye. Exact (case-insensitive) match on a customer's business/technical/executive contact email, else (for a corporate, non-freemail sender) on company_domain. Returns { matched:true, customerId, customerName, fdeOwner, matchedOn } or { matched:false }. If matched:false, do NOT guess — route the sender to manual triage.",
  inputSchema: z.object({
    sender: z.string().min(3).describe("The sender's email address (a raw address or a 'Name <addr>' header form)."),
  }),
  async execute({ sender }) {
    return await matchCustomerByEmail(sender);
  },
});

export const createTriageTicketTool = defineTool({
  description:
    "Stage a DRAFT ticket in the triage queue (status is forced to 'Needs Triage') for a matched customer — this is how autonomous flows like email intake propose a ticket WITHOUT auto-filing a live one. NOT approval-gated: it can only ever create a draft, never a live ticket, so a human still approves it into 'Open' via promote_ticket. Idempotent on externalId (pass the email Message-ID so re-runs don't duplicate). Fill the fields provisionally from the source (e.g. the email) — a human corrects them on approval. ticketOwnerEmail is optional: omit it if you can't resolve the FDE owner and a human will assign it on approval.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    summary: z.string().min(1).describe("One-line ticket title (e.g. the email subject)."),
    description: z.string().optional().describe("Full detail (e.g. the email body)."),
    ticketType: z.enum(["Bug", "Config Change", "Feature Request", "Access Request", "Data Issue", "Migration", "Question", "Escalation"]),
    ticketCategory: z.enum(["Feature Request", "Bug Report", "Data Migration Request", "Configuration Change Request", "Workflow Customization Request"]),
    ticketPriority: z.enum(["P0-Critical", "P1-High", "P2-Medium", "P3-Low"]),
    ticketOwnerEmail: z.string().email().optional().describe("The FDE who would own it (the customer's fde_owner). Omit if unresolved — a human assigns it on approval."),
    ticketNextStep: z.string().min(1),
    sourceChannel: z.enum(["Email", "Slack", "Call", "Meeting", "In-App", "Zendesk"]).optional(),
    reportedByEmail: z.string().email().optional(),
    customerContactEmail: z.string().email().optional(),
    externalId: z.string().optional().describe("Dedup key, e.g. the email Message-ID."),
  }),
  async execute({ customerId, ticketOwnerEmail, ...rest }) {
    const ticketId = `TCK-${nanoid(8)}`;
    const result = await createTicket({
      ticketId,
      customerId,
      ...rest,
      ticketOwnerEmail: ticketOwnerEmail ?? UNASSIGNED_TRIAGE_OWNER,
      ticketStatus: "Needs Triage",
    });
    return { ok: true, ...result };
  },
});

export const promoteTicketTool = defineTool({
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
  async execute({ customerId, ticketId, toStatus }) {
    return { ticket: await setTicketStatus(customerId, ticketId, toStatus ?? "Open") };
  },
});

export const listTriageTicketsTool = defineTool({
  description:
    "List the triage queue — draft tickets awaiting approval (status 'Needs Triage') across all customers, e.g. those staged by email intake. Each carries the customer, summary, description, priority, owner, and source. Use this to review what to promote (approve) or resolve (discard).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { triageTickets: await scopeToOrg(await listTriageTickets(), ctx) };
  },
});

export const listUrgentTicketsTool = defineTool({
  description:
    "List OPEN, URGENT tickets across all customers from the tickets store — P0-Critical/P1-High priority, SLA at-risk/breached, or past their due date — ranked most-urgent first. Each ticket carries urgencyRank, customer, summary, DESCRIPTION (the reported metric signal — uptime/accuracy/throughput incidents live here), next step, openedAt, and ageHours (the measured TAT, for reconciling against a TAT SLA commitment), plus due date. Use this to prioritize whoever most needs a change and to reconcile SLA breaches from ticket data.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { urgentTickets: await scopeToOrg(await listUrgentTickets(), ctx) };
  },
});

export const listFollowupsTool = defineTool({
  description:
    "List open customer tickets/follow-ups across all customers (or one), sorted by the caller. Use this to prep the daily stand-up.",
  inputSchema: z.object({
    customerId: z.string().optional().describe("Optional: scope to a single customer."),
  }),
  async execute({ customerId }, ctx) {
    return { followUps: await scopeToOrg(await listFollowUps(customerId), ctx) };
  },
});

export const resolveFollowupTool = defineTool({
  description: "Mark a customer follow-up as done in the system of record.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    followUpId: z.string().min(1),
  }),
  async execute({ customerId, followUpId }) {
    return { resolved: await resolveFollowUp(customerId, followUpId) };
  },
});

export const emailListInboxTool = defineTool({
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
  async execute({ max, ...filters }) {
    return { emails: await listInbox({ ...filters, max: max ?? 10 }) };
  },
});

export const emailCreateDraftTool = defineTool({
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
  async execute(input) {
    const draft = await createDraft(input);
    return { created: true as const, mailbox: draft.mailbox, uid: draft.uid };
  },
});

export const granolaSearchNotesTool = defineTool({
  description:
    "Search Granola meeting notes by keyword to pull recent customer-call context and action items.",
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute({ query, limit }) {
    return await searchGranolaNotes(query, limit);
  },
});
