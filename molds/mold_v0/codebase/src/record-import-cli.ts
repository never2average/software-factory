/**
 * operator:import-records (mold_v0-285; scripts/operator/import-records.ts is its door): a staff Import file
 * ({"records": [{key, title?, data}]}, the console's Import format) into ONE shared (platform) area, through exactly the
 * path the staff console's Import takes (src/record-import.ts staffImport): the same checks per row, the same batch, a
 * new record's own database made after the batch commits (src/record-resources.ts), the staff access log's IMPORT lines
 * and the platform trail's staff entries naming who imported (`--by`, else "operator").
 *
 *   --area <name>   the shared area (required)
 *   --file <path>   the Import file (required): {"records": [...]} or a bare list of rows
 *   --dry-run       checked and counted, nothing written
 *   --json          one JSON result
 *   --by <name>     who imports, as the logs name them (default "operator")
 *
 * Idempotent by key (importRecords): an existing record is updated (its fields merged), never duplicated; a row that
 * changes nothing is not written, so a second run of the same file writes nothing. Counts: new, updated (a staff row,
 * or a repository's row overridden), unchanged, invalid (each with its reasons; skipped, never written).
 * Exit 0: done (or a dry run). 1: the database could not be reached or the write failed. 2: bad arguments, a missing or
 * unreadable file, an area that is not a shared one, or a real run whose area makes databases while the key vault is
 * locked (no APP_VAULT_KEY: their connection strings could not be sealed).
 */
import { readFileSync } from "node:fs";

export interface ImportCliResult { code: number; out: string; json: unknown }

const USAGE = "usage: operator:import-records -- --area <shared area> --file <import.json> [--dry-run] [--json] [--by <name>]";

class Usage extends Error {}

function parse(argv: string[]) {
  const o: { area?: string; file?: string; dry: boolean; json: boolean; by: string } = { dry: false, json: false, by: "operator" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Usage(`${a} needs a value. ${USAGE}`); return v; };
    if (a === "--area") o.area = val();
    else if (a === "--file") o.file = val();
    else if (a === "--by") o.by = val();
    else if (a === "--dry-run") o.dry = true;
    else if (a === "--json") o.json = true;
    else throw new Usage(`unknown argument ${a.slice(0, 40)}. ${USAGE}`);
  }
  if (!o.area || !o.file) throw new Usage(`--area and --file are both needed. ${USAGE}`);
  return o as Required<typeof o>;
}

/** Run the command; never exits the process (the door does). */
export async function importRecordsCommand(argv: string[]): Promise<ImportCliResult> {
  let o: ReturnType<typeof parse>;
  try { o = parse(argv); } catch (e) { return { code: 2, out: `import-records: ${(e as Error).message}`, json: { ok: false, error: (e as Error).message } }; }
  const bad = (code: number, error: string) => ({ code, out: `import-records: ${error}`, json: { ok: false, area: o.area, error } });
  let rows: unknown;
  try {
    const doc = JSON.parse(readFileSync(o.file, "utf8")) as unknown;
    rows = Array.isArray(doc) ? doc : (doc as { records?: unknown })?.records;
    if (!Array.isArray(rows)) return bad(2, `${o.file} is not an Import file: it holds no "records" list`);
  } catch (e) { return bad(2, `${o.file} could not be read as JSON (${(e as Error).message.slice(0, 120)})`); }

  const { findArea } = await import("./record-areas.js");
  const area = findArea(o.area);
  if (!area) return bad(2, `there is no area ${o.area.slice(0, 64)} in this build`);
  if (area.scope !== "platform") return bad(2, `${area.name} holds each workspace's own records: this imports into a shared (platform) area only`);
  const { featureOn } = await import("./features.js");
  const makesDatabases = featureOn("record_resources") && area.fields.some((f) => f.type === "database");
  const { vaultUnlocked } = await import("./keyvault.js");
  if (!o.dry && makesDatabases && !vaultUnlocked())
    return bad(2, `${area.label} records each get a database of their own, whose connection string is sealed with the key vault's master key, and this run has none (APP_VAULT_KEY): nothing was written`);

  const { staffImport } = await import("./record-import.js");
  const { PackError } = await import("./pack-api.js");
  let report: Awaited<ReturnType<typeof staffImport>>;
  try {
    report = await staffImport(area, rows, { dryRun: o.dry, actor: o.by, role: "operator", ip: "", channel: "system" });
    const { flushAudit } = await import("./audit-trail.js");
    await flushAudit().catch(() => {});
  } catch (e) {
    if (e instanceof PackError) return bad(e.status >= 500 ? 1 : 2, e.message);
    return bad(1, `the import failed: ${String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 300)}`);
  }
  const c = report.counts;
  const counts = { new: c.create, updated: c.update + c.override, unchanged: c.unchanged, invalid: c.invalid };
  const invalid = report.rows.filter((r) => r.action === "invalid").map((r) => ({ row: r.row, key: r.key, reasons: r.errors }));
  const databases: { key: string; status: string; reason: string | null; login: boolean | null }[] = [];
  if (!o.dry && makesDatabases) {
    const { recordResources } = await import("./record-resources.js");
    const keys = report.rows.filter((r) => r.action === "create").map((r) => r.key);
    for (const k of keys) for (const d of (await recordResources(area, k, {})).databases)
      databases.push({ key: k, status: d.status, reason: d.status === "ready" ? d.note : d.reason, login: d.login });
  }
  const json = { ok: true, area: area.name, dry_run: o.dry, rows: report.rows.length, counts, written: report.written, invalid, ...(makesDatabases && !o.dry ? { databases } : {}) };
  const lines = [
    `import-records: ${area.label} (${area.name}), ${report.rows.length} row${report.rows.length === 1 ? "" : "s"} from ${o.file}${o.dry ? ": a dry run, nothing written" : `, by ${o.by}`}`,
    `  new ${counts.new}, updated ${counts.updated}, unchanged ${counts.unchanged}, invalid ${counts.invalid}${o.dry ? "" : `; written ${report.written}`}`,
    ...invalid.map((r) => `  row ${r.row} (${r.key || "no key"}): invalid: ${r.reasons.join("; ")}`),
    ...databases.map((d) => `  ${d.key}: database ${d.status}${d.reason ? ` (${d.reason})` : ""}`),
  ];
  return { code: 0, out: lines.join("\n"), json };
}
