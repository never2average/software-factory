/**
 * WHICH CROSS-WORKSPACE READERS CAN A PERSON'S REQUEST REACH? — the analysis behind check:tenancy's fifth surface.
 *
 * The principle: workspaces are not aware of each other. No code a person's request runs may list the workspaces or
 * read every workspace's scope. A cron, a backfill or a deploy step may.
 *
 * READERS (sinks): a call to `acrossOrgDbs`, `acrossOrgsRls` or `listWorkspaceIds`, a `.listOrgs()` call on any object
 * (the gate's workspace list), a `select … .from(orgs)` with no `.where(…)` (enumerating the workspace table), and an
 * `import(<expression>)` whose module cannot be known statically (it could load anything).
 *
 * ENTRY POINTS (roots) — what a person's request runs: every Next route handler (`app/**\/route.ts`), page and layout
 * (server components), `"use server"` module, the proxy (`proxy.ts` / `middleware.ts`); every agent model tool
 * (`agent/tools/**`, `agent/subagents/**`), channel (`agent/channels/**`), hook (`agent/hooks/**`), connection and
 * instruction module, and `agent/agent.ts`. NOT roots, each for a reason stated in SYSTEM_ENTRIES below: Vercel cron
 * routes, eve schedules, instrumentation, and everything under scripts/, setup/ and services/.
 *
 * FUNCTION-LEVEL, NOT FILE-LEVEL. Each top-level declaration is a node; an edge is a reference to another
 * declaration, resolved through imports (relative, `@/…`, `#…` package imports, re-exports, namespace imports, and
 * `await import(…)` with the members it uses). A module the request path imports may hold a system function that
 * sweeps, as long as nothing on the request path references it.
 *
 * CONDITIONAL READERS. `orgId ? withOrgDb(orgId, …) : acrossOrgDbs(…)` — and `if (orgId) return …` before one — sweeps
 * only when that parameter is missing. Such a reader is reached only through a call that leaves the argument out (or
 * passes `undefined` / `null`), or through a caller that forwards its OWN optional parameter there (which makes the
 * caller conditional in turn). A root is always called with its arguments, so a condition that survives to a root is
 * not a finding. Any non-call reference (a function passed as a value) is assumed to reach everything.
 *
 * Pure: `analyse({ root })` returns the findings; check-tenancy.mjs prints them and fails the run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

const SINK_CALLS = new Set(["acrossOrgDbs", "acrossOrgsRls", "listWorkspaceIds"]);
const SINK_METHODS = new Set(["listOrgs"]);

/**
 * Entry points that are NOT a person's request, and why. A root is anything under the ROOTS patterns that is not
 * matched here. Each reason is a claim about every file it covers.
 */
export const SYSTEM_ENTRIES = [
  // Only while the route actually checks CRON_SECRET: one that does not is callable by anyone, and is a root.
  [
    "app/api/cron/",
    "Vercel cron: called by the platform on a schedule, admitted only with CRON_SECRET, never by a person",
    (src) => /CRON_SECRET/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
  ],
  ["agent/schedules/", "eve schedules: fired by eve's scheduler as the app principal, never by a person"],
  ["agent/instrumentation.ts", "process start-up, not a request"],
];

/** A person's request runs these. */
const ROOT_PATTERNS = [
  (f) => /^app\/.*\/route\.(ts|tsx|js|mjs)$/.test(f),
  (f) => /^app\/(.*\/)?(page|layout|template|default|not-found|error|loading)\.(tsx|ts)$/.test(f),
  (f) => f === "proxy.ts" || f === "middleware.ts",
  (f) => /^agent\/(tools|subagents|channels|hooks|connections|instructions)\//.test(f),
  (f) => f === "agent/agent.ts" || f === "agent/instructions.ts" || f === "agent/sandbox.ts",
  // The local MCP server and CLI a person runs (setup/): every tool call is that person's request.
  (f) => /^setup\/[^/]+\.(mjs|js|ts)$/.test(f),
];

const EXTS = [".ts", ".tsx", ".mjs", ".js"];

function walk(root, dir, out) {
  const abs = nodePath.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = statSync(nodePath.join(root, rel));
    if (st.isDirectory()) walk(root, rel, out);
    else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

export async function analyse({ root = process.cwd() } = {}) {
  const { default: ts } = await import("typescript");
  const files = [...walk(root, "app", []), ...walk(root, "lib", []), ...walk(root, "agent", []), ...walk(root, "setup", [])];
  for (const f of ["proxy.ts", "middleware.ts"]) if (existsSync(nodePath.join(root, f))) files.push(f);
  const fileSet = new Set(files);
  let pkgImports = {};
  try {
    pkgImports = JSON.parse(readFileSync(nodePath.join(root, "package.json"), "utf8")).imports ?? {};
  } catch {
    /* no package.json: no # imports */
  }

  /* ---- module resolution ---- */
  const tryFile = (base) => {
    const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
    if (/\.(js|mjs)$/.test(base)) candidates.push(base.replace(/\.(m?js)$/, ".ts"), base.replace(/\.(m?js)$/, ".tsx"));
    return candidates.map((c) => nodePath.posix.normalize(c)).find((c) => fileSet.has(c)) ?? null;
  };
  const resolve = (from, spec) => {
    if (spec.startsWith("@/")) return tryFile(spec.slice(2));
    if (spec.startsWith("#")) {
      for (const [pattern, target] of Object.entries(pkgImports)) {
        const t = typeof target === "string" ? target : null;
        if (!t) continue;
        if (pattern.endsWith("*") && spec.startsWith(pattern.slice(0, -1))) {
          return tryFile(nodePath.posix.normalize(t.replace("*", spec.slice(pattern.length - 1)).replace(/^\.\//, "")));
        }
        if (pattern === spec) return tryFile(t.replace(/^\.\//, ""));
      }
      return null;
    }
    if (spec.startsWith(".")) return tryFile(nodePath.posix.join(nodePath.posix.dirname(from), spec));
    return null;
  };

  /* ---- per-file model ---- */
  const modules = new Map();
  const moduleOf = (file) => {
    if (modules.has(file)) return modules.get(file);
    const text = readFileSync(nodePath.join(root, file), "utf8");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const m = { file, sf, decls: new Map(), exports: new Map(), stars: [], imports: new Map(), useServer: false };
    modules.set(file, m);
    const first = sf.statements[0];
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server") m.useServer = true;
    const exported = (node) => node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (node) => node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword);
    const top = [];
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        if (st.importClause?.isTypeOnly) continue;
        const target = resolve(file, st.moduleSpecifier.text);
        if (!target) continue;
        const clause = st.importClause;
        if (!clause) continue;
        if (clause.name) m.imports.set(clause.name.text, { file: target, name: "default" });
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) m.imports.set(nb.name.text, { file: target, name: "*" });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            m.imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
          }
        }
        continue;
      }
      if (ts.isExportDeclaration(st)) {
        if (st.isTypeOnly) continue;
        const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolve(file, st.moduleSpecifier.text) : null;
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            const local = (el.propertyName ?? el.name).text;
            m.exports.set(el.name.text, target ? { file: target, name: local } : { local });
          }
        } else if (!st.exportClause && target) m.stars.push(target);
        continue;
      }
      if (ts.isFunctionDeclaration(st) && st.name) {
        m.decls.set(st.name.text, st);
        if (exported(st)) m.exports.set(isDefault(st) ? "default" : st.name.text, { local: st.name.text });
        continue;
      }
      if (ts.isFunctionDeclaration(st) && !st.name && isDefault(st)) {
        m.decls.set("default", st);
        m.exports.set("default", { local: "default" });
        continue;
      }
      if (ts.isClassDeclaration(st) && st.name) {
        m.decls.set(st.name.text, st);
        if (exported(st)) m.exports.set(isDefault(st) ? "default" : st.name.text, { local: st.name.text });
        continue;
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            m.decls.set(d.name.text, d);
            if (exported(st)) m.exports.set(d.name.text, { local: d.name.text });
          } else top.push(d);
        }
        continue;
      }
      if (ts.isExportAssignment(st)) {
        m.decls.set("default", st.expression);
        m.exports.set("default", { local: "default" });
        continue;
      }
      if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) continue;
      top.push(st);
    }
    if (top.length) m.decls.set("<module>", top);
    return m;
  };

  /** (file, exported name) → [file, local decl name] after following re-exports; null when unknown. */
  const exportTarget = (file, name, seen = new Set()) => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const m = moduleOf(file);
    const e = m.exports.get(name);
    if (e?.local !== undefined) return m.decls.has(e.local) ? [file, e.local] : null;
    if (e?.file) return exportTarget(e.file, e.name, seen);
    for (const star of m.stars) {
      const hit = exportTarget(star, name, seen);
      if (hit) return hit;
    }
    return null;
  };
  const allExports = (file) => {
    const m = moduleOf(file);
    const out = [];
    for (const name of new Set([...m.exports.keys(), ...m.decls.keys()])) {
      const t = name === "<module>" ? [file, name] : exportTarget(file, name) ?? (m.decls.has(name) ? [file, name] : null);
      if (t) out.push(t);
    }
    return out;
  };

  /* ---- per-declaration facts: sinks, edges ---- */
  const unwrap = (e) => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) e = e.expression;
    return e;
  };
  const isImportCall = (e) => e && ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword;
  const paramsOf = (node) => {
    let fn = node;
    if (ts.isVariableDeclaration(fn)) fn = fn.initializer ? unwrap(fn.initializer) : null;
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    return fn.parameters.map((p) => ({
      name: ts.isIdentifier(p.name) ? p.name.text : null,
      optional: Boolean(p.questionToken || p.initializer) || (p.type ? /\b(undefined|null)\b/.test(p.type.getText()) : false),
    }));
  };
  const facts = new Map();
  const factsOf = (file, name) => {
    const key = `${file}#${name}`;
    if (facts.has(key)) return facts.get(key);
    const m = moduleOf(file);
    const node = m.decls.get(name);
    const f = { key, file, name, sinks: [], calls: [], refs: [], params: Array.isArray(node) ? null : paramsOf(node) };
    facts.set(key, f);
    if (!node) return f;
    const params = f.params ?? [];
    const paramIndex = (id) => params.findIndex((p) => p.name === id);
    /** The parameter index a sink is conditional on, or -1. */
    const conditionalOn = (n) => {
      for (let cur = n, parent = n.parent; parent && cur !== node; cur = parent, parent = parent.parent) {
        if (ts.isConditionalExpression(parent) && cur === parent.whenFalse) {
          const c = unwrap(parent.condition);
          if (ts.isIdentifier(c) && paramIndex(c.text) > -1) return paramIndex(c.text);
        }
        if (ts.isIfStatement(parent) && cur === parent.elseStatement) {
          const c = unwrap(parent.expression);
          if (ts.isIdentifier(c) && paramIndex(c.text) > -1) return paramIndex(c.text);
        }
        if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
          // `if (orgId) return …;` earlier in the same block guards everything after it.
          for (const st of parent.statements) {
            if (st === cur) break;
            if (ts.isIfStatement(st) && !st.elseStatement) {
              const c = unwrap(st.expression);
              const exits = (s) => ts.isReturnStatement(s) || ts.isThrowStatement(s) || (ts.isBlock(s) && s.statements.some((x) => ts.isReturnStatement(x) || ts.isThrowStatement(x)));
              if (ts.isIdentifier(c) && paramIndex(c.text) > -1 && exits(st.thenStatement)) return paramIndex(c.text);
            }
          }
        }
      }
      return -1;
    };
    const lineOf = (n) => m.sf.getLineAndCharacterOfPosition(n.getStart(m.sf)).line + 1;
    /** Namespace-like locals: `import * as ns`, `const m = await import(…)`. name → file. */
    const namespaces = new Map();
    for (const [local, imp] of m.imports) if (imp.name === "*") namespaces.set(local, imp.file);
    const addRef = (target, n, call) => {
      if (!target) return;
      if (call) f.calls.push({ target, args: call.arguments, line: lineOf(n) });
      else f.refs.push({ target, line: lineOf(n) });
    };
    const resolveIdent = (id) => {
      if (m.decls.has(id) && id !== name) return [file, id];
      const imp = m.imports.get(id);
      if (imp && imp.name !== "*") return exportTarget(imp.file, imp.name) ?? null;
      return null;
    };
    const visit = (n) => {
      // Dynamic import bound to a name: `const m = await import("x")` / `const { a } = await import("x")`.
      if (ts.isVariableDeclaration(n) && n.initializer && isImportCall(unwrap(n.initializer))) {
        const call = unwrap(n.initializer);
        const target = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? resolve(file, call.arguments[0].text) : null;
        if (target) {
          if (ts.isIdentifier(n.name)) namespaces.set(n.name.text, target);
          else if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              const imported = (el.propertyName ?? el.name).getText(m.sf);
              addRef(exportTarget(target, imported), el, null);
            }
          }
        }
        return;
      }
      if (isImportCall(n) && !(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]))) {
        // `import(<expression>)` could load ANY module, a cross-workspace reader included: unknown, so reported.
        f.sinks.push({ line: lineOf(n), reader: "import(<unknown module>)", cond: -1 });
        return;
      }
      if (isImportCall(n)) {
        const target = n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? resolve(file, n.arguments[0].text) : null;
        if (target) {
          // `(await import("x")).fn(…)` names its member; anything else may use the whole module.
          let up = n.parent;
          while (up && (ts.isAwaitExpression(up) || ts.isParenthesizedExpression(up))) up = up.parent;
          if (up && ts.isPropertyAccessExpression(up)) {
            const call = ts.isCallExpression(up.parent) && up.parent.expression === up ? up.parent : null;
            addRef(exportTarget(target, up.name.text), up, call);
          } else for (const t of allExports(target)) addRef(t, n, null);
        }
        return;
      }
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        if (ts.isIdentifier(callee) && SINK_CALLS.has(callee.text) && !SINK_CALLS.has(name)) {
          f.sinks.push({ line: lineOf(n), reader: callee.text, cond: conditionalOn(n) });
        }
        if (ts.isPropertyAccessExpression(callee) && SINK_METHODS.has(callee.name.text)) {
          f.sinks.push({ line: lineOf(n), reader: `.${callee.name.text}()`, cond: conditionalOn(n) });
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "from" &&
          n.arguments.length === 1 &&
          ts.isIdentifier(n.arguments[0]) &&
          n.arguments[0].text === "orgs" &&
          !(ts.isPropertyAccessExpression(n.parent) && ["where", "innerJoin", "leftJoin"].includes(n.parent.name.text)) &&
          !SINK_CALLS.has(name)
        ) {
          f.sinks.push({ line: lineOf(n), reader: "select … from(orgs)", cond: conditionalOn(n) });
        }
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && namespaces.has(n.expression.text)) {
        const call = ts.isCallExpression(n.parent) && n.parent.expression === n ? n.parent : null;
        addRef(exportTarget(namespaces.get(n.expression.text), n.name.text), n, call);
        return;
      }
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isName =
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.name === n) ||
          ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) ||
          ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p);
        if (!isName) {
          if (namespaces.has(n.text) && m.imports.get(n.text)?.name === "*") {
            for (const t of allExports(namespaces.get(n.text))) addRef(t, n, null);
          } else {
            const target = resolveIdent(n.text);
            const call = ts.isCallExpression(p) && p.expression === n ? p : null;
            if (target) addRef(target, n, call);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    if (Array.isArray(node)) node.forEach(visit);
    else visit(node);
    return f;
  };

  /* ---- reachability: every (sink, condition) a declaration can reach ---- */
  const reachMemo = new Map();
  const inProgress = new Set();
  const isOmitted = (arg) => {
    if (!arg) return true;
    const a = unwrap(arg);
    return a.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(a) && a.text === "undefined") || ts.isVoidExpression(a);
  };
  /** → [{ sink: {file, line, reader, decl}, cond: -1 | param index of THIS decl, via: [keys] }] */
  const reach = (file, name) => {
    const key = `${file}#${name}`;
    if (reachMemo.has(key)) return reachMemo.get(key);
    if (inProgress.has(key)) return [];
    inProgress.add(key);
    const f = factsOf(file, name);
    const out = [];
    const seen = new Set();
    const add = (item) => {
      const k = `${item.sink.file}:${item.sink.line}:${item.cond}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(item);
    };
    for (const s of f.sinks) add({ sink: { file, line: s.line, reader: s.reader, decl: name }, cond: s.cond, via: [key] });
    for (const c of f.calls) {
      const [tf, tn] = c.target;
      for (const r of reach(tf, tn)) {
        if (r.cond === -1) add({ ...r, cond: -1, via: [key, ...r.via] });
        else {
          const arg = c.args[r.cond];
          if (isOmitted(arg)) add({ ...r, cond: -1, via: [key, ...r.via] });
          else {
            const a = unwrap(arg);
            const k = ts.isIdentifier(a) ? (f.params ?? []).findIndex((p) => p.name === a.text && p.optional) : -1;
            if (k > -1) add({ ...r, cond: k, via: [key, ...r.via] });
            // a named argument that is always present: the reader's own scope is used — no finding
          }
        }
      }
    }
    for (const ref of f.refs) {
      const [tf, tn] = ref.target;
      for (const r of reach(tf, tn)) add({ ...r, cond: -1, via: [key, ...r.via] });
    }
    inProgress.delete(key);
    reachMemo.set(key, out);
    return out;
  };

  /* ---- roots ---- */
  const system = (f) =>
    SYSTEM_ENTRIES.find(
      ([prefix, , holds]) =>
        (f === prefix || f.startsWith(prefix)) && (!holds || holds(readFileSync(nodePath.join(root, f), "utf8"))),
    );
  const roots = files.filter((f) => !system(f) && (ROOT_PATTERNS.some((p) => p(f)) || moduleOf(f).useServer));
  const findings = [];
  const seenFinding = new Set();
  for (const rootFile of roots) {
    // Everything the root file declares, and everything it exports — a re-export (`export { x as default } from …`)
    // is as much the entry point as a local declaration.
    const entries = new Map();
    for (const name of moduleOf(rootFile).decls.keys()) entries.set(`${rootFile}#${name}`, [rootFile, name]);
    for (const t of allExports(rootFile)) entries.set(`${t[0]}#${t[1]}`, t);
    for (const [entryFile, name] of entries.values()) {
      for (const r of reach(entryFile, name)) {
        if (r.cond !== -1) continue; // a root is always called with its arguments
        const k = `${rootFile}|${r.sink.file}:${r.sink.line}`;
        if (seenFinding.has(k)) continue;
        seenFinding.add(k);
        findings.push({ root: rootFile, ...r.sink, via: r.via });
      }
    }
  }
  findings.sort((a, b) => (a.file + a.line + a.root < b.file + b.line + b.root ? -1 : 1));
  return { findings, roots: roots.length, files: files.length };
}
