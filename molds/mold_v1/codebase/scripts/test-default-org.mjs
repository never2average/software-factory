#!/usr/bin/env node
/**
 * ORG #1 IS A DEPLOYMENT SETTING (lib/default-org.ts).
 *
 * Org #1's workspace id and hosted domain used to be one company's, written into lib/org-context.ts and its agent twin.
 * Each deployment now names its own with DEFAULT_ORG_ID and DEFAULT_ORG_DOMAIN; unset, neutral built-in placeholders
 * apply. A deployment whose data was written under an id keeps working only if it is given that id, so this holds
 * every reader to the same rule:
 *
 *   1. unset (or blank), lib/default-org.ts answers its built-in values, and scripts/lib/default-org.mjs the same;
 *   2. set, the web's lib/org-context.ts, the agent's agent/lib/org-context.ts, lib/default-org.ts and the scripts'
 *      scripts/lib/default-org.mjs all answer the deployment's values (the domain in lower case);
 *   3. the operator tooling records org #1's slug as the employer, or WORKSPACE_OPERATOR_COMPANY when it is set.
 *
 * Each case runs in a child process, since the modules read the environment once, when they load.
 *
 *   npm run test:default-org
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
};

const PROBE = `
const lib = await import("./lib/default-org.ts");
const scripts = await import("./scripts/lib/default-org.mjs");
const agent = await import("./agent/lib/org-context.ts");
const op = await import("./scripts/operator/lib/operator.mjs");
console.log(JSON.stringify({
  lib: [lib.DEFAULT_ORG, lib.DEFAULT_DOMAIN], builtIn: [lib.BUILT_IN_ORG, lib.BUILT_IN_DOMAIN],
  scripts: [scripts.DEFAULT_ORG, scripts.DEFAULT_DOMAIN], scriptsBuiltIn: [scripts.BUILT_IN_ORG, scripts.BUILT_IN_DOMAIN],
  agent: [agent.DEFAULT_ORG, agent.DEFAULT_DOMAIN], company: op.OPERATOR_COMPANY, allowed: op.ALLOWED_DOMAIN,
}));`;

function probe(extra) {
  const env = { ...process.env };
  for (const k of ["DEFAULT_ORG_ID", "DEFAULT_ORG_DOMAIN", "WORKSPACE_OPERATOR_COMPANY"]) delete env[k];
  Object.assign(env, extra);
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", PROBE], { env, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

console.log("1. Unset, the built-in placeholders");
const none = probe({});
check("lib/default-org.ts: DEFAULT_ORG and DEFAULT_DOMAIN are the built-in values", JSON.stringify(none.lib) === JSON.stringify(none.builtIn), none);
check("…and the built-in id has the org- prefix every workspace id has", /^org-[a-z0-9-]+$/.test(none.builtIn[0]), none.builtIn);
check("scripts/lib/default-org.mjs reads the same built-in values from lib/default-org.ts", JSON.stringify(none.scriptsBuiltIn) === JSON.stringify(none.builtIn) && JSON.stringify(none.scripts) === JSON.stringify(none.lib), none);
check("the agent's org context re-exports them", JSON.stringify(none.agent) === JSON.stringify(none.lib), none);
check("the operator tooling: the built-in domain, and the built-in slug as the employer", none.allowed === none.builtIn[1] && none.company === none.builtIn[0].replace(/^org-/, ""), none);
const blank = probe({ DEFAULT_ORG_ID: "  ", DEFAULT_ORG_DOMAIN: "", WORKSPACE_OPERATOR_COMPANY: " " });
check("blank settings count as unset", JSON.stringify(blank) === JSON.stringify(none), blank);

console.log("\n2. Set, every reader answers the deployment's org #1");
const set = probe({ DEFAULT_ORG_ID: " org-northwind ", DEFAULT_ORG_DOMAIN: "Northwind.Example" });
const want = JSON.stringify(["org-northwind", "northwind.example"]);
check("lib/default-org.ts (trimmed; the domain in lower case)", JSON.stringify(set.lib) === want, set.lib);
check("scripts/lib/default-org.mjs", JSON.stringify(set.scripts) === want, set.scripts);
check("agent/lib/org-context.ts", JSON.stringify(set.agent) === want, set.agent);
check("the built-in values are unchanged by the settings", JSON.stringify(set.builtIn) === JSON.stringify(none.builtIn), set.builtIn);
check("the operator tooling: the deployment's domain, and its slug as the employer", set.allowed === "northwind.example" && set.company === "northwind", set);
const named = probe({ DEFAULT_ORG_ID: "org-northwind", WORKSPACE_OPERATOR_COMPANY: "Northwind Traders" });
check("WORKSPACE_OPERATOR_COMPANY names the employer when it is set", named.company === "Northwind Traders", named.company);

console.log("\n3. Written once");
const web = readFileSync("lib/org-context.ts", "utf8");
const agentSrc = readFileSync("agent/lib/org-context.ts", "utf8");
check("neither org context writes an org id or a domain of its own", !/export const DEFAULT_(ORG|DOMAIN)\s*=/.test(web) && !/export const DEFAULT_(ORG|DOMAIN)\s*=/.test(agentSrc));

console.log(failures.length ? `\ntest-default-org: ${failures.length} failed` : `\ntest-default-org: all ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);
