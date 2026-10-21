"""Progress across curation waves: which chunks are done/valid/pending, and totals."""
import glob, json, os, subprocess, sys, collections
done = valid = cands_done = acc = placed = 0
pending, invalid = [], []
cats = collections.Counter()
for inp in sorted(glob.glob("curate/in/*.jsonl")):
    name = os.path.basename(inp)[:-6]
    out = f"curate/out/{name}.json"
    n = sum(1 for _ in open(inp))
    if not os.path.exists(out):
        pending.append(name); continue
    done += 1
    r = subprocess.run([sys.executable, "check_curated.py", inp, out], capture_output=True, text=True)
    if r.returncode:
        invalid.append(f"{name}: {r.stdout.strip().splitlines()[-1][:120]}"); continue
    valid += 1; cands_done += n
    T = json.load(open(out)); acc += len(T); placed += sum(1 for t in T if t.get("repo_url"))
    cats.update(t["category"] for t in T)
print(f"chunks: {valid} valid, {len(invalid)} invalid, {len(pending)} pending")
print(f"candidates curated {cands_done} -> {acc} accepted ({(100 * acc // cands_done) if cands_done else 0}%), {placed} placed in repos")
print("accepted by category:", dict(cats.most_common()))
if invalid: print("INVALID:", *invalid, sep="\n  ")
if pending: print("pending:", " ".join(pending))
