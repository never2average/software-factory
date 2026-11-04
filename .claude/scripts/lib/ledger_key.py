"""Secrets the factory GENERATES for an app because of its profile (mold_v0-227): today APP_LEDGER_SIGNING_KEY.

An app whose profile has `audit.sign` on (mold_v0-195, chain and sign) signs checkpoints of its hash-chained audit
trails with an Ed25519 key the database never sees. Nobody holds that key in an account somewhere, so it is never
TYPED: the factory makes it here and writes it straight to the deploy target. The mold declares which names are like
this, and when, in its mold.json:

  "profile_secrets": {"APP_LEDGER_SIGNING_KEY": {"when": "audit.sign", "generate": "ed25519_seed",
                                                  "project": "api", "retired_public_keys": "APP_LEDGER_PUBLIC_KEYS"}}

  when                 a dotted path in the app's effective profile (application.json profile, else its host pack's
                       profile, else the mold's own profile file); the name is required while it is true
  generate             ed25519_seed: 32 random bytes (base64), the form src/ledger.ts reads
  project              on Vercel, the project that reads it (the api project)
  retired_public_keys  the name the app publishes retired public keys under (comma-separated), beside the current one

Who reads it:
  provision.py <app> (the check) and mint.py's keys station   the name is required while `when` holds; missing, the
                       check prints `provision.py <app> --generate-secret NAME` and the station asks for that line
  provision.py <app> --generate-secret NAME [--rotate]         makes the key here, writes it to the target, prints only
                       the public key and its id (sha256 of the public key, 16 hex characters: src/ledger.ts keyId)
  a compose_remote deploy                                      the server lacks it: made and written the same way, with
                       the deploy's own yes (the server's env file only exists from the first deploy)

Rules: the seed is never printed, logged, stored in state or passed on a command line (it goes to the target's own
writer: Vercel's API body, or the server's env-merge on stdin). An existing key is never overwritten without --rotate;
a rotation first publishes every public key the app had (state's ledger_keys record and the app's own
/.well-known/ledger-keys.json) under the retired name, so checkpoints signed before it still verify, and refuses when
it cannot find the current key's public half. State keeps public keys only (infrastructure.json ledger_keys).

  python3 .claude/scripts/lib/ledger_key.py --self-test
"""
import base64, datetime, hashlib, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GENERATE_FLAG = "--generate-secret"


class Refused(Exception):
    """Nothing was generated or written; the message says why and what to do."""


def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _manifest(mold_id, root):
    try:
        with open(os.path.join(root or ROOT, "molds", str(mold_id or ""), "mold.json")) as fh: return json.load(fh)
    except (OSError, ValueError): return {}


def declared(mold_id, root=None, man=None):
    """{NAME: spec} of the mold's profile-generated secrets (mold.json profile_secrets); {} for a mold with none."""
    ps = ((man if man is not None else _manifest(mold_id, root)) or {}).get("profile_secrets") or {}
    return {k: v for k, v in ps.items() if not k.startswith("$") and isinstance(v, dict) and v.get("generate")}


def _walk(doc, path):
    cur = doc
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur: return None
        cur = cur[p]
    return cur


def profile_value(app, path, root=None):
    """The value at `path` in the profile the app's build carries: the app's own top-level field, else its host pack's,
    else the mold's own profile file (the order lib/app_profile.py write() lays them down)."""
    root = root or ROOT; top = path.split(".")[0]
    prof = (app or {}).get("profile") or {}
    if top in prof: return _walk(prof, path)
    try:
        import app_profile
        host = app_profile._host_profile(app, root)
        if top in host: return _walk(host, path)
        s = app_profile.spec(app.get("mold_id"), root)
    except Exception:
        s = None
    if s and s.get("file"):
        try:
            with open(os.path.join(root, "molds", str(app.get("mold_id")), "codebase", s["file"])) as fh: return _walk(json.load(fh), path)
        except (OSError, ValueError): return None
    return None


def needed(app, root=None, man=None):
    """[(NAME, spec)] the app needs because its profile turns them on (audit.sign for APP_LEDGER_SIGNING_KEY)."""
    return [(n, s) for n, s in declared((app or {}).get("mold_id"), root, man).items() if profile_value(app, s.get("when", ""), root) is True]


def names_needed(app, root=None, man=None): return [n for n, _ in needed(app, root, man)]


def how(app_id, name, script=".claude/scripts/provision.py"):
    """What a person (or the agent, after a yes) runs for a generated key: no value to find or paste."""
    return (f"Nothing to look up or paste: this key is made on the factory machine. With the operator's yes (it writes a secret "
            f"to the app's hosting), run: python3 {script} {app_id} {GENERATE_FLAG} {name} - it makes the key, writes it straight "
            f"to the app's settings and prints only its public half. Then run the check again.")


def command(app_id, name): return f"python3 .claude/scripts/provision.py {app_id} {GENERATE_FLAG} {name}"


# ---------------------------------------------------------------------------------------------------------------------
# the key itself
# ---------------------------------------------------------------------------------------------------------------------
def key_id(pub): return hashlib.sha256(pub).hexdigest()[:16]     # src/ledger.ts keyId


def raw32(v):
    """32 raw bytes from hex or base64(url), else None (src/ledger.ts raw32)."""
    v = str(v or "").strip()
    if re.fullmatch(r"[0-9a-fA-F]{64}", v): return bytes.fromhex(v)
    for dec in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            b = dec(v + "=" * (-len(v) % 4))
            if len(b) == 32: return b
        except (ValueError, TypeError): pass
    return None


_NODE = ("const c=require('node:crypto');const k=c.generateKeyPairSync('ed25519');"
         "const s=k.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);"
         "const p=k.publicKey.export({format:'der',type:'spki'}).subarray(-32);"
         "process.stdout.write(JSON.stringify({s:s.toString('base64'),p:p.toString('base64')}))")


def generate(run=subprocess.run):
    """(seed_b64, public_b64, key_id): a new Ed25519 key. The seed lives in this process only. Python's `cryptography`
    when present, else Node's own crypto (the same calls as the mold's scripts/ledger-keygen.ts) through a pipe."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization as S
        k = Ed25519PrivateKey.generate()
        seed = k.private_bytes(S.Encoding.Raw, S.PrivateFormat.Raw, S.NoEncryption())
        pub = k.public_key().public_bytes(S.Encoding.Raw, S.PublicFormat.Raw)
    except ImportError:
        r = run(["node", "-e", _NODE], capture_output=True, text=True, timeout=60)
        if r.returncode: raise Refused("no Ed25519 key could be made here: install Python's cryptography (pip install cryptography) or Node.js. Nothing was written.")
        d = json.loads(r.stdout); seed, pub = base64.b64decode(d["s"]), base64.b64decode(d["p"])
    return base64.b64encode(seed).decode(), base64.b64encode(pub).decode(), key_id(pub)


def public_of(seed_b64):
    """The public key (base64) of a seed, to prove a written seed matches what was recorded (self-test)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as S
    k = Ed25519PrivateKey.from_private_bytes(raw32(seed_b64))
    return base64.b64encode(k.public_key().public_bytes(S.Encoding.Raw, S.PublicFormat.Raw)).decode()


# ---------------------------------------------------------------------------------------------------------------------
# what the app already publishes
# ---------------------------------------------------------------------------------------------------------------------
def _read_json(url):
    r = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "15", "--fail", url], capture_output=True, text=True)
    if r.returncode: return None
    try: return json.loads(r.stdout)
    except ValueError: return None


def published(base_url, read_json=None):
    """[public key base64] the app serves at /.well-known/ledger-keys.json (current and retired); [] when unreadable."""
    if not base_url: return []
    doc = (read_json or _read_json)(base_url.rstrip("/") + "/.well-known/ledger-keys.json")
    out = []
    for k in (doc or {}).get("keys") or []:
        b = raw32((k or {}).get("public_key") or (k or {}).get("public_key_hex"))
        if b: out.append(base64.b64encode(b).decode())
    return out


def recorded(infra, name):
    """State's record of the keys made for NAME (public halves only), newest last."""
    return [r for r in (infra.get("ledger_keys") or []) if isinstance(r, dict) and r.get("name", name) == name]


def record(infra, name, pub_b64, kid, how_made):
    """Mark every earlier key of NAME retired and add the new one as current (public halves only)."""
    keys = infra.setdefault("ledger_keys", [])
    for r in keys:
        if isinstance(r, dict) and r.get("name", name) == name: r["current"] = False
    keys.append({"name": name, "kid": kid, "public_key": pub_b64, "current": True, "set_at": now(), "how": how_made})


# ---------------------------------------------------------------------------------------------------------------------
# --generate-secret NAME [--rotate]
# ---------------------------------------------------------------------------------------------------------------------
class Target:
    """Where the key goes. names() -> the env names the target holds (names only); write([(NAME, value)]) stores them
    (the value never on a command line); where: words for the person; url: the app's address (its published keys)."""
    def __init__(self, names, write, where, url=None, held=None):
        self.names, self.write, self.where, self.url = names, write, where, url
        self.held = held or (lambda n, have: n in have)


def generate_secret(app_id, app, infra, name, target, rotate=False, say=print, root=None, man=None, read_json=None, save=None):
    """Make NAME's key and write it to `target`. Returns 0; raises Refused with nothing written."""
    import agent_result as AR
    decl = declared(app.get("mold_id"), root, man)
    if name not in decl:
        raise Refused(f"{name} is not a key the factory makes for {app.get('mold_id')} apps (it makes: {', '.join(decl) or 'none'}). "
                      f"A value only you hold is set with: python3 .claude/scripts/provision.py {app_id} --set-secret {name}. Nothing was written.")
    spec = decl[name]
    if profile_value(app, spec.get("when", ""), root) is not True:
        raise Refused(f"{app_id}: {spec.get('when')} is off in this app's profile, so nothing would use {name}; nothing was made or written. "
                      f"Turn it on first (application.json profile, e.g. \"audit\": {{\"sign\": true}}), then rerun.")
    have = set(target.names())
    held = target.held(name, have)
    retired = []
    if held and not rotate:
        cur = [r for r in recorded(infra, name) if r.get("current")]
        said = f" (its key id is {cur[-1]['kid']})" if cur else ""
        raise Refused(f"{name} is already set on {target.where}{said}, and an existing key is never overwritten: nothing was made or written. "
                      f"To replace it (a rotation; the old public key stays published so older checkpoints still verify): "
                      f"python3 .claude/scripts/provision.py {app_id} {GENERATE_FLAG} {name} --rotate")
    if held and rotate:
        known = [r["public_key"] for r in recorded(infra, name) if r.get("public_key")] + published(target.url, read_json)
        if not known:
            raise Refused(f"{name} is set on {target.where}, but the public half of that key is neither in this app's state "
                          f"(infrastructure.json ledger_keys) nor readable at {(target.url or 'the app') + '/.well-known/ledger-keys.json'}. "
                          f"Rotating now would leave the checkpoints it signed unverifiable, so nothing was made or written. "
                          f"Deploy the app (so it publishes the key) and rerun.")
        retired = list(dict.fromkeys(k for k in known if raw32(k)))
    seed, pub, kid = generate()
    AR.forbid(seed)
    retired = [k for k in retired if k != pub]
    rk = spec.get("retired_public_keys")
    if retired and rk:   # first: the old keys stay published even if the second write never happens
        target.write([(rk, ",".join(retired))])
        say(f"  {rk} on {target.where}: {len(retired)} earlier public key(s) kept published, so checkpoints they signed still verify")
    target.write([(name, seed)])
    seed = None
    record(infra, name, pub, kid, "rotated" if retired else "generated")
    if save: save(infra)
    say(f"{name} {'rotated' if retired else 'generated'} on this machine and written to {target.where}; the private key was never shown, "
        f"logged or kept here. Public key {pub} (key id {kid}). It is published at /.well-known/ledger-keys.json once the app "
        f"runs with it: deploy for it to apply.")
    AR.note(summary=f"{name} {'rotated' if retired else 'generated'} and written to {target.where}; public key id {kid} (the private key was never shown or stored here).")
    return 0


def for_deploy(infra, name, say=print):
    """A compose_remote deploy's fresh key for a server that lacks it: (seed, pub, kid), recorded in infra (public half)."""
    import agent_result as AR
    seed, pub, kid = generate(); AR.forbid(seed)
    record(infra, name, pub, kid, "generated at the deploy")
    say(f"  {name}: the server has none, so one was made on this machine and goes into its env file (never shown). Public key {pub} (key id {kid})")
    return seed


# ---------------------------------------------------------------------------------------------------------------------
def self_test():
    """Offline: the profile switch, the key's form, never printing the seed, refusals, rotation. A fake target only."""
    import io, contextlib, tempfile, shutil
    import agent_result as AR
    n = [0]; fails = []
    def ok(c, what):
        n[0] += 1
        if not c: fails.append(what)
    man = _manifest("mold_v0", ROOT)
    d = declared("mold_v0", ROOT, man)
    ok("APP_LEDGER_SIGNING_KEY" in d and d["APP_LEDGER_SIGNING_KEY"]["when"] == "audit.sign" and d["APP_LEDGER_SIGNING_KEY"].get("retired_public_keys") == "APP_LEDGER_PUBLIC_KEYS",
       f"mold_v0's mold.json declares APP_LEDGER_SIGNING_KEY under audit.sign: {d}")
    ok(declared("mold_v1", ROOT) == {}, "mold_v1 declares no generated secret")
    on = {"app_id": "zz", "mold_id": "mold_v0", "profile": {"audit": {"sign": True}}}
    off = {"app_id": "zz", "mold_id": "mold_v0", "profile": {"audit": {"data": True}}}
    ok(names_needed(on, ROOT) == ["APP_LEDGER_SIGNING_KEY"], "audit.sign on: the key is needed")
    ok(names_needed(off, ROOT) == [] and names_needed({"mold_id": "mold_v0"}, ROOT) == [] and names_needed({"mold_id": "mold_v1", "profile": {"audit": {"sign": True}}}, ROOT) == [],
       "audit.sign off or absent, or a mold without the feature: not needed")
    import single_service as SS
    F = SS.compose_facts(SS.codebase("mold_v0", ROOT), man)
    ok({"APP_LEDGER_SIGNING_KEY", "APP_LEDGER_PUBLIC_KEYS"} <= set(F["optional"]),
       "the mold's compose file hands both ledger names to the API container (else a server's key would never reach it)")
    s, p, k = generate()
    ok(raw32(s) and len(raw32(s)) == 32 and len(raw32(p)) == 32 and k == hashlib.sha256(raw32(p)).hexdigest()[:16] and public_of(s) == p,
       "a key: a 32-byte seed in base64 (what src/ledger.ts reads), its public key, and the id src/ledger.ts computes")
    ok(generate()[0] != s, "each key is new")

    class Fake:
        def __init__(self, have=None): self.env = dict(have or {}); self.writes = []
        def target(self, url=None): return Target(lambda: set(self.env), self.w, "the fake target", url)
        def w(self, pairs):
            for k_, v_ in pairs: self.env[k_] = v_; self.writes.append(k_)
    t = tempfile.mkdtemp(prefix="ledger-key-selftest-")
    try:
        ip = os.path.join(t, "infrastructure.json"); log = os.path.join(t, "run.log")
        sv = lambda i: json.dump(i, open(ip, "w"))
        out = io.StringIO()
        def go(app, infra, fk, **kw):
            AR.reset(); said = []
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                try: rc = generate_secret("zz", app, infra, kw.pop("name", "APP_LEDGER_SIGNING_KEY"), fk.target(kw.pop("url", None)), say=lambda x: (said.append(x), print(x)), root=ROOT, man=man, save=sv, **kw)
                except Refused as e: rc = str(e); print(e)
            open(log, "a").write("\n".join(said) + "\n" + json.dumps(AR.NOTES) + "\n")
            return rc, said
        fk = Fake(); infra = {}
        rc, said = go(on, infra, fk)
        seed1 = fk.env.get("APP_LEDGER_SIGNING_KEY", "")
        rec = recorded(infra, "APP_LEDGER_SIGNING_KEY")
        ok(rc == 0 and fk.writes == ["APP_LEDGER_SIGNING_KEY"] and raw32(seed1) and rec and rec[-1]["public_key"] == public_of(seed1) and rec[-1]["current"],
           f"generated: written to the target once, its public half recorded in state: {fk.writes} {rec}")
        ok(any(rec[-1]["public_key"] in x and rec[-1]["kid"] in x for x in said), "it prints the public key and its id")
        rc2, _ = go(on, infra, fk)
        ok(isinstance(rc2, str) and "never overwritten" in rc2 and "--rotate" in rc2 and fk.env["APP_LEDGER_SIGNING_KEY"] == seed1, "an existing key is never overwritten without --rotate")
        rc3, said3 = go(on, infra, fk, rotate=True, url="https://zz.example.org", read_json=lambda u: {"keys": [{"public_key": rec[0]["public_key"]}]})
        seed2 = fk.env["APP_LEDGER_SIGNING_KEY"]; rec2 = recorded(infra, "APP_LEDGER_SIGNING_KEY")
        ok(rc3 == 0 and seed2 != seed1 and fk.env.get("APP_LEDGER_PUBLIC_KEYS") == rec2[0]["public_key"] and fk.writes[-2:] == ["APP_LEDGER_PUBLIC_KEYS", "APP_LEDGER_SIGNING_KEY"]
           and [r["current"] for r in rec2] == [False, True] and rec2[-1]["public_key"] == public_of(seed2),
           f"--rotate: the old public key published under APP_LEDGER_PUBLIC_KEYS first, then the new key; state marks the old one retired: {fk.writes} {rec2}")
        rc4, _ = go(on, {}, Fake({"APP_LEDGER_SIGNING_KEY": "x"}), rotate=True, url=None)
        ok(isinstance(rc4, str) and "unverifiable" in rc4, "--rotate with the current key's public half nowhere to be found: refused, nothing written")
        fk5 = Fake(); rc5, _ = go(off, {}, fk5)
        ok(isinstance(rc5, str) and "off" in rc5 and not fk5.writes, "audit.sign off: refused, nothing made")
        fk6 = Fake(); rc6, _ = go(on, {}, fk6, name="RESEND_API_KEY")
        ok(isinstance(rc6, str) and "--set-secret" in rc6 and not fk6.writes, "a name the mold does not generate: refused, pointed at --set-secret")
        inf7 = {}; buf = io.StringIO()
        with contextlib.redirect_stdout(buf): s7 = for_deploy(inf7, "APP_LEDGER_SIGNING_KEY")
        ok(raw32(s7) and recorded(inf7, "APP_LEDGER_SIGNING_KEY")[-1]["public_key"] == public_of(s7) and s7 not in buf.getvalue(), "a deploy's key: recorded by its public half, the seed not printed")
        # the seeds never appear in any output, file or log
        seeds = [seed1, seed2, s7] + [v for v in (fk.env.get("APP_LEDGER_SIGNING_KEY"),) if v]
        texts = out.getvalue() + buf.getvalue() + "".join(open(os.path.join(dp, f), errors="replace").read() for dp, _, fs in os.walk(t) for f in fs)
        forms = [f for s_ in seeds for f in (s_, raw32(s_).hex(), base64.urlsafe_b64encode(raw32(s_)).decode().rstrip("="), s_.rstrip("="))]
        ok(not [f for f in forms if f in texts], "no generated seed (base64, base64url or hex) appears in any output, state file or log")
        ok(fk.env["APP_LEDGER_SIGNING_KEY"] not in json.dumps(json.load(open(ip))), "state holds public keys only")
    finally:
        shutil.rmtree(t, ignore_errors=True)
    if fails:
        print("ledger_key self-test FAILED:\n  " + "\n  ".join(fails)); return 1
    print(f"ledger_key: {n[0]} checks passed (the profile switch, the key, never printed, no overwrite, rotation; a fake target)")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]: sys.exit(self_test())
    sys.exit(__doc__)
