#!/usr/bin/env python3
"""Intake (rehearsal copy): a one-page brief -> the four state files of one application.

  intake.py <brief.md> --app <app_id> [--mold mold_v1] [--answers state/application/<app_id>/answers.json]

Lines the brief may carry, each on its own line: `Product name:`, `Colour: #RRGGBB`, `Workspace:`, `Owner: <email>`,
`Members: <emails>`, plus phrases such as "web search on" or "browser off". What the brief does not answer goes to
state/application/<app_id>/questions.json (exit 2); the answers come back in answers.json, keyed by question id.
Secrets are written as names only.
"""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from rehearsal import ROOT, adir, die, load, log_call, save


def field(text, name):
    m = re.search(rf"^\s*[-*]?\s*{name}\s*:\s*(.+?)\s*$", text, re.I | re.M)
    return m.group(1).strip().strip('"') if m else None


def flag(text, name):
    m = re.search(rf"{name}\s*(?::|is)?\s*(on|off|yes|no|enabled|disabled)", text, re.I)
    return bool(m) and m.group(1).lower() in ("on", "yes", "enabled")


def main(argv):
    log_call("intake.py", argv)
    if not argv or "--app" not in argv: sys.exit(__doc__)
    brief = argv[0]; app = argv[argv.index("--app") + 1]
    mold = argv[argv.index("--mold") + 1] if "--mold" in argv else "mold_v1"
    p = os.path.join(ROOT, brief)
    if not os.path.exists(p): die(f"no brief at {brief}", 2)
    text = open(p).read()
    ans = {}
    if "--answers" in argv:
        ap = os.path.join(ROOT, argv[argv.index("--answers") + 1])
        if os.path.exists(ap): ans = load(ap)
    owner = field(text, "Owner") or ans.get("owner")
    workspace = field(text, "Workspace") or ans.get("workspace")
    questions = []
    if not owner: questions.append({"id": "owner", "question": "Who owns the first workspace? (their email address)"})
    if not workspace: questions.append({"id": "workspace", "question": "What is the first workspace called?"})
    d = adir(app); os.makedirs(d, exist_ok=True)
    save(os.path.join(d, "questions.json"), questions)
    if questions:
        print(f"{len(questions)} question(s) the brief does not answer: state/application/{app}/questions.json")
        return 2
    members = [m.strip() for m in re.split(r"[,\s]+", field(text, "Members") or "") if "@" in m]
    web, browser = flag(text, "web search"), flag(text, "browser")
    name = field(text, "Product name"); colour = field(text, "Colou?r")
    secrets = ["MODEL_API_KEY", "RESEND_API_KEY"] + (["EXA_API_KEY"] if web else [])
    a = {"app_id": app, "mold_id": mold, "status": "stamped", "brief": brief, "mold_commit": None,
         "surface": {"branding": {"product_name": name, "brand_color": colour} if name else {},
                     "flags": {"web_search": web, "browser": browser}},
         "workspace": {"org": {"org_id": re.sub(r"[^a-z0-9]+", "-", workspace.lower()).strip("-"), "name": workspace},
                       "owner": owner, "members": [{"email": owner, "role": "owner"}] + [{"email": m, "role": "member"} for m in members if m != owner]},
         "testing": {}}
    i = {"target": "vercel", "vercel": {"project": app.replace("_", "-"), "framework": "nextjs", "production_url": None},
         "secrets_user": secrets, "deployed_at": None}
    save(os.path.join(d, "application.json"), a); save(os.path.join(d, "infrastructure.json"), i)
    save(os.path.join(d, "datastores.json"), {"postgres": {"provider": "neon", "url_ref": "DATABASE_URL", "rls_verified": False}})
    save(os.path.join(d, "datainfra.json"), {"blob": {"store_ref": "BLOB_READ_WRITE_TOKEN"}})
    print(f"state written: state/application/{app}/ (four files); secrets by name: {', '.join(secrets)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
