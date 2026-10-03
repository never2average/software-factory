#!/usr/bin/env python3
"""Offline self-test of the vm_remote target (mold_v1-075..078). Run it as:

  python3 .claude/scripts/lib/vm_remote.py --self-test        (or: provision.py --self-test-remote)

NOTHING HERE TOUCHES A SERVER OR CHANGES THIS MACHINE. Every remote answer is a recorded fixture, every "run"
goes to a fake runner, and for the whole test the process refuses to open a socket or start ssh, rsync or curl:
a test that reached for the network fails instead of connecting. Generated scripts are syntax-checked
(`bash -n`), never executed. Files are written only under a temp directory that is removed afterwards.
"""
import contextlib, hashlib, importlib.util, io, json, os, re, shutil, socket, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
for p in (HERE, SCRIPTS):
    if p not in sys.path: sys.path.insert(0, p)
import vm_remote as V
import factory as F
import provision as P
import lanes as L
import lane_url

FX = os.path.dirname(V.FIXTURE)
CP = subprocess.CompletedProcess
MOLD = os.path.join(ROOT, "molds", "mold_v1", "codebase")
SECRET = "s3cr3t-VALUE-9f2b7c"          # a stand-in for an operator value; it must never surface anywhere but one stdin

def load(p): return json.load(open(p))
def fx(name): return open(os.path.join(FX, name)).read()
def fixture_docs(): return {n: load(os.path.join(V.FIXTURE, f"{n}.json")) for n in ("application", "infrastructure", "datastores", "datainfra")}
def digest(d):
    h = hashlib.sha256()
    for r, _, fs in sorted(os.walk(d)):
        for f in sorted(fs): h.update(f.encode()); h.update(open(os.path.join(r, f), "rb").read())
    return h.hexdigest()

class Offline:
    """While active: no socket may connect or resolve, and no ssh/rsync/curl/scp process may start."""
    BANNED = ("ssh", "rsync", "curl", "scp", "sftp", "wget")
    def __enter__(self):
        self.saved = (socket.socket.connect, socket.getaddrinfo, subprocess.Popen.__init__); self.tripped = []
        outer = self
        def no_connect(sock, *a, **k): outer.tripped.append(f"connect {a}"); raise AssertionError("the self-test tried to open a socket")
        def no_dns(*a, **k): outer.tripped.append(f"dns {a[:1]}"); raise AssertionError("the self-test tried to resolve a name")
        real_init = subprocess.Popen.__init__
        def guarded_init(popen, args, *a, **k):
            first = (args if isinstance(args, str) else (args[0] if args else "")).split()[0] if args else ""
            if os.path.basename(str(first)) in outer.BANNED:
                outer.tripped.append(f"spawn {first}"); raise AssertionError(f"the self-test tried to start {first}")
            return real_init(popen, args, *a, **k)
        socket.socket.connect = no_connect; socket.getaddrinfo = no_dns; subprocess.Popen.__init__ = guarded_init
        return self
    def __exit__(self, *exc):
        socket.socket.connect, socket.getaddrinfo, subprocess.Popen.__init__ = self.saved
        return False

def quiet(fn, *a, **k):
    """(return value or the exception, everything it printed)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try: out = fn(*a, **k)
        except (SystemExit, V.Stop) as e: out = e
    return out, buf.getvalue()

EVIDENCE_JSON = {"role": "app_rw", "superuser": False, "bypassrls": False, "tables_org_scoped": 58, "protected": 58, "unprotected": [],
                 "open_policies": [], "leaking_policies": [], "policies_executed": 60, "policies_unverified": [], "unmeasured": [],
                 "probe_table": "customers", "probe_tables": 58, "probe_skipped": [], "foreign_rows": 0, "leaking_tables": [],
                 "cross_org_write": "42501", "cross_org_writable": [], "unset_org_rows": 0, "open_with_no_org": []}
HEALTH_DOC = {"ok": True, "db": {"ok": True, "detail": "SELECT 1 ok · role app_rw (RLS enforced)"}}

def run():
    fails, n = [], [0]
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail)[:400] if detail != '' else ''}")
    tmp = tempfile.mkdtemp(prefix="vm-remote-selftest-")
    real_state = digest(os.path.join(ROOT, "state"))
    try:
        with Offline() as net:
            _state_rules(check)
            _generated_files(check, tmp)
            _env_file(check, tmp)
            _service_env(check, tmp)
            _storage_and_sandbox(check, tmp)
            _qualification(check)
            _plan_and_dry_run(check, tmp)
            _deploy_sequence(check, tmp)
            _host_chain(check, tmp)
            _records(check, tmp)
            _operator_commands(check, tmp)
            _lanes(check)
            _brief_to_plan(check, tmp)
            check("the whole self-test opened no socket and started no ssh/rsync/curl", not net.tripped, net.tripped)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    check("the real state/ is byte-identical after the self-test", digest(os.path.join(ROOT, "state")) == real_state)
    if fails:
        print("vm_remote self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"vm_remote self-test ok: {n[0]} checks (state rules, generated scripts, unit and timer files, Caddyfile, firewall, "
          f"env file without leaks, one env file per service with no private key for the agent, storage names, sandbox deny list and "
          f"the storage conflict it refuses, host qualification, dry-run plan, deploy sequence, database chain order, records, lanes); "
          f"offline, nothing contacted, nothing on this machine changed")
    return 0

# ---- 075: the schema and the rules factory.py validate applies ------------------------------------------------
def _state_rules(check):
    errs, docs = F._app_errors("vm_remote_fixture", V.FIXTURE)
    check("the fixture (target vm_remote) validates", errs == [], errs)
    r = subprocess.run([sys.executable, os.path.join(SCRIPTS, "factory.py"), "validate", "--app-dir", V.FIXTURE], capture_output=True, text=True)
    check("  ...and through `factory.py validate --app-dir`", r.returncode == 0 and r.stdout.strip() == "ok", r.stdout + r.stderr)
    sch = load(os.path.join(ROOT, "state/application/app_id/infrastructure.schema.json"))
    def schema_errs(mut):
        d = fixture_docs(); mut(d["infrastructure"]); return F._check(d["infrastructure"], sch, "x")
    def rule_errs(mut, app_id="vm_remote_fixture"):
        d = fixture_docs(); mut(d); return F._vm_remote(app_id, d)
    vr = lambda d: d["infrastructure"]["vm_remote"]
    for label, mut, needle in (
        ("an unknown key under vm_remote", lambda i: i["vm_remote"].update(password="x"), "not allowed"),
        ("a key PATH where the key NAME belongs", lambda i: i["vm_remote"].update(ssh_key_ref="/root/.ssh/id_ed25519"), "fails pattern"),
        ("a public key where the key NAME belongs", lambda i: i["vm_remote"].update(ssh_key_ref="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc x"), "fails pattern"),
        ("kvm set to anything but required", lambda i: i["vm_remote"].update(kvm="optional"), "not in"),
        ("an http production_url", lambda i: i["vm_remote"].update(production_url="http://app.example.com"), "fails pattern"),
        ("a user@host in host", lambda i: i["vm_remote"].update(host="root@203.0.113.10"), "fails pattern"),
        ("a missing sandbox block", lambda i: i["vm_remote"].pop("sandbox"), "missing sandbox"),
        ("a lower-case storage key name", lambda i: i["vm_remote"]["storage"].update(access_key_ref="my key"), "fails pattern")):
        e = schema_errs(mut)
        check(f"the schema refuses {label}", any(needle in x for x in e), e)
    for label, mut, needle in (
        ("an install_path that is not the fixed one", lambda d: vr(d).update(install_path="/opt/software-factory/other"), "fixed at"),
        ("a 1-vCPU sandbox (it froze in the spike)", lambda d: vr(d)["sandbox"].update(cpus=1), "at least 2"),
        ("a 512 MiB sandbox", lambda d: vr(d)["sandbox"].update(memory_mib=512), "at least 1024"),
        ("an SSH port that is not a port", lambda d: vr(d).update(ssh_port=70000), "ssh_port"),
        ("an SSH source limit with no address for the deploy itself to log in to", lambda d: vr(d).update(ssh_allow_from="10.44.0.0/24"), "ssh_host"),
        ("an SSH source of every address", lambda d: vr(d).update(ssh_allow_from="0.0.0.0/0", ssh_host="10.44.0.2"), "every address"),
        ("the Vercel secret store", lambda d: d["infrastructure"].update(secret_store="vercel_env"), "vm_remote_env_file"),
        ("the Vercel sandbox", lambda d: d["infrastructure"]["sandbox"].update(provider="vercel_sandbox"), "microsandbox"),
        ("a deny list without the metadata range", lambda d: vr(d)["sandbox"].update(deny_subnets=["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10"]), "169.254.0.0/16"),
        ("a storage dir inside the build", lambda d: vr(d)["storage"].update(dir="/var/lib/software-factory/other/storage"), "storage.dir"),
        ("a blob provider that disagrees with the storage driver", lambda d: d["datastores"]["blob"].update(provider="vercel_blob"), "blob.provider"),
        ("a managed Postgres", lambda d: d["datastores"]["postgres"].update(provider="neon"), "self_hosted"),
        ("a Postgres that is not on loopback", lambda d: d["datastores"]["postgres"].update(host="0.0.0.0"), "loopback"),
        ("tls migration_switch without naming the switch", lambda d: vr(d)["postgres"].update(tls="migration_switch"), "migration_switch_env"),
        ("an sslmode that disagrees with tls", lambda d: d["datastores"]["postgres"].update(sslmode="disable"), "sslmode"),
        ("s3 storage without a key NAME", lambda d: vr(d).update(storage={"driver": "s3", "bucket": "b"}), "access_key_ref"),
        ("a production_url nobody deployed", lambda d: vr(d).update(production_url="https://app.example.com"), "no deployed_at"),
        ("a production_url that is not the domain", lambda d: (vr(d).update(production_url="https://other.example.com"), d["infrastructure"].update(deployed_at="2026-10-02T10:00:00+00:00")), "https://<vm_remote.domain>"),
        ("a deployed status with no server", lambda d: (vr(d).pop("host"), d["application"].update(status="stamped")), "only a deploy to a real server"),
        ("a password inside a URL in a free-text field", lambda d: vr(d)["storage"].update(bucket="https://user:hunter2@bucket.example.com"), "NAMES only")):
        e = rule_errs(mut)
        check(f"validate refuses {label}", any(needle in x for x in e), e)
    d = fixture_docs(); d["infrastructure"]["vercel"] = {"production_url": "https://x.vercel.app"}
    check("validate refuses a vercel object on a vm_remote app", any("vercel object is present" in x for x in F._target_objects("a", d)))
    d = fixture_docs(); d["infrastructure"].update(target="vercel")
    check("  ...and a vm_remote object on a vercel app", any("vm_remote object is present" in x for x in F._target_objects("a", d)))
    two = {"a": fixture_docs(), "b": fixture_docs()}
    check("two live vm_remote apps cannot share one server", any("one server serves one application" in x for x in F._vm_remote_hosts(two)))
    two["b"]["application"]["status"] = "retired"
    check("  ...a retired one does not count", F._vm_remote_hosts(two) == [])
    d = fixture_docs(); d["application"]["status"] = "stamped"
    check("a vm_remote app may hold a deployed status (it serves); the vm-only status rule does not fire", F._vm_status("a", d) == [])
    d = fixture_docs(); d["application"]["status"] = "stamped"; d["infrastructure"]["deployed_at"] = "2026-10-02T10:00:00+00:00"
    d["infrastructure"]["vm_remote"]["production_url"] = "https://app.example.com"
    e = F._rls_claim("a", d)
    check("  ...but then it owes the isolation evidence, and is pointed at --deploy-remote/--verify-rls", e and "--verify-rls" in e[0], e)
    d["datastores"]["postgres"]["rls_verified"] = {"at": "2026-10-02T10:00:00+00:00", "mode": "fail_closed", "backend": "self_hosted", "source": "t", "superuser": False,
        "bypassrls": False, "cross_org_write": "42501", "foreign_rows_readable": 0, "running_app": "not_enforced"}
    e = F._rls_claim("a", d)
    check("  ...and a not-enforced running app is sent to --deploy-remote, not --deploy", any(x.endswith("--deploy-remote") for x in e), e)
    # shape_state: what intake calls
    d = fixture_docs(); i = d["infrastructure"]; i.pop("vm_remote"); i.update(target="vercel", secret_store="vercel_env")
    i["vercel"] = {"team": "t", "project": "p"}; i["secrets"].append("BLOB_READ_WRITE_TOKEN"); i["secrets_derived"].append("BLOB_READ_WRITE_TOKEN")
    d["datastores"]["postgres"].update(provider="neon", pooling="transaction"); d["datastores"]["blob"] = {"provider": "vercel_blob", "root_prefix": "orgs/example", "token_ref": "BLOB_READ_WRITE_TOKEN"}
    V.shape_state("vm_remote_fixture", i, d["datastores"], d["datainfra"])
    e = F._check(i, sch, "x") + F._vm_remote("vm_remote_fixture", d) + F._target_objects("vm_remote_fixture", d)
    check("shape_state turns an intake-built state into a valid vm_remote one", e == [], e)
    check("  ...with no Vercel-only secret name left, and no server address invented", "BLOB_READ_WRITE_TOKEN" not in i["secrets"] + i["secrets_derived"]
          and "host" not in i["vm_remote"] and "domain" not in i["vm_remote"], i["vm_remote"])
    ov = F._lane_overlays()
    check("the vm_remote lane overlay validates against lane.schema.json", ov == [], ov)

# ---- 076 / 077: every generated file ---------------------------------------------------------------------------
def _settings(mut=None):
    d = fixture_docs()
    if mut: mut(d)
    return V.settings("vm_remote_fixture", d["application"], d["infrastructure"], d["datastores"])

def _generated_files(check, tmp):
    S = _settings(); mold = os.path.join(ROOT, "molds/mold_v1/codebase")
    crons = V.read_crons(mold)
    check("the cron list is read from the source's vercel.json, and it is the six this file names", crons == list(V.CRONS) and len(crons) == 6, crons)
    check("cron expressions become systemd calendars", [V.cron_to_oncalendar(x) for x in ("* * * * *", "*/5 * * * *", "*/10 * * * *", "*/15 * * * *")]
          == ["*-*-* *:*:00", "*-*-* *:0/5:00", "*-*-* *:0/10:00", "*-*-* *:0/15:00"])
    check("  ...and a shape it cannot express is refused, not approximated", V.cron_to_oncalendar("0 3 * * *") is None and V.cron_to_oncalendar("*/0 * * * *") is None)
    src = os.path.join(tmp, "src-cron"); os.makedirs(src)
    json.dump({"crons": [{"path": "/api/cron/nightly", "schedule": "0 3 * * *"}]}, open(os.path.join(src, "vercel.json"), "w"))
    out, _ = quiet(V.read_crons, src)
    check("  ...with a sentence naming the route", isinstance(out, V.Stop) and "/api/cron/nightly" in str(out), out)
    check("a source without vercel.json falls back to the six", V.read_crons(os.path.join(tmp, "nowhere")) == list(V.CRONS))
    U = V.unit_files(S, crons); svc, tim = V.unit_names(S, crons)
    app_units = [k for k in U if k.endswith(".service") and "-cron-" not in k and "-egress" not in k]
    check("exactly three application services", sorted(app_units) == sorted(svc) and len(svc) == 3, app_units)
    check("exactly six timers, each with its service", len(tim) == 6 and all(t in U and t.replace(".timer", ".service") in U for t in tim), tim)
    api = U[f"{S['unit']}-api.service"]
    check("the API unit runs as the non-root service user, in group kvm", "User=sfapp" in api and "SupplementaryGroups=kvm" in api and "User=root" not in api, api)
    check("  ...clears stale locks and prewarms BEFORE it starts", "ExecStartPre=/bin/bash /opt/software-factory/vm_remote_fixture/factory/api-prestart.sh" in api
          and api.index("ExecStartPre=") < api.index("ExecStart=/usr/bin/node"))
    check("  ...starts the built server, not `eve start`, on loopback", "ExecStart=/usr/bin/node .output/server/index.mjs" in api and "HOST=127.0.0.1" in api and "NITRO_HOST=127.0.0.1" in api and "eve start\n" not in api)
    check("  ...reads its OWN env file, not the master one", "EnvironmentFile=/etc/software-factory/vm_remote_fixture/api.env" in api and "EnvironmentFile=/etc/software-factory/vm_remote_fixture/env\n" not in api)
    for name, f in (("web", "web.env"), ("workflow", "workflow.env")):
        check(f"the {name} unit reads {f} and nothing else", f"EnvironmentFile=/etc/software-factory/vm_remote_fixture/{f}" in U[f"{S['unit']}-{name}.service"]
              and U[f"{S['unit']}-{name}.service"].count("EnvironmentFile=") == 1)
    check("every cron call reads cron.env, and no unit reads the master env file", all("EnvironmentFile=/etc/software-factory/vm_remote_fixture/cron.env" in v for k, v in U.items() if "-cron-" in k and k.endswith(".service"))
          and not any("EnvironmentFile=/etc/software-factory/vm_remote_fixture/env\n" in v for v in U.values()))
    for name, port in (("web", 3000), ("workflow", 3002)):
        u = U[f"{S['unit']}-{name}.service"]
        check(f"the {name} unit binds loopback only and runs as the service user", f"-H 127.0.0.1 -p {port}" in u and "User=sfapp" in u and "0.0.0.0" not in u, u)
    check("no unit runs as root except the firewall's one-shot egress rule", all("User=sfapp" in v for k, v in U.items() if k.endswith(".service") and "-egress" not in k))
    for route, expr in crons:
        t = U[f"{S['unit']}-cron-{route}.timer"]; s = U[f"{S['unit']}-cron-{route}.service"]
        check(f"timer {route} fires on {expr}", f"OnCalendar={V.cron_to_oncalendar(expr)}" in t and f"cron-call.sh {route}" in s and "CRON_SECRET" not in s, t)
    cc = V.cron_call_sh(S, crons); curl_line = next(l for l in cc.splitlines() if "/usr/bin/curl" in l)
    check("the cron call hands CRON_SECRET to curl on stdin, never on its command line", "--config -" in curl_line and "$CRON_SECRET" not in curl_line.split("| /usr/bin/curl", 1)[1]
          and "127.0.0.1:3000/api/cron/$1" in curl_line, curl_line)
    check("  ...and refuses a route that is not one of the six", all(r in cc for r, _ in crons) and "not one of this app's cron routes" in cc)
    cf = V.caddyfile(S)
    check("the Caddyfile serves the domain over TLS and proxies only to the web app on loopback", "app.example.com {" in cf and "reverse_proxy 127.0.0.1:3000" in cf
          and "3001" not in cf and "3002" not in cf and "http://" not in cf, cf)
    check("  ...keeps the cron routes private and names the operator for certificate mail", "respond @cron 404" in cf and "path /api/cron/*" in cf and "email operator@example.com" in cf)
    fw = V.firewall_sh(S)
    allows = sorted(l.strip() for l in fw.splitlines() if l.strip().startswith("ufw allow"))
    check("the firewall allows 22, 80 and 443 and nothing else", allows == ["ufw allow 22/tcp", "ufw allow 443/tcp", "ufw allow 80/tcp"], allows)
    check("  ...denies everything else in, and enables", "ufw default deny incoming" in fw and "ufw --force enable" in fw and "ufw default deny routed" in fw)
    check("  ...turns fail2ban on for ssh", "fail2ban" in fw and "[sshd]" in V.fail2ban_jail(S) and "enabled = true" in V.fail2ban_jail(S) and "port = 22" in V.fail2ban_jail(S))
    check("  ...carries no Docker conntrack rule and refuses a server that has Docker", "ctorigdstport" not in fw and "conntrack -" not in fw and "DOCKER-USER" not in fw and "refusing: Docker is installed" in fw)
    check("  ...and is unchanged by a second run (it compares before it resets)", 'if [ "$have" != "$want" ]' in fw)
    fw2 = V.firewall_sh(_settings(lambda d: d["infrastructure"]["vm_remote"].update(ssh_port=2222)))
    check("a moved SSH port is the one allowed", "ufw allow 2222/tcp" in fw2 and "ufw allow 22/tcp" not in fw2 and "port = 2222" in V.fail2ban_jail(_settings(lambda d: d["infrastructure"]["vm_remote"].update(ssh_port=2222))))
    tun = lambda d: d["infrastructure"]["vm_remote"].update(ssh_host="10.44.0.2", ssh_allow_from="10.44.0.0/24")
    S4 = _settings(tun); fw4 = V.firewall_sh(S4)
    check("the allowed SSH source is a parameter: named, only that network reaches the SSH port (room for a private tunnel, mold_v1-156)",
          V.ufw_rules(S4) == ["ufw allow 443/tcp", "ufw allow 80/tcp", "ufw allow from 10.44.0.0/24 to any port 22 proto tcp"]
          and "  ufw allow from 10.44.0.0/24 to any port 22 proto tcp" in fw4 and "ufw allow 22/tcp" not in fw4, V.ufw_rules(S4))
    check("  ...and absent, the rule is today's", V.ufw_rules(S) == ["ufw allow 22/tcp", "ufw allow 443/tcp", "ufw allow 80/tcp"])
    p4 = {s["id"]: s for s in V.plan(S4, mold)}
    check("  ...SSH then goes to the tunnel address, while DNS and the sandbox deny list keep the public one",
          "root@10.44.0.2" in p4["packages"]["argv"] and V.sandbox_conflict(S4, ["203.0.113.10"]) is None and V.dns_problem(S4, lambda d: ["203.0.113.10"]) is None
          and V.dns_problem(S4, lambda d: ["10.44.0.2"]) is not None)
    nft = V.egress_nft(S)
    check("the egress rule keeps the service user off metadata and private ranges, and leaves loopback", all(x in nft for x in V.EGRESS_DENY) and "127.0.0.0/8" not in nft and 'meta skuid "sfapp"' in nft, nft)
    B = V.bundle(S, crons)
    changing = ("packages.sh", "firewall.sh", "postgres.sh", "build.sh", "db-chain.sh", "units.sh", "caddy.sh")
    for name in changing:
        body = [l for l in B[name][0].splitlines() if l.strip() and not l.startswith("#")]
        check(f"{name} refuses to run anywhere but the app's own server, before it does anything", body[0] == "set -eu" and body[1].startswith('[ "${SF_REMOTE_DEPLOY:-}" = "vm_remote_fixture" ] || {') and "exit 3" in body[1], body[:2])
    check("the read-only scripts say so", "READ-ONLY" in B["qualify.sh"][0] and "READ-ONLY" in B["health.sh"][0])
    everything = "\n".join(t for t, _ in B.values())
    check("no generated file uses rm -rf, and none deletes through a variable", "rm -rf" not in everything and "rm -r" not in everything and not [l for l in everything.splitlines() if "-delete" in l and "$" in l])
    out = os.path.join(tmp, "bundle"); V.write_bundle(S, crons, out)
    bash = shutil.which("bash")
    for name in sorted(k for k in B if k.endswith(".sh")):
        r = subprocess.run([bash, "-n", os.path.join(out, name)], capture_output=True, text=True) if bash else CP([], 0, "", "")
        check(f"{name} is valid shell (parsed, never run)", r.returncode == 0, r.stderr)
    spec = json.load(open(os.path.join(out, "env-services.json")))
    check("the bundle carries each service's env spec as data, names only", spec == V.service_env_spec(S) and set(spec) == {"web", "api", "workflow", "cron"})
    # Two more read-only parsers, used only where this machine has them: systemd's own unit checker, and nft's
    # check mode (-c: parsed and validated against the kernel, never applied). The service user does not exist
    # here, so the rule is checked with `nobody` standing in for it.
    sa = shutil.which("systemd-analyze")
    if sa and os.path.exists("/usr/bin/node"):
        units = sorted(os.path.join(out, "units", n) for n in os.listdir(os.path.join(out, "units")))
        r = subprocess.run([sa, "verify", "--man=no", *units], capture_output=True, text=True, timeout=60)
        check("every unit and timer passes `systemd-analyze verify` (read-only)", r.returncode == 0 and not r.stderr.strip(), r.stderr[-400:])
    nft = shutil.which("nft") or ("/usr/sbin/nft" if os.path.exists("/usr/sbin/nft") else None)
    if nft and os.geteuid() == 0:
        probe = os.path.join(tmp, "egress-check.nft")
        with open(probe, "w") as f: f.write(B["egress.nft"][0].replace(f'"{V.SERVICE_USER}"', '"nobody"'))
        r = subprocess.run([nft, "-c", "-f", probe], capture_output=True, text=True, timeout=30)
        check("the egress rule is valid nftables (`nft -c`: checked, never applied)", r.returncode == 0, r.stderr[-400:])
    check("the factory's own prewarm is gone: the mold's `npm run sandbox:prewarm` does that job", "prewarm-serial.mjs" not in B and not hasattr(V, "PREWARM_MJS"))
    pre = B["api-prestart.sh"][0]
    check("the API pre-start checks /dev/kvm, then runs the mold's prewarm with the runtime link and three tries per template, deleting nothing itself",
          pre.index("[ -c /dev/kvm ]") < pre.index("sandbox:prewarm") and pre.rstrip().endswith("exec /usr/bin/npm run --silent sandbox:prewarm -- --link-runtime --retries 2")
          and "-delete" not in pre and not re.search(r"(^|[;&|]\s*)rm\s", pre, re.M) and "cd /opt/software-factory/vm_remote_fixture/app" in pre, pre)
    b = B["build.sh"][0]; order = [b.index(x) for x in ("systemctl stop", "env-split --file", "npm ci --include=dev", "npm run build:eve", "-- npm run build\n", "services/task-workflow -- npm run build")]
    check("the build stops the services, splits the env files, then builds in place at the final path, one build at a time", order == sorted(order) and "/opt/software-factory/vm_remote_fixture/app" in b and " & " not in b and "wait\n" not in b, order)
    check("  ...as the service user, each part with its own service's env file loaded by env-run (never sourced by a shell)",
          all(f"env-run --file /etc/software-factory/vm_remote_fixture/{k}.env --user sfapp" in b for k in ("api", "web", "workflow"))
          and "env-run --file /etc/software-factory/vm_remote_fixture/env " not in b and ". /etc/software-factory" not in b
          and "$RUN_API /opt/software-factory/vm_remote_fixture/app -- npm run build:eve" in b and "$RUN_WEB /opt/software-factory/vm_remote_fixture/app -- npm run build\n" in b)
    dc = B["db-chain.sh"][0]
    check("the database step passes the new DATABASE_URL on to the services' files right after the chain", dc.index("host-chain") < dc.index("env-split --file /etc/software-factory/vm_remote_fixture/env --spec /opt/software-factory/vm_remote_fixture/factory/env-services.json"))
    pgs = B["postgres.sh"][0]
    check("Postgres listens on loopback with TLS on, and its password is minted on the server", "listen_addresses = '127.0.0.1'" in pgs and "ssl = on" in pgs and "pg-admin --file" in pgs and "PASSWORD" not in pgs)
    S2 = _settings(lambda d: (d["infrastructure"]["vm_remote"]["postgres"].update(tls="migration_switch", migration_switch_env="MIGRATE_SSLMODE"), d["datastores"]["postgres"].update(sslmode="disable")))
    check("  ...or TLS off with the migration switch set, when state says so", "ssl = off" in V.postgres_sh(S2) and V.config_pairs(S2).get("MIGRATE_SSLMODE") == "disable" and S2["sslmode"] == "disable")
    pk = B["packages.sh"][0]
    check("packages: Node 24, Caddy, PostgreSQL 17, ufw, fail2ban; a no-login service user; no Docker", all(x in pk for x in ("setup_24.x", "caddy", "postgresql-17", "ufw", "fail2ban", "--shell /usr/sbin/nologin sfapp")) and "docker" not in pk.lower())
    check("  ...the env directory is root's alone", "install -d -m 700 /etc/software-factory /etc/software-factory/vm_remote_fixture" in pk)
    copies = [rel for _, rel in V.bundle_copies()]
    check("the server gets the factory's own chain: provision.py, this module and every lib .mjs", ".claude/scripts/provision.py" in copies and ".claude/scripts/lib/vm_remote.py" in copies
          and all(f".claude/scripts/lib/{m}" in copies for m in ("deploy-window.mjs", "rls-cover.mjs", "rls-policy.mjs", "verify-apprw.mjs")), copies)
    check("  ...and they are in the written bundle, byte for byte", open(os.path.join(out, ".claude/scripts/provision.py"), "rb").read() == open(os.path.join(SCRIPTS, "provision.py"), "rb").read())
    check("generation is deterministic: a second bundle is identical (a re-run changes nothing by itself)", V.bundle(_settings(), V.read_crons(mold)) == B)
    hv, bad = V.health_verdict(S, V.parse_kv(fx("health-ok.txt")), crons)
    check("a healthy server's answer is accepted", bad == [] and hv == {"workflow": "200", "api": "200", "web": "200", "kvm": "ok"}, (hv, bad))
    def sick(**kw): return V.health_verdict(S, dict(V.parse_kv(fx("health-ok.txt")), **kw), crons)
    for label, kw, needle, kvm in (("Postgres open to the internet", {"PUBLIC_LISTENERS": "22 80 443 5432"}, "5432", "ok"),
                                   ("the API as root", {"API_USER": "root"}, "non-root", "ok"),
                                   ("the API outside group kvm", {"API_IN_KVM": "no"}, "group kvm", "api_not_in_kvm_group"),
                                   ("no /dev/kvm", {"KVM": "absent"}, "/dev/kvm", "device_missing"),
                                   ("five timers", {"TIMERS": "5"}, "5 of 6", "ok"),
                                   ("an inactive firewall", {"UFW": "inactive"}, "firewall", "ok"),
                                   ("a world-readable env file", {"ENV_MODE": "644 root"}, "mode 600", "ok"),
                                   ("a service env file the service user owns", {"ENV_FILES": "web=600-root api=600-sfapp workflow=600-root cron=600-root"}, "api.env is 600-sfapp", "ok"),
                                   ("a missing service env file", {"ENV_FILES": "web=600-root api=600-root workflow=600-root"}, "cron.env is missing", "ok"),
                                   ("an agent that holds the sign-in private key", {"API_PRIVATE_KEY": "yes"}, "AUTH_JWT_PRIVATE_KEY", "ok"),
                                   ("an agent whose environment could not be read", {"API_PRIVATE_KEY": "unread"}, "could not be read", "ok"),
                                   ("a dead API", {"API": "000"}, "api service answered no answer", "ok")):
        hv, bad = sick(**kw)
        check(f"health refuses {label}", any(needle in x for x in bad) and hv["kvm"] == kvm, (hv, bad))
    gaps = V.mold_gaps(mold)
    check("the mold snapshot is reported for what it lacks, by name (read-only scan)", isinstance(gaps, list) and all(g[0] in ("SANDBOX_BACKEND", "STORAGE_DRIVER", "SERVICE_AUTH", "sandbox:prewarm") for g in gaps), gaps)
    src = os.path.join(tmp, "src-ready"); os.makedirs(os.path.join(src, "agent")); os.makedirs(os.path.join(src, "lib"))
    check("  ...a source without the mold's `sandbox:prewarm` script lacks it, by name", "sandbox:prewarm" in [g[0] for g in V.mold_gaps(src)])
    json.dump({"scripts": {"sandbox:prewarm": "node scripts/sandbox-prewarm-serial.mjs"}}, open(os.path.join(src, "package.json"), "w"))
    open(os.path.join(src, "agent/sandbox.ts"), "w").write("process.env.SANDBOX_BACKEND"); open(os.path.join(src, "lib/storage.ts"), "w").write("process.env.STORAGE_DRIVER")
    check("  ...a source with two of the three switches lacks exactly the third", [g[0] for g in V.mold_gaps(src)] == ["SERVICE_AUTH"])
    open(os.path.join(src, "lib/service.ts"), "w").write("process.env.SERVICE_AUTH")
    check("  ...and one with all three lacks none", V.mold_gaps(src) == [])

# ---- 076: the env file ------------------------------------------------------------------------------------------
def _env_file(check, tmp):
    d = os.path.join(tmp, "etc", "app"); f = os.path.join(d, "env")
    added, changed, refused = V.env_merge(f, {"RESEND_API_KEY": SECRET, "PLATFORM_NOTIFY_FROM": "Example <no-reply@example.com>"})
    check("env-merge returns names, never values", added == ["PLATFORM_NOTIFY_FROM", "RESEND_API_KEY"] and not changed and not refused and SECRET not in json.dumps([added, changed, refused]))
    check("the env file is mode 600 in a directory only its owner can enter", stat.S_IMODE(os.stat(f).st_mode) == 0o600 and stat.S_IMODE(os.stat(d).st_mode) == 0o700, oct(os.stat(f).st_mode))
    check("values survive a round trip, spaces and angle brackets included", V.env_read(f) == {"RESEND_API_KEY": SECRET, "PLATFORM_NOTIFY_FROM": "Example <no-reply@example.com>"})
    before = open(f).read(); again = V.env_merge(f, {"RESEND_API_KEY": SECRET})
    check("merging the same pair again changes nothing", again == ([], [], []) and open(f).read() == before)
    check("  ...and a new value for a name is a change, by name", V.env_merge(f, {"RESEND_API_KEY": SECRET + "2"})[1] == ["RESEND_API_KEY"])
    for label, val in (("a line break", "a\nb"), ("a double quote", 'a"b'), ("a backslash", "a\\b"), ("nothing", "")):
        a2, c2, why = V.env_merge(f, {"EXA_API_KEY": val})
        check(f"a value with {label} is refused by NAME, and not stored", why and "EXA_API_KEY" in why[0] and (val == "" or val not in why[0]) and "EXA_API_KEY" not in V.env_read(f), why)
    tool = os.path.join(HERE, "vm_remote.py")
    r = subprocess.run([sys.executable, tool, "env-merge", "--file", f], input=f"CLOUDFLARE_API_TOKEN={SECRET}\n", capture_output=True, text=True)
    check("the env-merge command takes the value on stdin and prints only the name", r.returncode == 0 and "CLOUDFLARE_API_TOKEN" in r.stdout and SECRET not in r.stdout + r.stderr
          and SECRET not in " ".join(r.args), r.stdout + r.stderr)
    r = subprocess.run([sys.executable, tool, "env-names", "--file", f], capture_output=True, text=True)
    check("env-names prints names and no value", "CLOUDFLARE_API_TOKEN" in r.stdout.split() and SECRET not in r.stdout and "=" not in r.stdout, r.stdout)
    r = subprocess.run([sys.executable, tool, "env-merge", "--file", f], input='BAD_ONE=va"lue-' + SECRET + "\n", capture_output=True, text=True)
    check("a refused value exits non-zero and is not echoed", r.returncode == 1 and "BAD_ONE" in r.stderr and SECRET not in r.stdout + r.stderr, r.stderr)
    f2 = os.path.join(tmp, "etc", "mint", "env"); calls = []
    def pair(): calls.append(1); return "PRIVKEYBASE64", "PUBKEYBASE64"
    made = V.env_mint(f2, jwt_pair=pair)
    check("env-mint mints the six internal secrets once, on the machine that keeps them", made == sorted(V.MINTED) and len(V.env_read(f2)["CRON_SECRET"]) == 64 and stat.S_IMODE(os.stat(f2).st_mode) == 0o600, made)
    check("  ...the storage signing secret among them, long enough for the mold (32+ characters)", len(V.env_read(f2).get("STORAGE_SIGNING_SECRET", "")) >= 32)
    kept = dict(V.env_read(f2))
    check("  ...and a second run mints nothing and keeps every value", V.env_mint(f2, jwt_pair=pair) == [] and V.env_read(f2) == kept and len(calls) == 1)
    half = dict(kept); half.pop("AUTH_JWT_PUBLIC_KEY"); V.env_write(f2, half)
    check("  ...a key pair with one half missing is re-minted as a pair", V.env_mint(f2, jwt_pair=pair) == ["AUTH_JWT_PRIVATE_KEY", "AUTH_JWT_PUBLIC_KEY"] and V.env_read(f2)["CRON_SECRET"] == kept["CRON_SECRET"])
    if shutil.which("node"):
        priv, pub = V._jwt_pair()
        check("the real key-pair minter returns two base64 PEMs", len(priv) > 100 and len(pub) > 80 and " " not in priv)
    r = subprocess.run([sys.executable, tool, "env-run", "--file", f, "--user", os.environ.get("USER") or __import__("pwd").getpwuid(os.getuid()).pw_name, "--home", tmp, "--cwd", tmp,
                        "--", "sh", "-c", 'test "$CLOUDFLARE_API_TOKEN" = "$1" && test "$HOME" = "$2" && echo loaded', "x", SECRET, tmp], capture_output=True, text=True)
    check("env-run hands the file's values to the child's environment", r.stdout.strip() == "loaded", r.stdout + r.stderr)
    S = _settings(); c = V.config_pairs(S)
    check("the settings half of the env file holds no secret name", not (set(c) & set(V.SERVER_MADE)) and not (set(c) & set(V.operator_names(S))), sorted(c))
    check("  ...and carries the sandbox settings, the build-time flags and the loopback addresses", c["SANDBOX_BACKEND"] == "microsandbox" and c["SANDBOX_CPUS"] == "2" and c["SANDBOX_MEMORY_MIB"] == "1024"
          and c["ENABLE_WEB_SEARCH"] == "true" and c["ENABLE_BROWSER"] == "false" and c["EVE_API_URL"] == "http://127.0.0.1:3001" and c["TASK_WORKFLOW_SERVICE_URL"] == "http://127.0.0.1:3002"
          and c["WEB_ORIGIN"] == "https://app.example.com" and c["SERVICE_AUTH"] == "session-key" and c["EVE_DOCKER_PATH"] == "/nonexistent/docker", c)
    check("  ...the filesystem storage driver under the names the mold reads (STORAGE_DRIVER=filesystem, STORAGE_FS_ROOT, STORAGE_PUBLIC_URL)",
          c["STORAGE_DRIVER"] == "filesystem" and c["STORAGE_FS_ROOT"] == "/var/lib/software-factory/vm_remote_fixture/storage" and c["STORAGE_PUBLIC_URL"] == "https://app.example.com"
          and not ({"STORAGE_DIR", "DATAROOM_DIR", "STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_ACCESS_KEY_REF", "STORAGE_SECRET_KEY_REF"} & set(c)), sorted(c))
    check("  ...and DATABASE_SSL=require for the loopback Postgres with TLS on", c["DATABASE_SSL"] == "require")
    deny = c["SANDBOX_DENY_SUBNETS"].split(",")
    check("  ...the sandbox deny list is the five ranges and NOT the server's own address (filesystem file links point there)", sorted(deny) == sorted(V.DENY_REQUIRED) and "203.0.113.10/32" not in deny, deny)
    check("  ...every pair is storable", all(V.env_check(k, v) is None for k, v in c.items()))
    check("one Google client id feeds both names, so only one is asked for", "NEXT_PUBLIC_GOOGLE_CLIENT_ID" not in V.operator_names(S) and "GOOGLE_CLIENT_ID" in V.operator_names(S))
    said = []
    got = V.collect_secrets("a", ["RESEND_API_KEY", "GOOGLE_CLIENT_ID"], environ={"RESEND_API_KEY": SECRET}, ask=lambda prompt: "123-abc.apps.googleusercontent.com", tty=True, say=said.append)
    check("operator values come from a named environment value or the hidden prompt", got == {"RESEND_API_KEY": SECRET, "GOOGLE_CLIENT_ID": "123-abc.apps.googleusercontent.com", "NEXT_PUBLIC_GOOGLE_CLIENT_ID": "123-abc.apps.googleusercontent.com"}, sorted(got))
    check("  ...and nothing said along the way contains a value", SECRET not in "\n".join(said) and "123-abc" not in "\n".join(said), said)
    out, _ = quiet(V.collect_secrets, "a", ["RESEND_API_KEY"], environ={}, ask=lambda p: SECRET, tty=False)
    check("  ...with no terminal and no environment value it stops and names what is missing", isinstance(out, V.Stop) and "RESEND_API_KEY" in str(out) and "terminal" in str(out), out)
    tries = iter(["bad\\value", SECRET]); said = []
    got = V.collect_secrets("a", ["EXA_API_KEY"], environ={}, ask=lambda p: next(tries), tty=True, say=said.append, shape=lambda n, v: None)
    check("  ...a value the file cannot hold is asked for again, without being shown", got == {"EXA_API_KEY": SECRET} and "bad" not in "\n".join(said), said)
    out, _ = quiet(V.collect_secrets, "a", ["EXA_API_KEY"], environ={}, ask=lambda p: "nope", tty=True, say=lambda *_: None, shape=lambda n, v: f"{n}: that does not look right")
    check("  ...and three wrong shapes stop the deploy before anything is sent", isinstance(out, V.Stop) and "three tries" in str(out), out)
    psql_in = []
    def psql(sql): psql_in.append(sql); return CP([], 0, "", "")
    f3 = os.path.join(tmp, "etc", "pg", "env")
    made, printed = quiet(V.pg_admin, f3, "vmremotefixture", 5432, "require", psql)
    url = V.env_read(f3).get("POSTGRES_ADMIN_URL", ""); pw = url.split("sfadmin:")[1].split("@")[0] if "sfadmin:" in url else "?"
    check("pg-admin mints the admin password on the server and writes the loopback URL with TLS", made is True and url.startswith("postgresql://sfadmin:") and url.endswith("@127.0.0.1:5432/vmremotefixture?sslmode=require") and len(pw) == 48, url.replace(pw, "***"))
    check("  ...the password reaches psql on stdin only and is never printed", pw in psql_in[0] and pw not in printed and "CREATE DATABASE vmremotefixture" in psql_in[-1], printed)
    made, printed = quiet(V.pg_admin, f3, "vmremotefixture", 5432, "require", psql)
    check("  ...and a second run rotates nothing", made is False and len(psql_in) == 3 and V.env_read(f3)["POSTGRES_ADMIN_URL"] == url, printed)
    check("the app_rw URL is moved onto the port that answers, keeping its credentials", V.retarget("postgresql://app_rw:pw@db.example:6543/x?a=1", "postgresql://sfadmin:other@127.0.0.1:5432/x", "require")
          == "postgresql://app_rw:pw@127.0.0.1:5432/x?a=1&sslmode=require")

# ---- one env file per service (fde-agent #99: SERVICE_AUTH=session-key) -------------------------------------------
PRIV, PUB = "PRIV-" + SECRET, "PUB-KEY-material"
def _master_values(S):
    """Every name the master file holds after a deploy, with stand-in values."""
    m = dict(V.config_pairs(S))
    for k in V.MINTED: m[k] = f"{k}-{SECRET}"
    m["AUTH_JWT_PRIVATE_KEY"], m["AUTH_JWT_PUBLIC_KEY"] = PRIV, PUB
    m["POSTGRES_ADMIN_URL"] = "postgresql://sfadmin:ADMINPW@127.0.0.1:5432/x?sslmode=require"
    m["DATABASE_URL"] = "postgresql://app_rw:APPRWPW@127.0.0.1:5432/x?sslmode=require"
    for n in V.operator_names(S) + ["NEXT_PUBLIC_GOOGLE_CLIENT_ID"]: m[n] = f"{n}-{SECRET}"
    return m

def _service_env(check, tmp):
    S = _settings(); spec = V.service_env_spec(S); master = _master_values(S)
    v = V.split_values(master, spec)
    check("there is one env file per service: web, api, workflow and the cron calls", set(v) == {"web", "api", "workflow", "cron"} and set(S["env_files"]) == set(v))
    check("the agent's file holds NO sign-in private key", "AUTH_JWT_PRIVATE_KEY" not in v["api"] and PRIV not in json.dumps(v["api"]), sorted(v["api"]))
    check("  ...but the public key and SERVICE_AUTH=session-key, so it verifies the web app's service token", v["api"].get("AUTH_JWT_PUBLIC_KEY") == PUB and v["api"].get("SERVICE_AUTH") == "session-key")
    check("  ...and its own settings: sandbox, storage, model, database, the internal secrets it reads", all(k in v["api"] for k in ("SANDBOX_BACKEND", "SANDBOX_DENY_SUBNETS", "STORAGE_DRIVER", "STORAGE_FS_ROOT",
          "STORAGE_PUBLIC_URL", "STORAGE_SIGNING_SECRET", "DATABASE_URL", "CRON_SECRET", "OPS_SECRETS_KEY", "TASK_WORKFLOW_SERVICE_TOKEN", "WORKFLOW_LOCAL_DATA_DIR", "GOOGLE_CLIENT_ID", "CLOUDFLARE_API_TOKEN")), sorted(v["api"]))
    check("  ...and none of the web app's own names (agent address, mail, browser client id)", not (set(V.WEB_ONLY) & set(v["api"])), sorted(set(V.WEB_ONLY) & set(v["api"])))
    check("the web app's file holds the private key, the public key and SERVICE_AUTH=session-key", v["web"].get("AUTH_JWT_PRIVATE_KEY") == PRIV and v["web"].get("AUTH_JWT_PUBLIC_KEY") == PUB
          and v["web"].get("SERVICE_AUTH") == "session-key" and v["web"].get("NEXT_PUBLIC_EVE_API_URL") == v["web"].get("EVE_API_URL") == "http://127.0.0.1:3001")
    check("the task-workflow service gets only what it reads, and a workflow data directory of its own", sorted(v["workflow"]) == sorted(V.WORKFLOW_READS)
          and v["workflow"]["WORKFLOW_LOCAL_DATA_DIR"] == "/var/lib/software-factory/vm_remote_fixture/task-workflow-data" != v["api"]["WORKFLOW_LOCAL_DATA_DIR"], v["workflow"].keys())
    check("the cron calls get CRON_SECRET and nothing else", sorted(v["cron"]) == ["CRON_SECRET"])
    check("no service gets the database admin URL or the migration TLS switch", not any(k in vals for vals in v.values() for k in V.ADMIN_ONLY))
    check("  ...and nothing a service gets is a value it does not have in the master file (or a fixed setting)", all(vals[k] == master.get(k) for svc, vals in v.items() for k in vals if k not in spec[svc]["set"]))
    d = os.path.join(tmp, "etc", "split"); mf = os.path.join(d, "env"); V.env_write(mf, master)
    sp = os.path.join(tmp, "env-services.json"); json.dump(spec, open(sp, "w"))
    r = subprocess.run([sys.executable, os.path.join(HERE, "vm_remote.py"), "env-split", "--file", mf, "--spec", sp], capture_output=True, text=True)
    check("env-split writes the four files and prints names and counts only", r.returncode == 0 and SECRET not in r.stdout + r.stderr and "ADMINPW" not in r.stdout + r.stderr
          and all(f"{k}.env" in r.stdout for k in v), r.stdout + r.stderr)
    for k in v:
        p = os.path.join(d, f"{k}.env")
        check(f"  ...{k}.env is mode 600 and holds exactly its names", os.path.isfile(p) and stat.S_IMODE(os.stat(p).st_mode) == 0o600 and V.env_read(p) == v[k], k)
    check("  ...in the directory only its owner can enter, owned like the master file (root on the server)", stat.S_IMODE(os.stat(d).st_mode) == 0o700
          and all(os.stat(os.path.join(d, f"{k}.env")).st_uid == os.stat(mf).st_uid for k in v))
    check("  ...and the agent's file on disk has no private key in it", "AUTH_JWT_PRIVATE_KEY" not in open(os.path.join(d, "api.env")).read() and PRIV not in open(os.path.join(d, "api.env")).read())
    stale = dict(master, STORAGE_DIR="/var/lib/x/storage", DATAROOM_DIR="/var/lib/x/storage/dataroom")
    check("names an earlier plan wrote and the mold never read stay out of every service's file", not any(n in vals for vals in V.split_values(stale, spec).values() for n in V.RETIRED))
    gone = dict(master); gone.pop("EXA_API_KEY", None); V.env_write(mf, gone); V.env_split(mf, d, spec)
    check("a name taken out of the master file leaves every service's file on the next split", all("EXA_API_KEY" not in V.env_read(os.path.join(d, f"{k}.env")) for k in v))
    bad = json.loads(json.dumps(spec)); bad["api"]["drop"] = [n for n in bad["api"]["drop"] if n != "AUTH_JWT_PRIVATE_KEY"]
    before = open(os.path.join(d, "api.env")).read()
    out, printed = quiet(V.env_split, mf, d, bad)
    check("a spec that would hand the agent the private key is refused, and nothing is rewritten", isinstance(out, SystemExit) and "private key" in str(out)
          and open(os.path.join(d, "api.env")).read() == before and PRIV not in printed, out)
    check("the unit files point each service at exactly the file written for it", all(f"EnvironmentFile={S['env_files'][k]}" in t for k, t in
          ((k, V.unit_files(S, list(V.CRONS))[f"{S['unit']}-{n}.service"]) for k, n in (("web", "web"), ("api", "api"), ("workflow", "workflow")))))

# ---- storage names (fde-agent #103) and the sandbox deny list (fde-agent #100) --------------------------------------
def _storage_and_sandbox(check, tmp):
    s3 = lambda **kw: (lambda d: (d["infrastructure"]["vm_remote"].update(storage=dict({"driver": "s3", "bucket": "acme-files", "endpoint": "https://fra1.digitaloceanspaces.com",
                       "region": "fra1", "access_key_ref": "SPACES_KEY", "secret_key_ref": "SPACES_SECRET"}, **kw)),
                       d["infrastructure"]["secrets"].extend(["SPACES_KEY", "SPACES_SECRET"]), d["infrastructure"]["secrets_user"].extend(["SPACES_KEY", "SPACES_SECRET"]),
                       d["datastores"]["blob"].update(provider="s3")))
    d = fixture_docs(); s3()(d)
    e = F._check(d["infrastructure"], load(os.path.join(ROOT, "state/application/app_id/infrastructure.schema.json")), "x") + F._vm_remote("vm_remote_fixture", d)
    check("an s3 vm_remote app validates (the fixture, switched to Spaces)", e == [], e)
    S = _settings(s3()); c = V.config_pairs(S)
    check("the s3 driver's settings go under the names the mold reads", c["STORAGE_DRIVER"] == "s3" and c["STORAGE_S3_ENDPOINT"] == "https://fra1.digitaloceanspaces.com"
          and c["STORAGE_S3_BUCKET"] == "acme-files" and c["STORAGE_S3_REGION"] == "fra1" and c["NEXT_PUBLIC_STORAGE_HOST"] == "fra1.digitaloceanspaces.com"
          and not any(k.startswith("STORAGE_FS_") or k in ("STORAGE_PUBLIC_URL", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_REF") for k in c), sorted(c))
    check("  ...and the key pair is never a setting: only its NAMES are in state", not any(k in c for k in ("STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY", "SPACES_KEY", "SPACES_SECRET")))
    check("  ...virtual addressing puts the bucket in the browser's storage host", V.config_pairs(_settings(s3(addressing="virtual")))["NEXT_PUBLIC_STORAGE_HOST"] == "acme-files.fra1.digitaloceanspaces.com"
          and V.config_pairs(_settings(s3(addressing="virtual")))["STORAGE_S3_ADDRESSING"] == "virtual")
    m = _master_values(S); v = V.split_values(m, V.service_env_spec(S))
    check("on the server the operator's key pair reaches web and agent under STORAGE_S3_ACCESS_KEY_ID / STORAGE_S3_SECRET_ACCESS_KEY",
          all(v[k].get("STORAGE_S3_ACCESS_KEY_ID") == m["SPACES_KEY"] and v[k].get("STORAGE_S3_SECRET_ACCESS_KEY") == m["SPACES_SECRET"] for k in ("web", "api")))
    check("  ...and not under the stored names too, nor to the workflow service or the cron calls", not any(n in v[k] for k in v for n in ("SPACES_KEY", "SPACES_SECRET"))
          and "STORAGE_S3_ACCESS_KEY_ID" not in v["workflow"] and "STORAGE_S3_ACCESS_KEY_ID" not in v["cron"])
    check("  ...and on s3 no service holds the filesystem driver's signing secret", all("STORAGE_SIGNING_SECRET" not in v[k] for k in v))
    d = fixture_docs(); s3(endpoint=None)(d); d["infrastructure"]["vm_remote"]["storage"].pop("endpoint")
    check("validate refuses s3 without an endpoint (the mold refuses to start without STORAGE_S3_ENDPOINT)", any("storage.endpoint" in x for x in F._vm_remote("vm_remote_fixture", d)))
    # The names the plan writes, against the mold that will run them: every one must be read somewhere in its source.
    for label, src in (("this checkout's snapshot", MOLD),):
        if V.mold_gaps(src):
            check(f"(the name-by-name read check waits for {label} to carry #99-#101; it lacks {[g[0] for g in V.mold_gaps(src)]})", True); continue
        text = _source_text(src)
        names = set(V.config_pairs(_settings())) | set(V.config_pairs(S)) | set(V.MINTED) | {mold for _, mold in V.S3_KEYS} | set(V.WORKFLOW_READS)
        # Two names are read by eve itself, not by the app's own source (docs/self-hosting/SANDBOX.md names the first).
        by_eve = {"EVE_DOCKER_PATH", "WORKFLOW_LOCAL_DATA_DIR"}
        unread = sorted(n for n in names - {"DATABASE_SSL"} - by_eve if not re.search(r"\b" + n + r"\b", text))
        check(f"every name the plan writes is one {label} reads", unread == [], unread)
        eve = os.path.join(src, "node_modules", "eve", "dist")
        if os.path.isdir(eve):
            r = subprocess.run(["grep", "-rlwE", "|".join(sorted(by_eve)), eve], capture_output=True, text=True)
            hits = "\n".join(open(f, errors="ignore").read() for f in r.stdout.split()[:20])
            check("  ...and the two eve reads itself are in eve's own code", all(re.search(r"\b" + n + r"\b", hits) for n in by_eve), sorted(by_eve))
        check("  ...DATABASE_SSL included (the migration scripts)", re.search(r"\bDATABASE_SSL\b", open(os.path.join(src, "scripts/lib/migration-ssl.mjs")).read()) is not None)
        check("  ...and none the agent never reads is in its file", not any(re.search(r"\b" + n + r"\b", _source_text(src, ("agent",))) for n in ("AUTH_JWT_PRIVATE_KEY",)))
    # The sandbox deny list and the filesystem driver's file links
    S = _settings()
    check("the deny list never gains the server's own address", "203.0.113.10/32" not in V.deny_list(S) and V.sandbox_conflict(S) is None and V.sandbox_conflict(S, ["203.0.113.10"]) is None)
    own = lambda d: d["infrastructure"]["vm_remote"]["sandbox"]["deny_subnets"].append("203.0.113.10/32")
    S2 = _settings(own); why = V.sandbox_conflict(S2)
    check("filesystem storage with the server's own address denied is refused, in a sentence that names both fixes", why and "203.0.113.10/32" in why and "s3" in why
          and "deny_subnets" in why and "loopback" in why, why)
    d = fixture_docs(); own(d)
    check("  ...by validate too", any("inside vm_remote.sandbox.deny_subnets" in x and "203.0.113.10/32" in x for x in F._vm_remote("vm_remote_fixture", d)), F._vm_remote("vm_remote_fixture", d))
    rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--deploy-remote", "--dry-run"], d["application"], d["infrastructure"], d["datastores"], V.FIXTURE, P)
    check("  ...and the plan is not printed for it", rc == 1 and "[01 qualify]" not in printed, printed[:300])
    check("  ...but the same deny list with s3 storage is fine (its links point at the bucket)", V.sandbox_conflict(_settings(lambda d: (own(d), s3()(d)))) is None
          and F._vm_remote("vm_remote_fixture", (lambda d: (own(d), s3()(d), d)[-1])(fixture_docs())) == [])
    priv = _settings(lambda d: d["infrastructure"]["vm_remote"].update(host="10.20.0.5"))
    why = V.sandbox_conflict(priv)
    check("a server whose address is in a required private range cannot use filesystem storage: the fix offered is s3 or a public address",
          why and "10.0.0.0/8" in why and "s3" in why and "Take 10.0.0.0/8 out" not in why, why)
    wide = _settings(lambda d: d["infrastructure"]["vm_remote"]["sandbox"]["deny_subnets"].append("198.51.100.0/24"))
    check("an address the DOMAIN resolves to is checked too (the static check only sees the host)", V.sandbox_conflict(wide) is None and "198.51.100.7" in (V.sandbox_conflict(wide, ["198.51.100.7"]) or ""))
    # --qualify-remote: the domain is resolved and a conflict is a refusal, after the read-only probe. Nothing real is
    # contacted: the runner, the resolver, the key and the tool lookup are stand-ins for this one call.
    d = fixture_docs(); d["infrastructure"]["vm_remote"]["sandbox"]["deny_subnets"].append("198.51.100.0/24")
    adir = os.path.join(tmp, "qual", "vm_remote_fixture"); shutil.copytree(V.FIXTURE, adir); json.dump(d["infrastructure"], open(os.path.join(adir, "infrastructure.json"), "w"), indent=2)
    key = os.path.join(tmp, "qual", "key"); open(key, "w").close()
    saved = (V.real_runner, V.resolve, V.key_path, V.shutil.which)
    try:
        V.real_runner = lambda st, stdin=None: CP(st["argv"], 0, fx("qualify-ok.txt"), "")
        V.key_path = lambda S: key; V.shutil.which = lambda t: "/usr/bin/" + t
        V.resolve = lambda name: ["198.51.100.7"]
        rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--qualify-remote"], d["application"], d["infrastructure"], d["datastores"], adir, P)
        check("--qualify-remote refuses a server whose domain leads into the sandbox deny list while files are on its disk", rc == 1 and "cannot run the app" in printed and "198.51.100.0/24" in printed, printed[-400:])
        V.resolve = lambda name: ["203.0.113.10"]
        rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--qualify-remote"], d["application"], d["infrastructure"], d["datastores"], adir, P)
        check("  ...and accepts it when the domain leads to the public address", rc == 0 and "the server is fit" in printed, printed[-400:])
    finally:
        V.real_runner, V.resolve, V.key_path, V.shutil.which = saved

def _source_text(src, tops=("agent", "lib", "app", "services/task-workflow/lib", "services/task-workflow/app", "scripts")):
    out = []
    for top in tops:
        for dp, dirs, files in os.walk(os.path.join(src, top)):
            dirs[:] = [x for x in dirs if x not in ("node_modules", ".next", ".output", ".eve", "fixtures")]
            out += [open(os.path.join(dp, f), errors="ignore").read() for f in files if f.endswith((".ts", ".tsx", ".mjs", ".js")) and ".test." not in f]
    for f in ("next.config.ts", "proxy.ts"):
        if os.path.isfile(os.path.join(src, f)): out.append(open(os.path.join(src, f)).read())
    return "\n".join(out)

# ---- 076: host qualification -------------------------------------------------------------------------------------
def _qualification(check):
    ok = V.parse_kv(fx("qualify-ok.txt"))
    check("the probe's answer parses into facts", ok["KVM"] == "present" and ok["VCPU"] == "4" and ok["OS_VERSION"] == "24.04" and ok["PROXY"] == "none" and len(ok) == 11, ok)
    check("an 8 GB / 4 vCPU Ubuntu 24.04 host with KVM and no Docker qualifies", V.qualify(ok) == [])
    bad = V.qualify(V.parse_kv(fx("qualify-no-kvm.txt")))
    check("no /dev/kvm is refused, in words the operator can act on", len(bad) == 1 and "nested virtualization" in bad[0] and "Nothing was installed" in bad[0], bad)
    bad = V.qualify(V.parse_kv(fx("qualify-small.txt")))
    check("a 4 GB / 2 vCPU / 9 GB-free host is refused on each count", len(bad) == 3 and "3.8 GB of memory" in bad[0] and "2 virtual CPU" in bad[1] and "9.0 GB of free disk" in bad[2], bad)
    bad = V.qualify(V.parse_kv(fx("qualify-wrong-os.txt")))
    check("the wrong OS, an ARM processor, no sudo and Docker are each refused", len(bad) == 4 and "Ubuntu 24.04" in bad[0] and "aarch64" in bad[1] and "sudo" in bad[2] and "Docker is installed" in bad[3], bad)
    bad = V.qualify(V.parse_kv(fx("qualify-nginx.txt")))
    check("a server with another web server on it (nginx) is refused: Caddy is the one reverse proxy", len(bad) == 1 and "nginx" in bad[0] and "Caddy" in bad[0] and bad[0].endswith("."), bad)
    check("  ...and nothing the deploy installs is a second web server", not any(re.search(r"\b(nginx|apache2|haproxy|traefik)\b", text) for name, (text, _) in V.bundle(_settings(), list(V.CRONS)).items()
          if name not in ("qualify.sh",)) and "caddy" in V.packages_sh(_settings()))
    bad = V.qualify(V.parse_kv(fx("qualify-garbled.txt")))
    check("an answer that could not be read is a refusal, never a pass", len(bad) == 1 and "could not read" in bad[0] and "VCPU" in bad[0], bad)
    check("an empty answer is a refusal too", len(V.qualify({})) == 1)
    for sentence in V.qualify(V.parse_kv(fx("qualify-wrong-os.txt"))) + V.qualify(V.parse_kv(fx("qualify-small.txt"))):
        check("every refusal is a plain sentence (no key=value, no code)", "=" not in sentence and "KVM=" not in sentence and sentence.endswith("."), sentence)
    q = V.QUALIFY_SH
    check("the probe is read-only and reports every fact the rules read", all(f"{k}=" in q for k in ("OS_ID", "OS_VERSION", "ARCH", "KVM", "MEM_KB", "VCPU", "DISK_FREE_KB", "SUDO", "DOCKER", "SYSTEMD", "PROXY"))
          and not any(w in q for w in ("apt", "install ", "rm ", "systemctl", ">/etc", "tee ")), q)

# ---- 076: the plan and the dry run -------------------------------------------------------------------------------
STEP_IDS = ["qualify", "dns", "mkdir", "bundle", "packages", "firewall", "postgres", "env-config", "env-mint", "env-names", "env-secrets",
            "source", "build", "db-chain", "units", "caddy", "health", "health-public"]
def _plan_and_dry_run(check, tmp):
    S = _settings(); mold = os.path.join(ROOT, "molds/mold_v1/codebase"); crons = V.read_crons(mold); B = V.bundle(S, crons)
    steps = V.plan(S, mold)
    check("the plan is the eighteen steps, qualification first", [s["id"] for s in steps] == STEP_IDS, [s["id"] for s in steps])
    check("every script a step runs is in the bundle", all(s["script"] in B for s in steps if s.get("script")))
    remote = [s for s in steps if "argv" in s]
    check("every remote step goes over ssh or rsync to the app's own host, with the named key", all(s["argv"][0] in ("ssh", "rsync") and "root@203.0.113.10" in " ".join(s["argv"]) for s in remote)
          and all(V.KEY_MARK in " ".join(s["argv"]) for s in remote))
    changing = [s for s in remote if s["argv"][0] == "ssh" and s["id"] not in ("qualify", "env-names", "health")]
    check("every step that changes the server carries the guard marker; the three read-only ones do not need it", all("SF_REMOTE_DEPLOY=vm_remote_fixture" in s["argv"][-1] for s in changing), [s["id"] for s in changing])
    src = next(s for s in steps if s["id"] == "source")
    check("the source step copies source, never a build", all(x in src["argv"] for x in ("node_modules", ".next", ".output", ".eve", ".env", ".env.*")) and src["argv"][-1] == "root@203.0.113.10:/opt/software-factory/vm_remote_fixture/app/", src["argv"])
    check("the build and database steps come after the source and before the units", STEP_IDS.index("source") < STEP_IDS.index("build") < STEP_IDS.index("db-chain") < STEP_IDS.index("units") < STEP_IDS.index("caddy"))
    S2 = _settings(lambda d: d["infrastructure"]["vm_remote"].update(ssh_user="deploy"))
    p2 = {s["id"]: s for s in V.plan(S2, mold)}
    check("a non-root login runs every changing step through sudo", p2["packages"]["argv"][-1].startswith("sudo env SF_REMOTE_DEPLOY=") and "sudo rsync" in p2["source"]["argv"], p2["packages"]["argv"][-1])
    lines = []; V.print_plan(S, steps, B, crons, V.mold_gaps(mold), out=lines.append); text = "\n".join(lines)
    check("the dry run prints every step, its local command and its remote script", all(f"[{i:02d} {sid}]" in text for i, sid in enumerate(STEP_IDS, 1)) and all(f"remote script factory/{s['script']}:" in text for s in steps if s.get("script")))
    check("  ...every generated file, unit and timer included", all(f"--- factory/{k}" in text for k in B if k not in {s.get("script") for s in steps}) and text.count("OnCalendar=") == 6)
    check("  ...says twice that nothing was run, and never shows a key path or a secret value", text.startswith("DRY RUN") and lines[-1].endswith("nothing was run and nothing was contacted.") and os.path.expanduser("~/.ssh") not in text and "~/.ssh/sf_vm_remote_fixture" in text)
    check("  ...lists the operator's names and says they are typed hidden", "CLOUDFLARE_API_TOKEN" in text and "hidden" in text and "minted on the server, never here" in text)
    d = fixture_docs()
    rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--deploy-remote", "--dry-run"], d["application"], d["infrastructure"], d["datastores"], V.FIXTURE, P)
    check("`--deploy-remote --dry-run` prints that same plan and exits 0 without connecting", rc == 0 and printed.strip() == text.strip(), printed[:300])
    r = subprocess.run([sys.executable, os.path.join(HERE, "vm_remote.py"), "plan", V.FIXTURE], capture_output=True, text=True)
    check("`vm_remote.py plan <fixture>` prints it too", r.returncode == 0 and r.stdout.strip() == text.strip(), r.stderr[:300])
    S3 = _settings(lambda d: (d["infrastructure"]["vm_remote"].pop("host"), d["infrastructure"]["vm_remote"].pop("domain")))
    lines = []; V.print_plan(S3, V.plan(S3, mold), V.bundle(S3, crons), crons, [], out=lines.append)
    check("with no server supplied yet the plan still prints, with a placeholder and the command that supplies it", V.NO_HOST in "\n".join(lines) and "--set-remote host=<address> domain=<name>" in "\n".join(lines))
    rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--deploy-remote"], d["application"], d["infrastructure"], d["datastores"], V.FIXTURE, P)
    check("a real deploy of the fixture is refused before anything is contacted", rc == 1 and "Nothing was contacted" in printed, printed[:400])
    rc, printed = quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--deploy"], d["application"], d["infrastructure"], d["datastores"], V.FIXTURE, P)
    check("`--deploy` on a vm_remote app points at --deploy-remote", rc == 1 and "--deploy-remote" in printed)
    rc, printed = quiet(V.check, "vm_remote_fixture", d["application"], d["infrastructure"], d["datastores"], V.FIXTURE)
    check("`--check` is offline, lists the steps, and says what is still to do", rc in (0, 1) and "nothing was contacted and nothing was created" in printed and "a deploy will, in order:" in printed and "18." in printed, printed[-600:])

# ---- 076: the deploy sequence against recorded answers -----------------------------------------------------------
def _deploy_sequence(check, tmp):
    S = _settings(); mold = os.path.join(ROOT, "molds/mold_v1/codebase"); crons = V.read_crons(mold)
    ev_line = "  isolation proof: {...}\nEVIDENCE " + json.dumps({"at": "x", "mode": "fail_closed", "backend": "self_hosted", "protected": 58})
    waits = []
    def attempt(answers, names_present="", secrets=None, resolver=lambda d: ["203.0.113.10"], fail_at=None):
        log, said, asked, started = [], [], [], []; waits.clear()
        def runner(step, stdin=None):
            log.append((step["id"], list(step["argv"]), stdin))
            if step["id"] == fail_at: return CP(step["argv"], 1, "", "npm ERR! build failed")
            out = {"qualify": answers, "env-names": names_present, "db-chain": ev_line, "health": fx("health-ok.txt")}.get(step["id"], "ok")
            return CP(step["argv"], 0, out, "")
        def secrets_for(names): asked.append(list(names)); return {k: f"{SECRET}-{k}" for k in names} if secrets is None else secrets
        try: res = V.deploy(S, mold, crons, runner=runner, secrets_for=secrets_for, resolver=resolver, read_health=lambda u: ("200", HEALTH_DOC, ""),
                            say=said.append, bundle_dir=os.path.join(tmp, f"deploy-{len(os.listdir(tmp))}"), on_started=lambda: started.append(1), wait=waits.append)
        except V.Stop as e: res = e
        return res, log, said, asked, started
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"))
    ran = [x[0] for x in log]
    check("a deploy runs the plan's remote steps in the plan's order", ran == [s for s in STEP_IDS if s not in ("dns", "health-public")], ran)
    check("  ...asks only for the operator's names the server lacks", asked == [V.operator_names(S)], asked)
    sec = next(x for x in log if x[0] == "env-secrets")
    check("  ...sends their values on the stdin of ONE command", all(f"{SECRET}-{k}" in sec[2] for k in V.operator_names(S)) and sum(1 for x in log if x[2] and SECRET in x[2]) == 1)
    check("  ...and on no command line and in nothing it printed", not any(SECRET in " ".join(x[1]) for x in log) and SECRET not in "\n".join(said), [l for l in said if SECRET in l])
    cfg = next(x for x in log if x[0] == "env-config")[2]
    check("  ...the settings step carries settings only", "SANDBOX_BACKEND=microsandbox" in cfg and not any(k + "=" in cfg for k in V.operator_names(S)))
    check("  ...returns the health verdict, the evidence and the outside reading", not isinstance(res, V.Stop) and res["health"]["kvm"] == "ok" and res["problems"] == [] and res["evidence"]["protected"] == 58 and res["public"][0] == "200", res)
    check("  ...and marks the point after which the server is changed", started == [1])
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"), names_present="\n".join(V.operator_names(S)))
    check("a second deploy asks for nothing and sends no secret step", asked == [] and "env-secrets" not in [x[0] for x in log] and not isinstance(res, V.Stop), [x[0] for x in log])
    res, log, said, asked, started = attempt(fx("qualify-no-kvm.txt"))
    check("an unfit host stops the deploy after the read-only probe: nothing else runs", isinstance(res, V.Stop) and [x[0] for x in log] == ["qualify"] and "nested virtualization" in str(res) and started == [], str(res))
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"), resolver=lambda d: ["198.51.100.7"])
    check("a domain that points elsewhere stops it before anything is installed", isinstance(res, V.Stop) and [x[0] for x in log] == ["qualify"] and "198.51.100.7" in str(res) and "A record" in str(res) and started == [], str(res))
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"), resolver=lambda d: [])
    check("  ...and so does a domain that leads nowhere", isinstance(res, V.Stop) and "does not lead anywhere yet" in str(res))
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"), fail_at="build")
    check("a failed build stops there, says so, and nothing after it runs", isinstance(res, V.Stop) and "step build stopped" in str(res) and [x[0] for x in log][-1] == "build" and "safe to run again" in str(res), str(res))
    res, log, said, asked, started = attempt(fx("qualify-ok.txt"), secrets={})
    check("a value the operator did not supply stops it before the build", isinstance(res, V.Stop) and "still missing" in str(res) and "build" not in [x[0] for x in log])
    answers = iter([("", None, "nothing answered"), ("", None, "nothing answered"), ("200", HEALTH_DOC, ""), ("200", None, "")]); slept = []
    res = V.deploy(S, mold, crons, runner=lambda st, stdin=None: CP(st["argv"], 0, {"qualify": fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(S)), "db-chain": ev_line,
                   "health": fx("health-ok.txt")}.get(st["id"], "ok"), ""), resolver=lambda d: ["203.0.113.10"], read_health=lambda u: next(answers), say=lambda *_: None,
                   bundle_dir=os.path.join(tmp, "deploy-wait"), wait=slept.append)
    check("the outside health read waits for the certificate instead of failing a first deploy", slept == [10, 10] and res["public"][0] == "200" and res["problems"] == [], (slept, res["problems"]))
    step = {"id": "t", "argv": ["sh", "-c", "cat; echo err >&2; exit 3"], "timeout": 10}
    r = V.real_runner(step, "from-stdin")
    check("the real runner feeds stdin from memory and returns output and exit code", r.stdout == "from-stdin" and r.returncode == 3 and "err" in r.stderr)
    out, _ = quiet(V.real_runner, {"id": "slow", "argv": ["sh", "-c", "sleep 20"], "timeout": 1})
    check("  ...and a step past its deadline is stopped with a sentence", isinstance(out, V.Stop) and "did not finish within 1s" in str(out), out)
    check("command output is scrubbed of credentials before it is shown", "pw" not in V.redact("postgresql://sfadmin:pw@127.0.0.1/db") and "tok" not in V.redact("Authorization: Bearer tok"))
    check("the DNS check compares the domain with the server's address", V.dns_problem(S, lambda d: ["203.0.113.10"]) is None)

# ---- 076: the database chain is provision.py's chain ------------------------------------------------------------
def _host_chain(check, tmp):
    def attempt(name, tables, dry_run_out="[i] No changes detected"):
        app = os.path.join(tmp, name, "app"); os.makedirs(app); envf = os.path.join(tmp, name, "env")
        V.env_write(envf, {"POSTGRES_ADMIN_URL": "postgresql://sfadmin:ADMINPW@127.0.0.1:5432/x?sslmode=require"})
        calls, seen = [], {}
        def run(script, env):
            act = env.get("ACTION"); calls.append(script.replace(".mjs", "") + (f":{act}" if act else ""))
            if script == "deploy-window.mjs":
                if act == "probe": return CP([], 0, json.dumps({"action": "probe", "public_tables": tables, "read_only": "read_only" in env["ADMIN_URL"], "pks": {}}), "")
                if act == "hold": return CP([], 0, '{"action":"hold","held":true,"tables":58}', "")
                if act == "release": return CP([], 0, '{"action":"release","released":58}', "")
                return CP([], 0, '{"action":"apply","applied":1}', "")
            if script == "rls-cover.mjs": return CP([], 0, '{"covered":58}', "")
            if script == "verify-apprw.mjs":
                seen["url_at_proof"] = env["APP_RW_URL"]; seen["published_before_proof"] = "DATABASE_URL" in V.env_read(envf)
                return CP([], 0, json.dumps(EVIDENCE_JSON), "")
            return CP([], 1, "", "unknown")
        def sh(cmd, env):
            calls.append("sh:" + ("push-force" if "push --force" in cmd else "dry-run" if "--strict" in cmd else "journal" if "migrate-production" in cmd
                                  else "bootstrap" if "bootstrap" in cmd else "task-workflow" if "task-workflows" in cmd else cmd))
            if "--strict" in cmd: return CP(cmd, 0, dry_run_out, "")
            if "bootstrap" in cmd:
                seen["supabase_file"] = os.path.exists(os.path.join(app, ".env.supabase"))
                open(os.path.join(app, ".env.local"), "a").write('DATABASE_URL="postgresql://app_rw:APPRWPW@127.0.0.1:6543/x"\n')
                return CP(cmd, 1, "DATABASE_URL now points at app_rw\nError: connect ECONNREFUSED 127.0.0.1:6543", "")
            return CP(cmd, 0, "ok", "")
        out, printed = quiet(V.host_chain, app, envf, "fail_closed", "require", P=P, sh=sh, run=run)
        return out, printed, calls, seen, envf, app
    out, printed, calls, seen, envf, app = attempt("live", 3)
    want = ["deploy-window:hold", "deploy-window:probe", "sh:journal", "deploy-window:hold", "deploy-window:probe", "sh:dry-run", "deploy-window:hold",
            "sh:bootstrap", "sh:task-workflow", "rls-cover", "deploy-window:release", "verify-apprw"]
    check("on a live database the server runs hold, journal, hold, drift dry run, hold, bootstrap, task-workflow, cover, release, prove", calls == want, calls)
    check("  ...DATABASE_URL is written only after the proof, on the port that answers, with TLS", seen.get("published_before_proof") is False
          and V.env_read(envf).get("DATABASE_URL") == "postgresql://app_rw:APPRWPW@127.0.0.1:5432/x?sslmode=require" and seen["url_at_proof"] == V.env_read(envf)["DATABASE_URL"], V.env_names(envf))
    check("  ...the evidence line carries counts and no credential", isinstance(out, dict) and out["protected"] == 58 and out["backend"] == "self_hosted" and "EVIDENCE {" in printed
          and "ADMINPW" not in printed and "APPRWPW" not in printed, printed[-300:])
    check("  ...the transient admin file existed only for the bootstrap", seen.get("supabase_file") is True and not os.path.exists(os.path.join(app, ".env.supabase")) and not os.path.exists(os.path.join(app, ".env.local")))
    check("  ...and it is the chain provision.py declares, run by provision.py's own runner", tuple(P.SCHEMA_CHAIN) == ("hold", "push", "migrate", "hold", "drift", "hold", "bootstrap", "task-workflow", "cover", "release", "prove", "publish")
          and "P._run_chain(" in open(os.path.join(HERE, "vm_remote.py")).read())
    out, printed, calls, seen, envf, app = attempt("empty", 0)
    check("on an empty database it pushes the schema once and plans no drift", calls[:3] == ["deploy-window:hold", "deploy-window:probe", "sh:push-force"] and "sh:dry-run" not in calls and isinstance(out, dict), calls)
    loss = " Warning  You are about to execute current statements:\n\nALTER TABLE \"t\" DROP COLUMN \"c\";\n\nError: x"
    out, printed, calls, seen, envf, app = attempt("loss", 3, loss)
    check("a drift plan that would delete data stops the chain", isinstance(out, SystemExit) and "DELETE data" in str(out) and "DROP COLUMN" in str(out), out)
    check("  ...before any bootstrap, with the guard still held and no DATABASE_URL written", "sh:bootstrap" not in calls and "deploy-window:release" not in calls and "deploy-window:apply" not in calls
          and "DATABASE_URL" not in V.env_read(envf), calls)
    V.env_merge(envf, {"DATABASE_URL": "postgresql://app_rw:APPRWPW@127.0.0.1:5432/x?sslmode=require"})
    calls2 = []
    def run2(script, env): calls2.append(script); return CP([], 0, json.dumps(EVIDENCE_JSON) if script == "verify-apprw.mjs" else "{}", "")
    out, printed = quiet(V.host_chain, app, envf, "fail_closed", "require", measure_only=True, repair=False, P=P, run=run2)
    check("--verify-rls measures on the server without repairing or rotating", calls2 == ["verify-apprw.mjs"] and isinstance(out, dict) and "EVIDENCE {" in printed, calls2)
    out, printed = quiet(V.host_chain, app, os.path.join(tmp, "absent-env"), "fail_closed", "require", P=P, run=run2)
    check("a server with no admin URL is one sentence, not a traceback", isinstance(out, SystemExit) and "POSTGRES_ADMIN_URL" in str(out))

# ---- 076: what a deploy records ----------------------------------------------------------------------------------
def _records(check, tmp):
    def stage(name):
        d = os.path.join(tmp, name, "vm_remote_fixture"); shutil.copytree(V.FIXTURE, d)
        docs = {k: load(os.path.join(d, f"{k}.json")) for k in ("application", "infrastructure", "datastores")}
        S = V.settings("vm_remote_fixture", docs["application"], docs["infrastructure"], docs["datastores"])
        return d, docs, S
    evd, _ = quiet(P._verify_app_rw, lambda s, e: CP([], 0, json.dumps(EVIDENCE_JSON), ""), "postgresql://app_rw:x@127.0.0.1/x", "fail_closed", "self_hosted", "self-test", "hint")
    hv = {"workflow": "200", "api": "200", "web": "200", "kvm": "ok"}
    good = {"health": hv, "problems": [], "evidence": evd, "facts": {}, "public": ("200", HEALTH_DOC, "")}
    def fake(res=None, stop=None, start=True):
        def deploy_fn(S, src, crons, on_started=None, secrets_for=None, read_health=None, **_):
            if start and on_started: on_started()
            if stop: raise V.Stop(stop)
            return res
        return deploy_fn
    d, docs, S = stage("ok")
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, MOLD, list(V.CRONS), fake(good))
    app, infra, ds = (load(os.path.join(d, f"{k}.json")) for k in ("application", "infrastructure", "datastores"))
    check("a deploy that passes every gate records stamped, the URL, the instant and the health", rc == 0 and app["status"] == "stamped" and infra["vm_remote"]["production_url"] == "https://app.example.com"
          and infra["deployed_at"] == P.NOW and infra["vm_remote"]["health"]["kvm"] == "ok" and infra["vm_remote"]["health"]["qualified_at"] == P.NOW, printed[-300:])
    check("  ...and the isolation evidence, with the running app's own reading", ds["postgres"]["rls_verified"]["running_app"] == "enforced" and ds["postgres"]["rls_verified"]["at"] == P.NOW and ds["postgres"]["rls_verified"]["backend"] == "self_hosted")
    errs, _ = F._app_errors("vm_remote_fixture", d)
    check("  ...and that recorded state VALIDATES as a deployed application", errs == [], errs)
    check("  ...which the lanes then grade at its own URL", lane_url.target_url(infra) == "https://app.example.com")
    d, docs, S = stage("unproven")
    bad = dict(good, public=("502", None, "HTTP 502, and the body is not a health document"))
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, MOLD, list(V.CRONS), fake(bad))
    app, infra = load(os.path.join(d, "application.json")), load(os.path.join(d, "infrastructure.json"))
    check("an app whose health cannot be read from outside is reverted, never stamped, and gets no URL", rc == 1 and app["status"] == "reverted" and "unmeasured" in app["revert"]["reason"]
          and "production_url" not in infra["vm_remote"] and "deployed_at" not in infra, app.get("revert"))
    check("  ...and that state validates too (a reverted app claims nothing)", F._app_errors("vm_remote_fixture", d)[0] == [], F._app_errors("vm_remote_fixture", d)[0])
    d, docs, S = stage("sick")
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, MOLD, list(V.CRONS),
                        fake(dict(good, problems=["something on the server listens to the internet on port(s) 5432; only 22, 80, 443 may"])))
    check("a server left with a public database port is reverted with that sentence", rc == 1 and "5432" in load(os.path.join(d, "application.json"))["revert"]["reason"])
    d, docs, S = stage("stopped")
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, MOLD, list(V.CRONS), fake(stop="step build stopped (exit 1): npm ERR!"))
    app = load(os.path.join(d, "application.json"))
    check("a deploy that stops after it began is recorded reverted with the reason", rc == 1 and app["status"] == "reverted" and "step build stopped" in app["revert"]["reason"], app)
    d, docs, S = stage("nosrc")
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, os.path.join(tmp, "not-a-source"), list(V.CRONS), fake(good))
    check("a source directory that is not the application is refused before anything is copied", rc == 1 and "not the application's source" in printed and load(os.path.join(d, "application.json"))["status"] == "planned", printed)
    d, docs, S = stage("refused")
    rc, printed = quiet(V.run_deploy, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, MOLD, list(V.CRONS), fake(stop="This server cannot run the app", start=False))
    check("a refusal before anything changed leaves the status alone and says so", rc == 1 and load(os.path.join(d, "application.json"))["status"] == "planned" and "status is unchanged" in printed, printed)
    d, docs, S = stage("verify")
    runner = lambda step: CP(step["argv"], 0, '  isolation proof: {"role":"app_rw"}\nEVIDENCE ' + json.dumps(evd), "")
    rc, printed = quiet(V.verify_rls, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, False, runner, lambda u: ("200", HEALTH_DOC, ""))
    check("--verify-rls records the server's proof and the running app's reading, and prints the proof line the functional lane looks for",
          rc == 0 and load(os.path.join(d, "datastores.json"))["postgres"]["rls_verified"]["running_app"] == "enforced" and any(l.strip().startswith("isolation proof:") for l in printed.splitlines()), printed)
    rc, printed = quiet(V.verify_rls, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, False, runner,
                        lambda u: ("200", {"db": {"ok": True, "detail": "SELECT 1 ok · role postgres — WARNING: BYPASSRLS, row-level security is NOT enforced"}}, ""))
    check("  ...and fails when the running app says row-level security is not enforced", rc == 1 and "--deploy-remote" in printed)
    rc, printed = quiet(V.verify_rls, "vm_remote_fixture", S, docs["application"], docs["infrastructure"], docs["datastores"], d, P, False, lambda step: CP([], 255, "", "ssh: connect to host: timed out"), None)
    check("  ...and when the server cannot be reached, without recording anything new", rc == 1 and "could not be proven" in printed)

# ---- the operator's own commands ---------------------------------------------------------------------------------
def _operator_commands(check, tmp):
    d = os.path.join(tmp, "set", "vm_remote_fixture"); shutil.copytree(V.FIXTURE, d)
    out, printed = quiet(V.set_remote, "vm_remote_fixture", d, ["host=198.51.100.20", "domain=Research.Example.com", "ssh_port=2222"])
    vr = load(os.path.join(d, "infrastructure.json"))["vm_remote"]
    check("--set-remote writes the server address and the domain into state", vr["host"] == "198.51.100.20" and vr["domain"] == "research.example.com" and vr["ssh_port"] == 2222, printed)
    before = open(os.path.join(d, "infrastructure.json")).read()
    for bad, needle in ((["password=hunter2"], "not one of them"), (["host=root@198.51.100.20"], "without a user name"), (["ssh_port=abc"], "must be a number"), (["ssh_key_ref=/root/.ssh/id_rsa"], "did not fit")):
        out, _ = quiet(V.set_remote, "vm_remote_fixture", d, bad)
        check(f"  ...and refuses {bad[0].split('=')[0]}={'<bad>'} without writing", isinstance(out, V.Stop) and needle in str(out) and open(os.path.join(d, "infrastructure.json")).read() == before, out)
    if shutil.which("ssh-keygen"):
        home = os.path.join(tmp, "home"); S = _settings(); said = []
        pub = V.remote_key(S, say=said.append, home=home); priv = os.path.join(home, ".ssh", "sf_vm_remote_fixture")
        check("--remote-key makes the named key pair and prints only the public half", pub.startswith("ssh-ed25519 ") and os.path.isfile(priv) and stat.S_IMODE(os.stat(priv).st_mode) == 0o600
              and "PRIVATE KEY" not in "\n".join(said) and "sf_vm_remote_fixture" in "\n".join(said), said)
        check("  ...and a second run makes nothing new", V.remote_key(S, say=lambda *_: None, home=home) == pub)
    check("the source to ship is the mold for a plain app and the build copy for a branded or packed one", V.source_for("x", {"mold_id": "mold_v1"}).endswith("molds/mold_v1/codebase")
          and V.source_for("x", {"mold_id": "mold_v1", "packs": ["p"]}).endswith("build/x"))

# ---- 078: the lanes ----------------------------------------------------------------------------------------------
def _lanes(check):
    docs = fixture_docs(); infra = docs["infrastructure"]
    check("an undeployed vm_remote app has no URL to grade", lane_url.target_url(infra) == "")
    dep = json.loads(json.dumps(infra)); dep["vm_remote"]["production_url"] = "https://app.example.com"; dep["deployed_at"] = "2026-10-02T10:00:00+00:00"
    check("a deployed one is graded at vm_remote.production_url", lane_url.target_url(dep) == "https://app.example.com")
    typed = json.loads(json.dumps(dep)); typed.pop("deployed_at")
    check("  ...but never at a URL no deploy recorded", lane_url.target_url(typed) == "")
    other = json.loads(json.dumps(dep)); other["vm_remote"]["production_url"] = "https://elsewhere.example.com"
    check("  ...nor at one that is not the app's own domain", lane_url.target_url(other) == "")
    check("a vercel app is graded where it always was", lane_url.target_url({"target": "vercel", "vercel": {"production_url": "https://x.vercel.app/"}}) == "https://x.vercel.app")
    check("a vm app has none", lane_url.target_url({"target": "vm", "vm": {}}) == "")
    ddocs = dict(docs, infrastructure=dep)
    check("the mold's `infrastructure.vercel.production_url` precondition is answered by the vm_remote URL", L.state_get(ddocs, "infrastructure.vercel.production_url") == "https://app.example.com"
          and L.state_get(docs, "infrastructure.vercel.production_url") is None)
    vdocs = {"infrastructure": {"target": "vercel", "vercel": {"production_url": "https://x.vercel.app"}}}
    check("  ...and for a vercel app that path still reads the vercel object", L.state_get(vdocs, "infrastructure.vercel.production_url") == "https://x.vercel.app")
    ctx = L.context("vm_remote_fixture", "functional", "mold_v1", ddocs, "r")
    check("the lane context's {url} is the vm_remote URL", ctx["url"] == "https://app.example.com")
    testing = os.path.join(ROOT, "molds/mold_v1/testing")
    spec = L.read_spec("functional", "mold_v1"); turn = next(c for c in spec["checks"] if c["name"] == "chat.turn")
    cmd = L.subst(turn["run"], ctx)
    check("the mold's lane-url.py calls are answered by the runner's resolver for a vm_remote app", "lib/lane_url.py vm_remote_fixture" in cmd and "lane-url.py" not in cmd, cmd)
    for lane in ("accessibility", "responsiveness"):
        sp = L.read_spec(lane, "mold_v1"); c = L.subst(sp["checks"][0]["run"], dict(ctx, lane=lane))
        check(f"  ...in the {lane} lane too, harness arguments included", "lib/lane_url.py vm_remote_fixture --harness" in c and "lane-url.py" not in c, c)
    rls = next(c for c in spec["checks"] if c["name"] == "rls")
    msg = L.subst(rls["requires"][1]["else"], ctx)
    check("an instruction that ended --deploy names --deploy-remote, once", msg.endswith("provision.py vm_remote_fixture --deploy-remote") and "remote-remote" not in L.subst(msg, ctx), msg)
    vctx = L.context("vm_remote_fixture", "functional", "mold_v1", dict(docs, infrastructure={"target": "vercel", "vercel": {"production_url": "https://x.vercel.app"}}), "r")
    check("a vercel app's commands are run exactly as the lane declares them", "accessibility/lane-url.py" in L.subst(turn["run"], vctx) and vctx["_rewrite"] == [] and vctx["url"] == "https://x.vercel.app")
    over = L.with_overlay(spec, "functional", "mold_v1", ddocs)
    check("the functional lane gains the python tool-call check for a vm_remote app", [c["name"] for c in over["checks"]] == [c["name"] for c in spec["checks"]] + ["tool.python"])
    check("  ...and for no other target", L.with_overlay(spec, "functional", "mold_v1", vdocs) is spec and L.with_overlay(spec, "functional", "mold_v1", {"infrastructure": {"target": "vm"}}) is spec)
    check("  ...and no other lane", all(L.with_overlay(L.read_spec(l, "mold_v1"), l, "mold_v1", ddocs) == L.read_spec(l, "mold_v1") for l in ("context", "load", "accessibility", "responsiveness")))
    tp = next(c for c in over["checks"] if c["name"] == "tool.python")
    c = L.subst(tp["run"], ctx)
    check("  ...it runs as a signed-in person against the vm_remote URL", "session.py vm_remote_fixture --" in c and "tool-python.py" in c and "lane_url.py vm_remote_fixture" in c and len(tp["requires"]) == 2, c)
    res = L.run_check({"name": "x", "run": "true", "app_env": ["DATABASE_URL"]}, ddocs, ctx)
    check("a check that must connect as the application is skipped for a vm_remote app, with the reason", res["status"] == "skipped" and "never leaves it" in res["reason"], res)
    spec_tp = importlib.util.spec_from_file_location("tool_python", os.path.join(SCRIPTS, "lane-overlays/vm_remote/tool-python.py"))
    T = importlib.util.module_from_spec(spec_tp); spec_tp.loader.exec_module(T)
    check("the tool-call prompt holds the expression and never its answer", str(T.A * T.B) not in T.PROMPT and f"{T.A}*{T.B}" in T.PROMPT and T.WANT == f"SF-TOOL {T.A * T.B}")
    ok_events = [{"type": "session.started"}, {"type": "actions.requested"},
                 {"type": "action.result", "data": {"result": {"callId": "c1", "kind": "tool-result", "toolName": "bash", "output": f"{T.WANT}\nuid 1001 kernel 6.12.68\n", "isError": False}, "status": "completed"}},
                 {"type": "message.completed", "data": {"message": T.WANT}}, {"type": "turn.completed"}]
    ok, why, seen = T.judge(ok_events)
    check("a tool result carrying the computed line passes", ok and "uid 1001" in why and "bash" in why, why)
    ok, why, _ = T.judge([{"type": "message.completed", "data": {"message": f"The answer is {T.A * T.B}"}}, {"type": "turn.completed"}])
    check("an answer with the number but no tool call FAILS (the model worked it out itself)", not ok and "called no tool" in why, why)
    spike = {"type": "action.result", "data": {"error": {"code": "ACTION_RESULT_FAILED", "message": "Sandbox template is not provisioned for backend \"microsandbox\"."},
             "result": {"toolName": "bash", "output": "Sandbox template is not provisioned", "isError": True}, "status": "failed"}}
    ok, why, _ = T.judge([spike, {"type": "message.completed", "data": {"message": "I could not run it"}}, {"type": "turn.completed"}])
    check("the spike's own failure (a template that was never prewarmed) fails with its message", not ok and "not provisioned" in why, why)
    ok, why, _ = T.judge([{"type": "action.result", "data": {"result": {"toolName": "bash", "output": f"{T.WANT}\n", "isError": True}, "status": "failed"}}, {"type": "turn.completed"}])
    check("a failed tool result does not pass even if it echoes the line", not ok)
    ok, why, _ = T.judge([{"type": "subagent.event", "data": {"event": ok_events[2]}}, {"type": "session.waiting"}])
    check("a tool result inside a subagent event counts", ok, why)
    check("a stream that never ends, and a failed turn, both fail", not T.judge(ok_events[:3])[0] and not T.judge([{"type": "turn.failed", "data": {"error": "x"}}])[0])

# ---- brief -> state -> check -> dry run, in a temp copy of the factory ----------------------------------------
def _brief_to_plan(check, tmp):
    T = os.path.join(tmp, "factory"); os.makedirs(os.path.join(T, ".claude"))
    shutil.copytree(SCRIPTS, os.path.join(T, ".claude", "scripts"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(ROOT, "state"), os.path.join(T, "state"))
    for d in ("packs", "molds"): os.symlink(os.path.join(ROOT, d), os.path.join(T, d))
    os.makedirs(os.path.join(T, "briefs"))
    open(os.path.join(T, "briefs", "acme_remote.md"), "w").write(
        "Delivered for Acme's research team, on the customer's own server.\nFresh database. Product: delivered.\n"
        "Workspace: Acme. Operator: you@acme.example. Members: a@acme.example.\nNo browser subagent. Keep web search on.\n")
    py = lambda *a: subprocess.run([sys.executable, *a], cwd=T, capture_output=True, text=True)
    r = py(".claude/scripts/intake.py", "briefs/acme_remote.md", "--app", "acme_remote")
    check("a brief that says \"the customer's own server\" becomes a valid vm_remote application", r.returncode == 0 and "target=vm_remote" in r.stdout and r.stdout.splitlines()[0] == "ok", r.stdout + r.stderr)
    if r.returncode: return
    infra = load(os.path.join(T, "state/application/acme_remote/infrastructure.json"))
    check("  ...with no server address invented and every default filled", "host" not in infra["vm_remote"] and infra["vm_remote"]["install_path"] == "/opt/software-factory/acme_remote" and infra["secret_store"] == "vm_remote_env_file")
    r = py(".claude/scripts/provision.py", "acme_remote")
    check("its check runs offline and asks for the server and the domain", r.returncode == 1 and "--set-remote host=<address> domain=<name>" in r.stdout and "nothing was contacted" in r.stdout, r.stdout[-500:] + r.stderr)
    r = py(".claude/scripts/provision.py", "acme_remote", "--set-remote", "host=203.0.113.44", "domain=research.acme.example")
    check("the operator's two values are recorded", r.returncode == 0 and "recorded host, domain" in r.stdout, r.stdout + r.stderr)
    r = py(".claude/scripts/provision.py", "acme_remote", "--deploy-remote", "--dry-run")
    check("and the dry run prints the complete plan for that server", r.returncode == 0 and "[18 health-public]" in r.stdout and "root@203.0.113.44" in r.stdout and "research.acme.example {" in r.stdout
          and r.stdout.rstrip().endswith("nothing was run and nothing was contacted."), r.stdout[-300:] + r.stderr)
    r = py(".claude/scripts/factory.py", "validate")
    check("the factory still validates with that application in it", r.returncode == 0 and r.stdout.strip() == "ok", r.stdout[-400:])
    r = py(".claude/scripts/lanes.py", "acme_remote", "--list")
    check("its lanes list 27 functional checks (the 26 plus tool.python) and point at --deploy-remote", r.returncode == 0 and "--deploy-remote" in r.stdout
          and any(l.split()[:3] == ["functional", "yes", "27"] for l in r.stdout.splitlines()), r.stdout + r.stderr)

if __name__ == "__main__": sys.exit(run())
