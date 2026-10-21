"""Validate generated (idea-based) tasks. python3 check_generated.py IDEAS_CHUNK.json OUTPUT.json"""
import json, os, re, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
ideas = {i["id"]: i for i in json.load(open(sys.argv[1]))}
outp = json.load(open(sys.argv[2]))
repos = {r["id"]: r for r in json.load(open(os.environ.get("REPOS_JSON", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curated", "repos.json"))))}
LANG = {"express-ts": "TypeScript", "nextjs-ts": "TypeScript", "node-ts": "TypeScript", "fastapi": "Python", "django": "Python",
        "go-http": "Go", "react-native": "TypeScript", "flutter": "Dart", "java-spring": "Java", "rust-axum": "Rust", "cpp-cmake": "C++"}
STACK_MODE = os.environ.get("GEN_MODE") == "stack"
IDEA_MODE = os.environ.get("GEN_MODE") == "idea"  # ideabrowser ideas: 0-6 tasks per idea, sized by the product, with a plan file
ALL_CATS = {"auth", "database", "background-jobs", "caching", "deployment", "observability", "payments", "email", "messaging",
            "search", "ai", "storage", "feature-flags", "analytics", "agents"}
CATS = ALL_CATS if IDEA_MODE else ({"auth", "database", "background-jobs", "caching", "deployment", "observability", "payments", "email", "messaging",
         "search", "ai", "storage", "feature-flags", "analytics"} if STACK_MODE else {"agents", "feature-flags"})
terms = set(json.load(open(os.path.join(HERE, "vendors.json")))) - {"Ninja", "all models"}
WORDS = {"Make", "Render", "Segment", "Temporal", "Resend", "Neon", "Chroma", "Railway", "Composer", "Cargo", "Passport",
         "Oracle", "Snowflake", "Unleash", "Poetry", "Paddle", "Clerk", "Pip", "Bun", "Pacman", "Lucia", "SES", "Docker"}
alt = lambda ts: "|".join(sorted((re.escape(t) for t in ts), key=len, reverse=True))
ci = re.compile(r"(?<![\w.])(" + alt(terms - WORDS) + r")(?![\w])", re.I)
cs = re.compile(r"(?<![\w.])(" + alt(terms & WORDS) + r")(?![\w])")
vendor = lambda s: ci.search(s) or cs.search(s)
bad = re.compile(r"https?://|[\w.+-]+@[\w-]+\.\w+")
problems, per_idea = [], collections.Counter()
ids = collections.Counter(t.get("id") for t in outp)
for t in outp:
    tid = t.get("id", "?")
    if ids[tid] > 1: problems.append(f"duplicate id {tid}")
    src = t.get("source") or {}
    if src.get("dataset") != "generated" or src.get("idea_id") not in ideas:
        problems.append(f"{tid}: source must be {{dataset: generated, idea_id: <an idea id in the chunk>}}"); continue
    if not re.fullmatch(r"gen-[a-z0-9-]{6,80}", tid): problems.append(f"{tid}: id must look like gen-<idea-id>-<slug>")
    per_idea[src["idea_id"]] += 1
    if t.get("category") not in CATS: problems.append(f"{tid}: category must be one of {sorted(CATS)}")
    if t.get("template") not in LANG or t.get("language") != LANG.get(t.get("template")):
        problems.append(f"{tid}: template/language invalid")
    if IDEA_MODE and t.get("template") == "express-ts":
        problems.append(f"{tid}: express-ts is capped; pick the stack that fits the product")
    if STACK_MODE and t.get("template") != ideas[src["idea_id"]].get("assigned_stack"):
        problems.append(f"{tid}: template must be the idea's assigned_stack ({ideas[src['idea_id']].get('assigned_stack')})")
    if not 2 <= len(t.get("tags") or []) <= 5 or any(vendor(x) for x in t.get("tags") or []): problems.append(f"{tid}: tags")
    for f, lo, hi in (("generic_prompt", 120, 1400), ("prompt", 120, 1400)):
        v = t.get(f) or ""
        if not lo <= len(v) <= hi: problems.append(f"{tid}: {f} length {len(v)}")
        m = vendor(v + " " + (t.get(f.replace("prompt", "title")) or ""))
        if m: problems.append(f"{tid}: names vendor/package '{m.group(0)}'")
        if bad.search(v): problems.append(f"{tid}: URL/email in {f}")
    if t.get("repo_url"):
        r = repos.get((t.get("repo") or {}).get("id"))
        if not r or t["repo_url"] != f"{r['url']}#{r['commit']}" or r["template"] != t.get("template") or t.get("category") in r["capabilities_present"]:
            problems.append(f"{tid}: repo placement invalid")
    elif t.get("prompt") != t.get("generic_prompt") or t.get("title") != t.get("generic_title"):
        problems.append(f"{tid}: without repo_url, title/prompt must equal generic_*")
if IDEA_MODE:
    # The plan (OUTPUT.plan.json) sizes each idea: [{idea_id, task_count 0-6, rationale}], matching the tasks written.
    plan_path = sys.argv[2].replace(".json", ".plan.json")
    plan = {x.get("idea_id"): x for x in json.load(open(plan_path))} if os.path.exists(plan_path) else {}
    if not plan: problems.append(f"missing plan file {plan_path}")
    per_cat = collections.defaultdict(list)
    for t in outp:
        per_cat[(t.get("source") or {}).get("idea_id")].append(t.get("category"))
    for i in ideas:
        x = plan.get(i)
        if not x: problems.append(f"{i}: not in plan"); continue
        if not isinstance(x.get("task_count"), int) or not 0 <= x["task_count"] <= 6: problems.append(f"{i}: task_count must be 0-6")
        elif x["task_count"] != per_idea[i]: problems.append(f"{i}: plan says {x['task_count']} tasks, output has {per_idea[i]}")
        if len((x.get("rationale") or "").strip()) < 30: problems.append(f"{i}: rationale too short")
        if len(per_cat[i]) != len(set(per_cat[i])): problems.append(f"{i}: repeated category {per_cat[i]}")
    for t in outp:
        s_ = t.get("source") or {}
        if s_.get("idea_id") in ideas and s_.get("ideabrowser_url") != ideas[s_["idea_id"]].get("ideabrowser_url"):
            problems.append(f"{t.get('id')}: source.ideabrowser_url must be copied from the idea")
else:
    missing = [i for i in ideas if per_idea[i] == 0]
    if missing: problems.append(f"ideas with no tasks: {missing[:5]}")
agents = sum(1 for t in outp if t.get("category") == "agents"); flags = len(outp) - agents
print(f"{len(ideas)} ideas -> {len(outp)} tasks ({agents} agents, {flags} other, {sum(1 for t in outp if t.get('repo_url'))} placed)")
print("\n".join(problems[:50]) if problems else "OK")
sys.exit(1 if problems else 0)
