export const meta = {
  name: "coverage-digest",
  description: "One page on what changed across the covered {accounts} this week.",
};

phase("Read");
const digest = await agent(
  "Write one page on what changed across the covered {accounts} this week: new filings, restated figures, and anything that needs a second look.",
  { subagent: "ledger-reader" },
);

return digest;
