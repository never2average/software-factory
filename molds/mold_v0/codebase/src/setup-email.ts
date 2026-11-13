/**
 * The setup email (mold_v0-277): how to connect the product, written ONLY for the agents the person chose (one, or
 * several), each with its own exact steps (src/connect-catalog.ts: its one-click link, command, config file and snippet)
 * and the connection URL. Never a generic list of every client: the caller names the clients by catalog id, and an
 * empty choice, an unknown id or too many are refused (SetupEmailError, a 400).
 *
 * Built here, sent by src/email.ts (setupEmail, the one place that builds and sends a message): the console's Overview
 * (Connect, Send setup by email: to the signed-in person's own address) and the staff console's invite result (copied
 * or opened in the staff's own mail app, the key never in it: KEY_PLACEHOLDER).
 */
import type { ClientEntry } from "./connect-catalog.js";

export class SetupEmailError extends Error { status = 400; }

/** At most so many clients in one email: a person picks the few they use, never the whole catalog. */
export const MAX_SETUP_CLIENTS = 5;

/**
 * The chosen clients, in the order chosen, each once: refused when the choice is not a list of catalog ids, is empty,
 * names an id the catalog does not have, or names more than MAX_SETUP_CLIENTS.
 */
export function chosenClients(ids: unknown, catalog: readonly ClientEntry[]): ClientEntry[] {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new SetupEmailError("Choose the agents to set up: clients must be a list of client ids");
  const want = [...new Set(ids.map((x: string) => x.trim()).filter(Boolean))];
  if (!want.length) throw new SetupEmailError("Choose at least one agent to set up");
  if (want.length > MAX_SETUP_CLIENTS) throw new SetupEmailError(`Choose at most ${MAX_SETUP_CLIENTS} Agents for one email`);
  const unknown = want.filter((id) => !catalog.some((c) => c.id === id));
  if (unknown.length) throw new SetupEmailError(`Unknown agent: ${unknown.map((x) => JSON.stringify(x.slice(0, 40))).join(", ")}`);
  return want.map((id) => catalog.find((c) => c.id === id)!);
}

/** "A", "A and B", "A, B and C". */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** One client's section: its name, then its own way in, step by step, in the order the client takes them. */
function clientSection(c: ClientEntry, numbered: boolean, n: number): string {
  const out = [numbered ? `${n}. ${c.client}` : c.client];
  if (c.install_url) out.push(`One-click install: ${c.install_url}`);
  out.push(c.steps);
  if (c.command) out.push("", "Run:", c.command);
  if (c.snippet) out.push("", c.file ? `${c.command || c.install_url ? "Or add this to" : "Add this to"} ${c.file}:` : "Configuration:", c.snippet);
  return out.join("\n");
}

/**
 * The email's subject and body for the chosen clients. `url` is the connection URL; `key` (a legacy API key, or the
 * placeholder the staff console pastes it over) adds the note on keeping it private; `prompt` is the first thing to type.
 */
export function setupEmailText(chosen: readonly ClientEntry[], o: { name: string; url: string; key?: string | null; prompt: string }): { subject: string; body: string; clients: string[] } {
  if (!chosen.length) throw new SetupEmailError("Choose at least one agent to set up");
  const names = chosen.map((c) => c.client);
  const subject = `Set up ${o.name} in ${andList(names)}`;
  const many = chosen.length > 1;
  const body = [
    "Hi,",
    "",
    `Here is how to connect ${o.name} to ${andList(names)}. Your connection URL:`,
    "",
    o.url,
    ...(o.key ? ["", `Your API key: ${o.key}`, "Anyone with it can use your account, so keep it private. Your client sends it in a header; it never goes in the URL."] : []),
    "",
    ...chosen.flatMap((c, i) => [clientSection(c, many, i + 1), ""]),
    `Then open a new chat and type: "${o.prompt}"`,
    "",
    "Reply to this email with anything that gets in your way.",
  ].join("\n");
  return { subject, body, clients: chosen.map((c) => c.id) };
}
