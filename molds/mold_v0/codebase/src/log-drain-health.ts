/**
 * A log drain's health (mold_v0-325): is the hosting provider's request log reaching this workspace, and since when has
 * it not? For each log-drain receiver the build declares (pack.json developer_surface.webhooks_in[] with `log_drain`),
 * a workspace's state is one of
 *
 *   not_connected   no source for the receiver yet: nobody gave the provider this app's address
 *   waiting         a source exists and nothing has arrived yet
 *   receiving       the last delivery is less than `silent_hours` old
 *   silent          the last delivery is `silent_hours` old or more
 *
 * The scheduled check (logDrainCheck, from the scheduler's tick as job `log_drains`) marks a silent source once
 * (webhook_sources.silent_since, migration 0074) and logs one line for it; it never marks it again until a delivery
 * clears it (src/developer-inbound.ts touch), so a silence is reported once, however long it lasts. The console reads
 * the state (GET /api/log-drains/status) and shows it above the pages that read the drain's records (their charts,
 * lists and the home page when silent); nothing is emailed.
 */
import express, { type Router } from "express";
import { customerSession, type Session } from "./app.js";
import { getDb } from "./db.js";
import { developerSurface } from "./developer-surface.js";
import { logDrainOptions } from "./log-drain.js";
import { findArea, may } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";

export type DrainState = "not_connected" | "waiting" | "receiving" | "silent";
export interface DrainStatus {
  receiver: string;
  /** The record areas the drain fills: its report area and, with compare, its comparisons'. */
  areas: string[];
  state: DrainState;
  sources: number;
  last_received_at: string | null;
  silent_since: string | null;
  silent_hours: number;
  /** Whole hours since the last delivery (null: never). */
  hours_since: number | null;
}

/** The build's log-drain receivers, with their options. */
export function logDrainReceivers() {
  return (developerSurface()?.webhooks_in ?? []).flatMap((r) => {
    const o = logDrainOptions(r);
    return o ? [{ name: r.name, area: r.area, o }] : [];
  });
}
export const logDrainsWired = () => logDrainReceivers().length > 0;

interface Row { receiver: string; n: number; last: Date | null; silent: Date | null }

/** One workspace's drains (every receiver; `orgId` null: none of its sources are read). */
export async function drainStatus(orgId: number, now = Date.now()): Promise<DrainStatus[]> {
  const rcv = logDrainReceivers();
  if (!rcv.length) return [];
  const rows = await asPlatform(async () => (await getDb()).query<Row>(
    `SELECT receiver, count(*)::int AS n, max(last_received_at) AS last, max(silent_since) AS silent
       FROM webhook_sources WHERE org_id = $1 AND disabled_at IS NULL AND receiver = ANY($2) GROUP BY receiver`, [orgId, rcv.map((r) => r.name)]));
  return rcv.map(({ name, area, o }) => {
    const r = rows.find((x) => x.receiver === name);
    const last = r?.last ? new Date(r.last).getTime() : null;
    const hours = last === null ? null : Math.floor((now - last) / 3_600_000);
    const state: DrainState = !r?.n ? "not_connected" : last === null ? "waiting" : hours! >= o.silent_hours ? "silent" : "receiving";
    return { receiver: name, areas: [area, ...(o.compare ? [o.compare.area] : [])], state, sources: r?.n ?? 0,
      last_received_at: last === null ? null : new Date(last).toISOString(), silent_since: r?.silent ? new Date(r.silent).toISOString() : null,
      silent_hours: o.silent_hours, hours_since: hours };
  });
}

/**
 * The scheduled check: every enabled source of a log-drain receiver whose last delivery (or, never delivered, whose
 * creation) is `silent_hours` old or more and that is not marked yet is marked silent, once. A source that never
 * received is marked too (set up, but nothing came).
 */
export async function logDrainCheck(now = new Date()): Promise<{ ran: boolean; marked: number }> {
  const rcv = logDrainReceivers();
  if (!rcv.length) return { ran: false, marked: 0 };
  let marked = 0;
  for (const { name, o } of rcv) {
    const rows = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number }>(
      `/* tenant: the scheduler marks every workspace's silent sources, by receiver */
       UPDATE webhook_sources SET silent_since = $3
        WHERE receiver = $1 AND disabled_at IS NULL AND silent_since IS NULL
          AND coalesce(last_received_at, created_at) <= $3::timestamptz - make_interval(hours => $2::int)
        RETURNING id, org_id`, [name, o.silent_hours, now]));
    marked += rows.length;
    for (const r of rows) console.error(`log drain: workspace ${r.org_id}: no request logs for ${o.silent_hours} hours or more (receiver ${name}, source ${r.id})`);
  }
  return { ran: true, marked };
}

/** /api/log-drains: mounted when the build has a log-drain receiver. */
export function logDrainAppRouter(): Router {
  const r = express.Router();
  if (!logDrainsWired()) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/status", async (_req, res, next) => {
    try {
      const s = res.locals.session as Session;
      const actor = { role: s.accountRole ?? null, userId: s.user ?? null };
      // A drain is shown to those who may read one of the areas it fills.
      const all = await drainStatus(s.org);
      res.json({ drains: all.filter((d) => d.areas.some((a) => { const x = findArea(a); return !!x && may(x, "read", actor); })) });
    } catch (e) { next(e); }
  });
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
