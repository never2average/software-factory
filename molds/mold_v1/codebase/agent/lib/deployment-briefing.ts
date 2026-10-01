/**
 * The deployment profile, as the model reads it.
 *
 * The base prompt was written for one use of the product (a delivery team managing
 * customers). A deployment that uses it for something else says so in profiles/*.json; this renders that as a
 * short per-turn block.
 *
 * When the profile RELABELS the domains (agent/lib/agent-vocabulary.ts), the model already reads every tool,
 * field and folder in the profile's words — `list_companies`, `company_id`, `Companies/` — so this block states
 * those words and nothing else: it never names the base product's (`list_customers`, "customer", `Customers/`),
 * which only taught the model a second vocabulary to reason in. Everything it says is written with the base
 * identifiers and then spoken through the same translation the tools use, so the two cannot disagree.
 *
 * When the profile only hides domains or redefines fields without renaming anything, the identifiers ARE the
 * base ones, and the block says so as before.
 *
 * Returns null when the profile is the default one: the default deployment's prompt is unchanged.
 */
import { DEFAULT_DOMAINS, DEPLOYMENT_PROFILE, type CustomFieldSpec, type DeploymentProfile, type DomainArea } from "./deployment-profile.generated.ts";
import { createVocabulary, speakCodeWith, speakWith, verbatimWith, VOCABULARY, type Vocabulary, type VocabularyProfile } from "./agent-vocabulary.ts";

const DEFAULT_ACCOUNT = "customer";
/** The member's words in the default profile: the base text's role placeholders are filled with these. */
const DEFAULT_MEMBER = "member";

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
 * One own field, terse on purpose (this is paid for on every turn): `key`="Label" (type or choices; required).
 * Keys, labels and choices are the profile's own and are stored as written: never translated (`own` marks them
 * verbatim under a relabel).
 */
function briefCustomField(f: CustomFieldSpec, own: (t: string) => string): string {
  return `\`${own(f.key)}\`="${own(f.label)}" (${f.type === "pick_list" ? own((f.options ?? []).join("|")) : f.type === "date" ? "yyyy-mm-dd" : f.type === "percent" ? "percent 0-100" : f.type === "link" ? "http(s)-link" : f.type}${f.required ? "; required" : ""})`;
}

/**
 * The account record's OWN fields (`account_fields.custom_fields`): where they live on the record the model reads
 * and writes, and what each accepts. Nothing when the profile declares none. Written with base identifiers, like
 * everything here; the relabelled block is spoken as a whole.
 */
export function renderAccountFieldsBriefing(profile: Pick<DeploymentProfile, "account_fields" | "vocabulary">, v?: Vocabulary): string[] {
  const fields = profile.account_fields?.custom_fields ?? [];
  if (!fields.length) return [];
  const own = (t: string) => (v?.relabelled ? verbatimWith(v, t) : t);
  const listed = fields.filter((f) => f.show_in_list).map((f) => `\`${own(f.key)}\``);
  const account = own(profile.vocabulary.account.singular);
  return [
    `- Own fields of each ${account}, by key in its \`custom\` (read with \`get_customer\`, write with \`upsert_customer\`; send only changed keys; null clears; other keys are refused; ${fields.some((f) => f.type === "long_text") ? "add to a long text with \`custom_append\` instead of resending it (replace one: null in \`custom\` plus the new text in \`custom_append\`); " : ""}\`list_customers\` carries ${listed.length ? `only ${listed.join(", ")}` : "none of them"}): ${fields.map((f) => briefCustomField(f, own)).join(", ")}.`,
  ];
}

/**
 * One redefined area, tersely: what it MEANS here, how its fields and enum values are shown to people, what is
 * not used (and what to write there anyway), and that the identifiers stay. Nothing for an area left at default.
 */
export function renderDomainBriefing(area: DomainArea, domains: DeploymentProfile["domains"], v?: Vocabulary): string[] {
  const relabelled = Boolean(v?.relabelled);
  const spec = domains[area];
  const def = DEFAULT_DOMAINS[area];
  if (same(spec, def)) return [];
  const ids = AREA_IDENTIFIERS[area];
  const fields = Object.entries(spec.fields);
  const lines: string[] = [];
  const an = /^[aeiou]/i.test(ids.was) ? "an" : "a";
  // Words that only differ in case or punctuation from the identifier teach the model nothing: leave them out.
  const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  // The profile's own words (labels, descriptions, kinds, choices, custom-field keys) are already the deployment's:
  // under a relabel they are marked verbatim so the spoken block keeps them exactly as the profile spells them.
  const own = (t: string) => (relabelled && v ? verbatimWith(v, t) : t);
  if (relabelled) {
    // Written in base identifiers, spoken by renderDeploymentBriefing: `get_customer` reaches the model as the
    // tool it is actually given, `deployments[]` as the key its results carry.
    lines.push(
      `- **${own(spec.label.plural)}** (singular: ${own(spec.label.singular)}): ${own(spec.description)} Read them in \`get_customer\` (\`${ids.record}\`), write them with \`upsert_customer\`; files under \`${ids.folder}\`; TODO containerType \`${v ? speakCodeWith(v, ids.container) : ids.container}\`; \`${ids.id}\` is shown as "${own(spec.id_label)}". People say the display words below; you store the values.`,
    );
  } else {
    lines.push(
      `- ${!same(spec.label, def.label) ? `${an[0].toUpperCase()}${an.slice(1)} "${ids.was}" is a **${spec.label.singular}** here (plural: ${spec.label.plural})` : `${spec.label.plural} mean something specific here`}: ${spec.description} Identifiers stay: read with \`get_customer\` (\`${ids.record}\`), write with \`upsert_customer\`, files under \`${ids.folder}\`, TODO containerType \`${ids.container}\`, \`${ids.id}\` shown as "${spec.id_label}". People say the display words below; you store the values.`,
    );
  }
  const group = "group_by" in spec ? (spec as DeploymentProfile["domains"]["implementations"]) : null;
  if (group?.group_by) {
    lines.push(`  - A **${own(group.group_label.singular)}** (plural: ${own(group.group_label.plural)}) is the set of \`${ids.record}\` rows sharing one \`${group.group_by}\` slug, e.g. \`large-caps\`. One row per customer id, so each is in one ${own(group.group_label.singular.toLowerCase())} at a time.`);
  }
  if (spec.kind_field) lines.push(`  - \`${spec.kind_field}\` carries the ${own(spec.fields[spec.kind_field]?.label ?? "kind")}: ${spec.kinds.map(own).join("; ")}.`);
  const labelled = fields.filter(([k, f]) => !f.hidden && f.label && f.label !== def.fields[k]?.label && k !== spec.kind_field && k !== group?.group_by && plain(f.label) !== plain(k));
  if (labelled.length) lines.push(`  - Fields: ${labelled.map(([k, f]) => `\`${k}\`="${own(f.label!)}"`).join(", ")}.`);
  for (const [k, f] of fields) {
    if (f.hidden || !f.options || same(f.options, def.fields[k]?.options)) continue;
    // A stored value is named the way the model's tools give it (`Customer` reaches it as `Company`).
    const told = (value: string) => (relabelled && v ? speakCodeWith(v, value) : value);
    const changed = Object.entries(f.options).filter(([value, label]) => plain(told(value)) !== plain(label));
    if (changed.length) lines.push(`  - \`${k}\`: ${changed.map(([value, label]) => `"${own(label)}" is ${relabelled ? `\`${value}\`` : value}`).join(", ")}.`);
  }
  // The deployment's OWN fields: not columns, so the model has to be told where they go and what each accepts.
  if (spec.custom_fields.length) {
    const at = area === "deployments" ? "deployments[].custom" : "implementation.custom";
    lines.push(`  - Own fields, by key in \`${at}\` (send only changed keys; null clears; other keys are refused): ${spec.custom_fields.map((f) => briefCustomField(f, own)).join(", ")}.`);
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
  const v = profile === DEPLOYMENT_PROFILE ? VOCABULARY : createVocabulary(profile as VocabularyProfile);
  if (v.relabelled) return renderRelabelledBriefing(profile, v);
  const { vocabulary: voc, dataroom, agent } = profile;
  const lines: string[] = [];
  if (voc.account.singular !== DEFAULT_ACCOUNT) {
    lines.push(
      `- In this deployment a "customer" is called a **${voc.account.singular}** (plural: ${voc.account.plural}). Say "${voc.account.singular}" to people. The identifiers do not change: tools such as \`list_customers\` and \`get_customer\`, the \`customer_id\` field and the \`Customers/\` data-room folder all refer to ${voc.account.plural}.`,
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
  lines.push(...renderAccountFieldsBriefing(profile));
  for (const area of ["implementations", "deployments"] as const) lines.push(...renderDomainBriefing(area, profile.domains));
  const body = [lines.join("\n"), agent.briefing?.trim() ?? ""].filter(Boolean).join("\n\n");
  return body ? `## This deployment\n\n${body}` : null;
}

/**
 * The block for a profile that renames things: the deployment's words only. Composed with the base identifiers
 * and spoken as a whole (speakWith), so each name is the one the model's tools, results and folders use.
 */
function renderRelabelledBriefing(profile: DeploymentProfile, v: Vocabulary): string {
  const { vocabulary: voc, dataroom, agent } = profile;
  const own = (t: string) => verbatimWith(v, t);
  const lines: string[] = [];
  if (voc.account.singular.trim().toLowerCase() !== DEFAULT_ACCOUNT) {
    lines.push(
      `- Each record you keep is a **${own(voc.account.singular)}** (plural: ${own(voc.account.plural)}). Your tools, their fields and the data room use the same word: \`list_customers\`, \`get_customer\`, \`customer_id\`, \`Customers/\`.`,
    );
  }
  if (voc.member.singular.toLowerCase() !== DEFAULT_MEMBER) {
    lines.push(`- The people you work for are **${own(voc.member.plural)}**; the one responsible for a ${own(voc.account.singular)} is its **${own(voc.owner)}**.`);
  }
  const hidden = Object.entries(dataroom.domains).filter(([, d]) => !d.visible).map(([k]) => k);
  if (hidden.length > 0) {
    lines.push(
      `- This workspace does not use these parts of the product: ${hidden.join(", ")}. Do not offer, plan or write work under them, and ignore the sections of your instructions that are only about them, unless a person explicitly asks.`,
    );
  }
  const folders = Object.entries(dataroom.domains).filter(([k, d]) => d.visible && d.label !== k);
  if (folders.length > 0) {
    lines.push(`- Data-room folders by name: ${folders.map(([k, d]) => `\`${k}/\` holds ${own(d.label)}`).join("; ")}. Read and write them by exactly these paths.`);
  }
  lines.push(...renderAccountFieldsBriefing(profile, v));
  for (const area of ["implementations", "deployments"] as const) lines.push(...renderDomainBriefing(area, profile.domains, v));
  // agent.briefing is the profile's own text, in its own words: passed verbatim.
  const body = [lines.join("\n"), agent.briefing?.trim() ? own(agent.briefing.trim()) : ""].filter(Boolean).join("\n\n");
  return speakWith(v, `## This workspace\n\n${body}`);
}
