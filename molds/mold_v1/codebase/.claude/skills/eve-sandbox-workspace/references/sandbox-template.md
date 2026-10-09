# `sandbox/sandbox.ts` skeleton

Derived from the install block of `agent/subagents/research/sandbox.ts` (a legacy top-level
`sandbox.ts`; the pattern is right, the location is not). Save as
`agent/subagents/<key>/sandbox/sandbox.ts`. Change three things: `PKGS`, the
`(import name, pip name)` pairs in the `MISSING` line, and the subagent name in the error.

```ts
import { defineSandbox } from "eve/sandbox";

// Kept inline (not imported from agent/lib/) because eve derives the template key from THIS
// file's source hash plus the seeded workspace: an imported helper could change without
// rotating the template, leaving the deployed snapshot silently stale.
const INSTALL_PARSERS = `set -u
PKGS="pdfplumber pypdf openpyxl"
LOG=/tmp/eve-parsers.log
: > "$LOG"

if ! command -v python3 >/dev/null 2>&1; then
  echo "no python3 on PATH in this sandbox image" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" != "0" ] && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi

if ! $SUDO python3 -m pip --version >>"$LOG" 2>&1; then
  $SUDO python3 -m ensurepip --upgrade >>"$LOG" 2>&1 \\
    || $SUDO apt-get install -y python3-pip >>"$LOG" 2>&1 \\
    || $SUDO dnf install -y python3-pip >>"$LOG" 2>&1 \\
    || true
fi

$SUDO python3 -m pip install --quiet --break-system-packages $PKGS >>"$LOG" 2>&1 \\
  || $SUDO python3 -m pip install --quiet $PKGS >>"$LOG" 2>&1 \\
  || python3 -m pip install --quiet --user $PKGS >>"$LOG" 2>&1 \\
  || true

# (import name, pip name): they differ for some packages (pptx / python-pptx, docx / python-docx).
MISSING=$(python3 -c 'import importlib.util as u; print(" ".join(p for m, p in (("pdfplumber","pdfplumber"),("pypdf","pypdf"),("openpyxl","openpyxl")) if u.find_spec(m) is None))')
if [ -n "$MISSING" ]; then
  echo "missing after install: $MISSING" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
`;

export default defineSandbox({
  async bootstrap({ use }) {
    const sandbox = await use();
    const install = await sandbox.run({ command: INSTALL_PARSERS });
    // A swallowed install produces a template that LOOKS fine and then fails every run with
    // an import error far from the cause. Fail the template build instead, with pip's output.
    if (install.exitCode !== 0) {
      throw new Error(
        `<key> sandbox bootstrap could not install its parsers: ${
          install.stderr.trim() || install.stdout.trim() || `exit ${install.exitCode}`
        }`,
      );
    }
  },
});
```

Nothing here copies the scripts: eve mirrors `sandbox/workspace/**` into `/workspace`
because the folder layout is used. Confirm the `defineSandbox` surface against
`node_modules/eve/docs/sandbox.mdx` after an eve upgrade.
