import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/ops-errors";
import { del, head, put } from "@vercel/blob";
import { sql } from "drizzle-orm";
import { getOpsDb } from "@/lib/ops-db";
import { normalizeAgentUrl } from "@/lib/agent-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A live health probe for the three things everything else stands on: the
 * database, the blob store, and inference. Each is exercised for real, not
 * merely reported as "configured":
 *
 *   - db:        a round-trip `SELECT 1` through the ops Drizzle client.
 *   - blob:      a probe object is written, read back, and deleted — a true
 *                write/read/delete against the SAME private store the data room
 *                uses. Nothing is left behind.
 *   - inference: the agent's own `/eve/v1/health` is fetched (it reports whether
 *                the model runtime is ready). We do not spend a real turn — that
 *                would need the caller's credentials and cost tokens.
 *
 * Public and side-effect-free (the blob probe cleans up after itself), so it can
 * back an uptime check.
 */
interface Check {
  ok: boolean;
  detail: string;
  ms: number;
}

async function timed(fn: () => Promise<string>): Promise<Check> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, detail: errorMessage(e), ms: Date.now() - start };
  }
}

/**
 * Whether an invite can actually reach a human.
 *
 * Presence only — no send. Delivery is genuinely observable at send time now
 * (sendOrgInvite reports per recipient), and a probe email on every health poll
 * would be both costly and rude. What is worth surfacing here is the standing
 * configuration fact that used to be invisible: for months this deployment had
 * no channel at all, and the wizard cheerfully reported "Setup emails sent".
 */
function checkMail(): { configured: boolean; via: string | null; detail: string } {
  if (process.env.RESEND_API_KEY && process.env.PLATFORM_NOTIFY_FROM) {
    const from = process.env.PLATFORM_NOTIFY_FROM;
    return { configured: true, via: "email", detail: `Resend, from ${from}` };
  }
  if (process.env.RESEND_API_KEY) {
    return {
      configured: false,
      via: null,
      detail: "RESEND_API_KEY is set but PLATFORM_NOTIFY_FROM is not — invites fall back to links",
    };
  }
  if (process.env.SLACK_BOT_TOKEN) {
    return { configured: true, via: "slack", detail: "Slack DM via the org bot" };
  }
  return { configured: false, via: null, detail: "No channel — invites fall back to copyable links" };
}

async function checkDb(): Promise<Check> {
  return timed(async () => {
    const db = getOpsDb();
    if (!db) throw new Error("no DATABASE_URL — the DB is not configured");
    // WHICH ROLE we connect as, not just whether we can connect.
    //
    // Row-level security is ignored entirely by a role with the BYPASSRLS
    // attribute, so connecting as the wrong role silently downgrades every
    // tenant policy to nothing while the app keeps working perfectly. That
    // failure is invisible by construction, which is why it belongs in a
    // health check: "can it reach the database" was never the interesting
    // question. (The POSTGRES_URL fallback that could reroute us to another
    // provider's database entirely is gone — see lib/ops-db.ts.)
    const rows = await db.execute<{ role: string; bypassrls: boolean }>(
      sql`select current_user as role,
                 (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`,
    );
    const row = (rows as unknown as { role: string; bypassrls: boolean }[])[0];
    const role = row?.role ?? "unknown";
    // Reported, not thrown. This is a standing configuration fact, not an
    // outage — turning the health endpoint red for it would cry wolf on a
    // signal that is supposed to mean "the platform is down". It is stated
    // plainly enough that nobody can mistake it for fine.
    return row?.bypassrls
      ? `SELECT 1 ok · role ${role} — WARNING: BYPASSRLS, row-level security is NOT enforced (point DATABASE_URL at app_rw)`
      : `SELECT 1 ok · role ${role} (RLS enforced)`;
  });
}

async function checkBlob(): Promise<Check> {
  return timed(async () => {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error("no BLOB_READ_WRITE_TOKEN — the blob store is not configured");
    // The data-room store is PRIVATE (private blobs are not publicly fetchable),
    // so the round-trip is write → head → delete: head() confirms the object
    // actually landed with the right size, without needing a presigned read.
    const key = `_health/probe-${Date.now()}.txt`;
    const body = `health ${new Date().toISOString()}`;
    const { url } = await put(key, body, {
      access: "private",
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    try {
      const meta = await head(url, { token });
      if (!meta) throw new Error("probe written but head() returned nothing");
      if (meta.size !== Buffer.byteLength(body)) {
        throw new Error(`probe size mismatch: wrote ${Buffer.byteLength(body)}, head says ${meta.size}`);
      }
      return "write → head → delete ok";
    } finally {
      await del(url, { token }).catch(() => {});
    }
  });
}

async function checkInference(): Promise<Check> {
  return timed(async () => {
    // normalizeAgentUrl, not a truthiness test: "[SENSITIVE]" and a malformed
    // value are both non-empty, so `!base` waved them through and the probe
    // then failed with a network error about a nonsense host rather than
    // saying the variable is not usable.
    const base = normalizeAgentUrl(process.env.EVE_API_URL) ?? normalizeAgentUrl(process.env.NEXT_PUBLIC_EVE_API_URL);
    if (!base) throw new Error("EVE_API_URL / NEXT_PUBLIC_EVE_API_URL is unset or unusable — cannot reach the agent");
    const res = await fetch(`${base}/eve/v1/health`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`agent health returned ${res.status}`);
    const body = (await res.json()) as { status?: string; ok?: boolean };
    if (!body.ok && body.status !== "ready") throw new Error(`agent not ready: ${JSON.stringify(body)}`);
    return `agent ${body.status ?? "ok"}`;
  });
}

async function checkTaskWorkflow(): Promise<Check> {
  return timed(async () => {
    const base = process.env.TASK_WORKFLOW_SERVICE_URL;
    if (!base) throw new Error("no TASK_WORKFLOW_SERVICE_URL — task workflow service is not configured");
    const res = await fetch(`${base.replace(/\/$/, "")}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`task workflow health returned ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; service?: string };
    if (!body.ok) throw new Error("task workflow service reported unhealthy");
    return `${body.service ?? "task-workflow"} ready`;
  });
}

export async function GET() {
  const [db, blob, inference, taskWorkflow] = await Promise.all([
    checkDb(),
    checkBlob(),
    checkInference(),
    checkTaskWorkflow(),
  ]);
  const mail = checkMail();
  // `ok` stays the three load-bearing subsystems. A missing mail channel does
  // not make the platform unhealthy — invites fall back to copyable links — so
  // it is reported, not alarmed on.
  const ok = db.ok && blob.ok && inference.ok && taskWorkflow.ok;
  return NextResponse.json({ ok, checkedAt: new Date().toISOString(), db, blob, inference, taskWorkflow, mail }, {
    status: ok ? 200 : 503,
  });
}
