/**
 * Approval-gated writes (mold_v0-079): a job kind that writes (`approval: {preview, by, expires_minutes}`) starts only
 * after someone said yes to the output of a run of its preview kind (a dry run of the same pack). Table:
 * sql/migrations/0016_run_approvals_egress.sql (run_approvals; no tenant access).
 *
 *   digest    previewDigest(): the sha256 of the preview's output as it is shown to the approver: the run (its id, kind,
 *             scope, targets), its results (every field, in order) and the files it recorded (agent_output and
 *             agent_file events: path, size, sha256). What the approver saw is what they approve: approve() takes the
 *             sha256 they were shown and refuses another, so a yes can never be given to an output nobody looked at.
 *   approve   by the workspace's owner, signed in (src/view-routes.ts /api/runs/:id/approve), or the platform's operator
 *             (src/http.ts /api/admin/runs/:id/approve), as the write kind declares (`by`): never the other, never an
 *             API or member key (an agent holding one cannot say yes for a person). Only a preview that succeeded, of
 *             the declared preview kind, of the same pack and workspace, not older than the approval's own life; once
 *             per preview and write kind. The approval keeps the preview's scope and targets and the workspace's
 *             version now, and expires after `expires_minutes`.
 *   use       src/runs.ts startRun: the write run names the approval (apr_…); in the transaction that queues it, the
 *             approval is taken (unused, unexpired, this workspace's, this pack's and this kind's: used once), the
 *             preview's digest is computed again and must still be the approved one, and the run's scope and targets
 *             must be the preview's. src/runs.ts claimRun: when the write is claimed, the workspace must still be at the
 *             approved version (another run changed it since: the write fails, not retried).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** JSON with object keys sorted, so the same value always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{16,40}$/;
type KindLike = { name: string; workspace?: boolean; approval?: { preview: string; by: "owner" | "operator"; expires_minutes: number } };

interface PreviewRow { id: string; org_id: number; pack: string; kind: string; status: string; scope: Record<string, unknown>; targets: Record<string, unknown>; ended_at: Date | null }

/** The output of a preview run that an approval is bound to, and its sha256. Null when the run is not the workspace's. */
export async function previewDigest(q: Queryable, orgId: number, runId: string): Promise<{ run: PreviewRow; sha256: string; output: Record<string, unknown> } | null> {
  const [run] = await q.query<PreviewRow>("SELECT id, org_id, pack, kind, status, scope, targets, ended_at FROM runs WHERE org_id = $1 AND id = $2", [orgId, runId]);
  if (!run) return null;
  const results = await q.query("SELECT check_area, check_key, asset_area, asset_key, source_area, source_key, status, finding_fingerprint, evidence_ref, detail FROM run_results WHERE org_id = $1 AND run_id = $2 ORDER BY id", [orgId, runId]);
  const files = (await q.query<{ type: string; data: Record<string, unknown> }>(
    "SELECT type, data FROM run_events WHERE org_id = $1 AND run_id = $2 AND type IN ('agent_output', 'agent_file') ORDER BY id", [orgId, runId]))
    .map((e) => ({ type: e.type, path: e.data?.path ?? null, size: e.data?.size ?? null, sha256: e.data?.sha256 ?? null }));
  const output = { run: { id: run.id, pack: run.pack, kind: run.kind, scope: run.scope ?? {}, targets: run.targets ?? {} }, results, files };
  return { run, sha256: sha256(canonical(output)), output };
}

export interface ApprovalView { id: string; preview_run_id: string; write_kind: string; output_sha256: string; approved_by: string; approver_role: string; expires_at: string; used_by_run_id: string | null }

/**
 * Say yes to preview run `runId` of workspace `orgId` for `writeKind`, as `role` (the workspace's owner or the
 * platform's operator). `sha256` is the digest the approver was shown: another is refused.
 */
export async function approvePreview(orgId: number, runId: string, input: { kind?: unknown; sha256?: unknown }, who: { role: "owner" | "operator"; by: string }): Promise<ApprovalView> {
  const { findKind } = await import("./runs.js");
  const { latestSnapshot } = await import("./workspace-store.js");
  if (typeof input?.kind !== "string") throw new PackError("kind: the write kind this preview is approved for", 400);
  if (typeof input?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) throw new PackError("sha256: the digest of the preview's output you were shown", 400);
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const d = await previewDigest(tx, orgId, String(runId));
    if (!d) throw new PackError("no such run in this workspace", 404);
    const k = findKind(d.run.pack, input.kind as string) as KindLike | null;
    if (!k?.approval) throw new PackError(`${String(input.kind).slice(0, 64)} is not a kind of this run's pack that waits for an approval`, 404);
    if (k.approval.preview !== d.run.kind) throw new PackError(`${k.name} is approved from a run of ${k.approval.preview}, not ${d.run.kind}`, 400);
    if (k.approval.by !== who.role) throw new PackError(`${k.name} is approved by the ${k.approval.by === "owner" ? "workspace's owner" : "platform's operator"} only`, 403);
    if (d.run.status !== "succeeded") throw new PackError(`the preview ${d.run.status === "queued" || d.run.status === "running" ? "has not finished" : "did not succeed"}: nothing to approve`, 409);
    const ended = d.run.ended_at ? new Date(d.run.ended_at).getTime() : 0;
    if (Date.now() - ended > k.approval.expires_minutes * 60_000) throw new PackError("the preview is too old to approve: run it again", 409);
    if (input.sha256 !== d.sha256) throw new PackError("the preview's output is not the one you were shown (its sha256 differs): look at it again", 409);
    const version = k.workspace === false ? null : ((await latestSnapshot(tx, orgId, d.run.pack))?.version ?? 0);
    const id = `apr_${randomBytes(18).toString("base64url")}`;
    const [r] = await tx.query<ApprovalView & { expires_at: Date }>(
      `INSERT INTO run_approvals (id, org_id, pack, preview_run_id, write_kind, output_sha256, scope, targets, workspace_version, approved_by, approver_role, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12))
       ON CONFLICT (preview_run_id, write_kind) DO NOTHING
       RETURNING id, preview_run_id, write_kind, output_sha256, approved_by, approver_role, expires_at, used_by_run_id`,
      [id, orgId, d.run.pack, d.run.id, k.name, d.sha256, JSON.stringify(d.run.scope ?? {}), JSON.stringify(d.run.targets ?? {}), version, who.by.slice(0, 200), who.role, k.approval.expires_minutes]);
    if (!r) throw new PackError("this preview is already approved for that kind (a preview is written at most once): run the preview again", 409);
    await tx.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 0, 'approved', $3)",
      [d.run.id, orgId, JSON.stringify({ approval: r.id, write_kind: k.name, sha256: d.sha256, by: who.by.slice(0, 200), role: who.role, expires_at: new Date(r.expires_at).toISOString() })]);
    return { ...r, expires_at: new Date(r.expires_at).toISOString() };
  }));
}

/** What an approver is shown of a preview run: its output, its sha256, and the kinds it may be approved for (and by whom). */
export async function approvalView(orgId: number, runId: string) {
  const { jobKinds } = await import("./runs.js");
  return asPlatform(async () => {
    const db = await getDb();
    const d = await previewDigest(db, orgId, String(runId));
    if (!d) throw new PackError("no such run in this workspace", 404);
    const kinds = (jobKinds() as (KindLike & { pack: string })[]).filter((k) => k.pack === d.run.pack && k.approval?.preview === d.run.kind)
      .map((k) => ({ kind: k.name, by: k.approval!.by, expires_minutes: k.approval!.expires_minutes }));
    const given = await db.query("SELECT id, write_kind, approved_by, approver_role, expires_at, used_by_run_id FROM run_approvals WHERE org_id = $1 AND preview_run_id = $2 ORDER BY created_at", [orgId, d.run.id]);
    return { run: { id: d.run.id, kind: d.run.kind, status: d.run.status }, sha256: d.sha256, output: d.output, approve_for: kinds, approvals: given };
  });
}

/**
 * Take approval `id` for a new write run (src/runs.ts startRun, inside the transaction that queues it): unused,
 * unexpired, of this workspace, pack and kind; the run's scope and targets the preview's; the preview's output still
 * the approved one. Throws a PackError (and the transaction, so the approval stays unused) otherwise.
 */
export async function takeApproval(tx: Queryable, a: { id: unknown; orgId: number; pack: string; kind: string; runId: string; scope: Record<string, unknown>; targets: Record<string, unknown> }) {
  if (typeof a.id !== "string" || !APPROVAL_ID.test(a.id)) throw new PackError(`${a.kind} writes only after its preview is approved: give the approval (apr_…) of the preview run to write`, 403);
  const [r] = await tx.query<{ id: string; preview_run_id: string; output_sha256: string; scope: Record<string, unknown>; targets: Record<string, unknown>; approver_role: string; approved_by: string }>(
    `UPDATE run_approvals SET used_by_run_id = $5, used_at = now()
      WHERE id = $1 AND org_id = $2 AND pack = $3 AND write_kind = $4 AND used_at IS NULL AND expires_at > now()
      RETURNING id, preview_run_id, output_sha256, scope, targets, approver_role, approved_by`, [a.id, a.orgId, a.pack, a.kind, a.runId]);
  if (!r) throw new PackError("that approval cannot start this run: it is used, expired, or not this workspace's approval for this kind", 403);
  if (canonical(r.scope ?? {}) !== canonical(a.scope) || canonical(r.targets ?? {}) !== canonical(a.targets))
    throw new PackError("the run's scope and targets must be the approved preview's", 403);
  const d = await previewDigest(tx, a.orgId, r.preview_run_id);
  if (!d || d.sha256 !== r.output_sha256) throw new PackError("the approved preview's output has changed since it was approved", 409);
  return r;
}

/**
 * What a claimed write run is given (src/runs.ts claimRun): the approval and the preview's output that was approved,
 * so the write can apply exactly that (the harness writes it to a file named by RUN_APPROVED_PREVIEW).
 */
export async function approvedPreview(q: Queryable, run: { org_id: number; approval_id?: string | null }) {
  if (!run.approval_id) return null;
  const [a] = await q.query<{ id: string; preview_run_id: string; output_sha256: string; approved_by: string; approver_role: string }>(
    "SELECT id, preview_run_id, output_sha256, approved_by, approver_role FROM run_approvals WHERE id = $1 AND org_id = $2", [run.approval_id, run.org_id]);
  if (!a) return null;
  const d = await previewDigest(q, run.org_id, a.preview_run_id);
  return { id: a.id, preview_run_id: a.preview_run_id, sha256: a.output_sha256, approved_by: a.approved_by, role: a.approver_role, output: d?.output ?? null };
}

/** When a write run is claimed: its workspace must still be at the version its preview was approved at. Null: fine. */
export async function approvalStale(tx: Queryable, run: { id: string; org_id: number; pack: string; approval_id?: string | null }): Promise<string | null> {
  if (!run.approval_id) return null;
  const { latestSnapshot } = await import("./workspace-store.js");
  const [a] = await tx.query<{ workspace_version: number | null; live: boolean }>(
    "SELECT workspace_version, expires_at > now() AS live FROM run_approvals WHERE id = $1 AND org_id = $2 AND used_by_run_id = $3", [run.approval_id, run.org_id, run.id]);
  if (!a) return "the run's approval is not there";
  // Expired while the write waited in the queue: it does not run on an old yes.
  if (!a.live) return "the run's approval expired before it could run: approve its preview again";
  if (a.workspace_version === null) return null;
  const now = (await latestSnapshot(tx, run.org_id, run.pack))?.version ?? 0;
  return now === a.workspace_version ? null : `the workspace changed after its preview was approved (version ${a.workspace_version}, now ${now}): run the preview again`;
}
