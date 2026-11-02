#!/usr/bin/env python3
"""leakcheck.py: keep this machine's private values (organisation, people, domains, servers, app ids) out of git.

The repository is public. What identifies the organisation that runs this factory lives only on its machine:
state/factory.local.json and the files below, all git-ignored. This script turns them into a denylist and looks for
any of those values in what git would publish. It never prints a value: a finding says `path:line: local value #n`
and where value #n came from (`leakcheck.py terms` lists the sources, still without the values).

  leakcheck.py scan [--all | --staged | --rev REV] [--json]
        --all (default)  every tracked file as it is on disk now (content and path)
        --staged         only the lines a commit would add, and the paths it would add (the pre-commit hook)
        --rev REV        every file of a commit's tree, e.g. --rev HEAD
  leakcheck.py msg <file>          a commit message (the commit-msg hook)
  leakcheck.py push <remote>       the commits a push would send, read as git's pre-push hook gives them on stdin:
                                   each commit's message and the lines it adds (the pre-push hook)
  leakcheck.py terms [--json]      how many values the denylist holds, and where each came from (never the values)
  leakcheck.py install-hook        install pre-commit, commit-msg and pre-push hooks in this clone. A hook already
                                   there is kept and still runs after this one (renamed <hook>.pre-leakcheck)
  leakcheck.py --self-test

Where the denylist comes from (each git-ignored, each optional):
  state/factory.local.json   every string value (keys starting with "_" skipped); an email also as its name and its
                             domain, a URL also as its path parts, a domain also as each distinctive label
  state/leak-denylist.txt    one term per line (# comments): names, domains, people, ids the local JSON does not hold
  state/application/<id>/    every application id on this machine except the template `app_id`
Never denylisted: values the example file (state/factory.local.example.json) uses, and the owner and name of this
repository's own `origin` (public by definition).

False positives:
  state/leak-allowlist.txt   (git-ignored) `term: <value>` never flags that value; `path: <glob>` skips matching files
  state/leakcheck-known.txt  (tracked, paths only, never values) `<glob>  # why`: findings in those files are listed
                             as known and do not fail. For a vendored snapshot whose fix belongs upstream (a mold).

Matching: case-insensitive; `_` and `-` in a term also match a space, the other one or nothing (app_one = app-one =
AppOne). A term of 6 characters or more matches anywhere; a shorter one only as a whole word (letters and digits
around it end the match). Binary files are checked by path only.

Exit codes: 0 nothing found, 1 found something, 2 could not run (not a git repository, a bad argument).
"""
import fnmatch, ipaddress, json, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_MARK = "# leakcheck-hook"
HOOKS = ("pre-commit", "commit-msg", "pre-push")
PUBLIC_HOSTS = {"github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "ssh.github.com"}
# labels too common to name anybody: a domain is denylisted whole, and only its distinctive labels on their own
COMMON_LABELS = {"com", "org", "net", "io", "in", "co", "ai", "app", "dev", "www", "mail", "email", "notify", "cloud",
                 "vercel", "github", "gitlab", "google", "gmail", "outlook", "example", "local", "localhost", "online",
                 "site", "tech", "systems", "group", "global", "digital", "labs", "studio", "workers", "pages"}
# values a setting may hold that are the mold's own public constants, not anybody's name (defaults.source_offer.app)
PUBLIC_VALUES = {"licensor_exception"}
MIN_LEN = 3          # shorter values are too common to mean anything
SUBSTRING_LEN = 6    # from this length a value matches inside a longer word too


# ---- the denylist ------------------------------------------------------------------------------------------------
def _git(root, *args, check=True, input=None, text=True):
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=root, capture_output=True, input=input, text=text)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {(r.stderr or b'').strip() if text else r.stderr[:200]}")
    return r


def _walk(x, path=""):
    if isinstance(x, dict):
        for k, v in x.items():
            if str(k).startswith("_"): continue
            yield from _walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(x, list):
        for i, v in enumerate(x): yield from _walk(v, f"{path}[{i}]")
    elif isinstance(x, str):
        yield path, x


def _is_ip(s):
    try: ipaddress.ip_address(s); return True
    except ValueError: return False


def _expand(value):
    """[(term, how)]: the value itself and the parts of it that identify somebody on their own."""
    v = value.strip()
    out = [(v, "")]
    if "://" in v or re.match(r"^[^@/\s]+@[^:/\s]+:", v):              # a URL or an scp-like git address
        m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/]?(.*)$", re.sub(r"\.git/?$", "", v.rstrip("/")))
        if m:
            host, rest = m.group(1).lower(), m.group(2)
            if host not in PUBLIC_HOSTS and not _is_ip(host): out.append((host, " (host)"))
            for seg in [s for s in rest.split("/") if s]: out.append((seg, " (path part)"))
        return out
    if "@" in v and " " not in v:
        name, _, dom = v.partition("@")
        out += [(name, " (name part)"), (dom, " (domain part)")]
        v = dom
    if "." in v and " " not in v and "/" not in v and not _is_ip(v):
        for lab in v.split("."):
            if len(lab) >= 5 and lab.lower() not in COMMON_LABELS: out.append((lab, " (domain label)"))
    return out


def _origin(root):
    """(owner and name, "owner/name") of this repository's own origin: public, so never a finding."""
    r = _git(root, "remote", "get-url", "origin", check=False)
    url = (r.stdout or "").strip()
    if r.returncode != 0 or not url: return set(), None
    m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?/?$", url)
    if not m: return set(), None
    return {p.lower() for p in m.group(2).split("/") if p}, m.group(2).lower().strip("/")


def _example_values(root):
    p = os.path.join(root, "state", "factory.local.example.json")
    try:
        with open(p) as f: data = json.load(f)
    except (OSError, ValueError): return set()
    out = set()
    for _, v in _walk(data):
        out |= {t.lower() for t, _ in _expand(v)}
    return out


def _read_lines(p):
    try:
        with open(p, encoding="utf-8") as f:
            return [l.strip() for l in f]
    except OSError:
        return []


def allowlist(root):
    """(terms never flagged, path globs skipped) from the git-ignored state/leak-allowlist.txt."""
    terms, paths = set(), []
    for l in _read_lines(os.path.join(root, "state", "leak-allowlist.txt")):
        if not l or l.startswith("#"): continue
        k, _, v = l.partition(":")
        if k.strip() == "term" and v.strip(): terms.add(v.strip().lower())
        elif k.strip() == "path" and v.strip(): paths.append(v.strip())
    return terms, paths


def known_paths(root):
    """Tracked globs whose findings are known and do not fail (state/leakcheck-known.txt: paths only)."""
    out = []
    for l in _read_lines(os.path.join(root, "state", "leakcheck-known.txt")):
        l = l.split("#", 1)[0].strip()
        if l: out.append(l)
    return out


def load_terms(root=ROOT):
    """[{"n", "term", "source"}], numbered in a stable order. Only `term` is private; never print it."""
    raw = []
    local = os.environ.get("FACTORY_LOCAL") or os.path.join(root, "state", "factory.local.json")
    if os.path.exists(local):
        try:
            with open(local) as f: data = json.load(f)
        except ValueError:
            raise RuntimeError(f"{os.path.relpath(local, root)} is not valid JSON")
        for key, v in _walk(data):
            raw += [(t, f"factory.local.json {key}{how}") for t, how in _expand(v)]
    for i, l in enumerate(_read_lines(os.path.join(root, "state", "leak-denylist.txt")), 1):
        if l and not l.startswith("#"): raw.append((l, f"leak-denylist.txt line {i}"))
    appdir = os.path.join(root, "state", "application")
    if os.path.isdir(appdir):
        for a in sorted(os.listdir(appdir)):
            if a != "app_id" and os.path.isdir(os.path.join(appdir, a)): raw.append((a, "state/application/ folder name"))
    parts, slug = _origin(root)
    skip = parts | _example_values(root) | allowlist(root)[0] | PUBLIC_VALUES
    seen, out = set(), []
    for t, src in raw:
        k = t.strip().lower()
        if len(k) < MIN_LEN or k in skip or k in seen or (slug and re.sub(r"\.git/?$", "", k).endswith(slug)): continue
        seen.add(k); out.append({"n": len(out) + 1, "term": t.strip(), "source": src})
    return out


def _pattern(term):
    parts = [re.escape(p) for p in re.split(r"[-_]+", term)]
    body = r"[-_ ]?".join(p for p in parts if p)
    if len(term) >= SUBSTRING_LEN: return body
    return r"(?<![A-Za-z0-9])" + body + r"(?![A-Za-z0-9])"


class Matcher:
    def __init__(self, terms):
        self.terms = terms
        self.rx = [(t["n"], re.compile(_pattern(t["term"]), re.I), max(re.split(r"[-_ ]+", t["term"].lower()), key=len))
                   for t in terms]

    def mask(self, text):
        """text with every term replaced by `<local value #n>`: what a printed path may show."""
        for n, rx, _ in self.rx: text = rx.sub(f"<local value #{n}>", text)
        return text

    def find(self, text):
        """[(line_no, n)] for every term found in text (one entry per term per line)."""
        low = text.lower()
        hits = []
        for n, rx, key in self.rx:
            if key not in low: continue          # quick: most files hold none of the terms
            for m in rx.finditer(text):
                hits.append((text.count("\n", 0, m.start()) + 1, n))
        return sorted(set(hits))


# ---- what to read ------------------------------------------------------------------------------------------------
def _blobs(root, listing):
    """{path: bytes} for [(path, sha)] through one `git cat-file --batch`."""
    if not listing: return {}
    r = subprocess.run(["git", "cat-file", "--batch"], cwd=root, input="".join(f"{s}\n" for _, s in listing).encode(),
                       capture_output=True)
    if r.returncode != 0: raise RuntimeError("git cat-file failed")
    out, buf, i = {}, r.stdout, 0
    for path, _ in listing:
        nl = buf.index(b"\n", i)
        head = buf[i:nl].split()
        if len(head) < 3 or head[1] == b"missing":
            i = nl + 1; continue
        size = int(head[2]); out[path] = buf[nl + 1: nl + 1 + size]; i = nl + 1 + size + 1
    return out


def _tree_files(root, rev=None):
    if rev:
        raw = _git(root, "ls-tree", "-r", "-z", rev).stdout
        rows = [e.split("\t", 1) for e in raw.split("\0") if e]
        return [(p, meta.split()[2]) for meta, p in rows if meta.split()[1] == "blob"]
    raw = _git(root, "ls-files", "-s", "-z").stdout
    rows = [e.split("\t", 1) for e in raw.split("\0") if e]
    return [(p, meta.split()[1]) for meta, p in rows if not meta.startswith("160000")]


def _added_lines(diff_text):
    """{path: [(line_no, text)]} of the lines a unified diff (-U0) adds."""
    out, path, ln, in_head = {}, None, 0, False
    for l in diff_text.split("\n"):
        if l.startswith("diff --git "): in_head, path = True, None; continue
        if in_head and l.startswith("+++ "):
            p = l[4:]
            path = None if p == "/dev/null" else (p[2:] if p.startswith("b/") else p)
            continue
        if l.startswith("@@"):
            in_head = False
            m = re.search(r"\+(\d+)", l); ln = int(m.group(1)) if m else 0
            continue
        if in_head or path is None: continue
        if l.startswith("+"):
            out.setdefault(path, []).append((ln, l[1:])); ln += 1
    return out


def _is_binary(b):
    return b"\0" in b[:8000]


# ---- scanning ----------------------------------------------------------------------------------------------------
def scan(root=ROOT, mode="all", rev=None, terms=None):
    """{"findings": [{path, line, n, source, known}], "terms": count, "files": count}"""
    terms = load_terms(root) if terms is None else terms
    res = {"findings": [], "terms": len(terms), "files": 0}
    if not terms: return res
    M = Matcher(terms); src = {t["n"]: t["source"] for t in terms}
    allow_paths = allowlist(root)[1]; known = known_paths(root)
    def skip(p): return any(fnmatch.fnmatch(p, g) for g in allow_paths)
    def is_known(p): return any(fnmatch.fnmatch(p, g) for g in known)
    def add(path, line, n, where=None):
        f = {"path": M.mask(path), "line": line, "n": n, "source": src[n], "known": is_known(path)}
        if where: f["where"] = where
        res["findings"].append(f)
    if mode == "staged":
        new = _git(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACR").stdout.split("\0")
        for p in filter(None, new):
            if skip(p): continue
            for _, n in M.find(p): add(p, 0, n, "path")
        diff = _git(root, "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR").stdout
        for p, lines in _added_lines(diff).items():
            if skip(p): continue
            res["files"] += 1
            for ln, text in lines:
                for _, n in M.find(text): add(p, ln, n)
    else:
        listing = [(p, s) for p, s in _tree_files(root, rev) if not skip(p)]
        if rev: blobs = _blobs(root, listing)
        else:   # tracked files as they are on disk now (a fix shows before it is staged); a deleted one as staged
            blobs = {}
            for p, _ in listing:
                fp = os.path.join(root, p)
                if os.path.isfile(fp) and not os.path.islink(fp):
                    with open(fp, "rb") as f: blobs[p] = f.read()
            blobs.update(_blobs(root, [(p, s) for p, s in listing if p not in blobs]))
        for p, _ in listing:
            res["files"] += 1
            for _, n in M.find(p): add(p, 0, n, "path")
            b = blobs.get(p)
            if b is None or _is_binary(b): continue
            for ln, n in M.find(b.decode("utf-8", "replace")): add(p, ln, n)
    return res


def scan_message(text, root=ROOT, terms=None, label="commit message"):
    terms = load_terms(root) if terms is None else terms
    lines = []
    for l in text.split("\n"):
        if l.startswith("# ------------------------ >8 ------------------------"): break
        lines.append("" if l.startswith("#") else l)
    M = Matcher(terms) if terms else None
    src = {t["n"]: t["source"] for t in terms}
    return [{"path": label, "line": ln, "n": n, "source": src[n], "known": False}
            for ln, n in (M.find("\n".join(lines)) if M else [])]


def scan_push(root, remote, refs_text, terms=None):
    """The commits a push sends: messages and added lines. refs_text is the pre-push hook's stdin."""
    terms = load_terms(root) if terms is None else terms
    res = {"findings": [], "terms": len(terms), "files": 0}
    if not terms: return res
    M = Matcher(terms); src = {t["n"]: t["source"] for t in terms}
    allow_paths = allowlist(root)[1]
    zero = re.compile(r"^0+$")
    for line in refs_text.splitlines():
        parts = line.split()
        if len(parts) < 4 or zero.match(parts[1]): continue
        local_sha, remote_sha = parts[1], parts[3]
        have_remote = not zero.match(remote_sha) and _git(root, "cat-file", "-e", remote_sha, check=False).returncode == 0
        rng = [f"{remote_sha}..{local_sha}"] if have_remote else [local_sha, "--not", f"--remotes={remote}"]
        commits = [c for c in _git(root, "rev-list", *rng).stdout.split() if c]
        for c in commits:
            short = c[:10]
            msg = _git(root, "log", "-1", "--format=%B", c).stdout
            for ln, n in M.find(msg):
                res["findings"].append({"path": f"commit {short} message", "line": ln, "n": n, "source": src[n], "known": False})
            diff = _git(root, "show", "-U0", "--no-color", "--no-ext-diff", "--format=", "--first-parent", c).stdout
            for p, lines in _added_lines(diff).items():
                if any(fnmatch.fnmatch(p, g) for g in allow_paths): continue
                res["files"] += 1
                mp = M.mask(p)
                for _, n in M.find(p):
                    res["findings"].append({"path": f"commit {short} {mp}", "line": 0, "n": n, "source": src[n], "known": False, "where": "path"})
                for ln, text in lines:
                    for _, n in M.find(text):
                        res["findings"].append({"path": f"commit {short} {mp}", "line": ln, "n": n, "source": src[n], "known": False})
    return res


def report(res, as_json=False, what="tracked files"):
    bad = [f for f in res["findings"] if not f["known"]]
    known = [f for f in res["findings"] if f["known"]]
    if as_json:
        print(json.dumps({"status": "failed" if bad else "ok", "terms": res["terms"], "files": res.get("files", 0),
                          "findings": bad, "known": known}, indent=2))
    else:
        for f in bad:
            where = f"{f['path']}:{f['line']}" if f.get("where") != "path" else f"{f['path']} (file name)"
            print(f"{where}: local value #{f['n']} ({f['source']})")
        if known:
            files = sorted({f["path"] for f in known})
            print(f"known (state/leakcheck-known.txt, not failing): {len(known)} finding(s) in {len(files)} file(s)")
        if not res["terms"]:
            print("leakcheck: no local values on this machine (state/factory.local.json, state/leak-denylist.txt), nothing to look for")
        elif bad:
            print(f"leakcheck: {len(bad)} finding(s) of this machine's private values in {what}. Replace each with a neutral "
                  f"word (example_app, acme, example.com); `leakcheck.py terms` says where value #n is defined.")
        else:
            print(f"leakcheck: ok ({res['terms']} local values, {res.get('files', 0)} file(s) read)")
    return 1 if bad else 0


# ---- hooks -------------------------------------------------------------------------------------------------------
HOOK_BODY = {
    "pre-commit": 'python3 "$s" scan --staged || exit 1\n[ -x "$0.pre-leakcheck" ] && exec "$0.pre-leakcheck" "$@"\nexit 0\n',
    "commit-msg": 'python3 "$s" msg "$1" || exit 1\n[ -x "$0.pre-leakcheck" ] && exec "$0.pre-leakcheck" "$@"\nexit 0\n',
    "pre-push": 'input=$(cat)\nprintf \'%s\\n\' "$input" | python3 "$s" push "$1" || exit 1\n'
                '[ -x "$0.pre-leakcheck" ] && { printf \'%s\\n\' "$input" | "$0.pre-leakcheck" "$@"; exit $?; }\nexit 0\n',
}


def hook_text(name):
    return ("#!/bin/sh\n" + HOOK_MARK + " (installed by .claude/scripts/leakcheck.py install-hook; never prints a value)\n"
            'top=$(git rev-parse --show-toplevel) || exit 1\n'
            's="$top/.claude/scripts/leakcheck.py"; [ -f "$s" ] || s="$top/.agents/scripts/leakcheck.py"\n'
            '[ -f "$s" ] || { [ -x "$0.pre-leakcheck" ] && exec "$0.pre-leakcheck" "$@"; exit 0; }\n' + HOOK_BODY[name])


def install_hook(root=ROOT):
    hooks = _git(root, "rev-parse", "--git-path", "hooks").stdout.strip()
    hooks = hooks if os.path.isabs(hooks) else os.path.join(root, hooks)
    os.makedirs(hooks, exist_ok=True)
    for name in HOOKS:
        p = os.path.join(hooks, name)
        if os.path.exists(p):
            with open(p, errors="replace") as f: cur = f.read()
            if HOOK_MARK not in cur:
                os.replace(p, p + ".pre-leakcheck"); print(f"{name}: the hook already there still runs, after this one ({name}.pre-leakcheck)")
        with open(p, "w") as f: f.write(hook_text(name))
        os.chmod(p, 0o755)
        print(f"{name}: installed")
    return 0


def hook_installed(root=ROOT):
    try: hooks = _git(root, "rev-parse", "--git-path", "hooks").stdout.strip()
    except (RuntimeError, OSError): return False
    hooks = hooks if os.path.isabs(hooks) else os.path.join(root, hooks)
    for name in HOOKS:
        try:
            with open(os.path.join(hooks, name), errors="replace") as f:
                if HOOK_MARK not in f.read(): return False
        except OSError: return False
    return True


def validate_errors(root=ROOT):
    """For factory.py validate: one line per finding in tracked files, never a value. [] outside a git repository."""
    if not os.path.exists(os.path.join(root, ".git")): return []
    try: res = scan(root, "all")
    except RuntimeError as e: return [f"leakcheck: could not run ({e})"]
    return [f"leakcheck: {f['path']}{':' + str(f['line']) if f.get('where') != 'path' else ' (file name)'}: local value "
            f"#{f['n']} ({f['source']})" for f in res["findings"] if not f["known"]]


# ---- self-test ---------------------------------------------------------------------------------------------------
def self_test():
    import io, contextlib, shutil
    fails = []
    def ok(c, m):
        if not c: fails.append(m)
    secrets = ["Zorblax", "zorblax.example-corp.test", "jdoe.zorblax@mailhost.test", "198.51.100.77", "zorb-team-slug",
               "quux_vm_app", "Kq", "ghostorg", "jdoe", "zorblax-internal"]
    def captured(fn, *a, **k):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try: rc = fn(*a, **k)
            except SystemExit as e: rc = e.code
        return rc, out.getvalue() + err.getvalue()
    def no_values(text, what):
        low = text.lower()
        for s in secrets:
            if s.lower() in low: fails.append(f"{what}: printed a private value")
    old = os.environ.pop("FACTORY_LOCAL", None)
    with tempfile.TemporaryDirectory() as d:
        g = lambda *a, **k: _git(d, *a, **k)
        g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t")
        g("remote", "add", "origin", "git@github.com:pubowner/pubrepo.git")
        os.makedirs(os.path.join(d, "state", "application", "quux_vm_app")); os.makedirs(os.path.join(d, "state", "application", "app_id"))
        json.dump({"_comment": "Zorblax in a comment is skipped", "defaults": {
            "operator_email": "jdoe.zorblax@mailhost.test", "notify_domain": "zorblax.example-corp.test", "vercel_team": "zorb-team-slug",
            "vm": {"host": "198.51.100.77"}, "tiny": "Kq", "placeholder": "your-vercel-team-slug"},
            "mold_sources": {"m": "https://github.com/ghostorg/pubrepo-mold.git", "self": "git@github.com:pubowner/pubrepo.git"}},
            open(os.path.join(d, "state", "factory.local.json"), "w"))
        json.dump({"defaults": {"vercel_team": "your-vercel-team-slug"}}, open(os.path.join(d, "state", "factory.local.example.json"), "w"))
        open(os.path.join(d, "state", "leak-denylist.txt"), "w").write("# people\njdoe\nzorblax-internal\n\nquux\n")
        open(os.path.join(d, "state", "leak-allowlist.txt"), "w").write("term: quux\npath: vendor/*\npath: .claude/*\n")
        open(os.path.join(d, ".gitignore"), "w").write("/state/factory.local.json\n/state/leak-denylist.txt\n/state/leak-allowlist.txt\n/state/application/*\n")
        T = load_terms(d)
        keys = {t["term"].lower() for t in T}
        ok("zorblax" in keys and "zorblax.example-corp.test" in keys, "an email's domain and its distinctive label are terms")
        ok("jdoe.zorblax" in keys and "198.51.100.77" in keys and "zorb-team-slug" in keys, "names, IPs and slugs are terms")
        ok("ghostorg" in keys and "pubrepo-mold" in keys, "a mold source URL's owner and name are terms")
        ok("pubowner" not in keys and "pubrepo" not in keys, "the repository's own origin owner/name is never a term")
        ok("kq" not in keys, "values shorter than 3 characters are skipped")
        ok("your-vercel-team-slug" not in keys, "a value the example file uses is a placeholder, not a term")
        ok("quux_vm_app" in keys and "app_id" not in keys, "local application ids are terms, the template is not")
        ok("quux" not in keys, "an allowlisted term is dropped")
        ok(not any("comment" in t["source"] for t in T), "keys starting with _ are skipped")
        ok([t["n"] for t in T] == list(range(1, len(T) + 1)), "terms are numbered 1..n")
        # files
        os.makedirs(os.path.join(d, "docs")); os.makedirs(os.path.join(d, "vendor")); os.makedirs(os.path.join(d, "snap"))
        files = {
            "docs/clean.md": "nothing here\nan example_app on example.com\n",
            "docs/a.md": "line one\nwe deploy Quux-VM-App to the box\nmail JDOE when done\nthe ZorblaxCorp office\n",
            "docs/word.md": "ajdoex is not a name; jdoe_old is\n",
            "docs/ip.md": "server 198.51.100.77 and 198.51.100.7 differ\n",
            "vendor/x.md": "Zorblax\n",
            "snap/y.md": "Zorblax upstream\n",
            "docs/zorblax-notes.md": "a clean body, a leaky name\n",
        }
        for p, c in files.items(): open(os.path.join(d, p), "w").write(c)
        open(os.path.join(d, "docs", "bin.dat"), "wb").write(b"\0\1Zorblax\0")
        open(os.path.join(d, "state", "leakcheck-known.txt"), "w").write("snap/*   # upstream snapshot\n")
        g("add", ".gitignore", "docs", "vendor", "snap", "state/leakcheck-known.txt"); g("commit", "-q", "-m", "init")
        r = scan(d, "all")
        hits = {(f["path"], f["line"]) for f in r["findings"] if not f["known"]}
        ok(("docs/a.md", 2) in hits and ("docs/a.md", 3) in hits and ("docs/a.md", 4) in hits, f"case/separator variants found {sorted(hits)}")
        ok(("docs/word.md", 1) in hits and len([f for f in r["findings"] if f["path"] == "docs/word.md"]) == 1,
           "a short term matches as a word only (jdoe_old yes, ajdoex no)")
        ok(("docs/ip.md", 1) in hits, "an IP is found")
        ok(not any(f["path"] == "docs/clean.md" for f in r["findings"]), "a clean file has no finding")
        ok(not any(f["path"].startswith("vendor/") for f in r["findings"]), "an allowlisted path is skipped")
        ok(any(f["path"] == "snap/y.md" and f["known"] for f in r["findings"]), "a known path is listed as known")
        ok(any(f["path"].startswith("docs/<local value #") and f.get("where") == "path" for f in r["findings"]), "a file name is checked, and printed masked")
        ok(not any(f["path"] == "docs/bin.dat" and f["line"] for f in r["findings"]), "binary content is skipped")
        rc, out = captured(report, r); ok(rc == 1 and "local value #" in out, "report fails with numbered values"); no_values(out, "report")
        rc, out = captured(report, r, True); ok(rc == 1 and json.loads(out)["status"] == "failed", "--json"); no_values(out, "report --json")
        rc, out = captured(_terms_cmd, d, False); no_values(out, "terms"); ok(rc == 0 and "factory.local.json" in out, "terms lists sources")
        rc, out = captured(_terms_cmd, d, True); no_values(out, "terms --json")
        ok(len(validate_errors(d)) == len([f for f in r["findings"] if not f["known"]]), "validate_errors mirrors scan --all"); no_values("\n".join(validate_errors(d)), "validate")
        # --rev reads a commit's tree; a later fix is clean at HEAD
        for p in ("docs/a.md", "docs/word.md", "docs/ip.md"): open(os.path.join(d, p), "w").write("example_app on example_vm\n")
        g("rm", "-q", "--cached", "docs/zorblax-notes.md", "docs/bin.dat"); os.remove(os.path.join(d, "docs", "zorblax-notes.md"))
        g("add", "docs"); g("commit", "-q", "-m", "scrub")
        ok(not [f for f in scan(d, "rev", "HEAD")["findings"] if not f["known"]], "clean at HEAD after the scrub")
        ok(any(f["path"] == "docs/a.md" for f in scan(d, "rev", "HEAD~1")["findings"]), "--rev HEAD~1 still sees the old tree")
        # staged: only added lines and new paths
        open(os.path.join(d, "docs", "clean.md"), "a").write("ok line\nping 198.51.100.77\n")
        g("add", "docs/clean.md")
        s = scan(d, "staged"); ok([(f["path"], f["line"]) for f in s["findings"]] == [("docs/clean.md", 4)], f"staged finds the added line {s['findings']}")
        g("reset", "-q")
        open(os.path.join(d, "docs", "clean.md"), "w").write("nothing here\nan example_app on example.com\n")
        # messages
        ok(scan_message("fix\n\nfor jdoe\n# jdoe in a comment is ignored\n", d)[0]["line"] == 3, "a message line is found, comments skipped")
        ok(not scan_message("fix the example_app\n", d), "a clean message passes")
        # hooks block a commit and a push; nothing leaks into their output
        open(os.path.join(d, ".git", "hooks", "pre-commit"), "w").write("#!/bin/sh\necho old-hook-ran > \"$(git rev-parse --git-dir)/old-ran\"\n")
        os.chmod(os.path.join(d, ".git", "hooks", "pre-commit"), 0o755)
        os.makedirs(os.path.join(d, ".claude", "scripts")); shutil.copy(os.path.abspath(__file__), os.path.join(d, ".claude", "scripts", "leakcheck.py"))
        rc, out = captured(install_hook, d); ok(rc == 0 and hook_installed(d), "hooks installed")
        ok(os.path.exists(os.path.join(d, ".git", "hooks", "pre-commit.pre-leakcheck")), "the old hook is kept")
        g("add", ".claude"); c = g("commit", "-q", "-m", "add the script", check=False)
        ok(c.returncode == 0 and os.path.exists(os.path.join(d, ".git", "old-ran")), f"a clean commit passes and the old hook still runs {c.stderr[-300:]}")
        open(os.path.join(d, "docs", "clean.md"), "a").write("ask jdoe\n"); g("add", "docs/clean.md")
        c = g("commit", "-q", "-m", "x", check=False)
        ok(c.returncode != 0 and "local value #" in c.stdout + c.stderr, "the pre-commit hook blocks an added value"); no_values(c.stdout + c.stderr, "pre-commit hook")
        g("reset", "-q", "--hard")
        c = g("commit", "-q", "--allow-empty", "-m", "ping the zorblax team", check=False)
        ok(c.returncode != 0, "the commit-msg hook blocks a value in a message"); no_values(c.stdout + c.stderr, "commit-msg hook")
        # push: a bare remote; a commit made with --no-verify is still stopped at the push
        bare = os.path.join(d, "..", os.path.basename(d) + "-remote.git")
        try:
            subprocess.run(["git", "init", "-q", "--bare", bare], check=True, capture_output=True)
            g("remote", "set-url", "origin", bare)
            c = g("push", "-q", "origin", "main", check=False)
            ok(c.returncode != 0, "pre-push stops a first push of a branch whose new commits added values")
            no_values(c.stdout + c.stderr, "pre-push hook (first push)")
            g("push", "-q", "--no-verify", "origin", "main")
            open(os.path.join(d, "docs", "clean.md"), "a").write("host 198.51.100.77\n"); g("add", "docs/clean.md")
            g("commit", "-q", "--no-verify", "-m", "sneak")
            c = g("push", "-q", "origin", "main", check=False)
            ok(c.returncode != 0 and "local value #" in c.stdout + c.stderr, f"pre-push blocks a commit made with --no-verify {c.stderr[-300:]}")
            no_values(c.stdout + c.stderr, "pre-push hook")
            g("reset", "-q", "--hard", "HEAD~1")
            open(os.path.join(d, "docs", "clean.md"), "a").write("fine\n"); g("add", "docs/clean.md"); g("commit", "-q", "-m", "fine")
            c = g("push", "-q", "origin", "main", check=False); ok(c.returncode == 0, f"a clean push passes {c.stderr[-300:]}")
        finally:
            shutil.rmtree(bare, ignore_errors=True)
        # no local values: nothing to look for, and that is not a failure
        for p in ("factory.local.json", "leak-denylist.txt"): os.remove(os.path.join(d, "state", p))
        shutil.rmtree(os.path.join(d, "state", "application", "quux_vm_app"))
        rc, out = captured(report, scan(d, "all")); ok(load_terms(d) == [] and rc == 0, "no denylist: nothing to find, passes")
    if old is not None: os.environ["FACTORY_LOCAL"] = old
    ok(_pattern("ab-cd") .startswith("(?<!") and _pattern("abcdef_g") == r"abcdef[-_ ]?g", "pattern shapes")
    ok(_added_lines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +2,2 @@\n+one\n+two\n") == {"x": [(2, "one"), (3, "two")]}, "diff parsing")
    for f in fails: print("FAIL", f)
    print("leakcheck self-test:", "ok" if not fails else f"{len(fails)} failure(s)")
    return 1 if fails else 0


def _terms_cmd(root, as_json):
    T = load_terms(root)
    if as_json:
        print(json.dumps({"terms": len(T), "sources": [{"n": t["n"], "source": t["source"]} for t in T]}, indent=2))
    else:
        for t in T: print(f"local value #{t['n']}: {t['source']}")
        print(f"{len(T)} local value(s)")
    return 0


def main(argv):
    if argv[:1] == ["--self-test"]: return self_test()
    if argv[:1] in (["-h"], ["--help"]): print(__doc__); return 0
    cmd = argv[0] if argv and not argv[0].startswith("-") else "scan"
    rest = argv[1:] if argv and not argv[0].startswith("-") else argv
    as_json = "--json" in rest
    if _git(ROOT, "rev-parse", "--git-dir", check=False).returncode != 0:
        print("leakcheck: not a git repository", file=sys.stderr); return 2
    try:
        if cmd == "scan":
            if "--staged" in rest: return report(scan(ROOT, "staged"), as_json, "the staged changes")
            if "--rev" in rest:
                i = rest.index("--rev")
                if i + 1 >= len(rest): print(__doc__); return 2
                return report(scan(ROOT, "rev", rest[i + 1]), as_json, rest[i + 1])
            return report(scan(ROOT, "all"), as_json)
        if cmd == "msg":
            if not rest: print(__doc__); return 2
            with open(rest[0], errors="replace") as f: text = f.read()
            fs = scan_message(text)
            for x in fs: print(f"commit message line {x['line']}: local value #{x['n']} ({x['source']})")
            if fs: print("leakcheck: the commit message names this machine's private values; reword it."); return 1
            return 0
        if cmd == "push":
            remote = rest[0] if rest else "origin"
            return report(scan_push(ROOT, remote, sys.stdin.read()), as_json, "the commits being pushed")
        if cmd == "terms": return _terms_cmd(ROOT, as_json)
        if cmd == "install-hook": return install_hook(ROOT)
    except RuntimeError as e:
        print(f"leakcheck: could not run: {e}", file=sys.stderr); return 2
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
