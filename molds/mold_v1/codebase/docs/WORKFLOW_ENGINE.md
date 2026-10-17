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

**Phases 1 and 2 of 8 change no runtime behaviour.** Nothing in the app imports the engine yet; only the build does,
to check a profile's workflows (phase 2: `scripts/lib/record-workflows.mjs`, the DSL's validator and `spec.json`).
`npm run test:workflow-engine` fails if anything outside its own glue (the step rules, the test, the sync, the build's
check) names it. What follows, each its own change:

| Phase | What |
|---|---|
| 1 | the engine core as a library, its step rules, tests, the sync (this) |
| 2 | the deployment profile's schema for workflows: `records.workflows`, a lifecycle's `workflow`, each move's `step`, `workflow_states`, checked at build (docs/DEPLOYMENT_PROFILE.md "records.workflows"); email and agent actions and prompt branches refused until a later phase |
| 3 | Postgres tables for definitions and instances, with row-level security |
| 4 | people data: the directory, roles and reporting lines from the mold's own records |
| 5 | runtime wiring: attaching a workflow to a record, a person's change through the step rules |
| 6 | step actions: the emails and agent runs the rules queue |
| 7 | surfaces: the screens and the agent's tools |
| 8 | a pilot on one pack |

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
