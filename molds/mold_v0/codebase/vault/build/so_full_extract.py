"""Stage 1 (full Stack Overflow, mikex86/stackoverflow-posts): high-precision tool-choice candidates.

Keeps questions that (a) have engagement (score >= 2 or >= 1000 views), (b) are tagged with one of Octillion's stacks,
(c) signal a capability through tags or the title, and (d) ask how to build something rather than report an error.
Reads batches with projected columns; one ~580 MB file on disk at a time.
  python so_full_extract.py OUT_DIR FILE_START FILE_END [new-only]
"new-only" emits just mobile (React Native / Flutter), agent-building and DBMS candidates (for files already scanned).
"""
import hashlib, html, json, os, re, sys
import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download

out_dir, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
NEW_ONLY = len(sys.argv) > 4 and sys.argv[4] == "new-only"
JRC_ONLY = len(sys.argv) > 4 and sys.argv[4] == "jrc-only"
os.makedirs(out_dir, exist_ok=True)
REPO = "mikex86/stackoverflow-posts"
files = sorted(f.path for f in HfApi().list_repo_tree(REPO, repo_type="dataset", recursive=True) if f.path.endswith(".parquet"))

STACK_TAGS = {
    "express-ts": {"express", "nestjs", "koa", "fastify", "node.js", "typescript", "express-session", "passport.js"},
    "nextjs-ts": {"next.js", "nextjs", "next.js13", "next-auth", "vercel", "reactjs", "react-hooks"},
    "fastapi": {"fastapi", "starlette", "pydantic", "uvicorn"},
    "django": {"django", "django-rest-framework", "django-models", "django-views", "django-forms", "django-templates", "django-celery"},
    "go-http": {"go", "gin", "go-gin", "echo", "go-echo", "go-fiber", "gorilla"},
    "react-native": {"react-native", "expo", "react-native-android", "react-native-ios", "expo-router", "react-native-navigation"},
    "flutter": {"flutter", "dart", "flutter-layout", "flutter-dependencies", "flutter-web", "flutter-provider", "flutter-bloc", "riverpod"},
}
MOBILE = {"react-native", "flutter"}
STACK_TAGS.update({
    "java-spring": {"spring-boot", "spring", "spring-mvc", "spring-security", "spring-data-jpa", "spring-data", "hibernate",
                    "jpa", "quarkus", "micronaut", "jakarta-ee", "java-ee", "spring-webflux", "spring-cloud", "java"},
    "rust-axum": {"rust", "rust-tokio", "actix-web", "rust-axum", "axum", "rust-rocket", "rocket", "serde", "rust-diesel",
                  "diesel", "sqlx", "tokio", "warp", "rust-cargo"},
    "cpp-cmake": {"c++", "cmake", "qt", "boost", "c++11", "c++14", "c++17", "c++20", "boost-asio", "poco-libraries",
                  "qt5", "qt6", "boost-beast", "grpc-c++"},
})
JRC = {"java-spring", "rust-axum", "cpp-cmake"}
TITLE_CATS = {k: re.compile(v, re.I) for k, v in {
    "observability": r"\b(logging|logger|log files?|metrics|tracing|telemetry|monitor(ing)?|crash report)",
    "database": r"\b(database|sqlite|postgres|mysql|orm|persist(ence)?|store .* data|schema|migrations?)",
    "auth": r"\b(authenticat|authoriz|login|oauth|jwt|password hash|sessions?)\b",
    "messaging": r"\b(websockets?|message queue|pub/?sub|push notification|real[- ]time|mqtt|zeromq|grpc streaming)",
    "background-jobs": r"\b(background (task|job|thread)|scheduler|cron|job queue|task queue|thread pool for jobs)",
    "caching": r"\b(cach(e|ing)|rate limit)",
    "search": r"\b(full[- ]text search|search engine|fuzzy search|indexing documents)",
    "storage": r"\b(file upload|object storage|blob storage|store (files|images))",
    "payments": r"\b(payment|billing|subscription|checkout)",
    "email": r"\b(send(ing)? e-?mails?|smtp)\b",
    "feature-flags": r"\b(feature (flags?|toggles?)|a/b test|gradual rollout|remote config)",
    "ai": r"\b(llm|language model|embeddings?|inference server|onnx|chatbot)",
    "agents": r"\b(ai agent|llm agent|tool calling|function calling|rag\b|retrieval[- ]augmented)",
    "deployment": r"\b(deploy|docker(file)?|container|kubernetes|ci/cd|cross[- ]compil)",
}.items()}
CAT_TAGS = {
    "email": {"email", "smtp", "nodemailer", "sendgrid", "mailgun", "amazon-ses", "postmark", "django-email", "html-email", "email-verification", "transactional-email"},
    "payments": {"stripe-payments", "stripe.js", "paypal", "braintree", "payment-gateway", "payment", "subscription", "in-app-purchase", "paddle", "razorpay", "recurring-billing"},
    "feature-flags": {"feature-toggle", "feature-flags", "launchdarkly", "unleash", "a-b-testing", "ab-testing"},
    "analytics": {"google-analytics", "analytics", "mixpanel", "segment-io", "posthog", "amplitude-analytics", "tracking", "event-tracking"},
    "background-jobs": {"bull", "bullmq", "celery", "cron", "node-cron", "background-process", "job-queue", "task-queue", "rabbitmq", "amazon-sqs", "kue", "agenda", "rq", "apscheduler", "worker", "scheduled-tasks"},
    "storage": {"file-upload", "amazon-s3", "multer", "image-upload", "cloudinary", "blob", "google-cloud-storage", "minio", "presigned-url", "django-storages"},
    "caching": {"caching", "redis", "memcached", "rate-limiting", "node-cache", "django-cache", "http-caching"},
    "observability": {"logging", "sentry", "datadog", "monitoring", "opentelemetry", "winston", "pino", "prometheus", "error-logging", "apm", "tracing"},
    "messaging": {"websocket", "socket.io", "push-notification", "server-sent-events", "real-time", "pusher", "firebase-cloud-messaging", "twilio", "sms", "django-channels", "web-push"},
    "search": {"full-text-search", "elasticsearch", "algolia", "meilisearch", "typesense", "search", "autocomplete", "postgresql-full-text-search"},
    "auth": {"authentication", "oauth-2.0", "jwt", "passport.js", "next-auth", "auth0", "openid-connect", "single-sign-on", "two-factor-authentication", "session", "clerk", "supabase-auth"},
    "ai": {"embedding", "vector-database", "pinecone", "chatbot", "gpt-3", "huggingface-transformers", "openai-api", "chatgpt-api"},
    "agents": {"langchain", "langchain-js", "py-langchain", "llama-index", "autogen", "crewai", "function-calling",
               "openai-assistants-api", "retrieval-augmented-generation", "ai-agent", "langgraph", "semantic-kernel", "ollama",
               "large-language-model", "openai-function-calling", "agent", "multi-agent"},
    "database": {"orm", "prisma", "typeorm", "sequelize.js", "mongoose", "sqlalchemy", "database-migration", "drizzle", "knex.js", "gorm",
                 "sqflite", "realm", "watermelondb", "asyncstorage", "hive", "drift", "isar", "google-cloud-firestore",
                 "firebase-realtime-database"},
    "deployment": {"deployment", "docker", "heroku", "vercel", "aws-lambda", "serverless", "github-actions", "ci-cd", "kubernetes", "nginx"},
}
TAG2CAT = {t: c for c, ts in CAT_TAGS.items() for t in ts}
CAT_TAGS["messaging"] |= {"firebase-cloud-messaging", "expo-notifications", "flutter-local-notifications", "onesignal"}
CAT_TAGS["payments"] |= {"in-app-purchase", "react-native-iap", "in-app-billing", "revenuecat"}
CAT_TAGS["auth"] |= {"firebase-authentication", "google-signin", "apple-sign-in", "biometrics", "local-auth"}
CAT_TAGS["observability"] |= {"crashlytics", "firebase-crashlytics"}
CAT_TAGS["analytics"] |= {"firebase-analytics"}
CAT_TAGS["storage"] |= {"image-picker", "file-picker"}
TAG2CAT = {t: c for c, ts in CAT_TAGS.items() for t in ts}
# DBMS: engine/design questions are admitted without a framework tag, but only with a design-style title and score >= 5.
DBMS_TAGS = {"database-design", "database-schema", "time-series", "timescaledb", "influxdb", "graph-database", "neo4j",
             "sharding", "replication", "data-warehouse", "olap", "clickhouse", "cassandra", "amazon-dynamodb", "cockroachdb",
             "database-performance", "database-partitioning", "postgresql", "mysql", "mongodb", "sqlite", "redis",
             "database-replication", "multi-tenant", "event-sourcing", "nosql", "relational-database", "data-modeling"}
DBMS_TITLE = re.compile(r"\b(design|schema|model(l?ing)?|structure|best way to (store|model|design)|which (database|db)|"
                        r"choose|choosing|scal(e|ing|able)|shard|partition|replicat|time[- ]series|multi[- ]tenan|migrat|"
                        r"store .* (data|events|logs|history)|normali[sz]|graph|warehouse|analytics|audit|versioning)\b", re.I)
ASK = re.compile(r"\b(how (do|can|should|to|would)|best (way|practice|approach)|implement(ing)?|add(ing)?|set ?up|integrat(e|ing)|"
                 r"recommend(ed)?|which .*(should|to use)|what is the (best|right|recommended)|build(ing)?|design(ing)?|"
                 r"approach|strategy|architecture)\b", re.I)
BUGGY = re.compile(r"\b(error|errors|not working|doesn'?t work|does not work|undefined|cannot|can'?t|fail(s|ed|ing)?|exception|"
                   r"issue with|problem with|broken|null|crash(es)?|warning|unexpected|why (is|does|am)|solve|fix(ing)?|err\b|wrong|"
                   r"instead of|get rid|not (receiving|getting|showing|saving|sending|triggered|firing|returning|loading|updating))\b", re.I)
PRE = re.compile(r"<pre.*?</pre>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def prose(body):
    t = PRE.sub(" [code omitted] ", body or "")
    return re.sub(r"\s+", " ", html.unescape(TAG.sub(" ", t))).strip()


out = open(os.path.join(out_dir, "candidates.jsonl"), "a")
cols = ["Id", "PostTypeId", "Score", "ViewCount", "Title", "Body", "Tags", "ContentLicense", "CreationDate", "AnswerCount"]
for i in range(start, min(end, len(files))):
    path = hf_hub_download(REPO, files[i], repo_type="dataset", cache_dir=os.path.join(out_dir, "files"))
    pf = pq.ParquetFile(path)
    have = [c for c in cols if c in pf.schema_arrow.names]
    kept = qs = 0
    for b in pf.iter_batches(batch_size=20000, columns=have):
        d = b.to_pydict()
        for j in range(len(d["Id"])):
            if d["PostTypeId"][j] != 1:
                continue
            qs += 1
            title = d["Title"][j] or ""
            tags = set(d["Tags"][j] or [])
            if not ((d["Score"][j] or 0) >= 2 or (d["ViewCount"][j] or 0) >= 1000):
                continue
            stacks = [s for s, ts in STACK_TAGS.items() if tags & ts]
            if BUGGY.search(title):
                continue
            cats = sorted({TAG2CAT[t] for t in tags if t in TAG2CAT})
            if JRC_ONLY and not cats:
                cats = sorted({c for c, rx in TITLE_CATS.items() if rx.search(title)})
            dbms = bool(tags & DBMS_TAGS) and (d["Score"][j] or 0) >= 5 and bool(DBMS_TITLE.search(title))
            agents = "agents" in cats
            if dbms and "database" not in cats:
                cats = sorted(set(cats) | {"database"})
            if not stacks and (dbms or agents):
                stacks = ["any"]  # the curation agent picks the stack
            if not stacks or not cats or not (ASK.search(title) or dbms):
                continue
            if NEW_ONLY and not (dbms or agents or MOBILE & set(stacks)):
                continue
            if JRC_ONLY:
                stacks = [s for s in stacks if s in JRC]
                if not stacks or "android" in tags or any(t.startswith("android") for t in tags):
                    continue
            text = prose(d["Body"][j])
            if len(text.split()) < 25 or text.count("[code omitted]") > 3:
                continue
            h = hashlib.sha1(re.sub(r"\W+", " ", title.lower()).encode()).hexdigest()
            out.write(json.dumps({"hash": h, "source": REPO, "source_id": f"stackoverflow.com/q/{d['Id'][j]}",
                                  "license": d.get("ContentLicense", [None] * len(d["Id"]))[j] or "CC BY-SA",
                                  "score": d["Score"][j], "views": d["ViewCount"][j], "tags": sorted(tags),
                                  "stacks": stacks, "categories": cats, "dbms": dbms, "created": d.get("CreationDate", [None] * len(d["Id"]))[j],
                                  "text": f"{title}\n\n{text[:1800]}"}) + "\n")
            kept += 1
    out.flush()
    os.remove(os.path.realpath(path))
    print(f"file {i}: {qs} questions -> {kept} candidates", flush=True)
