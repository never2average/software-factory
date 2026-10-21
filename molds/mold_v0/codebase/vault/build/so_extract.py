"""Stage 1 (Stack Overflow): candidate tool-choice questions from pacovaldez/stackoverflow-questions.

Keeps questions whose TITLE asks how to add/implement/choose something in an infrastructure category (email, payments,
feature flags, analytics, jobs, storage, ...). Code blocks and HTML are stripped; the prose is what gets rewritten.
Reads in batches (low memory); one file on disk at a time.
  python so_extract.py OUT_DIR FILE_START FILE_END
"""
import hashlib, html, json, os, re, sys
import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download

out_dir, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(out_dir, exist_ok=True)
REPO = "pacovaldez/stackoverflow-questions"
files = sorted(f.path for f in HfApi().list_repo_tree(REPO, repo_type="dataset", recursive=True)
               if f.path.endswith(".parquet") and "/post_questions_train/" in f.path) or \
        sorted(f.path for f in HfApi().list_repo_tree(REPO, repo_type="dataset", recursive=True) if f.path.endswith(".parquet"))
print(f"{len(files)} parquet files", flush=True)

ASK = re.compile(r"\b(how (do|can|should|to)|best (way|practice|approach)|implement(ing)?|add(ing)?|set ?up|integrat(e|ing)|"
                 r"recommend|which .* (should|to use)|what is the (best|right|recommended)|build(ing)?|design(ing)?)\b", re.I)
NEED = {
    "email": r"\b(send(ing)? (an? )?e-?mails?|e-?mail (sending|service|notifications?|verification|confirmation)|transactional e-?mail|newsletter|password reset e-?mail|smtp)\b",
    "payments": r"\b(payments?|billing|subscriptions?|checkout|recurring (charges|billing)|invoic(e|es|ing)|paywall|in-app purchase)\b",
    "feature-flags": r"\b(feature (flags?|toggles?|switch(es)?)|a/?b test(ing|s)?|gradual (rollout|release)|dark launch|canary release)\b",
    "analytics": r"\b(analytics|track(ing)? (user|events?|page ?views?|clicks|usage)|event tracking|usage metrics|funnel)\b",
    "background-jobs": r"\b(background (jobs?|tasks?|process(ing)?|workers?)|job queue|task queue|message queue|scheduled (jobs?|tasks?)|cron jobs?|long[- ]running tasks?|async(hronous)? tasks?)\b",
    "storage": r"\b(file uploads?|upload(ing)? (files|images|photos|videos)|store (files|images|uploads|photos)|image (storage|hosting)|object storage|serve (images|files))\b",
    "caching": r"\b(cach(e|ing) (layer|responses?|results|queries|data)|distributed cache|rate[- ]limit(ing)?|throttl(e|ing) (requests|api))\b",
    "observability": r"\b(error (tracking|monitoring|reporting)|log aggregation|centrali[sz]ed logging|application monitoring|apm|distributed tracing|crash reporting|alerting)\b",
    "messaging": r"\b(push notifications?|sms|real[- ]?time (updates|notifications|chat)|websockets?|server[- ]sent events|live (updates|chat))\b",
    "search": r"\b(full[- ]text search|search engine|fuzzy search|autocomplete|search (functionality|feature) )\b",
    "auth": r"\b(authentication|social login|single sign[- ]on|sso|oauth ?2?|magic link|two[- ]factor|2fa|passwordless|user management)\b",
}
NEED_RE = {k: re.compile(v, re.I) for k, v in NEED.items()}
PRE = re.compile(r"<pre.*?</pre>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def prose(body):
    t = PRE.sub(" [code omitted] ", body or "")
    t = html.unescape(TAG.sub(" ", t))
    return re.sub(r"\s+", " ", t).strip()


out = open(os.path.join(out_dir, "candidates.jsonl"), "a")
total = 0
for i in range(start, min(end, len(files))):
    path = hf_hub_download(REPO, files[i], repo_type="dataset", cache_dir=os.path.join(out_dir, "files"))
    kept = rows = 0
    for batch in pq.ParquetFile(path).iter_batches(batch_size=5000, columns=["title", "body"]):
        for r_i, (title, body) in enumerate(zip(batch.column("title").to_pylist(), batch.column("body").to_pylist())):
            rows += 1
            if not title or not ASK.search(title):
                continue
            cats = [k for k, r in NEED_RE.items() if r.search(title)]
            if not cats:
                continue
            text = prose(body)
            if len(text.split()) < 25 or text.count("[code omitted]") > 3:
                continue
            text = f"{title}\n\n{text[:1800]}"
            h = hashlib.sha1(re.sub(r"\W+", " ", title.lower()).encode()).hexdigest()
            out.write(json.dumps({"hash": h, "source": REPO, "source_id": f"{files[i].rsplit('/', 1)[-1]}#{rows - 1}",
                                  "license": "CC-BY-SA-4.0 (Stack Overflow content)", "categories": cats, "text": text}) + "\n")
            kept += 1
    out.flush()
    os.remove(os.path.realpath(path))
    total += kept
    print(f"file {i}: {rows} questions -> {kept} candidates (total {total})", flush=True)
