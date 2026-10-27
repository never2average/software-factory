// The journeys and in-chat tips components (mold_v0-143; src/journeys.ts, src/tips.ts), offline: throwaway build copies
// for what gen-packs writes and refuses, then the server's modules in this process (an embedded database, the offline
// Clerk) with the declarative fixture's config turned on, and off.
//   npm run test:journeys-tips
//
// 1. A pack.json `journeys` and `tips` (scripts/fixtures/packs/fixture_journeys: a pack.json and nothing else) reach the
//    server as PACK_CONFIG and the console as JOURNEYS and TIPS (the built-in ids, what starts work, the placeholders the
//    editor offers, the words), with the pages in the sidebar; a build without them writes those files as the shell's own.
// 2. Refused, naming the pack: two packs turning a component on, console.components naming one, a template whose stage
//    has no tool and is not marked by hand, a word a component does not have, a host pack's page under /app/journeys or
//    /admin/journeys.
// 3. Off (no config): no route (portal, admin, webhook), no tip on any answer, whatever the tables hold.
// 4. On: the built-in pipeline seeded once (a deleted one stays deleted, an untouched one follows the pack), its stage
//    done from a real tool call, a manual stage marked by hand (a tool's stage refused), an account's own use cases
//    (add, import twice, remove), help requests between teammates, the admin's templates (a tool the build lacks refused
//    in the fixture's words) and their adoption; the webhook (its secret), the tip at the end of the next answer in the
//    fixture's words (once a day, always after its always_after tool, at most three times), on /app (dismiss, mute) and
//    on /admin (queue by hand, remove); the Storage page names its tables by the fixture's labels.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup as cleanupWorld, connect, startHttp, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "journeys-tips-"));
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_journeys", "pack.json"), "utf8"));
let n = 0;

/** A throwaway copy of this codebase (its node_modules linked) with these packs and console files; gen-packs run in it. */
function world(packs: Record<string, Record<string, string>>, web: Record<string, string> = {}, profile: Record<string, unknown> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, files] of Object.entries(packs)) for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, "packs", id, f)), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, f), text);
  }
  for (const [f, text] of Object.entries(web)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");
const pack = (json: unknown) => ({ "pack.json": JSON.stringify(json, null, 2) });
const strip = <T extends Record<string, unknown>>(x: T) => { const { $comment: _c, ...rest } = x; return rest; };

try {
  // ---------- 1. what gen-packs writes ----------
  {
    const on = world({ fixture_journeys: pack(FIXTURE) });
    assert.equal(on.status, 0, on.out);
    const config = JSON.parse(/export const PACK_CONFIG: readonly unknown\[\] = ([\s\S]*?);\n/.exec(read(on.dir, "src/hosts.generated.ts"))![1]!);
    assert.deepEqual(config[0].journeys, strip(FIXTURE.journeys), "pack.json journeys reaches the server as PACK_CONFIG, without its $comment");
    assert.deepEqual(config[0].tips, strip(FIXTURE.tips), "pack.json tips too");
    assert.deepEqual(config[0].texts, FIXTURE.texts, "the journeys' nouns reach the server (side both)");
    const facts = read(on.dir, "web/src/config/build-facts.generated.ts");
    const j = JSON.parse(/export const JOURNEYS = ([\s\S]*?);\n/.exec(facts)![1]!), t = JSON.parse(/export const TIPS = ([\s\S]*?);\n/.exec(facts)![1]!);
    assert.deepEqual(j, { pack: "fixture_journeys", built_in: ["first-steps"], launch: { tools: ["remember"], groups: [] }, tokens: ["{client}"],
      words: { export_prefix: "fixture-use-cases", use_case_name_placeholder: "Name, e.g. Pricing page check",
        stage_prompt_placeholder: "The prompt to paste, e.g. Summarise what changed for {product} this week.", stage_expect_placeholder: "You'll see: what comes back" } },
      "JOURNEYS: the built-in ids, what starts work, the placeholders the editor offers, its words over the shell's defaults");
    assert.deepEqual(t, { pack: "fixture_journeys", words: { prompt_placeholder: "Prompt to try (optional)" } }, "TIPS: its words");
    assert.match(read(on.dir, "web/src/config/pack-host-nav.generated.ts"), /"label": "Engagement"[\s\S]*"title": "Pipelines"[\s\S]*"url": "\/app\/journeys"[\s\S]*"url": "\/admin\/journeys"/,
      "the pages in the sidebar (Engagement, named with the pack's word) where no pack places them");
    assert.ok(!/"components"/.test(read(on.dir, "web/src/config/pack-host-nav.generated.ts")), "no console component: they are the shell's own now");
    const off = world({});
    assert.equal(off.status, 0, off.out);
    for (const f of ["src/hosts.generated.ts", "web/src/config/build-facts.generated.ts", "web/src/config/pack-host-nav.generated.ts"])
      assert.equal(read(off.dir, f), read(ROOT, f), `${f}: a build without them writes what the shell's own does`);
    console.log("✓ pack.json journeys and tips reach PACK_CONFIG, JOURNEYS and TIPS and the sidebar; without them the generated files are the shell's own");
  }

  // ---------- 2. refusals ----------
  {
    const refused = (what: string, packs: Record<string, Record<string, string>>, re: RegExp, web: Record<string, string> = {}, profile: Record<string, unknown> = {}) => {
      const w = world(packs, web, profile);
      assert.notEqual(w.status, 0, `${what}: refused`);
      assert.match(w.out, re, `${what}: ${w.out.slice(-600)}`);
    };
    const second = { ...FIXTURE, id: "fixture_second", name: "Second", memory: undefined, texts: undefined };
    refused("two packs turning journeys on", { fixture_journeys: pack(FIXTURE), fixture_second: pack({ ...second, tips: undefined }) }, /journeys: pack fixture_journeys turns the journeys component on too/);
    refused("two packs turning tips on", { fixture_journeys: pack(FIXTURE), fixture_second: pack({ ...second, journeys: undefined }) }, /tips: pack fixture_journeys turns the in-chat tips component on too/);
    const noTool = structuredClone(FIXTURE);
    delete noTool.journeys.templates[0].stages[1].manual;
    refused("a stage with no tool that is not marked by hand", { fixture_journeys: pack(noTool) }, /manual true/);
    refused("a word it does not have", { fixture_journeys: pack({ ...FIXTURE, journeys: { ...FIXTURE.journeys, words: { no_such_word: "x" } } }) }, /journeys\.words/);
    const hosty = (routes: unknown, consoleCfg?: unknown) => ({ hosty: { "pack.json": JSON.stringify({ id: "hosty", name: "Hosty", version: "1", host: { entry: "host.ts" }, ...(consoleCfg ? { console: consoleCfg } : {}) }),
      "host.ts": "import { defineHost } from \"../../src/pack-host.js\";\nexport default defineHost({ id: \"hosty\" });\n" } });
    const hostyWeb = (routes: unknown) => ({ "web/src/packs/hosty/index.ts": "export default { id: 'hosty' };\n", "web/src/packs/hosty/routes.json": JSON.stringify(routes) });
    refused("a host page under /app/journeys", hosty({}), /app: journeys is under the shell's own \/app\/journeys \(the journeys component's page/, hostyWeb({ app: ["journeys"] }), { host_packs: ["hosty"] });
    refused("a host page under /admin/journeys", hosty({}), /admin: journeys is under the shell's own \/admin\/journeys \(the journeys and tips components' page/, hostyWeb({ admin: ["journeys"] }), { host_packs: ["hosty"] });
    refused("console.components naming tips", hosty({}, { components: ["tips"] }), /console\.components|tips/, hostyWeb({}), { host_packs: ["hosty"] });
    console.log("✓ refused: two packs per component, a stage with no tool not marked by hand, an unknown word, a host page under /app/journeys or /admin/journeys, console.components naming tips");
  }

  // ---------- 3 and 4. the server, off then on ----------
  process.env.APP_JOURNEY_SECRET = "journeys-test-secret";
  const { createOrg } = await import("../src/auth.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  const { getDb } = await import("../src/db.js");
  const tips = await import("../src/tips.js");
  const journeys = await import("../src/journeys.js");
  const db = await getDb();
  const { org } = await createOrg(`Journeys ${STAMP}`);

  // Off: zero packs. Rows in the tables change nothing.
  setPackConfigsForTest([]);
  await db.query("INSERT INTO nudges (org_id, journey, step, message, expires_at) VALUES ($1, 'x', 'y', 'Off but present', now() + interval '1 day')", [org.orgId]);
  assert.equal(await tips.nudgeForChat({ ...org, userId: "user_off" }), null, "off: no tip for chat");
  const answer = { content: [{ type: "text" as const, text: "an answer" }], structuredContent: { a: 1 } };
  assert.deepEqual(await tips.withTip({ ...org, userId: "user_off" }, "anything", answer), answer, "off: an answer is left as it was");
  await db.query("DELETE FROM nudges WHERE org_id = $1", [org.orgId]);
  const offHttp = await startHttp();
  const ownerOff = await offHttp.signIn(org, "owner");
  const support0 = await offHttp.adminToken("owner");
  for (const [m, p, h] of [["GET", "/api/app/journeys", ownerOff], ["GET", "/api/app/adoption", ownerOff], ["GET", "/api/app/nudges", ownerOff],
    ["GET", "/api/admin/onboarding/playbooks", support0], ["GET", "/api/admin/onboarding/journeys", support0]] as const)
    assert.equal((await offHttp.req(m, p, { authorization: `Bearer ${h}` })).status, 404, `off: no ${p}`);
  assert.equal((await offHttp.req("POST", "/api/journeys/nudges", { authorization: "Bearer journeys-test-secret" }, { org: org.slug, message: "x" })).status, 404, "off: no webhook");
  await offHttp.close();
  console.log("✓ off: no portal, admin or webhook route, no tip on any answer, whatever the tables hold");

  // On: the fixture's config, as PACK_CONFIG carries it.
  setPackConfigsForTest([{ pack: "fixture_journeys", memory: strip(FIXTURE.memory), journeys: strip(FIXTURE.journeys), tips: strip(FIXTURE.tips), texts: FIXTURE.texts } as never]);
  const http = await startHttp();
  const owner = await http.signIn(org, "owner"), member = await http.signIn(org, "member"), member2 = await http.signIn(org, "member"), viewer = await http.signIn(org, "viewer");
  const sub = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).sub as string;
  const call = async (t: string, method: string, p: string, body?: unknown) => {
    const r = await http.req(method, `/api/app${p}`, { authorization: `Bearer ${t}` }, body);
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) as any };
  };
  const adminCall = async (role: "viewer" | "support" | "operator" | "owner", method: string, p: string, body?: unknown) => {
    const r = await http.req(method, `/api/admin/onboarding${p}`, { authorization: `Bearer ${await http.adminToken(role)}` }, body);
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) as any };
  };

  // Journeys: the built-in pipeline, seeded and promoted, its placeholders as written (no host hook).
  const list1 = (await call(member, "GET", "/journeys")).body.journeys;
  assert.deepEqual(list1.map((x: any) => x.id), ["first-steps"], "the built-in pipeline, seeded once");
  assert.equal(list1[0].stages[0].prompt, "Remember that {client} prefers email.", "no host hook: placeholders as written");
  assert.equal(list1[0].stages[0].done, false);
  // A real tool call completes its stage (the member's AI client).
  const mc = await connect({ ...org, userId: sub(member), role: "member" });
  assert.ok(!(await mc.call("remember", { body: "Contoso prefers email." })).isError);
  const list2 = (await call(member, "GET", "/journeys")).body.journeys;
  assert.equal(list2[0].stages[0].done, true, "the stage is done from the tool call");
  assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM journey_progress WHERE org_id = $1 AND source = 'tool'", [org.orgId]))[0]!.n, 1, "and recorded once");
  // Manual stages by hand; a tool's stage refused in the words of the component.
  const toolStage = await call(member, "POST", "/journeys/first-steps/stages/save", { done: true });
  assert.deepEqual([toolStage.status, toolStage.body.error], [400, "This stage is marked done by your AI client's tool calls, not by hand"]);
  assert.equal((await call(viewer, "POST", "/journeys/first-steps/stages/share", { done: true })).status, 403, "viewers read only");
  assert.equal((await call(member, "POST", "/journeys/first-steps/stages/share", { done: true })).status, 204);
  assert.equal((await call(member, "GET", "/journeys")).body.journeys[0].done, 2, "both stages done");
  assert.equal((await call(member, "POST", "/journeys/nope/stages/x", { done: true })).body.error, "No such pipeline stage", "refusals in the build's word for a journey");
  // The seed ledger: a deleted built-in stays deleted; an untouched one follows the pack.
  await db.query("UPDATE journey_templates SET stages = '[]'::jsonb WHERE id = 'first-steps'");
  journeys.__resetSeed();
  assert.equal((await journeys.listTemplates()).find((x) => x.id === "first-steps")!.stages.length, 2, "an untouched built-in gets its stages back");
  // An account's own use cases: add, import (twice adds nothing), remove.
  assert.equal((await call(member, "POST", "/journeys", { outcome: "x", stages: [{ prompt: "y" }] })).status, 400, "a use case needs a name");
  const uc = (await call(member, "POST", "/journeys", { name: "Weekly check", outcome: "Know what changed", stages: [{ title: "Ask", prompt: "What changed this week?" }] })).body;
  assert.ok(uc.id.startsWith(`${org.slug}-weekly-check`));
  const file = { items: Array.from({ length: 30 }, (_, i) => ({ name: `Imported ${i}`, outcome: "o", stages: [{ title: "t", prompt: `p ${"x".repeat(200)}` }] })) };
  assert.deepEqual((await call(member, "POST", "/journeys/import", file)).body, { imported: 30, skipped: 0, errors: [] }, "an import is not held to the 16 kB body limit");
  assert.equal((await call(member, "POST", "/journeys/import", file)).body.imported, 0, "importing twice adds nothing");
  assert.equal((await call(member2, "DELETE", `/journeys/${uc.id}`)).body.error, "Only whoever added it, or an account admin, can remove it");
  assert.equal((await call(owner, "DELETE", `/journeys/${uc.id}`)).status, 204, "an account admin removes it");
  assert.equal((await call(owner, "DELETE", "/journeys/first-steps")).status, 404, "a template is not removed from /app");
  // Help requests between teammates.
  const hq = (await call(member2, "POST", "/adoption/help", { journey_id: "first-steps", note: "Where do I start?" })).body;
  assert.equal((await call(member2, "POST", "/adoption/help", { journey_id: "first-steps" })).body.id, hq.id, "one live request per person per use case");
  assert.equal((await call(member2, "POST", `/adoption/help/${hq.id}/pick`)).body.error, "That is your own request");
  assert.equal((await call(member, "POST", `/adoption/help/${hq.id}/pick`)).status, 204);
  assert.equal((await call(owner, "POST", `/adoption/help/${hq.id}/pick`)).status, 409, "picked already");
  const ad = (await call(member, "GET", "/adoption")).body;
  const fs = ad.use_cases.find((x: any) => x.id === "first-steps");
  assert.ok(fs.people.some((p: any) => p.user_id === sub(member) && p.finished && p.label === "You"), "adoption person by person: the member finished it");
  assert.equal(ad.help.find((h: any) => h.id === hq.id).status, "picked");
  assert.equal((await call(member, "POST", `/adoption/help/${hq.id}/done`)).status, 204);
  // The admin's templates: listed with the tools a stage may name and their adoption; a tool the build lacks refused.
  const pb = (await adminCall("viewer", "GET", "/playbooks")).body;
  assert.deepEqual(pb.tools, ["remember", "recall"], "the tools a stage may name: the build's own");
  assert.equal(pb.playbooks.find((p: any) => p.id === "first-steps").adoption.started, 1, "adoption across accounts");
  const tpl = { name: "Docs check", outcome: "Know the docs are read", stages: [{ title: "Search", prompt: "Search memory for docs.", tools: ["recall"], expect: "Items." }] };
  const bad = await adminCall("operator", "POST", "/playbooks", { ...tpl, stages: [{ ...tpl.stages[0], tools: ["rm_rf"] }] });
  assert.deepEqual([bad.status, bad.body.error], [400, "Stage 1: rm_rf is not one of Workspace's tools"], "refused in the fixture's words");
  assert.equal((await adminCall("viewer", "POST", "/playbooks", tpl)).status, 403, "writing templates needs library");
  assert.equal((await adminCall("operator", "POST", "/playbooks", tpl)).body.id, "docs-check");
  assert.equal((await adminCall("operator", "POST", "/playbooks", tpl)).status, 409);
  assert.ok(!(await call(member, "GET", "/journeys")).body.journeys.some((x: any) => x.id === "docs-check"), "not promoted until an admin says so");
  assert.equal((await adminCall("operator", "POST", "/playbooks/docs-check/promote", { promoted: true })).status, 204);
  assert.ok((await call(member, "GET", "/journeys")).body.journeys.some((x: any) => x.id === "docs-check"), "promoted: customers see it");
  assert.equal((await adminCall("operator", "DELETE", "/playbooks/docs-check")).status, 403, "deleting needs delete");
  assert.equal((await adminCall("owner", "DELETE", "/playbooks/docs-check")).status, 204);
  console.log("✓ on, journeys: seeded once and following the pack, a stage done from a real tool call, manual stages by hand, own use cases (add, import, remove), help requests, the admin's templates with adoption; refusals in the build's words");

  // Tips: the webhook, then the AI client's next answers.
  const hook = (body: unknown, auth?: string, p = "") => http.req("POST", `/api/journeys/nudges${p}`, auth ? { authorization: auth } : {}, body);
  const wrong = await hook({ org: org.slug, message: "x" }, "Bearer nope");
  assert.deepEqual([wrong.status, (await wrong.json()).error], [401, "Invalid pipeline secret"], "a wrong secret refused, in the build's words");
  const tip = { distinct_id: sub(member), journey: "welcome", step: "save", message: "Save one fact the team should not repeat.", prompt: "Remember that we answer within a day." };
  assert.equal((await hook(tip, "Bearer journeys-test-secret")).status, 201, "queued by the workflow's webhook (Bearer)");
  assert.equal((await hook({ ...tip, step: "via-path" }, undefined, "/journeys-test-secret")).status, 201, "or the secret in the path");
  await db.query("DELETE FROM nudges WHERE step = 'via-path'");
  assert.equal((await hook({ distinct_id: "user_unknown", message: "x" }, "Bearer journeys-test-secret")).status, 404, "an unknown person");
  const a1 = await mc.call("remember", { body: "We answer within a day." });
  assert.match(a1.content[0]!.text, /\n\n---\nA tip for the user from Workspace: Save one fact the team should not repeat\. To try it, they can say: "Remember that we answer within a day\."\. Tips can be turned off at http:\/\/[^ ]+\/app\.$/,
    "the tip at the end of the next answer, in the fixture's words");
  assert.deepEqual(a1.structuredContent.nudge, { message: tip.message, prompt: tip.prompt });
  const a2 = await mc.call("remember", { body: "Twice." });
  assert.ok(!a2.content[0]!.text.includes("---\nA tip"), "at most one a day in chat");
  const a3 = await mc.call("recall", {});
  assert.ok(a3.content[0]!.text.includes("---\nA tip"), "always after the always_after tool");
  await mc.call("recall", {});
  const a5 = await mc.call("recall", {});
  assert.ok(!a5.content[0]!.text.includes("---\nA tip"), "shown in chat at most three times");
  // On /app: listed, dismissed (only by its own person), muted.
  const waiting = (await call(member, "GET", "/nudges")).body;
  assert.equal(waiting.muted, false);
  const t1 = waiting.nudges.find((x: any) => x.step === "save");
  assert.ok(t1, "the tip waits on /app");
  assert.equal((await call(member, "POST", `/nudges/${t1.id}/dismiss`)).status, 204);
  assert.equal((await call(member, "POST", `/nudges/${t1.id}/dismiss`)).body.error, "No such tip");
  assert.equal((await call(member, "POST", "/nudges/mute", { muted: true })).status, 204);
  assert.equal((await call(member, "GET", "/nudges")).body.muted, true);
  // On /admin: the recipes with their webhook bodies, a tip queued by hand (support), removed.
  const view = (await adminCall("viewer", "GET", "/journeys")).body;
  assert.equal(view.configured, true, "the webhook's secret is set");
  assert.equal(JSON.parse(view.recipes[0].steps[0].body).distinct_id, "{event.distinct_id}", "each recipe step with its ready-to-paste body");
  assert.equal((await adminCall("viewer", "POST", "/journeys/nudges", { org_slug: org.slug, message: "x" })).status, 403, "queueing a tip needs journeys");
  const sent = (await adminCall("support", "POST", "/journeys/nudges", { org_slug: org.slug, message: "New: search." })).body;
  assert.deepEqual([sent.journey, sent.step], ["manual", "step"]);
  assert.ok((await call(member2, "GET", "/nudges")).body.nudges.some((x: any) => x.message === "New: search."), "an account-wide tip reaches everyone");
  assert.equal((await adminCall("support", "DELETE", `/journeys/nudges/${sent.id}`)).status, 204);
  assert.equal((await adminCall("support", "DELETE", `/journeys/nudges/${sent.id}`)).body.error, "No such nudge");
  await mc.close();
  // The Storage page names the tables by the fixture's labels (and the rest by their stored names).
  const { storageReport } = await import("../src/spend-usage.js");
  const labels = Object.fromEntries((await storageReport({})).tables.map((x: { name: string; label: string }) => [x.name, x.label]));
  assert.equal(labels.journey_templates, "Pipelines");
  assert.equal(labels.nudges, "Tip queue");
  assert.equal(labels.nudge_prefs, "Nudge prefs");
  await http.close();
  console.log("✓ on, tips: the webhook and its secret, the tip at the end of the next answer in the fixture's words (once a day, always after recall, at most three times), on /app (dismiss, mute) and /admin (recipes, queue by hand, remove); the Storage page's labels");
} finally {
  rmSync(TMP, { recursive: true, force: true });
  cleanupWorld();
}
process.exit(0);
