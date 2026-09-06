/**
 * Remove duplicate chat_threads rows left by the reconcile fork.
 *
 * The fork (fixed in app/api/ops/threads/route.ts) inserted a SECOND row for one
 * eve session whenever a chat's mount key changed — a fresh mount is `new-1`, a
 * reopened one is keyed by the stored id — so the same conversation could hold
 * two rows, one of them empty. In the share UI that is two entries for one
 * thread and a coin flip which one you open.
 *
 * SAFETY, because this deletes rows nobody can get back:
 *   * Only rows sharing (owner_email, eve_session_id) with another row are ever
 *     considered. A thread with no twin is never touched.
 *   * Within a group the KEEPER is the row with the most events, ties broken by
 *     most recently updated. The keeper is never deleted.
 *   * A loser is deleted only when it is genuinely inert: no events, and no
 *     members other than the owner. A row someone was actually sharing is
 *     REPORTED and left alone — merging share state is not something to guess at.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   node .cleanup-thread-forks.mjs            # show what would happen
 *   node .cleanup-thread-forks.mjs --apply    # do it
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

function readEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const APPLY = process.argv.includes("--apply");
const url = readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No DATABASE_URL in .env.local");
const sql = postgres(url, { ssl: "require", prepare: false, connect_timeout: 20 });

const rows = await sql`
  select t.id, t.owner_email, t.eve_session_id, t.client_key, t.title, t.archived_at,
         t.updated_at,
         jsonb_array_length(coalesce(t.client_events, '[]'::jsonb)) as n_events,
         (select count(*)::int from chat_thread_members m
           where m.thread_id = t.id and lower(m.email) <> lower(t.owner_email)) as n_members
  from chat_threads t
  order by t.owner_email, t.eve_session_id, t.updated_at desc`;

// Group by the thread's real identity: one conversation per (owner, session).
const groups = new Map();
for (const r of rows) {
  const key = `${r.owner_email?.toLowerCase()}|${r.eve_session_id}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const doomed = [];
const kept = [];
for (const [key, list] of groups) {
  if (list.length < 2) continue;
  const ranked = [...list].sort(
    (a, b) => b.n_events - a.n_events || b.updated_at - a.updated_at,
  );
  const keeper = ranked[0];
  kept.push({ key, keeper });
  for (const loser of ranked.slice(1)) {
    if (loser.n_events > 0 || loser.n_members > 0) {
      console.log(
        `  ! KEEPING ${loser.id} (${loser.client_key}) — it has ${loser.n_events} event(s) and ` +
          `${loser.n_members} shared member(s); not inert, so not mine to delete`,
      );
      continue;
    }
    doomed.push({ loser, keeper });
  }
}

console.log(`\n${groups.size} conversation(s), ${rows.length} row(s)`);
if (doomed.length === 0) {
  console.log("✓ no inert duplicates to remove");
  await sql.end();
  process.exit(0);
}
console.log(`\n${doomed.length} inert duplicate(s) would be removed:\n`);
for (const { loser, keeper } of doomed) {
  console.log(`  session ${loser.eve_session_id}`);
  console.log(`    DELETE  ${loser.id}  key=${loser.client_key}  events=${loser.n_events}  "${String(loser.title).slice(0, 40)}"`);
  console.log(`    keep    ${keeper.id}  key=${keeper.client_key}  events=${keeper.n_events}\n`);
}

if (!APPLY) {
  console.log("Dry run. Re-run with --apply to delete.");
  await sql.end();
  process.exit(0);
}

let removed = 0;
for (const { loser } of doomed) {
  // Members first — the owner row of an inert duplicate still has a membership
  // row, and the FK would otherwise refuse the delete.
  await sql`delete from chat_thread_members where thread_id = ${loser.id}`;
  const gone = await sql`delete from chat_threads where id = ${loser.id} returning id`;
  removed += gone.length;
}
console.log(`✓ removed ${removed} duplicate row(s)`);

const [{ n }] = await sql`
  select count(*)::int as n from (
    select owner_email, eve_session_id from chat_threads
    group by owner_email, eve_session_id having count(*) > 1
  ) d`;
console.log(n === 0 ? "✓ no duplicate (owner, session) pairs remain" : `✗ ${n} duplicate pair(s) still present`);
await sql.end();
process.exit(n === 0 ? 0 : 1);
