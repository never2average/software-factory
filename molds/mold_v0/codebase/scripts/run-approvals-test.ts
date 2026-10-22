// Approval-gated writes (mold_v0-079; src/run-approvals.ts, src/runs.ts startRun and claimRun), offline: an embedded
// database, the HTTP API behind a fake Clerk, admin tokens, the generated MCP tools.
//   npm run test:run-approvals
//
//  1. Declarations: the preview is a kind of the same pack, not gated itself, not the kind itself; no schedule starts a
//     gated kind.
//  2. The gate: a write without an approval, or with a made-up one, does not start. A preview's approval is given for
//     the sha256 of its output as it was shown (another sha256 is refused), by the declared approver only (the
//     workspace's owner signed in: not a member, not the platform's operator; or the operator: not the owner, not an
//     admin viewer), only once per preview and write kind, only for a preview that succeeded.
//  3. Use: the write starts with it, once (a second start with it is refused: no replay), only in its own workspace
//     (another workspace with it: refused), only with the preview's scope and targets (another scope: refused, and the
//     approval stays unused), only before it expires; and only while the preview's output is the approved one (an
//     output changed afterwards: refused). The write then runs and writes.
//  4. The workspace changed between the approval and the write (another run committed): the write fails when it is
//     claimed, not retried.
//  5. The generated start tool takes the approval (the MCP door): refused without one, starts with one.
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const FIX = path.join(ROOT, "scripts", "fixtures", "run-approvals");

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const runs = await import("../src/runs.js");
  const store = await import("../src/workspace-store.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const A = (await createOrg(`Approve A ${STAMP}`)).org, B = (await createOrg(`Approve B ${STAMP}`)).org;

  // ---------- 1. declarations ----------
  {
    const k = (name: string, x: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry: "x.mjs", ...x });
    const pack = (kinds: unknown[], extra: Record<string, unknown> = {}) => definePack({ id: "pk", jobKinds: kinds as never, ...extra });
    assert.doesNotThrow(() => pack([k("pv"), k("wr", { workspace: true, approval: { preview: "pv" } })]));
    assert.throws(() => pack([k("wr", { approval: { preview: "nope" } })]), /its preview nope is not a kind of this pack/);
    assert.throws(() => pack([k("wr", { approval: { preview: "wr" } })]), /not its own preview/);
    assert.throws(() => pack([k("pv", { approval: { preview: "wr" } }), k("wr", { approval: { preview: "pv" } })]), /waits for an approval itself/);
    assert.throws(() => pack([k("pv"), k("wr", { approval: { preview: "pv", by: "anyone" } })]), /approval/);
    assert.throws(() => pack([k("pv"), k("wr", { approval: { preview: "pv", expires_minutes: 1 } })]), /approval/);
    assert.throws(() => pack([k("pv"), k("wr", { approval: { preview: "pv" } })], { schedules: [{ name: "nightly", label: "Nightly", job_kind: "wr", cron: "0 3 * * *" }] }), /a schedule cannot start it/);
    console.log("✓ declarations: the preview is another, ungated kind of the pack; a schedule never starts a gated kind");
  }

  // ---------- the fixture pack ----------
  const kind = (name: string, entry: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry, lease_seconds: 15, max_attempts: 1, ...extra });
  const fixture = definePack({
    id: "fixture_approve",
    recordAreas: [{ name: "approve_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] }],
    jobKinds: [
      kind("add_preview", "preview.mjs"),
      kind("add", "write.mjs", { workspace: true, approval: { preview: "add_preview" } }),
      kind("add_op", "write.mjs", { workspace: true, approval: { preview: "add_preview", by: "operator", expires_minutes: 60 } }),
      kind("touch", "touch.mjs", { workspace: true }),
    ] as never,
  });
  setPacksForTest([{ manifest: { id: "fixture_approve", name: "Fixture approve", version: "1", entry: "index.ts", migrations: null, words: {}, dir: FIX }, definition: fixture }]);
  await rec.putPlatform(null, "approve_checks", "c1", { title: "A check", data: { summary: "x" } });
  const http = await startHttp();
  const client = await harness.localRunnerClient("w-approve");
  const iso = process.getuid?.() === 0 ? {} : { allowSameUser: true };
  const carry = async (id: string, k: string) => {
    const c = await client.claim([`fixture_approve/${k}`]);
    if (!c) return (await runs.getRun((await db.query<{ org_id: number }>("SELECT org_id FROM runs WHERE id = $1", [id]))[0]!.org_id, id))!;
    assert.equal(c.run.id, id);
    return (await harness.runWorkspaceHarness(client, c, { egress: "off", packDir: () => FIX, ...iso }))!;
  };
  const preview = async (orgId: number, catalog: string) => {
    const r = await runs.startRun(orgId, "fixture_approve", "add_preview", { scope: { catalog } });
    assert.equal((await carry(r.id, "add_preview")).status, "succeeded");
    return r.id;
  };
  const tokA = { owner: await http.signIn(A, "owner"), member: await http.signIn(A) }, ownerB = await http.signIn(B, "owner");
  const call = async (method: string, p: string, tok: string, body?: unknown) => { const r = await http.req(method, p, { authorization: `Bearer ${tok}` }, body); const t = await r.text(); return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t; } })() }; };
  const shown = async (id: string, tok = tokA.owner) => { const v = await call("GET", `/api/runs/${id}/approval`, tok); assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body; };
  const approve = (id: string, kind: string, sha256: string, tok = tokA.owner) => call("POST", `/api/runs/${id}/approve`, tok, { kind, sha256 });
  const filesOf = async (o: number) => { const s = await store.latestSnapshot(db, o, "fixture_approve"); return s ? Object.keys(s.manifest).sort() : []; };
  const start = (orgId: number, kind: string, input: Record<string, unknown>) => runs.startRun(orgId, "fixture_approve", kind, input as never);

  try {
    // ---------- 2. the gate ----------
    let approvalId = "", p1 = "";
    {
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "acme" } }), /writes only after its preview is approved/);
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "acme" }, approval: "apr_" + "x".repeat(24) }), /cannot start this run/);
      await assert.rejects(start(A.orgId, "touch", { approval: "apr_" + "x".repeat(24) }), /does not wait for an approval/);
      p1 = await preview(A.orgId, "acme");
      const v = await shown(p1);
      assert.match(v.sha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(v.approve_for.map((x: { kind: string; by: string }) => `${x.kind}:${x.by}`).sort(), ["add:owner", "add_op:operator"], "what it may be approved for, and by whom");
      assert.equal(v.output.results[0].detail.would_add, "acme", "the approver is shown the preview's output");
      assert.equal((await approve(p1, "add", "0".repeat(64))).status, 409, "another sha256 than the output's: refused");
      assert.equal((await approve(p1, "add", v.sha256, tokA.member)).status, 403, "a member does not approve");
      assert.equal((await approve(p1, "add", v.sha256, ownerB)).status, 404, "another workspace's owner does not see the run");
      assert.equal((await approve(p1, "add_op", v.sha256)).status, 403, "a kind the operator approves: not the owner");
      const op = await http.adminToken("operator"), viewer = await http.adminToken("viewer");
      assert.equal((await call("POST", `/api/admin/runs/${p1}/approve`, op, { kind: "add", sha256: v.sha256 })).status, 403, "a kind the owner approves: not the operator");
      assert.equal((await call("POST", `/api/admin/runs/${p1}/approve`, viewer, { kind: "add_op", sha256: v.sha256 })).status, 403, "an admin viewer does not approve");
      const ok = await approve(p1, "add", v.sha256);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      approvalId = ok.body.approval.id;
      assert.match(approvalId, /^apr_/);
      assert.equal((await approve(p1, "add", v.sha256)).status, 409, "a preview is approved once per write kind");
      const failed = await runs.startRun(A.orgId, "fixture_approve", "add_preview", { scope: { catalog: "acme" } });
      await db.query("UPDATE runs SET status = 'failed', ended_at = now() WHERE id = $1", [failed.id]);
      assert.equal((await approve(failed.id, "add", (await shown(failed.id)).sha256)).status, 409, "a preview that did not succeed: nothing to approve");
      const opOk = await call("POST", `/api/admin/runs/${p1}/approve`, op, { kind: "add_op", sha256: v.sha256 });
      assert.equal(opOk.status, 201, JSON.stringify(opOk.body));
      assert.equal(opOk.body.approval.approver_role, "operator");
      console.log("✓ the gate: no write without an approval; approved for the sha256 of what was shown, by the declared approver only (owner signed in, or operator), once, for a preview that succeeded");
    }

    // ---------- 3. use ----------
    {
      await assert.rejects(start(B.orgId, "add", { scope: { catalog: "acme" }, approval: approvalId }), /cannot start this run/, "never in another workspace");
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "evil" }, approval: approvalId }), /scope and targets must be the approved preview's/);
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "acme" }, targets: { asset: "x" }, approval: approvalId }), /scope and targets must be the approved preview's/);
      assert.equal((await db.query<{ used_at: Date | null }>("SELECT used_at FROM run_approvals WHERE id = $1", [approvalId]))[0]!.used_at, null, "a refused start leaves the approval unused");
      await assert.rejects(start(A.orgId, "add_op", { scope: { catalog: "acme" }, approval: approvalId }), /cannot start this run/, "only for the kind it was given for");
      const w = await start(A.orgId, "add", { scope: { catalog: "acme" }, approval: approvalId });
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "acme" }, approval: approvalId }), /cannot start this run/, "used once: no replay");
      { const wv = await carry(w.id, "add"); assert.equal(wv.status, "succeeded", JSON.stringify(wv)); }
      assert.deepEqual(await filesOf(A.orgId), ["catalogs/acme.json"], "the write wrote what the preview showed");
      const used = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'approval_used'", [w.id]))[0]!.data;
      assert.equal(used.approval, approvalId); assert.equal(used.preview_run_id, p1);
      // Expired.
      const p2 = await preview(A.orgId, "beta");
      const a2 = (await approve(p2, "add", (await shown(p2)).sha256)).body.approval.id;
      await db.query("UPDATE run_approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [a2]);
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "beta" }, approval: a2 }), /cannot start this run/, "an expired approval");
      // The preview's output changed after its approval (a result added to it): refused.
      const p3 = await preview(A.orgId, "gamma");
      const a3 = (await approve(p3, "add", (await shown(p3)).sha256)).body.approval.id;
      await db.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status, finding_fingerprint) VALUES ($1, $2, 'approve_checks', 'c1', 'fail', 'extra')", [p3, A.orgId]);
      await assert.rejects(start(A.orgId, "add", { scope: { catalog: "gamma" }, approval: a3 }), /output has changed since it was approved/);
      console.log("✓ use: once (no replay), its own workspace and kind only, the preview's scope and targets only (a refusal leaves it unused), before it expires, while the preview's output is the approved one; the write writes");
    }

    // ---------- 4. the workspace changed between the approval and the write ----------
    {
      const p4 = await preview(A.orgId, "delta");
      const a4 = (await approve(p4, "add", (await shown(p4)).sha256)).body.approval.id;
      const t = await start(A.orgId, "touch", {});
      assert.equal((await carry(t.id, "touch")).status, "succeeded");
      const w = await start(A.orgId, "add", { scope: { catalog: "delta" }, approval: a4 });
      const v = await carry(w.id, "add");
      assert.equal(v.status, "failed"); assert.equal(v.error_kind, "run");
      assert.match(v.error ?? "", /the workspace changed after its preview was approved/);
      assert.ok(!(await filesOf(A.orgId)).includes("catalogs/delta.json"), "nothing written");
      console.log("✓ the workspace changed after the approval: the write fails when claimed (not retried), nothing written");
    }

    // ---------- 5. the MCP door ----------
    {
      const ca = await connect(A);
      const tools = (await ca.client.listTools()).tools;
      const st = tools.find((x) => x.name === "fixture_approve_start_add")!;
      assert.ok(st, tools.map((x) => x.name).join(","));
      assert.ok(Object.keys((st.inputSchema as { properties?: object }).properties ?? {}).includes("approval"), "the gated kind's start tool takes the approval");
      const plain = tools.find((x) => x.name === "fixture_approve_start_touch")!;
      assert.ok(!Object.keys((plain.inputSchema as { properties?: object }).properties ?? {}).includes("approval"), "another kind's does not");
      // (The fixture's area is named approve_checks: a tool's verb is what would approve, never an area's name.)
      assert.ok(!tools.some((x) => /^(approve|grant|confirm)/.test(x.name.replace(/^fixture_approve_|^/, ""))), `no tool approves: only a person signed in, or the operator, does (${tools.map((x) => x.name).join(", ")})`);
      const no = await ca.call("fixture_approve_start_add", {});
      assert.ok(no.isError && /approval/.test(no.content[0]!.text), `the approval is a required argument: ${JSON.stringify(no)}`);
      const p5 = await preview(A.orgId, "eps");
      const a5 = (await approve(p5, "add", (await shown(p5)).sha256)).body.approval.id;
      // The kind declares no arguments, so the tool's scope is empty: the preview's must be too for the write to match.
      const p6r = await runs.startRun(A.orgId, "fixture_approve", "add_preview", {});
      assert.equal((await carry(p6r.id, "add_preview")).status, "succeeded");
      const a6 = (await approve(p6r.id, "add", (await shown(p6r.id)).sha256)).body.approval.id;
      const mismatch = await ca.call("fixture_approve_start_add", { approval: a5 });
      assert.ok(mismatch.isError && /scope and targets/.test(mismatch.content[0]!.text), "the tool's run has the preview's scope or none");
      const yes = await ca.call("fixture_approve_start_add", { approval: a6 });
      assert.ok(!yes.isError, JSON.stringify(yes));
      await ca.close();
      console.log("✓ the MCP door: the gated kind's start tool requires the approval (refused without one) and starts with the preview's; no tool approves");
    }
  } finally { await http.close(); }
  await db.close();
  console.log("RUN APPROVALS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
