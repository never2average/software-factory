import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";
import { microsandboxSettings } from "#lib/sandbox-settings.js";

/**
 * WHERE THIS SANDBOX RUNS (agent/lib/sandbox-settings.ts). With `SANDBOX_BACKEND` unset or "vercel" this is null and
 * no `backend` is added below, so eve chooses as it always has: Vercel Sandbox on Vercel. With
 * `SANDBOX_BACKEND=microsandbox` (a deployment that is not on Vercel) it is a KVM microVM with `SANDBOX_CPUS`
 * (default 2), `SANDBOX_MEMORY_MIB` (default 1024) and a network policy that allows the internet and denies cloud
 * metadata, the private ranges, loopback and the Docker bridge. On a Vercel build the import above is a stub (eve's
 * hosted bundles prune the local backends) and is never called.
 */
const selfHosted = microsandboxSettings();

/**
 * Pre-install document libraries into the sandbox template so agents can ALWAYS
 * READ an uploaded `.pdf` and produce real `.docx` / `.xlsx` / `.pptx` / `.pdf`
 * files without a flaky runtime `pip install` (and without "no packages installed, I'll hand-
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
# reportlab WRITES a pdf; pdfplumber and pypdf READ one. Both readers are here because a
# person uploading a filing and asking a question of it is the commonest thing this product
# does, and the root agent had no way to open one: measured 2026-09-23, a real upload died on
# \`ModuleNotFoundError: No module named 'pdfplumber'\` then \`… 'PyPDF2'\`, and the turn ended
# with an empty model response because nothing was left to try. The specialists' own sandboxes
# already carry pdfplumber and pypdf; the main chat did not.
# pymupdf (imported as \`fitz\`) RENDERS a pdf page to an image. That is the only route into a
# SCANNED filing — and SEBI filings routinely are scans — because pdfplumber returns "" for a page
# with no text layer, and "" is indistinguishable from an empty page to everything downstream. The
# \`read_image\` tool runs its renderer in this sandbox and pip-installs pymupdf itself when it is
# absent (agent/lib/vision-tools.ts), so this line is not what makes the feature work: it is what
# keeps a ~30 s wheel download out of the middle of a person's turn on every cold sandbox. pdf2image
# was the alternative and needs poppler, an apt package — a wheel installs where an apt-get needs a
# root this sandbox may not have.
PKGS="python-docx openpyxl python-pptx reportlab pdfplumber pypdf pymupdf"
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

MISSING=$(python3 -c 'import importlib.util as u; print(" ".join(p for m, p in (("docx","python-docx"),("openpyxl","openpyxl"),("pptx","python-pptx"),("reportlab","reportlab"),("pdfplumber","pdfplumber"),("pypdf","pypdf"),("fitz","pymupdf")) if u.find_spec(m) is None))')
if [ -n "$MISSING" ]; then
  echo "missing after install: $MISSING" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
`;

export default defineSandbox({
  ...(selfHosted ? { backend: microsandbox(selfHosted) } : {}),
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
