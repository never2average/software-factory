/**
 * Tests for the deployment profile (profiles/*.json -> lib/deployment-profile.generated.ts) and the per-turn
 * briefing the model reads (agent/lib/deployment-briefing.ts).
 *
 * The property that matters: with only profiles/00-default.json the product reads exactly as it did before
 * profiles existed (same copy, no extra prompt block), and a deployment that changes the profile gets its
 * own words while every IDENTIFIER (`list_customers`, `Customers/`) stays put.
 *
 * Runs offline with plain node + assert — no database, no network. Expects the generated files to be built
 * from the default profile alone (npm run build:deployment-profile).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-deployment-profile.mjs
 */
import assert from "node:assert/strict";

const { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } = await import("../lib/deployment-profile.generated.ts");
const agentSide = await import("../agent/lib/deployment-profile.generated.ts");
const { renderDeploymentBriefing } = await import("../agent/lib/deployment-briefing.ts");

// --- the default profile reproduces today's product -------------------------

assert.equal(PRODUCT_NAME, "Delivered");
assert.equal(fillProfileText("{product}"), "Delivered", "{product} fills with the product name");
assert.equal(fillProfileText(DEPLOYMENT_PROFILE.chat.hero_lines[0]), PRODUCT_NAME, "the hero opens on the product name");
assert.deepEqual(agentSide.DEPLOYMENT_PROFILE, DEPLOYMENT_PROFILE, "web and agent read the same profile");

const cards = DEPLOYMENT_PROFILE.chat.starter_cards;
assert.equal(fillProfileText(cards.tickets_waiting, { count: 3 }), "3 open tickets are waiting on us.");
assert.equal(
  fillProfileText(cards.triage_prompt, { name: "Acme" }),
  "Triage the open tickets for Acme: what is blocking each one, who owns it, and what should we do next?",
);
assert.equal(
  fillProfileText(cards.quiet_prompt, { name: "Acme", days: 21 }),
  "Acme has been quiet for 21 days. Summarise where we left off and draft a check-in to their main contact.",
);
assert.equal(fillProfileText(cards.quiet_badge, { days: 21 }), "21d quiet");
assert.equal(
  fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.pill_active, {
    context: DEPLOYMENT_PROFILE.vocabulary.account_context,
    names: "Acme, Globex",
  }),
  "Customer context: Acme, Globex — click to change",
);
assert.equal(fillProfileText("{unknown} stays"), "{unknown} stays", "an unknown slot is left as written");
assert.deepEqual(DEPLOYMENT_PROFILE.chat.user_messages, { collapse: true, collapsed_lines: 6 }, "long sent messages fold to six lines by default");
for (const d of Object.values(DEPLOYMENT_PROFILE.dataroom.domains)) assert.equal(d.visible, true, "every domain is visible by default");

// --- the briefing: nothing for the default, a reading rule for anything else ---

assert.equal(renderDeploymentBriefing(), null, "the default deployment adds nothing to the prompt");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), null);

const research = structuredClone(DEPLOYMENT_PROFILE);
research.vocabulary.account = { singular: "company", plural: "companies" };
research.vocabulary.member = { singular: "analyst", plural: "analysts" };
research.vocabulary.owner = "lead analyst";
research.dataroom.domains.Tickets.visible = false;
research.dataroom.domains.Customers.label = "Companies";
research.agent.briefing = "This workspace researches housing finance companies.";

const block = renderDeploymentBriefing(research);
assert.ok(block, "a changed profile renders a block");
assert.ok(block.startsWith("## This deployment"));
for (const word of ["company", "companies", "analyst", "analysts", "lead analyst", "Tickets", "Companies", "housing finance"]) {
  assert.ok(block.includes(word), `briefing mentions "${word}"`);
}
// Vocabulary is a reading rule: the identifiers are named so the model maps words, not renames things.
assert.ok(block.includes("`list_customers`"), "tool identifier is kept");
assert.ok(block.includes("`Customers/`"), "data-room path token is kept");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), null, "rendering another profile does not touch the default");

// A briefing alone is enough to render a block.
const briefed = structuredClone(DEPLOYMENT_PROFILE);
briefed.agent.briefing = "Only the briefing.";
assert.equal(renderDeploymentBriefing(briefed), "## This deployment\n\nOnly the briefing.");

console.log("deployment-profile: all assertions passed");
