"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  Building2,
  ChevronRightIcon,
  FileAudioIcon,
  FileCode2Icon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  FolderTreeIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PuzzleIcon,
  Rocket,
  SearchIcon,
  ServerIcon,
  TicketIcon,
  UploadIcon,
  Users,
  WrenchIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PdfView } from "./pdf-view";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { jsonForPeople } from "@/lib/ui-keys";
import { W, an } from "@/lib/ui-words";
import { listedOwnFields, orderPhrase, sameKey, sheetColumnKey, workbookHidden, type WorkbookTable, type WorkbookTableInfo } from "@/lib/workbook-fields";
import type { CustomFieldSpec } from "@/lib/deployment-profile.generated";
import { domainView } from "@/lib/profile-domains";

interface Ticket {
  ticketId: string;
  summary?: string;
  description?: string;
  affectedSchema?: string;
  affectedSolutionId?: string;
  affectedDeploymentId?: string;
  affectedEnvironment?: string;
  affectedWorkflowId?: string;
  affectedConnector?: string;
  affectedModel?: string;
  affectedDataSource?: string;
  relatedTicketIds?: string[];
  externalSystem?: string;
  externalId?: string;
  ticketType?: string;
  ticketCategory?: string;
  ticketStatus?: string;
  ticketPriority?: string;
  severity?: string;
  supportQueue?: string;
  ownerTeam?: string;
  reportedByEmail?: string;
  customerContactEmail?: string;
  ticketOpenedDate?: string;
  triagedAt?: string;
  ticketDueDate?: string;
  slaDueAt?: string;
  firstResponseDueAt?: string;
  firstRespondedAt?: string;
  resolutionDueAt?: string;
  slaStatus?: string;
  escalated?: boolean;
  escalatedAt?: string;
  escalationLevel?: string;
  escalationReason?: string;
  ticketOwnerEmail?: string;
  sourceChannel?: string;
  lastActivityDate?: string;
  sourceLink?: string;
  escalationOwnerEmail?: string;
  productionImpact?: boolean;
  customerImpactLevel?: string;
  customerImpactSummary?: string;
  affectedUserCount?: number;
  issueDomain?: string;
  modelIssueType?: string;
  dataIssueType?: string;
  integrationIssueType?: string;
  rootCauseStatus?: string;
  rootCauseCategory?: string;
  rootCauseSummary?: string;
  detectedAt?: string;
  mitigatedAt?: string;
  remediationSummary?: string;
  preventiveActions?: string;
  postmortemRequired?: boolean;
  postmortemStatus?: string;
  postmortemOwnerEmail?: string;
  postmortemDueDate?: string;
  postmortemUrl?: string;
  tags?: string[];
  resolutionSummary?: string;
  resolvedAt?: string;
  ticketNextStep?: string;
}
interface Interaction {
  interactionId?: string;
  interactionAt?: string;
  interactionType?: string;
  sourceSystem?: string;
  sourceId?: string;
  sourceLink?: string;
  summary?: string;
  note?: string;
  outcome?: string;
  participantEmails?: string[];
  relatedTicketIds?: string[];
  relatedSolutionIds?: string[];
  relatedDeploymentIds?: string[];
  nextAction?: string;
  nextActionOwnerEmail?: string;
  nextActionDueDate?: string;
  sentiment?: string;
  sensitivity?: string;
  recordedByEmail?: string;
  recordedAt?: string;
}
interface Platform {
  tenantId?: string;
  platformConfigStatus?: string;
  deploymentModel?: string;
  dataResidencyConstraint?: string;
  authMode?: string;
  dataClassification?: string;
  piiHandling?: string;
  auditLoggingEnabled?: boolean;
  retentionDays?: number;
  aiGovernanceStatus?: string;
  modelPolicyId?: string;
  allowedModelProviders?: string[];
  modelDataUsePolicy?: string;
  inferenceRegion?: string;
  crossBorderProcessingAllowed?: boolean;
  guardrailPolicy?: string;
  guardrailPolicyVersion?: string;
  guardrailEnforcementMode?: string;
  promptLoggingMode?: string;
  customerManagedKeyEnabled?: boolean;
  kmsKeyRef?: string;
  scimProvisioningEnabled?: boolean;
  rbacPolicy?: string;
  auditLogSink?: string;
  observabilityEnabled?: boolean;
  primaryModel?: string;
  fallbackModel?: string;
  minimumEvalScorePct?: number;
  lastGovernanceReviewAt?: string;
  monthlySpendLimitUsd?: number;
  enabledConnectors?: string[];
  featureFlags?: string[];
  primaryUseCase?: string;
  lastHealthCheckAt?: string;
}
interface Deployment {
  /** The profile's own fields this area lists (show_in_list), as the workbook route sends them. */
  custom?: Record<string, unknown>;
  deploymentId?: string;
  environment?: string;
  region?: string;
  cloudProvider?: string;
  runtime?: string;
  deploymentStrategy?: string;
  deployedVersion?: string;
  releaseId?: string;
  releaseChannel?: string;
  buildSha?: string;
  runtimeVersion?: string;
  configVersion?: string;
  approvedByEmail?: string;
  approvedAt?: string;
  modelRouteId?: string;
  modelRoutingMode?: string;
  primaryModelRef?: string;
  primaryModelVersion?: string;
  fallbackModelRef?: string;
  fallbackModelVersion?: string;
  modelTrafficPrimaryPct?: number;
  lastDeployAt?: string;
  releaseStatus?: string;
  rollbackVersion?: string;
  rollbackStatus?: string;
  rollbackTestedAt?: string;
  healthStatus?: string;
  uptime30dPct?: number;
  errorRate30dPct?: number;
  latencyP95Ms?: number;
  latencySloMs?: number;
  requestCount30d?: number;
  llmRequestCount30d?: number;
  inputTokens30d?: number;
  outputTokens30d?: number;
  cacheHitRate30dPct?: number;
  guardrailBlockRate30dPct?: number;
  cost30dUsd?: number;
  costBudget30dUsd?: number;
  projectedCost30dUsd?: number;
  capacityLimitRpm?: number;
  peakRpm30d?: number;
  utilization30dPct?: number;
  liveUrl?: string;
  deployOwnerEmail?: string;
  lastIncidentRef?: string;
  activeIncidentRefs?: string[];
  incidentCount30d?: number;
  dashboardUrl?: string;
  runbookUrl?: string;
  lastTelemetryAt?: string;
  notes?: string;
}
interface Solution {
  solutionId?: string;
  useCase?: string;
  workflowId?: string;
  workflowName?: string;
  businessProcess?: string;
  businessUnit?: string;
  primaryUserRole?: string;
  workflowOwnerEmail?: string;
  riskOwnerEmail?: string;
  workflowFrequency?: string;
  decisionImpact?: string;
  upstreamSystems?: string[];
  downstreamSystems?: string[];
  outputArtifacts?: string[];
  sensitiveDataTypes?: string[];
  valueMetric?: string;
  valueMetricUnit?: string;
  valueMetricDirection?: string;
  measurementSource?: string;
  measurementWindowDays?: number;
  baselineMetricValue?: number;
  currentMetricValue?: number;
  targetMetricValue?: number;
  baselinePeriodStart?: string;
  baselinePeriodEnd?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  targetDate?: string;
  valueEvidenceUrl?: string;
  annualizedValueRealizedUsd?: number;
  valueRealizationConfidencePct?: number;
  solutionValueRealizationStage?: string;
  modulesEnabled?: string[];
  solutionStatus?: string;
  solutionGoLiveDate?: string;
  weeklyActiveUsers?: number;
  weeklyQueryVolume?: number;
  automationRatePct?: number;
  humanReviewRatePct?: number;
  productionReadinessScore?: number;
  solutionEvalScorePct?: number;
  evalStatus?: string;
  evalSuiteId?: string;
  evalDatasetVersion?: string;
  lastEvalRunId?: string;
  lastEvalRunAt?: string;
  evalPassRatePct?: number;
  evalCoveragePct?: number;
  taskSuccessRatePct?: number;
  answerAcceptanceRatePct?: number;
  groundednessScorePct?: number;
  citationCoveragePct?: number;
  hallucinationRatePct?: number;
  policyViolationRatePct?: number;
  guardrailInterventionRatePct?: number;
  customerReportedDefects30d?: number;
  safetyIncidentCount30d?: number;
  humanReviewPolicy?: string;
  reviewSlaHours?: number;
  reviewSlaAttainmentPct?: number;
  reviewBacklogCount?: number;
  readinessStatus?: string;
  readinessGateFailures?: string[];
  modelRiskApprovalStatus?: string;
  runbookUrl?: string;
  solutionNextStep?: string;
  lastEvalRun?: string;
  valueDelivered?: string;
  expansionOpportunity?: string;
  expansionStage?: string;
  expansionPotentialAnnualValueUsd?: number;
  expansionConfidencePct?: number;
  solutionFdeOwner?: string;
  lastReviewedDate?: string;
}
interface Implementation {
  custom?: Record<string, unknown>;
  rolloutId?: string;
  launchScopeSolutionIds?: string[];
  implementationStage?: string;
  implementationOwnerEmail?: string;
  rolloutGovernanceStatus?: string;
  customerLaunchApproverEmail?: string;
  providerLaunchApproverEmail?: string;
  launchDecision?: string;
  launchDecisionDate?: string;
  implementationProgressPct?: number;
  implementationRiskLevel?: string;
  dataReadinessPct?: number;
  integrationReadinessPct?: number;
  dataSourceInventoryStatus?: string;
  dataAccessStatus?: string;
  dataQualityStatus?: string;
  connectorProvisioningStatus?: string;
  integrationTestStatus?: string;
  securityReviewStatus?: string;
  privacyReviewStatus?: string;
  evalAcceptanceStatus?: string;
  acceptanceEvidenceLink?: string;
  uatStatus?: string;
  trainingStatus?: string;
  launchCriteria?: string;
  launchCriteriaStatus?: string;
  goLiveConfidencePct?: number;
  targetGoLiveDate?: string;
  actualGoLiveDate?: string;
  launchWindowStartAt?: string;
  launchWindowEndAt?: string;
  runbookStatus?: string;
  runbookLink?: string;
  supportHandoffStatus?: string;
  supportOwnerEmail?: string;
  supportChannelRef?: string;
  billingReadinessStatus?: string;
  entitlementProvisioningStatus?: string;
  billingStartDate?: string;
  currentMilestone?: string;
  currentMilestoneDueDate?: string;
  blocker?: string;
  blockerOwner?: string;
  blockerSeverity?: string;
  blockedSinceDate?: string;
  riskMitigationPlan?: string;
  criticalBlockerTicketIds?: string[];
  openBlockerCount?: number;
  implementationNextStep?: string;
  implementationLastUpdatedAt?: string;
}
interface Customer {
  custom?: Record<string, unknown>;
  id: string;
  name?: string;
  tier?: string;
  lifecycleStage?: string;
  status?: string;
  healthScore?: number;
  fdeOwner?: string;
  aeOwner?: string;
  arr?: number;
  arrCurrency?: string;
  seats?: number;
  externalAccountId?: string;
  legalEntityName?: string;
  accountRegion?: string;
  contractStatus?: string;
  renewalForecast?: string;
  renewalRiskReason?: string;
  expansionPotentialArr?: number;
  healthReason?: string;
  companyDomain?: string;
  vertical?: string;
  regulatoryProfile?: string;
  businessOwnerEmail?: string;
  technicalOwnerEmail?: string;
  executiveSponsorEmail?: string;
  valueRealizationStage?: string;
  targetAnnualValue?: number;
  realizedAnnualValue?: number;
  successCriteria?: string;
  valuePeriodStart?: string;
  valuePeriodEnd?: string;
  valueEvidenceStatus?: string;
  valueEvidenceUrl?: string;
  lastBusinessReviewDate?: string;
  nextBusinessReviewDate?: string;
  contractStart?: string;
  renewalDate?: string;
  industrySegment?: string;
  platform?: Platform;
  deployments?: Deployment[];
  solutions?: Solution[];
  implementation?: Implementation;
  tickets?: Ticket[];
  interactions?: Interaction[];
}

export type BadgeTone = "high" | "medium" | "low" | "muted";
export interface DataItem {
  customer: string; // header, shown with a logo
  summary: string; // 1–2 line description
  action: string; // the concrete next step the click will kick off
  badge?: string;
  badgeTone?: BadgeTone;
  badgeClass?: string; // explicit color classes (overrides badgeTone), e.g. ticket category
  meta?: string; // small muted footnote under the badge (e.g. "22d old")
  spoc?: { name: string; role?: string; org?: string; email?: string }; // single point of contact
  prompt: string;
}

interface InternalStaffAssignment {
  customer_id?: string;
  staffRole: string;
  name: string;
  title?: string;
  employerOrg?: string;
  email?: string;
  lastContact?: string;
}
interface CustomerStakeholder {
  customer_id?: string;
  stakeholderRole: string;
  name: string;
  title?: string;
  employerOrg?: string;
  email?: string;
  lastContact?: string;
}

/**
 * THE WORKSPACE'S OWN RECORDS, as GET /api/ops/workbook answers them: every Master.xlsx preview is built from this.
 *
 * They used to be built at module scope from the bundled data/customers.json and data/people.json, so every
 * workspace showed the same two invented accounts, and a People sheet with a real person's email on them, whatever
 * it actually held (factory task mold_v1-120). Nothing in the client imports a record any more; a workspace with
 * none sees the empty state. `npm run check:no-sample-data` holds both, in the built bundle and on the page.
 */
export interface WorkbookData {
  customers: Customer[];
  people: { internalStaffAssignments: InternalStaffAssignment[]; customerStakeholders: CustomerStakeholder[] };
  /** Per table: how many rows came, and whether the route's cap cut it. */
  tables: Partial<Record<WorkbookTable, WorkbookTableInfo>>;
  /** Tables that could not be read. Their sheets say so; they are never shown as empty. */
  unavailable: WorkbookTable[];
}
/** An answer from the workbook API, read defensively: anything missing is an empty list, never an invented row. */
function asWorkbook(data: unknown): WorkbookData {
  const d = (data ?? {}) as {
    customers?: unknown;
    people?: { internalStaffAssignments?: unknown; customerStakeholders?: unknown };
    tables?: unknown;
    unavailable?: unknown;
  };
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    customers: list<Customer>(d.customers).filter((c) => c && typeof c.id === "string"),
    people: {
      internalStaffAssignments: list<InternalStaffAssignment>(d.people?.internalStaffAssignments),
      customerStakeholders: list<CustomerStakeholder>(d.people?.customerStakeholders),
    },
    tables: d.tables && typeof d.tables === "object" ? (d.tables as WorkbookData["tables"]) : {},
    unavailable: list<WorkbookTable>(d.unavailable),
  };
}
type WorkbookState = { status: "loading" } | { status: "ready"; data: WorkbookData } | { status: "error"; message: string };

/** A compact "what's happening" summary for the customer-context picker. */
export interface CustomerContextSummary {
  tier?: string;
  lifecycleStage?: string;
  status?: string;
  healthScore?: number;
  // WHY the status is what it is — the only part of "health" that says
  // something the status word doesn't.
  healthReason?: string;
  fdeOwner?: string;
  lead?: { name: string; role?: string };
  openTickets: number;
  lastTouchDate?: string;
  lastTouch?: string;
}

/**
 * Ticket-category colours come from the category text itself: a stable hash picks one of a
 * fixed palette, so any category — including ones a workspace defines later — gets a
 * consistent colour without a table to maintain. Every class string is written out in full so
 * Tailwind compiles it; each pair reads at 4.5:1 or better on the /15 tint in both themes.
 */
const CATEGORY_PALETTE = [
  "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  "bg-red-500/15 text-red-700 dark:text-red-400",
  "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
] as const;
function hashLabel(label: string): number {
  // FNV-1a over the normalised label: case and surrounding space do not change the colour.
  let h = 0x811c9dc5;
  for (const ch of label.trim().toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
export function ticketCategoryTone(category: string): string {
  return CATEGORY_PALETTE[hashLabel(category) % CATEGORY_PALETTE.length];
}
export type DataroomTab =
  | "customers"
  | "platform"
  | "deployments"
  | "solutions"
  | "implementation"
  | "tickets"
  | "people"
  | "interactions"
  | "internal-staff"
  | "customer-stakeholders";

/**
 * What the deployment profile says about one data-room domain. `domain` is the REAL domain name (the folder,
 * the Master.xlsx, the sheet): a profile only changes the label people read and whether the domain is shown.
 */
function domainDisplay(domain: string): { label: string; visible: boolean; description?: string } {
  const entry = DEPLOYMENT_PROFILE.dataroom.domains[domain];
  return { label: entry?.label || domain, visible: entry?.visible !== false, description: entry?.description };
}

/**
 * A sheet's tab, as a person reads it. The sheet NAME inside the workbook never changes ("Deployments",
 * "Implementation": the agent reads sheets by name); a deployment that renames the area sees its plural.
 */
const SHEET_AREA: Record<string, "deployments" | "implementations"> = { Deployments: "deployments", Implementation: "implementations" };
function sheetTitle(name: string): string {
  const area = SHEET_AREA[name];
  if (area) return domainView(area).name(name);
  // The account's own sheet reads as its domain's label ("Companies"). The stakeholders sheet is NAMED in the
  // profile's word already (SECTION_SHEET).
  if (name === SECTION_SHEET.customers) return domainDisplay(name).label;
  return name;
}

const ALL_DATAROOM_SECTIONS: { key: DataroomTab; domain: string; icon: typeof Users }[] = [
  { key: "customers", domain: "Customers", icon: Building2 },
  { key: "platform", domain: "Platform", icon: ServerIcon },
  { key: "deployments", domain: "Deployments", icon: Rocket },
  { key: "solutions", domain: "Solutions", icon: PuzzleIcon },
  { key: "implementation", domain: "Implementation", icon: WrenchIcon },
  { key: "tickets", domain: "Tickets", icon: TicketIcon },
  { key: "people", domain: "People", icon: Users },
];

/** The domains this deployment shows, labelled the way it names them. Hidden domains are absent. */
export const DATAROOM_SECTIONS: { key: DataroomTab; label: string; description?: string; icon: typeof Users }[] =
  ALL_DATAROOM_SECTIONS.filter((s) => domainDisplay(s.domain).visible).map(({ key, domain, icon }) => {
    const { label, description } = domainDisplay(domain);
    return { key, label, description, icon };
  });

interface Sheet {
  name: string;
  /** The stored column names (spoken through the profile's words when shown). */
  head: string[];
  /** The profile's own listed fields, shown after `head` in the profile's labels as they are. */
  own?: string[];
  rows: (React.ReactNode | string | undefined)[][];
}

function joinList(values?: string[]): string | undefined {
  return values?.length ? values.join(", ") : undefined;
}

function formatPercent(value?: number): string | undefined {
  if (value == null) return undefined;
  // A stored value that is not a number is shown as it is, never allowed to take the whole data room down.
  return typeof value === "number" ? `${value.toFixed(2)}%` : String(value);
}

const SECTION_SHEET: Record<DataroomTab, string> = {
  customers: "Customers",
  platform: "Platform",
  deployments: "Deployments",
  solutions: "Solutions",
  implementation: "Implementation",
  tickets: "Tickets",
  people: "Internal Staff",
  interactions: "Interactions",
  "internal-staff": "Internal Staff",
  "customer-stakeholders": `${W.Account} Stakeholders`,
};

/** One workbook, one sheet per canonical schema in fixed data-model order, from the workspace's own records. */
function buildWorkbook(data: WorkbookData): Sheet[] {
  const customers = data.customers;
  const peopleSeed = data.people;
  const tickets = customers.flatMap((c) =>
    (c.tickets ?? []).map((ticket) => ({ customerId: c.id, customer: c.name ?? c.id, ...ticket })),
  );
  const interactions = customers.flatMap((c) =>
    (c.interactions ?? []).map((interaction) => ({ customerId: c.id, customer: c.name ?? c.id, ...interaction })),
  );
  return [
    {
      name: "Customers",
      head: [
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
      ],
      rows: customers.map((c) => [
        c.id,
        c.name,
        c.tier,
        c.lifecycleStage,
        c.status,
        c.healthScore != null ? String(c.healthScore) : undefined,
        c.fdeOwner,
        c.aeOwner,
        c.arr != null ? String(c.arr) : undefined,
        c.arrCurrency,
        c.seats != null ? String(c.seats) : undefined,
        c.externalAccountId,
        c.legalEntityName,
        c.accountRegion,
        c.contractStatus,
        c.renewalForecast,
        c.renewalRiskReason,
        c.expansionPotentialArr != null ? String(c.expansionPotentialArr) : undefined,
        c.healthReason,
        c.companyDomain,
        c.vertical,
        c.regulatoryProfile,
        c.businessOwnerEmail,
        c.technicalOwnerEmail,
        c.executiveSponsorEmail,
        c.valueRealizationStage,
        c.targetAnnualValue != null ? String(c.targetAnnualValue) : undefined,
        c.realizedAnnualValue != null ? String(c.realizedAnnualValue) : undefined,
        c.successCriteria,
        c.valuePeriodStart,
        c.valuePeriodEnd,
        c.valueEvidenceStatus,
        c.valueEvidenceUrl,
        c.lastBusinessReviewDate,
        c.nextBusinessReviewDate,
        c.contractStart,
        c.renewalDate,
        c.industrySegment,
      ]),
    },
    {
      name: "Platform",
      head: [
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
      ],
      rows: customers.map((c) => [
        c.id,
        c.platform?.tenantId,
        c.platform?.platformConfigStatus,
        c.platform?.deploymentModel,
        c.platform?.dataResidencyConstraint,
        c.platform?.authMode,
        c.platform?.dataClassification,
        c.platform?.piiHandling,
        c.platform?.auditLoggingEnabled != null ? String(c.platform.auditLoggingEnabled) : undefined,
        c.platform?.retentionDays != null ? String(c.platform.retentionDays) : undefined,
        c.platform?.aiGovernanceStatus,
        c.platform?.modelPolicyId,
        joinList(c.platform?.allowedModelProviders),
        c.platform?.modelDataUsePolicy,
        c.platform?.inferenceRegion,
        c.platform?.crossBorderProcessingAllowed != null ? String(c.platform.crossBorderProcessingAllowed) : undefined,
        c.platform?.guardrailPolicy,
        c.platform?.guardrailPolicyVersion,
        c.platform?.guardrailEnforcementMode,
        c.platform?.promptLoggingMode,
        c.platform?.customerManagedKeyEnabled != null ? String(c.platform.customerManagedKeyEnabled) : undefined,
        c.platform?.kmsKeyRef,
        c.platform?.scimProvisioningEnabled != null ? String(c.platform.scimProvisioningEnabled) : undefined,
        c.platform?.rbacPolicy,
        c.platform?.auditLogSink,
        c.platform?.observabilityEnabled != null ? String(c.platform.observabilityEnabled) : undefined,
        c.platform?.primaryModel,
        c.platform?.fallbackModel,
        formatPercent(c.platform?.minimumEvalScorePct),
        c.platform?.lastGovernanceReviewAt,
        c.platform?.monthlySpendLimitUsd != null ? String(c.platform.monthlySpendLimitUsd) : undefined,
        joinList(c.platform?.enabledConnectors),
        joinList(c.platform?.featureFlags),
        c.platform?.primaryUseCase,
        c.platform?.lastHealthCheckAt,
      ]),
    },
    {
      name: "Deployments",
      head: [
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
      ],
      rows: customers.flatMap((c) =>
        (c.deployments ?? []).map((d) => [
          c.id,
          d.deploymentId,
          d.environment,
          d.region,
          d.cloudProvider,
          d.runtime,
          d.deploymentStrategy,
          d.deployedVersion,
          d.releaseId,
          d.releaseChannel,
          d.buildSha,
          d.runtimeVersion,
          d.configVersion,
          d.approvedByEmail,
          d.approvedAt,
          d.modelRouteId,
          d.modelRoutingMode,
          d.primaryModelRef,
          d.primaryModelVersion,
          d.fallbackModelRef,
          d.fallbackModelVersion,
          formatPercent(d.modelTrafficPrimaryPct),
          d.lastDeployAt,
          d.releaseStatus,
          d.rollbackVersion,
          d.rollbackStatus,
          d.rollbackTestedAt,
          <Health key={`${c.id}:${d.environment}`} value={d.healthStatus} />,
          formatPercent(d.uptime30dPct),
          formatPercent(d.errorRate30dPct),
          d.latencyP95Ms != null ? String(d.latencyP95Ms) : undefined,
          d.latencySloMs != null ? String(d.latencySloMs) : undefined,
          d.requestCount30d != null ? String(d.requestCount30d) : undefined,
          d.llmRequestCount30d != null ? String(d.llmRequestCount30d) : undefined,
          d.inputTokens30d != null ? String(d.inputTokens30d) : undefined,
          d.outputTokens30d != null ? String(d.outputTokens30d) : undefined,
          formatPercent(d.cacheHitRate30dPct),
          formatPercent(d.guardrailBlockRate30dPct),
          d.cost30dUsd != null ? String(d.cost30dUsd) : undefined,
          d.costBudget30dUsd != null ? String(d.costBudget30dUsd) : undefined,
          d.projectedCost30dUsd != null ? String(d.projectedCost30dUsd) : undefined,
          d.capacityLimitRpm != null ? String(d.capacityLimitRpm) : undefined,
          d.peakRpm30d != null ? String(d.peakRpm30d) : undefined,
          formatPercent(d.utilization30dPct),
          d.liveUrl,
          d.deployOwnerEmail,
          d.lastIncidentRef,
          joinList(d.activeIncidentRefs),
          d.incidentCount30d != null ? String(d.incidentCount30d) : undefined,
          d.dashboardUrl,
          d.runbookUrl,
          d.lastTelemetryAt,
          d.notes,
        ]),
      ),
    },
    {
      name: "Solutions",
      head: [
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
      ],
      rows: customers.flatMap((c) =>
        (c.solutions ?? []).map((s) => [
          s.solutionId,
          c.id,
          s.useCase,
          s.workflowId,
          s.workflowName,
          s.businessProcess,
          s.businessUnit,
          s.primaryUserRole,
          s.workflowOwnerEmail,
          s.riskOwnerEmail,
          s.workflowFrequency,
          s.decisionImpact,
          joinList(s.upstreamSystems),
          joinList(s.downstreamSystems),
          joinList(s.outputArtifacts),
          joinList(s.sensitiveDataTypes),
          s.valueMetric,
          s.valueMetricUnit,
          s.valueMetricDirection,
          s.measurementSource,
          s.measurementWindowDays != null ? String(s.measurementWindowDays) : undefined,
          s.baselineMetricValue != null ? String(s.baselineMetricValue) : undefined,
          s.currentMetricValue != null ? String(s.currentMetricValue) : undefined,
          s.targetMetricValue != null ? String(s.targetMetricValue) : undefined,
          s.baselinePeriodStart,
          s.baselinePeriodEnd,
          s.currentPeriodStart,
          s.currentPeriodEnd,
          s.targetDate,
          s.valueEvidenceUrl,
          s.annualizedValueRealizedUsd != null ? String(s.annualizedValueRealizedUsd) : undefined,
          formatPercent(s.valueRealizationConfidencePct),
          s.solutionValueRealizationStage,
          joinList(s.modulesEnabled),
          s.solutionStatus,
          s.solutionGoLiveDate,
          s.weeklyActiveUsers != null ? String(s.weeklyActiveUsers) : undefined,
          s.weeklyQueryVolume != null ? String(s.weeklyQueryVolume) : undefined,
          formatPercent(s.automationRatePct),
          formatPercent(s.humanReviewRatePct),
          s.productionReadinessScore != null ? String(s.productionReadinessScore) : undefined,
          s.solutionEvalScorePct != null ? `${s.solutionEvalScorePct}%` : undefined,
          s.evalStatus,
          s.evalSuiteId,
          s.evalDatasetVersion,
          s.lastEvalRunId,
          s.lastEvalRunAt,
          formatPercent(s.evalPassRatePct),
          formatPercent(s.evalCoveragePct),
          formatPercent(s.taskSuccessRatePct),
          formatPercent(s.answerAcceptanceRatePct),
          formatPercent(s.groundednessScorePct),
          formatPercent(s.citationCoveragePct),
          formatPercent(s.hallucinationRatePct),
          formatPercent(s.policyViolationRatePct),
          formatPercent(s.guardrailInterventionRatePct),
          s.customerReportedDefects30d != null ? String(s.customerReportedDefects30d) : undefined,
          s.safetyIncidentCount30d != null ? String(s.safetyIncidentCount30d) : undefined,
          s.humanReviewPolicy,
          s.reviewSlaHours != null ? String(s.reviewSlaHours) : undefined,
          formatPercent(s.reviewSlaAttainmentPct),
          s.reviewBacklogCount != null ? String(s.reviewBacklogCount) : undefined,
          s.readinessStatus,
          joinList(s.readinessGateFailures),
          s.modelRiskApprovalStatus,
          s.runbookUrl,
          s.solutionNextStep,
          s.lastEvalRun,
          s.valueDelivered,
          s.expansionOpportunity,
          s.expansionStage,
          s.expansionPotentialAnnualValueUsd != null ? String(s.expansionPotentialAnnualValueUsd) : undefined,
          formatPercent(s.expansionConfidencePct),
          s.solutionFdeOwner,
          s.lastReviewedDate,
        ]),
      ),
    },
    {
      name: "Implementation",
      head: [
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
      ],
      rows: customers.map((c) => [
        c.id,
        c.implementation?.rolloutId,
        joinList(c.implementation?.launchScopeSolutionIds),
        c.implementation?.implementationStage,
        c.implementation?.implementationOwnerEmail,
        c.implementation?.rolloutGovernanceStatus,
        c.implementation?.customerLaunchApproverEmail,
        c.implementation?.providerLaunchApproverEmail,
        c.implementation?.launchDecision,
        c.implementation?.launchDecisionDate,
        c.implementation?.implementationProgressPct != null
          ? `${c.implementation.implementationProgressPct}%`
          : undefined,
        c.implementation?.implementationRiskLevel,
        formatPercent(c.implementation?.dataReadinessPct),
        formatPercent(c.implementation?.integrationReadinessPct),
        c.implementation?.dataSourceInventoryStatus,
        c.implementation?.dataAccessStatus,
        c.implementation?.dataQualityStatus,
        c.implementation?.connectorProvisioningStatus,
        c.implementation?.integrationTestStatus,
        c.implementation?.securityReviewStatus,
        c.implementation?.privacyReviewStatus,
        c.implementation?.evalAcceptanceStatus,
        c.implementation?.acceptanceEvidenceLink,
        c.implementation?.uatStatus,
        c.implementation?.trainingStatus,
        c.implementation?.launchCriteria,
        c.implementation?.launchCriteriaStatus,
        formatPercent(c.implementation?.goLiveConfidencePct),
        c.implementation?.targetGoLiveDate,
        c.implementation?.actualGoLiveDate,
        c.implementation?.launchWindowStartAt,
        c.implementation?.launchWindowEndAt,
        c.implementation?.runbookStatus,
        c.implementation?.runbookLink,
        c.implementation?.supportHandoffStatus,
        c.implementation?.supportOwnerEmail,
        c.implementation?.supportChannelRef,
        c.implementation?.billingReadinessStatus,
        c.implementation?.entitlementProvisioningStatus,
        c.implementation?.billingStartDate,
        c.implementation?.currentMilestone,
        c.implementation?.currentMilestoneDueDate,
        c.implementation?.blocker,
        c.implementation?.blockerOwner,
        c.implementation?.blockerSeverity,
        c.implementation?.blockedSinceDate,
        c.implementation?.riskMitigationPlan,
        joinList(c.implementation?.criticalBlockerTicketIds),
        c.implementation?.openBlockerCount != null ? String(c.implementation.openBlockerCount) : undefined,
        c.implementation?.implementationNextStep,
        c.implementation?.implementationLastUpdatedAt,
      ]),
    },
    {
      name: "Tickets",
      head: [
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
      ],
      rows: tickets.map((t) => [
        t.ticketId,
        t.customerId,
        t.summary,
        t.description,
        t.affectedSchema,
        t.affectedSolutionId,
        t.affectedDeploymentId,
        t.affectedEnvironment,
        t.affectedWorkflowId,
        t.affectedConnector,
        t.affectedModel,
        t.affectedDataSource,
        joinList(t.relatedTicketIds),
        t.externalSystem,
        t.externalId,
        t.ticketType,
        <TicketCategory key={`${t.ticketId}:cat`} value={t.ticketCategory} />,
        t.ticketStatus,
        t.ticketPriority,
        t.severity,
        t.supportQueue,
        t.ownerTeam,
        t.reportedByEmail,
        t.customerContactEmail,
        t.ticketOpenedDate,
        t.triagedAt,
        t.ticketDueDate,
        t.slaDueAt,
        t.firstResponseDueAt,
        t.firstRespondedAt,
        t.resolutionDueAt,
        t.slaStatus,
        t.escalated != null ? String(t.escalated) : undefined,
        t.escalatedAt,
        t.escalationLevel,
        t.escalationReason,
        t.ticketOwnerEmail,
        t.sourceChannel,
        t.lastActivityDate,
        t.sourceLink,
        t.escalationOwnerEmail,
        t.productionImpact != null ? String(t.productionImpact) : undefined,
        t.customerImpactLevel,
        t.customerImpactSummary,
        t.affectedUserCount != null ? String(t.affectedUserCount) : undefined,
        t.issueDomain,
        t.modelIssueType,
        t.dataIssueType,
        t.integrationIssueType,
        t.rootCauseStatus,
        t.rootCauseCategory,
        t.rootCauseSummary,
        t.detectedAt,
        t.mitigatedAt,
        t.remediationSummary,
        t.preventiveActions,
        t.postmortemRequired != null ? String(t.postmortemRequired) : undefined,
        t.postmortemStatus,
        t.postmortemOwnerEmail,
        t.postmortemDueDate,
        t.postmortemUrl,
        joinList(t.tags),
        t.resolutionSummary,
        t.resolvedAt,
        t.ticketNextStep,
      ]),
    },
    {
      name: "Interactions",
      head: [
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
      ],
      rows: interactions.map((i) => [
        i.interactionId,
        i.customerId,
        i.interactionAt,
        i.interactionType,
        i.sourceSystem,
        i.sourceId,
        i.sourceLink,
        i.summary,
        i.note,
        i.outcome,
        joinList(i.participantEmails),
        joinList(i.relatedTicketIds),
        joinList(i.relatedSolutionIds),
        joinList(i.relatedDeploymentIds),
        i.nextAction,
        i.nextActionOwnerEmail,
        i.nextActionDueDate,
        i.sentiment,
        i.sensitivity,
        i.recordedByEmail,
        i.recordedAt,
      ]),
    },
    {
      name: "Internal Staff",
      head: [
        "customer_id",
        "staff_role",
        "name",
        "title",
        "employer_org",
        "email",
        "last_contact",
      ],
      rows: (peopleSeed.internalStaffAssignments ?? []).map((p) => [
        p.customer_id,
        p.staffRole,
        p.name,
        p.title,
        p.employerOrg,
        p.email,
        p.lastContact,
      ]),
    },
    {
      name: SECTION_SHEET["customer-stakeholders"],
      head: [
        "customer_id",
        "stakeholder_role",
        "name",
        "title",
        "employer_org",
        "email",
        "last_contact",
      ],
      rows: (peopleSeed.customerStakeholders ?? []).map((p) => [
        p.customer_id,
        p.stakeholderRole,
        p.name,
        p.title,
        p.employerOrg,
        p.email,
        p.lastContact,
      ]),
    },
  ];
}

// --- File-system model ------------------------------------------------------

type FileKind = "sheet" | "doc" | "pdf" | "audio" | "yaml";
interface FileItem {
  id: string;
  name: string;
  kind: FileKind;
  sheetNames?: string[]; // a multi-sheet workbook (.xlsx): its sheets, filled from the workspace's records when open
  path?: string; // logical dm.md data-room path — content is fetched live from /api/dataroom
  live?: boolean; // true when the file actually exists in the Blob store
  meta?: string;
}

/** Fetched body of one Blob-backed file, cached per path for the open session.
 *
 *  `binary` is the PDF case: the file IS in the store, but its bytes are not
 *  text and are not cached here — the viewer streams them itself. The state
 *  exists so a PDF gets the same three-way answer every other kind gets
 *  (loading / not there yet / here), instead of the one placeholder card that
 *  read "preview isn't wired up yet" whether the file existed or not. */
type FileBody =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "binary" }
  | { status: "missing" }
  | { status: "error"; message: string };
interface FolderNode {
  id: string;
  /** The real folder name (a path segment). Never relabelled. */
  name: string;
  /** What people read instead of `name`, when the deployment profile relabels a domain. */
  label?: string;
  /** Shown as the folder's tooltip. */
  description?: string;
  folders: FolderNode[];
  files: FileItem[];
}

function fileIcon(kind: FileKind) {
  if (kind === "sheet") return FileSpreadsheetIcon;
  if (kind === "audio") return FileAudioIcon;
  if (kind === "pdf") return FileIcon;
  if (kind === "yaml") return FileCode2Icon;
  return FileTextIcon;
}

/** Infer a file kind from its extension so the tree shows the right icon. */
function kindFromName(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["yaml", "yml", "tf", "toml", "json", "jsonl", "sh", "tpl"].includes(ext)) return "yaml";
  if (ext === "pdf") return "pdf";
  if (["m4a", "mp3", "wav"].includes(ext)) return "audio";
  return "doc";
}

// --- The dm.md data room: seven domains, one Master.xlsx per domain ----------
//
// The file tree mirrors dm.md (the canonical data-room structure): Customers,
// Platform, Deployments, Solutions, Implementation, Tickets, People. Each
// domain root carries a Master.xlsx holding that domain's sheets (see
// docs/data-model.md for the packaging map), surrounded by the domain's real
// artifacts — context briefs, interaction logs, Terraform, Helm values,
// JSON Schemas, signoff records, eval datasets, ticket JSONL files.

// A derived sheet: one row per customer, a narrative summary of every
// interaction — the "data room of the summary of all the interactions". Lives
// in the Tickets workbook alongside the raw Interactions detail sheet.
function interactionDigest(c: Customer): {
  count: string;
  range?: string;
  last?: string;
  actions?: string;
  sentiment?: string;
  digest: React.ReactNode;
} {
  const list = (c.interactions ?? [])
    .slice()
    .sort((a, b) => String(a.interactionAt ?? "").localeCompare(String(b.interactionAt ?? "")));
  const day = (s?: string) => (s ? s.slice(0, 10) : undefined);
  if (list.length === 0) {
    return { count: "0", actions: "0", digest: <DigestCell text="No interactions logged yet." /> };
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

  return {
    count: String(list.length),
    range,
    last: day(lastI.interactionAt),
    actions: String(openActions.length),
    sentiment,
    digest: <DigestCell text={`${lead}\n\n${timeline}\n\n${recent} ${actionsLine}`} />,
  };
}

function interactionDigestSheet(customers: Customer[]): Sheet {
  return {
  name: "Interaction Digest",
  head: [
    "customer_id",
    "customer_name",
    "interactions",
    "date_range",
    "last_touch",
    "open_next_actions",
    "sentiment",
    "digest",
  ],
  rows: customers.map((c) => {
    const d = interactionDigest(c);
    return [c.id, c.name, d.count, d.range, d.last, d.actions, d.sentiment, d.digest];
  }),
  };
}

/** Every sheet of the workbook, by name, built from the workspace's records. */
function sheetsByName(data: WorkbookData): Record<string, Sheet> {
  const c = data.customers;
  const shaped = [...buildWorkbook(data), interactionDigestSheet(c)]
    .filter((s) => !HIDDEN_SHEETS.has(s.name))
    .map((s) => withoutHidden(s, SHEET_HIDDEN[s.name]))
    .map((s) =>
      s.name === "Customers"
        ? withOwnColumns(s, listedOwnFields("account"), c)
        : s.name === "Deployments"
          ? withOwnColumns(s, listedOwnFields("deployments"), c.flatMap((x) => x.deployments ?? []))
          : s.name === "Implementation"
            ? withOwnColumns(s, listedOwnFields("implementations"), c.map((x) => x.implementation))
            : s,
    );
  return Object.fromEntries(shaped.map((s) => [s.name, s]));
}

/**
 * WHAT THE PROFILE SHOWS (lib/workbook-fields.ts). A field it hides is never a column, even when an answer carries
 * it; a nested part it hides (platform, solutions, tickets) is not a sheet; the own fields it lists are columns, in
 * its labels. Under the hfc-research profile that is 26 hidden account fields gone and Rating / Target price / KPI
 * table completeness on the coverage reports (check-ui-vocabulary's data-room pass holds it).
 */
const HIDDEN = workbookHidden();
const SHEET_HIDDEN: Record<string, ReadonlySet<string>> = {
  Customers: HIDDEN.account,
  Deployments: HIDDEN.deployments,
  Implementation: HIDDEN.implementation,
};
const TABLE_SHEET: Partial<Record<WorkbookTable, string>> = { platform: "Platform", solutions: "Solutions", tickets: "Tickets" };
const HIDDEN_SHEETS = new Set([...HIDDEN.tables].map((t) => TABLE_SHEET[t]).filter((n): n is string => Boolean(n)));

function withoutHidden(sheet: Sheet, hidden: ReadonlySet<string> | undefined): Sheet {
  if (!hidden?.size) return sheet;
  const keep = sheet.head.map((col) => ![...hidden].some((k) => sameKey(k, col)));
  if (keep.every(Boolean)) return sheet;
  return {
    ...sheet,
    head: sheet.head.filter((_, i) => keep[i]),
    rows: sheet.rows.map((r) => r.filter((_, i) => keep[i])),
  };
}

/** An own field's value as a cell: a percent reads as one; anything else as it is stored. */
function ownCell(value: unknown, spec: CustomFieldSpec): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (spec.type === "percent" && typeof value === "number") return `${value}%`;
  if (spec.type === "number" && typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

/** The listed own fields as columns after the stored ones; `owners[i]` is the record behind row i. */
function withOwnColumns(sheet: Sheet, specs: CustomFieldSpec[], owners: ({ custom?: Record<string, unknown> } | undefined)[]): Sheet {
  if (!specs.length) return sheet;
  return {
    ...sheet,
    own: specs.map((f) => f.label),
    rows: sheet.rows.map((r, i) => [...r, ...specs.map((f) => ownCell(owners[i]?.custom?.[f.key], f))]),
  };
}

/**
 * The tables each sheet is read from. A sheet one of whose tables could not be read says so instead of its rows; a
 * sheet one of whose tables the route capped says it shows only part. The account-derived sheets depend on the
 * accounts too: past the accounts' cap, the rest of the accounts' rows are not there either.
 */
const SHEET_TABLES: Record<string, WorkbookTable[]> = {
  Customers: ["customers"],
  Platform: ["platform", "customers"],
  Deployments: ["deployments", "customers"],
  Solutions: ["solutions", "customers"],
  Implementation: ["implementation", "customers"],
  Tickets: ["tickets", "customers"],
  Interactions: ["interactions", "customers"],
  "Interaction Digest": ["interactions", "customers"],
  "Internal Staff": ["internal_staff"],
  [SECTION_SHEET["customer-stakeholders"]]: ["customer_stakeholders"],
};

/** Which sheets live in each workbook. Keyed on the data-room tab. */
const WORKBOOK_SHEETS: Record<DataroomTab, string[]> = {
  customers: ["Customers"],
  platform: ["Platform"],
  deployments: ["Deployments"],
  solutions: ["Solutions"],
  implementation: ["Implementation"],
  tickets: ["Tickets", "Interactions", "Interaction Digest"],
  // Personnel: OnFinance staff assignments + external customer stakeholders.
  people: ["Internal Staff", SECTION_SHEET["customer-stakeholders"]],
  // Supporting tabs, if ever opened directly, resolve to a single-sheet book.
  interactions: ["Interactions"],
  "internal-staff": ["Internal Staff"],
  "customer-stakeholders": [SECTION_SHEET["customer-stakeholders"]],
};

/** The sheet names of one workbook: fixed by the data model, whatever the workspace holds. */
function workbookSheetNames(section: DataroomTab): string[] {
  return WORKBOOK_SHEETS[section] ?? [];
}

/** A Blob-backed dm.md file: `id` IS its logical data-room path; content is fetched live. */
function doc(path: string, meta?: string): FileItem {
  const name = path.split("/").pop() ?? path;
  return { id: path, name, kind: kindFromName(name), path, meta };
}

/** A binary artifact (pdf, audio…) — present in the tree, no inline preview. */
function bin(path: string, meta?: string): FileItem {
  const name = path.split("/").pop() ?? path;
  return { id: path, name, kind: kindFromName(name), meta };
}

function dir(
  id: string,
  name: string,
  files: FileItem[] = [],
  folders: FolderNode[] = [],
): FolderNode {
  return { id, name, files, folders };
}

/** `<Domain>/Master.xlsx`, carrying that domain's sheets. */
function masterFile(domain: string, tab: DataroomTab): FileItem {
  const sheetNames = workbookSheetNames(tab);
  return {
    id: `master:${domain}`,
    name: "Master.xlsx",
    kind: "sheet",
    sheetNames,
    meta: `${sheetNames.length} sheet${sheetNames.length === 1 ? "" : "s"}`,
  };
}

// --- The dm.md SKELETON: seven domains, folder structure only ----------------
//
// This mirrors dm.md (the canonical data-room structure) so the full folder
// tree — including empty folders — always shows. Files carry their logical
// dm.md path but embed NO content: on open, the modal fetches /api/dataroom
// for the live Blob path list (marking which skeleton files actually exist in
// the store, and adding any Blob files the skeleton doesn't know about), then
// fetches each opened file's body from /api/dataroom?path=… on demand. The
// per-domain Master.xlsx workbooks stay app-rendered from the sheets above.

const CUSTOMERS_DOMAIN: FolderNode = dir(
  "dom:customers",
  "Customers",
  [masterFile("customers", "customers")],
  [
    dir(
      "customers/syncs",
      "syncs",
      [],
      [
        dir("customers/syncs/manual_entry", "manual_entry"),
        dir("customers/syncs/email", "email"),
        dir("customers/syncs/slack", "slack"),
        dir(
          "customers/syncs/meeting_notes",
          "meeting_notes",
          [],
          [dir("customers/syncs/meeting_notes/granola", "granola")],
        ),
      ],
    ),
  ],
);

const PLATFORM_DOMAIN: FolderNode = dir(
  "dom:platform",
  "Platform",
  [masterFile("platform", "platform")],
  [
    dir(
      "platform/syncs",
      "syncs",
      [],
      [
        dir("platform/syncs/manual_entry", "manual_entry"),
        dir("platform/syncs/github", "github"),
        dir("platform/syncs/aws", "aws"),
        dir("platform/syncs/slack", "slack"),
        dir("platform/syncs/miro", "miro"),
      ],
    ),
  ],
);

const DEPLOYMENTS_DOMAIN: FolderNode = dir(
  "dom:deployments",
  "Deployments",
  [masterFile("deployments", "deployments")],
  [
    dir(
      "deployments/syncs",
      "syncs",
      [],
      [
        dir("deployments/syncs/manual_input", "manual_input"),
        dir("deployments/syncs/claude", "claude"),
        dir("deployments/syncs/codex", "codex"),
        dir("deployments/syncs/email", "email"),
        dir("deployments/syncs/github", "github"),
        dir("deployments/syncs/aws", "aws"),
        dir("deployments/syncs/azure", "azure"),
        dir("deployments/syncs/gcp", "gcp"),
        dir("deployments/syncs/oci", "oci"),
        dir(
          "deployments/syncs/bare_metal",
          "bare_metal",
          [],
          [
            dir("deployments/syncs/bare_metal/oc", "oc"),
            dir("deployments/syncs/bare_metal/nkp", "nkp"),
            dir("deployments/syncs/bare_metal/custom_k8s", "custom_k8s"),
          ],
        ),
      ],
    ),
  ],
);

const SOLUTIONS_DOMAIN: FolderNode = dir(
  "dom:solutions",
  "Solutions",
  [masterFile("solutions", "solutions")],
  [],
);

const IMPLEMENTATION_DOMAIN: FolderNode = dir(
  "dom:implementation",
  "Implementation",
  [masterFile("implementation", "implementation")],
  [],
);

const TICKETS_DOMAIN: FolderNode = dir(
  "dom:tickets",
  "Tickets",
  [masterFile("tickets", "tickets")],
  [
    dir("tickets/feat", "feat"),
    dir("tickets/search", "search"),
    dir("tickets/bug", "bug"),
    dir("tickets/docs", "docs"),
    dir("tickets/evals", "evals"),
    dir("tickets/config_changes", "config_changes"),
    dir("tickets/data_migration", "data_migration"),
    dir("tickets/backfills", "backfills"),
    dir("tickets/onboarding", "onboarding"),
    dir(
      "tickets/syncs",
      "syncs",
      [],
      [
        dir("tickets/syncs/manual_entry", "manual_entry"),
        dir("tickets/syncs/call", "call"),
        dir("tickets/syncs/email", "email"),
        dir("tickets/syncs/slack", "slack"),
      ],
    ),
  ],
);

const PEOPLE_DOMAIN: FolderNode = dir(
  "dom:people",
  "People",
  [masterFile("person", "people")],
  [
    dir(
      "person/syncs",
      "syncs",
      [],
      [
        dir("person/syncs/manual_entry", "manual_entry"),
        dir("person/syncs/email", "email"),
        dir("person/syncs/slack", "slack"),
        dir("person/syncs/analytics", "analytics"),
        dir("person/syncs/observability", "observability"),
        dir(
          "person/syncs/meeting_notes",
          "meeting_notes",
          [],
          [dir("person/syncs/meeting_notes/granola", "granola")],
        ),
      ],
    ),
  ],
);

/**
 * The dm.md domains this deployment shows, in canonical order. Each keeps its real `name`/`id` (paths, Master.xlsx
 * and sheet lookups key on those); the deployment profile supplies the label people read and can hide a domain.
 */
const DATA_ROOM_DOMAINS: FolderNode[] = [
  CUSTOMERS_DOMAIN,
  PLATFORM_DOMAIN,
  DEPLOYMENTS_DOMAIN,
  SOLUTIONS_DOMAIN,
  IMPLEMENTATION_DOMAIN,
  TICKETS_DOMAIN,
  PEOPLE_DOMAIN,
]
  .filter((node) => domainDisplay(node.name).visible)
  .map((node) => {
    const { label, description } = domainDisplay(node.name);
    return { ...node, label, description };
  });

/** DataroomTab → the dm.md domain key that carries its Master.xlsx. */
const TAB_DOMAIN_KEY: Record<DataroomTab, string> = {
  customers: "customers",
  platform: "platform",
  deployments: "deployments",
  solutions: "solutions",
  implementation: "implementation",
  tickets: "tickets",
  people: "person",
  interactions: "tickets",
  "internal-staff": "person",
  "customer-stakeholders": "person",
};

/** Domain key → the tab whose sheet set fills that domain's Master.xlsx. */
const DOMAIN_MASTER_TAB: Record<string, DataroomTab> = {
  customers: "customers",
  platform: "platform",
  deployments: "deployments",
  solutions: "solutions",
  implementation: "implementation",
  tickets: "tickets",
  person: "people",
};

/** Domain key → the real domain name the deployment profile is keyed on. */
const DOMAIN_KEY_NAME: Record<string, string> = {
  customers: "Customers",
  platform: "Platform",
  deployments: "Deployments",
  solutions: "Solutions",
  implementation: "Implementation",
  tickets: "Tickets",
  person: "People",
};

/** A tab whose domain this deployment hides falls back to the first visible one (Customers is always visible). */
function visibleTab(tab: DataroomTab): DataroomTab {
  const domain = TAB_DOMAIN_KEY[tab];
  if (domainDisplay(DOMAIN_KEY_NAME[domain] ?? domain).visible) return tab;
  return DATAROOM_SECTIONS[0]?.key ?? "customers";
}

const DOMAIN_FOLDER_IDS = DATA_ROOM_DOMAINS.map((f) => f.id);

/** Clone the skeleton so live markers/insertions never mutate module constants. */
function cloneFolder(node: FolderNode): FolderNode {
  return {
    ...node,
    folders: node.folders.map(cloneFolder),
    files: node.files.map((file) => ({ ...file })),
  };
}

function indexFilesByPath(node: FolderNode, into: Map<string, FileItem>): void {
  for (const file of node.files) if (file.path) into.set(file.path, file);
  for (const sub of node.folders) indexFilesByPath(sub, into);
}

/**
 * Merge the live Blob path list onto the dm.md skeleton: skeleton files that
 * exist in the store are marked `live`; Blob paths the skeleton doesn't show
 * are inserted under the right folders (created on demand, mirroring the
 * path's segments). Master.xlsx paths are skipped — the per-domain workbooks
 * stay app-rendered from the sheet data. While the list is still loading
 * (null) the skeleton stays optimistic so the tree doesn't flash dim.
 */
function mergeLiveDomains(livePaths: string[] | null): FolderNode[] {
  const domains = DATA_ROOM_DOMAINS.map(cloneFolder);
  const filesByPath = new Map<string, FileItem>();
  for (const domain of domains) indexFilesByPath(domain, filesByPath);

  if (livePaths === null) {
    for (const file of filesByPath.values()) file.live = true;
    return domains;
  }

  const live = new Set(livePaths);
  for (const file of filesByPath.values()) file.live = live.has(file.path as string);

  for (const path of livePaths) {
    if (filesByPath.has(path)) continue;
    const segments = path.split("/");
    if (segments.length < 2) continue;
    const name = segments[segments.length - 1];
    if (name === "Master.xlsx") continue;
    // Resolve by domain id, not display name — ids are the stable key.
    const domain = domains.find((d) => d.id === `dom:${segments[0].toLowerCase()}`);
    if (!domain) continue;
    let node = domain;
    let prefix = segments[0];
    for (const segment of segments.slice(1, -1)) {
      prefix = `${prefix}/${segment}`;
      let child = node.folders.find((f) => f.name === segment);
      if (!child) {
        child = { id: `live:${prefix}`, name: segment, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    if (!node.files.some((f) => f.name === name)) {
      node.files.push({ id: path, name, kind: kindFromName(name), path, live: true });
    }
  }
  return domains;
}

/**
 * The Uploads folder, built from the live data-room paths under `Uploads/` so
 * every persisted upload appears nested under its uploader's identity folder
 * (Uploads/{person_id}/file). `pending` holds just-uploaded files that may not
 * be in the live list yet (optimistic), merged in under the same nesting.
 */
function buildUploadsFolder(livePaths: string[] | null, pending: FileItem[]): FolderNode {
  const root: FolderNode = { id: "uploads", name: "Uploads", folders: [], files: [] };
  const place = (path: string, item: FileItem) => {
    const segments = path.split("/");
    let node = root;
    let prefix = "Uploads";
    for (const segment of segments.slice(1, -1)) {
      prefix = `${prefix}/${segment}`;
      let child = node.folders.find((f) => f.name === segment);
      if (!child) {
        child = { id: `live:${prefix}`, name: segment, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    if (!node.files.some((f) => f.path === path)) node.files.push(item);
  };
  const livedUploads = (livePaths ?? []).filter((p) => p.startsWith("Uploads/") && p.split("/").length >= 3);
  for (const path of livedUploads) {
    const name = path.split("/").pop() as string;
    place(path, { id: path, name, kind: kindFromName(name), path, live: true });
  }
  for (const p of pending) {
    if (!p.path || livedUploads.includes(p.path)) continue;
    place(p.path, p);
  }
  return root;
}

/** The whole data room: the seven (live-merged) domains + the Uploads folder. */
function buildDataroomRoot(domains: FolderNode[], uploads: FolderNode): FolderNode {
  return {
    id: "root",
    name: DEPLOYMENT_PROFILE.dataroom.root_label,
    files: [],
    folders: [...domains, uploads],
  };
}

function collectFiles(
  node: FolderNode,
  path: string[] = [],
): Array<{ file: FileItem; path: string[] }> {
  const here = node.id === "root" ? path : [...path, node.label ?? node.name];
  return [
    ...node.files.map((file) => ({ file, path: here })),
    ...node.folders.flatMap((f) => collectFiles(f, here)),
  ];
}

function findFile(node: FolderNode, id: string): FileItem | null {
  for (const f of node.files) if (f.id === id) return f;
  for (const sub of node.folders) {
    const found = findFile(sub, id);
    if (found) return found;
  }
  return null;
}

export function Dataroom({
  open,
  onOpenChange,
  initialTab,
  initialSheet,
  getAuthHeaders,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialTab: DataroomTab;
  readonly initialSheet?: string;
  readonly getAuthHeaders?: () => Record<string, string>;
}) {
  const [openId, setOpenId] = useState("master:customers");
  const [sheetIdx, setSheetIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [uploads, setUploads] = useState<FileItem[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(DOMAIN_FOLDER_IDS));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Live Blob state: the store's logical path list (null while loading) and a
  // per-path content cache for the open session.
  const [livePaths, setLivePaths] = useState<string[] | null>(null);
  const [fileBodies, setFileBodies] = useState<Record<string, FileBody>>({});
  // The workspace's own records, which every Master.xlsx preview is built from (never a bundled sample).
  const [workbook, setWorkbook] = useState<WorkbookState>({ status: "loading" });
  /** Reads the workbook again (a failed read's Retry). */
  const [reloadKey, setReloadKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  const domains = useMemo(() => mergeLiveDomains(livePaths), [livePaths]);
  const uploadsFolder = useMemo(() => buildUploadsFolder(livePaths, uploads), [livePaths, uploads]);
  const root = useMemo(() => buildDataroomRoot(domains, uploadsFolder), [domains, uploadsFolder]);

  // On modal open: read the workspace's records for the Master.xlsx previews. A failed read is said, never shown
  // as an empty workspace.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWorkbook({ status: "loading" });
    fetch("/api/ops/workbook", { headers: getAuthHeaders ? getAuthHeaders() : {} })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (cancelled) return;
        if (!res.ok || data === null) {
          setWorkbook({ status: "error", message: data?.error ?? `HTTP ${res.status}` });
          return;
        }
        setWorkbook({ status: "ready", data: asWorkbook(data) });
      })
      .catch((error: unknown) => {
        if (!cancelled) setWorkbook({ status: "error", message: error instanceof Error ? error.message : "Network error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);
  const sheetIndex = useMemo(
    () => (workbook.status === "ready" ? sheetsByName(workbook.data) : null),
    [workbook],
  );

  // On modal open: reset the session caches and fetch the live path list.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLivePaths(null);
    setFileBodies({});
    fetch("/api/dataroom", { headers: getAuthHeaders ? getAuthHeaders() : {} })
      .then((res) => res.json())
      .then((data: { paths?: unknown }) => {
        if (cancelled) return;
        setLivePaths(Array.isArray(data?.paths) ? (data.paths as string[]) : []);
      })
      .catch(() => {
        if (!cancelled) setLivePaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setUploads([]);
    setUploadError(null);
    setArchived(new Set());
    setSearch("");
    // Domain folders read as a real file system: all seven expanded by default.
    setExpanded(new Set([...DOMAIN_FOLDER_IDS, "uploads"]));
    setSidebarOpen(true);
    // Resolve the requested tab against the dm.md tree: open that domain's
    // Master.xlsx on the requested sheet.
    const tab = visibleTab(initialTab);
    const domain = TAB_DOMAIN_KEY[tab];
    setOpenId(`master:${domain}`);
    const targetSheet = (tab === initialTab ? initialSheet : undefined) ?? SECTION_SHEET[tab];
    const idx = workbookSheetNames(DOMAIN_MASTER_TAB[domain]).filter((name) => !HIDDEN_SHEETS.has(name)).findIndex((name) => name === targetSheet);
    setSheetIdx(idx >= 0 ? idx : 0);
  }, [open, initialTab, initialSheet]);

  const openFile = findFile(root, openId);

  // When a Blob-backed file is opened, fetch its body once and cache it for
  // the session. Sheet workbooks are app-rendered and audio has no viewer, so
  // neither fetches.
  //
  // A PDF does not fetch HERE EITHER, and that is not the old "binaries never
  // fetch" rule — it is a different one. /api/dataroom's JSON answer decodes the
  // object as UTF-8 text, which destroys a PDF, and holding a 40 MB string in
  // `fileBodies` for the session would be a second copy of a file that is
  // already expensive. The viewer streams the bytes itself
  // (pdf-view.tsx → /api/dataroom?as=bytes) and hands the memory back page by
  // page; all this state has to know is whether the file is THERE.
  const fetchPath =
    openFile?.path && openFile.kind !== "sheet" && openFile.kind !== "pdf" && openFile.kind !== "audio"
      ? openFile.path
      : null;
  /**
   * A PDF's "body" is DERIVED, never cached in `fileBodies`.
   *
   * All it has to answer is whether the object is in the store, and that answer
   * CHANGES: an upload shows optimistically (`live`) and the live path list is
   * refetched a moment later. Caching the first answer froze a filing the
   * analyst had just dropped in as "Not created yet" until they closed and
   * reopened the room. Nothing is saved by caching it either — the bytes are the
   * viewer's to stream, so there is no body here to hold on to.
   */
  const binaryBody = (file: FileItem): FileBody => {
    if (file.live) return { status: "binary" };
    if (livePaths === null) return { status: "loading" };
    return livePaths.includes(file.path ?? "") ? { status: "binary" } : { status: "missing" };
  };
  useEffect(() => {
    if (!open || !fetchPath || fileBodies[fetchPath]) return;
    const path = fetchPath;
    // The live list already told us this file doesn't exist — skip the fetch.
    if (livePaths !== null && !livePaths.includes(path)) {
      setFileBodies((prev) => ({ ...prev, [path]: { status: "missing" } }));
      return;
    }
    setFileBodies((prev) => ({ ...prev, [path]: { status: "loading" } }));
    fetch(`/api/dataroom?path=${encodeURIComponent(path)}`, { headers: getAuthHeaders ? getAuthHeaders() : {} })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          content?: string;
          records?: unknown[];
          found?: boolean;
          error?: string;
        } | null;
        if (!res.ok || data === null) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        if (data.found === false) {
          setFileBodies((prev) => ({ ...prev, [path]: { status: "missing" } }));
        } else if (Array.isArray(data.records)) {
          // .jsonl comes back as parsed records — re-serialize one per line
          // so the existing JsonlView renders them.
          // Keys in the profile's words (lib/ui-keys.ts); values exactly as stored.
          const content = data.records.map((record) => jsonForPeople(record)).join("\n");
          setFileBodies((prev) => ({ ...prev, [path]: { status: "ready", content } }));
        } else {
          setFileBodies((prev) => ({
            ...prev,
            [path]: { status: "ready", content: data.content ?? "" },
          }));
        }
      })
      .catch((error: unknown) => {
        setFileBodies((prev) => ({
          ...prev,
          [path]: {
            status: "error",
            message: error instanceof Error ? error.message : "Failed to load the file",
          },
        }));
      });
  }, [open, fetchPath, livePaths, fileBodies]);

  /** The open workbook's sheets: built from the workspace's records once they are read; headers only until then. A
   *  sheet the profile hides (a nested part it does not use) is not one of them. */
  const openSheets: Sheet[] | undefined = openFile?.sheetNames
    ?.filter((name) => !HIDDEN_SHEETS.has(name))
    .map((name) => sheetIndex?.[name] ?? { name, head: [], rows: [] });
  const activeSheet = openSheets?.length ? Math.min(sheetIdx, openSheets.length - 1) : 0;
  const activeTables = openSheets?.length ? (SHEET_TABLES[openSheets[activeSheet].name] ?? []) : [];
  /** One of this sheet's tables could not be read: the sheet says so instead of rows (never "no records"). */
  const sheetUnavailable = workbook.status === "ready" && activeTables.some((t) => workbook.data.unavailable.includes(t));
  /** One of this sheet's tables was cut at the route's cap: the sheet says it shows only part. */
  const sheetCapped =
    workbook.status === "ready" && !sheetUnavailable
      ? activeTables.map((t) => workbook.data.tables[t]).find((info) => info?.truncated)
      : undefined;
  /** What an empty sheet says. Never a sample record: loading, a failed read, or the workspace's own emptiness. */
  const emptySheet: React.ReactNode =
    workbook.status === "loading" ? (
      <span data-testid="dataroom-loading">Loading {W.account} records…</span>
    ) : workbook.status === "error" ? (
      <span data-testid="dataroom-error" className="flex flex-col items-center gap-2">
        <span>The {W.account} records could not be loaded ({workbook.message}).</span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-md border border-border px-2.5 py-1 text-foreground text-xs hover:bg-muted"
        >
          Retry
        </button>
      </span>
    ) : sheetUnavailable ? (
      <span data-testid="dataroom-unavailable">
        These records could not be loaded right now. The other sheets are not affected; close and reopen to try again.
      </span>
    ) : workbook.data.customers.length === 0 ? (
      <span data-testid="dataroom-empty" className="flex flex-col items-center gap-1">
        <span className="font-medium text-foreground">No {W.accounts} yet</span>
        <span>Records appear here once {an(W.account)} {W.account} is added to this workspace.</span>
      </span>
    ) : (
      "No records."
    );
  const openAt = (id: string) => {
    setOpenId(id);
    setSheetIdx(0);
  };
  const searchResults = search.trim()
    ? collectFiles(root).filter(
        ({ file }) =>
          !archived.has(file.id) && file.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : null;

  const toggleFolder = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const archive = (id: string) => setArchived((prev) => new Set(prev).add(id));
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setUploadError(null);
    setExpanded((prev) => new Set(prev).add("uploads"));
    for (const f of picked) {
      const form = new FormData();
      form.append("file", f);
      try {
        const res = await fetch("/api/ops/upload", {
          method: "POST",
          headers: getAuthHeaders ? getAuthHeaders() : {},
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as { path?: string; name?: string; error?: string };
        if (res.ok && data.path) {
          // Optimistic: show it immediately under its identity folder; the live
          // refetch below reconciles it to the canonical Uploads/{me}/ path.
          const path = data.path;
          const name = data.name ?? f.name;
          setUploads((prev) => [
            {
              id: path,
              name,
              kind: kindFromName(name),
              path,
              live: true,
              meta: `${Math.max(1, Math.round(f.size / 1024))} KB`,
            },
            ...prev.filter((x) => x.path !== path),
          ]);
        } else {
          setUploadError(data.error ?? `Upload failed for ${f.name}.`);
        }
      } catch {
        setUploadError(`Upload failed for ${f.name}.`);
      }
    }
    // Refetch the live path list so uploads appear canonically (and persist across reopen).
    fetch("/api/dataroom", { headers: getAuthHeaders ? getAuthHeaders() : {} })
      .then((r) => r.json())
      .then((d: { paths?: unknown }) => setLivePaths(Array.isArray(d?.paths) ? (d.paths as string[]) : []))
      .catch(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[99vh] w-[99vw] max-w-[99vw] flex-col gap-0 overflow-hidden rounded-2xl border border-white/10 bg-popover p-0 shadow-2xl ring-1 ring-white/5 sm:max-w-[99vw]">
        <DialogHeader className="sr-only">
          <DialogTitle>{DEPLOYMENT_PROFILE.dataroom.root_label}</DialogTitle>
          <DialogDescription>Consolidated system of record.</DialogDescription>
        </DialogHeader>

        {/* Title bar — height matched to the dialog close button so their centers align */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
          <FolderTreeIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{DEPLOYMENT_PROFILE.dataroom.root_label}</span>
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Hide file tree" : "Show file tree"}
            aria-label={sidebarOpen ? "Hide file tree" : "Show file tree"}
            aria-pressed={sidebarOpen}
            className="mr-8 ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {sidebarOpen ? (
              <PanelRightCloseIcon className="size-4" />
            ) : (
              <PanelRightIcon className="size-4" />
            )}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Left sidebar — the dm.md file tree */}
          {sidebarOpen ? (
          <aside className="flex w-72 shrink-0 flex-col border-border border-r bg-background">
            {/* File system */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-border border-b p-2">
                <div className="relative flex-1">
                  <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search files…"
                    className="w-full rounded-md border border-border bg-background py-1 pr-2 pl-7 text-xs outline-none focus:border-foreground/30"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => uploadRef.current?.click()}
                  title="Upload"
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <UploadIcon className="size-3.5" />
                </button>
                <input ref={uploadRef} type="file" multiple className="hidden" onChange={onUpload} />
              </div>
              {uploadError ? (
                <div className="border-border border-b px-2 py-1.5 text-2xs text-destructive">
                  {uploadError}
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {searchResults ? (
                  searchResults.length > 0 ? (
                    searchResults.map(({ file, path }) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        depth={0}
                        isOpen={openId === file.id}
                        onOpen={() => openAt(file.id)}
                        onArchive={() => archive(file.id)}
                        subtitle={path.join(" / ") || undefined}
                      />
                    ))
                  ) : (
                    <p className="p-3 text-center text-muted-foreground text-xs">No files match.</p>
                  )
                ) : (
                  <FileTree
                    folder={root}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggleFolder}
                    openId={openId}
                    onOpen={openAt}
                    onArchive={archive}
                    archived={archived}
                  />
                )}
              </div>
            </div>
          </aside>
          ) : null}

          {/* Main — the open workbook sheet / file, full remaining width */}
          <div className="flex min-w-0 flex-1 flex-col bg-muted/10">
            {openFile?.kind === "sheet" && openSheets?.length ? (
              <>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {sheetCapped ? (
                    <p data-testid="dataroom-truncated" className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
                      Showing the first {sheetCapped.rows.toLocaleString("en-US")} of these records, {orderPhrase(sheetCapped.order)}. The rest
                      are in the workspace but not shown here.
                    </p>
                  ) : null}
                  <Table
                    head={[...openSheets[activeSheet].head.map((k) => sheetColumnKey(openSheets[activeSheet].name, k)), ...(openSheets[activeSheet].own ?? [])]}
                    rows={sheetUnavailable ? [] : openSheets[activeSheet].rows}
                    empty={emptySheet}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-border border-t bg-muted/40 px-2 py-1">
                  {openSheets.map((s, i) => (
                    <button
                      type="button"
                      key={s.name}
                      onClick={() => setSheetIdx(i)}
                      className={cn(
                        "shrink-0 rounded-t-md border-t-2 px-3 py-1 text-xs transition-colors",
                        i === activeSheet
                          ? "border-foreground bg-background font-medium text-foreground"
                          : "border-transparent text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {sheetTitle(s.name)}
                    </button>
                  ))}
                </div>
              </>
            ) : openFile ? (
              <FilePreview
                file={openFile}
                body={
                  !openFile.path
                    ? undefined
                    : openFile.kind === "pdf"
                      ? binaryBody(openFile)
                      : fileBodies[openFile.path]
                }
              />
            ) : (
              <p className="grid flex-1 place-items-center text-muted-foreground text-sm">
                Select a file to open it.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileTree({
  folder,
  depth,
  expanded,
  onToggle,
  openId,
  onOpen,
  onArchive,
  archived,
}: {
  readonly folder: FolderNode;
  readonly depth: number;
  readonly expanded: Set<string>;
  readonly onToggle: (id: string) => void;
  readonly openId: string;
  readonly onOpen: (id: string) => void;
  readonly onArchive: (id: string) => void;
  readonly archived: Set<string>;
}) {
  return (
    <>
      {folder.folders.map((sub) => {
        const isOpen = expanded.has(sub.id);
        return (
          <div key={sub.id}>
            <button
              type="button"
              onClick={() => onToggle(sub.id)}
              title={sub.description}
              style={{ paddingLeft: depth * 12 + 6 }}
              className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-2xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")}
              />
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{sub.label ?? sub.name}</span>
            </button>
            {isOpen ? (
              <FileTree
                folder={sub}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                openId={openId}
                onOpen={onOpen}
                onArchive={onArchive}
                archived={archived}
              />
            ) : null}
          </div>
        );
      })}
      {folder.files
        .filter((f) => !archived.has(f.id))
        .map((file) => (
          <FileRow
            key={file.id}
            file={file}
            depth={depth}
            isOpen={openId === file.id}
            onOpen={() => onOpen(file.id)}
            onArchive={() => onArchive(file.id)}
          />
        ))}
    </>
  );
}

function FileRow({
  file,
  depth,
  isOpen,
  onOpen,
  onArchive,
  subtitle,
}: {
  readonly file: FileItem;
  readonly depth: number;
  readonly isOpen: boolean;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
  readonly subtitle?: string;
}) {
  const Icon = fileIcon(file.kind);
  // Skeleton-only rows (a dm.md slot with no Blob artifact yet) render dimmed.
  const skeletonOnly = Boolean(file.path) && file.live !== true;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        style={{ paddingLeft: depth * 12 + 18 }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-7 text-left text-2xs transition-colors",
          isOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
          skeletonOnly && "opacity-50",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{file.name}</span>
      </button>
      <button
        type="button"
        onClick={onArchive}
        title="Archive"
        className="absolute top-1 right-1 hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
      >
        <ArchiveIcon className="size-3" />
      </button>
      {subtitle ? (
        <p
          className="truncate pb-0.5 text-3xs text-muted-foreground/60"
          style={{ paddingLeft: depth * 12 + 32 }}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

/** Pretty-print a JSON string; fall back to the raw text if it doesn't parse. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A monospace block that preserves whitespace (yaml/tf/json/etc.). */
function CodeBlock({ text }: { readonly text: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-lg border border-border/60 bg-muted/40 p-4 font-mono text-foreground/90 text-xs leading-relaxed">
      {text}
    </pre>
  );
}

/** One pretty-printed record per JSONL line. */
function JsonlView({ text }: { readonly text: string }) {
  const records = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    <div className="flex flex-col gap-3">
      {records.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static content, stable order
        <div key={i}>
          <p className="mb-1 font-medium text-3xs text-muted-foreground/60 uppercase tracking-wide">
            Record {i + 1}
          </p>
          <CodeBlock text={prettyJson(line)} />
        </div>
      ))}
    </div>
  );
}

/** Inline markdown: **bold** and `code`. */
function renderInline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      // biome-ignore lint/suspicious/noArrayIndexKey: static content, stable order
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: static content, stable order
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/** A lightweight rendered-markdown view: headings, bullets, bold, code. */
function MarkdownView({ text }: { readonly text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul
        key={`ul-${blocks.length}`}
        className="list-disc space-y-1 pl-5 text-foreground/90 text-sm leading-relaxed"
      >
        {list.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, stable order
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre
          key={`code-${blocks.length}`}
          className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flushList();
    if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={`h-${i}`} className="pt-2 font-semibold text-sm">
          {renderInline(line.slice(4))}
        </h3>,
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={`h-${i}`} className="pt-3 font-semibold text-base">
          {renderInline(line.slice(3))}
        </h2>,
      );
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h1 key={`h-${i}`} className="font-semibold text-xl">
          {renderInline(line.slice(2))}
        </h1>,
      );
    } else if (line.trim() !== "") {
      blocks.push(
        <p key={`p-${i}`} className="text-foreground/90 text-sm leading-relaxed">
          {renderInline(line)}
        </p>,
      );
    }
  }
  flushList();
  return <div className="flex w-full max-w-3xl flex-col gap-2.5">{blocks}</div>;
}

/** Centered status card used for binary, loading, missing, and error states. */
function FileStateCard({
  file,
  children,
}: {
  readonly file: FileItem;
  readonly children: React.ReactNode;
}) {
  const Icon = fileIcon(file.kind);
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-background/50 p-8 text-center">
        <Icon className="size-10 text-muted-foreground" />
        <div>
          <p className="font-medium text-sm">{file.name}</p>
          {file.meta ? <p className="text-muted-foreground text-xs">{file.meta}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Renders a Blob-backed file's fetched content by extension; a PDF is drawn by
 *  the in-app viewer, audio still keeps the placeholder card. */
function FilePreview({
  file,
  body,
}: {
  readonly file: FileItem;
  readonly body?: FileBody;
}) {
  // Audio, and any tree entry with no data-room path behind it: nothing to show.
  // A PDF used to be in this list, which is the whole defect — an analyst could
  // upload a filing, watch the agent read it, and never look at it themselves.
  if (!file.path || file.kind === "audio") {
    return (
      <FileStateCard file={file}>
        <p className="text-muted-foreground text-xs">
          Preview isn&apos;t wired up yet — this artifact lives in the {DEPLOYMENT_PROFILE.vocabulary.account.singular}&apos;s data room.
        </p>
      </FileStateCard>
    );
  }
  /**
   * The PDF, drawn by THE viewer — the same pdf.js component the published
   * artifact preview uses (app/_components/pdf-view.tsx), reading through
   * /api/dataroom, which resolves the path inside the caller's own workspace.
   * No second renderer, and no signed blob url in this page.
   *
   * The three states are the SAME three the text kinds show, for the same
   * reasons: nothing yet from the store → the "Loading from the data room…"
   * card; a tree slot the store has no object for → the "Not created yet" card;
   * the object is there → render it. Everything past that — a file too large to
   * draw, an expired sign-in, a password-protected document — is the viewer's
   * own error card, which names the file and says what happened.
   */
  if (file.kind === "pdf") {
    if (body?.status === "binary") {
      return (
        // Sized like the artifact panel's body: the viewer scrolls itself, so
        // this box must not add a second scrollbar around it.
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="dataroom-pdf">
          <PdfView dataroomPath={file.path} filename={file.name} />
        </div>
      );
    }
    if (body?.status === "missing") {
      return (
        <FileStateCard file={file}>
          <p className="text-muted-foreground text-xs">
            Not created yet — this dm.md slot has no artifact in the data room. Agents write it here
            as the engagement progresses.
          </p>
        </FileStateCard>
      );
    }
    return (
      <FileStateCard file={file}>
        <p className="animate-pulse text-muted-foreground text-xs">Loading from the data room…</p>
      </FileStateCard>
    );
  }
  if (!body || body.status === "loading" || body.status === "binary") {
    return (
      <FileStateCard file={file}>
        <p className="animate-pulse text-muted-foreground text-xs">Loading from the data room…</p>
      </FileStateCard>
    );
  }
  if (body.status === "missing") {
    return (
      <FileStateCard file={file}>
        <p className="text-muted-foreground text-xs">
          Not created yet — this dm.md slot has no artifact in the data room. Agents write it here
          as the engagement progresses.
        </p>
      </FileStateCard>
    );
  }
  if (body.status === "error") {
    return (
      <FileStateCard file={file}>
        <p className="text-red-500 text-xs">Couldn&apos;t load this file: {body.message}</p>
      </FileStateCard>
    );
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let rendered: React.ReactNode;
  if (ext === "md") rendered = <MarkdownView text={body.content} />;
  else if (ext === "json") rendered = <CodeBlock text={prettyJson(body.content)} />;
  else if (ext === "jsonl") rendered = <JsonlView text={body.content} />;
  else rendered = <CodeBlock text={body.content} />;
  return <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{rendered}</div>;
}

const SHEET_PAGE_SIZES = [10, 25, 50, 100];
const SHEET_PAGE_SIZE_KEY = "dataroom-page-size";

function Table({
  head,
  rows,
  empty = "No records.",
}: {
  readonly head: string[];
  readonly rows: (React.ReactNode | string | undefined)[][];
  /** What the sheet says when it has no rows. */
  readonly empty?: React.ReactNode;
}) {
  // Sheets had NO pagination — a 60-account workbook rendered every row. Page
  // size is user-configurable and shared across all sheets (persisted).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SHEET_PAGE_SIZE_KEY));
      return SHEET_PAGE_SIZES.includes(v) ? v : 25;
    } catch {
      return 25;
    }
  });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(1);
    try {
      localStorage.setItem(SHEET_PAGE_SIZE_KEY, String(n));
    } catch {
      /* storage unavailable */
    }
  };
  if (rows.length === 0) {
    return <div className="px-2 py-10 text-center text-muted-foreground text-sm">{empty}</div>;
  }
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  return (
    <div className="flex min-h-0 flex-col gap-2">
    <div className="overflow-auto rounded-lg border border-border bg-background">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted text-left text-muted-foreground text-xs">
            <th className="w-9 border border-border px-2 py-1.5 text-center font-normal text-muted-foreground/50">
              #
            </th>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap border border-border px-3 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, i) => (
            <tr key={start + i} className={cn("hover:bg-muted/40", i % 2 ? "bg-muted/10" : "")}>
              <td className="border border-border px-2 py-1.5 text-center text-muted-foreground/50 tabular-nums">
                {start + i + 1}
              </td>
              {row.map((cell, j) => {
                const isEmpty = cell == null || cell === "";
                // String cells stay clamped + truncated; rich cells (badges,
                // the interaction digest) size themselves and may wrap.
                const isNode = !isEmpty && typeof cell !== "string";
                return (
                  <td
                    key={j}
                    className={cn(
                      "border border-border px-3 py-1.5 align-top",
                      isNode ? "" : "max-w-[24rem] truncate",
                    )}
                  >
                    {isEmpty ? <span className="text-muted-foreground/40">—</span> : cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="flex shrink-0 items-center justify-between gap-3 px-1 pb-1">
      <div className="flex items-center gap-2.5">
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          aria-label="Rows per page"
          className="h-6 rounded-md border border-border bg-background px-1.5 text-muted-foreground text-xs outline-none hover:text-foreground focus:border-ring"
        >
          {SHEET_PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          aria-label="Previous page"
          disabled={current <= 1}
          onClick={() => setPage(current - 1)}
          className="grid size-6 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          ‹
        </button>
        <span className="grid h-6 min-w-6 place-items-center rounded-md bg-foreground px-1 font-medium text-background tabular-nums">
          {current}
        </span>
        <span className="text-muted-foreground tabular-nums">of {pages}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={current >= pages}
          onClick={() => setPage(current + 1)}
          className="grid size-6 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          ›
        </button>
      </div>
    </div>
    </div>
  );
}

// Per-tool connection metadata (consumed by the ops center): a logo tint, the
// data types synced into the data room, and the last refresh timestamp.
export const TOOL_META: Record<string, { color: string; synced: string[]; lastRefreshed: string }> = {
  "System of record": {
    color: "#64748b",
    // What it holds, in the profile's words: the records themselves, never the name of a file.
    synced: [W.Accounts, "People", "Workbook sheets"],
    lastRefreshed: "2026-07-10 09:12",
  },
  Salesforce: {
    color: "#00a1e0",
    synced: ["Accounts", "ARR & renewals", "Contacts & roles", "Opportunities"],
    lastRefreshed: "2026-07-10 08:58",
  },
  Gmail: {
    color: "#ea4335",
    synced: ["Email threads", "Follow-up drafts", "Attachments"],
    lastRefreshed: "2026-07-10 09:02",
  },
  Granola: {
    color: "#5b5bd6",
    synced: ["Meeting notes", "Attendees", "Action items"],
    lastRefreshed: "2026-07-10 08:10",
  },
  Slack: {
    color: "#611f69",
    synced: [`${W.Account} channels`, `${W.Account} DMs`, "Alerts"],
    lastRefreshed: "2026-07-10 09:06",
  },
  Vercel: {
    color: "#3b3b3b",
    synced: ["Deployments", "Build logs", "Runtime metrics", "Regions"],
    lastRefreshed: "2026-07-10 09:08",
  },
  GitHub: {
    color: "#444c56",
    synced: ["Releases", "Commits", "Pull requests", "Tags"],
    lastRefreshed: "2026-07-10 08:50",
  },
  Confluence: {
    color: "#2684ff",
    synced: ["Runbooks", "Solution docs", "Specs"],
    lastRefreshed: "2026-07-10 05:30",
  },
  "Eval runner": {
    color: "#16a34a",
    synced: ["Eval suites", "Run scores", "Datasets"],
    lastRefreshed: "2026-07-10 06:45",
  },
};

/** A wrapping, multi-line prose cell (for the interaction digest narrative). */
function DigestCell({ text }: { readonly text: string }) {
  return (
    <div className="max-w-[46rem] whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
      {text}
    </div>
  );
}

/** Colored badge for a ticket's canonical request category (colour from ticketCategoryTone). */
function TicketCategory({ value }: { readonly value?: string }) {
  if (!value) return <span className="text-muted-foreground/50">—</span>;
  const tone = value ? ticketCategoryTone(value) : "bg-muted text-muted-foreground";
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-xs", tone)}>{value}</span>
  );
}

function Health({ value }: { readonly value?: string }) {
  if (!value) return <span className="text-muted-foreground/50">—</span>;
  const tone =
    value === "healthy"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : value === "degraded" || value === "unknown"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-red-500/15 text-red-700 dark:text-red-400";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs capitalize", tone)}>{value}</span>;
}
