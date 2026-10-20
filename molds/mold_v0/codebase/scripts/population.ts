// Developer populations admin CLI: the coding-agent mix per population, stored in Postgres.
//   npm run population -- list
//   npm run population -- show [slug]                       (default population if omitted)
//   npm run population -- create enterprise "Enterprise developers" [--from global]
//   npm run population -- share global codex/default 0.2   (market share; renormalised over running agents)
//   npm run population -- pause global copilot/auto "no credentials yet"  |  resume global copilot/auto
//   npm run population -- unit global 20 [--min-one]        (sandbox unit; --min-one gives every agent >= 1)
//   npm run population -- default enterprise
import { getDb } from "../src/db.js";
import { runnableCoverage, sandboxMix } from "../src/agents.js";
import * as pops from "../src/populations.js";

const [cmd, ...args] = process.argv.slice(2);

async function show(slug?: string) {
  const p = await pops.getPopulation(slug);
  const mix = new Map(sandboxMix(p).map((r) => [r.agent.id, r]));
  console.log(`${p.name} [${p.slug}]${p.is_default ? " (default)" : ""}: unit ${p.sandbox_unit} sandboxes${p.min_one_sandbox ? ", min one each" : ""}; runnable coverage ${(runnableCoverage(p) * 100).toFixed(1)}%`);
  console.table(p.agents.filter((a) => a.weight > 0).map((a) => ({
    agent: a.id, market_share: `${(a.weight * 100).toFixed(1)}%`, paused: a.paused ? a.paused_reason ?? "yes" : "",
    exact: mix.get(a.id)?.exact.toFixed(2) ?? "-", sandboxes: mix.get(a.id)?.sandboxes ?? 0,
  })));
}

async function main() {
  switch (cmd) {
    case "list": console.table(await pops.listPopulations()); return;
    case "show": return show(args[0]);
    case "create": {
      const i = args.indexOf("--from");
      await pops.createPopulation(args[0], args[1], { from: i >= 0 ? args[i + 1] : undefined });
      return show(args[0]);
    }
    case "share": await pops.setShare(args[0], args[1], Number(args[2])); return show(args[0]);
    case "pause": await pops.setPaused(args[0], args[1], true, args[2]); return show(args[0]);
    case "resume": await pops.setPaused(args[0], args[1], false); return show(args[0]);
    case "unit": await pops.updatePopulation(args[0], { sandbox_unit: Number(args[1]), min_one_sandbox: args.includes("--min-one") }); return show(args[0]);
    case "default": await pops.setDefaultPopulation(args[0]); return show(args[0]);
    default: throw new Error("Commands: list, show, create, share, pause, resume, unit, default");
  }
}

try { await main(); }
finally { await (await getDb()).close(); }
