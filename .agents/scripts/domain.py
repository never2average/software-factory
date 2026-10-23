#!/usr/bin/env python3
"""domain.py <app_id> status | attach <domain> | verify | switch   |   --self-test

Give a Vercel application its own web address (research.example.com instead of <project>.vercel.app).

  status   the address the app answers on now, the domain state names, what DNS says, whether it serves the app
  attach   add the domain to the app's Vercel project through Vercel's project API (POST /v10/projects/<project>/domains),
           record it in infrastructure.vercel.custom_domain ONLY when Vercel holds it on the project, and print the DNS
           record the domain's owner has to create. Changes nothing the app's users see. When Vercel wants proof that
           the team owns the domain first (a name under an apex another Vercel account uses), it exits 3, needs_human,
           naming the TXT record (host _vercel at the registrar, and its value) the owner adds; then run verify.
  verify   Vercel holds the domain on the project and has verified it (when it is still waiting it asks Vercel to check
           again: POST /v9/projects/<project>/domains/<domain>/verify; exit 3 naming the TXT record while it waits),
           DNS points at Vercel, and https://<domain>/api/ops/health answers 200.
  --json   one result in the script protocol (lib/agent_result.py): exit 0 done, 1 failed, 3 needs_human.
  switch   only after verify passes: the domain becomes the app's front door — production_url, WEB_ORIGIN on
           the web and api projects (emailed links, the MCP origin check). Prints what still has to follow:
           a redeploy, the Google sign-in origin, and a new version of the app's agent package.

The *.vercel.app address keeps working after a switch; nothing is taken away.

A single-service mold (molds/<mold_id>/mold.json "shape": "single_service", e.g. mold_v0) runs on Vercel as two
projects: the console <project>, which people open and which carries the API's own paths, and the API <project>-api.
The domain is the console's (its project, vercel.projects.web, is the one attach and verify ask Vercel about). For such an app verify reads https://<domain><the console's proxied health path> (mold.json
vercel.projects.web.proxied_health, else health_path, /healthz) and wants 200 with {"ok": true}: the API's own answer,
come through the console. switch first asks Vercel that the domain is filed under the console project (the deploy keeps
it as the front door only then), writes the API's settings made from the console's address (mold.json
vercel.projects.api.env: OCTILLION_CONSOLE_URL, which sign-in codes, invitations, emailed links and Clerk's accepted
sign-in origins are built on) on the API project, and moves production_url; a redeploy makes the API read it.
"""
import json, os, re, socket, subprocess, sys, tempfile, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import agent_result as AR   # the one --json result shape, exit codes 0/1/3 (lib/agent_result.py)

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
    two = ".".join(parts[-2:]) in TWO_PART
    return len(parts) == (3 if two else 2)

TWO_PART = ("co.in", "co.uk", "com.au", "co.jp", "com.sg", "net.in", "org.in", "firm.in", "gen.in", "ind.in")

def apex_of(domain):
    """The registered name a domain sits under (research.example.co.in -> example.co.in): where its DNS is edited."""
    parts = domain.split(".")
    return ".".join(parts[-(3 if ".".join(parts[-2:]) in TWO_PART else 2):])

def registrar_host(name, domain):
    """What goes in the registrar's Name/Host box for a record called `name` under `domain`'s apex (_vercel.example.com
    -> _vercel; the apex itself -> @)."""
    apex = apex_of(domain)
    if name == apex: return "@"
    return name[:-len(apex) - 1] if name.endswith("." + apex) else name

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

# ---- what Vercel holds: the domain on the app's project, and whether Vercel has verified it ------------------------
# `vercel domains add` was not enough: for a name under an apex Vercel files with another account it answered
# {"status":"error","reason":"domain_not_owned"} and attach still recorded the domain, so it never reached the project
# and no certificate was issued. The project API adds it with verified:false and the TXT record that proves ownership.

def vapi(path, method="GET", body=None, scope=None, cwd=None):
    """(doc, err) from `vercel api`: Vercel's JSON answer ({} when none) and None, or the answer and its error as
    {"code", "message"}. A body goes in a temporary file (--input), removed afterwards. Never prints."""
    argv = ["vercel", "api", path, "-X", method, "--raw"] + (["--scope", scope] if scope else [])
    tmp = None
    try:
        if body is not None:
            fd, tmp = tempfile.mkstemp(prefix="domain-", suffix=".json")
            with os.fdopen(fd, "w") as f: json.dump(body, f)
            argv += ["--input", tmp]
        r = subprocess.run(argv, cwd=cwd or ROOT, capture_output=True, text=True, timeout=90, stdin=subprocess.DEVNULL)
    except (subprocess.TimeoutExpired, OSError) as e:
        return {}, {"code": type(e).__name__, "message": f"could not run the Vercel command line ({type(e).__name__})"}
    finally:
        if tmp:
            try: os.unlink(tmp)
            except OSError: pass
    doc = {}
    for text in (r.stdout, r.stderr):
        text = re.sub(r"\x1b\[[0-9;]*m", "", text or "").strip()
        try: doc = json.loads(text[text.index("{"):]) if "{" in text else {}
        except ValueError: doc = {}
        if isinstance(doc, dict) and doc: break
        doc = {}
    return doc, api_error(doc, r.returncode, r.stderr)

def api_error(doc, rc=0, stderr=""):
    """None when `doc` is a good answer; else {"code", "message"} from Vercel's {"error": ...} or the CLI's
    {"status": "error", "reason": ...}."""
    e = doc.get("error")
    if isinstance(e, dict): return {"code": str(e.get("code") or "error"), "message": str(e.get("message") or e.get("code") or "")[:300]}
    if e: return {"code": "error", "message": str(e)[:300]}
    if doc.get("status") == "error": return {"code": str(doc.get("reason") or "error"), "message": str(doc.get("message") or doc.get("reason") or "")[:300]}
    if rc: return {"code": "error", "message": (((stderr or "").strip().splitlines()) or ["no answer"])[-1][:300]}
    return None

def not_found(err): return bool(err) and (err["code"] == "not_found" or "not found" in err["message"].lower())

def web_project(app_id, v):
    """The project the domain belongs on: the console (vercel.projects.web) for a single-service mold, else the app's
    project, as before."""
    return ((v.get("projects") or {}).get("web") or v["project"]) if single(app_id) else v["project"]

def cwd_of(app_id): return os.path.join(ROOT, "build", app_id) if os.path.isdir(os.path.join(ROOT, "build", app_id)) else ROOT

def held(doc):
    """What a project-domain answer says: on the project, verified, and the records Vercel waits for."""
    return {"on": True, "verified": doc.get("verified") is True, "verification": [x for x in (doc.get("verification") or []) if isinstance(x, dict)]}

def domain_state(app_id, v, d):
    """{"on": True|False|None, "verified", "verification", "why"}: GET /v9/projects/<project>/domains/<d>. "on" is None
    when Vercel could not be asked (no sign-in, no network); 404 "Project Domain not found" is False."""
    doc, err = vapi(f"/v9/projects/{web_project(app_id, v)}/domains/{d}", scope=v.get("team"), cwd=cwd_of(app_id))
    if not err: return held(doc)
    if not_found(err): return {"on": False, "verified": False, "verification": [], "why": err["message"]}
    return {"on": None, "verified": False, "verification": [], "why": err["message"] or err["code"]}

def ask_verify(app_id, v, d, st):
    """Vercel is waiting for proof of ownership: ask it to check again. Returns the new state (verified or not)."""
    doc, err = vapi(f"/v9/projects/{web_project(app_id, v)}/domains/{d}/verify", "POST", scope=v.get("team"), cwd=cwd_of(app_id))
    if not err and doc.get("verified") is True: return held(doc)
    again = held(doc) if not err and doc else st
    if err and isinstance(doc.get("error"), dict) and doc["error"].get("verification"): again = dict(st, verification=doc["error"]["verification"])
    return dict(again, verified=False, why=(err or {}).get("message", ""))

def proof_records(d, st):
    return [dict(type=str(x.get("type") or "TXT").upper(), host=registrar_host(str(x.get("domain") or ""), d), name=str(x.get("domain") or ""),
                 value=str(x.get("value") or "")) for x in st.get("verification") or [] if x.get("domain") and x.get("value")]

def need_proof(app_id, d, st):
    """Print, and file as the run's needs_human, the record(s) the domain's owner adds so Vercel accepts `d`.
    Returns 3, the script protocol's "a human is needed"."""
    recs = proof_records(d, st); apex = apex_of(d); rec = dns_record(d)
    if not recs:
        how = (f"Vercel has not yet accepted that this team owns {apex}, but did not say which record it wants. Open the app's "
               f"Vercel project, then Settings, then Domains, and read what it asks for next to {d}; then tell me what it shows.")
    else:
        steps = [f"Vercel needs proof that you own {apex} before it will serve {d} and issue its security certificate. "
                 f"This is done with one extra record in {apex}'s DNS settings, at the company where {apex} is registered "
                 f"(for example GoDaddy, Namecheap, Cloudflare or Google Domains):",
                 f"1. Sign in there and open the DNS settings (sometimes called DNS records or Manage DNS) for {apex}."]
        n = 1
        for x in recs:
            n += 1; steps.append(f"{n}. Click Add record and choose the type {x['type']}.")
            n += 1; steps.append(f"{n}. In the Name (or Host) box type exactly:  {x['host']}")
            n += 1; steps.append(f"{n}. In the Value (or Content) box paste exactly:  {x['value']}")
            n += 1; steps.append(f"{n}. Leave TTL as it is and click Save.")
        steps.append(f"While you are there, check that {apex} also has the record that sends visitors to the app: "
                     f"type {rec['type']}, name {rec['name']}, value {rec['value']} (add it the same way if it is missing).")
        steps.append(f"Then tell me it is done; I will run python3 .claude/scripts/domain.py {app_id} verify. A new record can take "
                     f"from a few minutes up to an hour to be seen. The record only proves who owns the name: it holds no "
                     f"password, and nothing the app's users see changes until the address is switched.")
        how = "\n".join(steps)
    for x in recs: print(f"Vercel is waiting for proof of ownership: {x['type']} record  host {x['host']}  (full name {x['name']})  value {x['value']}")
    print(how)
    AR.need("dns", f"{recs[0]['type']} {recs[0]['name']}" if recs else f"Vercel domain check for {d}", how)
    AR.detail("verification", recs); AR.detail("domain", d)
    AR.note(summary=f"{d} is on the Vercel project but Vercel is waiting for proof that the team owns {apex}",
            next=f"the domain's owner adds the record above, then: python3 .claude/scripts/domain.py {app_id} verify")
    return AR.EXIT["needs_human"]

def vercel_check(app_id, v, d, quiet):
    """Before any health read: is the domain on the project, and verified (asking Vercel to check again when it waits)?
    Returns None to carry on, or the exit code to stop with (1 not on the project, 3 waiting for the owner's record)."""
    st = domain_state(app_id, v, d); proj = web_project(app_id, v)
    if st["on"] is None:
        print(f"Vercel: could not ask whether {d} is on the project {proj} ({st['why']}); reading the address only"); return None
    if st["on"] is False:
        print(f"Vercel: {d} is NOT on the project {proj} (Vercel: {st['why'] or 'not found'}), so it cannot serve the app or get a certificate. "
              f"Add it: python3 .claude/scripts/domain.py {app_id} attach {d}")
        AR.note(summary=f"{d} is not on the Vercel project {proj}", next=f"python3 .claude/scripts/domain.py {app_id} attach {d}")
        return 1
    if not st["verified"]:
        st = ask_verify(app_id, v, d, st)
        if not st["verified"]: return need_proof(app_id, d, st)
        print(f"Vercel: {d} is now verified on {proj}; its certificate follows within a minute or so")
    elif not quiet: print(f"Vercel: {d} is on the project {proj} and verified")
    return None

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
        st = domain_state(app_id, v, d); proj = web_project(app_id, v); rec = dns_record(d)
        if st["on"] is None: said = f"could not ask Vercel ({st['why']})"
        elif st["on"] is False: said = f"NO: not on the project {proj}; add it with domain.py {app_id} attach {d}"
        elif st["verified"]: said = f"yes, on the project {proj} and verified"
        else: said = f"on the project {proj}, but NOT verified: Vercel is waiting for the record below (domain.py {app_id} verify asks it to check again)"
        print(f"on Vercel    {said}")
        print(f"DNS record   type {rec['type']}   name {rec['name']}   value {rec['value']}   (sends visitors to the app)")
        for x in proof_records(d, st) if st["on"] and not st["verified"] else []:
            print(f"DNS record   type {x['type']}   name {x['host']}   value {x['value']}   (proves ownership to Vercel)")
        if st["on"] and not st["verified"]:
            AR.need("dns", f"{(proof_records(d, st) or [{}])[0].get('type', 'TXT')} {(proof_records(d, st) or [{}])[0].get('name', d)}",
                    f"The domain's owner adds the ownership record above at the company where {apex_of(d)} is registered; then: python3 .claude/scripts/domain.py {app_id} verify")
        ips = resolves(d); print(f"DNS          {', '.join(ips) if ips else 'does not resolve yet'}")
        man = single(app_id)
        print(f"serves app   {'yes' if (single_healthy(d, man)[0] if man else healthy(d)) else 'no'}")
    return 0

def attach(app_id, domain):
    domain = domain.lower().strip().removeprefix("https://").rstrip("/")
    if not DOMAIN.match(domain): sys.exit(f"{domain!r} is not a domain name (expected something like research.example.com)")
    if domain.endswith(".vercel.app"): sys.exit("that is the address the app already has")
    infra, p = docs(app_id); v = infra["vercel"]; proj = web_project(app_id, v)
    doc, err = vapi(f"/v10/projects/{proj}/domains", "POST", {"name": domain}, scope=v.get("team"), cwd=cwd_of(app_id))
    # Added: Vercel's answer says what it holds. Refused: it may already be on this project (an earlier attach), so
    # ask what the project holds; anything but "on the project" records nothing.
    st = held(doc) if not err else domain_state(app_id, v, domain)
    if not st["on"]:
        print(f"Vercel: {(err or {}).get('code', '')}: {(err or {}).get('message', '') or st.get('why', '')}".strip(), file=sys.stderr)
        AR.detail("vercel_error", err)
        sys.exit(f"Vercel did not add {domain} to the project {proj}; nothing was recorded")
    v["custom_domain"] = domain; save(infra, p)
    rec = dns_record(domain)
    print(f"{domain} is on the Vercel project {proj} and recorded. The app's address has NOT changed yet.")
    if not st["verified"]:
        st = ask_verify(app_id, v, domain, st)     # a record the owner already added is read at once
        if not st["verified"]: return need_proof(app_id, domain, st)
    print(f"DNS record for the domain's owner to create:  type {rec['type']}   name {rec['name']}   value {rec['value']}")
    print(f"then: python3 .claude/scripts/domain.py {app_id} verify")
    AR.note(summary=f"{domain} is on the Vercel project {proj} and verified; its owner points it at Vercel with one {rec['type']} record",
            next=f"python3 .claude/scripts/domain.py {app_id} verify")
    return 0

def verify(app_id, quiet=False):
    infra, _ = docs(app_id); d = infra["vercel"].get("custom_domain")
    if not d: sys.exit("no domain is attached yet")
    stop = vercel_check(app_id, infra["vercel"], d, quiet)
    if stop is not None: return stop
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
    assert DOMAIN.match("research.example.com") and not DOMAIN.match("https://x.com") and not DOMAIN.match("nodots")
    assert is_apex("example.com") and is_apex("example.co.in") and not is_apex("app.example.com") and not is_apex("a.example.co.in")
    assert dns_record("example.com") == dict(type="A", name="@", value=VERCEL_A)
    assert dns_record("app.example.com") == dict(type="CNAME", name="app", value=VERCEL_CNAME)
    assert dns_record("a.b.example.com")["name"] == "a.b" and dns_record("app.example.co.in")["name"] == "app"
    assert apex_of("app.example.com") == "example.com" and apex_of("a.b.example.co.in") == "example.co.in" and apex_of("example.com") == "example.com"
    assert registrar_host("_vercel.example.com", "app.example.com") == "_vercel" and registrar_host("_vercel.example.co.in", "a.example.co.in") == "_vercel"
    assert registrar_host("example.com", "app.example.com") == "@"
    assert api_error({"status": "error", "reason": "domain_not_owned"})["code"] == "domain_not_owned" and api_error({"name": "x"}) is None
    assert not_found(api_error({"error": {"code": "not_found", "message": "Project Domain not found"}})) and not not_found(api_error({"error": {"code": "forbidden", "message": "no"}}))
    n = 15 + single_self_test()
    print(f"domain: {n} checks passed"); return 0

def single_self_test():
    """A mold_v0 app (two Vercel projects) and a mold_v1 app in a throwaway root, offline: DNS, the health reads, Vercel's
    domain list and its env writes are stand-ins here, and socket/subprocess/urlopen refuse if anything tries the real
    thing. Returns the number of checks."""
    import contextlib, io, shutil, tempfile
    g = globals(); keep = {k: g[k] for k in ("ROOT", "resolves", "read_health", "healthy", "console_owns", "set_env", "env_names", "vapi")}
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
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
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
        # Vercel's project-domain API, as measured: POST /v10 adds (verified or waiting for a TXT record), or refuses
        # with domain_not_owned for an apex another account files; GET /v9 is 404 "Project Domain not found" when the
        # domain is not on the project; POST /v9/.../verify turns verified once the owner's TXT record is there.
        V = {"held": {"mv0": {"mv0.example.com": True}, "mv1": {"mv1.example.com": True}}, "calls": [], "refuse": set(),
             "pending": set(), "txt_in": set(), "offline": False}
        TXT = "vc-domain-verify=app.example.org,0123456789abcdef"
        def proof(d): return [{"type": "TXT", "domain": "_vercel." + apex_of(d), "value": TXT, "reason": "pending_domain_verification"}]
        def fake_vapi(path, method="GET", body=None, scope=None, cwd=None):
            V["calls"].append((method, path, body, scope))
            if V["offline"]: return {}, {"code": "error", "message": "not signed in"}
            parts = path.strip("/").split("/"); proj = parts[2]; on = V["held"].setdefault(proj, {})
            if method == "POST" and len(parts) == 4:
                d = body["name"]
                if d in V["refuse"]: return {"status": "error", "reason": "domain_not_owned"}, api_error({"status": "error", "reason": "domain_not_owned"})
                on[d] = d not in V["pending"] and on.get(d, True)
            else:
                d = parts[4]
                if d not in on: return {"error": {"code": "not_found", "message": "Project Domain not found"}}, {"code": "not_found", "message": "Project Domain not found"}
                if method == "POST" and len(parts) == 6 and d in V["txt_in"]: on[d] = True
                if method == "POST" and len(parts) == 6 and not on[d]:
                    doc = {"error": {"code": "missing_txt_record", "message": "Domain _vercel needs a TXT record"}}; return doc, api_error(doc)
            ans = {"name": d, "projectId": proj, "verified": on[d]}
            if not on[d]: ans["verification"] = proof(d)
            return ans, None
        g["vapi"] = fake_vapi

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

        # ---- attach through the project API; nothing recorded unless Vercel holds it -------------------------------
        mp = os.path.join(tmp, "state", "application", "mv1", "infrastructure.json")
        V["calls"].clear(); AR.reset()
        rc, out = run(attach, "mv1", "https://new.example.net/")
        assert rc == 0 and load(mp)["vercel"]["custom_domain"] == "new.example.net" and "type CNAME   name new" in out, out; n += 1
        assert V["calls"][0] == ("POST", "/v10/projects/mv1/domains", {"name": "new.example.net"}, "team-x"), V["calls"]; n += 1
        # the measured failure: domain_not_owned, not on the project -> exit 1, the earlier domain stays recorded
        V["refuse"].add("app.example.org"); V["calls"].clear()
        rc, out = run(attach, "mv1", "app.example.org")
        assert rc and "nothing was recorded" in str(rc) and load(mp)["vercel"]["custom_domain"] == "new.example.net", (rc, out); n += 1
        assert [c[:2] for c in V["calls"]] == [("POST", "/v10/projects/mv1/domains"), ("GET", "/v9/projects/mv1/domains/app.example.org")], V["calls"]; n += 1
        # Vercel could not be asked at all: nothing recorded either
        V["offline"] = True; rc, out = run(attach, "mv1", "other.example.org"); V["offline"] = False
        assert rc and load(mp)["vercel"]["custom_domain"] == "new.example.net"; n += 1
        # refused because an earlier attach already put it on the project: recorded, as Vercel holds it
        V["held"]["mv1"]["again.example.net"] = True; V["refuse"].add("again.example.net")
        rc, out = run(attach, "mv1", "again.example.net"); assert rc == 0 and load(mp)["vercel"]["custom_domain"] == "again.example.net", out; n += 1
        # added but waiting for proof of ownership: recorded, exit 3, the TXT record named in plain words
        V["refuse"].discard("app.example.org"); V["pending"].add("app.example.org"); V["calls"].clear(); AR.reset()
        rc, out = run(attach, "mv1", "app.example.org")
        assert rc == 3 and load(mp)["vercel"]["custom_domain"] == "app.example.org", (rc, out); n += 1
        assert "host _vercel" in out and TXT in out and "Name (or Host) box type exactly:  _vercel" in out and "registered" in out, out; n += 1
        assert ("POST", "/v9/projects/mv1/domains/app.example.org/verify", None, "team-x") in V["calls"]; n += 1
        nd = AR.NOTES["needs"]; assert len(nd) == 1 and nd[0]["kind"] == "dns" and nd[0]["name"] == "TXT _vercel.example.org" and TXT in nd[0]["how"], nd; n += 1
        # verify while the TXT record is missing: asks Vercel again, exit 3, no health read
        reads.clear(); V["calls"].clear(); AR.reset()
        rc, out = run(verify, "mv1")
        assert rc == 3 and not reads and ("POST", "/v9/projects/mv1/domains/app.example.org/verify", None, "team-x") in V["calls"] and TXT in out, out; n += 1
        # status reads (never asks Vercel to verify) and names both records
        V["calls"].clear(); rc, out = run(status, "mv1")
        assert rc == 0 and "NOT verified" in out and "name _vercel   value " + TXT in out and "type CNAME   name app" in out, out; n += 1
        assert all(c[0] == "GET" for c in V["calls"]); n += 1
        # the owner added it: verify turns it verified and goes on to the health read
        V["txt_in"].add("app.example.org"); reads.clear()
        rc, out = run(verify, "mv1"); assert rc == 0 and "now verified" in out and reads == ["https://app.example.org/api/ops/health"], out; n += 1
        rc, out = run(status, "mv1"); assert "yes, on the project mv1 and verified" in out and "_vercel" not in out, out; n += 1
        # the domain was taken off the project: verify says so, exit 1, no health read
        del V["held"]["mv1"]["app.example.org"]; reads.clear()
        rc, out = run(verify, "mv1"); assert rc == 1 and not reads and "NOT on the project mv1" in out, out; n += 1
        rc, out = run(status, "mv1"); assert "NO: not on the project mv1" in out, out; n += 1
        # Vercel cannot be asked: verify reads the address only, as before
        V["offline"] = True; reads.clear()
        rc, out = run(verify, "mv1"); assert rc == 0 and "could not ask" in out and reads == ["https://app.example.org/api/ops/health"], out; n += 1
        V["offline"] = False

        # a single-service app's domain goes on its console (web) project
        sp = app("sv", "mold_v0", projects={"api": "sv-api", "web": "sv-console"})
        V["calls"].clear(); rc, out = run(attach, "sv", "sv.example.net")
        assert rc == 0 and V["calls"][0][1] == "/v10/projects/sv-console/domains" and load(sp)["vercel"]["custom_domain"] == "sv.example.net", V["calls"]; n += 1

        # --json: one needs_human document, exit 3
        saved = {k: os.environ.pop(k, None) for k in ("FACTORY_RUN_LOG", "FACTORY_RUN_RECORD", "FACTORY_RUNS_DIR")}
        try:
            V["pending"].add("w.example.org"); rc, out = run(main, ["mv1", "attach", "w.example.org", "--json"])
        finally:
            os.environ.update({k: v for k, v in saved.items() if v is not None})
        doc = json.loads(out[out.index("{"):])
        assert rc == 3 and doc["status"] == "needs_human" and doc["needs"][0]["kind"] == "dns" and "_vercel" in doc["needs"][0]["how"] and TXT in doc["needs"][0]["how"], doc; n += 1
        return n
    finally:
        socket.getaddrinfo, subprocess.run, urllib.request.urlopen = real
        g.update(keep); shutil.rmtree(tmp, ignore_errors=True)

def main(a):
    if "--self-test" in a: return self_test()
    as_json, a = AR.wants_json(a)
    if as_json: return AR.run_json(main, a, root=ROOT, app=a[0] if a else None, step="domain")
    if len(a) >= 2 and a[1] == "status": return status(a[0])
    if len(a) == 3 and a[1] == "attach": return attach(a[0], a[2])
    if len(a) == 2 and a[1] == "verify": return verify(a[0])
    if len(a) == 2 and a[1] == "switch": return switch(a[0])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
