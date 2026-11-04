// The record contract (mold_v0-222; src/pack-api.ts RecordContractSchema, contractProblems; the factory's docs/RECORDS.md).
//   npm run test:record-contract
// The build accepts a contract its area's own declaration agrees with and refuses, with the path, what the area alone
// shows to be untrue; the factory's spec check holds the rest (the permissions' defaults, the pack's mcp settings, its
// tabs, its email intake) to the build. The runtime reads its import, export and reveal (mold_v0-234, mold_v0-235):
// npm run test:record-contract-runtime.
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
  "contract.actions.import: import names member, billing, whom create leaves out",
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

// mold_v0-234: a workspace import, for roles that may create and update; never with an encrypted field or a write none.
assert.deepEqual(issues(ws({ provenance: ["people"], actions: actions({ import: ["member", "owner"] }), primary_action: "create_record" })), [], "a workspace import within create and update");
const imp = issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ update: ["owner"], import: ["member", "owner"] }) }));
assert.ok(imp.some((m) => m.startsWith("contract.actions.import: import names member, whom update leaves out")), imp.join("\n"));
const enc = (extra: Record<string, unknown> = {}) => ({ fields: [{ name: "note", label: "Note" }, { name: "secret", label: "Secret", encrypted: true, ...extra }] });
assert.ok(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ reveal: W, import: W }) }, enc()))
  .some((m) => m.startsWith("contract.actions.import: an area with an encrypted field takes no import")));
assert.ok(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ create: none("x"), import: W }) }))
  .some((m) => m.startsWith("contract.actions.import: import writes new and changed records, and create is none")));
// mold_v0-235: export within read; reveal is the area's, a field's reveal_roles within it.
assert.deepEqual(issues(ws({ provenance: ["people"], actions: actions({ export: ["owner"] }), primary_action: "create_record" })), [], "export narrower than read");
assert.ok(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ read: W, export: ALL }) }))
  .some((m) => m.startsWith("contract.actions.export: export names viewer, whom read leaves out")));
assert.deepEqual(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ reveal: ["member", "owner"] }) }, enc({ reveal_roles: ["owner"] }))), [], "a field narrows the area's reveal");
assert.deepEqual(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ reveal: none("never shown") }) }, enc())), [], "reveal none with an encrypted field: nothing revealed");
assert.ok(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ reveal: ["owner"] }) }, enc({ reveal_roles: ["member", "owner"] })))
  .some((m) => m.startsWith("contract.actions.reveal: field secret's reveal_roles name member, whom the area's reveal leaves out")));
assert.ok(issues(ws({ provenance: ["people"], primary_action: "create_record", actions: actions({ reveal: none("never") }) }, enc({ reveal_roles: ["owner"] })))
  .some((m) => m.startsWith("contract.actions.reveal: field secret declares reveal_roles, but the contract's reveal is none")));

// 3. In a pack.json, as the build reads it.
const pack = { id: "acme", name: "Acme", version: "1.0.0", record_areas: [ws({ provenance: ["people"], actions: actions(), primary_action: "create_record" })] };
assert.doesNotThrow(() => checkPackJson(pack));
assert.throws(() => checkPackJson({ ...pack, record_areas: [ws({ provenance: ["people"], actions: actions({ import: ALL }), primary_action: "create_record" })] }), /import/);
assert.doesNotThrow(() => checkPackJson({ ...pack, record_areas: [ws({ provenance: ["people"], actions: actions({ import: W, export: ["owner"] }), primary_action: "create_record" })] }));

console.log("record contract: ok (accepted when the area agrees; each contradiction refused with its path, the import, export and reveal rules of mold_v0-234/235 included; in a pack.json)");
