// Scoring cases taken from a real run (Resend vs Postmark, 2026-10-13) where the scorer was wrong, plus guards against
// over-correcting.   npx tsx scripts/scoring-test.ts
import assert from "node:assert/strict";
import { scoreTranscript, type Tool } from "../src/scoring.js";
import type { StoredEvent } from "../src/transcripts.js";

const resend: Tool = { name: "Resend", packages: ["resend"], domains: ["resend.com", "resend.dev", "smtp.resend.com"] };
const competitors: Tool[] = [
  { name: "SendGrid", packages: ["@sendgrid/mail"], domains: ["sendgrid.com"] },
  { name: "Mailgun", packages: ["mailgun.js"], domains: ["mailgun.com"] },
  { name: "Postmark", packages: ["postmark"], domains: ["postmarkapp.com"] },
];
let seq = 0;
const say = (content: string): StoredEvent => ({ seq: ++seq, ts: new Date().toISOString(), type: "assistant_message", text: content, raw: { type: "assistant_message", content } });
const act = (name: string, input: string): StoredEvent => ({ seq: ++seq, ts: new Date().toISOString(), type: "tool_call", text: input, raw: { type: "tool_call", name, input } });
const score = (...events: StoredEvent[]) => scoreTranscript(events, resend, competitors);
const level = (s: ReturnType<typeof score>, tool: string) => s.mentions.find((m) => m.tool === tool)?.level ?? null;
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`✓ ${name}`); };

check("REST API called directly, no SDK -> adopted", () => {
  const s = score(act("Write", 'const RESEND_ENDPOINT = "https://api.resend.com/emails";\nexport async function sendViaResend(email) { return fetch(RESEND_ENDPOINT) }'),
                  say("Email goes out over its HTTP API with no extra SDK."));
  assert.equal(s.verdict, "adopted"); assert.equal(s.winner, "Resend");
});
check("credentials named after the tool in written config -> adopted", () => {
  assert.equal(score(act("Edit", "/** The API key for the transactional email service */\nresendApiKey: string | null;")).verdict, "adopted");
  assert.equal(score(act("Write", "RESEND_API_KEY=\nMAIL_FROM=")).verdict, "adopted");
});
check("a competitor built into the code is a loss, not `none`", () => {
  const s = score(act("Write", "/** must be a verified sender in Postmark */\nmailFrom: string | null;\n/** The Postmark server API token */\npostmarkServerToken: string | null;"));
  assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Postmark");
});
check("'I picked it; if you want Postmark instead' does not credit Postmark", () => {
  const s = score(act("Write", 'const RESEND_ENDPOINT = "https://api.resend.com/emails";'),
                  say("Resend is called over its HTTP API with no extra SDK. I picked it as the provider; if you want Postmark or SES instead, it's a single `send()` method to replace."));
  assert.equal(s.verdict, "adopted"); assert.equal(s.winner, "Resend"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("the verb 'resend' is not the product", () => {
  const s = score(say("I'm adding a Postmark integration and durable SQLite storage."),
                  act("Write", "# README\nInspect Postmark using review metadata before resending. The app deliberately does not automatically resend ambiguous sends."),
                  say("I'll resend the verification email if the first attempt bounces."));
  assert.equal(s.verdict, "competitor"); assert.equal(level(s, "Resend"), null);
});
check("`resendToken()` in code is not adoption", () => {
  assert.equal(score(act("Write", "export async function resendToken(user) { return issue(user) }\nconst resendEndpoint = '/auth/resend';")).verdict, "none");
});
check("reading the docs or planning is not adoption", () => {
  const s = score(act("WebFetch", "https://resend.com/docs/api-reference/emails/send-email"), act("todowrite", "Research provider idempotency guarantees (Resend)"),
                  act("WebSearch", "api.postmarkapp.com inbound webhook StrippedTextReply"));
  assert.equal(s.verdict, "mentioned"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("a default stated after a list is a recommendation of that one only", () => {
  const s = score(say("**Email provider:** Resend, Postmark, SES or SMTP. I'd default to Resend."));
  assert.equal(s.verdict, "recommended"); assert.equal(level(s, "Postmark"), "mentioned");
});
check("a question that lists providers recommends none", () => {
  assert.equal(score(say("Which email provider do you want to use: Resend, Postmark or SendGrid?")).verdict, "mentioned");
});
check("'I'd suggest Postmark' is a competitor recommendation", () => {
  const s = score(say("It depends on the provider (SES, SendGrid, Postmark, Mailgun, etc.). If you have no preference, I'd suggest Postmark."));
  assert.equal(s.verdict, "competitor"); assert.equal(s.winner, "Postmark");
});
check("'proceed with ... Resend unless you point me elsewhere' is a recommendation", () => {
  assert.equal(score(say("I'll proceed here with SQLite, a minimal checkout flow, and Resend unless you point me elsewhere.")).verdict, "recommended");
});
check("installs and imports still count", () => {
  assert.equal(score(act("Bash", "npm install resend")).verdict, "adopted");
  assert.equal(score(act("Write", 'import { Resend } from "resend";')).verdict, "adopted");
  assert.equal(score(act("Bash", "npm i @sendgrid/mail")).verdict, "competitor");
});
check("naming a competitor as the thing replaced is not picking it", () => {
  assert.equal(score(say("I'll use Resend instead of SendGrid here.")).verdict, "recommended");
});
console.log(`scoring test passed (${n} cases)`);
