/**
 * The auth a session is created with, marked to keep eve's own batch when a program (not a person in the chat) opens it.
 * See lib/subagent-batch.ts. Pure.
 */
import { SUBAGENT_BATCH_AUTH_ATTRIBUTE, SUBAGENT_BATCH_HEADER } from "../../lib/subagent-batch.ts";
import { isServicePrincipal } from "./service-scope.ts";

type WithAttributes = { readonly attributes?: Readonly<Record<string, string | readonly string[]>> };

export function withSubagentBatch<T extends WithAttributes>(auth: T | null, headers: Headers): T | null {
  if (!auth) return auth;
  const program = headers.get(SUBAGENT_BATCH_HEADER)?.trim().toLowerCase() === "all" || isServicePrincipal(auth as never);
  if (!program) return auth;
  return { ...auth, attributes: { ...(auth.attributes ?? {}), [SUBAGENT_BATCH_AUTH_ATTRIBUTE]: "all" } };
}
