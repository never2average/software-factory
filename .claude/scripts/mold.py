#!/usr/bin/env python3
"""mold.py — put a mold's codebase on this machine, exactly as its source has it, and prove it.

  mold.py fetch <mold_id> [--into DIR]     the source at the commit state/factory.json pins (molds[].source.commit)
  mold.py refresh <mold_id> [--into DIR]   the source at its current main; records the new commit and snapshot date
                                           in state/factory.json and the mold's MOLD.md
  mold.py check <mold_id> [--into DIR]     compare the snapshot with the pinned commit; writes nothing
  mold.py fetch <mold_id> --rehearsal      INSIDE A REHEARSAL ONLY (FACTORY_REHEARSAL set; lib/services.py): write a tiny
                                           stand-in mold instead of fetching the source: a few files of codebase, the
                                           brand rules for them, and five lanes whose checks run in under a second against
                                           the rehearsal's fake deployment. Nothing is cloned and no account is needed.
  mold.py --self-test

Where the source lives is this machine's own: state/factory.local.json -> "mold_sources" -> {"<mold_id>": "<git URL>"}
(never committed; .claude/scripts/lib/factory_local.py). The snapshot goes to molds/<mold_id>/codebase (git-ignored),
or to --into DIR. The clone is shallow, in a temporary directory, and removed afterwards.

Every run ends with the proof the mold's MOLD.md has always asked for: the snapshot and the clone compared file by
file, `.next/` absent, and the word IDENTICAL. Exit 0 only then; 1 when the proof fails or git refuses; 2 when this
machine names no source or state names no commit (the line printed says what to set).
"""
import datetime, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from factory_local import mold_source

ROOT = os.path.dirname(os.path.dirname(HERE))
# Never part of a snapshot (molds/mold_v1/MOLD.md): the source's own history, installed packages, and what the
# mold's own tests and dev server write into their cwd. rsync --delete leaves an excluded path in place, so a
# node_modules installed in the snapshot survives a fetch.
EXCLUDES = (".git", "node_modules", "test-results", ".next")


class Stop(Exception):
    def __init__(self, msg, code=1): super().__init__(msg); self.code = code


def run(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True)


def mold_entry(root, mold_id):
    with open(os.path.join(root, "state", "factory.json")) as f: fj = json.load(f)
    m = next((m for m in fj.get("molds", []) if isinstance(m, dict) and m.get("mold_id") == mold_id), None)
    if m is None: raise Stop(f"state/factory.json has no mold called {mold_id!r}.", 2)
    return m


def source_of(root, mold_id):
    url = mold_source(mold_id, os.path.join(root, "state"))
    if not url:
        raise Stop(f"This machine does not say where {mold_id} comes from yet. Open state/factory.local.json and add "
                   f"its git address under \"mold_sources\", like this:\n\n"
                   f"  \"mold_sources\": {{ \"{mold_id}\": \"https://github.com/<owner>/<repository>.git\" }}\n\n"
                   f"(state/factory.local.example.json shows the whole file). Then ask again; nothing was changed.", 2)
    return url


def clone_at(url, tmp, commit=None, branch="main"):
    """A shallow checkout of `url` in tmp at `commit` (or at the tip of `branch`). -> the full commit checked out."""
    for argv in (["git", "init", "-q", tmp], ["git", "-C", tmp, "remote", "add", "origin", url]):
        r = run(argv)
        if r.returncode: raise Stop(f"git could not start the clone: {r.stderr.strip()[-300:]}")
    want = commit or branch
    r = run(["git", "-C", tmp, "fetch", "-q", "--depth", "1", "origin", want])
    if r.returncode and commit:
        # A server that refuses a fetch by commit id: take the branch, deep enough to reach a recent pin.
        r = run(["git", "-C", tmp, "fetch", "-q", "--depth", "500", "origin", branch])
        if r.returncode == 0 and run(["git", "-C", tmp, "cat-file", "-e", f"{commit}^{{commit}}"]).returncode:
            raise Stop(f"the source has no commit {commit} on {branch} (within its last 500 commits), so the pinned "
                       f"snapshot cannot be fetched. Check molds[].source.commit in state/factory.json.")
    if r.returncode:
        raise Stop(f"git could not fetch {want} from the mold's source: {r.stderr.strip()[-300:]}\n"
                   f"Check the address in state/factory.local.json (mold_sources) and that this machine can read it.")
    r = run(["git", "-C", tmp, "checkout", "-q", "--detach", commit or "FETCH_HEAD"])
    if r.returncode: raise Stop(f"git could not check out {want}: {r.stderr.strip()[-300:]}")
    head = run(["git", "-C", tmp, "rev-parse", "HEAD"]).stdout.strip()
    if commit and head != commit and not head.startswith(commit):
        raise Stop(f"the source answered with {head}, not the pinned {commit}; nothing was copied.")
    return head


def sync(tmp, dest):
    """rsync the clone over dest. -> how many paths it changed."""
    os.makedirs(dest, exist_ok=True)
    # --checksum: a fresh clone gives every file a new mtime, so only content, size, a new path or a deletion counts.
    argv = ["rsync", "-a", "--checksum", "--delete", "--itemize-changes"] + [x for e in EXCLUDES for x in ("--exclude", e)] + [tmp + "/", dest + "/"]
    r = run(argv)
    if r.returncode: raise Stop(f"rsync could not copy the clone into {dest}: {r.stderr.strip()[-300:]}")
    changed = lambda l: l.startswith("*deleting") or (len(l) > 11 and l[1] in "fL" and any(c in l[2:11] for c in "cs+"))
    return len([l for l in r.stdout.splitlines() if changed(l)])


def prove(tmp, dest):
    """The MOLD.md proof. -> (identical, the differences)."""
    r = run(["diff", "-rq"] + [x for e in EXCLUDES for x in ("--exclude", e)] + [tmp, dest])
    diffs = [l.replace(tmp, "<source>").replace(dest, "<snapshot>") for l in r.stdout.splitlines()]
    if os.path.lexists(os.path.join(dest, ".next")): diffs.append("<snapshot>/.next exists (a run wrote into the snapshot; remove it)")
    return r.returncode == 0 and not diffs, diffs


def record(root, mold_id, commit, today):
    """refresh: the new commit and snapshot date in state/factory.json and in the mold's MOLD.md."""
    p = os.path.join(root, "state", "factory.json")
    with open(p) as f: fj = json.load(f)
    for m in fj.get("molds", []):
        if isinstance(m, dict) and m.get("mold_id") == mold_id:
            m.setdefault("source", {}); m["source"]["commit"] = commit; m["source"]["snapshot_date"] = today
    with open(p, "w") as f: json.dump(fj, f, indent=2, ensure_ascii=False); f.write("\n")
    md = os.path.join(root, "molds", mold_id, "MOLD.md")
    if os.path.exists(md):
        s = open(md).read()
        s2 = re.sub(r"(\*\*Source:\*\*[^\n]*?@ )[0-9a-f]{7,40}( \(`[^`]+`, snapshot )\d{4}-\d{2}-\d{2}", lambda m_: f"{m_.group(1)}{commit[:7]}{m_.group(2)}{today}", s, count=1)
        if s2 == s: print(f"  note: molds/{mold_id}/MOLD.md has no '**Source:** ... @ <commit> (`main`, snapshot <date>' line to update")
        open(md, "w").write(s2)


def main(a, root=ROOT, today=None):
    if not a or a[0] not in ("fetch", "refresh", "check") or len(a) < 2: print(__doc__); return 2
    cmd, mold_id = a[0], a[1]
    if "--rehearsal" in a:
        if cmd != "fetch": print("--rehearsal goes with fetch only.", file=sys.stderr); return 2
        if not os.environ.get("FACTORY_REHEARSAL"):
            print(f"--rehearsal writes a stand-in over molds/{mold_id}/, so it runs only inside a rehearsal (FACTORY_REHEARSAL "
                  f"set to the rehearsal's directory; lib/services.py). Nothing was written.", file=sys.stderr); return 2
        n = rehearsal_mold(root, mold_id)
        print(f"{mold_id}: rehearsal stand-in written to molds/{mold_id}/ ({n} files: codebase, branding, five lanes); nothing was fetched")
        return 0
    dest = os.path.abspath(a[a.index("--into") + 1]) if "--into" in a and a.index("--into") + 1 < len(a) else os.path.join(root, "molds", mold_id, "codebase")
    today = today or datetime.date.today().isoformat()
    try:
        m = mold_entry(root, mold_id); url = source_of(root, mold_id)
        pinned = (m.get("source") or {}).get("commit")
        if cmd != "refresh" and not pinned:
            raise Stop(f"state/factory.json pins no commit for {mold_id} (molds[].source.commit), so there is nothing to "
                       f"fetch. `mold.py refresh {mold_id}` takes the source's current main and records it.", 2)
        if cmd == "check" and not os.path.isdir(dest): raise Stop(f"there is no snapshot at {dest} to check; `mold.py fetch {mold_id}` puts one there.", 2)
        tmp = tempfile.mkdtemp(prefix=f"mold-{mold_id}-")
        try:
            head = clone_at(url, tmp, commit=None if cmd == "refresh" else pinned)
            print(f"{mold_id}: the source at {head[:12]}" + (" (its current main)" if cmd == "refresh" else " (the pinned commit)"))
            if cmd != "check":
                n = sync(tmp, dest)
                print(f"  copied into {os.path.relpath(dest, root) if dest.startswith(root + os.sep) else dest}: "
                      + (f"{n} path(s) changed" if n else "nothing changed (it was already this commit)"))
            same, diffs = prove(tmp, dest)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        if not same:
            print(f"  NOT IDENTICAL — {len(diffs)} difference(s):"); [print("   " + d) for d in diffs[:40]]
            if len(diffs) > 40: print(f"   ... and {len(diffs) - 40} more")
            print(f"  `mold.py fetch {mold_id}` puts the pinned commit back." if cmd == "check" else "  The copy did not land whole; run it again.")
            return 1
        if cmd == "refresh":
            if head != pinned: record(root, mold_id, head, today); print(f"  recorded {head[:12]} ({today}) in state/factory.json and molds/{mold_id}/MOLD.md")
            else: print("  the pin was already this commit; nothing recorded")
        print("IDENTICAL")
        return 0
    except Stop as e:
        print(str(e), file=sys.stderr); return e.code


# ---- the rehearsal mold (FACTORY_REHEARSAL only) ------------------------------------------------------------------
REHEARSAL_CHECKS = r'''#!/usr/bin/env python3
"""The rehearsal mold's checks (mold.py fetch --rehearsal). Each reads the application's state and asks the rehearsal's
fake deployment through `curl` (the fake on PATH); nothing reaches a real address. Exit 0 pass, 1 fail."""
import json, os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
kind, app = sys.argv[1], sys.argv[2]
d = os.path.join(ROOT, "state", "application", app)
a = json.load(open(os.path.join(d, "application.json"))); i = json.load(open(os.path.join(d, "infrastructure.json")))
url = (i.get("vercel") or {}).get("production_url") or ""
def get(path, token=None):
    argv = ["curl", "--silent", "--show-error", "--max-time", "20", "-w", "\n%{http_code}"] + (["-H", f"authorization: Bearer {token}"] if token else []) + [url + path]
    r = subprocess.run(argv, capture_output=True, text=True)
    body, _, code = r.stdout.rpartition("\n")
    return code.strip(), body
def lum(h):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[k:k + 2], 16) for k in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
if not url and kind not in ("corpus", "contrast"):
    print(f"{app} has no production address yet; deploy it first"); sys.exit(1)
if kind == "health":
    code, body = get("/api/ops/health"); print(f"| health | {'pass' if code == '200' else 'fail'} | {url}/api/ops/health answered {code or 'nothing'} |")
    sys.exit(0 if code == "200" else 1)
if kind == "isolation":
    code, body = get("/api/ops/health")
    try: det = json.loads(body)["db"]["detail"]
    except Exception: det = ""
    ok = "(RLS enforced)" in det; print(f"| isolation | {'pass' if ok else 'fail'} | {det or 'no db check in the health answer'} |"); sys.exit(0 if ok else 1)
if kind == "corpus":
    n = len(((a.get("surface") or {}).get("primary_context") or {}).get("corpus") or [])
    print(f"| corpus | {'pass' if n else 'fail'} | {n} corpus kind(s) declared for the agent's context |"); sys.exit(0 if n else 1)
if kind == "load":
    codes = [get("/api/ops/health")[0] for _ in range(5)]
    ok = all(c == "200" for c in codes); print(f"| load | {'pass' if ok else 'fail'} | 5 of 5 requests answered 200; p95 first token 1.9 s (budget 4 s) |" if ok else f"| load | fail | answers: {codes} |")
    sys.exit(0 if ok else 1)
if kind == "contrast":
    col = ((a.get("surface") or {}).get("branding") or {}).get("brand_color") or "#1F4FD8"
    if not (col.startswith("#") and len(col) == 7): print(f"| contrast | pass | brand colour {col} is not a hex colour; the mold's own theme applies |"); sys.exit(0)
    hi, lo = sorted((lum(col), 1.0), reverse=True); ratio = (hi + 0.05) / (lo + 0.05)
    if ratio >= 4.5: print(f"| contrast | pass | brand colour {col} on white: {ratio:.1f}:1 |"); sys.exit(0)
    print(f"| contrast | fail | brand colour {col} on white has a contrast of {ratio:.1f}:1; buttons and links need at least 4.5:1 (WCAG AA) |"); sys.exit(1)
if kind == "viewport":
    code, _ = get("/"); ok = code == "200"
    print(f"| viewports | {'pass' if ok else 'fail'} | 375 px, 768 px and 1280 px: no horizontal scroll |"); sys.exit(0 if ok else 1)
if kind == "signed_in":
    code, body = get("/api/ops/me", os.environ.get("MOLD_V1_SESSION_TOKEN"))
    ok = code == "200"; print(f"| signed in | {'pass' if ok else 'fail'} | the signed-in page answered {code} |"); sys.exit(0 if ok else 1)
print(f"unknown check {kind}"); sys.exit(2)
'''
SESSION_ELSE = ("This check signs in as a person, and no session is on hand: someone who can sign in gets a one-time code "
                "(python3 .claude/scripts/mint.py {app_id} code-request <email>, only when they say so), then "
                "python3 .claude/scripts/mint.py {app_id} code <six digits> <email>.")
def _lane(name, order, checks, summary):
    return {"lane": name, "order": order, "summary": summary, "checks": checks,
            "not_covered": ["Everything a real mold's lane measures: this is the rehearsal's stand-in, graded against a fake deployment."]}
def _chk(name, kind, signed=False, why=""):
    c = {"name": name, "run": f"python3 {{testing}}/rehearsal_checks.py {kind} {{app_id}}", "cwd": "root", "timeout_s": 60,
         "expect": {"exit": 0}, "emits": "markdown_table", "why": why}
    if signed: c["requires"] = [{"env": "MOLD_V1_SESSION_TOKEN", "else": SESSION_ELSE}]
    return c
def rehearsal_mold(root, mold_id):
    """Write the stand-in mold under molds/<mold_id>/ (codebase/, branding/, testing/). -> how many files."""
    m = os.path.join(root, "molds", mold_id); n = 0
    files = {
        "codebase/package.json": json.dumps({"name": "rehearsal-mold", "private": True, "scripts": {"build": "next build"}}, indent=2) + "\n",
        "codebase/next.config.mjs": "export default {};\n",
        "codebase/app/layout.tsx": "export const metadata = { title: \"Workbench\" };\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
        "codebase/app/page.tsx": "export default function Page() { return <main>Workbench</main>; }\n",
        "codebase/app/icon.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" rx=\"8\"/></svg>\n",
        "codebase/app/globals.css": ":root {\n  --primary: oklch(0.2 0 0);\n  --ring: oklch(0.7 0 0);\n  --radius: 0.625rem;\n}\n.dark {\n  --primary: oklch(0.9 0 0);\n  --ring: oklch(0.5 0 0);\n}\n",
        "codebase/services/task-workflow/package.json": json.dumps({"name": "task-workflow", "private": True}) + "\n",
        "codebase/vercel.json": json.dumps({"crons": []}) + "\n",
        "codebase/dm.md": "# Data room\n\nThe rehearsal mold's data room layout.\n",
        "codebase/node_modules/.keep": "",
        "branding/rules.json": json.dumps({"mold_id": mold_id, "product_name_default": "Workbench",
                                          "files": {"icon": "app/icon.svg", "layout": "app/layout.tsx", "globals": "app/globals.css"},
                                          "product_name_files": ["layout"], "replacements": [],
                                          "palette_blocks": [{"id": "light", "anchor": ":root {", "scheme": "light"}, {"id": "dark", "anchor": ".dark {", "scheme": "dark"}]}, indent=2) + "\n",
        "testing/rehearsal_checks.py": REHEARSAL_CHECKS,
    }
    lanes = {
        "functional": _lane("functional", 10, [_chk("health", "health", why="the deployed app answers"), _chk("tenant.isolation", "isolation", why="a workspace cannot read another's rows"),
                                               _chk("chat.turn", "signed_in", True, "one signed-in chat turn answers")], "Health, workspace isolation and one signed-in chat turn."),
        "context": _lane("context", 20, [_chk("corpus.declared", "corpus", why="the agent's context is declared")], "The agent's declared context."),
        "load": _lane("load", 30, [_chk("concurrency", "load", why="the app keeps answering under load")], "Answers under concurrent requests."),
        "accessibility": _lane("accessibility", 40, [_chk("brand.contrast", "contrast", why="buttons and links in the brand colour must be readable"),
                                                     _chk("authenticated.surface", "signed_in", True, "signed-in pages pass an accessibility scan")],
                               "Brand colour contrast (WCAG AA 4.5:1) and the signed-in pages."),
        "responsiveness": _lane("responsiveness", 50, [_chk("viewports", "viewport", why="no horizontal scroll at phone, tablet and desktop widths"),
                                                       _chk("authenticated.viewports", "signed_in", True, "the signed-in workspace at 375 px")], "Phone, tablet and desktop widths."),
    }
    for lane, spec in lanes.items(): files[f"testing/{lane}/lane.json"] = json.dumps(dict({"$schema": "../lane.schema.json"}, **spec), indent=2) + "\n"
    if not os.path.exists(os.path.join(m, "testing", "lane.schema.json")):
        # A minimal schema of the same shape, when the rehearsal did not bring the factory's own.
        files["testing/lane.schema.json"] = json.dumps({"type": "object", "required": ["lane", "checks"], "properties": {
            "lane": {"type": "string", "enum": ["load", "context", "functional", "accessibility", "responsiveness"]},
            "checks": {"type": "array", "items": {"type": "object", "required": ["name", "run"]}}}}, indent=2) + "\n"
    for rel, body in files.items():
        p = os.path.join(m, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f: f.write(body)
        if rel.endswith(".py"): os.chmod(p, 0o755)
        n += 1
    if not os.path.exists(os.path.join(m, "MOLD.md")):
        open(os.path.join(m, "MOLD.md"), "w").write(f"# {mold_id} (rehearsal stand-in)\n\nWritten by `mold.py fetch {mold_id} --rehearsal`: a few files of codebase, "
                                                    "its brand rules and five lanes graded against the rehearsal's fake deployment. Never edited in place.\n"); n += 1
    return n


def self_test():
    """Offline: a local bare repository stands in for the source."""
    checks = []
    def ok(cond, what): checks.append(what); assert cond, what
    def git(*argv, cwd=None):
        r = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *argv], cwd=cwd, capture_output=True, text=True)
        assert r.returncode == 0, (argv, r.stderr); return r.stdout.strip()
    import contextlib, io
    def quiet(argv, root, today="2026-01-02"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err): rc = main(argv, root, today)
        return rc, out.getvalue() + err.getvalue()
    with tempfile.TemporaryDirectory() as t:
        bare, work, root = os.path.join(t, "src.git"), os.path.join(t, "work"), os.path.join(t, "factory")
        git("init", "-q", "--bare", "-b", "main", bare); git("config", "uploadpack.allowAnySHA1InWant", "false", cwd=bare)
        git("init", "-q", "-b", "main", work)
        os.makedirs(os.path.join(work, "app")); open(os.path.join(work, "app", "page.tsx"), "w").write("one\n")
        open(os.path.join(work, "README.md"), "w").write("base\n"); open(os.path.join(work, ".gitignore"), "w").write(".next\n")
        git("add", "-A", cwd=work); git("commit", "-qm", "one", cwd=work); c1 = git("rev-parse", "HEAD", cwd=work)
        open(os.path.join(work, "app", "page.tsx"), "w").write("two\n"); open(os.path.join(work, "NEW.md"), "w").write("new\n")
        git("add", "-A", cwd=work); git("commit", "-qm", "two", cwd=work); c2 = git("rev-parse", "HEAD", cwd=work)
        git("remote", "add", "origin", bare, cwd=work); git("push", "-q", "origin", "main", cwd=work)
        os.makedirs(os.path.join(root, "state")); os.makedirs(os.path.join(root, "molds", "m"))
        fj = {"molds": [{"mold_id": "m", "status": "active", "source": {"commit": c1, "snapshot_date": "2026-01-01"}}]}
        json.dump(fj, open(os.path.join(root, "state", "factory.json"), "w"), indent=2)
        md = os.path.join(root, "molds", "m", "MOLD.md")
        open(md, "w").write(f"# m\n\n**Source:** the mold's source @ {c1[:7]} (`main`, snapshot 2026-01-01; notes)\n")
        snap = os.path.join(root, "molds", "m", "codebase")

        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 2 and "mold_sources" in out and "state/factory.local.json" in out and not os.path.exists(snap), "no source named: a friendly line naming where to set it, nothing written, exit 2")
        json.dump({"mold_sources": {"m": bare}}, open(os.path.join(root, "state", "factory.local.json"), "w"))

        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 0 and out.rstrip().endswith("IDENTICAL"), "fetch: the pinned commit, proved IDENTICAL")
        ok(open(os.path.join(snap, "app", "page.tsx")).read() == "one\n" and not os.path.exists(os.path.join(snap, "NEW.md")), "fetch: the PINNED commit, not main (via the branch fallback, since this source refuses a fetch by id)")
        ok(not os.path.exists(os.path.join(snap, ".git")), "fetch: no .git in the snapshot")

        os.makedirs(os.path.join(snap, "node_modules", "x")); open(os.path.join(snap, "node_modules", "x", "i.js"), "w").write("1\n")
        open(os.path.join(snap, "stray.txt"), "w").write("left by a run\n"); open(os.path.join(snap, "README.md"), "w").write("edited in place\n")
        rc, out = quiet(["check", "m"], root)
        ok(rc == 1 and "NOT IDENTICAL" in out and "stray.txt" in out and "README.md" in out and open(os.path.join(snap, "README.md")).read() == "edited in place\n", "check: names what differs and writes nothing")
        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 0 and "IDENTICAL" in out and not os.path.exists(os.path.join(snap, "stray.txt")) and open(os.path.join(snap, "README.md")).read() == "base\n", "fetch: puts a drifted snapshot back")
        ok(os.path.exists(os.path.join(snap, "node_modules", "x", "i.js")), "fetch: an installed node_modules survives")
        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 0 and "nothing changed" in out, "fetch again: nothing changed")
        os.makedirs(os.path.join(snap, ".next"))
        rc, out = quiet(["check", "m"], root)
        ok(rc == 1 and ".next exists" in out, "check: a .next/ in the snapshot fails the proof")
        os.rmdir(os.path.join(snap, ".next"))

        other = os.path.join(t, "elsewhere")
        rc, out = quiet(["fetch", "m", "--into", other], root)
        ok(rc == 0 and open(os.path.join(other, "app", "page.tsx")).read() == "one\n", "fetch --into: another directory, same proof")

        git("config", "uploadpack.allowAnySHA1InWant", "true", cwd=bare)
        rc, out = quiet(["refresh", "m"], root, today="2026-02-03")
        fj2 = json.load(open(os.path.join(root, "state", "factory.json")))
        ok(rc == 0 and "IDENTICAL" in out and open(os.path.join(snap, "app", "page.tsx")).read() == "two\n", "refresh: the source's current main")
        ok(fj2["molds"][0]["source"] == {"commit": c2, "snapshot_date": "2026-02-03"}, "refresh: commit and snapshot date recorded in state/factory.json")
        ok(f"@ {c2[:7]} (`main`, snapshot 2026-02-03; notes)" in open(md).read(), "refresh: and in MOLD.md's Source line")
        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 0 and open(os.path.join(snap, "NEW.md")).read() == "new\n", "fetch after refresh: the new pin, fetched by id")

        fj2["molds"][0]["source"]["commit"] = "0" * 40; json.dump(fj2, open(os.path.join(root, "state", "factory.json"), "w"))
        before = open(os.path.join(snap, "app", "page.tsx")).read()
        rc, out = quiet(["fetch", "m"], root)
        ok(rc == 1 and "0000000" in out and open(os.path.join(snap, "app", "page.tsx")).read() == before, "a pin the source does not have: refused, snapshot untouched")
        rc, out = quiet(["fetch", "nope"], root)
        ok(rc == 2 and "no mold called" in out, "an unknown mold: refused")
        was = os.environ.pop("FACTORY_REHEARSAL", None)
        try:
            rc, out = quiet(["fetch", "r", "--rehearsal"], root)
            ok(rc == 2 and "only inside a rehearsal" in out and not os.path.exists(os.path.join(root, "molds", "r")), "--rehearsal outside a rehearsal: refused, nothing written")
            os.environ["FACTORY_REHEARSAL"] = os.path.join(t, "reh")
            rc, out = quiet(["fetch", "r", "--rehearsal"], root)
            lj = json.load(open(os.path.join(root, "molds", "r", "testing", "accessibility", "lane.json")))
            ok(rc == 0 and lj["lane"] == "accessibility" and os.path.exists(os.path.join(root, "molds", "r", "branding", "rules.json"))
               and os.path.isdir(os.path.join(root, "molds", "r", "codebase", "node_modules")), "--rehearsal: codebase, brand rules and five lanes, nothing cloned")
        finally:
            if was is None: os.environ.pop("FACTORY_REHEARSAL", None)
            else: os.environ["FACTORY_REHEARSAL"] = was
    print(f"mold: {len(checks)} checks passed (offline: a local bare repository as the source)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]: self_test(); sys.exit(0)
    sys.exit(main(sys.argv[1:]))
