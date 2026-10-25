/**
 * The admin MCP's skills' texts (src/admin-mcp.ts ADMIN_SKILLS: each a playbook for one recurring job, an MCP prompt), in a
 * module with no imports, so the build reads them as the server does (mold_v0-140): scripts/gen-packs.mjs refuses a pack
 * whose pack.json `admin_mcp.skills` replaces a step these texts no longer have. Each text is given the product's name
 * (the profile's) and the skill's arguments.
 */
const CONFIRM = "Never make a change without the user's explicit yes in this conversation; say which role it needs.";

export const ADMIN_SKILL_TEXTS = {
  ops_review: (product: string, _a: Record<string, never> = {}) => [
      `Do ${product}'s daily operations review.`,
      "1. health_summary with failures: true. 2. list_access_requests with status 'pending'. 3. list_accounts with attention_only: true.",
      "Write a short report: **Health** (verdict, orchestrators, anything degraded), **Failures** (grouped by reason, with counts and the fix the data points to), " +
      "**Runs** (active ones and any stuck: queued or booting a long time), **Access requests** (who is waiting and for how long), **Accounts** (what needs attention and why). " +
      "End with at most 5 next steps, most urgent first, each naming the tool that would do it. " + CONFIRM,
    ].join("\n"),
  triage_requests: (_product: string, _a: Record<string, never> = {}) => [
      "Triage the pending access requests.",
      "1. list_access_requests with status 'pending'.",
      "2. For each: one line on the person and company (role, team size, product, what they want), the fit signals the request carries, how long it has waited, " +
      "and a recommendation: approve, decline, or ask a question first, with the reason.",
      "3. Show them as a table, oldest first. Then ask which to approve or decline; call approve_access_request / decline_access_request only for the ones the user confirms (Support role). " + CONFIRM,
    ].join("\n"),
  account_review: (product: string, { account }: { account?: string }) => [
      `Review the ${product} account "${account ?? ""}".`,
      "1. list_accounts with q set to it to find the slug if needed, then get_account. 2. model_spend with account set to the slug.",
      "Write: **Where they are** (stage, next step, people and who is active), **Usage** (tool calls, runs and their outcomes, errors), **Money** (model spend this month against the allowance, plan, " +
      "subscription state), **Problems** (anything blocking or wrong, with evidence), **Next step** (one concrete action for us, one for them). " + CONFIRM,
    ].join("\n"),
  finops_digest: (product: string, { from, to }: { from?: string; to?: string }) => {
      const r = JSON.stringify({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
      return [
        `Write ${product}'s FinOps digest for ${from || to ? `${from ?? "…"} to ${to ?? "today"}` : "this month"}.`,
        `1. finops_revenue ${r}. 2. finops_plans ${r}. 3. finops_experiments ${r}. 4. model_spend ${r}.`,
        "Write: **Revenue** (MRR now, collected, paying accounts, gross margin, the accounts that moved it), **Plans** (subscribers and MRR per plan), " +
        "**Experiments** (per running experiment: each variant's shown, subscribed, conversion with its interval, lift vs control and whether it is significant yet; say plainly when it is too early), " +
        "**Model spend** (by provider and top accounts; flag unpriced requests and anything spending fast against its allowance). Numbers from the tools only; no estimates.",
      ].join("\n");
    },
  pricing_experiment: (_product: string, { experiment, idea }: { experiment?: string; idea?: string }) => [
      `Set up the pricing experiment "${experiment ?? ""}": ${idea ?? ""}`,
      "1. finops_plans to see the existing plans and their configs (reuse one as the control if it fits).",
      "2. Draft one plan config per variant (the create_plan config: name, base_fee_usd, monthly_budget_usd, usage, trial_days, experiment, weight). Use real, marketable plan names.",
      "3. create_plan with dry_run: true for each and show what Stripe would get. 4. Ask the user to confirm; then create_plan for each (Owner role), and set_plan_experiment " +
      "to put an existing control plan in the experiment. 5. Remind them only accounts allowed plans are shown variants, and that results are on FinOps › Experiments (finops_experiments). " + CONFIRM,
    ].join("\n"),
  cost_check: (product: string, { from, to }: { from?: string; to?: string }) => [
      `Check ${product}'s model costs${from || to ? ` for ${from ?? "…"} to ${to ?? "today"}` : " this month"}.`,
      `1. model_spend ${JSON.stringify({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}. 2. list_accounts. 3. analytics_overview for the same days.`,
      "Write: total spend and its split (sessions vs orchestrators, by provider and model), the top accounts and their spend against allowance, unpriced requests (spend is understated: name the models), " +
      "and anything unusual (a day or account far above the rest). End with concrete fixes (a price row, an allowance, a setting), each naming the tool. " + CONFIRM,
    ].join("\n"),
} as const;

/** The skills, by name (src/admin-mcp.ts ADMIN_SKILLS has exactly these: the compiler holds the two lists together). */
export type AdminSkillName = keyof typeof ADMIN_SKILL_TEXTS;
