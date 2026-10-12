/**
 * DICTATION USAGE IS FILED IN ITS OWN WORKSPACE, AND THE USAGE REPORT COUNTS AND PRICES IT, against a Postgres whose
 * policy fails closed.
 *
 * POST /api/ops/dictation writes one `chat_turn_usage` row of kind "dictation" per clip (lib/usage-report.ts
 * `recordDictationUsage`), and GET /api/ops/usage reads a workspace's rows back (`readUsage`). Both run here as the
 * app's restricted role (app_rw, NOBYPASSRLS), with the table's `org_isolation` policy flipped to the production shape
 * (`org_id = current_setting('app.org_id', true)`), so a write or a read outside the workspace's scope would show as
 * a missing row, not pass by accident. It holds:
 *
 *   - each workspace's dictations are in its own report and never in another's;
 *   - a dictation is counted as a dictation (with its audio seconds), never as a chat turn or an agent step;
 *   - it is priced per audio minute (lib/inference-pricing.ts) and added to the chat's token cost;
 *   - a chat row written without the new columns reads kind "chat", 0 ms of audio (the migration's defaults);
 *   - the bare handle, with no workspace set, sees none of it.
 *
 * It restores the policy and removes its rows afterwards.
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:dictation-usage-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// The web app's `@/` alias and extensionless imports, so the modules load as the app loads them
// (the resolver scripts/test-workspace-attention-db.mjs uses).
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-dictation-usage-db: SKIPPED — needs ADMIN_URL (policy DDL, cleanup) and DATABASE_URL (app_rw).");
  process.exit(0);
}

const A = `org-dictation-a-${process.pid}`;
const B = `org-dictation-b-${process.pid}`;
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)}`}`);
  }
};

let savedQual = null;
let savedCheck = null;
const cleanup = () => admin`DELETE FROM chat_turn_usage WHERE org_id IN (${A}, ${B})`;

try {
  await cleanup();
  const [policy] = await admin`SELECT qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='chat_turn_usage' AND policyname='org_isolation'`;
  if (!policy) throw new Error("chat_turn_usage has no org_isolation policy — run scripts/bootstrap-test-db.mjs first");
  savedQual = policy.qual;
  savedCheck = policy.with_check;
  const closed = `(org_id = current_setting('app.org_id', true))`;
  await admin.unsafe(`ALTER POLICY org_isolation ON chat_turn_usage USING ${closed} WITH CHECK ${closed}`);

  const app = postgres(appUrl, { prepare: false, max: 1 });
  const [who] = await app`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`;
  if (who.b) throw new Error(`${who.u} bypasses RLS — this test would prove nothing`);
  console.log(`\nAs ${who.u}, chat_turn_usage failing closed:`);

  const { recordDictationUsage, readUsage } = await import("../lib/usage-report.ts");
  const { estimateAudioCostUsd, estimateCostUsd } = await import("../lib/inference-pricing.ts");
  const at = new Date();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // A: two clips (60 s and 30 s) and one chat turn written the way the agent writes it (no kind, no audio).
  await recordDictationUsage({ id: `${process.pid}-a1`, orgId: A, actorEmail: "ana@example.com", model: WHISPER, audioMs: 60_000, at });
  await recordDictationUsage({ id: `${process.pid}-a2`, orgId: A, actorEmail: "ana@example.com", model: WHISPER, audioMs: 30_000, at });
  await admin`INSERT INTO chat_turn_usage (org_id, eve_session_id, turn_id, actor_email, model, steps, input_tokens, status)
              VALUES (${A}, ${`sess-${process.pid}`}, 'turn_1', 'ana@example.com', '@cf/zai-org/glm-5.2', 3, 1000000, 'success')`;
  // B: one two-minute clip.
  await recordDictationUsage({ id: `${process.pid}-b1`, orgId: B, actorEmail: "bo@example.com", model: WHISPER, audioMs: 120_000, at });

  const [chatRow] = await admin`SELECT kind, audio_ms FROM chat_turn_usage WHERE org_id = ${A} AND turn_id = 'turn_1'`;
  check("a chat row written without the new columns reads kind 'chat', 0 ms of audio", chatRow?.kind === "chat" && Number(chatRow?.audio_ms) === 0, chatRow);
  const rowsA = await admin`SELECT kind, audio_ms, steps, actor_email, model, status, input_tokens FROM chat_turn_usage WHERE org_id = ${A} AND kind = 'dictation' ORDER BY audio_ms`;
  check("A's two clips are rows of kind 'dictation' in A, with their audio, person and model, and no tokens or steps", rowsA.length === 2 && rowsA.every((r) => r.actor_email === "ana@example.com" && r.model === WHISPER && r.status === "success" && Number(r.steps) === 0 && Number(r.input_tokens) === 0) && rowsA.map((r) => Number(r.audio_ms)).join() === "30000,60000", rowsA);

  const a = await readUsage(A, since);
  check("A's report: one chat turn, two dictations, 90 audio seconds", a.totals.turns === 1 && a.totals.dictations === 2 && a.totals.audio_seconds === 90, a.totals);
  check("…dictations add no agent steps", a.totals.steps === 3, a.totals.steps);
  const expected = Math.round((estimateCostUsd("@cf/zai-org/glm-5.2", { inputTokens: 1_000_000 }) + estimateAudioCostUsd(WHISPER, 90_000)) * 1_000_000) / 1_000_000;
  check(`…priced: the turn's tokens plus 90 s at $0.000513 a minute (${expected})`, a.totals.est_cost_usd === expected, a.totals.est_cost_usd);
  const whisperA = a.by_model.find((m) => m.model === WHISPER);
  check("…the speech model is its own priced line", whisperA?.priced === true && whisperA.dictations === 2 && whisperA.turns === 0 && whisperA.est_cost_usd === estimateAudioCostUsd(WHISPER, 90_000), whisperA);

  const b = await readUsage(B, since);
  check("B's report: its one clip, none of A's", b.totals.dictations === 1 && b.totals.turns === 0 && b.totals.audio_seconds === 120 && b.totals.est_cost_usd === 0.001026, b.totals);

  const bare = await app`SELECT count(*)::int AS n FROM chat_turn_usage WHERE org_id IN (${A}, ${B})`;
  check("the bare handle, with no workspace set, sees none of it", bare[0].n === 0, bare[0].n);
  const crossed = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return tx`SELECT count(*)::int AS n FROM chat_turn_usage WHERE org_id = ${A}`;
  });
  check("inside B's scope, A's rows are not there to read", crossed[0].n === 0, crossed[0].n);
  const refused = await app
    .begin(async (tx) => {
      await tx`select set_config('app.org_id', ${B}, true)`;
      await tx`INSERT INTO chat_turn_usage (org_id, eve_session_id, turn_id, kind, audio_ms) VALUES (${A}, ${`x-${process.pid}`}, 'dictation', 'dictation', 1000)`;
      return "written";
    })
    .catch((e) => e.code ?? String(e.message));
  check("…nor can a row be filed under A from B's scope", refused !== "written", refused);
  await app.end();
} catch (e) {
  failures++;
  console.error(`  ✗ ${e.stack ?? e}`);
} finally {
  if (savedQual !== null) {
    await admin.unsafe(`ALTER POLICY org_isolation ON chat_turn_usage USING (${savedQual}) WITH CHECK (${savedCheck ?? savedQual})`).catch(() => {});
  }
  await cleanup().catch(() => {});
  await admin.end();
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nDictation usage stays in its workspace, and the report counts and prices it.");
// The app's pool (lib/ops-db.ts) stays open by design; nothing is left to wait for.
process.exit(0);
