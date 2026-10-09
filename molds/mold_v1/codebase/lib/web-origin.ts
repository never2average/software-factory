/**
 * THE WEB APP'S ADDRESS, as the agent needs it: CORS for the browser chat (agent/channels/eve.ts), the queued-message
 * nudge (agent/lib/chat-queue-nudge.ts) and the run trigger (agent/lib/run-tools.ts).
 *
 * It is the deployment's setting, WEB_ORIGIN, and nothing else. It used to default to one product's own web address,
 * so any other deployment without the setting sent its nudges and run triggers to that product and allowed its
 * browser origin. There is no derived fallback either: on Vercel, VERCEL_PROJECT_PRODUCTION_URL in the agent's
 * project is the AGENT's own address (a separate project from the web app), not the web app's.
 *
 * Unset or not an http(s) URL: null, and one plain line in the log naming the setting. Callers refuse what needs it
 * (a run trigger says so; the nudge is skipped; CORS allows no cross-origin browser but local development).
 *
 * Dependency-free: the agent, the web app and plain-node tests all load it.
 */
type Env = Record<string, string | undefined>;

let said = false;

export function webOriginSetting(env: Env = process.env): string | null {
  const raw = env.WEB_ORIGIN?.trim() || "";
  let origin: string | null = null;
  if (raw && raw !== "[SENSITIVE]") {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") origin = raw.replace(/\/+$/, "");
    } catch {
      origin = null;
    }
  }
  if (origin === null && !said) {
    said = true;
    console.warn(
      `[web-origin] WEB_ORIGIN is ${raw ? "not an http(s) address" : "not set"} on the agent, so it cannot reach the web app ` +
        "(run triggers and queued-message nudges are refused; browsers on other addresses are not allowed). " +
        "Set WEB_ORIGIN=https://<the web app's address> on the agent.",
    );
  }
  return origin;
}
