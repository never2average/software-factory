import { NextRequest, NextResponse } from "next/server";
import { deployments, implementation } from "@/agent/lib/db/schema";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import { isDeclared, type AccountAreaId } from "@/agent/lib/record-area-records";
import { countRecordMetrics } from "@/agent/lib/record-metrics";
import type { AreaTable } from "@/agent/lib/record-query";
import { errorText } from "@/lib/ops-errors";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = { deployments, implementations: implementation } as const;
const ACCOUNT_AREAS = Object.keys(TABLE) as AccountAreaId[];

/**
 * GET /api/ops/record-metrics?area=deployments|implementations — the metrics the area's definition declares
 * (records.areas.<area>.metrics), counted in the database over the caller's workspace's records
 * (agent/lib/record-metrics.ts, the list query's own conditions): `{ metrics: [{ id, label, value, text, attention,
 * format }] }`. An area that declares none (every default) answers `{ metrics: [] }` without a query.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const area = new URL(request.url).searchParams.get("area");
  if (!(ACCOUNT_AREAS as string[]).includes(area ?? "")) {
    // The two ids are the routes' own (an identifier, never a word a person reads in a relabelled deployment).
    return NextResponse.json({ error: `Name the record area: ?area=${ACCOUNT_AREAS.join(" or ?area=")}.` }, { status: 400 });
  }
  const id = area as AccountAreaId;
  if (!isDeclared(id) || !(RECORD_AREAS[id].metrics ?? []).length || !getOpsDb()) return NextResponse.json({ metrics: [] });
  try {
    const metrics = await withOrgRls(ctx.orgId, (tx) => countRecordMetrics(tx, id, TABLE[id] as unknown as AreaTable, ctx.orgId));
    return NextResponse.json({ metrics });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
