"""Assemble the curated library: the deployed library + every valid curated chunk, deduped and re-validated.
  python3 build_library.py OUT_TASKS.json OUT_REPOS.json
"""
import collections, glob, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get("BASE_LIBRARY", os.path.join(HERE, "..", "curated", "tasks.json"))
REPOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curated", "repos.json")
out_tasks, out_repos = sys.argv[1], sys.argv[2]
repos = {r["id"]: r for r in json.load(open(REPOS))}

tasks, skipped = [], []
base = json.load(open(LIB))
for t in base:
    t.setdefault("generic_title", t["title"]); t.setdefault("generic_prompt", t["prompt"])
tasks += base
for inp in sorted(glob.glob(os.path.join(HERE, "curate/in/*.jsonl"))):
    out = inp.replace("/in/", "/out/").replace(".jsonl", ".json")
    if not os.path.exists(out):
        continue
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_curated.py"), inp, out], capture_output=True, text=True)
    if r.returncode:
        skipped.append(os.path.basename(out)); continue
    tasks += json.load(open(out))

# Generated (idea-based) agent-building and feature-flag tasks, each chunk re-validated.
for ideas in sorted(glob.glob(os.path.join(HERE, "curate/gen/*.json"))):
    out = ideas.replace("/gen/", "/gen-out/")
    if not os.path.exists(out):
        continue
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_generated.py"), ideas, out], capture_output=True, text=True)
    if r.returncode:
        skipped.append(os.path.basename(out)); continue
    tasks += json.load(open(out))

# Generated Java/Rust/C++ tasks (stack mode).
for ideas in sorted(glob.glob(os.path.join(HERE, "curate/gens/*.json"))):
    out = ideas.replace("/gens/", "/gens-out/")
    if not os.path.exists(out):
        continue
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_generated.py"), ideas, out], capture_output=True, text=True,
                       env={**os.environ, "GEN_MODE": "stack"})
    if r.returncode:
        skipped.append(os.path.basename(out)); continue
    tasks += json.load(open(out))

# Generated from real ideabrowser ideas (idea mode: 0-6 tasks per idea, sized by the product).
for ideas in sorted(glob.glob(os.path.join(HERE, "curate/geni/*.json"))):
    out = ideas.replace("/geni/", "/geni-out/")
    if not os.path.exists(out):
        continue
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_generated.py"), ideas, out], capture_output=True, text=True,
                       env={**os.environ, "GEN_MODE": "idea"})
    if r.returncode:
        skipped.append(os.path.basename(out)); continue
    tasks += json.load(open(out))

seen_ids, seen_titles, final, dups = set(), set(), [], 0
for t in tasks:
    k = re.sub(r"\W+", " ", (t.get("generic_title") or t["title"]).lower()).strip()
    if t["id"] in seen_ids or k in seen_titles:
        dups += 1; continue
    seen_ids.add(t["id"]); seen_titles.add(k)
    if t.get("repo_url"):
        r = repos.get(t["repo"]["id"])
        assert r and t["repo_url"] == f"{r['url']}#{r['commit']}" and r["template"] == t["template"], t["id"]
        assert t["category"] not in r["capabilities_present"], t["id"]
    final.append(t)
# Balance: at most CAP tasks per (repo, category); the rest fall back to their generic starter version.
CAP = int(os.environ.get("REPO_CATEGORY_CAP", "25"))
per, reverted = collections.Counter(), 0
for t in final:
    if t.get("repo_url"):
        k = (t["repo"]["id"], t["category"])
        per[k] += 1
        if per[k] > CAP:
            t["title"], t["prompt"] = t["generic_title"], t["generic_prompt"]
            t.pop("repo_url", None); t.pop("repo", None)
            reverted += 1
print(f"balance: {reverted} placements over {CAP}/repo/category reverted to starters")

# Undersample Express: keep every repo-placed Express task, then starter-only ones (rarest categories first) up to the cap.
import hashlib
EXPRESS_CAP = int(os.environ.get("EXPRESS_CAP", "1200"))
ex = [t for t in final if t["template"] == "express-ts"]
if len(ex) > EXPRESS_CAP:
    placed_ex = [t for t in ex if t.get("repo_url")]
    starter_ex = [t for t in ex if not t.get("repo_url")]
    freq = collections.Counter(t["category"] for t in final)
    starter_ex.sort(key=lambda t: (freq[t["category"]], hashlib.sha1(t["id"].encode()).hexdigest()))
    keep = {id(t) for t in placed_ex[:EXPRESS_CAP]} | {id(t) for t in starter_ex[:max(0, EXPRESS_CAP - len(placed_ex))]}
    before = len(final)
    final = [t for t in final if t["template"] != "express-ts" or id(t) in keep]
    print(f"express undersampled: {len(ex)} -> {sum(1 for t in final if t['template'] == 'express-ts')} ({before - len(final)} dropped)")
json.dump(final, open(out_tasks, "w"), indent=2, ensure_ascii=False)
json.dump(list(repos.values()), open(out_repos, "w"), indent=2)
placed = [t for t in final if t.get("repo_url")]
print(f"library: {len(final)} tasks ({len(placed)} in repos, {len(final) - len(placed)} on starters); {dups} duplicates dropped; "
      f"invalid chunks skipped: {skipped or 'none'}")
print("by category:", dict(collections.Counter(t["category"] for t in final).most_common()))
print("by template:", dict(collections.Counter(t["template"] for t in final).most_common()))
print("by source:", dict(collections.Counter(t["source"].get("dataset") for t in final).most_common()))
print(f"repos: {len(repos)} in catalog, {len({t['repo']['id'] for t in placed})} used")
