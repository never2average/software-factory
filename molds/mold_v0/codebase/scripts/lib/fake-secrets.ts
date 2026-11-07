// Stand-in secrets for the offline tests (mold_v0-262), built when a test runs so that no file of the mold holds text
// shaped like a real credential: repo.py's secret gate (and any other scanner) refuses a tree with a private key's
// armour line or a provider key's shape in it, whatever the value is. Nothing here is a real key, and no allowlist is
// needed for any of it: the scanner still finds every real one.
const DASHES = "-".repeat(5);

/** A PEM armour line: `pemLine("BEGIN", "RSA")` is the first line of an RSA private key's file. */
export const pemLine = (edge: "BEGIN" | "END", kind = "") => `${DASHES}${edge} ${kind ? `${kind} ` : ""}${["PRIVATE", "KEY"].join(" ")}${DASHES}`;
/** A whole stand-in private key file: its armour around `body`. */
export const pemBlock = (body: string, kind = "") => `${pemLine("BEGIN", kind)}\n${body}\n${pemLine("END", kind)}\n`;
/** A string with an Anthropic key's shape (its prefix, then `tail`): what a run's log might leak, for the masking tests. */
export const anthropicShaped = (tail = "ABCDEFGHIJKLMNOPQRSTUVWX") => ["sk", "ant", "api03", tail].join("-");
