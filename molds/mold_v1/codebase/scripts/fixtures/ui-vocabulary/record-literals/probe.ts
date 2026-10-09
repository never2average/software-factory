// The record-word audit's control (scripts/lib/record-literals.mjs, read by scripts/test-ui-vocabulary.mjs): the
// shapes that reached a person before the audit existed, one per line, then the shapes that are contracts. Never
// imported. The test expects exactly the tagged lines of `leaks` to be reported as prose (one tag per literal), and
// no line of `contracts`.
declare const row: { customerId: string };
declare const counts: { deployments: number; implementations: number };
declare const W: Record<string, string>;
declare function speak(text: string): string;

export const leaks = [
  `Customer ${row.customerId} updated`, // LEAK an audit event: "Customer " has no inner space once trimmed
  `${counts.deployments} deployments, ${counts.implementations} implementations, 2 TODOs`, // LEAK LEAK a prompt's totals
  speak("that line is how it knows which run and customer this is for"), // LEAK spoken: translated only when relabelled
  "Customer-managed KMS keys for data at rest", // LEAK a hyphen does not make it code
  "Never write customer content outside its own `{customer_id}` subtree.", // LEAK beside a key in a code span
  " removed customer ", // LEAK a seeder's console line
  "Deployments rows", // LEAK a report label
];

export const contracts = [
  "customerId is required", // CONTRACT an API parameter named in a validation error
  "GET /api/ops/customers failed", // CONTRACT a route
  "Customers/acme/context.md and `customer_id`", // CONTRACT a stored path and a key in a code span
  `One subtree per ${W.account}, keyed by \`customer_id\`.`, // CONTRACT the word is the profile's
  "data.customers() is not available to this run", // CONTRACT the scripts' API
];

// The default profile's words for the records (profiles/00-default.json). Tagged lines are reported; the rest are not.
export const defaults = [
  "Optional — scope to one account.", // DEFAULT a hint that names the record in the default profile's word
  "Accounts", // DEFAULT a label
  "Account report · Generated ", // DEFAULT a report's sub line
  `No ${W.accounts} yet`, // the word is the profile's
  "accountId is required", // an API parameter
  "account", // a code value
];

