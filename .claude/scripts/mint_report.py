#!/usr/bin/env python3
"""mint_report.py <app_id> [--json]   |   --self-test          (also: mint.py <app_id> report)

What it took to mint one application: time and money, each figure labelled by how it is known.

  measured      read from a record that was written when the thing happened (the agent sessions' own cost and
                duration counters, git history, lane reports, the running app's usage table)
  not measured  named, with where the operator can see it; never guessed

Sources
  agent work    ~/.claude/projects/<this repo>/*.jsonl — every session that names the app. Each carries running
                `cost-state` records (cost in USD at API list prices, model time, tool time, tokens per model, lines
                written); the last one in a session is that session's total, subagents included.
  calendar      git history of state/application/<app_id>/, the packs it names and its brief
  deploys       every distinct `deployed_at` that infrastructure.json ever held in git, plus mint-log.jsonl
  tests         the lane reports written for this app
  upstream      merged pull requests to the mold's source repository in the app's calendar window (gh, if signed in)
  running app   sum of cost_usd / tokens in the app's own automation_runs table, read per workspace under RLS

Writes reports/mint/<app_id>.md (and .json) and prints the markdown.
"""
import datetime as dt, glob, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts")
GAP = 300   # seconds of silence after which the session is counted as idle, not working

def load(p): return json.load(open(p))
def ts(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def hm(sec): sec = int(sec); return f"{sec // 3600}h {sec % 3600 // 60:02d}m"
def git(*a): return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout

def transcripts_dir():
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", ROOT))

def active_seconds(stamps, gap=GAP):
    """Wall time with the idle stretches taken out: consecutive records closer than `gap` count, longer gaps do not."""
    stamps = sorted(stamps); return sum(min((b - a).total_seconds(), gap) if (b - a).total_seconds() <= gap else 0 for a, b in zip(stamps, stamps[1:]))

def read_session(path, app_id):
    text = open(path, errors="replace").read()
    if app_id not in text: return None
    cost = None; stamps = []; human = 0; turns = 0; tools = 0; after = 0; seen = {}; order = []; cut = 0
    for line in text.splitlines():
        try: d = json.loads(line)
        except ValueError: continue
        if "totalCostUSD" in d: cost = d; after = 0; cut = len(order)
        t = d.get("timestamp")
        if t and not d.get("isSidechain"):
            try: stamps.append(ts(t))
            except ValueError: pass
        m = d.get("message") or {}
        if d.get("type") == "user" and not d.get("isMeta") and not d.get("isCompactSummary") and not d.get("toolUseResult"):
            c = m.get("content"); txt = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text") if isinstance(c, list) else ""
            if txt.strip() and not txt.lstrip().startswith(("<system-reminder>", "<task-notification>", "[SYSTEM", "Another Claude session", "This session is being continued")): human += 1
        u = m.get("usage") if d.get("type") == "assistant" else None
        if u and m.get("id"):
            if m["id"] not in seen: order.append(m["id"])
            seen[m["id"]] = weighted(u)
        if d.get("type") == "assistant" and not d.get("isSidechain"):
            turns += 1; after += 1; tools += sum(1 for x in (m.get("content") or []) if isinstance(x, dict) and x.get("type") == "tool_use")
    sub = glob.glob(os.path.join(path[:-6], "subagents", "*.jsonl"))
    before = sum(seen[i] for i in order[:cut]); later = sum(seen[i] for i in order[cut:])
    est = (cost["totalCostUSD"] * later / before) if cost and before else None
    return dict(session=os.path.basename(path)[:8], first=min(stamps).isoformat() if stamps else None, last=max(stamps).isoformat() if stamps else None,
                active_s=active_seconds(stamps), operator_messages=human, assistant_messages=turns, tool_calls=tools, subagents=len(sub),
                cost_usd=(cost or {}).get("totalCostUSD"), cost_uncounted_est_usd=est, model_s=((cost or {}).get("totalAPIDuration") or 0) / 1000, tool_s=((cost or {}).get("totalToolDuration") or 0) / 1000,
                lines_added=(cost or {}).get("totalLinesAdded"), models={k: dict(cost_usd=v.get("costUSD"), output_tokens=v.get("outputTokens"), input_tokens=(v.get("inputTokens") or 0) + (v.get("cacheReadInputTokens") or 0) + (v.get("cacheCreationInputTokens") or 0)) for k, v in ((cost or {}).get("modelUsage") or {}).items()},
                cost_as_of=None if not cost else f"The cost and working-time counters are as of the session's last cost record; {after} of its {turns} agent messages came after it and are not yet counted, so the true figures are higher; the Money table carries an estimate for that part.")

def weighted(u):
    """Tokens in units of one input token, by the price ratios the model family keeps (cache read 0.1, 1-hour cache
    write 2, 5-minute cache write 1.25, output 5). Used ONLY to scale a measured cost over work the counter has not seen."""
    cc = u.get("cache_creation") or {}; h = cc.get("ephemeral_1h_input_tokens"); f = cc.get("ephemeral_5m_input_tokens")
    write = (2 * (h or 0) + 1.25 * (f or 0)) if (h is not None or f is not None) else 1.25 * (u.get("cache_creation_input_tokens") or 0)
    return (u.get("input_tokens") or 0) + 0.1 * (u.get("cache_read_input_tokens") or 0) + write + 5 * (u.get("output_tokens") or 0)

def calendar(app_id, app):
    paths = [f"state/application/{app_id}", f"briefs/{app_id}.md"] + [f"packs/{p}" for p in app.get("packs") or []]
    log = [l.split("\t") for l in git("log", "--reverse", "--format=%aI\t%s", "--", *paths).splitlines() if l]
    deploys = set()
    for h in git("log", "--format=%H", "--", f"state/application/{app_id}/infrastructure.json").split():
        try: d = json.loads(git("show", f"{h}:state/application/{app_id}/infrastructure.json")).get("deployed_at")
        except ValueError: d = None
        if d: deploys.add(d)
    ml = os.path.join(ROOT, "state", "application", app_id, "mint-log.jsonl")
    stations = [json.loads(l) for l in open(ml)] if os.path.exists(ml) else []
    return dict(first_commit=log[0][0] if log else None, last_commit=log[-1][0] if log else None, commits=len(log),
                deploys=sorted(deploys), stations=stations)

def lanes(app_id, mold_id):
    out = {}
    for lane in ("functional", "context", "load", "accessibility", "responsiveness"):
        rs = sorted(glob.glob(os.path.join(ROOT, "molds", mold_id, "testing", lane, "reports", f"{app_id}-*.md")))
        out[lane] = len(rs)
    return out

def upstream(mold_id, since, until):
    repo = next(((m.get("source") or {}).get("repo", "") for m in load(os.path.join(ROOT, "state", "factory.json"))["molds"] if m["mold_id"] == mold_id), "").replace("github.com/", "")
    if not repo or not since: return None
    r = subprocess.run(["gh", "pr", "list", "-R", repo, "--state", "merged", "--limit", "200", "--json", "number,mergedAt,additions,deletions"], capture_output=True, text=True)
    if r.returncode: return None
    prs = [p for p in json.loads(r.stdout) if since[:10] <= p["mergedAt"][:10] <= until[:10]]
    return dict(repo=repo, merged=len(prs), additions=sum(p["additions"] for p in prs), deletions=sum(p["deletions"] for p in prs), numbers=sorted(p["number"] for p in prs))

def running_app(app_id, infra):
    """Inference the LIVE app has spent so far, from its own table. Read-only, per workspace, under RLS."""
    try:
        sys.path.insert(0, S); import clone
        build = os.path.join(ROOT, "build", app_id)
        url = clone.pull_env(infra["vercel"]["project"], build).get("DATABASE_URL")
        js = ("import pg from 'postgres'; const sql = pg(process.env.DATABASE_URL, {max:1}); const out = [];"
              "for (const o of process.env.ORGS.split(',')) { const r = await sql.begin(async (t) => { await t`select set_config('app.org_id', ${o}, true)`;"
              "return t`select count(*)::int as runs, coalesce(sum(cost_usd),0)::float as cost, coalesce(sum(input_tokens),0)::float as inp, coalesce(sum(output_tokens),0)::float as outp from automation_runs`; }); out.push({org:o, ...r[0]}); }"
              "console.log(JSON.stringify(out)); await sql.end();")
        orgs = [os.path.basename(p)[:-5] for p in glob.glob(os.path.join(ROOT, "state", "application", app_id, "seed", "orgs", "*.json"))]
        if not orgs or not url: return None
        r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=build, env=dict(os.environ, DATABASE_URL=url, ORGS=",".join(orgs)), capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None

def build(app_id, live=True):
    adir = os.path.join(ROOT, "state", "application", app_id)
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    sessions = [s for s in (read_session(p, app_id) for p in sorted(glob.glob(os.path.join(transcripts_dir(), "*.jsonl")))) if s]
    cal = calendar(app_id, app); now = dt.datetime.now(dt.timezone.utc).isoformat()
    return dict(app_id=app_id, generated_at=now, status=app.get("status"), url=(infra.get("vercel") or {}).get("production_url"), packs=app.get("packs") or [],
                sessions=sessions, calendar=cal, lanes=lanes(app_id, app["mold_id"]),
                upstream=upstream(app["mold_id"], cal["first_commit"], now) if live else None,
                running_app=running_app(app_id, infra) if live and infra.get("target") == "vercel" else None)

def markdown(r):
    S_ = r["sessions"]; cost = sum(s["cost_usd"] or 0 for s in S_); model_s = sum(s["model_s"] for s in S_); tool_s = sum(s["tool_s"] for s in S_); act = sum(s["active_s"] for s in S_)
    first = min((s["first"] for s in S_ if s["first"]), default=r["calendar"]["first_commit"]); dep = r["calendar"]["deploys"]
    L = [f"# What it took to mint `{r['app_id']}`", "", f"Generated {r['generated_at'][:16]}Z · status **{r['status']}** · {r['url'] or 'not deployed'} · packs: {', '.join(r['packs']) or 'none'}", "",
         "Every figure is *measured* from a record written when the thing happened, unless the row says otherwise.", "", "## Time", "", "| | |", "|---|---|"]
    if first: L.append(f"| First message about this app | {first[:16]}Z |")
    if dep:
        L.append(f"| First live deploy | {dep[0][:16]}Z — **{hm((ts(dep[0]) - ts(first)).total_seconds())}** of calendar time after the first message |")
        L.append(f"| Deploys so far | {len(dep)} (latest {dep[-1][:16]}Z) |")
    L += [f"| Agent working: model time | {hm(model_s)} |", f"| Agent working: running commands, builds, deploys, tests | {hm(tool_s)} |",
          f"| Session active time (idle gaps over {GAP // 60} min removed) | {hm(act)} |",
          f"| Operator messages | {sum(s['operator_messages'] for s in S_)} |",
          f"| Agent messages / tool calls / subagents | {sum(s['assistant_messages'] for s in S_)} / {sum(s['tool_calls'] for s in S_)} / {sum(s['subagents'] for s in S_)} |",
          f"| Test-lane reports written | {sum(r['lanes'].values())} ({', '.join(f'{k} {v}' for k, v in r['lanes'].items())}) |",
          f"| Commits touching the app, its brief and its packs | {r['calendar']['commits']} |"]
    if r["upstream"]: L.append(f"| Pull requests merged upstream in the same window | {r['upstream']['merged']} (+{r['upstream']['additions']} / −{r['upstream']['deletions']} lines) in {r['upstream']['repo']} |")
    L += ["", "## Money", "", "| Item | Amount | How it is known |", "|---|---|---|",
          f"| Agent (Claude) work | **${cost:,.2f}** | measured: the sessions' own cost counters, at API list prices, subagents included. On a Claude subscription this is the *equivalent value used*, not an invoice. |"]
    est = sum(s.get("cost_uncounted_est_usd") or 0 for s in S_)
    if est: L.append(f"| Agent work the counter has not seen yet | about ${est:,.0f} | **estimated**: the measured cost scaled by the tokens the main session used after its last cost record (subagents since then are not included). Replaced by a measured figure at the next cost record. Total so far: about **${cost + est:,.0f}**. |")
    for s in S_:
        for m, v in sorted(s["models"].items(), key=lambda kv: -(kv[1]["cost_usd"] or 0)):
            L.append(f"| · {m} | ${v['cost_usd'] or 0:,.2f} | {v['input_tokens'] / 1e6:,.1f}M tokens read, {v['output_tokens'] / 1e6:,.2f}M written |")
    ra = r["running_app"]
    if ra is not None: L.append(f"| Inference the live app has spent | ${sum(x['cost'] for x in ra):,.2f} | measured: the app's own run table, {sum(x['runs'] for x in ra)} run(s) across {len(ra)} workspace(s). Runs that recorded no cost count as $0. |")
    else: L.append("| Inference the live app has spent | not measured | the app's run table could not be read from here |")
    L += ["| Hosting (Vercel: three projects, builds, functions) | not measured | vercel.com → the team → Usage. No per-project invoice is readable from this machine. |",
          "| Database and file store (Neon, Vercel Blob) | not measured | the Vercel team's Storage tab; both start on free allowances |",
          "| Model provider account (Cloudflare Workers AI) | not measured | dash.cloudflare.com → AI → Workers AI → usage; the row above is the app's own count of the same spend |",
          "| Email (Resend), web search (Exa) | not measured | each provider's usage page; both keys are shared with the operator's other apps |",
          "", "## Reading it", "",
          "- The agent figure is for **everything done in those sessions**, not only this app's own files: it includes building factory features the next app reuses (packs, the mint line, the per-app package, the domain step) and the upstream pull requests. The next app's report is the marginal cost; this one is the cost of the first.",
          "- Calendar time includes every wait for the operator (keys, decisions, sign-in codes) and overnight gaps. Agent working time does not.",
          f"- {S_[0]['cost_as_of'] if S_ and S_[0]['cost_as_of'] else 'No cost record was found in the sessions.'}"]
    if r["calendar"]["stations"]:
        L += ["", "## Stations (from the mint log)", "", "| station | started | took | result |", "|---|---|---|---|"]
        L += [f"| {e['station']} | {e['start'][:16]}Z | {hm(e['seconds'])} | {'ok' if e['ok'] else 'did not finish'} |" for e in r["calendar"]["stations"]]
    return "\n".join(L) + "\n"

def self_test():
    t = [ts("2026-01-01T00:00:00Z") + dt.timedelta(seconds=s) for s in (0, 60, 120, 5000, 5100)]
    assert active_seconds(t) == 220, active_seconds(t)
    assert weighted({"input_tokens": 10, "cache_read_input_tokens": 100, "output_tokens": 2, "cache_creation": {"ephemeral_1h_input_tokens": 5, "ephemeral_5m_input_tokens": 0}}) == 40
    assert hm(3725) == "1h 02m" and hm(59) == "0h 00m"
    assert ts("2026-09-18T12:04:27.593Z").year == 2026
    print("mint_report: 5 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if not a: sys.exit(__doc__)
    r = build(a[0]); out = os.path.join(ROOT, "reports", "mint"); os.makedirs(out, exist_ok=True)
    json.dump(r, open(os.path.join(out, a[0] + ".json"), "w"), indent=2)
    md = markdown(r); open(os.path.join(out, a[0] + ".md"), "w").write(md)
    print(json.dumps(r, indent=2) if "--json" in a else md); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
