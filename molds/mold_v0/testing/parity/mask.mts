// What changes from one snapshot of the same build to the next and says nothing about the build: the time, the ports the
// lane world picked, the ids its offline Clerk and the database minted, keys and tokens. Each is replaced by a marker that
// keeps the field and the shape of the text (`<time>`, `<port>`, ...), never removed: a real field that changes is still
// a diff, and a field that appears or goes is too. Used by snapshot.mts on everything it records; diff.mts compares the
// masked records. One list, so a mask added for one surface (a page's text) applies to every other (an API answer).
//
// Rule of thumb when a determinism run shows a diff: mask the VALUE that is not the build's (a timestamp, an id), never
// drop the field or the page that carries it.

/** [pattern, marker] in order: the longer, more specific patterns first. */
export const TEXT_MASKS: [RegExp, string][] = [
  // ISO-8601 timestamps and dates (2026-10-24T14:17:49.123Z, 2026-10-24 14:17:49+00, 2026-10-24).
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?\b/g, "<date>"],
  // Loopback addresses with the port the lane world picked.
  [/\b(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\b/g, "$1:<port>"],
  // UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  // The offline Clerk's and Stripe-style ids: user_2abc..., org_..., sess_..., inv_..., orginv_...
  // (a run of 8+ letters and digits with at least one digit: `org_settings` is a word, `org_2x9Lk...` an id).
  [/\b(user|org|sess|inv|orginv|orgmem|client|sk_test|pk_test|whsec|cus|sub|price|prod|in|pi|cs)_(?=[A-Za-z]*\d)[A-Za-z0-9]{8,}\b/g, "$1_<id>"],
  // API keys, member keys, admin tokens and other prefixed secrets the build mints (oct_..., app_..., wsk_...).
  // With a digit in it: a tool's name (list_developer_profiles) is words, a key is not.
  [/\b([a-z]{2,10})_(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}\b/g, "$1_<key>"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<jwt>"],
  // A key shown cut short (`oct_79_3IT…`, the keys page): its namespace is the build's, the rest is not.
  [/\b([a-z]{2,10})_[A-Za-z0-9_-]{3,16}…/g, "$1_<key>…"],
  // Long hex (hashes, random tokens) and long base64url runs with digits.
  [/\b[0-9a-f]{24,}\b/gi, "<hex>"],
  // Dates people read: Oct 24, 2026 / 24 Oct 2026 / October 24 / 24/10/2026 / 10/24/2026.
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:, \d{4})?\b/g, "<date>"],
  [/\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?: \d{4})?\b/g, "<date>"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<date>"],
  // Month and year alone (a billing period): October 2026.
  [/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g, "<month>"],
  // Weekdays (a "today is" line).
  [/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, "<weekday>"],
  // Clock times: 14:17, 14:17:49, 2:17 PM.
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?\b/g, "<clock>"],
  // Relative times: 5 minutes ago, in 3 days, just now, a few seconds ago, 4m ago, 2h.
  [/\b(?:just now|a few seconds ago|less than a minute ago)\b/gi, "<ago>"],
  // Only with "ago": "keys expire after 30 days" is the build's own words.
  [/\b(?:about |over |almost )?(?:an?|\d+) (?:second|minute|hour|day|week|month|year)s? ago\b/gi, "<ago>"],
  [/\b\d+\s?(?:s|m|h|d|ms) ago\b/g, "<ago>"],
  // The year alone in a footer (© 2026).
  [/©\s?\d{4}\b/g, "© <year>"],
];

/** Base64 of a JSON document (`config=eyJ1cmwiOi...` in an install link) is decoded, masked and shown as `b64(<json>)`, so
 * the port inside it is masked like any other and the rest still compares. */
const B64_JSON = /\beyJ[A-Za-z0-9+/_-]{8,}={0,2}/g;

export function maskText(s: string): string {
  let out = s.replace(B64_JSON, (m) => {
    if (/^eyJ[^.]*\.[^.]+\./.test(m)) return m;   // a JWT: masked below
    try {
      const txt = Buffer.from(m.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      JSON.parse(txt);
      return `b64(${maskText(txt)})`;
    } catch { return m; }
  });
  for (const [re, to] of TEXT_MASKS) out = out.replace(re, to);
  return out;
}

/** The masks as [source, flags, replacement], for a page's own text nodes (snapshot.mts masks the DOM before it reads the
 * text and takes its screenshots, so a time or a port shows the same pixels every run). */
export const TEXT_MASK_SOURCES = TEXT_MASKS.map(([re, to]) => [re.source, re.flags, to] as const);

/** Keys whose value is a time (epoch seconds or milliseconds, or a date string) or a measured duration, never a property of
 * the build. Case-sensitive on purpose: `format` and `items` are not times. */
const TIME_KEY = /(^|_)(at|time|ts|timestamp|date|since|until|expires|ms|elapsed|elapsed_days|elapsed_hours|uptime|seconds_ago|last_seen|now)$|[a-z](At|Ms|Time|Date)$/;
/** Keys whose value shows the start of a minted key or token (`oct_GY4Mf7`): its namespace is the build's, the rest is not. */
const KEY_SHOWN = /(^|_)(key_prefix|prefix|hint|last4|preview)$|[a-z](Prefix|Hint)$/;

/**
 * Mask a JSON value: every string (and key) through maskText, a value that is a time by its key (`*_at`, `*Ms`, ...)
 * to "<time>", and the shown start of a minted key (`key_prefix: "oct_GY4Mf7"`) to its namespace (`oct_<key>`). Ids are left alone: the lane world makes the same rows in the same order every run, so a database id
 * that changes is a real change; a random one (Clerk's, a key) is caught by its text. Keys are kept, and so is every
 * array's length and order.
 */
export function maskJson(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (TIME_KEY.test(key) && v) return "<time>";
    if (KEY_SHOWN.test(key) && /^[a-z]{2,10}_\S{3,}$/.test(v)) return `${v.slice(0, v.indexOf("_"))}_<key>`;
    return maskText(v);
  }
  if (typeof v === "number") {
    if (TIME_KEY.test(key)) return "<time>";
    // An epoch timestamp in milliseconds under any key (2001..2103).
    if (Number.isInteger(v) && v > 1e12 && v < 4.2e12) return "<time>";
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => maskJson(x, key));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[maskText(k)] = maskJson((v as Record<string, unknown>)[k], k);
    return out;
  }
  return v;
}

/** JSON with sorted keys and two-space indentation, so a file diff shows the field that moved. */
export const stable = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
