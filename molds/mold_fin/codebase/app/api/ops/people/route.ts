import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { customerStakeholders, internalStaff } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The people the notify-recipients picker searches. They live in TWO tables —
 * `internal_staff` (us) and `customer_stakeholders` (them) — and the SAME person
 * appears once per customer they are attached to, so a naive union shows
 * duplicates. We dedupe by email (case-insensitive) and collapse the customers
 * each person appears under into a `customers` list, which the picker shows as
 * context.
 *
 * There are only a handful of rows, so this reads both tables whole and filters
 * in memory rather than pushing a UNION + ILIKE into SQL.
 */
export interface OpsPerson {
  name: string;
  email: string;
  title: string | null;
  org: string | null;
  role: string | null;
  kind: "internal" | "stakeholder";
  customers: string[];
}

const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : DEFAULT_LIMIT;

  try {
    const [staff, stakeholders] = await withOrgRls(ctx.orgId, (tx) =>
      Promise.all([
        tx.select().from(internalStaff).where(eq(internalStaff.orgId, ctx.orgId)),
        tx.select().from(customerStakeholders).where(eq(customerStakeholders.orgId, ctx.orgId)),
      ]));

    // Dedupe by lowercased email; merge the customer ids the person shows up under.
    const byEmail = new Map<string, OpsPerson>();
    const add = (
      kind: "internal" | "stakeholder",
      row: {
        name: string | null;
        email: string | null;
        title: string | null;
        employerOrg: string | null;
        customerId: string | null;
        role: string | null;
      },
    ) => {
      if (!row.email) return; // an email is the whole point — skip rows without one
      const key = row.email.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) {
        if (row.customerId && !existing.customers.includes(row.customerId)) {
          existing.customers.push(row.customerId);
        }
        return;
      }
      byEmail.set(key, {
        name: row.name ?? row.email,
        email: row.email,
        title: row.title,
        org: row.employerOrg,
        role: row.role,
        kind,
        customers: row.customerId ? [row.customerId] : [],
      });
    };

    for (const r of staff) {
      add("internal", {
        name: r.name,
        email: r.email,
        title: r.title,
        employerOrg: r.employerOrg,
        customerId: r.customerId,
        role: r.staffRole,
      });
    }
    for (const r of stakeholders) {
      add("stakeholder", {
        name: r.name,
        email: r.email,
        title: r.title,
        employerOrg: r.employerOrg,
        customerId: r.customerId,
        role: r.stakeholderRole,
      });
    }

    const matches = (p: OpsPerson) =>
      !q ||
      [p.name, p.email, p.title, p.org].some((f) => f?.toLowerCase().includes(q));

    const items = [...byEmail.values()]
      .filter(matches)
      // Us first, then them; alphabetical within each group.
      .sort((a, b) =>
        a.kind !== b.kind
          ? a.kind === "internal"
            ? -1
            : 1
          : a.name.localeCompare(b.name),
      )
      .slice(0, limit);

    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
