#!/usr/bin/env node
/**
 * test:neutral-names — the neutral-names ratchet catches every kind of new
 * occurrence, lets every declared allowance through, and does not mistake
 * a substring for the word.
 *
 * A gate whose failing cases are never exercised quietly stops working, so each
 * kind of offender is PLANTED in a throwaway tree (no git, so the plain walk is
 * used) and the real CLI is run against it with a small allow-list. Then the
 * real repository is checked with the real list, which is what CI gates on.
 *
 * On the commit before this one it fails: the check, its library and its list
 * did not exist, and the tree carried ~80 occurrences none of them would allow
 * (the CI database name, comments, a symbol key, an exported identifier, a
 * private package's scope).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { occurrencesIn } from "./lib/neutral-names.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CHECK = join(ROOT, "scripts/check-neutral-names.mjs");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
};

// The word is assembled, never written whole, so this file needs no allowance of its own
// beyond its exempt path, and a reader can see which strings are the planted offenders.
const w = ["f", "d", "e"].join("");
const U = w.toUpperCase();
const C = w[0].toUpperCase() + w.slice(1);

/* 1. The matcher: words and identifier parts, never substrings. ------------------- */
const names = (s) => occurrencesIn(s).map((o) => o.name);
check("a snake_case contract is one name", names(`${w}_owner`).join() === `${w}_owner`);
check("an env name is one name", names(`process.env.${U}_OPS_URL`).join() === `${U}_OPS_URL`);
check("a camelCase part is found", names(`solution${C}Owner`).join() === `solution${C}Owner`);
check("an npm script is one name", names(`npm run ${w}:new-org -- --x`).join() === `${w}:new-org`);
check("a colon-joined claim is not an npm script", names(`owner:a:project:${w}-agent:environment:x`).join() === `${w}-agent`);
check("the bare word is bare", occurrencesIn(`an ${U} owner`).every((o) => o.bare) && occurrencesIn(`${U}s`)[0]?.bare === true);
check("a regex escape is a boundary", names(`/\\b${U} owner/`).join() === U);
check(
  "substrings are not the word",
  names(`con${w}ltype wf${"De"}fs Ref${"De"}tail 3${w}41 dead${"bee"}${w}adbeef`).length === 0,
  JSON.stringify(names(`con${w}ltype 3${w}41`)),
);

/* 2. The gate, against a planted tree. -------------------------------------------- */
const tree = (files, allow) => {
  const dir = mkdtempSync(join(tmpdir(), "neutral-names-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, "allow.json"), JSON.stringify(allow));
  return dir;
};
const run = (dir) => {
  const r = spawnSync(process.execPath, [CHECK, "--root", dir, "--allow", join(dir, "allow.json")], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const baseAllow = () => ({
  exempt_paths: { "allow.json": "the list", "history/": "immutable" },
  contracts: { [`${w}_owner`]: { kind: "database column", plan: "a later PR" } },
  examples: {},
  base_word: { vocab: { why: "default profile words", files: { "prompt.md": 2 } } },
});
const clean = {
  "src/a.ts": `select ${w}_owner from customers; // the contract, anywhere\nconst owner = 1;\n`,
  "prompt.md": `You help an ${U} and their ${U} owner.\n`,
  "history/0001.json": `{"${w}Thing": "${U}_OLD"}\n`,
};

const cases = [
  ["a clean tree passes (contract anywhere, bare word under its ceiling, exempt path unread)", {}, null, 0, /every occurrence is accounted for/],
  ["a new identifier fails", { "src/b.ts": `const ${w}Thing = 1;\n` }, null, 1, new RegExp(`src/b\\.ts:1: "${w}Thing"`)],
  ["a new environment variable fails", { "src/b.ts": `process.env.${U}_NEW\n` }, null, 1, new RegExp(`"${U}_NEW"`)],
  ["a new camelCase part fails", { "src/b.ts": `x.owner${C}Id\n` }, null, 1, new RegExp(`"owner${C}Id"`)],
  ["a new npm script fails", { "package.json": `{"scripts":{"${w}:thing":"x"}}\n` }, null, 1, new RegExp(`"${w}:thing"`)],
  ["a file named with the word fails", { [`src/${w}-helper.ts`]: "export {};\n" }, null, 1, new RegExp(`the path carries "${w}-helper"`)],
  ["a directory named with the word fails", { [`src/${w}/x.ts`]: "export {};\n" }, null, 1, new RegExp(`the path carries "${w}"`)],
  ["the bare word in a file with no ceiling fails", { "src/b.ts": `// ask the ${U}\n` }, null, 1, /in a file with no ceiling/],
  ["the bare word over its ceiling fails", { "prompt.md": `An ${U}, an ${U} owner, and ${U}s.\n` }, null, 1, /over its ceiling of 2/],
  ["the bare word under its ceiling fails, naming the new ceiling", { "prompt.md": `You help an ${U}.\n` }, null, 1, /Lower the ceiling .* to 1/],
  ["a ceiling on a file that no longer has the word fails", { "prompt.md": "You help a member.\n" }, null, 1, /to 0 \(remove the entry\)/],
  ["a listed contract that no longer occurs fails", { "src/a.ts": "const owner = 1;\n" }, null, 1, new RegExp(`contract "${w}_owner" no longer occurs`)],
  [
    "an example name is allowed like a contract",
    { "src/b.ts": `plant("${w}_reindex")\n` },
    (a) => ({ ...a, examples: { [`${w}_reindex`]: { kind: "constructed offender", plan: "stays" } } }),
    0,
    /accounted for/,
  ],
  ["a contract with no plan is refused, not ignored", {}, (a) => ({ ...a, contracts: { [`${w}_owner`]: { kind: "x" } } }), 1, /needs a "kind" and a "plan"/],
  ["an empty contract list is refused, not treated as no allowance", {}, (a) => ({ ...a, contracts: {} }), 1, /parsed as empty/],
];
for (const [name, plant, editAllow, status, pattern] of cases) {
  const allow = editAllow ? editAllow(baseAllow()) : baseAllow();
  const dir = tree({ ...clean, ...plant }, allow);
  try {
    const r = run(dir);
    check(name, r.status === status && pattern.test(r.out), `exit ${r.status}: ${r.out.trim().split("\n").slice(0, 4).join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* 3. The real repository, with the real list: what CI gates on. ------------------- */
const real = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: "utf8" });
check("this repository passes its own list", real.status === 0, `${real.stdout}${real.stderr}`.trim().split("\n").slice(0, 6).join(" | "));

assert.equal(failures, 0, `${failures} neutral-names check(s) failed`);
console.log("\ntest-neutral-names: every kind of new occurrence is caught; every declared allowance holds");
