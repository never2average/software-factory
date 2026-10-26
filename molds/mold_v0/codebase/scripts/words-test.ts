// The shell's vocabulary (mold_v0-100; src/words.ts, src/vocabulary.ts, web/src/lib/vocabulary.ts, scripts/lib/concepts.ts).
//   npm run test:words     offline: no database, no server
//
// 1. The engine: placeholders filled from the layers (profile over packs over the neutral BASE), plurals, capitals,
//    articles that agree ("an audit"), anything else left as written.
// 2. gen-packs: profile.json `words` checked (an unknown key or a bad word is refused), and the console's words for a
//    build are what the server works out for the same packs and profile; the console's engine is the server's.
// 3. The shared copy (Billing, Budget rules, launch refusals, policy checks, the roles' help): with zero packs every
//    message says "run" and none a concept word; under a declarative pack whose pack.json says "run": "audit", audits;
//    under the first product's host pack words ("run": "simulation", with its products) byte for byte the sentences
//    the shell said before mold_v0-100, the contact being the profile's name.
// 4. The concept-word ratchet on planted files: prose counts, identifiers, SQL, placeholders and one-token keys do not;
//    a file over or under its ceiling fails, as does a ceiling on a file that carries none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROFILE } from "../src/profile.js";
import { setPacksForTest, type GeneratedPack } from "../src/packs.js";
import { explain, parsePolicy, refusal, runsAtOnceError, LimitError } from "../src/limits.js";
import { accountRefusal, accountRoleHelp, ACCOUNT_ROLES } from "../src/account-roles.js";
import { roleHelp } from "../src/admin-roles.js";
import { setPackConfigsForTest } from "../src/host.js";
import { fill, vocabulary, word } from "../src/vocabulary.js";
import { BASE_WORDS, fillWith, pluralWord, resolveWords, unknownPlaceholders } from "../src/words.js";
import { checkConcepts, type Concepts } from "./lib/concepts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "words-test-"));
const CONCEPTS = (JSON.parse(readFileSync(path.join(ROOT, "scripts", "vocabulary.json"), "utf8")) as { concepts: Concepts }).concepts;
let passed = 0;
const ok = (what: string) => { passed++; console.log(`✓ ${what}`); };

/** A pack that is its pack.json alone, with these words. */
const pack = (id: string, words: Record<string, string>): GeneratedPack =>
  ({ manifest: { id, name: id, version: "0.1.0", entry: null, migrations: null, words }, declared: null });

try {
  // ---------- 1. the engine ----------
  const w = resolveWords([{ member: "analyst" }, { run: "audit", workspace: "company" }, { run: "review", key: "token" }]);
  assert.deepEqual([w.run, w.runs, w.workspace, w.workspaces, w.member, w.members, w.key, w.account], ["audit", "audits", "company", "companies", "analyst", "analysts", "token", "account"],
    "the profile's layer over the first pack's over the next pack's over BASE");
  assert.deepEqual(resolveWords([]), BASE_WORDS, "no layer: the neutral words");
  assert.equal(resolveWords([{ run: "analysis", runs: "analyses" }]).runs, "analyses", "a layer may name its plural");
  assert.deepEqual(["audit", "batch", "policy", "review", "simulation"].map(pluralWord), ["audits", "batches", "policies", "reviews", "simulations"]);
  assert.equal(fillWith(w, "Acme", "A {run} and a {Run}; Most a {run}; an {member}; {Runs} of {product} by {Members} of {Product}"),
    "An audit and an Audit; Most an audit; an analyst; Audits of Acme by Analysts of Acme", "capitals, plurals, the product and agreeing articles");
  assert.equal(fillWith(BASE_WORDS, "Acme", "A {run}; {tool_calls}; {nope}; ${x}; {"), "A run; tool calls; {nope}; ${x}; {", "unknown placeholders and template text are left alone");
  assert.deepEqual(unknownPlaceholders("{run} {rnu} {Members}"), ["rnu"]);
  ok("the engine: layers, plurals, capitals, the product and articles that agree; anything else untouched");

  // ---------- 2. gen-packs: profile words, and the console's words are the server's ----------
  const gen = (packsDir: string, profile: unknown) => {
    const pf = path.join(TMP, `profile-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(pf, JSON.stringify(profile));
    const out = path.join(packsDir, "..", "out");
    return { r: spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packsDir, "--out", out, "--profile", pf], { cwd: ROOT, encoding: "utf8" }), out };
  };
  const packsDir = path.join(TMP, "build", "packs");
  mkdirSync(path.join(packsDir, "fixture_audit"), { recursive: true });
  writeFileSync(path.join(packsDir, "fixture_audit", "pack.json"), JSON.stringify({ id: "fixture_audit", name: "Fixture audit", version: "0.1.0", words: { run: "audit", workspace: "company" } }));
  for (const [bad, re] of [[{ words: { runner: "x" } }, /words\.runner: not a shell word/], [{ words: { run: "<b>" } }, /words\.run: a word of 1 to 40/], [{ words: ["run"] }, /words: an object/]] as const) {
    const x = gen(packsDir, bad);
    assert.equal(x.r.status, 1, `refused: ${JSON.stringify(bad)}`);
    assert.match(x.r.stderr + x.r.stdout, re);
  }
  const built = gen(packsDir, { name: "Acme", words: { member: "analyst", runs: "audit jobs" } });
  assert.equal(built.r.status, 0, built.r.stderr);
  const webWords = readFileSync(path.join(built.out, "web", "src", "config", "vocabulary.generated.ts"), "utf8");
  const consoleWords = JSON.parse(webWords.slice(webWords.indexOf("{"), webWords.lastIndexOf("}") + 1));
  const profileLayer = readFileSync(path.join(built.out, "src", "vocabulary.generated.ts"), "utf8");
  assert.match(profileLayer, /"member": "analyst"/);
  assert.deepEqual(consoleWords, resolveWords([{ member: "analyst", runs: "audit jobs" }, { run: "audit", workspace: "company" }]), "the console's words: the server's layers resolved");
  assert.deepEqual([consoleWords.run, consoleWords.runs, consoleWords.member, consoleWords.workspace], ["audit", "audit jobs", "analyst", "company"],
    "the app's own plural over the pack's word; the pack's words where the profile names none");
  assert.equal(readFileSync(path.join(ROOT, "web", "src", "lib", "words.generated.ts"), "utf8").split("\n").slice(1).join("\n"), readFileSync(path.join(ROOT, "src", "words.ts"), "utf8"),
    "the console runs the server's engine (a copy gen-packs keeps current)");
  const web = await import("../web/src/lib/vocabulary.js");
  setPacksForTest([]);
  assert.deepEqual(vocabulary(), BASE_WORDS, "zero packs: the server's words are the neutral ones");
  const probe = "A {run}; {Runs}; {members}; {product}";
  assert.equal(web.fill(probe), fill(probe), "and the console says what the server says");
  assert.equal(web.W.Runs, "Runs");
  ok("gen-packs: profile words checked; the console's words and engine are the server's");

  // ---------- 3. the shared copy ----------
  const NOW = new Date(Date.UTC(2026, 9, 15));
  const admins = [{ name: "Ada" }];
  const picture = (o: { cap: number; can_run?: boolean; conc?: number | null }) => ({
    account: { cap_usd: o.cap, spent_usd: o.cap, launchable_usd: o.cap }, buffer_usd: 0, rest: { budget_usd: o.cap, spent: 0 }, teams: [], admins,
    members: [{ user_id: "u1", pot: null, can_run: o.can_run ?? true, own_can_run: null, limit_source: "pool", limit_usd: null, adjust_usd: 0, effective_max_concurrent: o.conc ?? null, cap_usd: null, spent: 0 }],
  }) as any;
  const policy = { mode: "pool", reserve_usd: 0, default_cap_usd: null, new_members_can_run: true, max_concurrent_runs: null, max_sessions_per_run: null, max_run_usd: null } as any;
  const policyError = (p: Record<string, unknown>) => {
    try { parsePolicy(policy, p as any, 100); } catch (e) { assert.ok(e instanceof LimitError); return e.message; }
    throw new Error(`parsePolicy accepted ${JSON.stringify(p)}`);
  };
  const messages = () => {
    const run = { max_sessions: 3, max_run_usd: null };
    return {
      explain_no_allowance: explain(picture({ cap: 0 }), "u1", run, NOW)[0]!,
      explain_not_allowed: explain(picture({ cap: 50, can_run: false }), "u1", run, NOW)[1]!,
      explain_at_once_1: explain(picture({ cap: 50, conc: 1 }), "u1", run, NOW)[2]!,
      explain_at_once_2: explain(picture({ cap: 50, conc: 2 }), "u1", run, NOW)[2]!,
      explain_each_run: explain(picture({ cap: 50 }), "u1", run, NOW)[2]!,
      refusal_no_allowance: refusal(picture({ cap: 0 }), "no_allowance").message,
      refusal_account_cap: refusal(picture({ cap: 40 }), "account_cap").message.replace(/ for \w+ \(/, " for <month> (").replace(/wait until .*$/, "wait until …"),
      refusal_launch_access: refusal(picture({ cap: 40 }), "launch_access").message,
      runs_at_once_1: runsAtOnceError(1, 1, "you", admins).message,
      runs_at_once_2: runsAtOnceError(2, 2, "team", admins).message,
      policy_money: policyError({ max_run_usd: "lots" }),
      policy_min: policyError({ max_run_usd: 0.001 }),
      policy_cap: policyError({ max_run_usd: 500 }),
      viewer_launch: accountRefusal("launch").message,
      viewer_edit: accountRefusal("edit").message,
      ...Object.fromEntries(ACCOUNT_ROLES.map((r) => [`role_${r}`, accountRoleHelp(r)])),
      admin_operator: roleHelp("operator"),
      admin_support: roleHelp("support"),
    } as Record<string, string>;
  };
  // A concept word in a message, the profile's name (the contact) aside: it is the build's own, whatever it is.
  const CONCEPT = new RegExp(`\\b(${CONCEPTS.words.map((x) => x.replace(/ /g, "[ -]")).join("|")})(s|es)?\\b`, "i");
  const concepts = (v: string) => CONCEPT.test(v.replaceAll(PROFILE.name, "<name>"));

  setPacksForTest([]);
  const zero = messages();
  assert.deepEqual(Object.entries(zero).filter(([, v]) => concepts(v)), [], "zero packs: no message names a concept word");
  assert.equal(zero.explain_no_allowance, `Your account has no prepaid allowance this month, so nobody can launch runs. Contact ${PROFILE.name} to add one.`);
  assert.equal(zero.refusal_no_allowance, `Your account has no prepaid allowance this month, so runs can't run. Contact ${PROFILE.name}.`);
  assert.match(zero.refusal_account_cap!, new RegExp(`reply to your ${PROFILE.name} contact`));
  assert.equal(zero.runs_at_once_1!.split(";")[0], "You have 1 run running");
  assert.equal(zero.policy_cap, "A run can't spend more than your $100.00 allowance.");
  assert.equal(zero.viewer_launch, "Viewers can read reports, usage and transcripts but can't run runs. Ask an account owner to change your role on the Team page.",
    "no pack's texts: the shell's own refusal");
  assert.equal(zero.viewer_edit, "Viewers can read but can't make changes. Ask an account owner to change your role on the Team page.");
  assert.equal(zero.admin_support, "Viewer, plus access requests, new accounts and invitations.");
  ok(`zero packs: ${Object.keys(zero).length} messages say "run", none a concept word; the contact is the profile's ${PROFILE.name}`);

  setPacksForTest([pack("fixture_audit", { workspace: "company", run: "audit" })]);
  assert.equal(word("Runs"), "Audits");
  const audit = messages();
  assert.deepEqual(Object.entries(audit).filter(([, v]) => concepts(v)), [], "run = audit: no message names a concept word");
  const pick = (m: Record<string, string>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, m[k]]));
  const KEYS = ["explain_no_allowance", "explain_not_allowed", "explain_at_once_1", "explain_at_once_2", "explain_each_run", "refusal_no_allowance", "refusal_launch_access",
    "runs_at_once_1", "runs_at_once_2", "policy_money", "policy_min", "policy_cap", "viewer_launch", "role_member", "role_viewer", "admin_operator"];
  assert.deepEqual(pick(audit, KEYS), {
    explain_no_allowance: `Your account has no prepaid allowance this month, so nobody can launch audits. Contact ${PROFILE.name} to add one.`,
    explain_not_allowed: "You haven't been allowed to launch audits yet. Reports and transcripts stay available.",
    explain_at_once_1: "You can have 1 audit running at once.",
    explain_at_once_2: "You can have 2 audits running at once.",
    explain_each_run: "Each audit can use up to 3 agent sessions.",
    refusal_no_allowance: `Your account has no prepaid allowance this month, so audits can't run. Contact ${PROFILE.name}.`,
    refusal_launch_access: "You haven't been allowed to launch audits yet. Reports and transcripts stay available. Ask Ada to change Budget rules on the Billing page.",
    runs_at_once_1: "You have 1 audit running; you can have 1 at once (set for you). Wait for one to finish. Ask Ada to change Budget rules on the Billing page.",
    runs_at_once_2: "You have 2 audits running; you can have 2 at once (set for your team). Wait for one to finish. Ask Ada to change Budget rules on the Billing page.",
    policy_money: "Most an audit can spend must be a number of dollars",
    policy_min: "Most an audit can spend must be at least $0.01, or empty for no limit.",
    policy_cap: "An audit can't spend more than your $100.00 allowance.",
    viewer_launch: "Viewers can read reports, usage and transcripts but can't run audits. Ask an account owner to change your role on the Team page.",
    role_member: "Runs audits within Budget rules and keeps their own context and memory.",
    role_viewer: "Reads usage, adoption, reports and context. Can't run audits or change anything.",
    admin_operator: "Support, plus compute, harnesses, agent configuration, the library, account edits and audits.",
  }, "a declarative pack's run word, with its article, in every sentence");
  ok(`run = "audit": ${Object.keys(audit).length} messages say audit / audits / an audit, none a concept word`);

  // The first product's host pack words: the literal sentences of src/limits.ts, src/account-roles.ts and
  // src/admin-roles.ts before mold_v0-100, its name being the host build's profile name.
  // Its pack.json texts (mold_v0-141) write the refusals and the Support role's help in its words, as the shell did.
  setPacksForTest([pack("host_product", { run: "simulation" })]);
  setPackConfigsForTest([{ pack: "host_product", texts: {
    "refusal.viewer_launch": "Viewers can read reports, usage and transcripts but can't run {runs} or onboard products.",
    "refusal.viewer_edit": "Viewers can read but can't change context, products, memory or use cases.",
    "admin_roles.support": "Viewer, plus access requests, new accounts, invitations and journey tips.",
  } }]);
  const NAME = PROFILE.name;
  assert.deepEqual(messages(), {
    explain_no_allowance: `Your account has no prepaid allowance this month, so nobody can launch simulations. Contact ${NAME} to add one.`,
    explain_not_allowed: "You haven't been allowed to launch simulations yet. Reports and transcripts stay available.",
    explain_at_once_1: "You can have 1 simulation running at once.",
    explain_at_once_2: "You can have 2 simulations running at once.",
    explain_each_run: "Each simulation can use up to 3 agent sessions.",
    refusal_no_allowance: `Your account has no prepaid allowance this month, so simulations can't run. Contact ${NAME}.`,
    refusal_account_cap: `Your account has used its $40.00 for <month> ($40.00 spent). Results so far stay available; reply to your ${NAME} contact to raise the allowance, or wait until …`,
    refusal_launch_access: "You haven't been allowed to launch simulations yet. Reports and transcripts stay available. Ask Ada to change Budget rules on the Billing page.",
    runs_at_once_1: "You have 1 simulation running; you can have 1 at once (set for you). Wait for one to finish. Ask Ada to change Budget rules on the Billing page.",
    runs_at_once_2: "You have 2 simulations running; you can have 2 at once (set for your team). Wait for one to finish. Ask Ada to change Budget rules on the Billing page.",
    policy_money: "Most a simulation can spend must be a number of dollars",
    policy_min: "Most a simulation can spend must be at least $0.01, or empty for no limit.",
    policy_cap: "A simulation can't spend more than your $100.00 allowance.",
    viewer_launch: "Viewers can read reports, usage and transcripts but can't run simulations or onboard products. Ask an account owner to change your role on the Team page.",
    viewer_edit: "Viewers can read but can't change context, products, memory or use cases. Ask an account owner to change your role on the Team page.",
    role_viewer: "Reads usage, adoption, reports and context. Can't run simulations or change anything.",
    role_member: "Runs simulations within Budget rules and keeps their own context and memory.",
    role_billing: "A member who also manages billing, the plan and Budget rules. Can't manage the team.",
    role_owner: "Everything, including the team: invite people, remove them and change roles.",
    admin_operator: "Support, plus compute, harnesses, agent configuration, the library, account edits and simulations.",
    admin_support: "Viewer, plus access requests, new accounts, invitations and journey tips.",
  }, "the host pack's words give back the shell's sentences unchanged");
  setPackConfigsForTest([]);
  ok("run = \"simulation\" (the first product's host pack words): every message is the sentence from before, byte for byte");

  // ---------- 4. the concept-word ratchet ----------
  const tree = path.join(TMP, "ratchet");
  const put = (f: string, text: string) => { mkdirSync(path.dirname(path.join(tree, f)), { recursive: true }); writeFileSync(path.join(tree, f), text); };
  put("web/package.json", readFileSync(path.join(ROOT, "web", "package.json"), "utf8"));
  rmSync(path.join(tree, "web", "node_modules"), { force: true });
  spawnSync("ln", ["-s", path.join(ROOT, "web", "node_modules"), path.join(tree, "web", "node_modules")]);
  put("src/a.ts", [
    'export const a = "You can\'t launch simulations yet";',                       // prose: counts
    'export const b = { kind: "simulation", id: "simulation_id" };',               // one-token values and keys: no
    'export const c = "SELECT id FROM simulations WHERE org_id = $1";',            // SQL: no
    'export const d = `run ${x} of simulationId and run_simulation`; const x = 1;', // identifiers: no
    'export const e = "Launch a {run} from `simulations.created_by`";',            // a placeholder and a code span: no
    "export const f = 'Simulations';",                                              // a capitalised label: counts
    "// a simulation in a comment: no",
  ].join("\n"));
  put("web/src/b.tsx", "export const B = () => <p>No scenarios in this period.</p>;\n");
  const c = (ceilings: Record<string, number>): Concepts => ({ ...CONCEPTS, scan: ["src/**/*.ts", "web/src/**/*.tsx"], skip: {}, ceilings: { test: { why: "t", migration: "t", files: ceilings } } });
  const exact = checkConcepts(tree, c({ "src/a.ts": 2, "web/src/b.tsx": 1 }));
  assert.deepEqual(exact.counts, { "src/a.ts": 2, "web/src/b.tsx": 1 }, `prose and labels count, nothing else (${exact.hits.map((h) => `${h.line}:${h.text}`).join(" | ")})`);
  assert.deepEqual(exact.problems, []);
  assert.match(checkConcepts(tree, c({ "src/a.ts": 1, "web/src/b.tsx": 1 })).problems.join("\n"), /src\/a\.ts: 2 concept word\(s\) as prose, ceiling 1/);
  assert.match(checkConcepts(tree, c({ "src/a.ts": 3, "web/src/b.tsx": 1 })).problems.join("\n"), /lower the ceiling .* to 2/);
  assert.match(checkConcepts(tree, c({ "src/a.ts": 2, "web/src/b.tsx": 1, "src/gone.ts": 1 })).problems.join("\n"), /src\/gone\.ts: carries no concept word any more/);
  assert.match(checkConcepts(tree, c({})).problems.join("\n"), /web\/src\/b\.tsx: 1 concept word\(s\) as prose, ceiling 0/);
  ok("the concept ratchet: prose and labels count; identifiers, SQL, placeholders, code spans, keys and comments do not; over, under and stale ceilings fail");
  // mold_v0-113: the staff docs (docs/*.md) are prose outside fenced blocks: a sentence counts, a code span, an
  // identifier, a path and a fenced block do not.
  put("docs/a.md", ["# Limits", "", "New simulations need a subscription.", "The `simulations` table and `run_simulation`; see docs/scenarios.md.", "```", "simulations running: 3", "```", "| Personas | x |"].join("\n"));
  const md = checkConcepts(tree, { ...c({ "src/a.ts": 2, "web/src/b.tsx": 1, "docs/a.md": 2 }), scan: ["src/**/*.ts", "web/src/**/*.tsx", "docs/*.md"] });
  assert.deepEqual([md.counts["docs/a.md"], md.problems], [2, []], `a doc's prose counts, its code spans, paths and fences do not (${md.hits.filter((h) => h.file === "docs/a.md").map((h) => `${h.line}:${h.text}`).join(" | ")})`);
  ok("the concept ratchet reads the staff docs: a sentence and a table label count; code spans, paths and fenced blocks do not");
} finally {
  setPacksForTest(null);
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`words: ${passed} checks passed`);
process.exit(0);
