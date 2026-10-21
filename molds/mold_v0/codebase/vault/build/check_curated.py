"""Validate a subagent's curated output (accepted tasks only) against its candidate chunk.
  python3 check_curated.py CHUNK.jsonl OUTPUT.json
Exit 0 only when every task passes.
"""
import json, os, re, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
REPOS = os.environ.get("REPOS_JSON", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curated", "repos.json"))
cands = {json.loads(l)["source_id"]: json.loads(l) for l in open(sys.argv[1])}
outp = json.load(open(sys.argv[2]))
repos = {r["id"]: r for r in json.load(open(REPOS))}
CATS = {"auth", "database", "background-jobs", "caching", "deployment", "observability", "payments", "email", "messaging",
        "search", "ai", "agents", "storage", "feature-flags", "analytics"}
TEMPLATES = {"express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter",
             "java-spring", "rust-axum", "cpp-cmake"}
LANG = {"express-ts": "TypeScript", "nextjs-ts": "TypeScript", "node-ts": "TypeScript", "fastapi": "Python", "django": "Python",
        "go-http": "Go", "react-native": "TypeScript", "flutter": "Dart", "java-spring": "Java", "rust-axum": "Rust",
        "cpp-cmake": "C++"}
terms = set(json.load(open(os.path.join(HERE, "vendors.json")))) - {"Ninja", "all models"}
WORDS = {"Make", "Render", "Segment", "Temporal", "Resend", "Neon", "Chroma", "Railway", "Composer", "Cargo", "Passport",
         "Oracle", "Snowflake", "Unleash", "Poetry", "Paddle", "Clerk", "Pip", "Bun", "Pacman", "Lucia", "SES", "Docker"}
alt = lambda ts: "|".join(sorted((re.escape(t) for t in ts), key=len, reverse=True))
_ci = re.compile(r"(?<![\w.])(" + alt(terms - WORDS) + r")(?![\w])", re.I)
_cs = re.compile(r"(?<![\w.])(" + alt(terms & WORDS) + r")(?![\w])")
vendor = lambda s: _ci.search(s) or _cs.search(s)
bad_text = re.compile(r"https?://|[\w.+-]+@[\w-]+\.\w+|stack ?overflow", re.I)

problems = []
ids = [t.get("id") for t in outp]
for i, n in collections.Counter(ids).items():
    if n > 1:
        problems.append(f"duplicate id {i}")
for t in outp:
    tid = t.get("id", "?")
    src = (t.get("source") or {}).get("source_id")
    c = cands.get(src)
    if not c:
        problems.append(f"{tid}: source.source_id must be one of the chunk's candidate source_ids"); continue
    if src.startswith("stackoverflow.com/"):
        want_id = "so-" + src.rsplit("/", 1)[-1]
    elif src.startswith("github.com/"):
        want_id = "mswe-" + re.sub(r"[^a-z0-9]+", "-", src[len("github.com/"):].lower()).strip("-")[:70]
    else:
        want_id = "wc-" + src[:12]
    if tid != want_id:
        problems.append(f"{tid}: id must be {want_id}")
    if t.get("category") not in CATS:
        problems.append(f"{tid}: category must be one of {sorted(CATS)}")
    if t.get("template") not in TEMPLATES:
        problems.append(f"{tid}: template must be one of {sorted(TEMPLATES)}")
    elif t.get("language") != LANG[t["template"]]:
        problems.append(f"{tid}: language must be {LANG[t['template']]} for {t['template']}")
    tags = t.get("tags") or []
    if not (2 <= len(tags) <= 5) or any(vendor(x) for x in tags):
        problems.append(f"{tid}: tags must be 2-5 generic tags without vendor names")
    s = t.get("source") or {}
    for k in ("dataset", "license"):
        if s.get(k) != c.get({"dataset": "source"}.get(k, k)):
            problems.append(f"{tid}: source.{k} must be copied from the candidate ({c.get({'dataset': 'source'}.get(k, k))})")
    for field, lo, hi in (("generic_prompt", 60, 1200), ("prompt", 80, 1200)):
        v = t.get(field) or ""
        if not lo <= len(v) <= hi:
            problems.append(f"{tid}: {field} length {len(v)} outside {lo}-{hi}")
        m = vendor(v + " " + (t.get(field.replace("prompt", "title")) or ""))
        if m:
            problems.append(f"{tid}: {field}/title names vendor/package '{m.group(0)}'")
        if bad_text.search(v):
            problems.append(f"{tid}: {field} contains a URL, email address or mentions the source site")
    if t.get("repo_url"):
        r = repos.get((t.get("repo") or {}).get("id"))
        if not r:
            problems.append(f"{tid}: repo.id must be a repos.json id"); continue
        if r["template"] != t.get("template"):
            problems.append(f"{tid}: repo {r['id']} is {r['template']}, task template is {t.get('template')}")
        if t.get("category") in r["capabilities_present"]:
            problems.append(f"{tid}: repo {r['id']} already has {t['category']}")
        if t["repo_url"] != f"{r['url']}#{r['commit']}":
            problems.append(f"{tid}: repo_url must be exactly {r['url']}#{r['commit']}")
    elif t.get("prompt") != t.get("generic_prompt") or t.get("title") != t.get("generic_title"):
        problems.append(f"{tid}: without repo_url, title/prompt must equal generic_title/generic_prompt")
placed = sum(1 for t in outp if t.get("repo_url"))
print(f"{len(cands)} candidates -> {len(outp)} accepted ({placed} placed in repos)")
print("\n".join(problems[:60]) if problems else "OK")
sys.exit(1 if problems else 0)
