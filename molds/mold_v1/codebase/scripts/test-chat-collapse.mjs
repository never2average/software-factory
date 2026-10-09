/**
 * When a sent message folds (lib/chat-collapse). The real module, executed.
 * The rendered behaviour is checked in a browser by tests/user-message.spec.ts.
 *
 * Run:  npm run test:chat-collapse
 */
import assert from "node:assert/strict";
import { exceedsFold, foldHeight, lineHeightPx } from "../lib/chat-collapse.ts";
import { DEPLOYMENT_PROFILE } from "../lib/deployment-profile.generated.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const LH = 20;
const { collapse, collapsed_lines: lines } = DEPLOYMENT_PROFILE.chat.user_messages;

check("today's product default: fold, to six lines", collapse === true && lines === 6);
check("a one-line message is untouched", !exceedsFold(LH, LH, lines));
check("exactly the fold is untouched", !exceedsFold(LH * lines, LH, lines));
check("one or two lines over is NOT worth a button", !exceedsFold(LH * (lines + 2), LH, lines));
check("three lines over folds", exceedsFold(LH * (lines + 3), LH, lines));
check("a pasted filing folds", exceedsFold(4000, LH, lines));
check("folds to lines × line-height", foldHeight(LH, lines) === 120);
check("unmeasured content never folds", !exceedsFold(0, LH, lines) && !exceedsFold(500, 0, lines) && !exceedsFold(Number.NaN, LH, lines));
check("px line-height is used as is", lineHeightPx("22.75px", "14px") === 22.75);
check("'normal' falls back to 1.5 × font size", lineHeightPx("normal", "14px") === 21);
check("garbage falls back too", lineHeightPx("", "") === 21);

console.log(`\nchat collapse: ${passed}/${passed} checks passed`);
