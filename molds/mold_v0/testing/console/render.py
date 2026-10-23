#!/usr/bin/env python3
"""The lane console: an application's own console, built from its lane copy and served on this machine only.

  render.py <app_id> --codebase <lane copy> -- <harness.mjs> [harness args]
      build build/<app_id>.lane-console/ (when its inputs changed), then run the harness inside the lane world
      (world.mts): the lane copy's API on an embedded throwaway database behind the shell's own mock Clerk, one
      workspace whose owner is also platform staff, and the console (`next start`) pointed at that API. Everything
      listens on 127.0.0.1; nothing deployed is contacted, and the harness refuses any other address (world.mts).
  render.py --self-test

WHY A STAND-IN FOR @clerk/nextjs. The console signs people in with Clerk, whose browser client must reach Clerk's own
servers with the application's real keys: a copy served on this machine cannot sign anyone in. The API side already has
an offline Clerk (the shell's scripts/lib/mock-providers.ts, which its own tests use), so the lane world signs a session
with it, and the console copy built here resolves `@clerk/nextjs` to console/clerk-standin/, which reads that session
cookie instead of loading Clerk. The API verifies the token on every call as it does in production. Only the build
here carries the stand-in: build/<app_id>.lane/ (what the other lanes grade) and every deploy keep the real package.

The copy: <lane copy>/web without node_modules and .next, and a node_modules folder of links to the lane copy's installed
packages (never written) with @clerk/nextjs the stand-in. `next build` bakes the API's address into the console's
rewrites, so the API's port is chosen here and recorded in build/<app_id>.lane-console/lane-console.json beside a hash of
every input; an unchanged copy with its port still free is reused (the accessibility and responsiveness lanes of one run
build once). Standard library only.
"""
import hashlib, json, os, shutil, socket, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
STANDIN = os.path.join(HERE, "clerk-standin")
SKIP = {"node_modules", ".next", ".turbo"}
BUILD_S, WORLD_S = 1200, 1500   # the lane check allows 3000s: a build, then the world with its own deadline
KEEP_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def port_free(p):
    s = socket.socket()
    try: s.bind(("127.0.0.1", p)); return True
    except OSError: return False
    finally: s.close()


def skipped(names): return [n for n in names if n in SKIP or n.startswith(".env")]


def digest(web):
    h = hashlib.sha256()
    # The installed packages it links are inputs too: a changed next or react must not reuse an old .next.
    for pkg in ("next", "react", "react-dom"):
        f = os.path.join(web, "node_modules", pkg, "package.json")
        if os.path.exists(f): h.update(f"{pkg}={json.load(open(f)).get('version')}".encode())
    for base in (web, STANDIN, os.path.join(HERE, "render.py")):
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP)
            for f in sorted(files):
                if f.startswith(".env"): continue
                p = os.path.join(d, f); h.update(os.path.relpath(p, base).encode())
                with open(p, "rb") as fh: h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()


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


def prepare(app_id, codebase, say=print):
    """Returns (console web dir, api port), building when an input changed or the recorded port is taken."""
    web = os.path.join(os.path.abspath(codebase), "web")
    if not os.path.isdir(web): raise SystemExit(f"{codebase} has no web/ console to serve.")
    nm = os.path.realpath(os.path.join(web, "node_modules"))
    if not os.path.isdir(os.path.join(nm, "next")):
        raise SystemExit(f"{web}/node_modules has no Next.js: install the console's dependencies (npm --prefix molds/mold_v0/codebase/web install --no-package-lock).")
    out = os.path.join(ROOT, "build", f"{app_id}.lane-console")
    meta_p = os.path.join(out, "lane-console.json")
    want = digest(web)
    try: meta = json.load(open(meta_p))
    except (OSError, ValueError): meta = {}
    built = os.path.join(out, "web", ".next", "BUILD_ID")
    if meta.get("hash") == want and os.path.exists(built) and port_free(meta.get("api_port", 0)):
        say(f"lane console: reusing build/{app_id}.lane-console/ (its inputs are unchanged)")
        return os.path.join(out, "web"), meta["api_port"]
    if os.path.isdir(out): shutil.rmtree(out)
    shutil.copytree(web, os.path.join(out, "web"), ignore=lambda d, names: skipped(names))   # never an .env file
    link_modules(nm, os.path.join(out, "web", "node_modules"))
    port = free_port()
    # An allow-listed environment: nothing of the operator's shell (an app address, a key) is baked into the build.
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV}
    # The console's sign-in is fixed at build time (mold_v0-004: web/next.config.ts, AUTH_PROVIDER). The lane world signs
    # its person in with the shell's offline Clerk and this build carries the Clerk stand-in, so the console is built for
    # Clerk; left to its default (built-in sign-in) it would ask the API for a built-in session the world never issues.
    env.update(NODE_ENV="production", NEXT_TELEMETRY_DISABLED="1", APP_API_URL=f"http://127.0.0.1:{port}",
               NEXT_PUBLIC_AUTH_PROVIDER="clerk")
    say(f"lane console: next build of build/{app_id}.lane-console/web (the API at 127.0.0.1:{port})")
    r = subprocess.run(["node", "node_modules/next/dist/bin/next", "build", "--webpack"], cwd=os.path.join(out, "web"), env=env,
                       capture_output=True, text=True, timeout=BUILD_S)
    if r.returncode:
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-40:])
        raise SystemExit(f"lane console: next build failed (exit {r.returncode}); this is the app's console failing to build:\n{tail}")
    json.dump({"hash": want, "api_port": port, "from": os.path.relpath(web, ROOT)}, open(meta_p, "w"), indent=1)
    return os.path.join(out, "web"), port


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    if len(a) < 4 or "--codebase" not in a or "--" not in a: sys.exit(__doc__)
    app_id = a[0]; codebase = a[a.index("--codebase") + 1]; rest = a[a.index("--") + 1:]
    web, port = prepare(app_id, codebase)
    tsx = os.path.join(os.path.abspath(codebase), "node_modules", ".bin", "tsx")
    cmd = [tsx, os.path.join(HERE, "world.mts"), "--codebase", os.path.abspath(codebase), "--console", web,
           "--api-port", str(port), "--deadline", str(WORLD_S), "--harness", os.path.abspath(rest[0]), "--", *rest[1:]]
    sys.stdout.flush()
    return subprocess.run(cmd, cwd=os.path.abspath(codebase)).returncode


def self_test():
    import tempfile
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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
