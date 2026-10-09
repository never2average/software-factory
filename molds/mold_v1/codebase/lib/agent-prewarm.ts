/**
 * WARM THE AGENT BEFORE THE FIRST MESSAGE.
 *
 * The agent runs as its own serverless deployment, and the first message of a session was the request that found it
 * cold: the person typed, pressed Enter and waited for a function to boot before a token could stream. The composer
 * mounting is the earliest moment we know a message is coming, so it sends one cheap authenticated no-op to the agent
 * (its health route, through the same same-origin rewrite a message takes) to start that boot while the person types.
 *
 * Once per tab per WARM_FOR_MS (sessionStorage, so a reload in the same tab does not repeat it), never awaited, and
 * nothing depends on its answer: a failure only means the first message pays the cold start it always paid.
 */
import { STORAGE_KEYS, readStored } from "./browser-storage.ts";

/** A serverless instance stays warm for minutes after a request; re-warm after this long. */
const WARM_FOR_MS = 4 * 60_000;
const MARK = "workspace-agent-warmed-at";

export const PREWARM_PATH = "/eve/v1/health";

/** Where sessionStorage is unavailable (private mode), warm at most once per page load instead. */
let warmedThisPage = false;

/** Send the warm-up if this tab has not sent one recently. Returns whether it sent one. */
export function prewarmAgent(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(MARK) ?? 0);
    if (now - last < WARM_FOR_MS) return false;
    window.sessionStorage.setItem(MARK, String(now));
  } catch {
    /* no sessionStorage: fall back to once per page load */
    if (warmedThisPage) return false;
  }
  warmedThisPage = true;
  const headers: Record<string, string> = {};
  const token = readStored(STORAGE_KEYS.token);
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch(PREWARM_PATH, { headers, cache: "no-store", priority: "low" } as RequestInit).catch(() => {});
  return true;
}
