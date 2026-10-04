import { defineSandbox } from "eve/sandbox";

// This subagent parses filings (PDF, XLSX, PPTX) and builds Excel output, so its sandbox needs the
// document libraries pre-installed (declared subagents get their own sandbox,
// they do not inherit the root's).
// Minimal, deterministic Excel formatting applied to every built workbook so
// its workbooks don't ship as bare grids: bold + shaded
// header row, frozen header, and content-fit column widths. Run as
// `python3 /root/fmt_xlsx.py <file.xlsx> [...]` after building.
const FMT_XLSX = `import sys
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

def fmt(path):
    wb = load_workbook(path)
    fill = PatternFill("solid", fgColor="EEF1F5")
    bold = Font(bold=True)
    for ws in wb.worksheets:
        if ws.max_row < 1:
            continue
        for cell in ws[1]:
            cell.font = bold
            cell.fill = fill
            cell.alignment = Alignment(vertical="center", wrap_text=False)
        ws.freeze_panes = "A2"
        for col in range(1, ws.max_column + 1):
            letter = get_column_letter(col)
            width = 10
            for row in range(1, min(ws.max_row, 200) + 1):
                v = ws.cell(row=row, column=col).value
                if v is not None:
                    width = max(width, min(len(str(v)) + 2, 60))
            ws.column_dimensions[letter].width = width
    wb.save(path)

if __name__ == "__main__":
    for p in sys.argv[1:]:
        fmt(p)
        print("formatted", p)
`;

// Kept inline (not imported from agent/lib/) because eve derives the template
// key from THIS file's source hash: a helper module could change without
// rotating the template, leaving the deployed snapshot silently stale.
const INSTALL_DOC_LIBS = `set -u
PKGS="openpyxl pdfplumber pypdf python-pptx"
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

MISSING=$(python3 -c 'import importlib.util as u; print(" ".join(p for m, p in (("openpyxl","openpyxl"),("pdfplumber","pdfplumber"),("pypdf","pypdf"),("pptx","python-pptx")) if u.find_spec(m) is None))')
if [ -n "$MISSING" ]; then
  echo "missing after install: $MISSING" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
`;

export default defineSandbox({
  async bootstrap({ use }) {
    const sandbox = await use();
    const install = await sandbox.run({ command: INSTALL_DOC_LIBS });
    // A swallowed install produced a template that LOOKED fine and then failed
    // every workbook build with an import error far from the cause. Fail the
    // template build instead, carrying pip's own output.
    if (install.exitCode !== 0) {
      throw new Error(
        `investor-presentations sandbox bootstrap could not install the document libraries: ${
          install.stderr.trim() || install.stdout.trim() || `exit ${install.exitCode}`
        }`,
      );
    }
    // Ship the minimal formatter into the container so every workbook can be
    // styled with one call after it's built.
    const formatter = await sandbox.run({
      // Vercel Sandbox runs this as root. A self-hosted microsandbox runs it as `vercel-sandbox`, which cannot
      // write under /root: there it goes through sudo, and /root is made readable so the same
      // `python3 /root/fmt_xlsx.py` the prompts name works on both (first real server, 2026-10-04).
      command: `if [ "$(id -u)" != 0 ]; then sudo -n mkdir -p /root && sudo -n chmod 755 /root; fi && { if [ "$(id -u)" = 0 ]; then cat > /root/fmt_xlsx.py; else sudo -n tee /root/fmt_xlsx.py >/dev/null; fi; } <<'FMTEOF'\n${FMT_XLSX}FMTEOF`,
    });
    if (formatter.exitCode !== 0) {
      throw new Error(
        `investor-presentations sandbox bootstrap could not write /root/fmt_xlsx.py: ${
          formatter.stderr.trim() || `exit ${formatter.exitCode}`
        }`,
      );
    }
  },
});
