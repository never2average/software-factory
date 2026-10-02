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
 * WHAT WIDENING IT FOUND, AND WHAT THE BASELINE OF 1 WAS.
 *
 * Two files, and they are not the same kind of thing.
 *
 *   lib/agent-prompt-versions.ts — a `tenancy-ok:` with a reason. Its one
 *     unscoped statement is an existence probe that discards the row; every
 *     real read and write already runs inside withOrgRls.
 *
 *   lib/workspace-attention.ts — WAS REAL DEBT, recorded as debt rather than
 *     waved through with a marker. It counts "things needing attention" per
 *     workspace for the workspace SWITCHER, and asked it with six grouped
 *     queries on the bare handle, so under the fail-closed policy every count
 *     came back zero. A `tenancy-ok:` marker saying "cross-workspace by design"
 *     would have been true and would also have concealed that it did not work.
 *     Fixed in mold_v1-099 (each workspace counted inside its own scope,
 *     scripts/test-workspace-attention-db.mjs), and the web baseline is 0.
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
 * `.tsx` is read too (mold_v1-135). It was kept out on the theory that
 * components do not hold a database handle, but `app/**` pages are server
 * components and can; a theory about where a mistake cannot be is the kind of
 * claim this file exists to stop making.
 */
const webFiles = execSync("grep -rl 'getOpsDb' app lib --include=*.ts --include=*.tsx").toString().trim().split("\n");
const web = classify(webFiles, {
  isExempt: (f) =>
    !NOT_CONTROL_PLANE.some(([path]) => f === path) &&
    CONTROL_PLANE.some(([prefix]) => f.startsWith(prefix)),
});

/* ---- surface 2: the agent ------------------------------------------------ */

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const full = `${dir}/${f}`;
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
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

/* ---- surface 4: ownership guards that pass on an invisible row ------------ */

/**
 * A GUARD THAT ASKS A QUESTION RLS CANNOT ANSWER.
 *
 * getCustomer(id, orgId) read the record across every workspace, then read the
 * owner in the CALLER's scope and returned null only `if (row?.orgId && row.orgId
 * !== orgId)`. Under the fail-closed policy that scoped read cannot see another
 * workspace's row, so `row` was undefined, the guard was false, and the other
 * workspace's record went out. lib/org-context.ts `customerInOrg` was the same
 * idea written the other way round: `row ? row.orgId === orgId : true` on the bare
 * handle, which sees no row, so it admitted every id. Both LOOK like a check and
 * both read "I could not see it" as "it is fine".
 *
 * The right shape is the read itself inside the caller's scope: then absence IS
 * the answer. So these fail outright, with no baseline.
 *
 * READ FROM THE SYNTAX TREE, NOT BY REGEX (mold_v1-119). The first version was
 * three line regexes, and each of these walked past them: an aliased
 * `orgForCustomer` import, `const owner = row?.orgId; if (owner && …)`,
 * `row != null && row.orgId !== …`, `if (!row) return true`, `rows.length === 0
 * || rows[0].orgId === …`, `row?.["orgId"]`, and the same guards on `workspaceId`.
 * This parses every file with the TypeScript compiler (already a dependency) and
 * looks for the SHAPE, whatever it is spelled like. An "ownership read" is an
 * access to orgId / org_id / workspaceId / workspace_id, by `.` or by `["…"]`. The
 * shapes, each of which passes when row-level security hides the row:
 *
 *   PRESENCE   `row?.orgId && row.orgId !== …`, `row != null && …`, `rows.length > 0
 *              && …`, `owner && owner !== …` (owner = row?.orgId), and the block form
 *              `if (row) { if (row.orgId !== …) return … }`: a refusal on a MISMATCH
 *              that a hidden row never reaches;
 *   ABSENCE    `!row || row.orgId === …`, `rows.length === 0 || rows[0].orgId === …`,
 *              `row ? row.orgId === … : true`, `!row ? true : …`: a MATCH that a
 *              hidden row satisfies;
 *   EARLY      `if (!row) return true` in a function whose answer is otherwise
 *              "the owner matches";

 * mold_v1-135 — six more that walked past the first tree walk:
 *
 *   ALL/ANY    `rows.every((r) => r.orgId === orgId)` (true on the empty list RLS
 *              leaves) and `rows.some((r) => r.orgId !== orgId)` as a refusal
 *              (false on it) — sound only behind a non-empty / counted check of the
 *              same list (`rows.length > 0 && …`, `rows.length === 0 || …`);
 *   DESTRUCT   `const { orgId: owner } = row ?? {}` taints `owner` like `row?.orgId`;
 *   REVERSED   `row?.orgId === orgId || row === undefined` (and `mismatch && row`);
 *   EARLY      now any value that ADMITS, not only `true`: `{ ok: true }`, or the
 *              literal the function returns on a match (`… ? "allow" : "deny"`);
 *   LATE       `let o; o = row?.orgId` taints `o` like a declaration does;
 *   .tsx       files are walked.
 *
 * Tainted names are SCOPED to the function that taints them: `const { orgId } =
 * row ?? {}` in one function says nothing about a parameter called `orgId` in
 * the next.
 *
 * Polarity is what makes a guard unsound, so it is what is checked: `row?.orgId !==
 * orgId` alone refuses a hidden row (undefined is not the caller's workspace) and is
 * sound; `row && row.orgId === orgId` admits only a row it saw, and is sound too.
 *   TOOL       a model tool (a file calling `modelFacing(`) that calls
 *              orgForCustomer / orgForCustomerId under ANY local name — alias,
 *              namespace, destructured `import()` — taking its workspace from a
 *              model-supplied id instead of the caller's session.
 *
 * A guard over a table WITHOUT row-level security (orgs, the control plane) sees
 * every row and is sound; mark it `ownership-guard-ok: <reason>` on the line or
 * one of the two above.
 */
const { default: ts } = await import("typescript");

const ORG_KEY = /^(?:org_?id|workspace_?id)$/i;
const ORG_RESOLVERS = new Set(["orgForCustomer", "orgForCustomerId"]);

/** The org-id property an access expression reads, or null. */
function ownershipKey(node) {
  if (ts.isPropertyAccessExpression(node) && ORG_KEY.test(node.name.text)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && ORG_KEY.test(node.argumentExpression.text)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** Source text with optional-chaining and non-null marks removed, so `row?.x` and `row!.x` name the same base as `row.x`. */
const canon = (node, sf) => node.getText(sf).replace(/\?\./g, ".").replace(/!(?=[.[])/g, "").replace(/\.\[/g, "[").replace(/\s+/g, "");

/** Strip parentheses, `as`, `!` and `satisfies` wrappers. */
function bare(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n))) n = n.expression;
  return n;
}



const NULLISH = (n) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === "undefined");
const ZERO = (n) => ts.isNumericLiteral(n) && Number(n.text) === 0;
const ONE = (n) => ts.isNumericLiteral(n) && Number(n.text) === 1;
const isLength = (n) => ts.isPropertyAccessExpression(n) && n.name.text === "length";

/**
 * If `cond` tests that something is PRESENT (true when it is there), the canonical base it tests; else null.
 * `row`, `row != null`, `row !== undefined`, `Boolean(row)`, `!!row`, `rows.length`, `rows.length > 0`, `rows.length >= 1`,
 * `rows.length !== 0`, `rows[0]`.
 */
function presenceOf(cond, sf) {
  const c = bare(cond);
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return absenceOf(c.operand, sf, true);
  if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "Boolean" && c.arguments.length === 1) {
    return presenceOf(c.arguments[0], sf);
  }
  if (ts.isBinaryExpression(c)) {
    const op = c.operatorToken.kind;
    const [l, r] = [bare(c.left), bare(c.right)];
    if ((op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) && (NULLISH(r) || NULLISH(l))) {
      return subject(NULLISH(r) ? l : r, sf);
    }
    if (isLength(l)) {
      if ((op === ts.SyntaxKind.GreaterThanToken && ZERO(r)) || (op === ts.SyntaxKind.GreaterThanEqualsToken && ONE(r)) || ((op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) && ZERO(r))) {
        return canon(l.expression, sf);
      }
    }
    return null;
  }
  if (isLength(c)) return canon(c.expression, sf);
  if (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) return subject(c, sf);
  return null;
}

/** What a presence / absence test is ABOUT: the row, when the thing tested is the row's owner (`row?.orgId`). */
function subject(node, sf) {
  const n = bare(node);
  return ownershipKey(n) ? canon(n.expression, sf) : canon(n, sf);
}

/**
 * If `cond` tests that something is ABSENT, the canonical base; else null. `!row`, `row == null`, `row === undefined`,
 * `!rows.length`, `rows.length === 0`, `rows.length < 1`, `rows.length <= 0`. (`negated`: called on the operand of `!`.)
 */
function absenceOf(cond, sf, negated = false) {
  if (negated) return presenceOf(cond, sf);
  const c = bare(cond);
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return presenceOf(c.operand, sf);
  if (ts.isBinaryExpression(c)) {
    const op = c.operatorToken.kind;
    const [l, r] = [bare(c.left), bare(c.right)];
    if ((op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) && (NULLISH(r) || NULLISH(l))) {
      return subject(NULLISH(r) ? l : r, sf);
    }
    if (isLength(l)) {
      if (((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) && ZERO(r)) || (op === ts.SyntaxKind.LessThanToken && ONE(r)) || (op === ts.SyntaxKind.LessThanEqualsToken && ZERO(r))) {
        return canon(l.expression, sf);
      }
    }
  }
  return null;
}

/**
 * The ownership COMPARISONS inside `node` that are about `base` (the row, an element or member of it — rows[0],
 * rows.at(0), result.row — or a variable holding its owner): "match" for === / ==, "mismatch" for !== / !=.
 */
function ownerComparisons(node, base, sf, tainted) {
  const out = new Set();
  if (!base) return out;
  const about = (b) => b === base || b.startsWith(`${base}[`) || b.startsWith(`${base}.`);
  // Anywhere in the operand — `(row.orgId ?? DEFAULT_ORG)`, `String(row.orgId)`, `row.orgId.trim()`, a tainted
  // variable — but not inside a nested function.
  const isOwnerOfBase = (e) => {
    const x = bare(e);
    if (ownershipKey(x) && about(canon(x.expression, sf))) return true;
    const t = ts.isIdentifier(x) ? tainted.of(x) : null;
    if (t) return x.text === base || about(t);
    if (ts.isFunctionLike(x)) return false;
    let hit = false;
    ts.forEachChild(x, (c) => {
      if (!hit && isOwnerOfBase(c)) hit = true;
    });
    return hit;
  };
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && COMPARE.has(n.operatorToken.kind) && (isOwnerOfBase(n.left) || isOwnerOfBase(n.right))) {
      const k = n.operatorToken.kind;
      out.add(k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsEqualsToken ? "match" : "mismatch");
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Comparison operators that make an ownership read a guard. */
const COMPARE = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);


const isTrue = (n) => bare(n)?.kind === ts.SyntaxKind.TrueKeyword;
const isFalse = (n) => bare(n)?.kind === ts.SyntaxKind.FalseKeyword;

/**
 * Does returning `e` ADMIT? `true`; or an object literal that says so (`{ ok: true }` — at least one property
 * set to `true` and none to `false`); or a literal equal to one of `admitting`, the values the function
 * returns when the owner MATCHES (`row.orgId === orgId ? "allow" : "deny"` → "allow").
 */
function admits(e, sf, admitting = new Set()) {
  const x = bare(e);
  if (!x) return false;
  if (isTrue(x)) return true;
  if (ts.isObjectLiteralExpression(x)) {
    const vals = x.properties.filter(ts.isPropertyAssignment).map((p) => p.initializer);
    return vals.some(isTrue) && !vals.some(isFalse);
  }
  if (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x)) return admitting.has(canon(x, sf));
  return false;
}

/** Does `stmt` hold an `if (<owner mismatch on base>) return/throw …`? */
function refusesOnMismatch(stmt, base, sf, tainted) {
  let found = false;
  const exits = (s) => s && (ts.isReturnStatement(s) || ts.isThrowStatement(s) || (ts.isBlock(s) && s.statements.some(exits)));
  const visit = (n) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isIfStatement(n) && exits(n.thenStatement) && ownerComparisons(n.expression, base, sf, tainted).has("mismatch")) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(stmt);
  return found;
}
/** The value this statement (or single-statement block) returns, or null. */
function returned(stmt) {
  if (!stmt) return null;
  if (ts.isBlock(stmt)) return stmt.statements.length === 1 ? returned(stmt.statements[0]) : null;
  return ts.isReturnStatement(stmt) && stmt.expression ? stmt.expression : null;
}

/** Local names this file gives orgForCustomer / orgForCustomerId (and namespaces that carry them). */
function resolverNames(sf) {
  const names = new Set(ORG_RESOLVERS);
  const namespaces = new Set();
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings) {
      const b = n.importClause.namedBindings;
      if (ts.isNamedImports(b)) {
        for (const el of b.elements) if (ORG_RESOLVERS.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
      } else if (ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const from = el.propertyName ?? el.name;
          if (ts.isIdentifier(from) && ORG_RESOLVERS.has(from.text) && ts.isIdentifier(el.name)) names.add(el.name.text);
        }
      } else if (ts.isIdentifier(n.name)) {
        const init = bare(n.initializer);
        const inner = ts.isAwaitExpression(init) ? bare(init.expression) : init;
        if (ts.isIdentifier(inner) && names.has(inner.text)) names.add(n.name.text);
        if (ts.isPropertyAccessExpression(inner) && ORG_RESOLVERS.has(inner.name.text)) names.add(n.name.text);
        if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword) namespaces.add(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { names, namespaces };
}

/** Every unsound ownership guard in one file's source, as [line (1-based), why]. */
function unsoundGuards(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const hits = new Map();
  const flag = (node, why) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if ([lines[line], lines[line - 1], lines[line - 2]].some((l) => /ownership-guard-ok:\s*\S/.test(l ?? ""))) return;
    const key = `${line}:${why}`;
    if (!hits.has(key)) hits.set(key, [line + 1, why]);
  };

  // Variables holding a possibly-hidden owner: `const owner = row?.orgId`, `const o = row && row.orgId`.
  // `const owner = row?.orgId`, `= row?.["org_id"] ?? null`, `= row && row.orgId`: the variable IS the row's owner.
  // Scoped: each taint holds for the function (or file) that made it, never for a same-named parameter elsewhere.
  const taints = new Map();
  const scopeOf = (n) => {
    let s = n.parent;
    while (s && !ts.isFunctionLike(s) && !ts.isSourceFile(s)) s = s.parent;
    return s ?? sf;
  };
  const tainted = {
    add(name, base, at) {
      if (!taints.has(name)) taints.set(name, []);
      taints.get(name).push({ base, scope: scopeOf(at) });
    },
    /** The row an identifier's value is the owner of, if a taint covers this use. Innermost wins. */
    of(ident) {
      const list = taints.get(ident.text);
      if (!list) return null;
      let best = null;
      for (const t of list) {
        if (t.scope.pos <= ident.pos && ident.end <= t.scope.end && (!best || t.scope.end - t.scope.pos < best.scope.end - best.scope.pos)) best = t;
      }
      return best?.base ?? null;
    },
  };
  /** `row ?? {}`, `row || {}`, `await row`, `row` → the row's canonical base (for destructuring). */
  const rowOf = (e) => {
    let x = bare(e);
    if (ts.isAwaitExpression(x)) x = bare(x.expression);
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return rowOf(x.left);
    }
    if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return canon(x, sf);
    return null;
  };
  const ownerValue = (e) => {
    let x = bare(e);
    if (ts.isAwaitExpression(x)) x = bare(x.expression);
    if (ownershipKey(x)) return canon(x.expression, sf);
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return ownerValue(x.left);
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return ownerValue(x.right);
    return null;
  };
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const base = ownerValue(n.initializer);
      if (base) tainted.add(n.name.text, base, n);
    }
    // DESTRUCT — `const { orgId: owner } = row ?? {}`, `const { org_id } = row || {}`.
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      const base = rowOf(n.initializer);
      if (base) {
        for (const el of n.name.elements) {
          const from = el.propertyName ?? el.name;
          const key = ts.isIdentifier(from) || ts.isStringLiteralLike(from) ? from.text : null;
          if (key && ORG_KEY.test(key) && ts.isIdentifier(el.name)) tainted.add(el.name.text, base, n);
        }
      }
    }
    // LATE — `let o; o = row?.orgId`.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(bare(n.left))) {
      const base = ownerValue(n.right);
      if (base) tainted.add(bare(n.left).text, base, n);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  /**
   * Is `node` the right side of an `&&` (every) / `||` (some) whose left side checks `list`'s length or presence?
   * `rows.length > 0 && rows.every(…)`, `rows.length === ids.length && …`, `rows.length === 0 || rows.some(…)`.
   */
  const countedBefore = (node, list, joiner) => {
    let child = node;
    let p = node.parent;
    while (p && (ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === joiner))) {
      if (ts.isBinaryExpression(p) && p.right === child) {
        const left = p.left;
        if (canon(left, sf).includes(`${list}.length`) || presenceOf(left, sf) === list || absenceOf(left, sf) === list) return true;
      }
      child = p;
      p = p.parent;
    }
    return false;
  };
  /** Literals `fn` returns when the owner of `base` MATCHES: `row.orgId === orgId ? "allow" : "deny"` → "allow". */
  const matchValues = (fn, base) => {
    const out = new Set();
    const visit = (x) => {
      if (x !== fn && ts.isFunctionLike(x)) return;
      if (ts.isConditionalExpression(x)) {
        const k = ownerComparisons(x.condition, base, sf, tainted);
        const pick = k.has("match") && !k.has("mismatch") ? x.whenTrue : k.has("mismatch") && !k.has("match") ? x.whenFalse : null;
        const v = pick && bare(pick);
        if (v && (ts.isStringLiteralLike(v) || ts.isNumericLiteral(v))) out.add(canon(v, sf));
      }
      ts.forEachChild(x, visit);
    };
    visit(fn);
    return out;
  };

  const isTool = /\bmodelFacing\(/.test(src);
  const resolvers = isTool ? resolverNames(sf) : null;

  const visit = (n) => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      // PRESENCE — `row?.orgId && row.orgId !== …`, `row != null && …`, `rows.length > 0 && rows[0].orgId !== …`,
      // `owner && owner !== …`: false when the row is hidden, so the "mismatch" never fires.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const base = presenceOf(n.left, sf);
        if (base && ownerComparisons(n.right, base, sf, tainted).has("mismatch")) {
          flag(n, `\`${n.left.getText(sf).trim()} && …\` ownership guard (a row RLS hid makes it false, and it passes)`);
        }
      }
      // REVERSED PRESENCE — `row?.orgId !== orgId && row != null`: the same guard, operands swapped.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const base = presenceOf(n.right, sf);
        if (base && ownerComparisons(n.left, base, sf, tainted).has("mismatch")) {
          flag(n, `\`… && ${n.right.getText(sf).trim()}\` ownership guard (a row RLS hid makes it false, and it passes)`);
        }
      }
      // ABSENCE — `!row || row.orgId === …`, `rows.length === 0 || rows[0].orgId === …`: true when hidden, a "match".
      if (op === ts.SyntaxKind.BarBarToken) {
        const base = absenceOf(n.left, sf);
        if (base && ownerComparisons(n.right, base, sf, tainted).has("match")) {
          flag(n, `\`${n.left.getText(sf).trim()} || …\` ownership guard (admits a row it could not see)`);
        }
        // REVERSED ABSENCE — `row?.orgId === orgId || row === undefined`.
        const after = absenceOf(n.right, sf);
        if (after && ownerComparisons(n.left, after, sf, tainted).has("match")) {
          flag(n, `\`… || ${n.right.getText(sf).trim()}\` ownership guard (admits a row it could not see)`);
        }
      }
    }
    // ALL/ANY — `rows.every((r) => r.orgId === orgId)` is true on the empty list RLS leaves; `rows.some((r) =>
    // r.orgId !== orgId)` as a refusal is false on it. Sound only behind a non-empty or counted check of the list.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(bare(n.expression)) && n.arguments.length >= 1) {
      const callee = bare(n.expression);
      const method = callee.name.text;
      const fn = bare(n.arguments[0]);
      const param = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
      if ((method === "every" || method === "some") && param) {
        const found = ownerComparisons(fn.body, param, sf, tainted);
        const list = canon(callee.expression, sf);
        const unsound = method === "every" ? found.has("match") : found.has("mismatch");
        if (unsound && !countedBefore(n, list, method === "every" ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken)) {
          flag(n, method === "every"
            ? `\`${list}.every(… owner === …)\` is true on the empty list a row-level security filter leaves`
            : `\`${list}.some(… owner !== …)\` refuses nothing on the empty list a row-level security filter leaves`);
        }
      }
    }
    // ABSENCE, as a ternary — `row ? row.orgId === … : true`, `!row ? true : …`.
    if (ts.isConditionalExpression(n)) {
      const present = presenceOf(n.condition, sf);
      const absent = absenceOf(n.condition, sf);
      if (
        (present && admits(n.whenFalse, sf) && ownerComparisons(n.whenTrue, present, sf, tainted).has("match")) ||
        (absent && admits(n.whenTrue, sf) && ownerComparisons(n.whenFalse, absent, sf, tainted).has("match"))
      ) {
        flag(n, "`row ? row.orgId … : true` guard (admits a row it could not see)");
      }
    }
    // EARLY — `if (!row) return true` (or `{ ok: true }`, or the value a match returns) in a function whose answer
    // is otherwise "the owner matches".
    const early = ts.isIfStatement(n) ? returned(n.thenStatement) : null;
    if (early) {
      const base = absenceOf(n.expression, sf);
      let fn = n.parent;
      while (fn && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
      if (base && fn && !ts.isSourceFile(fn) && ownerComparisons(fn, base, sf, tainted).has("match") && admits(early, sf, matchValues(fn, base))) {
        flag(n, `\`if (${n.expression.getText(sf).trim()}) return ${early.getText(sf).trim()}\` before an ownership match (admits a row it could not see)`);
      }
    }
    // PRESENCE, as a block — `if (row) { if (row.orgId !== orgId) return null; }` / `if (owner) { … throw … }`: the
    // refusal sits inside a branch a hidden row never enters.
    if (ts.isIfStatement(n) && !n.elseStatement) {
      const base = presenceOf(n.expression, sf);
      if (base && refusesOnMismatch(n.thenStatement, base, sf, tainted)) {
        flag(n, `\`if (${n.expression.getText(sf).trim()}) { …refuse on a mismatch… }\` (a row RLS hid skips the refusal)`);
      }
    }
    // TOOL — the workspace taken from a model-supplied customer id, under any name.
    if (resolvers && ts.isCallExpression(n)) {
      const callee = bare(n.expression);
      const direct = ts.isIdentifier(callee) && resolvers.names.has(callee.text);
      const viaNs = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        ORG_RESOLVERS.has(ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : "");
      if (direct || viaNs) flag(n, "a model tool takes its workspace from a customer id (use orgForSession(ctx))");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...hits.values()].sort((a, b) => a[0] - b[0]);
}

const guardFiles = [
  ...(existsSync("agent") ? walk("agent") : []),
  ...(existsSync("lib") ? walk("lib") : []),
  ...(existsSync("app") ? walk("app") : []),
  ...(existsSync("services/task-workflow/lib") ? walk("services/task-workflow/lib") : []),
  ...(existsSync("services/task-workflow/app") ? walk("services/task-workflow/app") : []),
].filter((f) => !f.includes("node_modules") && !/\.generated\.tsx?$/.test(f));
const guardHits = [];
for (const f of guardFiles) {
  for (const [line, why] of unsoundGuards(f, readFileSync(f, "utf8"))) guardHits.push(`${f}:${line}  ${why}`);
}
console.log(`ownership guards: ${guardFiles.length} files scanned · unsound guards: ${guardHits.length}`);
if (guardHits.length) {
  console.error(
    `\n✗ ${guardHits.length} ownership guard(s) that pass when row-level security hides the row:\n` +
      guardHits.map((h) => `  ${h}`).join("\n") +
      `\n  Read inside the caller's scope (withOrgDb / withOrgRls) and treat absence as the answer, or add` +
      `\n  \`ownership-guard-ok: <reason>\` when the table carries no row-level security.`,
  );
  process.exitCode = 1;
}

/* ---- surface 5: cross-workspace readers reachable from a person's request -- */

/**
 * WORKSPACES ARE NOT AWARE OF EACH OTHER. No code a person's request runs may list the workspaces or read every
 * workspace's scope: `acrossOrgDbs`, `acrossOrgsRls`, `listWorkspaceIds`, a `.listOrgs()` reader, or a bare
 * `select … from(orgs)`. A cron, a backfill or a deploy step may. The analysis is function-level and follows imports,
 * re-exports and dynamic imports from every request entry point (route handlers, pages, the proxy, model tools, agent
 * channels / hooks / instructions) — scripts/lib/cross-workspace-reach.mjs, whose header says exactly what it covers.
 *
 * A reader still reachable from a request must be named below, with the reason it is not a person reading another
 * workspace — or with the change that is removing it. Anything else fails the run. An entry that is no longer
 * reached is reported so the list shrinks (a warning, so a parallel branch that removes one does not break the other).
 */
const CROSS_WORKSPACE_KNOWN = [
  [
    "agent/lib/session-scope.ts#inheritedScope",
    "RESOLUTION, not a read of another workspace's data: which workspace an eve-internal session is in (a subagent's " +
      "child, a service continuation) — one org id, looked up by an eve-issued session id that no person supplies, " +
      "and it becomes that session's scope. FOLLOW-UP: a control-plane session→workspace row written with the scope, " +
      "so this is a point read instead of a sweep.",
  ],
  [
    "setup/workspace-cli.mjs#<module>",
    "A DISPATCHER, not a reader: `import(target)` loads one of setup/'s own program files (COMMANDS: login, mcp, " +
      "install-skills), each of which is a request entry point scanned here in its own right.",
  ],
  [
    "setup/workspace-mcp.mjs#<module>",
    "A DISPATCHER, not a reader: `import(DEPLOYMENT.modules.login)` loads setup/'s own sign-in module (workspace-login), " +
      "itself a request entry point scanned here in its own right.",
  ],
];
{
  const { analyse } = await import("./lib/cross-workspace-reach.mjs");
  const { findings, roots } = await analyse({ root: process.cwd() });
  const known = new Map(CROSS_WORKSPACE_KNOWN);
  const unexplained = findings.filter((f) => !known.has(`${f.file}#${f.decl}`));
  const reached = new Map();
  for (const f of findings) {
    const k = `${f.file}#${f.decl}`;
    reached.set(k, (reached.get(k) ?? 0) + 1);
  }
  console.log(`\ncross-workspace readers reachable from a person's request (${roots} entry points):`);
  for (const [k, reason] of CROSS_WORKSPACE_KNOWN) {
    if (reached.has(k)) console.log(`  known: ${k} — ${reached.get(k)} entry point(s). ${reason}`);
  }
  for (const [k] of CROSS_WORKSPACE_KNOWN) {
    if (!reached.has(k)) console.log(`  no longer reached — delete it from CROSS_WORKSPACE_KNOWN: ${k}`);
  }
  if (unexplained.length) {
    console.error(`\n✗ ${unexplained.length} path(s) from a person's request to a cross-workspace reader:`);
    for (const f of unexplained) {
      console.error(`  cross-workspace ${f.file}:${f.line} ${f.reader} in ${f.decl} ← ${f.root} (via ${f.via.join(" → ")})`);
    }
    console.error(
      "\n  Read the ONE workspace the request is in (withOrgDb / withOrgRls with the caller's workspace). A job that\n" +
        "  must see every workspace is a cron, a backfill or a deploy step (scripts/lib/cross-workspace-reach.mjs\n" +
        "  SYSTEM_ENTRIES), never a request.",
    );
    process.exitCode = 1;
  } else {
    console.log("  ✓ nothing else: every other request path reads one workspace");
  }
}

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
if (failed || process.exitCode === 1) process.exit(1);

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
