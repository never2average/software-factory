"""Tiny OpenAI chat helper for the vault build: JSON replies, retries, a disk cache and a hard spend cap."""
import hashlib, json, os, threading, time, urllib.request, urllib.error

PRICES = {"gpt-6.1-sol": (2.00, 10.00)}  # the only model the vault build uses  # $/MTok in, out (schema.sql, 2026-10-10)
BUDGET_USD = float(os.environ.get("VAULT_BUILD_BUDGET", "15"))
WORK = os.environ.get("VAULT_BUILD_WORK", ".")
STATE = os.path.join(WORK, "spend.json")
CACHE = os.path.join(WORK, "llm-cache.jsonl")
_lock = threading.Lock()


def _key():
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    raise SystemExit("Set OPENAI_API_KEY")


KEY = _key()
_spend = json.load(open(STATE)) if os.path.exists(STATE) else {"usd": 0.0, "calls": 0, "in": 0, "out": 0}
_cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        try:
            d = json.loads(line); _cache[d["k"]] = d["v"]
        except Exception:
            pass


def spent():
    return dict(_spend)


def chat_json(model, system, user, max_tokens=800):
    k = hashlib.sha256(json.dumps([model, system, user]).encode()).hexdigest()
    if k in _cache:
        return _cache[k]
    with _lock:
        if _spend["usd"] >= BUDGET_USD:
            raise RuntimeError(f"budget ${BUDGET_USD} reached")
    body = {"model": model, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    body["max_completion_tokens"] = max_tokens
    for attempt in range(6):
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                resp = json.load(r)
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 502, 503, 504) and attempt < 5:
                time.sleep(2 ** attempt); continue
            raise RuntimeError(f"OpenAI {e.code}: {msg}")
        except (urllib.error.URLError, TimeoutError):
            if attempt < 5:
                time.sleep(2 ** attempt); continue
            raise
    u = resp.get("usage", {})
    pin, pout = PRICES[model]
    cost = (u.get("prompt_tokens", 0) * pin + u.get("completion_tokens", 0) * pout) / 1e6
    text = resp["choices"][0]["message"]["content"] or "{}"
    try:
        v = json.loads(text)
    except json.JSONDecodeError:
        v = {"_unparsed": text[:500]}
    with _lock:
        _spend["usd"] += cost; _spend["calls"] += 1
        _spend["in"] += u.get("prompt_tokens", 0); _spend["out"] += u.get("completion_tokens", 0)
        json.dump(_spend, open(STATE, "w"))
        _cache[k] = v
        with open(CACHE, "a") as f:
            f.write(json.dumps({"k": k, "v": v}) + "\n")
    return v
