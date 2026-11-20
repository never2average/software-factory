#!/usr/bin/env python3
"""The blocks wiring check: each building block app/blocks.json names has every variable it reads set in this session
(by name, never a value) and read by the application's code. Prints one JSON object; exit 0 when every block is wired.
  python3 scripts/steps/wiring_check.py <app dir>"""
import json, os, re, sys

app = sys.argv[1]
blocks = json.load(open(os.path.join(app, "blocks.json")))["blocks"]
code = ""
for root, _dirs, files in os.walk(os.path.join(app, "src")):
    for f in sorted(files):
        code += open(os.path.join(root, f), encoding="utf-8").read() + "\n"
out = []
for b in blocks:
    unset = [n for n in b["env"] if not os.environ.get(n)]
    unread = [n for n in b.get("reads", b["env"]) if not re.search(r"\b%s\b" % re.escape(n), code)]
    out.append({"block": b["block"], "status": "wired" if not unset and not unread else "not_wired", "unset": unset, "unread": unread})
ok = all(x["status"] == "wired" for x in out)
print(json.dumps({"ok": ok, "blocks": out}, sort_keys=True))
sys.exit(0 if ok else 1)
