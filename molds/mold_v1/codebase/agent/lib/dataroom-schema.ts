// Zod contract for the dm.md data-room entities.
//
// dm.md at the repository root is the CANONICAL data model (seven domains:
// accounts, platform, deliveries, solutions, projects, tickets, people; each
// stored under the folder the deployment profile names, ./dataroom-folders.ts).
// docs/data-model.md is the derived sheet-packaging view.
//
// This module models the *artifact* layer of dm.md — the JSON/JSONL/Markdown
// records that live inside the domain folder trees. The flat sheet schemas in
// ./customer-schema.ts remain the sheet-projection layer and are re-used here
// where the artifact rows share the sheet grain (interactions, tickets).
//
// Layering: additive only. Nothing in customer-schema.ts changes; this file
// composes on top of it.

import { z } from "zod";
import { interactionSchema, ticketSchema } from "./customer-schema.ts";
import { fill } from "./agent-vocabulary.ts";
import { ROOT_FOLDERS } from "./dataroom-folders.ts";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Slug used for folder-addressable IDs across the data room. */
const slug = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a folder-safe slug");

/** The system of record's customer id (`customers.customer_id`), e.g. "acme-bank". */
export const customerIdSchema = slug;

/**
 * `platform_version_id` — the first-class key of the platform domain.
 * It partitions {folder:platform}/, {folder:deliveries}/{customer_id}/, {folder:solutions}/, and
 * {folder:people}/{person_id}/ subtrees (e.g. "2026.06.3").
 */
export const platformVersionIdSchema = slug.brand<"PlatformVersionId">();
export type PlatformVersionId = z.infer<typeof platformVersionIdSchema>;

export const personIdSchema = slug;
export const agentIdSchema = slug;
export const pipelineIdSchema = slug;
export const runIdSchema = slug;
export const personaIdSchema = slug;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * A JSON Schema *document* artifact (e.g. `run_configs.schema.json`,
 * `{folder:platform}/{v}/design_decisions/*.schemas.json`). Deliberately loose: the
 * document itself is the contract; here we only guarantee it is a JSON object
 * that self-identifies as a schema.
 */
export const jsonSchemaDocumentSchema = z
  .looseObject({
    $schema: z.string().optional(),
    $id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    properties: z.record(z.string(), jsonValueSchema).optional(),
    required: z.array(z.string()).optional(),
  })
  .refine(
    (doc) => doc.$schema !== undefined || doc.type !== undefined || doc.properties !== undefined,
    "JSON Schema document must declare $schema, type, or properties",
  );

const isoDateTime = z.string().min(1); // ISO-8601 timestamps, kept as strings like customer-schema.ts
const urlOrEmptySchema = z.string().url().or(z.literal(""));

/** Markdown artifact record (context.md, rationale.md, recipe.md, ...). */
export const markdownDocSchema = z.object({
  path: z.string().min(1),
  format: z.literal("markdown").default("markdown"),
  title: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().min(1),
  updatedAt: isoDateTime.optional(),
  updatedByEmail: z.string().email().optional(),
});

// ---------------------------------------------------------------------------
// Agreements ({folder:accounts}/{CustomerID}/agreements/, {folder:people}/{person_id}/agreements/)
// ---------------------------------------------------------------------------

export const agreementTypeSchema = z.enum([
  "NDA",
  "MSA",
  "DPA",
  "SOW",
  "Order Form",
  "BAA",
  "SLA",
  "Other",
]);

export const agreementStatusSchema = z.enum([
  "draft",
  "under_review",
  "executed",
  "expired",
  "terminated",
]);

export const agreementSchema = z
  .object({
    agreementId: slug,
    /** Which dm.md folder the binary lives under. */
    scope: z.enum(["customer", "person"]),
    customerId: customerIdSchema.optional(),
    personId: personIdSchema.optional(),
    agreementType: agreementTypeSchema,
    title: z.string().min(1),
    status: agreementStatusSchema,
    counterpartyLegalName: z.string().optional(),
    effectiveDate: z.string().optional(),
    expirationDate: z.string().optional(),
    signedByEmails: z.array(z.string().email()).optional(),
    fileName: z.string().min(1),
    /** Path under the data room, e.g. {folder:accounts}/acme-bank/agreements/msa.pdf */
    storagePath: z.string().min(1),
    uploadedByEmail: z.string().email().optional(),
    uploadedAt: isoDateTime.optional(),
    notes: z.string().optional(),
  })
  .refine(
    (a) => (a.scope === "customer" ? a.customerId !== undefined : a.personId !== undefined),
    fill("{account}-scoped agreements need customerId; person-scoped agreements need personId"),
  );

// ---------------------------------------------------------------------------
// Person domain ({folder:people}/{person_id}/)
// ---------------------------------------------------------------------------

/** {folder:people}/{person_id}/identity.json */
export const personIdentitySchema = z.object({
  personId: personIdSchema,
  kind: z.enum(["internal", "external"]),
  displayName: z.string().min(1),
  primaryEmail: z.string().email(),
  emails: z.array(z.string().email()).optional(),
  employerOrg: z.string().min(1),
  title: z.string().optional(),
  /** Customers this person is associated with (join through customer_id). */
  customerIds: z.array(customerIdSchema).optional(),
  /** External-system identity refs, e.g. { "slack": "U0123", "granola": "..." } */
  externalIds: z.record(z.string(), z.string()).optional(),
  linkedinUrl: urlOrEmptySchema.optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
  createdAt: isoDateTime.optional(),
  updatedAt: isoDateTime.optional(),
});

/**
 * One record of {folder:people}/{person_id}/interactions.jsonl. Same row shape as the
 * customer-level Interactions sheet, plus the person spine key.
 */
export const personInteractionRecordSchema = interactionSchema.extend({
  personId: personIdSchema,
  customerId: customerIdSchema.optional(),
});

/** {folder:people}/{person_id}/context.md */
export const personContextDocSchema = markdownDocSchema.extend({
  personId: personIdSchema,
});

/** {folder:people}/{person_id}/{platform_version_id}/ access + enablement record. */
export const personPlatformAccessRecordSchema = z.object({
  personId: personIdSchema,
  platformVersionId: platformVersionIdSchema,
  accessLevel: z.enum(["none", "viewer", "operator", "admin"]),
  enablementStatus: z.enum(["not_started", "invited", "onboarded", "certified", "revoked"]),
  grantedAt: isoDateTime.optional(),
  revokedAt: isoDateTime.optional(),
  grantedByEmail: z.string().email().optional(),
  notes: z.string().optional(),
});

/** The whole {folder:people}/{person_id}/ folder for one external person. */
export const personFolderSchema = z.object({
  personId: personIdSchema,
  identity: personIdentitySchema,
  context: personContextDocSchema.optional(),
  interactions: z.array(personInteractionRecordSchema),
  platformAccess: z.array(personPlatformAccessRecordSchema).optional(),
  agreements: z.array(agreementSchema).optional(),
});

// ---------------------------------------------------------------------------
// Pipeline / agent / recipe entities
// ---------------------------------------------------------------------------

export const pipelineTriggerSchema = z.object({
  type: z.enum(["manual", "schedule", "event", "webhook"]),
  /** Cron expression when type = "schedule". */
  schedule: z.string().optional(),
  /** Event name when type = "event". */
  event: z.string().optional(),
});

export const pipelineStepSchema = z.object({
  stepId: slug,
  name: z.string().min(1),
  kind: z.enum(["source", "transform", "llm", "tool", "branch", "human_review", "sink"]),
  /** Connector/tool/model this step uses, e.g. "connector:sharepoint". */
  uses: z.string().optional(),
  config: jsonObjectSchema.optional(),
  dependsOn: z.array(slug).optional(),
});

/**
 * pipeline_config.json — appears under {folder:deliveries}/.../platform/pipelines/,
 * {folder:solutions}/{v}/pipelines/, and {folder:projects}/{customer_id}/pipelines/.
 */
export const pipelineConfigSchema = z
  .object({
    pipelineId: pipelineIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    platformVersionId: platformVersionIdSchema,
    version: z.string().min(1),
    ownerEmail: z.string().email().optional(),
    trigger: pipelineTriggerSchema,
    steps: z.array(pipelineStepSchema).min(1),
    connectors: z.array(z.string()).optional(),
    /** Data-room path of the run_configs.schema.json contract for this pipeline. */
    runConfigsSchemaRef: z.string().optional(),
    /** Data-room path of the integromat.schema.json contract for this pipeline. */
    integromatSchemaRef: z.string().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .superRefine((config, ctx) => {
    const stepIds = new Set(config.steps.map((step) => step.stepId));
    if (stepIds.size !== config.steps.length) {
      ctx.addIssue({ code: "custom", message: "pipeline stepIds must be unique", path: ["steps"] });
    }
    config.steps.forEach((step, index) => {
      for (const dep of step.dependsOn ?? []) {
        if (!stepIds.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `step "${step.stepId}" dependsOn unknown step "${dep}"`,
            path: ["steps", index, "dependsOn"],
          });
        }
      }
    });
  });

/**
 * private.integromat.json — private integration credentials that sit next to
 * a pipeline_config.json. Never published via publish_artifact.
 */
export const privateIntegromatConfigSchema = z.looseObject({
  pipelineId: pipelineIdSchema.optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
});

/** run_configs.schema.json — a JSON Schema document contract for run configs. */
export const runConfigsSchemaDocumentSchema = jsonSchemaDocumentSchema;

/** One seed file inside a recipe/ folder. */
export const recipeFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
  contentType: z.string().optional(),
});

/**
 * Recipe — recipe.md + recipe/ seed folder for an agent
 * ({folder:solutions}/{v}/agents/{agent_id}/, and the seed workspaces under
 * {folder:deliveries}/.../platform/agents/{agent_id}/ and
 * {folder:projects}/{customer_id}/agents/{agent_id}/).
 */
export const recipeSchema = z.object({
  agentId: agentIdSchema,
  platformVersionId: platformVersionIdSchema,
  title: z.string().min(1),
  /** Body of recipe.md. */
  instructions: z.string().min(1),
  seedFiles: z.array(recipeFileSchema).optional(),
  requiredConnectors: z.array(z.string()).optional(),
  requiredTools: z.array(z.string()).optional(),
  version: z.string().optional(),
  updatedAt: isoDateTime.optional(),
});

// ---------------------------------------------------------------------------
// Eval-run artifacts ({folder:solutions}/{v}/{agents|pipelines}/{id}/evals/)
// ---------------------------------------------------------------------------

/** One row of evals/dataset.jsonl. */
export const evalDatasetRecordSchema = z.object({
  caseId: slug,
  input: jsonValueSchema,
  expected: jsonValueSchema.optional(),
  reference: z.string().optional(),
  tags: z.array(z.string()).optional(),
  weight: z.number().positive().optional(),
  createdAt: isoDateTime.optional(),
});

/** One row of evals/benchmark.jsonl — a metric gate the run must clear. */
export const evalBenchmarkRecordSchema = z.object({
  metric: z.string().min(1),
  threshold: z.number(),
  comparison: z.enum(["gte", "gt", "lte", "lt", "eq"]),
  baseline: z.number().optional(),
  /** Restrict the gate to a subset of dataset cases by tag. */
  appliesToTags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

/** The eval target: which agent or pipeline this run exercises. */
export const evalTargetSchema = z
  .object({
    kind: z.enum(["agent", "pipeline"]),
    agentId: agentIdSchema.optional(),
    pipelineId: pipelineIdSchema.optional(),
    platformVersionId: platformVersionIdSchema,
  })
  .refine(
    (t) => (t.kind === "agent" ? t.agentId !== undefined : t.pipelineId !== undefined),
    "agent targets need agentId; pipeline targets need pipelineId",
  );

/** evals/{run_id}/run_configs.json. */
export const evalRunConfigSchema = z.object({
  runId: runIdSchema,
  target: evalTargetSchema,
  model: z.string().optional(),
  modelParams: jsonObjectSchema.optional(),
  /** Values conforming to the target's run_configs.schema.json contract. */
  runConfig: jsonObjectSchema.optional(),
  datasetRef: z.string().optional(),
  benchmarkRef: z.string().optional(),
  gitSha: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  initiatedByEmail: z.string().email().optional(),
  startedAt: isoDateTime.optional(),
  completedAt: isoDateTime.optional(),
});

/** One row of evals/{run_id}/output.jsonl. */
export const evalOutputRecordSchema = z.object({
  runId: runIdSchema,
  caseId: slug,
  output: jsonValueSchema,
  scores: z.record(z.string(), z.number()).optional(),
  pass: z.boolean().optional(),
  gradedBy: z.enum(["exact_match", "heuristic", "llm_judge", "human"]).optional(),
  latencyMs: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/** One row of evals/{run_id}/trace.jsonl. */
export const evalTraceRecordSchema = z.object({
  runId: runIdSchema,
  traceId: z.string().min(1),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  caseId: slug.optional(),
  at: isoDateTime,
  eventType: z.enum([
    "run_start",
    "run_end",
    "case_start",
    "case_end",
    "llm_call",
    "tool_call",
    "retrieval",
    "guardrail",
    "error",
    "log",
  ]),
  name: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  payload: jsonValueSchema.optional(),
});

/** A whole evals/{run_id}/ folder: run_configs.json + output.jsonl + trace.jsonl. */
export const evalRunSchema = z
  .object({
    config: evalRunConfigSchema,
    outputs: z.array(evalOutputRecordSchema),
    traces: z.array(evalTraceRecordSchema),
  })
  .superRefine((run, ctx) => {
    run.outputs.forEach((output, index) => {
      if (output.runId !== run.config.runId) {
        ctx.addIssue({
          code: "custom",
          message: `output runId "${output.runId}" does not match run "${run.config.runId}"`,
          path: ["outputs", index, "runId"],
        });
      }
    });
    run.traces.forEach((trace, index) => {
      if (trace.runId !== run.config.runId) {
        ctx.addIssue({
          code: "custom",
          message: `trace runId "${trace.runId}" does not match run "${run.config.runId}"`,
          path: ["traces", index, "runId"],
        });
      }
    });
  });

// ---------------------------------------------------------------------------
// Deployment signoff records
// ({folder:deliveries}/{customer_id}/{platform_version_id}/infrastructure/*/signoff/)
// ---------------------------------------------------------------------------

/** The four signoff parties, matching the signoff/ file names in dm.md. */
export const signoffRoleSchema = z.enum([
  "internal",
  "customer.infra",
  "customer.infosec",
  "customer.cloudvendor",
]);
export type SignoffRole = z.infer<typeof signoffRoleSchema>;

export const signoffStatusSchema = z.enum([
  "not_requested",
  "requested",
  "in_review",
  "approved",
  "rejected",
  "waived",
]);
export type SignoffStatus = z.infer<typeof signoffStatusSchema>;

export const infrastructureComponentSchema = z.enum([
  "network",
  "compute",
  "storage",
  "inference",
  "agents",
  "database",
  "observability",
  "autoscale",
]);

/** One signoff/{role}.md record, parsed to structured form. */
export const deploymentSignoffRecordSchema = z
  .object({
    customerId: customerIdSchema,
    platformVersionId: platformVersionIdSchema,
    component: infrastructureComponentSchema,
    role: signoffRoleSchema,
    status: signoffStatusSchema,
    approverName: z.string().optional(),
    approverEmail: z.string().email().optional(),
    approverOrg: z.string().optional(),
    requestedAt: isoDateTime.optional(),
    decidedAt: isoDateTime.optional(),
    expiresAt: isoDateTime.optional(),
    /** Data-room path of the markdown record, e.g. .../signoff/internal.md */
    documentPath: z.string().min(1),
    evidenceUrl: urlOrEmptySchema.optional(),
    conditions: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .refine(
    (record) =>
      record.status !== "approved" && record.status !== "rejected"
        ? true
        : record.decidedAt !== undefined && record.approverEmail !== undefined,
    "approved/rejected signoffs must carry decidedAt and approverEmail",
  );

/** The signoff/ folder for one infrastructure component of one deployment. */
export const signoffChainSchema = z
  .object({
    customerId: customerIdSchema,
    platformVersionId: platformVersionIdSchema,
    component: infrastructureComponentSchema,
    records: z.array(deploymentSignoffRecordSchema).min(1),
  })
  .superRefine((chain, ctx) => {
    const seen = new Set<SignoffRole>();
    chain.records.forEach((record, index) => {
      if (seen.has(record.role)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate signoff record for role "${record.role}"`,
          path: ["records", index, "role"],
        });
      }
      seen.add(record.role);
      if (record.customerId !== chain.customerId) {
        ctx.addIssue({
          code: "custom",
          message: "signoff record customerId does not match chain",
          path: ["records", index, "customerId"],
        });
      }
      if (record.platformVersionId !== chain.platformVersionId) {
        ctx.addIssue({
          code: "custom",
          message: "signoff record platformVersionId does not match chain",
          path: ["records", index, "platformVersionId"],
        });
      }
      if (record.component !== chain.component) {
        ctx.addIssue({
          code: "custom",
          message: "signoff record component does not match chain",
          path: ["records", index, "component"],
        });
      }
    });
  });

/** True once every one of the four parties has approved (or been waived). */
export function isSignoffChainComplete(chain: z.infer<typeof signoffChainSchema>): boolean {
  const byRole = new Map(chain.records.map((record) => [record.role, record.status]));
  return signoffRoleSchema.options.every((role) => {
    const status = byRole.get(role);
    return status === "approved" || status === "waived";
  });
}

// ---------------------------------------------------------------------------
// Domain folder composites — one per dm.md top-level domain
// ---------------------------------------------------------------------------

/**
 * A top-level folder of the data room, by its STORED name: the seven domains' folders, then the folder files a
 * signed-in user attaches through the chat are filed under (by their own identity; an internal scratch/inbox, not
 * the external people tree). The names are the deployment profile's (./dataroom-folders.ts), never spelled here.
 */
export const dataroomDomainSchema = z.enum(ROOT_FOLDERS as [string, ...string[]]);
export type DataroomDomain = z.infer<typeof dataroomDomainSchema>;

/**
 * One customer-persona record. Lives as jsonl lines in two places:
 * `{folder:accounts}/{customer_id}/personas.jsonl` — the archetypes at that customer —
 * and `{folder:solutions}/{platform_version_id}/supported.personas.jsonl` — the personas
 * a solution version supports (recipes cite persona_ids). Personas are
 * archetypes, NOT real people: real humans live in {folder:people}/ (and in
 * background_research/{person_id}/ on a pipeline).
 */
export const personaSchema = z.object({
  personaId: personaIdSchema,
  name: z.string().min(1),
  /** e.g. "compliance officer", "relationship manager", "ops analyst". */
  role: z.string().min(1),
  /** Market segment / vertical, e.g. "NBFC", "AMC", "private bank". */
  segment: z.string().optional(),
  seniority: z.enum(["ic", "manager", "executive"]).optional(),
  goals: z.array(z.string()).default([]),
  painPoints: z.array(z.string()).default([]),
  jobsToBeDone: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
  /** The solution surfaces this persona touches. */
  servedByAgentIds: z.array(agentIdSchema).optional(),
  servedByPipelineIds: z.array(pipelineIdSchema).optional(),
  notes: z.string().optional(),
});
export type Persona = z.infer<typeof personaSchema>;

/** {folder:accounts}/{CustomerID}/ — interactions.jsonl + context.md + personas.jsonl + agreements/. */
export const customerFolderSchema = z.object({
  customerId: customerIdSchema,
  interactions: z.array(interactionSchema),
  context: markdownDocSchema.optional(),
  personas: z.array(personaSchema).optional(),
  agreements: z.array(agreementSchema).optional(),
});

/** {folder:platform}/{platform_version_id}/ release folder. */
export const platformVersionFolderSchema = z.object({
  platformVersionId: platformVersionIdSchema,
  changelogs: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** e.g. {folder:platform}/2026.06.3/2026-06-14_changelog_manager.md */
        path: z.string().min(1),
        title: z.string().optional(),
      }),
    )
    .optional(),
  designDecisions: z
    .object({
      tenancy: jsonSchemaDocumentSchema.optional(),
      organization: jsonSchemaDocumentSchema.optional(),
      dataplatform: jsonSchemaDocumentSchema.optional(),
      agents: jsonSchemaDocumentSchema.optional(),
      pipelineConfig: jsonSchemaDocumentSchema.optional(),
      integromat: jsonSchemaDocumentSchema.optional(),
    })
    .optional(),
  helmVariants: z.array(z.string()).optional(),
  terraformVariants: z.array(z.string()).optional(),
  securityArtifacts: z.array(z.string()).optional(),
});

/** {folder:deliveries}/{customer_id}/{platform_version_id}/ workspace. */
export const deploymentFolderSchema = z.object({
  customerId: customerIdSchema,
  platformVersionId: platformVersionIdSchema,
  infrastructure: z
    .object({
      inference: z
        .object({
          customizationsPath: z.string().optional(),
          rationale: markdownDocSchema.optional(),
          signoffs: signoffChainSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  platform: z
    .object({
      organization: jsonObjectSchema.optional(),
      dataplatform: jsonObjectSchema.optional(),
      agents: z.array(recipeSchema).optional(),
      pipelines: z
        .array(
          z.object({
            pipelineId: pipelineIdSchema,
            pipelineConfig: pipelineConfigSchema,
            privateIntegromat: privateIntegromatConfigSchema.optional(),
          }),
        )
        .optional(),
      integromat: jsonObjectSchema.optional(),
    })
    .optional(),
});

/** {folder:solutions}/{platform_version_id}/agents/{agent_id}/ folder. */
export const solutionAgentFolderSchema = z.object({
  platformVersionId: platformVersionIdSchema,
  agentId: agentIdSchema,
  recipe: recipeSchema,
  runConfigsSchema: runConfigsSchemaDocumentSchema.optional(),
  dataplatformSchema: jsonSchemaDocumentSchema.optional(),
  evals: z
    .object({
      dataset: z.array(evalDatasetRecordSchema),
      benchmark: z.array(evalBenchmarkRecordSchema).optional(),
      runs: z.array(evalRunSchema),
    })
    .optional(),
});

/** {folder:solutions}/{platform_version_id}/pipelines/{pipeline_id}/ folder. */
export const solutionPipelineFolderSchema = z.object({
  platformVersionId: platformVersionIdSchema,
  pipelineId: pipelineIdSchema,
  pipelineConfig: pipelineConfigSchema,
  runConfigsSchema: runConfigsSchemaDocumentSchema.optional(),
  integromatSchema: jsonSchemaDocumentSchema.optional(),
  evals: z
    .object({
      runs: z.array(evalRunSchema),
    })
    .optional(),
  backgroundResearch: z
    .array(
      z.object({
        personId: personIdSchema,
        context: personContextDocSchema.optional(),
        interactions: z.array(personInteractionRecordSchema).optional(),
      }),
    )
    .optional(),
});

/** {folder:projects}/{customer_id}/ workspace. */
export const implementationFolderSchema = z.object({
  customerId: customerIdSchema,
  agents: z.array(recipeSchema).optional(),
  pipelines: z
    .array(
      z.object({
        pipelineId: pipelineIdSchema,
        pipelineConfig: pipelineConfigSchema,
        privateIntegromat: privateIntegromatConfigSchema.optional(),
      }),
    )
    .optional(),
  integromat: jsonObjectSchema.optional(),
  evals: z
    .object({
      agents: z.array(evalRunSchema).optional(),
      pipelines: z.array(evalRunSchema).optional(),
    })
    .optional(),
});

/** The nine storage partitions under {folder:tickets}/ (see docs/data-model.md). */
export const ticketFolderSchema = z.enum([
  "feat",
  "search",
  "bug",
  "docs",
  "evals",
  "config_changes",
  "data_migration",
  "backfills",
  "onboarding",
]);
export type TicketFolder = z.infer<typeof ticketFolderSchema>;

/** {folder:tickets}/{folder}/{customer_id}/{platform_id}/tickets_{id}.jsonl */
export const ticketFileSchema = z.object({
  folder: ticketFolderSchema,
  customerId: customerIdSchema,
  platformVersionId: platformVersionIdSchema,
  fileName: z
    .string()
    .regex(/^tickets_[A-Za-z0-9._-]+\.jsonl$/, "must look like tickets_{id}.jsonl"),
  /** Rows conform to the sheet-projection ticketSchema. */
  tickets: z.array(ticketSchema).min(1),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Agreement = z.infer<typeof agreementSchema>;
export type CustomerFolder = z.infer<typeof customerFolderSchema>;
export type DeploymentFolder = z.infer<typeof deploymentFolderSchema>;
export type DeploymentSignoffRecord = z.infer<typeof deploymentSignoffRecordSchema>;
export type EvalBenchmarkRecord = z.infer<typeof evalBenchmarkRecordSchema>;
export type EvalDatasetRecord = z.infer<typeof evalDatasetRecordSchema>;
export type EvalOutputRecord = z.infer<typeof evalOutputRecordSchema>;
export type EvalRun = z.infer<typeof evalRunSchema>;
export type EvalRunConfig = z.infer<typeof evalRunConfigSchema>;
export type EvalTraceRecord = z.infer<typeof evalTraceRecordSchema>;
export type ImplementationFolder = z.infer<typeof implementationFolderSchema>;
export type MarkdownDoc = z.infer<typeof markdownDocSchema>;
export type PersonFolder = z.infer<typeof personFolderSchema>;
export type PersonIdentity = z.infer<typeof personIdentitySchema>;
export type PersonInteractionRecord = z.infer<typeof personInteractionRecordSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PlatformVersionFolder = z.infer<typeof platformVersionFolderSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type SignoffChain = z.infer<typeof signoffChainSchema>;
export type SolutionAgentFolder = z.infer<typeof solutionAgentFolderSchema>;
export type SolutionPipelineFolder = z.infer<typeof solutionPipelineFolderSchema>;
export type TicketFile = z.infer<typeof ticketFileSchema>;
