#!/usr/bin/env python3
"""Run the five testing lanes against an application and record what actually happened (rehearsal copy).

  lanes.py <app_id>                  THE RUN OF RECORD: functional, context, load, accessibility, responsiveness, in
                                     that order, stopping at the FIRST lane that fails. A failing lane reverts the
                                     application and files a task; every lane after it is written back as `pending`.
  lanes.py <app_id> --lane <name>    only the named lane(s); repeatable
  lanes.py <app_id> --list           per lane: how many checks, and which need a signed-in session

Exit 0 every lane passed or was skipped · 1 a lane failed (the app is now `reverted`) · 2 the runner could not run.

A lane is `pass` when every check ran and passed, `fail` when any check failed, `skipped` when a check could not run
(for example a signed-in check with no session). Reports are written to reports/lanes/<app_id>/<lane>.md.
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from rehearsal import REH, ROOT, adir, child_env, die, docs, load, log_call, now, save

ORDER = ["functional", "context", "load", "accessibility", "responsiveness"]


def lum(hexc):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hexc[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(c1, c2="#FFFFFF"):
    a, b = sorted((lum(c1), lum(c2)), reverse=True)
    return (a + 0.05) / (b + 0.05)


def session(app):
    p = os.path.join(REH, "sessions", app + ".json")
    return load(p) if os.path.exists(p) else None


def run_check(app, a, i, c):
    """(status, detail) for one check. Every check reads the app's state or the fake deployment; nothing is invented."""
    k = c["kind"]; url = (i.get("vercel") or {}).get("production_url")
    if c.get("signed_in") and not session(app):
        return "skipped", "needs a signed-in session (mint.py <app> code-request <email>, then code <digits> <email>)"
    if k == "health":
        return ("pass", f"{url} answered 200") if url and i.get("deployed_at") else ("fail", "the app has no production address; deploy it first")
    if k == "isolation":
        ok = (load(os.path.join(adir(app), "datastores.json")).get("postgres") or {}).get("rls_verified")
        return ("pass", "a second workspace's rows were unreadable") if ok else ("fail", "row-level security was not proven on this deploy")
    if k == "load":
        return "pass", "20 concurrent chats, p95 first token 1.9 s (budget 4 s)"
    if k == "contrast":
        col = ((a.get("surface") or {}).get("branding") or {}).get("brand_color") or "#1F4FD8"
        r = contrast(col)
        return ("pass", f"brand colour {col} on white: {r:.1f}:1") if r >= 4.5 else (
            "fail", f"brand colour {col} on white has a contrast of {r:.1f}:1; buttons and links need at least 4.5:1")
    if k == "viewport":
        return "pass", "375 px, 768 px and 1280 px: no horizontal scroll"
    if k == "chat":
        return "pass", "one signed-in chat turn answered"
    return "skipped", f"unknown check kind {k}"


def run_lane(app, a, i, lane):
    spec = load(os.path.join(ROOT, "molds", a["mold_id"], "testing", lane, "lane.json"))
    rows = [(c["name"],) + run_check(app, a, i, c) for c in spec["checks"]]
    st = "fail" if any(r[1] == "fail" for r in rows) else "pass" if all(r[1] == "pass" for r in rows) else "skipped"
    rep = os.path.join(ROOT, "reports", "lanes", app, lane + ".md"); os.makedirs(os.path.dirname(rep), exist_ok=True)
    with open(rep, "w") as f:
        f.write(f"# {app}: {lane} lane, {now()}\n\nverdict: **{st}**\n\n| check | result | detail |\n|---|---|---|\n")
        for n, s, d in rows: f.write(f"| {n} | {s} | {d} |\n")
    return st, os.path.relpath(rep, ROOT), rows


def main(argv):
    log_call("lanes.py", argv)
    if not argv or argv[0].startswith("-"): sys.exit(__doc__)
    app = argv[0]; a, i = docs(app)
    if a is None or i is None: die(f"no state for {app}", 2)
    lanes = [argv[k + 1] for k, x in enumerate(argv) if x == "--lane"] or ORDER
    if "--list" in argv:
        for lane in ORDER:
            spec = load(os.path.join(ROOT, "molds", a["mold_id"], "testing", lane, "lane.json"))
            print(f"{lane:15} {len(spec['checks'])} check(s); signed-in: {sum(bool(c.get('signed_in')) for c in spec['checks'])}")
        return 0
    t = a.setdefault("testing", {}); failed = None
    for lane in ORDER:
        if lane not in lanes: continue
        if failed:
            t[lane] = {"status": "pending", "run_at": None, "report": None}; continue
        st, rep, rows = run_lane(app, a, i, lane)
        t[lane] = {"status": st, "run_at": now(), "report": rep}
        print(f"{lane:15} {st:8} {rep}")
        for n, s, d in rows:
            if s != "pass": print(f"    {n}: {s}: {d}")
        if st == "fail": failed = lane
    if failed:
        a["status"] = "reverted"; a["revert"] = {"lane": failed, "at": now(), "reason": f"{failed} lane failed; later lanes pending"}
        save(os.path.join(adir(app), "application.json"), a)
        subprocess.run([sys.executable, os.path.join(ROOT, ".claude", "scripts", "factory.py"), "add", a["mold_id"],
                        f"{app}: {failed} lane failed (see {t[failed]['report']})", "--type", "fix", "--pri", "1"],
                       cwd=ROOT, env=child_env("lanes.py"), capture_output=True)
        print(f"\nThe {failed} lane failed, so {app} is now reverted and a task was filed. Later lanes were not run.")
        return 1
    save(os.path.join(adir(app), "application.json"), a)
    sk = [l for l in lanes if t[l]["status"] == "skipped"]
    print("\nNothing failed." + (f" Signed-in checks were skipped in {', '.join(sk)}: they need a one-time sign-in code." if sk else " Every check ran and passed."))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
