// The per-tool tenant-isolation sweep (mold_v0-154), run last by scripts/smoke.ts on every build, whatever its packs:
// every MCP tool of the build is called over HTTP as workspace B with every identifier workspace A holds, and nothing
// of A's may come back in a result, and nothing of A's may change.
//
// The shell knows no product, so it reads the build's tools and their argument schemas from the server itself and fills
// them in: each string parameter gets the identifier under test (an enum gets the value that names the identifier's
// area, pack or kind when it lists one), each required non-string parameter a plain value. A's data comes from the
// build's own declarations (a row in each workspace record area, a run of each job kind) and from A calling every tool
// that writes; its identifiers are then read from every tenant table (src/rls.ts tenantTables), so a pack table counts
// too. A host pack's own smoke test may sweep with its product's data on top of this (packs/<id>/scripts/smoke.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Db } from "../src/db.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Json = Record<string, unknown>;
type Org = { key: string; org: { orgId: number; slug: string } };
/** One argument set: none at all, free text, or one identifier of A's with what names it (its table, area, pack, kind). */
type ArgSet = { kind: "empty" } | { kind: "text" } | { kind: "id"; value: string; hints: string[] };

/** Columns whose values are identifiers a tool may take (never org_id: B passing A's number is the `id` sets' job too). */
const ID_COLUMN = /^(id|key|slug|.+_id)$/;
/** At most this many rows per table give identifiers (the sweep stays a few thousand calls). */
const ROWS_PER_TABLE = 5;
/** And at most this many identifiers in all. */
const MAX_IDS = 80;
/** How long A's rows must hold still before the sweep starts, and the longest it waits for that. */
const SETTLE_MS = 6000, SETTLE_MAX_MS = 30000;

/**
 * A value for a JSON Schema (an MCP tool's inputSchema): every string `fill`, enums the hinted value if they list one,
 * numbers the identifier when it is a number, else their minimum or 1, booleans false. Objects get every string
 * property (any of them may be an identifier) and their required ones.
 */
export function fillSchema(schema: unknown, fill: string, hints: string[] = [], depth = 0): unknown {
  const s = (schema && typeof schema === "object" ? schema : {}) as Json;
  if (depth > 6) return fill;
  const alt = (s.anyOf ?? s.oneOf ?? s.allOf) as unknown[] | undefined;
  if (Array.isArray(alt) && alt.length) {
    const pick = alt.find((x) => (x as Json)?.type === "string") ?? alt.find((x) => (x as Json)?.type !== "null") ?? alt[0];
    return fillSchema(pick, fill, hints, depth + 1);
  }
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((v) => hints.includes(String(v))) ?? s.enum[0];
  if (s.const !== undefined) return s.const;
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== "null") : s.type as string | undefined;
  switch (type) {
    case "string": {
      const max = typeof s.maxLength === "number" ? s.maxLength : undefined;
      return max !== undefined && fill.length > max ? fill.slice(0, max) : fill;
    }
    case "integer": case "number":
      return /^-?[0-9]+$/.test(fill) ? Number(fill) : typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean": return false;
    case "array": return [fillSchema(s.items, fill, hints, depth + 1)];
    case "object": case undefined: {
      const props = (s.properties ?? {}) as Record<string, Json>;
      if (type === undefined && !s.properties) return fill;
      const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
      const out: Json = {};
      for (const [name, p] of Object.entries(props)) {
        const t = Array.isArray(p?.type) ? (p.type as string[]) : [p?.type];
        const stringy = t.includes("string") || (p?.type === "array" && (p.items as Json | undefined)?.type === "string")
          || (Array.isArray(p?.anyOf ?? p?.oneOf) && ((p.anyOf ?? p.oneOf) as Json[]).some((x) => x?.type === "string"));
        if (stringy || required.has(name)) out[name] = fillSchema(p, fill, hints, depth + 1);
      }
      return out;
    }
    default: return fill;
  }
}

/** Every string in a value (what B passed in, removed from what came back: an error may echo its argument). */
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : typeof v === "number" ? [String(v)]
  : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** A's rows in every tenant table with an org_id (and its organization row), as text: what B must not change. */
async function snapshot(db: Db, tables: string[], orgId: number): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const t of tables) {
    const rows = await db.query<{ r: string }>(`/* tenant: smoke: one workspace's rows */ SELECT t::text AS r FROM "${t}" t WHERE ${t === "organizations" ? "id" : "org_id"} = $1`, [orgId]);
    out.set(t, rows.map((x) => x.r).sort());
  }
  return out;
}
const sameSnapshot = (x: Map<string, string[]>, y: Map<string, string[]>) => [...x.keys()].filter((t) => JSON.stringify(x.get(t)) !== JSON.stringify(y.get(t)));

/**
 * The sweep. `base` is the smoke run's server; `a` its first workspace with its key (each second one is made here). Returns what it covered,
 * for the line smoke.ts prints; throws (an assertion naming the tool, its arguments and what of A's came back, or the
 * tables of A's that changed) otherwise.
 */
export async function isolationSweep({ base, db, a }: { base: string; db: Db; a: Org }): Promise<{ tools: number; argSets: number; calls: number; ids: number }> {
  const connect = async (key: string) => {
    const c = new Client({ name: "shell-smoke-isolation", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return c;
  };
  // The sweep makes thousands of calls from one key and one address in a minute: the per-minute MCP limits (src/rate-
  // limits.ts, read from the environment on every request) are lifted for it, and put back after.
  const LIMITS = ["APP_LIMIT_MCP_PER_KEY_PER_MINUTE", "APP_LIMIT_MCP_PER_WORKSPACE_PER_MINUTE", "APP_LIMIT_MCP_PER_IP_PER_MINUTE", "APP_LIMIT_MCP_PER_MEMBER_PER_MINUTE"];
  const saved = LIMITS.map((n) => [n, process.env[n]] as const);
  for (const n of LIMITS) process.env[n] = "1000000";
  const A = await connect(a.key);
  const { createOrg } = await import("../src/auth.js");
  const { deleteOrg } = await import("../src/tenancy.js");
  const others: number[] = [];
  try {
    const MARK = `ISOLATION_${randomBytes(6).toString("hex")}`;
    const toolsA = (await A.listTools()).tools;

    // ---------- A's data: the build's declarations, then every tool that writes, called by A ----------
    {
      // An allowance, so A's runs start (each B below gets one too, so its tools that start a run do so with A's identifiers).
      await db.query("UPDATE organizations SET budget_override_usd = 100 WHERE id = $1", [a.org.orgId]);
      const { recordAreas } = await import("../src/record-areas.js");
      for (const area of recordAreas()) {
        if (area.scope === "platform" || area.repo) continue; // shared, or read from a repository: not A's rows
        const data: Json = {};
        for (const f of (area.fields ?? []) as { name: string; type?: string }[]) if (!f.type || f.type === "text") data[f.name] = `${MARK} ${f.name}`;
        await db.query("/* tenant: smoke: workspace A's own record */ INSERT INTO workspace_records (org_id, pack, area, key, title, data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
          [a.org.orgId, area.pack, area.name, `${MARK}-${area.name}`, `Sweep ${MARK}`, JSON.stringify(data)]);
      }
      const { jobKinds, startRun } = await import("../src/runs.js");
      for (const k of jobKinds()) await startRun(a.org.orgId, k.pack, k.name, { scope: { note: MARK } }, "smoke").catch(() => null);
      for (const t of toolsA) {
        if ((t.annotations as Json | undefined)?.readOnlyHint === true) continue;
        await A.callTool({ name: t.name, arguments: fillSchema(t.inputSchema, `${MARK}-${t.name}`) as Json }).catch(() => null);
      }
    }

    // ---------- A's identifiers, from every tenant table ----------
    const { tenantTables } = await import("../src/rls.js");
    const withOrg = new Set((await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id'")).map((r) => r.table_name));
    const tables = (await tenantTables(db)).filter((t) => t === "organizations" || withOrg.has(t));
    const ids = new Map<string, string[]>();
    const own = new Set<string>(); // the identifiers that are A's alone: looked for in what comes back
    for (const t of tables) {
      const rows = await db.query<{ j: Json }>(`/* tenant: smoke: one workspace's rows */ SELECT to_jsonb(t) AS j FROM "${t}" t WHERE ${t === "organizations" ? "id" : "org_id"} = $1 LIMIT ${ROWS_PER_TABLE}`, [a.org.orgId]);
      for (const { j } of rows) {
        const row = typeof j === "string" ? JSON.parse(j) as Json : j;
        const hints = [t, row.pack, row.area, row.kind].filter((x): x is string => typeof x === "string");
        for (const [col, v] of Object.entries(row)) {
          if (col === "org_id" || !ID_COLUMN.test(col) || (typeof v !== "string" && typeof v !== "number")) continue;
          const value = String(v);
          if (value.includes(MARK) || (col === "id" && typeof v === "string" && v.length >= 8)) own.add(value);
          if (value && !ids.has(value) && ids.size < MAX_IDS) ids.set(value, hints);
        }
      }
    }
    // What would show a leak: A's mark, its key, its slug, and every identifier that is A's alone (a text `id`, or
    // anything carrying the mark). Shared values (a pack or kind name, a bare number) are passed as arguments but not
    // looked for: they could match anything.
    const leakable = [MARK, a.key, a.org.slug, ...own];

    const argSets: ArgSet[] = [{ kind: "empty" }, { kind: "text" }, ...[...ids].map(([value, hints]) => ({ kind: "id" as const, value, hints }))];
    // Settle: what A's own calls write after they answer lands before the snapshot (logs, and work a pack defers a few
    // seconds after a tool call, such as a progress sync): A's rows must hold still for SETTLE_MS, within SETTLE_MAX_MS.
    let before = await snapshot(db, tables, a.org.orgId);
    for (let still = 0, waited = 0; still < SETTLE_MS && waited < SETTLE_MAX_MS; waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
      const again = await snapshot(db, tables, a.org.orgId);
      if (sameSnapshot(before, again).length) { before = again; still = 0; } else still += 500;
    }

    // ---------- every tool, as B, with every argument set ----------
    // One B per argument set (the second workspace, made for it and deleted after): what a B writes with A's identifiers
    // (a record named after one, a run whose scope holds one) is B's own, and comes back in B's later results. So every
    // string a B has passed is taken out of what it gets back, and a fresh B per set keeps the rest of A's identifiers
    // (and A's mark, outside the free-text set) looked for in every result.
    let calls = 0, toolCount = 0;
    const stamp = randomBytes(4).toString("hex");
    for (const [i, set] of argSets.entries()) {
      const b = await createOrg(`Shell smoke isolation B${i}`, `shell-smoke-iso-b${i}-${stamp}`);
      others.push(b.org.orgId);
      await db.query("UPDATE organizations SET budget_override_usd = 100 WHERE id = $1", [b.org.orgId]);
      const B = await connect(b.key);
      try {
        const toolsB = (await B.listTools()).tools;
        assert.deepEqual(toolsB.map((t) => t.name).sort(), toolsA.map((t) => t.name).sort(), "both workspaces list the same tools");
        toolCount = toolsB.length;
        const passed = new Set<string>();
        for (const tool of toolsB) {
          const args = set.kind === "empty" ? {} : fillSchema(tool.inputSchema, set.kind === "text" ? MARK : set.value, set.kind === "id" ? set.hints : []) as Json;
          for (const v of strings(args)) if (v.length >= 3) passed.add(v);
          const r = await B.callTool({ name: tool.name, arguments: args }).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] }));
          calls++;
          let text = JSON.stringify((r as Json).structuredContent ?? null) + JSON.stringify((r as Json).content ?? null);
          for (const v of [...passed].sort((x, y) => y.length - x.length)) text = text.split(v).join("");
          const leaked = leakable.filter((x) => text.includes(x));
          assert.deepEqual(leaked, [], `isolation: ${tool.name} ${JSON.stringify(args).slice(0, 300)} as workspace B returned workspace A's ${leaked.join(", ")}`);
        }
      } finally { await B.close().catch(() => {}); }
      const changed = sameSnapshot(before, await snapshot(db, tables, a.org.orgId));
      assert.deepEqual(changed, [], `isolation: workspace B's calls (${set.kind === "id" ? `with ${set.value}` : set.kind}) changed workspace A's rows in ${changed.join(", ")}`);
    }
    return { tools: toolCount || toolsA.length, argSets: argSets.length, calls, ids: ids.size };
  } finally {
    await A.close().catch(() => {});
    for (const id of others) await deleteOrg(id).catch((e) => console.error(`isolation sweep: delete workspace ${id}: ${(e as Error).message}`));
    for (const [n, v] of saved) if (v === undefined) delete process.env[n]; else process.env[n] = v;
  }
}
