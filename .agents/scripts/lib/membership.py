#!/usr/bin/env python3
"""membership.py — who an application will email a sign-in code to, read from the application's OWN database.

An application emails a one-time sign-in code only to an address that already belongs to one of its workspaces, or
holds a live invite to one (the mold's app/api/auth/email/request). To everyone else it gives the very same answer
and sends nothing, on purpose: the reply must not tell a stranger who works where. So the factory cannot learn from
the app's answer whether a code went out (mold_v1-245: a freshly deployed app had no workspace, and the operator was
told four times that a code was on its way). It LOOKS first, here.

  read(app_id, emails)            every workspace of the app: how many owners it has, and for each address its role
                                  there (or none) and whether it holds a live invite. {"orgs": [...]} or {"error"}.
  check(app_id, email)            {"can": True | False | None, ...}: can this address be emailed a code?
                                  None = it could not be read (and why). Never a guess.
  said(app_id, email, m)          (send, words): whether to ask the app at all, and the one plain thing to say.
  sign_in_note(app_id)            a sentence for every message that asks the operator for a code: empty when the
                                  operator's own address can receive one, the missing step when it cannot.

STRICTLY READ-ONLY, as the application's own role (app_rw: the DATABASE_URL the app itself uses), refused outright if
that role is a superuser or bypasses row-level security, inside READ ONLY transactions, one workspace at a time with
set_config('app.org_id', ...), exactly as app_usage.py reads.

  vercel      the production DATABASE_URL is pulled by name (clone.pull_env, never printed or written) and the query
              runs here with node and the `postgres` package from build/<app_id>.
  vm_remote   over SSH (lib/vm_remote.py settings + ssh_argv). THIS FILE is sent on stdin to `python3 -` on the server,
              which reads the API service's env file as root and runs node from the app's directory AS THE API'S USER
              with DATABASE_URL alone in its environment. Only roles and counts come back, scrubbed of that file's values.
  rehearsal   (FACTORY_REHEARSAL) the fake app's workspaces are <rehearsal>/workspaces.json; nothing is reached.

Standard library only. `python3 membership.py --self-test`.
"""
import base64, json, os, re, subprocess, sys

HERE_FILE = os.path.abspath(globals().get("__file__") or "membership.py")   # no __file__ when sent to `python3 -` on a server
LIB = os.path.dirname(HERE_FILE)
S_DIR = os.path.dirname(LIB)
ROOT = os.path.dirname(os.path.dirname(S_DIR))
PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
TIMEOUT = 60

QUERY_JS = r"""
import pg from 'postgres';
setTimeout(() => { console.log(JSON.stringify({ error: 'the database did not answer within 45 seconds' })); process.exit(3); }, 45000).unref();
const A = JSON.parse(process.env.SF_MEMBER_ARGS);
const sql = pg(process.env.DATABASE_URL, { max: 1, connect_timeout: 20, idle_timeout: 5, prepare: false, onnotice: () => {} });
const why = (e) => String((e && e.code ? e.code + ' ' : '') + ((e && e.message) || e)).slice(0, 200);
const ro = (org, fn) => sql.begin('read only', async (t) => {
  await t`select set_config('statement_timeout', '15000', true)`;
  if (org !== null) await t`select set_config('app.org_id', ${org}, true)`;
  return fn(t);
});
const out = { orgs: [] };
try {
  const [r] = await ro(null, (t) => t`select current_user as role, r.rolsuper as su, r.rolbypassrls as bypass from pg_roles r where r.rolname = current_user`);
  if (r.su || r.bypass) {
    console.log(JSON.stringify({ error: `refused: the app's connection role ${r.role} bypasses row-level security, so it is not the app role; nothing was read` }));
    await sql.end(); process.exit(0);
  }
  const listed = await ro(null, (t) => t`select org_id from orgs order by org_id`);
  for (const o of listed) {
    const w = { org_id: o.org_id, people: [] };
    try {
      await ro(o.org_id, async (t) => {
        const [c] = await t`select count(*)::int as n from org_members where org_id = ${o.org_id} and role = 'owner'`;
        w.owners = c.n;
        for (const e of A.emails) {
          // The app's own rule (app/api/auth/email/request): a membership, or an invite not yet accepted and not
          // expired that is a workspace's own (a chat share's guest signs in from the chat's link, never from here).
          const m = await t`select role from org_members where org_id = ${o.org_id} and lower(email) = ${e} limit 1`;
          const i = await t`select count(*)::int as n from org_invites where org_id = ${o.org_id} and lower(email) = ${e}
            and accepted_at is null and expires_at > now() and coalesce(to_jsonb(org_invites)->>'origin', 'workspace') <> 'chat_share'`;
          w.people.push({ member: m.length ? m[0].role : null, invite: i[0].n > 0 });
        }
      });
    } catch (e) { w.error = why(e); w.people = []; }
    out.orgs.push(w);
  }
} catch (e) { out.error = why(e); }
try { await sql.end({ timeout: 5 }); } catch (e) {}
console.log(JSON.stringify(out));
process.exit(0);
"""

def load(p): return json.load(open(p))

URL_CRED = re.compile(r"([a-z][a-z0-9+.-]*://)[^/\s@]+@", re.I)
def scrub(text, secrets_=()):
    """Remove every given value (longest first) and any user:password@ out of a line before it is shown anywhere."""
    text = URL_CRED.sub(r"\1[redacted]@", str(text or ""))
    for v in sorted((s for s in secrets_ if s and len(s) >= 8), key=len, reverse=True): text = text.replace(v, "[redacted]")
    return text

def url_secrets(url):
    out = [url] if url else []
    m = re.match(r"^[a-z][a-z0-9+.-]*://[^:/@]*:([^@]*)@", url or "", re.I)
    if m and m.group(1): out.append(m.group(1))
    return out

def parse_last_json(stdout):
    for line in reversed((stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try: return json.loads(line)
            except ValueError: continue
    return None

def run_node(cwd, env, secrets_, timeout=50, run=subprocess.run, user_kw=None):
    """Run QUERY_JS in `cwd` (where the app's `postgres` package is). The raw dict; on failure {"error"}."""
    try:
        r = run(["node", "--input-type=module", "--disable-warning=ExperimentalWarning", "-e", QUERY_JS], cwd=cwd, env=env,
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, **(user_kw or {}))
    except subprocess.TimeoutExpired: return {"error": f"the query did not finish within {timeout} seconds"}
    except OSError as e: return {"error": f"node could not be started ({type(e).__name__})"}
    doc = parse_last_json(r.stdout)
    if doc is None:
        tail = " / ".join(l for l in scrub((r.stderr or "") + "\n" + (r.stdout or ""), secrets_).splitlines() if l.strip())[-300:]
        return {"error": "the query did not finish: " + (tail or f"exit {r.returncode}, nothing printed")}
    return json.loads(scrub(json.dumps(doc), secrets_))

def read_vercel(app_id, infra, args, root=None):
    root = root or ROOT
    build = os.path.join(root, "build", app_id)
    if not os.path.isdir(os.path.join(build, "node_modules", "postgres")):
        return {"error": f"build/{app_id} with its node_modules is not on this machine, so there is nothing to run the query with"}
    project = (infra.get("vercel") or {}).get("project")
    if not project: return {"error": "state names no Vercel project for this app"}
    sys.path.insert(0, S_DIR); import clone
    try: url = clone.pull_env(project, build).get("DATABASE_URL")
    except SystemExit: url = None
    except Exception as e: return {"error": f"the production settings could not be pulled from Vercel ({type(e).__name__})"}
    if not url or url == "[SENSITIVE]": return {"error": f"the Vercel project {project} has no readable DATABASE_URL in production"}
    env = {"PATH": os.environ.get("PATH", PATH), "HOME": os.environ.get("HOME", "/root"), "DATABASE_URL": url, "SF_MEMBER_ARGS": json.dumps(args)}
    return run_node(build, env, url_secrets(url))

def remote_argv(app_id, app, infra, ds, args):
    """The one SSH command for a vm_remote app. Nothing secret is on it: the env file is read on the server."""
    sys.path.insert(0, LIB); import vm_remote
    S = vm_remote.settings(app_id, app, infra, ds)
    spec = {"env_file": S["env_files"]["api"], "user": vm_remote.SERVICE_USERS["api"], "home": vm_remote.SERVICE_HOMES["api"],
            "app_dir": S["app_dir"], "args": args}
    b64 = base64.b64encode(json.dumps(spec).encode()).decode()
    return S, vm_remote.ssh_argv(S, f"{S['sudo']}python3 - remote {b64}")

def read_vm_remote(app_id, app, infra, ds, args, run=subprocess.run, have_key=os.path.isfile):
    S, argv = remote_argv(app_id, app, infra, ds, args)
    if not S["host"]: return {"error": "state has no server address for this app"}
    if not S["key_ref"] or not have_key(os.path.join(os.path.expanduser("~"), ".ssh", S["key_ref"])):
        return {"error": f"there is no SSH key named {S['key_ref'] or '(none)'} on this machine"}
    try: r = run(argv, input=open(HERE_FILE).read(), capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired: return {"error": f"the server did not answer within {TIMEOUT} seconds"}
    doc = parse_last_json(r.stdout)
    if doc is None:
        tail = scrub(((r.stderr or r.stdout or "").strip().splitlines() or [f"exit {r.returncode}"])[-1])[:300]
        return {"error": "the query on the server did not finish: " + tail}
    return doc

def remote_main(b64):
    """ON THE SERVER, as root: read the API service's env file, run the query as the API's user. Prints one JSON line."""
    import pwd
    spec = json.loads(base64.b64decode(b64)); vals = {}
    try:
        for line in open(spec["env_file"]).read().splitlines():
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1); v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
            vals[k.strip()] = v
    except OSError as e:
        print(json.dumps({"error": f"the API service's env file could not be read on the server ({type(e).__name__})"})); return 0
    if not vals.get("DATABASE_URL"):
        print(json.dumps({"error": "the API service's env file has no DATABASE_URL"})); return 0
    try: pw = pwd.getpwnam(spec["user"])
    except KeyError: print(json.dumps({"error": f"the server has no user {spec['user']}"})); return 0
    kw = dict(user=pw.pw_uid, group=pw.pw_gid, extra_groups=os.getgrouplist(spec["user"], pw.pw_gid)) if os.getuid() == 0 else {}
    env = {"PATH": PATH, "HOME": spec["home"], "LANG": "C.UTF-8", "NODE_ENV": "production", "DATABASE_URL": vals["DATABASE_URL"],
           "SF_MEMBER_ARGS": json.dumps(spec["args"])}
    if vals.get("DATABASE_SSL"): env["DATABASE_SSL"] = vals["DATABASE_SSL"]
    app_dir = spec["app_dir"]
    if not os.path.isdir(app_dir) and app_dir.endswith("/current"):   # a server not yet moved to releases/ serves from app/
        app_dir = app_dir[: -len("current")] + "app"
    secret = list(vals.values())
    doc = run_node(app_dir, env, secret + url_secrets(vals["DATABASE_URL"]), timeout=48, user_kw=kw)
    print(scrub(json.dumps(doc), secret)); return 0

# ---- a rehearsal's fake app (FACTORY_REHEARSAL): its workspaces are one file, written by the stand-in below ----------
def _rehearsal():
    sys.path.insert(0, LIB); import services
    return services.REHEARSAL

def _world(reh): return os.path.join(reh, "workspaces.json")

def rehearsal_write(app_id, seed):
    """The rehearsal's stand-in for workspace.py: the fake app's database gains (or updates) this workspace and its
    people, exactly the rows workspace_seed.mjs writes (the owner as owner, each member with their role)."""
    reh = _rehearsal(); p = _world(reh); w = load(p) if os.path.exists(p) else {}
    org = w.setdefault(app_id, {}).setdefault(seed["org_id"], {})
    for m in seed.get("members") or []:
        if m.get("email"): org[m["email"].strip().lower()] = m.get("role") or "member"
    org[seed["owner"].strip().lower()] = "owner"
    json.dump(w, open(p, "w"), indent=1)
    import services; services.log_call("workspace", [app_id, seed["org_id"]], action="workspace")
    return {"org": seed["org_id"], "orgs": "written", "org_members": len(org)}

def read_rehearsal(app_id, args):
    reh = _rehearsal(); p = _world(reh); w = (load(p) if os.path.exists(p) else {}).get(app_id) or {}
    return {"orgs": [{"org_id": o, "owners": sum(1 for r in people.values() if r == "owner"),
                      "people": [{"member": people.get(e), "invite": False} for e in args["emails"]]} for o, people in sorted(w.items())]}

# ---- reading, and what it means ----------------------------------------------------------------------------------
def read(app_id, emails, root=None):
    """Every workspace of the deployed app, and where each of `emails` stands in it. Never raises: {"error"} instead."""
    root = root or ROOT; adir = os.path.join(root, "state", "application", app_id)
    args = {"emails": [str(e).strip().lower() for e in emails]}
    try:
        if not os.path.isfile(os.path.join(adir, "infrastructure.json")): return {"error": f"there is no application {app_id} in state"}
        infra = load(os.path.join(adir, "infrastructure.json")); target = infra.get("target")
        if not infra.get("deployed_at"): return {"error": "the app is not deployed, so it has no database to read"}
        if _rehearsal(): return read_rehearsal(app_id, args)
        if target == "vercel": return read_vercel(app_id, infra, args, root)
        if target == "vm_remote":
            app = load(os.path.join(adir, "application.json"))
            ds = load(os.path.join(adir, "datastores.json")) if os.path.isfile(os.path.join(adir, "datastores.json")) else {}
            return read_vm_remote(app_id, app, infra, ds, args)
        return {"error": f"the deploy target {target!r} is not one this reads (vercel, vm_remote)"}
    except Exception as e:
        return {"error": f"the look itself stopped ({type(e).__name__})"}

def check(app_id, email, reader=None):
    """Can `email` be emailed a sign-in code by this app? {"can": True|False|None, "why", "member_of", "invited_to",
    "workspaces"}. True: a membership or a live invite somewhere. False: every workspace was read and it is in none.
    None: it could not be read; `why` says what stopped it."""
    raw = (reader or read)(app_id, [email])
    if not isinstance(raw, dict) or raw.get("error") or not isinstance(raw.get("orgs"), list):
        return {"can": None, "why": (raw or {}).get("error") if isinstance(raw, dict) else "nothing was read", "member_of": [], "invited_to": [], "workspaces": None}
    orgs = raw["orgs"]; first = lambda o: (o.get("people") or [{}])[0]
    member_of = [o["org_id"] for o in orgs if first(o).get("member")]; invited = [o["org_id"] for o in orgs if first(o).get("invite")]
    unread = [o for o in orgs if o.get("error")]
    out = {"member_of": member_of, "invited_to": invited, "workspaces": len(orgs), "why": ""}
    if member_of or invited: return dict(out, can=True)
    if unread: return dict(out, can=None, why=f"workspace {unread[0]['org_id']} could not be read ({unread[0]['error']})")
    return dict(out, can=False)

WORKSPACE_CMD = "python3 .claude/scripts/mint.py {app} run --only workspaces"

def said(app_id, email, m):
    """(send, words). send False: ask the app for nothing. The words never claim a code is coming unless the address
    was seen to belong to a workspace (or hold an invite) just now."""
    cmd = WORKSPACE_CMD.format(app=app_id)
    if m.get("can") is False:
        head = f"{email} belongs to no workspace on {app_id}, so the app will not email it a code. Nothing was sent."
        if not m.get("workspaces"):
            return False, (f"{head}\n{app_id} has no workspace at all yet. Next: create its own workspace (you, the operator, as its owner): {cmd}\n"
                           f"Then ask for the code again.")
        return False, (f"{head}\nNext, one of: a workspace owner invites {email} from inside the app (its members page); or add them to "
                       f"state/application/{app_id}/application.json workspace.members and write that to the app: {cmd}\nThen ask for the code again.")
    if m.get("can") is True:
        where = f"a member of {m['member_of'][0]}" if m.get("member_of") else f"invited to {m['invited_to'][0]}"
        return True, f"a six-digit code is on its way to {email} ({where}); it lasts ten minutes"
    return True, (f"a code was requested for {email}. Whether {email} belongs to a workspace on {app_id} could not be checked "
                  f"({m.get('why') or 'no reason given'}), and the app emails a code only to an address that is a member of one of its "
                  f"workspaces or holds an invite: it arrives (within a minute, good for ten) only if {email} is one. If nothing arrives, "
                  f"it is not a member: {cmd}")

def operator_email(root=None):
    """The operator's own address on this machine (state/factory.local.json defaults.operator_email), or "" when it is
    missing or still the example's placeholder."""
    sys.path.insert(0, LIB); from factory_local import load_factory
    try: e = str((load_factory(os.path.join(root or ROOT, "state")).get("defaults") or {}).get("operator_email") or "").strip().lower()
    except (OSError, ValueError): return ""
    return e if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e) and not re.search(r"yourcompany|^you@|example\.com$", e) else ""

def sign_in_note(app_id, checker=None, operator=None):
    """For every message that asks the operator to request a sign-in code: the app's rule in a sentence, and, when the
    operator's own address is seen to belong to no workspace of the app, the step that comes first. Never raises."""
    rule = "The app emails a code only to an address that belongs to one of its workspaces (or holds an invite); code-request checks that first and says so."
    try:
        op = operator if operator is not None else operator_email()
        if not op: return rule
        m = (checker or check)(app_id, op)
        if m.get("can") is False:
            what = "has no workspace yet" if not m.get("workspaces") else f"has no workspace {op} belongs to"
            return (f"FIRST: {app_id} {what}, so it would email nobody here a code. Create its own workspace, with you as its owner: "
                    f"{WORKSPACE_CMD.format(app=app_id)} . {rule}")
    except Exception: pass
    return rule

def self_test():
    n = [0]
    def ok(c, msg, got=None):
        n[0] += 1
        if not c: sys.exit(f"membership self-test FAILED: {msg}" + (f"\n  got: {got!r}" if got is not None else ""))
    org = lambda oid, member=None, invite=False, owners=1, **kw: dict({"org_id": oid, "owners": owners, "people": [{"member": member, "invite": invite}]}, **kw)
    rd = lambda doc: (lambda app, emails: doc)
    m = check("x", "a@b.test", rd({"orgs": []}))
    ok(m["can"] is False and m["workspaces"] == 0, "an app with no workspace at all: nobody can be emailed a code", m)
    send, words = said("x", "a@b.test", m)
    ok(not send and words.startswith("a@b.test belongs to no workspace on x, so the app will not email it a code") and "Nothing was sent" in words
       and "mint.py x run --only workspaces" in words and "on its way" not in words, "no workspace: send nothing, say why, name the next step", words)
    m = check("x", "a@b.test", rd({"orgs": [org("acme"), org("beta")]}))
    send, words = said("x", "a@b.test", m)
    ok(m["can"] is False and not send and "invites a@b.test from inside the app" in words and "on its way" not in words, "workspaces exist, the address is in none: invite them", words)
    m = check("x", "a@b.test", rd({"orgs": [org("acme"), org("beta", member="admin")]}))
    ok(m["can"] is True and m["member_of"] == ["beta"] and said("x", "a@b.test", m) == (True, "a six-digit code is on its way to a@b.test (a member of beta); it lasts ten minutes"), "a member: the code is requested", m)
    m = check("x", "a@b.test", rd({"orgs": [org("acme", invite=True)]}))
    ok(m["can"] is True and "invited to acme" in said("x", "a@b.test", m)[1], "a live invite counts, as it does for the app", m)
    for doc in ({"error": "the database did not answer"}, None, {"orgs": [org("acme"), dict(org("beta"), error="42501 permission denied")]}):
        m = check("x", "a@b.test", rd(doc)); send, words = said("x", "a@b.test", m)
        ok(m["can"] is None and send and "on its way" not in words and "could not be checked" in words and "only if a@b.test is one" in words, "membership unknown: requested, never promised", (doc, words))
    ok(check("x", "a@b.test", rd({"orgs": [dict(org("beta"), error="x"), org("acme", member="member")]}))["can"] is True, "a membership seen in one workspace is enough, whatever another says")
    # the note on every "request a code" message
    ok("FIRST: x has no workspace yet" in sign_in_note("x", lambda a, e: {"can": False, "workspaces": 0}, "op@acme.test") and "mint.py x run --only workspaces" in sign_in_note("x", lambda a, e: {"can": False, "workspaces": 0}, "op@acme.test"),
       "sign-in note: no workspace, so the workspace comes first")
    ok("FIRST" not in sign_in_note("x", lambda a, e: {"can": True}, "op@acme.test") and "FIRST" not in sign_in_note("x", lambda a, e: {"can": None}, "op@acme.test")
       and "only to an address that belongs to one of its workspaces" in sign_in_note("x", lambda a, e: {"can": None}, "op@acme.test"), "sign-in note: a member, or unknown: only the rule")
    def boom(a, e): raise RuntimeError("x")
    ok(sign_in_note("x", boom, "op@acme.test").startswith("The app emails a code only"), "sign-in note never raises")
    # state without the app, or not deployed: unknown, with the reason, and nothing is run
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        ok("no application" in read("nope", ["a@b.test"], root=t)["error"], "an app that is not in state: an error, never a guess")
        os.makedirs(os.path.join(t, "state", "application", "x")); json.dump({"target": "vercel"}, open(os.path.join(t, "state", "application", "x", "infrastructure.json"), "w"))
        ok("not deployed" in read("x", ["a@b.test"], root=t)["error"], "an app that is not deployed has no database to read")
        json.dump({"defaults": {"operator_email": "you@yourcompany.com"}}, open(os.path.join(t, "state", "factory.json"), "w"))
        was = os.environ.pop("FACTORY_LOCAL", None)
        try:
            ok(operator_email(t) == "", "the example's placeholder is not an operator address")
            json.dump({"defaults": {"operator_email": " Op@Acme.Test "}}, open(os.path.join(t, "state", "factory.local.json"), "w"))
            ok(operator_email(t) == "op@acme.test", "the operator's own address, lower-cased")
        finally:
            if was is not None: os.environ["FACTORY_LOCAL"] = was
    # a rehearsal: the fake app's database is one file; a fresh deploy has no workspace, and the stand-in for workspace.py adds one
    sys.path.insert(0, LIB); import services
    real_reh = services.REHEARSAL
    with tempfile.TemporaryDirectory() as t:
        try:
            services.REHEARSAL = os.path.join(t, "reh"); os.makedirs(services.REHEARSAL)
            os.makedirs(os.path.join(t, "state", "application", "x")); json.dump({"target": "vercel", "deployed_at": "2026-10-13T00:00:00+00:00"}, open(os.path.join(t, "state", "application", "x", "infrastructure.json"), "w"))
            rd2 = lambda app, emails: read(app, emails, root=t)
            m = check("x", "op@acme.test", rd2)
            ok(m["can"] is False and m["workspaces"] == 0, "rehearsal: a freshly deployed fake app has no workspace, so nobody can be emailed a code", m)
            rehearsal_write("x", {"org_id": "acme", "name": "Acme", "owner": "Op@Acme.test", "members": [{"email": "ana@acme.test", "role": "admin"}]})
            raw = rd2("x", ["op@acme.test", "ana@acme.test", "zed@acme.test"])
            ok(raw == {"orgs": [{"org_id": "acme", "owners": 1, "people": [{"member": "owner", "invite": False}, {"member": "admin", "invite": False}, {"member": None, "invite": False}]}]}, "rehearsal: the stand-in writes the owner and each member with their role", raw)
            ok(check("x", "op@acme.test", rd2)["can"] is True and check("x", "zed@acme.test", rd2)["can"] is False and check("other", "op@acme.test", rd2)["can"] is None, "rehearsal: one app's workspaces answer for that app only")
        finally: services.REHEARSAL = real_reh
    # the query: read-only, the app role only, the app's own rule; and a connection string never reaches a printed line
    ok("begin('read only'" in QUERY_JS and "rolbypassrls" in QUERY_JS and "set_config('app.org_id'" in QUERY_JS and not re.search(r"\b(insert|update|delete)\b", QUERY_JS, re.I), "the query only reads, as the app role, one workspace at a time")
    ok("accepted_at is null" in QUERY_JS and "expires_at > now()" in QUERY_JS and "chat_share" in QUERY_JS, "an invite counts exactly when the app counts it")
    u = "postgres://app_rw:s3cretPassw0rd@db.example.com:5432/app"
    class R:
        def __init__(s, out, err="", rc=0): s.stdout, s.stderr, s.returncode = out, err, rc
    seen = {}
    def fake(argv, **kw): seen.update(argv=argv, env=kw["env"]); return R("", f"connect failed for {u}", 1)
    doc = run_node("/tmp", {"DATABASE_URL": u, "SF_MEMBER_ARGS": "{}"}, url_secrets(u), run=fake)
    ok("error" in doc and "s3cretPassw0rd" not in json.dumps(doc) and u not in json.dumps(doc), "a failed query's words carry no connection string", doc)
    ok(not any(u in a or "a@b.test" in a for a in seen["argv"]), "nothing secret, and no address, is on node's command line")
    doc = run_node("/tmp", {}, [], run=lambda argv, **kw: R('noise\n{"orgs": [{"org_id": "acme", "owners": 1, "people": [{"member": "owner", "invite": false}]}]}\n'))
    ok(check("x", "a@b.test", lambda a, e: doc)["member_of"] == ["acme"], "the query's one JSON line is what is read")
    print(f"membership: {n[0]} checks passed"); return 0

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["remote"] and len(a) == 2: sys.exit(remote_main(a[1]))
    if a == ["--self-test"]: sys.exit(self_test())
    sys.exit(__doc__)
