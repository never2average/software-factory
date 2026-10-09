#!/usr/bin/env python3
"""repo.py — an application's own repository on GitHub or GitLab. ONLY when the operator asks for one.

  repo.py <app_id> status                     does this app have a repository, where, and what would be pushed
  repo.py <app_id> publish --provider github|gitlab [--owner <account-or-group>] [--name <repo>]
                           [--host <gitlab server>] [--dry-run]
                                              create a PRIVATE repository and push the app into it. Run again, it
                                              pushes to the same repository. There is no flag that makes one public.
  repo.py <app_id> push [--dry-run]           one new commit, when the app changed since the last push
  repo.py <app_id> auto-push on|off           let a finished deploy or test run push by itself (off unless you say so)
  repo.py <app_id> unlink                     forget the link in state; the repository itself is never deleted
  repo.py --self-test                         offline: local bare repositories and stand-in gh / glab / vercel commands

Nothing in the factory runs this by itself. mint.py only prints one line saying whether a repository exists. The one
exception is opt-in: with `repository.auto_push: true` in the app's infrastructure.json, a deploy that finished and a
lane run that was recorded push a commit (`repo.py <app_id> auto`, which does nothing at all otherwise).

WHAT GOES IN. Assembled in a scratch directory outside the factory checkout (never under build/, never in this
repository's git):
  - the app's code as a deploy builds it: the mold snapshot, the app's brand (branding.py) and its packs (packs.py),
    with no node_modules, no build output, no .env files, no logs, and without the mold's own CI (.github/);
  - factory/: the brief, the four state files (they hold secret NAMES only), the packs with their versions;
  - FACTORY.md: which mold and which exact upstream commit, which packs, when, and that the repository is a generated
    record: changes belong in the factory (base changes upstream by pull request, app changes in the pack).
One commit per publish or push, authored as the factory, its message naming the mold commit and the reason.

THE SECRET GATE runs before every commit and cannot be turned off: every file is scanned for provider tokens, private
key blocks, connection strings that carry a password, .env files, the private halves of the SSH keys the app names,
and the VALUE of every secret the factory can resolve for the app (compared by hash; the values are never kept or
printed). One finding refuses the whole push, naming the file and the line.

CREDENTIALS. One per provider, shared by every app, never in the repository or in state:
  GitHub   the `gh` command's own sign-in on this machine; --owner defaults to that account
  GitLab   the `glab` command if installed, else a token read from the environment by NAME (GITLAB_TOKEN);
           --host for a company's own server (default gitlab.com)
State keeps only provider, host, owner, name, url, last_commit and auto_push (infrastructure.json `repository`).
"""
import base64, contextlib, datetime, hashlib, io, json, os, re, shutil, subprocess, sys, tempfile
import urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts")
sys.path.insert(0, S)
import branding, library, packs
sys.path.insert(0, os.path.join(S, "lib")); from factory_local import mold_source, repo_slug

ENV = dict(os.environ)                      # what every child process sees; the self-test swaps it for stand-ins
AUTHOR = ("Software Factory", "factory@software-factory.invalid")
BRANCH = "main"
TOKEN_NAME = "GITLAB_TOKEN"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$")
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$")
STATE_FILES = ("application", "infrastructure", "datastores", "datainfra")
REPO_KEYS = ("provider", "host", "owner", "name", "url", "last_commit", "auto_push")
# Never part of an app's repository. rsync also honours the mold's own .gitignore (build output, caches).
LEFT_OUT = ("node_modules", ".next", ".vercel", ".eve", ".git", ".github", ".env*", "*.log", "__pycache__", "*.pyc", ".DS_Store")
WHEN = "Assembled: "                        # the one line of FACTORY.md that differs between two identical builds

class Stop(Exception):
    """A refusal in plain words. Nothing was created or pushed unless the message says so."""

def load(p): return json.load(open(p))
def save(p, o): json.dump(o, open(p, "w"), indent=2); open(p, "a").write("\n")
def adir(app): return os.path.join(ROOT, "state", "application", app)
def which(tool): return shutil.which(tool, path=ENV.get("PATH"))
def run(cmd, cwd=None, input=None, env=None):
    return subprocess.run(cmd, cwd=cwd, input=input, env=dict(ENV, GIT_TERMINAL_PROMPT="0", **(env or {})), capture_output=True, text=True)
def home(): return ENV.get("HOME") or os.path.expanduser("~")
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
def mb(n): return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{max(1, round(n / 1024))} KB"

def docs(app):
    d = adir(app)
    if not os.path.isfile(os.path.join(d, "application.json")) or not os.path.isfile(os.path.join(d, "infrastructure.json")):
        raise Stop(f"{app}: no such application (state/application/{app}/ has no application.json and infrastructure.json). "
                   f"See them all: python3 .claude/scripts/mint.py list")
    return load(os.path.join(d, "application.json")), load(os.path.join(d, "infrastructure.json"))

def mold_entry(mold_id):
    for m in load(os.path.join(ROOT, "state", "factory.json")).get("molds", []):
        if m.get("mold_id") == mold_id: return m
    raise Stop(f"state/factory.json has no mold {mold_id!r}")

# ---- what an app's repository contains ---------------------------------------------------------------------------

@contextlib.contextmanager
def scratch(keep=False):
    """A private directory outside the factory checkout. Removed afterwards, by its own name and nothing else."""
    d = tempfile.mkdtemp(prefix="sf-repo-")
    if os.path.realpath(d).startswith(os.path.realpath(ROOT) + os.sep): raise Stop(f"the scratch directory {d} is inside the factory checkout; set TMPDIR to somewhere else")
    try: yield d
    finally:
        if not keep and os.path.basename(d).startswith("sf-repo-") and os.path.isdir(d): shutil.rmtree(d, ignore_errors=True)

def pack_record(pack_id):
    m = load(os.path.join(packs.PACKS, pack_id, "pack.json")); files = packs.pack_files(pack_id); h = hashlib.sha256()
    for f in files:
        h.update(f.encode() + b"\0"); h.update(open(os.path.join(packs.PACKS, pack_id, "files", f), "rb").read())
    return {"pack_id": pack_id, "name": m.get("name", ""), "version": m.get("version", "unversioned"), "files": len(files), "sha256": h.hexdigest()}

def tree_files(tree):
    out = []
    for d, ds, fs in os.walk(tree):
        ds.sort()
        for f in sorted(fs): out.append(os.path.relpath(os.path.join(d, f), tree))
    return out

def factory_md(m):
    packs_line = ", ".join(f"`{p['pack_id']}` {p['version']}" for p in m["packs"]) or "none (this app is the mold as it comes)"
    deployed = m.get("deployed_mold_commit")
    return f"""# {m['product_name']}: a generated record

This repository was written by the software factory. It is a copy of the application `{m['app_id']}` as the factory
builds it for a deploy, kept so the code has a home outside the factory. Nobody works in it.

app_id: {m['app_id']}
Mold: `{m['mold_id']}`, a snapshot of {m['mold_repo']}
Mold commit: {m['mold_commit']}
Packs: {packs_line}
{WHEN}{m['assembled_at']} by the factory at commit {m['factory_commit']}
{"Running now: the mold commit above." if deployed == m['mold_commit'] else f"Running now: mold commit {deployed}; the next deploy brings it to the commit above." if deployed else "Running now: not deployed yet."}

## What is here

- The application's code: the mold at the commit above, with this app's brand and packs applied.
- `factory/brief.md`: the page of plain words the app was made from.
- `factory/state/`: the four state files. They name secrets; they never hold a secret's value.
- `factory/packs.json`: each pack, its version and a checksum of its files.
- `factory/manifest.json`: the facts on this page, for a program to read.

Left out on purpose: installed packages (`node_modules`), build output, `.env` files, logs, and the mold's own
continuous-integration folder (`.github/`), which belongs to the upstream repository.

## Do not edit this repository

The next push from the factory replaces whatever is here. A change belongs in one of two places:

- a change to the base product goes to {m['mold_repo']} as a pull request, and reaches this app when the factory
  refreshes its snapshot;
- a change that is this application's own (its specialists, its instructions, its wording) goes in its pack,
  `packs/<pack_id>/` in the factory.

## Rebuild it

In the factory checkout, with the mold at the commit above:

    python3 .claude/scripts/mint.py {m['app_id']} run          # build, deploy and test the app
    python3 .claude/scripts/repo.py {m['app_id']} push         # write this repository again
"""

def assemble(app_id, dest):
    """dest/ = the app's code as a deploy builds it, plus factory/ and FACTORY.md. -> the manifest."""
    app, infra = docs(app_id); mold = mold_entry(app["mold_id"]); src = mold.get("source") or {}
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    if not os.path.isdir(mold_dir): raise Stop(f"{app['mold_id']} has no codebase (molds/{app['mold_id']}/codebase), so there is nothing to put in a repository")
    if not src.get("commit"): raise Stop(f"state/factory.json records no upstream commit for {app['mold_id']}, so the repository could not say what it was built from")
    os.makedirs(dest)
    r = run(["rsync", "-a"] + [x for e in LEFT_OUT for x in ("--exclude", e)] + ["--filter=:- .gitignore", mold_dir + "/", dest + "/"])
    if r.returncode: raise Stop("could not copy the mold: " + r.stderr.strip()[-300:])
    for clash in ("factory", "FACTORY.md"):
        if os.path.lexists(os.path.join(dest, clash)): raise Stop(f"{app['mold_id']} already has {clash} at its root, which is where the factory writes its own record")
    # The generators the brand and the packs run are the mold's own; they find installed packages through this link,
    # which is removed before anything is scanned or committed.
    nm = os.path.join(mold_dir, "node_modules"); link = os.path.join(dest, "node_modules")
    if os.path.isdir(nm): os.symlink(nm, link)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            b = branding.resolve(app)
            if b: branding.apply_overlay(dest, b, load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json")))
            if app.get("packs") or library.install(app) == "all": packs.apply(app_id, build=dest)   # also names the starter library state asks for
    except SystemExit as e:
        raise Stop(f"the app could not be assembled the way a deploy assembles it: {e}")
    finally:
        if os.path.islink(link): os.unlink(link)
    m = {"app_id": app_id, "product_name": ((app.get("surface") or {}).get("branding") or {}).get("product_name") or app_id,
         "mold_id": app["mold_id"], "mold_repo": repo_slug(mold_source(app["mold_id"], os.path.join(ROOT, "state"))) or "its upstream repository", "mold_commit": src["commit"],
         "mold_snapshot_date": src.get("snapshot_date"), "deployed_mold_commit": app.get("mold_commit"),
         "packs": [pack_record(p) for p in app.get("packs") or []]}
    f = os.path.join(dest, "factory"); os.makedirs(os.path.join(f, "state"))
    brief = app.get("brief") if isinstance(app.get("brief"), str) else f"briefs/{app_id}.md"
    if os.path.isfile(os.path.join(ROOT, brief)): shutil.copyfile(os.path.join(ROOT, brief), os.path.join(f, "brief.md"))
    for n in STATE_FILES:
        p = os.path.join(adir(app_id), n + ".json")
        if not os.path.isfile(p): continue
        if n == "infrastructure":
            # Where this repository lives and what was last pushed is the factory's note, not the app's: left out,
            # so a push does not change the very thing it pushes.
            save(os.path.join(f, "state", n + ".json"), {k: v for k, v in infra.items() if k != "repository"})
        else: shutil.copyfile(p, os.path.join(f, "state", n + ".json"))
    save(os.path.join(f, "packs.json"), m["packs"]); save(os.path.join(f, "manifest.json"), m)
    head = run(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout.strip() or "unknown"
    open(os.path.join(dest, "FACTORY.md"), "w").write(factory_md(dict(m, assembled_at=now(), factory_commit=head)))
    files = tree_files(dest)
    bad = [p for p in files if any(part in ("node_modules", ".next", ".vercel", ".eve", ".git") for part in p.split(os.sep))
           or os.path.basename(p).endswith(".log")]
    if bad: raise Stop(f"the assembled tree still holds {len(bad)} file(s) that never belong in a repository, e.g. {bad[0]}")
    m["files"] = len(files); m["bytes"] = sum(os.lstat(os.path.join(dest, p)).st_size for p in files)
    return m

# ---- the secret gate ---------------------------------------------------------------------------------------------

MIN_VALUE = 8
TOKENS = [(what, re.compile(rx)) for what, rx in (
    ("a GitHub token", rb"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    ("a GitHub token", rb"\bgithub_pat_[A-Za-z0-9_]{40,}"),
    ("a GitLab token", rb"\bgl(?:pat|dt|rt|ptt|oas|soat|cbt|ft|imt|agent)-[A-Za-z0-9_.-]{20,}"),
    ("an AWS access key", rb"\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}\b"),     # not AWS's own documentation key
    ("a Slack token", rb"\bxox[abprs]-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9-]{20,}"),
    ("an Anthropic or OpenAI key", rb"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}"),
    ("a Resend key", rb"\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}"),
    ("an npm token", rb"\bnpm_[A-Za-z0-9]{36}\b"),
    ("a Google API key", rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("a Vercel Blob token", rb"\bvercel_blob_rw_[A-Za-z0-9]{12,}_[A-Za-z0-9]{24,}"),
    ("a Stripe live key", rb"\b[sr]k_live_[A-Za-z0-9]{20,}"),
    ("a Neon database password", rb"\bnpg_[A-Za-z0-9]{12,}"),
    ("a private key block", rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----"),
)]
B64_PEM = re.compile(rb"LS0tLS1CRUdJTi[A-Za-z0-9+/=]{24,}")        # base64 of "-----BEGIN ", as an env file stores a key
CONN = re.compile(rb"\b[A-Za-z][A-Za-z0-9+.-]{1,24}://([^\s/:@'\"`<>\\,;()]{1,128}):([^\s/@'\"`<>\\,;()]{1,256})@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)")
# Not a credential: a password that is plainly a stand-in in documentation or a template (a word like "password", a
# ${VARIABLE}, an ellipsis, one or two characters), or an address nobody else can reach or that cannot exist: this
# machine itself, and the names reserved for examples and tests. A REAL password is still caught wherever it is
# written, because every value the factory can resolve is compared by hash whatever the address around it says.
PLACEHOLDER = re.compile(rb"[$<>{}*%\[\]#]|\xe2\x80\xa6|^(?:.{1,2}|pass(?:word|wd)?|pw|pwd|secret|x{3,}|\.{3}|changeme|example|test|postgres|user|token|key|redacted)$", re.I)
NOWHERE = re.compile(rb"^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]|(?:.*\.)?example\.(?:com|org|net)|.*\.(?:example|test|invalid|localhost))$", re.I)
KEY_FILES = ("id_rsa", "id_ed25519", "id_ecdsa", "id_dsa")
SECRET_WORD = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DSN")

class Values:
    """The secret values the factory could resolve for one app, kept only as (first four bytes, length, SHA-256).
    The four bytes let the scan find where a value might start; the hash decides. No value is stored or printed."""
    def __init__(self): self.by_prefix = {}; self.names = set(); self.notes = []
    def add(self, name, value):
        if value is None: return
        v = value.encode() if isinstance(value, str) else value
        forms = {v.strip(), v.strip().replace(b"\\n", b"\n"), v.strip().replace(b"\n", b"\\n")}
        forms |= {l.strip() for x in list(forms) for l in x.split(b"\n") if len(l.strip()) >= 40}     # each long line of a key
        m = CONN.match(v.strip())
        if m: forms |= {m.group(2), urllib.parse.unquote_to_bytes(m.group(2))}                          # the password alone
        for x in forms:
            if len(x) < MIN_VALUE or x.startswith(b"-----"): continue
            self.by_prefix.setdefault(x[:4], set()).add((len(x), hashlib.sha256(x).digest(), name)); self.names.add(name)

def refs_in(o):
    """Every NAME a state file points at: the value of any key ending _ref."""
    if isinstance(o, dict):
        for k, v in o.items():
            if k.endswith("_ref") and isinstance(v, str): yield k, v
            else: yield from refs_in(v)
    elif isinstance(o, list):
        for v in o: yield from refs_in(v)

def public_by_design(name, value, infra):
    """Not a secret, although it travels with the secrets: a build flag, a value every browser receives, a plain address."""
    if "PUBLIC" in name or name in (infra.get("runtime_env") or {}): return True       # NEXT_PUBLIC_*, and the public half of a key pair
    return bool(re.fullmatch(r"https?://[^\s:@?]+(:\d+)?(/[^\s?@]*)?", value.strip()))

def vercel_values(project):
    """The production values of one Vercel project, read into a private file that is deleted at once."""
    base = os.path.join(home(), ".cache", "software-factory"); os.makedirs(base, mode=0o700, exist_ok=True)
    d = tempfile.mkdtemp(prefix="sf-repo-env-", dir=base); f = os.path.join(d, "env"); vals = {}; hidden = []
    try:
        run(["vercel", "env", "pull", "--yes", "--environment=production", "--project", project, f], cwd=d)
        for l in (open(f) if os.path.exists(f) else []):
            if "=" in l and not l.startswith("#"):
                k, v = l.split("=", 1); k, v = k.strip(), v.strip().strip('"')
                (hidden.append(k) if v == "[SENSITIVE]" else vals.__setitem__(k, v))
    finally:
        if os.path.basename(d).startswith("sf-repo-env-"): shutil.rmtree(d, ignore_errors=True)
    return vals, hidden

def resolve_values(app_id, app, infra, P=None):
    """Every secret value the factory can get at for this app, as hashes. Says where it looked and what it could not read."""
    V = Values(); state = [app, infra] + [load(p) for p in (os.path.join(adir(app_id), n + ".json") for n in ("datastores", "datainfra")) if os.path.isfile(p)]
    declared = {n for k in ("secrets", "secrets_user", "secrets_derived", "secrets_optional") for n in infra.get(k) or []}
    refs = dict((v, k) for k, v in refs_in(state))
    ssh = {v for v, k in refs.items() if k == "ssh_key_ref"}
    names = declared | (set(refs) - ssh) | {TOKEN_NAME, "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "VERCEL_TOKEN"}
    got = {}
    for n in sorted(names):
        if ENV.get(n): got[n] = ENV[n]
    env_n = len(got); vercel_n = 0; hidden = set()
    proj = (infra.get("vercel") or {}).get("project")
    if infra.get("target") == "vercel" and proj and which("vercel"):
        for p in (proj, proj + "-api", proj + "-workflow"):
            vals, hid = vercel_values(p); hidden |= set(hid)
            for k, v in vals.items():
                if k in declared or SECRET_WORD.search(k) or CONN.match(v.encode()): got.setdefault(k, v); vercel_n += 1
        V.notes.append(f"Vercel ({proj} and its two services): {vercel_n} value(s) read" + (f"; {len(hidden)} write-only, so not comparable: {', '.join(sorted(hidden))}" if hidden else ""))
    elif infra.get("target") == "vm_remote":
        V.notes.append("the app's own server keeps its values in files only that server can read, so they were not compared; the patterns below still apply")
    public = {v for k, v in got.items() if public_by_design(k, v, infra)}
    for k, v in got.items():
        if v not in public: V.add(k, v)
    if env_n: V.notes.append(f"this machine's environment: {env_n} named value(s)")
    # The shared provider credential itself, and what the factory keeps privately for this app.
    for label, cmd in (("the GitHub sign-in", ["gh", "auth", "token"]),) + ((("the GitLab sign-in", ["glab", "config", "get", "token", "--host", P.host]),) if P is not None and P.id == "gitlab" else ()):
        if which(cmd[0]):
            r = run(cmd)
            if r.returncode == 0 and r.stdout.strip(): V.add(label, r.stdout.strip())
    sess = os.path.join(home(), ".cache", "software-factory", f"{app_id}.session.json")
    if os.path.isfile(sess):
        try: V.add("the operator's saved sign-in for this app", load(sess).get("token"))
        except (ValueError, OSError): pass
    local = os.path.join(ROOT, "infra", "vm", "apps", app_id)
    for d, _, fs in os.walk(local) if os.path.isdir(local) else []:
        for f in fs:
            if f == ".pg-admin" or f.startswith(".env") or f.endswith(".key"):
                try: body = open(os.path.join(d, f), "rb").read()
                except OSError: continue
                for l in body.splitlines():
                    V.add(f"a value in infra/vm/apps/{app_id}/{f}", l.split(b"=", 1)[-1].strip().strip(b'"') if b"=" in l and not l.startswith(b"-") else l)
    for ref in sorted(ssh):
        p = os.path.join(home(), ".ssh", ref)
        if os.path.isfile(p):
            try: V.add(f"the private half of the SSH key {ref}", open(p, "rb").read())
            except OSError: V.notes.append(f"the SSH key {ref} could not be read, so its private half was not compared")
    V.ssh = ssh
    return V

def scan(tree, V=None, files=None):
    """-> [(file, line, what)] for everything in the tree that must never be pushed. The value itself is never returned."""
    found = set(); files = tree_files(tree) if files is None else files; ssh = getattr(V, "ssh", set()) if V else set()
    for rel in files:
        p = os.path.join(tree, rel); base = os.path.basename(rel)
        if base == ".env" or base.startswith(".env."): found.add((rel, 0, "an environment file (.env); these hold secret values"))
        if base in KEY_FILES or base in ssh: found.add((rel, 0, "a file named like the private half of an SSH key"))
        if os.path.islink(p): continue
        try: data = open(p, "rb").read()
        except OSError as e: found.add((rel, 0, f"a file that could not be read ({e.strerror}), so it could not be checked")); continue
        line = lambda i: data.count(b"\n", 0, i) + 1
        for what, rx in TOKENS:
            for m in rx.finditer(data): found.add((rel, line(m.start()), what))
        for m in B64_PEM.finditer(data):
            try: head = base64.b64decode(m.group(0)[:len(m.group(0)) // 4 * 4][:400])
            except ValueError: continue
            if b"PRIVATE KEY" in head: found.add((rel, line(m.start()), "a private key block (base64-encoded)"))
        for m in CONN.finditer(data):
            if not PLACEHOLDER.search(m.group(2)) and not NOWHERE.match(m.group(3).rstrip(b".")): found.add((rel, line(m.start()), "a connection string with a password in it"))
        for prefix, entries in (V.by_prefix.items() if V else ()):
            i = data.find(prefix)
            while i >= 0:
                for n, digest, name in entries:
                    if hashlib.sha256(data[i:i + n]).digest() == digest: found.add((rel, line(i), f"the value of {name}"))
                i = data.find(prefix, i + 1)
    return sorted(found)

def refusal(findings):
    lines = [f"  {f}{':' + str(n) if n else ''}: {what}" for f, n, what in findings[:40]]
    if len(findings) > 40: lines.append(f"  … and {len(findings) - 40} more")
    return ("REFUSED: the secret gate found something that must never be pushed. Nothing was committed and nothing was pushed.\n"
            + "\n".join(lines) + "\nThe values are not shown here on purpose. Remove each one at its source (the mold upstream, the pack, or the "
            "state file), treat any real credential among them as exposed and replace it, then ask again.")

# ---- the providers: one shared credential each ---------------------------------------------------------------------

GH_HELP = """GitHub is not signed in on this machine, so nothing was created.

What I need: this machine signed in to GitHub once, so the factory can create the app's private repository and push to it.
It is one sign-in for every app and takes about two minutes.

1. In the terminal on this machine, run:

    gh auth login --hostname github.com --git-protocol https --web

2. It prints an eight-character code and a web address. Open the address in your browser.
3. Type the code into the box that says "Enter the code displayed on your device" and click "Continue".
4. Click "Authorize github".

Then ask me again for the repository. The sign-in is kept by the gh command on this machine; the factory never sees
your password and stores nothing about it in the repository or the state files."""

def gitlab_help(host):
    return f"""GitLab is not set up on this machine yet, so nothing was created.

What I need: one access token from GitLab, so the factory can create this app's private project and push to it.
It is one token for every app, and it takes about three minutes.

1. Open https://{host}/-/user_settings/personal_access_tokens
2. Click "Add new token".
3. In "Token name" type:

    software-factory

4. In "Expiration date" pick a date (three months from now is a good choice).
5. Under "Select scopes" tick only "api". Leave every other box empty.
6. Click "Create token" (older servers call the button "Create personal access token").
7. GitLab shows the token once. Copy it.
8. In the terminal on this machine (not in this chat), run this line, paste the token when it asks, and press Enter.
   Nothing appears while you paste; that is the hidden prompt working.

    read -rsp "Paste the token: " T && printf 'export {TOKEN_NAME}=%s\\n' "$T" >> ~/.profile && chmod 600 ~/.profile && unset T && echo " saved"

9. Close this Claude Code session and start a new one, so it picks the token up.

Then ask me again for the repository. "api" is the smallest permission GitLab offers that can create a project; the
token is read from this machine's own environment under the name {TOKEN_NAME}, is never written to the repository, the
state files or this chat, and stops working on the date you picked."""

class GitHub:
    id = "github"; host = "github.com"
    def ready(self): return bool(which("gh"))
    def need(self):
        if not self.ready(): raise Stop(GH_HELP)
    def account(self, offline=False):
        """The signed-in account. Read from gh's own settings file first, which asks nobody."""
        if not self.ready(): return None
        r = run(["gh", "config", "get", "user", "-h", self.host]); name = r.stdout.strip() if r.returncode == 0 else ""
        if not name and not offline:
            r = run(["gh", "api", "user", "--jq", ".login"]); name = r.stdout.strip() if r.returncode == 0 else ""
            if not name: raise Stop(GH_HELP)
        return name or None
    def view(self, owner, name):
        r = run(["gh", "repo", "view", f"{owner}/{name}", "--json", "visibility,isEmpty,url"])
        if r.returncode:
            if "Could not resolve" in r.stderr or "not found" in r.stderr.lower(): return None
            if "auth login" in r.stderr or "authentication" in r.stderr.lower(): raise Stop(GH_HELP)
            raise Stop(f"GitHub could not be asked about {owner}/{name}: {r.stderr.strip()[-300:]}")
        j = json.loads(r.stdout); return {"private": j.get("visibility") == "PRIVATE"}
    def create(self, owner, name, about):
        r = run(["gh", "repo", "create", f"{owner}/{name}", "--private", "--description", about])
        if r.returncode: raise Stop(f"GitHub did not create {owner}/{name}: {r.stderr.strip()[-300:]}")
    def git_auth(self): return ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    def web(self, owner, name): return f"https://{self.host}/{owner}/{name}"

class GitLab:
    id = "gitlab"
    def __init__(self, host="gitlab.com"):
        if not HOST_RE.match(host): raise Stop(f"--host is the server's name alone, like gitlab.com or gitlab.example.com, not {host!r}")
        self.host = host
    def ready(self): return bool(which("glab") or ENV.get(TOKEN_NAME))
    def need(self):
        if not self.ready(): raise Stop(gitlab_help(self.host))
    def call(self, method, path, fields=None):
        """-> (status, json). Through glab when it is installed, else the REST API with the token named GITLAB_TOKEN.
        The token travels in a header; it is never part of an address, a command line or a message."""
        if which("glab"):
            r = run(["glab", "api", "--hostname", self.host, "--method", method, path] + [x for k, v in (fields or {}).items() for x in ("-f", f"{k}={v}")])
            if r.returncode == 0:
                try: return 200, json.loads(r.stdout or "{}")
                except ValueError: return 200, {}
            m = re.search(r"\b(40[0-9]|5[0-9]{2})\b", r.stderr + r.stdout); return (int(m.group(1)) if m else 500), {"message": (r.stderr or r.stdout).strip()[-200:]}
        req = urllib.request.Request(f"https://{self.host}/api/v4/{path}", method=method, headers={"PRIVATE-TOKEN": ENV[TOKEN_NAME]},
                                     data=urllib.parse.urlencode(fields).encode() if fields else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            try: return e.code, json.load(e)
            except ValueError: return e.code, {}
        except urllib.error.URLError as e: raise Stop(f"{self.host} could not be reached: {e.reason}")
    def account(self, offline=False):
        if offline or not self.ready(): return None
        st, j = self.call("GET", "user")
        if st in (401, 403): raise Stop(f"{self.host} did not accept the GitLab credential (it may have expired).\n\n" + gitlab_help(self.host))
        if st != 200 or not j.get("username"): raise Stop(f"{self.host} did not say who is signed in (status {st})")
        return j["username"]
    def view(self, owner, name):
        st, j = self.call("GET", "projects/" + urllib.parse.quote(f"{owner}/{name}", safe=""))
        if st == 404: return None
        if st != 200: raise Stop(f"{self.host} could not be asked about {owner}/{name} (status {st})")
        return {"private": j.get("visibility") == "private"}
    def create(self, owner, name, about):
        fields = {"name": name, "path": name, "visibility": "private", "description": about}
        if owner != self.account():
            st, ns = self.call("GET", "namespaces/" + urllib.parse.quote(owner, safe=""))
            if st != 200 or not ns.get("id"): raise Stop(f"{self.host} has no group or account called {owner!r} that this credential can see")
            fields["namespace_id"] = ns["id"]
        st, j = self.call("POST", "projects", fields)
        if st not in (200, 201): raise Stop(f"{self.host} did not create {owner}/{name} (status {st}): {str(j.get('message', ''))[:200]}")
    def git_auth(self):
        helper = "!glab auth git-credential" if which("glab") else f"!f() {{ test \"$1\" = get && printf 'username=oauth2\\npassword=%s\\n' \"${TOKEN_NAME}\"; }}; f"
        return ["-c", "credential.helper=", "-c", "credential.helper=" + helper]
    def web(self, owner, name): return f"https://{self.host}/{owner}/{name}"

def provider(pid, host=None):
    if pid == "github":
        if host and host != "github.com": raise Stop("--host is for GitLab; GitHub is always github.com")
        return GitHub()
    if pid == "gitlab": return GitLab(host or "gitlab.com")
    raise Stop("--provider is github or gitlab")

# ---- commit and push -----------------------------------------------------------------------------------------------

def remote_head(P, remote):
    """-> (branch, commit) of the remote's default branch, or (None, None) for an empty repository."""
    r = run(["git"] + P.git_auth() + ["ls-remote", "--symref", remote, "HEAD"])
    if r.returncode: raise Stop(f"the repository at {remote} could not be read: {r.stderr.strip()[-300:]}")
    b = re.search(r"^ref: refs/heads/(\S+)\s+HEAD", r.stdout, re.M); c = re.search(r"^([0-9a-f]{40})\s+HEAD", r.stdout, re.M)
    return (b.group(1) if b else BRANCH, c.group(1)) if c else (None, None)

def commit_and_push(P, remote, tree, gitdir, scanned, message):
    """One commit of `tree` on top of whatever the remote holds. -> (commit, pushed?). Only ever called by deliver(),
    after the secret gate passed over `scanned`; a file git would add that the gate did not read stops it."""
    gd = os.path.join(gitdir, ".git")
    def g(*a, auth=False, env=None):
        return run(["git"] + (P.git_auth() if auth else []) + ["--git-dir", gd, "--work-tree", tree] + list(a), env=env)
    def must(r, what):
        if r.returncode: raise Stop(f"{what}: {(r.stderr or r.stdout).strip()[-300:]}")
        return r
    must(run(["git", "init", "-q", "-b", BRANCH, gitdir]), "git could not start a repository")
    branch, prev = remote_head(P, remote); fm = os.path.join(tree, "FACTORY.md"); fresh = open(fm).read()
    if prev:
        must(g("fetch", "-q", "--depth", "1", remote, branch, auth=True), "the repository's last commit could not be fetched")
        must(g("update-ref", f"refs/heads/{BRANCH}", prev), "git"); must(g("reset", "-q"), "git")
        old = g("show", f"{prev}:FACTORY.md"); was = re.search(rf"^{re.escape(WHEN)}.*$", old.stdout, re.M) if old.returncode == 0 else None
        if was:
            # Same app, same mold, same packs, same state: only the time of assembly would differ. That is no change.
            open(fm, "w").write(re.sub(rf"^{re.escape(WHEN)}.*$", lambda _: was.group(0), fresh, count=1, flags=re.M))
            must(g("add", "-A"), "git add")
            if g("diff", "--cached", "--quiet").returncode == 0: return prev, False
            open(fm, "w").write(fresh)
    must(g("add", "-A"), "git add")
    staged = set(must(g("ls-files", "-z"), "git").stdout.split("\0")) - {""}
    unread = sorted(staged - set(scanned))
    if unread: raise Stop(f"{len(unread)} file(s) would be committed that the secret gate did not read (e.g. {unread[0]}); nothing was committed")
    who = {"GIT_AUTHOR_NAME": AUTHOR[0], "GIT_AUTHOR_EMAIL": AUTHOR[1], "GIT_COMMITTER_NAME": AUTHOR[0], "GIT_COMMITTER_EMAIL": AUTHOR[1]}
    must(g("-c", "commit.gpgsign=false", "commit", "-q", "-m", message, env=who), "git commit")
    sha = must(g("rev-parse", "HEAD"), "git").stdout.strip()
    must(g("push", "-q", remote, f"HEAD:refs/heads/{branch or BRANCH}", auth=True), "the push was refused")
    return sha, True

def describe(target, m, V, findings, exists):
    t = target; where = f"{t['host']}/{t['owner'] or '<the signed-in account, looked up when publishing>'}/{t['name']}"
    print(f"{m['app_id']} -> {where}  (PRIVATE; {exists})")
    print(f"  what goes in: {m['files']:,} files, {mb(m['bytes'])}")
    print(f"    the app's code: {m['mold_id']} at upstream commit {m['mold_commit']}"
          + (f", packs {', '.join(p['pack_id'] + ' ' + p['version'] for p in m['packs'])}" if m["packs"] else ", no packs")
          + (f", branded \"{m['product_name']}\"" if m["product_name"] != m["app_id"] else ""))
    print("    factory/: the brief, the four state files (secret NAMES only), the packs and their versions")
    print("    FACTORY.md: what it was built from, and that changes belong in the factory")
    print("  left out: node_modules, build output, .env files, logs, the mold's own CI folder (.github/)")
    print(f"  secret gate: {m['files']:,} files read; {len(V.names)} secret value(s) compared by hash; " + ("nothing found" if not findings else f"{len(findings)} finding(s)"))
    for n in V.notes: print(f"    {n}")

def deliver(app_id, target, dry, reason, keep=False):
    """Assemble, pass the gate, and (unless dry) create if needed, commit and push. The ONLY path to a commit."""
    app, infra = docs(app_id); P = provider(target["provider"], target["host"]); rec = infra.get("repository")
    with scratch(keep) as d:
        tree = os.path.join(d, "tree"); m = assemble(app_id, tree); files = tree_files(tree)
        V = resolve_values(app_id, app, infra, P); findings = scan(tree, V, files)
        describe(target, m, V, findings, f"recorded, last pushed {rec['last_commit'][:12]}" if rec and rec.get("last_commit") else "recorded" if rec else "not created yet")
        if keep: print(f"  kept for you to look at: {tree}")
        if findings: print("\n" + refusal(findings)); return 3
        if dry:
            print("\ndry run: nothing was created and nothing was pushed."
                  + ("" if P.ready() else f"\nnote: {'GitHub' if P.id == 'github' else 'GitLab'} is not set up on this machine yet; publishing will say exactly what is needed."))
            return 0
        P.need(); owner = target["owner"] or P.account()
        if not OWNER_RE.match(owner or ""): raise Stop(f"the owner {owner!r} is not an account or group name")
        name = target["name"]; web = P.web(owner, name); remote = web + ".git"; seen = P.view(owner, name)
        about = f"{m['product_name']}: generated by the software factory from {m['mold_id']}. Do not edit here; see FACTORY.md."
        if seen is None:
            if rec: raise Stop(f"{web} is recorded for {app_id} but is no longer there. Nothing was created. To start a new one: python3 .claude/scripts/repo.py {app_id} unlink, then publish again.")
            P.create(owner, name, about); seen = P.view(owner, name); print(f"created {web} (private, empty)")
        if not seen or not seen["private"]:
            raise Stop(f"{web} is not private, and the factory only ever pushes to a private repository. Nothing was pushed. "
                       f"Make it private in its settings page, or unlink it: python3 .claude/scripts/repo.py {app_id} unlink")
        if not rec:
            # Not ours on record: take it only if it is empty, or if its own FACTORY.md says it is this app's.
            _, head = remote_head(P, remote)
            if head:
                probe = os.path.join(d, "probe"); run(["git", "init", "-q", probe])
                run(["git"] + P.git_auth() + ["-C", probe, "fetch", "-q", "--depth", "1", remote, "HEAD"])
                mark = run(["git", "-C", probe, "show", "FETCH_HEAD:FACTORY.md"])
                if mark.returncode or not re.search(rf"^app_id: {re.escape(app_id)}$", mark.stdout, re.M):
                    raise Stop(f"{web} already exists and is not this app's (it has commits, and no FACTORY.md naming {app_id}). Nothing was pushed. "
                               f"Choose another name: python3 .claude/scripts/repo.py {app_id} publish --provider {P.id} --name <another-name>")
        packs_s = ", ".join(f"{p['pack_id']} {p['version']}" for p in m["packs"]) or "none"
        msg = (f"{app_id}: {reason} ({m['mold_id']} at {m['mold_commit'][:12]})\n\nReason: {reason}\nMold: {m['mold_id']}, {m['mold_repo']}\n"
               f"Mold commit: {m['mold_commit']}\nPacks: {packs_s}\n\nWritten by the software factory. Do not edit this repository; see FACTORY.md.")
        sha, pushed = commit_and_push(P, remote, tree, os.path.join(d, "git"), files, msg)
    infra = load(os.path.join(adir(app_id), "infrastructure.json"))
    infra["repository"] = {"provider": P.id, "host": P.host, "owner": owner, "name": name, "url": web, "last_commit": sha,
                           "auto_push": bool((infra.get("repository") or {}).get("auto_push", False))}
    save(os.path.join(adir(app_id), "infrastructure.json"), infra)
    print(f"pushed {sha[:12]} to {web}" if pushed else f"nothing changed since {sha[:12]}; no new commit. {web}")
    return 0

# ---- the commands --------------------------------------------------------------------------------------------------

def others_using(app_id, P, owner, name):
    base = os.path.join(ROOT, "state", "application")
    for other in sorted(os.listdir(base)):
        f = os.path.join(base, other, "infrastructure.json")
        if other in (app_id, "app_id") or not os.path.isfile(f): continue
        r = load(f).get("repository") or {}
        if (r.get("provider"), r.get("host"), str(r.get("owner", "")).lower(), str(r.get("name", "")).lower()) == (P.id, P.host, (owner or "").lower(), name.lower()): return other

def target_of(rec): return {k: rec[k] for k in ("provider", "host", "owner", "name")}

def publish(app_id, pid, owner, name, host, dry, keep=False):
    app, infra = docs(app_id); rec = infra.get("repository")
    if rec:
        asked = {"provider": pid, "owner": owner, "name": name, "host": host}
        differ = [k for k, v in asked.items() if v and v != rec.get(k)]
        if differ: raise Stop(f"{app_id} already has a repository at {rec['url']}, and a publish goes there. To move it somewhere else, "
                              f"first: python3 .claude/scripts/repo.py {app_id} unlink (the old repository is left as it is)")
        return deliver(app_id, target_of(rec), dry, "publish", keep)
    if not pid: raise Stop("say where: --provider github or --provider gitlab")
    P = provider(pid, host); name = name or app_id.replace("_", "-")
    if not NAME_RE.match(name): raise Stop(f"a repository name is letters, digits, dots, dashes and underscores, not {name!r}")
    if owner and not OWNER_RE.match(owner): raise Stop(f"--owner is an account or group name, not {owner!r}")
    owner = owner or P.account(offline=dry)
    clash = others_using(app_id, P, owner, name)
    if clash: raise Stop(f"{P.host}/{owner}/{name} is already {clash}'s repository; every app has its own. Choose another --name.")
    return deliver(app_id, {"provider": P.id, "host": P.host, "owner": owner, "name": name}, dry, "first publish", keep)

def push(app_id, dry, reason="push", keep=False):
    _, infra = docs(app_id); rec = infra.get("repository")
    if not rec: raise Stop(f"{app_id} has no repository. One is made only when asked for: python3 .claude/scripts/repo.py {app_id} publish --provider github --dry-run")
    return deliver(app_id, target_of(rec), dry, reason, keep)

def auto(app_id, reason):
    """What a finished deploy and a recorded lane run call. Does NOTHING unless a repository is recorded AND
    repository.auto_push is true; and it never fails its caller."""
    try:
        rec = docs(app_id)[1].get("repository")
        if not isinstance(rec, dict) or rec.get("auto_push") is not True: return 0
        print(f"repository: auto-push is on for {app_id}; pushing after {reason}")
        rc = push(app_id, False, f"after {reason}")
        if rc: print(f"repository: not pushed (see above); the {reason} itself is unaffected")
    except Stop as e: print(f"repository: not pushed after {reason}: {e}")
    except Exception as e: print(f"repository: not pushed after {reason}: {type(e).__name__}: {str(e)[:200]}")
    return 0

def set_auto(app_id, on):
    _, infra = docs(app_id); rec = infra.get("repository")
    if not rec: raise Stop(f"{app_id} has no repository, so there is nothing to push to automatically. Ask for one first: python3 .claude/scripts/repo.py {app_id} publish --provider github --dry-run")
    rec["auto_push"] = on; save(os.path.join(adir(app_id), "infrastructure.json"), infra)
    print(f"{app_id}: auto-push is {'ON: a finished deploy and a recorded test run each push one commit to ' + rec['url'] if on else 'off: nothing is pushed unless you ask'}")
    return 0

def unlink(app_id):
    _, infra = docs(app_id); rec = infra.pop("repository", None)
    if not rec: print(f"{app_id} has no repository recorded; nothing to forget"); return 0
    save(os.path.join(adir(app_id), "infrastructure.json"), infra)
    print(f"{app_id}: forgot {rec['url']}. The repository itself was not touched and still holds everything pushed so far; "
          f"if you want it gone, delete it yourself in its settings page.")
    return 0

def status_line(infra, app_id="<app>"):
    """One line for mint.py: never a station, never something that runs."""
    rec = (infra or {}).get("repository")
    if not isinstance(rec, dict): return f"repository: none (ask for one: repo.py {app_id} publish --provider github|gitlab --dry-run)"
    return (f"repository: {rec.get('url')} (private; last pushed {str(rec.get('last_commit') or 'never')[:12]}; "
            f"auto-push {'on' if rec.get('auto_push') is True else 'off'})")

def status(app_id, keep=False):
    app, infra = docs(app_id); rec = infra.get("repository"); print(status_line(infra, app_id))
    with scratch(keep) as d:
        tree = os.path.join(d, "tree"); m = assemble(app_id, tree); V = resolve_values(app_id, app, infra); findings = scan(tree, V)
        t = target_of(rec) if rec else {"provider": "-", "host": "<provider>", "owner": "<owner>", "name": app_id.replace("_", "-")}
        print("what a push would send:" if rec else "what a publish would send:")
        describe(t, m, V, findings, "recorded" if rec else "not created; nothing is created until you ask")
        if keep: print(f"  kept for you to look at: {tree}")
        if findings: print("\n" + refusal(findings)); return 3
    return 0

def opt(a, k):
    if k not in a: return None
    i = a.index(k)
    if i + 1 >= len(a) or a[i + 1].startswith("--"): raise Stop(f"{k} needs a value")
    return a[i + 1]

def main(a):
    if "--self-test" in a: return self_test()
    if len(a) < 2 or a[0].startswith("-"): sys.exit(__doc__)
    app_id, cmd, rest = a[0], a[1], a[2:]
    known = {"status": ("--keep",), "publish": ("--provider", "--owner", "--name", "--host", "--dry-run", "--keep"), "push": ("--dry-run", "--keep"),
             "unlink": (), "auto": ("--reason",), "auto-push": ()}
    try:
        if cmd not in known: sys.exit(__doc__)
        stray = [x for x in rest if x.startswith("--") and x not in known[cmd]]
        if stray: raise Stop(f"{cmd} has no {stray[0]}." + (" A repository made by the factory is always private." if "public" in stray[0] or "visib" in stray[0] else ""))
        keep = "--keep" in rest
        if cmd == "status": return status(app_id, keep)
        if cmd == "publish": return publish(app_id, opt(rest, "--provider"), opt(rest, "--owner"), opt(rest, "--name"), opt(rest, "--host"), "--dry-run" in rest, keep)
        if cmd == "push": return push(app_id, "--dry-run" in rest, keep=keep)
        if cmd == "unlink": return unlink(app_id)
        if cmd == "auto": return auto(app_id, opt(rest, "--reason") or "a factory step")
        if cmd == "auto-push":
            if rest not in (["on"], ["off"]): raise Stop("auto-push on, or auto-push off")
            return set_auto(app_id, rest == ["on"])
    except Stop as e:
        print(str(e), file=sys.stderr); return 1

def self_test():
    sys.path.insert(0, os.path.join(S, "lib")); import repo_selftest
    return repo_selftest.run(sys.modules[__name__])

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
