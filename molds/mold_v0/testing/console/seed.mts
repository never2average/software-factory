// The lane world's own sample rows for its workspace (mold_v0-176; world.mts step 4c), so a build's customer lists (its
// areas' tables, its runs and reports) are graded with rows. A workspace's records come from its own use, never from a
// pack's samples (src/pack-api.ts refuses samples on a workspace area), so the lane world makes them itself from what the
// build declares, the same for every build and every run (no randomness, no clock beyond "now"):
//   records  every stored workspace area (not one read live from an API): SAMPLES rows, keys <area>-<n>, each field
//            filled by its type (an enum through its options, a date around today, a number within its bounds, yes/no
//            in turn); a reference or link field names a record the world has (the shared areas' samples, a workspace
//            area seeded before it), and a text field named like an area (application -> applications) names one of
//            its records; json, person and file fields are left empty. Written as a repository's rows are
//            (src/record-areas.ts writeFromRepository, source "lane:samples"), so read-only and sealed areas take them.
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

type Field = { name: string; type: string; options?: (string | { value: string })[]; to?: string; multiple?: boolean; min?: number; max?: number; max_length?: number; required?: boolean; label?: string };
type Area = { name: string; pack: string; label: string; scope: string; role: string; fields: Field[]; repo: { kind: string } | null; samples?: { key: string }[] };

const optionValues = (f: Field) => (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const singular = (label: string) => label.replace(/ies$/i, "y").replace(/(?<!s)s$/i, "");

/** The value of field `f` for the n-th sample (0-based), or undefined to leave it empty. */
function valueOf(f: Field, n: number, i: number, keysOf: (area: string) => string[], areaNamed: (field: string) => string | null): unknown {
  switch (f.type) {
    case "enum": { const o = optionValues(f); if (!o.length) return undefined; const v = o[(n + i) % o.length]; return f.multiple ? [v] : v; }
    case "boolean": return n % 3 === 0;
    case "number": {
      const lo = f.min ?? 0, hi = f.max ?? lo + 100;
      return Math.round((lo + ((n * 37 + i * 11) % 100) / 100 * (hi - lo)) * 100) / 100;
    }
    case "date": return day((n * 9 + i * 3) % 60 - 30);
    case "reference": case "link": {
      const keys = f.to ? keysOf(f.to) : [];
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
    default: return undefined; // json, person, file: left empty
  }
}

export async function seedWorkspace(orgId: number, lane: string): Promise<{ records: number; runs: number; results: number; skipped: string[] }> {
  const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
  const ra = await imp("src/record-areas.ts");
  const { getDb } = await imp("src/db.ts");
  const { asPlatform } = await imp("src/tenant-scope.ts");
  const areas = ra.recordAreas() as Area[];
  const seeded = new Map<string, string[]>();
  for (const a of areas) if (a.scope === "platform" && a.samples?.length) seeded.set(a.name, a.samples.map((x) => x.key));
  const keysOf = (name: string) => seeded.get(name) ?? [];
  const areaNamed = (field: string) => areas.find((a) => [field, `${field}s`, `${field}es`].includes(a.name) && seeded.has(a.name))?.name ?? null;
  const out = { records: 0, runs: 0, results: 0, skipped: [] as string[] };

  // Areas whose references are all to areas already seeded go first; the rest after, in declaration order.
  const own = areas.filter((a) => a.scope === "workspace" && a.repo?.kind !== "http_api");
  const order = [...own].sort((x, y) => Number(x.fields.some((f) => f.to && own.some((o) => o.name === f.to))) - Number(y.fields.some((f) => f.to && own.some((o) => o.name === f.to))));
  for (const a of order) {
    const ops = Array.from({ length: SAMPLES }, (_, n) => {
      const data: Record<string, unknown> = {};
      a.fields.forEach((f, i) => { const v = valueOf(f, n, i, keysOf, areaNamed); if (v !== undefined) data[f.name] = v; });
      return { op: "put", area: a.name, key: `${a.name.replace(/_/g, "-")}-${n + 1}`, title: `${singular(a.label)} ${n + 1}`, data };
    });
    try {
      await ra.writeFromRepository(orgId, a.pack, SOURCE, ops, new Map(ops.map((o) => [`${o.area}\u0000${o.key}`, `lane:${o.key}`])));
      seeded.set(a.name, ops.map((o) => o.key));
      out.records += ops.length;
    } catch (e) { out.skipped.push(`${a.name}: ${(e as Error).message.slice(0, 200)}`); }
  }

  // Runs of the build's job kinds: finished, failed and running, newest first, over a workspace asset when the kind reads one.
  const { jobKinds } = await imp("src/runs.ts");
  const kinds = (jobKinds() as { pack: string; name: string; max_attempts: number; token_lifetime_seconds: number; lease_seconds: number; budget_usd: number }[]).slice(0, 6);
  const asset = own.find((a) => a.role === "asset" && seeded.has(a.name));
  const check = areas.find((a) => a.role === "check" && seeded.has(a.name));
  const STATES = ["succeeded", "failed", "succeeded", "running", "succeeded", "cancelled", "succeeded", "failed", "succeeded", "succeeded"] as const;
  const SECONDS = [312, 1250, 95, 4020, 760, 41, 2210, 188, 530, 1475];
  const COSTS = [0.42, 1.87, 0.06, 3.1, 12.4, 0.0, 2.35, 0.91, 5.6, 0.18];
  if (kinds.length) {
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
  }
  return out;
}

/** Remove what seedWorkspace wrote (its records by their source, its runs by their ids), for the empty states. */
export async function unseedWorkspace(orgId: number, lane: string): Promise<number> {
  const imp = (rel: string) => import(pathToFileURL(path.join(lane, rel)).href);
  const { getDb } = await imp("src/db.ts");
  const { asPlatform } = await imp("src/tenant-scope.ts");
  const db = await getDb();
  return asPlatform(async () => {
    const r = await db.query("DELETE FROM workspace_records WHERE org_id = $1 AND source = $2 RETURNING key", [orgId, SOURCE]);
    const x = await db.query("DELETE FROM runs WHERE org_id = $1 AND id LIKE 'run_lane_%' RETURNING id", [orgId]);
    return (r as unknown[]).length + (x as unknown[]).length;
  });
}
