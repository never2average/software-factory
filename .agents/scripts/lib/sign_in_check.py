#!/usr/bin/env python3
"""Do an app's sign-ins come back to its front door? Every OAuth return address, checked at the providers (mold_v0-270).

  sign_in_check.py --self-test     offline: every provider is a stand-in HTTP server on 127.0.0.1

WHY. After an app moved to its own domain (domain.py switch), Google answered "redirect_uri_mismatch" and GitHub "the
redirect URL is not associated with the application": the providers still held the old return addresses, and nothing
in the factory said so. Every check, deploy and switch now names each sign-in the app sends people through, the EXACT
address the provider must hold, whether it does (pass / fail / unknown), and where to click to fix it.

THE FLOWS (the app's own Health › Sign-in lists the same, src/sign-in-check.ts in the mold):
  clerk.domain         Clerk's instance holds the front door (Backend API /v1/instance, /v1/domains, CLERK_SECRET_KEY)
  clerk.<strategy>     each social sign-in Clerk has on (its Frontend API's public /v1/environment); the return address
                       is Clerk's own, <frontend api>/v1/oauth_callback. An anonymous sign-in attempt at the Frontend API
                       (what Clerk's sign-in page does on a click; nobody signs in) answers the provider's authorize
                       address with Clerk's client id, which is then opened.
  google               the built-in sign-in's Google: <front door>/api/auth/google/callback (GOOGLE_REDIRECT_URI wins)
  github_app.*         the platform GitHub App (callback <front door>/api/github-app/callback, the install's return,
                       the webhook) and oauth.<pack>.<name> (credential connections, <front door>/api/credential-connections/callback):
                       their client ids are in the app's key vault, so they come from the app's own report (GET
                       <api>/api/cron/sign-in-check with CRON_SECRET, read from the deploy target and never printed)
  mcp                  AI clients' sign-in: the app's /.well-known/oauth-protected-resource/mcp names <front door>/mcp
                       (built-in), or Clerk lets clients register (on Clerk)

THE ANSWERS, as measured 2026-11-07, before anyone signs in: Google's authorize address 302s to its sign-in page for a
listed address and to /signin/oauth/error?authError=<base64 naming redirect_uri_mismatch> (or 400) for one it does not
list. GitHub's sends EVERY anonymous request to its sign-in page (a wrong address and an unknown client id alike; the page
names a known app), so a probe of GitHub says unknown; what GitHub sent back to the app (the app's report) decides it.
Anything not understood is "unknown", never "pass".

Never a secret: the Clerk secret goes to Clerk's Backend API only and CRON_SECRET to the app only, both held in memory;
client ids are public but only a 12-hex fingerprint is ever printed or recorded. Standard library only.
"""
import base64, datetime, hashlib, json, os, re, sys, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
CLERK_API = "https://api.clerk.com"
GOOGLE_WHERE = "Google Cloud Console → APIs & Services → Credentials → the OAuth client → Authorized redirect URIs"
GITHUB_APP_WHERE = "GitHub → Settings → Developer settings → GitHub Apps → the app → Callback URL"
CLERK_DOMAINS_WHERE = "Clerk dashboard → Configure → Domains"
CLERK_SSO_WHERE = "Clerk dashboard → Configure → SSO connections"
# Paths on the front door the mold's sign-ins return to (domain.py switch names the ones that change).
FRONT_PATHS = {"google": "/api/auth/google/callback", "github_app.callback": "/api/github-app/callback",
               "oauth": "/api/credential-connections/callback", "mcp": "/mcp"}
RESULTS = ("pass", "fail", "unknown")
REWRITE = None   # the self-test only: (url) -> url, the providers' addresses mapped to stand-ins on 127.0.0.1


def _now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
def fingerprint(cid): return hashlib.sha256(cid.strip().encode()).hexdigest()[:12] if cid else None
def origin(u):
    try: s = urllib.parse.urlsplit(u or "")
    except ValueError: return ""
    return f"{s.scheme}://{s.netloc}" if s.scheme in ("http", "https") and s.netloc else ""
def host(u):
    try: return urllib.parse.urlsplit(u or "").netloc
    except ValueError: return ""


# ---- HTTP: one function, redirects never followed blindly ----------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def real_http(url, method="GET", headers=None, body=None, timeout=12):
    """{status, location (absolute, against the address asked), body, cookies}. Status 0: nothing answered."""
    h = {"user-agent": BROWSER_UA, "accept": "text/html,application/json"}
    h.update(headers or {})
    req = urllib.request.Request(REWRITE(url) if REWRITE else url, method=method, headers=h, data=body.encode() if isinstance(body, str) else body)
    def out(st, hd, text):
        loc = hd.get("location") if hd else None
        cookies = hd.get_all("set-cookie") if hd is not None and hasattr(hd, "get_all") else []
        return {"status": st, "location": urllib.parse.urljoin(url, loc) if loc else None, "body": text, "cookies": cookies or []}
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout) as r:
            return out(r.status, r.headers, r.read(400_000).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try: text = e.read(400_000).decode("utf-8", "replace")
        except Exception: text = ""
        return out(e.code, e.headers, text)
    except Exception:
        return {"status": 0, "location": None, "body": "", "cookies": []}


def _json(a):
    try: d = json.loads(a["body"])
    except (ValueError, TypeError): return None
    return d if isinstance(d, dict) else None


# ---- the classifiers (the same rules as the mold's src/sign-in-check.ts) ---------------------------------------------------

def _b64(s):
    try: return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode("latin-1")
    except Exception: return ""


def probe_google(url, http=None):
    a = (http or real_http)(url)
    if a["status"] == 0: return "unknown", "Google could not be reached from here"
    if a["status"] >= 400 and "redirect_uri_mismatch" in a["body"]:
        return "fail", "Google answered redirect_uri_mismatch: the address is not under the client's Authorized redirect URIs"
    if 300 <= a["status"] < 400 and a["location"]:
        to = urllib.parse.urlsplit(a["location"])
        if to.netloc != host(url): return "unknown", f"Google sent the browser to another site ({to.netloc})"
        err = (urllib.parse.parse_qs(to.query).get("authError") or [""])[0]
        if err or "/error" in to.path:
            said = _b64(err)
            if "redirect_uri_mismatch" in said: return "fail", "Google answered redirect_uri_mismatch: the address is not under the client's Authorized redirect URIs"
            if re.search(r"invalid_client|deleted_client|OAuth client was not found", said): return "fail", "Google does not know this client id (invalid_client): the app's client was deleted or the id is wrong"
            return "unknown", "Google refused for a reason other than the address"
        if re.match(r"^/(v\d+/signin|signin|o/oauth2|ServiceLogin|AccountChooser|InteractiveLogin)", to.path):
            return "pass", "Google lists the address: it goes on to its sign-in page"
    return "unknown", f"Google's answer was not understood (HTTP {a['status']})"


def probe_github(url, http=None):
    http = http or real_http
    a = http(url)
    if a["status"] == 0: return "unknown", "GitHub could not be reached from here"
    bad = lambda t: re.search(r"not associated with (this|the) application|redirect_uri_mismatch", t or "", re.I)
    if 300 <= a["status"] < 400 and a["location"]:
        to = urllib.parse.urlsplit(a["location"])
        if (urllib.parse.parse_qs(to.query).get("error") or [""])[0] == "redirect_uri_mismatch":
            return "fail", "GitHub sent the browser back with redirect_uri_mismatch: the address is not the app's Callback URL"
        if to.netloc == host(url) and to.path == "/login":
            page = http(a["location"])
            if bad(page["body"]): return "fail", "GitHub says the redirect URL is not associated with the application"
            m = re.search(r"to continue to\s*<strong>([^<]{1,100})</strong>", page["body"] or "")
            return ("unknown", f"GitHub knows the app ({m.group(1).strip()}), but it checks the Callback URL only after someone signs in") if m else \
                   ("unknown", "GitHub did not name an app for this client id (check the client id); it checks the Callback URL only after someone signs in")
        return "unknown", "GitHub sent the browser somewhere not understood"
    if bad(a["body"]): return "fail", "GitHub says the redirect URL is not associated with the application"
    return "unknown", f"GitHub's answer was not understood (HTTP {a['status']})"


def probe_generic(url, redirect_uri, http=None):
    a = (http or real_http)(url)
    if a["status"] == 0: return "unknown", "the provider could not be reached from here"
    if a["location"]:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(a["location"]).query)
        e = f"{(q.get('error') or [''])[0]} {(q.get('error_description') or [''])[0]}"
        if re.search(r"redirect_uri_mismatch|invalid_redirect_uri|redirect_uri.*(not|invalid|match)", e, re.I):
            return "fail", f"the provider sent the browser back with {(q.get('error') or [''])[0]}: the address is not registered"
    if a["status"] >= 400 and re.search(r"redirect_uri_mismatch|invalid_redirect_uri|AADSTS50011|redirect[ _]ur[il][^<]{0,80}(not (registered|valid|allowed|associated)|does not match|mismatch|invalid)", a["body"] or "", re.I):
        return "fail", "the provider says the return address is not registered"
    return "unknown", f"the provider's answer was not understood (HTTP {a['status']}); it may check the address only after a sign-in"


def classify(provider, url, redirect_uri, http=None):
    h = host(url)
    if provider == "google" or h == "accounts.google.com": return probe_google(url, http)
    if provider == "github" or h == "github.com": return probe_github(url, http)
    return probe_generic(url, redirect_uri, http)


# ---- where to click ---------------------------------------------------------------------------------------------------

def google_steps(uri, via_clerk=False):
    return ["Open https://console.cloud.google.com/apis/credentials and sign in with the Google account that owns the app's sign-in.",
            "At the top of the page, pick the project the sign-in belongs to (if you see only one, that is it).",
            ("Under \"OAuth 2.0 Client IDs\", click the client whose Client ID Clerk shows (Clerk dashboard → Configure → SSO connections → Google)."
             if via_clerk else "Under \"OAuth 2.0 Client IDs\", click the entry whose type is \"Web application\"."),
            "Under \"Authorized redirect URIs\", click \"Add URI\" and paste this exactly:", f"    {uri}",
            "Click \"Save\" at the bottom. Google can take up to five minutes to apply it."]


def github_steps(uri, via_clerk=False):
    if via_clerk:
        return ["Open https://github.com/settings/developers (for an organization's app: the organization's Settings → Developer settings) and sign in.",
                "Click the OAuth app or GitHub App whose Client ID Clerk shows (Clerk dashboard → Configure → SSO connections → GitHub).",
                "Set \"Authorization callback URL\" (an OAuth app) or the first \"Callback URL\" (a GitHub App) to exactly:", f"    {uri}",
                "Click \"Update application\" (or \"Save changes\")."]
    return ["Open https://github.com/settings/apps (for an organization's app: https://github.com/organizations/<the organization>/settings/apps) and sign in.",
            "Click \"Edit\" next to the app this platform uses.",
            "Under \"Callback URL\", click \"Add Callback URL\" (or change the first one) and paste this exactly:", f"    {uri}",
            "Keep \"Request user authorization (OAuth) during installation\" ticked.",
            "Click \"Save changes\" at the bottom."]


def clerk_domain_steps(front, fapi):
    h = host(front)
    return ["Open https://dashboard.clerk.com and sign in.",
            f"Click the application this app signs people in with{f' (its sign-in address is {host(fapi)})' if fapi else ''}; if there is a Development / Production switch at the top, pick Production.",
            "Click Configure in the menu along the top, then Domains on the left.",
            f"Either change the primary domain to {'.'.join(h.split('.')[-2:])}, or click \"Add satellite domain\" and type {h}; then add the DNS records Clerk lists at the company where the domain is registered.",
            "Wait until Clerk shows the domain as verified (a few minutes up to an hour)."]


def flow(id, label, provider, redirect_uri, path, result, detail, where, steps, client=None):
    return {"id": id, "label": label, "provider": provider, "redirect_uri": redirect_uri, "path": path, "result": result,
            "detail": detail, "where": where, "steps": steps, "client": fingerprint(client) if client else None}


# ---- Clerk ------------------------------------------------------------------------------------------------------------

def clerk_flows(front, fapi, sk, dev_hint=False, http=None):
    http = http or real_http
    out = []
    auth = {"authorization": f"Bearer {sk}", "accept": "application/json"} if sk else None
    inst = http(f"{CLERK_API}/v1/instance", headers=auth) if sk else None
    doms = http(f"{CLERK_API}/v1/domains", headers=auth) if sk else None
    instance = _json(inst) if inst and inst["status"] == 200 else None
    dj = _json(doms) if doms and doms["status"] == 200 else None
    domains = [d for d in (dj or {}).get("data") or [] if isinstance(d, dict)] if dj is not None else None
    env = str((instance or {}).get("environment_type") or ("development" if dev_hint else "production"))
    h = host(front)
    names = [str(d.get("name") or "") for d in domains or [] if d.get("name")]
    allowed = [str(o) for o in (instance or {}).get("allowed_origins") or []]
    held = [n for n in names if h == n or h.endswith("." + n)]
    if not sk: r, d = "unknown", "the API has no Clerk secret key, so Clerk's settings could not be read"
    elif instance is None or domains is None: r, d = "unknown", f"Clerk's Backend API did not answer (HTTP {(inst or {}).get('status', 0)}, {(doms or {}).get('status', 0)})"
    elif env == "development": r, d = "pass", "a development instance: it accepts any address"
    elif held or any(origin(o) == origin(front) for o in allowed): r, d = "pass", f"Clerk's instance holds {h} ({held[0] if held else 'an allowed origin'})"
    else: r, d = "fail", f"Clerk's instance is for {', '.join(names) or 'another domain'}, not {h}: sign-in there is refused"
    out.append(flow("clerk.domain", "Clerk: the app's address", "clerk", front, "", r, d, CLERK_DOMAINS_WHERE, clerk_domain_steps(front, fapi)))
    if not fapi: return out
    callback = f"{fapi}/v1/oauth_callback"
    e = http(f"{fapi}/v1/environment?_clerk_js_version=5", headers={"origin": front, "accept": "application/json"})
    social = ((_json(e) or {}).get("user_settings") or {}).get("social")
    if not isinstance(social, dict):
        out.append(flow("clerk.social", "Clerk: social sign-ins", "clerk", callback, None, "unknown",
                        f"Clerk's public settings could not be read (HTTP {e['status']}), so which social sign-ins are on is not known", CLERK_SSO_WHERE, []))
        return out
    dev = env == "development"
    for key, s in social.items():
        if not isinstance(s, dict) or not s.get("enabled"): continue
        strategy = str(s.get("strategy") or key); provider = strategy.replace("oauth_", "", 1); name = s.get("name") or provider
        creds = "Clerk's shared development credentials unless custom ones are set" if dev else "custom credentials (a production instance always uses its own)"
        url, client, refused, why = clerk_attempt(fapi, front, strategy, dev, http)
        r, d = classify(provider, url, callback, http) if url else (("fail" if refused else "unknown"), why)
        where = (f"{GOOGLE_WHERE} (the client Clerk uses)" if provider == "google" else
                 "GitHub → Settings → Developer settings → the app Clerk uses → Authorization callback URL" if provider == "github" else
                 f"{name}'s developer console → the OAuth app Clerk uses → redirect URIs")
        steps = (google_steps(callback, True) if provider == "google" else github_steps(callback, True) if provider == "github" else
                 [f"Open {name}'s developer console and the OAuth app whose client id Clerk shows ({CLERK_SSO_WHERE} → {name}).",
                  "Add this as an allowed redirect (callback) address:", f"    {callback}", "Save."])
        out.append(flow(f"clerk.{strategy}", f"{name} (through Clerk)", provider, callback, None, r, f"{d} (Clerk's callback, {creds})", where, steps, client))
    return out


def clerk_attempt(fapi, front, strategy, dev, http):
    """An anonymous sign-in attempt at Clerk's Frontend API: (provider authorize address, Clerk's client id, refused, why)."""
    q = {"_clerk_js_version": "5"}
    if dev:
        d = _json(http(f"{fapi}/v1/dev_browser", method="POST", headers={"origin": front, "accept": "application/json"}, body="")) or {}
        tok = d.get("token") or d.get("id")
        if isinstance(tok, str): q["__clerk_db_jwt"] = tok
    qs = urllib.parse.urlencode(q)
    first = http(f"{fapi}/v1/client?{qs}", headers={"origin": front, "accept": "application/json"})
    cookie = "; ".join(c.split(";")[0] for c in first.get("cookies") or [] if c.startswith("__client="))
    body = urllib.parse.urlencode({"strategy": strategy, "redirect_url": f"{front}/sso-callback", "action_complete_redirect_url": f"{front}/"})
    a = http(f"{fapi}/v1/client/sign_ins?{qs}", method="POST", body=body,
             headers={"origin": front, "accept": "application/json", "content-type": "application/x-www-form-urlencoded", **({"cookie": cookie} if cookie else {})})
    j = _json(a) or {}
    ext = (((j.get("response") or {}).get("first_factor_verification") or {}).get("external_verification_redirect_url"))
    if a["status"] == 200 and isinstance(ext, str) and re.match(r"^https?://", ext):
        cid = (urllib.parse.parse_qs(urllib.parse.urlsplit(ext).query).get("client_id") or [None])[0]
        return ext, cid, False, ""
    errs = [e for e in j.get("errors") or [] if isinstance(e, dict)]
    said = "; ".join(f"{e.get('code', '')} {(e.get('meta') or {}).get('param_name', '')} {e.get('long_message') or e.get('message') or ''}" for e in errs)
    code = (errs[0].get("code") if errs else None) or a["status"]
    if a["status"] >= 400 and re.search(r"redirect_url|origin", said, re.I):
        return None, None, True, f"Clerk refused a sign-in started on {host(front)} ({code})"
    tail = f", {errs[0]['code']}" if errs and errs[0].get("code") else ""
    return None, None, False, f"Clerk did not start a sign-in (HTTP {a['status']}{tail})"


# ---- the app's own report (key-vault sign-ins: the GitHub App, credential connections) ------------------------------------

def app_report(api_url, cron_secret, http=None):
    """The app's Health › Sign-in report as the factory reads it (with public client ids), or (None, why)."""
    if not api_url: return None, "the app has no API address yet"
    if not cron_secret: return None, "CRON_SECRET could not be read from the deploy target"
    a = (http or real_http)(f"{api_url.rstrip('/')}/api/cron/sign-in-check", headers={"authorization": f"Bearer {cron_secret}", "accept": "application/json"})
    j = _json(a) if a["status"] == 200 else None
    if j and isinstance(j.get("flows"), list): return j, ""
    return None, ("the app's build does not report its sign-ins yet (it is older than mold_v0-270; a deploy brings it)" if a["status"] == 404
                  else f"the app did not answer its sign-in report (HTTP {a['status']})")


# ---- the check -----------------------------------------------------------------------------------------------------------

def provider_of(api):
    raw = str(api.get("AUTH_PROVIDER") or "").strip().lower()
    if raw in ("builtin", "clerk"): return raw
    return "clerk" if str(api.get("CLERK_SECRET_KEY") or "").strip() else "builtin"


def frontend_api(api, web):
    import clerk_mcp
    u = clerk_mcp.frontend_from_url(api.get("CLERK_FRONTEND_API_URL"))
    if u: return u
    for v in (web.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), api.get("CLERK_PUBLISHABLE_KEY"), api.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")):
        f = clerk_mcp.frontend_from_pk(v)
        if f: return f
    return None


def check(app_id, front, api_url, api=None, web=None, http=None):
    """Every flow for the front door `front`. `api`/`web`: the two projects' values (held, never printed). Reads only."""
    http = http or real_http; api = api or {}; web = web or {}
    front = (front or "").rstrip("/")
    res = {"at": _now(), "front_door": front, "flows": [], "notes": []}
    if not front:
        res["notes"].append("the app has no address yet: nothing to check")
        return finish(res)
    prov = provider_of(api)
    if prov == "clerk":
        fapi = frontend_api(api, web)
        pk = str(web.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") or api.get("CLERK_PUBLISHABLE_KEY") or "")
        res["flows"] += clerk_flows(front, fapi, str(api.get("CLERK_SECRET_KEY") or ""), pk.startswith("pk_test_"), http)
    elif api.get("GOOGLE_CLIENT_ID"):
        uri = api.get("GOOGLE_REDIRECT_URI") or f"{front}{FRONT_PATHS['google']}"
        q = urllib.parse.urlencode({"client_id": api["GOOGLE_CLIENT_ID"], "redirect_uri": uri, "response_type": "code", "scope": "openid email profile", "state": "address-check", "prompt": "select_account"})
        r, d = probe_google(f"{api.get('GOOGLE_AUTH_URL') or 'https://accounts.google.com/o/oauth2/v2/auth'}?{q}", http)
        res["flows"].append(flow("google", "Google (the app's own sign-in)", "google", uri, None if api.get("GOOGLE_REDIRECT_URI") else FRONT_PATHS["google"],
                                 r, d, GOOGLE_WHERE, google_steps(uri), api["GOOGLE_CLIENT_ID"]))
    report, why = app_report(api_url, api.get("CRON_SECRET"), http)
    if report is None:
        res["flows"].append(flow("app", "The app's own connections (GitHub App, credential sign-ins)", "app", None, None, "unknown", why,
                                 "the app's staff console → Health → Sign-in", []))
    else:
        moved = (report.get("front_door") or "").rstrip("/") != front
        for f in report["flows"]:
            if not isinstance(f, dict) or not str(f.get("id", "")).startswith(("github_app.", "oauth.")): continue
            g = dict(f); cid = g.pop("client_id", None); auth = g.pop("authorize_url", None); g.pop("client", None)
            if moved and g.get("path"):
                g["redirect_uri"] = f"{front}{g['path']}"
                g["steps"] = [s.replace(f"    {f.get('redirect_uri')}", f"    {g['redirect_uri']}") for s in g.get("steps") or []]
                if cid and auth and g["id"] != "github_app.setup":
                    url = f"{auth}?{urllib.parse.urlencode({'client_id': cid, 'redirect_uri': g['redirect_uri'], 'response_type': 'code', 'state': 'address-check'})}"
                    g["result"], g["detail"] = classify(g.get("provider"), url, g["redirect_uri"], http)
                else: g["result"], g["detail"] = "unknown", "not asked at the new address yet"
                g["detail"] += f" (the app still runs on {report.get('front_door')}: redeploy it)"
            g["client"] = fingerprint(cid) if cid else None
            res["flows"].append({k: g.get(k) for k in ("id", "label", "provider", "redirect_uri", "path", "result", "detail", "where", "steps", "client")})
    res["flows"].append(mcp_flow(front, prov, api, web, http))
    return finish(res)


def mcp_flow(front, prov, api, web, http):
    base = ("mcp", "AI clients' sign-in (MCP)")
    if prov == "clerk":
        fapi = frontend_api(api, web)
        a = http(f"{fapi}/.well-known/oauth-authorization-server", headers={"accept": "application/json"}) if fapi else {"status": 0, "body": ""}
        j = _json(a) if a["status"] == 200 else None
        on = bool(j) and ((isinstance(j.get("registration_endpoint"), str) and j["registration_endpoint"].startswith("http")) or j.get("client_id_metadata_document_supported") is True)
        r, d = ("unknown", "Clerk's sign-in server did not say whether AI clients may register") if not j else \
               ("pass", "AI clients register their own return addresses with Clerk: nothing to add for them") if on else \
               ("fail", "Clerk lets no AI client register itself, so AI clients cannot sign in")
        return flow(*base, "clerk", None, FRONT_PATHS["mcp"], r, d, "Clerk dashboard → Configure → OAuth applications → Settings",
                    ["Open https://dashboard.clerk.com and click the application this app signs people in with.",
                     "Click Configure along the top, then OAuth applications on the left, then the Settings tab.",
                     "Turn on Dynamic client registration (and Client ID Metadata Documents, if it is there).", "Click Save if a Save button appears."])
    a = http(f"{front}/.well-known/oauth-protected-resource/mcp", headers={"accept": "application/json"})
    j = _json(a) if a["status"] == 200 else None
    want = f"{front}/mcp"
    if not j or not isinstance(j.get("resource"), str): r, d = "unknown", f"the app did not answer its sign-in address for AI clients (HTTP {a['status']})"
    elif j["resource"].rstrip("/") == want: r, d = "pass", f"AI clients sign in on {want} and bring their own return addresses: nothing to add for them"
    else: r, d = "fail", f"AI clients are told to sign in at {j['resource']}, not {want}: a redeploy applies the front door"
    return flow(*base, "app", None, FRONT_PATHS["mcp"], r, d, "the factory: a redeploy", ["Redeploy the app (the factory's deploy writes the address AI clients connect to)."])


def finish(res):
    res["totals"] = {k: sum(1 for f in res["flows"] if f["result"] == k) for k in RESULTS}
    return res


# ---- saying it ------------------------------------------------------------------------------------------------------------

MARK = {"pass": "pass   ", "fail": "FAIL   ", "unknown": "unknown"}


def lines(res, indent="  "):
    """What a check prints: one line per flow, the exact address under it."""
    t = res.get("totals") or {}
    out = [f"{indent}sign-in return addresses for {res.get('front_door') or '(no address)'}: {t.get('pass', 0)} pass, {t.get('fail', 0)} fail, {t.get('unknown', 0)} unknown"]
    out += [f"{indent}  {n}" for n in res.get("notes") or []]
    for f in sorted(res.get("flows") or [], key=lambda f: RESULTS.index(f["result"]) if f["result"] in RESULTS else 9, reverse=False):
        out.append(f"{indent}  {MARK.get(f['result'], f['result'])}  {f['label']}: {f['detail']}")
        if f.get("redirect_uri"): out.append(f"{indent}             address: {f['redirect_uri']}   (where: {f['where']})")
    return out


def failing(res):
    """The failures the operator is asked about. AI clients' registration with Clerk is not one of them: provision.py's
    Clerk reading (lib/clerk_mcp.py) already asks for it, and stops only when nothing else lets an AI client connect."""
    return [f for f in res.get("flows") or [] if f["result"] == "fail" and not (f["id"] == "mcp" and f.get("provider") == "clerk")]


def ask(app_id, res):
    """The plain request for the operator (AGENTS.md "Asking the operator"): the first failing sign-in, click by click;
    the others named, to be done one at a time. '' when nothing fails."""
    bad = failing(res)
    if not bad: return ""
    f = bad[0]
    steps = [s for s in f.get("steps") or []]
    numbered, n = [], 0
    for s in steps:
        if s.startswith("    "): numbered.append(f"      {s.strip()}")
        else: n += 1; numbered.append(f"  {n}. {s}")
    rest = [g["label"] for g in bad[1:]]
    return "\n".join([
        f"{f['label']} does not work for {app_id} at {res.get('front_door')}: {f['detail']}.",
        (f"It needs one address added in {f['where'].split(' → ')[0]} (about three minutes):" if f.get("redirect_uri")
         else f"It needs one setting changed in {f['where'].split(' → ')[0]} (about a minute):"), *numbered,
        f"Then say it is done, and the check runs again (it only reads): python3 .claude/scripts/provision.py {app_id} --sign-in-check",
        "Nothing secret is involved: the address is public, and no password or key is typed anywhere.",
        *( [f"After that, {len(rest)} more sign-in(s) need the same kind of fix ({', '.join(rest)}); I will give you those steps one at a time."] if rest else [])])


def record(infra, res):
    """infrastructure.json sign_in_redirects: the last reading (no steps, no client id)."""
    infra["sign_in_redirects"] = {"at": res["at"], "front_door": res["front_door"], "totals": res["totals"],
                                  "flows": [{k: f.get(k) for k in ("id", "label", "provider", "redirect_uri", "path", "result", "detail", "where")} for f in res["flows"]]}


def recorded_line(infra):
    c = (infra or {}).get("sign_in_redirects") or {}
    t = c.get("totals")
    if not t: return ""
    bad = [f["label"] for f in c.get("flows") or [] if f.get("result") == "fail"]
    return (f"sign-in return addresses ({c.get('at', '')[:16]}): {t.get('pass', 0)} pass, {t.get('fail', 0)} fail, {t.get('unknown', 0)} unknown"
            + (f"; needs you: {', '.join(bad)}" if bad else ""))


def changes(old_front, new_front, flows=None):
    """Before a switch: every return address made of the front door, old -> new, and where it is registered. `flows`: the
    last recorded reading's (only the flows the app uses); without one, every front-door address the mold has."""
    old_front, new_front = (old_front or "").rstrip("/"), (new_front or "").rstrip("/")
    out = []
    seen = set()
    for f in flows or []:
        p = f.get("path")
        if p is None or (f.get("id"), p) in seen: continue
        seen.add((f.get("id"), p))
        if f.get("id") == "clerk.domain":
            out.append({"label": f["label"], "old": old_front, "new": new_front, "where": CLERK_DOMAINS_WHERE}); continue
        out.append({"label": f["label"], "old": f"{old_front}{p}", "new": f"{new_front}{p}", "where": f.get("where") or ""})
    if not flows:
        for label, p, where in (("Google (the app's own sign-in)", FRONT_PATHS["google"], GOOGLE_WHERE), ("GitHub App: callback", FRONT_PATHS["github_app.callback"], GITHUB_APP_WHERE),
                                ("Credential connections (each provider)", FRONT_PATHS["oauth"], "each provider's developer console → the OAuth app → redirect URIs"),
                                ("AI clients' sign-in (MCP)", FRONT_PATHS["mcp"], "nothing to register: a redeploy applies it")):
            out.append({"label": label + " (if the app uses it)", "old": f"{old_front}{p}", "new": f"{new_front}{p}", "where": where})
    return out


# ---- self-test: every provider a stand-in on 127.0.0.1 --------------------------------------------------------------------

def self_test():
    import http.server, threading
    global REWRITE
    n = [0]
    def ok(c, what, detail=""):
        assert c, f"{what}: {detail}" if detail else what
        n[0] += 1; print(f"  ok   {what}")
    FRONT, NEW, FAPI, API = "https://app.example.com", "https://app.newco.test", "https://clerk.example.com", "https://app-api.example.net"
    SK, CRON = "sk_live_" + "s" * 24, "cron-" + "c" * 24
    CG, OWN, GH, ACME = "111-clerkgoogle.apps.googleusercontent.com", "222-owngoogle.apps.googleusercontent.com", "Iv1.platformapp", "acme-client-1"
    W = {"google": {CG: {f"{FAPI}/v1/oauth_callback"}, OWN: {f"{FRONT}/api/auth/google/callback"}}, "domains": ["example.com"], "env": "production",
         "social": True, "registration": True, "acme": set(), "resource": f"{FRONT}/mcp", "report": True, "calls": []}
    b64u = lambda s: base64.urlsafe_b64encode(s.encode("latin-1")).decode().rstrip("=")
    def reply(h, st, body="", headers=None):
        h.send_response(st)
        for k, v in (headers or {}).items():
            for x in (v if isinstance(v, list) else [v]): h.send_header(k, x)
        h.end_headers(); h.wfile.write(body.encode())
    def js(h, st, d, headers=None): reply(h, st, json.dumps(d), dict({"content-type": "application/json"}, **(headers or {})))
    def server(name, handle):
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def go(self):
                ln = int(self.headers.get("content-length") or 0); body = self.rfile.read(ln).decode() if ln else ""
                u = urllib.parse.urlsplit(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                W["calls"].append((name, self.command, u.path, dict(self.headers), body))
                handle(self, u.path, q, body)
            do_GET = do_POST = go
        s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=s.serve_forever, daemon=True).start()
        return s, f"http://127.0.0.1:{s.server_address[1]}"
    def google(h, p, q, body):
        lst = W["google"].get(q.get("client_id"))
        if lst is None: return reply(h, 302, headers={"location": f"https://accounts.google.com/signin/oauth/error?authError={b64u(chr(10) + chr(14) + 'invalid_client')}"})
        reply(h, 302, headers={"location": "https://accounts.google.com/v3/signin/identifier?x=1" if q.get("redirect_uri") in lst
                               else f"https://accounts.google.com/signin/oauth/error?authError={b64u(chr(10) + chr(21) + 'redirect_uri_mismatch')}&client_id=x"})
    def github(h, p, q, body):
        if p == "/login/oauth/authorize": return reply(h, 302, headers={"location": f"https://github.com/login?client_id={q.get('client_id')}&return_to=x"})
        if p == "/login": return reply(h, 200, f"<p>Sign in to <strong>GitHub</strong>{'<br>to continue to <strong>Platform App</strong>' if q.get('client_id') == GH else ''}</p>")
        reply(h, 404)
    holds = lambda o: W["env"] == "development" or any(host(o) == d or host(o).endswith("." + d) for d in W["domains"])
    def clerk_api(h, p, q, body):
        if h.headers.get("authorization") != f"Bearer {SK}": return js(h, 401, {})
        if p == "/v1/instance": return js(h, 200, {"environment_type": W["env"], "allowed_origins": []})
        if p == "/v1/domains": return js(h, 200, {"data": [{"name": d} for d in W["domains"]]})
        js(h, 404, {})
    def fapi(h, p, q, body):
        if p == "/v1/environment": return js(h, 200, {"user_settings": {"social": {"oauth_google": {"enabled": True, "strategy": "oauth_google", "name": "Google"},
                                                                                    "oauth_github": {"enabled": True, "strategy": "oauth_github", "name": "GitHub"}}}}) if W["social"] else js(h, 503, {})
        if p == "/v1/client": return js(h, 200, {"response": None}, {"set-cookie": ["__client=standin; Path=/", "x=1"]})
        if p == "/v1/client/sign_ins":
            f = dict(urllib.parse.parse_qsl(body))
            if not holds(h.headers.get("origin", "")): return js(h, 400, {"errors": [{"code": "origin_invalid", "meta": {"param_name": "redirect_url"}}]})
            cb = urllib.parse.quote(f"{FAPI}/v1/oauth_callback", safe="")
            ext = f"https://accounts.google.com/o/oauth2/auth?client_id={CG}&redirect_uri={cb}" if f["strategy"] == "oauth_google" else f"https://github.com/login/oauth/authorize?client_id={GH}&redirect_uri={cb}"
            return js(h, 200, {"response": {"first_factor_verification": {"external_verification_redirect_url": ext}}})
        if p == "/.well-known/oauth-authorization-server": return js(h, 200, dict({"issuer": FAPI}, **({"registration_endpoint": f"{FAPI}/oauth/register"} if W["registration"] else {})))
        js(h, 404, {})
    def acme(h, p, q, body):
        if q.get("redirect_uri") in W["acme"]: return reply(h, 302, headers={"location": "https://login.acme.test/login"})
        js(h, 400, {"error": "invalid_request", "error_description": "The redirect_uri is not registered for this client"})
    def app(h, p, q, body):
        if p == "/.well-known/oauth-protected-resource/mcp": return js(h, 200, {"resource": W["resource"]})
        if p == "/api/cron/sign-in-check":
            if not W["report"]: return js(h, 404, {"error": "Not found"})
            if h.headers.get("authorization") != f"Bearer {CRON}": return js(h, 401, {})
            uri = f"{FRONT}/api/github-app/callback"; cc = f"{FRONT}/api/credential-connections/callback"
            return js(h, 200, {"front_door": FRONT, "flows": [
                {"id": "github_app.callback", "label": "GitHub App: callback", "provider": "github", "redirect_uri": uri, "path": "/api/github-app/callback", "result": "pass",
                 "detail": "someone came back here", "where": GITHUB_APP_WHERE, "steps": github_steps(uri), "client_id": GH, "authorize_url": "https://github.com/login/oauth/authorize"},
                {"id": "oauth.pack.acme", "label": "Acme (credential connection)", "provider": "acme", "redirect_uri": cc, "path": "/api/credential-connections/callback", "result": "unknown",
                 "detail": "x", "where": "Acme's console", "steps": ["Add:", f"    {cc}"], "client_id": ACME, "authorize_url": "https://login.acme.test/authorize"},
                {"id": "mcp", "label": "ignored: the factory reads its own"}]})
        js(h, 404, {})
    servers = [server(n_, f_) for n_, f_ in (("google", google), ("github", github), ("clerk_api", clerk_api), ("fapi", fapi), ("acme", acme), ("app", app))]
    M = {"https://accounts.google.com": servers[0][1], "https://github.com": servers[1][1], CLERK_API: servers[2][1], FAPI: servers[3][1],
         "https://login.acme.test": servers[4][1], FRONT: servers[5][1], API: servers[5][1], NEW: servers[5][1], "https://down.example.test": "http://127.0.0.1:9"}
    REWRITE = lambda u: M[origin(u)] + u[len(origin(u)):] if origin(u) in M else u
    try:
        g = lambda cid, uri: f"https://accounts.google.com/o/oauth2/v2/auth?client_id={cid}&redirect_uri={urllib.parse.quote(uri, safe='')}"
        ok(probe_google(g(OWN, f"{FRONT}/api/auth/google/callback"))[0] == "pass", "Google lists it: pass")
        r = probe_google(g(OWN, f"{NEW}/api/auth/google/callback")); ok(r[0] == "fail" and "redirect_uri_mismatch" in r[1], "Google does not: fail, saying redirect_uri_mismatch")
        ok("invalid_client" in probe_google(g("999-x.apps.googleusercontent.com", FRONT))[1], "an unknown Google client: said")
        ok(probe_google("https://down.example.test/o/oauth2/v2/auth")[0] == "unknown", "nothing answers: unknown")
        stub = lambda st, loc=None, body="": (lambda url, **k: {"status": st, "location": loc, "body": body, "cookies": []})
        ok(probe_google("https://accounts.google.com/x", stub(200, None, "a new page"))[0] == "unknown" and probe_google("https://accounts.google.com/x", stub(302, "https://evil.example/v3/signin"))[0] == "unknown",
           "a page not understood, another site: unknown, never pass")
        r = probe_github(f"https://github.com/login/oauth/authorize?client_id={GH}&redirect_uri=x")
        ok(r[0] == "unknown" and "Platform App" in r[1], "GitHub, anonymous: unknown (it checks after a sign-in), naming the app")
        ok(probe_github("https://github.com/login/oauth/authorize?client_id=Iv1.nope")[0] == "unknown", "an unknown GitHub client: still unknown, said")
        ok(probe_github("https://github.com/x", stub(302, "https://app.example.com/cb?error=redirect_uri_mismatch"))[0] == "fail", "GitHub sending back redirect_uri_mismatch: fail")
        ok(probe_generic(f"https://login.acme.test/authorize?redirect_uri=x", "x")[0] == "fail", "another provider naming the address: fail")
        W["acme"].add("y"); ok(probe_generic(f"https://login.acme.test/authorize?redirect_uri=y", "y")[0] == "unknown", "another provider going on: unknown, never pass"); W["acme"].clear()

        clerk_vals = {"CLERK_SECRET_KEY": SK, "CRON_SECRET": CRON, "CLERK_FRONTEND_API_URL": FAPI}
        res = check("zz_app", FRONT, API, clerk_vals, {})
        ids = {f["id"]: f for f in res["flows"]}
        ok(list(ids) == ["clerk.domain", "clerk.oauth_google", "clerk.oauth_github", "github_app.callback", "oauth.pack.acme", "mcp"], "Clerk's flows, the app's key-vault flows, AI clients", list(ids))
        ok(ids["clerk.domain"]["result"] == "pass" and ids["clerk.oauth_google"]["result"] == "pass" and ids["clerk.oauth_google"]["redirect_uri"] == f"{FAPI}/v1/oauth_callback",
           "Google through Clerk: Clerk's callback, listed: pass")
        ok(ids["clerk.oauth_github"]["result"] == "unknown" and ids["github_app.callback"]["result"] == "pass", "GitHub through Clerk unknown; the app's GitHub callback as the app measured it")
        ok(ids["mcp"]["result"] == "pass", "AI clients may register with Clerk")
        ok(all(c[3].get("Authorization") == f"Bearer {SK}" for c in W["calls"] if c[0] == "clerk_api") and not any(SK in json.dumps(c[3]) for c in W["calls"] if c[0] != "clerk_api"),
           "the Clerk secret goes to Clerk's Backend API only")
        ok(all(c[3].get("Authorization") == f"Bearer {CRON}" for c in W["calls"] if c[2] == "/api/cron/sign-in-check") and not any(CRON in json.dumps(c[3]) for c in W["calls"] if c[2] != "/api/cron/sign-in-check"),
           "CRON_SECRET goes to the app's report only")
        text = json.dumps(res) + "\n".join(lines(res))
        ok(not any(s in text for s in (SK, CRON, CG, GH, ACME)), "no secret and no client id in the result or its lines (fingerprints)")

        res = check("zz_app", NEW, API, clerk_vals, {})
        ids = {f["id"]: f for f in res["flows"]}
        ok(ids["clerk.domain"]["result"] == "fail" and any("Add satellite domain" in s and "app.newco.test" in s for s in ids["clerk.domain"]["steps"]), "after a move Clerk does not hold the new address: fail, with Clerk's Domains steps")
        ok(ids["clerk.oauth_google"]["result"] == "fail" and "refused" in ids["clerk.oauth_google"]["detail"], "Clerk refuses a sign-in started there: fail")
        ok(ids["github_app.callback"]["redirect_uri"] == f"{NEW}/api/github-app/callback" and ids["github_app.callback"]["result"] == "unknown"
           and f"    {NEW}/api/github-app/callback" in ids["github_app.callback"]["steps"] and "redeploy" in ids["github_app.callback"]["detail"],
           "the app's own flows remade for the new front door, probed again there (GitHub: unknown), and the redeploy named")
        ok(ids["oauth.pack.acme"]["result"] == "fail", "Acme refuses the new address: fail")
        a = ask("zz_app", res)
        ok(a.startswith("Clerk: the app's address does not work for zz_app at https://app.newco.test") and "  1. Open https://dashboard.clerk.com" in a and "--sign-in-check" in a
           and "more sign-in(s)" in a and "Nothing secret" in a, "the plain ask: the first failure click by click, the rest one at a time", a)

        W["google"][CG].clear()
        ids = {f["id"]: f for f in check("zz_app", FRONT, API, clerk_vals, {})["flows"]}
        ok(ids["clerk.oauth_google"]["result"] == "fail" and f"    {FAPI}/v1/oauth_callback" in ids["clerk.oauth_google"]["steps"] and GOOGLE_WHERE in ids["clerk.oauth_google"]["where"],
           "Google stops listing Clerk's callback: fail, the exact address on its own line, Google Cloud Console's path")
        W["google"][CG].add(f"{FAPI}/v1/oauth_callback")
        W["social"] = False; W["registration"] = False; W["report"] = False
        res = check("zz_app", FRONT, API, dict(clerk_vals, CLERK_SECRET_KEY="sk_live_wrong"), {})
        ok([(f["id"], f["result"]) for f in res["flows"]] == [("clerk.domain", "unknown"), ("clerk.social", "unknown"), ("app", "unknown"), ("mcp", "fail")],
           "Clerk not readable, an older app: unknown, never pass; registration off: AI clients fail", [(f["id"], f["result"]) for f in res["flows"]])
        ok(failing(res) == [] and ask("zz_app", res) == "", "AI clients' registration with Clerk is said, not asked twice (provision.py's Clerk reading asks for it)")
        W["social"] = True; W["registration"] = True; W["report"] = True

        built = {"AUTH_PROVIDER": "builtin", "GOOGLE_CLIENT_ID": OWN, "CRON_SECRET": CRON}
        ids = {f["id"]: f for f in check("zz_app", FRONT, API, built)["flows"]}
        ok(ids["google"]["result"] == "pass" and ids["google"]["redirect_uri"] == f"{FRONT}/api/auth/google/callback" and ids["mcp"]["result"] == "pass", "built-in: Google's callback on the front door, AI clients on it")
        res = check("zz_app", NEW, API, built)
        ids = {f["id"]: f for f in res["flows"]}
        ok(ids["google"]["result"] == "fail" and ids["mcp"]["result"] == "fail" and "redeploy" in ids["mcp"]["detail"], "built-in after a move: Google fail; AI clients still told the old address until the redeploy")
        record(inf := {}, res)
        ok(set(inf["sign_in_redirects"]) == {"at", "front_door", "totals", "flows"} and "steps" not in json.dumps(inf) and OWN not in json.dumps(inf), "the record: the reading, no steps, no client id")
        ok(recorded_line(inf).startswith("sign-in return addresses (") and "needs you: Google" in recorded_line(inf) and recorded_line({}) == "", "one line from the record")
        ok(check("zz_app", "", API)["flows"] == [] and "no address" in lines(check("zz_app", "", API))[1], "an app with no address: nothing checked")

        ch = changes(FRONT, NEW, inf["sign_in_redirects"]["flows"])
        ok({"label": "Google (the app's own sign-in)", "old": f"{FRONT}/api/auth/google/callback", "new": f"{NEW}/api/auth/google/callback", "where": GOOGLE_WHERE} in ch,
           "before a switch: each address made of the front door, old and new, and where it is registered")
        ok(all(c["old"] != c["new"] for c in ch) and not any("oauth_callback" in c["new"] for c in ch), "Clerk's own callbacks do not change; only the front door's do")
        ok(len(changes(FRONT, NEW)) == 4 and all("(if the app uses it)" in c["label"] for c in changes(FRONT, NEW)), "with no reading: every front-door address the mold has")
    finally:
        REWRITE = None
        for s, _ in servers: s.shutdown()
    print(f"sign_in_check --self-test: {n[0]} checks passed")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv: sys.exit(self_test())
    print(__doc__); sys.exit(2)
