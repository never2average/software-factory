#!/usr/bin/env python3
"""Does "Continue with Google" lead somewhere on the DEPLOYED app? One line, and exit 0 or 1.

  python3 molds/mold_v1/testing/functional/signin-google.py <base_url>
  python3 molds/mold_v1/testing/functional/signin-google.py --self-test      offline

WHAT IT USED TO CHECK, AND WHY THAT WAS NOT ENOUGH. It read the served scripts for a Google web client id: the page
prints "Google sign-in is not configured" when there is none. But a client id is there whether the button works or
not. Google signs people in only at an address written by hand on the OAuth client's page in Google Cloud Console,
so an app minted at a new address with a reused client passed this check with a button that led to Google's error
page ("redirect_uri_mismatch").

WHAT IT CHECKS NOW, with public GETs only (the page, its scripts, the app's own answer, Google's sign-in address):
  1. the served scripts carry a client id (as before; none is a fail);
  2. Google is asked whether it lists this address for that client: GET accounts.google.com/o/oauth2/v2/auth with
     redirect_uri=<the address> answers a redirect to its sign-in pages when it does, and to its error page naming
     redirect_uri_mismatch when it does not (measured 2026-10-13; anything else is "could not be checked");
  3. the app is asked what its sign-in page shows: /api/auth/google/availability says direct, hub or none (a build
     older than the mold's sign-in hub has no such answer).

  pass  works directly                    Google lists the address
  pass  works through the hub             the app says hub, and its hub says it answers for this address
  pass  NOT available here, no dead button  Google does not list it and the page shows only the emailed-code sign-in:
                                          a person can sign in, and nothing on the page leads to an error. The line
                                          says so in capitals and names the command that turns Google sign-in on.
  pass  NOT WORKING, build older than the fix   the page still shows a button that leads to Google's error page, and
                                          no deploy of this build can change that; reported loudly, not failed,
                                          because the lane grades what a deploy can fix.
  pass  could not be checked              Google's answer was not understood (never read as broken)
  FAIL  no client id; or the page shows a Google button (it says direct or hub) that does not work.

The client id is public (it ships to every browser); this script still prints only a count. Standard library only.
"""
import base64, json, re, sys, urllib.error, urllib.parse, urllib.request

BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
ID = re.compile(r"[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def real_http(url, headers=None, timeout=30):
    """(status, {lower-case header: value}, body). Redirects are not followed. Status 0 = nothing answered."""
    req = urllib.request.Request(url, headers=headers or {"user-agent": "factory-lane"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(4_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, ""
    except Exception:
        return 0, {}, ""


def redirect_list(client_id, origin, http):
    """listed | unlisted | unknown: does Google list `origin` as a redirect address of this client?"""
    q = urllib.parse.urlencode({"client_id": client_id, "redirect_uri": origin, "response_type": "id_token",
                                "scope": "openid email profile", "nonce": "address-check"})
    st, h, _ = http("https://accounts.google.com/o/oauth2/v2/auth?" + q, {"user-agent": BROWSER_UA})
    if not 300 <= st <= 399: return "unknown"
    to = urllib.parse.urlsplit(urllib.parse.urljoin("https://accounts.google.com", h.get("location") or ""))
    if to.hostname != "accounts.google.com": return "unknown"
    err = urllib.parse.parse_qs(to.query).get("authError")
    if err or "/error" in to.path:
        try: text = base64.urlsafe_b64decode((err or [""])[0] + "=" * (-len((err or [""])[0]) % 4))
        except Exception: text = b""
        return "unlisted" if b"redirect_uri_mismatch" in text else "unknown"
    return "listed" if re.match(r"^/(v\d+/signin|signin|o/oauth2|ServiceLogin|AccountChooser|InteractiveLogin)", to.path) else "unknown"


def _json(url, http):
    st, _, body = http(url, {"accept": "application/json", "user-agent": "factory-lane"})
    if st != 200: return None
    try: d = json.loads(body)
    except ValueError: return None
    return d if isinstance(d, dict) else None


def grade(base, http=real_http):
    """(passed, the one line)."""
    base = base.rstrip("/")
    st, _, html = http(base + "/", None)
    chunks = sorted(set(re.findall(r"/_next/static/[^\"'\\ ]+\.js", html))) if st == 200 else []
    if not chunks: return False, f"signin.google: fail — {base}/ served no Next.js chunks; is this the app?"
    cid = None
    for c in chunks[:80]:
        st, _, js = http(base + c, None)
        m = ID.search(js) if st == 200 else None
        if m: cid = m.group(0); break
    if not cid:
        return False, (f"signin.google: fail — no Google web client id in {len(chunks)} served chunk(s); the sign-in page will say "
                       f"'Google sign-in is not configured'. Set it and rebuild: python3 .claude/scripts/provision.py <app_id> --set-secret GOOGLE_CLIENT_ID, then --deploy")
    u = urllib.parse.urlsplit(base); origin = f"{u.scheme}://{u.netloc}"
    listed = redirect_list(cid, origin, http)
    says = _json(origin + "/api/auth/google/availability", http)
    shows = (says or {}).get("google")
    how = "python3 .claude/scripts/provision.py <app_id> --google-signin (it says what to do, step by step)"
    if listed == "listed":
        return True, f"signin.google: pass — works directly: Google lists {origin} for the client in the served scripts"
    if shows == "hub":
        hub = str(says.get("hub") or "")
        status = _json(f"{hub}/api/auth/google-hub/status?" + urllib.parse.urlencode({"return": origin}), http) if hub.startswith("https://") else None
        if status and status.get("hub") is True and status.get("allowed") is True and status.get("ready") is not False:
            hub_listed = redirect_list(cid, hub, http)
            if hub_listed != "unlisted":
                return True, f"signin.google: pass — works through the hub {hub}: it answers for {origin}" + ("" if hub_listed == "listed" else " (Google could not be asked about the hub itself)")
        return False, (f"signin.google: fail — the page shows a Google button that goes through {hub or 'a hub'}, and that hub does not answer for {origin}. "
                       f"See: {how}")
    if listed == "unlisted":
        if shows == "none":
            return True, (f"signin.google: pass — Google sign-in is NOT AVAILABLE at {origin} (Google does not list this address) and the page shows no Google "
                          f"button, only the emailed-code sign-in, so nothing on it leads to an error. To turn Google sign-in on: {how}")
        if says is None:
            return True, (f"signin.google: pass — WARNING: Google sign-in is NOT WORKING at {origin}: Google does not list this address, and this build "
                          f"(older than the mold's fix) still shows a button that leads to Google's error page. Not failed, because no deploy of this "
                          f"build changes it. To fix it now: {how}")
        return False, (f"signin.google: fail — the page shows a Google button ({shows}) and Google does not list {origin}: the button leads to Google's "
                       f"error page (redirect_uri_mismatch). See: {how}")
    return True, f"signin.google: pass — could not be checked: Google's answer about {origin} was not understood (a client id is in the served scripts)"


def self_test():
    n = [0]
    def ok(c, what, detail=""):
        assert c, f"{what}: {detail}" if detail else what
        n[0] += 1; print(f"  ok   {what}")
    CID = "123456789012-" + "a" * 32 + ".apps.googleusercontent.com"
    APP, HUB = "https://new-app.example", "https://hub-app.example"
    mismatch = base64.urlsafe_b64encode(b"\n\x15redirect_uri_mismatch\x12\x04nope").decode().rstrip("=")
    def world(listed=(), says=None, hub=None, cid=CID, google="up"):
        def http(url, headers=None, timeout=30):
            u = urllib.parse.urlsplit(url); q = urllib.parse.parse_qs(u.query); base = f"{u.scheme}://{u.netloc}"
            if u.netloc == "accounts.google.com":
                if google != "up": return (0, {}, "") if google == "down" else (200, {}, "<html>new</html>")
                good = q["redirect_uri"][0] in listed
                return 302, {"location": "https://accounts.google.com/v3/signin/identifier" if good else f"https://accounts.google.com/signin/oauth/error?authError={mismatch}"}, ""
            if base == APP:
                if u.path == "/": return 200, {}, '<script src="/_next/static/chunks/a.js"></script>'
                if u.path.startswith("/_next/"): return 200, {}, f'x="{cid}"' if cid else "x"
                if u.path == "/api/auth/google/availability": return (200, {}, json.dumps(says)) if says else (404, {}, "")
            if base == HUB and u.path == "/api/auth/google-hub/status" and hub:
                return 200, {}, json.dumps(dict(hub, allowed=q["return"][0] in hub.get("answers", [])))
            return 404, {}, ""
        return http
    p, line = grade(APP, world(listed=[APP]))
    ok(p and "works directly" in line and CID not in line, "an address Google lists passes, and the client id is not printed", line)
    p, line = grade(APP, world(cid=None))
    ok(not p and "no Google web client id" in line, "no client id in the served scripts fails, as before")
    p, line = grade(APP, world(listed=[HUB], says={"google": "hub", "hub": HUB}, hub={"hub": True, "ready": True, "answers": [APP]}))
    ok(p and "works through the hub" in line, "through a hub that answers for this address passes", line)
    p, line = grade(APP, world(listed=[HUB], says={"google": "hub", "hub": HUB}, hub={"hub": True, "ready": True, "answers": []}))
    ok(not p and "does not answer for" in line, "a Google button through a hub that does not answer for this address FAILS", line)
    p, line = grade(APP, world(says={"google": "hub", "hub": HUB}, hub={"hub": True, "ready": True, "answers": [APP]}))
    ok(not p, "…and so does a hub Google does not list")
    p, line = grade(APP, world(says={"google": "direct", "reason": "unverified"}))
    ok(not p and "redirect_uri_mismatch" in line, "a Google button on an address Google does not list FAILS", line)
    p, line = grade(APP, world(says={"google": "none", "reason": "unlisted"}))
    ok(p and "NOT AVAILABLE" in line and "no Google button" in line and "--google-signin" in line, "no dead button: unlisted with only the emailed code shown passes, and says so loudly", line)
    p, line = grade(APP, world())
    ok(p and "WARNING" in line and "NOT WORKING" in line and "older than the mold's fix" in line, "a build older than the fix is reported loudly, not failed", line)
    for g in ("down", "changed"):
        p, line = grade(APP, world(google=g, says={"google": "direct"}))
        ok(p and "could not be checked" in line, f"Google's answer not understood ({g}) is never read as broken", line)
    p, line = grade("https://nothing.example", world())
    ok(not p and "no Next.js chunks" in line, "an address that is not the app fails")
    print(f"signin-google --self-test: {n[0]} checks passed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: sys.exit(self_test())
    if len(sys.argv) < 2: sys.exit(__doc__)
    passed, line = grade(sys.argv[1])
    print(line)
    sys.exit(0 if passed else 1)
