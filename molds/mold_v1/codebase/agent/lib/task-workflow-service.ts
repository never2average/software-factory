import { WORK_PERIODS, periodWordOf } from "./work-periods.ts";

interface ServiceResponse<T> {
  item?: T;
  error?: string;
}

export async function taskWorkflowRequest<T>(
  orgId: string,
  actor: string,
  path: string,
  init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
): Promise<T> {
  const url = process.env.TASK_WORKFLOW_SERVICE_URL?.replace(/\/$/, "");
  const token = process.env.TASK_WORKFLOW_SERVICE_TOKEN;
  if (!url || !token) throw new Error("Task workflow service is not configured.");

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-org-id": orgId,
        "x-actor-email": actor.toLowerCase(),
        "x-actor-role": "engineer",
        // The word the service's activity feed names a period by (the deployment profile's). Nothing under "off".
        ...(WORK_PERIODS.enabled ? { "x-period-label": encodeURIComponent(periodWordOf(WORK_PERIODS, "Period")) } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new Error(`Task workflow service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await response.json().catch(() => ({})) as ServiceResponse<T>;
  if (!response.ok) throw new Error(payload.error ?? `Task workflow service returned ${response.status}`);
  if (payload.item === undefined) return payload as T;
  return payload.item;
}
