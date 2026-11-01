#!/usr/bin/env python3
"""mint_report.py <app_id> [--json]   |   --all [--json]   |   --live [--json]   |   --self-test          (also: mint.py <app_id> report)

What it took to mint one application: time and money, each figure labelled by how it is known.

  measured      read from a record that was written when the thing happened (the agent sessions' own cost and
                duration counters, git history, lane reports, the running app's usage table)
  apportioned   a measured session figure split across the apps the session names (below); the share is recorded
  estimated     the agent work after a session's last cost record, scaled from the measured part; always kept apart
  not measured  named, with where the operator can see it; never guessed, never shown as 0

Sources
  agent work    ~/.claude/projects/<this repo>/*.jsonl, and each session's subagents/, for every session that names the
                app (its id or its hyphenated form, as a whole word). Each carries `cost-state` records (cost in USD at
                API list prices, model time, tool time, tokens per model, lines written), cumulative per run of the
                program (startTime); a session's figure is the sum over its runs, a run carried over from an earlier
                session counted once.
  calendar      git history of state/application/<app_id>/, the packs it names and its brief
  deploys       every distinct `deployed_at` that infrastructure.json ever held in git (and holds now), plus mint-log.jsonl
  tests         the lane reports written for this app
  upstream      merged pull requests to the mold's source repository in the app's calendar window (gh, if signed in)
  running app   sum of cost_usd / tokens in the app's own automation_runs table, read per workspace under RLS

Apportioning. A session that names only this app counts whole for it (basis "own"). A session that names several
apps is split (basis "apportioned"): it is cut into pieces of work, each from one message to the agent (the
operator's, or a background-task notice) to the next, subagent transcripts included; each piece's tokens are priced at
the per-token price the session's own counter implies for that model, and credited to the apps the piece names, in
proportion to how often it names each. Pieces that name no app are factory work and go to no app. An app's share of
the session is its credited spend over all the spend; that share is applied to the session's cost, model time,
tool time and active time. So the figures of all apps sharing a session add up to at most the session, never more.

--all writes one report per application that is not retired, then prints (with --json) each app's `summary` and
each product's sum over its app_ids (state/products.json). It does not go online.

Writes reports/mint/<app_id>.md (and .json) and prints the markdown.

--live (mold_v0-185) brings the "built" figure up to the minute without the full recompute: the hourly --all report,
with every session whose transcript changed in the last hour read incrementally (only its new lines; a byte offset per
transcript is kept in reports/mint/live-cache.json, at most LIVE_BUDGET_S of reading per call). See live_builds. Writes
reports/mint/live.json. Offline, like --all.
"""
import datetime as dt, glob, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts")
GAP = 300   # seconds of silence after which the session is counted as idle, not working

sys.path.insert(0, os.path.join(S, "lib"))
import lane_url   # target_url(infra): the application's address, per deploy target
from factory_local import mold_source, repo_slug

def load(p): return json.load(open(p))
def ts(s):
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)   # a time written without a zone is UTC
def hm(sec): sec = int(sec); return f"{sec // 3600}h {sec % 3600 // 60:02d}m"
def git(*a): return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout

def transcripts_dir():
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", ROOT))

def active_seconds(stamps, gap=GAP):
    """Wall time with the idle stretches taken out: consecutive records closer than `gap` count, longer gaps do not."""
    stamps = sorted(stamps); return sum(min((b - a).total_seconds(), gap) if (b - a).total_seconds() <= gap else 0 for a, b in zip(stamps, stamps[1:]))

def known_apps():
    """Every application id the factory knows (state/application and products.json), retired ones included: a session
    that names a retired app still shares its work with it, so the live apps are not charged for that part."""
    ids = {n for n in os.listdir(os.path.join(ROOT, "state", "application")) if n != "app_id" and os.path.isdir(os.path.join(ROOT, "state", "application", n))}
    try: ids |= {a for p in load(os.path.join(ROOT, "state", "products.json")).get("products", []) for a in p.get("app_ids") or []}
    except (OSError, ValueError): pass
    return sorted(ids)

def name_pattern(apps):
    """An app is named by its id or its hyphenated form (onfinance-hfc.vercel.app), as a whole word: onfinance_hfc
    inside onfinance_hfc_vm does not count. Returns (regex, alias -> id)."""
    alias = {a: a for a in apps}; alias.update({a.replace("_", "-"): a for a in apps})
    return re.compile(r"(?<![A-Za-z0-9_-])(" + "|".join(re.escape(x) for x in sorted(alias, key=len, reverse=True)) + r")(?![A-Za-z0-9_-])"), alias

def model_key(m): return re.sub(r"\[.*?\]$", "", m or "")

def pieces(lines, rx, alias):
    """Splits one transcript into pieces of work. A piece starts at each message given to the agent (the operator's,
    a queued one, or a background-task notice) and runs to the next. Each piece keeps how often it names each app
    (in the messages and tool calls and results, not in injected context or compaction summaries) and the token
    weight of every agent message in it."""
    out = []; cur = None
    for line in lines:
        try: d = json.loads(line)
        except ValueError: continue
        t = d.get("type"); m = d.get("message") or {}; c = m.get("content")
        is_prompt = (t == "user" and not d.get("isMeta") and not d.get("isCompactSummary") and not d.get("toolUseResult")
                     and not (isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c))) \
            or (t == "attachment" and (d.get("attachment") or {}).get("type") == "queued_command")
        if is_prompt or cur is None:
            cur = dict(names={}, msgs={}, first=d.get("timestamp")); out.append(cur)
        if cur["first"] is None: cur["first"] = d.get("timestamp")
        body = c if t in ("user", "assistant") and not d.get("isCompactSummary") and not d.get("isMeta") else d.get("attachment") if is_prompt else None
        if body:
            for x in rx.findall(body if isinstance(body, str) else json.dumps(body)): a = alias[x]; cur["names"][a] = cur["names"].get(a, 0) + 1
        u = m.get("usage") if t == "assistant" else None
        if u and m.get("id"): cur["msgs"][m["id"]] = (weighted(u), model_key(m.get("model")), d.get("timestamp") or "")
    return out

COUNTERS = ("totalCostUSD", "totalAPIDuration", "totalToolDuration", "totalLinesAdded")
_SCANS = {}

def scan(path, rx, alias):
    """Everything one session transcript holds, read once (for every app at a time).

    Cost counters. Each `cost-state` record is cumulative for one run of the program, named by its startTime; a
    restart begins a new run at zero, and a session continued from another carries that run's counter over. So a
    session's measured cost is the sum, over its runs, of the highest value each run reached (minus what that run had
    already reached in an earlier session file: see `measured`). Taking only the last record would drop every
    earlier run."""
    if (path, rx.pattern) in _SCANS: return _SCANS[(path, rx.pattern)]
    text = open(path, errors="replace").read(); lines = text.splitlines()
    runs = {}; stamps = []; human = 0; turns = 0; tools = 0; after = 0; seen = {}; order = []; cut = 0; cut_ts = ""; last_ts = ""
    for line in lines:
        try: d = json.loads(line)
        except ValueError: continue
        if d.get("timestamp"): last_ts = d["timestamp"]
        if "totalCostUSD" in d:
            k = d.get("startTime") or "?"
            if k not in runs or (d.get("totalCostUSD") or 0) >= (runs[k].get("totalCostUSD") or 0): runs[k] = d
            after = 0; cut = len(order); cut_ts = last_ts
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
    subs = sorted(glob.glob(os.path.join(path[:-6], "subagents", "*.jsonl")))
    main = pieces(lines, rx, alias); sub = [p for f in subs for p in pieces(open(f, errors="replace").read().splitlines(), rx, alias)]
    before_ids = set(order[:cut])
    r = dict(path=path, session=os.path.basename(path)[:8], stamps=stamps, first=min(stamps).isoformat() if stamps else None, last=max(stamps).isoformat() if stamps else None,
             runs=runs, human=human, turns=turns, tools=tools, after=after, subagents=len(subs), cut_ts=cut_ts,
             before=sum(seen[i] for i in order[:cut]), later=sum(seen[i] for i in order[cut:]),
             main=main, sub=sub, before_ids=before_ids, names=sorted({a for p in main + sub for a in p["names"]}))
    _SCANS[(path, rx.pattern)] = r; return r

def measured(sc, all_scans):
    """The session's own counters: per run, its highest value less what the same run had reached in session files
    that started earlier (a continued session carries its parent's counter). Returns (totals, per-model cost/tokens)."""
    tot = dict.fromkeys(COUNTERS, 0.0); models = {}
    for k, rec in sc["runs"].items():
        prior = [o["runs"][k] for o in all_scans if o is not sc and k in o["runs"] and (o["last"] or "") < (sc["last"] or "")]
        base = max(prior, key=lambda x: x.get("totalCostUSD") or 0) if prior else {}
        for f in COUNTERS: tot[f] += max(0.0, (rec.get(f) or 0) - (base.get(f) or 0))
        bm = base.get("modelUsage") or {}
        for name, v in (rec.get("modelUsage") or {}).items():
            b = bm.get(name) or {}; mk = model_key(name); acc = models.setdefault(mk, dict(cost_usd=0.0, output_tokens=0, input_tokens=0, weight=0.0))
            dv = {f: max(0, (v.get(f) or 0) - (b.get(f) or 0)) for f in ("costUSD", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")}
            acc["cost_usd"] += dv["costUSD"]; acc["output_tokens"] += dv["outputTokens"]; acc["input_tokens"] += dv["inputTokens"] + dv["cacheReadInputTokens"] + dv["cacheCreationInputTokens"]
            acc["weight"] += weighted(dict(input_tokens=dv["inputTokens"], cache_read_input_tokens=dv["cacheReadInputTokens"], cache_creation_input_tokens=dv["cacheCreationInputTokens"], output_tokens=dv["outputTokens"]))
    return tot, models

def shares(sc, prices):
    """Each app's share of one session, priced: every agent message's tokens are valued at the price per token the
    session's own counter implies for that message's model, and each piece of work is credited to the apps it names in
    proportion to how often it names each; a piece that names none stays factory work. Two shares: over the work
    the cost counter has seen (main session and subagents up to its last record), and over the main-session work after
    it (which the uncounted estimate covers)."""
    avg = (sum(p[0] for p in prices.values()) / sum(p[1] for p in prices.values())) if prices and sum(p[1] for p in prices.values()) else 1.0
    price = lambda w, m: w * ((prices[m][0] / prices[m][1]) if m in prices and prices[m][1] else avg)
    def split(pcs, keep):
        tot = 0.0; per = {}
        for p in pcs:
            w = sum(price(x[0], x[1]) for i, x in p["msgs"].items() if keep(i, x)); tot += w; n = sum(p["names"].values())
            for a, k in p["names"].items(): per[a] = per.get(a, 0.0) + w * k / n
        return tot, per
    counted = (lambda i, x: i in sc["before_ids"]) if sc["cut_ts"] else (lambda i, x: True)   # no cost record: one share over everything
    tb, pb = split(sc["main"], counted)
    ts_, ps = split(sc["sub"], lambda i, x: not sc["cut_ts"] or x[2] <= sc["cut_ts"]); tb += ts_
    for a, v in ps.items(): pb[a] = pb.get(a, 0.0) + v
    ta, pa = split(sc["main"], lambda i, x: i not in sc["before_ids"])
    return ({a: v / tb for a, v in pb.items()} if tb else {}), ({a: v / ta for a, v in pa.items()} if ta else {})

def read_session(path, app_id, apps=None):
    """One session as it bears on one app: None when it never names the app. `basis` is "own" when the session names
    only this app (all of it is counted), "apportioned" when it names others too (this app's `share` of it is
    counted, see `shares`). The session-wide figures are kept beside the apportioned ones (session_*)."""
    apps = apps or known_apps(); rx, alias = name_pattern(sorted(set(apps) | {app_id}))
    sc = scan(path, rx, alias)
    if app_id not in sc["names"]: return None
    all_scans = [scan(p, rx, alias) for p in sorted(glob.glob(os.path.join(os.path.dirname(path), "*.jsonl")))]
    tot, models = measured(sc, all_scans); has_cost = bool(sc["runs"])
    cost = tot["totalCostUSD"] if has_cost else None
    est = (cost * sc["later"] / sc["before"]) if has_cost and sc["before"] else None
    own = sc["names"] == [app_id]
    if own: share = share_after = 1.0; factory = None
    else:
        sb, sa = shares(sc, {m: (v["cost_usd"], v["weight"]) for m, v in models.items()})
        share = sb.get(app_id, 0.0); share_after = sa.get(app_id, 0.0) if sa else share; factory = max(0.0, 1.0 - sum(sb.values()))
    act = active_seconds(sc["stamps"]); named = [p["first"] for p in sc["main"] + sc["sub"] if app_id in p["names"] and p["first"]]
    sh = lambda v: None if v is None else v * share
    return dict(session=sc["session"], file=os.path.basename(path), run_costs={str(k): rec.get("totalCostUSD") or 0 for k, rec in sc["runs"].items()},
                first=sc["first"], last=sc["last"], first_named=min(named) if named else sc["first"],
                basis="own" if own else "apportioned", share=round(share, 4), share_uncounted=round(share_after, 4),
                factory_share=None if factory is None else round(factory, 4), names=sc["names"],
                active_s=act * share, operator_messages=sc["human"], assistant_messages=sc["turns"], tool_calls=sc["tools"], subagents=sc["subagents"],
                cost_usd=sh(cost), cost_uncounted_est_usd=None if est is None else est * share_after,
                model_s=tot["totalAPIDuration"] / 1000 * share, tool_s=tot["totalToolDuration"] / 1000 * share,
                session_cost_usd=cost, session_cost_uncounted_est_usd=est, session_model_s=tot["totalAPIDuration"] / 1000, session_tool_s=tot["totalToolDuration"] / 1000, session_active_s=act,
                runs=len(sc["runs"]), lines_added=int(tot["totalLinesAdded"]) if has_cost else None,
                models={k: dict(cost_usd=v["cost_usd"] * share, output_tokens=v["output_tokens"], input_tokens=v["input_tokens"]) for k, v in models.items()},
                cost_as_of=None if not has_cost else f"The cost and working-time counters are as of the session's last cost record; {sc['after']} of its {sc['turns']} agent messages came after it and are not yet counted, so the true figures are higher; the Money table carries an estimate for that part.")

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
    try: d = load(os.path.join(ROOT, "state", "application", app_id, "infrastructure.json")).get("deployed_at")   # not yet committed
    except (OSError, ValueError): d = None
    if d: deploys.add(d)
    ml = os.path.join(ROOT, "state", "application", app_id, "mint-log.jsonl")
    stations = [json.loads(l) for l in open(ml)] if os.path.exists(ml) else []
    by = {}   # one deploy per instant: a bare date and its migrated midnight-UTC form are the same deploy
    for d in deploys:
        try: k = ts(d)
        except ValueError: continue
        if len(d) > len(by.get(k, "")): by[k] = d
    return dict(first_commit=log[0][0] if log else None, last_commit=log[-1][0] if log else None, commits=len(log),
                deploys=[by[k] for k in sorted(by)], stations=stations)

def lanes(app_id, mold_id):
    out = {}
    for lane in ("functional", "context", "load", "accessibility", "responsiveness"):
        rs = sorted(glob.glob(os.path.join(ROOT, "molds", mold_id, "testing", lane, "reports", f"{app_id}-*.md")))
        out[lane] = len(rs)
    return out

def upstream(mold_id, since, until):
    # owner/name of the mold's source, from this machine's own state/factory.local.json -> mold_sources (lib/factory_local.py)
    repo = (repo_slug(mold_source(mold_id)) or "").replace("github.com/", "")
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

def build(app_id, live=True, apps=None, tdir=None):
    adir = os.path.join(ROOT, "state", "application", app_id)
    app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    apps = apps or known_apps()
    sessions = [s for s in (read_session(p, app_id, apps) for p in sorted(glob.glob(os.path.join(tdir or transcripts_dir(), "*.jsonl")))) if s]
    cal = calendar(app_id, app); now = dt.datetime.now(dt.timezone.utc).isoformat()
    r = dict(app_id=app_id, generated_at=now, status=app.get("status"), url=lane_url.target_url(infra), target=infra.get("target"), packs=app.get("packs") or [],
             sessions=sessions, calendar=cal, lanes=lanes(app_id, app["mold_id"]),
             upstream=upstream(app["mold_id"], cal["first_commit"], now) if live else None,
             running_app=running_app(app_id, infra) if live and infra.get("target") == "vercel" else None)
    r["summary"] = summary(r); return r

def summary(r):
    """The board's line for one app. Every money figure says how it is known: build_cost_usd is measured (the sessions'
    own counters), `own` when every session that names the app names no other, `apportioned` when a session's cost
    was split across the apps it names (build_cost_shares says how much of which session). The part the counters have
    not seen yet is an estimate, kept apart in build_cost_uncounted_est_usd and never added into build_cost_usd.
    None means not measured, never zero."""
    S_ = r["sessions"]; dep = sorted(r["calendar"]["deploys"], key=ts) if r["calendar"]["deploys"] else []
    costs = [s["cost_usd"] for s in S_ if s["cost_usd"] is not None]; ests = [s["cost_uncounted_est_usd"] for s in S_ if s.get("cost_uncounted_est_usd") is not None]
    first = min((s.get("first_named") or s["first"] for s in S_ if s.get("first_named") or s["first"]), default=None, key=ts)
    gap = (ts(dep[0]) - ts(first)).total_seconds() if dep and first else None
    return dict(build_cost_usd=round(sum(costs), 2) if costs else None,
                build_cost_basis=None if not S_ else "own" if all(s["basis"] == "own" for s in S_) else "apportioned",
                build_cost_uncounted_est_usd=round(sum(ests), 2) if ests else None, build_cost_uncounted_is_estimate=True,
                build_cost_shares=[dict(session=s["session"], basis=s["basis"], share=s["share"], share_uncounted=s["share_uncounted"], factory_share=s.get("factory_share"),
                                        session_cost_usd=None if s.get("session_cost_usd") is None else round(s["session_cost_usd"], 2)) for s in S_],
                agent_model_s=round(sum(s["model_s"] for s in S_)) if S_ else None, agent_tool_s=round(sum(s["tool_s"] for s in S_)) if S_ else None,
                active_s=round(sum(s["active_s"] for s in S_)) if S_ else None,
                first_message=first, first_deploy=dep[0] if dep else None, latest_deploy=dep[-1] if dep else None, deploys=len(dep),
                calendar_to_first_deploy_s=round(gap) if gap is not None and gap >= 0 else None,
                sessions=len(S_))

def product_totals(summaries, products):
    """Each product's sum over its app_ids. Apps without a report (retired, or never stamped here) are listed in
    `not_reported`, not counted as zero. Apportioned shares of one session add up without counting it twice."""
    out = {}
    for p in products:
        got = {a: summaries[a] for a in p.get("app_ids") or [] if a in summaries}
        vals = lambda k: [v[k] for v in got.values() if v.get(k) is not None]
        add = lambda k, nd=2: round(sum(vals(k)), nd) if vals(k) else None
        firsts = vals("first_message"); first_deps = vals("first_deploy"); ldep = vals("latest_deploy")
        f, d = (min(firsts, key=ts) if firsts else None), (min(first_deps, key=ts) if first_deps else None)
        bases = {v["build_cost_basis"] for v in got.values() if v.get("build_cost_basis")}
        out[p["product_id"]] = dict(app_ids=sorted(got), not_reported=[a for a in p.get("app_ids") or [] if a not in got],
                                    build_cost_usd=add("build_cost_usd"), build_cost_basis=None if not bases else "own" if bases == {"own"} else "apportioned",
                                    build_cost_uncounted_est_usd=add("build_cost_uncounted_est_usd"), build_cost_uncounted_is_estimate=True,
                                    agent_model_s=add("agent_model_s", 0), agent_tool_s=add("agent_tool_s", 0), active_s=add("active_s", 0),
                                    first_message=f, first_deploy=d, latest_deploy=max(ldep, key=ts) if ldep else None, deploys=sum(v["deploys"] for v in got.values()),
                                    calendar_to_first_deploy_s=round((ts(d) - ts(f)).total_seconds()) if f and d and ts(d) >= ts(f) else None,
                                    sessions=len({x["session"] for v in got.values() for x in v["build_cost_shares"]}))
    return out

def markdown(r):
    S_ = r["sessions"]; cost = sum(s["cost_usd"] or 0 for s in S_); model_s = sum(s["model_s"] for s in S_); tool_s = sum(s["tool_s"] for s in S_); act = sum(s["active_s"] for s in S_)
    first = min((s.get("first_named") or s["first"] for s in S_ if s.get("first_named") or s["first"]), default=r["calendar"]["first_commit"]); dep = r["calendar"]["deploys"]
    split = [s for s in S_ if s.get("basis") == "apportioned"]
    how = "" if not split else " (this app's share: " + ", ".join(f"{s['share']:.1%} of session {s['session']}" for s in split) + ")"
    L = [f"# What it took to mint `{r['app_id']}`", "", f"Generated {r['generated_at'][:16]}Z · status **{r['status']}** · {r['url'] or 'not deployed'} · packs: {', '.join(r['packs']) or 'none'}", "",
         "Every figure is *measured* from a record written when the thing happened, unless the row says otherwise.", "", "## Time", "", "| | |", "|---|---|"]
    if first: L.append(f"| First message about this app | {first[:16]}Z |")
    if dep:
        gap = (ts(dep[0]) - ts(first)).total_seconds()
        L.append(f"| First live deploy | {dep[0][:16]}Z — " + (f"**{hm(gap)}** of calendar time after the first message |" if gap >= 0 else "before the first message on record (that work is in no session on this machine) |"))
        L.append(f"| Deploys so far | {len(dep)} (latest {dep[-1][:16]}Z) |")
    L += [f"| Agent working: model time | {hm(model_s)}{' (apportioned)' if split else ''} |", f"| Agent working: running commands, builds, deploys, tests | {hm(tool_s)}{' (apportioned)' if split else ''} |",
          f"| Session active time (idle gaps over {GAP // 60} min removed) | {hm(act)}{' (apportioned)' if split else ''} |",
          f"| Operator messages{' (whole sessions, not apportioned)' if split else ''} | {sum(s['operator_messages'] for s in S_)} |",
          f"| Agent messages / tool calls / subagents{' (whole sessions, not apportioned)' if split else ''} | {sum(s['assistant_messages'] for s in S_)} / {sum(s['tool_calls'] for s in S_)} / {sum(s['subagents'] for s in S_)} |",
          f"| Test-lane reports written | {sum(r['lanes'].values())} ({', '.join(f'{k} {v}' for k, v in r['lanes'].items())}) |",
          f"| Commits touching the app, its brief and its packs | {r['calendar']['commits']} |"]
    if r["upstream"]: L.append(f"| Pull requests merged upstream in the same window | {r['upstream']['merged']} (+{r['upstream']['additions']} / −{r['upstream']['deletions']} lines) in {r['upstream']['repo']} |")
    L += ["", "## Money", "", "| Item | Amount | How it is known |", "|---|---|---|",
          f"| Agent (Claude) work | **${cost:,.2f}** | measured: the sessions' own cost counters, at API list prices, subagents included, every run of each session added up. On a Claude subscription this is the *equivalent value used*, not an invoice. " +
          (f"**Apportioned**{how}: a session that also names other apps is split by the share of its priced tokens spent in pieces of work that name this app; work naming no app stays factory work and is charged to no app. |" if split else "Own: every session counted names only this app. |")]
    est = sum(s.get("cost_uncounted_est_usd") or 0 for s in S_)
    if est: L.append(f"| Agent work the counter has not seen yet | about ${est:,.0f} | **estimated**: the measured cost scaled by the tokens the main session used after its last cost record (subagents since then are not included){', then apportioned by the same rule over that later work' if split else ''}. Replaced by a measured figure at the next cost record. Total so far: about **${cost + est:,.0f}**. |")
    for s in split: L.append(f"| · session {s['session']} as a whole | ${s['session_cost_usd'] or 0:,.2f} | names {', '.join(s['names'])}; {s['factory_share']:.1%} of it named no app (factory work) |")
    for s in S_:
        for m, v in sorted(s["models"].items(), key=lambda kv: -(kv[1]["cost_usd"] or 0)):
            L.append(f"| · {m} | ${v['cost_usd'] or 0:,.2f} | {v['input_tokens'] / 1e6:,.1f}M tokens read, {v['output_tokens'] / 1e6:,.2f}M written (whole session{', cost apportioned' if s.get('basis') == 'apportioned' else ''}) |")
    ra = r["running_app"]
    if ra is not None: L.append(f"| Inference the live app has spent | ${sum(x['cost'] for x in ra):,.2f} | measured: the app's own run table, {sum(x['runs'] for x in ra)} run(s) across {len(ra)} workspace(s). Runs that recorded no cost count as $0. |")
    else: L.append("| Inference the live app has spent | not measured | the app's run table could not be read from here |")
    L += hosting_rows(r.get("target"))
    L += [
          "| Model provider account (Cloudflare Workers AI) | not measured | dash.cloudflare.com → AI → Workers AI → usage; the row above is the app's own count of the same spend |",
          "| Email (Resend), web search (Exa) | not measured | each provider's usage page; both keys are shared with the operator's other apps |",
          "", "## Reading it", "",
          ("- The agent figure is this app's **apportioned share** of sessions that also worked on other apps. A piece of work (from one message to the agent until the next) that names this app is credited to it, in proportion to how often it names each app; pieces that name no app are factory work and are not in any app's figure. A piece that names the app can still have built factory features the next app reuses." if split else
           "- The agent figure is for **everything done in those sessions**, not only this app's own files: it includes building factory features the next app reuses (packs, the mint line, the per-app package, the domain step) and the upstream pull requests. The next app's report is the marginal cost; this one is the cost of the first."),
          "- Calendar time includes every wait for the operator (keys, decisions, sign-in codes) and overnight gaps. Agent working time does not.",
          f"- {S_[0]['cost_as_of'] if S_ and S_[0]['cost_as_of'] else 'No cost record was found in the sessions.'}"]
    if r["calendar"]["stations"]:
        L += ["", "## Stations (from the mint log)", "", "| station | started | took | result |", "|---|---|---|---|"]
        L += [f"| {e['station']} | {e['start'][:16]}Z | {hm(e['seconds'])} | {'ok' if e['ok'] else 'did not finish'} |" for e in r["calendar"]["stations"]]
    return "\n".join(L) + "\n"

def hosting_rows(target):
    """The two hosting lines, by deploy target. A server of the application's own has one bill, the server's."""
    if target == "vm_remote":
        return ["| Hosting (the application's own server: the three services, the builds, the sandboxes) | not measured | the server provider's invoice; one fixed monthly price (docs/COST_MODEL.md §7) |",
                "| Database and file store (PostgreSQL and the files, on the same server) | not measured | included in the server's price; nothing is billed separately |"]
    return ["| Hosting (Vercel: three projects, builds, functions) | not measured | vercel.com → the team → Usage. No per-project invoice is readable from this machine. |",
            "| Database and file store (Neon, Vercel Blob) | not measured | the Vercel team's Storage tab; both start on free allowances |"]

def fixture_sessions(d):
    """Three tiny transcripts: s1 names app_a and app_b and has two program runs; s2 names only app_a; s3 continues
    s2's run (its counter carries s2's cost over)."""
    def rec(path, rows): open(os.path.join(d, path), "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
    t = lambda m: f"2026-01-01T{m // 60:02d}:{m % 60:02d}:00Z"
    ask = lambda m, txt: dict(type="user", timestamp=t(m), message=dict(role="user", content=txt))
    say = lambda m, i, out, txt="ok": dict(type="assistant", timestamp=t(m), message=dict(id=i, model="X[1m]", content=[dict(type="text", text=txt)], usage=dict(input_tokens=0, output_tokens=out)))
    cost = lambda m, start, usd, out: dict(type="cost-state", timestamp=t(m), startTime=start, totalCostUSD=usd, totalAPIDuration=usd * 1000, totalToolDuration=0, totalLinesAdded=0,
                                         modelUsage={"X[1m]": dict(costUSD=usd, inputTokens=0, outputTokens=out, cacheReadInputTokens=0, cacheCreationInputTokens=0)})
    rec("s1.jsonl", [ask(0, "work on app_a"), say(1, "m1", 100), ask(2, "now app_b, then app_b again"), say(3, "m2", 100), ask(4, "factory chores, app_ab is not an app"), say(5, "m3", 200),
                     cost(6, 1, 40, 400), ask(7, "back to app_a"), say(8, "m4", 100), cost(9, 2, 10, 100), ask(10, "app_b last"), say(11, "m5", 100)])
    rec("s2.jsonl", [ask(20, "only app_a here"), say(21, "m6", 50), cost(22, 3, 7, 50)])
    rec("s3.jsonl", [ask(30, "more app_a"), say(31, "m7", 50), cost(32, 3, 9, 100)])

def self_test():
    import tempfile
    t = [ts("2026-01-01T00:00:00Z") + dt.timedelta(seconds=s) for s in (0, 60, 120, 5000, 5100)]
    assert active_seconds(t) == 220, active_seconds(t)
    assert weighted({"input_tokens": 10, "cache_read_input_tokens": 100, "output_tokens": 2, "cache_creation": {"ephemeral_1h_input_tokens": 5, "ephemeral_5m_input_tokens": 0}}) == 40
    assert hm(3725) == "1h 02m" and hm(59) == "0h 00m"
    assert ts("2026-09-18T12:04:27.593Z").year == 2026
    assert "Vercel" in hosting_rows("vercel")[0] and hosting_rows(None) == hosting_rows("vercel") and "own server" in hosting_rows("vm_remote")[0] and "Vercel" not in "".join(hosting_rows("vm_remote"))
    assert lane_url.target_url({"target": "vm_remote", "deployed_at": "2026-10-04T00:00:00+00:00", "vm_remote": {"domain": "a.example.com", "production_url": "https://a.example.com"}}) == "https://a.example.com"
    rx, alias = name_pattern(["onfinance_hfc", "onfinance_hfc_vm"])
    assert [alias[x] for x in rx.findall("onfinance_hfc_vm, onfinance-hfc.vercel.app, onfinance_hfc")] == ["onfinance_hfc_vm", "onfinance_hfc", "onfinance_hfc"]
    apps = ["app_a", "app_b", "app_a_vm"]
    with tempfile.TemporaryDirectory() as d:
        fixture_sessions(d); P = lambda n: os.path.join(d, n)
        a1, b1 = read_session(P("s1.jsonl"), "app_a", apps), read_session(P("s1.jsonl"), "app_b", apps)
        # the shared session is split, not counted twice: 40 + 10 over two runs; app_a named in 200 of the 500 counted output tokens, app_b in 100
        assert a1["session_cost_usd"] == 50 and (a1["basis"], b1["basis"]) == ("apportioned", "apportioned"), (a1, b1)
        assert abs(a1["share"] - 0.4) < 1e-9 and abs(b1["share"] - 0.2) < 1e-9 and abs(a1["factory_share"] - 0.4) < 1e-9, (a1["share"], b1["share"])
        assert abs(a1["cost_usd"] - 20) < 1e-9 and abs(b1["cost_usd"] - 10) < 1e-9 and a1["cost_usd"] + b1["cost_usd"] <= a1["session_cost_usd"]
        assert abs(a1["model_s"] - 20) < 1e-9 and abs(b1["model_s"] - 10) < 1e-9
        # the work after the last cost record is an estimate, apportioned over that later work only (it names app_b)
        assert abs(b1["cost_uncounted_est_usd"] - 10) < 1e-9 and a1["cost_uncounted_est_usd"] == 0, (a1["cost_uncounted_est_usd"], b1["cost_uncounted_est_usd"])
        assert read_session(P("s1.jsonl"), "app_a_vm", apps) is None   # app_ab and app_a are not app_a_vm
        a2, a3 = read_session(P("s2.jsonl"), "app_a", apps), read_session(P("s3.jsonl"), "app_a", apps)
        assert a2["basis"] == "own" and a2["share"] == 1 and a2["cost_usd"] == 7 and read_session(P("s2.jsonl"), "app_b", apps) is None
        assert a3["cost_usd"] == 2, a3["cost_usd"]   # s3 continues s2's run: only what it added counts
        cal = dict(deploys=["2026-01-01T02:00:00+00:00", "2026-01-02T00:00:00+00:00"])
        sa, sb = summary(dict(sessions=[a1, a2, a3], calendar=cal)), summary(dict(sessions=[b1], calendar=dict(deploys=[])))
        assert sa["build_cost_usd"] == 29 and sa["build_cost_basis"] == "apportioned" and sa["build_cost_uncounted_est_usd"] == 0 and sa["deploys"] == 2, sa
        assert sa["first_message"] == "2026-01-01T00:00:00Z" and sa["calendar_to_first_deploy_s"] == 7200 and sa["sessions"] == 3
        assert sb["build_cost_usd"] == 10 and sb["build_cost_uncounted_est_usd"] == 10 and sb["first_deploy"] is None and sb["calendar_to_first_deploy_s"] is None
        own = summary(dict(sessions=[a2], calendar=dict(deploys=[]))); assert own["build_cost_basis"] == "own"
        none = summary(dict(sessions=[], calendar=dict(deploys=[]))); assert none["build_cost_usd"] is None and none["agent_model_s"] is None and none["build_cost_basis"] is None
        pt = product_totals({"app_a": sa, "app_b": sb}, [dict(product_id="p", app_ids=["app_a", "app_b", "gone"])])["p"]
        assert pt["build_cost_usd"] == 39 and pt["build_cost_basis"] == "apportioned" and pt["not_reported"] == ["gone"] and pt["sessions"] == 3 and pt["deploys"] == 2, pt
        assert pt["build_cost_usd"] <= 50 + 9   # the sum over apps never exceeds what the sessions cost
    n = live_self_test()
    print(f"mint_report: {22 + n} checks passed"); return 0

# ---------------------------------------------------------------------------------------------------------------------
# --live: the "built" figure within a minute (mold_v0-185)
# ---------------------------------------------------------------------------------------------------------------------
LIVE_WINDOW_S = 3600          # a session is live when its transcript changed within the last hour
LIVE_BUDGET_S = 20            # at most this long reading per call; the next call carries on where this one stopped
LIVE_CACHE = os.path.join(ROOT, "reports", "mint", "live-cache.json")
LIVE_OUT = os.path.join(ROOT, "reports", "mint", "live.json")
KEEP_BEFORE_IDS = 400         # message ids just before the last cost record, so a repeated id is not counted again

def live_read(path, st, rx, alias, budget_s=LIVE_BUDGET_S, clock=None):
    """Reads what a transcript gained since `st` (its byte offset), complete lines only, and keeps per program run the
    highest cost counters (`cost-state` records), the priced token weight of the agent's messages before the last such
    record (`before_w`) and after it (`later`: id -> weight, the estimate's base), and how often each app is named.
    Returns the new state; `done` is False while a long file is still being caught up on (the offset says where)."""
    import time
    clock = clock or time.monotonic
    st = dict(st or {}); st.setdefault("offset", 0); st.setdefault("runs", {}); st.setdefault("before_w", 0.0); st.setdefault("later", {})
    st.setdefault("names", {}); st.setdefault("named_at", {}); st.setdefault("recent_before", []); st.setdefault("cut_ts", ""); st.setdefault("last_ts", "")
    size = os.path.getsize(path)
    if size < st["offset"]: st = live_read(path, {}, rx, alias, budget_s, clock); return st   # rewritten: start over
    start = clock(); done = True
    with open(path, "rb") as f:
        f.seek(st["offset"])
        while True:
            line = f.readline()
            if not line: break
            if not line.endswith(b"\n"): break                 # a line still being written: next time
            st["offset"] += len(line)
            if b'"totalCostUSD"' in line:
                try: d = json.loads(line)
                except ValueError: continue
                k = str(d.get("startTime") or "?"); cur = st["runs"].get(k) or {}
                if (d.get("totalCostUSD") or 0) >= (cur.get("cost") or 0):
                    st["runs"][k] = {"cost": d.get("totalCostUSD") or 0, "model_ms": d.get("totalAPIDuration") or 0, "tool_ms": d.get("totalToolDuration") or 0}
                st["before_w"] += sum(v for v in st["later"].values())
                st["recent_before"] = (st["recent_before"] + list(st["later"]))[-KEEP_BEFORE_IDS:]; st["later"] = {}
                st["cut_ts"] = d.get("timestamp") or st["last_ts"]
            elif b'"assistant"' in line or b'"user"' in line:   # a cheap filter before parsing; the type is checked below
                try: d = json.loads(line)
                except ValueError: continue
                if d.get("timestamp"): st["last_ts"] = d["timestamp"]
                m = d.get("message") or {}
                if not isinstance(m, dict): continue
                if d.get("type") == "assistant" and m.get("usage") and m.get("id") and m["id"] not in st["recent_before"] and not d.get("isSidechain"):
                    st["later"][m["id"]] = weighted(m["usage"])
                if d.get("type") in ("user", "assistant") and not d.get("isMeta") and not d.get("isCompactSummary") and m.get("content"):
                    c = m["content"]
                    for x in rx.findall(c if isinstance(c, str) else json.dumps(c)):
                        a = alias[x]; st["names"][a] = st["names"].get(a, 0) + 1; st["named_at"][a] = st["last_ts"]
            if clock() - start > budget_s: done = st["offset"] >= size; break
    st["size"] = size; st["done"] = done
    return st

def live_builds(apps=None, tdir=None, reports_dir=None, cache_path=None, now=None, budget_s=LIVE_BUDGET_S):
    """Each app's build figure now: its hourly report (reports/mint/<app>.json), with every session that is live (its
    transcript changed in the last hour) brought up to date from the transcript's new lines.
      measured   the session's cost counters as they stand now (per program run, the highest value), less what the
                 hourly report already counted (its run_costs), times the app's share in that report
      estimated  the work after the session's last cost record, priced as the report prices it (the session's cost per
                 token weight), times the app's share of it; and a live session the hourly report does not have yet,
                 split by how often it names each app: all of it ~ est. until the next hourly report measures it
    A report from before run_costs were recorded keeps its figure until the next hourly recompute (live_from says so).
    -> {"generated_at", "apps": {app: {...}}, "active_apps": [...], "catching_up": [...]}"""
    import time
    now = now or time.time(); apps = apps or known_apps(); tdir = tdir or transcripts_dir()
    reports_dir = reports_dir or os.path.join(ROOT, "reports", "mint"); cache_path = cache_path or os.path.join(reports_dir, "live-cache.json")
    rx, alias = name_pattern(apps)
    try: cache = load(cache_path)
    except (OSError, ValueError): cache = {}
    files = cache.get("files") or {}
    live = sorted(p for p in glob.glob(os.path.join(tdir, "*.jsonl")) if now - os.path.getmtime(p) <= LIVE_WINDOW_S)
    t0 = time.monotonic(); behind = []
    for p in live:
        b = os.path.basename(p); st = files.get(b) or {}
        if st.get("size") == os.path.getsize(p) and st.get("done"): continue
        left = max(1.0, budget_s - (time.monotonic() - t0))
        files[b] = live_read(p, st, rx, alias, left)
        if not files[b].get("done"): behind.append(b[:8])
    files = {b: v for b, v in files.items() if os.path.exists(os.path.join(tdir, b))}
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path + ".tmp", "w") as f: json.dump({"files": files}, f)
    os.replace(cache_path + ".tmp", cache_path)
    live_names = {os.path.basename(p) for p in live}
    out, active = {}, set()
    for b in live_names:   # an app is being built when a live session named it within the last hour
        for a, at in ((files.get(b) or {}).get("named_at") or {}).items():
            try:
                if now - ts(at).timestamp() <= LIVE_WINDOW_S: active.add(a)
            except (ValueError, AttributeError): pass
    for app_id in apps:
        try: rep = load(os.path.join(reports_dir, app_id + ".json"))
        except (OSError, ValueError): rep = None
        if rep is None and not any(app_id in (files.get(b) or {}).get("names", {}) for b in live_names): continue
        sm = (rep or {}).get("summary") or {}
        cost = sm.get("build_cost_usd"); est = sm.get("build_cost_uncounted_est_usd") or 0.0
        e = {"cost_usd": cost, "basis": sm.get("build_cost_basis"), "uncounted_est_usd": None, "live_sessions": [], "unreported_sessions": [],
             "report_at": (rep or {}).get("generated_at"), "live_from": None}
        seen = set()
        for s in (rep or {}).get("sessions") or []:
            b = s.get("file") or ""; seen.add(b)
            if b not in live_names: continue
            st = files.get(b) or {}
            if not st.get("done"): e["live_from"] = "catching up on the session's transcript"; continue
            if "run_costs" not in s: e["live_from"] = "the next hourly recompute (this report predates live figures)"; continue
            runs = st.get("runs") or {}
            if not runs and s.get("cost_usd") is None: continue   # no cost record yet, live or hourly: still not measured, never $0
            delta = sum(max(0.0, (v.get("cost") or 0) - (s["run_costs"].get(k) or 0)) for k, v in runs.items())
            whole = (s.get("session_cost_usd") or 0) + delta
            # the report's own split, unrounded where it can be worked back (share and share_uncounted are kept to 4 places)
            share = s["cost_usd"] / s["session_cost_usd"] if s.get("cost_usd") is not None and s.get("session_cost_usd") else (s.get("share") or 0)
            share_after = (s["cost_uncounted_est_usd"] / s["session_cost_uncounted_est_usd"] if s.get("cost_uncounted_est_usd") is not None and s.get("session_cost_uncounted_est_usd")
                           else s.get("share_uncounted") if s.get("share_uncounted") is not None else share)
            later = sum((st.get("later") or {}).values()); before = st.get("before_w") or 0
            s_est = whole * later / before if before else 0.0
            cost = (cost or 0) - (s.get("cost_usd") or 0) + share * whole
            est = est - (s.get("cost_uncounted_est_usd") or 0) + share_after * s_est
            e["live_sessions"].append(s.get("session"))
        for b in live_names - seen:   # a live session the hourly report has not seen: all of it an estimate
            st = files.get(b) or {}; names = st.get("names") or {}
            if not st.get("done") or not names.get(app_id): continue
            if set(names) != {app_id}:
                # it names other apps too: its split needs the hourly report's pieces of work (a name count would
                # charge the factory's own work to the apps), so it is counted there, not guessed here
                e["live_from"] = "the next hourly recompute (a new session that also names other apps)"; e["unreported_sessions"].append(b[:8]); continue
            whole = sum((v.get("cost") or 0) for v in (st.get("runs") or {}).values())
            later = sum((st.get("later") or {}).values()); before = st.get("before_w") or 0
            whole += whole * later / before if before else 0.0
            est += whole
            e["unreported_sessions"].append(b[:8])
            if e["basis"] is None: e["basis"] = "own"
        e["cost_usd"] = None if cost is None else round(cost, 2)
        e["uncounted_est_usd"] = round(est, 2) if est else None
        out[app_id] = e
    res = {"generated_at": dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="seconds"), "apps": out,
           "active_apps": sorted(active), "catching_up": behind}
    with open(os.path.join(reports_dir, "live.json.tmp"), "w") as f: json.dump(res, f, indent=2)
    os.replace(os.path.join(reports_dir, "live.json.tmp"), os.path.join(reports_dir, "live.json"))
    return res

def live_self_test():
    """--live against the fixture sessions: a counter that moves after the hourly report moves the figure; the work
    after it stays an estimate; a session the report has not seen is all estimate; a long file is read in steps."""
    import tempfile, time
    apps = ["app_a", "app_b", "app_a_vm"]
    with tempfile.TemporaryDirectory() as d:
        tdir = os.path.join(d, "t"); rdir = os.path.join(d, "r"); os.makedirs(tdir); os.makedirs(rdir)
        fixture_sessions(tdir); P = lambda n: os.path.join(tdir, n)
        a1, a2, a3 = (read_session(P(n), "app_a", apps) for n in ("s1.jsonl", "s2.jsonl", "s3.jsonl"))
        assert a1["file"] == "s1.jsonl" and a1["run_costs"] == {"1": 40, "2": 10}, a1["run_costs"]
        rep = dict(app_id="app_a", generated_at="2026-01-01T01:00:00+00:00", sessions=[a1, a2, a3], summary=summary(dict(sessions=[a1, a2, a3], calendar=dict(deploys=[]))))
        json.dump(rep, open(os.path.join(rdir, "app_a.json"), "w"))
        old = time.time() - 2 * LIVE_WINDOW_S
        for n in ("s1.jsonl", "s2.jsonl", "s3.jsonl"): os.utime(P(n), (old, old))
        r0 = live_builds(apps, tdir, rdir)
        assert r0["apps"]["app_a"]["cost_usd"] == 29 and r0["apps"]["app_a"]["live_sessions"] == [] and r0["active_apps"] == [], r0
        # s2 goes on: its run 3 reaches $12 (it was $7 in the report) and 50 more output tokens come after that record
        with open(P("s2.jsonl"), "a") as f:
            f.write(json.dumps(dict(type="user", timestamp="2026-01-01T00:40:00Z", message=dict(role="user", content="app_a again"))) + "\n")
            f.write(json.dumps(dict(type="cost-state", timestamp="2026-01-01T00:41:00Z", startTime=3, totalCostUSD=12, totalAPIDuration=12000, totalToolDuration=0)) + "\n")
            f.write(json.dumps(dict(type="assistant", timestamp="2026-01-01T00:42:00Z", message=dict(id="m9", model="X[1m]", content=[dict(type="text", text="ok")], usage=dict(input_tokens=0, output_tokens=50)))) + "\n")
            f.write('{"type":"assistant","partial')                       # a line still being written is left for later
        r1 = live_builds(apps, tdir, rdir)["apps"]["app_a"]
        # measured: 29 + (12 - 7) = 34; estimated: s2's 50 tokens after its record, at its 12 per 100 weighted tokens... priced by the session's own rate
        assert r1["cost_usd"] == 34 and r1["live_sessions"] == [a2["session"]] and r1["uncounted_est_usd"] is not None and r1["uncounted_est_usd"] > 0, r1
        # a new session the report has not seen that names only app_a: all of it ~ est. for app_a
        stamp = dt.datetime.now(dt.timezone.utc).isoformat()
        with open(P("s4.jsonl"), "w") as f:
            f.write(json.dumps(dict(type="user", timestamp=stamp, message=dict(role="user", content="app_a only"))) + "\n")
            f.write(json.dumps(dict(type="cost-state", timestamp=stamp, startTime=9, totalCostUSD=8, totalAPIDuration=1, totalToolDuration=0)) + "\n")
        r2 = live_builds(apps, tdir, rdir)
        assert r2["apps"]["app_a"]["cost_usd"] == 34 and abs(r2["apps"]["app_a"]["uncounted_est_usd"] - (r1["uncounted_est_usd"] + 8)) < 0.011 and r2["apps"]["app_a"]["unreported_sessions"] == ["s4.jsonl"[:8]], r2
        assert r2["active_apps"] == ["app_a"], r2["active_apps"]   # named just now; s2's mention is from 2026-01-01, long ago
        # one that also names app_b: not split by a name count (that would charge factory work to the apps), said
        with open(P("s5.jsonl"), "w") as f:
            f.write(json.dumps(dict(type="user", timestamp=stamp, message=dict(role="user", content="app_a and app_b"))) + "\n")
            f.write(json.dumps(dict(type="cost-state", timestamp=stamp, startTime=10, totalCostUSD=100, totalAPIDuration=1, totalToolDuration=0)) + "\n")
        r2b = live_builds(apps, tdir, rdir)["apps"]
        assert r2b["app_a"]["uncounted_est_usd"] == r2["apps"]["app_a"]["uncounted_est_usd"] and "hourly" in r2b["app_a"]["live_from"] and r2b["app_b"]["cost_usd"] is None and r2b["app_b"]["uncounted_est_usd"] is None, r2b
        # a live session with no cost record anywhere stays not measured (never $0)
        with open(P("s6.jsonl"), "w") as f:
            f.write(json.dumps(dict(type="user", timestamp=stamp, message=dict(role="user", content="app_a_vm only"))) + "\n")
        s6 = read_session(P("s6.jsonl"), "app_a_vm", apps)
        json.dump(dict(app_id="app_a_vm", sessions=[s6], summary=summary(dict(sessions=[s6], calendar=dict(deploys=[])))), open(os.path.join(rdir, "app_a_vm.json"), "w"))
        r6 = live_builds(apps, tdir, rdir)["apps"]["app_a_vm"]
        assert r6["cost_usd"] is None and r6["uncounted_est_usd"] is None and r6["live_sessions"] == [], r6
        # a report from before run_costs: its figure stands, and says when it goes live
        for s in rep["sessions"]: s.pop("run_costs")
        json.dump(rep, open(os.path.join(rdir, "app_a.json"), "w"))
        r3 = live_builds(apps, tdir, rdir)["apps"]["app_a"]
        assert r3["cost_usd"] == 29 and "hourly" in (r3["live_from"] or ""), r3
        # read in steps: a clock that runs out after every line still gets there, line by line, across calls
        ticks = iter(range(10 ** 6))
        st = {}
        rx, alias = name_pattern(apps)
        for _ in range(20):
            st = live_read(P("s1.jsonl"), st, rx, alias, budget_s=0.5, clock=lambda: next(ticks))
            if st["done"]: break
        full = live_read(P("s1.jsonl"), {}, rx, alias)
        assert st["done"] and st["runs"] == full["runs"] and st["offset"] == full["offset"] and st["names"] == full["names"], (st, full)
    return 6

def all_reports(as_json):
    """--all: one report per application that is not retired, each written to reports/mint/<app>.json and .md as a
    single report is, then each product's sum. Offline: the upstream and running-app sections of an earlier
    report are kept (with when they were read), not refreshed."""
    apps = known_apps(); out_dir = os.path.join(ROOT, "reports", "mint"); os.makedirs(out_dir, exist_ok=True)
    summaries = {}; errors = {}
    for app_id in sorted(n for n in os.listdir(os.path.join(ROOT, "state", "application")) if os.path.exists(os.path.join(ROOT, "state", "application", n, "application.json"))):
        if load(os.path.join(ROOT, "state", "application", app_id, "application.json")).get("status") == "retired": continue
        try:
            r = build(app_id, live=False, apps=apps); path = os.path.join(out_dir, app_id + ".json")
            old = load(path) if os.path.exists(path) else {}
            for k in ("upstream", "running_app"):
                if r[k] is None and old.get(k) is not None: r[k] = old[k]; r[k + "_as_of"] = old.get(k + "_as_of") or old.get("generated_at")
            json.dump(r, open(path, "w"), indent=2); open(os.path.join(out_dir, app_id + ".md"), "w").write(markdown(r))
            summaries[app_id] = r["summary"]
        except Exception as e:   # one app's broken state must not stop the others
            errors[app_id] = f"{type(e).__name__}: {e}"
    products = product_totals(summaries, load(os.path.join(ROOT, "state", "products.json")).get("products", []))
    res = dict(generated_at=dt.datetime.now(dt.timezone.utc).isoformat(), apps=summaries, products=products, errors=errors)
    if as_json: print(json.dumps(res, indent=2))
    else:
        money = lambda v: "not measured" if v is None else f"${v:,.2f}"
        for k, v in list(summaries.items()) + [(f"product {k}", v) for k, v in products.items()]:
            dur = lambda x: "not measured" if x is None else hm(x); est = v["build_cost_uncounted_est_usd"]
            print(f"{k}: built {money(v['build_cost_usd'])}" + (f" ({v['build_cost_basis']})" if v["build_cost_basis"] else "") + (f" + about {money(est)} estimated, not yet counted" if est else "") +
                  f" · agent {dur(v['agent_model_s'])} · active {dur(v['active_s'])} · {v['deploys']} deploys")
        for k, e in errors.items(): print(f"{k}: {e}", file=sys.stderr)
    return 1 if errors else 0

def main(a):
    if "--self-test" in a: return self_test()
    if "--live" in a:
        r = live_builds()
        if "--json" in a: print(json.dumps(r, indent=2)); return 0
        money = lambda v: "not measured" if v is None else f"${v:,.2f}"
        for k, v in sorted(r["apps"].items()):
            print(f"{k}: built {money(v['cost_usd'])}" + (f" + ~{money(v['uncounted_est_usd'])} est." if v["uncounted_est_usd"] else "") +
                  (f" · live sessions {', '.join(v['live_sessions'] + v['unreported_sessions'])}" if v["live_sessions"] or v["unreported_sessions"] else "") +
                  (f" · live from {v['live_from']}" if v["live_from"] else ""))
        if r["catching_up"]: print("still reading: " + ", ".join(r["catching_up"]) + " (the next call carries on)")
        return 0
    if "--all" in a: return all_reports("--json" in a)
    if not a: sys.exit(__doc__)
    r = build(a[0]); out = os.path.join(ROOT, "reports", "mint"); os.makedirs(out, exist_ok=True)
    json.dump(r, open(os.path.join(out, a[0] + ".json"), "w"), indent=2)
    md = markdown(r); open(os.path.join(out, a[0] + ".md"), "w").write(md)
    print(json.dumps(r, indent=2) if "--json" in a else md); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
