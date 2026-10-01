/**
 * Friendly display names and one-line argument summaries for tool calls.
 * Used by the chat's tool-cluster rows and standalone tool-card headers so the
 * transcript never shows raw identifiers like "eve:subagent:research".
 */
import { SUBAGENT_META } from "./subagent-meta.generated";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
// The agent's model-facing tool names follow the profile (`get_company` for `get_customer`): look up by base name.
import { baseNameAmong, canonicalToolName, modelToolName, speakIdentifier } from "@/agent/lib/agent-vocabulary";

/** What this deployment calls a customer. Tool IDENTIFIERS never change — only the label a person reads. */
const ACCOUNT = DEPLOYMENT_PROFILE.vocabulary.account;


const SUBAGENT_PREFIX = "eve:subagent:";

const KNOWN_NAMES: Record<string, string> = {
  ask_question: "Question",
  browser_open: "Open browser",
  browser_goto: "Navigate",
  browser_read: "Read page",
  browser_act: "Act on page",
  browser_login: "Log in",
  browser_screenshot: "Screenshot",
  browser_wait: "Wait for page",
  browser_close: "Close browser",
  create_ticket: "Create ticket",
  create_triage_ticket: "Stage triage draft",
  dataroom_list: "List data room",
  dataroom_read: "Read data room",
  dataroom_write_doc: "Write data-room doc",
  get_customer: `Get ${ACCOUNT.singular}`,
  list_customers: `List ${ACCOUNT.plural}`,
  publish_artifact: "Publish artifact",
  web_search: "Web search",
};

/** Sentence case, matching the curated KNOWN_NAMES labels. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Curated display names where the title-cased key reads wrong. Every other declared subagent is named by
 *  SUBAGENT_META (subagent.json "name", else the title-cased key) — generated in the deployment profile's words,
 *  so a relabelled deployment never reads a base word in a specialist's name; an unknown id title-cases below. */
const SUBAGENT_NAMES: Record<string, string> = {
  "follow-ups": "Follow-ups",
};

/** Info-modal copy for a subagent: what it declares (SUBAGENT_META, in the profile's words); generic fallback for
 *  unknown ids. */
export function subagentDescription(name: string): string {
  return SUBAGENT_META[name]?.summary || "A delegated specialist agent with its own instructions, tools, and session.";
}

/** "customer-context" -> "Customer Context". Rail rows, detail headers, and the
 *  chat's delegation cards all format through here so the name never appears as
 *  a raw hyphenated identifier anywhere. */
export function subagentDisplayName(name: string): string {
  const known = SUBAGENT_NAMES[name] ?? SUBAGENT_META[name]?.name;
  if (known) return known;
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** "eve:subagent:research" -> "Research subagent"; known tools get a curated
 *  label; anything else falls back to snake_case -> space-separated Sentence
 *  case, so every path shares one casing regime. */
export function toolDisplayName(toolName: string): string {
  if (toolName.startsWith(SUBAGENT_PREFIX)) {
    const name = toolName.slice(SUBAGENT_PREFIX.length).trim();
    return name ? `${subagentDisplayName(name)} subagent` : "Subagent";
  }
  // The fallback speaks the deployment's vocabulary too: "update_customer" -> "Update customer" by default,
  // "Update company" where a profile renames the account noun. A tool's old name in a stored transcript
  // (TOOL_ALIASES) is shown as the tool it is now, under the name this deployment's model calls it by.
  const current = canonicalToolName(toolName) === toolName ? toolName : modelToolName(canonicalToolName(toolName));
  const base = baseNameAmong(current, Object.keys(KNOWN_NAMES));
  return (
    KNOWN_NAMES[base] ??
    sentenceCase(
      current
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\bcustomers\b/g, ACCOUNT.plural)
        .replace(/\bcustomer\b/g, ACCOUNT.singular),
    )
  );
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** One-line summary of a tool call's arguments, or null when there is nothing
 *  short and human-readable to show. */
export function toolCallSummary(toolName: string, input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;

  if (toolName.startsWith(SUBAGENT_PREFIX)) {
    const message = firstString(obj, ["message", "prompt", "task"]);
    return message ? truncate(message) : null;
  }

  switch (baseNameAmong(toolName, ["get_customer", "dataroom_read", "dataroom_list", "dataroom_write_doc", "web_search"])) {
    case "get_customer": {
      const id = firstString(obj, ["id", "customerId", "customer_id", ...["customerId", "customer_id"].map((k) => speakIdentifier(k))]);
      return id ? truncate(id) : null;
    }
    case "dataroom_read":
    case "dataroom_list":
    case "dataroom_write_doc": {
      const path = firstString(obj, ["path", "prefix"]);
      return path ? truncate(path) : null;
    }
    case "web_search": {
      const query = firstString(obj, ["query", "q"]);
      return query ? truncate(query) : null;
    }
    default: {
      for (const value of Object.values(obj)) {
        if (typeof value === "string" && value.trim()) return truncate(value);
      }
      return null;
    }
  }
}
