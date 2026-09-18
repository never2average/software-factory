/**
 * Static validation of a workflow script, and the step graph derived from it.
 *
 * A workflow script is JavaScript an operator types into the browser and the
 * backend then EXECUTES. Two things follow from that, and this module is both:
 *
 * 1. It is the first safety gate. The script is refused before it is ever
 *    stored if it reaches for anything outside the small surface the sandbox
 *    injects — no `import`/`require`, no `eval`/`new Function`, no `globalThis`,
 *    no `process`/`fetch`. The QuickJS sandbox (lib/workflow-runtime.ts) is the
 *    real boundary and would deny these anyway; refusing here means the operator
 *    finds out while typing rather than half way through a run.
 *
 * 2. It is what makes a script legible. Same bet Keystroke's AST parser makes:
 *    if the shape of the script is constrained, its phases and steps can be
 *    read straight off the source and drawn, and a run can light up the step it
 *    is on. Shapes that cannot be read statically (a step call hidden inside
 *    .map, a phase name built by string concat) are reported as warnings, not
 *    errors — they still run, they just go dark on the graph.
 *
 * Deliberately NOT a security boundary on its own: static analysis of JS can
 * always be defeated. The sandbox is the boundary. This is the fast, friendly
 * first pass.
 */
import "server-only";

import { parse } from "acorn";
import type { Node } from "acorn";
import { stripTypes } from "./workflow-ts";

/** The only globals a script may touch. Everything else is a hard error. */
export const HOST_FUNCTIONS = ["agent", "parallel", "pipeline", "phase", "log", "args"] as const;

/** Reaching for any of these means the script is trying to leave the sandbox. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "eval",
  "Function",
  "globalThis",
  "global",
  "process",
  "require",
  "fetch",
  "XMLHttpRequest",
  "WebAssembly",
  "import",
  "Deno",
  "Bun",
]);

/** Safe, pure built-ins a script legitimately needs. */
const ALLOWED_GLOBALS = new Set([
  ...HOST_FUNCTIONS,
  "JSON",
  "Math",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Set",
  "Map",
  "Promise",
  "Error",
  "console",
  "undefined",
  "NaN",
  "Infinity",
]);

export interface WorkflowIssue {
  level: "error" | "warning";
  message: string;
  line: number;
}

/** One node of the graph drawn from the script: a phase and the steps under it. */
export interface WorkflowStep {
  kind: "agent" | "parallel" | "pipeline";
  label: string;
  line: number;
}

export interface WorkflowPhase {
  title: string;
  steps: WorkflowStep[];
}

export interface WorkflowAnalysis {
  ok: boolean;
  issues: WorkflowIssue[];
  meta: { name?: string; description?: string } | null;
  phases: WorkflowPhase[];
}

type AnyNode = Node & Record<string, unknown>;

function walk(node: AnyNode | null | undefined, visit: (n: AnyNode) => void): void {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child as AnyNode, visit);
    } else if (value && typeof value === "object" && "type" in (value as object)) {
      walk(value as AnyNode, visit);
    }
  }
}

/** A string literal, or null when the value is computed (and so unreadable). */
function literalString(node: AnyNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

export function analyzeWorkflowScript(input: string): WorkflowAnalysis {
  const issues: WorkflowIssue[] = [];
  const phases: WorkflowPhase[] = [];
  let meta: WorkflowAnalysis["meta"] = null;

  // Scripts are authored in TypeScript; acorn parses JavaScript. Erase the types
  // first, and analyse exactly the text the sandbox will execute.
  const stripped = stripTypes(input);
  if (stripped.error) {
    const at = /^Line (\d+): /.exec(stripped.error);
    return {
      ok: false,
      issues: [
        {
          level: "error",
          message: at ? stripped.error.slice(at[0].length) : stripped.error,
          line: at ? Number(at[1]) : 1,
        },
      ],
      meta: null,
      phases: [],
    };
  }
  const source = stripped.js;

  let ast: AnyNode;
  try {
    ast = parse(source, {
      ecmaVersion: 2023,
      sourceType: "module",
      locations: true,
      // A script is a BODY, not a module: the runtime wraps it in an async
      // function, so top-level `await` and `return` are exactly how a script
      // ends. Parsing without these rejects every correct script — including
      // the starter one — with a syntax error that is really the parser's.
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AnyNode;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    return {
      ok: false,
      issues: [
        { level: "error", message: err.message ?? "Could not parse the script.", line: err.loc?.line ?? 1 },
      ],
      meta: null,
      phases: [],
    };
  }

  const lineOf = (n: AnyNode): number =>
    ((n.loc as { start?: { line?: number } })?.start?.line ?? 1) as number;

  // Steps land in the phase most recently opened by phase("…"), which is how the
  // script reads top to bottom. Steps before the first phase() go in an implicit
  // one, so a script with no phases still draws.
  let current: WorkflowPhase = { title: "Workflow", steps: [] };
  phases.push(current);

  walk(ast, (n) => {
    // Nothing may enter or leave the sandbox.
    if (n.type === "ImportDeclaration" || n.type === "ImportExpression") {
      issues.push({
        level: "error",
        message: "A workflow script cannot import anything — it runs in a sandbox with no modules.",
        line: lineOf(n),
      });
      return;
    }
    if (n.type === "Identifier" && FORBIDDEN_IDENTIFIERS.has(n.name as string)) {
      issues.push({
        level: "error",
        message: `\`${n.name}\` is not available to a workflow script — it runs sandboxed, with no host access.`,
        line: lineOf(n),
      });
      return;
    }

    if (n.type !== "CallExpression") return;
    const callee = n.callee as AnyNode;
    if (callee?.type !== "Identifier") return;
    const name = callee.name as string;
    const args = (n.arguments ?? []) as AnyNode[];

    if (name === "phase") {
      const title = literalString(args[0]);
      if (!title) {
        issues.push({
          level: "warning",
          message: "phase() was given a computed title, so it cannot be drawn on the graph.",
          line: lineOf(n),
        });
        return;
      }
      current = { title, steps: [] };
      phases.push(current);
      return;
    }

    if (name === "agent" || name === "parallel" || name === "pipeline") {
      const label =
        name === "agent"
          ? (literalString(args[0]) ?? "…")
          : `${name} over ${args.length} ${args.length === 1 ? "input" : "inputs"}`;
      current.steps.push({
        kind: name as WorkflowStep["kind"],
        label: label.length > 60 ? `${label.slice(0, 57)}…` : label,
        line: lineOf(n),
      });
      if (name === "agent" && literalString(args[0]) === null) {
        issues.push({
          level: "warning",
          message: "agent() was given a computed prompt, so the graph cannot show what it asks for.",
          line: lineOf(n),
        });
      }
    }
  });

  // `export const meta = { name, description }` — the script's own identity.
  walk(ast, (n) => {
    if (n.type !== "VariableDeclarator") return;
    const id = n.id as AnyNode;
    if (id?.type !== "Identifier" || id.name !== "meta") return;
    const init = n.init as AnyNode;
    if (init?.type !== "ObjectExpression") return;
    const out: { name?: string; description?: string } = {};
    for (const prop of (init.properties ?? []) as AnyNode[]) {
      const key = prop.key as AnyNode;
      const keyName = key?.type === "Identifier" ? (key.name as string) : literalString(key);
      const value = literalString(prop.value as AnyNode);
      if (keyName === "name" && value) out.name = value;
      if (keyName === "description" && value) out.description = value;
    }
    meta = out;
  });

  if (!meta) {
    issues.push({
      level: "warning",
      message: "No `export const meta = { name, description }` — the workflow has no stated identity.",
      line: 1,
    });
  }

  // An empty implicit phase is noise on the graph.
  const drawn = phases.filter((p, i) => p.steps.length > 0 || i > 0);

  return {
    ok: !issues.some((i) => i.level === "error"),
    issues,
    meta,
    phases: drawn,
  };
}

/** Every identifier a script reads that the sandbox will not provide. */
export function unknownGlobals(source: string): string[] {
  try {
    const ast = parse(source, {
      ecmaVersion: 2023,
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AnyNode;
    const declared = new Set<string>();
    const used = new Set<string>();
    walk(ast, (n) => {
      if (n.type === "VariableDeclarator" && (n.id as AnyNode)?.type === "Identifier") {
        declared.add((n.id as AnyNode).name as string);
      }
      if (n.type === "FunctionDeclaration" && (n.id as AnyNode)?.type === "Identifier") {
        declared.add((n.id as AnyNode).name as string);
      }
      if (n.type === "Identifier") used.add(n.name as string);
    });
    return [...used].filter((u) => !declared.has(u) && !ALLOWED_GLOBALS.has(u));
  } catch {
    return [];
  }
}
