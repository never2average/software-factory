#!/usr/bin/env node
/**
 * lib/storage IS SERVER-ONLY. A CLIENT COMPONENT MAY IMPORT lib/storage/hosts.ts AND NOTHING ELSE UNDER IT.
 *
 * Everything else under lib/storage/ holds or reads the file store's credentials (the Vercel Blob token, the S3 keys,
 * the link-signing secret). The file it replaced (lib/blob-read.ts) said so with `import "server-only"`, which makes
 * `next build` fail when a client component can reach the module. That package cannot be imported by these modules:
 * the eve agent and plain `node` scripts load them too, and outside Next's server bundles its default export throws
 * (lib/storage/server-guard.ts has the full reason). This check is the build-time half of the replacement:
 *
 *   1. reach   follow every import (static, re-export, dynamic, require; `@/` and relative) from each file that starts
 *              with "use client", and fail when the graph reaches a module under lib/storage/ other than hosts.ts.
 *              Reported with the chain of imports, so the fix is visible. A type-only import is erased by the compiler
 *              and is not an edge.
 *   2. guard   every module under lib/storage/ except hosts.ts and types.ts (types only) must start its imports with
 *              `import "./server-guard.ts"`, the run-time half, so one cannot be added without it.
 *   3. hosts   hosts.ts, the one module a browser loads, must import nothing at all.
 *
 *   node scripts/check-storage-server-only.mjs              check the tree
 *   node scripts/check-storage-server-only.mjs --self-test  prove the rules catch what they should, both ways
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ts = createRequire(import.meta.url)("typescript");

const STORAGE_DIR = "lib/storage/";
/** The one module under lib/storage/ a client component may import. */
const BROWSER_SAFE = "lib/storage/hosts.ts";
const GUARD = "lib/storage/server-guard.ts";
/** Modules that need no guard: the browser-safe one, the guard itself, and the one that is only types. */
const GUARD_EXEMPT = new Set([BROWSER_SAFE, GUARD, "lib/storage/types.ts"]);

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CLIENT_ROOTS = ["app/", "components/", "lib/"];
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

/** The imports of one file that exist at run time: [{ specifier, line }], and whether it opens with "use client". */
export function analyse(file, text) {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const imports = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  let client = false;
  for (const statement of source.statements) {
    // Directives are the leading string-literal statements; "use client" must be among them.
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === "use client") client = true;
      continue;
    }
    break;
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      // Erased by the compiler: `import type …`, or named imports that are every one `type X` with no default.
      const typeOnly = clause ? clause.isTypeOnly || (!clause.name && named !== null && named.length > 0 && named.every((e) => e.isTypeOnly)) : false;
      if (!typeOnly) imports.push({ specifier: node.moduleSpecifier.text, line: lineOf(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      const typeOnly = node.isTypeOnly || (named !== null && named.length > 0 && named.every((e) => e.isTypeOnly));
      if (!typeOnly) imports.push({ specifier: node.moduleSpecifier.text, line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamic || required) imports.push({ specifier: node.arguments[0].text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { client, imports };
}

/** A specifier to a repository file, or null for a package or something that is not in the tree. */
export function resolveImport(from, specifier, has) {
  let base;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) if (has(base + suffix)) return base + suffix;
  // eve's convention: a `.js` specifier for a `.ts` file.
  if (base.endsWith(".js") && has(base.slice(0, -3) + ".ts")) return base.slice(0, -3) + ".ts";
  return null;
}

/** Problems in a set of files (a Map of path -> text): [{ rule, file, line, text }]. */
export function problemsIn(files) {
  const has = (file) => files.has(file);
  const analysed = new Map();
  const info = (file) => {
    if (!analysed.has(file)) analysed.set(file, analyse(file, files.get(file)));
    return analysed.get(file);
  };
  const problems = [];

  // 1. reach
  for (const entry of [...files.keys()].sort()) {
    if (!SOURCE.test(entry) || !CLIENT_ROOTS.some((root) => entry.startsWith(root)) || !info(entry).client) continue;
    const cameFrom = new Map([[entry, null]]);
    const queue = [entry];
    const reported = new Set();
    while (queue.length > 0) {
      const file = queue.shift();
      for (const { specifier, line } of info(file).imports) {
        const target = resolveImport(file, specifier, has);
        if (!target || !SOURCE.test(target)) continue;
        if (target.startsWith(STORAGE_DIR) && target !== BROWSER_SAFE) {
          if (reported.has(target)) continue;
          reported.add(target);
          const chain = [];
          for (let at = file; at !== null; at = cameFrom.get(at)) chain.unshift(at);
          problems.push({ rule: "reach", file: entry, line: file === entry ? line : 1, text: [...chain, target].join(" -> ") });
          continue; // do not walk into the store: one report per forbidden module is enough
        }
        if (!cameFrom.has(target)) {
          cameFrom.set(target, file);
          queue.push(target);
        }
      }
    }
  }

  // 2. guard, 3. hosts
  for (const file of [...files.keys()].sort()) {
    if (!file.startsWith(STORAGE_DIR) || !SOURCE.test(file)) continue;
    const { imports } = info(file);
    if (file === BROWSER_SAFE) {
      for (const { specifier, line } of imports) problems.push({ rule: "hosts", file, line, text: `imports "${specifier}"` });
      continue;
    }
    if (GUARD_EXEMPT.has(file)) continue;
    const first = imports[0];
    if (!first || resolveImport(file, first.specifier, has) !== GUARD) {
      problems.push({ rule: "guard", file, line: first?.line ?? 1, text: first ? `its first import is "${first.specifier}"` : "it imports nothing" });
    }
  }
  if (!has(GUARD)) problems.push({ rule: "guard", file: GUARD, line: 1, text: "the guard module is missing" });
  if (!has(BROWSER_SAFE)) problems.push({ rule: "hosts", file: BROWSER_SAFE, line: 1, text: "the browser-safe module is missing" });
  return problems;
}

function selfTest() {
  let failed = 0;
  const base = {
    "lib/storage/server-guard.ts": `export {};\n`,
    "lib/storage/hosts.ts": `export const isStorageHostForBrowser = () => true;\n`,
    "lib/storage/types.ts": `export interface StorageDriver {}\nexport class StorageConfigError extends Error {}\n`,
    "lib/storage/index.ts": `import "./server-guard.ts";\nimport { createVercelBlobDriver } from "./vercel-blob.ts";\nexport const storageDriver = () => createVercelBlobDriver("t");\n`,
    "lib/storage/vercel-blob.ts": `import "./server-guard.ts";\nimport { put } from "a-store-client";\nexport const createVercelBlobDriver = (t: string) => put;\n`,
    "lib/storage/urls.ts": `import "./server-guard.ts";\nexport const storageUrlRules = () => null;\n`,
  };
  const expect = (label, extra, want) => {
    const files = new Map(Object.entries({ ...base, ...extra }).filter(([, text]) => text !== null));
    const got = problemsIn(files).map((p) => `${p.rule}:${p.text}`);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  };
  console.log("check-storage-server-only self-test");
  const C = `"use client";\n`;
  expect("a client component importing hosts.ts passes", { "app/_components/a.tsx": `${C}import { isStorageHostForBrowser } from "@/lib/storage/hosts";\n` }, []);
  expect("a client component importing the driver entry point fails", { "app/_components/a.tsx": `${C}import { storageDriver } from "@/lib/storage/index";\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("…by the directory name", { "app/_components/a.tsx": `${C}import { storageDriver } from "@/lib/storage";\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("…the Vercel Blob driver", { "app/_components/a.tsx": `${C}import { createVercelBlobDriver } from "../../lib/storage/vercel-blob.ts";\n` }, ["reach:app/_components/a.tsx -> lib/storage/vercel-blob.ts"]);
  expect("…the link rules (not hosts.ts, so not allowed)", { "components/a.tsx": `'use client'\nimport { storageUrlRules } from "@/lib/storage/urls";\n` }, ["reach:components/a.tsx -> lib/storage/urls.ts"]);
  expect("…a dynamic import", { "app/_components/a.tsx": `${C}export const load = () => import("@/lib/storage/index");\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("…a require", { "app/_components/a.tsx": `${C}const s = require("@/lib/storage/index");\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("…a re-export", { "app/_components/a.tsx": `${C}export { storageDriver } from "@/lib/storage/index";\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("…a value import of types.ts (the error class is code)", { "app/_components/a.tsx": `${C}import { StorageConfigError } from "@/lib/storage/types";\n` }, ["reach:app/_components/a.tsx -> lib/storage/types.ts"]);
  expect("…through a helper two imports away, with the chain", {
    "app/_components/a.tsx": `${C}import { b } from "./b";\n`,
    "app/_components/b.ts": `import { c } from "@/lib/c";\nexport const b = c;\n`,
    "lib/c.ts": `import { storageUrlRules } from "./storage/urls.ts";\nexport const c = storageUrlRules;\n`,
  }, ["reach:app/_components/a.tsx -> app/_components/b.ts -> lib/c.ts -> lib/storage/urls.ts"]);
  expect("…a client module under lib/", { "lib/hook.ts": `${C}import { storageDriver } from "./storage/index.ts";\n` }, ["reach:lib/hook.ts -> lib/storage/index.ts"]);
  expect("two forbidden modules from one component are both reported", { "app/_components/a.tsx": `${C}import { storageDriver } from "@/lib/storage/index";\nimport { storageUrlRules } from "@/lib/storage/urls";\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts", "reach:app/_components/a.tsx -> lib/storage/urls.ts"]);
  expect("a type-only import passes (erased by the compiler)", { "app/_components/a.tsx": `${C}import type { StorageDriver } from "@/lib/storage/types";\nimport { type StorageDriver as D } from "@/lib/storage/index";\nexport type { StorageDriver as E } from "@/lib/storage/types";\n` }, []);
  expect("…but a mixed import does not", { "app/_components/a.tsx": `${C}import { type StorageDriver, storageDriver } from "@/lib/storage/index";\n` }, ["reach:app/_components/a.tsx -> lib/storage/index.ts"]);
  expect("a SERVER file importing the driver passes (a route, a server lib)", { "app/api/x/route.ts": `import { storageDriver } from "@/lib/storage/index";\n`, "lib/dataroom-blob.ts": `import "server-only";\nimport { storageDriver } from "@/lib/storage/index";\n` }, []);
  expect("a comment or a string that names the module passes", { "app/_components/a.tsx": `${C}// import { storageDriver } from "@/lib/storage/index";\nconst s = 'import("@/lib/storage/index")';\n` }, []);
  expect("\"use client\" must be a directive: a later string is not one", { "app/_components/a.tsx": `import { storageDriver } from "@/lib/storage/index";\n"use client";\n` }, []);
  expect("a storage module without the guard fails", { "lib/storage/new-driver.ts": `import { put } from "somewhere";\nexport const x = put;\n` }, [`guard:its first import is "somewhere"`]);
  expect("…when the guard is not FIRST", { "lib/storage/urls.ts": `import nodePath from "node:path";\nimport "./server-guard.ts";\nexport const storageUrlRules = () => nodePath;\n` }, [`guard:its first import is "node:path"`]);
  expect("…when it imports nothing at all", { "lib/storage/keys.ts": `export const isStorageKey = () => true;\n` }, ["guard:it imports nothing"]);
  expect("…and the entry point and the Vercel Blob driver are held to it by name", { "lib/storage/index.ts": `import { createVercelBlobDriver } from "./vercel-blob.ts";\nexport const storageDriver = createVercelBlobDriver;\n`, "lib/storage/vercel-blob.ts": `import { put } from "a-store-client";\nexport const createVercelBlobDriver = put;\n` }, [`guard:its first import is "./vercel-blob.ts"`, `guard:its first import is "a-store-client"`]);
  expect("the literal package does not count as the guard (it throws in the agent and in node scripts)", { "lib/storage/urls.ts": `import "server-only";\nexport const storageUrlRules = () => null;\n` }, [`guard:its first import is "server-only"`]);
  expect("a missing guard module fails", { "lib/storage/server-guard.ts": null }, [`guard:its first import is "./server-guard.ts"`, `guard:its first import is "./server-guard.ts"`, `guard:its first import is "./server-guard.ts"`, "guard:the guard module is missing"]);
  expect("hosts.ts importing anything fails (a browser loads it)", { "lib/storage/hosts.ts": `import { storageKind } from "./settings.ts";\nexport const isStorageHostForBrowser = () => storageKind;\n` }, [`hosts:imports "./settings.ts"`]);
  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall ok");
}

function main() {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "app", "components", "lib"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && SOURCE.test(f));
  const files = new Map();
  for (const file of listed) {
    try {
      files.set(file, readFileSync(file, "utf8"));
    } catch {
      // deleted in the working tree
    }
  }
  const problems = problemsIn(files);
  const clients = [...files.keys()].filter((f) => analyse(f, files.get(f)).client).length;
  const stores = [...files.keys()].filter((f) => f.startsWith(STORAGE_DIR)).length;
  if (clients === 0 || stores < 3) {
    console.error(`check-storage-server-only: found ${clients} client component(s) and ${stores} module(s) under ${STORAGE_DIR}: this check would pass with nothing to protect.`);
    process.exit(1);
  }
  if (problems.length === 0) {
    console.log(`check-storage-server-only: ok — ${clients} "use client" files; none can reach a module under ${STORAGE_DIR} other than hosts.ts, and all ${stores - GUARD_EXEMPT.size} server modules there start with the guard.`);
    return;
  }
  for (const p of problems) {
    const why =
      p.rule === "reach"
        ? `a client component can reach a server-only storage module (it may import ${BROWSER_SAFE} only):\n    ${p.text}`
        : p.rule === "guard"
          ? `a module under ${STORAGE_DIR} must begin its imports with \`import "./server-guard.ts";\` (${p.text})`
          : `${BROWSER_SAFE} is loaded by the browser and must import nothing (${p.text})`;
    console.error(`${p.file}:${p.line}: ${why}`);
  }
  console.error(`\ncheck-storage-server-only: ${problems.length} problem(s).`);
  process.exit(1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
