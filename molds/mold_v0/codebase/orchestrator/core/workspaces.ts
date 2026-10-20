/**
 * Starter workspaces: when a scenario has no repo_url, the worker sandbox is seeded with a small, realistic project
 * (orchestrator/workspaces/<template>/) committed once, so the coding agent finds "this service" instead of an empty
 * directory (seen live 2026-10-10: Codex stopped with "The workspace at /home/agent/work is empty").
 *
 * Templates are neutral: framework + language tooling only, no dev-tool SDKs, nothing customer-category related.
 * Selection is deterministic: explicit `template` (set by research or save_scenarios) > language > keywords > fallback.
 * The diff (and the "done" check) is taken against the seed commit, so the template itself never counts as work.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "workspaces");
export const TEMPLATES = ["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter", "java-spring", "rust-axum", "cpp-cmake"] as const;
export type TemplateId = (typeof TEMPLATES)[number];
export const FALLBACK_TEMPLATE: TemplateId = "node-ts";

export interface TemplateInput {
  template?: string | null;
  language?: string | null;
  tags?: string[] | null;
  title?: string | null;
  prompt?: string | null;
}

const has = (text: string, re: RegExp) => re.test(text);
const NEXT = /\bnext(\.js|js)?\b(?! (step|steps|time|page|one|week|release))|\bapp router\b|\breact\b|\bfrontend\b|\bfront-end\b|\bserver components?\b|\btsx\b/;
const DJANGO = /\bdjango\b/;
const FASTAPI = /\bfastapi\b|\bpydantic\b|\buvicorn\b|\bflask\b|\bstarlette\b/;
const PYTHON = /\bpython\b|\bpip\b|\bpytest\b|\.py\b/;
const GO = /\bgolang\b|\bgo (service|server|module|api|app|backend|http|code|project)\b|\bnet\/http\b|\bgo\.mod\b/;
const SERVICE = /\bservice\b|\bapi\b|\bendpoints?\b|\broutes?\b|\bserver\b|\bexpress\b|\bwebhooks?\b|\bmiddleware\b|\bbackend\b|\brest\b|\bhttp\b|\bpost \/|\bget \//;
const JAVA = /\bjava\b|\bspring( boot)?\b|\bkotlin\b|\bmaven\b|\bgradle\b|\bquarkus\b|\bjakarta\b/;
const RUST = /\brust\b|\bcargo\b|\baxum\b|\bactix\b|\btokio\b|\bcrates?\b/;
const CPP = /\bc\+\+|\bcpp\b|\bcmake\b|\bqt\b|\bboost\b/;
const RN = /\breact native\b|\breact-native\b|\bexpo\b/;
const FLUTTER = /\bflutter\b|\bdart\b|\bpubspec\b/;
const MOBILE = /\bmobile app\b|\bios\b|\bandroid\b|\bpush notifications? on (the )?(phone|device)\b/;
const TS_JS = /\btypescript\b|\bjavascript\b|\bnode(\.js|js)?\b|\bnpm\b|\bts\b/;

/** Deterministic template choice for a scenario without a repo. */
export function selectTemplate(s: TemplateInput): TemplateId {
  const explicit = (s.template ?? "").trim().toLowerCase();
  if ((TEMPLATES as readonly string[]).includes(explicit)) return explicit as TemplateId;
  const lang = (s.language ?? "").trim().toLowerCase();
  const text = [lang, ...(s.tags ?? []), s.title ?? "", s.prompt ?? ""].join(" \n ").toLowerCase();

  // Explicit languages and unambiguous stack keywords first.
  if (lang === "java" || lang === "kotlin") return "java-spring";
  if (lang === "rust") return "rust-axum";
  if (lang === "c++" || lang === "cpp" || lang === "c") return "cpp-cmake";
  // Mobile next: a mobile task must not land in a web starter.
  if (lang === "dart" || has(text, FLUTTER)) return "flutter";
  if (has(text, RN)) return "react-native";
  if (has(text, MOBILE) && lang !== "python" && lang !== "go") return "react-native";

  if (lang === "python" || lang === "py") return has(text, DJANGO) ? "django" : "fastapi";
  if (lang === "go" || lang === "golang") return "go-http";
  if (["typescript", "javascript", "ts", "js", "node", "nodejs", "tsx"].includes(lang)) {
    if (has(text, NEXT)) return "nextjs-ts";
    return has(text, SERVICE) ? "express-ts" : "node-ts";
  }
  // No (or another) language: keywords.
  if (has(text, RUST)) return "rust-axum";
  if (has(text, CPP)) return "cpp-cmake";
  if (has(text, JAVA)) return "java-spring";
  if (has(text, DJANGO)) return "django";
  if (has(text, FASTAPI) || has(text, PYTHON)) return "fastapi";
  if (has(text, GO)) return "go-http";
  if (has(text, NEXT)) return "nextjs-ts";
  if (has(text, SERVICE)) return "express-ts";
  if (has(text, TS_JS)) return "node-ts";
  return FALLBACK_TEMPLATE;
}

/** Template files as {relative path: content}, sorted. */
export function templateFiles(id: TemplateId, root = WORKSPACES_DIR): Record<string, string> {
  const base = join(root, id);
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(base, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && statSync(join(base, r)).size < 256_000) out[r] = readFileSync(join(base, r), "utf8");
    }
  };
  walk("");
  return out;
}

/** The seed commit sha from seedScript output (last 40-hex line; "" if absent -> diff falls back to the empty tree). */
export function seedBase(out: string): string {
  return [...out.matchAll(/^([0-9a-f]{40})\s*$/gm)].pop()?.[1] ?? "";
}

/**
 * Bash that writes the template into $W (must exist and be empty), makes the initial commit and prints its sha.
 * Runs as the agent user. Files travel base64-encoded, so no quoting issues; total stays far under 5 MiB.
 */
export function seedScript(id: TemplateId, root = WORKSPACES_DIR): string {
  const files = templateFiles(id, root);
  const lines = [
    "set -euo pipefail",
    'cd "$W"',
    ...Object.entries(files).map(([p, c]) => {
      const q = `'${p.replace(/'/g, "")}'`;
      return `mkdir -p "$(dirname ${q})" && printf '%s' '${Buffer.from(c).toString("base64")}' | base64 -d > ${q}`;
    }),
    "git init -q -b main 2>/dev/null || git init -q",
    "git add -A",
    'git -c user.name="Dev" -c user.email="dev@example.com" -c commit.gpgsign=false commit -q -m "Initial commit"',
    "git rev-parse HEAD",
  ];
  return lines.join("\n") + "\n";
}
