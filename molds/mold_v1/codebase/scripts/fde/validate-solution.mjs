// fde:validate-solution — the shared hard gate for a configured solution. Reads a
// Solutions/{ver}/{pipelines|agents}/{id}/ instance and checks it is well-formed:
// the contract schema parses, the artifact/recipe exists, no TODO markers remain,
// and evals are seeded. Advisory by default; `--strict` exits non-zero on any
// hard failure (for CI / a finish gate). Dependency-free — no ajv (package.json
// is frozen); this is structural validation + a doctor-style lint.
//
//   npm run fde:validate-solution -- --version v2.4.0 --id pl-collections
//   npm run fde:validate-solution -- --version v2.4.0 --id collections-agent --kind agent --strict
import { dataroom, workspaceFor } from "./lib/customer.mjs";
import { glyph, flag, hasFlag } from "./lib/fde.mjs";

async function main() {
  const version = flag("version").trim();
  const id = flag("id").trim();
  const kind = flag("kind").trim() || "pipeline";
  if (!version || !id) {
    console.error(`${glyph.bad} --version and --id are required.`);
    process.exit(1);
  }
  const sub = kind === "agent" ? "agents" : "pipelines";
  const base = `Solutions/${version}/${sub}/${id}`;
  const store = dataroom(workspaceFor());
  const present = await store.list(base);
  if (present.length === 0) {
    console.error(`${glyph.bad} No solution at ${base}. Configure it first (fde:configure-${kind === "agent" ? "agents" : "solution"}).`);
    process.exit(1);
  }

  console.log(`Validate ${kind} solution: ${base}\n`);
  const hard = []; // blocking
  const soft = []; // advisory

  const has = (rel) => present.includes(`${base}/${rel}`);
  async function readJson(rel) {
    const raw = await store.read(`${base}/${rel}`);
    if (raw == null) return { missing: true };
    try {
      return { value: JSON.parse(raw), raw };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), raw };
    }
  }

  // 1. Contract schema must exist and parse.
  const schemaFile = "run_configs.schema.json";
  if (!has(schemaFile)) hard.push(`missing contract ${schemaFile}`);
  else {
    const s = await readJson(schemaFile);
    if (s.error) hard.push(`${schemaFile} does not parse: ${s.error}`);
    else if (s.value?.["x-status"] === "TODO") soft.push(`${schemaFile} is still a TODO stub`);
  }

  // 2. The artifact (pipeline) or recipe (agent) must exist and be filled.
  if (kind === "agent") {
    if (!has("recipe.md")) hard.push("missing recipe.md");
    if (!has("dataplatform.schemas.json")) soft.push("missing dataplatform.schemas.json");
  } else {
    const cfgFile = "pipeline_config.json";
    if (!has(cfgFile)) hard.push(`missing artifact ${cfgFile}`);
    else {
      const c = await readJson(cfgFile);
      if (c.error) hard.push(`${cfgFile} does not parse: ${c.error}`);
      else {
        if (c.value?.["x-status"] === "TODO") soft.push(`${cfgFile} still marked TODO`);
        if (!Array.isArray(c.value?.steps) || c.value.steps.length === 0) soft.push(`${cfgFile} has no steps`);
      }
    }
    if (!has("integromat.schema.json")) soft.push("missing integromat.schema.json");
  }

  // 3. Evals must be seeded (the gate is eval-based, not PR-based). Agents carry
  //    evals/dataset.jsonl; pipelines carry evals/{run_id}/… run outputs.
  const hasEvals =
    kind === "agent" ? has("evals/dataset.jsonl") : present.some((p) => p.startsWith(`${base}/evals/`));
  if (!hasEvals) soft.push("no evals seeded — the solution is ungated");

  // Report.
  for (const h of hard) console.log(`${glyph.bad} ${h}`);
  for (const s of soft) console.log(`${glyph.warn} ${s}`);
  if (hard.length === 0 && soft.length === 0) console.log(`${glyph.ok} well-formed and complete.`);
  else if (hard.length === 0) console.log(`\n${glyph.ok} structurally valid (${soft.length} advisory).`);

  if (hard.length > 0 && hasFlag("strict")) {
    console.error(`\n${glyph.bad} ${hard.length} hard failure(s) — not shippable.`);
    process.exit(1);
  }
  console.log(`\n${glyph.info} ${hard.length} hard, ${soft.length} advisory. ${hasFlag("strict") ? "" : "(pass --strict to gate on hard failures)"}`);
}

main().catch((e) => {
  console.error(`${glyph.bad} validate-solution failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
