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
  carry      a new release's prewarm reuses the template snapshots the serving release uses (its records carried over
             first, as the API's user) instead of rebuilding them under it; keep still removes what no plan uses
  factory    deploy() against recorded answers: what it says and runs when the switch switched back, when the health
             check after it fails, when the prewarm or the build fails; --rollback-remote
  buildfit   a build sized to the machine (mold_v1-232, lib/buildfit.py): the sizing for 2, 4 and 8 GB, 1 to 4 CPUs,
             idle and busy, beside a serving release or not; cgroup limits read from a stand-in /sys/fs/cgroup tree (the
             page cache left out); the wait for memory, the temporary swap file (only with no swap at all, and removed
             after), the retry tight after a kernel kill and with more heap after V8's own, the clear capacity exit with
             the measured numbers, build.sh running every heavy step through it, env-run carrying the sizing, and
             deploy() turning the capacity exit into the request for a bigger server, nothing switched

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
    buildfit(check, tmp)

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
            # eve's prewarmMicrosandboxTemplate, when the fixture names templates (eve-keys: "<key> <snapshot>" lines): a
            # record in THIS release's cache naming a snapshot the store has is reused; anything else is rebuilt, and eve
            # removes the snapshot of that name first (removeSnapshotIfExists), which a chat on the serving release may need
            f'if [ -f {self.d}/eve-keys ]; then t="$1/.eve/sandbox-cache/microsandbox/templates"; s="{self.root}{V.SERVICE_HOME}/.microsandbox/snapshots"\n'
            f'  while read -r k n; do if [ -f "$t/$k/metadata.json" ] && grep -q "\\"$n\\"" "$t/$k/metadata.json" && [ -d "$s/$n" ]; then echo "reused $k" >> {self.d}/eve\n'
            f'  else echo "rebuilt $n" >> {self.d}/eve; rm -rf "${{s:?}}/$n"; mkdir -p "$s/$n" "$t/$k"; printf \'{{"optionsHash": "ffdd1712e872da6aa9b0", "snapshotName": "%s", "version": 2}}\\n\' "$n" > "$t/$k/metadata.json"; fi\n'
            f'  done < {self.d}/eve-keys\nfi\n'
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
    carry(check, tmp, S, crons)

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

# ---- mold_v1-227: a new release reuses the serving release's template snapshots, never rebuilds them under it ----------
def carry(check, tmp, S, crons):
    # eve names a template snapshot createProviderName("eve-sbx-tpl", templateKey, optionsHash), and the template key
    # does not hold the release's path (first server, 2026-10-10: five of six keys, and so snapshot names, identical in
    # two releases). Before the fix the new release's empty cache made eve rebuild each one: removeSnapshotIfExists on
    # the very snapshot the serving release's chats start from, then seconds to minutes until the new one existed.
    base = os.path.join(tmp, "carry"); inst = os.path.join(base, "opt", "app"); home = os.path.join(base, "home"); store = os.path.join(home, ".microsandbox")
    tdir = lambda n: os.path.join(inst, "releases", n, ".eve/sandbox-cache/microsandbox/templates")
    for n in (A_, B_): os.makedirs(os.path.join(inst, "releases", n, ".eve"))
    os.symlink(f"releases/{A_}", os.path.join(inst, "current"))
    _cache(os.path.join(inst, "releases", A_), {_key(1): _tpl(1), _key(2): _tpl(2), _key(4): _tpl(4)})       # 4: its snapshot is gone
    for i in (1, 2): _snap(store, _tpl(i))
    os.makedirs(os.path.join(tdir(A_), _key(5))); json.dump({"optionsHash": "h", "snapshotName": "../../../etc", "version": 2}, open(os.path.join(tdir(A_), _key(5), "metadata.json"), "w"))
    os.makedirs(os.path.join(tdir(A_), _key(6) + ".abc.tmp")); json.dump({"optionsHash": "h", "snapshotName": _tpl(1), "version": 2}, open(os.path.join(tdir(A_), _key(6) + ".abc.tmp", "metadata.json"), "w"))
    outside = os.path.join(base, "elsewhere"); os.makedirs(outside); json.dump({"optionsHash": "h", "snapshotName": _tpl(2), "version": 2}, open(os.path.join(outside, "metadata.json"), "w"))
    os.symlink(outside, os.path.join(tdir(A_), _key(7)))
    os.makedirs(os.path.join(tdir(B_), _key(2))); json.dump({"optionsHash": "other", "snapshotName": _tpl(9), "version": 2}, open(os.path.join(tdir(B_), _key(2), "metadata.json"), "w"))
    served = digest(os.path.join(inst, "releases", A_)); said = []
    carry_ = getattr(V, "release_carry", None)
    n = carry_(inst, B_, home, say=said.append) if carry_ else None
    got = sorted(os.listdir(tdir(B_)))
    check("carry: a new release gets the serving release's template records, so eve reuses those snapshots instead of rebuilding them under the serving release (mold_v1-227)",
          n == 1 and got == [_key(1), _key(2)] and json.load(open(os.path.join(tdir(B_), _key(1), "metadata.json"))) == json.load(open(os.path.join(tdir(A_), _key(1), "metadata.json"))), (n, got, said))
    check("carry:   ...never a record whose snapshot is gone, one that does not name a template snapshot, eve's own temporary one, or a link; the new release's own record is kept",
          json.load(open(os.path.join(tdir(B_), _key(2), "metadata.json")))["optionsHash"] == "other" and digest(os.path.join(inst, "releases", A_)) == served, got)
    if carry_:
        said.clear()
        check("carry: nothing to carry when the release is the serving one, is not a release id, or nothing serves", carry_(inst, A_, home, say=said.append) == 0
              and carry_(inst, "../x", home, say=said.append) == 0 and carry_(os.path.join(tmp, "nothing"), B_, home, say=said.append) == 0, said)

    # ---- keep's "a prewarm is running" guard counts only a prewarm that uses this store (started with its HOME)
    other = os.path.join(base, "other-home"); os.makedirs(other)
    ps = [subprocess.Popen(["bash", "-c", "sleep 60; true", f"sandbox-prewarm-serial.mjs-{h}"], env={"PATH": "/usr/bin:/bin", "HOME": h}) for h in (home, other)]
    try:
        mine, theirs = V._proc_cmdlines(home), V._proc_cmdlines(other)
        check("keep: a prewarm counts as running only when it uses this store (its HOME); one for another store, such as another app's, is not",
              any(f"-{home}" in c for c in mine) and not any(f"-{other}" in c for c in mine) and any(f"-{other}" in c for c in theirs)
              and all(any(f"-{h}" in c for c in V._proc_cmdlines()) for h in (home, other)), (mine[-3:], theirs[-3:]))
    finally:
        for p_ in ps: p_.kill(); p_.wait()

    # ---- through release.sh prewarm, then keep: the serving release's snapshots are reused, and keep still cleans up
    sv = Server(tmp, "rel-carry", S, crons, releases=(A_, B_), current=A_)
    sstore = sv.root + V.SERVICE_HOME + "/.microsandbox"
    open(sstore + "/bin/msb", "w").write('#!/bin/bash\necho "msb $*" >> "%s/calls"\n[ "$1 $2" = "snapshot remove" ] && rm -r "$HOME/.microsandbox/snapshots/$3"\nexit 0\n' % sv.d); os.chmod(sstore + "/bin/msb", 0o755)
    def plannable(r_): os.makedirs(sv.rdir(r_) + "/scripts", exist_ok=True); open(sv.rdir(r_) + "/scripts/sandbox-prewarm-serial.mjs", "w").write('if (has("--plan")) {}\n')
    for r_ in (A_, B_): plannable(r_)
    _cache(sv.rdir(A_), {_key(1): _tpl(1), _key(2): _tpl(2), _key(3): _tpl(3)})                   # 3: a template the new code no longer has
    for i in (1, 2, 3): _snap(sstore, _tpl(i))
    sv.put("eve-keys", f"{_key(1)} {_tpl(1)}", f"{_key(2)} {_tpl(2)}", f"{_key(9)} {_tpl(9)}")
    served = digest(sv.rdir(A_))
    r, kv = sv.run("prewarm", B_)
    eve = sv.lines("eve") if os.path.exists(os.path.join(sv.d, "eve")) else []
    check("carry (release.sh prewarm): the templates the serving release uses are reused, so no snapshot a chat on it starts from is removed and rebuilt; only the new one is built",
          r.returncode == 0 and kv.get("PREWARMED") == B_ and eve == [f"reused {_key(1)}", f"reused {_key(2)}", f"rebuilt {_tpl(9)}"] and digest(sv.rdir(A_)) == served, (eve, r.stdout[-300:], r.stderr[-300:]))
    c = sv.lines("calls"); cl = next((i for i, l in enumerate(c) if "release-carry" in l), None); sr = next((i for i, l in enumerate(c) if l.startswith("systemd-run")), None)
    check("carry (release.sh prewarm):   ...the records are carried as the API's user (it owns both caches), before the prewarm starts",
          cl is not None and sr is not None and cl < sr and c[cl].startswith(f"runuser -u {V.SERVICE_USER} --") and f"--to {B_}" in c[cl], c)
    sv.point("current", B_); sv.point("previous", A_)
    os.remove(os.path.join(sv.d, "eve"))
    r, kv = sv.run("prepare", C_); sv.build(C_); plannable(C_); r2, kv2 = sv.run("prewarm", C_)
    check("carry (release.sh prewarm):   ...and a later release reuses them again, the reruns' mark logic unchanged",
          r.returncode == 0 and r2.returncode == 0 and sv.lines("eve") == [f"reused {_key(1)}", f"reused {_key(2)}", f"reused {_key(9)}"] and os.path.exists(sv.root + S["marks"] + "/" + C_), (sv.lines("eve"), r2.stderr[-300:]))
    sv.point("current", C_); sv.point("previous", B_)
    for r_ in (B_, C_): json.dump(_plan([_key(1), _key(2), _key(9)]), open(os.path.join(sv.d, f"plan-{r_}.json"), "w"))
    r, kv = sv.run("keep")
    left = sorted(os.listdir(sstore + "/snapshots"))
    check("carry (release.sh keep): keep removes the old release and the snapshot no kept release's plan uses, even though its record was carried; shared ones stay",
          r.returncode == 0 and not os.path.exists(sv.rdir(A_)) and left == [_tpl(1), _tpl(2), _tpl(9)], (left, r.stdout[-500:], r.stderr[-300:]))
    r, kv = sv.run("prepare", D_); sv.build(D_); os.makedirs(sv.rdir(D_) + "/.eve", exist_ok=True); sv.run("prewarm", D_)
    check("carry (release.sh prewarm): a record whose snapshot keep removed is not carried on", sorted(os.listdir(sv.rdir(D_) + "/.eve/sandbox-cache/microsandbox/templates")) == sorted([_key(1), _key(2), _key(9)]),
          os.listdir(sv.rdir(D_) + "/.eve/sandbox-cache/microsandbox/templates"))

# ---- mold_v1-232: a build sized to the machine that runs it ----------------------------------------------------------
import buildfit as BF

def box(mem_gb, cpus, avail_frac=0.8, load=0.0, swap=0, room=None, limit=None, host=None, disk=50000):
    """Facts for a machine of this size: MemAvailable at `avail_frac` of it, `load` on its CPUs."""
    total = int(mem_gb * 1024 * 0.97)
    return {"mem_total_mb": total, "mem_avail_mb": int(total * avail_frac), "swap_total_mb": swap, "swap_free_mb": swap, "cg_room_mb": room,
            "cg_limit_mb": limit, "cpus": cpus, "host_cpus": host or cpus, "load1": load, "disk_free_mb": disk}

def _pack(tmp, name, n):
    """A build copy with n subagents (agent/subagents/<i>/agent.ts)."""
    d = os.path.join(tmp, name)
    for i in range(n):
        os.makedirs(os.path.join(d, "agent", "subagents", f"s{i}"), exist_ok=True); open(os.path.join(d, "agent", "subagents", f"s{i}", "agent.ts"), "w").write("export default {}\n")
    os.makedirs(os.path.join(d, "agent", "subagents", "not-one"), exist_ok=True)
    return d

class _Eyes:
    """Stand-in watchers, one per try: what each saw."""
    def __init__(self, *seen): self.seen = list(seen); self.units = []
    def __call__(self, unit=None):
        self.units.append(unit); got = self.seen.pop(0) if self.seen else {}
        class One:
            def stop(_): return {"peak_mb": got.get("peak_mb"), "oom_kills": got.get("oom_kills", 0), "killed": got.get("killed", [])}
        return One()

def honest(check, tmp, go, roomy):
    """mold_v1-247: a build has finished only when it left its product and none of its processes was killed; its output
    is shown when it fails; its need is the app's; one heavy build at a time; swap when the need is above the memory."""
    finished = lambda log: [l for l in log["said"] if " finished in " in l]
    # ---- 1. a killed child with a parent that exits 0 ----
    victim = {"pid": 843059, "name": "MainThread", "anon_mb": 4753}
    rc, log = go([roomy], [0, 0], watch=_Eyes({"peak_mb": 4700, "oom_kills": 1, "killed": [victim]}, {"peak_mb": 3000}))
    first = next((l for l in log["said"] if "FAILED" in l), "")
    check("honest: the kernel killed a child and the build tool still exited 0: a FAILURE that says so (which process, at how many MB, that the exit was 0), "
          "never `finished`; then the retry, tight, which finishes", rc == 0 and len(log["runs"]) == 2 and "killed one of its processes (MainThread, pid 843059)" in first
          and "at 4753 MB" in first and "own exit was 0" in first and len(finished(log)) == 1 and log["said"].index(finished(log)[0]) > log["said"].index(first)
          and log["runs"][1]["BUILD_CPUS"] == "1", log["said"])
    rc, log = go([roomy], [0, 0], watch=_Eyes({"oom_kills": 1, "peak_mb": 4800}, {"oom_kills": 2, "peak_mb": 4900}))
    check("honest:   ...killed again on the retry: the capacity exit and BUILD_SHORT with killed=1 and where it was killed, nothing `finished`",
          rc == BF.CAPACITY_RC and not finished(log) and log["said"][-1].startswith("BUILD_SHORT") and "killed_at_mb=4900" in log["said"][-1]
          and log["said"][-1].endswith("killed=1"), log["said"][-2:])
    rc, log = go([roomy], [0], watch=_Eyes({"peak_mb": 2400}))
    check("honest:   ...a watched build nobody killed finishes once, and says its peak", rc == 0 and len(log["runs"]) == 1 and "2400 MB at its most" in finished(log)[0], log["said"])
    # the scope's own count, the kernel's log, and whose kill it was
    cg = os.path.join(tmp, "cg247"); sc = os.path.join(cg, "system.slice", "sf-build-1-2-1.scope"); os.makedirs(sc)
    for f_, t_ in (("memory.stat", f"anon {3 << 30}\nfile {1 << 30}\n"), ("memory.swap.current", str(1 << 30)), ("memory.events", "low 0\nhigh 9\noom 1\noom_kill 1\n"),
                   ("cgroup.procs", "111\n222\n")): open(os.path.join(sc, f_), "w").write(t_)
    klog = ("[100.5] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=/user.slice/session-1.scope,task=next-server (v1,pid=999,uid=0\n"
            "[100.6] Out of memory: Killed process 999 (next-server (v1) total-vm:25882480kB, anon-rss:3858108kB, file-rss:3072kB, shmem-rss:0kB, UID:0 pgtables:17004kB oom_score_adj:0\n"
            "[200.1] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=/system.slice/sf-build-1-2-1.scope,task=MainThread,pid=843059,uid=0\n"
            "[200.2] Out of memory: Killed process 843059 (MainThread) total-vm:25426116kB, anon-rss:4867292kB, file-rss:2560kB, shmem-rss:0kB, UID:0 pgtables:89384kB oom_score_adj:0\n")
    w = BF.Watch("sf-build-1-2-1", every=30, root=cg, dmesg=lambda: klog); w.since = 150.0; seen = w.stop()
    check("honest: the watcher reads the step's own scope: its peak (anonymous + swapped, not the page cache), memory.events' oom_kill, and the kernel's log for "
          "a kill in that scope, with the size it was killed at (4753 MB, the 2026-10-13 kill)", seen["peak_mb"] == 4096 and seen["oom_kills"] == 1
          and seen["killed"] == [{"pid": 843059, "name": "MainThread", "anon_mb": 4753}], seen)
    check("honest:   ...another app's kill (a dev server, another scope) and a kill before the step began are not this step's",
          BF.oom_victims(klog, 0, [], "sf-build-1-2-1") == seen["killed"] and BF.oom_victims(klog, 250, [843059], "sf-build-1-2-1") == []
          and BF.oom_victims(klog, 0, [999]) == [{"pid": 999, "name": "next-server (v1", "anon_mb": 3767}])
    me = BF.Watch(None, every=30, dmesg=lambda: ""); seen = me.stop()
    check("honest:   ...with no scope it follows this process's own descendants, and never fails the build it watches", seen["oom_kills"] == 0 and seen["killed"] == [], seen)
    pl = BF.plan("eve", roomy); pl["unit"] = "sf-build-9-9-1"
    if os.path.isdir("/run/systemd/system"):
        check("honest:   ...the scope is named, so its cgroup can be found", "--unit=sf-build-9-9-1" in BF.wrap(["x"], pl, roomy, which=lambda c: "/usr/bin/" + c, euid=0))
    # ---- 2. a missing product ----
    app = _pack(tmp, "app14", 14); prod = os.path.join(".vercel", "output", "config.json")
    def writes(argv, env, cwd): os.makedirs(os.path.join(cwd, ".vercel", "output"), exist_ok=True); open(os.path.join(cwd, prod), "w").write("{}"); return 0, "built\n"
    rc, log = go([roomy], [0], cwd=app, produces=[prod])
    check("honest: a build that exits 0 without what it is for (.vercel/output/config.json) FAILED: exit 1, the missing file named, never `finished`, and with no "
          "sign of a kill it is not run again", rc == 1 and len(log["runs"]) == 1 and not finished(log) and any("did not leave " + prod in l for l in log["said"]), log["said"])
    rc, log = go([roomy], [0, 0], cwd=app, produces=[prod], kills_seq=[3, 4, 4, 4, 4])
    check("honest:   ...missing while the kernel's OOM count rose: killed for memory, so the retry (and still missing: a failure, not `finished`)",
          rc == 1 and len(log["runs"]) == 2 and not finished(log) and log["runs"][1]["BUILD_CPUS"] == "1", log["said"])
    rc, log = go([roomy], [0], cwd=app, produces=[prod], runner=writes)
    check("honest:   ...and the build that leaves it has finished", rc == 0 and len(finished(log)) == 1, log["said"])
    os.utime(os.path.join(app, prod), (1, 1))
    rc, log = go([roomy], [0], cwd=app, produces=[prod])
    check("honest:   ...an earlier build's product does not count: it must be this run's", rc == 1 and not finished(log), log["said"])
    # ---- 3. the build's own output ----
    noisy = "".join(f"line {i}\n" for i in range(1, 101)) + "postgres://app:hunter2secret@db.internal/x\nAUTH_TOKEN=abcd1234efgh\nError: boom\n"
    kept = os.path.join(tmp, "out247", "deploy.eve-api-build.out")
    rc, log = go([roomy], [1], tails=[noisy], out_file=kept)
    shown = [l for l in log["said"] if l.startswith("  | ")]
    check("honest: a failed build's last 60 lines are in the log, under a line that says so and names the file with the whole of it",
          rc == 1 and len(shown) == BF.TAIL_LINES and shown[-1] == "  | Error: boom" and shown[0] == "  | line 44"
          and any("the last 60 lines" in l and kept in l for l in log["said"]), (len(shown), shown[:1], shown[-1:]))
    whole = open(kept).read()
    check("honest:   ...secrets hidden in the log and in the file, which keeps every line and only its owner may read",
          not any("hunter2secret" in l or "abcd1234efgh" in l for l in log["said"]) and "hunter2secret" not in whole and "abcd1234efgh" not in whole
          and "line 1\n" in whole and "Error: boom" in whole and "postgres://***:***@db.internal" in whole and (os.stat(kept).st_mode & 0o077) == 0, whole[-200:])
    rc, log = go([roomy], [0, 0], tails=["child gone\n", ""], watch=_Eyes({"oom_kills": 1}, {}))
    check("honest:   ...a killed build's output is shown too", rc == 0 and "  | child gone" in log["said"], log["said"])
    rc, log = go([roomy], [0], tails=[noisy])
    check("honest:   ...a build that finished shows none of it", rc == 0 and not any(l.startswith("  | ") for l in log["said"]))
    # ---- 4. the need is the app's ----
    big = _pack(tmp, "app27", 27)
    p14, p27 = BF.profile("eve", app, "a14", {}), BF.profile("eve", big, "a27", {})
    check("sized to the app: the eve build's need grows with the subagents in the build copy: 14 is the usual 2600 MB, 27 is about 5 GB (5.06 GB measured), "
          "with a heap that grows too (out of heap at 2656 MB, fine at 3852)", (BF.subagents(app), BF.subagents(big)) == (14, 27) and p14["need_mb"] == 2600 and p14["heap_mb"] == 1280
          and 4900 <= p27["need_mb"] <= 5300 and p27["floor_mb"] > p14["need_mb"] and 3700 <= p27["heap_mb"] <= 4100, (p14, p27))
    check("sized to the app:   ...the other steps, and a directory with no subagents, keep the usual numbers",
          BF.profile("web", big, "a27", {})["need_mb"] == BF.STEPS["web"]["need_mb"] and BF.profile("eve", tmp, "x", {})["need_mb"] == 2600)
    eight = dict(box(8, 4), mem_avail_mb=5253)       # 5.25 GB available, no swap: the 2026-10-13 machine, as the killed build was sized
    check("sized to the app:   ...on 8 GB with 5.25 GB free and no swap, 14 subagents build roomy; 27 do not (they were sized as roomy, and killed)",
          BF.plan("eve", eight, prof=p14)["mode"] == "roomy" and BF.plan("eve", eight, prof=p27)["mode"] != "roomy" and "27 subagents" in BF.plan("eve", eight, prof=p27)["why"])
    peaks = os.path.join(tmp, "peaks247", "build-peaks.json")
    rc, log = go([roomy], [0], cwd=big, who="a27", peaks=peaks, watch=_Eyes({"peak_mb": 4400}))
    rec = BF.read_peaks(peaks).get("a27:eve") or {}
    check("sized to the app: a build that finished leaves its measured peak for the app (with its subagent count), nowhere but the peaks file it was given",
          rc == 0 and rec.get("peak_mb") == 4400 and rec.get("subagents") == 27 and "at_least_mb" not in rec, rec)
    again = BF.profile("eve", big, "a27", BF.read_peaks(peaks))
    check("sized to the app:   ...and the next build of that app is sized from it (the peak plus a tenth), not from the estimate; another app's is not",
          again["need_mb"] == 4850 and again["measured_mb"] == 4400 and "peaked at 4400 MB" in again["basis"] and BF.profile("eve", big, "other", BF.read_peaks(peaks))["need_mb"] == p27["need_mb"], again)
    grown = BF.profile("eve", _pack(tmp, "app30", 30), "a27", BF.read_peaks(peaks))
    check("sized to the app:   ...subagents added since then are added to it", grown["need_mb"] == BF._up((4400 + 3 * BF.PER_SUBAGENT_MB) * BF.PEAK_MARGIN), grown["need_mb"])
    rc, log = go([roomy], [0, 0], cwd=big, who="k27", peaks=peaks, watch=_Eyes({"oom_kills": 1, "peak_mb": 5600}, {"oom_kills": 1, "peak_mb": 5600}))
    after_kill = BF.profile("eve", big, "k27", BF.read_peaks(peaks))
    check("sized to the app:   ...a build killed at 5600 MB is remembered as needing more than that, until one finishes",
          rc == BF.CAPACITY_RC and after_kill["need_mb"] >= 5600 and "killed at 5600 MB" in after_kill["basis"], after_kill)
    four = box(4, 2, avail_frac=0.85, disk=3000)     # 4 GB, no swap, no disk for a swap file
    rc, log = go([four], [0], cwd=big, who="a27")
    line = BF.parse_short(log["said"][-1]) or {}
    check("sized to the app: a machine that cannot give the app's need even with all of its memory and swap stops BEFORE building, with no wait: BUILD_SHORT "
          "carries the app's need, its subagents and the most the machine has", rc == BF.CAPACITY_RC and not log["runs"] and not log["slept"]
          and line.get("need_mb") == p27["need_mb"] and line.get("subagents") == 27 and line.get("most_mb") < line.get("floor_mb") and BF.too_small(line), log["said"][-2:])
    words = BF.short_words(line)
    check("sized to the app:   ...and the sentence names them: this app, its 27 subagents, what it needs, what the machine can give, that waiting will not help",
          "for this app (27 subagents)" in words and f"{p27['need_mb']} MB" in words and f"is {line['most_mb']} MB" in words and "waiting will not help" in words, words)
    rc, log = go([four], [0], cwd=app, who="a14")
    check("sized to the app:   ...the same machine still builds the 14-subagent app", rc == 0 and len(log["runs"]) == 1, log["said"])
    busy = box(8, 4, avail_frac=0.2, disk=3000)
    check("sized to the app:   ...a machine that is only busy is not called too small", not BF.too_small(BF.parse_short(BF.short_line("eve", busy, True, prof=p14))))
    # ---- 5. one heavy build at a time on a machine ----
    import fcntl
    lock_path = os.path.join(tmp, "lock247", "heavy-build.lock"); os.makedirs(os.path.dirname(lock_path))
    holder = open(lock_path, "a+"); fcntl.flock(holder, fcntl.LOCK_EX)
    holder.write(json.dumps({"who": "other_app", "pid": 4242, "since": 1000})); holder.flush()
    order, slept = [], []
    def nap(s_):
        slept.append(s_)
        if len(slept) == 3: order.append("other done"); holder.seek(0); holder.truncate(); fcntl.flock(holder, fcntl.LOCK_UN)
    def lk(who, say, sleep): return BF.machine_lock(who, say=say, sleep=nap, path=lock_path, wait_s=600, poll_s=5, now=lambda: 1300)
    rc, log = go([roomy], [0], lock=lk, who="this_app", runner=lambda a, e, c: order.append("this built") or (0, ""))
    waiting = [l for l in log["said"] if "waiting for other_app's build" in l]
    check("one at a time: a second app's build queues behind the first's, saying whose build it waits for and for how long, and starts only when that is done",
          rc == 0 and order == ["other done", "this built"] and len(waiting) == 1 and "this_app" in waiting[0] and "pid 4242" in waiting[0] and "started 5 min ago" in waiting[0]
          and sum(slept) == 15, (order, slept, log["said"][:3]))
    check("one at a time:   ...it is sized only once it holds the machine (the plan comes after the wait), and its own processes are told the lock is held",
          log["said"].index(next(l for l in log["said"] if "eve roomy" in l)) > log["said"].index(waiting[0]) and any("other_app's build is done" in l for l in log["said"]), log["said"])
    env_seen = {}
    rc, log = go([roomy], [0], lock=lk, who="this_app", runner=lambda a, e, c: env_seen.update(e) or (0, ""))
    check("one at a time:   ...a free machine is taken at once, held for the build, and free again after", rc == 0 and env_seen.get(BF.LOCK_ENV) == "held"
          and not any("waiting for" in l for l in log["said"]) and open(lock_path).read() == "", log["said"])
    fcntl.flock(holder, fcntl.LOCK_EX); slept.clear()
    def lk_short(who, say, sleep): return BF.machine_lock(who, say=say, sleep=slept.append, path=lock_path, wait_s=10, poll_s=5)
    rc, log = go([roomy], [0], lock=lk_short, who="this_app")
    check("one at a time:   ...and a build that is still held off at the end of the wait is NOT started: exit 1, saying so, nothing run",
          rc == 1 and not log["runs"] and "was not started" in log["said"][-1], log["said"])
    rc, log = go([roomy], [0], lock=lk_short, who="this_app", runner=lambda a, e, c: (0, ""))
    fcntl.flock(holder, fcntl.LOCK_UN); holder.close()
    with BF.machine_lock("a", say=lambda l: None, path=lock_path) as other:
        check("one at a time:   ...the lock is a flock: it goes with its process, and its file is never something to delete", other is None and json.load(open(lock_path))["who"] == "a")
    check("one at a time:   ...the machine's own lock and peaks file are under ~/.cache/software-factory", BF.LOCK_PATH.startswith(os.path.join(os.path.expanduser("~"), ".cache", "software-factory") + os.sep)
          and os.path.dirname(BF.PEAKS_PATH) == os.path.dirname(BF.LOCK_PATH))
    # ---- 6. swap whenever the need is above the memory ----
    has_swap = dict(eight, swap_total_mb=8191, swap_free_mb=8000)
    pl = BF.plan("eve", has_swap, prof=p27)
    check("swap: the app's need above the free memory on a machine WITH swap: it runs, counting its swap (said in the plan), not short and not as if it were roomy",
          pl["mode"] == "tight" and pl["swap_mb"] > 0 and pl["budget_mb"] >= p27["need_mb"] and "of it swap" in BF.plan_line(pl), pl)
    rc, log = go([has_swap], [0], cwd=big, who="a27")
    check("swap:   ...and no temporary file is made when the machine's own swap covers it", rc == 0 and not log["swap"] and len(log["runs"]) == 1, log["swap"])
    check("swap:   ...none is counted, and none made, when the memory alone covers the need", BF.plan("eve", has_swap, prof=p14)["swap_mb"] == 0 and BF.swap_mb_for("eve", has_swap, False, p14, euid=0) == 0)
    under = dict(eight, swap_total_mb=1024, swap_free_mb=0)            # above the floor, under the need, its own swap used up
    rc, log = go([under, dict(under, swap_total_mb=5120, swap_free_mb=4296)], [0], cwd=big, who="a27", serving=False)
    if os.geteuid() == 0:
        check("swap:   ...a machine whose own swap does not cover the need gets the temporary file for what is missing, without being short first, removed after",
              rc == 0 and log["swap"] and log["swap"][0][0] == "on" and log["swap"][-1] == ("off",) and not log["slept"], (log["swap"], log["said"][:2]))
    check("swap:   ...only as root, and only with the disk to spare beside it", BF.swap_mb_for("eve", under, False, p27, euid=1000) == 0
          and BF.swap_mb_for("eve", dict(under, disk_free_mb=4000), False, p27, euid=0) == 0 and BF.swap_mb_for("eve", under, False, p27, euid=0) >= 1024)

def buildfit(check, tmp):
    # ---- the sizing table: 2, 4, 8 GB x 1-4 CPUs x idle and busy ----
    rows = {}
    for gb in (2, 4, 8):
        for cpus in (1, 2, 3, 4):
            for busy in (False, True):
                f = box(gb, cpus, avail_frac=0.45 if busy else 0.85, load=cpus * 0.9 if busy else 0.1)
                for step in ("eve", "web", "workflow", "npm-ci"):
                    rows[(gb, cpus, busy, step)] = BF.plan(step, f, serving=True)
    bad = []
    for (gb, cpus, busy, step), pl in rows.items():
        need, floor, heap = BF.STEPS[step]["need_mb"], BF.STEPS[step]["floor_mb"], BF.STEPS[step]["heap_mb"]
        b = pl["budget_mb"]
        want = "roomy" if b >= need else "tight" if b >= floor else "short"
        if pl["mode"] != want: bad.append(f"{gb}GB/{cpus}cpu/{'busy' if busy else 'idle'}/{step}: mode {pl['mode']}, want {want} (budget {b})")
        if not (1 <= pl["workers"] <= cpus and 1 <= pl["threads"] <= cpus): bad.append(f"{gb}/{cpus}/{step}: {pl['workers']} workers, {pl['threads']} threads on {cpus} CPUs")
        if pl["mode"] != "roomy" and (pl["workers"] != 1 or pl["threads"] > 2): bad.append(f"{gb}/{cpus}/{step}: tight but {pl['workers']} workers")
        if not (heap <= pl["heap_mb"] <= BF.HEAP_MAX_MB): bad.append(f"{gb}/{cpus}/{step}: heap {pl['heap_mb']} outside {heap}-{BF.HEAP_MAX_MB}")
        if pl["mode"] == "roomy" and pl["heap_mb"] > b: bad.append(f"{gb}/{cpus}/{step}: heap {pl['heap_mb']} over the budget {b}")
        if pl["env"]["NODE_OPTIONS"] != f"--max-old-space-size={pl['heap_mb']}" or pl["env"]["BUILD_CPUS"] != str(pl["workers"]): bad.append(f"{gb}/{cpus}/{step}: env {pl['env']}")
        if busy and pl["nice"] != 19: bad.append(f"{gb}/{cpus}/{step}: busy but nice {pl['nice']}")
    check("buildfit: across 2/4/8 GB, 1-4 CPUs, idle and busy, every step's mode follows its budget, workers and threads fit the CPUs, "
          "tight is one worker, the heap stays between the step's floor and 4 GB and under the budget, and the env says the same", not bad, bad[:6])
    g = lambda gb, cpus, busy, step: rows[(gb, cpus, busy, step)]
    check("buildfit:   ...8 GB idle, 4 CPUs: the web build roomy, 3 workers (Next's own default), 4 native threads, a heap of a few GB",
          (g(8, 4, False, "web")["mode"], g(8, 4, False, "web")["workers"], g(8, 4, False, "web")["threads"]) == ("roomy", 3, 4) and g(8, 4, False, "web")["heap_mb"] >= 2048,
          {k: g(8, 4, False, "web")[k] for k in ("mode", "workers", "threads", "heap_mb")})
    check("buildfit:   ...8 GB busy (other work holds half): the eve build still fits, at nice 19 and idle IO, fewer workers than CPUs",
          g(8, 4, True, "eve")["mode"] in ("roomy", "tight") and g(8, 4, True, "eve")["nice"] == 19 and g(8, 4, True, "eve")["ionice"] == "idle")
    check("buildfit:   ...4 GB idle: eve and web tight or roomy, never short; 4 GB busy: they are short (wait, swap or a bigger box)",
          all(g(4, c, False, s_)["mode"] != "short" for c in (1, 2, 3, 4) for s_ in ("eve", "web")) and all(g(4, c, True, s_)["mode"] == "short" for c in (1, 2, 4) for s_ in ("eve", "web")),
          [(c, s_, g(4, c, b_, s_)["mode"], g(4, c, b_, s_)["budget_mb"]) for c in (1, 4) for b_ in (False, True) for s_ in ("eve", "web")])
    check("buildfit:   ...2 GB: every heavy build is short without swap; the install and the task-workflow build are not when idle",
          all(g(2, c, b_, s_)["mode"] == "short" for c in (1, 4) for b_ in (False, True) for s_ in ("eve", "web")) and g(2, 2, False, "npm-ci")["mode"] != "short")
    check("buildfit:   ...1 CPU: one worker and one native thread whatever the memory", all(g(gb, 1, b_, s_)["workers"] == 1 and g(gb, 1, b_, s_)["threads"] == 1
          for gb in (2, 4, 8) for b_ in (False, True) for s_ in ("eve", "web")))
    with_swap = BF.plan("eve", box(2, 2, avail_frac=0.85, swap=4096), serving=False)
    check("buildfit:   ...2 GB with 4 GB of swap: eve runs tight, counting half the free swap, slow but not killed",
          with_swap["mode"] == "tight" and with_swap["workers"] == 1, {k: with_swap[k] for k in ("mode", "budget_mb", "heap_mb")})
    lone = BF.plan("web", box(8, 4, avail_frac=0.62), serving=False); beside = BF.plan("web", box(8, 4, avail_frac=0.62), serving=True)
    check("buildfit:   ...beside a serving release more is kept back (the release's headroom) than on a machine that serves nothing",
          beside["budget_mb"] < lone["budget_mb"] and BF.headroom_mb(box(8, 4), True) >= 480, (lone["budget_mb"], beside["budget_mb"]))
    check("buildfit:   ...no memory reading (macOS): tight at the step's need, never a guess of plenty", BF.plan("eve", dict(box(8, 4), mem_avail_mb=None))["mode"] == "tight")
    check("buildfit:   ...the soft memory limit is never under the step's need (a step above it would crawl, not finish)",
          all(pl["memory_high_mb"] >= BF.STEPS[k[3]]["need_mb"] for k, pl in rows.items()))
    # ---- what is measured: a cgroup's limit, not the host's ----
    cg = os.path.join(tmp, "cgroup"); leaf = os.path.join(cg, "system.slice", "build.scope")
    os.makedirs(leaf)
    files = {os.path.join(cg, "system.slice", "memory.max"): "max\n", os.path.join(cg, "system.slice", "memory.current"): str(5 << 30),
             os.path.join(cg, "system.slice", "memory.stat"): f"anon {4 << 30}\nfile {1 << 30}\n",
             os.path.join(leaf, "memory.max"): str(3 << 30), os.path.join(leaf, "memory.current"): str(int(1.5 * (1 << 30))),
             os.path.join(leaf, "memory.stat"): f"anon {1 << 29}\nfile {1 << 30}\n", os.path.join(leaf, "memory.high"): "max\n",
             os.path.join(leaf, "cpu.max"): "200000 100000\n"}
    for pth, txt in files.items(): open(pth, "w").write(txt)
    def read(pth):
        if pth == "/proc/self/cgroup": return "0::/system.slice/build.scope\n"
        try: return open(pth).read()
        except OSError: return None
    room, limit, cpus = BF.cgroup_limits(read, root=cg)
    check("buildfit: a cgroup's limit is found from the leaf up: 3 GB, of which 0.5 GB held (its 1 GB of page cache does not count), 2 CPUs from cpu.max",
          (room, limit, cpus) == (2560, 3072, 2), (room, limit, cpus))
    check("buildfit:   ...and no cgroup line (not Linux, cgroup v1) is no limit, not zero", BF.cgroup_limits(lambda p: None) == (None, None, None))
    capped = BF.plan("eve", box(8, 4, avail_frac=0.85, room=1800, limit=3072, host=4), serving=False)
    check("buildfit:   ...a build inside that limit is sized to it, not to the host's free memory", capped["mode"] == "short" and capped["budget_mb"] < 1800, capped["budget_mb"])
    mi = BF._meminfo("MemTotal:        8129672 kB\nMemAvailable:    5120000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n")
    check("buildfit: /proc/meminfo is read in MB", (mi["MemTotal"], mi["MemAvailable"], mi["SwapTotal"]) == (7939, 5000, 0), mi)
    real = BF.measure()
    check("buildfit: the real measurement works on this machine", real["cpus"] >= 1 and (real["mem_avail_mb"] is None or real["mem_avail_mb"] > 0), real)
    check("buildfit: idle CPUs: a 4-CPU host at load 3 has 1; a 2-CPU cgroup on that host keeps both until the other two are full",
          (BF.idle_cpus(box(8, 4, load=3.0)), BF.idle_cpus(box(8, 2, load=2.0, host=4)), BF.idle_cpus(box(8, 2, load=3.4, host=4))) == (1, 2, 1))
    # ---- how it runs: priority, and never escaping a limit ----
    pl = BF.plan("web", box(8, 4))
    w = BF.wrap(["npm", "run", "build"], pl, box(8, 4), which=lambda c: "/usr/bin/" + c, euid=0)
    if os.path.isdir("/run/systemd/system"):
        check("buildfit: as root with systemd, a transient scope with CPUWeight, IOWeight, MemoryHigh and nice, ionice inside it",
              w[:4] == ["systemd-run", "--quiet", "--scope", "--collect"] and f"MemoryHigh={pl['memory_high_mb']}M" in w and f"--nice={pl['nice']}" in w
              and w[w.index("--") + 1] == "ionice" and w[-3:] == ["npm", "run", "build"], w)
    w = BF.wrap(["npm", "run", "build"], pl, box(8, 2, limit=3072, host=4), which=lambda c: "/usr/bin/" + c, euid=0)
    check("buildfit:   ...inside a cgroup limit no new scope (it would be made outside the limit and escape it): nice and ionice instead",
          w[0] == "nice" and "systemd-run" not in w and w[-3:] == ["npm", "run", "build"] and "ionice" in w, w)
    w = BF.wrap(["x"], pl, box(8, 4), which=lambda c: None, euid=1000)
    check("buildfit:   ...and with neither tool, the command as it is", w == ["x"], w)
    e = BF.sized_env({"NODE_OPTIONS": "--enable-source-maps --max-old-space-size=8000", "KEEP": "1"}, pl)
    check("buildfit: NODE_OPTIONS keeps its other flags and gets this heap ceiling instead of any other; the rest is kept",
          e["NODE_OPTIONS"] == f"--enable-source-maps --max-old-space-size={pl['heap_mb']}" and e["KEEP"] == "1" and e["BUILD_CPUS"] == str(pl["workers"]), e["NODE_OPTIONS"])
    # ---- run: the wait, the swap file, the retry, the clear failure (every outside effect a stand-in) ----
    def go(facts_seq, codes, tails=None, swap_made=True, kills_seq=None, **kw):
        fs, cs, ts = iter(facts_seq), iter(codes), iter(tails or [""] * len(codes)); ks = iter(kills_seq or [None] * 20)
        last = {"f": None}
        def probe():
            try: last["f"] = next(fs)
            except StopIteration: pass
            return dict(last["f"])
        log = {"runs": [], "slept": [], "said": [], "swap": []}
        def runner(argv, env, cwd): log["runs"].append(dict(env)); return next(cs), next(ts)
        swap = (lambda mb, say: log["swap"].append(("on", mb)) or swap_made, lambda say: log["swap"].append(("off",)))
        # nothing of this machine's: no lock, no watcher, no peaks file (each has its own checks below)
        for k_, v_ in (("watch", None), ("lock", None), ("peaks", False)): kw.setdefault(k_, v_)
        rc = BF.run(kw.pop("step", "eve"), ["npm", "run", "build:eve"], serving=kw.pop("serving", True), wait_s=kw.pop("wait_s", 60), poll_s=15, env={}, probe=probe,
                    runner=kw.pop("runner", None) or runner, sleep=log["slept"].append, kills=lambda: next(ks), swap=swap, wrapper=lambda a, p, f: a, say=log["said"].append, **kw)
        return rc, log
    roomy, short = box(8, 4, avail_frac=0.85), box(8, 4, avail_frac=0.2)
    rc, log = go([roomy], [0])
    check("buildfit run: a machine with room runs the step once, sized, and says how", rc == 0 and len(log["runs"]) == 1 and "eve roomy" in log["said"][0]
          and log["runs"][0]["NODE_OPTIONS"].startswith("--max-old-space-size="), log["said"])
    rc, log = go([short, short, roomy], [0])
    check("buildfit run: memory short now: it waits (saying what is using it), and runs once there is room, with no swap file",
          rc == 0 and log["slept"] == [15, 15] and len(log["runs"]) == 1 and not log["swap"] and "waiting for memory" in log["said"][0], (log["slept"], log["said"][:2]))
    swapped = dict(short, swap_total_mb=2048, swap_free_mb=2048)
    rc, log = go([short] * 5 + [swapped], [0])
    check("buildfit run: still short after the wait, on a machine with no swap and disk to spare: a temporary swap file, said in the log; the step runs "
          "tight; the file is removed after", rc == 0 and log["swap"][0][0] == "on" and log["swap"][-1] == ("off",) and log["runs"][0]["BUILD_CPUS"] == "1"
          and sum(log["slept"]) == 60, (log["swap"], log["slept"]))
    tiny = box(2, 2, avail_frac=0.85)
    rc, log = go([tiny, dict(tiny, swap_total_mb=3072, swap_free_mb=3072)], [0])
    check("buildfit run: a machine too small for the step whatever leaves (2 GB for eve): no wait at all, straight to the swap file",
          rc == 0 and not log["slept"] and log["swap"][0][0] == "on" and any("waiting would not help" in l for l in log["said"]), (log["slept"], log["said"][:2]))
    rc, log = go([short] * 6, [0])
    check("buildfit run: and if even that is short: CAPACITY_RC, nothing run, a BUILD_SHORT line with the measured numbers, the swap file removed",
          rc == BF.CAPACITY_RC and not log["runs"] and log["said"][-1].startswith("BUILD_SHORT step=eve") and "avail_mb=" in log["said"][-1] and log["swap"][-1] == ("off",), log["said"][-2:])
    rc, log = go([dict(short, swap_total_mb=1024, swap_free_mb=0)] * 6, [0])
    check("buildfit run:   ...a machine whose own swap is used up gets the temporary file too (mold_v1-247), removed after",
          rc == BF.CAPACITY_RC and log["swap"][0][0] == "on" and log["swap"][-1] == ("off",), log["swap"])
    rc, log = go([dict(short, disk_free_mb=3000)] * 6, [0])
    check("buildfit run:   ...nor one without the disk to spare", rc == BF.CAPACITY_RC and not log["swap"])
    rc, log = go([roomy], [137, 0], kills_seq=[3, 4, 4, 4])
    check("buildfit run: killed by the kernel (exit 137): once more, tight: one worker, two native threads at most, and it finishes",
          rc == 0 and len(log["runs"]) == 2 and log["runs"][0]["BUILD_CPUS"] != "1" and log["runs"][1]["BUILD_CPUS"] == "1" and int(log["runs"][1]["RAYON_NUM_THREADS"]) <= 2
          and any("not a fault of the app" in l for l in log["said"]), [r["BUILD_CPUS"] for r in log["runs"]])
    rc, log = go([roomy], [1, 0], kills_seq=[7, 8, 8, 8])
    check("buildfit run:   ...a failure while the kernel's OOM count rose counts as a kill too (npm says only `exit 1`)", rc == 0 and len(log["runs"]) == 2)
    rc, log = go([roomy], [134, 0], tails=["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", ""])
    h1, h2 = (int(r["NODE_OPTIONS"].split("=")[1]) for r in log["runs"])
    check("buildfit run: out of V8's own heap: once more with a bigger heap (never a smaller one)", rc == 0 and h2 > h1, (h1, h2))
    rc, log = go([roomy], [137, 137])
    check("buildfit run: killed again, tight: CAPACITY_RC and BUILD_SHORT ... killed=1, not the build's own exit", rc == BF.CAPACITY_RC and log["said"][-1].endswith("killed=1"), log["said"][-1])
    rc, log = go([roomy], [2])
    check("buildfit run: an ordinary failure is the build's own: its exit code, run once, no retry", rc == 2 and len(log["runs"]) == 1)
    honest(check, tmp, go, roomy)
    short_line = BF.short_line("web", box(4, 2, avail_frac=0.3), True)
    parsed = BF.parse_short("noise\n" + short_line + "\n")
    words = BF.short_words(parsed)
    check("buildfit: the BUILD_SHORT line reads back, and says the numbers in a sentence", parsed["step"] == "web" and parsed["cpus"] == 2 and "MB of memory available" in words
          and "2500 MB as usual" in words, words)
    check("buildfit: a self-test's light jobs at once: never more than the idle CPUs or the memory allow, at least one",
          (BF.fit_workers(150, facts=box(8, 4)), BF.fit_workers(150, facts=box(8, 4, load=3.9)), BF.fit_workers(150, facts=box(2, 4, avail_frac=0.1))) == (4, 1, 1))
    # ---- the server: build.sh runs every heavy step through build-run, one after another ----
    S = B._settings(); crons = V.read_crons(B.MOLD)
    sh = V.build_sh(S, crons)
    steps = re.findall(r'\$RUN_(API|WEB|WF) "[^"]+" --step ([a-z-]+) -- (npm [^\n]+)', sh)
    check("build.sh: each heavy step goes through build-run with its own step: the install, eve, web, the workflow install and build, in that order",
          [(k, st) for k, st, _ in steps] == [("API", "npm-ci"), ("API", "eve"), ("WEB", "web"), ("WF", "npm-ci"), ("WF", "workflow")]
          and all(f'build-run --serving {S["app_dir"]} --file' in l for l in sh.splitlines() if l.startswith("RUN_")) and "env-run" not in sh.split("set -eu")[1], steps)
    check("build.sh:   ...and nothing runs two at once (no `&`, no `wait`), under set -e so a capacity exit stops it",
          not re.search(r"&\s*$|\bwait\b", sh, re.M) and "set -eu" in sh and str(BF.CAPACITY_RC) in sh)
    got = {}
    rc = V.build_run(["build-run", "--serving", tmp, "--file", "/etc/x/web.env", "--user", "sfbuild", "--home", "/var/lib/sfbuild", "--cwd", "/opt/a/releases/r",
                      "--step", "web", "--", "npm", "run", "build"], fit=lambda step, inner, **k: got.update(step=step, inner=inner, **k) or 0)
    check("build-run: the step, sized, with env-run inside it (the build user and the service's env file), knowing a release serves",
          rc == 0 and got["step"] == "web" and got["serving"] is True and got["inner"][2:4] == ["env-run", "--file"] and got["inner"][-4:] == ["--", "npm", "run", "build"]
          and "sfbuild" in got["inner"], got)
    V.build_run(["build-run", "--serving", os.path.join(tmp, "nothing-serves"), "--file", "f", "--user", "u", "--home", "h", "--cwd", "c", "--step", "nonsense", "--", "x"],
                fit=lambda step, inner, **k: got.update(step=step, **k) or 0)
    check("build-run:   ...a first deploy (no current) keeps only the machine's headroom; an unknown step is sized as a generic build", got["serving"] is False and got["step"] == "generic")
    if os.getuid() == 0:
        env_file = os.path.join(tmp, "build.env"); open(env_file, "w").write('NODE_OPTIONS="--enable-source-maps"\nFROM_FILE="1"\n'); os.chmod(env_file, 0o600)
        r = subprocess.run([sys.executable, TOOL, "env-run", "--file", env_file, "--user", "root", "--home", tmp, "--cwd", tmp, "--", "env"],
                           env={"PATH": os.environ.get("PATH", ""), "NODE_OPTIONS": "--max-old-space-size=1234", "BUILD_CPUS": "1", "SECRET_ELSEWHERE": "x"},
                           capture_output=True, text=True)
        envs = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        check("env-run: the sizing from build-run reaches the build (NODE_OPTIONS merged with the file's), nothing else of the caller's does",
              envs.get("NODE_OPTIONS") == "--enable-source-maps --max-old-space-size=1234" and envs.get("BUILD_CPUS") == "1" and envs.get("FROM_FILE") == "1"
              and "SECRET_ELSEWHERE" not in envs, {k: envs.get(k) for k in ("NODE_OPTIONS", "BUILD_CPUS", "FROM_FILE", "SECRET_ELSEWHERE")})
    # ---- the factory: a capacity exit is the request for a bigger server, nothing switched ----
    ev = "EVIDENCE " + json.dumps({"protected": 58})
    line = BF.short_line("eve", box(8, 4, avail_frac=0.2, load=3.5), True)
    log = []
    def runner(st, stdin=None):
        log.append(st["id"])
        if st["id"] == "build": return CP(st["argv"], BF.CAPACITY_RC, "build: ...\nbuildfit: eve cannot run on this machine now\n" + line + "\n", "")
        out = {"qualify": B.fx("qualify-ok.txt"), "env-names": "\n".join(V.operator_names(S)), "db-chain": ev, "health": B.fx("health-ok.txt"), "switch": B.SWITCHED}.get(st["id"], "ok")
        return CP(st["argv"], 0, out, "")
    import agent_result
    agent_result.reset() if hasattr(agent_result, "reset") else agent_result.NOTES.update({"needs": []})
    try: res = V.deploy(S, B.MOLD, crons, runner=runner, resolver=lambda d: ["203.0.113.10"], read_health=lambda u: ("200", B.HEALTH_DOC, ""), say=lambda *_: None,
                        bundle_dir=os.path.join(tmp, "factory-deploy-buildshort"), wait=lambda s: None, release=D_, rehearse=B.NO_REHEARSAL)
    except V.Stop as e: res = e
    text = str(res)
    check("deploy: a build the server cannot fit stops at the build, before the database, the prewarm and the switch, and says nothing was switched",
          isinstance(res, V.Stop) and log[-1] == "build" and "switch" not in log and "db-chain" not in log and "Nothing was switched" in text, (log[-3:], text[:200]))
    check("deploy:   ...naming what build-run measured there, in words", "MB of memory available" in text and "agent API's build" in text, text[:400])
    check("deploy:   ...and asking for the bigger server the capacity check would (one plan, its price, the resize clicks), as an approval only the operator gives",
          "Resize" in text and "16 GB memory" in text and "--capacity" in text and any(n["kind"] == "approval" and "bigger" in n["name"] for n in agent_result.NOTES["needs"]),
          (text[-600:], agent_result.NOTES["needs"]))
    agent_result.NOTES.update({"needs": []})

def buildfit_alone():
    """buildfit.py --self-test: this section only, offline."""
    import tempfile
    fails, n = [], [0]
    def check(name, cond, detail=""):
        n[0] += 1
        if not cond: fails.append(f"{name}{': ' + str(detail)[:400] if detail != '' else ''}")
    tmp = tempfile.mkdtemp(prefix="buildfit-selftest-")
    try:
        with B.Offline(): buildfit(check, tmp)
    finally: shutil.rmtree(tmp, ignore_errors=True)
    if fails: print("buildfit self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"buildfit self-test ok: {n[0]} checks (sizing for 2/4/8 GB, 1-4 CPUs, idle and busy; cgroup limits; the wait, the swap file, "
          "the retry and the capacity exit; a killed child or a missing product is a failure, its output shown; the need sized to the app's subagents and "
          "its measured peak; one heavy build at a time; swap when the need is above the memory; build.sh, build-run, env-run; deploy's request for a "
          "bigger server). Offline, nothing on this machine changed")
    return 0
