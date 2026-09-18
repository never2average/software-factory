/**
 * What a workflow step actually RECEIVES.
 *
 * The complaint this guards against is "it opens blank": a step is a brand-new
 * eve session, so anything the composer did not put in the message is simply
 * not there. The subagent case is the one worth testing — a subagent only ever
 * sees what the orchestrator forwards, so the run's identity has to travel
 * inside the task text rather than in a preamble addressed to the orchestrator.
 *
 * Behavioural, not grep-based: it calls the real composer and reads the string.
 *
 * Run:  npm run test:step-context
 */
import assert from "node:assert/strict";

const { composeStepMessage, customerFromArgs } = await import("../lib/workflow-delegate.ts");

const ctx = {
  workflow: "Weekly account report",
  phase: "Gather",
  runId: "wfr_abc12345",
  call: 3,
  customerId: "acme-bank",
};

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
};

/* ---- plain step -------------------------------------------------------- */
const plain = composeStepMessage("Summarise last week's tickets.", undefined, ctx);
check("names the workflow", plain.includes("Weekly account report"));
check("names the phase", plain.includes('phase "Gather"'));
check("names the 1-based step", plain.includes("Step 3"));
check("names the customer", plain.includes("acme-bank"));
check("names the run", plain.includes("wfr_abc12345"));
check("still carries the prompt", plain.includes("Summarise last week's tickets."));
check("says the reader is a program", /consumed by a program/.test(plain));

/* ---- no context: unchanged from a bare prompt --------------------------- */
check(
  "a context-free step is just its prompt",
  composeStepMessage("Do the thing.") === "Do the thing.",
);

/* ---- delegated step: the case that was blank ---------------------------- */
const routed = composeStepMessage("Check the deploy health.", "deployment", ctx);
const task = routed.slice(routed.indexOf("<task>"), routed.indexOf("</task>"));
check("asks for the named subagent", routed.includes("`deployment` subagent"));
check("the task block exists", task.length > 0 && routed.includes("</task>"));
// The whole point: identity is INSIDE the block that gets forwarded verbatim,
// not only in the orchestrator's preamble.
check("customer travels inside the task block", task.includes("acme-bank"));
check("workflow travels inside the task block", task.includes("Weekly account report"));
check("run id travels inside the task block", task.includes("wfr_abc12345"));
check("the prompt is inside the task block", task.includes("Check the deploy health."));
check("forwarding is demanded verbatim", /VERBATIM/.test(routed));

/* ---- customer resolution ------------------------------------------------ */
check("customerId", customerFromArgs({ customerId: "acme" }) === "acme");
check("customer_id", customerFromArgs({ customer_id: "acme" }) === "acme");
check("customer", customerFromArgs({ customer: "acme" }) === "acme");
check("accountId", customerFromArgs({ accountId: "acme" }) === "acme");
check("trims", customerFromArgs({ customerId: "  acme  " }) === "acme");
check("blank is not a customer", customerFromArgs({ customerId: "   " }) === undefined);
check("wrong type is not a customer", customerFromArgs({ customerId: 42 }) === undefined);
check("an unrelated id is NOT guessed at", customerFromArgs({ tenantId: "acme" }) === undefined);
check("no args", customerFromArgs(undefined) === undefined);
check("array args", customerFromArgs(["acme"]) === undefined);
check("string args", customerFromArgs("acme") === undefined);

console.log(`step context: ${passed}/${passed} checks passed`);
