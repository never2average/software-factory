/**
 * The deployment profile, as the model reads it.
 *
 * The static prompt was written for one use of the product (a forward-deployed engineering team managing
 * customers). A deployment that uses it for something else says so in profiles/*.json; this renders that as a
 * short per-turn block. It states vocabulary as a READING RULE — tool names, fields and data-room paths keep
 * their identifiers (`list_customers`, `customer_id`, `Customers/`), so the model must map the words, not
 * rename the things.
 *
 * Returns null when the profile is the default one: the default deployment's prompt is unchanged.
 */
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";

const DEFAULT_ACCOUNT = "customer";
const DEFAULT_MEMBER = "FDE";

export function renderDeploymentBriefing(profile = DEPLOYMENT_PROFILE): string | null {
  const { vocabulary: v, dataroom, agent } = profile;
  const lines: string[] = [];
  if (v.account.singular !== DEFAULT_ACCOUNT) {
    lines.push(
      `- In this deployment a "customer" is called a **${v.account.singular}** (plural: ${v.account.plural}). Say "${v.account.singular}" to people. The identifiers do not change: tools such as \`list_customers\` and \`get_customer\`, the \`customer_id\` field and the \`Customers/\` data-room folder all refer to ${v.account.plural}.`,
    );
  }
  if (v.member.singular !== DEFAULT_MEMBER) {
    lines.push(
      `- The people you work for are **${v.member.plural}**, not FDEs. Where your instructions say "FDE" or "FDE owner", read "${v.member.singular}" and "${v.owner}".`,
    );
  }
  const hidden = Object.entries(dataroom.domains).filter(([, d]) => !d.visible).map(([k]) => k);
  if (hidden.length > 0) {
    lines.push(
      `- This deployment does not use these parts of the product: ${hidden.join(", ")}. Do not offer, plan or write work under them, and ignore the sections of your instructions that are only about them, unless a person explicitly asks.`,
    );
  }
  const relabelled = Object.entries(dataroom.domains).filter(([k, d]) => d.visible && d.label !== k);
  if (relabelled.length > 0) {
    lines.push(`- People see these data-room folders under other names: ${relabelled.map(([k, d]) => `\`${k}/\` is shown as "${d.label}"`).join("; ")}. Paths you read and write keep the folder's real name.`);
  }
  const body = [lines.join("\n"), agent.briefing?.trim() ?? ""].filter(Boolean).join("\n\n");
  return body ? `## This deployment\n\n${body}` : null;
}
