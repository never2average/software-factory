"""Pick N buildable ideabrowser ideas (stratified by business model and product type) and split them into chunks.
  python3 select_ib_ideas.py IDEAS.csv N CHUNK_SIZE
Only id, title, market, scores and link are kept; the CSV itself is not redistributed.
"""
import collections, csv, json, math, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
rows, N, SIZE = list(csv.DictReader(open(sys.argv[1]))), int(sys.argv[2]), int(sys.argv[3])
SOFTWARE = {"SaaS", "Platform", "Mobile app", "Marketplace", "Ecommerce", "Hardware", "Plugin"}
ideas = [r for r in rows if r["market"].split(" · ")[-1] in SOFTWARE]
score = lambda r: float(r["ib_index"] or 0) + math.log10(1 + float(r["demand_avg_24mo"] or 0)) / 2
groups = collections.defaultdict(list)
for r in ideas:
    groups[r["market"].split(" · ")[-1]].append(r)
for g in groups.values():
    g.sort(key=score, reverse=True)
# Proportional share with a floor so mobile, marketplace and hardware ideas are represented.
FLOOR = {"Mobile app": 40, "Marketplace": 30, "Hardware": 15, "Ecommerce": 10, "Plugin": 2}
total = sum(len(g) for g in groups.values())
quota = {k: max(FLOOR.get(k, 0), round(N * len(g) / total)) for k, g in groups.items()}
while sum(quota.values()) > N:  # trim the largest group to hit N exactly
    quota[max(quota, key=quota.get)] -= 1
picked, seen = [], set()
for k, g in groups.items():
    taken = 0
    for r in g:
        key = re.sub(r"\(.*?\)|[^a-z ]", "", r["title"].lower()).strip()[:40]
        if taken == quota[k] or key in seen:
            continue
        seen.add(key); taken += 1
        picked.append({"id": f"idea-ib-{r['id']}", "title": re.sub(r"\s*\(.*?\)\s*$", "", r["title"]).strip(),
                       "market": r["market"], "product_type": k, "ideabrowser_id": r["id"], "ideabrowser_url": r["url"],
                       "scores": {x: r[x] for x in ("opportunity", "pain", "timing", "feasibility")}})
picked.sort(key=lambda i: i["id"])
out = os.path.join(HERE, "curate/geni"); os.makedirs(out, exist_ok=True)
for n in range(-(-len(picked) // SIZE)):
    json.dump(picked[n::-(-len(picked) // SIZE)], open(f"{out}/geni-{n + 1:02d}.json", "w"), indent=1, ensure_ascii=False)
print(len(picked), "ideas:", dict(collections.Counter(i["product_type"] for i in picked)), "->", -(-len(picked) // SIZE), "chunks")
