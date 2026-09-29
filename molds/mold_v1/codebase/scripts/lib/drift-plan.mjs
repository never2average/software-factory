/**
 * The factory deploy's drift step, for the migration tests that must prove it plans nothing after the journal.
 *
 * provision.py (software-factory, mold_v1-143) runs the journal and then a READ-ONLY `drizzle-kit push --strict
 * --verbose` against schema.ts (non-TTY, so its approval prompt rejects before anything executes). It reads the plan
 * whole from its "You are about to execute current statements:" line (a statement starts at column 0 with an SQL
 * verb; drizzle prints a primary-key drop without a trailing `;`) and splits it: set aside only what push would do to
 * policies and row-level security and the one out-of-band index; REFUSE data loss and any other index drop.
 *
 * So a schema.ts change that drops an index must be done by a journal entry: left to the drift step it is refused
 * and the deploy stops. Shared by test-company-key-migration-db.mjs and test-customer-id-index-migration-db.mjs.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** Run drizzle-kit with DATABASE_URL set; the output without colour codes, and the SQL lines it printed. */
export function kit(args, url) {
  const r = spawnSync(join(ROOT, "node_modules/.bin/drizzle-kit"), args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n");
  return { status: r.status, out, statements: out.split("\n").filter((l) => /^(ALTER|CREATE|DROP|DELETE|TRUNCATE|INSERT|UPDATE)\b/.test(l.trim())) };
}

export const OUT_OF_BAND_INDEXES = ["workflow_definitions_one_default_idx"];
const SET_ASIDE = new RegExp(String.raw`^\s*(DROP\s+POLICY\b|ALTER\s+POLICY\b|DROP\s+INDEX\s+(IF\s+EXISTS\s+)?"?(${OUT_OF_BAND_INDEXES.join("|")})"?\s*;|ALTER\s+TABLE\b[\s\S]*\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY)`, "i");
const DATA_LOSS = /^\s*truncate\b|\bDROP\s+(TABLE|COLUMN|SCHEMA|MATERIALIZED\s+VIEW)\b/i;
const DROPS_INDEX = /^\s*DROP\s+INDEX\b/i;
const SQL_START = /^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|DO|GRANT|REVOKE|INSERT|UPDATE|DELETE|SELECT|WITH|SET|REFRESH)\b/i;
const PLAN_END = /^\s*(Warning\b|Error:|THIS ACTION\b|Do you still want\b|\[.\]|·)/;

/** The drift step's plan against `url`: { apply, aside, refused } (statements), or { error, out }. */
export function driftPlan(url) {
  const u = new URL(url);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  const r = kit(["push", "--strict", "--verbose"], u.toString());
  if (/Changes applied/.test(r.out)) return { error: "the dry run applied changes", out: r.out.slice(-600) };
  const HEAD = "You are about to execute current statements:";
  if (!r.out.includes(HEAD)) return /No changes detected/.test(r.out) ? { apply: [], aside: [], refused: [] } : { error: "no plan", out: r.out.slice(-600) };
  const stmts = [];
  for (const line of r.out.split(HEAD)[1].split("\n")) {
    if (PLAN_END.test(line)) break;
    if (!line.trim()) continue;
    if (SQL_START.test(line)) stmts.push(line);
    else if (stmts.length) stmts[stmts.length - 1] += `\n${line}`;
  }
  const aside = stmts.filter((x) => SET_ASIDE.test(x));
  const rest = stmts.filter((x) => !SET_ASIDE.test(x));
  return { apply: rest.filter((x) => !DATA_LOSS.test(x) && !DROPS_INDEX.test(x)), aside, refused: rest.filter((x) => DATA_LOSS.test(x) || DROPS_INDEX.test(x)) };
}
