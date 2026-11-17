// The workspace agent's blank screen and quick commands (mold_v0-316, flag agent_quick_commands), offline and pure:
// `npm run test:agent-quick-commands`.
//   1. Config: pack.json tabs[].agent and agent_defaults (src/pack-api.ts TabAgentSchema, AgentDefaultsSchema; the manifest
//      takes agent_defaults), and their refusals in words: a command that would send, a name twice, a malformed name or
//      placeholder, too many examples, an empty tab agent, a key that is not one.
//   2. What is offered: the tab's examples over the app's over the shell's; commands the tab's first, then the app's (else
//      the shell's), one per name; the "/" filter; what a typed "/" opens.
//   3. Filling a prompt: {tab}, {area}, {record_key}, {record_title}; a blank left and the cursor on it; no tab, no record.
//   4. The active tab: a console page to its tab (and a record's page to its record and its area's tab), the agent
//      page's address both ways, a session's opened_from as the server checks it; the flag in the registry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgentDefaultsSchema, TabAgentSchema, TabSchema } from "../src/pack-api.js";
import { PackJsonSchema } from "../src/pack-manifest.js";
import { openedFromOf } from "../src/agent-composer.js";
import * as Q from "../web/src/features/agent/composer/quick-commands.js";

const ok = (what: string) => console.log(`✓ ${what}`);
const ROOT = path.resolve(import.meta.dirname, "..");
const refused = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } } }, v: unknown, words: RegExp, what: string) => {
  const r = schema.safeParse(v);
  assert.equal(r.success, false, `${what}: refused`);
  const said = r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  assert.match(said, words, `${what}: in words (${said})`);
};

const cmd = (name: string, prompt = `Do ${name} on {tab}.`) => ({ name, label: name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), description: `About ${name}`, prompt });
const ex = (title: string, prompt = `${title} for {tab}.`) => ({ title, prompt });

// ---------- 1. config ----------
{
  const tabAgent = { examples: [ex("Summarise findings"), ex("Open items", "List the open items in {tab} by {what to sort by}.")], commands: [cmd("triage"), { ...cmd("draft"), send: false as const }] };
  assert.deepEqual(TabAgentSchema.parse(tabAgent).commands!.map((c) => c.name), ["triage", "draft"]);
  const tab = TabSchema.parse({ id: "findings", kind: "area", area: "findings", agent: tabAgent });
  assert.equal(tab.agent?.examples?.length, 2, "a tab carries its agent");
  const defaults = { greeting: "What should we look at in {tab}?", intro: "Ask anything, or start from an example.", examples: [ex("Summarise this workspace", "Summarise this workspace.")], commands: [cmd("summarise")] };
  assert.equal(AgentDefaultsSchema.parse(defaults).greeting, defaults.greeting);
  const manifest = PackJsonSchema.safeParse({ id: "acme", version: "1.0.0", name: "Acme", description: "A pack.", agent_defaults: defaults, tabs: [{ id: "findings", kind: "area", area: "findings", agent: tabAgent }] });
  assert.ok(manifest.success || !manifest.error.issues.some((i) => /agent/.test(i.path.join("."))), `the manifest takes agent_defaults and a tab's agent (${manifest.success ? "" : manifest.error.issues.map((i) => i.path.join(".") + ": " + i.message).join(" | ")})`);

  refused(TabAgentSchema, { commands: [{ ...cmd("go"), send: true }] }, /never sends on its own/, "a command that would send");
  refused(TabAgentSchema, { commands: [cmd("same"), cmd("same")] }, /\/same is listed twice/, "a name twice");
  refused(TabAgentSchema, { commands: [cmd("Bad_Name")] }, /lowercase letters, digits and -/, "a malformed name");
  refused(TabAgentSchema, { commands: [cmd("x", "Look at {{tab}}")] }, /single braces/, "double braces");
  refused(TabAgentSchema, { commands: [cmd("x", "Look at {Tab} or { tab")] }, /brace that is not a placeholder/, "a brace that is no placeholder");
  refused(TabAgentSchema, { examples: [ex("A <b>bold</b> one")] }, /no angle brackets/, "markup");
  refused(TabAgentSchema, { examples: Array.from({ length: 7 }, (_, i) => ex(`Example ${i}`)) }, /at most 6 example prompts/, "seven examples");
  refused(TabAgentSchema, { commands: Array.from({ length: 13 }, (_, i) => cmd(`c${i}`)) }, /at most 12 quick commands/, "thirteen commands");
  refused(TabAgentSchema, {}, /names its examples, its commands or both/, "an empty tab agent");
  refused(TabAgentSchema, { greeting: "Hi" }, /greeting|Unrecognized/i, "a greeting is the app's, not a tab's");
  refused(AgentDefaultsSchema, { commands: [{ ...cmd("x"), shortcut: "k" }] }, /shortcut|Unrecognized/i, "a key that is not one");
  refused(AgentDefaultsSchema, { greeting: "x".repeat(81) }, /80|Too big|at most/i, "a long greeting");
  for (const t of ["Compare {first version} and {second version}", "Summarise {record_title} ({record_key}) in {area}", "No placeholder at all"])
    assert.equal(Q.templateProblem(t), null, `the console's check agrees: ${t}`);
  assert.match(Q.templateProblem("Look at {{tab}}")!, /single braces/);
  assert.match(Q.templateProblem("Look at {Tab}")!, /not a placeholder/);
  assert.deepEqual(Q.placeholders("{tab} and {what to find} and {tab}"), ["tab", "what to find"]);
  ok("config: a tab's agent and the app's agent_defaults are taken; a command that sends, a name twice, malformed names and braces, markup, too many, an empty tab agent and unknown keys are refused in words");
}

// ---------- 2. what is offered ----------
{
  const reg: Q.AgentPromptsRegistry = {
    defaults: { greeting: "Ask about {tab}", examples: [ex("App one"), ex("App two"), ex("App three"), ex("App four")], commands: [cmd("summarise", "App summary of {tab}."), cmd("draft"), cmd("export")] },
    tabs: { findings: { examples: [ex("Tab one"), ex("Tab two"), ex("Tab three"), ex("Tab four"), ex("Tab five")], commands: [cmd("triage"), cmd("summarise", "Findings summary of {tab}.")] }, reports: { commands: [cmd("publish")] } },
  };
  const none = { tab: null, record: null };
  assert.deepEqual(Q.examplesFor(reg, { tab: "findings", record: null }).map((e) => e.title), ["Tab one", "Tab two", "Tab three", "Tab four", "Tab five"], "a tab's own examples replace the app's");
  assert.deepEqual(Q.examplesFor(reg, { tab: "reports", record: null }).map((e) => e.title), ["App one", "App two", "App three", "App four"], "a tab without examples: the app's");
  assert.deepEqual(Q.examplesFor(reg, none).map((e) => e.title), ["App one", "App two", "App three", "App four"], "no tab: the app's");
  const empty: Q.AgentPromptsRegistry = { defaults: null, tabs: {} };
  assert.equal(Q.examplesFor(empty, none), Q.GENERIC_EXAMPLES.workspace, "nothing declared, no tab: the shell's workspace examples");
  assert.equal(Q.examplesFor(empty, { tab: "x", record: null }), Q.GENERIC_EXAMPLES.tab, "a tab: the shell's tab examples");
  assert.equal(Q.examplesFor(empty, { tab: "x", record: { area: "findings", key: "F-1" } }), Q.GENERIC_EXAMPLES.record, "a record: the shell's record examples");
  for (const set of Object.values(Q.GENERIC_EXAMPLES)) assert.ok(set.length >= 4 && set.length <= 6 && set.every((e) => TabAgentSchema.safeParse({ examples: [e] }).success), "the shell's examples are 4 to 6 and pass the pack's own check");
  assert.ok(Q.GENERIC_COMMANDS.length >= 3 && TabAgentSchema.safeParse({ commands: Q.GENERIC_COMMANDS }).success, "the shell's commands pass the pack's own check");

  const merged = Q.commandsFor(reg, { tab: "findings", record: null });
  assert.deepEqual(merged.map((c) => `${c.scope}:${c.name}`), ["tab:triage", "tab:summarise", "global:draft", "global:export"], "the tab's first, then the app's, one per name");
  assert.equal(merged.find((c) => c.name === "summarise")!.prompt, "Findings summary of {tab}.", "a name both say: the tab's wins");
  assert.deepEqual(Q.commandsFor(reg, none).map((c) => c.name), ["summarise", "draft", "export"], "the Agents page: the app's global commands only");
  assert.deepEqual(Q.commandsFor(reg, { tab: "unknown", record: null }).map((c) => c.name), ["summarise", "draft", "export"], "a tab with nothing of its own: the app's");
  assert.deepEqual(Q.commandsFor(empty, { tab: "x", record: null }).map((c) => c.name), Q.GENERIC_COMMANDS.map((c) => c.name), "nothing declared: the shell's");
  assert.deepEqual(Q.mergeCommands([cmd("draft")], [cmd("a"), cmd("draft"), cmd("b")]).map((c) => c.name), ["draft", "a", "b"], "deduped by name, first kept");

  assert.deepEqual(Q.filterCommands(merged, "").map((c) => c.name), merged.map((c) => c.name), "an empty filter shows all");
  assert.deepEqual(Q.filterCommands(merged, "dr").map((c) => c.name), ["draft"], "a name's start");
  assert.deepEqual(Q.filterCommands(merged, "about exp").map((c) => c.name), ["export"], "words of the description");
  assert.deepEqual(Q.filterCommands([cmd("summarise"), { ...cmd("triage"), description: "Summarise and sort" }], "summ").map((c) => c.name), ["summarise", "triage"], "a name's start before a word inside");
  assert.equal(Q.slashQuery("/"), "");
  assert.equal(Q.slashQuery("/tri"), "tri");
  assert.equal(Q.slashQuery("/tri age"), null, "a space ends it: the person is writing");
  assert.equal(Q.slashQuery("see /tri"), null, "only as the first character");
  assert.equal(Q.slashQuery("//"), null);
  const g = Q.greetingFor(reg, { tab: "Findings" });
  assert.equal(g.title, "Ask about Findings", "the app's greeting, its {tab} filled");
  assert.equal(Q.greetingFor(empty, {}).title, "How can I help?");
  assert.equal(Q.greetingFor(empty, { tab: "Findings", record_title: "Late filing" }).title, "How can I help with Late filing?");
  ok("offered: the tab's examples over the app's over the shell's (workspace, tab, record); commands the tab's first, the app's next, one per name; the filter and the typed slash; the greeting");
}

// ---------- 3. filling ----------
{
  const ctx = { tab: "Findings", area: "Findings", record_key: "FND-12", record_title: "Late filing" };
  assert.deepEqual(Q.fillPrompt("Summarise {tab}.", ctx), { text: "Summarise Findings.", select: null }, "filled; the cursor at the end");
  assert.deepEqual(Q.fillPrompt("Check {record_title} ({record_key}) in {area}.", ctx), { text: "Check Late filing (FND-12) in Findings.", select: null });
  const blank = Q.fillPrompt("Compare {record_key} with {other finding} on {tab}.", ctx);
  assert.equal(blank.text, "Compare FND-12 with {other finding} on Findings.");
  assert.deepEqual(blank.select, [20, 35], "the cursor selects the first blank left");
  assert.equal(blank.text.slice(...blank.select!), "{other finding}");
  const noRecord = Q.fillPrompt("Summarise {record_title} in {tab}.", {});
  assert.equal(noRecord.text, "Summarise {record_title} in this workspace.", "no tab reads 'this workspace'; no record leaves its placeholder");
  assert.equal(noRecord.text.slice(...noRecord.select!), "{record_title}", "and the cursor goes there");
  assert.equal(Q.fillPrompt("About {record_title}", { record_key: "K-1" }).text, "About K-1", "a record without its title: its key");
  assert.equal(Q.fillPrompt("Look at {tab}", { tab: "A {b} c" }).text, "Look at A b c", "the context's words never bring braces in");
  ok("filling: the page's tab, area and record; a blank left for the person with the cursor on it; no tab, no record");
}

// ---------- 4. the active tab ----------
{
  const tabs: Q.TabRef[] = [
    { id: "home", url: "/app" }, { id: "findings", url: "/app/findings", area: "findings" }, { id: "all-items", url: "/app/all-items", area: "findings", areas: [{ area: "findings" }, { area: "notes" }] },
    { id: "files", url: "/app/files?store=acme" }, { id: "reports", url: "/app/reports" }, { id: "team", url: "/app/settings?tab=team" },
  ];
  const r = (p: string, q = "") => Q.resolveOpenedFrom(p, q, tabs);
  assert.deepEqual(r("/app"), { tab: "home", record: null }, "the home page");
  assert.deepEqual(r("/app/findings"), { tab: "findings", record: null });
  assert.deepEqual(r("/app/findings/"), { tab: "findings", record: null }, "a trailing slash");
  assert.deepEqual(r("/app/findings", "?view=board&q=late"), { tab: "findings", record: null }, "the page's own query keeps its tab");
  assert.deepEqual(r("/app/records/findings/FND-12"), { tab: "findings", record: { area: "findings", key: "FND-12" } }, "a record: its area's own tab before a merged one");
  assert.deepEqual(r("/app/records/notes/N-1"), { tab: "all-items", record: { area: "notes", key: "N-1" } }, "an area only a merged tab lists");
  assert.deepEqual(r("/app/records/other/X-1"), { tab: null, record: { area: "other", key: "X-1" } }, "an area no tab lists: the record alone");
  assert.deepEqual(r("/app/records/findings"), { tab: "findings", record: null }, "an area's list");
  assert.deepEqual(r("/app/files", "?store=acme"), { tab: "files", record: null }, "a tab whose address has a query");
  assert.deepEqual(r("/app/files"), { tab: null, record: null }, "without that query it is not that tab");
  assert.deepEqual(r("/app/settings", "?tab=team"), { tab: "team", record: null }, "a Settings tab");
  assert.deepEqual(r("/app/reports/2026"), { tab: "reports", record: null }, "a page under a tab");
  assert.deepEqual(r("/app/billing"), { tab: null, record: null }, "a page of no tab; /app is never a prefix");
  assert.deepEqual(r("/app/agent", "?new=1&from=findings"), { tab: null, record: null }, "the agent's own pages have none");
  assert.deepEqual(r("/app/records/findings/bad%20key"), { tab: "findings", record: null }, "a malformed key is dropped, never guessed");

  assert.equal(Q.agentHref("/app/agent", { tab: "findings", record: { area: "findings", key: "FND-12" } }), "/app/agent?new=1&from=findings&record=findings%2FFND-12");
  assert.equal(Q.agentHref("/app/agent", { tab: null, record: null }), "/app/agent", "no tab: the Agents page itself");
  const params = (s: string) => new URLSearchParams(s);
  assert.deepEqual(Q.openedFromParams(params("new=1&from=findings&record=findings%2FFND-12")), { tab: "findings", record: { area: "findings", key: "FND-12" } }, "the address read back");
  assert.deepEqual(Q.openedFromParams(params("from=Bad Tab&record=nope")), { tab: null, record: null }, "malformed: dropped");
  assert.deepEqual(Q.openedFromParams(params("")), { tab: null, record: null });

  assert.equal(openedFromOf(undefined), null);
  assert.equal(openedFromOf({}), null, "nothing in it: nothing kept");
  assert.deepEqual(openedFromOf({ tab: "findings", record: { area: "findings", key: "FND-12" } }), { tab: "findings", record: { area: "findings", key: "FND-12" } });
  assert.deepEqual(openedFromOf({ tab: "findings" }), { tab: "findings", record: null });
  for (const [v, words] of [["findings", /an object/], [{ tab: "Findings!" }, /tab's id/], [{ tab: "x", page: "y" }, /page is not one of its fields/],
    [{ record: { area: "findings" } }, /record is \{area, key\}/], [{ record: { area: "findings", key: "a b" } }, /record is/], [{ record: { area: "f", key: "k", title: "t" } }, /record is/]] as const) {
    assert.throws(() => openedFromOf(v), (e: Error & { status?: number }) => words.test(e.message) && /^opened_from: /.test(e.message), `refused: ${JSON.stringify(v)}`);
  }

  const reg = JSON.parse(readFileSync(path.join(ROOT, "src", "features.json"), "utf8")) as { flags: { id: string; default: boolean; requires?: string[]; requested_by: string; quiet_off?: boolean }[] };
  const flag = reg.flags.find((f) => f.id === "agent_quick_commands")!;
  assert.ok(flag && flag.default === true && flag.requested_by === "agent" && flag.requires?.includes("agent_harness") && flag.quiet_off === true, "the flag: on by default wherever the agent is, quiet while off");
  const gen = readFileSync(path.join(ROOT, "web", "src", "config", "agent-prompts.generated.ts"), "utf8");
  assert.match(gen, /export const agentPrompts: AgentPromptsRegistry = /, "the console's registry is generated");
  ok("the active tab: pages, records, merged and query tabs, the agent page's address both ways, a session's opened_from checked in words; the flag registered");
}
console.log("agent quick commands: all passed");
