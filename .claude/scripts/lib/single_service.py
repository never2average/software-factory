#!/usr/bin/env python3
"""single_service: run a mold that ships as ONE service with its own Docker Compose stack (mold_v0-028).

A mold opts in with molds/<mold_id>/mold.json ("shape": "single_service"); today that is mold_v0, the operator's MCP
product pinned as it is. Everything else in the factory keeps its mold_v1 paths: each caller asks `manifest(mold_id)`
first and hands over here only when it answers. The factory never edits the mold's codebase while it deploys (mold_v0's is
authored in this repository since mold_v0-040, by pull request like any other file; lib/intree.py): what
the factory needs from it (the compose project's default name, the service that is built, the env names it requires
or accepts, the port, the health check) is READ from its own files at plan time (compose_facts).

Two deploy targets (infrastructure.target):

  compose_remote  a server of the app's own, over SSH. It reuses lib/vm_remote.py's host probe, SSH and rsync
                  handling, the DNS precondition, the key pair, the hidden prompt for values only the operator holds,
                  the env file (names in, names out; root, mode 600) and the firewall rules, and deploys the mold's own
                  compose stack under a project name of the app's own (sf-<app-id>), never the compose file's default.
  vercel          TWO Vercel projects (mold_v0-029): <project>-api, the API function from the mold's own vercel.json,
                  and <project>, the web console (a server-rendered Next.js app in the mold's web/) as its own Next.js
                  project, pointed at the API through the API-address variable its next.config reads. Neither may be a
                  LIVE project or another app's (provision.py's refusal, plus every name another app holds); both are
                  created under the team scope, and a base name taken on vercel.app is suffixed (provision.py's own
                  choice, recorded). Only the api project gets the app's own Neon Postgres (provision.py's provisioning,
                  proven empty first; DATABASE_URL written by the integration, never here) and the product's minted keys;
                  the console gets the API's address and only the sign-in names the operator sets for it. Deployed api
                  first, then the console; health on both; when either fails, BOTH go back to the production deployment
                  that served before.

Through provision.py (main_for):

  provision.py <app_id>                                  check: offline, read-only, connects to nothing
  provision.py <app_id> --set-remote host=<address> domain=<name> [ssh_user= ssh_port= ssh_key_ref= provider=]
  provision.py <app_id> --remote-key                     the SSH key pair named by ssh_key_ref; prints the PUBLIC half
  provision.py <app_id> --qualify-remote                 the read-only host probe, judged for a compose stack
  provision.py <app_id> --deploy-remote [--dry-run]      the deploy (compose_remote); --dry-run prints every step
  provision.py <app_id> --deploy [--dry-run]             the deploy (vercel: the api project, then the console project)
  provision.py <app_id> --rollback-remote [--dry-run]    the server back to the release that served before
  provision.py <app_id> --set-secret NAME                one value at a hidden prompt, into the server's env file (or
                                                         the Vercel project(s) that read NAME); it applies at the next deploy
  provision.py <app_id> --lane-key [--dry-run] [--yes]   an organisation of the app's own for the lanes' MCP check (the
                                                         product's own org:create), its connector address kept in a
                                                         private file outside the repository. It writes to the app's
                                                         data, so it runs only with --yes (exit 3 asks for the yes)

THE APP'S OWN COPY (mold_v0-024). An app with packs (application.json "packs") or a brand (surface.branding) is deployed
from build/<app_id>/, made afresh from the codebase at every deploy, before anything is created or contacted:
branding.py prepare (the brand through the profile, the favicon set, the colours; molds/<mold_id>/branding/rules.json),
then packs.py apply and verify (the mold's own pack rules, mold.json "packs"). An app with neither is deployed from the
codebase exactly as before. The lanes grade build/<app_id>.lane/ for an app with packs (packs.py lane-copy), as for
mold_v1. A step that fails stops the deploy with nothing created, and the app is not marked reverted.

WHAT A compose_remote DEPLOY DOES, in order. Nothing before `up` changes what serves; `up` either ends on a stack that
answered its health checks or switches `current` back to the release that served before and brings that up again.
   preflight  ON THIS MACHINE: every file the image build copies exists in the snapshot, every name the compose file
              requires is either written from state or minted by the mold's own bootstrap script, and the compose
              project is this app's own (a project named like the compose file's default would be another stack's)
   rehearsal  the generated scripts parsed (bash -n) and this file imported from the bundle alone, before contact
   qualify    vm_remote's read-only probe plus three lines (compose, who holds the web ports): Ubuntu 24.04, sudo,
              systemd, memory, CPUs, disk, no other web server, the web ports free or this app's own. KVM is not needed
   dns        the domain must already point at the server, or the stack's own Caddy cannot get a certificate
   bundle     the generated scripts and the factory's tooling -> <install>/factory
   packages   Docker and its compose plugin where there is no Docker; an existing Docker is never replaced (only its own
              compose plugin is added, or the step refuses); ufw, fail2ban, rsync, python3, openssl
   firewall   ufw: SSH, 80 and 443 only (vm_remote's rules); fail2ban for ssh. Docker publishes only what the compose
              file names, and the health step fails if anything else publishes a port
   names      which env names the server already holds (names only)
   values     values only the operator holds (secrets_user), at a hidden prompt, for names the server lacks
   source     the snapshot's SOURCE into a new release directory, <install>/releases/<id>, beside the serving one
   env        state's settings (DOMAIN, PUBLIC_URL) and the operator's values merged into the env file; then every
              name still missing is minted ON THE SERVER by the mold's own bootstrap script, run in a private temp
              directory that sees the NAMES already present and never their values. Nothing is printed but names
   up         `current` -> the new release; docker compose -p sf-<app> ... up -d --build --wait. On failure: back
              (and `previous` restored, so it never names the release that failed)
   health     on the server: the app container healthy, running as a user other than root, and only the services
              the compose file publishes holding a port; from here: https://<domain><health_path> answers 200 ok;
              otherwise the server goes back to the release that served before (up.sh --back --drop), by itself
   keep       every release but the serving and the previous one removed

ROW-LEVEL SECURITY (mold_v0-051). When mold.json declares "rls" and the codebase's package.json has that script (mold_v0
since mold_v0-031: `npm run check:rls`, the product's catalog check plus a live two-organisation probe inside a
transaction that is rolled back), intake writes datastores.postgres.rls = its mode ("fail_closed"), and every deploy
runs the script against the DEPLOYED database after the health checks: compose_remote in a one-off container of the
new release's image with the server's env file (as the product's own rolling-deploy.sh does); vercel on this machine,
with the api project's production DATABASE_URL (read back, never shown), right after the deployment that reads it was
built. A check that fails, or cannot run, is a failed health check (the server, or both projects, go back to what
served before). The result is written to datastores.postgres.rls_verified (at, backend, mode, source, and in
running_app_detail what was read); `provision.py <app> --verify-rls` reads it again. What this proves: the database the
app is configured with has the product's policies and no organisation reaches another's rows. What it does not: it runs
nothing inside a Vercel function; there the function's own probe (/healthz rls_probe, run by the product's cron at most
hourly) is read and recorded as said, and "not run" is recorded as unmeasured, never as enforced.

The database is the stack's own Postgres container on the compose network (no published port). Its password and the
app's keys exist only in the env file on the server. State records names, the release, the health verdict and the
address; never a value.
"""
import datetime, getpass, json, os, re, secrets as pysecrets, shlex, shutil, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vm_remote as VR   # the host probe, SSH/rsync argv, DNS check, key pair, hidden prompt, env file, firewall rules

SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
TARGETS = ("compose_remote", "vercel")
Stop = VR.Stop
class NotBuilt(Stop):
    """The app's own build copy (its brand, its packs) could not be made: nothing was created or contacted, so the app is
    not marked reverted (provision.py says why and exits 1)."""
class NeedsHuman(Stop):
    """Only the operator can do the next thing (a value only they hold). provision.py turns it into exit 3 through the
    `needs` it noted; it never marks the app reverted, because nothing was tried."""
PROJECT_RE = re.compile(r"^sf-[a-z0-9][a-z0-9-]{1,60}$")
RELEASE_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
HOST_MIN = {"mem_kb": 3_600_000, "vcpu": 2, "disk_free_gb": 20}   # a "4 GB" plan reports about 3.8 GB; the image build needs ~3
ARCH_OK = ("x86_64", "aarch64")
CRED = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|HEADERS)")
UP_WAIT_S = 900
PUBLIC_WAIT_S = 180          # a first deploy: the stack's Caddy asks for its certificate after `up`
NOT_ROOT = ("0", "", "unknown")

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
def load(p): return json.load(open(p))
def save(p, o):
    with open(p, "w") as f: f.write(json.dumps(o, indent=2) + "\n")

# ---------------------------------------------------------------------------------------------------------
# the mold's manifest and what its own files say
# ---------------------------------------------------------------------------------------------------------
def manifest(mold_id, root=None):
    """molds/<mold_id>/mold.json when it declares the single-service shape, else None (every mold_v1 path)."""
    p = os.path.join(root or ROOT, "molds", str(mold_id or ""), "mold.json")
    if not os.path.isfile(p): return None
    try: m = load(p)
    except ValueError: return None
    return m if m.get("shape") == "single_service" else None

def applies(app, root=None):
    return bool(isinstance(app, dict) and manifest(app.get("mold_id"), root))

def codebase(mold_id, root=None): return os.path.join(root or ROOT, "molds", mold_id, "codebase")

def rls_spec(cb, man):
    """mold.json "rls" when the codebase's package.json really has that script (else None: the app asks for no RLS)."""
    spec = (man or {}).get("rls")
    if not isinstance(spec, dict) or not spec.get("script") or spec.get("mode") not in ("on", "fail_closed"): return None
    try: scripts = (json.load(open(os.path.join(cb, "package.json"))).get("scripts") or {})
    except (OSError, ValueError): return None
    return dict(spec, pass_text=spec.get("pass") or "RLS CHECK PASS") if spec["script"] in scripts else None

def rls_said(out, spec):
    """The product's own verdict line from the check's output (its PASS or FAIL line), else its last lines; redacted."""
    lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
    hit = [l for l in lines if re.search(r"RLS CHECK (PASS|FAIL)", l)]
    return VR.redact(" | ".join(hit[-1:] or lines[-3:]))[:400]

def rls_passed(rc, out, spec): return rc == 0 and bool(spec) and spec["pass_text"] in (out or "")

RLS_SOURCE = "check:rls"      # rls_verified.source starts with this for a single-service app (factory.py reads it)
def record_rls(adir, spec, passed, said, how, running, detail, save_fn=None):
    """datastores.postgres.rls_verified for a single-service app, from the product's own check (module docstring):
    the mode is the spec's only when the check passed; what was read, and where, is said in source and the detail."""
    p = os.path.join(adir, "datastores.json")
    try: ds = load(p)
    except (OSError, ValueError): return None
    pg = ds.setdefault("postgres", {})
    ev = {"at": now(), "backend": pg.get("provider") or "", "mode": spec["mode"] if passed else "off",
          "source": (f"{RLS_SOURCE} (npm run {spec['script']}, the product's own: catalog + live probe, rolled back), {how}"
                     + ("" if passed else f"; FAILED: {said}"))[:600],
          "running_app": running if passed else "not_enforced", "running_app_detail": f"{detail} Check said: {said}"[:600]}
    pg["rls_verified"] = ev
    (save_fn or save)(p, ds)
    return ev

def rls_local(cb, db_url, spec, timeout=300):
    """The product's check on THIS machine against one database (Vercel: the api project's). -> (exit, output)."""
    env = {k: v for k, v in os.environ.items() if k not in ("PGLITE_DIR", "CLICKHOUSE_URL", "MIGRATIONS_PG_URL")}
    env["DATABASE_URL"] = db_url
    try: r = subprocess.run(["npm", "run", "--silent", spec["script"]], cwd=cb, env=env, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e: return 124, f"the check could not run: {type(e).__name__}"
    return r.returncode, VR.redact(((r.stdout or "") + "\n" + (r.stderr or "")).replace(db_url, "<database>"))

def rls_tools_missing(cb, spec):
    """Why the check cannot run from this machine (Vercel), or None."""
    if spec and not os.path.exists(os.path.join(cb, "node_modules", ".bin", "tsx")):
        return (f"the product's row-level security check runs from this machine against the app's database, and needs the mold's "
                f"dependencies installed first: npm --prefix {os.path.relpath(cb, ROOT) if cb.startswith(ROOT + os.sep) else cb} ci")
    return None

def rls_vercel(P, cb, api, spec, health_doc, rls_run=None):
    """Vercel: the check against the api project's production database, and the function's own probe as /healthz said
    it. -> (passed, said, running_app, detail). Raises Stop when the database address cannot be read back."""
    import agent_result as AR
    vals = P.pull_env(cb, api, required=False); url = vals.get("DATABASE_URL")
    if not url or url == "[SENSITIVE]":
        raise Stop(f"DATABASE_URL could not be read back from {api} (absent, or marked Sensitive on Vercel, which hides it from every "
                   f"reader), so row-level security could not be checked and the deploy cannot finish. Tell the operator; nothing "
                   f"here changes how the database address is stored")
    AR.forbid(url)
    rc, out = (rls_run or rls_local)(cb, url, spec)
    passed, said = rls_passed(rc, out, spec), rls_said(out, spec)
    probe = (health_doc or {}).get("rls_probe") if isinstance(health_doc, dict) else None
    if passed and probe == "failed": passed, said = False, f"{said}; but the function's own probe says failed (/healthz rls_probe)"
    running = "enforced" if probe == "ok" else "not_enforced" if probe == "failed" else "unmeasured"
    detail = (f"ran on the factory machine against {api}'s production DATABASE_URL, right after the deployment that reads it was built; "
              f"the function's own probe (/healthz rls_probe, run by the product's cron at most hourly) said {probe or 'nothing'!r}.")
    return passed, said, running, detail

REF = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}")
def parse_compose(text):
    """What a compose file says, read without a YAML library: the default project name, each service (whether it is
    built here, publishes ports, sits behind a profile, the ports it exposes, the names its environment block reads
    whole), and every ${NAME...} reference with its operator. `$${...}` is compose's escape and is not a reference."""
    out = {"name": "", "services": {}, "refs": []}
    section, svc = None, None
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip(): continue
        ind = len(line) - len(line.lstrip())
        if ind == 0:
            k, _, v = line.partition(":"); section = k.strip(); svc = None
            if section == "name": out["name"] = v.strip().strip("'\"")
            continue
        for n, op, dflt in REF.findall(line): out["refs"].append((n, op or "", dflt))
        if section != "services": continue
        if ind == 2 and line.strip().endswith(":") and not line.strip().startswith("-"):
            svc = line.strip()[:-1]; out["services"][svc] = {"build": False, "ports": False, "profiles": False, "expose": [], "reads": [], "required_reads": []}
            continue
        if not svc: continue
        s = out["services"][svc]; t = line.strip()
        if ind == 4:
            key = t.split(":", 1)[0]
            if key == "build": s["build"] = True
            elif key == "ports": s["ports"] = True
            elif key == "profiles": s["profiles"] = True
            elif key == "expose": s["expose"] += re.findall(r"\d+", t.split(":", 1)[1])
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])?", t) if ind == 6 else None
        if m and m.group(1) == m.group(2):
            s["reads"].append(m.group(1))
            if (m.group(3) or "").endswith("?"): s["required_reads"].append(m.group(1))
    return out

def bootstrap_names(text):
    """The names a mold's own bootstrap script writes (`put NAME ...`)."""
    return sorted(set(re.findall(r"^\s*put\s+([A-Z_][A-Z0-9_]*)\s", text, re.M)))

def dockerfile_sources(text):
    """Every path a Dockerfile COPY/ADD takes from the build context (not from another stage)."""
    out = []
    for line in text.splitlines():
        t = line.strip()
        if not re.match(r"(?i)^(COPY|ADD)\s", t) or "--from=" in t: continue
        parts = [p for p in shlex.split(t)[1:] if not p.startswith("--")]
        if parts and parts[0].startswith("["): continue
        out += parts[:-1]
    return out

def compose_facts(cb, man):
    """Everything the plan needs from the snapshot's own files. Raises Stop with one sentence if a file is missing."""
    c = man.get("compose") or {}
    cf = os.path.join(cb, c.get("file", ""))
    if not os.path.isfile(cf): raise Stop(f"the mold's compose file {c.get('file')} is not in molds/{man['mold_id']}/codebase. Nothing was done.")
    P = parse_compose(open(cf).read())
    built = [n for n, s in P["services"].items() if s["build"]]
    if len(built) != 1: raise Stop(f"{c.get('file')} builds {len(built)} services ({', '.join(built) or 'none'}); a single-service mold builds exactly one. Nothing was done.")
    app = built[0]; svc = P["services"][app]
    req = sorted({n for n, op, _ in P["refs"] if op.endswith("?")})
    opt = sorted({n for n, op, d in P["refs"] if op.endswith("-") and d == "" and n not in req})
    boot = os.path.join(cb, c.get("mint", ""))
    minted = bootstrap_names(open(boot).read()) if c.get("mint") and os.path.isfile(boot) else []
    df = os.path.join(cb, c.get("dockerfile", "Dockerfile"))
    dtext = open(df).read() if os.path.isfile(df) else ""
    return {"file": c.get("file"), "default_project": P["name"], "service": app, "port": (svc["expose"] or [""])[0],
            "required": req, "optional": opt, "optional_secrets": [n for n in opt if CRED.search(n)],
            "app_reads_required": svc["required_reads"], "config": dict(c.get("config") or {}), "minted": minted,
            "mint": c.get("mint", ""), "publishers": sorted(n for n, s in P["services"].items() if s["ports"] and not s["profiles"]),
            "healthcheck": bool(re.search(r"(?m)^\s*HEALTHCHECK\s", dtext)), "dockerfile_sources": dockerfile_sources(dtext),
            "excludes": list(c.get("source_excludes") or []), "rls": rls_spec(cb, man)}

def missing_build_inputs(cb, F):
    """Files the image build copies that the snapshot does not have: the build would stop on the server."""
    return [s for s in F["dockerfile_sources"] if not any(True for _ in _glob(cb, s))]

def _glob(cb, pattern):
    import glob
    p = os.path.join(cb, pattern)
    return glob.glob(p) if any(ch in pattern for ch in "*?[") else ([p] if os.path.exists(p) else [])

def _codebase_fix(mold_id, what):
    """Where a change to the mold's own files is made: this repository for an in-tree mold, its source otherwise."""
    import intree
    try: it = intree.is_in_tree(mold_id, ROOT)
    except intree.Unreadable: it = True
    if it: return f"That is a change to molds/{mold_id}/codebase in this repository ({what}), by pull request; a deploy never makes it"
    return (f"That is a change to the mold's source, by pull request there ({what}), then `python3 .claude/scripts/mold.py refresh {mold_id}`; "
            f"the factory never edits a snapshot")

def preflight(cb, F, S):
    """Plain sentences for what stops a deploy before any server is contacted; [] when none."""
    bad = []
    gone = missing_build_inputs(cb, F)
    if gone:
        bad.append(f"the image build copies {', '.join(gone)}, which the mold's codebase does not contain (its own .gitignore keeps it out of "
                   f"the repository), so `docker compose build` would stop on the server. " + _codebase_fix(S["mold_id"], "commit the file"))
    nobody = [n for n in F["required"] if n not in F["config"] and n not in F["minted"]]
    if nobody:
        bad.append(f"{F['file']} requires {', '.join(nobody)}, which neither state ({', '.join(F['config']) or 'nothing'}) nor the mold's "
                   f"own {F['mint'] or 'bootstrap script'} provides")
    if not PROJECT_RE.match(S["project"]) or S["project"] == F["default_project"]:
        bad.append(f"the compose project for this app is {S['project']!r}; it must be sf-<app id> and never {F['default_project']!r}, the "
                   f"compose file's own default, which names another copy's containers and volumes")
    return bad

# ---------------------------------------------------------------------------------------------------------
# state: intake's shape, validate's rules, the settings a deploy reads
# ---------------------------------------------------------------------------------------------------------
def slug(app_id): return app_id.replace("_", "-")
def install_path(app_id): return f"/opt/software-factory/{app_id}"

def secret_names(F, target, K=None):
    """(user, derived, optional) names for a target. compose_remote: the compose file's required names are written
    from state or minted on the server; vercel: DATABASE_URL comes from the app's own Neon database (provisioned at the
    first deploy), the names the app reads whole are minted by the same bootstrap script, plus CRON_SECRET for Vercel's
    own cron calls, all on the api project. With K (console_facts), the console's sign-in names join them: the operator's
    to set when mold.json says the console needs them, else optional. Nothing else is the operator's to type."""
    if target == "compose_remote":
        return [], [n for n in F["required"] if n not in F["config"]], list(F["optional_secrets"])
    derived = ["DATABASE_URL"] + [n for n in F["app_reads_required"] if n not in F["config"]] + ["CRON_SECRET"]
    opt = [n for n in F["optional_secrets"] if n not in derived]
    user = list(K["required"]) if K else []
    opt += [n for n in (K["optional"] if K else []) if n not in opt and n not in user]
    return user, derived, [n for n in opt if n not in user]

def shape_state(app_id, mold_id, target, prod, mold, ans, hints, brief_rel, defaults=None, root=None):
    """The four state documents of a single-service app, from intake's answers. The same four schemas as every app; the
    fields only this shape needs are infrastructure.compose_remote, postgres.exposure "compose_network" and blob "none"."""
    man = manifest(mold_id, root); F = compose_facts(codebase(mold_id, root), man); d = defaults or {}
    user, derived, optional = secret_names(F, target, console_facts(codebase(mold_id, root), man) if target == "vercel" else None)
    app = {"$schema": "../app_id/application.schema.json", "app_id": app_id, "mold_id": mold_id,
           "mold_commit": mold_commit(mold_id, root) or (mold.get("source") or {}).get("commit", ""), "status": "planned", "brief": brief_rel,
           "product_id": prod["product_id"], "service_surface": [],
           "testing": {l: {"status": "pending"} for l in ("load", "context", "functional", "accessibility", "responsiveness")}}
    if hints.get("customer_id"): app["customer_id"] = hints["customer_id"]
    infra = {"$schema": "../app_id/infrastructure.schema.json", "target": target,
             "secret_store": "compose_remote_env_file" if target == "compose_remote" else "vercel_env",
             "sandbox": {"provider": "none", "prewarm": False},
             "secrets": sorted(set(user + derived)), "secrets_user": user, "secrets_derived": derived, "secrets_optional": optional}
    dom = (ans.get("domain") or "").strip().lower()
    if target == "compose_remote":
        cr = {"provider": "digitalocean", "ssh_user": "root", "ssh_port": 22, "ssh_key_ref": f"sf_{app_id}", "install_path": install_path(app_id),
              "compose": {"project": f"sf-{slug(app_id)}", "file": F["file"], "service": F["service"]}}
        if hints.get("remote_host"): cr["host"] = hints["remote_host"]
        if dom: cr["domain"] = dom
        infra["compose_remote"] = cr
        pg = {"provider": "self_hosted", "host": "postgres", "exposure": "compose_network"}
    else:
        base = ans.get("vercel_project") or slug(app_id)   # two projects: <base>-api (the API) and <base> (the console)
        infra["vercel"] = {"team": d.get("vercel_team", "your-vercel-team"), "project": base, "projects": vercel_projects(base)}
        if dom: infra["vercel"]["custom_domain"] = dom
        pg = {"provider": "neon", "exposure": "managed_provider", "admin_url_ref": "DATABASE_URL_UNPOOLED", "pooling": "transaction"}
    # rls: what the mold's own check proves (mold.json "rls", mold_v0-051: "fail_closed" since the product's mold_v0-031),
    # only while the codebase has that check; "off" otherwise (tenant rows scoped in queries, its tenant-SQL check).
    # Either way the deploy measures it and records the evidence (rls_verified); it is never claimed unmeasured.
    spec = rls_spec(codebase(mold_id, root), man)
    ds = {"$schema": "../app_id/datastores.schema.json",
          "postgres": dict(pg, scope="fresh", rls=spec["mode"] if spec else "off", tenancy="multi_org", url_ref="DATABASE_URL"),
          "blob": {"provider": "none"}, "cache": {"provider": "none"}}
    di = {"$schema": "../app_id/datainfra.schema.json",
          "dataroom": {"spec": "none (mold_v0 has no data room)", "top_level": [], "system_of_record": "postgres"},
          "platforms": [], "deployments": [], "syncs": [], "pipelines": [], "agents": [], "connectors": []}
    return app, infra, ds, di

KEY_MATERIAL = re.compile(r"-----BEGIN|(?i:postgres(?:ql)?://[^\s/:@]+:[^\s/@]+@)|\b[A-Za-z0-9+/]{40,}={0,2}\b")
def problems(app_id, docs, root=None):
    """What the schema cannot say about a single-service app, or about a compose_remote target. [] when fine."""
    a = docs.get("application") or {}; infra = docs.get("infrastructure") or {}; t = infra.get("target")
    single = applies(a, root); out = []
    f = f"{app_id}/infrastructure.json"; fix = f"state/application/{app_id}/infrastructure.json"
    if not single:
        if t == "compose_remote":
            out.append(f"{f}: target is 'compose_remote', which runs a single-service mold's own compose stack, but {a.get('mold_id')!r} is not "
                       f"one (no molds/{a.get('mold_id')}/mold.json with \"shape\": \"single_service\") — use the targets its own paths know")
        return out
    if t not in TARGETS:
        return [f"{f}: target is {t!r}, but {a.get('mold_id')} runs on {' or '.join(TARGETS)} only (molds/{a.get('mold_id')}/mold.json) — set one in {fix}"]
    pg = (docs.get("datastores") or {}).get("postgres") or {}
    if t == "vercel":
        if infra.get("secret_store") != "vercel_env": out.append(f"{f}: a Vercel app keeps its values in the project's environment — set \"secret_store\": \"vercel_env\" in {fix}")
        if pg.get("provider") == "self_hosted": out.append(f"{app_id}/datastores.json: a Vercel function cannot reach a database on a server's private network — set postgres.provider to \"neon\"")
        v = infra.get("vercel") or {}; base = v.get("project") or ""
        if not base: out.append(f"{f}: a Vercel app needs vercel.project, the base name of its two projects (<name>-api and <name>) — set it in {fix}")
        elif v.get("projects") is not None and v.get("projects") != vercel_projects(base):
            out.append(f"{f}: vercel.projects is {v.get('projects')} but the base name {base!r} gives {vercel_projects(base)} (the API and the console) — "
                       f"set it to that, or delete the line, in {fix}")
        return out
    cr = infra.get("compose_remote")
    if not isinstance(cr, dict): return [f"{f}: target is 'compose_remote' but there is no compose_remote object — add it to {fix}"]
    if cr.get("install_path") != install_path(app_id):
        out.append(f"{f}: compose_remote.install_path is {cr.get('install_path')!r} but it is fixed at {install_path(app_id)!r} — set it in {fix}")
    proj = (cr.get("compose") or {}).get("project")
    if proj != f"sf-{slug(app_id)}":
        out.append(f"{f}: compose_remote.compose.project is {proj!r} but it is fixed at 'sf-{slug(app_id)}' (the app's own containers and "
                   f"volumes; any other name could be another stack's) — set it in {fix}")
    if infra.get("secret_store") != "compose_remote_env_file":
        out.append(f"{f}: secret_store is {infra.get('secret_store')!r} but a compose_remote app keeps its values in the env file on its own "
                   f"server — set \"secret_store\": \"compose_remote_env_file\" in {fix}")
    if pg.get("provider") != "self_hosted" or pg.get("exposure") != "compose_network":
        out.append(f"{app_id}/datastores.json: a compose_remote app's database is its stack's own Postgres on the compose network, but postgres "
                   f"says provider {pg.get('provider')!r}, exposure {pg.get('exposure')!r} — set provider \"self_hosted\" and exposure \"compose_network\"")
    dom, purl = cr.get("domain"), cr.get("production_url")
    if purl is not None:
        if not dom or purl != f"https://{dom}":
            out.append(f"{f}: compose_remote.production_url is {purl!r} but this app's address is https://<compose_remote.domain> — delete the line from {fix}; the deploy writes it")
        if not infra.get("deployed_at"):
            out.append(f"{f}: compose_remote.production_url is set but there is no deployed_at, so nothing deployed that address — delete the line from {fix}")
    if a.get("status") in ("stamped", "testing", "serviceable"):
        lack = [k for k in ("host", "domain", "production_url") if not cr.get(k)]
        if lack: out.append(f"{app_id}/application.json: status is {a.get('status')!r} but compose_remote has no {', '.join(lack)}, which only a deploy writes — set status back to 'planned'")
    for k, v in cr.items():
        if isinstance(v, str) and k != "production_url" and KEY_MATERIAL.search(v):
            out.append(f"{f}: compose_remote.{k} looks like a key or a password; this file holds NAMES only — replace it in {fix} and treat the value as exposed")
    return out

def settings(app_id, app, infra, root=None):
    """The dictionary a deploy reads, shaped so vm_remote's helpers (ssh_argv, rsync_argv, guarded, dns_problem,
    ufw_rules, fail2ban_jail, remote_key) take it as they take their own."""
    cr = infra.get("compose_remote") or {}; man = manifest(app.get("mold_id"), root) or {}
    inst = install_path(app_id)
    S = {"app_id": app_id, "mold_id": app.get("mold_id"), "slug": slug(app_id), "host": cr.get("host") or "", "domain": cr.get("domain") or "",
         "user": cr.get("ssh_user") or "root", "port": int(cr.get("ssh_port") or 22), "key_ref": cr.get("ssh_key_ref") or f"sf_{app_id}",
         "ssh_host": cr.get("ssh_host") or "", "ssh_allow_from": cr.get("ssh_allow_from") or "", "tunnel": {}, "tunnel_on": False,
         "install": inst, "releases": f"{inst}/releases", "current": f"{inst}/current", "factory_dir": f"{inst}/factory",
         "env_dir": f"/etc/software-factory/{app_id}", "env_file": f"/etc/software-factory/{app_id}/env",
         "project": (cr.get("compose") or {}).get("project") or f"sf-{slug(app_id)}",
         "compose_file": (cr.get("compose") or {}).get("file") or (man.get("compose") or {}).get("file", ""),
         "health_path": man.get("health_path", "/"), "secrets_user": list(infra.get("secrets_user") or []),
         "secrets_optional": list(infra.get("secrets_optional") or []), "email": ""}
    S["host_shown"] = S["ssh_host"] or S["host"] or VR.NO_HOST; S["domain_shown"] = S["domain"] or VR.NO_DOMAIN
    S["url"] = f"https://{S['domain_shown']}"; S["sudo"] = "" if S["user"] == "root" else "sudo "
    S["tool"] = f"{S['factory_dir']}/.claude/scripts/lib/single_service.py"
    S["vr_tool"] = f"{S['factory_dir']}/.claude/scripts/lib/vm_remote.py"
    return S

def config_pairs(S, F):
    """The settings state decides, by name, for the env file (never a secret)."""
    return {k: v.replace("{domain}", S["domain"]) for k, v in F["config"].items()}

# ---------------------------------------------------------------------------------------------------------
# generated files (run on the server, as root, only with the deploy's marker)
# ---------------------------------------------------------------------------------------------------------
HEAD = "# GENERATED by .claude/scripts/lib/single_service.py from state/application/@APP@/. Regenerated on every deploy.\n"
def _dc(S): return (f'dc() {{ docker compose -p {shlex.quote(S["project"])} -f "{S["current"]}/{S["compose_file"]}" '
                    f'--env-file {shlex.quote(S["env_file"])} "$@"; }}\n')
def _head(S): return VR.fill(HEAD, APP=S["app_id"]) + "set -eu\n" + VR.fill(VR.GUARD, APP=S["app_id"])

COMPOSE_PROBE = r"""
if docker compose version >/dev/null 2>&1; then echo "COMPOSE=present"; else echo "COMPOSE=absent"; fi
n=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -cE ':(80|443)$' || true); echo "WEB_LISTENERS=${n:-0}"
h=none
if command -v docker >/dev/null 2>&1; then
  h=$(docker ps --format '{{.Label "com.docker.compose.project"}} {{.Ports}}' 2>/dev/null | awk '/:(80|443)->/ {print ($1==""?"(no-project)":$1)}' | sort -u | paste -sd, -)
  [ -n "$h" ] || h=none
fi
echo "WEB_HOLDER=$h"
"""

# Docker: installed only where there is none. An existing Docker is never replaced (docker.io over docker-ce would
# swap the engine under whatever runs there); only its compose plugin is added, from the same packaging, or the
# script refuses with the reason.
DOCKER_LINES = """if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y -q --no-upgrade docker.io docker-compose-v2
elif ! docker compose version >/dev/null 2>&1; then
  if dpkg -s docker-ce >/dev/null 2>&1; then apt-get install -y -q --no-upgrade docker-compose-plugin
  elif dpkg -s docker.io >/dev/null 2>&1; then apt-get install -y -q --no-upgrade docker-compose-v2
  else echo "packages: Docker is installed here, but not from a package this deploy knows (docker-ce or docker.io), and it has no compose plugin. Nothing was changed; add the compose plugin by hand or use a fresh server." >&2; exit 4
  fi
fi
"""
def packages_sh(S):
    return _head(S) + VR.fill("""export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-upgrade ca-certificates curl rsync ufw fail2ban python3 openssl iproute2
""" + DOCKER_LINES + """systemctl enable --now docker >/dev/null
install -d -m 755 /opt/software-factory @INSTALL@ @INSTALL@/releases @FACTORY@
install -d -m 700 /etc/software-factory @ENVDIR@
echo "packages: $(docker --version | cut -d, -f1), compose $(docker compose version --short 2>/dev/null || echo present)"
""", INSTALL=S["install"], FACTORY=S["factory_dir"], ENVDIR=S["env_dir"])

def firewall_sh(S):
    rules = VR.ufw_rules(S)
    return _head(S) + VR.fill("""export LC_ALL=C
# Docker publishes ports past ufw. The compose file publishes the web ports only, and health.sh fails the deploy if
# any other service of this project holds a published port; the database is reachable on the compose network alone.
want="$(printf '%s\\n' @RULES@)"
have="$(ufw show added 2>/dev/null | grep '^ufw ' | sort || true)"
if [ "$have" != "$want" ] || ! ufw status | grep -q '^Status: active'; then
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
@ALLOWS@
  ufw --force enable
  echo "firewall: reset to exactly @PORTS@"
else
  echo "firewall: already exactly @PORTS@"
fi
install -d -m 755 /etc/fail2ban/jail.d
install -m 644 @FACTORY@/fail2ban-sshd.local /etc/fail2ban/jail.d/software-factory-sshd.local
systemctl enable --now fail2ban >/dev/null
systemctl reload fail2ban 2>/dev/null || systemctl restart fail2ban
echo "firewall: fail2ban on for ssh"
""", RULES=" ".join(shlex.quote(r) for r in rules), ALLOWS="\n".join("  " + r for r in rules), FACTORY=S["factory_dir"],
        PORTS=", ".join(str(p) for p in sorted({S["port"], 80, 443})) + (f" (SSH from {S['ssh_allow_from']} only)" if S["ssh_allow_from"] else ""))

def up_sh(S):
    """`up.sh <release>`: `current` -> that release, the stack up and healthy; on failure, back to the one before, with
    `previous` restored to what it said before this deploy (so it never names the release that failed).
    `up.sh --back`: the operator's rollback: to `previous`, which then names the release just left (run again: forward).
    `up.sh --back --drop`: the deploy's own rollback after a failed health check: to `previous`, which is then restored
    to what it said before this deploy. Either --back says NOTHING= and changes nothing when there is nowhere to go."""
    return _head(S) + _dc(S) + VR.fill("""cd @INSTALL@
point() { ln -sfn "releases/$1" current.new && mv -T current.new current; }
cur=""; [ -L current ] && cur="$(basename "$(readlink current)")"
restore() { if [ -n "$1" ]; then echo "$1" > previous; else rm -f previous; fi; }
if [ "${1:-}" = "--back" ]; then
  to="$(cat previous 2>/dev/null || true)"
  if [ -z "$to" ] || [ "$to" = "$cur" ] || [ ! -d "releases/$to" ]; then
    echo "NOTHING=no earlier release to go back to (serving ${cur:-nothing}); nothing was changed"; echo "SERVING=$cur"; exit 0
  fi
  point "$to"
  if dc up -d --build --wait --wait-timeout @WAIT@; then
    if [ "${2:-}" = "--drop" ]; then restore "$(cat previous.before 2>/dev/null || true)"; else echo "$cur" > previous; fi
    echo "ROLLED_BACK=$to"; echo "SERVING=$to"; exit 0
  fi
  point "$cur"; echo "ROLLBACK_FAILED=$to"; exit 1
fi
REL="${1:?usage: up.sh <release-id> | --back [--drop]}"
case "$REL" in *[!0-9TZ]*|"") echo "up: not a release id: $REL" >&2; exit 2;; esac
[ -d "releases/$REL" ] || { echo "up: releases/$REL does not exist" >&2; exit 2; }
was="$(cat previous 2>/dev/null || true)"
if [ -n "$was" ]; then echo "$was" > previous.before; else rm -f previous.before; fi
point "$REL"
if [ -n "$cur" ] && [ "$cur" != "$REL" ]; then echo "$cur" > previous; fi
if dc up -d --build --wait --wait-timeout @WAIT@; then echo "UP=ok"; echo "SERVING=$REL"; exit 0; fi
echo "UP=failed"
if [ -n "$cur" ] && [ "$cur" != "$REL" ] && [ -d "releases/$cur" ]; then
  point "$cur"; restore "$was"
  if dc up -d --build --wait --wait-timeout @WAIT@; then echo "ROLLED_BACK=$cur"; else echo "ROLLBACK_FAILED=$cur"; fi
else
  echo "SWITCH_BACK=none"
fi
exit 1
""", INSTALL=S["install"], WAIT=UP_WAIT_S)

def health_sh(S, F):
    return _head(S) + _dc(S) + VR.fill("""cid="$(dc ps -q @SERVICE@ 2>/dev/null | head -n 1)"
if [ -n "$cid" ]; then
  echo "APP_STATE=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
  echo "APP_UID=$(dc exec -T @SERVICE@ id -u 2>/dev/null || echo unknown)"
else
  echo "APP_STATE=absent"; echo "APP_UID=unknown"
fi
echo "PUBLISHED=$(docker ps --filter label=com.docker.compose.project=@PROJECT@ --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | awk '/->/ {print $1}' | sort -u | paste -sd, -)"
echo "SERVING=$(basename "$(readlink @INSTALL@/current)")"
echo "DISK_PERCENT=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')"
""", SERVICE=shlex.quote(F["service"]), PROJECT=shlex.quote(S["project"]), INSTALL=S["install"])

def keep_sh(S):
    return _head(S) + VR.fill("""cd @INSTALL@/releases
cur="$(basename "$(readlink ../current)")"; prev="$(cat ../previous 2>/dev/null || true)"
for d in */; do
  d="${d%/}"
  case "$d" in "$cur"|"$prev") continue;; esac
  if printf '%s' "$d" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$'; then rm -rf -- "$d"; echo "keep: removed release $d"; fi
done
docker image prune -f --filter label=com.docker.compose.project=@PROJECT@ >/dev/null 2>&1 || true
echo "keep: serving $cur${prev:+, previous $prev}"
""", INSTALL=S["install"], PROJECT=shlex.quote(S["project"]))

def bundle(S, F):
    return {"qualify.sh": (VR.QUALIFY_SH + COMPOSE_PROBE, 0o755), "packages.sh": (packages_sh(S), 0o755), "firewall.sh": (firewall_sh(S), 0o755),
            "up.sh": (up_sh(S), 0o755), "health.sh": (health_sh(S, F), 0o755), "keep.sh": (keep_sh(S), 0o755),
            "fail2ban-sshd.local": (VR.fail2ban_jail(S), 0o644)}

def write_bundle(S, F, out):
    for rel, (text, mode) in bundle(S, F).items():
        p = os.path.join(out, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f: f.write(text)
        os.chmod(p, mode)
    for src, rel in VR.bundle_copies():
        p = os.path.join(out, rel); os.makedirs(os.path.dirname(p), exist_ok=True); shutil.copyfile(src, p)
    return out

def rehearse(out):
    """Before any contact: every generated script parses, and the server-side tool imports from the bundle alone."""
    bad = []
    for f in sorted(os.listdir(out)):
        if f.endswith(".sh"):
            r = subprocess.run(["bash", "-n", os.path.join(out, f)], capture_output=True, text=True)
            if r.returncode: bad.append(f"{f} does not parse: {(r.stderr or '').strip()[-200:]}")
    lib = os.path.join(out, ".claude", "scripts", "lib")
    for mod in ("single_service", "vm_remote"):
        r = subprocess.run([sys.executable or "python3", "-I", "-B", "-c", "import sys; sys.path[:0]=[sys.argv[1]]; import " + mod, lib],
                           capture_output=True, text=True, cwd=out)
        if r.returncode: bad.append(f"{mod}.py does not import from the bundle alone: {(r.stderr or '').strip().splitlines()[-1:]}")
    return bad

# ---------------------------------------------------------------------------------------------------------
# the plan
# ---------------------------------------------------------------------------------------------------------
def release_id(at=None): return (at or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")

def plan(S, F, source_dir, bundle_dir="<bundle>", shown=True, release=None):
    rel = release or "<release-id>"; R = f"{S['releases']}/{rel}"
    ssh = lambda cmd: VR.ssh_argv(S, cmd, shown=shown)
    g = lambda cmd: VR.guarded(S, cmd)
    excludes = list(F["excludes"])
    env_cmd = g(f"python3 {S['tool']} env --file {S['env_file']} --bootstrap {R}/{F['mint']}" if F["mint"] else f"python3 {S['vr_tool']} env-merge --file {S['env_file']}")
    return [
        {"id": "qualify", "title": "qualify the server (read-only probe, judged for a compose stack)", "argv": ssh("sh -s"), "stdin": "qualify.sh", "timeout": 60},
        {"id": "bundle", "title": f"send the generated scripts and the factory's tooling to {S['factory_dir']}",
         "argv": VR.rsync_argv(S, bundle_dir, S["factory_dir"], shown=shown), "timeout": 300},
        {"id": "packages", "title": "Docker and its compose plugin (if absent), ufw, fail2ban, rsync, python3, openssl", "argv": ssh(g(f"bash {S['factory_dir']}/packages.sh")), "timeout": 1200},
        {"id": "firewall", "title": "ufw: SSH, 80 and 443 only; fail2ban for ssh", "argv": ssh(g(f"bash {S['factory_dir']}/firewall.sh")), "timeout": 300},
        {"id": "names", "title": "which env names the server already holds (names only)", "argv": ssh(f"{S['sudo']}python3 {S['vr_tool']} env-names --file {S['env_file']}"), "timeout": 60},
        {"id": "release-dir", "title": f"a new release directory {R} beside the serving one", "argv": ssh(g(f"install -d -m 755 {R}")), "timeout": 60},
        {"id": "source", "title": f"the source (not a build) from {os.path.relpath(source_dir, ROOT) if os.path.isabs(source_dir) else source_dir}/ into {R}", "argv": VR.rsync_argv(S, source_dir, R, excludes=excludes, shown=shown), "timeout": 900},
        {"id": "env", "title": f"settings from state ({', '.join(F['config'])}) and the operator's values into {S['env_file']} (root, 600); every name still "
                               f"missing minted ON the server by the mold's own {F['mint'] or 'tool'}, which sees names, never values", "argv": ssh(env_cmd), "stdin": "NAME=value lines", "timeout": 120},
        {"id": "up", "title": f"current -> {rel}; docker compose -p {S['project']} up -d --build --wait (on failure: back to the release that served)",
         "argv": ssh(g(f"bash {S['factory_dir']}/up.sh {rel}")), "timeout": UP_WAIT_S * 2 + 1800},
        {"id": "health", "title": f"on the server: {F['service']} {'healthy' if F['healthcheck'] else 'running'}, not root, only {', '.join(F['publishers']) or 'nothing'} publishing ports",
         "argv": ssh(g(f"bash {S['factory_dir']}/health.sh")), "timeout": 120},
        {"id": "public", "title": f"from here: {S['url']}{S['health_path']} answers 200 with ok", "argv": None, "timeout": PUBLIC_WAIT_S},
    ] + ([
        {"id": "rls", "title": f"row-level security on the deployed database: the product's own `npm run {F['rls']['script']}` in a one-off "
                               f"container of the new release, with the server's env file (catalog + live probe, rolled back)",
         "argv": ssh(rls_cmd(S, F)), "timeout": 300},
    ] if F.get("rls") else []) + [
        {"id": "keep", "title": "every release but the serving and the previous one removed", "argv": ssh(g(f"bash {S['factory_dir']}/keep.sh")), "timeout": 300},
        {"id": "back", "title": "ONLY if the health step or the public read fails: back to the release that served before (up.sh --back --drop)",
         "argv": ssh(g(f"bash {S['factory_dir']}/up.sh --back --drop")), "timeout": UP_WAIT_S * 2 + 600},
    ]

def rls_cmd(S, F):
    return (f"{S['sudo']}docker compose -p {shlex.quote(S['project'])} -f {S['current']}/{S['compose_file']} --env-file {shlex.quote(S['env_file'])} "
            f"run --rm -T --no-deps {shlex.quote(F['service'])} npm run --silent {shlex.quote(F['rls']['script'])}")

def print_plan(S, F, steps, say=print):
    say(f"{S['app_id']}: deploy plan for its own server (compose project {S['project']}, never {F['default_project']!r}); nothing is contacted by this --dry-run")
    say("  0. preflight on this machine: the snapshot has every file the image build copies; every required name is provided; the project name is the app's own")
    say("  0. rehearsal: the generated scripts parsed (bash -n), the server-side tool imported from the bundle alone")
    for i, st in enumerate(steps, 1):
        say(f"  {i:2d}. [{st['id']}] {st['title']}")
        if st.get("argv"): say(f"      $ {VR.shown_cmd(S, st['argv'])}" + (f"   < {st['stdin']}" if st.get("stdin") else ""))
    say(f"  then state: compose_remote.production_url, compose_remote.health, compose_remote.release, deployed_at, status stamped (or reverted, with the reason)")

# ---------------------------------------------------------------------------------------------------------
# judgements
# ---------------------------------------------------------------------------------------------------------
def qualify(facts, S):
    """Plain sentences for everything that disqualifies the server for a compose stack; [] when it is fit."""
    need = ("OS_ID", "OS_VERSION", "ARCH", "MEM_KB", "VCPU", "DISK_FREE_KB", "SUDO", "SYSTEMD", "PROXY", "COMPOSE", "WEB_LISTENERS", "WEB_HOLDER")
    unread = [k for k in need if not facts.get(k)]
    if unread: return [f"The server answered, but the check could not read {', '.join(unread)}. Nothing was installed. Run the check again."]
    bad = []
    num = lambda k: int(facts[k]) if facts.get(k, "").isdigit() else None
    if (num("MEM_KB") or 0) < HOST_MIN["mem_kb"]:
        bad.append(f"This server has {round((num('MEM_KB') or 0) / 1048576, 1)} GB of memory; building and running the stack needs a 4 GB plan.")
    if (num("VCPU") or 0) < HOST_MIN["vcpu"]: bad.append(f"This server has {num('VCPU') or 0} virtual CPU(s); the stack needs {HOST_MIN['vcpu']}.")
    if (num("DISK_FREE_KB") or 0) < HOST_MIN["disk_free_gb"] * 1048576:
        bad.append(f"This server has {round((num('DISK_FREE_KB') or 0) / 1048576, 1)} GB of free disk; the images, the database and two releases need {HOST_MIN['disk_free_gb']} GB.")
    if (facts["OS_ID"], facts["OS_VERSION"]) not in VR.OS_OK: bad.append(f"This server runs {facts['OS_ID']} {facts['OS_VERSION']}; the deploy is written for Ubuntu 24.04.")
    if facts["ARCH"] not in ARCH_OK: bad.append(f"This server's processor type is {facts['ARCH']}; choose an Intel/AMD or ARM64 plan.")
    if facts["SUDO"] != "ok": bad.append("The login the deploy uses can neither act as root nor use sudo without a password. Use the root login the provider gave you.")
    if facts["SYSTEMD"] != "yes": bad.append("This server does not run systemd, which keeps Docker running. Use a standard Ubuntu 24.04 image.")
    if facts["PROXY"] != "none": bad.append(f"Another web server ({facts['PROXY']}) is installed here; the stack's own Caddy needs ports 80 and 443. Use a server of its own.")
    holders = [h for h in facts["WEB_HOLDER"].split(",") if h and h != "none"]
    others = [h for h in holders if h != S["project"]]
    if others or (facts["WEB_LISTENERS"] != "0" and not holders):
        bad.append(f"Something else already answers on the web ports (80/443) of this server ({', '.join(others) or 'a process outside Docker'}). "
                   f"Two stacks cannot share those ports, and this deploy never stops or changes another one. Use a server of its own.")
    return bad

def health_verdict(F, kv, public):
    """Why the stack is not serving, from the server's read and the read from outside; [] when it is."""
    bad = []; want = "healthy" if F["healthcheck"] else "running"
    if kv.get("APP_STATE") != want: bad.append(f"the {F['service']} container is {kv.get('APP_STATE') or 'absent'}, not {want}")
    if kv.get("APP_UID", "") in NOT_ROOT: bad.append(f"the {F['service']} container runs as root (uid {kv.get('APP_UID') or 'unknown'}), not as the image's own user")
    extra = sorted(set(x for x in (kv.get("PUBLISHED") or "").split(",") if x) - set(F["publishers"]))
    if extra: bad.append(f"{', '.join(extra)} publish(es) a port, but only {', '.join(F['publishers']) or 'nothing'} may (the compose file's own)")
    code, doc, why = public
    if str(code) != "200" or not (isinstance(doc, dict) and doc.get("ok") is True):
        bad.append(f"the health address answered {('HTTP ' + str(code)) if code else 'nothing'}{(' (' + why + ')') if why else ''}")
    return bad

# ---------------------------------------------------------------------------------------------------------
# compose_remote: check, deploy, set-secret, rollback
# ---------------------------------------------------------------------------------------------------------
def uses_build(app):
    """An app with packs or a brand is built from a copy of its own, build/<app_id>/ (mold_v0-024), as mold_v1's apps are;
    one with neither is deployed from the codebase as it is, exactly as before."""
    return bool(isinstance(app, dict) and (app.get("packs") or (app.get("surface") or {}).get("branding")))

def source_for(app_id, app, root=None):
    return os.path.join(root or ROOT, "build", app_id) if uses_build(app) else codebase(app["mold_id"], root)

def build_source(app_id, app, root=None, say=print, run=subprocess.run):
    """What a deploy ships: the codebase itself, or for an app with packs or a brand build/<app_id>/ made AFRESH from the
    codebase for this deploy (never a copy left by an earlier run, which could carry a pack the app no longer names or
    yesterday's codebase): the brand first (branding.py prepare: the profile, the favicon set, the colours), then the packs
    (packs.py apply: the files, the mold's generators) and their checks (packs.py verify). Raises NotBuilt when a step
    fails; nothing was created or contacted by then."""
    if not uses_build(app): return codebase(app["mold_id"], root)
    if root and run is subprocess.run:   # branding.py and packs.py work in THIS factory's tree, never a temp root's
        raise NotBuilt(f"{app_id}: build_source with another factory root needs a stand-in runner; nothing was built")
    build = source_for(app_id, app, root)
    if os.path.isdir(build) and not os.path.islink(build): shutil.rmtree(build)
    elif os.path.lexists(build): os.remove(build)
    steps = []
    if (app.get("surface") or {}).get("branding"): steps.append(("the brand", [sys.executable, os.path.join(SCRIPTS, "branding.py"), app_id, "prepare"]))
    if app.get("packs"):
        steps += [("the packs", [sys.executable, os.path.join(SCRIPTS, "packs.py"), "apply", app_id]),
                  ("the packs' checks", [sys.executable, os.path.join(SCRIPTS, "packs.py"), "verify", app_id])]
    for what, cmd in steps:
        r = run(cmd, capture_output=True, text=True, cwd=root or ROOT)
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        if r.returncode: raise NotBuilt(f"{app_id}: {what} could not be applied to build/{app_id}/, so nothing was created or deployed: {out[-400:] or 'no output'}")
        if out: say("  " + out.splitlines()[-1])
    if not os.path.isdir(build): raise NotBuilt(f"{app_id}: build/{app_id}/ was not made (no step wrote it), so nothing was created or deployed.")
    return build

def check(app_id, app, infra, adir, say=print, root=None):
    """Offline and read-only. Exit 0 = ready for --deploy-remote."""
    S = settings(app_id, app, infra, root); man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root)
    F = compose_facts(cb, man)
    say(f"  server: {S['host'] or 'not supplied yet'} · domain: {S['domain'] or 'not supplied yet'} · login: {S['user']} on port {S['port']} · "
        f"SSH key name: {S['key_ref']} ({'present' if os.path.isfile(VR.key_path(S)) else 'not on this VM yet'} at {VR.key_shown(S)})")
    say(f"  the mold's own stack: {F['file']} (service {F['service']}, port {F['port'] or '?'}), compose project {S['project']} (never {F['default_project']!r}); "
        f"health {S['health_path']}")
    errs = VR.state_problems(app_id, adir)
    for e in errs: say("  state: " + e)
    pre = preflight(cb, F, S)
    for p in pre: say("  not ready: " + p)
    say("a deploy will, in order:")
    for i, st in enumerate(plan(S, F, source_for(app_id, app, root)), 1): say(f"  {i:2d}. {st['title']}")
    say(f"values only you hold, asked for at a hidden prompt during the deploy if the server lacks them: {', '.join(S['secrets_user']) or 'none'}")
    say(f"minted on the server by the mold's own {F['mint']} (not yours to set): {', '.join(n for n in F['required'] if n not in F['config'])}")
    if S["secrets_optional"]:
        say(f"optional, off while empty; set one any time with --set-secret NAME (it applies at the next deploy): {', '.join(S['secrets_optional'])}")
    todo = []
    if not S["host"] or not S["domain"]:
        todo.append(f"supply the server and the domain: python3 .claude/scripts/provision.py {app_id} --set-remote host=<address> domain=<name>")
    if not os.path.isfile(VR.key_path(S)):
        todo.append(f"make the SSH key named {S['key_ref']} and add its public half at the server provider: python3 .claude/scripts/provision.py {app_id} --remote-key")
    if errs: todo.append("fix the state problem(s) above, then run: python3 .claude/scripts/factory.py validate")
    gone = missing_build_inputs(cb, F)
    if gone: todo.append(f"the mold's codebase lacks {', '.join(gone)}, which its image build copies. " + _codebase_fix(app["mold_id"], "commit the file")
                         + " (nothing for this app's state to change)")
    elif pre: todo.append("the mold's codebase cannot be deployed as it is (see 'not ready' above). " + _codebase_fix(app["mold_id"], "see above"))
    say("check only, offline and read-only: nothing was contacted and nothing was created. " +
        ("Still to do:" if todo else f"Ready. See every command first: python3 .claude/scripts/provision.py {app_id} --deploy-remote --dry-run"))
    for t in todo: say("  - " + t)
    return 1 if todo else 0

def set_remote(app_id, adir, pairs, say=print):
    allowed = {"host": str, "domain": str, "ssh_user": str, "ssh_port": int, "ssh_key_ref": str, "provider": str, "ssh_host": str, "ssh_allow_from": str}
    ip = os.path.join(adir, "infrastructure.json"); infra = load(ip); cr = dict(infra.get("compose_remote") or {}); old = json.dumps(infra, indent=2) + "\n"
    for p in pairs:
        k, _, v = p.partition("=")
        if k not in allowed or not v: raise Stop(f"--set-remote takes {', '.join(k + '=...' for k in allowed)}; {p!r} is not one of them. Nothing was written.")
        if k == "host" and "@" in v: raise Stop("host is the server's address only (for example 203.0.113.7), without a user name. Nothing was written.")
        try: cr[k] = allowed[k](v.strip().lower() if k == "domain" else v.strip())
        except ValueError: raise Stop(f"{k} must be a number. Nothing was written.")
    if cr.get("production_url") and cr.get("domain") and cr["production_url"] != f"https://{cr['domain']}": cr.pop("production_url")
    infra["compose_remote"] = cr; save(ip, infra)
    errs = VR.state_problems(app_id, adir)
    if errs:
        with open(ip, "w") as f: f.write(old)
        raise Stop("that did not fit, so nothing was written:\n  " + "\n  ".join(errs))
    say(f"{app_id}: recorded " + ", ".join(p.partition('=')[0] for p in pairs) + f" in state/application/{app_id}/infrastructure.json")
    say(f"Next: python3 .claude/scripts/provision.py {app_id}")

def _kv(text): return VR.parse_kv(text)

def deploy(S, F, cb, runner=None, secrets_for=None, resolver=VR.resolve, read_public=None, say=print, release=None, wait=time.sleep, bundle_dir=None):
    """Run the plan. Returns {"health", "release", "facts"}; raises Stop with one instruction otherwise. Every outside
    call goes through `runner`, `resolver` and `read_public`, so the whole sequence runs offline in the self-test."""
    runner = runner or VR.real_runner; release = release or release_id()
    pre = preflight(cb, F, S)
    if pre: raise Stop("This app cannot be deployed from the mold's snapshot as it is; nothing was contacted:\n  - " + "\n  - ".join(pre))
    own = bundle_dir is None; bundle_dir = bundle_dir or tempfile.mkdtemp(prefix="sf-single-")
    try:
        write_bundle(S, F, bundle_dir)
        bad = rehearse(bundle_dir)
        if bad: raise Stop("The bundle failed its rehearsal on this machine; nothing was contacted:\n  - " + "\n  - ".join(bad))
        say("[rehearsal] the generated scripts parse and the server-side tool imports from the bundle alone")
        steps = {s["id"]: s for s in plan(S, F, cb, bundle_dir, shown=False, release=release)}
        def run(sid, stdin=None, check=True):
            st = steps[sid]; say(f"[{sid}] {st['title']}")
            r = runner(st, stdin)
            for l in [l for l in VR.redact(r.stdout or "").splitlines() if l.strip() and not re.match(r"^[A-Z_]+=", l)][-6:]: say("    " + l)
            if check and r.returncode:
                tail = VR.redact(((r.stderr or "") + (r.stdout or "")).strip())[-400:]
                raise Stop(f"step {sid} failed (exit {r.returncode}): {tail}. Nothing after it ran; it is safe to run the deploy again.")
            return r
        r = run("qualify", open(os.path.join(bundle_dir, "qualify.sh")).read(), check=False)
        if r.returncode: raise Stop(f"could not log in to the server: {VR.redact((r.stderr or 'no answer').strip())[-200:]}. Check the address and that the key named {S['key_ref']} was added there.")
        facts = _kv(r.stdout); bad = qualify(facts, S)
        if bad: raise Stop("This server cannot run the stack:\n  - " + "\n  - ".join(bad))
        why = VR.dns_problem(S, resolver)
        if why: raise Stop(why)
        say("[dns] the domain points at the server")
        for sid in ("bundle", "packages", "firewall"): run(sid)
        have = set((run("names").stdout or "").split())
        missing = [n for n in S["secrets_user"] if n not in have]
        vals = (secrets_for or (lambda m: VR.collect_secrets(S["app_id"], m)))(missing) if missing else {}
        for k, v in vals.items():
            if "$" in v: raise Stop(f"{k} contains a $ sign, which the compose env file would read as a variable; nothing was sent. Check the value.")
        run("release-dir"); run("source")
        pairs = dict(config_pairs(S, F), **vals)
        run("env", "".join(f"{k}={v}\n" for k, v in pairs.items()))
        r = run("up", check=False); kv = _kv(r.stdout)
        if r.returncode:
            if kv.get("ROLLED_BACK"): raise Stop(f"release {release} did not come up healthy, so the server switched back by itself to {kv['ROLLED_BACK']}, which serves again. Fix the cause and deploy again.")
            if kv.get("ROLLBACK_FAILED"): raise Stop(f"release {release} did not come up, and the release before it ({kv['ROLLBACK_FAILED']}) did not either. THE SITE IS DOWN. Try: python3 .claude/scripts/provision.py {S['app_id']} --rollback-remote")
            raise Stop(f"release {release} did not come up and there was no earlier release to go back to (exit {r.returncode}): " + VR.redact((r.stderr or "").strip())[-300:])
        kv = _kv(run("health").stdout)
        url = S["url"] + S["health_path"]
        for attempt in range(PUBLIC_WAIT_S // 10 + 1):     # a first deploy: the certificate arrives after `up`
            public = (read_public or _read_public)(url)
            if str(public[0]) == "200": break
            wait(10)
        bad = health_verdict(F, kv, public); rls = None
        if not bad and F.get("rls"):
            r = run("rls", check=False); out = (r.stdout or "") + "\n" + (r.stderr or "")
            rls = {"passed": rls_passed(r.returncode, out, F["rls"]), "said": rls_said(out, F["rls"]), "exit": r.returncode}
            if not rls["passed"]: bad.append(f"the product's row-level security check failed on the deployed database (exit {r.returncode}): {rls['said'] or 'no output'}")
            else: say(f"    {rls['said']}")
        if bad:
            # The release came up but does not serve: back to the one that served before, by itself (as on Vercel).
            rb = run("back", check=False); bk = _kv(rb.stdout)
            what = (f"the server switched back by itself to {bk['ROLLED_BACK']}, which serves again" if rb.returncode == 0 and bk.get("ROLLED_BACK") else
                    f"there was no earlier release to switch back to, so {release} is still in place" if rb.returncode == 0 and bk.get("NOTHING") else
                    f"the switch back to {bk.get('ROLLBACK_FAILED') or 'the earlier release'} FAILED too; try: python3 .claude/scripts/provision.py {S['app_id']} --rollback-remote")
            e = Stop(f"release {release} came up but does not serve as it should: " + "; ".join(bad) + f". {what}. Fix the cause and deploy again.")
            e.rls = rls; raise e
        say(f"[public] {url} answered 200 ok")
        run("keep", check=False)
        return {"release": release, "facts": facts,
                "health": {"app": kv.get("APP_STATE", ""), "uid": kv.get("APP_UID", ""), "published": kv.get("PUBLISHED", ""),
                           "public": str(public[0]), "disk_percent": kv.get("DISK_PERCENT", ""), "at": now()}, "rls": rls}
    finally:
        if own: shutil.rmtree(bundle_dir, ignore_errors=True)

def _read_public(url):
    sys.path.insert(0, SCRIPTS); import provision
    return provision._read_health(url)

def record(adir, app, infra, S, res, mold_commit, save_fn=save):
    cr = infra.setdefault("compose_remote", {})
    cr["production_url"] = f"https://{S['domain']}"; cr["health"] = res["health"]; cr["release"] = res["release"]
    infra["deployed_at"] = now()
    app["status"] = "stamped" if app.get("status") in (None, "planned", "stamping", "reverted") else app["status"]
    app.pop("revert", None)
    if mold_commit: app["mold_commit"] = mold_commit
    save_fn(os.path.join(adir, "infrastructure.json"), infra); save_fn(os.path.join(adir, "application.json"), app)

def revert(adir, app, reason, save_fn=save):
    app["status"] = "reverted"; app["revert"] = {"reason": reason[:400], "lane": "functional", "at": now()}
    save_fn(os.path.join(adir, "application.json"), app)

def mold_commit(mold_id, root=None):
    """What an app built now records as its mold_commit: an in-tree mold's version in this repository (lib/intree.py),
    else the pin in state/factory.json."""
    import intree
    try: v = intree.version(mold_id, root or ROOT)
    except intree.Unreadable: v = None
    if v: return v
    for m in load(os.path.join(root or ROOT, "state", "factory.json")).get("molds", []):
        if m.get("mold_id") == mold_id: return (m.get("source") or {}).get("commit", "")
    return ""

def _ready_to_contact(S, app_id):
    if not S["host"] or not S["domain"]:
        raise Stop(f"{app_id}: the server address and the domain are not in state yet. Nothing was contacted. "
                   f"Supply them: python3 .claude/scripts/provision.py {app_id} --set-remote host=<address> domain=<name>")
    if not os.path.isfile(VR.key_path(S)):
        raise Stop(f"{app_id}: there is no SSH key named {S['key_ref']} on this VM. Nothing was contacted. Make it: python3 .claude/scripts/provision.py {app_id} --remote-key")
    for tool in ("ssh", "rsync"):
        if not shutil.which(tool): raise Stop(f"this VM has no `{tool}` command, which the deploy needs. Nothing was contacted.")

def _hidden_value(app_id, name, P):
    """One value at a hidden prompt, from the operator's own terminal; never from a pipe (exit 3 instead)."""
    import agent_result as AR
    if sys.stdin.isatty():
        P.explain(name); v = getpass.getpass(f"{name} (input hidden): ").strip(); v = P.strip_pasted_name(name, v)
    elif P.trusted_stdin(): v = sys.stdin.readline().strip()
    else:
        AR.need("secret", name, AR.secret_how(app_id, name))
        P.stop_for_human(f"This window cannot hide what you type, so nothing was read and nothing was saved. The operator runs this "
                         f"themselves, in a separate terminal on this machine:\n  python3 .claude/scripts/provision.py {app_id} --set-secret {name}")
    AR.forbid(v)
    if not v: raise Stop("nothing entered; nothing was stored")
    return v

def set_secret_remote(app_id, S, name, P, runner=None, value=None, say=print):
    declared = set(S["secrets_user"]) | set(S["secrets_optional"])
    if name not in declared:
        raise Stop(f"{name} is not a name this app reads from its operator (it reads: {', '.join(sorted(declared)) or 'none'}). The NAME goes on the "
                   f"command line and the value is asked for afterwards. Nothing was stored.")
    _ready_to_contact(S, app_id)
    v = value if value is not None else _hidden_value(app_id, name, P)
    why = VR.env_check(name, v) or ("it contains a $ sign, which the compose env file would read as a variable" if "$" in v else None)
    if why: raise Stop(f"{why}. Nothing was stored.")
    st = {"id": "set-secret", "argv": VR.ssh_argv(S, VR.guarded(S, f"python3 {S['vr_tool']} env-merge --file {S['env_file']}")), "timeout": 60}
    r = (runner or VR.real_runner)(st, f"{name}={v}\n")
    if r.returncode: raise Stop(f"{name} was not stored: " + VR.redact((r.stderr or r.stdout or "").strip())[-200:] +
                                f". If the app was never deployed there, deploy it first: python3 .claude/scripts/provision.py {app_id} --deploy-remote")
    say(f"{name} is stored on the server (its env file, root only; the value was never shown or kept here). It applies at the next deploy: "
        f"python3 .claude/scripts/provision.py {app_id} --deploy-remote")
    return 0

def rollback_remote(app_id, S, F, dry=False, runner=None, say=print):
    st = {"id": "rollback", "title": "the server back to the release that served before (up.sh with the previous release)",
          "argv": VR.ssh_argv(S, VR.guarded(S, f"bash {S['factory_dir']}/up.sh --back"), shown=dry), "timeout": UP_WAIT_S * 2 + 600}
    if dry:
        say(f"{app_id}: --rollback-remote would run, and nothing was contacted:\n  $ {VR.shown_cmd(S, st['argv'])}"); return 0
    _ready_to_contact(S, app_id)
    r = (runner or VR.real_runner)(st, None); kv = _kv(r.stdout)
    if r.returncode == 0 and kv.get("NOTHING"): say(f"{app_id}: {kv['NOTHING']}."); return 0
    if r.returncode == 0: say(f"{app_id}: the server serves release {kv.get('SERVING')} again (the one before the last deploy); run --rollback-remote again to go forward."); return 0
    say(f"{app_id}: the rollback did not finish (exit {r.returncode}): " + VR.redact((r.stderr or "").strip())[-300:]); return 1

# ---------------------------------------------------------------------------------------------------------
# the lanes' MCP check: an organisation of the app's own, its connector address kept privately
# ---------------------------------------------------------------------------------------------------------
def private_dir():
    import services
    return services.private_dir()
def write_private(path, text):
    """A private file: its directory 0700 and the file 0600, enforced even when either already exists with wider modes
    (os.makedirs and os.open apply a mode only to what they create)."""
    d = os.path.dirname(path); os.makedirs(d, mode=0o700, exist_ok=True); os.chmod(d, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try: os.fchmod(fd, 0o600); os.write(fd, text.encode())
    finally: os.close(fd)
def lane_key_path(app_id): return os.path.join(private_dir(), f"{app_id}.mcp-connector")

def lane_key_ok(app_id, url):
    """The private connector file exists and is for THIS app's address (a key for another address grades nothing)."""
    p = lane_key_path(app_id)
    if not url or not os.path.isfile(p): return False
    return (open(p).read().strip().split("/mcp/")[0].rstrip("/") == url.rstrip("/"))

def lane_key_argv(S, F, man, again=False, shown=False):
    lk = man["lane_key"]; args = lk["again"] if again else lk["create"]
    inner = " ".join(shlex.quote(x) for x in ["node", "--import", "tsx", lk["script"], *args])
    dc = (f"docker compose -p {shlex.quote(S['project'])} -f {S['current']}/{S['compose_file']} --env-file {shlex.quote(S['env_file'])} "
          f"exec -T {shlex.quote(F['service'])} {inner}")
    return VR.ssh_argv(S, f"{S['sudo']}{dc}", shown=shown)

def lane_key(app_id, app, infra, a, P, runner=None, say=print, root=None, adir=None):
    """Make (or add a key to) the app's own lane-check organisation and keep its connector address privately."""
    import agent_result as AR
    man = manifest(app["mold_id"], root); F = compose_facts(codebase(app["mold_id"], root), man); lk = man.get("lane_key")
    if not lk: raise Stop(f"{app['mold_id']} declares no lane_key in its mold.json, so there is nothing to make.")
    t = infra.get("target"); S = settings(app_id, app, infra, root)
    url = (infra.get("compose_remote") or {}).get("production_url") if t == "compose_remote" else (infra.get("vercel") or {}).get("api_url")   # the MCP check targets the API
    what = (f"the product's own {lk['script']} \"{lk['create'][0]}\" {lk['create'][1]} (or, when that organisation exists, a new key for it), "
            f"run {'in its container on the server' if t == 'compose_remote' else 'here against its production database'}; the connector address it prints "
            f"is written to {lane_key_path(app_id)} (mode 600), never shown")
    if "--dry-run" in a:
        say(f"{app_id}: --lane-key would make {what}.")
        if t == "compose_remote": say("  $ " + VR.shown_cmd(S, lane_key_argv(S, F, man, shown=True)))
        say("dry run: nothing was contacted or written."); return 0
    if not url: raise Stop(f"{app_id} is not deployed yet, so it has no database to make an organisation in. Deploy it first.")
    if "--yes" not in a:
        AR.need("approval", "lane-check organisation", f"Say yes to adding an organisation named \"{lk['create'][0]}\" to {app_id}'s data, used only by the "
                f"lanes' MCP check; then: python3 .claude/scripts/provision.py {app_id} --lane-key --yes")
        P.stop_for_human(f"{app_id}: this writes to the app's data ({what}). It runs only with --yes, after the operator said yes. See it first: "
                         f"python3 .claude/scripts/provision.py {app_id} --lane-key --dry-run")
    if t == "compose_remote":
        _ready_to_contact(S, app_id); run = runner or VR.real_runner
        r = run({"id": "lane-key", "argv": lane_key_argv(S, F, man), "timeout": 120}, None)
        if r.returncode: r = run({"id": "lane-key", "argv": lane_key_argv(S, F, man, again=True), "timeout": 120}, None)
        out = r.stdout or ""
    else:
        vals = P.pull_env(codebase(app["mold_id"], root), vercel_projects(vercel_project(infra))["api"], required=False)   # the database is the api project's alone
        if not vals.get("DATABASE_URL") or vals["DATABASE_URL"] == "[SENSITIVE]": raise Stop(f"{app_id}: DATABASE_URL could not be read back from the api project; nothing was made.")
        env = dict(os.environ, DATABASE_URL=vals["DATABASE_URL"], PUBLIC_URL=url); AR.forbid(vals["DATABASE_URL"])
        cmd = ["npx", "tsx", lk["script"]]
        r = subprocess.run(cmd + lk["create"], cwd=codebase(app["mold_id"], root), env=env, capture_output=True, text=True, timeout=180)
        if r.returncode: r = subprocess.run(cmd + lk["again"], cwd=codebase(app["mold_id"], root), env=env, capture_output=True, text=True, timeout=180)
        out = r.stdout or ""
    m = re.search(lk["url_pattern"], out)
    if r.returncode or not m:
        raise Stop(f"{app_id}: the organisation's connector address was not made (exit {r.returncode}): " + VR.redact(re.sub(lk["url_pattern"], "<address>", (r.stderr or out)))[-300:])
    AR.forbid(m.group(0))
    write_private(lane_key_path(app_id), m.group(0) + "\n")
    if t == "compose_remote" and adir:      # names only: which organisation, and when (the address stays in the private file)
        infra["compose_remote"]["lane_key"] = {"slug": lk["create"][1], "at": now()}; save(os.path.join(adir, "infrastructure.json"), infra)
    say(f"{app_id}: the lane-check organisation's connector address is kept in {lane_key_path(app_id)} (mode 600, never shown). The MCP check can run: "
        f"python3 .claude/scripts/lanes.py {app_id} --lane functional")
    return 0

# ---------------------------------------------------------------------------------------------------------
# vercel: two projects, the API function and the web console (mold_v0-029)
# ---------------------------------------------------------------------------------------------------------
# The operator's decision (2026-10-20): the product runs on Vercel as TWO projects. <base>-api is the API and MCP
# function, deployed from the snapshot's own vercel.json; <base> is the web console (web/, a server-rendered Next.js
# app with a middleware) as its own Next.js project, pointed at the API through the one variable its next.config reads
# for the API's address. The suffixes are vercel_addr.ROLES' own ("" and "-api"), so provision.py's LIVE-project
# refusal, intake's taken names and the address guard cover both projects as they cover mold_v1's.
SUFFIX = {"api": "-api", "web": ""}
ORDER = ("api", "web")                       # deployed in this order: the console is pointed at the API's address
PAGE_OK = re.compile(r"^(2\d\d|3\d\d|401|403)$")   # a console page that renders, or its sign-in redirect / refusal

def vercel_project(infra): return (infra.get("vercel") or {}).get("project", "")
def vercel_projects(base): return {r: f"{base}{s}" for r, s in SUFFIX.items()} if base else {}
def vercel_spec(man, role): return (((man or {}).get("vercel") or {}).get("projects") or {}).get(role) or {}

NEXT_CONFIGS = ("next.config.ts", "next.config.mjs", "next.config.js")
API_ENV = re.compile(r"""process\.env\.([A-Z][A-Z0-9_]*)\s*\?\?\s*['"`]https?://""")
def console_facts(cb, man):
    """What the console project needs, READ from the snapshot each time: its directory, its Next.js config, the ONE
    variable that config reads for the API's address (`process.env.NAME ?? 'http://...'`), whether its lockfile is
    committed (Vercel installs from it), and the sign-in names the operator sets for it (mold.json operator_env)."""
    w = vercel_spec(man, "web"); d = w.get("dir", "web"); wd = os.path.join(cb, d)
    cfg = next((f for f in NEXT_CONFIGS if os.path.isfile(os.path.join(wd, f))), "")
    names = sorted(set(API_ENV.findall(open(os.path.join(wd, cfg)).read()))) if cfg else []
    env = w.get("operator_env") or {}
    return {"dir": d, "present": os.path.isdir(wd), "config": f"{d}/{cfg}" if cfg else "", "api_env": names[0] if len(names) == 1 else "",
            "api_env_found": names, "framework": w.get("framework", "nextjs"), "lockfile": os.path.isfile(os.path.join(wd, "package-lock.json")),
            "required": sorted(n for n, k in env.items() if k == "required"), "optional": sorted(n for n, k in env.items() if k != "required"),
            "proxied_health": w.get("proxied_health") or man.get("health_path", "/healthz"), "pages": list(w.get("pages") or ["/admin", "/app"])}

def console_preflight(K):
    """Plain sentences for what stops the console project before anything is created; [] when none."""
    bad = []
    if not K["present"]: return [f"the console's directory {K['dir']}/ is not in the mold's snapshot"]
    if not K["config"]: bad.append(f"{K['dir']}/ has no next.config (.ts, .mjs or .js), so it is not the Next.js console the second project builds")
    elif not K["api_env"]:
        found = ", ".join(K["api_env_found"]) or "none"
        bad.append(f"{K['config']} must read exactly one variable for the API's address (process.env.NAME ?? 'http://...'); it reads {found}. "
                   f"The console project is pointed at the API through that variable")
    if not K["lockfile"]:
        bad.append(f"{K['dir']}/package-lock.json is not committed in the mold's snapshot, so Vercel cannot install the console's exact dependencies "
                   f"(commit it: for an in-tree mold such as mold_v0, in this repository by pull request; otherwise in the mold's source, then mold.py refresh)")
    return bad

def api_names(F):
    """Every name the API project reads (minted, provisioned or optional), from the compose file and the manifest."""
    u, d, o = secret_names(F, "vercel", K=None)
    return set(u) | set(d) | set(o)

def project_for(F, K, name):
    """Which of the two projects take NAME: the API when it reads it, the console when it is one of its sign-in names."""
    return [r for r, hit in (("api", name in api_names(F)), ("web", name in set(K["required"]) | set(K["optional"]))) if hit]

def taken_by_others(app_id, root=None):
    """{project name: app id} for every Vercel project another (not retired) app deploys to: its base, -api and
    -workflow names, and any names its state records."""
    out = {}; adir = os.path.join(root or ROOT, "state", "application")
    for o in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
        if o in (app_id, "app_id"): continue
        try:
            v = load(os.path.join(adir, o, "infrastructure.json")).get("vercel") or {}
            st = load(os.path.join(adir, o, "application.json")).get("status")
        except (OSError, ValueError): continue
        if st in ("retired", "dropped"): continue
        b = v.get("project")
        for n in ([b, f"{b}-api", f"{b}-workflow"] if b else []) + [x for x in (v.get("projects") or {}).values() if isinstance(x, str)]:
            if n: out.setdefault(n, o)
    return out

def refuse_project(app_id, infra, P, root=None):
    """provision.py's own refusal (a LIVE project, or a base another app deploys to) and, for BOTH of this app's
    projects, any name another app holds, as a Stop, before any project is read or written."""
    try: P._refuse_live_or_shared_project(app_id, infra)
    except SystemExit as e: raise Stop(str(e.code if e.code is not None else e))
    base = vercel_project(infra); mine = vercel_projects(base); rec = (infra.get("vercel") or {}).get("projects")
    if not base: raise Stop(f"{app_id}: state names no Vercel project (vercel.project). Nothing was written.")
    if rec and rec != mine:
        raise Stop(f"{app_id}: vercel.projects says {rec}, but the projects of the base name {base!r} are {mine}. The deploy writes that line; "
                   f"delete it from state/application/{app_id}/infrastructure.json and rerun. Nothing was written.")
    others = taken_by_others(app_id, root)
    hit = [f"{n} is {others[n]}'s project" for n in mine.values() if n in others]
    if hit:
        raise Stop(f"{app_id}: " + "; ".join(hit) + ". One project is one environment namespace, so this app's values would land in another "
                   f"app's. Give this app its own vercel.project in state/application/{app_id}/infrastructure.json and rerun. Nothing was written.")

def project_exists(P, name, cb):
    """True / False for a project of this team, False ONLY when Vercel answers not-found. Any other failure (not signed
    in, no network, an unreadable answer) is a Stop: a project that cannot be read is never taken for an empty one,
    which would ask the operator for keys it already holds."""
    if P._project_meta(name, cb).get("id"): return True
    rc, doc, err = P._vapi(f"/v9/projects/{name}", cb)
    e = doc.get("error") if isinstance(doc, dict) else None
    if (isinstance(e, dict) and e.get("code") == "not_found") or "not found" in (err or "").lower(): return False
    if isinstance(doc, dict) and doc.get("id"): return True
    raise Stop(f"{name} could not be read from Vercel ({VR.redact(err or 'no answer')[:160]}), so it is not known what it holds. "
               "Check that this machine is signed in to Vercel (vercel whoami) and rerun. Nothing was created or deployed.")

def choose_names(app_id, infra, cb, P, adir=None, say=print, root=None):
    """The app's two project names, BEFORE anything creates either: when NEITHER exists yet and a name is taken in this
    team or on vercel.app (someone else's), provision.py's own choice of a free base is used and recorded in
    vercel.name_history; the new names pass the same refusals; no free name at all is refused. Every writer that may
    create a project (--deploy and --set-secret) comes through here first. Returns {role: project}."""
    v = infra["vercel"]; base = v["project"]; names = vercel_projects(base)
    if not any(P._project_meta(n, cb).get("id") for n in names.values()):
        new, note = P.choose_project_base(app_id, base, infra, cb)
        if not new: raise Stop(f"refusing to create {base}'s projects: {note}. Set vercel.project in state/application/{app_id}/infrastructure.json to a free name and rerun. Nothing was created.")
        if new != base:
            why = note.split(", so the projects")[0]
            v.setdefault("name_history", []).append({"at": now(), "from": base, "to": new, "why": why[:300]})
            v["project"] = new; v.pop("projects", None); names = vercel_projects(new)
            refuse_project(app_id, infra, P, root)
            say(f"  {why}: this app's projects are named {names['api']} (the API) and {names['web']} (the console) instead")
    v["projects"] = names
    if adir: save(os.path.join(adir, "infrastructure.json"), infra)
    return names

def ensure_projects(app_id, infra, cb, K, P, adir=None, say=print, root=None):
    """The app's two projects, created where absent under the team scope (`vercel project add <name> --scope <team>`),
    unhooked from git at once, the console set to its framework preset, under the names choose_names() gives (a free
    base chosen and recorded when neither exists yet and a name is taken). Returns {role: project}."""
    team = infra["vercel"].get("team", "")
    names = choose_names(app_id, infra, cb, P, adir=adir, say=say, root=root)
    for r in ORDER:
        n = names[r]
        ensure_project(n, team, cb, P, say=lambda l, r=r: say(f"{l} ({'the API' if r == 'api' else 'the console'})"))
        if r == "web" and P._project_meta(n, cb).get("framework") != K["framework"]:
            try: P.set_framework(n, K["framework"], cb)
            except SystemExit as e: raise Stop(str(e.code if e.code is not None else e))
    return names

def vercel_plan(app_id, F, infra, man, K=None, cb=None, app=None):
    v = infra.get("vercel") or {}; names = vercel_projects(vercel_project(infra)); team = v.get("team", ""); sc = f" --scope {team}" if team else ""
    K = K or console_facts(cb or codebase(man["mold_id"]), man)
    minted = ", ".join(n for n in infra.get("secrets_derived") or [] if n != "DATABASE_URL")
    signin = ", ".join(K["required"] + K["optional"]) or "none"
    return [f"refuse {names.get('api')} or {names.get('web')} if either is a LIVE project or another app's (provision.py's rule and every name another app holds), before anything is written",
            f"two Vercel projects, each created if absent with `vercel project add <name>{sc}` and never connected to git: {names.get('api')} (the API and MCP "
            f"function, from {man['vercel']['projects']['api'].get('config', 'vercel.json')}) and {names.get('web')} (the console, {K['dir']}/, framework {K['framework']}); "
            f"when neither exists and a name is taken (in this team or on vercel.app), a free base name is chosen and recorded",
            f"{names.get('api')} only: the app's own Postgres, an empty free Neon database adopted or a new one from the Vercel Marketplace (provision.py's "
            f"Neon provisioning: proven empty in a throwaway project before it is connected); DATABASE_URL is the one the integration writes, never written here",
            f"{names.get('api')} only: minted if absent by the mold's own {F['mint']} in a private temp directory here (values never shown): {minted or 'nothing'}",
            (f"build/{app_id}/ made afresh from the codebase with this app's own " + " and ".join(x for x, y in (("brand (branding.py prepare)", (app.get("surface") or {}).get("branding")), ("packs (packs.py apply, then verify)", app.get("packs"))) if y)
             + ", before anything is created; the deployment serving each project now is recorded" if uses_build(app)
             else f"a build copy build/{app_id}/ of the snapshot (no node_modules, no .next); the deployment serving each project now is recorded"),
            f"vercel deploy --prod --yes --project {names.get('api')}{sc} from the copy; its address read back from Vercel; PUBLIC_URL set to it (one more deploy when it changed); "
            f"health: <api>{man['health_path']} answers 200 ok",
            f"{names.get('web')}: {K['api_env'] or '<the API-address variable>'} set to the API's address (nothing else of the API's: never DATABASE_URL, never a minted key; "
            f"sign-in names the operator sets for it: {signin})",
            f"vercel deploy --prod --yes --project {names.get('web')}{sc} from build/{app_id}/{K['dir']}/; its address read back from Vercel",
            f"health: <console>{K['proxied_health']} answers 200 ok through the console (it reaches the API), and {' and '.join(K['pages'])} answer (a page, or its sign-in redirect; never 5xx)",
            "if anything after the first deploy fails: BOTH projects back on the production deployment that served before (where there was one)",
            "state: vercel.projects, vercel.api_url, vercel.production_url (the console: people open it, and it carries the API's paths too), vercel.health, "
            "vercel.release, deployed_at, status stamped (or reverted, with the reason and the rollback)"]

def mint_values(cb, F, names, run=subprocess.run):

    """{name: value} for `names`, minted by the mold's own bootstrap script in a private temp directory. In memory only."""
    out = {}; t = tempfile.mkdtemp(prefix="sf-mint-")
    try:
        os.chmod(t, 0o700); shutil.copyfile(os.path.join(cb, F["mint"]), os.path.join(t, "bootstrap.sh"))
        r = run(["bash", os.path.join(t, "bootstrap.sh")], cwd=t, capture_output=True, text=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": t})
        if r.returncode: raise Stop(f"the mold's own {F['mint']} could not mint (exit {r.returncode}); nothing was written")
        vals = VR.env_read(os.path.join(t, ".env"))
        out = {n: vals[n] for n in names if vals.get(n)}
    finally: shutil.rmtree(t, ignore_errors=True)
    if "CRON_SECRET" in names and "CRON_SECRET" not in out: out["CRON_SECRET"] = pysecrets.token_hex(32)
    return out

def ensure_project(proj, team, cb, P, say=print):
    """Create one project if absent, under the team scope, and unhook it from git. True when it created it."""
    if P._project_meta(proj, cb).get("id"): return False
    r = P.vrun(f"vercel project add {proj}" + (f" --scope {team}" if team else ""), shell=True, cwd=cb, capture_output=True, text=True)
    if not P._project_meta(proj, cb).get("id"): raise Stop(f"could not create the Vercel project {proj}: " + ((r.stdout or "") + (r.stderr or "")).strip()[-200:])
    P.disconnect_git(proj, cb); say(f"  created the Vercel project {proj}")
    return True

DB_STAT_MJS = """import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DB_URL, connectionTimeoutMillis: 15000 });
await c.connect();
try {
  const { rows: [r] } = await c.query(`SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables,
    (SELECT count(*)::int FROM pg_policies) AS policies, pg_size_pretty(pg_database_size(current_database())) AS size`);
  console.log(JSON.stringify(r));
} finally { await c.end().catch(() => {}); }
"""
def db_stat_with(cb, P):
    """provision.py's _db_stat (is this database empty?), read with the mold's own `pg` client: the mold's node_modules,
    linked from a temp directory, never a file in the snapshot. The address stays in an environment variable."""
    def stat(mold_dir, proj, key="DATABASE_URL_UNPOOLED", environment="production"):
        vals = P.pull_env(mold_dir, proj, environment=environment, required=False)
        url = vals.get(key) or vals.get("DATABASE_URL")
        if not url: return None
        d = tempfile.mkdtemp(prefix="sf-dbstat-")
        try:
            os.symlink(os.path.join(os.path.abspath(cb), "node_modules"), os.path.join(d, "node_modules"))
            open(os.path.join(d, "db-stat.mjs"), "w").write(DB_STAT_MJS)
            r = subprocess.run(["node", os.path.join(d, "db-stat.mjs")], cwd=d, env=dict(os.environ, DB_URL=url), capture_output=True, text=True, timeout=60)
            try: return json.loads((r.stdout.strip().splitlines() or ["{}"])[-1]) if r.returncode == 0 else None
            except ValueError: return None
        finally: shutil.rmtree(d, ignore_errors=True)
    return stat

def ensure_database(app_id, infra, cb, proj, present, P, say=print):
    """The app's own Postgres through provision.py's Neon provisioning: an empty spare adopted or a new free one made,
    each proven EMPTY in a throwaway project before the app's project is connected to it (a database already holding
    tables is never adopted). DATABASE_URL is the one the integration writes; this factory never writes it here, and
    never replaces one that is already set (write-once). Returns True when it provisioned."""
    if "DATABASE_URL" in present: return False
    if not os.path.isfile(os.path.join(cb, "node_modules", "pg", "package.json")):
        raise Stop(f"the emptiness check reads the database with the mold's own `pg` client, which is not installed in molds/{os.path.basename(os.path.dirname(cb))}/codebase. "
                   f"Install the mold's dependencies first: npm --prefix {os.path.relpath(cb, ROOT)} ci. Nothing was provisioned.")
    real = P._db_stat; P._db_stat = db_stat_with(cb, P)
    try:
        try: P.adopt_or_create_neon(app_id, cb, infra, proj)
        except SystemExit as e: raise Stop(str(e.code if e.code is not None else e))
    finally: P._db_stat = real
    if "DATABASE_URL" not in P.vercel_env_names(cb, proj):
        raise Stop(f"{proj}: a database was connected but no DATABASE_URL arrived on the project. Nothing was deployed.")
    say(f"  {proj}: the app's own Postgres is connected ({(infra.get('datastores') or {}).get('neon_resource', 'Neon')}); DATABASE_URL written by the integration, never shown")
    return True

def _read_page(url):
    """(status, why) for one console page, WITHOUT following a redirect: a sign-in redirect is an answer. Read-only."""
    # Asked as a browser's page navigation: sign-in middleware (e.g. Clerk's protect()) answers a signed-out page load with
    # a redirect to sign-in, but a request that does not look like a page load with 404, which would read as broken.
    r = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}",
                        "-H", "Accept: text/html,application/xhtml+xml", "-H", "Sec-Fetch-Dest: document", "-H", "Sec-Fetch-Mode: navigate", url],
                       capture_output=True, text=True)
    m = re.search(r"(\d{3})\s*$", r.stdout or "")
    if r.returncode or not m or m.group(1) == "000":
        return "", "nothing answered: " + (((r.stderr or "").strip().splitlines() or ["no response"])[-1])[:120]
    return m.group(1), ""

def _healthy(res): return str(res[0]) == "200" and isinstance(res[1], dict) and res[1].get("ok") is True
def _said(res): return (f"HTTP {res[0]}" if res[0] else "nothing") + (f" ({res[2]})" if res[2] else "")

def console_verdict(P, url, K, read_page=_read_page):
    """([why the console does not serve], health record): <console><proxied_health> answers 200 ok THROUGH the console
    (so its API-address variable reaches the API), and each page answers: a page, its sign-in redirect or a refusal;
    never a 5xx and never nothing."""
    bad = []; res = P._read_health(url + K["proxied_health"])
    if not _healthy(res): bad.append(f"{K['proxied_health']} through the console answered {_said(res)}, so the console does not reach the API")
    pages = {}
    for pg in K["pages"]:
        code, why = read_page(url + pg); pages[pg] = code or "no answer"
        if not PAGE_OK.match(code or ""): bad.append(f"{pg} answered {_said((code, None, why))}")
    return bad, {"web": str(res[0]) if res[0] else "no answer", "pages": pages}

def rollback_both(before, cb, P, why, by="the deploy's own health check", health_urls=None):
    """Both projects back on the production deployment recorded before this run, the console first, then health read
    AGAIN on every project that had one to go back to (health_urls: {role: address + health path}). result is
    'rolled back' only when every such project moved back and each health answered 200 ok (the schema's rule);
    otherwise it says what was measured. Never raises: the caller decides how the run ends. Returns the record kept
    in vercel.rollback."""
    rec = {"at": now(), "by": by, "why": why[:300], "projects": {}}
    for r in ("web", "api"):
        b = before.get(r) or {}
        if not b.get("id"): rec["projects"][r] = "nothing to roll back to: no production deployment before this one"; continue
        try:
            cur = P.production_of(b["project"], cb) or {}
            if cur.get("id") == b["id"]: rec["projects"][r] = f"already serving {b['id']}"; continue
            ok, detail = P._point_production(b, b["id"], cb, "rollback")
        except SystemExit as e: ok, detail = False, str(e.code if e.code is not None else e)[:200]
        except BaseException as e:   # never raises: an error (or a second Ctrl-C) here is recorded, and the caller still reverts
            ok, detail = False, f"the rollback itself stopped ({type(e).__name__})"
        rec["projects"][r] = f"rolled back to {b['id']}" if ok else f"NOT rolled back: {detail}"
    rec["health"] = {}
    for r in ("web", "api"):
        if not (before.get(r) or {}).get("id"): continue      # nothing went back there, so there is nothing to re-read
        u = (health_urls or {}).get(r)
        if not u: rec["health"][r] = "no address recorded"; continue
        try:
            res = P._read_health(u)
            rec["health"][r] = "200" if _healthy(res) else (f"{res[0]} (not ok)" if str(res[0]) == "200" else (str(res[0]) or "no answer"))
        except BaseException as e:   # never raises; a read that blew up is what was measured
            rec["health"][r] = f"not read: {type(e).__name__}"
    vals = list(rec["projects"].values())
    moved = any(x.startswith(("rolled back", "already serving")) for x in vals)
    stayed = [r for r, x in rec["projects"].items() if x.startswith("nothing to roll back to")]
    healthy = rec["health"] and all(h == "200" for h in rec["health"].values())
    rec["result"] = ("rollback FAILED" if any(x.startswith("NOT") for x in vals) else
                     "nothing to roll back to" if not moved else
                     "rolled back, but health is not all 200" if not healthy else
                     f"partly rolled back: {', '.join(stayed)} had nothing to go back to" if stayed else
                     "rolled back")
    return rec

def _rollback_recorded(before, cb, P, why, health_urls, v, ipath, infra):
    """rollback_both, its record kept in vercel.rollback and saved whatever happens (rollback_both never raises; the
    save still runs if something around it does)."""
    rec = {"at": now(), "by": "the deploy's own health check", "why": why[:300], "projects": {}, "result": "rollback interrupted"}
    try:
        urls = {}
        try: urls = health_urls()
        except Exception: pass
        rec = rollback_both(before, cb, P, why, health_urls=urls)
    finally:
        v["rollback"] = rec; save(ipath, infra)
    return rec

def _rollback_said(rec, names):
    """One sentence for the operator: where each project now is, and what health said after it."""
    back = "; ".join(f"{names[role]}: {x}" for role, x in rec["projects"].items())
    health = ", ".join(f"{names[r]} {h}" for r, h in (rec.get("health") or {}).items())
    warn = (" THE SITE MAY BE DOWN." if rec["result"] == "rollback FAILED" else
            f" Health after it is not all 200 ({health}): the site may not be serving." if rec["result"].startswith("rolled back, but") else
            f" {rec['result'][0].upper() + rec['result'][1:]}, so it still serves this run's deployment." if rec["result"].startswith("partly") else "")
    if rec["result"] == "rollback interrupted": warn = " THE ROLLBACK WAS INTERRUPTED: THE SITE MAY BE DOWN."
    return f"Both projects were put back where possible ({back}).{warn}" + (f" Health after it: {health}." if health and not warn else "")

def _stop_text(e): return str(e.code if isinstance(e, SystemExit) and e.code is not None else e)

def vercel_deploy(app_id, app, infra, adir, P, say=print, root=None, read_page=_read_page, rls_run=None, build_run=subprocess.run):
    """The two-project deploy: the api project first, then the console pointed at its address; health on both; when
    anything after the first deploy fails, both projects go back to what served before. Raises Stop with the reason."""
    man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man); K = console_facts(cb, man)
    v = infra["vercel"]; team = v.get("team", ""); scope = f" --scope {team}" if team else ""
    ipath = os.path.join(adir, "infrastructure.json")
    pre = console_preflight(K)
    if pre: raise Stop("The console project cannot be deployed from the mold's snapshot as it is; nothing was created:\n  - " + "\n  - ".join(pre))
    why = rls_tools_missing(cb, F.get("rls"))
    if why: raise Stop(f"{why}. Nothing was created or deployed.")
    # An app with packs or a brand: its own copy, made afresh now, before anything is read or created (NotBuilt).
    src = build_source(app_id, app, root, say=say, run=build_run)
    refuse_project(app_id, infra, P, root)
    # the values only the operator holds, BEFORE any project is created or renamed: a project that does not exist yet
    # holds no names, so every name it must hold is missing. Exit 3 (needs_human) through provision.py; not reverted.
    now_names = vercel_projects(vercel_project(infra))
    held = {r: (P.vercel_env_names(cb, n) if project_exists(P, n, cb) else set()) for r, n in now_names.items()}
    missing = [n for n in infra.get("secrets_user") or [] if not all(n in held[r] for r in project_for(F, K, n))]
    if missing:
        P.ask_nicely_for(app_id, missing)
        raise NeedsHuman(f"{app_id}: {', '.join(missing)} not set yet on {now_names['api']} / {now_names['web']}; nothing was created or deployed.")
    names = ensure_projects(app_id, infra, cb, K, P, adir=adir, say=say, root=root); api, web = names["api"], names["web"]
    present = {r: P.vercel_env_names(cb, n) for r, n in names.items()}
    stray = sorted((present["web"] & (api_names(F) | {"DATABASE_URL"})) - set(K["required"]) - set(K["optional"]))
    if stray:   # e.g. an app from the one-project shape, whose <base> was the API: its data would stay behind on the console
        raise Stop(f"{web} holds the API's own names ({', '.join(stray)}), so it is not a console project; nothing was deployed. "
                   "Move the app to new project names, or remove those names from it, first.")
    missing = [n for n in infra.get("secrets_user") or [] if not all(n in present[r] for r in project_for(F, K, n))]
    if missing:
        P.ask_nicely_for(app_id, missing); raise NeedsHuman(f"{app_id}: {', '.join(missing)} not set yet on {api} / {web}; nothing was deployed.")
    if ensure_database(app_id, infra, cb, api, present["api"], P, say=say): save(ipath, infra)
    want = [n for n in infra.get("secrets_derived") or [] if n not in present["api"] and n != "DATABASE_URL"]
    for n, val in mint_values(cb, F, want).items():
        P._set_env(n, val, cb, project=api); say(f"  {api}: {n} minted and written (not shown)")
    build = os.path.join(root or ROOT, "build", app_id); os.makedirs(build, exist_ok=True)
    if os.path.realpath(src) != os.path.realpath(build):    # build_source made build/<app_id>/ itself when the app has packs or a brand
        r = subprocess.run(["rsync", "-a", "--delete", *[x for e in F["excludes"] + [".next"] for x in ("--exclude", e)],
                            cb.rstrip("/") + "/", build + "/"], capture_output=True, text=True)
        if r.returncode: raise Stop(f"the build copy could not be made: {r.stderr.strip()[-200:]}")
    for role, d in (("api", build), ("web", os.path.join(build, K["dir"]))):
        link = P._link_dir(names[role], cb)       # a throwaway temp directory: removed as soon as its link file is copied
        try:
            if not link: raise Stop(f"{names[role]} could not be read back from Vercel to link the build copy to it; nothing was deployed.")
            os.makedirs(os.path.join(d, ".vercel"), exist_ok=True)
            shutil.copyfile(os.path.join(link, ".vercel", "project.json"), os.path.join(d, ".vercel", "project.json"))
        finally:
            if link: shutil.rmtree(link, ignore_errors=True)
    before = {role: P.production_of(n, cb) or {} for role, n in names.items()}
    v["release"] = {"at": now(), "before": {role: before[role].get("id") for role in ORDER}}; v.pop("console", None); save(ipath, infra)
    # where health is read after a rollback: this run's addresses once known, else the ones the last deploy recorded
    health_urls = lambda: {r: u + p for r, u, p in (("api", v.get("api_url"), man["health_path"]), ("web", v.get("production_url"), K["proxied_health"])) if u}
    try:
        api_url = ""
        for attempt in (1, 2):
            out = P.vercel_deploy(f"vercel deploy --prod --yes --project {api}{scope}", build, f"{api} deploy")
            if before["api"].get("id"): P.promote_new({"projects": {"api": before["api"]}}, cb, ["api"])   # after an earlier rollback Vercel holds production
            api_url = P._deployed_address(api, out, cb, infra)
            if P.pull_env(cb, api, required=False).get("PUBLIC_URL") == api_url: break
            P._set_env("PUBLIC_URL", api_url, cb, project=api); say(f"  {api}: PUBLIC_URL set to {api_url}" + ("; deploying once more so the API reads it" if attempt == 1 else ""))
        v["api_url"] = api_url
        res = P._read_health(api_url + man["health_path"]); v["health"] = {"api": str(res[0]) if res[0] else "no answer"}
        if not _healthy(res): raise Stop(f"{api} deployed to {api_url}, but {man['health_path']} answered {_said(res)}")
        say(f"  {api}: {api_url}{man['health_path']} answered 200 ok")
        rls = None
        if F.get("rls"):
            rls = rls_vercel(P, cb, api, F["rls"], res[1], rls_run)
            if not rls[0]:
                record_rls(adir, F["rls"], False, rls[1], "by provision.py --deploy (both projects rolled back)", rls[2], rls[3])
                raise Stop(f"{api}: the product's row-level security check failed on its database: {rls[1] or 'no output'}")
            say(f"  {api}: {rls[1]}")
        if P.pull_env(cb, web, required=False).get(K["api_env"]) != api_url:
            P._set_env(K["api_env"], api_url, cb, project=web); say(f"  {web}: {K['api_env']} set to the API's address {api_url}")
        out = P.vercel_deploy(f"vercel deploy --prod --yes --project {web}{scope}", os.path.join(build, K["dir"]), f"{web} deploy")
        if before["web"].get("id"): P.promote_new({"projects": {"web": before["web"]}}, cb, ["web"])
        url = P._deployed_address(web, out, cb, infra); v["production_url"] = url
        bad, h = console_verdict(P, url, K, read_page); v["health"].update(h)
        if bad: raise Stop(f"{web} deployed to {url}, but " + "; ".join(bad))
    except (Stop, SystemExit) as e:
        why = _stop_text(e); rec = _rollback_recorded(before, cb, P, why, health_urls, v, ipath, infra)
        raise Stop(why.rstrip(".") + f". {_rollback_said(rec, names)} Recorded as reverted.")
    except BaseException as e:   # anything unexpected (a bug, a broken pipe, Ctrl-C) half-way: both back, reverted, then re-raised
        first = (str(e).strip().splitlines() or [""])[0]           # the first line only, redacted: it lands in state
        why = f"the deploy stopped on an unexpected error ({type(e).__name__}" + (f": {VR.redact(first)[:160]}" if first else "") + ")"
        rec = {"result": "rollback interrupted", "projects": {}}
        try: rec = _rollback_recorded(before, cb, P, why, health_urls, v, ipath, infra)
        finally: revert(adir, app, why + f". {_rollback_said(rec, names)}")
        raise
    infra["deployed_at"] = now(); app["status"] = "stamped" if app.get("status") in (None, "planned", "reverted") else app["status"]; app.pop("revert", None)
    app["mold_commit"] = mold_commit(app["mold_id"], root) or app.get("mold_commit", "")
    save(ipath, infra); save(os.path.join(adir, "application.json"), app)
    if rls: record_rls(adir, F["rls"], True, rls[1], "by provision.py --deploy", rls[2], rls[3])
    say(f"{app_id}: deployed. The console {url} ({web}; {K['proxied_health']} reaches the API, {', '.join(f'{p} {c}' for p, c in h['pages'].items())}); "
        f"the API {api_url} ({api}; {man['health_path']} 200 ok)"); return 0

def vercel_check(app_id, app, infra, P, say=print, root=None):
    """Read-only. Exit 0 = ready for --deploy (nothing on Vercel is the operator's to type unless the console's sign-in
    names are required; optional keys stay off)."""
    import agent_result as AR
    man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man); K = console_facts(cb, man)
    names = vercel_projects(vercel_project(infra))
    meta = {r: P._project_meta(n, cb) for r, n in names.items()}
    present = {r: (P.vercel_env_names(cb, n) if meta[r].get("id") else set()) for r, n in names.items()}
    for r in ORDER:
        say(f"  Vercel project {names[r]} ({'the API and MCP function' if r == 'api' else 'the console, ' + K['dir'] + '/'}): "
            f"{'exists' if meta[r].get('id') else 'not created yet (a deploy creates it)'}")
    say(f"  database ({names['api']} only): {'DATABASE_URL is on the project (kept as it is: written once)' if 'DATABASE_URL' in present['api'] else 'the app gets its own Postgres at the first deploy (an empty free Neon database, proven empty before it is connected)'}")
    say(f"  minted at the deploy if absent ({names['api']} only): {', '.join(n for n in infra.get('secrets_derived') or [] if n not in present['api'] and n != 'DATABASE_URL') or 'nothing (all present)'}")
    say(f"  console: pointed at the API through {K['api_env'] or '(no single API-address variable found)'} ({K['config'] or 'no next.config'}); never DATABASE_URL or a minted key")
    for n in K["required"] + K["optional"]:
        say(f"  console sign-in name {n} ({'required' if n in K['required'] else 'optional'}): {'set' if n in present['web'] else 'not set'} on {names['web']}")
    if infra.get("secrets_optional"): say(f"  optional, off while empty (set one with --set-secret NAME): {', '.join(infra['secrets_optional'])}")
    say("a deploy will:")
    for i, l in enumerate(vercel_plan(app_id, F, infra, man, K), 1): say(f"  {i}. {l}")
    pre = console_preflight(K)
    for p in pre: say("  not ready: " + p)
    missing = [n for n in infra.get("secrets_user") or [] if not all(n in present[r] for r in project_for(F, K, n))]
    if missing:
        for n in missing:
            say(f"  python3 .claude/scripts/provision.py {app_id} --set-secret {n}"); AR.need("secret", n, AR.secret_how(app_id, n))
        say(f"{len(missing)} value(s) only you hold are not set yet ({', '.join(missing)}): run each line above in a separate terminal on this machine."); return 1
    if pre: say("  - the mold's codebase cannot run as two projects as it is (see 'not ready' above). " + _codebase_fix(app["mold_id"], "see above")); return 1
    why = rls_tools_missing(cb, F.get("rls"))
    if why: say(f"  - {why}"); return 1
    pg = os.path.isfile(os.path.join(cb, "node_modules", "pg", "package.json"))
    if "DATABASE_URL" not in present["api"] and not pg:
        say(f"  - install the mold's dependencies first (the database emptiness check uses its own `pg` client): npm --prefix {os.path.relpath(cb, root or ROOT)} ci"); return 1
    say(f"Ready. See the plan: python3 .claude/scripts/provision.py {app_id} --deploy --dry-run")
    return 0

def set_secret_vercel(app_id, app, infra, name, P, root=None, value=None, adir=None, say=print):
    """One value, at a hidden prompt, onto the project(s) that read NAME: the API when it reads it, the console when it
    is one of its sign-in names, both when both do. Never DATABASE_URL, and nothing the console does not read."""
    cb = codebase(app["mold_id"], root); man = manifest(app["mold_id"], root); F = compose_facts(cb, man); K = console_facts(cb, man)
    declared = set(infra.get("secrets_user") or []) | set(infra.get("secrets_optional") or []) | set(infra.get("secrets_derived") or []) | set(K["required"]) | set(K["optional"])
    roles = project_for(F, K, name)
    if name not in declared or not roles: raise Stop(f"{name} is not a name this app reads (it reads: {', '.join(sorted(declared))}). Nothing was stored.")
    if name == "DATABASE_URL": raise Stop(f"{app_id}: DATABASE_URL is written by the database integration at the first deploy and never by hand. Nothing was stored.")
    refuse_project(app_id, infra, P, root)
    names = choose_names(app_id, infra, cb, P, adir=None, say=say, root=root); team = (infra.get("vercel") or {}).get("team", "")
    v = value if value is not None else _hidden_value(app_id, name, P)
    if adir: save(os.path.join(adir, "infrastructure.json"), infra)   # the name choice is recorded once a value is in hand, before any project is made
    for r in roles:
        if ensure_project(names[r], team, cb, P): print(f"  (created {names[r]} empty to hold {name}: free, no deployment)")
        P._set_env(name, v, cb, project=names[r])
    print(f"{name} set on {' and '.join(names[r] for r in roles)} (the value was never shown or stored here). It applies at the next deploy."); return 0

# ---------------------------------------------------------------------------------------------------------
# provision.py hands over here
# ---------------------------------------------------------------------------------------------------------
def verify_rls(app_id, app, infra, adir, P, say=print, root=None, runner=None, rls_run=None):
    """`--verify-rls`: the product's row-level security check against the deployed database again, recorded (read-only:
    the probe's rows are rolled back). Exit 0 passed, 1 not."""
    man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man); spec = F.get("rls")
    if not spec:
        say(f"{app_id}: {app['mold_id']} declares no row-level security check (mold.json \"rls\" with a script its package.json has), "
            f"so there is nothing to verify; its rows are scoped in its queries (the lanes' tenant-SQL check)."); return 0
    t = infra.get("target")
    if t == "compose_remote":
        S = settings(app_id, app, infra, root)
        if not (infra.get("compose_remote") or {}).get("production_url"): raise Stop(f"{app_id} is not deployed yet; deploy it first.")
        _ready_to_contact(S, app_id)
        r = (runner or VR.real_runner)({"id": "rls", "argv": VR.ssh_argv(S, rls_cmd(S, F)), "timeout": 300}, None)
        out = (r.stdout or "") + "\n" + (r.stderr or ""); passed, said = rls_passed(r.returncode, out, spec), rls_said(out, spec)
        how, running, detail = ("by provision.py --verify-rls in a one-off container of the serving release", "enforced",
                                "ran in a one-off container of the serving release's image, with the env file its containers read.")
    else:
        v = infra.get("vercel") or {}
        if not v.get("api_url"): raise Stop(f"{app_id} is not deployed yet; deploy it first.")
        why = rls_tools_missing(cb, spec)
        if why: raise Stop(why)
        res = P._read_health(v["api_url"] + man["health_path"])
        passed, said, running, detail = rls_vercel(P, cb, vercel_projects(vercel_project(infra))["api"], spec, res[1], rls_run)
        how = "by provision.py --verify-rls"
    record_rls(adir, spec, passed, said, how, running, detail)
    say(f"{app_id}: row-level security {'proven' if passed else 'NOT proven'} on the deployed database: {said or 'no output'} "
        f"(recorded in state/application/{app_id}/datastores.json postgres.rls_verified)")
    return 0 if passed else 1

def main_for(app_id, a, app, infra, ds, adir, P, say=print, root=None):
    """Everything provision.py does for a single-service application. Returns the exit code."""
    t = infra.get("target"); dry = "--dry-run" in a
    try:
        errs = VR.state_problems(app_id, adir) if root is None else []
        if "--lane-key" in a:
            if t == "vercel": refuse_project(app_id, infra, P, root)
            return lane_key(app_id, app, infra, a, P, say=say, root=root, adir=adir)
        if t == "vercel":
            cb = codebase(app["mold_id"], root)
            for f in ("--deploy-remote", "--set-remote", "--remote-key", "--qualify-remote", "--rollback-remote"):
                if f in a: raise Stop(f"{app_id}: {f} is for an app on a server of its own; this one is on Vercel. Use --deploy.")
            refuse_project(app_id, infra, P, root)   # a LIVE project or another app's (either of the two): refused before any read or write
            if "--set-secret" in a: return set_secret_vercel(app_id, app, infra, a[a.index("--set-secret") + 1], P, root=root, adir=adir, say=say)
            if "--deploy" in a:
                if errs: raise Stop("the state does not validate; nothing was done:\n  " + "\n  ".join(errs))
                man = manifest(app["mold_id"], root); F = compose_facts(cb, man)
                if dry:
                    say(f"{app_id}: --deploy --dry-run: a deploy would do, in this order (nothing is created by this dry run):")
                    K = console_facts(cb, man)
                    for i, l in enumerate(vercel_plan(app_id, F, infra, man, K, app=app), 1): say(f"  {i}. {l}")
                    for p in console_preflight(K): say("  NOT READY (a real deploy refuses here, before anything is created): " + p)
                    return 0
                try: return vercel_deploy(app_id, app, infra, adir, P, say=say, root=root)
                except (NeedsHuman, NotBuilt): raise          # nothing was tried, so nothing is reverted
                except Stop as e: revert(adir, app, str(e)); raise
            if "--verify-rls" in a: return verify_rls(app_id, app, infra, adir, P, say=say, root=root)
            for f in ("--rollback", "--smoke", "--verify-db"):
                if f in a: raise Stop(f"{app_id}: {f} belongs to mold_v1's three-project deploy; this app's --deploy checks both of its projects and rolls both back itself, and its lanes do the rest.")
            return vercel_check(app_id, app, infra, P, say=say, root=root)
        # compose_remote
        if "--set-remote" in a:
            i = a.index("--set-remote"); set_remote(app_id, adir, [x for x in a[i + 1:] if "=" in x and not x.startswith("-")], say=say); return 0
        S = settings(app_id, app, infra, root); man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man)
        if "--remote-key" in a: VR.remote_key(S, say=say); return 0
        if "--verify-rls" in a: return verify_rls(app_id, app, infra, adir, P, say=say, root=root)
        for flag, instead in (("--deploy", "--deploy-remote"), ("--rollback", "--rollback-remote"), ("--verify-db", "--deploy-remote"),
                              ("--smoke", "--deploy-remote (its health step)"),
                              ("--workspace-remote", "the app's own admin console or --lane-key")):
            if flag in a and not (flag == "--deploy" and "--deploy-remote" in a) and not (flag == "--rollback" and "--rollback-remote" in a):
                say(f"{app_id}: {flag} is not for this app (its own compose stack). Use: python3 .claude/scripts/provision.py {app_id} {instead}"); return 1
        if "--set-secret" in a: return set_secret_remote(app_id, S, a[a.index("--set-secret") + 1], P, say=say)
        if "--rollback-remote" in a: return rollback_remote(app_id, S, F, dry=dry, say=say)
        if "--qualify-remote" in a:
            _ready_to_contact(dict(S, domain=S["domain"] or "-"), app_id)
            r = VR.real_runner({"id": "qualify", "argv": VR.ssh_argv(S, "sh -s"), "timeout": 60}, VR.QUALIFY_SH + COMPOSE_PROBE)
            if r.returncode: raise Stop("could not log in to the server: " + VR.redact((r.stderr or "no answer").strip())[-200:])
            bad = qualify(_kv(r.stdout), S)
            if bad: raise Stop("This server cannot run the stack:\n  - " + "\n  - ".join(bad))
            say(f"{app_id}: the server is fit for its compose stack. Nothing was installed or changed."); return 0
        if "--deploy-remote" not in a: return check(app_id, app, infra, adir, say=say, root=root)
        if errs: raise Stop("the state does not validate; nothing was contacted:\n  " + "\n  ".join(errs))
        if dry:
            print_plan(S, F, plan(S, F, source_for(app_id, app, root)), say=say)
            if uses_build(app): say(f"  (before step 1: build/{app_id}/ made afresh from the codebase with this app's own brand and packs; nothing is contacted until it is)")
            for p in preflight(cb, F, S): say("  NOT READY (a real deploy refuses here, before contact): " + p)
            if "--out" in a: out = a[a.index("--out") + 1]; write_bundle(S, F, out); say(f"bundle written to {out} for reading; nothing was sent anywhere")
            return 0
        _ready_to_contact(S, app_id)
        src = build_source(app_id, app, root, say=say)     # the codebase, or build/<app_id>/ afresh (packs, brand); NotBuilt: not reverted
        try: res = deploy(S, F, src, say=say)
        except Stop as e:
            r_ = getattr(e, "rls", None)
            if r_ and not r_["passed"]:   # the deployed database was measured failing: never leave an older pass standing
                record_rls(adir, F["rls"], False, r_["said"], "by provision.py --deploy-remote (the release was rolled back)", "not_enforced",
                           "ran in a one-off container of the new release's image, with the server's env file.")
            revert(adir, app, str(e)); raise
        record(adir, app, infra, S, res, mold_commit(app["mold_id"], root))
        if res.get("rls"):
            record_rls(adir, F["rls"], True, res["rls"]["said"], f"by provision.py --deploy-remote in a one-off container of release {res['release']}",
                       "enforced", "ran in a one-off container of the serving release's image, with the env file its containers read (the same database and login).")
        say(f"{app_id}: deployed release {res['release']} to {S['url']}; health {S['health_path']} answered 200 ok. Next: python3 .claude/scripts/lanes.py {app_id}")
        return 0
    except Stop as e:
        say(str(e)); return 1

# ---------------------------------------------------------------------------------------------------------
# mint.py's stations for a single-service app (None: the station's own reading applies)
# ---------------------------------------------------------------------------------------------------------
DONE, TODO, OPERATOR, FAILED, NA = "done", "next", "needs you", "failed", "not needed"
LANES = ("functional", "context", "load", "accessibility", "responsiveness")
def mcp_address(infra):
    """Where the MCP connector lives: on Vercel the api project's address (the console's is for people), else the app's."""
    return ((infra.get("vercel") or {}).get("api_url") or "").rstrip("/") if infra.get("target") == "vercel" else address(infra)

def address(infra):
    t = infra.get("target")
    if t == "compose_remote":
        cr = infra.get("compose_remote") or {}; u = (cr.get("production_url") or "").rstrip("/")
        return u if u and cr.get("domain") and u == f"https://{cr['domain']}" and infra.get("deployed_at") else ""
    return ((infra.get("vercel") or {}).get("production_url") or "").rstrip("/")

def station(name, app_id, a, i, root=None):
    if name in ("brief", "state") or not isinstance(a, dict) or not isinstance(i, dict): return None
    man = manifest(a.get("mold_id"), root)
    if not man: return None
    nn = man.get("not_needed") or {}
    if name in nn: return (NA, nn[name])
    t = i.get("target"); url = address(i)
    flag = "--deploy-remote" if t == "compose_remote" else "--deploy"
    if name == "deploy":
        if (not url or not i.get("deployed_at")) and a.get("status") == "reverted" and (a.get("revert") or {}).get("reason"):
            return (FAILED, f"the first deploy stopped: {' '.join(str(a['revert']['reason']).split())[:300]} (python3 .claude/scripts/provision.py {app_id} {flag} once the cause is fixed)")
        if not url or not i.get("deployed_at"): return (TODO, "first deploy" + (" to its own server" if t == "compose_remote" else " (two Vercel projects: the API, then the console)"))
        if a.get("status") == "reverted": return (TODO, "a lane failed or a deploy stopped; redeploy once the cause is fixed")
        now_c = mold_commit(a["mold_id"], root); was = a.get("mold_commit")
        if was and now_c and was != now_c: return (TODO, f"the mold moved ({was[:7]} -> {now_c[:7]}); redeploy to pick it up")
        return (DONE, f"{url} (deployed {i['deployed_at'][:16]})")
    if name == "tests":
        tt = a.get("testing") or {}; dep = i.get("deployed_at") or ""
        if any((tt.get(l) or {}).get("status") == "fail" for l in tt): return (FAILED, "a lane failed; its report is named in application.json testing")
        ran = [(tt.get(l) or {}).get("run_at") or "" for l in LANES]
        if not all(ran) or min(ran) < dep: return (TODO, "run the five lanes against this deploy")
        if url and not lane_key_ok(app_id, mcp_address(i)):
            return (OPERATOR, f"nothing failed, but the MCP check was skipped: it needs an organisation of the app's own. Say yes to it, then: "
                              f"python3 .claude/scripts/provision.py {app_id} --lane-key --yes (see it first with --dry-run); then the lanes run again")
        skipped = [l for l in LANES if (tt.get(l) or {}).get("status") == "skipped"]
        return (DONE, "five lanes ran, none failed" + (f"; skipped, each with its reason in its report: {', '.join(skipped)}" if skipped else ""))
    if name == "address":
        if t == "compose_remote":
            cr = i.get("compose_remote") or {}
            return (DONE, url) if url else (NA, f"its own domain, {cr.get('domain') or 'not named yet'}, once deployed")
        return None
    return None

# ---------------------------------------------------------------------------------------------------------
# on the server (run from the bundle, as root)
# ---------------------------------------------------------------------------------------------------------
def server_env(env_file, bootstrap, stdin_text, run=subprocess.run, say=print):
    """Merge NAME=value lines from stdin into the env file, then mint every name still missing with the mold's own
    bootstrap script, run in a private temp directory that is given the NAMES already present (never a value)."""
    pairs = VR.stdin_pairs(stdin_text or "")
    added, changed, refused = VR.env_merge(env_file, pairs) if pairs else ([], [], [])
    for why in refused: say("env: " + why)
    if refused: return 1
    minted = []
    if bootstrap:
        have = set(VR.env_names(env_file)); t = tempfile.mkdtemp(prefix="sf-mint-")
        try:
            os.chmod(t, 0o700); shutil.copyfile(bootstrap, os.path.join(t, "bootstrap.sh"))
            fd = os.open(os.path.join(t, ".env"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, "".join(f"{n}=present\n" for n in sorted(have)).encode()); os.close(fd)
            r = run(["bash", os.path.join(t, "bootstrap.sh")], cwd=t, capture_output=True, text=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": t})
            if r.returncode: say(f"env: the mold's own bootstrap script stopped (exit {r.returncode}); nothing was minted"); return 1
            new = {k: v for k, v in VR.env_read(os.path.join(t, ".env")).items() if k not in have}
            minted, _, bad = VR.env_merge(env_file, new)
            for why in bad: say("env: " + why)
            if bad: return 1
        finally: shutil.rmtree(t, ignore_errors=True)
    say(f"env: {len(added)} added, {len(changed)} changed" + (f" ({', '.join(added + changed)})" if added or changed else "") +
        f"; minted on this server: {', '.join(minted) or 'nothing (every name was present and kept)'} (values not shown)")
    return 0

def cli(a):
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    if a[0] == "env": return server_env(opt("--file"), opt("--bootstrap"), sys.stdin.read())
    if a[0] == "lane-key-path":
        # For a lane's precondition: the private connector file for this app's address, or exit 1 with the reason.
        app_id = a[1] if len(a) > 1 else ""
        try: infra = load(os.path.join(ROOT, "state", "application", app_id, "infrastructure.json"))
        except (OSError, ValueError): print(f"{app_id}: no state", file=sys.stderr); return 1
        url = mcp_address(infra)
        if not url: print(f"{app_id} is not deployed yet: python3 .claude/scripts/provision.py {app_id} " + ("--deploy" if infra.get("target") == "vercel" else "--deploy-remote"), file=sys.stderr); return 1
        if not lane_key_ok(app_id, url):
            print(f"{app_id} has no lane-check organisation for {url} yet; with the operator's yes: python3 .claude/scripts/provision.py {app_id} --lane-key --yes", file=sys.stderr); return 1
        print(lane_key_path(app_id)); return 0
    if a[0] == "--self-test":
        # The tests live beside this file (single_service_selftest.py), which no server bundle carries.
        return subprocess.run([sys.executable, os.path.join(HERE, "single_service_selftest.py")]).returncode
    print(__doc__); return 2

if __name__ == "__main__": sys.exit(cli(sys.argv[1:]))
