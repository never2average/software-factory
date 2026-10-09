import type postgres from "postgres";
import { definitionCreateSchema, workflowStagesSchema, type ServiceContext, type WorkflowDefinitionRow, type WorkflowStage } from "@/lib/types";

export interface DefinitionDto {
  id: string;
  name: string;
  entity: "task" | "implementation";
  stages: WorkflowStage[];
  currentVersion: number;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDefinitionDto(row: WorkflowDefinitionRow): DefinitionDto {
  return {
    id: row.id,
    name: row.name,
    entity: row.entity,
    stages: row.stages,
    currentVersion: row.current_version,
    isDefault: row.is_default,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listDefinitions(sql: postgres.TransactionSql, orgId: string): Promise<DefinitionDto[]> {
  const rows = await sql<WorkflowDefinitionRow[]>`
    select id, org_id, name, entity, stages, current_version, is_default,
           created_by, created_at, updated_at
      from workflow_definitions
     where org_id = ${orgId} and archived_at is null
     order by is_default desc, updated_at desc`;
  return rows.map(toDefinitionDto);
}

export async function createDefinition(
  sql: postgres.TransactionSql,
  ctx: ServiceContext,
  input: ReturnType<typeof definitionCreateSchema.parse>,
): Promise<DefinitionDto> {
  const id = `pwf_${crypto.randomUUID().replaceAll("-", "")}`;
  const [defaultRow] = await sql<{ present: boolean }[]>`
    select exists(
      select 1 from workflow_definitions
       where org_id = ${ctx.orgId} and entity = ${input.entity}
         and is_default = true and archived_at is null
    ) as present`;
  const isDefault = input.isDefault ?? !defaultRow?.present;
  if (isDefault) {
    await sql`update workflow_definitions set is_default = false, updated_at = now()
               where org_id = ${ctx.orgId} and entity = ${input.entity} and archived_at is null`;
  }
  const [row] = await sql<WorkflowDefinitionRow[]>`
    insert into workflow_definitions
      (id, org_id, name, entity, stages, current_version, is_default, created_by)
    values
      (${id}, ${ctx.orgId}, ${input.name}, ${input.entity}, ${sql.json(input.stages)}, 1, ${isDefault}, ${ctx.actor})
    returning id, org_id, name, entity, stages, current_version, is_default,
              created_by, created_at, updated_at`;
  if (!row) throw new Error("Invalid: Workflow definition was not created");
  await sql`
    insert into project_workflow_versions
      (org_id, workflow_id, version, name, entity, stages, created_by)
    values
      (${ctx.orgId}, ${id}, 1, ${input.name}, ${input.entity}, ${sql.json(input.stages)}, ${ctx.actor})`;
  return toDefinitionDto(row);
}

export async function updateDefinition(
  sql: postgres.TransactionSql,
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; entity?: "task" | "implementation"; stages?: WorkflowStage[]; isDefault?: boolean },
): Promise<DefinitionDto> {
  const [current] = await sql<WorkflowDefinitionRow[]>`
    select id, org_id, name, entity, stages, current_version, is_default,
           created_by, created_at, updated_at
      from workflow_definitions
     where id = ${id} and org_id = ${ctx.orgId} and archived_at is null
     for update`;
  if (!current) throw new Error("Not found: Workflow definition not found");
  const name = patch.name ?? current.name;
  const entity = patch.entity ?? current.entity;
  const stages = workflowStagesSchema.parse(patch.stages ?? current.stages);
  const isDefault = patch.isDefault ?? current.is_default;
  const version = current.current_version + 1;
  if (isDefault) {
    await sql`update workflow_definitions set is_default = false, updated_at = now()
               where org_id = ${ctx.orgId} and entity = ${entity} and id <> ${id} and archived_at is null`;
  }
  const [updated] = await sql<WorkflowDefinitionRow[]>`
    update workflow_definitions
       set name = ${name}, entity = ${entity}, stages = ${sql.json(stages)},
           current_version = ${version}, is_default = ${isDefault}, updated_at = now()
     where id = ${id} and org_id = ${ctx.orgId}
     returning id, org_id, name, entity, stages, current_version, is_default,
               created_by, created_at, updated_at`;
  if (!updated) throw new Error("Not found: Workflow definition not found");
  await sql`
    insert into project_workflow_versions
      (org_id, workflow_id, version, name, entity, stages, created_by)
    values
      (${ctx.orgId}, ${id}, ${version}, ${name}, ${entity}, ${sql.json(stages)}, ${ctx.actor})`;
  return toDefinitionDto(updated);
}

export async function archiveDefinition(sql: postgres.TransactionSql, ctx: ServiceContext, id: string): Promise<void> {
  const [row] = await sql<{ entity: string; is_default: boolean }[]>`
    update workflow_definitions
       set archived_at = now(), is_default = false, updated_at = now()
     where id = ${id} and org_id = ${ctx.orgId} and archived_at is null
     returning entity, is_default`;
  if (!row) throw new Error("Not found: Workflow definition not found");
  if (row.is_default) {
    await sql`
      update workflow_definitions set is_default = true, updated_at = now()
       where id = (
         select id from workflow_definitions
          where org_id = ${ctx.orgId} and entity = ${row.entity} and archived_at is null
          order by updated_at desc limit 1
       )`;
  }
}

export async function ensureVersion(
  sql: postgres.TransactionSql,
  definition: WorkflowDefinitionRow,
  actor: string,
): Promise<{ id: string; stages: WorkflowStage[] }> {
  await sql`
    insert into project_workflow_versions
      (org_id, workflow_id, version, name, entity, stages, created_by)
    values
      (${definition.org_id}, ${definition.id}, ${definition.current_version}, ${definition.name},
       ${definition.entity}, ${sql.json(definition.stages)}, ${actor})
    on conflict (org_id, workflow_id, version) do nothing`;
  const [version] = await sql<{ id: string; stages: WorkflowStage[] }[]>`
    select id, stages from project_workflow_versions
     where org_id = ${definition.org_id} and workflow_id = ${definition.id}
       and version = ${definition.current_version}
     limit 1`;
  if (!version) throw new Error("Conflict: Workflow version could not be resolved");
  return version;
}
