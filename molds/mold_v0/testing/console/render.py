#!/usr/bin/env python3
"""The lane console: an application's own console, built from its lane copy and served on this machine only.

  render.py <app_id> --codebase <lane copy> [options] -- <harness.mjs> [harness args]
  render.py <app_id> --codebase <lane copy> [options] --suite a11y,layout,targets,shots,<harness.mjs> [-- <its args>]
      build the console (or reuse a cached build of the same inputs), then run the harness(es) inside ONE lane world
      (world.mts): the lane copy's API on an embedded throwaway database behind the shell's own mock Clerk, one
      workspace whose owner is also platform staff, and the console (`next start`) pointed at that API. Everything
      listens on 127.0.0.1; nothing deployed is contacted, and the harness refuses any other address (world.mts).
  render.py <app_id> --codebase <lane copy> --pages auto --plan     print the pages a change selects, and why; no browser
  render.py --self-test

OPTIONS
  --suite <items>      comma-separated, run in this order in one world (one build, one database, one `next start`):
                         a11y      accessibility/a11y.mjs                    (the accessibility lane's axe.console)
                         layout    responsiveness/responsive.mjs --only layout   (layout.viewports)
                         targets   responsiveness/responsive.mjs --only targets  (tap.targets)
                         viewports responsiveness/responsive.mjs (layout and targets)
                         shots     console/shots.mjs: a full-page screenshot per page at 390 and 1280 px (--shots-dir)
                         <path>    any harness exporting run(ctx); it gets the arguments after `--`
                       the exit code is the worst of them; each prints its own tables under a `== suite: <item>` heading
  --pages all          every page the build serves (the default; what the lanes run, and the end-of-train sweep)
  --pages auto         the pages the change can reach (git diff of the repository holding --codebase against --base, plus
                       --changed paths), plus the landing page and the admin home as a smoke; see pages.py for the
                       mapping. Prints each chosen page with why.
  --pages /a,/b        exactly those pages (and the smoke)
  --base <ref>         what --pages auto diffs against (default origin/main, else HEAD)
  --changed <path>     a changed path the diff cannot see (a git-ignored pack: packs/<id>/pack.json); repeatable
  --shots-dir <dir>    where `shots` writes (default reports/lane-shots/<app_id>/ under the factory root)
  --no-cache           build afresh in build/<app_id>.lane-console/ and leave the shared cache alone
  --plan               print the build key (hit or miss) and the chosen pages, then stop: no build, no browser

THE CACHE (cache.py): a build is kept under a hash of every input that can change it (the console's files, the packs
and the profile it was generated from, the installed packages, node, the build environment, the stand-in) in
$LANE_CACHE_DIR (default ~/.cache/software-factory/lane-console), at most $LANE_CACHE_MAX (6) builds, least recently used
removed first. Same inputs: no `next build`, the run serves a private copy of the build with its API port patched in.
Any different input: a rebuild. Shared by every clone on the machine, never across different packs.

WHY A STAND-IN FOR @clerk/nextjs. The console signs people in with Clerk, whose browser client must reach Clerk's own
servers with the application's real keys: a copy served on this machine cannot sign anyone in. The API side already has
an offline Clerk (the shell's scripts/lib/mock-providers.ts, which its own tests use), so the lane world signs a session
with it, and the console copy built here resolves `@clerk/nextjs` to console/clerk-standin/, which reads that session
cookie instead of loading Clerk. The API verifies the token on every call as it does in production. Only the build
here carries the stand-in: build/<app_id>.lane/ (what the other lanes grade) and every deploy keep the real package.

The copy: <lane copy>/web without node_modules and .next, and a node_modules folder of links to the lane copy's installed
packages (never written) with @clerk/nextjs the stand-in. Standard library only.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cache, pages as pagesel  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
TESTING = os.path.dirname(HERE)
STANDIN = os.path.join(HERE, "clerk-standin")
BUILD_S, WORLD_S = 1200, 1500   # the lane check allows 3000s: a build, then the world with its own deadline
KEEP_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER")
SUITE = {
    "a11y": (os.path.join(TESTING, "accessibility", "a11y.mjs"), []),
    "layout": (os.path.join(TESTING, "responsiveness", "responsive.mjs"), ["--only", "layout"]),
    "targets": (os.path.join(TESTING, "responsiveness", "responsive.mjs"), ["--only", "targets"]),
    "viewports": (os.path.join(TESTING, "responsiveness", "responsive.mjs"), []),
    "shots": (os.path.join(HERE, "shots.mjs"), []),
}


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def port_free(p):
    s = socket.socket()
    try: s.bind(("127.0.0.1", p)); return True
    except OSError: return False
    finally: s.close()


def link_modules(src_nm, dst_nm):
    """dst_nm: a folder of links to src_nm's packages, @clerk/nextjs replaced by the stand-in (copied, so the bundler
    resolves its own imports - next, react - through this folder)."""
    os.makedirs(dst_nm)
    for e in sorted(os.listdir(src_nm)):
        if e == "@clerk":
            os.makedirs(os.path.join(dst_nm, e))
            for s in sorted(os.listdir(os.path.join(src_nm, e))):
                if s != "nextjs": os.symlink(os.path.join(src_nm, e, s), os.path.join(dst_nm, e, s))
            shutil.copytree(STANDIN, os.path.join(dst_nm, e, "nextjs"))
            real_types = os.path.join(src_nm, e, "nextjs", "dist", "types")
            if os.path.isdir(real_types): os.symlink(real_types, os.path.join(dst_nm, e, "nextjs", "types"))
        else:
            os.symlink(os.path.join(src_nm, e), os.path.join(dst_nm, e))


def build_env(port):
    # An allow-listed environment: nothing of the operator's shell (an app address, a key) is baked into the build.
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV}
    # The console's sign-in is fixed at build time (mold_v0-004: web/next.config.ts, AUTH_PROVIDER). The lane world signs
    # its person in with the shell's offline Clerk and this build carries the Clerk stand-in, so the console is built for
    # Clerk; left to its default (built-in sign-in) it would ask the API for a built-in session the world never issues.
    env.update(NODE_ENV="production", NEXT_TELEMETRY_DISABLED="1", APP_API_URL=f"http://127.0.0.1:{port}",
               NEXT_PUBLIC_AUTH_PROVIDER="clerk")
    return env


def next_build(web_dir, port, say):
    t0 = time.time()
    r = subprocess.run(["node", "node_modules/next/dist/bin/next", "build", "--webpack"], cwd=web_dir, env=build_env(port),
                       capture_output=True, text=True, timeout=BUILD_S)
    if r.returncode:
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-40:])
        raise SystemExit(f"lane console: next build failed (exit {r.returncode}); this is the app's console failing to build:\n{tail}")
    say(f"lane console: built in {time.time() - t0:.0f}s")
    return time.time() - t0


def sources(codebase):
    web = os.path.join(os.path.abspath(codebase), "web")
    if not os.path.isdir(web): raise SystemExit(f"{codebase} has no web/ console to serve.")
    nm = os.path.realpath(os.path.join(web, "node_modules"))
    if not os.path.isdir(os.path.join(nm, "next")):
        raise SystemExit(f"{web}/node_modules has no Next.js: install the console's dependencies (npm --prefix molds/mold_v0/codebase/web install --no-package-lock).")
    return web, nm


def build_key(codebase):
    web, nm = sources(codebase)
    inp = cache.inputs(os.path.abspath(codebase), web, nm, STANDIN, build_env(0))
    return cache.key(inp), inp


def prepare(app_id, codebase, say=print, no_cache=False):
    """Returns (console web dir, api port, cleanup): a build of the lane copy's console, from the cache when one of the
    same inputs is there, else built (and cached)."""
    web, nm = sources(codebase)
    if no_cache:
        out = os.path.join(ROOT, "build", f"{app_id}.lane-console")
        if os.path.isdir(out): shutil.rmtree(out)
        shutil.copytree(web, os.path.join(out, "web"), ignore=lambda d, names: cache.skipped(names))   # never an .env file
        link_modules(nm, os.path.join(out, "web", "node_modules"))
        port = free_port()
        say(f"lane console: --no-cache: next build of build/{app_id}.lane-console/web (the API at 127.0.0.1:{port})")
        next_build(os.path.join(out, "web"), port, say)
        return os.path.join(out, "web"), port, lambda: None
    root = cache.root()
    k, inp = build_key(codebase)
    with cache.lock(os.path.join(root, "locks", f"{k}.lock")):
        meta = cache.lookup(root, k)
        if meta:
            say(f"lane console: cache hit {k} (built {time.strftime('%Y-%m-%d %H:%M', time.localtime(meta.get('built_at', 0)))} "
                f"from {meta.get('from', '?')}, in {meta.get('build_s', 0):.0f}s; used {meta.get('uses', 0)} times): no next build")
        else:
            with cache.lock(os.path.join(root, "locks", "build.lock")):
                work = os.path.join(root, "work", "web")
                keep = os.path.join(work, ".next", "cache")
                held = os.path.join(root, "work", "next-cache")
                shutil.rmtree(held, ignore_errors=True)
                if os.path.isdir(keep): os.rename(keep, held)
                shutil.rmtree(work, ignore_errors=True)
                cache.fresh_copy(web, work)
                if os.path.isdir(held): os.makedirs(os.path.join(work, ".next")); os.rename(held, keep)
                link_modules(nm, os.path.join(work, "node_modules"))
                port0 = free_port()
                say(f"lane console: cache miss {k}: next build of {os.path.relpath(web, ROOT) if web.startswith(ROOT) else web} "
                    f"({'incremental: the bundler cache of the previous build is kept' if os.path.isdir(keep) else 'from scratch'})")
                secs = next_build(work, port0, say)
                cache.store(root, k, work, {"inputs": inp, "api_port": port0, "built_at": time.time(), "build_s": secs,
                                            "from": os.path.relpath(web, ROOT) if web.startswith(ROOT) else web})
                meta = cache.lookup(root, k)
        cache.touch(root, k)
        run = cache.run_copy(root, k)
    cache.evict(root, cache.keep_max(), protect={k}, say=say)
    run_web = os.path.join(run, "web")
    link_modules(nm, os.path.join(run_web, "node_modules"))
    port = free_port()
    if not cache.patch_port(os.path.join(run_web, ".next"), meta["api_port"], port):
        shutil.rmtree(run, ignore_errors=True)
        say("lane console: the cached build does not carry its API address where expected: building afresh (--no-cache)")
        return prepare(app_id, codebase, say, no_cache=True)
    return run_web, port, lambda: shutil.rmtree(run, ignore_errors=True)


# ---- pages ---------------------------------------------------------------------------------------------------------

def surface(codebase):
    """The build's pages and packs (surface.mts, read-only), as the world will see them."""
    tsx = os.path.join(os.path.abspath(codebase), "node_modules", ".bin", "tsx")
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV}
    r = subprocess.run([tsx, os.path.join(HERE, "surface.mts"), os.path.abspath(codebase)], cwd=os.path.abspath(codebase),
                       env=env, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"--pages: could not read the build's pages (surface.mts):\n{r.stderr[-2000:]}")
    return json.loads(r.stdout)


def choose_pages(mode, codebase, base, extra, say=print):
    """None for every page, else [{path, reasons}] (printed)."""
    if mode in (None, "all"): return None
    s = surface(codebase)
    if mode == "auto":
        repo = os.path.abspath(codebase)
        if base is None:
            base = "origin/main" if pagesel.git(repo, "rev-parse", "--verify", "--quiet", "origin/main") else "HEAD"
        top, mb, changed = pagesel.changed_files(repo, base)
        changed = sorted(set(changed) | set(extra))
        say(f"pages auto: {len(changed)} changed file(s) in {top} since {base} ({mb[:12]})")
        chosen, notes, rules = pagesel.plan(changed, s["pages"], s["packs"], pagesel.importers_in(os.path.abspath(codebase)))
        for path, r in zip(changed, rules): say(f"  {path}: {r[-1] if r[0] != 'none' else 'no page (' + r[-1] + ')'}")
    else:
        want = [p.strip() for p in mode.split(",") if p.strip()]
        rules = [("route", w, True, f"named ({w})") for w in want]
        chosen, notes = pagesel.select(rules, s["pages"], s["packs"])
    for n in notes: say(f"  note: {n}")
    total = len({p["path"] for p in s["pages"]})
    say(f"pages {mode}: {len(chosen)} of {total} pages")
    for path, why in chosen.items(): say(f"  {path}  <- {'; '.join(dict.fromkeys(why))}")
    return [{"path": p, "reasons": w} for p, w in chosen.items()]


def suite_items(spec, rest, shots_dir):
    items = []
    for name in [x.strip() for x in spec.split(",") if x.strip()]:
        if name in SUITE:
            h, argv = SUITE[name]
            if name == "shots": argv = ["--dir", shots_dir]
            items.append({"name": name, "harness": h, "argv": argv})
        elif os.path.exists(name):
            items.append({"name": os.path.basename(name), "harness": os.path.abspath(name), "argv": rest})
        else:
            raise SystemExit(f"--suite: {name!r} is neither one of {', '.join(SUITE)} nor a harness file.")
    return items


def opt(a, k, default=None):
    return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else default


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    head, rest = (a[:a.index("--")], a[a.index("--") + 1:]) if "--" in a else (a, [])
    if len(head) < 3 or "--codebase" not in head or not (rest or "--suite" in head or "--plan" in head): sys.exit(__doc__)
    app_id, codebase = head[0], opt(head, "--codebase")
    changed = [head[i + 1] for i, x in enumerate(head) if x == "--changed" and i + 1 < len(head)]
    chosen = choose_pages(opt(head, "--pages", "all"), codebase, opt(head, "--base"), changed)
    if "--plan" in head:
        k, inp = build_key(codebase)
        hit = cache.lookup(cache.root(), k)
        print(f"lane console: build key {k}: {'cached (no next build)' if hit else 'not cached (a next build)'} in {cache.root()}")
        print(json.dumps({n: (v if n in ('env', 'packs', 'recipe', 'node') else str(v)[:16]) for n, v in inp.items()}, indent=1))
        return 0
    if "--suite" in head:
        shots_dir = os.path.abspath(opt(head, "--shots-dir", os.path.join(ROOT, "reports", "lane-shots", app_id)))
        items = suite_items(opt(head, "--suite"), rest, shots_dir)
    else:
        items = [{"name": os.path.basename(rest[0]), "harness": os.path.abspath(rest[0]), "argv": rest[1:]}]
    t0 = time.time()
    web, port, cleanup = prepare(app_id, codebase, no_cache="--no-cache" in head)
    print(f"lane console: ready in {time.time() - t0:.0f}s")
    tmp = tempfile.mkdtemp(prefix="lane-suite-")
    try:
        suite_f = os.path.join(tmp, "suite.json")
        json.dump(items, open(suite_f, "w"))
        tsx = os.path.join(os.path.abspath(codebase), "node_modules", ".bin", "tsx")
        cmd = [tsx, os.path.join(HERE, "world.mts"), "--codebase", os.path.abspath(codebase), "--console", web,
               "--api-port", str(port), "--deadline", str(WORLD_S * len(items)), "--suite", suite_f]
        if chosen is not None:
            pages_f = os.path.join(tmp, "pages.json")
            json.dump(chosen, open(pages_f, "w"))
            cmd += ["--pages", pages_f]
        sys.stdout.flush()
        t1 = time.time()
        code = subprocess.run(cmd, cwd=os.path.abspath(codebase)).returncode
        print(f"lane console: world and harnesses took {time.time() - t1:.0f}s ({time.time() - t0:.0f}s in all)")
        return code
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        cleanup()


def self_test():
    import unittest
    ok = []
    t = tempfile.mkdtemp(prefix="render-selftest-")
    try:
        src = os.path.join(t, "nm"); os.makedirs(os.path.join(src, "@clerk", "nextjs")); os.makedirs(os.path.join(src, "@clerk", "themes"))
        os.makedirs(os.path.join(src, "next")); os.makedirs(os.path.join(src, ".bin"))
        dst = os.path.join(t, "out")
        link_modules(src, dst)
        ok.append(os.path.islink(os.path.join(dst, "next")) and os.path.realpath(os.path.join(dst, "next")) == os.path.join(src, "next"))
        ok.append(os.path.islink(os.path.join(dst, "@clerk", "themes")) and not os.path.islink(os.path.join(dst, "@clerk", "nextjs")))
        ok.append(json.load(open(os.path.join(dst, "@clerk", "nextjs", "package.json")))["version"].endswith("lane-standin"))
        ok.append(not os.listdir(os.path.join(src, "@clerk", "nextjs")))   # the real package folder is never written
        p = free_port(); ok.append(port_free(p))
    finally:
        shutil.rmtree(t, ignore_errors=True)
    if not all(ok): print(f"render: self-test failed: {ok}"); return 1
    print(f"render: {len(ok)} checks passed (links, the stand-in in place of @clerk/nextjs only, the real package untouched)")
    # The cache key and the page selection (test_render.py): no browser, no build.
    r = unittest.TextTestRunner(verbosity=0, stream=sys.stdout).run(unittest.defaultTestLoader.discover(HERE, pattern="test_render.py"))
    return 0 if r.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
