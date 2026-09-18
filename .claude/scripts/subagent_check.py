#!/usr/bin/env python3
"""subagent_check.py <mold_id> [key ...] [--json]

Runs a mold's own subagent workspace check (molds/<mold_id>/codebase/scripts/check-subagents.py) from the
factory. The check lives in the mold because a mold must carry everything needed to customise its agents
(.claude/skills/subagent/SKILL.md); this wrapper only finds it and passes the verdict through.
"""
import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    code = os.path.join(ROOT, "molds", a[0], "codebase"); chk = os.path.join(code, "scripts", "check-subagents.py")
    if not os.path.isdir(code): sys.exit(f"{a[0]}: no codebase at molds/{a[0]}/codebase")
    if not os.path.exists(chk):
        sys.exit(f"{a[0]}: this mold has no scripts/check-subagents.py, so its subagents cannot be held to the workspace "
                 f"standard. Snapshot molds (mold_v1) are not expected to have one; a forked mold must — copy it from "
                 f"molds/mold_fin/codebase/scripts/check-subagents.py with the mold's eve-* skills.")
    sys.exit(subprocess.run([sys.executable, chk, *a[1:]], cwd=code).returncode)
if __name__ == "__main__": main(sys.argv[1:])
