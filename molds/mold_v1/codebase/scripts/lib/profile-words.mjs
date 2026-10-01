/**
 * The role and record placeholders base text writes (`{member}`, `{owner}`, `{account}`, `{deployment}`,
 * `{implementation}`, `{rollout}`, each with its plural and capitalised forms), filled from a deployment profile.
 *
 * The plain-JavaScript twin of `fillWith` in agent/lib/agent-vocabulary.ts, for build scripts that hold a merged
 * profile as JSON and cannot import the generated TypeScript one (the base skill is mirrored into the generic
 * package from profiles/00-default.json, and into a deployment's package from its own profiles).
 * scripts/test-agent-vocabulary.mjs holds the two to the same output.
 */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) || /^[A-Z]$/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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
  return out;
}

/** Base text with every placeholder filled, and "a" / "an" before a filled word recomputed for it. */
export function fillPlaceholders(text, profile) {
  if (typeof text !== "string" || !text.includes("{")) return text;
  const words = placeholderWords(profile);
  const re = new RegExp(`(?:\\b([Aa])(n?)( |\\n[ \\t]*)(\\*\\*|\\*|_|\`|")?)?(?<!\\$)\\{(${Object.keys(words).join("|")})\\}`, "g");
  return text.replace(re, (_m, a, _n, gap, fmt, key) => {
    const w = words[key];
    if (!a) return w;
    const vowel = /^[aeiou]/i.test(w) && !/^(uni|use|usu|eu|one)/i.test(w);
    return `${a}${vowel ? "n" : ""}${gap}${fmt ?? ""}${w}`;
  });
}

/** Does this text still hold a placeholder? */
export const hasPlaceholder = (text) => /(?<!\$)\{(members?|Members?|owner|Owner|accounts?|Accounts?|deployments?|Deployments?|implementations?|Implementations?|rollouts?|Rollouts?)\}/.test(String(text));
