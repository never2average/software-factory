"""Round 2 candidate set: unclassified WildChat + Stack Overflow, weighted toward categories the library is thin in."""
import json, random, collections
random.seed(20261011)
THIN = {"email", "payments", "feature-flags", "analytics", "background-jobs", "storage", "caching", "observability",
        "messaging", "search"}
wc = open("wc/candidates.jsonl").readlines()
done = set(wc[:520] + wc[520::2])  # round 1 input
wc_left = [json.loads(l) for l in wc if l not in done]
wc_thin = [c for c in wc_left if THIN & set(c["categories"])]
so = [json.loads(l) for l in open("so-q/candidates.jsonl")]
# Per-category quota for Stack Overflow (a question counts toward its first thin category, else its first category).
QUOTA = {"auth": 80, "search": 200, "messaging": 300, "payments": 400}
by = collections.defaultdict(list)
for c in so:
    cat = next((x for x in c["categories"] if x in THIN), c["categories"][0])
    by[cat].append(c)
so_pick = []
for cat, items in by.items():
    random.shuffle(items)
    so_pick += items[:QUOTA.get(cat, len(items))]
out = wc_thin + so_pick
random.shuffle(out)
with open("round2-candidates.jsonl", "w") as f:
    f.writelines(json.dumps(c) + "\n" for c in out)
print(f"wildchat leftover {len(wc_left)} -> thin {len(wc_thin)}; stackoverflow {len(so)} -> {len(so_pick)}; total {len(out)}")
print("first-category mix", collections.Counter(next((x for x in c["categories"] if x in THIN), c["categories"][0]) for c in out))
