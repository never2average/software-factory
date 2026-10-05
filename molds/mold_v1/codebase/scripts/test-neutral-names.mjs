#!/usr/bin/env node
/**
 * test:neutral-names — the neutral-names ratchet catches every kind of new
 * occurrence, lets every declared allowance through, and does not mistake
 * a substring for the word. The same for the record words written as prose
 * (customer, deployment, implementation, rollout; scripts/lib/record-words.mjs):
 * prose in a prompt, a string literal, JSX text or a JSON value is caught; an
 * identifier, a path, a code span, a quoted value, a placeholder or a listed
 * name is not; and the per-file ceilings ratchet both ways. And the same for the
 * data-room folder names (scripts/lib/stored-folders.mjs): a path that starts
 * with one, in code or in a comment, and a value that is exactly one, are caught
 * in a file with no ceiling; a placeholder, FOLDER.<id> and the one legacy
 * definition are not.
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
import { legacyFolders } from "./lib/profile-folders.mjs";
import { storedFolderNames, storedFoldersInFile } from "./lib/stored-folders.mjs";

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
check("paths, routes, scopes, flags and query values are not prose", prose("records/customers/acme /api/ops/customers customer:acme customer:{id} --customer ?tab=deployments record.customer customer.name deployments[]").length === 0);
check("code spans and quoted values are not prose", prose("set `customer` or 'deployment' or \"rollout\"; ```\nkey: `implementation`\n```").length === 0);
check("placeholders are not prose", prose("{account} {customer} {customer_id} ${customer} <customer>").length === 0);
check("a specialist's name is a name: hyphenated anywhere, a single word only in bold", prose("ask customer-context, or **deployment**").length === 0 && prose("ask deployment").length === 1);
// The names the data-room folders once had (read from their one definition, never written here): three of them
// are record words. A domain is written as a placeholder now, so such a word in a sentence is the word.
const OLD = legacyFolders(ROOT);
check("a data-room domain's former folder name in a sentence is a record word like any other", prose(`across ${OLD.accounts}, ${OLD.platform}, ${OLD.deliveries} and ${OLD.projects}`).join() === [OLD.accounts, OLD.deliveries, OLD.projects].join());
check("…and so is one standing alone as a label", prose(OLD.accounts).length === 1 && prose(OLD.projects).length === 1);
check("a domain written as a placeholder is not prose", prose("across {domain:accounts} and {domain:deliveries}; read {folder:projects}/{customer_id}/x").length === 0);
check("one token is a key or a value; a capitalised record word alone is a label", prose("customers").length === 0 && prose("deployment").length === 0 && prose("Rollouts").length === 1);

/* 1c. The stored-folder matcher: a path head anywhere, an exact value in a literal. */
{
  const names = ["Ledger", "Oldbooks", "Inbox"];
  const found = (path, text, opt) => storedFoldersInFile(path, text, names, opt).map((h) => `${h.kind}:${h.name}`).join();
  check("a path that starts with a folder name is found, in a string and in a comment", found("src/a.ts", "// reads Ledger/{id}/x.md\nconst p = `Ledger/${id}/x.md`;\n") === "path:Ledger,path:Ledger");
  check("…deeper in a longer path too", found("src/a.ts", 'const p = "orgs/a/Oldbooks/acme/context.md";\n') === "path:Oldbooks");
  check("a value that is exactly a folder name is found", found("src/a.ts", 'store.list("Ledger");\n') === "value:Ledger");
  check("…and in a JSON value, never in a key", found("data/x.json", '{"Ledger": {"sheet": "Ledger", "path": "Inbox/a/b.pdf"}}\n') === "path:Inbox,value:Ledger");
  check("a placeholder, an interpolation and an identifier are not a name", found("src/a.ts", "const p = `${FOLDER.accounts}/x`; const t = '{folder:accounts}/x and {domain:accounts}'; const LedgerView = 1; const u = 'my.Ledger/x'; const k = 'SubLedger/x';\n") === "");
  check("the word in a sentence is not a folder", found("src/a.ts", 'const t = "The Ledger is closed and the Inbox is empty";\n') === "");
  check("a test's strings are read for path heads only", found("src/a.test.ts", 'eq(label, "Ledger"); read("Ledger/x");\n', { values: false }) === "path:Ledger");
  const real = storedFolderNames(ROOT);
  check("the names are read from the one legacy definition and the default profile, and from nowhere else", Object.values(OLD).every((n) => real.includes(n)) && real.length >= Object.keys(OLD).length);
}
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
  stored_folders: {
    scan: { "src/**": "source", "tests/**": "tests", "prompt.md": "a prompt", "data/**": "fixtures" },
    values_in: { "src/**": "source", "data/**": "fixtures" },
    skip: { "src/**/*.generated.ts": "derived", "scripts/lib/legacy-dataroom-folders.json": "the one legacy definition" },
    ceilings: {},
  },
  builtin_library: {
    libraries: { "library/**": "the library directories a profile names" },
    skip: { "tests/**": "tests insert the rows they assert on" },
    writers: {},
  },
  // What a work period is called (scripts/lib/period-words.mjs). The planted tree's default word is made up
  // ("lap"), so that the real one is not written in this file.
  period_words: {
    default_profile: { "profiles/00-default.json": "the word's home" },
    legacy_definition: { why: "the one definition", files: { "src/schema.ts": 1 } },
    contracts: [{ pattern: "lap_(?:list|create)", files: ["src/wire.ts"], why: "wire tool names" }],
    exempt_paths: { "allow.json": "the list", "history/": "immutable" },
  },
});
const clean = {
  // The planted tree's own folder names: a former one and the default profile's. Made up, so that no real one is
  // written in this file.
  "scripts/lib/legacy-dataroom-folders.json": '{"$comment": "the former names", "accounts": "Oldbooks", "uploads": "Inbox"}\n',
  "profiles/00-default.json": '{"dataroom": {"domains": {"accounts": {"folder": "Ledger"}}, "uploads_folder": "Inbox"}, "library": {"sources": {}}, "work_periods": {"label": {"singular": "lap", "plural": "laps"}}}\n',
  "src/schema.ts": "// A CYCLE: a time-boxed iteration (a lap).\nexport const cycles = 1;\n",
  "src/wire.ts": 'export const tools = ["lap_list", "lap_create"];\n',
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
        "export const m = \"Read customer_id and customerId from records/customers/acme with list_customers; `customer` is 'deployment' in deployments[]; customer:acme; --customer <id>; {account} {customer_id} ${customer}; ask customer-context or **deployment**; status Waiting on Customer; across {domain:accounts}, {domain:deliveries} and {domain:projects}\";\n",
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

  // The data-room folder names: the default profile's and the former ones, spelled nowhere in base code.
  ["a path built on the default profile's folder name fails", { "src/b.ts": "export const p = (id) => `Ledger/${id}/context.md`;\n" }, null, 1, /src\/b\.ts: 1 stored folder name\(s\) spelled in a file with no ceiling \(1: "Ledger\/"/],
  ["a path built on a former folder name fails", { "src/b.ts": 'export const p = "Oldbooks/acme/context.md";\n' }, null, 1, /src\/b\.ts: 1 stored folder name\(s\) spelled in a file with no ceiling \(1: "Oldbooks\/"/],
  ["a path in a comment fails: the next edit copies it", { "src/b.ts": "// writes Ledger/{id}/notes.md\nexport {};\n" }, null, 1, /src\/b\.ts: 1 stored folder name/],
  ["a path in a prompt fails", { "prompt.md": `You help an ${U} and their ${U} owner. Read Inbox/{person_id}/ first.\n` }, null, 1, /prompt\.md: 1 stored folder name/],
  ["a value that is exactly a folder name fails in code that ships", { "src/b.ts": 'export const all = store.list("Ledger");\n' }, null, 1, /src\/b\.ts: 1 stored folder name\(s\) spelled in a file with no ceiling \(1: "Ledger" in/],
  ["a fixture's path fails; its placeholder does not", { "data/x.json": '{"path": "Ledger/a/context.md", "other": "{folder:accounts}/a/context.md"}\n' }, null, 1, /data\/x\.json: 1 stored folder name/],
  ["a test may compare a label with the word, and may not hardcode a path", { "tests/a.ts": 'eq(label, "Ledger");\nread("Ledger/a/x.md");\n' }, null, 1, /tests\/a\.ts: 1 stored folder name\(s\) spelled in a file with no ceiling \(2: "Ledger\/"/],
  [
    "FOLDER.<id>, a placeholder, the word in a sentence, a generated file and the legacy definition itself are not spellings",
    {
      "src/b.ts": "import { FOLDER } from './folders';\nexport const p = (id) => `${FOLDER.accounts}/${id}/context.md`;\nexport const t = 'Read {folder:accounts}/{customer_id}/context.md; the Ledger is shared';\n",
      "src/c.generated.ts": 'export const folders = { accounts: "Ledger" }; export const p = "Ledger/x";\n',
    },
    null,
    0,
    /stored folder names \(3 known: the former ones and the default profile's\) spelled in base code: 0 under 0 file ceiling/,
  ],
  ["a folder name over its ceiling fails", { "src/b.ts": 'export const a = "Ledger/x"; export const b = "Ledger/y";\n' }, (a) => ({ ...a, stored_folders: { ...a.stored_folders, ceilings: { later: { why: "another PR", files: { "src/b.ts": 1 } } } } }), 1, /src\/b\.ts: 2 stored folder name\(s\) spelled, over its ceiling of 1/],
  ["a folder name under its ceiling passes", { "src/b.ts": 'export const a = "Ledger/x";\n' }, (a) => ({ ...a, stored_folders: { ...a.stored_folders, ceilings: { later: { why: "another PR", files: { "src/b.ts": 1 } } } } }), 0, /spelled in base code: 1 under 1 file ceiling/],
  ["fewer than the ceiling fails, naming the new ceiling", { "src/b.ts": 'export const a = "Ledger/x";\n' }, (a) => ({ ...a, stored_folders: { ...a.stored_folders, ceilings: { later: { why: "another PR", files: { "src/b.ts": 2 } } } } }), 1, /under its ceiling of 2: lower stored_folders\.ceilings\["later"\]\.files\["src\/b\.ts"\] to 1/],
  ["a ceiling on a file that spells none fails", {}, (a) => ({ ...a, stored_folders: { ...a.stored_folders, ceilings: { later: { why: "another PR", files: { "src/b.ts": 1 } } } } }), 1, /src\/b\.ts: has a stored-folder ceiling but spells none now/],
  ["a ceiling group with no reason is refused", {}, (a) => ({ ...a, stored_folders: { ...a.stored_folders, ceilings: { later: { files: { "src/b.ts": 1 } } } } }), 1, /stored_folders\.ceilings\["later"\] needs a "why" and "files"/],
  ["an allow-list with no stored_folders section is refused, not treated as nothing to check", {}, (a) => ({ ...a, stored_folders: undefined }), 1, /has no "stored_folders" section/],
  ["an empty scan list is refused", {}, (a) => ({ ...a, stored_folders: { ...a.stored_folders, scan: {} } }), 1, /stored_folders\.scan parsed as empty/],
  // The built-in library (scripts/lib/builtin-library.mjs): base code ships no workflow and no recipe of its own.
  ["a workflow script outside a library directory fails", { "scripts/operator/workflows/qbr.workflow.js": 'export const meta = { name: "qbr", description: "d" };\n' }, null, 1, /scripts\/operator\/workflows\/qbr\.workflow\.js: a workflow script outside a library directory/],
  ["…and passes inside one", { "library/ops/workflows/qbr.workflow.js": 'export const meta = { name: "qbr", description: "d" };\n' }, null, 0, /no workflow or recipe library in base code/],
  ["the default profile naming a library source fails", { "profiles/00-default.json": '{"dataroom": {"domains": {"accounts": {"folder": "Ledger"}}, "uploads_folder": "Inbox"}, "work_periods": {"label": {"singular": "lap", "plural": "laps"}}, "library": {"sources": {"ops": "library/ops"}}}\n' }, null, 1, /profiles\/00-default\.json: library\.sources names ops/],
  ["the default profile with no library key fails", { "profiles/00-default.json": '{"dataroom": {"domains": {"accounts": {"folder": "Ledger"}}, "uploads_folder": "Inbox"}, "work_periods": {"label": {"singular": "lap", "plural": "laps"}}}\n' }, null, 1, /profiles\/00-default\.json: library\.sources is missing/],
  ["a recipe written as a literal in base code fails", { "src/b.ts": 'export const BUILTIN = [{ slug: "onboard-self", title: "Sign in", satisfiesCheck: "members" }];\n' }, null, 1, /src\/b\.ts: a recipe written as a literal/],
  ["…and passes as a row of a library's recipes.json", { "library/ops/recipes.json": '{"recipes": [{"slug": "onboard-self", "title": "Sign in", "satisfiesCheck": "members"}]}\n' }, null, 0, /no recipe literal/],
  ["a new file that inserts into workflows fails until it is listed", { "src/b.ts": "await db.insert(workflows).values(rows);\n" }, null, 1, /src\/b\.ts: inserts into the workflows, recipes or apps table and is not a listed writer/],
  ["…in SQL too, and into recipes", { "src/b.mjs": "await sql`INSERT INTO recipes (org_id, slug) VALUES (${o}, ${s})`;\n" }, null, 1, /src\/b\.mjs: inserts into the workflows, recipes or apps table/],
  ["a listed writer passes", { "src/b.ts": "await db.insert(workflows).values(rows);\n" }, (a) => ({ ...a, builtin_library: { ...a.builtin_library, writers: { "src/b.ts": "one row a person asked for" } } }), 0, /1 listed writer\(s\)/],
  ["a listed writer that no longer inserts fails", {}, (a) => ({ ...a, builtin_library: { ...a.builtin_library, writers: { "src/b.ts": "one row a person asked for" } } }), 1, /src\/b\.ts: listed in builtin_library\.writers but no longer inserts/],
  // Starter apps (the apps a new workspace is created with) are a library's too.
  ["starter apps outside a library directory fail", { "src/apps.json": '{"apps": [{"key": "digest", "name": "Digest", "description": "d", "brief": "b", "source": {"specialist": "research"}}]}\n' }, null, 1, /src\/apps\.json: starter apps outside a library directory/],
  ["…and pass as a library's apps.json", { "library/ops/apps.json": '{"apps": [{"key": "digest", "name": "Digest", "description": "d", "brief": "b", "source": {"specialist": "research"}}]}\n' }, null, 0, /no starter app outside a library/],
  ["a starter app written as a literal in base code fails", { "src/b.ts": 'export const DEFAULT_APPS = [{ name: "Digest", brief: "Summarise the week.", firstContent: "on_open" }];\n' }, null, 1, /src\/b\.ts: a starter app written as a literal/],
  ["…and so does a literal starter key", { "src/b.ts": 'const row = { name: "Digest", starterKey: "base/digest" };\n' }, null, 1, /src\/b\.ts: a starter app written as a literal/],
  ["a new file that inserts into apps fails until it is listed", { "src/b.ts": "await db.insert(apps).values(DEFAULTS);\n" }, null, 1, /src\/b\.ts: inserts into the workflows, recipes or apps table and is not a listed writer/],
  ["a test may insert the rows it asserts on", { "tests/a.ts": "await db.insert(workflows).values(rows);\n" }, null, 0, /0 listed writer\(s\)/],
  ["an allow-list with no builtin_library section is refused, not treated as nothing to check", {}, (a) => ({ ...a, builtin_library: undefined }), 1, /builtin_library\.libraries parsed as empty/],
  // What a work period is called: the default profile's word (here "lap"), anywhere but its declared homes.
  ["the clean tree spells the period word only in its homes", {}, null, 0, /word for a work period \("laps", "lap", read from profiles\/00-default\.json\) is spelled 3 time\(s\) outside it/],
  ["the period word in a label fails", { "src/panel.tsx": 'export const label = "Lap lead";\n' }, null, 1, /src\/panel\.tsx:1: the default profile's word for a work period \("lap"\) is spelled 1 time/],
  ["the plural in a sentence fails", { "src/tool.ts": 'export const d = "List the team\'s cycles (laps).";\n' }, null, 1, /src\/tool\.ts:1: .* spelled 1 time/],
  ["as part of an identifier it fails (camelCase, snake_case, a file name)", { "src/a2.ts": "const lapCount = 1; const next_lap = 2; const isLap = 3;\n", "src/lap-board.ts": "export {};\n" }, null, 1, /src\/a2\.ts:1: .* spelled 3 time[\s\S]*src\/lap-board\.ts:path/],
  ["a word that merely contains the letters is not an occurrence", { "src/b2.ts": 'const overlap = 1; const laptop = "collapse"; // elapsed, lapse, Laplace\n' }, null, 0, /spelled 3 time\(s\) outside it/],
  ["a placeholder and a word taken from the profile are not spellings", { "src/c2.ts": 'export const d = fill("List the {periods}."); export const l = W.Period;\n' }, null, 0, /spelled 3 time\(s\) outside it/],
  ["a contract name outside the files it is listed for fails", { "src/other.ts": 'call("lap_list");\n' }, null, 1, /src\/other\.ts:1: .* spelled 1 time/],
  ["a second spelling in the legacy definition fails", { "src/schema.ts": "// A CYCLE: a time-boxed iteration (a lap). Every lap has a lead.\n" }, null, 1, /src\/schema\.ts: the legacy definition spells the period word 2 times, over its count of 1/],
  ["a legacy definition that no longer spells it fails", { "src/schema.ts": "// A CYCLE: a time-boxed iteration.\n" }, null, 1, /src\/schema\.ts: listed as the legacy definition but no longer spells/],
  ["a second legacy definition is refused", {}, (a) => ({ ...a, period_words: { ...a.period_words, legacy_definition: { why: "two", files: { "src/schema.ts": 1, "src/wire.ts": 1 } } } }), 1, /there is ONE legacy definition/],
  ["a contract that no longer occurs fails", { "src/wire.ts": "export const tools = [];\n" }, null, 1, /period_words contract \/lap_\(\?:list\|create\)\/ no longer occurs anywhere/],
  ["a contract with no reason is refused", {}, (a) => ({ ...a, period_words: { ...a.period_words, contracts: [{ pattern: "lap_list" }] } }), 1, /contracts\[0\] needs a "pattern" and a "why"/],
  ["an allow-list with no period_words section is refused, not treated as nothing to check", {}, (a) => ({ ...a, period_words: undefined }), 1, /has no "period_words" section/],
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
console.log("\ntest-neutral-names: every kind of new occurrence is caught (the role word, the record words as prose, a data-room folder name, a workflow or recipe library in base code, a work period's word); every declared allowance holds");
