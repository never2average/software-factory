#!/usr/bin/env node
/**
 * WORK PERIODS FOLLOW THE DEPLOYMENT PROFILE (profiles/*.json `work_periods`), everywhere, in each mode.
 *
 * The base product had one idea of a period (a shared one the whole team works in, with a lead, a capacity and a
 * burndown, under its own word) written into the UI, the model's tools, the coding agent's tools, the routes and the
 * activity feed. A deployment whose people each hold their own targets for a week could neither reshape it nor turn
 * it off. Now the profile says which of three things a period is, and what it is called:
 *
 *   1. THE GENERATOR refuses a profile it cannot build (an unknown mode, a word that is not one, mode individual or
 *      auto_rollover without a length), and a profile that renames the period gets its word in the list too.
 *   2. THE RULES (agent/lib/work-periods.ts): who an item belongs to, each person's progress with the signed-in
 *      person first, the reporting chain, the next period's window.
 *   3. DEFAULT PROFILE (this checkout): mode team, and every string the UI shows about a period is, to the letter,
 *      what the base product showed before the words were the profile's (the list below was copied from the
 *      components as they were); the coding agent's tools and the model's three tool definitions are byte for byte
 *      what they were (the recorded surface); the routes answer as before.
 *   4. MODE "off" (a copy of this checkout under scripts/fixtures/work-periods/50-off.json): the period view is not
 *      among the views, the model has no list_cycles / upsert_cycle and upsert_todo has no cycleId, the coding agent
 *      has neither period tool and no task tool takes or names a period, every cycles route answers 404, a task
 *      write that names a period is refused, and NOTHING the model reads mentions a cycle or the default's word for one.
 *   5. MODE "individual" (a copy under 50-individual.json): the views, the words, the tools and their descriptions
 *      are a person's own items within the period; no lead and no capacity anywhere; the goals route exists.
 *   6. The relabelled fixture (scripts/fixtures/agent-vocabulary/50-relabelled.json), which check:agent-vocabulary
 *      and check:ui-vocabulary render, is in mode individual, so those two gates hold that mode's whole surface.
 *
 * No database (scripts/test-work-periods-db.mjs is the half that needs one). Three copies of the checkout are built
 * and rendered, so this takes a minute or two.
 *
 *   npm run test:work-periods
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPeriodWords } from "./lib/period-words.mjs";
import { copyWithProfiles, surfaceSections } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIXTURES = join(ROOT, "scripts/fixtures/work-periods");

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 900)}`}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** What a default deployment read before the words were the profile's: a recorded before-image. */
const BEFORE = JSON.parse(readFileSync(join(FIXTURES, "default-before.json"), "utf8"));
/** The default profile's word for a period, as a word (not inside a library workflow's stored name). */
// (On a tree whose default profile has no work_periods yet, the before-image's words: the checks below then fail by name.)
const DEFAULT_WORDS = (() => { try { return defaultPeriodWords(ROOT); } catch { return [BEFORE.settings.label.plural, BEFORE.settings.label.singular]; } })();
/** Run one part; a part that cannot run at all (a module that does not exist yet) is a failure by name, not a crash. */
const part = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name}: could not run`, false, String(e?.message ?? e).split("\n").slice(0, 3).join(" | "));
  }
};
const defaultWord = new RegExp(`(?<![A-Za-z-])(?:${DEFAULT_WORDS.join("|")})(?![a-z])`, "i");
const defaultWordIn = (text) => (text.match(new RegExp(`.{0,80}${defaultWord.source}.{0,40}`, "i")) ?? [null])[0];
const PERIOD_TOOLS = Object.keys(BEFORE.mcp).filter((n) => !n.startsWith("task_"));

/* ------------------------------------------------------------------------------------------ 1. the generator */
console.log("\n1. The profile generator");
function generate(overlay) {
  const dir = mkdtempSync(join(tmpdir(), "work-periods-profile-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    if (overlay) writeFileSync(join(dir, "50-test.json"), JSON.stringify(overlay));
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print"], { encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir } });
    let profile = null;
    try { profile = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { /* refused */ }
    return { status: r.status, err: r.stderr, wp: profile?.work_periods };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const wpOf = (work_periods) => generate({ work_periods });
await part("the generator", async () => {
  const d = generate(null);
  check("the default profile is mode team, a shared period with no fixed length, rolled over by hand", d.status === 0 && d.wp?.mode === "team" && d.wp.length_days === null && d.wp.auto_rollover === false, d.wp ?? d.err);
  const refused = [
    ["an unknown mode", { mode: "solo" }, /work_periods\.mode: "solo" is not a mode/],
    ["a mode that is not a string", { mode: true }, /work_periods\.mode/],
    ["an empty label", { label: { singular: "", plural: "weeks" } }, /work_periods\.label\.singular must be a non-empty word/],
    ["a label with a placeholder brace in it", { label: { singular: "{week}", plural: "weeks" } }, /work_periods\.label\.singular must be a non-empty word/],
    ["a label padded with spaces", { item_label: { singular: " target", plural: "targets" } }, /work_periods\.item_label\.singular must be a non-empty word/],
    ["a label that is not a pair", { label: "week" }, /work_periods\.label must be an object/],
    ["an unknown key in a label", { label: { singular: "week", plural: "weeks", short: "wk" } }, /work_periods\.label\.short: unknown key/],
    ["an unknown key in the block", { cadence: "weekly" }, /work_periods\.cadence: unknown key/],
    ["a length of zero days", { length_days: 0 }, /work_periods\.length_days must be null/],
    ["a length that is not a whole number", { length_days: 7.5 }, /work_periods\.length_days must be null/],
    ["a length over a year", { length_days: 400 }, /work_periods\.length_days must be null/],
    ["auto_rollover that is not true or false", { auto_rollover: "yes" }, /work_periods\.auto_rollover must be true or false/],
    ["mode individual without a length", { mode: "individual" }, /mode "individual" needs a length in days/],
    ["auto_rollover without a length", { auto_rollover: true }, /auto_rollover needs a length in days/],
    ["auto_rollover under mode off", { mode: "off", auto_rollover: true, length_days: 7 }, /nothing to roll over when mode is "off"/],
  ];
  for (const [what, block, message] of refused) {
    const r = wpOf(block);
    check(`refused: ${what}`, r.status !== 0 && message.test(r.err), r.err.trim().slice(0, 300) || r.wp);
  }
  const individual = generate(JSON.parse(readFileSync(join(FIXTURES, "50-individual.json"), "utf8")));
  check("mode individual with a length builds", individual.status === 0 && individual.wp?.mode === "individual" && individual.wp.length_days === 7 && individual.wp.auto_rollover === true, individual.err);
  check("a profile that renames the period gets its word in the list too (list_label follows label)", same(individual.wp?.list_label, { singular: "week", plural: "weeks" }), individual.wp);
  const both = wpOf({ label: { singular: "iteration", plural: "iterations" }, list_label: { singular: "block", plural: "blocks" } });
  check("…unless it states its own list word", both.status === 0 && same(both.wp?.list_label, { singular: "block", plural: "blocks" }), both.wp ?? both.err);
  const off = generate(JSON.parse(readFileSync(join(FIXTURES, "50-off.json"), "utf8")));
  check('mode "off" builds from one line', off.status === 0 && off.wp?.mode === "off", off.err);
});

/* ------------------------------------------------------------------------------------------------ 2. the rules */
console.log("\n2. The rules (agent/lib/work-periods.ts)");
await part("the rules", async () => {
  const wp = await import("../agent/lib/work-periods.ts");
  const team = wp.workPeriodsOf({ work_periods: { mode: "team", label: { singular: "iteration", plural: "iterations" }, list_label: { singular: "cycle", plural: "cycles" }, item_label: { singular: "target", plural: "targets" }, length_days: null, auto_rollover: false } });
  const ind = wp.workPeriodsOf({ work_periods: { mode: "individual", label: { singular: "week", plural: "weeks" }, list_label: { singular: "week", plural: "weeks" }, item_label: { singular: "target", plural: "targets" }, length_days: 7, auto_rollover: true } });
  const off = wp.workPeriodsOf({ work_periods: { ...{ label: team.label, list_label: team.listLabel, item_label: team.itemLabel, length_days: null }, mode: "off", auto_rollover: true } });
  check("the three modes: exactly one of team / individual holds, and off is not enabled", team.team && !team.individual && team.enabled && ind.individual && !ind.team && ind.enabled && !off.enabled && !off.team && !off.individual);
  check("auto rollover is never on under mode off", off.autoRollover === false && ind.autoRollover === true);
  check("the period placeholders fill from the profile, as written or capitalised", wp.fillPeriodWords("{period} {periods} {Period} {Periods} {period_item} {period_items} {Period_item} {Period_items}", ind) === "week weeks Week Weeks target targets Target Targets");
  check("a template interpolation and an unknown key are left alone", wp.fillPeriodWords("${period} {periodic} {period}", ind) === "${period} {periodic} week");
  check("a period's short code is its word's first two letters", wp.periodSlugPrefix(ind) === "WE" && wp.periodSlugPrefix(team) === "IT");

  const t = (id, assignee, createdBy, done, extra = {}) => ({ id, title: id, done, status: done ? "done" : "open", assignee, createdBy, cycleId: "p1", ...extra });
  const tasks = [
    t("a1", "ana@x.test", "lee@x.test", true),
    t("a2", "ANA@x.test", "lee@x.test", false),
    t("b1", null, "bo@x.test", false),
    t("b2", "bo@x.test", "bo@x.test", false, { status: "cancelled" }),
    t("c1", "cy@x.test", "cy@x.test", true, { cycleId: "p2" }),
    t("d1", "di@x.test", "di@x.test", false, { archivedAt: "2026-01-01" }),
  ];
  const people = wp.progressByPerson("p1", tasks, [{ member: "ana@x.test", goal: "Three names", targetCount: 5 }, { member: "eve@x.test", goal: "Catch up", targetCount: 2 }], "Bo@x.test");
  check("each person's own items: the signed-in person first, then by name; another period's and archived items are not there", same(people.map((p) => p.person), ["bo@x.test", "ana@x.test", "eve@x.test"]), people.map((p) => p.person));
  const [bo, ana, eve] = people;
  check("an item with no assignee is its creator's, and a cancelled one is not planned work", bo.total === 1 && bo.done === 0 && bo.planned === 1 && bo.items.length === 2, bo);
  check("progress is done over the larger of what was planned and what is filed", ana.done === 1 && ana.total === 2 && ana.planned === 5 && ana.progress === 0.2 && ana.goal === "Three names", ana);
  check("a person with a goal and no items yet is listed", eve.total === 0 && eve.planned === 2 && eve.progress === 0 && eve.goal === "Catch up", eve);
  check("the signed-in person is listed first even with nothing yet", wp.progressByPerson("p9", tasks, [], "new@x.test")[0]?.person === "new@x.test");

  const roster = [{ email: "ana@x.test", managerEmail: "Lee@x.test" }, { email: "lee@x.test", managerEmail: "max@x.test" }, { email: "max@x.test", managerEmail: null }, { email: "loop1@x.test", managerEmail: "loop2@x.test" }, { email: "loop2@x.test", managerEmail: "loop1@x.test" }];
  check("the roster models reporting: a person's manager, and that manager's manager, manage them", wp.managesPerson(roster, "lee@x.test", "ana@x.test") && wp.managesPerson(roster, "MAX@x.test", "ana@x.test"));
  check("a peer, a reportee and a stranger do not", !wp.managesPerson(roster, "ana@x.test", "lee@x.test") && !wp.managesPerson(roster, "bo@x.test", "ana@x.test") && !wp.managesPerson(roster, "ana@x.test", "ana@x.test"));
  check("a loop in the roster ends the walk", wp.managesPerson(roster, "max@x.test", "loop1@x.test") === false);
  check("a person may act for themselves and their reportees, nobody else", wp.mayActFor(roster, "Ana@x.test", "ana@x.test") && wp.mayActFor(roster, "lee@x.test", "ana@x.test") && !wp.mayActFor(roster, "ana@x.test", "max@x.test"));

  // The workflow library: a workflow that needs periods is not offered where the profile turns them off.
  const { createVocabulary } = await import("../agent/lib/agent-vocabulary.ts");
  const { DEPLOYMENT_PROFILE } = await import("../agent/lib/deployment-profile.generated.ts");
  const view = await import("../agent/lib/workflow-library-view.ts");
  const { workflowAvailability } = await import("../lib/workflow-availability.ts");
  const vOn = createVocabulary(DEPLOYMENT_PROFILE);
  const vOff = createVocabulary({ ...DEPLOYMENT_PROFILE, work_periods: { ...DEPLOYMENT_PROFILE.work_periods, mode: "off" } });
  const wf = (name, script, description = "d") => ({ name, description, trigger: "manual", steps: [], script });
  const lib = [
    wf("plan-the-period", 'const c = await agent("Call list_cycles, then file each follow-up with upsert_todo (cycleId).");'),
    wf("open-a-period", 'await agent("Open the next one with upsert_cycle.");'),
    wf("worded", 'await agent("Summarise it.");', "Review the {period} with the team."),
    wf("plain", 'await agent("Summarise the lifecycle stage and recycle nothing.");'),
  ];
  check("a library workflow that calls a period tool, files a task into a period or names one is provisioned where periods exist", same(view.deploymentWorkflowLibrary(vOn, lib).map((w) => w.name), lib.map((w) => w.name)));
  check("…and is NOT provisioned where the profile turns them off; one that needs none still is", same(view.deploymentWorkflowLibrary(vOff, lib).map((w) => w.name), ["plain"]), view.deploymentWorkflowLibrary(vOff, lib).map((w) => w.name));
  const left = workflowAvailability(lib[0], vOff, lib);
  check("a workspace that already holds such a row sees it unavailable, refused by every run path, without the feature being named", left.available === false && !/cycle|period/i.test(left.reason) && workflowAvailability(lib[3], vOff, lib).available === true && workflowAvailability(lib[0], vOn, lib).available === true, left);

  const DAY = 86_400_000;
  const now = Date.parse("2026-10-07T12:00:00Z");
  const period = (id, start, days, extra = {}) => ({ id, name: id, startsAt: new Date(start), endsAt: new Date(start + days * DAY), state: "active", ...extra });
  const w1 = period("w1", Date.parse("2026-09-28T00:00:00Z"), 7);
  const w2 = period("w2", Date.parse("2026-10-05T00:00:00Z"), 7);
  const w3 = period("w3", Date.parse("2026-10-12T00:00:00Z"), 7);
  check("the current period is the one whose window contains now", wp.currentPeriod([w1, w2, w3], now)?.id === "w2" && wp.currentPeriod([w1], now) === undefined);
  check("the next period is the earliest that starts when this one ends; closed and archived ones are skipped", wp.nextPeriod([w3, w1, w2], w1)?.id === "w2" && wp.nextPeriod([w1, { ...w2, state: "closed" }, w3], w1)?.id === "w3" && wp.nextPeriod([w1, { ...w2, archivedAt: new Date() }], w1) === undefined);
  const next = wp.followingWindow(w2, 7, ind, now);
  check("a new period follows the one before it, the profile's length long, named by the profile's word and its start", next.startsAt.getTime() === w2.endsAt.getTime() && next.endsAt.getTime() - next.startsAt.getTime() === 7 * DAY && next.name === "Week of 2026-10-12", next);
  const late = wp.followingWindow(w1, 7, ind, Date.parse("2026-10-21T12:00:00Z"));
  check("after a gap it is the window that contains today, still on the same beat", late.startsAt.toISOString() === "2026-10-19T00:00:00.000Z" && late.endsAt.toISOString() === "2026-10-26T00:00:00.000Z", late);
  const first = wp.followingWindow(null, 7, ind, now);
  check("with no period before it, it starts today", first.startsAt.toISOString() === "2026-10-07T00:00:00.000Z", first);
});

/* ----------------------------------------------------------------------------------- probes, one per profile */
const PROBE = ["--conditions=react-server", "scripts/lib/work-period-probe.mjs"];
const SURFACE = ["scripts/lib/model-surface.mjs", "--snapshot", "--no-results"];
function probeHere() {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...PROBE], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`the probe failed in this checkout:\n${(r.stderr || r.stdout).slice(-3000)}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
function inCopy(fixture) {
  const copy = copyWithProfiles(ROOT, [[fixture, join(FIXTURES, fixture)]]);
  try {
    const probe = JSON.parse(copy.run(PROBE).stdout.trim().split("\n").at(-1));
    const surface = copy.run(SURFACE).stdout;
    return { probe, surface, sections: surfaceSections(surface) };
  } finally {
    copy.remove();
  }
}
const status = (probe, route) => probe.routes[route]?.status;
const CYCLE_ROUTES = ["GET /api/ops/cycles", "POST /api/ops/cycles", "PATCH /api/ops/cycles/:id", "DELETE /api/ops/cycles/:id", "POST /api/ops/cycles/:id/rollover", "GET /api/ops/cycles/:id/goals", "PUT /api/ops/cycles/:id/goals"];
/** A cycle named as a word or in an identifier (`cycleId`, `list_cycles`); "lifecycle" and "recycle" are other words. */
const PERIOD_TALK = /(?<![A-Za-z])(?:cycles?|Cycles?)(?![a-z])|(?<=[a-z0-9])Cycles?(?![a-z])/g;

/* --------------------------------------------------------------------------------------- 3. the default profile */
console.log("\n3. Default profile (this checkout): nothing changed");
await part("the default profile", async () => {
  const p = probeHere();
  check("mode team, the base product's two words, no fixed length, no auto rollover", same(p.settings, BEFORE.settings), p.settings);
  const moved = Object.entries(BEFORE.strings).filter(([k, v]) => p.strings[k] !== v).map(([k, v]) => `${k}: "${p.strings[k]}" (was "${v}")`);
  check(`every one of the ${Object.keys(BEFORE.strings).length} strings the UI shows about a period is what it was, to the letter`, moved.length === 0, moved);
  check("the views are the four they were, the period view first, under its old key", same(p.views, BEFORE.views) && p.resolved.period === BEFORE.views[0], p.views);
  check("the placeholders fill to the default profile's words", p.filled === BEFORE.filled, p.filled);

  const mcpMoved = Object.entries(BEFORE.mcp).flatMap(([tool, was]) => Object.entries(was).filter(([k, v]) => !same(p.mcp[tool]?.[k], v)).map(([k]) => `${tool}.${k}: ${JSON.stringify(p.mcp[tool]?.[k])}`));
  check("the coding agent's two period tools and three task tools are offered, described and parameterised as before", mcpMoved.length === 0, mcpMoved);
  check("…and its instructions list them as before", p.instructions.includes(BEFORE.instructions_line));
  check("the task service is told the default profile's word, so its activity feed reads as before", same(p.serviceHeaders, { "x-period-label": BEFORE.activity_label }), p.serviceHeaders);

  check("the cycles routes answer a signed-in caller as before (no database here: an empty list, 503 on a write)", status(p, "GET /api/ops/cycles") === 200 && same(p.routes["GET /api/ops/cycles"].body, { items: [] }) && ["POST /api/ops/cycles", "PATCH /api/ops/cycles/:id", "PATCH /api/ops/cycles/:id lead", "DELETE /api/ops/cycles/:id", "POST /api/ops/cycles/:id/rollover"].every((r) => status(p, r) === 503), p.routes);
  check("the per-person goals route does not exist under mode team", status(p, "GET /api/ops/cycles/:id/goals") === 404 && status(p, "PUT /api/ops/cycles/:id/goals") === 404);
  check("a task write that names a period is forwarded as before (the service is not configured here: 503)", status(p, "POST /api/ops/todos with cycleId") === 503 && status(p, "PATCH /api/ops/todos/:id with cycleId") === 503, p.routes);
  check("a period's activity and comments are read as before", status(p, "GET /api/ops/activity?entity=cycle") === 200 && status(p, "GET /api/ops/comments?entity=cycle") === 200);

  // The model's tools: the three definitions in a fresh render are the recorded surface's, byte for byte.
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ...SURFACE], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const now = surfaceSections(r.stdout);
  const recorded = surfaceSections(readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"));
  for (const tool of ["list_cycles", "upsert_cycle", "upsert_todo"]) {
    const title = `root :: tool :: ${tool}`;
    check(`the model's ${tool} is byte for byte the recorded one`, r.status === 0 && recorded.has(title) && now.get(title) === recorded.get(title), (now.get(title) ?? r.stderr ?? "").slice(0, 300));
  }
  check("…and the whole default surface is the recorded one", r.stdout === readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"));
});

/* -------------------------------------------------------------------------------------------------- 4. mode off */
console.log('\n4. Mode "off" (a copy of this checkout under scripts/fixtures/work-periods/50-off.json)');
await part("mode off", async () => {
  const { probe: p, surface, sections } = inCopy("50-off.json");
  check("the profile is mode off, and nothing is enabled", p.settings.mode === "off" && p.settings.enabled === false && p.settings.autoRollover === false, p.settings);
  check("the period view is not among the views; the other three are untouched", same(p.views, ["tasks", "deployments", "implementations"]), p.views);
  check("a link to the period view opens the task list", p.resolved.period === "tasks" && p.resolved.tasks === "tasks");
  check("the UI is told there is nothing to show", p.strings.enabled === false);

  check("the model is not given list_cycles or upsert_cycle", !sections.has("root :: tool :: list_cycles") && !sections.has("root :: tool :: upsert_cycle") && ![...sections.keys()].some((t) => /tool :: (list|upsert)_cycle/.test(t)), [...sections.keys()].filter((t) => /cycle/.test(t)));
  const todo = sections.get("root :: tool :: upsert_todo") ?? "";
  check("upsert_todo is still there, with no cycleId parameter", todo.includes('"title"') && !todo.includes("cycleId"), todo.slice(0, 200));
  const talk = [];
  for (const [title, body] of sections) for (const m of body.matchAll(PERIOD_TALK)) talk.push(`[${title}] ${body.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\n/g, " ")}`);
  check(`nothing the model reads mentions a cycle (${sections.size} sections: prompts, tools, roster, briefing)`, talk.length === 0, talk.slice(0, 6));
  check("…nor the default profile's word for one", defaultWordIn(surface) === null, defaultWordIn(surface));

  check("the coding agent is offered neither period tool", PERIOD_TOOLS.length === 2 && PERIOD_TOOLS.every((n) => !p.mcpNames.includes(n)) && p.mcpNames.includes("task_create"), p.mcpNames.filter((n) => /task|_list$/.test(n)));
  check("…its task tools take no cycleId and do not name a period", p.mcp.task_create.cycleId === null && p.mcp.task_update.cycleId === null && p.mcp.task_list.description === "The team's TODOs: status, assignee, container and any linked object." && !/cycle/i.test(p.mcp.task_create.description), p.mcp);
  check("…and its instructions do not list them", p.instructions.includes("- **Delivery** — `implementation_upsert`, `deployment_upsert`.") && defaultWordIn(p.instructions) === null);

  const answers = CYCLE_ROUTES.map((r) => [r, status(p, r)]);
  check("every cycles route answers 404 to a signed-in caller", answers.every(([, s]) => s === 404), answers);
  check("a task write that names a period is refused; one that does not is forwarded", status(p, "POST /api/ops/todos with cycleId") === 400 && status(p, "PATCH /api/ops/todos/:id with cycleId") === 400 && status(p, "POST /api/ops/todos without") === 503, p.routes);
  check("a task is answered without its period, and the task service is told no word", same(p.withoutPeriod, { items: [{ id: "t", title: "x" }] }) && same(p.serviceHeaders, {}), [p.withoutPeriod, p.serviceHeaders]);
});

/* ------------------------------------------------------------------------------------------- 5. mode individual */
console.log('\n5. Mode "individual" (a copy under scripts/fixtures/work-periods/50-individual.json)');
await part("mode individual", async () => {
  const { probe: p, surface, sections } = inCopy("50-individual.json");
  check("the profile is mode individual, a week long, rolled over automatically", p.settings.mode === "individual" && p.settings.individual && !p.settings.team && p.settings.lengthDays === 7 && p.settings.autoRollover === true, p.settings);
  check("the period view is offered under its old key, in the profile's word", same(p.views, BEFORE.views) && p.strings.navLabel === "Weeks", [p.views, p.strings.navLabel]);
  const want = {
    navBlurb: "Each person's targets for the week.",
    listLabel: "Week",
    backlogOption: "Backlog (no week)",
    createLabel: "New week",
    emptyNone: "No weeks yet — hit New week.",
    eyebrow: "Week",
    deleteLabel: "Delete week",
    slugPrefix: "WE",
    itemsLabel: "Targets",
    myItemsLabel: "My targets",
    addItemPlaceholder: "Add a target…",
    personGoalLabel: "Goal for the week",
    carryMineLabel: "Carry my unfinished targets to the next week",
    rolloverLabel: "Carry everyone's unfinished targets to the next week",
    progressLabel: ["1/1 target done", "2/5 targets done"],
  };
  const off = Object.entries(want).filter(([k, v]) => !same(p.strings[k], v)).map(([k]) => `${k}: ${JSON.stringify(p.strings[k])}`);
  check("what a person reads is their own items within the period, in the profile's words", off.length === 0, off);
  const base = Object.entries(p.strings).filter(([, v]) => defaultWord.test(JSON.stringify(v)) || /(?<![A-Za-z])cycles?(?![a-z])/i.test(JSON.stringify(v))).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  check("no string the UI shows carries the default profile's words", base.length === 0, base);

  const list = sections.get("root :: tool :: list_cycles") ?? "";
  const upsert = sections.get("root :: tool :: upsert_cycle") ?? "";
  const todo = sections.get("root :: tool :: upsert_todo") ?? "";
  check("the model's list tool lists the periods and ONE person's items, the signed-in person by default", /List the weeks \(cycles\) and one person's targets/.test(list) && list.includes('"person"') && /Omit for the signed-in person/.test(list) && list.includes('"cycleId"'), list.slice(0, 400));
  check("…and says how to add and complete one", /Add one with upsert_todo \(cycleId: "current"\), complete one with upsert_todo \(id, done: true\)/.test(list), list.slice(0, 700));
  check("the model's period tool sets a person's goal and planned count, not a lead or a capacity", upsert.includes('"goal"') && upsert.includes('"planned"') && upsert.includes('"person"') && /no shared lead and no team capacity/.test(upsert) && !/"lead"|"capacity"/.test(upsert), upsert.slice(0, 400));
  check("…only for the signed-in person or someone who reports to them", /only do that for yourself or for a person who reports to you on the roster/.test(upsert) && /only set one for yourself or for a person who reports to you on the roster/.test(todo), todo.slice(-700));
  check('upsert_todo files a todo as a person\'s target, and takes "current" for this week', /Makes this todo a target of a week/.test(todo) && /or \\"current\\" for the week that contains today/.test(todo), todo.slice(-700));
  const placeholders = surface.match(/(?<!\$)\{(period_items?|Period_items?|periods?|Periods?)\}/g) ?? [];
  check("no period placeholder reaches the model unfilled", placeholders.length === 0, placeholders);
  check("nothing the model reads carries the default profile's word for a period", defaultWordIn(surface) === null, defaultWordIn(surface));

  check("the coding agent's period tools read the profile's words and say whose an item is", p.mcp[PERIOD_TOOLS[0]]?.description.startsWith("Weeks (cycles): name, window, and state. Each person holds their own targets in a week") && p.mcp[PERIOD_TOOLS[1]]?.description === "Create a week (cycle) with a name and an ISO start/end window." && p.mcp.task_create.cycleId?.description === `Week id from ${PERIOD_TOOLS[0]}.`, p.mcp);
  check("the per-person goals route exists", status(p, "GET /api/ops/cycles/:id/goals") === 200 && same(p.routes["GET /api/ops/cycles/:id/goals"].body, { items: [] }), p.routes["GET /api/ops/cycles/:id/goals"]);
  check("the cycles routes exist", status(p, "GET /api/ops/cycles") === 200 && status(p, "POST /api/ops/cycles/:id/rollover") === 503);
  check("the task service is told the profile's word", same(p.serviceHeaders, { "x-period-label": "Week" }), p.serviceHeaders);
});

/* ------------------------------------------------------------------------------------- 6. the relabelled fixture */
console.log("\n6. The relabelled fixture the vocabulary gates render");
await part("the relabelled fixture", async () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), "utf8"));
  const block = JSON.parse(readFileSync(join(FIXTURES, "50-individual.json"), "utf8")).work_periods;
  const { $comment: _c, ...mine } = fixture.work_periods ?? {};
  check("scripts/fixtures/agent-vocabulary/50-relabelled.json is in mode individual, the same block as 50-individual.json", same(mine, block), mine);
  const spec = readFileSync(join(ROOT, "scripts/lib/rendered-text.mjs"), "utf8");
  check("the rendered-page pass opens a period and expects each person's own items (scripts/lib/rendered-text.mjs)", spec.includes(`view=${BEFORE.views[0]}`) && /periodExpectations/.test(spec));
});

console.log(`\ntest-work-periods: ${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
