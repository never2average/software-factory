#!/usr/bin/env python3
"""Which web addresses are this application's own on Vercel: read from Vercel, never derived from a project name.

  vercel_addr.py --self-test                       offline: name collision, alias reading, the ownership guard
  vercel_addr.py <project> [--scope TEAM]          read-only: the project's production address, verified as ours
  vercel_addr.py --verify <url> <project>... [--scope TEAM]   read-only: is <url> served by one of these projects?

WHY (mold_v1-239, 2026-10-12). provision.py used to assume a project named X answers at https://X.vercel.app. A
*.vercel.app name is global across every Vercel account, and the first project to take it keeps it: when the name
is taken, Vercel gives a new project a different one (compliance-os-neon.vercel.app) and says so only in the
project's domain list and the deployment's alias list. compliance_os was deployed to compliance-os,
compliance-os-api and compliance-os-workflow; compliance-os.vercel.app and compliance-os-api.vercel.app belonged to
someone else's account. The factory read health from the stranger's site, wrote the stranger's address into
WEB_ORIGIN and NEXT_PUBLIC_EVE_API_URL, and, had health passed, the smoke test would have sent the operator's
signed-in session to that site.

THE RULES HERE
  * An address is ours only when Vercel, asked with our team's scope, says one of our projects serves it: the alias
    record (GET /v4/aliases/<host>) or the deployment record (GET /v13/deployments/<host>) names our project's id.
    Anything else (another team's site, an address nobody serves, a read that failed) is NOT ours. Unknown is no.
  * A production address is read after each deploy: the project's verified domains (GET /v9/projects/<id>/domains)
    that the deployment's own alias list carries, preferring <project>.vercel.app when it is among them.
  * Before a project is created, <name>.vercel.app is looked at from outside, anonymously, with no credential: an
    address nobody serves answers Vercel's DEPLOYMENT_NOT_FOUND; anything else is taken (or unknown, and treated so).
  * guard_app() is the one question every credential-carrying request asks first (smoke, the pre-deploy sign-in
    probe, mint.py code / code-request, lanes): no verified owner, no request.

Every function takes `api(path, method="GET", fields=None) -> (returncode, JSON dict)` and, where it looks from
outside, `probe(url) -> (http status or 0, text)`, so the self-test runs them against fakes. Standard library only.
"""
import json, os, re, subprocess, sys, urllib.parse

VERCEL_APP = ".vercel.app"
def suffix():
    """*.vercel.app; in a rehearsal (FACTORY_REHEARSAL, lib/services.py) *.rehearsal.invalid, so nothing real is named."""
    return ".rehearsal.invalid" if os.environ.get("FACTORY_REHEARSAL") else VERCEL_APP
NOT_FOUND = "DEPLOYMENT_NOT_FOUND"     # Vercel's answer (header x-vercel-error and the page) for an address nobody serves
ROLES = ("", "-api", "-workflow")       # the three projects of one application: <base>, <base>-api, <base>-workflow


def host_of(url):
    u = urllib.parse.urlsplit(url if "://" in (url or "") else "https://" + (url or ""))
    return (u.hostname or "").lower()


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9-]", "-", (s or "").lower())).strip("-")


# ---- the two ways of asking -------------------------------------------------------------------------------------------

def cli_api(cwd=None, scope=None, timeout=60):
    """`vercel api` with the team's scope. Returns api(path, method, fields) -> (rc, doc); an answer carrying
    {"error": ...}, or no JSON at all, is a failure (rc != 0). Never prints."""
    def api(path, method="GET", fields=None):
        argv = ["vercel", "api", path, "-X", method, "--raw"] + (["--scope", scope] if scope else [])
        for k, v in (fields or {}).items(): argv += ["-f", f"{k}={v}"]
        try:
            r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        except (subprocess.TimeoutExpired, OSError) as e:
            return 1, {"error": f"{type(e).__name__}"}
        try: doc = json.loads(r.stdout) if (r.stdout or "").strip() else {}
        except ValueError: doc = {}
        doc = doc if isinstance(doc, dict) else {}
        if r.returncode and not doc.get("error"):
            doc = {"error": (((r.stderr or "").strip().splitlines()) or ["no answer"])[-1][:200]}
        return (r.returncode or (1 if doc.get("error") else 0)), doc
    return api


def curl_probe(timeout=15):
    """probe(url) -> (status, headers and body): one anonymous GET, no cookie, no credential, no redirect followed."""
    def probe(url):
        try:
            r = subprocess.run(["curl", "--silent", "--include", "--max-time", str(timeout), "-w", "\n%{http_code}", url],
                               capture_output=True, text=True, timeout=timeout + 10, stdin=subprocess.DEVNULL)
        except (subprocess.TimeoutExpired, OSError):
            return 0, ""
        text, _, code = (r.stdout or "").rpartition("\n")
        try: return int(code.strip() or 0), text
        except ValueError: return 0, r.stdout or ""
    return probe


# ---- what Vercel says ---------------------------------------------------------------------------------------------------

def project(api, ref):
    rc, doc = api(f"/v9/projects/{ref}")
    return doc if rc == 0 and doc.get("id") else None


def project_domains(api, pid):
    """The project's own domains that serve it (verified, no redirect, not a branch or custom environment), in
    Vercel's order; None when the list could not be read."""
    rc, doc = api(f"/v9/projects/{pid}/domains")
    if rc: return None
    out = []
    for d in doc.get("domains") or []:
        if d.get("projectId") not in (None, pid): continue
        if not d.get("verified") or d.get("redirect") or d.get("gitBranch") or d.get("customEnvironmentId"): continue
        if d.get("name"): out.append(str(d["name"]).lower())
    return out


def owner_of(api, host):
    """The id of the project in OUR team that serves `host` (an alias, else a deployment URL), or None."""
    for path in (f"/v4/aliases/{host}", f"/v13/deployments/{host}"):
        rc, doc = api(path)
        if rc == 0 and doc.get("projectId"): return doc["projectId"]
    return None


def _pick(project_name, hosts):
    """<project>.vercel.app when it is among them, else the first other *.vercel.app, else the first one."""
    if not hosts: return None
    own = f"{project_name}{suffix()}".lower()
    if own in hosts: return own
    return next((h for h in hosts if h.endswith(suffix())), hosts[0])


def current_address(api, project_name):
    """(url, why) of the project's production address from its own domain list, verified with an alias lookup when
    a deployment serves it. For a project that has never been deployed the domain list is the only record; a domain
    Vercel attached to OUR project id is ours by Vercel's own account."""
    m = project(api, project_name)
    if not m: return None, f"the Vercel project {project_name} could not be read"
    doms = project_domains(api, m["id"])
    if doms is None: return None, f"the domain list of {project_name} could not be read"
    host = _pick(project_name, doms)
    if not host: return None, f"{project_name} has no production domain yet"
    return f"https://{host}", f"{project_name}'s own domain list"


def production_address(api, project_name, deployment=None):
    """(url, why): the address that serves `project_name`'s production, read after a deploy. `deployment` is the
    deployment the deploy made (its id or its one-off host); without it, the project's current production target.
    Only a domain that is BOTH in the project's domain list AND in that deployment's alias list (without a deployment:
    the production alias list, or an alias record naming the project) is a candidate, and the one chosen must resolve
    to our project id in the alias record. (None, why) otherwise: never a guess."""
    m = project(api, project_name)
    if not m: return None, f"the Vercel project {project_name} could not be read"
    pid = m["id"]
    doms = project_domains(api, pid)
    if doms is None: return None, f"the domain list of {project_name} could not be read"
    if deployment:
        rc, d = api(f"/v13/deployments/{deployment}")
        if rc or d.get("projectId") != pid:
            return None, f"the deployment {deployment} is not one of {project_name}'s (Vercel names {d.get('projectId') or 'no project'})"
        aliases = [str(a).lower() for a in d.get("alias") or []]
        cands = [h for h in doms if h in aliases]
    else:
        # the production target's alias list is a snapshot of its deploy; a domain added since is served once its alias
        # record names this project, so either says it serves production now
        aliases = [str(a).lower() for a in (((m.get("targets") or {}).get("production") or {}).get("alias") or [])]
        cands = [h for h in doms if h in aliases or owner_of(api, h) == pid]
    host = _pick(project_name, cands)
    if not host:
        return None, (f"{project_name}'s production deployment carries none of the project's domains yet "
                      f"(domains: {', '.join(doms) or 'none'}; aliases: {', '.join(aliases) or 'none'})")
    if owner_of(api, host) != pid:
        return None, f"Vercel does not say {host} serves {project_name}"
    return f"https://{host}", f"{project_name}'s domain, on its production deployment"


def verify(api, url, projects):
    """(True, project name) when `url` is served by one of `projects` (names, in our team); (False, why) otherwise."""
    host = host_of(url)
    if not host: return False, "there is no address to check"
    ids = {}
    for n in projects:
        m = project(api, n)
        if m: ids[m["id"]] = n
    if not ids:
        return False, f"none of {', '.join(projects)} could be read on Vercel, so {host} cannot be shown to be this app's"
    pid = owner_of(api, host)
    if pid in ids: return True, ids[pid]
    if pid: return False, f"{host} is served by another project of this Vercel team ({pid}), not by {', '.join(projects)}"
    return False, (f"Vercel does not list {host} as an address of {', '.join(projects)} in this team: "
                   f"it may be another account's site")


def name_status(api, probe, name):
    """("team", project id) when <name>.vercel.app already serves a project of our team; ("free", None) when nobody
    serves it (Vercel answers DEPLOYMENT_NOT_FOUND); ("taken", None) when someone else's site answers there;
    ("unknown", None) when nothing could be read (treated as not free)."""
    host = f"{name}{suffix()}"
    pid = owner_of(api, host)
    if pid: return "team", pid
    code, text = probe(f"https://{host}/")
    if NOT_FOUND in (text or ""): return "free", None
    if not code: return "unknown", None
    return "taken", None


def alternatives(base, prefix=None, team=None, rand=None):
    """Other names to try, in order: <prefix>-<base>, <base>-<first word of the team>, <base>-<4 hex>."""
    out, p, t = [], slug(prefix), slug((team or "").split("-")[0])
    if p and not base.startswith(p + "-"): out.append(f"{p}-{base}")
    if t and t != p: out.append(f"{base}-{t}")
    out.append(f"{base}-{rand or os.urandom(2).hex()}")
    return [x[:80].strip("-") for x in out]


def free_base(api, probe, base, alts=()):
    """(base, report): the first of [base, *alts] whose three names (<b>, <b>-api, <b>-workflow) are neither projects
    of this team nor served by anyone at <name>.vercel.app. (None, report) when none is. report: [(b, [why...])]."""
    report = []
    for b in [base, *alts]:
        bad = []
        for n in (b + r for r in ROLES):
            if project(api, n): bad.append(f"{n} is already a project of this team"); continue
            st, _ = name_status(api, probe, n)
            if st != "free": bad.append(f"{n}{suffix()} is {'someone else' + chr(39) + 's' if st == 'taken' else st}")
        report.append((b, bad))
        if not bad: return b, report
    return None, report


def claim(api, probe, project_name):
    """(url, why): the project's production address, claiming <project>.vercel.app for it first when it has none and
    that name is free. A project that already has a domain keeps it; a taken name is never claimed."""
    url, why = current_address(api, project_name)
    if url: return url, why
    m = project(api, project_name)
    if not m: return None, why
    st, _ = name_status(api, probe, project_name)
    if st != "free":
        return None, f"{project_name}{suffix()} is not free ({st}); Vercel will name the address itself at the deploy, and it is read back then"
    rc, doc = api(f"/v10/projects/{m['id']}/domains", "POST", {"name": f"{project_name}{suffix()}"})
    if rc: return None, f"Vercel refused {project_name}{suffix()} for {project_name}: {(doc.get('error') or {}).get('message') if isinstance(doc.get('error'), dict) else doc.get('error')}"
    return current_address(api, project_name)


def guard_app(infra, url, api=None, roles=None):
    """(True, who) when it is safe to send a credential to `url` for this application; (False, why) otherwise.
    Only an app on Vercel is asked of Vercel; an app on its own server has the address its operator set and the deploy
    proved (lane_url.target_url's rule). roles: which of the app's projects may serve it (default: all three)."""
    infra = infra or {}
    if infra.get("target") != "vercel": return True, "an app on its own server: its address is the one its deploy recorded"
    v = infra.get("vercel") or {}; base = v.get("project")
    if not base: return False, "state names no Vercel project for this app, so no address can be shown to be its own"
    names = [base + r for r in (roles if roles is not None else ROLES)]
    if api is None: api = cli_api(scope=v.get("team") or None)
    ok, who = verify(api, url, names)
    if ok: return True, who
    return False, (f"refusing to send anything to {host_of(url) or "an empty address"}: {who}. Nothing was sent. Read the app's "
                   f"real address with: python3 .claude/scripts/lib/vercel_addr.py {base} --scope {v.get('team') or '<team>'}")


# ---- self-test ----------------------------------------------------------------------------------------------------------

class FakeVercel:
    """Our team's projects and aliases, plus the public internet's other sites, as dicts. Records every call."""
    def __init__(self):
        self.projects = {}     # name -> {"id", "domains": [host], "prod": deployment id}
        self.deployments = {}  # id or host -> {"id", "projectId", "alias": [...]}
        self.strangers = {}    # host -> page text someone else serves there
        self.calls = []
    def add(self, name, domains=(), prod_aliases=None):
        pid = "prj_" + name; dep = f"dpl_{name}"; host = f"{name}-abc123-team.vercel.app"
        self.projects[name] = {"id": pid, "domains": list(domains), "prod": dep}
        d = {"id": dep, "projectId": pid, "url": host, "alias": list(prod_aliases if prod_aliases is not None else domains)}
        self.deployments[dep] = d; self.deployments[host] = d
        return pid
    def _by(self, ref): return next((n for n, p in self.projects.items() if ref in (n, p["id"])), None)
    def api(self, path, method="GET", fields=None):
        self.calls.append((method, path))
        m = re.match(r"^/v9/projects/([^/]+)$", path)
        if m:
            n = self._by(m.group(1))
            if not n: return 1, {"error": {"message": "Project not found"}}
            p = self.projects[n]; d = self.deployments.get(p["prod"]) or {}
            return 0, {"id": p["id"], "name": n, "targets": {"production": {"id": p["prod"], "alias": d.get("alias", [])}}}
        m = re.match(r"^/v\d+/projects/([^/]+)/domains$", path)
        if m:
            n = self._by(m.group(1))
            if not n: return 1, {"error": {"message": "Project not found"}}
            if method == "POST":
                h = fields["name"]
                if h in self.strangers or any(h in p["domains"] for p in self.projects.values()): return 1, {"error": {"message": "domain taken"}}
                self.projects[n]["domains"].append(h); return 0, {"name": h}
            return 0, {"domains": [{"name": h, "projectId": self.projects[n]["id"], "verified": True, "redirect": None} for h in self.projects[n]["domains"]]}
        m = re.match(r"^/v4/aliases/([^/?]+)$", path)
        if m:
            for n, p in self.projects.items():
                if m.group(1) in (self.deployments.get(p["prod"]) or {}).get("alias", []): return 0, {"alias": m.group(1), "projectId": p["id"]}
            return 1, {"error": {"message": "Response Error (404)"}}
        m = re.match(r"^/v13/deployments/([^/?]+)$", path)
        if m:
            d = self.deployments.get(m.group(1))
            return (0, dict(d)) if d else (1, {"error": {"message": "Deployment not found"}})
        return 1, {"error": {"message": f"unexpected {path}"}}
    def probe(self, url):
        self.calls.append(("PROBE", url))
        h = host_of(url)
        if h in self.strangers: return 200, self.strangers[h]
        if any(h in (self.deployments.get(p["prod"]) or {}).get("alias", []) for p in self.projects.values()): return 200, "ours"
        return 404, f"x-vercel-error: {NOT_FOUND}\n\nThe deployment could not be found on Vercel."


def self_test():
    os.environ.pop("FACTORY_REHEARSAL", None)   # these fakes speak *.vercel.app
    fails, n = [], [0]
    def ok(cond, what, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{what}{': ' + str(detail)[:300] if detail else ''}")
    # the 2026-10-12 world: someone else holds compliance-os.vercel.app and compliance-os-api.vercel.app
    V = FakeVercel()
    V.strangers = {"compliance-os.vercel.app": "<title>Compliance OS</title> someone else's product",
                   "compliance-os-api.vercel.app": "<html>404 someone else's</html>"}
    V.add("compliance-os", ["compliance-os-neon.vercel.app"], ["compliance-os-neon.vercel.app", "compliance-os-team.vercel.app"])
    V.add("compliance-os-api", ["compliance-os-api-ten.vercel.app"])
    V.add("compliance-os-workflow", ["compliance-os-workflow.vercel.app"])

    # 1. alias reading: the real address comes from Vercel, not from the project name
    url, why = production_address(V.api, "compliance-os", deployment="compliance-os-abc123-team.vercel.app")
    ok(url == "https://compliance-os-neon.vercel.app", "alias reading: the web address is the project's own domain on its deployment, not <name>.vercel.app", (url, why))
    url, _ = production_address(V.api, "compliance-os-api")
    ok(url == "https://compliance-os-api-ten.vercel.app", "alias reading: the api's address is Vercel's fallback name, read from the production target", url)
    url, _ = production_address(V.api, "compliance-os-workflow")
    ok(url == "https://compliance-os-workflow.vercel.app", "alias reading: a free name is still read, not assumed", url)
    url, why = production_address(V.api, "compliance-os", deployment="dpl_compliance-os-api")
    ok(url is None and "not one of compliance-os's" in why, "alias reading: a deployment of another project is refused", why)
    V2 = FakeVercel(); V2.add("fresh", ["fresh.vercel.app"], prod_aliases=[])
    url, why = production_address(V2.api, "fresh")
    ok(url is None and "carries none" in why, "alias reading: a domain the deployment does not carry yet is not an address", why)
    url, _ = current_address(V.api, "compliance-os")
    ok(url == "https://compliance-os-neon.vercel.app", "current_address reads the domain list (before a deploy)", url)

    # 2. name collision
    st, _ = name_status(V.api, V.probe, "compliance-os")
    ok(st == "taken", "name collision: compliance-os.vercel.app served by someone else is 'taken'", st)
    st, _ = name_status(V.api, V.probe, "compliance-os-workflow")
    ok(st == "team", "a name our own project serves is 'team', not free", st)
    st, _ = name_status(V.api, V.probe, "onfinance-compliance-os")
    ok(st == "free", "a name nobody serves (DEPLOYMENT_NOT_FOUND) is free", st)
    st, _ = name_status(V.api, lambda u: (0, ""), "anything")
    ok(st == "unknown", "nothing answered: unknown, never free", st)
    alts = alternatives("compliance-os", prefix="OnFinance", team="acme7f-1234s-projects", rand="beef")
    ok(alts == ["onfinance-compliance-os", "compliance-os-acme7f", "compliance-os-beef"], "alternatives: prefix, team word, random", alts)
    base, rep = free_base(V.api, V.probe, "compliance-os", alts)
    ok(base == "onfinance-compliance-os" and rep[0][1], "free_base skips the taken name and picks the first free set of three", (base, rep))
    W = FakeVercel(); W.strangers = {"app.vercel.app": "x"}
    base, rep = free_base(W.api, W.probe, "app", [])
    ok(base is None and "someone else's" in rep[0][1][0], "free_base: no free name -> None, saying whose", rep)
    W.add("app2-api", ["app2-api.vercel.app"])
    base, rep = free_base(W.api, W.probe, "app2", [])
    ok(base is None and "already a project" in " ".join(rep[0][1]), "free_base: a name that is already one of our projects is not free", rep)

    # claim: a fresh project gets <name>.vercel.app only when nobody has it
    C = FakeVercel(); C.strangers = {"taken.vercel.app": "x"}
    C.projects["mine"] = {"id": "prj_mine", "domains": [], "prod": None}
    C.projects["taken"] = {"id": "prj_taken", "domains": [], "prod": None}
    url, _ = claim(C.api, C.probe, "mine")
    ok(url == "https://mine.vercel.app" and ("POST", "/v10/projects/prj_mine/domains") in C.calls, "claim: a free <name>.vercel.app is attached to our project", url)
    url, why = claim(C.api, C.probe, "taken")
    ok(url is None and "not free" in why and ("POST", "/v10/projects/prj_taken/domains") not in C.calls, "claim: a taken name is never claimed", why)

    # 3. the ownership guard: nothing carrying a credential goes to an address Vercel does not call ours
    infra = {"target": "vercel", "vercel": {"team": "t", "project": "compliance-os"}}
    good, why = guard_app(infra, "https://compliance-os.vercel.app", api=V.api, roles=("",))
    ok(not good and "refusing to send anything to compliance-os.vercel.app" in why and "Nothing was sent" in why,
       "ownership guard: the stranger's compliance-os.vercel.app is refused", why)
    ok(not any(c[0] == "PROBE" and "compliance-os.vercel.app" in c[1] for c in V.calls[-6:]), "  ...and the guard itself never contacts that address")
    good, who = guard_app(infra, "https://compliance-os-neon.vercel.app/", api=V.api, roles=("",))
    ok(good and who == "compliance-os", "ownership guard: our own alias passes", who)
    good, why = guard_app(infra, "https://compliance-os-api-ten.vercel.app", api=V.api, roles=("",))
    ok(not good and "another project" in why, "ownership guard: our api's address is not the web app's", why)
    good, _ = guard_app(infra, "https://compliance-os-abc123-team.vercel.app", api=V.api, roles=("",))
    ok(good, "ownership guard: our own one-off deployment URL passes (the deployment record names our project)")
    good, why = guard_app({"target": "vercel", "vercel": {}}, "https://x.vercel.app", api=V.api)
    ok(not good and "no Vercel project" in why, "ownership guard: no project in state -> refused", why)
    broken = lambda path, method="GET", fields=None: (1, {"error": "network down"})
    good, why = guard_app(infra, "https://compliance-os-neon.vercel.app", api=broken)
    ok(not good, "ownership guard: Vercel unreadable -> refused (unknown is no)", why)
    good, _ = guard_app({"target": "vm_remote", "vm_remote": {"production_url": "https://a.example.com"}}, "https://a.example.com", api=broken)
    ok(good, "ownership guard: an app on its own server is not asked of Vercel")
    ok(host_of("https://A.Example.com:443/x") == "a.example.com" and host_of("") == "", "host_of")
    if fails:
        print("vercel_addr self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"vercel_addr self-test: {n[0]} checks passed"); return 0


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 2
    scope = a[a.index("--scope") + 1] if "--scope" in a and a.index("--scope") + 1 < len(a) else None
    rest = [x for i, x in enumerate(a) if x != "--scope" and (i == 0 or a[i - 1] != "--scope")]
    api = cli_api(scope=scope)
    if rest[0] == "--verify":
        if len(rest) < 3: print(__doc__); return 2
        good, who = verify(api, rest[1], rest[2:])
        print(f"{'ours' if good else 'NOT ours'}: {host_of(rest[1])} {'is served by ' + who if good else '- ' + who}")
        return 0 if good else 1
    url, why = production_address(api, rest[0])
    if url: print(f"{url}  ({why}, verified as ours)"); return 0
    print(f"{rest[0]}: no verified production address: {why}", file=sys.stderr); return 1


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
