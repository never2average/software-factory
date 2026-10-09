/**
 * THE WORDS A PERSON READS for the base product's domains, in this deployment's profile.
 *
 * The base product has five things to name: the account, the person who works in the console, the account's owner,
 * and the two record areas (the second one's rows come in groups). What each is CALLED is the profile's
 * (profiles/*.json: `vocabulary`, `domains.<area>.label`, `domains.implementations.group_label`). The default
 * profile's words are neutral ones, chosen to name no line of work: account, member, "Account owner", delivery,
 * project, and plan for the group. A pack's profile replaces them with its own (company, analyst, coverage report).
 * Storage keeps its own, older names for the same things (`customer_id`, `implementationStage`, `rolloutId`): those
 * are identifiers and never move, and no sentence may spell one. A data-room folder's stored name is the profile's
 * too (agent/lib/dataroom-folders.ts): a person reads the domain's label, `domainLabel("accounts")`.
 *
 * So any sentence the UI, an ops API, a published report, a seeded file or a seeder writes that names one of them
 * takes the word from HERE, never from a literal, the default profile's words included: `${W.Account} not found`,
 * `${an(W.account)} ${W.account}`, never "Account not found" (a pack's deployment would read the default's word).
 * `npm run check:ui-vocabulary` enforces that in the source it calls visible, the built client bundle and the
 * rendered pages; the record-word audit (scripts/lib/record-literals.mjs, run by `npm run test:ui-vocabulary`) in
 * every string literal of app/, components/, lib/, the report renderer and the seeders, for the stored names and
 * for the default profile's words alike.
 *
 * `npm run check:ui-vocabulary` pins every word below to the default profile's, and scripts/test-ui-vocabulary.mjs
 * holds the functions built on them (lib/ui-keys.ts, lib/ops-errors.ts, lib/record-export.ts, lib/profile-domains.ts)
 * under the default profile, a relabelling one and one that only renames the records.
 *
 * `install` is the product install itself ("email sign-in is not configured on this workspace"): the workspace,
 * under every profile, as base text for the model says it.
 *
 * Pure: plain data from the generated profile, safe on the client and the server.
 */
import { labelOf, type DataroomDomainId } from "../agent/lib/dataroom-folders.ts";
import { LEGACY_MEMBER } from "../agent/lib/legacy-member.ts";
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";
import { domainView, lowerFirst } from "./profile-domains.ts";
import { WORK_PERIODS as PERIODS } from "../agent/lib/work-periods.ts";

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
  /** The label of the member responsible for an account ("Account owner"). Also the `fde_owner` field's label. */
  owner: V.owner,
  /** The label of an account's second owner ("Secondary owner"): the `ae_owner` / `secondary_owner` field's label. */
  secondaryOwner: V.secondary_owner,
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
  /** A time-boxed period that groups tasks (`work_periods.label`). Sentences come from lib/work-periods-ui.ts. */
  period: PERIODS.label.singular,
  periods: PERIODS.label.plural,
  Period: upperFirst(PERIODS.label.singular),
  Periods: upperFirst(PERIODS.label.plural),
  /** The same period where tasks are grouped and filtered by it (`work_periods.list_label`). */
  periodList: PERIODS.listLabel.singular,
  periodLists: PERIODS.listLabel.plural,
  /** One task in a period under mode individual (`work_periods.item_label`): "target". */
  periodItem: PERIODS.itemLabel.singular,
  periodItems: PERIODS.itemLabel.plural,
  /** An account id as a placeholder shows it: the account word, then "-id". */
  accountIdExample: `${V.account.singular.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-id`,
  /** The product install ("not configured on this workspace"). */
  install: "workspace",
} as const;

/** A data-room domain (by its id: "accounts", "tickets") as a person reads it: the profile's label. */
export function domainLabel(domain: DataroomDomainId): string {
  return labelOf(domain);
}

/** "a" or "an" before a word: `${an(W.member)} ${W.member}` reads "a member", "an analyst", "a company". */
export function an(word: string): string {
  if (/^[A-Z]{2,}/.test(word)) return /^[AEFHILMNORSX]/.test(word) ? "an" : "a";
  return /^[aeiou]/i.test(word) && !/^(uni|use|usu|eu|one)/i.test(word) ? "an" : "a";
}

/**
 * Stored enum values that carry the member's LEGACY word (agent/lib/legacy-member.ts): a
 * ticket's `ownerTeam` and an account's `valueEvidenceStatus`. Rows keep the value as stored (other systems and
 * the workbook read it, and a write sends it back); a person reads it in this deployment's member word:
 * `ownerTeam` "<legacy>" reads "Member", `valueEvidenceStatus` "<legacy> Verified" reads "Member Verified".
 * Any other field, and any other value, is shown exactly as stored.
 */
export const LEGACY_MEMBER_VALUE_FIELDS: ReadonlySet<string> = new Set(["ownerTeam", "valueEvidenceStatus"]);
const LEGACY_VALUE = new RegExp(`^${LEGACY_MEMBER.singular}(?= |$)`);
export function storedValueLabel(field: string, value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (!LEGACY_MEMBER_VALUE_FIELDS.has(field)) return value;
  return value.replace(LEGACY_VALUE, W.Member);
}
