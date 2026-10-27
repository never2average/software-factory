/**
 * The client skill (mold_v0-144): a skill bundle for AI clients (a folder with SKILL.md, the Agent Skills format Claude,
 * Claude Code and other clients load), generated for every build from its own profile and config and served as a zip
 * from the public install page (src/install-pages.ts: /install links it, /install/skill.zip and
 * /downloads/<name>-skill.zip answer it). What it holds (src/client-skill.ts writes it):
 *
 *   <name>/SKILL.md            the frontmatter (name, description), the body, then a generated section saying where the
 *                              connector is (the build's MCP address, the front door: src/console-url.ts mcpUrl) and
 *                              where its tools are described
 *   <name>/reference/tools.md  every tool the customer MCP server lists, with its description and whether it changes
 *                              anything, generated from the server itself (never a tool the server does not list)
 *   <name>/<path>              the config's own files (`files`), such as a reference page
 *
 * With no config the body is generated too: the product's description, the server's own instructions (as the MCP server
 * sends them) and a table of its tools. A pack declares the skill in pack.json `client_skill` (at most one pack of a
 * build); the app's own profile.json `client_skill` comes over it field by field (`files` and `words` path by path):
 *
 *   "client_skill": {
 *     "name":        "acme-desk",     the skill's name: lowercase letters, digits and single hyphens, up to 64
 *                                     (default: the MCP server's name, made so); never the reserved words of a client
 *     "description": "...",          what it does and when a client should use it: one line, up to 1024 characters,
 *                                     no angle brackets (default: the words' `description`, from the profile)
 *     "body":        "# ...",        the skill's instructions, Markdown, up to 30000 characters (default: generated)
 *     "files":       {"reference/terms.md": "..."}  Markdown or text files beside SKILL.md, up to 10, each up to 30000
 *     "words":       {"connect_heading": "..."}     the generated parts' words (CLIENT_SKILL_WORDS), one line each
 *   }
 *
 * Pure, no imports: scripts/gen-packs.mjs runs the same rules (node strips the types) and writes the checked, merged
 * block to src/client-skill.generated.ts (null without one).
 */

/** The generated parts' words, each with its neutral default. Placeholders: {product}, {summary}, {url}, {install}. */
export const CLIENT_SKILL_WORDS = {
  /** The default description (no `description` in the config). */
  description: "{summary} Use it when the user wants to work with {product} from this AI client. Needs the {product} connector (an MCP server).",
  /** The default body's headings and table. */
  instructions_heading: "How to work with {product}",
  tools_heading: "Tools",
  tool_column: "Tool",
  does_column: "What it does",
  no_tools: "The connector lists no tools yet.",
  /** The section after every body: where the connector is. */
  connect_heading: "Connecting {product}",
  connect_text: "This skill works through the {product} connector, an MCP server at {url}. Add it to your AI client as a custom connector with that address and sign in when the client asks. Each client's steps are at {install}.",
  tools_link: "Every tool the connector offers, and what it does, is in reference/tools.md.",
  /** reference/tools.md. */
  tools_title: "{product} tools",
  tools_intro: "The tools the {product} connector offers. Your role in your account decides which of them you may call.",
  reads_only: "Reads only.",
  changes: "Changes something.",
} as const;
export type ClientSkillWord = keyof typeof CLIENT_SKILL_WORDS;
export const CLIENT_SKILL_KEYS = ["name", "description", "body", "files", "words"] as const;

export interface ClientSkillConfig {
  name?: string;
  description?: string;
  body?: string;
  files?: Record<string, string>;
  words?: Partial<Record<ClientSkillWord, string>>;
}

/** The files the shell writes itself: never a config file's path. */
export const GENERATED_PATHS = ["SKILL.md", "reference/tools.md"] as const;
export const MAX_FILES = 10;
export const MAX_TEXT = 30000;
/** A skill's name (the Agent Skills format): lowercase letters, digits and single hyphens, up to 64 characters. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Words a client reserves in a skill's name. */
const RESERVED = ["anthropic", "claude"];
/** A file's path beside SKILL.md: folders and a name of lowercase letters, digits, _ and -, ending .md or .txt. */
const FILE_PATH = /^([a-z0-9][a-z0-9_-]{0,40}\/){0,3}[a-z0-9][a-z0-9_.-]{0,60}\.(md|txt)$/;
/** Characters a one-line text may not hold (control, line breaks, invisible and bidirectional characters). */
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
/** Characters Markdown may not hold: as above, but line breaks and tabs are text. */
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

const lineProblem = (v: unknown, max: number): string | null =>
  typeof v !== "string" || !v.trim() ? "text is required"
    : v.length > max ? `at most ${max} characters`
      : NOT_PLAIN.test(v) || /[<>]/.test(v) ? "plain text on one line: no line breaks, control or invisible characters, or angle brackets"
        : null;
const textProblem = (v: unknown): string | null =>
  typeof v !== "string" || !v.trim() ? "text is required"
    : v.length > MAX_TEXT ? `at most ${MAX_TEXT} characters`
      : NOT_TEXT.test(v) ? "Markdown text: no control or invisible characters (line breaks and tabs are fine)"
        : null;

/** A skill name's problem, or null. */
export function skillNameProblem(v: unknown): string | null {
  if (typeof v !== "string" || !NAME.test(v) || v.length > 64) return "lowercase letters, digits and single hyphens, up to 64 characters";
  const bad = RESERVED.find((w) => v.includes(w));
  return bad ? `may not contain "${bad}" (a word AI clients reserve)` : null;
}

/** Every problem of a `client_skill` block as "client_skill.<field>: message"; [] when it is well formed. */
export function clientSkillProblems(v: unknown, at = "client_skill"): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at}: an object (name, description, body, files, words; each optional)`];
  const o = v as Record<string, unknown>, out: string[] = [];
  const say = (k: string, p: string | null) => { if (p) out.push(`${at}.${k}: ${p}`); };
  for (const k of Object.keys(o)) if (k !== "$comment" && !(CLIENT_SKILL_KEYS as readonly string[]).includes(k)) out.push(`${at}.${k}: not a client_skill field (known: ${CLIENT_SKILL_KEYS.join(", ")})`);
  if (o.$comment !== undefined && (typeof o.$comment !== "string" || o.$comment.length > 2000)) say("$comment", "text of up to 2000 characters");
  if (o.name !== undefined) say("name", skillNameProblem(o.name));
  if (o.description !== undefined) say("description", lineProblem(o.description, 1024));
  if (o.body !== undefined) {
    say("body", textProblem(o.body));
    if (typeof o.body === "string" && /^\s*---/.test(o.body)) say("body", "the shell writes the frontmatter (name, description): give the body without it");
  }
  if (o.files !== undefined) {
    if (!o.files || typeof o.files !== "object" || Array.isArray(o.files)) say("files", "an object of path -> Markdown text");
    else {
      const entries = Object.entries(o.files as Record<string, unknown>);
      if (entries.length > MAX_FILES) say("files", `at most ${MAX_FILES} files`);
      for (const [p, t] of entries) {
        if (!FILE_PATH.test(p) || p.includes("..")) say(`files.${p}`, "a path beside SKILL.md: up to 3 folders, then a name of lowercase letters, digits, _, - and ., ending .md or .txt");
        else if ((GENERATED_PATHS as readonly string[]).includes(p)) say(`files.${p}`, "the shell writes this file itself");
        say(`files.${p}`, textProblem(t));
      }
    }
  }
  if (o.words !== undefined) {
    if (!o.words || typeof o.words !== "object" || Array.isArray(o.words)) say("words", "an object of word -> text");
    else for (const [k, w] of Object.entries(o.words as Record<string, unknown>)) {
      if (!Object.hasOwn(CLIENT_SKILL_WORDS, k)) say(`words.${k}`, `not a client_skill word (known: ${Object.keys(CLIENT_SKILL_WORDS).join(", ")})`);
      else say(`words.${k}`, lineProblem(w, 600));
    }
  }
  return out;
}

/** A pack's block with the app's over it, field by field (`files` and `words` path by path); null when neither has one. */
export function mergeClientSkill(pack: ClientSkillConfig | null | undefined, app: ClientSkillConfig | null | undefined): ClientSkillConfig | null {
  if (!pack && !app) return null;
  const strip = (o: ClientSkillConfig | null | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== "$comment")) as ClientSkillConfig;
  const a = strip(pack), b = strip(app);
  const out: ClientSkillConfig = { ...a, ...b };
  if (a.files || b.files) out.files = { ...a.files, ...b.files };
  if (a.words || b.words) out.words = { ...a.words, ...b.words };
  return out;
}

/** What the skill is built from: the build's names, its connector and what the server lists. */
export interface SkillFacts {
  product: string;
  server: string;
  summary: string;
  /** The MCP endpoint (…/mcp) and the install page's address. */
  url: string;
  install: string;
  instructions: string;
  tools: { name: string; title: string | null; description: string; read_only: boolean }[];
}

/** A word with its placeholders filled. */
export function skillWord(cfg: ClientSkillConfig | null, k: ClientSkillWord, f: Pick<SkillFacts, "product" | "summary" | "url" | "install">): string {
  const t = cfg?.words?.[k] ?? CLIENT_SKILL_WORDS[k];
  return t.replace(/\{(product|summary|url|install)\}/g, (_m, p: "product" | "summary" | "url" | "install") => f[p]);
}

/** The skill's name: the config's, else the MCP server's name made into one (lowercase, hyphens; "connector" if nothing is left). */
export function skillName(cfg: ClientSkillConfig | null, server: string): string {
  if (cfg?.name) return cfg.name;
  const n = server.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return n && !skillNameProblem(n) ? n : "connector";
}

/** A frontmatter value: as it is when YAML reads it as plain text, else double-quoted (a JSON string is valid YAML). */
const yamlValue = (s: string) => /^[A-Za-z0-9(]/.test(s) && !/: |\s#|["\\]|:$/.test(s) ? s : JSON.stringify(s);
/** A table cell: one line, no pipe. */
const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
/** The first sentence of a description (as the customer docs' tool table cuts it), up to 200 characters. */
export function firstSentence(s = ""): string {
  const parts = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z`"])/);
  let out = parts[0] ?? "";
  for (let i = 1; out.length < 40 && i < parts.length; i++) out += ` ${parts[i]}`;
  return out.length <= 200 ? out : `${out.slice(0, out.lastIndexOf(" ", 197))}…`;
}

/** Every file of the skill, by its path inside the skill's folder, sorted: SKILL.md, reference/tools.md and the config's own. */
export function skillFiles(cfg: ClientSkillConfig | null, f: SkillFacts): Record<string, string> {
  const w = (k: ClientSkillWord) => skillWord(cfg, k, f);
  const name = skillName(cfg, f.server);
  const description = cfg?.description ?? w("description").replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, 1024);
  const body = cfg?.body?.trim() ?? [
    `# ${f.product}`,
    f.summary,
    ...(f.instructions.trim() ? [`## ${w("instructions_heading")}`, f.instructions.trim()] : []),
    `## ${w("tools_heading")}`,
    f.tools.length ? [`| ${w("tool_column")} | ${w("does_column")} |`, "|---|---|", ...f.tools.map((t) => `| \`${t.name}\` | ${cell(firstSentence(t.description) || t.title || "")} |`)].join("\n") : w("no_tools"),
  ].join("\n\n");
  const skill = `---\nname: ${name}\ndescription: ${yamlValue(description)}\n---\n\n${body}\n\n## ${w("connect_heading")}\n\n${w("connect_text")}\n${w("tools_link")}\n`;
  const tools = [`# ${w("tools_title")}`, w("tools_intro"),
    ...f.tools.map((t) => `## \`${t.name}\`${t.title ? `: ${t.title}` : ""}\n\n${t.description.trim() || "-"}\n\n${t.read_only ? w("reads_only") : w("changes")}`)].join("\n\n") + "\n";
  const all: Record<string, string> = { ...cfg?.files, "SKILL.md": skill, "reference/tools.md": tools };
  return Object.fromEntries(Object.keys(all).sort().map((p) => [p, all[p]!]));
}
