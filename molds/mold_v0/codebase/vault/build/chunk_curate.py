"""Split full-SO candidates into per-stack chunks for curation subagents, thin categories and high scores first."""
import collections, json, os
PRIORITY = ["agents", "feature-flags", "observability", "caching", "analytics", "search", "payments", "email", "background-jobs",
            "storage", "messaging", "ai", "deployment", "database", "auth"]
rank = {c: i for i, c in enumerate(PRIORITY)}
seen = set()
for f in ("so-q/candidates.jsonl", "wc/candidates.jsonl"):
    for l in open(f):
        seen.add(json.loads(l)["hash"])
import glob
for f in glob.glob("curate/in/*.jsonl"):  # already handed to an agent (pilot or earlier wave)
    for l in open(f):
        seen.add(json.loads(l)["hash"])
cands, dup = [], 0
for l in open("sof/candidates.jsonl"):
    c = json.loads(l)
    if c["hash"] in seen:
        dup += 1; continue
    seen.add(c["hash"]); cands.append(c)
by = collections.defaultdict(list)
for c in cands:
    # Primary stack: the most specific tag family (Next/FastAPI/Django/Go before the broad Node/TypeScript one).
    order = ["react-native", "flutter", "nextjs-ts", "fastapi", "django", "go-http", "express-ts", "any"]
    by[min(c["stacks"], key=order.index)].append(c)
import sys
WAVE = sys.argv[1]
os.makedirs("curate/in", exist_ok=True)
SIZE = 150
chunks = []
for stack, items in by.items():
    items.sort(key=lambda c: (min(rank.get(x, 99) for x in c["categories"]), -(c["score"] or 0)))
    for i in range(0, len(items), SIZE):
        name = f"curate/in/w{WAVE}-{stack}-{i // SIZE + 1:02d}.jsonl"
        with open(name, "w") as f:
            f.writelines(json.dumps(c) + "\n" for c in items[i:i + SIZE])
        chunks.append((name, stack, len(items[i:i + SIZE])))
print(f"{len(cands)} new candidates ({dup} duplicates dropped) -> {len(chunks)} chunks")
print("by stack:", {s: len(v) for s, v in by.items()})
print("by first category:", dict(collections.Counter(min(c["categories"], key=lambda x: rank.get(x, 99)) for c in cands).most_common()))
json.dump(chunks, open(f"curate/chunks-w{WAVE}.json", "w"))
