#!/usr/bin/env python3
"""More of the vm_remote self-test (run by vm_remote_selftest.run, inside its Offline guard): two tickets of 2026-10-04.

  users      one system user per service (mold_v1-158): the units, the build, the prune and the health step each follow
             the right user; the move of a server that ran everything as one user, in its order; the web app's own
             view of the file store; the egress rule that keeps the app's users off the server's own SSH port
  workspace  the brief's workspace written ON the server (mold_v1-152): what is sent, as whom it runs, what is
             recorded, what is refused; the seed itself run against a stand-in for the app's database modules
  surface    the application's surface written ON the server after it (mold_v1-163): what is sent and listed, as whom
             lib/surface.mjs runs and with which tables, what is recorded and what is refused; surface.mjs apply
             itself run with node against a stand-in for the app's `postgres` module

NOTHING HERE TOUCHES A SERVER OR CHANGES THIS MACHINE. The generated users.sh, seal.sh and storage-view.sh are the real
scripts, run against stand-in `systemctl`, `useradd`, `install`, `chown`, `mount` ... commands in a temp directory,
with every path they touch moved under that directory. Two checks go one step further where this machine allows it
(root, with `unshare`), each inside a PRIVATE namespace that vanishes with the process and so changes nothing here:
the id-mapped view is mounted for real in a private mount namespace, and the egress rule is loaded for real in a
private network namespace and tried from a user it names. Where they cannot run they are skipped and the summary says so.
"""
import json, os, re, shutil, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
import vm_remote as V
import vm_remote_selftest as B

RAN = []          # which of the two private-namespace checks really ran on this machine (for the summary line)

WEB, API, WORK = (V.SERVICE_USERS[k] for k in ("web", "api", "workflow"))
SHIMS = {
"systemctl": '''case "$1" in
  is-active) u="${@: -1}"; grep -qxF "$u" "$d/active" ;;
  stop) echo "systemctl $*" >> "$d/calls"; grep -vxF "$2" "$d/active" > "$d/active.n" || true; mv "$d/active.n" "$d/active" ;;
  *) echo "systemctl $*" >> "$d/calls" ;;
esac''',
"getent": '''[ "$1" = group ] && grep -qxF "$2" "$d/groups"''',
"groupadd": '''echo "groupadd $*" >> "$d/calls"; echo "${@: -1}" >> "$d/groups"''',
"useradd": '''echo "useradd $*" >> "$d/calls"; echo "${@: -1}" >> "$d/users"; echo "${@: -1}" >> "$d/groups"''',
"usermod": '''echo "usermod $*" >> "$d/calls"; echo "${@: -1} $3" >> "$d/memberships"''',
"id": '''n="${@: -1}"; grep -qxF "$n" "$d/users" || exit 1
case "$1" in
  -nG) echo "$n $(grep "^$n " "$d/memberships" | cut -d' ' -f2 | tr '\\n' ' ')" ;;
  -u|-g) grep -nxF "$n" "$d/users" | cut -d: -f1 | sed 's/^/6000/' ;;
esac''',
"install": '''echo "install $*" >> "$d/calls"; o=root
while [ $# -gt 0 ]; do case "$1" in -d) ;; -m|-g) shift ;; -o) o="$2"; shift ;; *) mkdir -p "$1"; echo "$1 $o" >> "$d/owners" ;; esac; shift; done''',
"stat": '''p="${@: -1}"; o="$(grep -F "$p " "$d/owners" | awk -v p="$p" '$1 == p {x = $2} END {print x}')"; echo "${o:-root}"''',
"chown": '''echo "chown $*" >> "$d/calls"; echo "${@: -1} ${2%%:*}" >> "$d/owners"''',
"chmod": '''echo "chmod $*" >> "$d/calls"''',
"mountpoint": '''grep -qxF "${@: -1}" "$d/mounted"''',
"mount": '''echo "mount $*" >> "$d/calls"; echo "${@: -1}" >> "$d/mounted"; [ -e "$d/mount-shows-wrong-owner" ] || echo "${@: -1} ''' + WEB + '''" >> "$d/owners"''',
"umount": '''echo "umount $*" >> "$d/calls"; grep -vxF "$1" "$d/mounted" > "$d/mounted.n" || true; mv "$d/mounted.n" "$d/mounted"; echo "$1 root" >> "$d/owners"''',
}

class Box:
    """A temp directory standing in for the server: stand-in commands on PATH, and the little they need to remember."""
    def __init__(self, tmp, name, users=(), active=(), owners=()):
        self.d = os.path.join(tmp, name); self.root = os.path.join(self.d, "root"); os.makedirs(os.path.join(self.d, "bin")); os.makedirs(self.root)
        for n, body in SHIMS.items():
            p = os.path.join(self.d, "bin", n); open(p, "w").write(f"#!/bin/bash\nd={self.d}\n{body}\n"); os.chmod(p, 0o755)
        for f in ("calls", "memberships", "mounted"): open(os.path.join(self.d, f), "w").close()
        self.put("users", users); self.put("groups", users); self.put("active", active)
        self.put("owners", [f"{self.root}{p} {o}" for p, o in owners])
        for p, _ in owners: os.makedirs(self.root + p, exist_ok=True)
    def put(self, name, lines): open(os.path.join(self.d, name), "w").write("".join(l + "\n" for l in lines))
    def lines(self, name): return [l for l in open(os.path.join(self.d, name)).read().split("\n") if l]
    def calls(self): return self.lines("calls")
    def owner(self, path):
        got = [l.rsplit(" ", 1)[1] for l in self.lines("owners") if l.rsplit(" ", 1)[0] == self.root + path]
        return got[-1] if got else None
    def run(self, text, *args, guard="vm_remote_fixture"):
        sp = os.path.join(self.d, "script.sh"); open(sp, "w").write(text)
        env = {"PATH": os.path.join(self.d, "bin") + ":/usr/bin:/bin", "HOME": self.d}
        if guard: env[V.GUARD_VAR] = guard
        return subprocess.run(["bash", sp, *args], env=env, capture_output=True, text=True)

def users(check, tmp):
    S = B._settings(); crons = list(V.CRONS); U = V.unit_files(S, crons); Bn = V.bundle(S, crons); pre = S["unit"]; data = S["data"]
    # ---- who is who
    names = [WEB, API, WORK, V.BUILD_USER]
    check("users: one user per service, and one more for the code that runs no service", len(set(names)) == 4 and set(V.SERVICE_USERS) == {"web", "api", "workflow"} and V.CRON_USER == WEB)
    check("users: the agent API keeps the old single user's name and its short HOME, so the sandbox store never moves",
          API == "sfapp" and V.SERVICE_USER == API and V.SERVICE_HOME == V.SERVICE_HOMES["api"] == "/var/lib/sfapp" and len(V.SERVICE_HOME + "/.microsandbox") < 30)
    check("users: every user has a home of its own", len(set(list(V.SERVICE_HOMES.values()) + [V.BUILD_HOME])) == 4)
    for k in ("web", "api", "workflow"):
        u = U[f"{pre}-{k}.service"]; me = V.SERVICE_USERS[k]
        check(f"users: the {k} unit runs as {me}, in its own group, with its own HOME and its own env file",
              f"User={me}\nGroup={me}\n" in u and f"Environment=HOME={V.SERVICE_HOMES[k]}\n" in u and f"EnvironmentFile={S['env_files'][k]}\n" in u and u.count("User=") == 1, u)
    check("users: the API is the only unit in group kvm", [k for k, v in U.items() if "SupplementaryGroups=kvm" in v] == [f"{pre}-api.service"] and "kvm" not in U[f"{pre}-web.service"] + U[f"{pre}-workflow.service"])
    check("users: nobody is put in group kvm in /etc/group: the API's process gets it from its unit alone", "kvm" not in " ".join(l for l in V.accounts_sh().splitlines() if "usermod" in l or "useradd" in l))
    cron_units = [v for k, v in U.items() if "-cron-" in k and k.endswith(".service")]
    check("users: the cron calls run as the web app's user (they only call the web app, with a secret it already holds), never as the agent's",
          len(cron_units) == 6 and all(f"User={WEB}\nGroup={WEB}\n" in v and f"User={API}" not in v for v in cron_units))
    pr = U[f"{pre}-sandbox-prune.service"]
    check("users: the nightly prune runs as the store's owner, the agent API's user, with its HOME", f"User={API}\nGroup={API}\nEnvironment=HOME={V.SERVICE_HOME}\n" in pr and f"--home {V.SERVICE_HOME} " in pr, pr)
    pa = V.shown_cmd(S, V.prune_argv(S, shown=True))
    check("users:   ...and so does --prune-sandboxes", f"runuser -u {API} -- env HOME={V.SERVICE_HOME} " in pa, pa)
    b = Bn["build.sh"][0]
    check("users: every part of the build runs as the code's owner, with the env file of the service that will run it",
          all(f"env-run --file {S['env_files'][k]} --user {V.BUILD_USER} --home {V.BUILD_HOME} --cwd" in b for k in ("api", "web", "workflow")) and f"--user {API}" not in b and f"--user {WEB}" not in b, b)
    pre_sh = Bn["api-prestart.sh"][0]
    check("users: the prewarm runs inside the API unit, so as the agent API's user", "ExecStartPre=/bin/bash" in U[f"{pre}-api.service"] and "runuser" not in pre_sh and "sudo" not in pre_sh)

    # ---- the order of a deploy on a server that still runs everything as one user
    order = [b.index(x) for x in ("/factory/users.sh", "env-split --file", f"chown -hR {V.BUILD_USER}:{V.CODE_GROUP} ", "npm run build:eve", "-- npm run build\n", "/factory/seal.sh")]
    check("migration: build.sh hands directories over, THEN splits the env files, builds, and seals the new release; it stops nothing (mold_v1-222)", order == sorted(order) and "systemctl" not in b, order)
    ids = [s["id"] for s in V.plan(S, B.MOLD)]
    check("migration: across the deploy: accounts (packages) -> egress rule that names them (firewall) -> hand over, build -> database -> prewarm -> switch -> health",
          ids.index("packages") < ids.index("firewall") < ids.index("source") < ids.index("build") < ids.index("db-chain") < ids.index("prewarm") < ids.index("switch") < ids.index("health"), ids)
    pk = Bn["packages.sh"][0]
    body = [l for l in pk.splitlines() if not l.startswith("#")]
    check("migration: the packages step, which runs while the old services are still serving, makes accounts and re-owns NOTHING",
          not any(l.startswith(("chown", "chmod")) for l in body) and not any("install -d" in l and (" -o " in l or data in l or S["app_dir"] in l or "/var/lib/sf" in l) for l in body)
          and all(f"useradd --system --user-group --home-dir {h} --no-create-home --shell /usr/sbin/nologin {u}" in pk for u, h in ((WEB, V.SERVICE_HOMES["web"]), (WORK, V.SERVICE_HOMES["workflow"]), (V.BUILD_USER, V.BUILD_HOME))), body[-8:])
    us = Bn["users.sh"][0]; ub = [l for l in us.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    everything = "\n".join(Bn[k][0] for k in ("users.sh", "seal.sh", "storage-view.sh", "build.sh", "db-chain.sh", "packages.sh"))
    code_lines = [l for l in everything.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    check("migration: no script in it removes or moves anything, or names the database", not [l for l in code_lines if re.search(r"(^|[;&|]\s*|\s)(rm|mv|rmdir|dropdb|pg_dropcluster|truncate|shred)\s", l)]
          and "postgres" not in us + Bn["seal.sh"][0] + Bn["storage-view.sh"][0] and "psql" not in us)
    store = f"{V.SERVICE_HOME}/.microsandbox"
    check("migration: the sandbox store and the file store are only ever LOOKED at (stat), never the object of chown, chmod, install or mount --move",
          not [l for l in ub if store in l and not ("stat -c" in l or l.startswith("if [ -e") or "refusing" in l)]
          and not [l for l in ub if S["storage_dir"] + " " in l + " " and l.startswith(("chown", "chmod"))], [l for l in ub if store in l])
    # ---- the real users.sh, against a server that ran everything as one user
    old = [(V.SERVICE_HOME, API), (store, API), (data, API), (f"{data}/workflow-data", API), (f"{data}/task-workflow-data", API), (S["storage_dir"], API), (f"{data}/build-stamps", API)]
    svc, _ = V.unit_names(S, crons)
    box = Box(tmp, "old-server", users=[API], active=svc, owners=old)
    script = V.users_sh(S, crons, root=box.root)
    r = box.run(script, guard=None)
    check("users.sh: it refuses to run at all without the deploy's marker", r.returncode == 3 and box.calls() == [])
    r = box.run(script)
    check("users.sh: with a service still running it refuses, having made no account and handed over nothing", r.returncode == 5 and "still running" in r.stderr and box.calls() == [], (r.stderr, box.calls()))
    for u in svc: subprocess.run([os.path.join(box.d, "bin", "systemctl"), "stop", u])
    mark = len(box.calls()); r = box.run(script); c = box.calls()[mark:]
    check("users.sh: once the services are stopped it runs", r.returncode == 0 and "users: " in r.stdout, r.stderr)
    made = [l.split()[-1] for l in c if l.startswith("useradd")]
    check("users.sh:   ...makes the three new accounts and not the one that exists", made == [WEB, WORK, V.BUILD_USER] and f"groupadd --system {V.CODE_GROUP}" in c, made)
    check("users.sh:   ...lets the three services, and nobody else, read the code", sorted(l.split()[-1] for l in c if l.startswith(f"usermod -a -G {V.CODE_GROUP}")) == sorted([WEB, API, WORK]))
    first_hand = next(i for i, l in enumerate(c) if l.startswith(("install", "chown")))
    check("users.sh:   ...accounts first, directories after", max(i for i, l in enumerate(c) if l.startswith(("useradd", "usermod", "groupadd"))) < first_hand, c)
    check("users.sh:   ...the task-workflow service's data changes hands, to that service alone", box.owner(f"{data}/task-workflow-data") == WORK and f"chown -hR {WORK}:{WORK} {box.root}{data}/task-workflow-data" in c
          and f"install -d -m 700 -o {WORK} -g {WORK} {box.root}{data}/task-workflow-data" in c)
    check("users.sh:   ...eve's workflow data stays the agent's alone, and the data directory becomes root's, open to the three services' group only",
          box.owner(f"{data}/workflow-data") == API and f"install -d -m 700 -o {API} -g {API} {box.root}{data}/workflow-data" in c and f"install -d -m 750 -o root -g {V.CODE_GROUP} {box.root}{data}" in c)
    check("users.sh:   ...each user's home is its own and closed (700); the agent's is where it always was",
          all(f"install -d -m 700 -o {u} -g {u} {box.root}{h}" in c for u, h in ((WEB, V.SERVICE_HOMES["web"]), (WORK, V.SERVICE_HOMES["workflow"]), (V.BUILD_USER, V.BUILD_HOME), (API, V.SERVICE_HOME))))
    touched = [l for l in c if (box.root + store) in l or (box.root + S["storage_dir"] + " ") in (l + " ")]
    check("users.sh:   ...the sandbox store and the file store were not touched by any command (not moved, not re-owned, not re-moded)",
          touched == [] and box.owner(store) == API and box.owner(S["storage_dir"]) == API and os.path.isdir(box.root + store) and os.path.isdir(box.root + S["storage_dir"]), touched)
    check("users.sh:   ...the web app's view of the file store gets its mount point", os.path.isdir(box.root + S["storage_view"]) and f"install -d -m 755 {box.root}{S['storage_view']}" in c)
    check("users.sh:   ...and it started nothing: the services come back in release.sh switch, each as its own user", not any(l.startswith("systemctl") and ("start" in l or "restart" in l) for l in c)
          and Bn["release.sh"][0].index('timeout "$t" systemctl restart "$u"') > 0)
    # mold_v1-222: on a server already moved, users.sh runs while the services serve (the new release is built beside them)
    moved = [(V.SERVICE_HOME, API), (store, API), (data, "root"), (f"{data}/workflow-data", API), (f"{data}/task-workflow-data", WORK), (S["storage_dir"], API)]
    live = Box(tmp, "moved-server", users=names, active=svc, owners=moved)
    r = live.run(V.users_sh(S, crons, root=live.root)); lc = live.calls()
    check("users.sh: on a server already moved to one user per service it runs while the services serve, changing no owner and stopping nothing",
          r.returncode == 0 and not any(l.startswith(("useradd", "systemctl")) for l in lc) and live.owner(f"{data}/task-workflow-data") == WORK and live.lines("active") == svc, (r.stderr, lc))
    half = Box(tmp, "half-moved", users=[API, WEB, WORK, V.BUILD_USER], active=svc, owners=old)
    r = half.run(V.users_sh(S, crons, root=half.root))
    check("users.sh:   ...but where the move is still pending (the task-workflow data is not its own yet) it refuses while a service runs, and says what to do",
          r.returncode == 5 and "systemctl stop" in r.stderr and half.calls() == [], (r.stderr, half.calls()))
    mark = len(box.calls()); r = box.run(script); c2 = box.calls()[mark:]
    check("users.sh: a second run makes no account, re-makes no mount point and leaves every owner as it was",
          r.returncode == 0 and not any(l.startswith(("useradd", "usermod", "groupadd")) for l in c2) and not any(S["storage_view"] in l for l in c2)
          and box.owner(f"{data}/task-workflow-data") == WORK and box.owner(store) == API and box.owner(S["storage_dir"]) == API, c2)
    for what, path in (("sandbox store", store), ("file store", S["storage_dir"])):
        bx = Box(tmp, "foreign-" + what.replace(" ", "-"), users=[API], owners=[(p, ("someone" if p == path else o)) for p, o in old])
        r = bx.run(V.users_sh(S, crons, root=bx.root))
        check(f"users.sh: a {what} that is not the agent's stops it with a sentence, and that directory is left exactly as found",
              r.returncode == 6 and f"belongs to someone, not to {API}" in r.stderr and bx.owner(path) == "someone" and not [l for l in bx.calls() if (bx.root + path + " ") in (l + " ")], r.stderr)
    fresh = Box(tmp, "fresh-server")
    r = fresh.run(V.users_sh(S, crons, root=fresh.root))
    check("users.sh: on a fresh server it makes all four accounts and every directory, the file store as the agent's (700)",
          r.returncode == 0 and [l.split()[-1] for l in fresh.calls() if l.startswith("useradd")] == [WEB, API, WORK, V.BUILD_USER]
          and f"install -d -m 700 -o {API} -g {API} {fresh.root}{S['storage_dir']}" in fresh.calls() and fresh.owner(f"{data}/task-workflow-data") == WORK, fresh.calls())
    S3 = B._settings(lambda d: d["infrastructure"]["vm_remote"].update(storage={"driver": "s3", "endpoint": "https://s3.example.com", "bucket": "b", "region": "r", "access_key_ref": "STORAGE_S3_ACCESS_KEY_ID", "secret_key_ref": "STORAGE_S3_SECRET_ACCESS_KEY"}))
    B3 = V.bundle(S3, crons)
    check("users: with files in an object store there is no view: no script, no unit, no web-only storage path, and the web unit requires none",
          "storage-view.sh" not in B3 and not [k for k in B3 if "-storage.service" in k] and "storage" not in V.users_sh(S3, crons).lower().replace("sandbox store", "")
          and V.service_env_spec(S3)["web"]["set"] == {} and "Requires=" not in B3[f"units/{pre}-web.service"][0] and "STORAGE_VIEW" not in B3["health.sh"][0])

    # ---- the code: who may read it and who may write it
    app = S["app_dir"]
    tree = [(app, V.BUILD_USER)] + [(f"{app}/{p}", V.BUILD_USER) for p in (".next", ".output", ".eve", "agent", "node_modules", "services/task-workflow/.next")]
    box = Box(tmp, "seal", users=names, owners=tree)
    r = box.run(V.seal_sh(S, root=box.root)); c = box.calls(); A = box.root + app
    check("seal.sh: first the whole tree is the code owner's, readable by the services' group and by nobody else", r.returncode == 0 and c[0] == f"chown -hR {V.BUILD_USER}:{V.CODE_GROUP} {A}" and c[1] == f"chmod -R u=rwX,g=rX,o= {A}", (r.stderr, c[:2]))
    check("seal.sh: then each service gets exactly what it writes: .next the web app's; .output, .eve and the prewarm's lock directory the agent's; the task-workflow build that service's",
          box.owner(f"{app}/.next") == WEB and box.owner(f"{app}/.output") == API and box.owner(f"{app}/.eve") == API and box.owner(f"{app}/.eve-build-hidden") == API
          and box.owner(f"{app}/services/task-workflow/.next") == WORK and f"chown -hR {WEB}:{WEB} {A}/.next" in c and f"chown -hR {WORK}:{WORK} {A}/services/task-workflow/.next" in c, c)
    check("seal.sh:   ...agent/ is the agent's to write (the prewarm's sandbox wrappers) and the group's to read", f"chown -hR {API}:{V.CODE_GROUP} {A}/agent" in c and box.owner(f"{app}/agent") == API)
    check("seal.sh:   ...the code's root and node_modules stay the code owner's: no service can change what another runs", box.owner(app) == V.BUILD_USER and box.owner(f"{app}/node_modules") == V.BUILD_USER
          and not [l for l in c[2:] if l.split()[-1] in (A, f"{A}/node_modules")])
    check("seal.sh:   ...the prewarm's lock directory is made for the agent, because it cannot make it in a directory it may not write", f"install -d -m 750 -o {API} -g {API} {A}/.eve-build-hidden" in c)
    bare = Box(tmp, "seal-bare", users=names, owners=[(app, "root")])
    r = bare.run(V.seal_sh(S, root=bare.root))
    check("seal.sh: a tree with no build in it yet is sealed without an error (nothing that is absent is chowned)", r.returncode == 0 and not [l for l in bare.calls() if "/.next" in l or "/.output" in l or "/agent" in l], bare.calls())
    dc = Bn["db-chain.sh"][0]
    check("seal: the database step, which runs the mold's scripts as root inside the code, seals it again and no longer hands the tree to one user",
          dc.index("host-chain") < dc.index("env-split") < dc.index("/factory/seal.sh") and "chown" not in dc)
    src = B.MOLD
    reads = {"lib/storage/filesystem.ts": ("mode: 0o700", "0o600"), "scripts/eve-build.mjs": ('".eve-build-hidden"', "mkdirSync(DIR, { recursive: true })"),
             "scripts/lib/sandbox-overlay.mjs": ("renameSync(slot, kept)", "writeFileSync(slot, wrapperSource"), "scripts/sandbox-prewarm-serial.mjs": ('join(appRoot, ".eve", "sandbox-cache", "template-locks")', "withAgentTreeLock")}
    for rel, needles in reads.items():
        try: text = open(os.path.join(src, rel)).read()
        except OSError: text = ""
        check(f"what the snapshot's own code reads and writes is as these scripts assume: {rel}", all(n in text for n in needles), [n for n in needles if n not in text])

    # ---- the file store: one owner on disk, a view for the web app
    spec = V.service_env_spec(S)
    check("storage: the agent reads the file store where it is; the web app reads it through its own view; nobody else gets a storage path",
          V.config_pairs(S)["STORAGE_FS_ROOT"] == S["storage_dir"] and spec["web"]["set"] == {"STORAGE_FS_ROOT": S["storage_view"]} and spec["api"]["set"] == {}
          and "STORAGE_FS_ROOT" not in (spec["workflow"]["keep"] + spec["cron"]["keep"]) and S["storage_view"] != S["storage_dir"])
    master = dict(V.config_pairs(S), DATABASE_URL="postgresql://app_rw:x@127.0.0.1:5432/a")
    split = V.split_values(master, spec)
    check("storage:   ...and that is what lands in each service's env file", split["web"]["STORAGE_FS_ROOT"] == S["storage_view"] and split["api"]["STORAGE_FS_ROOT"] == S["storage_dir"] and "STORAGE_FS_ROOT" not in split["workflow"])
    web_unit = U[f"{pre}-web.service"]; view_unit = U[f"{pre}-storage.service"]
    check("storage: the web app starts only after its view is mounted, and stops with it", f"Requires={pre}-storage.service\n" in web_unit and f"{pre}-storage.service" in web_unit.split("After=")[1].split("\n")[0]
          and "storage-view.sh up" in view_unit and "storage-view.sh down" in view_unit and "RemainAfterExit=yes" in view_unit and "WantedBy=multi-user.target" in view_unit, web_unit)
    us_ = Bn["release.sh"][0]
    check("storage: the switch mounts the view before it restarts the services (start, never restart: the serving web app uses it), and says why if it cannot",
          us_.index(f"systemctl start {pre}-storage.service") < us_.index('timeout "$t" systemctl restart "$u"') and f"systemctl restart {pre}-storage.service" not in us_ and "could not be mounted" in us_)
    real, view = S["storage_dir"], S["storage_view"]
    box = Box(tmp, "view", users=[API, WEB], owners=[(real, API), (view, "root")])
    sv = V.storage_view_sh(S, root=box.root)
    r = box.run(sv, "up"); c = box.calls()
    want = f"mount --bind -o X-mount.idmap=u:60001:60002:1 g:60001:60002:1 {box.root}{real} {box.root}{view}"
    check("storage-view.sh: `up` mounts the store at the view with the agent's ids on disk shown as the web app's (on-disk id first)", r.returncode == 0 and c == [want] and "is seen by" in r.stdout, (c, r.stderr))
    r = box.run(sv, "up")
    check("storage-view.sh:   ...a second `up` does nothing", r.returncode == 0 and box.calls() == [want] and "already in place" in r.stdout)
    r = box.run(sv, "down")
    check("storage-view.sh:   ...`down` unmounts it, and a second `down` is harmless", r.returncode == 0 and box.calls()[-1] == f"umount {box.root}{view}" and box.run(sv, "down").returncode == 0 and len(box.calls()) == 2)
    open(os.path.join(box.d, "mount-shows-wrong-owner"), "w").close(); mark = len(box.calls()); r = box.run(sv, "up")
    check("storage-view.sh: a server that cannot make the view is told so, and the half-made mount is taken down again", r.returncode == 1 and "does not support id-mapped mounts" in r.stderr
          and [l.split()[0] for l in box.calls()[mark:]] == ["mount", "umount"], (r.stderr, box.calls()[mark:]))
    bx = Box(tmp, "view-foreign", users=[API, WEB], owners=[(real, "someone"), (view, "root")])
    r = bx.run(V.storage_view_sh(S, root=bx.root), "up")
    check("storage-view.sh: a file store that is not the agent's is not mounted anywhere", r.returncode == 1 and bx.calls() == [] and "refusing" in r.stderr)
    check("storage-view.sh: it is valid shell and asks for nothing but the two verbs", subprocess.run(["bash", "-n", os.path.join(box.d, "script.sh")]).returncode == 0 and box.run(sv, "sideways").returncode == 2)
    _real_view(check, S)

    # ---- the egress rule
    nft = V.egress_nft(S); rules = [l.strip() for l in nft.splitlines() if l.strip().startswith("meta skuid")]
    who = '{ "' + '", "'.join(V.EGRESS_USERS) + '" }'
    check("egress: two lines, both for every one of the app's users: private networks refused, and this server's own SSH port dropped on every address it holds",
          rules == [f"meta skuid {who} ip daddr {{ {', '.join(V.EGRESS_DENY)} }} reject with icmpx type admin-prohibited", f"meta skuid {who} fib daddr type local tcp dport 22 drop"]
          and API in V.EGRESS_USERS and set(V.EGRESS_USERS) == {WEB, API, WORK, V.BUILD_USER}, rules)
    check("egress:   ...443 is not mentioned, so the web origin a sandbox downloads data-room files from stays reachable", "443" not in "\n".join(rules) and "dport 22 drop" in rules[1] and "accept;" in nft)
    check("egress:   ...no address is written into it (every address the server holds, whatever they are)", not re.search(r"\d+\.\d+\.\d+\.\d+", rules[1]) and V.egress_ssh_rule(S) in rules[1])
    S22 = B._settings(lambda d: d["infrastructure"]["vm_remote"].update(ssh_port=2222))
    check("egress:   ...a moved SSH port is the one dropped", "tcp dport 2222 drop" in V.egress_nft(S22) and "dport 22 " not in V.egress_nft(S22) and V.egress_ssh_rule(S22).endswith("dport 2222 drop"))
    check("egress: the unit that loads it at boot still runs before the API", f"Before={pre}-api.service" in U[f"{pre}-egress.service"] and "egress.nft" in U[f"{pre}-egress.service"])
    _real_egress(check, S, tmp)

    # ---- health: every process's user, what the agent's user can reach, the egress rule
    h = Bn["health.sh"][0]
    for needle, what in ((f'echo "WEB_USER=$(user_of "$wpid")"', "the web app's user"), ('echo "WORKFLOW_USER=$(user_of "$fpid")"', "the task-workflow service's user"), ("API_USER=", "the agent API's user"),
                         (f"as_api() {{ runuser -u {API} -- \"$@\" >/dev/null 2>&1; }}", "everything tried as the agent's user"),
                         (f"as_api head -c 1 {S['env_dir']}/web.env", "the web app's env file, tried as the agent's user"),
                         ('as_api head -c 1 "/proc/$wpid/environ"', "the running web app's environment, tried as the agent's user"),
                         (f"as_api test -w {S['app_dir']}/node_modules", "the shared code, tried for writing as the agent's user"),
                         (f"grep -qF '{V.egress_ssh_rule(S)}'", "the loaded egress rule"), ('tcp "$own" 22', "this server's own SSH port, tried as the agent's user"), ('tcp "$own" 443', "this server's own 443, tried as the agent's user"),
                         (f"mountpoint -q {S['storage_view']}", "the web app's view of the file store"), ("KVM_MEMBERS=", "who is in group kvm"), ("SANDBOX_STORE_OWNER=", "the sandbox store's owner")):
        check(f"health.sh reads {what}", needle in h, needle)
    check("health.sh is still read-only and valid shell: it asks, as each user, and changes nothing", "READ-ONLY" in h and not re.search(r"(^|[;&|]\s*)(rm|mv|chown|chmod|install|systemctl (start|stop|restart)|mount|umount|nft -f)\s", h, re.M))
    ok = V.parse_kv(B.fx("health-ok.txt")); hv, bad = V.health_verdict(S, ok, crons)
    check("health: a server with separate users is accepted and recorded as such", bad == [] and hv["users"] == "separate" and hv["egress_ssh"] == "blocked", (hv, bad))
    def sick(**kw): return V.health_verdict(S, dict(ok, **kw), crons)
    for label, kw, needle, key, val in (
            ("the web app still running as the agent's user", {"WEB_USER": API}, f"the web service runs as {API}", "users", "not_separate"),
            ("the task-workflow service running as the agent's user", {"WORKFLOW_USER": API}, f"must run as its own user {WORK}", "users", "not_separate"),
            ("the agent API running as the web app's user", {"API_USER": WEB}, f"must run as its own user {API}", "users", "not_separate"),
            ("a web process in group kvm", {"WEB_IN_KVM": "yes"}, "web app's process is in group kvm", "users", "not_separate"),
            ("another user added to group kvm", {"KVM_MEMBERS": f"{API},{WEB}"}, f"member(s) {WEB}", "users", "not_separate"),
            ("an agent user that can open web.env", {"AGENT_READS_WEB_ENV": "yes"}, "can open the web app's env file", "users", "not_separate"),
            ("an agent user that can read the web process's environment", {"AGENT_READS_WEB_PROC": "yes"}, "environment under /proc", "users", "not_separate"),
            ("a web app that was not running when its environment was tried", {"AGENT_READS_WEB_PROC": "unread"}, "could not be tried", "users", "not_separate"),
            ("an agent user that can write shared code", {"AGENT_WRITES_CODE": "yes"}, "write code that another service runs", "users", "not_separate"),
            ("a sandbox store owned by somebody else", {"SANDBOX_STORE_OWNER": WEB}, "sandbox store belongs to", "users", "not_separate"),
            ("an agent home others can enter", {"API_HOME": f"755 {API}"}, "must be mode 700", "users", "not_separate"),
            ("a missing egress line for the SSH port", {"EGRESS_SSH_RULE": "no"}, "is not loaded", "egress_ssh", "open"),
            ("an SSH port the agent's user could open", {"EGRESS_SSH": "open"}, "so a sandbox could too", "egress_ssh", "open"),
            ("443 closed to the agent's user", {"EGRESS_WEB": "blocked"}, "downloads data-room files", "egress_ssh", "blocked"),
            ("a view that is not mounted", {"STORAGE_VIEW": "unmounted"}, "view of the file store is unmounted", "users", "separate"),
            ("a file store the web app cannot write", {"WEB_STORAGE": "closed"}, "the web app cannot write the file store", "users", "separate"),
            ("a file store the agent cannot write", {"API_STORAGE": "closed"}, "the agent cannot write the file store", "users", "separate")):
        hv, bad = sick(**kw)
        check(f"health refuses {label}", any(needle in x for x in bad) and hv[key] == val, (hv, bad))
    hv, bad = V.health_verdict(S, {k: v for k, v in ok.items() if k not in ("WEB_USER", "AGENT_READS_WEB_ENV", "EGRESS_SSH_RULE")}, crons)
    check("health: a fact the server did not report is a refusal, not a pass", len(bad) >= 3 and hv["users"] == "not_separate" and hv["egress_ssh"] == "open", bad)
    hv, bad = V.health_verdict(S, dict(ok, API_USER="root"), crons)
    check("health: the API as root is still said once, in its own words", len([x for x in bad if "API runs as root" in x]) == 1 and not [x for x in bad if "the api service runs as" in x], bad)
    hv, bad = V.health_verdict(S, dict(ok, SANDBOX_STORE_OWNER="missing", EGRESS_SSH="unread", EGRESS_WEB="unread"), crons)
    check("health: a store that does not exist yet, and an address the probe could not learn, are not failures while the rule itself is loaded", bad == [] and hv["egress_ssh"] == "blocked", bad)
    sch = B.load(os.path.join(B.ROOT, "state/application/app_id/infrastructure.schema.json"))
    d = B.fixture_docs(); d["infrastructure"]["vm_remote"]["health"] = dict(V.health_verdict(S, ok, crons)[0], qualified_at="2026-10-04T12:00:00+00:00")
    check("health: what it records fits the schema", B.F._check(d["infrastructure"], sch, "x") == [], B.F._check(d["infrastructure"], sch, "x"))
    out, printed = B.quiet(V.check, "vm_remote_fixture", *(B.load(os.path.join(V.FIXTURE, f"{k}.json")) for k in ("application", "infrastructure", "datastores")), V.FIXTURE)
    check("users: the offline check says who runs what and what the health step tries", f"the web app runs as {WEB}, the agent API as {API}" in printed and "only one in group kvm" in printed and f"the code belongs to {V.BUILD_USER}" in printed, printed[-1500:])

def _real_view(check, S):
    """The id-mapped view for real, in a PRIVATE mount namespace (nothing outside the process ever sees the mount): the
    generated script mounts it, and two stand-in uids then use the store the way the app's storage driver does (folders
    700, files 600, written under tmp/ and linked into place). Skipped where this machine cannot do it."""
    try: ver = subprocess.run(["mount", "--version"], capture_output=True, text=True).stdout
    except OSError: ver = ""
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("setpriv") or "idmapping" not in ver or not os.path.isdir("/var/tmp"): return
    d = tempfile.mkdtemp(prefix="sf-view-selftest-", dir="/var/tmp")
    try:
        os.chmod(d, 0o755); real = d + S["storage_dir"]; view = d + S["storage_view"]; os.makedirs(real); os.makedirs(view); os.makedirs(os.path.join(d, "bin"))
        for p in (d + S["data"], os.path.dirname(d + S["data"]), os.path.dirname(os.path.dirname(d + S["data"])), os.path.dirname(os.path.dirname(os.path.dirname(d + S["data"])))): os.chmod(p, 0o755)
        os.chown(real, 60001, 60001); os.chmod(real, 0o700)
        # the two users exist only on a server: `id` and `stat -c %U` answer for the stand-in uids, everything else is real
        open(os.path.join(d, "bin", "id"), "w").write(f"#!/bin/bash\ncase \"${{@: -1}}\" in {API}) echo 60001 ;; {WEB}) echo 60002 ;; *) exit 1 ;; esac\n")
        open(os.path.join(d, "bin", "stat"), "w").write(f"#!/bin/bash\ncase \"$(/usr/bin/stat -c %u \"${{@: -1}}\")\" in 60001) echo {API} ;; 60002) echo {WEB} ;; *) echo other ;; esac\n")
        for n in ("id", "stat"): os.chmod(os.path.join(d, "bin", n), 0o755)
        open(os.path.join(d, "view.sh"), "w").write(V.storage_view_sh(S, root=d))
        probe = f'''
import os, sys
sys.stdout.reconfigure(line_buffering=True)
view, real = {view!r}, {real!r}
def as_(uid, fn):
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([]); os.setgid(uid); os.setuid(uid); print(fn()); sys.stdout.flush(); os._exit(0)
        except Exception as e:
            print("ERR", type(e).__name__, e); sys.stdout.flush(); os._exit(1)
    return os.waitpid(pid, 0)[1] == 0
def web_writes():
    os.makedirs(view + "/objects/orgs/x", mode=0o700); os.makedirs(view + "/tmp", mode=0o700)
    fd = os.open(view + "/tmp/t1", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, b"from the web app"); os.fsync(fd); os.close(fd)
    os.link(view + "/tmp/t1", view + "/objects/orgs/x/upload"); os.unlink(view + "/tmp/t1")
    return "WEB-WROTE uid=%d" % os.stat(view + "/objects/orgs/x/upload").st_uid
def api_reads_and_writes():
    got = open(real + "/objects/orgs/x/upload").read()
    fd = os.open(real + "/objects/orgs/x/note", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, b"from the agent"); os.close(fd)
    return "API-READ " + got
def web_reads(): return "WEB-READ " + open(view + "/objects/orgs/x/note").read()
def closed(path):
    try: os.listdir(path); return "OPEN"
    except PermissionError: return "CLOSED"
print("up", as_(60002, web_writes), as_(60001, api_reads_and_writes), as_(60002, web_reads))
st = os.stat(real + "/objects/orgs/x/upload"); print("ONDISK uid=%d mode=%o dir=%o" % (st.st_uid, st.st_mode & 0o777, os.stat(real + "/objects/orgs/x").st_mode & 0o777))
as_(60002, lambda: "WEB-DIRECT " + closed(real)); as_(60003, lambda: "THIRD-VIEW " + closed(view)); as_(60001, lambda: "API-VIEW " + closed(view))
'''
        open(os.path.join(d, "probe.py"), "w").write(probe)
        sh = (f'export PATH={d}/bin:/usr/sbin:/usr/bin:/sbin:/bin; bash {d}/view.sh up || exit 9; mountpoint -q {view} && echo MOUNTED; bash {d}/view.sh up; '
              f'{sys.executable} {d}/probe.py; bash {d}/view.sh down; mountpoint -q {view} || echo UNMOUNTED')
        r = subprocess.run(["unshare", "-m", "bash", "-c", sh], capture_output=True, text=True, timeout=60)
        out = r.stdout
        if r.returncode == 9 and "MOUNTED" not in out: return        # this kernel or filesystem cannot make the mount: not a verdict on the script
        RAN.append("the id-mapped view of the file store mounted for real in a private mount namespace")
        check("storage (real mount, private namespace): the generated script mounts the view, a second `up` keeps it, `down` removes it",
              "MOUNTED" in out and "already in place" in out and out.rstrip().endswith("UNMOUNTED"), out + r.stderr)
        check("storage (real mount):   ...the web app's uid writes a 700 folder and a 600 file through the view, as their owner", "WEB-WROTE uid=60002" in out, out + r.stderr)
        check("storage (real mount):   ...on disk they belong to the agent's uid, modes untouched, and the agent reads them and writes its own", "ONDISK uid=60001 mode=600 dir=700" in out and "API-READ from the web app" in out, out)
        check("storage (real mount):   ...and the web app reads what the agent wrote", "WEB-READ from the agent" in out, out)
        check("storage (real mount):   ...the store itself stays closed to the web app's uid, and the view to everyone but it", "WEB-DIRECT CLOSED" in out and "THIRD-VIEW CLOSED" in out and "API-VIEW CLOSED" in out, out)
        check("storage (real mount):   ...nothing is left mounted on this machine", not [l for l in open("/proc/self/mounts") if d in l])
    finally:
        shutil.rmtree(d, ignore_errors=True)

def _real_egress(check, S, tmp):
    """The egress rule for real, in a PRIVATE network namespace (its own loopback and its own empty firewall, gone with
    the process): a stand-in public address on lo, something listening on the SSH port and on 443, and a connection
    tried as a uid the rule names and as one it does not. Skipped where this machine cannot do it."""
    nft = shutil.which("nft") or ("/usr/sbin/nft" if os.path.exists("/usr/sbin/nft") else None)
    if os.geteuid() != 0 or not nft or not shutil.which("unshare") or not shutil.which("ip"): return
    d = os.path.join(tmp, "egress-real"); os.makedirs(d)
    text = V.egress_nft(S)
    for i, u in enumerate(V.EGRESS_USERS): text = text.replace(f'"{u}"', str(60001 + i))
    text = "\n".join(l for l in text.splitlines() if l.strip() != "delete table inet sf_egress" and l.strip() != "table inet sf_egress")     # a fresh namespace has no table to replace
    open(os.path.join(d, "egress.nft"), "w").write(text + "\n")
    probe = '''
import os, socket, sys, threading
addr = "203.0.113.5"
for port in (22, 443):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(16)
    threading.Thread(target=lambda s=s: [s.accept() for _ in range(16)], daemon=True).start()
def probe(a, p):
    c = socket.socket(); c.settimeout(1.5)
    try: c.connect((a, p)); return "open"
    except OSError: return "blocked"
    finally: c.close()
def as_(uid):
    pid = os.fork()
    if pid == 0:
        os.setgroups([]); os.setgid(uid); os.setuid(uid)
        print("uid", uid, " ".join(f"{a}:{p}={probe(a, p)}" for a in (addr, "127.0.0.1") for p in (22, 443))); sys.stdout.flush(); os._exit(0)
    os.waitpid(pid, 0)
as_(60002); as_(60009)
'''
    open(os.path.join(d, "probe.py"), "w").write(probe)
    sh = f"ip link set lo up && ip addr add 203.0.113.5/32 dev lo && {nft} -f {d}/egress.nft && {nft} list table inet sf_egress && {sys.executable} {d}/probe.py"
    r = subprocess.run(["unshare", "-n", "sh", "-c", sh], capture_output=True, text=True, timeout=60)
    if r.returncode and "uid 60002" not in r.stdout: return                # no namespace, no nft in it: not a verdict on the rule
    RAN.append("the egress rule loaded for real in a private network namespace")
    out = r.stdout
    check("egress (real rule, private namespace): loaded, it lists in the words the health step looks for", V.egress_ssh_rule(S) in out, out + r.stderr)
    check("egress (real rule):   ...a user it names cannot open the server's own SSH port, on its public address or on loopback, and CAN open 443 on both",
          "uid 60002 203.0.113.5:22=blocked 203.0.113.5:443=open 127.0.0.1:22=blocked 127.0.0.1:443=open" in out, out)
    check("egress (real rule):   ...a user it does not name is not affected", "uid 60009 203.0.113.5:22=open 203.0.113.5:443=open 127.0.0.1:22=open 127.0.0.1:443=open" in out, out)

# ---------------------------------------------------------------------------------------------------------
# the brief's workspace, on the server (mold_v1-152)
# ---------------------------------------------------------------------------------------------------------
DB_URL = "postgresql://app_rw:Zk3-app-rw-PASSWORD-77@127.0.0.1:5432/vmremotefixture?sslmode=require"

def _deployed(tmp, name, mut=None):
    """A temp copy of the fixture's state, deployed (so the workspace step has a database to write to)."""
    d = os.path.join(tmp, name, "vm_remote_fixture"); shutil.copytree(V.FIXTURE, d)
    docs = {n: B.load(os.path.join(d, f"{n}.json")) for n in ("application", "infrastructure", "datastores")}
    docs["infrastructure"]["vm_remote"]["production_url"] = "https://app.example.com"; docs["infrastructure"]["deployed_at"] = "2026-10-04T10:00:00+00:00"
    if mut: mut(docs)
    for n, v in docs.items(): json.dump(v, open(os.path.join(d, f"{n}.json"), "w"), indent=2)
    return d, docs

def workspace(check, tmp):
    crons = list(V.CRONS); P = B.P
    app = B.fixture_docs()["application"]
    app["workspace"].update(members=[{"email": "Operator@Example.com", "role": "owner"}, {"email": "ana@example.com", "role": "admin"}, {"email": "ben@example.com", "role": "member"}],
                            roster=[{"email": "operator@example.com", "name": "Operator"}, {"email": "ana@example.com", "name": "Ana", "team": "Credit", "manager_email": "operator@example.com", "escalations": [{"email": "operator@example.com", "reason": "limits"}]}],
                            platform_admins=["operator@example.com"])
    app["workspace"]["org"].update(google_hosted_domain="example.com", display_name="Example Co")
    SURFACE = {"primary_context": {"corpus": [], "instructions": {"workspace": "Answer from the files. Cite the page.", "persona_name": "Ava", "tone": "plain", "default_mode": "build", "model": "@cf/zai-org/glm-5.2",
                                                             "subagents": [{"agent_key": "research", "paused": False}, {"agent_key": "filings", "paused": True, "instructions": "Quote the clause."}]}},
               "web_search": {"enabled": True, "default_on_for_agent": True}, "browser": {"enabled": False, "default_on_for_agent": False},
               "custom_workflow_builder": {"library": {"install": "all"}, "definitions": [{"id": "wd-credit", "name": "Credit review", "entity": "todo", "is_default": True, "stages": [{"id": "open"}, {"id": "done"}]}],
                                           "scripts": [{"name": "weekly-digest", "description": "Digest", "trigger": "manual", "steps": [{"say": "hi"}]}, {"name": "from-a-file", "file": "workflows/x.json"}]}}
    seed = V.state_seed(app)
    check("workspace: state's own workspace becomes a seed: the org row's id, name, shown name and hosted domain", (seed["org_id"], seed["name"], seed["google_hosted_domain"], seed["display_name"]) == ("example", "Example", "example.com", "Example Co"), seed)
    check("workspace:   ...the owner, and every member with its role (emails lower-cased, names from the roster)", seed["owner"] == "operator@example.com"
          and seed["members"] == [{"email": "operator@example.com", "role": "owner", "name": "Operator"}, {"email": "ana@example.com", "role": "admin", "name": "Ana"}, {"email": "ben@example.com", "role": "member"}], seed["members"])
    check("workspace:   ...the platform administrators and the people roster with reporting lines", seed["platform_admins"] == ["operator@example.com"] and seed["roster"][1]["manager_email"] == "operator@example.com" and seed["roster"][1]["escalations"])
    check("workspace:   ...and nothing that is not a name, an email, a role or the logo", set(seed) <= {"org_id", "name", "google_hosted_domain", "owner", "members", "platform_admins", "roster", "display_name", "logo_url"})
    out, _ = B.quiet(V.state_seed, {"app_id": "x", "workspace": {"org": {"org_id": "x", "name": "X"}, "members": []}})
    check("workspace: a state that names no owner is refused in a sentence", isinstance(out, V.Stop) and "owner" in str(out))
    d, docs = _deployed(tmp, "ws-plan", lambda x: x["application"].update(workspace=app["workspace"], surface=SURFACE))
    sdir = os.path.join(d, "seed", "orgs"); os.makedirs(os.path.join(sdir, "second")); os.makedirs(os.path.join(sdir, "example"))
    json.dump({"org_id": "second", "name": "Second Desk", "google_hosted_domain": "second.example", "owner": "operator@example.com", "note": "x", "members": [{"email": "cy@second.example", "role": "member", "name": "Cy"}]}, open(os.path.join(sdir, "second.json"), "w"))
    json.dump({"customers": [{"id": "acme", "name": "Acme"}, {"id": "globex", "name": "Globex"}]}, open(os.path.join(sdir, "second", "customers.json"), "w"))
    json.dump({"customers": [{"id": "initech", "name": "Initech"}]}, open(os.path.join(sdir, "example", "customers.json"), "w"))
    plan = V.workspace_plan("vm_remote_fixture", docs["application"], d)
    check("workspace: the plan is the state's own workspace first, then every seed under seed/orgs/, each with the companies beside it",
          [k for k, _, _ in plan] == [V.STATE_SEED, "second.json"] and len(plan[0][2]["customers"]) == 1 and len(plan[1][2]["customers"]) == 2 and "note" not in plan[1][2]["seed"], [(k, l) for k, l, _ in plan])
    check("workspace:   ...the state's own is guarded against a server that already has other workspaces; an explicit seed is not", plan[0][2]["seed"].get("guard") == "no_other_workspace" and "guard" not in plan[1][2]["seed"]
          and "guard" not in V.workspace_plan("vm_remote_fixture", docs["application"], d, new_workspace=True)[0][2]["seed"])
    only = V.workspace_plan("vm_remote_fixture", docs["application"], d, only=os.path.join(sdir, "second.json"))
    check("workspace:   ...and one named seed file writes just that workspace", [k for k, _, _ in only] == ["second.json"] and len(only[0][2]["customers"]) == 2)
    json.dump({"org_id": "bad", "name": "Bad", "owner": "o@example.com", "members": [{"email": "a@example.com", "role": "member", "password": "hunter2"}]}, open(os.path.join(sdir, "bad.json"), "w"))
    out, _ = B.quiet(V.workspace_plan, "vm_remote_fixture", docs["application"], d)
    check("workspace: a seed with a password field is refused before anything is contacted, as workspace.py refuses it", isinstance(out, V.Stop) and "password" in str(out) and "Nothing was contacted" in str(out) and "hunter2" not in str(out))
    os.remove(os.path.join(sdir, "bad.json"))
    json.dump({"org_id": "example", "name": "Example Renamed", "owner": "operator@example.com", "members": []}, open(os.path.join(sdir, "example.json"), "w"))
    out, _ = B.quiet(V.workspace_plan, "vm_remote_fixture", docs["application"], d)
    check("workspace: a seed file that names the state's own workspace differently is refused: one of the two is out of date", isinstance(out, V.Stop) and "make them agree" in str(out))
    os.remove(os.path.join(sdir, "example.json"))

    # ---- the one remote command
    S = V.settings("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"])
    argv = V.workspace_argv(S, shown=True); remote = argv[-1]
    check("workspace: one SSH command: the factory's seed, as the web app's user, with the web service's own env file, in the built app",
          argv[0] == "ssh" and f"workspace-seed --file {S['env_files']['web']} --user {WEB} --home {V.SERVICE_HOMES['web']} --app-dir {S['app_dir']} --script {S['factory_dir']}/.claude/scripts/lib/workspace_seed.mjs" in remote
          and remote.startswith(f"env {V.GUARD_VAR}=vm_remote_fixture python3 {S['tool']} "), remote)
    check("surface: the same command names the factory's surface.mjs beside the seed, both in the factory's directory on the server", remote.endswith(f"--surface-script {S['factory_dir']}/.claude/scripts/lib/surface.mjs") and remote.count("workspace-seed ") == 1, remote)
    check("workspace:   ...never the master env file, the admin URL, or any value on the command line", f"--file {S['env_file']} " not in remote and "POSTGRES_ADMIN_URL" not in remote and "postgres" not in remote and "@example.com" not in remote and "DATABASE_URL" not in remote)
    copies = [rel for _, rel in V.bundle_copies()]
    check("workspace:   ...the seed is one of the scripts every bundle carries to the server", ".claude/scripts/lib/workspace_seed.mjs" in copies)
    check("surface:   ...and so is surface.mjs", ".claude/scripts/lib/surface.mjs" in copies)

    # ---- what is sent for the surface (mold_v1-163)
    sd = V.surface_doc(docs["application"]); st_ = sd["state"]
    check("surface: what is sent is the workspace's id and the four tables the seed does not write", sd["org_id"] == "example" and sd["only"] == ["agent_profiles", "agent_configs", "workflow_definitions", "workflows"] == list(V.SURFACE_TABLES), sd["only"])
    check("surface:   ...the default profile's fields, the subagent configs, the definitions and the scripts, as state has them", st_["surface"]["primary_context"]["instructions"] == SURFACE["primary_context"]["instructions"]
          and st_["surface"]["web_search"] == SURFACE["web_search"] and st_["surface"]["browser"] == SURFACE["browser"]
          and st_["surface"]["custom_workflow_builder"] == {"definitions": SURFACE["custom_workflow_builder"]["definitions"], "scripts": SURFACE["custom_workflow_builder"]["scripts"]}, st_)
    check("surface:   ...the operator as the author of the rows, and nothing else of the workspace (no members, no roster, no admins)", st_["workspace"] == {"org": {"org_id": "example", "name": "Example"}, "operator_self": {"email": "operator@example.com"}}, st_["workspace"])
    check("surface:   ...a state with no surface asks for none", V.surface_doc({"app_id": "x", "workspace": app["workspace"]}) is None and V.surface_digest({"app_id": "x", "workspace": app["workspace"]}) is None)
    src_mjs = open(os.path.join(HERE, "surface.mjs")).read(); listed = re.search(r"const APPLY_TABLES = \[([^\]]*)\]", src_mjs)
    apply_tables = re.findall(r'"(\w+)"', listed.group(1)) if listed else []
    check("surface: every table surface.mjs apply writes is written on a server by exactly one of the two steps", listed and set(re.findall(r'await up\("(\w+)"', src_mjs)) == set(apply_tables)
          and set(apply_tables) == set(V.SURFACE_TABLES) | {"orgs", "org_members", "platform_admins", "people_roster"}, apply_tables)
    seed_mjs = open(os.path.join(HERE, "workspace_seed.mjs")).read()
    check("surface:   ...the other four are the workspace seed's", all(x in seed_mjs for x in ("db.insert(orgs)", "db.insert(orgMembers)", "schema.platformAdmins", "insert into people_roster")))
    scoped = re.search(r"const SCOPED = new Set\(\[([^\]]*)\]", src_mjs)
    check("surface:   ...and each of the server's four is written inside the workspace's own scope (row-level security in force), so none needs the admin connection",
          scoped and set(V.SURFACE_TABLES) <= set(re.findall(r'"(\w+)"', scoped.group(1))), scoped and scoped.group(1))

    # ---- the factory side, against a stand-in for the remote runner
    class Remote:
        """Answers the two commands the way the server does. `orgs` is what its database already holds."""
        def __init__(self, orgs=(), leak=False, no_user=False, surface="ok"): self.orgs = set(orgs); self.calls = []; self.stdin = None; self.leak = leak; self.no_user = no_user; self.surface = surface; self.workflows = set()
        def __call__(self, step, stdin=None):
            self.calls.append(step["id"])
            if step["id"] == "bundle": return B.CP(step["argv"], 0, "", "")
            self.stdin = stdin; self.argv = step["argv"]; lines = []
            if self.no_user: return B.CP(step["argv"], 1, f"workspace: this server has no user {WEB} yet: it was deployed before each service got a user of its own. Nothing was written. Deploy once, then run this again.\n", "")
            wrote = set()
            for item in json.loads(stdin)["seeds"]:
                sd = item["seed"]
                if sd.get("guard") and sd["org_id"] not in self.orgs and self.orgs:
                    lines.append("WORKSPACE " + json.dumps({"org": sd["org_id"], "other_workspaces": sorted(self.orgs), "error": "other_workspaces"})); continue
                wrote.add(sd["org_id"])
                was = sd["org_id"] in self.orgs; self.orgs.add(sd["org_id"])
                lines.append("WORKSPACE " + json.dumps({"org": sd["org_id"], "orgs": "updated" if was else "created", "org_members": 1 + len([m for m in sd["members"] if m["email"] != sd["owner"]]),
                                                        "platform_admins": len(sd.get("platform_admins") or []), "recipes": 0 if was else 5, "workflows_created": 0 if was else 13, "workflows_present": 13 if was else 0,     # answers as a server whose build names the account-delivery library: 5 recipes, 13 workflows
                                                        "people_roster": len(sd.get("roster") or sd["members"]), "customers": len(item["customers"]), "customers_in_workspace": len(item["customers"])}))
            sf = json.loads(stdin).get("surface")
            if sf and self.surface != "silent":
                cw = sf["state"]["surface"]["custom_workflow_builder"]; new = [w["name"] for w in cw["scripts"] if not w.get("file") and w["name"] not in self.workflows]
                if sf["org_id"] not in wrote: out = {"org": sf["org_id"], "skipped": "its workspace was not written in this run, so nothing of the surface was written either"}
                elif self.surface == "rls": out = {"org": sf["org_id"], "agent_profiles": 1, "agent_configs": "ERR new row violates row-level security policy for table \"agent_configs\"", "workflow_definitions": 1, "workflows": 0}
                else:
                    self.workflows |= set(new)
                    out = {"org": sf["org_id"], "agent_profiles": 1, "agent_configs": len(sf["state"]["surface"]["primary_context"]["instructions"].get("subagents") or []), "workflow_definitions": len(cw["definitions"]), "workflows": len(new)}
                lines.append("SURFACE " + json.dumps(out))
            if self.leak: lines.append(f"warning: connected to {DB_URL}")
            return B.CP(step["argv"], 1 if any('"error"' in l or '"skipped"' in l or "ERR " in l for l in lines) else 0, "\n".join(lines) + "\n", "")
    real_key = V.key_path
    V.key_path = lambda S_: os.path.join(tmp, "a-key-that-exists"); open(os.path.join(tmp, "a-key-that-exists"), "w").close()
    try:
        said = []; rem = Remote()
        rc = V.workspace_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], d, P, ["--workspace-remote", "--dry-run"], crons, runner=rem, say=said.append)
        text = "\n".join(said)
        check("workspace: --dry-run prints the two commands and what would be sent, and contacts nothing", rc == 0 and rem.calls == [] and "nothing was contacted" in said[0] and "workspace-seed --file" in text and "rsync" in said[1]
              and "the application's own workspace, example" in text and "3 members, 1 platform admin" in text and "hosted domain example.com" in text and "2 companies" in text and not os.path.exists(os.path.join(sdir, ".applied.json")), text)
        check("surface: --dry-run lists what the surface step would write, table by table, and still contacts nothing", rem.calls == [] and "then the application's surface for example" in text and "limited to 4 tables" in text
              and "agent_profiles: the workspace's default agent profile, created or updated: persona 'Ava', a tone, instructions of 37 characters, default mode build, model @cf/zai-org/glm-5.2, web search by default on, browser by default off" in text
              and "agent_configs: 2 subagent configs, created or updated: research, filings (1 paused, 1 with instructions of their own)" in text
              and "workflow_definitions: 1 workflow definition, created or updated: wd-credit" in text
              and "workflows: 1 workflow script, each added only if no workflow of that name exists: weekly-digest; 1 file-backed script(s) are not written by this step (from-a-file)" in text
              and "not touched again: the org row, members, platform admins, roster" in text, text)
        check("surface:   ...the instructions themselves are counted, never printed", "Answer from the files" not in text and "Quote the clause" not in text, text)
        one = []; V.workspace_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], d, P, ["--workspace-remote", os.path.join(sdir, "second.json"), "--dry-run"], crons, runner=rem, say=one.append)
        check("surface:   ...a run for one named seed file says it writes no surface", "is not written by a run for one named seed file" in "\n".join(one) and "agent_profiles" not in "\n".join(one), one)
        und = B.fixture_docs()
        out, _ = B.quiet(V.workspace_remote, "vm_remote_fixture", V.settings("vm_remote_fixture", und["application"], und["infrastructure"], und["datastores"]), und["application"], und["infrastructure"], V.FIXTURE, P, ["--workspace-remote"], crons, runner=rem)
        check("workspace: an app that was never deployed has no database to write to: said, and nothing contacted", isinstance(out, V.Stop) and "not deployed yet" in str(out) and rem.calls == [])
        said = []; rem = Remote(leak=True)
        rc = V.workspace_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], d, P, ["--workspace-remote"], crons, runner=rem, say=said.append)
        text = "\n".join(said); sent = json.loads(rem.stdin)
        check("workspace: a real run sends this version of the factory's scripts, then the workspaces on the stdin of ONE command", rc == 0 and rem.calls == ["bundle", "workspace"] and [x["seed"]["org_id"] for x in sent["seeds"]] == ["example", "second"]
              and sent["seeds"][0]["seed"]["members"] == seed["members"] and sent["seeds"][1]["customers"][0]["id"] == "acme" and all(json.dumps(sent["seeds"][0]["seed"]["owner"]) not in a for a in rem.argv), text)
        check("workspace:   ...it says what was written, in counts", "written: the application's own workspace, example" in text and "workspace created, 3 member(s), 1 platform admin(s), 5 recipe(s) added, starter workflows 13 installed" in text and "written: the workspace second" in text and "2 companies in the workspace" in text, text)
        check("workspace:   ...a connection string in anything the server printed is not repeated here", "Zk3-app-rw-PASSWORD-77" not in text and "***:***@" in text, text)
        rec = B.load(os.path.join(sdir, ".applied.json")); infra_now = B.load(os.path.join(d, "infrastructure.json"))
        check("surface: the surface travels on the same stdin, after the workspaces, and nothing of it is on the command line", sent.get("surface") == V.surface_doc(docs["application"]) and all("Ava" not in a and "agent_profiles" not in a for a in rem.argv), sent.get("surface"))
        check("surface:   ...it says what was written, in counts", "written: the application's surface: the default agent profile, 2 subagent config(s), 1 workflow definition(s), 1 workflow script(s) added" in text and "and the application's surface with them" in text and "SURFACE {" not in text and "WORKSPACE {" not in text, text)
        check("workspace:   ...and records what it applied, as written, where mint.py reads it", rec == {V.STATE_SEED: V.state_seed_digest(docs["application"], d), "second.json": V.seed_digest(os.path.join(sdir, "second.json")), V.SURFACE_KEY: V.surface_digest(docs["application"])}
              and infra_now.get("configured_at") == P.NOW and B.F._check(infra_now, B.load(os.path.join(B.ROOT, "state/application/app_id/infrastructure.schema.json")), "x") == [], rec)
        said = []; rc = V.workspace_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], d, P, ["--workspace-remote"], crons, runner=rem, say=said.append)
        check("workspace: a second run updates and adds nothing (idempotent)", rc == 0 and "workspace updated" in "\n".join(said) and "0 recipe(s) added" in "\n".join(said) and "13 already there" in "\n".join(said), said)
        check("surface: a second run adds no workflow script a second time", "0 workflow script(s) added" in "\n".join(said), said)
        only_said = []; rem_one = Remote(orgs=["example"])
        rc = V.workspace_remote("vm_remote_fixture", S, docs["application"], docs["infrastructure"], d, P, ["--workspace-remote", os.path.join(sdir, "second.json")], crons, runner=rem_one, say=only_said.append)
        check("surface: a run for one named seed file sends no surface", rc == 0 and "surface" not in json.loads(rem_one.stdin) and "surface" not in "\n".join(only_said), only_said)
        # the surface refused by the database, and a server that says nothing about it
        d4, docs4 = _deployed(tmp, "ws-surface-rls", lambda x: x["application"].update(workspace=app["workspace"], surface=SURFACE))
        said = []; rc = V.workspace_remote("vm_remote_fixture", S, docs4["application"], docs4["infrastructure"], d4, P, ["--workspace-remote"], crons, runner=Remote(surface="rls"), say=said.append)
        rec4 = B.load(os.path.join(d4, "seed", "orgs", ".applied.json"))
        check("surface: a table the database refused is named with its reason, the run fails, and the surface is NOT recorded as applied (the workspace is)",
              rc == 1 and "NOT finished: the application's surface: agent_configs: new row violates row-level security policy" in "\n".join(said) and V.SURFACE_KEY not in rec4 and V.STATE_SEED in rec4, said)
        d5, docs5 = _deployed(tmp, "ws-surface-silent", lambda x: x["application"].update(workspace=app["workspace"], surface=SURFACE))
        said = []; rc = V.workspace_remote("vm_remote_fixture", S, docs5["application"], docs5["infrastructure"], d5, P, ["--workspace-remote"], crons, runner=Remote(surface="silent"), say=said.append)
        check("surface: a server that says nothing about the surface is a failure, never read as written", rc == 1 and "the server said nothing about it" in "\n".join(said) and V.SURFACE_KEY not in B.load(os.path.join(d5, "seed", "orgs", ".applied.json")), said)
        # the real server's case: its workspace was made by hand under another id
        d2, docs2 = _deployed(tmp, "ws-guard", lambda x: x["application"].update(workspace=app["workspace"], surface=SURFACE))
        said = []; rem = Remote(orgs=["example-ai"])
        rc = V.workspace_remote("vm_remote_fixture", S, docs2["application"], docs2["infrastructure"], d2, P, ["--workspace-remote"], crons, runner=rem, say=said.append)
        text = "\n".join(said)
        check("workspace: a server whose workspace was made under ANOTHER id is not given a second, empty one: refused, with both ids and the two ways out",
              rc == 1 and rem.orgs == {"example-ai"} and "already has workspace(s) example-ai and none with the id example" in text and "--new-workspace" in text and "org.org_id" in text, text)
        check("workspace:   ...and nothing is recorded as applied", not os.path.exists(os.path.join(d2, "seed", "orgs", ".applied.json")) and "configured_at" not in B.load(os.path.join(d2, "infrastructure.json")))
        check("surface: a workspace that was refused gets no surface either, and the operator is told", "NOT finished: the application's surface: its workspace was not written in this run" in text, text)
        said = []; rc = V.workspace_remote("vm_remote_fixture", S, docs2["application"], docs2["infrastructure"], d2, P, ["--workspace-remote", "--new-workspace"], crons, runner=rem, say=said.append)
        check("workspace:   ...unless the operator says a new workspace is wanted", rc == 0 and rem.orgs == {"example-ai", "example"} and "guard" not in json.loads(rem.stdin)["seeds"][0]["seed"])
        said = []; rem = Remote(no_user=True); d3, docs3 = _deployed(tmp, "ws-old")
        rc = V.workspace_remote("vm_remote_fixture", S, docs3["application"], docs3["infrastructure"], d3, P, ["--workspace-remote"], crons, runner=rem, say=said.append)
        check("workspace: a server deployed before each service had its own user says so, and nothing is recorded", rc == 1 and f"has no user {WEB} yet" in "\n".join(said) and not os.path.exists(os.path.join(d3, "seed", "orgs", ".applied.json")), said)
    finally:
        V.key_path = real_key

    # ---- the server side: as whom, with what, and what it prints
    import pwd
    me = pwd.getpwuid(os.getuid()).pw_name
    envf = os.path.join(tmp, "ws-server", "web.env"); os.makedirs(os.path.dirname(envf))
    V.env_write(envf, {"DATABASE_URL": DB_URL, "AUTH_JWT_PRIVATE_KEY": "PRIVATE-KEY-" + "k" * 30, "WEB_ORIGIN": "https://app.example.com"})
    seen = []
    def fake_run(argv):
        seen.append({"argv": list(argv), "seed": B.load(argv[4]), "mode": stat.S_IMODE(os.stat(argv[4]).st_mode), "customers": B.load(argv[5]) if len(argv) > 5 else None})
        if B.load(argv[4])["org_id"] == "boom": return B.CP(argv, 1, "", f"Error: connect ECONNREFUSED while using {DB_URL}\n    at x.js:1")
        return B.CP(argv, 0, "noise\n" + json.dumps({"org": B.load(argv[4])["org_id"], "orgs": "created", "org_members": 1}) + "\n", "")
    said = []
    doc = {"seeds": [{"seed": {"org_id": "example", "name": "Example", "owner": "o@example.com", "members": []}, "customers": [{"id": "acme"}]}, {"seed": {"org_id": "boom", "name": "B", "owner": "o@example.com", "members": []}, "customers": []}]}
    rc = V.workspace_seed(envf, me, tmp, tmp, "/factory/workspace_seed.mjs", doc, run=fake_run, say=said.append)
    check("workspace (server): each workspace is one run of the seed with node, on a private file that holds only that workspace",
          [c["argv"][:4] for c in seen] == [["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/factory/workspace_seed.mjs"]] * 2 and seen[0]["seed"]["org_id"] == "example" and seen[0]["mode"] == 0o600
          and seen[0]["customers"] == {"customers": [{"id": "acme"}]} and len(seen[1]["argv"]) == 5, seen)
    check("workspace (server):   ...it prints one WORKSPACE line per workspace and fails if any failed", rc == 1 and said[0] == 'WORKSPACE {"org": "example", "orgs": "created", "org_members": 1}' and said[1].startswith('WORKSPACE {"org": "boom", "error": "the seed did not finish'), said)
    check("workspace (server):   ...and no value from the env file is in anything it printed, even when the app's own error carried the connection string", "Zk3-app-rw-PASSWORD-77" not in "\n".join(said) and "PRIVATE-KEY" not in "\n".join(said) and "ECONNREFUSED" in said[1], said)
    check("workspace (server):   ...the temp files are gone afterwards", not os.path.exists(seen[0]["argv"][4]) and not os.path.exists(os.path.dirname(seen[0]["argv"][4])))
    said = []; rc = V.workspace_seed(envf, "sf-no-such-user", tmp, tmp, "x", doc, run=fake_run, say=said.append)
    check("workspace (server): without the web app's user it writes nothing and says what to do", rc == 1 and "has no user sf-no-such-user yet" in said[0] and len(seen) == 2)
    V.env_write(envf, {"WEB_ORIGIN": "https://app.example.com"}); said = []
    check("workspace (server): without a DATABASE_URL in the web app's env file there is nothing to write to", V.workspace_seed(envf, me, tmp, tmp, "x", doc, run=fake_run, say=said.append) == 1 and "no DATABASE_URL" in said[0] and len(seen) == 2)
    src = open(V.__file__).read(); body = src[src.index("def workspace_seed("):src.index("def env_run(")]
    check("workspace (server): the child gets the web service's env file and nothing else of the server's (no master file, no admin URL)", "env_read(env_file)" in body and "POSTGRES_ADMIN_URL" not in body and "os.environ" not in body
          and "user=pw.pw_uid, group=pw.pw_gid" in body)
    check("surface (server): the surface step is in the same function, under the same user and env file, and names no admin URL either", "_surface_apply(" in body and "POSTGRES_ADMIN_URL" not in src[src.index("def _surface_apply("):src.index("def env_run(")])

    # ---- the surface, server side (mold_v1-163): as whom, with what, and what it prints
    V.env_write(envf, {"DATABASE_URL": DB_URL, "AUTH_JWT_PRIVATE_KEY": "PRIVATE-KEY-" + "k" * 30, "WEB_ORIGIN": "https://app.example.com"})
    factory = os.path.join(tmp, "ws-server", "factory"); os.makedirs(factory); os.chmod(factory, 0o700)       # root's alone on a real server
    for f in ("workspace_seed.mjs", "surface.mjs"): shutil.copyfile(os.path.join(HERE, f), os.path.join(factory, f))
    sdoc = V.surface_doc(docs["application"]); calls = []
    def fake_both(argv, stdin_text=None, more_env=None, answer=None):
        if argv[-1] != "apply":
            sd_ = B.load(argv[4]); calls.append(("seed", sd_["org_id"]))
            if sd_["org_id"] == "boom": return B.CP(argv, 1, "", "Error: nope")
            return B.CP(argv, 0, json.dumps({"org": sd_["org_id"], "orgs": "updated", "org_members": 1}) + "\n", "")
        st = os.stat(argv[1])
        calls.append(("surface", {"argv": list(argv), "stdin": json.loads(stdin_text), "env": dict(more_env), "mode": stat.S_IMODE(st.st_mode), "dir": os.path.dirname(argv[1]),
                                  "text": open(argv[1]).read(), "seed_beside": os.path.exists(os.path.join(os.path.dirname(argv[1]), "workspace_seed.mjs"))}))
        return answer or B.CP(argv, 0, json.dumps({"agent_profiles": 1, "agent_configs": 2, "workflow_definitions": 1, "workflows": 1, "orgs": 1}, indent=2) + "\n", "")
    own = {"seed": {"org_id": "example", "name": "Example", "owner": "operator@example.com", "members": []}, "customers": []}
    said = []
    rc = V.workspace_seed(envf, me, tmp, "/srv/app", os.path.join(factory, "workspace_seed.mjs"), {"seeds": [own], "surface": sdoc}, run=fake_both, say=said.append, surface_script=os.path.join(factory, "surface.mjs"))
    sc = [c[1] for c in calls if c[0] == "surface"]
    check("surface (server): after the workspace's own seed, ONE run of surface.mjs apply with node", rc == 0 and [c[0] for c in calls] == ["seed", "surface"] and sc[0]["argv"][0] == "node" and sc[0]["argv"][2:] == ["apply"] and len(sc[0]["argv"]) == 3, calls)
    check("surface (server):   ...from a private copy the web app's user can read, not from the factory's root-only directory (the first real server's lesson)",
          sc[0]["dir"] != factory and os.path.basename(sc[0]["argv"][1]) == "surface.mjs" and sc[0]["mode"] == 0o600 and sc[0]["seed_beside"] and sc[0]["text"] == open(os.path.join(HERE, "surface.mjs")).read(), sc[0]["argv"])
    check("surface (server):   ...told where the app's own modules are, which workspace, and which tables: the four, nothing more", sc[0]["env"] == {"MOLD_DIR": "/srv/app", "ORG_ID": "example", "SURFACE_ONLY": "agent_profiles,agent_configs,workflow_definitions,workflows"}, sc[0]["env"])
    check("surface (server):   ...no database URL is added by the factory: the only one the child holds is the web service's own (the app role)", not any("URL" in k for k in sc[0]["env"]))
    check("surface (server):   ...the state arrives on stdin, not in a file and not on the command line", sc[0]["stdin"] == sdoc["state"])
    check("surface (server):   ...it prints one SURFACE line of counts, for the asked tables only", said[-1] == 'SURFACE {"org": "example", "agent_profiles": 1, "agent_configs": 2, "workflow_definitions": 1, "workflows": 1}', said)
    check("surface (server):   ...and the private copies are gone afterwards", not os.path.exists(sc[0]["argv"][1]) and not os.path.exists(sc[0]["dir"]))
    calls.clear(); said = []
    rc = V.workspace_seed(envf, me, tmp, "/srv/app", os.path.join(factory, "workspace_seed.mjs"), {"seeds": [dict(own, seed=dict(own["seed"], org_id="boom"))], "surface": dict(sdoc, org_id="boom")}, run=fake_both, say=said.append, surface_script=os.path.join(factory, "surface.mjs"))
    check("surface (server): when the workspace's own seed did not finish, surface.mjs is never started, and the line says so", rc == 1 and [c[0] for c in calls] == ["seed"] and said[-1].startswith('SURFACE {"org": "boom", "skipped": "its workspace was not written'), said)
    calls.clear(); said = []
    leak = lambda argv, i=None, e=None: fake_both(argv, i, e, answer=B.CP(argv, 1, "", f"surface.mjs apply: connect ECONNREFUSED {DB_URL}\n") if argv[-1] == "apply" else None)
    rc = V.workspace_seed(envf, me, tmp, "/srv/app", os.path.join(factory, "workspace_seed.mjs"), {"seeds": [own], "surface": sdoc}, run=leak, say=said.append, surface_script=os.path.join(factory, "surface.mjs"))
    check("surface (server): a surface step that fails says why, fails the run, and repeats no value of the env file", rc == 1 and '"error": "the surface step did not finish' in said[-1] and "ECONNREFUSED" in said[-1]
          and "Zk3-app-rw-PASSWORD-77" not in "\n".join(said) and "PRIVATE-KEY" not in "\n".join(said), said)
    said = []
    err = lambda argv, i=None, e=None: fake_both(argv, i, e, answer=B.CP(argv, 0, json.dumps({"agent_profiles": 1, "agent_configs": "ERR new row violates row-level security policy", "workflow_definitions": 0, "workflows": 0}), "") if argv[-1] == "apply" else None)
    rc = V.workspace_seed(envf, me, tmp, "/srv/app", os.path.join(factory, "workspace_seed.mjs"), {"seeds": [own], "surface": sdoc}, run=err, say=said.append, surface_script=os.path.join(factory, "surface.mjs"))
    check("surface (server): a table the database refused fails the run and is shown with its reason", rc == 1 and '"agent_configs": "ERR new row violates row-level security policy"' in said[-1], said)
    calls.clear(); said = []
    rc = V.workspace_seed(envf, me, tmp, "/srv/app", os.path.join(factory, "workspace_seed.mjs"), {"seeds": [own]}, run=fake_both, say=said.append, surface_script=os.path.join(factory, "surface.mjs"))
    check("surface (server): a document with no surface (workspace.py's seeds, a named seed file) runs no surface step and prints no SURFACE line", rc == 0 and [c[0] for c in calls] == ["seed"] and not any(l.startswith("SURFACE") for l in said), said)
    _real_seed(check, tmp)
    _real_surface(check, tmp, sdoc)

FAKE_APP = {
"agent/lib/db/index.ts": '''import { readFileSync, writeFileSync, existsSync } from "node:fs";
const FILE = process.env.FAKE_DB;
export const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { orgs: [], org_members: [], platform_admins: [], people_roster: [], customers: [], provisioned: {}, scopes: [] };
export const save = () => writeFileSync(FILE, JSON.stringify(state));
const match = (row, cond) => !cond || row[cond.col] === cond.v;
const db = {
  select: () => ({ from: (t) => { const rows = () => state[t.__t]; const q = Promise.resolve().then(rows); q.where = (cond) => Promise.resolve(rows().filter((r) => match(r, cond))); return q; } }),
  update: (t) => ({ set: (v) => ({ where: async (cond) => { for (const r of state[t.__t]) if (match(r, cond)) Object.assign(r, v); } }) }),
  insert: (t) => ({ values: (v) => {
    const keyOf = (r) => (t.__key ?? []).map((k) => r[k]).join("|");
    const put = (onConflict) => { const at = state[t.__t].findIndex((r) => keyOf(r) === keyOf(v)); if (at < 0) state[t.__t].push({ ...v }); else if (onConflict) Object.assign(state[t.__t][at], onConflict); else if (onConflict === undefined) throw new Error("duplicate key in " + t.__t); };
    const q = { then: (ok, bad) => { try { put(undefined); ok(); } catch (e) { bad(e); } }, onConflictDoUpdate: async ({ set }) => put(set), onConflictDoNothing: async () => put(null) };
    return q;
  } }),
};
export function getDb() { return process.env.DATABASE_URL ? db : null; }
export async function withOrgDb(org, fn) {
  state.scopes.push(org);
  return fn({ execute: async (q) => {
    if (q.text.includes("insert into people_roster")) { const [o, email, name, team, manager, esc] = q.params; if (o !== org) throw new Error("row for another workspace"); const row = { org_id: o, email, name, team, manager_email: manager ?? null, escalations: esc ?? null };
      const at = state.people_roster.findIndex((r) => r.email === email); if (at < 0) state.people_roster.push(row); else state.people_roster[at] = row; return []; }
    if (q.text.includes("select count(*)")) return [{ n: state.customers.filter((c) => c.org === org).length }];
    throw new Error("unexpected statement: " + q.text);
  } });
}
''',
"agent/lib/db/schema.ts": '''export const orgs = { __t: "orgs", __key: ["orgId"], orgId: "orgId" };
export const orgMembers = { __t: "org_members", __key: ["orgId", "email"], orgId: "orgId", email: "email" };
export const platformAdmins = { __t: "platform_admins", __key: ["email"] };
export const peopleRoster = { __t: "people_roster" };
''',
# The stand-in for the mold's provisionWorkspace: like the real one it gives a new workspace the library the BUILD names
# and nothing else. FAKE_LIBRARY stands for that build: unset is the default profile (no library at all, which is what
# an app with library.install "none" is built with); "account-delivery" is the 13 workflows and 5 recipes of "all".
"agent/lib/provision-workspace.ts": '''import { state } from "./db/index.ts";
const LIBRARY = process.env.FAKE_LIBRARY === "account-delivery" ? { recipes: 5, workflows: 13 } : { recipes: 0, workflows: 0 };
export async function provisionWorkspace(tx, org, owner) {
  const first = !state.provisioned[org]; state.provisioned[org] = owner;
  return first ? { recipesCreated: LIBRARY.recipes, workflowsCreated: LIBRARY.workflows, workflowsSkipped: 0 } : { recipesCreated: 0, workflowsCreated: 0, workflowsSkipped: LIBRARY.workflows };
}
''',
"agent/lib/system-of-record.ts": '''import { state } from "./db/index.ts";
export async function writeCustomerToPostgres(db, c, org) {
  if (!c.id) throw new Error("a company needs an id");
  const at = state.customers.findIndex((x) => x.org === org && x.id === c.id); if (at < 0) state.customers.push({ org, ...c }); else state.customers[at] = { org, ...c };
}
''',
"scripts/operator/lib/customer.mjs": '''import { save } from "../../../agent/lib/db/index.ts";
export async function closeDb() { save(); }
''',
"node_modules/drizzle-orm/index.js": '''export const eq = (col, v) => ({ col, v });
export const and = (...a) => a;
export const sql = (strings, ...params) => ({ text: strings.join("?"), params });
''',
"package.json": '{"type": "module"}\n',
}

def _real_seed(check, tmp):
    """The factory's own workspace_seed.mjs, run with node inside a stand-in for the built app: the same module paths the
    seed imports, backed by a JSON file instead of Postgres. What is checked is the seed's own logic (what it writes, in
    which workspace's scope, what the guard refuses, that a second run changes nothing); the SQL itself only a server proves."""
    node = shutil.which("node")
    if not node: return
    r = subprocess.run([node, "-e", "process.exit(process.features.typescript ? 0 : 1)"], capture_output=True)
    if r.returncode: return
    appd = os.path.join(tmp, "fake-app"); dbf = os.path.join(tmp, "fake-db.json")
    for rel, text in FAKE_APP.items():
        p = os.path.join(appd, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(text)
    script = os.path.join(HERE, "workspace_seed.mjs")
    def run(seed, customers=None, url="postgresql://stand-in", library="account-delivery"):
        sp = os.path.join(tmp, "seed-in.json"); json.dump(seed, open(sp, "w")); args = [sp]
        if customers is not None:
            cp = os.path.join(tmp, "cust-in.json"); json.dump({"customers": customers}, open(cp, "w")); args.append(cp)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "FAKE_DB": dbf, "HOME": tmp}
        if library: env["FAKE_LIBRARY"] = library
        if url: env["DATABASE_URL"] = url
        r = subprocess.run([node, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, *args], cwd=appd, env=env, capture_output=True, text=True, timeout=120)
        try: out = json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
        except ValueError: out = {"unparsed": r.stdout + r.stderr}
        return r.returncode, out, (B.load(dbf) if os.path.exists(dbf) else None)
    RAN.append("the workspace seed run with node against a stand-in for the app's database modules")
    seed = {"org_id": "example", "name": "Example", "google_hosted_domain": "example.com", "display_name": "Example Co", "owner": "operator@example.com",
            "members": [{"email": "operator@example.com", "role": "owner"}, {"email": "ana@example.com", "role": "admin"}], "platform_admins": ["operator@example.com"],
            "roster": [{"email": "operator@example.com", "name": "Operator"}, {"email": "ana@example.com", "name": "Ana", "team": "Credit", "manager_email": "operator@example.com", "escalations": [{"email": "operator@example.com", "reason": "limits"}]}],
            "guard": "no_other_workspace"}
    rc, out, db = run(seed, [{"id": "acme", "name": "Acme"}])
    check("seed (run with node): on an empty database it creates the workspace: the org row with its hosted domain and shown name", rc == 0 and out.get("orgs") == "created" and len(db["orgs"]) == 1
          and (db["orgs"][0]["orgId"], db["orgs"][0]["name"], db["orgs"][0]["googleHostedDomain"], db["orgs"][0]["branding"], db["orgs"][0]["blobPrefix"]) == ("example", "Example", "example.com", {"displayName": "Example Co"}, "orgs/example"), (rc, out))
    check("seed (run with node):   ...the owner and the members with their roles", [(m["email"], m["role"]) for m in db["org_members"]] == [("operator@example.com", "owner"), ("ana@example.com", "admin")] and out["org_members"] == 2)
    check("seed (run with node):   ...the platform administrators", [a["email"] for a in db["platform_admins"]] == ["operator@example.com"] and out["platform_admins"] == 1)
    check("seed (run with node):   ...the starter library the build names (here the account-delivery one: 5 recipes, 13 workflows), through the mold's own provisionWorkspace", out["recipes"] == 5 and out["workflows_created"] == 13 and db["provisioned"] == {"example": "operator@example.com"})
    check("seed (run with node):   ...the people roster from state, with reporting lines", [(p["email"], p["team"], p["manager_email"]) for p in db["people_roster"]] == [("operator@example.com", None, None), ("ana@example.com", "Credit", "operator@example.com")] and out["people_roster"] == 2)
    check("seed (run with node):   ...and the companies", out["customers"] == 1 and out["customers_in_workspace"] == 1 and db["customers"][0]["org"] == "example")
    check("seed (run with node):   ...every org-scoped write went inside that workspace's own scope", set(db["scopes"]) == {"example"} and len(db["scopes"]) >= 3)
    before = json.dumps({k: db[k] for k in ("org_members", "platform_admins", "people_roster", "customers")}, sort_keys=True)
    rc, out, db = run(seed, [{"id": "acme", "name": "Acme"}])
    check("seed (run with node): a second run updates the one workspace and adds nothing", rc == 0 and out["orgs"] == "updated" and out["recipes"] == 0 and out["workflows_present"] == 13 and len(db["orgs"]) == 1
          and json.dumps({k: db[k] for k in ("org_members", "platform_admins", "people_roster", "customers")}, sort_keys=True) == before, out)
    other = dict(seed, org_id="example-two", name="Example Two"); snap = json.dumps(db, sort_keys=True)
    rc, out, db = run(other)
    check("seed (run with node): the guard: a workspace that is not there, on a database that has others, is NOT created and nothing at all is written",
          rc == 1 and out.get("error") == "other_workspaces" and out.get("other_workspaces") == ["example"] and json.dumps(db, sort_keys=True) == snap, out)
    rc, out, db = run({k: v for k, v in other.items() if k != "guard"})
    check("seed (run with node):   ...without the guard (an explicit seed, or --new-workspace) it is created beside the first", rc == 0 and out["orgs"] == "created" and [o["orgId"] for o in db["orgs"]] == ["example", "example-two"])
    legacy = {"org_id": "third", "name": "Third", "google_hosted_domain": None, "owner": "operator@example.com", "members": [{"email": "cy@third.example", "role": "member", "name": "Cy"}]}
    rc, out, db = run(legacy)
    check("seed (run with node): a seed as workspace.py has always sent it (no admins, no roster, no shown name) writes what it always wrote",
          rc == 0 and "platform_admins" not in out and len(db["platform_admins"]) == 1 and "branding" not in db["orgs"][2] and out["people_roster"] == 1
          and [p for p in db["people_roster"] if p["email"] == "cy@third.example"][0]["team"] == "Research", out)
    rc, out, db = run(seed, url=None)
    check("seed (run with node): with no DATABASE_URL it writes nothing and exits non-zero", rc == 1 and len(db["orgs"]) == 3)
    bare = dict(seed, org_id="bare", name="Bare"); bare.pop("guard")
    rc, out, db = run(bare, library=None)
    check("seed (run with node): in a build that names no library (library.install none, the default) the workspace is created with no starter recipes and no starter workflows, and the seed does not mind",
          rc == 0 and out["orgs"] == "created" and out["recipes"] == 0 and out["workflows_created"] == 0 and out["workflows_present"] == 0 and db["provisioned"].get("bare") == "operator@example.com", out)
    rc, out, db = run(dict(seed), [{"name": "No Id"}])
    check("seed (run with node): a company the app refuses is reported by id and fails the run, without hiding the rest", rc == 1 and out.get("customers_failed") and out["orgs"] == "updated")


# A stand-in for the app's `postgres` module (postgres.js), for surface.mjs: the tagged-template client, sql(identifiers),
# sql.json, sql.begin and sql.end, backed by a JSON file. It models the three things the surface step leans on:
#   the catalog   which columns are each table's primary key (pg_index), and each table's unique keys
#   upserts       `insert ... on conflict (cols) do update set c = excluded.c`: by that key; a second unique key that is
#                 violated raises, as Postgres does (the default profile's (org_id, email) index)
#   row security  a row of an org-scoped table can be written or read only inside a transaction whose
#                 set_config('app.org_id') names that row's workspace; otherwise the insert is refused with Postgres's words
# Every statement and the options each client was opened with are recorded, so the test can say what was NOT run.
FAKE_POSTGRES = r"""
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const FILE = process.env.FAKE_DB;
const PK = { orgs: ["org_id"], org_members: ["org_id", "email"], platform_admins: ["email"], people_roster: ["email"], agent_profiles: ["id"],
             agent_configs: ["org_id", "agent_key"], workflow_definitions: ["id"], workflows: ["id"] };
const UNIQUE = { agent_profiles: [["org_id", "email"]] };
const RLS = new Set(["people_roster", "agent_profiles", "agent_configs", "workflow_definitions", "workflows"]);
const db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { tables: {}, statements: [], clients: [], seq: 0 };
for (const t of Object.keys(PK)) db.tables[t] = db.tables[t] ?? [];
const save = () => writeFileSync(FILE, JSON.stringify(db));
class Ident { constructor(v) { this.v = v; } }
class Json { constructor(v) { this.v = v; } }
const splitTop = (s) => { const out = []; let depth = 0, cur = ""; for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const lit = (x) => x === "?" ? undefined : /^'.*'$/.test(x) ? x.slice(1, -1) : x === "null" ? null : x === "now()" ? "NOW" : /^\d+$/.test(x) ? Number(x) : x;
function run(scope, strings, values) {
  let text = "", params = [];
  strings.forEach((str, i) => { text += str; if (i < values.length) { const v = values[i];
    if (v instanceof Ident) text += Array.isArray(v.v) ? v.v.join(", ") : v.v; else { text += "?"; params.push(v instanceof Json ? v.v : v); } } });
  text = text.replace(/\s+/g, " ").trim(); db.statements.push({ text, scope: scope.org ?? null });
  if (/^select a\.attname from pg_index/.test(text)) { const t = String(params[0]); if (!PK[t]) throw new Error('relation "' + t + '" does not exist'); return PK[t].map((attname) => ({ attname })); }
  if (/^select set_config\('app\.org_id'/.test(text)) { if (!scope.tx) throw new Error("set_config(..., true) outside a transaction"); scope.org = params[0]; return [{}]; }
  let m = text.match(/^select 1 as x from (\w+) where org_id = \? and name = \? limit 1$/);
  if (m) { const visible = db.tables[m[1]].filter((r) => !RLS.has(m[1]) || r.org_id === scope.org); return visible.filter((r) => r.org_id === params[0] && r.name === params[1]).slice(0, 1).map(() => ({ x: 1 })); }
  m = text.match(/^insert into (\w+) \(([^)]*)\) values \((.*?)\)(?: on conflict(?: \(([^)]*)\))? do (nothing|update set (.*)))?$/);
  if (m) {
    const [, t, colsRaw, valsRaw, target, action, setRaw] = m; const cols = splitTop(colsRaw), vals = splitTop(valsRaw); let pi = 0;
    if (cols.length !== vals.length) throw new Error("INSERT has more expressions than target columns");
    const row = {}; cols.forEach((c, i) => { const l = lit(vals[i]); row[c] = l === undefined ? params[pi++] : l; });
    for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null;
    if (RLS.has(t) && row.org_id !== scope.org) throw new Error('new row violates row-level security policy for table "' + t + '"');
    if (t === "workflows" && !row.id) row.id = "wf-" + (++db.seq);
    const same = (key) => (r) => key.every((c) => r[c] === row[c]);
    const keys = [PK[t], ...(UNIQUE[t] ?? [])]; const tkey = target ? target.split(",").map((x) => x.trim()) : null;
    if (tkey && !keys.some((k) => k.join() === tkey.join())) throw new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification");
    const hit = tkey ? db.tables[t].find(same(tkey)) : (action === "nothing" ? db.tables[t].find((r) => keys.some((k) => same(k)(r))) : null);
    if (hit) { if (action !== "nothing") for (const a of splitTop(setRaw)) { const c = a.split("=")[0].trim(); hit[c] = row[c]; } return []; }
    for (const k of keys) if (db.tables[t].some(same(k))) throw new Error('duplicate key value violates unique constraint "' + t + "_" + k.join("_") + '"');
    db.tables[t].push(row); return [];
  }
  throw new Error("the stand-in does not know this statement: " + text.slice(0, 120));
}
function client(scope) {
  const sql = (first, ...rest) => {
    if (first && first.raw) { const p = (async () => run(scope, first, rest))(); return p; }
    return new Ident(first);
  };
  sql.json = (v) => new Json(v);
  sql.begin = async (fn) => { const snap = JSON.stringify(db.tables); const tx = client({ tx: true });
    try { return await fn(tx); } catch (e) { db.tables = JSON.parse(snap); throw e; } };
  sql.end = async () => save();
  return sql;
}
module.exports = (url, options) => { db.clients.push({ url, options }); return client({}); };
"""

def _real_surface(check, tmp, sdoc):
    """The factory's own surface.mjs `apply`, run with node the way the server runs it (MOLD_DIR, ORG_ID, SURFACE_ONLY, the
    state on stdin), against FAKE_POSTGRES above. What is checked is surface.mjs's own logic: which tables it writes and
    which it leaves alone, that each write is inside the workspace's scope, that a second run changes nothing, that nothing
    is ever removed, and how it opens the connection. The SQL against a real Postgres only a server proves."""
    node = shutil.which("node")
    if not node: return
    appd = os.path.join(tmp, "fake-built-app"); mod = os.path.join(appd, "node_modules", "postgres"); os.makedirs(mod)
    open(os.path.join(appd, "package.json"), "w").write('{"name": "stand-in"}\n')
    open(os.path.join(mod, "package.json"), "w").write('{"name": "postgres", "main": "index.js"}\n')
    open(os.path.join(mod, "index.js"), "w").write(FAKE_POSTGRES)
    private = os.path.join(tmp, "sf-workspace-private"); os.makedirs(private)             # where the server puts its copy: NOT beside the app
    script = os.path.join(private, "surface.mjs"); shutil.copyfile(os.path.join(HERE, "surface.mjs"), script)
    def run(state, dbf, only=",".join(V.SURFACE_TABLES), url=DB_URL, org="example"):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "FAKE_DB": dbf, "MOLD_DIR": appd, "ORG_ID": org, "DATABASE_URL": url}
        if only is not None: env["SURFACE_ONLY"] = only
        r = subprocess.run([node, script, "apply"], cwd=appd, env=env, input=json.dumps(state), capture_output=True, text=True, timeout=120)
        try: out = json.loads(r.stdout)
        except ValueError: out = {"unparsed": r.stdout + r.stderr}
        return r.returncode, out, (B.load(dbf) if os.path.exists(dbf) else None), r.stderr
    RAN.append("surface.mjs apply run with node against a stand-in for the app's postgres module")
    state = sdoc["state"]; dbf = os.path.join(tmp, "fake-pg.json")
    # what the workspace seed and the people using the app left there before this step ever ran
    before = {"tables": {"orgs": [{"org_id": "example", "name": "Example", "branding": {"displayName": "Example Co"}}], "org_members": [{"org_id": "example", "email": "operator@example.com", "role": "owner"}],
                         "platform_admins": [{"email": "operator@example.com"}], "people_roster": [{"org_id": "example", "email": "ana@example.com", "name": "Ana"}],
                         "agent_profiles": [{"id": "Xq9-made-in-the-app", "org_id": "example", "email": "", "persona_name": "Old", "tone": None, "instructions": "old", "default_mode": None, "web_search_default": None, "browser_default": None, "model": None, "updated_by": "ana@example.com"},
                                            {"id": "m1", "org_id": "example", "email": "ana@example.com", "persona_name": "Ana's own", "instructions": "mine"}],
                         "agent_configs": [{"org_id": "example", "agent_key": "legacy", "paused": True, "instructions": "kept"}, {"org_id": "other", "agent_key": "research", "paused": True, "instructions": "another workspace's"}],
                         "workflow_definitions": [{"id": "wd-old", "org_id": "example", "name": "Old flow", "entity": "todo", "stages": [], "current_version": 4, "is_default": False}],
                         "workflows": [{"id": "wf-lib", "org_id": "example", "name": "qbr-prep", "steps": []}]}, "statements": [], "clients": [], "seq": 0}
    json.dump(before, open(dbf, "w"))
    rc, out, db, err = run(state, dbf)
    T = db["tables"] if db else {}
    check("surface.mjs (run with node): limited to the four tables, it reports those four and no other", rc == 0 and out == {"agent_profiles": 1, "agent_configs": 2, "workflow_definitions": 1, "workflows": 1}, (rc, out, err))
    prof = [p for p in T.get("agent_profiles", []) if p["email"] == ""]
    check("surface.mjs (run with node):   ...the default agent profile: the row a person had already saved in the app is UPDATED from state, not duplicated and not refused",
          len(prof) == 1 and prof[0]["id"] == "Xq9-made-in-the-app" and (prof[0]["persona_name"], prof[0]["tone"], prof[0]["instructions"], prof[0]["default_mode"], prof[0]["model"], prof[0]["web_search_default"], prof[0]["browser_default"])
          == ("Ava", "plain", "Answer from the files. Cite the page.", "build", "@cf/zai-org/glm-5.2", True, False), prof)
    check("surface.mjs (run with node):   ...a member's own profile is left exactly as it was", [p for p in T["agent_profiles"] if p["email"] == "ana@example.com"] == before["tables"]["agent_profiles"][1:], T["agent_profiles"])
    cfg = {(c["org_id"], c["agent_key"]): c for c in T["agent_configs"]}
    check("surface.mjs (run with node):   ...the per-subagent configs, paused or not, with their instructions", (cfg[("example", "research")]["paused"], cfg[("example", "research")]["instructions"]) == (False, None)
          and (cfg[("example", "filings")]["paused"], cfg[("example", "filings")]["instructions"]) == (True, "Quote the clause."), cfg)
    wd = {d["id"]: d for d in T["workflow_definitions"]}
    check("surface.mjs (run with node):   ...the workflow definitions with their stages", wd["wd-credit"]["org_id"] == "example" and wd["wd-credit"]["stages"] == [{"id": "open"}, {"id": "done"}] and wd["wd-credit"]["is_default"] is True, wd)
    wf = {w["name"]: w for w in T["workflows"]}
    check("surface.mjs (run with node):   ...the workflow scripts that are not file-backed", wf["weekly-digest"]["steps"] == [{"say": "hi"}] and wf["weekly-digest"]["created_by"] == "operator@example.com" and "from-a-file" not in wf, wf)
    check("surface.mjs (run with node):   ...NOTHING is removed: a config, a definition and a workflow that state does not name are still there, and so is another workspace's row",
          cfg[("example", "legacy")] == before["tables"]["agent_configs"][0] and cfg[("other", "research")] == before["tables"]["agent_configs"][1] and wd["wd-old"] == before["tables"]["workflow_definitions"][0] and wf["qbr-prep"] == before["tables"]["workflows"][0])
    check("surface.mjs (run with node):   ...the tables the workspace seed owns are not touched at all", all(T[t] == before["tables"][t] for t in ("orgs", "org_members", "platform_admins", "people_roster")))
    stm = db["statements"]; writes = [x for x in stm if x["text"].startswith("insert into")]
    check("surface.mjs (run with node):   ...no statement names them, not even a read of their keys", not any(re.search(r"\b(orgs|org_members|platform_admins|people_roster)\b", x["text"]) for x in stm) and len(writes) == 5, [x["text"][:70] for x in stm])
    check("surface.mjs (run with node):   ...every write is inside a transaction that names this workspace (row-level security in force for each row)", writes and all(x["scope"] == "example" for x in writes), [(x["text"][:40], x["scope"]) for x in writes])
    check("surface.mjs (run with node):   ...and there is no delete, update, truncate, drop or alter anywhere", not any(re.match(r"(delete|update|truncate|drop|alter|grant|create)\b", x["text"], re.I) for x in stm), [x["text"][:50] for x in stm])
    check("surface.mjs (run with node):   ...the connection is the URL's own: on the server's loopback database the URL says sslmode=require and no `ssl` option overrides it",
          len(db["clients"]) == 1 and db["clients"][0]["url"] == DB_URL and "ssl" not in db["clients"][0]["options"], db["clients"])
    check("surface.mjs (run with node):   ...and nothing it printed carries the connection string", "Zk3-app-rw-PASSWORD-77" not in json.dumps(out) + err)
    snap = json.dumps(T, sort_keys=True)
    rc, out, db, err = run(state, dbf)
    check("surface.mjs (run with node): a second run changes nothing and adds no workflow twice (idempotent)", rc == 0 and out == {"agent_profiles": 1, "agent_configs": 2, "workflow_definitions": 1, "workflows": 0} and json.dumps(db["tables"], sort_keys=True) == snap, out)
    rc, out, db, err = run(state, dbf, org="other-workspace")
    check("surface.mjs (run with node): the workspace written is the one in the state it was handed; ORG_ID alone moves nothing", rc == 0 and json.dumps(db["tables"], sort_keys=True) == snap)
    rc, out, db, err = run(state, dbf, only="agent_profiles,customers")
    check("surface.mjs (run with node): a table apply does not write is refused by name, before anything is opened", rc == 1 and "SURFACE_ONLY names customers" in err and json.dumps(db["tables"], sort_keys=True) == snap, (rc, err))
    # the same file on the Vercel path: no SURFACE_ONLY, the whole of apply, as clone.py configure runs it
    full = {"workspace": {"org": {"org_id": "example", "name": "Example", "display_name": "Example Co"}, "operator_self": {"email": "operator@example.com"},
                          "members": [{"email": "operator@example.com", "role": "owner"}], "platform_admins": ["operator@example.com"], "roster": [{"email": "ana@example.com", "name": "Ana", "team": "Credit"}]},
            "surface": state["surface"]}
    dbf2 = os.path.join(tmp, "fake-pg-vercel.json")
    rc, out, db, err = run(full, dbf2, only=None, url="postgresql://app_rw:pw@db.example.com:5432/app")
    check("surface.mjs (run with node): without SURFACE_ONLY (clone.py configure, the Vercel path) it writes all eight tables, as before",
          rc == 0 and out == {"orgs": 1, "org_members": 1, "platform_admins": 1, "people_roster": 1, "agent_profiles": 1, "agent_configs": 2, "workflow_definitions": 1, "workflows": 1}
          and db["tables"]["agent_profiles"][0]["id"] == "example:default" and db["tables"]["orgs"][0]["branding"] == {"displayName": "Example Co"}, (rc, out, err))
    check("surface.mjs (run with node):   ...over TLS, as before, for a database that is not on loopback", db["clients"][0]["options"].get("ssl") == "require", db["clients"])
    rc, out, db, err = run(full, dbf2, only=None, url="postgresql://app_rw:pw@db.example.com:5432/app")
    check("surface.mjs (run with node):   ...and a second run there still updates the one default profile it made", rc == 0 and out["agent_profiles"] == 1 and len(db["tables"]["agent_profiles"]) == 1, out)
    dbf3 = os.path.join(tmp, "fake-pg-local.json")
    rc, out, db, err = run(full, dbf3, only=None, url="postgresql://postgres:pw@127.0.0.1:5432/throwaway")
    check("surface.mjs (run with node): a loopback URL that names no sslmode stays plaintext, as it always was (the throwaway local database)", rc == 0 and db["clients"][0]["options"].get("ssl") is False, db and db["clients"])
