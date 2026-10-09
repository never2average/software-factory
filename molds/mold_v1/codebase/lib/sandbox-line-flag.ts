/**
 * Whether a WEB build shows the chat's "Waiting for a free sandbox (…in line)…" line (mold_v1-194; the line is
 * lib/sandbox-wait-client.ts, the agent's side agent/lib/sandbox-wait.ts). next.config.ts inlines the answer as
 * `NEXT_PUBLIC_SANDBOX_LINE`, read at build like every value it takes from the environment (scripts/check-gates.mjs).
 *
 * Only an agent on microsandbox caps its running sandboxes, so only a web app built beside one asks:
 * `SANDBOX_BACKEND=microsandbox` in the build's environment, read the way agent/lib/sandbox-settings.ts reads it
 * (trimmed, any case). Anything else, unset on Vercel included, is off, and the chat then sends no request for it.
 * A value the agent's build would refuse is off here too: the agent's own build is where that is said.
 *
 * No imports: next.config.ts loads this, and so does the off-Vercel probe's throwaway app.
 */
export function sandboxLineFlag(env: Record<string, string | undefined> = process.env): "1" | "" {
  return (env.SANDBOX_BACKEND ?? "").trim().toLowerCase() === "microsandbox" ? "1" : "";
}
