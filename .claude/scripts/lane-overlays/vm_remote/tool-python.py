#!/usr/bin/env python3
"""One real agent turn that must RUN PYTHON in the sandbox, on the deployed app, as a signed-in person.

  MOLD_V1_SESSION_TOKEN=... python3 .claude/scripts/lane-overlays/vm_remote/tool-python.py <base_url> [--timeout 240]

Why a vm_remote application needs this and a Vercel one does not: on Vercel the sandbox is Vercel's own; on a
server it is a KVM microVM the API starts itself as a non-root user (reports/vm-spike-mold_v1-072.md). A wrong
group, a missing /dev/kvm, a template that was never prewarmed or a frozen microVM leaves chat working and every
tool call failing, and `chat.turn` (which asks for one word) cannot see that.

The agent is asked to run one python3 command that prints a marker and a product. The check passes only when a
TOOL RESULT event on the stream carries the computed line: the prompt contains the expression, never the answer,
so the model cannot satisfy it by replying. Exit 0 and `tool.python: pass`, or exit 1 and `tool.python: fail`
with the reason. Nothing is printed from the token; nothing is written anywhere.
"""
import json, os, sys, time, urllib.request, urllib.error

A, B = 7919, 6007                       # two primes; the product appears nowhere in the prompt
MARK = "SF-TOOL"
WANT = f"{MARK} {A * B}"
CMD = f"python3 -c \"import os, platform; print('{MARK}', {A}*{B}); print('uid', os.getuid(), 'kernel', platform.release())\""
PROMPT = (f"Use your bash tool to run exactly this one command in your sandbox, once, and then reply with only what it printed:\n{CMD}")

def judge(events):
    """(ok, reason, detail) from the stream's events. Pure, so the self-test can replay recorded streams."""
    types, results, answer, terminal, failed = {}, [], "", None, None
    def walk(ev):
        t = ev.get("type") or "?"; d = ev.get("data") or {}
        if t == "subagent.event" and isinstance(d.get("event"), dict): return walk(d["event"])
        return t, d
    for ev in events:
        t, d = walk(ev); types[t] = types.get(t, 0) + 1
        if t == "action.result": results.append(d)
        if t == "message.completed" and isinstance(d.get("message"), str): answer = d["message"]
        if t in ("turn.failed", "session.failed"): failed = json.dumps(d)[:300]; terminal = t; break
        if t in ("turn.completed", "session.completed", "session.waiting"): terminal = t; break
    seen = ", ".join(f"{k}x{v}" for k, v in sorted(types.items())) or "none"
    if failed: return False, f"the turn failed ({terminal}): {failed}", seen
    if not terminal: return False, f"no terminal event; events seen: {seen}", seen
    if not results: return False, ("the agent called no tool at all, so nothing shows the sandbox can run python"
                                   + (" (its reply contains the number, which it worked out by itself)" if str(A * B) in answer else "")), seen
    for d in results:
        r = d.get("result") if isinstance(d.get("result"), dict) else {}
        out = r.get("output") if isinstance(r.get("output"), str) else json.dumps(r.get("output"))
        if WANT in (out or ""):
            if r.get("isError") or d.get("status") == "failed": continue
            line = next((l for l in out.splitlines() if l.startswith("uid ")), "")
            return True, f"tool `{r.get('toolName')}` ran python3 in the sandbox and returned the computed line" + (f" ({line.strip()[:80]})" if line else ""), seen
    last = results[-1]; r = last.get("result") if isinstance(last.get("result"), dict) else {}
    err = (last.get("error") or {}).get("message") if isinstance(last.get("error"), dict) else None
    return False, ("a tool was called but no tool result carried the computed line; the last one said: "
                   + str(err or r.get("output") or last)[:300]), seen

def main(a):
    if not a or a[0].startswith("-"): sys.exit(__doc__)
    base = a[0].rstrip("/"); timeout = int(a[a.index("--timeout") + 1]) if "--timeout" in a else 240
    tok = (os.environ.get("MOLD_V1_SESSION_TOKEN") or "").strip()
    if not tok:
        print("tool.python: skipped — MOLD_V1_SESSION_TOKEN is not set; a signed-in session is needed to start a turn"); return 3
    H = {"authorization": f"Bearer {tok}", "content-type": "application/json", "user-agent": "factory-lane"}
    def fail(why): print(f"tool.python: fail — {why}"); return 1
    t0 = time.time()
    try:
        req = urllib.request.Request(f"{base}/eve/v1/session", data=json.dumps({"message": PROMPT}).encode(), headers=H, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r: started = json.loads(r.read().decode())
    except urllib.error.HTTPError as e: return fail(f"POST /eve/v1/session answered {e.code}: {e.read()[:160].decode('utf-8', 'replace')!r}")
    except Exception as e: return fail(f"POST /eve/v1/session did not answer: {e}")
    sid = started.get("sessionId")
    if not sid: return fail(f"the agent opened no session: {json.dumps(started)[:200]}")
    events = []
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
                events.append(ev)
                if (ev.get("type") or "") in ("turn.failed", "session.failed", "turn.completed", "session.completed", "session.waiting"): break
    except Exception as e:
        return fail(f"stream of session {sid[:8]}… broke after {time.time() - t0:.0f}s: {e}")
    ok, reason, seen = judge(events)
    print("| check | result | detail |"); print("|---|---|---|")
    print(f"| events | info | {seen} |")
    print(f"| python in the sandbox | {'pass' if ok else 'fail'} | {reason.replace('|', '/')} |")
    if not ok: return fail(reason)
    print(f"tool.python: pass — {reason}, in {time.time() - t0:.0f}s"); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
