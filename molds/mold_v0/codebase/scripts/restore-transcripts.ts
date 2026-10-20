/**
 * Restore session traces from the R2 archive into the configured transcript store (docs/storage.md).
 * Use after ClickHouse lapses (unset CLICKHOUSE_URL: Postgres store) or after creating a new ClickHouse service.
 *
 *   npx tsx scripts/restore-transcripts.ts [--org <id>] [--dry-run]
 * Needs R2_* and the database env of the server (run it inside the server container).
 */
const { restoreArchives } = await import("../src/archive.js");
const args = process.argv.slice(2);
const org = args.includes("--org") ? Number(args[args.indexOf("--org") + 1]) : undefined;
const r = await restoreArchives({ orgId: Number.isFinite(org) ? org : undefined, dryRun: args.includes("--dry-run") });
process.exit(r.failed ? 1 : 0);
