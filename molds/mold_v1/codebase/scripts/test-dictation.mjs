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
 *   - the usage row (model, audio length, workspace, person), its price per audio minute, and that a ledger failure
 *     still gives the person their text;
 *   - a provider failure is a plain 502, records nothing, and never echoes the provider's credentials;
 *   - off by profile or without credentials: GET says so and POST is 404;
 *   - the Workers AI call: URL, bearer, body, the text and the measured length read back, an error without the token;
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
import { estimateAudioCostUsd, audioPriceForModel, estimateCostUsd } from "../lib/inference-pricing.ts";

const ROOT = new URL("..", import.meta.url).pathname;
let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label);
  passed++;
  console.log(`  ok   ${label}`);
};

const SETTINGS = { enabled: true, provider: "cloudflare", model: "@cf/openai/whisper-large-v3-turbo", language: null, maxSeconds: 120, maxBytes: 4 * 1024 * 1024 };
const TOKEN_A = "Bearer token-of-ana";
const TOKEN_B = "Bearer token-of-bo";
/** Two people in two workspaces, and the one workspace each may name. */
const PEOPLE = { [TOKEN_A]: { orgId: "org-a", email: "ana@example.com" }, [TOKEN_B]: { orgId: "org-b", email: "bo@example.com" } };

function harness({ settings = SETTINGS, transcript = { text: "  Draft the weekly   summary  ", durationSeconds: 12.5 }, providerFails = false, ledgerFails = false, noProvider = false } = {}) {
  const log = { calls: [], rows: [], errors: [] };
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
  check("the row carries no words and no audio", !("text" in row) && !("audio" in row) && Object.keys(row).sort().join(",") === "actorEmail,at,audioMs,id,model,orgId");
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
check("the limits in plain words", lengthText(120) === "2 minutes" && lengthText(60) === "1 minute" && lengthText(90) === "90 seconds" && sizeText(4 * 1024 * 1024) === "4 MB" && sizeText(512 * 1024) === "512 KB");
check("MediaRecorder's types are audio (Chromium's video/webm label too); others are not", isAudioType("audio/webm;codecs=opus") && isAudioType("audio/mp4") && isAudioType("video/webm") && isAudioType("audio/ogg; codecs=opus") && !isAudioType("text/plain") && !isAudioType("image/png") && !isAudioType(""));

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
  check("on: GET says on, with the limits the button shows and keeps to", body.enabled === true && body.max_seconds === 120 && body.max_bytes === SETTINGS.maxBytes && Object.keys(body).length === 3);
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
  const refused = [
    [{ asr: { enabled: "yes" } }, /asr\.enabled/],
    [{ asr: { provider: "browser" } }, /asr\.provider/],
    [{ asr: { model: "whisper" } }, /asr\.model/],
    [{ asr: { language: "English" } }, /asr\.language/],
    [{ asr: { max_seconds: 3600 } }, /asr\.max_seconds/],
    [{ asr: { max_bytes: 26 * 1024 * 1024 } }, /asr\.max_bytes.*10 MB/],
    [{ asr: { spoken_replies: true } }, /asr\.spoken_replies: unknown key/],
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
check("the route serves the tested handler", /createDictationHandler\(/.test(route) && /export async function POST\(request: NextRequest\) \{\s*return handler\.POST\(request\);/.test(route));
const ledger = readFileSync(join(ROOT, "lib/usage-report.ts"), "utf8");
check("…its workspace is the sign-in's (orgContextForRequest), its row written inside that workspace's RLS scope", /orgContextForRequest\(request\)/.test(route) && /recordDictationUsage\(row\)/.test(route) && /withOrgRls\(row\.orgId,/.test(ledger) && /kind: "dictation"/.test(ledger));
check("no audio is kept: the route and its ledger import no storage and write no file", ![route, ledger].some((src) => /dataroom|storage|writeFile|@vercel\/blob|put\(/i.test(src.replace(/^\s*(\*|\/\/).*$/gm, ""))));
const usage = readFileSync(join(ROOT, "app/api/ops/usage/route.ts"), "utf8");
check("the usage report counts dictations apart from turns and prices them per audio minute (behaviour: scripts/test-dictation-usage-db.mjs)", /readUsage\(ctx\.orgId, since\)/.test(usage) && /groupBy\(day, chatTurnUsage\.model, chatTurnUsage\.kind\)/.test(ledger) && /into\.dictations \+= g\.rows/.test(ledger) && /estimateAudioCostUsd\(model, g\.audio_ms\)/.test(ledger));
const composer = readFileSync(join(ROOT, "app/_components/composer.tsx"), "utf8");
const button = readFileSync(join(ROOT, "app/_components/dictation-button.tsx"), "utf8");
check("both composers carry the microphone", /lazy\(\(\) => import\("\.\/dictation-slot"\)/.test(composer) && /<DictationSlot \/>/.test(composer));
check("the button never submits the form", !/requestSubmit|\.submit\(|type="submit"/.test(button));
check("no browser speech service: MediaRecorder and the server only", /MediaRecorder/.test(button) && !/SpeechRecognition|webkitSpeech|speechSynthesis/.test(button));
const slot = readFileSync(join(ROOT, "app/_components/dictation-slot.tsx"), "utf8");
const text = readFileSync(join(ROOT, "lib/dictation-text.ts"), "utf8");
const imports = (src) => [...src.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((m) => m[1]);
check("…and it imports only React and the import-free lib/dictation-text.ts (anything the first load also holds is split out into one more first-load file)", imports(button).join() === "react,@/lib/dictation-text" && imports(text).length === 0, imports(button).join());
check("the recorder is not on the chat's first load: loaded only once the server says dictation is on", /lazy\(\(\) => import\("\.\/dictation-button"\)/.test(slot) && /<DictationButton capability=\{capability\} path=\{DICTATION_PATH\} authHeaders=\{dictationAuthHeaders\} \/>/.test(slot) && /capability\?\.enabled \?/.test(slot) && !/from "\.\/dictation-(button|slot)"/.test(composer));

console.log(`\n${passed} checks passed.`);
