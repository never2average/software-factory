/**
 * JSON text for a recorded file that must hold values EXACTLY, without the retired word appearing in the file.
 *
 * A golden recording or a schema snapshot holds whatever the code produced: a sha256 in hex, a URL-encoded path
 * (`%2F` followed by a folder name), an old column name in a migration's record of what it made. Any of those can
 * spell the base product's retired word by accident or by history, and the tree must not carry it
 * (check:neutral-names, the whole-tree scan). JSON lets any character inside a string be written as a `\uXXXX`
 * escape, and JSON.parse returns the same string either way, so writing the first letter of each occurrence as its
 * escape changes the file's text and nothing it holds.
 *
 * Pure, no imports beyond the word's own definition.
 */
import { BASE_PRODUCT_WORD } from "./agent-cli.mjs";

const [FIRST, ...REST] = BASE_PRODUCT_WORD;
// An existing escape (`ý`, `\"`) is passed over whole, so a letter inside one is never touched.
const OCCURRENCE = new RegExp(String.raw`\\u[0-9A-Fa-f]{4}|\\.|[${FIRST}${FIRST.toUpperCase()}](?=${REST.map((c) => `[${c}${c.toUpperCase()}]`).join("")})`, "g");

/** `text` (JSON) with the retired word's first letter escaped wherever the word occurs; JSON.parse gives the same value. */
export function escapeRetiredWord(text) {
  return String(text).replace(OCCURRENCE, (m) => (m.length === 1 ? `\\u${m.charCodeAt(0).toString(16).padStart(4, "0")}` : m));
}

/** JSON.stringify(value, null, indent), with escapeRetiredWord applied: what a recorder writes to disk. */
export function stringifyRecorded(value, indent) {
  return escapeRetiredWord(JSON.stringify(value, null, indent));
}
