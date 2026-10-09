/**
 * What the stored-path census (dataroom-path-census.mjs) replaces before it is compared with a before-image:
 * generated ids, timestamps and dates, which are the same on no two runs and never part of where a file is stored.
 *
 * Its own module so it can be tested with ids no run can be asked to produce. The ids are `PREFIX-${nanoid(10)}`
 * (agent/lib/syncs.ts, agent/lib/tools.ts), and nanoid's alphabet is A-Za-z0-9 plus "_" and "-". The expression
 * used to end in `\b`, which does not hold after an id whose last character is "-" (a "-" followed by a quote is
 * no word boundary), so about one id in 64 was left as it was and the census differed from its before-image:
 * test:dataroom-folders failed at random ("INT-76chYeL52-", CI run 37207524888 attempt 2). An id now ends where
 * its ten characters end: at a word boundary, or after a final "-". Everything the old expression matched still
 * matches, so no before-image changes.
 */
export const GENERATED_ID = /\b(SYNC|INT|TCK|CS)-[A-Za-z0-9_-]{10}(?:\b|(?<=-))/g;

/** A JSON text with every generated id, timestamp, date and uuid replaced by a placeholder. */
export const maskText = (json) =>
  json
    .replace(GENERATED_ID, "$1-<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<timestamp>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");

/** The same for a value. */
export const mask = (value) => JSON.parse(maskText(JSON.stringify(value)));
