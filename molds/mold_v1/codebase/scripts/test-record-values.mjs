/**
 * Record choice values come from ONE place: the zod enums in agent/lib/customer-schema.ts (and, for the words a
 * person reads, the deployment profile). Offline: no database, no network.
 *
 * mold_v1-251. Each of these held a hand-made copy of a choice list, and each copy had drifted from what is stored:
 *   - the attention counts compared health with "Healthy" and risk with "High"/"Critical" (no row holds either);
 *   - the create route defaulted stage "scoping", risk "low" and blocker owner "" (none a value of its enum);
 *   - the default create form offered risk low/medium/high/critical and environment production/development;
 *   - the MCP tool named stages "scoping/configuration/integration/uat/go-live";
 *   - the Ops API stored any string for a choice column.
 *
 * Here: the meanings base code gives a value are values of their enum; the MCP text is built from the enum and names
 * nothing else; the Ops API's choice check refuses a value with a message that lists the real ones. The database
 * half (counts, defaults and refusals through the real routes) is scripts/test-record-values-db.mjs.
 *
 *   npm run test:record-values
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

// The web app's `@/` alias and extensionless imports, as the app resolves them (scripts/test-workspace-attention-db.mjs).
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

let passed = 0;
let failures = 0;
const check = (what, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${what}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${what}\n         ${String(e?.message ?? e).split("\n").slice(0, 6).join("\n         ")}`);
  }
};

const schema = await import("../agent/lib/customer-schema.ts");
const { deploymentSchema, implementationSchema, ticketSchema } = schema;
const { DOMAIN_FIELDS } = await import("../lib/deployment-profile.generated.ts");
const { FOLDER } = await import("../agent/lib/dataroom-folders.ts");
const ENUM = {
  deployments: (k) => deploymentSchema.shape[k].unwrap?.().options ?? deploymentSchema.shape[k].options,
  implementations: (k) => implementationSchema.shape[k].unwrap?.().options ?? implementationSchema.shape[k].options,
};
const STAGES = ENUM.implementations("implementationStage");
const RISKS = ENUM.implementations("implementationRiskLevel");

console.log("\n1. The values base code gives a meaning to are values of their enums");
{
  const M = schema.CHOICE_MEANINGS;
  check("CHOICE_MEANINGS exists in agent/lib/customer-schema.ts", () => assert.ok(M, "no CHOICE_MEANINGS export"));
  check("the create defaults are stored values (release, health; stage, risk, blocker owner)", () => {
    for (const [k, v] of Object.entries(M.deployments.defaults)) assert.ok(ENUM.deployments(k).includes(v), `deployments.${k} default ${JSON.stringify(v)}`);
    for (const [k, v] of Object.entries(M.implementations.defaults)) assert.ok(ENUM.implementations(k).includes(v), `implementations.${k} default ${JSON.stringify(v)}`);
  });
  check("what counts as healthy, and as at risk, are stored values", () => {
    for (const v of M.deployments.healthy) assert.ok(ENUM.deployments("healthStatus").includes(v), v);
    for (const v of M.implementations.atRisk) assert.ok(RISKS.includes(v), v);
    assert.ok(M.implementations.atRisk.includes(RISKS.at(-1)), "the highest risk value is counted");
    assert.ok(!M.implementations.atRisk.includes(RISKS[0]), "the lowest is not");
  });
  check("the ticket statuses and priorities the counts use are stored values", () => {
    for (const v of M.tickets.open) assert.ok(ticketSchema.shape.ticketStatus.options.includes(v), v);
    for (const v of M.tickets.urgent) assert.ok(ticketSchema.shape.ticketPriority.options.includes(v), v);
  });
  check("the generated profile carries the enums unchanged (DOMAIN_FIELDS is what the routes and forms read)", () => {
    for (const area of ["deployments", "implementations"]) {
      for (const [k, meta] of Object.entries(DOMAIN_FIELDS[area])) if (meta.type === "enum") assert.deepEqual(meta.values, ENUM[area](k), `${area}.${k}`);
    }
  });
}

console.log("\n2. The Ops API's choice check: a stored value passes, anything else is refused with the list");
{
  const fields = await import("../lib/ops-domain-fields.ts");
  check("choiceSchema exists in lib/ops-domain-fields.ts", () => assert.equal(typeof fields.choiceSchema, "function"));
  if (typeof fields.choiceSchema === "function") {
    for (const [area, key, bad] of [
      ["implementations", "implementationRiskLevel", "low"],
      ["implementations", "implementationStage", "scoping"],
      ["deployments", "healthStatus", "Healthy"],
      ["deployments", "environment", "production"],
    ]) {
      check(`${area}.${key}: every stored value passes; ${JSON.stringify(bad)} is refused naming each real value`, () => {
        const s = fields.choiceSchema(area, key);
        for (const v of ENUM[area](key)) assert.equal(s.safeParse(v).success, true, v);
        const r = s.safeParse(bad);
        assert.equal(r.success, false);
        const msg = r.error.issues[0].message;
        assert.ok(msg.includes(JSON.stringify(bad)), `names the value it refused: ${msg}`);
        for (const v of ENUM[area](key)) assert.ok(msg.includes(v), `lists ${v}: ${msg}`);
      });
    }
    check("an optional choice column a profile puts on a form is checked the same way", () => {
      const s = fields.profileFieldSchemas("implementations", [])["launchDecision"];
      assert.equal(s.safeParse("Go").success, true);
      assert.equal(s.safeParse("").success, true, "blank clears");
      const r = s.safeParse("maybe");
      assert.equal(r.success, false);
      assert.match(r.error.issues[0].message, /Pending, Go, No-Go, Deferred/);
    });
  }
}

console.log("\n3. The MCP write tools: the choice text is the enum's, and a host that does not know it names none");
{
  const { createTools } = await import("../setup/workspace-tools.mjs");
  const base = { api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null, folders: FOLDER };
  const toolsOf = (ctx) => Object.fromEntries(createTools({ ...base, ...ctx }).map((t) => [t.name, t]));
  const { toolChoices } = await import("../lib/ops-domain-fields.ts").catch(() => ({}));
  const packaged = toolsOf({});
  const hosted = toolsOf({ choices: typeof toolChoices === "function" ? toolChoices() : undefined });
  /** Every stage-like word the tool's text names in a list: "stage (a/b/c)" or "stage: one of a, b". */
  const namedStages = (tool) => {
    const text = [tool.description, tool.inputSchema.properties.implementationStage?.description ?? ""].join("\n");
    const list = /stage \(([^)]*)\)/i.exec(text)?.[1] ?? /stage: one of ([^.]*)\./i.exec(text)?.[1] ?? "";
    return list.split(/[/,]/).map((w) => w.replace(/\(.*$/, "").trim()).filter(Boolean);
  };
  check("implementation_upsert names no stage that is not a stored value (packaged host)", () => {
    const bad = namedStages(packaged.implementation_upsert).filter((w) => !STAGES.includes(w));
    assert.deepEqual(bad, [], "stage names in the tool text that are not values of implementationStage");
  });
  check("…nor the hosted endpoint", () => {
    const bad = namedStages(hosted.implementation_upsert).filter((w) => !STAGES.includes(w));
    assert.deepEqual(bad, []);
  });
  check("hosted: stage and risk are the enum's values, in order, as a JSON-schema enum, and the text lists each", () => {
    const p = hosted.implementation_upsert.inputSchema.properties;
    assert.deepEqual(p.implementationStage.enum, STAGES);
    assert.deepEqual(p.implementationRiskLevel.enum, RISKS);
    assert.deepEqual(namedStages(hosted.implementation_upsert), STAGES);
    for (const r of RISKS) assert.ok(p.implementationRiskLevel.description.includes(r), r);
  });
  check("hosted: the record's environment, region, release and health are the enum's values, with the create defaults", () => {
    const p = hosted.deployment_upsert.inputSchema.properties;
    for (const k of ["environment", "region", "releaseStatus", "healthStatus"]) assert.deepEqual(p[k].enum, ENUM.deployments(k), k);
    const M = schema.CHOICE_MEANINGS;
    assert.ok(p.healthStatus.description.includes(`gets ${M.deployments.defaults.healthStatus}.`), p.healthStatus.description);
    assert.ok(hosted.implementation_upsert.inputSchema.properties.implementationStage.description.includes(`gets ${M.implementations.defaults.implementationStage}.`));
  });
  check("packaged (no choices): the choice inputs are plain strings, and say a wrong value comes back with the list", () => {
    const p = packaged.implementation_upsert.inputSchema.properties;
    assert.equal(p.implementationStage.enum, undefined);
    assert.equal(p.implementationStage.type, "string");
    assert.match(p.implementationStage.description, /refused with the list of valid ones/);
  });
  check("no stage or risk value is spelled in the packaged record tools' text, in any case (a copy is what drifted)", () => {
    const text = JSON.stringify([packaged.implementation_upsert, packaged.deployment_upsert]);
    for (const v of [...STAGES, ...RISKS]) {
      assert.ok(!new RegExp(`\\b${v.replace(/[-]/g, "\\-")}\\b`, "i").test(text), `${JSON.stringify(v)} is spelled in the packaged tool text`);
    }
  });
}

console.log(`\ntest-record-values: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
