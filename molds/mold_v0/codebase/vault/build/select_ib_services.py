"""Pick every service-type ideabrowser idea (to be reimagined as an agent product) and split into chunks after geni-10.
  python3 select_ib_services.py IDEAS.csv CHUNK_SIZE FIRST_CHUNK_NO
"""
import csv, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
rows, SIZE, FIRST = list(csv.DictReader(open(sys.argv[1]))), int(sys.argv[2]), int(sys.argv[3])
SERVICE = {"Service", "Productized service"}
picked = [{"id": f"idea-ib-{r['id']}", "title": re.sub(r"\s*\(.*?\)\s*$", "", r["title"]).strip(), "market": r["market"],
           "product_type": r["market"].split(" · ")[-1], "service_to_agent": True, "ideabrowser_id": r["id"],
           "ideabrowser_url": r["url"], "scores": {x: r[x] for x in ("opportunity", "pain", "timing", "feasibility")}}
          for r in rows if r["market"].split(" · ")[-1] in SERVICE]
n = -(-len(picked) // SIZE)
out = os.path.join(HERE, "curate/geni")
for k in range(n):
    json.dump(picked[k::n], open(f"{out}/geni-{FIRST + k:02d}.json", "w"), indent=1, ensure_ascii=False)
print(len(picked), "service ideas ->", n, f"chunks geni-{FIRST:02d}..geni-{FIRST + n - 1:02d}")
