/**
 * Which sign-in this server runs (mold_v0-004): the shell's own (`builtin`: an emailed one-time code and Google, people
 * and sessions in Postgres, src/builtin-auth.ts) or Clerk's (`clerk`: src/clerk.ts, exactly as before). One switch for
 * the whole server, read from the environment on every call:
 *
 *   AUTH_PROVIDER=builtin|clerk  the operator's choice, always wins
 *   unset                        clerk when CLERK_SECRET_KEY is set (an app already on Clerk keeps it, unchanged),
 *                                builtin otherwise (every new app)
 *
 * Anything else in AUTH_PROVIDER is ignored with one line on stderr, and the rule for unset applies. No imports: clerk.ts
 * and everything else read it without a cycle.
 */
export type AuthProviderName = "builtin" | "clerk";
export const AUTH_PROVIDERS: readonly AuthProviderName[] = ["builtin", "clerk"];

let warned = "";
export function authProvider(): AuthProviderName {
  const raw = (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "builtin" || raw === "clerk") return raw;
  if (raw && warned !== raw) {
    warned = raw;
    console.error(`AUTH_PROVIDER=${JSON.stringify(raw.slice(0, 40))} is not builtin or clerk: ignored (${process.env.CLERK_SECRET_KEY ? "clerk, from CLERK_SECRET_KEY" : "builtin"})`);
  }
  return process.env.CLERK_SECRET_KEY ? "clerk" : "builtin";
}
export const builtinAuth = () => authProvider() === "builtin";
