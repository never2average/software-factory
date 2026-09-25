/**
 * Deterministic workbook-spec builder for the customer data room.
 *
 * PURE + clock-injected: every export is a side-effect-free function of the
 * system of record (plus the bundled people seed) and an injected `now`; it
 * reads nothing from the wall clock. Relative `.ts` imports (never `#lib/*.js`
 * aliases) so the offline strip-types tests
 * (`node --experimental-strip-types scripts/test-workbook-spec.mjs`) resolve —
 * `node --experimental-strip-types` does not resolve the package `#lib/*.js`
 * subpath imports.
 *
 * A "spec" is DATA, not display: it names each `<Domain>/Master.xlsx` workbook,
 * its sheets, the exact snake_case column headers (transcribed verbatim from the
 * canonical head arrays in `app/_components/dataroom.tsx`, which match
 * `docs/data-model.md` and the Zod field order in `./customer-schema.ts`), and
 * one `CellValue[]` per row. A downstream renderer serializes this straight to
 * `.xlsx` (columns as row 1). Cell normalization is fixed and display-free:
 *   - strings / numbers        -> passed through unchanged (numbers stay numbers)
 *   - booleans                 -> "true" / "false"
 *   - string arrays            -> `values.join(", ")` when non-empty, else null
 *   - absent (undefined/null)  -> null
 *
 * `now` is threaded through the public API but is currently only RESERVED: the
 * interaction digest is derived purely from the stored interaction rows, so the
 * output does not depend on the clock. It is kept in the signature so a future
 * as-of / freshness column can be added without a breaking change.
 */
import {
  getCustomer,
} from "./system-of-record.ts";
import {
  peopleStoreSchema,
  type Customer,
  type Interaction,
} from "./customer-schema.ts";
import { readFileSync } from "node:fs";
import { compatEnv } from "./compat-env.ts";
import { samplePeople } from "./sample-data.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type CellValue = string | number | null;

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: CellValue[][];
}

export type WorkbookDomain =
  | "Customers"
  | "Platform"
  | "Deployments"
  | "Solutions"
  | "Implementation"
  | "Tickets"
  | "People";

/** Fixed data-model order (docs/data-model.md workbook table). */
export const WORKBOOK_DOMAINS: readonly WorkbookDomain[] = [
  "Customers",
  "Platform",
  "Deployments",
  "Solutions",
  "Implementation",
  "Tickets",
  "People",
] as const;

export interface WorkbookSpec {
  workbook: `${WorkbookDomain}/Master.xlsx`;
  domain: WorkbookDomain;
  sheets: SheetSpec[];
}

/* -------------------------------------------------------------------------- */
/* People seed — parsed once through the canonical Zod contract                */
/* -------------------------------------------------------------------------- */

/**
 * The no-database fallback's people, with a TEST-ONLY override.
 *
 * None by default: the sample staff and stakeholders (data/sample/people.json)
 * are read only in a local demo (DEMO_SAMPLE_DATA=1, ./sample-data.ts). There
 * is no upsert path for people a test can seed through, so
 * WORKSPACE_PEOPLE_SEED (once FDE_PEOPLE_SEED) lets a test point at its own
 * fixture. It is read once, at module load, and is never set in production.
 */
const peopleSeed = peopleStoreSchema.parse(
  compatEnv("WORKSPACE_PEOPLE_SEED")
    ? JSON.parse(readFileSync(compatEnv("WORKSPACE_PEOPLE_SEED") as string, "utf8"))
    : samplePeople(),
);

/* -------------------------------------------------------------------------- */
/* Canonical column arrays (verbatim from app/_components/dataroom.tsx)        */
/* -------------------------------------------------------------------------- */

const CUSTOMERS_COLUMNS = [
  "customer_id",
  "customer_name",
  "tier",
  "lifecycle_stage",
  "status",
  "health_score",
  "fde_owner",
  "ae_owner",
  "arr",
  "arr_currency",
  "seats",
  "external_account_id",
  "legal_entity_name",
  "account_region",
  "contract_status",
  "renewal_forecast",
  "renewal_risk_reason",
  "expansion_potential_arr",
  "health_reason",
  "company_domain",
  "vertical",
  "regulatory_profile",
  "business_owner_email",
  "technical_owner_email",
  "executive_sponsor_email",
  "value_realization_stage",
  "target_annual_value",
  "realized_annual_value",
  "success_criteria",
  "value_period_start",
  "value_period_end",
  "value_evidence_status",
  "value_evidence_url",
  "last_business_review_date",
  "next_business_review_date",
  "contract_start",
  "renewal_date",
  "industry_segment",
] as const;

const PLATFORM_COLUMNS = [
  "customer_id",
  "tenant_id",
  "platform_config_status",
  "deployment_model",
  "data_residency_constraint",
  "auth_mode",
  "data_classification",
  "pii_handling",
  "audit_logging_enabled",
  "retention_days",
  "ai_governance_status",
  "model_policy_id",
  "allowed_model_providers",
  "model_data_use_policy",
  "inference_region",
  "cross_border_processing_allowed",
  "guardrail_policy",
  "guardrail_policy_version",
  "guardrail_enforcement_mode",
  "prompt_logging_mode",
  "customer_managed_key_enabled",
  "kms_key_ref",
  "scim_provisioning_enabled",
  "rbac_policy",
  "audit_log_sink",
  "observability_enabled",
  "primary_model",
  "fallback_model",
  "minimum_eval_score_pct",
  "last_governance_review_at",
  "monthly_spend_limit_usd",
  "enabled_connectors",
  "feature_flags",
  "primary_use_case",
  "last_health_check_at",
] as const;

const DEPLOYMENTS_COLUMNS = [
  "customer_id",
  "deployment_id",
  "environment",
  "region",
  "cloud_provider",
  "runtime",
  "deployment_strategy",
  "deployed_version",
  "release_id",
  "release_channel",
  "build_sha",
  "runtime_version",
  "config_version",
  "approved_by_email",
  "approved_at",
  "model_route_id",
  "model_routing_mode",
  "primary_model_ref",
  "primary_model_version",
  "fallback_model_ref",
  "fallback_model_version",
  "model_traffic_primary_pct",
  "last_deploy_at",
  "release_status",
  "rollback_version",
  "rollback_status",
  "rollback_tested_at",
  "health_status",
  "uptime_30d_pct",
  "error_rate_30d_pct",
  "latency_p95_ms",
  "latency_slo_ms",
  "request_count_30d",
  "llm_request_count_30d",
  "input_tokens_30d",
  "output_tokens_30d",
  "cache_hit_rate_30d_pct",
  "guardrail_block_rate_30d_pct",
  "cost_30d_usd",
  "cost_budget_30d_usd",
  "projected_cost_30d_usd",
  "capacity_limit_rpm",
  "peak_rpm_30d",
  "utilization_30d_pct",
  "live_url",
  "deploy_owner_email",
  "last_incident_ref",
  "active_incident_refs",
  "incident_count_30d",
  "dashboard_url",
  "runbook_url",
  "last_telemetry_at",
  "notes",
] as const;

const SOLUTIONS_COLUMNS = [
  "solution_id",
  "customer_id",
  "use_case",
  "workflow_id",
  "workflow_name",
  "business_process",
  "business_unit",
  "primary_user_role",
  "workflow_owner_email",
  "risk_owner_email",
  "workflow_frequency",
  "decision_impact",
  "upstream_systems",
  "downstream_systems",
  "output_artifacts",
  "sensitive_data_types",
  "value_metric",
  "value_metric_unit",
  "value_metric_direction",
  "measurement_source",
  "measurement_window_days",
  "baseline_metric_value",
  "current_metric_value",
  "target_metric_value",
  "baseline_period_start",
  "baseline_period_end",
  "current_period_start",
  "current_period_end",
  "target_date",
  "value_evidence_url",
  "annualized_value_realized_usd",
  "value_realization_confidence_pct",
  "solution_value_realization_stage",
  "modules_enabled",
  "solution_status",
  "solution_go_live_date",
  "weekly_active_users",
  "weekly_query_volume",
  "automation_rate_pct",
  "human_review_rate_pct",
  "production_readiness_score",
  "solution_eval_score_pct",
  "eval_status",
  "eval_suite_id",
  "eval_dataset_version",
  "last_eval_run_id",
  "last_eval_run_at",
  "eval_pass_rate_pct",
  "eval_coverage_pct",
  "task_success_rate_pct",
  "answer_acceptance_rate_pct",
  "groundedness_score_pct",
  "citation_coverage_pct",
  "hallucination_rate_pct",
  "policy_violation_rate_pct",
  "guardrail_intervention_rate_pct",
  "customer_reported_defects_30d",
  "safety_incident_count_30d",
  "human_review_policy",
  "review_sla_hours",
  "review_sla_attainment_pct",
  "review_backlog_count",
  "readiness_status",
  "readiness_gate_failures",
  "model_risk_approval_status",
  "runbook_url",
  "solution_next_step",
  "last_eval_run",
  "value_delivered",
  "expansion_opportunity",
  "expansion_stage",
  "expansion_potential_annual_value_usd",
  "expansion_confidence_pct",
  "solution_fde_owner",
  "last_reviewed_date",
] as const;

const IMPLEMENTATION_COLUMNS = [
  "customer_id",
  "rollout_id",
  "launch_scope_solution_ids",
  "implementation_stage",
  "implementation_owner_email",
  "rollout_governance_status",
  "customer_launch_approver_email",
  "provider_launch_approver_email",
  "launch_decision",
  "launch_decision_date",
  "implementation_progress_pct",
  "implementation_risk_level",
  "data_readiness_pct",
  "integration_readiness_pct",
  "data_source_inventory_status",
  "data_access_status",
  "data_quality_status",
  "connector_provisioning_status",
  "integration_test_status",
  "security_review_status",
  "privacy_review_status",
  "eval_acceptance_status",
  "acceptance_evidence_link",
  "uat_status",
  "training_status",
  "launch_criteria",
  "launch_criteria_status",
  "go_live_confidence_pct",
  "target_go_live_date",
  "actual_go_live_date",
  "launch_window_start_at",
  "launch_window_end_at",
  "runbook_status",
  "runbook_link",
  "support_handoff_status",
  "support_owner_email",
  "support_channel_ref",
  "billing_readiness_status",
  "entitlement_provisioning_status",
  "billing_start_date",
  "current_milestone",
  "current_milestone_due_date",
  "blocker",
  "blocker_owner",
  "blocker_severity",
  "blocked_since_date",
  "risk_mitigation_plan",
  "critical_blocker_ticket_ids",
  "open_blocker_count",
  "implementation_next_step",
  "implementation_last_updated_at",
] as const;

const TICKETS_COLUMNS = [
  "ticket_id",
  "customer_id",
  "summary",
  "description",
  "affected_schema",
  "affected_solution_id",
  "affected_deployment_id",
  "affected_environment",
  "affected_workflow_id",
  "affected_connector",
  "affected_model",
  "affected_data_source",
  "related_ticket_ids",
  "external_system",
  "external_id",
  "ticket_type",
  "ticket_category",
  "ticket_status",
  "ticket_priority",
  "severity",
  "support_queue",
  "owner_team",
  "reported_by_email",
  "customer_contact_email",
  "ticket_opened_date",
  "triaged_at",
  "ticket_due_date",
  "sla_due_at",
  "first_response_due_at",
  "first_responded_at",
  "resolution_due_at",
  "sla_status",
  "escalated",
  "escalated_at",
  "escalation_level",
  "escalation_reason",
  "ticket_owner_email",
  "source_channel",
  "last_activity_date",
  "source_link",
  "escalation_owner_email",
  "production_impact",
  "customer_impact_level",
  "customer_impact_summary",
  "affected_user_count",
  "issue_domain",
  "model_issue_type",
  "data_issue_type",
  "integration_issue_type",
  "root_cause_status",
  "root_cause_category",
  "root_cause_summary",
  "detected_at",
  "mitigated_at",
  "remediation_summary",
  "preventive_actions",
  "postmortem_required",
  "postmortem_status",
  "postmortem_owner_email",
  "postmortem_due_date",
  "postmortem_url",
  "tags",
  "resolution_summary",
  "resolved_at",
  "ticket_next_step",
] as const;

const INTERACTIONS_COLUMNS = [
  "interaction_id",
  "customer_id",
  "interaction_at",
  "interaction_type",
  "source_system",
  "source_id",
  "source_link",
  "summary",
  "note",
  "outcome",
  "participant_emails",
  "related_ticket_ids",
  "related_solution_ids",
  "related_deployment_ids",
  "next_action",
  "next_action_owner_email",
  "next_action_due_date",
  "sentiment",
  "sensitivity",
  "recorded_by_email",
  "recorded_at",
] as const;

const INTERNAL_STAFF_COLUMNS = [
  "customer_id",
  "staff_role",
  "name",
  "title",
  "employer_org",
  "email",
  "last_contact",
] as const;

const CUSTOMER_STAKEHOLDERS_COLUMNS = [
  "customer_id",
  "stakeholder_role",
  "name",
  "title",
  "employer_org",
  "email",
  "last_contact",
] as const;

const INTERACTION_DIGEST_COLUMNS = [
  "customer_id",
  "customer_name",
  "interactions",
  "date_range",
  "last_touch",
  "open_next_actions",
  "sentiment",
  "digest",
] as const;

/* -------------------------------------------------------------------------- */
/* Cell normalization + column->field mapping                                  */
/* -------------------------------------------------------------------------- */

/** snake_case column -> the camelCase entity field it was derived from. */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Deterministic, display-free cell coercion (see module doc). */
function normalizeCell(value: unknown): CellValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((v) => String(v)).join(", ") : null;
  }
  // Objects are never expected as leaf cells; stringify defensively.
  return String(value);
}

/**
 * Map one entity `source` to a row for `columns`. `customer_id` always resolves
 * to the parent customer id and `customer_name` to the parent customer name;
 * every other column snake->camel-maps directly onto a `source` field.
 */
function mapRow(
  columns: readonly string[],
  source: Record<string, unknown>,
  customerId: string,
  customerName: string,
): CellValue[] {
  return columns.map((col) => {
    if (col === "customer_id") return customerId;
    if (col === "customer_name") return normalizeCell(customerName);
    return normalizeCell(source[snakeToCamel(col)]);
  });
}

/* -------------------------------------------------------------------------- */
/* Interaction digest (mirrors dataroom.tsx interactionDigest)                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive the single Interaction Digest row for a customer: a plain-text
 * narrative summary of every interaction. Mirrors the derivation in
 * `app/_components/dataroom.tsx`. `interactions`/`open_next_actions` are numbers.
 */
export function deriveInteractionDigestRow(customer: Customer): CellValue[] {
  const day = (s?: string): string | undefined => (s ? s.slice(0, 10) : undefined);
  const list: Interaction[] = (customer.interactions ?? [])
    .slice()
    .sort((a, b) => String(a.interactionAt ?? "").localeCompare(String(b.interactionAt ?? "")));

  if (list.length === 0) {
    return [customer.id, customer.name, 0, null, null, 0, null, "No interactions logged yet."];
  }

  const dates = list.map((i) => i.interactionAt).filter(Boolean) as string[];
  const first = day(dates[0]);
  const last = day(dates.at(-1));
  const range = first && last ? (first === last ? first : `${first} → ${last}`) : undefined;
  const lastI = list[list.length - 1];
  const openActions = list.filter((i) => i.nextAction);
  const sentiment = [...list].reverse().find((i) => i.sentiment)?.sentiment;

  const lead = `${list.length} interaction${list.length === 1 ? "" : "s"}${
    range ? ` from ${range}` : ""
  }${sentiment ? `, most recent sentiment ${sentiment}` : ""}.`;
  const timeline = list
    .map(
      (i) =>
        `${day(i.interactionAt) ?? "—"} · ${i.interactionType ?? "touchpoint"}${
          i.summary ? ` — ${i.summary}` : i.note ? ` — ${i.note}` : ""
        }`,
    )
    .join("\n");
  const recent = `Most recent — ${lastI.interactionType ?? "touchpoint"}${
    lastI.interactionAt ? ` on ${day(lastI.interactionAt)}` : ""
  }: ${lastI.summary ?? lastI.note ?? "no summary"}${lastI.sentiment ? ` (${lastI.sentiment})` : ""}.`;
  const actionsLine = openActions.length
    ? `${openActions.length} open next action${
        openActions.length === 1 ? "" : "s"
      }: ${openActions.map((a) => a.nextAction).join("; ")}.`
    : "No open next actions.";

  return [
    customer.id,
    customer.name,
    list.length,
    range ?? null,
    day(lastI.interactionAt) ?? null,
    openActions.length,
    sentiment ?? null,
    `${lead}\n\n${timeline}\n\n${recent} ${actionsLine}`,
  ];
}

/* -------------------------------------------------------------------------- */
/* Per-domain sheet builders                                                  */
/* -------------------------------------------------------------------------- */

function domainSheets(customer: Customer, domain: WorkbookDomain): SheetSpec[] {
  const cid = customer.id;
  const cname = customer.name;
  switch (domain) {
    case "Customers":
      return [
        {
          name: "Customers",
          columns: [...CUSTOMERS_COLUMNS],
          rows: [mapRow(CUSTOMERS_COLUMNS, customer as Record<string, unknown>, cid, cname)],
        },
      ];
    case "Platform":
      return [
        {
          name: "Platform",
          columns: [...PLATFORM_COLUMNS],
          rows: customer.platform
            ? [mapRow(PLATFORM_COLUMNS, customer.platform as Record<string, unknown>, cid, cname)]
            : [],
        },
      ];
    case "Deployments":
      return [
        {
          name: "Deployments",
          columns: [...DEPLOYMENTS_COLUMNS],
          rows: (customer.deployments ?? []).map((d) =>
            mapRow(DEPLOYMENTS_COLUMNS, d as Record<string, unknown>, cid, cname),
          ),
        },
      ];
    case "Solutions":
      return [
        {
          name: "Solutions",
          columns: [...SOLUTIONS_COLUMNS],
          rows: (customer.solutions ?? []).map((s) =>
            mapRow(SOLUTIONS_COLUMNS, s as Record<string, unknown>, cid, cname),
          ),
        },
      ];
    case "Implementation":
      return [
        {
          name: "Implementation",
          columns: [...IMPLEMENTATION_COLUMNS],
          rows: customer.implementation
            ? [
                mapRow(
                  IMPLEMENTATION_COLUMNS,
                  customer.implementation as Record<string, unknown>,
                  cid,
                  cname,
                ),
              ]
            : [],
        },
      ];
    case "Tickets": {
      const interactionsAsc = (customer.interactions ?? [])
        .slice()
        .sort((a, b) => String(a.interactionAt ?? "").localeCompare(String(b.interactionAt ?? "")));
      return [
        {
          name: "Tickets",
          columns: [...TICKETS_COLUMNS],
          rows: (customer.tickets ?? []).map((t) =>
            mapRow(TICKETS_COLUMNS, t as Record<string, unknown>, cid, cname),
          ),
        },
        {
          name: "Interactions",
          columns: [...INTERACTIONS_COLUMNS],
          rows: interactionsAsc.map((i) =>
            mapRow(INTERACTIONS_COLUMNS, i as Record<string, unknown>, cid, cname),
          ),
        },
        {
          name: "Interaction Digest",
          columns: [...INTERACTION_DIGEST_COLUMNS],
          rows: [deriveInteractionDigestRow(customer)],
        },
      ];
    }
    case "People": {
      const staff = peopleSeed.internalStaffAssignments.filter((p) => p.customer_id === cid);
      const stakeholders = peopleSeed.customerStakeholders.filter((p) => p.customer_id === cid);
      return [
        {
          name: "Internal Staff",
          columns: [...INTERNAL_STAFF_COLUMNS],
          rows: staff.map((p) =>
            mapRow(INTERNAL_STAFF_COLUMNS, p as Record<string, unknown>, cid, cname),
          ),
        },
        {
          name: "Customer Stakeholders",
          columns: [...CUSTOMER_STAKEHOLDERS_COLUMNS],
          rows: stakeholders.map((p) =>
            mapRow(CUSTOMER_STAKEHOLDERS_COLUMNS, p as Record<string, unknown>, cid, cname),
          ),
        },
      ];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the workbook spec for one `<Domain>/Master.xlsx` of a customer.
 * `now` is reserved (see module doc). Throws `Unknown customer: <id>` when the
 * customer is not in the system of record.
 */
export async function buildDomainWorkbookSpec(opts: {
  customerId: string;
  domain: WorkbookDomain;
  now: Date | string;
  /** The caller's workspace: a customer outside it is "Unknown customer". */
  orgId?: string | null;
}): Promise<WorkbookSpec> {
  void opts.now; // reserved: digest is derived purely from stored rows
  const customer = await getCustomer(opts.customerId, opts.orgId);
  if (!customer) throw new Error(`Unknown customer: ${opts.customerId}`);
  return {
    workbook: `${opts.domain}/Master.xlsx`,
    domain: opts.domain,
    sheets: domainSheets(customer, opts.domain),
  };
}

/**
 * Build every domain workbook spec for a customer, in the fixed
 * `WORKBOOK_DOMAINS` order. Throws `Unknown customer: <id>` when absent.
 */
export async function buildCustomerWorkbookSpecs(opts: {
  customerId: string;
  now: Date | string;
  /** The caller's workspace: a customer outside it is "Unknown customer". */
  orgId?: string | null;
}): Promise<WorkbookSpec[]> {
  void opts.now; // reserved
  const customer = await getCustomer(opts.customerId, opts.orgId);
  if (!customer) throw new Error(`Unknown customer: ${opts.customerId}`);
  return WORKBOOK_DOMAINS.map((domain) => ({
    workbook: `${domain}/Master.xlsx`,
    domain,
    sheets: domainSheets(customer, domain),
  }));
}
