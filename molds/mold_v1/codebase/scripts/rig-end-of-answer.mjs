/**
 * THE END-OF-ANSWER ROW DURING A LONG TOOL CALL — a rig check, in a real browser, against the real agent.
 *
 * #52 put the copy / retry / feedback row under an answer only when the TURN is finished (`turnFinished`), not when
 * the eve store stops reading. Measured live on 2026-09-23 by sampling the page and calling a turn "live" if its text
 * had grown in the last two samples, 2 of 16 live samples still showed the row — but both were plausibly the sample in
 * which the turn legitimately ENDED, and text growth cannot tell "a tool is in flight" from "the turn just finished"
 * (mold_v1-111). This check uses the finer signal: the SERVER's own stream, read beside the page without a seam, says
 * exactly when the tool call started (`actions.requested`), when its result came back (`action.result`) and when the
 * turn ended (`turn.completed`). The page says what it decided (`[data-end-of-answer]`, the row;
 * `[role=log][data-turn]`, the verdict it was decided on; `data-stream-index`, how far it has read).
 *
 * What it does: sends a message the fake model answers with ONE long tool call (`--script long-tool`: eve's own
 * `bash` running `sleep 20`, or `--tool delegate`: a specialist that works for `--child-work-ms`), then a slowly
 * streamed answer — through a proxy that severs every stream segment (RIG_SEAM_MS) so the long silence spans several
 * detached stretches, which is exactly where the store looks idle. Sampling every 200 ms, it checks:
 *
 *   - while the server's tool call is IN FLIGHT, not one sample shows the row, and the page says `running`;
 *   - from the tool's start until the server's `turn.completed`, not one sample shows the row;
 *   - after `turn.completed` the row appears (within RIG_MAX_LAG_MS) and stays, and the page says `finished`;
 *   - enough samples fell inside the tool call for the first check to mean something (RIG_MIN_SAMPLES).
 *
 * SETUP: as scripts/rig-subagent-handback.mjs, with the model on a long tool call:
 *   node scripts/fake-model-server.mjs --port 8797 --script long-tool --tool bash --tool-seconds 20 &
 *   (or --tool delegate --child-work-ms 20000)
 *
 * RUN:  RIG_BASE=http://127.0.0.1:3110 [RIG_SEAM_MS=4000] [RIG_TOKEN=…] node scripts/rig-end-of-answer.mjs
 * Without RIG_BASE it says SKIPPED and exits 0.
 */
import { chromium } from "playwright";
import { checker, openChat, rigToken, seamProxy, serverTail } from "./lib/rig.mjs";

const BASE = process.env.RIG_BASE;
if (!BASE) {
  console.log("rig-end-of-answer: SKIPPED — needs RIG_BASE (the app, /eve/v1 routed to eve dev on the long-tool model). See the header.");
  process.exit(0);
}
const SEAM_MS = Number(process.env.RIG_SEAM_MS ?? 4_000);
const MAX_LAG_MS = Number(process.env.RIG_MAX_LAG_MS ?? 3_000);
const MIN_SAMPLES = Number(process.env.RIG_MIN_SAMPLES ?? 40);
const TOKEN = process.env.RIG_TOKEN ?? rigToken();
const auth = { authorization: `Bearer ${TOKEN}` };

const { check, finish } = checker("rig-end-of-answer");
const seam = await seamProxy(BASE, SEAM_MS);
const browser = await chromium.launch();
try {
  const { page, box, state } = await openChat(browser, seam.url, TOKEN);
  await box.fill(`End-of-answer check ${Date.now()}: run the long tool.`);
  await box.press("Enter");
  for (let i = 0; i < 200 && !state.sessionId; i++) await page.waitForTimeout(100);
  check("the send created a session", Boolean(state.sessionId));
  const truth = serverTail(BASE, state.sessionId, auth, (e) => e.type === "session.waiting" || e.type === "session.failed");

  const samples = [];
  let settledAt = 0;
  for (let i = 0; i < 1_500; i++) {
    const s = await page.evaluate(() => {
      const log = document.querySelector('[role="log"]');
      // The row's marker, or — on a build from before it — the row's own "Thumbs up" button, which only it has.
      const marked = document.querySelectorAll("[data-end-of-answer]").length;
      return {
        row: marked || log?.querySelectorAll('button[aria-label="Thumbs up"]').length || 0,
        turn: log?.getAttribute("data-turn") ?? null,
        index: Number(log?.getAttribute("data-stream-index") ?? -1),
      };
    });
    samples.push({ at: Date.now(), ...s });
    const ended = truth.events.find((x) => x.event.type === "turn.completed" && x.event.data?.turnId);
    if (ended && !settledAt) settledAt = Date.now();
    // Keep sampling a little past the end: the row has to APPEAR, and then stay.
    if (settledAt && Date.now() - settledAt > MAX_LAG_MS + 2_000) break;
    await page.waitForTimeout(200);
  }
  truth.stop();

  const at = (type, pred = () => true) => truth.events.find((x) => x.event.type === type && pred(x.event))?.at ?? 0;
  const toolStart = at("actions.requested");
  const toolEnd = at("action.result");
  const turnEnd = at("turn.completed");
  const inFlight = samples.filter((s) => toolStart && s.at > toolStart && s.at < (toolEnd || Number.POSITIVE_INFINITY));
  const beforeEnd = samples.filter((s) => toolStart && s.at > toolStart && s.at < (turnEnd || Number.POSITIVE_INFINITY));
  const after = samples.filter((s) => turnEnd && s.at > turnEnd + MAX_LAG_MS);
  const firstRow = samples.find((s) => turnEnd && s.at > turnEnd && s.row > 0);
  console.log(
    `  tool in flight ${toolStart && toolEnd ? ((toolEnd - toolStart) / 1000).toFixed(1) : "?"} s (${inFlight.length} samples); turn ended ${
      turnEnd && toolEnd ? ((turnEnd - toolEnd) / 1000).toFixed(1) : "?"
    } s after the result; row on screen ${firstRow ? `${firstRow.at - turnEnd} ms` : "never"} after the end; ${
      seam.streams.filter((s) => s.sessionId === state.sessionId).length
    } stream opens`,
  );

  check("the server ran the tool call and finished the turn", Boolean(toolStart && toolEnd && turnEnd));
  check(`enough samples fell inside the tool call (${inFlight.length} ≥ ${MIN_SAMPLES})`, inFlight.length >= MIN_SAMPLES);
  const shownInFlight = inFlight.filter((s) => s.row > 0);
  check("not one sample during the tool call shows the end-of-answer row", shownInFlight.length === 0, shownInFlight.slice(0, 3));
  const hasVerdict = samples.some((s) => s.turn !== null);
  if (hasVerdict) {
    check("…and the page says the turn is running throughout it", inFlight.every((s) => s.turn === "running"), inFlight.filter((s) => s.turn !== "running").slice(0, 3));
  } else console.log("  (this build does not expose data-turn: the verdict checks are skipped)");
  const shownEarly = beforeEnd.filter((s) => s.row > 0);
  check("not one sample before the server's turn.completed shows it", shownEarly.length === 0, shownEarly.slice(0, 3));
  check(`after the turn ends the row appears within ${MAX_LAG_MS} ms`, Boolean(firstRow) && firstRow.at - turnEnd < MAX_LAG_MS, firstRow ? firstRow.at - turnEnd : null);
  check(
    `…and stays${hasVerdict ? ", with the page saying finished" : ""}`,
    after.length > 0 && after.every((s) => s.row > 0 && (!hasVerdict || s.turn === "finished")),
    after.filter((s) => !(s.row > 0 && (!hasVerdict || s.turn === "finished"))).slice(0, 3),
  );
} finally {
  await browser.close();
  seam.close();
}
finish();
