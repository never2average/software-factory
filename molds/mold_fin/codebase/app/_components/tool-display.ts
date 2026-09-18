/**
 * Friendly display names and one-line argument summaries for tool calls.
 * Used by the chat's tool-cluster rows and standalone tool-card headers so the
 * transcript never shows raw identifiers like "eve:subagent:research".
 */

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
  get_customer: "Get customer",
  list_customers: "List customers",
  publish_artifact: "Publish artifact",
  web_search: "Web search",
};

/** Sentence case, matching the curated KNOWN_NAMES labels. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Curated display names for the declared subagents; the fallback title-cases
 *  each hyphen-separated word so an unknown id still reads as a proper noun. */
const SUBAGENT_NAMES: Record<string, string> = {
  browser: "Browser",
  research: "Research",
  configuration: "Configuration",
  "customer-context": "Customer Context",
  "data-migration": "Data Migration",
  deployment: "Deployment",
  evals: "Evals",
  "follow-ups": "Follow-ups",
  "workflow-author": "Workflow Author",
  "hfc-kpi-extraction": "HFC KPI Extraction",
  "lodr-filings": "LODR Filings",
  "investor-presentations": "Investor Presentations",
  "annual-report-format": "Annual Report Format",
};

/** What each declared subagent DOES — shown in the rail's info modal. */
const SUBAGENT_DESCRIPTIONS: Record<string, string> = {
  "hfc-kpi-extraction":
    "Builds the standard quarterly KPI table for a housing finance company from its LODR results and investor presentation, with the workspace's source-precedence, unit and formula rules and a citation for every value.",
  "lodr-filings":
    "Finds, files and reads a company's SEBI LODR disclosures by regulation — results, material events, shareholding, related parties, security cover, annual report — and keeps its dated filing log.",
  "investor-presentations":
    "Reads investor presentations and concall transcripts slide by slide: operational metrics, management guidance and how it changed, and the company's own metric definitions. Uses the parent's deck for unlisted HFCs.",
  "annual-report-format":
    "Maps an HFC annual report and extracts its sections into a consistent structure: Directors' Report, MD&A, Ind AS 109 notes, RBI HFC disclosures, related parties, auditor's report and CARO.",
  research:
    "Builds an account's full context from scratch: company research (web + Granola), the customer's data-room domains (Platform, Deployments, Solutions, Implementation, Tickets, People), and publishes the domain workbooks.",
  configuration:
    "Owns how a customer's platform is configured — models, connections, feature flags, guardrails — plus solution contracts and recipes. Flags risky changes for human approval.",
  "customer-context":
    "Pulls a customer's full picture: record, interactions, tickets, health. The go-to for briefs, QBR prep, and status assessments.",
  "data-migration":
    "Plans and tracks data migrations: source analysis, mapping, volume, validation, and rollback approaches under Implementation/.",
  deployment:
    "Owns deployment infrastructure and the 4-party signoff chain: sizing across the eight infra domains, customizations, and go-live readiness.",
  evals:
    "Runs and interprets evaluation suites for agents and pipelines: datasets, benchmarks, regressions, and proposed fixes.",
  "follow-ups":
    "Works the ticket queue: files and triages tickets, nudges owners, escalates via PagerDuty, and tracks follow-through.",
  "workflow-author":
    "Writes and edits operator workflow scripts (the QuickJS agent()/phase() orchestrations) against the platform's validator.",
};

/** Info-modal copy for a subagent; generic fallback for unknown ids. */
export function subagentDescription(name: string): string {
  return (
    SUBAGENT_DESCRIPTIONS[name] ??
    "A delegated specialist agent with its own instructions, tools, and session."
  );
}

/** "customer-context" -> "Customer Context". Rail rows, detail headers, and the
 *  chat's delegation cards all format through here so the name never appears as
 *  a raw hyphenated identifier anywhere. */
export function subagentDisplayName(name: string): string {
  const known = SUBAGENT_NAMES[name];
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
  return KNOWN_NAMES[toolName] ?? sentenceCase(toolName.replace(/_/g, " ").toLowerCase());
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

  switch (toolName) {
    case "get_customer": {
      const id = firstString(obj, ["id", "customerId", "customer_id"]);
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
