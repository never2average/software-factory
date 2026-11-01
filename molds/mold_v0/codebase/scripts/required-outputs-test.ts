// A job kind's required outputs (mold_v0-188; src/required-outputs.ts), offline: no database, no run.
//   npm run test:required-outputs
//
//  1. The status mapping: a run that would succeed and wrote its required output succeeds; one that wrote other files
//     but not it fails "output_missing", naming it; one that failed keeps its own failure; a quiet run (nothing changed)
//     succeeds under "workspace_changed" and fails under "always".
//  2. What counts as written: a file added or changed between the restored snapshot and the staged write-back; the same
//     bytes, a removal or a file that matches no pattern do not; links are not followed.
//  3. Patterns: "{name}" is the run's argument, taken literally (a value never widens the glob); "*" one segment.
//  4. The kind's configuration: a required output outside the write-back, with an undeclared placeholder or listed
//     twice is refused; the defaults are none and "always".
//  5. Maxwell's run_S59pF-Rit5xA3fsh as it happened: one ledger line appended, the report left as it was: it fails.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentWorkspaceSchema } from "../src/agent-workspace-config.js";
import { fillPattern, missingOutputs, OUTPUT_MISSING, withRequiredOutputs, writtenOutputs } from "../src/required-outputs.js";

const TMP = mkdtempSync(path.join(tmpdir(), "required-outputs-"));
const tree = (name: string, files: Record<string, string>) => {
  const root = path.join(TMP, name);
  for (const [rel, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), body); }
  mkdirSync(root, { recursive: true });
  return root;
};
const REPORT = "company-profile/company/summary.md";
const ok = { outcome: "succeeded" as const, results: [{ x: 1 }] };

try {
  // ---------- 1. the status mapping ----------
  {
    const req = { required: [REPORT], workspaceUnchanged: false };
    // Output changed: succeeds, exactly as it was (results and all).
    assert.equal(withRequiredOutputs(ok, { ...req, written: [REPORT, "company-profile/company/soc/main.jsonl"] }), ok);
    // Output unchanged, something else written: fails output_missing, naming it.
    const miss = withRequiredOutputs(ok, { ...req, written: ["company-profile/company/soc/main.jsonl"] });
    assert.equal(miss.outcome, "failed");
    assert.equal((miss as { error_kind: string }).error_kind, OUTPUT_MISSING);
    assert.match((miss as { error: string }).error, /did not write its required output \(company-profile\/company\/summary\.md\)/);
    assert.ok(!("results" in miss), "a failed run's results are not taken");
    // Run failed: keeps its own failure, whatever it wrote.
    for (const kind of ["run", "validation", "timeout", "infrastructure"]) {
      const failed = { outcome: "failed" as const, error_kind: kind, error: "x" };
      assert.equal(withRequiredOutputs(failed, { ...req, written: [] }), failed, `a ${kind} failure stays one`);
    }
    // Nothing changed at all: "workspace_changed" lets a quiet exit succeed; "always" (the default) does not.
    assert.equal(withRequiredOutputs(ok, { required: [REPORT], when: "workspace_changed", workspaceUnchanged: true, written: [] }), ok);
    assert.equal(withRequiredOutputs(ok, { required: [REPORT], workspaceUnchanged: true, written: [] }).outcome, "failed");
    assert.equal(withRequiredOutputs(ok, { required: [REPORT], when: "workspace_changed", workspaceUnchanged: false, written: ["a/b"] }).outcome, "failed");
    // No required output: nothing changes.
    assert.equal(withRequiredOutputs(ok, { required: [], workspaceUnchanged: true, written: [] }), ok);
    // Two required, one written: the other is named, and only it.
    const two = withRequiredOutputs(ok, { required: [REPORT, "applications/*/summary.md"], workspaceUnchanged: false, written: [REPORT] });
    assert.match((two as { error: string }).error, /\(applications\/\*\/summary\.md\)/);
    assert.deepEqual(missingOutputs({ required: [REPORT, "applications/*/summary.md"], workspaceUnchanged: false, written: ["applications/web/summary.md"] }), [REPORT]);
    console.log("✓ status: output written -> succeeded as it was; not written -> failed output_missing, naming it; a failed run keeps its failure; a quiet run passes only under workspace_changed");
  }

  // ---------- 2. what counts as written ----------
  {
    const before = tree("before", { [REPORT]: "v3\n", "company-profile/company/soc/main.jsonl": "a\n", "company-profile/company/gone.md": "x" });
    const same = tree("same", { [REPORT]: "v3\n", "company-profile/company/soc/main.jsonl": "a\nb\n" });
    assert.deepEqual(writtenOutputs(before, same, [REPORT]), [], "the same bytes are not written");
    assert.deepEqual(writtenOutputs(before, same, ["company-profile/company/**"]), ["company-profile/company/soc/main.jsonl"], "a removal is not a write; a change is");
    const changed = tree("changed", { [REPORT]: "v4\n" });
    assert.deepEqual(writtenOutputs(before, changed, [REPORT]), [REPORT]);
    const added = tree("added", { [REPORT]: "new\n" });
    assert.deepEqual(writtenOutputs(null, added, [REPORT]), [REPORT], "the first run: no snapshot, the file is new");
    assert.deepEqual(writtenOutputs(path.join(TMP, "none"), added, [REPORT]), [REPORT], "a snapshot directory that is not there reads as empty");
    const linked = tree("linked", {});
    mkdirSync(path.join(linked, "company-profile/company"), { recursive: true });
    symlinkSync("/etc/hostname", path.join(linked, REPORT));
    assert.deepEqual(writtenOutputs(before, linked, [REPORT]), [], "a link is never an output");
    assert.deepEqual(writtenOutputs(before, changed, []), [], "no pattern, nothing read");
    console.log("✓ written: added or changed bytes only (not the same bytes, a removal or a link); no snapshot reads as empty");
  }

  // ---------- 3. patterns ----------
  {
    assert.equal(fillPattern("company-profile/{company}/summary.md", { company: "acme" }), "company-profile/acme/summary.md");
    assert.equal(fillPattern("data/{x}/r.md", { x: "a*b/c?" }), "data/a_b_c_/r.md", "a value is taken literally");
    assert.throws(() => fillPattern("data/{nope}/r.md", {}), /has no value/);
    assert.deepEqual(missingOutputs({ required: ["company-profile/{company}/summary.md"], values: { company: "acme" }, workspaceUnchanged: false, written: ["company-profile/acme/summary.md"] }), []);
    assert.deepEqual(missingOutputs({ required: ["company-profile/{company}/summary.md"], values: { company: "acme" }, workspaceUnchanged: false, written: ["company-profile/other/summary.md"] }), ["company-profile/acme/summary.md"]);
    assert.deepEqual(missingOutputs({ required: ["company-profile/*/summary.md"], workspaceUnchanged: false, written: ["company-profile/a/b/summary.md"] }), ["company-profile/*/summary.md"], "* is one segment");
    console.log("✓ patterns: {argument} filled literally, * one segment");
  }

  // ---------- 4. the kind's configuration ----------
  {
    const base = { repository: "https://github.com/example/agent", commit: "a".repeat(40), command: ["node", "a.mjs"], validate: { command: ["node", "v.mjs"] },
      write_back: ["company-profile/company", "applications"], args: { app: { from: "targets.asset.key" } } };
    const parsed = AgentWorkspaceSchema.parse(base);
    assert.deepEqual([parsed.required_outputs, parsed.required_outputs_when], [[], "always"], "defaults: none, always");
    const good = AgentWorkspaceSchema.parse({ ...base, required_outputs: [REPORT, "applications/{app}/summary.md"], required_outputs_when: "workspace_changed" });
    assert.deepEqual(good.required_outputs, [REPORT, "applications/{app}/summary.md"]);
    const bad = (extra: Record<string, unknown>, re: RegExp) => {
      const r = AgentWorkspaceSchema.safeParse({ ...base, ...extra });
      assert.ok(!r.success, JSON.stringify(extra));
      assert.match(r.error!.issues.map((i) => i.message).join("; "), re);
    };
    bad({ required_outputs: ["kpis/summary.md"] }, /not a file under a write-back path/);
    bad({ required_outputs: ["company-profile/company"] }, /not a file under a write-back path/);
    bad({ required_outputs: ["../x/summary.md"] }, /relative glob/);
    bad({ required_outputs: ["applications/{nope}/summary.md"] }, /\{nope\} is not a declared argument/);
    bad({ required_outputs: [REPORT, REPORT] }, /listed twice/);
    bad({ required_outputs_when: "sometimes" }, /./);
    console.log("✓ configuration: defaults none and always; outside the write-back, an undeclared placeholder, a repeat: refused");
  }

  // ---------- 5. run_S59pF-Rit5xA3fsh ----------
  {
    // What the run restored and what it staged: the ledger with one more line, the report as it was (version 3.2.0).
    const restored = tree("s59-restored", { [REPORT]: "---\nversion: 3.2.0\n---\n", "company-profile/company/soc/main.jsonl": "{\"id\":\"obs_1\"}\n" });
    const staged = tree("s59-staged", { [REPORT]: "---\nversion: 3.2.0\n---\n", "company-profile/company/soc/main.jsonl": "{\"id\":\"obs_1\"}\n{\"id\":\"obs_01M6B79EAAPZMXZ0K1EJZXKKPP\"}\n" });
    const required = [REPORT];
    const written = writtenOutputs(restored, staged, required);
    const end = withRequiredOutputs({ outcome: "succeeded" as const, results: [] }, { required, when: "workspace_changed", workspaceUnchanged: false, written });
    assert.equal(end.outcome, "failed");
    assert.equal((end as { error_kind: string }).error_kind, "output_missing");
    // The quiet exit of the same kind ("report current": nothing written anywhere) still succeeds.
    assert.equal(withRequiredOutputs({ outcome: "succeeded" as const, results: [] }, { required, when: "workspace_changed", workspaceUnchanged: true, written: writtenOutputs(restored, restored, required) }).outcome, "succeeded");
    console.log("✓ run_S59pF-Rit5xA3fsh: the ledger appended, the report left as it was: failed output_missing; the quiet exit still succeeds");
  }
  console.log("required-outputs: ok");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
