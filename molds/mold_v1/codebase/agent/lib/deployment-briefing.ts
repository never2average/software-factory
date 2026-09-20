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
import { DEFAULT_DOMAINS, DEPLOYMENT_PROFILE, type CustomFieldSpec, type DeploymentProfile, type DomainArea } from "./deployment-profile.generated.ts";

const DEFAULT_ACCOUNT = "customer";
const DEFAULT_MEMBER = "FDE";

/**
 * The identifiers of each redefinable area: what the static prompt calls it, the record key on a customer, the
 * data-room folder, its id field and the TODO container type. Reads go through `get_customer`, writes through
 * `upsert_customer` (agent/lib/tools.ts): neither tool, nor any field, is renamed by a profile.
 */
const AREA_IDENTIFIERS: Record<DomainArea, { was: string; record: string; folder: string; id: string; container: string }> = {
  deployments: { was: "deployment", record: "deployments[]", folder: "Deployments/", id: "deploymentId", container: "deployment" },
  implementations: { was: "implementation", record: "implementation", folder: "Implementation/", id: "rolloutId", container: "implementation" },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * One redefined area, tersely: what it MEANS here, how its fields and enum values are shown to people, what is
 * not used (and what to write there anyway), and that the identifiers stay. Nothing for an area left at default.
 */
export function renderDomainBriefing(area: DomainArea, domains: DeploymentProfile["domains"]): string[] {
  const spec = domains[area];
  const def = DEFAULT_DOMAINS[area];
  if (same(spec, def)) return [];
  const ids = AREA_IDENTIFIERS[area];
  const fields = Object.entries(spec.fields);
  const lines: string[] = [];
  const an = /^[aeiou]/i.test(ids.was) ? "an" : "a";
  // Words that only differ in case or punctuation from the identifier teach the model nothing: leave them out.
  const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  lines.push(
    `- ${!same(spec.label, def.label) ? `${an[0].toUpperCase()}${an.slice(1)} "${ids.was}" is a **${spec.label.singular}** here (plural: ${spec.label.plural})` : `${spec.label.plural} mean something specific here`}: ${spec.description} Identifiers stay: read with \`get_customer\` (\`${ids.record}\`), write with \`upsert_customer\`, files under \`${ids.folder}\`, TODO containerType \`${ids.container}\`, \`${ids.id}\` shown as "${spec.id_label}". People say the display words below; you store the values.`,
  );
  const group = "group_by" in spec ? (spec as DeploymentProfile["domains"]["implementations"]) : null;
  if (group?.group_by) {
    lines.push(`  - A **${group.group_label.singular}** (plural: ${group.group_label.plural}) is the set of \`${ids.record}\` rows sharing one \`${group.group_by}\` slug, e.g. \`large-caps\`. One row per customer id, so each is in one ${group.group_label.singular.toLowerCase()} at a time.`);
  }
  if (spec.kind_field) lines.push(`  - \`${spec.kind_field}\` carries the ${spec.fields[spec.kind_field]?.label ?? "kind"}: ${spec.kinds.join("; ")}.`);
  const labelled = fields.filter(([k, f]) => !f.hidden && f.label && f.label !== def.fields[k]?.label && k !== spec.kind_field && k !== group?.group_by && plain(f.label) !== plain(k));
  if (labelled.length) lines.push(`  - Fields: ${labelled.map(([k, f]) => `\`${k}\`="${f.label}"`).join(", ")}.`);
  for (const [k, f] of fields) {
    if (f.hidden || !f.options || same(f.options, def.fields[k]?.options)) continue;
    const changed = Object.entries(f.options).filter(([value, label]) => plain(value) !== plain(label));
    if (changed.length) lines.push(`  - \`${k}\`: ${changed.map(([value, label]) => `"${label}" is ${value}`).join(", ")}.`);
  }
  // The deployment's OWN fields: not columns, so the model has to be told where they go and what each accepts.
  if (spec.custom_fields.length) {
    const at = area === "deployments" ? "deployments[].custom" : "implementation.custom";
    // Terse on purpose (this is paid for on every turn): `key`="Label" (type or choices; required).
    const brief = (f: CustomFieldSpec) => `\`${f.key}\`="${f.label}" (${f.type === "pick_list" ? (f.options ?? []).join("|") : f.type === "date" ? "yyyy-mm-dd" : f.type === "percent" ? "percent 0-100" : f.type === "link" ? "http(s)-link" : f.type}${f.required ? "; required" : ""})`;
    lines.push(`  - Own fields, by key in \`${at}\` (send only changed keys; null clears; other keys are refused): ${spec.custom_fields.map(brief).join(", ")}.`);
  }
  const hidden = fields.filter(([, f]) => f.hidden);
  if (hidden.length) {
    const fixed = hidden.filter(([, f]) => f.fixed !== undefined);
    const free = hidden.filter(([, f]) => f.fixed === undefined).map(([k]) => k);
    // A long list is paid for on every turn; past a handful, the rule is shorter than the names.
    const unused = free.length > 8 ? `${free.slice(0, 4).join(", ")} and ${free.length - 4} more: use only the fields named above, never ask about or report another \`${ids.record}\` field` : `never ask about or report ${free.join(", ")}`;
    lines.push(`  - Not used here: ${free.length ? unused : "the fixed fields"}.${fixed.length ? ` When you write a record, set ${fixed.map(([k, f]) => `\`${k}\`=${JSON.stringify(f.fixed)}`).join(" and ")}.` : ""}`);
  }
  return lines;
}

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
  for (const area of ["implementations", "deployments"] as const) lines.push(...renderDomainBriefing(area, profile.domains));
  const body = [lines.join("\n"), agent.briefing?.trim() ?? ""].filter(Boolean).join("\n\n");
  return body ? `## This deployment\n\n${body}` : null;
}
