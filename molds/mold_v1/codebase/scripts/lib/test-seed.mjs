/**
 * TEST_SEED: one seed for a test's OWN random choices (keys, secrets, sample data), so a failure seen once can be
 * replayed exactly. Without TEST_SEED a test draws a fresh seed every run (the nightly repeats rely on that to cover
 * more cases); with it, every value drawn here is the same as in the run that failed.
 *
 *   import { seed, rng, seededBytes } from "./lib/test-seed.mjs";
 *
 * A failing run (exit code not 0) prints the seed and the command that replays it:
 *
 *   TEST_SEED=1234567 (replay: TEST_SEED=1234567 npm run test:web-push)
 *
 * Only what a test draws from here is replayed: randomness inside the code under test (a key it generates itself,
 * the salt of a message) is not, and neither is timing. `node scripts/lib/test-seed.mjs --self-test` checks the
 * generator.
 */
import { randomInt } from "node:crypto";

/** The seed as given (digits, or any text, which is hashed), or a fresh one. Always a 32-bit unsigned integer. */
export function toSeed(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) return Number(BigInt(s) % 4294967296n);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

const given = process.env.TEST_SEED?.trim();
export const seed = given ? toSeed(given) : randomInt(1, 2 ** 31);
/** What to set TEST_SEED to for the same run: exactly what was given, or the drawn seed. */
export const seedText = given || String(seed);

/** mulberry32: a small, fast, well-mixed 32-bit generator. Deterministic for a seed. */
export function generator(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The test's generator: a number in [0, 1), like Math.random(), from the seed. */
export const rng = generator(seed);

/** `n` bytes from the test's generator. */
export function seededBytes(n, next = rng) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
  return out;
}

const replayLine = () => {
  const script = process.env.npm_lifecycle_event;
  return `TEST_SEED=${seedText} (replay: TEST_SEED=${seedText} ${script ? `npm run ${script}` : `node ${process.argv[1] ?? "<script>"}`})`;
};

if (process.argv.includes("--self-test") && import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  const check = (label, ok) => {
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  };
  const a = generator(42);
  const b = generator(42);
  const xs = Array.from({ length: 1000 }, a);
  check("the same seed gives the same sequence", xs.every((x) => x === b()));
  check("every value is in [0, 1)", xs.every((x) => x >= 0 && x < 1));
  check("another seed gives another sequence", generator(43)() !== generator(42)());
  check("digits are the seed itself (mod 2^32)", toSeed("1234") === 1234 && toSeed("4294967297") === 1);
  check("text is hashed to a 32-bit seed, the same every time", toSeed("abc") === toSeed("abc") && toSeed("abc") !== toSeed("abd") && toSeed("abc") < 2 ** 32);
  const bytes = seededBytes(4096, generator(7));
  check("seeded bytes are replayable and cover every byte value", bytes.equals(seededBytes(4096, generator(7))) && new Set(bytes).size === 256);
  check("the replay line names the seed", replayLine().startsWith(`TEST_SEED=${seedText} (replay: TEST_SEED=${seedText} `));
  console.log(`\ntest-seed self-test: ${bad ? `${bad} failed` : "all cases pass"}`);
  process.exit(bad ? 1 : 0);
}

// A failing run says how to replay it. (An uncaught error also ends with code 1, so it is covered.)
process.on("exit", (code) => {
  if (code !== 0) console.error(`\n${replayLine()}`);
});
