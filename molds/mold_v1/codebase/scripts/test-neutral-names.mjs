#!/usr/bin/env node
/**
 * test:neutral-names — the neutral-names ratchet catches every kind of new
 * occurrence, lets every declared allowance through, and does not mistake
 * a substring for the word. The same for the record words written as prose
 * (customer, deployment, implementation, rollout; scripts/lib/record-words.mjs):
 * prose in a prompt, a string literal, JSX text or a JSON value is caught; an
 * identifier, a path, a code span, a quoted value, a placeholder or a listed
 * name is not; and the per-file ceilings ratchet both ways.
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
import { proseRecordWords, recordWordsInFile } from "./lib/record-words.mjs";

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

/* 1b. The record-word matcher: prose, never a name. ------------------------------- */
const prose = (s, n = new Set(["customer-context", "deployment"])) => proseRecordWords(s, n).map((h) => h.word);
check("a record word in a sentence is prose, in any case and number", prose("Each Customer has deployments; one implementation per rollout.").join() === "Customer,deployments,implementation,rollout");
check("a compound is prose", prose("customer-facing, per-customer, the customer's own").length === 3);
check("identifiers are not prose", prose("customer_id customerId list_customers deploymentId implementationStage rolloutId CUSTOMER_ID").length === 0);
check("paths, routes, scopes, flags and query values are not prose", prose("Customers/acme /api/ops/customers customer:acme customer:{id} --customer ?tab=deployments record.customer customer.name deployments[]").length === 0);
check("code spans and quoted values are not prose", prose("set `customer` or 'deployment' or \"rollout\"; ```\nkey: `implementation`\n```").length === 0);
check("placeholders are not prose", prose("{account} {customer} {customer_id} ${customer} <customer>").length === 0);
check("a specialist's name is a name: hyphenated anywhere, a single word only in bold", prose("ask customer-context, or **deployment**").length === 0 && prose("ask deployment").length === 1);
check("a data-room domain's stored name inside a sentence is the folder", prose("across Customers, Platform, Deployments and Implementation").length === 0);
check("…and at the start of a sentence it is the word", prose("Customers are listed first.").join() === "Customers");
check("a wrapped line is not a new sentence", prose("the seven domains (Platform,\nDeployments, Solutions)").length === 0);
check("one token is a key or a value; a capitalised record word alone is a label", prose("customers").length === 0 && prose("deployment").length === 0 && prose("Rollouts").length === 1 && prose("Customers").length === 0);
check("a source file is read for its texts only", recordWordsInFile("x.ts", '// customer\nconst customer = "a customer";\n').length === 1);

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
  record_words: {
    scan: { "src/**": "source", "prompt.md": "a prompt", "profile.json": "a profile" },
    skip: { "src/**/*.generated.ts": "derived" },
    names: { "customer-context": "a specialist's directory name", deployment: "a specialist's directory name", "Waiting on Customer": "a stored enum value" },
    ceilings: {},
  },
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

  // The record words (customer, deployment, implementation, rollout) written as prose in base text.
  ["a record word in a prompt with no ceiling fails", { "prompt.md": `You help an ${U} and their ${U} owner with each customer.\n` }, null, 1, /prompt\.md: 1 record word\(s\) written as prose in a file with no ceiling/],
  ["a record word in a string literal fails", { "src/b.ts": 'export const m = `Customer ${id} not found`;\n' }, null, 1, /src\/b\.ts: 1 record word\(s\) written as prose in a file with no ceiling \(1: "Customer"/],
  ["a record word in JSX text fails", { "src/b.tsx": "export const A = () => <p>No deployments yet</p>;\n" }, null, 1, /src\/b\.tsx: 1 record word/],
  ["a record word in a JSON string value fails; a key and a $comment do not", { "profile.json": '{"$comment": "a customer", "customer": {"label": "Stalled customers"}}\n' }, null, 1, /profile\.json: 1 record word/],
  ["a capitalised record word alone is a label, and fails", { "src/b.ts": 'export const title = "Rollouts";\n' }, null, 1, /src\/b\.ts: 1 record word/],
  [
    "identifiers, paths, code, quoted values, placeholders, comments, statements and listed names are not prose",
    {
      "src/b.ts":
        '// the customer of a deployment\nimport x from "./customer";\nconst k = "customer";\nconst q = sql`select * from customers where rollout = 1`;\n' +
        "export const m = \"Read customer_id and customerId from Customers/acme with list_customers; `customer` is 'deployment' in deployments[]; customer:acme; --customer <id>; {account} {customer_id} ${customer}; ask customer-context or **deployment**; status Waiting on Customer; across Customers, Deployments and Implementation\";\n",
      "src/c.generated.ts": 'export const m = "every customer";\n',
    },
    null,
    0,
    /record words as prose in base text: 0 under 0 file ceiling/,
  ],
  ["a record word over its ceiling fails", { "prompt.md": `An ${U}, an ${U} owner, a customer and a rollout.\n` }, (a) => ({ ...a, record_words: { ...a.record_words, ceilings: { later: { why: "another PR", files: { "prompt.md": 1 } } } } }), 1, /prompt\.md: 2 record word\(s\) written as prose, over its ceiling of 1/],
  ["a record word under its ceiling passes", { "prompt.md": `An ${U}, an ${U} owner and a customer.\n` }, (a) => ({ ...a, record_words: { ...a.record_words, ceilings: { later: { why: "another PR", files: { "prompt.md": 1 } } } } }), 0, /record words as prose in base text: 1 under 1 file ceiling/],
  ["fewer than the ceiling fails, naming the new ceiling", { "prompt.md": `An ${U}, an ${U} owner and a customer.\n` }, (a) => ({ ...a, record_words: { ...a.record_words, ceilings: { later: { why: "another PR", files: { "prompt.md": 3 } } } } }), 1, /under its ceiling of 3: lower record_words\.ceilings\["later"\]\.files\["prompt\.md"\] to 1/],
  ["a ceiling on a file that carries none fails", {}, (a) => ({ ...a, record_words: { ...a.record_words, ceilings: { later: { why: "another PR", files: { "prompt.md": 1 } } } } }), 1, /prompt\.md: has a record-word ceiling but carries none now/],
  ["a ceiling group with no reason is refused", {}, (a) => ({ ...a, record_words: { ...a.record_words, ceilings: { later: { files: { "prompt.md": 1 } } } } }), 1, /needs a "why" and "files"/],
  ["an allow-list with no record_words section is refused, not treated as nothing to check", {}, (a) => ({ ...a, record_words: undefined }), 1, /has no "record_words" section/],
  ["an empty scan list is refused", {}, (a) => ({ ...a, record_words: { ...a.record_words, scan: {} } }), 1, /scan parsed as empty/],
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
console.log("\ntest-neutral-names: every kind of new occurrence is caught (the role word, and the record words as prose); every declared allowance holds");
