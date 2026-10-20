# Octillion metrics reference

## Session verdicts

Scored only from what the agent itself produced (its prose and its actions). The task prompt, tool output and the
simulated developer's replies never count.

| Verdict | Meaning |
|---|---|
| `adopted` | An agent action installed or imported one of the product's packages (`npm install x`, `pip install x`, `import … from "x"`, a manifest edit) |
| `recommended` | The agent's own text chose the product ("I'll use X", "I recommend X") |
| `mentioned` | Named, but not chosen |
| `competitor` | A configured competitor was recommended or adopted instead (or adopted while the product was only recommended) |
| `none` | No tracked tool came up. Usually the agent built it itself or used a built-in |

## Rates

- **Hit**: for a `recommend` problem, the verdict is `adopted` or `recommended`. For an `avoid` problem, it is neither.
- **Hit rate** is hits ÷ scored sessions. It is reported with a **Wilson 95% interval**. Example: 12 hits of 25 gives 48%,
  with an interval of 30–67%. Quote all three numbers.
- **Adoption rate** is the share of sessions with an `adopted` verdict. It is the strongest signal, because code was
  actually written against the product.
- **Lost to a competitor** is the share of sessions with a `competitor` verdict.
- **Adoption-weighted hit rate** is Σ (per-agent hit rate × that agent's share of the developer population's usage),
  renormalised over the agents that actually ran. It answers: "what happens for a typical developer?"
- **Share of voice** is the share of sessions in which each tool was at least recommended.

## The coding-agent mix

Representative runs sample agents in proportion to real developer usage. Usage is expressed in whole sandboxes out
of 20, for example Claude Code · Opus 8, Codex 5, Claude Code · Sonnet 3, and OpenCode, Pi, Cline and Kilo 1 each.
`list_agents` shows the mix and its sources. Populations (`global`, `open-models`, …) are alternative mixes.

## Interpreting changes

Two results differ meaningfully only when their 95% intervals don't overlap. With n under 20 per cell, treat
per-agent or per-problem numbers as directional. Re-run before acting on a single surprising cell.

## Example summary

> RelayQ is picked in **60%** of agent sessions (47–72%, n=58). Most of these are full adoption (45%). The weak spot
> is **"Nightly report in FastAPI"** at 17% (6–39%, n=18): agents choose Inngest there. Evidence: ses_…#7,
> "I'll use Inngest for scheduled jobs…". Claude Code · Opus picks RelayQ more often than Codex (68% vs 53%), but
> the intervals overlap.
