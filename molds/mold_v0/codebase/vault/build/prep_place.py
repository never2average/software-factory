"""Merge both task rounds, write vendors.json for the validator, and split tasks into per-agent chunks by stack."""
import collections, glob, json, os, re
import pyarrow.parquet as pq

r1 = json.load(open("tasks.json"))
r2 = json.load(open("tasks-round2.json"))
for t in r1:  # round 1 recorded the WildChat id as conversation_hash
    s = t["source"]
    if "conversation_hash" in s:
        s["source_id"] = s.pop("conversation_hash")
seen, merged = set(), []
for t in r1 + r2:
    k = re.sub(r"\W+", " ", t["title"].lower()).strip()
    if k in seen or t["id"] in {m["id"] for m in merged}:
        continue
    seen.add(k); merged.append(t)
json.dump(merged, open("tasks-merged.json", "w"), indent=2, ensure_ascii=False)
print("merged", len(merged), collections.Counter(t["category"] for t in merged))

# Vendor terms (same construction as tasks_build.py), saved so the validator needs no pyarrow.
p = os.environ["SO_SURVEY_PARQUET"]
df = pq.read_table(p, columns=["DatabaseHaveWorkedWith", "PlatformHaveWorkedWith", "AIModelsHaveWorkedWith"]).to_pandas()
terms = set()
for col in df.columns:
    for v in df[col].dropna():
        for x in str(v).split(";"):
            for part in re.split(r"[()/]", x):
                part = part.strip()
                if len(part) >= 3 and part.lower() not in {"other", "models", "build tool", "chatbot models", "reasoning models"}:
                    terms.add(part)
terms |= set("""Stripe Paddle Braintree PayPal Auth0 Clerk Okta Cognito Keycloak NextAuth Auth.js Passport Lucia Supabase Firebase
Appwrite PocketBase Neon PlanetScale Turso Prisma Drizzle TypeORM Sequelize Mongoose SQLAlchemy Redis Valkey Memcached BullMQ
Celery Sidekiq Temporal Inngest RabbitMQ Kafka SQS Sentry Datadog Honeycomb Grafana Prometheus Rollbar Bugsnag OpenTelemetry
PostHog Mixpanel Amplitude Segment LaunchDarkly Unleash Flagsmith GrowthBook SendGrid Mailgun Postmark Resend Nodemailer SES
Twilio Vonage Pusher Ably Socket.IO Algolia Meilisearch Typesense Elasticsearch OpenSearch Pinecone Weaviate Qdrant Chroma
Milvus pgvector LangChain LlamaIndex OpenAI Anthropic Claude Gemini Cloudinary UploadThing S3 R2 Backblaze Vercel Netlify
Heroku Render Railway Fly.io Cloudflare AWS Azure GCP DigitalOcean""".split())
terms -= {"Go", "go"}
json.dump(sorted(terms), open("vendors.json", "w"))

# Chunks: one stack per chunk; big stacks split so each agent gets <= ~75 tasks.
os.makedirs("place", exist_ok=True)
by = collections.defaultdict(list)
for t in merged:
    by[t["template"]].append(t)
chunks = []
for tpl, items in sorted(by.items()):
    n = max(1, round(len(items) / 75))
    for i in range(n):
        part = items[i::n]
        name = f"place/{tpl}-{i + 1}.json"
        json.dump(part, open(name, "w"), indent=2, ensure_ascii=False)
        chunks.append((name, tpl, len(part)))
for c in chunks:
    print(c)
