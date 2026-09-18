import "server-only";

import ts from "typescript";

/**
 * A workflow is authored as TypeScript (`<name>.workflow.ts`), but nothing
 * downstream speaks TypeScript: acorn (lib/workflow-validate.ts) parses JS, and
 * QuickJS (lib/workflow-runtime.ts) executes JS. A type annotation would be a
 * syntax error in both — so the types are erased here, once, before either sees
 * the script.
 *
 * This is erasure, not compilation: `transpileModule` never type-checks and
 * never resolves an import, so it cannot reach the filesystem or the network. It
 * is a pure string→string transform, and the security boundary remains exactly
 * where it was — the sandbox.
 *
 * The one thing to know: erasing a `type` or `interface` declaration DELETES its
 * lines, so a line number in the emitted JS can sit above the line the operator
 * typed. Diagnostics from the validator are reported against the emitted script,
 * which is what actually runs.
 */
export function stripTypes(source: string): { js: string; error: string | null } {
  try {
    const out = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        // Emit ES modules: turning this into CommonJS would inject `require`
        // and `exports`, which the validator forbids and the sandbox lacks.
        module: ts.ModuleKind.ESNext,
        removeComments: false,
        // No lib, no types, no resolution — nothing to read off disk.
        isolatedModules: true,
      },
      reportDiagnostics: true,
    });
    // Only SYNTAX errors matter here. There is no type-checking to fail: the
    // script's globals (agent, phase, parallel…) are injected by the sandbox and
    // have no declarations, so a type error is not a thing this can produce.
    const fatal = (out.diagnostics ?? []).find(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (fatal) {
      const line =
        fatal.file && fatal.start != null
          ? fatal.file.getLineAndCharacterOfPosition(fatal.start).line + 1
          : 1;
      return {
        js: out.outputText,
        error: `Line ${line}: ${ts.flattenDiagnosticMessageText(fatal.messageText, " ")}`,
      };
    }
    return { js: out.outputText, error: null };
  } catch (e) {
    return { js: "", error: e instanceof Error ? e.message : String(e) };
  }
}
