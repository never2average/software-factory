/**
 * Deterministic artifact-generation tools. Each is re-exported from a snake_case
 * file under a `tools/` directory (root or subagent) so the model-facing tool
 * name comes from the filename.
 *
 * These wrap the PURE, clock-injected renderers/builders (render-html.ts,
 * workbook-spec.ts) with the tool boundary as the single place the wall clock is
 * read — the libs themselves stay side-effect-free and offline-testable.
 *   - render_account_report: render a self-contained HTML report (one customer,
 *     or the all-customers data-room index) and PUBLISH it as a private,
 *     time-limited signed-link artifact. Needs BLOB_READ_WRITE_TOKEN at runtime
 *     (publishArtifact throws a self-describing error otherwise).
 *   - build_workbook_spec: return the deterministic `<Domain>/Master.xlsx`
 *     workbook spec(s) (sheet names, column headers, data rows) as JSON, to be
 *     serialized to .xlsx in the bash sandbox (openpyxl) and published via
 *     publish_artifact with the sandbox path. Needs no external configuration.
 *
 * Alias (`#lib/*.js`) imports are correct here — these run under the eve runtime,
 * not the strip-types offline tests (which is why the underlying libs use
 * relative `.ts` specifiers instead).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { renderAccountReport, renderDataroomSummary } from "#lib/render-html.js";
import {
  WORKBOOK_DOMAINS,
  buildCustomerWorkbookSpecs,
  buildDomainWorkbookSpec,
} from "#lib/workbook-spec.js";
import { publishArtifact } from "#lib/artifact.js";
import { modelFacing } from "./model-facing/tools/model-facing.ts";
import { fill } from "./agent-vocabulary.ts";
import { orgForSession } from "#lib/org-context.js";

/**
 * The verified caller's email from the session auth, never from the model.
 * Used to stamp who requested a published deliverable (audit trail). Returns
 * undefined when the surface is unauthenticated (e.g. local dev), so callers can
 * leave the field unset rather than forge one. (Duplicated verbatim from
 * agent/lib/tools.ts — the established pattern; this module may not edit tools.ts.)
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

export const renderAccountReportTool = modelFacing("render_account_report", defineTool({
  description:
    "Render a deterministic, self-contained HTML report for one {account} straight from the system of record (header, ranked open follow-ups, recent interactions, {deployments}, platform summary) and PUBLISH it via the private signed-link artifact path. Pass scope:'dataroom' for the all-{accounts} data-room index instead. Returns the signed url + expiresAt.",
  inputSchema: z.object({
    customerId: z
      .string()
      .min(1)
      .optional()
      .describe(fill("{Account} slug, e.g. 'acme-bank'. Required unless scope is 'dataroom'.")),
    scope: z.enum(["account", "dataroom"]).optional(),
  }),
  async execute({ customerId, scope }, ctx) {
    // The tool boundary is where the clock is read; the libs stay pure.
    const now = new Date().toISOString();
    const effectiveScope = scope ?? "account";
    // Both reports read the system of record in the CALLER's workspace. Unscoped, an account report rendered any
    // workspace's customer by id and the data-room index listed every workspace's customers.
    const orgId = await orgForSession(ctx);

    let html: string;
    let filename: string;
    if (effectiveScope === "dataroom") {
      html = await renderDataroomSummary({ now, orgId });
      filename = `dataroom-summary-${now.slice(0, 10)}.html`;
    } else {
      if (!customerId) {
        throw new Error("render_account_report requires `customerId` unless scope is 'dataroom'.");
      }
      html = await renderAccountReport({ customerId, now, orgId });
      filename = `${customerId}-account-report-${now.slice(0, 10)}.html`;
    }

    const { url, pathname, expiresAt } = await publishArtifact({ orgId, filename, content: html });
    return {
      published: true as const,
      url,
      // Stable identity, so a reader can re-sign once `url` expires.
      pathname,
      expiresAt,
      requestedBy: emailOrUndefined(callerEmail(ctx)),
      note: "Private signed link — expires at expiresAt.",
    };
  },
}));

export const buildWorkbookSpecTool = modelFacing("build_workbook_spec", defineTool({
  description:
    "Build the DETERMINISTIC workbook spec(s) for a {account} per docs/data-model.md: for each <Domain>/Master.xlsx the exact sheet names, column headers, and data rows from the system of record (Tickets carries Tickets + Interactions + derived Interaction Digest; People carries Internal Staff + Customer Stakeholders). Returns JSON to serialize verbatim to .xlsx in the bash sandbox with openpyxl (one sheet per SheetSpec, columns as row 1), then publish via publish_artifact with the sandbox path. Do NOT invent or reorder columns.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    domain: z
      .enum([...WORKBOOK_DOMAINS] as [string, ...string[]])
      .optional()
      .describe("One domain workbook; omit for all seven."),
  }),
  async execute({ customerId, domain }, ctx) {
    const now = new Date().toISOString();
    // The workbook is read in the caller's workspace; another workspace's customer id is "Unknown <account>".
    const orgId = await orgForSession(ctx);
    const specs = domain
      ? [
          await buildDomainWorkbookSpec({
            customerId,
            domain: domain as (typeof WORKBOOK_DOMAINS)[number],
            now,
            orgId,
          }),
        ]
      : await buildCustomerWorkbookSpecs({ customerId, now, orgId });
    return { customerId, workbooks: specs };
  },
}), { spokenOutput: ["name", "columns"] });
