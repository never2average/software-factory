import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { browserCredentials, customers } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { encryptSecret, hasSecretsKey } from "@/lib/secret-crypto";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The browser login credential vault — per-customer, per-site username/password
 * the agent's browser_login uses. The password is AES-256-GCM sealed with
 * OPS_SECRETS_KEY before it touches the DB; **no route ever returns the
 * plaintext** — GET returns only username + a last-4 hint, mirroring the
 * connector-secrets rule. Deliberately NOT surfaced in the Ops Center admin UI
 * (API only): the agent decrypts inside browser_login's execute().
 */
async function caller(request: NextRequest): Promise<string | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  return identity?.email ?? null;
}

function normHost(input: string): string {
  try {
    return new URL(input.includes("://") ? input : `https://${input}`).host.replace(/^www\./, "");
  } catch {
    return input.replace(/^www\./, "");
  }
}

export async function GET(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  if (!(await caller(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Workspace-scoped. These rows are sealed site logins; until the tenancy
    // migration the table had no org_id, so every workspace listed every
    // other workspace's stored credentials (usernames and which sites).
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(browserCredentials).where(eq(browserCredentials.orgId, ctx.orgId))
        .orderBy(asc(browserCredentials.customerId)));
    // NEVER return the ciphertext or plaintext — only what identifies the entry.
    return NextResponse.json({
      items: rows.map((r) => ({
        customerId: r.customerId,
        siteOrigin: r.siteOrigin,
        username: r.username,
        hint: r.secretHint,
        addedBy: r.addedBy,
        at: r.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const createSchema = z.object({
  customerId: z.string().min(1),
  siteOrigin: z.string().min(3),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await caller(request);
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSecretsKey()) {
    return NextResponse.json(
      { error: "OPS_SECRETS_KEY is not configured — cannot store credentials securely." },
      { status: 503 },
    );
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const siteOrigin = normHost(parsed.data.siteOrigin);
  // Seal with the CUSTOMER's workspace key (HKDF), so only that workspace's
  // derived key decrypts it. The agent's browser_login uses the same salt.
  // Is the customer in THIS workspace? Asked in the workspace's own scope, so row-level security answers it. It
  // was asked on the bare handle (orgForCustomerId), which under the fail-closed policy sees no row and answers
  // the default workspace for every id: the default workspace passed for any id, every other one for none.
  const [owned] = await withOrgRls(ctx.orgId, (tx) =>
    tx
      .select({ id: customers.customerId })
      .from(customers)
      .where(and(eq(customers.customerId, parsed.data.customerId), eq(customers.orgId, ctx.orgId)))
      .limit(1),
  );
  if (!owned) {
    return NextResponse.json({ error: `${W.Account} is not in this workspace.` }, { status: 404 });
  }
  const sealed = encryptSecret(parsed.data.password, ctx.orgId);
  try {
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(browserCredentials)
        .values({
          orgId: ctx.orgId,
          customerId: parsed.data.customerId,
          siteOrigin,
          username: parsed.data.username,
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          secretHint: sealed.hint,
          addedBy: email,
        })
        .onConflictDoUpdate({
          target: [browserCredentials.orgId, browserCredentials.customerId, browserCredentials.siteOrigin],
          set: {
            username: parsed.data.username,
            secretCiphertext: sealed.ciphertext,
            secretIv: sealed.iv,
            secretTag: sealed.tag,
            secretHint: sealed.hint,
            addedBy: email,
            updatedAt: new Date(),
          },
        }),
    );
    return NextResponse.json({ item: { customerId: parsed.data.customerId, siteOrigin, username: parsed.data.username } }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await caller(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const siteOrigin = url.searchParams.get("siteOrigin");
  if (!customerId || !siteOrigin) return NextResponse.json({ error: "customerId + siteOrigin required" }, { status: 400 });
  try {
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(browserCredentials)
        .where(
          and(
            eq(browserCredentials.orgId, ctx.orgId),
            eq(browserCredentials.customerId, customerId),
            eq(browserCredentials.siteOrigin, normHost(siteOrigin)),
          ),
        ),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
