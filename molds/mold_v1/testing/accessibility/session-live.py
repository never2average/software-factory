#!/usr/bin/env python3
"""Precondition probe for the accessibility lane's signed-in checks: is there a session to measure WITH?

  python3 molds/mold_v1/testing/accessibility/session-live.py <base_url> [--session-env NAME]
                                                            [--min-remaining SECONDS]

Exit 0 only when the named environment variable holds a session THIS deployment still accepts, for an identity
that belongs to at least one workspace there, with enough life left to outlast the check that is about to run.
Anything else exits 1, which the runner reads as an unmet precondition and records the check `skipped` and the
lane `skipped` — never `pass`, because a lane that could not sign in has not seen the product.

WHERE THE SESSION COMES FROM (mold_v1-040). lane.json runs this probe — and the harness — through
`.claude/scripts/lib/session.py <app_id> -- …`, which signs a session for the application's own FDE identity
(application.workspace.fde_self.email) with the app's own AUTH_JWT_PRIVATE_KEY, read by name from the app's
secret store, and hands it over in the variable. That is a real session on this mold: lib/ops-auth.ts admits
the app's ES256 "email-session" token on its signature alone (the emailed code gates the mint ROUTE, not the
token), and it is the same token the app's own verify route would hand that person. A session an operator
signed in for and exported (README, "Authenticated coverage") still wins: if the variable is already set the
helper mints nothing. Either way this probe only READS the variable; it never signs anything.

WHY THIS IS A PRECONDITION AND NOT A ROW IN THE HARNESS. A `fail` row reverts the application and files a
defect against the mold (.claude/scripts/lanes.py: a failed lane sets `status: reverted`). A session the
deployment refuses says nothing whatever about the application — it says the key the factory holds is not the
key the deployment runs with (an app redeployed with a rotated pair), or an operator's paste went stale. Grading
that as a product defect would revert a healthy deployment and tell a non-technical operator their app was
broken when their credential was. So "is this credential usable" is answered HERE, before a browser opens,
where the only verdicts available are `skipped` and "run it". The harness downstream still refuses to grade
anything it did not measure — a refused session there prints `not-covered` and exits 2, it never prints `pass`.

WHY THE MEMBERSHIP CHECK. The token proves an email and nothing else; workspace membership is read from the
database on every request (lib/org-context.ts). An identity the deployment admits but that belongs to no
workspace is sent to onboarding by the app's own auth gate, so the "signed-in surface" would be an empty shell:
that is `skipped` with the reason, not a measurement, and not a `fail` against the application either.

WHY THE EXPIRY MARGIN. Checking `exp` is in the future is not enough: a token with 40 seconds left passes the
probe and then dies in the middle of a 15-minute run. `--min-remaining` is set from the check's own `timeout_s`
plus slack in lane.json, so a token that cannot outlive the run is refused now — with one instruction — rather
than half way through it.

THE TOKEN IS READ BY NAME AND NEVER PRINTED, and neither is the response body: only the identity the claims
name, the expiry, and how many workspaces the deployment lists for it, so a lane report can say who the product
was measured as without becoming the place the credential leaks.

(The accessibility and responsiveness lanes carry a copy each. The duplication is on purpose — a lane folder is
meant to be self-contained, so copying it into a future mold brings everything it needs.)
"""
import base64, json, os, re, sys, time, urllib.error, urllib.request
from urllib.parse import urlparse

# HARD RULE 2: the live factory projects are never touched, by anything, including a probe. A
# `production_url` pointing at one of them is a provisioning defect; this refuses to send a
# credential there rather than "just reading" from production.
LIVE = re.compile(r"(^|\.)fde-(agent|agent-api|task-workflow)[^.]*\.", re.I)
PATH = "/api/ops/orgs"   # the app's own read-only ops GET (app/_components/ops/lib.ts sends exactly this)

def claims(tok):
    """Decoded, NOT verified. The deployment's own answer below is the verdict; this only reads exp."""
    p = tok.split(".")
    if len(p) != 3: return None
    try: return json.loads(base64.urlsafe_b64decode(p[1] + "=" * (-len(p[1]) % 4)))
    except Exception: return {}

def main(a):
    if not a or a[0].startswith("--"): sys.exit(__doc__)
    base = a[0].rstrip("/")
    env = a[a.index("--session-env") + 1] if "--session-env" in a else "MOLD_V1_SESSION_TOKEN"
    need = int(a[a.index("--min-remaining") + 1]) if "--min-remaining" in a else 0
    how = (f"Run the check through the factory's session helper, which signs one for the application's own FDE "
           f"identity (python3 .claude/scripts/lib/session.py <app_id> -- …, as lane.json does); if it says why it "
           f"cannot, sign in to the app yourself, copy that browser's `fde-google-token` value out of localStorage, "
           f"and re-run with it in {env}.")

    tok = (os.environ.get(env) or "").strip()
    if not tok:
        print(f"{env} is not set, so the signed-in product surface cannot be measured. {how}", file=sys.stderr); return 1
    c = claims(tok)
    if c is None:
        print(f"{env} is set but is not a JWT (expected three dot-separated parts). {how}", file=sys.stderr); return 1
    exp, left = c.get("exp"), None
    if isinstance(exp, (int, float)):
        left = int(exp - time.time())
        if left <= 0:
            print(f"the session in {env} expired {-left}s ago, so this run would measure nothing. {how}", file=sys.stderr); return 1
        if left < need:
            print(f"the session in {env} has {left}s left, less than the {need}s this check needs to finish; "
                  f"it would die mid-run and measure nothing. {how}", file=sys.stderr); return 1
    host = urlparse(base).hostname or ""
    if LIVE.search(host):
        print(f"{host} is one of the live factory projects; this probe will not send a credential to it. "
              "Point the application's production_url at its own deployment.", file=sys.stderr); return 1

    req = urllib.request.Request(base + PATH, headers={"authorization": "Bearer " + tok})
    body = b""
    try:
        r = urllib.request.urlopen(req, timeout=20)   # read-only GET; the body is parsed for a COUNT and never printed
        code, body = r.status, r.read(8 << 20)   # a workspace logo travels here as a data: URI; 64 KB cut the JSON off and skipped every signed-in check
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:
        print(f"{base}{PATH} is unreachable, so the session could not be checked: {e}", file=sys.stderr); return 1
    if code in (401, 403):
        print(f"{base}{PATH} answered HTTP {code}: this deployment does not accept the session in {env} "
              f"(wrong application, or signed out elsewhere). Nothing would be measured. {how}", file=sys.stderr); return 1
    if not 200 <= code < 300:
        print(f"{base}{PATH} answered HTTP {code}, so the session could not be checked. {how}", file=sys.stderr); return 1
    who = c.get("email") or c.get("sub") or "(the token names no email)"
    try: orgs = len(json.loads(body).get("items") or [])
    except Exception: orgs = -1
    if orgs < 1:
        # Admitted is not the same as a member (lib/org-context.ts): with no workspace the app's own auth gate
        # sends this identity to onboarding, and the "signed-in surface" would be an empty shell. Nothing to
        # measure, so nothing is graded — and it is not a defect of the application either.
        print(f"{base}{PATH} {code}: this deployment accepts the session for {who}, but lists "
              f"{'no workspace' if orgs == 0 else 'an unreadable answer'} for that identity, so signing in would land "
              f"on onboarding rather than the product and nothing would be measured. Seed the application's workspace "
              f"with its FDE as a member (application.workspace.members), or sign in as a member and re-run with that "
              f"session in {env}.", file=sys.stderr); return 1
    print(f"{base}{PATH} {code} · session accepted for {who} · member of {orgs} workspace(s)" +
          (f" · {left}s left (needs {need}s)" if left is not None else " · no exp claim; the server's answer is the verdict"))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
