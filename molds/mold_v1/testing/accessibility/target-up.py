#!/usr/bin/env python3
"""Precondition probe for the accessibility lane: is there a page to grade?

  python3 molds/mold_v1/testing/accessibility/target-up.py <base_url> [path ...]

Exit 0 only when every path answers 2xx. Anything else exits 1, which the runner reads as an unmet
precondition and records the lane as `skipped` — the one honest verdict for a target that never
rendered. Without this probe a browser-side timeout would land as `fail`, blaming the application for
the operator not having deployed it yet.
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
            print(f"{base}{path} answered HTTP {code}, so there is nothing to grade", file=sys.stderr); return 1
        print(f"{base}{path} {code}")
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
