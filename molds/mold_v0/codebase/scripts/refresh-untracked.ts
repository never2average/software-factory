// Recompute agent_sessions.untracked from the stored transcripts (src/worker.ts refreshUntracked): for every scored
// session with installs on record, or with --all every scored session. Run after a change to src/scoring.ts
// untrackedInstalls.
//   DATABASE_URL=... npx tsx scripts/refresh-untracked.ts [--all]
import { getDb } from "../src/db.js";
import { refreshUntracked } from "../src/worker.js";

const db = await getDb();
const rows = await db.query<{ id: string; untracked: { name: string }[] }>(
  `/* tenant: internal: backfill, every account */ SELECT id, coalesce(untracked, '[]'::jsonb) AS untracked FROM agent_sessions WHERE verdict IS NOT NULL
   ${process.argv.includes("--all") ? "" : "AND jsonb_typeof(untracked) = 'array' AND jsonb_array_length(untracked) > 0"}`);
let changed = 0;
for (const r of rows) {
  const next = await refreshUntracked(r.id);
  if (next && JSON.stringify(next) !== JSON.stringify(r.untracked)) {
    changed++;
    console.log(`${r.id}: ${r.untracked.map((x) => x.name).join(" ") || "-"} -> ${next.map((x) => x.name).join(" ") || "-"}`);
  }
}
console.log(`${rows.length} sessions checked, ${changed} changed`);
process.exit(0);
