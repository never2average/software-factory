import { defineSandbox } from "eve/sandbox";

// The "inspection-intake" sandbox: its scripts use the Python standard library only, so the bootstrap only proves python3 is there
// and fails the template build loudly when it is not (a silent template fails every run far from the cause).
const CHECK_PYTHON = `set -u
command -v python3 >/dev/null 2>&1 || { echo "no python3 on PATH in this sandbox image" >&2; exit 1; }
python3 -c 'import json, csv, re, datetime' || { echo "python3 is missing its standard library" >&2; exit 1; }
`;

export default defineSandbox({
  async bootstrap({ use }) {
    const sandbox = await use();
    const check = await sandbox.run({ command: CHECK_PYTHON });
    if (check.exitCode !== 0) {
      throw new Error(`inspection-intake sandbox bootstrap: ${check.stderr.trim() || check.stdout.trim() || `exit ${check.exitCode}`}`);
    }
  },
});
