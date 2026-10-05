#!/usr/bin/env node
/**
 * test:operator-tooling — the operator tooling moved to scripts/operator/ and every old name still works.
 *
 * The tooling had the base product's role word in its folder, its npm script names, its environment variables
 * and a stored memory key. Each moved additively, and each old name is held by something outside this
 * repository (a person's muscle memory and runbooks, the software factory's import of the old lib path, an
 * `.env.local`, a row already in the memories table). So this proves, offline, that:
 *
 *   1. every old npm script is still there and runs the same file as its new `operator:*` name, and that file exists;
 *   2. both old lib paths still resolve and export exactly what the new modules export;
 *   3. the four environment variables are read neutral-first with the old name as a fallback;
 *   4. the member-profile memory key is written neutral and found under either key, and onboard-self uses it.
 *
 * On the commit before this one it fails: scripts/operator/ did not exist.
 *
 * The role word is assembled, never written whole, so this file needs no allowance in the neutral-names list.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const w = ["f", "d", "e"].join("");
const U = w.toUpperCase();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
};

/* 1. npm scripts: every old name is an alias of a new one, running the same file. ---------------------------- */
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
// The eighteen commands the tooling had before the move, by their part after the colon.
const COMMANDS = [
  "onboard-self", "new-customer", "new-org", "backfill-customizations", "backfill-integrations", "configure-platform",
  "configure-solution", "configure-agents", "configure-infra", "validate-solution", "context-graph", "doctor",
  "seed-workflows", "inventory", "sandbox", "thread-open-perf", "chat-persist-perf", "seed-subagent-rows",
];
const oldNames = Object.keys(scripts).filter((k) => k.startsWith(`${w}:`));
const newNames = Object.keys(scripts).filter((k) => k.startsWith("operator:"));
const missing = COMMANDS.filter((c) => !scripts[`${w}:${c}`]);
check(`every old npm script is still there (${COMMANDS.length})`, missing.length === 0, `missing: ${missing.join(", ")}`);
check("and no other", oldNames.length === COMMANDS.length, oldNames.join(", "));
// Commands added after the move have a neutral name only: there is no old name to keep.
const ADDED = ["library-cleanup", "library-apply"];
check("there is one operator:* script per old one, plus the commands added since", newNames.length === oldNames.length + ADDED.length && ADDED.every((c) => scripts[`operator:${c}`] && !scripts[`${w}:${c}`]), `${newNames.length} vs ${oldNames.length} + ${ADDED.length}`);
for (const old of oldNames) {
  const neu = `operator:${old.slice(w.length + 1)}`;
  check(`npm run ${old} runs the same command as npm run ${neu}`, scripts[neu] !== undefined && scripts[neu] === scripts[old], `${scripts[old]}\n     vs ${scripts[neu]}`);
  const file = /\s(scripts\/\S+\.mjs)\b/.exec(scripts[old] ?? "")?.[1];
  check(`  ${old} names a file under scripts/operator/ that exists`, !!file && file.startsWith("scripts/operator/") && existsSync(join(ROOT, file)), String(file));
}
check("no npm script still points into the old folder", !Object.values(scripts).some((v) => v.includes(`scripts/${w}/`)));

/* 2. Import paths: the old lib paths are re-exports of the new modules. -------------------------------------- */
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const pairs = [
  [`scripts/${w}/lib/customer.mjs`, "scripts/operator/lib/customer.mjs"],
  [`scripts/${w}/lib/${w}.mjs`, "scripts/operator/lib/operator.mjs"],
];
for (const [oldPath, newPath] of pairs) {
  let oldMod, newMod, err = "";
  try {
    [oldMod, newMod] = await Promise.all([load(oldPath), load(newPath)]);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check(`${oldPath} and ${newPath} both import`, !!oldMod && !!newMod, err);
  if (!oldMod || !newMod) continue;
  const a = Object.keys(oldMod).sort();
  const b = Object.keys(newMod).sort();
  check(`  ${oldPath} exports exactly what ${newPath} does (${b.length})`, a.join() === b.join() && b.length > 0, `${a.join()} vs ${b.join()}`);
  check(`  ...and the same bindings, not copies`, b.every((k) => oldMod[k] === newMod[k]));
}
const customer = await load(`scripts/${w}/lib/customer.mjs`);
for (const name of ["closeDb", "getDb", "withOrgDb", "workspaceFor", "slugify", "dataroom"]) {
  check(`the factory's import (scripts/${w}/lib/customer.mjs) still offers ${name}`, typeof customer[name] === "function");
}

/* 3. Environment: neutral name first, old name as a fallback that says so once. ---------------------------- */
const op = await load("scripts/operator/lib/operator.mjs");
const legacyOf = { WORKSPACE_ORG: `${U}_ORG`, WORKSPACE_OPS_URL: `${U}_OPS_URL`, WORKSPACE_SELF_EMAIL: `${U}_SELF_EMAIL`, WORKSPACE_GOOGLE_TOKEN: `${U}_GOOGLE_TOKEN` };
check("the env table is exactly the four operator variables", JSON.stringify(op.LEGACY_OPERATOR_ENV) === JSON.stringify(legacyOf), JSON.stringify(op.LEGACY_OPERATOR_ENV));
for (const [neu, old] of Object.entries(legacyOf)) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  check(`${neu} alone is read`, op.operatorEnv(neu, { [neu]: " new " }, warn) === "new" && warnings.length === 0);
  check(`${neu} wins over ${old}`, op.operatorEnv(neu, { [neu]: "new", [old]: "old" }, warn) === "new" && warnings.length === 0);
  check(`${old} alone still answers`, op.operatorEnv(neu, { [old]: "old" }, warn) === "old");
  check(`  ...and says so once, naming both`, warnings.length === 1 && warnings[0].includes(old) && warnings[0].includes(neu), warnings.join(" | "));
  op.operatorEnv(neu, { [old]: "old" }, warn);
  check(`  ...only once per process`, warnings.length === 1);
  check(`  ...and reports which variable answered`, op.operatorEnvSource(neu, { [old]: "old" }, warn).name === old);
  check(`an empty ${neu} falls through to ${old}`, op.operatorEnv(neu, { [neu]: "  ", [old]: "old" }, warn) === "old");
  check(`neither set is "" with no source`, op.operatorEnv(neu, {}, warn) === "" && op.operatorEnvSource(neu, {}, warn).name === null);
}
{
  const saved = { ...process.env };
  try {
    for (const k of [...Object.keys(legacyOf), ...Object.values(legacyOf)]) delete process.env[k];
    process.env[`${U}_SELF_EMAIL`] = "old@onfinance.in";
    const argv = process.argv;
    process.argv = argv.filter((a) => a !== "--email");
    // No stored sign-in (paths that do not exist), so the variables decide, whatever this machine's HOME holds.
    const none = { credentialPaths: [join(tmpdir(), "operator-tooling-none", "a.json"), join(tmpdir(), "operator-tooling-none", "b.json")] };
    const id = op.resolveIdentity(none);
    check("resolveIdentity falls back to the old self-email variable", id.email === "old@onfinance.in" && id.source === `${U}_SELF_EMAIL`, JSON.stringify(id));
    process.env.WORKSPACE_SELF_EMAIL = "new@onfinance.in";
    const id2 = op.resolveIdentity(none);
    check("resolveIdentity prefers WORKSPACE_SELF_EMAIL", id2.email === "new@onfinance.in" && id2.source === "WORKSPACE_SELF_EMAIL", JSON.stringify(id2));
    // The stored sign-in: the login command's folder today first, then the one it had before the rename.
    const home = mkdtempSync(join(tmpdir(), "operator-tooling-home-"));
    try {
      check("the stored sign-in is read from the new folder first, then the old one",
        JSON.stringify(op.CREDENTIAL_PATHS.map((p) => p.split("/").slice(-2, -1)[0])) === JSON.stringify(["workspace-mcp", `${w}-mcp`]), JSON.stringify(op.CREDENTIAL_PATHS));
      const neuPath = join(home, "workspace-mcp", "credentials.json");
      const oldPath = join(home, `${w}-mcp`, "credentials.json");
      mkdirSync(join(home, `${w}-mcp`), { recursive: true });
      writeFileSync(oldPath, JSON.stringify({ email: "signed-in-before@onfinance.in" }));
      const fromOld = op.resolveIdentity({ credentialPaths: [neuPath, oldPath] });
      check("a sign-in kept only in the old folder is still who is running this", fromOld.email === "signed-in-before@onfinance.in" && fromOld.source === "workspace-login", JSON.stringify(fromOld));
      mkdirSync(join(home, "workspace-mcp"), { recursive: true });
      writeFileSync(neuPath, JSON.stringify({ email: "signed-in-now@onfinance.in" }));
      const fromNew = op.resolveIdentity({ credentialPaths: [neuPath, oldPath] });
      check("a sign-in in the new folder wins over the old one", fromNew.email === "signed-in-now@onfinance.in", JSON.stringify(fromNew));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    process.env[`${U}_OPS_URL`] = "https://old.example/";
    check("opsUrl falls back to the old variable", op.opsUrl() === "https://old.example");
    process.env.WORKSPACE_OPS_URL = "https://new.example";
    check("opsUrl prefers WORKSPACE_OPS_URL", op.opsUrl() === "https://new.example");
    process.env[`${U}_ORG`] = "org-old";
    check("workspaceFor falls back to the old org variable", customer.workspaceFor() === "org-old");
    process.env.WORKSPACE_ORG = "org-new";
    check("workspaceFor prefers WORKSPACE_ORG", customer.workspaceFor() === "org-new");
    process.argv = argv;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/* 4. The member-profile memory key: written neutral, read both ways. --------------------------------------- */
const oldPrefix = `${w}-profile:`;
const keys = op.memberProfileKeys(" Priyesh@OnFinance.in ");
check("the written key is neutral and lower-cased", keys.key === "member-profile:priyesh@onfinance.in", keys.key);
check("the old key is still computed for reading", keys.legacyKey === `${oldPrefix}priyesh@onfinance.in`, keys.legacyKey);
const legacyRow = { id: 1, key: keys.legacyKey, version: 3 };
const neutralRow = { id: 2, key: keys.key, version: 1 };
check("a profile stored under the old key is found", op.pickMemberProfile([legacyRow], "priyesh@onfinance.in") === legacyRow);
check("a profile stored under the new key is found", op.pickMemberProfile([neutralRow], "priyesh@onfinance.in") === neutralRow);
check("with both, the new key's row wins, whatever the order", op.pickMemberProfile([legacyRow, neutralRow], "priyesh@onfinance.in") === neutralRow);
check("another person's row is never picked", op.pickMemberProfile([{ id: 3, key: `${oldPrefix}x@onfinance.in` }], "priyesh@onfinance.in") === null);
check("no rows is null", op.pickMemberProfile([], "a@b.c") === null);
check("the email is read back from either key", op.memberProfileEmail(keys.key) === "priyesh@onfinance.in" && op.memberProfileEmail(keys.legacyKey) === "priyesh@onfinance.in");
check("any other key names no member", op.memberProfileEmail("profile:someone") === null);

const onboard = readFileSync(join(ROOT, "scripts/operator/onboard-self.mjs"), "utf8");
check("onboard-self looks the profile up under both keys", /inArray\(memories\.key, \[key, legacyKey\]\)/.test(onboard));
check("onboard-self picks the row with pickMemberProfile", /pickMemberProfile\(found, email\)/.test(onboard));
check("onboard-self writes the neutral key when it updates (an old-key row is moved, not duplicated)", /\.set\(\{ key, value,/.test(onboard));
check("onboard-self inserts under the neutral key", /insert\(memories\)\.values\(\{[\s\S]{0,80}\bkey,/.test(onboard));
check("onboard-self never builds the old key itself", !onboard.includes(`\`${oldPrefix}\${`));

/* 5. Nothing reads the old folder except the two re-exports. ----------------------------------------------- */
const oldDir = join(ROOT, "scripts", w);
check("the old folder keeps the two lib re-exports", existsSync(join(oldDir, "lib", "customer.mjs")) && existsSync(join(oldDir, "lib", `${w}.mjs`)));
check("the operator workflow docs moved, with a pointer at the old path", existsSync(join(ROOT, "docs/OPERATOR_WORKFLOW.md")) && readFileSync(join(ROOT, `docs/${U}_WORKFLOW.md`), "utf8").includes("OPERATOR_WORKFLOW.md"));

console.log(failures ? `\n${failures} failure(s)` : "\nall operator-tooling checks passed");
process.exit(failures ? 1 : 0);
