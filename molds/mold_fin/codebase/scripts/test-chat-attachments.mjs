/**
 * The attachment message contract, executed offline so CI can hold it.
 *
 * Two invariants, both learned the hard way in one afternoon:
 *
 *   - the MODEL must get the data-room path (without it the agent hunts for a
 *     file it was told about and reports "not found");
 *   - the USER must see their own words and nothing else (the first version
 *     printed "Read it from that path with your data-room tools" inside their
 *     own message bubble).
 *
 * This imports the REAL module the app uses. The end-to-end companion
 * (test:attachment-e2e) proves the same path against production with a genuine
 * .xlsx; this one runs in milliseconds with no network, so it can gate every PR.
 *
 * Run:  npm run test:chat-attachments
 */
import assert from "node:assert/strict";
import {
  composeAttachmentMessage,
  stripAgentOnly,
  visibleText,
} from "../lib/chat-attachments.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

const TEXT = "Please populate my customers from this.";
const FILE = { name: "Latest Deployment Tracker - v2.0 (1).xlsx", path: "Uploads/operator-onfinance-in/Latest Deployment Tracker - v2.0 _1_.xlsx" };

console.log("Attachment message contract:");

const one = composeAttachmentMessage(TEXT, [FILE]);
check("the model gets the data-room path", one.includes(FILE.path));
check("the model is told to read it with its tools", /data-room tools/.test(one));
check("the reader sees exactly their own words", visibleText(one) === TEXT);
check("no path leaks to the reader", !visibleText(one).includes("Uploads/"));
check("no instruction leaks to the reader", !/data-room tools/.test(visibleText(one)));
// The chip is how the reader knows a file went with the message at all.
check("a chip token is present for the transcript", one.includes(`[file: ${FILE.name}]`));

/* Filenames are hostile: brackets, parens, unicode. A `(directive: …)` style
 * marker would end at the first ")" and leak the rest — which is exactly why
 * paired sentinels were chosen. */
const nasty = {
  name: "Q3 (final) [v2] — notes).xlsx",
  path: "Uploads/x/Q3 _final_ [v2] — notes_.xlsx",
};
const hostile = composeAttachmentMessage("hi", [nasty]);
check("a filename full of brackets does not leak the block", !visibleText(hostile).includes("Uploads/"));
check("…and the reader still sees only their words", visibleText(hostile) === "hi");

const many = composeAttachmentMessage(TEXT, [FILE, nasty]);
check("both paths reach the model", many.includes(FILE.path) && many.includes(nasty.path));
check("plural wording is used for several files", /these files/.test(many));
check("multiple attachments still leak nothing", visibleText(many) === TEXT);

const failed = composeAttachmentMessage(TEXT, [], ["broken.xlsx"]);
check("a failed upload is reported TO THE MODEL", failed.includes("broken.xlsx"));
check("…and not to the reader", visibleText(failed) === TEXT);

check("no attachments leaves the text untouched", composeAttachmentMessage(TEXT, []) === TEXT);
check("an empty message with a file still carries the path", composeAttachmentMessage("", [FILE]).includes(FILE.path));
check("stripping is idempotent", stripAgentOnly(stripAgentOnly(one)) === stripAgentOnly(one));

/* The regression that started it all: an 840KB base64 payload in the message. */
check("no data URL is ever embedded", !one.includes("data:") && !many.includes("base64"));

/* ---- turn directives ----------------------------------------------------- */

const { wrapDirectives } = await import("../lib/chat-attachments.ts");

console.log("\nTurn directives:");
// The exact string that appeared in a user's message bubble.
const BROWSER = "(Browser use is enabled — you may open a real browser (browser_open) and navigate + read pages with the browser tools when it helps.)";
const CONTEXT = "(Context: this conversation is about axis-bank.)";
const asked = "Can you check our customers' websites for key management personnel?";

const withDir = `${wrapDirectives([CONTEXT, BROWSER])}\n\n${asked}`;
check("the model still receives the directives", withDir.includes("browser_open") && withDir.includes("axis-bank"));
check("the reader sees only their question", visibleText(withDir) === asked);
// The specific failure: nested "(browser_open)" defeated a [^)]* pattern, so the
// tail leaked even when the directive name was recognised.
check("a directive containing brackets does not leak its tail", !visibleText(withDir).includes("browser_open"));
check("no directive name survives", !/Browser use|Context:/.test(visibleText(withDir)));

// Messages sent before the marker existed replay from eve on reopen.
const legacy = `${CONTEXT} ${BROWSER}\n\n${asked}`;
check("legacy bare directives are still stripped", visibleText(legacy) === asked);
check("…including Browser use, which was never in the old list", !visibleText(legacy).includes("browser"));

check("no directives leaves the text untouched", wrapDirectives([]) === "");

console.log(`\nchat attachments + directives: ${passed}/${passed} checks passed`);
