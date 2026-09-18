import { z } from "zod";

const qualifiers = {
  department: z.string().trim().min(1).max(120).optional(),
  guidance: z.string().trim().min(1).max(1000).optional(),
};

export const assignRuleSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none"), ...qualifiers }),
  z.strictObject({ type: z.literal("role"), value: z.string().trim().min(1).max(120), ...qualifiers }),
  z.strictObject({ type: z.literal("person"), value: z.string().email(), ...qualifiers }),
  z.strictObject({ type: z.literal("team"), value: z.string().trim().min(1).max(120), ...qualifiers }),
  z.strictObject({ type: z.literal("customer_owner"), ...qualifiers }),
  z.strictObject({ type: z.literal("least_loaded"), value: z.string().trim().min(1).max(120).optional(), ...qualifiers }),
  z.strictObject({ type: z.literal("prompt"), value: z.string().trim().min(1).max(2000), ...qualifiers }),
]);

export const migrateRuleSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("manual") }),
  z.strictObject({ type: z.literal("rule"), value: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal("prompt"), value: z.string().trim().min(1).max(2000) }),
]);

export const workflowStageSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  assign: assignRuleSchema,
  transitions: z.array(z.strictObject({ to: z.string().trim().min(1).max(120), migrate: migrateRuleSchema })),
});

export const workflowStagesSchema = z.array(workflowStageSchema).min(1).max(50).superRefine((stages, ctx) => {
  const ids = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (ids.has(stage.id)) {
      ctx.addIssue({ code: "custom", path: [index, "id"], message: `Duplicate stage id: ${stage.id}` });
    }
    ids.add(stage.id);
  }
  for (const [index, stage] of stages.entries()) {
    const targets = new Set<string>();
    for (const [transitionIndex, transition] of stage.transitions.entries()) {
      if (!ids.has(transition.to)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "transitions", transitionIndex, "to"],
          message: `Unknown target stage: ${transition.to}`,
        });
      }
      if (transition.to === stage.id) {
        ctx.addIssue({ code: "custom", path: [index, "transitions", transitionIndex, "to"], message: "A stage cannot transition to itself" });
      }
      if (targets.has(transition.to)) {
        ctx.addIssue({ code: "custom", path: [index, "transitions", transitionIndex, "to"], message: "Duplicate transition target" });
      }
      targets.add(transition.to);
    }
  }
});

export type AssignRule = z.infer<typeof assignRuleSchema>;
export type MigrateRule = z.infer<typeof migrateRuleSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;

export const definitionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  entity: z.enum(["task", "implementation"]),
  stages: workflowStagesSchema,
  isDefault: z.boolean().optional(),
});

export const definitionPatchSchema = definitionCreateSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
});

const containerType = z.enum(["deployment", "implementation"]);
const linkType = z.enum(["ticket", "customer", "app", "cron", "workflow", "chat"]);
const taskStatus = z.enum(["backlog", "open", "in_progress", "blocked", "done", "cancelled"]);

export const taskCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(4000).nullable().optional(),
  status: taskStatus.optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  containerType: containerType.nullable().optional(),
  containerId: z.string().nullable().optional(),
  containerLabel: z.string().nullable().optional(),
  linkType: linkType.nullable().optional(),
  linkId: z.string().nullable().optional(),
  linkLabel: z.string().nullable().optional(),
  assignee: z.string().email().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  createdBy: z.string().optional(),
});

export const taskPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().max(4000).nullable().optional(),
  done: z.boolean().optional(),
  status: taskStatus.optional(),
  stageId: z.string().trim().min(1).max(120).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  containerType: containerType.nullable().optional(),
  containerId: z.string().nullable().optional(),
  containerLabel: z.string().nullable().optional(),
  linkType: linkType.nullable().optional(),
  linkId: z.string().nullable().optional(),
  linkLabel: z.string().nullable().optional(),
  assignee: z.string().email().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  archived: z.boolean().optional(),
  actor: z.string().optional(),
  reason: z.string().max(2000).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskPatchInput = z.infer<typeof taskPatchSchema>;

export interface ServiceContext {
  orgId: string;
  actor: string;
  role: "owner" | "admin" | "engineer" | "member";
}

export interface WorkflowDefinitionRow {
  id: string;
  org_id: string;
  name: string;
  entity: "task" | "implementation";
  stages: WorkflowStage[];
  current_version: number;
  is_default: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}
