// The lane world's own sample rows for its workspace (mold_v0-176; world.mts step 4c), so a build's customer lists (its
// areas' tables, its runs and reports) are graded with rows. A workspace's records come from its own use, never from a
// pack's samples (src/pack-api.ts refuses samples on a workspace area), so the lane world makes them itself from what the
// build declares, the same for every build and every run (no randomness, no clock beyond "now"):
//   records  every stored workspace area (not one read live from an API): SAMPLES rows, keys <area>-<n>, each field
//            filled by its type (an enum through its options, a date around today, a number within its bounds, yes/no
//            in turn); a reference or link field names a record the world has (the shared areas' samples, a workspace
//            area seeded before it), and a text field named like an area (application -> applications) names one of
//            its records; json, person, file and optional url fields are left empty (mold_v0-256: a required url field
//            gets https://example.com/<area>/<n>, so an area with one is seeded too). Written as a repository's rows are
//            (src/record-areas.ts writeFromRepository, source "lane:samples"), so read-only and sealed areas take them.
//            mold_v0-298: referenced areas first (whatever the chain), and a shared area with no samples that a required
//            reference points at gets a few placeholder rows; an area still left empty is listed with the reason.
//            mold_v0-300: a reference with a `where` names only a row it keeps (the server's own test, conditionHolds);
//            a required one that keeps none skips its area with the reason, and one area failing never stops the rest.
//   runs     a few runs of the build's job kinds, finished, failed and running, each over a workspace asset record
//            when the kind reads one (targets.asset), with results against the shared check samples; written straight
//            into the throwaway database as the platform (the runs engine's own rows), ids run_lane_<n>.
// Nothing here runs outside the lane world: a deployed build never writes these. unseedWorkspace removes them again
// (a harness shooting the empty states).
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SAMPLES = 8;
export const SOURCE = "lane:samples";
const DAY = 86_400_000;

type Field = { name: string; type: string; options?: (string | { value: string })[]; to?: string; multiple?: boolean; min?: number; max?: number; max_length?: number; required?: boolean; label?: string; where?: unknown };
type Area = { name: string; pack: string; label: string; scope: string; role: string; fields: Field[]; repo: { kind: string } | null; samples?: { key: string; data?: Record<string, unknown> }[] };
/** The keys of an area's rows, those a reference's `where` keeps when one is given (mold_v0-300). */
type KeysOf = (area: string, where?: unknown) => string[];

const optionValues = (f: Field) => (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const singular = (label: string) => label.replace(/ies$/i, "y").replace(/(?<!s)s$/i, "");

/** The value of field `f` for the n-th sample (0-based), or undefined to leave it empty. */
/** (Exported for scripts/record-pages-3-test.ts.) */
export function valueOf(f: Field, n: number, i: number, keysOf: KeysOf, areaNamed: (field: string) => string | null, area = "records"): unknown {
  switch (f.type) {
    case "enum": { const o = optionValues(f); if (!o.length) return undefined; const v = o[(n + i) % o.length]; return f.multiple ? [v] : v; }
    case "boolean": return n % 3 === 0;
    case "number": {
      const lo = f.min ?? 0, hi = f.max ?? lo + 100;
      return Math.round((lo + ((n * 37 + i * 11) % 100) / 100 * (hi - lo)) * 100) / 100;
    }
    case "date": return day((n * 9 + i * 3) % 60 - 30);
    case "reference": case "link": {
      // mold_v0-300: only the records the field's `where` keeps (the server refuses any other, see checkRecord).
      const keys = f.to ? keysOf(f.to, f.type === "reference" ? f.where : undefined) : [];
      if (!keys.length) return undefined;
      const k = keys[n % keys.length];
      return f.multiple || (f.type === "link" && f.name.endsWith("s")) ? [k] : k;
    }
    case "text": {
      const area = areaNamed(f.name);
      const keys = area ? keysOf(area) : [];
      const t = keys.length ? keys[n % keys.length]! : `Sample ${(f.label ?? f.name).toLowerCase()} ${n + 1}`;
      return t.slice(0, f.max_length ?? 20_000);
    }
    // mold_v0-256: a required url field gets an address of the example domain (else its area could not be seeded at all);
    // an optional one stays empty (mold_v0-238: an address a card would try to fetch).
    case "url": return f.required ? `https://example.com/${area}/${n + 1}` : undefined;
    default: return undefined; // json, person, file, an optional url: left empty
  }
}

/** A reference or link field and the area it points at (not the area itself). */
const refsOf = (a: Area) => a.fields.filter((f) => (f.type === "reference" || f.type === "link") && !!f.to);

export async function seedWorkspace(orgId: number, lane: string): Promise<{ records: number; runs: number; results: number; skipped: string[]; filled: string[] }> {
  const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
  const ra = await imp("src/record-areas.ts");
  const { getDb } = await imp("src/db.ts");
  const { asPlatform } = await imp("src/tenant-scope.ts");
  // mold_v0-300: a reference's `where` is tested as the server tests it (src/pack-api.ts conditionHolds, used by
  // src/record-areas.ts checkRecord), against the data the lane world wrote for each row.
  const { conditionHolds } = await imp("src/pack-api.ts");
  const areas = ra.recordAreas() as Area[];
  const seeded = new Map<string, string[]>();
  const rowData = new Map<string, Map<string, Record<string, unknown>>>(); // area -> key -> the data written
  const remember = (area: string, rows: { key: string; data?: Record<string, unknown> }[]) => {
    const m = rowData.get(area) ?? new Map<string, Record<string, unknown>>();
    for (const r of rows) m.set(r.key, r.data ?? {});
    rowData.set(area, m);
  };
  for (const a of areas) if (a.scope === "platform" && a.samples?.length) { seeded.set(a.name, a.samples.map((x) => x.key)); remember(a.name, a.samples); }
  const holds = (where: unknown, data: Record<string, unknown> | undefined) => {
    try { return !!data && conditionHolds(where, data); } catch { return false; }
  };
  const keysOf: KeysOf = (name, where) => {
    const keys = seeded.get(name) ?? [];
    return where ? keys.filter((k) => holds(where, rowData.get(name)?.get(k))) : keys;
  };
  const areaNamed = (field: string) => areas.find((a) => [field, `${field}s`, `${field}es`].includes(a.name) && seeded.has(a.name))?.name ?? null;
  const out = { records: 0, runs: 0, results: 0, skipped: [] as string[], filled: [] as string[] };
  const byName = new Map(areas.map((a) => [a.name, a]));
  const own = areas.filter((a) => a.scope === "workspace" && a.repo?.kind !== "http_api");
  const isOwn = (name: string) => own.some((o) => o.name === name);

  // mold_v0-298: the areas are seeded referenced-first (a depth-first walk of their reference and link fields), so an
  // area that points at another workspace area finds its rows, however long the chain. A required reference to a shared
  // area with no samples gets a few placeholder rows there first (written as 4b writes the samples), so the area that
  // needs them is seeded too; whatever still cannot be seeded is named in `skipped` with the reason (world.mts prints it).
  const state = new Map<string, "doing" | "done" | "failed">();
  const why = new Map<string, string>(); // an area that has no rows, and why

  /** A shared area with no samples: a few placeholder rows, so a workspace area's required reference has a target. */
  async function fillShared(t: Area, depth: number): Promise<void> {
    if (seeded.has(t.name) || state.has(t.name)) return;
    state.set(t.name, "doing");
    if (t.repo?.kind === "http_api") { state.set(t.name, "failed"); why.set(t.name, "it is read live from an outside service, so the lane world cannot write rows to it"); return; }
    for (const f of refsOf(t)) if (f.required && f.to !== t.name) await ensure(f.to!, depth + 1);
    const n = Math.min(3, SAMPLES);
    const ops = Array.from({ length: n }, (_, i) => {
      const data: Record<string, unknown> = {};
      t.fields.forEach((f, j) => { const v = valueOf(f, i, j, keysOf, areaNamed, t.name); if (v !== undefined) data[f.name] = v; });
      return { key: `${t.name.replace(/_/g, "-")}-lane-${i + 1}`, title: `${singular(t.label)} ${i + 1}`, data };
    });
    try {
      for (const o of ops) await ra.putPlatform(null, t.name, o.key, { title: o.title, version: null, data: o.data }, "put", { source: SOURCE, fingerprint: `lane-placeholder:${o.key}` });
      seeded.set(t.name, ops.map((o) => o.key));
      remember(t.name, ops);
      state.set(t.name, "done");
      out.filled.push(`${t.name} (a shared area with no samples): ${ops.length} placeholder row(s), so the areas that must point at one could be seeded`);
    } catch (e) {
      state.set(t.name, "failed");
      why.set(t.name, `placeholder rows were refused: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  /** Make sure area `name` has rows before something points at it (a workspace area seeded, a shared one filled). */
  async function ensure(name: string, depth: number): Promise<void> {
    if (depth > 12) { if (!seeded.has(name)) why.set(name, "its chain of references is too long (over 12 areas deep) to seed in order"); return; }
    const t = byName.get(name);
    if (!t) { why.set(name, "no area of that name is in this build"); return; }
    if (isOwn(name)) await seedArea(t, depth);
    else if (t.scope === "platform") await fillShared(t, depth);
    else if (!seeded.has(name)) why.set(name, t.repo?.kind === "http_api" ? "it is read live from an outside service" : `the lane world does not write ${t.scope} areas`);
  }

  async function seedArea(a: Area, depth = 0): Promise<void> {
    if (state.has(a.name)) return; // done, failed, or being seeded further up this chain (a loop of references)
    state.set(a.name, "doing");
    for (const f of refsOf(a)) {
      if (f.to === a.name) continue;
      // A shared area with samples has rows already; one without gets placeholders only when the field needs a value.
      const t = byName.get(f.to!);
      if (t && !isOwn(t.name) && seeded.has(t.name)) continue;
      if (t && !isOwn(t.name) && !f.required) continue;
      await ensure(f.to!, depth + 1);
    }
    const keys = Array.from({ length: SAMPLES }, (_, n) => `${a.name.replace(/_/g, "-")}-${n + 1}`);
    // A required reference to the area itself names an earlier row of the same batch (the first row, the first).
    // mold_v0-300: with a `where`, only an earlier row of the batch that it keeps (the rows built so far).
    const built = new Map<string, Record<string, unknown>>();
    const self: KeysOf = (name, where) => {
      if (name !== a.name) return keysOf(name, where);
      return where ? keys.filter((k) => built.has(k) && holds(where, built.get(k))) : keys;
    };
    const ops = keys.map((key, n) => {
      const data: Record<string, unknown> = {};
      a.fields.forEach((f, i) => {
        const selfRef = f.to === a.name && (f.type === "reference" || f.type === "link");
        const v = selfRef && !f.required ? undefined : valueOf(f, selfRef ? Math.max(n - 1, 0) : n, i, selfRef ? self : keysOf, areaNamed, a.name);
        if (v !== undefined) data[f.name] = v;
      });
      built.set(key, data);
      return { op: "put", area: a.name, key, title: `${singular(a.label)} ${n + 1}`, data };
    });
    // Required references with nothing to point at: said with the reason, rather than a bare refusal from the store.
    const unmet = refsOf(a).filter((f) => f.required && f.to !== a.name && !keysOf(f.to!).length)
      .map((f) => `its required ${f.name} points at ${f.to}, which has no rows (${why.get(f.to!) ?? (state.get(f.to!) === "doing" ? "the two areas point at each other" : "it has no samples")})`);
    // mold_v0-300: a required reference whose `where` keeps none of the target's rows: the area is skipped with the
    // reason, rather than written and refused by the store (an optional one is left empty by valueOf).
    for (const f of refsOf(a)) {
      if (!f.required || f.type !== "reference" || !f.where || f.to === a.name || !keysOf(f.to!).length) continue;
      if (!keysOf(f.to!, f.where).length) unmet.push(`its required ${f.name} may name only ${f.to} records its where keeps (${JSON.stringify(f.where).slice(0, 120)}), and none of the ${keysOf(f.to!).length} row(s) there matches`);
    }
    const whereUnmet = unmet.filter((u) => u.includes("its where keeps"));
    if (whereUnmet.length) { state.set(a.name, "failed"); why.set(a.name, whereUnmet.join("; ")); return; }
    try {
      await ra.writeFromRepository(orgId, a.pack, SOURCE, ops, new Map(ops.map((o) => [`${o.area}\u0000${o.key}`, `lane:${o.key}`])));
      seeded.set(a.name, ops.map((o) => o.key));
      remember(a.name, ops);
      out.records += ops.length;
      state.set(a.name, "done");
    } catch (e) {
      state.set(a.name, "failed");
      why.set(a.name, unmet.length ? unmet.join("; ") : (e as Error).message.slice(0, 200));
    }
  }

  // mold_v0-300: one area that throws (anything outside its own write) is named in `skipped`; the others are still seeded.
  const attempt = async (a: Area) => {
    try { await seedArea(a); }
    catch (e) { state.set(a.name, "failed"); why.set(a.name, `seeding it failed: ${(e as Error).message.slice(0, 200)}`); }
  };
  for (const a of own) await attempt(a);
  // A loop of references: an area refused while the other was half-way is tried once more, now that the rest have rows.
  for (const a of own) if (state.get(a.name) === "failed") { state.delete(a.name); why.delete(a.name); await attempt(a); }
  for (const a of own) if (!seeded.has(a.name)) out.skipped.push(`${a.name}: ${why.get(a.name) ?? "not seeded"}`);

  // Runs of the build's job kinds: finished, failed and running, newest first, over a workspace asset when the kind reads one.
  const { jobKinds } = await imp("src/runs.ts");
  const kinds = (jobKinds() as { pack: string; name: string; max_attempts: number; token_lifetime_seconds: number; lease_seconds: number; budget_usd: number }[]).slice(0, 6);
  const asset = own.find((a) => a.role === "asset" && seeded.has(a.name));
  const check = areas.find((a) => a.role === "check" && seeded.has(a.name));
  const STATES = ["succeeded", "failed", "succeeded", "running", "succeeded", "cancelled", "succeeded", "failed", "succeeded", "succeeded"] as const;
  const SECONDS = [312, 1250, 95, 4020, 760, 41, 2210, 188, 530, 1475];
  const COSTS = [0.42, 1.87, 0.06, 3.1, 12.4, 0.0, 2.35, 0.91, 5.6, 0.18];
  // mold_v0-300: a refused run insert is reported, never a throw that loses the records written above.
  if (kinds.length) try {
    const db = await getDb();
    await asPlatform(async () => {
      for (let n = 0; n < STATES.length; n++) {
        const k = kinds[n % kinds.length]!, status = STATES[n]!;
        // A running run started a few minutes ago (its duration so far); the others hours and days back.
        const created = status === "running" ? Date.now() - 6 * 60_000 : Date.now() - (n * 7 + 1) * 3600_000;
        const started = created + 30_000;
        const ended = status === "running" ? null : started + SECONDS[n]! * 1000;
        const target = asset && JSON.stringify(k).includes("targets.asset") ? { asset: { area: asset.name, key: keysOf(asset.name)[n % keysOf(asset.name).length] } } : {};
        const id = `run_lane_${n + 1}`;
        await db.query(
          `INSERT INTO runs (id, org_id, pack, kind, status, scope, targets, spec, attempt, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd,
             cost_usd, error_kind, error, requested_by, created_at, started_at, ended_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, 1, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT (id) DO NOTHING`,
          [id, orgId, k.pack, k.name, status, JSON.stringify(target), JSON.stringify(k), k.max_attempts, k.token_lifetime_seconds, k.lease_seconds, k.budget_usd,
           COSTS[n], status === "failed" ? "run" : status === "cancelled" ? "cancelled" : null,
           status === "failed" ? "A sample failure: the run stopped before it finished (lane world)." : status === "cancelled" ? "Cancelled (lane world sample)." : null,
           SOURCE, new Date(created), new Date(started), ended ? new Date(ended) : null]);
        out.runs++;
        if (check && (status === "succeeded" || status === "failed")) {
          const checks = keysOf(check.name).slice(0, 1 + (n % 4));
          for (const [i, key] of checks.entries()) {
            await db.query(
              `INSERT INTO run_results (run_id, org_id, check_area, check_key, asset_area, asset_key, status, evidence_ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT DO NOTHING`,
              [id, orgId, check.name, key, target.asset?.area ?? null, target.asset?.key ?? null, status === "failed" && i === 0 ? "error" : (n + i) % 3 === 0 ? "fail" : "pass", `evidence/${id}/${i + 1}.json`]);
            out.results++;
          }
        }
      }
    });
  } catch (e) {
    out.skipped.push(`sample runs: ${(e as Error).message.slice(0, 200)}`);
  }
  return out;
}

/** Remove what seedWorkspace wrote (its records by their source, its runs by their ids, its placeholders), for the empty states. */
export async function unseedWorkspace(orgId: number, lane: string): Promise<number> {
  const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
  const { getDb } = await imp("src/db.ts");
  const { asPlatform } = await imp("src/tenant-scope.ts");
  const db = await getDb();
  return asPlatform(async () => {
    const r = await db.query("DELETE FROM workspace_records WHERE org_id = $1 AND source = $2 RETURNING key", [orgId, SOURCE]);
    const x = await db.query("DELETE FROM runs WHERE org_id = $1 AND id LIKE 'run_lane_%' RETURNING id", [orgId]);
    // mold_v0-298: the placeholder rows written to shared areas with no samples, by their own fingerprint
    // (lane-placeholder:<key>); world.mts 4b's real samples (fingerprint lane:<key>) stay, whatever their keys.
    const p = await db.query("DELETE FROM platform_records WHERE source = $1 AND fingerprint LIKE 'lane-placeholder:%' RETURNING key", [SOURCE]);
    return (r as unknown[]).length + (x as unknown[]).length + (p as unknown[]).length;
  });
}
