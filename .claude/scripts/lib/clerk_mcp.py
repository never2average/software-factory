#!/usr/bin/env python3
"""Clerk as the sign-in AI clients use on a mold's /mcp (mold_v0-116). Standard library only.

WHY. A mold_v0 app on Clerk had only CLERK_SECRET_KEY on its -api Vercel project. The API finds Clerk's Frontend API
(the OAuth server AI clients sign in at) from CLERK_FRONTEND_API_URL or a publishable key (src/clerk.ts frontendApi),
and it had neither, so /.well-known/oauth-protected-resource answered "OAuth is not configured" and the install pages
said there was no sign-in. With member keys off (profile member_keys: false) nothing else lets a client connect. And
the Clerk instance had dynamic client registration off: its /.well-known/oauth-authorization-server named no
registration_endpoint and no client_id_metadata_document_supported, so a client could not register itself even once
the API pointed at Clerk. Only the operator can turn that on, in Clerk's dashboard.

WHAT THE MOLD DECLARES (mold.json "mcp_sign_in"; a mold without it gets none of this):
  builtin     the file that makes the mold its own OAuth server under its built-in sign-in (present = /mcp sign-in works
              without Clerk)
  clerk       secret: the name whose presence puts the API on Clerk; provider_env: the switch that overrides it
              (builtin|clerk); frontend_api_env: the API's explicit Frontend API address (a proxy's; the operator's
              own, never written by the factory); publishable: {api: name the API reads, web: name the console reads}

THE FIX ON VERCEL (single_service.vercel_deploy): the console's publishable key is copied, as it is, onto the api
project under the API's own name (CLERK_PUBLISHABLE_KEY), at every deploy, when the API is on Clerk. Why that name and
not CLERK_FRONTEND_API_URL: it is the value the API is documented to read first-hand and the one a server deploy
already gives it (the compose file passes CLERK_PUBLISHABLE_KEY to the API), so both targets end the same; it is
copied, not transformed, so the API decodes it with its own code; and CLERK_FRONTEND_API_URL stays free for what it is
for (a Clerk proxy address, which then wins over the key and is never overwritten by the factory). A publishable key
is public by design (it is in every console page's scripts): it is still never printed, only the Frontend API's host.

THE CHECK (registration): GET <frontend api>/.well-known/oauth-authorization-server. `on` when it names a
registration_endpoint (dynamic client registration) or client_id_metadata_document_supported is true (Client ID
Metadata Documents); `off` when it answers JSON with neither; `unknown` otherwise (no answer, not JSON): never read as
off. provision.py's check stops for the operator (exit 3) on `off` only when member keys are off, since then nothing
else lets an AI client connect; otherwise it is a warning with the same steps.
"""
import base64, json, os, re, urllib.error, urllib.request

HOST = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]{1,5})?")
PK = re.compile(r"pk_(test|live)_([A-Za-z0-9+/=_-]{4,400})")
DASHBOARD = "https://dashboard.clerk.com"
UNSET = object()


def spec(man):
    """The mold's declaration (mold.json mcp_sign_in), or {}."""
    s = (man or {}).get("mcp_sign_in")
    return s if isinstance(s, dict) else {}


def clerk_spec(man):
    c = spec(man).get("clerk")
    return c if isinstance(c, dict) and c.get("secret") and isinstance(c.get("publishable"), dict) else {}


def frontend_from_pk(pk):
    """https://<host> named by a Clerk publishable key (pk_test_/pk_live_ + base64 of "<host>$"), else None: the same
    reading as the mold's src/clerk.ts frontendApi."""
    m = PK.fullmatch(str(pk or "").strip())
    if not m: return None
    enc = m.group(2)
    for dec in (base64.b64decode, base64.urlsafe_b64decode):
        try: host = dec(enc + "=" * (-len(enc) % 4)).decode("utf-8")
        except (ValueError, UnicodeDecodeError): continue
        host = host.rstrip("$").strip().lower()
        if HOST.fullmatch(host): return f"https://{host}"
    return None


def frontend_from_url(u):
    u = str(u or "").strip().rstrip("/")
    m = re.fullmatch(r"https://([^/\s]+)", u)
    return u if m and HOST.fullmatch(m.group(1).lower()) else None


def provider(api_vals, cs):
    """Which sign-in the API runs, from its values: 'clerk' or 'builtin' (the mold's src/auth-provider.ts rule: the
    switch wins when it says builtin or clerk, else Clerk when the secret is set). 'none' when the switch says clerk and
    the secret is not set: then neither runs (Clerk is off without its key, and the built-in sign-in is switched off)."""
    if not cs: return "builtin"
    raw = str((api_vals or {}).get(cs.get("provider_env") or "AUTH_PROVIDER") or "").strip().lower()
    has = bool(str((api_vals or {}).get(cs["secret"]) or "").strip())
    if raw == "builtin": return "builtin"
    if raw == "clerk": return "clerk" if has else "none"
    return "clerk" if has else "builtin"


def facts(man, api_vals, web_vals):
    """What the API will know about Clerk after the next deploy, from the two projects' values (held, never printed):
    {provider, frontend (https://host or None), source (where it comes from, in words), copy ({name: value} the deploy
    writes on the api project, or {})}."""
    cs = clerk_spec(man); out = {"provider": provider(api_vals, cs), "frontend": None, "source": "", "copy": {}}
    if not cs or out["provider"] != "clerk": return out
    api_vals, web_vals = api_vals or {}, web_vals or {}
    a_name, w_name = cs["publishable"].get("api"), cs["publishable"].get("web")
    fa = cs.get("frontend_api_env")
    web_pk = str(web_vals.get(w_name) or "").strip() if w_name else ""
    if a_name and frontend_from_pk(web_pk) and str(api_vals.get(a_name) or "").strip() != web_pk:
        out["copy"] = {a_name: web_pk}
    if fa and frontend_from_url(api_vals.get(fa)):
        out.update(frontend=frontend_from_url(api_vals.get(fa)), source=f"{fa} on the API (the operator's own address for Clerk; kept)")
    elif frontend_from_pk(web_pk):
        out.update(frontend=frontend_from_pk(web_pk), source=f"the console's {w_name}" + (f", copied to the API as {a_name} at the deploy" if out["copy"] else f", which the API holds as {a_name}"))
    elif a_name and frontend_from_pk(api_vals.get(a_name)):
        out.update(frontend=frontend_from_pk(api_vals.get(a_name)), source=f"{a_name} on the API")
    return out


def _read_json(url, timeout=10):
    """(status, parsed JSON or None, why). Read-only GET; never raises."""
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "software-factory-check"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: body, code = r.read(200_000), r.status
    except urllib.error.HTTPError as e: return e.code, None, f"HTTP {e.code}"
    except Exception as e: return None, None, f"{type(e).__name__}: {str(e)[:120]}"
    try: return code, json.loads(body.decode("utf-8")), ""
    except (ValueError, UnicodeDecodeError): return code, None, f"HTTP {code}, not JSON"


def registration(frontend, read_json=None):
    """{state: on|off|unknown, dcr, cimd, said}: can an AI client register itself with this Clerk instance?"""
    code, doc, why = (read_json or _read_json)(frontend.rstrip("/") + "/.well-known/oauth-authorization-server")
    if str(code) != "200" or not isinstance(doc, dict):
        return {"state": "unknown", "dcr": False, "cimd": False, "said": why or f"HTTP {code}"}
    dcr = isinstance(doc.get("registration_endpoint"), str) and doc["registration_endpoint"].startswith("https://")
    cimd = doc.get("client_id_metadata_document_supported") is True
    said = " and ".join(x for x, on in (("dynamic client registration", dcr), ("Client ID Metadata Documents", cimd)) if on)
    return {"state": "on" if dcr or cimd else "off", "dcr": dcr, "cimd": cimd,
            "said": f"{said} on" if said else "no registration_endpoint and no client_id_metadata_document_supported"}


def host_of(frontend): return re.sub(r"^https://", "", str(frontend or "")).rstrip("/")


def steps(app_id, frontend):
    """Click by click, for the operator (AGENTS.md "Asking the operator for something")."""
    return [
        f"Open {DASHBOARD} and sign in to Clerk.",
        f"Click the application {app_id} signs people in with (its sign-in address is {host_of(frontend)}). If the top of "
        "the page has a Development / Production switch, pick the one whose address matches.",
        "Click Configure in the menu along the top.",
        "In the menu on the left, click OAuth applications.",
        "Click the Settings tab.",
        "Turn on Dynamic client registration. If a switch named Client ID Metadata Documents is there too, turn it on as well.",
        "If a Save button appears, click it.",
    ]


def ask(app_id, frontend, keys_off):
    """The plain request: what, why, the steps, what happens next and why it is safe."""
    why = ("Member API keys are off for this app, so signing in is the only way an AI app can connect to it, and right now "
           "it cannot." if keys_off else
           "AI apps can still connect with a member's API key, but signing in (the easier way) does not work yet.")
    return (f"{app_id} needs one setting turned on in Clerk, the service that signs its users in, so AI apps such as Claude "
            f"or ChatGPT can sign people in to it. {why} It takes about a minute:\n"
            + "\n".join(f"  {i}. {s}" for i, s in enumerate(steps(app_id, frontend), 1))
            + f"\nThen say it is done, and the check runs again: python3 .claude/scripts/provision.py {app_id}\n"
            "It is safe: the setting only lets an AI app ask Clerk for a sign-in page; nobody gets in without signing in "
            "with their own account, and nothing is shared or stored by turning it on.")


def member_keys_off(app, root, mold_id=None):
    """True when the app's /mcp takes no member API keys (profile member_keys: false): the app's own state first, then
    its build copy's profile.json (a host pack may set it), then the mold's own profile.json."""
    prof = (app or {}).get("profile")
    if isinstance(prof, dict) and isinstance(prof.get("member_keys"), bool): return prof["member_keys"] is False
    mid = mold_id or (app or {}).get("mold_id") or ""
    for p in (os.path.join(root, "build", str((app or {}).get("app_id") or "-"), "profile.json"),
              os.path.join(root, "molds", str(mid), "codebase", "profile.json")):
        try: v = json.load(open(p)).get("member_keys")
        except (OSError, ValueError, AttributeError): continue
        if isinstance(v, bool): return v is False
    return False


def judge(app_id, man, api_vals, web_vals, keys_off, read_json=None):
    """The check's reading for a Vercel app. -> {lines: [said], block: None | (kind, name, how, summary), copy, facts,
    registration}. block is set only when nothing lets an AI client connect (member keys off)."""
    cs = clerk_spec(man); out = {"lines": [], "block": None, "copy": {}, "facts": None, "registration": None}
    if not cs: return out
    f = facts(man, api_vals, web_vals); out["facts"] = f; out["copy"] = f["copy"]
    keys = "member API keys are off, so signing in is the only way in" if keys_off else "member API keys still let AI clients connect"
    pe, w_name = cs.get("provider_env") or "AUTH_PROVIDER", cs["publishable"].get("web")
    if f["provider"] == "builtin":
        out["lines"].append("  AI clients' sign-in on /mcp: the app's own (built-in sign-in; Clerk is not in use)"); return out
    if f["provider"] == "none":
        msg = (f"{pe} says clerk on the API but {cs['secret']} is not set there, so neither Clerk nor the built-in sign-in "
               f"runs: no AI client can sign in ({keys})")
        out["lines"].append("  " + ("NOT READY: " if keys_off else "WARNING: ") + msg)
        if keys_off: out["block"] = ("secret", cs["secret"], None, msg)
        return out
    if f["copy"]: out["lines"].append(f"  the deploy copies the console's {w_name} (a public key) onto the API as {', '.join(f['copy'])}, so the API finds Clerk's sign-in server")
    if not f["frontend"]:
        msg = (f"the API is on Clerk but cannot find Clerk's sign-in server: no publishable key on the console ({w_name}) or the API, "
               f"so /mcp's sign-in answers \"OAuth is not configured\" ({keys})")
        out["lines"].append("  " + ("NOT READY: " if keys_off else "WARNING: ") + msg)
        if keys_off: out["block"] = ("secret", w_name, None, msg)
        return out
    reg = registration(f["frontend"], read_json); out["registration"] = reg
    where = f"Clerk ({host_of(f['frontend'])}, from {f['source']})"
    if reg["state"] == "on":
        out["lines"].append(f"  AI clients' sign-in on /mcp: {where}; {reg['said']}, so a client registers itself and signs in")
    elif reg["state"] == "unknown":
        out["lines"].append(f"  AI clients' sign-in on /mcp: {where}; whether a client may register itself could not be read ({reg['said']}); not read as off")
    else:
        msg = f"{where} lets no AI client register itself ({reg['said']}); {keys}"
        out["lines"].append("  " + ("NOT READY: " if keys_off else "WARNING: ") + msg)
        out["lines"] += ["    " + l for l in ask(app_id, f["frontend"], keys_off).splitlines()]
        if keys_off: out["block"] = ("approval", "Clerk dynamic client registration", ask(app_id, f["frontend"], True), msg)
    return out


def self_test():
    """Offline: keys, provider, facts and the registration reading against stand-ins."""
    fails = []
    def ok(c, m):
        if not c: fails.append(m)
    host = "clerk.app-one.example.test"
    pk = "pk_live_" + base64.b64encode((host + "$").encode()).decode()
    pk2 = "pk_test_" + base64.b64encode(b"other-one.clerk.accounts.dev$").decode().rstrip("=")
    ok(frontend_from_pk(pk) == f"https://{host}" and frontend_from_pk(pk2) == "https://other-one.clerk.accounts.dev", "a publishable key names its Frontend API (padded or not)")
    for bad in ("", "standin", "pk_live_", "sk_live_" + pk[8:], "pk_live_" + base64.b64encode(b"not a host$").decode(), None):
        ok(frontend_from_pk(bad) is None, f"not a publishable key: {bad!r}")
    man = {"mcp_sign_in": {"builtin": "src/mcp-oauth.ts", "clerk": {"secret": "CLERK_SECRET_KEY", "provider_env": "AUTH_PROVIDER", "frontend_api_env": "CLERK_FRONTEND_API_URL",
                                                                    "publishable": {"api": "CLERK_PUBLISHABLE_KEY", "web": "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"}}}}
    S = "sk_live_standin"
    ok(provider({}, clerk_spec(man)) == "builtin" and provider({"CLERK_SECRET_KEY": S}, clerk_spec(man)) == "clerk"
       and provider({"CLERK_SECRET_KEY": S, "AUTH_PROVIDER": "builtin"}, clerk_spec(man)) == "builtin" and provider({"AUTH_PROVIDER": "Clerk"}, clerk_spec(man)) == "none"
       and provider({"CLERK_SECRET_KEY": S, "AUTH_PROVIDER": "other"}, clerk_spec(man)) == "clerk" and provider({"CLERK_SECRET_KEY": S}, {}) == "builtin", "the provider: the mold's own rule")
    f = facts(man, {"CLERK_SECRET_KEY": S}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk})
    ok(f["frontend"] == f"https://{host}" and f["copy"] == {"CLERK_PUBLISHABLE_KEY": pk}, f"the live case: only the secret on the API -> the console's key is copied: {f}")
    f = facts(man, {"CLERK_SECRET_KEY": S, "CLERK_PUBLISHABLE_KEY": pk}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk})
    ok(f["frontend"] and f["copy"] == {}, "already the same: nothing to write")
    f = facts(man, {"CLERK_SECRET_KEY": S, "CLERK_PUBLISHABLE_KEY": pk2}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk})
    ok(f["copy"] == {"CLERK_PUBLISHABLE_KEY": pk} and f["frontend"] == f"https://{host}", "a different key on the API: the console's wins (one Clerk instance for both)")
    f = facts(man, {"CLERK_SECRET_KEY": S, "CLERK_FRONTEND_API_URL": "https://auth.app-one.example.test/"}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk})
    ok(f["frontend"] == "https://auth.app-one.example.test" and f["copy"] == {"CLERK_PUBLISHABLE_KEY": pk} and "kept" in f["source"], f"a proxy address on the API wins and is kept: {f}")
    f = facts(man, {"CLERK_SECRET_KEY": S, "CLERK_PUBLISHABLE_KEY": pk}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "[SENSITIVE]"})
    ok(f["frontend"] == f"https://{host}" and f["copy"] == {}, "an unreadable console key: the API's own key is used, nothing written")
    f = facts(man, {"CLERK_SECRET_KEY": S}, {})
    ok(f["frontend"] is None and f["copy"] == {}, "no key anywhere: no Frontend API, nothing written")
    ok(facts(man, {}, {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk})["copy"] == {}, "a built-in app gets no Clerk key on its API")
    # registration
    rj = lambda doc, code=200: (lambda url: (code, doc, "") if url == f"https://{host}/.well-known/oauth-authorization-server" else (None, None, "wrong url " + url))
    ok(registration(f"https://{host}", rj({"issuer": "x", "registration_endpoint": f"https://{host}/oauth/register"}))["state"] == "on", "DCR on")
    ok(registration(f"https://{host}", rj({"issuer": "x", "client_id_metadata_document_supported": True}))["state"] == "on", "CIMD on")
    r = registration(f"https://{host}", rj({"issuer": "x", "authorization_endpoint": "https://x/a"}))
    ok(r["state"] == "off" and "registration_endpoint" in r["said"], f"neither: off: {r}")
    ok(registration(f"https://{host}", rj({"client_id_metadata_document_supported": "true", "registration_endpoint": "http://x"}))["state"] == "off", "a non-boolean flag and a plain-http endpoint are not on")
    ok(registration(f"https://{host}", rj(None, 502))["state"] == "unknown" and registration(f"https://{host}", lambda u: (None, None, "URLError"))["state"] == "unknown", "no answer: unknown, never off")
    # judge
    keys = {"CLERK_SECRET_KEY": S}; web = {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": pk}
    off = rj({"issuer": "x"}); on = rj({"registration_endpoint": f"https://{host}/oauth/register"})
    j = judge("zz_app", man, keys, web, True, off)
    ok(j["block"] and j["block"][0] == "approval" and "Dynamic client registration" in j["block"][2] and "OAuth applications" in j["block"][2] and "Configure" in j["block"][2]
       and pk not in "\n".join(j["lines"]) and j["copy"], f"keys off + registration off: a human is needed, with the steps; the key never said: {j['lines']}")
    j = judge("zz_app", man, keys, web, False, off)
    ok(j["block"] is None and any("WARNING" in l for l in j["lines"]) and any("Dynamic client registration" in l for l in j["lines"]), "keys on + registration off: a warning with the steps")
    j = judge("zz_app", man, keys, web, True, on)
    ok(j["block"] is None and not any("WARNING" in l or "NOT READY" in l for l in j["lines"]), "registration on: ready")
    j = judge("zz_app", man, keys, web, True, lambda u: (None, None, "timeout"))
    ok(j["block"] is None and any("could not be read" in l for l in j["lines"]), "Clerk not answering: said, never blocks")
    j = judge("zz_app", man, keys, {}, True, on)
    ok(j["block"] and j["block"][:2] == ("secret", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), f"keys off, no publishable key anywhere: the key is asked for: {j['block']}")
    j = judge("zz_app", man, keys, {}, False, on)
    ok(j["block"] is None and any("WARNING" in l and "OAuth is not configured" in l for l in j["lines"]), "keys on, no publishable key: a warning")
    j = judge("zz_app", man, {"AUTH_PROVIDER": "clerk"}, web, True, on)
    ok(j["block"] and j["block"][:2] == ("secret", "CLERK_SECRET_KEY"), "AUTH_PROVIDER=clerk without the secret, keys off: neither sign-in runs: refused")
    j = judge("zz_app", man, {}, web, True, lambda u: ok(False, "a built-in app never asks Clerk") or (None, None, ""))
    ok(j["block"] is None and "built-in" in j["lines"][0], "built-in sign-in: nothing asked of Clerk")
    ok(judge("zz_app", {}, keys, web, True, off) == {"lines": [], "block": None, "copy": {}, "facts": None, "registration": None}, "a mold that declares nothing: nothing")
    return fails


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        bad = self_test()
        for b in bad: print("FAIL:", b)
        print(f"clerk_mcp self-test: {'ok' if not bad else str(len(bad)) + ' failed'}"); sys.exit(1 if bad else 0)
    print(__doc__); sys.exit(2)
