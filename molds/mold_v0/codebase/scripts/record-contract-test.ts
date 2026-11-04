// The record contract (mold_v0-222; src/pack-api.ts RecordContractSchema, contractProblems; the factory's docs/RECORDS.md).
//   npm run test:record-contract
// Declarative only: no runtime code reads it. The build accepts a contract its area's own declaration agrees with and
// refuses, with the path, what the area alone shows to be untrue; the factory's spec check holds the rest (the
// permissions' defaults, the pack's mcp settings, its tabs, its email intake) to the build.
import assert from "node:assert/strict";
import { checkPackJson } from "../src/pack-manifest.js";
import { RecordAreaSchema } from "../src/pack-api.js";

const ALL = ["viewer", "member", "billing", "owner"], W = ["member", "billing", "owner"];
const none = (why: string) => ({ none: why });
const issues = (a: unknown) => { const r = RecordAreaSchema.safeParse(a); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
const ws = (contract: unknown, extra: Record<string, unknown> = {}) => ({
  name: "jobs", label: "Jobs", role: "check", scope: "workspace", fields: [{ name: "note", label: "Note" }], ...extra, contract,
});
const actions = (over: Record<string, unknown> = {}) => ({
  read: ALL, export: ALL, create: W, update: W, delete: W, move: none("no lifecycle"), reveal: none("no encrypted field"),
  import: none("the shell has no workspace import"), ...over,
});

// 1. A contract its area agrees with; none at all (every existing pack).
assert.deepEqual(issues(ws({ provenance: ["people"], actions: actions(), primary_action: "create_record" })), []);
assert.deepEqual(issues(ws(undefined)), []);
assert.deepEqual(issues(ws({ provenance: ["people", "intake"], actions: actions(), primary_action: none("rows arrive by email") })), []);
// A shared area: staff write and import it, people read and export it.
assert.deepEqual(issues({ name: "kinds", label: "Kinds", role: "source", scope: "platform", fields: [{ name: "note", label: "Note" }],
  contract: { provenance: ["staff"], primary_action: none("shared, read only to a workspace"),
    actions: actions({ create: { staff: "library" }, update: { staff: "library" }, delete: { staff: "delete" }, import: { staff: "library" } }) } }), []);
// Every action is said: a missing one is refused.
assert.ok(issues(ws({ provenance: ["people"], actions: { ...actions(), move: undefined }, primary_action: "create_record" })).some((m) => m.startsWith("contract.actions.move")));

// 2. What the area alone shows to be untrue.
const bad = issues(ws({ provenance: ["repository", "people", "people"], primary_action: "create_record",
  actions: actions({ create: ["viewer", "owner"], update: { staff: "library" }, move: W, reveal: W, import: W }) }));
for (const want of [
  "contract.provenance: a provenance is listed twice",
  "contract.provenance: provenance repository needs the area's repository",
  "contract.actions.create: viewer is read-only in the platform",
  "contract.actions.update: {staff} is for a shared area's",
  "contract.actions.move: move is a lifecycle's",
  "contract.actions.reveal: reveal is for encrypted fields",
  "contract.actions.import: the shell has no import for a workspace's own records",
]) assert.ok(bad.some((m) => m.startsWith(want)), `refused: ${want}\n${bad.join("\n")}`);
// Append-only: update, move and delete are none.
const ao = issues(ws({ provenance: ["people"], actions: actions(), primary_action: "create_record" }, { append_only: true }));
assert.ok(ao.some((m) => m.startsWith("contract.actions.update: an append-only area")) && ao.some((m) => m.startsWith("contract.actions.delete: an append-only area")));
// A shared area is never written by a workspace's roles, and its rows come from staff or its repository.
const shared = issues({ name: "kinds", label: "Kinds", role: "source", scope: "platform", fields: [{ name: "note", label: "Note" }],
  contract: { provenance: ["people"], primary_action: "create_record", actions: actions() } });
assert.ok(shared.some((m) => m.startsWith("contract.provenance: a shared (platform) area's rows come from staff or its repository")));
assert.ok(shared.some((m) => m.startsWith("contract.actions.create: a shared (platform) area is written by platform staff only")));
// A repository's area names it.
assert.ok(issues(ws({ provenance: ["people"], actions: actions({ create: none("files"), update: none("files"), delete: none("files") }), primary_action: none("files") },
  { repository: "files" })).some((m) => m.startsWith("contract.provenance: its rows come from repository files")));
// Plain reasons on one line.
assert.ok(issues(ws({ provenance: ["people"], actions: actions({ move: none("a {brace}") }), primary_action: "create_record" })).some((m) => m.startsWith("contract.actions.move")));

// 2b. An area's own lists (mold_v0-237): its Settings tab and its Records page take its `action: false` with a reason.
assert.deepEqual(issues(ws(undefined, { action: false, action_reason: "rows come from the pack's runs" })), []);
assert.ok(issues(ws(undefined, { action: false })).some((m) => m.startsWith("action_reason: action: false says why")));
assert.ok(issues(ws(undefined, { action_reason: "x" })).some((m) => m.startsWith("action_reason: action_reason is for action: false")));
assert.ok(issues(ws(undefined, { action: { kind: "create_record", area: "jobs" } })).some((m) => m.startsWith("action")), "an area's own action is false or absent");
assert.ok(issues(ws({ provenance: ["people"], actions: actions(), primary_action: "create_record" }, { settings: { group: "automation" }, action: false, action_reason: "run-made" }))
  .some((m) => m.startsWith("contract.primary_action: its Settings tab has no primary action")), "a Settings tab with none: the contract says none");
assert.deepEqual(issues(ws({ provenance: ["people"], actions: actions(), primary_action: none("run-made") }, { settings: { group: "automation" }, action: false, action_reason: "run-made" })), []);

// 2c. A url field (mold_v0-238): an address, which may preview its document.
{
  const { isFieldUrl, RecordFieldSchema } = await import("../src/pack-api.js");
  for (const good of ["https://example.com/a.pdf", "http://example.com", "https://sub.example.com:8443/x?y=1#z"]) assert.ok(isFieldUrl(good), good);
  for (const bad of ["example.com", "ftp://example.com/x", "javascript:alert(1)", "https://user:pw@example.com/", "https:///x", " https://example.com", "https://example.com/a b", `https://example.com/${"a".repeat(2048)}`, 42])
    assert.ok(!isFieldUrl(bad), String(bad).slice(0, 40));
  assert.ok(RecordFieldSchema.safeParse({ name: "site", label: "Site", type: "url", preview: "document" }).success);
  assert.ok(RecordFieldSchema.safeParse({ name: "notes", label: "Notes", type: "text", preview: "document" }).success, "a text field holding a URL still previews");
  assert.ok(!RecordFieldSchema.safeParse({ name: "site", label: "Site", type: "url", max_length: 10 }).success, "max_length is a text field's");
  assert.ok(!RecordFieldSchema.safeParse({ name: "site", label: "Site", type: "url", multiple: true }).success, "one address");
}

// 3. In a pack.json, as the build reads it.
const pack = { id: "acme", name: "Acme", version: "1.0.0", record_areas: [ws({ provenance: ["people"], actions: actions(), primary_action: "create_record" })] };
assert.doesNotThrow(() => checkPackJson(pack));
assert.throws(() => checkPackJson({ ...pack, record_areas: [ws({ provenance: ["people"], actions: actions({ import: W }), primary_action: "create_record" })] }), /import/);

console.log("record contract: ok (accepted when the area agrees; each contradiction refused with its path; an area's own lists' action: false with its reason; a url field; in a pack.json)");
