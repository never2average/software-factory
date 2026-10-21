/**
 * STREAMED TEXT UNDER prefers-reduced-motion (mold_v1-299): the streamed reply's reveal (app/_components/agent-message.tsx
 * useSmoothText) tweens the visible text toward what has arrived, frame by frame. A reader who asked for reduced motion
 * gets the full text at once instead.
 *
 *   1. THE SETTING, READ (lib/reduced-motion.ts): true only when matchMedia says the query matches; no window, no
 *      matchMedia, or one that throws: false (the page as it was). Its change is subscribed to and unsubscribed from,
 *      through addEventListener, or the older addListener pair.
 *   2. THE WIRING the reveal needs, read from the component (no DOM here; tests/user-message.spec.ts drives it in a
 *      browser with the setting on and counts the reveal's frames: none): useSmoothText reads the live setting and
 *      animates only while streaming AND not reduced, so with the setting on it never asks for a frame and returns the
 *      full text.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-reduced-motion.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
let passed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    console.error(`  FAIL ${what}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
};

let rm = null;
try {
  rm = await import("../lib/reduced-motion.ts");
} catch (e) {
  console.error(`  FAIL lib/reduced-motion.ts loads\n${e.message}`);
  process.exitCode = 1;
}

/** A window whose matchMedia answers `matches` for the reduced-motion query, recording listeners. */
function fakeWindow(matches, { legacy = false } = {}) {
  const listeners = new Set();
  const asked = [];
  const list = {
    matches,
    media: "",
    ...(legacy
      ? { addListener: (cb) => listeners.add(cb), removeListener: (cb) => listeners.delete(cb) }
      : {
          addEventListener: (type, cb) => {
            assert.equal(type, "change");
            listeners.add(cb);
          },
          removeEventListener: (type, cb) => {
            assert.equal(type, "change");
            listeners.delete(cb);
          },
        }),
  };
  return { win: { matchMedia: (q) => (asked.push(q), list) }, listeners, asked, list };
}

console.log("\n1. The setting, read");

await check("matchMedia says the reduced-motion query matches: true; says it does not: false", () => {
  assert.ok(rm);
  const on = fakeWindow(true);
  assert.equal(rm.prefersReducedMotion(on.win), true);
  assert.deepEqual(on.asked, ["(prefers-reduced-motion: reduce)"]);
  assert.equal(rm.prefersReducedMotion(fakeWindow(false).win), false);
});

await check("no window, no matchMedia, a matchMedia that answers nothing or throws: false (the page's motion as before)", () => {
  assert.ok(rm);
  assert.equal(rm.prefersReducedMotion(undefined), false, "the server's render: no window");
  assert.equal(rm.prefersReducedMotion({}), false);
  assert.equal(rm.prefersReducedMotion({ matchMedia: () => undefined }), false);
  assert.equal(rm.prefersReducedMotion({ matchMedia: () => { throw new Error("no"); } }), false);
});

await check("the change is subscribed to and unsubscribed from (addEventListener, and the older addListener pair)", () => {
  assert.ok(rm);
  for (const legacy of [false, true]) {
    const w = fakeWindow(false, { legacy });
    let called = 0;
    const off = rm.subscribeReducedMotion(() => (called += 1), w.win);
    assert.equal(w.listeners.size, 1, `legacy=${legacy}`);
    for (const cb of w.listeners) cb();
    assert.equal(called, 1);
    off();
    assert.equal(w.listeners.size, 0, `legacy=${legacy}: unsubscribed`);
  }
  const off = rm.subscribeReducedMotion(() => {}, undefined);
  assert.equal(typeof off, "function", "no window: a no-op unsubscribe");
  off();
});

console.log("\n2. The reveal's wiring (app/_components/agent-message.tsx)");

const SRC = readFileSync(`${ROOT}app/_components/agent-message.tsx`, "utf8");
const hook = (() => {
  const start = SRC.indexOf("function useSmoothText(");
  assert.ok(start >= 0, "useSmoothText is in agent-message.tsx");
  const end = SRC.indexOf("\nfunction ", start + 1);
  return SRC.slice(start, end);
})();

await check("useSmoothText reads the live setting (useReducedMotion from lib/reduced-motion.ts)", () => {
  assert.match(SRC, /import \{[^}]*\buseReducedMotion\b[^}]*\} from "@\/lib\/reduced-motion"/);
  assert.match(SRC, /import \{[^}]*\bprefersReducedMotion\b[^}]*\} from "@\/lib\/reduced-motion"/);
  assert.match(hook, /const reduced = useReducedMotion\(\);/);
});

await check("it animates only while streaming and not reduced: every frame, and what it returns, hang on that one flag", () => {
  assert.match(hook, /const enabled = streaming && !reduced;/);
  // The effect snaps (no frame asked) whenever `enabled` is false, and the hook returns the full text then.
  // The effect reads the setting itself as well: the hydration render takes the server's reading (false), and the
  // effect after it runs before the re-render with the real one (the batched CI saw that one frame asked for).
  assert.match(hook, /if \(!enabled \|\| prefersReducedMotion\(\) \|\| !target\.startsWith\(shownRef\.current\)\) \{[\s\S]*?cancelAnimationFrame\(rafRef\.current\);[\s\S]*?setShown\(target\);[\s\S]*?return;/);
  assert.match(hook, /return enabled \? shown : target;/);
  assert.match(hook, /\}, \[target, enabled\]\);/, "the effect re-runs when the setting changes mid-stream");
  // The only frames it asks for are its own loop's, after that check.
  const asks = [...hook.matchAll(/requestAnimationFrame\(/g)].map((m) => m.index);
  const gate = hook.indexOf("if (!enabled ||");
  assert.ok(asks.length > 0 && asks.every((i) => i > gate));
});

console.log(`\ntest-reduced-motion: ${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
