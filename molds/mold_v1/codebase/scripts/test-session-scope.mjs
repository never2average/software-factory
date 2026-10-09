// A subagent's child session carries no identity; it must resolve the workspace of its ROOT session and never
// fall back to the default workspace when a root scope exists. Pure logic, no database: run with
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-session-scope.mjs
import assert from "node:assert/strict";
import { callerFromCtx } from "../agent/lib/org-context.ts";

const human = { principalId: "a@customer-b.example", principalType: "user", attributes: { email: "A@customer-b.example" } };
// root turn: identity present, lineage absent
assert.equal(callerFromCtx({ session: { id: "root-1", auth: { current: human, initiator: human } } }).email, "a@customer-b.example");
// child session as eve runs it: both auth fields null, parent lineage present
const child = { session: { id: "child-9", parent: { rootSessionId: "root-1", sessionId: "root-1" }, auth: { current: null, initiator: null } } };
assert.equal(callerFromCtx(child).email, undefined, "a child session has no identity of its own");
assert.equal(callerFromCtx(child).org, undefined);
// the lookup key is the framework's root id, never anything from a message
const { inheritedScope } = await import("../agent/lib/session-scope.ts");
assert.equal(await inheritedScope(null), null, "no lineage, nothing inherited");
assert.equal(await inheritedScope({}), null, "lineage without a root id inherits nothing");
assert.equal(await inheritedScope({ rootSessionId: "root-1" }), null, "no database configured: inherits nothing rather than guessing");
console.log("test-session-scope: all assertions passed (no Postgres; the scoped lookup itself is covered by test:org-isolation's database)");
