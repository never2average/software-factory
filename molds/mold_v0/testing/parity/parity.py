#!/usr/bin/env python3
"""Parity: does a build still show people, AI clients and the console the same thing? (mold_v0-136)

  parity.py snapshot <app_id|zero> --out DIR [--codebase DIR] [--no-copy] [--no-shots] [--no-smoke] [--only mcp,generated,api,pages]
                    [--context-fixture [--memory-search TOOL]]
      A snapshot of one build (snapshot.mts, in the lane world of testing/console/: an embedded throwaway database, the
      offline Clerk, the console built from the copy and served on 127.0.0.1; nothing deployed is contacted).
        zero      the mold's own codebase, with no pack
        <app_id>  the app's lane copy build/<app_id>.lane/ (mold + the app's packs, unbranded), rebuilt first with
                  `packs.py lane-copy <app_id>` unless --no-copy; --codebase names any other copy
      Then each pack's own end-to-end check, when the copy has one (packs/<pack>/scripts/smoke.ts: Octillion's), on its
      own embedded database, with APP_PROXY_HOPS=1 as deployed (SMOKE_ENV below): smoke.json records pass or fail (its
      output is smoke-<pack>.log, not compared).
  parity.py diff BEFORE AFTER [--allow allow.json] [--pixel-threshold 0.001] [--max-lines 40] [--json]
      diff.mts: what differs, grouped; exit 1 when anything differs outside the allow list.
  parity.py probe <app_id>... [--out FILE]
      The live, read-only probe of a deployed app (addresses from state/application/<app_id>/infrastructure.json:
      production_url, api_url): GET /, /early-access, /request-access and /healthz (status and hashes of the body and of
      its visible text, both masked), /app and /admin (status and where they send a person, never followed), the OAuth
      protected-resource metadata and an MCP initialize without a key on /mcp (status and what the server asks for).
      tools/list and prompts/list need an account's key (the pack's scripts/mcp-check.ts reads one from the environment):
      no key is used here, so they are listed as skipped unless the server answers them without one. Never a write, a
      run or a sign-in.
  parity.py --self-test
      diff.mts's tests (diff.test.mts) and the probe's own parsers, offline.

Time: a full snapshot (MCP, generated files, API, every page with four screenshots) takes the console's build (once per
copy, reused while it is unchanged; render.py) and then about 10 to 20 minutes for 35 to 60 pages on the factory VM.
Heavy: run it through the machine's heavy-step queue when there is one. Standard library only.
"""
import hashlib, html, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TESTING = os.path.dirname(HERE)
MOLD = os.path.dirname(TESTING)
ROOT = os.path.abspath(os.path.join(MOLD, "..", ".."))
CODEBASE = os.path.join(MOLD, "codebase")
KEEP_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "USER")
SMOKE_S = 1200
WORLD_S = 5400   # the lane world's deadline for one snapshot: four shots of each of 60 pages fit with room to spare
# A pack's smoke test runs as the deploy configures the API (mold.json: APP_PROXY_HOPS 1 on Vercel and behind a server's
# Caddy). Octillion's sends X-Forwarded-For to play distinct callers; with no proxy trusted every request is 127.0.0.1
# and the per-address access-request limit answers 429 (measured 2026-10-24 on main: exit 1 without it, exit 0 with it).
SMOKE_ENV = {"APP_PROXY_HOPS": "1"}


def die(msg, code=2):
    print(f"parity: {msg}", file=sys.stderr); sys.exit(code)


def opt(a, k, default=None):
    return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else default


def tsx(codebase):
    t = os.path.join(codebase, "node_modules", ".bin", "tsx")
    if not os.path.exists(t): die(f"{codebase} has no node_modules/.bin/tsx: install the codebase's dependencies (npm --prefix molds/mold_v0/codebase ci).")
    return t


# ---------- snapshot ----------

def snapshot(a):
    if not a or a[0].startswith("--"): die("usage: parity.py snapshot <app_id|zero> --out DIR [--codebase DIR] [--no-copy] [--no-shots] [--no-smoke] [--only ...] [--context-fixture [--memory-search TOOL]]")
    target, out = a[0], opt(a, "--out")
    if not out: die("--out DIR is required")
    out = os.path.abspath(out)
    if os.path.exists(out) and os.listdir(out): die(f"{out} is not empty: a snapshot is written into an empty folder, so nothing of an older one is compared.")
    t0 = time.time()
    if opt(a, "--codebase"): codebase = os.path.abspath(opt(a, "--codebase"))
    elif target == "zero": codebase = CODEBASE
    else:
        codebase = os.path.join(ROOT, "build", f"{target}.lane")
        if "--no-copy" not in a:
            r = subprocess.run([sys.executable, os.path.join(ROOT, ".claude", "scripts", "packs.py"), "lane-copy", target], capture_output=True, text=True)
            if r.returncode: die(f"the lane copy of {target} could not be built: {(r.stdout + r.stderr).strip()[-600:]}", 1)
    if not os.path.isdir(codebase): die(f"no copy at {codebase}")
    console_id = "parity-zero" if target == "zero" else target
    args = ["--out", out] + (["--no-shots"] if "--no-shots" in a else []) + (["--only", opt(a, "--only")] if opt(a, "--only") else []) \
        + (["--context-fixture"] if "--context-fixture" in a else []) + (["--memory-search", opt(a, "--memory-search")] if opt(a, "--memory-search") else [])
    cmd = [sys.executable, os.path.join(TESTING, "console", "render.py"), console_id, "--codebase", codebase, "--deadline", str(WORLD_S),
           "--", os.path.join(HERE, "snapshot.mts"), *args]
    print(f"parity: snapshot of {os.path.relpath(codebase, ROOT)} into {out}", flush=True)
    t1 = time.time()
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode: die(f"the snapshot did not complete (exit {r.returncode}); {out} is partial and must not be compared", 1)
    t2 = time.time()
    smoke = {} if "--no-smoke" in a or (opt(a, "--only") and "smoke" not in opt(a, "--only")) else run_smokes(codebase, out)
    t3 = time.time()
    meta_p = os.path.join(out, "meta.json")
    meta = json.load(open(meta_p))
    meta["seconds"].update({"world_and_console": round(t2 - t1, 1), "smoke": round(t3 - t2, 1), "total": round(t3 - t0, 1)})
    meta["smoke"] = sorted(smoke)
    if RETRIED: meta["smoke_retried_after_exit"] = RETRIED   # run facts, not compared (diff.mts reads only packs)
    with open(meta_p, "w") as fh: fh.write(json.dumps(meta, indent=2, sort_keys=True) + "\n")
    print(f"parity: snapshot done in {t3 - t0:.0f}s ({', '.join(f'{k} {v}s' for k, v in sorted(meta['seconds'].items()))})")
    return 0


RETRIED = {}


def smoke_once(codebase, f, p):
    tmp = tempfile.mkdtemp(prefix=f"parity-smoke-{p}-")
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV}
    env.update(SMOKE_ENV, PGLITE_DIR=os.path.join(tmp, "pglite"), TMPDIR=tmp)
    try:
        r = subprocess.run([tsx(codebase), f], cwd=codebase, env=env, capture_output=True, text=True, errors="replace", timeout=SMOKE_S)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        dec = lambda b: b.decode(errors="replace") if isinstance(b, bytes) else (b or "")
        return 124, f"{dec(e.stdout)}{dec(e.stderr)}\n(stopped after {SMOKE_S}s)"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_smokes(codebase, out):
    """Each pack's own scripts/smoke.ts in the copy, on an embedded database of its own, with an allow-listed environment."""
    res = {}
    codebase = os.path.abspath(codebase)
    packs = os.path.join(codebase, "packs")
    for p in sorted(os.listdir(packs)) if os.path.isdir(packs) else []:
        f = os.path.join(packs, p, "scripts", "smoke.ts")
        if not os.path.isfile(f): continue
        t = time.time()
        code, log = smoke_once(codebase, f, p)
        retried = None
        if code >= 128 and code != 124:
            # The runtime itself died (a signal; seen: exit 133, a V8 fatal error in the embedded database's WebAssembly on a
            # busy 8 GB machine), not an assertion of the test: run it once more on a fresh database and log both.
            retried = code
            code, again = smoke_once(codebase, f, p)
            log = f"{log}\n\n---------- the run above ended with exit {retried} (the runtime, not an assertion); run again ----------\n\n{again}"
        with open(os.path.join(out, f"smoke-{p}.log"), "w") as fh: fh.write(log)
        res[p] = {"pass": code == 0, "exit": code, "env": SMOKE_ENV}
        if retried: RETRIED[p] = retried
        print(f"parity: {p}'s scripts/smoke.ts {'passed' if code == 0 else f'FAILED (exit {code}; smoke-{p}.log)'} in {time.time() - t:.0f}s", flush=True)
    if res:
        with open(os.path.join(out, "smoke.json"), "w") as fh: fh.write(json.dumps(res, indent=2, sort_keys=True) + "\n")
    return res


# ---------- diff ----------

def diff(a):
    if len([x for x in a if not x.startswith("--")]) < 2: die("usage: parity.py diff BEFORE AFTER [--allow allow.json] [--pixel-threshold 0.001] [--json]")
    return subprocess.run([tsx(CODEBASE), os.path.join(HERE, "diff.mts"), *a]).returncode


# ---------- live probe (read-only) ----------

MASKS = [   # the same idea as mask.mts, for what a deployed page carries that changes between two reads of one deploy
    (re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"), "<date>"),
    (re.compile(r'\bnonce="[^"]*"'), 'nonce="<nonce>"'),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<uuid>"),
    (re.compile(r"\b(?:iad|sfo|bom|fra|cdg|lhr|sin|hnd|syd|gru|cle|pdx|dub|arn|icn|kix|hkg|cpt)1::[a-z0-9:-]+\b"), "<vercel-id>"),
]
PAGES = ("/", "/early-access", "/request-access", "/healthz")
GATED = ("/app", "/admin")
UA = "parity-probe/1 (read-only; molds/mold_v0/testing/parity)"


def mask(s):
    for r, to in MASKS: s = r.sub(to, s)
    return s


def visible_text(body):
    """The words a person reads: scripts, styles and tags out, entities decoded, whitespace collapsed."""
    b = re.sub(r"(?is)<(script|style|noscript|template)\b.*?</\1>", " ", body)
    b = re.sub(r"(?s)<!--.*?-->", " ", b)
    b = re.sub(r"(?s)<[^>]+>", " ", b)
    return re.sub(r"\s+", " ", html.unescape(b)).strip()


def title_of(body):
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", body)
    return html.unescape(m.group(1)).strip() if m else None


def sha(s): return hashlib.sha256(s.encode()).hexdigest()[:16]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def fetch(url, method="GET", body=None, headers=None, follow=True, timeout=20):
    h = {"User-Agent": UA, **(headers or {})}
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace"), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read().decode("utf-8", "replace") if e.fp else "", url
    except Exception as e:   # noqa: BLE001 (a probe reports what it saw, including nothing)
        return 0, {}, f"{type(e).__name__}: {e}", url


def page_facts(base, path):
    status, h, body, final = fetch(base + path)
    ctype = (h.get("content-type") or "").split(";")[0]
    text = visible_text(body) if "html" in ctype else body.strip()
    return {"status": status, "type": ctype, "final": final.replace(base, "") or "/", "title": title_of(body) if "html" in ctype else None,
            "body_sha": sha(mask(body)), "text_sha": sha(mask(text)), "text_chars": len(text), "text_start": mask(text)[:160]}


def gated_facts(base, path):
    status, h, _, _ = fetch(base + path, follow=False)
    loc = h.get("location")
    return {"status": status, "location": mask(re.sub(r"([?&](?:redirect_url|__clerk[^=]*|state|nonce)=)[^&]*", r"\1<v>", loc)) if loc else None}


def sse_json(body):
    """The JSON-RPC message of an MCP answer: plain JSON, or the data line of a text/event-stream."""
    try: return json.loads(body)
    except ValueError: pass
    for line in body.splitlines():
        if line.startswith("data:"):
            try: return json.loads(line[5:].strip())
            except ValueError: continue
    return None


def mcp_facts(base):
    """An MCP initialize without a key; tools/list and prompts/list only when the server answers them without one."""
    hdr = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "parity-probe", "version": "1"}}}
    status, h, body, _ = fetch(base + "/mcp", "POST", json.dumps(init).encode(), hdr)
    www = h.get("www-authenticate")
    out = {"initialize": {"status": status, "www_authenticate": mask(www) if www else None}}
    msg = sse_json(body) if status == 200 else None
    if msg and "result" in msg:
        r = msg["result"]
        out["initialize"].update(server=r.get("serverInfo"), instructions_sha=sha(mask(r.get("instructions") or "")))
        sid = h.get("mcp-session-id")
        extra = {**hdr, **({"Mcp-Session-Id": sid} if sid else {})}
        for i, m in enumerate(("tools/list", "prompts/list"), 2):
            s2, _, b2, _ = fetch(base + "/mcp", "POST", json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": {}}).encode(), extra)
            j = sse_json(b2) or {}
            items = (j.get("result") or {}).get("tools" if m == "tools/list" else "prompts")
            out[m] = {"status": s2, "count": len(items), "names": sorted(x.get("name") for x in items), "sha": sha(json.dumps(items, sort_keys=True))} if items is not None else {"status": s2, "skipped": "no answer without a key"}
    else:
        for m in ("tools/list", "prompts/list"):
            out[m] = {"skipped": "needs an account's key (the server refused initialize without one); none is used by this probe"}
    for p in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
        s, _, b, _ = fetch(base + p)
        out[f"protected_resource{p[len('/.well-known/oauth-protected-resource'):] or ''}"] = {"status": s, "sha": sha(mask(b)) if s == 200 else None, "body": (sse_json(b) if s == 200 else None)}
    return out


def targets_of(app_id):
    f = os.path.join(ROOT, "state", "application", app_id, "infrastructure.json")
    if not os.path.exists(f): die(f"no state/application/{app_id}/infrastructure.json: the probe reads the app's addresses from there")
    d = json.load(open(f))
    v = d.get("vercel") or {}
    web = v.get("production_url") or d.get("production_url") or (f"https://{d['server']['domain']}" if (d.get("server") or {}).get("domain") else None)
    api = v.get("api_url") or d.get("api_url")
    return [(r, u.rstrip("/")) for r, u in (("web", web), ("api", api)) if u]


def probe(a):
    apps = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] != "--out")]
    if not apps: die("usage: parity.py probe <app_id>... [--out FILE]")
    report = {"probed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "read_only": True, "apps": {}}
    for app in apps:
        rows = {}
        for role, base in targets_of(app):
            rows[base] = {"role": role, "pages": {p: page_facts(base, p) for p in PAGES}, "gated": {p: gated_facts(base, p) for p in GATED}, "mcp": mcp_facts(base)}
        report["apps"][app] = rows
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if opt(a, "--out"):
        with open(opt(a, "--out"), "w") as fh: fh.write(text)
        print(f"parity: probe written to {opt(a, '--out')}")
    else:
        print(text)
    for app, rows in report["apps"].items():
        for base, r in rows.items():
            print(f"{app} {r['role']:3} {base}: " + ", ".join(f"{p} {f['status']}" for p, f in r["pages"].items()) + "; " +
                  ", ".join(f"{p} {f['status']}" for p, f in r["gated"].items()) + f"; /mcp initialize {r['mcp']['initialize']['status']}", file=sys.stderr)
    return 0


# ---------- self-test ----------

def self_test():
    ok = []
    ok.append(visible_text("<html><head><title>A &amp; B</title><script>x()</script></head><body><p>Hello <b>you</b></p></body></html>") == "A & B Hello you")
    ok.append(title_of("<title> A &amp; B </title>") == "A & B")
    ok.append(mask('<script nonce="abc">2026-10-24T10:00:00Z</script>') == '<script nonce="<nonce>"><date></script>')
    ok.append(sse_json('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n') == {"jsonrpc": "2.0", "id": 1, "result": {}})
    ok.append(sse_json('{"a":1}') == {"a": 1} and sse_json("nope") is None)
    print(f"parity probe: {sum(ok)}/{len(ok)} parser checks passed")
    r = subprocess.run([tsx(CODEBASE), "--test", os.path.join(HERE, "diff.test.mts")], capture_output=True, text=True)
    tail = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith(("ℹ pass", "ℹ fail", "✖"))]
    print("parity diff tests: " + "; ".join(tail[:8]))
    return 0 if all(ok) and r.returncode == 0 else 1


def main(a):
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    if a[0] == "--self-test": return self_test()
    cmd = {"snapshot": snapshot, "diff": diff, "probe": probe}.get(a[0])
    if not cmd: die(f"unknown command {a[0]!r}; see parity.py --help")
    return cmd(a[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
