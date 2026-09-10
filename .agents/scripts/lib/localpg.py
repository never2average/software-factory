#!/usr/bin/env python3
"""A per-app Postgres on a PRIVATE docker network. No host port, ever.

  localpg.py up <app_id>        create the network, cert and container; print nothing secret
                                (through infra/vm/apps/<app_id>/docker-compose.yml when it exists, so
                                 a hand-written docker-compose.override.yml governs this database too)
  localpg.py url <app_id>       print the admin URL (a secret value: only provision.py reads it)
  localpg.py run <app_id> <cmd> run <cmd> inside node:24 on the app's network, with the mold mounted
  localpg.py down <app_id> [--keep-data]   remove the container (and volume unless --keep-data)
  localpg.py ls                 the app databases this box holds

Why a private network and not a published port. `.bootstrap-supabase.mjs:206` forces the app URL
onto port 6543 (Supavisor's), unconditionally, and then connection-tests it. The usual workaround
is to publish the container on host port 6543 — but this droplet has no firewall (`ufw` inactive,
`iptables -P INPUT ACCEPT`), so a published port is on the public internet within minutes. Instead
the server LISTENS on 6543 inside the container, reachable only from containers on `sf-<app_id>`.
The hardcoded port becomes a true no-op and nothing is exposed. `docker port` stays empty.

TLS is not optional: 48 of the mold's .mjs scripts pass `ssl: "require"` as an explicit postgres.js
option, which beats any `sslmode` in the URL, so a plaintext server is simply unreachable by them.
A self-signed certificate is enough (`require` encrypts, it does not verify).

This lane is for LOCAL VERIFICATION on this box — the five testing lanes, a clone rehearsal, a
schema dry run. It is not a deploy target: a Vercel function cannot reach a private docker network,
and provision.py refuses to pair postgres.provider=self_hosted with target=vercel for that reason.
"""
import json, os, re, secrets, subprocess, sys

IMAGE = "postgres:17"; NODE_IMAGE = "node:24-bookworm-slim"; PORT = 6543
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
def _d(*a, **k): return subprocess.run(["docker", *a], capture_output=True, text=True, **k)
def net(app_id): return f"sf-{app_id.replace('_','-')}"
def cont(app_id): return f"pg-{app_id.replace('_','-')}"
def vol(app_id): return f"pg-{app_id.replace('_','-')}-data"
def dbname(app_id): return re.sub(r"[^a-z0-9]", "", app_id.lower()) or "appdb"   # unquoted in `GRANT CONNECT ON DATABASE ${dbName}`
def certdir(app_id): return os.path.join(appdir(app_id), "pg")

def _running(name): return _d("inspect", "-f", "{{.State.Running}}", name).stdout.strip() == "true"

HBA = ("# hostssl only: `host` would let any client on the app network downgrade to plaintext, and the\n"
       "# server offering TLS is not the same as the server requiring it.\n"
       "local all all scram-sha-256\n"
       "hostssl all all all scram-sha-256\n")

GITIGNORE = ".env\n.pg-admin\npg/\n"

def appdir(app_id):
    """infra/vm/apps/<app_id>/, with its .gitignore ALREADY IN PLACE before anything secret lands in it.

    The per-app .gitignore used to be written only by provision.py's generate_local_artifact, which the
    documented first command (`provision.py <id> --verify-db`) never reached — so that command left the
    Postgres superuser password (.pg-admin) and the server TLS private key (pg/server.key) untracked but
    NOT ignored, one `git add -A` away from a public repo. An ignore rule must never lag the secret it
    protects, so the directory cannot be created without it. The root .gitignore carries the same two
    rules as a second belt, for anything that creates this directory some other way."""
    d = os.path.join(ROOT, "infra/vm/apps", app_id); os.makedirs(d, exist_ok=True)
    g = os.path.join(d, ".gitignore")
    if not os.path.exists(g) or open(g).read() != GITIGNORE: open(g, "w").write(GITIGNORE)
    return d

def compose_file(app_id): return os.path.join(appdir(app_id), "docker-compose.yml")

def has_data(app_id):
    """Does this app's data volume still exist? Postgres bakes the superuser password INTO that volume
    at initdb time, so the volume and `.pg-admin` are one credential in two places."""
    return _d("volume", "inspect", vol(app_id)).returncode == 0

def _pw(app_id):
    """The admin password lives in the app's ignored `.pg-admin` (0600), generated, never typed, never printed.

    NEVER MINT A SECOND ONE OVER A LIVE VOLUME. provision.py regenerates this directory on every run and
    documents it as generated output, but this file is not derivable from anything: the password it holds
    was written into the data directory when the cluster was initialised. Minting a fresh one here writes
    a password the existing volume has never heard of — and it used to do exactly that, silently: the
    regeneration printed `local artifact regenerated`, exit 0, and every connection afterwards failed with
    `password authentication failed for user "postgres"` and no hint that a credential had been lost.
    Regenerating the artifact must not be able to destroy the only copy of a credential, so it refuses."""
    p = os.path.join(appdir(app_id), ".pg-admin")
    if not os.path.exists(p) and has_data(app_id):
        sys.exit(f"the admin password for {app_id}'s local database is missing "
                 f"(infra/vm/apps/{app_id}/.pg-admin) but its data volume {vol(app_id)} still exists, and nothing "
                 f"can open that volume without it. Nothing has been changed.\n"
                 f"  If you have a copy of that file, put it back at infra/vm/apps/{app_id}/.pg-admin and rerun.\n"
                 f"  Otherwise rebuild the database — it is a LOCAL VERIFICATION database, rebuilt from state,\n"
                 f"  and this DELETES the data in it:\n"
                 f"    python3 .claude/scripts/lib/localpg.py down {app_id}\n"
                 f"    python3 .claude/scripts/provision.py {app_id} --verify-db")
    if not os.path.exists(p):
        old = os.umask(0o077)
        # no trailing newline: the compose artifact feeds this same file to POSTGRES_PASSWORD_FILE,
        # and docker's entrypoint does not strip one, so a newline here would mean two different passwords
        try: open(p, "w").write(secrets.token_urlsafe(24))
        finally: os.umask(old)
    os.chmod(p, 0o600)
    return open(p).read().strip()

def _cert(app_id):
    d = certdir(app_id); os.makedirs(d, exist_ok=True)          # appdir() wrote .gitignore first: pg/ is ignored
    crt, key = os.path.join(d, "server.crt"), os.path.join(d, "server.key")
    if not (os.path.exists(crt) and os.path.exists(key)):
        # BOTH OR NEITHER. `if not exists(crt)` alone left a present-crt / missing-key directory untouched
        # and then died three lines down in os.chmod(key) with a FileNotFoundError traceback — a stack
        # trace where the operator needed a sentence — and postgres would not have started either.
        # Unlike .pg-admin this pair IS derivable: it is self-signed, no CA trusts it and postgres.js's
        # `ssl: require` encrypts without verifying it, so regenerating both costs nothing.
        for f in (crt, key):
            if os.path.exists(f): os.remove(f)
        subprocess.run(["openssl", "req", "-new", "-x509", "-days", "3650", "-nodes", "-subj", f"/CN={cont(app_id)}",
                        "-addext", f"subjectAltName=DNS:db,DNS:{cont(app_id)}", "-out", crt, "-keyout", key],
                       check=True, capture_output=True)
    hba = os.path.join(d, "pg_hba.conf")
    if not os.path.exists(hba): open(hba, "w").write(HBA)
    os.chmod(key, 0o600); os.chown(key, 999, 999); os.chown(crt, 999, 999)   # uid 999 = postgres in the official image
    os.chown(hba, 999, 999)
    return d

def _no_port_msg(app_id, pub):
    """The one edit this box cannot absorb: an override that publishes the database (no firewall here)."""
    return (f"refusing to run {cont(app_id)}: the compose config publishes a host port ({pub}). Remove the "
            f"`ports:` mapping from infra/vm/apps/{app_id}/docker-compose.override.yml — this factory never "
            f"opens a Postgres port to the internet.")

def up(app_id):
    """Bring this app's database up — through the generated compose artifact when one exists.

    The factory used to bring the database up with `docker run` while telling the operator that
    docker-compose.override.yml was "the one sanctioned hand-edit seam": the override could not reach
    the database the factory itself created and verified. Compose is now the primary path, run from the
    app directory so compose's own automatic override discovery applies (an explicit `-f` disables it).
    `docker run` remains the fallback for an app whose artifact has not been generated yet."""
    _d("network", "create", net(app_id))
    pw, certs, cf = _pw(app_id), _cert(app_id), compose_file(app_id)
    if os.path.exists(cf):
        # read the MERGED config (base + override) and refuse a published port before starting anything:
        # the post-start check below is the backstop, but a port that is never opened is better than one
        # closed a second later on a box with no firewall.
        cj = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=appdir(app_id), capture_output=True, text=True)
        try: pubs = [x for sv in json.loads(cj.stdout).get("services", {}).values() for x in (sv.get("ports") or [])]
        except Exception: pubs = []
        if pubs: sys.exit(_no_port_msg(app_id, json.dumps(pubs[0])) + " Nothing was started.")
        r = subprocess.run(["docker", "compose", "up", "-d"], cwd=appdir(app_id), capture_output=True, text=True)
    else:
        if _running(cont(app_id)): print(f"{cont(app_id)} already up"); return
        _d("rm", "-f", cont(app_id))
        r = _d("run", "-d", "--name", cont(app_id), "--network", net(app_id), "--network-alias", "db",
               "--restart", "unless-stopped",
               "-e", f"POSTGRES_PASSWORD={pw}", "-e", f"POSTGRES_DB={dbname(app_id)}",
               "-v", f"{vol(app_id)}:/var/lib/postgresql/data", "-v", f"{certs}:/certs:ro",
               IMAGE, "-c", f"port={PORT}", "-c", "ssl=on", "-c", "hba_file=/certs/pg_hba.conf",
               "-c", "ssl_cert_file=/certs/server.crt",
               "-c", "ssl_key_file=/certs/server.key", "-c", "password_encryption=scram-sha-256",
               "-c", "max_connections=200")
    if r.returncode: sys.exit("could not start the app database:\n" + (r.stdout + r.stderr).strip()[-400:])
    pub = _d("port", cont(app_id)).stdout.strip()
    if pub:
        _d("rm", "-f", cont(app_id))                       # checked before the readiness wait, not after it
        sys.exit(_no_port_msg(app_id, pub.splitlines()[0]) + " The container has been removed.")
    for _ in range(60):
        if _d("exec", cont(app_id), "pg_isready", "-p", str(PORT), "-U", "postgres").returncode == 0: break
        subprocess.run(["sleep", "1"])
    else: sys.exit(f"{cont(app_id)} did not become ready")
    print(f"{cont(app_id)} up on {net(app_id)} as db:{PORT} (no host port; TLS on)"
          + ("" if os.path.exists(cf) else "  [no compose artifact yet: run provision.py " + app_id + " --check]"))

def ensure_local_secrets(app_id):
    """Materialise the compose artifact's inputs — .pg-admin and pg/{server.crt,server.key,pg_hba.conf}
    — so a freshly generated artifact can be brought up by `docker compose up -d` with nothing else run
    first. provision.py calls this as it generates the artifact; all of them are ignored before they exist."""
    _pw(app_id); return _cert(app_id)

def url(app_id):
    """postgresql://postgres:<generated>@db:6543/<db>?sslmode=require — resolvable only on sf-<app_id>."""
    import urllib.parse
    return f"postgresql://postgres:{urllib.parse.quote(_pw(app_id), safe='')}@db:{PORT}/{dbname(app_id)}?sslmode=require"

def run(app_id, cmd, mold_dir, env=None, extra=()):
    """Run one shell command against the app database, on its network, with the mold mounted at /app.

    The mold scripts run INSIDE the network rather than the database being published to them: that is
    the whole point, and it is why `.bootstrap-supabase.mjs`'s hardcoded port 6543 needs no rewriting
    on this lane. Secret values travel as container env, never as argv."""
    args = ["run", "--rm", "--network", net(app_id), "-v", f"{os.path.abspath(mold_dir)}:/app", "-w", "/app",
            "-e", "NEXT_TELEMETRY_DISABLED=1", "-e", "CI=1", *extra]
    for k, v in (env or {}).items(): args += ["-e", f"{k}={v}"]
    args += [NODE_IMAGE, "sh", "-lc", cmd]
    return _d(*args)

def _exists(kind, name):
    """`docker [kind] inspect` exit 0 — the only evidence that a resource is (still) there."""
    return _d(*kind, "inspect", name).returncode == 0

def down(app_id, keep_data=False):
    """Remove the container, its data volume (unless --keep-data) and the network — and REPORT ONLY WHAT
    DOCKER ACTUALLY REMOVED. This used to print "pg-x removed; volume pg-x-data deleted" unconditionally,
    for an app that had never been created: a deletion verdict written by the script, not read from
    docker. The verdict is now built from `inspect` before and after each `rm`: a resource that was not
    there is named as such ("nothing to remove" when none of them were), one that was there and is still
    there afterwards (a volume held by another container, say) is a failure, exit 1, never a "deleted"."""
    kinds = [("container", (), cont(app_id))] + ([] if keep_data else [("volume", ("volume",), vol(app_id))]) \
            + [("network", ("network",), net(app_id))]
    removed, kept, stuck = [], [], []
    for label, kind, name in kinds:
        if not _exists(kind, name): continue
        r = _d(*kind, "rm", *(("-f",) if label == "container" else ()), name)
        if _exists(kind, name): stuck.append(f"{label} {name}: " + (r.stderr.strip().splitlines() or ["still present"])[-1])
        else: removed.append(f"{label} {name}")
    if keep_data and _exists(("volume",), vol(app_id)): kept.append(f"volume {vol(app_id)} kept (--keep-data)")
    if stuck:
        sys.exit(f"could not remove {app_id}'s local database completely:\n  " + "\n  ".join(stuck)
                 + ("\n  removed: " + ", ".join(removed) if removed else "")
                 + "\n  Rerun this command; if it fails again, run `docker ps -a` to see what still holds it.")
    print(f"{app_id}: " + ("removed " + ", ".join(removed) if removed else "nothing to remove") + ("; " + "; ".join(kept) if kept else ""))

def ls():
    out = _d("ps", "-a", "--filter", "name=^pg-", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}").stdout
    print(out.strip() or "no app databases on this box")

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    if a[0] == "up": up(a[1])
    elif a[0] == "url": print(url(a[1]))
    elif a[0] == "run": r = run(a[1], a[2], a[3] if len(a) > 3 else os.path.join(ROOT, "molds/mold_v1/codebase")); print(r.stdout + r.stderr); sys.exit(r.returncode)
    elif a[0] == "down": down(a[1], "--keep-data" in a)
    elif a[0] == "ls": ls()
    else: sys.exit(__doc__)
