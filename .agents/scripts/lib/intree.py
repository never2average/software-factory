#!/usr/bin/env python3
"""intree: a mold whose codebase is AUTHORED in this factory repository (operator decision D1, 2026-10-20; mold_v0-040).

Every other mold's codebase (mold_v1) is a snapshot of a source repository: `mold.py fetch|refresh|check` keep it
identical to a pinned commit there, and the deploy gate (lib/deploy_gate.py) reads that source's CI. An in-tree mold
has no source to fetch from: it forked from one at a recorded commit and is edited here, so

  - mold.py never fetches, refreshes or rewrites it (refresh refuses; check reports "in-tree since <commit>");
  - its version is a commit of THIS repository (the last one that changed molds/<mold_id>/codebase);
  - the deploy gate reads THIS repository's checks for the commit being deployed (HEAD of the checkout the deploy runs
    from), and refuses when the codebase on disk is not exactly that commit.

A mold is in-tree when molds/<mold_id>/mold.json says "source": {"in_tree": true, ...} OR state/factory.json's mold
entry says "source": {"in_tree": true}. Either one is enough (two places, so losing one never turns the protection
off), and a mold.json that exists but cannot be read is an error, never "not in-tree". Standard library only.
"""
import fnmatch, json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))


class Unreadable(Exception):
    """molds/<mold_id>/mold.json exists but is not JSON: nobody can say whether the mold is in-tree."""


def _factory_entry(mold_id, root):
    p = os.path.join(root, "state", "factory.json")
    try: fj = json.load(open(p))
    except (OSError, ValueError): return {}
    return next((m for m in fj.get("molds") or [] if isinstance(m, dict) and m.get("mold_id") == mold_id), {}) or {}


def info(mold_id, root=None):
    """The in-tree declaration ({"since", "forked_from", "ci", ...}) or None for a mold with a source of its own.
    Raises Unreadable when molds/<mold_id>/mold.json exists and is not valid JSON."""
    root = root or ROOT
    if not mold_id: return None
    p = os.path.join(root, "molds", str(mold_id), "mold.json"); man = {}
    if os.path.isfile(p):
        try: man = json.load(open(p))
        except ValueError as e: raise Unreadable(f"molds/{mold_id}/mold.json is not valid JSON ({e}), so whether {mold_id} is authored "
                                                 f"in this repository cannot be told; fix the file first. Nothing was changed.")
        if not isinstance(man, dict): raise Unreadable(f"molds/{mold_id}/mold.json is not a JSON object, so whether {mold_id} is authored in "
                                                       f"this repository cannot be told; fix the file first. Nothing was changed.")
    src = man.get("source") if isinstance(man.get("source"), dict) else {}
    fsrc = _factory_entry(mold_id, root).get("source"); fsrc = fsrc if isinstance(fsrc, dict) else {}
    if src.get("in_tree") is not True and fsrc.get("in_tree") is not True: return None
    out = {"mold_id": mold_id, "codebase": f"molds/{mold_id}/codebase", "ci": {"workflow": None}}
    out.update({k: v for k, v in fsrc.items() if k != "commit"})
    out.update(src)
    since = src.get("since") or fsrc.get("in_tree_since") or fsrc.get("since") or ""
    out["since"] = since if isinstance(since, str) else ""
    if not isinstance(out.get("forked_from"), dict): out["forked_from"] = {}
    out["ci"] = dict({"workflow": None}, **(out.get("ci") if isinstance(out.get("ci"), dict) else {}))
    return out


def is_in_tree(mold_id, root=None):
    return info(mold_id, root) is not None


def git(root, *argv, timeout=60):
    """(returncode, stdout) of git in `root`; (127, "") when git is not installed."""
    try: r = subprocess.run(["git", "-C", root, *argv], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError: return 127, ""
    except subprocess.TimeoutExpired: return 124, ""
    return r.returncode, r.stdout


def head(root=None):
    rc, out = git(root or ROOT, "rev-parse", "--verify", "HEAD")
    return out.strip() if rc == 0 and out.strip() else None


def last_change(mold_id, root=None):
    """The last commit of this repository that changed molds/<mold_id>/codebase, or None (no git, no history)."""
    rc, out = git(root or ROOT, "log", "-1", "--format=%H", "--", f"molds/{mold_id}/codebase")
    return out.strip() if rc == 0 and out.strip() else None


def version(mold_id, root=None):
    """What an app built from this in-tree mold records as its mold_commit. The fork point stands for the source commit
    it was forked from (the same files), so an app deployed before the fork does not read as behind; after the first
    change made here it is that change's commit."""
    I = info(mold_id, root)
    if not I: return None
    last = last_change(mold_id, root); since = I.get("since") or ""
    fork = (I.get("forked_from") or {}).get("commit") if isinstance(I.get("forked_from"), dict) else None
    if last and since and (last == since or since.startswith(last) or last.startswith(since)): return fork or last
    return last or fork or since or None


def slug(root=None):
    """host/owner/name of this repository's origin, or None when it has no GitHub-like origin."""
    import factory_local
    rc, out = git(root or ROOT, "remote", "get-url", "origin")
    return factory_local.repo_slug(out.strip()) if rc == 0 and out.strip() else None


def _excluded(rel, excludes):
    parts = rel.strip("/").split("/")
    for e in excludes:
        e = e.strip("/")
        if fnmatch.fnmatch(rel.strip("/"), e) or any(fnmatch.fnmatch(p, e) for p in parts): return True
    return False


def uncommitted(mold_id, root=None, excludes=()):
    """Paths under molds/<mold_id>/codebase that make the files on disk differ from HEAD: tracked changes, untracked
    files, and ignored files a deploy would still carry (ignored but not in `excludes`, mold.json's source_excludes).
    -> (list of "XY path" lines, or None when git cannot say)."""
    root = root or ROOT; cb = f"molds/{mold_id}/codebase"
    rc, out = git(root, "status", "--porcelain=v1", "--untracked-files=normal", "--ignored=traditional", "--", cb)
    if rc != 0: return None
    bad = []
    for line in out.splitlines():
        if len(line) < 4: continue
        code, path = line[:2], line[3:].strip().strip('"')
        rel = path[len(cb) + 1:] if path.startswith(cb + "/") else path
        if code == "!!" and _excluded(rel, excludes): continue
        bad.append(f"{code} {path}")
    return bad
