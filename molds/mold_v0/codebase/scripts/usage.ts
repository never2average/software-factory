// Per-model inference usage and cost through the gateway.
//   npm run usage                                   last 7 days, all models
//   npm run usage -- --model gpt-6.1-sol --days 30  one model
//   npm run usage -- price gpt-6.1-sol 2.00 0.10 10.00 [--long 272000 4.00 0.20 15.00] [--source "..."]
//   npm run usage -- prices
import { getDb } from "../src/db.js";
import { setPrice, usageReport } from "../src/usage.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const usd = (n: unknown) => `$${Number(n).toFixed(4)}`;

try {
  if (args[0] === "price") {
    const [, model, inp, cached, out] = args;
    const li = args.indexOf("--long");
    await setPrice(model, {
      input_per_mtok: Number(inp), cached_input_per_mtok: Number(cached), output_per_mtok: Number(out), source: flag("source") ?? "manual",
      ...(li >= 0 ? { long_context_threshold: Number(args[li + 1]), long_input_per_mtok: Number(args[li + 2]),
                      long_cached_input_per_mtok: Number(args[li + 3]), long_output_per_mtok: Number(args[li + 4]) } : {}),
    });
    console.log(`price set for ${model}`);
  } else if (args[0] === "prices") {
    console.table(await (await getDb()).query("SELECT model, input_per_mtok, cached_input_per_mtok, output_per_mtok, long_context_threshold, source FROM model_prices ORDER BY model"));
  } else {
    const r = await usageReport({ days: flag("days") ? Number(flag("days")) : 7, model: flag("model") });
    console.log(`Inference usage, last ${r.days} day(s)${r.model ? `, ${r.model}` : ""} (USD at list prices; unpriced models show $0):`);
    console.table(r.totals.map((t: any) => ({ model: t.model, requests: Number(t.requests), input: Number(t.input_tokens), cached: Number(t.cached_input_tokens),
                                               output: Number(t.output_tokens), cost: usd(t.cost_usd), priced: t.priced })));
    console.table(r.daily.map((d: any) => ({ day: d.day, model: d.model, consumer: d.consumer, requests: d.requests, input: Number(d.input_tokens),
                                              cached: Number(d.cached_input_tokens), output: Number(d.output_tokens), cost: usd(d.cost_usd) })));
  }
} finally {
  await (await getDb()).close();
}
