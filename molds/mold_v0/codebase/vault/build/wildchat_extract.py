"""Stage 1: pull candidate tool-choice coding requests from allenai/WildChat-4.8M (ODC-BY), one shard at a time.

Keeps the first user turn of English conversations that mention both a software context (framework, language, app)
and an infrastructure need (auth, database, queue, payments, ...). Writes candidates.jsonl; deletes each shard after use.
  python wildchat_extract.py OUT_DIR SHARD_START SHARD_END
"""
import json, os, re, sys, hashlib
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

out_dir, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(out_dir, exist_ok=True)
cache = os.path.join(out_dir, "shards")

SOFTWARE = re.compile(r"\b(react|next\.?js|vue|nuxt|svelte|angular|node(\.js)?|express|nest\.?js|django|flask|fastapi|"
                      r"rails|ruby|laravel|php|spring( boot)?|java|kotlin|golang|go (service|api|app|server)|rust|"
                      r"typescript|javascript|python|c#|\.net|asp\.net|flutter|react native|swift|android|ios app|"
                      r"backend|frontend|full[- ]?stack|web ?app|saas|api|microservice|mobile app|my app|our app|website)\b", re.I)
NEED = {
    "auth": r"\b(auth(entication|orization)?|log ?in|sign ?up|sign[- ]in|oauth|sso|jwt|session management|user accounts?|passwordless|2fa|mfa)\b",
    "database": r"\b(database|postgres(ql)?|mysql|sqlite|nosql|persist(ence)?|store (the )?data|migrations?|orm)\b",
    "background-jobs": r"\b(background (jobs?|tasks?|workers?)|job queue|task queue|message queue|queue|cron|scheduled (jobs?|tasks?)|worker process)\b",
    "caching": r"\b(cach(e|ing)|rate[- ]limit(ing)?)\b",
    "deployment": r"\b(deploy(ment|ing)?|host(ing)?|ci/?cd|serverless|containeri[sz]e|kubernetes|docker)\b",
    "observability": r"\b(monitor(ing)?|logging|error tracking|tracing|observability|alerts?|uptime|crash report(ing)?|metrics)\b",
    "payments": r"\b(payments?|billing|subscriptions?|checkout|invoic(e|ing)|charge (users|customers))\b",
    "email": r"\b(send(ing)? (an? )?e-?mails?|transactional e-?mail|email notifications?|newsletter|smtp)\b",
    "messaging": r"\b(sms|push notifications?|notifications? service|realtime|real-time|websockets?|live updates|chat feature)\b",
    "search": r"\b(full[- ]text search|search (feature|functionality|engine|bar)|fuzzy search|autocomplete)\b",
    "ai": r"\b(vector (database|store|search)|embeddings?|semantic search|rag|llm|chatbot)\b",
    "storage": r"\b(file uploads?|upload (files|images|photos)|object storage|image storage|store (files|images|uploads)|cdn)\b",
    "feature-flags": r"\b(feature flags?|feature toggles?|a/b test(ing)?|experiments? framework)\b",
    "analytics": r"\b(product analytics|analytics|event tracking|user tracking)\b",
}
NEED_RE = {k: re.compile(v, re.I) for k, v in NEED.items()}
CODE_DUMP = re.compile(r"(```|\n\s*(def |class |import |function |const |public |#include)|;\s*\n.*;\s*\n)")

seen = set()
out_path = os.path.join(out_dir, "candidates.jsonl")
if os.path.exists(out_path):
    for line in open(out_path):
        seen.add(json.loads(line)["hash"])
out = open(out_path, "a")
for i in range(start, end):
    name = f"data/train-{i:05d}-of-00086.parquet"
    path = hf_hub_download("allenai/WildChat-4.8M", name, repo_type="dataset", cache_dir=cache)
    pf = pq.ParquetFile(path)
    kept = 0
    # Batches keep memory flat: a whole shard as Python objects needs ~4.5 GB.
    rows_iter = (row for b in pf.iter_batches(batch_size=2000, columns=["conversation_hash", "language", "conversation", "toxic",
                                                                         "redacted", "timestamp"]) for row in b.to_pylist())
    for row in rows_iter:
        if row["language"] != "English" or row["toxic"]:
            continue
        conv = row["conversation"] or []
        first = next((m for m in conv if m.get("role") == "user"), None)
        if not first:
            continue
        text = (first.get("content") or "").strip()
        words = len(text.split())
        if words < 12 or words > 350 or CODE_DUMP.search(text) or not SOFTWARE.search(text):
            continue
        cats = [k for k, r in NEED_RE.items() if r.search(text)]
        if not cats:
            continue
        h = hashlib.sha1(re.sub(r"\W+", " ", text.lower()).strip().encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        out.write(json.dumps({"hash": h, "source": "allenai/WildChat-4.8M", "source_id": row["conversation_hash"],
                              "timestamp": str(row["timestamp"]), "redacted": bool(row["redacted"]),
                              "categories": cats, "text": text}) + "\n")
        kept += 1
    out.flush()
    os.remove(os.path.realpath(path))
    print(f"shard {i}: {pf.metadata.num_rows} rows -> {kept} candidates (total {len(seen)})", flush=True)
