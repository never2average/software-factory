/**
 * What a prefixed key looks like (mold_v0-323): one rule shared by the audit trail's masking (src/audit-request.ts) and
 * the audit key scan (src/audit-key-scan.ts), so what is masked when an entry is written and what the scan reports
 * cannot drift apart. Pure: no database, no server.
 *
 * A prefixed key is `<prefix>_` and at least 14 base64url characters (its "six", what a key list shows, and the rest).
 *   strict prefixes   the app's own secrets (oct_ workspace and member keys, adm_ admin tokens, hst_ agent tool tokens,
 *                     oma_/omr_/omc_ MCP sign-in tokens and codes, ocs_ OAuth client secrets, ogw_ gateway tokens,
 *                     orl_ run leases, owk_ worker tokens, ore_/orr_ on-premises runner tokens, whsec_ webhook secrets)
 *                     and the well-known ones (GitHub's, GitLab's): any value of that shape is a key.
 *   generic prefixes  words could start with these (sk_ developer keys, cs_ client sessions, pk_, rk_, re_, npm_, npg_,
 *                     app_, key_): a value counts only when what follows looks like a key (keyLike), so
 *                     "app_settings_dashboard" and "key_rotation_policy_2024" are kept as they are.
 */
export const ISSUED_PREFIXES = ["oct", "adm", "hst", "oma", "omr", "omc", "ocs", "ogw", "orl", "owk", "ore", "orr", "whsec"] as const;
export const KNOWN_PREFIXES = ["ghp", "gho", "ghs", "ghu", "ghr", "github_pat", "glpat"] as const;
export const GENERIC_PREFIXES = ["sk", "cs", "pk", "rk", "re", "npm", "npg", "app", "key"] as const;
const ALL = [...ISSUED_PREFIXES, ...KNOWN_PREFIXES, ...GENERIC_PREFIXES].sort((a, b) => b.length - a.length);
const GENERIC = new Set<string>(GENERIC_PREFIXES);

/** The body of the pattern: (prefix_)(six)(rest). */
const BODY = `((?:${ALL.join("|")})_)([A-Za-z0-9_-]{6})([A-Za-z0-9_-]{8,})`;
/** A whole value that is a prefixed key's shape (before keyLike). */
const WHOLE = new RegExp(`^${BODY}$`, "i");
/** Prefixed keys anywhere in a string (not glued to a word before them). A fresh RegExp each call: it is global. */
export const prefixedKeysIn = () => new RegExp(`(?<![A-Za-z0-9_-])${BODY}`, "gi");

/**
 * What follows a generic prefix looks like a key: 16 characters or more, letters with digits or with both cases, and
 * not a phrase (every part between _ and - one plain word: lower case, upper case, Capitalised, or digits).
 */
export function keyLike(rest: string): boolean {
  if (rest.length < 16) return false;
  if (!/[A-Za-z]/.test(rest) || !(/[0-9]/.test(rest) || (/[A-Z]/.test(rest) && /[a-z]/.test(rest)))) return false;
  return !rest.split(/[_-]/).every((p) => /^(?:[a-z]*|[A-Z]*|[A-Z][a-z]+|[0-9]+)$/.test(p));
}

/** A matched prefix (lower case, without its _) is a key's: strict always; generic only when what follows is keyLike. */
export function prefixedKeyOk(prefix: string, six: string, rest: string): boolean {
  const p = prefix.replace(/_$/, "").toLowerCase();
  if (p === "github_pat" && (six + rest).length < 40) return false;
  return !GENERIC.has(p) || keyLike(six + rest);
}

/** A whole value that is a prefixed key: its prefix (with _) and six, or null. */
export function prefixedKey(v: string): { prefix: string; six: string } | null {
  const m = WHOLE.exec(v);
  return m && prefixedKeyOk(m[1]!, m[2]!, m[3]!) ? { prefix: m[1]!, six: m[2]! } : null;
}
