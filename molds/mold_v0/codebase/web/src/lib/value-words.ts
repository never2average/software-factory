// Common short values in words (mold_v0-240), with no imports: one mapping for the credentials card's environment
// names (features/credentials/model.ts envWord, mold_v0-239) and a record's readable json fields
// (features/records/json-text.ts). "prod" reads Production wherever the console shows it.

/** The usual names of an environment, in words. */
const ENV_WORDS: Record<string, string> = {
  prod: 'Production', production: 'Production', prd: 'Production', live: 'Live', staging: 'Staging', stage: 'Staging', stg: 'Staging',
  uat: 'UAT', qa: 'QA', test: 'Test', testing: 'Test', dev: 'Development', development: 'Development', sandbox: 'Sandbox', preprod: 'Pre-production',
  'pre-prod': 'Pre-production', dr: 'Disaster recovery', demo: 'Demo', local: 'Local'
};
/** Other short values a stored document often carries (where a thing is hosted), in words. */
const OTHER_WORDS: Record<string, string> = {
  aws: 'AWS', gcp: 'GCP', azure: 'Azure', 'on-prem': 'On-premises', onprem: 'On-premises', 'on-premises': 'On-premises', k8s: 'Kubernetes'
};

/** An environment's name in words ("prod" reads Production); any other name capitalised. */
export const envWord = (e: string) => ENV_WORDS[e.toLowerCase()] ?? e.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A short value in words when it is a common one ("prod" reads Production, "aws" AWS); any other value as it is. */
export const valueWord = (v: string) => ENV_WORDS[v.toLowerCase()] ?? OTHER_WORDS[v.toLowerCase()] ?? v;
