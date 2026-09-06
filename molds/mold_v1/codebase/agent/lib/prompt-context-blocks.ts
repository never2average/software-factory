/** Workspace-scoped loaders for bounded, volatile prompt blocks. */
import { and, asc, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, withOrgDb } from "./db/index.ts";
import { peopleRoster, roomPresence, scheduleRules } from "./db/schema.ts";
import { DEFAULT_ORG } from "./org-context.ts";
import type { ContextEnvelope } from "./prompt-context.ts";

function tenantCondition(column: AnyPgColumn, orgId: string) {
  return orgId === DEFAULT_ORG
    ? or(eq(column, orgId), isNull(column))
    : eq(column, orgId);
}

function envelope(
  orgId: string,
  source: string,
  id: string,
  observedAt: Date | string,
  data: unknown,
): ContextEnvelope {
  return {
    id,
    source,
    provenance: "workspace-postgres-read",
    audience: { orgId },
    observedAt: observedAt instanceof Date ? observedAt.toISOString() : observedAt,
    trust: "untrusted",
    data,
  };
}

export async function loadScheduleContext(orgId: string): Promise<ContextEnvelope[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select({
          id: scheduleRules.id,
          name: scheduleRules.name,
          kind: scheduleRules.kind,
          customerId: scheduleRules.customerId,
          cron: scheduleRules.cron,
          everyMinutes: scheduleRules.everyMinutes,
          prompt: scheduleRules.prompt,
          channelId: scheduleRules.channelId,
          nextRunAt: scheduleRules.nextRunAt,
          updatedAt: scheduleRules.updatedAt,
        })
        .from(scheduleRules)
        .where(and(eq(scheduleRules.enabled, true), tenantCondition(scheduleRules.orgId, orgId)))
        .orderBy(asc(scheduleRules.nextRunAt), asc(scheduleRules.id))
        .limit(10),
    );
    return rows.map((row) => envelope(orgId, "schedule_rules", row.id, row.updatedAt, {
      name: row.name,
      kind: row.kind,
      customerId: row.customerId,
      cron: row.cron,
      everyMinutes: row.everyMinutes,
      prompt: row.prompt,
      channelId: row.channelId,
      nextRunAt: row.nextRunAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function loadRoomContext(orgId: string): Promise<ContextEnvelope[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const activeSince = new Date(Date.now() - 5 * 60_000);
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select({
          room: roomPresence.room,
          email: roomPresence.email,
          activity: roomPresence.activity,
          lastSeenAt: roomPresence.lastSeenAt,
        })
        .from(roomPresence)
        .where(and(eq(roomPresence.orgId, orgId), gte(roomPresence.lastSeenAt, activeSince)))
        .orderBy(desc(roomPresence.lastSeenAt), asc(roomPresence.room), asc(roomPresence.email))
        .limit(30),
    );
    return rows.map((row) => envelope(
      orgId,
      "room_presence",
      `${row.room}:${row.email}`,
      row.lastSeenAt,
      { room: row.room, email: row.email, activity: row.activity },
    ));
  } catch {
    return [];
  }
}

export async function loadRosterContext(orgId: string): Promise<ContextEnvelope[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select({
          email: peopleRoster.email,
          name: peopleRoster.name,
          team: peopleRoster.team,
          managerEmail: peopleRoster.managerEmail,
          updatedAt: peopleRoster.updatedAt,
        })
        .from(peopleRoster)
        .where(and(tenantCondition(peopleRoster.orgId, orgId), isNull(peopleRoster.archivedAt)))
        .orderBy(asc(peopleRoster.email))
        .limit(20),
    );
    return rows.map((row) => envelope(orgId, "people_roster", row.email, row.updatedAt, {
      email: row.email,
      name: row.name,
      team: row.team,
      managerEmail: row.managerEmail,
    }));
  } catch {
    return [];
  }
}
