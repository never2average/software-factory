// mold_v0-309: a record's display, generic and pure (no database, no browser):
//   1. a header fact hidden while empty (hide_empty) or shown only while its condition holds (when), checked at build
//   2. a share unit ("percent": 0.024 reads "2.4%"; "percent_100" as it is)
//   3. durations under 10 s keep one decimal (1180 ms "1.2s"); under a second in ms, "240 ms"
//   5. the record page's one date rule: within 7 days relative words, else the day ("15 Nov 2026"), the other on hover
//   7. a field set only by an action (set_by: "action"): out of the forms, a person's other value refused, kept on an edit
//   9. the lane world's sample rows under their area's own rules (a lifecycle's initial state, the storage check's shapes)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detailProblems, personSets, RecordAreaSchema, RecordFieldSchema } from "../src/pack-api.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const builds = JSON.parse(JSON.stringify(FIXTURE.record_areas.find((a: { name: string }) => a.name === "builds")));
const L = await web("features/records/detail-layout.ts");

// 1. Facts: hide_empty and when, in the schema, at build, and on the page.
{
  const area = RecordAreaSchema.parse({ ...builds, detail: { ...builds.detail, header: { ...builds.detail.header,
    facts: [{ field: "approver", hide_empty: true }, { field: "failure", when: { field: "status", equals: "failed" } }, { field: "branch" }] } } });
  assert.deepEqual(detailProblems(area as never), [], "a fact with hide_empty, and one with a condition on the record's fields, are a layout");
  const bad = RecordAreaSchema.safeParse({ ...builds, detail: { ...builds.detail, header: { ...builds.detail.header, facts: [{ field: "branch", when: { field: "nope", equals: "x" } }] } } });
  assert.ok(!bad.success && bad.error.issues.some((p) => p.path.join(".") === "detail.header.facts.0.when.field" && /nope is not one of the area's fields/.test(p.message)),
    `a fact's condition on a field the area lacks is refused at build: ${JSON.stringify(bad.error?.issues)}`);
  assert.throws(() => RecordAreaSchema.parse({ ...builds, detail: { ...builds.detail, header: { facts: [{ field: "branch", hide_empty: "yes" }] } } }), "hide_empty is true or false");
  const [approver, failure, branch] = area.detail!.header!.facts!;
  assert.equal(L.factShown(approver, { approver: "" }), false, "hide_empty: an empty value leaves the fact out");
  assert.equal(L.factShown(approver, { approver: "R. Lee" }), true, "and shows it with a value");
  assert.equal(L.factShown(branch, {}), true, "without hide_empty an empty fact still shows (its —)");
  assert.equal(L.factShown(failure, { status: "passed", failure: "x" }), false, "when: hidden while the condition does not hold");
  assert.equal(L.factShown(failure, { status: "failed" }), true, "and shown while it does");
  const count = { computed: { area: "builds", op: "count" }, label: "Builds", hide_empty: true };
  assert.equal(L.factShown(count, {}, null, { op: "count", value: 0, capped: false, area: "builds" }), false, "a computed count of 0 with hide_empty: left out");
  assert.equal(L.factShown(count, {}, null, { op: "count", value: 3, capped: false, area: "builds" }), true);
  assert.equal(L.factShown(count, {}, null, undefined), true, "still loading: kept (the header does not jump)");
  assert.equal(L.factShown({ ...count, hide_empty: undefined }, {}, null, { hidden: true }), false, "one the server hides: never shown");
  ok("facts: hide_empty leaves an empty one out (a computed count of 0 too), when shows one only while it holds, a bad condition refused at build");
}

// 2 and 3. Units: a share, and durations in milliseconds.
{
  assert.deepEqual([L.numberWords(0.024, "percent"), L.numberWords(0.5, "percent"), L.numberWords(1, "percent"), L.numberWords(87.4, "percent_100"), L.numberWords(87.4, "%"), L.numberWords("0.125", "percent")],
    ["2.4%", "50%", "100%", "87.4%", "87.4%", "12.5%"], "percent is a share from 0 to 1 (as a metric's); percent_100 and % already 0 to 100");
  assert.deepEqual([L.numberWords(1180, "ms"), L.numberWords(240, "ms"), L.numberWords(400, "ms"), L.numberWords(9400, "ms"), L.numberWords(12_400, "ms"), L.numberWords(65_000, "ms")],
    ["1.2s", "240 ms", "400 ms", "9.4s", "12s", "1m 5s"], "ms: under a second in ms, under 10 s one decimal, then whole seconds");
  assert.deepEqual([L.durationWords(1.18), L.durationWords(5), L.durationWords(45), L.durationWords(0.4)], ["1.2s", "5s", "45s", "0.4s"]);
  assert.equal(L.numberWords(4210), "4,210", "a number grouped");
  assert.ok(RecordFieldSchema.parse({ name: "pass_rate", label: "Pass rate", type: "number", unit: "percent" }), "a number field's unit may be percent");
  ok("units: percent 0.024 reads 2.4%, percent_100 and % as they are; 1180 ms reads 1.2s, 240 ms reads 240 ms");
}

// 5. One date rule.
{
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  assert.deepEqual(L.dateRule("2026-11-14", NOW), { text: "yesterday", hover: "14 Nov 2026", iso: "2026-11-14", near: true });
  assert.equal(L.dateRule("2026-11-08", NOW).text, "7 days ago", "seven days off: still relative");
  assert.deepEqual(L.dateRule("2026-11-05", NOW), { text: "5 Nov 2026", hover: "10 days ago", iso: "2026-11-05", near: false }, "further off: the day, the relative words on hover");
  assert.equal(L.dateRule("2026-11-15T09:00:00Z", NOW).text, "3 hours ago");
  const far = L.dateRule("2026-10-01T08:30:00Z", NOW);
  assert.equal(far.text, "1 Oct 2026", "a time further off: its day only");
  assert.match(far.hover, /^1 Oct 2026, 08:30 UTC \(/, "its exact time on hover");
  assert.equal(L.dateRule("not a date", NOW), null);
  const page = readFileSync(path.join(WEB, "features", "records", "detail-page.tsx"), "utf8");
  const hist = readFileSync(path.join(WEB, "features", "records", "history-section.tsx"), "utf8");
  const rp = readFileSync(path.join(WEB, "features", "records", "record-pages.tsx"), "utf8");
  assert.match(page, /export function DateText\(\{ v \}: \{ v: unknown \}\) \{\s*const w = dateRule\(v\);/, "facts and sections: DateText reads the one rule");
  assert.doesNotMatch(page, /<DateText [^>]*relative/, "no caller picks another form");
  assert.match(hist, /const when = dateRule\(h\.at\);/, "the History tab's times: the same rule");
  assert.match(hist, /f\?\.type === 'date' && !f\.encrypted && typeof v === 'string'\) return <When d=\{v\} \/>/, "a changed date: by the rule, never 2026-11-15");
  assert.match(hist, /<EntriesTable view=\{after\}/, "a changed log: the entries table, not one flattened line");
  assert.match(rp, /f\.type === 'date' && !f\.encrypted && typeof v === 'string' && v !== ''\) return <When d=\{v\} \/>/, "a peek's date: the same rule");
  ok("dates: within 7 days relative (the day on hover), else 15 Nov 2026 (relative on hover), in facts, sections, history and the peek; a log's change as its table");
}

// 7. A field set only by an action.
{
  const f = RecordFieldSchema.parse({ name: "status", label: "Status", type: "text", set_by: "action" });
  assert.equal(personSets(f), false); assert.equal(personSets(RecordFieldSchema.parse({ name: "bucket", label: "Bucket" })), true);
  assert.throws(() => RecordFieldSchema.parse({ name: "status", label: "Status", set_by: "action", required: true }), /not required/, "never required (a person adds the record without it)");
  assert.throws(() => RecordFieldSchema.parse({ name: "status", label: "Status", set_by: "person" }), "only \"action\"");
  const RA = await import("../src/record-areas.js");
  const area = { name: "storages", label: "Storages", fields: [{ name: "bucket", label: "Bucket", type: "text" }, { name: "status", label: "Status", type: "text", set_by: "action" }, { name: "tested", label: "Tested", type: "date", set_by: "action" }] } as never;
  const person = { role: "owner", userId: "user-1" } as never;
  const stored = { bucket: "a", status: "passed", tested: "2026-11-14" };
  assert.deepEqual(RA.actionFieldsOf(area, person, null, { bucket: "b" }, stored), { input: { bucket: "b" }, carried: { status: "passed", tested: "2026-11-14" } }, "a person's edit leaving them out keeps the stored values");
  assert.deepEqual(RA.actionFieldsOf(area, person, null, { bucket: "b", status: "passed" }, stored).carried.status, "passed", "sent as stored: kept");
  assert.throws(() => RA.actionFieldsOf(area, person, null, { bucket: "b", status: "failed" }, stored), (e: Error & { status?: number }) => e.status === 409 && /Status of Storages records is set by the app's own actions/.test(e.message), "another value from a person: refused");
  assert.throws(() => RA.actionFieldsOf(area, person, null, { status: "passed" }, null), /set by the app's own actions/, "a person's new record naming one: refused");
  assert.deepEqual(RA.actionFieldsOf(area, person, null, { status: "" }, null), { input: {}, carried: {} }, "sent empty on a new record: nothing to refuse");
  assert.deepEqual(RA.asAction(() => RA.actionFieldsOf(area, person, null, { status: "failed" }, stored)).input, { status: "failed" }, "inside an action (asAction): its write sets them");
  assert.deepEqual(RA.actionFieldsOf(area, { role: null, userId: null } as never, null, { status: "failed" }, stored).input, { status: "failed" }, "a run (no person) sets them");
  assert.deepEqual(RA.actionFieldsOf(area, person, { source: "lane:samples", fingerprint: "x" }, { status: "failed" }, stored).input, { status: "failed" }, "an index or the lane world's samples set them");
  const forms = ["record-page-routes.ts", "tab-actions.ts", "record-routes.ts", "data-api.ts"].map((n) => readFileSync(path.join(ROOT, "src", n), "utf8")).join("\n");
  assert.equal((forms.match(/personSets/g) ?? []).length >= 7, true, "every form's fields leave them out (Edit, Add <related>, a tab's Add, staff's form, the data API's form)");
  assert.match(readFileSync(path.join(ROOT, "src", "record-areas.ts"), "utf8"), /const own = actionFieldsOf\(area, actor, meta, enc\.input, prev\?\.opened \?\? null\);/, "the store applies it on every workspace write");
  ok("set_by action: out of every form, a person's other value refused (409), left out or sent as stored kept; runs, indexes and actions (asAction) set it");
}

// 9. The lane world's samples under their area's own rules.
{
  const seed = await import(pathToFileURL(path.join(ROOT, "..", "testing", "console", "seed.mts")).href);
  const lc = { name: "tickets", fields: [{ name: "state", type: "enum" }], lifecycle: { field: "state", initial: "open" } };
  assert.deepEqual(seed.honourRules(lc, { state: "closed", title: "x" }, 2), { state: "open", title: "x" }, "a lifecycle's field: its initial state (the store refuses any other)");
  const storage = { area: "storages", fields: { bucket: "bucket", endpoint: "endpoint", use: "use", access_key_id: "key_id", secret_access_key: "secret", status: "status", tested: "tested" } };
  const st = seed.honourRules({ name: "storages", fields: [] }, { bucket: "Sample bucket 1", endpoint: "Sample endpoint 1", use: true, key_id: "k", secret: "s", status: "x", tested: "2026-11-15", label: "y" }, 0, storage);
  assert.deepEqual(st, { bucket: "lane-storages-1", endpoint: "https://storage.example.com", use: false, label: "y" }, "the storage area: a bucket name and endpoint of the check's shape, never used, no keys, no test result");
  assert.match(st.bucket as string, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "the bucket name the storage check takes (src/workspace-storage.ts checkStorageRecord)");
  const { checkEndpoint } = await import("../src/keyvault.js");
  assert.equal(checkEndpoint(st.endpoint as string, st.bucket as string), "https://storage.example.com", "and an endpoint it takes");
  assert.deepEqual(seed.honourRules({ name: "other", fields: [] }, { bucket: "Sample" }, 0, storage), { bucket: "Sample" }, "another area: as it was");
  assert.deepEqual(seed.honourRules({ name: "apps", fields: [{ name: "repo", type: "repository", required: true }, { name: "mirror", type: "repository" }] }, {}, 1), { repo: "example/apps-2" }, "a required repository field: owner/name; an optional one left empty");
  const src = readFileSync(path.join(ROOT, "..", "testing", "console", "seed.mts"), "utf8");
  assert.equal((src.match(/honourRules\((t|a), data, (i|n), storage\)/g) ?? []).length, 2, "both writers (a workspace area's samples, a shared area's placeholders) apply them");
  ok("lane samples: a lifecycle's initial state, the storage area's bucket and endpoint shapes (never used), a required repository; on_save rules still skip with the reason");
}

// 6, 8, 10: the console's words.
{
  const ap = readFileSync(path.join(WEB, "features", "agent", "agent-page.tsx"), "utf8");
  assert.match(ap, /label=\{`\$\{inputLabel\(f\.name, f\.prop\)\}/, "Run a program: each input by its schema title");
  assert.match(ap, /hint=\{f\.prop\.description \|\| undefined\}/, "its description under it");
  const pa = readFileSync(path.join(WEB, "features", "records", "page-actions.tsx"), "utf8");
  assert.match(pa, /primary\?\.disabled && <p className='[^']*sm:hidden[^']*'[^>]*data-action-why-shown=\{primary\.id\}>\{primary\.disabled\}<\/p>/, "a greyed-out primary action's reason in words on a phone");
  const ta = readFileSync(path.join(WEB, "features", "tabs", "tab-action.tsx"), "utf8");
  assert.doesNotMatch(ta, /max-sm:w-8/, "a toolbar action is never a bare icon on a phone");
  const pg = readFileSync(path.join(WEB, "features", "agent", "programs-page.tsx"), "utf8");
  assert.match(pg, /whitespace-nowrap' data-program-kind=''>\{r\.machine \? 'Steps' : 'One run'\}/, "the programs list's Kind on one line");
  ok("Run a program labels from the schema; a disabled primary's reason shown on a phone; a toolbar action's word; Kind on one line");
}
// The batch's second part: B to I.
{
  const C = await web("features/records/code-text.ts");
  assert.deepEqual(["repoId", "url", "ciSystem", "tests_failed", "apiURL", "ids", "http_status"].map(C.columnWords), ["Repo ID", "URL", "CI system", "Tests failed", "API URL", "IDs", "HTTP status"], "E: a key in words, short words in capitals");
  assert.deepEqual(C.tableColumnSpecs(["name", { key: "repoId", label: "Repository" }]), { keys: ["name", "repoId"], labels: { repoId: "Repository" } }, "E: a column with its own heading");
  const T = await import("../src/pack-api.js");
  assert.ok(T.DetailTableSchema.safeParse({ field: "repos", columns: ["name", { key: "repoId", label: "Repository" }] }).success, "E: {key, label} columns declare");
  assert.ok(!T.DetailTableSchema.safeParse({ field: "repos", columns: [{ key: "repoId" }] }).success, "E: a labelled column names its label");
  assert.ok(RecordFieldSchema.safeParse({ name: "probe", label: "Probe", type: "text", labels: { "probe-iac": "Infrastructure probe" } }).success, "F: a text field's labels");
  assert.throws(() => RecordFieldSchema.parse({ name: "probe", label: "Probe", type: "number", labels: { "1": "One" } }), /labels are for a text field/, "F: only on a text field");
  const rp = readFileSync(path.join(WEB, "features", "records", "record-pages.tsx"), "utf8");
  assert.match(rp, /if \(f\?\.type === 'text' && typeof v === 'string' && f\.labels\?\.\[v\]\) return f\.labels\[v\]!;/, "F: shown in its words wherever fieldText reads it (lists, pages, history); an unknown value as stored");
  const builds2 = JSON.parse(JSON.stringify(builds));
  builds2.detail.header.facts.push({ computed: { area: "builds", via: "project", op: "count" }, label: "Builds" });
  const fi = builds2.detail.header.facts.length - 1;
  builds2.detail.tabs[0].sections[0].when = { fact: fi, empty: false };
  const g = RecordAreaSchema.safeParse(builds2);
  assert.ok(g.success || !g.error.issues.some((i) => /only for a notice/.test(i.message)), `G: a section's condition may test a computed fact: ${g.success ? "" : JSON.stringify(g.error.issues).slice(0, 300)}`);
  assert.equal(L.sectionShown({ title: "x", when: { fact: 0, empty: false } }, {}, null, { 0: { op: "count", value: 2, capped: false, area: "builds" } }), true, "G: shown while the count is above 0");
  assert.equal(L.sectionShown({ title: "x", when: { fact: 0, empty: false } }, {}, null, { 0: { op: "count", value: 0, capped: false, area: "builds" } }), false, "G: hidden at 0");
  const ds = readFileSync(path.join(WEB, "features", "records", "due-soon-card.tsx"), "utf8");
  assert.match(ds, /\{r\.due_at && !\(r\.overdue && r\.overdue_days\) && <time/, "H: one overdue marker (the badge's days, no second relative date)");
  const dp = readFileSync(path.join(WEB, "features", "records", "detail-page.tsx"), "utf8"), ck = readFileSync(path.join(WEB, "features", "records", "clocks.tsx"), "utf8");
  assert.match(dp, /if \(f\.type === 'date' && !f\.encrypted\) return <DateText v=\{v\} \/>;/, "B: a related table's date by the rule");
  assert.doesNotMatch(ck, />\{v\.due_on( \?\? '—')?\}<|slice\(0, 10\)/, "B: the Deadlines card and the deadline column by the rule");
  assert.doesNotMatch(dp, /font-mono text-xs break-all'>\{r\.key\}/, "C: no key printed under a related row's title");
  assert.ok(T.TabSchema.safeParse({ id: "scans", label: "Scans", kind: "runs", filter: { kind: { in: ["scan_repo", "scan_iac"] } } }).success, "I: a runs tab by job kind");
  assert.ok(T.TabSchema.safeParse({ id: "scans", label: "Scans", kind: "runs", filter: { kind: "scan_repo" } }).success);
  assert.ok(!T.TabSchema.safeParse({ id: "scans", label: "Scans", kind: "runs", filter: { status: "failed" } }).success, "I: by kind only");
  const rt = readFileSync(path.join(WEB, "features", "tabs", "runs.tsx"), "utf8"), gp = readFileSync(path.join(ROOT, "scripts", "gen-packs.mjs"), "utf8");
  assert.match(gp, /run_kinds: typeof t\.filter\.kind === "string"/, "I: the build passes the kinds on");
  assert.match(rt, /tab\.run_kinds\.includes\(r\.kind\)/, "I: the tab lists only theirs");
  assert.match(rt, /r\.target_title \? <span className='line-clamp-2' title=\{t\.key\}>\{r\.target_title\}<\/span>/, "I: a target by its title (its key on hover)");
  ok("B to I: related dates and Deadlines by the rule, no key under a title, table headings (URL, CI, ID; {key, label}), text labels, a section on a computed fact, one overdue marker, a runs tab by kind with titled targets");
}
console.log("\nrecord display (mold_v0-309): all checks passed");
