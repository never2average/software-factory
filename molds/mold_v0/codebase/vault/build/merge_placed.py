"""Merge the subagents' placed chunks into the final library, re-validating each against its input."""
import collections, glob, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
out, failed = [], []
for inp in sorted(glob.glob("place/*.json")):
    res = inp.replace("place/", "place/out/")
    if not os.path.exists(res):
        failed.append(f"{res} missing"); continue
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_placed.py"), inp, res], capture_output=True, text=True)
    if r.returncode != 0:
        failed.append(f"{res}: {r.stdout.strip().splitlines()[-1]}")
    out += json.load(open(res))
if failed:
    print("NOT MERGED:\n  " + "\n  ".join(failed)); sys.exit(1)
ids = [t["id"] for t in out]
assert len(ids) == len(set(ids)), "duplicate ids"
json.dump(out, open("tasks-final.json", "w"), indent=2, ensure_ascii=False)
placed = [t for t in out if t.get("repo_url")]
print(f"{len(out)} tasks, {len(placed)} in example repos ({100 * len(placed) // len(out)}%), {len(out) - len(placed)} on starter templates")
print("by category:", dict(collections.Counter(t["category"] for t in out).most_common()))
print("by source:", dict(collections.Counter(t["source"]["dataset"] for t in out)))
use = collections.Counter(t["repo"]["id"] for t in placed)
repos = json.load(open(os.path.join(HERE, "..", "curated", "repos.json")))
print("repos used:", len(use), "of", len(repos), "| unused:", [r["id"] for r in repos if r["id"] not in use])
print("tasks per repo min/max:", min(use.values()), max(use.values()))
