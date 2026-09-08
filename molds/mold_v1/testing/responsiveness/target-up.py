#!/usr/bin/env python3
"""Precondition probe for the responsiveness lane: is there a rendered page to measure?

  python3 molds/mold_v1/testing/responsiveness/target-up.py <base_url> [path ...]

Exit 0 only when every path answers 2xx. Anything else exits 1, which the runner reads as an unmet
precondition and records the lane `skipped` — the one honest verdict for a target that never rendered.

This exists so that "the operator has not deployed the app yet" cannot be reported as a layout defect.
Without it a browser-side navigation timeout lands as `fail`, the lane reverts the application, and a
task gets filed against a layout nobody has looked at. It is deliberately a separate file from the
harness: the runner has to be able to decide `skipped` vs `fail` BEFORE launching a browser.

(The accessibility lane carries its own copy of this probe. The duplication is on purpose — a lane
folder is meant to be self-contained, so that copying it into a future mold brings everything it needs.)
"""
import sys, urllib.error, urllib.request

def main(a):
    if not a: sys.exit(__doc__)
    base = a[0].rstrip("/")
    for path in (a[1:] or ["/"]):
        try:
            code = urllib.request.urlopen(base + path, timeout=20).status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:
            print(f"{base}{path} is unreachable: {e}", file=sys.stderr); return 1
        if not 200 <= code < 300:
            print(f"{base}{path} answered HTTP {code}, so there is nothing to measure", file=sys.stderr); return 1
        print(f"{base}{path} {code}")
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
