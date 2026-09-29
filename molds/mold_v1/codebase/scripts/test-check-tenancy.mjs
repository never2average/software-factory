/**
 * check:tenancy's OWNERSHIP-GUARD rule, run against guards it must catch and guards it must leave alone.
 *
 * The rule exists because two real guards read "row-level security hid the row" as "the row is fine": getCustomer's
 * `if (row?.orgId && row.orgId !== orgId) return null` and customerInOrg's `row ? row.orgId === orgId : true`. It was
 * three line regexes, and mold_v1-119 listed what walked past them: an aliased orgForCustomer import, `const
 * owner = row?.orgId; if (owner && …)`, `row != null && …`, `if (!row) return true`, `rows.length === 0 || …`,
 * bracket access and workspaceId. mold_v1-135 added six more that walked past THAT: rows.every/some, destructuring
 * from \`row ?? {}\`, a reversed or (\`match || row === undefined\`), an early return of a truthy non-\`true\`
 * (\`if (!row) return { ok: true }\`), a late assignment, and .tsx files that were never read. Each is a fixture file below, written into a scratch tree that the REAL script
 * (scripts/check-tenancy.mjs) is run over, exactly as CI runs it — so this fails on the regex version and passes on
 * the syntax-tree one.
 *
 *   npm run test:check-tenancy
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-tenancy.mjs");

/** Each UNSOUND guard: the file it lives in and its source. Every one must be reported. */
const UNSOUND = {
  "lib/guards/the-original.ts": `export async function getCustomer(row: { orgId?: string } | undefined, orgId: string) {
  if (row?.orgId && row.orgId !== orgId) return null;
  return row;
}`,
  "lib/guards/ternary-true.ts": `export function customerInOrg(row: { orgId: string } | undefined, orgId: string) {
  return row ? row.orgId === orgId : true;
}`,
  "lib/guards/via-variable.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  const owner = row?.orgId;
  if (owner && owner !== orgId) return null;
  return row;
}`,
  "lib/guards/not-null.ts": `export function guard(row: { orgId: string } | null, orgId: string) {
  if (row != null && row.orgId !== orgId) throw new Error("not yours");
  return row;
}`,
  "lib/guards/early-true.ts": `export function allowed(row: { orgId: string } | undefined, orgId: string): boolean {
  if (!row) return true;
  return row.orgId === orgId;
}`,
  "lib/guards/empty-rows.ts": `export function allowed(rows: { orgId: string }[], orgId: string): boolean {
  return rows.length === 0 || rows[0].orgId === orgId;
}`,
  "lib/guards/bracket.ts": `export function guard(row: Record<string, string> | undefined, orgId: string) {
  if (row?.["org_id"] && row["org_id"] !== orgId) return null;
  return row;
}`,
  "lib/guards/workspace-id.ts": `export function guard(item: { workspaceId: string } | undefined, workspaceId: string) {
  if (item && item.workspaceId !== workspaceId) return null;
  return item;
}`,
  "lib/guards/block.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  if (row) {
    if (row.orgId !== orgId) throw new Error("not found");
  }
  return row;
}`,
  "lib/guards/normalised.ts": `export function guard(thread: { orgId: string | null } | undefined, orgId: string) {
  if (thread && (thread.orgId ?? "default") !== orgId) return null;
  return thread;
}`,
  // mold_v1-135: six more shapes that walked past the syntax-tree version.
  "lib/guards/every.ts": `export function allOurs(rows: { orgId: string }[], orgId: string): boolean {
  return rows.every((r) => r.orgId === orgId); // [].every(...) is true: every hidden row "matches"
}`,
  "lib/guards/some-mismatch.ts": `export function guard(rows: { workspaceId: string }[], workspaceId: string) {
  if (rows.some((r) => r.workspaceId !== workspaceId)) return null; // [].some(...) is false: nothing refused
  return rows;
}`,
  "lib/guards/destructured.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  const { orgId: owner } = row ?? {};
  if (owner && owner !== orgId) return null;
  return row;
}`,
  "lib/guards/destructured-same-name.ts": `export function guard(row: { org_id: string } | undefined, caller: string) {
  const { org_id } = row || {};
  if (org_id) {
    if (org_id !== caller) throw new Error("not yours");
  }
  return row;
}`,
  "lib/guards/reversed-or.ts": `export function allowed(row: { orgId: string } | undefined, orgId: string): boolean {
  return row?.orgId === orgId || row === undefined;
}`,
  "lib/guards/reversed-or-not.ts": `export function allowed(rows: { orgId: string }[], orgId: string): boolean {
  return rows[0]?.orgId === orgId || !rows.length;
}`,
  "lib/guards/early-object.ts": `export function check(row: { orgId: string } | undefined, orgId: string) {
  if (!row) return { ok: true };
  return { ok: row.orgId === orgId };
}`,
  "lib/guards/early-string.ts": `export function verdict(row: { orgId: string } | null, orgId: string) {
  if (row == null) return "allow";
  return row.orgId === orgId ? "allow" : "deny";
}`,
  "lib/guards/late-assignment.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  let o: string | undefined;
  o = row?.orgId;
  if (o && o !== orgId) return null;
  return row;
}`,
  "app/guards/page.tsx": `export function Owned({ row, orgId }: { row?: { orgId: string }; orgId: string }) {
  if (row?.orgId && row.orgId !== orgId) return null;
  return <div>{String(row)}</div>;
}`,
  "agent/tools/aliased.ts": `import { orgForCustomer as workspaceFromCustomer } from "../lib/org-context.ts";
import { modelFacing } from "../lib/model-facing.ts";
export const tool = modelFacing("t", { async execute(input: { customerId: string }) {
  return workspaceFromCustomer(input.customerId);
} });`,
  "agent/tools/namespaced.ts": `import * as org from "../lib/org-context.ts";
import { modelFacing } from "../lib/model-facing.ts";
export const tool = modelFacing("t", { async execute(input: { customerId: string }) {
  return org.orgForCustomer(input.customerId);
} });`,
  "agent/tools/dynamic.ts": `import { modelFacing } from "../lib/model-facing.ts";
export const tool = modelFacing("t", { async execute(input: { customerId: string }) {
  const { orgForCustomer: resolve } = await import("../lib/org-context.ts");
  return resolve(input.customerId);
} });`,
};

/** SOUND code the rule must not report: a false positive teaches people to reach for the escape. */
const SOUND = {
  "lib/ok/refuses-hidden.ts": `export function guard(row: { orgId?: string } | undefined, orgId: string) {
  if (row?.orgId !== orgId) return null; // undefined is not the caller's workspace: refused
  return row;
}`,
  "lib/ok/admits-seen.ts": `export function allowed(row: { orgId: string } | undefined, orgId: string) {
  return Boolean(row && row.orgId === orgId);
}`,
  "lib/ok/absent-refused.ts": `export function guard(rule: { orgId: string } | undefined, orgId: string) {
  if (!rule || rule.orgId !== orgId) throw new Error("schedule rule not found");
  return rule;
}`,
  "lib/ok/default-value.ts": `export function workspaceOf(row: { orgId?: string } | undefined) {
  return row?.orgId ?? "default";
}`,
  "lib/ok/escaped.ts": `export function guard(claimed: { orgId: string } | undefined, id: string) {
  // ownership-guard-ok: \`orgs\` carries no row-level security, so this read sees every workspace's row.
  if (claimed && claimed.orgId !== id) return "taken";
  return null;
}`,
  // mold_v1-135, the sound neighbours of the shapes above.
  "lib/ok/every-nonempty.ts": `export function allOurs(rows: { orgId: string }[], orgId: string): boolean {
  return rows.length > 0 && rows.every((r) => r.orgId === orgId);
}`,
  "lib/ok/every-counted.ts": `export function allOurs(rows: { orgId: string }[], ids: string[], orgId: string): boolean {
  return rows.length === ids.length && rows.every((r) => r.orgId === orgId);
}`,
  "lib/ok/some-match.ts": `export function anyOurs(rows: { orgId: string }[], orgId: string): boolean {
  return rows.some((r) => r.orgId === orgId); // admits only a row it saw
}`,
  "lib/ok/some-empty-refused.ts": `export function guard(rows: { orgId: string }[], orgId: string) {
  if (rows.length === 0 || rows.some((r) => r.orgId !== orgId)) return null;
  return rows;
}`,
  "lib/ok/destructured-refuses.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  const { orgId: owner } = row ?? {};
  if (owner !== orgId) return null; // undefined is not the caller's workspace: refused
  return row;
}`,
  "lib/ok/param-named-org.ts": `export function workspaceOf(row: { orgId?: string } | undefined) {
  const { orgId } = row ?? {};
  return orgId ?? "default";
}
export function guard(item: { orgId: string } | undefined, orgId: string) {
  if (orgId && item?.orgId !== orgId) return null; // presence of the CALLER's id, not the row's; refusal is sound
  return item;
}`,
  "lib/ok/reversed-or-refused.ts": `export function refused(row: { orgId: string } | undefined, orgId: string): boolean {
  return row?.orgId !== orgId || row === undefined;
}`,
  "lib/ok/early-refusal-object.ts": `export function check(row: { orgId: string } | undefined, orgId: string) {
  if (!row) return { ok: false, reason: "not found" };
  return { ok: row.orgId === orgId };
}`,
  "lib/ok/late-assignment-refuses.ts": `export function guard(row: { orgId: string } | undefined, orgId: string) {
  let o: string | undefined;
  o = row?.orgId;
  if (o !== orgId) return null;
  return row;
}`,
  "app/ok/page.tsx": `export function Owned({ row, orgId }: { row?: { orgId: string }; orgId: string }) {
  if (row?.orgId !== orgId) return null;
  return <div>{String(row)}</div>;
}`,
  "lib/ok/uses-scope.ts": `import { getOpsDb, withOrgRls } from "./ops-db";
export async function list(orgId: string) {
  getOpsDb();
  return withOrgRls(orgId, async (tx: { select(): unknown }) => tx.select());
}`,
  "app/api/ok/route.ts": `export function GET() {
  return new Response("ok");
}`,
  "agent/tools/session.ts": `import { orgForSession } from "../lib/org-context.ts";
import { modelFacing } from "../lib/model-facing.ts";
export const tool = modelFacing("t", { async execute(_input: unknown, ctx: unknown) {
  return orgForSession(ctx);
} });`,
};

const root = mkdtempSync(join(tmpdir(), "check-tenancy-"));
let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${detail}`}`);
  }
};
try {
  for (const [file, src] of Object.entries({ ...UNSOUND, ...SOUND })) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), `${src}\n`);
  }
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = error.status ?? 1;
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const reported = new Set(
    out.split("\n").map((l) => /^\s+((?:lib|agent|app)\/\S+?):\d+\s/.exec(l)?.[1]).filter(Boolean),
  );
  console.log("\nUnsound ownership guards check:tenancy must report:");
  for (const file of Object.keys(UNSOUND)) check(file, reported.has(file), `not reported. Output:\n${out}`);
  console.log("\nSound code it must leave alone:");
  for (const file of Object.keys(SOUND)) check(file, !reported.has(file), `reported as unsound`);
  check("and it fails the run when it finds one", status !== 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\ntest-check-tenancy: all assertions passed" : `\ntest-check-tenancy: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
