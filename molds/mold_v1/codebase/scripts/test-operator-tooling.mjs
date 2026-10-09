#!/usr/bin/env node
/**
 * test:operator-tooling — the operator tooling lives in scripts/operator/ under neutral names, and nothing reads the
 * names it had before.
 *
 * The tooling once had the base product's role word in its folder, its npm script names, its environment variables
 * and a stored memory key. Each moved additively, with the old name kept working; that window is closed (the software
 * factory imports scripts/operator/lib/customer.mjs, drizzle/0037 moved the stored memory keys). So this proves,
 * offline, that:
 *
 *   1. every command is an `operator:*` npm script naming a file under scripts/operator/ that exists, and no script
 *      carries the old word;
 *   2. the operator lib modules import, and the old folder is gone;
 *   3. the four environment variables are read by their WORKSPACE_* name only;
 *   4. the member-profile memory key is `member-profile:<email>`, and onboard-self reads and writes only it.
 *
 * The old names are built from the word's one definition (BASE_PRODUCT_WORD), never written whole here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const w = BASE_PRODUCT_WORD;
const U = w.toUpperCase();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
};

/* 1. npm scripts: one operator:* name per command, running a file that exists. ------------------------------- */
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
// The commands the tooling has had since the move, by their part after the colon.
const COMMANDS = [
  "onboard-self", "new-customer", "new-org", "backfill-customizations", "backfill-integrations", "configure-platform",
  "configure-solution", "configure-agents", "configure-infra", "validate-solution", "context-graph", "doctor",
  "seed-workflows", "inventory", "sandbox", "thread-open-perf", "chat-persist-perf", "seed-subagent-rows",
];
for (const c of COMMANDS) {
  const cmd = scripts[`operator:${c}`];
  const file = /\s(scripts\/\S+\.mjs)\b/.exec(cmd ?? "")?.[1];
  check(`npm run operator:${c} names a file under scripts/operator/ that exists`, !!file && file.startsWith("scripts/operator/") && existsSync(join(ROOT, file)), String(cmd));
}
check("no npm script name or command carries the old word", Object.entries(scripts).every(([k, v]) => !k.toLowerCase().includes(w) && !v.toLowerCase().includes(w)));

/* 2. The lib modules, and the old folder gone. --------------------------------------------------------------- */
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const customer = await load("scripts/operator/lib/customer.mjs");
for (const name of ["closeDb", "getDb", "withOrgDb", "workspaceFor", "slugify", "dataroom"]) {
  check(`scripts/operator/lib/customer.mjs (the factory's import) offers ${name}`, typeof customer[name] === "function");
}
check("the old folder is gone", !existsSync(join(ROOT, "scripts", w)));
check("the operator workflow doc is docs/OPERATOR_WORKFLOW.md, and the old path is gone", existsSync(join(ROOT, "docs/OPERATOR_WORKFLOW.md")) && !existsSync(join(ROOT, `docs/${U}_WORKFLOW.md`)));

/* 3. Environment: WORKSPACE_* only. -------------------------------------------------------------------------- */
const op = await load("scripts/operator/lib/operator.mjs");
check("there is no legacy env table any more", !("LEGACY_OPERATOR_ENV" in op));
for (const neu of ["WORKSPACE_ORG", "WORKSPACE_OPS_URL", "WORKSPACE_SELF_EMAIL", "WORKSPACE_GOOGLE_TOKEN"]) {
  const old = neu.replace(/^WORKSPACE_/, `${U}_`);
  check(`${neu} is read, trimmed, and names itself as the source`, op.operatorEnv(neu, { [neu]: " v " }) === "v" && op.operatorEnvSource(neu, { [neu]: "v" }).name === neu);
  check(`  ${old} is not read`, op.operatorEnv(neu, { [old]: "old" }) === "" && op.operatorEnvSource(neu, { [old]: "old" }).name === null);
}
{
  const saved = { ...process.env };
  try {
    for (const k of ["WORKSPACE_ORG", "WORKSPACE_OPS_URL", "WORKSPACE_SELF_EMAIL", `${U}_SELF_EMAIL`, `${U}_OPS_URL`, `${U}_ORG`]) delete process.env[k];
    const argv = process.argv;
    process.argv = argv.filter((a) => a !== "--email");
    // No stored sign-in (a path that does not exist), so the variables decide, whatever this machine's HOME holds.
    const none = { credentialPaths: [join(tmpdir(), "operator-tooling-none", "a.json")] };
    process.env[`${U}_SELF_EMAIL`] = "old@example.com";
    check("resolveIdentity does not read the old self-email variable", op.resolveIdentity(none).email === "");
    process.env.WORKSPACE_SELF_EMAIL = "new@example.com";
    const id = op.resolveIdentity(none);
    check("resolveIdentity reads WORKSPACE_SELF_EMAIL", id.email === "new@example.com" && id.source === "WORKSPACE_SELF_EMAIL", JSON.stringify(id));
    // The stored sign-in: the login command's folder, and only it.
    check("the stored sign-in is read from ~/.config/workspace-mcp/ only", op.CREDENTIAL_PATHS.length === 1 && op.CREDENTIAL_PATHS[0].endsWith(join(".config", "workspace-mcp", "credentials.json")), op.CREDENTIAL_PATHS.join(", "));
    const home = mkdtempSync(join(tmpdir(), "operator-tooling-home-"));
    try {
      const path = join(home, "workspace-mcp", "credentials.json");
      mkdirSync(join(home, "workspace-mcp"), { recursive: true });
      writeFileSync(path, JSON.stringify({ email: "signed-in@example.com" }));
      const fromLogin = op.resolveIdentity({ credentialPaths: [path] });
      check("a sign-in there is who is running this", fromLogin.email === "signed-in@example.com" && fromLogin.source === "workspace-login", JSON.stringify(fromLogin));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    process.env[`${U}_OPS_URL`] = "https://old.example/";
    check("opsUrl does not read the old variable", op.opsUrl() !== "https://old.example");
    process.env.WORKSPACE_OPS_URL = "https://new.example";
    check("opsUrl reads WORKSPACE_OPS_URL", op.opsUrl() === "https://new.example");
    process.env[`${U}_ORG`] = "org-old";
    let fromOld;
    try { fromOld = customer.workspaceFor(); } catch { fromOld = null; }
    check("workspaceFor does not read the old org variable", fromOld === null);
    process.env.WORKSPACE_ORG = "org-new";
    check("workspaceFor reads WORKSPACE_ORG", customer.workspaceFor() === "org-new");
    process.argv = argv;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/* 4. The member-profile memory key. ------------------------------------------------------------------------- */
const keys = op.memberProfileKeys(" Quinn@example.com ");
check("the key is neutral and lower-cased", keys.key === "member-profile:quinn@example.com" && Object.keys(keys).join() === "key", JSON.stringify(keys));
const row = { id: 2, key: keys.key, version: 1 };
check("a profile stored under the key is found", op.pickMemberProfile([row], "quinn@example.com") === row);
check("a row under the old key is not (drizzle/0037 moved them)", op.pickMemberProfile([{ id: 1, key: `${w}-profile:quinn@example.com` }], "quinn@example.com") === null);
check("another person's row is never picked", op.pickMemberProfile([{ id: 3, key: "member-profile:x@example.com" }], "quinn@example.com") === null);
check("no rows is null", op.pickMemberProfile([], "a@b.c") === null);
check("the email is read back from the key", op.memberProfileEmail(keys.key) === "quinn@example.com");
check("any other key names no member", op.memberProfileEmail("profile:someone") === null && op.memberProfileEmail(`${w}-profile:quinn@example.com`) === null);

const onboard = readFileSync(join(ROOT, "scripts/operator/onboard-self.mjs"), "utf8");
check("onboard-self looks the profile up under its key", /inArray\(memories\.key, \[key\]\)/.test(onboard));
check("onboard-self picks the row with pickMemberProfile", /pickMemberProfile\(found, email\)/.test(onboard));
check("onboard-self writes the key when it updates", /\.set\(\{ key, value,/.test(onboard));
check("onboard-self inserts under the key", /insert\(memories\)\.values\(\{[\s\S]{0,80}\bkey,/.test(onboard));
check("onboard-self never spells the old word", !onboard.toLowerCase().includes(w));

console.log(failures ? `\n${failures} failure(s)` : "\nall operator-tooling checks passed");
process.exit(failures ? 1 : 0);
