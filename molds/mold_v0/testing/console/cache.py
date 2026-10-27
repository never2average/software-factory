"""The lane console's build cache (mold_v0-147): build once, test many. Standard library only.

A console build (`next build` of a lane copy's web/ with the Clerk stand-in) is kept under a key that is a hash of every
input that can change its bytes, and a later run with the same key serves a copy of it instead of building again:

  web       every file of the lane copy's web/ but node_modules, .next, .turbo and .env* (the console's own code, and the
            files the packs and the profile generate into it: pack-nav.generated.ts, pack-routes.generated.json, ...)
  packs     each pack the lane copy carries, by id and the hash of its pack.json (packs/<id>/pack.json, web/src/packs/<id>),
            so two builds for different packs never share an entry, even if their generated files were to agree
  profile   the lane copy's profile.json
  deps      the console's installed packages (node_modules/.package-lock.json, else every package's name@version)
  node      `node --version`
  env       the environment the build runs with, the API's port left out (it is patched per run, below)
  standin   the Clerk stand-in (clerk-standin/) every lane build carries
  recipe    RECIPE: bumped whenever the way render.py builds changes

A different input is a different key: a rebuild, never a reuse. Nothing of the lane copy's path is in the key (the same
mold at the same commit in two clones shares one build).

WHERE.  $LANE_CACHE_DIR, else ~/.cache/software-factory/lane-console:
  entries/<key>/web, entries/<key>/meta.json   a finished build (its sources and .next, without .next/cache) and what
                                               built it; written under a temporary name and renamed, so an entry is
                                               complete or absent
  work/web                                     where builds run, one at a time (locks/build.lock); its .next/cache (the
                                               bundler's own cache, which validates itself) is kept, so the next build of
                                               a small change is incremental. Files are copied in with fresh times, so the
                                               bundler re-reads every source file and trusts only its package snapshots.
  runs/<id>/web                                one run's private copy of an entry (about 20 MB): its API port patched in,
                                               node_modules linked to the lane copy's; removed when the run ends
  locks/<key>.lock                             building or copying an entry; eviction skips an entry in use
LRU: at most $LANE_CACHE_MAX entries (default 6), the least recently used removed first.

THE API PORT.  `next build` bakes the API's address into the console's rewrites (.next/routes-manifest.json, and the
config copies in required-server-files.json/.js). A run picks a free port and replaces the built one in those files of its
own copy; when the routes manifest does not carry the built address exactly once the copy is refused (and render.py builds
afresh), so a Next.js that stores it elsewhere can never serve a stale address. The world's /healthz probe goes through
that rewrite, so a wrong port fails the run loudly.
"""
import contextlib, fcntl, hashlib, json, os, re, shutil, subprocess, tempfile, time

RECIPE = "next build --webpack; clerk stand-in; NEXT_PUBLIC_AUTH_PROVIDER=clerk; v1"
SKIP = {"node_modules", ".next", ".turbo"}
PORT_FILES = ("routes-manifest.json", "required-server-files.json", "required-server-files.js")
KEY_ENV = ("LANG", "LC_ALL")


def root():
    return os.path.abspath(os.environ.get("LANE_CACHE_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "software-factory", "lane-console"))


def keep_max():
    try: return max(1, int(os.environ.get("LANE_CACHE_MAX", "6")))
    except ValueError: return 6


def skipped(names): return [n for n in names if n in SKIP or n.startswith(".env")]


def tree(base):
    """sha256 of every file under base (paths and contents), node_modules/.next/.turbo/.env* left out; '' when absent."""
    if not os.path.exists(base): return ""
    h = hashlib.sha256()
    if os.path.isfile(base):
        with open(base, "rb") as fh: return hashlib.sha256(fh.read()).hexdigest()
    for d, dirs, files in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x not in SKIP)
        for f in sorted(files):
            if f.startswith(".env"): continue
            p = os.path.join(d, f)
            h.update(os.path.relpath(p, base).encode() + b"\0")
            if os.path.islink(p): h.update(b"link:" + os.readlink(p).encode())
            else:
                with open(p, "rb") as fh: h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()


def deps(nm):
    """The installed packages: npm's own record of them when there is one, else every package's name@version."""
    lock = os.path.join(nm, ".package-lock.json")
    if os.path.exists(lock):
        with open(lock, "rb") as fh: return "lock:" + hashlib.sha256(fh.read()).hexdigest()
    h = hashlib.sha256()
    if os.path.isdir(nm):
        for e in sorted(os.listdir(nm)):
            names = [f"{e}/{s}" for s in sorted(os.listdir(os.path.join(nm, e)))] if e.startswith("@") and os.path.isdir(os.path.join(nm, e)) else [e]
            for n in names:
                f = os.path.join(nm, n, "package.json")
                try: v = json.load(open(f)).get("version")
                except (OSError, ValueError): v = None
                h.update(f"{n}@{v}\n".encode())
    return "versions:" + h.hexdigest()


def packs(codebase):
    out = []
    for base in (os.path.join(codebase, "packs"), os.path.join(codebase, "web", "src", "packs")):
        if not os.path.isdir(base): continue
        for e in sorted(os.listdir(base)):
            d = os.path.join(base, e)
            if not os.path.isdir(d): continue
            manifest = os.path.join(d, "pack.json")
            out.append(f"{os.path.relpath(d, codebase)}={tree(manifest) if os.path.exists(manifest) else 'dir'}")
    return out


def node_version():
    try: return subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except OSError: return "none"


def inputs(codebase, web, nm, standin, build_env, node=None):
    """Every input of a build, by name (what the key hashes; meta.json keeps it, so a miss can be explained)."""
    env = {k: v for k, v in sorted(build_env.items()) if k not in ("PATH", "HOME", "TMPDIR", "TERM", "USER") or k in KEY_ENV}
    if "APP_API_URL" in env: env["APP_API_URL"] = "http://127.0.0.1:<port>"
    return {
        "recipe": RECIPE,
        "web": tree(web),
        "packs": packs(codebase),
        "profile": tree(os.path.join(codebase, "profile.json")),
        "deps": deps(nm),
        "node": node if node is not None else node_version(),
        "env": env,
        "standin": tree(standin),
    }


def key(inp): return hashlib.sha256(json.dumps(inp, sort_keys=True).encode()).hexdigest()[:32]


@contextlib.contextmanager
def lock(path, shared=False, block=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, "a+")
    try:
        try: fcntl.flock(fh, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | (0 if block else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False; return
        yield True
    finally:
        fh.close()


def entry(rootdir, k): return os.path.join(rootdir, "entries", k)


def lookup(rootdir, k):
    """meta of a finished entry, else None."""
    e = entry(rootdir, k)
    try: meta = json.load(open(os.path.join(e, "meta.json")))
    except (OSError, ValueError): return None
    if meta.get("key") != k or not os.path.exists(os.path.join(e, "web", ".next", "BUILD_ID")): return None
    return meta


def write_json(p, obj):
    t = p + f".tmp-{os.getpid()}"
    with open(t, "w") as fh: json.dump(obj, fh, indent=1)
    os.replace(t, p)


def touch(rootdir, k):
    p = os.path.join(entry(rootdir, k), "meta.json")
    try:
        meta = json.load(open(p)); meta["last_used"] = time.time(); meta["uses"] = meta.get("uses", 0) + 1; write_json(p, meta)
    except (OSError, ValueError): pass


def fresh_copy(src, dst):
    """src -> dst without node_modules/.next/.turbo/.env*, every file and folder with the current time (the bundler's
    cache then re-reads every source file instead of trusting a time that two different files could share)."""
    shutil.copytree(src, dst, ignore=lambda d, names: skipped(names), copy_function=shutil.copyfile, symlinks=True)
    now = time.time()
    for d, dirs, files in os.walk(dst):
        for n in dirs + files:
            p = os.path.join(d, n)
            if not os.path.islink(p): os.utime(p, (now, now))
    os.utime(dst, (now, now))


def store(rootdir, k, built_web, meta):
    """The built web dir (sources and .next, no node_modules, no .next/cache, no trace) as entries/<k>, atomically."""
    final = entry(rootdir, k)
    tmp = final + f".tmp-{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    def ignore(d, names):
        out = [n for n in names if n == "node_modules" or n.startswith(".env")]
        if os.path.basename(d) == ".next": out += [n for n in names if n in ("cache", "trace", "trace-build")]
        return out
    shutil.copytree(built_web, os.path.join(tmp, "web"), ignore=ignore, symlinks=True)
    write_json(os.path.join(tmp, "meta.json"), {**meta, "key": k, "last_used": time.time(), "uses": 0})
    shutil.rmtree(final, ignore_errors=True)
    os.rename(tmp, final)


def size(path):
    n = 0
    for d, _, files in os.walk(path):
        for f in files:
            try: n += os.lstat(os.path.join(d, f)).st_size
            except OSError: pass
    return n


def evict(rootdir, keep, protect=(), say=print):
    """Removes the least recently used entries beyond `keep`; never one named in protect or in use (its lock held)."""
    base = os.path.join(rootdir, "entries")
    if not os.path.isdir(base): return []
    metas = []
    for e in os.listdir(base):
        if ".tmp-" in e: continue
        try: metas.append((json.load(open(os.path.join(base, e, "meta.json"))).get("last_used", 0), e))
        except (OSError, ValueError): metas.append((0, e))
    metas.sort(reverse=True)
    gone = []
    for _, e in metas[keep:]:
        if e in protect: continue
        with lock(os.path.join(rootdir, "locks", f"{e}.lock"), block=False) as got:
            if not got: continue
            shutil.rmtree(os.path.join(base, e), ignore_errors=True)
            gone.append(e)
        try: os.remove(os.path.join(rootdir, "locks", f"{e}.lock"))
        except OSError: pass
    if gone: say(f"lane console cache: removed {len(gone)} least recently used build(s) (keeping {keep})")
    return gone


def patch_port(next_dir, old, new):
    """Points a built console's API rewrites at 127.0.0.1:<new> instead of :<old>. False (nothing written) when the routes
    manifest does not carry the old address, or carries it anywhere but as a whole rewrite destination (followed by "/" or
    a closing quote): the console proxies several API paths (/:path*, /admin/mcp, /admin/session), so several are expected."""
    a, b = f"http://127.0.0.1:{old}", f"http://127.0.0.1:{new}"
    texts = {}
    for f in PORT_FILES:
        p = os.path.join(next_dir, f)
        if os.path.exists(p): texts[p] = open(p).read()
    rm = os.path.join(next_dir, "routes-manifest.json")
    m = texts.get(rm, "")
    if not m.count(a) or len(re.findall(re.escape(a) + r'(?=[/"])', m)) != m.count(a): return False
    for p, t in texts.items():
        if a in t:
            os.remove(p)   # a new file, never one written in place
            with open(p, "w") as fh: fh.write(t.replace(a, b))
    return True


def run_copy(rootdir, k):
    """A private copy of entries/<k>/web for one run, under runs/; the caller links node_modules and patches the port."""
    runs = os.path.join(rootdir, "runs")
    os.makedirs(runs, exist_ok=True)
    # Copies left by a run that was killed: older than a day and nobody's.
    for e in os.listdir(runs):
        p = os.path.join(runs, e)
        try:
            if time.time() - os.path.getmtime(p) > 86400: shutil.rmtree(p, ignore_errors=True)
        except OSError: pass
    d = tempfile.mkdtemp(prefix=f"{k[:12]}-", dir=runs)
    shutil.copytree(os.path.join(entry(rootdir, k), "web"), os.path.join(d, "web"), symlinks=True)
    return d
