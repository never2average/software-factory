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
  return text
    .replace(/⁦attachments⁩[\s\S]*?⁦\/attachments⁩/g, "")
    .replace(/⁦directives⁩[\s\S]*?⁦\/directives⁩/g, "")
    /**
     * Messages sent BEFORE the marker existed carry bare directives, and a
     * reopened thread replays them from eve, so they still have to go.
     *
     * Matched by STRUCTURE, not by bracket balancing: directives sit at the very
     * start and are followed by a blank line. Both the greedy `[^)]*` and a lazy
     * `[\s\S]*?\)` stop at the "(browser_open)" nested inside the browser
     * directive and leak its tail — which is exactly what shipped.
     */
    .replace(/^\((?:Context|Web search|Plan mode|Browser use)[\s\S]*?(?:\n\n|$)/i, "");
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
  return stripAgentOnly(text)
    .replace(/\[file(?:: ([^\]]*))?\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
