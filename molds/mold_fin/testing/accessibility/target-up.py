#!/usr/bin/env python3
"""Precondition probe for the accessibility lane: is there a page to grade?

  python3 molds/mold_fin/testing/accessibility/target-up.py <base_url> [path ...] [--expect REGEX ...]

Exit 0 only when every path answers 2xx AND every `--expect` marker is present in the body it served.
Anything else exits 1, which the runner reads as an unmet precondition and records the lane `skipped`
— the one honest verdict for a target that never rendered the application.

WHY THE MARKERS. HTTP 200 is not "the application is there". mold_fin applications share one Vercel
project, so a stale or colliding `production_url` answers 200 with somebody else's page; a deploy that
died on the client answers 200 with an error shell. Both used to satisfy this probe, and then every
criterion in the harness downstream was satisfied vacuously by a page with nothing on it — 0
violations, 0 targets, 0px of overflow — so the lane recorded `pass` against a deployment showing none
of the application. A marker the mold's own HTML always carries turns that into `skipped` with one
instruction, instead of green. `--expect` is a regex, matched case-insensitively against the decoded
body; markers live in `lane.json`, so a future mold changes its own declaration, never this probe.

The browser-side half of the same rule lives in the harness: a page that arrives with the markers and
then renders no interactive control is a `fail`, because at that point the application really is
broken rather than absent.
"""
import re, sys, urllib.error, urllib.request

def main(a):
    if not a: sys.exit(__doc__)
    want = [a[i + 1] for i, x in enumerate(a) if x == "--expect" and i + 1 < len(a)]
    rest, skip = [], False
    for x in a:
        if skip: skip = False; continue
        if x == "--expect": skip = True; continue
        rest.append(x)
    base = rest[0].rstrip("/")
    for path in (rest[1:] or ["/"]):
        try:
            r = urllib.request.urlopen(base + path, timeout=20)
            code, body = r.status, r.read(400000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            code, body = e.code, ""
        except Exception as e:
            print(f"{base}{path} is unreachable: {e}", file=sys.stderr); return 1
        if not 200 <= code < 300:
            print(f"{base}{path} answered HTTP {code}, so there is nothing to grade", file=sys.stderr); return 1
        missing = [m for m in want if not re.search(m, body, re.I)]
        if missing:
            print(f"{base}{path} answered HTTP {code} but the page it served is not this application: "
                  f"it is missing {', '.join(repr(m) for m in missing)}. Something else is serving this URL, "
                  f"or the deploy did not finish", file=sys.stderr)
            return 1
        print(f"{base}{path} {code}" + (f" · {len(want)} marker(s) present" if want else ""))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
