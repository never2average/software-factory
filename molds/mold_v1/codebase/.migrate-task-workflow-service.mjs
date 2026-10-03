/**
 * Additive, idempotent schema migration for the task-workflow microservice.
 *
 * It versions existing workflow definitions, creates a default task workflow
 * where an org has tasks but no definition, and pins every live existing task
 * to an immutable workflow version. No task fields are rewritten.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { migrationSsl } from "./scripts/lib/migration-ssl.mjs";

function readEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
        .map((line) => {
          const split = line.indexOf("=");
          return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const local = readEnv(".env.local");
const provider = readEnv(".env.supabase");
// The two env files first, as always. Then the environment, for a server that has neither file: the same admin
// variable scripts/migrate-production.mjs reads (never DATABASE_URL, which is the app's restricted role).
const adminUrl = provider.SUPABASE_POSTGRES_URL_NON_POOLING || local.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL_UNPOOLED;
if (!adminUrl) throw new Error("An admin database URL is required for the task-workflow migration");

// TLS is required unless DATABASE_SSL=disable names a Postgres on this machine (scripts/lib/migration-ssl.mjs).
const sql = postgres(adminUrl, { ssl: migrationSsl(adminUrl), prepare: false, max: 1 });
const [{ current_user: role }] = await sql`select current_user`;
console.log(`task-workflow migration connected as ${role}`);

await sql`alter table workflow_definitions add column if not exists current_version integer not null default 1`;
await sql`alter table workflow_definitions add column if not exists is_default boolean not null default false`;
await sql`alter table workflow_definitions add column if not exists archived_at timestamptz`;

await sql`
  create table if not exists project_workflow_versions (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    workflow_id text not null,
    version integer not null,
    name text not null,
    entity text not null,
    stages jsonb not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    unique (org_id, workflow_id, version)
  )`;
await sql`create index if not exists project_workflow_versions_workflow_idx
          on project_workflow_versions (workflow_id, created_at)`;

await sql`
  create table if not exists task_workflow_instances (
    task_id uuid primary key references todos(id) on delete cascade,
    org_id text not null,
    workflow_id text not null,
    workflow_version_id uuid not null,
    stage_id text not null,
    state text not null default 'active',
    automation_state text not null default 'idle',
    stage_entered_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
await sql`create index if not exists task_workflow_instances_org_stage_idx
          on task_workflow_instances (org_id, workflow_id, stage_id)`;
await sql`create index if not exists task_workflow_instances_version_idx
          on task_workflow_instances (workflow_version_id)`;

await sql`
  create table if not exists task_workflow_transition_events (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    task_id uuid not null,
    workflow_id text not null,
    workflow_version_id uuid not null,
    from_stage_id text,
    to_stage_id text not null,
    trigger text not null,
    actor text not null,
    reason text,
    idempotency_key text,
    created_at timestamptz not null default now()
  )`;
await sql`create index if not exists task_workflow_events_task_idx
          on task_workflow_transition_events (org_id, task_id, created_at)`;
await sql`create unique index if not exists task_workflow_events_idempotency_idx
          on task_workflow_transition_events (org_id, idempotency_key)`;

const defaultStages = [
  { id: "backlog", label: "Backlog", description: "Captured but not yet started.", assign: { type: "none" }, transitions: [{ to: "open", migrate: { type: "manual" } }] },
  { id: "open", label: "Open", description: "Ready to be picked up.", assign: { type: "least_loaded" }, transitions: [{ to: "in_progress", migrate: { type: "manual" } }] },
  { id: "in_progress", label: "In progress", description: "Actively being worked.", assign: { type: "none" }, transitions: [{ to: "blocked", migrate: { type: "manual" } }, { to: "done", migrate: { type: "manual" } }] },
  { id: "blocked", label: "Blocked", description: "Waiting on someone or something.", assign: { type: "none" }, transitions: [{ to: "in_progress", migrate: { type: "manual" } }] },
  { id: "done", label: "Done", description: "Completed and verified.", assign: { type: "none" }, transitions: [] },
];

await sql`
  insert into workflow_definitions
    (id, org_id, name, entity, stages, current_version, is_default, created_by)
  select 'pwf_default_' || md5(source.org_id), source.org_id,
         'Default task workflow', 'task', ${sql.json(defaultStages)}, 1, true,
         'task-workflow-migration'
    from (select distinct org_id from todos where org_id is not null) source
   where not exists (
     select 1 from workflow_definitions w
      where w.org_id = source.org_id and w.entity = 'task' and w.archived_at is null
   )
  on conflict (id) do nothing`;

// Select one deterministic default per org/entity before applying the partial
// unique index. Existing explicit defaults win; newest definition wins ties.
await sql`
  with ranked as (
    select id,
           row_number() over (
             partition by org_id, entity
             order by is_default desc, updated_at desc, created_at desc, id
           ) as position
      from workflow_definitions
     where archived_at is null
  )
  update workflow_definitions w
     set is_default = (ranked.position = 1)
    from ranked
   where w.id = ranked.id`;
await sql`create unique index if not exists workflow_definitions_one_default_idx
          on workflow_definitions (org_id, entity)
          where is_default = true and archived_at is null`;

const seededVersions = await sql`
  insert into project_workflow_versions
    (org_id, workflow_id, version, name, entity, stages, created_by, created_at)
  select org_id, id, current_version, name, entity, stages,
         coalesce(created_by, 'task-workflow-migration'), created_at
    from workflow_definitions
   where archived_at is null
  on conflict (org_id, workflow_id, version) do nothing
  returning id`;
console.log(`seeded ${seededVersions.length} immutable workflow version(s)`);

function key(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const definitions = await sql`
  select w.org_id, w.id, w.stages, v.id as version_id
    from workflow_definitions w
    join project_workflow_versions v
      on v.org_id = w.org_id and v.workflow_id = w.id and v.version = w.current_version
   where w.entity = 'task' and w.is_default = true and w.archived_at is null`;
let pinned = 0;
for (const definition of definitions) {
  const stages = Array.isArray(definition.stages) ? definition.stages : [];
  if (stages.length === 0) continue;
  const tasks = await sql`
    select t.id, t.status
      from todos t
     where t.org_id = ${definition.org_id} and t.archived_at is null
       and not exists (select 1 from task_workflow_instances i where i.task_id = t.id)`;
  for (const task of tasks) {
    const wanted = key(task.status);
    const stage = stages.find((candidate) => key(candidate.id) === wanted || key(candidate.label) === wanted)
      || (wanted === "done" ? stages.find((candidate) => !candidate.transitions?.length) : null)
      || stages[0];
    const terminal = !Array.isArray(stage.transitions) || stage.transitions.length === 0;
    await sql`
      insert into task_workflow_instances
        (task_id, org_id, workflow_id, workflow_version_id, stage_id, state, automation_state)
      values
        (${task.id}, ${definition.org_id}, ${definition.id}, ${definition.version_id}, ${stage.id},
         ${terminal ? "completed" : "active"}, 'idle')
      on conflict (task_id) do nothing`;
    await sql`
      insert into task_workflow_transition_events
        (org_id, task_id, workflow_id, workflow_version_id, from_stage_id, to_stage_id, trigger, actor, reason)
      select ${definition.org_id}, ${task.id}, ${definition.id}, ${definition.version_id}, null,
             ${stage.id}, 'migration', 'task-workflow-migration', 'Pinned existing task to workflow version'
       where not exists (
         select 1 from task_workflow_transition_events
          where task_id = ${task.id} and trigger = 'migration'
       )`;
    pinned += 1;
  }
}
console.log(`pinned ${pinned} existing live task(s)`);

const predicate = `(
  nullif(current_setting('app.org_id', true), '') IS NULL
  OR org_id = current_setting('app.org_id', true)
)`;
for (const table of ["project_workflow_versions", "task_workflow_instances", "task_workflow_transition_events"]) {
  await sql.unsafe(`alter table ${table} enable row level security`);
  await sql.unsafe(`alter table ${table} force row level security`);
  await sql.unsafe(`drop policy if exists org_isolation on ${table}`);
  await sql.unsafe(`create policy org_isolation on ${table} using ${predicate} with check ${predicate}`);
  await sql.unsafe(`grant select, insert, update, delete on ${table} to app_rw`);
}
await sql`grant select, insert, update, delete on workflow_definitions to app_rw`;

const [{ versions }] = await sql`select count(*)::int as versions from project_workflow_versions`;
const [{ instances }] = await sql`select count(*)::int as instances from task_workflow_instances`;
const [{ events }] = await sql`select count(*)::int as events from task_workflow_transition_events`;
console.log(`verified versions=${versions}, instances=${instances}, transition_events=${events}`);

// DATABASE_URL is deliberately the only runtime source in this repository.
// DATABASE_URL_APP_RW may be a retired provider URL left in a developer file.
const appUrl = local.DATABASE_URL;
if (appUrl) {
  const app = postgres(appUrl, { ssl: migrationSsl(appUrl), prepare: false, max: 1 });
  await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', 'org-onfinance', true)`;
    await tx`select 1 from project_workflow_versions limit 1`;
    await tx`select 1 from task_workflow_instances limit 1`;
    await tx`select 1 from task_workflow_transition_events limit 1`;
  });
  await app.end();
  console.log("verified app role access");
}

await sql.end();
console.log("task-workflow schema is ready");
