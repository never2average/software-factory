import { defineSandbox } from "eve/sandbox";

/**
 * Pre-install document-generation libraries into the sandbox template so agents
 * can ALWAYS produce real `.docx` / `.xlsx` / `.pptx` / `.pdf` files without a
 * flaky runtime `pip install` (and without "no packages installed, I'll hand-
 * craft it" fallbacks). `bootstrap` runs once when the template is built and the
 * snapshot carries into every later session; default egress is allow-all so the
 * install can reach PyPI.
 *
 * The install script is inlined rather than imported from `agent/lib/` on
 * purpose: eve derives the template key from THIS file's source hash, so an
 * imported helper could change without rotating the template and leave the
 * deployed snapshot silently stale.
 */
const INSTALL_DOC_LIBS = `set -u
PKGS="python-docx openpyxl python-pptx reportlab"
LOG=/tmp/eve-doc-libs.log
: > "$LOG"

if ! command -v python3 >/dev/null 2>&1; then
  echo "no python3 on PATH in this sandbox image" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" != "0" ] && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi

# The eve sandbox image ships pip; recover it rather than fail if a future image does not.
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

MISSING=$(python3 -c 'import importlib.util as u; print(" ".join(p for m, p in (("docx","python-docx"),("openpyxl","openpyxl"),("pptx","python-pptx"),("reportlab","reportlab")) if u.find_spec(m) is None))')
if [ -n "$MISSING" ]; then
  echo "missing after install: $MISSING" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
`;

export default defineSandbox({
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({ command: INSTALL_DOC_LIBS });
    // A swallowed install (the old `|| true` tail) produced a template that
    // LOOKED fine and then failed every document build with an import error far
    // from the cause. Fail the template build instead: eve reports this as
    // "Failed to prewarm Vercel sandbox template ..." with the pip output.
    if (result.exitCode !== 0) {
      throw new Error(
        `Sandbox bootstrap could not install the document libraries: ${
          result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
        }`,
      );
    }
  },
});
