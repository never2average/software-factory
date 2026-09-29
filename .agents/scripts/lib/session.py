#!/usr/bin/env python3
"""A session for an application the factory provisioned, handed to ONE command by name and never printed.

  session.py <app_id> -- <command...>   run <command> with <MOLD>_SESSION_TOKEN (MOLD_V1_SESSION_TOKEN for
                                        mold_v1) set to a session for the app's own FDE identity; exit as it exits
  session.py <app_id> --explain         who it would sign in as, with which key, for how long; mints nothing

WHAT A SESSION IS ON THIS MOLD, read from the code rather than assumed (molds/mold_v1/codebase/lib/auth-session.ts,
lib/ops-auth.ts, proxy.ts). Every /api/ops/* request carries `Authorization: Bearer <token>`, and the token is one
of two things: a Google ID token (signed by Google, needs an `hd` claim — the factory cannot produce one and must
not try), or the app's OWN "email-session" token: ES256, signed with the app's AUTH_JWT_PRIVATE_KEY, claims
{email, kind:"email-session", sub, iss:"delivered", aud:"delivered-app", iat, exp}. verifyOpsAuth checks THAT
kind first and asks nothing else of it — the emailed six-digit code gates only the route that mints
(app/api/auth/email/verify), not the token. The browser's "signed in" is the same token under localStorage
`workspace-google-token` (legacy `fde-google-token`; app/_components/auth-gate.tsx admits `kind === "email-session"`). So for an application whose
private key the factory itself generated and holds by name, the factory can sign a session and it is a real one:
the same bytes the app's own verify route would return to that person after a code.

WHO IT SIGNS IN AS: application.workspace.fde_self.email — the FDE this application was stamped for, recorded in
state and seeded as its workspace owner. Never a hard-coded person and never an address the factory invents: the
token proves an email, and membership is read from the app's database on every request (lib/org-context.ts), so
an identity with no membership sees an empty isolated workspace and the lane's probe says so instead of grading.

WHERE THE KEY COMES FROM, by name, from the app's own secret store (infrastructure.secret_store):
  vm_env_file  infra/vm/apps/<app_id>/.env            (0600, gitignored) — the ONLY store this helper reads.
  A Vercel-held key (secret_store vercel_env) is never pulled and never used to sign: such an app can serve a real
  person, and the fixture guard in state() refuses it before any key is looked for.
Nothing is written anywhere: the value goes from the store to node's stdin-free environment for one `sign`
call, the token goes into the child's environment, and neither reaches argv, a file, stdout or state.

WHY SHORT. The mold's own sessions last seven days; this one lasts --ttl seconds, default 1800: the longest lane
check that needs it is 900s and its precondition asks for 1200s of life (HARD RULE 8: the safe value). A session
that outlives the run it was minted for is a credential lying around for nothing.

WHY THE OPERATOR'S OWN SESSION WINS. If <MOLD>_SESSION_TOKEN is already set, the command runs with it untouched and
nothing is minted — a human who signed in and lent that session (the READMEs' manual path) is measuring the
product as themselves, on purpose, and a minted token silently replacing theirs would measure someone else.
"""
import base64, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
REDACTED = "[SENSITIVE]"    # what `vercel env pull` writes for a variable the CLI may not read (provision.py)
DEFAULT_TTL, MIN_TTL, MAX_TTL = 1800, 60, 7 * 24 * 3600   # the ceiling is the mold's own SESSION_TTL_SECONDS
KEY = "AUTH_JWT_PRIVATE_KEY"

def die(msg): print(msg, file=sys.stderr); sys.exit(1)
def load(p): return json.load(open(p))
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def docs(app_id):
    adir = os.path.join(ROOT, "state/application", app_id)
    if not os.path.isfile(os.path.join(adir, "application.json")):
        die(f"{app_id}: no such application (state/application/{app_id}/application.json does not exist), so there is "
            f"no identity to sign in as. Nothing was minted.")
    return load(os.path.join(adir, "application.json")), load(os.path.join(adir, "infrastructure.json"))

def state(app_id):
    app, infra = docs(app_id)
    # A HARNESS IDENTITY, NEVER A USER'S. The mold's own sign-in demands inbox proof (a six-digit code
    # emailed to the person) and this helper supplies none, so a token it signs is legitimate ONLY as a
    # test fixture against a database that serves nobody: a target=vm app on this box, in a status that
    # says it serves nothing, with no production URL, whose key the FACTORY generated. Any app that could
    # have a real user — a vercel target, a deployed status, a production URL — is refused outright.
    # Found by the round-4 critic: the first version would have signed for any app's fde_self.
    st = app.get("status"); tgt = infra.get("target"); purl = (infra.get("vercel") or {}).get("production_url")
    if tgt != "vm" or infra.get("secret_store") != "vm_env_file":
        die(f"{app_id}: target is {tgt!r} — this helper mints a HARNESS session for a local vm fixture only, never "
            f"for an app that can serve a real person. Nothing was minted.")
    if st not in ("planned", "reverted", "retired") or purl:
        die(f"{app_id}: status {st!r}" + (f" with production_url {purl!r}" if purl else "") + " — a session may only be "
            f"minted for a fixture that serves nobody. Nothing was minted.")
    print(f"{app_id}: minting a HARNESS session for the local vm fixture (not a user sign-in)", file=sys.stderr)
    email = ((app.get("workspace") or {}).get("fde_self") or {}).get("email", "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", email):
        die(f"{app_id}: application.workspace.fde_self.email is missing, so there is no named person to sign in as. "
            f"Set it in state/application/{app_id}/application.json (the FDE this app was stamped for) and rerun.")
    return app.get("mold_id") or die(f"{app_id}: application.json has no mold_id"), email, infra

def contract(mold_id):
    """The mold's own constants, read from its source, so a future mold that renames them is refused, not forged."""
    f = os.path.join(ROOT, "molds", mold_id, "codebase/lib/auth-session.ts")
    src = open(f).read() if os.path.isfile(f) else ""
    grab = lambda name: (re.search(r'const\s+%s\s*=\s*"([^"]+)"' % name, src) or [None, None])[1]
    iss, aud, alg = grab("SESSION_ISSUER"), grab("SESSION_AUDIENCE"), grab("ALG")
    kind = (re.search(r'kind:\s*"([^"]+)"', src) or [None, None])[1]
    if not (iss and aud and alg and kind):
        die(f"{mold_id}: could not read the session contract (SESSION_ISSUER, SESSION_AUDIENCE, ALG, kind) from "
            f"molds/{mold_id}/codebase/lib/auth-session.ts, so no session can be minted for this mold — a token "
            f"signed against guessed claims would be refused by the app and grade nothing.")
    if alg != "ES256":
        die(f"{mold_id}: lib/auth-session.ts signs {alg}; this helper signs ES256 only. Nothing was minted.")
    return {"iss": iss, "aud": aud, "alg": alg, "kind": kind}

def pem_of(raw):
    """PEM, or base64-of-PEM — the two shapes lib/auth-session.ts readKeyMaterial accepts; None otherwise."""
    v = (raw or "").strip().strip('"')
    if not v or v == REDACTED: return None
    if "-----BEGIN" in v: return v.replace("\\n", "\n")
    try:
        d = base64.b64decode(re.sub(r"\s+", "", v)).decode()
        return d if "-----BEGIN" in d else None
    except Exception: return None

def env_file_value(path, name):
    for l in (open(path) if os.path.isfile(path) else []):
        if l.startswith(name + "="): return l.split("=", 1)[1].rstrip("\n")
    return None

def private_key(app_id, infra):
    """The app's private key by name, from its own store. Returns (pem, where) or dies with one instruction."""
    store = infra.get("secret_store")
    if store != "vm_env_file":
        die(f"{app_id}: secret_store is {store!r}; a session is only ever minted from a key the factory generated for a "
            f"local vm fixture (infra/vm/apps/<app>/.env). A Vercel-held key is never used to sign one. Nothing was minted.")
    if store == "vm_env_file":
        f = os.path.join(ROOT, "infra/vm/apps", app_id, ".env"); where = f"infra/vm/apps/{app_id}/.env"
        if not os.path.isfile(f):
            die(f"{app_id}: {where} does not exist, so the app's signing key is not on this box. Bring the app up "
                f"first: python3 .claude/scripts/provision.py {app_id} --verify-db")
        raw = env_file_value(f, KEY)
        if raw is None:
            die(f"{app_id}: {where} has no {KEY}, so nothing can sign a session for this app. --verify-db mints the "
                f"pair into that file (the same one the vercel lane mints): python3 .claude/scripts/provision.py "
                f"{app_id} --verify-db. Or sign in to the app yourself and pass that browser's workspace-google-token as "
                f"the lane's session variable.")
        pem = pem_of(raw)
        if not pem: die(f"{app_id}: {KEY} in {where} is neither a PEM nor base64 of one. Regenerate the pair.")
        return pem, where

def sign(pem, signing_input):
    """ES256 = ECDSA P-256 over SHA-256 with the signature as raw r||s (ieee-p1363), which is what jose verifies.
    Python's stdlib has no ECDSA, so the one signature is made by node (always present: provision.py generates the
    pair with it), with the key and the input in the child's ENVIRONMENT — never argv, never a file."""
    if "PRIVATE KEY" not in pem:
        die(f"{KEY} holds a public key or something else, not a private key. Regenerate the pair.")
    js = ("const c=require('crypto');process.stdout.write(c.sign('sha256',Buffer.from(process.env.SF_INPUT),"
          "{key:process.env.SF_PEM,dsaEncoding:'ieee-p1363'}).toString('base64url'))")
    r = subprocess.run(["node", "-e", js], env=dict(os.environ, SF_PEM=pem, SF_INPUT=signing_input),
                       capture_output=True, text=True)
    if r.returncode or not r.stdout:
        die("the signing key could not be used: " + ((r.stderr.strip().splitlines() or ["no output"])[-1][:160]) +
            ". Regenerate the pair and rerun.")
    return r.stdout.strip()

def mint(email, c, pem, ttl):
    now = int(time.time())
    hdr = b64u(json.dumps({"alg": c["alg"], "typ": "JWT"}, separators=(",", ":")).encode())
    pl = b64u(json.dumps({"email": email, "kind": c["kind"], "sub": email, "iss": c["iss"], "aud": c["aud"],
                          "iat": now, "exp": now + ttl}, separators=(",", ":")).encode())
    return f"{hdr}.{pl}.{sign(pem, hdr + '.' + pl)}"

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    app_id = a[0]; rest = a[1:]
    ttl = DEFAULT_TTL
    if "--ttl" in rest:
        i = rest.index("--ttl")
        try: ttl = int(rest[i + 1])
        except (IndexError, ValueError): die("--ttl needs a number of seconds")
        del rest[i:i + 2]
        if not MIN_TTL <= ttl <= MAX_TTL: die(f"--ttl must be between {MIN_TTL} and {MAX_TTL} seconds (the mold's own ceiling)")
    mold_id = docs(app_id)[0].get("mold_id") or die(f"{app_id}: application.json has no mold_id")
    var = f"{re.sub(r'[^A-Za-z0-9]', '_', mold_id).upper()}_SESSION_TOKEN"
    # The operator's own session wins BEFORE the fixture guard below: the command then runs with the
    # environment it already had and nothing is minted, so there is nothing for the guard to refuse. This
    # is the only way a signed-in surface on a deployment (a target=vercel app, which the guard refuses to
    # mint for) is ever measured by a lane, and it is the operator's sign-in, never the factory's.
    if rest[:1] == ["--"] and len(rest) >= 2 and os.environ.get(var, "").strip():
        print(f"{var} is already set: running with that session, nothing minted (an operator's own sign-in wins)", file=sys.stderr)
        return subprocess.run(rest[1:]).returncode
    mold_id, email, infra = state(app_id)
    if rest[:1] == ["--explain"]:
        c = contract(mold_id)
        print(f"{app_id}: would sign in as {email} ({c['alg']}, iss {c['iss']}, aud {c['aud']}, kind {c['kind']}), "
              f"key {KEY} from {infra.get('secret_store')}, {ttl}s of life, handed to the command as {var}. Nothing minted.")
        return 0
    if rest[:1] != ["--"] or len(rest) < 2: sys.exit(__doc__)
    cmd = rest[1:]
    c = contract(mold_id); pem, where = private_key(app_id, infra)
    tok = mint(email, c, pem, ttl)
    print(f"session minted for {email} on {app_id} ({c['alg']}, key from {where}, {ttl}s of life); handed to the "
          f"command as {var} and never printed", file=sys.stderr)
    return subprocess.run(cmd, env=dict(os.environ, **{var: tok})).returncode

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
