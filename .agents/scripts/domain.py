#!/usr/bin/env python3
"""domain.py <app_id> status | attach <domain> | verify | switch   |   --self-test

Give a Vercel application its own web address (research.example.com instead of <project>.vercel.app).

  status   the address the app answers on now, the domain state names, what DNS says, whether it serves the app
  attach   record the domain in infrastructure.vercel.custom_domain, add it to the app's Vercel project, and
           print the ONE DNS record the domain's owner has to create. Changes nothing the app's users see.
  verify   DNS points at Vercel and https://<domain>/api/ops/health answers 200. Read-only.
  switch   only after verify passes: the domain becomes the app's front door — production_url, WEB_ORIGIN on
           the web and api projects (emailed links, the MCP origin check). Prints what still has to follow:
           a redeploy, the Google sign-in origin, and a new version of the app's agent package.

The *.vercel.app address keeps working after a switch; nothing is taken away.

A single-service mold (molds/<mold_id>/mold.json "shape": "single_service", e.g. mold_v0) runs on Vercel as two
projects: the console <project>, which people open and which carries the API's own paths, and the API <project>-api.
The domain is the console's. For such an app verify reads https://<domain><the console's proxied health path> (mold.json
vercel.projects.web.proxied_health, else health_path, /healthz) and wants 200 with {"ok": true}: the API's own answer,
come through the console. switch first asks Vercel that the domain is filed under the console project (the deploy keeps
it as the front door only then), writes the API's settings made from the console's address (mold.json
vercel.projects.api.env: OCTILLION_CONSOLE_URL, which sign-in codes, invitations, emailed links and Clerk's accepted
sign-in origins are built on) on the API project, and moves production_url; a redeploy makes the API read it.
"""
import json, os, re, socket, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
VERCEL_CNAME = "cname.vercel-dns.com"; VERCEL_A = "76.76.21.21"

def load(p): return json.load(open(p))

def docs(app_id):
    p = os.path.join(ROOT, "state", "application", app_id, "infrastructure.json")
    if not os.path.exists(p): sys.exit(f"{app_id}: no state/application/{app_id}/infrastructure.json")
    infra = load(p)
    if infra.get("target") != "vercel" or not infra.get("vercel", {}).get("project"):
        sys.exit(f"{app_id} is not a deployed Vercel application; a vm application's address is set where its reverse proxy is")
    return infra, p

def is_apex(domain):
    """example.com / example.co.in are apex; anything with one more label is a subdomain. Two-part public
    suffixes are the common trap, so the short list here errs toward calling a name an apex."""
    parts = domain.split(".")
    two = ".".join(parts[-2:]) in ("co.in", "co.uk", "com.au", "co.jp", "com.sg", "net.in", "org.in", "firm.in", "gen.in", "ind.in")
    return len(parts) == (3 if two else 2)

def dns_record(domain):
    if is_apex(domain): return dict(type="A", name="@", value=VERCEL_A)
    apex_len = 3 if is_apex(".".join(domain.split(".")[-3:])) and len(domain.split(".")) > 3 else 2
    return dict(type="CNAME", name=".".join(domain.split(".")[:-apex_len]), value=VERCEL_CNAME)

def resolves(domain):
    try: return sorted({a[4][0] for a in socket.getaddrinfo(domain, 443)})
    except OSError: return []

def healthy(domain):
    try:
        with urllib.request.urlopen(f"https://{domain}/api/ops/health", timeout=15) as r: return r.status == 200
    except Exception: return False

def save(infra, p): json.dump(infra, open(p, "w"), indent=2); open(p, "a").write("\n")

# ---- single-service molds (mold_v0: the console and API projects) ------------------------------------------------
SCRIPTS = os.path.dirname(os.path.abspath(__file__))

def single(app_id):
    """The app's mold manifest when it declares the single-service shape, else None (every mold_v1 path, unchanged)."""
    try: mold_id = load(os.path.join(ROOT, "state", "application", app_id, "application.json")).get("mold_id")
    except (OSError, ValueError, AttributeError): return None
    try: man = load(os.path.join(ROOT, "molds", str(mold_id or ""), "mold.json"))
    except (OSError, ValueError): return None
    return man if isinstance(man, dict) and man.get("shape") == "single_service" else None

def _web(man): return ((man.get("vercel") or {}).get("projects") or {}).get("web") or {}
def proxied_health(man): return _web(man).get("proxied_health") or man.get("health_path") or "/healthz"

def read_health(url):
    """(http status or 0, the JSON body when it is an object, else None). Read-only."""
    try:
        with urllib.request.urlopen(url, timeout=15) as r: code, body = r.status, r.read(65536)
    except urllib.error.HTTPError as e: return e.code, None
    except Exception: return 0, None
    try: doc = json.loads(body)
    except ValueError: doc = None
    return code, doc if isinstance(doc, dict) else None

def single_healthy(domain, man):
    """(ok, what was read): the API's health answers 200 {"ok": true} THROUGH the console on the domain. The console
    has no health route of its own; it hands the API's paths to the API, so this answer proves both."""
    path = proxied_health(man); code, doc = read_health(f"https://{domain}{path}")
    if code == 200 and doc is not None and doc.get("ok") is True: return True, f"https://{domain}{path}: 200 ok, the console on {domain} reaches the API"
    said = "no answer" if not code else f"HTTP {code}" + ("" if doc is not None else ", not a health document") + (", not ok" if doc is not None else "")
    return False, f"https://{domain}{path}: {said}, so the domain does not serve the app through its console yet"

def _provision():
    sys.path.insert(0, SCRIPTS)
    import provision
    return provision

def console_owns(infra, url, cwd):
    """(ok, why): Vercel files the domain under the console project (the base name), as the deploy's front-door rule asks."""
    P = _provision()
    return P.vercel_addr.guard_app(infra, url, api=P._addr_api(cwd, infra), roles=("",))

def set_env(name, value, cwd, project): _provision()._set_env(name, value, cwd, project=project)
def env_names(cwd, project): return _provision().vercel_env_names(cwd, project)

def console_settings(man, url):
    """The API project's settings that are made from the console's address (mold.json vercel.projects.api.env with
    {console_url}), filled with `url`; the ones that do not depend on it are the deploy's to write."""
    sys.path.insert(0, os.path.join(SCRIPTS, "lib"))
    import single_service as SS
    fixed = SS.api_settings(man, None)
    return {n: v for n, v in SS.api_settings(man, url).items() if n not in fixed}

def verify_single(d, man, quiet):
    ips = resolves(d); ok, said = single_healthy(d, man) if ips else (False, f"https://{d}{proxied_health(man)}: not read, the name does not resolve")
    ok = bool(ips) and ok
    if not quiet or not ok:
        print(f"DNS: {', '.join(ips) if ips else 'does not resolve yet (a new record can take up to an hour)'}")
        print(said)
    return 0 if ok else 1

def switch_single(app_id, infra, p, man):
    v = infra["vercel"]; d = v["custom_domain"]; url = f"https://{d}"
    api = (v.get("projects") or {}).get("api") or f"{v['project']}-api"
    cwd = os.path.join(ROOT, "build", app_id) if os.path.isdir(os.path.join(ROOT, "build", app_id)) else ROOT
    ok, why = console_owns(infra, url, cwd)
    if not ok: sys.exit(f"{why}\nnothing was switched: a deploy keeps {d} as the front door only when Vercel files it under the console project {v['project']}")
    want = console_settings(man, url)
    for n, val in want.items(): set_env(n, val, cwd, api)
    held = env_names(cwd, api)
    old = v.get("production_url"); v["production_url"] = url; save(infra, p)
    secrets = set(infra.get("secrets_user") or []) | set(infra.get("secrets_derived") or [])
    clerk = any(x.startswith("CLERK_") for x in secrets)
    print(f"front door: {old} -> {url} (the old address keeps working" + (", but once the API is redeployed it accepts Clerk sign-ins made on the new address, not the old one)" if clerk else ")"))
    if want: print(f"  {api}: {', '.join(f'{n}={val}' for n, val in want.items())} written; it applies at the next deploy")
    if "CLERK_AUTHORIZED_PARTIES" in held:
        print(f"  NOTE: {api} holds CLERK_AUTHORIZED_PARTIES, which replaces the sign-in origins made from the console's address: add {url} to it, or Clerk sign-ins on {d} are refused")
    if "GOOGLE_REDIRECT_URI" in held:
        print(f"  NOTE: {api} holds GOOGLE_REDIRECT_URI, which pins where Google sends people back: set it to {url}/api/auth/google/callback, or Google sign-in keeps returning to the old address")
    print("still to do, in this order:")
    n = 1
    print(f"  {n}. redeploy so the API reads the console's new address (until then sign-in codes, invitations and emailed links still point at {old}): "
          f"python3 .claude/scripts/provision.py {app_id} --deploy (the deploy keeps {url} as the front door)")
    if (infra.get("google") or {}).get("client_id") or "GOOGLE_CLIENT_ID" in secrets:
        n += 1; print(f"  {n}. the operator adds {url} to the Google sign-in client's Authorised JavaScript origins and {url}/api/auth/google/callback to its Authorised redirect URIs (the Google button fails on the new address until then; emailed codes work at once)")
    if clerk:
        n += 1; print(f"  {n}. Clerk: a production Clerk instance is tied to one domain (its publishable key names it). For {d} the operator either moves the instance to it or adds it as a satellite domain in the Clerk dashboard, including the DNS records Clerk lists; until then Clerk sign-in may not load on the new address")
    if infra.get("agent_cli"):
        n += 1; print(f"  {n}. a new version of {infra['agent_cli']['package']} with the new address: python3 .claude/scripts/agent_cli.py {app_id} publish")
    return 0

def status(app_id):
    infra, _ = docs(app_id); v = infra["vercel"]; d = v.get("custom_domain")
    print(f"front door   {v.get('production_url')}")
    print(f"own domain   {d or 'none named (domain.py ' + app_id + ' attach <domain>)'}")
    if d:
        ips = resolves(d); print(f"DNS          {', '.join(ips) if ips else 'does not resolve yet'}")
        man = single(app_id)
        print(f"serves app   {'yes' if (single_healthy(d, man)[0] if man else healthy(d)) else 'no'}")
    return 0

def attach(app_id, domain):
    domain = domain.lower().strip().removeprefix("https://").rstrip("/")
    if not DOMAIN.match(domain): sys.exit(f"{domain!r} is not a domain name (expected something like research.example.com)")
    if domain.endswith(".vercel.app"): sys.exit("that is the address the app already has")
    infra, p = docs(app_id); v = infra["vercel"]; scope = ["--scope", v["team"]] if v.get("team") else []
    r = subprocess.run(["vercel", "domains", "add", domain, v["project"], *scope], capture_output=True, text=True)
    out = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr)
    if r.returncode and "already" not in out.lower():
        print(out.strip()[-600:], file=sys.stderr); sys.exit("Vercel did not accept the domain; nothing was recorded")
    v["custom_domain"] = domain; save(infra, p)
    rec = dns_record(domain)
    print(f"{domain} is attached to the Vercel project {v['project']} and recorded. The app's address has NOT changed yet.")
    print(f"DNS record for the domain's owner to create:  type {rec['type']}   name {rec['name']}   value {rec['value']}")
    print(f"then: python3 .claude/scripts/domain.py {app_id} verify")
    return 0

def verify(app_id, quiet=False):
    infra, _ = docs(app_id); d = infra["vercel"].get("custom_domain")
    if not d: sys.exit("no domain is attached yet")
    man = single(app_id)
    if man: return verify_single(d, man, quiet)
    ips = resolves(d); ok = bool(ips) and healthy(d)
    if not quiet or not ok:
        print(f"DNS: {', '.join(ips) if ips else 'does not resolve yet (a new record can take up to an hour)'}")
        print(f"https://{d}/api/ops/health: {'200, the app answers' if ok else 'no answer from the app yet'}")
    return 0 if ok else 1

def switch(app_id):
    if verify(app_id, quiet=True): sys.exit("the domain does not serve the app yet, so nothing was switched")
    infra, p = docs(app_id); man = single(app_id)
    if man: return switch_single(app_id, infra, p, man)
    v = infra["vercel"]; d = v["custom_domain"]; url = f"https://{d}"
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import provision
    cwd = os.path.join(ROOT, "build", app_id) if os.path.isdir(os.path.join(ROOT, "build", app_id)) else ROOT
    for proj in (v["project"], f"{v['project']}-api"): provision._set_env("WEB_ORIGIN", url, cwd, project=proj)
    old = v.get("production_url"); v["production_url"] = url; save(infra, p)
    print(f"front door: {old} -> {url} (the old address keeps working)")
    print("still to do, in this order:")
    print(f"  1. redeploy so WEB_ORIGIN takes effect: python3 .claude/scripts/provision.py {app_id} --deploy")
    if infra.get("google", {}).get("client_id"): print(f"  2. the operator adds {url} to the Google sign-in client's Authorised JavaScript origins (Google button will not show on the new address until then; emailed codes work at once)")
    if infra.get("agent_cli"): print(f"  3. a new version of {infra['agent_cli']['package']} with the new address: python3 .claude/scripts/agent_cli.py {app_id} publish")
    return 0

def self_test():
    assert DOMAIN.match("research.onfinance.ai") and not DOMAIN.match("https://x.com") and not DOMAIN.match("nodots")
    assert is_apex("onfinance.ai") and is_apex("example.co.in") and not is_apex("hfc.onfinance.ai") and not is_apex("a.example.co.in")
    assert dns_record("onfinance.ai") == dict(type="A", name="@", value=VERCEL_A)
    assert dns_record("hfc.onfinance.ai") == dict(type="CNAME", name="hfc", value=VERCEL_CNAME)
    assert dns_record("a.b.onfinance.ai")["name"] == "a.b" and dns_record("hfc.example.co.in")["name"] == "hfc"
    n = 10 + single_self_test()
    print(f"domain: {n} checks passed"); return 0

def single_self_test():
    """A mold_v0 app (two Vercel projects) and a mold_v1 app in a throwaway root, offline: DNS, the health reads, Vercel's
    domain list and its env writes are stand-ins here, and socket/subprocess/urlopen refuse if anything tries the real
    thing. Returns the number of checks."""
    import contextlib, io, shutil, tempfile
    g = globals(); keep = {k: g[k] for k in ("ROOT", "resolves", "read_health", "healthy", "console_owns", "set_env", "env_names")}
    real = (socket.getaddrinfo, subprocess.run, urllib.request.urlopen)
    def refuse(*a, **k): raise AssertionError("the self-test tried to reach the network or run a command")
    sys.path.insert(0, os.path.join(SCRIPTS, "lib"))
    import single_service   # imported BEFORE the stand-ins below: it binds subprocess.run as default arguments
    tmp = tempfile.mkdtemp(prefix="domain-selftest-"); n = 0
    try:
        socket.getaddrinfo = subprocess.run = urllib.request.urlopen = refuse
        g["ROOT"] = tmp
        os.makedirs(os.path.join(tmp, "molds", "mold_v0")); os.makedirs(os.path.join(tmp, "molds", "mold_v1"))
        shutil.copyfile(os.path.join(keep["ROOT"], "molds", "mold_v0", "mold.json"), os.path.join(tmp, "molds", "mold_v0", "mold.json"))
        json.dump({"id": "mold_v1"}, open(os.path.join(tmp, "molds", "mold_v1", "mold.json"), "w"))
        def app(app_id, mold_id, projects=None, **extra):
            d = os.path.join(tmp, "state", "application", app_id); os.makedirs(d, exist_ok=True)
            json.dump({"app_id": app_id, "mold_id": mold_id, "status": "stamped"}, open(os.path.join(d, "application.json"), "w"))
            v = {"team": "team-x", "project": app_id, "production_url": f"https://{app_id}.vercel.app", "custom_domain": f"{app_id}.example.com"}
            if projects: v.update(projects=projects, api_url=f"https://{app_id}-api.vercel.app")
            json.dump(dict({"target": "vercel", "vercel": v, "secrets_user": []}, **extra), open(os.path.join(d, "infrastructure.json"), "w"))
            return os.path.join(d, "infrastructure.json")
        ip = app("mv0", "mold_v0", projects={"api": "mv0-api", "web": "mv0"}, google={"client_id": "x.apps.googleusercontent.com"})
        app("mv1", "mold_v1")
        def run(f, *a):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                try: rc = f(*a)
                except SystemExit as e: rc = e.code
            return rc, out.getvalue()
        reads = []; wrote = []; owns = {"ok": True}
        g["resolves"] = lambda d: ["76.76.21.21"]
        def fake_read(url):
            reads.append(url); return answers.get(url, (0, None))
        g["read_health"] = fake_read
        g["healthy"] = lambda d: reads.append(f"https://{d}/api/ops/health") or True
        g["console_owns"] = lambda infra, url, cwd: (owns["ok"], "Vercel files it under mv0" if owns["ok"] else "it is not filed under mv0")
        g["set_env"] = lambda name, value, cwd, project: wrote.append((project, name, value))
        g["env_names"] = lambda cwd, project: {"OCTILLION_CONSOLE_URL", "PUBLIC_URL"}

        # the shape is read from the mold: mold_v0 is single-service, mold_v1 is not
        assert single("mv0") and single("mv0")["shape"] == "single_service" and single("mv1") is None and single("nope") is None; n += 1
        assert proxied_health(single("mv0")) == "/healthz"; n += 1
        assert console_settings(single("mv0"), "https://mv0.example.com") == {"OCTILLION_CONSOLE_URL": "https://mv0.example.com"}; n += 1

        # verify: the console's /healthz on the domain, the API's own {"ok": true} through it
        answers = {"https://mv0.example.com/healthz": (200, {"ok": True})}
        rc, out = run(verify, "mv0")
        assert rc == 0 and reads == ["https://mv0.example.com/healthz"] and "reaches the API" in out, out; n += 1
        for bad in ((200, None), (200, {"ok": False}), (307, None), (502, {"ok": False}), (0, None)):
            answers = {"https://mv0.example.com/healthz": bad}; reads.clear()
            rc, out = run(verify, "mv0"); assert rc == 1 and "does not serve" in out, (bad, out)
        n += 1
        g["resolves"] = lambda d: []; reads.clear()
        rc, out = run(verify, "mv0"); assert rc == 1 and not reads and "does not resolve" in out, out; n += 1
        g["resolves"] = lambda d: ["76.76.21.21"]

        # status reads the same health
        answers = {"https://mv0.example.com/healthz": (200, {"ok": True})}; reads.clear()
        rc, out = run(status, "mv0"); assert rc == 0 and "serves app   yes" in out and reads == ["https://mv0.example.com/healthz"], out; n += 1

        # mold_v1 is untouched: /api/ops/health, never the console's path
        reads.clear(); rc, out = run(verify, "mv1")
        assert rc == 0 and reads == ["https://mv1.example.com/api/ops/health"] and "/api/ops/health: 200" in out, out; n += 1

        # switch refuses while the domain does not serve the app, and changes nothing
        answers = {"https://mv0.example.com/healthz": (502, None)}; wrote.clear()
        rc, out = run(switch, "mv0")
        assert rc and not wrote and load(ip)["vercel"]["production_url"] == "https://mv0.vercel.app"; n += 1

        # switch refuses when Vercel does not file the domain under the console project
        answers = {"https://mv0.example.com/healthz": (200, {"ok": True})}; owns["ok"] = False
        rc, out = run(switch, "mv0")
        assert rc and "nothing was switched" in str(rc) and not wrote and load(ip)["vercel"]["production_url"] == "https://mv0.vercel.app"; n += 1
        owns["ok"] = True

        # switch: OCTILLION_CONSOLE_URL on the API project only, production_url moved, the redeploy and Google named
        rc, out = run(switch, "mv0"); i = load(ip)
        assert rc == 0 and wrote == [("mv0-api", "OCTILLION_CONSOLE_URL", "https://mv0.example.com")], wrote; n += 1
        assert i["vercel"]["production_url"] == "https://mv0.example.com" and i["vercel"]["custom_domain"] == "mv0.example.com"; n += 1
        assert "WEB_ORIGIN" not in out and "provision.py mv0 --deploy" in out and "/api/auth/google/callback" in out and "CLERK_AUTHORIZED_PARTIES" not in out, out; n += 1
        assert out.index("redeploy") < out.index("Google"); n += 1

        # an explicit CLERK_AUTHORIZED_PARTIES on the API is named, as it overrides the origins made from the address
        g["env_names"] = lambda cwd, project: {"CLERK_AUTHORIZED_PARTIES", "GOOGLE_REDIRECT_URI"}; wrote.clear()
        rc, out = run(switch, "mv0"); assert rc == 0 and "CLERK_AUTHORIZED_PARTIES" in out and "GOOGLE_REDIRECT_URI" in out and "https://mv0.example.com" in out, out; n += 1
        # an app on Clerk is told the old address stops taking Clerk sign-ins after the redeploy, and the domain step
        i = load(ip); i["secrets_user"] = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]; i["vercel"]["production_url"] = "https://mv0.vercel.app"; save(i, ip)
        g["env_names"] = lambda cwd, project: set()
        rc, out = run(switch, "mv0"); assert rc == 0 and "not the old one" in out and "satellite" in out, out; n += 1
        return n
    finally:
        socket.getaddrinfo, subprocess.run, urllib.request.urlopen = real
        g.update(keep); shutil.rmtree(tmp, ignore_errors=True)

def main(a):
    if "--self-test" in a: return self_test()
    if len(a) >= 2 and a[1] == "status": return status(a[0])
    if len(a) == 3 and a[1] == "attach": return attach(a[0], a[2])
    if len(a) == 2 and a[1] == "verify": return verify(a[0])
    if len(a) == 2 and a[1] == "switch": return switch(a[0])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
