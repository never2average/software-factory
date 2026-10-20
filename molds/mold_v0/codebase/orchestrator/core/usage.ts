/** Token usage / cost across all harness runs of a session (launch + resumes). */
export interface Usage { tokens_in?: number; tokens_out?: number; cost_usd?: number; meta: Record<string, unknown> }

export class UsageTracker {
  // Claude Code: one `result` event per run, each with that run's usage and cost.
  private claudeRuns: Record<string, any>[] = [];
  private codexIn = 0; private codexCached = 0; private codexOut = 0; private codexReasoning = 0; private codexTurns = 0;

  observe(ev: Record<string, any>) {
    if (ev.type === "result") this.claudeRuns.push(ev);
    if (ev.type === "turn.completed" && ev.usage) {
      this.codexTurns++;
      this.codexIn += ev.usage.input_tokens ?? 0;
      this.codexCached += ev.usage.cached_input_tokens ?? 0;
      this.codexOut += ev.usage.output_tokens ?? 0;
      this.codexReasoning += ev.usage.reasoning_output_tokens ?? 0;
    }
  }

  usage(): Usage {
    if (this.claudeRuns.length) {
      let tin = 0, tout = 0, cost = 0, hasCost = false, turns = 0;
      const sum: Record<string, number> = {};
      for (const r of this.claudeRuns) {
        const u = r.usage ?? {};
        // input includes cache writes + reads so totals are comparable across harnesses
        tin += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        tout += u.output_tokens ?? 0;
        for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) sum[k] = (sum[k] ?? 0) + (u[k] ?? 0);
        if (typeof r.total_cost_usd === "number") { cost += r.total_cost_usd; hasCost = true; }
        turns += r.num_turns ?? 0;
      }
      const last = this.claudeRuns[this.claudeRuns.length - 1]!;
      return {
        tokens_in: tin, tokens_out: tout, cost_usd: hasCost ? Number(cost.toFixed(6)) : undefined,
        meta: { usage: sum, num_turns: turns, harness_runs: this.claudeRuns.length, subtype: last.subtype, model_usage: last.modelUsage },
      };
    }
    if (this.codexTurns) {
      return {
        tokens_in: this.codexIn,
        tokens_out: this.codexOut,
        cost_usd: undefined, // codex reports no cost; compute server-side from a price table
        meta: { usage: { input_tokens: this.codexIn, cached_input_tokens: this.codexCached, output_tokens: this.codexOut, reasoning_output_tokens: this.codexReasoning }, turns: this.codexTurns },
      };
    }
    return { meta: {} };
  }
}
