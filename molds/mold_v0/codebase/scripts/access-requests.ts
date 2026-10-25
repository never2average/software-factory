// List landing-page access requests, newest first: the shell's own fields and the answers to the build's own questions
// (mold_v0-102, src/access-request.ts), under their labels.
import { labelledAnswers } from "../src/access-request.js";
import { GENERATED_ACCESS_FIELDS } from "../src/access-request.generated.js";
import { getDb } from "../src/db.js";

const db = await getDb();
const rows = await db.query<Record<string, any>>(
  "SELECT created_at, email, company, message, answers FROM access_requests ORDER BY created_at DESC LIMIT 200",
);
console.table(rows.map(({ answers, ...r }) => ({ ...r, created_at: new Date(r.created_at).toISOString().slice(0, 16), message: String(r.message ?? "").slice(0, 60),
  answers: labelledAnswers(GENERATED_ACCESS_FIELDS, answers).map((a) => `${a.label}: ${a.text}`).join("; ").slice(0, 80) })));
await db.close();
