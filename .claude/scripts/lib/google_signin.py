#!/usr/bin/env python3
"""Does "Continue with Google" work on a deployed app? Checked after every deploy, and the sign-in hub's settings.

  google_signin.py <app_id> [--json]     the check on its own, against what serves now (reads only; records nothing)
  google_signin.py --self-test           offline, against a Google and two apps made in the test

WHY. Google signs people in only at an address written BY HAND on the OAuth client's page in Google Cloud Console
("Authorised redirect URIs" for the button, "Authorised JavaScript origins" for One Tap). There is no API for adding
one. The factory reuses one client across an operator's apps (mint.py reuse-keys), so every newly minted app came up
with a Google button that led to Google's error page, and the only check (functional lane, signin.google) looked for
a client id in the page's scripts, which is there whether the button works or not.

THE THREE RESULTS (check(), recorded in infrastructure.json under google_sign_in.check by provision.py):
  direct        Google lists this app's address: the button signs in here.
  hub           Google does not, but the app signs in through another app Google does list (the mold's sign-in hub):
                the hub is set on this app, the hub answers for this address, Google lists the hub, one client on both.
  not_working   neither. `next` then says exactly what to do, the two ways, click by click.
  unknown       Google (or the app) could not be asked or its answer was not understood. Never read as broken.

HOW GOOGLE IS ASKED (measured 2026-10-13 with one client, a listed and three unlisted addresses; the same two
questions the mold's own lib/google-origin-probe.ts asks):
  redirect list   GET https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=<origin>&response_type=id_token…
                  answers 302 to Google's sign-in pages when listed, 302 to /signin/oauth/error?authError=<base64
                  naming redirect_uri_mismatch> when not.
  origins list    GET https://accounts.google.com/gsi/status?client_id=… with `Origin: <origin>` and a browser's
                  User-Agent answers 200 when listed, 403 with error code 5 when not (code 9 = not a browser's
                  User-Agent, code 3 = no such client: both "unknown").
Neither is a documented contract, so anything else is "unknown", and "unknown" never fails or warns as broken.

A REGRESSION IS A FAILURE. An app whose last recorded result was direct or hub and is now not_working: record()
says `regressed`, and provision.py ends that deploy or --smoke with exit 1. A first not_working is a warning.

THE HUB'S SETTINGS (state only; nothing here deploys or touches a running app):
  infrastructure.json google_sign_in.hub          {origin, app_id}: this app signs in through that one
  infrastructure.json google_sign_in.answers_for  [{origin, name, app_id}]: this app is the hub for those
env_pairs() turns them into AUTH_GOOGLE_HUB_ORIGIN / AUTH_GOOGLE_HUB_ALLOWED_RETURNS, written on the app's NEXT
deploy (provision.py for Vercel, lib/vm_remote.py for a server), and only for a mold that reads them
(lib/google-hub.ts in its codebase). So a change to a live app's settings waits for whoever deploys it next.

The client id is public (it is in every page's scripts) but is never printed: a fingerprint is. Standard library only.
"""
import base64, datetime, hashlib, json, os, re, sys, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import services  # noqa: E402
import lane_url  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
CLIENT_ID = re.compile(r"[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com")
MOLD_READS = "lib/google-hub.ts"          # a mold that has this takes the hub's two settings from its environment
HUB_ENV, RETURNS_ENV = "AUTH_GOOGLE_HUB_ORIGIN", "AUTH_GOOGLE_HUB_ALLOWED_RETURNS"
WORKING = ("direct", "hub")
CONSOLE = "https://console.cloud.google.com/apis/credentials"


def _now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def fingerprint(client_id):
    """The mold's own fingerprint of a client id (lib/google-hub.ts clientFingerprint): 12 hex of its SHA-256."""
    return hashlib.sha256(client_id.strip().encode()).hexdigest()[:12] if client_id else None


def origin_of(url):
    """`https://host[:port]` of an address, or "" when it is not an http(s) one."""
    try: u = urllib.parse.urlsplit((url or "").strip())
    except ValueError: return ""
    return f"{u.scheme}://{u.netloc}" if u.scheme in ("http", "https") and u.netloc else ""


def exact_https_origin(text):
    """The mold's rule for a hub or a return (lib/google-hub.ts exactOrigin): https, a host, nothing else."""
    t = (text or "").strip()
    if not t or "*" in t or "@" in t: return None
    try: u = urllib.parse.urlsplit(t)
    except ValueError: return None
    if u.scheme != "https" or not u.hostname or u.path or u.query or u.fragment: return None
    if t != t.lower() or t.endswith(":443"): return None
    return t


# ---- HTTP: one function, so the self-test (and a rehearsal) never reaches the network ---------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def real_http(url, headers=None, timeout=20):
    """(status, {lower-case header: value}, body text). Redirects are not followed. Status 0 = nothing answered."""
    req = urllib.request.Request(url, headers=headers or {"user-agent": "factory-google-signin"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(4_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try: body = e.read(200_000).decode("utf-8", "replace")
        except Exception: body = ""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body
    except Exception:
        return 0, {}, ""


def probe_redirect(client_id, origin, http):
    q = urllib.parse.urlencode({"client_id": client_id, "redirect_uri": origin, "response_type": "id_token",
                                "scope": "openid email profile", "nonce": "address-check"})
    st, h, _ = http("https://accounts.google.com/o/oauth2/v2/auth?" + q, {"user-agent": BROWSER_UA})
    if not 300 <= st <= 399: return "unknown"
    try: to = urllib.parse.urlsplit(urllib.parse.urljoin("https://accounts.google.com", h.get("location") or ""))
    except ValueError: return "unknown"
    if to.hostname != "accounts.google.com": return "unknown"
    err = urllib.parse.parse_qs(to.query).get("authError")
    if err or "/error" in to.path:
        try: text = base64.urlsafe_b64decode((err or [""])[0] + "=" * (-len((err or [""])[0]) % 4))
        except Exception: text = b""
        return "unlisted" if b"redirect_uri_mismatch" in text else "unknown"
    return "listed" if re.match(r"^/(v\d+/signin|signin|o/oauth2|ServiceLogin|AccountChooser|InteractiveLogin)", to.path) else "unknown"


def probe_origin(client_id, origin, http):
    st, _, body = http("https://accounts.google.com/gsi/status?" + urllib.parse.urlencode({"client_id": client_id}),
                       {"origin": origin, "user-agent": BROWSER_UA})
    if st == 200: return "listed"
    if st != 403: return "unknown"
    m = re.search(r"\],\s*\[(\d+)\]\s*\]\s*$", (body or "").strip()[:400])
    return "unlisted" if m and m.group(1) == "5" else "unknown"


def listed(client_id, origin, http):
    return {"redirect": probe_redirect(client_id, origin, http), "origin": probe_origin(client_id, origin, http)}


def client_in_bundle(base, http):
    """The Google web client id the served page's scripts carry, or None. Never printed by anything here."""
    st, _, html = http(base + "/", None)
    if st != 200: return None
    for c in sorted(set(re.findall(r"/_next/static/[^\"'\\ ]+\.js", html)))[:80]:
        st, _, js = http(base + c, None)
        m = CLIENT_ID.search(js) if st == 200 else None
        if m: return m.group(0)
    return None


def _json(url, http):
    st, _, body = http(url, {"accept": "application/json", "user-agent": "factory-google-signin"})
    if st != 200: return None
    try: d = json.loads(body)
    except ValueError: return None
    return d if isinstance(d, dict) else None


# ---- what to tell the operator: the two ways, click by click (AGENTS.md "Asking the operator for something") -----------

def how_to_fix(app_id, origin, hub_app=None, project_number=None):
    """The steps, as lines. `hub_app`: an app whose Google sign-in works with the same client, when the factory
    knows one; the first way is offered only then."""
    out = [f"Google sign-in does not work at {origin} yet, because Google has not been told about this address. "
           f"People can still sign in with a code sent to their email. " + ("There are two ways to fix it; pick one." if hub_app else "To fix it:"), ""]
    if hub_app:
        out += [f"A. Let {hub_app} do the Google part for this app (one command, about a minute; nothing to open in a browser)",
                "   1. Run this in the factory folder:",
                f"        python3 .claude/scripts/provision.py {app_id} --google-hub {hub_app}",
                "   2. It names the two apps to deploy next. Nothing changes for anyone until those deploys.", ""]
    pick = f"pick the project numbered {project_number}" if project_number else "pick the project the app's login belongs to (if you see only one, that is it)"
    out += [("B. " if hub_app else "") + "Add this address in Google Cloud Console (about three minutes)",
            f"   1. Open {CONSOLE} and sign in with the Google account that owns the app's login.",
            f"   2. At the top of the page, {pick}.",
            "   3. Under \"OAuth 2.0 Client IDs\", click the entry whose type is \"Web application\".",
            "   4. Under \"Authorised JavaScript origins\", click \"Add URI\" and paste this, with no slash at the end:",
            f"        {origin}",
            "   5. Under \"Authorised redirect URIs\", click \"Add URI\" and paste the same address again:",
            f"        {origin}",
            "   6. Click \"Save\" at the bottom. Google can take up to five minutes to apply it.",
            "   7. Check it worked (this only reads, it changes nothing):",
            f"        python3 .claude/scripts/provision.py {app_id} --google-signin", "",
            "Nothing secret is involved: the address is public, and no password or key is typed anywhere."]
    return out


# ---- the check -----------------------------------------------------------------------------------------------------------

def app_address(infra): return origin_of(lane_url.target_url(infra or {}))


def deploy_line(app_id, infra=None, state_dir=None):
    """The command that deploys this app, by where it runs (a server of its own deploys with --deploy-remote)."""
    if infra is None:
        try: infra = json.load(open(os.path.join(state_dir or os.path.join(ROOT, "state", "application"), app_id, "infrastructure.json")))
        except (OSError, ValueError): infra = {}
    return f"python3 .claude/scripts/provision.py {app_id} " + ("--deploy-remote" if (infra or {}).get("target") == "vm_remote" else "--deploy")


def check(app_id, infra, http=None, hub_candidate=None):
    """One reading of what serves now. -> {result, detail, address, at, listed, hub?, app_says?, next: [lines]}.
    Reads only: a few public GETs to the app, to its hub and to Google. Sends no credential and no person's data."""
    res = {"result": "unknown", "detail": "", "address": app_address(infra), "at": _now(), "next": []}
    def done(result, detail, **more):
        res.update(result=result, detail=detail, **more); return res
    if services.REHEARSAL and http is None:
        # A rehearsal asks nobody. Its script may say what the reading is (FACTORY_GOOGLE_SIGNIN, a JSON object with
        # `result`): how provision.py's self-test drives a warning, a recovery and a regression through a real
        # deploy and --smoke. Read ONLY in a rehearsal.
        try: scripted = json.loads(os.environ.get("FACTORY_GOOGLE_SIGNIN") or "null")
        except ValueError: scripted = None
        if isinstance(scripted, dict) and scripted.get("result") in WORKING + ("not_working", "unknown"):
            fixes = how_to_fix(app_id, res["address"] or "this app's address", hub_candidate) if scripted["result"] == "not_working" else []
            return done(scripted["result"], scripted.get("detail") or "scripted by the rehearsal", next=fixes)
        return done("unknown", "a rehearsal: neither the app nor Google was asked")
    http = http or real_http
    origin = res["address"]
    if not origin: return done("unknown", "this app has no deployed address yet")
    google = infra.get("google") or {}
    # What the served page carries is what people sign in with; the recorded id is only a fallback (2026-10-13: a client
    # changed in the deploy target left the record stale, and the check read "not working" for a button that worked).
    cid = client_in_bundle(origin, http) or google.get("client_id")
    fix = lambda: how_to_fix(app_id, origin, hub_candidate, google.get("project_number"))
    if not cid:
        return done("not_working", "the page's scripts carry no Google client id, so the page has no Google sign-in at all",
                    next=["Set the Google client id (asked for at a hidden prompt), then deploy:",
                          f"    python3 .claude/scripts/provision.py {app_id} --set-secret GOOGLE_CLIENT_ID"])
    res["listed"] = own = listed(cid, origin, http)
    says = _json(origin + "/api/auth/google/availability", http)      # None on a mold older than the sign-in hub
    if says: res["app_says"] = {k: says.get(k) for k in ("google", "reason", "hub") if says.get(k) is not None}
    if own["redirect"] == "listed":
        note = "" if own["origin"] == "listed" else "; One Tap is off (the address is not under Authorised JavaScript origins), which the button does not need"
        if says and says.get("google") == "none":
            note += "; the app itself still shows no Google button (it remembers Google's answer for up to ten minutes)"
        return done("direct", f"Google lists {origin}: the button signs in here{note}")
    hub = ((infra.get("google_sign_in") or {}).get("hub") or {}).get("origin") or (says or {}).get("hub")
    hub_app = ((infra.get("google_sign_in") or {}).get("hub") or {}).get("app_id")
    if hub:
        res["hub"] = hub
        redeploy = lambda a: "    " + deploy_line(a, infra if a == app_id else None) + ("" if a == app_id else "    (that app has people using it: it is deployed only on your yes)")
        if says is None:
            return done("not_working", f"this app is set to sign in through {hub}, but the build serving now is older than the sign-in hub",
                        next=["Deploy this app once the mold has the sign-in hub (mold.py check mold_v1 shows its version):", redeploy(app_id)])
        status = _json(f"{hub}/api/auth/google-hub/status?" + urllib.parse.urlencode({"return": origin}), http)
        hub_listed = listed(cid, hub, http)
        res["hub_listed"] = hub_listed
        who = hub_app or "the hub app"
        if not status or status.get("hub") is not True:
            why = (f"{hub} does not answer as a sign-in hub yet (its build is older than the hub, or it has not been deployed since "
                   f"this app was added to its list)")
            return done("not_working", why, next=[f"Deploy {who} so it starts answering for {origin}:", redeploy(who)])
        if status.get("allowed") is not True:
            return done("not_working", f"{hub} is a sign-in hub but does not answer for {origin} yet: it has not been deployed since this address was added to its list",
                        next=[f"Deploy {who} so it starts answering for {origin}:", redeploy(who)])
        if status.get("client") != fingerprint(cid):
            return done("not_working", f"{hub} uses another Google client than this app, so Google's answer there is not for this app",
                        next=[f"Give both apps the same Google client id, or add {origin} in Google Cloud Console instead:"] + fix()[2:])
        if hub_listed["redirect"] == "unlisted" and hub_listed["origin"] == "unlisted":
            return done("not_working", f"Google does not list the hub itself ({hub}), so it cannot sign anyone in", next=how_to_fix(who, hub, None, google.get("project_number")))
        if says.get("google") != "hub":
            if says.get("reason") == "unverified" or says.get("google") == "direct":
                return done("unknown", f"the hub {hub} answers for {origin}, but the app could not ask Google about its own address and shows the direct button (reason: {says.get('reason')})")
            return done("not_working", f"the hub {hub} answers for {origin}, but the app serving now does not use it (it says: {says.get('reason') or says.get('google')}); "
                                       f"its hub setting takes effect at its next deploy", next=["Deploy this app:", redeploy(app_id)])
        if hub_listed["redirect"] == "unknown" and hub_listed["origin"] == "unknown":
            return done("unknown", f"signs in through {hub}, which answers for {origin}; Google could not be asked whether it lists the hub")
        return done("hub", f"signs in through {hub}" + (f" ({hub_app})" if hub_app else "") + f": the hub answers for {origin}, Google lists the hub, and both use one client")
    if own["redirect"] == "unlisted":
        return done("not_working", f"Google does not list {origin} (redirect_uri_mismatch), and no sign-in hub is set"
                    + ("; the page shows only the emailed-code sign-in" if says and says.get("google") == "none" else
                       "; the page still shows a Google button that leads to Google's error page (this build is older than the fix)" if says is None else ""),
                    next=fix())
    return done("unknown", f"Google's answer about {origin} was not understood (it could not be reached from here, or its sign-in pages changed)")


def record(infra, res):
    """Write the reading under infra.google_sign_in.check, keeping the one before. -> True when this is a REGRESSION:
    it worked (direct or hub) at the last reading that said either way, and now does not."""
    g = infra.setdefault("google_sign_in", {})
    old = g.get("check") or {}
    last = old if old.get("result") in WORKING + ("not_working",) else (old.get("last_known") or {})
    new = {k: res[k] for k in ("result", "detail", "address", "at", "listed", "hub") if res.get(k) is not None}
    if last: new["last_known"] = {k: last.get(k) for k in ("result", "at", "address") if last.get(k)}
    g["check"] = new
    return res["result"] == "not_working" and last.get("result") in WORKING and last.get("address") in (None, res.get("address"))


def line(res):
    """One line for a summary, a plan or the board."""
    r = res.get("result")
    head = {"direct": "Google sign-in: works directly", "hub": "Google sign-in: works through the hub",
            "not_working": "Google sign-in: NOT WORKING", "unknown": "Google sign-in: could not be checked"}.get(r, f"Google sign-in: {r}")
    return f"{head} ({res.get('detail')})" if res.get("detail") else head


def recorded_line(infra):
    """The same line from what was last recorded, or "" when nothing was."""
    c = ((infra or {}).get("google_sign_in") or {}).get("check") or {}
    return line(c) if c.get("result") else ""


# ---- the hub's settings: state, and the environment values a deploy writes from it --------------------------------------

def mold_reads_env(codebase):
    try: return RETURNS_ENV in open(os.path.join(codebase, MOLD_READS)).read()
    except OSError: return False


def display_name(app):
    n = (((app or {}).get("surface") or {}).get("branding") or {}).get("product_name") or ""
    n = re.sub(r"[^\w .&'()+-]", " ", n, flags=re.UNICODE).strip()
    return re.sub(r"\s+", " ", n)[:60]


def returns_value(infra):
    """AUTH_GOOGLE_HUB_ALLOWED_RETURNS for a hub: `origin=Name, origin`. Only exact https origins are written."""
    out = []
    for e in ((infra.get("google_sign_in") or {}).get("answers_for") or []):
        o = exact_https_origin(e.get("origin"))
        if o and all(not x.startswith(o + "=") and x != o for x in out):
            out.append(f"{o}={e['name']}" if e.get("name") and "," not in e["name"] and "=" not in e["name"] else o)
    return ", ".join(out)


def env_pairs(infra, codebase):
    """{name: value} for the app's WEB door on every deploy. {} for a mold that does not read them, and a name is
    absent when there is nothing to say (an env value cannot be empty): see env_stale()."""
    if not mold_reads_env(codebase): return {}
    out = {}
    hub = exact_https_origin(((infra.get("google_sign_in") or {}).get("hub") or {}).get("origin"))
    if hub and hub != app_address(infra): out[HUB_ENV] = hub
    rv = returns_value(infra)
    if rv: out[RETURNS_ENV] = rv
    return out


def env_stale(infra, codebase):
    """The names a deploy must REMOVE from the app's environment: state no longer says them."""
    if not mold_reads_env(codebase): return []
    return [n for n in (HUB_ENV, RETURNS_ENV) if n not in env_pairs(infra, codebase)]


def set_hub(app_id, infra, hub_id, hub_infra, app=None, http=None, now=None):
    """Point `app_id` at `hub_id` as its sign-in hub, in STATE: both infrastructure dicts are changed in place and the
    caller saves them. Nothing is deployed and no running app is touched. -> (ok, [lines to say]).
    Refuses unless the hub's own Google sign-in works directly, with the same client as this app."""
    http = http or (None if services.REHEARSAL else real_http)
    hub_origin = exact_https_origin(app_address(hub_infra))
    if hub_id == app_id: return False, [f"{app_id} cannot be its own sign-in hub."]
    if not hub_origin: return False, [f"{hub_id} has no deployed https address, so it cannot sign anyone in for another app."]
    mine, theirs = (infra.get("google") or {}).get("client_id"), (hub_infra.get("google") or {}).get("client_id")
    if mine and theirs and mine != theirs:
        return False, [f"{app_id} and {hub_id} use different Google client ids, so {hub_id} cannot sign people in for {app_id}. "
                       f"Give {app_id} the same one (mint.py {app_id} reuse-keys {hub_id}), or add its address in Google Cloud Console."]
    cid = theirs or mine
    if http is not None and cid:
        seen = listed(cid, hub_origin, http)
        if seen["redirect"] == "unlisted" and seen["origin"] == "unlisted":
            return False, [f"Google does not list {hub_id}'s own address ({hub_origin}), so it cannot be a sign-in hub. "
                           f"Pick an app whose Google sign-in works: python3 .claude/scripts/provision.py <app> --google-signin"]
    at = now or _now()
    said = []
    g = infra.setdefault("google_sign_in", {})
    before = (g.get("hub") or {}).get("origin")
    g["hub"] = {"origin": hub_origin, "app_id": hub_id, "set_at": at}
    said.append(f"{app_id} will sign in with Google through {hub_id} ({hub_origin})" + (f", instead of {before}" if before and before != hub_origin else "") + ".")
    said += sync_return(app_id, infra, hub_id, hub_infra, app=app, now=at)
    return True, said


def sync_return(app_id, infra, hub_id, hub_infra, app=None, now=None):
    """Make the hub's list name this app's address, once the app has one. Changes hub_infra in place (the caller
    saves it). -> lines to say; the last one says which deploys make it real."""
    own = exact_https_origin(app_address(infra))
    if not own:
        return [f"{app_id} has no address yet. After its first deploy, its address is added to {hub_id}'s list by that deploy, "
                f"and {hub_id} then needs one deploy of its own to start answering for it."]
    lst = hub_infra.setdefault("google_sign_in", {}).setdefault("answers_for", [])
    name = display_name(app)
    cur = next((e for e in lst if e.get("origin") == own), None)
    if cur and cur.get("app_id") == app_id and (cur.get("name") or "") == name:
        return [f"{hub_id}'s list already names {own}."]
    lst[:] = [e for e in lst if e.get("origin") != own and e.get("app_id") != app_id]
    lst.append({k: v for k, v in (("origin", own), ("name", name), ("app_id", app_id), ("added_at", now or _now())) if v})
    return [f"{own} is now on {hub_id}'s list of addresses it signs people in for (in the factory's state).",
            f"It takes effect when each app is next deployed. {hub_id} has people using it, so it is deployed only when you say so:",
            f"    {deploy_line(hub_id, hub_infra)}",
            f"    {deploy_line(app_id, infra)}",
            f"Until both are done, Google sign-in does not work at {own}; signing in with an emailed code does."]


def clear_hub(app_id, infra, hub_infra=None):
    g = infra.get("google_sign_in") or {}
    had = g.pop("hub", None)
    if hub_infra is not None:
        lst = (hub_infra.get("google_sign_in") or {}).get("answers_for")
        if lst is not None: lst[:] = [e for e in lst if e.get("app_id") != app_id]
    return [f"{app_id} no longer signs in through a hub (from its next deploy)." if had else f"{app_id} had no sign-in hub set."]


def hub_candidate(app_id, infra, state_dir=None):
    """An app that could be this one's hub: same client id, last checked as working directly. Its id, or None."""
    state_dir = state_dir or os.path.join(ROOT, "state", "application")
    want = (infra.get("google") or {}).get("client_id")
    keys_from = ((infra.get("google_sign_in") or {}).get("keys_from"))
    best = None
    try: names = sorted(os.listdir(state_dir))
    except OSError: return None
    for name in names:
        if name in (app_id, "app_id"): continue
        try: other = json.load(open(os.path.join(state_dir, name, "infrastructure.json")))
        except (OSError, ValueError): continue
        if not want or (other.get("google") or {}).get("client_id") != want: continue
        if ((other.get("google_sign_in") or {}).get("check") or {}).get("result") != "direct": continue
        if not exact_https_origin(app_address(other)): continue
        if name == keys_from: return name
        best = best or name
    return best


# ---- self-test -----------------------------------------------------------------------------------------------------------

def self_test():
    import tempfile
    n = [0]
    def ok(c, what, detail=""):
        assert c, f"{what}: {detail}" if detail else what
        n[0] += 1; print(f"  ok   {what}")
    CID = "123456789012-" + "a" * 32 + ".apps.googleusercontent.com"
    OTHER_CID = "123456789012-" + "b" * 32 + ".apps.googleusercontent.com"
    HUB, NEW, DOM = "https://hub-app.example", "https://new-app.example", "https://app.customer.example"
    mismatch = base64.urlsafe_b64encode(b"\n\x15redirect_uri_mismatch\x12\x10You can't sign in").decode().rstrip("=")

    class World:
        """Google's two endpoints as measured, and apps by address: {origin: {cid, availability, status}}."""
        def __init__(self, redirect=(), origins=(), apps=None, google="up"):
            self.redirect, self.origins, self.apps, self.google, self.calls = set(redirect), set(origins), apps or {}, google, []
        def __call__(self, url, headers=None, timeout=20):
            headers = headers or {}; self.calls.append((url, dict(headers)))
            u = urllib.parse.urlsplit(url); q = urllib.parse.parse_qs(u.query); base = f"{u.scheme}://{u.netloc}"
            if u.netloc == "accounts.google.com":
                if self.google == "down": return 0, {}, ""
                if self.google == "changed": return 200, {}, "<html>a new page</html>"
                if u.path == "/o/oauth2/v2/auth":
                    good = q["redirect_uri"][0] in self.redirect
                    return 302, {"location": "https://accounts.google.com/v3/signin/identifier?x=1" if good else f"https://accounts.google.com/signin/oauth/error?authError={mismatch}&client_id=x"}, ""
                if u.path == "/gsi/status":
                    if "Chrome/" not in headers.get("user-agent", ""): return 403, {}, ")]}'\n[[\"t\"],[9]]"
                    return (200, {}, ")]}'\n[[\"t\"],null,0]") if headers.get("origin") in self.origins else (403, {}, ")]}'\n[[\"t\"],[5]]")
            a = self.apps.get(base)
            if a is None: return 0, {}, ""
            if u.path == "/": return 200, {}, '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script>'
            if u.path == "/_next/static/chunks/a.js": return 200, {}, "console.log(1)"
            if u.path == "/_next/static/chunks/b.js": return 200, {}, f'const C="{a["cid"]}";' if a.get("cid") else "x"
            if u.path == "/api/auth/google/availability":
                return (200, {}, json.dumps(a["availability"])) if a.get("availability") else (404, {}, "not found")
            if u.path == "/api/auth/google-hub/status":
                s = a.get("status")
                if not s: return 404, {}, "not found"
                return 200, {}, json.dumps(dict(s, allowed=q.get("return", [""])[0] in s.get("answers", [])))
            return 404, {}, ""

    vercel = lambda url, **more: dict({"target": "vercel", "vercel": {"production_url": url, "project": "p"}}, **more)
    goog = {"google": {"client_id": CID, "project_number": "123456789012"}}

    # -- direct ---------------------------------------------------------------------------------------------------
    w = World(redirect=[HUB], origins=[HUB], apps={HUB: {"cid": CID}})
    r = check("hub_app", vercel(HUB, **goog), http=w)
    ok(r["result"] == "direct" and r["listed"] == {"redirect": "listed", "origin": "listed"} and not r["next"], "an address Google lists: works directly", r)
    ok(any("redirect_uri=https%3A%2F%2Fhub-app.example" in u for u, _ in w.calls) and any("/gsi/status" in u and h.get("origin") == HUB and "Chrome/" in h.get("user-agent", "") for u, h in w.calls),
       "Google is asked as a browser asks, naming the address")
    r = check("hub_app", vercel(HUB), http=w)
    ok(r["result"] == "direct", "with no client id in state, the one in the served page's scripts is used")
    ok(CID not in json.dumps(r) and CID not in line(r), "the client id is never in a result")
    r = check("x", vercel(HUB, **goog), http=World(redirect=[HUB], apps={HUB: {"cid": CID}}))
    ok(r["result"] == "direct" and "One Tap is off" in r["detail"], "listed for the button only: works, and says One Tap is off")

    # -- not working, the two ways ---------------------------------------------------------------------------------------
    w = World(redirect=[HUB], origins=[HUB], apps={NEW: {"cid": CID}})
    r = check("new_app", vercel(NEW, **goog), http=w, hub_candidate="hub_app")
    text = "\n".join(r["next"])
    ok(r["result"] == "not_working" and "redirect_uri_mismatch" in r["detail"] and "older than the fix" in r["detail"], "an address Google does not list, no hub: NOT working, and an older build still shows the dead button", r["detail"])
    ok("provision.py new_app --google-hub hub_app" in text and text.index("--google-hub") < text.index(CONSOLE), "the first way offered is the one command that sets the hub")
    ok(all(s in text for s in (CONSOLE, "Authorised JavaScript origins", "Authorised redirect URIs", '"Add URI"', '"Save"', "numbered 123456789012", f"        {NEW}", "--google-signin")),
       "the second way is Google Cloud Console, click by click, with the address to paste on its own line")
    ok(re.search(r"^   1\. Open ", text, re.M) and re.search(r"^   7\. ", text, re.M) and "Nothing secret is involved" in text and "People can still sign in with a code" in text,
       "numbered steps, what still works meanwhile, and why it is safe")
    r2 = check("new_app", vercel(NEW, **goog), http=w)
    ok("--google-hub" not in "\n".join(r2["next"]) and CONSOLE in "\n".join(r2["next"]), "with no app that could be the hub, only the console steps are given")
    w2 = World(redirect=[HUB], apps={NEW: {"cid": CID, "availability": {"google": "none", "reason": "unlisted", "hub": None}}})
    ok("only the emailed-code sign-in" in check("new_app", vercel(NEW, **goog), http=w2)["detail"], "a build with the fix shows no dead button, and the check says so")
    r = check("x", vercel(NEW), http=World(apps={NEW: {}}))
    ok(r["result"] == "not_working" and "no Google client id" in r["detail"] and "--set-secret GOOGLE_CLIENT_ID" in "\n".join(r["next"]), "no client id in the page: not working, and the fix is the key")

    # -- hub ----------------------------------------------------------------------------------------------------------------
    fp = fingerprint(CID)
    hub_ok = {"cid": CID, "status": {"hub": True, "client": fp, "ready": True, "answers": [NEW]}}
    app_hub = {"cid": CID, "availability": {"google": "hub", "reason": "hub", "hub": HUB}}
    state = vercel(NEW, google_sign_in={"hub": {"origin": HUB, "app_id": "hub_app"}}, **goog)
    r = check("new_app", state, http=World(redirect=[HUB], origins=[HUB], apps={HUB: hub_ok, NEW: app_hub}))
    ok(r["result"] == "hub" and r["hub"] == HUB and "hub_app" in r["detail"] and not r["next"], "hub set, hub answers for this address, Google lists the hub, one client: works through the hub", r)
    cases = [
        ("the hub has not been deployed since the address was added", {HUB: dict(hub_ok, status=dict(hub_ok["status"], answers=[])), NEW: app_hub}, "has not been deployed since", "provision.py hub_app --deploy"),
        ("the hub's build is older than the hub", {HUB: {"cid": CID}, NEW: app_hub}, "does not answer as a sign-in hub", "provision.py hub_app --deploy"),
        ("the hub uses another client", {HUB: dict(hub_ok, status=dict(hub_ok["status"], client=fingerprint(OTHER_CID))), NEW: app_hub}, "another Google client", CONSOLE),
        ("this app's build is older than the hub", {HUB: hub_ok, NEW: {"cid": CID}}, "older than the sign-in hub", "provision.py new_app --deploy"),
        ("this app has not been deployed since its hub was set", {HUB: hub_ok, NEW: {"cid": CID, "availability": {"google": "none", "reason": "unlisted", "hub": None}}}, "does not use it", "provision.py new_app --deploy"),
    ]
    for what, apps, why, fixline in cases:
        r = check("new_app", state, http=World(redirect=[HUB], origins=[HUB], apps=apps))
        ok(r["result"] == "not_working" and why in r["detail"] and fixline in "\n".join(r["next"]), f"hub not working ({what}): says why and what to run", r)
    ok("only on your yes" in "\n".join(check("new_app", state, http=World(redirect=[HUB], apps={HUB: {"cid": CID}, NEW: app_hub}))["next"]),
       "a step that deploys the hub (an app people use) says it waits for a yes")
    r = check("new_app", state, http=World(apps={HUB: hub_ok, NEW: app_hub}))
    ok(r["result"] == "not_working" and "does not list the hub itself" in r["detail"], "a hub Google does not list is not a hub")
    r = check("new_app", vercel(NEW, **goog), http=World(redirect=[HUB], origins=[HUB], apps={HUB: hub_ok, NEW: app_hub}))
    ok(r["result"] == "hub", "a hub the running app names is checked even when state does not name it")
    r = check("new_app", state, http=World(redirect=[HUB, NEW], origins=[HUB], apps={HUB: hub_ok, NEW: app_hub}))
    ok(r["result"] == "direct", "an address Google lists is direct even with a hub set")

    # -- unknown is never broken ---------------------------------------------------------------------------------------------
    for g in ("down", "changed"):
        r = check("new_app", vercel(NEW, **goog), http=World(apps={NEW: {"cid": CID}}, google=g))
        ok(r["result"] == "unknown" and not r["next"], f"Google's answer not understood ({g}): could not be checked, never 'not working'", r)
    ok(check("x", {"target": "vercel", "vercel": {}}, http=World())["result"] == "unknown", "an app with no address: nothing to check")
    r = check("new_app", state, http=World(google="down", apps={HUB: hub_ok, NEW: app_hub}))
    ok(r["result"] == "unknown", "a hub that answers, but Google unreachable: could not be checked")
    P = lambda loc: probe_redirect(CID, NEW, lambda u, h=None, timeout=20: (302, {"location": loc}, ""))
    other = base64.urlsafe_b64encode(b"\n\x0einvalid_client").decode().rstrip("=")
    ok(P(f"https://accounts.google.com/signin/oauth/error?authError={other}") == "unknown" and P("https://evil.example/v3/signin/identifier") == "unknown"
       and P("https://accounts.google.com/somewhere/new") == "unknown" and P("https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount") == "listed",
       "only redirect_uri_mismatch means unlisted: another error, another host or a new page says nothing")
    S = lambda st, body: probe_origin(CID, NEW, lambda u, h=None, timeout=20: (st, {}, body))
    ok(S(403, ")]}'\n[[\"t\"],[9]]") == "unknown" and S(403, ")]}'\n[[\"t\"],[3]]") == "unknown" and S(500, "") == "unknown" and S(403, ")]}'\n[[\"t\"],[5]]") == "unlisted" and S(200, "x") == "listed",
       "origins list: 200 listed, 403 code 5 unlisted, anything else says nothing")
    old = services.REHEARSAL; services.REHEARSAL = "/nonexistent"
    try:
        ok(check("new_app", vercel(NEW, **goog))["result"] == "unknown", "in a rehearsal nothing is asked of anyone")
        os.environ["FACTORY_GOOGLE_SIGNIN"] = json.dumps({"result": "not_working", "detail": "said by the script"})
        r = check("new_app", vercel(NEW, **goog), hub_candidate="hub_app")
        ok(r["result"] == "not_working" and r["detail"] == "said by the script" and "--google-hub hub_app" in "\n".join(r["next"]), "…unless the rehearsal's script says what the reading is")
    finally: services.REHEARSAL = old; os.environ.pop("FACTORY_GOOGLE_SIGNIN", None)
    os.environ["FACTORY_GOOGLE_SIGNIN"] = json.dumps({"result": "direct"})
    try: ok(check("x", {"target": "vercel", "vercel": {}}, http=World())["result"] == "unknown" and check("x", vercel(NEW, **goog), http=World(google="down", apps={NEW: {"cid": CID}}))["result"] == "unknown",
            "outside a rehearsal that setting is not read")
    finally: os.environ.pop("FACTORY_GOOGLE_SIGNIN", None)

    # -- recording, and a regression ------------------------------------------------------------------------------------------
    infra = vercel(HUB, **goog)
    first = record(infra, {"result": "not_working", "detail": "d", "address": HUB, "at": "t1"})
    ok(first is False and infra["google_sign_in"]["check"]["result"] == "not_working", "a first 'not working' is recorded and is not a regression")
    ok(record(infra, {"result": "direct", "detail": "d", "address": HUB, "at": "t2", "listed": {"redirect": "listed", "origin": "listed"}}) is False, "then it works")
    ok(record(infra, {"result": "unknown", "detail": "d", "address": HUB, "at": "t3"}) is False and infra["google_sign_in"]["check"]["last_known"]["result"] == "direct",
       "a reading that could not be made is no regression, and what was last known is kept")
    ok(record(infra, {"result": "not_working", "detail": "d", "address": HUB, "at": "t4"}) is True, "REGRESSION: it worked at the last reading that said, and now does not")
    ok(record(infra, {"result": "not_working", "detail": "d", "address": HUB, "at": "t5"}) is False, "a failure already reported is not reported as a new regression")
    infra = vercel(HUB); record(infra, {"result": "hub", "detail": "d", "address": HUB, "at": "t1", "hub": NEW})
    ok(record(infra, {"result": "not_working", "detail": "d", "address": HUB, "at": "t2"}) is True, "a hub sign-in that stops working is a regression too")
    infra = vercel(HUB); record(infra, {"result": "direct", "detail": "d", "address": HUB, "at": "t1"})
    ok(record(infra, {"result": "not_working", "detail": "d", "address": DOM, "at": "t2"}) is False, "an app that moved to a new address starts again: a warning, not a regression")
    ok("next" not in infra["google_sign_in"]["check"] and CID not in json.dumps(infra["google_sign_in"]), "the record holds the reading, not the steps and not the client id")
    ok(line({"result": "not_working", "detail": "x"}) == "Google sign-in: NOT WORKING (x)" and line({"result": "hub"}) == "Google sign-in: works through the hub"
       and recorded_line({}) == "" and recorded_line(infra).startswith("Google sign-in: NOT WORKING"), "one line for a summary, from a reading or from state")

    # -- the hub's settings ---------------------------------------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as t:
        new_mold, old_mold = os.path.join(t, "new"), os.path.join(t, "old")
        os.makedirs(os.path.join(new_mold, "lib")); os.makedirs(os.path.join(old_mold, "lib"))
        open(os.path.join(new_mold, MOLD_READS), "w").write(f"env.{HUB_ENV}; env.{RETURNS_ENV}")
        hub_i, new_i = vercel(HUB, **goog), vercel(NEW, **goog)
        app_doc = {"surface": {"branding": {"product_name": "New, App = <One>"}}}
        w = World(redirect=[HUB], origins=[HUB])
        good, said = set_hub("new_app", new_i, "hub_app", hub_i, app=app_doc, http=w, now="t0")
        ok(good and new_i["google_sign_in"]["hub"] == {"origin": HUB, "app_id": "hub_app", "set_at": "t0"}, "set_hub records the hub on the app")
        ok(hub_i["google_sign_in"]["answers_for"] == [{"origin": NEW, "name": "New App One", "app_id": "new_app", "added_at": "t0"}], "…and the app's address on the hub's list, with a plain name", hub_i["google_sign_in"])
        text = "\n".join(said)
        ok("takes effect when each app is next deployed" in text and "only when you say so" in text and "provision.py hub_app --deploy" in text and "an emailed code does" in text,
           "it says the change waits for each app's next deploy, and that the one people use waits for a yes")
        own_server = {"target": "vm_remote", "deployed_at": "2026-10-01T00:00:00+00:00", "vm_remote": {"domain": "app.customer.example", "production_url": DOM}, **goog}
        _, said_vm = set_hub("server_app", own_server, "hub_app", vercel(HUB, **goog), http=w, now="t0")
        ok("provision.py server_app --deploy-remote" in "\n".join(said_vm) and "provision.py hub_app --deploy\n" in "\n".join(said_vm) + "\n", "an app on its own server is told its own deploy command")
        ok(env_pairs(new_i, new_mold) == {HUB_ENV: HUB} and env_pairs(hub_i, new_mold) == {RETURNS_ENV: f"{NEW}=New App One"}, "the settings become the two environment values, each on its own side")
        ok(env_pairs(new_i, old_mold) == {} and env_stale(new_i, old_mold) == [], "a mold that does not read them gets none")
        ok(env_stale(new_i, new_mold) == [RETURNS_ENV] and env_stale(hub_i, new_mold) == [HUB_ENV], "a value state does not say is removed at the deploy, not left behind")
        again, said2 = set_hub("new_app", new_i, "hub_app", hub_i, app=app_doc, http=w, now="t1")
        ok(again and len(hub_i["google_sign_in"]["answers_for"]) == 1 and "already names" in "\n".join(said2), "setting it twice adds nothing twice")
        moved = vercel(DOM, google_sign_in=new_i["google_sign_in"], **goog)
        sync_return("new_app", moved, "hub_app", hub_i, app=app_doc, now="t2")
        ok([e["origin"] for e in hub_i["google_sign_in"]["answers_for"]] == [DOM], "an app that moves address replaces its entry: the old address is not left on the hub's list")
        hub_i["google_sign_in"]["answers_for"] += [{"origin": "http://plain.example"}, {"origin": "https://*.example"}, {"origin": "https://x.example/path"}, {"origin": "https://ok.example", "name": "a, b"}]
        ok(returns_value(hub_i) == f"{DOM}=New App One, https://ok.example", "only exact https origins are ever written to the hub's list; a name that would break the list is dropped")
        no_addr = {"target": "vercel", "vercel": {"project": "p"}, **goog}
        good, said = set_hub("fresh", no_addr, "hub_app", hub_i, http=w, now="t3")
        ok(good and no_addr["google_sign_in"]["hub"]["origin"] == HUB and "After its first deploy" in "\n".join(said) and all(e.get("app_id") != "fresh" for e in hub_i["google_sign_in"]["answers_for"]),
           "an app not deployed yet gets its hub now, and its address joins the hub's list at its first deploy")
        bad, why = set_hub("new_app", vercel(NEW, **goog), "other", vercel(DOM, google={"client_id": OTHER_CID}), http=w)
        ok(not bad and "different Google client ids" in why[0], "refused: the two apps use different clients")
        bad, why = set_hub("new_app", vercel(NEW, **goog), "dead", vercel(DOM, **goog), http=w)
        ok(not bad and "Google does not list" in why[0], "refused: Google does not list the would-be hub")
        bad, why = set_hub("new_app", vercel(NEW, **goog), "new_app", vercel(NEW, **goog), http=w)
        ok(not bad, "refused: an app is never its own hub")
        bad, why = set_hub("new_app", vercel(NEW, **goog), "vm", {"target": "vm"}, http=w)
        ok(not bad and "no deployed https address" in why[0], "refused: a hub with no address")
        ok(env_pairs(vercel(HUB, google_sign_in={"hub": {"origin": HUB}}), new_mold) == {}, "an app whose hub setting is its own address writes none")
        clear_hub("new_app", moved, hub_i)
        ok("hub" not in moved["google_sign_in"] and all(e.get("app_id") != "new_app" for e in hub_i["google_sign_in"]["answers_for"]), "clearing removes both halves")
        # hub_candidate: same client, last checked as direct; the app the keys came from first
        sd = os.path.join(t, "state");
        def put(name, doc):
            os.makedirs(os.path.join(sd, name)); json.dump(doc, open(os.path.join(sd, name, "infrastructure.json"), "w"))
        put("a_direct", vercel(HUB, google_sign_in={"check": {"result": "direct"}}, **goog))
        put("b_direct", vercel(DOM, google_sign_in={"check": {"result": "direct"}}, **goog))
        put("c_broken", vercel("https://c.example", google_sign_in={"check": {"result": "not_working"}}, **goog))
        put("d_other", vercel("https://d.example", google={"client_id": OTHER_CID}, google_sign_in={"check": {"result": "direct"}}))
        ok(hub_candidate("new_app", vercel(NEW, **goog), sd) == "a_direct", "a hub is suggested only from apps with the same client whose sign-in works directly")
        ok(hub_candidate("new_app", vercel(NEW, google_sign_in={"keys_from": "b_direct"}, **goog), sd) == "b_direct", "…the app the keys were reused from first")
        ok(hub_candidate("new_app", vercel(NEW, google={"client_id": "9" * 12 + "-" + "c" * 32 + ".apps.googleusercontent.com"}), sd) is None, "none when no app shares the client")
    ok(exact_https_origin("https://a.example") and not any(exact_https_origin(x) for x in ("http://a.example", "https://a.example/", "https://*.example", "https://A.example", "https://u@a.example", "https://a.example:443", "")),
       "an origin is https, a host, and nothing else")
    print(f"google_signin --self-test: {n[0]} checks passed")
    return 0


def main(a):
    if a and a[0] == "--self-test": return self_test()
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    app_id = a[0]
    try: infra = json.load(open(os.path.join(ROOT, "state", "application", app_id, "infrastructure.json")))
    except (OSError, ValueError): sys.exit(f"{app_id}: state/application/{app_id}/infrastructure.json is missing or unreadable.")
    res = check(app_id, infra, hub_candidate=hub_candidate(app_id, infra))
    if "--json" in a: print(json.dumps(res, indent=2))
    else:
        print(line(res))
        for l in res["next"]: print(l)
    return 0 if res["result"] in WORKING else 1 if res["result"] == "not_working" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
