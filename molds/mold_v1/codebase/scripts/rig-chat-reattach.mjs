/**
 * DOES THE CHAT REATTACH AFTER A SEVERED SEGMENT? — a rig check, in a real browser, against the real agent.
 *
 * mold_v1-096 (2026-09-22): "the chat stream does not REATTACH after a severed segment": the store only read a stream
 * from `send()`, so a turn whose segment ended mid-reply was POLLED (resync + a full replay + a remount, backing off
 * to 15 s, a budget of 4) instead of TAILED, and automation_audit filed "ended mid-turn and stopped resuming". #59
 * (readLiveTail, attachDecision), #68 (a quiet seam is not a failure) and #63 (a hidden tab keeps reading) replaced
 * that with a reader that continues at the cursor. This holds it on screen.
 *
 * What it does: sends a message whose reply streams for ~10 s (the fake model's `slow-reply`), through a proxy that
 * ends every stream segment SEAM ms after it opens — production's ~120 s severance, compressed, so the reply is cut
 * several times mid-sentence. Meanwhile it reads the session's stream itself, without a seam: the server's record of
 * what was said and when. It samples the page every 150 ms and checks:
 *
 *   - the reply on screen ends EXACTLY as the server's `message.completed` says (nothing missing, nothing twice);
 *   - it only ever GREW: no sample is shorter than, or not a prefix of, a later one (re-reading events the transcript
 *     already holds rewinds the text — the reducer replaces a part, it does not append);
 *   - after every cut the stream was re-opened AT THE CURSOR: every re-open after the first has a startIndex > 0 and
 *     none goes backwards, and nothing fell back to a replay or a resync (no `resync`, `attach-failed` or
 *     `stream-gave-up` telemetry);
 *   - the page kept up: the end of the reply is on screen within RIG_MAX_LAG_MS of the server sending it.
 *
 * SETUP: as scripts/rig-subagent-handback.mjs, with the model on the slow reply:
 *   node scripts/fake-model-server.mjs --port 8797 --script slow-reply --chunks 12 --chunk-delay-ms 800 &
 *   (eve dev with CLOUDFLARE_BASE_URL=http://127.0.0.1:8797/v1 …, the app built and started, a front door that
 *    routes /eve/v1/* to eve — see that header.)
 *
 * RUN:  RIG_BASE=http://127.0.0.1:3110 [RIG_SEAM_MS=2500] [RIG_TOKEN=…] node scripts/rig-chat-reattach.mjs
 * Without RIG_BASE it says SKIPPED and exits 0.
 */
import { chromium } from "playwright";
import { checker, openChat, rigToken, seamProxy, serverTail } from "./lib/rig.mjs";

const BASE = process.env.RIG_BASE;
if (!BASE) {
  console.log("rig-chat-reattach: SKIPPED — needs RIG_BASE (the app, /eve/v1 routed to eve dev on the slow-reply model). See the header.");
  process.exit(0);
}
const SEAM_MS = Number(process.env.RIG_SEAM_MS ?? 2_500);
const MAX_LAG_MS = Number(process.env.RIG_MAX_LAG_MS ?? 3_000);
const END = process.env.RIG_END ?? "SLOW-REPLY END.";
const TOKEN = process.env.RIG_TOKEN ?? rigToken();
const auth = { authorization: `Bearer ${TOKEN}` };

const { check, finish } = checker("rig-chat-reattach");
const seam = await seamProxy(BASE, SEAM_MS);
const browser = await chromium.launch();
try {
  const { page, box, telemetry, state } = await openChat(browser, seam.url, TOKEN);
  await box.fill(`Reattach check ${Date.now()}: answer slowly.`);
  await box.press("Enter");
  const sentAt = Date.now();
  for (let i = 0; i < 200 && !state.sessionId; i++) await page.waitForTimeout(100);
  check("the send created a session", Boolean(state.sessionId));
  const truth = serverTail(BASE, state.sessionId, auth, (e) => e.type === "session.waiting" || e.type === "session.failed");

  const samples = [];
  let endAt = 0;
  for (let i = 0; i < 600 && !endAt; i++) {
    const text = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('[role="log"] .is-assistant, [role="log"] [class*="from-assistant"]')];
      const last = bubbles.at(-1);
      return last ? last.innerText : (document.querySelector('[role="log"]')?.innerText ?? "");
    });
    const at = Date.now();
    samples.push({ at, text });
    if (text.includes(END)) endAt = at;
    else await page.waitForTimeout(150);
  }
  await truth.done;
  const completed = truth.events.find((x) => x.event.type === "message.completed");
  const serverText = completed?.event?.data?.message ?? "";
  console.log(
    `  reply streamed ${completed ? ((completed.at - sentAt) / 1000).toFixed(1) : "?"} s; stream opened at startIndex ${seam.streams
      .filter((s) => s.sessionId === state.sessionId)
      .map((s) => s.startIndex)
      .join(" → ")}; on screen ${endAt ? `${((endAt - (completed?.at ?? endAt)) / 1000).toFixed(1)} s after the server finished it` : "never"}`,
  );

  check("the server finished the reply", Boolean(serverText.includes(END)));
  const shown = samples.at(-1)?.text ?? "";
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  check("the whole reply is on screen, exactly once", norm(shown).includes(norm(serverText)) && norm(shown).split(END).length === 2, norm(shown).slice(-200));
  const reply = (s) => {
    const i = norm(s).indexOf("SLOW-REPLY part 1.");
    return i < 0 ? "" : norm(s).slice(i);
  };
  let rewound = null;
  for (let i = 1; i < samples.length && !rewound; i++) {
    const a = reply(samples[i - 1].text);
    const b = reply(samples[i].text);
    if (a && !b.startsWith(a)) rewound = { at: i, before: a.slice(-80), after: b.slice(-80) };
  }
  check("the reply only ever grew (never rewound, never repeated)", rewound === null, rewound);

  const opens = seam.streams.filter((s) => s.sessionId === state.sessionId && s.at >= sentAt);
  const reopens = opens.slice(1);
  check(`the reply was cut mid-turn (${reopens.length} re-opens)`, reopens.length >= 2);
  check("every re-open continued at the cursor (startIndex > 0)", reopens.every((s) => s.startIndex > 0), reopens.map((s) => s.startIndex));
  check("…and none went backwards", reopens.every((s, i) => i === 0 || s.startIndex >= reopens[i - 1].startIndex), reopens.map((s) => s.startIndex));
  const bad = telemetry.filter((t) => t.at >= sentAt && /"(resync|attach-failed|stream-gave-up)"/.test(t.body));
  check("no replay, resync or give-up was needed", bad.length === 0, bad.map((t) => t.body.slice(0, 160)));
  const lag = endAt && completed ? endAt - completed.at : Number.POSITIVE_INFINITY;
  check(`the end of the reply was on screen within ${MAX_LAG_MS} ms of the server sending it`, lag < MAX_LAG_MS, lag);
} finally {
  await browser.close();
  seam.close();
}
finish();
