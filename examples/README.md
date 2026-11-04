# Shippable examples

Five complete apps, one folder each, that you can copy and ship. Each folder holds the **prompt** a person writes (plain
words, complete enough that the agent asks nothing), the **spec** the agent produced from it, the app's **pack**, its
**logo** and a README with the exact commands. Every address is at example.com; the products are made up.

| Example | Mold | Kind | What it shows |
|---|---|---|---|
| [Wrenchline](mold_v0/field-service/) | mold_v0 | tool | Field-service work orders: priority-driven respond and fix-by clocks with escalation, emailed requests becoming work orders, a visit-report agent and a scheduled preventive plan |
| [Panelwise](mold_v0/hiring-pipeline/) | mold_v0 | tool | A hiring pipeline: candidates with documents and encrypted contact details, working-day clocks, three agents (CV screen, panel summary, weekly digest), both audit trails |
| [Flagwell](mold_v0/feature-flags/) | mold_v0 | embedded | Feature flags developers build in: append-only chained rollouts, yes/no checks, keys, client sessions, webhooks both ways, SDKs, signed checkpoints |
| [Inkboard](mold_v1/newsroom-calendar/) | mold_v1 | tool | A newsroom calendar: desks, assignments and editions mapped onto the record areas, a briefing specialist as a full workspace, scheduled briefings |
| [Keyward](mold_v1/property-desk/) | mold_v1 | tool | A property maintenance desk: buildings, tickets, inspection rounds and vendors' contracts, an inspection-reading specialist, scheduled lists |

How to write your own prompt so the agent asks nothing: [docs/EXAMPLE_PROMPTS.md](../docs/EXAMPLE_PROMPTS.md).
