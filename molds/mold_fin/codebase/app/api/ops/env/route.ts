import { NextResponse } from "next/server";
import { runtimeEnvPresence } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the RUNNING agent has in its environment — names and a boolean, never a
 * value. Written by the agent's every-minute dispatcher (agent/lib/env-presence.ts);
 * the Ops Center runs in a different Vercel project and cannot see the agent's
 * process, so this table is the only honest answer to "is that token live?".
 */
export async function GET() {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  try {
    const items = await db.select().from(runtimeEnvPresence);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
