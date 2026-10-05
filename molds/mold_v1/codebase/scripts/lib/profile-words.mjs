/**
 * The role and record placeholders base text writes (`{member}`, `{owner}`, `{account}`, `{deployment}`,
 * `{implementation}`, `{rollout}`, each with its plural and capitalised forms), filled from a deployment profile,
 * and the data-room ones (`{folder:accounts}`: the domain's folder as this deployment's reader addresses it;
 * `{domain:accounts}`: the domain in a sentence, its label).
 *
 * The plain-JavaScript twin of `fillWith` in agent/lib/agent-vocabulary.ts, for build scripts that hold a merged
 * profile as JSON and cannot import the generated TypeScript one (the base skill is mirrored into the generic
 * package from profiles/00-default.json, and into a deployment's package from its own profiles).
 * scripts/test-agent-vocabulary.mjs holds the two to the same output.
 */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) || /^[A-Z]$/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A label as a folder name ("Coverage reports" -> "Coverage-reports"): folderNameFor in agent/lib/agent-vocabulary.ts. */
const folderNameFor = (label) => label.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");

/** `folder:<id>` / `domain:<id>` -> the folder a reader addresses and the label a reader reads, for every domain. */
export function folderWords(profile) {
  const out = { "folder:uploads": profile.dataroom.uploads_folder, "domain:uploads": profile.dataroom.uploads_folder };
  for (const [id, d] of Object.entries(profile.dataroom.domains)) {
    const label = d.label || d.folder;
    out[`folder:${id}`] = label === d.folder ? d.folder : folderNameFor(label) || d.folder;
    out[`domain:${id}`] = label;
  }
  return out;
}

/** Every top-level data-room folder's STORED name under a profile, by id: foldersOf in agent/lib/dataroom-folders.ts. */
export function storedFolders(profile) {
  return { ...Object.fromEntries(Object.entries(profile.dataroom.domains).map(([id, d]) => [id, d.folder])), uploads: profile.dataroom.uploads_folder };
}

/** placeholder key -> the profile's word for it. */
export function placeholderWords(profile) {
  const pairs = {
    member: profile.vocabulary.member,
    account: profile.vocabulary.account,
    deployment: profile.domains.deployments.label,
    implementation: profile.domains.implementations.label,
    rollout: profile.domains.implementations.group_label,
  };
  const out = { owner: lowerFirst(profile.vocabulary.owner), Owner: upperFirst(profile.vocabulary.owner) };
  for (const [key, pair] of Object.entries(pairs)) {
    out[key] = lowerFirst(pair.singular);
    out[`${key}s`] = lowerFirst(pair.plural);
    out[upperFirst(key)] = upperFirst(pair.singular);
    out[`${upperFirst(key)}s`] = upperFirst(pair.plural);
  }
  // The period words (agent/lib/work-periods.ts periodWordOf): the profile's word as it is written, or capitalised.
  const wp = profile.work_periods;
  if (wp) {
    for (const [key, pair] of [["period", wp.label], ["period_item", wp.item_label]]) {
      out[key] = pair.singular;
      out[`${key}s`] = pair.plural;
      out[upperFirst(key)] = upperFirst(pair.singular);
      out[`${upperFirst(key)}s`] = upperFirst(pair.plural);
    }
  }
  return out;
}

/** Base text with every placeholder filled, and "a" / "an" before a filled word recomputed for it. */
export function fillPlaceholders(text, profile) {
  if (typeof text !== "string" || !text.includes("{")) return text;
  const words = { ...placeholderWords(profile), ...folderWords(profile) };
  const re = new RegExp(`(?:\\b([Aa])(n?)( |\\n[ \\t]*)(\\*\\*|\\*|_|\`|")?)?(?<!\\$)\\{(${Object.keys(words).join("|")})\\}`, "g");
  return text.replace(re, (_m, a, _n, gap, fmt, key) => {
    const w = words[key];
    if (!a) return w;
    const vowel = /^[aeiou]/i.test(w) && !/^(uni|use|usu|eu|one)/i.test(w);
    return `${a}${vowel ? "n" : ""}${gap}${fmt ?? ""}${w}`;
  });
}

/** Does this text still hold a placeholder? */
export const hasPlaceholder = (text) => /(?<!\$)\{(members?|Members?|owner|Owner|accounts?|Accounts?|deployments?|Deployments?|implementations?|Implementations?|rollouts?|Rollouts?|period_items?|Period_items?|periods?|Periods?|(?:folder|domain):[a-z]+)\}/.test(String(text));
