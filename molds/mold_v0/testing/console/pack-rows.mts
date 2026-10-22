// A row per pack for the functional and context lanes, measured in the lane copy on the shell's throwaway world
// (scripts/lib/test-world.ts: an embedded database in a temporary folder, removed at the end; nothing deployed is touched).
//   <lane copy>/node_modules/.bin/tsx pack-rows.mts <lane copy> tools
//       functional: for one fresh workspace (its owner), the customer MCP server lists every tool the pack declares
//       (surface.mts), and every one of the pack's read-only tools that needs no argument answers without isError.
//   <lane copy>/node_modules/.bin/tsx pack-rows.mts <lane copy> tables
//       context: every table the pack's migrations create (named <pack id>_*) has row-level security on, forced, and at
//       least one policy. (The live cross-workspace probe of those tables is the product's own check:rls, beside it.)
// Prints a markdown table, a row per pack (and the shell's), then "rows: N". Exit 0 when no row failed, else 1.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [laneArg, mode] = process.argv.slice(2);
if (!laneArg || !["tools", "tables"].includes(mode ?? "")) { console.error("usage: pack-rows.mts <lane copy> tools|tables"); process.exit(2); }
const lane = path.resolve(laneArg);
process.chdir(lane);
// An allow-listed environment: no key or service address of the operator's shell reaches a pack's tools.
const KEEP = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER"]);
for (const k of Object.keys(process.env)) if (!KEEP.has(k)) delete process.env[k];
const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

const tw = await imp("scripts/lib/test-world.ts");
let code = 1;
try {
  const { surface } = await import(pathToFileURL(path.join(import.meta.dirname, "surface.mts")).href);
  const s = await surface(lane);
  const owners: { id: string; kind: string }[] = [{ id: "shell", kind: "shell" }, ...s.packs];
  const rows: { pack: string; status: string; detail: string }[] = [];
  const { getDb } = await imp("src/db.ts");
  const db = await getDb();   // migrates: the shell's, then every pack's, in pack order

  if (mode === "tools") {
    const { createOrg } = await imp("src/auth.ts");
    const { org } = await createOrg("Lane pack rows", "lane-pack-rows");
    const c = await tw.connect({ ...org, role: "owner" });
    const listed = new Map<string, { annotations?: { readOnlyHint?: boolean }; inputSchema?: { required?: string[] } }>();
    for (const t of (await c.client.listTools()).tools) listed.set(t.name, t);
    for (const o of owners) {
      const mine = Object.entries(s.tools as Record<string, string>).filter(([, p]) => p === o.id).map(([n]) => n).sort();
      if (!mine.length) { rows.push({ pack: `${o.id} (${o.kind})`, status: "not-covered", detail: "declares no MCP tool" }); continue; }
      const missing = mine.filter((n) => !listed.has(n));
      const callable = mine.filter((n) => listed.get(n)?.annotations?.readOnlyHint === true && !(listed.get(n)?.inputSchema?.required ?? []).length);
      // A tool that answers isError with its own message on an empty workspace ("nothing here yet") has worked: only a
      // call that throws, or answers the shell's internal-error text, fails the row.
      const errors: string[] = [], refusals: string[] = [];
      for (const n of callable) {
        try {
          const r = await c.call(n, {});
          const text = cell(r.content?.[0]?.text);
          if (r.isError && /database error [0-9A-Z]{5}|internal error|could not be completed|Cannot read propert|is not a function|is not defined|TypeError|ReferenceError/i.test(text)) errors.push(`${n}: ${text.slice(0, 80)}`);
          else if (r.isError) refusals.push(n);
        } catch (e) { errors.push(`${n}: ${cell((e as Error).message).slice(0, 80)}`); }
      }
      const bad = missing.length || errors.length;
      rows.push({ pack: `${o.id} (${o.kind})`, status: bad ? "fail" : "pass", detail: [
        `${mine.length} tools, ${mine.length - missing.length} listed for a workspace owner`,
        missing.length ? `NOT LISTED: ${missing.slice(0, 6).join(", ")}` : "",
        `${callable.length} read-only without arguments called${refusals.length ? ` (${refusals.length} answered with their own message for an empty workspace: ${refusals.slice(0, 4).join(", ")})` : ""}`,
        errors.length ? `ERRORS: ${errors.slice(0, 4).join("; ")}` : "",
      ].filter(Boolean).join("; ") });
    }
    await c.close();
    console.log("### MCP tools: a row per pack (one fresh workspace, its owner, an embedded database)");
  } else {
    const tables = await db.query<{ name: string; rls: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public' ORDER BY c.relname`);
    for (const o of owners) {
      if (o.id === "shell") continue;
      const mine = tables.filter((t) => t.name.startsWith(`${o.id}_`));
      if (!mine.length) { rows.push({ pack: `${o.id} (${o.kind})`, status: "not-covered", detail: o.kind === "host" ? "no table of its own (a host pack's tables are still the shell's base schema, mold_v0-049)" : "no table of its own" }); continue; }
      const bad = mine.filter((t) => !t.rls || !t.forced || t.policies < 1);
      rows.push({ pack: `${o.id} (${o.kind})`, status: bad.length ? "fail" : "pass", detail: [
        `${mine.length} tables`,
        bad.length ? `NOT SECURED: ${bad.slice(0, 6).map((t) => `${t.name} (${[!t.rls && "rls off", !t.forced && "not forced", t.policies < 1 && "no policy"].filter(Boolean).join(", ")})`).join("; ")}` : "row-level security on, forced, with a policy",
      ].join("; ") });
    }
    console.log("### Pack tables: a row per pack (row-level security in the catalog, after every migration, on an embedded database)");
  }
  console.log("\n| pack | status | detail |\n|---|---|---|");
  for (const r of rows) console.log(`| ${cell(r.pack)} | ${r.status} | ${cell(r.detail)} |`);
  console.log(`\nrows: ${rows.length} (${rows.filter((r) => r.status === "fail").length} failed)`);
  code = rows.some((r) => r.status === "fail") ? 1 : 0;
  await db.close?.();
} catch (e) {
  console.error(`pack rows: ${(e as Error).stack ?? e}`);
  code = 1;
} finally {
  tw.cleanup();
}
process.exit(code);
