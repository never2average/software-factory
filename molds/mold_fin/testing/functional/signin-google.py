#!/usr/bin/env python3
"""Is Google sign-in configured on the DEPLOYED app? Exit 0 with one line when the served browser bundle
carries a Google web client id; exit 1 when it does not.

  python3 molds/mold_fin/testing/functional/signin-google.py <base_url>

WHY THE BUNDLE AND NOT THE PAGE. The sign-in page prints "Google sign-in is not configured
(NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset)" from the browser, after hydration, when the id compiled into the
bundle is empty. The server HTML never contains that sentence either way, so grepping the page for it —
the first version of this check — could never fail. The condition the sentence reports is "no client id
in the bundle", and that is observable: NEXT_PUBLIC_ values are baked into the chunks at build.
The id is public by construction (it ships to every browser); this script still prints only a count.
"""
import re, sys, urllib.request

def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": "factory-lane"}), timeout=30) as r:
        return r.read().decode("utf-8", "replace")

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else sys.exit(__doc__)
ID = re.compile(r"[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com")
html = get(base + "/")
chunks = sorted(set(re.findall(r"/_next/static/chunks/[^\"']+\.js", html)))
if not chunks: print(f"signin.google: fail — {base}/ served no Next.js chunks; is this the app?"); sys.exit(1)
seen = 0
for c in chunks[:60]:
    try: seen += len(set(ID.findall(get(base + c))))
    except Exception: continue
    if seen: break
if seen: print(f"signin.google: pass — the served bundle carries a Google web client id ({len(chunks)} chunk(s) scanned)"); sys.exit(0)
print(f"signin.google: fail — no Google web client id in {len(chunks)} served chunk(s); the sign-in page will say "
      f"'Google sign-in is not configured'. Set it and rebuild: python3 .claude/scripts/provision.py <app_id> --set-secret GOOGLE_CLIENT_ID, then --deploy"); sys.exit(1)
