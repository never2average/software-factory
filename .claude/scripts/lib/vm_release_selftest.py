#!/usr/bin/env python3
"""More of the vm_remote self-test (run by vm_remote_selftest.run, inside its Offline guard): mold_v1-222, a deploy that
cannot take the site down.

  rehearsal  the bundle is checked on this machine before any server step: the real rehearsal on the fixture's bundle
             passes and leaves it byte-identical; a bundle missing a helper, naming a script it lacks, with a shell
             script that does not parse, a .mjs that does not check or an import inside a function that resolves
             nowhere is refused with a sentence; and a deploy whose rehearsal fails contacts nothing
  release    the generated release.sh itself, run against stand-in `systemctl`, `curl`, `systemd-run`, `install` ...
             in a temp directory standing in for the server: a switch that works keeps the previous release; a failed
             start or a failed health answer switches back by itself; a rollback goes back and, run again, forward; a
             server deployed before releases is adopted and moved over with nothing stopped; the disk is checked; the
             prewarm runs before the switch and a failed one switches nothing; old releases and their template
             snapshots are removed, never the current or the previous one
  factory    deploy() against recorded answers: what it says and runs when the switch switched back, when the health
             check after it fails, when the prewarm or the build fails; --rollback-remote

NOTHING HERE TOUCHES A SERVER OR CHANGES THIS MACHINE: every path the scripts touch is under a temp directory, the
commands that would change a machine are stand-ins, and the real python3, bash, node, flock, timeout, ln and mv only
ever act on that temp directory.
"""
import hashlib, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
import vm_remote as V
import vm_remote_selftest as B

CP = subprocess.CompletedProcess
TOOL = os.path.join(HERE, "vm_remote.py")
A_, B_, C_, D_ = "20261008T090000Z", "20261009T090000Z", "20261010T090000Z", "20261010T120000Z"

def digest(d):
    h = hashlib.sha256()
    for r, dirs, fs in sorted(os.walk(d)):
        dirs.sort()
        for f in sorted(fs): h.update(os.path.relpath(os.path.join(r, f), d).encode()); h.update(open(os.path.join(r, f), "rb").read())
    return h.hexdigest()

def run(check, tmp):
    rehearsal(check, tmp)
    release(check, tmp)
    factory(check, tmp)

# ---- the rehearsal --------------------------------------------------------------------------------------------------
def rehearsal(check, tmp):
    S = B._settings(); crons = V.read_crons(B.MOLD)
    good = os.path.join(tmp, "rehearse-good"); V.write_bundle(S, crons, good); before = digest(good)
    said = []
    bad = V.rehearsal(S, crons, good, say=said.append)
    check("rehearsal: the fixture's real bundle passes: every .py imported and run with --help from the bundle alone, the server-side self-tests, bash -n, node --check",
          bad == [] and said and "rehearsed:" in said[-1], bad[:5])
    check("rehearsal:   ...and it changed nothing in the bundle it checked (it works on a copy: no __pycache__, no file written)", digest(good) == before
          and not [r for r, ds, _ in os.walk(good) if "__pycache__" in ds])
    lines = "\n".join(V.rehearsal_lines())
    check("rehearsal:   ...it isolates Python from this machine (-I) and says which imports are the factory's own",
          "python3 -I -B" in lines and all(m in lines for m in V.REHEARSAL_FACTORY_SIDE) and "provision.py" in lines)

    def broken(name, hurt, self_tests=False):
        d = os.path.join(tmp, f"rehearse-{name}"); V.write_bundle(S, crons, d); hurt(d)
        return V.rehearsal(S, crons, d, self_tests=self_tests, say=lambda *_: None)
    lib = lambda d, f: os.path.join(d, ".claude", "scripts", "lib", f)
    out = broken("no-legacy", lambda d: os.remove(lib(d, "legacy.py")))
    check("rehearsal: a bundle missing a helper (lib/legacy.py, the 2026-10-09 outage) is refused, naming it",
          any("imports legacy" in x and "not in the bundle" in x for x in out) and any("vm_remote.py: import failed" in x and "legacy" in x for x in out), out)
    out = broken("no-cron-call", lambda d: os.remove(os.path.join(d, "cron-call.sh")))
    check("rehearsal: a unit naming a factory script the bundle lacks is refused, naming the unit and the path",
          any("cron-call.sh, which is not in the bundle" in x and x.startswith("units/") for x in out), out)
    out = broken("bad-shell", lambda d: open(os.path.join(d, "build.sh"), "a").write("\nif then fi\n"))
    check("rehearsal: a shell script that does not parse is refused (bash -n)", any(x.startswith("build.sh: bash -n failed") for x in out), out)
    if shutil.which("node"):
        out = broken("bad-mjs", lambda d: open(lib(d, "rls-cover.mjs"), "w").write("const = ;\n"))
        check("rehearsal: a .mjs that does not check is refused (node --check)", any("rls-cover.mjs: node --check failed" in x for x in out), out)
    def lazy(d):
        p = lib(d, "vm_capacity.py"); open(p, "a").write("\n\ndef _later():\n    import sf_helper_that_was_never_copied\n")
    out = broken("lazy-import", lazy)
    check("rehearsal: an import inside a function, which only fails when the server reaches it, is found too", any("imports sf_helper_that_was_never_copied" in x for x in out), out)
    out = broken("no-tool", lambda d: os.remove(lib(d, "vm_remote.py")))
    check("rehearsal: a bundle without the server's own tool is refused: the remote commands name it", any("vm_remote.py, which is not in the bundle" in x for x in out), out[:3])
    # The deploy runs it before anything else: a failed rehearsal contacts nothing and changes nothing.
    log, started = [], []
    def runner(st, stdin=None): log.append(st["id"]); return CP([], 0, "ok", "")
    def hurt_then_rehearse(S_, crons_, d, **k):
        os.remove(lib(d, "legacy.py")); return V.rehearsal(S_, crons_, d, self_tests=False, **k)
    try: V.deploy(S, B.MOLD, crons, runner=runner, resolver=lambda d: ["203.0.113.10"], say=lambda *_: None, bundle_dir=os.path.join(tmp, "deploy-rehearse"),
                  on_started=lambda: started.append(1), rehearse=hurt_then_rehearse); res = None
    except V.Stop as e: res = e
    check("rehearsal: a deploy whose bundle fails the rehearsal stops before the first server step: nothing run, the server not contacted, the status not touched",
          isinstance(res, V.Stop) and log == [] and started == [] and "nothing was sent" in str(res) and "legacy" in str(res), (str(res)[:300], log))

# ---- release.sh against stand-ins -----------------------------------------------------------------------------------
SHIMS = {
"systemctl": r'''case "$1" in is-active) grep -qxF "${@: -1}" "$d/active" 2>/dev/null; exit $? ;; esac
echo "systemctl $*" >> "$d/calls"
case "$1" in
  restart)
    cur="$(basename "$(readlink -f "$d/root/opt/software-factory/vm_remote_fixture/current")")"
    case "$2" in *-api.service)
      if grep -qxF "$cur" "$d/fail-start" 2>/dev/null; then echo "prestart failed for $cur" >&2; exit 1; fi
      if grep -qxF "$cur" "$d/hang-start" 2>/dev/null; then sleep 30; fi ;;
    esac
    echo "$2 $cur" >> "$d/started" ;;
esac
exit 0''',
"curl": r'''cur="$(basename "$(readlink -f "$d/root/opt/software-factory/vm_remote_fixture/current")")"
echo "curl ${@: -1} ($cur)" >> "$d/curls"
if grep -qxF "$cur" "$d/sick" 2>/dev/null; then case "${@: -1}" in *:3000/*) printf 502; exit 0 ;; esac; fi
printf 200''',
"journalctl": '''echo "(the unit's last lines)"''',
"systemd-run": r'''echo "systemd-run $*" >> "$d/calls"; out=""
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in -p) case "$2" in StandardOutput=append:*) out="${2#StandardOutput=append:}" ;; esac; shift ;; --setenv=*) export "${1#--setenv=}" ;; esac
  shift
done
shift
# the mold's `sandbox:prewarm --plan` (release.sh keep): the fixture's plan for the release in WorkingDirectory, if any
case "$*" in *--plan*) w="$(grep -o 'WorkingDirectory=[^ ]*' "$d/calls" | tail -n 1)"; w="${w#WorkingDirectory=}"; f="$d/plan-$(basename "$w").json"
  [ -f "$f" ] && { cat "$f"; exit 0; }; exit 1 ;; esac
if [ -n "$out" ]; then "$@" >> "$out" 2>&1; else "$@"; fi''',
"runuser": r'''echo "runuser $*" >> "$d/calls"; while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; exec "$@"''',
"install": r'''a=()
while [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) a+=("$1") ;; esac; shift; done
exec /usr/bin/install "${a[@]}"''',
"chown": '''echo "chown $*" >> "$d/calls"''',
}

class Server:
    """A temp directory standing in for the app's server: releases under root/opt/..., stand-in commands on PATH."""
    def __init__(self, tmp, name, S, crons, releases=(), current=None, previous=None, legacy=False, **gen):
        self.d = os.path.join(tmp, name); self.root = os.path.join(self.d, "root"); self.S = S
        os.makedirs(os.path.join(self.d, "bin")); os.makedirs(self.root)
        for n, body in SHIMS.items():
            p = os.path.join(self.d, "bin", n); open(p, "w").write(f"#!/bin/bash\nd={self.d}\n{body}\n"); os.chmod(p, 0o755)
        for f in ("calls", "started", "curls"): open(os.path.join(self.d, f), "w").close()
        self.I = self.root + S["install"]; self.F = self.root + S["factory_dir"]
        os.makedirs(os.path.join(self.F, "units")); os.makedirs(os.path.join(self.root, "etc/systemd/system"))
        for name_, text in V.unit_files(S, crons).items(): open(os.path.join(self.F, "units", name_), "w").write(text)
        # a stand-in for the API's prestart: it fails when told to, else marks the release prewarmed as the real one does
        open(os.path.join(self.F, "api-prestart.sh"), "w").write(
            f'#!/bin/bash\nset -eu\ncd "$1"\nif [ -e {self.d}/prewarm-hangs ]; then echo "template eve-sbx-tpl-x timed out after 600s" >&2; exit 1; fi\n'
            f'echo "6 sandbox template(s) ready"\ntouch "{self.root}{S["marks"]}/$(basename "$(pwd -P)")"\n')
        os.makedirs(self.root + S["data"] + "/build-stamps"); open(self.root + S["data"] + "/build-stamps/app.lock", "w").write("legacy-lock\n")
        os.makedirs(self.root + V.SERVICE_HOME + "/.microsandbox/bin")
        for r in releases: self.build(r)
        if legacy: self.build(V.LEGACY_RELEASE)
        if current: self.point("current", current)
        if previous: self.point("previous", previous)
        self.script = V.release_sh(S, crons, root=self.root, tool=TOOL, timing={"start": {"workflow": 5, "api": 5, "web": 5}, "health": 1, "step": 0.2}, **gen)
    def rdir(self, n): return os.path.join(self.I, "app") if n == V.LEGACY_RELEASE else os.path.join(self.I, "releases", n)
    def build(self, n, journal=("0001_init",)):
        r = self.rdir(n)
        for f in (".output/server/index.mjs", ".next/BUILD_ID", "services/task-workflow/.next/BUILD_ID", "node_modules/microsandbox/package.json",
                  "node_modules/@superradcompany/microsandbox-linux-x64-gnu/bin/msb", "node_modules/@superradcompany/microsandbox-linux-x64-gnu/lib/libkrunfw.so.5",
                  "services/task-workflow/node_modules/x.js", ".sf-stamps/app.lock"):
            os.makedirs(os.path.dirname(os.path.join(r, f)), exist_ok=True); open(os.path.join(r, f), "w").write('  "version": "0.5.10",\n' if f.endswith("package.json") else n)
        os.makedirs(os.path.join(r, "drizzle/meta"), exist_ok=True)
        json.dump({"entries": [{"tag": t} for t in journal]}, open(os.path.join(r, "drizzle/meta/_journal.json"), "w"))
    def point(self, which, n):
        p = os.path.join(self.I, which)
        if os.path.lexists(p): os.unlink(p)
        os.symlink(V.LEGACY_RELEASE if n == V.LEGACY_RELEASE else f"releases/{n}", p)
    def at(self, which):
        p = os.path.join(self.I, which)
        return os.path.basename(os.readlink(p)) if os.path.islink(p) else None
    def put(self, f, *lines): open(os.path.join(self.d, f), "w").write("".join(l + "\n" for l in lines))
    def lines(self, f): return [l for l in open(os.path.join(self.d, f)).read().split("\n") if l]
    def run(self, *args, guard=True):
        sp = os.path.join(self.d, "release.sh"); open(sp, "w").write(self.script)
        env = {"PATH": os.path.join(self.d, "bin") + ":/usr/local/bin:/usr/bin:/bin", "HOME": self.d, "LANG": "C.UTF-8"}
        if guard: env[V.GUARD_VAR] = "vm_remote_fixture"
        r = subprocess.run(["bash", sp, *args], env=env, capture_output=True, text=True, timeout=120)
        return r, V.parse_kv(r.stdout)

def release(check, tmp):
    S = B._settings(); crons = V.read_crons(B.MOLD); svc, tim = V.unit_names(S, crons)
    wf, api, web = (f"{S['unit']}-{k}.service" for k in ("workflow", "api", "web"))
    script = V.release_sh(S, crons)
    check("release.sh: it refuses to run anywhere but the app's own server, and is valid shell",
          [l for l in script.splitlines() if l.strip() and not l.startswith("#")][1].startswith('[ "${SF_REMOTE_DEPLOY:-}" = "vm_remote_fixture" ]')
          and subprocess.run(["bash", "-n"], input=script, capture_output=True, text=True).returncode == 0)
    check("release.sh: it never deletes a release itself (the removal is the Python tool's, with its path checks), and every unit runs from `current`",
          "rm -rf" not in script and "rm -r " not in script and all(f"WorkingDirectory={S['app_dir']}" in t for k, t in V.unit_files(S, crons).items() if k in (api, web))
          and f"WorkingDirectory={S['app_dir']}/services/task-workflow" in V.unit_files(S, crons)[wf])

    pg, pk = V.postgres_sh(S), V.packages_sh(S)
    check("before the switch nothing restarts what serves: PostgreSQL only when its settings changed, and no installed package is upgraded mid-deploy",
          'if [ "$(pg_conf)" != "$before" ] || ! systemctl is-active --quiet postgresql; then' in pg and pg.count("systemctl restart postgresql") == 1
          and pg.index('before="$(pg_conf)"') < pg.index("software-factory.conf <<") and "apt-get install -y -q --no-upgrade ca-certificates" in pk, pg[-600:])

    # ---- a switch that works
    sv = Server(tmp, "rel-ok", S, crons, releases=(A_, B_), current=A_)
    r, kv = sv.run("switch", B_)
    st = sv.lines("started")
    check("switch: a release that starts and answers is switched in, and the one that served is kept as the previous one",
          r.returncode == 0 and kv.get("SWITCHED") == B_ and kv.get("PREVIOUS") == A_ and sv.at("current") == B_ and sv.at("previous") == A_, (r.returncode, r.stdout[-400:], r.stderr[-400:]))
    check("switch:   ...the three services restart in order, each on the new release", st == [f"{wf} {B_}", f"{api} {B_}", f"{web} {B_}"], st)
    c = sv.lines("calls")
    check("switch:   ...the units are installed first, the file store's view is started (never restarted), the timers turned on after",
          os.path.isfile(os.path.join(sv.root, "etc/systemd/system", api)) and "systemctl daemon-reload" in c and f"systemctl start {S['unit']}-storage.service" in c
          and f"systemctl restart {S['unit']}-storage.service" not in c and c.index("systemctl daemon-reload") < c.index(f"systemctl restart {wf}")
          and any(l.startswith("systemctl enable --now") and tim[0] in l for l in c[c.index(f"systemctl restart {web}"):]), c)
    check("switch:   ...and it waited for the three loopback health answers", kv.get("HEALTH", "").startswith("ok") and any(":3001/eve/v1/health" in l for l in sv.lines("curls")))
    check("switch:   ...`current` and `previous` are relative links: the real path of a release is its own directory",
          os.readlink(os.path.join(sv.I, "current")) == f"releases/{B_}" and os.path.realpath(os.path.join(sv.I, "current")) == sv.rdir(B_))

    # ---- a failed start (the API's prestart) switches back
    sv = Server(tmp, "rel-fail-start", S, crons, releases=(A_, B_, C_), current=B_, previous=A_)
    sv.put("fail-start", C_)
    r, kv = sv.run("switch", C_)
    st = sv.lines("started")
    check("switch: a release whose API does not start is switched back, by the server itself, to the release that was serving",
          r.returncode == 10 and kv.get("ROLLED_BACK") == B_ and sv.at("current") == B_, (r.returncode, r.stdout[-300:], r.stderr[-300:]))
    check("switch:   ...the previous release is what it was before (the failed one is never a fallback), and the old release was restarted and answered",
          sv.at("previous") == A_ and st == [f"{wf} {C_}", f"{wf} {B_}", f"{api} {B_}", f"{web} {B_}"] and kv.get("HEALTH", "").startswith("ok"), (sv.at("previous"), st))
    check("switch:   ...and it says why, with the unit's last lines", "did not start (exit 1)" in r.stderr and "did not come up healthy" in r.stderr, r.stderr[-300:])

    # ---- the 2026-10-09 outage: a prestart that hangs (a template rebuild) is cut at its deadline and switched back
    sv = Server(tmp, "rel-hang", S, crons, releases=(A_, B_), current=A_)
    sv.put("hang-start", B_)
    r, kv = sv.run("switch", B_)
    check("switch: an API start that hangs (2026-10-09: a template rebuild, 600 s in prestart) is cut at its deadline and the server switches back",
          r.returncode == 10 and kv.get("ROLLED_BACK") == A_ and sv.at("current") == A_ and "did not start within its 5s" in r.stderr
          and sv.lines("started")[-3:] == [f"{wf} {A_}", f"{api} {A_}", f"{web} {A_}"], (r.returncode, r.stderr[-300:], sv.lines("started")))

    # ---- a failed health answer switches back
    sv = Server(tmp, "rel-sick", S, crons, releases=(A_, B_), current=A_)
    sv.put("sick", B_)
    r, kv = sv.run("switch", B_)
    check("switch: a release that starts but whose web app answers 502 is switched back too", r.returncode == 10 and kv.get("ROLLED_BACK") == A_ and sv.at("current") == A_
          and sv.at("previous") is None and "HEALTH=failed" in r.stdout and "web=502" in r.stdout, (r.returncode, r.stdout[-300:]))

    # ---- the first release on a fresh server has nothing to go back to
    sv = Server(tmp, "rel-first", S, crons, releases=(A_,))
    sv.put("sick", A_)
    r, kv = sv.run("switch", A_)
    check("switch: on a server's first release a failure is reported as such (there is nothing to switch back to)", r.returncode == 9 and kv.get("SWITCH_BACK") == "none", (r.returncode, r.stdout[-200:]))
    r, kv = sv.run("switch", "20261010T1200")
    check("switch: a malformed release id is refused before anything is touched", r.returncode == 2 and "not a release id" in r.stderr)
    sv2 = Server(tmp, "rel-unbuilt", S, crons, releases=(A_,), current=A_)
    os.makedirs(sv2.rdir(B_))
    r, kv = sv2.run("switch", B_)
    check("switch: a release that is not a complete build is refused, and nothing is switched", r.returncode == 8 and sv2.at("current") == A_ and sv2.lines("started") == [])
    r, kv = sv2.run("switch", B_, guard=False)
    check("release.sh: without the deploy's marker it refuses, changing nothing", r.returncode == 3 and sv2.at("current") == A_)

    # ---- rollback by hand, and forward again
    sv = Server(tmp, "rel-rollback", S, crons, releases=(A_, B_), current=B_, previous=A_)
    sv.build(B_, journal=("0001_init", "0002_more"))
    r, kv = sv.run("rollback")
    check("rollback: it goes back to the previous release and restarts it; the two links swap", r.returncode == 0 and kv.get("ROLLED_BACK") == A_ and kv.get("PREVIOUS") == B_
          and sv.at("current") == A_ and sv.at("previous") == B_ and sv.lines("started")[-1] == f"{web} {A_}", (r.returncode, r.stdout[-300:], r.stderr[-300:]))
    check("rollback:   ...and names the migrations the database keeps that the release it went back to was built before", kv.get("NEWER_MIGRATIONS") == "0002_more", kv)
    r, kv = sv.run("rollback")
    check("rollback:   ...run again, it goes forward", r.returncode == 0 and kv.get("ROLLED_BACK") == B_ and sv.at("current") == B_ and sv.at("previous") == A_)
    sv.put("sick", A_)
    r, kv = sv.run("rollback")
    check("rollback: when the release it goes back to does not come up, it puts the serving one back", r.returncode == 14 and kv.get("ROLLBACK_UNDONE") == B_ and sv.at("current") == B_ and sv.at("previous") == A_,
          (r.returncode, r.stdout[-300:]))
    sv = Server(tmp, "rel-rollback-none", S, crons, releases=(A_,), current=A_)
    r, kv = sv.run("rollback")
    check("rollback: with no earlier release it says so and changes nothing", r.returncode == 13 and "no earlier release" in r.stderr and sv.at("current") == A_ and sv.lines("started") == [])

    # ---- detached: the switch runs as its own unit, and its log comes back
    sv = Server(tmp, "rel-detach", S, crons, releases=(A_, B_), current=A_)
    r, kv = sv.run("detach", "switch", B_)
    c = sv.lines("calls")
    check("detach: the switch runs as a transient unit (systemd-run --wait) whose log is printed and whose exit code is the step's",
          r.returncode == 0 and kv.get("SWITCHED") == B_ and any(l.startswith(f"systemd-run --quiet --wait --collect --unit {S['unit']}-release-switch") for l in c)
          and os.listdir(sv.root + S["release_log"]), (r.returncode, r.stdout[-300:], c[:3]))
    sv.put("sick", A_)
    r, kv = sv.run("detach", "rollback")
    check("detach:   ...a failed rollback's exit code reaches the factory too", r.returncode == 14 and kv.get("ROLLBACK_UNDONE") == B_, (r.returncode, r.stdout[-200:]))

    # ---- prewarm: before the switch, and a hung template switches nothing
    sv = Server(tmp, "rel-prewarm", S, crons, releases=(A_, B_), current=A_)
    r, kv = sv.run("prewarm", B_)
    c = sv.lines("calls"); sr = next((l for l in c if l.startswith("systemd-run")), "")
    check("prewarm: the new release's templates are built as the API's user, with its env file and settings, bounded in time, while the old release serves",
          r.returncode == 0 and kv.get("PREWARMED") == B_ and os.path.exists(sv.root + S["marks"] + "/" + B_) and sv.at("current") == A_ and sv.lines("started") == []
          and all(x in sr for x in (f"User={V.SERVICE_USER}", "SupplementaryGroups=kvm", f"EnvironmentFile={S['env_files']['api']}", f"RuntimeMaxSec={V.PREWARM_DEADLINE_S}",
                                    f"HOME={sv.root}{V.SERVICE_HOME}", "ProtectHome=yes", f"api-prestart.sh {sv.rdir(B_)}")), (r.stdout[-300:], sr))
    check("prewarm:   ...at a low CPU weight, so the chats' VMs keep the CPUs they use while a template builds beside them (mold_v1-224)",
          f"CPUWeight={V.PREWARM_CPU_WEIGHT}" in sr and V.PREWARM_CPU_WEIGHT < 100, sr)
    check("prewarm:   ...with the serving API stopped, the serving release is not marked (only a running API proves its prewarm)", not os.path.exists(sv.root + S["marks"] + "/" + A_))
    sv.put("active", api)
    r, kv = sv.run("prewarm", B_)
    check("prewarm:   ...with it running, the serving release is marked too, so a switch back to it is as quick as the switch", r.returncode == 0 and os.path.exists(sv.root + S["marks"] + "/" + A_))
    open(os.path.join(sv.d, "prewarm-hangs"), "w").close()
    r, kv = sv.run("prewarm", B_)
    check("prewarm: a template that hangs fails the step with the mold's own words; nothing is switched or restarted",
          r.returncode == 12 and "timed out after 600s" in r.stdout and "Nothing was switched" in r.stderr and sv.at("current") == A_ and sv.lines("started") == []
          and not os.path.exists(sv.root + S["marks"] + "/" + B_), (r.returncode, r.stderr[-300:]))
    os.remove(os.path.join(sv.d, "prewarm-hangs"))
    open(os.path.join(sv.rdir(B_), "node_modules/microsandbox/package.json"), "w").write('  "version": "0.6.0",\n')
    r, kv = sv.run("prewarm", B_)
    check("prewarm: when the sandbox runtime itself changed, the mark is withdrawn so the switch prewarms again with the new one",
          r.returncode == 0 and "RUNTIME" in kv and not os.path.exists(sv.root + S["marks"] + "/" + B_), r.stdout[-300:])

    # ---- a server deployed before releases: adopted, then moved over with nothing stopped
    sv = Server(tmp, "rel-legacy", S, crons, legacy=True)
    store = sv.root + V.SERVICE_HOME + "/.microsandbox"
    os.symlink(sv.rdir(V.LEGACY_RELEASE) + "/node_modules/@superradcompany/microsandbox-linux-x64-gnu/bin/msb", store + "/bin/msb")
    r, kv = sv.run("prepare", B_)
    check("legacy: `prepare` adopts the single directory as the release `current` leads to, moving nothing and stopping nothing",
          r.returncode == 0 and kv.get("RELEASE") == B_ and sv.at("current") == V.LEGACY_RELEASE and os.path.isdir(sv.rdir(V.LEGACY_RELEASE)) and not os.path.islink(sv.rdir(V.LEGACY_RELEASE))
          and not [l for l in sv.lines("calls") if l.startswith(("systemctl", "systemd-run"))], (r.returncode, r.stdout[-300:], r.stderr[-300:]))
    check("legacy:   ...the new release gets the serving node_modules and the stamps that say which lock file made them",
          os.path.isfile(sv.rdir(B_) + "/node_modules/microsandbox/package.json") and os.path.isfile(sv.rdir(B_) + "/services/task-workflow/node_modules/x.js")
          and open(sv.rdir(B_) + "/.sf-stamps/app.lock").read() == "legacy-lock\n")
    sv.build(B_); sv.run("prewarm", B_)
    r, kv = sv.run("switch", B_)
    check("legacy: the first switch moves it to the release; the old directory is the previous one, ready to go back to",
          r.returncode == 0 and sv.at("current") == B_ and sv.at("previous") == V.LEGACY_RELEASE, (r.returncode, r.stderr[-300:]))
    check("legacy:   ...the sandbox runtime's links now go through `current`, so they follow the serving release and never dangle",
          os.readlink(store + "/bin/msb") == sv.I + "/current/node_modules/@superradcompany/microsandbox-linux-x64-gnu/bin/msb"
          and os.path.islink(store + "/lib/libkrunfw.so.5"), os.readlink(store + "/bin/msb"))
    r, kv = sv.run("keep")
    check("legacy: `keep` leaves the old directory while it is the previous release", r.returncode == 0 and os.path.isdir(sv.rdir(V.LEGACY_RELEASE)) and not os.path.islink(sv.rdir(V.LEGACY_RELEASE)))
    sv.run("prepare", C_); sv.build(C_); sv.run("prewarm", C_)
    r, kv = sv.run("switch", C_)
    r2, kv2 = sv.run("keep")
    check("legacy: two releases later it is removed like any other, and becomes a link to `current` for anything that still names it",
          r.returncode == 0 and r2.returncode == 0 and sv.at("current") == C_ and sv.at("previous") == B_ and os.path.islink(sv.rdir(V.LEGACY_RELEASE))
          and os.readlink(sv.rdir(V.LEGACY_RELEASE)) == "current" and os.path.isdir(sv.rdir(B_)), (r2.stdout[-300:], r2.stderr[-200:]))
    check("legacy:   ...and the server-side commands that name <install>/current find the old directory on a server not moved yet",
          V._served(sv.I + "/nowhere/current") == sv.I + "/nowhere/current" and _served_legacy(tmp))

    # ---- keep: the last two releases, never current or previous
    sv = Server(tmp, "rel-keep", S, crons, releases=(A_, B_, C_, D_), current=C_, previous=A_)
    r, kv = sv.run("keep")
    check("keep: every release but current and previous is removed, whatever its age", r.returncode == 0 and sorted(os.listdir(os.path.join(sv.I, "releases"))) == sorted([A_, C_]), os.listdir(os.path.join(sv.I, "releases")))
    rels = os.path.join(sv.I, "releases"); os.makedirs(os.path.join(rels, "not-a-release")); os.symlink(sv.rdir(A_), os.path.join(rels, "20261001T000000Z"))
    r, kv = sv.run("keep")
    check("keep:   ...and nothing that is not a release (a stray directory, a link) is ever touched", os.path.isdir(os.path.join(rels, "not-a-release")) and os.path.islink(os.path.join(rels, "20261001T000000Z"))
          and os.path.isdir(sv.rdir(A_)))

    # ---- prepare: the disk
    sv = Server(tmp, "rel-disk", S, crons, releases=(A_,), current=A_, extra_gb=10 ** 7)
    r, kv = sv.run("prepare", B_)
    check("prepare: with too little free disk for a second copy it refuses in plain words, and makes nothing", r.returncode == 7 and "refusing: the server has" in r.stdout
          and "keeps serving" in r.stdout and not os.path.exists(sv.rdir(B_)), (r.returncode, r.stdout[-300:]))
    sv = Server(tmp, "rel-again", S, crons, releases=(A_,), current=A_)
    r, kv = sv.run("prepare", A_)
    check("prepare: the serving release's own id is refused (each deploy makes its own); the serving release is untouched", r.returncode == 8 and sv.at("current") == A_ and os.path.isfile(sv.rdir(A_) + "/.output/server/index.mjs"))

    # ---- the template snapshots of removed releases
    inst = os.path.join(tmp, "prune-snaps", "opt", "app"); home = os.path.join(tmp, "prune-snaps", "home")
    os.makedirs(os.path.join(home, ".microsandbox", "bin")); open(os.path.join(home, ".microsandbox", "bin", "msb"), "w").close()
    def rel(n, snaps):
        for i, s_ in enumerate(snaps):
            d = os.path.join(inst, "releases", n, ".eve/sandbox-cache/microsandbox/templates", f"eve-sbx-tpl-microsandbox-x-{i}")
            os.makedirs(d); json.dump({"optionsHash": "h", "snapshotName": s_, "version": 2}, open(os.path.join(d, "metadata.json"), "w"))
        os.makedirs(os.path.join(inst, "releases", n), exist_ok=True)
    rel(A_, ["eve-sbx-tpl-aaa", "eve-sbx-tpl-shared"]); rel(B_, ["eve-sbx-tpl-bbb"]); rel(C_, ["eve-sbx-tpl-ccc"])
    os.symlink(f"releases/{C_}", os.path.join(inst, "current")); os.symlink(f"releases/{B_}", os.path.join(inst, "previous"))
    asked, said = [], []
    rc = V.release_prune(inst, home, msb=lambda a: (asked.append(a), CP(a, 0, "", ""))[1], say=said.append)
    check("keep: the sandbox template snapshots that only the removed releases used are removed through msb; one a kept release uses is not",
          rc == 0 and asked == [["snapshot", "remove", "eve-sbx-tpl-aaa"], ["snapshot", "remove", "eve-sbx-tpl-shared"]] and not os.path.exists(os.path.join(inst, "releases", A_)), (asked, said))
    rel(D_, ["eve-sbx-tpl-shared"]); os.unlink(os.path.join(inst, "previous")); os.symlink(f"releases/{D_}", os.path.join(inst, "previous")); rel("20261007T000000Z", ["eve-sbx-tpl-shared", "eve-sbx-tpl-old"])
    asked.clear()
    V.release_prune(inst, home, msb=lambda a: (asked.append(a), CP(a, 1, "", "in use"))[1], say=said.append)
    check("keep:   ...shared with a kept release, never; and one msb refuses is left with a sentence, not an error",
          ["snapshot", "remove", "eve-sbx-tpl-shared"] not in asked and ["snapshot", "remove", "eve-sbx-tpl-old"] in asked and any("was left" in x for x in said), (asked, said[-3:]))
    empty = os.path.join(tmp, "prune-none"); os.makedirs(os.path.join(empty, "releases", A_))
    said.clear(); V.release_prune(empty, home, say=said.append)
    check("keep: with no `current` nothing at all is removed", os.path.isdir(os.path.join(empty, "releases", A_)) and "none was removed" in said[-1])

    unused(check, tmp, S, crons)

# ---- mold_v1-224: template snapshots no kept release uses ------------------------------------------------------------
OLD = 1_700_000_000.0          # a snapshot made long ago
def _tpl(i): return "eve-sbx-tpl-" + f"{i:032x}"
def _key(i): return f"eve-sbx-tpl-microsandbox-4c4164b5039c3606-{i:020x}"
def _cache(rdir, mapping):
    """A release's own template cache: key -> the snapshot its metadata names."""
    for k, snap in mapping.items():
        d = os.path.join(rdir, ".eve/sandbox-cache/microsandbox/templates", k); os.makedirs(d, exist_ok=True)
        json.dump({"optionsHash": "ffdd1712e872da6aa9b0", "snapshotName": snap, "version": 2}, open(os.path.join(d, "metadata.json"), "w"))
def _plan(keys, extra_nodes=()):
    return {"eve": "0.25.1", "nodes": [{"node": f"n{i}", "templateKey": k} for i, k in enumerate(keys)] + [{"node": "browser", "templateKey": None}, *extra_nodes]}
def _snap(store, name, when=OLD, kb=64):
    d = os.path.join(store, "snapshots", name); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "upper.ext4"), "wb") as f: f.write(b"x" * kb * 1024)
    for x in (os.path.join(d, "upper.ext4"), d): os.utime(x, (when, when))

def unused(check, tmp, S, crons):
    # the first server, small: previous = the old single directory (its cache also holds records of earlier builds'
    # keys), current = the first release; the store holds every snapshot any build ever made.
    base = os.path.join(tmp, "unused"); inst = os.path.join(base, "opt", "app"); home = os.path.join(base, "home"); store = os.path.join(home, ".microsandbox")
    plans = os.path.join(base, "plans"); os.makedirs(plans); os.makedirs(os.path.join(store, "bin")); open(os.path.join(store, "bin", "msb"), "w").close()
    os.makedirs(os.path.join(inst, "releases", C_)); os.makedirs(os.path.join(inst, "app"))
    os.symlink(f"releases/{C_}", os.path.join(inst, "current")); os.symlink("app", os.path.join(inst, "previous"))
    _cache(os.path.join(inst, "app"), {_key(1): _tpl(1), _key(2): _tpl(2), _key(3): _tpl(3), _key(4): _tpl(4)})   # 3 and 4: earlier builds
    _cache(os.path.join(inst, "releases", C_), {_key(1): _tpl(1), _key(5): _tpl(5)})
    json.dump(_plan([_key(1), _key(2)]), open(os.path.join(plans, "plan-app.json"), "w")); json.dump(_plan([_key(1), _key(5)]), open(os.path.join(plans, f"plan-{C_}.json"), "w"))
    for i in (1, 2, 3, 4, 5, 6): _snap(store, _tpl(i))
    _snap(store, _tpl(7), when=time.time())                            # made minutes ago (a prewarm that is not ours)
    _snap(store, "eve-sbx-state-" + "a" * 32); _snap(store, "eve-sbx-tpl-tmp-" + "b" * 32); _snap(store, "not-eve")
    outside = os.path.join(base, "elsewhere", _tpl(8)); os.makedirs(outside); os.symlink(outside, os.path.join(store, "snapshots", _tpl(8)))
    def msb_rm(fail=()):
        asked = []
        def m(a):
            asked.append(a)
            if a[:2] == ["snapshot", "remove"] and a[2] not in fail: shutil.rmtree(os.path.join(store, "snapshots", a[2]))
            return CP(a, 1 if a[2] in fail else 0, "", "")
        return asked, m
    snaps = lambda: sorted(os.listdir(os.path.join(store, "snapshots")))
    before = snaps(); said = []; asked, m = msb_rm()
    rc = V.release_prune(inst, home, msb=m, say=said.append, plans=plans, procs=lambda: [], dry_run=True)
    check("unused templates: a dry run names each snapshot neither kept release's plan uses, with its size and age, and removes nothing",
          rc == 0 and asked == [] and snaps() == before and sum("would remove template snapshot" in x for x in said) == 3
          and all(any(_tpl(i) in x and "would remove" in x for x in said) for i in (3, 4, 6)) and any("MB, made 2023-11-14" in x for x in said), said)
    said.clear()
    rc = V.release_prune(inst, home, msb=m, say=said.append, plans=plans, procs=lambda: [])
    check("unused templates: keep removes, through msb, the snapshots no kept release uses: older builds' records in a kept cache, and ones nothing names",
          rc == 0 and asked == [["snapshot", "remove", _tpl(i)] for i in (3, 4, 6)] and all(_tpl(i) not in snaps() for i in (3, 4, 6)), (asked, said[-3:]))
    check("unused templates:   ...never one a kept release's plan uses (shared or its own), one made within the hour, a session's state, a build leftover, a stranger, or a link out of the store",
          all(_tpl(i) in snaps() for i in (1, 2, 5, 7)) and "eve-sbx-state-" + "a" * 32 in snaps() and "eve-sbx-tpl-tmp-" + "b" * 32 in snaps() and "not-eve" in snaps()
          and os.path.islink(os.path.join(store, "snapshots", _tpl(8))) and os.path.isdir(outside), snaps())
    check("unused templates:   ...and says what it freed and kept", any("3 of 3 unused removed" in x and "3 template snapshot(s) in use by" in x and "1 newer than 1h kept" in x for x in said)
          and os.path.isdir(os.path.join(inst, "app")) and os.path.isdir(os.path.join(inst, "releases", C_)), said[-3:])
    for i in (3, 4, 6): _snap(store, _tpl(i))
    def none_removed(label, plans_=plans, procs=lambda: [], expect=""):
        said.clear(); asked.clear()
        V.release_prune(inst, home, msb=m, say=said.append, plans=plans_, procs=procs)
        check(f"unused templates: {label}: nothing is removed, with a sentence", asked == [] and all(_tpl(i) in snaps() for i in (3, 4, 6)) and any(expect in x for x in said), said)
    os.rename(os.path.join(plans, "plan-app.json"), os.path.join(plans, "hidden.json"))
    none_removed("a kept release whose plan could not be read (an older mold, a failed plan run)", expect="which sandbox templates release app uses is not known")
    open(os.path.join(plans, "plan-app.json"), "w").write("{not json")
    none_removed("  ...or is not JSON", expect="is not known")
    json.dump(_plan([_key(1), _key(9)]), open(os.path.join(plans, "plan-app.json"), "w"))
    none_removed("a plan key whose template record is missing (which snapshot it needs is not known)", expect="is not known")
    json.dump(_plan(["../../etc"]), open(os.path.join(plans, "plan-app.json"), "w"))
    none_removed("a plan key that is not a template key", expect="is not known")
    json.dump({"nodes": [{"node": "browser", "templateKey": None}]}, open(os.path.join(plans, f"plan-{C_}.json"), "w")); json.dump({"nodes": [{"node": "b", "templateKey": None}]}, open(os.path.join(plans, "plan-app.json"), "w"))
    none_removed("plans that name no template at all (not believed)", expect="not believed")
    json.dump(_plan([_key(1), _key(2)]), open(os.path.join(plans, "plan-app.json"), "w")); json.dump(_plan([_key(1), _key(5)]), open(os.path.join(plans, f"plan-{C_}.json"), "w"))
    none_removed("a sandbox prewarm running", procs=lambda: ["node scripts/sandbox-prewarm-serial.mjs --link-runtime --retries 2"], expect="a sandbox prewarm is running")
    said.clear(); asked.clear()
    V.release_prune(inst, home, msb=m, say=said.append)
    check("unused templates: without plans (prepare, as before) no other snapshot is considered", asked == [] and all(_tpl(i) in snaps() for i in (3, 4, 6)), said)
    said.clear(); asked2, m2 = msb_rm(fail=(_tpl(4),))
    rc = V.release_prune(inst, home, msb=m2, say=said.append, plans=plans, procs=lambda: [])
    check("unused templates: one msb will not remove is left, said, and keep's exit says so", rc == 1 and _tpl(4) in snaps() and _tpl(3) not in snaps() and any(f"{_tpl(4)} was left" in x for x in said), said[-3:])

    # ---- and through release.sh keep itself: the plans asked of each kept release, as the API's user
    sv = Server(tmp, "rel-unused", S, crons, releases=(A_, B_, C_), current=C_, previous=B_)
    sstore = sv.root + V.SERVICE_HOME + "/.microsandbox"
    open(sstore + "/bin/msb", "w").write('#!/bin/bash\necho "msb $*" >> "%s/calls"\n[ "$1 $2" = "snapshot remove" ] && rm -r "$HOME/.microsandbox/snapshots/$3"\nexit 0\n' % sv.d); os.chmod(sstore + "/bin/msb", 0o755)
    for n, keys in ((A_, (3,)), (B_, (1, 2)), (C_, (1, 5))):
        _cache(sv.rdir(n), {_key(i): _tpl(i) for i in keys})
        os.makedirs(sv.rdir(n) + "/scripts", exist_ok=True); open(sv.rdir(n) + "/scripts/sandbox-prewarm-serial.mjs", "w").write('if (has("--plan")) {}\n')
    json.dump(_plan([_key(1), _key(2)]), open(os.path.join(sv.d, f"plan-{B_}.json"), "w")); json.dump(_plan([_key(1), _key(5)]), open(os.path.join(sv.d, f"plan-{C_}.json"), "w"))
    for i in (1, 2, 3, 4, 5): _snap(sstore, _tpl(i))
    r, kv = sv.run("keep")
    c = sv.lines("calls"); plans_run = [l for l in c if l.startswith("systemd-run") and "--plan" in l]
    left = sorted(os.listdir(sstore + "/snapshots"))
    check("keep (release.sh): the old release goes, and so do the snapshots it used and the ones nothing uses; the kept releases' stay",
          r.returncode == 0 and not os.path.exists(sv.rdir(A_)) and left == [_tpl(1), _tpl(2), _tpl(5)], (r.returncode, left, r.stdout[-600:], r.stderr[-300:]))
    check("keep (release.sh):   ...each kept release's plan is the mold's own `--plan`, run in that release as the API's user with its settings, bounded",
          len(plans_run) == 2 and all(x in l for l in plans_run for x in (f"User={V.SERVICE_USER}", f"EnvironmentFile={S['env_files']['api']}", "RuntimeMaxSec=", "ProtectHome=yes", "sandbox-prewarm-serial.mjs --plan"))
          and any(f"WorkingDirectory={sv.rdir(C_)}" in l for l in plans_run) and any(f"WorkingDirectory={sv.rdir(B_)}" in l for l in plans_run), plans_run)
    check("keep (release.sh):   ...and every snapshot is removed by msb as the API's user", sum(l.startswith("runuser -u sfapp") and "snapshot remove" in l for l in c) == 2, [l for l in c if "msb" in l or "runuser" in l])
    sv = Server(tmp, "rel-unused-old", S, crons, releases=(B_, C_), current=C_, previous=B_)
    sstore = sv.root + V.SERVICE_HOME + "/.microsandbox"; open(sstore + "/bin/msb", "w").write("#!/bin/bash\nexit 0\n"); os.chmod(sstore + "/bin/msb", 0o755)
    for i in (1, 4): _snap(sstore, _tpl(i))
    r, kv = sv.run("keep")
    check("keep (release.sh): a kept release whose mold has no --plan is never asked for one (an older prewarm would take it for a full prewarm), and nothing more is removed",
          r.returncode == 0 and not any("--plan" in l for l in sv.lines("calls")) and sorted(os.listdir(sstore + "/snapshots")) == [_tpl(1), _tpl(4)] and "has no --plan" in r.stderr, (r.stdout[-300:], r.stderr[-300:]))

def _served_legacy(tmp):
    d = os.path.join(tmp, "served", "opt", "x"); os.makedirs(os.path.join(d, "app"))
    return V._served(d + "/current") == d + "/app"

# ---- the factory side -----------------------------------------------------------------------------------------------
def factory(check, tmp):
    S = B._settings(); crons = V.read_crons(B.MOLD)
    ev = "EVIDENCE " + json.dumps({"protected": 58})
    def attempt(name, answers=None, codes=None, public=("200", B.HEALTH_DOC, ""), health=None):
        log = []
        def runner(st, stdin=None):
            log.append(st["id"])
            out = {"qualify": B.fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(S)), "db-chain": ev, "health": health or B.fx("health-ok.txt"),
                   "switch": B.SWITCHED, **(answers or {})}.get(st["id"], "ok")
            return CP(st["argv"], (codes or {}).get(st["id"], 0), out, "the step's own words on stderr" if (codes or {}).get(st["id"]) else "")
        try: res = V.deploy(S, B.MOLD, crons, runner=runner, resolver=lambda d: ["203.0.113.10"], read_health=lambda u: public, say=lambda *_: None,
                            bundle_dir=os.path.join(tmp, f"factory-deploy-{name}"), wait=lambda s: None, release=D_, rehearse=B.NO_REHEARSAL)
        except V.Stop as e: res = e
        return res, log
    res, log = attempt("back", {"switch": f"HEALTH=failed workflow=200 api=000 web=200\nROLLED_BACK={C_}\n"}, {"switch": 10})
    check("factory: a switch the server switched back is reported as such: the previous release is serving and the site is up",
          isinstance(res, V.Stop) and f"release {C_}, which was serving before, is serving again" in str(res) and "api=000" in str(res) and log[-1] == "switch", (str(res)[:300], log[-3:]))
    res, log = attempt("first", {"switch": "SWITCH_BACK=none\n"}, {"switch": 9})
    check("factory:   ...a first release that failed says there was nothing to switch back to and that the site is not serving", isinstance(res, V.Stop) and "no earlier release" in str(res) and "not serving" in str(res))
    res, log = attempt("failed", {"switch": f"ROLLBACK_FAILED={C_}\n"}, {"switch": 11})
    check("factory:   ...and one where the old release did not come back either says plainly the site is down and what to run", isinstance(res, V.Stop) and "THE SITE IS DOWN" in str(res) and "--rollback-remote" in str(res))
    sick = B.fx("health-ok.txt").replace("API=200", "API=000")
    res, log = attempt("sick", {"rollback": f"ROLLED_BACK={C_}\nPREVIOUS={D_}\n"}, health=sick)
    check("factory: a release that switched in but then fails the health read is switched back by the rollback step, and the deploy says so",
          isinstance(res, V.Stop) and log[-1] == "rollback" and "keep" not in log and f"switched back to release {C_}" in str(res) and "agent API answered 000" in str(res), (str(res)[:300], log[-4:]))
    res, log = attempt("502", {"rollback": f"ROLLED_BACK={C_}\n"}, public=("502", None, "HTTP 502"))
    check("factory:   ...so is one the outside sees answering 502", isinstance(res, V.Stop) and log[-1] == "rollback" and "HTTP 502" in str(res))
    res, log = attempt("nocert", public=("", None, "nothing answered"))
    check("factory:   ...but no answer at all from outside (the certificate, DNS) is not the release's fault: no switch back, the deploy reports it as before",
          not isinstance(res, V.Stop) and "rollback" not in log and log[-1] == "keep" and res["problems"], (log[-3:], getattr(res, "get", lambda k: None)("problems")))
    for sid in ("build", "db-chain", "prewarm", "release"):
        res, log = attempt(f"fail-{sid}", codes={sid: 1})
        check(f"factory: a failed {sid} step stops before the switch and says the site was not touched",
              isinstance(res, V.Stop) and log[-1] == sid and "switch" not in log and "The site was not touched" in str(res), (str(res)[:200], log[-2:]))
    def smoked(result):
        log = []
        def runner(st, stdin=None):
            log.append(st["id"])
            out = {"qualify": B.fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(S)), "db-chain": ev, "health": B.fx("health-ok.txt"), "switch": B.SWITCHED,
                   "rollback": f"ROLLED_BACK={C_}\n"}.get(st["id"], "ok")
            return CP(st["argv"], 0, out, "")
        try: return V.deploy(S, B.MOLD, crons, runner=runner, resolver=lambda d: ["203.0.113.10"], read_health=lambda u: ("200", B.HEALTH_DOC, ""), say=lambda *_: None,
                             bundle_dir=os.path.join(tmp, f"factory-deploy-smoke-{result}"), wait=lambda s: None, release=D_, rehearse=B.NO_REHEARSAL,
                             smoke=lambda: {"result": result, "detail": "no complete answer within 150s" if result == "fail" else "no session on hand", "how": "mint.py x code"}), log
        except V.Stop as e: return e, log
    res, log = smoked("fail")
    check("factory: the post-deploy chat (lib/smoke.py) failing switches back too", isinstance(res, V.Stop) and log[-1] == "rollback" and "post-deploy chat failed" in str(res), (str(res)[:200], log[-3:]))
    res, log = smoked("needs_sign_in")
    check("factory:   ...but a chat that could not be run for want of a sign-in is a warning, not the release's fault", not isinstance(res, V.Stop) and log[-1] == "keep"
          and any("post-deploy chat was not run" in w for w in res["warnings"]), getattr(res, "get", lambda k: None)("warnings"))
    res, log = attempt("ok")
    check("factory: a deploy that passes ends with `keep`, after the health read", not isinstance(res, V.Stop) and log[-3:] == ["caddy", "health", "keep"] and res["release"]["current"] == D_, log[-4:])
    # --rollback-remote
    calls, said = [], []
    def rb_runner(answers):
        def r(st, stdin=None):
            calls.append(st["id"]); a = answers.get(st["id"], (0, "ok")); return CP(st["argv"], a[0], a[1], a[2] if len(a) > 2 else "")
        return r
    ok = {"release-status": (0, f"CURRENT={D_}\nPREVIOUS={C_}\nRELEASES={D_} {C_}\n"), "rollback": (0, f"rollback: current -> {C_}\nHEALTH=ok workflow=200 api=200 web=200\nNEWER_MIGRATIONS=0038_drop\nROLLED_BACK={C_}\nPREVIOUS={D_}\n"),
          "health": (0, B.fx("health-ok.txt"))}
    rc = V.rollback_remote("vm_remote_fixture", S, crons, runner=rb_runner(ok), read_health=lambda u: ("200", B.HEALTH_DOC, ""), say=said.append)
    text = "\n".join(said)
    check("--rollback-remote: it reads which release serves, goes back to the previous one, checks its health here and from outside, and says how to go forward",
          rc == 0 and calls == ["release-status", "rollback", "health"] and f"release {C_} is serving again" in text and "--rollback-remote once more" in text and "0038_drop" in text, (calls, text[-400:]))
    calls.clear(); said.clear()
    rc = V.rollback_remote("vm_remote_fixture", S, crons, runner=rb_runner({"release-status": (0, f"CURRENT={D_}\nPREVIOUS=\n")}), say=said.append)
    check("--rollback-remote:   ...with no earlier release it changes nothing", rc == 1 and calls == ["release-status"] and "Nothing was changed" in said[-1])
    calls.clear(); said.clear()
    rc = V.rollback_remote("vm_remote_fixture", S, crons, runner=rb_runner({"release-status": (127, "", "bash: /opt/software-factory/vm_remote_fixture/factory/release.sh: No such file or directory")}), say=said.append)
    check("--rollback-remote:   ...on a server deployed before releases it says there is nothing to go back to", rc == 1 and calls == ["release-status"] and "before releases existed" in said[-1])
    calls.clear(); said.clear()
    rc = V.rollback_remote("vm_remote_fixture", S, crons, runner=rb_runner(dict(ok, rollback=(14, f"HEALTH=failed workflow=200 api=000 web=200\nROLLBACK_UNDONE={D_}\n"))), say=said.append)
    check("--rollback-remote:   ...and when the earlier release does not come up, the server put the serving one back, and it says so", rc == 1 and f"put {D_} back" in said[-1])
    said.clear()
    rc = V.rollback_remote("vm_remote_fixture", S, crons, runner=lambda *a, **k: (_ for _ in ()).throw(AssertionError("contacted")), say=said.append, dry=True)
    text = "\n".join(said)
    check("--rollback-remote --dry-run prints the two commands and contacts nothing", rc == 0 and "release.sh status" in text and "release.sh detach rollback" in text and "DRY RUN" in text, text)
    d = B.fixture_docs()
    rc, printed = B.quiet(V.main_for, "vm_remote_fixture", ["vm_remote_fixture", "--rollback-remote", "--dry-run"], d["application"], d["infrastructure"], d["datastores"], V.FIXTURE, B.P)
    check("--rollback-remote --dry-run through provision's entry", rc == 0 and "release.sh detach rollback" in printed, printed[-300:])
    check("provision.py holds the app's deploy lock for --rollback-remote, as for a deploy", "--rollback-remote" in B.P.DEPLOY_FLAGS)
