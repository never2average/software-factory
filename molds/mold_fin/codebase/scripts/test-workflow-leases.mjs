import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFile(join(root, path), "utf8");

const [schema, journal, runtime, delegate, listRoute, detailRoute, manualRoute, cancelRoute] =
  await Promise.all([
    read("agent/lib/db/schema.ts"),
    read("lib/workflow-journal.ts"),
    read("lib/workflow-runtime.ts"),
    read("lib/workflow-delegate.ts"),
    read("app/api/ops/workflow-runs/route.ts"),
    read("app/api/ops/workflow-runs/[runId]/route.ts"),
    read("app/api/ops/workflows/[id]/run/route.ts"),
    read("app/api/ops/workflow-runs/[runId]/cancel/route.ts"),
  ]);

const checks = [
  [schema.includes('leaseToken: text("lease_token")'), "run lease token is persisted"],
  [schema.includes('leaseExpiresAt: timestamp("lease_expires_at"'), "run lease expiry is persisted"],
  [schema.includes('lastHeartbeatAt: timestamp("last_heartbeat_at"'), "heartbeat telemetry is persisted"],
  [schema.includes('cancelRequestedAt: timestamp("cancel_requested_at"'), "cancellation request is durable"],
  [
    schema.includes("primaryKey({ columns: [t.runId, t.attempt, t.callIndex] })"),
    "journal checkpoints are execution-epoch safe",
  ],
  [/for update skip locked/i.test(journal), "stalled-run claims skip already locked rows"],
  [
    /workflow_id is not distinct from[\s\S]*workflow_name = [\s\S]*args is not distinct from/.test(journal),
    "manual resume cannot switch workflow identity or arguments",
  ],
  [
    /r\.lease_token = \$\{lease\.leaseToken\}[\s\S]*r\.lease_expires_at > now\(\)/.test(journal),
    "journal writes require the live lease",
  ],
  [
    /and lease_token = \$\{lease\.leaseToken\}/.test(journal),
    "terminal state transitions require the owning lease",
  ],
  [
    /when cancel_requested_at is not null then 'cancelled'/.test(journal),
    "a cancellation request wins a racing completion",
  ],
  [
    journal.includes("finalizeAbandonedCancellations") &&
      /cancel_requested_at is not null[\s\S]*lease_expires_at <= now\(\)/.test(journal),
    "an abandoned cancellation becomes terminal after lease expiry",
  ],
  [
    journal.includes("finalizeExhaustedRuns") && /attempts >= \$\{attemptsCap\}/.test(journal),
    "retry exhaustion becomes terminal instead of remaining ownerless",
  ],
  [runtime.includes("opts.signal?.aborted"), "QuickJS execution observes cancellation"],
  [
    delegate.includes("/cancel") && delegate.includes("startIndex=${streamIndex}"),
    "Eve cancellation and durable cursor replay are used",
  ],
  [listRoute.includes("orgContextForRequest") && listRoute.includes("workflowRuns.orgId"), "run list is tenant scoped"],
  [detailRoute.includes("orgContextForRequest") && detailRoute.includes("workflowRunJournal.orgId"), "run detail is tenant scoped"],
  [manualRoute.includes("eq(workflows.orgId, org.orgId)") && manualRoute.includes("orgId: org.orgId"), "manual run lookup/write is tenant scoped"],
  [cancelRoute.includes("requestWorkflowRunCancellation") && cancelRoute.includes("identity.email"), "cancel API records a verified actor"],
];

for (const [ok, message] of checks) assert.ok(ok, message);
console.log(`workflow lease contract: ${checks.length}/${checks.length} checks passed`);
