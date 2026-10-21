"""Independent whole-library audit before shipping."""
import collections, json, random, re, sys
T = json.load(open(sys.argv[1]))
R = {r["id"]: r for r in json.load(open(sys.argv[2]))}
terms = set(json.load(open("vendors.json"))) - {"Ninja", "all models"}
WORDS = {"Make", "Render", "Segment", "Temporal", "Resend", "Neon", "Chroma", "Railway", "Composer", "Cargo", "Passport",
         "Oracle", "Snowflake", "Unleash", "Poetry", "Paddle", "Clerk", "Pip", "Bun", "Pacman", "Lucia", "SES", "Docker"}
alt = lambda ts: "|".join(sorted((re.escape(t) for t in ts), key=len, reverse=True))
ci = re.compile(r"(?<![\w.])(" + alt(terms - WORDS) + r")(?![\w])", re.I)
cs = re.compile(r"(?<![\w.])(" + alt(terms & WORDS) + r")(?![\w])")
url = re.compile(r"https?://|[\w.+-]+@[\w-]+\.\w+")
TEMPLATES = {"java-spring", "rust-axum", "cpp-cmake", "express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http", "react-native", "flutter"}
issues = collections.Counter(); examples = collections.defaultdict(list)
def flag(kind, t, detail=""):
    issues[kind] += 1
    if len(examples[kind]) < 3: examples[kind].append(f"{t['id']} {detail}"[:140])
ids = collections.Counter(t["id"] for t in T)
for t in T:
    if ids[t["id"]] > 1: flag("duplicate id", t)
    for f in ("id", "title", "prompt", "category", "template", "language", "source"):
        if not t.get(f): flag(f"missing {f}", t)
    if t.get("template") not in TEMPLATES: flag("bad template", t, t.get("template"))
    text = f"{t.get('title','')} {t.get('prompt','')}"
    m = ci.search(text) or cs.search(text)
    if m: flag("vendor name", t, m.group(0))
    if url.search(t.get("prompt", "")): flag("url/email", t)
    if not 60 <= len(t.get("prompt", "")) <= 1200: flag("prompt length", t, str(len(t.get("prompt", ""))))
    if t.get("repo_url"):
        r = R.get((t.get("repo") or {}).get("id"))
        if not r or t["repo_url"] != f"{r['url']}#{r['commit']}": flag("bad repo_url", t)
        elif t["category"] in r["capabilities_present"]: flag("capability already present", t)
        elif r["template"] != t["template"]: flag("template/repo mismatch", t)
print(f"{len(T)} tasks audited; issues: {dict(issues) or 'none'}")
for k, v in examples.items(): print(f"  {k}: {v}")
random.seed(2026)
for t in random.sample(T, 4):
    print(f"\n[{t['category']} / {t['template']} / {t.get('repo', {}).get('id', 'starter')}] {t['title']}\n  {t['prompt'][:300]}")
