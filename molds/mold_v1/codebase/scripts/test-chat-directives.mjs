/**
 * "Show the extra chat directives in either the chat input or the sidebar.
 *  You're showing that many, many times. That should not ever be shown."
 *
 * The per-turn directives ("(Context: this conversation is about …)",
 * "(Web search is off — …)", "(Browser use is enabled — … (browser_open) …)",
 * "(Plan mode is ON — …)") go to the model on EVERY message. The transcript
 * renderer hid them; nothing else did:
 *
 *  - `cleanTitle` stripped only the LEGACY bare form, `[^)]*` to the first `)`,
 *    and fell back to the RAW text when that left nothing — so a chat's sidebar
 *    title was its first message's directives;
 *  - the sidebar preview (`lastText`) was stored raw, directives and all, and
 *    mirrored to the database;
 *  - the suggestion cards sent the directives BARE, unwrapped;
 *  - Retry re-sent the stored text, stale directives included.
 *
 * Two halves. The BEHAVIOURAL half runs the one shared function
 * (`displayText` / `displayTitle` in lib/chat-attachments.ts) over every form a
 * directive was ever sent or stored in — including the half-stripped titles the
 * old cleaner left in the database. The GATE half enumerates every place a chat
 * title, preview or user message is displayed or persisted, and fails if one of
 * them reads the raw value — so a new site cannot quietly skip the function.
 *
 * Failures are collected, so a run on the unfixed code lists every leak at once.
 *
 * Run:  npm run test:chat-directives
 */
import { readFileSync } from "node:fs";
import * as att from "../lib/chat-attachments.ts";
import { FOLDER } from "../agent/lib/dataroom-folders.ts";

let passed = 0;
const failed = [];
const check = (label, condition) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}`);
  }
};

const CONTEXT = "(Context: this conversation is about acme-hfc, bharat-housing.)";
const SEARCH_OFF = "(Web search is off — do not use the web_search tool for this request.)";
const BROWSER =
  "(Browser use is enabled — you may open a real browser (browser_open) and navigate + read pages with the browser tools when it helps.)";
const planLine = (plural) =>
  `(Plan mode is ON — investigate and plan only, take no action. Use ONLY read-only tools to gather what you need; do NOT write, mutate, send, draft, schedule, post, page, or anything that would prompt for approval. If the request is ambiguous or has real options, ask me a short clarifying question first. Then give a concise plan: the goal, the concrete steps in order, which ${plural}/records/systems each step touches, and how we'll verify it. Then stop and wait for my explicit go — do not act until I approve.)`;
const PLAN = planLine("customers");
const PLAN_OTHER = planLine("companies");
const ALL = [CONTEXT, SEARCH_OFF, BROWSER, PLAN];
const WORDS = "What changed in the Q2 disbursement numbers (vs Q1)?";
/** Anything a directive ever contains that a person's own words would not. */
const LEAK = /⁦|directives⁩|this conversation is about|web_search|Web search is off|Browser use is enabled|browser_open|browser tools when it helps|Plan mode is ON|read-only tools/;

const shown = (s) => (typeof att.displayText === "function" ? att.displayText(s) : s);
const titled = (s, f) =>
  typeof att.displayTitle === "function" ? att.displayTitle(s, f) : s || f;

console.log("1. Every directive the app ever sent is hidden:");
{
  const forms = {
    "the agent-only marker (what every message sends today)": `${att.wrapDirectives(ALL)}\n\n${WORDS}`,
    "a company name with its own brackets": `(Context: this conversation is about Aadhar Housing (AHFL).) ${SEARCH_OFF}\n\n${WORDS}`,
    "the legacy bare run (suggestion cards; replayed threads)": `${ALL.join(" ")}\n\n${WORDS}`,
    "a legacy run with the nested (browser_open) bracket": `${BROWSER}\n\n${WORDS}`,
    "the plan line under another profile's plural": `${PLAN_OTHER}\n\n${WORDS}`,
    "legacy run AND marker together": `${CONTEXT}\n\n${att.wrapDirectives([SEARCH_OFF])}\n\n${WORDS}`,
  };
  for (const [name, text] of Object.entries(forms)) {
    const out = shown(text);
    check(`${name}: nothing leaks`, !LEAK.test(out));
    check(`${name}: the person's words survive`, out === WORDS);
    check(`${name}: nothing leaks into a TITLE`, !LEAK.test(titled(text, "New chat")));
  }
  check("an attachment-only first message titles as the fallback, never as its directives", titled(att.wrapDirectives(ALL), "New chat") === "New chat");
  check(
    "the model-only attachment block goes; the chip token stays for the renderer",
    shown(`${WORDS} [file: a.pdf]\n\n⁦attachments⁩ The user attached this file:\n- ${FOLDER.accounts}/a.pdf ⁦/attachments⁩`) ===
      `${WORDS} [file: a.pdf]`,
  );
  check("empty and missing text are empty", shown("") === "" && shown(undefined) === "" && shown(null) === "");
  check(
    "a title is one line",
    titled(`${att.wrapDirectives(ALL)}\n\nline one\nline two`, "x") === "line one line two",
  );
}

console.log("\n2. …and the person's own words are NEVER touched (the review's table):");
{
  const TABLE = [
    "Why did browser_open fail (timeout) on the Aadhar deck?",
    "(Context: I am the CFO) What is the NIM?",
    "(Context: see the attached deck",
    "Hello (Context matters) there",
    "What does (browser use) mean?",
    "(Web search is off) I turned it off myself.\n\nAnd a second paragraph.",
    // A real directive sentence, but NOT followed by a blank line: not how the app sent it.
    `${CONTEXT} What is the NIM?`,
    // Off by one character from the generated sentence.
    "(Web search is off — do not use the web_search tool for this request)\n\nMine.",
    "Please summarise: web_search tool when it helps, Plan mode is ON in our team process.",
  ];
  for (const text of TABLE) {
    check(`${JSON.stringify(text.slice(0, 60))} is shown exactly as written`, shown(text) === text.trim());
    check(`…and in a bubble`, att.visibleText(text) === text.trim());
  }
  check("the bubble (visibleText) hides the legacy run", !LEAK.test(att.visibleText(`${ALL.join(" ")}\n\n${WORDS}`)));
  const pasted = "I pasted this from the logs: ⁦directives⁩ and then\n\nthe rest of my question";
  check("pasted text containing ONE marker character keeps every word (only a complete pair is hidden)", att.visibleText(pasted) === pasted);
  check("…and a stray close marker is left alone too", shown("⁦/directives⁩ mine") === "⁦/directives⁩ mine");
  console.log("\n2b. A TITLE is a prefix, so it can end inside a directive:");
  const cut = (n) => `${CONTEXT} ${SEARCH_OFF}`.slice(0, n);
  for (const n of [20, 60, CONTEXT.length, CONTEXT.length + 25]) {
    check(`a title cut at ${n} characters, inside the directives, falls back`, titled(cut(n), "New chat") === "New chat");
  }
  check("a title cut inside the marker falls back", titled(att.wrapDirectives(ALL).slice(0, 90), "New chat") === "New chat");
  check("a title that is the person's own words is left alone", titled("(Context: I am the CFO) What is the NIM?", "x") === "(Context: I am the CFO) What is the NIM?");
}

console.log("\n3. The settings are shown ONCE, as state, beside the toggles:");
{
  const labels = typeof att.activeSettingLabels === "function" ? att.activeSettingLabels : null;
  check("activeSettingLabels exists", Boolean(labels));
  if (labels) {
    check(
      "a plain turn shows nothing",
      labels({ webSearch: true, browserUse: false, mode: "build", customers: [] }).length === 0,
    );
    check(
      "every non-default setting is named in plain words",
      JSON.stringify(labels({ webSearch: false, browserUse: true, mode: "plan", customers: ["acme-hfc", "bharat-housing"] })) ===
        JSON.stringify(["About: acme-hfc, bharat-housing", "Web search off", "Browser on", "Plan mode"]),
    );
    check("goal and loop modes are named too", labels({ webSearch: true, browserUse: false, mode: "goal", customers: [] })[0] === "Goal mode");
  }
}

console.log("\n4. GATE — every display and persist site goes through the one function:");
{
  const read = (p) => readFileSync(p, "utf8");
  const code = (p) =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  // (a) Nothing outside lib/chat-attachments strips directives by its own regex:
  // a second stripper is how "Browser use" leaked for its whole life.
  const ownStrippers = [
    "app/_components/agent-chat.tsx",
    "app/_components/agent-message.tsx",
    "app/_components/chat-shell.tsx",
    "app/_components/chat-sidebar.tsx",
    "app/_components/chat-search.tsx",
  ].filter((p) => /\/[^/\n]*\((?:\?:)?Context\|Web search/.test(code(p)));
  check(`no component keeps its own directive regex (${ownStrippers.join(", ") || "none"})`, ownStrippers.length === 0);

  // (b) A chat title or preview rendered in JSX is always displayTitle/displayText.
  const DISPLAY = [
    "app/_components/chat-sidebar.tsx",
    "app/_components/chat-search.tsx",
    "app/_components/agent-chat.tsx",
    "app/_components/chat-shell.tsx",
  ];
  for (const p of DISPLAY) {
    const raw = [...code(p).matchAll(/[{$]\{?\s*(?:s|t|it|thread|session|entry|chat|forkedFrom|src|meta)\??\.(?:title|preview)\b/g)].map(
      (m) => m[0],
    );
    check(`${p}: no raw chat title/preview is rendered (${raw.join(" ") || "none"})`, raw.length === 0);
  }

  // (c) DISPLAY ONLY. What is stored (the browser cache, the server mirror, a
  //     shared thread) or re-sent keeps its text exactly — a display rule that is
  //     ever wrong may hide words on screen, never lose them.
  const STORED = [
    "app/_components/chat-shell.tsx",
    "app/api/ops/chat-sessions/route.ts",
    "app/api/ops/threads/route.ts",
    "lib/chat-threads.ts",
  ];
  for (const p of STORED) {
    const hits = (code(p).match(/\b(?:title|preview):\s*[^\n]*display(?:Title|Text)\(/g) ?? []);
    check(`${p}: stores and serves titles/previews exactly as written (${hits.join(" | ") || "none cleaned"})`, hits.length === 0);
  }
  const chatSrc = code("app/_components/agent-chat.tsx");
  check(
    "the stored title and preview are derived WITHOUT stripping",
    !/function cleanTitle[\s\S]{0,300}?display(?:Text|Title)\(/.test(chatSrc) && !/function lastText[\s\S]{0,400}?displayText\(/.test(chatSrc),
  );

  // (d) The user bubble renders through visibleText → displayText; assistant text is never stripped.
  const msg = code("app/_components/agent-message.tsx");
  check("the user bubble has no private stripper left", !/function stripDirectives/.test(msg));
  check("the user bubble renders visibleText (→ displayText)", /extractAttachments\(text\)/.test(msg) && /visibleText\(text\)/.test(msg));
  check("visibleText is displayText", /export function visibleText[\s\S]*?return displayText\(/.test(code("lib/chat-attachments.ts")));
  const chat = chatSrc;

  // (e) Every message that carries directives wraps them; none sends them bare;
  //     Retry re-sends the stored text untouched.
  check("no message sends its directives bare (`${directives.join(…)}`)", !/\$\{directives\.join\(/.test(chat));
  check(
    "Retry re-sends the message exactly (no stripping on the way to the model)",
    /const retryLast[\s\S]{0,900}?agent\.send\(\{ message: text \}\)/.test(chat) && !/stripDirectiveBlocks\(/.test(chat),
  );

  // (f) The settings are shown as state beside the toggles.
  check("the composer shows the active settings as chips", /settingLabels\.map\(/.test(chat) && /activeSettingLabels\(/.test(chat));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
