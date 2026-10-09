/**
 * PagerDuty client. Two capabilities, each degrades to a clearly-labeled no-op
 * when its key is absent (like exa.ts / granola.ts) so the rest of the agent
 * keeps working:
 *
 *   - trigger/resolve an incident via the Events API v2 (needs PAGERDUTY_ROUTING_KEY).
 *     `dedup_key` = the ticket id, so re-triggering updates the same incident
 *     instead of opening duplicates.
 *   - read who is on-call now via the REST API (needs PAGERDUTY_API_TOKEN).
 *
 * Opsgenie is a drop-in alternative with the same two-call surface; swap the URLs
 * + auth here and keep the tool layer unchanged.
 */
const EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const REST_ONCALLS_URL = "https://api.pagerduty.com/oncalls";

export interface PageResult {
  configured: boolean;
  triggered: boolean;
  dedupKey?: string;
  message?: string;
}

/**
 * Trigger (or resolve) a PagerDuty incident. `dedupKey` (the ticket id) makes it
 * idempotent — PagerDuty coalesces repeat triggers onto one incident.
 */
export async function pageOnCall(input: {
  summary: string;
  dedupKey: string;
  severity?: "critical" | "error" | "warning" | "info";
  source?: string;
  customerId?: string;
  ticketId?: string;
  action?: "trigger" | "resolve";
  details?: Record<string, unknown>;
}): Promise<PageResult> {
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) {
    return {
      configured: false,
      triggered: false,
      message: "PAGERDUTY_ROUTING_KEY is not set. Add it to enable on-call paging.",
    };
  }
  const action = input.action ?? "trigger";
  const body = {
    routing_key: routingKey,
    event_action: action,
    dedup_key: input.dedupKey,
    payload: {
      summary: input.summary.slice(0, 1024),
      source: input.source ?? input.customerId ?? "agent-workspace",
      severity: input.severity ?? "error",
      custom_details: { customerId: input.customerId, ticketId: input.ticketId, ...input.details },
    },
  };
  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return {
      configured: true,
      triggered: false,
      message: `PagerDuty enqueue failed: ${res.status} ${res.statusText}`,
    };
  }
  return { configured: true, triggered: action === "trigger", dedupKey: input.dedupKey };
}

export interface OnCallEntry {
  escalationPolicy?: string;
  escalationLevel?: number;
  user?: string;
  userEmail?: string;
  scheduleName?: string;
}

/** Read who is currently on-call. Empty (configured:false) when no API token. */
export async function getOnCall(): Promise<{
  configured: boolean;
  oncalls: OnCallEntry[];
  message?: string;
}> {
  const token = process.env.PAGERDUTY_API_TOKEN;
  if (!token) {
    return {
      configured: false,
      oncalls: [],
      message: "PAGERDUTY_API_TOKEN is not set. Add it to read the current on-call.",
    };
  }
  const res = await fetch(`${REST_ONCALLS_URL}?earliest=true`, {
    headers: { authorization: `Token token=${token}`, accept: "application/json" },
  });
  if (!res.ok) {
    return { configured: true, oncalls: [], message: `PagerDuty oncalls failed: ${res.status}` };
  }
  const data = (await res.json()) as {
    oncalls?: Array<{
      escalation_policy?: { summary?: string };
      escalation_level?: number;
      user?: { summary?: string; email?: string };
      schedule?: { summary?: string } | null;
    }>;
  };
  return {
    configured: true,
    oncalls: (data.oncalls ?? []).map((o) => ({
      escalationPolicy: o.escalation_policy?.summary,
      escalationLevel: o.escalation_level,
      user: o.user?.summary,
      userEmail: o.user?.email,
      scheduleName: o.schedule?.summary ?? undefined,
    })),
  };
}
