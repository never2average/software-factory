"""Which console pages a change can affect: `render.py --pages auto` (mold_v0-147). Standard library only, no browser.

A builder's browser check grades the pages its change can reach, not all ~50, and says why each one was chosen. The full
sweep (`--pages all`, the default, and what every lane check in lanes.py runs) stays the end-of-train check.

changed files (git diff against a base ref, plus untracked files, plus any --changed path) -> rules -> pages.

THE MAPPING (paths are the factory repository's; a mold source checkout's own `web/...` paths read the same):

  path                                                     rule
  molds/<m>/codebase/<rel>, build/<app>.lane/<rel>,
  packs/<P>/files/<rel>                                    read <rel> as a path in the codebase (below)
  packs/<P>/<anything else> (pack.json, tests...)          pack P's pages
  molds/<m>/testing/console|accessibility|responsiveness/  all pages (the harness itself changed)
  anything else in the factory (state, docs, other molds,
  other lanes, scripts)                                    nothing (it does not reach the console)

  in the codebase:
  web/src/app/page.tsx, layout.tsx, globals.css, any
    file directly in web/src/app/                          all pages
  web/src/app/<route>/page.tsx                             that route only (route groups "(x)" dropped)
  web/src/app/<route>/layout|template|loading|error|
    not-found.tsx                                          every page under that route
  web/src/app/<route>/<other file> (a page's own helper)   every page under that route, when nothing outside that
                                                           route imports it; else all pages
  a route with a dynamic segment (records/[area]/...)      every page under its static part (/app/records)
  web/src/app/<area>/host/[pack]/...                       every host pack page in that area (app, admin, site)
  web/src/packs/<id>/...                                   host pack <id>'s pages
  packs/<id>/... (a pack in the codebase, pack.json)       pack <id>'s pages
  web/src/components|lib|hooks|styles|features|config|
    types|content/..., web/src/proxy.ts, web/public/...,
    web/<config files>, web/package.json                   all pages (shared by every page)
  profile.json, profiles/...                               all pages (words and settings every page shows)
  docs/..., *.md, tests (*-test.ts, *.test.*, tests/)      nothing
  anything else in the codebase (src/, sql/, scripts/,
    package.json: the API every page calls)                all pages

Always added, as a smoke: the landing page (/) and the admin home (/admin), or the first admin page when /admin is not
served. A rule that names no page (a pack that adds no console page) is printed, never silently dropped.
"""
import fnmatch, os, re, subprocess

SMOKE = ("/", "/admin")
MOLD = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))   # molds/<this>/testing/console
HARNESS_DIRS = ("console", "accessibility", "responsiveness")
SHARED_WEB = ("components", "lib", "hooks", "styles", "features", "config", "types", "content")
ROUTE_FILES = {"layout", "template", "loading", "error", "not-found", "global-error", "default"}
IGNORE = ("docs/*", "*.md", "*.mdx", "*-test.ts", "*-test.mjs", "*.test.ts", "*.test.tsx", "*.test.mjs", "*.spec.ts",
          "tests/*", "*/tests/*", "test/*", "*/__tests__/*", ".github/*", "LICENSE*")


def route_of(segs):
    """URL route of a list of app/ directory names, route groups dropped; (route, dynamic) where route stops at the
    first dynamic segment."""
    out = []
    for s in segs:
        if re.fullmatch(r"\(.*\)", s): continue
        if s.startswith("["): return "/" + "/".join(out), True
        out.append(s)
    return "/" + "/".join(out), False


def area_of(segs):
    real = [s for s in segs if not re.fullmatch(r"\(.*\)", s)]
    return real[0] if real and real[0] in ("app", "admin") else "site"


def ignored(rel):
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p) for p in IGNORE)


def normalize(path, mold=MOLD):
    """A repository path -> ('codebase', rel) | ('pack', id, why) | ('all', why) | ('none', why). Only this mold's
    codebase and harness count: another mold's files never reach this console."""
    p = path.replace("\\", "/")
    while p.startswith("./"): p = p[2:]
    m = re.match(rf"molds/{re.escape(mold)}/codebase/(.+)", p) or re.match(r"build/[^/]+\.lane/(.+)", p)
    if m: return ("codebase", m.group(1))
    m = re.match(r"packs/([^/]+)/files/(.+)", p)
    if m: return ("codebase", m.group(2))
    m = re.match(r"packs/([^/]+)/", p)
    if m: return ("pack", m.group(1), f"pack {m.group(1)} changed ({p})")
    m = re.match(rf"molds/{re.escape(mold)}/testing/([^/]+)/", p)
    if m and m.group(1) in HARNESS_DIRS: return ("all", f"the browser harness changed ({p})")
    if re.match(r"(molds|state|docs|briefs|brands|reports|build|\.claude|\.agents|\.kiro|\.gemini|\.codex|\.github|\.pi|\.opencode)/", p) \
            or "/" not in p and not p.startswith(("profile.json", "package.json")):
        return ("none", f"outside the console ({p})")
    return ("codebase", p)   # a mold source checkout: its own paths


def classify(rel, importers=None):
    """A codebase-relative path -> a rule: ('all', why) | ('route', prefix, exact, why) | ('host', area, why) |
    ('pack', id, why) | ('none', why). importers(rel) -> codebase-relative files that import it (for a route's own
    helper files)."""
    if ignored(rel): return ("none", f"documentation or a test ({rel})")
    if rel in ("profile.json",) or rel.startswith("profiles/"): return ("all", f"the profile every page reads ({rel})")
    m = re.match(r"packs/([^/]+)/", rel)
    if m: return ("pack", m.group(1), f"pack {m.group(1)} changed ({rel})")
    m = re.match(r"web/src/packs/([^/]+)/", rel)
    if m: return ("pack", m.group(1), f"host pack {m.group(1)} changed ({rel})")
    if rel.startswith("web/src/app/"):
        parts = rel[len("web/src/app/"):].split("/")
        segs, f = parts[:-1], parts[-1]
        if not segs: return ("all", f"the console's root ({rel})")
        real = [s for s in segs if not re.fullmatch(r"\(.*\)", s)]
        if len(real) >= 2 and real[1] == "host" and real[0] in ("app", "admin") or real[:1] == ["host"]:
            area = real[0] if real[0] in ("app", "admin") else "site"
            return ("host", area, f"the {area} host page route changed ({rel})")
        route, dynamic = route_of(segs)
        stem = f.rsplit(".", 1)[0]
        if route == "/" and not (stem == "page" and not dynamic and not real):
            return ("all", f"a route group's shared file ({rel})")
        if stem == "page" and not dynamic: return ("route", route, True, f"{route} changed ({rel})")
        if stem in ROUTE_FILES or stem == "page" or dynamic:
            return ("route", route, False, f"everything under {route} ({rel})")
        # A page's own helper: under its route, unless something outside that route imports it.
        dir_ = "web/src/app/" + "/".join(segs) + "/"
        outside = [i for i in (importers(rel) if importers else ["?"]) if not i.startswith(dir_)]
        if outside: return ("all", f"{rel} is imported outside {route} ({', '.join(outside[:2])})")
        return ("route", route, False, f"everything under {route} ({rel})")
    if rel.startswith("web/"):
        sub = rel[len("web/"):]
        if sub.startswith("src/"):
            top = sub.split("/")[1] if sub.count("/") >= 2 else sub[len("src/"):]
            if top in SHARED_WEB: return ("all", f"shared by every page ({rel})")
        return ("all", f"the console's shared code or settings ({rel})")
    return ("all", f"the API every page calls ({rel})")


def bare(path): return path.split("?", 1)[0]


def under(path, prefix):
    p = bare(path)
    return prefix == "/" or p == prefix or p.startswith(prefix.rstrip("/") + "/")


def select(rules, pages, packs):
    """rules from classify(); pages [{pack, path, ...}] (surface.mts); packs [{id, kind}] -> (chosen, notes):
    chosen {path: [reasons]} in page order (paths, so a page that two packs share is graded once with both rows),
    notes: what each rule found nothing for."""
    kinds = {p["id"]: p.get("kind", "pack") for p in packs}
    chosen, notes = {}, []
    def add(path, why): chosen.setdefault(path, []).append(why)
    for r in rules:
        kind, why = r[0], r[-1]
        if kind == "none": continue
        if kind == "all": hit = [p["path"] for p in pages]
        elif kind == "route":
            prefix, exact = r[1], r[2]
            hit = [p["path"] for p in pages if (bare(p["path"]) == prefix if exact else under(p["path"], prefix))]
        elif kind == "host":
            area = r[1]
            def in_area(p):
                b = bare(p["path"])
                a = "app" if under(b, "/app") else "admin" if under(b, "/admin") else "site"
                return a == area
            hit = [p["path"] for p in pages if kinds.get(p["pack"]) == "host" and in_area(p)]
        elif kind == "pack":
            hit = [p["path"] for p in pages if p["pack"] == r[1]]
        else: raise ValueError(r)
        if not hit: notes.append(f"{why}: no console page")
        for h in hit: add(h, why)
    paths = {p["path"] for p in pages}
    smoke = [s for s in SMOKE if s in paths]
    if "/admin" not in paths:
        smoke += [p["path"] for p in pages if under(p["path"], "/admin")][:1]
    for s in smoke: add(s, "smoke (always graded)")
    order = [p["path"] for p in pages]
    return {k: chosen[k] for k in sorted(chosen, key=lambda x: order.index(x) if x in order else len(order))}, notes


def plan(changed, pages, packs, importers=None, mold=MOLD):
    """changed: repository paths -> (chosen, notes, rules): the selection as select() returns it, and the rule each
    changed path made (in the order given)."""
    rules = []
    for path in changed:
        n = normalize(path, mold)
        if n[0] == "codebase": rules.append(classify(n[1], importers))
        elif n[0] == "pack": rules.append(("pack", n[1], n[2]))
        else: rules.append(n)
    # One rule that takes every page makes the others moot (their reasons would only repeat on every row).
    use = [r for r in rules if r[0] == "all"][:1] or rules
    chosen, notes = select(use, pages, packs)
    return chosen, notes, rules


# ---- the diff ------------------------------------------------------------------------------------------------------

def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def changed_files(repo, base):
    """Files that differ from <base> in <repo>: committed since the merge base, staged, unstaged, and untracked
    (git-ignored files, such as packs/, are not seen: name them with --changed)."""
    top = (git(repo, "rev-parse", "--show-toplevel") or "").strip()
    if not top: raise SystemExit(f"--pages auto: {repo} is not in a git repository; name the changed files with --changed <path>.")
    if git(top, "rev-parse", "--verify", "--quiet", base + "^{commit}") is None:
        raise SystemExit(f"--pages auto: the base {base!r} is not a commit in {top} (fetch it, or name another with --base).")
    mb = (git(top, "merge-base", base, "HEAD") or "").strip() or base
    out = (git(top, "diff", "--name-only", mb) or "").split() + (git(top, "ls-files", "--others", "--exclude-standard") or "").split()
    return top, mb, sorted(set(out))


def importers_in(codebase):
    """importers(rel): codebase-relative files under web/src that name rel's module in an import (a plain text scan of
    import/require specifiers ending in its path without extension; generous by design: a false hit only widens)."""
    web_src = os.path.join(codebase, "web", "src")
    cache = {}
    def files():
        if "all" not in cache:
            acc = []
            for d, dirs, fs in os.walk(web_src):
                dirs[:] = [x for x in dirs if x not in ("node_modules", ".next")]
                for f in fs:
                    if f.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts")):
                        p = os.path.join(d, f)
                        try:
                            with open(p, encoding="utf-8", errors="replace") as fh: acc.append((os.path.relpath(p, codebase), fh.read()))
                        except OSError: pass
            cache["all"] = acc
        return cache["all"]
    def importers(rel):
        stem = os.path.basename(rel).rsplit(".", 1)[0]
        pat = re.compile(r"""(?:from|import|require)\s*\(?\s*['"][^'"]*\b""" + re.escape(stem) + r"""(?:\.[a-z]+)?['"]""")
        return [f for f, text in files() if f != rel and pat.search(text)]
    return importers
