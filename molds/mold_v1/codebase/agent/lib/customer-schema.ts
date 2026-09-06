import { z } from "zod";

export const ticketStatusSchema = z.enum([
  "Open",
  "In Progress",
  "Blocked",
  "Waiting on Customer",
  "Waiting on Eng",
  "Waiting on Vendor",
  "Needs Triage",
  "Mitigated",
  "Monitoring",
  "Reopened",
  "Resolved",
  "Closed",
  "Won't Fix",
]);

// The five canonical ticket categories every ticket is classified into.
export const ticketCategorySchema = z.enum([
  "Feature Request",
  "Bug Report",
  "Data Migration Request",
  "Configuration Change Request",
  "Workflow Customization Request",
]);
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

/** Which FDE specialist a category routes to for triage. */
export const TICKET_CATEGORY_ROUTING: Record<TicketCategory, string> = {
  "Feature Request": "follow-ups",
  "Bug Report": "deployment",
  "Data Migration Request": "data-migration",
  "Configuration Change Request": "configuration",
  "Workflow Customization Request": "configuration",
};

const percentSchema = z.number().min(0).max(100);
const urlOrEmptySchema = z.string().url().or(z.literal(""));

export const platformSchema = z.object({
  tenantId: z.string().min(1).optional(),
  platformConfigStatus: z.enum(["Draft", "Pending Security Review", "Approved", "Active", "Suspended", "Retired"]).optional(),
  deploymentModel: z.enum(["multi_tenant_saas", "single_tenant_vpc", "customer_cloud_byoc", "on_prem"]),
  dataResidencyConstraint: z.enum(["none", "us_only", "eu_only", "in_country_only", "apac_only"]),
  authMode: z.enum(["saml_sso", "oidc", "google_oauth", "magic_link", "api_key"]).optional(),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  piiHandling: z.enum(["none", "mask_in_prompts", "redact_and_log", "customer_managed"]).optional(),
  auditLoggingEnabled: z.boolean().optional(),
  retentionDays: z.number().int().positive().optional(),
  aiGovernanceStatus: z.enum(["Not Started", "In Review", "Approved", "Exception Granted", "Blocked"]).optional(),
  modelPolicyId: z.string().optional(),
  allowedModelProviders: z.array(z.enum(["openai", "anthropic", "google", "azure_openai", "bedrock", "self_hosted"])).optional(),
  modelDataUsePolicy: z.enum(["zero_retention", "no_training", "provider_default", "customer_managed"]).optional(),
  inferenceRegion: z.string().optional(),
  crossBorderProcessingAllowed: z.boolean().optional(),
  guardrailPolicy: z.string().optional(),
  guardrailPolicyVersion: z.string().optional(),
  guardrailEnforcementMode: z.enum(["off", "monitor", "block", "human_review"]).optional(),
  promptLoggingMode: z.enum(["disabled", "metadata_only", "redacted", "full"]).optional(),
  customerManagedKeyEnabled: z.boolean().optional(),
  kmsKeyRef: z.string().optional(),
  scimProvisioningEnabled: z.boolean().optional(),
  rbacPolicy: z.enum(["basic", "department", "role_based", "custom"]).optional(),
  // "provider" = whoever runs this platform, as opposed to the customer's own
  // SIEM or bucket. It was one company's name, offered to every workspace.
  auditLogSink: z.enum(["none", "provider", "customer_siem", "customer_bucket"]).optional(),
  observabilityEnabled: z.boolean().optional(),
  primaryModel: z.string().min(1),
  fallbackModel: z.string().optional(),
  minimumEvalScorePct: percentSchema.optional(),
  lastGovernanceReviewAt: z.string().optional(),
  monthlySpendLimitUsd: z.number().nonnegative().optional(),
  enabledConnectors: z.array(z.string()),
  featureFlags: z.array(z.string()),
  primaryUseCase: z.string().min(1),
  lastHealthCheckAt: z.string().optional(),
});

export const deploymentSchema = z.object({
  deploymentId: z.string().min(1),
  environment: z.enum(["prod", "staging", "uat", "sandbox", "dev"]),
  region: z.enum([
    "us-east-1",
    "us-west-2",
    "eu-west-1",
    "eu-central-1",
    "ap-southeast-1",
    "ap-south-1",
    "ca-central-1",
    "customer-vpc",
    "on-prem",
  ]),
  cloudProvider: z.enum(["aws", "gcp", "azure", "vercel", "customer_cloud", "on_prem"]).optional(),
  runtime: z.string().optional(),
  deploymentStrategy: z.enum(["rolling", "blue_green", "canary", "preview", "manual"]).optional(),
  deployedVersion: z.string().min(1),
  releaseId: z.string().optional(),
  releaseChannel: z.enum(["stable", "rc", "beta", "hotfix", "preview"]).optional(),
  buildSha: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  runtimeVersion: z.string().optional(),
  configVersion: z.string().optional(),
  approvedByEmail: z.string().email().optional(),
  approvedAt: z.string().optional(),
  modelRouteId: z.string().optional(),
  modelRoutingMode: z.enum(["primary_only", "fallback", "traffic_split", "shadow", "disabled"]).optional(),
  primaryModelRef: z.string().optional(),
  primaryModelVersion: z.string().optional(),
  fallbackModelRef: z.string().optional(),
  fallbackModelVersion: z.string().optional(),
  modelTrafficPrimaryPct: percentSchema.optional(),
  lastDeployAt: z.string().optional(),
  releaseStatus: z.enum(["deployed", "in-progress", "pending-approval", "rolled-back", "failed"]),
  rollbackVersion: z.string().optional(),
  rollbackStatus: z.enum(["not_required", "ready", "in_progress", "completed", "failed", "blocked"]).optional(),
  rollbackTestedAt: z.string().optional(),
  healthStatus: z.enum(["healthy", "degraded", "down", "unknown"]),
  uptime30dPct: percentSchema.optional(),
  errorRate30dPct: percentSchema.optional(),
  latencyP95Ms: z.number().nonnegative().optional(),
  latencySloMs: z.number().positive().optional(),
  requestCount30d: z.number().int().nonnegative().optional(),
  llmRequestCount30d: z.number().int().nonnegative().optional(),
  inputTokens30d: z.number().int().nonnegative().optional(),
  outputTokens30d: z.number().int().nonnegative().optional(),
  cacheHitRate30dPct: percentSchema.optional(),
  guardrailBlockRate30dPct: percentSchema.optional(),
  cost30dUsd: z.number().nonnegative().optional(),
  costBudget30dUsd: z.number().nonnegative().optional(),
  projectedCost30dUsd: z.number().nonnegative().optional(),
  capacityLimitRpm: z.number().int().positive().optional(),
  peakRpm30d: z.number().int().nonnegative().optional(),
  utilization30dPct: percentSchema.optional(),
  liveUrl: z.string().url().optional(),
  deployOwnerEmail: z.string().email().optional(),
  lastIncidentRef: z.string().optional(),
  activeIncidentRefs: z.array(z.string()).optional(),
  incidentCount30d: z.number().int().nonnegative().optional(),
  dashboardUrl: z.string().url().optional(),
  runbookUrl: z.string().url().optional(),
  lastTelemetryAt: z.string().optional(),
  notes: z.string().optional(),
});

export const solutionSchema = z.object({
  solutionId: z.string().min(1),
  useCase: z.enum([
    "Research Copilot",
    "Credit/Underwriting Memo Drafting",
    "Compliance Guardrails",
    "Document Extraction",
    "KYC/AML Screening",
    "Earnings/Market Intelligence",
    "Due Diligence Assistant",
    "Custom Eval Harness",
    "Client Reporting Assistant",
    "CRM Migration/Onboarding",
    "Other",
  ]),
  workflowId: z.string().optional(),
  workflowName: z.string().optional(),
  businessProcess: z.string().optional(),
  businessUnit: z.string().optional(),
  primaryUserRole: z.string().optional(),
  workflowOwnerEmail: z.string().email().optional(),
  riskOwnerEmail: z.string().email().optional(),
  workflowFrequency: z.enum(["ad_hoc", "daily", "weekly", "monthly", "quarterly", "event_driven"]).optional(),
  decisionImpact: z.enum(["assistive", "drafts", "recommends", "approves_or_blocks", "autonomous"]).optional(),
  upstreamSystems: z.array(z.string()).optional(),
  downstreamSystems: z.array(z.string()).optional(),
  outputArtifacts: z.array(z.string()).optional(),
  sensitiveDataTypes: z.array(z.string()).optional(),
  valueMetric: z.string().optional(),
  valueMetricUnit: z.string().optional(),
  valueMetricDirection: z.enum(["increase_is_good", "decrease_is_good", "target_band"]).optional(),
  measurementSource: z.string().optional(),
  measurementWindowDays: z.number().int().positive().optional(),
  baselineMetricValue: z.number().optional(),
  currentMetricValue: z.number().optional(),
  targetMetricValue: z.number().optional(),
  baselinePeriodStart: z.string().optional(),
  baselinePeriodEnd: z.string().optional(),
  currentPeriodStart: z.string().optional(),
  currentPeriodEnd: z.string().optional(),
  targetDate: z.string().optional(),
  valueEvidenceUrl: urlOrEmptySchema.optional(),
  annualizedValueRealizedUsd: z.number().nonnegative().optional(),
  valueRealizationConfidencePct: percentSchema.optional(),
  solutionValueRealizationStage: z.enum(["Discovery", "Baseline", "Pilot Value", "Scaled Value", "Renewal Proof"]).optional(),
  modulesEnabled: z.array(z.string()),
  solutionStatus: z.enum(["Scoping", "Piloting", "Live", "Scaling", "Paused", "Deprecated", "Churned"]),
  solutionGoLiveDate: z.string().optional(),
  weeklyActiveUsers: z.number().int().nonnegative().optional(),
  weeklyQueryVolume: z.number().int().nonnegative().optional(),
  automationRatePct: percentSchema.optional(),
  humanReviewRatePct: percentSchema.optional(),
  productionReadinessScore: percentSchema.optional(),
  solutionEvalScorePct: percentSchema.optional(),
  evalStatus: z.enum(["not_configured", "needs_dataset", "running", "passing", "failing", "regressed", "waived"]).optional(),
  evalSuiteId: z.string().optional(),
  evalDatasetVersion: z.string().optional(),
  lastEvalRunId: z.string().optional(),
  lastEvalRunAt: z.string().optional(),
  evalPassRatePct: percentSchema.optional(),
  evalCoveragePct: percentSchema.optional(),
  taskSuccessRatePct: percentSchema.optional(),
  answerAcceptanceRatePct: percentSchema.optional(),
  groundednessScorePct: percentSchema.optional(),
  citationCoveragePct: percentSchema.optional(),
  hallucinationRatePct: percentSchema.optional(),
  policyViolationRatePct: percentSchema.optional(),
  guardrailInterventionRatePct: percentSchema.optional(),
  customerReportedDefects30d: z.number().int().nonnegative().optional(),
  safetyIncidentCount30d: z.number().int().nonnegative().optional(),
  humanReviewPolicy: z.enum(["none", "sampled", "risk_based", "all_outputs", "approval_gate", "exception_only"]).optional(),
  reviewSlaHours: z.number().positive().optional(),
  reviewSlaAttainmentPct: percentSchema.optional(),
  reviewBacklogCount: z.number().int().nonnegative().optional(),
  readinessStatus: z.enum(["not_started", "blocked", "at_risk", "ready_for_pilot", "ready_for_prod", "prod_ready", "waived"]).optional(),
  readinessGateFailures: z.array(z.string()).optional(),
  modelRiskApprovalStatus: z.enum(["not_started", "in_review", "approved", "rejected", "waived"]).optional(),
  runbookUrl: urlOrEmptySchema.optional(),
  solutionNextStep: z.string().optional(),
  lastEvalRun: z.string().optional(),
  valueDelivered: z.string().optional(),
  expansionOpportunity: z.string().optional(),
  expansionStage: z.enum(["none", "identified", "qualified", "proposal", "pilot_requested", "approved", "closed_won", "closed_lost"]).optional(),
  expansionPotentialAnnualValueUsd: z.number().nonnegative().optional(),
  expansionConfidencePct: percentSchema.optional(),
  solutionFdeOwner: z.string().email(),
  lastReviewedDate: z.string().optional(),
});

export const implementationSchema = z.object({
  rolloutId: z.string().optional(),
  launchScopeSolutionIds: z.array(z.string()).optional(),
  implementationStage: z.enum([
    "Kickoff",
    "Discovery",
    "Configuration",
    "Integration",
    "UAT",
    "Pilot",
    "Go-Live",
    "Stabilization",
    "Steady State",
    "On Hold",
  ]),
  implementationOwnerEmail: z.string().email().optional(),
  rolloutGovernanceStatus: z.enum(["Draft", "In Review", "Approved", "Changes Requested", "Waived"]).optional(),
  customerLaunchApproverEmail: z.string().email().optional(),
  providerLaunchApproverEmail: z.string().email().optional(),
  launchDecision: z.enum(["Pending", "Go", "No-Go", "Deferred"]).optional(),
  launchDecisionDate: z.string().optional(),
  implementationProgressPct: percentSchema,
  implementationRiskLevel: z.enum(["Green", "Yellow", "Red"]),
  dataReadinessPct: percentSchema.optional(),
  integrationReadinessPct: percentSchema.optional(),
  dataSourceInventoryStatus: z.enum(["Not Started", "In Progress", "Complete", "Blocked", "Waived"]).optional(),
  dataAccessStatus: z.enum(["Not Requested", "Requested", "Granted", "Blocked", "Revoked"]).optional(),
  dataQualityStatus: z.enum(["Not Assessed", "Issues Found", "Passed", "Failed", "Waived"]).optional(),
  connectorProvisioningStatus: z.enum(["Not Started", "In Progress", "Connected", "Failing", "Blocked", "Waived"]).optional(),
  integrationTestStatus: z.enum(["Not Started", "In Progress", "Passed", "Failed", "Waived"]).optional(),
  securityReviewStatus: z.enum(["Not Started", "In Review", "Approved", "Rejected", "Waived"]).optional(),
  privacyReviewStatus: z.enum(["Not Started", "In Review", "Approved", "Rejected", "Waived"]).optional(),
  evalAcceptanceStatus: z.enum(["Not Started", "In Review", "Accepted", "Rejected", "Waived"]).optional(),
  acceptanceEvidenceLink: urlOrEmptySchema.optional(),
  uatStatus: z.enum(["Not Started", "In Progress", "Passed", "Failed", "Waived"]).optional(),
  trainingStatus: z.enum(["Not Started", "Scheduled", "In Progress", "Complete"]).optional(),
  launchCriteria: z.string().optional(),
  launchCriteriaStatus: z.enum(["Not Defined", "Defined", "In Review", "Met", "Failed", "Waived"]).optional(),
  goLiveConfidencePct: percentSchema.optional(),
  targetGoLiveDate: z.string().optional(),
  actualGoLiveDate: z.string().optional(),
  launchWindowStartAt: z.string().optional(),
  launchWindowEndAt: z.string().optional(),
  runbookStatus: z.enum(["Not Started", "Draft", "In Review", "Approved", "Not Required"]).optional(),
  runbookLink: urlOrEmptySchema.optional(),
  supportHandoffStatus: z.enum(["Not Started", "Scheduled", "In Progress", "Complete", "Waived"]).optional(),
  supportOwnerEmail: z.string().email().optional(),
  supportChannelRef: z.string().optional(),
  billingReadinessStatus: z.enum(["Not Started", "In Review", "Ready", "Blocked", "Waived"]).optional(),
  entitlementProvisioningStatus: z.enum(["Not Started", "Provisioned", "Validated", "Blocked", "Waived"]).optional(),
  billingStartDate: z.string().optional(),
  currentMilestone: z.string().optional(),
  currentMilestoneDueDate: z.string().optional(),
  blocker: z.string().optional(),
  /**
   * Who owns the blocker. "Provider" is US — whoever runs this platform — as
   * opposed to the customer or a third party. It was literally "OnFinance",
   * which every other workspace on the platform also had to choose from.
   */
  blockerOwner: z.enum(["Provider", "Customer", "Third-Party Vendor", "None"]),
  blockerSeverity: z.enum(["None", "Low", "Medium", "High", "Critical"]).optional(),
  blockedSinceDate: z.string().optional(),
  riskMitigationPlan: z.string().optional(),
  criticalBlockerTicketIds: z.array(z.string()).optional(),
  openBlockerCount: z.number().int().nonnegative().optional(),
  implementationNextStep: z.string().optional(),
  implementationLastUpdatedAt: z.string().optional(),
});

export const ticketSchema = z.object({
  ticketId: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().optional(),
  affectedSchema: z.enum([
    "Customers",
    "Platform",
    "Deployments",
    "Solutions",
    "Implementation",
    "Tickets",
    "Interactions",
    "Internal Staff",
    "Customer Stakeholders",
    "Unknown",
  ]).optional(),
  affectedSolutionId: z.string().optional(),
  affectedDeploymentId: z.string().optional(),
  affectedEnvironment: z.string().optional(),
  affectedWorkflowId: z.string().optional(),
  affectedConnector: z.string().optional(),
  affectedModel: z.string().optional(),
  affectedDataSource: z.string().optional(),
  relatedTicketIds: z.array(z.string()).optional(),
  externalSystem: z.string().optional(),
  externalId: z.string().optional(),
  ticketType: z.enum([
    "Bug",
    "Config Change",
    "Feature Request",
    "Access Request",
    "Data Issue",
    "Migration",
    "Question",
    "Escalation",
  ]),
  // Canonical request classification. Every ticket is sorted into exactly one of
  // these five; it drives triage routing to the right FDE specialist.
  ticketCategory: ticketCategorySchema,
  ticketStatus: ticketStatusSchema,
  ticketPriority: z.enum(["P0-Critical", "P1-High", "P2-Medium", "P3-Low"]),
  severity: z.enum(["S0", "S1", "S2", "S3"]).optional(),
  supportQueue: z.string().optional(),
  ownerTeam: z.enum(["FDE", "Support", "Engineering", "Data", "Security", "Customer", "Vendor"]).optional(),
  reportedByEmail: z.string().email().optional(),
  customerContactEmail: z.string().email().optional(),
  ticketOpenedDate: z.string(),
  triagedAt: z.string().optional(),
  ticketDueDate: z.string().optional(),
  slaDueAt: z.string().optional(),
  firstResponseDueAt: z.string().optional(),
  firstRespondedAt: z.string().optional(),
  resolutionDueAt: z.string().optional(),
  slaStatus: z.enum(["not_applicable", "on_track", "at_risk", "breached", "paused", "met"]).optional(),
  escalated: z.boolean().optional(),
  escalatedAt: z.string().optional(),
  escalationLevel: z.enum(["L1", "L2", "L3", "Executive"]).optional(),
  escalationReason: z.string().optional(),
  ticketOwnerEmail: z.string().email(),
  sourceChannel: z.enum(["Email", "Slack", "Call", "Meeting", "In-App", "Zendesk"]),
  lastActivityDate: z.string(),
  sourceLink: z.string().optional(),
  escalationOwnerEmail: z.string().email().or(z.literal("")).optional(),
  productionImpact: z.boolean().optional(),
  customerImpactLevel: z.enum(["none", "low", "medium", "high", "critical"]).optional(),
  customerImpactSummary: z.string().optional(),
  affectedUserCount: z.number().int().nonnegative().optional(),
  issueDomain: z.enum([
    "support",
    "product",
    "model",
    "data",
    "integration",
    "deployment",
    "security",
    "implementation",
    "customer_action",
    "vendor",
    "unknown",
  ]).optional(),
  modelIssueType: z.string().optional(),
  dataIssueType: z.string().optional(),
  integrationIssueType: z.string().optional(),
  rootCauseStatus: z.enum(["not_started", "investigating", "identified", "fixed", "wont_fix", "unknown"]).optional(),
  rootCauseCategory: z.enum(["model", "data", "integration", "deployment", "configuration", "security", "customer_action", "vendor", "unknown"]).optional(),
  rootCauseSummary: z.string().optional(),
  detectedAt: z.string().optional(),
  mitigatedAt: z.string().optional(),
  remediationSummary: z.string().optional(),
  preventiveActions: z.string().optional(),
  postmortemRequired: z.boolean().optional(),
  postmortemStatus: z.enum(["not_required", "pending", "drafting", "published", "waived"]).optional(),
  postmortemOwnerEmail: z.string().email().optional(),
  postmortemDueDate: z.string().optional(),
  postmortemUrl: urlOrEmptySchema.optional(),
  tags: z.array(z.string()).optional(),
  resolutionSummary: z.string().optional(),
  resolvedAt: z.string().optional(),
  ticketNextStep: z.string().min(1),
});

export const interactionSchema = z.object({
  interactionId: z.string().min(1),
  interactionAt: z.string(),
  interactionType: z.enum(["meeting", "email", "call", "slack", "note", "qbr", "support_review", "implementation_checkin"]),
  sourceSystem: z.enum(["granola", "gmail", "slack", "salesforce", "zendesk", "manual", "other"]),
  sourceId: z.string().optional(),
  sourceLink: urlOrEmptySchema.optional(),
  summary: z.string().optional(),
  note: z.string(),
  outcome: z.string().optional(),
  participantEmails: z.array(z.string().email()).optional(),
  relatedTicketIds: z.array(z.string()).optional(),
  relatedSolutionIds: z.array(z.string()).optional(),
  relatedDeploymentIds: z.array(z.string()).optional(),
  nextAction: z.string().optional(),
  nextActionOwnerEmail: z.string().email().optional(),
  nextActionDueDate: z.string().optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed", "unknown"]).optional(),
  sensitivity: z.enum(["internal", "customer_shareable", "restricted"]).optional(),
  recordedByEmail: z.string().email().optional(),
  recordedAt: z.string().optional(),
});

export const customerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tier: z.string().optional(),
  lifecycleStage: z
    .enum(["Prospect", "Contracting", "Onboarding", "Pilot", "Live", "Expansion", "Renewal Risk", "Churned"])
    .optional(),
  // "In Progress" (54 accounts) and "Live" (2) are the fleet's real vocabulary —
  // the enum was narrower than the data, which is what broke get_customer reads
  // before the read-tolerance layer. "Needs Attention" is the triage state the
  // sweeps/standup flag accounts into before they harden to At Risk/Escalated.
  status: z
    .enum([
      "On Track",
      "In Progress",
      "Live",
      "Needs Attention",
      "At Risk",
      "Blocked",
      "Escalated",
      "Paused",
    ])
    .optional(),
  healthScore: z.number().min(0).max(100).optional(),
  fdeOwner: z.string().email().optional(),
  aeOwner: z.string().email().optional(),
  arr: z.number().nonnegative().optional(),
  arrCurrency: z.enum(["USD", "EUR", "GBP", "INR"]).optional(),
  seats: z.number().int().nonnegative().optional(),
  externalAccountId: z.string().optional(),
  legalEntityName: z.string().optional(),
  accountRegion: z.enum(["NA", "EMEA", "APAC", "LATAM", "Global"]).optional(),
  contractStatus: z.enum(["Draft", "Active", "Renewal Pending", "Expired", "Terminated"]).optional(),
  renewalForecast: z.enum(["Commit", "Likely", "At Risk", "Churn Likely", "Churned"]).optional(),
  renewalRiskReason: z.string().optional(),
  expansionPotentialArr: z.number().nonnegative().optional(),
  healthReason: z.string().optional(),
  companyDomain: z.string().optional(),
  vertical: z.string().optional(),
  regulatoryProfile: z.string().optional(),
  businessOwnerEmail: z.string().email().optional(),
  technicalOwnerEmail: z.string().email().optional(),
  executiveSponsorEmail: z.string().email().optional(),
  valueRealizationStage: z.enum(["Discovery", "Baseline", "Pilot Value", "Scaled Value", "Renewal Proof"]).optional(),
  targetAnnualValue: z.number().nonnegative().optional(),
  realizedAnnualValue: z.number().nonnegative().optional(),
  successCriteria: z.string().optional(),
  valuePeriodStart: z.string().optional(),
  valuePeriodEnd: z.string().optional(),
  valueEvidenceStatus: z.enum(["Not Started", "Estimated", "FDE Verified", "Customer Verified"]).optional(),
  valueEvidenceUrl: urlOrEmptySchema.optional(),
  lastBusinessReviewDate: z.string().optional(),
  nextBusinessReviewDate: z.string().optional(),
  contractStart: z.string().optional(),
  renewalDate: z.string().optional(),
  industrySegment: z.string().optional(),
  platform: platformSchema.optional(),
  deployments: z.array(deploymentSchema).optional(),
  solutions: z.array(solutionSchema).optional(),
  implementation: implementationSchema.optional(),
  tickets: z.array(ticketSchema).optional(),
  interactions: z.array(interactionSchema).optional(),
});

/* -------------------------------------------------------------------------- */
/* READ-side tolerance                                                        */
/*                                                                            */
/* Rows already in the database can carry string values outside today's       */
/* contract (data-quality drift, e.g. customers.status = "In Progress", or    */
/* fde_owner holding a person's name instead of an email). Throwing on READ   */
/* makes those records unreachable — get_customer errors on every call — so   */
/* the read path parses with a variant where every z.enum and every           */
/* constrained z.string (email/url/min-length/regex) falls back to carrying   */
/* the raw string (`.or(z.string())`). WRITE paths (upsertCustomer /          */
/* writeCustomerToPostgres / recordInteraction) keep parsing the strict       */
/* schemas above, so invalid values can be read out but never written in.     */
/* The variant is cast back to the source schema's type so the exported       */
/* entity types (Customer, Ticket, ...) are unchanged.                        */
/* -------------------------------------------------------------------------- */

function withReadTolerantStrings<T extends z.ZodType>(schema: T): T {
  const rebuild = (s: z.ZodType): z.ZodType => {
    // zod v4 internals: every schema exposes its definition on `.def`.
    const def = (s as unknown as { def?: { type?: string } & Record<string, unknown> }).def;
    switch (def?.type) {
      case "enum":
        return s.or(z.string());
      case "string": {
        // A checked string (email/url/min/regex): fall back to the raw string.
        const checks = def.checks as unknown[] | undefined;
        return (checks?.length ?? 0) > 0 || def.format != null ? s.or(z.string()) : s;
      }
      case "optional": {
        const innerType = def.innerType as z.ZodType;
        const inner = rebuild(innerType);
        return inner === innerType ? s : inner.optional();
      }
      case "nullable": {
        const innerType = def.innerType as z.ZodType;
        const inner = rebuild(innerType);
        return inner === innerType ? s : inner.nullable();
      }
      case "object": {
        const shape: Record<string, z.ZodType> = {};
        let changed = false;
        for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) {
          const next = rebuild(value);
          if (next !== value) changed = true;
          shape[key] = next;
        }
        return changed ? z.object(shape) : s;
      }
      case "array": {
        const elementType = def.element as z.ZodType;
        const element = rebuild(elementType);
        return element === elementType ? s : z.array(element);
      }
      case "union": {
        const optionTypes = def.options as z.ZodType[];
        const options = optionTypes.map(rebuild);
        return options.every((o, i) => o === optionTypes[i])
          ? s
          : z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
      }
      default:
        return s;
    }
  };
  return rebuild(schema) as T;
}

/** Read-path variant of {@link customerSchema}: out-of-contract strings pass through. */
export const customerReadSchema = withReadTolerantStrings(customerSchema);
/** Read-path variant of {@link ticketSchema}: out-of-contract strings pass through. */
export const ticketReadSchema = withReadTolerantStrings(ticketSchema);

export const customerStoreSchema = z.object({
  customers: z.array(customerSchema),
});

export const customerPatchSchema = customerSchema.partial().extend({
  id: z.string().min(1),
});

export const internalStaffAssignmentSchema = z.object({
  customer_id: z.string().min(1),
  staffRole: z.enum(["solution_engineer", "account_executive"]),
  name: z.string().min(1),
  title: z.string().optional(),
  employerOrg: z.string().min(1),
  email: z.string().email(),
  lastContact: z.string().optional(),
});

export const customerStakeholderSchema = z.object({
  customer_id: z.string().min(1),
  stakeholderRole: z.enum(["key_user", "decision_maker", "champion"]),
  name: z.string().min(1),
  title: z.string().optional(),
  employerOrg: z.string().min(1),
  email: z.string().email(),
  lastContact: z.string().optional(),
});

export const peopleStoreSchema = z.object({
  internalStaffAssignments: z.array(internalStaffAssignmentSchema),
  customerStakeholders: z.array(customerStakeholderSchema),
});

export type Customer = z.infer<typeof customerSchema>;
export type CustomerPatch = z.infer<typeof customerPatchSchema>;
export type CustomerStore = z.infer<typeof customerStoreSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type Implementation = z.infer<typeof implementationSchema>;
export type Interaction = z.infer<typeof interactionSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type Solution = z.infer<typeof solutionSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
