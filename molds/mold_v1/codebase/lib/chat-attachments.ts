/**
 * How an attachment becomes a message.
 *
 * Pure, in `lib/`, no `server-only` — so the tests drive the REAL code instead
 * of a copy. This path broke four separate ways in one afternoon:
 *
 *   1. the file was base64-inlined into the turn (840KB) and killed it;
 *   2. the upload was written to the legacy blob prefix while the agent read
 *      from the workspace prefix, so a successful upload was invisible;
 *   3. the browser could not re-fetch its own data URL (CSP `connect-src`), so
 *      the upload never fired;
 *   4. the agent-facing instructions rendered inside the USER'S message bubble.
 *
 * Every one of those was found by a person looking at a screenshot. The two
 * invariants below are the ones a test can hold:
 *
 *   - the MODEL must receive the data-room path;
 *   - the USER must see their own words, and nothing else.
 */

/**
 * Delimiters around text meant for the model only.
 *
 * Paired sentinels rather than a `(directive: …)` because filenames and paths
 * contain brackets and parentheses, and a `[^)]*` pattern stops at the first
 * one and leaks the remainder into the visible message.
 */
export const ATTACHMENT_OPEN = "⁦attachments⁩ ";
export const ATTACHMENT_CLOSE = " ⁦/attachments⁩";

/**
 * The same treatment for TURN DIRECTIVES — the per-turn toggle state the model
 * needs and the reader does not.
 *
 * These were sent as `(Context: …)` / `(Web search …)` / `(Plan mode …)` and
 * stripped by matching that list of names. Two ways that failed, both seen:
 * "Browser use" was added to the sender and never to the stripper, so it
 * rendered in the user's own bubble; and the browser directive contains
 * "(browser_open)", so the `[^)]*` pattern ends at that inner bracket and leaks
 * the tail even once the name IS listed.
 *
 * A whitelist of names cannot hold — every new toggle has to remember to update
 * a regex in another file. Marking the text as agent-only can.
 */
export const DIRECTIVE_OPEN = "⁦directives⁩ ";
export const DIRECTIVE_CLOSE = " ⁦/directives⁩";

export interface StoredAttachment {
  name: string;
  path: string;
}

/**
 * A filename safe to put inside a `[file: …]` token.
 *
 * The renderer matches `\[file(?:: ([^\]]*))?\]`, which stops at the FIRST
 * closing bracket — so a file called "Q3 (final) [v2] — notes.xlsx" ends the
 * token early and leaves "— notes.xlsx]" sitting in the user's own message.
 * Found by a test, not by a screenshot, which is the point of the test.
 *
 * Brackets become parentheses: the chip still reads naturally, and the token
 * can no longer be closed early. The MODEL is given the untouched path
 * separately, so nothing it needs is lost.
 */
function chipSafe(name: string): string {
  return name.replace(/\[/g, "(").replace(/\]/g, ")");
}

/** Build the message text: the user's words, chip tokens, then model-only paths. */
export function composeAttachmentMessage(
  text: string,
  stored: readonly StoredAttachment[],
  failed: readonly string[] = [],
): string {
  let out = text;
  if (stored.length > 0) {
    const paths = stored.map((s) => `- ${s.path}`).join("\n");
    const one = stored.length === 1;
    out = [
      text,
      stored.map((s) => `[file: ${chipSafe(s.name)}]`).join(" "),
      `${ATTACHMENT_OPEN}The user attached ${one ? "this file" : "these files"}, already saved in the data room. Read ${one ? "it" : "them"} with your data-room tools:\n${paths}${ATTACHMENT_CLOSE}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (failed.length > 0) {
    // Agent-facing too: it must not chase a file that is not there, and the
    // user does not need the internals.
    out = `${out}\n\n${ATTACHMENT_OPEN}These attachments failed to upload and are NOT available: ${failed.join(", ")}.${ATTACHMENT_CLOSE}`;
  }
  return out;
}

/** Remove every model-only block. The transcript renderer applies this. */
export function stripAgentOnly(text: string): string {
  // Directives in every form they were ever sent in — the marker, a truncated
  // marker, and the bare legacy run a reopened thread still replays — by the
  // same rules as the sidebar (see `stripDirectiveBlocks`), so the transcript
  // and the titles can no longer disagree about what is a directive.
  return stripDirectiveBlocks(text.replace(/⁦attachments⁩[\s\S]*?⁦\/attachments⁩/g, ""));
}

/**
 * EVERY DIRECTIVE SENTENCE THE APP HAS EVER SENT BARE — enumerated from the
 * history of app/_components/agent-chat.tsx (df7a1ed, d321131, 5e791ca,
 * be33292, d2e39c8), not guessed from fragments. A person's own words that
 * merely LOOK like a setting ("(Context: I am the CFO) …", "Why did
 * browser_open fail (timeout) …") are never one of these, and are never
 * touched. The only variable parts are the account ids of the Context line and
 * the profile's plural word in the plan line.
 */
const LEGACY_DIRECTIVES: readonly RegExp[] = [
  // Company names may carry their own brackets ("Aadhar Housing (AHFL)").
  /^\(Context: this conversation is about (?:[^()\n]|\([^()\n]*\))+?\.\)/,
  /^\(Web search is off — do not use the web_search tool for this request\.\)/,
  /^\(Browser use is enabled — you may open a real browser \(browser_open\) and navigate \+ read pages with the browser tools when it helps\.\)/,
  /^\(Plan mode is ON — investigate and plan only, take no action\. Use ONLY read-only tools to gather what you need; do NOT write, mutate, send, draft, schedule, post, page, or anything that would prompt for approval\. If the request is ambiguous or has real options, ask me a short clarifying question first\. Then give a concise plan: the goal, the concrete steps in order, which [^/()\n]+\/records\/systems each step touches, and how we'll verify it\. Then stop and wait for my explicit go — do not act until I approve\.\)/,
];

/**
 * The legacy run: at the VERY START of a message, one or more of the exact
 * sentences above separated by single spaces, and then a blank line (the only
 * way the app ever sent them). Anything else — a sentence that differs by a
 * character, a run with no blank line after it — is the person's text.
 */
function legacyRunLength(text: string): number {
  let i = 0;
  let matched = 0;
  for (;;) {
    const rest = text.slice(i);
    const hit = LEGACY_DIRECTIVES.map((re) => re.exec(rest)).find((m) => m !== null);
    if (!hit) break;
    i += hit[0].length;
    matched += 1;
    if (text[i] === " ") i += 1;
  }
  if (matched === 0) return 0;
  const tail = /^\s*\n\s*\n/.exec(text.slice(i).replace(/^ +/, ""));
  if (!tail) return 0;
  return text.length - text.slice(i).replace(/^ +/, "").slice(tail[0].length).length;
}

/**
 * Remove the per-turn DIRECTIVES — and only them: the agent-only marker block
 * (complete, or cut off by truncation — the marker characters are the app's own,
 * never a person's), a stray close marker, and the exact legacy run at the head
 * of a message. DISPLAY ONLY: nothing that is stored or re-sent goes through
 * this (see `displayText`).
 */
export function stripDirectiveBlocks(text: string): string {
  // Only a COMPLETE open…close pair: text a person pasted that happens to
  // contain one of the marker characters keeps every word.
  const out = text.replace(/⁦directives⁩[\s\S]*?⁦\/directives⁩/g, "").replace(/^\s+/, "");
  return out.slice(legacyRunLength(out));
}

/** How each generated sentence opens — for a TITLE cut off in the middle of one. */
const LEGACY_OPENINGS = [
  "(Context: this conversation is about ",
  "(Web search is off — ",
  "(Browser use is enabled — ",
  "(Plan mode is ON — ",
];

/**
 * A title is a prefix of the first message, and a prefix can end INSIDE a
 * directive: an open marker with no close, or a generated sentence cut short.
 * Only titles get this: in a message, a marker without its pair is the person's.
 */
function stripTruncatedDirective(title: string): string {
  const open = title.indexOf("⁦directives⁩");
  if (open >= 0 && title.indexOf("⁦/directives⁩", open) < 0) return title.slice(0, open).trim();
  let rest = title.replace(/^\s+/, "");
  let stripped = false;
  // Complete generated sentences at the head…
  for (;;) {
    const hit = LEGACY_DIRECTIVES.map((re) => re.exec(rest)).find((m) => m !== null);
    if (!hit) break;
    rest = rest.slice(hit[0].length).replace(/^ /, "");
    stripped = true;
  }
  const tail = rest.trim();
  // …followed by nothing (the title ended with them), or by the start of
  // another one that was cut off before its closing bracket.
  if (stripped && tail === "") return "";
  const cutOff =
    tail.length >= 8 &&
    !tail.includes(")") &&
    LEGACY_OPENINGS.some((o) => o.startsWith(tail) || tail.startsWith(o));
  return cutOff ? "" : title;
}

/**
 * WHAT A READER MAY SEE of a person's message, a title or a preview — the ONE
 * function every DISPLAY site uses (scripts/test-chat-directives.mjs enumerates
 * them). Display only: what is stored, mirrored to the server or re-sent keeps
 * its text exactly, so a rule that is ever wrong can only hide words on screen,
 * never lose them.
 *
 * "Show the extra chat directives in either the chat input or the sidebar.
 * You're showing that many, many times. That should not ever be shown." The
 * directives are sent on EVERY message, and the transcript renderer stripped
 * them while the sidebar title (`cleanTitle`, legacy parens only), the stored
 * preview and the suggestion cards' bare directives did not. Every model-only
 * block goes, in every form; the reader's own words and `[file: …]` chip tokens
 * stay (the renderer lifts the chips out itself).
 */
export function displayText(text: string | null | undefined): string {
  if (!text) return "";
  return stripDirectiveBlocks(
    text
      .replace(/⁦attachments⁩[\s\S]*?⁦\/attachments⁩/g, "")
      .replace(/⁦attachments⁩[\s\S]*$/g, "")
      .replace(/⁦\/attachments⁩/g, ""),
  ).trim();
}

/**
 * A chat's TITLE as the sidebar, the search and the fork banner show it: the
 * readable text on one line, or the fallback. Applied at RENDER as well as at
 * persist, so titles stored before this existed are clean without a migration.
 */
export function displayTitle(title: string | null | undefined, fallback: string): string {
  return stripTruncatedDirective(displayText(title)).replace(/\s+/g, " ").trim() || fallback;
}

/**
 * The active per-turn settings, as the reader should see them: ONCE, as state,
 * beside the composer's toggles — never repeated in every message and never in
 * the sidebar. Only what differs from a plain turn is listed.
 */
export function activeSettingLabels(input: {
  readonly webSearch: boolean;
  readonly browserUse: boolean;
  readonly mode: string;
  readonly customers: readonly string[];
}): string[] {
  const out: string[] = [];
  if (input.customers.length > 0) out.push(`About: ${input.customers.join(", ")}`);
  if (!input.webSearch) out.push("Web search off");
  if (input.browserUse) out.push("Browser on");
  if (input.mode === "plan") out.push("Plan mode");
  else if (input.mode === "goal") out.push("Goal mode");
  else if (input.mode === "loop") out.push("Loop mode");
  return out;
}

/** Wrap per-turn directives so the model reads them and the reader does not. */
export function wrapDirectives(directives: readonly string[]): string {
  return directives.length === 0 ? "" : `${DIRECTIVE_OPEN}${directives.join(" ")}${DIRECTIVE_CLOSE}`;
}

/** One attachment as the TRANSCRIPT can recover it: the chip's name, and the
 *  data-room path it was stored at when the message still carries one. */
export interface AttachmentRef {
  readonly name: string;
  /** Absent for a message sent before the marker existed, or replayed without it. */
  readonly path?: string;
}

/**
 * Recover the attachments of a sent message — name AND where the file went.
 *
 * `composeAttachmentMessage` writes two things about the same list: a
 * `[file: name]` chip token per file, for the reader, and one `- <path>` line
 * per file inside the model-only block, for the agent. The renderer read the
 * first and threw the second away, so the transcript knew a file had been
 * attached and had no idea where it was — which is why an attached PDF could be
 * named in the chat and not opened from it. Everything needed to open it was in
 * the message the whole time.
 *
 * PAIRED BY POSITION, because both lists are built from the same `stored` array
 * in the same order, and a name is not a key: two files can share one, and the
 * chip's name is `chipSafe`'d while the path is not, so they do not even match
 * as strings. A failed upload contributes neither a chip nor a path (it goes in
 * the separate failure sentence), so the two lists cannot drift apart.
 *
 * The path is left exactly as written, untrusted and unvalidated. This is
 * MESSAGE TEXT — a person can type `[file: x]` and an ⁦attachments⁩ block by
 * hand — so whatever comes out of here is a REQUEST, never a permission:
 * `isPreviewablePdfPath` decides whether it is worth rendering, and the server
 * decides, per workspace, whether it may be read at all.
 */
export function extractAttachmentRefs(text: string): AttachmentRef[] {
  const paths: string[] = [];
  for (const block of text.matchAll(/⁦attachments⁩([\s\S]*?)⁦\/attachments⁩/g)) {
    for (const line of block[1].split("\n")) {
      const path = /^\s*-\s+(\S.*?)\s*$/.exec(line);
      if (path) paths.push(path[1]);
    }
  }
  const refs: AttachmentRef[] = [];
  for (const token of stripAgentOnly(text).matchAll(/\[file(?:: ([^\]]*))?\]/g)) {
    const name = token[1]?.trim() || "attachment";
    const path = paths[refs.length];
    refs.push(path === undefined ? { name } : { name, path });
  }
  return refs;
}

/**
 * What the reader ends up seeing: model-only blocks gone, chip tokens lifted
 * out. Mirrors the renderer so a test can assert on the real thing.
 */
export function visibleText(text: string): string {
  return displayText(text)
    .replace(/\[file(?:: ([^\]]*))?\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
