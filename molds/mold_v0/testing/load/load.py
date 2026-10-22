#!/usr/bin/env python3
"""The load lane's harness for a single-service (mold_v0) application: a small, bounded, read-only load against the
DEPLOYED app, with a row per pack.

  load.py <app_id> --codebase <lane copy>     measure, print the tables, exit 0 (pass) / 1 (fail) / 2 (could not run)
  load.py <app_id> --check-addresses         the lane's precondition: both addresses proven the app's own and a
                                              lane-check connector for the MCP one (exit 0), else the reason (exit 1);
                                              nothing is sent to the app
  load.py --self-test                         offline: a fake app on 127.0.0.1, the thresholds, the address guard

WHAT IS SENT, AND WHERE. Only to the application's own two addresses, each proven its own before anything is sent:
  * its MCP connector (`single_service.mcp_address`: on Vercel the api project's `vercel.api_url`, on its own server
    `compose_remote.production_url`), with the lane-check organisation's key from the private connector file
    (`provision.py <app> --lane-key`; the file must name this exact address). Calls: `initialize`, `tools/list`, and
    `tools/call` of every tool the server marks read-only (annotations.readOnlyHint) that needs no argument. Nothing
    that changes data; the app records its usual per-call usage row for the lane organisation, as for any client.
  * its console's public pages (`/`, `/healthz`, and the pages a host pack serves signed out), with no credential.
On Vercel each address must be one Vercel says a project of THIS app serves (`vercel_addr.guard_app`: the api project
for the connector, the web project for the console); on its own server it must be the address the deploy recorded
(`https://<domain>`). Any other address, an address that is not https, or a connector file for another address: nothing
is sent and the harness exits 2. Every request is checked against those two hosts again as it is made.

HOW MUCH. A warm-up (each operation once, not counted), then up to DURATION_S seconds of CONCURRENCY workers sharing
a rate cap of RATE_PER_S requests per second and a hard cap of MAX_REQUESTS. Each request times out at TIMEOUT_S.

THRESHOLDS (per pack and overall): error rate at most MAX_ERROR_RATE (an HTTP 5xx or 429, a timeout, a refused
connection or a JSON-RPC error is an error; a tool result marked isError is the tool answering, e.g. "nothing here
yet" for the lane organisation, and is not), p50 at most P50_MS and p95 at most P95_MS.
A shared host has bad seconds: when a threshold trips, the whole measurement runs once more and the lane fails only
when the second pass trips as well (both passes are printed). Standard library only. The key never reaches stdout.
"""
import json, math, os, re, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, ".claude", "scripts", "lib"))

DURATION_S, CONCURRENCY, RATE_PER_S, MAX_REQUESTS, TIMEOUT_S = 30, 4, 6, 150, 20
MIN_SAMPLES = 40     # below this a pack row fails only on two errors or more; its p95 is shown, not judged
RATE_WINDOW_S = 61   # the app limits MCP calls per key per minute (300 by default): pass 2 waits out the window
MAX_ERROR_RATE, P50_MS, P95_MS = 0.01, 1500, 5000


# A tool result that is the shell reporting a crash, not the tool answering (src/packs.ts toToolResult on a throw).
CRASH = re.compile(r"database error [0-9A-Z]{5}|internal error|Cannot read propert|is not a function|is not defined|could not be completed", re.I)


class Refused(Exception):
    """An address this harness will not send anything to."""


# ---- where -------------------------------------------------------------------------------------------------------

def host(u): return (urllib.parse.urlsplit(u).hostname or "").lower()


def own_address(infra, url, roles, guard=None):
    """Raise Refused unless `url` is this application's own address (see the module doc)."""
    if not url: raise Refused("the app has no deployed address recorded")
    if urllib.parse.urlsplit(url).scheme != "https": raise Refused(f"{host(url) or url} is not an https address")
    t = (infra or {}).get("target")
    if t == "vercel":
        if guard is None:
            import vercel_addr
            guard = vercel_addr.guard_app
        ok, why = guard(infra, url, roles=roles)
        if not ok: raise Refused(why)
        return
    if t == "compose_remote":
        cr = infra.get("compose_remote") or {}
        if not (cr.get("domain") and url.rstrip("/") == f"https://{cr['domain']}" and infra.get("deployed_at")):
            raise Refused(f"{host(url)} is not the address this app's deploy recorded (compose_remote.production_url)")
        return
    raise Refused(f"target {t!r}: this harness grades a deployed mold_v0 app (vercel or compose_remote) only")


def targets(app_id, infra, guard=None):
    """(mcp url, console url, key): both addresses proven the app's own, the key from the private connector file."""
    import lane_url, single_service as SS
    mcp, web = SS.mcp_address(infra), lane_url.target_url(infra)
    own_address(infra, mcp, ("-api",), guard)
    own_address(infra, web, ("",), guard)
    p = SS.lane_key_path(app_id)
    if not SS.lane_key_ok(app_id, mcp):
        raise Refused(f"no lane-check connector for {host(mcp)}: python3 .claude/scripts/provision.py {app_id} --lane-key --dry-run, then --yes")
    m = re.search(r"/mcp/(oct_[\w-]+)", open(p).read())
    if not m: raise Refused("the private connector file holds no key")
    return mcp.rstrip("/") + "/mcp", web.rstrip("/"), m.group(1)


# ---- one request -------------------------------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered, never followed: following one would send the key (or a request) to wherever it points."""
    def redirect_request(self, *a, **k): return None


_OPENER = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))   # no proxy from the environment


class Client:
    def __init__(self, mcp, web, key, allowed=None):
        self.mcp, self.web, self.key = mcp, web, key
        self.allowed = allowed or {host(mcp), host(web)}
        self.ids = 0; self.lock = threading.Lock()

    def _open(self, req):
        if host(req.full_url) not in self.allowed: raise Refused(f"{host(req.full_url)} is not one of this app's addresses")
        return _OPENER.open(req, timeout=TIMEOUT_S)

    def rpc(self, method, params=None):
        """(ok, ms, detail, result)."""
        with self.lock: self.ids += 1; i = self.ids
        body = json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(self.mcp, data=body, method="POST", headers={
            "content-type": "application/json", "accept": "application/json, text/event-stream",
            "authorization": f"Bearer {self.key}", "mcp-protocol-version": "2025-06-18"})
        t = time.monotonic()
        try:
            with self._open(req) as r: text = r.read().decode("utf-8", "replace"); status = r.status
        except urllib.error.HTTPError as e: return False, (time.monotonic() - t) * 1000, f"HTTP {e.code}", None
        except Refused: raise
        except Exception as e: return False, (time.monotonic() - t) * 1000, type(e).__name__, None
        ms = (time.monotonic() - t) * 1000
        msg = None
        for line in text.splitlines() if "data:" in text else [text]:
            line = line[5:].strip() if line.startswith("data:") else line.strip()
            try: d = json.loads(line)
            except ValueError: continue
            if isinstance(d, dict) and d.get("id") == i: msg = d
        if msg is None: return False, ms, f"HTTP {status}, no JSON-RPC answer", None
        if "error" in msg: return False, ms, f"JSON-RPC error {msg['error'].get('code')}", None
        res = msg.get("result") or {}
        # A tool result marked isError is the tool answering (for the lane organisation, often "nothing here yet"): the
        # server worked, so it is not a load error. Only the transport, HTTP and JSON-RPC layers count as errors.
        if method == "tools/call" and res.get("isError"):
            text = " ".join(str(c.get("text", "")) for c in res.get("content") or [] if isinstance(c, dict))
            if CRASH.search(text): return False, ms, "tool crashed", res
            return True, ms, "isError", res
        return True, ms, "", res

    def page(self, path):
        req = urllib.request.Request(self.web + path, headers={"accept": "text/html,application/json"})
        t = time.monotonic()
        try:
            with self._open(req) as r: r.read(); return True, (time.monotonic() - t) * 1000, ""
        except urllib.error.HTTPError as e:   # 3xx (not followed) and 4xx are answers; 5xx and 429 are errors
            return e.code < 500 and e.code != 429, (time.monotonic() - t) * 1000, f"HTTP {e.code}"
        except Refused: raise
        except Exception as e: return False, (time.monotonic() - t) * 1000, type(e).__name__


# ---- the plan and the measurement ----------------------------------------------------------------------------------

def plan(client, surface):
    """Operations, each (pack, label, fn): tools/list (the shell's), every read-only argument-free tool (its pack's),
    the public pages (the shell's, or the host pack's that serves it). Also, per pack, the tools the lane copy has
    that the deployed server does not list (a redeploy is due), reported, not loaded."""
    ok, _, why, res = client.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lane-load", "version": "1"}})
    if not ok: raise RuntimeError(f"initialize failed: {why}")
    ok, _, why, res = client.rpc("tools/list")
    if not ok: raise RuntimeError(f"tools/list failed: {why}")
    tools = res.get("tools") or []
    owner = surface.get("tools") or {}
    ops = [("shell", "tools/list", lambda: client.rpc("tools/list")[:3])]
    listed = {t.get("name") for t in tools}
    for t in tools:
        ann = t.get("annotations") or {}; req = (t.get("inputSchema") or {}).get("required") or []
        if ann.get("readOnlyHint") is True and not req:
            n = t["name"]; ops.append((owner.get(n, "shell"), f"tools/call {n}", lambda n=n: client.rpc("tools/call", {"name": n, "arguments": {}})[:3]))
    pages = ["/", "/healthz"] + [p["path"] for p in surface.get("pages") or [] if not p.get("signed_in") and p["path"] != "/"]
    page_owner = {p["path"]: p["pack"] for p in surface.get("pages") or []}
    for path in dict.fromkeys(pages):
        ops.append((page_owner.get(path, "shell"), f"GET {path}", lambda path=path: client.page(path)))
    missing = {}
    for n, pk in owner.items():
        if n not in listed: missing.setdefault(pk, []).append(n)
    return ops, missing


def pct(xs, q):
    if not xs: return None
    s = sorted(xs); k = max(0, min(len(s) - 1, math.ceil(q / 100 * len(s)) - 1))   # nearest rank
    return s[k]


def measure(ops, duration=DURATION_S, workers=CONCURRENCY, rate=RATE_PER_S, cap=MAX_REQUESTS):
    """Warm up (each op once, not counted), then the bounded run. Returns {label: [(ok, ms, why)]}."""
    for _, _, fn in ops: fn()
    out = {label: [] for _, label, _ in ops}
    lock = threading.Lock(); state = {"n": 0, "next": time.monotonic()}
    stop = time.monotonic() + duration
    def worker():
        while True:
            with lock:
                if state["n"] >= cap or time.monotonic() >= stop: return
                i = state["n"]; state["n"] += 1
                wait = state["next"] - time.monotonic(); state["next"] = max(state["next"], time.monotonic()) + 1.0 / rate
            if wait > 0: time.sleep(wait)
            pack, label, fn = ops[i % len(ops)]
            r = fn()
            with lock: out[label].append(r)
    th = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
    for t in th: t.start()
    for t in th: t.join(duration + TIMEOUT_S * 2)
    return out


def judge(ops, got, missing, packs):
    """Rows per pack (and overall): requests, errors, p50, p95, status."""
    owner = {label: pack for pack, label, _ in ops}
    by = {}
    for label, rs in got.items(): by.setdefault(owner[label], []).extend(rs)
    rows = []
    order = ["shell"] + [p["id"] for p in packs] + sorted(k for k in by if k != "shell" and k not in {p["id"] for p in packs})
    for pk in dict.fromkeys(order):
        rs = by.get(pk, [])
        if not rs:
            rows.append({"pack": pk, "requests": 0, "errors": 0, "p50": None, "p95": None, "status": "not-covered",
                         "detail": "no read-only tool without arguments and no public page to load" + (f"; not on the deployed server: {', '.join(missing[pk][:5])}" if missing.get(pk) else "")})
            continue
        rows.append(row(pk, rs, missing.get(pk)))
    every = [r for rs in got.values() for r in rs]
    rows.append(row("all", every, None))
    return rows


def row(pk, rs, missing):
    ms = [r[1] for r in rs if r[0]]; errs = [r for r in rs if not r[0]]
    p50, p95 = pct(ms, 50), pct(ms, 95)
    rate = len(errs) / len(rs) if rs else 0
    bad = []
    small = pk != "all" and len(rs) < MIN_SAMPLES
    limited = sum(1 for e in errs if e[2] == "HTTP 429")
    if small:
        if len(errs) >= 2: bad.append(f"{len(errs)} errors in {len(rs)} requests ({', '.join(sorted({e[2] for e in errs}))[:80]})")
    elif rate > MAX_ERROR_RATE: bad.append(f"error rate {rate:.1%} > {MAX_ERROR_RATE:.0%} ({', '.join(sorted({e[2] for e in errs}))[:80]})")
    if p50 is not None and p50 > P50_MS: bad.append(f"p50 {p50:.0f}ms > {P50_MS}ms")
    if p95 is not None and p95 > P95_MS and not small: bad.append(f"p95 {p95:.0f}ms > {P95_MS}ms")
    if not ms: bad.append("no request succeeded")
    d = "; ".join(bad) or "within thresholds"
    if small: d += f" (only {len(rs)} requests: p95 shown, not judged; fails on 2 errors or more)"
    if limited: d += f"; {limited} answered 429, the app's own per-key limit"
    crashed = sum(1 for e in errs if e[2] == "tool crashed")
    if crashed: d += f"; {crashed} tool calls crashed"
    if missing: d += f"; not on the deployed server (redeploy due): {', '.join(missing[:5])}"
    return {"pack": pk, "requests": len(rs), "errors": len(errs), "p50": p50, "p95": p95, "status": "fail" if bad else "pass", "detail": d}


def table(rows, title, verdict=True):
    f = lambda v: "-" if v is None else f"{v:.0f}"
    # Pass 1 is not the verdict when it trips: its rows say `tripped`, so only pass 2 can print `| fail |`.
    st = lambda s: s if verdict or s != "fail" else "tripped"
    out = [f"### {title}", "", "| pack | requests | errors | p50 ms | p95 ms | status | detail |", "|---|---|---|---|---|---|---|"]
    for r in rows: out.append(f"| {r['pack']} | {r['requests']} | {r['errors']} | {f(r['p50'])} | {f(r['p95'])} | {st(r['status'])} | {r['detail'].replace('|', '/')} |")
    return "\n".join(out)


def run(client, surface, packs, say=print, **limits):
    ops, missing = plan(client, surface)
    say(f"load: {len(ops)} operations ({sum(1 for o in ops if o[1].startswith('tools/call'))} read-only tool calls), "
        f"{limits.get('duration', DURATION_S)}s, {limits.get('workers', CONCURRENCY)} workers, at most "
        f"{limits.get('rate', RATE_PER_S)}/s and {limits.get('cap', MAX_REQUESTS)} requests per pass; thresholds: errors <= "
        f"{MAX_ERROR_RATE:.0%}, p50 <= {P50_MS}ms, p95 <= {P95_MS}ms\n")
    rows = judge(ops, measure(ops, **{k: v for k, v in limits.items() if k != "window"}), missing, packs)
    tripped = any(r["status"] == "fail" for r in rows)
    say(table(rows, "pass 1: a row per pack", verdict=not tripped))
    if tripped:
        say(f"\nA threshold tripped on pass 1 (rows marked `tripped`), so the measurement runs once more after "
            f"{limits.get('window', RATE_WINDOW_S)}s (the app's per-minute limit resets); the lane fails only if pass 2 trips too.\n")
        time.sleep(limits.get("window", RATE_WINDOW_S))
        rows = judge(ops, measure(ops, **{k: v for k, v in limits.items() if k != "window"}), missing, packs)
        say(table(rows, "pass 2 (the verdict): a row per pack"))
    say(f"\nrows: {len(rows)} ({sum(1 for r in rows if r['status'] == 'fail')} failed)")
    return 1 if any(r["status"] == "fail" for r in rows) else 0


def main(a):
    if a[:1] == ["--self-test"]: return self_test()
    if not a or a[0].startswith("-") or ("--codebase" not in a and "--check-addresses" not in a): sys.exit(__doc__)
    app_id = a[0]
    adir = os.path.join(ROOT, "state", "application", app_id)
    try: infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    except (OSError, ValueError): print(f"{app_id}: no state"); return 2
    try: mcp, web, key = targets(app_id, infra)
    except Refused as e:
        print(f"load: nothing was sent. {e}"); return 1 if "--check-addresses" in a else 2
    if "--check-addresses" in a:
        print(f"load: {host(mcp)} (MCP connector) and {host(web)} (console) are {app_id}'s own; a lane-check connector exists"); return 0
    codebase = os.path.abspath(a[a.index("--codebase") + 1])
    r = subprocess.run([os.path.join(codebase, "node_modules", ".bin", "tsx"), os.path.join(ROOT, "molds", "mold_v0", "testing", "console", "surface.mts"), codebase],
                       capture_output=True, text=True, timeout=300, cwd=codebase, env={k: v for k, v in os.environ.items() if k != "DATABASE_URL"})
    if r.returncode: print(f"load: the lane copy's surface could not be read: {(r.stderr or r.stdout)[-400:]}"); return 2
    surface = json.loads(r.stdout)
    try: return run(Client(mcp, web, key), surface, surface.get("packs") or [])
    except Refused as e: print(f"load: stopped, nothing more was sent. {e}"); return 2
    except RuntimeError as e: print(f"load: the MCP server could not be measured: {e}"); return 1


# ---- self-test -----------------------------------------------------------------------------------------------------

def self_test():
    import http.server, socketserver
    checks = []
    def ok(c, what): checks.append(what); assert c, what
    state = {"fail_tool": False, "slow": 0.0, "calls": [], "auth": set()}
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            state["calls"].append(("GET", self.path)); time.sleep(state["slow"])
            if self.path == "/away": self.send_response(302); self.send_header("location", "https://example.org/steal"); self.end_headers(); return
            self.send_response(200 if self.path in ("/", "/healthz", "/early-access") else 404); self.end_headers(); self.wfile.write(b"ok")
        def do_POST(self):
            d = json.loads(self.rfile.read(int(self.headers["content-length"])))
            state["auth"].add(self.headers.get("authorization")); state["calls"].append(("POST", d["method"], (d.get("params") or {}).get("name"))); time.sleep(state["slow"])
            if d["method"] == "tools/list":
                res = {"tools": [{"name": "list_things", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object"}},
                                 {"name": "get_thing", "annotations": {"readOnlyHint": True}, "inputSchema": {"required": ["id"]}},
                                 {"name": "delete_thing", "annotations": {"readOnlyHint": False}, "inputSchema": {"type": "object"}},
                                 {"name": "pack_stats", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object"}}]}
            elif d["method"] == "tools/call" and state["fail_tool"] and d["params"]["name"] == "pack_stats" and (state["fail_tool"] is True or state.setdefault("n_once", 0) < 30) and not state.__setitem__("n_once", state.get("n_once", 0) + 1):
                body = json.dumps({"jsonrpc": "2.0", "id": d["id"], "error": {"code": -32603, "message": "Internal error"}}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body); return
            elif d["method"] == "tools/call":
                res = {"content": [{"type": "text", "text": "Nothing here yet"}], "isError": d["params"]["name"] == "list_things"}
            else: res = {"serverInfo": {"name": "fake"}}
            body = f"event: message\ndata: {json.dumps({'jsonrpc': '2.0', 'id': d['id'], 'result': res})}\n\n".encode()
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers(); self.wfile.write(body)
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    surface = {"tools": {"list_things": "shell", "pack_stats": "audit", "gone_tool": "audit", "get_thing": "shell"},
               "pages": [{"pack": "octillion", "path": "/early-access", "signed_in": False}, {"pack": "shell", "path": "/app", "signed_in": True}]}
    packs = [{"id": "octillion", "kind": "host"}, {"id": "audit", "kind": "pack"}, {"id": "empty", "kind": "pack"}]
    lim = dict(duration=1.5, workers=3, rate=40, cap=60, window=0)
    try:
        out = []
        c = Client(base + "/mcp", base, "oct_selftest_key")
        code = run(c, surface, packs, say=out.append, **lim); text = "\n".join(out)
        ok(code == 0 and "| audit |" in text and "| octillion |" in text and "| all |" in text, "a healthy app: exit 0, a row per pack and overall")
        ok("| empty | 0 | 0 | - | - | not-covered |" in text, "  ...a pack with nothing to load is not-covered, never pass")
        ok("redeploy due): gone_tool" in text, "  ...a lane-copy tool the deployed server does not list is named on its pack's row")
        ok(("GET", "/app") not in state["calls"] and ("GET", "/early-access") in state["calls"], "  ...signed-in pages are never loaded; a host pack's public page is")
        tools_called = {x[2] for x in state["calls"] if x[:2] == ("POST", "tools/call")}
        ok(tools_called == {"list_things", "pack_stats"}, "  ...only read-only, argument-free tools are called (never delete_thing, never get_thing without its id)")
        n = sum(1 for x in state["calls"] if x[1] != "initialize")
        ok(n <= lim["cap"] + 10, f"  ...the request cap holds ({n} requests for a cap of {lim['cap']} plus the warm-up)")
        ok("oct_selftest_key" not in text and state["auth"] == {"Bearer oct_selftest_key"}, "  ...the key goes in the header only, never into the output")
        state["fail_tool"] = True; state["calls"].clear(); out.clear()
        code = run(c, surface, packs, say=out.append, **lim); text = "\n".join(out)
        ok(code == 1 and "pass 2 (the verdict)" in text and re.search(r"\| audit \|[^\n]*\| fail \|", text.split("pass 2 (the verdict)")[1])
           and re.search(r"\| octillion \|[^\n]*\| pass \|", text.split("pass 2 (the verdict)")[1]), "a pack whose tool errors: its own row fails on both passes, the other packs pass")
        state["fail_tool"] = "once"; state["calls"].clear(); out.clear()
        code = run(c, surface, packs, say=out.append, **lim); text = "\n".join(out)
        ok(code == 0 and "| tripped |" in text and "| fail |" not in text and "rows: " in text and "(0 failed)" in text,
           "a pass 1 that trips and a pass 2 that holds: exit 0, pass 1's rows say `tripped`, so the lane's `| fail |` rule cannot fail it")
        state["fail_tool"] = False; state["slow"] = 0.0
        flip = {"n": 0}
        def flaky(): flip["n"] += 1; return (flip["n"] > 5, 10.0, "" if flip["n"] > 5 else "HTTP 502")
        ops = [("shell", "flaky", flaky)]
        rows1 = judge(ops, measure(ops, duration=0.5, workers=1, rate=50, cap=10), {}, [])
        ok(any(r["status"] == "fail" for r in rows1), "a burst of 5xx trips the error-rate threshold")
        ok(pct([1, 2, 3, 4, 100], 50) == 3 and pct([float(i) for i in range(1, 101)], 95) == 95, "percentiles: nearest rank")
        r = c.page("/away")
        ok(r[0] and r[2] == "HTTP 302", "a redirect is answered, never followed (nothing goes to the address it names)")
        try: c2 = Client(base + "/mcp", base, "k", allowed={"example.org"}); c2.page("/"); ok(False, "x")
        except Refused: ok(True, "a request to a host outside the app's two addresses is refused before it is sent")
    finally:
        srv.shutdown()
    # the address guard
    def refused(infra, url, roles, guard=None):
        try: own_address(infra, url, roles, guard); return False
        except Refused: return True
    cr = {"target": "compose_remote", "deployed_at": "2026-10-20", "compose_remote": {"domain": "a.example.org", "production_url": "https://a.example.org"}}
    ok(not refused(cr, "https://a.example.org", ("",)) and refused(cr, "https://b.example.org", ("",)) and refused(dict(cr, deployed_at=None), "https://a.example.org", ("",)),
       "compose_remote: only the address the deploy recorded")
    ok(refused(cr, "http://a.example.org", ("",)), "  ...and only over https")
    v = {"target": "vercel", "vercel": {"project": "octillion", "team": "t"}}
    seen = []
    def guard(infra, url, roles=None): seen.append((host(url), roles)); return (host(url) == "octillion-api.vercel.app" and roles == ("-api",)), "not ours"
    ok(not refused(v, "https://octillion-api.vercel.app", ("-api",), guard) and refused(v, "https://octillion-api.vercel.app", ("",), guard)
       and refused(v, "https://someone-else.vercel.app", ("-api",), guard), "vercel: an address only when Vercel says this app's own project serves it (the api project for the connector)")
    ok(refused({"target": "vm"}, "https://x.example.org", ("",)), "any other target: refused")
    print(f"load: {len(checks)} checks passed (rows per pack, thresholds and the second pass, read-only calls, the request cap, the key kept out of output, the address guard)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
