/**
 * THE WORDS A PERSON READS for the base product's domains, in this deployment's profile.
 *
 * The base product names five things: the account (a "customer"), the person who works in the console (an "FDE"),
 * the account's owner ("FDE owner"), and the two delivery record areas (a "deployment", an "implementation", whose
 * groups are "rollouts"). A profile renames them (profiles/*.json: `vocabulary`, `domains.<area>.label`,
 * `domains.implementations.group_label`). Any sentence the UI or an ops API shows that names one of them takes the
 * word from HERE, never from a literal: `${W.Account} not found`, not "Customer not found". That is what
 * `npm run check:ui-vocabulary` enforces, in the source and in the built client bundle.
 *
 * Under profiles/00-default.json every word below is exactly the base word it replaces ("customer", "Customers",
 * "FDE owner", "deployment", "Implementation"…), so the default deployment reads byte-for-byte what it read
 * before; `npm run check:ui-vocabulary` pins every word, and scripts/test-ui-vocabulary.mjs holds the functions built
 * on them (lib/ui-keys.ts, lib/ops-errors.ts) to the identity.
 *
 * `install` is the product install itself ("configured on this deployment"): once the profile renames the
 * deployment record area, "deployment" means that record, so the install is called the workspace — the same rule
 * agent/lib/agent-vocabulary.ts applies to what the model reads.
 *
 * Pure: plain data from the generated profile, safe on the client and the server.
 */
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";
import { domainView, lowerFirst } from "./profile-domains.ts";

export const upperFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

const V = DEPLOYMENT_PROFILE.vocabulary;
const DEP = domainView("deployments");
const IMP = domainView("implementations");
/** What a group of implementation rows is called (`domains.implementations.group_label`). */
const ROLLOUT = DEPLOYMENT_PROFILE.domains.implementations.group_label;

/** Lower-case for prose, capitalised for the start of a sentence or a label. */
export const W = {
  account: V.account.singular,
  accounts: V.account.plural,
  Account: upperFirst(V.account.singular),
  Accounts: upperFirst(V.account.plural),
  member: V.member.singular,
  members: V.member.plural,
  Member: upperFirst(V.member.singular),
  Members: upperFirst(V.member.plural),
  /** The label of the member responsible for an account ("FDE owner"). Also the `fde_owner` field's label. */
  owner: V.owner,
  deployment: DEP.noun,
  deployments: DEP.nouns,
  Deployment: DEP.singular,
  Deployments: DEP.plural,
  implementation: IMP.noun,
  implementations: IMP.nouns,
  Implementation: IMP.singular,
  Implementations: IMP.plural,
  rollout: lowerFirst(ROLLOUT.singular),
  rollouts: lowerFirst(ROLLOUT.plural),
  Rollout: ROLLOUT.singular,
  Rollouts: ROLLOUT.plural,
  /** An account id as a placeholder shows it: "customer-id". */
  accountIdExample: `${V.account.singular.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-id`,
  /** The product install ("not configured on this deployment"). */
  install: DEP.noun === "deployment" ? "deployment" : "workspace",
} as const;

/** A data-room domain (its stored name: "Customers", "Tickets") as a person reads it: the profile's label. */
export function domainLabel(domain: string): string {
  return DEPLOYMENT_PROFILE.dataroom.domains[domain]?.label || domain;
}

/** "a" or "an" before a word: `${an(W.member)} ${W.member}` reads "an FDE", "an analyst", "a company". */
export function an(word: string): string {
  if (/^[A-Z]{2,}/.test(word)) return /^[AEFHILMNORSX]/.test(word) ? "an" : "a";
  return /^[aeiou]/i.test(word) && !/^(uni|use|usu|eu|one)/i.test(word) ? "an" : "a";
}
