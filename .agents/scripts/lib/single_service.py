#!/usr/bin/env python3
"""single_service: run a mold that ships as ONE service with its own Docker Compose stack (mold_v0-028).

A mold opts in with molds/<mold_id>/mold.json ("shape": "single_service"); today that is mold_v0, the operator's MCP
product pinned as it is. Everything else in the factory keeps its mold_v1 paths: each caller asks `manifest(mold_id)`
first and hands over here only when it answers. The mold's codebase is a verbatim snapshot and is never edited: what
the factory needs from it (the compose project's default name, the service that is built, the env names it requires
or accepts, the port, the health check) is READ from its own files at plan time (compose_facts).

Two deploy targets (infrastructure.target):

  compose_remote  a server of the app's own, over SSH. It reuses lib/vm_remote.py's host probe, SSH and rsync
                  handling, the DNS precondition, the key pair, the hidden prompt for values only the operator holds,
                  the env file (names in, names out; root, mode 600) and the firewall rules, and deploys the mold's own
                  compose stack under a project name of the app's own (sf-<app-id>), never the compose file's default.
  vercel          one Vercel project, when the mold's vercel.json describes one function (mold_v0's does).

Through provision.py (main_for):

  provision.py <app_id>                                  check: offline, read-only, connects to nothing
  provision.py <app_id> --set-remote host=<address> domain=<name> [ssh_user= ssh_port= ssh_key_ref= provider=]
  provision.py <app_id> --remote-key                     the SSH key pair named by ssh_key_ref; prints the PUBLIC half
  provision.py <app_id> --qualify-remote                 the read-only host probe, judged for a compose stack
  provision.py <app_id> --deploy-remote [--dry-run]      the deploy (compose_remote); --dry-run prints every step
  provision.py <app_id> --deploy [--dry-run]             the deploy (vercel, one project)
  provision.py <app_id> --rollback-remote [--dry-run]    the server back to the release that served before
  provision.py <app_id> --set-secret NAME                one value at a hidden prompt, into the server's env file (or
                                                         the Vercel project); it applies at the next deploy
  provision.py <app_id> --lane-key [--dry-run] [--yes]   an organisation of the app's own for the lanes' MCP check (the
                                                         product's own org:create), its connector address kept in a
                                                         private file outside the repository. It writes to the app's
                                                         data, so it runs only with --yes (exit 3 asks for the yes)

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
   packages   Docker and its compose plugin (if absent), ufw, fail2ban, rsync, python3, openssl
   firewall   ufw: SSH, 80 and 443 only (vm_remote's rules); fail2ban for ssh. Docker publishes only what the compose
              file names, and the health step fails if anything else publishes a port
   names      which env names the server already holds (names only)
   values     values only the operator holds (secrets_user), at a hidden prompt, for names the server lacks
   source     the snapshot's SOURCE into a new release directory, <install>/releases/<id>, beside the serving one
   env        state's settings (DOMAIN, PUBLIC_URL) and the operator's values merged into the env file; then every
              name still missing is minted ON THE SERVER by the mold's own bootstrap script, run in a private temp
              directory that sees the NAMES already present and never their values. Nothing is printed but names
   up         `current` -> the new release; docker compose -p sf-<app> ... up -d --build --wait. On failure: back
   health     on the server: the app container healthy, running as a user other than root, and only the services
              the compose file publishes holding a port; from here: https://<domain><health_path> answers 200 ok
   keep       every release but the serving and the previous one removed

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
            "excludes": list(c.get("source_excludes") or [])}

def missing_build_inputs(cb, F):
    """Files the image build copies that the snapshot does not have: the build would stop on the server."""
    return [s for s in F["dockerfile_sources"] if not any(True for _ in _glob(cb, s))]

def _glob(cb, pattern):
    import glob
    p = os.path.join(cb, pattern)
    return glob.glob(p) if any(ch in pattern for ch in "*?[") else ([p] if os.path.exists(p) else [])

def preflight(cb, F, S):
    """Plain sentences for what stops a deploy before any server is contacted; [] when none."""
    bad = []
    gone = missing_build_inputs(cb, F)
    if gone:
        bad.append(f"the image build copies {', '.join(gone)}, which the mold's snapshot does not contain (its own .gitignore keeps it out of "
                   f"the repository), so `docker compose build` would stop on the server. That is a change to the mold's source, by pull "
                   f"request there (commit the file), then `python3 .claude/scripts/mold.py refresh {S['mold_id']}`; the factory never "
                   f"edits a snapshot")
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

def secret_names(F, target):
    """(user, derived, optional) names for a target. compose_remote: the compose file's required names are written
    from state or minted on the server; vercel: the database address is the operator's, the names the app reads whole
    are minted by the same bootstrap script, plus CRON_SECRET for Vercel's own cron calls."""
    if target == "compose_remote":
        return [], [n for n in F["required"] if n not in F["config"]], list(F["optional_secrets"])
    derived = [n for n in F["app_reads_required"] if n not in F["config"]] + ["CRON_SECRET"]
    return ["DATABASE_URL"], derived, [n for n in F["optional_secrets"] if n not in derived]

def shape_state(app_id, mold_id, target, prod, mold, ans, hints, brief_rel, defaults=None, root=None):
    """The four state documents of a single-service app, from intake's answers. The same four schemas as every app; the
    fields only this shape needs are infrastructure.compose_remote, postgres.exposure "compose_network" and blob "none"."""
    man = manifest(mold_id, root); F = compose_facts(codebase(mold_id, root), man); d = defaults or {}
    user, derived, optional = secret_names(F, target)
    app = {"$schema": "../app_id/application.schema.json", "app_id": app_id, "mold_id": mold_id,
           "mold_commit": (mold.get("source") or {}).get("commit", ""), "status": "planned", "brief": brief_rel,
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
        infra["vercel"] = {"team": d.get("vercel_team", "your-vercel-team"), "project": ans.get("vercel_project") or slug(app_id)}
        if dom: infra["vercel"]["custom_domain"] = dom
        pg = {"provider": "neon", "exposure": "managed_provider"}
    # rls "off": the product scopes tenant rows in its queries (its tenant-SQL check guards that), not with row-level
    # security; proving RLS on every deploy is ticket mold_v0-031. "off" is measured and recorded, never claimed.
    ds = {"$schema": "../app_id/datastores.schema.json",
          "postgres": dict(pg, scope="fresh", rls="off", tenancy="multi_org", url_ref="DATABASE_URL"),
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

def packages_sh(S):
    return _head(S) + VR.fill("""export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-upgrade ca-certificates curl rsync ufw fail2ban python3 openssl iproute2
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -q --no-upgrade docker.io docker-compose-v2
fi
systemctl enable --now docker >/dev/null
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
    """`current` -> the release named by $1, then the stack up and healthy; on failure, back to the one before."""
    return _head(S) + _dc(S) + VR.fill("""REL="${1:?usage: up.sh <release-id>}"
case "$REL" in *[!0-9TZ]*|"") echo "up: not a release id: $REL" >&2; exit 2;; esac
cd @INSTALL@
[ -d "releases/$REL" ] || { echo "up: releases/$REL does not exist" >&2; exit 2; }
prev=""; [ -L current ] && prev="$(basename "$(readlink current)")"
point() { ln -sfn "releases/$1" current.new && mv -T current.new current; }
point "$REL"
if [ -n "$prev" ] && [ "$prev" != "$REL" ]; then echo "$prev" > previous; fi
if dc up -d --build --wait --wait-timeout @WAIT@; then echo "UP=ok"; echo "SERVING=$REL"; exit 0; fi
echo "UP=failed"
if [ -n "$prev" ] && [ "$prev" != "$REL" ] && [ -d "releases/$prev" ]; then
  point "$prev"
  if dc up -d --build --wait --wait-timeout @WAIT@; then echo "ROLLED_BACK=$prev"; else echo "ROLLBACK_FAILED=$prev"; fi
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
        {"id": "source", "title": f"the mold's source (not a build) into {R}", "argv": VR.rsync_argv(S, source_dir, R, excludes=excludes, shown=shown), "timeout": 900},
        {"id": "env", "title": f"settings from state ({', '.join(F['config'])}) and the operator's values into {S['env_file']} (root, 600); every name still "
                               f"missing minted ON the server by the mold's own {F['mint'] or 'tool'}, which sees names, never values", "argv": ssh(env_cmd), "stdin": "NAME=value lines", "timeout": 120},
        {"id": "up", "title": f"current -> {rel}; docker compose -p {S['project']} up -d --build --wait (on failure: back to the release that served)",
         "argv": ssh(g(f"bash {S['factory_dir']}/up.sh {rel}")), "timeout": UP_WAIT_S * 2 + 1800},
        {"id": "health", "title": f"on the server: {F['service']} {'healthy' if F['healthcheck'] else 'running'}, not root, only {', '.join(F['publishers']) or 'nothing'} publishing ports",
         "argv": ssh(g(f"bash {S['factory_dir']}/health.sh")), "timeout": 120},
        {"id": "public", "title": f"from here: {S['url']}{S['health_path']} answers 200 with ok", "argv": None, "timeout": PUBLIC_WAIT_S},
        {"id": "keep", "title": "every release but the serving and the previous one removed", "argv": ssh(g(f"bash {S['factory_dir']}/keep.sh")), "timeout": 300},
    ]

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
def source_for(app_id, app, root=None): return codebase(app["mold_id"], root)

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
    if gone: todo.append(f"the mold's snapshot lacks {', '.join(gone)}, which its image build copies: commit it in the mold's source, then "
                         f"python3 .claude/scripts/mold.py refresh {app['mold_id']} (nothing for this app's state to change)")
    elif pre: todo.append("the mold's snapshot cannot be deployed as it is (see 'not ready' above): a change to the mold's source, then mold.py refresh")
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
        bad = health_verdict(F, kv, public)
        if bad:
            raise Stop(f"release {release} is up but does not serve as it should: " + "; ".join(bad) +
                       f". Go back to the release before it: python3 .claude/scripts/provision.py {S['app_id']} --rollback-remote")
        say(f"[public] {url} answered 200 ok")
        run("keep", check=False)
        return {"release": release, "facts": facts,
                "health": {"app": kv.get("APP_STATE", ""), "uid": kv.get("APP_UID", ""), "published": kv.get("PUBLISHED", ""),
                           "public": str(public[0]), "disk_percent": kv.get("DISK_PERCENT", ""), "at": now()}}
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
        P.explain(name); v = getpass.getpass(f"{name} (input hidden): ").strip()
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
          "argv": VR.ssh_argv(S, VR.guarded(S, f"bash -c {shlex.quote('bash ' + S['factory_dir'] + '/up.sh \"$(cat ' + S['install'] + '/previous)\"')}"), shown=dry), "timeout": UP_WAIT_S * 2 + 600}
    if dry:
        say(f"{app_id}: --rollback-remote would run, and nothing was contacted:\n  $ {VR.shown_cmd(S, st['argv'])}"); return 0
    _ready_to_contact(S, app_id)
    r = (runner or VR.real_runner)(st, None); kv = _kv(r.stdout)
    if r.returncode == 0: say(f"{app_id}: the server serves release {kv.get('SERVING')} again (the one before the last deploy)."); return 0
    say(f"{app_id}: the rollback did not finish (exit {r.returncode}): " + VR.redact((r.stderr or "").strip())[-300:]); return 1

# ---------------------------------------------------------------------------------------------------------
# the lanes' MCP check: an organisation of the app's own, its connector address kept privately
# ---------------------------------------------------------------------------------------------------------
def private_dir():
    import services
    return services.private_dir()
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
    url = (infra.get("compose_remote") or {}).get("production_url") if t == "compose_remote" else (infra.get("vercel") or {}).get("production_url")
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
        vals = P.pull_env(codebase(app["mold_id"], root), infra["vercel"]["project"], required=False)
        if not vals.get("DATABASE_URL") or vals["DATABASE_URL"] == "[SENSITIVE]": raise Stop(f"{app_id}: DATABASE_URL could not be read back from the project; nothing was made.")
        env = dict(os.environ, DATABASE_URL=vals["DATABASE_URL"], PUBLIC_URL=url); AR.forbid(vals["DATABASE_URL"])
        cmd = ["npx", "tsx", lk["script"]]
        r = subprocess.run(cmd + lk["create"], cwd=codebase(app["mold_id"], root), env=env, capture_output=True, text=True, timeout=180)
        if r.returncode: r = subprocess.run(cmd + lk["again"], cwd=codebase(app["mold_id"], root), env=env, capture_output=True, text=True, timeout=180)
        out = r.stdout or ""
    m = re.search(lk["url_pattern"], out)
    if r.returncode or not m:
        raise Stop(f"{app_id}: the organisation's connector address was not made (exit {r.returncode}): " + VR.redact(re.sub(lk["url_pattern"], "<address>", (r.stderr or out)))[-300:])
    AR.forbid(m.group(0))
    os.makedirs(private_dir(), mode=0o700, exist_ok=True)
    fd = os.open(lane_key_path(app_id), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, (m.group(0) + "\n").encode()); os.close(fd)
    if t == "compose_remote" and adir:      # names only: which organisation, and when (the address stays in the private file)
        infra["compose_remote"]["lane_key"] = {"slug": lk["create"][1], "at": now()}; save(os.path.join(adir, "infrastructure.json"), infra)
    say(f"{app_id}: the lane-check organisation's connector address is kept in {lane_key_path(app_id)} (mode 600, never shown). The MCP check can run: "
        f"python3 .claude/scripts/lanes.py {app_id} --lane functional")
    return 0

# ---------------------------------------------------------------------------------------------------------
# vercel: one project
# ---------------------------------------------------------------------------------------------------------
def vercel_project(infra): return (infra.get("vercel") or {}).get("project", "")

def vercel_plan(app_id, F, infra, man):
    v = infra.get("vercel") or {}; proj = vercel_project(infra); team = v.get("team", "")
    return [f"the Vercel project {proj} (one project; created if absent, never connected to git)",
            f"the operator's values checked by name: {', '.join(infra.get('secrets_user') or []) or 'none'}",
            f"minted if absent, by the mold's own {F['mint']} run in a private temp directory here (values never shown): {', '.join(infra.get('secrets_derived') or [])}",
            f"a build copy build/{app_id}/ of the snapshot (no node_modules), linked to {proj}",
            f"vercel deploy --prod --yes{(' --scope ' + team) if team else ''} from that copy ({man['vercel']['config']}: one function, its crons)",
            "the production address read back from Vercel (never derived from the name); PUBLIC_URL set to it, and one more deploy when it changed",
            f"health: <address>{man['health_path']} answers 200 with ok",
            "state: vercel.production_url, vercel.health.web, deployed_at, status stamped (or reverted, with the reason)"]

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

def vercel_check(app_id, app, infra, P, say=print, root=None):
    import agent_result as AR
    man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man); proj = vercel_project(infra)
    meta = P._project_meta(proj, cb); present = P.vercel_env_names(cb, proj) if meta.get("id") else set()
    say(f"  Vercel project {proj}: {'exists' if meta.get('id') else 'not created yet (a deploy creates it)'}; one project ({man['vercel']['config']})")
    missing = [n for n in infra.get("secrets_user") or [] if n not in present]
    say(f"  minted at the deploy if absent: {', '.join(n for n in infra.get('secrets_derived') or [] if n not in present) or 'nothing (all present)'}")
    say("a deploy will create:")
    for i, l in enumerate(vercel_plan(app_id, F, infra, man), 1): say(f"  {i}. {l}")
    if missing:
        for n in missing:
            say(f"  python3 .claude/scripts/provision.py {app_id} --set-secret {n}"); AR.need("secret", n, AR.secret_how(app_id, n))
        say(f"{len(missing)} value(s) only you hold are not on the project yet ({', '.join(missing)}): run each line above in a separate terminal on this machine."); return 1
    say(f"secrets present: {len(infra.get('secrets_user') or [])}/{len(infra.get('secrets_user') or [])}. Ready. See the plan: python3 .claude/scripts/provision.py {app_id} --deploy --dry-run")
    return 0

def vercel_deploy(app_id, app, infra, adir, P, say=print, root=None):
    man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man)
    v = infra["vercel"]; proj = v["project"]; team = v.get("team", ""); scope = f"--scope {team}" if team else ""
    if not P._project_meta(proj, cb).get("id"):
        r = P.vrun(f"vercel project add {proj} {scope}", shell=True, cwd=cb, capture_output=True, text=True)
        if not P._project_meta(proj, cb).get("id"): raise Stop(f"could not create the Vercel project {proj}: " + (r.stdout + r.stderr).strip()[-200:])
        P.disconnect_git(proj, cb); say(f"  created the Vercel project {proj}")
    present = P.vercel_env_names(cb, proj)
    missing = [n for n in infra.get("secrets_user") or [] if n not in present]
    if missing:
        P.ask_nicely_for(app_id, missing); raise Stop(f"{app_id}: {', '.join(missing)} not set on {proj}; nothing was deployed.")
    want = [n for n in infra.get("secrets_derived") or [] if n not in present]
    for n, val in mint_values(cb, F, want).items():
        P._set_env(n, val, cb, project=proj); say(f"  {proj}: {n} minted and written (not shown)")
    build = os.path.join(root or ROOT, "build", app_id); os.makedirs(build, exist_ok=True)
    r = subprocess.run(["rsync", "-a", "--delete", *[x for e in F["excludes"] for x in ("--exclude", e)], cb.rstrip("/") + "/", build + "/"], capture_output=True, text=True)
    if r.returncode: raise Stop(f"the build copy could not be made: {r.stderr.strip()[-200:]}")
    link = P._link_dir(proj, cb); os.makedirs(os.path.join(build, ".vercel"), exist_ok=True); shutil.copyfile(os.path.join(link, ".vercel", "project.json"), os.path.join(build, ".vercel", "project.json"))
    url = ""
    for attempt in (1, 2):
        out = P.vercel_deploy(f"vercel deploy --prod --yes {scope}", build, f"{proj} deploy")
        url = P._deployed_address(proj, out, cb, infra)
        cur = P.pull_env(cb, proj, required=False).get("PUBLIC_URL")
        if cur == url: break
        P._set_env("PUBLIC_URL", url, cb, project=proj); say(f"  {proj}: PUBLIC_URL set to {url}" + ("; deploying once more so the app reads it" if attempt == 1 else ""))
    code, doc, why = P._read_health(url + man["health_path"])
    v["production_url"] = url; v["health"] = {"web": str(code) if code else "no answer"}
    if str(code) != "200" or not (isinstance(doc, dict) and doc.get("ok") is True):
        save(os.path.join(adir, "infrastructure.json"), infra)
        raise Stop(f"{proj} deployed to {url}, but {man['health_path']} answered {code or 'nothing'} {why}".strip() + ". Recorded as reverted.")
    infra["deployed_at"] = now(); app["status"] = "stamped" if app.get("status") in (None, "planned", "reverted") else app["status"]; app.pop("revert", None)
    app["mold_commit"] = mold_commit(app["mold_id"], root) or app.get("mold_commit", "")
    save(os.path.join(adir, "infrastructure.json"), infra); save(os.path.join(adir, "application.json"), app)
    say(f"{app_id}: deployed to {url}; {man['health_path']} answered 200 ok"); return 0

def set_secret_vercel(app_id, infra, name, P, root_cb):
    declared = set(infra.get("secrets_user") or []) | set(infra.get("secrets_optional") or []) | set(infra.get("secrets_derived") or [])
    if name not in declared: raise Stop(f"{name} is not a name this app reads (it reads: {', '.join(sorted(declared))}). Nothing was stored.")
    proj = vercel_project(infra)
    v = _hidden_value(app_id, name, P)
    if not P._project_meta(proj, root_cb).get("id"):
        print(f"creating the Vercel project {proj} to hold {name} (empty, free, no deployment) ...")
        P.vrun(f"vercel project add {proj}", shell=True, cwd=root_cb, capture_output=True, text=True); P.disconnect_git(proj, root_cb)
    P._set_env(name, v, root_cb, project=proj)
    print(f"{name} set on {proj} (the value was never shown or stored here). It applies at the next deploy."); return 0

# ---------------------------------------------------------------------------------------------------------
# provision.py hands over here
# ---------------------------------------------------------------------------------------------------------
def main_for(app_id, a, app, infra, ds, adir, P, say=print, root=None):
    """Everything provision.py does for a single-service application. Returns the exit code."""
    t = infra.get("target"); dry = "--dry-run" in a
    try:
        errs = VR.state_problems(app_id, adir) if root is None else []
        if "--lane-key" in a: return lane_key(app_id, app, infra, a, P, say=say, root=root, adir=adir)
        if t == "vercel":
            cb = codebase(app["mold_id"], root)
            for f in ("--deploy-remote", "--set-remote", "--remote-key", "--qualify-remote", "--rollback-remote"):
                if f in a: raise Stop(f"{app_id}: {f} is for an app on a server of its own; this one is on Vercel. Use --deploy.")
            if "--set-secret" in a: return set_secret_vercel(app_id, infra, a[a.index("--set-secret") + 1], P, cb)
            if "--deploy" in a:
                if errs: raise Stop("the state does not validate; nothing was done:\n  " + "\n  ".join(errs))
                man = manifest(app["mold_id"], root); F = compose_facts(cb, man)
                if dry:
                    say(f"{app_id}: --deploy --dry-run: a deploy would do, in this order (nothing is created by this dry run):")
                    for i, l in enumerate(vercel_plan(app_id, F, infra, man), 1): say(f"  {i}. {l}")
                    return 0
                try: return vercel_deploy(app_id, app, infra, adir, P, say=say, root=root)
                except Stop as e: revert(adir, app, str(e)); raise
            for f in ("--rollback", "--smoke", "--verify-db", "--verify-rls"):
                if f in a: raise Stop(f"{app_id}: {f} belongs to mold_v1's three-project deploy; a single-service app has its health check in --deploy and its lanes.")
            return vercel_check(app_id, app, infra, P, say=say, root=root)
        # compose_remote
        if "--set-remote" in a:
            i = a.index("--set-remote"); set_remote(app_id, adir, [x for x in a[i + 1:] if "=" in x and not x.startswith("-")], say=say); return 0
        S = settings(app_id, app, infra, root); man = manifest(app["mold_id"], root); cb = codebase(app["mold_id"], root); F = compose_facts(cb, man)
        if "--remote-key" in a: VR.remote_key(S, say=say); return 0
        for flag, instead in (("--deploy", "--deploy-remote"), ("--rollback", "--rollback-remote"), ("--verify-db", "--deploy-remote"),
                              ("--smoke", "--deploy-remote (its health step)"), ("--verify-rls", "the lanes (its tenant-SQL check; RLS is ticket mold_v0-031)"),
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
            print_plan(S, F, plan(S, F, cb), say=say)
            for p in preflight(cb, F, S): say("  NOT READY (a real deploy refuses here, before contact): " + p)
            if "--out" in a: out = a[a.index("--out") + 1]; write_bundle(S, F, out); say(f"bundle written to {out} for reading; nothing was sent anywhere")
            return 0
        _ready_to_contact(S, app_id)
        try: res = deploy(S, F, cb, say=say)
        except Stop as e: revert(adir, app, str(e)); raise
        record(adir, app, infra, S, res, mold_commit(app["mold_id"], root))
        say(f"{app_id}: deployed release {res['release']} to {S['url']}; health {S['health_path']} answered 200 ok. Next: python3 .claude/scripts/lanes.py {app_id}")
        return 0
    except Stop as e:
        say(str(e)); return 1

# ---------------------------------------------------------------------------------------------------------
# mint.py's stations for a single-service app (None: the station's own reading applies)
# ---------------------------------------------------------------------------------------------------------
DONE, TODO, OPERATOR, FAILED, NA = "done", "next", "needs you", "failed", "not needed"
LANES = ("functional", "context", "load", "accessibility", "responsiveness")
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
        if not url or not i.get("deployed_at"): return (TODO, "first deploy" + (" to its own server" if t == "compose_remote" else " (one Vercel project)"))
        if a.get("status") == "reverted": return (TODO, "a lane failed or a deploy stopped; redeploy once the cause is fixed")
        now_c = mold_commit(a["mold_id"], root); was = a.get("mold_commit")
        if was and now_c and was != now_c: return (TODO, f"the mold moved ({was[:7]} -> {now_c[:7]}); redeploy to pick it up")
        return (DONE, f"{url} (deployed {i['deployed_at'][:16]})")
    if name == "tests":
        tt = a.get("testing") or {}; dep = i.get("deployed_at") or ""
        if any((tt.get(l) or {}).get("status") == "fail" for l in tt): return (FAILED, "a lane failed; its report is named in application.json testing")
        ran = [(tt.get(l) or {}).get("run_at") or "" for l in LANES]
        if not all(ran) or min(ran) < dep: return (TODO, "run the five lanes against this deploy")
        if url and not lane_key_ok(app_id, url):
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
        url = address(infra)
        if not url: print(f"{app_id} is not deployed yet: python3 .claude/scripts/provision.py {app_id} --deploy-remote", file=sys.stderr); return 1
        if not lane_key_ok(app_id, url):
            print(f"{app_id} has no lane-check organisation for {url} yet; with the operator's yes: python3 .claude/scripts/provision.py {app_id} --lane-key --yes", file=sys.stderr); return 1
        print(lane_key_path(app_id)); return 0
    if a[0] == "--self-test":
        # The tests live beside this file (single_service_selftest.py), which no server bundle carries.
        return subprocess.run([sys.executable, os.path.join(HERE, "single_service_selftest.py")]).returncode
    print(__doc__); return 2

if __name__ == "__main__": sys.exit(cli(sys.argv[1:]))
