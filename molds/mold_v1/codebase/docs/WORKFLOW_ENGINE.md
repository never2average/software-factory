# The workflow engine (vendored)

## What it is

A declarative workflow engine, carried in base code as a library: `lib/workflow-engine/`. It lives under the
repository's `lib/`, not `agent/lib/`: eve's build discovers every file under `agent/` and refuses anything that is not
an authored module (the DSL's `spec.json` and `UPSTREAM.json` are JSON), and agent code already imports from `lib/`
when it needs to (phase 5 does the same). A workflow is a JSON
document in its DSL (`dsl/spec.json`, a JSON Schema Draft 2020-12 contract, plus the semantic checks in
`dsl/validate.ts`): an `init` half (which records it applies to, its steps, who holds each, due dates, comment and
evidence demands, the allowed state transitions, when it is finished) and a `diff` half (ordered rules that react to a
step's change: open the next step, send work back, wait for a quorum or for other records, queue an email or an agent).
The core is pure TypeScript over plain objects: materialize an instance (`core/init.ts`), run the rules on a change
(`core/diff.ts`), match queries (`core/mongo.ts`), balance assignment (`core/balancer.ts`), check role scopes and the
reporting matrix (`core/rbac.ts`), draw the process (`core/diagram.ts`).

The engine is the upstream workflow engine, vendored. The mold's record lifecycles become engine-configurable on top of
it, over the mold's own Postgres records: no separate service, no other database.

**Phases 1 to 4 changed no runtime behaviour; phase 5 runs the engine on record moves, and only where a profile asks.**
The build checks a profile's workflows (phase 2: `scripts/lib/record-workflows.mjs`, the DSL's validator and
`spec.json`), the Postgres store (phase 3: `lib/record-workflow-store.ts`) holds the instances, and the record write
path (phase 5, "Runtime" below) runs them. ONE module of the app imports the engine, `lib/record-workflow-runtime.ts`;
everything else reaches it through it. `npm run test:workflow-engine` fails if anything outside its own glue (the step
rules, the runtime, their tests, the sync, the build's check, the store and its tests) names it, and
`npm run test:record-workflow-store` fails if anything but its tests and the write path (`lib/record-workflow-moves.ts`)
imports the store. A profile that binds no workflow (the default) never reaches either: every write is byte for byte
what it was. What follows, each its own change:

| Phase | What |
|---|---|
| 1 | the engine core as a library, its step rules, tests, the sync (this) |
| 2 | the deployment profile's schema for workflows: `records.workflows`, a lifecycle's `workflow`, each move's `step`, `workflow_states`, checked at build (docs/DEPLOYMENT_PROFILE.md "records.workflows"); email and agent actions and prompt branches refused until a later phase |
| 3 | Postgres persistence: `record_workflow_instances` (with each instance's pinned definition) and `record_workflow_events`, with row-level security, and the store over them (see "Storage" below) |
| 4 | people data: the directory, roles and reporting lines from the mold's own records |
| 5 | runtime wiring: attaching a workflow to a record, a person's change through the step rules (this; "Runtime" below) |
| 6 | step actions: the emails and agent runs the rules queue |
| 7 | surfaces: the screens and the agent's tools |
| 8 | a pilot on one pack |

## Storage

Phase 3 (`drizzle/0047_record_workflows.sql`, `agent/lib/db/schema.ts`, `lib/record-workflow-store.ts`). Two
per-workspace tables, each with row-level security ENABLED and FORCED and the `org_isolation` policy on `app.org_id`
(created by the migration in the production, fail-closed form: no workspace named, no rows):

- `record_workflow_instances`: one row per workflow running on one record (`entity_type`, the area; `entity_id`, the
  record), unique on `(org_id, entity_type, entity_id, workflow_id)`. It holds the engine's state (`steps`,
  `fired_once`, `terminal`, and the rest of the instance in `engine_state`), the **pinned** copy of the workflow
  document it was made from (`definition`) and its `definition_hash` (sha256 over canonical JSON), so a later build that
  changes the profile's document never changes a running instance's rules, and a `revision`. The record's own values
  are never copied here; the caller puts them on the instance before running the engine (`withRecordData`).
- `record_workflow_events`: the instance's history, one row per engine `HistoryEvent`, read back in the order it was
  appended (an identity id), indexed on `(org_id, instance_id, at)`. It is an audit trail: app_rw may only SELECT and
  INSERT (the migration revokes UPDATE and DELETE, and both bootstraps take them back again after their grant on all
  tables: `scripts/lib/append-only-tables.mjs`). Its foreign key carries the workspace, so an event can only hang off
  an instance of its own workspace, and it RESTRICTS: an instance with a history cannot be deleted.

**Instances outlive their record.** Deleting or archiving a record leaves its workflow instances and their history in
place; phase 5 marks an instance terminal or detached, never deletes it.

**An instance runs on its pinned definition.** Its `definition_version` is keyed by the pinned document's hash
(`definitionVersionOf`: the first 48 bits, plus one), so every document a workflow ever ran under has its own version
with no counter to race on, and an update never changes it. The engine's `getWorkflowVersion(id,
instance.definition_version)` answers it with the pinned copy, while `getWorkflow(id)` is the deployment's current
document (what a new instance is pinned to).

`RecordWorkflowStore` implements the engine's `WorkflowStore` interface for one workspace, on the handle of the
caller's workspace-scoped transaction (`withOrgRls`, `withOrgDb`): it checks once that the transaction's `app.org_id`
is its workspace and refuses otherwise, and names the workspace in every statement. Its own API: `create(instance,
definition)`, `get(id)`, `getByEntity(type, id, workflow)`, `listByEntity`, `getDefinition` (the pinned copy),
`update(instance)` (compare-and-swap on `instance.revision`, appending the history events after the stored ones; an
instance carrying less history than is stored, such as a list's summary, is refused before anything is written),
`appendEvent` (moves the revision on; `updated_at` never moves backwards) and `listEvents`. A stale revision, a
missing instance, a second attachment of a workflow to a record or a history mismatch is a `RecordWorkflowConflict`
(the engine's `PersistenceConflictError`, `status` 409):
returned by `create` / `update`, thrown by the engine's `saveInstance`; nothing is written, and no statement fails, so
the caller's transaction stays usable. Definitions come only from the build (`definitions`, the profile's
`records.workflows`): registering or changing one throws, as do storing an identity snapshot, callbacks and job leases,
which this phase does not carry. `getIdentitySnapshot` answers undefined: the directory is the workspace's people data
(phase 4), handed to the engine by the write path (phase 5). `reassignObjectScope` matches nothing: the record holds its
own fields. Tests: `npm run test:record-workflow-store` (offline, the statements it sends)
and `npm run test:record-workflow-store-db` (a real Postgres, as app_rw, two workspaces, fail-closed).

## Runtime

Phase 5. A record area whose lifecycle names a `workflow` (docs/DEPLOYMENT_PROFILE.md "records.workflows") runs one
engine instance per record, on the record's own moves. The pieces:

| File | What it is |
|---|---|
| `lib/record-workflows.generated.ts` | `RECORD_WORKFLOWS`: the documents a lifecycle names, emitted by the profile generator (`{}` by default). |
| `lib/record-workflow-runtime.ts` | The pure half, and the one module that imports the engine: the binding, the directory, seeding an instance, the step rules as checkMove's gate, the step change. |
| `lib/record-workflow-moves.ts` | The half that reads and writes, on the caller's workspace-scoped transaction: `openRecordWorkflow` before the validator, `commitRecordWorkflow` after the record is written, `workflowRefusal` for the 409. |
| `lib/record-workflow-server.ts` | The tasks' ops routes: the task-workflow service writes a task; a reserved move settled by the task's actual state keeps the two together. |
| `agent/lib/record-lifecycle.ts` | `WorkflowGate`, and checkMove asking it about every transition that names a `step` (no engine import). |

**One key per record.** An instance is stored under the record's own server-derived key (`workflowRecordKey`):
a task's and a period's `id`, an implementation's `implementation_id`, a deployment's account and id. Nothing a request
names is used for it (an `entityId` in a body is ignored by a bound area's routes, which also read four eyes from the
record's own feed id), so every door reaches the same single instance.

**Where the engine is called, and the transaction.** Every door that writes a record of a bound area in this database
does, in ONE workspace-scoped transaction (`withOrgRls` / `withOrgDb`): take the record's workflow lock
(`pg_advisory_xact_lock` on its key) and only then read the record (`lockedRead`), so the move is checked from the state
the record is in now and a second mover waits; `openRecordWorkflow` (reads the instance or seeds one in memory, the
workspace's people for the directory); the validator with the step rules; the record write and its feed lines;
`commitRecordWorkflow` (attaches or saves the instance through `RecordWorkflowStore`, compare-and-swap on the revision
read). A stale revision throws `RecordWorkflowConflict` out of the transaction, so the record write rolls back with it
and the door answers 409 (`code: "workflow_conflict"`). The doors:

- deployments and implementations: `lib/record-area-routes.ts` (`boundUpsert`, `boundPatch`; the unbound routes are
  untouched) and the agent's `upsert_<area>` (`agent/lib/record-area-tools.ts`);
- periods: `agent/lib/period-area-store.ts` `writeDeclaredPeriod` (the cycles routes and `upsert_cycle`);
- `upsert_customer`'s nested rows: a nested MOVE of a bound area is refused before anything is written (its several
  writes are not one transaction); a nested create is attached on its first move.

**A record written by another service (tasks).** The task-workflow service writes a task, outside this database. No
connection and no lock is held across its call; the record and its instance are kept together by a reserved move
(`lib/record-workflow-server.ts` for the todos routes, `upsert_todo` in `agent/lib/todo-tools.ts`):

1. a short transaction: the lock, the task as it is now and what its lifecycle reads, the instance and the step rules;
   then the checks with nothing held (a refusal reaches nothing);
2. a short transaction (`reserveRecordMove`): under the lock the task and its instance must still be what (1) read (else
   409, nothing written); the move is recorded on the instance as pending (`record_move`: id, from, to, step, comment,
   evidence) and saved;
3. the service's write, with nothing held and a time limit (`RECORD_WORKFLOW_SERVICE_TIMEOUT_MS`, 30 s by default);
4. a short transaction (`settleReservedMove`): the task's ACTUAL state settles the reservation: it reached the target →
   the step changes as checked; it stayed → released. So a refusal, a failure or a timeout never leaves the two apart,
   and the answer says what happened (a late write: 502 with `moved: true`; a refusal: the service's own answer).
   If (4) itself fails, the answer says the task moved and its step follows (`workflow_note`); the reservation stays,
   a second mover is answered 409 `workflow_busy`, and once it is older than two minutes the next read settles it the
   same way. A new task's instance is attached in its own short transaction once the service made it (or, failing
   that, on its first move, and the answer says so).

**A record moved without the engine** (a period's rollover, a system move): the instance remembers the record state
it was last brought in line with (`record_state`); when the record is found elsewhere, the steps `workflow_states`
lists for its state are re-synced first, as `provisioning` history rows, so a stale step never refuses a move.

**Binding.** An instance is attached when a record is created, or on its first move after the binding (a record that
existed before). Its steps are seeded from `lifecycle.workflow_states` for the record's state as the rules read it (under
whichever key the row holds it, a legacy spelling as the state it stands for): each listed step starts in its state
through the engine's migrated-step support (a template whose state starts `completed`, `completed_at` the time the
activity feed shows the record entering that state, else the record's own last change), as `provisioning` history rows, never a
`state_changed` row. A record the workflow's `init.condition` does not take gets none. Instances are pinned to the
document they were made from.

**Moves.** A transition with `step: {id, state}` changes that step. Before the write the step rules are checkMove's
own: `not_holder` (the caller may not act on the step: only its holders, the workspace's owners and admins, and a
holder's supervisor), `step_inactive` (the step is not open yet), `step_transition` (the workflow's `init.transitions`),
`step_comment` and `step_evidence` (the step's demands; the comment is the move's `reason`, the evidence the request's
`evidence`, accepted only by a bound area's ops routes). Each is a broken rule with a sentence in the profile's words,
naming who holds the step. After the write the change is made as upstream's step route makes it
(`lib/workflow-step-rules.ts`): the comment and evidence, the change and its history rows, a hand-placed holder kept,
re-resolution on entry, the workflow's own rules (`runDiff`), the finish (`terminal_when`).

**Enforcement.** `strict`: a broken step rule refuses the move like any lifecycle rule (409, `code:
"lifecycle_refused"`, every broken rule and the moves there are, each marked `held_by` when someone else holds its
step: by their name on the roster, their email only for an owner or an admin); nothing is written. `warn`: the move goes through; its warning and the feed's line name the step rule; the step
changes as an ADMINISTRATIVE change when a STEP rule was broken (`step_patched` with `administrative: true` and those
rules only, its `state_changed` marked so), and the workflow's own rules still run. `off`: the engine is never called, nothing is read, `evidence` is no
field.

**The directory.** `agent/lib/people-directory.ts` `identitySnapshot`, from the rows of `people_roster` and
`org_members` read in the write's transaction: owner and admin may do everything (`All`), engineers and members act on
what they hold or created and on what their reportees hold (supervisors by `manager_email`).

**Not in this phase.** Email and agent actions are refused at build and, defensively, at run (`RecordWorkflowRefused`):
ticket 281 turns them into notifications and assistant tasks. Rules guarded on other records (cohorts) do not run.
Changing a step's holder or due date has no door yet (the step rules for both are in `lib/workflow-step-rules.ts`; the
surfaces are ticket 282). The agent's tools take a move's
comment but no evidence. `describeMoves` says which step a move changes and that only whoever holds it may make it;
the full screens are ticket 282.

Tests: `npm run test:record-workflow-runtime` (offline) and `npm run test:record-workflow-runtime-db` (the real routes
and tools, as app_rw, fail-closed, two workspaces: strict, warn and off), on the neutral fixture
`scripts/fixtures/record-workflows/review.json`.

## Where it came from

`lib/workflow-engine/UPSTREAM.json` `source` records a neutral label ("the operator's workflow-engine
monorepo"), the engine's path inside that repository and the pinned commit, with every vendored file's sha256 as
upstream has it and as vendored, and every local patch. Each vendored file's first line points there.

**The repository's address is not in this repository.** Like the mold's own source address, it lives on the operator's
machine (the factory's machine-local settings, never committed). The sync is told where a checkout is, either with
`--from <dir>` or with the `WORKFLOW_ENGINE_SOURCE` environment variable; nothing in the tree names the repository, its
owner or its address.

## What is vendored, and what is not

Vendored (exactly the list in `scripts/sync-workflow-engine.mjs`, `FILES`):

- `dsl/spec.json`, `dsl/types.ts`, `dsl/validate.ts`
- `engine/src/core/`: `mongo.ts`, `init.ts`, `diff.ts`, `state.ts`, `balancer.ts`, `evaluator.ts`, `rbac.ts`,
  `diagram.ts`, and `store.ts` (the `WorkflowStore` interface and the in-memory store, used by tests only)
- the dependency closure of those, which the sync checks is closed: `core/identity.ts` (`DEFAULT_ORGANIZATION_ID`),
  `core/summary.ts` (the in-memory store's projection) and `integrations/identity.ts` (the identity snapshot type and
  its validator). All pure.

Not vendored (each with its reason in `UPSTREAM.json` `not_vendored`): the HTTP service (`app.ts`, `index.ts`), the
Ajv wrapper (`schema.ts`), MongoDB persistence, the HTTP callback and outbox integrations, the jobs, ordered "sequence"
workflows, upstream's own schemas, its per-client folders and example workflows, and its test suite.

The service's step-change guards are rebuilt, not vendored: `lib/workflow-step-rules.ts` holds them as pure
functions (the patch's shape, comment and evidence demands, dormant steps, the transition matrix, lowering a demand,
who may change a step's holder, the bounded due-date extension, pinning a hand-placed holder), with upstream's order
and status codes, so phase 5 can keep the same contract. Where upstream hard-codes a role name, the caller decides.

Runtime dependencies: none beyond Node's own (`node:crypto`). `dsl/validate.ts` needs no schema library. Validating a
document against `spec.json` needs Ajv, which the mold carries as a **devDependency**, used by the test and, from phase 2,
by the profile build (`scripts/lib/record-workflows.mjs` loads it only when a profile declares a workflow), never in the
client bundle.

## The local patches

The vendored files are never edited by hand. The sync applies three declared patches, each with an exact count,
recorded per file in `UPSTREAM.json`:

1. **import-specifiers**: a relative import gains `.ts`, so the files load under `node --experimental-strip-types`.
2. **erasable-syntax**: upstream's two TypeScript parameter properties (in `balancer.ts` and `store.ts`) become a field
   and an assignment on the same line. Node's strip-only mode refuses a parameter property, so without this neither
   file loads. Behaviour is identical.
3. **neutral-words**: whole comment lines, and the spec's title and `$id` lines, that named the upstream platform or
   company, an example taken from a client, or a line of business are replaced by neutral lines. No identifier or
   value code reads changes. **The original text is not stored in this repository in any form that can be read back:**
   each patch names the line(s) it replaces only by `sha256("neutral-words:" + text)`, so only a sync run against the
   upstream checkout, which holds the originals, can find and replace them. The one exception is
   `kept_identifiers`: three directory field names in `PLATFORM_USER_ATTRIBUTES`, upstream's wire contract, which
   `validateWorkflow` accepts in a query and refuses to see redeclared; renaming them would change what it accepts.

The sync also runs a domain-word gate over the whole vendored tree, `UPSTREAM.json` included: no client, bank,
company, product or line-of-business word (held as salted sha256 hashes, so the list does not carry them either),
except the kept identifiers at their exact count. An upstream test file named after a client is recorded as
`redacted-…`.

## Refreshing it

```
# on the operator's machine: a checkout of the upstream repository at the commit to vendor
# (a shallow, sparse clone is enough); its address is the operator's, never written here
export WORKFLOW_ENGINE_SOURCE=<checkout>/<engine path>
node scripts/sync-workflow-engine.mjs --commit <sha> --from "$WORKFLOW_ENGINE_SOURCE"   # re-pin and write
node scripts/sync-workflow-engine.mjs --from "$WORKFLOW_ENGINE_SOURCE"                  # the pinned commit again
npm run check:workflow-engine          # offline (CI); with WORKFLOW_ENGINE_SOURCE set it also re-derives
npm run test:workflow-engine
```

A refresh fails, naming the file and patch, when upstream no longer holds the text a patch was written for, when a
kept file imports something not on the list, or when a new domain word appears: declare a neutral-words patch for it,
or decide it is a contract and say so. `--check` needs no upstream checkout: it requires every vendored file to be its
recorded vendored sha256 with its header, the recorded patch list to be exactly what the script declares (hashes of
the replaced lines included), and `UPSTREAM.json` to be byte for byte what the sync writes. With `--from` (or
`WORKFLOW_ENGINE_SOURCE`) it also re-derives every file from the checkout and requires the recorded upstream sha256 and
the vendored bytes. CI runs it offline in the `verify` job.

## Tests

`npm run test:workflow-engine` (`scripts/test-workflow-engine.mjs`) ports the behaviour upstream's tests cover to the
vendored core and the step rules, on neutral fixtures under `scripts/fixtures/workflows/` (`people.json` and one
workflow per file: two-person review, a five-step chain, a multi-holder chain, a two-of-three quorum, a gateway
branch, escalation one level up, routing anchored one level down, self and supervisor reassignment, a one-shot due-date
extension, a cohort wait, a migrated step). `UPSTREAM.json` `coverage` maps each upstream test file to the cases that
port it, or says why it is not ported (the HTTP service, Mongo, ordered sequences); the test fails if a file is
unmapped or a mapped case is missing.
