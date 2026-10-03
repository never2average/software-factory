#!/usr/bin/env python3
"""vm_remote: put a stamped application on a server over SSH (mold_v1-075, -076, -077, -078).

Called by provision.py for an application whose infrastructure.target is "vm_remote":

  provision.py <app_id>                          check: offline and read-only, connects to nothing
  provision.py <app_id> --set-remote host=<address> domain=<name> [ssh_user= ssh_port= ssh_key_ref=]
  provision.py <app_id> --remote-key             make the SSH key pair named by ssh_key_ref (if absent), print the PUBLIC half
  provision.py <app_id> --qualify-remote         connect, run the read-only host probe, say yes or no
  provision.py <app_id> --deploy-remote --dry-run [--out DIR]
                                                 print every local command, every remote command and every generated
                                                 file, in order, WITHOUT connecting; --out also writes the bundle
  provision.py <app_id> --deploy-remote          the deploy
  provision.py <app_id> --verify-rls [--no-repair]   re-prove tenant isolation on the server's database and running app

and directly, for a state directory outside state/ (a fixture) and for the offline tests:

  vm_remote.py plan <dir with the four state files> [--source DIR] [--out DIR]
  vm_remote.py --self-test

The same file is copied to the server and run THERE for everything that touches a secret value, so no value
ever crosses the SSH command line (env-merge, env-mint, env-names, env-split, env-run, pg-admin, host-chain below).

WHAT A DEPLOY DOES, in order (reports/vm-spike-mold_v1-072.md is why each step is the way it is):
   1 qualify      read-only probe: /dev/kvm, 8 GB / 4 vCPU, free disk, Ubuntu 24.04, x86-64, sudo, no Docker, no
                  other web server (Caddy is the one reverse proxy; nginx or Apache would hold ports 80 and 443).
                  Anything short is refused in plain words before a single package is installed.
   2 dns          the domain must already point at the server, or Caddy cannot get a certificate.
   3 bundle       the generated scripts, unit files, Caddyfile and the factory's database tooling -> <install>/factory
   4 packages     Node 24, Caddy, PostgreSQL, ufw, fail2ban, nftables; the service user `sfapp` (no login, no sudo)
   5 firewall     ufw: the SSH port, 80 and 443 only; fail2ban for ssh; an egress rule that keeps the service user
                  off the cloud metadata address and the private ranges. No Docker rule: there is no Docker.
   6 postgres     the app's own cluster on 127.0.0.1, TLS on; the admin password is minted ON the server
   7 env          the master env file, mode 600, root-owned: settings from state, secrets minted on the server, and the
                  operator's own values from a hidden prompt (or from named environment values), sent on stdin. Each
                  service reads only its own file split from it (web.env, api.env, workflow.env, cron.env; root, 600):
                  the agent's holds the sign-in PUBLIC key only, the workflow service's only the three names it reads
   8 source       rsync the SOURCE (never a build) to <install>/app
   9 build        stop the services, then build IN PLACE, one build at a time: the build embeds absolute paths
  10 database     the SAME chain as the Vercel path (provision.SCHEMA_CHAIN through provision._run_chain): hold,
                  journal, drift dry run that refuses data loss, RLS bootstrap, coverage, release, isolation proof
  11 units        three services (workflow, api, web) and six cron timers. The API runs as `sfapp` in group kvm;
                  before it starts, the mold's own `npm run sandbox:prewarm` clears stale template locks, links the
                  sandbox runtime, refuses a data room the sandbox could not reach, and prewarms one template at a time
  12 caddy        TLS for the domain, everything proxied to the web app on loopback
  13 health       the three health endpoints, /dev/kvm and the API's groups, public listeners, then the same
                  read of /api/ops/health the Vercel path gates on

Every step is safe to run again. A redeploy takes the app offline from step 9 until step 11 finishes (the build is
not relocatable, so there is nowhere else to build it); say so before running one in working hours.
"""
import datetime, getpass, json, os, re, secrets as pysecrets, shlex, shutil, socket, subprocess, sys, tempfile, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
FIXTURE = os.path.join(SCRIPTS, "fixtures", "vm_remote", "vm_remote_fixture")

SERVICE_USER = "sfapp"
PORTS = {"web": 3000, "api": 3001, "workflow": 3002}
HOST_MIN = {"mem_mb": 7500, "vcpu": 4, "disk_free_gb": 20}      # an "8 GB" machine reports about 7.9 GB
OS_OK = (("ubuntu", "24.04"),)
ARCH_OK = ("x86_64",)                                            # the microsandbox runtime shipped in the mold is linux-x64
NO_HOST = "SERVER-ADDRESS-NOT-SUPPLIED-YET"
NO_DOMAIN = "domain-not-supplied-yet.invalid"
DENY_REQUIRED = ("169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8")
# The uid-level second layer cannot include loopback: the services themselves talk to Postgres and to each other there.
EGRESS_DENY = ("169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
# vercel.json's six schedules. plan() reads them from the SOURCE being shipped and refuses a schedule it cannot
# express; this list is only the fallback when a source has no vercel.json, and the self-test pins it to the mold's.
CRONS = (("resume-workflows", "*/5 * * * *"), ("run-cron-workflows", "* * * * *"), ("refresh-apps", "* * * * *"),
         ("sync-inbox", "*/10 * * * *"), ("close-abandoned-runs", "*/15 * * * *"), ("deliver-queued", "* * * * *"))
# The switches the mold must carry before it can run off Vercel (all upstream since fde-agent da581f2). A real deploy
# refuses while any is missing from the source it ships, and a dry run names them.
MOLD_SWITCHES = (("SANDBOX_BACKEND", "the sandbox setting (microVM backend, vCPUs, memory, network deny list)", "fde-agent #100 (mold_v1-151)"),
                 ("STORAGE_DRIVER", "the file-storage driver that replaces Vercel Blob", "fde-agent #103 (mold_v1-073)"),
                 ("SERVICE_AUTH", "the web app's own service identity that replaces the Vercel token", "fde-agent #99 (mold_v1-074)"))
# The mold's own off-Vercel tooling the deploy runs (fde-agent #100). A source without it is refused like a missing switch.
MOLD_SCRIPTS = (("sandbox:prewarm", "the mold's serial sandbox prewarm (stale locks, runtime link, file-link reach check)", "fde-agent #100 (docs/self-hosting/SANDBOX.md)"),)
# STORAGE_SIGNING_SECRET signs the filesystem driver's file links (lib/storage/settings.ts: 32+ characters; the web app and
# the agent hold the same value). Minted with the others; it reaches a service's env file only on the filesystem driver.
INTERNAL = ("CRON_SECRET", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "STORAGE_SIGNING_SECRET")
MINTED = INTERNAL + ("AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY")
SERVER_MADE = MINTED + ("POSTGRES_ADMIN_URL", "DATABASE_URL")
# ---- which service reads which name (fde-agent da581f2; checked against the source, see the self-test) ------------
# The master env file holds every name; each service gets a file of its own split from it (env_split), so a process
# never holds what it does not read. Read only by the factory's database chain and the mold's migration scripts, which
# run as root from the master file: no service gets these.
ADMIN_ONLY = ("POSTGRES_ADMIN_URL", "DATABASE_SSL")
# Read by the web app and never by the agent (SERVICE_AUTH=session-key: the web app signs with the private half, the
# agent verifies with the public half and must not be able to sign; docs/self-hosting/SERVICE_IDENTITY.md).
WEB_ONLY = ("AUTH_JWT_PRIVATE_KEY", "EVE_API_URL", "NEXT_PUBLIC_EVE_API_URL", "RESEND_API_KEY", "PLATFORM_NOTIFY_FROM",
            "NEXT_PUBLIC_GOOGLE_CLIENT_ID")
# The task-workflow service (services/task-workflow) reads exactly these, and the cron calls only the first.
WORKFLOW_READS = ("DATABASE_URL", "TASK_WORKFLOW_SERVICE_TOKEN", "WORKFLOW_LOCAL_DATA_DIR")
CRON_READS = ("CRON_SECRET",)
# Names earlier versions of this plan wrote that the mold never read (STORAGE_DIR, the s3 names without S3_, and the
# agent's developer fallback DATAROOM_DIR, which is not the filesystem driver). The master file keeps what it was
# given, so they are kept out of every service's file instead.
RETIRED = ("STORAGE_DIR", "DATAROOM_DIR", "STORAGE_BUCKET", "STORAGE_REGION", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY_REF", "STORAGE_SECRET_KEY_REF")
# The s3 driver reads its key pair under these names; state names where the operator's values are stored (*_ref).
S3_KEYS = (("access_key_ref", "STORAGE_S3_ACCESS_KEY_ID"), ("secret_key_ref", "STORAGE_S3_SECRET_ACCESS_KEY"))
SOURCE_EXCLUDES = ("node_modules", ".next", ".output", ".eve", ".vercel", ".git", ".env", ".env.*", ".dataroom",
                   "test-results", ".eve-build-hidden", "*.log")
GUARD_VAR = "SF_REMOTE_DEPLOY"

class Stop(Exception):
    """The deploy cannot go on. The message is one plain instruction for the operator."""

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
def load(p): return json.load(open(p))
def fill(t, **kw):
    for k, v in kw.items(): t = t.replace("@" + k + "@", str(v))
    left = re.findall(r"@[A-Z_]+@", t)
    if left: raise KeyError(f"template placeholders left unfilled: {sorted(set(left))}")
    return t

# ---------------------------------------------------------------------------------------------------------
# settings: everything the plan needs, from state alone
# ---------------------------------------------------------------------------------------------------------
def settings(app_id, app, infra, ds):
    vr = infra.get("vm_remote") or {}
    slug = app_id.replace("_", "-")
    install = f"/opt/software-factory/{app_id}"; data = f"/var/lib/software-factory/{app_id}"
    pg = ds.get("postgres") or {}; vp = vr.get("postgres") or {}
    ws = app.get("workspace") or {}
    S = {"app_id": app_id, "slug": slug, "unit": f"sf-{slug}",
         "host": vr.get("host") or "", "domain": vr.get("domain") or "", "user": vr.get("ssh_user") or "root",
         "port": int(vr.get("ssh_port") or 22), "key_ref": vr.get("ssh_key_ref") or "",
         "install": install, "app_dir": f"{install}/app", "factory_dir": f"{install}/factory",
         "env_dir": f"/etc/software-factory/{app_id}", "env_file": f"/etc/software-factory/{app_id}/env", "data": data,
         "env_files": {k: f"/etc/software-factory/{app_id}/{k}.env" for k in ("web", "api", "workflow", "cron")},
         "sandbox": dict(vr.get("sandbox") or {}), "storage": dict(vr.get("storage") or {}),
         "pg": {"version": int(vp.get("version") or 17), "tls": vp.get("tls") or "on", "switch": vp.get("migration_switch_env") or "",
                "db": pg.get("database") or re.sub(r"[^a-z0-9]", "", app_id.lower()), "port": int(pg.get("port") or 5432)},
         "mode": pg.get("rls", "fail_closed"), "flags": dict(infra.get("runtime_env") or {}), "model": dict(app.get("model") or {}),
         "secrets_user": list(infra.get("secrets_user") or []),
         "email": ((ws.get("operator_self") or ws.get("fde_self") or {}).get("email") or "").strip()}
    # `host` is the PUBLIC address (DNS, the sandbox deny list). SSH goes to ssh_host when one is named, e.g. the
    # server's address on a private administration tunnel (mold_v1-156); and the firewall lets only ssh_allow_from
    # reach the SSH port when that is named. Absent, both are today's behaviour: SSH to `host`, port open to all.
    S["ssh_host"] = vr.get("ssh_host") or ""; S["ssh_allow_from"] = vr.get("ssh_allow_from") or ""
    S["host_shown"] = S["ssh_host"] or S["host"] or NO_HOST; S["domain_shown"] = S["domain"] or NO_DOMAIN
    S["url"] = f"https://{S['domain_shown']}"
    S["sudo"] = "" if S["user"] == "root" else "sudo "
    S["tool"] = f"{S['factory_dir']}/.claude/scripts/lib/vm_remote.py"
    S["sslmode"] = "require" if S["pg"]["tls"] == "on" else "disable"
    return S

def shape_state(app_id, infra, ds, di, host=None, domain=None):
    """Turn the state intake built into the vm_remote shape, in place: the target's own object with every default
    filled, the datastores it implies (its own Postgres on loopback, files on its disk), and the secret NAMES that
    exist on a server (no Vercel Blob token, no managed-provider URL). The server address and the domain stay
    absent unless the brief gave them: they are the two things the operator supplies later."""
    infra["target"] = "vm_remote"; infra["secret_store"] = "vm_remote_env_file"
    infra["sandbox"] = {"provider": "microsandbox", "prewarm": True}
    drop = {"BLOB_READ_WRITE_TOKEN", "DATABASE_URL_UNPOOLED", "SUPABASE_URL", "SUPABASE_POSTGRES_URL_NON_POOLING"}
    for k in ("secrets", "secrets_user", "secrets_derived"): infra[k] = [n for n in infra.get(k, []) if n not in drop]
    if "POSTGRES_ADMIN_URL" not in infra["secrets_derived"]: infra["secrets_derived"].insert(1, "POSTGRES_ADMIN_URL")
    infra["secrets"] = sorted(set(infra["secrets"]) | {"POSTGRES_ADMIN_URL"})
    for other in ("vercel", "vm"): infra.pop(other, None)
    vr = {"provider": "digitalocean", "ssh_user": "root", "ssh_port": 22, "ssh_key_ref": f"sf_{app_id}",
          "install_path": f"/opt/software-factory/{app_id}", "kvm": "required",
          "sandbox": {"backend": "microsandbox", "cpus": 2, "memory_mib": 1024, "deny_subnets": list(DENY_REQUIRED)},
          "storage": {"driver": "fs", "dir": f"/var/lib/software-factory/{app_id}/storage"},
          "postgres": {"version": 17, "tls": "on"}}
    if host: vr["host"] = host
    if domain: vr["domain"] = domain.lower()
    infra["vm_remote"] = vr
    pg = ds.setdefault("postgres", {})
    for k in ("network", "pooling"): pg.pop(k, None)
    pg.update({"provider": "self_hosted", "host": "127.0.0.1", "port": 5432, "database": re.sub(r"[^a-z0-9]", "", app_id.lower()),
               "admin_url_ref": "POSTGRES_ADMIN_URL", "exposure": "remote_loopback", "sslmode": "require"})
    ds["blob"] = {"provider": "fs", "root_prefix": (ds.get("blob") or {}).get("root_prefix", "")}
    (di.get("dataroom") or {})["backend"] = "local"
    return infra, ds, di

def key_path(S): return os.path.join(os.path.expanduser("~"), ".ssh", S["key_ref"])
def key_shown(S): return f"~/.ssh/{S['key_ref']}"
KEY_MARK = "SF-KEY-PATH"     # stands in for the key path while a command is quoted for display
def shown_cmd(S, argv): return shlex.join(argv).replace(KEY_MARK, key_shown(S))

def ssh_opts(S, shown=False):
    return ["-p", str(S["port"]), "-i", KEY_MARK if shown else key_path(S), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20"]
def ssh_argv(S, remote, shown=False):
    return ["ssh", *ssh_opts(S, shown), f"{S['user']}@{S['host_shown']}", "--", remote]
def rsync_argv(S, src, dst, excludes=(), shown=False):
    a = ["rsync", "-az", "--delete"]
    for x in excludes: a += ["--exclude", x]
    if S["user"] != "root": a += ["--rsync-path", "sudo rsync"]
    return a + ["-e", shlex.join(["ssh", *ssh_opts(S, shown)]), src.rstrip("/") + "/", f"{S['user']}@{S['host_shown']}:{dst.rstrip('/')}/"]
def guarded(S, cmd):
    """A remote command that changes the server: run as root, with the marker the generated scripts insist on."""
    return f"{S['sudo']}env {GUARD_VAR}={S['app_id']} {cmd}"

# ---------------------------------------------------------------------------------------------------------
# the env file: names in, names out, values never printed
# ---------------------------------------------------------------------------------------------------------
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
def env_parse(text):
    out = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); k = k.strip(); v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] == '"': v = v[1:-1]
        if ENV_NAME.match(k): out[k] = v
    return out
def env_read(path): return env_parse(open(path).read()) if os.path.isfile(path) else {}
def env_names(path): return sorted(k for k, v in env_read(path).items() if v != "")
def env_check(name, value):
    """Why a pair cannot be stored, as a sentence that names the NAME and never the value; None when it can.
    One file is read by systemd (EnvironmentFile) and by env-run below, so a value must mean the same to both:
    one line, no double quote, no backslash. Every value is written inside double quotes."""
    if not ENV_NAME.match(name or ""): return f"{name!r} is not a usable name (letters, digits and underscores only)"
    if value == "": return f"{name} is empty, so nothing was stored for it"
    if "\n" in value or "\r" in value: return f"{name} has a line break in it; paste it as one line"
    if '"' in value or "\\" in value: return f"{name} contains a double quote or a backslash, which this file cannot hold; check you copied the right value"
    return None
def env_write(path, vals):
    """Atomic, mode 600, in a directory only its owner can enter. Nothing is echoed."""
    d = os.path.dirname(path); os.makedirs(d, mode=0o700, exist_ok=True)
    old = os.umask(0o077)
    try:
        fd, tmp = tempfile.mkstemp(prefix=".env.", dir=d)
        with os.fdopen(fd, "w") as f:
            for k in sorted(vals): f.write(f'{k}="{vals[k]}"\n')
        os.chmod(tmp, 0o600); os.replace(tmp, path)
    finally: os.umask(old)
def env_merge(path, pairs):
    """Merge pairs into the file. Returns (added names, changed names, refusals). A refused pair is not written."""
    cur = env_read(path); added, changed, refused = [], [], []
    for k, v in pairs.items():
        why = env_check(k, v)
        if why: refused.append(why); continue
        if k not in cur: added.append(k)
        elif cur[k] != v: changed.append(k)
        cur[k] = v
    if added or changed or not os.path.isfile(path): env_write(path, cur)
    else: os.chmod(path, 0o600)
    return sorted(added), sorted(changed), refused
def _jwt_pair():
    js = ("const{generateKeyPairSync}=require('crypto');const{publicKey:a,privateKey:b}=generateKeyPairSync('ec',{namedCurve:'P-256'});"
          "console.log(Buffer.from(b.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log(Buffer.from(a.export({type:'spki',format:'pem'})).toString('base64'))")
    priv, pub = subprocess.check_output(["node", "-e", js], text=True).split()
    return priv, pub
def env_mint(path, jwt_pair=_jwt_pair):
    """Mint the app's own internal secrets ON THE MACHINE THAT KEEPS THEM, once. A name already present is kept:
    a new CRON_SECRET or sign-in key on every deploy would sign everybody out. The key pair is kept only as a
    pair (one half without the other signs sessions nothing can verify). Returns the names minted."""
    cur = env_read(path); new = {}
    for k in INTERNAL:
        if not cur.get(k): new[k] = pysecrets.token_hex(32)       # 64 characters: STORAGE_SIGNING_SECRET needs 32+
    if not (cur.get("AUTH_JWT_PRIVATE_KEY") and cur.get("AUTH_JWT_PUBLIC_KEY")):
        new["AUTH_JWT_PRIVATE_KEY"], new["AUTH_JWT_PUBLIC_KEY"] = jwt_pair()
    if new: env_merge(path, new)
    else: os.chmod(path, 0o600) if os.path.isfile(path) else env_write(path, cur)
    return sorted(new)
def stdin_pairs(text):
    out = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1); out[k.strip()] = v
    return out

def deny_list(S):
    """SANDBOX_DENY_SUBNETS: state's list, which validate holds to the five required ranges (the mold adds the same five
    itself, agent/lib/sandbox-settings.ts). The server's own public address is NOT added: with the filesystem storage
    driver a sandbox downloads data-room files from the web app's public origin, which is that address
    (docs/self-hosting/SANDBOX.md). What protects that address is that every service on the host listens on loopback
    behind Caddy (health_verdict refuses any other public listener), so it offers a sandbox nothing the internet does
    not already see."""
    return list(dict.fromkeys(list(S["sandbox"].get("deny_subnets") or []) + list(DENY_REQUIRED)))

def _covered(address, cidrs):
    """The first CIDR in `cidrs` that holds `address` (an IP literal), else None."""
    import ipaddress
    try: ip = ipaddress.ip_address(address.strip("[]"))
    except ValueError: return None
    for c in cidrs:
        try:
            if ip in ipaddress.ip_network(c, strict=False): return c
        except ValueError: continue
    return None

def sandbox_conflict(S, addresses=None):
    """Why the agent's sandbox could not fetch the data room's files, or None. Only the filesystem driver has the
    problem: its signed links point at https://<domain>, so every address that name leads to must be outside the
    sandbox deny list. `addresses` are what the domain resolves to; without them, the public `host` stands in when it
    is an IP literal. The mold's `npm run sandbox:prewarm` makes the same check on the server before the API starts."""
    if (S["storage"].get("driver") or "fs") != "fs": return None
    cands = list(addresses) if addresses else ([S["host"]] if re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]+", S["host"] or "") else [])
    deny = deny_list(S)
    for a in cands:
        c = _covered(a, deny)
        if c:
            head = (f"{S['app_id']}: the data room's files are kept on the server's own disk (vm_remote.storage.driver \"fs\"), so the "
                    f"agent's sandbox downloads them from {S['url']}, which is {a}; but {a} is inside the networks the sandbox may never "
                    f"reach ({c}), so every file fetch would fail. ")
            fix = (f"Switch vm_remote.storage to the s3 driver, or put the app on a server with a public address" if c in DENY_REQUIRED else
                   f"Take {c} out of vm_remote.sandbox.deny_subnets in state/application/{S['app_id']}/infrastructure.json (the server's "
                   f"services listen on loopback only, behind Caddy, so its public address offers a sandbox nothing the internet does "
                   f"not see), or switch vm_remote.storage to the s3 driver")
            return head + fix + " (docs/self-hosting/SANDBOX.md in the mold)."
    return None

def storage_pairs(S):
    """The storage driver's settings, under the names lib/storage/settings.ts reads (fde-agent #103, docs/STORAGE.md).
    Names and non-secret values only: the signing secret is minted on the server, the s3 key pair is the operator's."""
    sg = S["storage"]
    if (sg.get("driver") or "fs") == "fs":
        return {"STORAGE_DRIVER": "filesystem", "STORAGE_FS_ROOT": sg.get("dir") or f"{S['data']}/storage",
                # The web app's public address: where a signed file link points, and what a sandbox downloads.
                "STORAGE_PUBLIC_URL": S["url"]}
    c = {"STORAGE_DRIVER": "s3"}
    for k, n in (("endpoint", "STORAGE_S3_ENDPOINT"), ("bucket", "STORAGE_S3_BUCKET"), ("region", "STORAGE_S3_REGION"), ("addressing", "STORAGE_S3_ADDRESSING")):
        if sg.get(k): c[n] = sg[k]
    # Build time, for the browser: the host signed links are served from (lib/storage/hosts.ts).
    host = urllib.parse.urlsplit(sg.get("endpoint") or "").hostname or ""
    if host and sg.get("bucket"):
        c["NEXT_PUBLIC_STORAGE_HOST"] = f"{sg['bucket']}.{host}" if sg.get("addressing") == "virtual" else host
    return c

def config_pairs(S):
    """The NON-secret half of the master env file, derived from state on every deploy so the running app cannot
    disagree with its state. Build-time flags (ENABLE_*) live here and nowhere else, which is what makes them identical
    at build and at run. Every name here is one the mold reads (the self-test checks them against the source)."""
    f = S["flags"]; sb = S["sandbox"]
    c = {"MODEL_PROVIDER": S["model"].get("provider") or f.get("MODEL_PROVIDER", "cloudflare"),
         "ENABLE_WEB_SEARCH": f.get("ENABLE_WEB_SEARCH", "true"), "ENABLE_BROWSER": f.get("ENABLE_BROWSER", "false"),
         "OPS_MULTI_TENANT": f.get("OPS_MULTI_TENANT", "1"),
         "WEB_ORIGIN": S["url"],
         # Both names, one address: lib/agent-url.ts refuses EVE_API_URL that differs from NEXT_PUBLIC_EVE_API_URL, and
         # off Vercel refuses to build or start with neither (fde-agent #101). Read at BUILD time.
         "EVE_API_URL": f"http://127.0.0.1:{PORTS['api']}", "NEXT_PUBLIC_EVE_API_URL": f"http://127.0.0.1:{PORTS['api']}",
         "TASK_WORKFLOW_SERVICE_URL": f"http://127.0.0.1:{PORTS['workflow']}",
         # eve's local workflow world (the agent). The task-workflow service gets a directory of its own (service_env_spec).
         "WORKFLOW_LOCAL_DATA_DIR": f"{S['data']}/workflow-data",
         # The web app presents its own short-lived service token and the agent accepts it (fde-agent #99).
         "SERVICE_AUTH": "session-key",
         "SANDBOX_BACKEND": sb.get("backend", "microsandbox"), "SANDBOX_CPUS": str(sb.get("cpus", 2)),
         "SANDBOX_MEMORY_MIB": str(sb.get("memory_mib", 1024)), "SANDBOX_DENY_SUBNETS": ",".join(deny_list(S)),
         "EVE_DOCKER_PATH": "/nonexistent/docker",
         # The mold's migration scripts (scripts/lib/migration-ssl.mjs): Postgres here answers TLS unless state says not.
         "DATABASE_SSL": "require" if S["pg"]["tls"] == "on" else "disable",
         **storage_pairs(S)}
    if S["model"].get("provider") == "cloudflare":
        for role, name in (("orchestrator", "CLOUDFLARE_MODEL_ORCHESTRATOR"), ("specialist", "CLOUDFLARE_MODEL_SPECIALIST")):
            if (S["model"].get("roles") or {}).get(role): c[name] = S["model"]["roles"][role]
    if S["pg"]["tls"] == "migration_switch" and S["pg"]["switch"]: c[S["pg"]["switch"]] = "disable"
    return c

def service_env_spec(S):
    """Which names each service's env file gets, as data (written to the bundle as env-services.json and applied on the
    server by env-split; names only, never a value).
      keep   the names to take from the master file (None: every name but `drop`)
      drop   names never to take
      alias  {name the mold reads: name state stores the value under}, copied on the server
      set    non-secret values that differ for this service"""
    sg = S["storage"]; fs = (sg.get("driver") or "fs") == "fs"
    admin = list(ADMIN_ONLY) + ([S["pg"]["switch"]] if S["pg"]["switch"] else []) + list(RETIRED)
    alias = {} if fs else {mold: sg[k] for k, mold in S3_KEYS if sg.get(k) and sg[k] != mold}
    # The signing secret signs the filesystem driver's links; on s3 no service needs it.
    unused = [] if fs else ["STORAGE_SIGNING_SECRET"]
    # The operator's s3 values under their stored names are passed on under the mold's names instead.
    stored = sorted(alias.values())
    return {
        "web": {"keep": None, "drop": sorted(set(admin + unused + stored)), "alias": alias, "set": {}},
        "api": {"keep": None, "drop": sorted(set(admin + unused + stored + list(WEB_ONLY))), "alias": alias, "set": {}},
        "workflow": {"keep": list(WORKFLOW_READS), "drop": [], "alias": {}, "set": {"WORKFLOW_LOCAL_DATA_DIR": f"{S['data']}/task-workflow-data"}},
        "cron": {"keep": list(CRON_READS), "drop": [], "alias": {}, "set": {}},
    }

def split_values(master, spec):
    """{service: {name: value}} from the master file's values, per service_env_spec. Pure."""
    out = {}
    for svc, sp in spec.items():
        keep = sp.get("keep"); drop = set(sp.get("drop") or [])
        vals = {k: v for k, v in master.items() if (keep is None or k in keep) and k not in drop}
        for mold, stored in (sp.get("alias") or {}).items():
            if master.get(stored): vals[mold] = master[stored]
        vals.update(sp.get("set") or {})
        out[svc] = vals
    return out

def env_split(master_path, env_dir, spec):
    """On the server, as root: write each service's env file from the master file, atomically, mode 600, in the root-only
    env directory. The files are root's, not the service user's: systemd reads EnvironmentFile as root, and a file the
    service user could open would let the agent (same user as the web app) read the web app's private key. Rewritten
    whole every time, so a name the spec no longer gives a service disappears from its file. Returns {service: count}."""
    vals = split_values(env_read(master_path), spec)
    if "AUTH_JWT_PRIVATE_KEY" in vals.get("api", {}):
        raise SystemExit("env-split: refusing to give the agent the sign-in private key; nothing was written")
    for svc, v in vals.items(): env_write(os.path.join(env_dir, f"{svc}.env"), v)
    return {svc: len(v) for svc, v in vals.items()}

def operator_names(S):
    """The names only the operator can supply. One client id feeds both Google names."""
    return [n for n in S["secrets_user"] if n != "NEXT_PUBLIC_GOOGLE_CLIENT_ID"]

def collect_secrets(app_id, missing, environ=None, ask=None, tty=None, explain=None, shape=None, say=print):
    """Values for the missing operator names: a named environment value if this shell has one, else a hidden
    prompt. Returns {name: value}. Nothing is echoed, logged or returned to any caller but the stdin of ONE
    ssh command. With no terminal and no environment value it stops and says which names, never guessing."""
    environ = os.environ if environ is None else environ
    tty = sys.stdin.isatty() if tty is None else tty
    ask = ask or getpass.getpass
    got, need_prompt = {}, []
    for n in missing:
        v = (environ.get(n) or "").strip()
        if v:
            why = env_check(n, v) or (shape(n, v) if shape else None)
            if why: raise Stop(f"{why}. That came from this shell's environment; nothing was sent to the server.")
            got[n] = v; say(f"  {n}: taken from this shell's environment (not shown)")
        else: need_prompt.append(n)
    if need_prompt and not tty:
        raise Stop(f"{app_id}: {len(need_prompt)} value(s) only you hold are not on the server yet: {', '.join(need_prompt)}. "
                   f"They are typed at a hidden prompt, so run this command yourself in a terminal: "
                   f"python3 .claude/scripts/provision.py {app_id} --deploy-remote")
    for n in need_prompt:
        if explain: explain(n)
        for _ in range(3):
            v = ask(f"{n} (hidden): ").strip()
            why = env_check(n, v) or (shape(n, v) if shape else None)
            if why: say(f"  {why}. Nothing was stored; try again."); continue
            got[n] = v; break
        else: raise Stop(f"{app_id}: {n} was not stored after three tries. Nothing was sent to the server; run the command again when you have it.")
    if "GOOGLE_CLIENT_ID" in got: got["NEXT_PUBLIC_GOOGLE_CLIENT_ID"] = got["GOOGLE_CLIENT_ID"]
    return got

# ---------------------------------------------------------------------------------------------------------
# host qualification
# ---------------------------------------------------------------------------------------------------------
QUALIFY_SH = r"""#!/bin/sh
# GENERATED by .claude/scripts/lib/vm_remote.py. READ-ONLY: it changes nothing on the machine it runs on.
ID=unknown; VERSION_ID=unknown
[ -r /etc/os-release ] && . /etc/os-release
echo "OS_ID=${ID}"
echo "OS_VERSION=${VERSION_ID}"
echo "ARCH=$(uname -m)"
if [ -c /dev/kvm ]; then echo "KVM=present"; else echo "KVM=absent"; fi
echo "MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
echo "VCPU=$(nproc)"
echo "DISK_FREE_KB=$(df -Pk /opt 2>/dev/null | awk 'NR==2 {print $4}')"
if [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; then echo "SUDO=ok"; else echo "SUDO=no"; fi
if command -v docker >/dev/null 2>&1; then echo "DOCKER=present"; else echo "DOCKER=absent"; fi
if [ -d /run/systemd/system ]; then echo "SYSTEMD=yes"; else echo "SYSTEMD=no"; fi
# Caddy is the app's one web server; another one already installed would hold ports 80 and 443.
p=none
for b in nginx apache2 httpd haproxy traefik lighttpd; do
  if command -v "$b" >/dev/null 2>&1 || [ -x "/usr/sbin/$b" ]; then p="$b"; break; fi
done
echo "PROXY=$p"
"""
def parse_kv(text):
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
        if m: out[m.group(1)] = m.group(2).strip()
    return out
def qualify(facts):
    """Plain sentences for everything that disqualifies the server; [] means it is fit. A fact the probe did not
    report is a refusal too: a server that could not be read has not been shown to be anything."""
    bad = []
    def num(k):
        try: return int(facts.get(k, ""))
        except ValueError: return None
    need = ("OS_ID", "OS_VERSION", "ARCH", "KVM", "MEM_KB", "VCPU", "DISK_FREE_KB", "SUDO", "DOCKER", "SYSTEMD", "PROXY")
    unread = [k for k in need if not facts.get(k)]
    if unread:
        return [f"The server answered, but the check could not read {', '.join(unread)}, so nothing is known about it. "
                f"Nothing was installed. Run the check again; if it repeats, the server is not a standard Ubuntu machine."]
    if facts["KVM"] != "present":
        bad.append("This server cannot run virtual machines inside itself (it has no /dev/kvm), and the agent's sandbox is a small "
                   "virtual machine. Ask the provider for a plan with \"nested virtualization\" or a dedicated/bare-metal server, "
                   "or pick another provider. Nothing was installed.")
    mem = num("MEM_KB"); cpu = num("VCPU"); disk = num("DISK_FREE_KB")
    if mem is None or mem < HOST_MIN["mem_mb"] * 1024:
        bad.append(f"This server has {round((mem or 0) / 1048576, 1)} GB of memory; the app needs 8 GB (building it takes about 3 GB "
                   f"on its own, and each agent sandbox up to 1 GB). Resize it to an 8 GB plan.")
    if cpu is None or cpu < HOST_MIN["vcpu"]:
        bad.append(f"This server has {cpu or 0} virtual CPU(s); the app needs {HOST_MIN['vcpu']} (each sandbox uses 2). Resize it to a 4-CPU plan.")
    if disk is None or disk < HOST_MIN["disk_free_gb"] * 1048576:
        bad.append(f"This server has {round((disk or 0) / 1048576, 1)} GB of free disk; the app needs {HOST_MIN['disk_free_gb']} GB free "
                   f"(the build, the sandbox templates and every chat's sandbox live on it). Pick a plan with a larger disk.")
    if (facts["OS_ID"], facts["OS_VERSION"]) not in OS_OK:
        bad.append(f"This server runs {facts['OS_ID']} {facts['OS_VERSION']}; the deploy is written for Ubuntu 24.04 and nothing else has "
                   f"been tried. Create the server again and choose \"Ubuntu 24.04 (LTS) x64\".")
    if facts["ARCH"] not in ARCH_OK:
        bad.append(f"This server's processor type is {facts['ARCH']}; the sandbox runtime the app ships is for x86-64 (Intel/AMD). "
                   f"Choose a regular Intel or AMD plan, not an ARM one.")
    if facts["SUDO"] != "ok":
        bad.append("The login the deploy uses can neither act as root nor use sudo without a password, so it cannot install anything. "
                   "Use the root login the provider gave you, or allow that user passwordless sudo.")
    if facts["DOCKER"] != "absent":
        bad.append("Docker is installed on this server. Docker rewrites firewall rules and opens ports behind the firewall's back, and "
                   "the app would pick it over the safer sandbox. Use a fresh server with nothing else on it.")
    if facts["PROXY"] != "none":
        bad.append(f"Another web server ({facts['PROXY']}) is installed on this server. The app's one web server is Caddy, which "
                   f"answers on the two web ports and gets the security certificate; two cannot share those ports. Use a fresh "
                   f"server with nothing else on it.")
    if facts["SYSTEMD"] != "yes":
        bad.append("This server does not run systemd, which is what keeps the app's three services and six timers alive. Use a "
                   "standard Ubuntu 24.04 server image.")
    return bad

# ---------------------------------------------------------------------------------------------------------
# generated files
# ---------------------------------------------------------------------------------------------------------
HEAD = ("# GENERATED by .claude/scripts/lib/vm_remote.py from state/application/@APP@/. Regenerated on every deploy;\n"
        "# an edit made on the server is replaced by the next one.\n")
GUARD = ('[ "${' + GUARD_VAR + ':-}" = "@APP@" ] || { echo "refusing to run: this script changes the machine it runs on. It is run only '
         'on @APP@\'s own server, by provision.py --deploy-remote." >&2; exit 3; }\n')

def cron_to_oncalendar(expr):
    """The two cron shapes vercel.json uses, as a systemd calendar expression; None for anything else."""
    f = expr.split()
    if len(f) != 5 or f[1:] != ["*", "*", "*", "*"]: return None
    if f[0] == "*": return "*-*-* *:*:00"
    m = re.fullmatch(r"\*/(\d{1,2})", f[0])
    return f"*-*-* *:0/{int(m.group(1))}:00" if m and 1 <= int(m.group(1)) <= 30 else None

def read_crons(source_dir):
    """(route name, cron expression) for every cron the source declares. The deploy mirrors vercel.json rather than
    a list in this file, so a seventh cron upstream becomes a seventh timer without an edit here."""
    f = os.path.join(source_dir or "", "vercel.json")
    if not (source_dir and os.path.isfile(f)): return list(CRONS)
    out = []
    for c in load(f).get("crons") or []:
        p = str(c.get("path", ""))
        m = re.fullmatch(r"/api/cron/([a-z0-9-]+)", p)
        if not m: raise Stop(f"{f} declares a cron at {p!r}, which is not an /api/cron/<name> route, so no timer can be written for it.")
        if not cron_to_oncalendar(str(c.get("schedule", ""))):
            raise Stop(f"{f} schedules {p} as {c.get('schedule')!r}; only every-minute and every-N-minutes schedules can be "
                       f"turned into a timer here. Add that shape to cron_to_oncalendar in .claude/scripts/lib/vm_remote.py.")
        out.append((m.group(1), c["schedule"]))
    return out

def unit_names(S, crons):
    svc = [f"{S['unit']}-{n}.service" for n in ("workflow", "api", "web")]
    tim = [f"{S['unit']}-cron-{n}.timer" for n, _ in crons]
    return svc, tim

SERVICE_COMMON = """[Service]
Type=simple
User=@USER@
Group=@USER@
EnvironmentFile=@ENV@
Environment=NODE_ENV=production
Environment=HOME=@DATA@/home
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
"""
def unit_files(S, crons):
    """name -> text for the three services, the egress rule's unit and one service + timer per cron. Each service reads
    its own env file (service_env_spec), never the master one."""
    u = {}; app = S["app_id"]; pre = S["unit"]
    common = lambda svc: fill(SERVICE_COMMON, USER=SERVICE_USER, ENV=S["env_files"][svc], DATA=S["data"])
    u[f"{pre}-workflow.service"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: task-workflow service (loopback only)
After=network-online.target postgresql.service
Wants=network-online.target

{common("workflow")}WorkingDirectory={S['app_dir']}/services/task-workflow
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p {PORTS['workflow']}

[Install]
WantedBy=multi-user.target
""")
    u[f"{pre}-api.service"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: eve agent API (loopback only; non-root, group kvm)
After=network-online.target postgresql.service {pre}-egress.service {pre}-workflow.service
Wants=network-online.target {pre}-egress.service

{common("api")}SupplementaryGroups=kvm
WorkingDirectory={S['app_dir']}
Environment=HOST=127.0.0.1
Environment=NITRO_HOST=127.0.0.1
Environment=PORT={PORTS['api']}
Environment=NITRO_PORT={PORTS['api']}
# Before the API serves: the mold's own `npm run sandbox:prewarm` clears template locks a killed start left behind (the
# next start hangs on them), refuses a data room the sandbox could not fetch, and builds the sandbox templates ONE AT
# A TIME (eve boots all of them at once, which failed on a 4-CPU host).
ExecStartPre=/bin/bash {S['factory_dir']}/api-prestart.sh
# The built server directly: `eve start` holds 2.3 GB for the life of the service.
ExecStart=/usr/bin/node .output/server/index.mjs
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
""")
    u[f"{pre}-web.service"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: web app (loopback only, behind Caddy)
After=network-online.target postgresql.service {pre}-api.service {pre}-workflow.service
Wants=network-online.target

{common("web")}WorkingDirectory={S['app_dir']}
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p {PORTS['web']}

[Install]
WantedBy=multi-user.target
""")
    u[f"{pre}-egress.service"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: keep the service user off the cloud metadata address and private networks
After=nftables.service
Before={pre}-api.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f {S['env_dir']}/egress.nft

[Install]
WantedBy=multi-user.target
""")
    for name, expr in crons:
        u[f"{pre}-cron-{name}.service"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: cron {name} (was Vercel Cron `{expr}`)
After={pre}-web.service

[Service]
Type=oneshot
User={SERVICE_USER}
Group={SERVICE_USER}
EnvironmentFile={S['env_files']['cron']}
ExecStart=/bin/bash {S['factory_dir']}/cron-call.sh {name}
TimeoutStartSec=115
NoNewPrivileges=yes
PrivateTmp=yes
""")
        u[f"{pre}-cron-{name}.timer"] = (fill(HEAD, APP=app) + f"""[Unit]
Description={app}: every `{expr}` call /api/cron/{name}

[Timer]
OnCalendar={cron_to_oncalendar(expr)}
AccuracySec=1s
Unit={pre}-cron-{name}.service

[Install]
WantedBy=timers.target
""")
    return u

def cron_call_sh(S, crons):
    routes = "|".join(n for n, _ in crons)
    return fill("""#!/bin/bash
@HEAD@# One cron route, called on loopback with the app's CRON_SECRET. The secret reaches curl on STDIN (a config
# line written by the shell's own printf), never on a command line another process could read.
set -eu
case "${1:-}" in
  @ROUTES@) ;;
  *) echo "not one of this app's cron routes: ${1:-}" >&2; exit 2 ;;
esac
: "${CRON_SECRET:?CRON_SECRET is not set in the cron env file}"
printf 'header = "Authorization: Bearer %s"\\n' "$CRON_SECRET" | /usr/bin/curl --silent --show-error --fail --max-time 110 --output /dev/null --config - "http://127.0.0.1:@PORT@/api/cron/$1"
""", HEAD=fill(HEAD, APP=S["app_id"]), ROUTES=routes, PORT=PORTS["web"])

def caddyfile(S):
    email = f"\temail {S['email']}\n" if S["email"] else ""
    return (fill(HEAD, APP=S["app_id"]) + "{\n" + email + "}\n\n" + f"""{S['domain_shown']} {{
	encode zstd gzip
	header {{
		Strict-Transport-Security "max-age=31536000"
		-Server
	}}
	# The six cron routes are called on loopback by this server's own timers; nobody outside needs them.
	@cron path /api/cron/*
	respond @cron 404
	# Everything goes to the web app, which keeps its session-ownership gate in front of /eve/v1/session/* and
	# forwards /eve/ and /.well-known/workflow/ to the API on loopback. The API and the task-workflow service
	# are never reachable from outside.
	reverse_proxy 127.0.0.1:{PORTS['web']} {{
		flush_interval -1
	}}
}}
""")

def egress_nft(S):
    nets = ", ".join(EGRESS_DENY)
    return (fill(HEAD, APP=S["app_id"]) + f"""# A second layer under the sandbox's own network policy (SANDBOX_DENY_SUBNETS): whatever runs as the service user,
# the agent's sandbox included, cannot open a connection to the cloud metadata address or a private network.
# Loopback is not listed: the services reach Postgres and each other there.
table inet sf_egress
delete table inet sf_egress
table inet sf_egress {{
	chain output {{
		type filter hook output priority 0; policy accept;
		meta skuid "{SERVICE_USER}" ip daddr {{ {nets} }} reject with icmpx type admin-prohibited
	}}
}}
""")

def ufw_rules(S):
    """The firewall's allow rules, in the words `ufw show added` prints them, sorted. The SSH rule takes its allowed
    source from state (vm_remote.ssh_allow_from): absent, the port is open to any address; named, only that address
    or network may reach it, which is how a private administration tunnel closes public SSH without another script."""
    web = [f"ufw allow {p}/tcp" for p in (80, 443)]
    ssh = (f"ufw allow from {S['ssh_allow_from']} to any port {S['port']} proto tcp" if S.get("ssh_allow_from") else f"ufw allow {S['port']}/tcp")
    return sorted(set(web + [ssh]))

def firewall_sh(S):
    rules = ufw_rules(S)
    return fill("""#!/bin/bash
@HEAD@# mold_v1-077. Run on the TARGET SERVER, as root, by provision.py --deploy-remote. Never on the factory VM.
#   - ufw: SSH (port @SSH@, from @SSHFROM@), 80 and 443 in; everything else in is refused. Nothing else is opened, ever.
#   - fail2ban watches ssh.
#   - the app's three services listen on 127.0.0.1 only (their unit files say so; health.sh checks it), so the
#     only things answering the internet are sshd and Caddy.
#   - the sandbox deny list: SANDBOX_DENY_SUBNETS in the env file is the first layer; the nftables rule installed
#     here is the second, for everything the service user runs.
#   - no Docker conntrack rule: that rule exists for Docker-published ports and there is no Docker on this server.
set -eu
@GUARD@export LC_ALL=C
if command -v docker >/dev/null 2>&1; then
  echo "refusing: Docker is installed on this server and would open ports behind this firewall. Use a server without it." >&2; exit 4
fi
want="$(printf '%s\\n' @RULES@)"
have="$(ufw show added 2>/dev/null | grep '^ufw ' | sort || true)"
if [ "$have" != "$want" ] || ! ufw status | grep -q '^Status: active'; then
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  ufw default deny routed
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
install -m 600 @FACTORY@/egress.nft @ENVDIR@/egress.nft
/usr/sbin/nft -c -f @ENVDIR@/egress.nft
install -m 644 @FACTORY@/units/@UNIT@-egress.service /etc/systemd/system/@UNIT@-egress.service
systemctl daemon-reload
systemctl enable @UNIT@-egress.service >/dev/null
systemctl restart @UNIT@-egress.service
echo "firewall: fail2ban on for ssh; egress rule for @USER@ loaded"
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), SSH=S["port"], SSHFROM=S["ssh_allow_from"] or "any address",
        RULES=" ".join(shlex.quote(r) for r in rules), ALLOWS="\n".join("  " + r for r in rules),
        PORTS=", ".join(str(p) for p in sorted({S["port"], 80, 443})) + (f" (SSH from {S['ssh_allow_from']} only)" if S["ssh_allow_from"] else ""), FACTORY=S["factory_dir"], ENVDIR=S["env_dir"],
        UNIT=S["unit"], USER=SERVICE_USER)

def fail2ban_jail(S):
    return (fill(HEAD, APP=S["app_id"]) + f"""[sshd]
enabled = true
port = {S['port']}
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
""")

def packages_sh(S):
    v = S["pg"]["version"]
    return fill("""#!/bin/bash
@HEAD@# What the server needs before the app can be built on it. Safe to run again: every part checks first.
set -eu
@GUARD@export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg rsync ufw fail2ban nftables python3 openssl build-essential ssl-cert
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v24" ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
if [ ! -d /usr/lib/postgresql/@PGV@ ]; then
  if ! apt-cache show postgresql-@PGV@ >/dev/null 2>&1; then
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
    . /etc/os-release
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -q
  fi
  apt-get install -y -q postgresql-@PGV@
fi
getent group kvm >/dev/null || groupadd --system kvm
id @USER@ >/dev/null 2>&1 || useradd --system --user-group --home-dir @DATA@/home --no-create-home --shell /usr/sbin/nologin @USER@
install -d -m 755 /opt/software-factory @INSTALL@ @FACTORY@
install -d -m 750 -o @USER@ -g @USER@ @APPDIR@ @DATA@ @DATA@/home @DATA@/workflow-data @DATA@/task-workflow-data @DATA@/storage @DATA@/build-stamps
install -d -m 700 /etc/software-factory @ENVDIR@
echo "packages: node $(node -v), $(caddy version | cut -d' ' -f1), postgresql @PGV@, service user @USER@"
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), PGV=v, USER=SERVICE_USER, DATA=S["data"],
        INSTALL=S["install"], FACTORY=S["factory_dir"], APPDIR=S["app_dir"], ENVDIR=S["env_dir"])

def postgres_sh(S):
    v = S["pg"]["version"]
    return fill("""#!/bin/bash
@HEAD@# The app's own Postgres cluster: 127.0.0.1 only, TLS @TLS@. The admin password is minted here, on the server,
# straight into the env file; it is never printed and never leaves this machine.
set -eu
@GUARD@install -d -m 755 /etc/postgresql/@PGV@/main/conf.d
cat > /etc/postgresql/@PGV@/main/conf.d/software-factory.conf <<'CONF'
listen_addresses = '127.0.0.1'
port = @PORT@
ssl = @SSL@
password_encryption = 'scram-sha-256'
CONF
systemctl enable postgresql >/dev/null
systemctl restart postgresql
for i in 1 2 3 4 5 6 7 8 9 10; do pg_isready -q -h 127.0.0.1 -p @PORT@ && break; sleep 2; done
pg_isready -q -h 127.0.0.1 -p @PORT@
python3 @TOOL@ pg-admin --file @ENV@ --db @DB@ --port @PORT@ --sslmode @SSLMODE@
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), PGV=v, PORT=S["pg"]["port"],
        TLS="on (self-signed; the mold's migration scripts require TLS and do not verify the certificate)" if S["pg"]["tls"] == "on" else "off (the mold's migration switch is set instead)",
        SSL="on" if S["pg"]["tls"] == "on" else "off", TOOL=S["tool"], ENV=S["env_file"], DB=S["pg"]["db"], SSLMODE=S["sslmode"])

def env_split_cmd(S):
    return f"python3 {S['tool']} env-split --file {S['env_file']} --spec {S['factory_dir']}/env-services.json"

def build_sh(S, crons):
    svc, tim = unit_names(S, crons)
    run = lambda k: f"python3 {S['tool']} env-run --file {S['env_files'][k]} --user {SERVICE_USER} --home {S['data']}/home --cwd"
    return fill("""#!/bin/bash
@HEAD@# Build IN PLACE at the final path: the eve build embeds absolute paths and cannot be moved afterwards.
# One build at a time (each peaks at 2-3 GB on an 8 GB machine). The services are stopped first, because the
# build rewrites the directories they run from; they come back in units.sh. Each part is built with the env file
# of the service that runs it, so build and run see the same names (the agent's has no private key).
set -eu
@GUARD@for u in @TIMERS@ @SERVICES@; do systemctl stop "$u" 2>/dev/null || true; done
@SPLIT@
chown -R @USER@:@USER@ @APPDIR@
RUN_API="@RUN_API@"
RUN_WEB="@RUN_WEB@"
RUN_WF="@RUN_WF@"
lock_now="$(sha256sum @APPDIR@/package-lock.json | cut -d' ' -f1)"
if [ ! -d @APPDIR@/node_modules ] || [ "$(cat @DATA@/build-stamps/app.lock 2>/dev/null || true)" != "$lock_now" ]; then
  # devDependencies included: the sandbox runtime (microsandbox) is one of them.
  $RUN_API @APPDIR@ -- npm ci --include=dev --no-audit --no-fund
  echo "$lock_now" > @DATA@/build-stamps/app.lock
fi
$RUN_API @APPDIR@ -- npm run build:eve
test -f @APPDIR@/.output/server/index.mjs
$RUN_WEB @APPDIR@ -- npm run build
lock_now="$(sha256sum @APPDIR@/services/task-workflow/package-lock.json | cut -d' ' -f1)"
if [ ! -d @APPDIR@/services/task-workflow/node_modules ] || [ "$(cat @DATA@/build-stamps/workflow.lock 2>/dev/null || true)" != "$lock_now" ]; then
  $RUN_WF @APPDIR@/services/task-workflow -- npm ci --include=dev --no-audit --no-fund
  echo "$lock_now" > @DATA@/build-stamps/workflow.lock
fi
$RUN_WF @APPDIR@/services/task-workflow -- npm run build
echo "build: eve API, web app and task-workflow service built at @APPDIR@"
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), TIMERS=" ".join(tim), SERVICES=" ".join(reversed(svc)),
        USER=SERVICE_USER, APPDIR=S["app_dir"], DATA=S["data"], SPLIT=env_split_cmd(S), RUN_API=run("api"), RUN_WEB=run("web"), RUN_WF=run("workflow"))

def db_chain_sh(S):
    return fill("""#!/bin/bash
@HEAD@# The database safety chain, on the server, with the URLs read from the env file here (they never cross SSH).
# It is provision.py's own chain: hold, journal, drift dry run that refuses data loss, RLS bootstrap, coverage,
# release, isolation proof; DATABASE_URL is written only after the proof, then passed on to the services' own files.
set -eu
@GUARD@python3 @TOOL@ host-chain --app-dir @APPDIR@ --env-file @ENV@ --mode @MODE@ --sslmode @SSLMODE@
@SPLIT@
chown -R @USER@:@USER@ @APPDIR@
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), TOOL=S["tool"], APPDIR=S["app_dir"],
        ENV=S["env_file"], MODE=S["mode"], SSLMODE=S["sslmode"], USER=SERVICE_USER, SPLIT=env_split_cmd(S))

def api_prestart_sh(S):
    return fill("""#!/bin/bash
@HEAD@# Runs as the service user (group kvm), with the API's own env file, before the API starts. It deletes nothing itself.
set -eu
[ -c /dev/kvm ] || { echo "no /dev/kvm on this server: the sandbox cannot start" >&2; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "the service user cannot open /dev/kvm (is it in group kvm?)" >&2; exit 1; }
# The mold's own prewarm (fde-agent #100, docs/self-hosting/SANDBOX.md), which does what this file used to do, better:
#   - removes only template locks whose owner process is gone (a held one stops it, naming the process);
#   - --link-runtime: links the microsandbox runtime npm already installed into ~/.microsandbox (no download);
#   - resolves STORAGE_PUBLIC_URL and refuses if the sandbox deny list holds any address it leads to, so the API never
#     starts with a data room its sandboxes cannot fetch;
#   - builds the templates one at a time, each tried @TRIES@ times; exit 1 if any is missing at the end.
cd @APPDIR@
exec /usr/bin/npm run --silent sandbox:prewarm -- --link-runtime --retries @RETRIES@
""", HEAD=fill(HEAD, APP=S["app_id"]), APPDIR=S["app_dir"], TRIES=PREWARM_RETRIES + 1, RETRIES=PREWARM_RETRIES)

# Extra tries per template (the mold allows 0-5). One microVM boot in about fourteen timed out on nested KVM in the
# spike (reports/vm-spike-mold_v1-072.md), so three tries in all, as the factory's own prewarm used to do.
PREWARM_RETRIES = 2

def units_sh(S, crons):
    svc, tim = unit_names(S, crons)
    return fill("""#!/bin/bash
@HEAD@# Install and (re)start the three services and the cron timers. The API's start includes the sandbox prewarm,
# so the first one can take several minutes.
set -eu
@GUARD@for f in @FACTORY@/units/*; do install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"; done
systemctl daemon-reload
systemctl enable @SERVICES@ >/dev/null
for u in @SERVICES@; do
  systemctl restart "$u" || { echo "service $u did not start. Its last lines:" >&2; journalctl -u "$u" -n 30 --no-pager >&2; exit 1; }
done
systemctl enable --now @TIMERS@ >/dev/null
echo "units: @NS@ services running, @NT@ cron timers on"
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), FACTORY=S["factory_dir"],
        SERVICES=" ".join(svc), TIMERS=" ".join(tim), NS=len(svc), NT=len(tim))

def caddy_sh(S):
    return fill("""#!/bin/bash
@HEAD@# TLS for @DOMAIN@. Caddy gets and renews the certificate by itself once the domain points at this server.
set -eu
@GUARD@caddy validate --adapter caddyfile --config @FACTORY@/Caddyfile >/dev/null
install -m 644 @FACTORY@/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy
echo "caddy: serving @DOMAIN@"
""", HEAD=fill(HEAD, APP=S["app_id"]), GUARD=fill(GUARD, APP=S["app_id"]), FACTORY=S["factory_dir"], DOMAIN=S["domain_shown"])

def health_sh(S, crons):
    return fill("""#!/bin/bash
@HEAD@# READ-ONLY. What is true on the server right now, one KEY=VALUE per line.
# A service that was started a second ago may not be listening yet: ask for up to a minute before saying "no answer".
code() {
  c=000
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    c="$(curl --silent --output /dev/null --max-time 25 --write-out '%{http_code}' "$1" 2>/dev/null || true)"
    [ -n "$c" ] && [ "$c" != "000" ] && break
    sleep 5
  done
  echo "${c:-000}"
}
echo "WORKFLOW=$(code http://127.0.0.1:@PW@/api/health)"
echo "API=$(code http://127.0.0.1:@PA@/eve/v1/health)"
echo "WEB=$(code http://127.0.0.1:@PWEB@/api/ops/health)"
if [ -c /dev/kvm ]; then echo "KVM=present"; else echo "KVM=absent"; fi
pid="$(systemctl show -p MainPID --value @UNIT@-api.service 2>/dev/null || echo 0)"
kgid="$(getent group kvm | cut -d: -f3)"
if [ -n "$pid" ] && [ "$pid" != "0" ] && [ -n "$kgid" ] && grep -E "^Groups:.*(^|[[:space:]])$kgid([[:space:]]|$)" "/proc/$pid/status" >/dev/null 2>&1; then echo "API_IN_KVM=yes"; else echo "API_IN_KVM=no"; fi
if [ -n "$pid" ] && [ "$pid" != "0" ]; then echo "API_USER=$(ps -o user= -p "$pid" | tr -d ' ')"; else echo "API_USER=none"; fi
echo "PUBLIC_LISTENERS=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -v -E '^(127\\.|\\[::1\\]|\\[::ffff:127\\.)' | sed -E 's/.*:([0-9]+)$/\\1/' | sort -un | tr '\\n' ' ')"
echo "TIMERS=$(systemctl list-timers --all --no-legend '@UNIT@-cron-*' 2>/dev/null | grep -c . || true)"
echo "UFW=$(ufw status 2>/dev/null | head -1 | sed 's/^Status: //')"
echo "ENV_MODE=$(stat -c '%a %U' @ENV@ 2>/dev/null || echo missing)"
echo "ENV_FILES=$(for s in @SVCS@; do printf '%s=%s ' "$s" "$(stat -c '%a-%U' "@ENVDIR@/$s.env" 2>/dev/null || echo missing)"; done)"
# Names only: does the RUNNING agent hold the sign-in private key? (yes/no; nothing else is read out)
if [ -n "$pid" ] && [ "$pid" != "0" ] && [ -r "/proc/$pid/environ" ]; then
  if tr '\\0' '\\n' < "/proc/$pid/environ" | grep -q '^AUTH_JWT_PRIVATE_KEY='; then echo "API_PRIVATE_KEY=yes"; else echo "API_PRIVATE_KEY=no"; fi
else echo "API_PRIVATE_KEY=unread"; fi
""", HEAD=fill(HEAD, APP=S["app_id"]), PW=PORTS["workflow"], PA=PORTS["api"], PWEB=PORTS["web"], UNIT=S["unit"], ENV=S["env_file"],
        ENVDIR=S["env_dir"], SVCS=" ".join(S["env_files"]))

def health_verdict(S, facts, crons):
    """(health block for state, problems). Problems are plain sentences; any one of them fails the deploy."""
    h = {k: (facts.get(K) if facts.get(K) not in (None, "", "000") else "no answer") for k, K in (("workflow", "WORKFLOW"), ("api", "API"), ("web", "WEB"))}
    bad = []
    if facts.get("KVM") != "present": h["kvm"] = "device_missing"; bad.append("the server no longer shows /dev/kvm, so no sandbox can start")
    elif facts.get("API_IN_KVM") != "yes": h["kvm"] = "api_not_in_kvm_group"; bad.append("the API process is not in group kvm, so it cannot start a sandbox")
    else: h["kvm"] = "ok"
    if facts.get("API_USER") in ("root", None, ""): bad.append(f"the API runs as {facts.get('API_USER') or 'nobody we could read'}, and it must run as the non-root user {SERVICE_USER}")
    for k in ("workflow", "api"):
        if h[k] != "200": bad.append(f"the {k} service answered {h[k]} on the server itself")
    if h["web"] == "no answer": bad.append("the web app did not answer on the server itself")
    allowed = {str(S["port"]), "80", "443"}
    extra = [p for p in (facts.get("PUBLIC_LISTENERS") or "").split() if p not in allowed]
    if extra: bad.append(f"something on the server listens to the internet on port(s) {', '.join(extra)}; only {', '.join(sorted(allowed, key=int))} may")
    if facts.get("UFW") != "active": bad.append("the firewall is not active")
    try: nt = int(facts.get("TIMERS") or 0)
    except ValueError: nt = 0
    if nt != len(crons): bad.append(f"{nt} of {len(crons)} cron timers are installed")
    if facts.get("ENV_MODE") != "600 root": bad.append(f"the env file is {facts.get('ENV_MODE')!r}, and it must be mode 600 owned by root")
    files = dict(x.split("=", 1) for x in (facts.get("ENV_FILES") or "").split() if "=" in x)
    wrong = [f"{k}.env is {files.get(k, 'missing')}" for k in S["env_files"] if files.get(k) != "600-root"]
    if wrong: bad.append(f"each service's env file must be mode 600 owned by root, but {', '.join(wrong)}")
    if facts.get("API_PRIVATE_KEY") != "no":
        bad.append("the agent API process holds the sign-in private key (AUTH_JWT_PRIVATE_KEY), or it could not be read; only the web app may"
                   if facts.get("API_PRIVATE_KEY") == "yes" else "whether the agent API holds the sign-in private key could not be read")
    return h, bad

# ---------------------------------------------------------------------------------------------------------
# the bundle and the plan
# ---------------------------------------------------------------------------------------------------------
def bundle(S, crons):
    """relative path -> (text, mode): everything generated for the server. Pure; writes nothing."""
    b = {"qualify.sh": (QUALIFY_SH, 0o755), "packages.sh": (packages_sh(S), 0o755), "firewall.sh": (firewall_sh(S), 0o755),
         "postgres.sh": (postgres_sh(S), 0o755), "build.sh": (build_sh(S, crons), 0o755), "db-chain.sh": (db_chain_sh(S), 0o755),
         "units.sh": (units_sh(S, crons), 0o755), "caddy.sh": (caddy_sh(S), 0o755), "health.sh": (health_sh(S, crons), 0o755),
         "api-prestart.sh": (api_prestart_sh(S), 0o755), "cron-call.sh": (cron_call_sh(S, crons), 0o755),
         "env-services.json": (json.dumps(service_env_spec(S), indent=2, sort_keys=True) + "\n", 0o644),
         "Caddyfile": (caddyfile(S), 0o644), "egress.nft": (egress_nft(S), 0o644),
         "fail2ban-sshd.local": (fail2ban_jail(S), 0o644)}
    for name, text in unit_files(S, crons).items(): b[f"units/{name}"] = (text, 0o644)
    return b
def bundle_copies():
    """The factory's own database tooling, copied verbatim so the server runs the same chain this VM does."""
    out = [(os.path.join(SCRIPTS, "provision.py"), ".claude/scripts/provision.py"), (os.path.abspath(__file__), ".claude/scripts/lib/vm_remote.py")]
    for f in sorted(os.listdir(HERE)):
        if f.endswith(".mjs"): out.append((os.path.join(HERE, f), f".claude/scripts/lib/{f}"))
    return out
def write_bundle(S, crons, out_dir):
    for rel, (text, mode) in bundle(S, crons).items():
        p = os.path.join(out_dir, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f: f.write(text)
        os.chmod(p, mode)
    for src, rel in bundle_copies():
        p = os.path.join(out_dir, rel); os.makedirs(os.path.dirname(p), exist_ok=True); shutil.copyfile(src, p)
    return out_dir

def plan(S, source_dir, bundle_dir="<bundle>", shown=True):
    """Every step of a deploy, in order: id, what it is for, the exact local command, what goes on its stdin and
    which generated script it runs. The dry run prints this list; the deploy executes this list. One list."""
    F = S["factory_dir"]; ssh = lambda cmd: ssh_argv(S, cmd, shown)
    tool = f"python3 {S['tool']}"
    return [
      {"id": "qualify", "title": "Is the server fit? (read-only probe; refuses in plain words if not)", "argv": ssh("sh -s"), "stdin": "script:qualify.sh", "script": "qualify.sh", "timeout": 120},
      {"id": "dns", "title": f"Does {S['domain_shown']} point at the server? (looked up on this VM; nothing is sent to the server)", "local": "dns", "timeout": 30},
      {"id": "mkdir", "title": "Make the install directory", "argv": ssh(guarded(S, f"install -d -m 755 {S['install']} {F}")), "timeout": 60},
      {"id": "bundle", "title": "Copy the generated scripts, unit files, Caddyfile and the database tooling", "argv": rsync_argv(S, bundle_dir, F, shown=shown), "timeout": 300},
      {"id": "packages", "title": "Install Node 24, Caddy, PostgreSQL, ufw, fail2ban, nftables; create the service user", "argv": ssh(guarded(S, f"bash {F}/packages.sh")), "script": "packages.sh", "timeout": 1800},
      {"id": "firewall", "title": f"Firewall: ports {S['port']}, 80, 443 only; fail2ban for ssh; the egress rule for the service user", "argv": ssh(guarded(S, f"bash {F}/firewall.sh")), "script": "firewall.sh", "timeout": 300},
      {"id": "postgres", "title": "PostgreSQL on 127.0.0.1 with TLS; the admin password is minted on the server", "argv": ssh(guarded(S, f"bash {F}/postgres.sh")), "script": "postgres.sh", "timeout": 600},
      {"id": "env-config", "title": "Master env file (root, mode 600): the settings derived from state", "argv": ssh(guarded(S, f"{tool} env-merge --file {S['env_file']}")), "stdin": "config", "timeout": 60},
      {"id": "env-mint", "title": "Master env file: mint the app's own internal secrets on the server (kept if already there)", "argv": ssh(guarded(S, f"{tool} env-mint --file {S['env_file']}")), "timeout": 120},
      {"id": "env-names", "title": "Env file: which NAMES are present (names only; no value is read back)", "argv": ssh(f"{S['sudo']}{tool} env-names --file {S['env_file']}"), "timeout": 60},
      {"id": "env-secrets", "title": "Env file: the values only the operator holds, from a hidden prompt, sent on stdin", "argv": ssh(guarded(S, f"{tool} env-merge --file {S['env_file']}")), "stdin": "secrets", "timeout": 60},
      {"id": "source", "title": "Copy the SOURCE (never a build) to its final path", "argv": rsync_argv(S, source_dir, S["app_dir"], SOURCE_EXCLUDES, shown=shown), "timeout": 1800},
      {"id": "build", "title": "Stop the services, split each service's own env file from the master, then build in place: eve API, web app, task-workflow, one at a time", "argv": ssh(guarded(S, f"bash {F}/build.sh")), "script": "build.sh", "timeout": 5400},
      {"id": "db-chain", "title": "Database: hold, journal, drift dry run refusing data loss, RLS bootstrap, coverage, release, isolation proof; then the services' env files again", "argv": ssh(guarded(S, f"bash {F}/db-chain.sh")), "script": "db-chain.sh", "timeout": 3600},
      {"id": "units", "title": "Three systemd services (API as a non-root user in group kvm, prewarm before start) and the cron timers", "argv": ssh(guarded(S, f"bash {F}/units.sh")), "script": "units.sh", "timeout": 2700},
      {"id": "caddy", "title": f"Caddy: TLS for {S['domain_shown']}, everything proxied to the web app on loopback", "argv": ssh(guarded(S, f"bash {F}/caddy.sh")), "script": "caddy.sh", "timeout": 300},
      {"id": "health", "title": "Health on the server: three endpoints, /dev/kvm, the API's user and groups, listeners, timers", "argv": ssh(f"{S['sudo']}bash {F}/health.sh"), "script": "health.sh", "timeout": 180},
      {"id": "health-public", "title": f"Health from outside: {S['url']}/api/ops/health and {S['url']}/eve/v1/health (the same read the Vercel path gates on)", "local": "health-public", "timeout": 120},
    ]

def mold_gaps(source_dir):
    """Which of the off-Vercel switches, and of the mold's own scripts the deploy runs, the source being shipped does
    not contain. Read-only."""
    try: scripts = (load(os.path.join(source_dir, "package.json")).get("scripts") or {})
    except (OSError, ValueError): scripts = {}
    missing_scripts = [(n, what, where) for n, what, where in MOLD_SCRIPTS if n not in scripts]
    return _switch_gaps(source_dir) + missing_scripts

def _switch_gaps(source_dir):
    want = {n for n, _, _ in MOLD_SWITCHES}; seen = set()
    for top in ("agent", "lib", "app", "scripts", "services"):
        for d, dirs, files in os.walk(os.path.join(source_dir, top)):
            dirs[:] = [x for x in dirs if x not in ("node_modules", ".next", ".output", ".eve", "test-results")]
            for f in files:
                if not f.endswith((".ts", ".tsx", ".mjs", ".js")): continue
                try: text = open(os.path.join(d, f), errors="ignore").read()
                except OSError: continue
                seen |= {n for n in want - seen if n in text}
            if seen == want: return []
    return [(n, what, where) for n, what, where in MOLD_SWITCHES if n not in seen]

def print_plan(S, steps, B, crons, gaps, out=print):
    out(f"DRY RUN for {S['app_id']}: nothing below was run and nothing was contacted.")
    out(f"  server {S['host'] or NO_HOST}" + (f" (SSH through {S['ssh_host']})" if S["ssh_host"] else "") + f" as {S['user']} on port {S['port']}, key name {S['key_ref']} ({key_shown(S)}); "
        f"domain {S['domain_shown']}; install path {S['install']}")
    if not S["host"] or not S["domain"]:
        out(f"  the server address and/or the domain are not in state yet, so a placeholder stands in. Supply them with: "
            f"python3 .claude/scripts/provision.py {S['app_id']} --set-remote host=<address> domain=<name>")
    for n, what, where in gaps:
        out(f"  NOT READY: the app's code does not yet contain {n} ({what}); that is {where}. A real deploy refuses until it does.")
    out(f"  the operator will be asked (hidden) for whichever of these the server does not hold yet: {', '.join(operator_names(S)) or 'nothing'}")
    out(f"  minted on the server, never here: {', '.join(SERVER_MADE)}")
    out("")
    for i, st in enumerate(steps, 1):
        out(f"[{i:02d} {st['id']}] {st['title']}")
        if st.get("local") == "dns":
            out(f"    (local) resolve {S['domain_shown']} and compare it with {S['host'] or NO_HOST}")
        elif st.get("local") == "health-public":
            out(f"    (local) curl --silent --max-time 20 {S['url']}/api/ops/health")
            out(f"    (local) curl --silent --max-time 20 {S['url']}/eve/v1/health")
        else:
            out("    $ " + shown_cmd(S, st["argv"]))
        if st.get("stdin") == "config":
            out("    stdin (settings, not secrets):")
            for k, v in sorted(config_pairs(S).items()): out(f"      | {k}={v}")
        elif st.get("stdin") == "secrets":
            out("    stdin: one NAME=<value typed at the hidden prompt> line per missing name; the values are never printed, logged or put on a command line")
        elif st.get("stdin", "").startswith("script:"):
            out(f"    stdin: the script below")
        if st.get("script"):
            out(f"    remote script factory/{st['script']}:")
            for line in B[st["script"]][0].rstrip("\n").split("\n"): out("      | " + line)
        out("")
    extras = sorted(k for k in B if k not in {st.get("script") for st in steps})
    out("Generated files the scripts above install or run:")
    for k in extras:
        out(f"  --- factory/{k}")
        for line in B[k][0].rstrip("\n").split("\n"): out("      | " + line)
    out("")
    out("Copied verbatim to factory/ so the server runs the factory's own database chain: " + ", ".join(rel for _, rel in bundle_copies()))
    out(f"After the last step: state/application/{S['app_id']}/infrastructure.json gets vm_remote.production_url, vm_remote.health and "
        f"deployed_at; datastores.json gets postgres.rls_verified; application.json status becomes stamped (or reverted, with the reason).")
    out(f"{len(steps)} steps, {len(crons)} cron timers, 3 services. DRY RUN: nothing was run and nothing was contacted.")

# ---------------------------------------------------------------------------------------------------------
# running it
# ---------------------------------------------------------------------------------------------------------
REDACT = [(re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@\"']*:[^\s/@\"']*@"), r"\1***:***@"),
          (re.compile(r"(?i)\b(bearer\s+)[^\s\"']+"), r"\1***")]
def redact(s):
    for rx, rep in REDACT: s = rx.sub(rep, s or "")
    return s

def real_runner(step, stdin_text=None):
    """One local command with a deadline, its own process group, and stdin from memory (never a file, never argv)."""
    p = subprocess.Popen(step["argv"], stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try: out, err = p.communicate(input=stdin_text, timeout=step.get("timeout", 300))
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, 9)
        except (ProcessLookupError, PermissionError): pass
        raise Stop(f"step {step['id']} did not finish within {step.get('timeout', 300)}s and was stopped. Nothing after it ran. "
                   f"It is safe to run the deploy again.")
    return subprocess.CompletedProcess(step["argv"], p.returncode, out, err)

def resolve(domain):
    try: return sorted({x[4][0] for x in socket.getaddrinfo(domain, 443, proto=socket.IPPROTO_TCP)})
    except OSError: return []

def dns_problem(S, resolver=resolve):
    got = resolver(S["domain"])
    want = [S["host"]] if re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]+", S["host"]) else resolver(S["host"])
    if not got:
        return (f"{S['domain']} does not lead anywhere yet. Add an A record for it that points at {S['host']} where the domain is "
                f"managed (docs/RUNBOOK.md, \"Point the domain at the server\"), wait a few minutes, and run this again. "
                f"Nothing was installed.")
    if not set(got) & set(want):
        return (f"{S['domain']} points at {', '.join(got)}, not at this app's server ({S['host']}). Change its A record to "
                f"{S['host']} where the domain is managed, wait a few minutes, and run this again. Nothing was installed.")
    return None

def deploy(S, source_dir, crons, runner=real_runner, secrets_for=None, resolver=resolve, read_health=None, say=print, bundle_dir=None, on_started=None, wait=time.sleep):
    """Run the plan. Returns {"health", "evidence", "running", "facts"}; raises Stop with one instruction otherwise.
    `runner`, `secrets_for`, `resolver` and `read_health` are injected so the whole sequence runs offline in the
    self-test against recorded answers."""
    own = bundle_dir is None
    bundle_dir = bundle_dir or tempfile.mkdtemp(prefix="sf-vm-remote-")
    try:
        write_bundle(S, crons, bundle_dir)
        B = bundle(S, crons); steps = {s["id"]: s for s in plan(S, source_dir, bundle_dir, shown=False)}
        def run(sid, stdin=None, quiet=False):
            st = steps[sid]; say(f"[{sid}] {st['title']}")
            r = runner(st, stdin)
            tail = [l for l in redact((r.stdout or "")).splitlines() if l.strip()]
            if not quiet:
                for l in tail[-8:]: say("    " + l[:220])
            if r.returncode:
                err = [l for l in redact((r.stderr or "") + "\n" + (r.stdout or "")).splitlines() if l.strip()]
                raise Stop(f"step {sid} stopped (exit {r.returncode}): " + " / ".join(err[-4:])[:600] +
                           f"\n  Every step is safe to run again: python3 .claude/scripts/provision.py {S['app_id']} --deploy-remote")
            return r
        facts = parse_kv(run("qualify", B["qualify.sh"][0], quiet=True).stdout)
        problems = qualify(facts)
        if problems: raise Stop("This server cannot run the app:\n  - " + "\n  - ".join(problems))
        say(f"    fit: {facts['OS_ID']} {facts['OS_VERSION']}, {facts['VCPU']} CPUs, {round(int(facts['MEM_KB']) / 1048576, 1)} GB, "
            f"{round(int(facts['DISK_FREE_KB']) / 1048576)} GB free, /dev/kvm present, no Docker, no other web server")
        say(f"[dns] {steps['dns']['title']}")
        why = dns_problem(S, resolver)
        if why: raise Stop(why)
        why = sandbox_conflict(S, resolver(S["domain"]))
        if why: raise Stop(why + " Nothing was installed.")
        if on_started: on_started()      # everything above only read; from here the server is changed
        for sid in ("mkdir", "bundle", "packages", "firewall", "postgres"): run(sid)
        run("env-config", "".join(f"{k}={v}\n" for k, v in sorted(config_pairs(S).items())))
        run("env-mint")
        have = set(run("env-names", quiet=True).stdout.split())
        missing = [n for n in operator_names(S) if n not in have]
        if missing:
            vals = (secrets_for or (lambda names: collect_secrets(S["app_id"], names)))(missing)
            lack = [n for n in missing if not vals.get(n)]
            if lack: raise Stop(f"{', '.join(lack)} still missing, so the app could not run. Nothing was built. Run the deploy again when you have them.")
            run("env-secrets", "".join(f"{k}={v}\n" for k, v in vals.items()), quiet=True)
            say(f"    {len(vals)} value(s) stored on the server (not shown): {', '.join(sorted(vals))}")
            del vals
        else:
            say("[env-secrets] nothing to ask: the server already holds every value only you can supply")
        for sid in ("source", "build"): run(sid)
        r = run("db-chain")
        ev = next((json.loads(l[len("EVIDENCE "):]) for l in r.stdout.splitlines() if l.startswith("EVIDENCE {")), None)
        if S["mode"] != "off" and not ev:
            raise Stop("the database step ended without an isolation proof, so tenant isolation is not known. Nothing was started. "
                       f"Run the deploy again: python3 .claude/scripts/provision.py {S['app_id']} --deploy-remote")
        for sid in ("units", "caddy"): run(sid)
        hf = parse_kv(run("health", quiet=True).stdout)
        health, bad = health_verdict(S, hf, crons)
        say(f"[health-public] {steps['health-public']['title']}")
        rh = read_health or _read_health
        # On a first deploy Caddy is still fetching the certificate: give the outside read ninety seconds before
        # calling it unanswered. A body that answers, whatever it says, ends the wait.
        for attempt in range(10):
            public = rh(f"{S['url']}/api/ops/health")
            if public[0] or attempt == 9: break
            wait(10)
        api_code = rh(f"{S['url']}/eve/v1/health")[0]
        if api_code != "200": bad.append(f"the agent API did not answer through {S['url']}/eve/v1/health (got {api_code or 'no answer'})")
        return {"health": health, "problems": bad, "evidence": ev, "facts": facts, "public": public}
    finally:
        if own: shutil.rmtree(bundle_dir, ignore_errors=True)

def _read_health(url):
    sys.path.insert(0, SCRIPTS); import provision
    return provision._read_health(url)

# ---------------------------------------------------------------------------------------------------------
# on the server
# ---------------------------------------------------------------------------------------------------------
def pg_admin(env_file, db, port, sslmode, psql=None):
    """Create the admin role and the database once, with a password minted here, and write POSTGRES_ADMIN_URL.
    The SQL (and so the password) reaches psql on STDIN. Present already: kept, nothing rotated."""
    if env_read(env_file).get("POSTGRES_ADMIN_URL"):
        print("postgres: the admin role is already set up (kept; no password was rotated)"); return False
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", db): sys.exit(f"postgres: {db!r} is not a usable database name")
    pw = pysecrets.token_hex(24)
    psql = psql or (lambda sql: subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-p", str(port), "-qAt"],
                                               input=sql, capture_output=True, text=True))
    r = psql("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sfadmin') THEN "
             f"CREATE ROLE sfadmin LOGIN SUPERUSER PASSWORD '{pw}'; ELSE ALTER ROLE sfadmin LOGIN SUPERUSER PASSWORD '{pw}'; END IF; END $$;\n")
    if r.returncode: sys.exit("postgres: could not create the admin role: " + (r.stderr or "").replace(pw, "***").strip()[-300:])
    r = psql(f"SELECT 1 FROM pg_database WHERE datname = '{db}';\n")
    if r.returncode: sys.exit("postgres: could not list databases: " + (r.stderr or "").strip()[-300:])
    if not (r.stdout or "").strip():
        r = psql(f"CREATE DATABASE {db} OWNER sfadmin;\n")
        if r.returncode: sys.exit("postgres: could not create the database: " + (r.stderr or "").strip()[-300:])
    env_merge(env_file, {"POSTGRES_ADMIN_URL": f"postgresql://sfadmin:{pw}@127.0.0.1:{port}/{db}?sslmode={sslmode}"})
    print(f"postgres: database {db} and its admin role created; POSTGRES_ADMIN_URL written to the env file (not shown)")
    return True

def retarget(app_url, admin_url, sslmode):
    """The app_rw URL the mold's bootstrap wrote, moved onto the host and port that answer here. The bootstrap
    forces port 6543 (Supabase's pooler); this server's Postgres is wherever the admin URL says."""
    a, b = urllib.parse.urlsplit(app_url), urllib.parse.urlsplit(admin_url)
    q = dict(urllib.parse.parse_qsl(a.query)); q["sslmode"] = sslmode
    userinfo = a.netloc.rsplit("@", 1)[0] if "@" in a.netloc else ""
    host = b.netloc.rsplit("@", 1)[-1]
    return urllib.parse.urlunsplit((a.scheme, f"{userinfo}@{host}" if userinfo else host, a.path, urllib.parse.urlencode(q), a.fragment))

def host_chain(app_dir, env_file, mode, sslmode, measure_only=False, repair=True, P=None, sh=None, run=None):
    """provision.py's schema chain, on the server, against the server's own database.

    The same SCHEMA_CHAIN, run by the same _run_chain, with the same step functions the Vercel path and
    --verify-db use (push_schema, apply_drift, _window, _rls_cover, _verify_app_rw); only where a command runs
    differs. Both URLs come from the env file on this machine. DATABASE_URL is written after the proof, never
    before. Prints one `EVIDENCE {...}` line (role names, flags and counts; no credential)."""
    if P is None:
        sys.path.insert(0, SCRIPTS); import provision as P
    vals = env_read(env_file); adm = vals.get("POSTGRES_ADMIN_URL", "")
    hint = "run the deploy again from the factory"
    if not adm: sys.exit(f"the env file has no POSTGRES_ADMIN_URL, so there is no database to prepare; {hint}")
    run = run or P._lib_runner(app_dir)
    if measure_only:
        if not vals.get("DATABASE_URL"): sys.exit(f"the env file has no DATABASE_URL yet, so there is nothing to prove; {hint}")
        if repair: P._rls_cover(run, adm, mode, hint)
        ev = P._verify_app_rw(run, vals["DATABASE_URL"], mode, "self_hosted", "provision.py --verify-rls (vm_remote, on the server)", hint)
        print("EVIDENCE " + json.dumps(ev)); return ev
    sh = sh or (lambda cmd, env: subprocess.run(cmd, shell=True, cwd=app_dir, env=dict(os.environ, **env),
                                                 stdin=subprocess.DEVNULL, capture_output=True, text=True))
    envloc = os.path.join(app_dir, ".env.local"); envsup = os.path.join(app_dir, ".env.supabase")
    # The mold's migration scripts (scripts/lib/migration-ssl.mjs): TLS required unless DATABASE_SSL=disable, which they
    # accept only for a Postgres on this machine. This server's Postgres is on loopback, TLS on unless state says not.
    ssl = {"DATABASE_SSL": "require" if sslmode == "require" else "disable"}
    saved = open(envloc).read() if os.path.exists(envloc) else None
    got = {}
    try:
        P._seed_env_local(envloc)
        with open(envsup, "w") as f: f.write(f"SUPABASE_POSTGRES_URL_NON_POOLING={adm}\n")
        os.chmod(envsup, 0o600)
        def mold(label, cmd, env):
            def step():
                r = sh(cmd, env)
                msg = [l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.lstrip().startswith("at ") and not l.startswith("npm notice")]
                print(f"  {label}: " + (redact(msg[-1])[:150] if msg else "ok"))
                if r.returncode: sys.exit(f"{label} failed:\n" + redact("\n".join(msg[-12:])))
            return step
        def bootstrap():
            env = {}
            m0 = re.match(r"postgres(?:ql)?://app_rw[^:]*:([^@]+)@", vals.get("DATABASE_URL", ""))
            if m0: env["APP_RW_PASSWORD"] = urllib.parse.unquote(m0.group(1)); print("  reusing the deployed app_rw password (no rotation)")
            r = sh("node .bootstrap-supabase.mjs", env); raw = r.stdout + r.stderr
            m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', open(envloc).read(), re.M) if os.path.exists(envloc) else None
            # The mold's bootstrap persists the app_rw URL, then tests it on port 6543 (Supabase's pooler). Here that
            # test can only fail, after all the real work succeeded; the proof below re-verifies on the right port.
            if r.returncode and not (m and "DATABASE_URL now points at" in raw):
                tail = [l for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("at ")]
                sys.exit("database bootstrap failed:\n" + redact("\n".join(tail[-12:])))
            if not m: sys.exit("the bootstrap did not write an app_rw DATABASE_URL")
            got["app_url"] = retarget(m.group(1), adm, sslmode); print("  rls + app_rw: bootstrapped")
        def hold():
            if mode != "off": print("  deploy window: " + json.dumps(P._window(run, "hold", adm, mode, hint))[:160])
        def release():
            if mode != "off": P._window(run, "release", adm, mode, hint)
        def prove(): got["ev"] = P._verify_app_rw(run, got["app_url"], mode, "self_hosted", "provision.py --deploy-remote (on the server)", hint)
        def push(): got["pushed"] = P.push_schema(sh, run, adm, mode, hint)
        def drift():
            if not got["pushed"]: P.apply_drift(sh, run, adm, mode, hint)
        def publish():
            env_merge(env_file, {"DATABASE_URL": got["app_url"]}); print("  DATABASE_URL (app_rw) written to the env file, after the proof")
        P._run_chain({"hold": hold, "push": push, "drift": drift,
                      "migrate": mold("migration journal", "node scripts/migrate-production.mjs", {"DATABASE_URL": adm, "DATABASE_URL_UNPOOLED": adm, **ssl}),
                      "bootstrap": bootstrap, "task-workflow": mold("task-workflow", "npm run db:migrate:task-workflows", ssl),
                      "cover": lambda: P._rls_cover(run, adm, mode, hint), "release": release, "prove": prove, "publish": publish})
    finally:
        if os.path.exists(envsup): os.remove(envsup)
        if saved is None:
            if os.path.exists(envloc): os.remove(envloc)
        else: open(envloc, "w").write(saved)
    print("EVIDENCE " + json.dumps(got["ev"])); return got["ev"]

def env_run(env_file, user, home, cwd, cmd):
    """Run one command as the service user with the env file loaded. The file is root's and mode 600, so root
    reads it here and the values pass to the child in its environment, never through a shell or a command line."""
    import pwd
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": home, "LANG": "C.UTF-8", **env_read(env_file)}
    pw = pwd.getpwnam(user)
    os.chdir(cwd)
    if os.getuid() == 0:
        os.initgroups(user, pw.pw_gid); os.setgid(pw.pw_gid); os.setuid(pw.pw_uid)
    os.execvpe(cmd[0], cmd, env)

# ---------------------------------------------------------------------------------------------------------
# provision.py's entry for a vm_remote application
# ---------------------------------------------------------------------------------------------------------
def source_for(app_id, app):
    """Where the source to ship comes from: the branded/packed build copy when the app has either, else the mold."""
    if (app.get("surface") or {}).get("branding") or app.get("packs"): return os.path.join(ROOT, "build", app_id)
    return os.path.join(ROOT, "molds", app["mold_id"], "codebase")

def state_problems(app_id, adir):
    sys.path.insert(0, SCRIPTS); import factory
    errs, _ = factory._app_errors(app_id, adir)
    return errs

def check(app_id, app, infra, ds, adir, say=print):
    """Offline and read-only: connects to nothing, writes nothing. Exit 0 = ready for --deploy-remote."""
    S = settings(app_id, app, infra, ds); src = source_for(app_id, app)
    mold_src = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    say(f"  server: {S['host'] or 'not supplied yet'} · domain: {S['domain'] or 'not supplied yet'} · login: {S['user']} on port {S['port']} · "
        f"SSH key name: {S['key_ref']} ({'present' if os.path.isfile(key_path(S)) else 'not on this VM yet'} at {key_shown(S)})")
    say(f"  install path {S['install']} · sandbox: {S['sandbox'].get('backend')} {S['sandbox'].get('cpus')} vCPU / {S['sandbox'].get('memory_mib')} MiB, "
        f"{len(S['sandbox'].get('deny_subnets') or [])} denied networks · storage: {S['storage'].get('driver')} · postgres {S['pg']['version']} on loopback, TLS {S['pg']['tls']}")
    errs = state_problems(app_id, adir)
    for e in errs: say("  state: " + e)
    conflict = sandbox_conflict(S)
    if conflict: say("  " + conflict)
    gaps = mold_gaps(mold_src)
    for n, what, where in gaps:
        say(f"  not ready: the app's code does not yet contain {n} ({what}); that is {where}")
    try: crons = read_crons(mold_src)
    except Stop as e: say("  " + str(e)); crons = []
    say("a deploy will, in order:")
    for i, st in enumerate(plan(S, src), 1): say(f"  {i:2d}. {st['title']}")
    say(f"  then write state: vm_remote.production_url, vm_remote.health, deployed_at, postgres.rls_verified, status stamped (or reverted, with the reason)")
    say(f"values only you hold, asked for at a hidden prompt during the deploy if the server lacks them: {', '.join(operator_names(S)) or 'none'}")
    say(f"minted on the server (not yours to set): {', '.join(SERVER_MADE)}")
    todo = []
    if not S["host"] or not S["domain"]:
        todo.append(f"supply the server and the domain (docs/RUNBOOK.md §9): python3 .claude/scripts/provision.py {app_id} --set-remote host=<address> domain=<name>")
    if not os.path.isfile(key_path(S)):
        todo.append(f"make the SSH key named {S['key_ref']} and add its public half at the server provider: python3 .claude/scripts/provision.py {app_id} --remote-key")
    if errs: todo.append("fix the state problem(s) above, then run: python3 .claude/scripts/factory.py validate")
    if conflict and not errs: todo.append("resolve the storage and sandbox conflict above")
    if gaps: todo.append("wait for the upstream changes named above to land in the mold (a refresh of the snapshot); nothing for you to do")
    say("check only, offline and read-only: nothing was contacted and nothing was created. " +
        ("Still to do:" if todo else f"Ready. See every command first: python3 .claude/scripts/provision.py {app_id} --deploy-remote --dry-run"))
    for t in todo: say("  - " + t)
    return 1 if todo else 0

def set_remote(app_id, adir, pairs, say=print):
    """Write the operator's server address / domain into state. Not secrets; validated by the schema."""
    allowed = {"host": str, "domain": str, "ssh_user": str, "ssh_port": int, "ssh_key_ref": str, "provider": str, "ssh_host": str, "ssh_allow_from": str}
    ip = os.path.join(adir, "infrastructure.json"); infra = load(ip); vr = dict(infra.get("vm_remote") or {})
    old = json.dumps(infra, indent=2) + "\n"
    for p in pairs:
        k, _, v = p.partition("=")
        if k not in allowed or not v:
            raise Stop(f"--set-remote takes {', '.join(f'{k}=...' for k in allowed)}; {p!r} is not one of them. Nothing was written.")
        if k == "host" and "@" in v: raise Stop("host is the server's address only (for example 203.0.113.7), without a user name. Nothing was written.")
        try: vr[k] = allowed[k](v.strip().lower() if k == "domain" else v.strip())
        except ValueError: raise Stop(f"{k} must be a number. Nothing was written.")
    if vr.get("production_url") and vr.get("domain") and vr["production_url"] != f"https://{vr['domain']}": vr.pop("production_url")
    infra["vm_remote"] = vr
    with open(ip, "w") as f: f.write(json.dumps(infra, indent=2) + "\n")
    errs = state_problems(app_id, adir)
    if errs:
        with open(ip, "w") as f: f.write(old)
        raise Stop("that did not fit, so nothing was written:\n  " + "\n  ".join(errs))
    say(f"{app_id}: recorded " + ", ".join(p.partition('=')[0] for p in pairs) + f" in state/application/{app_id}/infrastructure.json")
    say(f"Next: python3 .claude/scripts/provision.py {app_id}")

def remote_key(S, say=print, home=None):
    """Make the key pair named by ssh_key_ref if this VM has none, and print the PUBLIC half for the operator to
    paste at the server provider. The private half is never printed and never leaves ~/.ssh."""
    d = os.path.join(home or os.path.expanduser("~"), ".ssh"); priv = os.path.join(d, S["key_ref"])
    if not os.path.isfile(priv):
        os.makedirs(d, mode=0o700, exist_ok=True)
        r = subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"software-factory {S['app_id']}", "-f", priv], capture_output=True, text=True)
        if r.returncode: raise Stop("the key could not be made: " + (r.stderr or "").strip()[-200:])
        say(f"made a new key pair named {S['key_ref']} (the private half stays on this VM and is never shown)")
    else: say(f"the key named {S['key_ref']} already exists on this VM; nothing was changed")
    pub = open(priv + ".pub").read().strip()
    say("Paste this ONE line where the server provider asks for an SSH key, and give it this name: " + S["key_ref"])
    say(""); say(pub); say("")
    say("It is the public half: safe to paste, and it only lets this factory in, nobody else.")
    return pub

def main_for(app_id, a, app, infra, ds, adir, P):
    """Everything provision.py does for a `target: vm_remote` application. Returns the exit code."""
    say = print
    try:
        if "--set-remote" in a:
            i = a.index("--set-remote"); set_remote(app_id, adir, [x for x in a[i + 1:] if "=" in x and not x.startswith("-")]); return 0
        S = settings(app_id, app, infra, ds)
        if "--remote-key" in a: remote_key(S); return 0
        for flag, instead in (("--deploy", "--deploy-remote"), ("--verify-db", "--deploy-remote (its database step is the same chain)"),
                              ("--set-secret", "--deploy-remote (it asks for each missing value at a hidden prompt and stores it on the server)")):
            if flag in a:
                say(f"{app_id}: {flag} is for the other targets; this app runs on its own server. Use: "
                    f"python3 .claude/scripts/provision.py {app_id} {instead}"); return 1
        dry = "--dry-run" in a
        if not any(f in a for f in ("--deploy-remote", "--qualify-remote", "--verify-rls")):
            return check(app_id, app, infra, ds, adir)
        src = source_for(app_id, app); mold_src = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
        crons = read_crons(mold_src); gaps = mold_gaps(mold_src)
        if "--deploy-remote" in a and dry:
            errs = state_problems(app_id, adir)
            if errs: raise Stop("the state does not validate, so there is no plan to print:\n  " + "\n  ".join(errs))
            why = sandbox_conflict(S)
            if why: raise Stop(why + " Nothing was contacted.")
            B = bundle(S, crons); print_plan(S, plan(S, src), B, crons, gaps)
            if "--out" in a:
                out = a[a.index("--out") + 1]; write_bundle(S, crons, out); say(f"bundle written to {out} for reading; nothing was sent anywhere")
            return 0
        # ---- from here on a real server is contacted -------------------------------------------------
        errs = state_problems(app_id, adir)
        if errs: raise Stop("the state does not validate; nothing was contacted:\n  " + "\n  ".join(errs))
        why = sandbox_conflict(S)
        if why: raise Stop(why + " Nothing was contacted.")
        if not S["host"] or ("--qualify-remote" not in a and not S["domain"]):
            raise Stop(f"{app_id}: the server address and the domain are not in state yet, so there is nowhere to deploy. Nothing was "
                       f"contacted. Supply them: python3 .claude/scripts/provision.py {app_id} --set-remote host=<address> domain=<name>")
        if not os.path.isfile(key_path(S)):
            raise Stop(f"{app_id}: there is no SSH key named {S['key_ref']} on this VM ({key_shown(S)}), so the server would refuse us. "
                       f"Nothing was contacted. Make it and add it at the provider: python3 .claude/scripts/provision.py {app_id} --remote-key")
        for tool in ("ssh", "rsync"):
            if not shutil.which(tool): raise Stop(f"this VM has no `{tool}` command, which the deploy needs. Nothing was contacted.")
        if "--qualify-remote" in a:
            st = plan(S, src, shown=False)[0]; r = real_runner(st, QUALIFY_SH)
            if r.returncode: raise Stop("could not log in to the server: " + redact((r.stderr or "").strip().splitlines()[-1] if (r.stderr or "").strip() else "no answer") +
                                        f". Check the address, and that the key named {S['key_ref']} was added when the server was created.")
            problems = qualify(parse_kv(r.stdout))
            # The domain may not point anywhere yet; when it does, the addresses it leads to are what a sandbox fetches.
            why = sandbox_conflict(S, resolve(S["domain"])) if S["domain"] else None
            if why: problems.append(why)
            if problems: raise Stop("This server cannot run the app:\n  - " + "\n  - ".join(problems))
            say(f"{app_id}: the server is fit (KVM present, memory, CPUs, disk, Ubuntu 24.04, no Docker, no other web server). Nothing was installed or changed.")
            return 0
        if "--verify-rls" in a:
            return verify_rls(app_id, S, app, infra, ds, adir, P, repair="--no-repair" not in a)
        if gaps:
            raise Stop(f"{app_id}: the app's code does not yet contain " + "; ".join(f"{n} ({where})" for n, _, where in gaps) +
                       ". Without them it cannot store files, sign its own background calls or start a safe sandbox off Vercel, so a deploy "
                       "would build something that does not work. Nothing was contacted. See every step meanwhile: "
                       f"python3 .claude/scripts/provision.py {app_id} --deploy-remote --dry-run")
        return run_deploy(app_id, S, app, infra, ds, adir, P, src, crons)
    except Stop as e:
        say(str(e)); return 1

def prepare_source(app_id, app):
    """The same build copy the Vercel path ships: the brand, then the application's packs. The mold is never edited."""
    if (app.get("surface") or {}).get("branding"):
        r = subprocess.run([sys.executable, os.path.join(SCRIPTS, "branding.py"), app_id, "prepare"], capture_output=True, text=True)
        print((r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
        if r.returncode: raise Stop("branding failed; not deploying. Nothing was contacted.")
    if app.get("packs"):
        for verb in ("apply", "verify"):
            r = subprocess.run([sys.executable, os.path.join(SCRIPTS, "packs.py"), verb, app_id], capture_output=True, text=True)
            print("\n".join((r.stdout + r.stderr).strip().splitlines()[-3:]))
            if r.returncode: raise Stop("a pack did not apply or does not pass the mold's own checks; not deploying. Nothing was contacted.")

def run_deploy(app_id, S, app, infra, ds, adir, P, src, crons, deploy_fn=deploy):
    """The deploy, then the record. The status rules are the Vercel path's: `stamping` while it runs, `reverted`
    with the reason on any stop, `stamped` only when the app in front of traffic says row-level security is enforced."""
    def shape(n, v):
        g = P.GUIDE.get(n)
        return f"{n}: that does not look like {g['shape'][1]}" if g and not re.fullmatch(g["shape"][0], v) else None
    prepare_source(app_id, app)
    # The copy to the server deletes what the source no longer has, so the source must really be the app.
    if not (os.path.isfile(os.path.join(src, "package.json")) and os.path.isdir(os.path.join(src, "agent")) and os.path.isfile(os.path.join(src, "services/task-workflow/package.json"))):
        print(f"{app_id}: {os.path.relpath(src, ROOT)} is not the application's source (no package.json, agent/ or services/task-workflow), so there is "
              f"nothing to copy. Nothing was contacted and {app_id}'s status is unchanged."); return 1
    started = []
    def on_started():
        started.append(True); app["status"] = "stamping"; P.save(os.path.join(adir, "application.json"), app)
    try:
        def secrets_for(names):
            vals = collect_secrets(app_id, names, explain=P.explain, shape=shape)
            # The sender's display name is the app's brand, as on the Vercel path; the operator supplies the address.
            if vals.get("PLATFORM_NOTIFY_FROM"): vals["PLATFORM_NOTIFY_FROM"] = P.brand_sender(app, vals["PLATFORM_NOTIFY_FROM"])
            return vals
        res = deploy_fn(S, src, crons, on_started=on_started, secrets_for=secrets_for, read_health=P._read_health)
    except BaseException as e:
        # A refusal before anything on the server changed (the host is unfit, the domain does not point at it, the
        # login failed) leaves the status alone. After that point every stop is recorded, as on the Vercel path.
        if started:
            reason = str(e) if isinstance(e, (Stop, SystemExit)) and str(e) else f"the deploy stopped on {type(e).__name__}"
            P._revert(adir, app, redact(reason), "Deploy target: this app's own server; run --deploy-remote again once the cause is fixed.")
        if isinstance(e, Stop):
            print(str(e) + ("" if started else f"\n  {app_id}'s status is unchanged.")); return 1
        raise
    vr = infra.setdefault("vm_remote", {})
    vr["health"] = dict(res["health"], qualified_at=P.NOW)
    code, doc, why = res["public"]
    running = P._rls_from_doc(code, doc, why)
    if res["evidence"]:
        ev = dict(res["evidence"], at=P.NOW)       # one run, one instant: the same NOW deployed_at gets
        ev["running_app"], ev["running_app_detail"] = running
        P.record_rls(adir, ds, ev)
    problems = list(res["problems"])
    if S["mode"] != "off" and running[0] != "enforced":
        problems.append(f"the app at {S['url']} does not say row-level security is enforced ({running[0]}: {running[1][:160]})")
    if problems:
        P.save(os.path.join(adir, "infrastructure.json"), infra)
        P._revert(adir, app, "the deploy finished but the server is not in the state it must be: " + "; ".join(problems))
        print(f"{app_id}: deployed, but NOT accepted:\n  - " + "\n  - ".join(problems) +
              f"\n  Fix the cause and run it again: python3 .claude/scripts/provision.py {app_id} --deploy-remote")
        return 1
    vr["production_url"] = S["url"]; infra["deployed_at"] = P.NOW
    P.save(os.path.join(adir, "infrastructure.json"), infra)
    app.pop("revert", None)
    shipped = next(((m.get("source") or {}).get("commit") for m in load(os.path.join(ROOT, "state", "factory.json")).get("molds", []) if m.get("mold_id") == app.get("mold_id")), None)
    if shipped: app["mold_commit"] = shipped
    app["status"] = "stamped"; P.save(os.path.join(adir, "application.json"), app)
    print(f"deployed: {S['url']}")
    return 0

def verify_rls(app_id, S, app, infra, ds, adir, P, repair=True, runner=real_runner, read_health=None):
    """Re-prove tenant isolation on the server's database (measured there, where the URLs live) and on the app in
    front of traffic. No build, no restart, no password rotation."""
    if S["mode"] == "off":
        print(f'{app_id}: datastores.postgres.rls is "off", so there is nothing to prove.'); return 0
    cmd = guarded(S, f"python3 {S['tool']} host-chain --measure-only {'' if repair else '--no-repair '}--app-dir {S['app_dir']} "
                     f"--env-file {S['env_file']} --mode {S['mode']} --sslmode {S['sslmode']}")
    r = runner({"id": "verify-rls", "argv": ssh_argv(S, cmd), "timeout": 900})
    for l in redact(r.stdout or "").splitlines():
        if l.strip() and not l.startswith("EVIDENCE "): print(l[:420])
    ev = next((json.loads(l[len("EVIDENCE "):]) for l in (r.stdout or "").splitlines() if l.startswith("EVIDENCE {")), None)
    if r.returncode or not ev:
        print(f"{app_id}: tenant isolation could not be proven on the server: " + redact(((r.stderr or "").strip().splitlines() or ["no proof was printed"])[-1])[:300] +
              f"\n  Run: python3 .claude/scripts/provision.py {app_id} --deploy-remote"); return 1
    ev["at"] = P.NOW
    code, doc, why = (read_health or P._read_health)(f"{S['url']}/api/ops/health")
    ev["running_app"], ev["running_app_detail"] = P._rls_from_doc(code, doc, why)
    P.record_rls(adir, ds, ev)
    print(f"{app_id}: tenant isolation PROVEN on the server's stored DATABASE_URL: {ev.get('protected')}/{ev.get('org_scoped_tables')} "
          f"org-scoped tables protected, {ev.get('foreign_rows_readable')} foreign row(s) readable, cross-workspace write refused with {ev.get('cross_org_write')}")
    if ev["running_app"] != "enforced":
        print(f"{app_id}: but the app at {S['url']} does not say row-level security is enforced ({ev['running_app']}: {ev['running_app_detail'][:160]}).\n"
              f"  Run: python3 .claude/scripts/provision.py {app_id} --deploy-remote"); return 1
    print(f"  the running app reports: enforced ({ev['running_app_detail']})"); return 0

# ---------------------------------------------------------------------------------------------------------
# command line
# ---------------------------------------------------------------------------------------------------------
def _opt(a, k, d=None): return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d

def cli(a):
    if not a or a[0] in ("-h", "--help"): sys.exit(__doc__)
    if a[0] == "--self-test":
        sys.path.insert(0, HERE); import vm_remote_selftest
        return vm_remote_selftest.run()
    cmd = a[0]
    if cmd == "plan":
        d = os.path.abspath(a[1]) if len(a) > 1 and not a[1].startswith("-") else sys.exit(__doc__)
        app_id = os.path.basename(d.rstrip("/"))
        docs = {n: load(os.path.join(d, f"{n}.json")) for n in ("application", "infrastructure", "datastores")}
        errs = state_problems(app_id, d)
        if errs: print("\n".join(errs)); print(f"{len(errs)} problem(s): this state does not validate, so there is no plan."); return 1
        S = settings(app_id, docs["application"], docs["infrastructure"], docs["datastores"])
        mold_src = os.path.join(ROOT, "molds", docs["application"]["mold_id"], "codebase")
        src = _opt(a, "--source") or mold_src
        try: crons = read_crons(mold_src)
        except Stop as e: print(str(e)); return 1
        print_plan(S, plan(S, src), bundle(S, crons), crons, mold_gaps(mold_src))
        if "--out" in a: write_bundle(S, crons, _opt(a, "--out")); print(f"bundle written to {_opt(a, '--out')} for reading; nothing was sent anywhere")
        return 0
    f = _opt(a, "--file")
    if cmd == "env-names":
        print("\n".join(env_names(f))); return 0
    if cmd == "env-merge":
        added, changed, refused = env_merge(f, stdin_pairs(sys.stdin.read()))
        for why in refused: print("env: " + why, file=sys.stderr)
        print(f"env: {len(added)} name(s) added, {len(changed)} changed" + (f": {', '.join(added + changed)}" if added or changed else "") + " (values not shown)")
        return 1 if refused else 0
    if cmd == "env-mint":
        made = env_mint(f); print("env: minted on this server (values not shown): " + (", ".join(made) if made else "nothing; every internal secret was already present and was kept")); return 0
    if cmd == "env-split":
        counts = env_split(f, os.path.dirname(f), load(_opt(a, "--spec")))
        print("env: each service's own file written (root, mode 600; values not shown): " + ", ".join(f"{k}.env {n} names" for k, n in counts.items())); return 0
    if cmd == "env-run":
        i = a.index("--"); env_run(f, _opt(a, "--user"), _opt(a, "--home"), _opt(a, "--cwd"), a[i + 1:]); return 0
    if cmd == "pg-admin":
        pg_admin(f, _opt(a, "--db"), int(_opt(a, "--port", "5432")), _opt(a, "--sslmode", "require")); return 0
    if cmd == "host-chain":
        host_chain(_opt(a, "--app-dir"), _opt(a, "--env-file"), _opt(a, "--mode", "fail_closed"), _opt(a, "--sslmode", "require"),
                   measure_only="--measure-only" in a, repair="--no-repair" not in a); return 0
    sys.exit(__doc__)

if __name__ == "__main__": sys.exit(cli(sys.argv[1:]))
