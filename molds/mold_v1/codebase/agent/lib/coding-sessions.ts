/**
 * coding-sessions.ts — turn a local coding-agent transcript into a compact,
 * REDACTED session summary that lands through the existing sync framework
 * (ingestSource, the deliveries domain, source "claude" | "codex").
 *
 * This is the spike from the "MCP for coding-agent history" discussion. The
 * conclusion there decides the shape:
 *
 *   - NOT an MCP, and NOT "all historical data". A coding session is worth
 *     capturing only as evidence of what a member did for a customer, so this
 *     produces ONE small record per session — repo, branch, the opening ask,
 *     what tools/files/commands it touched, and a span — not the raw transcript.
 *   - Secrets first. Transcripts are full of tokens, keys and customer data, and
 *     the whole posture is "never persist secrets". `redactSecrets` runs over
 *     every string that survives into the summary, and the summary deliberately
 *     keeps only low-cardinality signal (paths, tool names, command HEADS) rather
 *     than full command bodies or message text, so there is little to leak.
 *
 * Pure and side-effect-free: it parses text you hand it. The reader that finds
 * the files and the CLI that lands them live in scripts/, so this stays testable
 * and carries no filesystem or network dependency.
 */

/** A redaction rule: a pattern, and what to say instead. */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Secret shapes worth catching before anything is stored. This is deliberately
 * broad and errs toward over-redaction — a false positive costs a "[redacted]",
 * a false negative writes a live credential into the durable record.
 */
const REDACTIONS: RedactionRule[] = [
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted:slack-token]" },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[redacted:github-token]" },
  { name: "openai-key", pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[redacted:api-key]" },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "[redacted:api-key]" },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted:aws-key]" },
  { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[redacted:google-key]" },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[redacted:jwt]" },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[redacted:private-key]" },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, replacement: "Bearer [redacted]" },
  // A URL with inline credentials — postgres://user:pass@host, https://x:y@host.
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s:@/]+@/gi, replacement: "$1:[redacted]@" },
  // KEY=value / "token": "value" for anything that names itself a secret.
  { name: "assigned-secret", pattern: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,}]{6,})/gi, replacement: '$1$2[redacted]' },
];

/** Replace every recognised secret shape in a string. Safe on any input. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of REDACTIONS) out = out.replace(rule.pattern, rule.replacement);
  return out;
}

/** The compact, durable record for one coding session. */
export interface CodingSession {
  /** The transcript's own session id (stable across re-ingests → dedupe key). */
  sessionId: string;
  /** "claude" | "codex" — which agent produced it. */
  agent: string;
  /** Working directory the session ran in (repo root, usually). */
  cwd: string | null;
  /** Repo basename, derived from cwd — the closest thing to a project name. */
  repo: string | null;
  /** git branch, when the transcript recorded one. */
  branch: string | null;
  /** The agent's own one-line title for the session, if it set one. */
  title: string | null;
  /** The opening human ask, redacted and clipped — what the session set out to do. */
  opening: string | null;
  /** ISO timestamps of the first and last recorded events. */
  startedAt: string | null;
  endedAt: string | null;
  /** How many human turns — a rough size. */
  userTurns: number;
  /** Tool name → count (Bash, Edit, Read, …). */
  tools: Record<string, number>;
  /** Distinct files the session wrote to (Edit/Write targets), redacted paths. */
  filesTouched: string[];
  /** The HEAD of each shell command run — the verb, not the payload. Redacted. */
  commandHeads: string[];
}

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The first text of a message's content, whether string or content-part array. */
function firstText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as Json).type === "text") {
        return str((part as Json).text);
      }
    }
  }
  return null;
}

/** The command's first token-ish head (`git push …` → `git push`), for signal not payload. */
function commandHead(command: string): string {
  const line = command.trim().split("\n")[0];
  // Keep the program and its first subcommand/flagless arg; drop the rest.
  const words = line.split(/\s+/).slice(0, 2).join(" ");
  return words.length > 48 ? `${words.slice(0, 45)}…` : words;
}

/**
 * Parse one Claude Code transcript (`~/.claude/projects/<slug>/<uuid>.jsonl`)
 * into a session summary. Unknown/garbage lines are skipped, never thrown on —
 * a transcript is an append log written by another program and may be mid-write.
 */
export function parseClaudeTranscript(jsonl: string, fallbackId: string): CodingSession | null {
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  const commandHeads: string[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let opening: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let userTurns = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Json;
    try {
      o = JSON.parse(trimmed) as Json;
    } catch {
      continue;
    }

    sessionId ??= str(o.sessionId);
    cwd ??= str(o.cwd);
    branch ??= str(o.gitBranch);
    if (o.type === "ai-title") title = str(o.aiTitle) ?? title;

    const ts = str(o.timestamp);
    if (ts) {
      startedAt ??= ts;
      endedAt = ts;
    }

    const message = o.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Json;
    const content = msg.content;

    if (msg.role === "user") {
      userTurns++;
      if (opening === null) {
        const text = firstText(content);
        // Skip the harness's context-restore preamble — it is not the ask.
        if (text && !text.startsWith("This session is being continued")) {
          opening = text.slice(0, 280);
        }
      }
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Json;
        if (p.type !== "tool_use") continue;
        const name = str(p.name);
        if (!name) continue;
        tools[name] = (tools[name] ?? 0) + 1;
        const input = (p.input ?? {}) as Json;
        if ((name === "Edit" || name === "Write") && str(input.file_path)) {
          files.add(str(input.file_path) as string);
        }
        if (name === "Bash" && str(input.command)) {
          const head = commandHead(str(input.command) as string);
          if (head && !commandHeads.includes(head)) commandHeads.push(head);
        }
      }
    }
  }

  if (!sessionId && !cwd && Object.keys(tools).length === 0) return null;

  const repo = cwd ? cwd.split("/").filter(Boolean).pop() ?? null : null;
  // Redact everything free-text before it leaves this function.
  return {
    sessionId: sessionId ?? fallbackId,
    agent: "claude",
    cwd: cwd ? redactSecrets(cwd) : null,
    repo,
    branch,
    title: title ? redactSecrets(title) : null,
    opening: opening ? redactSecrets(opening) : null,
    startedAt,
    endedAt,
    userTurns,
    tools,
    filesTouched: [...files].map(redactSecrets).slice(0, 50),
    commandHeads: commandHeads.map(redactSecrets).slice(0, 40),
  };
}

/**
 * The `items[]` payload handed to `ingestSource({ domain: FOLDER.deliveries,
 * source: "claude", items })`. It is the summary itself — the passthrough
 * adapter lands it verbatim as the RawSyncRecord payload, and `id`/`sourceId`
 * is the session id so a re-ingest of the same session is recognisable.
 */
export function sessionToSyncItem(session: CodingSession): Record<string, unknown> {
  return { id: session.sessionId, ...session };
}
