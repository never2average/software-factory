import os
"""Stages 2-3: classify WildChat candidates (gpt-6.1-sol, batched), rewrite the keepers blind (gpt-6.1-sol), vendor-check them.
  python tasks_build.py CANDIDATES.jsonl OUT.json [max_rewrites]
Every LLM reply is cached, so re-running after more candidates arrive only pays for the new ones.
"""
import glob, json, re, sys, collections
from concurrent.futures import ThreadPoolExecutor
import pyarrow.parquet as pq
import llm

cand_path, out_path = sys.argv[1], sys.argv[2]
max_rewrites = int(sys.argv[3]) if len(sys.argv) > 3 else 100000
cands = [json.loads(l) for l in open(cand_path)]
CATS = ["auth", "database", "background-jobs", "caching", "deployment", "observability", "payments", "email", "messaging",
        "search", "ai", "storage", "feature-flags", "analytics", "other"]
TEMPLATES = ["express-ts", "nextjs-ts", "node-ts", "fastapi", "django", "go-http"]

CLASSIFY = f"""You label real user messages sent to an AI assistant. Decide if the message is a software developer asking for
help building or changing a real application, where doing the work naturally involves CHOOSING a third-party library,
framework add-on, managed service or infrastructure component (for example an auth provider, a database, a job queue, an
email API, a payments provider, a search engine, error monitoring, file storage, hosting), and several reasonable options exist.
Not acceptable: essays, marketing/SEO copy, homework/theory questions, pure algorithm exercises, code dumps asking to fix a
syntax error, tasks fully solved by the standard library, non-software topics, roleplay.
Return JSON: {{"dev_request": bool, "tool_choice": bool, "category": one of {CATS}, "vendors_named": [names of specific
products/vendors/libraries mentioned], "personal_info": bool (names, emails, student ids, phone numbers, addresses, secrets),
"quality": 1-5 (5 = clear, realistic, specific developer task)}}"""

REWRITE = f"""You turn a real developer request into a task for a blind benchmark of AI coding agents. The agent works inside
a small existing starter project and must choose tools on its own.
Rules:
- Keep the developer's real underlying need, domain and constraints; make it concrete and realistic. First person, like a chat
  message or ticket to a coding agent: "In this <service/app>, ...". 60-900 characters.
- NEVER name any vendor, hosted service, database product, cloud, SaaS, or third-party package/library (no "Stripe", "Redis",
  "Postgres", "Auth0", "S3", "Firebase", "Celery", "Prisma", "Sentry", "OpenAI", ...). Describe needs generically ("a payment
  provider", "a relational database", "a background job queue"). Languages and the starter's own framework are fine.
- Remove all personal data. Don't invent vendor preferences.
- Pick the starter template that fits best: {TEMPLATES} (express-ts = TypeScript Express API, nextjs-ts = Next.js app,
  node-ts = plain TypeScript package/CLI, fastapi / django = Python, go-http = Go net/http service).
Return JSON: {{"title": short imperative title, "prompt", "template", "language" (TypeScript|Python|Go), "category": one of
{CATS}, "tags": 2-5 lowercase tags (generic, no vendor names), "acceptable": bool (false if it cannot become a realistic
tool-choice task)}}"""

# Vendor list: survey answer options (databases, platforms, AI, collaboration) + well-known dev-tool vendors and packages.
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
terms |= set("""Stripe Paddle Braintree PayPal Lemon Squeezy Auth0 Clerk Okta Cognito Keycloak NextAuth Auth.js Passport Lucia
Supabase Firebase Appwrite PocketBase Neon PlanetScale Turso CockroachDB Prisma Drizzle TypeORM Sequelize Mongoose SQLAlchemy
Redis Valkey Memcached BullMQ Bull Celery RQ Sidekiq Temporal Inngest Trigger.dev RabbitMQ Kafka SQS Kinesis Pub/Sub
Sentry Datadog New Relic Honeycomb Grafana Prometheus Logtail Better Stack Rollbar Bugsnag OpenTelemetry PostHog Mixpanel Amplitude
Segment LaunchDarkly Unleash Flagsmith GrowthBook SendGrid Mailgun Postmark Resend Nodemailer SES Twilio Vonage Pusher Ably Socket.IO
Algolia Meilisearch Typesense Elasticsearch OpenSearch Pinecone Weaviate Qdrant Chroma Milvus pgvector LangChain LlamaIndex OpenAI
Anthropic Claude Gemini Cloudinary UploadThing S3 R2 Backblaze Vercel Netlify Heroku Render Railway Fly.io Cloudflare AWS Azure GCP
Google Cloud DigitalOcean Docker Hub GitHub Actions CircleCI Uploadcare Mux Mapbox""".split())
terms -= {"Go", "go"}
vendor_re = re.compile(r"(?<![\w.])(" + "|".join(sorted((re.escape(t) for t in terms), key=len, reverse=True)) + r")(?![\w])", re.I)


BATCH = 20


def classify_batch(batch):
    """gpt-6.1-sol labels BATCH candidates per call; the instructions are paid once per batch."""
    items = "\n\n".join(f"<message id=\"{i}\">\n{c['text'][:2000]}\n</message>" for i, c in enumerate(batch))
    user = (f"Label each of these {len(batch)} messages independently. Return JSON {{\"labels\": [one object per message, "
            f"in order, each with \"id\" plus the fields above]}}.\n\n{items}")
    try:
        r = llm.chat_json("gpt-6.1-sol", CLASSIFY, user, 160 * len(batch) + 200)
        by_id = {int(l.get("id")): l for l in r.get("labels", []) if str(l.get("id", "")).isdigit()}
    except Exception as e:
        by_id = {}
    return [(c, by_id.get(i, {"error": "unlabeled"})) for i, c in enumerate(batch)]


batches = [cands[i:i + BATCH] for i in range(0, len(cands), BATCH)]
with ThreadPoolExecutor(8) as ex:
    labeled = [x for b in ex.map(classify_batch, batches) for x in b]
keep = [(c, l) for c, l in labeled if l.get("dev_request") and l.get("tool_choice") and not l.get("personal_info")
        and int(l.get("quality") or 0) >= 4 and l.get("category") != "other"]
print(f"classified {len(labeled)}; kept {len(keep)}; by category {collections.Counter(l['category'] for _, l in keep)}; spend {llm.spent()['usd']:.2f}", flush=True)
# Balance: at most max_rewrites per category, spread across the whole candidate set (not just the first shards).
by_cat = collections.defaultdict(list)
for item in keep:
    by_cat[item[1]["category"]].append(item)
keep = []
for cat, items in by_cat.items():
    step = max(1, len(items) / max_rewrites)
    keep += [items[int(i * step)] for i in range(min(max_rewrites, len(items)))]


def rewrite(item):
    c, l = item
    for attempt in range(2):
        extra = "" if attempt == 0 else "\nYour previous version named a vendor/package. Rewrite without any."
        try:
            r = llm.chat_json("gpt-6.1-sol", REWRITE, f"Category hint: {l['category']}\nOriginal request:\n{c['text'][:3000]}{extra}", 900)
        except Exception as e:
            return None
        if not r.get("acceptable") or not r.get("prompt") or r.get("template") not in TEMPLATES:
            return None
        if vendor_re.search(r["prompt"] + " " + r.get("title", "") + " " + " ".join(r.get("tags") or [])):
            continue
        if not (60 <= len(r["prompt"]) <= 1200):
            return None
        so = c.get("source") == "pacovaldez/stackoverflow-questions"
        # WildChat ids keep their historical form (conversation hash prefix); others use the candidate's content hash.
        tid = f"so-{c['hash'][:12]}" if so else f"wc-{c['source_id'][:12]}"
        return {"id": tid, "title": r["title"], "prompt": r["prompt"], "language": r.get("language"),
                "category": r.get("category") or l["category"], "tags": r.get("tags") or [], "template": r["template"],
                "source": {"dataset": c.get("source", "allenai/WildChat-4.8M"), "source_id": c["source_id"],
                           "license": c.get("license", "ODC-BY-1.0"),
                           "original_vendors_named": l.get("vendors_named") or [], "rewritten_by": "gpt-6.1-sol"}}
    return None


with ThreadPoolExecutor(8) as ex:
    tasks = [t for t in ex.map(rewrite, keep) if t]
# Exact-ish dedupe on normalized titles.
seen, out = set(), []
for t in tasks:
    k = re.sub(r"\W+", " ", t["title"].lower()).strip()
    if k not in seen:
        seen.add(k); out.append(t)
json.dump(out, open(out_path, "w"), indent=2, ensure_ascii=False)
print(f"wrote {len(out)} tasks; by category {collections.Counter(t['category'] for t in out)}; "
      f"by template {collections.Counter(t['template'] for t in out)}; spend {llm.spent()}")
