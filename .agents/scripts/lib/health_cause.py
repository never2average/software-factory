#!/usr/bin/env python3
"""Why an app's health page says it is down, in plain words: the failing part and its cause.

  health_cause.py --self-test        offline; the same cases as plugins/factory-board/hooks/board.test.ts

An app built from mold_v1 answers GET /api/ops/health with
  {"ok": false, "db": {"ok", "detail", "ms"}, "blob": {...}, "inference": {...}, "taskWorkflow": {...}, "mail": {...}}
and HTTP 503 when a part fails. `causes(body)` reads that body and returns one line per failing part, for example
  "database: the request was refused (usage limit?)"
The part's own `detail` text is only CLASSIFIED, never repeated: it can carry a host name or a database role, and these
lines go into the factory board, the uptime state file and the uptime email. A body that is not that JSON gives [].

The board's healthCauses() (plugins/factory-board/hooks/board.ts) is the TypeScript twin of this file; change both.
Standard library only.
"""
import json, re, sys

PARTS = {"db": "database", "blob": "file storage", "inference": "the assistant", "taskWorkflow": "background tasks"}

# First match wins; the order matters (a quota message also says "exceeded", a refused sign-in also says "failed").
RULES = [
    (re.compile(r"\b53000\b|insufficient[_ ]resources|quota|usage limit|exceeded the|limit (?:was |has been )?reached|plan limit", re.I),
     "the request was refused (usage limit?)"),
    (re.compile(r"\b53300\b|too many (?:clients|connections)|remaining connection slots", re.I), "too many connections at once"),
    (re.compile(r"password authentication failed|\b28P01\b|\b28000\b|role \S+ does not exist", re.I),
     "sign-in to it was refused (wrong password or role)"),
    (re.compile(r"suspended|endpoint (?:is |has been )?disabled", re.I), "it is switched off at the provider (suspended)"),
    (re.compile(r"ECONNREFUSED|connection refused", re.I), "it refused the connection (not running?)"),
    (re.compile(r"ENOTFOUND|EAI_AGAIN|getaddrinfo|could not be found", re.I), "its address could not be found"),
    (re.compile(r"timed? ?out|timeout|ETIMEDOUT|aborted", re.I), "it did not answer in time"),
    (re.compile(r"MISCONFIGURED|not configured|unset or unusable|\bno [A-Z][A-Z_]{3,}\b"), "it is not set up (a setting is missing)"),
    (re.compile(r"returned (\d{3})"), r"it answered with an error (HTTP \1)"),
    (re.compile(r"not ready|unhealthy", re.I), "it reports it is not ready"),
]
UNKNOWN = "it failed (a cause the factory does not recognise)"


def cause_of(detail):
    """The plain cause for one part's detail text."""
    text = str(detail or "")
    for rx, words in RULES:
        m = rx.search(text)
        if m:
            return m.expand(words)
    return UNKNOWN


def causes(body):
    """[ "<part>: <cause>" ] for every part the health JSON reports as failing; [] when the body is not that JSON."""
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    try:
        data = json.loads(body) if isinstance(body, str) else body
    except ValueError:
        return []
    if not isinstance(data, dict) or data.get("ok") is not False:
        return []
    out = []
    for key, part in PARTS.items():
        v = data.get(key)
        if isinstance(v, dict) and v.get("ok") is False:
            out.append(f"{part}: {cause_of(v.get('detail'))}")
    return out


# Shared with board.test.ts ("health causes"): the same inputs must give the same lines.
CASES = [
    ("Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.",
     "the request was refused (usage limit?)"),
    ("insufficient_resources (53000)", "the request was refused (usage limit?)"),
    ("sorry, too many clients already", "too many connections at once"),
    ('password authentication failed for user "app_rw"', "sign-in to it was refused (wrong password or role)"),
    ("The endpoint has been disabled. Enable it using Neon API and retry.", "it is switched off at the provider (suspended)"),
    ("connect ECONNREFUSED 192.0.2.1:5432", "it refused the connection (not running?)"),
    ("getaddrinfo ENOTFOUND db.example.test", "its address could not be found"),
    ("The operation was aborted due to timeout", "it did not answer in time"),
    ("no DATABASE_URL — the DB is not configured", "it is not set up (a setting is missing)"),
    ("agent health returned 502", "it answered with an error (HTTP 502)"),
    ("task workflow service reported unhealthy", "it reports it is not ready"),
    ("something odd", UNKNOWN),
]


def self_test():
    fails = []

    def check(name, cond):
        print(("ok   " if cond else "FAIL ") + name)
        if not cond:
            fails.append(name)

    for detail, want in CASES:
        check(f"cause: {detail[:50]!r} -> {want}", cause_of(detail) == want)
    body = json.dumps({"ok": False, "checkedAt": "t",
                       "db": {"ok": False, "detail": "Your project has exceeded the compute time quota.", "ms": 40},
                       "blob": {"ok": True, "detail": "write → head → delete ok", "ms": 9},
                       "inference": {"ok": False, "detail": "agent health returned 503", "ms": 5},
                       "taskWorkflow": {"ok": True, "detail": "ready", "ms": 3},
                       "mail": {"configured": False, "via": None, "detail": "No channel"}})
    check("the failing parts, in order, in plain words",
          causes(body) == ["database: the request was refused (usage limit?)",
                           "the assistant: it answered with an error (HTTP 503)"])
    check("bytes are read too", causes(body.encode()) == causes(body))
    check("a healthy body has no causes", causes(json.dumps({"ok": True, "db": {"ok": True}})) == [])
    check("a body that is not JSON has no causes", causes("<html>Bad Gateway</html>") == [])
    check("the detail text itself is never repeated",
          not any("192.0.2.1" in c for c in causes(json.dumps({"ok": False, "db": {"ok": False, "detail": "connect ECONNREFUSED 192.0.2.1:5432"}}))))
    print(f"\n{len(fails)} failed" if fails else "\nall passed")
    return 1 if fails else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    sys.exit(__doc__)
