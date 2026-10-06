// Derives the cockpit's live state from the agent's raw stream events:
// which subagents are running, and which customer / people / workload contexts
// have been pulled into the conversation. Fed by useEveAgent's `onEvent`.
//
// Events are typed loosely on purpose — this is display logic that degrades
// gracefully if a shape shifts, rather than coupling the UI to internal types.

import { SUBAGENT_KEYS } from "./subagent-meta.generated.ts";

import { DEPLOYMENT_PROFILE } from "../../lib/deployment-profile.generated.ts";
// Under a profile that relabels the domains the agent's tools are called in its words (`get_company`) and their
// results carry its keys (`companies`, `analystOwner`): recognise both, by the BASE name (agent-vocabulary.ts).
import { isDetachedOutput, isDetachedResult } from "../../lib/detached-delegation.ts";
import { baseNameAmong, fieldOf } from "../../agent/lib/agent-vocabulary.ts";

const RECORD_TOOLS = ["list_customers", "get_customer", "list_followups", "trigger_workflow", "run_app"] as const;
export interface SubagentRun {
  callId: string;
  name: string;
  childSessionId?: string;
  status: "running" | "done";
  /** Handed over to the main agent as "reports later" (lib/detached-delegation.ts): still running, reports by itself. */
  detached?: boolean;
  output?: string;
  activity: string[];
  /** The delegation tool part itself — carries a proxied approval/question
   *  (toolMetadata.eve.inputRequest) so the rail can render the options. */
  delegationPart?: unknown;
}

export interface CtxItem {
  id: string;
  label: string;
  sub?: string;
}

/**
 * Something the conversation PRODUCED or touched that's worth keeping at hand
 * while authoring — a published file (signed URL), or a cron/schedule the agent
 * created or updated (its definition, viewable inline). Workflow scripts are
 * surfaced separately in the cockpit from the live run list, not here.
 */
export interface ArtifactItem {
  id: string;
  label: string;
  kind: "file" | "cron";
  sub?: string;
  /** A published file's signed URL (kind: "file"). */
  href?: string;
  /** Inline content to view in a modal (kind: "cron" — the definition JSON). */
  content?: string;
}

/**
 * One canonical human. Raw owner strings arrive as compounds
 * ("Keshav Malik/ Prathmesh Shukla", "Priyesh / Keshav Malik") — those are
 * split into individuals, and repeat sightings merge into ONE row that
 * accumulates roles and the customer accounts they were seen on.
 */
export interface PersonItem {
  id: string;
  label: string;
  roles: string[];
  accounts: string[];
}

export interface Insights {
  subagents: SubagentRun[];
  customers: CtxItem[];
  people: PersonItem[];
  workload: CtxItem[];
  artifacts: ArtifactItem[];
  /** Workflow run ids this chat TRIGGERED via the `trigger_workflow` / `run_app`
   *  tools (which are plain tool calls, not subagent delegations, so their
   *  workflowId never lands in a delegation part). The cockpit keeps these runs
   *  visible even after they finish, so a run the conversation kicked off doesn't
   *  vanish from the panel the moment it completes. */
  workflowRunIds: string[];
  /** App ids / slugs this chat TOUCHED via `create_app` / `update_app` /
   *  `run_app` (refresh). The cockpit scopes its Apps section to these, so the
   *  Control Panel shows the apps for THIS chat thread — not every app that
   *  happens to be refreshing globally (e.g. a cron in another context). */
  appIds: string[];
  /** Live-view URLs from `browser_open` — the operator can watch the agent
   *  browse. Surfaced as a "Live browser" card in the Control Panel. */
  browserLiveViews: { sessionRef: string; url: string }[];
  /** Browser tool FAILURES (open/goto/read/act/login/close returned an `error`
   *  or threw) — surfaced in the Control Panel so a failing browser run says
   *  WHY, instead of silently showing no live-view card. */
  browserErrors: { tool: string; error: string }[];
}

export const emptyInsights: Insights = {
  subagents: [],
  customers: [],
  people: [],
  workload: [],
  artifacts: [],
  workflowRunIds: [],
  appIds: [],
  browserLiveViews: [],
  browserErrors: [],
};

type StreamEvent = { type: string; data?: unknown };

/** The tool name for an action.result — eve puts it on `result.toolName`. */
function toolNameOf(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (typeof r.toolName === "string") return r.toolName;
  // Fallback for older shapes where the callId encoded the tool name.
  return typeof r.callId === "string" ? r.callId.replace(/_\d+$/, "") : "";
}

function upsert(list: CtxItem[], item: CtxItem): CtxItem[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = [...list];
  next[i] = { ...next[i], ...item };
  return next;
}

function upsertArtifact(list: ArtifactItem[], item: ArtifactItem): ArtifactItem[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = [...list];
  next[i] = { ...next[i], ...item };
  return next;
}

/**
 * Capture an artifact from a tool CALL (needs both input and output): a
 * `publish_artifact` becomes a file with its signed URL; a `create_schedule` /
 * `update_schedule` becomes a viewable cron definition. Returns the list
 * unchanged for any other tool.
 */
function applyArtifact(
  list: ArtifactItem[],
  tool: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): ArtifactItem[] {
  if (tool === "publish_artifact") {
    const url = typeof output.url === "string" ? output.url : undefined;
    if (!url) return list;
    const filename = typeof input.filename === "string" ? input.filename : "artifact";
    const expiresAt = typeof output.expiresAt === "string" ? output.expiresAt : undefined;
    return upsertArtifact(list, {
      id: url,
      label: filename,
      kind: "file",
      href: url,
      sub: expiresAt ? `link expires ${new Date(expiresAt).toLocaleString()}` : "published file",
    });
  }
  if (tool === "create_schedule" || tool === "update_schedule") {
    // Prefer the persisted row (output) — it's the full definition; fall back to
    // the requested fields (input) for a partial update that returns nothing.
    const def = output && Object.keys(output).length ? output : input;
    const name =
      (typeof def.name === "string" && def.name) ||
      (typeof input.name === "string" && input.name) ||
      (typeof def.id === "string" && def.id) ||
      "schedule";
    const cadence =
      (typeof def.cron === "string" && def.cron) ||
      (typeof def.everyMinutes === "number" && `every ${def.everyMinutes}m`) ||
      undefined;
    return upsertArtifact(list, {
      id: `cron:${name}`,
      label: String(name),
      kind: "cron",
      sub: [tool === "create_schedule" ? "created" : "updated", cadence].filter(Boolean).join(" · "),
      content: JSON.stringify(def, null, 2),
    });
  }
  return list;
}

/**
 * Canonicalize a raw owner string into individual humans. Compound strings are
 * split on "/", ",", "&", and the word " and "; each piece is trimmed, inner
 * whitespace collapsed, and empties / <2-char fragments dropped. Identity is
 * the lowercased cleaned name (so "Keshav Malik/ Priyesh" and
 * "Priyesh / Keshav Malik" yield the same two people); the display label keeps
 * the cleaned name's original casing ("Soumil B" stays "Soumil B").
 */
function splitPeople(raw: string): Array<{ id: string; label: string }> {
  return raw
    .split(/\s*(?:[/,&]|\s+and\s+)\s*/i)
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter((piece) => piece.length >= 2)
    .map((piece) => {
      // fde_owner now carries emails (firstname@onfinance.in after the roster
      // normalization) — display the human, not the address: local part in
      // Title Case, identity keyed on the full lowercase address.
      const emailMatch = piece.match(/^([^@\s]+)@[^@\s]+\.[^@\s]+$/);
      if (emailMatch) {
        const label = emailMatch[1]
          .split(/[._-]+/)
          .filter(Boolean)
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(" ");
        return { id: piece.toLowerCase(), label };
      }
      return { id: piece.toLowerCase(), label: piece };
    });
}

/** accounts.length desc, then label — the People rail's display order. */
function byPersonRank(a: PersonItem, b: PersonItem): number {
  return b.accounts.length - a.accounts.length || a.label.localeCompare(b.label);
}

/** Merge one sighting of a person into the list: dedup roles + accounts. */
function upsertPerson(
  list: PersonItem[],
  id: string,
  label: string,
  role?: string,
  account?: string,
): PersonItem[] {
  const i = list.findIndex((p) => p.id === id);
  const existing: PersonItem = i === -1 ? { id, label, roles: [], accounts: [] } : list[i];
  const merged: PersonItem = {
    ...existing,
    roles: role && !existing.roles.includes(role) ? [...existing.roles, role] : existing.roles,
    accounts:
      account && !existing.accounts.includes(account)
        ? [...existing.accounts, account]
        : existing.accounts,
  };
  const next = i === -1 ? [...list, merged] : list.map((p, j) => (j === i ? merged : p));
  return next.sort(byPersonRank);
}

/** One-line summary of a child subagent event, for the live activity log. */
function describeEvent(inner: StreamEvent): string | null {
  const d = (inner?.data ?? {}) as Record<string, unknown>;
  switch (inner?.type) {
    case "actions.requested":
      return "→ calling tools";
    case "action.result": {
      const tool = toolNameOf(d.result);
      return tool ? `✓ ${tool}` : "✓ tool result";
    }
    case "message.completed":
      return "wrote a reply";
    case "turn.completed":
      return "finished";
    case "turn.failed":
    case "session.failed":
      return "⚠ failed";
    default:
      return null;
  }
}

function applyToolResult(state: Insights, modelTool: string, out: Record<string, unknown>): Insights {
  let next = state;
  const tool = baseNameAmong(modelTool, RECORD_TOOLS);
  const addPerson = (name?: unknown, role?: string, account?: string) => {
    if (typeof name !== "string" || name.length === 0) return;
    for (const person of splitPeople(name)) {
      next = {
        ...next,
        people: upsertPerson(next.people, person.id, person.label, role, account),
      };
    }
  };

  const listed = fieldOf(out, "customers");
  const fetched = fieldOf(out, "customer");
  if (tool === "list_customers" && Array.isArray(listed)) {
    for (const c of listed as Array<Record<string, unknown>>) {
      if (typeof c.id === "string") {
        next = {
          ...next,
          customers: upsert(next.customers, {
            id: c.id,
            label: String(c.name ?? c.id),
            sub: [c.lifecycleStage, c.status, c.tier].filter(Boolean).join(" · ") || undefined,
          }),
        };
        // NB: intentionally NOT adding each customer's fdeOwner here. A bulk
        // directory scan returns dozens of customers, and surfacing every owner
        // floods the People rail with people who are not in this conversation's
        // context. People come from FOCUSED lookups (get_customer) instead.
      }
    }
  } else if (tool === "get_customer" && fetched) {
    const c = fetched as Record<string, unknown>;
    if (typeof c.id === "string") {
      next = {
        ...next,
        customers: upsert(next.customers, {
          id: c.id,
          label: String(c.name ?? c.id),
          sub: [c.lifecycleStage, c.status, c.tier].filter(Boolean).join(" · ") || undefined,
        }),
      };
      // The owner's label is the deployment's word ("Account owner" by default, "Covering analyst" on a research
      // deployment): it is shown next to a person's name and email, where the old product's word read as a
      // status the person had not earned yet.
      addPerson(fieldOf(c, "fdeOwner"), DEPLOYMENT_PROFILE.vocabulary.owner, String(c.name ?? c.id));
      if (Array.isArray(c.tickets)) {
        for (const ticket of c.tickets as Array<Record<string, unknown>>) {
          if (typeof ticket.ticketId === "string") {
            next = {
              ...next,
              workload: upsert(next.workload, {
                id: ticket.ticketId,
                label: String(ticket.summary ?? ticket.ticketId),
                sub:
                  [c.name, ticket.ticketDueDate, ticket.ticketPriority].filter(Boolean).join(" · ") ||
                  undefined,
              }),
            };
          }
        }
      }
    }
  } else if (tool === "list_followups" && Array.isArray(out.followUps)) {
    for (const ticket of out.followUps as Array<Record<string, unknown>>) {
      if (typeof ticket.ticketId === "string") {
        next = {
          ...next,
          workload: upsert(next.workload, {
            id: ticket.ticketId,
            label: String(ticket.summary ?? ticket.ticketId),
            sub:
              [fieldOf(ticket, "customerName"), ticket.ticketDueDate, ticket.ticketPriority]
                .filter(Boolean)
                .join(" · ") || undefined,
          }),
        };
      }
    }
  }
  return next;
}

const SUBAGENT_NAMES = new Set<string>([
  "configuration",
  "customer-context",
  "data-migration",
  "deployment",
  "evals",
  "follow-ups",
  // The document-generation / data-room builder. Without this it fell through to
  // applyToolResult and its runs never appeared in the Control Panel.
  "research",
  // Every declared subagent (discovered), so one added as a directory is attributed like the built-in ones.
  ...SUBAGENT_KEYS,
]);

/**
 * The subagent name of a delegation tool call, or null. eve 0.25 renamed the
 * delegation tools to `eve:subagent:<name>` — the prefix IS the signal, so any
 * prefixed call counts without maintaining a name list. The bare-name set stays
 * for chats recorded under eve 0.20.
 */
function subagentNameOf(toolName: string): string | null {
  if (toolName.startsWith("eve:subagent:")) return toolName.slice("eve:subagent:".length);
  return SUBAGENT_NAMES.has(toolName) ? toolName : null;
}

/** Best-effort child-session id from a delegation part's metadata/output. */
function childSessionIdOf(part: Record<string, unknown>): string | undefined {
  const meta = (part.toolMetadata as { eve?: Record<string, unknown> } | undefined)?.eve;
  for (const source of [meta, part.output as Record<string, unknown> | undefined]) {
    const v = source?.childSessionId ?? source?.sessionId;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Derive the Control Panel state directly from the projected messages, which
 * always contain the rendered tool calls (unlike the live event stream, which
 * starts empty on restored chats). Scans every dynamic-tool part: subagent
 * delegations feed the Subagents list; customer/people/follow-up tool outputs
 * feed the context lists.
 */
export function deriveInsights(messages: readonly { parts?: readonly unknown[] }[]): Insights {
  let state = emptyInsights;
  let auto = 0;
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      const part = p as {
        type?: string;
        toolName?: string;
        toolCallId?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
        state?: string;
      };
      if (part.type !== "dynamic-tool" || !part.toolName) continue;
      // A delegation's "reports later" stand-in is output, not a result: that specialist is still working.
      const reportsLater = part.state === "output-available" && isDetachedOutput(part.output);
      const done = !reportsLater && (part.state === "output-available" || part.output != null || !!part.errorText);

      // Browser tool FAILURE → record WHY so the Control Panel can say what went
      // wrong (a failed browser_open otherwise just yields no live-view card and
      // the operator sees nothing). Captures both a returned `{error}` and a
      // thrown tool error (`errorText`).
      if (part.toolName.startsWith("browser_")) {
        const outErr =
          part.output && typeof part.output === "object"
            ? (part.output as { error?: unknown }).error
            : undefined;
        const err = typeof outErr === "string" && outErr ? outErr : part.errorText;
        if (err && !state.browserErrors.some((b) => b.tool === part.toolName && b.error === err)) {
          state = {
            ...state,
            browserErrors: [...state.browserErrors, { tool: part.toolName, error: String(err).slice(0, 300) }],
          };
        }
      }

      const subagentName = subagentNameOf(part.toolName);
      if (subagentName) {
        const id = part.toolCallId ?? `${part.toolName}-${auto++}`;
        /**
         * A REPEATED id is a different run, not an update of the earlier one. Each delegation is one part, seen
         * once per pass, so meeting an id a second time means the model reused it — counter-style ids
         * (Kimi: functions.x:0, :1, …) restart after a compaction or in a new session. The filter below used
         * to treat that as "the same run, newer state" and DROPPED the earlier subagent from the list. New
         * conversations get unique ids at the model boundary (agent/lib/unique-tool-call-ids.ts); transcripts
         * recorded before that still carry the repeats, so the EARLIER run is re-keyed and kept. The newest
         * keeps the raw id, which is the one live events and "focus this subagent" will name.
         */
        const clash = state.subagents.find((s) => s.callId === id);
        if (clash) {
          let n = 1;
          while (state.subagents.some((s) => s.callId === `${id}~${n}`)) n++;
          state = { ...state, subagents: state.subagents.map((s) => (s === clash ? { ...s, callId: `${id}~${n}` } : s)) };
        }
        const brief = (part.input as { message?: string } | undefined)?.message;
        const output =
          typeof part.output === "string"
            ? part.output
            : part.output
              ? JSON.stringify(part.output).slice(0, 600)
              : part.errorText;
        state = {
          ...state,
          subagents: [
            ...state.subagents.filter((s) => s.callId !== id),
            {
              callId: id,
              name: subagentName,
              childSessionId: childSessionIdOf(part as Record<string, unknown>),
              status: done ? "done" : "running",
              ...(reportsLater ? { detached: true } : {}),
              output: reportsLater ? undefined : output,
              activity: brief ? [brief] : [],
              delegationPart: part,
            },
          ],
        };
      } else if (part.output && typeof part.output === "object") {
        state = applyToolResult(state, part.toolName, part.output as Record<string, unknown>);
        // A trigger_workflow / run_app call returns the durable run's id — record
        // it so the cockpit keeps that run visible after it finishes.
        if (part.toolName === "trigger_workflow" || part.toolName === "run_app") {
          const rid = (part.output as { runId?: unknown }).runId;
          if (typeof rid === "string" && rid && !state.workflowRunIds.includes(rid)) {
            state = { ...state, workflowRunIds: [...state.workflowRunIds, rid] };
          }
        }
        // Apps this chat created / edited / refreshed → scope the cockpit's Apps
        // section to them. create_app/update_app return `app.id` (uuid);
        // run_app returns `app` (the slug/name that was refreshed).
        if (part.toolName === "create_app" || part.toolName === "update_app") {
          const appId = (part.output as { app?: { id?: unknown } }).app?.id;
          if (typeof appId === "string" && appId && !state.appIds.includes(appId)) {
            state = { ...state, appIds: [...state.appIds, appId] };
          }
        }
        if (part.toolName === "run_app") {
          const appRef = (part.output as { app?: unknown }).app;
          if (typeof appRef === "string" && appRef && !state.appIds.includes(appRef)) {
            state = { ...state, appIds: [...state.appIds, appRef] };
          }
        }
        // browser_open returns a live-view URL — surface it so the operator can
        // watch the agent browse (esp. before approving a browser_act).
        if (part.toolName === "browser_open") {
          const out = part.output as { sessionRef?: unknown; liveViewUrl?: unknown };
          if (typeof out.liveViewUrl === "string" && out.liveViewUrl && typeof out.sessionRef === "string") {
            if (!state.browserLiveViews.some((b) => b.sessionRef === out.sessionRef)) {
              state = {
                ...state,
                browserLiveViews: [...state.browserLiveViews, { sessionRef: out.sessionRef, url: out.liveViewUrl }],
              };
            }
          }
        }
      }

      // Artifacts the call produced — file publishes and cron create/update —
      // need BOTH the input (filename / requested fields) and the output.
      const artifacts = applyArtifact(
        state.artifacts,
        part.toolName,
        (part.input ?? {}) as Record<string, unknown>,
        (part.output ?? {}) as Record<string, unknown>,
      );
      if (artifacts !== state.artifacts) state = { ...state, artifacts };
    }
  }
  return state;
}

/** Merge one person record (roles + accounts unioned) into a list. */
function mergePerson(list: PersonItem[], p: PersonItem): PersonItem[] {
  let next = list;
  if (!next.some((x) => x.id === p.id)) next = upsertPerson(next, p.id, p.label);
  for (const role of p.roles) next = upsertPerson(next, p.id, p.label, role);
  for (const account of p.accounts) next = upsertPerson(next, p.id, p.label, undefined, account);
  return next;
}

/**
 * Fold a CHILD session's projection into the parent's.
 *
 * A delegation is an implementation detail: the operator asked the orchestrator
 * for the work, so everything a subagent produced (published files, crons, apps,
 * browser sessions, workflow runs, context it pulled) has to read as if this
 * conversation produced it. Without this the Control Panel only ever showed the
 * ROOT session's own tool calls, and every object a subagent made was invisible.
 *
 * The parent wins on conflict — its own record of an object is the one the
 * conversation actually references.
 */
export function mergeInsights(parent: Insights, child: Insights): Insights {
  const dedupe = <T>(base: readonly T[], extra: readonly T[], same: (a: T, b: T) => boolean): T[] => {
    const out = [...base];
    for (const item of extra) if (!out.some((x) => same(x, item))) out.push(item);
    return out;
  };
  let people = parent.people;
  for (const p of child.people) people = mergePerson(people, p);
  return {
    subagents: dedupe(parent.subagents, child.subagents, (a, b) => a.callId === b.callId),
    customers: dedupe(parent.customers, child.customers, (a, b) => a.id === b.id),
    people,
    workload: dedupe(parent.workload, child.workload, (a, b) => a.id === b.id),
    artifacts: dedupe(parent.artifacts, child.artifacts, (a, b) => a.id === b.id),
    workflowRunIds: dedupe(parent.workflowRunIds, child.workflowRunIds, (a, b) => a === b),
    appIds: dedupe(parent.appIds, child.appIds, (a, b) => a === b),
    browserLiveViews: dedupe(
      parent.browserLiveViews,
      child.browserLiveViews,
      (a, b) => a.sessionRef === b.sessionRef,
    ),
    browserErrors: dedupe(
      parent.browserErrors,
      child.browserErrors,
      (a, b) => a.tool === b.tool && a.error === b.error,
    ),
  };
}

export function insightsReducer(state: Insights, ev: StreamEvent): Insights {
  const d = (ev?.data ?? {}) as Record<string, unknown>;
  switch (ev?.type) {
    case "subagent.called":
    case "subagent.started": {
      const callId = d.callId;
      if (typeof callId !== "string") return state;
      if (state.subagents.some((s) => s.callId === callId)) return state;
      return {
        ...state,
        subagents: [
          ...state.subagents,
          {
            callId,
            name: String(d.name ?? d.subagentName ?? "subagent"),
            childSessionId: typeof d.childSessionId === "string" ? d.childSessionId : undefined,
            status: "running",
            activity: [],
          },
        ],
      };
    }
    case "subagent.event": {
      const callId = d.callId;
      const inner = d.event as StreamEvent | undefined;
      if (typeof callId !== "string" || !inner) return state;
      let next = state;
      // Log the child's step in its activity feed.
      const line = describeEvent(inner);
      if (line) {
        next = {
          ...next,
          subagents: next.subagents.map((s) =>
            s.callId === callId ? { ...s, activity: [...s.activity.slice(-40), line] } : s,
          ),
        };
      }
      // A subagent does most of the tool work — surface its results in the panel
      // too, not just the parent's direct calls.
      if (inner.type === "action.result") {
        const innerData = (inner.data ?? {}) as Record<string, unknown>;
        const tool = toolNameOf(innerData.result);
        if (tool) {
          const out = ((innerData.result as Record<string, unknown>)?.output ?? {}) as Record<
            string,
            unknown
          >;
          next = applyToolResult(next, tool, out);
        }
      }
      return next;
    }
    case "subagent.completed": {
      const callId = d.callId;
      if (typeof callId !== "string") return state;
      return {
        ...state,
        subagents: state.subagents.map((s) =>
          s.callId === callId
            ? { ...s, status: "done", output: typeof d.output === "string" ? d.output : undefined }
            : s,
        ),
      };
    }
    case "action.result": {
      const res = (d.result ?? {}) as Record<string, unknown>;
      // A delegation's result (or its "reports later" stand-in, lib/detached-delegation.ts): the run's status.
      let next = state;
      if (res.kind === "subagent-result" && typeof res.callId === "string" && state.subagents.some((s) => s.callId === res.callId)) {
        const reportsLater = isDetachedResult(res);
        next = {
          ...state,
          subagents: state.subagents.map((s) =>
            // Only a detached run is settled here; any other keeps eve's own signal (`subagent.completed`), as before.
            s.callId !== res.callId ? s : reportsLater ? { ...s, detached: true } : s.detached ? { ...s, status: "done", detached: false } : s,
          ),
        };
      }
      const tool = toolNameOf(res);
      if (!tool) return next;
      return applyToolResult(next, tool, (res.output ?? {}) as Record<string, unknown>);
    }
    default:
      return state;
  }
}
