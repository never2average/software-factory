/**
 * Drizzle Postgres schema for the FDE system of record.
 *
 * Mirrors the canonical Zod contracts in `agent/lib/customer-schema.ts` and
 * the sheet column contracts in `docs/data-model.md` (snake_case columns,
 * one table per sheet). Postgres holds the STRUCTURED entities; the document
 * artifacts (context.md, agreements, helm/terraform, eval jsonl, signoffs)
 * stay in the data-room store (`agent/lib/dataroom-store.ts`).
 *
 * Conventions:
 * - Every customer-scoped table keys on `customer_id` (the slug from
 *   `data/customers.json`, e.g. `acme-bank`) with an FK to `customers`.
 * - Zod enums are stored as `text` — the Zod schemas remain the validation
 *   contract at the application boundary; Postgres stores the literal value.
 * - Date/timestamp strings in the Zod contract are loose ISO strings, so they
 *   are stored as `text` to round-trip exactly what the JSON store holds.
 * - Array fields (`string[]`) are stored as `jsonb`.
 *
 * NOTE: this module must stay side-effect free — it is imported by
 * `agent/lib/db/index.ts`, which must not open any connection at import time.
 */
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Customers — one row per customer account (the account spine)               */
/* -------------------------------------------------------------------------- */

export const customers = pgTable(
  "customers",
  {
    // `customers[].id` in the Zod contract; `customer_id` on the sheet.
    customerId: text("customer_id").primaryKey(),
    // Which org (workspace) owns this customer account. Nullable → backfills to
    // 'onfinance'; every customer-scoped table inherits its org through here.
    orgId: text("org_id").notNull(),
    customerName: text("customer_name").notNull(),
    tier: text("tier"),
    lifecycleStage: text("lifecycle_stage"),
    status: text("status"),
    healthScore: doublePrecision("health_score"),
    fdeOwner: text("fde_owner"),
    aeOwner: text("ae_owner"),
    arr: doublePrecision("arr"),
    arrCurrency: text("arr_currency"),
    seats: integer("seats"),
    externalAccountId: text("external_account_id"),
    legalEntityName: text("legal_entity_name"),
    accountRegion: text("account_region"),
    contractStatus: text("contract_status"),
    renewalForecast: text("renewal_forecast"),
    renewalRiskReason: text("renewal_risk_reason"),
    expansionPotentialArr: doublePrecision("expansion_potential_arr"),
    healthReason: text("health_reason"),
    companyDomain: text("company_domain"),
    vertical: text("vertical"),
    regulatoryProfile: text("regulatory_profile"),
    businessOwnerEmail: text("business_owner_email"),
    technicalOwnerEmail: text("technical_owner_email"),
    executiveSponsorEmail: text("executive_sponsor_email"),
    valueRealizationStage: text("value_realization_stage"),
    targetAnnualValue: doublePrecision("target_annual_value"),
    realizedAnnualValue: doublePrecision("realized_annual_value"),
    successCriteria: text("success_criteria"),
    valuePeriodStart: text("value_period_start"),
    valuePeriodEnd: text("value_period_end"),
    valueEvidenceStatus: text("value_evidence_status"),
    valueEvidenceUrl: text("value_evidence_url"),
    lastBusinessReviewDate: text("last_business_review_date"),
    nextBusinessReviewDate: text("next_business_review_date"),
    contractStart: text("contract_start"),
    renewalDate: text("renewal_date"),
    industrySegment: text("industry_segment"),
  },
  (t) => [
    index("customers_fde_owner_idx").on(t.fdeOwner),
    index("customers_lifecycle_stage_idx").on(t.lifecycleStage),
  ],
);

/* -------------------------------------------------------------------------- */
/* Platform — one row per customer platform configuration                     */
/* -------------------------------------------------------------------------- */

export const platform = pgTable("platform", {
    orgId: text("org_id").notNull(),
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.customerId, { onDelete: "cascade" }),
  tenantId: text("tenant_id"),
  platformConfigStatus: text("platform_config_status"),
  deploymentModel: text("deployment_model").notNull(),
  dataResidencyConstraint: text("data_residency_constraint").notNull(),
  authMode: text("auth_mode"),
  dataClassification: text("data_classification"),
  piiHandling: text("pii_handling"),
  auditLoggingEnabled: boolean("audit_logging_enabled"),
  retentionDays: integer("retention_days"),
  aiGovernanceStatus: text("ai_governance_status"),
  modelPolicyId: text("model_policy_id"),
  allowedModelProviders: jsonb("allowed_model_providers").$type<string[]>(),
  modelDataUsePolicy: text("model_data_use_policy"),
  inferenceRegion: text("inference_region"),
  crossBorderProcessingAllowed: boolean("cross_border_processing_allowed"),
  guardrailPolicy: text("guardrail_policy"),
  guardrailPolicyVersion: text("guardrail_policy_version"),
  guardrailEnforcementMode: text("guardrail_enforcement_mode"),
  promptLoggingMode: text("prompt_logging_mode"),
  customerManagedKeyEnabled: boolean("customer_managed_key_enabled"),
  kmsKeyRef: text("kms_key_ref"),
  scimProvisioningEnabled: boolean("scim_provisioning_enabled"),
  rbacPolicy: text("rbac_policy"),
  auditLogSink: text("audit_log_sink"),
  observabilityEnabled: boolean("observability_enabled"),
  primaryModel: text("primary_model").notNull(),
  fallbackModel: text("fallback_model"),
  minimumEvalScorePct: doublePrecision("minimum_eval_score_pct"),
  lastGovernanceReviewAt: text("last_governance_review_at"),
  monthlySpendLimitUsd: doublePrecision("monthly_spend_limit_usd"),
  enabledConnectors: jsonb("enabled_connectors").$type<string[]>().notNull(),
  featureFlags: jsonb("feature_flags").$type<string[]>().notNull(),
  primaryUseCase: text("primary_use_case").notNull(),
  lastHealthCheckAt: text("last_health_check_at"),
});

/* -------------------------------------------------------------------------- */
/* Deployments — one row per deployable runtime instance                      */
/* Keyed by (customer_id, deployment_id); environment/region are dimensions.  */
/* -------------------------------------------------------------------------- */

export const deployments = pgTable(
  "deployments",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").notNull(),
    // Optional human title; blank falls back to the composed "customer · env · version".
    displayName: text("display_name"),
    environment: text("environment").notNull(),
    region: text("region").notNull(),
    cloudProvider: text("cloud_provider"),
    runtime: text("runtime"),
    deploymentStrategy: text("deployment_strategy"),
    deployedVersion: text("deployed_version").notNull(),
    releaseId: text("release_id"),
    releaseChannel: text("release_channel"),
    buildSha: text("build_sha"),
    runtimeVersion: text("runtime_version"),
    configVersion: text("config_version"),
    approvedByEmail: text("approved_by_email"),
    approvedAt: text("approved_at"),
    modelRouteId: text("model_route_id"),
    modelRoutingMode: text("model_routing_mode"),
    primaryModelRef: text("primary_model_ref"),
    primaryModelVersion: text("primary_model_version"),
    fallbackModelRef: text("fallback_model_ref"),
    fallbackModelVersion: text("fallback_model_version"),
    modelTrafficPrimaryPct: doublePrecision("model_traffic_primary_pct"),
    lastDeployAt: text("last_deploy_at"),
    releaseStatus: text("release_status").notNull(),
    rollbackVersion: text("rollback_version"),
    rollbackStatus: text("rollback_status"),
    rollbackTestedAt: text("rollback_tested_at"),
    healthStatus: text("health_status").notNull(),
    uptime30dPct: doublePrecision("uptime_30d_pct"),
    errorRate30dPct: doublePrecision("error_rate_30d_pct"),
    latencyP95Ms: doublePrecision("latency_p95_ms"),
    latencySloMs: doublePrecision("latency_slo_ms"),
    requestCount30d: bigint("request_count_30d", { mode: "number" }),
    llmRequestCount30d: bigint("llm_request_count_30d", { mode: "number" }),
    inputTokens30d: bigint("input_tokens_30d", { mode: "number" }),
    outputTokens30d: bigint("output_tokens_30d", { mode: "number" }),
    cacheHitRate30dPct: doublePrecision("cache_hit_rate_30d_pct"),
    guardrailBlockRate30dPct: doublePrecision("guardrail_block_rate_30d_pct"),
    cost30dUsd: doublePrecision("cost_30d_usd"),
    costBudget30dUsd: doublePrecision("cost_budget_30d_usd"),
    projectedCost30dUsd: doublePrecision("projected_cost_30d_usd"),
    capacityLimitRpm: integer("capacity_limit_rpm"),
    peakRpm30d: integer("peak_rpm_30d"),
    utilization30dPct: doublePrecision("utilization_30d_pct"),
    liveUrl: text("live_url"),
    deployOwnerEmail: text("deploy_owner_email"),
    lastIncidentRef: text("last_incident_ref"),
    activeIncidentRefs: jsonb("active_incident_refs").$type<string[]>(),
    incidentCount30d: integer("incident_count_30d"),
    dashboardUrl: text("dashboard_url"),
    runbookUrl: text("runbook_url"),
    lastTelemetryAt: text("last_telemetry_at"),
    notes: text("notes"),
    // The deployment profile's own fields (`domains.deployments.custom_fields`), keyed by field key. One column
    // whatever the profile declares; agent/lib/custom-fields.ts validates every write.
    custom: jsonb("custom").$type<Record<string, string | number>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.deploymentId] }),
    index("deployments_customer_id_idx").on(t.customerId),
    index("deployments_health_status_idx").on(t.healthStatus),
  ],
);

/* -------------------------------------------------------------------------- */
/* Solutions — one row per (customer_id, solution_id) workflow                */
/* -------------------------------------------------------------------------- */

export const solutions = pgTable(
  "solutions",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    solutionId: text("solution_id").notNull(),
    useCase: text("use_case").notNull(),
    workflowId: text("workflow_id"),
    workflowName: text("workflow_name"),
    businessProcess: text("business_process"),
    businessUnit: text("business_unit"),
    primaryUserRole: text("primary_user_role"),
    workflowOwnerEmail: text("workflow_owner_email"),
    riskOwnerEmail: text("risk_owner_email"),
    workflowFrequency: text("workflow_frequency"),
    decisionImpact: text("decision_impact"),
    upstreamSystems: jsonb("upstream_systems").$type<string[]>(),
    downstreamSystems: jsonb("downstream_systems").$type<string[]>(),
    outputArtifacts: jsonb("output_artifacts").$type<string[]>(),
    sensitiveDataTypes: jsonb("sensitive_data_types").$type<string[]>(),
    valueMetric: text("value_metric"),
    valueMetricUnit: text("value_metric_unit"),
    valueMetricDirection: text("value_metric_direction"),
    measurementSource: text("measurement_source"),
    measurementWindowDays: integer("measurement_window_days"),
    baselineMetricValue: doublePrecision("baseline_metric_value"),
    currentMetricValue: doublePrecision("current_metric_value"),
    targetMetricValue: doublePrecision("target_metric_value"),
    baselinePeriodStart: text("baseline_period_start"),
    baselinePeriodEnd: text("baseline_period_end"),
    currentPeriodStart: text("current_period_start"),
    currentPeriodEnd: text("current_period_end"),
    targetDate: text("target_date"),
    valueEvidenceUrl: text("value_evidence_url"),
    annualizedValueRealizedUsd: doublePrecision("annualized_value_realized_usd"),
    valueRealizationConfidencePct: doublePrecision("value_realization_confidence_pct"),
    solutionValueRealizationStage: text("solution_value_realization_stage"),
    modulesEnabled: jsonb("modules_enabled").$type<string[]>().notNull(),
    solutionStatus: text("solution_status").notNull(),
    solutionGoLiveDate: text("solution_go_live_date"),
    weeklyActiveUsers: integer("weekly_active_users"),
    weeklyQueryVolume: integer("weekly_query_volume"),
    automationRatePct: doublePrecision("automation_rate_pct"),
    humanReviewRatePct: doublePrecision("human_review_rate_pct"),
    productionReadinessScore: doublePrecision("production_readiness_score"),
    solutionEvalScorePct: doublePrecision("solution_eval_score_pct"),
    evalStatus: text("eval_status"),
    evalSuiteId: text("eval_suite_id"),
    evalDatasetVersion: text("eval_dataset_version"),
    lastEvalRunId: text("last_eval_run_id"),
    lastEvalRunAt: text("last_eval_run_at"),
    evalPassRatePct: doublePrecision("eval_pass_rate_pct"),
    evalCoveragePct: doublePrecision("eval_coverage_pct"),
    taskSuccessRatePct: doublePrecision("task_success_rate_pct"),
    answerAcceptanceRatePct: doublePrecision("answer_acceptance_rate_pct"),
    groundednessScorePct: doublePrecision("groundedness_score_pct"),
    citationCoveragePct: doublePrecision("citation_coverage_pct"),
    hallucinationRatePct: doublePrecision("hallucination_rate_pct"),
    policyViolationRatePct: doublePrecision("policy_violation_rate_pct"),
    guardrailInterventionRatePct: doublePrecision("guardrail_intervention_rate_pct"),
    customerReportedDefects30d: integer("customer_reported_defects_30d"),
    safetyIncidentCount30d: integer("safety_incident_count_30d"),
    humanReviewPolicy: text("human_review_policy"),
    reviewSlaHours: doublePrecision("review_sla_hours"),
    reviewSlaAttainmentPct: doublePrecision("review_sla_attainment_pct"),
    reviewBacklogCount: integer("review_backlog_count"),
    readinessStatus: text("readiness_status"),
    readinessGateFailures: jsonb("readiness_gate_failures").$type<string[]>(),
    modelRiskApprovalStatus: text("model_risk_approval_status"),
    runbookUrl: text("runbook_url"),
    solutionNextStep: text("solution_next_step"),
    lastEvalRun: text("last_eval_run"),
    valueDelivered: text("value_delivered"),
    expansionOpportunity: text("expansion_opportunity"),
    expansionStage: text("expansion_stage"),
    expansionPotentialAnnualValueUsd: doublePrecision("expansion_potential_annual_value_usd"),
    expansionConfidencePct: doublePrecision("expansion_confidence_pct"),
    solutionFdeOwner: text("solution_fde_owner").notNull(),
    lastReviewedDate: text("last_reviewed_date"),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.solutionId] }),
    index("solutions_customer_id_idx").on(t.customerId),
    index("solutions_solution_status_idx").on(t.solutionStatus),
  ],
);

/* -------------------------------------------------------------------------- */
/* Implementation — one row per customer rollout plan                         */
/* -------------------------------------------------------------------------- */

export const implementation = pgTable("implementation", {
    orgId: text("org_id").notNull(),
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.customerId, { onDelete: "cascade" }),
  rolloutId: text("rollout_id"),
  // Optional human title; blank falls back to the composed "customer · stage".
  displayName: text("display_name"),
  launchScopeSolutionIds: jsonb("launch_scope_solution_ids").$type<string[]>(),
  implementationStage: text("implementation_stage").notNull(),
  implementationOwnerEmail: text("implementation_owner_email"),
  rolloutGovernanceStatus: text("rollout_governance_status"),
  customerLaunchApproverEmail: text("customer_launch_approver_email"),
  providerLaunchApproverEmail: text("provider_launch_approver_email"),
  launchDecision: text("launch_decision"),
  launchDecisionDate: text("launch_decision_date"),
  implementationProgressPct: doublePrecision("implementation_progress_pct").notNull(),
  implementationRiskLevel: text("implementation_risk_level").notNull(),
  dataReadinessPct: doublePrecision("data_readiness_pct"),
  integrationReadinessPct: doublePrecision("integration_readiness_pct"),
  dataSourceInventoryStatus: text("data_source_inventory_status"),
  dataAccessStatus: text("data_access_status"),
  dataQualityStatus: text("data_quality_status"),
  connectorProvisioningStatus: text("connector_provisioning_status"),
  integrationTestStatus: text("integration_test_status"),
  securityReviewStatus: text("security_review_status"),
  privacyReviewStatus: text("privacy_review_status"),
  evalAcceptanceStatus: text("eval_acceptance_status"),
  acceptanceEvidenceLink: text("acceptance_evidence_link"),
  uatStatus: text("uat_status"),
  trainingStatus: text("training_status"),
  launchCriteria: text("launch_criteria"),
  launchCriteriaStatus: text("launch_criteria_status"),
  goLiveConfidencePct: doublePrecision("go_live_confidence_pct"),
  targetGoLiveDate: text("target_go_live_date"),
  actualGoLiveDate: text("actual_go_live_date"),
  launchWindowStartAt: text("launch_window_start_at"),
  launchWindowEndAt: text("launch_window_end_at"),
  runbookStatus: text("runbook_status"),
  runbookLink: text("runbook_link"),
  supportHandoffStatus: text("support_handoff_status"),
  supportOwnerEmail: text("support_owner_email"),
  supportChannelRef: text("support_channel_ref"),
  billingReadinessStatus: text("billing_readiness_status"),
  entitlementProvisioningStatus: text("entitlement_provisioning_status"),
  billingStartDate: text("billing_start_date"),
  currentMilestone: text("current_milestone"),
  currentMilestoneDueDate: text("current_milestone_due_date"),
  blocker: text("blocker"),
  blockerOwner: text("blocker_owner").notNull(),
  blockerSeverity: text("blocker_severity"),
  blockedSinceDate: text("blocked_since_date"),
  riskMitigationPlan: text("risk_mitigation_plan"),
  criticalBlockerTicketIds: jsonb("critical_blocker_ticket_ids").$type<string[]>(),
  openBlockerCount: integer("open_blocker_count"),
  implementationNextStep: text("implementation_next_step"),
  implementationLastUpdatedAt: text("implementation_last_updated_at"),
  // The deployment profile's own fields (`domains.implementations.custom_fields`); see deployments.custom.
  custom: jsonb("custom").$type<Record<string, string | number>>().notNull().default({}),
});

/* -------------------------------------------------------------------------- */
/* Tickets — one row per actionable ticket / follow-up / incident             */
/* -------------------------------------------------------------------------- */

export const tickets = pgTable(
  "tickets",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull(),
    summary: text("summary").notNull(),
    description: text("description"),
    affectedSchema: text("affected_schema"),
    affectedSolutionId: text("affected_solution_id"),
    affectedDeploymentId: text("affected_deployment_id"),
    affectedEnvironment: text("affected_environment"),
    affectedWorkflowId: text("affected_workflow_id"),
    affectedConnector: text("affected_connector"),
    affectedModel: text("affected_model"),
    affectedDataSource: text("affected_data_source"),
    relatedTicketIds: jsonb("related_ticket_ids").$type<string[]>(),
    externalSystem: text("external_system"),
    externalId: text("external_id"),
    ticketType: text("ticket_type").notNull(),
    ticketCategory: text("ticket_category").notNull(),
    ticketStatus: text("ticket_status").notNull(),
    ticketPriority: text("ticket_priority").notNull(),
    severity: text("severity"),
    supportQueue: text("support_queue"),
    ownerTeam: text("owner_team"),
    reportedByEmail: text("reported_by_email"),
    customerContactEmail: text("customer_contact_email"),
    ticketOpenedDate: text("ticket_opened_date").notNull(),
    triagedAt: text("triaged_at"),
    ticketDueDate: text("ticket_due_date"),
    slaDueAt: text("sla_due_at"),
    firstResponseDueAt: text("first_response_due_at"),
    firstRespondedAt: text("first_responded_at"),
    resolutionDueAt: text("resolution_due_at"),
    slaStatus: text("sla_status"),
    escalated: boolean("escalated"),
    escalatedAt: text("escalated_at"),
    escalationLevel: text("escalation_level"),
    escalationReason: text("escalation_reason"),
    ticketOwnerEmail: text("ticket_owner_email").notNull(),
    sourceChannel: text("source_channel").notNull(),
    lastActivityDate: text("last_activity_date").notNull(),
    sourceLink: text("source_link"),
    escalationOwnerEmail: text("escalation_owner_email"),
    productionImpact: boolean("production_impact"),
    customerImpactLevel: text("customer_impact_level"),
    customerImpactSummary: text("customer_impact_summary"),
    affectedUserCount: integer("affected_user_count"),
    issueDomain: text("issue_domain"),
    modelIssueType: text("model_issue_type"),
    dataIssueType: text("data_issue_type"),
    integrationIssueType: text("integration_issue_type"),
    rootCauseStatus: text("root_cause_status"),
    rootCauseCategory: text("root_cause_category"),
    rootCauseSummary: text("root_cause_summary"),
    detectedAt: text("detected_at"),
    mitigatedAt: text("mitigated_at"),
    remediationSummary: text("remediation_summary"),
    preventiveActions: text("preventive_actions"),
    postmortemRequired: boolean("postmortem_required"),
    postmortemStatus: text("postmortem_status"),
    postmortemOwnerEmail: text("postmortem_owner_email"),
    postmortemDueDate: text("postmortem_due_date"),
    postmortemUrl: text("postmortem_url"),
    tags: jsonb("tags").$type<string[]>(),
    resolutionSummary: text("resolution_summary"),
    resolvedAt: text("resolved_at"),
    ticketNextStep: text("ticket_next_step").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.ticketId] }),
    index("tickets_customer_id_idx").on(t.customerId),
    index("tickets_ticket_status_idx").on(t.ticketStatus),
    index("tickets_ticket_category_idx").on(t.ticketCategory),
  ],
);

/* -------------------------------------------------------------------------- */
/* Interactions — one row per customer touchpoint/event (append-mostly)       */
/* -------------------------------------------------------------------------- */

export const interactions = pgTable(
  "interactions",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    interactionId: text("interaction_id").notNull(),
    interactionAt: text("interaction_at").notNull(),
    interactionType: text("interaction_type").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id"),
    sourceLink: text("source_link"),
    summary: text("summary"),
    note: text("note").notNull(),
    outcome: text("outcome"),
    participantEmails: jsonb("participant_emails").$type<string[]>(),
    relatedTicketIds: jsonb("related_ticket_ids").$type<string[]>(),
    relatedSolutionIds: jsonb("related_solution_ids").$type<string[]>(),
    relatedDeploymentIds: jsonb("related_deployment_ids").$type<string[]>(),
    nextAction: text("next_action"),
    nextActionOwnerEmail: text("next_action_owner_email"),
    nextActionDueDate: text("next_action_due_date"),
    sentiment: text("sentiment"),
    sensitivity: text("sensitivity"),
    recordedByEmail: text("recorded_by_email"),
    recordedAt: text("recorded_at"),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.interactionId] }),
    index("interactions_customer_id_idx").on(t.customerId),
    index("interactions_interaction_at_idx").on(t.interactionAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* People — Internal Staff + Customer Stakeholders (People/Master.xlsx)       */
/* -------------------------------------------------------------------------- */

export const internalStaff = pgTable(
  "internal_staff",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    // "solution_engineer" | "account_executive"
    staffRole: text("staff_role").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    employerOrg: text("employer_org").notNull(),
    email: text("email").notNull(),
    lastContact: text("last_contact"),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.staffRole, t.email] }),
    index("internal_staff_email_idx").on(t.email),
  ],
);

export const customerStakeholders = pgTable(
  "customer_stakeholders",
  {
    orgId: text("org_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.customerId, { onDelete: "cascade" }),
    // "key_user" | "decision_maker" | "champion"
    stakeholderRole: text("stakeholder_role").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    employerOrg: text("employer_org").notNull(),
    email: text("email").notNull(),
    lastContact: text("last_contact"),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.stakeholderRole, t.email] }),
    index("customer_stakeholders_email_idx").on(t.email),
  ],
);

/* -------------------------------------------------------------------------- */
/* Memories — durable agent memory, scoped to team / customer / person        */
/* -------------------------------------------------------------------------- */

export const memoryScope = pgEnum("memory_scope", ["team", "customer", "person"]);
export const memorySensitivity = pgEnum("memory_sensitivity", [
  "internal",
  "customer_shareable",
  "restricted",
]);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    scope: memoryScope("scope").notNull(),
    // customers.customer_id for scope=customer, a person email/slug for
    // scope=person, null for scope=team. Not an FK: person memories have no
    // people PK to hang off, and team memories have no entity at all.
    entityId: text("entity_id"),
    key: text("key").notNull(),
    value: text("value").notNull(),
    authorEmail: text("author_email").notNull(),
    sensitivity: memorySensitivity("sensitivity").notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("memories_scope_entity_id_idx").on(t.scope, t.entityId),
    index("memories_key_idx").on(t.key),
  ],
);

/* -------------------------------------------------------------------------- */
/* Schedule rules — durable, dynamically-created recurring/one-time jobs       */
/*                                                                             */
/* Rows are claimed by the `agent/schedules/dynamic.ts` dispatcher (a single   */
/* `cron: "* * * * *"` schedule) via an atomic lease. Recurrence is driven by  */
/* `every_minutes`, NOT the `cron` column: there is no cron-parser dependency  */
/* (package.json is frozen), so `cron` is retained as a descriptive/future     */
/* full-cron string and is nullable. See `agent/lib/schedule-store.ts`.        */
/* -------------------------------------------------------------------------- */

export const scheduleRules = pgTable(
  "schedule_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    // Optional scope; NOT an FK so rules may outlive/precede customers.
    // null = team-wide.
    customerId: text("customer_id"),
    name: text("name").notNull(),
    // Descriptive/future full-cron string; recurrence is driven by
    // every_minutes (no cron-parser dep allowed — package.json frozen).
    cron: text("cron"),
    // null = one-time (disabled after it runs once).
    everyMinutes: integer("every_minutes"),
    // "prompt" | "standup" | "sla_sweep"
    kind: text("kind").notNull().default("prompt"),
    prompt: text("prompt").notNull(),
    // WHICH workflow (workflows.name) a fire of this rule runs, making the fire
    // an openable chat. NULL = the orchestrator handles the prompt itself. Read
    // by the run-cron-workflows Vercel cron, same as system_cron_overrides.workflow.
    workflow: text("workflow"),
    // Optional Slack target; null = log-only.
    channelId: text("channel_id"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    // Lease start; null = unclaimed.
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Random per-claim; complete/release must present it.
    leaseToken: text("lease_token"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Alert targets: who to notify when the rule decides to alert — jsonb
    // array of email addresses (same jsonb precedent as `synced`/`steps`).
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    // DEPRECATED — superseded by `notify_emails` (a list). Kept nullable to
    // avoid a destructive migration; the runtime only falls back to it when
    // `notify_emails` is null/empty. The migration backfilled it into
    // `notify_emails` as a one-element array.
    notifyEmail: text("notify_email"),
    // DEPRECATED — unused. "Notify when" was removed from the product (the
    // rule's own `prompt` IS the notify rule). Kept nullable to avoid a
    // destructive migration; nothing reads or writes it.
    notifyWhen: text("notify_when"),
    // Verified caller email (never the model).
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_rules_due_idx").on(t.enabled, t.nextRunAt),
    index("schedule_rules_customer_id_idx").on(t.customerId),
  ],
);

/* -------------------------------------------------------------------------- */
/* System cron overrides — pause/soft-delete/cadence/prompt state for          */
/* code-authored crons                                                         */
/*                                                                             */
/* The three static schedules (`agent/schedules/daily-standup.ts`,             */
/* `sla-sweep.ts`, `dynamic.ts`) are Vercel Cron jobs authored in code. This   */
/* table is the DB override that makes them operable from the Ops Center       */
/* anyway: each run() handler checks `isSystemCronActive(name)`                */
/* (agent/lib/system-cron-store.ts) and returns BEFORE starting any agent      */
/* session when its row says paused or soft-deleted. No row at all means       */
/* active (and no DATABASE_URL fails open).                                    */
/*                                                                             */
/* The `cron` column additionally OVERRIDES the authored cadence: when set,    */
/* the authored Vercel Cron invocation steps aside and the every-minute        */
/* dispatcher (`agent/schedules/dynamic.ts`) runs the cron whenever the        */
/* override expression matches (see agent/lib/cron-match.ts). NULL = the       */
/* authored cadence applies. `prompt` works the same way for the message text: */
/* when set, the run (authored handler OR dispatcher) hands IT to Slack        */
/* instead of the authored prompt in agent/lib/system-cron-defs.ts.            */
/* -------------------------------------------------------------------------- */

export const systemCronOverrides = pgTable("system_cron_overrides", {
  // The cron's schedule file name: "daily-standup" | "sla-sweep" | "dynamic".
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  // Override cron expression (5-field, UTC), validated by the API with
  // agent/lib/cron-match.ts before it is ever persisted. NULL = authored
  // cadence. When set, dynamic.ts owns this cron's timing.
  cron: text("cron"),
  // Override PROMPT. NULL = the authored prompt in
  // agent/lib/system-cron-defs.ts applies. Honoured by whichever clock fires
  // the cron (the authored handler or the dispatcher on an override cadence).
  prompt: text("prompt"),
  // WHICH WORKFLOW runs this cron: the name of a declared subagent
  // (workflows.name). NULL = no routing — the orchestrator handles the prompt
  // itself and delegates as it sees fit. When set, the run's message carries a
  // ROUTE TO WORKFLOW line naming the subagent (agent/lib/system-cron-defs.ts),
  // so the choice actually changes who does the work.
  workflow: text("workflow"),
  // Alert targets, same meaning as on the other record types: who the agent
  // should address when the run decides to alert — jsonb array of email
  // addresses, appended to the message as a NOTIFY TARGET line (see
  // agent/lib/system-cron-defs.ts).
  notifyEmails: jsonb("notify_emails").$type<string[]>(),
  // DEPRECATED — superseded by `notify_emails` (a list). Kept nullable to
  // avoid a destructive migration; the runtime only falls back to it when
  // `notify_emails` is null/empty. The migration backfilled it into
  // `notify_emails` as a one-element array.
  notifyEmail: text("notify_email"),
  // Soft delete — the UI hides the cron but a restore clears this again.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Last dispatch outcome, so the UI can show why a run failed.
  lastError: text("last_error"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Ops-center CRUD tables: connectors + workflows                             */
/*                                                                            */
/* Backed by the Next API routes under app/api/ops/* — full CRUD from the     */
/* Connectors / Workflows modals. Crons reuse `schedule_rules` above.         */
/* -------------------------------------------------------------------------- */

/** A connector's access mode over the data room: read, write, or both. */
export const connectorAccess = pgEnum("connector_access", ["read", "write", "read_write"]);

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    /**
     * WHOSE connector this is.
     *
     *   NULL → organization-level: shared by everyone in the workspace.
     *   set  → account-level: only this person can see or use it.
     *
     * org_id stays required either way — a personal connector still lives
     * inside a workspace, which is what makes it billable to the right place
     * and removable when the person leaves.
     *
     * The visibility rule is enforced by the RLS policy against the
     * `app.principal_email` GUC, not by application filters. A caller with no
     * principal — a cron, a workflow, any automation — therefore sees only
     * organization-level rows, so scheduled work can never act with somebody's
     * personal credentials or break the day they leave.
     */
    ownerEmail: text("owner_email"),
    // Display name, e.g. "Slack" (keys into the UI's brand palette).
    name: text("name").notNull(),
    // Source kind slug, e.g. "slack" | "github" | "granola" | "gmail" | ...
    kind: text("kind").notNull(),
    // read | write | read_write — the three connector classes.
    access: connectorAccess("access").notNull().default("read"),
    // "connected" | "read_only" | "setup" (free text; UI maps to a status pill).
    status: text("status").notNull().default("setup"),
    // Short one-line description shown in the list.
    detail: text("detail"),
    // Where its data lands in the dm.md tree (free text).
    lands: text("lands"),
    // Data streams synced (e.g. Slack channels) — jsonb array of strings.
    synced: jsonb("synced").$type<string[]>(),
    // Alert targets: who to notify when this connector needs attention —
    // jsonb array of email addresses.
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    // DEPRECATED — superseded by `notify_emails` (a list). Kept nullable to
    // avoid a destructive migration; the runtime only falls back to it when
    // `notify_emails` is null/empty. The migration backfilled it into
    // `notify_emails` as a one-element array.
    notifyEmail: text("notify_email"),
    // WHEN to notify the recipients above, in the operator's own words ("when a
    // sync fails twice in a row", "when a customer channel goes quiet for a
    // week"). Free text on purpose: it is a condition a person states, not an
    // enum. Set from the Ops Center; NOTE that no connector health-check runner
    // reads it yet — see the note in app/_components/ops/connectors-panel.tsx.
    notifyWhen: text("notify_when"),
    /* ---- BRING-YOUR-OWN connector (kind "mcp") -------------------------- *
     * The built-in kinds (slack, github, …) are wired in code against fixed
     * env vars. These columns are what lets a workspace add a connector we
     * never shipped — their own MCP server — without a code change or a
     * redeploy: `endpoint_url` is where it lives, `required_secrets` is the
     * credential contract it declares for itself. The secrets route validates
     * against THIS list for such a connector instead of the static manifest in
     * lib/connector-secrets-manifest.ts, and the agent's mcp_call tool reads
     * both at call time.                                                     */
    // Base URL of a customer-supplied MCP server (streamable HTTP).
    endpointUrl: text("endpoint_url"),
    // Self-declared credential contract: [{ name, purpose, optional? }].
    requiredSecrets: jsonb("required_secrets").$type<
      { name: string; purpose: string; optional?: boolean }[]
    >(),
    // Which stored secret carries the bearer token for `endpoint_url`. Named
    // rather than guessed, so a connector may hold several credentials and
    // still say unambiguously which one authenticates the MCP call itself.
    authSecretName: text("auth_secret_name"),
    enabled: boolean("enabled").notNull().default(true),
    // Verified caller email (never the model).
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connectors_access_idx").on(t.access)],
);

/**
 * An APP — a named Markdown document the agent regenerates on a cadence and the
 * Ops Center renders read-only. Its content is produced either by a WORKFLOW
 * (structured, multi-step, durable) or by a PROMPT (a single agent call); the
 * refresh-apps Vercel cron runs whichever is set and stores the Markdown here.
 * Rendering is streamdown, so GFM tables / code / mermaid all work.
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    // Stable url-safe handle for deep-links (/?ops=apps&id=<slug|id>).
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // "workflow" | "prompt" — which generator produces the content.
    sourceKind: text("source_kind").notNull().default("prompt"),
    // workflows.name, when sourceKind = "workflow".
    workflow: text("workflow"),
    // The instruction to run, when sourceKind = "prompt".
    prompt: text("prompt"),
    // Optional subagent to run the prompt as (null = the orchestrator).
    subagent: text("subagent"),
    // Optional customer scope; null = team-wide.
    customerId: text("customer_id"),
    // 5-field UTC cron for automatic refresh; null = manual refresh only.
    refreshCron: text("refresh_cron"),
    // The rendered document as it stands.
    contentMd: text("content_md"),
    contentUpdatedAt: timestamp("content_updated_at", { withTimezone: true }),
    // Provenance of the LAST refresh, so it can be opened as a chat:
    // a durable workflow run (workflow source) or an eve session (prompt source).
    lastRunId: text("last_run_id"),
    lastSessionId: text("last_session_id"),
    lastError: text("last_error"),
    // Dispatcher bookkeeping — set when a refresh is claimed, so two cron ticks
    // never regenerate the same app concurrently.
    refreshingAt: timestamp("refreshing_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    // Soft delete — the UI hides it but a restore clears this again.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("apps_slug_idx").on(t.slug), index("apps_customer_id_idx").on(t.customerId)],
);

/**
 * One REFRESH of an app — the document as it stood at that moment, plus the run
 * / session that produced it so the version can be reopened as a chat. Failed
 * attempts are recorded too (error, no content), so the history shows what was
 * tried, not just what succeeded. The app row keeps the latest for fast reads;
 * this is the archive behind it.
 */
export const appVersions = pgTable(
  "app_versions",
  {
    orgId: text("org_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull(),
    contentMd: text("content_md"),
    error: text("error"),
    // Provenance — either makes the version openable as a chat.
    runId: text("run_id"),
    sessionId: text("session_id"),
    // "cron" for an automatic refresh, else the operator's email.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("app_versions_app_id_idx").on(t.appId, t.createdAt)],
);

/**
 * An operator TODO — the FDE team's lightweight internal action list. This is
 * DELIBERATELY NOT the `tickets` system: no customer FK, no SLA, no ITSM fields.
 * A flat checklist that optionally hangs off a platform "epic" (a Deployment or
 * Implementation) and can point at a related object (a ticket, customer, app…).
 * Team-visible, attributed, assignable.
 */
/**
 * A CYCLE — a time-boxed iteration (a sprint) that groups todos. "Build cycles"
 * in the TODOs section: give it a name + a start/end window, then file todos
 * into it. The "current" cycle is the one whose window contains now.
 */
export const cycles = pgTable("cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  // Sprint lifecycle: "planning" | "active" | "closed".
  state: text("state").notNull().default("planning"),
  // The sprint's goal / theme.
  goal: text("goal"),
  // The sprint lead — the person accountable for the sprint (an email, resolved
  // against the roster). Distinct from createdBy (who filed it).
  lead: text("lead"),
  // Committed capacity as a task count — the burndown's ideal-line start.
  capacity: integer("capacity"),
  createdBy: text("created_by").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The FDE org roster — who's on which team and who they report to. Powers the
 * "me / my reportees / my team / everyone" scope filters in the TODOs
 * workspace. Keyed by email (the same email that appears as an owner on
 * tickets/deployments/implementations). Backfilled from internal_staff; team +
 * manager are filled in by an operator (or the agent via upsert_roster_member).
 */
export const peopleRoster = pgTable("people_roster", {
  // email is the PK today; the composite (org_id, email) PK is deferred to the
  // NOT-NULL migration (Phase 3) once every write stamps org_id. Nullable now.
  email: text("email").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name"),
  team: text("team"),
  // Who this person REPORTS to (the reporting chain walks this).
  managerEmail: text("manager_email"),
  // ESCALATION contacts: multiple managers, each pinged under a specific
  // condition (client escalation, technical blocker, SLA breach, …). Distinct
  // from the single reporting line above.
  escalations: jsonb("escalations").$type<{ email: string; reason: string }[]>(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const todos = pgTable(
  "todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    // The cycle (sprint) this todo is filed into; null = backlog.
    cycleId: uuid("cycle_id"),
    // Parent TODO — a subtask points at its parent's id. Null = a top-level task.
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    notes: text("notes"),
    done: boolean("done").notNull().default(false),
    doneAt: timestamp("done_at", { withTimezone: true }),
    // Board status: backlog | open | in_progress | blocked | done | cancelled.
    // Kept in sync with `done` in the API layer (done := status === "done").
    status: text("status").notNull().default("open"),
    // "low" | "normal" | "high".
    priority: text("priority").notNull().default("normal"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // The epic-analog it's filed under: a Deployment or an Implementation
    // (deployments.id / implementation.id). Null = ungrouped.
    containerType: text("container_type"),
    containerId: text("container_id"),
    containerLabel: text("container_label"),
    // A related object it points at: ticket | customer | app | cron | workflow |
    // chat. Rendered as a deep-linking chip. Null = none.
    linkType: text("link_type"),
    linkId: text("link_id"),
    linkLabel: text("link_label"),
    // Verified caller email (never the model). assignee null = the creator.
    createdBy: text("created_by").notNull(),
    assignee: text("assignee"),
    // Soft delete — hidden from the list but recoverable.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("todos_done_idx").on(t.done),
    index("todos_status_idx").on(t.status),
    index("todos_assignee_idx").on(t.assignee),
    index("todos_container_idx").on(t.containerType, t.containerId),
  ],
);

/**
 * The workspace activity feed — one human sentence per change to a task /
 * cycle / deployment / implementation, mirroring `automation_audit`
 * (`lib/ops-audit.ts`). Append-only; read per entity on the detail pages.
 */
export const entityActivity = pgTable(
  "entity_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    // "task" | "cycle" | "deployment" | "implementation".
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    // Caller email, or "system" for runtime-made changes.
    actor: text("actor").notNull(),
    // Human sentence, e.g. `Status changed open → in_progress`.
    event: text("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("entity_activity_lookup_idx").on(t.entityType, t.entityId, t.createdAt.desc())],
);

/**
 * Free-text discussion on any workspace entity — a flat thread keyed by
 * (entity_type, entity_id). `mentions` holds the @-mentioned emails (notified
 * by email on post).
 */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    mentions: jsonb("mentions").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_lookup_idx").on(t.entityType, t.entityId, t.createdAt)],
);

/**
 * A persisted, human codename for one subagent RUN. Two runs of the same
 * subagent type ("Research", "Research") are otherwise indistinguishable in the
 * Control Panel; each run is assigned a distinct name from the static pool
 * (lib/subagent-names.ts). Keyed by the run's stable id (`run_key` = child
 * session id, else the delegation tool-call id) so the name never shifts.
 */
/**
 * Cached AI briefings for one person on one account, keyed `${email}|${accountId}`.
 * Regenerating on every chip click was the latency the operator felt; a row is
 * served for an hour before it is refreshed.
 */
export const accountSummaries = pgTable("account_summaries", {
    orgId: text("org_id").notNull(),
  key: text("key").primaryKey(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subagentRuns = pgTable("subagent_runs", {
    orgId: text("org_id").notNull(),
  id: uuid("id").primaryKey().defaultRandom(),
  // The stable identity of the run: the child session id, else the tool-call id.
  runKey: text("run_key").notNull().unique(),
  // The child eve session id, when known (for cross-referencing).
  sessionId: text("session_id"),
  // The subagent type this run is an instance of (research, deployment, …).
  subagentType: text("subagent_type"),
  // The assigned codename (e.g. "Orion").
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // What the workflow does (its role / brief).
    description: text("description").notNull(),
    // How it starts, e.g. "on delegation" | "manual" | "on schedule".
    trigger: text("trigger").notNull().default("on delegation"),
    // Optional customer scope; null = any / team-wide.
    customerId: text("customer_id"),
    // Ordered step labels — jsonb array of strings.
    steps: jsonb("steps").$type<string[]>(),
    // Per-workflow operator instructions OVERRIDE. When `name` matches an eve
    // subagent id (deployment, configuration, evals, data-migration,
    // customer-context, follow-ups, research) and this is non-empty, the text
    // is injected into that subagent's context at turn start — see
    // agent/subagents/<id>/instructions/operator-override.ts.
    instructions: text("instructions"),
    // Whether the override above is LIVE. False keeps the text on the row but
    // stops it reaching the subagent — the operator's "disable without losing
    // my draft" switch. Distinct from `enabled`, which is the workflow itself.
    instructionsEnabled: boolean("instructions_enabled").notNull().default(true),
    // The workflow SCRIPT: JavaScript authored in the Ops Center that
    // orchestrates the subagents — `export const meta = {...}` followed by
    // phase() / agent() / parallel() / pipeline() calls. This is what a
    // workflow IS now; the subagent behind it is an implementation detail the
    // script delegates to, not something the tab exposes.
    //
    // It is executed in a QuickJS sandbox (lib/workflow-runtime.ts): no
    // filesystem, no network, no timers — only the host functions injected for
    // it. Validated before it can ever be saved (lib/workflow-validate.ts).
    script: text("script"),
    // Alert targets: who to notify when this workflow needs attention —
    // jsonb array of email addresses.
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    // DEPRECATED — superseded by `notify_emails` (a list). Kept nullable to
    // avoid a destructive migration; the runtime only falls back to it when
    // `notify_emails` is null/empty. The migration backfilled it into
    // `notify_emails` as a one-element array.
    notifyEmail: text("notify_email"),
    // DEPRECATED — unused ("notify when" was removed from the product). Kept
    // nullable to avoid a destructive migration; nothing reads or writes it.
    notifyWhen: text("notify_when"),
    enabled: boolean("enabled").notNull().default(true),
    // Verified caller email (never the model).
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_customer_id_idx").on(t.customerId)],
);

/**
 * Version history for `workflows.instructions` — one append-only row per SAVE
 * of the operator override, so the Ops Center's editor can restore an earlier
 * version. Restoring is not a rewind: it writes the old text back through the
 * normal PATCH, which appends another version. History therefore only ever
 * grows, and "what was live at time T" is always answerable.
 *
 * `content` is nullable: clearing the override is itself a version.
 */
export const workflowInstructionVersions = pgTable(
  "workflow_instruction_versions",
  {
    orgId: text("org_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull(),
    // The text as saved. Null = it was cleared.
    content: text("content"),
    // WHICH file this is a version of: the operator-instructions override, or
    // the workflow script. One table, because the editor treats both as "the
    // file open in the tab" and restore works identically for each.
    kind: text("kind").notNull().default("instructions"),
    // Verified caller email (never the model).
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_instr_versions_idx").on(t.workflowId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Durable workflow execution — resume + retry                                */
/*                                                                            */
/* A workflow SCRIPT run is checkpointed so a crash/timeout never redoes the  */
/* expensive LLM work: `workflow_runs` holds the run-level context (which     */
/* workflow, its args, status) so an incomplete run can be RESUMED, and       */
/* `workflow_run_journal` records each agent() call's result keyed by         */
/* (run_id, attempt, call_index). On re-run with the same run_id, completed   */
/* calls from earlier attempts are replayed, while each execution keeps its   */
/* own append-safe observability epoch.                                       */
/* Completed calls return their cached result instantly; only failed/new work */
/* executes live — the same journal+resume model the ultracode Workflow tool  */
/* uses. See lib/workflow-runtime.ts.                                         */
/* -------------------------------------------------------------------------- */

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    orgId: text("org_id").notNull(),
    // The durable run id (also the journal key). Client-supplied on resume.
    runId: text("run_id").primaryKey(),
    workflowId: uuid("workflow_id"),
    workflowName: text("workflow_name").notNull(),
    // The `args` the run was launched with — replayed verbatim on resume.
    args: jsonb("args"),
    // running | completed | failed | cancelled. `running` is owned by exactly
    // one execution lease; an expired/released lease may be atomically claimed
    // by the continuation driver.
    status: text("status").notNull().default("running"),
    // The workflow's final return value (when completed).
    result: jsonb("result"),
    error: text("error"),
    // How many times this run has been (re)driven — a runaway backstop.
    attempts: integer("attempts").notNull().default(1),
    // Execution ownership. Every driver gets a fresh unguessable lease token;
    // terminal writes and journal checkpoints must present that same token.
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // Current owner while leased; retained as the last owner after settlement
    // so run detail keeps execution provenance.
    workerId: text("worker_id"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    // Cancellation is a durable request. The active driver observes it during
    // heartbeats, aborts its Eve turn, then records the terminal boundary.
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelRequestedBy: text("cancel_requested_by"),
    cancelReason: text("cancel_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workflow_runs_status_idx").on(t.status, t.updatedAt),
    index("workflow_runs_lease_idx").on(t.status, t.leaseExpiresAt),
  ],
);

export const workflowRunJournal = pgTable(
  "workflow_run_journal",
  {
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    // Execution epoch. Completed entries from older attempts remain available
    // for replay, while a new lease can never overwrite the prior attempt's
    // observability or race its terminal write.
    attempt: integer("attempt").notNull().default(1),
    leaseToken: text("lease_token").notNull().default("legacy"),
    // The ordinal of this agent() call within the run (0-based).
    callIndex: integer("call_index").notNull(),
    subagent: text("subagent"),
    // The prompt is stored so a resume can assert the call still matches (a
    // script edit that changes call N invalidates N onward).
    prompt: text("prompt").notNull(),
    result: text("result"),
    status: text("status").notNull(), // running | completed | failed
    error: text("error"),
    // The eve session this step opened (set at step START, so the UI can steer a
    // RUNNING step) and the subagent's child session under it (from the step
    // stream's subagent.called event) — the steerable target.
    sessionId: text("session_id"),
    childSessionId: text("child_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.attempt, t.callIndex] }),
    index("workflow_run_journal_run_call_idx").on(t.runId, t.callIndex, t.attempt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Automation run history + audit log — append-only observability tables      */
/*                                                                            */
/* `automation_runs` records every fire of an automation (a dynamic schedule  */
/* rule, a code-authored system cron, or later a connector sync / workflow    */
/* delegation): one row per run, written best-effort by the run itself (see   */
/* agent/lib/automation-runs.ts — a bookkeeping failure never takes down the  */
/* run it describes). `automation_audit` records every human/config change    */
/* made through the Ops Center API as a human-readable sentence. Both are     */
/* append-only: no FK to the automation row, so history survives deletes.     */
/* -------------------------------------------------------------------------- */

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    // Drives per-org usage/cost aggregation (§7 Usage & limits).
    orgId: text("org_id").notNull(),
    // "schedule" | "system_cron" | "connector" | "workflow"
    automationType: text("automation_type").notNull(),
    // The automation row's uuid, or the system cron's name (a closed set).
    automationId: text("automation_id").notNull(),
    // "success" | "failed" | "running"
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms"),
    // One-line human summary of what the run did.
    summary: text("summary"),
    error: text("error"),
    // The durable workflow run this cron fire triggered (a cron routed to a
    // workflow is executed by the front-end cron runner). Lets an invocation
    // link to the run — opened as a chat with an "auto-triggered" badge.
    workflowRunId: text("workflow_run_id"),
    // Idempotency key for runs assembled from a STREAM of events rather than
    // written once at the end: a workflow (subagent) turn emits one
    // `step.completed` per model call, and each one adds its usage to the same
    // row. Unique, so the hook can upsert. Null for runs written in one shot
    // (schedules, system crons).
    runKey: text("run_key").unique(),
    // Token usage, accumulated across every model step of the run. Null when
    // the runtime reported no usage (or for runs that never had a model call).
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    // What the provider charged, when it says so.
    costUsd: doublePrecision("cost_usd"),
  },
  (t) => [
    index("automation_runs_lookup_idx").on(
      t.automationType,
      t.automationId,
      t.startedAt.desc(),
    ),
  ],
);

/**
 * Which workspace, and which person, an agent session belongs to.
 *
 * A declared subagent runs in its own child session, and eve gives an internal runtime path no identity:
 * `auth.current` and `auth.initiator` are both null there (eve docs, auth-and-route-protection). Every tool
 * resolves its workspace from that identity, so inside a subagent it resolved from nothing and fell back to
 * the default workspace — and for anyone outside that workspace the database refused the subagent's writes
 * (fail-closed RLS) while the main agent's, which carry the person's identity, went through.
 *
 * The root agent writes one row per session when a turn starts (agent/instructions/runtime-context.ts); a
 * child session finds its ROOT session's row through `ctx.session.parent.rootSessionId`, which comes from the
 * framework and never from the model. See agent/lib/session-scope.ts.
 */
export const agentSessionScopes = pgTable(
  "agent_session_scopes",
  {
    sessionId: text("session_id").primaryKey(),
    orgId: text("org_id").notNull(),
    principalEmail: text("principal_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_session_scopes_org_idx").on(t.orgId, t.updatedAt)],
);

/**
 * Token usage of ORDINARY chat turns — the main agent, not a workflow.
 *
 * `automation_runs` accounts for subagent (workflow) turns through each
 * subagent's `hooks/usage.ts`; the root agent had no such hook, so every chat
 * turn a person typed was billed nowhere. Measured on Workers AI, a first turn
 * is ~32,400 input tokens (about 4.5 cents) and nothing in the product showed
 * it. This table is the missing ledger: one row per (eve session, turn),
 * ASSEMBLED from a stream of `step.completed` events exactly like the
 * workflow rows — each step ADDS its usage and bumps `steps`; `turn.completed`
 * / `turn.failed` / `turn.cancelled` set the terminal status.
 *
 * Org-scoped and under `org_isolation` like every other tenanted table. The
 * hook resolves the workspace from the session's authenticated caller and
 * writes NOTHING when it cannot — a row with a guessed org is worse than none.
 * Cost is deliberately not stored: prices change, tokens do not. The read API
 * prices rows at request time from `lib/inference-pricing.ts`.
 */
export const chatTurnUsage = pgTable(
  "chat_turn_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    eveSessionId: text("eve_session_id").notNull(),
    turnId: text("turn_id").notNull(),
    /** The signed-in person who sent the turn, when the session carries one. */
    actorEmail: text("actor_email"),
    /** The configured model id at the time (e.g. `@cf/zai-org/glm-5.2`). */
    model: text("model"),
    /** Model calls in the turn so far. */
    steps: integer("steps").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    // "running" | "success" | "failed" | "cancelled"
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // One row per turn: the upsert key the hook accumulates into.
    uniqueIndex("chat_turn_usage_turn_uidx").on(t.eveSessionId, t.turnId),
    // The read API's shape: one workspace over a date range.
    index("chat_turn_usage_org_started_idx").on(t.orgId, t.startedAt),
  ],
);

export const automationAudit = pgTable(
  "automation_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    orgId: text("org_id").notNull(),
    automationType: text("automation_type").notNull(),
    automationId: text("automation_id").notNull(),
    // The caller's email when the client sent one, else "web"; "system" for
    // changes the runtime makes on its own.
    actor: text("actor").notNull(),
    // Human sentence, e.g. `Cadence changed 60m → 30m`.
    event: text("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automation_audit_lookup_idx").on(
      t.automationType,
      t.automationId,
      t.createdAt.desc(),
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Connector secrets + runtime env presence                                   */
/*                                                                            */
/* Two tables, because "is this connector's token working?" and "what token   */
/* did an operator type into the Ops Center?" are DIFFERENT questions and     */
/* conflating them is how a UI ends up lying about a credential.              */
/*                                                                            */
/* `runtime_env_presence` is the truth about the RUNNING agent: the dispatcher*/
/* (which fires every minute) reports which env var names are set in its own  */
/* process. Names and a boolean only — a value never leaves the process.      */
/*                                                                            */
/* `connector_secrets` is what an operator stored HERE. It is encrypted at    */
/* rest (AES-256-GCM, key from OPS_SECRETS_KEY — see lib/secret-crypto.ts)    */
/* and the API never returns a plaintext value, only whether one exists. It   */
/* does not reach the agent by itself: eve's connection modules read          */
/* process.env at import time, so a stored secret has to be promoted to the   */
/* agent's environment to go live. The UI says exactly that.                  */
/* -------------------------------------------------------------------------- */

export const connectorSecrets = pgTable(
  "connector_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenant scope (nullable → backfills to 'onfinance'; NOT NULL deferred).
    // NOT NULL, and load-bearing: the workspace id is the HKDF salt for this
    // row's key, so one org's dump can't decrypt another's. A null here would
    // have meant ciphertext sealed with the shared master key — the ORM said
    // nullable while the database already said NOT NULL, and the crypto had a
    // silent fallback for the case. All three now agree that it is required.
    orgId: text("org_id").notNull(),
    connectorId: uuid("connector_id").notNull(),
    // The ENV VAR name this secret is for (GITHUB_TOKEN, SLACK_BOT_TOKEN, …).
    name: text("name").notNull(),
    // AES-256-GCM. The plaintext is never stored, logged, or returned.
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    // WHICH key sealed this row. Without it a key can never be retired: you
    // cannot re-encrypt what you cannot tell apart. 1 = OPS_SECRETS_KEY,
    // 2 = OPS_SECRETS_KEY_V2, and so on — see lib/secret-crypto.ts.
    keyVersion: integer("key_version").notNull().default(1),
    // Last 4 characters, for "is this the token I think it is?" — nothing more.
    hint: text("hint"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connector_secrets_idx").on(t.connectorId, t.name)],
);

export const runtimeEnvPresence = pgTable("runtime_env_presence", {
  // The env var name. NEVER the value.
  name: text("name").primaryKey(),
  present: boolean("present").notNull(),
  // When the agent last reported on this name.
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Multiplayer chat: sharing a thread with @onfinance.in teammates.           */
/* A "thread" is otherwise a client-side localStorage construct; a row here is */
/* created only when a thread is SHARED, so it becomes server-authoritative    */
/* (ownership, membership, and server custody of the resume token). The full   */
/* event stream is NOT stored — eve replays it from GET /eve/v1/session/:id.   */
/* -------------------------------------------------------------------------- */

export const chatThreads = pgTable(
  "chat_threads",
  {
    orgId: text("org_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    // The owner's StoredSession.clientKey — reconciles the local thread with
    // this row so re-sharing updates instead of forking.
    clientKey: text("client_key"),
    // Current eve session id (eve may re-mint mid-stream; latest wins).
    eveSessionId: text("eve_session_id").notNull(),
    title: text("title").notNull(),
    preview: text("preview"),
    customers: jsonb("customers").$type<string[]>(),
    forkedFrom: jsonb("forked_from").$type<{ id: string; title: string }>(),
    ownerEmail: text("owner_email").notNull(),
    // SERVER CUSTODY of the resume capability — null while a turn is running.
    // Once a thread is shared the token lives ONLY here, never on any client:
    // that is both the concurrency serialization and the token-leak fix.
    continuationToken: text("continuation_token"),
    // Who holds the in-flight turn (for the "held by alice@" composer pill) and
    // when they claimed it (stall detection for an abandoned claim).
    turnHolder: text("turn_holder"),
    turnClaimedAt: timestamp("turn_claimed_at", { withTimezone: true }),
    // ONLY the synthesized `client.input.responded` markers — the eve replay
    // lacks them, so answered questions would revert without this (see
    // chat-shell openChat). NOT the full event stream.
    clientEvents: jsonb("client_events").$type<unknown[]>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_threads_owner_idx").on(t.ownerEmail),
    index("chat_threads_session_idx").on(t.eveSessionId),
  ],
);

export const chatThreadMembers = pgTable(
  "chat_thread_members",
  {
    orgId: text("org_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    email: text("email").notNull(),
    // 'owner' | 'participant' | 'viewer'.
    role: text("role").notNull(),
    // 'invited' | 'accepted' | 'revoked'. Opening an invited thread = accepting.
    status: text("status").notNull().default("invited"),
    invitedBy: text("invited_by").notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.email] }),
    index("chat_thread_members_email_idx").on(t.email, t.status),
  ],
);

export const chatTurnAuthors = pgTable(
  "chat_turn_authors",
  {
    orgId: text("org_id").notNull(),
    // eve has no per-message author; we attribute a turn to the sender by the
    // event offset at which their message landed in the stream.
    threadId: uuid("thread_id").notNull(),
    eventOffset: integer("event_offset").notNull(),
    authorEmail: text("author_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.eventOffset] })],
);

export const chatPresence = pgTable(
  "chat_presence",
  {
    orgId: text("org_id").notNull(),
    // Polled heartbeat presence for a shared thread (Vercel has no WebSockets /
    // LISTEN-NOTIFY, so members POST every ~10s while the thread is open).
    threadId: uuid("thread_id").notNull(),
    email: text("email").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Set a few seconds ahead while the member is actively typing.
    typingUntil: timestamp("typing_until", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.email] })],
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    // Browser capabilities are tenant-owned. These fields are deliberately
    // non-null: a missing scope must fail at write time, never become a global
    // session that another workspace can discover by UUID.
    orgId: text("org_id").notNull(),
    principalId: text("principal_id").notNull(),
    // A serverless function keeps no in-memory browser handle between tool
    // calls, so the session key lives here: browser_open creates a row (or
    // re-attaches to a live one for this eve session), every other tool looks
    // it up and connectOverCDP's the provider's still-alive browser.
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // "browserbase" | "local"
    providerSessionId: text("provider_session_id").notNull(),
    // CDP and live-view URLs are bearer capabilities. They are AES-256-GCM
    // sealed with an org-derived OPS_SECRETS_KEY before persistence; plaintext
    // exists only inside the agent process for the duration of an operation.
    capabilityKeyVersion: integer("capability_key_version").notNull().default(1),
    connectUrlCiphertext: text("connect_url_ciphertext").notNull(),
    connectUrlIv: text("connect_url_iv").notNull(),
    connectUrlTag: text("connect_url_tag").notNull(),
    liveViewUrlCiphertext: text("live_view_url_ciphertext"),
    liveViewUrlIv: text("live_view_url_iv"),
    liveViewUrlTag: text("live_view_url_tag"),
    /**
     * HUMAN CONTROL LOCK.
     *
     * The live view is interactive, so an operator clicking into it drives the
     * same page the agent is driving — with nothing arbitrating. Two hands on
     * one browser is worst exactly when it matters: mid-login, where the agent
     * can navigate away from a form a human is typing into, or submit a page
     * they were still reading.
     *
     * `controlHeldBy` is the operator's email while they hold it; null when the
     * agent is free to act. `controlExpiresAt` is a deadline, not a nicety —
     * without it, a closed laptop wedges the browser for every later turn, and
     * a lock nobody can clear is worse than no lock.
     */
    controlHeldBy: text("control_held_by"),
    controlHeldAt: timestamp("control_held_at", { withTimezone: true }),
    controlExpiresAt: timestamp("control_expires_at", { withTimezone: true }),
    // The eve session that owns this browser session (one per eve session ×
    // customer), so parallel subagent steps get separate browsers naturally.
    eveSessionId: text("eve_session_id"),
    customerId: text("customer_id"),
    // The cookie-sharing decision is explicit and auditable. The actual
    // persistent-context identity lives on browser_contexts.scope_key.
    contextScope: text("context_scope").notNull().default("principal"), // principal | team
    status: text("status").notNull().default("open"), // open | closing | release_failed | closed
    releaseAttempts: integer("release_attempts").notNull().default(0),
    releaseError: text("release_error"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("browser_sessions_eve_idx").on(t.orgId, t.principalId, t.eveSessionId, t.status),
    index("browser_sessions_sweep_idx").on(t.status, t.lastUsedAt),
  ],
);

export const browserAllowlist = pgTable(
  "browser_allowlist",
  {
    orgId: text("org_id").notNull(),
    // Per-customer (or global when customer_id is null) navigation allow-list.
    // Enforcement is DEFAULT-DENY once any entry exists (or the env default is
    // set): the browser may only navigate to listed origins. Unconfigured =
    // permissive + audited, so Phase 1 browsing keeps working until an operator
    // locks it down.
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id"), // null = applies to all customers
    origin: text("origin").notNull(), // e.g. "https://app.acme-bank.com" or "acme-bank.com"
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("browser_allowlist_lookup_idx").on(t.orgId, t.customerId)],
);

export const browserCredentials = pgTable(
  "browser_credentials",
  {
    orgId: text("org_id").notNull(),
    // Per-customer, per-site login credentials for browser_login. The secret is
    // AES-256-GCM sealed (secret_ciphertext/iv/tag) with OPS_SECRETS_KEY; the
    // agent decrypts it INSIDE the tool's execute(), types it over CDP, and never
    // returns it. No route ever returns the plaintext (only username + hint).
    // NOT the primary key — the natural key below is. Postgres allows exactly
    // one PRIMARY KEY per table, so declaring both made this table impossible
    // to create from schema.ts ("multiple primary keys ... are not allowed").
    // It went unnoticed because the live table was hand-created by
    // .migrate-browser-credentials.mjs, which had it right; only a from-scratch
    // build ever reads this definition. Every query, the upsert conflict target
    // and the delete all key on (customer_id, site_origin).
    id: uuid("id").defaultRandom().notNull(),
    customerId: text("customer_id").notNull(),
    siteOrigin: text("site_origin").notNull(), // e.g. "app.acme-bank.com"
    username: text("username").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    secretHint: text("secret_hint"), // last-4, to recognise which secret is stored
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.customerId, t.siteOrigin] })],
);

export const browserContexts = pgTable(
  "browser_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // Cookie state is principal-private by default. A caller must explicitly
    // choose `team`, producing scope_key="team"; otherwise the key contains
    // the authenticated principal id. This prevents same-slug customers in
    // different workspaces (or users) from sharing provider cookies.
    customerId: text("customer_id").notNull(),
    scopeType: text("scope_type").notNull(), // principal | team
    scopeKey: text("scope_key").notNull(),
    createdBy: text("created_by").notNull(),
    provider: text("provider").notNull(),
    providerContextId: text("provider_context_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("browser_contexts_scope_uidx").on(t.orgId, t.customerId, t.scopeKey),
    index("browser_contexts_org_idx").on(t.orgId, t.lastUsedAt),
  ],
);

/**
 * Per-user chat threads — the DURABLE mirror of the sidebar's thread list, so a
 * user's chats follow their account across browsers/devices (the localStorage
 * store stays as the instant-open + offline cache). Metadata only: the message
 * history is REPLAYED from the eve session on open (eve retains it durably), so
 * this table never holds the event stream. Distinct from `chat_threads`, which
 * exists only for MULTIPLAYER sharing.
 */
export const chatSessions = pgTable(
  "chat_sessions",
  {
    // The client-generated session id (StoredSession.id).
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    clientKey: text("client_key"),
    title: text("title"),
    preview: text("preview"),
    messageCount: integer("message_count"),
    customers: jsonb("customers").$type<string[]>(),
    forkedFrom: jsonb("forked_from").$type<{ id: string; title: string }>(),
    // The eve session to replay from on open (+ its resume token when parked).
    eveSessionId: text("eve_session_id"),
    continuationToken: text("continuation_token"),
    derivedCustomers: jsonb("derived_customers").$type<string[]>(),
    toolCounts: jsonb("tool_counts").$type<{ artifacts: number; emails: number }>(),
    archived: boolean("archived").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_sessions_owner_idx").on(t.ownerEmail, t.orgId, t.updatedAt.desc())],
);

/* -------------------------------------------------------------------------- */
/* Agent profiles — "personalize my agent". One org-default row (email = '')   */
/* plus optional per-user override rows. The effective profile = the user row  */
/* merged over the org default; it feeds the harness via                       */
/* `agent/instructions/agent-profile.ts` (defineDynamic) and seeds composer    */
/* defaults. Persona/tone/instructions are user-authored guidance, never       */
/* trusted as higher-priority than platform instructions.                      */
/* -------------------------------------------------------------------------- */
export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    // '' = the workspace default; a specific email = that member's override.
    email: text("email").notNull().default(""),
    // What the agent calls itself (display persona), e.g. "Ava".
    personaName: text("persona_name"),
    // Freeform tone hint, e.g. "concise, direct" / "warm, explains reasoning".
    tone: text("tone"),
    // Standing custom instructions injected every turn.
    instructions: text("instructions"),
    // Composer defaults.
    defaultMode: text("default_mode"), // build | plan | goal | loop
    webSearchDefault: boolean("web_search_default"),
    browserDefault: boolean("browser_default"),
    // Preferred model reference (null = platform default).
    model: text("model"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profiles_org_email_idx").on(t.orgId, t.email)],
);

/* -------------------------------------------------------------------------- */
/* Room presence — workspace-scoped "who's here now", generalizing chat        */
/* presence to arbitrary rooms (e.g. `readiness` or `readiness:acme-bank`).    */
/* Polled heartbeats (Vercel has no WebSockets): "online" = seen in the last   */
/* ~25s. Powers watching multiple teammates get a data room V1-ready live.     */
/* -------------------------------------------------------------------------- */
export const roomPresence = pgTable(
  "room_presence",
  {
    orgId: text("org_id").notNull(),
    // Free-form room key: a view (`readiness`) or an entity (`readiness:acme`).
    room: text("room").notNull(),
    email: text("email").notNull(),
    // Optional short label of what they're doing ("editing go-live date").
    activity: text("activity"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.room, t.email] })],
);

/* -------------------------------------------------------------------------- */
/* Agent configs — per-subagent workspace state: paused (the orchestrator      */
/* won't delegate to it) and custom instructions (injected when it runs). One  */
/* row per (org, agentKey) where agentKey is the subagent dir name             */
/* (research, deployment, …). Powers the Workspace "Agents" tab pause/resume + */
/* per-agent personalization.                                                  */
/* -------------------------------------------------------------------------- */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    orgId: text("org_id").notNull(),
    agentKey: text("agent_key").notNull(),
    paused: boolean("paused").notNull().default(false),
    instructions: text("instructions"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.agentKey] })],
);

/**
 * Every state an agent's instructions have ever been in.
 *
 * A prompt IS the agent's behaviour, and `agent_configs.instructions` is edited
 * in place — so "why did Research start doing that on Tuesday" was
 * unanswerable: the previous text was simply gone, and the audit row said only
 * that someone changed it. This keeps the full text of each state so a change
 * can be read as a diff and put back.
 *
 * One row per EDIT SESSION, holding the text after it. Rows are appended, and
 * the newest is rewritten in place while its author is still editing — the
 * panel saves on idle, so row-per-write would make this a keystroke log rather
 * than a history.
 *
 * The before-state is the preceding row — the same reconstruction
 * dataroom_file_versions uses, and for the same reason: storing both sides of
 * every edit would duplicate the entire history.
 */
export const agentPromptVersions = pgTable(
  "agent_prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    agentKey: text("agent_key").notNull(),
    instructions: text("instructions"),
    actor: text("actor").notNull(),
    /** 'edit' | 'restore' — a restore also names the version it came from. */
    kind: text("kind").notNull().default("edit"),
    restoredFrom: uuid("restored_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_prompt_versions_lookup_idx").on(t.orgId, t.agentKey, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Workflow definitions — the "Project workflows" state-machine spec. A named  */
/* workflow over one entity (task | implementation) with ordered STAGES; each  */
/* stage carries its assign rule + outgoing transitions (see                   */
/* lib/workflow-types.ts). The agent reads these to know how to assign and     */
/* migrate work; the board renders them as columns.                            */
/* -------------------------------------------------------------------------- */
export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // task | implementation
    entity: text("entity").notNull(),
    // WorkflowStage[] from lib/workflow-types.ts
    stages: jsonb("stages").$type<unknown[]>().notNull().default([]),
    // Monotonically increasing immutable snapshot number. Running task
    // instances pin one version so editing a workflow never rewrites history.
    currentVersion: integer("current_version").notNull().default(1),
    // One default per (org, entity), enforced by the task-workflow service.
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: text("created_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_definitions_org_idx").on(t.orgId)],
);

/** Immutable workflow snapshots. Task instances reference these, not the
 * mutable editor row above. */
export const projectWorkflowVersions = pgTable(
  "project_workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    entity: text("entity").notNull(),
    stages: jsonb("stages").$type<unknown[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_workflow_versions_number_idx").on(t.orgId, t.workflowId, t.version),
    index("project_workflow_versions_workflow_idx").on(t.workflowId, t.createdAt),
  ],
);

/** The exact workflow/stage currently governing a task. */
export const taskWorkflowInstances = pgTable(
  "task_workflow_instances",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => todos.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    stageId: text("stage_id").notNull(),
    state: text("state").notNull().default("active"),
    automationState: text("automation_state").notNull().default("idle"),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_workflow_instances_org_stage_idx").on(t.orgId, t.workflowId, t.stageId),
    index("task_workflow_instances_version_idx").on(t.workflowVersionId),
  ],
);

/** Append-only transition ledger. Deliberately not FK-cascaded from todos: a
 * task deletion must not erase its process audit trail. */
export const taskWorkflowTransitionEvents = pgTable(
  "task_workflow_transition_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    fromStageId: text("from_stage_id"),
    toStageId: text("to_stage_id").notNull(),
    trigger: text("trigger").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_workflow_events_task_idx").on(t.orgId, t.taskId, t.createdAt),
    uniqueIndex("task_workflow_events_idempotency_idx").on(t.orgId, t.idempotencyKey),
  ],
);

/* -------------------------------------------------------------------------- */
/* Orgs (workspaces) — the tenant layer ABOVE customers/roster/connectors.    */
/* OnFinance is org #1 (slug 'onfinance'). Everything global (connectors,     */
/* workflows, apps, cycles, todos, roster, memories, schedules, secrets) is   */
/* scoped to an org via a nullable `org_id` that backfills to 'onfinance';    */
/* customer-scoped tables inherit their org through the customer FK.          */
/* See docs/plan: Org Onboarding & Control Plane.                             */
/* -------------------------------------------------------------------------- */

export const orgs = pgTable("orgs", {
  // Slug PK, e.g. 'onfinance' — derived live from the company name in the UI.
  orgId: text("org_id").primaryKey(),
  name: text("name").notNull(),
  // The Google Workspace `hd` claim → org lookup. Unique; null for orgs that
  // sign in only via per-email invites (consumer-domain companies).
  googleHostedDomain: text("google_hosted_domain").unique(),
  // Branding + plan/limits as loose jsonb so the shape can evolve without DDL.
  branding: jsonb("branding").$type<{ logoUrl?: string; displayName?: string }>(),
  plan: text("plan"), // free | pro | enterprise (stub until billing)
  limits: jsonb("limits").$type<{ monthlyTokenCap?: number; monthlyCostUsdCap?: number; workflowRunCap?: number }>(),
  billing: jsonb("billing").$type<{ plan?: string; externalCustomerId?: string }>(),
  // New writes land under this blob prefix; OnFinance's legacy root is aliased.
  blobPrefix: text("blob_prefix"),
  dataResidency: text("data_residency"), // optional region hint per org
  status: text("status").notNull().default("provisioning"), // provisioning | active | suspended
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | engineer | member
    invitedBy: text("invited_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When this member last chose this workspace in the switcher.
     *
     * The agent had no way to know: it re-resolved the workspace from the
     * caller's identity on every turn, so someone in two workspaces got
     * whichever membership the query happened to return — the console showing
     * one tenant while the agent answered from the other. The switcher stamps
     * this, and both resolvers prefer the most recently chosen.
     */
    lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.email] }),
    index("org_members_email_idx").on(t.email),
  ],
);

export const orgInvites = pgTable(
  "org_invites",
  {
    // A not-yet-member can't pass the gate, so the invite carries its own token.
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // Only the HASH of the token is stored; the plaintext is emailed once.
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_invites_org_idx").on(t.orgId),
    index("org_invites_token_idx").on(t.tokenHash),
  ],
);

/**
 * One-time sign-in codes for people Google cannot vouch for.
 *
 * Deliberately NOT tenant-scoped: at the moment a code is requested we know an
 * email address and nothing else — which workspace they belong to is decided
 * after they authenticate, and an invitee may belong to several. Adding an
 * org_id here would mean guessing one, and guessing wrong locks the person out
 * of the workspace that actually invited them.
 *
 * Only the code's HMAC is stored. `attempts` caps guessing (a six-digit code is
 * only safe while the number of tries is small), and `consumedAt` makes it
 * single-use — without it a code stays valid for its whole lifetime after being
 * used, which is the classic replay in this flow.
 */
export const loginCodes = pgTable(
  "login_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("login_codes_email_idx").on(t.email, t.createdAt),
  ],
);

/**
 * Platform operators — the people allowed to CREATE orgs (a global allowlist,
 * distinct from any org membership). Kept tiny and separate so org provisioning
 * is a privileged action, not something an org owner can self-escalate to.
 */
export const platformAdmins = pgTable("platform_admins", {
  email: text("email").primaryKey(),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Recipe registry — the versioned, per-org catalog the onboarding handoff hands
 * to a customer's coding agents (`--recipes a,b,c`). "Extensibility = a row,
 * not a code change": mirrors the seed-pack seam. The built-in recipes
 * (onboard-self, import-roster, connect-sources, seed-workflows,
 * onboard-customer) are seeded INTO EACH WORKSPACE by provisionWorkspace when
 * it is created; there are no global rows (org_id is NOT NULL and the
 * fail-closed policy scopes reads to one org). An org can add/override its own.
 */
export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    slug: text("slug").notNull(), // onboard-self | import-roster | ...
    version: text("version").notNull().default("1"),
    title: text("title").notNull(),
    summary: text("summary"),
    // The instructions the remote coding agent runs, + which health check it
    // satisfies (so the checklist can turn green from GET org health).
    body: text("body"),
    satisfiesCheck: text("satisfies_check"), // members | roster | connector | workflows | dataroom | customer
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recipes_org_slug_idx").on(t.orgId, t.slug)],
);

/* -------------------------------------------------------------------------- */
/* Data-room version control                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A CHANGESET — one intentional batch of data-room writes.
 *
 * A backfill is not forty unrelated file writes; it is one act with forty
 * consequences. Recording it as such is what makes it reviewable as a whole and
 * undoable as a whole. Without this the only unit was a single overwrite, so a
 * bad backfill had to be picked apart file by file, from an audit trail that
 * recorded WHAT changed but never the bytes it replaced.
 */
export const dataroomChangesets = pgTable(
  "dataroom_changesets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    /** What this batch was for, in the author's words. */
    label: text("label").notNull(),
    /** Verified caller — a person's email, or the agent. */
    actor: text("actor").notNull(),
    /** "cli" | "agent" | "web" — how the writes arrived. */
    source: text("source").notNull().default("web"),
    /** Why, carried from the write tools' rationale. */
    rationale: text("rationale"),
    /** True when no human reviewed it (see the CLI's unattended approval mode). */
    unattended: boolean("unattended").notNull().default(false),
    /** open → committed → reverted. An open changeset is still collecting files. */
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertedBy: text("reverted_by"),
  },
  (t) => [index("dataroom_changesets_org_idx").on(t.orgId, t.createdAt)],
);

/**
 * One file's before-state within a changeset.
 *
 * `prevBlobKey` points at a SNAPSHOT of the bytes this write replaced, taken
 * before the overwrite. That snapshot is the entire point: the audit trail could
 * always say a file changed, but nothing could say what it used to be, so
 * "revert" was not a thing anyone could offer.
 */
export const dataroomFileVersions = pgTable(
  "dataroom_file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    /** Null for a one-off write that was not part of a batch. */
    changesetId: uuid("changeset_id"),
    path: text("path").notNull(),
    /** create | update | append | delete — what this write did to the path. */
    action: text("action").notNull(),
    /** Blob key holding the PREVIOUS bytes. Null when the file did not exist. */
    prevBlobKey: text("prev_blob_key"),
    prevBytes: integer("prev_bytes"),
    newBytes: integer("new_bytes"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dataroom_file_versions_changeset_idx").on(t.changesetId),
    index("dataroom_file_versions_path_idx").on(t.orgId, t.path, t.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Inbox — off-platform conversations, staged before they reach the data room  */
/* -------------------------------------------------------------------------- */

/**
 * One off-platform message (email, Granola note, Slack thread) waiting to be
 * turned into a data-room record.
 *
 * This is a STAGING table on purpose. The alternative — writing straight into
 * `interactions` with a draft status, the way email intake stages tickets —
 * puts un-reviewed raw material inside the record the account report and QBR
 * workflows read from. Keeping it out until a human has grouped and confirmed
 * it is the whole point of the panel.
 *
 * Ingestion is idempotent: a sync that re-reads the same mailbox must not
 * duplicate rows, hence the unique key on (org_id, source, external_id).
 * `thread_key` is what the panel groups by — a mail thread id, a Granola note
 * id, a Slack thread ts — so a back-and-forth arrives as ONE conversation
 * rather than nine unrelated items.
 */
export const inboxItems = pgTable(
  "inbox_items",
  {
    orgId: text("org_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    /** "email" | "granola" | "slack" — kept as text so a new source needs no migration. */
    source: text("source").notNull(),
    /** The provider's own id. Dedupe key; never shown. */
    externalId: text("external_id").notNull(),
    /** Groups messages into one conversation. Falls back to externalId when a
     *  source has no threading concept. */
    threadKey: text("thread_key").notNull(),
    subject: text("subject"),
    /** Short line for the list; the full text lives in `body`. */
    preview: text("preview"),
    body: text("body"),
    participants: jsonb("participants").$type<string[]>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Best-effort customer match (by sender domain). Null means unmatched —
     *  the panel makes that visible rather than guessing. */
    customerId: text("customer_id"),
    /** "new" | "promoted" | "dismissed". Promoted and archived rows are kept,
     *  not deleted, so a re-sync cannot resurrect something already dealt with. */
    status: text("status").notNull().default("new"),
    /** When someone opened it. NULL = unread. A timestamp rather than a boolean
     *  so "unread since" is answerable without a second column. */
    readAt: timestamp("read_at", { withTimezone: true }),
    /** What promotion produced, for traceability back out of the data room. */
    promotedInteractionId: text("promoted_interaction_id"),
    promotedTicketId: text("promoted_ticket_id"),
    promotedBy: text("promoted_by"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbox_items_dedupe_uidx").on(t.orgId, t.source, t.externalId),
    index("inbox_items_org_status_idx").on(t.orgId, t.status),
    index("inbox_items_thread_idx").on(t.orgId, t.threadKey),
  ],
);
