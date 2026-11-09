// SEALS. A shared record's own database connection string, with the key vault's master key (APP_VAULT_KEY).
// Imports a staff Import file ({"records": [{key, title, data}]}) into one shared (platform) area, through exactly the
// staff console's Import (src/record-import.ts staffImport; src/record-import-cli.ts says what it does and prints):
//   npm run operator:import-records -- --area <name> --file <path> [--dry-run] [--json] [--by <name>]
//   python3 .claude/scripts/provision.py <app_id> --operator import-records --dry-run -- --area <name> --file <path>   (the factory)
//
// It connects with the app's own DATABASE_URL (without one, the local PGlite database) and never migrates a database
// that has one: APP_MIGRATE_ON_BOOT=off, so a database behind this release's migrations is refused, not changed.
// Exit 0: done (or a dry run). 1: the database could not be reached or the write failed. 2: bad arguments or file.
if (process.env.DATABASE_URL) process.env.APP_MIGRATE_ON_BOOT = "off";

const { importRecordsCommand } = await import("../../src/record-import-cli.js");
const argv = process.argv.slice(2);
let code = 1;
try {
  const r = await importRecordsCommand(argv);
  code = r.code;
  if (argv.includes("--json")) console.log(JSON.stringify(r.json, null, 2));
  else (r.code === 0 ? console.log : console.error)(r.out);
} catch (e) {
  console.error(`import-records: ${String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 300)}`);
}
process.exit(code);
