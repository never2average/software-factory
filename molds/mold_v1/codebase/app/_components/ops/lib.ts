"use client";

/**
 * Ops Center non-visual shared code: API types, fetch/list/pager hooks,
 * formatting helpers, side-panel state, and the section registry.
 */

import { useCallback, useEffect, useState } from "react";
import {
  InboxIcon,
  AlarmClockIcon,
  CircleCheckIcon,
  LayoutDashboardIcon,
  PlugIcon,
  WorkflowIcon,
} from "lucide-react";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { STORAGE_KEYS, readActiveOrg, readStored, removeStored, writeActiveOrg, writeStored } from "@/lib/browser-storage";
import { an, W } from "@/lib/ui-words";
import { isStartupRead, sharedGet } from "@/lib/startup-fetch";
import { isWorkspaceRefusalBody, noteWorkspaceRefused } from "@/lib/workspace-refusal";

/** What a TODO is filed under, as a person reads it — only the containers whose data-room domain this deployment
 *  shows, in the profile's words ("deployment/implementation" by default). */
const TODO_CONTAINERS = [
  DEPLOYMENT_PROFILE.dataroom.domains.deliveries?.visible !== false ? W.deployment : null,
  DEPLOYMENT_PROFILE.dataroom.domains.projects?.visible !== false ? W.implementation : null,
].filter((w): w is string => Boolean(w));

/* -------------------------------- Sections ------------------------------- */

// NOTE: the Workspace (control plane) is NOT an Ops Center section — it opens as
// its own full page (`/workspace`) from the gear icon in the sidebar footer.
export type OpsSection = "connectors" | "workflows" | "crons" | "apps" | "todos" | "inbox";

// Connectors moved to the Workspace page (its own "Connectors" tab), so it's no
// longer in the Ops Center launcher — the type + render stay for deep-link compat.
export const OPS_SECTIONS: {
  key: OpsSection;
  label: string;
  icon: typeof PlugIcon;
}[] = [
  { key: "inbox", label: "Inbox", icon: InboxIcon },
  { key: "workflows", label: "Workflows", icon: WorkflowIcon },
  { key: "crons", label: "Crons", icon: AlarmClockIcon },
  { key: "apps", label: "Apps", icon: LayoutDashboardIcon },
  { key: "todos", label: "TODOs", icon: CircleCheckIcon },
];

export const SECTION_META: Record<
  OpsSection,
  { icon: typeof PlugIcon; title: string; blurb: string }
> = {
  apps: {
    icon: LayoutDashboardIcon,
    title: "Apps",
    blurb: "Living documents the agent regenerates on a cadence — rendered read-only as Markdown.",
  },
  todos: {
    icon: CircleCheckIcon,
    title: "TODOs",
    blurb:
      TODO_CONTAINERS.length > 0
        ? `The team's internal action list — filed under ${an(TODO_CONTAINERS[0])} ${TODO_CONTAINERS.join("/")}, linked to work.`
        : "The team's internal action list — linked to work.",
  },
  connectors: {
    icon: PlugIcon,
    title: "Connectors",
    blurb: "Ingestion sources feeding the data room's syncs/ landing zones.",
  },
  workflows: {
    icon: WorkflowIcon,
    title: "Workflows",
    blurb: "Specialist subagents the orchestrator delegates to, plus durable rule-driven loops.",
  },
  inbox: {
    icon: InboxIcon,
    title: "Inbox",
    blurb:
      "Off-platform conversations — email, Granola, Slack — grouped into threads and staged here until you promote them into the data room.",
  },
  crons: {
    icon: AlarmClockIcon,
    title: "Crons",
    blurb: "Scheduled jobs that run the agent on a cadence (Vercel Cron, evaluated in UTC).",
  },
};

/* --------------------------- API types + helpers -------------------------- */

export type Access = "read" | "write" | "read_write";

export interface ApiConnector {
  id: string;
  /**
   * Set when this connector belongs to ONE person; null when it is shared by
   * the workspace. The list only ever contains your own personal connectors
   * plus the shared ones — the RLS policy sees to that — so this is for
   * labelling, not filtering.
   */
  ownerEmail: string | null;
  name: string;
  kind: string;
  access: Access;
  status: string;
  detail: string | null;
  lands: string | null;
  synced: string[] | null;
  notifyEmail: string | null;
  /** The recipient LIST (supersedes notifyEmail above). */
  notifyEmails: string[] | null;
  /** The condition those recipients are notified on, in the operator's words. */
  notifyWhen: string | null;
  /**
   * DERIVED, not stored: whether the running agent actually holds this
   * connector's required secrets. The `status` column is seeded text and said
   * "connected" for connectors whose token is missing — this is the honest one.
   */
  health: "live" | "degraded" | "missing" | "unimplemented" | "unknown";
  /* ---- bring-your-own connector ------------------------------------- *
   * Null on a built-in kind, whose endpoint and credential contract live
   * in code. Set when a workspace registered its OWN MCP server: where it
   * is, what credentials it declares, and which one authenticates it.   */
  endpointUrl: string | null;
  requiredSecrets: { name: string; purpose: string; optional?: boolean }[] | null;
  authSecretName: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiWorkflow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  customerId: string | null;
  steps: string[] | null;
  // Operator override appended to the subagent's authored instructions.
  instructions: string | null;
  /** Whether the override above is live. False = kept on the row, not injected. */
  instructionsEnabled: boolean;
  /**
   * The workflow SCRIPT: JavaScript that orchestrates the subagents (meta +
   * phase/agent/parallel/pipeline). This is what a workflow IS — the subagent
   * behind a step is an implementation detail the script delegates to.
   */
  script: string | null;
  notifyEmail: string | null;
  /** The recipient LIST (supersedes notifyEmail above). */
  notifyEmails: string[] | null;
  enabled: boolean;
  /**
   * What THIS deployment can do with the row (lib/workflow-availability.ts), derived by GET /api/ops/workflows and
   * never stored: a base-library original that needs a specialist the profile excludes is not available; an edited
   * or authored one that needs one is runnable and reported.
   */
  availability?: { available: boolean; reason?: string; needsExcluded?: string[] };
  /** Whether this row can generate an APP's document, and as what, or why not (lib/app-source.ts). Derived. */
  appSource?: ApiAppSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An operator TODO — the team's internal checklist item (not a customer ticket). */
export interface ApiTodo {
  id: string;
  title: string;
  notes: string | null;
  done: boolean;
  doneAt: string | null;
  /** Board status: backlog | open | in_progress | blocked | done | cancelled. */
  status: string;
  priority: "low" | "normal" | "high";
  dueAt: string | null;
  /** The epic-analog it's filed under: a deployment or implementation. */
  containerType: "deployment" | "implementation" | null;
  containerId: string | null;
  containerLabel: string | null;
  /** A related object it points at. */
  linkType: "ticket" | "customer" | "app" | "cron" | "workflow" | "chat" | null;
  linkId: string | null;
  linkLabel: string | null;
  cycleId: string | null;
  /** Parent todo id — set when this todo is a subtask. */
  parentId: string | null;
  createdBy: string;
  assignee: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Owned reference rows for the TODO side-nav "My …" views (enriched pickers). */
export interface ApiRefTicket {
  id: string;
  label: string;
  sub?: string;
  owner: string | null;
  status: string;
  priority: string;
  customer: string | null;
}
export interface ApiRefDeployment {
  id: string;
  label: string;
  /** Editable human title; blank falls back to `label` (the composed identity). */
  displayName: string | null;
  owner: string | null;
  status: string;
  health: string;
  env: string;
  version: string;
  customer: string | null;
  customerLabel: string | null;
  uptime: number | null;
  errorRate: number | null;
  lastDeployAt: string | null;
  /** Columns the deployment profile shows beyond the defaults (`domains.deployments`); {} for the default profile. */
  fields?: Record<string, string | number | null>;
  /** The values of the profile's OWN fields (`custom_fields`), by key. */
  custom?: Record<string, string | number>;
  /** Set by the list when two customers share a deployment id: `id` is then customer + id, this is the real one. */
  recordId?: string;
}
export interface ApiRefImplementation {
  id: string;
  label: string;
  /** Editable human title; blank falls back to `label` (the composed identity). */
  displayName: string | null;
  owner: string | null;
  stage: string;
  risk: string;
  progress: number | null;
  customer: string | null;
  customerLabel: string | null;
  /** The launch-scope solution(s) use-case — the implementation card's title. */
  solutionName: string | null;
  /** actual, else target go-live date (ISO/date string) — the "due in N days". */
  goLiveDate: string | null;
  /** Columns the deployment profile shows beyond the defaults (`domains.implementations`); {} for the default profile. */
  fields?: Record<string, string | number | null>;
  /** The values of the profile's OWN fields (`custom_fields`), by key. */
  custom?: Record<string, string | number>;
}

/** One person's own goal for one period (mode individual): GET /api/ops/cycles/:id/goals. */
export interface ApiMemberGoal {
  member: string;
  goal: string | null;
  targetCount: number | null;
}

/** One roster row — the org graph the TODO scope filters resolve against. */
export interface ApiRosterMember {
  email: string;
  name: string | null;
  team: string | null;
  managerEmail: string | null;
  /** Escalation contacts: multiple managers, each with a trigger reason. */
  escalations?: { email: string; reason: string }[];
}

/** A cycle: the period that groups todos (what it is called and how it works is the profile's `work_periods`). */
export interface ApiCycle {
  id: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  /** "planning" | "active" | "closed". */
  state: string;
  goal: string | null;
  capacity: number | null;
  /** The lead's email (resolved against the roster). Mode team only. */
  lead: string | null;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A living Markdown document the agent regenerates on a cadence. */
export interface ApiApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sourceKind: "workflow" | "prompt";
  workflow: string | null;
  prompt: string | null;
  subagent: string | null;
  customerId: string | null;
  /** 5-field UTC cron; null = manual refresh only. */
  refreshCron: string | null;
  contentMd: string | null;
  contentUpdatedAt: string | null;
  /** Provenance of the last refresh — either is openable as a chat. */
  lastRunId: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  lastRefreshAt: string | null;
  enabled: boolean;
  /** Whether what generates this app can run as it is set now. Absent from an older API. */
  source?: ApiAppSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether a source can produce an app's document (lib/app-source.ts), derived by the API on every read: a workflow
 * script, the row of one of the workspace's specialists, or a prompt; or the reason it cannot run and what to do.
 */
export type ApiAppSource =
  | { ok: true; kind: "script" | "specialist" | "prompt"; specialist?: string }
  | { ok: false; kind: "script" | "specialist" | "prompt" | "none"; reason: string; fix: string };

/** One archived refresh of an app — the document as it stood, and its run. */
export interface ApiAppVersion {
  id: string;
  appId: string;
  contentMd: string | null;
  error: string | null;
  runId: string | null;
  sessionId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ApiSchedule {
  id: string;
  name: string;
  cron: string | null;
  everyMinutes: number | null;
  kind: string;
  workflow: string | null;
  prompt: string;
  channelId: string | null;
  customerId: string | null;
  notifyEmail: string | null;
  /** The recipient LIST (supersedes notifyEmail above). */
  notifyEmails: string[] | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Pause / soft-delete / cadence / prompt override for a code-authored cron. Absent row = live. */
export interface ApiSystemCronOverride {
  name: string;
  enabled: boolean;
  deletedAt: string | null;
  lastError: string | null;
  lastRunAt: string | null;
  // Override cron expression; null = the authored cadence applies. When set,
  // the every-minute dispatcher (agent/schedules/dynamic.ts) owns the timing.
  cron: string | null;
  // Override prompt; null = the authored prompt in
  // agent/lib/system-cron-defs.ts applies.
  prompt: string | null;
  /** Which workflow (subagent) runs this cron; null = the orchestrator does. */
  workflow: string | null;
  // Alert target appended to the message as a NOTIFY TARGET line; null = none.
  notifyEmail: string | null;
  /** The recipient LIST (supersedes notifyEmail above). */
  notifyEmails: string[] | null;
}

/** Discriminator for the shared run-history / audit-log tables. */
/**
 * A person the notify-recipients picker can choose. Sourced from the two real
 * people tables (internal_staff + customer_stakeholders), deduped by email —
 * see app/api/ops/people/route.ts.
 */
export interface OpsPerson {
  name: string;
  email: string;
  title: string | null;
  org: string | null;
  role: string | null;
  kind: "internal" | "stakeholder";
  customers: string[];
}

/**
 * One saved version of a workflow's operator-instructions override, from
 * GET /api/ops/workflows/:id/versions. `content: null` = the override was
 * cleared in that version.
 */
export interface ApiWorkflowVersion {
  id: string;
  workflowId: string;
  content: string | null;
  /** Which file this is a version of. */
  kind: "instructions" | "script";
  author: string;
  createdAt: string;
}

/** One step of a run, streamed back by POST /api/ops/workflows/:id/run. */
export interface WorkflowRunEvent {
  at: number;
  kind: "phase" | "log" | "agent" | "error";
  text: string;
}

/** The graph + diagnostics read off a script's source (lib/workflow-validate.ts). */
export interface WorkflowAnalysis {
  ok: boolean;
  issues: { level: "error" | "warning"; message: string; line: number }[];
  meta: { name?: string; description?: string } | null;
  phases: { title: string; steps: { kind: string; label: string; line: number }[] }[];
}

/**
 * The Google ID token the chat signs in with. A workflow run borrows the
 * OPERATOR's identity to reach the agent — a run must never be able to do
 * something the person who started it could not do themselves.
 */
export function authToken(): string | null {
  return readStored(STORAGE_KEYS.token);
}

/**
 * One secret a connector needs. `live` is the truth about the RUNNING agent
 * (reported by its dispatcher); `stored` is what an operator typed into the Ops
 * Center. They are different facts and the UI shows both — a value is never
 * returned by the API, only the last-4 `hint`.
 */
export interface ApiConnectorSecret {
  name: string;
  purpose: string;
  optional: boolean;
  live: boolean | null;
  liveSeenAt: string | null;
  stored: boolean;
  hint: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Only on a server with CONNECTIONS_PROVIDER=env: the agent reads this stored secret itself, at call time. */
  storedIsLive?: true;
}

export type AutomationType = "schedule" | "system_cron" | "connector" | "workflow";

/** One row of `automation_runs` from GET /api/ops/runs. */
export interface ApiRun {
  id: string;
  automationType: string;
  automationId: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
  /** The durable workflow run this cron fire triggered (a cron routed to a
   *  workflow) — makes the invocation openable as a chat. Null otherwise. */
  workflowRunId?: string | null;
  /** True when the triggered workflow run captured a step session — i.e. the
   *  invocation can actually be opened as a chat (not a dead link). */
  hasSession?: boolean;
  /** Token usage, accumulated across the run's model steps. Null when unreported. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/** Total billable tokens for a run (cache reads/writes included). */
export function runTokens(r: ApiRun): number {
  return (
    (r.inputTokens ?? 0) +
    (r.outputTokens ?? 0) +
    (r.cacheReadTokens ?? 0) +
    (r.cacheWriteTokens ?? 0)
  );
}

/** 1.2k / 340k / 4.1M — token counts are read at a glance, not audited. */
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** "12.4k tokens · 3.1k in / 9.3k out · $0.04" — null when the run reported none. */
export function fmtTokens(r: ApiRun): string | null {
  const total = runTokens(r);
  if (total === 0) return null;
  const parts = [
    `${fmtCount(total)} tokens`,
    `${fmtCount(r.inputTokens ?? 0)} in / ${fmtCount(r.outputTokens ?? 0)} out`,
  ];
  if (r.costUsd) parts.push(`$${r.costUsd.toFixed(r.costUsd < 1 ? 3 : 2)}`);
  return parts.join(" · ");
}

/** Where the chosen workspace is remembered, for people who belong to several. */
export const ACTIVE_ORG_KEY = STORAGE_KEYS.activeOrg;

/** The workspace THIS TAB is in (its own choice first; lib/browser-storage.ts readActiveOrg). */
export function activeOrg(): string | null {
  return readActiveOrg();
}

export function setActiveOrg(orgId: string | null): void {
  // private mode swallows both; the server just falls back to the default workspace
  writeActiveOrg(orgId);
}

/**
 * Switch this tab to `orgId` — the workspace switcher's path, also taken by a link that names a workspace: this tab's
 * choice, the default for new tabs, and the server's "last selected" (so a device that names no workspace follows).
 * The server call is a preference, not a grant: it is refused for a workspace the person is not in.
 */
export async function switchWorkspace(orgId: string): Promise<void> {
  // This TAB always follows (a guest's link names the chat's workspace, and the thread and session routes read it
  // for that one chat); the default for new tabs and the server's choice change only for a workspace the person is
  // actually in — the server refuses the rest (404), so a guest's own default workspace is never displaced.
  writeStored(ACTIVE_ORG_KEY, orgId, "session");
  const accepted = await opsFetch("/api/ops/me/workspaces/active", { method: "POST", body: JSON.stringify({ orgId }) }).then(
    () => true,
    () => false,
  );
  if (accepted) setActiveOrg(orgId);
}

/** A link's `org` parameter, when it is a plausible workspace id (one path segment, the keyspace's alphabet). */
export function workspaceOfLink(href: string): string | null {
  try {
    const org = new URL(href, "http://link.invalid").searchParams.get("org");
    return org && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(org) ? org : null;
  } catch {
    return null;
  }
}

/** `path` with this tab's workspace named on it (`&org=`), so the link opens in the same workspace anywhere. */
export function linkInWorkspace(path: string): string {
  const org = activeOrg();
  if (!org) return path;
  return `${path}${path.includes("?") ? "&" : "?"}org=${encodeURIComponent(org)}`;
}

/**
 * The same signed-in call as `opsFetch`, but hands back the raw Response — for
 * the few Ops routes that answer with BYTES (a PDF), where parsing JSON would
 * throw the body away. The caller reads status and body itself.
 */
export async function opsFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const token = authToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const org = readActiveOrg();
  if (org) headers["x-ops-org"] = org;
  const res = await fetch(path, { ...init, headers });
  // A refused workspace is noted for the page (lib/workspace-refusal.ts); the body is left for the caller.
  if (res.status === 403) {
    const body = await res.clone().text().catch(() => "");
    if (isWorkspaceRefusalBody(res.status, body)) noteWorkspaceRefused(org);
  }
  return res;
}

export async function opsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Every Ops API call now carries the signed-in identity — the middleware
  // (middleware.ts) verifies it. Without this header the API answers 401.
  const token = authToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  /**
   * Which workspace this call is about, when the person belongs to more than
   * one. Attached HERE rather than at each call site so a new ops surface
   * cannot forget it and silently read the wrong tenant.
   *
   * It is a name, not a grant: `resolveOrgForIdentity` honours it only if
   * the caller is actually a member of that workspace, and refuses the request
   * otherwise (it is never served from another workspace), so a hand-edited
   * value in localStorage buys nothing.
   */
  const org = readActiveOrg();
  if (org) headers["x-ops-org"] = org;
  // A plain GET of a first-screen read is shared with every other caller asking for it now, and with the <head>
  // script's early request (lib/startup-fetch).
  const res =
    !init?.method && !init?.body && !init?.signal && isStartupRead(path)
      ? await sharedGet(path, headers)
      : await fetch(path, { ...init, headers });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    // The tab's workspace is one this person is not a member of (or it does not exist): the server no longer
    // answers from another workspace instead. Noted once for the page, which shows a plain message and the
    // person's own workspaces (lib/workspace-refusal.ts); this call still fails with the server's sentence.
    if (isWorkspaceRefusalBody(res.status, data)) noteWorkspaceRefused(org);
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export function useOpsList<T>(path: string | null) {
  // A null path is a list this deployment does not have (a feature its profile turns off): empty, never fetched.
  const [items, setItems] = useState<T[] | null>(path === null ? [] : null);
  const [error, setError] = useState<string | null>(null);
  /** The rest of the list response, beside `items` (e.g. the workflows list's `libraryNote`). */
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const refetch = useCallback(async () => {
    if (path === null) return;
    try {
      const { items: list, ...rest } = await opsFetch<{ items: T[] } & Record<string, unknown>>(path);
      setItems(list);
      setExtra(rest);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  return { items, extra, error, refetch, loading: items === null && error === null };
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** The API stores run duration in MILLISECONDS; render as seconds (214s / 1.2s). */
export function fmtDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

export function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f?.toLowerCase().includes(q));
}

/* ------------------------------- Pagination ------------------------------ */

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const PAGE_SIZE_KEY = "ops-page-size";
const DEFAULT_PAGE_SIZE = 25;

function storedPageSize(): number {
  try {
    const v = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_PAGE_SIZE;
  } catch {
    // SSR / storage unavailable.
    return DEFAULT_PAGE_SIZE;
  }
}

/**
 * List pagination with a user-configurable page size, shared (and persisted)
 * across every Ops surface. Page clamps when the filtered list shrinks; size
 * changes snap back to page 1 so the viewport never lands past the end.
 */
export function usePager<T>(filtered: T[]) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(storedPageSize);
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(n));
    } catch {
      /* storage unavailable */
    }
  };
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize);
  return {
    rows,
    start,
    page: current,
    pages,
    setPage,
    total: filtered.length,
    pageSize,
    setPageSize,
  };
}

/* ----------------------------- Side-panel state --------------------------- */

/**
 * The right sidebar is transient. `closed` is the resting state — the table
 * spans the full modal width. It opens for Add (wizard) or Review — and the
 * detail panel IS the editor (every editable field edits inline in place).
 */
export type PanelState =
  | { mode: "closed" }
  | { mode: "view"; id: string }
  | { mode: "wizard" }
  // The bring-your-own connector wizard — a different set of questions, so a
  // separate mode rather than a flag threaded through the standard one.
  | { mode: "wizard-custom" }
  // A code-authored Vercel Cron job, not a DB row — its detail panel edits
  // the override columns inline (cadence, prompt, notify email, pause/resume);
  // Source / Last run / Last error stay read-only.
  | { mode: "system"; name: string };

export function panelId(panel: PanelState): string | null {
  return panel.mode === "view" ? panel.id : null;
}

/** "route-incident" → "Route Incident": de-kebab a slug for display. Leaves an
 *  already-spaced or capitalised name alone-ish (just title-cases the words). */
export function unkebab(s: string): string {
  const t = s.replace(/[-_]+/g, " ").trim();
  if (!t) return s;
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}
