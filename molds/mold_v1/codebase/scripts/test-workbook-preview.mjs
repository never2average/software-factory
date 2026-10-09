#!/usr/bin/env node
/**
 * THE DATA ROOM'S WORKBOOK PREVIEW: THE TEXT CUT AND THE CAP BANNER (follow-ups from #62, mold_v1-124).
 *
 *   1. The text cut splits no character. GET /api/ops/workbook cut long text with value.slice(0, 500), on UTF-16
 *      code units: an emoji at the boundary lost half its surrogate pair (a replacement box in the cell, and a lone
 *      surrogate in the JSON), a family emoji lost members, a flag became a regional letter. lib/workbook-fields.ts
 *      cutText counts grapheme clusters (Intl.Segmenter).
 *   2. The cap banner says the order the rows were kept in. It said "most recent first" on every sheet, including
 *      the accounts (kept in name order) and the implementation (in id order). The route now sends each table's
 *      `order`, and the banner says it.
 *   3. The route orders free-text date columns by the date they say (dateSortKeySql), never as strings: asserted
 *      here as wiring; its SQL is run against Postgres by scripts/test-workbook-route-db.mjs.
 *
 * No database, no build. Run: npm run test:workbook-preview
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const { cutText, CUT_CODE_UNIT_CEILING, TEXT_PREVIEW_CHARS, WORKBOOK_ORDER, WORKBOOK_TABLES, orderPhrase } = await import("../lib/workbook-fields.ts");

let passed = 0;
const check = (label, fn) => {
  fn();
  passed++;
  console.log(`  ok   ${label}`);
};
const loneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const count = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

console.log("1. the cut splits no character");
const N = TEXT_PREVIEW_CHARS;
for (const [what, unit] of [
  ["an emoji (a surrogate pair)", "😀"],
  ["a family emoji (seven code points)", "👨‍👩‍👧‍👦"],
  ["a flag (two regional indicators)", "🇮🇳"],
  ["an accented letter written as two code points", "é"],
  ["a skin-toned thumbs up", "👍🏽"],
]) {
  check(`${what} at the boundary is kept whole or left out whole`, () => {
    // One ASCII character short of the cap, then the unit: the old slice cut straight through it.
    const text = "a".repeat(N - 1) + unit.repeat(3) + " and more text after it";
    const out = cutText(text);
    assert.ok(out !== null, "text over the cap is cut");
    assert.ok(!loneSurrogate(out), "no lone surrogate half");
    assert.equal(count(out), N, `${N} characters as a person counts them`);
    assert.ok(out.endsWith(unit), "the last character is the whole unit");
    const old = text.slice(0, N);
  });
}
check("text of exactly the cap, and under it, is not cut", () => {
  assert.equal(cutText("x".repeat(N)), null);
  assert.equal(cutText("😀".repeat(N)), null, `${N} emoji are ${N} characters, though ${2 * N} code units`);
  assert.equal(cutText(""), null);
});
check("text one character over the cap is cut to the cap", () => {
  assert.equal(cutText("😀".repeat(N + 1)), "😀".repeat(N));
  assert.equal(cutText("b".repeat(N + 1)), "b".repeat(N));
});
check("a long note of ordinary text is cut exactly as before", () => {
  const text = "L".repeat(5000);
  assert.equal(cutText(text), text.slice(0, N));
});
check("one character of 2,000,001 code units (a letter and 2M combining marks) is still cut, by the code-unit backstop", () => {
  // Review of #76: a grapheme has no length limit, so counting graphemes alone sent the whole 2 MB.
  const text = "a" + "\u0301".repeat(2_000_000);
  const out = cutText(text);
  assert.ok(out !== null && out.length <= CUT_CODE_UNIT_CEILING, `cut to ${out?.length} code units`);
  assert.ok(!loneSurrogate(cutText("a" + "😀".repeat(CUT_CODE_UNIT_CEILING))), "the backstop never splits a surrogate pair");
});
check("the old cut really did split them (what this guards)", () => {
  const text = "a".repeat(N - 1) + "😀";
  assert.ok(loneSurrogate(text.slice(0, N)));
  assert.ok(!loneSurrogate(cutText(text + "tail")));
});

console.log("\n2. the cap banner says the order the rows were kept in");
check("every table has an order, and only the dated ones are 'most recent first'", () => {
  assert.deepEqual(Object.keys(WORKBOOK_ORDER).sort(), [...WORKBOOK_TABLES].sort());
  assert.equal(orderPhrase(WORKBOOK_ORDER.interactions), "most recent first");
  assert.equal(orderPhrase(WORKBOOK_ORDER.customers), "in name order");
  assert.equal(orderPhrase(WORKBOOK_ORDER.implementation), "in id order");
  assert.equal(orderPhrase(WORKBOOK_ORDER.platform), "in id order");
  assert.equal(orderPhrase(undefined), "in id order", "an answer without an order never claims recency");
});
const route = readFileSync(`${ROOT}app/api/ops/workbook/route.ts`, "utf8");
const dataroom = readFileSync(`${ROOT}app/_components/dataroom.tsx`, "utf8");
check("the route sends each table's order with its cap", () => {
  assert.match(route, /order: WORKBOOK_ORDER\[table\]/);
});
check("the banner says the table's order, never a fixed 'most recent first'", () => {
  assert.match(dataroom, /orderPhrase\(sheetCapped\.order\)/);
  const banner = dataroom.slice(dataroom.indexOf('data-testid="dataroom-truncated"'), dataroom.indexOf("</p>", dataroom.indexOf('data-testid="dataroom-truncated"')));
  assert.doesNotMatch(banner, /most recent first/);
});

console.log("\n3. the route cuts on characters and reads free-text dates as dates");
check("the route's cut is cutText, not a UTF-16 slice", () => {
  assert.match(route, /cutText\(value\)/);
  assert.doesNotMatch(route, /\.slice\(0, TEXT_PREVIEW_CHARS\)/);
});
check("every table kept most-recent-first is ordered by dateSortKeySql over its date column", () => {
  const columns = { deployments: "last_deploy_at", solutions: "last_reviewed_date", tickets: "last_activity_date", interactions: "interaction_at", internal_staff: "last_contact", customer_stakeholders: "last_contact" };
  for (const [table, order] of Object.entries(WORKBOOK_ORDER)) {
    if (order !== "recent") continue;
    assert.ok(columns[table], `${table} has a date column here`);
    assert.ok(route.includes(`newest(\`"${table}"."${columns[table]}"\`)`), `${table} is ordered by the date its ${columns[table]} says`);
  }
  assert.match(route, /dateSortKeySql\(column\)/);
});

console.log(`\nworkbook preview: ${passed} check(s) passed`);
