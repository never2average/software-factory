/**
 * The chat mirror is the only index of your conversations — guard the ways it
 * silently loses them.
 *
 * The transcript itself lives in eve and is durable. What is NOT durable is the
 * mirror row that points at it: no row, no sidebar entry, no way to reach a
 * finished conversation. On 2026-08-08 a completed 3,000-character answer became
 * unreachable exactly this way, and nothing on screen said anything was wrong.
 *
 * Every check here is a distinct way that write went missing:
 *   - starved by its own debounce during a long streaming turn
 *   - cancelled by the page unloading
 *   - dropped because sign-in had not resolved yet
 *   - rejected by the server and swallowed by an empty catch
 *
 * Run:  npm run test:chat-persistence
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
const sidebar = readFileSync("app/_components/chat-sidebar.tsx", "utf8");

console.log("Chat mirror durability:");

/* A debounce that resets on every call never fires under a continuous stream,
 * and a streaming turn updates on every message. */
check("the debounce has a maximum wait", /MAX_SYNC_WAIT_MS/.test(shell));
check(
  "…and it forces a write once exceeded",
  /Date\.now\(\) - pendingSince\.current >= MAX_SYNC_WAIT_MS\) return flushSessions\(\)/.test(shell),
);

/* An ordinary fetch is cancelled when the page goes away — which is exactly
 * when the last, most valuable write happens. */
check("unload writes use keepalive", /keepalive: onUnload/.test(shell));
check("navigation and tab close flush", /addEventListener\("pagehide"/.test(shell));
check("backgrounding flushes (the last event a mobile tab sees)", /visibilitychange/.test(shell));
check("unmount flushes", /flushSessions\(true\);\s*\n\s*\};\s*\n\s*\}, \[flushSessions\]\)/.test(shell));

/* keepalive bodies are size-capped; silently exceeding it drops the write. */
check("the unload payload is trimmed to fit keepalive", /onUnload \? 40 : 200/.test(shell));

/* A failed write used to be `.catch(() => {})`. */
check("a rejected write is retried", /requeue\(list, onUnload\)/.test(shell));
check("a non-ok response is treated as failure", /if \(r\.ok\) return setSyncFailed\(false\)/.test(shell));
check("persistent failure is surfaced, not swallowed", /setSyncFailed\(true\)/.test(shell));

/* Writes attempted before sign-in resolved had nothing to re-trigger them. */
check(
  "a write dropped before sign-in is retried when identity arrives",
  /if \(email && pendingSessions\.current\) flushSessions\(\)/.test(shell),
);

/* And the user has to be able to SEE that saving is broken. */
check("the flag reaches the sidebar", /saveFailed=\{syncFailed\}/.test(shell));
check("the sidebar renders it", /saveFailed \? \(/.test(sidebar));
check(
  "…and says the consequence, not just that something failed",
  /may not survive a reload/.test(sidebar),
);


/* ---- ownership + fork ---------------------------------------------------- */

const gate = readFileSync("app/eve/v1/session/[...segments]/route.ts", "utf8");
const nextCfg = readFileSync("next.config.ts", "utf8");
const threads = readFileSync("app/api/ops/threads/route.ts", "utf8");

console.log("\nSession ownership:");
check("per-session paths are gated, not blindly proxied", /permitted\(sessionId, identity\.email\)/.test(gate));
check("a non-owner is refused", /status: 403/.test(gate));
// The gate is a dynamic route; `afterFiles` rewrites (a bare array) beat dynamic
// routes, so the handler built fine and was never reached. Measured, not guessed.
check("the eve rewrite is a fallback so the gate wins", /fallback: \[/.test(nextCfg));
check("…and no afterFiles rewrite shadows it", /afterFiles: \[\]/.test(nextCfg));
check("the stream is passed through, never buffered", /new Response\(upstream\.body/.test(gate));
check("an unknown session fails open (never lock someone out of a new chat)", /if \(owners\.length === 0 && threads\.length === 0\) return true/.test(gate));
check("shared-thread members keep access", /chatThreadMembers/.test(gate));

console.log("\nThread fork:");
check(
  "a changed mount key cannot fork a second row for one session",
  /\(shared && shared\.ownerEmail === email \? shared : undefined\)/.test(threads),
);


/* ---- resuming a cut stream ---------------------------------------------- */

const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
const deployScript = readFileSync("scripts/deploy.mjs", "utf8");

console.log("\nStream resume:");
/**
 * The stream IS severed every ~120s (measured 121/241/362/482/602/723s). What
 * was wrong was the conclusion: eve's send-path reader loops and REOPENS at the
 * advanced index on a clean EOF, so `maxReconnectAttempts` is a budget of
 * SEGMENTS. At 6 it capped every conversation at twelve minutes.
 */
check(
  "the reconnect budget is large enough for a long turn",
  /maxReconnectAttempts: (\d+)/.test(chat) && Number(/maxReconnectAttempts: (\d+)/.exec(chat)[1]) >= 100,
);
// A remount cannot resume: the store opens a stream only from send().
check("no remount-based auto-resume was reintroduced", !/autoResumes/.test(chat));
check(
  "…and the reason is written down where someone would add one back",
  /store opens a stream only from send\(\)/.test(chat),
);
check(
  "the live chat path writes the durable mirror, not just localStorage",
  /syncRef\.current\?\.\(next/.test(readFileSync("app/_components/chat-shell.tsx", "utf8")),
);
check(
  "a new chat registers immediately instead of waiting out the debounce",
  /if \(immediate\) return flushSessions\(\)/.test(readFileSync("app/_components/chat-shell.tsx", "utf8")),
);
check(
  "a failed write cannot overwrite a newer queued snapshot",
  /pendingSessions\.current \?\?= list/.test(readFileSync("app/_components/chat-shell.tsx", "utf8")),
);
check(
  "the stream function gets the same ceiling as the work function",
  /maxDuration = "max"/.test(deployScript) && /__server\.func/.test(deployScript),
);

/* ---- identity, indexing, and being able to see failures ------------------ */

const relay = readFileSync("app/api/ops/threads/[id]/messages/route.ts", "utf8");
const threadsRoute = readFileSync("app/api/ops/threads/route.ts", "utf8");
const gateRoute = readFileSync("app/eve/v1/session/[...segments]/route.ts", "utf8");

console.log("\nConversation identity:");
// `new-1` from a per-load counter meant the first chat after every reload
// collided with the previous session's first chat, overwriting its row.
check("mount keys are unique across page loads", /mintKey\(/.test(shell) && !/new-\$\{newCount/.test(shell));
check(
  "a recycled key cannot adopt another conversation's thread row",
  /keyMatchIsSameConversation/.test(threadsRoute),
);

console.log("\nStream indexing:");
// streamIndex is an absolute count of SERVER events; counting client-only
// markers told eve to start N events late and those N never rendered.
check(
  "the resume cursor counts server events only",
  /streamIndex: fresh\.index \?\? \(fresh\.events as unknown\[\]\)\.length/.test(shell),
);

console.log("\nRelay token:");
check("the relay recovers the CURRENT token, not the first one", !/tailUntilPark\([^)]*, 0,/.test(relay));
check(
  "a severed tail leaves the claim so recovery can still fire",
  /\.\.\.\(parked\.token \? \{ turnClaimedAt: null \} : \{\}\)/.test(relay),
);

console.log("\nObservability:");
check("chat failures are reported somewhere queryable", /chat-telemetry/.test(shell) && /chat-telemetry/.test(chat));
check("a stream that gives up mid-turn is recorded", /stream-gave-up/.test(chat));
check("a failed save is recorded", /save-failed/.test(shell));
check("the gate says so when it fails open", /SESSION GATE FAILED OPEN/.test(gateRoute));
check("the gate's ceiling is not the narrowest on the path", /maxDuration = 800/.test(gateRoute));

console.log(`\nchat reliability: ${passed}/${passed} checks passed`);
