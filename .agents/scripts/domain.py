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

def status(app_id):
    infra, _ = docs(app_id); v = infra["vercel"]; d = v.get("custom_domain")
    print(f"front door   {v.get('production_url')}")
    print(f"own domain   {d or 'none named (domain.py ' + app_id + ' attach <domain>)'}")
    if d:
        ips = resolves(d); print(f"DNS          {', '.join(ips) if ips else 'does not resolve yet'}")
        print(f"serves app   {'yes' if healthy(d) else 'no'}")
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
    ips = resolves(d); ok = bool(ips) and healthy(d)
    if not quiet or not ok:
        print(f"DNS: {', '.join(ips) if ips else 'does not resolve yet (a new record can take up to an hour)'}")
        print(f"https://{d}/api/ops/health: {'200, the app answers' if ok else 'no answer from the app yet'}")
    return 0 if ok else 1

def switch(app_id):
    if verify(app_id, quiet=True): sys.exit("the domain does not serve the app yet, so nothing was switched")
    infra, p = docs(app_id); v = infra["vercel"]; d = v["custom_domain"]; url = f"https://{d}"
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
    print("domain: 10 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if len(a) >= 2 and a[1] == "status": return status(a[0])
    if len(a) == 3 and a[1] == "attach": return attach(a[0], a[2])
    if len(a) == 2 and a[1] == "verify": return verify(a[0])
    if len(a) == 2 and a[1] == "switch": return switch(a[0])
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
