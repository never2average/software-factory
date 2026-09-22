#!/usr/bin/env python3
"""mint_handoff.py <app_id>          (also: mint.py <app_id> handoff)

One page that lets someone who was not here carry an application forward: a go-to-market agent, a teammate, a new
session. Built from state, never from memory, so it can be regenerated at any time:

  what the product is and who it is for · where it lives and what state it is in (the ten mint stations) ·
  what is inside it (specialists, its own record fields, workspaces by size) · how a person or an agent gets in ·
  what was measured (tests, time, money) · what is still open and who it waits on · the rules of the road

Writes reports/mint/<app_id>.handoff.html — the page content for an Artifact (no doctype/head/body of its own) —
and embeds the same facts as JSON in <script type="application/json" id="handoff-data"> for an agent to read.

NEVER in the page: a credential, a person's email address, a customer's material, a pack's rulebook. Workspaces are
given by name and size only. It is checked before writing; a hit refuses the page.
"""
import datetime as dt, glob, html, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = os.path.join(ROOT, ".claude", "scripts"); sys.path.insert(0, S)
import mint, mint_report

def load(p): return json.load(open(p))
E = html.escape
FORBIDDEN = [re.compile(p) for p in (r"[A-Za-z0-9._%+-]+@(?!company\.com|example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}(?![\w/-])", r"\b(sk|re|npm|ghp|gho)_[A-Za-z0-9]{16,}", r"GOCSPX-", r"postgres(ql)?://", r"eyJ[A-Za-z0-9_-]{20,}\.")]

def facts(app_id):
    adir = os.path.join(ROOT, "state", "application", app_id); app = load(os.path.join(adir, "application.json")); infra = load(os.path.join(adir, "infrastructure.json"))
    prod = next((p for p in load(os.path.join(ROOT, "state", "products.json"))["products"] if p["product_id"] == app.get("product_id")), {})
    brand = (app.get("surface") or {}).get("branding") or {}
    packs = []
    for pid in app.get("packs") or []:
        m = load(os.path.join(ROOT, "packs", pid, "pack.json")); subs = []
        for k in m.get("subagents", []):
            sj = os.path.join(ROOT, "packs", pid, "files", "agent", "subagents", k, "subagent.json"); d = load(sj) if os.path.exists(sj) else {}
            skills = len(glob.glob(os.path.join(os.path.dirname(sj), "skills", "*", "SKILL.md")))
            subs.append(dict(key=k, name=d.get("name", k), summary=d.get("summary", ""), skills=skills))
        prof = {}
        for pf in sorted(glob.glob(os.path.join(ROOT, "packs", pid, "files", "profiles", "*.json"))): prof = load(pf)
        areas = []
        for a, d in (prof.get("domains") or {}).items():
            shown = (d.get("group_label") or {}).get("plural") if d.get("group_by") else (d.get("label") or {}).get("plural")
            areas.append(dict(area=a, shown_as=shown, description=d.get("description", ""), kinds=d.get("kinds") or [], own_fields=[dict(label=f["label"], type=f["type"], options=f.get("options")) for f in d.get("custom_fields") or []]))
        packs.append(dict(pack_id=pid, name=m.get("name"), description=m.get("description"), specialists=subs, record_areas=areas, vocabulary=prof.get("vocabulary")))
    spaces = []
    for s in mint.seeds(app_id):
        d = load(s); c = s[:-5] + "/customers.json"
        spaces.append(dict(name=d.get("name"), people=len(d.get("members") or []) + (1 if d.get("owner") else 0), accounts=len(load(c).get("customers", [])) if os.path.exists(c) else 0))
    stations = [dict(station=n, status=st, note=why) for n, st, why in mint.survey(app_id)]
    rp = os.path.join(ROOT, "reports", "mint", app_id + ".json"); rep = load(rp) if os.path.exists(rp) else mint_report.build(app_id, live=False)
    ses = rep.get("sessions") or []; dep = (rep.get("calendar") or {}).get("deploys") or []; first = min((s["first"] for s in ses if s.get("first")), default=None)
    took = dict(first_message=first, first_deploy=dep[0] if dep else None, deploys=len(dep), model_hours=round(sum(s["model_s"] for s in ses) / 3600, 1), tool_hours=round(sum(s["tool_s"] for s in ses) / 3600, 1),
                operator_messages=sum(s["operator_messages"] for s in ses), agent_cost_usd_measured=round(sum(s["cost_usd"] or 0 for s in ses), 2),
                agent_cost_usd_estimated_since=round(sum(s.get("cost_uncounted_est_usd") or 0 for s in ses)), upstream_prs=(rep.get("upstream") or {}).get("merged"), lane_reports=sum((rep.get("lanes") or {}).values()))
    tasks = []
    tf = os.path.join(ROOT, "state", "tasks", app["mold_id"] + ".jsonl")
    for l in open(tf) if os.path.exists(tf) else []:
        t = json.loads(l)
        if t.get("status") == "todo": tasks.append(dict(id=t["task_id"], priority=t.get("priority", 9), title=t["title"]))
    tasks.sort(key=lambda t: (t["priority"], t["id"]))
    # What changed lately, with the evidence that closed it. A handoff that lists only what is LEFT reads as if
    # nothing has happened, and the next agent re-opens a question that was answered yesterday.
    done = []
    for l in open(tf) if os.path.exists(tf) else []:
        t = json.loads(l)
        if t.get("status") == "done" and t.get("evidence"):
            done.append(dict(id=t["task_id"], at=t.get("updated") or "", title=t["title"], evidence=t["evidence"][-1]))
    done = sorted(done, key=lambda t: t["at"])[-6:][::-1]
    url = (infra.get("vercel") or {}).get("production_url"); cli = infra.get("agent_cli") or {}
    testing = {k: v.get("status") for k, v in (app.get("testing") or {}).items()}
    return dict(app_id=app_id, generated_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), product=dict(name=brand.get("product_name") or prod.get("name") or app_id, tagline=brand.get("tagline") or prod.get("tagline") or "", color=brand.get("brand_color")),
                status=app.get("status"), url=url, mold=dict(id=app["mold_id"], commit=(app.get("mold_commit") or "")[:7]), capabilities=dict(web_search=(infra.get("runtime_env") or {}).get("ENABLE_WEB_SEARCH"), browser=(infra.get("runtime_env") or {}).get("ENABLE_BROWSER")),
                models=(app.get("model") or {}).get("roles"), stations=stations, packs=packs, workspaces=spaces, testing=testing, took=took,
                access=dict(people=f"{url} — sign in with a six-digit code emailed to you, or Continue with Google where the workspace uses it. Access is by workspace membership: the owner invites people from Workspace → People." if url else None,
                            agents_hosted=f"{url}/api/mcp" if url else None, agents_package=cli.get("package"), package_published=bool((cli.get("published") or {}).get("version")), custom_domain=(infra.get("vercel") or {}).get("custom_domain")),
                open_tasks=tasks, recent=done, repo=dict(state=f"state/application/{app_id}/", packs=[f"packs/{p}/" for p in app.get("packs") or []], brief=f"briefs/{app_id}.md", report=f"reports/mint/{app_id}.md"))

MARK = {"done": ("ok", "Done"), "not needed": ("na", "Not needed"), "next": ("go", "Next"), "needs you": ("ask", "Needs the operator"), "failed": ("bad", "Failed"), "later": ("wait", "Later")}

def page(f):
    p = f["product"]; t = f["took"]; a = f["access"]
    st = "".join(f'<li class="st {MARK[s["status"]][0]}"><span class="st-n">{E(s["station"])}</span><span class="st-s">{MARK[s["status"]][1]}</span></li>' for s in f["stations"])
    waiting = [s for s in f["stations"] if s["status"] in ("needs you", "next", "failed")]
    wait_html = "".join(f'<li><b>{E(s["station"])}</b> <span class="pill {MARK[s["status"]][0]}">{MARK[s["status"]][1]}</span><br>{E(s["note"])}</li>' for s in waiting) or "<li>Nothing: every station is finished.</li>"
    packs = ""
    for k in f["packs"]:
        subs = "".join(f'<tr><td><b>{E(s["name"])}</b></td><td>{E(s["summary"])}</td><td class="num">{s["skills"]}</td></tr>' for s in k["specialists"])
        areas = ""
        for ar in k["record_areas"]:
            fields = "".join(f'<li><b>{E(x["label"])}</b> <span class="muted">{E(x["type"].replace("_", " "))}{(": " + E(" · ".join(x["options"]))) if x.get("options") else ""}</span></li>' for x in ar["own_fields"])
            kinds = ("<p class='muted'>Types: " + E(" · ".join(x if isinstance(x, str) else x.get("label", "") for x in ar["kinds"])) + "</p>") if ar["kinds"] else ""
            areas += f'<div class="area"><h4>{E(ar["shown_as"] or ar["area"])}</h4><p>{E(ar["description"])}</p>{kinds}<ul class="fields">{fields}</ul></div>'
        packs += f'<h3>Specialists <span class="muted">from the pack “{E(k["pack_id"])}”</span></h3><div class="scroll"><table><thead><tr><th>Specialist</th><th>What it does</th><th class="num">Skills</th></tr></thead><tbody>{subs}</tbody></table></div><h3>Its own records</h3><div class="areas">{areas}</div>'
    spaces = "".join(f'<tr><td><b>{E(w["name"] or "")}</b></td><td class="num">{w["people"]}</td><td class="num">{w["accounts"]}</td></tr>' for w in f["workspaces"])
    tests = "".join(f'<li><span class="pill {"ok" if v == "pass" else "wait" if v == "skipped" else "bad"}">{E(v)}</span> {E(k)}</li>' for k, v in sorted(f["testing"].items()))
    recent = "".join(f'<details><summary>{E(x["title"][:110])}{"…" if len(x["title"]) > 110 else ""} <span class="muted">— {E(x["id"])}, {E(x["at"])}</span></summary><p>{E(x["evidence"])}</p></details>' for x in f["recent"])
    tasks = "".join(f'<tr><td class="mono">{E(x["id"])}</td><td class="num">P{x["priority"]}</td><td>{E(x["title"])}</td></tr>' for x in f["open_tasks"][:14])
    money = f'${t["agent_cost_usd_measured"]:,.0f} measured' + (f' + about ${t["agent_cost_usd_estimated_since"]:,} estimated since the last cost record' if t["agent_cost_usd_estimated_since"] else "")
    cal = ""
    if t["first_message"] and t["first_deploy"]:
        d = dt.datetime.fromisoformat(t["first_deploy"]) - dt.datetime.fromisoformat(t["first_message"]); cal = f"{int(d.total_seconds() // 3600)}h {int(d.total_seconds() % 3600 // 60):02d}m"
    data = json.dumps(f, indent=1).replace("</", "<\\/")
    return f"""<title>{E(p["name"])} Handoff</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..112,500..700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{{--ground:#F5F7F8;--panel:#FFFFFF;--ink:#1D2328;--muted:#5B6873;--line:#D9DFE4;--accent:#0B6E69;--ok:#1E7A46;--ask:#A8590A;--bad:#B3261E;--wait:#6B7782;--okbg:#E3F3EA;--askbg:#FBEBD9;--badbg:#FADFDD;--waitbg:#E9EDF0}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--ground:#12161A;--panel:#1A2026;--ink:#E7EBEE;--muted:#9AA7B2;--line:#2C353D;--accent:#4FC4BC;--ok:#6FD49A;--ask:#F0A95B;--bad:#F2847C;--wait:#9AA7B2;--okbg:#173626;--askbg:#3B2A14;--badbg:#421E1B;--waitbg:#232B32}}}}
:root[data-theme="dark"]{{--ground:#12161A;--panel:#1A2026;--ink:#E7EBEE;--muted:#9AA7B2;--line:#2C353D;--accent:#4FC4BC;--ok:#6FD49A;--ask:#F0A95B;--bad:#F2847C;--wait:#9AA7B2;--okbg:#173626;--askbg:#3B2A14;--badbg:#421E1B;--waitbg:#232B32}}
body{{background:var(--ground);color:var(--ink);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif;padding-inline:clamp(16px,4vw,40px);padding-block:28px 56px}}
.wrap{{max-width:980px;margin-inline:auto;display:flex;flex-direction:column;gap:28px}}
h1,h2,h3,h4{{font-family:"Archivo","IBM Plex Sans",sans-serif;font-stretch:108%;text-wrap:balance;margin:0;line-height:1.2}}
h1{{font-size:clamp(26px,5vw,38px);font-weight:700}} h2{{font-size:20px;font-weight:650;padding-bottom:8px;border-bottom:1px solid var(--line)}} h3{{font-size:15px;font-weight:650;margin-top:6px}} h4{{font-size:14px;font-weight:650}}
p{{margin:0;max-width:68ch}} .muted{{color:var(--muted);font-weight:400}} .mono,code{{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px}}
a{{color:var(--accent)}} a:focus-visible{{outline:2px solid var(--accent);outline-offset:2px}}
header{{display:flex;flex-direction:column;gap:8px}} .eyebrow{{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}}
.meta{{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:13px}}
section{{display:flex;flex-direction:column;gap:14px}}
.rail{{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:6px}}
.st{{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--wait);padding:8px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}}
.st-n{{font-weight:600;font-size:13px}} .st-s{{font-size:12px;color:var(--muted)}}
.st.ok{{border-top-color:var(--ok)}} .st.go{{border-top-color:var(--accent)}} .st.ask{{border-top-color:var(--ask)}} .st.bad{{border-top-color:var(--bad)}} .st.na{{border-top-style:dashed}}
.pill{{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--waitbg);color:var(--wait);font-weight:500}}
.pill.ok{{background:var(--okbg);color:var(--ok)}} .pill.ask,.pill.go{{background:var(--askbg);color:var(--ask)}} .pill.bad{{background:var(--badbg);color:var(--bad)}}
ul.plain{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}} ul.plain li{{background:var(--panel);border:1px solid var(--line);padding:10px 14px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}}
.card{{background:var(--panel);border:1px solid var(--line);padding:14px 16px;display:flex;flex-direction:column;gap:8px;min-width:0}} .card code{{overflow-wrap:anywhere}}
.scroll{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line)}} th,td{{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}} th{{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:500}} .num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.areas{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}} .area{{background:var(--panel);border:1px solid var(--line);padding:14px 16px;display:flex;flex-direction:column;gap:8px}} ul.fields{{margin:0;padding-left:18px}} .tests{{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px 18px}}
.figs{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}} .fig{{background:var(--panel);padding:12px 14px}} .fig b{{display:block;font:650 20px/1.2 "Archivo",sans-serif;font-variant-numeric:tabular-nums}} .fig span{{font-size:12px;color:var(--muted)}}
ol.rules{{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;max-width:72ch}}
details{{background:var(--panel);border:1px solid var(--line);padding:10px 14px}} summary{{cursor:pointer;font-weight:600}} pre{{overflow-x:auto;margin:10px 0 0;font:12px/1.5 "IBM Plex Mono",monospace}}
</style>
<div class="wrap">
<header><span class="eyebrow">Handoff · for the next person or agent</span><h1>{E(p["name"])}</h1><p>{E(p["tagline"])}</p>
<div class="meta"><span>Status <b>{E(f["status"] or "")}</b></span><span>{f'<a href="{E(f["url"])}">{E(f["url"])}</a>' if f["url"] else "not deployed yet"}</span><span>built from {E(f["mold"]["id"])} @ <span class="mono">{E(f["mold"]["commit"])}</span></span><span>as of {E(f["generated_at"])}</span></div></header>

<section><h2>Where it stands</h2><ul class="rail">{st}</ul><h3>What it is waiting on</h3><ul class="plain">{wait_html}</ul></section>

<section><h2>What is inside</h2><p>Web search is <b>{"on" if f["capabilities"]["web_search"] == "true" else "off"}</b>, browser use is <b>{"on" if f["capabilities"]["browser"] == "true" else "off"}</b>.{(" The main agent runs on <span class='mono'>" + E(f["models"].get("orchestrator", "")) + "</span> (it reads images); specialists run on <span class='mono'>" + E(f["models"].get("specialist", "")) + "</span>.") if f["models"] else ""}</p>{packs}
<h3>Workspaces</h3><div class="scroll"><table><thead><tr><th>Workspace</th><th class="num">People</th><th class="num">Accounts</th></tr></thead><tbody>{spaces or '<tr><td colspan="3" class="muted">Only the one the application was stamped with.</td></tr>'}</tbody></table></div><p class="muted">People are listed by count only; names and addresses stay in the workspace.</p></section>

<section><h2>How to get in</h2><div class="grid">
<div class="card"><h4>A person</h4><p>{E(a["people"] or "After the first deploy.")}</p></div>
<div class="card"><h4>An agent, hosted</h4><p>Any MCP-capable assistant connects to <code>{E(a["agents_hosted"] or "—")}</code> with the person's own access token as a Bearer header. The token comes from the same emailed code and lasts 7 days; it proves an email address, and access still follows workspace membership.</p></div>
<div class="card"><h4>An agent, by package</h4><p><code>{E(a["agents_package"] or "—")}</code> — {"published" if a["package_published"] else "built and checked, <b>not published yet</b> (waits on the operator's npm sign-in)"}. <code>npx {E(a["agents_package"] or "")} login --email you@company.com</code>, then <code>… mcp</code>.</p></div>
<div class="card"><h4>Address</h4><p>{("Own domain: <code>" + E(a["custom_domain"]) + "</code>") if a["custom_domain"] else "Lives at its Vercel address. No own domain is named yet; choose one before the package is first published, because the address is baked into it."}</p></div></div></section>

<section><h2>What was measured</h2><ul class="tests">{tests}</ul>
<div class="figs"><div class="fig"><b>{cal or "—"}</b><span>first message to first live deploy</span></div><div class="fig"><b>{t["deploys"]}</b><span>deploys</span></div><div class="fig"><b>{t["model_hours"]}h + {t["tool_hours"]}h</b><span>agent model time + tool time</span></div><div class="fig"><b>{t["operator_messages"]}</b><span>operator messages</span></div><div class="fig"><b>{t["upstream_prs"] if t["upstream_prs"] is not None else "—"}</b><span>pull requests merged upstream</span></div><div class="fig"><b>{t["lane_reports"]}</b><span>test-lane reports</span></div></div>
<p>Agent cost: <b>{money}</b>, at API list prices (on a subscription this is value used, not an invoice). It covers the whole first build, including factory features the next application reuses. Hosting, database, model-provider, email and search bills are not readable from the factory; the full report says where each is seen: <code>{E(f["repo"]["report"])}</code>.</p></section>

<section><h2>Recently finished</h2><p class="muted">Newest first, each with the evidence that closed it — so nobody re-opens a question answered last week.</p>{recent}</section>

<section><h2>Open work</h2><div class="scroll"><table><thead><tr><th>Task</th><th class="num">Priority</th><th>What</th></tr></thead><tbody>{tasks or '<tr><td colspan="3">None.</td></tr>'}</tbody></table></div><p class="muted">From <code>state/tasks/{E(f["mold"]["id"])}.jsonl</code>; <code>python3 .claude/scripts/factory.py next {E(f["mold"]["id"])}</code> gives the current one.</p></section>

<section><h2>Rules of the road</h2><ol class="rules">
<li>Start from <code>python3 .claude/scripts/mint.py {E(f["app_id"])}</code>. It shows every station and the one next step; <code>run</code> does whatever needs nobody. Do not drive the station scripts by hand.</li>
<li>The mold is a general-purpose snapshot. This product's own code is its pack ({E(", ".join(f["repo"]["packs"]) or "none")}). A change to base behaviour is a pull request upstream, never a fork.</li>
<li>Credentials are named, never shown: not in the repository, not in a chat, not on this page. A pasted sign-in code becomes a private session outside the repository.</li>
<li>The operator is not an engineer. Ask for one thing at a time, in plain words, with numbered clicks from a web address, and say what is hidden and what expires.</li>
<li>Never publish a package, send a sign-in code to a real person, or create paid resources for a new application without the operator saying so.</li>
<li>Report what was measured. Read a test report before describing its result; a failed lane marks the application <i>reverted</i> until the cause is fixed and the ordered run passes.</li></ol>
<p class="muted">In the repository: state <code>{E(f["repo"]["state"])}</code> · brief <code>{E(f["repo"]["brief"])}</code> · instructions for agents <code>AGENTS.md</code> · the line <code>.claude/skills/mint/SKILL.md</code>.</p></section>

<details><summary>The same facts as data, for an agent</summary><pre>{E(json.dumps(f, indent=1))}</pre></details>
</div>
<script type="application/json" id="handoff-data">{data}</script>
"""

def main(a):
    if not a: sys.exit(__doc__)
    f = facts(a[0]); out = page(f)
    hits = sorted({m.group(0)[:40] for rx in FORBIDDEN for m in rx.finditer(out)})
    if hits: sys.exit("refusing to write the page: it would carry " + ", ".join(hits))
    d = os.path.join(ROOT, "reports", "mint"); os.makedirs(d, exist_ok=True); p = os.path.join(d, a[0] + ".handoff.html")
    open(p, "w").write(out); print(os.path.relpath(p, ROOT)); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
