/**
 * The onboarding checklist from pack-declared steps (mold_v0-011; molds/mold_v0/MOLD.md "Pack and record-area contract").
 * A pack declares steps (definePack({ onboarding }): an id, a label, help, and `done_when`); the shell works out, for
 * one workspace at a time, which are done, from what has really happened in that workspace, and the console's Setup
 * page shows them (web/src/features/portal/setup.tsx, from /api/onboarding). With no pack declaring a step nothing is
 * mounted and the Setup page is exactly what it was.
 *
 * Conditions (src/pack-api.ts ONBOARDING_CONDITION), each read for the calling workspace only (its id from the session;
 * every query names it and runs under row-level security for it, except the credential vault, which tenant work cannot
 * reach and which is read by the shell with the workspace's id):
 *   workspace          the workspace exists (done from the start)
 *   connected          an MCP client connected (initialize)
 *   first_call         any tool call succeeded
 *   tool:<name>        a call of that tool succeeded (a shell tool, list_records/get_record, or any pack's)
 *   credential:<name>  a value of that credential field of the pack is set (any asset or environment)
 *   record:<area>      a record exists in that workspace-scope area of the pack
 *   run:<kind>         a run of that job kind of the pack succeeded
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { customerSession, type Session } from "./app.js";
import { hasCredential } from "./credentials.js";
import { getDb } from "./db.js";
import { OnboardingStepSchema, PackError, z } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

export type OnboardingStep = z.output<typeof OnboardingStepSchema> & { pack: string };

let cache: { from: unknown; list: OnboardingStep[] } | null = null;
/** Every step the packs declare, in pack order then declaration order. */
export function onboardingSteps(): OnboardingStep[] {
  const list = packs();
  if (cache?.from === list) return cache.list;
  cache = { from: list, list: list.flatMap((p) => (p.definition.onboarding ?? []).map((s) => ({ ...OnboardingStepSchema.parse(s), pack: p.id }))) };
  return cache.list;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** When the condition first held for workspace `orgId` (an ISO time), or null while it does not. */
async function doneAt(orgId: number, s: OnboardingStep): Promise<string | null> {
  const [what, arg = ""] = s.done_when.split(":", 2) as [string, string?];
  if (what === "credential") return (await hasCredential(orgId, s.pack, arg))?.at ?? null;
  return withTenant(orgId, async () => {
    const db = await getDb();
    const one = async (sql: string, params: unknown[]) => iso((await db.query<{ at: Date | null }>(sql, params))[0]?.at);
    switch (what) {
      case "workspace": return one("SELECT created_at AS at FROM organizations WHERE id = $1", [orgId]);
      case "connected": return one("SELECT min(at) AS at FROM mcp_events WHERE org_id = $1 AND method = 'initialize'", [orgId]);
      case "first_call": return one("SELECT min(at) AS at FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok", [orgId]);
      case "tool": return one("SELECT min(at) AS at FROM mcp_events WHERE org_id = $1 AND method = 'tools/call' AND ok AND name = $2", [orgId, arg]);
      case "record": return one("SELECT min(created_at) AS at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3", [orgId, s.pack, arg]);
      case "run": return one("SELECT min(ended_at) AS at FROM runs WHERE org_id = $1 AND pack = $2 AND kind = $3 AND status = 'succeeded'", [orgId, s.pack, arg]);
      default: return null; // refused when the pack loads (src/pack-api.ts): never reached
    }
  });
}

/** A step's key across packs: `<pack>:<id>` (step ids are unique within a pack only). */
export const stepKey = (s: { pack: string; id: string }) => `${s.pack}:${s.id}`;
/** The conditions the shell's own account stages already measure (src/admin.ts): not stages of their own. */
const SHELL_CONDITIONS = new Set(["workspace", "connected", "first_call"]);
/** The steps that are account stages on the admin console (src/admin.ts accountStages): every step but the shell's. */
export const stageSteps = (): OnboardingStep[] => onboardingSteps().filter((s) => !SHELL_CONDITIONS.has(s.done_when.split(":", 1)[0]!));

/**
 * When each workspace first met each of `stageSteps()` (mold_v0-103): the same conditions as doneAt, for the admin
 * console's funnel, read across workspaces in one grouped query per kind of condition (platform staff only; the
 * caller is the admin console). `orgIds` narrows it to those workspaces. Workspaces with none met are absent.
 */
export async function stageStepsReached(orgIds?: number[]): Promise<Map<number, Record<string, string>>> {
  const steps = stageSteps();
  const out = new Map<number, Record<string, string>>();
  if (!steps.length || (orgIds && !orgIds.length)) return out;
  const by = (what: string) => steps.filter((s) => s.done_when.startsWith(`${what}:`));
  const ids = orgIds ?? null;
  type Row = { org_id: number; a: string; b: string; at: Date | string | null };
  const q = async (what: string, sql: string, params: unknown[]): Promise<Row[]> => (by(what).length ? (await getDb()).query<Row>(sql, [...params, ids]) : []);
  const packsOf = (what: string) => [...new Set(by(what).map((s) => s.pack))];
  const [runs, records, tools, creds] = await asPlatform(() => Promise.all([
    q("run", `/* tenant: internal: the admin console's account funnel, every workspace (or those listed) */
      SELECT org_id, pack AS a, kind AS b, min(ended_at) AS at FROM runs WHERE status = 'succeeded' AND pack = ANY($1::text[])
        AND ($2::int[] IS NULL OR org_id = ANY($2::int[])) GROUP BY org_id, pack, kind`, [packsOf("run")]),
    q("record", `/* tenant: internal: the admin console's account funnel, every workspace (or those listed) */
      SELECT org_id, pack AS a, area AS b, min(created_at) AS at FROM workspace_records WHERE org_id IS NOT NULL AND pack = ANY($1::text[])
        AND ($2::int[] IS NULL OR org_id = ANY($2::int[])) GROUP BY org_id, pack, area`, [packsOf("record")]),
    q("tool", `/* tenant: internal: the admin console's account funnel, every workspace (or those listed) */
      SELECT org_id, '' AS a, name AS b, min(at) AS at FROM mcp_events WHERE method = 'tools/call' AND ok AND name = ANY($1::text[])
        AND ($2::int[] IS NULL OR org_id = ANY($2::int[])) GROUP BY org_id, name`, [by("tool").map((s) => s.done_when.slice(5))]),
    q("credential", `/* tenant: internal: the admin console's account funnel, every workspace (or those listed) */
      SELECT org_id, pack AS a, name AS b, min(created_at) AS at FROM workspace_credentials WHERE pack = ANY($1::text[])
        AND ($2::int[] IS NULL OR org_id = ANY($2::int[])) GROUP BY org_id, pack, name`, [packsOf("credential")]),
  ]));
  const index = (rows: Row[]) => new Map(rows.map((r) => [`${r.org_id} ${r.a} ${r.b}`, iso(r.at)]));
  const at = { run: index(runs), record: index(records), tool: index(tools), credential: index(creds) } as Record<string, Map<string, string | null>>;
  const orgs = new Set([...runs, ...records, ...tools, ...creds].map((r) => Number(r.org_id)));
  for (const org of orgs) {
    const reached: Record<string, string> = {};
    for (const s of steps) {
      const [what, arg = ""] = s.done_when.split(":", 2) as [string, string?];
      const t = at[what]?.get(`${org} ${what === "tool" ? "" : s.pack} ${arg}`);
      if (t) reached[stepKey(s)] = t;
    }
    if (Object.keys(reached).length) out.set(org, reached);
  }
  return out;
}

/**
 * The shell's setup step (src/app.ts setup) a pack step stands for, by its condition (mold_v0-146): the console's one
 * checklist shows the pack's step in its place, so the same thing is never asked twice.
 */
const SHELL_STEP: Record<string, string> = { workspace: "joined", connected: "connected", first_call: "first_call" };

/**
 * The checklist for workspace `orgId`: every pack step (or only pack `pack`'s: its get_started tool, mold_v0-105, in
 * src/mcp-tools.ts), done or not, with when it was done.
 */
export async function onboardingFor(orgId: number, pack?: string) {
  const steps = await Promise.all(onboardingSteps().filter((s) => pack === undefined || s.pack === pack).map(async (s) => {
    const at = await doneAt(orgId, s);
    return { pack: s.pack, id: s.id, label: s.label, help: s.help ?? null, done: at !== null, at, covers: SHELL_STEP[s.done_when.split(":", 1)[0]!] ?? null };
  }));
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

/** /api/onboarding: a signed-in person of the workspace reads its checklist. Read only; nothing is mounted without steps. */
export function onboardingAppRouter(): Router {
  const r = express.Router();
  if (!onboardingSteps().length) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try { res.json(await onboardingFor((res.locals.session as Session).org)); }
    catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
  });
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
