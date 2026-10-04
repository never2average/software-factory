"""Offline tests of repo.py (run: python3 .claude/scripts/repo.py --self-test).

Nothing here reaches GitHub, GitLab or Vercel. A small factory is built in a temporary directory; `gh`, `glab` and
`vercel` are stand-in scripts that come first on PATH; every https://github.com/ and https://gitlab.example.com/
address is rewritten by git itself to a local bare repository, and git is told it may use local files only.

Every secret-shaped string below is put together at run time, so this file holds none.
"""
import contextlib, io, json, os, shutil, stat, subprocess, sys, tempfile, urllib.error, urllib.parse

GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
R = os.environ["SF_FAKE_REMOTES"]; a = sys.argv[1:]
open(os.path.join(R, "calls.log"), "a").write("gh " + " ".join(a) + "\n")
def path(slug): return os.path.join(R, "github.com", slug + ".git")
if a[:3] == ["config", "get", "user"] or a[:2] == ["api", "user"]: print("factory-bot"); sys.exit(0)
if a[:2] == ["auth", "token"]: print(os.environ.get("SF_FAKE_GH_TOKEN", "")); sys.exit(0)
if a[:2] == ["repo", "view"]:
    p = path(a[2])
    if not os.path.isdir(p): sys.stderr.write("GraphQL: Could not resolve to a Repository with the name '%s'.\n" % a[2]); sys.exit(1)
    print(json.dumps({"visibility": open(p + ".visibility").read().strip(), "url": "https://github.com/" + a[2]})); sys.exit(0)
if a[:2] == ["repo", "create"]:
    if "--private" not in a or "--public" in a or "--internal" in a: sys.stderr.write("stand-in: not private\n"); sys.exit(1)
    p = path(a[2]); os.makedirs(os.path.dirname(p), exist_ok=True)
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", p], check=True); open(p + ".visibility", "w").write("PRIVATE"); sys.exit(0)
sys.stderr.write("stand-in gh: unexpected " + " ".join(a) + "\n"); sys.exit(2)
'''
GLAB = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, urllib.parse
R = os.environ["SF_FAKE_REMOTES"]; a = sys.argv[1:]
open(os.path.join(R, "calls.log"), "a").write("glab " + " ".join(a) + "\n")
def no(code): sys.stderr.write("glab: %d\n" % code); sys.exit(1)
if a[:1] != ["api"]: sys.exit(0)
host = a[a.index("--hostname") + 1]; method = a[a.index("--method") + 1]; path = a[a.index("--method") + 2]
f = dict(x.split("=", 1) for i, x in enumerate(a) if i and a[i - 1] == "-f")
def repo(slug): return os.path.join(R, host, slug + ".git")
if path == "user": print(json.dumps({"username": "factory-bot"})); sys.exit(0)
if path.startswith("namespaces/"):
    if urllib.parse.unquote(path.split("/", 1)[1]) == "acme": print(json.dumps({"id": 7})); sys.exit(0)
    no(404)
if path.startswith("projects/") and method == "GET":
    p = repo(urllib.parse.unquote(path.split("/", 1)[1]))
    if not os.path.isdir(p): no(404)
    print(json.dumps({"visibility": open(p + ".visibility").read().strip()})); sys.exit(0)
if path == "projects" and method == "POST":
    if f.get("visibility") != "private": no(400)
    p = repo(("acme" if f.get("namespace_id") == "7" else "factory-bot") + "/" + f["path"]); os.makedirs(os.path.dirname(p), exist_ok=True)
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", p], check=True); open(p + ".visibility", "w").write("private")
    print(json.dumps({"id": 1})); sys.exit(0)
no(500)
'''
VERCEL = r'''#!/usr/bin/env python3
import os, shutil, sys
R = os.environ["SF_FAKE_REMOTES"]; a = sys.argv[1:]
open(os.path.join(R, "calls.log"), "a").write("vercel " + " ".join(a[:-1]) + "\n")
src = os.path.join(R, "vercel.env")
if a[:2] == ["env", "pull"] and os.path.exists(src): shutil.copyfile(src, a[-1])
'''
NODE_META = '''import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
// writes agent/lib/subagent-registry.generated.ts
const keys = existsSync("agent/subagents") ? readdirSync("agent/subagents").sort() : [];
mkdirSync("agent/lib", { recursive: true });
writeFileSync("agent/lib/subagent-registry.generated.ts", "export const SUBAGENTS = " + JSON.stringify(keys) + ";\\n");
'''
NODE_PROFILE = '''import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
let product = { name: "Base" };
for (const f of existsSync("profiles") ? readdirSync("profiles").sort() : []) Object.assign(product, JSON.parse(readFileSync("profiles/" + f, "utf8")).product || {});
mkdirSync("lib", { recursive: true });
writeFileSync("lib/deployment-profile.generated.ts", "export const PRODUCT = " + JSON.stringify(product) + ";\\n");
'''
MOLD_COMMIT = "0123456789abcdef0123456789abcdef01234567"

def write(p, s, mode=None):
    os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(s)
    if mode: os.chmod(p, mode)

def fixture(fx):
    j = lambda p, o: write(os.path.join(fx, p), json.dumps(o, indent=2) + "\n")
    j("state/factory.json", {"molds": [{"mold_id": "mold_t", "source": {"repo": "github.com/example/base", "commit": MOLD_COMMIT, "snapshot_date": "2026-10-01"}}]})
    c = os.path.join(fx, "molds/mold_t/codebase")
    for p, s in (("package.json", '{"name":"base"}\n'), ("app/page.tsx", "export default function Page() { return null }\n"), ("app/icon.svg", "<svg/>\n"),
                 (".gitignore", "dist\n.env*\n!.env.example\n"), ("dist/out.js", "built\n"), ("node_modules/x/index.js", "module.exports = 1\n"),
                 (".next/cache/a", "cache\n"), (".env.local", "LOCAL_ONLY=never-in-a-repository\n"), (".env.example", "API_KEY=\n"), ("server.log", "a log line\n"),
                 (".github/workflows/ci.yml", "on: push\n"), ("docs/setup.md", "Use postgres://user:password@localhost:5432/app and postgres://app:${PASSWORD}@host/db\n"),
                 ("scripts/gen-subagent-meta.mjs", NODE_META), ("scripts/sync-subagent-shared.mjs", "// nothing shared in this fixture\n"),
                 ("scripts/gen-deployment-profile.mjs", NODE_PROFILE)):
        write(os.path.join(c, p), s)
    j("molds/mold_t/branding/rules.json", {"files": {"icon": "app/icon.svg"}, "product_name_default": "Base", "replacements": [], "product_name_files": [], "palette_blocks": []})
    j("packs/demo-pack/pack.json", {"pack_id": "demo-pack", "name": "Demo", "version": "0.3.0", "description": "d", "subagents": ["alpha"]})
    write(os.path.join(fx, "packs/demo-pack/files/agent/subagents/alpha/agent.ts"), "export const alpha = 1;\n")
    write(os.path.join(fx, "briefs/demo_app.md"), "Product name: Demo Desk\nA desk for demos.\n")
    j("state/application/demo_app/application.json", {"app_id": "demo_app", "mold_id": "mold_t", "mold_commit": MOLD_COMMIT, "status": "stamped", "brief": "briefs/demo_app.md",
                                                       "packs": ["demo-pack"], "surface": {"branding": {"product_name": "Demo Desk", "tagline": "A desk for demos."}}})
    j("state/application/demo_app/infrastructure.json", {"target": "vercel", "vercel": {"project": "demo-app"}, "secrets": ["API_KEY", "DATABASE_URL", "NEXT_PUBLIC_SITE"],
                                                          "runtime_env": {}, "agent_cli": {"package": "@x/demo", "token_ref": "NPM_TOKEN"}})
    j("state/application/demo_app/datastores.json", {"postgres": {"provider": "neon"}})
    j("state/application/demo_app/datainfra.json", {})
    j("state/application/other_app/application.json", {"app_id": "other_app", "mold_id": "mold_t"})
    j("state/application/other_app/infrastructure.json", {"target": "vercel", "vercel": {"project": "other-app"}})

def run(M):
    import packs
    real_root, real_env, real_packs = M.ROOT, M.ENV, (packs.ROOT, packs.PACKS)
    real_open = M.urllib.request.urlopen
    tmp = tempfile.mkdtemp(prefix="sf-repo-selftest-"); fx = os.path.join(tmp, "factory"); R = os.path.join(tmp, "remotes"); os.makedirs(R)
    b1, b2 = os.path.join(tmp, "bin"), os.path.join(tmp, "bin-glab"); x = stat.S_IRWXU
    write(os.path.join(b1, "gh"), GH, x); write(os.path.join(b1, "vercel"), VERCEL, x); write(os.path.join(b2, "glab"), GLAB, x)
    fixture(fx)
    fails = []; n = [0]
    def ok(cond, what):
        n[0] += 1
        if not cond: fails.append(what)
    def env(glab=False, **extra):
        e = {k: v for k, v in real_env.items() if k not in ("GITLAB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "VERCEL_TOKEN", "API_KEY", "DATABASE_URL") and not k.startswith("GIT_")}
        e.update(PATH=os.pathsep.join(([b2] if glab else []) + [b1, real_env.get("PATH", "")]), HOME=os.path.join(tmp, "home"), SF_FAKE_REMOTES=R,
                 GIT_ALLOW_PROTOCOL="file", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_COUNT="2",
                 GIT_CONFIG_KEY_0=f"url.file://{R}/github.com/.insteadOf", GIT_CONFIG_VALUE_0="https://github.com/",
                 GIT_CONFIG_KEY_1=f"url.file://{R}/gitlab.example.com/.insteadOf", GIT_CONFIG_VALUE_1="https://gitlab.example.com/")
        e.update(extra); return e
    def cli(*a):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out): rc = M.main(list(a))
        return rc, out.getvalue()
    def calls(word=None):
        p = os.path.join(R, "calls.log"); ls = open(p).read().splitlines() if os.path.exists(p) else []
        return [l for l in ls if word is None or word in l]
    def git(repo, *a): return subprocess.run(["git", "--git-dir", repo, *a], capture_output=True, text=True, env=M.ENV).stdout
    def infra(app="demo_app"): return json.load(open(os.path.join(fx, "state/application", app, "infrastructure.json")))
    def set_infra(o, app="demo_app"): M.save(os.path.join(fx, "state/application", app, "infrastructure.json"), o)
    try:
        M.ROOT = fx; packs.ROOT = fx; packs.PACKS = os.path.join(fx, "packs"); M.ENV = env(); os.makedirs(M.ENV["HOME"])
        ok(os.path.dirname(M.which("gh")) == b1 and os.path.dirname(M.which("vercel")) == b1 and not M.which("glab"), "the stand-in commands come first on PATH")
        gh_repo = os.path.join(R, "github.com/factory-bot/demo-app.git")

        # ---- a dry run and status create nothing -----------------------------------------------------------------
        rc, out = cli("demo_app", "publish", "--provider", "github", "--dry-run")
        ok(rc == 0 and "dry run: nothing was created" in out and "github.com/factory-bot/demo-app" in out and "PRIVATE" in out, "dry run describes the plan: " + out[-300:])
        ok(not os.path.exists(gh_repo) and not calls("repo create") and not calls("repo view") and "repository" not in infra(), "a dry run created or recorded something")
        rc, out = cli("demo_app", "status")
        ok(rc == 0 and out.startswith("repository: none (ask for one: repo.py demo_app publish") and not calls("repo create"), "status with no repository: " + out[:200])
        ok(not os.path.exists(os.path.join(fx, "build")), "something was written under build/")
        rc, out = cli("demo_app", "publish", "--provider", "github", "--public")
        ok(rc == 1 and "always private" in out and not calls("repo create"), "there must be no way to ask for a public repository")
        rc, out = cli("demo_app", "push")
        ok(rc == 1 and "has no repository" in out, "push without a repository must refuse")

        # ---- nothing happens by itself -----------------------------------------------------------------------------
        before = len(calls()); rc, out = cli("demo_app", "auto", "--reason", "deploy")
        ok(rc == 0 and out == "" and len(calls()) == before and not os.path.exists(gh_repo), "auto with no repository recorded must do nothing at all")
        S = os.path.join(real_root, ".claude", "scripts"); sys.path.insert(0, S); import mint
        ok("repository" not in [s for s, _ in mint.STATIONS] and "repo" not in [s for s, _ in mint.STATIONS], "a repository must never be a mint station")
        for f in ("mint.py", "provision.py"):
            src = [l for l in open(os.path.join(S, f)).read().splitlines() if "repo.py" in l and not l.lstrip().startswith("#")]
            ok(src and all('"auto"' in l or "status_line" in l for l in src), f"{f} may reach repo.py only through the opt-in `auto` (and mint's status line)")
            ok("publish" not in "".join(l for l in src if "status_line" not in l), f"{f} must never publish")
        ok("repo.py" not in open(os.path.join(S, "lanes.py")).read(), "lanes.py must not reach repo.py")

        # ---- publish: a private repository, one commit, the right contents -----------------------------------------
        rc, out = cli("demo_app", "publish", "--provider", "github")
        ok(rc == 0 and "created https://github.com/factory-bot/demo-app (private, empty)" in out, "publish: " + out[-400:])
        ok(len(calls("repo create")) == 1 and "--private" in calls("repo create")[0], "the repository must be created with --private, once")
        rec = infra().get("repository") or {}
        ok(sorted(rec) == sorted(M.REPO_KEYS) and rec["url"] == "https://github.com/factory-bot/demo-app" and rec["auto_push"] is False
           and (rec["provider"], rec["host"], rec["owner"], rec["name"]) == ("github", "github.com", "factory-bot", "demo-app"), f"state after publish: {rec}")
        ok(git(gh_repo, "rev-list", "--count", "main").strip() == "1" and git(gh_repo, "rev-parse", "main").strip() == rec.get("last_commit"), "one commit, and state names it")
        an, ae, subj, body = git(gh_repo, "log", "-1", "--format=%an%x00%ae%x00%s%x00%b", "main").split("\0")
        ok((an, ae) == M.AUTHOR and git(gh_repo, "log", "-1", "--format=%cn", "main").strip() == M.AUTHOR[0], "the commit is authored and committed as the factory")
        ok(MOLD_COMMIT[:12] in subj and "first publish" in subj and f"Mold commit: {MOLD_COMMIT}" in body and "demo-pack 0.3.0" in body, "the message names the mold commit, the packs and the reason")
        tree = git(gh_repo, "ls-tree", "-r", "--name-only", "main").splitlines()
        ok(not [p for p in tree if "node_modules" in p or p.startswith((".next", "dist", ".github")) or os.path.basename(p).startswith(".env") or p.endswith(".log")],
           "node_modules, build output, .env files, logs or the mold's CI reached the repository")
        ok({"app/page.tsx", "FACTORY.md", "factory/brief.md", "factory/packs.json", "factory/manifest.json", "agent/subagents/alpha/agent.ts",
            "agent/lib/subagent-registry.generated.ts", "profiles/90-brand.json"} | {f"factory/state/{s}.json" for s in M.STATE_FILES} <= set(tree), f"the tree is missing something: {tree}")
        fm = git(gh_repo, "show", "main:FACTORY.md")
        ok(f"Mold commit: {MOLD_COMMIT}" in fm and "github.com/example/base" in fm and "`demo-pack` 0.3.0" in fm and "app_id: demo_app" in fm
           and "Do not edit this repository" in fm and "pull request" in fm and "repo.py demo_app push" in fm, "FACTORY.md does not say what it must")
        ok('"alpha"' in git(gh_repo, "show", "main:agent/lib/subagent-registry.generated.ts") and "Demo Desk" in git(gh_repo, "show", "main:lib/deployment-profile.generated.ts"),
           "packs and brand must be applied the way a deploy applies them")
        ok("repository" not in json.loads(git(gh_repo, "show", "main:factory/state/infrastructure.json")), "the pushed state must not carry the factory's own link note")
        pk = json.loads(git(gh_repo, "show", "main:factory/packs.json"))
        ok(pk[0]["pack_id"] == "demo-pack" and pk[0]["version"] == "0.3.0" and len(pk[0]["sha256"]) == 64, "factory/packs.json names each pack and its version")
        ok(not os.path.exists(os.path.join(fx, "build")) and not os.path.exists(os.path.join(fx, "molds/mold_t/codebase/factory")), "assembly wrote into the factory checkout")

        # ---- idempotent: the same repository, a commit only when something changed ---------------------------------
        rc, out = cli("demo_app", "publish", "--provider", "github")
        ok(rc == 0 and "nothing changed" in out and len(calls("repo create")) == 1 and git(gh_repo, "rev-list", "--count", "main").strip() == "1", "a second publish with no change: " + out[-200:])
        write(os.path.join(fx, "briefs/demo_app.md"), "Product name: Demo Desk\nA desk for demos, now with reports.\n")
        rc, out = cli("demo_app", "publish", "--provider", "github")
        ok(rc == 0 and len(calls("repo create")) == 1 and git(gh_repo, "rev-list", "--count", "main").strip() == "2" and infra()["repository"]["last_commit"] == git(gh_repo, "rev-parse", "main").strip(),
           "a second publish after a change pushes a new commit to the SAME repository: " + out[-200:])
        rc, out = cli("demo_app", "publish", "--provider", "gitlab")
        ok(rc == 1 and "already has a repository" in out, "publishing somewhere else while linked must refuse")
        rc, out = cli("demo_app", "push", "--dry-run")
        ok(rc == 0 and "dry run" in out and git(gh_repo, "rev-list", "--count", "main").strip() == "2", "push --dry-run pushes nothing")
        write(os.path.join(fx, "packs/demo-pack/files/agent/subagents/alpha/agent.ts"), "export const alpha = 2;\n")
        rc, out = cli("demo_app", "push")
        ok(rc == 0 and "pushed " in out and git(gh_repo, "rev-list", "--count", "main").strip() == "3" and "alpha = 2" in git(gh_repo, "show", "main:agent/subagents/alpha/agent.ts"), "push after a change: " + out[-200:])
        ok("demo_app: push (" in git(gh_repo, "log", "-1", "--format=%s", "main"), "a push names its reason")
        rc, out = cli("other_app", "publish", "--provider", "github", "--name", "demo-app", "--dry-run")
        ok(rc == 1 and "every app has its own" in out, "two apps must not share one repository: " + out[-200:])

        # ---- auto-push: off unless asked ---------------------------------------------------------------------------
        write(os.path.join(fx, "briefs/demo_app.md"), "Product name: Demo Desk\nChanged again.\n")
        rc, out = cli("demo_app", "auto", "--reason", "deploy")
        ok(rc == 0 and out == "" and git(gh_repo, "rev-list", "--count", "main").strip() == "3", "auto must do nothing while auto_push is false")
        rc, out = cli("demo_app", "auto-push", "on"); ok(rc == 0 and infra()["repository"]["auto_push"] is True, "auto-push on")
        rc, out = cli("demo_app", "auto", "--reason", "deploy")
        ok(rc == 0 and git(gh_repo, "rev-list", "--count", "main").strip() == "4" and "after deploy" in git(gh_repo, "log", "-1", "--format=%s", "main"), "auto with auto_push on pushes one commit: " + out[-200:])
        ok(infra()["repository"]["auto_push"] is True, "a push must keep the auto_push choice")
        rc, out = cli("demo_app", "auto-push", "off"); ok(infra()["repository"]["auto_push"] is False, "auto-push off")

        # ---- the secret gate ---------------------------------------------------------------------------------------
        tok = "gh" + "p_" + "A1b2" * 9; glt = "gl" + "pat-" + "x9Y8" * 6; pem = "-----BEGIN " + "RSA PRIVATE" + " KEY-----"; pw = "Tr0ub4dor" + "9xQ"
        conn = "postgres://app:" + pw + "@db.internal:5432/app"; api = "k9" + "Zq7Lm2Xw4" * 3; site = "https://demo.example.com"; ssh_line = "b3BlbnNza" + "C1rZXktdjE" * 5
        import base64 as b64
        b64pem = b64.b64encode(("-----BEGIN " + "PRIVATE KEY-----\nMIIabc\n").encode() * 2).decode()
        write(os.path.join(M.ENV["HOME"], ".ssh", "sf_demo"), "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n" + ssh_line + "\n-----END OPENSSH " + "PRIVATE KEY-----\n")
        write(os.path.join(R, "vercel.env"), f'DATABASE_URL="{conn}"\nNEXT_PUBLIC_SITE="{site}"\nHIDDEN_ONE="[SENSITIVE]"\nVERCEL_ENV="production"\n')
        M.ENV = env(API_KEY=api, SF_FAKE_GH_TOKEN=tok[::-1])
        app_doc = json.load(open(os.path.join(fx, "state/application/demo_app/application.json")))
        V = M.resolve_values("demo_app", app_doc, dict(infra(), vm_remote={"ssh_key_ref": "sf_demo"}))
        ok({"API_KEY", "DATABASE_URL", "the GitHub sign-in", "the private half of the SSH key sf_demo"} <= V.names and "NEXT_PUBLIC_SITE" not in V.names, f"values resolved: {sorted(V.names)}")
        ok(all(len(k) == 4 for k in V.by_prefix) and all(isinstance(e[0], int) and len(e[1]) == 32 for es in V.by_prefix.values() for e in es)
           and not any(v in repr(vars(V)) for v in (api, conn, pw, ssh_line, tok[::-1])), "resolved values must be kept as hashes only")
        ok(len(calls("vercel env pull")) >= 3 and not [f for f in os.listdir(os.path.join(M.ENV["HOME"], ".cache", "software-factory"))], "the pulled values must be read and deleted")
        plant = os.path.join(tmp, "plant")
        def planted(text, name="notes/planted.txt"):
            if os.path.isdir(plant): shutil.rmtree(plant)
            write(os.path.join(plant, name), "line one\nline two\n" + text + "\n"); return M.scan(plant, V)
        for what, text, secret in (("a GitHub token", "token = " + tok, tok), ("a GitLab token", glt, glt), ("a private key block", pem, None),
                                   ("a connection string with a password in it", "url: redis://default:" + pw[::-1] + "@cache.internal:6379", pw[::-1]),
                                   ("the value of API_KEY", "const k = '" + api + "'", api), ("the value of DATABASE_URL", "DSN=" + conn, conn),
                                   ("the value of DATABASE_URL", "password is " + pw + " ok", pw), ("the value of the GitHub sign-in", tok[::-1], tok[::-1]),
                                   ("the value of the private half of the SSH key sf_demo", ssh_line, ssh_line), ("a private key block (base64-encoded)", "KEY=" + b64pem, b64pem)):
            f = planted(text); msg = M.refusal(f)
            ok(("notes/planted.txt", 3, what) in f, f"the gate missed {what}: {[(a, b, c) for a, b, c in f]}")
            ok("notes/planted.txt:3" in msg and (secret is None or secret not in msg) and "Nothing was committed" in msg, f"the refusal for {what} must name file and line and never the value")
        ok(any(w.startswith("an environment file") for _, _, w in planted("X=1", ".env.production")), "a .env file must be refused")
        ok(any("private half of an SSH key" in w for _, _, w in planted("x", "keys/id_ed25519")) and any("private half of an SSH key" in w for _, _, w in planted("x", "sf_demo")), "a file named like a private key must be refused")
        ok(planted("see " + site + " and postgres://user:password@localhost/db and postgres://u:${DB_PASSWORD}@h/db and VERCEL_ENV production") == [], "public values and placeholders must not be refused")
        # the shapes a mold's own tests and documentation use: stand-ins, not credentials
        ok(planted("https://x:y@host postgres://postgres:\u2026@127.0.0.1:5432/t postgres://app_rw:app_rw_test_password@127.0.0.1:5432/t postgres://admin:s3cr3tpw@db.example.com:5432/app "
                   + "AKIA" + "IOSFODNN7EXAMPLE xox" + "b-test-override vercel_blob" + "_rw_fakestore_fakesecret") == [], "documentation stand-ins must not be refused")
        for what, text in (("an AWS access key", "AKIA" + "IOSFODNN7EXAMPLQ"), ("a Slack token", "xox" + "b-123456789012-123456789012-" + "aBcD" * 6),
                           ("a Vercel Blob token", "vercel_blob" + "_rw_" + "a1B2" * 4 + "_" + "c3D4" * 8), ("a connection string with a password in it", "postgres://admin:s3cr3t" + "pw9@db.internal.acme.io:5432/app")):
            ok(("notes/planted.txt", 3, what) in planted(text), f"a real-shaped value next to a stand-in must still be refused: {what}")
        # end to end: a planted value stops the push before any commit, and says where
        write(os.path.join(fx, "packs/demo-pack/files/agent/subagents/alpha/agent.ts"), "export const alpha = 3;\n// oops\nconst key = '" + api + "';\n")
        head = git(gh_repo, "rev-parse", "main").strip(); rc, out = cli("demo_app", "push")
        ok(rc == 3 and "REFUSED" in out and "agent/subagents/alpha/agent.ts:3: the value of API_KEY" in out and api not in out, "push with a planted secret: " + out[-300:].replace(api, "<value>"))
        ok(git(gh_repo, "rev-parse", "main").strip() == head and infra()["repository"]["last_commit"] == head, "a refused push must commit and record nothing")
        rc, out = cli("demo_app", "status"); ok(rc == 3 and "REFUSED" in out and api not in out, "status must report what the gate would refuse")
        write(os.path.join(fx, "packs/demo-pack/files/agent/subagents/alpha/agent.ts"), "export const alpha = 3;\n")
        rc, out = cli("demo_app", "push"); ok(rc == 0 and "pushed" in out and "1 write-only" in out, "push once the value is removed: " + out[-300:])
        import inspect
        ok("gate" not in inspect.signature(M.deliver).parameters and "skip" not in " ".join(inspect.signature(M.deliver).parameters) and "--no-" not in open(M.__file__).read().split("def self_test")[0],
           "there must be no switch that skips the gate")
        M.ENV = env()

        # ---- a repository that stopped being private, or is someone else's -----------------------------------------
        open(gh_repo + ".visibility", "w").write("PUBLIC"); write(os.path.join(fx, "briefs/demo_app.md"), "Product name: Demo Desk\nOne more change.\n")
        head = git(gh_repo, "rev-parse", "main").strip(); rc, out = cli("demo_app", "push")
        ok(rc == 1 and "is not private" in out and git(gh_repo, "rev-parse", "main").strip() == head, "the factory must never push to a public repository")
        open(gh_repo + ".visibility", "w").write("PRIVATE")

        # ---- unlink forgets, deletes nothing; publishing again takes the same repository back -----------------------
        rc, out = cli("demo_app", "unlink")
        ok(rc == 0 and "repository" not in infra() and os.path.isdir(gh_repo) and git(gh_repo, "rev-parse", "main").strip() == head and "not touched" in out, "unlink: " + out)
        rc, out = cli("demo_app", "publish", "--provider", "github")
        ok(rc == 0 and len(calls("repo create")) == 1 and int(git(gh_repo, "rev-list", "--count", "main")) >= 5 and infra()["repository"]["url"].endswith("/demo-app"), "publish after unlink re-links the same repository: " + out[-300:])
        foreign = os.path.join(R, "github.com/factory-bot/taken.git"); seed = os.path.join(tmp, "seed")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", foreign], check=True, env=M.ENV); open(foreign + ".visibility", "w").write("PRIVATE")
        subprocess.run(f"git init -q -b main {seed} && cd {seed} && echo theirs > README.md && git add -A && git -c user.name=x -c user.email=x@x commit -q -m theirs && git push -q {foreign} main",
                       shell=True, check=True, env=M.ENV, capture_output=True)
        rc, out = cli("other_app", "publish", "--provider", "github", "--name", "taken")
        ok(rc == 1 and "is not this app's" in out and git(foreign, "rev-list", "--count", "main").strip() == "1" and "repository" not in infra("other_app"), "an existing repository that is someone else's must not be pushed to: " + out[-300:])

        # ---- GitLab: nothing set up -> a plain ask; then glab; then the token named GITLAB_TOKEN --------------------
        rc, out = cli("other_app", "publish", "--provider", "gitlab", "--host", "gitlab.example.com", "--owner", "acme")
        ok(rc == 1 and "https://gitlab.example.com/-/user_settings/personal_access_tokens" in out and 'tick only "api"' in out and "GITLAB_TOKEN" in out and "nothing was created" in out,
           "with no GitLab credential the operator must be told exactly what to do: " + out[:200])
        rc, out = cli("other_app", "publish", "--provider", "gitlab", "--host", "gitlab.example.com", "--dry-run")
        ok(rc == 0 and "GitLab is not set up on this machine yet" in out and "gitlab.example.com/<the signed-in account" in out, "a GitLab dry run needs no credential: " + out[-300:])
        M.ENV = env(glab=True)
        rc, out = cli("other_app", "publish", "--provider", "gitlab", "--host", "gitlab.example.com", "--owner", "acme")
        gl_repo = os.path.join(R, "gitlab.example.com/acme/other-app.git"); rec = infra("other_app").get("repository") or {}
        ok(rc == 0 and os.path.isdir(gl_repo) and git(gl_repo, "rev-list", "--count", "main").strip() == "1" and rec.get("url") == "https://gitlab.example.com/acme/other-app"
           and (rec.get("provider"), rec.get("host"), rec.get("owner")) == ("gitlab", "gitlab.example.com", "acme"), "GitLab through glab: " + out[-300:])
        ok(any("visibility=private" in c and "namespace_id=7" in c for c in calls("--method POST projects")), "the GitLab project must be created private, in the named group")
        cli("other_app", "unlink"); shutil.rmtree(gl_repo); os.remove(gl_repo + ".visibility")
        token = "gl" + "pat-" + "Q" * 20; M.ENV = env(GITLAB_TOKEN=token); seen = []
        def fake_open(req, timeout=None):
            seen.append(req); path = req.full_url.split("/api/v4/", 1)[1]
            fields = [x for k, v in urllib.parse.parse_qsl((req.data or b"").decode()) for x in ("-f", f"{k}={v}")]
            r = subprocess.run([os.path.join(b2, "glab"), "api", "--hostname", urllib.parse.urlsplit(req.full_url).hostname, "--method", req.get_method(), path] + fields, capture_output=True, text=True, env=M.ENV)
            if r.returncode: raise urllib.error.HTTPError(req.full_url, int(r.stderr.split()[-1]), "no", None, io.BytesIO(b"{}"))
            resp = io.BytesIO(r.stdout.encode()); resp.status = 201 if req.get_method() == "POST" else 200; return contextlib.closing(resp)
        M.urllib.request.urlopen = fake_open
        rc, out = cli("other_app", "publish", "--provider", "gitlab", "--host", "gitlab.example.com")
        mine = os.path.join(R, "gitlab.example.com/factory-bot/other-app.git")
        ok(rc == 0 and os.path.isdir(mine) and git(mine, "rev-list", "--count", "main").strip() == "1" and infra("other_app")["repository"]["owner"] == "factory-bot", "GitLab through the token: " + out[-300:])
        ok(seen and all(r.get_header("Private-token") == token and token not in r.full_url and r.full_url.startswith("https://gitlab.example.com/api/v4/") for r in seen), "the token must travel in a header only")
        ok(token not in json.dumps(infra("other_app")) and token not in out and token not in git(mine, "show", "main:factory/state/infrastructure.json"), "the token must never reach state, output or the repository")
        rc, out = cli("other_app", "publish", "--provider", "gitlab", "--host", "https://gitlab.example.com/x")
        ok(rc == 1 and "already has a repository" in out, "a different host while linked must refuse")
        M.urllib.request.urlopen = real_open; M.ENV = env()

        # ---- validate: the schema and the rules it cannot express --------------------------------------------------
        import factory
        sch = json.load(open(os.path.join(real_root, "state/application/app_id/infrastructure.schema.json")))["properties"]["repository"]
        good = {"provider": "github", "host": "github.com", "owner": "acme", "name": "demo-app", "url": "https://github.com/acme/demo-app", "last_commit": "a" * 40, "auto_push": False}
        chk = lambda r: factory._check(r, sch, "x") + factory._repository("x", {"infrastructure": {"repository": r}})
        ok(chk(good) == [] and chk({k: v for k, v in good.items() if k not in ("last_commit", "auto_push")}) == [], f"a well-formed repository object must validate: {chk(good)}")
        for bad, why in ((dict(good, token="x"), "an extra key"), (dict(good, visibility="public"), "a visibility key"), (dict(good, provider="bitbucket"), "an unknown provider"),
                         (dict(good, url="https://github.com/acme/other"), "a url that is not host/owner/name"), (dict(good, url="https://u:" + pw + "@github.com/acme/demo-app"), "a url with a password"),
                         (dict(good, host="github.example.com"), "a GitHub host that is not github.com"), (dict(good, last_commit="abc"), "a short commit"),
                         (dict(good, auto_push="yes"), "a non-boolean auto_push"), ({k: v for k, v in good.items() if k != "last_commit"} | {"auto_push": True}, "auto_push with nothing ever pushed"),
                         ({k: v for k, v in good.items() if k != "owner"}, "a missing owner")):
            ok(chk(bad) != [], f"validate must refuse {why}")
        two = {"a": {"infrastructure": {"repository": good}}, "b": {"infrastructure": {"repository": dict(good, owner="ACME")}}, "c": {"infrastructure": {}}}
        ok(len(factory._repositories(two)) == 1 and factory._repositories({"a": two["a"], "c": two["c"]}) == [], "two apps recording one repository must fail validate")
        ok(factory._repository("x", {"infrastructure": {}}) == [], "an app with no repository must validate as before")
        ok(M.status_line({}, "x").startswith("repository: none (ask for one: repo.py x publish") and "auto-push off" in M.status_line({"repository": good}), "mint's one line")
    finally:
        M.ROOT, M.ENV = real_root, real_env; packs.ROOT, packs.PACKS = real_packs; M.urllib.request.urlopen = real_open
        if os.path.basename(tmp).startswith("sf-repo-selftest-"): shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        print("repo self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"repo: {n[0]} checks passed (offline: local bare repositories, stand-in gh / glab / vercel)"); return 0
