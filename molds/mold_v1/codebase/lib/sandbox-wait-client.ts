/**
 * THE CHAT'S "WAITING FOR A FREE SANDBOX" LINE, the pure half (mold_v1-194). The hook and the line are
 * app/_components/sandbox-wait-line.tsx; the agent's side is agent/lib/sandbox-wait.ts behind the session guard's
 * `GET /eve/v1/session/:id/sandbox-wait`.
 *
 * WHEN THE CHAT ASKS AT ALL. Only a web app BUILT with `SANDBOX_BACKEND=microsandbox` (next.config.ts inlines
 * `NEXT_PUBLIC_SANDBOX_LINE`, lib/sandbox-line-flag.ts): there, and only there, the agent runs sandboxes under a running cap and a command can
 * wait in line. A Vercel build has the flag empty, so the hook never sends a request: no poll, no cost, no line.
 *
 * The words are the deployment profile's (`chat.sandbox_wait`): a deployment that calls its sandboxes something
 * else says so there.
 */
import { DEPLOYMENT_PROFILE, fillProfileText } from "./deployment-profile.generated.ts";

/** Whether this build's agent can make a command wait for a free sandbox (decided at build: next.config.ts). */
export const SANDBOX_LINE_ENABLED: boolean = process.env.NEXT_PUBLIC_SANDBOX_LINE === "1";

/** The session route segment the line is read from (lib/chat-gate.ts counts it as a read). */
export const SANDBOX_WAIT_SEGMENT = "sandbox-wait";

/** How often the chat asks while a turn, or a specialist it handed work to, is running. */
export const SANDBOX_WAIT_POLL_MS = 3_000;

/** What the line shows: the place nearest the front among this chat's waiting commands, and how many there are. */
export interface SandboxWaitShown {
  readonly position: number;
  readonly count: number;
}

/** "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", … */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** The sentence a person reads for a place in line, in this deployment's words. */
export function sandboxWaitText(position: number, words: { line: string; next: string } = DEPLOYMENT_PROFILE.chat.sandbox_wait): string {
  return fillProfileText(position <= 1 ? words.next : words.line, { place: ordinal(position) });
}

/** The agent's answer, read defensively: anything unexpected is "nothing waiting". */
export function readSandboxWait(body: unknown): SandboxWaitShown | null {
  const waits = (body as { waits?: unknown } | null)?.waits;
  if (!Array.isArray(waits)) return null;
  const positions = waits
    .map((w) => (w as { position?: unknown } | null)?.position)
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1);
  if (positions.length === 0) return null;
  return { position: Math.min(...positions), count: positions.length };
}
