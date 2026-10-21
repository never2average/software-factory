"""Chunk Java/Rust/C++ candidates: all Rust and C++, Java sampled to a cap; skip anything already chunked.
  python3 chunk_jrc.py WAVE JAVA_CAP
"""
import collections, glob, json, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
wave, java_cap = sys.argv[1], int(sys.argv[2])
PRIORITY = ["agents", "feature-flags", "ai", "observability", "caching", "analytics", "search", "payments", "email",
            "background-jobs", "storage", "messaging", "deployment", "database", "auth"]
rank = {c: i for i, c in enumerate(PRIORITY)}
seen = set()
for f in glob.glob("curate/in/*.jsonl"):
    for l in open(f):
        seen.add(json.loads(l)["hash"])
by = collections.defaultdict(list)
for l in open("sof-jrc/candidates.jsonl"):
    c = json.loads(l)
    if c["hash"] in seen:
        continue
    seen.add(c["hash"])
    st = c["stacks"][0] if len(c["stacks"]) == 1 else ("rust-axum" if "rust-axum" in c["stacks"] else "cpp-cmake" if "cpp-cmake" in c["stacks"] else "java-spring")
    by[st].append(c)
key = lambda c: (min(rank.get(x, 99) for x in c["categories"]), -(c["score"] or 0))
SIZE, made = 150, []
for st, items in by.items():
    items.sort(key=key)
    if st == "java-spring":
        items = items[:java_cap]
    for i in range(0, len(items), SIZE):
        name = f"curate/in/{wave}-{st}-{i // SIZE + 1:02d}.jsonl"
        with open(name, "w") as f:
            f.writelines(json.dumps(c) + "\n" for c in items[i:i + SIZE])
        made.append((os.path.basename(name)[:-6], len(items[i:i + SIZE])))
print({st: len(v) for st, v in by.items()}, "->", len(made), "chunks")
print(" ".join(f"{n}:{k}" for n, k in made))
