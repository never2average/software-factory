#!/usr/bin/env python3
"""One real chat turn on the DEPLOYED app, as a signed-in person: does the configured model answer?

  MOLD_V1_SESSION_TOKEN=... python3 molds/mold_v1/testing/functional/chat-turn.py <base_url> [--timeout 180]

Exit 0 and `chat.turn: pass` when the agent opens a session, streams a turn and ends it with a non-empty
assistant message; exit 1 and `chat.turn: fail` with the reason otherwise. The message asks for one word so
the turn is cheap and the answer is checkable; the session is the app's own (POST /eve/v1/session, the same
call the browser and lib/workflow-delegate.ts make, through the web project's same-origin rewrite), so what
is measured is the product's model wiring: MODEL_PROVIDER, the provider credential, the api project's env.
Every event type seen on the stream is printed so a run also says whether the model streamed reasoning.
Nothing is printed from the token; nothing is written anywhere.
"""
import json, os, sys, time, urllib.request, urllib.error

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else sys.exit(__doc__)
timeout = int(sys.argv[sys.argv.index("--timeout") + 1]) if "--timeout" in sys.argv else 180
tok = (os.environ.get("MOLD_V1_SESSION_TOKEN") or "").strip()
if not tok:
    print("chat.turn: skipped — MOLD_V1_SESSION_TOKEN is not set; a signed-in session is needed to start a turn"); sys.exit(3)
H = {"authorization": f"Bearer {tok}", "content-type": "application/json", "user-agent": "factory-lane"}
PROMPT = "Reply with exactly one word: PONG. No punctuation, no explanation."

def fail(why): print(f"chat.turn: fail — {why}"); sys.exit(1)

t0 = time.time()
try:
    req = urllib.request.Request(f"{base}/eve/v1/session", data=json.dumps({"message": PROMPT}).encode(), headers=H, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r: started = json.loads(r.read().decode())
except urllib.error.HTTPError as e:
    fail(f"POST /eve/v1/session answered {e.code}: {e.read()[:160].decode('utf-8', 'replace')!r}")
except Exception as e:
    fail(f"POST /eve/v1/session did not answer: {e}")
sid = started.get("sessionId")
if not sid: fail(f"the agent opened no session: {json.dumps(started)[:200]}")

answer, types, terminal, failed = "", {}, None, None
try:
    req = urllib.request.Request(f"{base}/eve/v1/session/{sid}/stream", headers=H)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        deadline = time.time() + timeout
        for raw in r:
            if time.time() > deadline: break
            line = raw.decode("utf-8", "replace").strip()
            if not line: continue
            try: ev = json.loads(line)
            except ValueError: continue
            t = ev.get("type") or "?"; types[t] = types.get(t, 0) + 1
            d = ev.get("data") or {}
            if t == "message.completed" and isinstance(d.get("message"), str): answer = d["message"]
            if t in ("turn.failed", "session.failed"): failed = json.dumps(d)[:300]; terminal = t; break
            if t in ("turn.completed", "session.completed", "session.waiting"): terminal = t; break
except Exception as e:
    fail(f"stream of session {sid[:8]}… broke after {time.time() - t0:.0f}s: {e}; events seen: {types}")

elapsed = time.time() - t0
reasoning = [t for t in types if any(k in t.lower() for k in ("reason", "think"))]
print("| check | result | detail |"); print("|---|---|---|")
print(f"| events | info | {', '.join(f'{k}×{v}' for k, v in sorted(types.items()))} |")
print(f"| reasoning streamed | {'yes' if reasoning else 'no'} | {', '.join(reasoning) or 'no reasoning/thinking event type on this turn'} |")
if failed: fail(f"the turn failed ({terminal}) after {elapsed:.0f}s: {failed}")
if not terminal: fail(f"no terminal event within {timeout}s; events seen: {types}")
if not answer.strip(): fail(f"the turn ended ({terminal}) after {elapsed:.0f}s with no assistant message; events seen: {types}")
print(f"| answer | pass | {answer.strip()[:80]!r} in {elapsed:.0f}s ({terminal}) |")
# The app keeps its own ledger of every turn (chat_turn_usage, filled by agent/hooks/chat-usage.ts, read through
# GET /api/ops/usage). A turn that answered but left no row is a turn nobody can bill, so it fails here.
# The hook writes after the stream ends, so the ledger is polled for a few seconds.
ledger = None
for _ in range(10):
    try:
        req = urllib.request.Request(f"{base}/api/ops/usage?days=1", headers=H)
        with urllib.request.urlopen(req, timeout=30) as r: ledger = json.loads(r.read().decode())
        if (ledger.get("totals") or {}).get("steps", 0) >= 1: break
    except Exception as e: ledger = {"error": str(e)}
    time.sleep(2)
tot = (ledger or {}).get("totals") or {}
if not tot.get("steps"): fail(f"the turn answered but the app's usage ledger shows no step for today: {json.dumps(ledger)[:200]}")
print(f"| usage ledger | pass | today: {tot.get('turns')} turn(s), {tot.get('steps')} step(s), {tot.get('input_tokens')} in / {tot.get('output_tokens')} out, est ${tot.get('est_cost_usd')} |")
print(f"chat.turn: pass — one turn answered in {elapsed:.0f}s and the app's ledger recorded it; reasoning events: {'yes' if reasoning else 'none seen'}")
