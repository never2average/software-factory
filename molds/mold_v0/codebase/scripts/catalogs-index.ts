// The upstream catalogs' index after a deploy (mold_v0-128; src/repository-index.ts), against DATABASE_URL (or the local
// PGlite): every automatic upstream catalog not indexed at its pin is indexed now (one instance at a time: a catalog
// another instance is indexing is left to it), and one line per catalog says what happened, then the summary line the
// factory's deploy reads (CATALOGS INDEX: ...). Never a failed deploy: exit 0 unless the script itself could not run
// (the database unreachable: exit 1); a catalog that could not be indexed is said, recorded for the admin console
// (Repositories, Health) and retried by the server.
//   npm run catalogs:index
const { getDb } = await import("../src/db.js");
const { catalogs, ensureCatalogs } = await import("../src/repository-index.js");
const db = await getDb();
try {
  const all = await catalogs();
  if (!all.length) console.log("CATALOGS INDEX: this build has no upstream catalog");
  else {
    const got = await ensureCatalogs("deploy", { retry: true });
    const parts: string[] = [];
    for (const r of got) {
      const c = all.find((x) => x.pack === r.pack && x.name === r.name)!;
      const at = c.settings.upstream.commit.slice(0, 12);
      const rows = r.report ? r.report.areas.map((a) => `${a.area} ${a.created + a.updated + a.unchanged}`).join(", ") : "";
      const said = r.outcome === "indexed" ? `indexed at ${at}: ${rows}` : r.outcome === "current" ? `already indexed at ${at}`
        : r.outcome === "manual" ? "indexed by staff only (index: manual)" : r.outcome === "held" ? "being indexed by another instance"
        : r.outcome === "backoff" ? "failed recently; the server retries" : `FAILED at ${at}: ${r.error ?? "unknown error"}`;
      console.log(`  ${r.pack}/${r.name}: ${said}`);
      parts.push(`${r.name} ${r.outcome}${rows ? ` (${rows})` : ""}`);
    }
    // Rows now in each catalog's areas, whatever this run did.
    const counts = await db.query<{ area: string; n: number }>("SELECT area, count(*)::int AS n FROM platform_records WHERE (pack, area) IN (SELECT * FROM unnest($1::text[], $2::text[])) GROUP BY area ORDER BY area",
      [all.flatMap((c) => c.areas.map(() => c.pack)), all.flatMap((c) => c.areas.map((a) => a.name))]);
    console.log(`CATALOGS INDEX: ${parts.join("; ")}; rows now: ${counts.map((c) => `${c.area} ${c.n}`).join(", ") || "none"}`);
  }
} finally {
  await db.close();
}
