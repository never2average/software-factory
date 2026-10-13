/**
 * Dictation (speech to text for writing a prompt): the route's rules, driven with a fake provider.
 *
 * The real handler (lib/dictation.ts `createDictationHandler`) is the one app/api/ops/dictation/route.ts serves; here
 * it gets fakes for the sign-in, the provider and the usage ledger, so nothing leaves the machine and no database or
 * Next runtime is needed. What it holds:
 *
 *   - signed out is 401, and a refused workspace (a request naming one the caller is not a member of) is passed on as
 *     the refusal, with the provider never called;
 *   - the usage row is filed under the workspace and person of the SIGN-IN, whatever the form says;
 *   - the limits: size (stated by the request, then actual), the length the recorder states, and the length the model
 *     measured (paid for, so recorded, and the text refused); an empty clip and a non-audio upload;
 *   - sections of one stretch of listening (`session_id`, `seq`): filed under them, bounded by `max_session_seconds`
 *     and a rate per minute before the paid call, counted in the caller's workspace only; a clip with neither is
 *     served exactly as before;
 *   - the cut into sections (lib/dictation-segmenter.ts): at a pause, at the length limits, with the pre-roll, losing
 *     no sample at a cut, deaf to a click and to a steady hum; the 16 kHz conversion and the WAV each section is;
 *   - the order (lib/dictation-order.ts): answers in any order read as spoken, and the landing place moves with the
 *     person's own edits;
 *   - the usage row (model, audio length, workspace, person), its price per audio minute, and that a ledger failure
 *     still gives the person their text;
 *   - a provider failure is a plain 502, records nothing, and never echoes the provider's credentials;
 *   - off by profile or without credentials: GET says so and POST is 404;
 *   - the Workers AI call: URL, bearer, body, the text and the measured length read back, an error without the token;
 *     for each of the three request shapes (lib/dictation-models.ts), and never for a model it does not know;
 *   - the deployment's own choice of model and language (ASR_MODEL, ASR_LANGUAGE, ASR_ENABLED), failing closed;
 *   - the profile's `asr` rules (scripts/gen-deployment-profile.mjs), the price table, the migration and the wiring:
 *     no audio is stored (the route imports no storage), the usage report counts dictations apart from turns.
 *
 * Run:  npm run test:dictation
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDictationHandler,
  DICTATION_SETTINGS,
  insertDictated,
  isAudioType,
  lengthText,
  microphoneErrorText,
  sizeText,
} from "../lib/dictation.ts";
import { cloudflareTranscriber, cloudflareTranscriberFromEnv } from "../lib/dictation-cloudflare.ts";
import { estimateAudioCostUsd, audioPriceForModel, estimateCostUsd, AUDIO_PRICES } from "../lib/inference-pricing.ts";
import { resolveAsrChoice, SPEECH_MODELS, speechModelProblem } from "../lib/dictation-models.ts";
import { createOrderBuffer, shiftAnchor, shiftCaret } from "../lib/dictation-order.ts";
import { createDownsampler, createSegmenter, encodeWav, level, SECTION_SAMPLE_RATE } from "../lib/dictation-segmenter.ts";
import { SESSION_SECTIONS_PER_MINUTE } from "../lib/dictation.ts";

const ROOT = new URL("..", import.meta.url).pathname;
let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label);
  passed++;
  console.log(`  ok   ${label}`);
};

const SETTINGS = { enabled: true, provider: "cloudflare", model: "@cf/openai/whisper-large-v3-turbo", language: null, maxSeconds: 120, maxBytes: 4 * 1024 * 1024, maxSessionSeconds: 600, idleStopSeconds: 20 };
const TOKEN_A = "Bearer token-of-ana";
const TOKEN_B = "Bearer token-of-bo";
/** Two people in two workspaces, and the one workspace each may name. */
const PEOPLE = { [TOKEN_A]: { orgId: "org-a", email: "ana@example.com" }, [TOKEN_B]: { orgId: "org-b", email: "bo@example.com" } };

function harness({ settings = SETTINGS, transcript = { text: "  Draft the weekly   summary  ", durationSeconds: 12.5 }, providerFails = false, ledgerFails = false, noProvider = false, totalsFail = false } = {}) {
  const log = { calls: [], rows: [], errors: [], totalsAsked: [] };
  const handler = createDictationHandler({
    settings,
    transcriber: noProvider
      ? null
      : {
          async transcribe(input) {
            log.calls.push(input);
            if (providerFails) throw new Error("Workers AI answered 500");
            return transcript;
          },
        },
    async authorize(request) {
      const who = PEOPLE[request.headers.get("authorization") ?? ""];
      if (!who) return null;
      // As orgContextForRequest: a named workspace is honoured only for a member, refused otherwise (never swapped).
      const named = request.headers.get("x-ops-org");
      if (named && named !== who.orgId) return new Response(JSON.stringify({ error: "workspace_refused" }), { status: 403 });
      return who;
    },
    async recordUsage(row) {
      if (ledgerFails) throw new Error("db down");
      log.rows.push(row);
    },
    // As lib/usage-report.ts readDictationSession: the rows already written for this stretch, in the caller's workspace.
    async sessionTotals(who, sessionId, now) {
      log.totalsAsked.push({ orgId: who.orgId, sessionId });
      if (totalsFail) throw new Error("db down");
      const mine = log.rows.filter((r) => r.orgId === who.orgId && r.sessionId === sessionId);
      return { audioMs: mine.reduce((n, r) => n + r.audioMs, 0), lastMinute: mine.filter((r) => now.getTime() - r.at.getTime() < 60_000).length };
    },
    newId: () => `id-${log.rows.length + 1}`,
    now: () => new Date("2026-10-11T10:00:00Z"),
    error: (message, error) => log.errors.push(`${message} ${error instanceof Error ? error.message : error}`),
  });
  return { handler, log };
}

function clip({ bytes = 2048, type = "audio/webm;codecs=opus", durationMs = 12_000, extra = {} } = {}) {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(bytes).fill(7)], { type }), "dictation.webm");
  if (durationMs !== null) form.append("duration_ms", String(durationMs));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}
const post = (form, headers = { authorization: TOKEN_A }) => new Request("http://local/api/ops/dictation", { method: "POST", headers, body: form });
const get = (headers = { authorization: TOKEN_A }) => new Request("http://local/api/ops/dictation", { headers });

/* ---- sign-in and workspace ------------------------------------------------------------------------------------------- */

console.log("Sign-in and workspace:");
{
  const { handler, log } = harness();
  let res = await handler.GET(get({}));
  check("GET signed out is 401", res.status === 401);
  res = await handler.POST(post(clip(), {}));
  check("POST signed out is 401, and the provider is never called", res.status === 401 && log.calls.length === 0);
  res = await handler.POST(post(clip(), { authorization: "Bearer forged" }));
  check("…an unverifiable token too", res.status === 401 && log.calls.length === 0);
  res = await handler.POST(post(clip(), { authorization: TOKEN_A, "x-ops-org": "org-b" }));
  check("naming a workspace the caller is not a member of is refused as it is (403), unserved", res.status === 403 && log.calls.length === 0 && log.rows.length === 0);
  res = await handler.POST(post(clip({ extra: { org: "org-b", org_id: "org-b", email: "bo@example.com" } })));
  check("a workspace or person in the FORM is ignored: the row is the sign-in's", res.status === 200 && log.rows.length === 1 && log.rows[0].orgId === "org-a" && log.rows[0].actorEmail === "ana@example.com");
  res = await handler.POST(post(clip(), { authorization: TOKEN_B }));
  check("another person's clip is filed in their own workspace", res.status === 200 && log.rows[1].orgId === "org-b" && log.rows[1].actorEmail === "bo@example.com");
}

/* ---- the answer and the usage row ------------------------------------------------------------------------------------ */

console.log("\nTranscription and usage:");
{
  const { handler, log } = harness();
  const res = await handler.POST(post(clip()));
  const body = await res.json();
  check("the text comes back, whitespace tidied", res.status === 200 && body.text === "Draft the weekly summary", JSON.stringify(body));
  check("…with the length the model measured", body.duration_ms === 12_500);
  check("the provider got the clip's bytes, type, the profile's model and language", log.calls.length === 1 && log.calls[0].audio.byteLength === 2048 && log.calls[0].mimeType.startsWith("audio/webm") && log.calls[0].model === SETTINGS.model && log.calls[0].language === null);
  const row = log.rows[0];
  check("one usage row: workspace, person, model, the audio's length", log.rows.length === 1 && row.orgId === "org-a" && row.actorEmail === "ana@example.com" && row.model === SETTINGS.model && row.audioMs === 12_500);
  check("the row carries no words and no audio", !("text" in row) && !("audio" in row) && Object.keys(row).sort().join(",") === "actorEmail,at,audioMs,id,model,orgId,seq,sessionId");
  check("a clip sent on its own (no session_id, no seq) is served as before: no session, nothing counted against one", row.sessionId === null && row.seq === null && log.totalsAsked.length === 0 && Object.keys(body).sort().join(",") === "duration_ms,text");
  check("the response is never cached", res.headers.get("cache-control") === "no-store");
}
{
  const { handler, log } = harness({ transcript: { text: "Hello", durationSeconds: null } });
  await handler.POST(post(clip({ durationMs: 7_400 })));
  check("no measured length from the model: the recorder's stated length is billed", log.rows[0].audioMs === 7_400);
}
{
  const { handler, log } = harness({ ledgerFails: true });
  const res = await handler.POST(post(clip()));
  check("the ledger failing still gives the person their text (and is logged)", res.status === 200 && (await res.json()).text === "Draft the weekly summary" && log.errors.some((e) => e.includes("usage could not be recorded")));
}
{
  const { handler } = harness({ transcript: { text: "   ", durationSeconds: 3 } });
  const res = await handler.POST(post(clip()));
  check("silence is an empty text (the button says no speech was heard), not an error", res.status === 200 && (await res.json()).text === "");
}
{
  const { handler, log } = harness({ providerFails: true });
  const res = await handler.POST(post(clip()));
  const body = await res.json();
  check("a provider failure is a plain 502", res.status === 502 && /could not be turned into text/.test(body.error));
  check("…records no usage", log.rows.length === 0);
}

/* ---- limits ---------------------------------------------------------------------------------------------------------- */

console.log("\nLimits:");
{
  const { handler, log } = harness();
  let res = await handler.POST(post(clip({ bytes: SETTINGS.maxBytes + 1 })));
  check("a clip over max_bytes is 413, provider never called", res.status === 413 && (await res.json()).code === "too_large" && log.calls.length === 0);
  const big = new Request("http://local/api/ops/dictation", { method: "POST", headers: { authorization: TOKEN_A, "content-length": String(SETTINGS.maxBytes * 3), "content-type": "multipart/form-data; boundary=x" }, body: "x" });
  res = await handler.POST(big);
  check("a request that SAYS it is too big is refused unread", res.status === 413 && log.calls.length === 0);
  res = await handler.POST(post(clip({ bytes: SETTINGS.maxBytes })));
  check("exactly max_bytes is accepted", res.status === 200);
  log.calls.length = 0;
  res = await handler.POST(post(clip({ durationMs: 120_000 + 2_001 })));
  check("a stated length past max_seconds (plus the 2 s grace) is 413 before the paid call", res.status === 413 && (await res.json()).code === "too_long" && log.calls.length === 0);
  res = await handler.POST(post(clip({ durationMs: 121_500 })));
  check("…a recorder's stop a moment past the limit is within the grace", res.status === 200);
  res = await handler.POST(post(clip({ bytes: 0 })));
  check("an empty clip is 400", res.status === 400 && (await res.json()).code === "empty");
  res = await handler.POST(post(clip({ type: "text/plain" })));
  check("a non-audio upload is 415", res.status === 415);
  const noAudio = new FormData();
  noAudio.append("duration_ms", "1000");
  res = await handler.POST(post(noAudio));
  check("no `audio` field is 400", res.status === 400);
  res = await handler.POST(new Request("http://local/api/ops/dictation", { method: "POST", headers: { authorization: TOKEN_A, "content-type": "application/json" }, body: "{}" }));
  check("not multipart is 400", res.status === 400);
}
{
  // The recorder lied (or a client did without one): the model measures 5 minutes. Paid for, so recorded; refused.
  const { handler, log } = harness({ transcript: { text: "a long speech", durationSeconds: 300 } });
  const res = await handler.POST(post(clip({ durationMs: 10_000 })));
  const body = await res.json();
  check("a clip the MODEL measures past the limit is 413 and its text is not returned", res.status === 413 && body.code === "too_long" && !("text" in body));
  check("…and its usage is still recorded (the call was paid for)", log.rows.length === 1 && log.rows[0].audioMs === 300_000);
}
{
  const { handler } = harness();
  const res = await handler.POST(post(clip({ durationMs: null })));
  check("a clip without a stated length is measured by the model", res.status === 200);
}
check("the limits in plain words", lengthText(120) === "2 minutes" && lengthText(60) === "1 minute" && lengthText(90) === "90 seconds" && lengthText(1) === "1 second" && lengthText(600) === "10 minutes" && sizeText(4 * 1024 * 1024) === "4 MB" && sizeText(512 * 1024) === "512 KB");
check("MediaRecorder's types are audio (Chromium's video/webm label too); others are not", isAudioType("audio/webm;codecs=opus") && isAudioType("audio/mp4") && isAudioType("video/webm") && isAudioType("audio/ogg; codecs=opus") && !isAudioType("text/plain") && !isAudioType("image/png") && !isAudioType(""));

/* ---- sections of one stretch of listening ---------------------------------------------------------------------------- */

console.log("\nSections (session_id, seq):");
const SESSION = "3f2b6c1e-8a4d-4f0e-9b7a-2c5d1e0f9a8b";
const section = (seq, { sessionId = SESSION, durationMs = 2_000, extra = {} } = {}) => clip({ type: "audio/wav", durationMs, extra: { session_id: sessionId, seq: String(seq), ...extra } });
{
  const { handler, log } = harness({ transcript: { text: "and send it", durationSeconds: 2 } });
  const res = await handler.POST(post(section(3)));
  const body = await res.json();
  check("a section is transcribed like any clip, and its stretch and place are echoed", res.status === 200 && body.text === "and send it" && body.session_id === SESSION && body.seq === 3 && body.duration_ms === 2_000, JSON.stringify(body));
  check("…a WAV is audio the provider takes", log.calls.length === 1 && log.calls[0].mimeType === "audio/wav");
  check("…its usage row carries the stretch and the place (and still no words, no audio)", log.rows.length === 1 && log.rows[0].sessionId === SESSION && log.rows[0].seq === 3 && log.rows[0].audioMs === 2_000 && !("text" in log.rows[0]));
  check("…the stretch's usage was read before the paid call, in the caller's own workspace", log.totalsAsked.length === 1 && log.totalsAsked[0].orgId === "org-a" && log.totalsAsked[0].sessionId === SESSION);
  await handler.POST(post(section(0)));
  await handler.POST(post(section(0)));
  check("sections may arrive in any order, and one sent twice is served twice (the ledger adds it to its row)", log.rows.length === 3 && log.rows.map((r) => r.seq).join() === "3,0,0");
}
{
  const { handler, log } = harness();
  const bad = [
    [section(0, { sessionId: "short" }), "bad_session"],
    [section(0, { sessionId: "../../etc/passwd-0000" }), "bad_session"],
    [section(0, { sessionId: "x".repeat(65) }), "bad_session"],
    [clip({ extra: { seq: "0" } }), "bad_session"],
    [clip({ extra: { session_id: SESSION } }), "bad_seq"],
    [section("-1"), "bad_seq"],
    [section("1.5"), "bad_seq"],
    [section("10000"), "bad_seq"],
    [section("two"), "bad_seq"],
  ];
  for (const [form, code] of bad) {
    const res = await handler.POST(post(form));
    const body = await res.json();
    check(`refused before the paid call: ${code} (${form.get("session_id") ?? "no session_id"}, seq ${form.get("seq") ?? "none"})`, res.status === 400 && body.code === code && log.calls.length === 0 && log.rows.length === 0, JSON.stringify(body));
  }
  const res = await handler.POST(post(section(9_999)));
  check("seq 9999 is the last one accepted", res.status === 200);
}
{
  // max_session_seconds 10: five 2-second sections fill it; the sixth is refused before it is paid for.
  const { handler, log } = harness({ settings: { ...SETTINGS, maxSessionSeconds: 10 }, transcript: { text: "words", durationSeconds: 2 } });
  for (let i = 0; i < 5; i++) {
    const res = await handler.POST(post(section(i)));
    check(`session limit: section ${i} of a 10 s stretch (${i * 2} s used) is served`, res.status === 200);
  }
  const calls = log.calls.length;
  const res = await handler.POST(post(section(5)));
  const body = await res.json();
  check("…past max_session_seconds the next section is 429 session_limit, in plain words", res.status === 429 && body.code === "session_limit" && /limit of 10 seconds of dictation in one go/.test(body.error) && !("text" in body), JSON.stringify(body));
  check("…refused BEFORE the paid call, and nothing recorded for it", log.calls.length === calls && log.rows.length === 5);
  const other = await handler.POST(post(section(0, { sessionId: "another-stretch-0001" })));
  check("…a new stretch (the person pressed the microphone again) starts from nothing", other.status === 200);
  const theirs = await handler.POST(post(section(0), { authorization: TOKEN_B }));
  check("…and another workspace sending the SAME session id is not limited by this one's audio, nor filed with it", theirs.status === 200 && log.rows.at(-1).orgId === "org-b" && log.totalsAsked.at(-1).orgId === "org-b");
  const plain = await handler.POST(post(clip()));
  check("…a clip with no session is never counted against one", plain.status === 200);
}
{
  const { handler, log } = harness({ transcript: { text: "w", durationSeconds: 0.3 } });
  let last = 200;
  for (let i = 0; i < SESSION_SECTIONS_PER_MINUTE; i++) last = (await handler.POST(post(section(i, { durationMs: 300 })))).status;
  check(`rate: ${SESSION_SECTIONS_PER_MINUTE} sections of one stretch within a minute are served`, last === 200 && log.rows.length === SESSION_SECTIONS_PER_MINUTE);
  const res = await handler.POST(post(section(SESSION_SECTIONS_PER_MINUTE, { durationMs: 300 })));
  const body = await res.json();
  check("…the next is 429 rate_limited before the paid call", res.status === 429 && body.code === "rate_limited" && log.calls.length === SESSION_SECTIONS_PER_MINUTE, JSON.stringify(body));
}
{
  const { handler, log } = harness({ totalsFail: true });
  const res = await handler.POST(post(section(0)));
  check("the ledger unreadable: the section is still served, and it is logged", res.status === 200 && log.errors.some((e) => e.includes("session's usage could not be read")));
}
{
  // The per-clip limits still hold for a section.
  const { handler, log } = harness();
  let res = await handler.POST(post(section(0, { durationMs: 120_000 + 2_001 })));
  check("a section's own length and size limits are the clip's", res.status === 413 && (await res.json()).code === "too_long" && log.calls.length === 0);
  const big = new FormData();
  big.append("audio", new Blob([new Uint8Array(SETTINGS.maxBytes + 1)], { type: "audio/wav" }), "dictation.wav");
  big.append("session_id", SESSION);
  big.append("seq", "0");
  res = await handler.POST(post(big));
  check("…too large is 413 too, unsent", res.status === 413 && log.calls.length === 0);
}

/* ---- the cut into sections ------------------------------------------------------------------------------------------- */

console.log("\nThe cut into sections (lib/dictation-segmenter.ts):");
const RATE = SECTION_SAMPLE_RATE;
const n = (ms) => Math.round((ms * RATE) / 1000);
/** A voice-like stretch: loud, with a value that says where in the stream each sample came from. */
function audio(parts) {
  const out = new Float32Array(parts.reduce((sum, [ms]) => sum + n(ms), 0));
  let at = 0;
  for (const [ms, amp] of parts) {
    for (let i = 0; i < n(ms); i++, at++) out[at] = amp === 0 ? 0 : (at % 2 ? -1 : 1) * (amp + ((at % 997) / 997) * 0.01);
  }
  return out;
}
function cut(samples, options = {}, { chunk = 0, flush = false } = {}) {
  const sections = [];
  const seg = createSegmenter(options, (s) => sections.push(s));
  if (chunk) for (let i = 0; i < samples.length; i += chunk) seg.push(samples.subarray(i, i + chunk));
  else seg.push(samples);
  if (flush !== null) seg.flush(flush);
  return { sections, seg };
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
{
  const { sections, seg } = cut(audio([[500, 0], [1000, 0.2], [1000, 0], [1500, 0.2], [300, 0]]), {}, { flush: null });
  check("a pause of 600 ms closes a section: speech, a second of quiet, speech gives the first section while the second is still being said", sections.length === 1 && sections[0].seq === 0 && sections[0].reason === "pause" && seg.speaking === true, JSON.stringify(sections.map((s) => [s.durationMs, s.reason])));
  check("…it holds the speech, the pre-roll before it and a short tail after it, not the pause", near(sections[0].durationMs, 1000 + 240 + 200, 60) && near(sections[0].voicedMs, 1000, 40), `${sections[0].durationMs} ms, voiced ${sections[0].voicedMs}`);
  const lead = sections[0].samples.findIndex((v) => Math.abs(v) > 0.1);
  check("…the section starts BEFORE the voice was noticed (the first consonant is not clipped)", near((lead * 1000) / RATE, 240, 30), `${(lead * 1000) / RATE} ms of lead-in`);
  seg.flush();
  check("the person stops: what was being said is the last section", sections.length === 2 && sections[1].seq === 1 && sections[1].reason === "stop" && near(sections[1].voicedMs, 1500, 40), JSON.stringify(sections.map((s) => [s.durationMs, s.reason])));
  check("…and nothing is listening any more", seg.speaking === false && seg.sections === 2 && near(seg.totalMs, 4300, 1));
}
{
  const { sections } = cut(audio([[300, 0], [800, 0.2], [400, 0], [800, 0.2], [900, 0]]));
  check("a 400 ms breath inside a sentence does not split it", sections.length === 1 && near(sections[0].voicedMs, 1600, 40) && sections[0].reason === "pause", JSON.stringify(sections.map((s) => [s.durationMs, s.voicedMs])));
}
{
  const input = audio([[200, 0], [25_000, 0.2], [1000, 0]]);
  const { sections } = cut(input);
  check("someone who never pauses: cut at 10 seconds whatever is being said", sections.length === 3 && sections.every((s) => s.durationMs <= 10_000) && sections[0].reason === "length" && sections[1].reason === "length" && sections[2].reason === "pause", JSON.stringify(sections.map((s) => [s.durationMs, s.reason])));
  const joined = new Float32Array(sections.reduce((sum, s) => sum + s.samples.length, 0));
  let at = 0;
  for (const s of sections) {
    joined.set(s.samples, at);
    at += s.samples.length;
  }
  const from = input.findIndex((v, i) => v === joined[0] && input[i + 1] === joined[1] && input[i + 500] === joined[500]);
  let same = from >= 0;
  for (let i = 0; same && i < joined.length; i++) same = input[from + i] === joined[i];
  check("…and a cut loses nothing and repeats nothing: the sections laid end to end are the microphone's own samples", same, `from ${from}`);
}
{
  const { sections } = cut(audio([[200, 0], [8_100, 0.2], [300, 0], [1_200, 0.2], [900, 0]]));
  check("past 8 seconds the first short breath is taken as the cut, rather than waiting to break mid-word at 10", sections.length === 2 && sections[0].reason === "length" && near(sections[0].durationMs, 8_100 + 240 + 200, 80) && sections[1].reason === "pause", JSON.stringify(sections.map((s) => [s.durationMs, s.reason])));
}
{
  const { sections } = cut(audio([[200, 0], [12_000, 0.2], [900, 0]]), { hardMaxMs: 5_000, softMaxMs: 4_000 });
  check("a deployment with a shorter clip limit gets shorter sections", sections.length === 3 && sections.every((s) => s.durationMs <= 5_000), JSON.stringify(sections.map((s) => s.durationMs)));
}
{
  const { sections, seg } = cut(audio([[500, 0], [40, 0.5], [1500, 0], [100, 0.3], [1500, 0]]));
  check("a click or a cough is not speech: nothing is sent", sections.length === 0 && seg.sections === 0);
}
{
  const { sections, seg } = cut(audio([[10_000, 0.03]]), {}, { flush: null });
  check("a steady hum (a fan, a street) stops counting as a voice within a few seconds", seg.speaking === false && sections.length <= 1 && (sections[0]?.durationMs ?? 0) < 4_000, JSON.stringify(sections.map((s) => [s.durationMs, s.reason])));
  const before = sections.length;
  seg.push(audio([[1_000, 0.25], [800, 0.03]]));
  check("…and a voice over the hum is still heard", sections.length === before + 1 && near(sections.at(-1).voicedMs, 1_000, 80), JSON.stringify(sections.map((s) => [s.durationMs, s.voicedMs])));
}
{
  const quiet = audio([[2_000, 0.004]]);
  check("press-to-talk on a very quiet microphone: what was recorded is sent anyway, for the model to decide", (() => {
    const { sections } = cut(quiet, { keepUnvoiced: true }, { flush: true });
    return sections.length === 1 && sections[0].reason === "unvoiced" && near(sections[0].durationMs, 2_000, 20) && sections[0].seq === 0;
  })());
  check("…hands-free, silence is simply silence: nothing is sent", cut(quiet, { keepUnvoiced: true }, { flush: false }).sections.length === 0 && cut(quiet, {}, { flush: true }).sections.length === 0);
  check("…and a hold too short to hold anything sends nothing", cut(audio([[300, 0.004]]), { keepUnvoiced: true }, { flush: true }).sections.length === 0);
  const { sections } = cut(audio([[15_000, 0.004]]), { keepUnvoiced: true }, { flush: true });
  check("…never more than one section's length of it", sections.length === 1 && sections[0].durationMs <= 10_000);
  const spoke = cut(audio([[300, 0], [900, 0.2], [2_000, 0]]), { keepUnvoiced: true }, { flush: true });
  check("…and not at all once a real section has gone", spoke.sections.length === 1 && spoke.sections[0].reason === "pause");
}
{
  const { seg } = cut(audio([[300, 0], [900, 0.2], [3_000, 0]]), {}, { flush: null });
  check("how long it has been quiet is counted from the last voice (what hands-free listening stops itself on)", near(seg.quietMs, 3_000, 40) && near(seg.totalMs, 4_200, 1), `${seg.quietMs}`);
  seg.push(audio([[200, 0.2]]));
  check("…and a voice resets it", seg.quietMs < 40);
}
{
  const input = audio([[400, 0], [1_100, 0.2], [900, 0], [700, 0.2], [800, 0]]);
  const whole = cut(input).sections;
  const shape = (list) => JSON.stringify(list.map((s) => [s.seq, s.samples.length, s.reason]));
  check("the cut does not depend on how the samples arrive (one block, 128 at a time, 2048 at a time, an odd size)", [128, 2048, 777].every((chunk) => shape(cut(input, {}, { chunk }).sections) === shape(whole)) && whole.length === 2);
}
{
  const sine = (rate, ms, hz = 440) => Float32Array.from({ length: Math.round((rate * ms) / 1000) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const through = (rate, input, chunk) => {
    const down = createDownsampler(rate);
    const parts = [];
    for (let i = 0; i < input.length; i += chunk) parts.push(Float32Array.from(down(input.subarray(i, i + chunk))));
    const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const a = through(48_000, sine(48_000, 1_000), 2048);
  check("48 kHz down to 16 kHz: a third of the samples, across uneven blocks", near(a.length, 16_000, 1), `${a.length}`);
  check("…a 440 Hz tone keeps its loudness", near(level(a), 0.5 / Math.SQRT2, 0.02), `${level(a)}`);
  const b = through(44_100, sine(44_100, 1_000), 128);
  check("44.1 kHz (not a whole multiple) down to 16 kHz: a second is still a second", near(b.length, 16_000, 1) && near(level(b), 0.5 / Math.SQRT2, 0.02), `${b.length} ${level(b)}`);
  check("…the same samples whatever the block size", JSON.stringify([...through(44_100, sine(44_100, 200), 128)]) === JSON.stringify([...through(44_100, sine(44_100, 200), 4096)]));
  const same = new Float32Array([0.1, 0.2]);
  check("a microphone already at 16 kHz is passed through", createDownsampler(16_000)(same) === same);
}
{
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2]));
  const view = new DataView(wav.buffer);
  const tag = (at) => String.fromCharCode(...wav.subarray(at, at + 4));
  check("a section is a complete WAV file: header, 16 kHz, mono, 16-bit", tag(0) === "RIFF" && tag(8) === "WAVE" && tag(12) === "fmt " && tag(36) === "data" && view.getUint32(4, true) === wav.length - 8 && view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16_000 && view.getUint32(28, true) === 32_000 && view.getUint16(34, true) === 16 && view.getUint32(40, true) === 12 && wav.length === 44 + 12);
  const pcm = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
  check("…its samples little-endian, and anything too loud clipped, not wrapped", pcm.join() === "0,32767,-32768,16383,32767,-32768", pcm.join());
  check("…ten seconds of it is about 320 KB: far under the 4 MB limit and a Vercel function's 4.5 MB body", encodeWav(new Float32Array(10 * RATE)).length === 320_044 && 320_044 < DICTATION_SETTINGS.maxBytes);
}

/* ---- the order, and the landing place -------------------------------------------------------------------------------- */

console.log("\nThe order, and where the text lands (lib/dictation-order.ts):");
{
  const order = createOrderBuffer();
  check("the second section answered first is held back", order.settle(1, "two").length === 0 && order.held === 1 && order.next === 0);
  check("…and released, after the first, when the first is answered", order.settle(0, "one").join("|") === "one|two" && order.held === 0 && order.next === 2);
  check("a section in order goes straight through", order.settle(2, "three").join() === "three");
  order.settle(5, "six");
  order.settle(4, null);
  check("a section that failed or heard nothing (null) does not block the ones after it", order.settle(3, "four").join("|") === "four|six" && order.next === 6);
  check("an answer for a section already passed, or a second one for the same section, changes nothing", order.settle(1, "again").length === 0 && order.settle(7, "eight").length === 0 && order.settle(7, "other").length === 0 && order.settle(6, "seven").join("|") === "seven|eight");
  const reversed = createOrderBuffer();
  const out = [];
  for (const seq of [4, 3, 2, 1, 0]) out.push(...reversed.settle(seq, `s${seq}`));
  check("five answers in exactly the wrong order read in the right one", out.join() === "s0,s1,s2,s3,s4");
  const shuffled = createOrderBuffer();
  const got = [];
  for (const seq of [2, 0, 5, 1, 4, 3, 7, 6]) got.push(...shuffled.settle(seq, seq));
  check("…and any shuffle", got.join() === "0,1,2,3,4,5,6,7");
}
{
  const at = (start, end = start) => ({ start, end });
  const eq = (a, start, end = start) => a.start === start && a.end === end;
  check("typing after the landing place leaves it alone", eq(shiftAnchor(at(5), "Start end", "Start end, thanks"), 5));
  check("typing before it moves it along", eq(shiftAnchor(at(6), "Start end", "Note: Start end"), 12));
  check("deleting before it moves it back", eq(shiftAnchor(at(12), "Note: Start end", "Start end"), 6));
  check("typing exactly AT it puts it after what was typed (dictation carries on after the person's words)", eq(shiftAnchor(at(5), "Startend", "Start typed end"), 12) && eq(shiftAnchor(at(3), "abc", "abcdef"), 6));
  // " typed" after "Start", or "typed " before " end"? The same text either way; the person's cursor says which.
  check("…where the two texts cannot say where the typing was, the person's cursor does", eq(shiftAnchor(at(5), "Start end", "Start typed end", 11), 11) && eq(shiftAnchor(at(5), "Start end", "Start typed end", 12), 5) && eq(shiftAnchor(at(5), "Start end", "Start typed end"), 5));
  check("…and a cursor that fits no reading of the edit (the box was changed by something else) is not believed", eq(shiftAnchor(at(5), "Start end", "Start typed end", 2), 5) && eq(shiftAnchor(at(5), "Start end", "Start typed end", 99), 5));
  check("…a backspace in a run of the same letter, before or after it", eq(shiftAnchor(at(2), "aaaa", "aaa", 1), 1) && eq(shiftAnchor(at(2), "aaaa", "aaa", 3), 2));
  check("deleting the text it sits in moves it to where that text was", eq(shiftAnchor(at(8), "Start middle end", "Start end"), 6));
  check("a selection waiting to be replaced moves with the text around it", eq(shiftAnchor(at(6, 12), "Start middle end", "Oh. Start middle end"), 10, 16) && eq(shiftAnchor(at(6, 12), "Start middle end", "Start middle end!"), 6, 12));
  check("…and typing over that selection collapses it to after what was typed", eq(shiftAnchor(at(6, 12), "Start middle end", "Start x end"), 7));
  check("the message was sent and the box emptied: the landing place is the start of the new message", eq(shiftAnchor(at(9), "Start end", ""), 0));
  check("nothing changed: nothing moves", eq(shiftAnchor(at(3, 5), "abcdef", "abcdef"), 3, 5) && eq(shiftAnchor(at(30), "short", "short"), 5));
  check("the person's own cursor: before the new words it stays, after them it rides along, inside a replaced selection it goes after them", shiftCaret(2, 6, 6, 10) === 2 && shiftCaret(9, 6, 6, 10) === 19 && shiftCaret(6, 6, 6, 10) === 16 && shiftCaret(8, 6, 12, 4) === 10 && shiftCaret(14, 6, 12, 4) === 12);
}
{
  // The whole of it, as the button does it: three sections answered 2, 0, 1 while the person edits the box.
  let value = "Start end";
  let anchor = { start: 6, end: 6 };
  const order = createOrderBuffer();
  const land = (texts) => {
    for (const t of texts) {
      const r = insertDictated(value, anchor.start, anchor.end, t);
      value = r.value;
      anchor = { start: r.caret, end: r.caret };
    }
  };
  const edit = (next) => {
    anchor = shiftAnchor(anchor, value, next);
    value = next;
  };
  land(order.settle(2, "by Friday"));
  edit("Note: Start end");
  land(order.settle(0, "draft the summary"));
  edit("Note: Start draft the summary end, thanks");
  land(order.settle(1, "and send it"));
  check("sections answered out of order, with typing in between, read as spoken and around what was typed", value === "Note: Start draft the summary and send it by Friday end, thanks", value);
}

/* ---- off ------------------------------------------------------------------------------------------------------------- */

console.log("\nOff:");
{
  const { handler, log } = harness({ noProvider: true });
  let res = await handler.GET(get());
  check("no credentials: GET says off (the button stays hidden)", res.status === 200 && (await res.json()).enabled === false);
  res = await handler.POST(post(clip()));
  check("…and POST is 404", res.status === 404 && log.rows.length === 0);
}
{
  const { handler, log } = harness({ settings: { ...SETTINGS, enabled: false } });
  let res = await handler.GET(get());
  check("profile off: GET says off", (await res.json()).enabled === false);
  res = await handler.POST(post(clip()));
  check("…and POST is 404, provider never called", res.status === 404 && log.calls.length === 0);
}
{
  const { handler } = harness();
  const res = await handler.GET(get());
  const body = await res.json();
  check("on: GET says on, with the limits the button shows and keeps to", body.enabled === true && body.max_seconds === 120 && body.max_bytes === SETTINGS.maxBytes && body.max_session_seconds === 600 && body.idle_stop_seconds === 20 && Object.keys(body).length === 5);
}

/* ---- the Workers AI call --------------------------------------------------------------------------------------------- */

console.log("\nWorkers AI:");
{
  const seen = [];
  const t = cloudflareTranscriber({
    accountId: "acct123",
    apiToken: "secret-token-value",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: { text: " Hello there ", transcription_info: { duration: 4.2, language: "en" } } }), { status: 200 });
    },
  });
  const out = await t.transcribe({ audio: new Uint8Array([1, 2, 3, 250]), mimeType: "audio/webm", model: "@cf/openai/whisper-large-v3-turbo", language: "en" });
  const body = JSON.parse(seen[0].init.body);
  check("calls the run endpoint for the model on the account", seen[0].url === "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/openai/whisper-large-v3-turbo");
  check("with the bearer token in the header only", seen[0].init.headers.authorization === "Bearer secret-token-value" && !seen[0].init.body.includes("secret-token-value"));
  check("the clip as base64, transcribe, silence filtered, the language when set", body.audio === Buffer.from([1, 2, 3, 250]).toString("base64") && body.task === "transcribe" && body.vad_filter === true && body.language === "en");
  check("reads the text and the measured length", out.text === " Hello there " && out.durationSeconds === 4.2);
  await t.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/webm", model: "@cf/openai/whisper-large-v3-turbo", language: null });
  check("no language: none is sent (the model detects it)", !("language" in JSON.parse(seen[1].init.body)));
}
{
  const t = cloudflareTranscriber({
    accountId: "acct123",
    apiToken: "secret-token-value",
    fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid input" }] }), { status: 400 }),
  });
  const err = await t.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/webm", model: "@cf/openai/whisper-large-v3-turbo", language: null }).then(() => null, (e) => e);
  check("a refusal throws with the status and the provider's words, never the token", err instanceof Error && /400/.test(err.message) && /Invalid input/.test(err.message) && !err.message.includes("secret-token-value"));
}
{
  const seen = [];
  const t = cloudflareTranscriber({
    accountId: "acct123",
    apiToken: "secret-token-value",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: { text: " Older model ", word_count: 2, words: [{ word: "Older", start: 0, end: 0.4 }, { word: "model", start: 0.4, end: 0.9 }] } }), { status: 200 });
    },
  });
  const out = await t.transcribe({ audio: new Uint8Array([9, 8, 7]), mimeType: "audio/webm;codecs=opus", model: "@cf/openai/whisper", language: null });
  check("Whisper (older): the clip itself is the body, with the recorder's type", seen[0].url.endsWith("/ai/run/@cf/openai/whisper") && seen[0].init.headers["content-type"] === "audio/webm;codecs=opus" && Buffer.from(seen[0].init.body).equals(Buffer.from([9, 8, 7])));
  check("…its text is read back, and no clip length (word timings are not the clip's length)", out.text === " Older model " && out.durationSeconds === null);
}
{
  const seen = [];
  const t = cloudflareTranscriber({
    accountId: "acct123",
    apiToken: "secret-token-value",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: { results: { channels: [{ alternatives: [{ transcript: "Draft the memo.", confidence: 0.98 }] }] }, metadata: { duration: 3.5 } } }), { status: 200 });
    },
  });
  const out = await t.transcribe({ audio: new Uint8Array([4, 5]), mimeType: "audio/mp4", model: "@cf/deepgram/nova-3", language: "hi" });
  const u = new URL(seen[0].url);
  check("Nova-3: the clip as the body, formatted, in the language set", u.pathname.endsWith("/ai/run/@cf/deepgram/nova-3") && u.searchParams.get("smart_format") === "true" && u.searchParams.get("language") === "hi" && !u.searchParams.has("detect_language") && seen[0].init.headers["content-type"] === "audio/mp4" && Buffer.from(seen[0].init.body).equals(Buffer.from([4, 5])));
  check("…the bearer token in the header only", seen[0].init.headers.authorization === "Bearer secret-token-value" && !seen[0].url.includes("secret-token-value"));
  check("…reads the first alternative's transcript and the clip length", out.text === "Draft the memo." && out.durationSeconds === 3.5);
  const none = await t.transcribe({ audio: new Uint8Array([4]), mimeType: "", model: "@cf/deepgram/nova-3", language: null });
  const u2 = new URL(seen[1].url);
  check("…no language: it is asked to detect one; no type: sent as plain bytes", u2.searchParams.get("detect_language") === "true" && !u2.searchParams.has("language") && seen[1].init.headers["content-type"] === "application/octet-stream" && none.text === "Draft the memo.");
}
{
  let called = 0;
  const t = cloudflareTranscriber({ accountId: "a", apiToken: "t", fetch: async () => { called++; return new Response("{}"); } });
  const err = await t.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/webm", model: "@cf/unknown/asr", language: null }).then(() => null, (e) => e);
  check("a model it does not know how to call: refused, and never sent a guessed request", err instanceof Error && /not a speech model/.test(err.message) && called === 0);
}
check("no credentials: no transcriber", cloudflareTranscriberFromEnv({}) === null && cloudflareTranscriberFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: " " }) === null);
check("credentials the chat's models use: a transcriber (no new secret)", cloudflareTranscriberFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t\n" }) !== null);

/* ---- the composer's rules -------------------------------------------------------------------------------------------- */

console.log("\nThe composer:");
check("into an empty box: just the words", insertDictated("", 0, 0, " Hello ").value === "Hello");
{
  const r = insertDictated("Summarise for me", 9, 9, "the filing");
  check("at the cursor mid-text, spaced from both neighbours", r.value === "Summarise the filing for me" && r.caret === "Summarise the filing".length, JSON.stringify(r));
}
check("after a word at the end: one space before", insertDictated("Draft", 5, 5, "a note").value === "Draft a note");
check("over a selection: replaces it", insertDictated("Draft a memo now", 8, 12, "letter").value === "Draft a letter now");
check("next to existing spaces: no doubled space", insertDictated("Draft  now", 6, 6, "it").value === "Draft it now");
check("nothing heard: the box is unchanged", insertDictated("Keep", 4, 4, "  ").value === "Keep");
check("permission denied, in plain words", /blocked.*Allow the microphone/.test(microphoneErrorText({ name: "NotAllowedError" })));
check("no microphone, in plain words", /No microphone was found/.test(microphoneErrorText({ name: "NotFoundError" })));

/* ---- price, profile, migration, wiring ------------------------------------------------------------------------------- */

console.log("\nPrice, profile, migration, wiring:");
const pricing = readFileSync(join(ROOT, "lib/inference-pricing.ts"), "utf8");
check("the audio price cites its source and date", /developers\.cloudflare\.com\/workers-ai\/models\/whisper-large-v3-turbo/.test(pricing) && /2026-10-11/.test(pricing));
check("Whisper large v3 turbo is $0.000513 per audio minute", audioPriceForModel("@cf/openai/whisper-large-v3-turbo")?.perMinute === 0.000513);
check("a minute costs $0.000513; two minutes $0.001026", estimateAudioCostUsd("@cf/openai/whisper-large-v3-turbo", 60_000) === 0.000513 && estimateAudioCostUsd("@cf/openai/whisper-large-v3-turbo", 120_000) === 0.001026);
check("an unpriced speech model prices to null, never zero", estimateAudioCostUsd("@cf/unknown/asr", 60_000) === null && estimateCostUsd("@cf/openai/whisper-large-v3-turbo", { inputTokens: 1 }) === null);
check("the profile's model has a price (so a dictation is never an unpriced hole)", audioPriceForModel(DICTATION_SETTINGS.model) !== null);
check("the default profile: on, Workers AI, Whisper large v3 turbo, 2 minutes, 4 MB", DICTATION_SETTINGS.enabled === true && DICTATION_SETTINGS.provider === "cloudflare" && DICTATION_SETTINGS.model === "@cf/openai/whisper-large-v3-turbo" && DICTATION_SETTINGS.language === null && DICTATION_SETTINGS.maxSeconds === 120 && DICTATION_SETTINGS.maxBytes === 4 * 1024 * 1024);
check("…a stretch of listening up to 10 minutes, hands-free stopping after 20 seconds of silence", DICTATION_SETTINGS.maxSessionSeconds === 600 && DICTATION_SETTINGS.idleStopSeconds === 20);

check("every model dictation can call has a price per audio minute", Object.keys(SPEECH_MODELS).length >= 3 && Object.keys(SPEECH_MODELS).every((m) => audioPriceForModel(m) !== null));
check("Nova-3 is $0.0052 per audio minute (HTTP, not the WebSocket price), with its source", audioPriceForModel("@cf/deepgram/nova-3")?.perMinute === 0.0052 && /developers\.cloudflare\.com\/workers-ai\/models\/nova-3/.test(pricing));
check("a priced model is not enough: it must be one dictation can call", Object.keys(AUDIO_PRICES).every((m) => m in SPEECH_MODELS));
check("model and language rules", speechModelProblem("@cf/openai/whisper-large-v3-turbo", "hi") === null && speechModelProblem("@cf/deepgram/nova-3", "en") === null && speechModelProblem("@cf/openai/whisper", null) === null
  && /not a speech model/.test(speechModelProblem("@cf/unknown/asr", null)) && /takes no language/.test(speechModelProblem("@cf/openai/whisper", "en"))
  && /does not transcribe "ta"/.test(speechModelProblem("@cf/deepgram/nova-3", "ta")) && /two-letter/.test(speechModelProblem("@cf/openai/whisper-large-v3-turbo", "english")));
{
  const base = DICTATION_SETTINGS;
  let r = resolveAsrChoice(base, {});
  check("no ASR_* in the environment: the profile's choice", r.problem === null && r.settings === base);
  r = resolveAsrChoice(base, { ASR_MODEL: " @cf/deepgram/nova-3 ", ASR_LANGUAGE: "en" });
  check("ASR_MODEL and ASR_LANGUAGE choose the model and language", r.problem === null && r.settings.enabled === true && r.settings.model === "@cf/deepgram/nova-3" && r.settings.language === "en" && r.settings.maxSeconds === base.maxSeconds && Object.isFrozen(r.settings));
  r = resolveAsrChoice({ ...base, language: "hi" }, { ASR_LANGUAGE: "auto" });
  check("ASR_LANGUAGE=auto: the model detects the language, over a profile's", r.problem === null && r.settings.language === null);
  r = resolveAsrChoice(base, { ASR_MODEL: "", ASR_LANGUAGE: "  " });
  check("blank values: the profile's", r.problem === null && r.settings.model === base.model && r.settings.language === base.language);
  r = resolveAsrChoice(base, { ASR_MODEL: "@cf/unknown/asr" });
  check("an unknown model fails closed: dictation off, and the reason names the variable", r.settings.enabled === false && /dictation is off: "@cf\/unknown\/asr" is not a speech model.*\(set by ASR_MODEL\)/.test(r.problem), r.problem);
  r = resolveAsrChoice(base, { ASR_MODEL: "@cf/openai/whisper", ASR_LANGUAGE: "en" });
  check("a language the model cannot take fails closed", r.settings.enabled === false && /takes no language.*ASR_MODEL and ASR_LANGUAGE/.test(r.problem), r.problem);
  r = resolveAsrChoice(base, { ASR_ENABLED: "false", ASR_MODEL: "@cf/unknown/asr" });
  check("ASR_ENABLED=false: off, nothing else checked", r.settings.enabled === false && r.problem === null);
  r = resolveAsrChoice(base, { ASR_ENABLED: "yes" });
  check("ASR_ENABLED other than true/false fails closed", r.settings.enabled === false && /ASR_ENABLED must be "true" or "false"/.test(r.problem));
  r = resolveAsrChoice({ ...base, enabled: false }, { ASR_ENABLED: "true" });
  check("ASR_ENABLED=true turns on a profile's dictation that is off", r.problem === null && r.settings.enabled === true);
  const { handler } = harness({ settings: resolveAsrChoice(SETTINGS, { ASR_MODEL: "@cf/unknown/asr" }).settings });
  const res = await handler.GET(get());
  check("…and a deployment whose choice failed closed shows no microphone", (await res.json()).enabled === false);
}

const GEN = join(ROOT, "scripts/gen-deployment-profile.mjs");
function generate(overlay) {
  const dir = mkdtempSync(join(tmpdir(), "asr-profile-"));
  try {
    copyFileSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    writeFileSync(join(dir, "50-probe.json"), JSON.stringify(overlay));
    return spawnSync(process.execPath, [GEN, "--print"], { env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const ok = generate({ asr: { enabled: false, language: "hi", max_seconds: 60 } });
  check("a profile turns it off, sets a language and a shorter limit", ok.status === 0 && JSON.parse(ok.stdout).asr.enabled === false && JSON.parse(ok.stdout).asr.language === "hi" && JSON.parse(ok.stdout).asr.max_seconds === 60 && JSON.parse(ok.stdout).asr.model === "@cf/openai/whisper-large-v3-turbo", ok.stderr);
  const longer = generate({ asr: { max_session_seconds: 1800, idle_stop_seconds: 45 } });
  check("a profile sets how long one stretch of listening may run and how long hands-free waits in silence", longer.status === 0 && JSON.parse(longer.stdout).asr.max_session_seconds === 1800 && JSON.parse(longer.stdout).asr.idle_stop_seconds === 45 && JSON.parse(longer.stdout).asr.max_seconds === 120, longer.stderr);
  const nova = generate({ asr: { model: "@cf/deepgram/nova-3", language: "hi" } });
  check("a profile picks another model dictation can call", nova.status === 0 && JSON.parse(nova.stdout).asr.model === "@cf/deepgram/nova-3", nova.stderr);
  const refused = [
    [{ asr: { enabled: "yes" } }, /asr\.enabled/],
    [{ asr: { provider: "browser" } }, /asr\.provider/],
    [{ asr: { model: "whisper" } }, /asr\.model/],
    [{ asr: { language: "English" } }, /asr\.language/],
    [{ asr: { max_seconds: 3600 } }, /asr\.max_seconds/],
    [{ asr: { max_bytes: 26 * 1024 * 1024 } }, /asr\.max_bytes.*10 MB/],
    [{ asr: { max_session_seconds: 5 } }, /asr\.max_session_seconds.*10 to 3600/],
    [{ asr: { max_session_seconds: 7200 } }, /asr\.max_session_seconds/],
    [{ asr: { max_session_seconds: "600" } }, /asr\.max_session_seconds/],
    [{ asr: { idle_stop_seconds: 2 } }, /asr\.idle_stop_seconds.*5 to 120/],
    [{ asr: { idle_stop_seconds: 600 } }, /asr\.idle_stop_seconds/],
    [{ asr: { spoken_replies: true } }, /asr\.spoken_replies: unknown key/],
    [{ asr: { model: "@cf/unknown/asr" } }, /asr: "@cf\/unknown\/asr" is not a speech model dictation can call/],
    [{ asr: { model: "@cf/openai/whisper", language: "en" } }, /asr: @cf\/openai\/whisper takes no language/],
    [{ asr: { model: "@cf/deepgram/nova-3", language: "ta" } }, /asr: @cf\/deepgram\/nova-3 does not transcribe "ta"/],
  ];
  for (const [overlay, said] of refused) {
    const r = generate(overlay);
    check(`refused at build: ${JSON.stringify(overlay.asr)}`, r.status !== 0 && said.test(r.stderr), r.stderr);
  }
}

const migration = readFileSync(join(ROOT, "drizzle/0039_dictation_usage.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const schema = readFileSync(join(ROOT, "agent/lib/db/schema.ts"), "utf8");
check("the migration adds kind and audio_ms with defaults, idempotently, touching no policy", /ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'chat' NOT NULL/.test(migration) && /ADD COLUMN IF NOT EXISTS "audio_ms" bigint DEFAULT 0 NOT NULL/.test(migration) && !/POLICY|DROP|DELETE|UPDATE "/.test(migration.replace(/^--.*$/gm, "")));
check("…is in the journal migrate-production applies", journal.entries.some((e) => e.tag === "0039_dictation_usage" && e.idx === 39));
check("…and the schema the app reads has both", /kind: text\("kind"\)\.notNull\(\)\.default\("chat"\)/.test(schema) && /audioMs: bigint\("audio_ms", \{ mode: "number" \}\)\.notNull\(\)\.default\(0\)/.test(schema));

const route = readFileSync(join(ROOT, "app/api/ops/dictation/route.ts"), "utf8");
check("the route takes the deployment's own choice over the profile's, and says why when it fails closed", /resolveAsrChoice\(DICTATION_SETTINGS, process\.env\)/.test(route) && /settings,\n/.test(route) && /console\.error\(`\[dictation\] \$\{problem\}`\)/.test(route));
check("the route serves the tested handler", /createDictationHandler\(/.test(route) && /export async function POST\(request: NextRequest\) \{\s*return handler\.POST\(request\);/.test(route));
const ledger = readFileSync(join(ROOT, "lib/usage-report.ts"), "utf8");
check("…its workspace is the sign-in's (orgContextForRequest), its row written inside that workspace's RLS scope", /orgContextForRequest\(request\)/.test(route) && /recordDictationUsage\(row\)/.test(route) && /withOrgRls\(row\.orgId,/.test(ledger) && /kind: "dictation"/.test(ledger));
check("no audio is kept: the route and its ledger import no storage and write no file", ![route, ledger].some((src) => /dataroom|storage|writeFile|@vercel\/blob|put\(/i.test(src.replace(/^\s*(\*|\/\/).*$/gm, ""))));
const usage = readFileSync(join(ROOT, "app/api/ops/usage/route.ts"), "utf8");
check("the usage report counts dictations apart from turns and prices them per audio minute (behaviour: scripts/test-dictation-usage-db.mjs)", /readUsage\(ctx\.orgId, since\)/.test(usage) && /groupBy\(day, chatTurnUsage\.model, chatTurnUsage\.kind\)/.test(ledger) && /into\.dictations \+= g\.rows/.test(ledger) && /estimateAudioCostUsd\(model, g\.audio_ms\)/.test(ledger));
const composer = readFileSync(join(ROOT, "app/_components/composer.tsx"), "utf8");
const button = readFileSync(join(ROOT, "app/_components/dictation-button.tsx"), "utf8");
const engine = readFileSync(join(ROOT, "app/_components/dictation-engine.ts"), "utf8");
const worklet = readFileSync(join(ROOT, "public/dictation-capture.worklet.js"), "utf8");
check("both composers carry the microphone", /lazy\(\(\) => import\("\.\/dictation-slot"\)/.test(composer) && /<DictationSlot \/>/.test(composer));
check("nothing in dictation submits the form", ![button, engine].some((src) => /requestSubmit|\.submit\(|type="submit"/.test(src)));
check("no browser speech service and no recorder to restart: the Web Audio graph and the server only", /getUserMedia/.test(engine) && /audioWorklet\.addModule\(WORKLET_PATH\)/.test(engine) && /createScriptProcessor/.test(engine) && ![button, engine].some((src) => /SpeechRecognition|webkitSpeech|speechSynthesis|new MediaRecorder/.test(src)));
check("the microphone's tap is a file of this site's own, registering the processor the engine asks for", /WORKLET_PATH = "\/dictation-capture\.worklet\.js"/.test(engine) && /registerProcessor\("dictation-capture"/.test(worklet) && /new AudioWorkletNode\(ctx, "dictation-capture"/.test(engine));
check("each section goes up as a WAV of its own, with its stretch of listening and its place in it", /new Blob\(\[wav\], \{ type: "audio\/wav" \}\), "dictation\.wav"/.test(engine) && /form\.append\("session_id", sessionId\)/.test(engine) && /form\.append\("seq", String\(section\.seq\)\)/.test(engine) && /form\.append\("duration_ms"/.test(engine));
check("the button is one button: no strip, no Stop or Cancel beside it; the engine is fetched on a press, never imported", !/dictation-recording|Stop recording|Cancel recording/.test(button) && /import\("\.\/dictation-engine"\)/.test(button) && !/^import (?!type )[^;]*from "\.\/dictation-engine"/m.test(button));
check("hands-free is a pressed state a screen reader hears, each change is announced once, and Escape stops it", /aria-pressed=\{mode === "latched"\}/.test(button) && /role="status" aria-live="polite"/.test(button) && /e\.key !== "Escape"/.test(button));
check("reduced motion: the rings do not move, and the level is not read", /@media \(prefers-reduced-motion:reduce\)\{\.dictation-beat\{animation:none/.test(button) && /animate: !still/.test(button) && /if \(o\.animate\)/.test(engine));
const slot = readFileSync(join(ROOT, "app/_components/dictation-slot.tsx"), "utf8");
const imports = (src) => [...src.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((m) => m[1]);
const LIBS = ["lib/dictation-text.ts", "lib/dictation-segmenter.ts", "lib/dictation-order.ts"];
check(
  "…and what loads on demand imports only React and the import-free lib/dictation-*.ts (anything the first load also holds as a module of its own is split out into one more first-load file)",
  imports(button).join() === "react,react-dom,@/lib/dictation-order,@/lib/dictation-text,./dictation-engine" &&
    imports(engine).join() === "@/lib/dictation-order,@/lib/dictation-segmenter,@/lib/dictation-text" &&
    LIBS.every((f) => imports(readFileSync(join(ROOT, f), "utf8")).length === 0),
  `${imports(button).join()} | ${imports(engine).join()}`,
);
check("the button is not on the chat's first load: loaded only once the server says dictation is on", /lazy\(\(\) => import\("\.\/dictation-button"\)/.test(slot) && /<DictationButton capability=\{capability\} path=\{DICTATION_PATH\} authHeaders=\{dictationAuthHeaders\} \/>/.test(slot) && /capability\?\.enabled \?/.test(slot) && !/from "\.\/dictation-(button|slot|engine)"/.test(composer));
check("the ledger keys a section by workspace, stretch and place, adds a resent section to its row, and the route counts a stretch from the ledger", /`dictation:\$\{orgId\}:\$\{sessionId\}`/.test(ledger) && /turnId: sectioned \? `section-\$\{row\.seq\}` : "dictation"/.test(ledger) && /onConflictDoUpdate/.test(ledger) && /readDictationSession\(who\.orgId, sessionId, now\)/.test(route));

console.log(`\n${passed} checks passed.`);
