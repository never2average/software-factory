// Declared row maps' computed values (mold_v0-123; src/data-repositories.ts, src/pack-api.ts RowMapSchema,
// src/safe-pattern.ts), offline: no database, no server, a workspace's files in memory, a declarative pack with no code.
//   npm run test:row-maps
//
// 1. Bounded patterns: the syntax taken (classes, escapes, groups, alternation, bounded repetition) and every refusal
//    (a repeated group, a lookaround, a backreference, a lazy or stacked repetition, a word boundary or property
//    escape, too long, too many ways to match, an unclosed class or group); text over the limit never matches; the
//    worst pattern taken runs on the worst text in milliseconds.
// 2. Declarations: valid computed fields, where tests, retires and only_latest are taken; refused, each with its
//    reason: a bad pattern, an unknown kind, a list path where only a value path goes, __proto__ in a list path, an
//    empty `any`, an empty where test, retires on a file that is not append_only or on a directory, only_latest on an
//    upstream catalog, either on an API's map.
// 3. Values: a list's first item ([0]), every item ([]), `as` first or list, `only` (text, number, key, list,
//    boolean), `matches`, `max_length`, `any` (always true or false); where with a test; a value that does not fit is
//    no value, never an error.
// 4. Lines: retires ends ANOTHER key's row (a line naming its own key is its new version; a key retired comes back
//    with a later line; a value that is not text is ignored); only_latest keeps the lines of the greatest `by` among
//    `among` (text or numbers, the other kind ignored), no rows when no line matches `among`, the last line of a key
//    winning among them; the same declaration reads as it did before for a map with none of them.
import assert from "node:assert/strict";

const { patternProblem, patternMatches, PATTERN_LIMITS } = await import("../src/safe-pattern.js");
const { compileDeclarations } = await import("../src/pack-manifest.js");
const { setPacksForTest } = await import("../src/packs.js");
const repos = await import("../src/data-repositories.js");

// ---------- 1. bounded patterns ----------
{
  const taken = ["^own:[a-z0-9][a-z0-9-]{1,62}:", "^own:[a-z0-9][a-z0-9-]{1,62}(:|$)", "^[A-Za-z0-9][A-Za-z0-9._:()-]{0,199}$", "^.*$", ".",
    "^(ab)?c$", "^(?:x|y|z)-\\d{4}$", "[\\s\\S]", "^a\\.b\\(c\\)$", "[a\\-z]", "^[^/]+/x$", "^\\w{1,20}@[a-z.]{2,60}$", "[a-z]*a?!", "x{3}", "x{2,}"];
  for (const ok of taken)
    assert.equal(patternProblem(ok), null, `${ok} is a bounded pattern`);
  const refused: [string, RegExp][] = [
    ["(a+)+$", /a group is never repeated/], ["(a|aa)*", /a group is never repeated/], ["^(a?b)?c$", /a group is never repeated/], ["(ab){2}", /a group is never repeated/],
    ["(?=x)", /no lookahead, lookbehind or named group/], ["(?<n>x)", /no lookahead/], ["(?<=x)y", /no lookahead/], ["(?!x)", /no lookahead/],
    ["(x)\\1", /\\1 is not taken/], ["\\k<n>", /\\k is not taken/], ["\\bword", /\\b is not taken/], ["\\p{L}", /\\p is not taken/], ["\\u0041", /\\u is not taken/], ["a\\:b", /\\: is not taken/],
    ["a*?", /no lazy or stacked repetition/], ["a+*", /no lazy or stacked repetition/], ["a{1,3}{2}", /no lazy or stacked repetition/],
    ["a*a*", /multiply past 2000/], ["^[^/]+/[^/]+$", /multiply past 2000/], [".*.*", /multiply past 2000/], ["[a-z]{0,200}[a-z]{0,200}", /multiply past 2000/],
    ["x{1001}", /a repetition is at most 1000/], ["a{3,2}", /n at most m/], ["^*", /an anchor .* is not repeated/], ["*a", /\* repeats nothing/], ["{2}", /\{ repeats nothing/],
    ["[]", /an empty class/], ["[abc", /a class \[ is not closed/], ["[a[b]", /a class holds no \[/], ["(", /a group \( is not closed/], [")", /\) closes no group/], ["a]", /\] stands alone/],
    ["(((((x)))))", /groups nest at most 4 deep/], ["a".repeat(201), /at most 200 characters/], ["", /non-empty text/], ["a\nb", /no control character/], ["[z-a]", /not a pattern: .*Range out of order/i],
  ];
  for (const [p, re] of refused) assert.match(String(patternProblem(p)), re, `${JSON.stringify(p.slice(0, 40))} is refused with ${re}`);
  assert.ok(patternMatches("^a+$", "a".repeat(PATTERN_LIMITS.text)), "text at the limit is tested");
  assert.ok(!patternMatches("^a+$", "a".repeat(PATTERN_LIMITS.text + 1)), "longer text never matches");
  assert.ok(!patternMatches("^1$", 1) && !patternMatches(".", null) && !patternMatches(".", ["a"]), "only text matches");
  // The worst a taken pattern can do: its repetitions' ranges at the ceiling, unanchored (every start), on text that fails.
  const worst = "[a-z]{0,43}[a-z]{0,43}!";
  assert.equal(patternProblem(worst), null);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) assert.ok(!patternMatches(worst, "a".repeat(PATTERN_LIMITS.text)));
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 100, `the worst pattern taken on the worst text: ${ms.toFixed(1)} ms`);
  console.log(`✓ bounded patterns: ${taken.length} taken, ${refused.length} refused with their reasons; text over ${PATTERN_LIMITS.text} characters never matches; the worst taken pattern on the worst text: ${ms.toFixed(2)} ms a test`);
}

// ---------- 2. declarations ----------
const fields = [
  { name: "first_ref", label: "First ref", type: "text" }, { name: "refs", label: "Refs", type: "link" }, { name: "own", label: "Own", type: "boolean" },
  { name: "label", label: "Label", type: "text" }, { name: "note", label: "Note", type: "text" }, { name: "score", label: "Score", type: "number" },
  { name: "tags", label: "Tags", type: "json" }, { name: "done", label: "Done", type: "boolean" }, { name: "owner", label: "Owner", type: "text" },
  { name: "first_item", label: "First item", type: "json" },
];
const T = (value: string, max_length = 10) => ({ value, only: "text", max_length });
const entryMap = {
  key: "{id}",
  where: { "$.kind": "entry", "$.id": { only: "key" } },
  retires: "replaces",
  fields: {
    first_ref: { value: "refs[]", only: "key", as: "first" },
    refs: { value: "refs[]", only: "key" },
    own: { any: [{ value: "refs[]", only: "key", matches: "^own:[a-z0-9][a-z0-9-]{1,62}:" }, { value: "links[].target", matches: "^own:[a-z0-9][a-z0-9-]{1,62}(:|$)" }] },
    label: T("label"), note: T("meta.note", 5), score: { value: "score", only: "number" }, tags: { value: "tags", only: "list" },
    done: { value: "done", only: "boolean" }, owner: "links[0].owner", first_item: "items[0]",
  },
};
const pointFields = [{ name: "series", label: "Series", type: "text" }, { name: "value", label: "Value", type: "number" }, { name: "at", label: "At", type: "text" }];
const pointMap = { key: "{series}", title: "{series}", where: { "$.kind": "point", "$.at": { only: "text" }, "$.series": { only: "text" } },
  only_latest: { by: "at", among: { series: "base" } }, fields: { series: "series", value: { value: "value", only: "number" }, at: "at" } };
const PACK = (edit: (j: any) => void = () => {}) => {
  const j: any = structuredClone({
    id: "fixture_rows", name: "Fixture rows", version: "0.1.0",
    record_areas: [
      { name: "rw_entries", label: "Entries", role: "check", scope: "workspace", repository: "entries", fields },
      { name: "rw_points", label: "Points", role: "check", scope: "workspace", repository: "points", fields: pointFields },
      { name: "rw_plain", label: "Plain", role: "check", scope: "workspace", repository: "plain", fields: [{ name: "label", label: "Label", type: "text" }] },
      { name: "rw_folders", label: "Folders", role: "check", scope: "workspace", repository: "folders", fields: [{ name: "meta", label: "Meta", type: "json" }] },
      { name: "rw_catalog", label: "Catalog", role: "source", scope: "platform", repository: "catalog", fields: [{ name: "label", label: "Label", type: "text" }] },
    ],
    repositories: {
      entries: { kind: "workspace_files", store: "fixture_rows", path: "data/entries.jsonl", format: "jsonl", append_only: true, map: { rw_entries: entryMap } },
      points: { kind: "workspace_files", store: "fixture_rows", path: "data/points.jsonl", format: "jsonl", append_only: true, map: { rw_points: pointMap } },
      plain: { kind: "workspace_files", store: "fixture_rows", path: "data/plain.jsonl", format: "jsonl", append_only: true, map: { rw_plain: { key: "{id}", where: { kind: "entry" }, fields: { label: "label" } } } },
      folders: { kind: "workspace_files", store: "fixture_rows", dir: "folders/{name}", files: { meta: "meta.json" } },
      catalog: { kind: "upstream_catalog", upstream: { repo: "https://example.org/a/b", commit: "0".repeat(40) }, files: { all: "c.json" }, map: { rw_catalog: { from: "all", each: "items", key: "{id}", fields: { label: { value: "name", only: "text" } } } } },
    },
  });
  edit(j);
  return j;
};
const manifest = { id: "fixture_rows", name: "Fixture rows", version: "1", entry: null, migrations: null, words: {} };
const install = (j = PACK()) => setPacksForTest([{ manifest, declared: compileDeclarations(j), definition: null }]);
{
  install();
  const refused: [string, (j: any) => void, RegExp][] = [
    ["a repeated group", (j) => { j.repositories.entries.map.rw_entries.fields.own.any[0].matches = "^(own:)+x"; }, /fields\.own.*a bounded pattern: a group is never repeated/],
    ["a lookahead in where", (j) => { j.repositories.entries.map.rw_entries.where["$.id"] = { matches: "(?=x)" }; }, /where.*a bounded pattern: \(\?\.\.\.\) is not taken/],
    ["a pattern over 200 characters", (j) => { j.repositories.entries.map.rw_entries.fields.label = { value: "label", matches: "a".repeat(201) }; }, /fields\.label/],
    ["an unknown kind of value", (j) => { j.repositories.entries.map.rw_entries.fields.label = { value: "label", only: "date" }; }, /fields\.label/],
    ["a list path as a plain value path", (j) => { j.repositories.entries.map.rw_entries.fields.label = "refs[]"; }, /fields\.label/],
    ["__proto__ in a list path", (j) => { j.repositories.entries.map.rw_entries.fields.label = { value: "refs[].__proto__" }; }, /fields\.label/],
    ["an unknown key of a computed value", (j) => { j.repositories.entries.map.rw_entries.fields.label = { value: "label", eval: "x" }; }, /fields\.label/],
    ["an empty any", (j) => { j.repositories.entries.map.rw_entries.fields.own = { any: [] }; }, /fields\.own/],
    ["max_length past a text field's ceiling", (j) => { j.repositories.entries.map.rw_entries.fields.label = { value: "label", max_length: 20_001 }; }, /fields\.label/],
    ["an empty where test", (j) => { j.repositories.entries.map.rw_entries.where["$.id"] = {}; }, /a test names only or matches/],
    ["a list path in where", (j) => { j.repositories.entries.map.rw_entries.where["refs[]"] = "x"; }, /where\.refs\[\]/],
    ["only_latest with a list path", (j) => { j.repositories.points.map.rw_points.only_latest.by = "at[]"; }, /only_latest\.by/],
    ["retires where the last line does not win", (j) => { j.repositories.entries.append_only = false; }, /its map of rw_entries declares retires, which needs a workspace_files path with append_only: true/],
    ["retires on a directory", (j) => { j.repositories.folders.map = { rw_folders: { key: "{@name}", retires: "x" } }; }, /declares retires, which needs a workspace_files path/],
    ["only_latest on a directory", (j) => { j.repositories.folders.map = { rw_folders: { key: "{@name}", only_latest: { by: "x" } } }; }, /declares only_latest, which reads the lines of a workspace_files path/],
    ["only_latest on an upstream catalog", (j) => { j.repositories.catalog.map.rw_catalog.only_latest = { by: "at" }; }, /declares only_latest, which reads the lines of a workspace_files path/],
  ];
  for (const [what, edit, re] of refused) assert.throws(() => install(PACK(edit)), re, what);
  // An API's map takes computed fields, never the line operators.
  const api = (m: Record<string, unknown>) => PACK((j) => {
    j.record_areas.push({ name: "rw_live", label: "Live", role: "check", scope: "workspace", repository: "live", fields: [{ name: "label", label: "Label", type: "text" }] });
    j.repositories.live = { kind: "http_api", base_url: "https://api.example.org/v1", egress: ["api.example.org"], list: { path: "/items" }, map: { rw_live: { key: "{id}", ...m } } };
  });
  install(api({ fields: { label: { value: "name", only: "text", max_length: 20 } } }));
  assert.throws(() => install(api({ retires: "x" })), /repositories\.live/, "retires on an API's map");
  assert.throws(() => install(api({ only_latest: { by: "x" } })), /repositories\.live/, "only_latest on an API's map");
  install();
  console.log(`✓ declarations: computed fields, where tests, retires and only_latest taken; ${refused.length + 2} broken ones refused, each with its reason`);
}

// ---------- 3 and 4. values and lines ----------
const J = (o: unknown) => JSON.stringify(o);
const e = (id: unknown, extra: Record<string, unknown> = {}) => J({ kind: "entry", id, title: `Entry ${String(id)}`, label: `L ${String(id)}`, ...extra });
const entries = [
  e("e1", { refs: ["bad ref", "own:alpha:1", "shared:2"], links: [{ target: "shared:x", owner: "ann" }], label: "A label longer than ten", meta: { note: "abcdefgh" }, score: 3, tags: ["x"], done: true, items: [{ a: 1 }, 2] }),
  e("e2", { refs: "not a list", links: ["text", { target: "own:beta" }], score: "3", tags: "x", done: "yes", meta: { note: "" }, items: [] }),
  e("e3", { refs: [], links: [{ target: "own:Beta" }, { target: "own:b" }, { target: "own:gamma:9" }], label: "", meta: "not an object" }),
  e("e4", { refs: [42, null, "x:y"], links: { target: "own:delta" }, label: 7 }),
  e("bad id"), e(12), J([JSON.parse(e("in-a-list"))]), J({ kind: "other", id: "o1" }), "",
  e("e5"), e("e6", { replaces: "e5" }), e("e7", { replaces: "e7", label: "new" }), e("e8"), e("e9", { replaces: "e8" }), e("e8", { label: "back" }),
  e("e10", { replaces: 5 }), e("e11", { replaces: "never-there" }), e("e1", { label: "Later", refs: ["own:alpha:1"] }),
].join("\n");
const pt = (series: unknown, value: unknown, at: unknown, extra: Record<string, unknown> = {}) => J({ kind: "point", series, value, at, ...extra });
const files = (ent: string, points: string, plain = "") => [{ path: "data/entries.jsonl", body: ent }, { path: "data/points.jsonl", body: points }, { path: "data/plain.jsonl", body: plain }];
const rows = async (f: { path: string; body: string }[], repo: string, area: string) => (await repos.repositoryRows("fixture_rows", repo, repos.filesSource(f))).get(area)!;
{
  const got = await rows(files(entries, ""), "entries", "rw_entries");
  const by = Object.fromEntries(got.map((r: { key: string; data: unknown }) => [r.key, r.data]));
  assert.deepEqual(Object.keys(by).sort(), ["e1", "e10", "e11", "e2", "e3", "e4", "e6", "e7", "e8", "e9"],
    "where tests keep entry lines with a key ($.kind and $.id read the line itself: a line that is a list is none); e5 retired by e6; e8 retired by e9, then back with a later line; e7 names itself");
  assert.deepEqual(by.e1, { first_ref: "own:alpha:1", refs: ["own:alpha:1"], own: true, label: "Later" }, "the latest line of e1 wins, whole");
  assert.deepEqual(by.e2, { own: true, label: "L e2" }, "refs that is not a list: none; own from a link's target (the item that is text skipped); a number as text, text as a list or a boolean, empty text, a missing first item: none");
  assert.deepEqual(by.e3, { own: true }, "empty refs: no list and no first; own:Beta and own:b do not match, own:gamma:9 does; an empty label: none; meta that is not an object: no note");
  assert.deepEqual(by.e4, { first_ref: "x:y", refs: ["x:y"], own: false }, "only key keeps x:y (42 and null are not keys); links that is not a list: no target; any with nothing found is false; a label that is not text: none");
  assert.equal(got.find((r: { key: string }) => r.key === "e8")!.data.label, "back");
  const f1 = (await rows(files(e("f1", { refs: ["bad ref", "own:alpha:1"], links: [{ target: "shared:x", owner: "ann" }], label: "A label longer than ten", meta: { note: "abcdefgh" }, score: 3, tags: ["x"], done: true, items: [{ a: 1 }, 2] }), ""), "entries", "rw_entries"))[0]!;
  assert.deepEqual(f1.data, { first_ref: "own:alpha:1", refs: ["own:alpha:1"], own: true, label: "A label lo", note: "abcde", score: 3, tags: ["x"], done: true, owner: "ann", first_item: { a: 1 } },
    "as first: the first value that passes; [] gives the list; max_length cuts text; only number, list and boolean keep their kind; links[0].owner and items[0]: a list's first item");
  assert.equal(f1.title, "Entry f1", "no title template: the line's own title");
  console.log("✓ values: [0] and [], as first and list, only (text, number, key, list, boolean), matches, max_length, any (true or false); a value that does not fit is no value");
}
{
  const pts = [
    pt("base", 1, "2026-10-01"), pt("extra", 70, "2026-10-01"), pt("base", 5, "2026-10-20"), pt("extra", 50, "2026-10-20", { note: "first at the latest" }),
    pt("extra", 51, "2026-10-20"), pt("other", 9, "2026-10-21"), pt("base", 9, 20261231), pt("", 9, "2026-12-31"), pt("base", 9, ""), J({ kind: "nope", series: "base", at: "2027-01-01" }),
  ].join("\n");
  const p1 = await rows(files("", pts), "points", "rw_points");
  assert.deepEqual(p1.map((r: { key: string; data: any }) => [r.key, r.data.value, r.data.at]), [["base", 5, "2026-10-20"], ["extra", 51, "2026-10-20"]],
    "only the lines at the greatest `at` among base lines (a number at is not text: ignored; an empty series or at is no line); the last line of a key wins; other's later point is not at that time");
  const p2 = await rows(files("", [pt("extra", 40, "2026-10-21")].join("\n")), "points", "rw_points");
  assert.deepEqual(p2, [], "no line matches among: no rows");
  install(PACK((j) => { j.repositories.points.map.rw_points.only_latest.by = "n"; j.repositories.points.map.rw_points.where = { "$.kind": "point" }; }));
  const p3 = await rows(files("", [J({ kind: "point", series: "base", n: 2 }), J({ kind: "point", series: "base", n: 10 }), J({ kind: "point", series: "x", n: 10 }), J({ kind: "point", series: "y", n: 3 })].join("\n")), "points", "rw_points");
  assert.deepEqual(p3.map((r: { key: string }) => r.key), ["base", "x"], "numbers compared as numbers (10 > 2)");
  install();
  // The same file through a plain map (no operator): read as before mold_v0-123.
  const plain = await rows(files("", "", [J({ kind: "entry", id: "p1", label: "one" }), J({ kind: "entry", id: "p2", label: "two" }), J({ kind: "entry", id: "p1", label: "uno" })].join("\n")), "plain", "rw_plain");
  assert.deepEqual(plain.map((r: { key: string; data: any }) => [r.key, r.data.label]), [["p1", "uno"], ["p2", "two"]], "a plain map: the last line of a key wins, in the order keys first appear");
  console.log("✓ lines: retires ends another key's row (its own key is a new version; a retired key comes back with a later line); only_latest keeps the latest measurement's lines (text or numbers), none when nothing matches among; a plain map reads as before");
}
setPacksForTest(null);
console.log("test:row-maps: ok");
