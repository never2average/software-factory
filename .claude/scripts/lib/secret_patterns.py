#!/usr/bin/env python3
"""The key-shaped strings the factory never lets out of this machine: one list, shared by the repository secret gate
(`repo.py` scan, before an app's repository push) and the mold's own pull-request check (mold_v0-320, below), so a fake
key written into a test or a fixture fails the pull request that adds it instead of a later app push.

    python3 .claude/scripts/lib/secret_patterns.py scan <dir> [<dir> ...]

scans every file git tracks under each directory (from the repository root) and prints `file:line: what` for each
finding, never the value; exit 1 on any finding, 0 when clean, 2 when it could not run. `--self-test` proves each
pattern on fakes built at run time. A test that needs a key-shaped
value builds it at run time (`"gh" + "p_" + "x" * 36`), so no tracked file holds one.

Standard library only. Nothing here reads a secret value; repo.py's comparison of the app's own values by hash stays there.
"""
import base64, os, re, subprocess, sys

TOKENS = [(what, re.compile(rx)) for what, rx in (
    ("a GitHub token", rb"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    ("a GitHub token", rb"\bgithub_pat_[A-Za-z0-9_]{40,}"),
    ("a GitLab token", rb"\bgl(?:pat|dt|rt|ptt|oas|soat|cbt|ft|imt|agent)-[A-Za-z0-9_.-]{20,}"),
    ("an AWS access key", rb"\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}\b"),     # not AWS's own documentation key
    ("a Slack token", rb"\bxox[abprs]-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9-]{20,}"),
    ("an Anthropic or OpenAI key", rb"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}"),
    ("a Resend key", rb"\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}"),
    ("an npm token", rb"\bnpm_[A-Za-z0-9]{36}\b"),
    ("a Google API key", rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("a Vercel Blob token", rb"\bvercel_blob_rw_[A-Za-z0-9]{12,}_[A-Za-z0-9]{24,}"),
    ("a Stripe live key", rb"\b[sr]k_live_[A-Za-z0-9]{20,}"),
    ("a Neon database password", rb"\bnpg_[A-Za-z0-9]{12,}"),
    ("a private key block", rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----"),
)]
B64_PEM = re.compile(rb"LS0tLS1CRUdJTi[A-Za-z0-9+/=]{24,}")        # base64 of "-----BEGIN ", as an env file stores a key
CONN = re.compile(rb"\b[A-Za-z][A-Za-z0-9+.-]{1,24}://([^\s/:@'\"`<>\\,;()]{1,128}):([^\s/@'\"`<>\\,;()]{1,256})@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)")
# Not a credential: a password that is plainly a stand-in in documentation or a template (a word like "password", a
# ${VARIABLE}, an ellipsis, one or two characters), or an address nobody else can reach or that cannot exist: this
# machine itself, and the names reserved for examples and tests. A REAL password is still caught by repo.py wherever it
# is written, because every value the factory can resolve is compared by hash whatever the address around it says.
PLACEHOLDER = re.compile(rb"[$<>{}*%\[\]#]|\xe2\x80\xa6|^(?:.{1,2}|pass(?:word|wd)?|pw|pwd|secret|x{3,}|\.{3}|changeme|example|test|postgres|user|token|key|redacted)$", re.I)
NOWHERE = re.compile(rb"^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]|(?:.*\.)?example\.(?:com|org|net)|.*\.(?:example|test|invalid|localhost))$", re.I)
KEY_FILES = ("id_rsa", "id_ed25519", "id_ecdsa", "id_dsa")


def file_findings(rel):
    """-> [(line, what)] for a file's NAME alone: an environment file, the private half of an SSH key."""
    base = os.path.basename(rel); out = []
    if base == ".env" or base.startswith(".env."): out.append((0, "an environment file (.env); these hold secret values"))
    if base in KEY_FILES: out.append((0, "a file named like the private half of an SSH key"))
    return out


def findings(data):
    """-> [(line, what)] for every key-shaped string in `data` (bytes). The value itself is never returned."""
    found = set()
    line = lambda i: data.count(b"\n", 0, i) + 1
    for what, rx in TOKENS:
        for m in rx.finditer(data): found.add((line(m.start()), what))
    for m in B64_PEM.finditer(data):
        try: head = base64.b64decode(m.group(0)[:len(m.group(0)) // 4 * 4][:400])
        except ValueError: continue
        if b"PRIVATE KEY" in head: found.add((line(m.start()), "a private key block (base64-encoded)"))
    for m in CONN.finditer(data):
        if not PLACEHOLDER.search(m.group(2)) and not NOWHERE.match(m.group(3).rstrip(b".")): found.add((line(m.start()), "a connection string with a password in it"))
    return sorted(found)


TEMPLATES = (".env.example", ".env.sample", ".env.template")


def tracked(root, d):
    r = subprocess.run(["git", "-C", root, "ls-files", "-z", "--", d], capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode(errors="replace").strip() or "git ls-files failed")
    return [p for p in r.stdout.decode().split("\0") if p]


def scan_tracked(root, dirs):
    """-> [(file, line, what)] over every file git tracks under `dirs` (relative to the repository `root`)."""
    out = []
    for d in dirs:
        for rel in tracked(root, d):
            # A tracked template (.env.example) is no environment file: its contents are still scanned below. An app's
            # repository leaves every .env* out (repo.py LEFT_OUT), so the gate never sees one.
            if os.path.basename(rel) not in TEMPLATES: out += [(rel, n, w) for n, w in file_findings(rel)]
            p = os.path.join(root, rel)
            if os.path.islink(p) or not os.path.isfile(p): continue
            try: data = open(p, "rb").read()
            except OSError as e: out.append((rel, 0, f"a file that could not be read ({e.strerror})")); continue
            out += [(rel, n, w) for n, w in findings(data)]
    return sorted(set(out))


def self_test():
    """Each pattern catches a fake built here at run time (no tracked file holds one); a placeholder or an example host does not."""
    x = lambda n, c="a": c * n
    fakes = {"a GitHub token": "gh" + "p_" + x(36), "a GitLab token": "gl" + "pat-" + x(20), "an AWS access key": "AK" + "IA" + x(16, "Q"),
             "a Slack token": "xo" + "xb-" + x(8, "1") + "-" + x(8, "2") + "-" + x(20), "an Anthropic or OpenAI key": "sk" + "-ant-" + x(32),
             "a Resend key": "re" + "_" + x(6) + "_" + x(16), "an npm token": "np" + "m_" + x(36), "a Google API key": "AI" + "za" + x(35),
             "a Vercel Blob token": "vercel_blob" + "_rw_" + x(12) + "_" + x(24), "a Stripe live key": "sk" + "_live_" + x(20),
             "a Neon database password": "np" + "g_" + x(12), "a private key block": "-----BEGIN " + "PRIVATE KEY-----",
             "a private key block (base64-encoded)": base64.b64encode(("-----BEGIN " + "RSA PRIVATE KEY-----\n" + x(40)).encode()).decode(),
             "a connection string with a password in it": "postgres://app:" + "s3cretPass" + "@db.internal-host.io/app"}
    bad = [w for w, v in fakes.items() if w not in {what for _, what in findings(("text " + v + " text").encode())}]
    clean = ["postgres://app:" + "s3cretPass" + "@db.example.com/app", "postgres://user:" + "password" + "@prod-host.io/x",
             "postgres://app:${PASSWORD}@prod-host.io/x", "AK" + "IA" + "IOSFODNN7" + "EXAMPLE", "gh" + "p_short"]
    bad += [f"not a finding: {c[:12]}..." for c in clean if findings(c.encode())]
    for b in bad: print(f"FAIL: {b}", file=sys.stderr)
    print(f"secret patterns: {len(fakes) + len(clean)} checks" + (f", {len(bad)} failed" if bad else " passed"))
    return 1 if bad else 0


def main(argv):
    if argv[:1] == ["--self-test"]: return self_test()
    if len(argv) < 2 or argv[0] != "scan":
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr); return 2
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if root.returncode: print("not inside a git repository", file=sys.stderr); return 2
    root = root.stdout.strip()
    try: found = scan_tracked(root, argv[1:])
    except RuntimeError as e: print(f"could not list the tracked files: {e}", file=sys.stderr); return 2
    for f, n, what in found: print(f"{f}{':' + str(n) if n else ''}: {what}")
    if found:
        print(f"KEY-SHAPED STRINGS: {len(found)} finding(s) in tracked files (values not shown). Build a test's fake key at run time "
              "(e.g. \"gh\" + \"p_\" + \"x\" * 36) instead of writing it; treat a real one as exposed and replace it.", file=sys.stderr)
        return 1
    print(f"key-shaped strings: none in the tracked files under {', '.join(argv[1:])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
