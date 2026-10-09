/**
 * The deployment's words for the operator tooling's own output: `${W.Account} "acme" not found`.
 *
 * The same keys base text writes as placeholders (`{account}`, `{Deployments}`, `{member}`, `{owner}`) and
 * lib/ui-words.ts gives the UI, read from this build's profile. A script never spells a record or a role word.
 */
import { DEPLOYMENT_PROFILE } from "../../../lib/deployment-profile.generated.ts";
import { fillPlaceholders, placeholderWords } from "../../lib/profile-words.mjs";

export const W = Object.freeze(placeholderWords(DEPLOYMENT_PROFILE));
/** A whole text with placeholders, filled ("a {account}" reads "an account"). For text that embeds no data. */
export const say = (text) => fillPlaceholders(text, DEPLOYMENT_PROFILE);
