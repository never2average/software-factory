/**
 * Deployment signoff tools — the four-party infrastructure signoff chain that
 * gates customer-impacting deploys.
 *
 * dm.md addresses each signoff decision at:
 *
 *   Deployments/{customer_id}/{platform_version_id}/infrastructure/{component}/signoff/{signoff_role}.md
 *
 * where {component} is one of the eight infrastructure components and
 * {signoff_role} is one of the four parties (internal, customer.infra,
 * customer.infosec, customer.cloudvendor). Each file is a Markdown record with
 * a JSON-scalar YAML front matter block (the structured
 * deploymentSignoffRecordSchema fields) plus a human-readable note body.
 *
 * `record_signoff` writes one such file (once()-gated: it records an
 * authoritative approval decision, and stamps the verified caller for
 * internal signoffs). `get_signoff_status` reads the chain back, reports each
 * party's status per component, and computes chain completeness with the
 * canonical isSignoffChainComplete() helper.
 *
 * This module imports only the store, schema and versioning layers — never the
 * Group B dataroom-tools lib — so there is no cross-group build dependency.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { getDataroomStore } from "#lib/dataroom-store.js";
import { writeVersioned } from "#lib/dataroom-versions.js";
import { orgForCustomer } from "#lib/org-context.js";
import {
  deploymentSignoffRecordSchema,
  infrastructureComponentSchema,
  isSignoffChainComplete,
  signoffRoleSchema,
  signoffStatusSchema,
  type DeploymentSignoffRecord,
  type SignoffRole,
} from "#lib/dataroom-schema.js";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

// ---------------------------------------------------------------------------
// Verified caller (replicated locally to keep agent/lib/tools.ts untouched)
// ---------------------------------------------------------------------------

/**
 * The verified caller's email from the session auth, never from the model.
 * Used to stamp who recorded an internal signoff (audit trail). Returns
 * undefined on unauthenticated surfaces so the field is left unset rather than
 * forged. This intentionally duplicates the unexported helper in
 * agent/lib/tools.ts, which Group C must not edit.
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

// ---------------------------------------------------------------------------
// Markdown <-> record (JSON-scalar YAML front matter, unambiguous round-trip)
// ---------------------------------------------------------------------------

/** Fields, in a stable emit order, carried in the front matter. */
const FRONT_MATTER_FIELDS: readonly (keyof DeploymentSignoffRecord)[] = [
  "customerId",
  "platformVersionId",
  "component",
  "role",
  "status",
  "approverName",
  "approverEmail",
  "approverOrg",
  "requestedAt",
  "decidedAt",
  "expiresAt",
  "documentPath",
  "evidenceUrl",
  "conditions",
  "notes",
];

function signoffPath(
  customerId: string,
  platformVersionId: string,
  component: string,
  role: string,
): string {
  return `Deployments/${customerId}/${platformVersionId}/infrastructure/${component}/signoff/${role}.md`;
}

/** Render a validated record to Markdown: JSON-scalar YAML front matter + body. */
function renderSignoffMarkdown(record: DeploymentSignoffRecord): string {
  const lines: string[] = ["---"];
  for (const field of FRONT_MATTER_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${field}:`);
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
    } else {
      lines.push(`${field}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---", "");
  lines.push(`# Signoff — ${record.component} / ${record.role} — ${record.status}`, "");
  lines.push(record.notes && record.notes.length > 0 ? record.notes : "_(no note)_");
  return `${lines.join("\n")}\n`;
}

/** Parse the front matter of a signoff Markdown file back into a raw object. */
function parseSignoffFrontMatter(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("signoff record is missing its YAML front matter opener");
  }
  const raw: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const arrayItem = /^\s+-\s+(.*)$/.exec(line);
    if (arrayItem && currentArrayKey) {
      (raw[currentArrayKey] as unknown[]).push(JSON.parse(arrayItem[1]));
      continue;
    }
    const scalar = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!scalar) continue;
    const [, key, rest] = scalar;
    if (rest === "") {
      raw[key] = [];
      currentArrayKey = key;
    } else {
      raw[key] = JSON.parse(rest);
      currentArrayKey = null;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// record_signoff
// ---------------------------------------------------------------------------

export const recordSignoffTool = modelFacing("record_signoff", defineTool({
  description:
    "Record an authoritative deployment signoff decision for one infrastructure component and one party of the four-party chain (internal, customer.infra, customer.infosec, customer.cloudvendor). Writes the dm.md signoff/{party}.md record under Deployments/{customerId}/{platformVersionId}/infrastructure/{component}/signoff/. approved/rejected decisions must carry a decision date and signer email; internal signoffs default the signer email to the verified caller. Gated on approval since it records an authoritative approval decision.",
  approval: once(),
  inputSchema: z.object({
    customerId: z.string().min(1),
    platformVersionId: z.string().min(1),
    component: infrastructureComponentSchema.describe(
      "Infrastructure component: network | compute | storage | inference | agents | database | observability | autoscale.",
    ),
    party: signoffRoleSchema.describe(
      "Signoff party: internal | customer.infra | customer.infosec | customer.cloudvendor.",
    ),
    status: signoffStatusSchema.describe(
      "not_requested | requested | in_review | approved | rejected | waived.",
    ),
    signerName: z.string().optional(),
    signerEmail: z.string().email().optional(),
    signerOrg: z.string().optional(),
    date: z
      .string()
      .optional()
      .describe("ISO decision/request timestamp; defaults to now."),
    note: z.string().optional(),
    conditions: z.array(z.string()).optional(),
    evidenceUrl: z.string().url().optional(),
  }),
  async execute(input, ctx) {
    const {
      customerId,
      platformVersionId,
      component,
      party,
      status,
      signerName,
      signerEmail,
      signerOrg,
      date,
      note,
      conditions,
      evidenceUrl,
    } = input;

    const documentPath = signoffPath(customerId, platformVersionId, component, party);
    const when = date ?? new Date().toISOString();
    const decided = status === "approved" || status === "rejected";

    // internal signoffs default the signer email to the verified caller.
    const approverEmail =
      signerEmail ??
      (party === "internal" ? emailOrUndefined(callerEmail(ctx)) : undefined);

    // deploymentSignoffRecordSchema.refine enforces that approved/rejected
    // carry decidedAt + approverEmail; validation throws otherwise so the model
    // can supply the missing signer email.
    const record = deploymentSignoffRecordSchema.parse({
      customerId,
      platformVersionId,
      component,
      role: party,
      status,
      approverName: signerName,
      approverEmail,
      approverOrg: signerOrg,
      requestedAt: decided ? undefined : when,
      decidedAt: decided ? when : undefined,
      documentPath,
      evidenceUrl,
      conditions: conditions && conditions.length > 0 ? conditions : undefined,
      notes: note,
    });

    // Versioned: a signoff file is re-written each time a party moves, and the
    // previous decision is exactly what an audit asks for afterwards.
    await writeVersioned({
      orgId: await orgForCustomer(customerId),
      path: documentPath,
      content: renderSignoffMarkdown(record),
      actor: callerEmail(ctx) ?? "agent",
    });
    return { recorded: true as const, path: documentPath, status };
  },
}));

// ---------------------------------------------------------------------------
// get_signoff_status
// ---------------------------------------------------------------------------

interface PartyReport {
  status: string;
  approverName?: string;
  approverEmail?: string;
  approverOrg?: string;
  requestedAt?: string;
  decidedAt?: string;
  documentPath?: string;
}

interface ComponentReport {
  component: string;
  complete: boolean;
  parties: Record<SignoffRole, PartyReport>;
}

export const getSignoffStatusTool = modelFacing("get_signoff_status", defineTool({
  description:
    "Read the deployment signoff chain for a deployment and report each party's status per infrastructure component, plus whether each component's four-party chain is complete (every party approved or waived). Parties with no record report as not_requested. Omit component to report every component that has signoff records.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    platformVersionId: z.string().min(1),
    component: infrastructureComponentSchema
      .optional()
      .describe("Omit to report every component that has signoff records."),
  }),
  async execute({ customerId, platformVersionId, component }) {
    const store = getDataroomStore(await orgForCustomer(customerId));
    const prefix = `Deployments/${customerId}/${platformVersionId}/infrastructure`;
    const paths = await store.list(prefix);

    const wantSignoff = component
      ? `/infrastructure/${component}/signoff/`
      : "/signoff/";
    const signoffPaths = paths.filter(
      (p) => p.includes(wantSignoff) && p.endsWith(".md"),
    );

    const byComponent = new Map<string, DeploymentSignoffRecord[]>();
    for (const path of signoffPaths) {
      const text = await store.read(path);
      if (text === null) continue;
      const record = deploymentSignoffRecordSchema.parse(parseSignoffFrontMatter(text));
      const bucket = byComponent.get(record.component);
      if (bucket) bucket.push(record);
      else byComponent.set(record.component, [record]);
    }

    const components: ComponentReport[] = [];
    for (const [comp, records] of [...byComponent.entries()].sort()) {
      const parties = {} as Record<SignoffRole, PartyReport>;
      for (const role of signoffRoleSchema.options) {
        parties[role] = { status: "not_requested" };
      }
      for (const record of records) {
        parties[record.role] = {
          status: record.status,
          approverName: record.approverName,
          approverEmail: record.approverEmail,
          approverOrg: record.approverOrg,
          requestedAt: record.requestedAt,
          decidedAt: record.decidedAt,
          documentPath: record.documentPath,
        };
      }
      // Canonical completeness: every one of the four parties approved/waived.
      const complete = isSignoffChainComplete({
        customerId,
        platformVersionId: records[0].platformVersionId,
        component: records[0].component,
        records,
      });
      components.push({ component: comp, complete, parties });
    }

    return { customerId, platformVersionId, components };
  },
}));
