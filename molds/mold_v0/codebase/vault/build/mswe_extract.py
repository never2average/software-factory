"""Candidates from Multi-SWE-bench (ByteDance-Seed/Multi-SWE-bench): Java, Rust and C/C++ issues that read as feature
requests (not bug reports). Each candidate is a real issue on a real repo.
  python mswe_extract.py OUT_DIR
"""
import ast, hashlib, json, os, re, sys
from huggingface_hub import HfApi, hf_hub_download

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
REPO = "ByteDance-Seed/Multi-SWE-bench"
STACK = {"java": "java-spring", "rust": "rust-axum", "cpp": "cpp-cmake", "c": "cpp-cmake"}
FEATURE = re.compile(r"\b(add|support|feature|allow|option|enable|implement|introduce|provide|new|request|would be nice|ability to|configurable|integrat)", re.I)
BUG = re.compile(r"\b(fix|bug|crash|panic|regression|wrong|incorrect|broken|fails?|error|exception|segfault|leak|doesn'?t|does not|not working|unexpected)\b", re.I)
files = [f.path for f in HfApi().list_repo_tree(REPO, repo_type="dataset", recursive=True)
         if f.path.endswith(".jsonl") and f.path.split("/")[0] in STACK]
seen, kept = set(), 0
with open(os.path.join(out_dir, "candidates.jsonl"), "w") as out:
    for path in sorted(files):
        local = hf_hub_download(REPO, path, repo_type="dataset", cache_dir=os.path.join(out_dir, "hf"))
        for line in open(local):
            d = json.loads(line)
            issues = d.get("resolved_issues") or []
            if isinstance(issues, str):
                try: issues = ast.literal_eval(issues)
                except Exception: issues = []
            for iss in issues:
                title, body = (iss.get("title") or "").strip(), (iss.get("body") or "").strip()
                if not title or BUG.search(title) or not FEATURE.search(title + " " + body[:300]):
                    continue
                src = f"github.com/{d['org']}/{d['repo']}/issues/{iss.get('number')}"
                h = hashlib.sha1(src.encode()).hexdigest()
                if h in seen: continue
                seen.add(h)
                text = re.sub(r"```.*?```", " [code omitted] ", body, flags=re.S)
                text = re.sub(r"\s+", " ", text)[:1800]
                out.write(json.dumps({"hash": h, "source": REPO, "source_id": src, "license": "issue text from the upstream repository",
                                      "stacks": [STACK[path.split('/')[0]]], "categories": [], "repo": f"{d['org']}/{d['repo']}",
                                      "text": f"{title}\n\n{text}"}) + "\n")
                kept += 1
        print(path, "->", kept, "total", flush=True)
print("candidates:", kept)
