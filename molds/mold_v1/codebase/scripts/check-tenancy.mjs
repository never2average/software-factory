/**
 * Which code reads tenant data without entering the workspace's RLS scope?
 *
 * The `org_isolation` policies now FAIL CLOSED: a query that does not set
 * app.org_id returns ZERO rows rather than every workspace's. That makes an
 * unscoped query a silent data-loss bug — an empty list is a valid-looking
 * answer, so nothing raises its hand.
 *
 * This is a RATCHET, not a wall: it fails when a count goes UP. Driving one
 * down is the work; letting it grow is the regression.
 *
 *   npm run check:tenancy
 *   npm run check:tenancy -- --list      names every unconverted file
 *   npm run check:tenancy -- --accept    locks in a gain
 *
 * THREE SURFACES, because there are three projects against one database.
 *
 * This checked `app/api` only, and the agent is a SEPARATE deployment with its
 * own database layer (`withOrgDb`, not `withOrgRls`). Its files were verified
 * exactly once, by a guard living inside .migrate-rls-fail-closed.mjs — a
 * script that has now been run and will never be run again. So an unscoped
 * `db.select` in a Next route failed CI while the identical mistake in an agent
 * tool shipped, and surfaced as the agent calmly reporting that a workspace has
 * no customers. That guard is lifted here, where it runs on every commit.
 *
 * …AND THE WEB SURFACE WAS `app/api`, WHICH IS NOT WHERE THE WEB APP LIVES.
 *
 * `grep -rl getOpsDb app/api` has never once looked at `app/eve/**` or at
 * `lib/**`. Both hold code that reads tenant rows on the `getOpsDb()` handle,
 * and the worst of it was the ownership gate in front of eve's own session
 * routes: three queries, no workspace, 0 rows under the fail-closed policy, and
 * a branch that reads "no rows" as "we have no record of this session, let it
 * through". Every signed-in caller could read and send into every session they
 * had an id for, and this check reported the web surface clean on every commit
 * while that was true.
 *
 * The surface is `app lib` now. A checker aimed at the wrong directory is worth
 * less than no checker, because it is also a claim.
 *
 * WHAT WIDENING IT FOUND, AND WHAT THE BASELINE OF 1 IS.
 *
 * Two files, and they are not the same kind of thing.
 *
 *   lib/agent-prompt-versions.ts — a `tenancy-ok:` with a reason. Its one
 *     unscoped statement is an existence probe that discards the row; every
 *     real read and write already runs inside withOrgRls.
 *
 *   lib/workspace-attention.ts — REAL DEBT, recorded as debt rather than
 *     waved through with a marker. It counts "things needing attention" per
 *     workspace for the workspace SWITCHER, which is genuinely a question no
 *     single workspace can answer — but it asks it with six grouped queries on
 *     the bare handle, so under the fail-closed policy every count comes back
 *     zero and the switcher confidently shows nothing to do. A `tenancy-ok:`
 *     marker saying "cross-workspace by design" would be true and would also
 *     conceal that it does not work; the baseline of 1 says the same thing
 *     without the reassurance. The fix is the `acrossOrgsRls` shape, and it is
 *     a correctness bug, not a leak.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * The tenancy CONTROL PLANE — routes that must see across workspaces to work.
 *
 * Every entry is a deliberate exemption with a reason, because an allowlist
 * nobody justifies becomes the place bugs hide. These are the routes that
 * decide which workspace you are in; they cannot be scoped to the answer they
 * are computing.
 */
const CONTROL_PLANE = [
  ["app/api/auth/", "sign-in happens before any workspace is known"],
  ["app/api/ops/orgs/", "creates and administers workspaces themselves"],
  ["app/api/ops/me/", "answers 'which workspaces am I in' — spans all of them"],
  ["app/api/ops/invites/", "an invite is claimed by someone not yet a member"],
  ["app/api/ops/platform-admins/", "platform staff, deliberately cross-workspace"],
  ["app/api/ops/health/", "liveness — reads no tenant rows"],
  ["app/api/ops/env/", "deployment configuration, not tenant data"],
  ["app/api/ops/runtime-env/", "deployment configuration, not tenant data"],
  ["lib/org-context.ts", "RESOLVES which workspace you are in — cannot run inside its own answer"],
  ["lib/ops-db.ts", "defines withOrgRls/acrossOrgsRls; its own handle is the mechanism"],
];

/**
 * Exemptions the prefixes above grant by accident, taken back by name.
 *
 * A path prefix is a blunt instrument: `app/api/ops/orgs/` is genuinely the
 * workspace control plane, and it also contains a route that reads
 * `automation_audit` — an ordinary tenant table with an `org_isolation` policy.
 * The prefix exempted it, so nobody ever asked, and the query ran on the bare
 * handle and returned zero rows in production for as long as it has existed.
 *
 * An exemption is a claim about a file. When the claim is wrong for one file
 * under a prefix that is right for the rest, the honest fix is to name it.
 */
const NOT_CONTROL_PLANE = [
  ["app/api/ops/orgs/[id]/audit/route.ts", "reads automation_audit, a tenant table, not workspace metadata"],
];

const BASELINE_FILE = "scripts/.tenancy-baseline.json";

/**
 * Does this source text contain a query on an UNSCOPED handle?
 *
 * Count STATEMENTS, not files. "Does this file mention withOrgRls" passed
 * app/api/ops/workflows/route.ts, whose GET was converted and whose POST was
 * not — so creating a workflow INSERTed outside any workspace scope and the
 * policy rejected it, while this check reported 70/70 clean.
 *
 * Whitespace-normalised, because the chain is routinely split across lines:
 *
 *     await Promise.all([
 *       db
 *         .select()
 *
 * `await db.select` never matches that, so a file with an unscoped query inside
 * a Promise.all read as clean — which is exactly how listCustomers() slipped
 * through and took the agent down.
 *
 * `tx.` is excluded on purpose: inside withOrgRls/withOrgDb the handle passed to
 * the callback is already scoped.
 */
function unscopedQuery(src) {
  const flat = src.replace(/\s+/g, " ");
  return /\bdb ?\.(?:select|insert|update|delete|execute)\b/.test(flat);
}

/**
 * An explicit `db.transaction()` is acceptable ONLY if it sets the GUC on its
 * own first lines. Wrapping such a block in withOrgDb would open a second
 * transaction on a different pooled connection from the one holding the locks,
 * so it is scoped in place instead — but it must actually be scoped.
 */
function unscopedTransaction(src) {
  return [...src.matchAll(/db\.transaction\(/g)].some(
    (m) => !/set_config\('app\.org_id'/.test(src.slice(m.index, m.index + 600)),
  );
}

/**
 * A `tenancy-ok:` marker exempts a file, and must be followed by a reason.
 *
 * Some code is genuinely cross-workspace by construction — a scheduler that
 * enumerates workspaces and does its real work inside a per-workspace scope, a
 * module that RESOLVES which workspace you are in (it cannot run inside the
 * answer it computes), or one that touches only global tables with no org_id at
 * all. Forcing those through a scope would be a fake conversion that reads as
 * safe. An exemption nobody had to justify is where the next leak will live, so
 * the reason sits beside the code rather than in a list nobody re-reads.
 */
function marked(src) {
  return /tenancy-ok:\s*\S/.test(src);
}

function classify(files, { isExempt, offends = (src) => unscopedQuery(src) || unscopedTransaction(src) } = {}) {
  const exempt = [];
  const converted = [];
  const pending = [];
  for (const f of files) {
    if (isExempt?.(f)) {
      exempt.push(f);
      continue;
    }
    const src = readFileSync(f, "utf8");
    if (marked(src)) {
      converted.push(f);
      continue;
    }
    if (offends(src)) pending.push(f);
    else converted.push(f);
  }
  return { exempt, converted, pending };
}

/* ---- surface 1: the web app's API routes --------------------------------- */

/**
 * `app lib`, not `app/api`.
 *
 * The gate route that let every signed-in caller into every conversation lives
 * at `app/eve/v1/session/[...segments]/route.ts`, and the access helpers it
 * leans on live in `lib/`. Neither directory had ever been looked at. Widening
 * the grep is the regression guard for that bug: the pre-fix file matches
 * `db.select` on an unscoped handle, so it lands in `pending` and the ratchet
 * fails, which is what should have happened the day it was written.
 *
 * `--include=*.ts` deliberately keeps `.tsx` out: components do not hold a
 * database handle, and `lib/**` and `app/**` route files are where this
 * question is decided.
 */
const webFiles = execSync("grep -rl 'getOpsDb' app lib --include=*.ts").toString().trim().split("\n");
const web = classify(webFiles, {
  isExempt: (f) =>
    !NOT_CONTROL_PLANE.some(([path]) => f === path) &&
    CONTROL_PLANE.some(([prefix]) => f.startsWith(prefix)),
});

/* ---- surface 2: the agent ------------------------------------------------ */

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const full = `${dir}/${f}`;
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });

/**
 * The agent's equivalent of `getOpsDb` is `getDb`/`withOrgDb` from
 * agent/lib/db/index.ts. A file is in scope if it imports that module or
 * queries a `db` handle at all — the second clause matters, because a file can
 * acquire the handle by other means and still be the one leaking.
 *
 * db/index.ts itself is excluded: it DEFINES the scoping helper, so its own
 * unscoped statements are the mechanism, not a violation.
 */
const agentFiles = existsSync("agent")
  ? walk("agent")
      .filter((f) => !f.endsWith("db/index.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /db\/index\.ts"/.test(src) || /\bdb ?\.(?:select|insert|update|delete|transaction)\b/.test(src);
      })
  : [];
const agent = classify(agentFiles);

/* ---- surface 3: the task-workflow service -------------------------------- */

/**
 * There are THREE projects against this database, not two.
 *
 * services/task-workflow owns the Tasks tab and writes `todos`,
 * `entity_activity` and its own workflow tables. Forgetting it is not
 * hypothetical: during the credential rotation it was the project left behind,
 * and it stayed broken for forty minutes because two out of three looked like
 * all of them.
 *
 * Its scoping helper is `withOrgTransaction(orgId, …)` (services/…/lib/db.ts),
 * which sets the same app.org_id GUC. A file that reaches for the raw `getDb()`
 * handle instead is outside every workspace scope, so under the fail-closed
 * policy it reads nothing.
 */
const serviceFiles = existsSync("services/task-workflow/lib")
  ? [...walk("services/task-workflow/lib"), ...walk("services/task-workflow/app")].filter(
      (f) => !f.endsWith("lib/db.ts"), // defines the helper; its own handle is the mechanism
    )
  : [];
/**
 * The candidate set is every file that touches the database AT ALL — the scoped
 * ones included. Filtering to offenders first made the denominator 0, and a
 * surface measuring zero files is a surface that can never fail: it prints a
 * reassuring `0 · pending: 0` whatever anyone writes. The count of scoped files
 * is what shows the check is actually looking at something.
 */
const service = classify(
  serviceFiles.filter((f) => /withOrgTransaction|getDb\s*\(/.test(readFileSync(f, "utf8"))),
  // Reaching for the raw handle IS the violation here — there is no scoped
  // sibling to call it on, the way `tx.` is the scoped form on the web side.
  { offends: (src) => /getDb\s*\(/.test(src) },
);

/* ---- report -------------------------------------------------------------- */

const line = (label, r, extra) =>
  `${label}: ${r.converted.length + r.pending.length} · in scope: ${r.converted.length}` +
  ` · pending: ${r.pending.length}${extra ?? ""}`;

console.log(line("web routes    ", web, ` · control-plane exemptions: ${web.exempt.length}`));
console.log(line("agent files   ", agent));
console.log(line("service files ", service));

if (process.argv.includes("--list")) {
  for (const [name, r] of [["web", web], ["agent", agent], ["service", service]]) {
    if (!r.pending.length) continue;
    console.log(`\npending (${name}):`);
    for (const f of r.pending.sort()) console.log("  " + f);
  }
}

/**
 * The baseline carries a count PER SURFACE.
 *
 * One combined number would let the agent regress while the web app improves
 * and still read as "holding" — the precise blindness this change exists to
 * remove. An older single-count baseline is read as the web figure, with the
 * agent starting from whatever it measures today.
 */
/**
 * A MISSING baseline means zero debt, never "whatever we measure right now".
 *
 * The first version of this defaulted an absent key to today's count, which
 * makes the ratchet self-referential: the run that introduces a regression is
 * also the run that adopts it as the baseline, so it passes. Proved with an
 * injected unscoped query in an agent tool — the check printed `pending: 1` and
 * exited 0. A meter that calibrates itself to the fault reads clean forever,
 * which is the exact failure this whole file exists to stop.
 *
 * Defaulting to 0 fails loudly on a surface with real debt. That is the correct
 * direction: `--accept` is how debt gets recorded, deliberately.
 */
const saved = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {};
const baseline = {
  web: saved.web ?? saved.pending ?? 0,
  agent: saved.agent ?? 0,
  service: saved.service ?? 0,
};

if (process.argv.includes("--accept")) {
  const next = {
    web: web.pending.length,
    agent: agent.pending.length,
    service: service.pending.length,
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nbaseline set to web ${next.web}, agent ${next.agent}, service ${next.service}`);
  process.exit(0);
}

const surfaces = [
  ["web route", web.pending.length, baseline.web, "withOrgRls (lib/ops-db.ts)"],
  ["agent file", agent.pending.length, baseline.agent, "withOrgDb (agent/lib/db/index.ts)"],
  [
    "service file",
    service.pending.length,
    baseline.service,
    "withOrgTransaction (services/task-workflow/lib/db.ts)",
  ],
];

let failed = false;
for (const [what, now, was, helper] of surfaces) {
  if (now > was) {
    failed = true;
    console.error(
      `\n✗ ${now} ${what}(s) read tenant data outside a workspace scope, up from ${was}.` +
        `\n  The policies fail closed, so those reads return ZERO rows in production.` +
        `\n  Use ${helper}, or add a \`tenancy-ok:\` comment giving the reason.`,
    );
  }
}
if (failed) process.exit(1);

const gained = surfaces.filter(([, now, was]) => now < was);
if (gained.length) {
  console.log(
    `\n✓ down from ${gained.map(([w, n, was]) => `${was} ${w}s to ${n}`).join(", ")}` +
      ` — run with --accept to lock in the gain`,
  );
} else if (surfaces.every(([, now]) => now === 0)) {
  console.log("\n✓ all three projects read tenant data only inside a workspace's scope");
} else {
  console.log(
    `\n✓ holding at web ${baseline.web}, agent ${baseline.agent}, service ${baseline.service}`,
  );
}
