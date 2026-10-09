/**
 * Application-owned prompt/context governance.
 *
 * Eve continues to own conversation history, tool-call pairing, durable
 * streams, and context-window compaction. This module governs only the dynamic
 * records this application adds to Eve's system instructions.
 */
import type { ModelMessage } from "ai";
import { outputForModel, speak } from "./agent-vocabulary.ts";

export const STABLE_PROMPT_BOUNDARY = "<!-- stable-prompt-end -->";
export const ORGANIZATION_POLICY_MARKER = "<!-- organization-policy -->";
export const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

export const CONTEXT_BUDGETS = {
  memory: { maxItems: 20, maxTokens: 1_200 },
  schedules: { maxItems: 10, maxTokens: 900 },
  rooms: { maxItems: 30, maxTokens: 500 },
  roster: { maxItems: 20, maxTokens: 700 },
  operatorOverride: { maxItems: 1, maxTokens: 500 },
  agentConfiguration: { maxItems: 20, maxTokens: 600 },
  profile: { maxItems: 1, maxTokens: 500 },
  workflowDefinitions: { maxItems: 20, maxTokens: 1_400 },
} as const;

export type PromptMode =
  | "direct-conversation"
  | "autonomous-scheduled"
  | "delegated-subagent";

interface PrincipalLike {
  readonly principalId?: string;
  readonly principalType?: string;
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
}

export interface PromptModeContext {
  readonly channel?: { readonly kind?: string };
  readonly session?: {
    readonly auth?: {
      readonly current?: PrincipalLike | null;
      readonly initiator?: PrincipalLike | null;
    };
  };
}

function principalEmail(principal: PrincipalLike | null | undefined): string | undefined {
  const value = principal?.attributes?.email;
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

/** Resolve one and only one execution frame from authoritative runtime data. */
export function resolvePromptMode(ctx: PromptModeContext): PromptMode {
  const kind = ctx.channel?.kind?.toLowerCase() ?? "unknown";
  if (kind === "subagent" || kind.startsWith("subagent:")) return "delegated-subagent";
  if (kind === "schedule" || kind.startsWith("schedule:")) return "autonomous-scheduled";

  const principal = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
  const type = principal?.principalType?.toLowerCase() ?? "";
  const human = Boolean(principalEmail(principal)) || ["user", "human", "member"].includes(type);
  return human ? "direct-conversation" : "autonomous-scheduled";
}

const MODE_COPY: Record<PromptMode, readonly string[]> = {
  "direct-conversation": [
    "You are in a live conversation with an authenticated workspace member.",
    "Answer the current request directly, surface consequential choices, and use human-in-the-loop approval where the active tool requires it.",
  ],
  "autonomous-scheduled": [
    "You are running autonomously from a schedule or trusted service trigger.",
    "Complete the bounded task without waiting for chat input; make side effects idempotent and report blockers through the requested delivery channel.",
  ],
  "delegated-subagent": [
    "You are executing a delegated subtask in an isolated child session.",
    "Use only the self-contained brief and authorized sources provided to this child; return a concise result to the parent and do not assume access to the parent's conversation history.",
  ],
};

export function renderPromptMode(mode: PromptMode): string {
  return [
    `<prompt-mode name="${mode}">`,
    `## Execution mode: ${mode}`,
    "",
    ...MODE_COPY[mode],
    "</prompt-mode>",
  ].join("\n");
}

export type ContextTrust = "untrusted" | "security-tainted" | "secret";

export interface ContextAudience {
  readonly orgId: string;
  /** Empty/omitted means every entitled member of the organization. */
  readonly principals?: readonly string[];
}

export interface ContextEnvelope {
  readonly id: string;
  readonly source: string;
  readonly provenance: string;
  readonly audience: ContextAudience;
  readonly observedAt: string;
  readonly trust: ContextTrust;
  /** Data is serialized as data; it is never interpolated as instructions. */
  readonly data: unknown;
}

export interface ContextViewer {
  readonly orgId: string;
  readonly principalId?: string;
  /** Principals whose shared-history scope this viewer is entitled to read. */
  readonly entitledPrincipals?: readonly string[];
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?[^\s,"']{8,}/i,
  /\b(?:sk|xox[baprs]|gh[opsu])_[A-Za-z0-9_-]{12,}\b/,
] as const;

export function containsSecretLikeValue(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return true;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(serialized));
}

/**
 * Audience intersection is fail closed: org must match; targeted records must
 * include the viewer; and every named audience principal must be inside the
 * entitlement set supplied by the application that owns the shared context.
 */
export function isContextVisible(entry: ContextEnvelope, viewer: ContextViewer): boolean {
  if (entry.trust !== "untrusted" || entry.audience.orgId !== viewer.orgId) return false;
  if (containsSecretLikeValue(entry.data)) return false;
  const audience = entry.audience.principals ?? [];
  if (audience.length === 0) return true;
  if (!viewer.principalId || !audience.includes(viewer.principalId)) return false;
  const entitled = new Set(viewer.entitledPrincipals ?? [viewer.principalId]);
  return audience.every((principal) => entitled.has(principal));
}

export function estimatePromptTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function serializeEnvelope(entry: ContextEnvelope, maxChars: number): string | null {
  const base = {
    id: entry.id,
    source: entry.source,
    provenance: entry.provenance,
    audience: entry.audience,
    observedAt: entry.observedAt,
    trust: entry.trust,
  };
  let data: string;
  try {
    data = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data);
  } catch {
    return null;
  }
  let serialized = JSON.stringify({ ...base, data });
  if (serialized.length <= maxChars) return serialized;
  const emptySize = JSON.stringify({ ...base, data: "" }).length;
  if (emptySize >= maxChars) return null;
  data = truncateToTokenBudget(data, Math.floor((maxChars - emptySize) / 4));
  serialized = JSON.stringify({ ...base, data });
  while (serialized.length > maxChars && data.length > 0) {
    data = data.slice(0, -1);
    serialized = JSON.stringify({ ...base, data: `${data}…` });
  }
  return serialized.length <= maxChars ? serialized : null;
}

/** Render a hard-bounded volatile block containing only entitled records. */
export function renderContextBlock(input: {
  readonly name: string;
  readonly guidance: string;
  readonly entries: readonly ContextEnvelope[];
  readonly viewer: ContextViewer;
  readonly maxItems: number;
  readonly maxTokens: number;
}): string | null {
  const prefix = [
    `<volatile-context name="${input.name}" trust="untrusted">`,
    `## ${input.name}`,
    "",
    speak(input.guidance),
    "",
  ].join("\n");
  const suffix = "\n</volatile-context>";
  const maxChars = input.maxTokens * 4;
  if (prefix.length + suffix.length > maxChars) return null;
  const lines: string[] = [];
  let used = prefix.length + suffix.length;
  for (const entry of input.entries.filter((candidate) => isContextVisible(candidate, input.viewer)).slice(0, input.maxItems)) {
    const remaining = maxChars - used - (lines.length > 0 ? 1 : 0);
    // The records in the deployment's words (keys, stored enum values, paths, memory scopes); identity by default.
    const line = serializeEnvelope({ ...entry, data: outputForModel(entry.data) }, remaining);
    if (!line) continue;
    lines.push(line);
    used += line.length + (lines.length > 1 ? 1 : 0);
  }
  if (lines.length === 0) return null;
  return `${prefix}${lines.join("\n")}${suffix}`;
}

export interface AppOwnedHistoryEntry extends ContextEnvelope {
  readonly role: "user" | "assistant" | "tool-call" | "tool-result" | "context-fallback";
  readonly callId?: string;
}

export const EMPTY_CONTEXT_FALLBACK =
  "No entitled application context is available. Re-read the authoritative source instead of inferring missing history.";
export const INTERRUPTED_TOOL_FALLBACK =
  "The application-owned tool call was interrupted before a result was recorded. Re-run it if the result is still needed.";

/**
 * Normalize only history assembled by this app (never Eve's native history):
 * drop invisible/orphan results and synthesize deterministic interrupted
 * results so a future app-owned replay cannot send malformed tool history.
 */
export function normalizeAppOwnedHistory(
  entries: readonly AppOwnedHistoryEntry[],
  viewer: ContextViewer,
): AppOwnedHistoryEntry[] {
  const visible = entries.filter((entry) => isContextVisible(entry, viewer));
  const callIds = new Set(
    visible.filter((entry) => entry.role === "tool-call" && entry.callId).map((entry) => entry.callId as string),
  );
  const resultIds = new Set(
    visible.filter((entry) => entry.role === "tool-result" && entry.callId).map((entry) => entry.callId as string),
  );
  const normalized: AppOwnedHistoryEntry[] = [];
  for (const entry of visible) {
    if (entry.role === "tool-result" && (!entry.callId || !callIds.has(entry.callId))) continue;
    normalized.push(entry);
    if (entry.role === "tool-call" && entry.callId && !resultIds.has(entry.callId)) {
      normalized.push({
        ...entry,
        id: `${entry.id}:interrupted-result`,
        role: "tool-result",
        provenance: "deterministic-interrupted-tool-fallback",
        data: INTERRUPTED_TOOL_FALLBACK,
      });
    }
  }
  if (normalized.length > 0) return normalized;
  return [{
    id: "context:fallback",
    source: "application-context-filter",
    provenance: "deterministic-empty-context-fallback",
    audience: { orgId: viewer.orgId, principals: viewer.principalId ? [viewer.principalId] : undefined },
    observedAt: new Date(0).toISOString(),
    trust: "untrusted",
    role: "context-fallback",
    data: EMPTY_CONTEXT_FALLBACK,
  }];
}

function messageText(message: ModelMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export function compactionReason(messages: readonly ModelMessage[]): "eve-context-window" | "none" {
  return messages[0]?.role === "user" && messageText(messages[0]) === COMPACTION_CHECKPOINT_MARKER
    ? "eve-context-window"
    : "none";
}

export function promptModeFromInstructions(instructions: string): PromptMode | "unknown" {
  const match = instructions.match(/<prompt-mode name="([^"]+)">/);
  return match && Object.hasOwn(MODE_COPY, match[1]) ? (match[1] as PromptMode) : "unknown";
}

export function promptTelemetry(instructions: string, messages: readonly ModelMessage[]) {
  const boundary = instructions.indexOf(STABLE_PROMPT_BOUNDARY);
  const stable = boundary >= 0
    ? instructions.slice(0, boundary + STABLE_PROMPT_BOUNDARY.length)
    : instructions;
  const volatile = boundary >= 0
    ? instructions.slice(boundary + STABLE_PROMPT_BOUNDARY.length)
    : "";
  return {
    mode: promptModeFromInstructions(instructions),
    stableTokens: estimatePromptTokens(stable),
    volatileTokens: estimatePromptTokens(volatile),
    compactionReason: compactionReason(messages),
  };
}
