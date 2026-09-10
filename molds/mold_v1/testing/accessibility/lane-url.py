#!/usr/bin/env python3
"""Which URL does the accessibility lane measure for this application? Printed, or refused with one sentence.

  python3 molds/mold_v1/testing/accessibility/lane-url.py <app_id>             the URL alone
  python3 molds/mold_v1/testing/accessibility/lane-url.py <app_id> --harness   the harness arguments:
                                                                                `--url <url>`, plus what the
                                                                                fixture cannot serve

Exit 0 with the URL on stdout, or exit 1 with the reason on stderr — which the runner records as an unmet
precondition and a `skipped` lane, never `pass` and never `fail`.

TWO KINDS OF TARGET, IN THIS ORDER:
  1. A deployment: `infrastructure.vercel.production_url`, when it is set. That is the URL the lane has
     always graded, and it wins whenever it exists — an operator cannot point this lane elsewhere for an
     app that has a production URL.
  2. A LOCAL FIXTURE, for a `target: vm` application only (mold_v1-040). The vm lane never starts a web
     process (infra/vm/README.md) and its state cannot carry a URL (mold_v1-053), so an operator who has
     started the mold on this box says where in MOLD_V1_LANE_URL — an argument to the lane, not a state
     field. It is honoured only when ALL of these hold, each the safe reading (HARD RULE 8):
       - the app is `target: vm` with `secret_store: vm_env_file` and has no production_url: a fixture whose
         key the factory itself generated, the same guard .claude/scripts/lib/session.py applies before it
         signs a session for it. A vercel app is never measured at an operator-typed URL.
       - the app's status is planned, reverted or retired: it serves nobody.
       - the URL is plain http on 127.0.0.1 or localhost — a process on THIS box that the operator started.
         Anything else (a hostname, https, another address) is refused: this is not a way to aim the lane at
         a server the factory did not verify, and it is certainly not a way to aim it at a live project.
       - the URL has no whitespace, because lane.json splices it into a shell command unquoted for --harness.

WHAT `--harness` ADDS. A vm fixture is the web app alone: the task-workflow service that the workflow
builder is a client of (lib/task-workflow-service.ts) is one of the three deployables the vm lane does not
run (infra/vm/README.md). Measuring the builder there would fail on a control the service would have
rendered — a defect of the fixture, not of the application — so the harness is told `--without
task-workflow` and prints that one surface `not-covered` with the reason (a11y.mjs). A deployment gets no
such flag: there, an absent builder IS a defect. The flag is emitted here, next to the URL decision, so the
declaration and the fixture it describes cannot drift apart.

(The accessibility and responsiveness lanes carry a copy each. The duplication is on purpose — a lane
folder is meant to be self-contained, so copying it into a future mold brings everything it needs.)
"""
import json, os, re, sys
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
LANE = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
ENV = "MOLD_V1_LANE_URL"
FIXTURE_STATUSES = ("planned", "reverted", "retired")      # provision.py VM_STATUSES: a vm app serves nobody
FIXTURE_LACKS = ("task-workflow",)                          # the services the vm lane does not run (infra/vm/README.md)

def die(msg): print(msg, file=sys.stderr); sys.exit(1)
def load(p): return json.load(open(p))

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    app_id, harness = a[0], "--harness" in a[1:]
    adir = os.path.join(ROOT, "state/application", app_id)
    try: app, infra = load(os.path.join(adir, "application.json")), load(os.path.join(adir, "infrastructure.json"))
    except Exception:
        die(f"{app_id}: state/application/{app_id}/ has no readable application.json and infrastructure.json, so there is no application to measure.")
    purl = ((infra.get("vercel") or {}).get("production_url") or "").strip().rstrip("/")
    if purl:
        print(f"--url {purl}" if harness else purl); return 0
    tgt, store, st = infra.get("target"), infra.get("secret_store"), app.get("status")
    deploy = f"python3 .claude/scripts/provision.py {app_id} --deploy"
    if tgt != "vm" or store != "vm_env_file":
        die(f"{app_id}: no infrastructure.vercel.production_url yet — this lane grades rendered pages, so deploy the app first: {deploy}")
    if st not in FIXTURE_STATUSES:
        die(f"{app_id}: status {st!r} is not one a target=vm fixture can hold ({', '.join(FIXTURE_STATUSES)}), so this lane will not "
            f"measure a local URL for it. Fix the status in state/application/{app_id}/application.json.")
    raw = (os.environ.get(ENV) or "").strip()
    how = (f"start the mold on this box against the app's own env (molds/mold_v1/testing/{LANE}/README.md, \"Measuring a vm "
           f"fixture\"), then: {ENV}=http://127.0.0.1:<port> python3 .claude/scripts/lanes.py {app_id} --lane {LANE}")
    if not raw:
        die(f"{app_id}: target vm serves no web process and {ENV} is not set, so there is no page to grade. Either {how}; "
            f"or deploy it: set \"target\": \"vercel\" and run {deploy}")
    u = urlsplit(raw)
    if (u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost") or u.path not in ("", "/") or u.query or u.fragment
            or re.search(r"\s", raw) or u.username or u.password):
        die(f"{app_id}: {ENV} must be the mold started on THIS box, http://127.0.0.1:<port> or http://localhost:<port> and nothing "
            f"more — it is not honoured for any other address, so a lane cannot be aimed at a server the factory did not verify. "
            f"Then: {how}")
    url = raw.rstrip("/")
    if not harness: print(url); return 0
    print(" ".join(["--url", url] + [x for s in FIXTURE_LACKS for x in ("--without", s)]))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
