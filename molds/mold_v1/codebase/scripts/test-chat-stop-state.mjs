/**
 * test:chat-stop-state — a Stop's markers, notes and "stopped here" turns are one person's, in one workspace
 * (mold_v1-141). They are held at module scope so they outlive a chat's remount, and were keyed by chatKey alone
 * and never cleared: on a shared machine the next sign-in (or the same person in another workspace) opening a chat
 * with the same key was shown the previous one's Stop.
 *
 *   npm run test:chat-stop-state
 */
import { readFileSync } from "node:fs";

const state = await import("../app/_components/chat-stop-state.ts");
let failures = 0;
const check = (what, ok) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const marker = (turnId) => ({ type: "client.turn.stopped", data: { requestIds: [], delegations: [], at: 1, turnId } });

console.log("Keyed by person, workspace and chat:");
const alice = state.stopKey("alice@example.com:org-a", "chat-1");
const bob = state.stopKey("bob@example.com:org-a", "chat-1");
const aliceB = state.stopKey("alice@example.com:org-b", "chat-1");
const anon = state.stopKey(undefined, "chat-1");
check("the key is `${email}:${orgId}:${chatKey}`", alice === "alice@example.com:org-a:chat-1");
check("…and differs per person, per workspace, and for a mount with no signed-in scope", new Set([alice, bob, aliceB, anon]).size === 4);
check("…and is case-insensitive on the email (the same person is one key)", state.stopKey("Alice@Example.com:org-a", "chat-1") === alice);

let heard = 0;
const off = state.onStopMarker(alice, () => heard++);
state.recordStopMarker(alice, marker("turn_1"));
check("a marker is recorded for its key, and every mounted instance of that chat is told", state.stopMarkersFor(alice).length === 1 && heard === 1);
check("…and is NOT visible to another person's chat with the same chatKey", state.stopMarkersFor(bob).length === 0);
check("…nor to the same person's chat of that key in another workspace", state.stopMarkersFor(aliceB).length === 0);

console.log("\nSign-out forgets all of it:");
state.stopNotes.set(alice, "Stopped from another tab.");
state.stoppedHere.set(alice, new Set(["turn_1"]));
const heardBefore = heard;
state.forgetStopState();
check("markers are gone", state.stopMarkersFor(alice).length === 0);
check("notes are gone", state.stopNotes.size === 0);
check("turns this tab stopped are gone", state.stoppedHere.size === 0);
check("…and a chat still mounted is told, so it drops what it was showing", heard === heardBefore + 1);
off();
state.recordStopMarker(alice, marker("turn_2"));
check("an unsubscribed listener hears nothing more", heard === heardBefore + 1);
state.forgetStopState();

console.log("\nWiring:");
const gate = readFileSync("app/_components/auth-gate.tsx", "utf8");
const signOut = gate.slice(gate.indexOf("const signOut = useCallback("), gate.indexOf("}, []);", gate.indexOf("const signOut = useCallback(")));
check("auth-gate's signOut calls forgetStopState()", /forgetStopState\(\);/.test(signOut));
const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
check("agent-chat keeps none of these maps itself", !/const (stopNotes|stoppedHere|stopMarkersByChat|stopMarkerListeners) = new Map/.test(chat));
check("agent-chat derives the key from the chat cache's scope and the chat", /const stopStateKey = stopKey\(storageScope, chatKey\);/.test(chat));
check(
  "…and never reads or writes Stop state by chatKey alone",
  !/(stopNotes|stoppedHere)\.(get|set|delete)\(chatKey/.test(chat) && !/recordStopMarker\(\s*chatKey/.test(chat) && !/stopMarkersFor\(chatKey/.test(chat),
);

console.log(failures ? `\ntest:chat-stop-state: ${failures} FAILED` : "\ntest:chat-stop-state: all checks passed");
process.exit(failures ? 1 : 0);
