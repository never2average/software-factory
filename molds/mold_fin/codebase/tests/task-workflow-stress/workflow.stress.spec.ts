import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";

type OperationKind = "health" | "create" | "transition" | "events" | "list" | "delete";

interface OperationSample {
  kind: OperationKind;
  status: number;
  durationMs: number;
  ok: boolean;
}

interface TaskDto {
  id: string;
  title: string;
  status: string;
  done: boolean;
  assignee: string | null;
  workflow: {
    workflowId: string;
    stageId: string;
    stageLabel: string;
    automationState: string;
  } | null;
}

interface TransitionEvent {
  id: string;
  fromStageId: string | null;
  toStageId: string;
  trigger: string;
  idempotencyKey: string | null;
}

interface LifecycleResult {
  taskId: string;
  automationRunIds: string[];
  eventStages: string[];
}

const baseURL = (process.env.TASK_WORKFLOW_STRESS_BASE_URL ?? process.env.TASK_WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
const token = process.env.TASK_WORKFLOW_SERVICE_TOKEN ?? "";
const orgId = process.env.TASK_WORKFLOW_STRESS_ORG_ID ?? "";
const actor = process.env.TASK_WORKFLOW_STRESS_ACTOR ?? "stress@example.com";
const iterations = positiveInt("TASK_WORKFLOW_STRESS_ITERATIONS", 12, 200);
const concurrency = positiveInt("TASK_WORKFLOW_STRESS_CONCURRENCY", 4, 50);
const p95LimitMs = positiveInt("TASK_WORKFLOW_STRESS_P95_MS", 8_000, 120_000);
const runKey = `pwstress-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function assertSafeTarget(): void {
  if (!baseURL) throw new Error("TASK_WORKFLOW_STRESS_BASE_URL is required");
  if (!token) throw new Error("TASK_WORKFLOW_SERVICE_TOKEN is required");
  if (!orgId) throw new Error("TASK_WORKFLOW_STRESS_ORG_ID is required");
  const target = new URL(baseURL);
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "::1";
  if (!local && process.env.TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION !== "1") {
    throw new Error(
      `Refusing to mutate non-local target ${target.origin}. Set TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION=1 explicitly.`,
    );
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function measured<T>(
  samples: OperationSample[],
  kind: OperationKind,
  operation: () => Promise<{ status(): number; ok(): boolean; json(): Promise<T>; text(): Promise<string> }>,
): Promise<T> {
  const startedAt = performance.now();
  const response = await operation();
  const durationMs = performance.now() - startedAt;
  samples.push({ kind, status: response.status(), durationMs, ok: response.ok() });
  if (!response.ok()) {
    throw new Error(`${kind} returned ${response.status()}: ${await response.text()}`);
  }
  return response.json();
}

async function transition(
  api: APIRequestContext,
  samples: OperationSample[],
  taskId: string,
  stageId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const body = await measured<{ item: TaskDto; automationRunId: string | null }>(samples, "transition", () =>
    api.patch(`/api/v1/tasks/${taskId}`, {
      data: { stageId, idempotencyKey, actor, reason: `Playwright stress transition to ${stageId}` },
    }),
  );
  expect(body.item.workflow?.stageId).toBe(stageId);
  return body.automationRunId;
}

async function runLifecycle(
  api: APIRequestContext,
  samples: OperationSample[],
  createdTaskIds: Set<string>,
  index: number,
): Promise<LifecycleResult> {
  const title = `[${runKey}] task ${String(index + 1).padStart(3, "0")}`;
  const created = await measured<{ item: TaskDto; automationRunId: string | null }>(samples, "create", () =>
    api.post("/api/v1/tasks", {
      data: { title, notes: "Ephemeral Playwright stress-test task", priority: index % 3 === 0 ? "high" : "normal", createdBy: actor },
    }),
  );
  const taskId = created.item.id;
  createdTaskIds.add(taskId);
  expect(created.item.workflow?.stageId).toBe("backlog");

  const automationRunIds: string[] = [];
  const stages = index % 3 === 0
    ? ["open", "in_progress", "blocked", "in_progress", "done"]
    : ["open", "in_progress", "done"];
  for (const [transitionIndex, stageId] of stages.entries()) {
    const idempotencyKey = `${runKey}:${index}:${transitionIndex}:${stageId}`;
    const automationRunId = await transition(
      api,
      samples,
      taskId,
      stageId,
      idempotencyKey,
    );
    if (automationRunId) automationRunIds.push(automationRunId);
    if (transitionIndex === 0) {
      const replayRunId = await transition(api, samples, taskId, stageId, idempotencyKey);
      expect(replayRunId).toBeNull();
    }
  }

  const history = await measured<{ items: TransitionEvent[] }>(samples, "events", () =>
    api.get(`/api/v1/tasks/${taskId}/events`),
  );
  const eventStages = history.items.map((event) => event.toStageId);
  expect(eventStages).toEqual(["backlog", ...stages]);
  expect(new Set(history.items.map((event) => event.id)).size).toBe(history.items.length);
  expect(history.items.filter((event) => event.idempotencyKey).length).toBe(stages.length);

  return { taskId, automationRunIds, eventStages };
}

async function mapConcurrent<T>(count: number, limit: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      results[index] = await fn(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, limit) }, () => worker()));
  return results;
}

async function attachSummary(testInfo: TestInfo, summary: unknown): Promise<void> {
  await testInfo.attach("task-workflow-stress-summary.json", {
    body: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`),
    contentType: "application/json",
  });
}

test("concurrent task lifecycle preserves workflow invariants", async ({ playwright }, testInfo) => {
  assertSafeTarget();
  const samples: OperationSample[] = [];
  const createdTaskIds = new Set<string>();
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      authorization: `Bearer ${token}`,
      "x-org-id": orgId,
      "x-actor-email": actor,
      "x-actor-role": "admin",
    },
  });
  const startedAt = performance.now();
  let lifecycles: LifecycleResult[] = [];

  try {
    const health = await measured<{ ok: boolean; service: string }>(samples, "health", () => api.get("/api/health"));
    expect(health).toMatchObject({ ok: true, service: "task-workflow" });

    lifecycles = await mapConcurrent(iterations, concurrency, (index) =>
      runLifecycle(api, samples, createdTaskIds, index),
    );

    const listed = await measured<{ items: TaskDto[] }>(samples, "list", () => api.get("/api/v1/tasks"));
    const listedById = new Map(listed.items.map((item) => [item.id, item]));
    for (const lifecycle of lifecycles) {
      const item = listedById.get(lifecycle.taskId);
      expect(item, `task ${lifecycle.taskId} should remain visible until cleanup`).toBeDefined();
      expect(item?.workflow?.stageId).toBe("done");
      expect(item?.done).toBe(true);
      expect(item?.workflow?.automationState).toBe("idle");
    }
  } finally {
    await mapConcurrent(createdTaskIds.size, concurrency, async (index) => {
      const taskId = [...createdTaskIds][index]!;
      await measured<Record<string, unknown>>(samples, "delete", () => api.delete(`/api/v1/tasks/${taskId}`));
      return taskId;
    }).catch((error) => console.error("Stress cleanup failed", error));
    await api.dispose();
  }

  const elapsedMs = performance.now() - startedAt;
  const latency = samples.filter((sample) => sample.kind !== "delete").map((sample) => sample.durationMs);
  const statusCounts = Object.fromEntries(
    [...new Set(samples.map((sample) => sample.status))].sort().map((status) => [status, samples.filter((sample) => sample.status === status).length]),
  );
  const summary = {
    runKey,
    target: new URL(baseURL).origin,
    orgId,
    iterations,
    concurrency,
    elapsedMs: Math.round(elapsedMs),
    taskLifecyclesPerSecond: Number((iterations / (elapsedMs / 1000)).toFixed(2)),
    operations: samples.length,
    statusCounts,
    latencyMs: {
      p50: Math.round(percentile(latency, 0.5)),
      p95: Math.round(percentile(latency, 0.95)),
      p99: Math.round(percentile(latency, 0.99)),
      max: Math.round(Math.max(...latency)),
    },
    automationRuns: lifecycles.flatMap((item) => item.automationRunIds),
  };
  console.log(`task-workflow stress summary: ${JSON.stringify(summary)}`);
  await attachSummary(testInfo, summary);

  expect(samples.some((sample) => sample.status >= 500), "no operation should return a 5xx response").toBe(false);
  expect(summary.latencyMs.p95).toBeLessThanOrEqual(p95LimitMs);
});
