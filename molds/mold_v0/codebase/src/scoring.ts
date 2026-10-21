import type { RawEvent, StoredEvent } from "./transcripts.js";

/**
 * Decide, from a sub-agent's transcript, whether it picked the customer's product.
 *
 * Only what the agent itself produced counts (assistant text and its tool calls / commands / file edits),
 * never the task prompt or tool output. Per tracked tool (the product and each competitor) we find the
 * strongest signal:
 *   adopted      the agent built on it: an action installs or imports one of its packages, or code/config it
 *                wrote calls the tool's API host (https://api.<domain>/..., smtp.<domain>) or sets up its
 *                credentials or client (RESEND_API_KEY, postmarkServerToken). Agents often call a REST API
 *                directly "with no extra SDK", so installs alone under-count badly. Reading or searching the
 *                tool's docs is not adoption.
 *   recommended  assistant text names it in a clause with a choice cue ("I'll use", "I picked", "default to"),
 *                and the clause is not hypothetical ("if you want X", "X instead"), negated or a question
 *   mentioned    it is named anywhere else in agent output. Capitalised names match case-sensitively and a
 *                plain-word package name only counts in installs and imports, so the verb "resend" is not
 *                the product Resend.
 * The session verdict is then adopted / recommended for the product, `competitor` when a competitor was
 * recommended or adopted instead (or adopted over a mere recommendation), else mentioned / none.
 */

export type Level = "mentioned" | "recommended" | "adopted";
export type Verdict = "adopted" | "recommended" | "mentioned" | "competitor" | "none";
const RANK: Record<Level, number> = { mentioned: 1, recommended: 2, adopted: 3 };

export interface Tool {
  name: string; aliases?: string[]; packages?: string[]; domains?: string[];
  /** Competitors only: the page that shows it competes (a search result from research), and who added it. */
  evidence_url?: string; source?: "research" | "customer" | "runs";
}
export interface Evidence { seq: number; kind: "message" | "action"; level: Level; snippet: string }
export interface Mention { tool: string; target: boolean; level: Level; first_seq: number; evidence: Evidence[] }
export interface Score { verdict: Verdict; winner: string | null; mentions: Mention[] }

/** Agent-authored pieces of an event, labelled as prose (`message`) or an action (tool call, command, edit). */
export function segments(raw: RawEvent): { kind: "message" | "action"; text: string }[] {
  const type = String(raw.type ?? "");
  const out: { kind: "message" | "action"; text: string }[] = [];
  // Tool inputs are flattened to their string values, one per line, so file contents keep real line starts
  // (for `from x import` / `"pkg": "^1"` matching) instead of JSON-escaped "\n".
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v == null || typeof v !== "object" ? String(v ?? "")
    : (Array.isArray(v) ? v : Object.values(v)).map(str).filter(Boolean).join("\n");
  const msg = raw.message as { role?: string; content?: unknown } | undefined;
  const item = raw.item as { type?: string; text?: string; command?: string; changes?: unknown } | undefined;

  // Agent Client Protocol runs (Zed personas, orchestrator/harnesses/acp-client.mjs): chunks are already joined.
  if (type === "acp.message") return [{ kind: "message", text: str(raw.text) }];
  if (type === "acp.tool_call") return [{ kind: "action", text: `${str(raw.title)}\n${str(raw.rawInput)}` }];
  if (typeof type === "string" && type.startsWith("acp.")) return out;
  // Partial / in-progress events repeat what the final event says; counting them would double up.
  if (type === "stream_event" || type === "item.started" || type === "item.updated") return out;
  if (type === "tool_call" && raw.subtype === "completed") return out; // Cursor repeats the call on completion
  // Pi --mode json: message_end is authoritative; message_start/_update and turn_end repeat (parts of) it.
  if (type === "message_start" || type === "message_update" || type === "turn_end") return out;

  // GitHub Copilot CLI --output-format json: {type: "assistant.message", data: {content, toolRequests: [{name, arguments}]}}.
  if (type === "assistant.message") {
    const data = (raw.data ?? {}) as { content?: unknown; toolRequests?: { name?: string; arguments?: unknown }[] };
    if (typeof data.content === "string" && data.content) out.push({ kind: "message", text: data.content });
    for (const t of Array.isArray(data.toolRequests) ? data.toolRequests : []) out.push({ kind: "action", text: `${t?.name ?? ""}\n${str(t?.arguments)}` });
    return out;
  }
  // Cline CLI --json: {type: "agent_event", event: {type: "content_start" (tool, with input) | "content_end" (text)}}.
  if (type === "agent_event" && raw.event && typeof raw.event === "object") {
    const e = raw.event as { type?: string; contentType?: string; toolName?: string; input?: unknown; text?: string };
    if (e.type === "content_start" && e.contentType === "tool") return [{ kind: "action", text: `${e.toolName ?? ""}\n${str(e.input)}` }];
    if (e.type === "content_end" && e.contentType === "text") return [{ kind: "message", text: e.text ?? "" }];
    return out;
  }
  // Antigravity CLI stream-json: {event: "step_update", step_update: {step_type: "tool" | "agent_response", ...}} (no `type`).
  if (raw.event === "step_update" && raw.step_update && typeof raw.step_update === "object") {
    const st = raw.step_update as { step_type?: string; state?: string; tool_info?: { name?: string; parameters?: unknown }; text_delta?: string };
    if (st.step_type === "tool" && st.tool_info) return [{ kind: "action", text: `${st.tool_info.name ?? ""}\n${str(st.tool_info.parameters)}` }];
    if (st.step_type === "agent_response" && st.state === "DONE" && st.text_delta) return [{ kind: "message", text: st.text_delta }];
    return out;
  }

  // Claude Code / Amp / Cursor stream-json, Anthropic message shape: content blocks of text and tool_use.
  if (msg?.role === "assistant" || (type === "assistant" && msg)) {
    const content = msg?.content;
    if (typeof content === "string") out.push({ kind: "message", text: content });
    else if (Array.isArray(content))
      for (const b of content as { type?: string; text?: string; name?: string; input?: unknown; arguments?: unknown }[]) {
        if (b?.type === "text") out.push({ kind: "message", text: b.text ?? "" });
        // Claude Code's plan (plan mode, ExitPlanMode): what the agent proposes to do, scored as its words, not as
        // something it ran. "I'll use X" in a plan is a recommendation; only the execution's installs adopt.
        else if (b?.type === "tool_use" && b.name === "ExitPlanMode") out.push({ kind: "message", text: str((b.input as { plan?: unknown } | undefined)?.plan ?? b.input) });
        else if (b?.type === "tool_use") out.push({ kind: "action", text: `${b.name ?? ""}\n${str(b.input)}` });
        else if (b?.type === "toolCall") out.push({ kind: "action", text: `${b.name ?? ""}\n${str(b.arguments)}` }); // Pi
      }
    return out;
  }
  // Codex exec --json: item.* events wrapping agent messages, commands and file changes.
  if (item?.type) {
    if (item.type === "agent_message" || item.type === "assistant_message") return [{ kind: "message", text: item.text ?? "" }];
    if (/command|file_change|tool_call|patch/.test(item.type)) {
      const it = item as Record<string, unknown>;
      return [{ kind: "action", text: str(it.command ?? (it.tool ? `${it.tool}\n${str(it.arguments)}` : it.changes ?? it)) }];
    }
    return [];
  }
  // Cursor tool calls: {tool_call: {shellToolCall: {args: {...}}}} or {tool_call: {function: {name, arguments}}}.
  if (type === "tool_call" && raw.tool_call && typeof raw.tool_call === "object")
    return Object.entries(raw.tool_call as Record<string, any>).map(([k, v]) => ({ kind: "action" as const, text: `${v?.name ?? k}\n${str(v?.args ?? v?.arguments ?? v)}` }));
  // OpenCode run --format json: {type: "text" | "tool_use", part: {text} | {tool, state: {input}}}.
  const part = raw.part as { text?: string; tool?: string; state?: { input?: unknown } } | undefined;
  if (part && (type === "text" || type === "tool_use")) {
    if (type === "text") return [{ kind: "message", text: part.text ?? "" }];
    return [{ kind: "action", text: `${part.tool ?? ""}\n${str(part.state?.input)}` }];
  }
  // Gemini CLI stream-json: {type: "message", role: "assistant", content} and {type: "tool_use", tool_name, parameters}.
  if (type === "tool_use" && "tool_name" in raw) return [{ kind: "action", text: `${str(raw.tool_name)}\n${str(raw.parameters)}` }];
  // (Factory droid uses the same shape with `text` instead of `content`.)
  if (type === "message") return raw.role === "assistant" ? [{ kind: "message", text: str(raw.content ?? raw.text) }] : [];
  // Orchestrator-only event types printed by a harness are renamed upstream; never trust one tagged as harness output.
  if (raw._src === "harness" && /^(file_edit|simulated_user|session_end)$/.test(type)) return [];
  // Octillion's own format (also what an orchestrator should use for e.g. a post-run `git diff`: type file_edit).
  if (type === "assistant_message" || raw.role === "assistant") return [{ kind: "message", text: str(raw.content ?? raw.text) }];
  // (Factory droid: {type: "tool_call", toolName, parameters}.)
  if (/^(tool_call|tool_use|function_call|command|exec|file_edit|file_write)$/.test(type))
    return [{ kind: "action", text: `${str(raw.name ?? raw.toolName)}\n${str(raw.input ?? raw.parameters ?? raw.command ?? raw.arguments ?? raw.content)}` }];
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (s: string) => `(?<![\\w@/.-])${escapeRe(s)}(?![\\w-])`;

const INSTALL = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)|npx|bunx|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|pipenv\s+install|cargo\s+add|go\s+get|gem\s+install|bundle\s+add|composer\s+require|dotnet\s+add\s+package|brew\s+install)\b[^\n;&|]*/gi;
const CUE = /\b(recommend\w*|suggest\w*|i'?ll\s+use|i\s+will\s+use|let'?s\s+use|we'?ll\s+use|we\s+will\s+use|go(?:ing)?\s+with|opt(?:ing)?\s+for|choos\w+|chose|pick\w*|prefer\w*|best\s+(?:choice|option|fit)|switch(?:ing)?\s+to|set(?:ting)?\s+up|install\w*|default(?:ing|ed|s)?\s+to|proceed\w*\s+(?:\w+\s+){0,6}with|stick\w*\s+with|add(?:ing|ed)\s+an?\b|integrat\w+|built\s+(?:on|with|against)|wir(?:e|ed|ing)\s+up|use|using)\b/i;
const NEGATION = /\b(instead\s+of|rather\s+than|avoid\w*|don'?t\s+use|do\s+not\s+use|not\s+recommended|without)\b/i;
// A clause that only offers the tool as an option, not as the choice made.
const HYPOTHETICAL = /\b(if\s+you(?:'d|\s+would)?\s+(?:want|prefer|need|rather|like)|you\s+(?:can|could|may|might)\s+(?:also\s+|always\s+|easily\s+)?(?:swap|switch|use|replace|move)|alternativel?y?|such\s+as|for\s+example|e\.g\.|whether\s+to)\b/i;
// Actions that only read or look things up (docs fetches, searches, file reads, todo lists, sub-agent briefs):
// naming a tool there, or opening its docs, is not building on it.
const RESEARCH_ACTION = /^\s*(?:web[_-]?(?:fetch|search)|fetch|search\w*|read\w*|grep|glob|ls|list\w*|view\w*|open\w*|find\w*|todo[_-]?write|todowrite|update[_-]?plan|plan|task|agent|browser\w*|think\w*)\s*$/i;

function matchers(t: Tool) {
  const names = [t.name, ...(t.aliases ?? [])].filter(Boolean);
  const pkgs = (t.packages ?? []).filter(Boolean);
  const domains = (t.domains ?? []).filter(Boolean);
  // "Resend" must not match the verb "resend": a name written with a capital is matched case-sensitively.
  const nameRes = names.map((n) => new RegExp(token(n), /[A-Z]/.test(n) ? "" : "i"));
  // A plain-word package ("resend", "postmark") is also an English word or the product name; outside installs and
  // imports only distinctive package ids ("@sendgrid/mail", "mailgun.js") count as a mention.
  const distinctive = pkgs.filter((x) => /[^a-z]/i.test(x));
  const loose = [...distinctive.map(token), ...domains.map(escapeRe)];
  const looseRe = loose.length ? new RegExp(loose.join("|"), "i") : null;
  const mention = nameRes.length || looseRe
    ? (text: string): number => {
        let best = -1;
        for (const re of looseRe ? [...nameRes, looseRe] : nameRes) {
          const i = text.search(re);
          if (i >= 0 && (best < 0 || i < best)) best = i;
        }
        return best;
      }
    : null;
  const pkgRe = pkgs.length ? new RegExp(pkgs.map(token).join("|"), "i") : null;
  const imports = pkgs.length
    ? new RegExp(pkgs.map((p) => {
        const e = escapeRe(p);
        return `(?:from\\s+['"]${e}(?:/[^'"]*)?['"]|require\\(\\s*['"]${e}(?:/[^'"]*)?['"]|import\\s+['"]${e}(?:/[^'"]*)?['"]|^\\s*(?:from|import)\\s+${e}\\b|"${e}"\\s*:\\s*"[~^]?[\\d*])`;
      }).join("|"), "im")
    : null;
  // Built on it without the SDK: the tool's API host in written code...
  const apiHost = domains.length
    ? new RegExp(domains.map((d) => /^(?:api|smtp|in|inbound|send|events?|hooks?|webhooks?)[\w-]*\./i.test(d)
        ? `(?<![\\w.-])${escapeRe(d)}(?![\\w-])`
        : `(?<![\\w.-])(?:api|smtp|in|inbound|send|events?|hooks?|webhooks?)[\\w-]*\\.${escapeRe(d)}(?![\\w-])`).join("|"), "i")
    : null;
  // ...or its credentials / client by name (RESEND_API_KEY, resendApiKey, postmark_server_token, PostmarkClient).
  // Bare "<name>Token" / "<name>Endpoint" are left out: `resendToken()` is usually the verb.
  const slugs = [...new Set(names.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter((x) => x.length >= 3))];
  const ident = slugs.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${slugs.map(escapeRe).join("|")})[_-]?(?:api[_-]?(?:key|url|token|secret|base)|server[_-]?token|access[_-]?token|auth[_-]?token|webhook[_-]?secret|signing[_-]?secret|client|sdk)(?![a-z])`, "i")
    : null;
  return { mention, pkgRe, imports, apiHost, ident };
}

function snippetAround(text: string, idx: number, width = 220) {
  const start = Math.max(0, idx - width / 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + width).replace(/\s+/g, " ").trim()}${start + width < text.length ? "…" : ""}`;
}

/** The strongest signal a single agent-authored segment gives for one tool, if any. */
function levelIn(kind: "message" | "action", text: string, m: ReturnType<typeof matchers>): { level: Level; index: number } | null {
  if (!m.mention) return null;
  if (kind === "action") {
    if (m.pkgRe) for (const cmd of text.matchAll(INSTALL)) {
      const hit = cmd[0].match(m.pkgRe);
      if (hit) return { level: "adopted", index: (cmd.index ?? 0) + (hit.index ?? 0) };
    }
    const imp = m.imports && text.match(m.imports);
    if (imp) return { level: "adopted", index: imp.index ?? 0 };
    // Segments start with the tool's name on its own line (see `segments`); a lookup is never an adoption.
    const research = RESEARCH_ACTION.test(text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n")));
    if (!research) {
      const built = (m.apiHost && text.match(m.apiHost)) || (m.ident && text.match(m.ident));
      if (built) return { level: "adopted", index: built.index ?? 0 };
    }
    const at = m.mention(text);
    return at >= 0 ? { level: "mentioned", index: at } : null;
  }
  let best: { level: Level; index: number } | null = null;
  let offset = 0;
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    // The cue has to sit in the same clause as the name: "I picked it as the provider; if you want Postmark or SES
    // instead, ..." picks nothing in its second clause.
    let clauseOffset = 0;
    for (const clause of sentence.split(/(?<=;)|(?<=\s[—–-]\s)|(?=,\s+(?:but|though|although|however)\b)/)) {
      const at = m.mention(clause);
      if (at >= 0) {
        const before = clause.slice(0, at);
        const after = clause.slice(at, at + 80);
        const offered = HYPOTHETICAL.test(clause) || /^\S+(?:\s+(?:or|and|,)?\s*\S+){0,4}\s+instead\b(?!\s+of)/i.test(after) || /\?\s*$/.test(clause);
        const recommended = CUE.test(clause) && !NEGATION.test(before) && !offered;
        const cand = { level: (recommended ? "recommended" : "mentioned") as Level, index: offset + clauseOffset + at };
        if (!best || RANK[cand.level] > RANK[best.level]) best = cand;
        if (best.level === "recommended") return best;
      }
      clauseOffset += clause.length;
    }
    offset += sentence.length + 1;
  }
  return best;
}

const MANAGER: [RegExp, string][] = [
  [/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|^npx\b|^bunx\b/i, "npm"],
  [/^(?:pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|pipenv\s+install)\b/i, "pypi"],
  [/^cargo\s+add\b/i, "crates"], [/^go\s+get\b/i, "go"], [/^(?:gem\s+install|bundle\s+add)\b/i, "rubygems"],
  [/^composer\s+require\b/i, "packagist"], [/^dotnet\s+add\s+package\b/i, "nuget"], [/^brew\s+install\b/i, "brew"],
];
// Build and test tooling every project installs: never a choice between vendors.
// An install command sits where a shell command starts: a line start (after an optional prompt, sudo or a Dockerfile
// RUN), after && ; || | ( `, or opening a quoted `bash -c "..."`. Anywhere else ("then npm install the analysis and copy rows") it is prose the agent wrote.
const COMMAND_START = /(?:^|&&|\|\||[;|(`]|\s-l?c\s+["'])\s*(?:[$>#]\s*)?(?:RUN\s+|sudo\s+(?:-\S+\s+)*)?$/;
// Words that only show up when a "command" is really a sentence: one of them, or a word ending a sentence, drops it.
const PROSE = new Set(["a", "an", "the", "and", "or", "of", "off", "on", "in", "to", "by", "for", "with", "then", "than", "that", "this",
  "these", "those", "it", "its", "is", "are", "be", "was", "were", "every", "each", "all", "any", "some", "your", "our", "my", "you",
  "we", "they", "from", "into", "onto", "as", "at", "if", "so", "but", "not", "no", "can", "will", "should", "must", "may", "when"]);
/** A stored untracked name that could be a package (not a prose word, a number or the end of a sentence). */
export const plausiblePackage = (name: string) => name.length > 1 && !PROSE.has(name) && !/^\d+$/.test(name) && !/[.:!?]$/.test(name);
const TOOLING = new Set(["typescript", "ts-node", "tsx", "nodemon", "eslint", "prettier", "jest", "vitest", "mocha", "chai", "supertest",
  "pytest", "black", "ruff", "mypy", "flake8", "isort", "pip", "setuptools", "wheel", "uv", "dotenv", "python-dotenv", "concurrently", "rimraf",
  // CLIs agents run to build, type-check or test (npx tsc, npx next build, npx playwright test): not a choice of vendor.
  "tsc", "next", "playwright", "@playwright/test", "vite", "webpack", "esbuild", "turbo", "nx", "biome", "@biomejs/biome", "oxlint"]);

/**
 * Packages the agent installed that are neither the product nor a tracked competitor: the alternatives research
 * missed. A session whose verdict is "none" usually still picked something; this is what it was. Only install
 * commands in agent actions count (not prose, not lookups); versions, extras and flags are stripped, and type stubs
 * and common build/test tooling are left out.
 */
export function untrackedInstalls(events: StoredEvent[], tracked: Tool[]): { name: string; ecosystem: string }[] {
  const known = new Set(tracked.flatMap((t) => [...(t.packages ?? []), t.name, ...(t.aliases ?? [])]).map((x) => x.toLowerCase()));
  const out = new Map<string, { name: string; ecosystem: string }>();
  for (const e of events) {
    // The agent's own lines are the harness's (_src "harness": sink.ts tags everything the harness printed); segments()
    // drops what a harness could forge as the orchestrator's (file_edit, simulated_user, session_end).
    if (e.type === "simulated_user") continue;
    for (const seg of segments(e.raw)) {
      if (seg.kind !== "action") continue;
      const text = seg.text.replace(/\\n|\\t/g, "\n");
      for (const m of text.matchAll(INSTALL)) {
        const cmd = m[0].replace(/["'`},\]\\]+$/g, "").trim();
        const mgr = MANAGER.find(([re]) => re.test(cmd));
        if (!mgr) continue;
        const at = m.index ?? 0;
        if (!COMMAND_START.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at))) continue;
        const words = cmd.replace(mgr[0], "").trim().split(/\s+/).filter(Boolean);
        if (words.some((w) => PROSE.has(w.toLowerCase()) || /[a-z][.:!?]$/i.test(w))) continue;
        const npx = /^(?:npx|bunx)\b/i.test(cmd);
        for (let i = 0; i < words.length; i++) {
          let w = words[i]!.replace(/^["'`]+|["'`,]+$/g, "");
          if (/^-/.test(w)) { if (/^(?:-r|--requirement|-e|--editable|-c|--constraint|--index-url|-i|--extra-index-url|-p|--package)$/.test(w)) i++; continue; }
          if (!w || /^[.~/]|:\/\/|^\$|\.(?:txt|toml|cfg|json|lock)$/i.test(w)) { if (npx) break; continue; }
          w = mgr[1] === "npm" ? w.replace(/(?!^)@[^/]*$/, "") : mgr[1] === "go" ? w.replace(/@.*$/, "") : w.replace(/\[.*\]|[=<>~!]=?.*$/g, "");
          const name = w.toLowerCase();
          if (name && !/^@types\//.test(name) && !TOOLING.has(name) && !known.has(name) && /^[@a-z0-9][\w./@-]*$/i.test(name))
            out.set(`${mgr[1]}:${name}`, { name, ecosystem: mgr[1] });
          if (npx) break;   // npx runs one CLI; the rest are its arguments
        }
      }
    }
  }
  return [...out.values()];
}

/**
 * Blindness check (docs/security.md): the simulated developer must never name the product or a competitor. If its
 * replies do (for example because a planted persona told it to), the session is contaminated and gets no verdict.
 * Returns the names it used, or [] when clean. Only orchestrator-written replies count.
 */
export function developerNamedTools(events: StoredEvent[], target: Tool, competitors: Tool[]): string[] {
  const said = events.filter((e) => e.type === "simulated_user" && (e.raw as { _src?: unknown })._src !== "harness")
    .map((e) => String((e.raw as { content?: unknown }).content ?? e.text)).join("\n");
  if (!said) return [];
  const out: string[] = [];
  for (const t of [target, ...competitors])
    for (const w of [t.name, ...(t.aliases ?? []), ...(t.packages ?? [])].filter((x) => x && x.length > 2))
      if (new RegExp(token(w), "i").test(said)) { out.push(t.name); break; }
  return out;
}

export function scoreTranscript(events: StoredEvent[], target: Tool, competitors: Tool[]): Score {
  const tools = [{ tool: target, target: true }, ...competitors.map((tool) => ({ tool, target: false }))]
    .map((t) => ({ ...t, m: matchers(t.tool) }));
  const found = new Map<string, Mention>();

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    for (const seg of segments(e.raw)) {
      if (!seg.text) continue;
      for (const t of tools) {
        const hit = levelIn(seg.kind, seg.text, t.m);
        if (!hit) continue;
        const cur = found.get(t.tool.name) ?? { tool: t.tool.name, target: t.target, level: hit.level, first_seq: e.seq, evidence: [] };
        if (RANK[hit.level] > RANK[cur.level]) cur.level = hit.level;
        // Keep the first piece of evidence at each level, strongest first.
        if (!cur.evidence.some((ev) => ev.level === hit.level))
          cur.evidence.push({ seq: e.seq, kind: seg.kind, level: hit.level, snippet: snippetAround(seg.text, hit.index) });
        cur.evidence.sort((a, b) => RANK[b.level] - RANK[a.level]);
        found.set(t.tool.name, cur);
      }
    }
  }

  const mentions = [...found.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || a.first_seq - b.first_seq);
  const firstAt = (mn: Mention, level: Level) => mn.evidence.find((ev) => ev.level === level)?.seq ?? Infinity;
  const winnerAt = (level: Level) =>
    mentions.filter((mn) => mn.level === level).sort((a, b) => firstAt(a, level) - firstAt(b, level))[0] ?? null;
  const winner = winnerAt("adopted") ?? winnerAt("recommended");

  const mine = mentions.find((mn) => mn.target);
  let verdict: Verdict;
  if (mine?.level === "adopted") verdict = "adopted";
  else if (winner && !winner.target && (winner.level === "adopted" || !mine || mine.level !== "recommended")) verdict = "competitor";
  else if (mine?.level === "recommended") verdict = "recommended";
  else if (mine) verdict = "mentioned";
  else verdict = "none";

  return { verdict, winner: winner?.tool ?? null, mentions };
}

/** Whether a verdict counts as a success for a scenario's expectation. */
export const isHit = (verdict: Verdict | null, expectation: "recommend" | "avoid") =>
  verdict == null ? null : expectation === "recommend" ? verdict === "adopted" || verdict === "recommended"
                                                       : verdict !== "adopted" && verdict !== "recommended";

/**
 * How a winning tool was chosen, read back from the evidence the scorer kept for it (Mention.evidence, strongest first):
 *   installed    an install command in an agent action named one of its packages
 *   imported     code or config the agent wrote imports it or lists it as a dependency
 *   built_on     code the agent wrote calls its API host or sets up its credentials or client, with no install
 *   recommended  only the agent's prose chose it ("I'll use X")
 * The scorer stores no free-text reasoning; this is the rule that fired ("How the win showed up" on Pick rate). The
 * model-written why, per lost session, is src/reasons.ts.
 */
export type HowChosen = "installed" | "imported" | "built_on" | "recommended";
export function howChosen(m: Pick<Mention, "level" | "evidence"> | null | undefined): HowChosen | null {
  if (!m) return null;
  const ev = (m.evidence ?? []).find((e) => e.level === "adopted");
  if (m.level !== "adopted" || !ev) return m.level === "recommended" ? "recommended" : null;
  const text = String(ev.snippet ?? "");
  if (new RegExp(INSTALL.source, "i").test(text)) return "installed";
  if (/(?:from\s+['"][^'"]+['"]|require\(\s*['"]|import\s+['"]|^\s*(?:from|import)\s+[\w.]+|"[@\w./-]+"\s*:\s*"[~^]?[\d*])/im.test(text)) return "imported";
  return "built_on";
}
