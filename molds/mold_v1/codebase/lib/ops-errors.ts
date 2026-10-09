/**
 * An ops API error, as the person whose toast shows it reads it: in the profile's words.
 *
 * Ops routes answer `{ error }` with a zod issue list (`customerId: Required`) or an error's own text. Under a
 * profile that relabels the domains, the field a person is told about is the one they know (`companyId`), and the
 * prose is the profile's ("No company with that id…"). Database failures are already plain sentences with no
 * column or value in them (agent/lib/db/query-errors.ts); this keeps any product key or base word an error still
 * carries out of the toast. Quoted text, ids and names in a message are data and stay exactly as written
 * (agent/lib/agent-vocabulary.ts speakMessage, the same rule the model's tool errors follow).
 *
 * The identity under the default profile.
 */
import type { z } from "zod";
import { speakMessage } from "../agent/lib/agent-vocabulary.ts";
import { speakKey } from "./ui-keys.ts";

/** `customerId: Required; deployments.0.region: Required` with each field path in the profile's words. */
export function zodMessage(error: z.ZodError, root = "body"): string {
  return error.issues
    .map((i) => `${i.path.map((p) => (typeof p === "string" ? speakKey(p) : String(p))).join(".") || root}: ${speakMessage(i.message)}`)
    .join("; ");
}

/** Any error (or its text) for an `{ error }` answer: keys and base words spoken, data untouched. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && Array.isArray((e as { issues?: unknown }).issues) && (e as { name?: unknown }).name === "ZodError") {
    return zodMessage(e as z.ZodError);
  }
  return speakMessage(typeof e === "string" ? e : String(e));
}

/** An error's MESSAGE (no "Error: " prefix) for an `{ error }` answer or a stored run error a person reads, spoken
 *  like errorText. Replaces `e instanceof Error ? e.message : String(e)`. */
export function errorMessage(e: unknown): string {
  return speakMessage(e instanceof Error ? e.message : String(e));
}
