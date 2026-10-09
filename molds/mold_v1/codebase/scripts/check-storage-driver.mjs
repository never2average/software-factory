#!/usr/bin/env node
/**
 * ONE FILE TALKS TO VERCEL BLOB.
 *
 * The application reaches its file store through lib/storage (one interface, three drivers). That only holds while
 * nothing goes around it, so this check fails when:
 *
 *   1. any source file other than the Vercel Blob driver imports `@vercel/blob` (static import, dynamic import,
 *      require, or a re-export), or
 *   2. application code outside lib/storage/ names the Vercel Blob host (`vercel-storage.com`) in code. A host
 *      allow-list written at the call site is how the five copies of that rule came to exist; they ask the driver now.
 *
 * Comments may mention either: the rule is about what the code does. Tests and scripts may name the host (they build
 * fixtures for the default driver), but may not import the client, with the exceptions listed below.
 *
 *   node scripts/check-storage-driver.mjs              check the tree
 *   node scripts/check-storage-driver.mjs --self-test  prove the rules catch what they should, both ways
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The only application file that may import the client. */
const DRIVER = "lib/storage/vercel-blob.ts";

/** Files outside the application that may import it, each with the reason. */
const IMPORT_EXEMPT = new Map([
  ["scripts/lib/blob-call-recorder.mjs", "the test stand-in that records every call the driver makes (scripts/test-storage-default-unchanged.mjs)"],
  ["scripts/migrate-dataroom-root.mjs", "the one-time move of objects inside the Vercel Blob store itself; it is about that store by definition"],
  ["scripts/check-dataroom-folders.mjs", "the build gate's folded (folder) listing of a Vercel Blob store; on another driver the run-time write guard, which goes through the driver, is the check"],
  ["scripts/check-storage-driver.mjs", "this file: its self-test spells the imports it must catch"],
]);

/** Where the Vercel Blob host may be named in code. */
const HOST_ALLOWED = (file) => file.startsWith("lib/storage/") || file.startsWith("scripts/") || file.startsWith("tests/") || file.startsWith("docs/");

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|\.next|\.output|\.eve|\.vercel|build|dist)\//;

const IMPORT_PATTERNS = [
  /\bfrom\s*["']@vercel\/blob(?:\/[^"']*)?["']/,
  /\bimport\s*\(\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]\s*\)/,
  /\brequire\s*\(\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]\s*\)/,
  /\bimport\s*["']@vercel\/blob(?:\/[^"']*)?["']/,
];
const HOST_PATTERN = /vercel-storage\.com/;

/**
 * Is this line a comment? Decided from how the line STARTS (`//`, `/*`, or the ` * ` of a block comment), which is
 * how every comment in this codebase is written. Deliberately not a tokenizer: one that tracks strings and block
 * comments can be put out of step by a regular expression or a glob (`"src/**\/*.ts"`) and then hide real code after
 * it. This rule can only err the loud way: a comment written some other way is reported, never an import missed.
 */
const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);
/** The code on a line, without a trailing `// …` comment (a `//` after a quote or colon is a URL, and is kept). */
const codeOf = (line) => line.replace(/(^|[\s;,)}\]])\/\/.*$/, "$1");

/** Problems in one file: [{ file, line, rule, text }]. */
export function problemsIn(file, text) {
  if (!SOURCE.test(file) || SKIP.test(file)) return [];
  const problems = [];
  text.split("\n").forEach((raw, index) => {
    if (isCommentLine(raw)) return;
    const line = codeOf(raw);
    if (file !== DRIVER && !IMPORT_EXEMPT.has(file) && IMPORT_PATTERNS.some((re) => re.test(line))) {
      problems.push({ file, line: index + 1, rule: "import", text: raw.trim() });
    }
    if (!HOST_ALLOWED(file) && HOST_PATTERN.test(line)) {
      problems.push({ file, line: index + 1, rule: "host", text: raw.trim() });
    }
  });
  return problems;
}

function selfTest() {
  let failed = 0;
  const expect = (label, file, text, rules) => {
    const got = problemsIn(file, text).map((p) => p.rule);
    const ok = JSON.stringify(got) === JSON.stringify(rules);
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(rules)}`}`);
  };
  console.log("check-storage-driver self-test");
  expect("a static import in a route fails", "app/api/x/route.ts", `import { put } from "@vercel/blob";\n`, ["import"]);
  expect("…with single quotes", "lib/x.ts", `import { put } from '@vercel/blob';\n`, ["import"]);
  expect("…a multi-line import", "agent/lib/x.ts", `import {\n  put,\n  del,\n} from "@vercel/blob";\n`, ["import"]);
  expect("…a type-only import", "lib/x.ts", `import type { PutBlobResult } from "@vercel/blob";\n`, ["import"]);
  expect("…the client entry point", "app/_components/x.tsx", `import { upload } from "@vercel/blob/client";\n`, ["import"]);
  expect("…a dynamic import", "scripts/x.mjs", `const api = await import("@vercel/blob");\n`, ["import"]);
  expect("…a require", "scripts/x.cjs", `const { put } = require("@vercel/blob");\n`, ["import"]);
  expect("…a re-export", "lib/x.ts", `export { put } from "@vercel/blob";\n`, ["import"]);
  expect("…a side-effect import", "lib/x.ts", `import "@vercel/blob";\n`, ["import"]);
  expect("…in the task-workflow service too", "services/task-workflow/lib/x.ts", `import { put } from "@vercel/blob";\n`, ["import"]);
  expect("…and in another file under lib/storage/", "lib/storage/filesystem.ts", `import { put } from "@vercel/blob";\n`, ["import"]);
  expect("the driver itself may import it", DRIVER, `import { put } from "@vercel/blob";\n`, []);
  expect("a listed exemption may import it", "scripts/migrate-dataroom-root.mjs", `const api = await import("@vercel/blob");\n`, []);
  expect("a comment that mentions the package passes", "app/api/x/route.ts", `// used to import "@vercel/blob" here\n/* import { put } from "@vercel/blob"; */\n/**\n * import { put } from "@vercel/blob";\n */\nexport const x = 1; // was: from "@vercel/blob"\n`, []);
  expect("a string that merely names the package passes", "lib/x.ts", `const NAME = "@vercel/blob";\n`, []);
  expect("another package with a similar name passes", "lib/x.ts", `import { x } from "@vercel/blobby";\nimport { y } from "@vercel/functions";\n`, []);
  expect("the host in application code fails", "app/api/x/route.ts", `const ok = hostname.endsWith(".vercel-storage.com");\n`, ["host"]);
  expect("…in a client component", "app/_components/x.tsx", `return hostname === "vercel-storage.com";\n`, ["host"]);
  expect("…in the agent", "agent/lib/x.ts", `const HOST = "x.private.blob.vercel-storage.com";\n`, ["host"]);
  expect("the host in a comment passes", "lib/pdf-preview.ts", `/**\n * (\`…private.blob.vercel-storage.com/dataroom/…\`)\n */\n// vercel-storage.com\nexport const x = 1; // not vercel-storage.com\n`, []);
  expect("…but not when real code follows a glob or a regular expression that looks like a comment", "lib/x.ts", `const GLOB = "src/**/*.ts";\nconst RE = /["']/;\nconst api = await import("@vercel/blob");\nconst h = "https://x.vercel-storage.com/a";\n`, ["import", "host"]);
  expect("the host under lib/storage/ passes", "lib/storage/hosts.ts", `return h === "vercel-storage.com";\n`, []);
  expect("the host in a test passes (a fixture for the default driver)", "scripts/test-x.mjs", `const url = "https://x.blob.vercel-storage.com/a";\n`, []);
  expect("both problems on one line are both reported", "app/x.ts", `import { put } from "@vercel/blob"; const h = "vercel-storage.com";\n`, ["import", "host"]);
  expect("a non-source file is ignored", "docs/STORAGE.md", `import { put } from "@vercel/blob";\n`, []);
  expect("line numbers survive a block comment", "lib/x.ts", `/*\n * a\n */\nimport { put } from "@vercel/blob";\n`, ["import"]);
  const line = problemsIn("lib/x.ts", `/*\n * a\n */\nimport { put } from "@vercel/blob";\n`)[0]?.line;
  if (line !== 4) {
    failed++;
    console.log(`  FAIL the reported line is the file's (got ${line}, want 4)`);
  } else console.log("  ok   the reported line is the file's");
  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall ok");
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && SOURCE.test(f) && !SKIP.test(f));
  const problems = [];
  let driverImports = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (file === DRIVER) driverImports = text.split("\n").some((line) => !isCommentLine(line) && IMPORT_PATTERNS.some((re) => re.test(line)));
    problems.push(...problemsIn(file, text));
  }
  if (!driverImports) problems.push({ file: DRIVER, line: 1, rule: "driver", text: "the Vercel Blob driver is missing or no longer imports @vercel/blob: this check would pass with nothing to protect" });
  if (problems.length === 0) {
    console.log(`check-storage-driver: ok — ${files.length} files; @vercel/blob is imported by ${DRIVER} only (${IMPORT_EXEMPT.size} listed exemptions outside the app), and no application code names the Vercel Blob host.`);
    return;
  }
  for (const p of problems) {
    const why =
      p.rule === "import"
        ? "imports @vercel/blob directly: use the storage driver (lib/storage) instead"
        : p.rule === "host"
          ? "names the Vercel Blob host: ask the driver (storageUrlRules() on the server, isStorageHostForBrowser() in a client component)"
          : p.text;
    console.error(`${p.file}:${p.line}: ${why}${p.rule === "driver" ? "" : `\n    ${p.text}`}`);
  }
  console.error(`\ncheck-storage-driver: ${problems.length} problem(s).`);
  process.exit(1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
