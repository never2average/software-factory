import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { orgMembers, orgs, platformAdmins } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { seedWorkspace } from "@/lib/org-seed";
import { provisionWorkspace } from "@/agent/lib/provision-workspace";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { DEFAULT_DOMAIN, DEFAULT_ORG, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Org (workspace) provisioning.
 *
 *  GET  /api/ops/orgs  — the workspaces the caller belongs to (all of them for a
 *                        platform admin). Powers the workspace switcher.
 *  POST /api/ops/orgs  — create a workspace (PLATFORM ADMIN ONLY). Writes the
 *                        org row + the creator as owner, and derives the slug.
 *
 * Fail-safe: before the tenancy migration is live, GET returns the single
 * implicit org so the UI has something to render.
 */

async function isPlatformAdmin(db: NonNullable<ReturnType<typeof getOpsDb>>, email: string) {
  const [row] = await db.select().from(platformAdmins).where(eq(platformAdmins.email, email)).limit(1);
  return Boolean(row);
}

/** slugify a company name → workspace id: 'OnFinance Inc.' → 'onfinance-inc'. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function GET(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    // Pre-migration: the single implicit workspace.
    return NextResponse.json({
      // Pre-migration there is one implicit workspace and no `orgs` row to
      // read a name from. It used to be labelled with the first customer's
      // company name, which every later tenant would then see as the name of
      // THEIR workspace.
      items: [{ orgId: DEFAULT_ORG, name: "Workspace", role: "owner", status: "active" }],
    });
  }
  try {
    const admin = await isPlatformAdmin(db, identity.email);
    if (admin) {
      const rows = await db.select().from(orgs).orderBy(desc(orgs.createdAt));
      return NextResponse.json({
        items: rows.map((o) => ({ orgId: o.orgId, name: o.name, role: "admin", status: o.status, branding: o.branding ?? null })),
        platformAdmin: true,
      });
    }
    const email = identity.email.toLowerCase();
    let memberships = await db
      .select({ orgId: orgMembers.orgId, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.email, email));

    /**
     * JOIN ON FIRST SIGN-IN when this domain is already claimed.
     *
     * Claiming a domain is documented as auto-joining everyone from it, and the
     * data layer behaves that way — orgContextForRequest resolves a workspace by
     * hosted domain. But no membership row was ever written, and THIS list is
     * what the auth gate reads: no rows meant "you have no workspace", which
     * sent every employee after the first to onboarding, where creating the
     * workspace fails because the domain is taken. A dead end for everyone but
     * the founder.
     *
     * So the membership the claim already implies is made real here, on the
     * first request that needs it. Idempotent, and it only ever grants `member`
     * — an owner still decides who gets more.
     */
    if (memberships.length === 0 && identity.hostedDomain) {
      const [byDomain] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        .where(and(eq(orgs.googleHostedDomain, identity.hostedDomain), ne(orgs.status, "suspended")))
        .limit(1);
      if (byDomain) {
        await db
          .insert(orgMembers)
          .values({ orgId: byDomain.orgId, email, role: "member", acceptedAt: new Date() })
          .onConflictDoNothing();
        memberships = [{ orgId: byDomain.orgId, role: "member" }];
      }
    }
    const ids = memberships.map((m) => m.orgId);
    const rows = ids.length
      ? await db.select().from(orgs).where(inArray(orgs.orgId, ids))
      : [];
    const roleOf = new Map(memberships.map((m) => [m.orgId, m.role]));
    return NextResponse.json({
      items: rows.map((o) => ({ orgId: o.orgId, name: o.name, role: roleOf.get(o.orgId) ?? "member", status: o.status, branding: o.branding ?? null })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().optional(),
  googleHostedDomain: z.string().trim().toLowerCase().optional(),
  // Workspace logo captured during onboarding (small square data URI).
  branding: z.object({ logoUrl: z.string().optional(), displayName: z.string().optional() }).optional(),
});

export async function POST(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await tenancyEnabled(db))) {
    return NextResponse.json({ error: "Tenancy is not enabled yet (migration pending)." }, { status: 409 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  // Self-serve: any verified work identity can create a workspace and become its
  // owner. Platform admins can too. The privileged action is claiming a DOMAIN
  // (which auto-joins everyone from it), so that — not creation — is gated.
  const domain = parsed.data.googleHostedDomain || null;
  if (domain) {
    // You may only claim the domain you actually sign in from — no vacuuming a
    // domain you don't control into a workspace you own.
    if (domain !== identity.hostedDomain) {
      return NextResponse.json(
        { error: `You can only claim the domain you sign in from (${identity.hostedDomain ?? "none"}).` },
        { status: 403 },
      );
    }
    /**
     * onfinance.in is reserved FOR org #1 — but only while org #1 exists.
     *
     * This used to refuse unconditionally, which was fine while the primary
     * workspace was guaranteed present. It is not: after the database moved to
     * Supabase, org-onfinance was gone, and the reservation then guarded a
     * workspace that did not exist while locking out the only people entitled
     * to recreate it. Signing in from the domain you are claiming is already
     * checked above, so gating on the row's existence is the whole condition.
     */
    if (domain === DEFAULT_DOMAIN) {
      const [primary] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        .where(eq(orgs.orgId, DEFAULT_ORG))
        .limit(1);
      if (primary) {
        return NextResponse.json({ error: "That domain is reserved.", joinOrgId: DEFAULT_ORG }, { status: 409 });
      }
    }
    const [claimed] = await db
      .select({ orgId: orgs.orgId, name: orgs.name })
      .from(orgs)
      .where(eq(orgs.googleHostedDomain, domain))
      .limit(1);
    if (claimed) {
      return NextResponse.json(
        { error: `Domain '${domain}' already belongs to '${claimed.name}'. Request to join it instead.`, joinOrgId: claimed.orgId },
        { status: 409 },
      );
    }
  }
  const base = slugify(parsed.data.slug || parsed.data.name);
  if (!base) return NextResponse.json({ error: "Could not derive a workspace id." }, { status: 400 });
  // Company workspace ids are prefixed `org-` (the primary onfinance org keeps
  // its bare slug). Avoid double-prefixing if the caller already included it.
  const orgId = base.startsWith("org-") ? base : `org-${base}`;
  try {
    const [existing] = await db.select({ orgId: orgs.orgId }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
    if (existing) return NextResponse.json({ error: `Workspace '${orgId}' already exists.` }, { status: 409 });
    const [row] = await db
      .insert(orgs)
      .values({
        orgId,
        name: parsed.data.name,
        googleHostedDomain: parsed.data.googleHostedDomain || null,
        branding: parsed.data.branding ?? null,
        blobPrefix: `orgs/${orgId}`,
        // Usable the moment it exists. "provisioning" was written and never
        // cleared by anything, and the domain lookup required "active" — so a
        // self-serve workspace's domain matched nobody, permanently.
        status: "active",
        createdBy: identity.email,
      })
      .returning();
    // The creator is the workspace owner.
    await db
      .insert(orgMembers)
      .values({ orgId, email: identity.email.toLowerCase(), role: "owner", acceptedAt: new Date() })
      .onConflictDoNothing();
    // Lay down the starter tree so the console opens onto something readable
    // instead of three empty panels. Best-effort — see lib/org-seed.ts.
    const seeded = await seedWorkspace(orgId, row.name);
    /**
     * Install the recipe catalog and the workflow library. A workspace with no
     * workflows is not a workspace anyone can use, and until now the only way
     * to get them was an FDE remembering to run `fde:seed-workflows --org <id>`
     * by hand.
     *
     * Inside the new workspace's RLS scope, not on the unscoped handle above:
     * `orgs` and `org_members` are the control plane and carry no policy, but
     * `recipes` and `workflows` fail closed, so as app_rw the unscoped insert
     * was refused — caught below as a "best-effort" failure — and every
     * self-serve workspace came out with an empty library. Same shape as
     * `fde:new-org`, which is the other door onto these tables.
     *
     * Best-effort on purpose: the workspace itself is already created and
     * usable, so a seeding failure must not turn a successful signup into a
     * 500. It is reported in the response instead of thrown.
     */
    let provisioned: Awaited<ReturnType<typeof provisionWorkspace>> | null = null;
    let provisionError: string | null = null;
    try {
      provisioned = await withOrgRls(orgId, (tx) => provisionWorkspace(tx, orgId, identity.email));
    } catch (e) {
      provisionError = e instanceof Error ? e.message : String(e);
      console.error("provisionWorkspace failed", { orgId, error: provisionError });
    }
    return NextResponse.json(
      {
        item: { orgId: row.orgId, name: row.name, status: row.status },
        seeded,
        provisioned,
        ...(provisionError ? { provisionError } : {}),
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
