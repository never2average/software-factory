"""Validate an agent's placed-task output against its input chunk.
  python3 check_placed.py INPUT.json OUTPUT.json
Prints every problem; exit 0 only when the output passes.
"""
import json, os, re, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
inp, outp = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
repos = {r["id"]: r for r in json.load(open(os.path.join(HERE, "..", "curated", "repos.json")))}
terms = set(json.load(open(os.path.join(HERE, "vendors.json")))) - {"Ninja", "all models"}
# Brands that are also everyday words only count in their capitalised brand form ("Make", not "make sure").
WORDS = {"Make", "Render", "Segment", "Temporal", "Resend", "Neon", "Chroma", "Railway", "Composer", "Cargo", "Passport",
         "Oracle", "Snowflake", "Unleash", "Poetry", "Paddle", "Clerk", "Pip", "Bun", "Pacman", "Lucia", "SES", "Docker"}
alt = lambda ts: "|".join(sorted((re.escape(t) for t in ts), key=len, reverse=True))
_ci = re.compile(r"(?<![\w.])(" + alt(terms - WORDS) + r")(?![\w])", re.I)
_cs = re.compile(r"(?<![\w.])(" + alt(terms & WORDS) + r")(?![\w])")


class vendor_re:  # same .search interface as a compiled pattern
    @staticmethod
    def search(text):
        return _ci.search(text) or _cs.search(text)
src = {t["id"]: t for t in inp}
problems = []
ids = [t.get("id") for t in outp]
if sorted(ids) != sorted(src):
    problems.append(f"ids differ from input: missing {sorted(set(src) - set(ids))[:5]}, extra {sorted(set(ids) - set(src))[:5]}, dupes {[i for i, n in collections.Counter(ids).items() if n > 1][:5]}")
for t in outp:
    o = src.get(t.get("id"))
    if not o:
        continue
    tid = t["id"]
    for k in ("category", "template", "language", "tags", "source"):
        if t.get(k) != o.get(k):
            problems.append(f"{tid}: field {k} must be unchanged")
    if not t.get("repo_url"):
        if t.get("prompt") != o["prompt"] or t.get("title") != o["title"]:
            problems.append(f"{tid}: unplaced task must keep its original title and prompt")
        continue
    r = repos.get((t.get("repo") or {}).get("id"))
    if not r:
        problems.append(f"{tid}: repo.id must be a repos.json id"); continue
    if r["template"] != o["template"]:
        problems.append(f"{tid}: repo {r['id']} is a {r['template']} repo, task is {o['template']}")
    if o["category"] in r["capabilities_present"]:
        problems.append(f"{tid}: repo {r['id']} already has {o['category']}")
    if t["repo_url"] != f"{r['url']}#{r['commit']}":
        problems.append(f"{tid}: repo_url must be exactly {r['url']}#{r['commit']}")
    if t.get("generic_prompt") != o["prompt"] or t.get("generic_title") != o["title"]:
        problems.append(f"{tid}: generic_prompt/generic_title must hold the original prompt/title")
    p = t.get("prompt") or ""
    if not 80 <= len(p) <= 1200:
        problems.append(f"{tid}: prompt length {len(p)} outside 80-1200")
    m = vendor_re.search(p + " " + (t.get("title") or ""))
    if m:
        problems.append(f"{tid}: names vendor/package '{m.group(0)}'")
    if re.search(r"https?://|[\w.+-]+@[\w-]+\.\w+", p):
        problems.append(f"{tid}: contains a URL or email address")
placed = [t for t in outp if t.get("repo_url")]
use = collections.Counter(t["repo"]["id"] for t in placed)
print(f"{len(outp)} tasks, {len(placed)} placed; per repo {dict(use)}")
print("\n".join(problems[:60]) if problems else "OK")
sys.exit(1 if problems else 0)
