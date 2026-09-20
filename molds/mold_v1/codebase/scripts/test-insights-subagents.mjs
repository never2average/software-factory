// Every subagent invoked in a thread stays in the Control Panel's list, even when the model reused a tool-call id.
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-insights-subagents.mjs
import assert from "node:assert/strict";
import { deriveInsights } from "../app/_components/insights.ts";

const call = (toolCallId, name, message, output) => ({ type: "dynamic-tool", toolName: `eve:subagent:${name}`, toolCallId, input: { message }, ...(output ? { state: "output-available", output } : {}) });
const messages = [
  { parts: [call("functions.eve:subagent:lodr-filings:0", "lodr-filings", "Can Fin Homes", "filed 2")] },
  { parts: [call("functions.eve:subagent:hfc-kpi-extraction:1", "hfc-kpi-extraction", "Can Fin KPIs", "27 KPIs")] },
  // after a compaction the model's counter restarted: the SAME ids, different runs
  { parts: [call("functions.eve:subagent:lodr-filings:0", "lodr-filings", "Aavas", "filed 3")] },
  { parts: [call("functions.eve:subagent:lodr-filings:0", "lodr-filings", "Home First")] },
];
const runs = deriveInsights(messages).subagents;
assert.equal(runs.length, 4, "all four delegations are kept");
assert.equal(new Set(runs.map((r) => r.callId)).size, 4, "and each has its own key");
const newest = runs.find((r) => r.callId === "functions.eve:subagent:lodr-filings:0");
assert.deepEqual(newest.activity, ["Home First"], "the NEWEST run keeps the raw id (live events and focus name it)");
assert.equal(newest.status, "running");
assert.deepEqual(runs.filter((r) => r.name === "lodr-filings").map((r) => r.activity[0]).sort(), ["Aavas", "Can Fin Homes", "Home First"]);
assert.equal(runs.filter((r) => r.status === "done").length, 3);
// unique ids are untouched
const clean = deriveInsights([{ parts: [call("call_aaaaaaaaaaaaaaaaaaaaaaaa", "research", "x", "y")] }, { parts: [call("call_bbbbbbbbbbbbbbbbbbbbbbbb", "research", "z", "w")] }]).subagents;
assert.deepEqual(clean.map((r) => r.callId), ["call_aaaaaaaaaaaaaaaaaaaaaaaa", "call_bbbbbbbbbbbbbbbbbbbbbbbb"]);
console.log("test-insights-subagents: all assertions passed");
